// @ts-check
/**
 * 池的**记账**（`syncPoolUsage`）——命令行 `pool sync` 与网页控制台「重算用量」共用的那一处。
 *
 * 这里钉的是三件「看着对、其实错」的事：
 *
 * 1. **按模型分开记**：花费只能从 `entry.models` 的明细算出来。聚合的 `in` / `out`
 *    必须恰好等于明细之和——两处各算一遍的话，页面和命令行迟早对不上，而且**不会报错**。
 * 2. **每一行只有四个键**（`input` / `cacheRead` / `cacheWrite` / `output`），**没有 `calls`**。
 *    `calls` 是消息条数，摊到模型上既不可导也无人读；多一个键不会报错，
 *    只会在 `pool.json` 里静默多出一行噪音，而那份文件用户是要手看的。
 * 3. **没 model 的记账不许丢**：落进「（未知模型）」桶，它才会计入"有量、无价"。
 *    丢掉的话那部分花费从总额和明细里**一起消失**，且什么都不报。
 *
 * ⚠️ 夹具全是假 key / 假模型名：这份文件会被读、被复制（§6.3）。
 * ⚠️ `input_tokens` **含缓存**（`core/usage.js` 文件头那段）：夹公里写的是**总量**，
 *    解析器剥掉缓存之后才是断言里那四个数。写的时候别把它当"不含缓存"用。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { ensureEntry, loadPool } from '../src/cli/pool-store.js';
import { syncPoolUsage } from '../src/cli/pool-usage.js';
import { poolPath, poolUsageCachePath, profileDir, tokensDir } from '../src/core/paths.js';

/** 一个固定时刻：`usageAt` 断言要能一眼对上。 */
const NOW = new Date('2026-10-31T12:00:00.000Z');
const STAMP = NOW.toISOString();

/** @type {string[]} */
const made = [];
after(() => {
  for (const home of made) fs.rmSync(home, { recursive: true, force: true });
});

/**
 * 真的临时 home：`tokens/` 里放几个空文件（`listTokenNames()` 只数文件名）。
 * @param {string[]} names
 */
function home(names) {
  const h = fs.mkdtempSync(join(os.tmpdir(), 'cxt-pool-usage-'));
  fs.mkdirSync(tokensDir(h), { recursive: true });
  for (const name of names) fs.writeFileSync(join(tokensDir(h), `${name}.json`), '{}', 'utf8');
  made.push(h);
  return h;
}

/** 一个够用的 ctx——这几个函数只读 `home`。 */
const ctxOf = (h) => /** @type {any} */ ({ home: h, env: {} });

/**
 * 一条 `turn_context`：把 `turn_id` 绑到模型上（解析器靠它归属模型）。
 * @param {string} turnId
 * @param {string} model
 */
function turn(turnId, model) {
  return JSON.stringify({
    type: 'turn_context',
    timestamp: '2026-10-30T08:00:00.000Z',
    payload: { turn_id: turnId, model, cwd: 'C:/work/demo' },
  });
}

/**
 * 一条 `token_usage_record`（增量）。
 *
 * ⚠️ `input_tokens` 是**含缓存**的总量：解析器会减掉 `cached_input_tokens` 与
 * `cache_write_input_tokens`，剩下的才是"现算输入"。
 *
 * @param {string} turnId
 * @param {{input?: number, cacheRead?: number, cacheWrite?: number, output?: number}} [o]
 */
function record(turnId, o = {}) {
  const cacheRead = o.cacheRead ?? 0;
  const cacheWrite = o.cacheWrite ?? 0;
  return JSON.stringify({
    type: 'token_usage_record',
    timestamp: '2026-10-30T08:00:01.000Z',
    payload: {
      turn_id: turnId,
      usage: {
        input_tokens: (o.input ?? 0) + cacheRead + cacheWrite,
        cached_input_tokens: cacheRead,
        cache_write_input_tokens: cacheWrite,
        output_tokens: o.output ?? 0,
      },
    },
  });
}

/**
 * 往某个 token 的 profile 里写一份 rollout。
 *
 * @param {string} h
 * @param {string} token
 * @param {string} name   文件名（两个文件要不同的名字才都会被扫到）
 * @param {string[]} lines
 */
function writeRollout(h, token, name, lines) {
  const dir = join(profileDir(h, token), 'sessions', '2026', '10', '30');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, name), lines.join('\n') + '\n', 'utf8');
}

/** 一个空池 + 指定的几个条目（模拟"这几个 token 已经入池"）。 */
function poolWith(h, names) {
  const { pool } = loadPool(ctxOf(h));
  for (const name of names) ensureEntry(pool, name);
  return pool;
}

