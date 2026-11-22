// @ts-check
/**
 * `cmt usage` / 用量归集（§2.13）。
 *
 * 这个文件盯的是**两类会静默算错钱的东西**：
 *
 *   1. **去重**。claude 的 transcript 里同一条 assistant 消息会重复落盘
 *      （实测 33,895 行只有 5,844 个不同的 `message.id`）。不去重就是凭空翻倍，
 *      而且报表看起来完全正常。
 *   2. **`input_tokens` 的语义**。Claude 不含缓存、Codex 含缓存。
 *      两边照抄字段名的话，一条偏高、一条偏低，同样看不出来。
 *
 * 时间戳一律写成**不带 Z** 的本地时间（`2026-10-20T10:00:00.000`），
 * 这样 `dayOf()` 落到哪一天与时区无关，断言才能在任何机器上成立。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  claudeFromLines,
  codexFromLines,
  codexTokens,
  cutoffDay,
  dayOf,
  groupEntries,
  sinceEntries,
  tagToken,
  totalOf,
  zeroTokens,
} from '../src/core/usage.js';
import {
  costOf,
  normalizePriceTable,
  priceFor,
  priceFromEndpoint,
} from '../src/core/prices.js';

const BIN = fileURLToPath(new URL('../bin/cmt.js', import.meta.url));

// ═══════════════════════ 夹具 ═══════════════════════

/**
 * 一行 claude 的 assistant transcript。
 * @param {{ id?: string, model?: string, ts?: string, cwd?: string,
 *           input?: number, cacheRead?: number, cacheWrite?: number, output?: number }} [o]
 */
function claudeLine(o = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: o.ts ?? '2026-10-20T10:00:00.000',
    cwd: o.cwd ?? 'C:/work/a',
    message: {
      id: o.id ?? 'msg_1',
      model: o.model ?? 'm-a',
      usage: {
        input_tokens: o.input ?? 10,
        cache_read_input_tokens: o.cacheRead ?? 0,
        cache_creation_input_tokens: o.cacheWrite ?? 0,
        output_tokens: o.output ?? 5,
      },
    },
  });
}

/** @param {string} [cwd] */
const codexMeta = (cwd = 'C:/work/b') =>
  JSON.stringify({ type: 'session_meta', timestamp: '2026-10-20T09:00:00.000', payload: { cwd } });

/**
 * **本地**时间的 ISO 串（不带 Z）。
 *
 * `--days` 的窗口是拿"今天"算的，所以凡是断言窗口的夹具都不能写死日期——
 * 每过一天就红一次。写成带 Z 的 UTC 串也不行：`dayOf()` 按本地日历落天，
 * 在东八区的深夜里会落到明天。
 * @param {Date} d
 */
