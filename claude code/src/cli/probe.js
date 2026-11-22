// @ts-check
/**
 * 额度探测：**发一次最小的真实请求**，看这把 key 还能不能用（§2.13 四）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么必须真的发请求
 *
 * 中转站**没有**查询余额的通用接口，而"额度用尽"在协议层上常常是一个
 * **正常的 HTTP 应答**（`insufficient_user_quota` 走 403/429、甚至 200 的错误体）。
 * 所以唯一可靠的判据是**让它真花一次钱**：发一条最短的请求，2xx 就算有余额。
 *
 * 代价是真的要花钱——所以调用方那边必须有两道闸门：
 * **新鲜度 TTL**（`isStale()`）与**遇到第一个 `ok` 就停**。
 * 本文件只负责"探一次"，这两件都不在这里。
 *
 * ## 探什么：**跟启动时看到同一套值**
 *
 * 走 `prepareSession()` 而不是直接读 `tokens/<name>.json`——探测要回答的是
 * "用这个 token 启动会不会有额度"，那就必须和 `cmt run` 看到的是同一套
 * 端点 / 凭证 / 认证方式（绑定的 `baseUrl`、`${ENV}` 求值都在里面）。
 *
 * ## ★ 它**不抛错**
 *
 * 网络不通是**常态**（内网端点、代理没开），不是异常。抛错会让调用方在
 * `catch` 里重新组装同样的信息，而组装出来的那一份永远比这里的少几项。
 * 所以一律返回 `{status, detail, …}`，`status` 直接来自共享的分类器。
 *
 * ## ★★ 绝不打印、绝不外传密钥
 *
 * 这个文件是**第二个**会带着密钥出门的地方（第一个是拉模型清单）。
 * 所以：(a) 密钥只进认证头；(b) 任何往外递的文本都要先过 `redactSecret()`——
 * 有些网关会把收到的认证头原样写进错误体。
 * ─────────────────────────────────────────────────────────────
 */
import { evalEnvRef } from '../core/resolve.js';
import { STATUS, classifyProbe } from '../core/pool.js';
import { prepareSession } from './session.js';

/** 单次探测的超时。中转站要么秒回、要么根本连不上，10 秒足够区分。 */
export const PROBE_TIMEOUT_MS = 10000;

/**
 * 探测请求的输出上限。
 *
 * ★ **必须是 1**（§2.13 四，用户 2026-10-31 拍板）：多点一个 token 就多一点钱，
 * 而"这把 key 还能不能用"在第 1 个输出 token 时就已经知道了。
 */
export const PROBE_MAX_TOKENS = 1;

/**
 * 没配模型时的兜底。
 *
 * ★ 探测**必须**带一个模型名（协议要求），而"这个 token 没声明 `models`"是可能的
 * （§2.5 规则 4：`models` 是继承项）。给一个 Anthropic 兼容网关普遍认识的默认值，
 * 并允许 `--model` / `CMT_PROBE_MODEL` 覆盖——**判错的代价只是这一次探测**，
 * 不是这把 key 的去留。
 */
export const DEFAULT_PROBE_MODEL = 'claude-haiku-4-5-20251001';

/** `anthropic-version` 头——Anthropic 协议要求，中转站大多照验。 */
const ANTHROPIC_VERSION = '2023-06-01';

/** 探测用的那句话。越短越好——它按 token 计费。 */
const PROBE_INPUT = 'ping';

/**
 * @typedef {object} ProbeResult
 * @property {string} status    `STATUS` 之一（**不是** `unknown`）
 * @property {string} detail    给人看的一行（`HTTP 200 · 812ms`）
 * @property {number | null} httpStatus 没发出请求时为 `null`
 * @property {number} elapsedMs
 * @property {string} model     这一次用的模型名（便于排查"是不是模型挑错了"）
 */

/**
 * @typedef {object} ProbeInput
 * @property {string} baseUrl   端点根地址（尾斜杠随缘）
 * @property {string} secret    明文密钥；**只用于这一个请求头**
 * @property {'token' | 'key'} [authMode]  `token` → `Authorization: Bearer`；`key` → `x-api-key`
 * @property {string} model
 * @property {number} [timeoutMs]
 * @property {typeof globalThis.fetch} [fetchImpl] 测试注入用
 */

