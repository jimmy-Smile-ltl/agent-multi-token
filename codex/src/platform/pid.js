// @ts-check
/**
 * 进程活性探测——`sessions` 三态里 `live` / `dead` 的那一半。
 *
 * ★ 这是**平台层**的用处：`process.kill` 是宿主能力，core 不碰（不读 `process.*`）。
 * 与会话相关的纯逻辑在 `core/sessions.js`；这里只回答一个问题："这个 pid 还活着吗"。
 *
 * ## 判据（`kill(pid, 0)` 的跨平台语义）
 *
 * | 结果 | 含义 | 我们的答案 |
 * |---|---|---|
 * | 不抛 | 进程存在（信号 0 只做存在性检查） | **活** |
 * | `ESRCH` | no such process | 死 |
 * | `EPERM` | 存在，但没有权限发信号 | **活**——当成死会把别的用户/提权跑的会话全误报 |
 * | 其它错误 / 非法 pid | 说不清 / 根本不合法 | 死 |
 *
 * ⚠️ **pid 复用**：Windows 的 pid 会被快速复用，一个已经结束的旧进程号可能被
 * 别的进程占用而被报成"活"。这是**已知且接受**的边界（契约 §8 对应条目）——
 * 在场层是给人看的概览，不是审计凭证。要精确得比对进程启动时间，本期不做。
 */

/**
 * @typedef {{ kill?: (pid: number, signal: number) => boolean }} PidIo
 */

/**
 * 这个 pid 现在还活着吗。
 *
 * `io.kill` 只为测试注入——生产路径用 `process.kill`。
 * @param {number} pid
 * @param {PidIo} [io]
 * @returns {boolean}
 */
export function isPidAlive(pid, io = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const kill = typeof io.kill === 'function' ? io.kill : process.kill;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    const code =
      err !== null && typeof err === 'object' && 'code' in err
        ? /** @type {{ code?: unknown }} */ (err).code
        : undefined;
    return code === 'EPERM';
  }
}
