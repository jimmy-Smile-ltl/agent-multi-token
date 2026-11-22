// @ts-check
/**
 * ★ `cxt trust` 的端到端测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 与 `trust.test.js` 的分工（别重复测）
 *
 * `tests/trust.test.js` 测的是 `core/trust.js` 这个**纯函数**：路径规整的每一条规则、
 * 三态、就地修复、完整性错误、BOM/CRLF。那些都拿字符串字面量穷举过了。
 *
 * 这份文件管的是**它接上命令行之后**才存在的那一半：
 *
 * 1. **记录落在哪个 profile 上**——必须与 `cxt run` 走同一条级联（绑定 → defaults），
 *    否则写完了 run 起来照样问一遍，而用户以为已经信任过了。
 * 2. **输出说了什么**。`--untrust` 曾打印"已标记为**可信**"——一条说反了的确认，
 *    比没有还糟。这类 bug 只在输出层，core 的测试永远看不见。
 * 3. `trust rm` 的**拒绝**（cxt 只增不减）、`--all` 的批量语义、
 *    `trust ls` 的三态渲染。
 * 4. **`[projects.*]` 只增不减**这条不变量，在**整条 CLI 链路**上仍然成立
 *    （`writeProfileConfig` 的守门只有在拿到原文时才生效——忘了传就是一个静默失效）。
 *
 * ## ⚠️ 整份文件 skip 非 win32
 *
 * §7.3 那张规则表**只在 Windows 上实测过**，POSIX 的行是推断。
 * 拿推断当断言，测的是我的猜测而不是产品。Windows 是本项目的主场，
 * 这里就按主场写。
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

/** 长名基准（`os.tmpdir()` 给的是 `C:\Users\ALICE~1\...`，见 token-e2e 的说明） */
const TMP_BASE = nodeFs.realpathSync.native(tmpdir());

const PROJ_A = 'D:\\work\\client-a';
const PROJ_A_SUB = 'D:\\work\\client-a\\sub';
const PROJ_B = 'D:\\work\\client-b';

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
 *           toml?: string, profileName?: string }} [opts]
 */
function setup(opts = {}) {
  const home = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-trust-'));
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
  if (opts.toml !== undefined) {
    const name = opts.profileName ?? '_default';
    nodeFs.mkdirSync(join(appDir, 'profiles', name), { recursive: true });
    nodeFs.writeFileSync(cfgPath(name), opts.toml, 'utf8');
  }

  return {
    home,
    appDir,
    cfgPath,
    readCfg: (n) => nodeFs.readFileSync(cfgPath(n), 'utf8'),
    /**
     * @param {string[]} extra
     */
    run(extra) {
      const r = spawnSync(process.execPath, [CXT, 'trust', ...extra], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, NO_COLOR: '1' },
        cwd: ROOT,
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },
  };
}

/** 一个绑定了 relay-a 的 home */
function bound(opts = {}) {
  return setup({
    config: {
      version: 1,
      defaults: {},
      bindings: [
        { path: PROJ_A, token: 'relay-a' },
        { path: PROJ_A_SUB, token: 'relay-a' },
        { path: PROJ_B, token: 'relay-b' },
      ],
    },
    tokens: {
      'relay-a': { name: 'relay-a', authToken: 'sk-a' },
      'relay-b': { name: 'relay-b', authToken: 'sk-b' },
    },
    ...opts,
  });
}

// ═══════════════════ 写单条 ═══════════════════

