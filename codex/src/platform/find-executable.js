// @ts-check
/**
 * 可执行文件定位（§2.11 四）——**纯 JS 实现，不 spawn `which` / `where`**。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么不 spawn `which`
 *
 * 1. **`which` 自己也可能不在**（尤其 Windows、精简容器、Git Bash 之外的环境）；
 * 2. spawn 一次要几十毫秒，而 `cxt` 每次启动都要定位 `codex` 与终端；
 * 3. spawn 让这个函数**没法单测**——而它恰恰是三平台规则差异最大的地方之一。
 *
 * 签名与契约一致：`findExecutable(name, { platform, env })`。
 * 第三项 `fs` 是**可选注入**，默认用真 `node:fs`——测试塞个假的进去，
 * 于是**三大平台的定位规则都能在任意一台机器上单测**（§6.3）。
 * 本机是 Windows，但下面 `linux` 那组测试照样跑得动。
 * ─────────────────────────────────────────────────────────────
 *
 * ## 两个平台的规则**不一样**，别合并
 *
 * | | POSIX | Windows |
 * |---|---|---|
 * | `PATH` 分隔符 | `:` | `;` |
 * | 候选名 | 原样 | 逐个试 `PATHEXT`（`.COM;.EXE;.BAT;.CMD`） |
 * | 判定 | `fs.accessSync(p, X_OK)` —— **可执行位** | 只看**存在性**（`X_OK` 在 Windows 上无意义） |
 *
 * ⚠️ **Windows 上不带扩展名的文件不算可执行文件**，所以这里**不返回裸名**。
 * 不是洁癖：`CreateProcess` 要求扩展名在 `PATHEXT` 里，返回 `C:\bin\codex` 只会让
 * 调用方在 spawn 时收到一个完全不指向原因的错。`where.exe` 也是这个行为。
 *
 * ⚠️ Windows 的 `PATHEXT` 默认**不含 `.PS1`**，所以 `findExecutable('foo')`
 * 找不到 `foo.ps1`——这是**有意**的，PowerShell 脚本不能直接当可执行文件跑。
 * 调用方要 PowerShell 脚本得自己带扩展名。
 *
 * ⚠️ **`env.PATHEXT` 缺失或为空时要退回默认值**，不是"没有扩展名可试"。
 * 真机上 `PATHEXT` 确实可能没被设置（服务账户、某些 CI），此时按默认集试。
 */

import * as nodeFs from 'node:fs';
import { posix as posixPath, win32 as win32Path } from 'node:path';

/** Windows 的默认扩展名集（`PATHEXT` 缺失时用） */
export const DEFAULT_PATHEXT = Object.freeze(['.COM', '.EXE', '.BAT', '.CMD']);

/**
 * 读环境变量。**Windows 上大小写不敏感**，POSIX 上敏感。
 *
 * 为什么要显式写：`process.env` 在 Node 主线程上确实是大小写不敏感的（Windows），
 * 但一旦有人把环境**拷成普通对象**（本项目到处都在注入 `env`），这个性质就没了。
 * 真机上 Windows 的变量名常写作 `Path` 而不是 `PATH`——靠 `process.env` 的魔法
 * 侥幸能跑，换个人工构造的 env 就静默找不到。
 *
 * @param {Record<string, string | undefined> | null | undefined} env
 * @param {string} name
 * @param {NodeJS.Platform} platform
 * @returns {string | undefined}
 */
export function getEnvVar(env, name, platform) {
  if (env == null) return undefined;
  const direct = env[name];
  if (direct !== undefined) return direct;
  if (platform !== 'win32') return undefined;   // POSIX：名字就是名字，没有别名
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) return env[k];
  }
  return undefined;
}

