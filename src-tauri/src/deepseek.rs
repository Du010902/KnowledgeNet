//! DeepSeek API 接入
//!
//! 设计要点：
//! - 网络请求、鉴权、上下文组装都在 Rust 侧完成，API Key 不进入前端、不进入知识库备份。
//! - 流式回答通过 Tauri Channel 推给界面；SSE 按行缓冲解析，不假设一次读取就是一个完整事件。
//! - 每个请求带 requestId，取消时按 ID 中止任务，避免回答写到错误的对话。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;

const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";
const DEFAULT_MODEL: &str = "deepseek-flash";
const KEYRING_SERVICE: &str = "KnowledgeNet";
const KEYRING_USER: &str = "deepseek-api-key";

/// 官方上限：max_tokens 取值 1 ~ 393216（384K）。
/// 参考 https://api-docs.deepseek.com/api/create-chat-completion/
pub const MAX_OUTPUT_TOKENS: u32 = 393_216;

/// 未设置时的默认输出上限（非思考模式）。
///
/// 官方在未传 max_tokens 时：非思考模式默认 8K，思考模式默认 64K。
/// 这里给非思考模式一个略高于官方默认的值，避免正常讲解被截断；
/// 思考模式下不传该参数，直接采用服务端默认，防止推理过程被截半。
const DEFAULT_MAX_TOKENS: u32 = 16_384;

/// 进行中的请求：requestId -> 中止句柄
///
/// 注册表放进 `Arc<Mutex<..>>` 并让 `AiState` 可克隆，是为了让生成任务自己持有
/// 一份句柄：任务无论从哪条分支结束（正常收尾、上游报错、提前返回），都能把自己
/// 从表里摘掉。否则每问一次就留下一个再也没人清理的句柄，进程活得越久涨得越多，
/// 「取消」也会去中止一个早就结束的任务。
/// 被 abort 的取消路径走不到清理代码，这不算泄漏——条目在 `cancel` 里已经删掉了。
#[derive(Default, Clone)]
pub struct AiState {
    inflight: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

impl AiState {
    pub fn register(&self, request_id: &str, handle: tauri::async_runtime::JoinHandle<()>) {
        if let Ok(mut map) = self.inflight.lock() {
            map.insert(request_id.to_string(), handle);
        }
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut map) = self.inflight.lock() {
            map.remove(request_id);
        }
    }

    /// 中止指定请求。中止后任务不再发送任何事件，但已生成的片段由前端保留。
    pub fn cancel(&self, request_id: &str) -> bool {
        if let Ok(mut map) = self.inflight.lock() {
            if let Some(handle) = map.remove(request_id) {
                handle.abort();
                return true;
            }
        }
        false
    }

    pub fn cancel_all(&self) {
        if let Ok(mut map) = self.inflight.lock() {
            for (_, handle) in map.drain() {
                handle.abort();
            }
        }
    }
}

/* --------------------------------- 配置 --------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// 思考模式默认关闭：普通学习问答优先速度，复杂推导由使用者主动开启
    #[serde(default)]
    pub thinking: bool,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f32>,
}

impl AiConfig {
    fn resolved_base_url(&self) -> String {
        self.base_url
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    }

    fn resolved_model(&self) -> String {
        self.model
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_MODEL.to_string())
    }
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            base_url: None,
            model: None,
            thinking: false,
            max_tokens: Some(DEFAULT_MAX_TOKENS),
            temperature: None,
        }
    }
}

/* ------------------------------- API Key ------------------------------- */

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("无法访问系统凭据存储: {e}"))
}

/// 保存到系统凭据存储（Windows 凭据管理器 / macOS 钥匙串 / Linux secret-service）。
/// 不写进数据库、配置文件、备份或日志。
pub fn save_api_key(key: &str) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API Key 不能为空".into());
    }
    keyring_entry()?
        .set_password(trimmed)
        .map_err(|e| format!("保存 API Key 失败: {e}"))
}

pub fn clear_api_key() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // 本来就没有，视为成功
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("清除 API Key 失败: {e}")),
    }
}

/// 只返回「是否已配置」，绝不把密钥回传给界面
pub fn has_api_key() -> bool {
    read_api_key().is_ok()
}

