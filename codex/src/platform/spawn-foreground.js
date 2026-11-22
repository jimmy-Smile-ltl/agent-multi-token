// @ts-check
/**
 * 前台启动一个子进程并把终端交给它（`cxt exec` 用）。
 *
 * 与 `spawn-terminal.js` 的分工：
 *
 * | | `spawnTerminal()` | `spawnForeground()` |
 * |---|---|---|
 * | 干什么 | **弹一个新窗口** | 在**当前终端**跑，`stdio: 'inherit'` |
 * | 谁用 | `cxt run` | `cxt exec` |
 * | 等它结束吗 | ❌ `detached` + `unref`，立刻返回 pid | ✅ 等退出，转发退出码 |
 *
 * ⚠️ **退出码必须原样转发**（§5）。`cxt exec` 是 launch 脚本链条上的最后一环，
 * 用户在 `cmd` / `sh` 里看到的是**它的**退出码；吞掉就会让"codex 崩了"
 * 表现成"一切正常"。
 */

import { spawn as nodeSpawn } from 'node:child_process';

import { CxtError } from '../core/errors.js';

/**
 * @typedef {object} ForegroundSpec
 * @property {string} command
 * @property {string[]} args
 * @property {Record<string, string | undefined>} env
 * @property {string | null} [cwd]      不给 = 继承当前进程的 cwd
 * @property {boolean} [verbatimArgs]   ★ 只有 cmd shim 那条路该设（见 `codex-bin.js`）
 * @property {string} [label]           出错信息里怎么称呼它（默认取 `command`）
 */

/**
 * 前台跑一个命令，等它退出。
 *
 * @param {ForegroundSpec} spec
 * @param {{ spawn?: typeof nodeSpawn }} [deps]
 * @returns {Promise<number>} 退出码（**直接可以当 `cxt exec` 的返回值**）
 */
export function spawnForeground(spec, deps = {}) {
  const spawn = deps.spawn ?? nodeSpawn;
  const label = spec.label ?? spec.command;

  return new Promise((resolve, reject) => {
    /** @type {import('node:child_process').SpawnOptions} */
    const opts = { stdio: 'inherit', env: spec.env };
    if (spec.cwd !== null && spec.cwd !== undefined) opts.cwd = spec.cwd;
    // ★ 与 spawn-terminal.js 同理：只有 cmd shim 那条路才该设。
    //   设了之后 Node 不再给每个参数加引号/转义——我们自己已经转好了（§7.14⑥）。
    if (spec.verbatimArgs === true) opts.windowsVerbatimArguments = true;

    let child;
    try {
      child = spawn(spec.command, spec.args, opts);
    } catch (err) {
      reject(new CxtError(`启动 ${label} 失败：${err instanceof Error ? err.message : String(err)}`, {
        hint: '用 `cxt doctor` 看看 codex 定位与终端探测的结果',
      }));
      return;
    }

    child.on('error', (err) => {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      reject(new CxtError(
        `启动 ${label} 失败${code ? `（${code}）` : ''}：${err.message}`,
        {
          hint: code === 'ENOENT'
            ? '这个路径不存在了——它来自 config.json 的 defaults.codexBin；改掉它，或删掉该项让它自动探测'
              + '（`cxt doctor` 会报出 config.json 的完整路径）'
            : '用 `cxt doctor` 看完整诊断',
        },
      ));
    });

    child.on('exit', (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      // ★ 被信号打死时 `code` 是 null。**不能当 0 返回**——
      //   那会把"用户 Ctrl-C 掉了 codex"伪装成成功。
      if (signal !== null) {
        process.stderr.write(`cxt: ${label} 被信号 ${signal} 终止\n`);
        resolve(1);
        return;
      }
      resolve(1);
    });
  });
}
