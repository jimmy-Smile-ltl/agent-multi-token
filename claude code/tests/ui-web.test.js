// @ts-check
/**
 * `cmt ui --web` 的内核（§2.12 十一）——**视图模型**与**表单动作那一段**。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这份文件守的是什么
 *
 * 网页控制台有**三段**，只有中间那段是新的：
 *
 * ```
 *   serve-web.js（HTTP/安全）  ← tests/serve-web.test.js
 *   ui-web.js（视图模型 + 翻译） ← **本文件**
 *   ui/app.js（reducer）        ← tests/app.test.js
 * ```
 *
 * 所以这里**不重测**状态迁移——`app.test.js` 已经把 `panel` 事件族的每个 op
 * 穷举过了，再抄一遍只是把同一份断言写两处。这里管的是**两层之间的那道缝**：
 *
 * | # | 断言 | 为什么它值一条测试 |
 * |---|---|---|
 * | 1 | **视图模型的黄金形状** | 它是**跨项目**的接口，而两个项目各写各的 `ui-web.js`。少一个键只在**那一个**项目里坏 |
 * | 2 | **视图模型里没有明文密钥** | 一个 `console.log(view)` 就能把 sk 写进终端回滚 |
 * | 3 | **视图模型可 JSON 往返** | 它要过 HTTP；带个 `undefined` 或函数就静默丢字段 |
 * | 4 | **`toEvent` 是白名单** | 事件对象进 reducer，而 reducer 决定要不要写盘 |
 * | 5 | **每个 effect 恰好回执一次** | 今天只是**隐式**不变量，而整个"不需要关联 id"的设计都架在它上面 |
 * | 6 | **`apply()` 回来时状态一定静止** | `pending` 卡住 = 页面永远转圈，且没有任何出口 |
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPanelData, makeExecutor, makeSession } from '../src/cli/commands/ui.js';
import {
  CUSTOM_URL, loadAssets, makeOps, toEvent, viewModel,
} from '../src/cli/commands/ui-web.js';
import { initialState, reduce } from '../src/cli/ui/app.js';
import { profileDir } from '../src/core/paths.js';
import { emptyMeta, makeSessionId } from '../src/core/sessions.js';
import {
  listSessionMessages, listSessionReadMessages, writeSessionMessage, writeSessionMeta,
} from '../src/core/store.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/** 一次性丢弃的测试密钥。★ 绝不用真 key——这份文件会被读、被复制。 */
const FAKE_KEY = 'sk-test-9999';

/** 长名基准（`os.tmpdir()` 给的是 8.3 短名，见 token-e2e 的说明） */
const TMP_BASE = nodeFs.realpathSync.native(tmpdir());

const ROOTS = [];
after(() => {
  for (const r of ROOTS) {
    try {
      nodeFs.rmSync(r, { recursive: true, force: true });
    } catch { /* 删不掉就算了 */ }
  }
});

/**
 * 一个沙箱：临时 home + 一个项目目录。
 *
 * ★ 与 `ui-e2e.test.js` 那份的差别：**这里不 spawn 子进程**——直接造一个
 *   `Ctx` 交给函数。`loadState(ctx)` 只认 `ctx.home`（`core/paths.js` 的
 *   `rootDir(home)`），所以"临时 home"这条路在单元测试里同样成立，
 *   而且比 e2e 快两个数量级。
 *
 * @param {{ config?: any, tokens?: Record<string, any>, project?: any }} [opts]
 */
function setup(opts = {}) {
  const root = nodeFs.mkdtempSync(join(TMP_BASE, 'cmt-web-'));
  ROOTS.push(root);
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  const appDir = join(home, '.claude-multi-token');
  nodeFs.mkdirSync(join(appDir, 'tokens'), { recursive: true });
  nodeFs.mkdirSync(proj, { recursive: true });

  const write = (p, obj) => nodeFs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  if (opts.config !== undefined) write(join(appDir, 'config.json'), opts.config);
  for (const [name, obj] of Object.entries(opts.tokens ?? {})) {
    write(join(appDir, 'tokens', `${name}.json`), obj);
  }
  if (opts.project !== undefined) write(join(proj, '.cmt.json'), opts.project);

  const ctx = {
    platform: /** @type {NodeJS.Platform} */ ('win32'),
    home,
    env: {},
    cwd: proj,
    isTTY: false,
    stdinIsTTY: false,
    configPath: null,
  };

  return {
    root, home, proj, appDir, ctx,
    readConfig: () => JSON.parse(nodeFs.readFileSync(join(appDir, 'config.json'), 'utf8')),
    /** 会话（真执行器 + 真 reducer），网页桥要的就是它 */
    session: () => makeSession(ctx, initialState(buildPanelData(ctx))),
  };
}

/** 一条绑定 + 一个 token 的标准沙箱 */
const full = (over = {}) => setup({
  config: {
    version: 1,
    defaults: {},
    bindings: [{ path: join(TMP_BASE, 'x', 'client-a'), token: 'relay-z' }],
  },
  tokens: { 'relay-z': { authToken: FAKE_KEY, name: 'relay-z' } },
  project: { version: 1, token: 'relay-z', models: [{ id: 'keep-me' }] },
  ...over,
});

/** 把一串事件喂进纯 reducer（造 `viewModel()` 的输入用） */
function run(state, evs) {
  let s = state;
  for (const e of evs) s = reduce(s, e).state;
  return s;
}

/**
 * 起一个**真的**回环桩服务器：`GET /models` 回 `{data:[{id},…]}`。
 *
 * ★ 为什么不用注入一个假 `fetch`：这里要验的是 `ui.js` → `fetch-models.js`
 *   → 真 HTTP 这**一整条链**，换掉 fetch 就等于把最靠近边界的那一段挖走。
 *   端口用 `0`（系统分配）——**别写死 8080**，那是在赌跑测的机器上没人占着。
 * ★ 只绑 `127.0.0.1`：桩服务器绝不该对外可达。
 *
 * @param {(string | Record<string, unknown>)[]} ids
 *   给字符串就是 `{id}`；给对象就**原样**回（要带 `pricing` 时用这个）
 * @param {string} [path] 桩只认这个路径，别的回 404
 */
async function modelStub(ids, path = '/models') {
  /** @type {{ url: string, auth: string }[]} */
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ url: req.url ?? '', auth: req.headers.authorization ?? '' });
    if (req.url !== path) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: ids.map((it) => (typeof it === 'string' ? { id: it } : it)),
    }));
  });
  await new Promise((/** @type {(v?: any) => void} */ resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {{ port: number }} */ (server.address()).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((/** @type {(v?: any) => void} */ resolve) => server.close(resolve)),
  };
}

// ═══════════════════════════ 视图模型 ═══════════════════════════

describe('★★ 视图模型：跨项目冻结的那个形状', () => {
  test('★★ 黄金形状——顶层键集**一个不多一个不少**', () => {
    const s = full();
    const v = viewModel(s.session().state);

    assert.deepEqual(Object.keys(v).sort(), [
      'appName', 'attention', 'confirm', 'cwd', 'defaultsEnv', 'items', 'notice',
      'pending', 'poolStatuses', 'projectFile', 'quitting', 'recentSessions',
      'resources', 'resourcesSummary', 'screen', 'sessions', 'statusFile',
      'statuses', 'tokens', 'wizard',
    ]);
    // ★ 工具名**只**从 `data` 出去——这个文件里不写死 `cmt`
    assert.equal(v.appName, 'cmt');
    assert.equal(v.cwd, s.proj);
    assert.equal(v.projectFile, '.cmt.json');
    // ★ 状态表在哪儿：绝对路径，且落在**临时 home** 里（不是真的家目录）
    assert.equal(v.statusFile, join(s.appDir, 'projects.json'));
    assert.equal(v.screen, 'list');
    assert.equal(v.wizard, null, '没进向导时是 null，不是 {}');
    // ★★ 起手没在退出。页面靠这个位把自己关掉（`web/app.js` 的 `takeView()`），
    //    所以它**必须**在，而且**必须**是布尔——不是 `undefined`、不是 `'true'`。
    assert.equal(v.quitting, false);
  });

  test('★★ 会话条：只给 live、七个键恒定（池状态两个子键也是）', () => {
    const s = full();

    // 一条真活（pid = 本进程）+ 一条已退出（有 endedAt）——面板只该看见活的。
    const liveId = makeSessionId({ profile: 'relay-z', at: Date.now(), pid: process.pid });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: liveId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: process.pid,
      startedAt: '2026-11-04T00:00:00.000Z',
    });
    const endedId = makeSessionId({ profile: 'relay-z', at: Date.now() - 5000, pid: process.pid });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: endedId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: process.pid,
      startedAt: '2026-11-03T00:00:00.000Z',
      endedAt: '2026-11-03T01:00:00.000Z',
      exitCode: 0,
    });
    writeSessionMessage(s.home, liveId, '1754000000000-aa.json', {
      v: 1, id: 'm1', ts: '2026-11-04T00:00:01.000Z', from: 'human', to: liveId, type: 'info', body: 'hi',
    });

    const v = viewModel(s.session().state);
    assert.equal(v.sessions.length, 1, 'ended / dead 不进面板（只进 sessions 命令）');
    assert.equal(v.sessions[0].id, liveId);
    assert.equal(v.sessions[0].unread, 1);
    assert.deepEqual(Object.keys(v.sessions[0]).sort(), [
      'cwd', 'id', 'pid', 'pool', 'startedAt', 'token', 'unread',
    ]);
    // ★ 池状态的两个键：状态词 + 算好的中文（中文只在 `core/pool.js` 定义一处）
    assert.deepEqual(Object.keys(v.sessions[0].pool).sort(), ['label', 'status']);
    assert.equal(v.sessions[0].pool.status, 'unknown', '没入池 = unknown');
    assert.equal(v.sessions[0].pool.label, '未检测');
  });

  test('msg-read-all：把会话的未读移进 read；不存在的会话只给一句 notice', async () => {
    const s = full();
    const liveId = makeSessionId({ profile: 'relay-z', at: Date.now(), pid: process.pid });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: liveId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: process.pid,
      startedAt: '2026-11-04T00:00:00.000Z',
    });
    writeSessionMessage(s.home, liveId, '1754000000000-aa.json', {
      v: 1, id: 'm1', ts: '2026-11-04T00:00:01.000Z', from: 'human', to: liveId, type: 'info', body: 'hi',
    });

    const ops = makeOps(s.session(), s.ctx);
    const r1 = await ops.apply({ op: 'msg-read-all', session: liveId });
    assert.match(r1.view.notice, /已把 1 条标为已读/);
    assert.equal(listSessionMessages(s.home, liveId).length, 0);
    assert.equal(listSessionReadMessages(s.home, liveId).length, 1);

    const r2 = await ops.apply({ op: 'msg-read-all', session: 'nope-1-1' });
    assert.match(r2.view.notice, /没有这个会话/);
  });

  test('★★ 最近关闭：24 小时内的 ended/dead 进视图，九个键恒定（池状态两个子键）', () => {
    const s = full();
    const now = Date.now();

    const endedId = makeSessionId({ profile: 'relay-z', at: now - 3_600_000, pid: 9 });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: endedId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: 9,
      startedAt: new Date(now - 7_200_000).toISOString(),
      endedAt: new Date(now - 3_600_000).toISOString(),
      exitCode: 0,
    });

    // 太老的（>24h）不该进——"恢复刚才关掉的"是友好，"列一周前的历史"是噪音
    const oldId = makeSessionId({ profile: 'relay-z', at: now - 48 * 3_600_000, pid: 10 });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: oldId,
      token: 'relay-z',
      cwd: '/tmp/old',
      pid: 10,
      startedAt: new Date(now - 49 * 3_600_000).toISOString(),
      endedAt: new Date(now - 48 * 3_600_000).toISOString(),
      exitCode: 0,
    });

    const liveId = makeSessionId({ profile: 'relay-z', at: now, pid: process.pid });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: liveId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
    });

    const v = viewModel(s.session().state);
    assert.deepEqual(v.recentSessions.map((r) => r.id), [endedId]);
    assert.deepEqual(Object.keys(v.recentSessions[0]).sort(), [
      'cwd', 'endedAt', 'exitCode', 'id', 'pool', 'startedAt', 'state', 'token', 'unread',
    ]);
    assert.deepEqual(Object.keys(v.recentSessions[0].pool).sort(), ['label', 'status']);
    assert.equal(v.recentSessions[0].state, 'ended');
  });

  test('resume-session：校验视图里的会话；启动器注入假函数（测试里绝不弹真窗口）', async () => {
    const s = full();
    const now = Date.now();
    const id = makeSessionId({ profile: 'relay-z', at: now - 1000, pid: 9 });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: 9,
      startedAt: new Date(now - 5000).toISOString(),
      endedAt: new Date(now - 1000).toISOString(),
      exitCode: 0,
    });

    const calls = [];
    const ops = makeOps(s.session(), s.ctx, {
      resumeSession: async (/** @type {any} */ _ctx, /** @type {any} */ input) => {
        calls.push(input.id);
        return { id: input.id, token: 'relay-z', cwd: '/tmp/work' };
      },
    });

    const ok = await ops.apply({ op: 'resume-session', session: id });
    assert.match(ok.view.notice, /已在新窗口恢复 relay-z/);
    assert.deepEqual(calls, [id]);

    const bad = await ops.apply({ op: 'resume-session', session: 'nope-1-1' });
    assert.match(bad.view.notice, /没有这个会话/);
    assert.deepEqual(calls, [id], '校验失败时不许调用启动器');
  });

