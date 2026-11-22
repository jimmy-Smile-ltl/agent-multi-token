// @ts-check
/**
 * ★ `cmt exec` 的**端到端**测试——真的把命令跑起来，读它递给 claude 的东西。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么非这样测不可：`planLaunch()` / `renderPrint()` 只能证明"我们以为自己
 * 会传什么"。从那份计划到子进程真正拿到的环境之间还隔着 spawn、`buildSessionEnv()`
 * 的合并（§2.6）、以及 Windows 上的 cmd shim（§7.8）。所以这里放一个**假 claude**，
 * 让它把自己的 env / argv / cwd 写下来，再逐项断言。
 *
 * 假 claude 是 `claude.cmd`（npm 全局装出来的真实形态），走的是 `cmd.exe /c` 那条
 * 路（`claudeSpawnSpec()`，CVE-2024-27980）——**这条路径在别处一条测试都没有**。
 *
 * ★ 启动前校验（§2.5）那几条必须用**异步**的 `runAsync()`：`/models` 桩跑在
 *   **本进程**里，而 `spawnSync` 会把本进程的事件循环整个冻住——桩连连接都 accept
 *   不到，于是每次都要白等到 2 秒超时。表现和"校验根本没生效"一模一样。
 *
 * ⚠️ 全程 `USERPROFILE` / `HOME` 指向临时目录，**不碰真的 `~`**；
 *   token 一律用一次性假值。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import { tmpdir } from 'node:os';
import { win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ROOT = win32Path.dirname(win32Path.dirname(fileURLToPath(import.meta.url)));
const CMT = win32Path.join(ROOT, 'bin', 'cmt.js');

const TOKEN_VALUE = 'sk-E2E-secret-value-wxyz';

/**
 * 本次跑出来的临时 home，收尾统一删。
 *
 * 清理失败**不能让测试变红**（文件可能还被某个句柄占着），所以整个循环吞掉异常——
 * 临时目录攒着不放是小事，测试结论被它带偏是大事。
 *
 * @type {string[]}
 */
const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了 */ }
  }
});

/**
 * 搭一个临时 home + 假 claude。
 *
 * @param {{ bin: 'cmd', defaults?: Record<string, unknown> }} opts
 *   `defaults` 会盖在标准配置上——启动前校验那组要换 `baseUrl` / `models` / `preflight`。
 */
