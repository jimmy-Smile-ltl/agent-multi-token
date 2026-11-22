// @ts-check
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { applyProbe, ensureEntry, loadPool, savePool } from '../src/cli/pool-store.js';
import { poolPath, tokensDir } from '../src/core/paths.js';

/**
 * 一个真的临时 home：`tokens/` 里放几个空文件就够了——
 * `listTokenNames()` 只数文件名，不解析内容。
 *
 * ⚠️ `home` 是**用户的家**，不是数据根：`pool.json` 与 `tokens/` 都在
 * `home/.codex-multi-token/` 下面。路径一律走 `paths.js`，不在这里手拼。
 * @param {string[]} names
 * @returns {string}
 */
function makeHome(names) {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'cxt-pool-'));
  fs.mkdirSync(tokensDir(home), { recursive: true });
  for (const name of names) fs.writeFileSync(join(tokensDir(home), `${name}.json`), '{}', 'utf8');
  return home;
}

/** @param {string} home */
const poolFile = (home) => poolPath(home);

/**
 * 直接往盘上写一份池（绕过 `savePool`，模拟"手改过"）。
 * @param {string} home
 * @param {unknown} raw
 */
function writeRaw(home, raw) {
  fs.writeFileSync(poolFile(home), JSON.stringify(raw), 'utf8');
}

/** @type {string[]} */
const made = [];
after(() => {
  for (const home of made) fs.rmSync(home, { recursive: true, force: true });
});

/** @param {string[]} names */
function home(names) {
  const h = makeHome(names);
  made.push(h);
  return h;
}

/** 一个够 `pool-store` 用的 ctx——它只读 `home`。 */
const ctxOf = (h) => /** @type {any} */ ({ home: h, env: {} });

describe('loadPool：读池 + 盘上的 token 名', () => {
  test('没有 pool.json ⇒ 空池，不抛（可丢弃文件的纪律）', () => {
    const h = home(['relay-a']);
    const { pool, names, dropped } = loadPool(ctxOf(h));
    assert.deepEqual(names, ['relay-a']);
    assert.equal(dropped, 0);
    assert.deepEqual(pool.entries, {});
    assert.equal(pool.version, 1);
  });

  test('pool.json 是坏 JSON ⇒ 同样退化成空池', () => {
    const h = home(['relay-a']);
    fs.writeFileSync(poolFile(h), '{ 这不是 json', 'utf8');
    assert.doesNotThrow(() => loadPool(ctxOf(h)));
    assert.deepEqual(loadPool(ctxOf(h)).pool.entries, {});
  });

  test('★ 孤立条目（token 文件已删）会被滤掉，并计数', () => {
    const h = home(['relay-a']);
    writeRaw(h, {
      version: 1,
      rr: 2,
      entries: {
        'relay-a': { status: 'ok', calls: 3 },
        'relay-gone': { status: 'no_quota', calls: 99 },
      },
    });

    const { pool, dropped } = loadPool(ctxOf(h));
    assert.deepEqual(Object.keys(pool.entries), ['relay-a']);
    assert.equal(dropped, 1);
    // 活着的那条原样保留
    assert.equal(pool.entries['relay-a'].status, 'ok');
    assert.equal(pool.entries['relay-a'].calls, 3);
  });

  test('★★ loadPool 是只读的：孤立条目只是"看不见"，盘上一个字节都没动', () => {
    const h = home(['relay-a']);
    const raw = {
      version: 1,
      entries: { 'relay-a': { status: 'ok' }, 'relay-gone': { status: 'ok' } },
    };
    writeRaw(h, raw);
    const before = fs.readFileSync(poolFile(h), 'utf8');

    loadPool(ctxOf(h));

    assert.equal(fs.readFileSync(poolFile(h), 'utf8'), before);
  });

  test('lastPick 里指向已删 token 的记录同样被忘掉（否则 -c 会报一个它不在了的错）', () => {
    const h = home(['relay-a']);
    writeRaw(h, {
      entries: {},
      lastPick: { 'C:\\work\\one': 'relay-gone', 'C:\\work\\two': 'relay-a' },
    });

    const { pool } = loadPool(ctxOf(h));
    assert.deepEqual(pool.lastPick, { 'C:\\work\\two': 'relay-a' });
  });
});