fn read_api_key() -> Result<String, String> {
    match keyring_entry()?.get_password() {
        Ok(k) if !k.trim().is_empty() => Ok(k),
        Ok(_) => Err("尚未配置 API Key".into()),
        Err(keyring::Error::NoEntry) => Err("尚未配置 API Key".into()),
        Err(e) => Err(format!("读取 API Key 失败: {e}")),
    }
}

/* ------------------------------- 流式事件 ------------------------------- */

/// 推给前端的流式事件。
///
/// 字段必须按 camelCase 出网：`rename_all` 只改**变体名**（Delta → "delta"），
/// 结构体变体的字段保持 Rust 命名，`finish_reason` 到了前端就成了读不到的键，
/// 「被 max_tokens 截断」的提示因此永远不会出现。所以还要 `rename_all_fields`。
/// 线上格式（前端按这个解析，改动前先看 tests/stream_contract.rs）：
/// `{"type":"delta","text":".."}`
/// `{"type":"done","finishReason":..,"usage":..,"completed":..}`
/// `{"type":"error","message":".."}`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum StreamEvent {
    /// 增量文本
    Delta { text: String },
    /// 本次生成结束（可能是正常结束，也可能是上游截断）
    Done {
        finish_reason: Option<String>,
        usage: Option<serde_json::Value>,
        /// 是否正常收尾：收到 `[DONE]`，或者看到过 finish_reason，才算一次完整的生成。
        /// 连接中途断掉时是 false——前端据此把消息存成「不完整」而不是完整回答。
        completed: bool,
    },
    /// 出错，前端据此把消息标记为失败
    Error { message: String },
}

impl StreamEvent {
    fn send(self, channel: &Channel<StreamEvent>) {
        // 前端可能已经切走或取消，发送失败不需要影响后端
        let _ = channel.send(self);
    }
}

/// 处理一行 SSE 数据。返回 true 表示这次生成已经收场（已发出终止事件），
/// 调用方应立即停止读取。
///
/// 只接收「一整行」的字节：解码放在这里，是保证多字节 UTF-8 不会被网络分片劈开
/// 的前提（详见 stream_chat 里的缓冲说明）。
fn handle_sse_line(
    line_bytes: &[u8],
    channel: &Channel<StreamEvent>,
    finish_reason: &mut Option<String>,
    usage: &mut Option<serde_json::Value>,
) -> bool {
    // 整行字节已经到齐，这里的 lossy 只会丢掉真正非法的字节，不会再撕开汉字
    let raw = String::from_utf8_lossy(line_bytes);
    let line = raw.trim_end_matches('\r');

    let Some(data) = line.strip_prefix("data:") else {
        return false;
    };
    let data = data.trim();
    if data.is_empty() {
        return false;
    }
    if data == "[DONE]" {
        StreamEvent::Done {
            finish_reason: finish_reason.clone(),
            usage: usage.clone(),
            completed: true,
        }
        .send(channel);
        return true;
    }

    // 解析不了的行（心跳、注释、残缺片段）直接跳过，不打断整段回答
    let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
        return false;
    };

    if let Some(err) = value.get("error") {
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("上游返回错误");
        StreamEvent::Error {
            message: message.to_string(),
        }
        .send(channel);
        return true;
    }

    if value.get("usage").is_some() {
        *usage = value.get("usage").cloned();
    }

    let Some(choice) = value.get("choices").and_then(|c| c.get(0)) else {
        return false;
    };
    if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
        *finish_reason = Some(reason.to_string());
    }
    if let Some(text) = choice
        .get("delta")
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
    {
        if !text.is_empty() {
            StreamEvent::Delta {
                text: text.to_string(),
            }
            .send(channel);
        }
    }
    false
}

/// SSE 字节缓冲：只交出「完整行」，没等到换行符的尾部一直留在里面。
///
/// 单独抽出来是因为它有一个只能靠测试保证的性质：网络分片可以从多字节字符中间切开，
/// 只有等整行到齐再解码才不会把汉字变成 U+FFFD。见下方的单元测试。
#[derive(Default)]
struct LineBuffer {
    bytes: Vec<u8>,
}

