// @ts-check
/**
 * 资源登记（§2.14 十一 的「模型下拉与资源表」）。
 *
 * ─────────────────────────────────────────────────────────────
 * 每个 token 的 `GET {baseUrl}/models` **拉到了什么**、从**哪个地址**拉的、
 * **什么时候**拉的，记在 `resources.json` 里。
 *
 * ★★ **它不是"缓存代替现拉"**：向导第 3 步仍然每次现拉（§2.14 六）。
 * 这份登记只做两件事——喂主屏的模型下拉、喂资源表。它带 `url` 与 `fetchedAt`，
 * 地址一变就被判成"旧的"（`stale`），用户随时能手动「拉取 / 全部拉取」。
 * 所以它不怕"什么时候失效"这个问题：**失效的判据是可见的、由人做主的**。
 *
 * ★★ **本文件是纯函数**（§4.2）：不读 fs、不读 `process.env`、不读 `process.platform`。
 * 读写落在 `core/store.js` 的 `readResources()` / `writeResources()`。
 *
 * ★ **读要宽容、永不抛错**：调用方是每次重绘都跑的 `buildPanelData()`，
 * 一份手改坏的 `resources.json` 只该让下拉少几项，不该让控制台打不开。
 * ─────────────────────────────────────────────────────────────
 */

import { normalizePriceEntry } from './prices.js';

/** `resources.json` 的版本（独立于 `config.json` / `projects.json` 的，别混） */
export const RESOURCES_VERSION = 1;

/**
 * 单个 token 最多记多少个模型 id。
 *
 * ★ 这是一个**防卫性上限**：一个坏响应（或者一个把整个目录当模型列表吐的网关）
 * 不该把下拉撑成几万项。截断而不是拒绝——前面那 500 个仍然有用。
 */
export const MAX_MODELS = 500;

/**
 * @typedef {object} ResourceEntry
 * @property {string} url       拉取时**实际用的**地址（`token.baseUrl ?? defaults.baseUrl`）
 * @property {string[]} models  服务端给的原序（§2.14 六：解析器只报告服务端说了什么）
 * @property {string} fetchedAt ISO 时间串（`''` = 老文件里没有）
 * @property {Record<string, import('./prices.js').Price>} [pricing]
 *   端点**顺路报**的价格（id → USD / 百万 token，§2.13）。**可选键**：
 *   绝大多数中转站不报价格，那种情况下这个键**整个不存在**（不是空对象）。
 */

/** @returns {{ version: number, tokens: Record<string, ResourceEntry> }} */
export function defaultResources() {
  return { version: RESOURCES_VERSION, tokens: {} };
}

/**
 * 把盘上的东西收成**一定可用**的形状。**永不抛错**。
 *
 * 宽容到什么程度：
 * - 整个文件不是对象 → 全默认
 * - `tokens` 不是对象 → 空表
 * - 某一条不是对象 / 不像记录 → **丢掉那一条**（其余照常）
 * - `models` 里的非字符串 / 空串 / 重复 → 丢掉；超过 `MAX_MODELS` → 截断
 * - `url` / `fetchedAt` 不是字符串 → 记成 `''`（保留这条记录：清单本身仍然有用）
 * - `pricing` 逐条过 `normalizePriceEntry()`，坏的丢掉；**一条都不剩就连键都不写**
 *
 * ★ **不校验 token 名、也不看 token 还在不在**：这一层只认识这份文件。
 * "指向已删 token 的条目怎么办"是渲染层的事（不显示、不自动删）。
 *
 * @param {unknown} raw
 * @returns {{ version: number, tokens: Record<string, ResourceEntry> }}
 */
export function normalizeResources(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultResources();
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);

  /** @type {Record<string, ResourceEntry>} */
  const tokens = {};
  const src = obj.tokens;
  if (src !== null && typeof src === 'object' && !Array.isArray(src)) {
    for (const [name, value] of Object.entries(/** @type {Record<string, unknown>} */ (src))) {
      if (name === '') continue;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const e = /** @type {Record<string, unknown>} */ (value);
      /** @type {ResourceEntry} */
      const entry = {
        url: typeof e.url === 'string' ? e.url : '',
        models: cleanModels(e.models),
        fetchedAt: typeof e.fetchedAt === 'string' ? e.fetchedAt : '',
      };
      const pricing = cleanPricing(e.pricing);
      if (Object.keys(pricing).length > 0) entry.pricing = pricing;
      tokens[name] = entry;
    }
  }

  return { version: RESOURCES_VERSION, tokens };
}

/**
 * 这个 token 记着的模型 id（没有 = `[]`）。
 *
 * ★ 返回**副本**：调用方拿去拼下拉、拼资源表，谁也别改到登记本身。
 *
 * @param {{ tokens?: Record<string, ResourceEntry> } | null | undefined} resources
 * @param {string} name
 * @returns {string[]}
 */
export function modelsFor(resources, name) {
  const entry = resources?.tokens?.[name];
  return Array.isArray(entry?.models) ? [...entry.models] : [];
}

