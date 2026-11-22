// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CACHE_SECONDS,
  DEFAULT_USAGE_SECONDS,
  INVALID_CACHE_SECONDS,
  MAX_LAST_PICK,
  POLICY,
  POOL_VERSION,
  STATUS,
  STATUS_LABEL,
  classifyProbe,
  defaultPool,
  isStale,
  mapImportRows,
  normalizeEntry,
  normalizeModelUsage,
  normalizePool,
  normalizeStatus,
  orderCandidates,
  rotate,
  statusLabel,
  summarizePool,
  totalUsed,
  usageStale,
} from '../src/core/pool.js';

/**
 * 造一条条目。默认"刚探过、有余额"。
 * @param {Partial<import('../src/core/pool.js').PoolEntry>} [over]
 */
function entry(over = {}) {
  return {
    status: STATUS.OK,
    detail: '',
    checkedAt: '2026-10-31T00:00:00.000Z',
    calls: 0,
    in: 0,
    out: 0,
    usageAt: '',
    models: {},
    ...over,
  };
}

/** 本地时间构造（跨月判定用的是本机日历，用本地构造才与实现对齐） */
function local(year, month, day, hour = 12) {
  return new Date(year, month - 1, day, hour, 0, 0);
}

// ───────────────────────────── 归 一 化 ─────────────────────────────

describe('normalizePool：永不抛，脏的丢掉', () => {
  test('不是对象 → 全默认（null / 数组 / 字符串 / 数字 / 布尔）', () => {
    for (const raw of [null, undefined, [], 'x', 42, true]) {
      assert.deepEqual(normalizePool(raw), defaultPool());
    }
  });

  test('默认形状就是"空池"', () => {
    assert.deepEqual(defaultPool(), {
      version: POOL_VERSION,
      updatedAt: '',
      redis: '',
      rr: 0,
      lastPick: {},
      entries: {},
    });
  });

  test('★ updatedAt 是个字符串，读写一遍之后还在', () => {
    // 它不是账本，但少了它就没法回答"这份状态是什么时候的"——
    // 而 `normalizePool` 一旦不认这个键，一次读-改-写就会把它悄悄抹掉。
    assert.equal(normalizePool({ updatedAt: '2026-10-31T08:00:00.000Z' }).updatedAt,
      '2026-10-31T08:00:00.000Z');
    assert.equal(normalizePool({ updatedAt: 42 }).updatedAt, '');
  });

  test('★ redis 地址读得回来，且会被去空白（它可能带密码，所以不进 config.json）', () => {
    assert.equal(normalizePool({ redis: '  redis://127.0.0.1:6379  ' }).redis, 'redis://127.0.0.1:6379');
    assert.equal(normalizePool({ redis: 42 }).redis, '');
  });

  test('版本号永远被改写成当前版本', () => {
    assert.equal(normalizePool({ version: 99 }).version, POOL_VERSION);
  });

  test('entries / lastPick 不是对象 → 空表', () => {
    for (const value of [[], 'x', 3, null]) {
      const p = normalizePool({ entries: value, lastPick: value });
      assert.deepEqual(p.entries, {});
      assert.deepEqual(p.lastPick, {});
    }
  });

  test('某一条不是对象 → 只丢那一条，其余照常', () => {
    const p = normalizePool({
      entries: {
        good: { status: 'ok' },
        bad1: null,
        bad2: [],
        bad3: 'str',
        good2: { status: 'no_quota' },
      },
    });
    assert.deepEqual(Object.keys(p.entries).sort(), ['good', 'good2']);
    assert.equal(p.entries.good2.status, STATUS.NO_QUOTA);
  });

  test('认不出的状态降级成 unknown，不是丢掉这一条', () => {
    const p = normalizePool({ entries: { a: { status: 'weird' } } });
    assert.equal(p.entries.a.status, STATUS.UNKNOWN);
  });

  test('计数：负数 / 小数 / 字符串数字 / NaN 全部收成非负整数', () => {
    const p = normalizePool({
      entries: {
        a: { calls: -5, in: 1.9, out: '12' },
        b: { calls: 'x', in: NaN, out: Infinity },
      },
    });
    assert.deepEqual(
      { calls: p.entries.a.calls, in: p.entries.a.in, out: p.entries.a.out },
      { calls: 0, in: 1, out: 12 },
    );
    assert.deepEqual(
      { calls: p.entries.b.calls, in: p.entries.b.in, out: p.entries.b.out },
      { calls: 0, in: 0, out: 0 },
    );
  });

  test('rr 也收成非负整数', () => {
    assert.equal(normalizePool({ rr: '7' }).rr, 7);
    assert.equal(normalizePool({ rr: -3 }).rr, 0);
    assert.equal(normalizePool({ rr: 'zzz' }).rr, 0);
  });

  test('lastPick：空串 / 非字符串丢掉，超上限只留前 N 条', () => {
    /** @type {Record<string, unknown>} */
    const many = {};
    for (let i = 0; i < MAX_LAST_PICK + 25; i += 1) many[`/w/${i}`] = 'tok';
    many[''] = 'nope';
    many['/w/object'] = 42;

    const p = normalizePool({ lastPick: many });
    assert.equal(Object.keys(p.lastPick).length, MAX_LAST_PICK);
    assert.equal(p.lastPick[''], undefined);
    assert.equal(p.lastPick['/w/object'], undefined);
    assert.equal(p.lastPick['/w/0'], 'tok');
  });

  test('顶层多出来的键（旧版写的 usage 之类）不认也不报错', () => {
    const p = normalizePool({ usage: { a: 1 }, entries: { a: { status: 'ok' } } });
    assert.deepEqual(Object.keys(p).sort(), ['entries', 'lastPick', 'redis', 'rr', 'updatedAt', 'version']);
  });
});

