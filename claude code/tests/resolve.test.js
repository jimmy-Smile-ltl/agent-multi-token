// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInjection,
  buildSessionEnv,
  evalEnvRef,
  mergeEnv,
  parseEnvRef,
  pickTokenName,
  resolveConfig,
  SESSION_MARKER_ENV,
  SOURCE_LABEL,
  stripSessionMarkers,
} from '../src/core/resolve.js';
import { SLOT_ENV } from '../src/core/models.js';
import { normalizeProjectConfig } from '../src/core/project-config.js';
import { normalizeConfig, normalizeToken } from '../src/core/schema.js';

const CTX = { platform: /** @type {NodeJS.Platform} */ ('linux'), home: '/home/t' };
const CWD = '/home/t/work/a';

/** 造一份归一化过的 config（真实调用链就是这么拿到的） */
const cfg = (raw) => normalizeConfig({ version: 1, ...raw });
/** 造一个归一化过的 token */
const tok = (raw) => normalizeToken(raw, raw.name);

const resolve = (config, token, overrides = {}, extra = {}) =>
  resolveConfig({ config, token, overrides, cwd: CWD, ctx: CTX, env: {}, ...extra });

/** `buildInjection` 的常用夹具：默认给齐 authToken 与 models，免得每条用例重复写 */
const base = (extra) => ({ defaults: { authToken: 'sk-x', models: [{ id: 'm' }], ...extra } });
/** 跑一遍 `buildInjection`（`base()` 造配置 + 求值用的 procEnv 都是同一个） */
const inject = (raw, procEnv = {}) =>
  buildInjection(resolve(cfg(raw), null, {}, { env: procEnv }), { home: '/home/t', env: procEnv });


// ───────────────────────────── 阶段一：选 token ─────────────────────────────

describe('pickTokenName —— §2.3 的 token 行', () => {
  test('--token 压过一切', () => {
    const config = cfg({
      defaults: { token: 'global-tok' },
      bindings: [{ path: '/home/t/work', token: 'bound-tok' }],
    });
    const r = pickTokenName({ config, overrides: { token: 'cli-tok' }, cwd: CWD, ctx: CTX });
    assert.equal(r.name, 'cli-tok');
    assert.equal(r.source, 'cli');
  });

  test('绑定压过全局默认 token', () => {
    const config = cfg({
      defaults: { token: 'global-tok' },
      bindings: [{ path: '/home/t/work/a', token: 'bound-tok' }],
    });
    const r = pickTokenName({ config, cwd: CWD, ctx: CTX });
    assert.equal(r.name, 'bound-tok');
    assert.equal(r.source, 'binding');
    assert.equal(r.detail, '/home/t/work/a');
  });

  test('没有绑定 → 全局默认 token', () => {
    const config = cfg({ defaults: { token: 'global-tok' } });
    const r = pickTokenName({ config, cwd: CWD, ctx: CTX });
    assert.equal(r.name, 'global-tok');
    assert.equal(r.source, 'defaults');
  });

  test('都没有 → null（纯 defaults 模式）', () => {
    const r = pickTokenName({ config: cfg({}), cwd: CWD, ctx: CTX });
    assert.equal(r.name, null);
    assert.equal(r.source, 'none');
  });

  test('★ 绑定匹配用「调用时的 cwd」，不是 token.cwd（否则成环）', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work/a', token: 'bound' }] });
    // 从别的目录跑 → 不命中，哪怕某个 token 的 cwd 恰好是 /home/t/work/a
    const r = pickTokenName({ config, cwd: '/home/t/elsewhere', ctx: CTX });
    assert.equal(r.name, null);
  });

  test('--cwd 参与绑定匹配（"当作我在那儿"）', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work/a', token: 'bound' }] });
    const r = pickTokenName({ config, overrides: { cwd: '/home/t/work/a/sub' }, cwd: '/tmp', ctx: CTX });
    assert.equal(r.name, 'bound');
  });

  test('非法 token 名在阶段一就被拦下', () => {
    assert.throws(
      () => pickTokenName({ config: cfg({}), overrides: { token: '../evil' }, cwd: CWD, ctx: CTX }),
      /路径分隔符/,
    );
  });
});

// ───────────────────────────── 阶段二：级联 ─────────────────────────────

describe('resolveConfig —— baseUrl 四层', () => {
  const base = {
    defaults: { baseUrl: 'https://defaults.example' },
  };

  test('只有全局 → defaults', () => {
    const r = resolve(cfg(base), null);
    assert.equal(r.baseUrl.value, 'https://defaults.example');
    assert.equal(r.baseUrl.source, 'defaults');
  });

  test('token 压过全局', () => {
    const config = cfg(base);
    const r = resolve(config, tok({ name: 'a', baseUrl: 'https://token.example' }));
    assert.equal(r.baseUrl.value, 'https://token.example');
    assert.equal(r.baseUrl.source, 'token');
  });

  test('绑定压过 token', () => {
    const config = cfg({ ...base, bindings: [{ path: '/home/t/work', baseUrl: 'https://binding.example' }] });
    const r = resolve(config, tok({ name: 'a', baseUrl: 'https://token.example' }));
    assert.equal(r.baseUrl.value, 'https://binding.example');
    assert.equal(r.baseUrl.source, 'binding');
  });

  test('--url 压过绑定', () => {
    const config = cfg({ ...base, bindings: [{ path: '/home/t/work', baseUrl: 'https://binding.example' }] });
    const r = resolve(config, null, { baseUrl: 'https://cli.example' });
    assert.equal(r.baseUrl.value, 'https://cli.example');
    assert.equal(r.baseUrl.source, 'cli');
  });

  test('都没有 → value undefined / source none（交给 validate 报缺项）', () => {
    const r = resolve(cfg({}), null);
    assert.equal(r.baseUrl.value, undefined);
    assert.equal(r.baseUrl.source, 'none');
  });
});

