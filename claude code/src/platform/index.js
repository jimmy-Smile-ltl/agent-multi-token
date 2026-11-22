// @ts-check
/**
 * 平台适配层——**唯一知道具体终端程序的地方**（§2.9）。
 *
 * 对外导出六件事：
 *   findExecutable()   定位可执行文件（§2.9 四）
 *   resolveTerminal()  决定怎么拉起一个新终端（纯决策，可测）
 *   spawnTerminal()    真的拉起来（唯一无法单测的部分，§6.3）
 *   fetchModels()      ★ **全项目唯一的网络代码**（§2.12 六）
 *   serveWeb()         ★ 本地网页控制台的服务端（§2.12 十一）
 *   openHostBrowser()  把控制台的 URL 交给浏览器（同上）
 *
 * `platform` / `env` / `home` 全部由 cli 层注入，所以三大平台的**规则**
 * 都能在任意一台机器上单测（§6.3）；真正只能在真机验的只剩"终端弹窗"这一件事。
 *
 * ⚠️ `serveWeb` / `openBrowser` 那两件是**逐字共享**的文件（§4.1），所以它们
 *   一个宿主值都不自己读；`openHostBrowser()` 就是补上的那一层绑定。
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';

import { EnvError } from '../core/errors.js';
import { findExecutable } from './find-executable.js';
import { openBrowser } from './open-browser.js';
import * as macos from './macos.js';
import * as linux from './linux.js';
import * as windows from './windows.js';

export { findExecutable } from './find-executable.js';
// ★ `fetchModels` 是**全项目唯一的网络代码**（§2.12 六）——和 spawn 同住这一层，
//   因为它俩是同一类东西：副作用。
export { fetchModels, DEFAULT_TIMEOUT_MS } from './fetch-models.js';
// ★ 本地网页控制台的两块：起服务、开浏览器（§2.12 十一）。
//   两块都是副作用（监听端口 / spawn），所以住这一层。
//   ⚠️ 这两个文件是**逐字共享**的——纯函数版从 `cli/` 那边拿不到宿主值，
//      所以下面配一个"宿主绑定版"（`openHostBrowser`）。`serveWeb()` 不需要：
//      它要的宿主值一个都没有（端口由系统分配，没有 home / platform 要读）。
export { openBrowser } from './open-browser.js';
// ★ 「在文件管理器里打开这个目录」（控制台第 1 步那两个按钮之一）。
//   与 `openBrowser()` 的差别：它**不需要**宿主绑定版——平台默认取
//   `process.platform`、探针默认真的去 `statSync`，生产环境直接调就是对的。
export { openPath } from './open-path.js';
export { serveWeb, MAX_BODY_BYTES } from './serve-web.js';

/** @type {Record<string, { name: string, resolveTerminal: Function }>} */
const ADAPTERS = {
  win32: windows,
  darwin: macos,
};

/**
 * 取该平台的适配器。Linux 及一切非 win32/darwin 的 POSIX 都走 linux。
 * @param {NodeJS.Platform} platform
 */
export function adapterFor(platform) {
  return ADAPTERS[platform] ?? linux;
}

/**
 * 该平台上的终端名（`cmt doctor` 用）。
 * @param {NodeJS.Platform} platform
 */
export function platformName(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return 'linux';
}

/**
 * 造一份"按该平台找可执行文件"的查找函数。
 * @param {import('../cli/types.js').Ctx} ctx
 */
export function makeFinder(ctx) {
  return (/** @type {string} */ name) =>
    findExecutable(name, { platform: ctx.platform, env: ctx.env });
}

/**
 * 解析软链（Linux 认领终端方言用）。**失败返回 `null`，不抛**——
 * 软链可能恰好在这一瞬间被删掉，不值得让整个 `cmt run` 崩掉。
 * @returns {(p: string) => string | null}
 */
