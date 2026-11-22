// @ts-check
/**
 * `cxt msg` —— 文件信箱的端到端测试（真起 bin，沙箱 home）。
 *
 * ★ 收件人必须是**活会话**：用本测试进程的 pid 造 live、已退出子进程的 pid 造 dead。
 * ★ 判据集中在三条语义：
 *   ① 消息是文件（inbox → read 是 rename）；
 *   ② `from` 靠 `CXT_SESSION_ID` 识别，会话外就是 `human`；
 *   ③ 死会话拒收（静默丢弃是最坏的失败）。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { emptyMeta, makeSessionId, messageFileName } from '../src/core/sessions.js';
import { sessionInboxDir, sessionReadDir } from '../src/core/paths.js';
import { listSessionMessages, listSessionReadMessages, writeSessionMeta } from '../src/core/store.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CXT = join(ROOT, 'bin', 'cxt.js');

const HOME = nodeFs.mkdtempSync(join(tmpdir(), 'cxt-msg-'));
after(() => {
  try {
    nodeFs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* 临时目录删不掉不影响结论 */
  }
});

const ctx = { home: HOME };

/** @param {string} profile @param {number} pid @param {string} [startedAt] */
function addSession(profile, pid, startedAt = new Date().toISOString()) {
  const id = makeSessionId({ profile, at: Date.now() + Math.floor(Math.random() * 1000), pid });
  writeSessionMeta(HOME, {
    ...emptyMeta(),
    id,
    token: profile,
    cwd: `D:/work/${profile}`,
    pid,
    startedAt,
  });
  return id;
}

/** @param {number} pid */
function exitedPid() {
  const child = spawnSync(process.execPath, ['-e', '']);
  return /** @type {number} */ (child.pid);
}

/**
 * @param {string[]} argv
 * @param {Record<string, string>} [extraEnv]
 */
function runCli(argv, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CXT, 'msg', ...argv], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: HOME, HOME, ...extraEnv },
    cwd: ROOT,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('msg send', () => {
  test('--token 投给活会话；消息形状完整，from=human', () => {
    const a = addSession('relay-a', process.pid);
    const r = runCli(['send', '--token', 'relay-a', '你好', '呀']);
    assert.equal(r.code, 0, r.err);

    const files = listSessionMessages(HOME, a);
    assert.equal(files.length, 1);
    const raw = nodeFs.readFileSync(join(sessionInboxDir(HOME, a), files[0]), 'utf8');
    const msg = JSON.parse(raw);
    assert.equal(msg.v, 1);
    assert.equal(msg.from, 'human');
    assert.equal(msg.to, a);
    assert.equal(msg.type, 'info');
    assert.equal(msg.body, '你好 呀', '正文是剩余位置参数拼接');
    assert.ok(msg.ts);
  });

  test('id 前缀定位；--type action-request 被如实记录', () => {
    const b = addSession('relay-b', process.pid);
    const r = runCli(['send', b.slice(0, 12), '--type', 'action-request', '去跑测试']);
    assert.equal(r.code, 0, r.err);

    const files = listSessionMessages(HOME, b);
    assert.equal(files.length, 1);
    const msg = JSON.parse(nodeFs.readFileSync(join(sessionInboxDir(HOME, b), files[0]), 'utf8'));
    assert.equal(msg.type, 'action-request');
    assert.equal(msg.body, '去跑测试');
  });

  test('从会话里发（CXT_SESSION_ID 在环境里）→ from 是那个会话', () => {
    const from = addSession('relay-from', process.pid);
    const to = addSession('relay-to', process.pid);
    const r = runCli(['send', to.slice(0, 12), '回信'], { CXT_SESSION_ID: from });
    assert.equal(r.code, 0, r.err);

    const files = listSessionMessages(HOME, to);
    const msg = JSON.parse(nodeFs.readFileSync(join(sessionInboxDir(HOME, to), files[0]), 'utf8'));
    assert.equal(msg.from, from);
  });

  test('★ 死会话拒收（不静默丢弃）；空正文报错；坏 type 报错', () => {
    const deadPid = exitedPid();
    const dead = makeSessionId({ profile: 'relay-dead', at: 5, pid: deadPid });
    writeSessionMeta(HOME, {
      ...emptyMeta(),
      id: dead,
      token: 'relay-dead',
      cwd: 'D:/d',
      pid: deadPid,
      startedAt: '2026-01-01T00:00:00.000Z',
    });

    const r1 = runCli(['send', dead.slice(0, 12), '喂']);
    assert.equal(r1.code, 1);
    assert.match(r1.err, /没有 id 以|在跑/);

    const live = addSession('relay-live2', process.pid);

    const r2 = runCli(['send', '--token', 'relay-live2', '']);
    assert.equal(r2.code, 1);

    const r3 = runCli(['send', '--token', 'relay-live2', '--type', 'task', 'x']);
    assert.equal(r3.code, 1);
    assert.match(r3.err, /认不出的消息类型/);

    void live;
  });
});

describe('msg inbox', () => {
  test('默认读完即标记已读：inbox → read（rename 语义）', () => {
    const s = addSession('relay-inbox', process.pid);
    runCli(['send', s.slice(0, 12), '第一条']);
    runCli(['send', s.slice(0, 12), '第二条']);

    const r1 = runCli(['inbox', '--session', s.slice(0, 12)]);
    assert.equal(r1.code, 0, r1.err);
    assert.match(r1.out, /第一条/);
    assert.match(r1.out, /第二条/);
    assert.match(r1.out, /已标记为已读/);

    assert.equal(listSessionMessages(HOME, s).length, 0, 'inbox 应已清空');
    assert.equal(listSessionReadMessages(HOME, s).length, 2, 'read 应有两份');

    const r2 = runCli(['inbox', '--session', s.slice(0, 12)]);
    assert.match(r2.out, /没有未读消息/);
  });

  test('--peek 只看不动；--json 形状可解析', () => {
    const s = addSession('relay-peek', process.pid);
    runCli(['send', s.slice(0, 12), '别动我']);

    const r1 = runCli(['inbox', '--session', s.slice(0, 12), '--peek', '--json']);
    assert.equal(r1.code, 0, r1.err);
    const rows = JSON.parse(r1.out);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, '别动我');
    assert.equal(listSessionMessages(HOME, s).length, 1, '--peek 不许改状态');
  });
});

describe('msg gc', () => {
  test('超龄文件删掉、新鲜的留下；年龄取自文件名', () => {
    const s = addSession('relay-gc', process.pid);
    const oldFile = messageFileName(Date.now() - 10 * 86_400_000, 'aa');
    const freshFile = messageFileName(Date.now(), 'bb');
    nodeFs.mkdirSync(sessionInboxDir(HOME, s), { recursive: true });
    nodeFs.mkdirSync(sessionReadDir(HOME, s), { recursive: true });
    nodeFs.writeFileSync(join(sessionInboxDir(HOME, s), oldFile), '{"body":"old"}', 'utf8');
    nodeFs.writeFileSync(join(sessionReadDir(HOME, s), freshFile), '{"body":"fresh"}', 'utf8');

    const r = runCli(['gc', '--older-than', '7d']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /删掉 1 条/);
    assert.deepEqual(listSessionMessages(HOME, s), []);
    assert.deepEqual(listSessionReadMessages(HOME, s), [freshFile]);

    const bad = runCli(['gc', '--older-than', '7']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /older-than/);
  });
});
