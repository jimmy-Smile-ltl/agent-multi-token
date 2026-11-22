// @ts-check
/**
 * ★ **全项目唯一的网络代码**（§2.14 六 / §4.2）。
 *
 * `GET <baseUrl>/models` —— 面板向导第 3 步用它列出可勾选的模型。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么它必须住在 `platform/`
 *
 * `core/` 是纯的：不读 `process.*`、不 spawn、不碰 fs、**也不发请求**。
 * 网络和 spawn 是同一类东西——**副作用**——所以两者同住这一层（§4.2）。
 * 纯的那一半（URL 拼装、响应解析）在 `core/models-endpoint.js`，可以单测；
 * 这一半只负责"把请求发出去、把响应文本拿回来"。
 *
 * ## ★ 它**不抛错**，返回 `{ ok: false, error }`
 *
 * 理由与 `detectTerminal()`（§4.2）一致：**拉不到模型是常态**，不是异常。
 * 中转站常在内网、或者干脆没实现 `/models`。向导第 3 步的界面必须能显示
 * "为什么拉不到"，然后给出 `[r] 重试 / [m] 手敲 / [s] 跳过` 三条出路（§2.14 四）。
 * 抛错的话调用方要在 catch 里重新组装一遍同样的信息。
 *
 * ## ★★ 绝不打印、绝不外传 token
 *
 * `Authorization: Bearer <sk-…>` 是**唯一**会带着密钥出门的地方。
 * 所以：错误信息里只许出现 **URL / HTTP 状态 / 响应体片段**——
 * 一旦把 `err.message` 原样抛出去，undici 的网络错误有可能带上完整请求头。
 * 见下面的 `safeMessage()`。
 *
 * ## 不缓存
 *
 * 每次进第 3 步都现拉（§2.14 六）。加缓存就要回答"什么时候失效"，
 * 而中转站会加模型、key 会换——**不缓存就没有失效问题**。
 * ─────────────────────────────────────────────────────────────
 */

import { modelsUrl, parseModelsResponse } from '../core/models-endpoint.js';

/** 默认超时。内网端点要么秒回、要么根本连不上，10 秒足够区分这两者。 */
export const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @typedef {object} FetchModelsInput
 * @property {string} baseUrl       端点根地址（尾斜杠随缘，`modelsUrl()` 会处理）
 * @property {string} authToken     明文密钥；**只用于这一个请求头**
 * @property {number} [timeoutMs]
 * @property {typeof globalThis.fetch} [fetchImpl]  测试注入用
 */

/**
 * @typedef {object} FetchModelsResult
 * @property {boolean} ok
 * @property {string[]} ids         失败时恒为 `[]`
 * @property {Record<string, import('../core/prices.js').Price>} pricing
 *   端点顺路报的价格（id → USD / 百万 token）；端点没报就是**空对象**，不是错误
 * @property {number | null} status HTTP 状态码；**没发出去**（拼 URL 就失败了）时为 `null`
 * @property {string | null} error
 * @property {string | null} url    实际请求的 URL——报错时用户要靠它判断"是不是打错了地址"
 */

/**
 * 拉取模型清单。
 *
 * ★ 这是个**薄壳**：真正的活儿在 `fetchModelsRaw()`，这里只做一件事——
 *   把返回值里可能夹带的密钥**统一抹掉**（见 `redactSecret()`）。
 *
 * 做成单一出口而不是在每个 `return` 上写一遍，理由和 §2.9 的"唯一入口"同源：
 * **漏掉一处就等于没做**，而漏掉的那一处正是没人测到的那条分支。
 *
 * @param {FetchModelsInput} input
 * @returns {Promise<FetchModelsResult>}
 */
export async function fetchModels(input) {
  const r = await fetchModelsRaw(input);
  return { ...r, error: r.error === null ? null : redactSecret(r.error, input.authToken) };
}

/**
 * @param {FetchModelsInput} input
 * @returns {Promise<FetchModelsResult>}
 */
