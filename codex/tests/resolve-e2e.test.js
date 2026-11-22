// @ts-check
/**
 * ★ `cxt resolve` 的端到端测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这份文件守的是什么
 *
 * `tests/resolve.test.js` 已经把 `core/resolve.js` 的级联穷举过了。这份管的是
 * **接上命令行之后**才存在的那几条性质——它们全在 §4.4 第 8 步那句话上：
 *
 * > `cxt resolve` **不需要终端探测、不需要 spawn、不需要 codex 存在**，
 * > 所以它是整条解析链的第一道可验证关口。
 *
 * 那条性质是**可以测的**，而它一旦破了，用户会在最不该出错的时候拿到一个
 * 无关的报错（"找不到终端"），然后开始怀疑自己的配置。所以：
 *
 * 1. **PATH 清空、codex 不在、没有终端** → 它照样得跑出完整结果。
 * 2. **四要素缺项不是命令失败**（退出码仍是 0）——那正是它要展示的东西。
 *    真要拦启动的是 `cxt run` / `cxt exec`。
 * 3. **凭证打码**，且 `--json` 里**不许**出现 `tokenObject` / `binding`
 *    （那两个内部结构原样带着明文 `authToken`，漏出去等于打码白做了）。
 * 4. **它是只读的**——连受管区的"漂移"都只是**算出来**，不落盘。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = win32Path.dirname(dirname(fileURLToPath(import.meta.url)));
const CXT = win32Path.join(ROOT, 'bin', 'cxt.js');

/** 长名基准（`os.tmpdir()` 给的是 8.3 短名，见 token-e2e 的说明） */
const TMP_BASE = nodeFs.realpathSync.native(tmpdir());

/** ★ 一个显眼的假密钥：出现在任何输出里都算 §5 被破了 */
const SECRET = 'sk-LEAK-canary-do-not-print-9999';
const PROJ = 'D:\\work\\client-a';

/**
 * 一份**受管区已经一致**的 config.toml（第三个状态：幂等）。
 *
 * ⚠️ 这个字面量是**观察来的**，不是编的：它来自 `cxt run` 真实写入后的文件
 * （探针实测 `report.changed === false`）。所以它同时是这份格式的一份快照——
 * 拼接器的输出格式若变了（引号风格、section 前空行），**这条会红**，
 * 而那是**测试该告诉你的事**：回去核对 `toml-splice` 的格式，
 * 顺便确认这不是"幂等性"本身坏了（那由 `tests/toml-splice.test.js` 守着）。
 *
 * 注意 section 前那个**空行**不是装饰：没有它 `report.changed` 就是 true。
 */
const CONSISTENT_TOML = "# 用户自己的注释\n"
  + "model = 'deepseek-chat'\n"
  + "model_provider = 'cxt-relay-a'\n"
  + "\n[model_providers.cxt-relay-a]\n"
  + "name = 'cxt relay-a'\n"
  + "base_url = 'https://api.deepseek.com/'\n"
  + "env_key = 'CXT_TOKEN_RELAY_A'\n"
  + "wire_api = 'responses'\n";

const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了 */ }
  }
});

/**
 * @param {{ config?: any, tokens?: Record<string, any>,
 *           profile?: { name: string, toml?: string } }} [opts]
 */
