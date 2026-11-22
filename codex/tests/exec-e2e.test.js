// @ts-check
/**
 * ★ `cxt exec` 的**端到端**测试——真的把命令跑起来，读它给 codex 的东西。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么必须这样测：`--print` 只能证明"我们以为自己会传什么"。
 * 从 `--print` 到子进程真正拿到的环境之间还隔着 spawn、env 合并、
 * 以及 Windows 上的 cmd shim（§7.14⑥）。所以这里放一个**假 codex**，
 * 让它把自己的 env / argv / cwd 写下来，再逐项断言。
 *
 * 假 codex 有两种形态，正好覆盖两条 spawn 路径：
 *
 * | 形态 | `codexBin` | 走哪条路 |
 * |------|-----------|---------|
 * | `codex.cmd` | 生成的 `.cmd` | **shim 路径**（本机 npm 装出来的就是这个形态） |
 * | `process.execPath` + `codexArgs` 指脚本 | 真的 node.exe | **直接路径**（无 shell） |
 *
 * ⚠️ 全程 `USERPROFILE` 指向临时目录（本机实测 Node 在 Windows 上读它），
 * **不碰真的 `~`**。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ROOT = win32Path.dirname(dirname(fileURLToPath(import.meta.url)));
const CXT = win32Path.join(ROOT, 'bin', 'cxt.js');

const TOKEN_VALUE = 'sk-E2E-secret-value-wxyz';

/**
 * 本次跑出来的临时 home，收尾统一删。
 *
 * ⚠️ 不加这个的话每跑一次测试 `%TEMP%` 就多几个 `cxt-e2e-*`——
 * 本仓库实测攒到过 156 个。清理失败**不能让测试变红**（文件可能还被占着），
 * 所以整个循环吞掉异常。
 */
const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了——临时目录的事不该影响测试结论 */ }
  }
});

/**
 * 搭一个临时 home + 假 codex。
 *
 * @param {{bin: 'cmd' | 'node', defaults?: Record<string, unknown>}} opts
 *   `defaults` 会盖在标准配置上——启动前校验那组测试要换 baseUrl / models。
 */
