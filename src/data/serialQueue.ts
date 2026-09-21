/**
 * 串行队列
 *
 * 用途有两个，都是「必须整体排队，而不只是排队最后一步」的场景：
 *
 * 1. 引擎的修改操作：每个操作都是「读当前状态 → 计算新快照 → 提交 → 更新内存」。
 *    如果只把提交排队，两个操作会在第一次提交结束前读到同一份旧状态，
 *    后提交的那份把前一份的修改整体覆盖掉（并发新建节点还会算出同一个 ID）。
 * 2. 存储适配器的底层写入：避免两个提交同时写同一个文件/命令。
 *
 * 关键点：**队列必须吞掉上一轮的失败**。
 * 直接写 `chain = chain.then(...)` 而不处理拒绝状态，只要有一次写入失败
 * （例如 SQLite 瞬时锁、localStorage 配额），队列就永久停在被拒绝的状态，
 * 之后所有 `.then` 回调全部跳过——用户只能重启应用才能恢复保存。
 * 这里把失败留在本次调用的返回值里交给调用方，队列本身继续保持可用。
 */
export class SerialQueue {
  private chain: Promise<unknown> = Promise.resolve();

  /** 排队执行；返回本次任务的真实结果（含失败），不影响队列后续任务 */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const previous = this.chain;
    // 上一个任务无论成功还是失败，都要接着执行本次任务
    const result = previous.then(
      () => task(),
      () => task(),
    );
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 等待已排队的任务全部结束（导出、导入前对齐状态时使用） */
  async drain(): Promise<void> {
    await this.chain;
  }
}
