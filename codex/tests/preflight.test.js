// @ts-check
/**
 * ★ 启动前校验（§2.5）——**纯逻辑 + 注入的假 fetch**，一个网络包都不发。
 *
 * 真正"跑起来会不会把 `-c model=b` 递给 codex"那条链在
 * `tests/exec-e2e.test.js`（那里有个本地回环桩），这里只管**判断**：
 * 什么时候不该问、问了之后什么时候该换人、什么时候该闭嘴。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { preflightApplies, preflightModels } from '../src/cli/preflight.js';
import { SOURCE } from '../src/core/resolve.js';

// ───────────────────────────── 样本 ─────────────────────────────

const M = (id) => ({ id });

/** 一份"够用"的 resolved：只带 preflight 会碰的那几个键 */
function makeResolved(over = {}) {
  const models = over.models ?? [M('a'), M('b')];
  return {
    baseUrl: { value: 'https://relay.example.com/v1' },
    models: { value: models, source: SOURCE.TOKEN },
    model: { value: models[0] ?? null, source: SOURCE.TOKEN },
    envKeyName: 'CXT_TOKEN_RELAY_A',
    preflight: true,
    ...over,
  };
}

const injection = { env: { CXT_TOKEN_RELAY_A: 'sk-test-9999' } };

/** 假 fetch：`ids` 是端点要说的清单；`mode` 控制失败形态 */
function fakeFetch(ids, mode = 'ok') {
  /** @type {any[]} */
  const calls = [];
  const fn = async (/** @type {any} */ input) => {
    calls.push(input);
    if (mode === 'throw') throw new Error('ECONNREFUSED');
    if (mode === 'not-ok') return { ok: false, ids: [], status: 404, error: 'HTTP 404' };
    if (mode === 'empty') return { ok: true, ids: [], status: 200, error: null };
    return { ok: true, ids, status: 200, error: null };
  };
  return { fn, calls };
}

const ids = (/** @type {any} */ r) => r.models.value.map((/** @type {any} */ m) => m.id);

// ═══════════════════ 该不该问 ═══════════════════

describe('★ preflightApplies —— 什么时候连问都不问', () => {
  test('两项以上、没关、不是 --model → 问', () => {
    assert.equal(preflightApplies(makeResolved()), true);
  });

  test('★ 只有一项 → 不问（没有备选，问也换不了人）', () => {
    assert.equal(preflightApplies(makeResolved({ models: [M('a')] })), false);
  });

  test('空表 / 没声明 → 不问', () => {
    assert.equal(preflightApplies(makeResolved({ models: [] })), false);
    assert.equal(preflightApplies(makeResolved({ models: null })), false);
  });

  test('★ `defaults.preflight: false` → 不问（机器级总闸）', () => {
    assert.equal(preflightApplies(makeResolved({ preflight: false })), false);
  });

  test('★ `--model`（source === cli）→ 不问：那是用户这次点名要的', () => {
    const r = makeResolved({ model: { value: M('a'), source: SOURCE.CLI } });
    assert.equal(preflightApplies(r), false);
  });
});

// ═══════════════════ 问了之后 ═══════════════════