describe('syncPoolUsage：按模型记用量', () => {
  test('★★ 每个模型一行四项，聚合 = 明细之和（跨文件也并到同一行）', () => {
    const h = home(['relay-a', 'relay-b']);
    // 同一个模型出现在两份文件里 → 必须并成一行
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 10, cacheRead: 100, cacheWrite: 5, output: 7 }),
      turn('m-2', 'model-b'),
      record('m-2', { input: 20, output: 3 }),
    ]);
    writeRollout(h, 'relay-a', 's2.jsonl', [
      turn('m-3', 'model-a'),
      record('m-3', { input: 1, cacheRead: 2, output: 4 }),
    ]);

    const pool = poolWith(h, ['relay-a', 'relay-b']);
    const r = syncPoolUsage(ctxOf(h), pool, NOW);

    const entry = pool.entries['relay-a'];
    assert.deepEqual(entry.models, {
      'model-a': { input: 11, cacheRead: 102, cacheWrite: 5, output: 11 },
      'model-b': { input: 20, cacheRead: 0, cacheWrite: 0, output: 3 },
    });
    // ★ 聚合 = 明细之和（缓存三项都算输入侧，与 §2.15 九 的计费口径一致）
    assert.equal(entry.in, 11 + 102 + 5 + 20);
    assert.equal(entry.out, 11 + 3);
    assert.equal(entry.calls, 3);

    assert.equal(r.filesRead, 2);
    assert.deepEqual(r.names, ['relay-a', 'relay-b']);
    assert.deepEqual(r.totals['relay-a'].models, entry.models);
  });

  test('★★ 行里只有四个键：多出来的键会在 pool.json 里静默变成噪音', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 3, output: 1 }),
    ]);

    const pool = poolWith(h, ['relay-a']);
    syncPoolUsage(ctxOf(h), pool, NOW);

    const row = pool.entries['relay-a'].models['model-a'];
    assert.deepEqual(Object.keys(row).sort(), ['cacheRead', 'cacheWrite', 'input', 'output']);
  });

  test('★ 没有 model 的记账落进「（未知模型）」，不许静默消失', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 5, output: 1 }),
    ]);
    // 第二份 rollout 里**一条 `turn_context` 都没有**（解析器会退回"本文件最后一个模型"，
    // 所以必须换一个文件——同一个文件里前面那条会把它兜住）
    writeRollout(h, 'relay-a', 's2.jsonl', [
      record('m-2', { input: 40, output: 2 }),
    ]);

    const pool = poolWith(h, ['relay-a']);
    syncPoolUsage(ctxOf(h), pool, NOW);

    const entry = pool.entries['relay-a'];
    assert.deepEqual(entry.models['（未知模型）'], {
      input: 40, cacheRead: 0, cacheWrite: 0, output: 2,
    });
    // 它必须仍然计进聚合——否则"有量、无价"那条统计连加分的对象都没有
    assert.equal(entry.in, 45);
    assert.equal(entry.out, 3);
  });

  test('★★ 重算是覆盖而不是累加（连算两次同一个数，不是翻倍）', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 6, output: 2 }),
    ]);

    const pool = poolWith(h, ['relay-a']);
    // 先塞一份"上一次算出来的"旧账，模拟盘上已经有数字
    Object.assign(pool.entries['relay-a'], { calls: 99, in: 888, out: 777 });

    syncPoolUsage(ctxOf(h), pool, NOW);
    const first = JSON.stringify(pool.entries['relay-a']);
    syncPoolUsage(ctxOf(h), pool, NOW);

    assert.equal(JSON.stringify(pool.entries['relay-a']), first);
    assert.equal(pool.entries['relay-a'].calls, 1);
    assert.equal(pool.entries['relay-a'].in, 6);
  });
});