function setup(opts = {}) {
  const home = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-resolve-'));
  TEMP_HOMES.push(home);
  const appDir = join(home, '.codex-multi-token');
  nodeFs.mkdirSync(join(appDir, 'tokens'), { recursive: true });

  nodeFs.writeFileSync(join(appDir, 'config.json'),
    `${JSON.stringify(opts.config ?? { version: 1, defaults: {}, bindings: [] }, null, 2)}\n`, 'utf8');

  for (const [name, obj] of Object.entries(opts.tokens ?? {})) {
    nodeFs.writeFileSync(join(appDir, 'tokens', `${name}.json`),
      `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  }
  const cfgPath = (n) => join(appDir, 'profiles', n, 'config.toml');
  if (opts.profile !== undefined) {
    nodeFs.mkdirSync(join(appDir, 'profiles', opts.profile.name), { recursive: true });
    nodeFs.writeFileSync(cfgPath(opts.profile.name), opts.profile.toml ?? '', 'utf8');
  }

  return {
    home,
    appDir,
    cfgPath,
    readCfg: (n) => nodeFs.readFileSync(cfgPath(n), 'utf8'),
    /**
     * @param {string[]} extra
     * @param {{ env?: Record<string, string> }} [o]
     */
    run(extra, o = {}) {
      const r = spawnSync(process.execPath, [CXT, 'resolve', ...extra], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, NO_COLOR: '1', ...o.env },
        cwd: ROOT,
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },
  };
}

/** 四要素齐全的一套 */
function complete(opts = {}) {
  return setup({
    config: {
      version: 1,
      defaults: {},
      bindings: [{ path: PROJ, token: 'relay-a' }],
    },
    tokens: {
      'relay-a': {
        name: 'relay-a',
        authToken: SECRET,
        baseUrl: 'https://api.deepseek.com/',
        models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
      },
    },
    ...opts,
  });
}

// ═══════════════════ 那道"第一道可验证关口" ═══════════════════

describe('★★ cxt resolve 不需要终端、不需要 codex、不需要 spawn（§4.4 第 8 步）', () => {
  test('★ PATH 清空、没有 codex、没有终端变量 → 照样跑出完整结果', () => {
    // 破了的话，用户会在最不该出错的时候拿到一个无关的报错（"找不到终端"），
    // 然后开始怀疑自己的配置——而配置根本没毛病。
    const s = complete();
    const r = s.run([PROJ], { env: { PATH: '', TERM: '', TERMINAL: '', TERM_PROGRAM: '' } });

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /cxt resolve/);
    assert.match(r.out, /api\.deepseek\.com/, '解析结果该完整，不该因为没终端就少东西');
    assert.equal(/找不到|未找到终端|tried/.test(r.err), false, '不该冒出任何终端探测的报错');
  });

  test('★ 只读：连"漂移"都只是算出来，一个文件都不写', () => {
    const s = complete();
    const before = nodeFs.readdirSync(s.appDir, { recursive: true }).map(String).sort();

    s.run([PROJ]);
    s.run([PROJ, '--json']);

    assert.deepEqual(nodeFs.readdirSync(s.appDir, { recursive: true }).map(String).sort(), before,
      '★ resolve 一旦开始写东西，它就不能再当"先看一眼"的那一步用了');
    assert.equal(nodeFs.existsSync(s.cfgPath('relay-a')), false);
  });

  test('★★ 四要素缺项**不是命令失败**——退出码仍是 0，缺什么在表里说', () => {
    // 真要拦启动的是 `cxt run` / `cxt exec`（§2.1）。
    const s = setup();   // 一个 token 都没有
    const r = s.run([PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}——resolve 的职责就是把缺什么说清楚`);
    assert.match(r.out, /四要素不齐全，缺少：authToken、baseUrl、model/);
    assert.match(r.out, /\(缺\)/);
    assert.match(r.out, /cxt run \/ cxt exec 会拒绝启动/);
  });

  test('★ `--pick` **刻意不被认**——给它交互式选择器就毁了这条性质', () => {
    const s = complete();
    const r = s.run([PROJ, '--pick']);
    assert.equal(r.code, 1);
    assert.match(r.err, /未知选项 --pick/);
    assert.match(r.err, /cxt --help/);
  });

  test('未知选项 → 退出 1', () => {
    const s = complete();
    const r = s.run([PROJ, '--nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /未知选项/);
  });
});

// ═══════════════════ 来源层 ═══════════════════

