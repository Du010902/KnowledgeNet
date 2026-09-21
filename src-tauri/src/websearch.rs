//! 联网检索：DeepSeek 的 Anthropic 兼容 Messages 端点 + 服务端 `web_search` 工具。
//!
//! 为什么不用会话用的 `/chat/completions`：DeepSeek 的原生联网检索只在这个兼容端点上
//! 以 `web_search_20250305` 服务端工具的形式暴露，回的是**结构化**的
//! `web_search_tool_result` 块。走会话端点就只能让模型把链接写进正文，我们再去正文里
//! 抓 URL——那种抓法分不清「检索到的页面」和「模型凭记忆写出来的链接」，
//! 而学习资料里一条编出来的链接比没有链接更糟。所以这里**严格失败、不降级**：
//! 没有结果块就是错误，绝不退回去正文里捞 URL。
//!
//! 请求形状照抄 DSH（DeepSeek Harness）已验证的实现：
//! `POST {base}/messages`，`message` 里只有一句固定措辞的指令，
//! 检索结果全部来自响应里的结构化块，不从模型文本里读任何东西。
//! 解析部分刻意拆成不依赖网络的纯函数，好让上面这些性质能被单测钉住。
//!
//! API Key 只在本模块内部从系统凭据存储取出并使用：不回传前端、不进日志、
//! 不进任何错误信息（reqwest 的错误里只有 URL 与网络层原因，不含请求头）。

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use crate::deepseek::{self, AiConfig};

/// 服务端检索工具的版本号（Anthropic 兼容协议里的固定值）。
const WEB_SEARCH_TOOL_TYPE: &str = "web_search_20250305";
const WEB_SEARCH_TOOL_NAME: &str = "web_search";
/// 一次请求最多让上游搜几次：够「换个说法再搜一遍」，又不至于把一次提问变成十几次抓取。
const WEB_SEARCH_MAX_USES: u32 = 5;
/// 生成 token 上限：这次生成只负责把检索结果引出来，4096 足够。
const WEB_SEARCH_MAX_TOKENS: u32 = 4096;
/// 协议版本头：兼容端点据此选择消息格式。
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// 认清调用方用的 UA 是排查问题的第一步。
const USER_AGENT: &str = "KnowledgeNet/0.1";

/// 来源条数的**安全阀**，不是产品上限。
///
/// 原先这里是 8：一次检索最多给 8 条。实际上「给几条」不该由这里定——
/// 上游返回多少就留多少，使用者要的是能翻到全部来源（界面上每条思考/检索都能单独折叠，
/// 再长也不会把对话撑爆）。留着这个上限只为防一种情况：上游异常返回成百上千条，
/// 那份结果会同时撑爆上下文与界面。正常检索（几条到二十几条）永远碰不到它。
pub const SAFETY_MAX_RESULTS: usize = 50;

/// 建连超时与整体超时分开：连不上要在十几秒内说清楚，
/// 而一次带联网检索的生成本来就慢，整体给到 45 秒。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(45);

/// 一条检索来源。
///
/// `title`/`snippet`/`published_at` 都是 `Option` 而不是空串：
/// 「上游没给」和「给了个空标题」在前端要做不同处理（前者不显示那一行）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSource {
    pub url: String,
    pub title: Option<String>,
    /// 引用摘要：来自模型 text 块 citations 里的 `cited_text`
    pub snippet: Option<String>,
    /// 页面时间（上游字段名是 `page_age`）
    pub published_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub query: String,
    pub sources: Vec<SearchSource>,
    /// 是否因为超过条数上限而被截断：如实告诉界面，好显示「还有更多结果」
    pub truncated: bool,
}