function setup(opts) {
  const home = nodeFs.mkdtempSync(win32Path.join(tmpdir(), 'cmt-e2e-'));
  TEMP_HOMES.push(home);
  const appDir = win32Path.join(home, '.claude-multi-token');
  nodeFs.mkdirSync(win32Path.join(appDir, 'tokens'), { recursive: true });

  // ── 假 claude：把"子进程实际拿到了什么"写成 JSON ────────────────
  const dumpFile = win32Path.join(home, 'received.json');
  const probeJs = win32Path.join(home, 'probe.mjs');
  nodeFs.writeFileSync(
    probeJs,
    [
      `import nodeFs from 'node:fs';`,
      `const e = process.env;`,
      `nodeFs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({`,
      `  argv: process.argv.slice(2),`,
      `  cwd: process.cwd(),`,
      `  configDir: e.CLAUDE_CONFIG_DIR ?? null,`,
      `  baseUrl: e.ANTHROPIC_BASE_URL ?? null,`,
      `  authToken: e.ANTHROPIC_AUTH_TOKEN ?? null,`,
      `  apiKey: e.ANTHROPIC_API_KEY ?? null,`,
      `  model: e.ANTHROPIC_MODEL ?? null,`,
      `  opus: e.ANTHROPIC_DEFAULT_OPUS_MODEL ?? null,`,
      `  sonnet: e.ANTHROPIC_DEFAULT_SONNET_MODEL ?? null,`,
      `  haiku: e.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? null,`,
      `  fable: e.ANTHROPIC_DEFAULT_FABLE_MODEL ?? null,`,
      `  subagent: e.CLAUDE_CODE_SUBAGENT_MODEL ?? null,`,
      `  aOnly: e.A_ONLY ?? null,`,
      `  childSession: e.CLAUDE_CODE_CHILD_SESSION ?? null,`,
      `  sessionId: e.CMT_SESSION_ID ?? null,`,
      `}, null, 2), 'utf8');`,
      `process.exit(7);`, // ★ 固定退出码，用来验"退出码有没有被原样转发"
      '',
    ].join('\n'),
    'utf8',
  );

  /** @type {any} */
  const defaults = {
    baseUrl: 'https://relay.example.com/v1',
    authMode: 'token',
    // 只放一项 ⇒ 启动前校验直接跳过（没有备选），基础用例因此**一个网络包都不发**
    models: [{ id: 'a' }],
    env: { A_ONLY: 'from-defaults' },
  };
  Object.assign(defaults, opts.defaults ?? {});

  const cmdPath = win32Path.join(home, 'claude.cmd');
  // ★ 照抄 npm 生成的 shim 的写法——**`endLocal` 必须用 `&` 链在真正那条命令前面**。
  //
  //   踩过的坑：把 `SETLOCAL` / `ENDLOCAL` 各写一行（"更干净"的写法）时，
  //   子进程的退出码会被吞成 **0**——`ENDLOCAL` 会把 ERRORLEVEL 复位。
  //   本文件断言退出码 7，所以这份 shim 必须忠实，否则测的是 harness 的 bug。
  nodeFs.writeFileSync(
    cmdPath,
    [
      '@ECHO off',
      'SETLOCAL',
      'SET "_prog=node"',
      `endLocal & "%_prog%" "${probeJs}" %*`,
      '',
    ].join('\r\n'),
    'ascii',
  );
  defaults.claudeBin = cmdPath;

  const configFile = win32Path.join(appDir, 'config.json');
  nodeFs.writeFileSync(
    configFile,
    JSON.stringify({ version: 1, defaults, bindings: [] }, null, 2),
    'utf8',
  );
  nodeFs.writeFileSync(
    win32Path.join(appDir, 'tokens', 'relay-a.json'),
    JSON.stringify({ name: 'relay-a', authToken: TOKEN_VALUE, env: { A_ONLY: 'from-token' } }, null, 2),
    'utf8',
  );

  const childEnv = () => ({
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    // ★ 故意塞一个会话标记：它必须被 `stripSessionMarkers()` 剔掉（§2.6）。
    //   靠"本进程恰好是干净环境"来过这条断言，换个地方跑就成了空炮。
    CLAUDE_CODE_CHILD_SESSION: '1',
  });
  const received = () =>
    nodeFs.existsSync(dumpFile) ? JSON.parse(nodeFs.readFileSync(dumpFile, 'utf8')) : null;

  return {
    home,
    appDir,
    dumpFile,
    configFile,
    profileDir: win32Path.join(appDir, 'profiles', 'relay-a'),
    /** 同步跑一次 `cmt <argv>`（不会碰网络——只在桩不必参与时用） */
    runCmd(/** @type {string[]} */ argv) {
      const r = spawnSync(process.execPath, [CMT, ...argv], {
        encoding: 'utf8',
        env: childEnv(),
        cwd: ROOT,
      });
      return {
        code: r.status,
        out: r.stdout ?? '',
        err: r.stderr ?? '',
        received: received(),
      };
    },
    /** 同步跑一次 `cmt exec relay-a` */
    run(extra = []) {
      return this.runCmd(['exec', 'relay-a', ...extra]);
    },
    /** 异步版本——桩服务要它（见文件头那段说明） */
    async runAsync(extra = []) {
      const child = spawn(process.execPath, [CMT, 'exec', 'relay-a', ...extra], {
        env: childEnv(),
        cwd: ROOT,
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (/** @type {string} */ d) => { out += d; });
      child.stderr.on('data', (/** @type {string} */ d) => { err += d; });
      const code = await new Promise((res) => child.on('close', res));
      return { code, out, err, received: received() };
    },
  };
}

/**
 * 起一个 `/models` 桩：只回答一份清单，并把每次请求记下来。
 *
 * ★ 主机名用 `localhost` 而不是数字回环地址：`tests/source-hygiene.test.js` 的
 *   "白名单之外的 hostname" 守卫只认 `example.*` / `*.test` / `localhost` 这类，
 *   数字地址会被它判成"真地址漏进仓库"（`localhost` 本来就在白名单里）。
 *
 * @param {string[]} ids 端点要说的清单
 * @param {import('node:test').TestContext} t
 */
async function startModelsStub(ids, t) {
  /** @type {{url: string, auth: string | null}[]} */
  const hits = [];
  const server = nodeHttp.createServer((req, res) => {
    hits.push({ url: req.url ?? '', auth: /** @type {string | null} */ (req.headers.authorization ?? null) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await new Promise((res) => server.listen(0, 'localhost', () => res(undefined)));
  t.after(() => {
    // `fetch` 默认用 keep-alive，只关监听器会让 `close()` 等到连接超时
    server.closeAllConnections?.();
    server.close();
  });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { port: addr.port, hits };
}

/**
 * 一个**刚刚被关掉**的端口：连上去必然 ECONNREFUSED（不是超时）。
 *
 * 拿它测"端点不可达"比"指向一个不存在的域名"稳——后者在离线机器上
 * 还会先等一次 DNS。**不需要清理**，返回时监听器已经关干净了。
 */
async function deadPort() {
  const server = nodeHttp.createServer(() => {});
  await new Promise((res) => server.listen(0, 'localhost', () => res(undefined)));
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  await new Promise((res) => server.close(() => res(undefined)));
  return addr.port;
}

// ═══════════════════ ★ shim 路径（本机 npm 的真实形态）═══════════════════

describe('★ cmt exec 端到端 — 经 cmd shim 的假 claude', { skip: !IS_WIN }, () => {
  test('★ 注入的环境原样到达：身份 / 端点 / 模型 / 五个槽 / 逃生舱', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run();

    assert.ok(r.received !== null, `假 claude 没被跑起来。stderr:\n${r.err}`);
    assert.equal(r.received.configDir, s.profileDir, 'CLAUDE_CONFIG_DIR 必须指向该 token 的 profile（§2.2 身份隔离）');
    assert.equal(r.received.authToken, TOKEN_VALUE, '凭证必须注入');
    assert.equal(r.received.apiKey, null, '★ 没选中的那个认证变量必须 unset——否则 authMode 形同虚设（§2.6）');
    assert.equal(r.received.baseUrl, 'https://relay.example.com/v1');
    assert.equal(r.received.model, 'a', 'ANTHROPIC_MODEL 取 models[0]');
    assert.equal(r.received.aOnly, 'from-token', '★ env 是**按键合并**：token 层压过 defaults 层（§2.3）');
    assert.equal(r.received.childSession, null, '★★ 会话标记必须被剔掉——它会让新会话不再落盘（§2.6）');
    assert.equal(r.code, 7, '★ 退出码必须原样转发——吞掉会让"claude 崩了"表现成"一切正常"');
  });

  test('★ 五个槽没声明时全部自动填 models[0]（§2.5 默认规则）', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run();
    for (const k of ['opus', 'sonnet', 'haiku', 'fable', 'subagent']) {
      assert.equal(r.received[k], 'a', `${k} 槽该跟着 models[0] 走`);
    }
  });

  test('★ argv 只有 --name，没有 --fallback-model（交互模式不该假装能回退）', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run();
    assert.deepEqual(r.received.argv, ['--name', 'cmt:relay-a']);
  });

  test('★★ 在场层：exec 写会话记录、退出补 endedAt/exitCode、meta 不含 argv（§2.14）', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run();
    assert.equal(r.code, 7);

    const sessionsDir = win32Path.join(s.appDir, 'sessions');
    assert.equal(nodeFs.existsSync(sessionsDir), true, 'sessions/ 没建');
    const ids = nodeFs.readdirSync(sessionsDir);
    assert.equal(ids.length, 1, `应当恰好一条会话记录，实得 ${ids.join(', ')}`);

    const meta = JSON.parse(
      nodeFs.readFileSync(win32Path.join(sessionsDir, ids[0], 'meta.json'), 'utf8'),
    );
    assert.equal(meta.token, 'relay-a');
    assert.ok(Number.isInteger(meta.pid) && meta.pid > 0);
    assert.ok(meta.startedAt !== '');
    assert.ok(meta.endedAt !== '', '正常退出必须补 endedAt');
    assert.equal(meta.exitCode, 7, '退出码要如实记下来');
    // ★ 泄漏面：meta 永不记 argv、永不含明文 token（--token-value 是 sk）
    assert.equal('argv' in meta, false, 'meta 出现了 argv 字段');
    assert.equal(JSON.stringify(meta).includes(TOKEN_VALUE), false, 'meta 里出现了明文 token');
    // 注入给 claude 的会话 id 与记录一致（msg send 靠它认发送者）
    assert.equal(r.received.sessionId, meta.id);
  });
});

// ═══════════════════ ★ 启动前校验（§2.5）═══════════════════

describe('★★ 启动前校验（§2.5）— 真跑，看它递给 claude 什么', { skip: !IS_WIN }, () => {
  test('★★ 首位不在端点清单里 → 本次改用第二位，且**槽位一起换**', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const r = await s.runAsync();

    assert.ok(r.received !== null, `假 claude 没被跑起来。stderr:\n${r.err}`);
    assert.equal(r.received.model, 'b', '★ 校验挑出来的模型必须真的注入（不是只打印一句）');
    for (const k of ['opus', 'sonnet', 'haiku', 'fable', 'subagent']) {
      assert.equal(r.received[k], 'b', `★ ${k} 槽也得跟着换——否则"看起来切了、实际没切"`);
    }
    assert.match(r.err, /启动前校验/, '换了用户配的模型，必须说一句（这是"静默改配置"的反面）');
  });

  test('★★ 校验**只读**：配置字节不变，也不冒出 resources.json', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });
    const before = nodeFs.readFileSync(s.configFile);

    await s.runAsync();

    assert.ok(nodeFs.readFileSync(s.configFile).equals(before),
      '★ 一次只读探测把 models 重排留在盘上，用户下次根本不知道自己的配置什么时候变的');
    assert.equal(nodeFs.existsSync(win32Path.join(s.appDir, 'resources.json')), false,
      'resources.json 是"拉取登记"，不是校验结果的落点（§2.12 六）');
  });

  test('★ 请求确实打到了 `/v1/models`，并带着这个 token 的凭证', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });
    await s.runAsync();

    assert.equal(stub.hits.length, 1, '★ 只做一次——反复重试就是被 §1.4 禁止的自动故障转移了');
    assert.equal(stub.hits[0].url, '/v1/models');
    assert.equal(stub.hits[0].auth, `Bearer ${TOKEN_VALUE}`,
      '凭证走的是注入时已经求值过的那一条（不新增第二条取密钥的路）');
  });

  test('★ 首位就在清单里 → 一个字都不说', async (t) => {
    const stub = await startModelsStub(['a', 'b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const r = await s.runAsync();

    assert.equal(r.received?.model, 'a');
    assert.deepEqual(r.received?.argv, ['--name', 'cmt:relay-a'], '没换人就不该多出参数');
    assert.equal(r.err.includes('启动前校验'), false, '没事不要喊——喊多了这条警告就没人看了');
  });

  test('★ 一个都不在 → 照配置启动，但要说明（这条不能静默）', async (t) => {
    const stub = await startModelsStub(['x', 'y'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const r = await s.runAsync();

    assert.equal(r.received?.model, 'a', '★ 一个都匹配不上时绝不"随便挑一个"');
    assert.match(r.err, /启动前校验/);
    assert.match(r.err, /a/, '得说清是哪个模型没找到');
  });

  test('★★ 端点不可达 → 秒级放行，且一声不吭', async () => {
    const port = await deadPort();
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const startedAt = Date.now();
    const r = await s.runAsync();
    const elapsed = Date.now() - startedAt;

    assert.equal(r.received?.model, 'a', '端点不通 = 不知道，就按配置启动');
    assert.equal(r.err.includes('启动前校验'), false, '网络抖动不该每次启动都喊一嗓子');
    // ★ 粗阈值即可：这里要证的是"**不阻塞**"，2 秒这个具体数字由
    //   `tests/preflight.test.js` 钉（那里不发真包，测得准）。
    assert.ok(elapsed < 5000, `端点不通时放行太慢（${elapsed}ms）——开始启动就得先等一次网络`);
  });

  test('★★ `defaults.preflight: false` → 一个包都不发', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: {
        baseUrl: `http://localhost:${stub.port}/v1`,
        models: [{ id: 'a' }, { id: 'b' }],
        preflight: false,
      },
    });

    const r = await s.runAsync();

    assert.equal(stub.hits.length, 0, '关掉了还去连，那这个开关就是个摆设');
    assert.equal(r.received?.model, 'a');
  });

  test('★ 只有一项 → 连问都不问（没有备选，问了也换不了人）', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }] },
    });

    await s.runAsync();
    assert.equal(stub.hits.length, 0);
  });

  test('★★ 轮转之后 `--fallback-model` 必须跟着换（拿换人**之前**的 argv 就是错的）', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    // `--` 之后是 claude 自己的旗标（§2.5：`--fallback-model` 仅 --print 有效）。
    const r = await s.runAsync(['--', '--print']);

    assert.equal(r.received?.model, 'b');
    // 轮转后 models = [b, a] ⇒ 回退链是 `a`。读回 `session.injection` 的旧代码会写出 `b`，
    // 也就是"主模型没找到、回退到同一个没找到的模型"——静默，只在 --print 下看得见。
    assert.deepEqual(
      r.received.argv,
      ['--name', 'cmt:relay-a', '--fallback-model', 'a', '--print'],
      '★ 回退链必须是**校验之后**的 models[1..]',
    );
  });

  test('★ `cmt run --print` 不联网（它是诊断视图，根本走不到 exec）', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const r = s.runCmd(['run', 'relay-a', '--print']);
    // `--print` 也要先过终端探测；本机没有可探测的终端时这里没有可断言的东西。
    if (r.code !== 0 && /找不到可用的终端/.test(r.err)) {
      t.skip('本机没有可探测的终端');
      return;
    }

    assert.equal(r.code, 0, r.err);
    assert.equal(stub.hits.length, 0, '★ 诊断视图必须断网也能秒回');
  });
});