async function fetchModelsRaw(input) {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /** @type {string} */
  let url;
  try {
    url = modelsUrl(input.baseUrl);
  } catch (err) {
    // 纯函数那一半的报错（baseUrl 是空的）——原样转成结果，不往上抛
    return { ok: false, ids: [], pricing: {}, status: null, error: messageOf(err), url: null };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      ids: [],
      pricing: {},
      status: null,
      error: `这个 Node 没有 fetch（需要 Node 18+，当前 ${process.version}）`,
      url,
    };
  }

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${input.authToken}`,
        Accept: 'application/json',
      },
      // ★ 超时必须自己带：没有它，一个不响应的内网地址会让面板**永远卡在第 3 步**，
      //   而那是 raw mode 里——用户连 Ctrl+C 都出不去（§2.14 八）。
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, ids: [], pricing: {}, status: null, error: safeMessage(err, timeoutMs, url), url };
  }

  /** @type {string} */
  let text;
  try {
    text = await res.text();
  } catch (err) {
    return {
      ok: false,
      ids: [],
      pricing: {},
      status: res.status,
      error: `读响应体失败：${safeMessage(err, timeoutMs, url)}`,
      url,
    };
  }

  // ★ 解析**先于**状态码判断：HTTP 200 也可能是错误体（§2.14 六的注释），
  //   而错误体里的那句话（"invalid api key"）比 "HTTP 200" 有用得多。
  const parsed = parseModelsResponse(text);

  if (!res.ok) {
    const detail = parsed.error ?? snippetOf(text);
    return { ok: false, ids: [], pricing: {}, status: res.status, error: `HTTP ${res.status}：${detail}`, url };
  }

  if (parsed.error !== null) {
    return { ok: false, ids: [], pricing: {}, status: res.status, error: parsed.error, url };
  }

  return { ok: true, ids: parsed.ids, pricing: parsed.pricing, status: res.status, error: null, url };
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * 密钥短于这个长度就不做替换。
 *
 * 理由：`replaceAll` 一个 2 字符的"密钥"会把 `fetch failed` 打成
 * `fetch f***iled`——**错误信息直接变成噪音**，而 2 个字符的 bearer token
 * 在任何一个真实网关上都不可能通过。代价不对称：短密钥抹掉的收益接近零，
 * 抹掉可读性的损失是实打实的。
 */
const REDACT_MIN_LEN = 8;

/**
 * ★★ 把密钥从一段文本里抹掉。**这是本项目唯一会带着密钥出门的那条路的收尾。**
 *
 * 两处必须抹：
 *   1. undici 的错误消息在某些形态下会带上完整的请求描述（含请求头）；
 *   2. 有些网关会把收到的 `Authorization` 原样写进错误体。
 * 两处都不是我们造的，但**是我们递出去的**——所以由我们负责擦干净。
 *
 * @param {string} s
 * @param {string} secret
 * @returns {string}
 */
function redactSecret(s, secret) {
  if (typeof secret !== 'string' || secret.length < REDACT_MIN_LEN) return s;
  return s.split(secret).join('***');
}

/**
 * ★ 网络错误 → 给人看的一句话。
 *
 * 超时单独认：`AbortSignal.timeout()` 触发的是 `TimeoutError`，
 * 而它和"地址打错了"的处置方式完全不同（一个该重试，一个该改地址）。
 *
 * @param {unknown} err
 * @param {number} timeoutMs
 * @param {string} url
 * @returns {string}
 */
function safeMessage(err, timeoutMs, url) {
  const name = err !== null && typeof err === 'object' ? /** @type {any} */ (err).name : '';
  const raw = messageOf(err);

  if (name === 'TimeoutError' || name === 'AbortError' || /abort/i.test(raw)) {
    return `${timeoutMs} 毫秒内没有响应（${url}）——内网端点连不上时就是这个样子`;
  }

  return firstLine(raw);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * @param {string} s
 * @returns {string}
 */
function firstLine(s) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

/**
 * 非 2xx 且解析不出错误体时，至少把原文抖一点出来。
 * @param {string} text
 * @returns {string}
 */
function snippetOf(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (flat === '') return '（响应体是空的）';
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}
