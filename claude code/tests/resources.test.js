// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MAX_MODELS,
  RESOURCES_VERSION,
  defaultResources,
  endpointPrices,
  modelOptionsFor,
  modelsFor,
  normalizeResources,
  withFetchedModels,
} from '../src/core/resources.js';
import { resourcesPath } from '../src/core/paths.js';
import { readResources, writeResources } from '../src/core/store.js';

/** @returns {string} */
function tempHome() {
  return mkdtempSync(join(tmpdir(), 'cmt-resources-'));
}

// ───────────────────────────── 读：宽容 ─────────────────────────────

describe('normalizeResources：永不抛，脏的丢掉', () => {
  test('不是对象 → 全默认（null / 数组 / 字符串 / 数字）', () => {
    for (const raw of [null, undefined, [], 'x', 42, true]) {
      assert.deepEqual(normalizeResources(raw), defaultResources());
    }
  });

  test('版本号永远被改写成当前版本', () => {
    assert.equal(normalizeResources({ version: 99 }).version, RESOURCES_VERSION);
  });

  test('tokens 不是对象 → 空表', () => {
    for (const tokens of [[], 'x', 3, null]) {
      assert.deepEqual(normalizeResources({ tokens }).tokens, {});
    }
  });

  test('某一条不是对象 → 只丢那一条，其余照常', () => {
    const r = normalizeResources({
      tokens: {
        good: { url: 'http://a', models: ['m1'], fetchedAt: 't' },
        bad1: null,
        bad2: [],
        bad3: 'str',
        good2: { models: ['m2'] },
      },
    });
    assert.deepEqual(Object.keys(r.tokens).sort(), ['good', 'good2']);
    assert.deepEqual(r.tokens.good2, { url: '', models: ['m2'], fetchedAt: '' });
  });

  test('models：非字符串 / 空串 / 空白 / 重复 全丢；顺序保持', () => {
    const r = normalizeResources({
      tokens: { a: { models: ['b', 3, '', '  ', 'a', 'b', null, 'c'] } },
    });
    assert.deepEqual(r.tokens.a.models, ['b', 'a', 'c']);
  });

  test('models 超过上限 → 截断到 MAX_MODELS', () => {
    const many = Array.from({ length: MAX_MODELS + 50 }, (_, i) => `m${i}`);
    const r = normalizeResources({ tokens: { a: { models: many } } });
    assert.equal(r.tokens.a.models.length, MAX_MODELS);
    assert.equal(r.tokens.a.models[MAX_MODELS - 1], `m${MAX_MODELS - 1}`);
  });

  test('url / fetchedAt 不是字符串 → 记成空串，但那条记录仍然留着', () => {
    const r = normalizeResources({ tokens: { a: { url: 9, models: ['m'], fetchedAt: 5 } } });
    assert.deepEqual(r.tokens.a, { url: '', models: ['m'], fetchedAt: '' });
  });

  test('空名字的条目丢掉', () => {
    const r = normalizeResources({ tokens: { '': { models: ['m'] } } });
    assert.deepEqual(r.tokens, {});
  });
});

// ───────────────────────────── 查 ─────────────────────────────

describe('modelsFor', () => {
  test('没有 / 形状不对 → []；有 → 副本（改它不影响登记）', () => {
    assert.deepEqual(modelsFor(defaultResources(), 'a'), []);
    assert.deepEqual(modelsFor(null, 'a'), []);
    assert.deepEqual(modelsFor({ tokens: { a: { models: 'x' } } }, 'a'), []);

    const r = withFetchedModels(defaultResources(), 'a', 'u', ['m1', 'm2']);
    const got = modelsFor(r, 'a');
    got.push('junk');
    assert.deepEqual(modelsFor(r, 'a'), ['m1', 'm2']);
  });
});

// ───────────────────────────── 写 ─────────────────────────────

