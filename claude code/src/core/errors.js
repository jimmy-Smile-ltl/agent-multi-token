// @ts-check
/**
 * 错误类型与退出码（§6.2）。
 *
 * 约定：**所有对外错误都抛 CmtError**，CLI 层统一捕获渲染。
 * 报错必须带 `hint`——给出下一步命令，别让用户猜。
 */

export const EXIT = /** @type {const} */ ({
  /** 成功 */
  OK: 0,
  /** 用户错误：token 不存在、名字非法、参数冲突、四要素缺项 */
  USER: 1,
  /** 环境错误：claude 不在 PATH、终端探测失败、目录不可写 */
  ENV: 2,
});

export class CmtError extends Error {
  /**
   * @param {string} message 一句话说清"哪里错了"
   * @param {{ code?: number, hint?: string }} [opts]
   *   `code` 是**退出码**（§6.2）；`hint` 是"下一步该敲什么命令"
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'CmtError';
    this.code = opts.code ?? EXIT.USER;
    this.hint = opts.hint;
  }
}

/** 环境错误（退出码 2）——本机缺东西，不是用户敲错了 */
export class EnvError extends CmtError {
  /**
   * @param {string} message
   * @param {{ hint?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { ...opts, code: EXIT.ENV });
    this.name = 'EnvError';
  }
}

/**
 * 把错误渲染成给人看的文本（CLI 层唯一出口）。
 * @param {unknown} err
 * @returns {string}
 */
export function renderError(err) {
  if (err instanceof CmtError) {
    return err.hint ? `${err.message}\n${err.hint}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
