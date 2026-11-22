// @ts-check
/**
 * 真的把终端拉起来（§2.11 二·1）。
 *
 * ⚠️ **这是 `platform/` 里唯一无法单测的部分**（§6.3）。它做的事只有一件：
 * 把 `resolveTerminal()` 算出来的规格交给 `child_process.spawn`。
 * 所有**能**在单测里覆盖的决策都已经挪进 `resolve-terminal.js` 了。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 三个 spawn 选项，每一个都是承重的
 *
 * - `detached: true` —— 在 Windows 上 libuv 把它映射成 `DETACHED_PROCESS`
 *   （**不分配控制台**），在 POSIX 上是 `setsid()`。两个效果都是我们要的：
 *   新窗口独立于 cxt，**cxt 退出后它还活着**。
 *   顺带解决一个 Windows 上的观感问题：`wt.exe` 是控制台子系统程序，
 *   不 detached 的话会闪一个黑框。
 *
 * - `stdio: 'ignore'` —— 新终端的输出**不能**接到 cxt 的管道上。
 *   否则 cxt 一退，父进程的 pipe 关了，新窗口里的进程会收到写失败。
 *
 * - `unref()` —— 不阻塞 cxt 的事件循环，让它立刻返回。
 *
 * ## `windowsVerbatimArguments`
 *
 * 由 `spec.verbatimArgs` 决定（只有 `cmd` 兜底置 true）。
 * 为什么必须有它、以及为什么**别的路径不能有**，见 `types.js` 的那段长注释。
 *
 * ## ★ 第四个选项：`env`（必填，**不给默认值**）
 *
 * `spawn()` 不传 `env` 时的默认行为是**继承 `process.env`**。对别的程序那是好事，
 * 对这里**恰恰是 bug**：Windows Terminal 会把调用方的环境**原样转发**给新标签页
 * （§7.14 实测），于是从 codex 会话里跑一次 `cxt run`，新标签页就带上了
 * 父会话的整套会话身份（`CODEX_SESSION_ID` / `CODEX_THREAD_ID` /
 * `CODEX_SQLITE_HOME` …）——新会话顶着父会话的身份跑，
 * 甚至把状态库指到**另一个 token** 的目录上（§2.6）。
 *
 * 所以 `env` 是**必填的第二个位置参数**，不是可选项：
 * 可选 = 迟早有人不传；而"忘传"不报错、只静默泄漏。
 * 必填让"忘"当场变成 `TypeError`，这是**唯一**能在结构上关掉这个口子的形状。
 *
 * ⚠️ 传进来的应当是 `stripSessionMarkers(ctx.env)`——**不是** `injection.env`。
 * §2.7 的铁律：**引用跨得过进程边界，密钥跨不过，求值发生在新窗口里**。
 * 把注入项塞进标签页的环境，等于让 token 在窗口的 shell 里多出一份，
 * 还把求值点搬到了 `cxt run` 这一侧。真正的 codex 环境由窗口内的 `cxt exec`
 * 用 `buildSessionEnv()` 现算。
 * ─────────────────────────────────────────────────────────────
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { CxtError } from '../core/errors.js';

/**
 * 拉起终端。
 *
 * **不等待新终端的生死、不返回它的退出码**——新终端是独立会话，
 * 与 cxt 无关。这里只回答一个问题："命令**发出去**了吗？"
 * （"发出去了"包括"内核接受了这个 exec"，所以 ENOENT 会在这里变成异常。）
 *
 * ★ **它是 `async` 的，这个改动是承重的**：`spawn()` 对不存在的命令
 * **不抛错**，而是在下一个 tick 发 `error` 事件。早先的版本把"等结果"拆成
 * 一个单独的 `waitForSpawn()`，于是调用方**忘了 await 它**就会变成
 * "先打印『已在终端中启动』，再抛一个 ENOENT 的 uncaught exception"——
 * 用户看到的是自相矛盾的两句话。把等待**放进函数内部**之后，
 * 这个漏法在结构上就不存在了（没有第二个函数可以忘记调）。
 *
 * @param {import('./types.js').TerminalSpec} spec
 * @param {Record<string, string | undefined>} env 新终端的环境（见上：**必填**）
 * @param {{ spawn?: typeof nodeSpawn }} [deps] 测试注入用（生产不传）
 * @returns {Promise<{ pid: number | undefined }>}
 * @throws {CxtError} spawn 本身失败（命令不存在、权限不够）
 */
export async function spawnTerminal(spec, env, { spawn = nodeSpawn } = {}) {
  /** @type {import('node:child_process').SpawnOptions} */
  const opts = {
    detached: true,
    stdio: 'ignore',
    // ★ 见文件头"第四个选项"。**这一行就是 §2.6 头号不变量的落点**：
    //   没有它，新标签页的环境 = cxt 的环境 = 调用方的环境。
    env,
  };
  if (spec.verbatimArgs === true) {
    opts.windowsVerbatimArguments = true;
  }

  let child;
  try {
    child = spawn(spec.command, spec.args, opts);
  } catch (err) {
    // spawn 的同步抛错（参数类型不对之类）——极少见，但别让它裸奔
    throw new CxtError(`拉起 ${spec.terminal} 失败：${err instanceof Error ? err.message : String(err)}`, {
      hint: '用 `cxt run --print` 打印将要执行的命令，确认路径对不对',
    });
  }

  await waitForSpawn(child, spec.terminal);
  child.unref();
  return { pid: child.pid };
}

/**
 * 等 spawn 的**异步**结果，把"命令根本不存在"变成一条能看的错误。
 *
 * ⚠️ **不导出**：它是 `spawnTerminal()` 的内部步骤，见上面那段注释——
 * 导出就等于重新打开"调用方忘了 await"这个口子。
 *
 * 成功路径上（`spawn` 事件）立刻返回，所以这不会拖慢任何东西。
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} terminal 报错时点名用
 * @returns {Promise<void>}
 */
function waitForSpawn(child, terminal) {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      resolve();
    };
    const onError = (/** @type {Error & { code?: string }} */ err) => {
      child.removeListener('spawn', onSpawn);
      const code = err.code === 'ENOENT' ? '命令不存在' : err.code === 'EACCES' ? '没有执行权限' : err.code ?? '未知';
      reject(
        new CxtError(`拉起 ${terminal} 失败（${code}）：${err.message}`, {
          hint: '用 `cxt doctor` 看终端探测结果；或 `cxt exec <token>` 在当前终端里跑',
        }),
      );
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}