describe('resolveConfig —— cwd 三层', () => {
  test('--cwd 最优先', () => {
    const r = resolve(cfg({}), tok({ name: 'a', cwd: '/home/t/from-token' }), { cwd: '/home/t/from-cli' });
    assert.equal(r.cwd.value, '/home/t/from-cli');
    assert.equal(r.cwd.source, 'cli');
  });

  test('token.cwd 次之（★ cmt run <token> 的默认落点）', () => {
    const r = resolve(cfg({}), tok({ name: 'a', cwd: '/home/t/from-token' }));
    assert.equal(r.cwd.value, '/home/t/from-token');
    assert.equal(r.cwd.source, 'token');
  });

  test('都没有 → 当前目录', () => {
    const r = resolve(cfg({}), null);
    assert.equal(r.cwd.value, CWD);
    assert.equal(r.cwd.source, 'cwd');
  });

  test('~ 会展开（值必须能直接拿去 spawn）', () => {
    const r = resolve(cfg({}), tok({ name: 'a', cwd: '~/proj' }));
    assert.equal(r.cwd.value, '/home/t/proj');
  });

  test('cwdNormalized 是归一化串，供绑定对照（§2.9 三）', () => {
    const r = resolve(cfg({}), null, { cwd: '/home/t/work/a/' });
    assert.equal(r.cwdNormalized, '/home/t/work/a');
  });
});

describe('resolveConfig —— authToken / authMode', () => {
  test('authToken 走 --token-value → 绑定 → token → 全局', () => {
    const config = cfg({ defaults: { authToken: 'd' }, bindings: [{ path: '/home/t/work', authToken: 'b' }] });
    assert.equal(resolve(config, tok({ name: 'a', authToken: 't' })).authToken.value, 'b');
    assert.equal(resolve(cfg({ defaults: { authToken: 'd' } }), tok({ name: 'a', authToken: 't' })).authToken.value, 't');
    assert.equal(resolve(cfg({ defaults: { authToken: 'd' } }), null).authToken.value, 'd');
    assert.equal(resolve(config, tok({ name: 'a', authToken: 't' }), { authToken: 'c' }).authToken.value, 'c');
  });

  test('authMode 缺省是内置 "token"（§2.6：不弹确认框）', () => {
    const r = resolve(cfg({}), null);
    assert.equal(r.authMode.value, 'token');
    assert.equal(r.authMode.source, 'builtin');
  });

  test('authMode 可被各层覆盖', () => {
    const config = cfg({ defaults: { authMode: 'key' } });
    assert.equal(resolve(config, null).authMode.value, 'key');
    assert.equal(resolve(config, null).authMode.source, 'defaults');
    assert.equal(resolve(config, tok({ name: 'a', authMode: 'token' })).authMode.source, 'token');
    assert.equal(resolve(config, null, { authMode: 'token' }).authMode.source, 'cli');
  });
});

describe('resolveConfig —— models 整体覆盖（§2.3）', () => {
  const D = { id: 'd' };
  const T = { id: 't' };
  const B = { id: 'b' };

  test('★ 绑定有 list → 整个换掉，不与 token 的拼接', () => {
    const config = cfg({
      defaults: { models: [D] },
      bindings: [{ path: '/home/t/work', models: [B] }],
    });
    const r = resolve(config, tok({ name: 'a', models: [T] }));
    assert.deepEqual(r.models.value, [B]);
    assert.equal(r.models.source, 'binding');
  });

  test('token 有 list → 整个换掉全局的', () => {
    const config = cfg({ defaults: { models: [D] } });
    const r = resolve(config, tok({ name: 'a', models: [T] }));
    assert.deepEqual(r.models.value, [T]);
  });

  test('★ [] 是显式声明，不是"没声明"（§2.5 规则 4）', () => {
    const config = cfg({ defaults: { models: [D] }, bindings: [{ path: '/home/t/work', models: [] }] });
    const r = resolve(config, null);
    assert.deepEqual(r.models.value, []);
    assert.equal(r.models.declared, true, '[] 必须算"已声明"，否则会被误判成缺项');
    assert.equal(r.models.source, 'binding');
  });

  test('三层都没声明 → declared=false（validate 据此报缺项）', () => {
    const r = resolve(cfg({}), null);
    assert.equal(r.models.declared, false);
    assert.deepEqual(r.models.value, []);
  });

  test('--model 把指定模型提到首位，其余保持相对顺序', () => {
    const config = cfg({ defaults: { models: [{ id: 'x' }, { id: 'y' }, { id: 'z' }] } });
    const r = resolve(config, null, { model: 'z' });
    assert.deepEqual(r.models.value.map((m) => m.id), ['z', 'x', 'y']);
    assert.equal(r.models.source, 'cli');
  });

  test('--model 指定列表外的模型 → 插到首位', () => {
    const config = cfg({ defaults: { models: [{ id: 'x' }] } });
    const r = resolve(config, null, { model: 'new' });
    assert.deepEqual(r.models.value.map((m) => m.id), ['new', 'x']);
  });

  test('★ 只有 --model 也能满足"model"这一要素', () => {
    const r = resolve(cfg({}), null, { model: 'solo' });
    assert.equal(r.models.declared, true);
    assert.deepEqual(r.models.value, [{ id: 'solo' }]);
  });
});

