// @ts-check
/**
 * ★ `cxt model` 的端到端测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这份文件守的是什么
 *
 * `model` 是"**人工故障转移**"的手感来源：模型挂了就 `next` 轮转、`run -c` 续上会话。
 * 手感类的东西最容易在实现里被做坏，而且坏得不明显。这里盯四件事：
 *
 * 1. **`next` 少于两项要报错**，不能静默 no-op。轮转完还是它自己，
 *    用户敲完看不出任何变化，只会以为工具坏了。
 * 2. **物化要说出来**（§2.5）。该层原先没有自己的列表时，`use` / `next` 会先把
 *    **当前生效的那份**复制过来——不告诉用户的话，他以为只是轮转了一下，
 *    实际从此这个目录不再跟着 token / 全局变了。
 * 3. **`clear` 在"本来就没有"时什么都不写**。不拦的话 `writeLayer` 会为了
 *    "删掉 models" 而**新建**一条空绑定——用户敲了一句 clear，配置里多出一坨垃圾。
 * 4. **`--id` 不切冒号**。OpenRouter 那类 id 自己就带 `:`（`…-70b:free`），
 *    按 `:` 切会让 id 悄悄少一截，而报错要等到 Codex 启动时才出现。
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

const PROJ = 'D:\\work\\client-a';

const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了 */ }
  }
});

/**
 * @param {{ config?: any, tokens?: Record<string, any> }} [opts]
 */
function setup(opts = {}) {
  const home = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-model-'));
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

  return {
    home,
    appDir,
    configPath: join(appDir, 'config.json'),
    tokenPath: (n) => join(appDir, 'tokens', `${n}.json`),
    readConfig: () => JSON.parse(nodeFs.readFileSync(join(appDir, 'config.json'), 'utf8')),
    readToken: (n) => JSON.parse(nodeFs.readFileSync(join(appDir, 'tokens', `${n}.json`), 'utf8')),
    /** @param {string[]} extra */
    run(extra) {
      const r = spawnSync(process.execPath, [CXT, 'model', ...extra], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, NO_COLOR: '1' },
        cwd: ROOT,
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },
  };
}

const ids = (list) => (list ?? []).map((m) => m.id);

// ═══════════════════ global 与 token 层 ═══════════════════

