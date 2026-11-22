// @ts-check
/**
 * 取价：把三级价格合成**一张表**（§2.15 九 9.2）。
 *
 * 为什么值得单独一个文件：`cxt usage` 与网页控制台的资源屏要看**同一份**价格。
 * 两边各拼一遍三级合并，就是"同一个模型在两个页面两个价"——而那不会有任何报错，
 * 只有人把两张表摆在一起才会发现。
 *
 * 优先级（高 → 低）：
 *   1. 用户手写的 `prices.json`（结算价）
 *   2. `resources.json` 里端点自报的 `pricing`（挂牌价）
 *   3. 都没有 ⇒ 查不到价（`costOf()` 给 `null`，渲染成 `—`，**绝不冒充 `$0`**）
 *
 * ★ ①永远压过②：用户写了实际结算价，不该被一次「拉取」默默盖掉。
 * ★ 读不到 / 读坏了都**不抛错**：两份都是可丢弃的（`resources.json` 是重建缓存，
 *   没有 `prices.json` 本来就是常态）。坏了只该让花费那一列变回 `—`。
 */
import nodeFs from 'node:fs';

import { pricesPath } from '../core/paths.js';
import { normalizePriceTable } from '../core/prices.js';
import { endpointPrices } from '../core/resources.js';
import { readResources } from '../core/store.js';

/**
 * @typedef {object} LoadedPrices
 * @property {string} file                        `prices.json` 的绝对路径（报表要印出来）
 * @property {import('../core/prices.js').PriceTable} table  三级合并后的表
 * @property {string[]} handwritten               用户手写表里有的模型 id（**合并之前**数）
 * @property {number} fromEndpoint                由端点价补进来的模型个数
 */

/**
 * 取价，**只有这一处实现**。`cxt usage` 与资源屏都调它。
 *
 * @param {import('./types.js').Ctx} ctx
 * @returns {LoadedPrices}
 */
export function loadPriceTable(ctx) {
  const file = pricesPath(ctx.home);
  const table = loadPrices(file);
  // ★ 在端点价并进来**之前**数：`--json` 里说的"用户手写的表被用上了"，
  //   指的是盘上那份真的贡献了条目，不是"盘上有这么一个文件"。合并之后数就永远"有"了。
  const handwritten = Object.keys(table.models);

  let fromEndpoint = 0;
  for (const [id, p] of Object.entries(loadEndpointPrices(ctx.home))) {
    if (table.models[id] === undefined) {
      table.models[id] = p;
      fromEndpoint++;
    }
  }

  return { file, table, handwritten, fromEndpoint };
}

/**
 * @param {string} file
 * @returns {import('../core/prices.js').PriceTable}
 */
function loadPrices(file) {
  /** @type {string} */
  let text;
  try {
    text = nodeFs.readFileSync(file, 'utf8');
  } catch {
    return { models: {}, problems: [] }; // 没有价格表是常态，不是错误
  }
  /** @type {unknown} */
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { models: {}, problems: [`${file} 不是合法 JSON（${/** @type {any} */ (err).message}）`] };
  }
  return normalizePriceTable(raw);
}

/**
 * 从 `resources.json` 捡端点顺路报的价。
 *
 * ★ 读不到 / 读坏了就当**没有价格**，不报错：那份文件的地位是可丢弃的重建缓存
 *   （§3.4），它坏了只该让花费那列变回 `—`，不该让整份报表打不开。
 *
 * @param {string} home
 * @returns {Record<string, import('../core/prices.js').Price>}
 */
function loadEndpointPrices(home) {
  try {
    return endpointPrices(readResources(home));
  } catch {
    return {};
  }
}
