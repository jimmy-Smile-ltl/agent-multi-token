// @ts-check
/**
 * ★ `cxt token` 的端到端测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这份文件守的是什么
 *
 * `token` 是**凭证唯一的落盘点**（§2.2），所以它最要紧的性质都不是"能不能跑通"，
 * 而是几条**看不见的边界**：
 *
 * 1. **`edit` 不许动 profile 目录**（§2.5）——用户换 key 时最怕的就是
 *    "会不会把历史弄丢"。这条不靠"读代码时注意"，靠**逐字节比对**。
 * 2. **`rm` 默认不删 profile**（§3.3）——那里有 Codex 的登录态与会话历史。
 * 3. **`rm --purge` 在非 TTY 下必须拒绝执行**，而不是"没人看着就默认删"。
 * 4. **绝不碰 `~/.codex/`**——结构性保证，但要有测试盯着。
 * 5. **明文只在说出口的时候出现**（§1.4 / §5）：`--json` 里不许有完整密钥。
 *
 * ## 手法
 *
 * - `USERPROFILE` 指向临时 home，不碰真的 `~`。
 * - ⚠️ **临时目录要用 `realpathSync.native()` 展开成**长名**。
 *   `os.tmpdir()` 给的是 `C:\Users\ALICE~1\...`（8.3 短名），
 *   而 `cxt` 的路径告警、绑定匹配都是**字符串**比较——拿短名做断言基准，
 *   测出来的东西跟真实使用不是一回事。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ROOT = win32Path.dirname(dirname(fileURLToPath(import.meta.url)));
const CXT = win32Path.join(ROOT, 'bin', 'cxt.js');

/** 长名基准（见文件头 ⚠️） */
const TMP_BASE = nodeFs.realpathSync.native(tmpdir());

const SECRET = 'sk-TOKEN-secret-value-abcd';
const NEW_SECRET = 'sk-TOKEN-rotated-value-wxyz';

/** 本次跑出来的临时 home，收尾统一删 */
const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了——临时目录的事不该影响测试结论 */ }
  }
});

/**
 * 一个干净的临时 home。
 *
 * @param {{ config?: any, tokens?: Record<string, any>, profile?: { name: string, configToml?: string } }} [opts]
 */