describe('cxt model —— global 与 token 层', () => {
  test('set --global 写进 config.defaults.models，顺序即优先级', () => {
    const s = setup();
    const r = s.run(['set', '--global', 'a', 'b', 'c']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(ids(s.readConfig().defaults.models), ['a', 'b', 'c']);
    assert.match(r.out, /config\.defaults/);
  });

  test('★ `set <id>:<label>` 按**第一个**冒号切', () => {
    const s = setup();
    const r = s.run(['set', '--global', 'deepseek-chat:DS 对话']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    const m = s.readConfig().defaults.models[0];
    assert.equal(m.id, 'deepseek-chat');
    assert.equal(m.label, 'DS 对话');
  });

  test('★ `id:` （冒号右边空） = 显式没有 label，不是 label 为空串', () => {
    const s = setup();
    s.run(['set', '--global', 'm1:']);
    assert.deepEqual(s.readConfig().defaults.models[0], { id: 'm1' });
  });

  test('★★ `--id` **一个字都不切**——OpenRouter 那种自带冒号的 id 靠它', () => {
    const s = setup();
    const r = s.run(['set', '--global', '--id', 'meta-llama/llama-3.1-70b:free']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(s.readConfig().defaults.models[0].id, 'meta-llama/llama-3.1-70b:free',
      '★ 切了的话 id 悄悄少一截，报错要等到 Codex 启动时才出现');
    assert.equal(s.readConfig().defaults.models[0].label, undefined);
  });

  test('位置参数写法确实会切——两种写法并存，各自语义明确', () => {
    const s = setup();
    s.run(['set', '--global', 'meta-llama/llama-3.1-70b:free']);
    const m = s.readConfig().defaults.models[0];
    assert.equal(m.id, 'meta-llama/llama-3.1-70b');
    assert.equal(m.label, 'free');
  });

  test('★ 冒号在最左边（`:label`）→ 报错，不猜', () => {
    const s = setup();
    const r = s.run(['set', '--global', ':oops']);
    assert.equal(r.code, 1);
    assert.match(r.err, /模型 id 不能为空/);
  });

  test('set 没给 id → 退出 1，并给出可直接复制的例子', () => {
    const s = setup();
    const r = s.run(['set', '--global']);
    assert.equal(r.code, 1);
    assert.match(r.err, /没有给出模型 id/);
    assert.match(r.err, /cxt model set deepseek-chat deepseek-reasoner/);
  });

  test('set --token 写进那个 token 文件（其余字段不动）', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a', baseUrl: 'https://a/' } } });
    const r = s.run(['set', '--token', 'relay-a', 'm1', 'm2']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    const t = s.readToken('relay-a');
    assert.deepEqual(ids(t.models), ['m1', 'm2']);
    assert.equal(t.baseUrl, 'https://a/', '改 models 不该动别的字段');
  });

  test('★ --token 不存在 → 退出 1（悬空的 token 层没有意义，写进去也没人读得到）', () => {
    const s = setup();
    const r = s.run(['set', '--token', 'ghost', 'm1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /ghost/);
    assert.match(r.err, /不存在/);
    assert.equal(nodeFs.existsSync(s.tokenPath('ghost')), false);
  });

  test('★ 三个层 flag 同时给 → 退出 1，并说清楚为什么', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } } });
    const r = s.run(['set', '--global', '--token', 'relay-a', 'm1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /只能给一个/);
    assert.match(r.err, /三个不同的层/);
  });

  test('--json 的形状（file 指向真正被改的那个文件）', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } } });
    const g = JSON.parse(s.run(['set', '--global', 'm1', '--json']).out);
    assert.equal(g.target.kind, 'global');
    assert.equal(g.file, s.configPath);
    assert.equal(g.current.id, 'm1');

    const t = JSON.parse(s.run(['set', '--token', 'relay-a', 'm2', '--json']).out);
    assert.equal(t.file, s.tokenPath('relay-a'), '★ 报错/报告里的 file 必须是真的那个文件');
  });
});

// ═══════════════════ use / next / clear ═══════════════════