/// 跑一次联网检索。
///
/// API Key 由本函数自己从系统凭据存储读取（命令层因此完全不碰密钥），
/// 端点与模型来自 AI 配置里的检索项（与会话配置相互独立）。
pub async fn search(query: &str, config: &AiConfig) -> Result<SearchOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("检索关键词为空，没有可检索的内容".to_string());
    }

    let endpoint = format!(
        "{}/messages",
        config.resolved_search_base_url().trim_end_matches('/')
    );
    let model = config.resolved_search_model();

    let api_key = deepseek::read_api_key()
        .map_err(|e| endpoint_error(&endpoint, &format!("凭据不可用：{e}")))?;

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        // 拒绝重定向：请求头里带着 API Key，跟着 3xx 走到另一个主机
        // 等于把密钥交给对方。网关配错时宁可报错，也不能悄悄把密钥送出去。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建网络客户端失败: {e}"))?;

    let body = serde_json::json!({
        "model": model,
        "max_tokens": WEB_SEARCH_MAX_TOKENS,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "text",
                "text": format!("Perform a web search for the query: {query}"),
            }],
        }],
        "tools": [{
            "type": WEB_SEARCH_TOOL_TYPE,
            "name": WEB_SEARCH_TOOL_NAME,
            "max_uses": WEB_SEARCH_MAX_USES,
        }],
    });

    let response = client
        .post(&endpoint)
        // 官方看 x-api-key，Anthropic 兼容网关看 Authorization：两个都发，哪边认都行
        .header("x-api-key", &api_key)
        .header("authorization", format!("Bearer {api_key}"))
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .header("accept", "application/json")
        .header("user-agent", USER_AGENT)
        .json(&body)
        .send()
        .await
        .map_err(|e| endpoint_error(&endpoint, &format!("检索请求失败: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        let detail: String = response
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(400)
            .collect();
        let hint = match status.as_u16() {
            401 => "（API Key 无效或已过期）",
            402 => "（账户余额不足）",
            403 => "（没有访问该检索模型的权限）",
            404 => "（检索端点或检索模型名不对）",
            429 => "（请求过于频繁，请稍后重试）",
            500..=599 => "（上游暂时不可用，可稍后重试）",
            300..=399 => {
                "（检索端点要求重定向，已按安全策略拒绝：请求头里带着 API Key，不能跟着跳转）"
            }
            _ => "",
        };
        return Err(endpoint_error(
            &endpoint,
            &format!("检索接口返回 {status}{hint}: {detail}"),
        ));
    }

    let raw = response
        .text()
        .await
        .map_err(|e| endpoint_error(&endpoint, &format!("读取检索响应失败: {e}")))?;

    parse_body(&raw, query, SAFETY_MAX_RESULTS).map_err(|e| endpoint_error(&endpoint, &e))
}

/// 给「请求已经发出去之后」的失败补上可操作信息。
///
/// 用户看到的往往只有一句「HTTP 500」或「连接超时」，而这两句话都答不出
/// 「是哪个地址出的问题、要去哪儿改」。检索端点与会话端点是**两份独立配置**，
/// 说清楚这一点，用户才不会跑去改错地方，改完还奇怪为什么没用。
fn endpoint_error(endpoint: &str, message: &str) -> String {
    format!(
        "{message}\n\n本次检索用的端点：{endpoint}。\
         检索端点与会话端点相互独立，可在「AI 设置」里分别修改（检索模型同理）。"
    )
}

/// 解码响应体并抽出结构化来源。
///
/// 先解码再解析分成两步，是为了让「响应体不是 JSON」与「是 JSON 但没有结果块」
/// 给出两句不同的错误：前者是接入问题（端点/网关返回了 HTML 错误页），
/// 后者是模型或工具没被触发。两句都不可操作的话，用户只能干瞪眼。
fn parse_body(raw: &str, query: &str, max_results: usize) -> Result<SearchOutcome, String> {
    let payload: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("检索响应体无法解析为 JSON（{e}）"))?;
    parse_response(&payload, query, max_results)
}

/// 从一次 Messages 响应里抽出可引用的来源。
///
/// 三条规则（与 DSH 的实现对齐）：
/// - 结果只能来自 `web_search_tool_result` 块；一块都没有就直接报错，
///   **绝不**退回去读模型正文里的链接；
/// - `snippet` 来自所有 `text` 块 `citations[]` 里的 `cited_text`，按 url 建表，
///   **首次出现优先**；
/// - 按 url 去重：`max_uses > 1` 时同一页面会在多轮检索里重复出现。
fn parse_response(
    payload: &serde_json::Value,
    query: &str,
    max_results: usize,
) -> Result<SearchOutcome, String> {
    let blocks: &[serde_json::Value] = payload
        .get("content")
        .and_then(|content| content.as_array())
        .map(|blocks| blocks.as_slice())
        .unwrap_or(&[]);

    let result_blocks: Vec<&serde_json::Value> = blocks
        .iter()
        .filter(|block| {
            block.get("type").and_then(|t| t.as_str()) == Some("web_search_tool_result")
        })
        .collect();
    if result_blocks.is_empty() {
        return Err(
            "检索端点没有返回 web_search_tool_result 块：这次请求可能没有被当成联网检索\
             （检查「AI 设置」里的检索模型是否支持 web_search 工具）"
                .to_string(),
        );
    }

    let snippets = citation_snippets(blocks);
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut sources: Vec<SearchSource> = Vec::new();
    let mut truncated = false;

    'blocks: for block in result_blocks {
        let Some(items) = block.get("content").and_then(|c| c.as_array()) else {
            continue;
        };
        for item in items {
            if item.get("type").and_then(|t| t.as_str()) != Some("web_search_result") {
                continue;
            }
            let Some(url) = non_empty_str(item.get("url")) else {
                continue;
            };
            if !seen.insert(url) {
                continue;
            }
            if sources.len() >= max_results {
                // 到达上限就停下并如实标记：装作「只有这些」会让用户以为搜到的就这么多
                truncated = true;
                break 'blocks;
            }
            sources.push(SearchSource {
                url: url.to_string(),
                title: non_empty_str(item.get("title")).map(str::to_string),
                // 摘要在 citations 里按 url 关联；这条 url 没有被引用过就没有摘要
                snippet: snippets.get(url).cloned(),
                published_at: non_empty_str(item.get("page_age")).map(str::to_string),
            });
        }
    }

    Ok(SearchOutcome {
        query: query.to_string(),
        sources,
        truncated,
    })
}