describe('★★ 需要你处理：服务端算好的注意力清单', () => {
  test('健康 → 空数组（页面整块不显示）', () => {
    const s = full();
    assert.deepEqual(viewModel(s.session().state).attention, []);
  });

  test('未读纸条：已关闭的排前面（high + 恢复动作），live 的 normal 只有「标已读」', () => {
    const s = full();
    const now = Date.now();

    const liveId = makeSessionId({ profile: 'relay-z', at: now, pid: process.pid });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: liveId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
    });
    writeSessionMessage(s.home, liveId, '1754000000000-aa.json', {
      v: 1, id: 'm1', ts: new Date(now).toISOString(), from: 'human', to: liveId, type: 'question',
      body: 'auth 分支\n要怎么改？',
    });

    const closedId = makeSessionId({ profile: 'relay-z', at: now - 600_000, pid: 9 });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: closedId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: 9,
      startedAt: new Date(now - 3_600_000).toISOString(),
      endedAt: new Date(now - 600_000).toISOString(),
      exitCode: 0,
    });
    writeSessionMessage(s.home, closedId, '1754000001000-bb.json', {
      v: 1, id: 'm2', ts: new Date(now - 500_000).toISOString(), from: 'human', to: closedId, type: 'info',
      body: '窗口关前的留言',
    });

    const v = viewModel(s.session().state);
    assert.equal(v.attention.length, 2);

    const closed = v.attention[0];
    assert.equal(closed.kind, 'mail');
    assert.equal(closed.severity, 'high');
    assert.match(closed.title, /已关闭/);
    assert.deepEqual(closed.actions.map((/** @type {any} */ a) => a.op), ['resume-session', 'msg-read-all']);
    assert.deepEqual(closed.actions[0].args, { session: closedId });

    const live = v.attention[1];
    assert.equal(live.kind, 'mail');
    assert.equal(live.severity, 'normal');
    assert.deepEqual(live.actions.map((/** @type {any} */ a) => a.op), ['msg-read-all']);
    assert.equal(live.detail, 'auth 分支 要怎么改？', '正文压成一行短预览');
    assert.deepEqual(Object.keys(live).sort(), ['actions', 'detail', 'kind', 'severity', 'title']);
  });

  test('活会话的钥匙废了 → token-bad（动作 = check-token）', () => {
    const s = full();
    const now = Date.now();
    nodeFs.writeFileSync(join(s.appDir, 'pool.json'), JSON.stringify({
      version: 1,
      entries: { 'relay-z': { status: 'no_quota', detail: '', checkedAt: new Date(now).toISOString() } },
    }, null, 2));
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: makeSessionId({ profile: 'relay-z', at: now, pid: process.pid }),
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: process.pid,
      startedAt: new Date(now).toISOString(),
    });

    const v = viewModel(s.session().state);
    const item = v.attention.find((/** @type {any} */ i) => i.kind === 'token-bad');
    assert.ok(item, '钥匙废了却没有注意力条目');
    assert.equal(item.severity, 'high');
    assert.deepEqual(item.actions, [
      { label: '重新检测', op: 'check-token', args: { name: 'relay-z' } },
    ]);
  });

  test('最近关闭、退出码非 0 → exit-fail（动作 = 恢复；有未读时不重复出现）', () => {
    const s = full();
    const now = Date.now();

    const failId = makeSessionId({ profile: 'relay-z', at: now - 600_000, pid: 11 });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: failId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: 11,
      startedAt: new Date(now - 3_600_000).toISOString(),
      endedAt: new Date(now - 600_000).toISOString(),
      exitCode: 5,
    });

    const withMailId = makeSessionId({ profile: 'relay-z', at: now - 500_000, pid: 12 });
    writeSessionMeta(s.home, {
      ...emptyMeta(),
      id: withMailId,
      token: 'relay-z',
      cwd: '/tmp/work',
      pid: 12,
      startedAt: new Date(now - 3_600_000).toISOString(),
      endedAt: new Date(now - 500_000).toISOString(),
      exitCode: 7,
    });
    writeSessionMessage(s.home, withMailId, '1754000002000-cc.json', {
      v: 1, id: 'm3', ts: new Date(now - 400_000).toISOString(), from: 'human', to: withMailId, type: 'info', body: '喂',
    });

    const v = viewModel(s.session().state);
    const fails = v.attention.filter((/** @type {any} */ i) => i.kind === 'exit-fail');
    assert.equal(fails.length, 1, '有未读的那个已在 mail 条目里，不该重复');
    assert.equal(fails[0].actions[0].op, 'resume-session');
    assert.deepEqual(fails[0].actions[0].args, { session: failId });
  });
});

  test('★★ 点了「退出」之后 `quitting` 翻成 true——页面就靠这一位收工', () => {
    const s = full();
    const st = run(s.session().state, [{ type: 'panel', op: 'quit' }]);
    assert.equal(viewModel(st).quitting, true);
    // ★ 而且它是**终态**：退出之后再点什么都不动了（`ui/app.js` 顶上那道闸门）。
    //   页面据此把控件全关掉，不会出现"点了没反应"。
    const after = run(st, [{ type: 'panel', op: 'reload' }]);
    assert.equal(viewModel(after).quitting, true);
  });

  test('★★ 每一行的键集也钉住（前端逐字一致的那份按名字取值）', () => {
    const s = full();
    const v = viewModel(s.session().state);

    assert.equal(v.items.length, 3, '「当前目录」+ 一条绑定 + 「+ 新建…」');
    assert.deepEqual(v.items.map((/** @type {any} */ i) => i.kind), ['cwd', 'binding', 'new']);
    for (const it of v.items) {
      assert.deepEqual(Object.keys(it).sort(), [
        'active', 'baseUrl', 'index', 'kind', 'label', 'layer', 'masked',
        'modelOptions', 'models', 'path', 'source', 'status', 'token',
      ]);
    }
    assert.deepEqual(v.items.map((/** @type {any} */ i) => i.index), [0, 1, 2]);
    assert.deepEqual(Object.keys(v.tokens[0]).sort(), [
      'baseUrl', 'index', 'label', 'masked', 'name', 'url',
    ]);
    // ★ 资源表：**每个 token 一行**（这一个沙箱只有一个），键集也钉住——
    //   它是跨项目冻结的那一份，少一个键只在**那一个**项目里坏。
    assert.equal(v.resources.length, 1);
    assert.deepEqual(Object.keys(v.resources[0]).sort(), [
      'baseUrl', 'cachedUrl', 'env', 'fetchedAt', 'gatewayCount', 'gatewayUnified', 'label',
      'masked', 'models', 'name', 'pool', 'priority', 'priorityState', 'projects', 'stale',
      'url', 'usage',
    ]);
    // ★ 用量那六个键（§2.13 九 9.3）：没入池 / 没算过也给全零，
    //   而且 `cost` 是 `null` 而不是 0——`0` 会说"免费"。
    assert.deepEqual(Object.keys(v.resources[0].usage).sort(), [
      'calls', 'cost', 'in', 'out', 'syncedAt', 'unpriced',
    ]);
    // ★ 概览那十个键（§2.13 九 9.4）：空池也是一份**完整**的空概览，不是 `null`。
    assert.deepEqual(Object.keys(v.resourcesSummary).sort(), [
      'calls', 'cost', 'costPartial', 'counts', 'in', 'insights', 'out', 'syncedAt',
      'total', 'unpriced',
    ]);
    assert.equal(v.resourcesSummary.total, 1, '一个 token 就是一行');

    // ★ 状态只挂在**文件夹**那两行；另外两行是 `null`（不是缺键）
    assert.deepEqual(v.items.map((/** @type {any} */ i) => i.status === null), [false, false, true]);
    assert.equal(v.items[0].status.id, 'todo', '没设过的项目落在第一档');
    assert.deepEqual(Object.keys(v.items[0].status).sort(), ['color', 'id', 'label']);
  });

  test('★★ 向导那一半的键集', () => {
    const s = full();
    // n 开向导 → Enter 到第 2 步 → Enter 到第 3 步 → 清单到了
    let st = run(s.session().state, [
      { type: 'text', text: 'n' },
      { type: 'key', key: 'enter' },
      { type: 'key', key: 'enter' },
    ]);
    st = run(st, [{ type: 'models', token: st.wizard.token.chosen, ok: true, ids: ['m1', 'm2'], error: '' }]);
    const v = viewModel(st);

    assert.deepEqual(Object.keys(v.wizard).sort(), [
      'edit', 'models', 'notice', 'path', 'step', 'steps', 'token',
    ]);
    assert.equal(v.wizard.step, 3);
    assert.deepEqual(v.wizard.steps.map((/** @type {any} */ x) => x.state), ['done', 'done', 'active', 'todo']);
    assert.deepEqual(v.wizard.steps.map((/** @type {any} */ x) => x.n), [1, 2, 3, 4]);
    assert.deepEqual(Object.keys(v.wizard.path).sort(), ['dirs', 'pending', 'text']);
    assert.deepEqual(Object.keys(v.wizard.token).sort(), [
      'baseUrl', 'chosen', 'mode', 'name', 'notice', 'secretLength', 'urlOptions',
    ]);
    assert.deepEqual(Object.keys(v.wizard.models).sort(), [
      'checked', 'error', 'ids', 'notice', 'phase',
    ]);
  });

  test('★★ `canUp`/`canDown` 是**预先算好**的——浏览器里没有 `index === 0` 这种逻辑', () => {
    const s = full();
    let st = run(s.session().state, [
      { type: 'text', text: 'n' },
      { type: 'key', key: 'enter' },
      { type: 'key', key: 'enter' },
    ]);
    st = run(st, [{ type: 'models', token: st.wizard.token.chosen, ok: true, ids: ['m1', 'm2', 'm3'], error: '' }]);
    st = run(st, [
      { type: 'panel', op: 'toggle-model', id: 'm1' },
      { type: 'panel', op: 'toggle-model', id: 'm2' },
      { type: 'panel', op: 'toggle-model', id: 'm3' },
    ]);

    const checked = viewModel(st).wizard.models.checked;
    assert.deepEqual(checked, [
      { id: 'm1', canUp: false, canDown: true },
      { id: 'm2', canUp: true, canDown: true },
      { id: 'm3', canUp: true, canDown: false },
    ]);
  });

  test('★ 只有一条时两端都按不下去', () => {
    const s = full();
    let st = run(s.session().state, [
      { type: 'text', text: 'n' },
      { type: 'key', key: 'enter' },
      { type: 'key', key: 'enter' },
    ]);
    st = run(st, [{ type: 'models', token: st.wizard.token.chosen, ok: true, ids: ['m1'], error: '' }]);
    st = run(st, [{ type: 'panel', op: 'toggle-model', id: 'm1' }]);
    assert.deepEqual(viewModel(st).wizard.models.checked, [{ id: 'm1', canUp: false, canDown: false }]);
  });

  test('★ `confirm` 摊平成两个字段（**不用 `window.confirm`**：那个测不了）', () => {
    const s = full();
    // ★ 挪光标用 `{type:'key', key:'down'}`——**不是** `{type:'text', text:'j'}`。
    //   两条通道在这里是分开的：`nav()` 只认 `key` 事件里的 `up/down/home/end/pgup/pgdn`，
    //   而 `j` 是 vi 风格的动作键（`app.js` 的 `KEY` 表），它**不动光标**。
    //   页面那边点的是行上的按钮（`{op:'delete', index}`），连光标都不经过。
    const st = run(s.session().state, [{ type: 'key', key: 'down' }, { type: 'text', text: 'd' }]);
    const v = viewModel(st);

    assert.notEqual(v.confirm, null);
    assert.deepEqual(Object.keys(v.confirm).sort(), ['kind', 'label']);
    assert.equal(v.confirm.kind, 'delete-binding');
    assert.ok(v.confirm.label.includes('client-a'), '横幅上要写清楚删的是哪一条');
  });

  test('★★ 明文密钥**永不过线**——视图模型里只有长度', () => {
    const s = full();
    let st = run(s.session().state, [
      { type: 'text', text: 'n' },
      { type: 'key', key: 'enter' },   // 第 2 步
      { type: 'text', text: 'n' },     // 新建 token 态
      { type: 'text', text: 'relay-new' },
      { type: 'key', key: 'tab' },
    ]);
    // 把密钥整串塞进状态（走真路径：逐个字符喂 text）
    const SECRET = 'sk-live-DEADBEEF-0123456789';
    st = run(st, [...SECRET].map((ch) => ({ type: 'text', text: ch })));

    const v = viewModel(st);
    const json = JSON.stringify(v);

    assert.equal(v.wizard.token.secretLength, SECRET.length, '长度要如实报告');
    assert.ok(!json.includes(SECRET), '★ 明文密钥出现在了视图模型里');
    assert.ok(!json.includes('DEADBEEF'), '连一段都不许有');
    assert.ok(!Object.keys(v.wizard.token).includes('secret'), '连键名都不该在');
  });

  test('★★ 可 JSON 往返——它要过 HTTP', () => {
    const s = full();
    const st = run(s.session().state, [
      { type: 'text', text: 'n' },
      { type: 'key', key: 'enter' },
    ]);
    const v = viewModel(st);
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v, '有个字段在 JSON 里活不下来');
  });

  test('★ 向导里也照样可往返（`dirs` 是数组不是别的）', () => {
    const s = full();
    const st = run(s.session().state, [{ type: 'text', text: 'n' }]);
    const v = viewModel(st);
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v);
    assert.ok(Array.isArray(v.wizard.path.dirs));
  });

  test('★ `items[].index` 与数组下标**同源**——页面回传的就是它', () => {
    const s = full();
    const v = viewModel(s.session().state);
    v.items.forEach((/** @type {any} */ it, /** @type {number} */ i) => assert.equal(it.index, i));
  });

  test('★ `detail` 缺了也不炸（读不了的绑定那一行就是这样）', () => {
    const s = setup({ config: { version: 1, defaults: {}, bindings: [] } });
    const v = viewModel(s.session().state);
    for (const it of v.items) {
      assert.equal(typeof it.masked, 'string');
      assert.deepEqual(it.models, []);
      assert.equal(it.active, -1);
    }
  });
});

// ═══════════════════════════ 翻译层 ═══════════════════════════

describe('★★ `toEvent`：白名单，不是黑名单', () => {
  test('★★ 页面多塞的字段**一律不落地**', () => {
    const ev = toEvent({
      op: 'toggle-model',
      id: 'm1',
      // 下面这些页面爱塞什么塞什么
      __proto__: { evil: 1 },
      secret: 'sk-should-not-land',
      models: ['a', 'b'],
      type: 'launch',
      quitting: true,
    });
    assert.deepEqual(ev, { type: 'panel', op: 'toggle-model', id: 'm1' });
  });

  test('★★ `type` 永远是我们定的那个——页面塞不进别的事件类型', () => {
    const ev = toEvent({ op: 'quit', type: 'text', text: 'd' });
    assert.equal(ev?.type, 'panel');
    assert.equal(ev?.text, undefined);
  });

  test('★ 五个字段各自只在**类型对**的时候才带上', () => {
    assert.deepEqual(toEvent({ op: 'x', index: 3, dir: -1, value: 'v' }),
      { type: 'panel', op: 'x', index: 3, dir: -1, value: 'v' });
    // 类型不对就当没给——`index: "3"` 绝不能变成 `items["3"]`
    assert.deepEqual(toEvent({ op: 'x', index: '3', id: 7, dir: '1', value: 9 }),
      { type: 'panel', op: 'x' });
  });

  test('★ `index: 0` 要保住（`0` 是合法的行号，不能被当成"没给"）', () => {
    assert.deepEqual(toEvent({ op: 'activate', index: 0 }), { type: 'panel', op: 'activate', index: 0 });
  });

  test('★ `dir: 0` 也照样带过去——**合法性归 reducer 判**', () => {
    // 这里拦一遍就是第二处定义（`moveModel` 那边写着 `dir !== -1 && dir !== 1`）
    assert.deepEqual(toEvent({ op: 'move-model', id: 'm', dir: 0 }), { type: 'panel', op: 'move-model', id: 'm', dir: 0 });
  });

  test('★★ 认不出的 `op` 原样放行——合法性归 reducer', () => {
    assert.deepEqual(toEvent({ op: '没有这个 op' }), { type: 'panel', op: '没有这个 op' });
  });

  test('★ 连 `op` 都不是字符串 → `null`（调用方当 no-op）', () => {
    for (const bad of [null, undefined, 42, 'str', [], {}, { op: '' }, { op: 7 }]) {
      assert.equal(toEvent(bad), null, JSON.stringify(bad));
    }
  });

  test('★ 空字符串值要保住（用户把输入框清空了，那是**一个动作**）', () => {
    assert.deepEqual(toEvent({ op: 'set-path', value: '' }), { type: 'panel', op: 'set-path', value: '' });
  });
});

// ═══════════════════════════ 网页桥 ═══════════════════════════