describe('resolveConfig —— slots（整体覆盖 + 补默认槽）', () => {
  test('未列出的槽自动填 models[0]', () => {
    const config = cfg({ defaults: { models: [{ id: 'flash' }] } });
    const r = resolve(config, null);
    assert.deepEqual(r.slots, {
      opus: 'flash', sonnet: 'flash', haiku: 'flash', fable: 'flash', subagent: 'flash',
    });
  });

  test('★ 显式 null 的槽保持 null（不注入）', () => {
    const config = cfg({
      defaults: { models: [{ id: 'flash' }], slots: { haiku: null, opus: 'big' } },
    });
    const r = resolve(config, null);
    assert.equal(r.slots.haiku, null);
    assert.equal(r.slots.opus, 'big');
    assert.equal(r.slots.sonnet, 'flash');
  });

  test('绑定的 slots 整体覆盖 token 的', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', slots: { opus: 'b' } }] });
    const r = resolve(config, tok({ name: 'a', slots: { opus: 't' } }));
    assert.equal(r.slots.opus, 'b');
  });
});

describe('resolveConfig —— env 按键合并（§2.3 唯一的不对称）', () => {
  test('三层同名键：绑定赢', () => {
    const config = cfg({
      defaults: { env: { K: 'defaults', ONLY_D: '1' } },
      bindings: [{ path: '/home/t/work', env: { K: 'binding' } }],
    });
    const r = resolve(config, tok({ name: 'a', env: { K: 'token', ONLY_T: '1' } }));
    assert.equal(r.env.K.value, 'binding');
    assert.equal(r.env.K.source, 'binding');
    assert.equal(r.env.ONLY_D.value, '1');
    assert.equal(r.env.ONLY_D.source, 'defaults');
    assert.equal(r.env.ONLY_T.value, '1');
    assert.equal(r.env.ONLY_T.source, 'token');
  });

  test('★ 与 models 的"整体覆盖"相反：键不丢', () => {
    const config = cfg({
      defaults: { env: { A: '1', B: '1' } },
      bindings: [{ path: '/home/t/work', env: { C: '1' } }],
    });
    const r = resolve(config, null);
    assert.deepEqual(Object.keys(r.env).sort(), ['A', 'B', 'C']);
  });

  test('mergeEnv 直接调用：低层在前，高层覆盖', () => {
    const merged = mergeEnv([
      { source: 'binding', obj: { env: { X: 'b' } } },
      { source: 'defaults', obj: { env: { X: 'd', Y: 'd' } } },
    ]);
    assert.equal(merged.X.value, 'b');
    assert.equal(merged.Y.source, 'defaults');
  });
});

describe('resolveConfig —— claudeArgs 各层拼接（低 → 高）', () => {
  test('全局在前、token 在后，让更具体的层能覆盖', () => {
    const config = cfg({ defaults: { claudeArgs: ['--verbose'] } });
    const r = resolve(config, tok({ name: 'a', claudeArgs: ['--setting-sources', 'user'] }));
    assert.deepEqual(r.claudeArgs, ['--verbose', '--setting-sources', 'user']);
  });

  test('都没有 → 空数组', () => {
    assert.deepEqual(resolve(cfg({}), null).claudeArgs, []);
  });

  test('★ 绑定层没有 claudeArgs 这个字段（§2.4 的 binding 形状里没有它）', () => {
    assert.throws(
      () => cfg({ bindings: [{ path: '/home/t/work', claudeArgs: ['--x'] }] }),
      /未知字段 "claudeArgs"/,
    );
  });
});

describe('resolveConfig —— terminalMode / tokenName / warnings', () => {
  test('terminalMode 默认 tab（内置）', () => {
    const r = resolve(cfg({}), null);
    assert.equal(r.terminalMode.value, 'tab');
    assert.equal(r.terminalMode.source, 'builtin');
  });

  test('--window 覆盖', () => {
    const r = resolve(cfg({ defaults: { terminalMode: 'tab' } }), null, { terminalMode: 'window' });
    assert.equal(r.terminalMode.value, 'window');
    assert.equal(r.terminalMode.source, 'cli');
  });

  test('tokenName 带上来源层（cmt resolve 靠它回答"为什么")', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', token: 'bound' }] });
    const r = resolve(config, tok({ name: 'bound' }));
    assert.equal(r.tokenName.value, 'bound');
    assert.equal(r.tokenName.source, 'binding');
    assert.equal(r.tokenName.detail, '/home/t/work');
  });

  test('token 被选中但没加载 → 有 warning，不抛异常', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', token: 'bound' }] });
    const r = resolve(config, null);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /bound/);
  });

  test('纯 defaults 模式无 warning', () => {
    assert.deepEqual(resolve(cfg({}), null).warnings, []);
  });

  test('SOURCE_LABEL 覆盖全部来源层', () => {
    // ★ `project` 是 §2.11 的第四层——`cmt resolve` 会把它印成「项目本地」。
    //   漏了它的症状是"来源层那一栏是 undefined"，而 resolve 的卖点就是那一栏。
    for (const s of ['cli', 'project', 'binding', 'token', 'defaults', 'builtin', 'cwd', 'none']) {
      assert.ok(SOURCE_LABEL[/** @type {any} */ (s)], `缺 ${s} 的标签`);
    }
  });
});

// ─────────────────── §2.11 第四层：项目本地配置（.cmt.json）───────────────────

const PRJ_PATH = 'D:/work/a/.cmt.json';

/**
 * 造一份**归一化过的** project（真实调用链就是这么拿到的：
 * `store.readProjectConfig()` → `normalizeProjectConfig()`）。
 * 手工造对象会绕开 schema，而 schema 正是这一层唯一的安全边界。
 */
