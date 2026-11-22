// @ts-check
/**
 * `core/sessions.js` 的单测——纯函数，逐条钉死形状与边界。
 *
 * ★ 有一组断言是关于**泄漏面**的（`normalizeSessionMeta` 的白名单）：
 * 在场层永远不许把 argv 之类的字段带进 meta。那个测试不是形状洁癖，
 * 它是"`--token-value` 是明文密钥、meta 不许成为第二个落盘点"的机器守卫。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  DEFAULT_MESSAGE_TYPE,
  MESSAGE_TYPES,
  MESSAGE_VERSION,
  SESSION_STATE,
  SESSIONS_VERSION,
  emptyMeta,
  isValidMessageFileName,
  isValidSessionId,
  makeSessionId,
  messageFileName,
  messageFileTime,
  normalizeMessage,
  normalizeSessionMeta,
  olderThan,
  parseSpan,
  sessionStateOf,
} from '../src/core/sessions.js';

describe('makeSessionId / isValidSessionId', () => {
  test('形状：<profile>-<base36 时间>-<pid>，且自身通过校验', () => {
    const id = makeSessionId({ profile: 'relay-a', at: 1_700_000_000_000, pid: 4242 });
    assert.match(id, /^relay-a-[0-9a-z]+-4242$/);
    assert.equal(isValidSessionId(id), true);
  });

  test('无 profile 落到 _default；时间/pid 非法时降级为 0（不抛）', () => {
    assert.equal(makeSessionId({}), '_default-0-0');
    assert.equal(makeSessionId({ profile: '', at: NaN, pid: -1 }), '_default-0-0');
    assert.equal(makeSessionId({ profile: '_default', at: -5, pid: 1.5 }), '_default-0-0');
  });

  test('同一 profile 不同时间/pid → 不同 id', () => {
    const a = makeSessionId({ profile: 't', at: 1000, pid: 1 });
    const b = makeSessionId({ profile: 't', at: 1000, pid: 2 });
    const c = makeSessionId({ profile: 't', at: 1001, pid: 1 });
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });

  test('校验：合法形状', () => {
    assert.equal(isValidSessionId('relay-a-m1abc-123'), true);
    assert.equal(isValidSessionId('_default-x-1'), true);
    assert.equal(isValidSessionId('a'), true);
  });

  test('校验：拒绝路径穿越 / 大写 / 空格 / 超长 / 非字符串', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', 'A-x-1', 'a b', '', 'x'.repeat(200), null, 42]) {
      assert.equal(isValidSessionId(bad), false, JSON.stringify(bad));
    }
  });
});

describe('normalizeSessionMeta', () => {
  test('完整往返：九个键，逐字保留', () => {
    const meta = normalizeSessionMeta({
      v: 99,
      id: 'relay-a-m1-1',
      token: 'relay-a',
      cwd: 'D:/work/x',
      pid: 1234,
      startedAt: '2026-11-04T00:00:00.000Z',
      endedAt: '',
      exitCode: null,
      model: 'deepseek-flash',
    });
    assert.deepEqual(meta, {
      v: SESSIONS_VERSION,
      id: 'relay-a-m1-1',
      token: 'relay-a',
      cwd: 'D:/work/x',
      pid: 1234,
      startedAt: '2026-11-04T00:00:00.000Z',
      endedAt: '',
      exitCode: null,
      model: 'deepseek-flash',
    });
  });

  test('★★ 白名单：argv / 密钥类字段一个都进不来', () => {
    const meta = normalizeSessionMeta({
      id: 'x-1-2',
      argv: ['--model', 'm', '--token-value', 'sk-test-THIS-MUST-NOT-LAND'],
      authToken: 'sk-test-THIS-MUST-NOT-LAND',
      token: 'relay-a',
    });
    assert.deepEqual(Object.keys(meta).sort(), [
      'cwd', 'endedAt', 'exitCode', 'id', 'model', 'pid', 'startedAt', 'token', 'v',
    ]);
    const text = JSON.stringify(meta);
    assert.equal(text.includes('sk-test'), false, 'meta 里出现了密钥形状的串');
    assert.equal('argv' in meta, false);
  });

  test('非对象 → 全默认；fallbackId 兜底', () => {
    for (const raw of [null, 'x', 42, []]) {
      assert.deepEqual(normalizeSessionMeta(raw, 'dir-name'), { ...emptyMeta(), id: 'dir-name' });
    }
  });

  test('exitCode：数字截断；非数字 → null（0 是合法退出码，别和 null 混）', () => {
    assert.equal(normalizeSessionMeta({ exitCode: 0 }).exitCode, 0);
    assert.equal(normalizeSessionMeta({ exitCode: 3.9 }).exitCode, 3);
    assert.equal(normalizeSessionMeta({ exitCode: '3' }).exitCode, null);
    assert.equal(normalizeSessionMeta({ exitCode: NaN }).exitCode, null);
  });
});

describe('sessionStateOf', () => {
  test('live：没有 endedAt 且 pid 活', () => {
    assert.equal(sessionStateOf({ endedAt: '' }, true), SESSION_STATE.LIVE);
  });
  test('dead：没有 endedAt 但 pid 死了', () => {
    assert.equal(sessionStateOf({ endedAt: '' }, false), SESSION_STATE.DEAD);
  });
  test('ended：有 endedAt，无论 pid 死活', () => {
    assert.equal(sessionStateOf({ endedAt: '2026-11-04T00:00:00Z' }, true), SESSION_STATE.ENDED);
    assert.equal(sessionStateOf({ endedAt: '2026-11-04T00:00:00Z' }, false), SESSION_STATE.ENDED);
  });
  test('null / undefined → dead', () => {
    assert.equal(sessionStateOf(null, true), SESSION_STATE.DEAD);
    assert.equal(sessionStateOf(undefined, true), SESSION_STATE.DEAD);
  });
});

describe('normalizeMessage', () => {
  test('完整往返：七个键', () => {
    const msg = normalizeMessage({
      v: 9,
      id: 'm1',
      ts: '2026-11-04T00:00:00.000Z',
      from: 'human',
      to: 'relay-a-m1-1',
      type: 'action-request',
      body: '看一下 auth',
      extra: 'dropped',
    });
    assert.deepEqual(msg, {
      v: MESSAGE_VERSION,
      id: 'm1',
      ts: '2026-11-04T00:00:00.000Z',
      from: 'human',
      to: 'relay-a-m1-1',
      type: 'action-request',
      body: '看一下 auth',
    });
  });

  test('认不出的 type 降级成 info，消息不丢', () => {
    assert.equal(normalizeMessage({ type: 'task' })?.type, DEFAULT_MESSAGE_TYPE);
    assert.equal(MESSAGE_TYPES.includes('task'), false);
  });

  test('缺字段补空串；非对象 → null', () => {
    assert.deepEqual(normalizeMessage({})?.body, '');
    assert.deepEqual(normalizeMessage({})?.from, '');
    assert.equal(normalizeMessage(null), null);
    assert.equal(normalizeMessage('x'), null);
    assert.equal(normalizeMessage([]), null);
  });
});

describe('messageFileName', () => {
  test('形状：<ms>-<rand>.json，且自身通过校验', () => {
    const name = messageFileName(1_700_000_000_123, 'a1b2');
    assert.equal(name, '1700000000123-a1b2.json');
    assert.equal(isValidMessageFileName(name), true);
  });
  test('rand 非法 → 000000 兜底；时间非法 → 0', () => {
    assert.equal(messageFileName(1000, 'BAD!'), '1000-000000.json');
    assert.equal(messageFileName(-1, 'ab'), '0-ab.json');
  });
  test('校验：拒绝非文件名', () => {
    for (const bad of ['x.json', '123.json', '123-ab.txt', '../123-ab.json', null]) {
      assert.equal(isValidMessageFileName(bad), false, String(bad));
    }
  });

  test('messageFileTime：从文件名取毫秒；不合法 → NaN', () => {
    assert.equal(messageFileTime('1700000000123-ab.json'), 1_700_000_000_123);
    assert.equal(Number.isNaN(messageFileTime('x.json')), true);
    assert.equal(Number.isNaN(messageFileTime(null)), true);
  });
});

describe('parseSpan', () => {
  test('m/h/d 三种单位', () => {
    assert.equal(parseSpan('90m'), 90 * 60_000);
    assert.equal(parseSpan('12h'), 12 * 3_600_000);
    assert.equal(parseSpan('30d'), 30 * 86_400_000);
    assert.equal(parseSpan(' 7d '), 7 * 86_400_000);
  });
  test('认不出 → null（不猜）', () => {
    for (const bad of ['30', 'd', '1w', '1.5d', '-3d', '', null, 42]) {
      assert.equal(parseSpan(bad), null, String(bad));
    }
  });
});

describe('olderThan', () => {
  const now = '2026-11-04T00:00:00.000Z';
  test('超过阈值才算', () => {
    assert.equal(olderThan('2026-10-20T00:00:00.000Z', now, 7 * 86_400_000), true);
    assert.equal(olderThan('2026-11-03T00:00:00.000Z', now, 7 * 86_400_000), false);
  });
  test('空串 / 解析不出 / 未来 → 一律不算（不敢删就不删）', () => {
    assert.equal(olderThan('', now, 1), false);
    assert.equal(olderThan('not-a-date', now, 1), false);
    assert.equal(olderThan('2027-01-01T00:00:00.000Z', now, 1), false);
  });
  test('边界：恰好等于阈值算超龄（>=）', () => {
    assert.equal(olderThan('2026-10-28T00:00:00.000Z', now, 7 * 86_400_000), true);
  });
});