// ═══════════════════ ★ 续会话：-c / --continue（§2.5 工作流第二步）═══════════════════

describe('★ -c / --continue —— 模型挂了之后"续上刚才那次会话"', { skip: !IS_WIN }, () => {
  // 契约 §2.5 把 `cmt model next` + `cmt run -c` 写成模型故障转移的两步。
  // 曾经第二步根本跑不起来：`alias` 里写着 `c: 'continue'`，`boolean` 里却**没声明**
  // `continue`——自写解析器的别名只负责"短名 → 长名"，长名本身仍要出现在 spec 里。
  // 于是 `-c` 和 `--continue` 双双落进 `未知选项`。两处（run / exec）都要钉住。

  test('★ `cmt exec -c` 转成 claude 的 `--continue`，退出码照旧转发', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['-c']);
    assert.equal(r.code, 7, `退出码该是假 claude 的 7。stderr:\n${r.err}`);
    assert.deepEqual(r.received?.argv, ['--name', 'cmt:relay-a', '--continue']);
  });

  test('★ 长写法 `--continue` 与 `-c` 等价', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['--continue']);
    assert.equal(r.code, 7, r.err);
    assert.deepEqual(r.received?.argv, ['--name', 'cmt:relay-a', '--continue']);
  });

  test('★ 不给 -c 时一个 `--continue` 都不许冒出来（默认行为不能被顺手改掉）', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run();
    assert.equal(r.received?.argv.includes('--continue'), false);
  });

  test('★★ `cmt run -c --print` 能解析，且 `-c` 落在新窗口要跑的那条命令上', (t) => {
    const s = setup({ bin: 'cmd' });
    const r = s.runCmd(['run', 'relay-a', '-c', '--print']);
    if (r.code !== 0 && /找不到可用的终端/.test(r.err)) {
      t.skip('本机没有可探测的终端');
      return;
    }
    assert.equal(r.code, 0, `曾被解析器拒收（未知选项 -c）。stderr:\n${r.err}`);
    assert.match(r.out, /exec relay-a/, '打印的是窗口内那条 cmt exec');
    assert.match(r.out, /\s-c(\s|$)/, '★ -c 必须转发给窗口里的 exec，否则"续会话"只在新窗口里失效');
  });
});