function setup(opts) {
  const home = nodeFs.mkdtempSync(win32Path.join(tmpdir(), 'cxt-e2e-'));
  TEMP_HOMES.push(home);
  const appDir = win32Path.join(home, '.codex-multi-token');
  nodeFs.mkdirSync(win32Path.join(appDir, 'tokens'), { recursive: true });

  // 假 codex：把"子进程实际拿到了什么"写成 JSON
  const dumpFile = win32Path.join(home, 'received.json');
  const probeJs = win32Path.join(home, 'probe.js');
  nodeFs.writeFileSync(probeJs, [
    `import nodeFs from 'node:fs';`,
    `nodeFs.writeFileSync(${JSON.stringify(dumpFile)}, JSON.stringify({`,
    `  argv: process.argv.slice(2),`,
    `  cwd: process.cwd(),`,
    `  codexHome: process.env.CODEX_HOME ?? null,`,
    `  tokenVar: process.env.CXT_TOKEN_RELAY_A ?? null,`,
    `  rustLog: process.env.RUST_LOG ?? null,`,
    `  aOnly: process.env.A_ONLY ?? null,`,
    `  sessionId: process.env.CXT_SESSION_ID ?? null,`,
    `}, null, 2), 'utf8');`,
    `process.exit(7);`, // ★ 固定退出码，用来验"退出码有没有被原样转发"
    '',
  ].join('\n'), 'utf8');

  /** @type {any} */
  const defaults = {
    baseUrl: 'https://api.deepseek.com/',
    wireApi: 'responses',
    models: [{ id: 'deepseek-flash', label: 'Flash' }],
    env: { RUST_LOG: 'warn' },
  };
  Object.assign(defaults, opts.defaults ?? {});

  if (opts.bin === 'cmd') {
    const cmdPath = win32Path.join(home, 'codex.cmd');
    // ★ 照抄 npm 生成的 shim 的写法——**`ENDLOCAL` 必须用 `&` 链在真正那条命令前面**。
    //
    //   踩过的坑：把 `SETLOCAL` / `ENDLOCAL` 各写一行（"更干净"的写法）时，
    //   子进程的退出码会被吞成 **0**——`ENDLOCAL` 会把 ERRORLEVEL 复位。
    //   npm 的模板正是 `endLocal & goto ... & "%_prog%" ... %*`，不是随手写的。
    //   本用例断言退出码 7，所以这份 shim 必须忠实，否则测的是 harness 的 bug。
    nodeFs.writeFileSync(cmdPath, [
      '@ECHO off',
      'SETLOCAL',
      'SET "_prog=node"',
      `endLocal & "%_prog%" "${probeJs}" %*`,
      '',
    ].join('\r\n'), 'ascii');
    defaults.codexBin = cmdPath;
  } else {
    // 直接路径：codexBin 是真的 node.exe（没有 `.cmd` 后缀 → 不走 shim），
    // 脚本路径靠 codexArgs 传进去
    defaults.codexBin = process.execPath;
    defaults.codexArgs = [probeJs];
  }

  nodeFs.writeFileSync(win32Path.join(appDir, 'config.json'),
    JSON.stringify({ version: 1, defaults, bindings: [] }, null, 2), 'utf8');
  nodeFs.writeFileSync(win32Path.join(appDir, 'tokens', 'relay-a.json'),
    JSON.stringify({ name: 'relay-a', authToken: TOKEN_VALUE, env: { A_ONLY: '1' } }, null, 2), 'utf8');

  return {
    home,
    appDir,
    dumpFile,
    profileDir: win32Path.join(appDir, 'profiles', 'relay-a'),
    /** 跑一次 `cxt exec` */
    run(extra = []) {
      const r = spawnSync(process.execPath, [CXT, 'exec', 'relay-a', ...extra], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home },
        cwd: ROOT,
      });
      return {
        code: r.status,
        out: r.stdout ?? '',
        err: r.stderr ?? '',
        received: nodeFs.existsSync(dumpFile)
          ? JSON.parse(nodeFs.readFileSync(dumpFile, 'utf8'))
          : null,
      };
    },
    /**
     * 同一件事的**异步**版本。
     *
     * ★ 启动前校验那组测试必须用它：桩服务跑在**本进程**里，而 `spawnSync`
     *   会把本进程的事件循环整个冻住——桩根本 accept 不到连接，于是每次都要
     *   白等到超时。这不是产品问题，是测试写法问题，但表现完全一样（"校验没生效"）。
     */
    async runAsync(extra = []) {
      const child = spawn(process.execPath, [CXT, 'exec', 'relay-a', ...extra], {
        env: { ...process.env, USERPROFILE: home },
        cwd: ROOT,
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (/** @type {string} */ d) => { out += d; });
      child.stderr.on('data', (/** @type {string} */ d) => { err += d; });
      const code = await new Promise((res) => child.on('close', res));
      return {
        code,
        out,
        err,
        received: nodeFs.existsSync(dumpFile)
          ? JSON.parse(nodeFs.readFileSync(dumpFile, 'utf8'))
          : null,
      };
    },
  };
}

// ═══════════════════ ★ shim 路径（本机 npm 的真实形态）═══════════════════

