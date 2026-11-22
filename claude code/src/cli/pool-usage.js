// @ts-check
/**
 * 池的**记账**：从 transcript 重算每个 token / 每个模型的用量。
 *
 * ─────────────────────────────────────────────────────────────
 * | 谁调它 | 什么时候 |
 * |---|---|
 * | `cmt pool sync` | 命令行重算一次 |
 * | 网页控制台的「重算用量」 | 按钮点一次 |
 * | `autoSyncUsage()` | `pool list` / 面板 / 控制台**启动时**，按 TTL 顺手重算 |
 *
 * ★ **只此一处**。两处各写一份的话，"页面上说花了 3 块、命令行说 5 块"这种
 *   不一致没有任何报错，只有人把两张表摆在一起才会发现。
 *
 * ★ 目录发现与解析用的是 `usage-sources.js` + `core/usage.js`——与 `cmt usage`
 *   同一份（那个模块的文件头写明了理由，这里不重复）。
 *
 * ★ **按模型分开记**是花费能算出来的前提：一把 key 会同时跑好几个模型，
 *   只有一个总数的话，价格根本没处落。聚合的 `in` / `out` / `calls` 照旧写，
 *   它们与 `models` 是"总数"和"明细"的关系，不是两份真相。
 *
 * ## 增量：按 `size + mtimeMs` 复用上一次的解析结果
 *
 * transcript 是**追加写**的，池里又可能挂着十几个 profile 的几十份 jsonl
 * （本机实测：`~/.claude/projects` 就有 813 MB / 67 份）。每开一次面板
 * 就把它们整份读一遍、再逐行解析，纯属白烧 IO —— 绝大多数文件**一个字节都没变**。
 *
 * 所以这里接了一份缓存（`poolUsageCachePath()`，**与 `cmt usage` 那份是两个文件**，
 * 理由是那个函数上的注释）。命中判据是 `stat` 的 `size + mtimeMs`：
 * `stat` 比读整份便宜两个数量级，而追加写必然同时改动这两样。
 *
 * ★ 缓存只存 `{calls, models}`，**不存 `in` / `out`**：那两项是 `models` 的求和，
 *   存第二份就是给了它们一个可以漂移的机会。求和放在合并那一步做，
 *   §2.13 九 9.1 那条"聚合 = 明细之和"于是**由构造保证**，而不是靠记得维护。
 * ★ 缓存坏了 / 权限不够 / 磁盘满 —— **一律当作没有缓存**，绝不因此让记账失败。
 * ─────────────────────────────────────────────────────────────
 */
import nodeFs from 'node:fs';

import { poolUsageCachePath, rootDir } from '../core/paths.js';
import { poolSettings, usageStale } from '../core/pool.js';
import { claudeFromLines } from '../core/usage.js';
import { loadConfig } from '../core/store.js';
import { ensureEntry, loadPool, savePool } from './pool-store.js';
import { discoverSources } from './usage-sources.js';

/**
 * 模型 id 为空时的落点。
 *
 * ★ **不能丢**：丢掉的用量会从花费里**静默消失**（总额里没有它，明细里也没有它，
 *   于是"没配价格"那个计数也不会为它加分）。落成这个名字，它就老老实实算作
 *   "有量、无价"，与前端的 `—` 一致。
 */
const UNKNOWN_MODEL = '（未知模型）';

/** 缓存格式版本。形状一变就加一，旧缓存自动作废（它本来就是可丢弃的）。 */
const CACHE_VERSION = 1;

/**
 * @typedef {object} ModelTotals
 * @property {number} input
 * @property {number} cacheRead
 * @property {number} cacheWrite
 * @property {number} output
 */

/**
 * @typedef {object} TokenTotals
 * @property {number} calls   真正算进账的消息条数（= `stats.messages`）
 * @property {number} in      输入侧合计（input + cacheRead + cacheWrite）
 * @property {number} out     输出侧合计
 * @property {Record<string, ModelTotals>} models
 */

/**
 * 一份文件的解析结果。**这就是缓存里存的东西**。
 * @typedef {object} FileRow
 * @property {number} size
 * @property {number} mtimeMs
 * @property {number} calls
 * @property {Record<string, ModelTotals>} models
 */

/** @returns {{ version: number, files: Record<string, FileRow> }} */
function emptyCache() {
  return { version: CACHE_VERSION, files: {} };
}

/**
 * 把缓存里的一行收成可信的形状。**认不出就返回 `null`**（当成没缓存）。
 *
 * ★ 宁可整行作废也不要"能认多少认多少"：少算一半用量与算错一半用量，
 *   在账本上一样是错，而前者至少会退回到**重新解析**这条正确的路。
 * @param {unknown} raw
 * @returns {FileRow | null}
 */