/**
 * 把 `PATH` 拆成目录列表。**空段要丢掉**。
 *
 * 空段的来源：`PATH` 里连续的分隔符、开头/结尾的分隔符。
 * POSIX 上空段历史上表示"当前目录"，但那是**危险**的语义（能执行到任意
 * 工作目录下的同名文件），现代实现基本都不这么做了。**我们直接丢**。
 *
 * ⚠️ 分隔符必须按**目标平台**选：Windows 的路径本身含 `:`（`C:\bin`），
 * 拿 `:` 去拆 Windows 的 `PATH` 会把它碎成一地。
 *
 * @param {string | undefined} pathValue
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
export function splitPath(pathValue, platform) {
  if (typeof pathValue !== 'string' || pathValue === '') return [];
  const sep = platform === 'win32' ? ';' : ':';
  return pathValue.split(sep).filter((d) => d.trim() !== '');
}

/**
 * 把 `PATHEXT` 拆成扩展名列表。**统一成大写**（Windows 上大小写不敏感）。
 * @param {string | undefined} pathextValue
 * @returns {string[]}
 */
export function splitPathext(pathextValue) {
  if (typeof pathextValue !== 'string' || pathextValue.trim() === '') {
    return [...DEFAULT_PATHEXT];
  }
  const list = pathextValue
    .split(';')
    .map((e) => e.trim().toUpperCase())
    .filter((e) => e !== '');
  return list.length > 0 ? list : [...DEFAULT_PATHEXT];
}

/**
 * `findExecutable()` 的依赖。测试塞假的就是这个形状——只用到四个方法，
 * 所以不用真建文件就能穷举两个平台的规则。
 *
 * @typedef {{
 *   isFile: (p: string) => boolean,
 *   isExecutable: (p: string) => boolean,
 *   join: (...parts: string[]) => string,
 *   realName: (p: string) => string,
 * }} FindDeps
 */

/**
 * 造一个基于真实 `node:fs` 的 `FindDeps`。
 *
 * ⚠️ `join` 必须按**目标平台**选：`node:path` 的默认导出用的是**宿主**规则，
 * 在 Windows 上 `join('/home/t', 'x')` 会得到 `'\home\t\x'`（§2.11）。
 * 判据见 §2.11：「这个函数收不收 `platform` 参数？」——它收，所以用 `platform` 选。
 *
 * @param {NodeJS.Platform} platform
 * @param {typeof import('node:fs')} [fsMod]
 * @returns {FindDeps}
 */
export function realFindDeps(platform, fsMod = nodeFs) {
  const pathMod = platform === 'win32' ? win32Path : posixPath;

  /** 普通文件：`statSync().isFile()` */
  const isPlainFile = (p) => {
    try { return fsMod.statSync(p).isFile(); } catch { return false; }
  };

  /**
   * ★★ Windows 的"文件"判定——**必须带 App Execution Alias 兜底**。
   *
   * 2026-10-17 真机撞出来的：`%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`
   * （Microsoft Store 的应用别名，Windows Terminal 就装成这样）是个**重解析点**，
   * 目标在 MSIX 包目录里，普通用户没权限跟过去。于是：
   *
   * | 调用 | 结果 |
   * |------|------|
   * | `statSync(p)` | **EACCES** ← 它要跟随重解析点 |
   * | `existsSync(p)` | **false** ← 内部就是 statSync |
   * | `lstatSync(p)` | OK：`isSymbolicLink() === true`、`isFile() === false` |
   * | `readdirSync(目录)` | OK，`wt.exe` 就在列表里 |
   *
   * ⇒ 只用 `statSync().isFile()` 的话，`findExecutable('wt')` **静默返回 null**，
   *   而 §2.11 的 Windows 首选就是 `wt.exe`——结果就是**首选路径永远不生效**，
   *   每次都悄悄退到 `cmd /c start` 兜底（丢 cwd、丢窗口标题、多一层 shell）。
   *   静默降级正是本项目最忌讳的那类 bug。
   *
   * 所以：stat 失败时再看 `lstatSync`——**重解析点也算文件**，因为 Windows 跑得动它。
   * 这条兜底**只在 Windows 上开**：POSIX 上的悬空符号链接不该被当成可执行文件，
   * 那边由 `accessSync(X_OK)` 自然处理（它会失败，正是我们要的）。
   */
  const isFile = (p) => {
    if (isPlainFile(p)) return true;
    if (platform !== 'win32') return false;
    try { return fsMod.lstatSync(p).isSymbolicLink(); } catch { return false; }
  };

  return {
    join: pathMod.join,
    isFile,
    isExecutable: (p) => {
      // Windows 上 `X_OK` 基本是 no-op（只反映只读位），所以直接复用 isFile——
      // 这不是偷懒，是 §2.11 四明确规定的"Windows 只看存在性"
      if (platform === 'win32') return isFile(p);
      try { fsMod.accessSync(p, fsMod.constants.X_OK); return true; } catch { return false; }
    },
    // ★ 把构造出来的候选名换成**磁盘上的真实拼写**。
    //
    //   为什么需要：Windows 的 `PATHEXT` 是 `.COM;.EXE;.BAT;.CMD`（大写），
    //   而磁盘上装出来的通常是 `codex.cmd`（小写）。候选名是我们拼的，
    //   所以不加这一步就会返回 `...\npm\codex.CMD`——功能上没问题
    //   （Windows 大小写不敏感），但这个字符串会被写进 `defaults.codexBin`
    //   （§2.12 第 3 级），用户在配置文件里看到一个磁盘上不存在的拼写很难解释。
    //
    //   代价被**刻意**压在：只在命中之后、只对命中的那一个目录、只做一次 readdir。
    //   不是"每个 PATH 目录都 readdir"——那会让每次 cxt 启动都去扫一遍 System32。
    realName: (p) => {
      try {
        const dir = pathMod.dirname(p);
        const lower = pathMod.basename(p).toLowerCase();
        const hit = fsMod.readdirSync(dir).find((e) => e.toLowerCase() === lower);
        return hit === undefined ? p : pathMod.join(dir, hit);
      } catch {
        return p;   // 读不到目录就当没这回事，用构造名（别为了好看把定位搞失败）
      }
    },
  };
}