const prj = (raw) => normalizeProjectConfig({ version: 1, ...raw }, PRJ_PATH);

/** 跑一遍级联，带上项目本地层 */
const resolveP = (config, token, project, overrides = {}, extra = {}) =>
  resolveConfig({ config, token, overrides, cwd: CWD, ctx: CTX, env: {}, project, ...extra });

describe('pickTokenName —— 项目本地插在绑定之上（§2.11 三）', () => {
  test('★★ 项目本地赢过路径绑定', () => {
    // 理由（§2.11 三）：绑定按路径前缀匹配**一批**目录，而 `.cmt.json`
    // 只对它所在的那一棵树生效——更具体，所以更优先。
    const config = cfg({
      defaults: { token: 'global-tok' },
      bindings: [{ path: '/home/t/work', token: 'bound-tok' }],
    });
    const r = pickTokenName({ config, cwd: CWD, ctx: CTX, project: prj({ token: 'proj-tok' }) });
    assert.equal(r.name, 'proj-tok');
    assert.equal(r.source, 'project');
    // detail 是**文件路径**，不是目录——用户手上可能有好几份（"最近优先"），
    // 只说「项目本地」等于没说（§2.11 一）
    assert.equal(r.detail, PRJ_PATH);
  });

  test('★ --token 仍然压过项目本地（命令行是你这一下敲的）', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', token: 'bound-tok' }] });
    const r = pickTokenName({
      config,
      overrides: { token: 'cli-tok' },
      cwd: CWD,
      ctx: CTX,
      project: prj({ token: 'proj-tok' }),
    });
    assert.equal(r.name, 'cli-tok');
    assert.equal(r.source, 'cli');
  });

  test('项目本地没声明 token → 照样落到绑定（它不是"要么全用要么全不用"）', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', token: 'bound-tok' }] });
    const r = pickTokenName({ config, cwd: CWD, ctx: CTX, project: prj({ models: [{ id: 'm' }] }) });
    assert.equal(r.name, 'bound-tok');
    assert.equal(r.source, 'binding');
  });

  test('★ project 传 null / undefined 与不传等价（旧调用点不受影响）', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', token: 'bound-tok' }] });
    for (const p of [null, undefined]) {
      const r = pickTokenName({ config, cwd: CWD, ctx: CTX, project: p });
      assert.equal(r.name, 'bound-tok');
    }
  });
});

describe('★★ resolveConfig —— 项目本地赢过 binding', () => {
  const D = { id: 'd' };
  const T = { id: 't' };
  const B = { id: 'b' };
  const P = { id: 'p' };

  test('★★ models：项目本地赢过绑定，且**整体覆盖**（不拼接）', () => {
    const config = cfg({
      defaults: { models: [D] },
      bindings: [{ path: '/home/t/work', models: [B] }],
    });
    const r = resolveP(config, tok({ name: 'a', models: [T] }), prj({ models: [P] }));
    assert.deepEqual(r.models.value, [P]);
    assert.equal(r.models.source, 'project');
    assert.match(r.models.detail, /\.cmt\.json$/);
  });

  test('★ 项目本地没声明 models → 绑定照旧赢（逐键独立，不是整层开关）', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', models: [B] }] });
    const r = resolveP(config, null, prj({ env: { K: '1' } }));
    assert.deepEqual(r.models.value, [B]);
    assert.equal(r.models.source, 'binding');
  });

  test('★ 项目本地的 models: [] 是**显式空**，不是"没声明"（§2.5 规则 4）', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', models: [B] }] });
    const r = resolveP(config, null, prj({ models: [] }));
    assert.deepEqual(r.models.value, []);
    assert.equal(r.models.declared, true, '[] 必须算"已声明"，否则会被误判成缺项');
    assert.equal(r.models.source, 'project');
  });

  test('★ --model 仍然压过项目本地（提到首位，不是换掉列表）', () => {
    const config = cfg({});
    const r = resolveP(config, null, prj({ models: [{ id: 'x' }, { id: 'y' }] }), { model: 'y' });
    assert.deepEqual(r.models.value.map((m) => m.id), ['y', 'x']);
    assert.equal(r.models.source, 'cli');
  });

  test('★ resolved.project 与 projectPath 都带出来了（`cmt resolve` 要印是哪一份）', () => {
    const r = resolveP(cfg({}), null, prj({ token: 'x' }));
    assert.equal(r.projectPath, PRJ_PATH);
    assert.equal(r.project.configPath, PRJ_PATH);
  });

  test('没有项目本地配置时 projectPath 是 null（不是 undefined）', () => {
    // `cmt resolve` 用 `!== null` 判"要不要印这一行"——
    // undefined 会让那一行**永远不出现**，而症状是"我明明放了配置文件"
    assert.equal(resolve(cfg({}), null).projectPath, null);
  });
});