describe('withFetchedModels：整份替换，不改入参', () => {
  test('记一条新 token', () => {
    const base = defaultResources();
    const r = withFetchedModels(base, 'relay-a', 'http://x/v1', ['m1', 'm2'], '2026-10-24T00:00:00.000Z');
    assert.deepEqual(r.tokens['relay-a'], {
      url: 'http://x/v1',
      models: ['m1', 'm2'],
      fetchedAt: '2026-10-24T00:00:00.000Z',
    });
    // 不改入参
    assert.deepEqual(base.tokens, {});
  });

  test('同一个 token 再拉一次 = 整份替换（不是追加）', () => {
    let r = withFetchedModels(defaultResources(), 'a', 'u1', ['m1', 'm2'], 't1');
    r = withFetchedModels(r, 'a', 'u2', ['m3'], 't2');
    assert.deepEqual(r.tokens.a, { url: 'u2', models: ['m3'], fetchedAt: 't2' });
  });

  test('脏的 models 被收干净；空名字 = 原样返回', () => {
    const r = withFetchedModels(defaultResources(), 'a', 'u', ['m', 'm', 3, '']);
    assert.deepEqual(r.tokens.a.models, ['m']);

    const same = withFetchedModels(r, '', 'u', ['m']);
    assert.deepEqual(same.tokens, r.tokens);
  });

  test('不给 now → fetchedAt 是空串（不偷偷用真实时钟）', () => {
    const r = withFetchedModels(defaultResources(), 'a', 'u', ['m']);
    assert.equal(r.tokens.a.fetchedAt, '');
  });

  test('传进来的 resources 本身是脏的也能写（先归一）', () => {
    const r = withFetchedModels(
      /** @type {any} */ ({ tokens: { old: 'junk' } }),
      'a', 'u', ['m'], 't',
    );
    assert.deepEqual(Object.keys(r.tokens), ['a']);
  });
});

// ───────────────────────────── 价格（可选键） ─────────────────────────────

/** @type {import('../src/core/prices.js').Price} */
const P = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 };