/// 把每一条引用按 url 收成 `url -> cited_text`。
///
/// 摘要为什么不在 `web_search_result` 里：Anthropic 兼容协议的结果条目只有
/// `url`/`title`/`page_age`，真正的摘录在模型引用它时写在 `text` 块的 `citations[]` 里，
/// 所以两边要靠 url 关联起来。
fn citation_snippets(blocks: &[serde_json::Value]) -> HashMap<String, String> {
    let mut snippets: HashMap<String, String> = HashMap::new();
    for block in blocks {
        if block.get("type").and_then(|t| t.as_str()) != Some("text") {
            continue;
        }
        let Some(citations) = block.get("citations").and_then(|c| c.as_array()) else {
            continue;
        };
        for citation in citations {
            let Some(url) = non_empty_str(citation.get("url")) else {
                continue;
            };
            let Some(text) = non_empty_str(citation.get("cited_text")) else {
                continue;
            };
            // 首次出现优先：同一条链接被引两次时，后一次往往是更泛的概述，
            // 前一次更贴近用户问的那句话
            snippets
                .entry(url.to_string())
                .or_insert_with(|| text.to_string());
        }
    }
    snippets
}

/// 取一个「有内容」的字符串：缺失与空串是同一件事。
///
/// 上游会用 `""` 表示「没有标题 / 没有时间」，原样带出去前端就得自己再判一次空，
/// 而这种判断总有人会忘。
fn non_empty_str(value: Option<&serde_json::Value>) -> Option<&str> {
    value
        .and_then(|value| value.as_str())
        .filter(|text| !text.is_empty())
}

/* --------------------------------- 测试 --------------------------------- */

#[cfg(test)]
mod tests {
    use super::{parse_body, parse_response, SearchOutcome, SAFETY_MAX_RESULTS};
    use serde_json::json;

