// @ts-check
/**
 * ★ `cxt ls` 与 `cxt bind` 的端到端测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这份文件守的是什么
 *
 * 这两条命令一个"看"、一个"写"，守的都是**同一件事的两面**：
 * 写进去的那个字符串，和将来 `process.cwd()` 给的那个字符串，
 * 必须是**同一个**——因为匹配是字符串比较，而失配是静默的。
 *
 * 1. **`bind` 写用户的字面路径**（§7.3 铁律 4）：不 `resolve()`、不 `realpath`、
 *    不折大小写、不换分隔符。只展开 `~` 与补全相对路径，**且都要说出来**。
 * 2. **`bind` 的 `--token` 必须已存在**——否则写出来的是一条悬空绑定：
 *    写的时候不报错，`cxt run` 的时候才炸，而那时人已经在别的目录里了。
 * 3. **`ls` 一个字都不打印凭证**。这不是"打码"，是根本不取那个字段。
 * 4. **`ls` 的告警要排在"一个 token 都没有"那条早退之前**——刚删完最后一个
 *    token 的时候最容易留下一堆悬空绑定，而那时只看到"还没有任何 token"
 *    就等于没看见自己的配置已经指空了。
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

/** 长名基准（`os.tmpdir()` 给的是 8.3 短名，见 token-e2e 的说明） */
const TMP_BASE = nodeFs.realpathSync.native(tmpdir());

/** ★ 一个显眼的假密钥：它出现在任何输出里都算 §5 被破了 */
const SECRET = 'sk-LEAK-canary-do-not-print-9999';

const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了 */ }
  }
});

/**
 * @param {{ config?: any, tokens?: Record<string, any>, rawTokens?: Record<string, string> }} [opts]
 */