describe('pricing：端点顺路报的价（§2.13）', () => {
  test('★ 报了就存；**没报就整个键不存在**——不是空对象', () => {
    // 空对象会让读的人以为"问过了，没有"，而这个键缺省才是那个意思；
    // 也让落盘的 JSON 少一行噪音（绝大多数中转站根本不报价格）。
    const r = normalizeResources({
      tokens: {
        a: { models: ['m'], pricing: { m: P } },
        b: { models: ['n'] },
      },
    });
    assert.deepEqual(r.tokens.a.pricing, { m: P });
    assert.equal('pricing' in r.tokens.b, false);
  });

  test('坏条目逐个丢：缺 input/output 的、负价的、非对象；一条不剩就连键都不写', () => {
    const r = normalizeResources({
      tokens: {
        a: { models: ['m'], pricing: { ok: { input: 1, output: 2 }, bad: { input: 1 }, junk: 'x' } },
        b: { models: ['n'], pricing: { neg: { input: -1, output: 2 } } },
      },
    });
    assert.deepEqual(Object.keys(r.tokens.a.pricing), ['ok']);
    assert.equal('pricing' in r.tokens.b, false);
  });

  test('pricing 不是对象 → 丢掉它，条目本身留着', () => {
    for (const pricing of [[], 'x', 3, null]) {
      const r = normalizeResources({ tokens: { a: { models: ['m'], pricing } } });
      assert.deepEqual(r.tokens.a, { url: '', models: ['m'], fetchedAt: '' });
    }
  });

  test('价格表与清单共用 MAX_MODELS 上限（两份上限分开定只会漂移）', () => {
    /** @type {Record<string, { input: number, output: number }>} */
    const many = {};
    for (let i = 0; i < MAX_MODELS + 20; i++) many[`m${i}`] = { input: 1, output: 2 };
    const r = normalizeResources({ tokens: { a: { pricing: many } } });
    assert.equal(Object.keys(r.tokens.a.pricing).length, MAX_MODELS);
  });

  test('★★ withFetchedModels 带价写入；再拉一次没报价格 → 旧价**必须消失**', () => {
    let r = withFetchedModels(defaultResources(), 'a', 'u1', ['m'], 't1', { m: P });
    assert.deepEqual(r.tokens.a.pricing, { m: P });

    r = withFetchedModels(r, 'a', 'u2', ['m'], 't2');
    assert.equal('pricing' in r.tokens.a, false,
      '端点已经不再报价，还按老价算钱就是"涨了价却报旧账"');
  });

  test('withFetchedModels 的价格也被收干净；脏的一个字都进不去', () => {
    const r = withFetchedModels(defaultResources(), 'a', 'u', ['m'], 't',
      { m: P, bad: { input: 1 }, n: { input: 1, output: 2 } });
    assert.deepEqual(Object.keys(r.tokens.a.pricing), ['m', 'n']);
  });

  test('写盘 → 读回，价格还在（往返）', () => {
    const home = tempHome();
    try {
      const r = withFetchedModels(defaultResources(), 'a', 'u', ['m'], 't', { m: P });
      writeResources(home, r);
      assert.deepEqual(readResources(home).tokens.a.pricing, { m: P });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('endpointPrices —— 多个网关合成一张表', () => {
  test('★ 同名模型不同价：按 token 名字母序取第一个（规则简单且稳定）', () => {
    const r = normalizeResources({
      tokens: {
        zz: { pricing: { m: { input: 9, output: 9 } } },
        aa: { pricing: { m: { input: 1, output: 2 } } },
      },
    });
    assert.equal(endpointPrices(r).m.input, 1);
  });

  test('各网关的模型并起来', () => {
    const r = normalizeResources({
      tokens: {
        a: { pricing: { x: { input: 1, output: 1 } } },
        b: { pricing: { y: { input: 2, output: 2 } } },
      },
    });
    assert.deepEqual(Object.keys(endpointPrices(r)).sort(), ['x', 'y']);
  });

  test('没价 / 脏输入 / 空 → 空表，永不抛', () => {
    assert.deepEqual(endpointPrices(null), {});
    assert.deepEqual(endpointPrices(undefined), {});
    assert.deepEqual(endpointPrices({}), {});
    assert.deepEqual(endpointPrices({ tokens: 'x' }), {});
    assert.deepEqual(endpointPrices(defaultResources()), {});
  });
});

// ───────────────────────────── 下拉候选 ─────────────────────────────

describe('modelOptionsFor：已声明在前，缓存补后', () => {
  test('已声明的保持优先级顺序；缓存里剩下的按字母序补在后面', () => {
    const got = modelOptionsFor(['gpt-5', 'o3'], ['zz', 'gpt-5', 'aa', 'o3']);
    assert.deepEqual(got, ['gpt-5', 'o3', 'aa', 'zz']);
  });

  test('只有缓存 / 只有声明 / 都没有', () => {
    assert.deepEqual(modelOptionsFor([], ['b', 'a']), ['a', 'b']);
    assert.deepEqual(modelOptionsFor(['b', 'a'], []), ['b', 'a']);
    assert.deepEqual(modelOptionsFor([], []), []);
    assert.deepEqual(modelOptionsFor(undefined, undefined), []);
  });

  test('两边都有重复 → 只出现一次，且位置在声明那一段', () => {
    assert.deepEqual(modelOptionsFor(['a'], ['a', 'b']), ['a', 'b']);
  });

  test('合并后不超过 MAX_MODELS', () => {
    const declared = Array.from({ length: MAX_MODELS }, (_, i) => `d${i}`);
    const cached = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const got = modelOptionsFor(declared, cached);
    assert.equal(got.length, MAX_MODELS);
    assert.equal(got[0], 'd0');
  });

  test('脏输入被收干净', () => {
    assert.deepEqual(modelOptionsFor([3, '', ' a ', 'a'], [null, 'b']), ['a', 'b']);
  });
});

// ───────────────────────────── 落盘 ─────────────────────────────

describe('store：文件不存在不写盘，坏文件不硬报', () => {
  test('不存在 → 空表，且不创建文件', () => {
    const home = tempHome();
    try {
      assert.deepEqual(readResources(home), defaultResources());
      assert.throws(() => readFileSync(resourcesPath(home), 'utf8'), /ENOENT/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('写→读 往返', () => {
    const home = tempHome();
    try {
      const r = withFetchedModels(defaultResources(), 'relay-a', 'http://x/v1', ['m1'], 't1');
      writeResources(home, r);
      assert.deepEqual(readResources(home), r);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('★★ 坏 JSON 不抛，退回空表（与 config.json 故意不同）', () => {
    const home = tempHome();
    try {
      mkdirSync(join(home, '.claude-multi-token'), { recursive: true });
      writeFileSync(resourcesPath(home), '{ 这不是 JSON', 'utf8');
      assert.deepEqual(readResources(home), defaultResources());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('手改的脏形状读回来是干净的', () => {
    const home = tempHome();
    try {
      mkdirSync(join(home, '.claude-multi-token'), { recursive: true });
      writeFileSync(resourcesPath(home), JSON.stringify({
        version: 9,
        tokens: { a: { url: 'u', models: ['m', 'm', 3], fetchedAt: 't' }, b: 'junk' },
      }), 'utf8');
      const r = readResources(home);
      assert.deepEqual(Object.keys(r.tokens), ['a']);
      assert.deepEqual(r.tokens.a, { url: 'u', models: ['m'], fetchedAt: 't' });
      assert.equal(r.version, RESOURCES_VERSION);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
