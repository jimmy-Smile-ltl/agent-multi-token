// @ts-check
/**
 * 「这台机器上有哪些 transcript，各自属于哪个 token」——**唯一的一处定义**。
 *
 * ─────────────────────────────────────────────────────────────
 * 两个命令都要回答这个问题，而它们的答案必须**逐字一样**：
 *
 * | 命令 | 拿它干什么 |
 * |---|---|
 * | `cmt usage` | 读每份 transcript 的 token 数，汇总花费 |
 * | `cmt pool sync` | 把同一个数字写进池里的 `calls / in / out` |
 *
 * ★ 一旦各写一份，"池里显示的用量"与"`cmt usage` 显示的用量"迟早对不上——
 * 而那种不一致没有任何报错，只有人盯着两张表才会发现。
 * 所以目录怎么走（`profiles/<token>/projects` + 未托管的 `~/.claude/projects`）、
 * 递归多深、`.jsonl` 怎么认，全部挪到这里。
 *
 * ★ **只读**：这个模块只列文件名，不打开任何一个。解析是调用方的事。
 * ─────────────────────────────────────────────────────────────
 */
import nodeFs from 'node:fs';
import { join } from 'node:path';

import { profileDir, profilesDir } from '../core/paths.js';

/**
 * 托管之前（或直接跑 `claude` 时）transcript 落在 `~/.claude/projects`。
 *
 * ★ 它是个**伪 token 名**，只用于展示；真正的 token 名全是文件名，不会叫这个。
 */
export const LEGACY_TOKEN = '（未托管）';

/**
 * 递归找 `.jsonl`。
 *
 * ★ **必须递归**：subagent transcript 在 `<slug>/<session-uuid>/subagents/` 下面，
 *   深度 4。只扫一层会把它们整批漏掉（本机 90 份里有 52 份是 subagent 的）。
 *   深度上限只是防御——真出现环状目录别把进程跑死。
 *
 * @param {string} dir
 * @param {string[]} [out]
 * @param {number} [depth]
 * @returns {string[]}
 */
export function jsonlFiles(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  /** @type {import('node:fs').Dirent[]} */
  let ents;
  try {
    ents = nodeFs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在是常态（还没建过 token）
  }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) jsonlFiles(p, out, depth + 1);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

/**
 * 有哪些"token"名下有待统计的 transcript。
 *
 * 顺序即展示顺序：先按 profile 名（`_default` 会排在 `_` 之后、字母之前），
 * 未托管的垫底。
 *
 * ⚠️ **profile 目录只要存在就会被列出来**，哪怕里面一份 transcript 都没有
 * （`files` 是空数组）。调用方自己决定要不要跳过——`usage` 会把它显示成 0，
 * 而池的同步只关心有数字的那些。
 *
 * @param {string} home
 * @returns {{ token: string, files: string[] }[]}
 */
export function discoverSources(home) {
  /** @type {{ token: string, files: string[] }[]} */
  const out = [];
  /** @type {string[]} */
  let names = [];
  try {
    names = nodeFs.readdirSync(profilesDir(home), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch { /* 没有 profiles 目录：只用未托管那份 */ }

  for (const name of names) {
    out.push({ token: name, files: jsonlFiles(join(profileDir(home, name), 'projects')) });
  }
  out.push({ token: LEGACY_TOKEN, files: jsonlFiles(join(home, '.claude', 'projects')) });
  return out;
}