/**
 * 对一把明文密钥做一次探测。**永不抛错。**
 * @param {ProbeInput} input
 * @returns {Promise<ProbeResult>}
 */
export async function probeToken(input) {
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const model = input.model;

  /** @type {string} */
  let url;
  try {
    url = messagesUrl(input.baseUrl);
  } catch (err) {
    return fail(STATUS.OTHER, `端点地址不合法：${firstLine(messageOf(err))}`, null, started, model);
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return fail(STATUS.NET_FAIL, `这个 Node 没有 fetch（需要 Node 18+，当前 ${process.version}）`,
      null, started, model);
  }

  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: authHeaders(input.secret, input.authMode),
      body: JSON.stringify({
        model,
        max_tokens: PROBE_MAX_TOKENS,
        messages: [{ role: 'user', content: PROBE_INPUT }],
      }),
      // ★ 超时必须自己带：没有它，一个不响应的地址会让 `pool check` 永远挂着
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(STATUS.NET_FAIL, safeMessage(err, timeoutMs, url), null, started, model);
  }

  /** @type {string} */
  let text;
  try {
    text = await res.text();
  } catch (err) {
    return fail(STATUS.NET_FAIL, `读响应体失败：${safeMessage(err, timeoutMs, url)}`,
      res.status, started, model);
  }

  const status = classifyProbe({ status: res.status, body: text });
  const ms = Date.now() - started;

  // ★ 2xx 只报状态码与耗时——正文是模型回的话，对"有没有钱"毫无信息量，
  //   而把它打出来就等于把一个可能是中文/多行的正文塞进一行的 detail 里。
  if (status === STATUS.OK) {
    return { status, detail: `HTTP ${res.status} · ${ms}ms`, httpStatus: res.status, elapsedMs: ms, model };
  }

  const why = errorTextOf(text);
  return {
    status,
    detail: `HTTP ${res.status} · ${redactSecret(why, input.secret)}`.slice(0, 200),
    httpStatus: res.status,
    elapsedMs: ms,
    model,
  };
}

/**
 * 对**一个已配置的 token** 做探测：先解析出它这次真正会用的端点 / 凭证 / 模型。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {string} name
 * @param {{ model?: string, timeoutMs?: number, fetchImpl?: typeof globalThis.fetch }} [opts]
 * @returns {Promise<ProbeResult>}
 */