describe('★ cxt exec 端到端 — 经 cmd shim 的假 codex', { skip: !IS_WIN }, () => {
  test('★ 注入的环境、建好的 profile 目录、原样转发的退出码', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run();

    assert.ok(r.received !== null, `假 codex 没被跑起来。stderr:\n${r.err}`);
    assert.equal(r.received.codexHome, s.profileDir, 'CODEX_HOME 必须指向该 token 的 profile');
    assert.equal(r.received.tokenVar, TOKEN_VALUE, '凭证必须注入');
    assert.equal(r.received.rustLog, 'warn', 'defaults.env 的逃生舱');
    assert.equal(r.received.aOnly, '1', 'token.env 的逃生舱');
    assert.equal(r.code, 7, '★ 退出码必须原样转发——吞掉会让"codex 崩了"表现成"一切正常"');
  });

  test('★ `mkdir -p profiles/<token>/` 真的建了目录（§7.1：Codex 自己不建）', () => {
    const s = setup({ bin: 'cmd' });
    assert.equal(nodeFs.existsSync(s.profileDir), false, '前提：跑之前不存在');
    s.run();
    assert.equal(nodeFs.existsSync(s.profileDir), true,
      '不建的话 Codex 会报 "CODEX_HOME points to ..., but that path does not exist" 然后回落');
  });

  test('★ 受管区被写出来了，且带上了该 token 的 model / provider', () => {
    const s = setup({ bin: 'cmd' });
    s.run();
    const toml = nodeFs.readFileSync(win32Path.join(s.profileDir, 'config.toml'), 'utf8');

    // 引号写成 `['"]` 是**故意**的：受管区优先用 TOML 字面字符串（单引号，
    // 零转义，§7.14②），但那是个实现选择、不是契约；契约管的是键值语义。
    // 断言钉死在引号样式上，会把"换个更安全的引号策略"误报成回归。
    assert.match(toml, /model\s*=\s*['"]deepseek-flash['"]/);
    assert.match(toml, /env_key\s*=\s*['"]CXT_TOKEN_RELAY_A['"]/);
    assert.match(toml, /base_url\s*=\s*['"]https:\/\/api\.deepseek\.com\/['"]/);
    assert.match(toml, /wire_api\s*=\s*['"]responses['"]/);

    // ★ 真正的不变量：`model_provider` 指的那个表，必须在**同一份文件**里存在。
    //   拼错分隔符（`cxt-relay-a` vs `cxt_relay_a`）或漏写表头，都会让 codex
    //   启动即报错——而"两个字符串各写各的、各自都对"正是最容易漏掉的那种 bug。
    //   所以这里不复述字面量，而是**从文件里读出来再交叉验证**。
    const pid = toml.match(/model_provider\s*=\s*['"]([^'"]+)['"]/)?.[1];
    assert.ok(pid, `受管区里没有 model_provider：\n${toml}`);
    const escaped = pid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(toml, new RegExp(`\\[model_providers\\.${escaped}\\]`),
      `model_provider 是 ${pid}，但同文件里没有 [model_providers.${pid}] 表`);
  });

  test('★ 凭证**不落盘**——受管区里只有变量名（§2.2）', () => {
    const s = setup({ bin: 'cmd' });
    s.run();
    const toml = nodeFs.readFileSync(win32Path.join(s.profileDir, 'config.toml'), 'utf8');
    assert.equal(toml.includes(TOKEN_VALUE), false,
      '明文 token 出现在 config.toml 里就是 §2.2 被破了');
  });

  test('★ exec 跳过 token.cwd：不传 `-C`（§2.3 第五条）', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run();
    assert.deepEqual(r.received.argv, [],
      `exec 不该往 codex 传任何参数，实得 ${JSON.stringify(r.received?.argv)}`);
    assert.equal(r.received.cwd, ROOT, 'cwd 应该是调用方的进程目录，原样继承');
  });

  test('★ `--cwd` 显式给出 → 这时才传 `-C`', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['--cwd', ROOT]);
    assert.deepEqual(r.received.argv, ['-C', ROOT]);
  });

  test('★★ 在场层：exec 写会话记录、退出补 endedAt/exitCode、meta 不含 argv（§2.16）', () => {
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
    // 注入给 codex 的会话 id 与记录一致（msg send 靠它认发送者）
    assert.equal(r.received.sessionId, meta.id);
  });

  test('★ `--print` 不留下会话记录（打印不启动）', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['--print']);
    assert.equal(r.code, 0);
    assert.equal(
      nodeFs.existsSync(win32Path.join(s.appDir, 'sessions')),
      false,
      '--print 只打印，不该产生在场记录',
    );
  });

  test('★ `-c` → `resume --last` 落在全局选项之后', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['-c']);
    assert.deepEqual(r.received.argv, ['resume', '--last']);
  });

  test('★ `--` 透传的参数排在 `resume --last` **之后**', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['-c', '--', '--no-alt-screen']);
    assert.deepEqual(r.received.argv, ['resume', '--last', '--no-alt-screen']);
  });

  test('★ 第二次跑是幂等的——受管区不再变（§2.9）', () => {
    const s = setup({ bin: 'cmd' });
    s.run();
    const p = win32Path.join(s.profileDir, 'config.toml');
    const first = nodeFs.readFileSync(p, 'utf8');
    s.run();
    assert.equal(nodeFs.readFileSync(p, 'utf8'), first, '同一份解析结果必须拼出逐字节相同的文件');
  });

  test('★★ 重跑**不吃掉** `[projects.*]`——用户的信任记录比受管区重要（§2.9 最后一道保险）', () => {
    // `[projects.*]` 是 **Codex 自己写的**（§3.1 归属表），cxt 只是恰好和它同住一个文件。
    // 而 cxt 每次跑都会重写受管区——拼接器一旦"顺手清干净"，用户就要每次重新确认信任，
    // 且**没有任何报错**（信任没了的表现是 codex 重新问一遍，看起来像正常行为）。
    //
    // 这条走的是真写盘那条路（`managedRegionDiff` + `writeProfileConfig`），
    // `cxt run` 用的是同一对调用，所以这里覆盖了 run 那条路的写入语义。
    const s = setup({ bin: 'cmd' });
    const p = win32Path.join(s.profileDir, 'config.toml');
    nodeFs.mkdirSync(s.profileDir, { recursive: true });

    // 模拟"Codex 之前写过一次"：一段手写的、cxt 不认识的配置
    const userPart = [
      '[projects."D:\\\\work\\\\trusted"]',
      'trust_level = "trusted"',
      '',
      '[projects."D:\\\\work\\\\other"]',
      'trust_level = "untrusted"',
      '',
    ].join('\n');
    nodeFs.writeFileSync(p, userPart, 'utf8');

    s.run();
    const after1 = nodeFs.readFileSync(p, 'utf8');
    assert.match(after1, /\[projects\."D:\\\\work\\\\trusted"\]/, '★ 第一条信任记录被吃掉了');
    assert.match(after1, /\[projects\."D:\\\\work\\\\other"\]/, '★ 第二条信任记录被吃掉了');
    assert.match(after1, /trust_level\s*=\s*"trusted"/, 'trust_level 也要原样留着');

    // 再跑一次：受管区重写 + 用户区保留，两边都不该漂移
    s.run();
    assert.equal(nodeFs.readFileSync(p, 'utf8'), after1,
      '★ 重跑既不该丢用户区，也不该让受管区漂移');
  });
});

