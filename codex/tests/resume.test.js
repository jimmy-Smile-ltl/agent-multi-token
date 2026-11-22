// @ts-check
/**
 * `resumeSession()`（`src/cli/resume.js`）的单测。
 *
 * ★ 启动器**注入假函数**：测试里绝不开真窗口（那会污染桌面、在 CI 里必挂）。
 *   断言的是"传出去的 argv 与 opts 对不对"——那才是恢复语义的全部。
 */
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import { resumeSession } from '../src/cli/resume.js';
import { emptyMeta, makeSessionId } from '../src/core/sessions.js';
import { writeSessionMeta } from '../src/core/store.js';

const HOME = nodeFs.mkdtempSync(join(tmpdir(), 'cxt-resume-'));
after(() => {
  try {
    nodeFs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
});

const ctx = {
  platform: process.platform,
  home: HOME,
  env: {},
  cwd: '/repo',
  isTTY: false,
  stdinIsTTY: false,
  configPath: null,
};

let seq = 0;
/** @param {Partial<ReturnType<typeof emptyMeta>>} [extra] */
function addSession(extra = {}) {
  seq += 1;
  const id = makeSessionId({ profile: 'relay-a', at: Date.now() + seq, pid: 100 + seq });
  writeSessionMeta(HOME, {
    ...emptyMeta(),
    id,
    token: 'relay-a',
    cwd: 'D:/work/client-a',
    pid: 4242,
    startedAt: '2026-11-01T00:00:00.000Z',
    endedAt: '2026-11-01T01:00:00.000Z',
    exitCode: 0,
    ...extra,
  });
  return id;
}

/** 假启动器：记下参数，什么都不开。 */
function fakeIo() {
  /** @type {any[]} */
  const plans = [];
  /** @type {any[]} */
  const starts = [];
  return {
    plans,
    starts,
    io: {
      planLaunch: async (/** @type {any} */ argv, /** @type {any} */ _ctx, /** @type {any} */ opts) => {
        plans.push({ argv, opts });
        return { fake: true, argv };
      },
      startLaunch: async (/** @type {any} */ plan) => {
        starts.push(plan);
        return { pid: 1 };
      },
    },
  };
}

describe('resumeSession', () => {
  test('ended 会话 → 同 token、同 cwd、resume:true，quiet 启动', async () => {
    const id = addSession();
    const f = fakeIo();

    const r = await resumeSession(ctx, { id }, f.io);

    assert.equal(r.id, id);
    assert.equal(r.token, 'relay-a');
    assert.equal(f.plans.length, 1);
    assert.deepEqual(f.plans[0].argv, {
      token: 'relay-a',
      cwd: 'D:/work/client-a',
      resume: true,
    });
    assert.deepEqual(f.plans[0].opts, { quiet: true });
    assert.equal(f.starts.length, 1, '启动器要真的被叫一次');
  });

  test('live 会话拒绝，且**不调**启动器', async () => {
    const id = addSession({ endedAt: '', exitCode: null, pid: process.pid });
    const f = fakeIo();
    await assert.rejects(() => resumeSession(ctx, { id }, f.io), /还在跑/);
    assert.equal(f.plans.length, 0);
  });

  test('不存在的 id：报错并列出可恢复的会话', async () => {
    const id = addSession();
    const f = fakeIo();
    await assert.rejects(
      () => resumeSession(ctx, { id: 'nope' }, f.io),
      (err) => err instanceof Error && /没有 id 以 nope 开头/.test(err.message) && (err.hint ?? err.message).includes(id),
    );
    assert.equal(f.plans.length, 0);
  });

  test('前缀匹配到多个 → 拒绝（不猜）', async () => {
    const a = addSession();
    const b = addSession();
    const prefix = a.slice(0, 10); // 同一个 profile 前缀一定相同
    const f = fakeIo();
    await assert.rejects(() => resumeSession(ctx, { id: prefix }, f.io), /说不清是哪一个|匹配到/);
    assert.equal(f.plans.length, 0);
    void b;
  });

  test('纯 defaults 模式（_default）不把占位名当 token 传下去', async () => {
    const id = addSession({ token: '_default' });
    const f = fakeIo();
    await resumeSession(ctx, { id }, f.io);
    assert.deepEqual(f.plans[0].argv, { cwd: 'D:/work/client-a', resume: true });
  });

  test('空 id → 直接报错', async () => {
    const f = fakeIo();
    await assert.rejects(() => resumeSession(ctx, { id: '  ' }, f.io), /要给一个会话 id/);
  });
});