describe('cxt trust <路径> —— 写哪、写成什么样', { skip: !IS_WIN }, () => {
  test('★ 记录落在**绑定命中的那个** token 的 profile 里（与 cxt run 同一条级联）', () => {
    const s = bound();
    const r = s.run([PROJ_A]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.cfgPath('relay-a')), true,
      '★ 写到了别的 profile：run 起来照样问一遍，而用户以为已经信任过了');
    assert.equal(nodeFs.existsSync(s.cfgPath('relay-b')), false);

    const text = s.readCfg('relay-a');
    assert.match(text, /\[projects\.'D:\\work\\client-a'\]/);
    assert.match(text, /trust_level = 'trusted'/);
  });

  test('★ 正斜杠输入 → 落盘是反斜杠，**而且要在输出里说出来**（§7.3 铁律 1）', () => {
    // 不说的话，用户下次手工改这个文件时会照自己的习惯写回正斜杠——
    // 而那正是"不报错但静默不匹配"的那一种。
    const s = bound();
    const r = s.run(['D:/work/client-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(s.readCfg('relay-a'), /\[projects\.'D:\\work\\client-a'\]/);
    assert.match(r.out, /规范化/, '★ 改写了用户的输入就必须解释');
    assert.match(r.out, /静默不匹配/);
  });

  test('★ 相对路径按当前目录补全，并说明补了什么', () => {
    const s = bound();
    const r = s.run(['relay-proj']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /相对路径按当前目录补全/);
    assert.match(s.readCfg('_default'), /relay-proj/);
  });

  test('★ 幂等：第二次跑说"未变"，而不是再写一遍', () => {
    const s = bound();
    s.run([PROJ_A]);
    const first = s.readCfg('relay-a');

    const r = s.run([PROJ_A]);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /信任状态未变/);
    assert.equal(s.readCfg('relay-a'), first, '第二次不该动文件');
  });

  test('★★ `--untrust` 的确认文案必须说**不可信**，不能说反', () => {
    // 这条是回归：`ACTION_TEXT` 只按 action 出文案时，`--untrust` 会打印
    // "已标记为**可信**"——一条说反了的确认，比没有确认还糟。
    const s = bound();
    s.run([PROJ_A]);
    const r = s.run([PROJ_A, '--untrust']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /不可信/);
    assert.equal(/已把信任状态改成\s*可信/.test(r.out), false, '★ 说反了');
    assert.match(s.readCfg('relay-a'), /trust_level = 'untrusted'/);
  });

  test('★ `--untrust` **不删条目**，只改值——并解释为什么（§7.3 铁律 1）', () => {
    const s = bound();
    s.run([PROJ_A]);
    const r = s.run([PROJ_A, '--untrust']);

    const text = s.readCfg('relay-a');
    assert.equal((text.match(/\[projects\./g) ?? []).length, 1, '★ 条目被删了');
    assert.match(r.out, /UnlessTrusted|三态/,
      '要解释"显式 untrusted ≠ 从未标记"，否则用户下次会自己去删条目——那会降级语义');
  });

  test('★ 就地修好写法认不出的既有条目，并说清楚"你原来那条 Codex 认不出"', () => {
    const s = bound({
      profileName: 'relay-a',
      toml: String.raw`[projects."D:/work/client-a"]
trust_level = "trusted"
`,
    });
    const r = s.run([PROJ_A]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /认不出/);
    assert.match(r.out, /D:\/work\/client-a/, '要点名原来那条写法');
    assert.equal(s.readCfg('relay-a'), String.raw`[projects.'D:\work\client-a']
trust_level = 'trusted'
`, '★ 只该动表头那一行，表体一字不动');
  });

  test('★ 有多条写坏的条目时，只修一条、其余点名上报（修两条会变重复表）', () => {
    const s = bound({
      profileName: 'relay-a',
      toml: String.raw`[projects."D:/work/client-a"]
trust_level = "trusted"

[projects."D:\\work\\client-a\\"]
trust_level = "untrusted"
`,
    });
    const r = s.run([PROJ_A]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /还有 1 条/);
    assert.match(r.out, /尾部多了分隔符/);
    assert.match(r.out, /一次只修一条|重复表/);

    // 两条都还在（我们从不删条目），但只有第一条被改成规范写形
    const text = s.readCfg('relay-a');
    assert.equal((text.match(/\[projects\./g) ?? []).length, 2, '★ 条目数变了');
    assert.equal((text.match(/\[projects\.'D:\\work\\client-a'\]/g) ?? []).length, 1);
  });

  test('★ 8.3 短名只**警告**、不归一化（§7.3 铁律 4）', () => {
    const s = bound();
    const r = s.run(['D:\\work\\PROJ~1']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /8\.3 短名/);
    assert.match(s.readCfg('_default'), /PROJ~1/, '写下去的必须是用户的**字面**路径');
  });

  test('★ 给父目录写信任时警告"子目录不继承"（§7.3）——最常见的误解', () => {
    const s = bound();
    const r = s.run([PROJ_A]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /信任\*\*不继承\*\*|不继承/);
    assert.match(r.out, /client-a\\sub/, '要点名是哪个子目录');
  });

  test('★ 全新文件要说明"受管区还没写，首次 run 才写"（§3.2 惰性）', () => {
    const s = bound();
    const r = s.run([PROJ_A]);
    assert.match(r.out, /新建的 config\.toml/);
    assert.match(r.out, /首次 `cxt run` 时才写|惰性/);
    // ★ 只写信任记录，不预写受管区
    assert.equal(/model_provider/.test(s.readCfg('relay-a')), false);
  });

  test('--token 显式指定时落在那个 token 的 profile 里（不跟绑定走）', () => {
    const s = bound();
    const r = s.run([PROJ_A, '--token', 'relay-b']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.cfgPath('relay-b')), true);
    assert.equal(nodeFs.existsSync(s.cfgPath('relay-a')), false);
  });

  test('--token 指定的 token 不存在 → 退出 1（写错名字是用户的错，要说出来）', () => {
    const s = bound();
    const r = s.run([PROJ_A, '--token', 'nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /不存在/);
  });

  test('★ 级联给出的 token 已被删 → **不报错**，但要警告记录写在了哪', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: PROJ_A, token: 'ghost' }] },
      tokens: {},
    });
    const r = s.run([PROJ_A]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`, '写这个文件是安全且幂等的，不该拦');
    assert.match(r.out, /ghost/);
    assert.match(r.out, /不存在/);
    assert.equal(nodeFs.existsSync(s.cfgPath('ghost')), true);
  });

  test('没有路径、也没有 --all → 退出 1，并给出三种用法', () => {
    const s = bound();
    const r = s.run([]);
    assert.equal(r.code, 1);
    assert.match(r.err, /缺少路径/);
    assert.match(r.err, /--all/);
    assert.match(r.err, /trust ls/);
  });

  test('--json 的形状', () => {
    const s = bound();
    const r = s.run([PROJ_A, '--json']);
    const j = JSON.parse(r.out);

    assert.equal(j.ok, true);
    assert.equal(j.action, 'added');
    assert.equal(j.level, 'trusted');
    assert.equal(j.token, 'relay-a');
    assert.equal(j.profile, 'relay-a');
    assert.equal(j.path, PROJ_A);
    assert.equal(j.file, s.cfgPath('relay-a'));
  });
});

// ═══════════════════ --all ═══════════════════

describe('cxt trust --all —— 批量标记该 token 的绑定路径', { skip: !IS_WIN }, () => {
  test('★ 一次把该 token 的全部绑定路径都标上，且是**一次原子写**', () => {
    const s = bound();
    const r = s.run(['--all', '--token', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    const text = s.readCfg('relay-a');
    assert.match(text, /\[projects\.'D:\\work\\client-a'\]/);
    assert.match(text, /\[projects\.'D:\\work\\client-a\\sub'\]/);
    assert.equal(/client-b/.test(text), false, 'relay-b 的绑定不该被标');
    assert.match(r.out, /2 条/);
  });

  test('★ 路径写的是正斜杠（config.json 里常见）→ 落盘仍是反斜杠', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: 'D:/work/slash', token: 'relay-a' }] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } },
    });
    const r = s.run(['--all', '--token', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(s.readCfg('relay-a'), /\[projects\.'D:\\work\\slash'\]/);
  });

  test('★ 一条坏的（相对路径）不该让整批停下——其余照标', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [
          { path: 'relative/one', token: 'relay-a' },
          { path: PROJ_B, token: 'relay-a' },
        ],
      },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } },
    });
    const r = s.run(['--all', '--token', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(s.readCfg('relay-a'), /\[projects\.'D:\\work\\client-b'\]/, '好的那条该标上');
    assert.match(r.out, /跳过了/);
    assert.match(r.out, /relative\/one/);
  });

  test('--all 与路径同时给 → 退出 1', () => {
    const s = bound();
    const r = s.run(['--all', PROJ_A, '--token', 'relay-a']);
    assert.equal(r.code, 1);
    assert.match(r.err, /--all 与路径不能同时给/);
  });

  test('该 token 没有任何绑定 → 退出 1，并指路 bind', () => {
    const s = bound();
    const r = s.run(['--all', '--token', 'relay-a', '--untrust']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);

    // relay-b 的绑定存在，但换一个没有任何绑定的 token
    const s2 = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { 'lonely': { name: 'lonely', authToken: 'sk-l' } },
    });
    const r2 = s2.run(['--all', '--token', 'lonely']);
    assert.equal(r2.code, 1);
    assert.match(r2.err, /没有任何绑定路径/);
    assert.match(r2.err, /cxt bind/);
  });

  test('--all 不给 --token、defaults 里也没有 → 退出 1，并说明两种出路', () => {
    const s = bound();
    const r = s.run(['--all']);
    assert.equal(r.code, 1);
    assert.match(r.err, /不知道该给哪个 token/);
    assert.match(r.err, /--token/);
    assert.match(r.err, /defaults\.token/);
  });

  test('★ --all 也走 defaults.token 的缺省', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: { token: 'relay-a' },
        bindings: [{ path: PROJ_A, token: 'relay-a' }],
      },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } },
    });
    const r = s.run(['--all']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(s.readCfg('relay-a'), /trust_level = 'trusted'/);
  });
});

// ═══════════════════ rm：刻意不存在 ═══════════════════

describe('★ cxt trust rm —— 刻意不存在（§7.3 铁律 1）', { skip: !IS_WIN }, () => {
  for (const sub of ['rm', 'remove', 'delete']) {
    test(`\`trust ${sub}\` 拒绝，并给出**两条**出路`, () => {
      const s = bound();
      const r = s.run([sub, PROJ_A]);

      assert.equal(r.code, 1);
      assert.match(r.err, /不删信任条目/);
      assert.match(r.err, /--untrust/, '要指第一条出路');
      assert.match(r.err, /手工编辑|profile ls/, '只说"不支持"的话，用户下一步就是去删文件——那更危险');
    });
  }
});