describe('cxt resolve —— 每项都标了来源层（这是它存在的理由）', () => {
  test('★ 命中绑定 → 从 token 文件拿到的项标成"token 文件"', () => {
    const s = complete();
    const j = JSON.parse(s.run([PROJ, '--json']).out);

    assert.equal(j.bindingPath, PROJ);
    assert.equal(j.token.value, 'relay-a');
    assert.equal(j.token.source, 'binding', '身份来自绑定，不是来自命令行');
    assert.equal(j.baseUrl.value, 'https://api.deepseek.com/');
    assert.equal(j.baseUrl.source, 'token');
    assert.equal(j.model.value.id, 'deepseek-chat');
    assert.equal(j.model.source, 'token');
    assert.deepEqual(j.missing, []);
  });

  test('★ 人读输出把来源层翻成中文（`binding` → 「路径绑定」）', () => {
    const s = complete();
    const r = s.run([PROJ]);
    assert.match(r.out, /relay-a\s+路径绑定/);
    assert.match(r.out, /token 文件/);
    assert.match(r.out, /cxt-relay-a\s+派生/);
  });

  test('★ 没有命中绑定 → 说清楚"没有命中任何路径绑定"', () => {
    const s = complete();
    const r = s.run(['D:\\work\\elsewhere']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /没有命中任何路径绑定/);
  });

  test('★ 命令行覆盖 → 来源标成"命令行"（层级最高）', () => {
    const s = complete();
    const j = JSON.parse(s.run([PROJ, '--url', 'https://override.example.com/', '--json']).out);
    assert.equal(j.baseUrl.value, 'https://override.example.com/');
    assert.equal(j.baseUrl.source, 'cli');
  });

  test('★ 一律按 **run 入口** 解析（token.cwd 生效），并在输出里说明', () => {
    const s = complete();
    const r = s.run([PROJ]);
    assert.match(r.out, /入口 run：token\.cwd 生效/);
    assert.equal(/入口 exec/.test(r.out), false, 'resolve 只讲 run 入口这一个故事');
  });

  test('--token 指定另一个 token（名字，不是密钥）', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {
        'relay-a': { name: 'relay-a', authToken: SECRET, baseUrl: 'https://a/', models: [{ id: 'ma' }] },
        'relay-b': { name: 'relay-b', authToken: 'sk-b-wxyz', baseUrl: 'https://b/', models: [{ id: 'mb' }] },
      },
    });
    const j = JSON.parse(s.run([PROJ, '--token', 'relay-b', '--json']).out);
    assert.equal(j.token.value, 'relay-b');
    assert.equal(j.token.source, 'cli');
    assert.equal(j.baseUrl.value, 'https://b/');
    assert.equal(j.model.value.id, 'mb');
  });

  test('★★ `--token` 撞上带覆盖项的绑定 → **警告**（A 的凭证接到 B 的地址上）', () => {
    // 绑定层比 token 层更具体（§2.3），所以 baseUrl 会从**绑定**里取，
    // 而身份是 --token 给的——静默混用凭证与端点是安全坑，必须说出来。
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: PROJ, token: 'relay-a', baseUrl: 'https://a-endpoint.example.com/' }],
      },
      tokens: {
        'relay-a': { name: 'relay-a', authToken: SECRET, baseUrl: 'https://a/' },
        'relay-b': { name: 'relay-b', authToken: 'sk-b-wxyz', baseUrl: 'https://b/' },
      },
    });
    const r = s.run([PROJ, '--token', 'relay-b']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /这会把 A 的凭证接到 B 的地址上/);
    assert.match(r.out, /--token relay-b/);

    const j = JSON.parse(s.run([PROJ, '--token', 'relay-b', '--json']).out);
    assert.equal(j.baseUrl.source, 'binding', '绑定层确实赢了——这正是要警告的原因');
    assert.equal(j.warnings.length, 1);
    assert.equal(j.warnings[0].code, 'explicit-token-mixed-with-binding');
  });

  test('★ `--token-value` 直接给密钥，来源标成命令行', () => {
    const s = complete();
    const j = JSON.parse(s.run([PROJ, '--token-value', 'sk-direct-value-1234', '--json']).out);
    assert.equal(j.authToken.source, 'cli');
    assert.equal(j.authToken.value, 'sk-****1234', '★ 打码仍然要生效');
  });

  test('★★ `--model` 只影响本次解析，**受管区仍写配置值**（§2.5）', () => {
    // 两种错法都要避开：写成本次的值 → cxt 自己制造一份漂移；
    // 干脆不写 → 拼接器把原有的 `model` 删掉，"这次换个模型"顺手抹掉持久配置。
    const s = complete({ profile: { name: 'relay-a', toml: CONSISTENT_TOML } });
    const j = JSON.parse(s.run([PROJ, '--model', 'deepseek-reasoner', '--json']).out);

    assert.equal(j.model.value.id, 'deepseek-reasoner');
    assert.equal(j.model.source, 'cli');
    assert.deepEqual(j.models.value, [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }],
      'models（配置里的优先级表）不该被 --model 改掉');
    assert.equal(j.managedRegion.changed, false,
      '★ 受管区里写的是 models[0]，不是本次覆盖的那个——所以它仍是幂等的');
    assert.equal(s.readCfg('relay-a'), CONSISTENT_TOML, '文件一个字都没动');
  });
});