    /// 仿真响应：两个结果块（第二块与第一块有一条重复 URL），
    /// text 块里的 citations 只覆盖其中两条。
    fn 完整响应() -> serde_json::Value {
        json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "content": [
                {
                    "type": "web_search_tool_result",
                    "content": [
                        {
                            "type": "web_search_result",
                            "url": "https://a.test/gradient",
                            "title": "梯度下降",
                            "page_age": "2024-03-01",
                        },
                        {
                            "type": "web_search_result",
                            "url": "https://b.test/learning-rate",
                            "title": "学习率",
                            "page_age": "",
                        },
                        { "type": "web_search_result", "url": "" },
                    ],
                },
                {
                    "type": "text",
                    "text": "梯度下降是一种迭代优化方法。",
                    "citations": [
                        {
                            "type": "web_search_result_location",
                            "url": "https://a.test/gradient",
                            "cited_text": "梯度下降沿负梯度方向更新参数。",
                        },
                        {
                            "type": "web_search_result_location",
                            "url": "https://a.test/gradient",
                            "cited_text": "后一次引用不该覆盖前一次。",
                        },
                        {
                            "type": "web_search_result_location",
                            "url": "https://c.test/never-listed",
                            "cited_text": "这条 url 没有对应的结果条目。",
                        },
                    ],
                },
                {
                    "type": "web_search_tool_result",
                    "content": [
                        // 多轮检索会把同一页面再带回来一次
                        {
                            "type": "web_search_result",
                            "url": "https://a.test/gradient",
                            "title": "梯度下降（第二次搜到）",
                        },
                        {
                            "type": "web_search_result",
                            "url": "https://d.test/momentum",
                            "title": "动量法",
                            "page_age": "2025-01-09",
                        },
                    ],
                },
            ],
        })
    }

    #[test]
    fn 解析出结构化来源并关联_citations_摘要() {
        let outcome = parse_response(&完整响应(), "梯度下降", SAFETY_MAX_RESULTS).unwrap();

        assert_eq!(outcome.query, "梯度下降");
        assert!(!outcome.truncated);
        assert_eq!(outcome.sources.len(), 3, "空 url 要被跳过");

        let first = &outcome.sources[0];
        assert_eq!(first.url, "https://a.test/gradient");
        assert_eq!(first.title.as_deref(), Some("梯度下降"));
        assert_eq!(first.published_at.as_deref(), Some("2024-03-01"));
        assert_eq!(
            first.snippet.as_deref(),
            Some("梯度下降沿负梯度方向更新参数。"),
            "摘要必须来自 citations，且首次出现优先"
        );

        // 没有 citations 的来源：摘要为 None，而不是空串
        let second = &outcome.sources[1];
        assert_eq!(second.url, "https://b.test/learning-rate");
        assert_eq!(second.snippet, None);
        // 上游用空串表示「没有时间」，不能原样带出去
        assert_eq!(second.published_at, None);
    }

    /*
     * 严格失败：一个 `web_search_tool_result` 块都没有时必须报错，
     * 而不是退回去读模型正文里的 URL —— 正文里的链接分不清是检索到的
     * 还是模型凭记忆写出来的，混进来源列表就是在给用户递假引用。
     */
    #[test]
    fn 没有结果块时报错而不是去正文里抓链接() {
        let response = json!({
            "content": [
                {
                    "type": "text",
                    "text": "你可以看看 https://made-up.test/gradient 这个页面。",
                    "citations": [],
                },
            ],
        });
        let error = parse_response(&response, "梯度下降", SAFETY_MAX_RESULTS).unwrap_err();
        assert!(
            error.contains("web_search_tool_result"),
            "错误信息要指出缺的是什么: {error}"
        );
        assert!(!error.contains("made-up.test"), "不能把正文里的链接当来源");

        // content 整个缺失同样是「没有结果块」，不是 panic
        let empty = parse_response(&json!({}), "梯度下降", SAFETY_MAX_RESULTS).unwrap_err();
        assert!(empty.contains("web_search_tool_result"));
    }

    #[test]
    fn 同一个_url_只保留第一次出现的条目() {
        let outcome = parse_response(&完整响应(), "梯度下降", SAFETY_MAX_RESULTS).unwrap();
        let urls: Vec<&str> = outcome.sources.iter().map(|s| s.url.as_str()).collect();
        assert_eq!(
            urls,
            vec![
                "https://a.test/gradient",
                "https://b.test/learning-rate",
                "https://d.test/momentum",
            ]
        );
        // 去重保留的是第一次那条：标题不能被后来那次覆盖
        assert_eq!(outcome.sources[0].title.as_deref(), Some("梯度下降"));
    }

    #[test]
    fn 超过条数上限时截断并标记_truncated() {
        let outcome = parse_response(&完整响应(), "梯度下降", 2).unwrap();
        assert_eq!(outcome.sources.len(), 2);
        assert!(outcome.truncated, "被截断必须如实标记");

        // 正好装得下时不算截断，否则界面会永远显示「还有更多」
        let exact = parse_response(&完整响应(), "梯度下降", 3).unwrap();
        assert_eq!(exact.sources.len(), 3);
        assert!(!exact.truncated);
    }

    #[test]
    fn 响应体不可解析时给出专门的错误() {
        let error = parse_body("<html>502 Bad Gateway</html>", "梯度下降", 8).unwrap_err();
        assert!(error.contains("无法解析"), "要区分「不是 JSON」: {error}");
        // 截断的 JSON（网关半路断开）同样落到这里，而不是 panic
        let truncated = parse_body("{\"content\": [", "梯度下降", 8).unwrap_err();
        assert!(truncated.contains("无法解析"));
    }

    #[test]
    fn 结果条目里的空字段变成_none_而不是空串() {
        let response = json!({
            "content": [{
                "type": "web_search_tool_result",
                "content": [{
                    "type": "web_search_result",
                    "url": "https://a.test",
                    "title": "",
                    "page_age": "",
                }],
            }],
        });
        let outcome: SearchOutcome = parse_response(&response, "q", 8).unwrap();
        assert_eq!(outcome.sources.len(), 1);
        assert_eq!(outcome.sources[0].title, None);
        assert_eq!(outcome.sources[0].published_at, None);
    }
}