impl LineBuffer {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
    }

    /// 取出一整行（含结尾的换行符，由调用方决定怎么裁）；
    /// 还没出现换行符时返回 None，字节留在缓冲区里等下一片。
    fn next_line(&mut self) -> Option<Vec<u8>> {
        let idx = self.bytes.iter().position(|&b| b == b'\n')?;
        // split_off 把换行之后的尾巴留下，行本身取出来
        let tail = self.bytes.split_off(idx + 1);
        Some(std::mem::replace(&mut self.bytes, tail))
    }

    /// 流结束时取走残留的最后一行（上游可能没补换行符）。
    /// 补一个换行只是为了让取行逻辑统一；残缺内容会解析失败并被忽略。
    fn take_remainder(&mut self) -> Option<Vec<u8>> {
        if self.bytes.is_empty() {
            return None;
        }
        let mut rest = std::mem::take(&mut self.bytes);
        rest.push(b'\n');
        Some(rest)
    }
}

/* ------------------------------- 请求组装 ------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatTurn {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub request_id: String,
    /// 组装好的消息：系统提示 + 必要上下文 + 当前问题
    pub messages: Vec<ChatTurn>,
    #[serde(default)]
    pub config: Option<AiConfig>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 发起一次流式对话。函数本身立即返回，生成过程在后台任务里跑。
pub fn start_chat(
    state: &AiState,
    channel: Channel<StreamEvent>,
    req: ChatRequest,
) -> Result<(), String> {
    let api_key = read_api_key()?;
    let config = req.config.clone().unwrap_or_default();
    let base_url = config.resolved_base_url();
    let model = config.resolved_model();
    let request_id = req.request_id.clone();

    let mut body = serde_json::json!({
        "model": model,
        "messages": req.messages,
        "stream": true,
    });

    /*
     * max_tokens 的处理规则（与官方默认值配合，避免截断）：
     *
     * - 使用者显式设置了值：照传，但夹到 1 ~ 384K 的合法区间。
     * - 思考模式且未设置：不传该参数。
     *   官方默认就是 64K；如果我们塞一个偏小的值（例如 2048），
     *   会在推理中途被 max_tokens 截断，回答只剩半截，且很容易被误认为模型能力问题。
     * - 非思考模式且未设置：给一个略高于官方默认 8K 的值。
     */
    let effective_max_tokens = match config.max_tokens {
        Some(v) if v > 0 => Some(v.min(MAX_OUTPUT_TOKENS)),
        _ if config.thinking => None,
        _ => Some(DEFAULT_MAX_TOKENS),
    };
    if let Some(max_tokens) = effective_max_tokens {
        body["max_tokens"] = serde_json::json!(max_tokens);
    }

    if let Some(temperature) = config.temperature {
        body["temperature"] = serde_json::json!(temperature);
    }
    // 思考模式：官方当前默认开启，普通问答必须显式关闭，
    // 否则会明显变慢。集中在这里处理，不散落到界面代码。
    body["thinking"] = serde_json::json!({
        "type": if config.thinking { "enabled" } else { "disabled" }
    });

    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let req_id_for_task = request_id.clone();
    // 任务自己拿一份注册表，跑完把自己摘掉（见 AiState 的说明）
    let registry = state.clone();

    // 先派生任务再登记句柄：任务里那句 finish 是常规清理路径，
    // 取消时条目也会被 cancel 摘掉。理论上留了一个「任务在 register 之前就结束」的
    // 窗口，但那要求整个请求在同一瞬间跑完（实际只有「建客户端失败」这种纯本地分支
    // 才做得到），最坏结果是注册表里多留一个已经结束的句柄，不影响任何一次生成。
    let handle = tauri::async_runtime::spawn(async move {
        stream_chat(channel, url, body, api_key).await;
        registry.finish(&req_id_for_task);
    });

    state.register(&request_id, handle);
    Ok(())
}

