// @ts-check
/**
 * 命令行里那个"路径参数"该怎么落到磁盘上。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么需要它，以及它**不**做什么
 *
 * §7.3 铁律 4 说得很死：**写用户的字面路径**，不许 `resolve()` / `realpath`。
 * 理由是自洽性——Codex 那边比的是 `process.cwd()` 的字面串，cxt 擅自归一化
 * 就会让"写进去的"和"Codex 看到的"变成两个字符串。
 *
 * 但**相对路径**是另一回事。`cxt bind .` 存进去一个 `.` 的话，它
 * **永远匹配不上任何 cwd**——这正是本项目最恨的那种**静默失效**。
 * 所以这里只做两件事，且**两件都会在输出里说出来**：
 *
 * 1. 展开开头的 `~`（配置/命令行里写 `~/work` 是常见写法）
 * 2. 相对路径按**当前工作目录**补全
 *
 * ❌ 不折叠大小写、❌ 不换分隔符、❌ 不 `realpath`、❌ 不碰 8.3 短名。
 * 那些是**匹配时**的事（`core/bindings.js` 的 `normalizeForCompare`），
 * 不是**写入时**的事。
 * ─────────────────────────────────────────────────────────────
 */

import { posix, win32 } from 'node:path';

import { expandTilde } from '../core/paths.js';

/**
 * @param {string} raw 用户敲的路径
 * @param {import('./types.js').Ctx} ctx
 * @returns {{ path: string, from: string | null }}
 *   `path` = 要写进配置的串；`from` = 被改写前的原样（没改写则 `null`，供输出里说明）
 */
export function resolveUserPath(raw, ctx) {
  const p = String(raw ?? '');
  if (p === '') return { path: p, from: null };

  const expanded = expandTilde(p, ctx.home, ctx.platform);
  const { isAbsolute, join } = ctx.platform === 'win32' ? win32 : posix;

  const out = isAbsolute(expanded) ? expanded : join(ctx.cwd, expanded);
  return { path: out, from: out === p ? null : p };
}