describe('normalizeEntry / normalizeStatus', () => {
  test('不是对象 → null（调用方负责丢掉）', () => {
    for (const raw of [null, undefined, [], 'x', 3]) {
      assert.equal(normalizeEntry(raw), null);
    }
  });

  test('缺字段的条目补成空值，不是丢掉', () => {
    assert.deepEqual(normalizeEntry({}), {
      status: STATUS.UNKNOWN,
      detail: '',
      checkedAt: '',
      calls: 0,
      in: 0,
      out: 0,
      usageAt: '',
      models: {},
    });
  });

  test('non-string 的 detail / checkedAt 收成空串', () => {
    assert.deepEqual(normalizeEntry({ detail: 5, checkedAt: null }), {
      status: STATUS.UNKNOWN,
      detail: '',
      checkedAt: '',
      calls: 0,
      in: 0,
      out: 0,
      usageAt: '',
      models: {},
    });
  });

  test('用量明细与记账时间跟着走；类型不对就收回默认值', () => {
    const e = normalizeEntry({
      usageAt: '2026-10-31T00:00:00.000Z',
      models: { 'm-1': { input: 10, cacheRead: 3, cacheWrite: 1, output: 7 } },
    });
    assert.equal(e.usageAt, '2026-10-31T00:00:00.000Z');
    assert.deepEqual(e.models['m-1'], { input: 10, cacheRead: 3, cacheWrite: 1, output: 7 });

    const bad = normalizeEntry({ usageAt: 5, models: 'x' });
    assert.equal(bad.usageAt, '');
    assert.deepEqual(bad.models, {});
  });

  test('normalizeStatus：词表内的原样返回，其余一律 unknown', () => {
    for (const s of Object.values(STATUS)) assert.equal(normalizeStatus(s), s);
    for (const s of ['', 'OK', ' ok', null, 3, undefined, 'none']) {
      assert.equal(normalizeStatus(s), STATUS.UNKNOWN);
    }
  });

  test('statusLabel：六个词都有中文，认不出来的按"未检测"（与判定同一个口径）', () => {
    for (const s of Object.values(STATUS)) {
      assert.equal(typeof statusLabel(s), 'string');
      assert.notEqual(statusLabel(s).trim(), '');
    }
    assert.equal(statusLabel(STATUS.OK), '有余额');
    assert.equal(statusLabel(STATUS.NO_QUOTA), '无余额');
    // ★ 表格里出现一个"判不出却显示得很确定"的词，比显示"未检测"更糟
    for (const s of ['', 'OK', null, 3, 'wat']) assert.equal(statusLabel(s), STATUS_LABEL[STATUS.UNKNOWN]);
  });
});

// ───────────────────────────── 用 量 ─────────────────────────────

describe('totalUsed', () => {
  test('输入 + 输出；没有条目算 0', () => {
    assert.equal(totalUsed(entry({ in: 100, out: 23 })), 123);
    assert.equal(totalUsed(entry({ calls: 999 })), 0);
    assert.equal(totalUsed(null), 0);
    assert.equal(totalUsed(undefined), 0);
  });

  test('★ calls 不参与——按"次数"分配会让长会话那把 key 一直被优先挑走', () => {
    const chatty = entry({ calls: 1, in: 500000, out: 100000 });
    const quiet = entry({ calls: 300, in: 10, out: 10 });
    assert.ok(totalUsed(quiet) < totalUsed(chatty));
  });
});

