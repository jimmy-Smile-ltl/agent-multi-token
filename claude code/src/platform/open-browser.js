// @ts-check
/**
 * 把控制台的 URL 交给浏览器（「面板 · Web 控制台」）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 两档：先应用窗口，不行再退默认浏览器
 *
 * | 档 | 条件 | 命令 |
 * |---|---|---|
 * | **应用窗口** | 本机装了 Chrome / Edge | `<exe> --app=<url>` |
 * | **默认浏览器** | 没找到，**或者上面那条起不来** | 各平台"打开这个 URL"的默认命令 |
 *
 * 应用窗口那档是**体验**：`--app=` 开出来的窗口没有地址栏、没有标签页、没有书签栏，
 * 看上去就是个原生客户端——正是这个功能想要的样子。
 *
 * 默认浏览器那档是**可用性**：宁可开出一个带地址栏的普通窗口，也不能因为
 * "没找到 Chrome" 就让用户对着一行 URL 自己复制粘贴。
 *
 * ## ★ 这个函数**从不抛错**，也**从不写 stdout**
 *
 * 它回一个纯数据的结果。理由：**开不出浏览器不是致命错误**——调用方手里
 * 永远有那行 URL，用户自己粘一下就能用。把它变成异常只会逼调用方写
 * `try/catch` 然后原样忽略，而那正是"异常当控制流"的坏味道。
 *
 * 同理，它不打印任何东西：这一层不认识终端、不认识配色、更不认识工具名。
 * 要说什么由调用方说。
 *
 * ## ★ 逐字一致：这个文件与姊妹项目的那份**逐字相同**
 *
 * 所以这里**不许**出现：工具名、环境变量名、项目的错误类型、契约节号、
 * 以及任何写死到 stdout 的输出。
 *
 * ★ 由此推出一条硬约束：**这个文件必须自给自足**——不许 import 项目里的
 *   任何其它模块（`platform/index.js`、`find-executable.js` 都不是共享文件，
 *   两份副本随时可能漂移）。下面那几段十行的工具函数是**故意重复**的，
 *   不是抄漏了。
 * ─────────────────────────────────────────────────────────────
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { win32 as win32Path, posix as posixPath } from 'node:path';

/**
 * 候选浏览器表。**顺序即优先级**——Chrome 先于 Edge。
 *
 * 三种候选：
 *
 * | `kind` | 含义 | 例 |
 * |---|---|---|
 * | `path` | 绝对路径；`~/` 开头表示用户主目录 | macOS 的 `.app` 包 |
 * | `env`  | `%VAR%\rel`——Windows 的安装位置由环境变量决定 | `%LOCALAPPDATA%\…\chrome.exe` |
 * | `name` | 走 `PATH` 找（由调用方注入的查找函数负责） | Linux 的 `google-chrome` |
 *
 * ⚠️ Windows 上**三条 `env` 都要有**：Chrome 装成"仅为我"时在 `LOCALAPPDATA`，
 * 装成"所有人"时在 `PROGRAMFILES`，而 64 位 Edge 历史上落在 `PROGRAMFILES(X86)`。
 * 少一条的表现是**在某些机器上静默退到默认浏览器**——不报错，只是没那么好看。
 *
 * @type {Record<string, { browser: 'chrome' | 'edge', kind: 'path' | 'env' | 'name', value: string, rel?: string }[]>}
 */