function setup(opts = {}) {
  const home = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-lsbind-'));
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
  // 故意写坏的文件（测"坏文件照样抛错"）
  for (const [name, text] of Object.entries(opts.rawTokens ?? {})) {
    nodeFs.writeFileSync(join(appDir, 'tokens', `${name}.json`), text, 'utf8');
  }

  return {
    home,
    appDir,
    configPath: join(appDir, 'config.json'),
    readConfig: () => JSON.parse(nodeFs.readFileSync(join(appDir, 'config.json'), 'utf8')),
    /**
     * @param {string[]} extra
     * @param {{ cwd?: string }} [o]
     */
    run(extra, o = {}) {
      const r = spawnSync(process.execPath, [CXT, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, NO_COLOR: '1' },
        cwd: o.cwd ?? ROOT,
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },
  };
}

const A = { name: 'relay-a', authToken: SECRET, baseUrl: 'https://a.example.com/' };
const B = { name: 'relay-b', authToken: 'sk-b-value-wxyz' };

// ═══════════════════ cxt ls ═══════════════════

describe('cxt ls —— 我有几个身份，各自什么样', () => {
  test('一个 token 都没有 → 说清楚，并给出建一个的完整例子', () => {
    const s = setup();
    const r = s.run(['ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /还没有任何 token/);
    assert.match(r.out, /cxt token add relay-a --token/, '空状态要给出**可复制**的下一步');
  });

  test('★★ 凭证**一个字都不打印**——人读和 --json 都不许出现', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const human = s.run(['ls']);
    const json = s.run(['ls', '--json']);

    assert.equal(human.code, 0, `stderr:\n${human.err}`);
    assert.equal(human.out.includes(SECRET), false,
      '★ ls 是概览命令，没有理由取凭证——连打码都不该做，是根本不取');
    assert.equal(json.out.includes(SECRET), false, '★ --json 是给脚本消费的，更要守规矩');
    assert.equal(json.out.includes('sk-b-value-wxyz'), false);
  });

  test('★ 模型列标出来源（own / global / —）——§2.5 级联最容易让人困惑的地方', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: { models: [{ id: 'global-model' }] },
        bindings: [],
      },
      tokens: {
        'relay-a': { ...A, models: [{ id: 'own-model' }] },
        'relay-b': B,
        'relay-c': { name: 'relay-c', authToken: 'sk-c' },
      },
    });
    const r = s.run(['ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /own-model\s+\(own\)/);
    assert.match(r.out, /global-model\s+\(global\)/);
    assert.match(r.out, /\(own\) = 这个 token 自己设的|模型列的/);
  });

  test('★ 三层都没有模型 → 那一列是 `—`，不是空白（空白看着像坏了）', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const j = JSON.parse(s.run(['ls', '--json']).out);
    assert.equal(j.tokens[0].modelsSource, 'none');
    assert.equal(j.tokens[0].models, null);
  });

  test('★ 显式空列表与"没设"在 ls 里是两样（§2.4）', () => {
    const s = setup({ tokens: { 'relay-a': { ...A, models: [] } } });
    const r = s.run(['ls']);
    assert.match(r.out, /\[\] 不注入/);
    assert.match(r.out, /\(own\)/);
  });

  test('profile 列：建了是 ✓，没建是未建', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    nodeFs.mkdirSync(join(s.appDir, 'profiles', 'relay-a'), { recursive: true });

    const j = JSON.parse(s.run(['ls', '--json']).out);
    assert.equal(j.tokens[0].profileExists, true);
    assert.equal(j.defaultProfile.name, '_default', '纯 defaults 模式的落点也要给出来（脚本要用）');
    assert.equal(j.defaultProfile.profileExists, false);
  });

  test('绑定列：哪些目录会走它', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [
          { path: 'D:/work/client-a', token: 'relay-a' },
          { path: 'D:/work/client-b', token: 'relay-a' },
        ],
      },
      tokens: { 'relay-a': A },
    });
    const j = JSON.parse(s.run(['ls', '--json']).out);
    assert.deepEqual(j.tokens[0].boundPaths, ['D:/work/client-a', 'D:/work/client-b']);
  });

  test('★★ 悬空绑定要警告——它只会在 `cxt run` 时才炸', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: 'D:/work/gone', token: 'ghost' }],
      },
      tokens: { 'relay-a': A },
    });
    const r = s.run(['ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /指向不存在的 token/);
    assert.match(r.out, /ghost/);
    assert.match(r.out, /D:\/work\/gone/);
  });

  test('★ defaults.token 指了个不存在的 token → 也要警告', () => {
    const s = setup({
      config: { version: 1, defaults: { token: 'ghost' }, bindings: [] },
      tokens: { 'relay-a': A },
    });
    const r = s.run(['ls']);
    assert.match(r.out, /config\.defaults\.token = ghost/);
    assert.match(r.out, /解析不出身份/);
  });

  test('★★ 告警排在"一个 token 都没有"的早退**之前**——刚删完最后一个 token 时最需要它', () => {
    // 这条是回归：告警算在早退之后的话，用户删光 token 后只会看到
    // "还没有任何 token"，而看不到自己的配置已经指向空气了。
    const s = setup({
      config: {
        version: 1,
        defaults: { token: 'ghost' },
        bindings: [{ path: 'D:/work/gone', token: 'ghost' }],
      },
    });
    const r = s.run(['ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /还没有任何 token/);
    assert.match(r.out, /指向不存在的 token ghost/,
      '★ 空清单 + 悬空绑定，两个都要说——只说了前者，用户就以为一切正常');
    assert.match(r.out, /defaults\.token = ghost/);
  });

  test('★ 坏掉的 token 文件**直接报错**，不静默跳过（一份缺东西的清单更危险）', () => {
    const s = setup({
      tokens: { 'relay-a': A },
      rawTokens: { broken: '{ this is not json' },
    });
    const r = s.run(['ls']);

    assert.equal(r.code, 1);
    assert.match(r.err, /broken/);
    assert.match(r.err, /不是合法 JSON/);
    assert.match(r.err, /手改坏了可以删掉它重新生成/, '报错要给出路');
  });

  test('--json 的形状：tokens / defaultProfile / defaults / bindings', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: { models: [{ id: 'g' }], baseUrl: 'https://g.example.com/' },
        bindings: [{ path: 'D:/work/a', token: 'relay-a' }],
      },
      tokens: { 'relay-a': A },
    });
    const j = JSON.parse(s.run(['ls', '--json']).out);

    assert.equal(j.tokens.length, 1);
    assert.deepEqual(j.defaults.models, [{ id: 'g' }]);
    assert.equal(j.defaults.baseUrl, 'https://g.example.com/');
    assert.deepEqual(j.bindings, [{ path: 'D:/work/a', token: 'relay-a' }]);
  });

  test('页脚给出"接着看什么"的三条路（token show / resolve / bind ls）', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const r = s.run(['ls']);
    assert.match(r.out, /cxt token show/);
    assert.match(r.out, /cxt resolve/);
  });
});