// ═══════════════════ 直接路径（无 shell）═══════════════════

describe('★ cxt exec 端到端 — 直接 spawn（不经 cmd）', { skip: !IS_WIN }, () => {
  test('★ codexBin 不是 `.cmd` 时走直接 spawn，参数一字不差', () => {
    const s = setup({ bin: 'node' });

    // ★ 挑的全是"经 cmd 会被改写"的参数：直接路径必须**原样**送到。
    //   对照组就是上面 shim 那组——同样的字符串走 shim 要转义、这里不该有
    //   任何转义痕迹（带 `&` 的不会被截断、`%` 不会消失、尾部反斜杠不翻倍）。
    const tricky = ['--flag=a & b', '100%', 'say "hi"', 'D:\\proj\\'];
    const r = s.run(['--', ...tricky]);

    assert.ok(r.received !== null, `假 codex 没被跑起来。stderr:\n${r.err}`);
    assert.equal(r.received.codexHome, s.profileDir);
    assert.equal(r.received.tokenVar, TOKEN_VALUE);
    assert.equal(r.code, 7);

    // ⚠️ 这里看不到 `codexArgs` 里的脚本路径——它被 node 自己吃掉了（是 `argv[1]`，
    //    而 probe 报的是 `process.argv.slice(2)`）。所以"脚本跑起来了"这件事
    //    由 `received !== null` 证明，本断言只管**参数转发**。
    assert.deepEqual(r.received.argv, tricky,
      `直接路径不该对参数做任何改写，实得 ${JSON.stringify(r.received.argv)}`);
  });
});