const CANDIDATES = {
  win32: [
    { browser: 'chrome', kind: 'env', value: 'LOCALAPPDATA', rel: 'Google\\Chrome\\Application\\chrome.exe' },
    { browser: 'chrome', kind: 'env', value: 'PROGRAMFILES', rel: 'Google\\Chrome\\Application\\chrome.exe' },
    { browser: 'chrome', kind: 'env', value: 'PROGRAMFILES(X86)', rel: 'Google\\Chrome\\Application\\chrome.exe' },
    // PATH 上基本不会有，但 scoop / chocolatey 之类会往里放——试一下不花钱
    { browser: 'chrome', kind: 'name', value: 'chrome' },
    { browser: 'edge', kind: 'env', value: 'PROGRAMFILES(X86)', rel: 'Microsoft\\Edge\\Application\\msedge.exe' },
    { browser: 'edge', kind: 'env', value: 'PROGRAMFILES', rel: 'Microsoft\\Edge\\Application\\msedge.exe' },
    { browser: 'edge', kind: 'env', value: 'LOCALAPPDATA', rel: 'Microsoft\\Edge\\Application\\msedge.exe' },
    { browser: 'edge', kind: 'name', value: 'msedge' },
  ],
  darwin: [
    { browser: 'chrome', kind: 'path', value: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { browser: 'chrome', kind: 'path', value: '~/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
    { browser: 'edge', kind: 'path', value: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
    { browser: 'edge', kind: 'path', value: '~/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
  ],
  linux: [
    { browser: 'chrome', kind: 'name', value: 'google-chrome' },
    { browser: 'chrome', kind: 'name', value: 'google-chrome-stable' },
    { browser: 'edge', kind: 'name', value: 'microsoft-edge' },
    { browser: 'edge', kind: 'name', value: 'microsoft-edge-stable' },
  ],
};

/** `--app=` 开出来的窗口没有地址栏。**这一个 flag 就是"像原生客户端"的全部来源。** */
const APP_FLAG = '--app=';

/**
 * 三个 spawn 选项，和拉起终端那套同源：`detached` 让浏览器独立于本进程
 * （我们退出了它还活着，且 Windows 上不闪黑框），`stdio: 'ignore'` 不让它
 * 接到我们的管道上，随后 `unref()` 不吊住事件循环。
 */
const SPAWN_OPTS = { detached: true, stdio: 'ignore' };

/**
 * ★★ URL 白名单：必须是 http/https，且**一个 cmd 元字符都不许有**。
 *
 * 默认浏览器那档在 Windows 上要走 `cmd`，而 `cmd` 认 `& | < > ^ % " \``——
 * 一个含 `&` 的 URL 会把 `start` 后面的东西切成第二条命令。
 *
 * ★ 这不是"够用就行"：本函数拿到的 URL 是我们自己拼的
 *   （`http://127.0.0.1:<端口>/<口令>/`，口令限定 `[A-Za-z0-9_-]`），
 *   **永远不含这些字符**，所以这条规则不损失任何合法用法。
 *   它挡的是"将来有人把别的东西喂进来"。
 *
 * ★★ 写成**正向白名单**（RFC 3986 的 unreserved + gen-delims + sub-delims，
 *   再挖掉 `&` `'` `%`）而不是"排除若干坏字符"，有两个好处：
 *   ① 默认拒绝——将来冒出来的新元字符不用等谁想起来加进黑名单；
 *   ② 控制字符**天然进不来**（NUL / CR / LF 都不在字母表里），于是这条规则
 *      不需要写出 U+0000 的转义——**那个转义在本仓库里会被落成一个真的 NUL
 *      字节**，等于规则自己制造了一个裸控制字符（已经踩过两次）。
 */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$()*+,;=]+$/i;

/**
 * `openBrowser()` 的返回值。
 *
 * ★ **五个字段一个不少，成功失败都一样**——调用方不用做 `undefined` 检查，
 *   于是"某个分支忘了给某个字段"这类错在类型层面就没了。
 *
 * @typedef {{
 *   ok: boolean,
 *   via: 'app' | 'default' | null,
 *   browser: 'chrome' | 'edge' | null,
 *   exe: string | null,
 *   reason: string,
 * }} OpenBrowserResult
 */

/**
 * 打开一个 URL。
 *
 * @param {string} url 只接受 `http://` / `https://`
 * @param {object} [input]
 * @param {NodeJS.Platform} [input.platform] 默认宿主
 * @param {Record<string, string | undefined>} [input.env] 默认宿主（读 `COMSPEC` 等）
 * @param {string} [input.home] 用户主目录的绝对路径（展开 `~/`）。**不给默认值**——
 *   这一层不认识 `os.homedir()`，由调用方注入
 * @param {{ spawn?: typeof nodeSpawn, isFile?: (p: string) => boolean, findExecutable?: (name: string) => string | null }} [input.deps]
 *   测试注入。`findExecutable` 默认返回 `null`——**默认不搜 `PATH`**，
 *   于是单测里不会因为跑测的机器恰好装了 Chrome 而漂移
 * @returns {Promise<OpenBrowserResult>}
 */
export async function openBrowser(url, input = {}) {
  const platform = input.platform ?? /** @type {NodeJS.Platform} */ (process.platform);
  const env = input.env ?? process.env;
  const home = input.home ?? '';
  const deps = input.deps ?? {};
  const spawn = deps.spawn ?? nodeSpawn;
  const isFile = deps.isFile ?? defaultIsFile;
  const findExecutable = deps.findExecutable ?? (() => null);

  if (typeof url !== 'string' || !SAFE_URL.test(url)) {
    return fail('只接受不含特殊字符的 http/https URL');
  }

  /** 应用窗口那档失败的原因，退到默认浏览器时一并带回去（好让调用方能解释） */
  let appReason = '';

  const hit = resolveBrowserExe(platform, { env, home, isFile, findExecutable });
  if (hit !== null) {
    const r = await trySpawn(spawn, hit.path, [APP_FLAG + url], SPAWN_OPTS);
    if (r.ok) return { ok: true, via: 'app', browser: hit.browser, exe: hit.path, reason: '' };
    // ★ 找到了却起不来（被杀软拦、权限不够、装坏了）——**继续往下退**，
    //   而不是把"有 Chrome 但打不开"直接甩给用户。这正是"两档"的意义。
    appReason = `应用窗口起不来（${r.reason}）`;
  }

  const spec = defaultSpec(platform, env, url);
  const r2 = await trySpawn(spawn, spec.command, spec.args, { ...SPAWN_OPTS, windowsVerbatimArguments: spec.verbatim });
  if (r2.ok) return { ok: true, via: 'default', browser: null, exe: spec.command, reason: appReason };
  return fail(r2.reason);
}

/**
 * @param {string} reason
 * @returns {{ ok: false, via: null, browser: null, exe: null, reason: string }}
 */
function fail(reason) {
  return { ok: false, via: null, browser: null, exe: null, reason };
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * 默认的"这是不是一个普通文件"。
 *
 * ★ 这里**没有**走"`statSync` 失败再看 `lstatSync`"那条兜底——那条是为
 *   App Execution Alias（商店应用别名，普通用户跟不过去重解析点）准备的，
 *   而 Chrome / Edge 是普通安装文件。
 *
 * ★ 就算某台机器上真的看走了眼，后果也只是**退到默认浏览器**——
 *   一个优雅降级，不是静默失败。所以这里保持简单。
 *
 * @param {string} p
 * @returns {boolean}
 */
function defaultIsFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 按候选表找出一个 Chrome / Edge 的**可执行文件绝对路径**。找不到回 `null`。
 *
 * ★ 表里**顺序即优先级**：Chrome 的每一条都排在 Edge 前面——所以"两个都装了"
 *   时拿到的是 Chrome，而"Chrome 的第三条才命中"时也不会被 Edge 抢走。
 *
 * @param {NodeJS.Platform} platform
 * @param {{ env: Record<string, string | undefined>, home: string, isFile: (p: string) => boolean, findExecutable: (n: string) => string | null }} ctx
 * @returns {{ browser: 'chrome' | 'edge', path: string } | null}
 */
function resolveBrowserExe(platform, ctx) {
  const pathMod = platform === 'win32' ? win32Path : posixPath;
  for (const c of CANDIDATES[platform] ?? []) {
    if (c.kind === 'name') {
      const p = ctx.findExecutable(c.value);
      if (typeof p === 'string' && p !== '') return { browser: c.browser, path: p };
      continue;
    }
    if (c.kind === 'path') {
      const p = expandHome(c.value, ctx.home);
      if (p !== null && ctx.isFile(p)) return { browser: c.browser, path: p };
      continue;
    }
    const base = readEnv(ctx.env, c.value, platform);
    if (typeof base !== 'string' || base === '') continue;
    const p = pathMod.join(base, c.rel ?? '');
    if (ctx.isFile(p)) return { browser: c.browser, path: p };
  }
  return null;
}

/**
 * 展开开头的 `~/`。`home` 是空的（调用方没给）时回 `null`——**不猜**。
 *
 * ⚠️ 只认 `~/`，不认裸 `~`：`~foo` 是"用户 foo 的家目录"，那是另一套语义，
 * 而这里根本用不上。认了反而要处理一个我们没有的信息来源。
 *
 * @param {string} value
 * @param {string} home
 * @returns {string | null}
 */
function expandHome(value, home) {
  if (!value.startsWith('~/')) return value;
  if (home === '') return null;
  return home.replace(/[/\\]+$/, '') + value.slice(1);
}

/**
 * 读环境变量。**Windows 上大小写不敏感**，POSIX 上敏感。
 *
 * ★ 这个十行函数是从 `find-executable.js` **故意抄过来的**，不是忘了 import：
 *   那个文件**不是**共享文件，两份副本随时可能漂移，而这个文件必须逐字一致。
 *   抄一份的代价是十行，import 的代价是"哪天它变了、这边跟着变、然后两个项目的
 *   行为悄悄分叉"。
 *
 * 真机上 Windows 的变量名常写作 `Path` / `ComSpec` 而不是全大写——靠
 * `process.env` 自带的魔法能跑，但调用方一旦把环境拷成普通对象，魔法就没了。
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @param {NodeJS.Platform} platform
 * @returns {string | undefined}
 */
function readEnv(env, name, platform) {
  if (env == null) return undefined;
  const direct = env[name];
  if (direct !== undefined) return direct;
  if (platform !== 'win32') return undefined;
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) return env[k];
  }
  return undefined;
}

/**
 * 兜底用的解释器。**不走"找可执行文件"那条路**——`cmd.exe` 由 `%COMSPEC%` 保证。
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function comspecOf(env) {
  const v = readEnv(env, 'COMSPEC', 'win32');
  return typeof v === 'string' && v !== '' ? v : 'cmd.exe';
}

/**
 * "用默认浏览器打开这个 URL"在各平台上的确切命令。
 *
 * ## ★★ Windows：那个**空的 `""` 是标题位**，不是可有可无的装饰
 *
 * `start` 把**第一个带引号的参数永远当成窗口标题**。少了它，`start` 会把 URL
 * 本身当成标题——于是**什么都不会打开**，而命令照样返回 0。
 * 真机上的表现是"点了没反应"，且**不报任何错**。这是这一层最容易写错、
 * 也最难自己发现的一处，所以它有一条专门的测试盯着。
 *
 * 整条命令再包一层引号 + `/d /s /c`：`cmd /c` 对后面那串是"先剥首尾引号再分词"，
 * 于是带空格的 URL 即使加了引号也会被切开；`/d /s /c` + **一整条命令字符串**
 * 是唯一稳的形态。配套的 `windowsVerbatimArguments` 保证 Node 不再加工一遍。
 *
 * ## 另外两个平台
 *
 * `open` 与 `xdg-open` 都只收一个参数、不需要引号戏法——URL 里没有空格
 * （上面那条白名单保证的）。
 *
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @param {string} url
 * @returns {{ command: string, args: string[], verbatim: boolean }}
 */
function defaultSpec(platform, env, url) {
  if (platform === 'win32') {
    const cmd = comspecOf(env);
    return { command: cmd, args: ['/d', '/s', '/c', `"start "" "${url}""`], verbatim: true };
  }
  if (platform === 'darwin') return { command: 'open', args: [url], verbatim: false };
  // ★ 其余一切（含 Linux 与 BSD）：`xdg-open` 是事实标准
  return { command: 'xdg-open', args: [url], verbatim: false };
}

/**
 * spawn 一个**不关心生死**的子进程，只回答"命令发出去了吗"。
 *
 * `spawn()` 对不存在的命令**不抛错**，而是在下一个 tick 发 `error` 事件。
 * 所以等待必须发生在**函数内部**——拆出去的话，调用方忘了 await 就会变成
 * "先报『已打开』，再抛一个 ENOENT 的未捕获异常"，用户看到两句自相矛盾的话。
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