describe('★★ `makeOps`：一个表单动作进出一次', () => {
  test('★★ 每个 op 都**回到一个视图**——no-op 也回', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    const first = await ops.view();
    assert.equal(first.screen, 'list');

    // 认不出的 op：状态不动，但**照样回一份当前视图**（页面拿的是旧状态）
    const r = await ops.apply({ op: '没有这个 op' });
    assert.deepEqual(r.view, first);
    assert.equal(r.done, false);

    // 连 op 都没有
    const r2 = await ops.apply({});
    assert.deepEqual(r2.view, first);
  });

  test('★★ `done` 只在「退出」那一下是 true', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    assert.equal((await ops.apply({ op: 'reload' })).done, false);
    assert.equal((await ops.apply({ op: 'new' })).done, false);
    assert.equal((await ops.apply({ op: 'back' })).done, false);
    assert.equal((await ops.apply({ op: 'quit' })).done, true);
  });

  test('★★ `apply()` 回来时状态一定**静止**——`pending` 不许卡住', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    for (const op of ['reload', 'new', 'back', 'next', 'retry', 'skip', 'quit']) {
      const r = await ops.apply({ op });
      assert.equal(r.view.pending, false, `${op} 之后 pending 卡住了`);
    }
  });

  test('★★ 重读完了，「读取配置…」要被擦掉——它是个**进行中**的提示', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    // ★ 「刷新」那条路：reducer 先写「读取配置…」，执行器重读完回 `reloaded`。
    //   `reloaded` 的语义是 `notice: ev.notice ?? state.notice` ⇒ 执行器不显式传空串，
    //   那句"正在读"就**永远**停在提示条上——重读早就结束了，字还挂着。
    //   （浏览器里一眼可见，而所有"pending 不卡住"的断言都看不见它。）
    const r = await ops.apply({ op: 'reload' });
    assert.equal(r.view.notice, '', '重读完了还留着进行中的提示');
  });

  test('★★ 走完一整套表单动作：勾选 → 调序 → 落盘', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    await ops.apply({ op: 'new' });
    await ops.apply({ op: 'set-path', value: s.proj });
    await ops.apply({ op: 'next' });                 // 第 2 步

    // ★★ `pick-token` **自己就把步骤推到第 3 步**了（`ui/app.js` 的 `pickToken()`：
    //    "选中身份"与"进入下一步"是同一个动作）。所以这里**不能**再补一个 `next`
    //    ——那会直接跨到第 4 步，第 3 步整段被跳过。前端那边同理：第 2 步的
    //    「下一步」只在 `token.mode === 'new'`（要新建）时才摆出来。
    let v = (await ops.apply({ op: 'pick-token', index: 0 })).view;
    assert.equal(v.wizard.step, 3);
    // ★ 而且清单**已经拉过了**：`pick-token` 顺带发了 `fetch-models`，
    //   `apply()` 里的 `settle()` 把它跑到了头。这个 token 没有 baseUrl，
    //   所以 `ok:false` —— 失败是**值**不是异常，页面照常进第 3 步。
    assert.equal(v.wizard.models.phase, 'fail', '没有 baseUrl 拉不到清单，这正是"手敲"那条路的入口');

    // 拉不到清单 → 手敲
    v = (await ops.apply({ op: 'manual-model', value: 'm1' })).view;
    v = (await ops.apply({ op: 'manual-model', value: 'm2' })).view;
    assert.deepEqual(v.wizard.models.checked.map((/** @type {any} */ c) => c.id), ['m1', 'm2']);

    // ★ 调序：把第 2 个上移——**这是 TUI 做不到的那件事**
    v = (await ops.apply({ op: 'move-model', id: 'm2', dir: -1 })).view;
    assert.deepEqual(v.wizard.models.checked.map((/** @type {any} */ c) => c.id), ['m2', 'm1']);

    // 两端越界 = no-op（不是夹到边界上）
    v = (await ops.apply({ op: 'move-model', id: 'm2', dir: -1 })).view;
    assert.deepEqual(v.wizard.models.checked.map((/** @type {any} */ c) => c.id), ['m2', 'm1']);

    v = (await ops.apply({ op: 'next' })).view;      // 第 4 步
    assert.equal(v.wizard.step, 4);
    assert.equal(v.pending, false);

    v = (await ops.apply({ op: 'apply' })).view;
    assert.match(v.notice, /已写入|绑定/, `落点没说清楚：${v.notice}`);

    // ★ 真的写了两处盘（§2.12 四）。
    //   ⚠️ 夹具里**已经有一条**绑定（`full()` 造的 `…/client-a`），所以这里是
    //   1 → 2：`doApplyWizard` 是 **append**，不是替换整个 `bindings` 数组。
    const OLD = join(TMP_BASE, 'x', 'client-a');
    const bindings = s.readConfig().bindings;
    assert.equal(bindings.length, 2, `落盘后应该是 2 条：${JSON.stringify(bindings)}`);
    assert.ok(bindings.some((/** @type {any} */ b) => b.path === OLD && b.token === 'relay-z'),
      '夹具里那条原样保留了吗');
    const added = bindings.filter((/** @type {any} */ b) => b.path !== OLD);
    assert.equal(added.length, 1, `新绑定没落盘：${JSON.stringify(bindings)}`);
    assert.equal(added[0].token, 'relay-z');

    const project = JSON.parse(nodeFs.readFileSync(join(s.proj, '.cmt.json'), 'utf8'));
    assert.deepEqual(project.models, [{ id: 'm2' }, { id: 'm1' }], '顺序即优先级，要按调过的顺序落盘');
  });

  test('★ 越界的 `index` = no-op，**绝不夹到边界上**', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const before = await ops.view();

    for (const index of [99, -1, 1.5]) {
      const r = await ops.apply({ op: 'activate', index });
      assert.equal(r.view.notice, before.notice, `index=${index} 不该有任何动静`);
    }
  });

  test('★★ 「退出」这件事不经过执行器——`quit` 在 `makeSession` 就被滤掉了', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    // 认不出的副作用才会 dispatch `failed`；`quit` 到不了执行器，
    // 所以退出之后**不该**多出一句"认不出的副作用：quit"。
    const r = await ops.apply({ op: 'quit' });
    assert.equal(r.done, true);
    assert.ok(!String(r.view.notice).includes('认不出的副作用'), r.view.notice);
  });

  test('★★ 退出之后**任何 op 都是空操作**（状态闸门）', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const r = await ops.apply({ op: 'quit' });

    const after = await ops.apply({ op: 'new' });
    assert.equal(after.view.screen, r.view.screen, '退出后还能开向导 = 状态泄漏');
    assert.equal(after.done, true, 'done 要一直是 true，服务端据此收尾');
  });

  test('★★ `open-path` 是旁路：不进 reducer，状态**一个字都不动**', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const before = await ops.view();

    // ★ 用**不存在的目录**走这条测试：探针在 spawn 之前就失败了，所以
    //   跑测的机器上**不会真的弹出一个资源管理器窗口**。成功那条（确切 argv）
    //   归 `open-path.test.js`，那边 `spawn` 是注入的。
    const r = await ops.apply({ op: 'open-path', value: join(s.root, '不存在的目录') });

    assert.equal(r.done, false);
    assert.match(r.view.notice, /不存在/);
    // ★★ 除了 `notice` 以外**整份视图一模一样**——这就证明了它没有落到
    //    reducer 里（落了的话 `screen`/`pending`/`wizard` 至少有一个会动）。
    assert.deepEqual({ ...r.view, notice: before.notice }, before, 'open-path 动了状态');

    // ★ 相对路径按 `ctx.cwd` 补全——与「进子目录」那条路**同一个**
    //   `resolveUserPath()`。所以这里回的是"不存在"，不是"没有给路径"：
    //   前者说明它真被解析成了一个绝对路径。
    const r2 = await ops.apply({ op: 'open-path', value: 'nope-relative' });
    assert.match(r2.view.notice, /不存在/);
  });
});

// ═══════════════════ 项目状态 & 身份↔地址 联动 ═══════════════════

/** 同一个 `ctx` 上**重新**开一个会话（= 刷新页面 / 重启服务）。 */
const reopen = (s) => makeOps(makeSession(s.ctx, initialState(buildPanelData(s.ctx))), s.ctx);

/** `full()` 那个沙箱里 `projects.json` 的绝对路径 */
const projectsFile = (/** @type {any} */ s) => join(s.appDir, 'projects.json');

describe('★★ 项目状态：两个旁路 op（不进 reducer）', () => {
  test('★★ 标一档 → 落盘 + 视图跟着变 + **重开一个会话还在**', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    // 第 0 行 = 「当前目录」，第 1 行 = 夹具里那条绑定
    let v = (await ops.apply({ op: 'set-status', index: 1, id: 'doing' })).view;
    assert.equal(v.items[1].status.id, 'doing');
    assert.equal(v.items[1].status.label, '进行中');
    assert.equal(v.items[0].status.id, 'todo', '★ 只该动被点的那一行');
    assert.equal(v.notice, '', '成功时不往 notice 里塞东西（那是给失败用的）');

    // 盘上真的落了，而且键是**归一化之后**的路径
    const onDisk = JSON.parse(nodeFs.readFileSync(projectsFile(s), 'utf8'));
    assert.equal(onDisk.version, 1);
    assert.equal(onDisk.statuses.length, 5);
    assert.deepEqual(Object.values(onDisk.projects), [{ status: 'doing' }]);

    // 刷新 / 重启之后还在（视图是从盘上重读出来的）
    const back = await reopen(s).view();
    assert.equal(back.items[1].status.id, 'doing');
  });

  test('★ 从没设过 = 第一档，而**盘上还没有那个文件**（惰性）', async () => {
    const s = full();
    const v = await makeOps(s.session(), s.ctx).view();
    assert.equal(v.items[0].status.id, 'todo');
    assert.equal(v.items[1].status.id, 'todo');
    assert.throws(() => nodeFs.readFileSync(projectsFile(s), 'utf8'), /ENOENT/,
      '★ 什么都没改就写出了 projects.json');
  });

  test('★ 越界的 index / 认不出的 id / 不是文件夹的行 → 说一句话，**一个字节都不写**', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const before = await ops.view();

    const cases = [
      [{ op: 'set-status', index: 99, id: 'doing' }, /列表已经变了/],
      [{ op: 'set-status', index: -1, id: 'doing' }, /列表已经变了/],
      [{ op: 'set-status', index: 1.5, id: 'doing' }, /列表已经变了/],
      [{ op: 'set-status', index: 2, id: 'doing' }, /只有「当前目录」/],   // 末行是「+ 新建…」
      [{ op: 'set-status', index: 1, id: '不存在的一档' }, /认不出的状态/],
      [{ op: 'set-status', index: 1, id: '' }, /认不出的状态/],
      [{ op: 'set-status', index: 1 }, /认不出的状态/],
    ];
    for (const [body, re] of cases) {
      const r = await ops.apply(body);
      assert.match(r.view.notice, re, JSON.stringify(body));
      // ★ 除了 notice 之外视图**一模一样**：证明它没落进 reducer
      assert.deepEqual({ ...r.view, notice: before.notice }, before, `${JSON.stringify(body)} 动了状态`);
    }
    assert.throws(() => nodeFs.readFileSync(projectsFile(s), 'utf8'), /ENOENT/);
  });

  test('★★ `save-statuses`：新行的 id 由**服务端**分配，改名字不动已有 id', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    await ops.apply({ op: 'set-status', index: 1, id: 'doing' });

    const keep = (await ops.view()).statuses
      .filter((/** @type {any} */ x) => x.id !== 'fail')      // 没人用的那一档可以删
      .map((/** @type {any} */ x) => ({ id: x.id, label: x.id === 'doing' ? '在做' : x.label, color: x.color }));
    keep.push({ id: '', label: '待验收', color: 'purple' });

    const v = (await ops.apply({ op: 'save-statuses', statuses: keep })).view;
    // ★ 成功要留一句回执：对话框一关，页面上除此之外没有任何"这次成了"的证据，
    //   而上一句的提示可能还是一次失败（那句红字会留在页面顶上，看起来像没保存成功）。
    assert.equal(v.notice, '状态表已保存');
    assert.deepEqual(v.statuses.map((/** @type {any} */ x) => x.id), ['todo', 'doing', 'wait', 'done', 's1']);
    assert.equal(v.statuses[1].label, '在做', '改名要生效');
    assert.equal(v.items[1].status.label, '在做', '★ 项目指向的是 id，改名不该把它弄丢');
  });

  test('★★ 删掉**还在用**的状态 → 拒，并说人话（用名称，不用内部 id）', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    await ops.apply({ op: 'set-status', index: 1, id: 'doing' });
    const before = await ops.view();

    const keep = before.statuses
      .filter((/** @type {any} */ x) => x.id !== 'doing')
      .map((/** @type {any} */ x) => ({ id: x.id, label: x.label, color: x.color }));
    const r = await ops.apply({ op: 'save-statuses', statuses: keep });

    assert.match(r.view.notice, /进行中/);
    assert.doesNotMatch(r.view.notice, /doing/);
    assert.deepEqual({ ...r.view, notice: before.notice }, before, '★ 被拒了还改了视图');
    // 盘上那份也没动
    const onDisk = JSON.parse(nodeFs.readFileSync(projectsFile(s), 'utf8'));
    assert.ok(onDisk.statuses.some((/** @type {any} */ x) => x.id === 'doing'));
  });

  test('★ `save-statuses` 的其它拒绝路径（空表 / 空名 / 怪颜色）都只说话不写盘', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const before = await ops.view();

    for (const statuses of [
      [],
      [{ id: '', label: '  ', color: 'blue' }],
      [{ id: '', label: '甲', color: '#ff0000' }],
      [{ id: '../x', label: '甲', color: 'blue' }],
      'not-an-array',
    ]) {
      const r = await ops.apply({ op: 'save-statuses', statuses });
      assert.notEqual(r.view.notice, '', `${JSON.stringify(statuses)} 没被拒`);
      assert.deepEqual({ ...r.view, notice: before.notice }, before);
    }
    assert.throws(() => nodeFs.readFileSync(projectsFile(s), 'utf8'), /ENOENT/);
  });

  test('★ 状态写盘**不碰** `config.json`（那是两条互不相干的路）', async () => {
    const s = full();
    const before = nodeFs.readFileSync(join(s.appDir, 'config.json'), 'utf8');
    await makeOps(s.session(), s.ctx).apply({ op: 'set-status', index: 1, id: 'done' });
    assert.equal(nodeFs.readFileSync(join(s.appDir, 'config.json'), 'utf8'), before);
  });
});

