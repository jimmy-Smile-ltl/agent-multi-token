// @ts-check
/**
 * 在系统的文件管理器里打开一个目录（「面板 · Web 控制台」）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它做什么
 *
 * | 平台 | 命令 |
 * |---|---|
 * | Windows | `explorer.exe <目录>` |
 * | macOS | `open <目录>` |
 * | 其余（Linux / BSD） | `xdg-open <目录>` |
 *
 * ## ★★ 三条 argv，**一个字都不进 shell**
 *
 * 路径是用户自己在表单里敲的，会原样变成 `spawn()` 的第二个参数。这里
 * **没有** `cmd /c`、**没有** `sh -c`、**没有**字符串拼接——于是 `&`、`|`、
 * `"`、`^` 这些在命令行里有含义的字符，在这里只是**文件名的一部分**。
 *
 * ⚠️ 这与 `open-browser.js` 那条 Windows 路径**故意不同**：那个要开的是
 *   URL，而"用默认浏览器打开一个 URL"没有可直接执行的东西，只能借
 *   `cmd start`，于是才有那个空 `""`（标题位）的戏法。开目录**有**：
 *   `explorer.exe` 直接收路径。**少一层 shell 就少一类能出错的地方。**
 *
 * ## ★ Windows 上不要去看退出码
 *
 * `explorer.exe` **成功也回 1**。所以这里只等 `spawn` 事件（"命令发出去了吗"），
 * 不等 `exit`——等退出码会把每一次成功都读成失败。
 *
 * ## ★ 这个函数**从不抛错**，也**从不写 stdout**
 *
 * 理由与 `open-browser.js` 相同：开不出文件管理器不是致命错误，调用方手里
 * 还有那行路径。回一个纯数据的结果，由调用方决定说什么。
 *
 * ## ★ 逐字一致：与姊妹项目的那份**逐字相同**
 *
 * 所以这里**不许**出现：工具名、环境变量名、项目的错误类型、契约节号、
 * 以及任何写死到 stdout 的输出。它必须**自给自足**——只 import node 内置模块。
 * ─────────────────────────────────────────────────────────────
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';

/**
 * 和拉起终端、开浏览器那套同源：`detached` 让文件管理器独立于本进程
 * （我们退出了它还开着，且 Windows 上不闪黑框），`stdio: 'ignore'` 不让它
 * 接到我们的管道上，随后 `unref()` 不吊住事件循环。
 */
const SPAWN_OPTS = { detached: true, stdio: 'ignore' };

/**
 * `openPath()` 的返回值。★ **两个字段成功失败都一样给**，调用方不用做
 * `undefined` 检查。
 *
 * @typedef {{ ok: boolean, reason: string }} OpenPathResult
 */

/**
 * 探针结果。`'missing'` 与 `'file'` 分开，是为了**说清是哪一种**——
 * "这个目录不存在"和"这是一个文件，不是目录"是两句不同的话，
 * 混成一句会让用户去查一个不存在的问题。
 *
 * @typedef {'dir' | 'file' | 'missing'} PathKind
 */

/**
 * 在文件管理器里打开 `dir`。
 *
 * @param {string} dir 目录的**绝对路径**（`~` / 相对路径由调用方解析好再进来：
 *   这一层不认识 `ctx.home`，也不认识 `ctx.cwd`）
 * @param {object} [input]
 * @param {NodeJS.Platform} [input.platform] 默认宿主
 * @param {{ spawn?: typeof nodeSpawn, probe?: (p: string) => PathKind }} [input.deps]
 *   测试注入。★ 默认探针**真的去 statSync**——这是这个文件与 `open-browser.js`
 *   的一个差别：那边默认"找不到浏览器"是为了不让单测看跑测机器的脸色，
 *   而这里"目录存不存在"是**被测对象本身**，藏起来就没得测了。
 * @returns {Promise<OpenPathResult>}
 */
