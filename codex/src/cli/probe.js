// @ts-check
/**
 * 额度探测：**发一次最小的真实请求**，看这把 key 还能不能用。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么必须真的发请求
 *
 * 各家中转站**没有**查询余额的通用接口：`/dashboard/billing` 是 OpenAI 独有、
 * `/user/self` 是一部分 oneapi 部署才有。而"额度用尽"在协议层上的表现
 * 恰恰是一个**正常的 HTTP 应答**（`insufficient_user_quota` 常常是 403/429
 * 甚至 200 的错误体）。所以唯一可靠的判据是**让它真花一次钱**：
 * 发一条最短的请求，2xx 就算有余额。
 *
 * 代价是真的要花钱、也真的是一次调用——所以调用方那边必须有两道闸门：
 * **新鲜度 TTL**（探过就别再探）与**遇到第一个 `ok` 就停**。
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
 * 所以：(a) 密钥只进 `Authorization` 头；(b) 任何往外递的文本都要先过
 * `redactSecret()`——有些网关会把收到的 `Authorization` 原样写进错误体。
 * ─────────────────────────────────────────────────────────────
 */
import { STATUS, classifyProbe } from '../core/pool.js';
import { parseSecretRef } from '../core/schema.js';
import { resolveSession } from './session.js';

/** 单次探测的超时。中转站要么秒回、要么根本连不上，10 秒足够区分。 */
export const PROBE_TIMEOUT_MS = 10000;

/** 探测请求的输出上限——够让服务端做一次额度检查，又不会真写出什么。 */
export const PROBE_MAX_OUTPUT_TOKENS = 16;

/**
 * 没配模型时的兜底。
 *
 * ★ 探测**必须**带一个模型名（协议要求），而"用户没配 models"是常态
 * （模型写在 profile 的 `config.toml` 里，不在这份配置里）。
 * 所以给一个 OpenAI 兼容网关普遍认识的默认值，并允许 `--model` /
 * `CXT_PROBE_MODEL` 覆盖——**判错的代价只是这一次探测**，不是这把 key 的去留。
 */
export const DEFAULT_PROBE_MODEL = 'gpt-4o-mini';

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
    url = responsesUrl(input.baseUrl);
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
      headers: {
        Authorization: `Bearer ${input.secret}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        input: PROBE_INPUT,
        max_output_tokens: PROBE_MAX_OUTPUT_TOKENS,
        // ★ 不落库：探测是"问一句就走"，没有理由在对方那边留一条会话
        store: false,
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
 * ★ 用 `resolveSession()` 而不是直接读 `tokens/<name>.json`——探测要回答的是
 * "用这个 token 启动会不会有额度"，那就必须**和服务启动时看到的是同一套值**
 * （binding / project / defaults 各层的覆盖都在里面）。
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
    // `exec` 入口：探测不关心 token.cwd（那是"弹窗口落在哪"），
    // 用 exec 是为了**不**让一个只给 run 用的默认目录影响判断。
    resolved = resolveSession(ctx, { token: name }, 'exec');
  } catch (err) {
    return fail(STATUS.OTHER, `解析不出来：${firstLine(messageOf(err))}`, null, started, opts.model ?? '');
  }

  const baseUrl = resolved.baseUrl?.value;
  const model = opts.model
    ?? resolved.model?.value
    ?? envProbeModel(ctx.env)
    ?? DEFAULT_PROBE_MODEL;

  if (typeof baseUrl !== 'string' || baseUrl === '') {
    return fail(STATUS.OTHER, '没有 baseUrl（这个 token 没配端点）', null, started, model);
  }

  /** @type {string} */
  let secret;
  try {
    secret = secretOf(resolved.authToken?.value, ctx.env);
  } catch (err) {
    // ★ 本地缺凭证不是"服务端拒绝了它"，但它确实**用不了**——照 `invalid` 记，
    //   理由与"服务端说无效"一样：24 小时内别再拿它去试。
    return fail(STATUS.INVALID, `本地没有可用凭证：${firstLine(messageOf(err))}`, null, started, model);
  }

  return probeToken({ baseUrl, secret, model, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl });
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * `POST {baseUrl}/responses`。
 *
 * ★ `wireApi` 在本项目里只有 `"responses"` 一种取值（别的会在 schema 里就被拒），
 * 所以这里不需要按它分叉。
 * @param {string} baseUrl
 * @returns {string}
 */
function responsesUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
    throw new Error('baseUrl 是空的');
  }
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  // 端点必须是 http(s)：`file:` / `data:` 之类会让 fetch 直接抛一个难懂的错
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`不认识的协议 ${parsed.protocol}（只认 http / https）`);
  }
  return `${trimmed}/responses`;
}

/**
 * 凭证求值：`${ENV_VAR}` 从**当前进程环境**读，字面量原样用。
 * @param {unknown} raw
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function secretOf(raw, env) {
  if (typeof raw !== 'string' || raw === '') throw new Error('authToken 没配');
  const ref = parseSecretRef(raw);
  if (ref.kind === 'literal') return ref.value;

  const v = env[ref.name];
  if (typeof v !== 'string' || v === '') throw new Error(`引用的环境变量 ${ref.name} 未设置`);
  return v;
}

/**
 * `CXT_PROBE_MODEL`——命令行之外的最后一个旋钮。
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function envProbeModel(env) {
  const v = env?.CXT_PROBE_MODEL;
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
