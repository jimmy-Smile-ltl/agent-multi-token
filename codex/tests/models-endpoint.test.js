// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { modelsUrl, parseModelsResponse } from '../src/core/models-endpoint.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/** OpenAI 官方 / one-api 形态 */
const OPENAI_STYLE = JSON.stringify({
  object: 'list',
  data: [
    { id: 'gpt-5.6-sol', object: 'model', created: 1700000000, owned_by: 'system' },
    { id: 'deepseek-v3', object: 'model', created: 1700000001, owned_by: 'system' },
  ],
});

/** 简化过的中转：data 里直接是字符串 */
const STRINGS_STYLE = JSON.stringify({ data: ['gpt-5.6-sol', 'deepseek-v3'] });

/** 裸数组 */
const BARE_STYLE = JSON.stringify(['gpt-5.6-sol', 'deepseek-v3']);

/**
 * @param {string} text
 * @returns {string[]}
 */
const idsOf = (text) => parseModelsResponse(text).ids;

/**
 * @param {string} text
 * @returns {string}
 */
const errOf = (text) => {
  const r = parseModelsResponse(text);
  assert.equal(r.error !== null, true, `本该报错，却给了 ids=${JSON.stringify(r.ids)}`);
  return /** @type {string} */ (r.error);
};

// ═══════════════ modelsUrl —— 尾斜杠去重 ═══════════════

describe('modelsUrl —— 拼 <baseUrl>/models', () => {
  test('★ 带不带尾斜杠、带几个，都得到同一个 URL', () => {
    const want = 'https://oneapi.example.com/v1/models';
    assert.equal(modelsUrl('https://oneapi.example.com/v1'), want);
    assert.equal(modelsUrl('https://oneapi.example.com/v1/'), want);
    assert.equal(modelsUrl('https://oneapi.example.com/v1///'), want);
  });

  test('★ 根路径的 baseUrl 不会被吃成相对路径', () => {
    // ⚠️ 这条守的是 `replace(/\/+$/, '')` 写错成 `replace(/\/+/, '')` 的经典 bug：
    //    那样 `https://x.com/` 会变成 `https:/x.com/models`，请求直接打错主机。
    assert.equal(modelsUrl('https://x.com'), 'https://x.com/models');
    assert.equal(modelsUrl('https://x.com/'), 'https://x.com/models');
  });

  test('前后空白不算地址的一部分', () => {
    assert.equal(modelsUrl('  https://x.com/v1  '), 'https://x.com/v1/models');
  });

  test('路径里（非末尾）的斜杠原样保留', () => {
    assert.equal(
      modelsUrl('https://gateway.example.com/api/openai/v1'),
      'https://gateway.example.com/api/openai/v1/models',
    );
  });

  test('★ baseUrl 为空 → 明确报错，并给出手敲 id 的出路', () => {
    assert.throws(() => modelsUrl(''), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.message, /baseUrl/);
      assert.match(err.hint, /\[m\]|手(动|敲)/);
      return true;
    });
    assert.throws(() => modelsUrl('   '), /baseUrl/);
    // @ts-expect-error 故意传错类型：纯函数对非字符串也要稳
    assert.throws(() => modelsUrl(undefined), /baseUrl/);
  });
});

// ═══════════════ parseModelsResponse —— 三种形态 ═══════════════