describe('syncPoolUsage：谁被算、谁不被算', () => {
  test('★★ 池外的 profile 一个字都不记账（只认 entries 里的名字）', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 1, output: 1 }),
    ]);
    // relay-x 有 rollout，但**没入池**——它不该被凭空建出一个条目
    writeRollout(h, 'relay-x', 's1.jsonl', [
      turn('x-1', 'model-a'),
      record('x-1', { input: 1000, output: 1000 }),
    ]);

    const pool = poolWith(h, ['relay-a']);
    const r = syncPoolUsage(ctxOf(h), pool, NOW);

    assert.deepEqual(Object.keys(pool.entries), ['relay-a']);
    assert.equal(r.totals['relay-x'], undefined);
    assert.equal(r.filesRead, 1, '只该读入池的那几个 token 的文件');
    assert.equal(pool.entries['relay-a'].calls, 1);
  });

  test('★★ 未托管的那份（~/.codex/sessions）不是 token 名，永不入池', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 1, output: 1 }),
    ]);
    const legacy = join(h, '.codex', 'sessions', '2026', '10', '30');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(
      join(legacy, 'rollout-old.jsonl'),
      [turn('L-1', 'model-a'), record('L-1', { input: 500, output: 500 })].join('\n'),
      'utf8',
    );

    const pool = poolWith(h, ['relay-a']);
    syncPoolUsage(ctxOf(h), pool, NOW);

    assert.equal(pool.entries['relay-a'].calls, 1, '未托管那份被算进来就翻倍了');
    assert.equal(pool.entries['relay-a'].in, 1);
  });

  test('★ 入了池但一份 rollout 都没有 ⇒ 归零 + 照样盖时间戳', () => {
    const h = home(['relay-a', 'relay-b']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 2, output: 1 }),
    ]);

    const pool = poolWith(h, ['relay-a', 'relay-b']);
    syncPoolUsage(ctxOf(h), pool, NOW);

    const b = pool.entries['relay-b'];
    assert.deepEqual(b.models, {});
    assert.equal(b.calls, 0);
    assert.equal(b.in, 0);
    assert.equal(b.out, 0);
    // ★ 时间是"重算过"的凭据：0 用量与"从没算过"必须能区分开
    assert.equal(b.usageAt, STAMP);
  });

  test('★ 整批共用同一个时刻（同一次重算的数字就该有同一个戳）', () => {
    const h = home(['relay-a', 'relay-b', 'relay-c']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 1, output: 1 }),
    ]);

    const pool = poolWith(h, ['relay-a', 'relay-b', 'relay-c']);
    syncPoolUsage(ctxOf(h), pool, NOW);

    for (const name of ['relay-a', 'relay-b', 'relay-c']) {
      assert.equal(pool.entries[name].usageAt, STAMP);
    }
  });
});

describe('syncPoolUsage：落盘', () => {
  test('★★ 明细与时间戳真的进了 pool.json，且读回来形状不变', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 10, cacheRead: 4, output: 6 }),
    ]);

    const pool = poolWith(h, ['relay-a']);
    syncPoolUsage(ctxOf(h), pool, NOW);

    assert.equal(fs.existsSync(poolPath(h)), true, 'sync 必须落盘——不然命令行与页面各看各的');

    const back = loadPool(ctxOf(h)).pool.entries['relay-a'];
    assert.deepEqual(back.models, {
      'model-a': { input: 10, cacheRead: 4, cacheWrite: 0, output: 6 },
    });
    assert.equal(back.usageAt, STAMP);
  });
});

/**
 * 增量缓存（`pool-usage-cache.json`）。
 *
 * ★ 它存在的理由只有一条：**重算会变便宜，但不能变不准**。所以每一条断言都是在问
 * "走缓存之后，`pool.json` 里的数还是不是那个数"。缓存的命中判据是
 * `size + mtimeMs`——这两个数一起变才叫"文件动过"，单独一样变也不该重读。
 */
