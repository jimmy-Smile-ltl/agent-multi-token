// @ts-check
/**
 * ★ `/models` 的 **URL 拼装与响应解析**（§2.14 六）——**纯函数，不发请求**。
 *
 * ─────────────────────────────────────────────────────────────
 * 网络那一半在 `platform/fetch-models.js`（§4.2：副作用只许住在 `platform/`）。
 * 这里只回答两个问题，两个都能在任意一台机器上单测：
 *
 *   1. 给一个 baseUrl，**该请求哪个 URL**？（`modelsUrl`）
 *   2. 拿到一段响应文本，**里面有哪些模型 id、各自什么价**？
 *      没有的话**为什么**？（`parseModelsResponse`）
 *
 * ★ **价格顺路带回来**（§2.13）：OpenRouter 及其仿制者的每一项目里都有
 *   `pricing: { prompt, completion, … }`（USD / token 的十进制**字符串**）。
 *   拉清单时一起记下，`cxt usage` 就不必逼用户手抄一份 `prices.json`。
 *   转成「USD / 百万 token」的活交给 `core/prices.js::priceFromEndpoint()`，
 *   本文件只负责"哪一项属于哪个 id"。
 * ─────────────────────────────────────────────────────────────
 *
 * ## 为什么要容三种响应形态
 *
 * 面板向导第 3 步拉的是**中转站**的 `/models`，不是 OpenAI 官方那个。
 * 实测过的形态至少有三种：
 *
 * ```jsonc
 * { "object": "list", "data": [{ "id": "gpt-5.6-sol", ... }] }   // OpenAI 官方 / one-api
 * { "data": ["gpt-5.6-sol", "deepseek-v3"] }                      // 简化过的中转
 * ["gpt-5.6-sol", "deepseek-v3"]                                  // 裸数组
 * ```
 *
 * 只认第一种的话，第二三种的站点在面板里会显示成"拉不到"——**而它其实拉到了**，
 * 只是我们没看。这是"宁可明确"的反面：把一个成功的请求报成失败。
 *
 * ## 为什么错误体也要在这里认
 *
 * ⚠️ **HTTP 200 也可能是错误体**（中转站的常见做法：网关转发成功，
 * 上游用错误 JSON 回话）。所以"HTTP 状态码正常"不能推出"拿到的是模型列表"——
 * 解析层必须自己认 `error`，否则用户看到的是"该端点没有返回任何模型"，
 * 而真正的原因是"你的 key 无效"。**错误信息必须原样透出来。**
 *
 * ## 为什么非 JSON 也要给一段原文
 *
 * baseUrl 指错时最常见的表现是**返回一整个 HTML 登录页**（200 + `<!DOCTYPE html>`）。
 * 只说"不是 JSON"等于让用户自己去猜，给 60 个字符的原文他一眼就懂了。
 */

import { CxtError } from './errors.js';
import { priceFromEndpoint } from './prices.js';

/**
 * 拼出模型清单的 URL：`<baseUrl>/models`，**尾斜杠去重**。
 *
 * `https://x/v1` / `https://x/v1/` / `https://x/v1///` 得到同一个结果——
 * 用户从别处复制粘贴 baseUrl 时尾斜杠带不带完全随机，为此报错没有道理。
 *
 * ⚠️ **不做 URL 合法性校验**：那件事归 `schema.js`（`baseUrl` 在那里已被要求
 * 非空、且不许是 `${VAR}` 引用）。这里只负责拼接，多一道校验就是第二处真相。
 *
 * @param {string} baseUrl
 * @returns {string}
 */
export function modelsUrl(baseUrl) {
  const s = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (s === '') {
    throw new CxtError('baseUrl 是空的，拼不出 /models 的地址', {
      hint: '这个 token 没声明 baseUrl。补上它：`cxt token edit <名字> --base-url <url>`；'
        + '或者在面板第 3 步按 [m] 手动输入模型 id（不联网也能往下走）',
    });
  }
  return `${s.replace(/\/+$/, '')}/models`;
}

/**
 * 解析 `/models` 的响应体（§2.14 六）。
 *
 * @param {string} text 响应原文（**未解析的**，好让"不是 JSON"这条也能给出原文片段）
 * @returns {{ ids: string[], pricing: Record<string, import('./prices.js').Price>, error: string | null }}
 *   `error` 非 null 时 `ids` 必为空数组——**要么给列表，要么给原因，不会两样都含糊**。
 *   `pricing` 只是**顺路捡到的**：端点不报价格时它就是个空对象，
 *   那**不是**错误（绝大多数中转站根本没有这个字段）。
 */
