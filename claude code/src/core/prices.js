// @ts-check
/**
 * 价格表与花费计算（§2.13）。
 *
 * 存的是 **USD / 百万 token**。理由：
 *   - provider 的公开价目表本来就是这么报的（"$3 / MTok"），用户抄进 `prices.json` 不用换算；
 *   - OpenRouter 的 `/models` 给的是**每 token** 的十进制字符串，在入口处 `× 1e6` 一次即可，
 *     全链路都是人能对着核对的量级。
 *
 * ★ 拿不到价格时**返回 `null`，不返回 0**。0 会渲染成"免费"，而真相是"不知道"——
 *   这两件事在账单上差得远。调用方负责把 `null` 显示成 `—`。
 *
 * 三级取值（优先级从高到低）：
 *   1. 用户手写的 `prices.json`（本文件的 `normalizePriceTable` / `priceFor`）——
 *      **显式配置永远压过自动采集**：网关的挂牌价与实际结算价常常不是一回事，
 *      用户既然动手写了，就不该被一次「拉取」默默盖掉
 *   2. 端点自报（OpenRouter 形态的 `pricing`，拉清单时顺手记进 `resources.json`）
 *   3. 都没有 ⇒ `null`
 */

/** 价格单位：一百万 token。 */
export const PRICE_UNIT = 1_000_000;

/**
 * 四个桶的单价（USD / 百万 token），**互不重叠**，与 `usage.js` 的 `Tokens` 一一对应。
 * @typedef {object} Price
 * @property {number} input
 * @property {number} output
 * @property {number} cacheRead
 * @property {number} cacheWrite
 */

/** @typedef {{ models: Record<string, Price>, problems: string[] }} PriceTable */

/**
 * 每 token 的价格 → 每百万 token 的价格。
 *
 * `× 1e6` 之后顺手抹掉浮点尾巴：`0.000003 * 1e6` 在 IEEE754 下未必正好是 3，
 * 而价格表是要给人看、给人抄的，多出个 `2.9999999999999996` 只会让人怀疑算错了。
 * @param {number} perToken
 */
function toPerMillion(perToken) {
  return Math.round(perToken * PRICE_UNIT * 1e6) / 1e6;
}

/**
 * 把一个 `models.<id>` 的值归一成 `Price`。
 *
 * 必须给 `input` 与 `output`；`cacheRead` / `cacheWrite` 缺省时**按输入价**算。
 * 这是保守假设（缓存通常比现算便宜，按输入价算是往高了估），
 * 且在这里写死比让用户对着 `—` 猜为什么算不出钱要好。想精确就显式写。
 * @param {unknown} raw
 * @returns {Price | null}
 */
export function normalizePriceEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (raw);

  const price = (/** @type {unknown} */ v) => {
    const n = typeof v === 'string' ? Number(v) : v;
    // 负数是 OpenRouter 表达"不按 token 计价"的方式，不是价格
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  };

  const input = price(o.input);
  const output = price(o.output);
  if (input === null || output === null) return null;

  return {
    input,
    output,
    cacheRead: price(o.cacheRead) ?? input,
    cacheWrite: price(o.cacheWrite) ?? input,
  };
}

/**
 * 归一整张价格表。
 *
 * 坏条目**不抛错**，收集到 `problems` 里让调用方提示——一张表里有一条写错，
 * 不该让整份用量报表打不开。
 *
 * @param {unknown} raw 解析后的 JSON（`{ models: {…} }`，也接受裸的 `{…}`）
 * @returns {PriceTable}
 */
export function normalizePriceTable(raw) {
  /** @type {PriceTable} */
  const out = { models: {}, problems: [] };
  if (!raw || typeof raw !== 'object') {
    out.problems.push('价格表不是对象');
    return out;
  }

  const o = /** @type {Record<string, unknown>} */ (raw);
  const src = o.models && typeof o.models === 'object' && !Array.isArray(o.models)
    ? /** @type {Record<string, unknown>} */ (o.models)
    : o;

  for (const [id, value] of Object.entries(src)) {
    if (id === 'version' || id === '$schema') continue;
    const p = normalizePriceEntry(value);
    if (p === null) {
      out.problems.push(`「${id}」缺 input/output，已跳过`);
      continue;
    }
    out.models[id] = p;
  }
  return out;
}

/**
 * 查一个模型的价：先**精确匹配**，再用 `*` 结尾的通配（取最长前缀）。
 *
 * 通配是有序的：`claude-sonnet-4-5*` 比 `claude-*` 先命中——
 * 否则写了一条通用兜底，专用那条就永远轮不上了。
 *
 * @param {PriceTable | Record<string, Price>} table
 * @param {string} modelId
 * @returns {Price | null}
 */
export function priceFor(table, modelId) {
  if (!modelId) return null;
  const models = /** @type {PriceTable} */ (table)?.models
    ?? /** @type {Record<string, Price>} */ (table);
  if (!models || typeof models !== 'object') return null;

  const exact = models[modelId];
  if (exact) return exact;

  /** @type {string | null} */
  let best = null;
  for (const key of Object.keys(models)) {
    if (!key.endsWith('*')) continue;
    const prefix = key.slice(0, -1);
    if (prefix === '' || !modelId.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.length - 1) best = key;
  }
  return best === null ? null : (models[best] ?? null);
}

/**
 * 算钱。`price` 为 `null` 时返回 `null`（**不是 0**，见文件头）。
 * @param {import('./usage.js').Tokens} tokens
 * @param {Price | null} price
 * @returns {number | null}
 */
export function costOf(tokens, price) {
  if (!price) return null;
  const micro =
    tokens.input * price.input +
    tokens.cacheRead * price.cacheRead +
    tokens.cacheWrite * price.cacheWrite +
    tokens.output * price.output;
  return micro / PRICE_UNIT;
}

/**
 * OpenRouter 形态的 `pricing` 字段 → `Price`。
 *
 * 形如 `{ prompt: "0.000003", completion: "0.000015", input_cache_read: "…" }`，
 * 单位是 **USD / token** 的十进制**字符串**（不是数字，别直接乘）。
 *
 * `prompt` / `completion` 缺任一 ⇒ 整条不算（半份价格比没有更危险：
 * 会让花费看起来比实际低）。缓存两项缺省时按输入价。
 *
 * @param {unknown} pricing
 * @returns {Price | null}
 */
export function priceFromEndpoint(pricing) {
  if (!pricing || typeof pricing !== 'object') return null;
  const p = /** @type {Record<string, unknown>} */ (pricing);

  const per = (/** @type {unknown} */ v) => {
    const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const prompt = per(p.prompt);
  const completion = per(p.completion);
  if (prompt === null || completion === null) return null;

  return {
    input: toPerMillion(prompt),
    output: toPerMillion(completion),
    cacheRead: toPerMillion(per(p.input_cache_read) ?? prompt),
    cacheWrite: toPerMillion(per(p.input_cache_write) ?? prompt),
  };
}