describe('syncPoolUsage：增量缓存', () => {
  /** 一次重算的收尾断言：走不走缓存，池里的数必须一模一样。 */
  const sameNumbers = (a, b) => {
    assert.equal(a.in, b.in);
    assert.equal(a.out, b.out);
    assert.equal(a.calls, b.calls);
    assert.deepEqual(a.models, b.models);
  };

  test('★★ 没变过的文件走缓存：数一个不差，filesRead 归零', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 10, cacheRead: 4, output: 6 }),
    ]);
    writeRollout(h, 'relay-a', 's2.jsonl', [
      turn('m-2', 'model-b'),
      record('m-2', { input: 3, output: 2 }),
    ]);

    const pool1 = poolWith(h, ['relay-a']);
    const first = syncPoolUsage(ctxOf(h), pool1, NOW);
    assert.equal(first.filesRead, 2, '头一次没有缓存可用，两份都得读');
    assert.equal(first.filesCached, 0);
    const before = JSON.parse(JSON.stringify(pool1.entries['relay-a']));

    const pool2 = poolWith(h, ['relay-a']);
    const second = syncPoolUsage(ctxOf(h), pool2, NOW);
    assert.equal(second.filesRead, 0, '两份都没变，一份都不该重读');
    assert.equal(second.filesCached, 2);
    // ★ 这条是全部：省下来的 IO 不许换走一个数字
    sameNumbers(pool2.entries['relay-a'], before);
  });

  test('★ 只重读变过的那一份（追加一行 = size 与 mtime 都变）', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 10, output: 6 }),
    ]);
    const s2 = join(profileDir(h, 'relay-a'), 'sessions', '2026', '10', '30', 's2.jsonl');
    writeRollout(h, 'relay-a', 's2.jsonl', [
      turn('m-2', 'model-b'),
      record('m-2', { input: 3, output: 2 }),
    ]);

    syncPoolUsage(ctxOf(h), poolWith(h, ['relay-a']), NOW);

    // 追加一整个 turn：同一次会话里又跑了一轮
    fs.appendFileSync(s2, `${turn('m-3', 'model-b')}\n${record('m-3', { input: 5, output: 1 })}\n`, 'utf8');

    const pool2 = poolWith(h, ['relay-a']);
    const r = syncPoolUsage(ctxOf(h), pool2, NOW);
    assert.equal(r.filesRead, 1, '只有 s2 变了');
    assert.equal(r.filesCached, 1);
    // ★ 追加进去的那一轮必须真的算进来——走缓存的 s1 也不许丢
    assert.equal(pool2.entries['relay-a'].models['model-b'].input, 8);
    assert.equal(pool2.entries['relay-a'].models['model-a'].input, 10);
  });

  test('★ `--force` 不信缓存：全部重读，数不变', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 7, output: 3 }),
    ]);

    const first = syncPoolUsage(ctxOf(h), poolWith(h, ['relay-a']), NOW);
    assert.equal(first.filesRead, 1);

    const pool2 = poolWith(h, ['relay-a']);
    const forced = syncPoolUsage(ctxOf(h), pool2, NOW, { force: true });
    assert.equal(forced.filesRead, 1);
    assert.equal(forced.filesCached, 0);
    sameNumbers(pool2.entries['relay-a'], first.totals['relay-a']);
  });

  test('★ 坏缓存当没有：照常全读，一个数不差', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 2, output: 1 }),
    ]);
    // 半截 JSON / 形状不对 / 版本对不上，三条都该退化成"没有缓存"
    for (const junk of ['{"version":1,"files":', '[]', '{"version":99,"files":{}}']) {
      fs.writeFileSync(poolUsageCachePath(h), junk, 'utf8');
      const r = syncPoolUsage(ctxOf(h), poolWith(h, ['relay-a']), NOW);
      assert.equal(r.filesRead, 1, `缓存是 ${junk} 时必须当没有`);
    }
  });

  test('★★ 缓存里只有 size / mtimeMs / calls / models（没有 in / out）', () => {
    const h = home(['relay-a']);
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 10, cacheRead: 4, output: 6 }),
    ]);
    syncPoolUsage(ctxOf(h), poolWith(h, ['relay-a']), NOW);

    const raw = JSON.parse(fs.readFileSync(poolUsageCachePath(h), 'utf8'));
    assert.equal(raw.version, 1);
    const rows = Object.values(raw.files);
    assert.equal(rows.length, 1);

    // ★ 存了 `in`/`out` 就会有两份真相：缓存说 14、明细加起来 14——一旦哪天不一致，
    //   "聚合 = 明细之和"就没有任何东西守着了。所以这一层**只存原料**。
    assert.deepEqual(Object.keys(rows[0]).sort(), ['calls', 'models', 'mtimeMs', 'size']);
    assert.deepEqual(Object.keys(rows[0].models['model-a']).sort(),
      ['cacheRead', 'cacheWrite', 'input', 'output']);
  });

  test('★ 缓存只留这一轮见过的文件（删掉的那份跟着消失）', () => {
    const h = home(['relay-a']);
    const s1 = join(profileDir(h, 'relay-a'), 'sessions', '2026', '10', '30', 's1.jsonl');
    writeRollout(h, 'relay-a', 's1.jsonl', [
      turn('m-1', 'model-a'),
      record('m-1', { input: 1, output: 1 }),
    ]);
    const s2 = join(profileDir(h, 'relay-a'), 'sessions', '2026', '10', '30', 's2.jsonl');
    writeRollout(h, 'relay-a', 's2.jsonl', [
      turn('m-2', 'model-a'),
      record('m-2', { input: 2, output: 2 }),
    ]);

    syncPoolUsage(ctxOf(h), poolWith(h, ['relay-a']), NOW);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(poolUsageCachePath(h), 'utf8')).files).length, 2);

    fs.rmSync(s2);
    const pool2 = poolWith(h, ['relay-a']);
    syncPoolUsage(ctxOf(h), pool2, NOW);

    const raw = JSON.parse(fs.readFileSync(poolUsageCachePath(h), 'utf8'));
    // ★ 只该剩 s1：删掉的文件不许在缓存里长成一条死账（那份缓存会永远不缩小）
    assert.deepEqual(Object.keys(raw.files), [s1]);
    // 而且它的数还是对的——删的是别的文件，不该把 s1 的账也带走
    assert.equal(pool2.entries['relay-a'].models['model-a'].input, 1);
  });
});