describe('★★ 身份 ↔ 服务端地址：下拉联动与写回', () => {
  /** 两个身份、两个地址 + 一个没配地址的——正好覆盖"地址属于谁"的三种情况。 */
  const twoTokens = () => full({
    tokens: {
      'relay-z': { authToken: FAKE_KEY, name: 'relay-z', baseUrl: 'https://a.example' },
      'relay-y': { authToken: FAKE_KEY, name: 'relay-y', baseUrl: 'https://b.example' },
      'relay-bare': { authToken: FAKE_KEY, name: 'relay-bare' },
    },
  });

  test('★ `tokens[].url` 是原始值，`baseUrl` 仍是给人看的那串', async () => {
    const s = twoTokens();
    const v = await makeOps(s.session(), s.ctx).view();
    const byName = (/** @type {string} */ n) => v.tokens.find((/** @type {any} */ t) => t.name === n);
    assert.equal(byName('relay-z').url, 'https://a.example');
    assert.equal(byName('relay-bare').url, '', '没配 = 空串');
    assert.equal(byName('relay-bare').baseUrl, '(未设置)', '给人看的还是那句');
  });

  test('★★ `urlOptions`：去重 + 首项是「未设置」+ 末项是「自定义…」', async () => {
    const s = twoTokens();
    const ops = makeOps(s.session(), s.ctx);
    await ops.apply({ op: 'new' });
    await ops.apply({ op: 'set-path', value: s.proj });
    const v = (await ops.apply({ op: 'next' })).view;

    // ★ 顺序是 `buildPanelData()` 给的**按名字排序**（bare < y < z），
    //   不是文件出现顺序——所以地址也跟着这个顺序排。
    assert.deepEqual(v.wizard.token.urlOptions.map((/** @type {any} */ o) => o.value), [
      '', 'https://b.example', 'https://a.example', CUSTOM_URL,
    ]);
    assert.equal(v.wizard.token.urlOptions[0].label, '（未设置）');
  });

  test('★★ 选身份 → 地址跟着走；换地址 → 身份跟着走（第 2 步，不联网）', async () => {
    const s = twoTokens();
    const ops = makeOps(s.session(), s.ctx);
    await ops.apply({ op: 'new' });
    await ops.apply({ op: 'set-path', value: s.proj });
    await ops.apply({ op: 'next' });

    // ★ 按名字排：0 = relay-bare（没地址）· 1 = relay-y（b）· 2 = relay-z（a）
    let v = (await ops.apply({ op: 'select-token', index: 0 })).view;
    assert.equal(v.wizard.token.chosen, 'relay-bare');
    assert.equal(v.wizard.token.baseUrl, '');
    assert.equal(v.wizard.step, 2, '★ 选一下就把人带进第 3 步 = 每点一次都联网');

    v = (await ops.apply({ op: 'select-token', index: 1 })).view;       // relay-y
    assert.equal(v.wizard.token.baseUrl, 'https://b.example');

    v = (await ops.apply({ op: 'set-base-url', value: 'https://a.example' })).view;
    assert.equal(v.wizard.token.chosen, 'relay-z', '★ 改了地址，身份也得跟上');
    assert.equal(v.wizard.token.baseUrl, 'https://a.example');
  });

  test('★★ 第 4 步写回 `tokens/<名字>.json` 的 `baseUrl`，回执里明写「服务端 → …」', async () => {
    const s = twoTokens();
    const ops = makeOps(s.session(), s.ctx);

    await ops.apply({ op: 'new' });
    await ops.apply({ op: 'set-path', value: s.proj });
    await ops.apply({ op: 'next' });
    await ops.apply({ op: 'select-token', index: 1 });                  // relay-y
    await ops.apply({ op: 'set-base-url', value: 'https://custom.example/v1' });
    await ops.apply({ op: 'confirm-token' });                           // 第 3 步（会去拉清单，失败也无所谓）
    await ops.apply({ op: 'next' });                                    // 第 4 步
    const v = (await ops.apply({ op: 'apply' })).view;

    assert.match(v.notice, /服务端 relay-y → https:\/\/custom\.example\/v1/);
    const token = JSON.parse(nodeFs.readFileSync(join(s.appDir, 'tokens', 'relay-y.json'), 'utf8'));
    assert.equal(token.baseUrl, 'https://custom.example/v1');
    // ★ 别的身份一个字节都不许动
    const other = JSON.parse(nodeFs.readFileSync(join(s.appDir, 'tokens', 'relay-z.json'), 'utf8'));
    assert.equal(other.baseUrl, 'https://a.example');
  });

  test('★ 清空地址 = 把那个键**删掉**（schema 不收空串）', async () => {
    const s = twoTokens();
    const ops = makeOps(s.session(), s.ctx);

    await ops.apply({ op: 'new' });
    await ops.apply({ op: 'set-path', value: s.proj });
    await ops.apply({ op: 'next' });
    await ops.apply({ op: 'select-token', index: 1 });                  // relay-y
    await ops.apply({ op: 'set-base-url', value: '' });
    await ops.apply({ op: 'confirm-token' });
    await ops.apply({ op: 'next' });
    const v = (await ops.apply({ op: 'apply' })).view;

    assert.match(v.notice, /服务端 relay-y → （已清空）/);
    const token = JSON.parse(nodeFs.readFileSync(join(s.appDir, 'tokens', 'relay-y.json'), 'utf8'));
    assert.equal(Object.hasOwn(token, 'baseUrl'), false);
  });

  test('★ 没动过地址 → 不写回、也不多那一行回执', async () => {
    const s = twoTokens();
    const ops = makeOps(s.session(), s.ctx);

    await ops.apply({ op: 'new' });
    await ops.apply({ op: 'set-path', value: s.proj });
    await ops.apply({ op: 'next' });
    await ops.apply({ op: 'select-token', index: 1 });
    await ops.apply({ op: 'confirm-token' });
    await ops.apply({ op: 'next' });
    const before = nodeFs.readFileSync(join(s.appDir, 'tokens', 'relay-y.json'), 'utf8');
    const v = (await ops.apply({ op: 'apply' })).view;

    assert.doesNotMatch(v.notice, /服务端/);
    assert.equal(nodeFs.readFileSync(join(s.appDir, 'tokens', 'relay-y.json'), 'utf8'), before);
  });

  test('★ 新建身份时带上地址 → `tokens/<名字>.json` 里就有它', async () => {
    const s = twoTokens();
    const ops = makeOps(s.session(), s.ctx);

    await ops.apply({ op: 'new' });
    await ops.apply({ op: 'set-path', value: s.proj });
    await ops.apply({ op: 'next' });
    await ops.apply({ op: 'new-token' });
    await ops.apply({ op: 'set-token-name', value: 'relay-new' });
    await ops.apply({ op: 'set-secret', value: FAKE_KEY });
    await ops.apply({ op: 'set-base-url', value: 'https://new.example' });
    const v = (await ops.apply({ op: 'save-token' })).view;

    assert.equal(v.wizard.token.chosen, 'relay-new');
    assert.equal(v.wizard.token.baseUrl, 'https://new.example', '★ 存完立刻显示它自己的地址');
    const token = JSON.parse(nodeFs.readFileSync(join(s.appDir, 'tokens', 'relay-new.json'), 'utf8'));
    assert.equal(token.baseUrl, 'https://new.example');
    assert.equal(token.authToken, FAKE_KEY);
  });
});

// ═══════════════════════════ 回执 ═══════════════════════════

// ═══════════ 模型下拉 & 资源表（§2.14 十二）═══════════

/** `full()` 那个沙箱里 `.cmt.json` 的绝对路径 */
const projectFileOf = (/** @type {any} */ s) => join(s.proj, '.cmt.json');
/** `resources.json` 的绝对路径 */
const resourcesFileOf = (/** @type {any} */ s) => join(s.appDir, 'resources.json');

/** 三档模型清单的沙箱：`.cmt.json` 里是 [a, b, c]，生效的是 a */
const three = () => full({
  project: { version: 1, token: 'relay-z', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
});

describe('★★ 模型下拉：`set-model` 是旁路 op（写盘与向导第 4 步同一个函数）', () => {
  test('★★ 选一个已在清单里的 → **提到首位**（与 `model use` 逐字节同义），并真的写进那一层', async () => {
    const s = three();
    const ops = makeOps(s.session(), s.ctx);
    const before = await ops.view();
    assert.deepEqual(before.items[0].models, ['a', 'b', 'c']);
    assert.equal(before.items[0].active, 0);

    const r = await ops.apply({ op: 'set-model', index: 0, id: 'c' });

    assert.equal(r.done, false);
    // ★ 回执就是 `doApplyModels()` 那句话——与向导第 4 步**一字不差**
    assert.equal(r.view.notice, '项目本地 .cmt.json ← 3 个模型');
    assert.deepEqual(r.view.items[0].models, ['c', 'a', 'b'], '提到首位，其余保持相对顺序');
    assert.equal(r.view.items[0].active, 0);

    const disk = JSON.parse(nodeFs.readFileSync(projectFileOf(s), 'utf8'));
    assert.deepEqual(disk.models, [{ id: 'c' }, { id: 'a' }, { id: 'b' }]);
    assert.equal(disk.token, 'relay-z', '★ 写模型不该把身份弄丢');
    assert.equal(disk.version, 1, '★ 也不该升版本号');

    // 刷新页面（= 重开会话）之后还在
    assert.deepEqual((await reopen(s).view()).items[0].models, ['c', 'a', 'b']);
  });

  test('★ 选一个清单外的 → 插到首位（不用先 `model set` 一遍）', async () => {
    const s = three();
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'set-model', index: 0, id: 'zzz' });
    assert.deepEqual(r.view.items[0].models, ['zzz', 'a', 'b', 'c']);
    assert.deepEqual(
      JSON.parse(nodeFs.readFileSync(projectFileOf(s), 'utf8')).models.map((/** @type {any} */ m) => m.id),
      ['zzz', 'a', 'b', 'c'],
    );
  });

  test('★★ 选「（不声明）」（`id` 是空串）→ 那一层的 `models` 键**被删**，不是写成 `[]`', async () => {
    const s = three();
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'set-model', index: 0, id: '' });
    assert.equal(r.view.notice, '项目本地 .cmt.json 的模型声明已清掉');
    assert.deepEqual(r.view.items[0].models, []);

    const disk = JSON.parse(nodeFs.readFileSync(projectFileOf(s), 'utf8'));
    // ★★ `[]` 的语义是"这一层说：没有模型"，与"这一层别说话"**完全不同**（§2.5）。
    //    写成 `[]` 会让 `cmt run` 报"没有可用的模型"。
    assert.equal('models' in disk, false);
    assert.equal(disk.token, 'relay-z');
  });

  test('★ 「(未绑定)」那一行写的是 **token 自己**——不给当前目录凭空建一条绑定', async () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { solo: { authToken: FAKE_KEY } },
    });
    const ops = makeOps(s.session(), s.ctx);
    const at = (await ops.view()).items.findIndex((/** @type {any} */ i) => i.kind === 'token');
    assert.ok(at >= 0, '沙箱里应该有一行未绑定的 token');

    const r = await ops.apply({ op: 'set-model', index: at, id: 'mx' });
    assert.equal(r.view.notice, 'token solo ← 1 个模型');

    const disk = JSON.parse(nodeFs.readFileSync(join(s.appDir, 'tokens', 'solo.json'), 'utf8'));
    assert.deepEqual(disk.models, [{ id: 'mx' }]);
    assert.equal(disk.authToken, FAKE_KEY, '★ 写模型不许碰密钥');
    // ★ 而且**没有**顺手写出一条绑定
    assert.deepEqual(
      JSON.parse(nodeFs.readFileSync(join(s.appDir, 'config.json'), 'utf8')).bindings,
      [],
    );
  });

  test('★ 拒绝路径：坏 index / 「+ 新建…」/ 没身份的那一行 → 说一句话，**一个字节都不写**', async () => {
    const s = three();
    const ops = makeOps(s.session(), s.ctx);
    const before = await ops.view();
    const fileBefore = nodeFs.readFileSync(projectFileOf(s), 'utf8');

    for (const [body, re] of [
      [{ op: 'set-model', index: 99, id: 'a' }, /列表已经变了/],
      [{ op: 'set-model', index: -1, id: 'a' }, /列表已经变了/],
      [{ op: 'set-model', index: 1.5, id: 'a' }, /列表已经变了/],
      [{ op: 'set-model', index: 2, id: 'a' }, /这一行没有可改的模型/],   // 末行是「+ 新建…」
    ]) {
      const r = await ops.apply(body);
      assert.match(r.view.notice, re, JSON.stringify(body));
      // ★ 除了 notice 之外视图**一模一样**：证明它没落进 reducer
      assert.deepEqual({ ...r.view, notice: before.notice }, before, `${JSON.stringify(body)} 动了状态`);
    }
    assert.equal(nodeFs.readFileSync(projectFileOf(s), 'utf8'), fileBefore, '被拒了还写盘');

    // 没身份的那一行（绑定没写 token、目录里也没有 `.cmt.json`）
    const s2 = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: join(TMP_BASE, 'x', 'client-q') }] },
    });
    const ops2 = makeOps(s2.session(), s2.ctx);
    const configBefore = nodeFs.readFileSync(join(s2.appDir, 'config.json'), 'utf8');
    const r2 = await ops2.apply({ op: 'set-model', index: 1, id: 'a' });
    assert.match(r2.view.notice, /没有身份/);
    assert.equal(nodeFs.readFileSync(join(s2.appDir, 'config.json'), 'utf8'), configBefore);
  });
});