describe('ensureEntry：入池 = pool.json 里多一个键', () => {
  test('没有就建一个 unknown 的全零条目', () => {
    const pool = /** @type {any} */ ({ entries: {} });
    const entry = ensureEntry(pool, 'relay-new');

    assert.deepEqual(entry, { status: 'unknown', detail: '', checkedAt: '', calls: 0, in: 0, out: 0 });
    assert.equal(pool.entries['relay-new'], entry);
  });

  test('已经有了就**原样复用**，不重置已探到的状态与用量', () => {
    const pool = /** @type {any} */ ({
      entries: { 'relay-a': { status: 'ok', detail: 'HTTP 200 · 8ms', checkedAt: '2026-10-31T00:00:00.000Z', calls: 7, in: 100, out: 20 } },
    });
    const entry = ensureEntry(pool, 'relay-a');

    assert.equal(entry.status, 'ok');
    assert.equal(entry.calls, 7);
    assert.equal(entry.in, 100);
  });

  test('手改坏了的条目会被收成合法形状（而不是把垃圾带出去）', () => {
    const pool = /** @type {any} */ ({ entries: { 'relay-a': { status: '????', calls: -5, in: 'x' } } });
    const entry = ensureEntry(pool, 'relay-a');

    assert.equal(entry.status, 'unknown');
    assert.equal(entry.calls, 0);
    assert.equal(entry.in, 0);
  });
});

describe('applyProbe：探测只改状态，不碰用量', () => {
  test('盖 status / detail / checkedAt', () => {
    const entry = /** @type {any} */ ({ status: 'unknown', detail: '', checkedAt: '', calls: 4, in: 10, out: 2 });
    applyProbe(entry, { status: 'no_quota', detail: 'HTTP 402 · 余额已用尽' }, new Date('2026-10-31T08:00:00.000Z'));

    assert.equal(entry.status, 'no_quota');
    assert.equal(entry.detail, 'HTTP 402 · 余额已用尽');
    assert.equal(entry.checkedAt, '2026-10-31T08:00:00.000Z');
  });

  test('★ 用量字段一个都不动（探测回答的是"有没有钱"，不是"花了多少"）', () => {
    const entry = /** @type {any} */ ({ status: 'ok', detail: '', checkedAt: '', calls: 4, in: 10, out: 2 });
    applyProbe(entry, { status: 'ok', detail: 'HTTP 200 · 5ms' }, new Date());

    assert.equal(entry.calls, 4);
    assert.equal(entry.in, 10);
    assert.equal(entry.out, 2);
  });
});

describe('savePool：落盘并盖时间', () => {
  test('★ updatedAt 只在写的时候取（读一次不该让文件看起来"刚变过"）', () => {
    const h = home(['relay-a']);
    const { pool } = loadPool(ctxOf(h));
    assert.equal(pool.updatedAt, '');
    assert.equal(fs.existsSync(poolFile(h)), false, '读池不该创建文件');

    savePool(ctxOf(h), pool, new Date('2026-10-31T09:30:00.000Z'));
    assert.equal(pool.updatedAt, '2026-10-31T09:30:00.000Z');

    const { pool: again } = loadPool(ctxOf(h));
    assert.equal(again.updatedAt, '2026-10-31T09:30:00.000Z');
  });

  test('写进去的东西读得回来，且形状被收过（写口就是归一化的口）', () => {
    const h = home(['relay-a', 'relay-b']);
    const pool = /** @type {any} */ ({
      version: 1,
      redis: '  redis://127.0.0.1:6379  ',
      rr: 3,
      lastPick: { 'C:\\w': 'relay-a' },
      entries: {
        'relay-a': { status: 'ok', detail: 'HTTP 200 · 7ms', checkedAt: '2026-10-31T00:00:00.000Z', calls: 2, in: 30, out: 5 },
        'relay-b': { status: '这是手改的', calls: '11' },
      },
    });

    savePool(ctxOf(h), pool, new Date('2026-10-31T10:00:00.000Z'));
    const back = loadPool(ctxOf(h)).pool;

    assert.equal(back.redis, 'redis://127.0.0.1:6379');
    assert.equal(back.rr, 3);
    assert.deepEqual(back.lastPick, { 'C:\\w': 'relay-a' });
    assert.equal(back.entries['relay-a'].in, 30);
    assert.equal(back.entries['relay-b'].status, 'unknown');
    assert.equal(back.entries['relay-b'].calls, 11);
  });
});
