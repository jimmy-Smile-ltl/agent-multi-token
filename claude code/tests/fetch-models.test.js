// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TIMEOUT_MS, fetchModels } from '../src/platform/fetch-models.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/**
 * 假 `fetch`：记下每次调用，按脚本回一个响应。
 *
 * @param {object} [opts]
 * @param {number} [opts.status]
 * @param {string} [opts.body]
 * @param {Error} [opts.throws] 直接抛（模拟网络层失败）
 * @param {boolean} [opts.textThrows] 让 res.text() 抛
 */
function fakeFetch(opts = {}) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  const impl = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    if (opts.throws) throw opts.throws;
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => {
        if (opts.textThrows) throw new Error('socket hang up');
        return opts.body ?? '';
      },
    };
  };
  return { calls, impl: /** @type {any} */ (impl) };
}

const TOKEN = 'sk-SECRET-DO-NOT-LEAK-0123456789';

/**
 * @param {object} [opts]
 * @param {Parameters<typeof fakeFetch>[0]} [fakeOpts]
 */
function run(opts = {}, fakeOpts = {}) {
  const f = fakeFetch(fakeOpts);
  return {
    f,
    p: fetchModels({ baseUrl: 'https://x.example.com/v1', authToken: TOKEN, fetchImpl: f.impl, ...opts }),
  };
}

// ═══════════════ 成功路径 ═══════════════

describe('fetchModels —— 成功路径', () => {
  test('★ 请求拼好的 URL，带上 Bearer 与 Accept', async () => {
    const { f, p } = run({}, { body: JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }) });
    const r = await p;

    assert.equal(r.ok, true);
    assert.deepEqual(r.ids, ['a', 'b']);
    assert.equal(r.status, 200);
    assert.equal(r.error, null);
    assert.equal(r.url, 'https://x.example.com/v1/models');

    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, 'https://x.example.com/v1/models');
    assert.equal(f.calls[0].init.method, 'GET');
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(f.calls[0].init.headers.Accept, 'application/json');
  });

  test('★★ 带上超时 signal——没有它，不响应的内网地址会让面板永远卡在第 3 步', async () => {
    const { f, p } = run({ timeoutMs: 1234 }, { body: '{"data":[]}' });
    await p;
    const signal = f.calls[0].init.signal;
    assert.ok(signal instanceof AbortSignal, '★ signal 必须是 AbortSignal');
    assert.equal(signal.aborted, false, '★ 刚发出去时不该已经中止');
  });

  test('★ 空列表是 ok（服务端说"我一个模型都没有"）——由界面决定要不要提示', async () => {
    const { p } = run({}, { body: JSON.stringify({ object: 'list', data: [] }) });
    const r = await p;
    assert.equal(r.ok, true);
    assert.deepEqual(r.ids, []);
    assert.equal(r.error, null);
  });

  test('默认超时是一个具体的数（不是 undefined 传给 AbortSignal）', () => {
    assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number');
    assert.ok(DEFAULT_TIMEOUT_MS > 0);
  });
});

// ═══════════════ 失败路径：四种，各自要能分清 ═══════════════