/**
 * 定位一个可执行文件，返回**绝对路径**或 `null`。
 *
 * 目录与扩展名的**遍历顺序是「目录在外、候选名在内」**——先试完 `PATH` 里
 * 第一个目录的所有扩展名，再进第二个目录。这与 Windows 自身的查找顺序一致
 * （`PATH` 的先后压过扩展名的优先级：早目录里的 `foo.bat` 赢过后目录里的 `foo.exe`）。
 *
 * @param {string} name
 *   可执行文件名。Windows 上**不带扩展名**（`codex`，不是 `codex.cmd`）——
 *   扩展名由 `PATHEXT` 试出来。带扩展名也支持（不会重复追加）。
 *   含路径分隔符时按路径处理，不搜 `PATH`（与 `which` / `where` 同语义）。
 * @param {{
 *   platform: NodeJS.Platform,
 *   env: Record<string, string | undefined>,
 *   fs?: FindDeps,
 * }} ctx
 * @returns {string | null}
 */
export function findExecutable(name, { platform, env, fs }) {
  if (typeof name !== 'string' || name === '') return null;
  const f = fs ?? realFindDeps(platform);

  const isPath = /[/\\]/.test(name);

  if (platform === 'win32') {
    // ★ Windows：按 PATHEXT 逐个试，只看**存在性**（X_OK 在这边没有意义）
    const exts = splitPathext(getEnvVar(env, 'PATHEXT', platform));
    // 名字已经带扩展名（`wt.exe`）时不再追加——否则会去试 `wt.exe.EXE` 这种荒唐组合。
    // 注意这里**不把裸名放进候选**：见文件头"Windows 上不带扩展名的文件不算可执行文件"。
    const hasExt = exts.some((e) => name.toUpperCase().endsWith(e));
    const names = hasExt ? [name] : exts.map((e) => name + e);
    // ★ 命中后统一走这里：把构造名换成磁盘上的真实拼写（见 realFindDeps 里 realName 的注释）
    const win = (p) => f.realName(p);

    if (isPath) {
      for (const n of names) if (f.isFile(n)) return win(n);
      return null;
    }

    for (const dir of splitPath(getEnvVar(env, 'PATH', platform), platform)) {
      for (const n of names) {
        const full = f.join(dir, n);
        if (f.isFile(full)) return win(full);
      }
    }
    return null;
  }

  // POSIX：原样，按**可执行位**判定
  if (isPath) return f.isExecutable(name) ? name : null;

  for (const dir of splitPath(getEnvVar(env, 'PATH', platform), platform)) {
    const full = f.join(dir, name);
    if (f.isExecutable(full)) return full;
  }
  return null;
}
