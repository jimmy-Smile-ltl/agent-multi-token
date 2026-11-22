// @ts-check
/**
 * 可执行文件定位（§2.9 四）——**纯 JS，绝不 spawn `which` / `where`**。
 *
 * 为什么不 spawn：`which` 在三大平台的行为各不相同（有的读 shell 别名、有的读
 * 登录 shell 的 PATH），而且它本身也可能不在 PATH 里。自己按规则找，行为才是确定的。
 *
 * ## 三平台规则（§6.3：规则本身在任意宿主机上都能测）
 *
 * | 平台 | PATH 分隔符 | 候选 | 命中判据 |
 * |------|------------|------|---------|
 * | POSIX | `:` | `dir/name` | `fs.accessSync(X_OK)` |
 * | Windows | `;` | `dir\name` + `PATHEXT` 各扩展名 | **只看存在性**（`X_OK` 在 Windows 上无意义） |
 *
 * `platform` / `env` / 探针**全部注入**，所以"Windows 规则"在 Linux CI 上照样能跑。
 *
 * ⚠️ POSIX 的 PATH 里**空段**按规范表示"当前目录"。这里**故意跳过**——
 * 在 cwd 里找可执行文件是经典的提权面（用户 cd 到恶意仓库再敲命令），
 * 而"PATH 里有空段"在实践中几乎总是配置事故。
 */
import { accessSync, constants } from 'node:fs';

import { joinFor } from '../core/paths.js';

/** Windows 上没配 `PATHEXT` 时的兜底（cmd 的默认值） */
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * 路径里有没有分隔符 → 说明用户给的是路径而不是"要在 PATH 里找的名字"。
 * @param {string} name
 * @param {boolean} isWin
 */
function looksLikePath(name, isWin) {
  return name.includes('/') || (isWin && name.includes('\\'));
}

/**
 * **纯函数**：按优先级列出所有候选绝对路径，不碰 fs。
 *
 * 顺序即优先级——`findExecutable()` 取第一个命中的，所以"PATH 里靠前的目录赢"。
 * @param {string} name
 * @param {{ platform: NodeJS.Platform, env: Record<string, string | undefined>, pathExt?: string }} opts
 * @returns {string[]}
 */
export function executableCandidates(name, { platform, env, pathExt }) {
  const isWin = platform === 'win32';
  const j = joinFor(platform);

  // 已经是路径（`./node`、`C:\x\node.exe`）→ 就查它，别去 PATH 里翻
  if (looksLikePath(name, isWin)) return [name];

  const dirs = String(env.PATH ?? '')
    .split(isWin ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1')) // Windows 的 PATH 里常有整段带引号
    .filter((d) => d !== ''); // 空段 = 当前目录，故意跳过（见文件头）

  /** @type {string[]} */
  const out = [];

  if (isWin) {
    const hasExt = /\.[^\\/]+$/.test(name);
    const exts = String(pathExt ?? env.PATHEXT ?? DEFAULT_PATHEXT)
      .split(';')
      .map((e) => e.trim())
      .filter((e) => e !== '');
    for (const d of dirs) {
      if (hasExt) {
        // 用户已经写了扩展名（claude.exe）→ 别再加一遍变成 claude.exe.exe
        out.push(j(d, name));
      } else {
        for (const e of exts) out.push(j(d, name + e.toLowerCase()));
      }
    }
  } else {
    for (const d of dirs) out.push(j(d, name));
  }

  return out;
}

/**
 * 真实探针：这个路径能不能执行。
 *
 * - POSIX：`X_OK`（有执行位）
 * - Windows：只看存在性——`fs.accessSync` 的 `X_OK` 在 Windows 上等价于 `F_OK`，
 *   写 `X_OK` 只会让人误以为检查了权限
 *
 * @param {NodeJS.Platform} platform
 * @returns {(p: string) => boolean}
 */
export function realProbe(platform) {
  const isWin = platform === 'win32';
  return (p) => {
    try {
      accessSync(p, isWin ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * 按 PATH 找一个可执行文件，返回第一个命中的**绝对路径**（找不到返回 `null`）。
 *
 * @param {string} name
 * @param {{
 *   platform: NodeJS.Platform,
 *   env: Record<string, string | undefined>,
 *   pathExt?: string,
 *   probe?: (p: string) => boolean,
 * }} opts `probe` 注入是为了让三平台规则都能在任意宿主机上测（§6.3）
 * @returns {string | null}
 */
export function findExecutable(name, { platform, env, pathExt, probe }) {
  const check = probe ?? realProbe(platform);
  for (const c of executableCandidates(name, { platform, env, pathExt })) {
    if (check(c)) return c;
  }
  return null;
}