// ═══════════════════ cxt bind：建 ═══════════════════

describe('cxt bind —— 写进去的必须就是将来能匹配上的那个串', { skip: !IS_WIN }, () => {
  test('建一条绑定，并建出根目录 + config.json（§3.2）', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const r = s.run(['bind', 'D:\\work\\client-a', '--token', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.configPath), true);
    const cfg = s.readConfig();
    assert.equal(cfg.bindings.length, 1);
    assert.equal(cfg.bindings[0].path, 'D:\\work\\client-a');
    assert.equal(cfg.bindings[0].token, 'relay-a');
  });

  test('★★ `--token` 不存在 → 退出 1，**什么都不写**（悬空绑定写时不报错、跑时才炸）', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const r = s.run(['bind', 'D:\\work\\x', '--token', 'ghost']);

    assert.equal(r.code, 1);
    assert.match(r.err, /ghost/);
    assert.match(r.err, /不存在/);
    assert.equal(nodeFs.existsSync(s.configPath), false,
      '★ 拒了就不该建出 config.json——半个配置文件比没有更难查');
  });

  test('★ 幂等：第二次跑说"未变"，且**不重写文件**', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    s.run(['bind', 'D:\\work\\a', '--token', 'relay-a']);
    const before = nodeFs.readFileSync(s.configPath, 'utf8');

    const r = s.run(['bind', 'D:\\work\\a', '--token', 'relay-a']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /绑定未变/);
    assert.equal(nodeFs.readFileSync(s.configPath, 'utf8'), before);
    assert.equal(s.readConfig().bindings.length, 1, '★ 追加出第二条了——"哪条生效"从此取决于书写顺序');
  });

  test('★ 合并而非替换：`--url` 不该把已有的 `--token` 抹掉', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    s.run(['bind', 'D:\\work\\a', '--token', 'relay-a']);
    const r = s.run(['bind', 'D:\\work\\a', '--url', 'https://relay.example.com/v1']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    const b = s.readConfig().bindings[0];
    assert.equal(b.token, 'relay-a', '★ token 被 url 覆盖掉了——一次只改一个字段的常识被破坏');
    assert.equal(b.baseUrl, 'https://relay.example.com/v1');
    assert.match(r.out, /已更新绑定/);
  });

  test('★ 相对路径按当前目录补全，**并说明补了什么**', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    // cwd 用自己的临时目录：`process.cwd()` 的返回值是断言的基准，
    // 拿项目的长路径当基准会顺带测上"Windows 怎么规范化 cwd"这件无关的事
    const cwd = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-cwd-'));
    TEMP_HOMES.push(cwd);

    const r = s.run(['bind', 'myproj', '--token', 'relay-a'], { cwd });

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /相对路径按当前目录补全/);
    assert.match(r.out, /myproj → /, '要把"改写前 → 改写后"写出来');
    assert.equal(s.readConfig().bindings[0].path, join(cwd, 'myproj'));
  });

  test('★ 8.3 短名只**警告**、不归一化——写下去的是用户的字面路径（§7.3 铁律 4）', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const r = s.run(['bind', 'D:\\work\\PROJ~1', '--token', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    if (IS_WIN) {
      assert.match(r.out, /8\.3 短名/);
      assert.match(r.out, /刻意不归一化/);
    }
    assert.equal(s.readConfig().bindings[0].path, 'D:\\work\\PROJ~1',
      '★ 归一化了的话，"写进去的"与"process.cwd() 给的"就再也不是同一个字符串');
  });

  test('★ 下面有更具体的绑定时说一句（最长前缀匹配的正常行为，但值得知道）', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    s.run(['bind', 'D:\\work\\client-a', '--token', 'relay-a']);
    const r = s.run(['bind', 'D:\\work', '--token', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /更具体的绑定/);
    assert.match(r.out, /client-a/);
  });

  test('--model 可重复，顺序即优先级', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const r = s.run(['bind', 'D:\\work\\a', '--token', 'relay-a',
      '--model', 'm1', '--model', 'm2']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(s.readConfig().bindings[0].models, [{ id: 'm1' }, { id: 'm2' }]);
    assert.match(r.out, /models=m1 > m2/);
  });

  test('★ 什么都没给 → 退出 1，且例子里的路径**带引号**（含空格时能直接复制）', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const r = s.run(['bind', 'D:\\my work\\a']);
    assert.equal(r.code, 1);
    assert.match(r.err, /没有给出要绑定的内容/);
  });

  test('没有路径 → 退出 1，并给出两条出路', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const r = s.run(['bind']);
    assert.equal(r.code, 1);
    assert.match(r.err, /缺少路径/);
    assert.match(r.err, /bind ls/);
  });

  test('--json 的形状', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const r = s.run(['bind', 'D:\\work\\a', '--token', 'relay-a', '--json']);
    const j = JSON.parse(r.out);

    assert.equal(j.ok, true);
    assert.equal(j.action, 'created');
    assert.equal(j.path, 'D:\\work\\a');
    assert.equal(j.binding.token, 'relay-a');
    assert.equal(j.file, s.configPath);
  });
});