export function parseModelsResponse(text) {
  const raw = typeof text === 'string' ? text : '';

  /** @type {any} */
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return {
      ids: [],
      pricing: {},
      error: raw.trim() === ''
        ? '响应是空的（连 JSON 都不是）'
        : `响应不是 JSON（开头是 ${snippet(raw)}）`,
    };
  }

  // ★ 先认错误体：HTTP 200 也可能是它，而它比"没有列表"更值得说出口
  const errMsg = errorMessageOf(body);
  if (errMsg !== null) return { ids: [], pricing: {}, error: errMsg };

  const arr = Array.isArray(body)
    ? body
    : (body !== null && typeof body === 'object' && Array.isArray(body.data) ? body.data : null);

  if (arr === null) {
    return {
      ids: [],
      pricing: {},
      error: `响应里没有模型列表（既不是数组，也没有 data 数组）——原文开头是 ${snippet(raw)}`,
    };
  }

  /** @type {string[]} */
  const ids = [];
  /** @type {Record<string, import('./prices.js').Price>} */
  const pricing = {};
  const seen = new Set();
  let unusable = 0;

  for (const item of arr) {
    const id = idOf(item);
    if (id === null) {
      unusable += 1;
      continue;
    }
    // ★ 去重保序：重复 id 在面板里会变成两个一模一样的选项，
    //   勾两次还会得到一个"同一个模型占两个优先级位"的列表——那是没有意义的。
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);

    const p = priceOf(item);
    if (p !== null) pricing[id] = p;
  }

  // ⚠️ "一项都认不出"与"服务端就是空的"必须分开：
  //    前者是我们看不懂人家的形状（该报错），后者是合法回答（该让用户手敲）。
  if (ids.length === 0 && unusable > 0) {
    return {
      ids: [],
      pricing: {},
      error: `列表里有 ${unusable} 项，但没有一项认得出模型 id`
        + '（每一项要么是字符串，要么是带 "id" 的对象）',
    };
  }

  return { ids, pricing, error: null };
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * 从一项里取模型 id。认不出返回 `null`。
 *
 * 只认 `id` 这一个字段，**不猜** `name` / `model` / `slug`：
 * 猜错的表现是往用户的优先级列表里塞一个不存在的模型名，
 * 而那个错误要到 `cxt run` 时才由 Codex 报出来——**离现场太远了**。
 *
 * @param {unknown} item
 * @returns {string | null}
 */
function idOf(item) {
  if (typeof item === 'string') {
    const s = item.trim();
    return s === '' ? null : s;
  }
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    const v = /** @type {any} */ (item).id;
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return null;
}

/**
 * 从一项里取价格。没有 / 认不出返回 `null`。
 *
 * 只认 OpenRouter 形态的 `pricing` 字段（`prompt` / `completion` / …）。
 * **不猜**别的字段名（`price` / `cost` / `input_price` 各家自创），
 * 理由与 `idOf()` 相同：猜错就是个**看着像真的**的数，而错的价格比没有价格更糟。
 *
 * ★ 价格是**顺路捡的**，所以这里的任何失败都必须安静——
 *   `priceFromEndpoint()` 认不出就返回 `null`，不上抛、不报 problem。
 *
 * @param {unknown} item
 * @returns {import('./prices.js').Price | null}
 */
function priceOf(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return null;
  return priceFromEndpoint(/** @type {any} */ (item).pricing);
}

/**
 * 从响应体里挖出错误信息；没有 `error` 字段返回 `null`。
 *
 * 认三种形状：`{error: "文字"}` / `{error: {message: "文字"}}` / 其余形状**原样抖出来**
 * （最后那种看着笨，但比"未知错误"强——用户至少能搜那段 JSON）。
 *
 * @param {any} body
 * @returns {string | null}
 */
function errorMessageOf(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!('error' in body)) return null;

  const e = body.error;
  if (typeof e === 'string' && e.trim() !== '') return e;
  if (e !== null && typeof e === 'object' && typeof e.message === 'string' && e.message.trim() !== '') {
    return e.message;
  }
  return `端点返回了错误：${snippet(JSON.stringify(e) ?? String(e))}`;
}

/**
 * 原文 → 一小段单行摘录（给错误信息用）。
 *
 * 折行与连续空白压成一个空格：HTML 登录页的开头几十个字符里通常全是缩进和换行，
 * 不压的话摘录里一个字都看不见。
 *
 * @param {string} s
 * @returns {string}
 */
function snippet(s) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}