// ═══════════════════ 拒绝启动的分支 ═══════════════════

describe('cxt exec — 该拦的必须拦住', { skip: !IS_WIN }, () => {
  test('★ 四要素不齐 → 退出码 1，且**不启动** codex', () => {
    const s = setup({ bin: 'cmd' });
    nodeFs.writeFileSync(win32Path.join(s.appDir, 'tokens', 'bare.json'),
      JSON.stringify({ name: 'bare' }, null, 2), 'utf8');

    const r = spawnSync(process.execPath, [CXT, 'exec', 'bare'], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: s.home },
      cwd: ROOT,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /四要素不齐全/);
    assert.equal(nodeFs.existsSync(s.dumpFile), false, '★ 拒绝启动就该**一个进程都不起**');
  });

  test('★ 不存在的 token → 退出码 1', () => {
    const s = setup({ bin: 'cmd' });
    const r = spawnSync(process.execPath, [CXT, 'exec', 'nope'], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: s.home },
      cwd: ROOT,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /nope/);
  });

  test('★ 路径穿越的 token 名被拒（§2.8）', () => {
    const s = setup({ bin: 'cmd' });
    const r = spawnSync(process.execPath, [CXT, 'exec', '../../etc/passwd'], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: s.home },
      cwd: ROOT,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /路径分隔符/);
  });

  test('★ `--pick` 在 exec 上**不存在**——交互式选择器不该出现在启动路径上', () => {
    // 理由与 `cxt resolve` 相同（见 commands/resolve.js 的注释）：exec 是
    // launch 脚本调用的那一环，可能跑在非 TTY 里，给它一个交互选择器是错的。
    const s = setup({ bin: 'cmd' });
    const r = spawnSync(process.execPath, [CXT, 'exec', 'relay-a', '--pick'], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: s.home },
      cwd: ROOT,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /未知选项 --pick/);
    assert.equal(nodeFs.existsSync(s.dumpFile), false, '更不该因此把 codex 跑起来');
  });
});

// ═══════════════════ --print 不产生副作用 ═══════════════════

describe('cxt exec --print — 只看不跑', { skip: !IS_WIN }, () => {
  test('★ 不启动进程、不建 profile 目录、不写 config.toml', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['--print']);

    assert.equal(r.code, 0);
    assert.equal(nodeFs.existsSync(s.dumpFile), false, '★ --print 绝不该跑起来任何东西');
    assert.equal(nodeFs.existsSync(s.profileDir), false, '★ --print 绝不该建目录');
    assert.equal(nodeFs.existsSync(win32Path.join(s.profileDir, 'config.toml')), false);
  });

  test('★ 但要把"将要执行什么"说清楚：CODEX_HOME / 环境 / 命令', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['--print', '--cwd', ROOT]);

    assert.match(r.out, /CODEX_HOME/);
    assert.match(r.out, /profiles[\\/]relay-a/);
    assert.match(r.out, /codex\.cmd/);
    assert.match(r.out, /D:\/explicit|--cwd|ROOT/);
    assert.match(r.out, /-C/);
  });

  test('★ 凭证在 --print 里也必须打码（§5 脱敏规则）', () => {
    const s = setup({ bin: 'cmd' });
    const r = s.run(['--print']);
    assert.equal(r.out.includes(TOKEN_VALUE), false, '--print 的输出里不能出现完整凭证');
    assert.match(r.out, /sk-\*+/, '应该是打码形态');
  });
});

// ═══════════════════ ★ 启动前校验（§2.5）═══════════════════