describe('★★ 资源表：`refresh-models` / `refresh-all-models`（现拉 + 登记）', () => {
  test('★★ 拉到了 → 写进 `resources.json`，资源表与下拉都跟着变', async (t) => {
    const stub = await modelStub(['m1', 'm2']);
    t.after(() => stub.close());

    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { solo: { authToken: FAKE_KEY, baseUrl: stub.baseUrl } },
    });
    const ops = makeOps(s.session(), s.ctx);
    const at = (await ops.view()).items.findIndex((/** @type {any} */ i) => i.kind === 'token');

    const r = await ops.apply({ op: 'refresh-models', name: 'solo' });
    assert.equal(r.view.notice, 'solo ← 2 个模型');

    const row = r.view.resources.find((/** @type {any} */ x) => x.name === 'solo');
    assert.deepEqual(row.models, ['m1', 'm2']);
    assert.equal(row.url, stub.baseUrl);
    assert.equal(row.cachedUrl, stub.baseUrl);
    assert.equal(row.stale, false);
    assert.match(row.fetchedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
    assert.equal(row.projects, 0, '★ 没被任何绑定显式声明');

    // ★ 下拉候选跟着多出两项——证明 `reloadPanel()` 真的从盘上重读了
    assert.deepEqual(r.view.items[at].modelOptions, ['m1', 'm2']);

    const disk = JSON.parse(nodeFs.readFileSync(resourcesFileOf(s), 'utf8'));
    assert.deepEqual(disk.tokens.solo, {
      url: stub.baseUrl, models: ['m1', 'm2'], fetchedAt: row.fetchedAt,
    });
    assert.equal(disk.version, 1);
    // ★ 请求真的带上了那个身份（不是空 Bearer）
    assert.equal(stub.hits.length, 1);
    assert.equal(stub.hits[0].auth, `Bearer ${FAKE_KEY}`);
    assert.equal(stub.hits[0].url, '/models');
  });

  test('★★ 端点顺路报了价 → 存进 `resources.json`，**但不进视图模型**', async (t) => {
    // 价格是"自动采集"的那一级（§2.13）。它只对 `cmt usage` 有用，
    // 资源表不需要知道——视图模型是跨项目冻结的 14 键，别为一个后端字段去动它。
    const stub = await modelStub([
      { id: 'm1', pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' } },
      { id: 'm-free' },
    ]);
    t.after(() => stub.close());

    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { solo: { authToken: FAKE_KEY, baseUrl: stub.baseUrl } },
    });
    const r = await makeOps(s.session(), s.ctx).apply({ op: 'refresh-models', name: 'solo' });
    assert.equal(r.view.notice, 'solo ← 2 个模型');

    const disk = JSON.parse(nodeFs.readFileSync(resourcesFileOf(s), 'utf8'));
    assert.deepEqual(disk.tokens.solo.pricing, {
      m1: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3 },
    });
    assert.equal('pricing' in r.view.resources[0], false, '视图模型一个键都不许多');
  });

  test('★ 再拉一次、端点不再报价 → 旧价从盘上消失（不报过期价）', async (t) => {
    const withPrice = await modelStub([
      { id: 'm1', pricing: { prompt: '0.000003', completion: '0.000015' } },
    ]);
    t.after(() => withPrice.close());

    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { solo: { authToken: FAKE_KEY, baseUrl: withPrice.baseUrl } },
    });
    await makeOps(s.session(), s.ctx).apply({ op: 'refresh-models', name: 'solo' });

    const plain = await modelStub(['m1']);
    t.after(() => plain.close());
    nodeFs.writeFileSync(
      join(s.appDir, 'tokens', 'solo.json'),
      `${JSON.stringify({ authToken: FAKE_KEY, baseUrl: plain.baseUrl }, null, 2)}\n`,
    );
    await reopen(s).apply({ op: 'refresh-models', name: 'solo' });

    const disk = JSON.parse(nodeFs.readFileSync(resourcesFileOf(s), 'utf8'));
    assert.equal('pricing' in disk.tokens.solo, false);
  });

  test('★★ 拉不到 → 说原因，**旧登记原样留着**（一次网络抖动不该抹掉上次的结果）', async (t) => {
    const stub = await modelStub(['m1', 'm2']);
    t.after(() => stub.close());

    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { solo: { authToken: FAKE_KEY, baseUrl: stub.baseUrl } },
    });
    const ops = makeOps(s.session(), s.ctx);
    await ops.apply({ op: 'refresh-models', name: 'solo' });
    const before = nodeFs.readFileSync(resourcesFileOf(s), 'utf8');

    // 把这个身份指到一个**永远没人听**的端口（端口 1：连不上是立刻的，不是 10 秒超时）
    nodeFs.writeFileSync(
      join(s.appDir, 'tokens', 'solo.json'),
      `${JSON.stringify({ authToken: FAKE_KEY, baseUrl: 'http://127.0.0.1:1' }, null, 2)}\n`,
    );
    const ops2 = reopen(s);

    const r = await ops2.apply({ op: 'refresh-models', name: 'solo' });
    assert.match(r.view.notice, /拉取失败/);
    assert.equal(nodeFs.readFileSync(resourcesFileOf(s), 'utf8'), before, '失败也改了登记');

    // ★ 但资源表**看得见**这份清单是旧的：地址变了
    const row = r.view.resources.find((/** @type {any} */ x) => x.name === 'solo');
    assert.equal(row.stale, true);
    assert.deepEqual(row.models, ['m1', 'm2']);
    assert.equal(row.cachedUrl, stub.baseUrl, '清单来自哪个地址');
    assert.equal(row.url, 'http://127.0.0.1:1', '当前地址');
  });

  test('★ 认不出的 token 名 → 说一句话，**不建文件**', async () => {
    const s = setup({ config: { version: 1, defaults: {}, bindings: [] }, tokens: {} });
    const r = await makeOps(s.session(), s.ctx).apply({ op: 'refresh-models', name: 'nope' });
    assert.match(r.view.notice, /没有 token/);
    assert.throws(() => nodeFs.readFileSync(resourcesFileOf(s), 'utf8'), /ENOENT/);
  });

  test('★★ `refresh-all-models`：两个身份一成一败 → 汇总一句，**只有成功那条入库**', async (t) => {
    const stub = await modelStub(['m1', 'm2', 'm3']);
    t.after(() => stub.close());

    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {
        good: { authToken: FAKE_KEY, baseUrl: stub.baseUrl },
        dead: { authToken: FAKE_KEY, baseUrl: 'http://127.0.0.1:1' },
      },
    });
    const r = await makeOps(s.session(), s.ctx).apply({ op: 'refresh-all-models' });

    assert.equal(r.view.notice, '拉取完成：1 成功 · 1 失败');
    assert.deepEqual(r.view.resources.map((/** @type {any} */ x) => x.name), ['dead', 'good']);
    const byName = Object.fromEntries(r.view.resources.map((/** @type {any} */ x) => [x.name, x]));
    assert.deepEqual(byName.good.models, ['m1', 'm2', 'm3']);
    assert.deepEqual(byName.dead.models, []);

    const disk = JSON.parse(nodeFs.readFileSync(resourcesFileOf(s), 'utf8'));
    assert.deepEqual(Object.keys(disk.tokens), ['good'], '★ 失败的**不**入库');
  });

  test('★ 一个 token 都没有 → 明说，别装作拉过了', async () => {
    const s = setup({ config: { version: 1, defaults: {}, bindings: [] }, tokens: {} });
    const r = await makeOps(s.session(), s.ctx).apply({ op: 'refresh-all-models' });
    assert.match(r.view.notice, /还没有 token/);
    assert.throws(() => nodeFs.readFileSync(resourcesFileOf(s), 'utf8'), /ENOENT/);
  });

  test('★★ 向导第 3 步的现拉也**顺手登记**（同一个函数，不会两条路给出两种结果）', async (t) => {
    const stub = await modelStub(['m1', 'm2']);
    t.after(() => stub.close());

    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { solo: { authToken: FAKE_KEY, baseUrl: stub.baseUrl } },
    });
    const exec = makeExecutor(s.ctx);

    /** @type {any[]} */
    const got = [];
    await exec({ type: 'fetch-models', token: 'solo' }, (ev) => got.push(ev));

    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'models');
    assert.equal(got[0].ok, true);
    assert.deepEqual(got[0].ids, ['m1', 'm2']);

    const disk = JSON.parse(nodeFs.readFileSync(resourcesFileOf(s), 'utf8'));
    assert.deepEqual(disk.tokens.solo.models, ['m1', 'm2']);
    assert.equal(disk.tokens.solo.url, stub.baseUrl);
  });

  test('★ `modelOptions` = **已声明的在前 + 登记补后**（去重、按字母序）', async (t) => {
    const stub = await modelStub(['zz', 'b-declared', 'aa']);
    t.after(() => stub.close());

    const s = full({
      tokens: { 'relay-z': { authToken: FAKE_KEY, baseUrl: stub.baseUrl } },
      project: { version: 1, token: 'relay-z', models: [{ id: 'b-declared' }, { id: 'a-declared' }] },
    });
    const ops = makeOps(s.session(), s.ctx);
    await ops.apply({ op: 'refresh-models', name: 'relay-z' });

    const v = await ops.view();
    assert.deepEqual(v.items[0].modelOptions, ['b-declared', 'a-declared', 'aa', 'zz']);
  });
});

// ═════════════ 资源表 · 昵称与优先级（§2.12 十二）═════════════

/** `tokens/<name>.json` 的绝对路径 */
const tokenFileOf = (/** @type {any} */ s, /** @type {string} */ name) => join(s.appDir, 'tokens', `${name}.json`);
/** 读回一个 token 文件（断言"盘上到底写了什么"用） */
const readTokenFile = (/** @type {any} */ s, /** @type {string} */ name) => JSON.parse(nodeFs.readFileSync(tokenFileOf(s, name), 'utf8'));

/**
 * 一个网关沙箱：a / b 共用 `defaults.baseUrl`（同一个端点）、c 是另一个端点。
 * ★ 端点一律 `.test` 保留 TLD——源码卫生那条规则会拦陌生域名。
 * @param {{ tokens?: Record<string, any> }} [over]
 */
const gateway = (over = {}) => setup({
  config: {
    version: 1,
    defaults: { baseUrl: 'https://gw.test/v1', models: [{ id: 'm1' }, { id: 'm2' }] },
    bindings: [],
  },
  tokens: {
    'relay-a': { name: 'relay-a', authToken: FAKE_KEY, models: [{ id: 'm1' }, { id: 'm2' }] },
    'relay-b': { name: 'relay-b', authToken: FAKE_KEY, models: [{ id: 'm1' }, { id: 'm2' }] },
    'relay-c': { name: 'relay-c', authToken: FAKE_KEY, baseUrl: 'https://other.test/v1' },
    ...over.tokens,
  },
});

describe('★★ 资源表 · 昵称：`set-label` 是旁路 op（空 = 删键）', () => {
  test('★★ 写昵称 → 落盘、视图跟着变、重开一个会话还在', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const before = await ops.view();

    const r = await ops.apply({ op: 'set-label', name: 'relay-z', label: '阿里中转' });

    assert.equal(r.done, false);
    assert.equal(r.view.tokens[0].label, '阿里中转');
    assert.equal(r.view.resources[0].label, '阿里中转');
    // ★ 成功**不写** `notice`（与 `open-path` 同一条）：行内那个输入框自己就是回执
    assert.equal(r.view.notice, before.notice);

    const disk = readTokenFile(s, 'relay-z');
    assert.equal(disk.label, '阿里中转');
    assert.equal(disk.authToken, FAKE_KEY, '★ 改昵称不许碰密钥');
    assert.equal(disk.name, 'relay-z', '★ 也不许碰身份');

    assert.equal((await reopen(s).view()).resources[0].label, '阿里中转');
  });

  test('★★ 清空 = **删键**，不是写 `""`（schema 里空串 = 未设置）', async () => {
    const s = full({
      tokens: { 'relay-z': { name: 'relay-z', authToken: FAKE_KEY, label: '旧名' } },
    });
    const ops = makeOps(s.session(), s.ctx);
    assert.equal((await ops.view()).resources[0].label, '旧名');

    // 前后空白也算空——`normalizeTokenLabel()` 先 trim
    const r = await ops.apply({ op: 'set-label', name: 'relay-z', label: '   ' });

    assert.equal(r.view.resources[0].label, '');
    const disk = readTokenFile(s, 'relay-z');
    // ★★ 写成 `""` 与"没有这个键"在 schema 里是**两件事**（前者是"设成了空名字"）。
    //    这里钉死的是"清空意味着键消失"。
    assert.equal('label' in disk, false);
    assert.equal(disk.authToken, FAKE_KEY);
  });

  test('★ 未知 token / 缺 label / 非文本 → 说一句话，**一个字节都不写**', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const before = nodeFs.readFileSync(tokenFileOf(s, 'relay-z'), 'utf8');
    const view0 = await ops.view();

    for (const [body, re] of [
      [{ op: 'set-label', name: 'nope', label: 'x' }, /没有 token/],
      [{ op: 'set-label', name: '', label: 'x' }, /没有 token/],
      [{ op: 'set-label', name: 'relay-z' }, /必须是文本/],
      // ★ `null` **不许**被理解成"清空"——静默删掉用户写了半天的昵称是最坏的一种理解
      [{ op: 'set-label', name: 'relay-z', label: null }, /必须是文本/],
    ]) {
      const r = await ops.apply(body);
      assert.match(r.view.notice, re, JSON.stringify(body));
      assert.deepEqual({ ...r.view, notice: view0.notice }, view0, `${JSON.stringify(body)} 动了状态`);
    }
    assert.equal(nodeFs.readFileSync(tokenFileOf(s, 'relay-z'), 'utf8'), before);
  });

  test('★★ 超长 / 带控制字符 → 拒，且**文件不动**（schema 在写盘之前抛）', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const before = nodeFs.readFileSync(tokenFileOf(s, 'relay-z'), 'utf8');

    // ⚠️ 控制字符用 `String.fromCharCode` 造，不在源码里写转义——那写法落盘时会变成裸字节
    const LF = String.fromCharCode(10);
    const TAB = String.fromCharCode(9);
    for (const [label, re] of [
      ['x'.repeat(33), /最多 32/],
      [`换${LF}行`, /控制字符/],
      [`制表${TAB}符`, /控制字符/],
    ]) {
      const r = await ops.apply({ op: 'set-label', name: 'relay-z', label });
      assert.match(r.view.notice, re, JSON.stringify(label));
      assert.equal(nodeFs.readFileSync(tokenFileOf(s, 'relay-z'), 'utf8'), before, `写进去了：${JSON.stringify(label)}`);
    }

    // ★ 32 个**码点**正好到顶——emoji 在 UTF-16 里占两位，按 `.length` 算会被误拒
    const ok = await ops.apply({ op: 'set-label', name: 'relay-z', label: '😀'.repeat(32) });
    assert.equal(ok.view.resources[0].label, '😀'.repeat(32));
  });
});

describe('★★ 资源表 · 优先级：`save-priority` 种进 token 自己的 `models`', () => {
  test('★★ 生效值只算 **token 层**——项目本地声明的模型不算进这一列', async () => {
    const s = full(); // `.cmt.json` 里有 keep-me，token 自己没声明
    const v = await makeOps(s.session(), s.ctx).view();

    assert.ok(v.items[0].models.includes('keep-me'), '路径那一层确实在生效');
    // ★★ 资源表按 token 看（§2.12 十二）：混进路径层只会得到一列"看情况"的数字
    assert.deepEqual(v.resources[0].priority, []);
    assert.equal(v.resources[0].priorityState, 'inherit');
  });

  test('★★ 三种状态：own / empty / inherit', async () => {
    const s = gateway({
      tokens: { 'relay-e': { name: 'relay-e', authToken: FAKE_KEY, models: [] } },
    });
    const rows = (await makeOps(s.session(), s.ctx).view()).resources;
    const by = (/** @type {string} */ n) => rows.find((/** @type {any} */ r) => r.name === n);

    assert.equal(by('relay-a').priorityState, 'own');
    assert.deepEqual(by('relay-a').priority, ['m1', 'm2']);
    // ★ `[]` 是"这一层说：一个都不注入"，与"这一层别说话"完全不同（§2.3 末那张表）
    assert.equal(by('relay-e').priorityState, 'empty');
    assert.deepEqual(by('relay-e').priority, []);
    assert.equal(by('relay-c').priorityState, 'inherit');
    assert.deepEqual(by('relay-c').priority, ['m1', 'm2'], '继承全局的那份');
  });

  test('★★ 同网关：号码一致时 `gatewayUnified` 为真，分叉了就是假', async () => {
    const s1 = gateway();
    const rows1 = (await makeOps(s1.session(), s1.ctx).view()).resources;
    const a1 = rows1.find((/** @type {any} */ r) => r.name === 'relay-a');
    assert.equal(a1.gatewayCount, 2, 'a 与 b 共用 `defaults.baseUrl`');
    assert.equal(a1.gatewayUnified, true);
    assert.equal(rows1.find((/** @type {any} */ r) => r.name === 'relay-c').gatewayCount, 1, 'c 是另一个端点');

    const s2 = gateway({ tokens: { 'relay-b': { name: 'relay-b', authToken: FAKE_KEY, models: [{ id: 'm2' }, { id: 'm1' }] } } });
    const rows2 = (await makeOps(s2.session(), s2.ctx).view()).resources;
    const a2 = rows2.find((/** @type {any} */ r) => r.name === 'relay-a');
    assert.equal(a2.gatewayUnified, false, '★ 顺序不同就是不同——逐项比，不比集合');
  });

  test('★★ token scope：顺序就是优先级，写进那个 token，别人一个字节不动', async () => {
    const s = gateway();
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'save-priority', name: 'relay-b', ids: ['m2', 'm1', 'm3'], scope: 'token' });

    assert.equal(r.done, false);
    assert.equal(r.view.notice, '已保存：relay-b ← 3 个模型');

    const disk = readTokenFile(s, 'relay-b');
    assert.deepEqual(disk.models, [{ id: 'm2' }, { id: 'm1' }, { id: 'm3' }]);
    assert.equal(disk.authToken, FAKE_KEY, '★ 改优先级不许碰密钥');

    const row = r.view.resources.find((/** @type {any} */ x) => x.name === 'relay-b');
    assert.deepEqual(row.priority, ['m2', 'm1', 'm3']);
    assert.equal(row.priorityState, 'own');

    // ★ 同网关的 a 没被带着改（没勾那个复选框），于是这一组从此"不同"
    assert.deepEqual(readTokenFile(s, 'relay-a').models, [{ id: 'm1' }, { id: 'm2' }]);
    const a = r.view.resources.find((/** @type {any} */ x) => x.name === 'relay-a');
    assert.equal(a.gatewayUnified, false);

    assert.deepEqual((await reopen(s).view()).resources.find((/** @type {any} */ x) => x.name === 'relay-b').priority, ['m2', 'm1', 'm3']);
  });

  test('★★ 空数组 = **删掉那个键**（回到继承），绝不写 `[]`', async () => {
    const s = gateway();
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'save-priority', name: 'relay-a', ids: [], scope: 'token' });

    assert.equal(r.view.notice, '已保存：relay-a ← 回到继承');
    const disk = readTokenFile(s, 'relay-a');
    // ★★ 写成 `[]` 会让这个 token 从"继承"变成"显式不注入"——`cmt run` 那边是两种结局
    assert.equal('models' in disk, false);

    const row = r.view.resources.find((/** @type {any} */ x) => x.name === 'relay-a');
    assert.equal(row.priorityState, 'inherit');
    assert.deepEqual(row.priority, ['m1', 'm2'], '回到全局那份');
  });

  test('★★ 服务端自己清洗：trim / 丢空 / 去重保序', async () => {
    const s = gateway();
    const ops = makeOps(s.session(), s.ctx);

    await ops.apply({ op: 'save-priority', name: 'relay-a', ids: [' m2 ', '', '  ', 'm2', 'm1'], scope: 'token' });

    assert.deepEqual(readTokenFile(s, 'relay-a').models, [{ id: 'm2' }, { id: 'm1' }]);
  });

  test('★ 旧条目上的 `label` **跟着 id 走**——只调了个顺序，不该把中文名抹掉', async () => {
    const s = gateway({
      tokens: { 'relay-e': { name: 'relay-e', authToken: FAKE_KEY, models: [{ id: 'x', label: 'X 模型' }, { id: 'y' }] } },
    });
    const ops = makeOps(s.session(), s.ctx);

    await ops.apply({ op: 'save-priority', name: 'relay-e', ids: ['y', 'x'], scope: 'token' });

    assert.deepEqual(readTokenFile(s, 'relay-e').models, [{ id: 'y' }, { id: 'x', label: 'X 模型' }]);
  });

  test('★★ gateway scope：服务端按**生效 URL** 自己找同组，不信前端', async () => {
    const s = gateway();
    const ops = makeOps(s.session(), s.ctx);

    // 前端只说"要套用到网关"，**不给名单**——名单是服务端算的
    const r = await ops.apply({ op: 'save-priority', name: 'relay-a', ids: ['m3', 'm2'], scope: 'gateway' });

    assert.equal(r.view.notice, '已保存：2 个模型 → 2 个 token');
    assert.deepEqual(readTokenFile(s, 'relay-a').models, [{ id: 'm3' }, { id: 'm2' }]);
    assert.deepEqual(readTokenFile(s, 'relay-b').models, [{ id: 'm3' }, { id: 'm2' }], 'b 走的是同一个端点');
    // ★ c 是另一个端点——不许被顺手改掉
    assert.equal('models' in readTokenFile(s, 'relay-c'), false);

    // 认不出的 scope 一律当作「只改自己」——**不猜**用户的意思
    await ops.apply({ op: 'save-priority', name: 'relay-a', ids: ['m9'], scope: 'nonsense' });
    assert.deepEqual(readTokenFile(s, 'relay-b').models, [{ id: 'm3' }, { id: 'm2' }]);
  });

  test('★ 生效 URL 是空串时，网关里**只有自己**（两个都没配端点，不算一组）', async () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {
        'relay-a': { name: 'relay-a', authToken: FAKE_KEY },
        'relay-b': { name: 'relay-b', authToken: FAKE_KEY },
      },
    });
    const ops = makeOps(s.session(), s.ctx);

    assert.deepEqual((await ops.view()).resources.map((/** @type {any} */ r) => r.gatewayCount), [1, 1]);

    const r = await ops.apply({ op: 'save-priority', name: 'relay-a', ids: ['z'], scope: 'gateway' });
    assert.equal(r.view.notice, '已保存：relay-a ← 1 个模型');
    assert.equal('models' in readTokenFile(s, 'relay-b'), false);
  });

  test('★ 拒绝路径：坏 ids / 未知 token → 说一句话，**一个字节都不写**', async () => {
    const s = gateway();
    const ops = makeOps(s.session(), s.ctx);
    const before = nodeFs.readFileSync(tokenFileOf(s, 'relay-a'), 'utf8');
    const view0 = await ops.view();
    const NL = String.fromCharCode(10);

    for (const [body, re] of [
      [{ op: 'save-priority', name: 'relay-a', ids: 'm1', scope: 'token' }, /必须是一个数组/],
      [{ op: 'save-priority', name: 'relay-a', ids: [1], scope: 'token' }, /必须是字符串/],
      [{ op: 'save-priority', name: 'relay-a', ids: ['x'.repeat(129)], scope: 'token' }, /太长/],
      [{ op: 'save-priority', name: 'relay-a', ids: [`a${NL}b`], scope: 'token' }, /控制字符/],
      [{ op: 'save-priority', name: 'relay-a', ids: Array.from({ length: 501 }, (_, i) => `m${i}`), scope: 'token' }, /最多 500/],
      [{ op: 'save-priority', name: 'relay-a', scope: 'token' }, /必须是一个数组/],
      [{ op: 'save-priority', name: 'nope', ids: ['m1'], scope: 'token' }, /没有 token/],
    ]) {
      const r = await ops.apply(body);
      assert.match(r.view.notice, re, JSON.stringify(body).slice(0, 120));
      assert.deepEqual({ ...r.view, notice: view0.notice }, view0, `${JSON.stringify(body).slice(0, 80)} 动了状态`);
    }
    assert.equal(nodeFs.readFileSync(tokenFileOf(s, 'relay-a'), 'utf8'), before);
  });
});