describe('resolveConfig —— 项目本地的 env 与 claudeArgs（§2.3 那两行）', () => {
  test('★★ env：四层按键合并，项目本地**最后盖**', () => {
    const config = cfg({
      defaults: { env: { K: 'defaults', ONLY_D: '1' } },
      bindings: [{ path: '/home/t/work', env: { K: 'binding', ONLY_B: '1' } }],
    });
    const r = resolveP(config, tok({ name: 'a', env: { K: 'token', ONLY_T: '1' } }),
      prj({ env: { K: 'project', ONLY_P: '1' } }));

    assert.equal(r.env.K.value, 'project');
    assert.equal(r.env.K.source, 'project');
    // ★ 与 models 的"整体覆盖"相反：**键一个都不丢**（§2.3 唯一的不对称）
    assert.deepEqual(Object.keys(r.env).sort(), ['K', 'ONLY_B', 'ONLY_D', 'ONLY_P', 'ONLY_T']);
    assert.equal(r.env.ONLY_D.source, 'defaults');
    assert.equal(r.env.ONLY_B.source, 'binding');
    assert.equal(r.env.ONLY_T.source, 'token');
    assert.equal(r.env.ONLY_P.source, 'project');
  });

  test('★ 项目本地的 detail 是**裸文件路径**——四层里只有它要指路', () => {
    // 另外三层的 detail 是「config.defaults」「token a」「/home/t/work」，
    // 而项目本地是**唯一**可能有好几份候选的层（"最近优先"），必须指到文件。
    //
    // ★★ 断言的是**裸路径**，不是「项目本地 <路径>」：`sourceTag()` 会把层名印在
    //    括号外面（`← 项目本地（<detail>）`），detail 里再写一遍层名就成了
    //    「← 项目本地（项目本地 C:\x\.cmt.json）」。这条同时钉住**两处 detail 同形**：
    //    另一个写法在 `pickTokenName()` 里（那条已断言 `detail === PRJ_PATH`）——
    //    两处不一致时，症状是同一份配置在 `cmt resolve` 的两行里长得不一样。
    const r = resolveP(cfg({}), null, prj({ env: { K: '1' } }));
    assert.equal(r.env.K.detail, PRJ_PATH);
    // 顺带钉住"层名在括号外面"这件事本身：detail 里**不许**再出现层名
    assert.doesNotMatch(r.env.K.detail, /项目本地/);
  });

  test('★★ claudeArgs：全局 + token + 项目本地，**低 → 高**拼接', () => {
    const config = cfg({ defaults: { claudeArgs: ['--verbose'] } });
    const r = resolveP(config, tok({ name: 'a', claudeArgs: ['--setting-sources', 'user'] }),
      prj({ claudeArgs: ['--effort', 'max'] }));
    assert.deepEqual(r.claudeArgs, [
      '--verbose',
      '--setting-sources', 'user',
      '--effort', 'max',
    ]);
  });

  test('★ 绑定层插不进 claudeArgs（§2.4 的 binding 形状里没有它，项目本地有）', () => {
    // 这条不对称是刻意的：绑定回答"用哪个身份"，项目文件回答"这个仓库怎么跑"
    assert.throws(
      () => cfg({ bindings: [{ path: '/home/t/work', claudeArgs: ['--x'] }] }),
      /未知字段 "claudeArgs"/,
    );
    assert.doesNotThrow(() => prj({ claudeArgs: ['--x'] }));
  });
});

describe('★★ 项目本地**没有**的那几层（§2.11 二/三：不是忘了接）', () => {
  test('★★ baseUrl / authToken / slots 盖不掉——但**守它的是禁键表，不是层表**', () => {
    // ★ 这条测试的写法是刻意的，理由值得写下来：
    //
    //   `buildLayers()` 把整个 project 对象当成一层塞进去，而 `pickFrom()` 是**通用**的
    //   ——谁有那个键就用谁的。所以"项目本地没有 baseUrl"**不是 resolve.js 守的**，
    //   是 `normalizeProjectConfig()` 的禁键表守的（契约 §2.11 三 原话：
    //   "不是忘了接，是那张禁键表的直接后果"）。
    //
    //   于是这里断言的是**链条的起点**：合法 project 根本造不出带这些键的对象。
    //   谁哪天把禁键表删了，这条立刻红——而它红的方式正是"外泄通道开了"。
    for (const [key, value] of [
      ['baseUrl', 'https://evil.example.com/v1'],
      ['authToken', 'sk-evil'],
      ['slots', { haiku: 'x' }],
    ]) {
      assert.throws(
        () => prj({ [key]: value }),
        /不许出现/,
        `${key} 必须在 schema 就被拒——它到不了 resolve()`,
      );
    }

    // 合法的那份跑出来，这三项的来源层里**永远不出现** 'project'
    const config = cfg({
      defaults: { authToken: 'sk-x', baseUrl: 'https://ok.example.com' },
      bindings: [{ path: '/home/t/work', baseUrl: 'https://bound.example.com', slots: { opus: 'o' } }],
    });
    const r = resolveP(config, null, prj({ token: 'a', models: [{ id: 'm' }] }));
    assert.equal(r.baseUrl.source, 'binding');
    assert.equal(r.authToken.source, 'defaults');
    assert.equal(r.baseUrl.value, 'https://bound.example.com');
    assert.equal(r.authToken.value, 'sk-x');
    assert.notEqual(r.slots.opus, undefined);
  });

  test('★★ cwd 盖不掉——这一条**是** resolve.js 结构性守住的', () => {
    // 与上一条不同：`resolveConfig()` 算 cwd 时**压根不看层表**
    // （`--cwd` → token.cwd → 进程 cwd，见 §2.3 的 cwd 行），
    // 所以就算硬塞一个 cwd 进去也无效。两条防线机制不同，都要钉住。
    const handMade = { configPath: PRJ_PATH, version: 1, cwd: '/evil' };
    const r = resolveP(cfg({}), null, /** @type {any} */ (handMade));
    assert.equal(r.cwd.value, CWD, '项目本地的 cwd 不许影响落点');
    assert.equal(r.cwd.source, 'cwd');
  });

  test('★ token.cwd 仍然有效（cwd 的级联是 --cwd → token.cwd → 进程 cwd）', () => {
    const r = resolveP(cfg({}), tok({ name: 'a', cwd: '/home/t/work/a' }), prj({ token: 'a' }));
    assert.equal(r.cwd.value, '/home/t/work/a');
    assert.equal(r.cwd.source, 'token');
  });
});