/**
 * 起一个 `/models` 桩：只回答一份清单，并把每次请求记下来。
 *
 * ★ 主机名用 `localhost` 而不是数字回环地址：`tests/source-hygiene.test.js` 的
 *   "白名单之外的 hostname" 守卫只认 `example.*` / `*.test` / `localhost` 这类，
 *   数字地址会被它判成"真地址漏进仓库"。这不是绕守卫——`localhost` 本来就是
 *   回环的正名，守卫的白名单里也明写着它。
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

/** 受管区里写的 `model = ...` 那一行读出来 */
function managedModel(s) {
  const toml = nodeFs.readFileSync(win32Path.join(s.profileDir, 'config.toml'), 'utf8');
  return toml.match(/^\s*model\s*=\s*['"]([^'"]*)['"]/m)?.[1] ?? null;
}

describe('★★ 启动前校验（§2.5）— 真跑，看它递给 codex 什么', { skip: !IS_WIN }, () => {
  test('★★ 首位不在端点清单里 → 本次改用第二位，且**只对这一次生效**', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const r = await s.runAsync();

    assert.ok(r.received !== null, `假 codex 没被跑起来。stderr:\n${r.err}`);
    assert.deepEqual(r.received.argv, ['-c', 'model=b'],
      '★ 校验挑出来的模型必须从 `-c` 走——它不能等受管区的写盘时序');
    assert.match(r.err, /启动前校验/, '换了用户配的模型，必须说一句（这是"静默改配置"的反面）');
    assert.match(r.err, /b/, '那一句里要有换成谁了');

    // ★★ 这条是整套设计的地基：**受管区写的是配置值，不是本次生效值**。
    //   写穿的话，一次只读探测就把 `model = 'b'` 永久留在 config.toml 里，
    //   用户下次根本不知道自己的配置什么时候变的。
    assert.equal(managedModel(s), 'a',
      '★ 受管区必须仍是配置值 a；校验的结论不落盘（§2.5「只读」）');
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

  test('★ 首位就在清单里 → 一个字都不说，也不加 `-c`', async (t) => {
    const stub = await startModelsStub(['a', 'b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const r = await s.runAsync();

    assert.deepEqual(r.received?.argv, [], '没换人就不该多出参数');
    assert.equal(r.err.includes('启动前校验'), false, '没事不要喊——喊多了这条警告就没人看了');
    assert.equal(managedModel(s), 'a');
  });

  test('★ 一个都不在 → 照配置启动，但要说明（这条不能静默）', async (t) => {
    const stub = await startModelsStub(['x', 'y'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const r = await s.runAsync();

    assert.deepEqual(r.received?.argv, [], '★ 一个都匹配不上时绝不"随便挑一个"');
    assert.match(r.err, /启动前校验/);
    assert.match(r.err, /a/, '得说清是哪个模型没找到');
  });

  test('★★ 端点不可达 → 秒级放行，参数跟没开校验时一模一样', async () => {
    const port = await deadPort();
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const startedAt = Date.now();
    const r = await s.runAsync();
    const elapsed = Date.now() - startedAt;

    assert.deepEqual(r.received?.argv, [], '端点不通 = 不知道，就按配置启动');
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
    assert.deepEqual(r.received?.argv, []);
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

  test('★ `--print` 不联网（§2.5 边界③）——但它要提前说真跑时会校验', async (t) => {
    const stub = await startModelsStub(['b'], t);
    const s = setup({
      bin: 'cmd',
      defaults: { baseUrl: `http://localhost:${stub.port}/v1`, models: [{ id: 'a' }, { id: 'b' }] },
    });

    const r = await s.runAsync(['--print']);

    assert.equal(r.code, 0);
    assert.equal(stub.hits.length, 0, '★ 诊断视图必须断网也能秒回');
    assert.match(r.out, /启动前校验已开启/, '要让用户知道"打印出来的不是一定跑起来的"');
    assert.match(r.out, /不联网/);
  });
});