export async function openPath(dir, input = {}) {
  const platform = input.platform ?? /** @type {NodeJS.Platform} */ (process.platform);
  const deps = input.deps ?? {};
  const spawn = deps.spawn ?? nodeSpawn;
  const probe = deps.probe ?? defaultProbe;

  if (typeof dir !== 'string' || dir.trim() === '') {
    return fail('没有给路径');
  }
  // ★ 先挡控制字符再交给 spawn：一个 NUL 会让 spawn 在**进程之外**抛
  //   ERR_INVALID_ARG_VALUE，而那是个异常，不是一个能说给人听的失败。
  if (hasControlChar(dir)) {
    return fail('路径里有控制字符');
  }

  const kind = probe(dir);
  if (kind === 'missing') return fail('这个目录不存在');
  if (kind === 'file') return fail('这是一个文件，不是目录');

  // ★ 到这里 `dir` 一定是**存在的目录**。探测在 spawn 之前，所以
  //   "打不开"只会是"文件管理器本身起不来"，不会是"路径不对"——
  //   这两类失败的原因能分开说。
  const spec = specFor(platform, dir);
  const r = await trySpawn(spawn, spec.command, spec.args, SPAWN_OPTS);
  return r.ok ? { ok: true, reason: '' } : fail(r.reason);
}

/**
 * @param {string} reason
 * @returns {{ ok: false, reason: string }}
 */
function fail(reason) {
  return { ok: false, reason };
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * 默认探针：**真的去磁盘上看一眼**。
 *
 * @param {string} p
 * @returns {PathKind}
 */
function defaultProbe(p) {
  try {
    return statSync(p).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

/**
 * 路径里有没有控制字符（含 DEL）。
 *
 * ★★ **这里用的是码点比较，不是正则里的转义。** 本仓库里写出那个
 *   NUL 的转义序列，**落盘时会变成一个真的控制字节**（已经踩过两次），
 *   于是"检查控制字符"的这行代码本身就成了源码卫生测试的违规项。
 *   用 `charCodeAt` 就不存在这个转义，这条规则也就永远不会自我违反。
 *
 * @param {string} s
 * @returns {boolean}
 */
function hasControlChar(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * "在文件管理器里打开这个目录"在各平台上的确切命令。
 *
 * ★ 三个平台都是 **`[目录]` 一个参数**，没有任何引号戏法——因为都不过 shell。
 *   这正是这个文件比 `open-browser.js` 短一半的原因。
 *
 * @param {NodeJS.Platform} platform
 * @param {string} dir
 * @returns {{ command: string, args: string[] }}
 */
function specFor(platform, dir) {
  if (platform === 'win32') return { command: 'explorer.exe', args: [dir] };
  if (platform === 'darwin') return { command: 'open', args: [dir] };
  // ★ 其余一切（含 Linux 与 BSD）：`xdg-open` 是事实标准
  return { command: 'xdg-open', args: [dir] };
}

/**
 * spawn 一个**不关心生死**的子进程，只回答"命令发出去了吗"。
 *
 * `spawn()` 对不存在的命令**不抛错**，而是在下一个 tick 发 `error` 事件。
 * 所以等待必须发生在**函数内部**——拆出去的话，调用方忘了 await 就会变成
 * "先报『已打开』，再抛一个 ENOENT 的未捕获异常"。
 *
 * @param {typeof nodeSpawn} spawn
 * @param {string} command
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} opts
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
function trySpawn(spawn, command, args, opts) {
  let child;
  try {
    child = spawn(command, args, opts);
  } catch (err) {
    return Promise.resolve({ ok: false, reason: message(err) });
  }
  return new Promise((resolve) => {
    const onSpawn = () => {
      child.removeListener('error', onError);
      child.unref();
      resolve({ ok: true });
    };
    const onError = (/** @type {Error & { code?: string }} */ err) => {
      child.removeListener('spawn', onSpawn);
      resolve({ ok: false, reason: message(err) });
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}