// ───────────────────────────── ${ENV_VAR} ─────────────────────────────

describe('parseEnvRef / evalEnvRef —— ${VAR} 的求值规则（§2.4）', () => {
  test('整串引用才认', () => {
    assert.deepEqual(parseEnvRef('${DEEPSEEK_API_KEY}'), { name: 'DEEPSEEK_API_KEY' });
    assert.equal(parseEnvRef('sk-${VAR}'), null);
    assert.equal(parseEnvRef('${A}${B}'), null);
    assert.equal(parseEnvRef('${1BAD}'), null);
    assert.equal(parseEnvRef('sk-abc123'), null);
    assert.equal(parseEnvRef(''), null);
  });

  test('已设置 → 取到值', () => {
    const r = evalEnvRef('${K}', { K: 'sk-real' });
    assert.equal(r.value, 'sk-real');
    assert.deepEqual(r.ref, { name: 'K' });
  });

  test('★ 未设置 → 报错并指名变量，绝不静默回退成字面量', () => {
    assert.throws(
      () => evalEnvRef('${MISSING}', {}),
      (e) => /MISSING/.test(e.message) && /未设置/.test(e.message),
    );
    // 空串等同于未设置——空 token 一样打不通
    assert.throws(() => evalEnvRef('${EMPTY}', { EMPTY: '' }), /未设置/);
  });

  test('明文原样返回，ref 为 null', () => {
    assert.deepEqual(evalEnvRef('sk-plain', {}), { value: 'sk-plain', ref: null });
  });

  test('★ 部分引用 → 报错，而不是把 ${...} 留在 token 里', () => {
    assert.throws(
      () => evalEnvRef('sk-${VAR}', { VAR: 'x' }),
      (e) => /不支持的/.test(e.message) && /只支持整串引用/.test(e.hint),
    );
  });
});

describe('resolveConfig 对 ${VAR} 只识别不求值', () => {
  test('环境变量没设置也不抛异常——cmt resolve 要能显示"未设置"', () => {
    const config = cfg({ defaults: { authToken: '${NOPE}' } });
    const r = resolve(config, null, {}, { env: {} });
    assert.equal(r.authToken.value, '${NOPE}');
    assert.deepEqual(r.authToken.ref, { name: 'NOPE', set: false });
  });

  test('设置了就标 set: true', () => {
    const config = cfg({ defaults: { authToken: '${HAVE}' } });
    const r = resolve(config, null, {}, { env: { HAVE: 'sk-x' } });
    assert.deepEqual(r.authToken.ref, { name: 'HAVE', set: true });
    assert.equal(r.authToken.value, '${HAVE}', '★ 值仍是原始引用串，不打印密钥');
  });

  test('明文 → ref 为 null', () => {
    const config = cfg({ defaults: { authToken: 'sk-plain' } });
    assert.equal(resolve(config, null).authToken.ref, null);
  });
});

describe('resolveConfig —— baseUrl 的 ${VAR} 引用（§2.4）', () => {
  test('环境变量没设置也不抛异常——cmt resolve 要能显示"未设置"', () => {
    const config = cfg({ defaults: { baseUrl: '${RELAY_BASE_URL}' } });
    const r = resolve(config, null, {}, { env: {} });
    assert.equal(r.baseUrl.value, '${RELAY_BASE_URL}');
    assert.deepEqual(r.baseUrl.ref, { name: 'RELAY_BASE_URL', set: false });
  });

  test('设置了就标 set: true，且 value 仍是引用原文', () => {
    const config = cfg({ defaults: { baseUrl: '${RELAY_BASE_URL}' } });
    const r = resolve(config, null, {}, { env: { RELAY_BASE_URL: 'https://relay.example.com' } });
    assert.deepEqual(r.baseUrl.ref, { name: 'RELAY_BASE_URL', set: true });
    assert.equal(r.baseUrl.value, '${RELAY_BASE_URL}', '★ resolve 阶段不求值，端点只在启动时取');
  });

  test('空串等同未设置（空端点一样打不通）', () => {
    const config = cfg({ defaults: { baseUrl: '${RELAY_BASE_URL}' } });
    const r = resolve(config, null, {}, { env: { RELAY_BASE_URL: '' } });
    assert.equal(r.baseUrl.ref.set, false);
  });

  test('明文 baseUrl → ref 为 null（别把所有 URL 都当引用）', () => {
    const config = cfg({ defaults: { baseUrl: 'https://api.example' } });
    assert.equal(resolve(config, null).baseUrl.ref, null);
  });

  test('★ --url 也吃引用：识别发生在级联之后的最终值上', () => {
    const config = cfg({});
    const r = resolve(config, null, { baseUrl: '${CLI_URL}' }, { env: { CLI_URL: 'https://x' } });
    assert.equal(r.baseUrl.source, 'cli');
    assert.deepEqual(r.baseUrl.ref, { name: 'CLI_URL', set: true });
  });

  test('authToken 与 baseUrl 各自独立判定', () => {
    const config = cfg({ defaults: { authToken: '${K}', baseUrl: '${U}' } });
    const r = resolve(config, null, {}, { env: { K: 'sk-x' } });
    assert.deepEqual(r.authToken.ref, { name: 'K', set: true });
    assert.deepEqual(r.baseUrl.ref, { name: 'U', set: false });
  });
});