describe('normalizeModelUsage：每模型用量', () => {
  test('不是对象 → 空表，不抛', () => {
    for (const raw of [null, undefined, [], 'x', 3]) {
      assert.deepEqual(normalizeModelUsage(raw), {});
    }
  });

  test('认得出的行按 0 补齐，未知字段丢掉', () => {
    assert.deepEqual(normalizeModelUsage({ m: { input: 5, secret: 'x' } }), {
      m: { input: 5, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
  });

  test('★ 全零的行不保留——它和"没有这一行"说的是同一件事', () => {
    assert.deepEqual(normalizeModelUsage({ m: { input: 0, output: 0 } }), {});
    assert.deepEqual(normalizeModelUsage({ m: { input: 1 } }), {
      m: { input: 1, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
  });

  test('空 id / 非对象的行丢掉，其余照常', () => {
    assert.deepEqual(normalizeModelUsage({ '': { input: 1 }, bad: null, ok: { input: 2 } }), {
      ok: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
  });

  test('★ 认不出的字段（比如老版本的 calls）不会混进来', () => {
    assert.deepEqual(normalizeModelUsage({ m: { calls: 9, input: 2 } }), {
      m: { input: 2, cacheRead: 0, cacheWrite: 0, output: 0 },
    });
  });
});

// ───────────────────────────── 概 览 ─────────────────────────────

/** 概览里的"一行用量"。 */
function usage(over = {}) {
  return { calls: 0, in: 0, out: 0, cost: null, unpriced: 0, syncedAt: '', ...over };
}

/** 概览里的一行。 */
function row(over = {}) {
  return {
    url: 'https://example.com',
    status: STATUS.OK,
    checkedAt: '2026-10-31T00:00:00.000Z',
    usage: usage(),
    ...over,
  };
}

describe('summarizePool：概览条的数字与提示', () => {
  const NOW = '2026-10-31T12:00:00.000Z';

  test('空池：数字全 0，花费 null（不是 $0）', () => {
    const s = summarizePool([], NOW);
    assert.equal(s.total, 0);
    assert.deepEqual(s.counts, []);
    assert.deepEqual([s.calls, s.in, s.out], [0, 0, 0]);
    assert.equal(s.cost, null);
    assert.equal(s.costPartial, false);
    assert.equal(s.unpriced, 0);
    assert.equal(s.syncedAt, '');
    assert.equal(s.insights.length, 1);
    assert.match(s.insights[0], /token/);
  });

  test('不是数组 / 夹杂垃圾行 → 只数得出来的那些，不抛', () => {
    for (const bad of [null, undefined, 'x', 3]) assert.equal(summarizePool(bad, NOW).total, 0);
    const s = summarizePool([row(), null, 'x', [], row({ status: STATUS.NO_QUOTA })], NOW);
    assert.equal(s.total, 2);
  });

  test('计数只留有条目的状态，顺序是 STATUSES（好坏顺序，不是字母序）', () => {
    const s = summarizePool(
      [
        row({ status: STATUS.UNKNOWN }),
        row({ status: STATUS.OK }),
        row({ status: STATUS.OK }),
        row({ status: STATUS.NO_QUOTA }),
      ],
      NOW,
    );
    assert.deepEqual(s.counts.map((c) => c.status), [STATUS.OK, STATUS.NO_QUOTA, STATUS.UNKNOWN]);
    assert.deepEqual(s.counts.map((c) => c.count), [2, 1, 1]);
    assert.equal(s.counts[0].label, STATUS_LABEL[STATUS.OK]);
    // 六档里没出现的三档不占位——概览条上不该有一排「0」
    assert.equal(s.counts.length, 3);
  });

  test('用量逐项相加', () => {
    const s = summarizePool(
      [
        row({ usage: usage({ calls: 2, in: 100, out: 10 }) }),
        row({ usage: usage({ calls: 3, in: 400, out: 90 }) }),
      ],
      NOW,
    );
    assert.deepEqual([s.calls, s.in, s.out], [5, 500, 100]);
  });

  test('花费：全都查得到价 → 加起来', () => {
    const s = summarizePool(
      [
        row({ usage: usage({ calls: 1, in: 10, cost: 0.25, syncedAt: NOW }) }),
        row({ usage: usage({ calls: 1, in: 10, cost: 0.5, syncedAt: NOW }) }),
      ],
      NOW,
    );
    assert.equal(s.cost, 0.75);
    assert.equal(s.costPartial, false);
  });

  test('★ 有用量但一个价都查不到 → cost 是 null，不是 0', () => {
    const s = summarizePool(
      [row({ usage: usage({ calls: 1, in: 10, unpriced: 2, syncedAt: NOW }) })],
      NOW,
    );
    assert.equal(s.cost, null, '$0 会说"免费"，而真相是"没配价格"');
    assert.equal(s.costPartial, true);
    assert.equal(s.unpriced, 2);
  });

  test('部分无价 → 数字照算，但标成下限（前端渲染 `$0.42+`）', () => {
    const s = summarizePool(
      [
        row({ usage: usage({ calls: 1, in: 10, cost: 0.42, unpriced: 1, syncedAt: NOW }) }),
        row({ usage: usage({ calls: 1, in: 10, unpriced: 3, syncedAt: NOW }) }),
      ],
      NOW,
    );
    assert.equal(s.cost, 0.42);
    assert.equal(s.costPartial, true);
    assert.equal(s.unpriced, 4);
  });

  test('全都有价、确实 0 元 → cost 是 0（这时候"免费"是真的）', () => {
    const s = summarizePool(
      [row({ usage: usage({ calls: 1, in: 10, cost: 0, syncedAt: NOW }) })],
      NOW,
    );
    assert.equal(s.cost, 0);
    assert.equal(s.costPartial, false);
  });

  test('一次用量都没有 → cost 是 null（没有"花了 0 元"这回事）', () => {
    assert.equal(summarizePool([row()], NOW).cost, null);
  });

  test('syncedAt 取各行里最新的那个', () => {
    const s = summarizePool(
      [
        row({ usage: usage({ syncedAt: '2026-10-01T00:00:00.000Z' }) }),
        row({ usage: usage({ syncedAt: '2026-10-30T00:00:00.000Z' }) }),
        row({ usage: usage({ syncedAt: '' }) }),
      ],
      NOW,
    );
    assert.equal(s.syncedAt, '2026-10-30T00:00:00.000Z');
  });

  test('健康的池 → 一条提示都没有（提示不是装饰）', () => {
    const s = summarizePool(
      [
        row({ url: 'https://a.example.com', usage: usage({ calls: 5, in: 100, cost: 0.1, syncedAt: NOW }) }),
        row({ url: 'https://b.example.com', usage: usage({ calls: 5, in: 100, cost: 0.1, syncedAt: NOW }) }),
      ],
      NOW,
    );
    assert.deepEqual(s.insights, []);
  });

  test('★「全是未检测」与「全都不可用」是两句不同的话', () => {
    const fresh = summarizePool([row({ status: STATUS.UNKNOWN }), row({ status: STATUS.UNKNOWN })], NOW);
    assert.match(fresh.insights[0], /没检测过/);
    assert.doesNotMatch(fresh.insights[0], /没有一个/);

    const dead = summarizePool([row({ status: STATUS.NO_QUOTA }), row({ status: STATUS.INVALID })], NOW);
    assert.match(dead.insights[0], /没有一个/);
  });

  test('未定价的模型数会汇总，并占一条提示', () => {
    const s = summarizePool(
      [
        row({ usage: usage({ syncedAt: NOW, cost: 1 }) }),
        row({ usage: usage({ syncedAt: NOW, unpriced: 3 }) }),
      ],
      NOW,
    );
    assert.equal(s.unpriced, 3);
    assert.ok(s.insights.some((x) => x.includes('查不到价格')));
  });

  test('网关集中：一半以上的 token 在同一个地址才提示', () => {
    const url = 'https://one.example.com';
    const concentrated = summarizePool(
      [
        row({ url, usage: usage({ syncedAt: NOW }) }),
        row({ url, usage: usage({ syncedAt: NOW }) }),
        row({ url: 'https://two.example.com', usage: usage({ syncedAt: NOW }) }),
      ],
      NOW,
    );
    assert.ok(concentrated.insights.some((x) => x.includes('同一个网关')));

    const spread = summarizePool(
      [
        row({ url, usage: usage({ syncedAt: NOW }) }),
        row({ url, usage: usage({ syncedAt: NOW }) }),
        row({ url: 'https://b.example.com', usage: usage({ syncedAt: NOW }) }),
        row({ url: 'https://c.example.com', usage: usage({ syncedAt: NOW }) }),
        row({ url: 'https://d.example.com', usage: usage({ syncedAt: NOW }) }),
      ],
      NOW,
    );
    assert.ok(!spread.insights.some((x) => x.includes('同一个网关')));
  });

  test('用量放了两天 → 提示重算', () => {
    const stale = summarizePool(
      [row({ url: 'https://a.example.com', usage: usage({ syncedAt: '2026-10-29T00:00:00.000Z' }) })],
      NOW,
    );
    assert.ok(stale.insights.some((x) => x.includes('天前')));
  });

  test('跨月的「无余额」→ 提示额度可能已刷新', () => {
    const s = summarizePool(
      [
        row({
          url: 'https://a.example.com',
          status: STATUS.NO_QUOTA,
          checkedAt: '2026-09-30T00:00:00.000Z',
          usage: usage({ syncedAt: NOW }),
        }),
        row({ url: 'https://b.example.com', usage: usage({ syncedAt: NOW }) }),
      ],
      NOW,
    );
    assert.ok(s.insights.some((x) => x.includes('跨月')));
  });

  test('提示最多两条——再多概览条也没地方放', () => {
    const s = summarizePool(
      [
        row({
          status: STATUS.NO_QUOTA,
          checkedAt: '2026-09-30T00:00:00.000Z',
          usage: usage({ unpriced: 5, syncedAt: '2026-10-01T00:00:00.000Z' }),
        }),
      ],
      NOW,
    );
    assert.ok(s.insights.length <= 2, s.insights.join(' / '));
    assert.ok(s.insights.every((x) => typeof x === 'string' && x !== ''));
  });
});

describe('isStale：什么时候该重探', () => {
  const now = local(2026, 10, 31);

  test('没有条目 / 从没探过 → 立刻', () => {
    assert.equal(isStale(undefined, now), true);
    assert.equal(isStale(null, now), true);
    assert.equal(isStale(entry({ checkedAt: '' }), now), true);
  });

  test('checkedAt 认不出来 → 立刻', () => {
    assert.equal(isStale(entry({ checkedAt: '昨天' }), now), true);
    assert.equal(isStale(entry({ checkedAt: '2026-13-45' }), now), true);
  });

  test('checkedAt 在未来（改过系统时钟）→ 立刻', () => {
    assert.equal(isStale(entry({ checkedAt: '2027-01-01T00:00:00.000Z' }), now), true);
  });

  test('ok：窗口内是新鲜的，过了窗口就过期', () => {
    const fresh = entry({ checkedAt: new Date(now.getTime() - 60_000).toISOString() });
    const old = entry({
      checkedAt: new Date(now.getTime() - (DEFAULT_CACHE_SECONDS + 1) * 1000).toISOString(),
    });
    assert.equal(isStale(fresh, now), false);
    assert.equal(isStale(old, now), true);
  });

  test('cacheSeconds 可覆盖（0 / 负数 / 非数字都退回默认）', () => {
    const at = new Date(now.getTime() - 400_000).toISOString();
    assert.equal(isStale(entry({ checkedAt: at }), now, { cacheSeconds: 600 }), false);
    assert.equal(isStale(entry({ checkedAt: at }), now, { cacheSeconds: 0 }), true);
    assert.equal(isStale(entry({ checkedAt: at }), now, { cacheSeconds: -1 }), true);
    assert.equal(isStale(entry({ checkedAt: at }), now, { cacheSeconds: 'x' }), true);
  });

  test('invalid：一整天之内不重探', () => {
    const justNow = entry({
      status: STATUS.INVALID,
      checkedAt: new Date(now.getTime() - 3600_000).toISOString(),
    });
    const yesterday = entry({
      status: STATUS.INVALID,
      checkedAt: new Date(now.getTime() - (INVALID_CACHE_SECONDS + 60) * 1000).toISOString(),
    });
    assert.equal(isStale(justNow, now), false);
    assert.equal(isStale(yesterday, now), true);
  });

  test('★★ no_quota：同月不重探（哪怕过去一个月差一天）', () => {
    const e = entry({ status: STATUS.NO_QUOTA, checkedAt: local(2026, 10, 2).toISOString() });
    assert.equal(isStale(e, local(2026, 10, 31)), false);
  });

  test('★★ no_quota：跨月立刻重探（额度按自然月刷新）', () => {
    const e = entry({ status: STATUS.NO_QUOTA, checkedAt: local(2026, 9, 30, 23).toISOString() });
    assert.equal(isStale(e, local(2026, 10, 1, 1)), true);
  });

  test('★★ no_quota：跨年也算跨月', () => {
    const e = entry({ status: STATUS.NO_QUOTA, checkedAt: local(2025, 12, 31, 23).toISOString() });
    assert.equal(isStale(e, local(2026, 1, 1, 1)), true);
  });

  test('net_fail / other / unknown 都走默认窗口，不是"永远不探"也不是"永远探"', () => {
    for (const status of [STATUS.NET_FAIL, STATUS.OTHER, STATUS.UNKNOWN]) {
      const fresh = entry({ status, checkedAt: new Date(now.getTime() - 60_000).toISOString() });
      const old = entry({
        status,
        checkedAt: new Date(now.getTime() - (DEFAULT_CACHE_SECONDS + 1) * 1000).toISOString(),
      });
      assert.equal(isStale(fresh, now), false, status);
      assert.equal(isStale(old, now), true, status);
    }
  });

  test('now 也接受毫秒数', () => {
    const at = new Date(now.getTime() - 60_000).toISOString();
    assert.equal(isStale(entry({ checkedAt: at }), now.getTime()), false);
  });
});

describe('usageStale：用量该不该重算', () => {
  const now = local(2026, 10, 31);
  const ago = (seconds) => new Date(now.getTime() - seconds * 1000).toISOString();

  test('★ 池里没有条目 → 不算（调用方据此完全不碰盘）', () => {
    assert.equal(usageStale({}, now), false);
    assert.equal(usageStale(null, now), false);
    assert.equal(usageStale([], now), false);
  });

  test('从没算过 → 立刻（`usageAt` 是空串）', () => {
    assert.equal(usageStale({ a: entry({ usageAt: '' }) }, now), true);
  });

  test('`usageAt` 认不出来 / 在未来 → 立刻', () => {
    assert.equal(usageStale({ a: entry({ usageAt: '昨天' }) }, now), true);
    assert.equal(usageStale({ a: entry({ usageAt: '2026-13-45' }) }, now), true);
    // 时间倒流：手改过文件或改了系统时钟
    assert.equal(usageStale({ a: entry({ usageAt: '2027-01-01T00:00:00.000Z' }) }, now), true);
  });

  test('窗口内是新鲜的，过了窗口就重算', () => {
    assert.equal(usageStale({ a: entry({ usageAt: ago(60) }) }, now), false);
    assert.equal(usageStale({ a: entry({ usageAt: ago(DEFAULT_USAGE_SECONDS + 1) }) }, now), true);
  });

  test('★★ 任何一条落后就重算（不是"全部落后才重算"）', () => {
    const fresh = entry({ usageAt: ago(60) });
    const stale = entry({ usageAt: ago(DEFAULT_USAGE_SECONDS + 1) });

    assert.equal(usageStale({ a: fresh }, now), false);
    assert.equal(usageStale({ a: fresh, b: stale }, now), true);
    // ★ 这条是"新入池的 token 不许拖着整池不刷新"：它的 `usageAt` 是 `''`，
    //   而老条目还没到期——若要求"全部过期"，两条判据会互相等，结果是两边都不动。
    assert.equal(usageStale({ old: fresh, fresh: entry({ usageAt: '' }) }, now), true);
  });

  test('usageSeconds 可覆盖（0 / 负数 / 非数字都退回默认）', () => {
    const at = ago(400);
    assert.equal(usageStale({ a: entry({ usageAt: at }) }, now, { usageSeconds: 600 }), false);
    assert.equal(usageStale({ a: entry({ usageAt: at }) }, now, { usageSeconds: 60 }), true);
    assert.equal(usageStale({ a: entry({ usageAt: at }) }, now, { usageSeconds: 0 }), false);
    assert.equal(usageStale({ a: entry({ usageAt: at }) }, now, { usageSeconds: -1 }), false);
    assert.equal(usageStale({ a: entry({ usageAt: at }) }, now, { usageSeconds: 'x' }), false);
  });

  test('now 也接受毫秒数', () => {
    assert.equal(usageStale({ a: entry({ usageAt: ago(60) }) }, now.getTime()), false);
  });
});

// ───────────────────────────── 分 类 器 ─────────────────────────────

describe('classifyProbe：一次应答 → 一个状态', () => {
  test('2xx 一律 ok，哪怕正文里带着 quota 字样', () => {
    assert.equal(classifyProbe({ status: 200 }), STATUS.OK);
    assert.equal(classifyProbe({ status: 201, body: '{"remaining_quota": 0}' }), STATUS.OK);
    assert.equal(classifyProbe({ status: 204, body: 'insufficient_quota' }), STATUS.OK);
  });

  test('402 是协议级"要钱"', () => {
    assert.equal(classifyProbe({ status: 402 }), STATUS.NO_QUOTA);
  });

  test('正文说没钱了 → no_quota', () => {
    const bodies = [
      'insufficient_user_quota',
      '{"error":{"type":"insufficient_quota"}}',
      '账户余额不足，请充值',
      '该分组额度已用尽',
      '已欠费',
      '{"message":"You exceeded your current quota"}',
    ];
    for (const body of bodies) {
      assert.equal(classifyProbe({ status: 403, body }), STATUS.NO_QUOTA, body);
    }
  });

  test('对象正文也会被摊平再搜（不是 [object Object]）', () => {
    assert.equal(
      classifyProbe({ status: 400, body: { error: { message: '额度不足' } } }),
      STATUS.NO_QUOTA,
    );
  });

  test('Buffer 正文也认', () => {
    assert.equal(
      classifyProbe({ status: 403, body: Buffer.from('insufficient_user_quota', 'utf8') }),
      STATUS.NO_QUOTA,
    );
  });

  test('401 → invalid', () => {
    assert.equal(classifyProbe({ status: 401 }), STATUS.INVALID);
    assert.equal(classifyProbe({ status: 401, body: 'Unauthorized' }), STATUS.INVALID);
  });

  test('把无效 key 报成 400/403 的网关也认', () => {
    assert.equal(classifyProbe({ status: 400, body: 'invalid api key' }), STATUS.INVALID);
    assert.equal(classifyProbe({ status: 403, body: '{"error":"unauthorized"}' }), STATUS.INVALID);
    assert.equal(classifyProbe({ status: 400, body: '密钥无效' }), STATUS.INVALID);
    assert.equal(classifyProbe({ status: 403, body: '认证失败' }), STATUS.INVALID);
  });

  test('★★ 429 是限流不是没钱：默认 other，仍然能当候选', () => {
    assert.equal(classifyProbe({ status: 429 }), STATUS.OTHER);
    assert.equal(classifyProbe({ status: 429, body: '{"error":"rate limit exceeded"}' }), STATUS.OTHER);
    assert.equal(classifyProbe({ status: 429, body: '当前分组上游负载已饱和' }), STATUS.OTHER);
  });

  test('★★ 除非 429 的正文明确说余额没了', () => {
    assert.equal(
      classifyProbe({ status: 429, body: '{"type":"insufficient_user_quota"}' }),
      STATUS.NO_QUOTA,
    );
    assert.equal(classifyProbe({ status: 429, body: '账户余额不足' }), STATUS.NO_QUOTA);
  });

  test('剩下的（5xx / 404 / 看不懂的 4xx）一律 other，不冤枉人', () => {
    for (const status of [500, 502, 503, 404, 400, 418]) {
      assert.equal(classifyProbe({ status }), STATUS.OTHER, String(status));
    }
  });

  test('没有 status / 非有限数 / 0 → net_fail（网络根本没通）', () => {
    assert.equal(classifyProbe({}), STATUS.NET_FAIL);
    assert.equal(classifyProbe({ status: NaN }), STATUS.NET_FAIL);
    assert.equal(classifyProbe({ status: 0 }), STATUS.NET_FAIL);
    assert.equal(classifyProbe({ status: -1 }), STATUS.NET_FAIL);
    assert.equal(classifyProbe({ status: '200' }), STATUS.NET_FAIL);
  });

  test('永远不返回 unknown', () => {
    for (const status of [200, 204, 400, 401, 403, 402, 404, 429, 500, 0, NaN]) {
      assert.notEqual(classifyProbe({ status }), STATUS.UNKNOWN);
    }
  });
});

// ───────────────────────────── 排 序 ─────────────────────────────

describe('orderCandidates：挑谁', () => {
  test('硬排除 no_quota 与 invalid', () => {
    const names = orderCandidates({
      a: entry({ status: STATUS.OK }),
      b: entry({ status: STATUS.NO_QUOTA }),
      c: entry({ status: STATUS.INVALID }),
      d: entry({ status: STATUS.OTHER }),
      e: entry({ status: STATUS.UNKNOWN }),
      f: entry({ status: STATUS.NET_FAIL }),
    });
    assert.deepEqual(names, ['a', 'd', 'e', 'f']);
  });

  test('没探过的（unknown）仍然参与候选——先试一把再说', () => {
    assert.deepEqual(orderCandidates({ fresh: entry({ status: STATUS.UNKNOWN }) }), ['fresh']);
  });

  test('按总用量升序', () => {
    const names = orderCandidates({
      c: entry({ in: 300, out: 0 }),
      a: entry({ in: 0, out: 10 }),
      b: entry({ in: 50, out: 0 }),
    });
    assert.deepEqual(names, ['a', 'b', 'c']);
  });

  test('用量并列按名字升序（与文件里的键顺序无关）', () => {
    assert.deepEqual(orderCandidates({ b: entry(), a: entry(), c: entry() }), ['a', 'b', 'c']);
    assert.deepEqual(orderCandidates({ c: entry(), a: entry(), b: entry() }), ['a', 'b', 'c']);
  });

  test('rr 游标是"并列时的轮询"：连挑两次拿到不同的 key', () => {
    const table = { a: entry(), b: entry(), c: entry() };
    assert.equal(orderCandidates(table, { rr: 0 })[0], 'a');
    assert.equal(orderCandidates(table, { rr: 1 })[0], 'b');
    assert.equal(orderCandidates(table, { rr: 2 })[0], 'c');
    assert.equal(orderCandidates(table, { rr: 3 })[0], 'a');
  });

  test('用量不同时游标不会把少用的挤下去', () => {
    const table = { a: entry({ in: 100 }), b: entry({ in: 1 }) };
    assert.equal(orderCandidates(table, { rr: 5 })[0], 'b');
  });

  test('★ 游标只转"并列最小的那一组"，不是转整张表', () => {
    // 0 用量两个（并列最小）+ 一个大用量：游标在这两个之间转
    const table = { c: entry({ in: 999 }), a: entry(), b: entry() };
    assert.deepEqual(orderCandidates(table, { rr: 0 }), ['a', 'b', 'c']);
    assert.deepEqual(orderCandidates(table, { rr: 1 }), ['b', 'a', 'c']);
    assert.deepEqual(orderCandidates(table, { rr: 2 }), ['a', 'b', 'c']);
  });

  test('游标超出长度 / 负数都能算', () => {
    const table = { a: entry(), b: entry() };
    assert.equal(orderCandidates(table, { rr: 10_001 })[0], 'b');
    // 盘上的 rr 是收过的非负数，负数在这里等于 0
    assert.equal(orderCandidates(table, { rr: -1 })[0], 'a');
  });

  test('round-robin 策略不看用量，纯按名字轮转', () => {
    const table = { b: entry({ in: 1 }), a: entry({ in: 999 }) };
    assert.deepEqual(orderCandidates(table, { policy: POLICY.ROUND_ROBIN }), ['a', 'b']);
    assert.deepEqual(orderCandidates(table, { policy: POLICY.ROUND_ROBIN, rr: 1 }), ['b', 'a']);
  });

  test('空表 / 全被排除 → 空数组', () => {
    assert.deepEqual(orderCandidates({}), []);
    assert.deepEqual(orderCandidates({ a: entry({ status: STATUS.NO_QUOTA }) }), []);
    assert.deepEqual(orderCandidates(null), []);
  });

  test('参数是脏的也不抛：坏条目当"没探过"，名字仍然留着', () => {
    assert.deepEqual(orderCandidates({ a: null, b: undefined, c: { status: 'ok' } }), [
      'a',
      'b',
      'c',
    ]);
  });

  test('★ 「在用靠后」：activeTokens 里的名字排到末尾，但**不是排除**', () => {
    const table = { a: entry(), b: entry(), c: entry() };
    assert.deepEqual(orderCandidates(table, { activeTokens: new Set(['a']) }), ['b', 'c', 'a']);
    // 全在用 → 仍然全部返回（软偏好，不是排除；同 token 多开是允许的）
    assert.deepEqual(
      orderCandidates(table, { activeTokens: new Set(['a', 'b', 'c']) }),
      ['a', 'b', 'c'],
    );
  });

  test('activeTokens 也接受数组；空集合与不传一致', () => {
    const table = { b: entry(), a: entry() };
    const base = orderCandidates(table, {});
    assert.deepEqual(orderCandidates(table, { activeTokens: [] }), base);
    assert.deepEqual(orderCandidates(table, { activeTokens: ['b'] }), ['a', 'b']);
  });

  test('在用组内部仍按策略排序（rr 只转各组的并列头）', () => {
    const table = { a: entry(), b: entry(), c: entry(), d: entry() };
    assert.deepEqual(orderCandidates(table, { activeTokens: ['a', 'b'] }), ['c', 'd', 'a', 'b']);
    assert.deepEqual(
      orderCandidates(table, { activeTokens: ['a', 'b'], rr: 1 }),
      ['d', 'c', 'b', 'a'],
    );
  });

  test('round-robin + activeTokens：不在用的先轮', () => {
    const table = { a: entry(), b: entry() };
    assert.deepEqual(
      orderCandidates(table, { policy: POLICY.ROUND_ROBIN, activeTokens: ['a'] }),
      ['b', 'a'],
    );
  });
});

describe('rotate', () => {
  test('左移', () => {
    assert.deepEqual(rotate([1, 2, 3], 1), [2, 3, 1]);
    assert.deepEqual(rotate([1, 2, 3], 0), [1, 2, 3]);
    assert.deepEqual(rotate([1, 2, 3], 3), [1, 2, 3]);
    assert.deepEqual(rotate([1, 2, 3], -1), [3, 1, 2]);
    assert.deepEqual(rotate([], 5), []);
  });

  test('不原地改传入的数组', () => {
    const list = [1, 2, 3];
    rotate(list, 2);
    assert.deepEqual(list, [1, 2, 3]);
  });
});

// ───────────────────────────── 导 入 ─────────────────────────────

describe('mapImportRows：表格行 → 条目', () => {
  test('表头被跳过，剩下的照收', () => {
    const r = mapImportRows([
      ['名字', '密钥'],
      ['甲', 'sk-test-aaaaaaaa'],
      ['乙', 'sk-test-bbbbbbbb'],
    ]);
    assert.deepEqual(r.items, [
      { name: '甲', secret: 'sk-test-aaaaaaaa' },
      { name: '乙', secret: 'sk-test-bbbbbbbb' },
    ]);
    assert.equal(r.skipped.header, 1);
    assert.equal(r.skipped.malformed, 0);
  });

  test('英文表头也认', () => {
    for (const header of [
      ['name', 'key'],
      ['Token', 'API Key'],
      ['名称', 'sk'],
      ['name', 'api-key'],
      ['名字', '密钥值'],
    ]) {
      const r = mapImportRows([header, ['a', 'sk-test-aaaaaaaa']]);
      assert.equal(r.items.length, 1, header.join('/'));
      assert.equal(r.skipped.header, 1, header.join('/'));
    }
  });

  test('★ 只在首行判表头——正文里真有一个叫 key 的 token', () => {
    const r = mapImportRows([
      ['a', 'sk-test-aaaaaaaa'],
      ['key', 'sk-test-bbbbbbbb'],
    ]);
    assert.deepEqual(r.items.map((i) => i.name), ['a', 'key']);
    assert.equal(r.skipped.header, 0);
  });

  test('首行不是表头时，它就是数据', () => {
    const r = mapImportRows([['a', 'sk-test-aaaaaaaa']]);
    assert.equal(r.items.length, 1);
    assert.equal(r.skipped.header, 0);
  });

  test('空行计数但不报错', () => {
    const r = mapImportRows([
      ['名字', '密钥'],
      ['', ''],
      ['甲', 'sk-test-aaaaaaaa'],
      ['', ''],
    ]);
    assert.equal(r.items.length, 1);
    assert.equal(r.skipped.blank, 2);
  });

  test('Bearer 前缀被剥掉（从命令行粘过来的人常带）', () => {
    const r = mapImportRows([['a', 'Bearer sk-test-aaaaaaaa']]);
    assert.equal(r.items[0].secret, 'sk-test-aaaaaaaa');

    const r2 = mapImportRows([['a', 'bearer   sk-test-bbbbbbbb']]);
    assert.equal(r2.items[0].secret, 'sk-test-bbbbbbbb');
  });

  test('同名的只留第一个，其余计入 duplicate', () => {
    const r = mapImportRows([
      ['a', 'sk-test-aaaaaaaa'],
      ['a', 'sk-test-bbbbbbbb'],
      ['b', 'sk-test-cccccccc'],
    ]);
    assert.deepEqual(r.items, [
      { name: 'a', secret: 'sk-test-aaaaaaaa' },
      { name: 'b', secret: 'sk-test-cccccccc' },
    ]);
    assert.equal(r.skipped.duplicate, 1);
  });

  test('名字里的路径分隔符 / 控制字符 → malformed（不许拼进文件名）', () => {
    for (const name of ['../x', 'a/b', 'a\\b', 'a:b', 'a|b', 'a\nb']) {
      const r = mapImportRows([[name, 'sk-test-aaaaaaaa']]);
      assert.equal(r.items.length, 0, name);
      assert.equal(r.skipped.malformed, 1, name);
    }
  });

  test('名字太长 → malformed；长度上限正好 64', () => {
    assert.equal(mapImportRows([['x'.repeat(64), 'sk-test-aaaaaaaa']]).items.length, 1);
    assert.equal(mapImportRows([['x'.repeat(65), 'sk-test-aaaaaaaa']]).skipped.malformed, 1);
  });

  test('密钥太短 / 太长 / 带空格 → malformed', () => {
    const bad = ['short', 'sk test aaaa', `${'a'.repeat(201)}`, 'sk-test-aaaa bbbb'];
    for (const secret of bad) {
      const r = mapImportRows([['a', secret]]);
      assert.equal(r.items.length, 0, secret.length);
      assert.equal(r.skipped.malformed, 1);
    }
  });

  test('★ 不要求 sk- 前缀：中转站自签键、JWT、随机 hex 都收', () => {
    for (const secret of ['abcdefgh', 'A1b2C3d4E5f6', 'a.b-c_d.eeeeeeeee']) {
      const r = mapImportRows([['a', secret]]);
      assert.equal(r.items.length, 1, secret);
    }
  });

  test('名字两边空白被修掉', () => {
    const r = mapImportRows([['  甲  ', '  sk-test-aaaaaaaa  ']]);
    assert.deepEqual(r.items[0], { name: '甲', secret: 'sk-test-aaaaaaaa' });
  });

  test('不是数组的行也扛得住', () => {
    const r = mapImportRows([null, [], ['a', 'sk-test-aaaaaaaa']]);
    assert.equal(r.items.length, 1);
    assert.equal(r.skipped.blank, 2);
  });

  test('传进来的不是数组 → 空结果，不抛', () => {
    assert.deepEqual(mapImportRows(null).items, []);
    assert.deepEqual(mapImportRows('x').items, []);
  });
});