function localIso(d) {
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`;
}

/**
 * @param {string} turnId
 * @param {string} model
 * @param {string} cwd
 */
const codexTurn = (turnId, model, cwd) =>
  JSON.stringify({ type: 'turn_context', timestamp: '2026-10-20T09:00:01.000', payload: { turn_id: turnId, model, cwd } });

/**
 * @param {string} turnId
 * @param {string} ts
 * @param {Record<string, number>} u
 */
const codexRec = (turnId, ts, u) =>
  JSON.stringify({ type: 'token_usage_record', timestamp: ts, payload: { turn_id: turnId, usage: u } });

/**
 * @param {string} ts
 * @param {Record<string, number>} total
 */
const codexCount = (ts, total) =>
  JSON.stringify({ type: 'event_msg', timestamp: ts, payload: { type: 'token_count', info: { total_token_usage: total } } });

/** 一整套 codex 字段 */
const full = (/** @type {Record<string, number>} */ u) => ({
  input_tokens: u.input ?? 0,
  cached_input_tokens: u.cached ?? 0,
  cache_write_input_tokens: u.write ?? 0,
  output_tokens: u.output ?? 0,
  reasoning_output_tokens: u.reasoning ?? 0,
  total_tokens: (u.input ?? 0) + (u.output ?? 0),
});

// ═══════════════════════ dayOf ═══════════════════════

describe('dayOf —— 本地日期', () => {
  test('本地时间戳 → 当天', () => {
    assert.equal(dayOf('2026-10-20T23:59:59.000'), '2026-10-20');
    assert.equal(dayOf('2026-01-05T00:00:00.000'), '2026-01-05');
  });

  test('★ 用**本地**日期：带 Z 的时间戳按本机时区落到那一天', () => {
    const iso = '2026-10-20T12:00:00.000Z';
    assert.equal(dayOf(iso), dayOf(new Date(iso).toISOString()));
    assert.match(dayOf(iso), /^\d{4}-\d{2}-\d{2}$/);
  });

  test('解析不了 / 不是字符串 → 空串（调用方归入"日期未知"）', () => {
    assert.equal(dayOf(''), '');
    assert.equal(dayOf('不是时间'), '');
    assert.equal(dayOf(undefined), '');
    assert.equal(dayOf(12345), '');
  });
});

// ═══════════════════════ Claude ═══════════════════════

describe('claudeFromLines', () => {
  test('基本累计：四项照搬（Claude 的 input 不含缓存）', () => {
    const r = claudeFromLines([
      claudeLine({ id: 'a', input: 100, cacheRead: 20, cacheWrite: 5, output: 7 }),
    ]);
    assert.equal(r.entries.length, 1);
    assert.deepEqual(r.entries[0].tokens, { input: 100, cacheRead: 20, cacheWrite: 5, output: 7 });
    assert.equal(r.entries[0].day, '2026-10-20');
    assert.equal(r.entries[0].model, 'm-a');
  });

  test('★ 同一条数据合并成一行（同 day/model/project）', () => {
    const r = claudeFromLines([
      claudeLine({ id: 'a', input: 10 }),
      claudeLine({ id: 'b', input: 10 }),
    ]);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].tokens.input, 20);
  });

  test('★★ 同 `message.id` 重复落盘 → 只算一次（不去重就是凭空翻倍）', () => {
    const r = claudeFromLines([
      claudeLine({ id: 'dup', input: 100, output: 50 }),
      claudeLine({ id: 'dup', input: 100, output: 50 }),
      claudeLine({ id: 'dup', input: 100, output: 50 }),
    ]);
    assert.equal(r.entries[0].tokens.input, 100, '三次落盘只能算一次');
    assert.equal(r.entries[0].tokens.output, 50);
    assert.equal(r.stats.duplicates, 2);
  });

  test('去重是**按 id**、不是按内容：不同 id 同样内容要各算各的', () => {
    const r = claudeFromLines([claudeLine({ id: 'x' }), claudeLine({ id: 'y' })]);
    assert.equal(r.entries[0].tokens.input, 20);
  });

  test('`<synthetic>` 是记账用的假消息，不计', () => {
    const r = claudeFromLines([claudeLine({ id: 's', model: '<synthetic>' })]);
    assert.equal(r.entries.length, 0);
  });

  test('全零 usage 不计（存在但没有量）', () => {
    const r = claudeFromLines([
      claudeLine({ id: 'z', input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }),
    ]);
    assert.equal(r.entries.length, 0);
  });

  test('非 assistant 行（user / 系统）一律不计，也不报 noUsage', () => {
    const r = claudeFromLines([
      JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:00:00.000', cwd: 'C:/work/a' }),
    ]);
    assert.equal(r.entries.length, 0);
    assert.equal(r.stats.noUsage, 0);
  });

  test('★ cwd 在文件内**向上继承**——没带 cwd 的行跟着最近一次见到的走', () => {
    // 这一行（assistant）自己**没有 cwd**，全靠前面那条 user 行留下的线索。
    const assistantNoCwd = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-20T10:00:05.000',
      message: {
        id: 'a',
        model: 'm-a',
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    const r = claudeFromLines([
      JSON.stringify({ type: 'user', timestamp: '2026-10-20T10:00:00.000', cwd: 'C:/work/a' }),
      assistantNoCwd,
    ]);
    assert.equal(r.entries[0].project, 'C:/work/a', '没有 cwd 不等于"未知目录"');
  });

  test('坏 JSON 不炸，计入 badJson，后面的行照常算', () => {
    const r = claudeFromLines(['{ 这不是 json', claudeLine({ id: 'ok', input: 3 })]);
    assert.equal(r.stats.badJson, 1);
    assert.equal(r.entries[0].tokens.input, 3);
  });

  test('空行跳过', () => {
    const r = claudeFromLines(['', '', claudeLine({ id: 'a' })]);
    assert.equal(r.stats.lines, 1);
  });

  test('负数 / 非数字的 usage 记 0，绝不把总额拉成负的', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-20T10:00:00.000',
      cwd: 'C:/work/a',
      message: {
        id: 'neg',
        model: 'm',
        usage: { input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: 3 },
      },
    });
    const r = claudeFromLines([line]);
    assert.deepEqual(r.entries[0].tokens, { input: 0, cacheRead: 3, cacheWrite: 0, output: 0 });
  });
});

// ═══════════════════════ Codex ═══════════════════════

describe('codexTokens —— ★★ input 含缓存，必须剥掉', () => {
  test('input = 原始 input − cached − cacheWrite', () => {
    const t = codexTokens(full({ input: 1000, cached: 800, write: 100, output: 50 }));
    assert.deepEqual(t, { input: 100, cacheRead: 800, cacheWrite: 100, output: 50 });
  });

  test('★ 换算后四项之和 == provider 的 total_tokens（口径没有漂移）', () => {
    const u = full({ input: 1000, cached: 800, write: 100, output: 50 });
    assert.equal(totalOf(codexTokens(u)), u.total_tokens);
  });

  test('reasoning_output_tokens 是 output 的子集，**不加**', () => {
    const t = codexTokens(full({ input: 10, output: 50, reasoning: 30 }));
    assert.equal(t.output, 50, 'output 原样——reasoning 已经在里面了');
    assert.equal(totalOf(t), 60);
  });

  test('缓存之和反常地超过 input → input 记 0，不出负数', () => {
    const t = codexTokens({ input_tokens: 10, cached_input_tokens: 1000, output_tokens: 0 });
    assert.equal(t.input, 0);
    assert.equal(t.cacheRead, 1000);
  });
});

describe('codexFromLines', () => {
  test('有 token_usage_record → 逐条求和，并按 turn 归到各自日期与模型', () => {
    const r = codexFromLines([
      codexMeta(),
      codexTurn('t1', 'gpt-5', 'C:/work/b'),
      codexRec('t1', '2026-10-20T10:00:00.000', full({ input: 100, output: 10 })),
      codexTurn('t2', 'gpt-6', 'C:/work/b'),
      codexRec('t2', '2026-10-21T10:00:00.000', full({ input: 200, output: 20 })),
    ]);

    assert.equal(r.entries.length, 2, '两个 turn、两天、两个模型 ⇒ 两条');
    const byDay = Object.fromEntries(r.entries.map((e) => [e.day, e]));
    assert.equal(byDay['2026-10-20'].tokens.input, 100);
    assert.equal(byDay['2026-10-20'].model, 'gpt-5');
    assert.equal(byDay['2026-10-21'].tokens.input, 200);
    assert.equal(byDay['2026-10-21'].model, 'gpt-6');
  });

  test('★ 只有累计的 token_count → 退回"取最后一条"，整段归到那个时间点', () => {
    const r = codexFromLines([
      codexMeta(),
      codexTurn('t1', 'gpt-5', 'C:/work/b'),
      codexCount('2026-10-20T10:00:00.000', full({ input: 100, output: 10 })),
      codexCount('2026-10-20T11:00:00.000', full({ input: 500, output: 50 })),
    ]);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].tokens.input, 500, '★ 累计值只能取最后一条，不能相加');
    assert.equal(r.entries[0].day, '2026-10-20');
    assert.equal(r.entries[0].project, 'C:/work/b');
  });

  test('★★ 两种记录都在时**不叠加**（实测两者逐字段相等）', () => {
    const u = full({ input: 100, output: 10 });
    const r = codexFromLines([
      codexMeta(),
      codexTurn('t1', 'gpt-5', 'C:/work/b'),
      codexRec('t1', '2026-10-20T10:00:00.000', u),
      codexCount('2026-10-20T10:00:00.000', u),
    ]);
    assert.equal(r.entries[0].tokens.input, 100, '用 record 就不再看 count');
  });

  test('cwd 只在 session_meta 里也能落到每条记录上', () => {
    const r = codexFromLines([
      codexMeta('C:/only/meta'),
      codexRec('t9', '2026-10-20T10:00:00.000', full({ input: 5 })),
    ]);
    assert.equal(r.entries[0].project, 'C:/only/meta');
  });

  test('空文件 → 没有记录，也不抛', () => {
    const r = codexFromLines([]);
    assert.deepEqual(r.entries, []);
  });

  test('坏 JSON 跳过', () => {
    const r = codexFromLines(['{坏', codexMeta(), codexRec('t', '2026-10-20T10:00:00.000', full({ input: 1 }))]);
    assert.equal(r.stats.badJson, 1);
    assert.equal(r.entries.length, 1);
  });
});

// ═══════════════════════ 分组 ═══════════════════════

const E = (/** @type {Partial<import('../src/core/usage.js').UsageEntry> & {token?: string}} */ o) => ({
  day: o.day ?? '2026-10-20',
  model: o.model ?? 'm-a',
  project: o.project ?? 'C:/work/a',
  tokens: o.tokens ?? { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 },
  ...(o.token === undefined ? {} : { token: o.token }),
});

describe('groupEntries', () => {
  test('按 token / model / day 分组', () => {
    const entries = tagToken([E({ token: undefined })], 'relay-a');
    assert.equal(groupEntries(entries, 'token')[0].key, 'relay-a');
    assert.equal(groupEntries([E({ model: 'x' })], 'model')[0].key, 'x');
    assert.equal(groupEntries([E({ day: '2026-01-01' })], 'day')[0].key, '2026-01-01');
  });

  test('★ 按总量降序——最花钱的永远在最上面', () => {
    const g = groupEntries([
      E({ model: 'small', tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 } }),
      E({ model: 'big', tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    ], 'model');
    assert.deepEqual(g.map((x) => x.key), ['big', 'small']);
  });

  test('组里带着原始记录（算花费要逐条查价）', () => {
    const g = groupEntries([E({ model: 'x' }), E({ model: 'x' })], 'model');
    assert.equal(g[0].entries.length, 2);
  });

  test('★ 项目路径按平台归一：Windows 上大小写不同是同一个项目，展示保留首见写法', () => {
    const entries = [E({ project: 'C:\\Work\\A' }), E({ project: 'c:/work/a' })];
    const win = groupEntries(entries, 'project', { platform: 'win32' });
    assert.equal(win.length, 1);
    assert.equal(win[0].key, 'C:\\Work\\A', '展示用首次出现的写法');

    const posix = groupEntries(entries, 'project', { platform: 'linux' });
    assert.equal(posix.length, 2, 'POSIX 上大小写是两个目录');
  });

  test('空键落进"未知"，不丢记录', () => {
    const g = groupEntries([E({ model: '' })], 'model');
    assert.equal(g[0].key, '（未知模型）');
  });
});

describe('tagToken', () => {
  test('不改入参，返回带 token 的副本', () => {
    const src = [E({})];
    const out = tagToken(src, 'relay-a');
    assert.equal(/** @type {any} */ (src[0]).token, undefined);
    assert.equal(/** @type {any} */ (out[0]).token, 'relay-a');
    assert.deepEqual(out[0].tokens, src[0].tokens);
  });
});

describe('cutoffDay / sinceEntries', () => {
  test('--days 1 = 今天；--days 7 = 含今天往前 7 天', () => {
    const now = new Date(2026, 9, 25); // 2026-10-25 本地
    assert.equal(cutoffDay(1, now), '2026-10-25');
    assert.equal(cutoffDay(7, now), '2026-10-19');
    assert.equal(cutoffDay(0, now), '', '0 = 不限');
  });

  test('跨月/跨年也算得对', () => {
    assert.equal(cutoffDay(3, new Date(2026, 0, 1)), '2025-12-30');
  });

  test('窗口外的丢掉，日期未知的**保留**', () => {
    const out = sinceEntries([
      E({ day: '2026-10-18' }), E({ day: '2026-10-20' }), E({ day: '' }),
    ], '2026-10-19');
    assert.deepEqual(out.map((e) => e.day), ['2026-10-20', '']);
  });

  test('cutoff 为空串 → 原样返回', () => {
    const src = [E({ day: '2000-01-01' })];
    assert.equal(sinceEntries(src, ''), src);
  });
});

// ═══════════════════════ 价格 ═══════════════════════

describe('normalizePriceTable', () => {
  test('接受 {models:{…}} 与裸表两种写法', () => {
    const a = normalizePriceTable({ models: { m: { input: 3, output: 15 } } });
    assert.equal(a.models.m.input, 3);
    const b = normalizePriceTable({ m: { input: 3, output: 15 } });
    assert.equal(b.models.m.input, 3);
  });

  test('cacheRead / cacheWrite 缺省 → 按 input 算（保守：往高了估）', () => {
    const t = normalizePriceTable({ models: { m: { input: 3, output: 15 } } });
    assert.equal(t.models.m.cacheRead, 3);
    assert.equal(t.models.m.cacheWrite, 3);
  });

  test('显式给了缓存价就用它', () => {
    const t = normalizePriceTable({ models: { m: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } });
    assert.equal(t.models.m.cacheRead, 0.3);
  });

  test('缺 input 或 output → 跳过并记一条 problem，不抛', () => {
    const t = normalizePriceTable({ models: { bad: { input: 3 }, alsoBad: {}, good: { input: 1, output: 2 } } });
    assert.deepEqual(Object.keys(t.models), ['good']);
    assert.equal(t.problems.length, 2);
  });

  test('负价（OpenRouter 的 -1）不算价格', () => {
    const t = normalizePriceTable({ models: { m: { input: -1, output: 15 } } });
    assert.deepEqual(Object.keys(t.models), []);
  });

  test('不是对象 → 一条 problem，空表', () => {
    assert.deepEqual(normalizePriceTable(null).models, {});
    assert.equal(normalizePriceTable('x').problems.length, 1);
  });
});

describe('priceFor', () => {
  const table = normalizePriceTable({
    models: {
      exact: { input: 1, output: 2 },
      'sonnet-*': { input: 3, output: 15 },
      'sonnet-4-5*': { input: 4, output: 20 },
      'orphan-*': { input: 9, output: 9 },
    },
  });

  test('精确匹配优先', () => {
    assert.equal(priceFor(table, 'exact').input, 1);
  });

  test('★ 通配取**最长前缀**——通用兜底不该压过专用那条', () => {
    assert.equal(priceFor(table, 'sonnet-4-5-2026').input, 4);
    assert.equal(priceFor(table, 'sonnet-3').input, 3);
  });

  test('一个都不匹配 → null（不是 0）', () => {
    assert.equal(priceFor(table, 'nope'), null);
    assert.equal(priceFor(table, ''), null);
  });

  test('接受裸表', () => {
    assert.equal(priceFor({ m: { input: 5, output: 6 } }, 'm').input, 5);
  });
});

describe('costOf', () => {
  const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

  test('按百万 token 折算', () => {
    const cost = costOf({ input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 }, price);
    assert.equal(cost, 3);
  });

  test('四档各按各的价', () => {
    const cost = costOf({ input: 0, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 }, price);
    assert.equal(cost, 0.3 + 15);
  });

  test('★ 没有价格 → null，**不是 0**（0 会渲染成"免费"）', () => {
    assert.equal(costOf({ input: 1e9, cacheRead: 0, cacheWrite: 0, output: 0 }, null), null);
  });

  test('零用量 = 0 元（这个 0 是真的）', () => {
    assert.equal(costOf(zeroTokens(), price), 0);
  });
});

describe('priceFromEndpoint —— OpenRouter 形态', () => {
  test('每 token 的**字符串** → 每百万；小数尾巴要抹干净', () => {
    const p = priceFromEndpoint({ prompt: '0.000003', completion: '0.000015' });
    assert.equal(p.input, 3);
    assert.equal(p.output, 15);
  });

  test('缓存两项有就给，没有按输入价', () => {
    const a = priceFromEndpoint({
      prompt: '0.000003', completion: '0.000015',
      input_cache_read: '0.0000003', input_cache_write: '0.00000375',
    });
    assert.equal(a.cacheRead, 0.3);
    assert.equal(a.cacheWrite, 3.75);

    const b = priceFromEndpoint({ prompt: '0.000002', completion: '0.00001' });
    assert.equal(b.cacheRead, 2);
  });

  test('★ 缺 prompt 或 completion → 整条不算（半份价格比没有更危险）', () => {
    assert.equal(priceFromEndpoint({ completion: '0.000015' }), null);
    assert.equal(priceFromEndpoint({ prompt: '0.000003' }), null);
    assert.equal(priceFromEndpoint(null), null);
  });

  test('负数（按调用计价的标记）不算价格', () => {
    const p = priceFromEndpoint({ prompt: '0.000003', completion: '0.000015', input_cache_read: '-1' });
    assert.equal(p.cacheRead, 3, '回退到输入价');
  });
});

// ═══════════════════════ CLI 端到端 ═══════════════════════

/** @type {string[]} */
const ROOTS = [];
after(() => {
  for (const r of ROOTS) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch { /* 删不掉就算了 */ }
  }
});

/**
 * `resources.json` 里带着**端点自报价**的样子（拉清单时顺手记下的，§2.13）。
 * 与 `prices.json` 的区别只在来源：这张表是自动采集的，用户没写过任何一个字。
 */
const RESOURCES_WITH_PRICES = {
  version: 1,
  tokens: {
    'relay-a': {
      url: 'https://gateway.example.com/v1',
      models: ['m-a'],
      fetchedAt: '2026-10-24T00:00:00.000Z',
      pricing: { 'm-a': { input: 3, output: 15, cacheRead: 3, cacheWrite: 3 } },
    },
  },
};

/**
 * 假 home + 若干 transcript。
 * @param {{ lines?: string[], token?: string, prices?: unknown, resources?: unknown }} [o]
 */
function makeHome(o = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cmt-usage-'));
  ROOTS.push(root);
  const home = join(root, 'home');
  const app = join(home, '.claude-multi-token');
  const token = o.token ?? 'relay-a';
  const dir = join(app, 'profiles', token, 'projects', 'C--work-a');
  mkdirSync(dir, { recursive: true });

  const lines = o.lines ?? [claudeLine({ id: 'a', input: 1_000_000, output: 1_000_000 })];
  writeFileSync(join(dir, 'sess.jsonl'), lines.join('\n') + '\n', 'utf8');

  if (o.prices !== undefined) {
    writeFileSync(join(app, 'prices.json'), JSON.stringify(o.prices, null, 2), 'utf8');
  }

  if (o.resources !== undefined) {
    writeFileSync(join(app, 'resources.json'), JSON.stringify(o.resources, null, 2), 'utf8');
  }

  return {
    root,
    home,
    app,
    run(/** @type {string[]} */ argv) {
      try {
        const stdout = execFileSync(process.execPath, [BIN, ...argv], {
          encoding: 'utf8',
          cwd: root,
          env: { ...process.env, HOME: home, USERPROFILE: home },
        });
        return { code: 0, stdout, stderr: '' };
      } catch (err) {
        const e = /** @type {any} */ (err);
        return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    },
  };
}

describe('cmt usage —— 端到端', () => {
  test('★ 有价格表 → 花费真的算出来', () => {
    const h = makeHome({ prices: { models: { 'm-a': { input: 3, output: 15 } } } });
    const r = h.run(['usage', '--days', 'all']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\$18\.00/, '100 万输入 @3 + 100 万输出 @15 = 18');
  });

  test('★★ 没有价格表 → 花费是「—」，**绝不是 $0**', () => {
    const h = makeHome();
    const r = h.run(['usage', '--days', 'all']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /—/);
    assert.doesNotMatch(r.stdout, /\$0\b/);
    assert.match(r.stdout, /没有价格/, '要说清为什么算不出钱，并给出下一步');
  });

  test('★★ 端点自报价也能算钱（用户一个字没写）', () => {
    // 这是 `/models` 拉清单的**第二个用处**：OpenRouter 形态的响应里本来就带 price，
    // 顺路记进 resources.json，`usage` 就不用逼用户手抄一份价格表。
    const h = makeHome({ resources: RESOURCES_WITH_PRICES });
    const r = h.run(['usage', '--days', 'all', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.equal(o.total.cost, 18, '100 万 @3 + 100 万 @15');
    assert.equal(o.endpointPrices, 1, '要说清有几个模型用了端点价');
    assert.equal(o.pricesFile, null, '★ 没有 prices.json，别报成用上了它');
  });

  test('★★ prices.json 压过端点价（用户写的结算价不能被挂牌价盖掉）', () => {
    const h = makeHome({
      resources: RESOURCES_WITH_PRICES, // 端点价 → $18
      prices: { models: { 'm-a': { input: 1, output: 6 } } }, // 用户价 → $7
    });
    const o = JSON.parse(h.run(['usage', '--days', 'all', '--json']).stdout);
    assert.equal(o.total.cost, 7);
    assert.equal(o.endpointPrices, 0, '被用户价覆盖的那些**不算**用上了端点价');
    assert.ok(o.pricesFile, '用户的表确实被用上了');
  });

  test('★ resources.json 坏了 → 只是没有价格，不报错', () => {
    // 它是可丢弃的重建缓存（§3.4）；它坏只该让花费那列变回「—」，
    // 不该让整份用量报表打不开。
    const h = makeHome();
    writeFileSync(join(h.app, 'resources.json'), '{ 这不是 JSON', 'utf8');
    const r = h.run(['usage', '--days', 'all']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /—/);
    assert.match(r.stdout, /没有价格/);
  });

  test('--json 的形状稳定', () => {
    const h = makeHome({ prices: { models: { 'm-a': { input: 3, output: 15 } } } });
    const r = h.run(['usage', '--days', 'all', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const o = JSON.parse(r.stdout);

    assert.equal(o.agent, 'claude-code');
    assert.equal(o.by, 'token');
    assert.equal(o.groups[0].key, 'relay-a');
    assert.equal(o.groups[0].total, 2_000_000);
    assert.equal(o.groups[0].cost, 18);
    assert.equal(o.groups[0].complete, true);
    assert.equal(o.total.total, 2_000_000);
    assert.ok(o.sources.some((/** @type {any} */ s) => s.token === 'relay-a' && s.files === 1));
  });

  test('--by project / model / day 都能跑', () => {
    const h = makeHome();
    for (const by of ['project', 'model', 'day']) {
      const r = h.run(['usage', '--days', 'all', '--by', by, '--json']);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).by, by);
    }
  });

  test('未知的 --by → 退出码 1，并列出可用维度', () => {
    const h = makeHome();
    const r = h.run(['usage', '--by', 'nonsense']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /token/);
  });

  test('窗口过滤：旧记录被排除', () => {
    const h = makeHome({
      lines: [
        claudeLine({ id: 'old', ts: '2020-01-01T10:00:00.000', input: 100 }),
        // ★ 用"现在"而不是写死的日期——窗口是拿今天算的，写死就每天红一次。
        claudeLine({ id: 'new', ts: localIso(new Date()), input: 1 }),
      ],
    });
    const all = JSON.parse(h.run(['usage', '--days', 'all', '--json']).stdout);
    const recent = JSON.parse(h.run(['usage', '--days', '1', '--json']).stdout);
    assert.equal(all.total.total, 111, '两条都要算：100 输入 + 5 输出，1 输入 + 5 输出');
    assert.equal(recent.total.total, 6, '--days 1 不该包含 2020 年那条');
  });

  test('★ 只读：不碰 config.json / tokens，只写自己的 usage-cache.json', () => {
    const h = makeHome();
    const before = readFileSync(join(h.app, 'profiles', 'relay-a', 'projects', 'C--work-a', 'sess.jsonl'), 'utf8');
    h.run(['usage', '--days', 'all']);

    assert.equal(
      readFileSync(join(h.app, 'profiles', 'relay-a', 'projects', 'C--work-a', 'sess.jsonl'), 'utf8'),
      before,
      'transcript 不许改',
    );
    const cache = JSON.parse(readFileSync(join(h.app, 'usage-cache.json'), 'utf8'));
    assert.equal(cache.version, 1);
    assert.equal(Object.keys(cache.files).length, 1);
  });

  test('★ 缓存命中：transcript 没变时不重新解析（缓存里的条目原样复用）', () => {
    const h = makeHome();
    h.run(['usage', '--days', 'all']);
    const first = JSON.parse(readFileSync(join(h.app, 'usage-cache.json'), 'utf8'));

    const r = h.run(['usage', '--days', 'all', '--json']);
    const second = JSON.parse(readFileSync(join(h.app, 'usage-cache.json'), 'utf8'));

    assert.deepEqual(second, first, '没变就不该重写缓存');
    assert.equal(JSON.parse(r.stdout).total.total, 2_000_000, '缓存读出来的数要和第一次一致');
  });

  test('★ 内容变了 → 重新解析，数字跟着变', () => {
    const h = makeHome();
    h.run(['usage', '--days', 'all']);
    // 追加一条新的（transcript 是追加写的）
    const f = join(h.app, 'profiles', 'relay-a', 'projects', 'C--work-a', 'sess.jsonl');
    writeFileSync(f, readFileSync(f, 'utf8') + claudeLine({ id: 'b', input: 1_000_000, output: 0 }) + '\n', 'utf8');

    const r = h.run(['usage', '--days', 'all', '--json']);
    assert.equal(JSON.parse(r.stdout).total.total, 3_000_000);
  });

  test('完全没有 transcript → 说清楚找过哪里，退出码 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'cmt-usage-empty-'));
    ROOTS.push(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    try {
      const stdout = execFileSync(process.execPath, [BIN, 'usage'], {
        encoding: 'utf8',
        cwd: root,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      assert.match(stdout, /没有找到任何 transcript/);
    } catch (err) {
      assert.fail(`不该非零退出：${/** @type {any} */ (err).stderr ?? ''}`);
    }
  });
});