describe('buildInjection —— baseUrl 求值（§2.4）', () => {
  test('引用设了 → 注入求值后的真 URL，不是字面量', () => {
    const r = inject(base({ baseUrl: '${RELAY_BASE_URL}' }), { RELAY_BASE_URL: 'https://relay.example.com' });
    assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://relay.example.com');
    assert.equal(r.unresolved.length, 0);
  });

  test('★ 引用没设 → 不注入，且记下原因（绝不塞字面量 `${...}`）', () => {
    const r = inject(base({ baseUrl: '${RELAY_BASE_URL}' }));
    assert.equal('ANTHROPIC_BASE_URL' in r.env, false);
    const u = r.unresolved.find((x) => x.envVar === 'ANTHROPIC_BASE_URL');
    assert.ok(u, 'unresolved 里要有一条 ANTHROPIC_BASE_URL');
    assert.match(u.reason, /RELAY_BASE_URL/);
  });

  test('★ 部分引用（拼接）→ 同样不注入，且报"只支持整串引用"', () => {
    const r = inject(base({ baseUrl: 'https://${HOST}/v1' }), { HOST: 'relay.example.com' });
    assert.equal('ANTHROPIC_BASE_URL' in r.env, false);
    assert.match(r.unresolved.find((x) => x.envVar === 'ANTHROPIC_BASE_URL').reason, /不支持的/);
  });

  test('明文 baseUrl 原样注入，不进 unresolved', () => {
    const r = inject(base({ baseUrl: 'https://api.example' }));
    assert.equal(r.env.ANTHROPIC_BASE_URL, 'https://api.example');
    assert.equal(r.unresolved.some((x) => x.envVar === 'ANTHROPIC_BASE_URL'), false);
  });

  test('完全没有 baseUrl → 不注入，且记一条（缺端点比缺 token 更隐蔽）', () => {
    const r = inject(base({}));
    assert.equal('ANTHROPIC_BASE_URL' in r.env, false);
    assert.match(
      r.unresolved.find((x) => x.envVar === 'ANTHROPIC_BASE_URL').reason,
      /没有任何一层提供 baseUrl/,
    );
  });
});

// ─────────────────── §2.6 继承环境的净化（会话标记 + unset）───────────────────

describe('stripSessionMarkers —— 会话标记一个不留（§2.6）', () => {
  test('9 个标记全剔', () => {
    /** @type {Record<string, string>} */
    const env = {};
    for (const k of SESSION_MARKER_ENV) env[k] = 'x';
    assert.deepEqual(stripSessionMarkers(env), {});
  });

  test('★ PATH / HOME / ANTHROPIC_MODEL / 配置类 CLAUDE_CODE_* 一个不动', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/t',
      ANTHROPIC_MODEL: '父会话的模型',
      ANTHROPIC_AUTH_TOKEN: '父会话的 token',
      // 判据是"身份 vs 配置"（§2.6）：这几个描述的是**配置**，剔掉反而是错的
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432',
      CLAUDE_CODE_DISABLE_AUTOUPDATER: '1',
    };
    assert.deepEqual(stripSessionMarkers(env), env);
  });

  test('★ 不改入参——入参就是 process.env 本身（ctx.env 按引用传进来）', () => {
    const live = { PATH: '/usr/bin', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ID: 'abc' };
    const out = stripSessionMarkers(live);
    assert.equal('CLAUDE_CODE_CHILD_SESSION' in out, false, '返回值要干净');
    assert.equal(live.CLAUDE_CODE_CHILD_SESSION, '1', '原对象必须原封不动');
    assert.equal(live.CLAUDE_CODE_SESSION_ID, 'abc');
    assert.notEqual(out, live, '必须是新对象，不能是同一个引用');
  });

  test('容忍 undefined 值（process.env 上确实会有）', () => {
    const out = stripSessionMarkers({ PATH: '/usr/bin', CLAUDE_PID: undefined, K: undefined });
    assert.deepEqual(out, { PATH: '/usr/bin', K: undefined });
  });
});