// ═══════════════════ 脱敏 ═══════════════════

describe('★ cxt resolve 的脱敏（§5 + §2.4）', () => {
  test('★★ 人读输出里不出现完整凭证', () => {
    const s = complete();
    const r = s.run([PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(r.out.includes(SECRET), false);
    assert.match(r.out, /sk-\*{4}9999/, '打码是"前 3 后 4"');
  });

  test('★★ `--json` 里不出现完整凭证，也不导出内部结构', () => {
    const s = complete();
    const r = s.run([PROJ, '--json']);

    assert.equal(r.out.includes(SECRET), false, '★ --json 是给脚本消费的，更要守规矩');
    const j = JSON.parse(r.out);
    assert.equal(j.tokenObject, undefined,
      '★ tokenObject 原样带着明文 authToken，漏出去等于打码白做了');
    assert.equal(j.binding, undefined, 'binding 是内部结构，同样不导出');
    assert.equal(j.authToken.value, 'sk-****9999');
    assert.equal(j.authToken.kind, 'literal');
  });

  test('★ 注入的环境变量按**名**打码（逃生舱里可能塞着别的密钥）', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: PROJ, token: 'relay-a' }] },
      tokens: {
        'relay-a': {
          name: 'relay-a', authToken: SECRET, baseUrl: 'https://a/', models: [{ id: 'm' }],
          env: { OPENAI_API_KEY: 'sk-ESCAPE-hatch-value-1234', PLAIN_SETTING: 'not-a-secret' },
        },
      },
    });
    const r = s.run([PROJ, '--json']);
    const j = JSON.parse(r.out);

    assert.equal(r.out.includes('sk-ESCAPE-hatch-value-1234'), false,
      '★ 只认 CXT_TOKEN_ 前缀的话，OPENAI_API_KEY 会被原样打印出来');
    assert.equal(j.env.value.PLAIN_SETTING, 'not-a-secret',
      '★ 按键值打码会把它变成 not****cret——既不安全又没法读');
    assert.equal(j.env.value.OPENAI_API_KEY, 'sk-****1234');
  });

  test('★★ `${ENV_VAR}` 引用：**原样显示变量名** + 标注已设置/未设置（§2.4）', () => {
    // 把引用串打成 `${D****_KEY}` 的话，用户看不出该 export 哪一个变量——
    // 而"这一项为什么没生效"正是 `cxt resolve` 存在的理由。
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: PROJ, token: 'relay-a' }] },
      tokens: {
        'relay-a': {
          name: 'relay-a', authToken: '${SOME_UNSET_KEY_XYZ}',
          baseUrl: 'https://a/', models: [{ id: 'm' }],
        },
      },
    });
    const r = s.run([PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}——检测缺项本来就不需要求值凭证`);
    assert.match(r.out, /\$\{SOME_UNSET_KEY_XYZ\}\s+（⚠ 未设置）/);

    const j = JSON.parse(s.run([PROJ, '--json']).out);
    assert.equal(j.authToken.kind, 'env');
    assert.equal(j.authToken.envName, 'SOME_UNSET_KEY_XYZ', '脚本要能直接读出变量名');
    assert.equal(j.authToken.envSet, false);
  });

  test('★★ 引用**已设置**时也只标注，绝不打印变量的值', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: PROJ, token: 'relay-a' }] },
      tokens: {
        'relay-a': {
          name: 'relay-a', authToken: '${MY_SET_KEY}',
          baseUrl: 'https://a/', models: [{ id: 'm' }],
        },
      },
    });
    const env = { MY_SET_KEY: 'sk-the-real-value-xyz' };
    const r = s.run([PROJ], { env });

    assert.match(r.out, /\$\{MY_SET_KEY\}\s+（已设置）/);
    assert.equal(r.out.includes('sk-the-real-value-xyz'), false,
      '★ §2.4：展示时只标注已设置/未设置，不打印值');

    const jr = s.run([PROJ, '--json'], { env });
    assert.equal(jr.out.includes('sk-the-real-value-xyz'), false);
    assert.equal(JSON.parse(jr.out).authToken.envSet, true);
  });
});

// ═══════════════════ 受管区三态 ═══════════════════

describe('cxt resolve —— 受管区的三种状态', () => {
  test('★ 还没有 config.toml → "尚未创建"，不是"漂移"（首次写入别吓唬人）', () => {
    const s = complete();
    const r = s.run([PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /尚未创建/);
    assert.match(r.out, /首次运行时会写入以下内容/);
    assert.equal(/漂移/.test(r.out), false, '★ 首次写入被说成"漂移"，用户会以为配置坏了');
  });

  test('★ 尚未创建时把**将要写入的每一行**都列出来（这是它最有用的时刻）', () => {
    const s = complete();
    const r = s.run([PROJ]);

    for (const line of [
      "+ model = 'deepseek-chat'",
      "+ model_provider = 'cxt-relay-a'",
      '+ [model_providers.cxt-relay-a]',
      "+ base_url = 'https://api.deepseek.com/'",
      "+ env_key = 'CXT_TOKEN_RELAY_A'",
      "+ wire_api = 'responses'",
    ]) {
      assert.ok(r.out.includes(line), `该列出这一行：${line}\n实际输出：\n${r.out}`);
    }
    assert.equal(r.out.includes(SECRET), false, '预览里当然也不许出现明文凭证');
  });

  test('★ 文件与受管区**逐字节一致** → "幂等，无漂移"（用户自己的注释留着）', () => {
    const s = complete({ profile: { name: 'relay-a', toml: CONSISTENT_TOML } });
    const r = s.run([PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /与当前文件一致（幂等，无漂移）/);
    // ⚠️ 判据要用**漂移横幅**那句，不能用裸的 /漂移/——「无漂移」里也有"漂移"两个字
    assert.equal(/与当前文件不一致|尚未创建/.test(r.out), false);

    const j = JSON.parse(s.run([PROJ, '--json']).out);
    assert.equal(j.managedRegion.changed, false);
    assert.equal(j.managedRegion.report.created, false);
  });

  test('★ 受管区漂移 → 报"会就地修正"，并把要变的那几行列出来', () => {
    const s = complete({
      profile: { name: 'relay-a', toml: '# 用户自己的配置\nmodel = "OLD-STALE-MODEL"\n' },
    });
    const r = s.run([PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /漂移/);
    assert.match(r.out, /cxt run \/ cxt exec 会就地修正/);
    assert.match(r.out, /-\s+model = "OLD-STALE-MODEL"/, '要显示**删掉**哪一行');
    assert.match(r.out, /\+\s+model = 'deepseek-chat'/, '也要显示新增哪一行');
    assert.equal(s.readCfg('relay-a'), '# 用户自己的配置\nmodel = "OLD-STALE-MODEL"\n',
      '★ resolve 只预览，不修正——文件必须原样');
  });

  test('--json 的 managedRegion 形状', () => {
    const s = complete();
    const j = JSON.parse(s.run([PROJ, '--json']).out);
    assert.equal(j.managedRegion.changed, true);
    assert.equal(j.managedRegion.report.created, true);
    assert.deepEqual(j.managedRegion.report.insertedTopLevel, ['model', 'model_provider']);
    assert.equal(j.managedRegion.report.wroteProvider, 'cxt-relay-a');
    assert.equal(typeof j.profileDir, 'string');
    assert.match(j.profileDir, /relay-a$/);
  });
});

// ═══════════════════ 项目本地配置（§2.13）═══════════════════

/**
 * 造一个**真实**目录，可带一份 `.cxt.json`。
 *
 * ⚠️ 必须是真目录：发现走的是 `statSync().isFile()`（§2.13 一），
 * 而 `isFile` 是注入进来的——e2e 这一层要验的正是"注入的是不是对的"。
 * @param {Record<string, any>} [files]
 */
function makeProj(files = {}) {
  const dir = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-rproj-'));
  TEMP_HOMES.push(dir);
  for (const [name, body] of Object.entries(files)) {
    nodeFs.writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }
  return dir;
}

const readProjFile = (dir) => JSON.parse(nodeFs.readFileSync(join(dir, '.cxt.json'), 'utf8'));

describe('★★ cxt resolve 里的项目本地配置（§2.13）', () => {
  test('★★ 发现：`.cxt.json` 的 token 赢过绑定，且**印出是哪一份**', () => {
    const dir = makeProj({
      '.cxt.json': { version: 1, token: 'relay-a', models: [{ id: 'proj-model' }] },
    });
    // 绑定的 token 是 relay-a、项目本地的是 relay-a 的同名——换个 token 才能看出谁赢
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: PROJ, token: 'relay-b' }] },
      tokens: {
        'relay-a': { name: 'relay-a', authToken: 'sk-a-1111', baseUrl: 'https://a/' },
        'relay-b': { name: 'relay-b', authToken: 'sk-b-2222', baseUrl: 'https://b/' },
      },
    });

    const r = s.run([PROJ, '--cwd', dir, '--json']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    const j = JSON.parse(r.out);
    assert.equal(j.token.value, 'relay-a', '★ 项目本地赢过绑定');
    assert.equal(j.token.source, 'project');
    assert.equal(j.projectPath, join(dir, '.cxt.json'));
    assert.deepEqual(j.models.value, [{ id: 'proj-model' }]);
    assert.equal(j.models.source, 'project');

    // ★ 人读输出里也得看得见——"是哪一份赢了"是这一层存在的全部理由
    const h = s.run([PROJ, '--cwd', dir]);
    assert.match(h.out, /项目本地配置/);
    assert.match(h.out, /项目本地/, '来源列要显示中文标签，不是裸的 project');
  });

  test('★ 向上发现：子目录里跑，用的是**最近**的那一份', () => {
    const dir = makeProj({ '.cxt.json': { version: 1, token: 'relay-a' } });
    const sub = join(dir, 'sub');
    nodeFs.mkdirSync(sub, { recursive: true });
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a-1111', baseUrl: 'https://a/' } },
    });

    const j = JSON.parse(s.run(['--cwd', sub, '--json']).out);
    assert.equal(j.projectPath, join(dir, '.cxt.json'), '★ 在 sub 里跑，用的是 dir 的那份');
    assert.equal(j.token.value, 'relay-a');
  });

  test('★ 没有 `.cxt.json` 时 projectPath 是 null（字段恒在，脚本不用判 undefined）', () => {
    const dir = makeProj();
    const s = complete();

    const j = JSON.parse(s.run([PROJ, '--cwd', dir, '--json']).out);
    assert.ok('projectPath' in j, '★ 字段恒在——脚本不该靠 `undefined` 判断');
    assert.equal(j.projectPath, null);

    // ⚠️ 这一条顺带钉住"测试进程的目录树上没有 .cxt.json"——
    //    若哪天有人在仓库根放了一份，它会红，而那是**该**红的。
    const j2 = JSON.parse(s.run([PROJ, '--json']).out);
    assert.equal(j2.projectPath, null);
    assert.equal(j2.token.source, 'binding');
  });

  test('★★ 禁键：项目文件里写 baseUrl → 硬报错，绝不悄悄生效', () => {
    // 这是 §2.13 二那条攻击面的**端到端**版本：克隆来的仓库写 evil.com，
    // 用户 `cxt resolve` 一下就该被拦住。
    const dir = makeProj({ '.cxt.json': { version: 1, baseUrl: 'https://evil.example.com/v1' } });
    const r = complete().run([PROJ, '--cwd', dir]);

    assert.equal(r.code, 1);
    assert.match(r.err, /baseUrl/);
    assert.match(r.err, /外泄通道|攻击面/);
  });

  test('★ 坏文件不静默跳过（JSON 语法错也一样）', () => {
    const dir = makeProj();
    nodeFs.writeFileSync(join(dir, '.cxt.json'), '{ 这不是 json', 'utf8');
    const r = complete().run([PROJ, '--cwd', dir]);
    assert.equal(r.code, 1);
    assert.match(r.err, /JSON/);
  });

  test('★ 发现用的是「调用时的 cwd」（--cwd 优先），不是进程目录', () => {
    // 反证：不加 --cwd 时，进程目录（ROOT，测试里没有 .cxt.json）说了算
    const dir = makeProj({ '.cxt.json': { version: 1, token: 'relay-a' } });
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: PROJ, token: 'relay-b' }] },
      tokens: {
        'relay-a': { name: 'relay-a', authToken: 'sk-a-1111', baseUrl: 'https://a/' },
        'relay-b': { name: 'relay-b', authToken: 'sk-b-2222', baseUrl: 'https://b/' },
      },
    });
    const withCwd = JSON.parse(s.run([PROJ, '--cwd', dir, '--json']).out);
    const without = JSON.parse(s.run([PROJ, '--json']).out);
    assert.equal(withCwd.projectPath, join(dir, '.cxt.json'));
    assert.equal(without.projectPath, null, '不指 --cwd 就不该发现那个目录的配置');
    assert.equal(without.token.value, 'relay-b');
  });
});

describe('★ 全局 flag `--config`（§2.13 一）', () => {
  test('★ 显式指定 → 用它，**跳过发现**（哪怕 cwd 那儿有一份）', () => {
    const near = makeProj({ '.cxt.json': { version: 1, token: 'relay-b' } });
    const other = makeProj({ 'my-cfg.json': { version: 1, token: 'relay-a' } });
    const explicit = join(other, 'my-cfg.json');

    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {
        'relay-a': { name: 'relay-a', authToken: 'sk-a-1111', baseUrl: 'https://a/' },
        'relay-b': { name: 'relay-b', authToken: 'sk-b-2222', baseUrl: 'https://b/' },
      },
    });

    const j = JSON.parse(s.run(['--cwd', near, '--config', explicit, '--json']).out);
    assert.equal(j.projectPath, explicit);
    assert.equal(j.token.value, 'relay-a', '★ 显式给的赢过发现到的那份');
  });

  test('★ `--config=` 等号写法同样认', () => {
    const other = makeProj({ 'my-cfg.json': { version: 1, token: 'relay-a' } });
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a-1111', baseUrl: 'https://a/' } },
    });
    const j = JSON.parse(s.run([`--config=${join(other, 'my-cfg.json')}`, '--json']).out);
    assert.equal(j.token.value, 'relay-a');
  });

  test('★★ 文件不存在 → 退出 1，**绝不回退到发现**', () => {
    // 显式给了路径却悄悄用别的文件，是最难排查的一类静默失效（§2.13 一）。
    const near = makeProj({ '.cxt.json': { version: 1, token: 'relay-a' } });
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a-1111', baseUrl: 'https://a/' } },
    });

    const r = s.run(['--cwd', near, '--config', join(near, 'nope.json')]);
    assert.equal(r.code, 1);
    assert.match(r.err, /找不到项目本地配置/);
    assert.match(r.err, /nope\.json/);
  });

  test('★ `--config` 后面没值 / 给了两次 → 都是退出 1', () => {
    const s = complete();
    const a = s.run(['--config']);
    assert.equal(a.code, 1);
    assert.match(a.err, /要跟一个路径/);

    const b = s.run(['--config', 'x.json', '--config', 'y.json']);
    assert.equal(b.code, 1);
    assert.match(b.err, /不止一次/);
  });

  test('★★ `--` 之后的 `--config` 是**给 codex 的**，cxt 不许吃它', () => {
    // `cxt run relay-a -- --config foo` 里的 --config 是 codex 自己的参数。
    // 少了这条，用户想给 codex 传 --config 就会把 cxt 的解析指向乱七八糟的文件。
    const dir = makeProj({ '.cxt.json': { version: 1, token: 'relay-a' } });
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a-1111', baseUrl: 'https://a/' } },
    });

    const j = JSON.parse(s.run(['--cwd', dir, '--json', '--', '--config', 'codex-side.toml']).out);
    assert.equal(j.projectPath, join(dir, '.cxt.json'), '★ 发现照常走（没被那个 --config 顶掉）');
    assert.deepEqual(j.codexArgs.value, ['--config', 'codex-side.toml'], '★ 它原样透传给 codex');
  });

  test('`--config` 对所有命令都生效（不只是 resolve）', () => {
    const other = makeProj({ 'my-cfg.json': { version: 1, token: 'relay-a' } });
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a-1111', baseUrl: 'https://a/' } },
    });
    const r = spawnSync(process.execPath,
      [CXT, 'model', 'ls', '--path', PROJ, '--config', join(other, 'my-cfg.json')],
      { encoding: 'utf8', env: { ...process.env, USERPROFILE: s.home, NO_COLOR: '1' }, cwd: ROOT });
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
  });
});

// ═══════════════════ 派生量 ═══════════════════

describe('cxt resolve —— 派生量', () => {
  test('★ 凭证环境变量名与 profile 都算出来', () => {
    const s = complete();
    const j = JSON.parse(s.run([PROJ, '--json']).out);

    assert.equal(j.envKeyName, 'CXT_TOKEN_RELAY_A', '名字里的 `-` 要变成 `_`（环境变量名不允许连字符）');
    assert.equal(j.profile, 'relay-a');
    assert.equal(typeof j.profileDir, 'string');
  });

  test('★ 没有 token 时也有一套兜底（`_default` 不是"报错"）', () => {
    const s = setup();
    const j = JSON.parse(s.run([PROJ, '--json']).out);

    assert.equal(j.profile, '_default');
    assert.equal(j.envKeyName, 'CXT_TOKEN_DEFAULT');
    assert.equal(j.providerId.value, 'cxt-default');
    assert.equal(j.providerId.source, 'derived');
  });

  test('--help → 退出 0，并说清楚与 exec 的差别', () => {
    const s = complete();
    const r = s.run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /想看 exec 入口的解析结果，用 `cxt exec --print`/);
  });
});
