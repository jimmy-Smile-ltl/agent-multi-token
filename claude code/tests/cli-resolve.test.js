// @ts-check
/**
 * `cmt resolve` 的端到端冒烟（§5：`--json` 是"e2e 冒烟测试的断言载体"）。
 *
 * core/ 的单测已经覆盖了级联规则本身；这里验的是**它们真的接上了**：
 * 参数解析 → 读文件 → 解析 → 注入清单 → 输出。所以本文件**故意重复**几条
 * 已在 resolve.test.js 里断言过的规则——重复的是**链路**，不是规则。
 *
 * 隔离手段：`os.homedir()` 在 Windows 读 `USERPROFILE`、在 POSIX 读 `HOME`，
 * 两个都设上，子进程就落进临时夹具里，碰不到真实配置。
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/cmt.js', import.meta.url));

/** @type {string} */
let ROOT;
/** @type {string} */
let HOME;

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), 'cmt-e2e-'));
  HOME = join(ROOT, 'home');
  const app = join(HOME, '.claude-multi-token');
  mkdirSync(join(app, 'tokens'), { recursive: true });
  mkdirSync(join(ROOT, 'work', 'client-a'), { recursive: true });
  mkdirSync(join(ROOT, 'work', 'client-b'), { recursive: true });
  mkdirSync(join(ROOT, 'work', 'client-c'), { recursive: true });

  const w = (/** @type {string} */ p, /** @type {unknown} */ o) =>
    writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`, 'utf8');

  w(join(app, 'config.json'), {
    version: 1,
    defaults: {
      authToken: '${CMT_E2E_KEY}',
      baseUrl: 'https://api.deepseek.com/anthropic',
      models: [{ id: 'deepseek-flash[1m]' }, { id: 'deepseek-flash' }],
      slots: { haiku: 'deepseek-flash' },
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    },
    bindings: [
      { path: join(ROOT, 'work', 'client-a'), token: 'relay-a' },
      { path: join(ROOT, 'work', 'client-b'), baseUrl: 'https://other.example.com' },
      // ★ 端点也走 ${VAR}：内网中转站就不必落进仓库（§2.4）
      { path: join(ROOT, 'work', 'client-c'), baseUrl: '${CMT_E2E_BASE_URL}' },
    ],
  });

  w(join(app, 'tokens', 'relay-a.json'), {
    name: 'relay-a',
    authToken: 'sk-plaintext-e2e-1234567890',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: [{ id: 'relay-a-model' }],
  });

  // 带 cwd 的 token：用来验"本地路径"能从 token 层来（§2.3 级联的中间那一档）
  w(join(app, 'tokens', 'relay-c.json'), {
    name: 'relay-c',
    authToken: 'sk-plaintext-e2e-0987654321',
    baseUrl: 'https://api.deepseek.com/anthropic',
    cwd: join(ROOT, 'work', 'client-b'),
    models: [{ id: 'relay-c-model' }],
  });
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

/**
 * 跑一次 `cmt resolve`。
 * @param {string[]} argv
 * @param {Record<string, string>} [extraEnv]
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function cmt(argv, extraEnv = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...argv], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME,
        USERPROFILE: HOME, // Windows 的 os.homedir() 看这个
        CMT_E2E_KEY: 'sk-from-env-0987654321',
        CMT_E2E_BASE_URL: 'https://relay.example.com',
        ...extraEnv,
      },
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    const e = /** @type {any} */ (err);
    return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * @param {string[]} argv
 * @param {Record<string, string>} [extraEnv]
 */
function cmtJson(argv, extraEnv) {
  const r = cmt([...argv, '--json'], extraEnv);
  assert.equal(r.code, 0, `期望退出码 0，实际 ${r.code}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe('cmt resolve —— 端到端', () => {
  test('绑定命中：token 来自路径绑定，四要素齐全', () => {
    const j = cmtJson(['resolve', join(ROOT, 'work', 'client-a')]);
    assert.equal(j.ok, true);
    assert.deepEqual(j.missing, []);
    assert.equal(j.tokenName.value, 'relay-a');
    assert.equal(j.tokenName.source, 'binding');
    // 绑定用「调用时的 cwd」匹配（§2.3）
    assert.equal(j.cwd.value, join(ROOT, 'work', 'client-a'));
  });

  test('注入清单真的成形：profile 目录 / 认证 / 模型 / 别名槽', () => {
    const { env, args } = cmtJson(['resolve', join(ROOT, 'work', 'client-a')]);
    assert.equal(env.CLAUDE_CONFIG_DIR, join(HOME, '.claude-multi-token', 'profiles', 'relay-a'));
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-****7890'); // 打码后才出得来（§5）
    assert.equal(env.ANTHROPIC_MODEL, 'relay-a-model');
    // token 没声明 slots → 全槽自动填 models[0]（§2.5）
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'relay-a-model');
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, 'relay-a-model');
    assert.deepEqual(args, ['--name', 'cmt:relay-a']);
  });

  test('未声明的槽自动填 models[0]，显式声明的槽保持不动', () => {
    // client-b 无 token → 用全局 models[0] = deepseek-flash[1m]
    const { env } = cmtJson(['resolve', join(ROOT, 'work', 'client-b')]);
    assert.equal(env.ANTHROPIC_MODEL, 'deepseek-flash[1m]');
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'deepseek-flash[1m]'); // 未声明 → 填
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-flash'); // 显式声明 → 保持
  });

  test('纯 defaults 模式：没有 token 名，profile 落 _default', () => {
    const j = cmtJson(['resolve', join(ROOT, 'work')]); // 无绑定、无 defaults.token
    assert.equal(j.tokenName.value, null);
    assert.equal(j.tokenName.source, 'none');
    assert.equal(j.binding, null);
    assert.equal(j.env.CLAUDE_CONFIG_DIR, join(HOME, '.claude-multi-token', 'profiles', '_default'));
    assert.deepEqual(j.args, ['--name', 'cmt:default']);
  });

  test('${VAR} 从环境求值——不是从配置里抄字面量', () => {
    const { env } = cmtJson(['resolve', join(ROOT, 'work', 'client-b')]);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-****4321'); // CMT_E2E_KEY 的尾 4 位
  });

  test('${VAR} 未设置 → 不注入、报缺项、指名变量，且绝不塞假 token', () => {
    // 故意把 CMT_E2E_KEY 抹成空串
    const j = cmtJson(['resolve', join(ROOT, 'work', 'client-b')], { CMT_E2E_KEY: '' });
    assert.equal(j.ok, false);
    assert.deepEqual(
      j.missing.map((/** @type {any} */ m) => m.key),
      ['token'],
    );
    assert.match(j.missing[0].hint, /CMT_E2E_KEY/);
    assert.equal('ANTHROPIC_AUTH_TOKEN' in j.env, false); // 关键：没有假 token 混进去
    assert.equal(j.unresolved.length, 1);
    assert.match(j.unresolved[0].reason, /CMT_E2E_KEY/);
  });

  // ── baseUrl 的 ${VAR}：与 authToken 同规则（§2.4）────────────────
  describe('baseUrl 的 ${VAR} 引用', () => {
    const C = () => join(ROOT, 'work', 'client-c');

    test('★ 端点从环境求值——配置里只有引用，没有真 URL', () => {
      const j = cmtJson(['resolve', C()]);
      assert.equal(j.ok, true);
      assert.equal(j.env.ANTHROPIC_BASE_URL, 'https://relay.example.com');
      assert.deepEqual(j.elements.baseUrl.ref, { name: 'CMT_E2E_BASE_URL', set: true });
      // 展示层印引用原文（§2.4：resolve 阶段根本不求值）
      assert.equal(j.elements.baseUrl.value, '${CMT_E2E_BASE_URL}');
    });

    test('人类可读输出印「引用（已设置）」，不印端点值', () => {
      const r = cmt(['resolve', C()]);
      assert.equal(r.code, 0);
      assert.match(r.stdout, /✓ apiUrl\s+\$\{CMT_E2E_BASE_URL\}（已设置）/);
    });

    test('★ 未设置 → 不注入、报缺项、指名变量，且绝不塞字面量 ${...}', () => {
      const j = cmtJson(['resolve', C()], { CMT_E2E_BASE_URL: '' });
      assert.equal(j.ok, false);
      assert.deepEqual(
        j.missing.map((/** @type {any} */ m) => m.key),
        ['apiUrl'],
      );
      assert.match(j.missing[0].hint, /CMT_E2E_BASE_URL/);
      assert.equal('ANTHROPIC_BASE_URL' in j.env, false); // 关键：没有假端点混进去
      assert.match(
        j.unresolved.find((/** @type {any} */ u) => u.envVar === 'ANTHROPIC_BASE_URL').reason,
        /CMT_E2E_BASE_URL/,
      );
    });

    test('未设置时人类可读输出标「未设置」且带 ✗', () => {
      const r = cmt(['resolve', C()], { CMT_E2E_BASE_URL: '' });
      assert.equal(r.code, 0); // resolve 永远 0
      assert.match(r.stdout, /✗ apiUrl\s+\$\{CMT_E2E_BASE_URL\}（未设置）/);
    });

    test('--url 也吃引用（识别发生在级联之后的最终值上）', () => {
      const j = cmtJson(['resolve', join(ROOT, 'work', 'client-a'), '--url', '${CMT_E2E_BASE_URL}']);
      assert.equal(j.elements.baseUrl.source, 'cli');
      assert.deepEqual(j.elements.baseUrl.ref, { name: 'CMT_E2E_BASE_URL', set: true });
      assert.equal(j.env.ANTHROPIC_BASE_URL, 'https://relay.example.com');
    });
  });

  test('绑定可以只覆盖 baseUrl——其余项照常往下层找，不受影响', () => {
    const j = cmtJson(['resolve', join(ROOT, 'work', 'client-b')]);
    assert.equal(j.elements.baseUrl.value, 'https://other.example.com');
    assert.equal(j.elements.baseUrl.source, 'binding');
    // 该绑定没写 token，defaults 也没写 → 落进纯 defaults 模式
    assert.equal(j.tokenName.value, null);
    assert.equal(j.tokenName.source, 'none');
    // 但没被覆盖的项照旧来自全局默认
    assert.equal(j.elements.model.source, 'defaults');
    assert.equal(j.authMode.source, 'builtin'); // 谁都没声明 authMode
  });

  test('--model 把指定模型提到首位，其余保持相对顺序', () => {
    const j = cmtJson(['resolve', join(ROOT, 'work', 'client-b'), '--model', 'deepseek-flash']);
    assert.deepEqual(j.elements.model.value, ['deepseek-flash', 'deepseek-flash[1m]']);
    assert.equal(j.elements.model.source, 'cli');
    assert.equal(j.env.ANTHROPIC_MODEL, 'deepseek-flash');
  });

  test('--token 压过路径绑定（命令行优先级最高）', () => {
    const j = cmtJson(['resolve', join(ROOT, 'work', 'client-a'), '--token', 'relay-a']);
    assert.equal(j.tokenName.source, 'cli');
  });

  test('--token 指向不存在的 token → 警告，但不崩', () => {
    const j = cmtJson(['resolve', join(ROOT, 'work'), '--token', 'nope']);
    assert.ok(j.warnings.some((/** @type {string} */ w) => w.includes('nope')));
  });

  test('人类可读输出：四要素带 ✓/✗，密钥打码', () => {
    const r = cmt(['resolve', join(ROOT, 'work', 'client-a')]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /四要素/);
    assert.match(r.stdout, /✓ token/);
    assert.match(r.stdout, /将要注入/);
    assert.match(r.stdout, /ANTHROPIC_AUTH_TOKEN\s+sk-\*{4}7890/);
    assert.doesNotMatch(r.stdout, /sk-plaintext-e2e-1234567890/); // 明文一个字符都不许漏
  });

  test('四要素不齐时退出码仍是 0（诊断命令不该"失败"）', () => {
    const r = cmt(['resolve', join(ROOT, 'work')], { CMT_E2E_KEY: '' });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /✗ token/);
    assert.match(r.stdout, /四要素不完整，缺 1 项/);
  });

  test('--json 与人类可读走的是同一条链（结论一致）', () => {
    const args = ['resolve', join(ROOT, 'work', 'client-a')];
    const j = cmtJson(args);
    const human = cmt(args).stdout;
    assert.equal(j.ok, true);
    assert.match(human, /relay-a/);
    assert.match(human, /relay-a-model/);
  });

  test('--help 有输出且退出码 0', () => {
    const r = cmt(['resolve', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /cmt resolve \[<path>\]/);
  });

  // ── 回归：cwd 的来源层必须如实标注（§2.3）────────────────────────
  // 曾经的 bug：`pickOverrides` 无条件把 `ctx.cwd` 塞进 overrides，
  // 于是"没给 --cwd、只是继承了进程目录"被谎报成「命令行（--cwd）」。
  // 这组用例把三档都钉住——上面那条"绑定命中"用例当时**没能**发现它。
  describe('cwd 的来源层', () => {
    test('位置参数 = 显式指定 → cli', () => {
      const j = cmtJson(['resolve', join(ROOT, 'work', 'client-a')]);
      assert.equal(j.elements.cwd.source, 'cli');
      assert.equal(j.elements.cwd.value, join(ROOT, 'work', 'client-a'));
    });

    test('--cwd 同样算显式指定 → cli', () => {
      const j = cmtJson(['resolve', '--cwd', join(ROOT, 'work', 'client-a')]);
      assert.equal(j.elements.cwd.source, 'cli');
    });

    test('什么都不给 → 当前目录，来源是 cwd 而不是 cli', () => {
      const j = cmtJson(['resolve']); // 继承测试进程的 cwd（仓库目录，无绑定）
      assert.equal(j.elements.cwd.source, 'cwd');
      assert.equal(j.elements.cwd.value, process.cwd());
    });

    test('token 声明了 cwd 且用户没指定目录 → token', () => {
      // relay-c 自带 cwd；从任意目录发起都该落到它那儿
      const j = cmtJson(['resolve', '--token', 'relay-c']);
      assert.equal(j.elements.cwd.source, 'token');
      assert.equal(j.elements.cwd.value, join(ROOT, 'work', 'client-b'));
    });

    test('--cwd 参与绑定匹配（匹配用的是"调用时的目录"，不是 token.cwd）', () => {
      const j = cmtJson(['resolve', '--cwd', join(ROOT, 'work', 'client-a')]);
      assert.equal(j.tokenName.value, 'relay-a');
      assert.equal(j.tokenName.source, 'binding');
      assert.equal(j.binding.path, join(ROOT, 'work', 'client-a'));
    });
  });
});