describe('cxt model use / next —— 人工故障转移的手感', () => {
  test('★ use 提拔到首位，其余保持相对顺序（原首位退到第二，随时切回）', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, bindings: [] } });
    const r = s.run(['use', '--global', 'c']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(ids(s.readConfig().defaults.models), ['c', 'a', 'b']);
    assert.match(r.out, /a\s+→\s+c/, '要说清楚换成了什么');
  });

  test('★ use 一个不在列表里的 id → 插到首位（新候选不必先 set 一遍）', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'a' }] }, bindings: [] } });
    s.run(['use', '--global', 'newbie']);
    assert.deepEqual(ids(s.readConfig().defaults.models), ['newbie', 'a']);
  });

  test('★ use 的 id 已在首位 → 报成功（要的状态已经成立，这是诚实的 no-op）', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'a' }, { id: 'b' }] }, bindings: [] } });
    const r = s.run(['use', '--global', 'a']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(ids(s.readConfig().defaults.models), ['a', 'b']);
  });

  test('★ use 保住原条目的 label（不编造、不丢）', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: { models: [{ id: 'a' }, { id: 'b', label: 'B 家' }] },
        bindings: [],
      },
    });
    s.run(['use', '--global', 'b']);
    assert.deepEqual(s.readConfig().defaults.models[0], { id: 'b', label: 'B 家' });
  });

  test('use 缺 id → 退出 1', () => {
    const s = setup();
    const r = s.run(['use', '--global']);
    assert.equal(r.code, 1);
    assert.match(r.err, /缺少模型 id/);
  });

  test('★ next 轮转一位： [a,b,c] → [b,c,a]', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, bindings: [] } });
    const r = s.run(['next', '--global']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(ids(s.readConfig().defaults.models), ['b', 'c', 'a']);
    assert.match(r.out, /a\s+→\s+b/);
  });

  test('★★ next 反复按一定能回到原点（长度不变 = 候选不会被耗光）', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, bindings: [] } });
    for (let i = 0; i < 3; i += 1) s.run(['next', '--global']);
    assert.deepEqual(ids(s.readConfig().defaults.models), ['a', 'b', 'c']);
  });

  test('★★ next 只有一项 → **报错**，不是静默 no-op（轮转完没变化会像工具坏了）', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'only' }] }, bindings: [] } });
    const r = s.run(['next', '--global']);

    assert.equal(r.code, 1);
    assert.match(r.err, /只有一项/);
    assert.match(r.err, /没有下一个/);
    assert.match(r.err, /cxt model set/, '报错要给出路');
  });

  test('next 一层都没声明 → 退出 1（空列表没有下一个）', () => {
    const s = setup();
    const r = s.run(['next', '--global']);
    assert.equal(r.code, 1);
    assert.match(r.err, /空的|没有下一个/);
  });

  test('★★ clear 在没有自己列表的层上**什么都不写**——不许凭空建出一条空绑定', () => {
    const s = setup();
    const r = s.run(['clear', '--path', PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /本来就没有自己的模型列表/);
    assert.equal(nodeFs.existsSync(s.configPath), false,
      '★ 敲了一句 clear，配置文件里多出一坨垃圾——这就是"不拦"的代价');
  });

  test('★ clear --global 被拒，并说清楚 global 是级联的顶层', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'a' }] }, bindings: [] } });
    const r = s.run(['clear', '--global']);

    assert.equal(r.code, 1);
    assert.match(r.err, /不支持 --global/);
    assert.match(r.err, /顶层/);
    assert.match(r.err, /cxt model set --global/);
    assert.deepEqual(ids(s.readConfig().defaults.models), ['a'], '拒了就不许动文件');
  });

  test('clear --token 删掉那一层自己的列表，并报出原来生效的是什么', () => {
    const s = setup({
      config: { version: 1, defaults: { models: [{ id: 'g' }] }, bindings: [] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a', models: [{ id: 'own' }] } },
    });
    const r = s.run(['clear', '--token', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(s.readToken('relay-a').models, undefined, '该字段要**删掉**，不是置空数组');
    assert.match(r.out, /回退到上一层/);
    assert.match(r.out, /原来它生效的是\s+own/);
  });
});

// ═══════════════════ 路径层 ═══════════════════

describe('★ cxt model 的路径层（--path / 无 flag 走当前目录）', { skip: !IS_WIN }, () => {
  test('★ 该路径没有绑定时**自动建一条**（§2.5）', () => {
    const s = setup();
    const r = s.run(['set', '--path', PROJ, 'm1']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    const b = s.readConfig().bindings;
    assert.equal(b.length, 1);
    assert.equal(b[0].path, PROJ);
    assert.deepEqual(ids(b[0].models), ['m1']);
    assert.equal(b[0].token, undefined, '★ 只建了一条带 models 的绑定，没有顺手编一个 token');
  });

  test('★ 已有那条绑定则就地改，不追加第二条', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [{ path: PROJ, token: 'relay-a' }] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } },
    });
    s.run(['set', '--path', PROJ, 'm1']);

    const b = s.readConfig().bindings;
    assert.equal(b.length, 1);
    assert.equal(b[0].token, 'relay-a', '改 models 不该把 token 抹掉');
    assert.deepEqual(ids(b[0].models), ['m1']);
  });

  test('★★ 物化：该层没有自己的列表时，use 会复制上层那份上来——**并且要说出来**', () => {
    const s = setup({
      config: { version: 1, defaults: { models: [{ id: 'g1' }, { id: 'g2' }] }, bindings: [] },
    });
    const r = s.run(['use', '--path', PROJ, 'g2']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /物化/);
    assert.match(r.out, /不再随上层变化/, '★ 不说的话，用户以为只是轮转了一下');
    assert.match(r.out, /cxt model clear/);
    assert.deepEqual(ids(s.readConfig().bindings[0].models), ['g2', 'g1']);
  });

  test('★ 物化判据是"这一层自己有没有列表"，不是"读到的列表是不是空"', () => {
    // 该路径没声明、但 token 层有——那正是"复制一份上来"的典型场景。
    // 拿 `before === undefined` 当判据就会漏掉它（读到的列表并不为空）。
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: PROJ, token: 'relay-a' }],
      },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a', models: [{ id: 't1' }, { id: 't2' }] } },
    });
    const r = s.run(['next', '--path', PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /物化/);
    assert.deepEqual(ids(s.readConfig().bindings[0].models), ['t2', 't1']);
    assert.deepEqual(ids(s.readToken('relay-a').models), ['t1', 't2'],
      '★ 写的是**路径层**那条，token 层不该被改（那是最隐蔽的"改错层"）');
  });

  test('★ 无 flag 时按**当前目录**——这是最顺手的一层', () => {
    const s = setup();
    const cwd = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-mcwd-'));
    TEMP_HOMES.push(cwd);

    const r = spawnSync(process.execPath, [CXT, 'model', 'set', 'here-model'], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: s.home, NO_COLOR: '1' },
      cwd,
    });
    assert.equal(r.status, 0, `stderr:\n${r.stderr}`);
    assert.equal(s.readConfig().bindings[0].path, cwd);
  });

  test('★ 读用前缀匹配、写用精确匹配——next 不该改掉祖先目录那条共享绑定', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: 'D:\\work', token: 'relay-a', models: [{ id: 'anc1' }, { id: 'anc2' }] }],
      },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } },
    });
    // 在子目录里 next：生效的是祖先那条，但写下去必须落到**本目录自己**的新绑定上
    const r = s.run(['next', '--path', 'D:\\work\\client-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    const b = s.readConfig().bindings;
    assert.equal(b.length, 2);
    assert.deepEqual(ids(b.find((/** @type {any} */ x) => x.path === 'D:\\work').models), ['anc1', 'anc2'],
      '★ 祖先那条被改了——它可能是好几个目录共用的');
    assert.deepEqual(ids(b.find((/** @type {any} */ x) => x.path === 'D:\\work\\client-a').models), ['anc2', 'anc1']);
  });

  test('★ ls 把来源层标出来——这是这张表存在的主要理由', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: { models: [{ id: 'g' }] },
        bindings: [{ path: PROJ, models: [{ id: 'b1' }, { id: 'b2' }] }],
      },
    });
    const r = s.run(['ls', PROJ, '--json']);
    const j = JSON.parse(r.out);

    assert.equal(j.what, PROJ);
    assert.equal(j.source, `binding ${PROJ}`);
    assert.equal(j.current.id, 'b1', 'current = models[0]');
  });

  test('★ 路径层没声明 → 标成 defaults，而不是当成"没有"', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'g' }] }, bindings: [] } });
    const j = JSON.parse(s.run(['ls', PROJ, '--json']).out);
    assert.equal(j.source, 'defaults');
    assert.equal(j.current.id, 'g');
  });

  test('★ `model ls <名字>` 当 token 解释（在绑定目录里问的也是那个 token）', () => {
    const s = setup({
      config: { version: 1, defaults: { models: [{ id: 'g' }] }, bindings: [] },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a', models: [{ id: 'own' }] } },
    });
    const j = JSON.parse(s.run(['ls', 'relay-a', '--json']).out);
    assert.equal(j.what, 'token relay-a');
    assert.equal(j.source, 'token', '问的是 token 本身时，来源层就是它自己');
    assert.equal(j.current.id, 'own');
  });

  test('★ 一层都没声明 → 说清楚"Codex 会用它自己的默认"，并给出 set 的写法', () => {
    const s = setup();
    const r = s.run(['ls', PROJ]);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /没有任何一层声明模型/);
    assert.match(r.out, /cxt model set --path/);
  });

  test('★ 显式空列表在人读输出里有自己的说法（与"没设"不是一回事，§2.5 规则 3）', () => {
    const s = setup({
      config: { version: 1, defaults: { models: [] }, bindings: [] },
    });
    const r = s.run(['ls', PROJ]);
    assert.match(r.out, /显式空列表/);
    assert.match(r.out, /来源层：.*defaults/);
  });

  test('★ 单元素列表在 ls 里就提示"next 会报错"——别让用户到那时候才发现', () => {
    const s = setup({ config: { version: 1, defaults: { models: [{ id: 'only' }] }, bindings: [] } });
    const r = s.run(['ls', PROJ]);
    assert.match(r.out, /只有一项/);
    assert.match(r.out, /cxt model next/);
  });
});

