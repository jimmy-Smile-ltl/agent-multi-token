// @ts-check
/**
 * 定位 codex 可执行文件 + 处理 Windows 的 `.cmd` 包装（§2.12）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 一、四级定位顺序（§2.12）
 *
 * | 顺序 | 来源 |
 * |------|------|
 * | 1 | `defaults.codexBin`（显式配置） |
 * | 2 | `findExecutable('codex')`（§2.11 四，纯 JS，不 spawn `which`/`where`） |
 * | 3 | 常见安装路径（`core/paths.js` 的 `codexFallbackPaths`） |
 * | 4 | 都找不到 → 退出码 2，提示 `npm i -g @openai/codex` |
 *
 * 命中 2 或 3 时把**绝对路径写回 `defaults.codexBin`**，下次免探测。
 *
 * ## 二、为什么 Windows 上绕不开 `cmd.exe`
 *
 * npm 在 Windows 上装出来的是 `codex.cmd`（**没有 `.exe`**——本机实测
 * `%APPDATA%\npm\` 下只有 `codex` / `codex.cmd` / `codex.ps1`）。
 * 而 Node 从 18.20 / 20.12 起**拒绝直接 spawn `.cmd`**（CVE-2024-27980），
 * 真机实测直接 spawn 得到 `EINVAL`。所以这条路必须走
 * `cmd.exe /d /s /c "<整条命令串>"` + `windowsVerbatimArguments: true`。
 *
 * ## 三、★ 绕不开的代价：这条路上**参数会经过 cmd 的解析**
 *
 * §2.12 把"直接拉起"定为首选，图的就是"argv 一路不被 shell 解析"。
 * 但 `codex.cmd` 这条路**没有这个红利**——真机实测（`scripts/_probe-shim-args.mjs`，
 * 对照 `spawn(node, [js, ...args])` 的基准真相）：
 *
 * | 参数 | 直接 spawn | 经 cmd shim（不转义） | 处置 |
 * |------|-----------|---------------------|------|
 * | `hello world` | ✅ | ✅ | — |
 * | `a & b` / `a ^ b` / `100%` | ✅ | ✅ **（引号内是安全的）** | — |
 * | `D:\工作\我的 项目` | ✅ | ✅ **中文没问题** | — |
 * | `say "hi"` | ✅ | ❌ → `say hi` | `"` → `""` 转义（实测 ✅） |
 * | `D:\proj\` | ✅ | ❌ → `D:\proj"` | 尾随 `\` 翻倍（`CommandLineToArgvW` 规则） |
 * | `%PATH%` | ✅ | ❌ **被展开成真 PATH** | **无解**，只能检测 + 报警 |
 *
 * `%` 那一条是**硬限制**：实测 `%%PATH%%` 与 `^%PATH^%` 两种候选转义都无效
 * （cmd 在 `/c` 命令行这一层不认这两种写法）。所以 `quoteForCmdShim()`
 * 对它**不假装能修**，而是把问题报到 `warnings` 里——静默传一个被展开的
 * 路径比直接报错更贵。
 * ─────────────────────────────────────────────────────────────
 */

import nodeFs from 'node:fs';
import { win32 as win32Path } from 'node:path';

import { EnvError } from '../core/errors.js';
import { codexFallbackPaths, configPath } from '../core/paths.js';
import { readConfig, writeConfig } from '../core/store.js';
import { findExecutable } from '../platform/index.js';

/** 需要经 `cmd.exe` 才能 spawn 的扩展名（Node 拒绝直接 spawn 它们） */
const SHIM_EXTENSIONS = Object.freeze(['.cmd', '.bat']);

/**
 * 这个可执行文件是不是需要 `cmd.exe` 包装？
 *
 * ⚠️ **只在 Windows 上为真**：POSIX 上一个叫 `foo.cmd` 的文件就是个普通文件，
 * 直接 spawn 没问题。别在 Linux 上给它套 `cmd.exe`。
 *
 * @param {string} binPath
 * @param {NodeJS.Platform} platform
 */
export function needsCmdShim(binPath, platform) {
  if (platform !== 'win32') return false;
  const lower = String(binPath).toLowerCase();
  return SHIM_EXTENSIONS.some((e) => lower.endsWith(e));
}

/** `%NAME%` 形态的变量引用——`100%` / `50% off 20%` 不算，`%PATH%` 算 */
const PCT_VAR = /%[A-Za-z_][A-Za-z0-9_]*%/;

