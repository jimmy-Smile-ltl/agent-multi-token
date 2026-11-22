// @ts-check
/**
 * 会话在场层与消息信箱的 **IO 层**（`core/store.js`）单测。
 *
 * ★ 每个用例都在**沙箱 home** 里跑（`mkdtempSync`），绝不碰真实状态目录。
 * ★ 文件里**不写死根目录名**（两个项目不同）——一律经 `paths.js` 拿。
 * ★ 判据集中在"宽容"：不存在 / 坏 JSON / 怪文件名一律降级，**永不抛**
 * ——在场记录与消息都是可丢弃的，一份坏文件不许让命令失败。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';

import { sessionInboxDir, sessionMetaPath, sessionReadDir, sessionsDir } from '../src/core/paths.js';
import { emptyMeta, messageFileName } from '../src/core/sessions.js';
import {
  ensureDir,
  listSessionIds,
  listSessionMessages,
  listSessionReadMessages,
  markSessionMessageRead,
  readSessionMessage,
  readSessionMeta,
  removeSessionDir,
  removeSessionMessage,
  writeSessionMessage,
  writeSessionMeta,
} from '../src/core/store.js';

const HOME = mkdtempSync(join(os.tmpdir(), 'sessions-io-'));
after(() => rmSync(HOME, { recursive: true, force: true }));

let seq = 0;
/** @returns {string} */
function nextId() {
  seq += 1;
  return `relay-a-m${seq}-1`;
}

/**
 * @param {string} id
 * @param {Record<string, unknown>} [extra]
 */
function metaOf(id, extra = {}) {
  return {
    ...emptyMeta(),
    id,
    token: 'relay-a',
    cwd: 'D:/work/x',
    pid: 4242,
    startedAt: '2026-11-04T00:00:00.000Z',
    ...extra,
  };
}

describe('会话 meta 读写', () => {
  test('写 → 读往返；listSessionIds 含它', () => {
    const id = nextId();
    writeSessionMeta(HOME, metaOf(id));
    assert.deepEqual(readSessionMeta(HOME, id), metaOf(id));
    assert.ok(listSessionIds(HOME).includes(id));
  });

  test('退出更新：读-改-写补 endedAt / exitCode，其余字段不动', () => {
    const id = nextId();
    writeSessionMeta(HOME, metaOf(id));
    const meta = readSessionMeta(HOME, id);
    assert.ok(meta);
    writeSessionMeta(HOME, {
      ...meta,
      endedAt: '2026-11-04T01:00:00.000Z',
      exitCode: 0,
    });
    const after = readSessionMeta(HOME, id);
    assert.equal(after?.endedAt, '2026-11-04T01:00:00.000Z');
    assert.equal(after?.exitCode, 0);
    assert.equal(after?.token, 'relay-a');
    assert.equal(after?.pid, 4242);
  });

  test('不存在 / 坏 JSON → null（永不抛）', () => {
    assert.equal(readSessionMeta(HOME, 'nope-1-1'), null);

    const id = nextId();
    const p = sessionMetaPath(HOME, id);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '{ not json', 'utf8');
    assert.equal(readSessionMeta(HOME, id), null);
  });

  test('listSessionIds：非法目录名跳过、按名排序', () => {
    const a = nextId();
    const b = nextId();
    writeSessionMeta(HOME, metaOf(a));
    writeSessionMeta(HOME, metaOf(b));
    ensureDir(join(sessionsDir(HOME), 'BAD NAME'));
    const ids = listSessionIds(HOME);
    assert.ok(ids.includes(a));
    assert.ok(ids.includes(b));
    assert.equal(ids.includes('BAD NAME'), false);
    assert.deepEqual([...ids].sort(), ids);
  });

  test('removeSessionDir：删掉 → 列表里没有了；第二次 false', () => {
    const id = nextId();
    writeSessionMeta(HOME, metaOf(id));
    assert.equal(removeSessionDir(HOME, id), true);
    assert.equal(listSessionIds(HOME).includes(id), false);
    assert.equal(removeSessionDir(HOME, id), false);
  });
});

describe('消息信箱', () => {
  test('投递 → 列出（时间序）→ 读回 → 标记已读（inbox→read 原子迁移）', () => {
    const id = nextId();
    writeSessionMeta(HOME, metaOf(id));
    const a = messageFileName(1_000, 'aa');
    const b = messageFileName(2_000, 'bb');
    writeSessionMessage(HOME, id, a, {
      v: 1, id: 'm1', ts: '2026-11-04T00:00:01.000Z', from: 'human', to: id, type: 'info', body: 'hi',
    });
    writeSessionMessage(HOME, id, b, {
      v: 1, id: 'm2', ts: '2026-11-04T00:00:02.000Z', from: id, to: id, type: 'action-request', body: 'go',
    });

    assert.deepEqual(listSessionMessages(HOME, id), [a, b]);
    assert.equal(readSessionMessage(sessionInboxDir(HOME, id), a)?.body, 'hi');
    assert.equal(readSessionMessage(sessionInboxDir(HOME, id), b)?.type, 'action-request');

    assert.equal(markSessionMessageRead(HOME, id, a), true);
    assert.deepEqual(listSessionMessages(HOME, id), [b]);
    assert.deepEqual(listSessionReadMessages(HOME, id), [a]);
    // 「已读」= 文件的位置：inbox 里没了，read 里有
    assert.equal(readSessionMessage(sessionInboxDir(HOME, id), a), null);
    assert.equal(readSessionMessage(sessionReadDir(HOME, id), a)?.body, 'hi');
  });

  test('坏文件名跳过；坏 JSON 读回 null', () => {
    const id = nextId();
    const inbox = sessionInboxDir(HOME, id);
    ensureDir(inbox);
    writeFileSync(join(inbox, 'junk.json'), 'x', 'utf8');
    const good = messageFileName(3_000, 'cc');
    writeFileSync(join(inbox, good), '{ bad json', 'utf8');

    assert.deepEqual(listSessionMessages(HOME, id), [good]);
    assert.equal(readSessionMessage(inbox, good), null);
  });

  test('removeSessionMessage：删一条；找不到也返回 true（force）', () => {
    const id = nextId();
    const read = sessionReadDir(HOME, id);
    const f = messageFileName(4_000, 'dd');
    writeSessionMessage(HOME, id, f, { body: 'x' });
    markSessionMessageRead(HOME, id, f);
    assert.equal(removeSessionMessage(read, f), true);
    assert.deepEqual(listSessionReadMessages(HOME, id), []);
    assert.equal(removeSessionMessage(read, f), true);
  });

  test('不存在的会话：列表为空、迁移 false（不抛）', () => {
    assert.deepEqual(listSessionMessages(HOME, 'nope-1-1'), []);
    assert.deepEqual(listSessionReadMessages(HOME, 'nope-1-1'), []);
    assert.equal(markSessionMessageRead(HOME, 'nope-1-1', messageFileName(1, 'zz')), false);
  });
});