// ═══════════════════ 项目本地层（§2.13 五）═══════════════════

/**
 * ★ 写入目标跟着**生效层**走。
 *
 * 写到一个不生效的地方 = 命令静默失效：`cxt model next` 报"已轮转"、
 * 模型却纹丝不动——正是 §6.2「宁可明确」要避免的。
 */
describe('★ cxt model 的项目本地层：写入目标跟着生效层走（§2.13 五）', { skip: !IS_WIN }, () => {
  /**
   * 造一个**真实**目录，可带一份 `.cxt.json`。
   * ⚠️ 必须是真目录：发现走 `statSync().isFile()`（§2.13 一）。
   * @param {Record<string, any>} [files]
   */
  function makeProj(files = {}) {
    const dir = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-mproj-'));
    TEMP_HOMES.push(dir);
    for (const [name, body] of Object.entries(files)) {
      nodeFs.writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
    return dir;
  }
  const readProj = (/** @type {string} */ dir) =>
    JSON.parse(nodeFs.readFileSync(join(dir, '.cxt.json'), 'utf8'));

  /** 一个声明了 models 的项目目录 + 一套空的全局配置 */
  function projSetup() {
    return setup({ config: { version: 1, defaults: {}, bindings: [] } });
  }

  test('★★ 项目文件声明了 models → `set --path` 写进**那个文件**，不碰绑定', () => {
    const dir = makeProj({ '.cxt.json': { version: 1, token: 'relay-a', models: [{ id: 'p1' }] } });
    const s = projSetup();

    const r = s.run(['set', '--path', dir, 'n1', 'n2']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(ids(readProj(dir).models), ['n1', 'n2']);
    assert.deepEqual(s.readConfig().bindings ?? [], [],
      '★ 写到了生效的那一层，就不该顺手建一条绑定出来');
  });

  test('★ 写项目文件时**保留其余键**（token / sandboxMode / env 一个都不能丢）', () => {
    const dir = makeProj({
      '.cxt.json': {
        version: 1,
        token: 'relay-a',
        sandboxMode: 'danger-full-access',
        approvalPolicy: 'never',
        env: { RUST_LOG: 'warn' },
        models: [{ id: 'p1' }],
      },
    });
    const s = projSetup();
    s.run(['set', '--path', dir, 'n1']);

    const f = readProj(dir);
    assert.equal(f.token, 'relay-a');
    assert.equal(f.sandboxMode, 'danger-full-access');
    assert.equal(f.approvalPolicy, 'never');
    assert.deepEqual(f.env, { RUST_LOG: 'warn' });
    assert.deepEqual(ids(f.models), ['n1']);
    assert.equal(f.version, 1);
  });

  test('★ `use` 走的是**项目本地那条链**：物化出来的就是项目本地当前生效的那份', () => {
    const dir = makeProj({ '.cxt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });
    const s = projSetup();

    const r = s.run(['use', '--path', dir, 'p2']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(ids(readProj(dir).models), ['p2', 'p1']);
  });

  test('★★ 项目文件**没**声明 models → 写入仍然落到绑定（那一层没说话）', () => {
    // 反向断言：不这么分的话，`cxt model set --path` 会让项目文件
    // **凭空开始管模型**——而它原本只声明了 token。
    const dir = makeProj({ '.cxt.json': { version: 1, token: 'relay-a' } });
    const s = projSetup();

    const r = s.run(['set', '--path', dir, 'm1']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(ids(s.readConfig().bindings[0].models), ['m1']);
    assert.equal(readProj(dir).models, undefined, '★ 项目文件不该被凭空加上 models');
  });

  test('★★ `--config` 压过按 `--path` 的发现：写进它指的那一份', () => {
    // §2.13 一：显式给了 `--config` 就是"这一份才是我的项目配置"，**不做发现**。
    // 于是**生效层**是它，写入目标自然得跟着它——否则
    // `cxt --config A model set --path B` 会去改 B 那一份，而真正生效的是 A。
    const near = makeProj({ '.cxt.json': { version: 1, models: [{ id: 'p1' }] } });
    const other = makeProj({ 'my-cfg.json': { version: 1, models: [{ id: 'q1' }] } });
    const explicit = join(other, 'my-cfg.json');
    const s = projSetup();

    const r = s.run(['set', '--path', near, '--config', explicit, 'n1', 'n2']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);

    assert.deepEqual(ids(JSON.parse(nodeFs.readFileSync(explicit, 'utf8')).models), ['n1', 'n2'],
      '★ 写进了 `--config` 指的那一份');
    assert.deepEqual(ids(readProj(near).models), ['p1'], '★ 发现到的那一份一个字不动');
    assert.deepEqual(s.readConfig().bindings ?? [], [], '★ 也没顺手建一条绑定');
  });

  test('★ `--config` 那一份**没**声明 models → 仍然落到绑定（判据是生效层，不是"给了就写它"）', () => {
    // 与上一条配对：`--config` 改的是**发现**，不是"写入目标的判据"。
    // 判据只有一个——**哪一层生效**（§2.13 五）。
    const near = makeProj({ '.cxt.json': { version: 1, models: [{ id: 'p1' }] } });
    const other = makeProj({ 'my-cfg.json': { version: 1, token: 'relay-a' } });
    const explicit = join(other, 'my-cfg.json');
    const s = projSetup();

    const r = s.run(['set', '--path', near, '--config', explicit, 'm1']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);

    assert.deepEqual(ids(s.readConfig().bindings[0].models), ['m1']);
    assert.equal(JSON.parse(nodeFs.readFileSync(explicit, 'utf8')).models, undefined,
      '★ 它没声明 models，就不该被凭空加上——那等于让一个只管 token 的文件开始管模型');
    assert.deepEqual(ids(readProj(near).models), ['p1'], '★ 发现被跳过 → 那一份也不动');
  });

  test('★ `ls` 与 `set` 的判据一致：来源标成项目本地，file 指那个文件', () => {
    const dir = makeProj({ '.cxt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });
    const s = projSetup();

    const j = JSON.parse(s.run(['ls', '--path', dir, '--json']).out);
    assert.equal(j.source, `项目本地 ${join(dir, '.cxt.json')}`);
    assert.equal(j.file, join(dir, '.cxt.json'));
    assert.equal(j.current.id, 'p1');

    // 人读输出里也要看得见
    assert.match(s.run(['ls', '--path', dir]).out, /项目本地/);
  });

  test('★ `ls --path` 与位置参数**只认一个**——同时给要报错，不许猜', () => {
    // ★ 这条守的是"静默失效"：`--path` 曾经在 spec 里、但 cmdLs 只读位置参数，
    //   于是 `ls --path X` 会**一声不响地列出当前目录**（问 A 答 B）。
    //   现在两条路都通了，剩下唯一的坑就是"两条都给"——那必须明确报错。
    const dir = makeProj({ '.cxt.json': { version: 1, models: [{ id: 'p1' }] } });
    const s = projSetup();

    const r = s.run(['ls', dir, '--path', dir]);
    assert.equal(r.code, 1);
    assert.match(r.err, /位置参数与 `--path` 只能给一个/);
  });

  test('★ `ls --path` 与 `ls <path>` 得到**同一份**答案', () => {
    const dir = makeProj({ '.cxt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });
    const s = projSetup();

    const a = JSON.parse(s.run(['ls', dir, '--json']).out);
    const b = JSON.parse(s.run(['ls', '--path', dir, '--json']).out);
    assert.deepEqual(b, a, '★ 两种写法是同一件事，输出必须逐字一致');
  });

  test('★ `ls --path` 也能吃到"路径"这一支的完整级联（不是只看项目文件）', () => {
    // 反向断言：`--path` 若被当成"只查项目本地"，这里就会是 none——
    // 而它该和位置参数一样，走 项目本地 → 绑定 → token → defaults。
    const dir = makeProj({});
    const s = projSetup();
    const r = s.run(['set', '--path', dir, 'm1']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);

    const j = JSON.parse(s.run(['ls', '--path', dir, '--json']).out);
    assert.equal(j.current.id, 'm1');
    assert.match(j.source, /^binding /);
  });

  test('★★ `clear` 只删 models，**不删文件**、也不建绑定', () => {
    const dir = makeProj({
      '.cxt.json': { version: 1, token: 'relay-a', models: [{ id: 'p1' }] },
    });
    const s = projSetup();

    const r = s.run(['clear', '--path', dir]);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(join(dir, '.cxt.json')), true, '★ 文件本身还在');
    assert.equal(readProj(dir).token, 'relay-a', '★ 其余键一个都不许丢');
    assert.equal(readProj(dir).models, undefined);
    assert.deepEqual(s.readConfig().bindings ?? [], []);
  });

  test('★★ 在**子目录**里跑 → 发现的是祖先那份，写回**那个文件**（不新建一份）', () => {
    const dir = makeProj({ '.cxt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });
    const sub = join(dir, 'sub');
    nodeFs.mkdirSync(sub, { recursive: true });
    const s = projSetup();

    const r = s.run(['next', '--path', sub]);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(join(sub, '.cxt.json')), false,
      '★ 不该在子目录里新建一份——那会让"最近优先"从此指向它');
    assert.deepEqual(ids(readProj(dir).models), ['p2', 'p1']);
  });

  test('★ 项目文件坏了 → 硬报错（不静默回退到绑定）', () => {
    const dir = makeProj({ '.cxt.json': { version: 1, baseUrl: 'https://evil.example.com/v1' } });
    const s = projSetup();

    const r = s.run(['set', '--path', dir, 'm1']);
    assert.equal(r.code, 1);
    assert.match(r.err, /baseUrl/);
    assert.deepEqual(s.readConfig().bindings ?? [], [], '★ 报错了就什么都不该写');
  });

  test('`--json` 的 target.kind 标成 project（脚本要按它分流）', () => {
    const dir = makeProj({ '.cxt.json': { version: 1, models: [{ id: 'p1' }] } });
    const s = projSetup();
    const j = JSON.parse(s.run(['set', '--path', dir, 'm1', '--json']).out);
    assert.equal(j.target.kind, 'project');
    assert.equal(j.file, join(dir, '.cxt.json'));
  });
});

// ═══════════════════ 分发与帮助 ═══════════════════

describe('cxt model —— 分发与帮助', () => {
  test('没有子命令 → 打帮助，退出 0', () => {
    const s = setup();
    const r = s.run([]);
    assert.equal(r.code, 0);
    assert.match(r.out, /cxt model next/);
    assert.match(r.out, /物化/);
  });

  test('--help → 退出 0', () => {
    const s = setup();
    const r = s.run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /--global/);
  });

  test('未知子命令 → 退出 1，并列出可用的', () => {
    const s = setup();
    const r = s.run(['nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /未知子命令/);
    assert.match(r.err, /ls \/ set \/ use \/ next \/ clear/);
  });
});