/// 真正读取流的地方。抽成独立函数，是为了让 spawn 出来的任务体只剩
/// 「跑完 → 把自己从注册表摘掉」两件事：函数里有多少个提前 return，
/// 都不会漏掉清理代码。
async fn stream_chat(
    channel: Channel<StreamEvent>,
    url: String,
    body: serde_json::Value,
    api_key: String,
) {
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            StreamEvent::Error {
                message: format!("创建网络客户端失败: {e}"),
            }
            .send(&channel);
            return;
        }
    };

    let response = client
        .post(&url)
        .bearer_auth(&api_key)
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .await;

    let response = match response {
        Ok(r) => r,
        Err(e) => {
            StreamEvent::Error {
                message: format!("请求失败: {e}"),
            }
            .send(&channel);
            return;
        }
    };

    // 把 HTTP 状态码翻译成可操作的提示，而不是丢一个裸错误
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let hint = match status.as_u16() {
            401 => "（API Key 无效或已过期）",
            402 => "（账户余额不足）",
            429 => "（请求过于频繁，请稍后重试）",
            _ => "",
        };
        let snippet: String = detail.chars().take(400).collect();
        StreamEvent::Error {
            message: format!("DeepSeek 返回 {status}{hint}: {snippet}"),
        }
        .send(&channel);
        return;
    }

    let mut stream = response.bytes_stream();
    // SSE 按行解析：一次网络读取可能是半个事件，也可能包含多个事件。
    //
    // 缓冲区里存的是**原始字节**而不是 String。一个汉字占 3 个字节，网络分片完全
    // 可能从中间劈开它；早先每收到一片就 `from_utf8_lossy(&chunk)`，跨越分片边界的
    // 半个汉字会当场变成 U+FFFD，原始字节再也找不回来，回答里因此凭空多出乱码，
    // 还被当成正常内容存进库。现在只把「到换行符为止」的完整行交给 lossy 解码，
    // 没有换行的尾部留在缓冲区里等下一片补齐。
    let mut lines = LineBuffer::default();
    let mut finish_reason: Option<String> = None;
    let mut usage: Option<serde_json::Value> = None;

    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                StreamEvent::Error {
                    message: format!("读取响应中断: {e}"),
                }
                .send(&channel);
                return;
            }
        };
        lines.push(&chunk);

        // 只处理完整的行，最后一段不完整的留在缓冲区里等下一次
        while let Some(line_bytes) = lines.next_line() {
            if handle_sse_line(&line_bytes, &channel, &mut finish_reason, &mut usage) {
                return;
            }
        }
    }

    // 流读完了，缓冲区里可能还剩最后一行（上游没补换行符），照样处理一次。
    // 若它是断流留下的残缺 JSON，解析会失败并被忽略，不会有副作用。
    if let Some(last) = lines.take_remainder() {
        if handle_sse_line(&last, &channel, &mut finish_reason, &mut usage) {
            return;
        }
    }

    // 连接自然结束、没有收到 [DONE]：只有看到过 finish_reason 才算上游真的写完了。
    // 两者都没有说明流是被掐断的（completed = false），前端据此把消息存成「不完整」；
    // 当成完整答案存下来的话，这半截回答以后谁也看不出缺了结尾。
    StreamEvent::Done {
        finish_reason: finish_reason.clone(),
        usage,
        completed: finish_reason.is_some(),
    }
    .send(&channel);
}

/* ------------------------------ 连通性测试 ------------------------------ */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub model: Option<String>,
    pub latency_ms: Option<i64>,
}

/// 用一次极小的请求验证 Key、地址与模型是否可用。
/// 只回传状态与耗时，不回传任何密钥信息。
pub async fn test_connection(config: AiConfig) -> TestResult {
    let api_key = match read_api_key() {
        Ok(k) => k,
        Err(e) => {
            return TestResult {
                ok: false,
                message: e,
                model: None,
                latency_ms: None,
            }
        }
    };

    let model = config.resolved_model();
    let url = format!(
        "{}/chat/completions",
        config.resolved_base_url().trim_end_matches('/')
    );

    let started = now_ms();
    let client = match reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return TestResult {
                ok: false,
                message: format!("创建网络客户端失败: {e}"),
                model: None,
                latency_ms: None,
            }
        }
    };

    let result = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&serde_json::json!({
            "model": model,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 1,
            "stream": false,
            "thinking": { "type": "disabled" }
        }))
        .send()
        .await;

    let latency = now_ms() - started;
    match result {
        Ok(resp) if resp.status().is_success() => TestResult {
            ok: true,
            message: format!("连接正常，用时 {latency} ms"),
            model: Some(model),
            latency_ms: Some(latency),
        },
        Ok(resp) => {
            let status = resp.status();
            let detail: String = resp
                .text()
                .await
                .unwrap_or_default()
                .chars()
                .take(300)
                .collect();
            let hint = match status.as_u16() {
                401 => "（API Key 无效）",
                402 => "（余额不足）",
                404 => "（模型名或服务地址不对）",
                429 => "（请求过于频繁）",
                _ => "",
            };
            TestResult {
                ok: false,
                message: format!("{status}{hint}: {detail}"),
                model: Some(model),
                latency_ms: Some(latency),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: format!("无法连接: {e}"),
            model: Some(model),
            latency_ms: None,
        },
    }
}