describe('★★ 资源表 · 添加：`add-token` 复用向导那条建 token 的路', () => {
  test('★★ 建成 → 落盘（密钥 + 可选地址）、视图多一行、重开还在；回执里没有明文', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    assert.equal((await ops.view()).resources.length, 1);

    const r = await ops.apply({
      op: 'add-token', name: 'relay-new', secret: FAKE_KEY,
      baseUrl: 'http://127.0.0.1:9/v1',
    });

    assert.equal(r.done, false);
    assert.equal(r.view.notice, '已添加：relay-new');
    const row = r.view.resources.find((/** @type {any} */ x) => x.name === 'relay-new');
    assert.notEqual(row, undefined, '回执 resources 里得出现这一行');

    // ★★ 明文永不过线：整个视图里搜不到密钥本体，只有打码值
    assert.equal(JSON.stringify(r.view).includes(FAKE_KEY), false);

    const disk = readTokenFile(s, 'relay-new');
    assert.equal(disk.authToken, FAKE_KEY);
    assert.equal(disk.baseUrl, 'http://127.0.0.1:9/v1');

    const again = (await reopen(s).view()).resources.find((/** @type {any} */ x) => x.name === 'relay-new');
    assert.notEqual(again, undefined);
  });

  test('★★ 地址留空 = 不写键（与向导第 2 步同一条语义）', async () => {
    const s = full();
    await makeOps(s.session(), s.ctx).apply({ op: 'add-token', name: 'solo', secret: FAKE_KEY });

    const disk = readTokenFile(s, 'solo');
    assert.equal(disk.authToken, FAKE_KEY);
    assert.equal('baseUrl' in disk, false);
  });

  test('★★ 重名 / 坏名字 / 空密钥 / 非文本 → 说一句话，**文件一个都不多**', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const before = nodeFs.readdirSync(join(s.appDir, 'tokens'));
    const NL = String.fromCharCode(10);

    for (const [body, re] of [
      [{ op: 'add-token', name: 'relay-z', secret: FAKE_KEY }, /已存在/],
      [{ op: 'add-token', name: 'Bad/Name', secret: FAKE_KEY }, /路径分隔符/],
      [{ op: 'add-token', name: 'ok-name' }, /密钥不能为空/],
      [{ op: 'add-token', name: 'ok-name', secret: '' }, /密钥不能为空/],
      [{ op: 'add-token', name: 'ok-name', secret: '   ' }, /密钥不能为空/],
      [{ op: 'add-token', name: 'ok-name', secret: null }, /密钥不能为空/],
      // ★ `null` 地址也不许被"善意理解"成"没有地址"
      [{ op: 'add-token', name: 'ok-name', secret: FAKE_KEY, baseUrl: null }, /必须是文本/],
      [{ op: 'add-token', name: 'ok-name', secret: FAKE_KEY, baseUrl: 9 }, /必须是文本/],
      [{ op: 'add-token', secret: FAKE_KEY }, /名字必须是文本/],
      [{ op: 'add-token', name: '', secret: FAKE_KEY }, /名字必须是文本/],
      [{ op: 'add-token', name: `带${NL}行`, secret: FAKE_KEY }, /名不合法/],
    ]) {
      const r = await ops.apply(body);
      assert.match(r.view.notice, re, JSON.stringify(body).slice(0, 120));
    }
    assert.deepEqual(nodeFs.readdirSync(join(s.appDir, 'tokens')), before, '拒绝路径不许留下半个文件');
  });
});

describe('★★ 资源表 · 环境变量：`save-env` 把 env 逃生舱搬进控制台', () => {
  test('★★ token 目标：写进那个 token 的本层 env，别的行不动，重开还在', async () => {
    const s = gateway();
    const ops = makeOps(s.session(), s.ctx);
    const before = await ops.view();

    // ★ 空串**有意义**：注入时删掉继承来的那个变量（契约 §2.6）——不是"没填"
    const env = { FOO: '1', BAR: '' };
    const r = await ops.apply({ op: 'save-env', target: 'token', name: 'relay-a', env });

    assert.equal(r.done, false);
    // ★ 成功**不写** `notice`（与 `set-label` 同一条）：回执里的 `env` 就是答案
    assert.equal(r.view.notice, before.notice);

    const disk = readTokenFile(s, 'relay-a');
    assert.deepEqual(disk.env, env);
    assert.equal(disk.authToken, FAKE_KEY, '★ 改 env 不许碰密钥');
    assert.deepEqual(disk.models, [{ id: 'm1' }, { id: 'm2' }], '★ 也不许碰优先级');

    const row = r.view.resources.find((/** @type {any} */ x) => x.name === 'relay-a');
    assert.deepEqual(row.env, env);
    // ★ 键集固定：没设的行兜成 `{}`，不是 `undefined`（过不了 JSON 往返）
    assert.deepEqual(
      r.view.resources.find((/** @type {any} */ x) => x.name === 'relay-b').env,
      {},
    );

    const back = (await reopen(s).view()).resources.find((/** @type {any} */ x) => x.name === 'relay-a');
    assert.deepEqual(back.env, env);
  });

  test('★★ defaults 目标：写进 `config.json` 的 `defaults.env`，token 文件一个字节不动', async () => {
    const s = gateway();
    const ops = makeOps(s.session(), s.ctx);
    assert.deepEqual((await ops.view()).defaultsEnv, {});
    const tokenBefore = nodeFs.readFileSync(tokenFileOf(s, 'relay-a'), 'utf8');

    const env = { A: 'x', B: '中文也合法' };
    const r = await ops.apply({ op: 'save-env', target: 'defaults', env });

    assert.equal(r.done, false);
    assert.deepEqual(r.view.defaultsEnv, env);
    // ★ 全局默认不是"套到每个 token 上"：每行自己的 `env` 还是空的
    assert.deepEqual(r.view.resources.find((/** @type {any} */ x) => x.name === 'relay-a').env, {});

    const disk = s.readConfig();
    assert.deepEqual(disk.defaults.env, env);
    // ★ 这条写盘路在写之前**整份过** `normalizeConfig`（`saveConfig` 不校验），
    //   顺手钉住它没把 defaults 里别的键抹掉
    assert.deepEqual(disk.defaults.models, [{ id: 'm1' }, { id: 'm2' }]);
    assert.equal(disk.defaults.baseUrl, 'https://gw.test/v1');

    assert.equal(nodeFs.readFileSync(tokenFileOf(s, 'relay-a'), 'utf8'), tokenBefore);
    assert.deepEqual((await reopen(s).view()).defaultsEnv, env);
  });

  test('★★ `{}` = **删键**（回到继承），两个目标都是——绝不写 `{}` 上盘', async () => {
    const s = setup({
      config: { version: 1, defaults: { env: { A: '1', B: '2' } }, bindings: [] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: FAKE_KEY, env: { X: '9' } } },
    });
    const ops = makeOps(s.session(), s.ctx);
    assert.deepEqual((await ops.view()).resources[0].env, { X: '9' });

    await ops.apply({ op: 'save-env', target: 'token', name: 'relay-a', env: {} });
    // ★ 写成 `{}` 与"没有这个键"在合并（§2.3）里结果相同，但盘上是两件事：
    //   前者会让这个 token 永远"有一个空的 env"，后者才是真正的回继承
    assert.equal('env' in readTokenFile(s, 'relay-a'), false);
    assert.deepEqual((await ops.view()).resources[0].env, {});

    await ops.apply({ op: 'save-env', target: 'defaults', env: {} });
    assert.equal('env' in s.readConfig().defaults, false);
    assert.deepEqual((await ops.view()).defaultsEnv, {});
  });

  test('★ 坏目标 / 未知 token / 非对象 / 坏值 → 说一句话，**两个文件都不动**', async () => {
    const s = gateway();
    const ops = makeOps(s.session(), s.ctx);
    const tokenBefore = nodeFs.readFileSync(tokenFileOf(s, 'relay-a'), 'utf8');
    const configBefore = nodeFs.readFileSync(join(s.appDir, 'config.json'), 'utf8');
    const view0 = await ops.view();

    for (const [body, re] of [
      [{ op: 'save-env', target: 'gateway', env: { A: '1' } }, /必须是 token 或 defaults/],
      [{ op: 'save-env', env: { A: '1' } }, /必须是 token 或 defaults/],
      [{ op: 'save-env', target: 'token', name: 'nope', env: { A: '1' } }, /没有 token/],
      [{ op: 'save-env', target: 'token', env: { A: '1' } }, /没有 token/],
      // ★ `null` / 数组 / 字符串都不许被"善意理解"成清空
      [{ op: 'save-env', target: 'defaults', env: null }, /必须是 JSON 对象/],
      [{ op: 'save-env', target: 'defaults', env: [] }, /必须是 JSON 对象/],
      [{ op: 'save-env', target: 'defaults', env: 'A=1' }, /必须是 JSON 对象/],
      // ★ 值的类型**只在服务端**查：前端的 `JSON.parse` 只保证"是个 JSON"
      [{ op: 'save-env', target: 'defaults', env: { N: 123 } }, /必须是字符串/],
      [{ op: 'save-env', target: 'token', name: 'relay-a', env: { '': 'x' } }, /空的环境变量名/],
    ]) {
      const r = await ops.apply(body);
      assert.match(r.view.notice, re, JSON.stringify(body).slice(0, 120));
      assert.deepEqual({ ...r.view, notice: view0.notice }, view0, `${JSON.stringify(body).slice(0, 80)} 动了状态`);
    }
    assert.equal(nodeFs.readFileSync(tokenFileOf(s, 'relay-a'), 'utf8'), tokenBefore);
    assert.equal(nodeFs.readFileSync(join(s.appDir, 'config.json'), 'utf8'), configBefore);
  });
});

