// @ts-check
/**
 * `platform/` 的门面——**这是唯一允许读宿主真实值的地方**（§4.2）。
 *
 * ```
 * bin → cli → core ← platform
 * ```
 *
 * `core/` 不读 `process.env` / `process.platform` / `os.homedir()`、不 spawn；
 * 那些真实值全部在这里读一次，然后**作为参数往下传**。
 * 好处是三大平台的规则都能在任意一台机器上单测（§6.3）——本机是 Windows，
 * 而 `resolve-terminal.test.js` 里 20 多条 macOS / Linux 断言照样跑真逻辑。
 *
 * ⚠️ 门面里的函数**都带"可覆盖宿主值"的可选参数**（`platform` / `env`）。
 * 不是为了灵活，是为了让 `cxt doctor` 能回答"如果我在 Linux 上会怎样"，
 * 以及让集成测试不用真弹窗就能验完整链路。
 */

import nodeFs from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';

import { findExecutable as pureFind, realFindDeps } from './find-executable.js';
import { openBrowser } from './open-browser.js';
import { resolveTerminal } from './resolve-terminal.js';
import { spawnForeground } from './spawn-foreground.js';
import { spawnTerminal } from './spawn-terminal.js';

// ⚠️ `waitForSpawn` **故意不导出**：它现在是 `spawnTerminal()` 的内部步骤，
//    导出就等于重新打开"调用方忘了 await"那个口子（见 spawn-terminal.js 的注释）。
export { spawnTerminal, spawnForeground, resolveTerminal };
export { buildTitle } from './resolve-terminal.js';
// ★ `fetchModels` 是**全项目唯一的网络代码**（§2.14 六）——和 spawn 同住这一层，
//   因为它俩是同一类东西：副作用。
export { fetchModels, DEFAULT_TIMEOUT_MS } from './fetch-models.js';
// ★ 本地网页控制台的两块：起服务、开浏览器（§2.14 十）。
//   两块都是副作用（监听端口 / spawn），所以住这一层。
//   ⚠️ 这两个文件是**逐字共享**的——纯函数版从 `cli/` 那边拿不到宿主值，
//      所以下面各配一个"宿主绑定版"。
export { openBrowser } from './open-browser.js';
// ★ 「在文件管理器里打开这个目录」（控制台第 1 步那两个按钮之一）。
//   与 `openBrowser()` 的差别：它**不需要**宿主绑定版——平台默认取
//   `process.platform`、探针默认真的去 `statSync`，生产环境直接调就是对的。
export { openPath } from './open-path.js';
export { serveWeb, MAX_BODY_BYTES } from './serve-web.js';

/** 宿主的 `process.platform`（只在这里读一次） */
export function hostPlatform() {
  return /** @type {NodeJS.Platform} */ (osPlatform());
}

/** 宿主的 `process.env` */
export function hostEnv() {
  return process.env;
}

/**
 * 宿主的 home，**不带尾部分隔符**。
 *
 * ⚠️ `os.homedir()` 在 Windows 上返回 `C:\Users\x`（无反斜杠），但环境变量
 * `%USERPROFILE%` 偶尔带尾斜杠——统一在这里剥掉，免得下游到处写 `replace(/[\\/]+$/,'')`。
 */
export function hostHome() {
  return homedir().replace(/[\\/]+$/, '');
}

/**
 * 在宿主的 `PATH` 上找一个可执行文件（§2.11 四）。
 *
 * 纯 JS 实现，**不 spawn `which` / `where`**——那两个命令的可用性本身就不保证。
 *
 * @param {string} name
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined> }} [opts]
 * @returns {string | null} 命中则返回**磁盘上的真实拼写**，未命中返回 `null`
 */
export function findExecutable(name, opts = {}) {
  const platform = opts.platform ?? hostPlatform();
  const env = opts.env ?? hostEnv();
  return pureFind(name, { platform, env });
}

