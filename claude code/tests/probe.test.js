// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PROBE_MAX_TOKENS, PROBE_TIMEOUT_MS, probeToken } from '../src/cli/probe.js';

/**
 * 假 `fetch`：只回一个够用的 `{status, text()}`。
 * 探测只读这两样，所以不需要真的构造 `Response`。
 * @param {number} status
 * @param {string} body
 * @param {{ onCall?: (url: string, init: any) => void }} [opts]
 */
function fakeFetch(status, body, opts = {}) {
  return /** @type {any} */ (async (url, init) => {
    opts.onCall?.(String(url), init);
    return { status, text: async () => body };
  });
}

/** @type {any} */
const BASE = { baseUrl: 'https://relay.example.com', secret: 'sk-****aaaa', model: 'claude-haiku-4-5-20251001' };

describe('probeToken：一次最小的真实请求', () => {
  test('2xx ⇒ ok，detail 只报状态码与耗时（正文一个字都不回显）', async () => {
    const r = await probeToken({
      ...BASE,
      fetchImpl: fakeFetch(200, '{"content":[{"type":"text","text":"pong"}]}'),
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.httpStatus, 200);
    assert.match(r.detail, /^HTTP 200 · \d+ms$/);
  });

  test('★ 请求打的是 /v1/messages（Anthropic 协议那条路）', async () => {
    /** @type {string | null} */
    let seen = null;
    await probeToken({
      ...BASE,
      fetchImpl: fakeFetch(200, '{}', { onCall: (url) => { seen = url; } }),
    });
    assert.equal(seen, 'https://relay.example.com/v1/messages');
  });

  test('★ baseUrl 已经带了 /v1 ⇒ 不拼成 /v1/v1（尾斜杠随缘）', async () => {
    /** @type {string | null} */
    let seen = null;
    await probeToken({
      ...BASE,
      baseUrl: 'https://relay.example.com/v1/', // 尾斜杠随缘
      fetchImpl: fakeFetch(200, '{}', { onCall: (url) => { seen = url; } }),
    });
    assert.equal(seen, 'https://relay.example.com/v1/messages');
  });

  test('请求体带模型名、极小输出上限，且只有协议要的那几个键', async () => {
    /** @type {any} */
    let init = null;
    await probeToken({
      ...BASE,
      fetchImpl: fakeFetch(200, '{}', { onCall: (_u, i) => { init = i; } }),
    });

    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer sk-****aaaa');
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
    assert.equal(body.max_tokens, PROBE_MAX_TOKENS);
    assert.equal(PROBE_MAX_TOKENS, 1, '输出上限必须是最小值——多点一个 token 就多一点钱');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'ping' }]);
    // 请求里不该出现任何"多要东西"的字段
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model']);
  });

  test('★★ authMode 决定认证头，而且**只发一个**（§2.6）', async () => {
    /** @type {any} */
    let tokenMode = null;
    await probeToken({
      ...BASE,
      fetchImpl: fakeFetch(200, '{}', { onCall: (_u, i) => { tokenMode = i; } }),
    });
    assert.equal(tokenMode.headers.Authorization, 'Bearer sk-****aaaa');
    assert.equal(tokenMode.headers['x-api-key'], undefined);

    /** @type {any} */
    let keyMode = null;
    await probeToken({
      ...BASE,
      authMode: 'key',
      fetchImpl: fakeFetch(200, '{}', { onCall: (_u, i) => { keyMode = i; } }),
    });
    assert.equal(keyMode.headers['x-api-key'], 'sk-****aaaa');
    assert.equal(keyMode.headers.Authorization, undefined);
    // 协议头照常在
    assert.equal(keyMode.headers['anthropic-version'], '2023-06-01');
  });

  test('402 ⇒ no_quota（协议级信号，比任何字符串都硬）', async () => {
    const r = await probeToken({ ...BASE, fetchImpl: fakeFetch(402, '{"error":{"message":"payment required"}}') });
    assert.equal(r.status, 'no_quota');
  });

  test('401 ⇒ invalid', async () => {
    const r = await probeToken({ ...BASE, fetchImpl: fakeFetch(401, '{"error":{"message":"invalid api key"}}') });
    assert.equal(r.status, 'invalid');
  });

  test('额度耗尽的措辞 ⇒ no_quota（各家中转站的写法不一样）', async () => {
    const r = await probeToken({
      ...BASE,
      fetchImpl: fakeFetch(403, '{"error":{"message":"insufficient_user_quota"}}'),
    });
    assert.equal(r.status, 'no_quota');
    assert.match(r.detail, /^HTTP 403 · /);
  });

  test('★ 429 只是限流 ⇒ other（仍参与候选，不判死到下个月）', async () => {
    const r = await probeToken({ ...BASE, fetchImpl: fakeFetch(429, '{"error":{"message":"rate limited"}}') });
    assert.equal(r.status, 'other');
  });

  test('★★ 网关把认证头原样写进错误体时，先打码再往外递', async () => {
    const r = await probeToken({
      ...BASE,
      fetchImpl: fakeFetch(401, '{"error":{"message":"bad key sk-****aaaa"}}'),
    });
    assert.ok(!r.detail.includes('sk-****aaaa'), `detail 里出现了密钥：${r.detail}`);
    assert.match(r.detail, /\*\*\*/);
  });

  test('端点不是 http(s) ⇒ other，而且**一个请求都不发**', async () => {
    let called = 0;
    const r = await probeToken({
      ...BASE,
      baseUrl: 'file:///etc/passwd',
      fetchImpl: /** @type {any} */ (async () => { called += 1; return { status: 200, text: async () => '' }; }),
    });
    assert.equal(r.status, 'other');
    assert.equal(called, 0);
    assert.equal(r.httpStatus, null);
    assert.match(r.detail, /不认识的协议/);
  });

  test('超时 ⇒ net_fail，并且消息里说清楚是几毫秒', async () => {
    /** @type {any} */
    const boom = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const r = await probeToken({ ...BASE, timeoutMs: 1234, fetchImpl: boom });
    assert.equal(r.status, 'net_fail');
    assert.match(r.detail, /1234 毫秒/);
  });

  test('连不上（不是超时）⇒ net_fail，原样保留系统给的那句话', async () => {
    /** @type {any} */
    const boom = async () => { throw new Error('getaddrinfo ENOTFOUND relay.example.com'); };
    const r = await probeToken({ ...BASE, fetchImpl: boom });
    assert.equal(r.status, 'net_fail');
    assert.match(r.detail, /ENOTFOUND/);
  });

  test('响应体不是 JSON ⇒ 压成一行塞进 detail，绝不留换行', async () => {
    const r = await probeToken({ ...BASE, fetchImpl: fakeFetch(502, 'Bad Gateway\n\nupstream\n') });
    assert.equal(r.status, 'other');
    assert.ok(!r.detail.includes('\n'));
    assert.match(r.detail, /Bad Gateway/);
  });

  test('空响应体也有话说', async () => {
    const r = await probeToken({ ...BASE, fetchImpl: fakeFetch(500, '') });
    assert.equal(r.status, 'other');
    assert.match(r.detail, /响应体是空的/);
  });

  test('detail 有长度上限（一行不能长到把表格撑爆）', async () => {
    const r = await probeToken({ ...BASE, fetchImpl: fakeFetch(500, 'x'.repeat(5000)) });
    assert.ok(r.detail.length <= 200, `detail 长 ${r.detail.length}`);
  });

  test('默认超时是 10 秒量级——不是无限等', () => {
    assert.ok(PROBE_TIMEOUT_MS >= 3000 && PROBE_TIMEOUT_MS <= 30000);
  });
});