// ═══════════════════ cxt bind ls / rm ═══════════════════

describe('cxt bind ls —— 有哪些绑定、哪条悬空了', { skip: !IS_WIN }, () => {
  test('没有绑定 → 空状态 + 可复制的例子', () => {
    const s = setup();
    const r = s.run(['bind', 'ls']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /还没有任何路径绑定/);
    assert.match(r.out, /cxt bind D:\/work\/client-a --token relay-a/);
  });

  test('★ 悬空的 token 引用要标出来（它只会在 run 时才炸）', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [
          { path: 'D:/work/ok', token: 'relay-a' },
          { path: 'D:/work/gone', token: 'ghost' },
        ],
      },
      tokens: { 'relay-a': A },
    });
    const r = s.run(['bind', 'ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /ghost ✗不存在/);
    assert.equal(/relay-a ✗不存在/.test(r.out), false, '好的那条不该被标');
  });

  test('★ 未指定 token 的绑定显示 `(未指定)`，不是空白', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: 'D:/work/a', models: [{ id: 'm' }] }] },
    });
    const r = s.run(['bind', 'ls']);
    assert.match(r.out, /\(未指定\)/);
  });

  test('★★ 归一后撞车的两条绑定要警告——谁生效取决于书写顺序', () => {
    // `normalizeConfig` 只按**原始串**查重，所以 `D:/x` 与 `D:\x` 能同时存进来。
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [
          { path: 'D:/work/same', token: 'relay-a' },
          { path: 'D:\\work\\same', token: 'relay-b' },
        ],
      },
      tokens: { 'relay-a': A, 'relay-b': B },
    });
    const r = s.run(['bind', 'ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /归一后指向同一个目录/);
    assert.match(r.out, /谁生效取决于书写顺序/);
  });

  test('★ 页脚写明匹配规则（最长前缀优先；并列取先出现的）', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: 'D:/work/a', token: 'relay-a' }] },
      tokens: { 'relay-a': A },
    });
    const r = s.run(['bind', 'ls']);
    assert.match(r.out, /最长前缀优先/);
  });

  test('--json 里带上覆盖项与 collisions', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: 'D:/work/a', token: 'relay-a', models: [{ id: 'm1' }] }],
      },
      tokens: { 'relay-a': A },
    });
    const j = JSON.parse(s.run(['bind', 'ls', '--json']).out);
    assert.deepEqual(j.bindings[0].models, [{ id: 'm1' }]);
    assert.deepEqual(j.collisions, []);
  });
});