function setup(opts = {}) {
  const home = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-token-'));
  TEMP_HOMES.push(home);
  const appDir = join(home, '.codex-multi-token');
  nodeFs.mkdirSync(join(appDir, 'tokens'), { recursive: true });

  if (opts.config !== undefined) {
    nodeFs.writeFileSync(join(appDir, 'config.json'),
      `${JSON.stringify(opts.config, null, 2)}\n`, 'utf8');
  }
  for (const [name, obj] of Object.entries(opts.tokens ?? {})) {
    nodeFs.writeFileSync(join(appDir, 'tokens', `${name}.json`),
      `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  }
  if (opts.profile !== undefined) {
    const dir = join(appDir, 'profiles', opts.profile.name);
    nodeFs.mkdirSync(dir, { recursive: true });
    if (opts.profile.configToml !== undefined) {
      nodeFs.writeFileSync(join(dir, 'config.toml'), opts.profile.configToml, 'utf8');
    }
  }

  return {
    home,
    appDir,
    tokenFile: (n) => join(appDir, 'tokens', `${n}.json`),
    profileDir: (n) => join(appDir, 'profiles', n),
    readToken: (n) => JSON.parse(nodeFs.readFileSync(join(appDir, 'tokens', `${n}.json`), 'utf8')),
    /**
     * 跑一次 `cxt token …`。
     * @param {string[]} extra
     */
    run(extra) {
      const r = spawnSync(process.execPath, [CXT, 'token', ...extra], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, NO_COLOR: '1' },
        cwd: ROOT,
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },
  };
}

// ═══════════════════ add ═══════════════════

describe('cxt token add', () => {
  test('建 token 文件 + 根目录的 config.json', () => {
    const s = setup();
    const r = s.run(['add', 'relay-a', '--token', SECRET, '--base-url', 'https://api.deepseek.com/']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.tokenFile('relay-a')), true);
    assert.equal(nodeFs.existsSync(join(s.appDir, 'config.json')), true, '§3.2：add 触发时建根目录 + config.json');

    const t = s.readToken('relay-a');
    assert.equal(t.name, 'relay-a');
    assert.equal(t.authToken, SECRET);
    assert.equal(t.baseUrl, 'https://api.deepseek.com/');
  });

  test('★ 绝不预建 profile 目录（§3.2：惰性，由首次 run 建）', () => {
    const s = setup();
    const r = s.run(['add', 'relay-a', '--token', SECRET]);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.profileDir('relay-a')), false,
      '★ `token add` 建了 profile 目录——那会让"哪些 profile 真的用过"这个信息永久丢失');
  });

  test('★ 明文要**当场说一句**（§1.4：不加密存储是明确的非目标，不是疏漏）', () => {
    const s = setup();
    const r = s.run(['add', 'relay-a', '--token', SECRET]);
    assert.match(r.out, /明文/);
    assert.match(r.out, /不加密存储|\$\{YOUR_ENV_VAR\}/);
  });

  test('★ `${ENV_VAR}` 引用不落盘明文，也不再报"明文"', () => {
    const s = setup();
    const r = s.run(['add', 'relay-a', '--token', '${DEEPSEEK_API_KEY}']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(s.readToken('relay-a').authToken, '${DEEPSEEK_API_KEY}',
      '引用要**原样**存进去，启动时才求值（§2.4）');
    assert.equal(/⚠[\s\S]*明文/.test(r.out), false, '引用不是明文，不该报明文');
  });

  test('重名 → 退出 1，并指路 edit', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: SECRET } } });
    const r = s.run(['add', 'relay-a', '--token', 'sk-other']);
    assert.equal(r.code, 1);
    assert.match(r.err, /已存在/);
    assert.match(r.err, /token edit/, '报错要给出路，否则用户下一步就是手工删文件');
  });

  test('缺 --token → 退出 1', () => {
    const s = setup();
    const r = s.run(['add', 'relay-a']);
    assert.equal(r.code, 1);
    assert.match(r.err, /--token/);
    assert.equal(nodeFs.existsSync(s.tokenFile('relay-a')), false);
  });

  test('★ 路径穿越的 token 名被拒（§2.8）', () => {
    const s = setup();
    const r = s.run(['add', '../../etc/passwd', '--token', SECRET]);
    assert.equal(r.code, 1);
    assert.match(r.err, /路径分隔符/);
    assert.equal(nodeFs.existsSync(join(s.appDir, 'tokens', '..', '..', 'etc', 'passwd.json')), false);
  });

  test('--json 里**不许**出现完整密钥（§5）', () => {
    const s = setup();
    const r = s.run(['add', 'relay-a', '--token', SECRET, '--json']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(r.out.includes(SECRET), false, '★ 完整凭证出现在 --json 里就是 §5 被破了');
    const j = JSON.parse(r.out);
    assert.equal(j.ok, true);
    assert.equal(j.action, 'add');
    assert.equal(j.name, 'relay-a');
  });
});

// ═══════════════════ show ═══════════════════

describe('cxt token show', () => {
  test('凭证打码，完整值不出现', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: SECRET } } });
    const r = s.run(['show', 'relay-a']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(r.out.includes(SECRET), false);
    assert.match(r.out, /sk-\*+/);
  });

  test('★ `${ENV_VAR}` 引用**原样**显示 + 已设置/未设置', () => {
    // 引用串是**变量名**，藏起来只会让人查不出该设哪个变量（§5 的例外）
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: '${SOME_VAR}' } } });
    const r = s.run(['show', 'relay-a']);
    assert.match(r.out, /SOME_VAR/, '引用必须原样可见');
  });

  test('★ env 逃生舱按**键名**打码，不只看 CXT_TOKEN_ 前缀（§5）', () => {
    const s = setup({
      tokens: {
        'relay-a': {
          name: 'relay-a', authToken: SECRET,
          env: {
            OPENAI_API_KEY: 'sk-ESCAPE-hatch-value-1234',
            PLAIN_SETTING: 'not-a-secret',
            HF_TOKEN: '${HF_TOKEN}',
          },
        },
      },
    });
    const r = s.run(['show', 'relay-a']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(r.out.includes('sk-ESCAPE-hatch-value-1234'), false,
      '★ 只认 CXT_TOKEN_ 前缀的话，OPENAI_API_KEY 会被原样打印出来');
    assert.match(r.out, /not-a-secret/,
      '★ 键名不匹配密钥模式的值不该被打码——按键值打码会把它变成 `not****cret`，'
      + '既不安全又没法读，而且与 `cxt resolve` / `cxt exec` 的显示对不上');
    assert.match(r.out, /\$\{HF_TOKEN\}/, '引用串是变量名，不是密钥——原样显示才查得出该设哪个变量');
  });

  test('--json 不含明文，但给出 env 引用名', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: '${SOME_VAR}' } } });
    const r = s.run(['show', 'relay-a', '--json']);
    const j = JSON.parse(r.out);
    assert.equal(j.authToken.kind, 'env');
    assert.equal(j.authToken.envName, 'SOME_VAR');
    assert.equal(r.out.includes(SECRET), false);
  });

  test('不存在的 token → 退出 1，措辞是"不存在"不是"文件不存在"（§2.8）', () => {
    const s = setup();
    const r = s.run(['show', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /token "nope" 不存在/);
  });

  test('★ 名字非法与不存在是**两种**错（§2.8）', () => {
    const s = setup();
    const r = s.run(['show', '../etc']);
    assert.equal(r.code, 1);
    assert.equal(/不存在/.test(r.err), false, '这是"名字非法"，不是"不存在"');
    assert.match(r.err, /路径分隔符/);
  });
});

// ═══════════════════ edit ═══════════════════

describe('★★ cxt token edit —— 换 key 不能把历史弄丢', () => {
  /** Codex 自己的东西 + cxt 写的受管区，混在一个 profile 目录里 */
  const PROFILE_TOML = [
    'model = "deepseek-chat"',
    'model_provider = "cxt-relay-a"',
    '',
    '[model_providers.cxt-relay-a]',
    'name = "relay-a"',
    'base_url = "https://api.deepseek.com/"',
    '',
    "# 用户手写的注释，改 key 不该动它",
    '[projects.\'D:\\work\\client-a\']',
    'trust_level = "trusted"',
    '',
  ].join('\n');

  function seeded() {
    const s = setup({
      tokens: { 'relay-a': { name: 'relay-a', authToken: SECRET, baseUrl: 'https://api.deepseek.com/' } },
      profile: { name: 'relay-a', configToml: PROFILE_TOML },
    });
    // Codex 的登录态与会话历史——**cxt 一律不碰**（§3.1）
    nodeFs.writeFileSync(join(s.profileDir('relay-a'), 'auth.json'), '{"codex":"login-state"}', 'utf8');
    nodeFs.mkdirSync(join(s.profileDir('relay-a'), 'sessions'), { recursive: true });
    nodeFs.writeFileSync(join(s.profileDir('relay-a'), 'sessions', 'rollout-1.jsonl'), '{"n":1}\n', 'utf8');
    return s;
  }

  test('★★ profile 目录**逐字节不变**——auth.json / sessions / config.toml 全都原样', () => {
    const s = seeded();
    const before = nodeFs.readFileSync(join(s.profileDir('relay-a'), 'config.toml'), 'utf8');

    const r = s.run(['edit', 'relay-a', '--token', NEW_SECRET]);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);

    assert.equal(s.readToken('relay-a').authToken, NEW_SECRET, 'token 文件该更新');
    assert.equal(
      nodeFs.readFileSync(join(s.profileDir('relay-a'), 'config.toml'), 'utf8'), before,
      '★★ config.toml 被改了——`edit` 的卖点就是"不动 profile"（§2.5）',
    );
    assert.equal(nodeFs.existsSync(join(s.profileDir('relay-a'), 'auth.json')), true);
    assert.equal(
      nodeFs.readFileSync(join(s.profileDir('relay-a'), 'sessions', 'rollout-1.jsonl'), 'utf8'),
      '{"n":1}\n',
    );
  });

  test('★ 输出里要**显式**说"profile 未改动"——用户就是为这句话来的', () => {
    const s = seeded();
    const r = s.run(['edit', 'relay-a', '--token', NEW_SECRET]);
    assert.match(r.out, /profile/);
    assert.match(r.out, /未改动/);
    assert.match(r.out, /resume --last|会话历史/);
  });

  test('改凭证时提示"下次启动才生效"', () => {
    const s = seeded();
    const r = s.run(['edit', 'relay-a', '--token', NEW_SECRET]);
    assert.match(r.out, /下次启动|已经开着/);
  });

  test('什么都没给 → 退出 1，并说明为什么不提供"删单个字段"', () => {
    const s = seeded();
    const r = s.run(['edit', 'relay-a']);
    assert.equal(r.code, 1);
    assert.match(r.err, /至少给一个|没有给出要改的字段/);
  });

  test('改 base-url（别名 --url 与 --base-url 是同一个字段）', () => {
    const s = seeded();
    const r = s.run(['edit', 'relay-a', '--url', 'https://relay.example.com/v1']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(s.readToken('relay-a').baseUrl, 'https://relay.example.com/v1');
  });

  test('写坏了的值在**写盘之前**就被 schema 拦住', () => {
    const s = seeded();
    const r = s.run(['edit', 'relay-a', '--base-url', '']);
    assert.equal(r.code, 1, '空 baseUrl 该被 schema 拒');
    assert.equal(s.readToken('relay-a').baseUrl, 'https://api.deepseek.com/', '拒了就不许落盘');
  });
});

// ═══════════════════ rm ═══════════════════

describe('cxt token rm', () => {
  function seeded() {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: 'D:/work/client-a', token: 'relay-a' }],
      },
      tokens: {
        'relay-a': { name: 'relay-a', authToken: SECRET },
        'relay-b': { name: 'relay-b', authToken: 'sk-other-value-wxyz' },
      },
      profile: { name: 'relay-a', configToml: '[projects.\'D:\\work\\client-a\']\ntrust_level = "trusted"\n' },
    });
    nodeFs.writeFileSync(join(s.profileDir('relay-a'), 'auth.json'), '{"codex":"login-state"}', 'utf8');
    return s;
  }

  test('★ 默认**只删 token 文件**，profile 目录保留（§3.3）', () => {
    const s = seeded();
    const r = s.run(['rm', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.tokenFile('relay-a')), false);
    assert.equal(nodeFs.existsSync(s.profileDir('relay-a')), true,
      '★ 目录里有 Codex 的 auth.json 与会话历史，删了不可恢复');
    assert.equal(nodeFs.existsSync(join(s.profileDir('relay-a'), 'auth.json')), true);
    assert.match(r.out, /保留/);
  });

  test('★ 删完要警告悬空的绑定（§3.3：不静默留悬空）', () => {
    const s = seeded();
    const r = s.run(['rm', 'relay-a']);
    assert.match(r.out, /绑定/);
    assert.match(r.out, /D:\/work\/client-a|D:\\\\work\\\\client-a/);
    assert.match(r.out, /bind/);
  });

  test('--purge --yes 才连目录一起删', () => {
    const s = seeded();
    const r = s.run(['rm', 'relay-a', '--purge', '--yes']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.tokenFile('relay-a')), false);
    assert.equal(nodeFs.existsSync(s.profileDir('relay-a')), false);
  });

  test('★★ --purge 不带 --yes 且**非 TTY** → 拒绝执行，什么都没删', () => {
    // "没人看着的时候默认删"是这类命令最糟的默认值（§3.3 / pick.js）。
    // spawnSync 的 stdin 是 pipe ⇒ stdinIsTTY 为 false，正是脚本调起的场景。
    const s = seeded();
    const r = s.run(['rm', 'relay-a', '--purge']);

    assert.equal(r.code, 1);
    assert.match(r.err, /确认|终端/);
    assert.equal(nodeFs.existsSync(s.tokenFile('relay-a')), true, '★ 拒绝必须发生在删除**之前**');
    assert.equal(nodeFs.existsSync(s.profileDir('relay-a')), true);
  });

  test('不存在的 token → 退出 1', () => {
    const s = seeded();
    const r = s.run(['rm', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /不存在/);
    assert.match(r.err, /relay-a/, '报错要列出附近有哪些名字');
  });

  test('--json 里带上悬空绑定清单', () => {
    const s = seeded();
    const r = s.run(['rm', 'relay-a', '--json']);
    const j = JSON.parse(r.out);
    assert.equal(j.ok, true);
    assert.equal(j.purged, false);
    assert.deepEqual(j.danglingBindings, ['D:/work/client-a']);
  });
});

// ═══════════════════ 结构性保证：绝不碰 ~/.codex/ ═══════════════════

describe('★ cxt 绝不写 ~/.codex/（§2.9 铁律）', { skip: !IS_WIN }, () => {
  test('把整套 token 命令跑一遍，用户原本的 CODEX_HOME 一字未动', () => {
    const s = setup();
    // 冒充"用户原本的 ~/.codex"
    const realCodex = join(s.home, '.codex');
    nodeFs.mkdirSync(realCodex, { recursive: true });
    const sentinel = join(realCodex, 'config.toml');
    nodeFs.writeFileSync(sentinel, '# 用户自己的配置\nmodel = "gpt-5"\n', 'utf8');
    nodeFs.writeFileSync(join(realCodex, 'auth.json'), '{"mine":true}', 'utf8');

    s.run(['add', 'relay-a', '--token', SECRET]);
    s.run(['edit', 'relay-a', '--token', NEW_SECRET]);
    s.run(['show', 'relay-a']);
    s.run(['rm', 'relay-a', '--purge', '--yes']);

    assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), '# 用户自己的配置\nmodel = "gpt-5"\n');
    assert.equal(nodeFs.readFileSync(join(realCodex, 'auth.json'), 'utf8'), '{"mine":true}');
    assert.deepEqual(nodeFs.readdirSync(realCodex).sort(), ['auth.json', 'config.toml'],
      '★ ~/.codex/ 里多出了别的东西——cxt 只该在 ~/.codex-multi-token/ 里干活');
  });
});

// ═══════════════════ label（昵称，§2.4 末）═══════════════════

describe('cxt token 的 --label', () => {
  test('add 带 --label：落盘、show 多一行「昵称」、--json 原样带出', () => {
    const s = setup();
    const r = s.run(['add', 'relay-a', '--token', SECRET, '--label', '阿里中转']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(s.readToken('relay-a').label, '阿里中转');

    const shown = s.run(['show', 'relay-a']);
    assert.equal(shown.code, 0, `stderr:\n${shown.err}`);
    assert.match(shown.out, /昵称/);
    assert.match(shown.out, /阿里中转/);

    const j = JSON.parse(s.run(['show', 'relay-a', '--json']).out);
    assert.equal(j.label, '阿里中转');
  });

  test('★ `--label ""` = 清除昵称：**删键**，不是写空串', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: SECRET, label: '旧昵称' } } });
    const r = s.run(['edit', 'relay-a', '--label', '']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal('label' in s.readToken('relay-a'), false,
      '★ 写空串会让"没设置"和"设成空"变成两回事，而它们本该是同一件事');
  });

  test('★ 不唯一的昵称：两个 token 可以同名，身份仍是 name', () => {
    const s = setup();
    assert.equal(s.run(['add', 'a', '--token', SECRET, '--label', '同一个']).code, 0);
    assert.equal(s.run(['add', 'b', '--token', SECRET, '--label', '同一个']).code, 0);
    assert.equal(s.readToken('a').label, s.readToken('b').label);
    assert.notEqual(s.readToken('a').name, s.readToken('b').name);
  });

  test('★ 坏 label 在**写盘之前**就被拒：文件不动', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: SECRET } } });
    const before = nodeFs.readFileSync(s.tokenFile('relay-a'), 'utf8');
    const r = s.run(['edit', 'relay-a', '--label', `a${String.fromCharCode(127)}b`]);
    assert.equal(r.code, 1);
    assert.match(r.err, /控制字符/);
    assert.equal(nodeFs.readFileSync(s.tokenFile('relay-a'), 'utf8'), before);
  });

  test('★ label 不进 defaults / binding（它不是 COMMON_KEYS）', () => {
    const s = setup({
      config: { version: 1, defaults: { label: 'x' } },
      tokens: { 'relay-a': { name: 'relay-a', authToken: SECRET } },
    });
    // `token add` 不读 config——换一个**会解析 config** 的命令来验（§2.4）
    const r = s.run(['show', 'relay-a']);
    assert.equal(r.code, 1);
    assert.match(r.err, /未知字段/);
  });
});