// ═══════════════════ ls ═══════════════════

describe('cxt trust ls —— 只读的三态视图', { skip: !IS_WIN }, () => {
  test('★ 当前目录落在哪个 profile 上，要标出来', () => {
    const s = bound();
    s.run([PROJ_A, '--token', 'relay-a']);

    const r = s.run(['ls', '--cwd', PROJ_A]);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /← 当前目录/);
    assert.match(r.out, /trusted/);
  });

  test('★★ 当前目录**从未标记**时要给出第三态，而不是留白', () => {
    // 这一行恰恰是"我这个目录现在跑 codex 会不会被问"的直接答案。
    const s = bound();
    s.run([PROJ_A, '--token', 'relay-a']);   // 标的是 client-a，不是 client-b

    const r = s.run(['ls', '--cwd', PROJ_B]);
    assert.match(r.out, /未标记/);
    assert.match(r.out, /← 当前目录/);
  });

  test('★ 连 config.toml 都没有的 profile，当前目录那一问**仍要回答**', () => {
    const s = bound();   // 一个 profile 都没建过
    const r = s.run(['ls', '--cwd', PROJ_A]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /未标记/);
    assert.match(r.out, /← 当前目录/);
    assert.match(r.out, /还没有 config\.toml/);
  });

  test('★ 显式 untrusted 与"从未标记"在输出里是**两样**（§7.3）', () => {
    const s = bound();
    s.run([PROJ_A, '--token', 'relay-a']);
    s.run([PROJ_A, '--untrust', '--token', 'relay-a']);

    const r = s.run(['ls', '--cwd', PROJ_A]);
    assert.match(r.out, /untrusted/);
    assert.equal(/未标记[\s\S]*← 当前目录/.test(r.out), false,
      '★ 已经显式标了 untrusted，就不该再报"从未标记"');
  });

  test('★ 页脚要写出三态语义与 (token × 项目) 矩阵——这是本方案唯一的显著代价', () => {
    const s = bound();
    const r = s.run(['ls', '--cwd', PROJ_A]);
    assert.match(r.out, /UnlessTrusted/);
    assert.match(r.out, /OnRequest/);
    assert.match(r.out, /token × 项目|换个 token/);
  });

  test('--token 只看那一个 profile', () => {
    const s = bound();
    s.run([PROJ_A, '--token', 'relay-a']);
    s.run([PROJ_B, '--token', 'relay-b']);

    const r = s.run(['ls', '--token', 'relay-a', '--json']);
    const j = JSON.parse(r.out);
    assert.deepEqual(j.profiles.map((p) => p.profile), ['relay-a']);
  });

  test('--json 的形状：cwd 级联 + 每个 profile 的条目', () => {
    const s = bound();
    s.run([PROJ_A, '--token', 'relay-a']);

    const r = s.run(['ls', '--cwd', PROJ_A, '--json']);
    const j = JSON.parse(r.out);

    assert.equal(j.cwd, PROJ_A);
    assert.equal(j.cwdToken, 'relay-a');
    assert.equal(j.cwdProfile, 'relay-a');
    assert.equal(j.total, 1);

    const p = j.profiles.find((x) => x.profile === 'relay-a');
    assert.equal(p.entries.length, 1);
    assert.equal(p.entries[0].path, PROJ_A);
    assert.equal(p.entries[0].state, 'trusted');
    assert.equal(p.cwdState.state, 'trusted');
  });

  test('★ 表形式下报的是 `trust_level` 那一行，不是表头行', () => {
    const s = bound({
      profileName: 'relay-a',
      toml: String.raw`# 一行注释
model = "deepseek-chat"

[projects.'D:\work\client-a']
trust_level = 'trusted'
`,
    });
    const r = s.run(['ls', '--cwd', PROJ_A, '--json']);
    const p = JSON.parse(r.out).profiles.find((x) => x.profile === 'relay-a');

    assert.equal(p.entries[0].line, 5,
      '★ 报表头行（第 4 行）会让用户翻过去发现"这里没有 trust_level"');
  });

  test('★ 一个 profile 的表坏了，其余几个照常显示', () => {
    const s = bound({
      profileName: 'relay-a',
      // 同一张表定义两次 → 完整性错误
      toml: String.raw`[projects.'D:\work\client-a']
trust_level = 'trusted'

[projects.'D:\work\client-a']
trust_level = 'untrusted'
`,
    });
    s.run([PROJ_B, '--token', 'relay-b']);

    const r = s.run(['ls', '--cwd', PROJ_B]);
    assert.equal(r.code, 0, '一个 profile 坏了不该让整个 ls 失败');
    assert.match(r.out, /读不出来/);
    assert.match(r.out, /client-b/, 'relay-b 那条仍要显示');
  });
});