/**
 * 记一次**成功的**拉取。返回新对象，不改入参（与 reducer 同一个纪律）。
 *
 * ★ 覆盖语义：同一个 token 再拉一次就是**整份替换**——清单是"这个端点现在有什么"，
 * 不是历史累积。失败的拉取**不调用它**（旧记录原样留着，那正是它该有的样子）。
 *
 * ★ 价格同理**整份替换**：这次端点没报价格，旧价就**不能**留着——
 *   那会变成"模型已经涨价/改价，报表还在按三个月前的价算"。
 *
 * @param {{ version: number, tokens: Record<string, ResourceEntry> }} resources
 * @param {string} name
 * @param {string} url 实际用的地址
 * @param {unknown} models 服务端给的 id 列表（可以是脏的）
 * @param {string} [nowIso] 调用方给的时间；不给 = 空串（测试用，生产永远给）
 * @param {unknown} [pricing] 端点顺路报的价格（id → `Price`）；没有就传 `null`
 * @returns {{ version: number, tokens: Record<string, ResourceEntry> }}
 */
export function withFetchedModels(resources, name, url, models, nowIso = '', pricing = null) {
  const base = normalizeResources(resources);
  const key = typeof name === 'string' ? name.trim() : '';
  if (key === '') return base;

  /** @type {ResourceEntry} */
  const entry = {
    url: typeof url === 'string' ? url : '',
    models: cleanModels(models),
    fetchedAt: typeof nowIso === 'string' ? nowIso : '',
  };
  const prices = cleanPricing(pricing);
  if (Object.keys(prices).length > 0) entry.pricing = prices;

  return {
    ...base,
    tokens: {
      ...base.tokens,
      [key]: entry,
    },
  };
}

/**
 * 全部 token 登记里的端点价，合成一张 `id → Price` 的表（§2.13）。
 *
 * ★ 同名模型在**不同网关**上可能给出不同的价（中转站加价率不一样）。
 *   这里按 **token 名字母序**取第一个，规则简单且稳定——想精确到某个网关，
 *   就在 `prices.json` 里写死那个 id（用户手写的那份优先，见 `usage.js`）。
 *
 * @param {{ tokens?: Record<string, ResourceEntry> } | null | undefined} resources
 * @returns {Record<string, import('./prices.js').Price>}
 */
export function endpointPrices(resources) {
  /** @type {Record<string, import('./prices.js').Price>} */
  const out = {};
  const tokens = resources?.tokens;
  if (!tokens || typeof tokens !== 'object') return out;

  for (const name of Object.keys(tokens).sort()) {
    const p = tokens[name]?.pricing;
    if (!p || typeof p !== 'object') continue;
    for (const [id, price] of Object.entries(p)) {
      if (out[id] === undefined) out[id] = price;
    }
  }
  return out;
}

/**
 * 下拉的候选：**已声明的在前（保持优先级顺序）**，缓存里剩下的按字母序补在后面。
 *
 * 顺序是有意义的：
 * - 已声明那一段就是 `models` 的优先级——用户扫的就是"我现在用的这几个"；
 * - 缓存补的那一段是"这个端点还提供什么"——按字母排，才**找得到**。
 *   （服务端顺序是插入序、没有意义，§2.14 六 实测过。）
 *
 * ★ 前端**不**做这件事：`src/web/app.js` 是逐字共享的，它不该知道
 * "哪些模型出现过"这种业务逻辑。
 *
 * @param {unknown} declared 已声明的 id（`probeFor()` 给的字符串数组）
 * @param {unknown} cached 登记里的 id
 * @returns {string[]}
 */
export function modelOptionsFor(declared, cached) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();

  for (const id of cleanModels(declared)) {
    if (out.length >= MAX_MODELS) break;
    seen.add(id);
    out.push(id);
  }

  const rest = cleanModels(cached)
    .filter((id) => !seen.has(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const id of rest) {
    if (out.length >= MAX_MODELS) break;
    out.push(id);
  }
  return out;
}

// ───────────────────────────── 小件 ─────────────────────────────

/**
 * 收一份 id 列表：非字符串 / 空串 / 重复丢掉，超上限截断。
 *
 * ★ **保序**。这个函数被读盘、写盘、拼下拉三处共用——一处排一次序，
 * 三处就会给出三种顺序。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function cleanModels(raw) {
  if (!Array.isArray(raw)) return [];

  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= MAX_MODELS) break;
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 收一份价格表：id 去空白、值逐条过 `normalizePriceEntry()`，坏的丢掉，超上限截断。
 *
 * ★ 与 `cleanModels()` 共用 `MAX_MODELS`：价格表跟着模型清单走，
 *   清单有几项它就最多几项——两份上限分开定只会漂移。
 *
 * @param {unknown} raw
 * @returns {Record<string, import('./prices.js').Price>}
 */
function cleanPricing(raw) {
  /** @type {Record<string, import('./prices.js').Price>} */
  const out = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;

  let n = 0;
  for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (n >= MAX_MODELS) break;
    const id = key.trim();
    if (id === '' || out[id] !== undefined) continue;
    const p = normalizePriceEntry(value);
    if (p === null) continue;
    out[id] = p;
    n++;
  }
  return out;
}
