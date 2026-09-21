/**
 * 桌面端知识库生命周期控制器
 *
 * 设备级能力：系统选择器、最近打开列表、新建/打开/关闭、运行中创建副本，
 * 以及设备设置（AI 配置存 AppData，API Key 存系统凭据存储）。
 *
 * 两条容易出错的规则在这里收口：
 * - 打开新库之前必须先关闭当前库：Rust 侧同时只允许一个可写会话，否则会报 `already_open`；
 * - 只有打开成功才创建会话；失败时不能留下一个「看起来打开了」的空壳。
 */
import { invoke } from "@tauri-apps/api/core";

import { toRepositoryError } from "./errors.ts";
import type { DeviceSettings, DeviceSettingsController } from "./deviceSettings.ts";
import { createManagedSession, type ManagedLibrarySession } from "./librarySession.ts";
import type { LibraryController, LibrarySession, Repository } from "./repository.ts";
import { TauriRepository } from "./tauriRepository.ts";
import type { AiConfig } from "./aiProvider.ts";
import type { CopyMode, CopyResult, LibraryInfo, RecentLibrary } from "./types.ts";
import { newUuid } from "./uuid.ts";

/** `load_device_settings` 的返回：AI 配置在这里，API Key 只有一个「有没有」的标记 */
interface DeviceSettingsWire {
  recentLibraries?: RecentLibrary[];
  aiConfig?: AiConfig | null;
  hasApiKey?: boolean;
}

/** 统一归一化错误：调用方只需要看 `RepositoryError.code` */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toRepositoryError(error);
  }
}

export class TauriLibraryController implements LibraryController, DeviceSettingsController {
  readonly isDemo = false;

  #session: ManagedLibrarySession | null = null;

  /* ------------------------------ 生命周期 ------------------------------ */

  async createLibrary(parentDir: string, name: string, title?: string): Promise<LibrarySession> {
    await this.detachCurrent();
    // v2 的命令参数是**平铺**的（契约 §4.1）：v1 时代的 `request: { … }` 包装层已经不存在，
    // 继续包一层会让 Tauri 报 "missing required key parentDir"。
    const info = await call<LibraryInfo>("create_library", { parentDir, name, title });
    return this.attach(info);
  }

  async openLibrary(rootPath: string, allowReadOnly = false): Promise<LibrarySession> {
    await this.detachCurrent();
    const info = await call<LibraryInfo>("open_library", { rootPath, allowReadOnly });
    return this.attach(info);
  }

  async closeLibrary(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (session) {
      // close() 幂等：会话已经失效时只是返回上一次的释放结果
      await session.close();
      return;
    }
    // 控制器自己没有会话（例如热更新后重建）时，先问后端是否还打开着
    const info = await call<LibraryInfo | null>("current_library_info");
    if (info) await call<void>("close_library");
  }

  async currentLibraryInfo(): Promise<LibraryInfo | null> {
    return call<LibraryInfo | null>("current_library_info");
  }

  async createLibraryCopy(
    targetParentDir: string,
    name: string,
    mode: CopyMode,
  ): Promise<CopyResult> {
    return call<CopyResult>("create_library_copy", { targetParentDir, name, mode });
  }

  /* ------------------------------ 设备级记录 ------------------------------ */

  async listRecentLibraries(): Promise<RecentLibrary[]> {
    const settings = await this.loadDeviceSettings();
    return settings.recentLibraries;
  }

  async removeRecentLibrary(path: string): Promise<void> {
    await call<void>("remove_recent_library", { path });
  }

  /* -------------------------------- 选择器 -------------------------------- */

  async pickDirectory(title?: string): Promise<string | null> {
    return call<string | null>("pick_directory", { title });
  }

  async pickFiles(): Promise<string[]> {
    return call<string[]>("pick_files");
  }

  /* ------------------------------ 设备设置 ------------------------------ */

  async loadDeviceSettings(): Promise<DeviceSettings> {
    const wire = await call<DeviceSettingsWire>("load_device_settings");
    return {
      recentLibraries: wire?.recentLibraries ?? [],
      aiConfig: wire?.aiConfig ?? null,
      hasApiKey: wire?.hasApiKey ?? false,
    };
  }

  /** AI 配置存设备设置（AppData），不进知识库；API Key 走系统凭据存储 */
  async saveAiConfig(config: AiConfig): Promise<void> {
    await call<void>("save_ai_config", { config });
  }

  async saveApiKey(key: string): Promise<void> {
    await call<void>("save_api_key", { key });
  }

  async clearApiKey(): Promise<void> {
    await call<void>("clear_api_key");
  }

  /* -------------------------------- 内部 -------------------------------- */

  /** 打开新库之前先关掉当前库：Rust 侧同时只允许一个可写会话 */
  private async detachCurrent(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (session) {
      await session.close();
      return;
    }
    const info = await call<LibraryInfo | null>("current_library_info").catch(() => null);
    if (info) await call<void>("close_library");
  }

  /** 用打开结果创建会话：Repository 与会话互相绑定，关闭时释放后端锁 */
  private attach(info: LibraryInfo): ManagedLibrarySession {
    const session = createManagedSession({
      sessionId: newUuid(),
      info,
      createRepository: (binding): Repository => new TauriRepository(binding),
      onClose: async () => {
        await call<void>("close_library");
      },
    });
    this.#session = session;
    return session;
  }
}