describe('parseModelsResponse —— 三种响应形态都认（§2.14 六）', () => {
  test('★★ OpenAI 官方形态：{ data: [{ id, ... }] }', () => {
    assert.deepEqual(idsOf(OPENAI_STYLE), ['gpt-5.6-sol', 'deepseek-v3']);
    assert.equal(parseModelsResponse(OPENAI_STYLE).error, null);
  });

  test('★★ 简化形态：{ data: ["id"] }', () => {
    assert.deepEqual(idsOf(STRINGS_STYLE), ['gpt-5.6-sol', 'deepseek-v3']);
  });

  test('★★ 裸数组：["id"]', () => {
    assert.deepEqual(idsOf(BARE_STYLE), ['gpt-5.6-sol', 'deepseek-v3']);
  });

  test('裸数组里是对象也认（第四种，顺手的事）', () => {
    assert.deepEqual(idsOf(JSON.stringify([{ id: 'a' }, { id: 'b' }])), ['a', 'b']);
  });

  test('混着来也认：字符串与对象同处一个数组', () => {
    assert.deepEqual(idsOf(JSON.stringify({ data: ['a', { id: 'b' }, 'c'] })), ['a', 'b', 'c']);
  });

  test('★ 顺序原样保留——它通常是"新到旧"，别自作主张排序', () => {
    assert.deepEqual(idsOf(JSON.stringify(['z', 'a', 'm'])), ['z', 'a', 'm']);
  });

  test('id 两侧的空白被去掉（服务端带出来的，不该进用户的优先级列表）', () => {
    assert.deepEqual(idsOf(JSON.stringify({ data: [{ id: '  a  ' }, ' b '] })), ['a', 'b']);
  });

  test('★ 重复 id 去重保序', () => {
    // 勾两次同一个 id 会得到一个"同一模型占两个优先级位"的列表，没有意义
    assert.deepEqual(idsOf(JSON.stringify(['a', 'b', 'a'])), ['a', 'b']);
  });

  test('★ 空列表是**合法回答**，不是错误（服务端说"我一个模型都没有"）', () => {
    const r = parseModelsResponse(JSON.stringify({ object: 'list', data: [] }));
    assert.deepEqual(r.ids, []);
    assert.equal(r.error, null, '★ 空的与认不出的必须分开——前者该让用户手敲，后者该报错');
  });

  test('列表之外的多余字段一概不看', () => {
    assert.deepEqual(
      idsOf(JSON.stringify({ object: 'list', has_more: false, data: [{ id: 'a', extra: { deep: 1 } }] })),
      ['a'],
    );
  });
});

// ═══════════════ parseModelsResponse —— 顺路捡到的价格（§2.13） ═══════════════