/**
 * 把一个参数转义成**可以放进 `cmd /c` 那一整条命令串**的形态（含两侧引号）。
 *
 * 逐字符扫，不用链式 `replace`——两条规则会互相踩：
 * 先把 `"` 换成 `""`，再处理"引号前的反斜杠"，就会把刚写进去的那两个引号
 * 又当成需要处理的目标。一趟扫完最省心。
 *
 * 两条规则都来自真机实测，见文件头那张表。
 *
 * @param {string} s
 * @returns {string}
 */
export function quoteForCmdShim(s) {
  const v = String(s);
  let out = '';
  let bs = 0; // 攒着的反斜杠——只有遇到引号/结尾时才知道要不要翻倍

  for (const ch of v) {
    if (ch === '\\') { bs += 1; continue; }

    if (ch === '"') {
      // ★ 引号前的反斜杠要翻倍：`CommandLineToArgvW` 把 `\"` 读成"转义引号"，
      //   于是 `"D:\proj\"` 的闭引号被吃掉、参数尾多出一个 `"`（真机实测 ❌）。
      //   规则：引号前 N 个反斜杠 → 输出 2N 个 → 子进程拿回 N 个。
      out += '\\'.repeat(bs * 2);
      // ★ 引号本身写成 `""`（cmd 在引号内的引号转义，真机实测 ✅）
      out += '""';
      bs = 0;
      continue;
    }

    out += '\\'.repeat(bs) + ch;
    bs = 0;
  }

  // ★ 尾部反斜杠：它后面紧跟的是我们的**闭引号**，同样要翻倍。
  //   不处理的话 `D:\proj\` 会变成 `D:\proj"`（真机实测 ❌）。
  out += '\\'.repeat(bs * 2);

  return `"${out}"`;
}

/**
 * 拼出经 `cmd.exe` 跑一个 `.cmd` 的完整 argv（§7.14④）。
 *
 * ★ `/d /s /c` 三个开关都不是装饰，真机实测（去掉 `/s` 则**全部用例都失败**）：
 * `/s` 的语义是"剥掉最外层引号后原样传递"，正是我们需要的；
 * 少了它，cmd 会把 `"<路径>" "<参数>"` 当成一个整体去解析，连朴素用例都跑不起来。
 *
 * @param {string} binPath
 * @param {string[]} args
 * @returns {{ args: string[], verbatimArgs: true, warnings: string[] }}
 */
export function cmdShimArgv(binPath, args) {
  /** @type {string[]} */
  const warnings = [];

  for (const a of args) {
    if (PCT_VAR.test(a)) {
      warnings.push(
        `参数里有 cmd 的变量引用语法，经 codex.cmd 会被**展开**且无法转义：${JSON.stringify(a)}`
        + '——把该目录改名，或改用非 .cmd 的 codex 安装（见 README 的"Windows 上的 codex 定位"）',
      );
    }
  }

  const line = [quoteForCmdShim(binPath), ...args.map(quoteForCmdShim)].join(' ');
  return {
    // ★ 整条再包一层引号：`/s` 剥掉的正是这一层
    args: ['/d', '/s', '/c', `"${line}"`],
    verbatimArgs: true,
    warnings,
  };
}

// ───────────────────────────── 四级定位 ─────────────────────────────

/**
 * ★ **纯决策**版的四级定位（可在任何机器上单测）。
 *
 * @param {object} input
 * @param {string | null | undefined} input.configured  `defaults.codexBin`
 * @param {NodeJS.Platform} input.platform
 * @param {string} input.home
 * @param {object} input.deps
 * @param {(name: string) => string | null} input.deps.findExecutable
 * @param {(p: string) => boolean} input.deps.isFile
 * @returns {{ path: string, level: 1 | 2 | 3, tried: string[] } | null}
 */
export function pickCodexBin({ configured, platform, home, deps }) {
  /** @type {string[]} */
  const tried = [];

  // 1. 显式配置。**配了但不存在 = 报错，不静默往下走**——
  //    静默回落会让用户以为"我配的那个在用"，实际用的是别的版本。
  if (typeof configured === 'string' && configured !== '') {
    if (deps.isFile(configured)) return { path: configured, level: 1, tried };
    throw new EnvError(`defaults.codexBin 指向的文件不存在：${configured}`, {
      hint: `改掉它（编辑 ${configPath(home)} 里的 defaults.codexBin），或删掉这一项让它自动探测`,
    });
  }

  // 2. PATH
  const onPath = deps.findExecutable('codex');
  if (onPath !== null) return { path: onPath, level: 2, tried };
  tried.push('PATH 里没找到 codex');

  // 3. 常见安装路径
  for (const p of codexFallbackPaths(home, platform)) {
    if (deps.isFile(p)) return { path: p, level: 3, tried };
    tried.push(`${p}：不存在`);
  }

  return null;
}