function sanitizeRow(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const size = Number(r.size);
  const mtimeMs = Number(r.mtimeMs);
  const calls = Number(r.calls);
  if (!Number.isFinite(size) || !Number.isFinite(mtimeMs)) return null;
  if (!Number.isFinite(calls) || calls < 0) return null;

  if (r.models === null || typeof r.models !== 'object' || Array.isArray(r.models)) return null;
  /** @type {Record<string, ModelTotals>} */
  const models = {};
  for (const [id, value] of Object.entries(/** @type {Record<string, unknown>} */ (r.models))) {
    if (id === '') return null;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const v = /** @type {Record<string, unknown>} */ (value);
    const row = {
      input: Number(v.input),
      cacheRead: Number(v.cacheRead),
      cacheWrite: Number(v.cacheWrite),
      output: Number(v.output),
    };
    if (![row.input, row.cacheRead, row.cacheWrite, row.output].every(
      (n) => Number.isFinite(n) && n >= 0,
    )) return null;
    models[id] = row;
  }
  return { size, mtimeMs, calls, models };
}

/**
 * 读缓存。**永不抛错**——坏 JSON、坏形状、文件不在，一律回空缓存。
 * @param {string} home
 * @returns {{ version: number, files: Record<string, FileRow> }}
 */
function loadCache(home) {
  try {
    const raw = JSON.parse(nodeFs.readFileSync(poolUsageCachePath(home), 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyCache();
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (o.version !== CACHE_VERSION) return emptyCache();
    if (o.files === null || typeof o.files !== 'object' || Array.isArray(o.files)) {
      return emptyCache();
    }
    /** @type {Record<string, FileRow>} */
    const files = {};
    for (const [file, hit] of Object.entries(/** @type {Record<string, unknown>} */ (o.files))) {
      const row = sanitizeRow(hit);
      if (row !== null) files[file] = row;
    }
    return { version: CACHE_VERSION, files };
  } catch {
    return emptyCache(); // 坏了就当没有（这份缓存本来就是可丢弃的）
  }
}

/**
 * 写缓存。**失败只吞掉**——磁盘满 / 只读盘 / 目录建不出来，都不该让这次记账失败。
 * @param {string} home
 * @param {{ version: number, files: Record<string, FileRow> }} cache
 */
function saveCache(home, cache) {
  try {
    nodeFs.mkdirSync(rootDir(home), { recursive: true });
    nodeFs.writeFileSync(poolUsageCachePath(home), JSON.stringify(cache), 'utf8');
  } catch {
    /* 下次重算就是了 */
  }
}

/**
 * 读一份 transcript，收成 `FileRow`。读不了 → `null`（跳过它，不让整次同步失败）。
 * @param {string} file
 * @returns {FileRow | null}
 */
function readRow(file) {
  /** @type {string} */
  let text;
  /** @type {import('node:fs').Stats} */
  let stat;
  try {
    stat = nodeFs.statSync(file);
    text = nodeFs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const { entries, stats } = claudeFromLines(text.split(/\r?\n/));
  /** @type {Record<string, ModelTotals>} */
  const models = {};
  for (const e of entries) {
    const id = e.model || UNKNOWN_MODEL;
    const row = models[id]
      ?? (models[id] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    row.input += e.tokens.input;
    row.cacheRead += e.tokens.cacheRead;
    row.cacheWrite += e.tokens.cacheWrite;
    row.output += e.tokens.output;
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs, calls: stats.messages, models };
}

/**
 * 把一份文件的汇总并进 token 级合计。
 * @param {TokenTotals} t
 * @param {FileRow} row
 */
function mergeRow(t, row) {
  t.calls += row.calls;
  for (const [id, r] of Object.entries(row.models)) {
    const dst = t.models[id]
      ?? (t.models[id] = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    dst.input += r.input;
    dst.cacheRead += r.cacheRead;
    dst.cacheWrite += r.cacheWrite;
    dst.output += r.output;
  }
}

/**
 * 重算并**落盘**。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {ReturnType<typeof import('./pool-store.js').loadPool>['pool']} pool
 *        已经由 `loadPool()` 读出来的池（它已经滤掉了孤立条目）
 * @param {Date} [now]
 * @param {{ force?: boolean }} [opts] `force: true` = 无视缓存，全部重读
 * @returns {{ filesRead: number, filesCached: number, names: string[], totals: Record<string, TokenTotals> }}
 */
export function syncPoolUsage(ctx, pool, now = new Date(), opts = {}) {
  const force = opts.force === true;
  const names = Object.keys(pool.entries);
  const wanted = new Set(names);

  /** @type {Record<string, TokenTotals>} */
  const totals = {};
  for (const name of names) totals[name] = { calls: 0, in: 0, out: 0, models: {} };

  const cache = force ? emptyCache() : loadCache(ctx.home);
  /** @type {Record<string, FileRow>} 这一轮真正见过的文件——缓存只留这些 */
  const nextFiles = {};
  let filesRead = 0;
  let filesCached = 0;

  for (const src of discoverSources(ctx.home)) {
    if (!wanted.has(src.token)) continue;
    const t = totals[src.token];

    for (const file of src.files) {
      const hit = force ? null : cache.files[file];
      /** @type {FileRow | null} */
      let row = null;

      if (hit !== undefined) {
        // 命中判据只有 `size + mtimeMs`：追加写必然同时改动这两样，
        // 而 `stat` 比读整份便宜两个数量级。
        try {
          const stat = nodeFs.statSync(file);
          if (stat.size === hit.size && stat.mtimeMs === hit.mtimeMs) row = hit;
        } catch {
          row = null; // 文件没了 / 读不了，就当没命中
        }
      }

      if (row !== null) {
        filesCached += 1;
      } else {
        row = readRow(file);
        if (row === null) continue; // 读不了就跳过：一份坏文件不该让整次同步失败
        filesRead += 1;
      }

      nextFiles[file] = row;
      mergeRow(t, row);
    }
  }

  // ★ 缓存**只留这一轮见过的文件**：token 删了、profile 清了、历史被 `--purge` 带走了，
  //   旧条目就该跟着消失。不清理的话这份缓存会长成一张永远不缩小的死账。
  const pruned = Object.keys(cache.files).filter((file) => !(file in nextFiles)).length;
  if (filesRead > 0 || pruned > 0) {
    saveCache(ctx.home, { version: CACHE_VERSION, files: nextFiles });
  }

  // ★ 时间戳取一次、整批共用：同一次重算算出来的数，就该有同一个时刻。
  const stamp = now.toISOString();

  for (const name of names) {
    const t = totals[name];

    // 聚合 = 明细之和（§2.13 九 9.1 的第一条不变式）。全零的模型行不留：
    // `normalizeModelUsage()` 读回时也会把它丢掉，留着只是让文件随模型清单一起长胖。
    let inSum = 0;
    let outSum = 0;
    for (const [id, r] of Object.entries(t.models)) {
      if (r.input + r.cacheRead + r.cacheWrite + r.output === 0) {
        delete t.models[id];
        continue;
      }
      inSum += r.input + r.cacheRead + r.cacheWrite;
      outSum += r.output;
    }
    t.in = inSum;
    t.out = outSum;

    const entry = ensureEntry(pool, name);
    entry.calls = t.calls;
    entry.in = t.in;
    entry.out = t.out;
    entry.models = t.models;
    entry.usageAt = stamp;
  }

  savePool(ctx, pool, now);
  return { filesRead, filesCached, names, totals };
}

/**
 * **启动时顺手重算**：`pool list` / 面板 / 控制台在"打开"的那一刻各调一次。
 *
 * ★ 这就是"用量不用手动记"的全部实现——用户什么都不用做，打开就能看见新的数。
 * ★★ **一次都不许抛**：它是挂在别人的启动路径上的旁路。一条坏记录、一个不可写的目录，
 *   正确的结局是"这次的用量是旧的"，**不是"面板打不开"**。调用方因此也不需要 try。
 * ★ 池是空的、或者全部条目都还在新鲜期内 ⇒ 返回 `null`，**一个字节都不写**。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {Date} [now]
 * @returns {{ filesRead: number, filesCached: number, names: string[] } | null}
 */
export function autoSyncUsage(ctx, now = new Date()) {
  try {
    const { pool } = loadPool(ctx);
    if (Object.keys(pool.entries).length === 0) return null;

    if (!usageStale(pool.entries, now, poolSettingsOf(ctx))) return null;

    const r = syncPoolUsage(ctx, pool, now);
    return { filesRead: r.filesRead, filesCached: r.filesCached, names: r.names };
  } catch {
    return null;
  }
}

/**
 * 读 `config.defaults.pool` 的运行期形状。**读不出来就按默认**——
 * 自动重算是旁路，不该因为配置文件有毛病就整条不跑（真正的报错归命令自己）。
 * @param {import('./types.js').Ctx} ctx
 * @returns {{ auto: boolean, policy: string, cacheSeconds: number, usageSeconds: number }}
 */
function poolSettingsOf(ctx) {
  try {
    return poolSettings(loadConfig({ home: ctx.home }).config.defaults?.pool);
  } catch {
    return poolSettings(null);
  }
}
