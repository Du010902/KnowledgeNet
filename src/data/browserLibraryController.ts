/**
 * 浏览器演示库生命周期控制器（v2）
 *
 * 演示模式没有真实文件夹、锁与设备索引，因此这里明确降级：
 * - 「最近打开列表」永远是空的（浏览器里只有一个演示库，编造多条记录只会误导用户）；
 * - 文件夹选择器返回 null / 空数组；
 * - 创建副本直接抛 `unsupported_in_demo`；
 * - AI 配置只在浏览器本地保存，API Key 一律不保存（模拟服务本来也不需要）。
 *
 * `isDemo = true`：界面据此显示「演示模式，不是便携知识库」。
 */
import { RepositoryError } from "./errors.ts";
import type { DeviceSettings, DeviceSettingsController } from "./deviceSettings.ts";
import { createManagedSession, type ManagedLibrarySession } from "./librarySession.ts";
import type { LibraryController, LibrarySession, Repository } from "./repository.ts";
import {
  BrowserRepository,
  DEMO_BACKEND_LABEL,
  DEMO_DEVICE_KEY,
  createDemoLibrary,
  demoLibraryReady,
  loadDemoVfs,
  readDemoLibraryInfo,
  resetDemoStorage,
  seedDemoLibrary,
  storeDemoVfs,
  type StorageLike,
} from "./browserRepository.ts";
import { LIBRARY_FILE } from "./v2/paths.ts";
import { newLibraryManifest, parseLibraryManifest, serializeJson } from "./v2/schema.ts";
import type { AiConfig } from "./aiProvider.ts";
import type { CopyMode, CopyResult, LibraryInfo, RecentLibrary } from "./types.ts";
import { newUuid } from "./uuid.ts";

export { DEMO_DEVICE_KEY };

interface DemoDeviceSettingsFile {
  aiConfig?: AiConfig | null;
}

/** 演示模式的设备设置也走 localStorage；拿不到时退化成内存 */
const fallback = new Map<string, string>();

function storage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (ls) return ls;
  } catch {
    // 隐私模式：退化成内存
  }
  return {
    getItem: (key: string) => fallback.get(key) ?? null,
    setItem: (key: string, value: string) => {
      fallback.set(key, value);
    },
    removeItem: (key: string) => {
      fallback.delete(key);
    },
  };
}

export class DemoLibraryController implements LibraryController, DeviceSettingsController {
  readonly isDemo = true;

  #session: ManagedLibrarySession | null = null;
  #libraryId: string | null = null;

  /* ------------------------------ 生命周期 ------------------------------ */

  async createLibrary(
    _parentDir: string,
    name: string,
    title?: string,
  ): Promise<LibrarySession> {
    // 「新建演示库」= 清空演示存储：不假装在用户目录里创建了文件夹。
    // 刻意不播种示例节点：用户点「新建」时期待的是一张白纸。
    resetDemoStorage();
    const libraryId = newUuid();
    const libraryTitle = title ?? name ?? "浏览器演示知识库";
    await createDemoLibrary({ libraryId, title: libraryTitle, seed: false });
    this.#libraryId = libraryId;
    return this.#open(libraryTitle, false);
  }

  async openLibrary(_rootPath: string, allowReadOnly = false): Promise<LibrarySession> {
    // 演示后端不区分路径：浏览器里只有一个演示库。
    // 第一次打开时播种少量示例节点，让图谱不是一片空白。
    this.#libraryId = this.#libraryId ?? newUuid();
    if (!demoLibraryReady()) {
      await createDemoLibrary({
        libraryId: this.#libraryId,
        title: "浏览器演示知识库",
        seed: true,
      });
    } else {
      const vfs = loadDemoVfs();
      let manifest;
      try {
        manifest = parseLibraryManifest(vfs.readSync(LIBRARY_FILE), LIBRARY_FILE);
      } catch {
        manifest = newLibraryManifest({
          libraryId: this.#libraryId,
          title: "浏览器演示知识库",
          now: new Date().toISOString(),
        });
        vfs.writeSync(LIBRARY_FILE, serializeJson(manifest));
      }
      if (await seedDemoLibrary(vfs, manifest)) storeDemoVfs(vfs);
    }
    return this.#open("浏览器演示知识库", allowReadOnly);
  }

  async closeLibrary(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    this.#libraryId = null;
    if (session) await session.close();
  }

  async currentLibraryInfo(): Promise<LibraryInfo | null> {
    return this.#session?.valid ? this.#session.info : null;
  }

  async createLibraryCopy(
    _targetParentDir: string,
    _name: string,
    _mode: CopyMode,
  ): Promise<CopyResult> {
    throw new RepositoryError(
      "unsupported_in_demo",
      "浏览器演示模式不能创建知识库副本：完整副本是桌面版能力（复制整个知识库文件夹）",
    );
  }

  /* ------------------------------ 设备级记录 ------------------------------ */

  async listRecentLibraries(): Promise<RecentLibrary[]> {
    return [];
  }

  async removeRecentLibrary(_path: string): Promise<void> {
    // 演示模式没有设备级最近列表，无需处理
  }

  /* -------------------------------- 选择器 -------------------------------- */

  async pickDirectory(_title?: string): Promise<string | null> {
    // 浏览器拿不到用户目录；界面据此提示「演示模式请直接打开演示库」
    return null;
  }

  async pickFiles(): Promise<string[]> {
    return [];
  }

  /* ------------------------------ 设备设置 ------------------------------ */

  async loadDeviceSettings(): Promise<DeviceSettings> {
    let aiConfig: AiConfig | null = null;
    try {
      const raw = storage().getItem(DEMO_DEVICE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as DemoDeviceSettingsFile;
        aiConfig = parsed.aiConfig ?? null;
      }
    } catch {
      // 演示设置坏了不值得中断界面：按未配置处理
      aiConfig = null;
    }
    return { recentLibraries: [], aiConfig, hasApiKey: false };
  }

  async saveAiConfig(config: AiConfig): Promise<void> {
    storage().setItem(DEMO_DEVICE_KEY, JSON.stringify({ aiConfig: config }));
  }

  async saveApiKey(_key: string): Promise<void> {
    throw new RepositoryError(
      "unsupported_in_demo",
      "浏览器演示模式不保存 API Key：请输入桌面版使用真实 AI",
    );
  }

  async clearApiKey(): Promise<void> {
    // 演示模式本来就没有保存过 Key
  }

  /* -------------------------------- 内部 -------------------------------- */

  async #open(title: string, readOnly: boolean): Promise<LibrarySession> {
    const previous = this.#session;
    this.#session = null;
    if (previous) await previous.close();

    const libraryId = this.#libraryId ?? newUuid();
    this.#libraryId = libraryId;
    const info = await readDemoLibraryInfo({ libraryId, title, readOnly });
    const session = createManagedSession({
      sessionId: newUuid(),
      info,
      createRepository: (binding): Repository => new BrowserRepository(binding),
      // 演示后端没有要释放的资源；close() 只负责让会话失效
      onClose: async () => undefined,
    });
    this.#session = session;
    return session;
  }
}

/** 演示模式的说明文案：界面必须让用户看到「这不是便携知识库」 */
export const DEMO_WARNING = `演示模式：数据只存在浏览器 localStorage（${DEMO_BACKEND_LABEL}），清理站点数据就会消失；正式使用请用桌面版。`;