describe('★★ 每个 effect 恰好 dispatch 一次', () => {
  test('★★ 六种无副作用的 effect 各回执一次（整个"不需要关联 id"的设计架在这上面）', async () => {
    const s = full();
    const exec = makeExecutor(s.ctx);

    const cases = [
      { fx: { type: 'reload' }, want: 'reloaded' },
      { fx: { type: 'list-dirs', path: s.proj }, want: 'dirs' },
      { fx: { type: 'save-token', name: 'relay-new', secret: FAKE_KEY }, want: 'token-saved' },
      { fx: { type: 'apply-wizard', path: s.proj, token: 'relay-z', models: ['m1'] }, want: 'applied' },
      {
        fx: { type: 'apply-models', target: { path: s.proj, token: 'relay-z', layer: 'project' }, models: ['m9'] },
        want: 'applied',
      },
      { fx: { type: 'delete-binding', path: join(TMP_BASE, 'x', 'client-a') }, want: 'deleted' },
    ];

    for (const c of cases) {
      /** @type {any[]} */
      const got = [];
      await exec(c.fx, (ev) => got.push(ev));
      assert.equal(got.length, 1, `${c.fx.type} 回执了 ${got.length} 次，应该是 1 次`);
      assert.equal(got[0].type, c.want, c.fx.type);
    }
  });

  test('★★ `fetch-models` 失败也是**一个值**，不是异常——照样恰好一次', async () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      // 端口 1 上永远没人听：连不上是**立刻**的（实测 ~50ms），不是 10 秒超时
      tokens: { 'relay-dead': { authToken: FAKE_KEY, name: 'relay-dead', baseUrl: 'http://127.0.0.1:1' } },
    });
    const exec = makeExecutor(s.ctx);

    /** @type {any[]} */
    const got = [];
    await exec({ type: 'fetch-models', token: 'relay-dead' }, (ev) => got.push(ev));

    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'models');
    assert.equal(got[0].ok, false);
    assert.equal(got[0].token, 'relay-dead');
  });

  test('★★ 认不出的副作用 → `failed`，也是恰好一次（这是兜底那张网）', async () => {
    const s = full();
    const exec = makeExecutor(s.ctx);

    /** @type {any[]} */
    const got = [];
    await exec({ type: 'quit' }, (ev) => got.push(ev));

    assert.equal(got.length, 1);
    assert.equal(got[0].type, 'failed');
    assert.match(got[0].error, /认不出的副作用：quit/);
  });

  test('★ `dispatch` 自己抛错时，外层那张网接住并回 `failed`', async () => {
    const s = full();
    const exec = makeExecutor(s.ctx);

    /** @type {any[]} */
    const got = [];
    await exec({ type: 'reload' }, (ev) => {
      got.push(ev);
      // ★ 只炸**第一次**。外层那张网就是靠"再 dispatch 一次 `failed`"报信的，
      //   一个**每次都炸**的假 dispatch 会让它自己也炸掉——那测的就不是这张网，
      //   而是"假 dispatch 抛了两次"。真 dispatch 只写内存，不抛。
      if (got.length === 1) throw new Error('dispatch 炸了');
    });

    assert.equal(got.length, 2);
    assert.equal(got[0].type, 'reloaded');
    assert.equal(got[1].type, 'failed');
    assert.match(got[1].error, /dispatch 炸了/);
  });

  // ⚠️ **`launch` 不在这里测**：它会真的 `spawnTerminal()` 开一个终端窗口
  //    （`{detached:true, stdio:'ignore'}`——连它的 stderr 我们都看不见）。
  //    那条路归 `ui-e2e.test.js`：它走 `CMT_UI=plain` 从头到尾真的启一次。
});

// ═══════════════════════════ 前端资产 ═══════════════════════════

/**
 * `src/web/` 那三件。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么这几条值得测：**这里没有浏览器**
 *
 * 整个项目零依赖 ⇒ 没有 jsdom、没有 playwright、没有前端测试框架。
 * `src/web/app.js` 的每一行都**跑不到**——它只在真浏览器里活。
 *
 * 于是"测不到"的东西必须靠**结构**保证，而这几条断言就是那些结构：
 *
 * | # | 断言 | 不测会怎样 |
 * |---|---|---|
 * | 1 | 三件都在、都非空、路径与 `ASSET_FILES` 对得上 | 白屏，且服务端一个字都不报 |
 * | 2 | `index.html` **没有**内联 `<script>`/`<style>`/`on*=`/`style="…"` | CSP 毙掉它 ⇒ **白屏，控制台没有报错** |
 * | 3 | 没有绝对 URL（`src`/`href`） | `default-src 'none'` 拦掉 ⇒ 样式/脚本静默不加载 |
 * | 4 | `style.css` 没有 `@import` / 外部 `url()` | `font-src` 跟着 `default-src 'none'` 一起关死 |
 * | 5 | ★★ `app.js` 摸到的每个 id 都在 `index.html` 里 | `$('typo')` 返回 `null` ⇒ 首帧 `TypeError` ⇒ **白屏** |
 * | 6 | ★★ `app.js` 把响应体当**视图模型**读，靠 `quitting` 收工 | 读成 `{view, done}` 信封 ⇒ 第一个动作之后 `view` 是 `undefined` ⇒ **整页炸** |
 * | 7 | ★ 三件里不许出现工具名 / 环境变量名 | 它们要**逐字**复制到姊妹项目（§4.1） |
 *
 * ★ 第 5 条是这几条里最值钱的：它是唯一能抓住"手滑打错一个 id"的东西，
 *   而那个错误的**唯一**表现是浏览器里一片白——测试全绿、服务端 200。
 *
 * ★★ 第 6 条守的是一个**真发生过**的 bug（`ui-e2e` 抓出来的）：前端写的是
 *   `view = data.view`，而服务端发的是**裸视图**（`serve-web.js` 的
 *   `sendJson(res, 200, view)`）——两边各自"看着都对"。前端没有测试框架
 *   （零依赖，见 `app.js` 文件头），所以这条只能扫源码。
 * ─────────────────────────────────────────────────────────────
 */