/* ------------------------------ 一次性短补全 ------------------------------ */

/// 一次**非流式**的短补全，给「自动为对话起标题」这类内部小任务用。
///
/// 为什么不复用流式路径：流式要一路把增量推给界面（Channel + 取消注册表），
/// 而这里只要最终那一行字，走非流式简单得多，也不会在界面上闪出半截标题。
///
/// 失败一律返回 `Err`，由调用方决定降级（起不出标题就保持原样，不该报错给用户）。
pub async fn complete_once(
    config: AiConfig,
    messages: Vec<ChatTurn>,
    max_tokens: u32,
) -> Result<String, String> {
    let api_key = read_api_key()?;
    let model = config.resolved_model();
    let url = format!(
        "{}/chat/completions",
        config.resolved_base_url().trim_end_matches('/')
    );

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| format!("创建网络客户端失败: {e}"))?;

    let resp = client
        .post(&url)
        .bearer_auth(&api_key)
        .json(&serde_json::json!({
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens.clamp(1, MAX_OUTPUT_TOKENS),
            "stream": false,
            "temperature": 0.2,
            // 起标题不需要推理：开思考模式只会更慢，而且容易把推理过程混进答案
            "thinking": { "type": "disabled" }
        }))
        .send()
        .await
        .map_err(|e| format!("请求失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let detail: String = resp
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        return Err(format!("{status}: {detail}"));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应不是合法 JSON: {e}"))?;
    body["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "响应里没有 choices[0].message.content".to_string())
}

/* --------------------------------- 测试 --------------------------------- */

#[cfg(test)]
mod tests {
    use super::LineBuffer;

    /*
     * 一个汉字占 3 个字节，网络分片完全可能从中间切开它。
     * 早先每收到一片就 `from_utf8_lossy(&chunk)`：切开的半个汉字当场变成 U+FFFD，
     * 原始字节再也找不回来，模型回答就这样带着乱码被存进库，事后无法修复。
     * 这里直接构造「分片从汉字中间切开」的场景，把这条性质钉住。
     */
    #[test]
    fn 汉字被网络分片劈开也不会变成乱码() {
        let line = "data: {\"choices\":[{\"delta\":{\"content\":\"梯度下降\"}}]}\n";
        let bytes = line.as_bytes();
        // 找到第一个非 ASCII 字节（「梯」的首字节），在它后面一个字节处切开
        let first_han = bytes.iter().position(|&b| b >= 0x80).expect("样例里有汉字");
        let cut = first_han + 1;

        let mut buffer = LineBuffer::default();
        buffer.push(&bytes[..cut]);
        assert!(
            buffer.next_line().is_none(),
            "半个事件不该被当成完整行交出去"
        );

        buffer.push(&bytes[cut..]);
        let got = buffer.next_line().expect("字节补齐后应当能取出一整行");
        let text = String::from_utf8_lossy(&got);
        assert!(text.contains("梯度下降"), "被劈开的汉字没能还原: {text}");
        assert!(!text.contains('\u{FFFD}'), "出现替换字符，说明字节已经丢了");
        assert!(buffer.next_line().is_none());
    }

    #[test]
    fn 一次读取里的多行会被逐行交出() {
        let mut buffer = LineBuffer::default();
        buffer.push(b"data: a\n\ndata: b\n");

        assert_eq!(buffer.next_line().as_deref(), Some(&b"data: a\n"[..]));
        // SSE 的空行是事件分隔符，照样按行交出，由上层决定忽略
        assert_eq!(buffer.next_line().as_deref(), Some(&b"\n"[..]));
        assert_eq!(buffer.next_line().as_deref(), Some(&b"data: b\n"[..]));
        assert!(buffer.next_line().is_none());
    }

    #[test]
    fn 流结束时残留的最后一行也能取出来() {
        let mut buffer = LineBuffer::default();
        buffer.push(b"data: {\"choices\":[]}");
        assert!(buffer.next_line().is_none(), "没有换行符就还不算完整行");

        let last = buffer.take_remainder().expect("结束时应当交还残留内容");
        assert_eq!(
            String::from_utf8_lossy(&last).trim(),
            "data: {\"choices\":[]}"
        );
        assert!(buffer.take_remainder().is_none(), "交还过一次就不该再有残留");
    }
}