export function makeRealpath() {
  return (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
}

/**
 * 在**宿主的**环境里开一个浏览器窗口（§2.12 十一）。
 *
 * ★ 为什么要有这层薄封装：`open-browser.js` 是**逐字共享**的，所以它一个宿主值
 *   都不许自己读（读了，两份拷贝就会因为机器不同而分叉）。代价是它默认的
 *   查找函数"永远回 `null`"——**不搜 `PATH`**，好让单测不因为跑测的机器恰好
 *   装了什么而漂移。生产环境**必须**走这个版本，否则 Linux 上的
 *   `google-chrome` 永远找不到，每次都静默退到 `xdg-open`（观感是"应用窗口
 *   这个功能在我的机器上就是没用"）。
 *
 * ⚠️ `home` 是必填的：`open-browser.js` 拿它展开 `~/`（macOS 的
 *   `~/Applications/...`）。**故意不给默认值**——一个猜出来的 home 会让
 *   "找不到浏览器"变成"找到了一个不存在的东西"。
 *
 * @param {string} url
 * @param {import('../cli/types.js').Ctx} ctx
 * @returns {Promise<import('./open-browser.js').OpenBrowserResult>}
 */
export function openHostBrowser(url, ctx) {
  return openBrowser(url, {
    platform: ctx.platform,
    env: ctx.env,
    home: ctx.home,
    deps: { findExecutable: makeFinder(ctx) },
  });
}

/**
 * 决定怎么拉起一个新终端——**纯决策，不 spawn**。
 *
 * @param {{
 *   title: string,
 *   cwd: string,
 *   argv: string[],
 *   mode?: 'tab' | 'window',
 *   scriptPath: string,
 * }} opts
 * @param {import('../cli/types.js').Ctx} ctx
 * @returns {import('./types.js').TerminalSpec}
 */
export function resolveTerminal({ title, cwd, argv, mode = 'tab', scriptPath }, ctx) {
  const adapter = adapterFor(ctx.platform);
  const spec = adapter.resolveTerminal({
    title,
    cwd,
    argv,
    mode,
    ctx,
    deps: { findExecutable: makeFinder(ctx), realpath: makeRealpath(), scriptPath },
  });

  if (spec.terminal === 'none' || spec.command === '') {
    throw new EnvError(
      `找不到可用的终端（试过：${spec.tried.join('、') || '无'}）`,
      {
        hint:
          '设置 $TERMINAL 指定终端，或用 `cmt run --print` 看将要执行的命令，' +
          '然后手工在目标目录里跑 `cmt exec <token>`',
      },
    );
  }
  return spec;
}

/**
 * 真的拉起来。**这是本项目唯一无法单测的一步**（§6.3），`--print` 是它的兜底。
 *
 * `detached: true` + `unref()`：新窗口独立于当前进程存活——
 * `cmt run` 敲完就返回，关掉当前终端也不影响新开的那个。
 *
 * ⚠️ **`env` 必须由调用方给，不许省。** 新终端会**继承**调用方的环境，而 Windows Terminal
 * 更会把这份环境**原样转发**给新标签页（§7.7 实测）——`cmt run` 从 Claude Code 会话里被调用时，
 * 新标签页拿到的就是那个会话的整套身份变量（`CLAUDE_CODE_CHILD_SESSION=1` 会让它
 * "Transcript saving is off"）。所以这里是净化的**唯一**关口，`run.js` 传的是
 * `stripSessionMarkers(ctx.env)`（§2.6）。
 *
 * 平台层**不认识** Claude 的会话标记，也不该认识——它只负责"用这份环境去拉"。
 *
 * @param {import('./types.js').TerminalSpec} spec
 * @param {Record<string, string | undefined>} env 交给新终端的环境（调用方负责净化）
 * @returns {{ pid: number | undefined }}
 */
export function spawnTerminal(spec, env) {
  try {
    const child = spawn(spec.command, spec.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env,
    });
    child.unref();
    return { pid: child.pid };
  } catch (err) {
    throw new EnvError(`拉不起终端（${spec.command}）：${/** @type {any} */ (err).message}`, {
      hint: `手工跑一遍看看：${spec.command} ${spec.args.join(' ')}`,
    });
  }
}