describe('★★ 前端资产：CSP 下能活、id 对得上、不带工具名', () => {
  const WEB = new URL('../src/web/', import.meta.url);
  const read = (/** @type {string} */ f) => nodeFs.readFileSync(new URL(f, WEB), 'utf8');

  const html = read('index.html');
  const js = read('app.js');
  const css = read('style.css');

  /**
   * 剥掉注释再扫。
   *
   * ★★ 必须剥，而且理由是自指的：`index.html` 的说明里**写着**「不许内联
   *    `<script>`」，`style.css` 的说明里**写着**「没有 `@import`」。
   *    不剥的话，这几条规则会先把**它们自己的说明书**抓成违规。
   *
   * ★ 剥掉也是**语义正确**的：注释不是元素、不是声明，浏览器根本不看它。
   *   而工具名那条（下面最后一条）反过来——**要**扫原文，因为注释里写了
   *   工具名，照样会让两个项目的那份文件对不上。
   */
  const stripHtml = (/** @type {string} */ s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const stripCss = (/** @type {string} */ s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

  const HTML = stripHtml(html);
  const JS = stripCss(js);
  const CSS = stripCss(css);

  test('★★ `loadAssets()` 三件都读得到，路径与 `ASSET_FILES` 对得上', () => {
    const assets = loadAssets();

    // ★ 键集**恰好**是这三个：多一个少一个都说明清单和文件对不上了。
    assert.deepEqual([...assets.keys()].sort(), ['/', '/app.js', '/style.css']);

    for (const [p, a] of assets) {
      assert.ok(a.body.length > 0, `${p} 是空的——这份安装不完整`);
      assert.match(a.type, /charset=utf-8/, `${p} 的类型少了 charset（§3 第 8 条）`);
    }

    // ★ 页面挂在 `/<口令>/` 下，所以 `/` 那一份就是 `index.html` 本身。
    assert.equal(assets.get('/').body.toString('utf8'), html);
  });

  test('★★ `index.html` 没有 CSP 会毙掉的那四样', () => {
    // ① 内联 `<script>`：有 `src` 才是外部脚本
    const scripts = HTML.match(/<script\b[^>]*>/g) ?? [];
    assert.ok(scripts.length > 0, '一个 `<script>` 都没有？那这个页面是死的');
    for (const s of scripts) {
      assert.match(s, /\ssrc=/, `内联 <script> 会被 script-src 'self' 毙掉，而且是**静默**的：${s}`);
    }

    // ② 内联 `<style>`
    assert.ok(!/<style\b/i.test(HTML), "内联 <style> 会被 style-src 'self' 毙掉");

    // ③ `on*=` 属性（onclick / onload / onerror…）——**逐标签**扫，
    //    不是整篇正则：`content=` 里就藏着一个 `ontent=`，整篇扫会误伤。
    for (const tag of HTML.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      const bad = tag.match(/\son[a-z]+\s*=/i);
      assert.equal(bad, null, `on*= 是内联脚本，一样被毙：${tag}`);
    }

    // ④ `style="…"` 属性——**同样**被 CSP 毙，这条最容易漏
    assert.ok(!/\sstyle\s*=/i.test(HTML), 'style="…" 属性也被 style-src \'self\' 毙掉，要变的样子全走 class');
  });

  test('★★ 三件里没有绝对 URL（`default-src \'none\'` 会全拦掉）', () => {
    for (const [name, text] of [['index.html', HTML], ['style.css', CSS], ['app.js', JS]]) {
      const abs = text.match(/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//gi);
      assert.equal(abs, null, `${name} 里有绝对 URL：${abs}`);
      const ext = text.match(/url\(\s*["']?\s*(?:https?:)?\/\//gi);
      assert.equal(ext, null, `${name} 里有外部 url()：${ext}`);
    }
    assert.ok(!/@import/i.test(CSS), '`@import` 会被 style-src \'self\' 拦掉');
    // ★ app.js 扫**原文**：它的注释里不该出现任何 URL，出现了也是个该问的问题。
    assert.ok(!/https?:\/\//i.test(js), 'app.js 里出现了绝对 URL');
  });

  test('★★ `app.js` 摸到的每个 id 都在 `index.html` 里', () => {
    /** @type {Set<string>} */
    const have = new Set();
    for (const m of HTML.matchAll(/\sid="([^"]+)"/g)) have.add(m[1]);

    /** @type {Set<string>} */
    const want = new Set();
    // `$('x')` 与 `setText('x', …)`——`setText()` 内部就是 `$(id)`，
    // 它那条路的 id 是字符串字面量，正则得一起收。
    for (const m of JS.matchAll(/(?:\$|setText)\(\s*'([A-Za-z0-9_-]+)'/g)) want.add(m[1]);

    assert.ok(want.size > 20, `只抓到 ${want.size} 个 id——正则是不是没跟上 app.js 的写法？`);

    const missing = [...want].filter((id) => !have.has(id));
    assert.deepEqual(missing, [], `app.js 摸不到的 id（首帧 TypeError ⇒ 白屏）：${missing}`);

    // ★ 反方向：`index.html` 里的 id 也**不该**有没人用的。
    //   死 id 不致命，但它说明某次改动把用法删了、标记留下了——
    //   而下一个读这段 HTML 的人会以为它还有用。
    const unused = [...have].filter((id) => !want.has(id));
    assert.deepEqual(unused, [], `index.html 里没人用的 id：${unused}`);
  });

  test('★★ `app.js` 把响应体当**视图模型**读，靠 `quitting` 收工', () => {
    // ★ 这条守的是一个**真发生过**的 bug：前端写的是 `view = data.view`，
    //   而服务端发的是裸视图（`serve-web.js` 的 `sendJson(res, 200, view)`）,
    //   于是第一个动作之后 `view` 就成了 `undefined`，整页炸掉。
    //   两边各自"看着都对"——所以这个 bug 是**读**出来的，不是测出来的。
    //
    // ⚠️ 前端没有测试框架（零依赖），这条只能扫源码。但它扫的是两个**具体的
    //   词**，不是"猜它怎么写"——`data` 是 `send()` 里那个解析后的响应体。
    assert.doesNotMatch(JS, /data\.view\b/,
      '把响应体当成 `{view, …}` 信封了——服务端发的是**裸视图**');
    assert.doesNotMatch(JS, /\.done\s*===/,
      '在读那个**不上线**的 `done`（它是 `ui-web.js` 给 `serve-web.js` 的收尾信号）');
    // ★ 正方向：`quitting` 得读。少了它，控制台退出了页面还在那儿装活着，
    //   用户点「退出」之后看到的是一个**看起来没反应**的界面。
    assert.match(JS, /\.quitting\b/, '不读 `quitting` 了？那页面没法知道控制台已经退出');
  });

  test('★ 三件里不许出现工具名 / 环境变量名（它们要逐字复制到姊妹项目）', () => {
    // ★ 这一条扫**原文**（连注释一起）：注释里写了工具名，两个项目的那份
    //   文件照样对不上——而"逐字一致"是这条纪律的全部内容。
    for (const [name, text] of [['index.html', html], ['style.css', css], ['app.js', js]]) {
      assert.ok(!/cxt|cmt/i.test(text), `${name} 里出现了工具名`);
      assert.ok(!/codex|claude/i.test(text), `${name} 里出现了产品名`);
      assert.ok(!/CXT_|CMT_/.test(text), `${name} 里出现了环境变量名`);
      // ★ 契约节号也**不许**写：姊妹项目那边这一节是「十」不是「十一」（§4.1）。
      assert.ok(!/§\s*\d/.test(text), `${name} 里出现了契约节号`);
    }
  });
});

// ═══════════════════════════ token 池 ═══════════════════════════

/**
 * 池状态那几块（§2.13 七）。
 *
 * ─────────────────────────────────────────────────────────────
 * 这一段与**视图模型**那一段（本文件开头）是同一类东西：视图键集是跨项目
 * 冻结的接口，池状态就挂在那两个键上（顶层 `poolStatuses` + `resources[].pool`）。
 * 所以这里验的仍然不是"池好不好用"（那是 `pool.test.js` / `pool-store.test.js`
 * / `pool-pick.test.js` 的事），而是**面板与命令行给出的是不是同一个答案**：
 *
 * | 断言 | 错了会怎样 |
 * |---|---|
 * | 六档的中文只在服务端定义一处 | 页面的 `ok/no_quota` 与 `cmt pool list` 说法不一致 |
 * | 没入池的那行四键齐全 | 前端为了 `null` 写分支；而"没探过"其实有确定的样子 |
 * | 手动标注**只写本地** | 点一下状态丸，用量账本被清掉 |
 * | 拒绝路径一个字节都不写 | 打错一个状态词，`pool.json` 半截落盘 |
 * | 现探走的是**真 HTTP**、最小请求 | 探测悄悄变大（花钱）或悄悄不打（永远"未检测"） |
 *
 * ⚠️ 探测桩是真 HTTP、只绑回环、端口交给系统分配（与 `modelStub()` 同一条纪律）。
 * ─────────────────────────────────────────────────────────────
 */

const poolFileOf = (/** @type {any} */ s) => join(s.appDir, 'pool.json');
const writePoolFile = (/** @type {any} */ s, obj) => nodeFs.writeFileSync(
  poolFileOf(s), `${JSON.stringify(obj, null, 2)}\n`, 'utf8',
);
const readPoolFile = (/** @type {any} */ s) => JSON.parse(nodeFs.readFileSync(poolFileOf(s), 'utf8'));

/**
 * 起一个只认探测路径的桩（`POST /v1/messages`——cmt 走 Anthropic 协议那条路）。
 *
 * ★ 把请求体也记下来：那几条断言要证明"发出去的是一条**最小**请求"，
 *   而只看得到 URL 是证明不了的。
 * ★ 路径取**前缀**判据而不是等值：`probe.js` 会按 baseUrl 补 `/v1`，
 *   桩不替它猜，只记录。
 *
 * @param {{ status?: number, body?: string }} [reply]
 */
async function probeStub(reply = {}) {
  const status = reply.status ?? 200;
  const body = reply.body ?? '';
  /** @type {{ url: string, method: string, auth: string, body: string }[]} */
  const hits = [];
  const server = createServer((req, res) => {
    let chunked = '';
    req.on('data', (/** @type {any} */ c) => { chunked += c; });
    req.on('end', () => {
      hits.push({
        url: req.url ?? '', method: req.method ?? '', auth: req.headers.authorization ?? '', body: chunked,
      });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise((/** @type {(v?: any) => void} */ resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = /** @type {{ port: number }} */ (server.address()).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((/** @type {(v?: any) => void} */ resolve) => server.close(resolve)),
  };
}

describe('★★ 资源表 · 池状态：词表与只读的那一半', () => {
  test('★★ `poolStatuses`：六档，顺序就是好坏顺序，中文只在服务端定义一处', () => {
    const v = viewModel(full().session().state);

    assert.deepEqual(
      v.poolStatuses.map((/** @type {any} */ o) => o.status),
      ['ok', 'no_quota', 'invalid', 'net_fail', 'other', 'unknown'],
    );
    // ★ 页面**不自己翻**：这里的中文必须与 `cmt pool list` 是同一份（`STATUS_LABEL`）
    assert.deepEqual(
      v.poolStatuses.map((/** @type {any} */ o) => o.label),
      ['有余额', '无余额', '密钥无效', '连不上', '异常', '未检测'],
    );
    for (const o of v.poolStatuses) {
      assert.deepEqual(Object.keys(o).sort(), ['label', 'status']);
    }
  });

  test('★★ 没入池的那一行也**四个键齐全**（`unknown` / 「未检测」），不是 `null`', () => {
    const s = full();
    const v = viewModel(s.session().state);

    assert.deepEqual(v.resources[0].pool, {
      status: 'unknown', label: '未检测', detail: '', checkedAt: '',
    });
    // ★ 照样**没有** `secret`：池只借这个字段的名，不借它的密文
    assert.equal('secret' in v.resources[0], false);
    // ★ 盘上还是**没有** `pool.json`——看一眼前不会顺手建一个（§3.2 的惰性）
    assert.equal(nodeFs.existsSync(poolFileOf(s)), false);
  });

  test('★ 盘上有条目就照着显示（`detail` 与检测时间都过线，给人看）', () => {
    const s = full();
    writePoolFile(s, {
      version: 1,
      updatedAt: '2026-10-31T01:00:00.000Z',
      entries: {
        'relay-z': {
          status: 'no_quota',
          detail: 'HTTP 402 · insufficient_user_quota',
          checkedAt: '2026-10-31T01:02:03.000Z',
          calls: 3,
          in: 10,
          out: 4,
        },
      },
    });

    const v = viewModel(s.session().state);
    assert.deepEqual(v.resources[0].pool, {
      status: 'no_quota',
      label: '无余额',
      detail: 'HTTP 402 · insufficient_user_quota',
      checkedAt: '2026-10-31T01:02:03.000Z',
    });
  });

  test('★ 认不出的状态词 / 坏条目 → 退化成「未检测」，页面不炸', () => {
    const s = full();
    writePoolFile(s, {
      version: 1,
      entries: { 'relay-z': { status: 'weird', detail: 42, checkedAt: null } },
    });

    // `readPool()` 会先把这一行 normalize 掉；就算它漏过去，视图这一层也有兜底
    const v = viewModel(s.session().state);
    assert.equal(v.resources[0].pool.status, 'unknown');
    assert.equal(v.resources[0].pool.label, '未检测');
    assert.equal(v.resources[0].pool.detail, '');
    assert.equal(v.resources[0].pool.checkedAt, '');
  });
});

describe('★★ 资源表 · 池状态：`set-pool-status`（手动标注，只写本地）', () => {
  test('★★ 标一档 → 落盘 + 视图跟着变 + 重开一个会话还在', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'set-pool-status', name: 'relay-z', status: 'no_quota' });

    assert.equal(r.done, false);
    assert.equal(r.view.resources[0].pool.status, 'no_quota');
    assert.equal(r.view.resources[0].pool.label, '无余额');
    assert.match(r.view.notice, /已标成「无余额」/);

    const disk = readPoolFile(s);
    assert.equal(disk.entries['relay-z'].status, 'no_quota');
    // ★ `manual` 是个**标记**：看 detail 就知道这一档不是探出来的
    assert.equal(disk.entries['relay-z'].detail, 'manual');
    assert.match(disk.entries['relay-z'].checkedAt, /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(
      [disk.entries['relay-z'].calls, disk.entries['relay-z'].in, disk.entries['relay-z'].out],
      [0, 0, 0],
      '★ 标注不是探针，用量一个数都不该动',
    );
    assert.match(disk.updatedAt, /^\d{4}-\d\d-\d\dT/);

    assert.equal((await reopen(s).view()).resources[0].pool.status, 'no_quota');
  });

  test('★★ `unknown` = **清状态**，用量一个字都不动（与 `pool reset` 同义）', async () => {
    const s = full();
    writePoolFile(s, {
      version: 1,
      entries: {
        'relay-z': {
          status: 'ok', detail: 'HTTP 200 · 12ms', checkedAt: '2026-10-31T01:00:00.000Z',
          calls: 3, in: 10, out: 4,
        },
      },
    });
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'set-pool-status', name: 'relay-z', status: 'unknown' });

    assert.equal(r.view.resources[0].pool.status, 'unknown');
    assert.equal(r.view.resources[0].pool.label, '未检测');
    assert.match(r.view.notice, /已清掉 relay-z 的状态/);

    const entry = readPoolFile(s).entries['relay-z'];
    assert.deepEqual([entry.status, entry.detail, entry.checkedAt], ['unknown', '', '']);
    // ★★ 账本是账本：哪个 token 用掉多少与"上次探得怎么样"是两件事
    assert.deepEqual([entry.calls, entry.in, entry.out], [3, 10, 4]);
  });

  test('★ 认不出的名字 / 认不出的状态 → 说一句话，**一个字节都不写**', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);
    const view0 = await ops.view();
    const tokenBefore = nodeFs.readFileSync(tokenFileOf(s, 'relay-z'), 'utf8');

    for (const [body, re] of [
      [{ op: 'set-pool-status', name: 'nope', status: 'ok' }, /没有 token/],
      [{ op: 'set-pool-status', name: '', status: 'ok' }, /没有 token/],
      // ★ 页面的下拉只喂六档，但服务端不靠"页面不会发"来保证正确性
      [{ op: 'set-pool-status', name: 'relay-z', status: 'all' }, /认不出的池状态/],
      [{ op: 'set-pool-status', name: 'relay-z' }, /认不出的池状态/],
      [{ op: 'set-pool-status', name: 'relay-z', status: '' }, /认不出的池状态/],
    ]) {
      const r = await ops.apply(body);
      assert.match(r.view.notice, re, JSON.stringify(body));
      assert.deepEqual({ ...r.view, notice: view0.notice }, view0, `${JSON.stringify(body)} 动了状态`);
    }

    assert.equal(nodeFs.existsSync(poolFileOf(s)), false, '拒掉的请求不该建出 pool.json');
    assert.equal(nodeFs.readFileSync(tokenFileOf(s, 'relay-z'), 'utf8'), tokenBefore);
  });
});

describe('★★ 资源表 · 用量与花费：`sync-usage`（与 `cmt pool sync` 同一份记账）', () => {
  /**
   * 往某个 token 的 profile 里写一份 transcript（只写解析器真正会读的那几个字段）。
   * @param {any} s
   * @param {string} token
   * @param {Record<string, unknown>[]} lines
   */
  const writeTranscript = (s, token, lines) => {
    const dir = join(profileDir(s.home, token), 'projects', 'C--work-demo');
    nodeFs.mkdirSync(dir, { recursive: true });
    nodeFs.writeFileSync(join(dir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  };

  /** 一条 assistant 记录（`usage` 是 claude 自己写的那几个字段名）。 */
  const assistant = (model, input, output, cacheRead = 0) => ({
    type: 'assistant',
    cwd: 'C:\\work\\demo',
    timestamp: '2026-10-30T08:00:00.000Z',
    message: {
      id: `m-${model}-${input}-${output}`,
      model,
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: 0,
        output_tokens: output,
      },
    },
  });

  test('★★ 重算 → 每行六键齐全、概览与之同源，且真的落进 `pool.json`', async () => {
    const s = full();
    writeTranscript(s, 'relay-z', [
      assistant('model-a', 60, 20, 20),
      // ★ 一个没价的模型：它必须让 `cost` 变成**下限**，而不是被静默丢掉
      assistant('model-x', 20, 0),
    ]);
    nodeFs.writeFileSync(
      join(s.appDir, 'prices.json'),
      JSON.stringify({ models: { 'model-a': { input: 3, output: 15, cacheRead: 0.3 } } }),
      'utf8',
    );
    writePoolFile(s, { version: 1, entries: { 'relay-z': { status: 'ok' } } });

    const ops = makeOps(s.session(), s.ctx);
    const r = await ops.apply({ op: 'sync-usage' });

    assert.equal(r.done, false);
    assert.match(r.view.notice, /重算了 1 个 token · 读了 1 份记录/);

    const usage = r.view.resources[0].usage;
    assert.deepEqual(Object.keys(usage).sort(), ['calls', 'cost', 'in', 'out', 'syncedAt', 'unpriced']);
    assert.equal(usage.calls, 2);
    // 输入侧 = 各模型 input + cacheRead + cacheWrite
    assert.equal(usage.in, 60 + 20 + 20);
    assert.equal(usage.out, 20);
    // model-a：60×3 + 20×0.3 + 20×15 = 486 / 1e6
    assert.ok(Math.abs(usage.cost - 0.000486) < 1e-12, `cost=${usage.cost}`);
    assert.equal(usage.unpriced, 1, 'model-x 没价，要数出来');
    assert.match(usage.syncedAt, /^\d{4}-\d\d-\d\dT/);

    // ★★ 概览与明细**同源**：它加的就是上面那一行，不是另算一遍
    const sum = r.view.resourcesSummary;
    assert.deepEqual(Object.keys(sum).sort(), [
      'calls', 'cost', 'costPartial', 'counts', 'in', 'insights', 'out', 'syncedAt',
      'total', 'unpriced',
    ]);
    assert.equal(sum.total, 1);
    assert.equal(sum.calls, usage.calls);
    assert.equal(sum.in, usage.in);
    assert.equal(sum.out, usage.out);
    assert.equal(sum.cost, usage.cost);
    assert.equal(sum.costPartial, true, '有模型没价 ⇒ 合计只是下限');
    assert.equal(sum.unpriced, 1);
    assert.equal(sum.syncedAt, usage.syncedAt);

    // ★ 落盘：命令行 `cmt pool sync` 与这里看的是同一个文件
    const disk = readPoolFile(s);
    assert.deepEqual(disk.entries['relay-z'].models['model-a'], {
      input: 60, cacheRead: 20, cacheWrite: 0, output: 20,
    });
    assert.equal(disk.entries['relay-z'].usageAt, usage.syncedAt);
    // ★ 探测那三样一个都不该被重算动过
    assert.equal(disk.entries['relay-z'].status, 'ok');
  });

  test('★★ 一份记录都没有 ⇒ 归零 + 盖时间戳，回执说清"是没找到"而不是"没用过"', async () => {
    const s = full();
    writePoolFile(s, {
      version: 1,
      entries: { 'relay-z': { status: 'ok', calls: 99, in: 888, out: 777, usageAt: '' } },
    });

    const ops = makeOps(s.session(), s.ctx);
    const r = await ops.apply({ op: 'sync-usage' });

    assert.match(r.view.notice, /一份会话记录都没找到/);
    assert.equal(r.view.resources[0].usage.calls, 0);
    assert.equal(r.view.resources[0].usage.cost, null, '没有用量 ⇒ 不知道花多少，不是 $0');
    assert.equal(r.view.resourcesSummary.cost, null);

    const entry = readPoolFile(s).entries['relay-z'];
    assert.deepEqual([entry.calls, entry.in, entry.out], [0, 0, 0], '重算是覆盖，不是累加');
    // ★ "0 用量"与"从没算过"必须能区分开
    assert.match(entry.usageAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(entry.status, 'ok', '重算不是探测，状态不许动');
  });
});

describe('★★ 资源表 · 池状态：`check-token`（现探，走真 HTTP）', () => {
  test('★★ 200 → 「有余额」；发出去的是一条**最小**请求，密钥只在头里', async (t) => {
    const stub = await probeStub({ status: 200, body: '{"id":"msg_1","content":[]}' });
    t.after(() => stub.close());

    const s = full({ tokens: { 'relay-z': { name: 'relay-z', authToken: FAKE_KEY, baseUrl: stub.baseUrl } } });
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'check-token', name: 'relay-z' });

    assert.equal(r.done, false);
    assert.equal(r.view.resources[0].pool.status, 'ok');
    assert.equal(r.view.resources[0].pool.label, '有余额');
    assert.match(r.view.notice, /relay-z：有余额/);
    // ★ 回执里那行 detail 是"HTTP 200 · Nms"，**不含**任何回应正文
    assert.match(r.view.resources[0].pool.detail, /^HTTP 200 · \d+ms$/);

    assert.equal(stub.hits.length, 1);
    assert.equal(stub.hits[0].method, 'POST');
    // ★★ cmt 走 **Anthropic 协议**：`/v1/messages`（baseUrl 没带 `/v1`，由探测补上）
    assert.equal(stub.hits[0].url, '/v1/messages');
    assert.equal(stub.hits[0].auth, `Bearer ${FAKE_KEY}`);
    const sent = JSON.parse(stub.hits[0].body);
    // ★ 输出上限是 1——多要一个 token 就多花一点钱（`PROBE_MAX_TOKENS`）
    assert.equal(sent.max_tokens, 1);
    assert.deepEqual(sent.messages, [{ role: 'user', content: 'ping' }]);
    // 模型来自解析结果（项目里的 `.cmt.json` 声明的那一个），不是探测自己编的
    assert.equal(sent.model, 'keep-me');
    // ★ 明文密钥**只**在 `Authorization` 里出现一次，请求体里没有
    assert.equal(stub.hits[0].body.includes(FAKE_KEY), false);

    const entry = readPoolFile(s).entries['relay-z'];
    assert.equal(entry.status, 'ok');
    assert.match(entry.checkedAt, /^\d{4}-\d\d-\d\dT/);
  });

  test('★★ 402 + `insufficient_user_quota` → 「无余额」（协议层上它是个正常应答）', async (t) => {
    const stub = await probeStub({
      status: 402,
      body: '{"error":{"message":"insufficient_user_quota"}}',
    });
    t.after(() => stub.close());

    const s = full({ tokens: { 'relay-z': { name: 'relay-z', authToken: FAKE_KEY, baseUrl: stub.baseUrl } } });
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'check-token', name: 'relay-z' });

    assert.equal(r.view.resources[0].pool.status, 'no_quota');
    assert.equal(r.view.resources[0].pool.label, '无余额');
    assert.match(r.view.resources[0].pool.detail, /insufficient_user_quota/);
    assert.equal(readPoolFile(s).entries['relay-z'].status, 'no_quota');
  });

  test('★ 401 → 「密钥无效」（与"没余额"必须分得开）', async (t) => {
    const stub = await probeStub({ status: 401, body: '{"error":{"message":"invalid api key"}}' });
    t.after(() => stub.close());

    const s = full({ tokens: { 'relay-z': { name: 'relay-z', authToken: FAKE_KEY, baseUrl: stub.baseUrl } } });
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'check-token', name: 'relay-z' });
    assert.equal(r.view.resources[0].pool.status, 'invalid');
    assert.equal(r.view.resources[0].pool.label, '密钥无效');
  });

  test('★★ 没有这个 token → 说一句话，**一条请求都不发**', async (t) => {
    const stub = await probeStub();
    t.after(() => stub.close());

    const s = full({ tokens: { 'relay-z': { name: 'relay-z', authToken: FAKE_KEY, baseUrl: stub.baseUrl } } });
    const ops = makeOps(s.session(), s.ctx);
    const view0 = await ops.view();

    for (const body of [
      { op: 'check-token', name: 'nope' },
      { op: 'check-token', name: '' },
    ]) {
      const r = await ops.apply(body);
      assert.match(r.view.notice, /没有 token/, JSON.stringify(body));
      assert.deepEqual({ ...r.view, notice: view0.notice }, view0);
    }
    assert.equal(stub.hits.length, 0);
    assert.equal(nodeFs.existsSync(poolFileOf(s)), false);
  });

  test('★ 没配端点的 token → 「异常」并说清为什么（探测**不抛错**）', async () => {
    const s = full();
    const ops = makeOps(s.session(), s.ctx);

    const r = await ops.apply({ op: 'check-token', name: 'relay-z' });

    assert.equal(r.view.resources[0].pool.status, 'other');
    assert.equal(r.view.resources[0].pool.label, '异常');
    assert.match(r.view.resources[0].pool.detail, /baseUrl/);
    assert.equal(readPoolFile(s).entries['relay-z'].status, 'other');
  });
});