// ═══════════════════ 结构性不变量 ═══════════════════

describe('★ `[projects.*]` 只增不减——整条 CLI 链路上都成立（§2.9 铁律 2）', { skip: !IS_WIN }, () => {
  test('★★ 反复 trust / untrust 一个**别的**路径，既有条目一条不少', () => {
    const s = bound({
      profileName: 'relay-a',
      toml: String.raw`# 用户手写的注释
model = "deepseek-chat"
model_provider = "cxt-relay-a"

[model_providers.cxt-relay-a]
name = "relay-a"
base_url = "https://api.deepseek.com/"

[projects.'D:\work\client-a']
trust_level = 'trusted'

[projects.'D:\work\other']
trust_level = 'untrusted'
`,
    });
    const before = s.readCfg('relay-a');
    const beforeCount = (before.match(/\[projects\./g) ?? []).length;

    s.run(['D:\\work\\third', '--token', 'relay-a']);
    s.run(['D:\\work\\third', '--untrust', '--token', 'relay-a']);
    s.run(['D:\\work\\third', '--token', 'relay-a']);

    const after = s.readCfg('relay-a');
    assert.equal((after.match(/\[projects\./g) ?? []).length, beforeCount + 1,
      '★ 条目数对不上——要么删了用户的信任决定，要么重复追加了');
    for (const keep of ['D:\\work\\client-a', 'D:\\work\\other']) {
      assert.ok(after.includes(`[projects.'${keep}']`), `${keep} 的条目被吃掉了`);
    }
    // 非受管区必须逐字节保留
    assert.match(after, /# 用户手写的注释/);
    assert.match(after, /\[model_providers\.cxt-relay-a\]/);
  });

  test('★ 用户自己的 provider 与注释一字不动', () => {
    const s = bound({
      profileName: 'relay-a',
      toml: String.raw`# 我的配置，别动
[model_providers.my-own-relay]
name = "我的中转"
base_url = "https://relay.example.com/v1"
env_key = "MY_KEY"

[projects.'D:\work\client-a']
trust_level = 'trusted'
`,
    });
    const before = s.readCfg('relay-a');
    s.run([PROJ_A, '--token', 'relay-a']);
    assert.equal(s.readCfg('relay-a'), before, '信任已经是对的，文件就该一字不动');
  });
});