describe('cmt resolve —— near miss 提示（绑定是字符串匹配，写法不同就失配）', () => {
  test('★ 末段相同、整串对不上 → 把两个串都摆出来，而不是只说「绑定（无）」', () => {
    // 模拟实测踩到的形态：短名/长名中段不同、末段相同（Windows 8.3）。
    // 这里用"父目录不同、末段相同"来构造等价形状。
    const miss = cmt(['resolve', join(ROOT, 'other', 'client-a')]);
    assert.equal(miss.code, 0, 'resolve 永远退出码 0');
    assert.match(miss.stdout, /绑定\s+（无）/);
    assert.match(miss.stdout, /末段相同、整串却对不上/, '该给出 near miss 提示');
    assert.match(miss.stdout, /归一化/, '该把归一化串摆出来供逐字符对照');
  });

  test('--json 里也带上 nearMisses（脚本可断言）', () => {
    const j = cmtJson(['resolve', join(ROOT, 'other', 'client-a')]);
    assert.equal(j.binding, null);
    assert.ok(Array.isArray(j.nearMisses));
    assert.equal(j.nearMisses.length, 1);
    assert.ok(j.nearMisses[0].normalized, '该带上归一化串');
  });

  test('正常命中时不报 near miss（别给正常路径加噪音）', () => {
    const j = cmtJson(['resolve', join(ROOT, 'work', 'client-a')]);
    assert.ok(j.binding, '前提：这条本来就命中');
    assert.deepEqual(j.nearMisses, []);
  });

  test('末段完全不同 → 不报（隔壁目录不算 near miss）', () => {
    const j = cmtJson(['resolve', join(ROOT, 'work', 'client-zzz')]);
    assert.deepEqual(j.nearMisses, []);
  });
});
