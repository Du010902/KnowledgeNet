/**
 * 当前知识库会话的注册表
 *
 * 界面只通过这里拿 Repository，因此「切库之后旧库的响应不能写进新库界面」这条规则
 * 只有一个收口点：
 *
 * - `setCurrentSession(next)` 会**同步失效**旧会话（旧 Repository 之后所有调用抛
 *   `session_closed`），再异步 `close()` 释放后端资源；
 * - `getRepository()` 在会话已失效时返回 null，组件拿不到还能写旧库的句柄；
 * - 控制器只负责创建会话，不自动登记——登记由 store 在切换流程里显式完成，
 *   否则「打不开知识库」时也会留下一个空壳会话。
 */
import { isTauri } from "./platform.ts";
import type { LibraryController, LibrarySession, Repository } from "./repository.ts";
import type { DeviceSettingsController } from "./deviceSettings.ts";
import { DemoLibraryController } from "./browserLibraryController.ts";
import { TauriLibraryController } from "./tauriLibraryController.ts";

type SessionListener = (session: LibrarySession | null) => void;

let controller: LibraryController | null = null;
let deviceController: DeviceSettingsController | null = null;
let current: LibrarySession | null = null;
const listeners = new Set<SessionListener>();

/** 设备级控制器：桌面端是真文件夹与 SQLite，浏览器端是明确的演示后端 */
export function getLibraryController(): LibraryController {
  if (!controller) {
    controller = isTauri() ? new TauriLibraryController() : new DemoLibraryController();
  }
  return controller;
}

/** 设备设置（最近列表 + AI 配置）。与库生命周期分开，因为它不依赖任何打开的知识库 */
export function getDeviceSettingsController(): DeviceSettingsController {
  if (!deviceController) {
    const active = getLibraryController();
    if (active instanceof TauriLibraryController || active instanceof DemoLibraryController) {
      deviceController = active;
    } else {
      // 理论上到不了这里；真出现时也不要静默返回一个假对象
      throw new Error("当前后端没有实现设备设置接口");
    }
  }
  return deviceController;
}

/** 当前会话；没有打开知识库或会话已失效时为 null */
export function getCurrentSession(): LibrarySession | null {
  return current && current.valid ? current : null;
}

/** 当前仓库；没有打开知识库时为 null。组件不得长期缓存它，切库后必须重新获取。 */
export function getRepository(): Repository | null {
  return getCurrentSession()?.repository ?? null;
}

/**
 * 订阅会话变化。只在新会话登记/移除时回调**一次**，不立即回调；
 * 需要初值请自行调用 `getCurrentSession()`。返回退订函数。
 */
export function subscribeSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 登记当前会话（打开成功后调用；关闭时传 null）。
 *
 * 传入新会话时旧会话立即失效并异步关闭：用户切库后，旧库的异步响应必须在恢复执行的
 * 第一步就失败，而不是把旧数据写进新库界面。传入已经失效的会话等同于 null。
 */
export function setCurrentSession(session: LibrarySession | null): void {
  const next = session && session.valid ? session : null;
  const previous = current;
  if (previous === next) return;
  current = next;

  if (previous && previous !== next) {
    // 先同步失效，再异步释放：close() 的第一步就是把 valid 置为 false
    const managed = previous as LibrarySession & { invalidate?: () => void };
    managed.invalidate?.();
    void previous.close().catch((error: unknown) => {
      // 释放失败只影响后端资源（例如锁），不应把界面卡在切换流程里；
      // 但必须让开发者看得见，不能静默吞掉
      console.warn("[KnowledgeNet] 关闭旧知识库会话失败", error);
    });
  }

  for (const listener of [...listeners]) {
    try {
      listener(current);
    } catch (error) {
      console.error("[KnowledgeNet] 会话订阅回调抛错", error);
    }
  }
}

/** 仅供测试：清空注册表，避免用例之间互相污染 */
export function resetSessionForTests(): void {
  current = null;
  controller = null;
  deviceController = null;
  listeners.clear();
}