/**
 * `fs.realpathSync` 的"失败给 null"版——给 Linux 的 `x-terminal-emulator` 软链用。
 *
 * 用 `realpathSync.native` 而不是 JS 版：只有 native 会走系统的真实解析，
 * 而 JS 版在 Windows 上会做一次"看起来像路径"的启发式处理，对重解析点不可靠。
 *
 * @param {string} p
 * @returns {string | null}
 */
export function realpathOrNull(p) {
  try {
    return nodeFs.realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * ★ **宿主绑定版的 `resolveTerminal()`**——`cxt run` / `cxt doctor` 用的就是它。
 *
 * `scriptPath` 必须由调用方给（`core/paths.js` 的 `launchScriptPath()`）：
 * `platform/` 不知道 `profiles/<token>/` 怎么排布，也不该知道。
 *
 * @param {import('./types.js').SpawnRequest & { mode?: 'window' | 'tab' }} request
 * @param {object} opts
 * @param {string} opts.scriptPath  `via: 'script'` 时会被写进去的那个脚本的绝对路径
 * @param {NodeJS.Platform} [opts.platform]
 * @param {Record<string, string | undefined>} [opts.env]
 * @returns {import('./types.js').TerminalSpec}
 */
export function resolveHostTerminal(request, { scriptPath, platform, env }) {
  const p = platform ?? hostPlatform();
  const e = env ?? hostEnv();
  return resolveTerminal(request, {
    platform: p,
    env: e,
    deps: {
      findExecutable: (name) => pureFind(name, { platform: p, env: e, fs: realFindDeps(p) }),
      realpath: realpathOrNull,
      scriptPath,
    },
  });
}

/**
 * `cxt doctor` 用：报告"这台机器上会走哪条路"。
 *
 * ★ 与 `resolveHostTerminal()` 的差别只有**不抛错**：探测全失败时返回
 * `{ ok: false, tried }`，因为 doctor 的职责恰恰是把失败摊开给用户看，
 * 而不是自己先炸掉。
 *
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.cwd
 * @param {string} input.scriptPath
 * @param {NodeJS.Platform} [input.platform]
 * @param {Record<string, string | undefined>} [input.env]
 * @returns {{ ok: true, spec: import('./types.js').TerminalSpec } | { ok: false, tried: string[], message: string }}
 */
export function detectTerminal({ title, cwd, scriptPath, platform, env }) {
  try {
    // argv 用占位符：doctor 只关心"走哪条路"，不关心真跑什么
    const spec = resolveHostTerminal({ title, cwd, argv: ['<argv>'], mode: 'tab' }, { scriptPath, platform, env });
    return { ok: true, spec };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 错误文本里本来就有 `  · 候选: 原因` 那几行，原样带回给 doctor 渲染
    const tried = message.split('\n').slice(1).map((l) => l.replace(/^\s*·\s*/, ''));
    return { ok: false, tried, message };
  }
}

/**
 * ★ **宿主绑定版的 `openBrowser()`**——控制台启动时用的就是它。
 *
 * 与 `resolveHostTerminal()` 同一个套路：把宿主值（平台 / 环境 / 家目录）
 * 一次性填进去，并给它一个**真的会搜 `PATH`** 的查找函数。
 *
 * ⚠️ 纯函数版的默认查找函数是"永远回 `null`"（**不搜 `PATH`**）——那是为了
 * 让单测不因为跑测的机器恰好装了什么而漂移。生产环境必须走这个版本，
 * 否则 Linux 上的 `google-chrome` 永远找不到，每次都静默退到 `xdg-open`。
 *
 * @param {string} url
 * @param {{ platform?: NodeJS.Platform, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<import('./open-browser.js').OpenBrowserResult>}
 */
export function openHostBrowser(url, opts = {}) {
  const platform = opts.platform ?? hostPlatform();
  const env = opts.env ?? hostEnv();
  return openBrowser(url, {
    platform,
    env,
    home: hostHome(),
    deps: { findExecutable: (name) => pureFind(name, { platform, env, fs: realFindDeps(platform) }) },
  });
}
