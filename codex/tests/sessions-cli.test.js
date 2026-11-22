// @ts-check
/**
 * 会话在场层的 **CLI 层**（`src/cli/sessions.js`）与 `sessions` 命令的测试。
 *
 * ★ 沙箱 home（`mkdtempSync`），绝不碰真实状态目录。
 * ★ 三态用**真事实**造：本进程 = live、已退出子进程 = dead、手工补 endedAt = ended。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { activeTokensOf, listSessions, pruneSessions, recordSessionEnd, recordSessionStart } from '../src/cli/sessions.js';
import { emptyMeta, makeSessionId } from '../src/core/sessions.js';
import { writeSessionMessage, writeSessionMeta } from '../src/core/store.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CXT = join(ROOT, 'bin', 'cxt.js');

const HOME = nodeFs.mkdtempSync(join(tmpdir(), 'cxt-sessions-'));
after(() => {
  try {
    nodeFs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
});

function ctxOf() {
  return {
    platform: process.platform,
    home: HOME,
    env: {},
    cwd: ROOT,
    isTTY: false,
    stdinIsTTY: false,
    configPath: null,
  };
}

/** @param {string} id @param {Record<string, unknown>} [extra] */
function metaOf(id, extra = {}) {
  return {
    ...emptyMeta(),
    id,
    token: 'relay-a',
    cwd: 'D:/work/x',
    pid: 1,
    startedAt: '2026-11-04T00:00:00.000Z',
    ...extra,
  };
}

/** 跑一次 `cxt sessions`（沙箱 home）。 */
function runCli(argv) {
  const r = spawnSync(process.execPath, [CXT, 'sessions', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: HOME, HOME },
    cwd: ROOT,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('recordSessionStart / End', () => {
  test('启动写一条 live 记录（pid = 本进程）；退出补 endedAt/exitCode', () => {
    const ctx = ctxOf();
    const rec = recordSessionStart(ctx, {
      resolved: {
        profileName: 'relay-a',
        cwd: 'D:/work/x',
        models: { value: [{ id: 'deepseek-flash' }] },
      },
    });
    assert.ok(rec);

    const live = listSessions(ctx).find((s) => s.id === rec.id);
    assert.ok(live);
    assert.equal(live.state, 'live');
    assert.equal(live.meta.token, 'relay-a');
    assert.equal(live.meta.model, 'deepseek-flash');
    assert.equal(live.meta.pid, process.pid);
    assert.equal('argv' in live.meta, false);

    recordSessionEnd(ctx, rec.id, 3);
    const ended = listSessions(ctx).find((s) => s.id === rec.id);
    assert.equal(ended?.state, 'ended');
    assert.equal(ended?.meta.exitCode, 3);
    assert.ok(ended?.meta.endedAt);
  });

  test('activeTokensOf：只收 live 的 token', () => {
    const ctx = ctxOf();
    const live = recordSessionStart(ctx, { resolved: { profileName: 'relay-live', cwd: 'D:/x' } });
    const dead = makeSessionId({ profile: 'relay-dead', at: 1, pid: 1 });
    writeSessionMeta(ctx.home, metaOf(dead));
    const set = activeTokensOf(ctx);
    assert.equal(set.has('relay-live'), true);
    assert.equal(set.has('relay-dead'), false);
    if (live) recordSessionEnd(ctx, live.id, 0); // 收拾干净，别干扰同文件后面的用例
  });
});

describe('三态判定（用真进程）', () => {
  test('已退出子进程的 pid → dead', () => {
    const ctx = ctxOf();
    const child = spawnSync(process.execPath, ['-e', '']);
    const pid = /** @type {number} */ (child.pid);
    const id = makeSessionId({ profile: 'relay-gone', at: 2, pid });
    writeSessionMeta(ctx.home, metaOf(id, { pid, startedAt: '2026-11-04T00:00:00.000Z' }));

    const row = listSessions(ctx).find((s) => s.id === id);
    assert.equal(row?.state, 'dead');
    assert.equal(row?.alive, false);
  });
});

describe('pruneSessions', () => {
  test('超龄 ended 删掉；live 永不删；未读要 --force', () => {
    const ctx = ctxOf();
    const now = new Date('2026-11-04T00:00:00.000Z');
    const old = '2026-08-01T00:00:00.000Z'; // 95 天前
    const day = 86_400_000;
    const span = 30 * day;

    const idOld = makeSessionId({ profile: 'relay-old', at: 10, pid: 10 });
    writeSessionMeta(ctx.home, metaOf(idOld, { startedAt: old, endedAt: old, exitCode: 0 }));

    const idUnread = makeSessionId({ profile: 'relay-unread', at: 11, pid: 11 });
    writeSessionMeta(ctx.home, metaOf(idUnread, { startedAt: old, endedAt: old, exitCode: 0 }));
    writeSessionMessage(ctx.home, idUnread, '1754000000000-aa.json', {
      v: 1, id: 'm1', ts: old, from: 'human', to: idUnread, type: 'info', body: '看这个',
    });

    const live = recordSessionStart(ctx, { resolved: { profileName: 'relay-new', cwd: 'D:/x' } });
    assert.ok(live);

    const r1 = pruneSessions(ctx, { olderThanMs: span, now });
    assert.deepEqual(r1.removed, [idOld]);
    assert.equal(r1.keptUnread.includes(idUnread), true);
    assert.equal(r1.keptLive >= 1, true);

    const r2 = pruneSessions(ctx, { olderThanMs: span, now, force: true });
    assert.equal(r2.removed.includes(idUnread), true);

    // live 的还在
    const ids = listSessions(ctx).map((s) => s.id);
    assert.equal(ids.includes(/** @type {{id:string}} */ (live).id), true);
    recordSessionEnd(ctx, /** @type {{id:string}} */ (live).id, 0);
  });
});

describe('cxt sessions 命令（端到端）', () => {
  test('--json 输出可解析，含 live 与未读字段', () => {
    const ctx = ctxOf();
    const rec = recordSessionStart(ctx, { resolved: { profileName: 'relay-json', cwd: 'D:/p' } });
    assert.ok(rec);
    writeSessionMessage(ctx.home, rec.id, '1754000000001-bb.json', {
      v: 1, id: 'm2', ts: '2026-10-31T00:00:00.001Z', from: 'human', to: rec.id, type: 'info', body: 'hi',
    });

    const r = runCli(['--json']);
    assert.equal(r.code, 0, r.err);
    const rows = JSON.parse(r.out);
    const row = rows.find((x) => x.id === rec.id);
    assert.ok(row, '新会话不在 sessions --json 输出里');
    assert.equal(row.state, 'live');
    assert.equal(row.unread, 1);
    assert.equal(row.token, 'relay-json');
    recordSessionEnd(ctx, rec.id, 0);
  });

  test('--older-than 认不出 → 退出码 1，并说清单位', () => {
    const r = runCli(['prune', '--older-than', '30']);
    assert.equal(r.code, 1);
    assert.match(r.err, /older-than/);
    assert.match(r.err, /m \/ h \/ d|m\/h\/d/);
  });
});