/**
 * 宿主版的四级定位——**cli 层用这个**。
 *
 * 命中 2 / 3 时把绝对路径写回 `defaults.codexBin`（§2.12）。
 * 写回失败**不算错**（只读文件系统、磁盘满…）：下次再探一遍就是了，
 * 但要说出来，别让用户以为写成功了。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {{ writeBack?: boolean }} [opts] `writeBack: false` 用于 `doctor` 这类只读命令
 * @returns {{ path: string, level: 1 | 2 | 3, shim: boolean, writeBackError: string | null }}
 */
export function locateCodexBin(ctx, opts = {}) {
  const config = readConfig(ctx.home);
  const found = pickCodexBin({
    configured: config.defaults?.codexBin,
    platform: ctx.platform,
    home: ctx.home,
    deps: {
      findExecutable: (name) => findExecutable(name, { platform: ctx.platform, env: ctx.env }),
      isFile: (p) => isFileOnDisk(p),
    },
  });

  if (found === null) {
    throw new EnvError('找不到 codex 可执行文件', {
      hint: '装它：`npm i -g @openai/codex`；装完重跑；'
        + `装到了非标准位置就在 ${configPath(ctx.home)} 的 defaults.codexBin 里写绝对路径`,
    });
  }

  let writeBackError = null;
  if (found.level !== 1 && opts.writeBack !== false) {
    try {
      writeConfig(ctx.home, {
        ...config,
        defaults: { ...config.defaults, codexBin: found.path },
      });
    } catch (err) {
      writeBackError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    path: found.path,
    level: found.level,
    shim: needsCmdShim(found.path, ctx.platform),
    writeBackError,
  };
}

/**
 * "磁盘上真有这个文件吗"。
 *
 * ⚠️ 不能只用 `statSync().isFile()`：`WindowsApps` 下的 **App Execution Alias**
 * 会让它抛 `EACCES`、让 `existsSync` 返回 `false`（§7.14⑤）。
 * 这里要判断的是"用户显式配的 / npm 装的那个路径在不在"，
 * 而那些是真文件——但既然 §7.14⑤ 的坑已经踩过一次，就顺手把
 * 重解析点也算作"存在"（与 `find-executable.js` 的 `isFile` 同一条规则）。
 *
 * @param {string} p
 */
function isFileOnDisk(p) {
  try {
    return nodeFs.statSync(p).isFile();
  } catch {
    // Windows：跟随失败但它是重解析点 → 当成存在（见 §7.14⑤）
    if (process.platform !== 'win32') return false;
    try { return nodeFs.lstatSync(p).isSymbolicLink(); } catch { return false; }
  }
}

/**
 * `cxt doctor` 用：把探测过程摊开，**不抛错**。
 *
 * @param {import('./types.js').Ctx} ctx
 * @returns {{ ok: true, path: string, level: number, shim: boolean } | { ok: false, tried: string[], message: string }}
 */
export function detectCodexBin(ctx) {
  try {
    const r = locateCodexBin(ctx, { writeBack: false });
    return { ok: true, path: r.path, level: r.level, shim: r.shim };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tried = codexFallbackPaths(ctx.home, ctx.platform).map((p) => `${p}：${isFileOnDisk(p) ? '在' : '不在'}`);
    return { ok: false, tried, message };
  }
}

/** 供 `cxt doctor` 显示的常见路径清单（不探测，纯列举） */
export function codexSearchPaths(home, platform) {
  return codexFallbackPaths(home, platform);
}

/** 暴露给测试：Windows 上 `.cmd` 的扩展名表 */
export { SHIM_EXTENSIONS };

/** 暴露给测试：从 `cmd /c` 的 argv 里还原那条命令串 */
export function shimCommandLine(shimArgs) {
  return shimArgs[3];
}

/** 仅用于类型推断，别 import 它 */
export const __win32Path = win32Path;