describe('parseModelsResponse —— 端点顺路报的价格', () => {
  /** 模仿 OpenRouter：每项带 `pricing`，单位是 USD / token 的**字符串** */
  const OPENROUTER_STYLE = JSON.stringify({
    data: [
      {
        id: 'claude-sonnet-4.5',
        pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
      },
      { id: 'no-price' },
      { id: 'half-price', pricing: { prompt: '0.000003' } },
      { id: 'negative', pricing: { prompt: '-1', completion: '0.000015' } },
    ],
  });

  test('★★ 有价就记下，转成 USD / 百万 token；没报价的**不进表**', () => {
    const { ids, pricing } = parseModelsResponse(OPENROUTER_STYLE);
    assert.deepEqual(ids, ['claude-sonnet-4.5', 'no-price', 'half-price', 'negative']);
    assert.deepEqual(Object.keys(pricing), ['claude-sonnet-4.5'],
      '★ 没报价 ≠ 免费：不进表，调用方才知道"不知道"');
    assert.deepEqual(pricing['claude-sonnet-4.5'],
      { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
      'cacheWrite 没报 → 按输入价');
  });

  test('★ 端点是 OpenAI 官方形态（没有 pricing）→ 空对象，不是 undefined', () => {
    // 调用方 `withFetchedModels(…, e.pricing)` 直接传下去；给 undefined 也能活，
    // 但"没有价格"这件事应当是一个**明确的值**，不是缺席。
    for (const t of [OPENAI_STYLE, STRINGS_STYLE, BARE_STYLE]) {
      assert.deepEqual(parseModelsResponse(t).pricing, {});
    }
  });

  test('★ 出错时 pricing 也是空对象——绝不把半份结果混进错误分支', () => {
    for (const t of ['', 'x', '{"error":"e"}', '{"data":[{"name":"a"}]}']) {
      const r = parseModelsResponse(t);
      if (r.error !== null) assert.deepEqual(r.pricing, {});
    }
  });

  test('只有 OpenRouter 的 `pricing` 被认；`price` / `cost` 这些自创字段一概不猜', () => {
    // 猜错的表现和 `idOf()` 那边一样：冒出一个**看着像真的**的数，
    // 而错的价格比没有价格更糟——用户会照着它做决定。
    const r = parseModelsResponse(JSON.stringify([
      { id: 'a', price: { input: 1, output: 2 } },
      { id: 'b', cost: '0.000003' },
      { id: 'c', input_price: 3 },
    ]));
    assert.deepEqual(r.pricing, {});
  });

  test('★ 重复 id：**第一次出现**定胜负（价格也不看后面那条）', () => {
    const r = parseModelsResponse(JSON.stringify([
      { id: 'a' },
      { id: 'a', pricing: { prompt: '0.000003', completion: '0.000015' } },
    ]));
    assert.deepEqual(r.ids, ['a']);
    assert.deepEqual(r.pricing, {}, '第一条没价 ⇒ 这个 id 就没价，别被后面那条补上');
  });

  test('pricing 是垃圾（null / 数组 / 字符串）→ 安静跳过，不影响 ids', () => {
    const r = parseModelsResponse(JSON.stringify([
      { id: 'a', pricing: null },
      { id: 'b', pricing: [] },
      { id: 'c', pricing: 'cheap' },
      { id: 'd', pricing: { prompt: '0.000001', completion: '0.000002' } },
    ]));
    assert.deepEqual(r.ids, ['a', 'b', 'c', 'd']);
    assert.deepEqual(Object.keys(r.pricing), ['d']);
  });
});

// ═══════════════ parseModelsResponse —— 失败要说清是哪一种 ═══════════════

describe('parseModelsResponse —— 失败必须给出原因', () => {
  test('★★ HTTP 200 的错误体：{ error: { message } }', () => {
    // ★ 中转站常见做法：网关转发成功（200），上游用错误 JSON 回话。
    //   不认这个的话，用户看到的是"该端点没有返回任何模型"——**而真因是 key 无效**。
    const e = errOf(JSON.stringify({
      error: { message: 'Invalid API key provided', type: 'invalid_request_error', code: 'invalid_api_key' },
    }));
    assert.match(e, /Invalid API key provided/);
  });

  test('★★ { error: "一句话" } 也认', () => {
    assert.match(errOf(JSON.stringify({ error: 'quota exceeded' })), /quota exceeded/);
  });

  test('★ 错误体形状认不出时，把 error 那一段原样抖出来（别只说"未知错误"）', () => {
    const e = errOf(JSON.stringify({ error: { code: 42, detail: '上游炸了' } }));
    assert.match(e, /上游炸了/);
  });

  test('★★ 不是 JSON → 给出原文开头（baseUrl 指错时最常见的是 HTML 登录页）', () => {
    const e = errOf('<!DOCTYPE html>\n<html>\n  <head><title>登录</title></head>');
    assert.match(e, /不是 JSON/);
    assert.match(e, /<!DOCTYPE html>/);
    assert.doesNotMatch(e, /\n/, '摘录必须压成一行——错误信息里不该出现换行');
  });

  test('★ 空响应体单独说（不是"不是 JSON"）', () => {
    assert.match(errOf(''), /空的/);
    assert.match(errOf('   \n  '), /空的/);
  });

  test('★ 是 JSON 但认不出列表形状 → 说清"没有 data 数组、本身也不是数组"', () => {
    assert.match(errOf(JSON.stringify({ object: 'list', models: [] })), /没有模型列表/);
    assert.match(errOf(JSON.stringify({ ok: true })), /没有模型列表/);
    assert.match(errOf('"just a string"'), /没有模型列表/);
    assert.match(errOf('null'), /没有模型列表/);
  });

  test('★ 有列表但一项都认不出 → 与"空列表"分开报（这是**我们**看不懂人家的形状）', () => {
    const e = errOf(JSON.stringify({ data: [{ name: 'a' }, { slug: 'b' }] }));
    assert.match(e, /2 项/);
    assert.match(e, /认得出模型 id/);
  });
  test('★ 只认 `id`，不猜 `name` / `model` / `slug`', () => {
    // 猜错的表现是往优先级列表里塞一个不存在的模型名，
    // 而那个错误要到 `cxt run` 时才由 Codex 报出来——离现场太远
    assert.deepEqual(idsOf(JSON.stringify([{ name: 'a' }, { model: 'b' }, { slug: 'c' }, { id: 'd' }])), ['d']);
  });

  test('列表里混着认不出的项：认出的照给，不报错', () => {
    assert.deepEqual(idsOf(JSON.stringify({ data: [{ id: 'a' }, null, 42, { id: '' }, { id: 'b' }] })), ['a', 'b']);
  });

  test('★ 非字符串输入不炸（调用方可能把 undefined 递进来）', () => {
    // @ts-expect-error 故意传错类型
    assert.equal(parseModelsResponse(undefined).error !== null, true);
    // @ts-expect-error 故意传错类型
    assert.deepEqual(parseModelsResponse(null).ids, []);
  });

  test('★ 出错时 ids 恒为空数组——要么给列表，要么给原因', () => {
    for (const t of ['', 'x', '{}', '{"error":"e"}', '{"data":[{"name":"a"}]}']) {
      const r = parseModelsResponse(t);
      if (r.error !== null) assert.deepEqual(r.ids, [], `error 非 null 时 ids 必须为空：${t}`);
    }
  });
});