describe('buildSessionEnv —— 继承 → 删 unset → 盖注入（§2.6）', () => {
  /** 一次算好的注入项，几条用例共用 */
  const injection = () => buildInjection(resolve(cfg(base({})), null), { home: '/home/t' });

  test('★ 头号不变量：结果不取决于"是从哪儿被调用的"', () => {
    // 同一个干净环境，一份原样、一份掺上 Claude Code 的整套会话标记（§7.7 实测的那一套）。
    // 两者的 buildSessionEnv 结果**必须一模一样**——这条直接编码用户报的那个 bug：
    // 从 Claude Code 会话里跑 `cmt run`，新会话不该知道自己在谁的会话里被拉起。
    const clean = { PATH: '/usr/bin', HOME: '/home/t', LANG: 'zh_CN.UTF-8' };
    /** @type {Record<string, string>} */
    const polluted = { ...clean };
    for (const k of SESSION_MARKER_ENV) polluted[k] = '父会话的值';
    polluted.CLAUDE_CODE_MESSAGING_SOCKET = '\\\\.\\pipe\\LOCAL\\cc-msg-abc';

    assert.deepEqual(
      buildSessionEnv({ base: polluted, injection: injection() }),
      buildSessionEnv({ base: clean, injection: injection() }),
    );
  });

  test('配置类的 CLAUDE_CODE_* 照旧继承（判据：身份 vs 配置）', () => {
    const env = buildSessionEnv({
      base: {
        PATH: '/usr/bin',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
        CLAUDE_CODE_DISABLE_AUTOUPDATER: '1',
      },
      injection: injection(),
    });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'max');
    assert.equal(env.CLAUDE_CODE_DISABLE_AUTOUPDATER, '1');
  });

  test('★ unset 里那一项，继承来的值真的没了', () => {
    // `authMode: "token"`（默认）→ unset 含 ANTHROPIC_API_KEY。
    // 留着它本不致命，但 §7.2 的优先级是 AUTH_TOKEN 压过 API_KEY，
    // 反过来的那一半（authMode: "key"）才是真要命的，两条一起钉住。
    const env = buildSessionEnv({
      base: { ANTHROPIC_API_KEY: '父会话的 key', ANTHROPIC_AUTH_TOKEN: '父会话的 token' },
      injection: injection(),
    });
    assert.equal('ANTHROPIC_API_KEY' in env, false);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-x', '注入项要盖过继承来的同名值');
  });

  test('★ 先删后盖：env 逃生舱能盖过 unset（顺序反了就会静默失效）', () => {
    const raw = base({ models: [], env: { ANTHROPIC_MODEL: '手写的' } });
    const inj = buildInjection(resolve(cfg(raw), null), { home: '/home/t' });
    assert.ok(inj.unset.includes('ANTHROPIC_MODEL'), 'models: [] 时 ANTHROPIC_MODEL 在 unset 里');
    const env = buildSessionEnv({ base: { ANTHROPIC_MODEL: '父会话的模型' }, injection: inj });
    assert.equal(env.ANTHROPIC_MODEL, '手写的', '逃生舱最后生效');
  });

  test('★★ 空串的另一半：继承来的那个变量在最终环境里**真的没了**', () => {
    // 上一层的兄弟用例（buildInjection —— unset）只证明"进了 unset"，
    // 这里证明它一路走到 spawn 面前时确实不在。中间隔着 buildSessionEnv 的合并。
    const inj = buildInjection(resolve(cfg(base({ env: { FOO: '' } })), null), { home: '/home/t' });
    const env = buildSessionEnv({ base: { FOO: '父进程的', BAR: '照常继承' }, injection: inj });
    assert.equal('FOO' in env, false);
    assert.equal(env.BAR, '照常继承', '删一个不该殃及其他');
  });

  test('不改 base', () => {
    const live = { PATH: '/usr/bin', CLAUDE_CODE_CHILD_SESSION: '1' };
    buildSessionEnv({ base: live, injection: injection() });
    assert.equal(live.CLAUDE_CODE_CHILD_SESSION, '1');
  });
});

describe('buildInjection —— unset（"不注入"也要把继承来的删掉，§2.6）', () => {
  const unsetOf = (raw) =>
    buildInjection(resolve(cfg(raw), null, {}, { env: {} }), { home: '/home/t' }).unset.sort();

  test('★ 没选中的认证变量一定在 unset 里', () => {
    // §7.2 的优先级是 AUTH_TOKEN 压过 API_KEY。authMode: "key" 时若继承来一个
    // AUTH_TOKEN，**它会赢**——配的是 key，跑的却是别人的 token。所以这一条是必需的。
    assert.deepEqual(unsetOf(base({})), ['ANTHROPIC_API_KEY']);
    assert.deepEqual(unsetOf(base({ authMode: 'key' })), ['ANTHROPIC_AUTH_TOKEN']);
  });

  test('★ models: [] → ANTHROPIC_MODEL + 全部 5 个槽变量', () => {
    assert.deepEqual(unsetOf(base({ models: [] })), [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      ...Object.values(SLOT_ENV),
    ].sort());
  });

  test('显式 null 的槽只删它自己（其余槽照常注入）', () => {
    assert.deepEqual(unsetOf(base({ slots: { opus: null } })), [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_DEFAULT_OPUS_MODEL',
    ]);
  });

  test('★ 普通配置不含任何槽变量（别把"默认填 models[0]"误删成 unset）', () => {
    const unset = unsetOf(base({}));
    for (const varName of Object.values(SLOT_ENV)) {
      assert.equal(unset.includes(varName), false, `${varName} 不该在 unset 里`);
    }
  });

  test('cmt 不管理的 ANTHROPIC_* 不进 unset（那张表无边界）', () => {
    const unset = unsetOf(base({}));
    assert.equal(unset.includes('ANTHROPIC_CUSTOM_HEADERS'), false);
    assert.equal(unset.includes('ANTHROPIC_PROFILE'), false);
    assert.equal(unset.includes('ANTHROPIC_BASE_URL'), false);
  });

  test('★★ `env: {FOO: ""}` 是第四个 unset 来源——空串 = 删，不是注入空值（§2.6）', () => {
    // 同一个配置在 Windows 上"删掉了"，在 POSIX 上却是**真的空值**：语义不能随平台漂。
    // 而且这是 `env` 唯一能**减**变量的通道——`wt.exe` 会把调用方的整套环境原样转发
    // 进新标签页（§7.7），没有它就没法把父会话漏进来的东西请出去。
    const inj = buildInjection(resolve(cfg(base({ env: { FOO: '' } })), null), { home: '/home/t' });
    assert.ok(inj.unset.includes('FOO'), '空串必须进 unset');
    assert.equal('FOO' in inj.env, false, '★ 空串不许写进 env —— 写进去在两个平台上就是两种语义');
  });

  test('★★ 空串撤得掉前面几步已经写进去的键（槽位默认值也照撤）', () => {
    // 槽位推导在 env 逃生舱**之前**跑：只"不写"是不够的，得把已经写进去的那份删掉，
    // 否则"删"会被自己的默认值盖回来。
    const inj = buildInjection(
      resolve(cfg(base({ env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: '' } })), null),
      { home: '/home/t' },
    );
    assert.equal('ANTHROPIC_DEFAULT_HAIKU_MODEL' in inj.env, false);
    assert.ok(inj.unset.includes('ANTHROPIC_DEFAULT_HAIKU_MODEL'));
    // 其余槽照常注入（只删点名的那个）
    assert.equal(inj.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'm');
  });
});