describe('fetchModels —— 失败要说清是哪一种', () => {
  test('★★ HTTP 非 2xx：状态码 + 响应体里的那句话都要有', async () => {
    const { p } = run({}, {
      status: 401,
      body: JSON.stringify({ error: { message: 'Invalid API key provided' } }),
    });
    const r = await p;
    assert.equal(r.ok, false);
    assert.deepEqual(r.ids, []);
    assert.equal(r.status, 401);
    assert.match(/** @type {string} */ (r.error), /401/);
    assert.match(/** @type {string} */ (r.error), /Invalid API key provided/);
  });

  test('★ HTTP 非 2xx 且响应体是 HTML → 抖一段原文出来', async () => {
    const { p } = run({}, { status: 502, body: '<html><body>Bad Gateway</body></html>' });
    const r = await p;
    assert.match(/** @type {string} */ (r.error), /502/);
    assert.match(/** @type {string} */ (r.error), /Bad Gateway/);
  });

  test('★ HTTP 非 2xx 且响应体是空的 → 明说"响应体是空的"，不是空白', async () => {
    const { p } = run({}, { status: 500, body: '' });
    const r = await p;
    assert.match(/** @type {string} */ (r.error), /500/);
    assert.match(/** @type {string} */ (r.error), /空的/);
  });

  test('★★ HTTP 200 但是错误体 → 判成失败（这正是"网关转发成功、上游报错"的形态）', async () => {
    const { p } = run({}, { status: 200, body: JSON.stringify({ error: { message: 'quota exceeded' } }) });
    const r = await p;
    assert.equal(r.ok, false, '★ 200 不等于拿到了模型列表');
    assert.match(/** @type {string} */ (r.error), /quota exceeded/);
  });

  test('★★ 网络层抛错 → 不抛出去，转成 { ok:false }', async () => {
    const { p } = run({}, { throws: new TypeError('fetch failed') });
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.status, null);
    assert.match(/** @type {string} */ (r.error), /fetch failed/);
  });

  test('★★ 超时单独认——它和"地址打错了"的处置方式完全不同', async () => {
    const err = new Error('The operation was aborted due to timeout');
    err.name = 'TimeoutError';
    const { p } = run({ timeoutMs: 10 }, { throws: err });
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(/** @type {string} */ (r.error), /10 毫秒内没有响应/);
    assert.match(/** @type {string} */ (r.error), /内网端点/);
  });

  test('读响应体时炸掉 → 也转成结果，且带上已经拿到的状态码', async () => {
    const { p } = run({}, { status: 200, textThrows: true });
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.status, 200);
    assert.match(/** @type {string} */ (r.error), /读响应体失败/);
  });

  test('★ baseUrl 是空的 → 不发请求，直接给纯函数那句报错', async () => {
    const f = fakeFetch({ body: '{}' });
    const r = await fetchModels({ baseUrl: '', authToken: TOKEN, fetchImpl: f.impl });
    assert.equal(r.ok, false);
    assert.equal(r.status, null);
    assert.equal(r.url, null);
    assert.match(/** @type {string} */ (r.error), /baseUrl/);
    assert.equal(f.calls.length, 0, '★ 地址都拼不出来就不该发请求');
  });
});

// ═══════════════ ★★ 凭证不许外泄 ═══════════════

describe('★★ 失败结果里绝不许出现密钥', () => {
  test('网络层抛出的错误消息里带上了请求头 → 我们这边不许原样透出去', async () => {
    // 这是真实存在的形态：undici 的某些错误展开后能看到完整的请求描述
    const leaky = new TypeError(`fetch failed: GET https://x/models Authorization: Bearer ${TOKEN}`);
    const { p } = run({}, { throws: leaky });
    const r = await p;
    assert.doesNotMatch(/** @type {string} */ (r.error), /sk-SECRET/, '★ 密钥泄进错误信息了');
  });

  test('非 2xx 的响应体里若回显了密钥，也不许透出去', async () => {
    // 有些网关会把收到的 Authorization 原样写进错误体
    const { p } = run({}, { status: 400, body: JSON.stringify({ error: { message: `bad key: ${TOKEN}` } }) });
    const r = await p;
    assert.doesNotMatch(/** @type {string} */ (r.error), /sk-SECRET/, '★ 密钥泄进错误信息了');
  });

  test('成功结果里当然也不含密钥', async () => {
    const { p } = run({}, { body: '{"data":[{"id":"a"}]}' });
    assert.doesNotMatch(JSON.stringify(await p), /sk-SECRET/);
  });

  test('★ 抹掉密钥之后，错误信息本身还得能读', async () => {
    const { p } = run({}, { throws: new TypeError(`fetch failed: Bearer ${TOKEN} 连不上`) });
    const r = await p;
    assert.match(/** @type {string} */ (r.error), /fetch failed/);
    assert.match(/** @type {string} */ (r.error), /连不上/);
    assert.match(/** @type {string} */ (r.error), /\*\*\*/);
  });

  test('★ 太短的"密钥"不抹——抹了会把整句话打成噪音', async () => {
    // 代价不对称：2 个字符的 bearer token 在任何真实网关上都不可能通过，
    // 而 `replaceAll('a', '***')` 会把 `fetch failed` 变成 `fetch f***iled`。
    const f = fakeFetch({ throws: new TypeError('fetch failed') });
    const r = await fetchModels({
      baseUrl: 'https://x.example.com/v1',
      authToken: 'ab',
      fetchImpl: f.impl,
    });
    assert.equal(r.error, 'fetch failed', '★ 短密钥不该被当成替换目标');
  });
});