export async function probeConfiguredToken(ctx, name, opts = {}) {
  const started = Date.now();

  /** @type {any} */
  let resolved;
  try {
    // ★ 用**调用时的 cwd** 装配：绑定与项目本地配置（§2.11）该生效就生效——
    //   与 `cmt run` 同一个口径。`overrides.token` 是最高优先（§2.3），所以
    //   这里解析出来的**一定**是点名的那把 token。
    const session = prepareSession({
      ctx,
      target: ctx.cwd,
      overrides: { token: name },
    });
    resolved = session.resolved;
  } catch (err) {
    return fail(STATUS.OTHER, `解析不出来：${firstLine(messageOf(err))}`, null, started, opts.model ?? '');
  }

  const model = opts.model
    ?? resolved.models?.value?.[0]?.id
    ?? envProbeModel(ctx.env)
    ?? DEFAULT_PROBE_MODEL;

  /** @type {string} */
  let baseUrl;
  try {
    const raw = resolved.baseUrl?.value;
    if (typeof raw !== 'string' || raw.trim() === '') throw new Error('没有 baseUrl（这个 token 没配端点）');
    baseUrl = evalEnvRef(raw, ctx.env).value;
  } catch (err) {
    return fail(STATUS.OTHER, firstLine(messageOf(err)), null, started, model);
  }

  /** @type {string} */
  let secret;
  try {
    const raw = resolved.authToken?.value;
    if (typeof raw !== 'string' || raw === '') throw new Error('authToken 没配');
    secret = evalEnvRef(raw, ctx.env).value;
  } catch (err) {
    // ★ 本地缺凭证不是"服务端拒绝了它"，但它确实**用不了**——照 `invalid` 记，
    //   理由与"服务端说无效"一样：24 小时内别再拿它去试。
    return fail(STATUS.INVALID, `本地没有可用凭证：${firstLine(messageOf(err))}`, null, started, model);
  }

  const authMode = resolved.authMode?.value === 'key' ? 'key' : 'token';

  return probeToken({
    baseUrl,
    secret,
    authMode,
    model,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * `POST {baseUrl}/v1/messages`（§2.13 四）。
 *
 * ★ `baseUrl` 在本项目里是 **`ANTHROPIC_BASE_URL` 那一层**的地址（例：
 * `https://api.deepseek.com/anthropic`），所以协议路径要自己接上去。
 * 但用户也可能直接把地址写成 `…/v1`，那时再拼一个 `/v1` 就是 `/v1/v1/messages`
 * ——所以先看它是不是已经带上了。
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function messagesUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('baseUrl 是空的');
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  // 端点必须是 http(s)：`file:` / `data:` 之类会让 fetch 直接抛一个难懂的错
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不认识的协议 ${parsed.protocol}（只认 http / https）`);
  }
  return /\/v1$/i.test(trimmed) ? `${trimmed}/messages` : `${trimmed}/v1/messages`;
}

/**
 * 认证头——**由 `authMode` 决定，且只发一个**（§2.6）。
 *
 * | `authMode` | 头 |
 * |---|---|
 * | `token`（默认） | `Authorization: Bearer <key>` |
 * | `key` | `x-api-key: <key>` |
 *
 * ★ 两个都发是错的：Claude Code 那边 `ANTHROPIC_AUTH_TOKEN` 压过
 * `ANTHROPIC_API_KEY`（§7.2），同时发等于让探测看到的认证方式与真实启动不一致。
 *
 * @param {string} secret
 * @param {'token' | 'key' | undefined} authMode
 * @returns {Record<string, string>}
 */
function authHeaders(secret, authMode) {
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (authMode === 'key') headers['x-api-key'] = secret;
  else headers.Authorization = `Bearer ${secret}`;
  return headers;
}

/**
 * `CMT_PROBE_MODEL`——命令行之外的最后一个旋钮。
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function envProbeModel(env) {
  const v = env?.CMT_PROBE_MODEL;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * @param {string} status
 * @param {string} detail
 * @param {number | null} httpStatus
 * @param {number} started
 * @param {string} model
 * @returns {ProbeResult}
 */
function fail(status, detail, httpStatus, started, model) {
  return {
    status,
    detail: firstLine(detail),
    httpStatus,
    elapsedMs: Date.now() - started,
    model,
  };
}

/**
 * 密钥短于这个长度就不做替换——见 `fetch-models.js` 里同一段的理由。
 */
const REDACT_MIN_LEN = 8;

/**
 * @param {string} s
 * @param {string} secret
 * @returns {string}
 */
function redactSecret(s, secret) {
  if (typeof secret !== 'string' || secret.length < REDACT_MIN_LEN) return s;
  return s.split(secret).join('***');
}

/**
 * 从错误体里挑一句最短有用的话。
 *
 * ★ 先试 JSON（`{"error":{"message":"..."}}` 是绝大多数网关的形状），
 *   解不出来就把原文压平成一行——**绝不把整个响应体塞进 detail**。
 * @param {string} text
 * @returns {string}
 */
function errorTextOf(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return '（响应体是空的）';

  try {
    const o = JSON.parse(raw);
    const msg = pickMessage(o);
    if (msg !== null) return msg;
  } catch { /* 不是 JSON：下面按纯文本处理 */ }

  const flat = raw.replace(/\s+/g, ' ');
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

/**
 * 从几种常见错误体里挖出那句话。
 * @param {any} o
 * @returns {string | null}
 */
function pickMessage(o) {
  if (o === null || typeof o !== 'object') return null;
  const e = o.error ?? o;
  if (typeof e === 'string' && e !== '') return e;
  if (e !== null && typeof e === 'object' && typeof e.message === 'string' && e.message !== '') {
    return e.message;
  }
  if (typeof o.message === 'string' && o.message !== '') return o.message;
  return null;
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
 * @param {unknown} err
 * @param {number} timeoutMs
 * @param {string} url
 * @returns {string}
 */
function safeMessage(err, timeoutMs, url) {
  const name = err !== null && typeof err === 'object' ? /** @type {any} */ (err).name : '';
  const raw = messageOf(err);

  if (name === 'TimeoutError' || name === 'AbortError' || /abort/i.test(raw)) {
    return `${timeoutMs} 毫秒内没有响应（${url}）`;
  }
  return firstLine(raw);
}

/**
 * @param {string} s
 * @returns {string}
 */
function firstLine(s) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