describe('★★ preflightModels —— 只读、只做一次、失败静默', () => {
  test('首位就在清单里 → 原对象、无提示', async () => {
    const r = makeResolved();
    const f = fakeFetch(['a', 'b']);
    const out = await preflightModels({ resolved: r, injection, fetch: f.fn });

    assert.equal(out.resolved, r, '没换人就必须返回**同一个**对象（身份相等）');
    assert.equal(out.note, null);
  });

  test('★ 第二位存在 → 旋转，note 说清换成了谁', async () => {
    const r = makeResolved();
    const f = fakeFetch(['b']);
    const out = await preflightModels({ resolved: r, injection, fetch: f.fn });

    assert.notEqual(out.resolved, r, '换了人就不能还是原来那个对象');
    assert.deepEqual(ids(out.resolved), ['b', 'a']);
    assert.equal(out.resolved.model.value.id, 'b');
    assert.equal(out.resolved.model.source, SOURCE.PREFLIGHT);
    assert.match(out.note ?? '', /a/);
    assert.match(out.note ?? '', /b/);
  });

  test('★ 换人时 `model.value` 与 `models.value[0]` 是同一个对象', async () => {
    const out = await preflightModels({ resolved: makeResolved(), injection, fetch: fakeFetch(['b']).fn });
    assert.equal(out.resolved.model.value, out.resolved.models.value[0]);
  });

  test('★★ 一个都不在 → 保持原样，但要说一句（这条不能静默）', async () => {
    const r = makeResolved();
    const out = await preflightModels({ resolved: r, injection, fetch: fakeFetch(['x', 'y']).fn });

    assert.equal(out.resolved, r);
    assert.deepEqual(ids(out.resolved), ['a', 'b']);
    assert.match(out.note ?? '', /没有 a/);
  });

  test('★ 不改入参', async () => {
    const r = makeResolved();
    await preflightModels({ resolved: r, injection, fetch: fakeFetch(['b']).fn });
    assert.deepEqual(ids(r), ['a', 'b']);
    assert.equal(r.model.value?.id, 'a');
  });

  // ── 静默的四条路：内网端点这是常态，喊了只会让人学会无视 ──

  test('★ 拉取抛错 → 静默', async () => {
    const r = makeResolved();
    const out = await preflightModels({ resolved: r, injection, fetch: fakeFetch([], 'throw').fn });
    assert.equal(out.resolved, r);
    assert.equal(out.note, null);
  });

  test('★ 端点报错（!ok）→ 静默', async () => {
    const out = await preflightModels({ resolved: makeResolved(), injection, fetch: fakeFetch([], 'not-ok').fn });
    assert.equal(out.note, null);
  });

  test('★ 拉到空清单 → 静默（"一项都没有"不是"你的模型没了"）', async () => {
    const out = await preflightModels({ resolved: makeResolved(), injection, fetch: fakeFetch([], 'empty').fn });
    assert.equal(out.note, null);
  });

  test('★ `enabled: false` → 连 fetch 都不调', async () => {
    const f = fakeFetch(['b']);
    const out = await preflightModels({ resolved: makeResolved(), injection, enabled: false, fetch: f.fn });
    assert.equal(f.calls.length, 0);
    assert.equal(out.note, null);
  });

  test('★ 只有一项 → 连 fetch 都不调', async () => {
    const f = fakeFetch(['b']);
    await preflightModels({ resolved: makeResolved({ models: [M('a')] }), injection, fetch: f.fn });
    assert.equal(f.calls.length, 0);
  });

  test('★ 环境里没有凭证（没求值）→ 不调 fetch，也不抛', async () => {
    const f = fakeFetch(['b']);
    const out = await preflightModels({ resolved: makeResolved(), injection: { env: {} }, fetch: f.fn });
    assert.equal(f.calls.length, 0);
    assert.equal(out.note, null);
  });

  test('baseUrl 为空 → 不调 fetch', async () => {
    const f = fakeFetch(['b']);
    await preflightModels({
      resolved: makeResolved({ baseUrl: { value: '' } }),
      injection,
      fetch: f.fn,
    });
    assert.equal(f.calls.length, 0);
  });
});

// ═══════════════════ 请求长什么样 ═══════════════════

describe('★ 请求参数：地址取 baseUrl、凭证取注入值、超时 2 秒', () => {
  test('baseUrl 与凭证原样传下去', async () => {
    const f = fakeFetch(['a']);
    await preflightModels({ resolved: makeResolved(), injection, fetch: f.fn });

    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].baseUrl, 'https://relay.example.com/v1');
    assert.equal(f.calls[0].authToken, 'sk-test-9999');
  });

  test('★★ 超时是 2000ms 而不是面板那 10 秒（每次启动都要付这个等待）', async () => {
    const f = fakeFetch(['a']);
    await preflightModels({ resolved: makeResolved(), injection, fetch: f.fn });
    assert.equal(f.calls[0].timeoutMs, 2000);
  });
});