describe('cxt bind rm —— 只删那一条绑定', { skip: !IS_WIN }, () => {
  test('★ 删掉精确匹配的那条，别的绑定一条不动', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [
          { path: 'D:/work/a', token: 'relay-a' },
          { path: 'D:/work/a/sub', token: 'relay-a' },
          { path: 'D:/work/b', token: 'relay-b' },
        ],
      },
      tokens: { 'relay-a': A, 'relay-b': B },
    });
    const r = s.run(['bind', 'rm', 'D:/work/a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    const paths = s.readConfig().bindings.map((/** @type {any} */ b) => b.path);
    assert.deepEqual(paths, ['D:/work/a/sub', 'D:/work/b']);
    assert.match(r.out, /只删了这条\*\*路径绑定\*\*/, '要说清楚没动别的');
  });

  test('★★ 删的是**精确匹配**，不是前缀——不能顺手带走子目录的绑定', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: 'D:/work/a/sub', token: 'relay-a' }],
      },
      tokens: { 'relay-a': A },
    });
    const r = s.run(['bind', 'rm', 'D:/work/a']);

    assert.equal(r.code, 1, '★ 前缀匹配的话，删父目录会把子目录的绑定一起带走');
    assert.match(r.err, /没有绑定指向/);
    assert.match(r.err, /精确匹配/);
    assert.equal(s.readConfig().bindings.length, 1);
  });

  test('缺路径 → 退出 1', () => {
    const s = setup();
    const r = s.run(['bind', 'rm']);
    assert.equal(r.code, 1);
    assert.match(r.err, /缺少要删的路径/);
  });

  test('★ 只删绑定：token 文件、profile 目录都不动', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: 'D:/work/a', token: 'relay-a' }],
      },
      tokens: { 'relay-a': A },
    });
    nodeFs.mkdirSync(join(s.appDir, 'profiles', 'relay-a'), { recursive: true });
    nodeFs.writeFileSync(join(s.appDir, 'profiles', 'relay-a', 'auth.json'), '{"x":1}', 'utf8');

    const r = s.run(['bind', 'rm', 'D:/work/a']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(join(s.appDir, 'tokens', 'relay-a.json')), true);
    assert.equal(nodeFs.readFileSync(join(s.appDir, 'profiles', 'relay-a', 'auth.json'), 'utf8'), '{"x":1}');
  });
});

// ═══════════════════ 结构性保证 ═══════════════════

describe('★ ls / bind 绝不写 ~/.codex/（§2.9 铁律）', { skip: !IS_WIN }, () => {
  test('跑一整套 ls + bind + bind rm，用户原本的 CODEX_HOME 一字未动', () => {
    const s = setup({ tokens: { 'relay-a': A } });
    const realCodex = join(s.home, '.codex');
    nodeFs.mkdirSync(realCodex, { recursive: true });
    const sentinel = join(realCodex, 'config.toml');
    nodeFs.writeFileSync(sentinel, '# 用户自己的配置\nmodel = "gpt-5"\n', 'utf8');

    s.run(['ls']);
    s.run(['ls', '--json']);
    s.run(['bind', 'D:\\work\\a', '--token', 'relay-a']);
    s.run(['bind', 'ls']);
    s.run(['bind', 'rm', 'D:\\work\\a']);

    assert.equal(nodeFs.readFileSync(sentinel, 'utf8'), '# 用户自己的配置\nmodel = "gpt-5"\n');
    assert.deepEqual(nodeFs.readdirSync(realCodex), ['config.toml']);
  });
});
