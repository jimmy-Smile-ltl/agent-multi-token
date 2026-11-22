// @ts-check
/**
 * 池的**读写**（I/O 那一半）——`core/pool.js` 是纯的，这里补上"盘上是谁"。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ `pool.json` 是可丢弃的**覆盖层**，所以这里的读写与 `config.json`
 *   不是同一种纪律：
 *
 * | | `config.json` | `pool.json` |
 * |---|---|---|
 * | 坏 JSON | **抛**（承重） | 退化成空池（可丢弃） |
 * | 未知键 | **抛** | 不认也不报错 |
 * | 读时会不会写盘 | 可能会迁移 | **绝不** |
 *
 * ★★ **孤立条目在读的时候丢掉**：`entries` 里有一个名字，而
 * `tokens/<name>.json` 已经删了——那不是错误，是"这个 token 被删过"。
 * 留着它会让 `pool list` 显示一个不存在的身份，更坏的是**哪天真有人
 * 新建一个同名 token，它会悄悄继承一份旧状态**。
 * 所以读的时候过滤，下一次写盘就真的没了。
 * ─────────────────────────────────────────────────────────────
 */
import { listTokenNames, readPool, writePool } from '../core/store.js';
import { STATUS, normalizeEntry } from '../core/pool.js';

/**
 * @typedef {object} LoadedPool
 * @property {ReturnType<typeof readPool>} pool  已经滤掉孤立条目的池
 * @property {string[]} names                    盘上真实存在的 token 名（已排序）
 * @property {number} dropped                    这次滤掉了几个孤立条目
 */

/**
 * 读池 + 盘上的 token 名，并滤掉孤立条目。
 *
 * ⚠️ **本函数不写盘**。孤立条目只是不在返回值里；真要清掉得调用 `savePool()`。
 * 之所以这样：读的职责就该只是读。`pool list` 今天确实会写盘，但那是它开局跑的
 * `autoSyncUsage()` 在写**用量**——与这里丢掉的孤立条目是两件事，别混。
 *
 * @param {import('./types.js').Ctx} ctx
 * @returns {LoadedPool}
 */
export function loadPool(ctx) {
  const names = listTokenNames(ctx);
  const known = new Set(names);
  const pool = readPool(ctx.home);

  let dropped = 0;
  for (const name of Object.keys(pool.entries)) {
    if (!known.has(name)) {
      delete pool.entries[name];
      dropped += 1;
    }
  }
  // `lastPick` 里指向已删 token 的记录同样没用——留着只会让 `-c`
  // 报一个"它不在了"的错，而真正该做的是忘掉它。
  for (const cwd of Object.keys(pool.lastPick)) {
    if (!known.has(pool.lastPick[cwd])) delete pool.lastPick[cwd];
  }

  return { pool, names, dropped };
}

/**
 * 落盘，并盖一个 `updatedAt`。
 *
 * ★ 时间**只在写的时候**取（读的时候不取）——读一次不该让文件的修改时间
 * "看起来刚有变化"。`pool list` 也会写盘，但那是 `autoSyncUsage()` 真的重算过了。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {ReturnType<typeof readPool>} pool
 * @param {Date} [now]
 */
export function savePool(ctx, pool, now = new Date()) {
  pool.updatedAt = now.toISOString();
  writePool(ctx.home, pool);
}

/**
 * 取一个条目；没有就**新建一个 `unknown` 的空条目**（就地写入 `pool.entries`）。
 *
 * ★ 建条目不等于"入池"——入池与否只看 `pool.json` 里有没有这个键，
 * 而这里就是那个键诞生的地方。调用方负责决定什么时候调它。
 *
 * @param {ReturnType<typeof readPool>} pool
 * @param {string} name
 * @returns {import('../core/pool.js').PoolEntry}
 */
export function ensureEntry(pool, name) {
  const existing = normalizeEntry(pool.entries[name]);
  if (existing !== null) {
    pool.entries[name] = existing;
    return existing;
  }
  const fresh = /** @type {import('../core/pool.js').PoolEntry} */ ({
    status: STATUS.UNKNOWN,
    detail: '',
    checkedAt: '',
    calls: 0,
    in: 0,
    out: 0,
    usageAt: '',
    models: {},
  });
  pool.entries[name] = fresh;
  return fresh;
}

/**
 * 把一次探测结果盖到条目上。**用量字段不动**——探测只回答"有没有钱"。
 *
 * @param {import('../core/pool.js').PoolEntry} entry
 * @param {{ status: string, detail: string }} probe
 * @param {Date} [now]
 */
export function applyProbe(entry, probe, now = new Date()) {
  entry.status = probe.status;
  entry.detail = probe.detail;
  entry.checkedAt = now.toISOString();
}
