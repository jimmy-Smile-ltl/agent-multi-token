// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { SOURCE, buildInjection, buildSessionEnv, resolve, resolveCwd, stripSessionMarkers, SESSION_MARKER_ENV } from '../src/core/resolve.js';
import { assertArgvConsistent, assertComplete, assertPickUsable } from '../src/core/validate.js';
import { evaluateSecretRef, parseSecretRef } from '../src/core/schema.js';

// ───────────────────────────── 夹具 ─────────────────────────────

const CWD = 'D:/work/client-a';

const DEFAULTS = {
  authToken: '${DEEPSEEK_API_KEY}',
  baseUrl: 'https://api.deepseek.com/',
  wireApi: 'responses',
  models: [{ id: 'deepseek-flash', label: 'Flash 1M' }, { id: 'deepseek-v4-pro' }],
  env: { RUST_LOG: 'warn', SHARED: 'from-defaults' },
  codexArgs: ['--no-alt-screen'],
  terminalMode: 'tab',
};

const TOKEN_A = {
  name: 'relay-a',
  authToken: 'sk-a',
  baseUrl: 'https://a.example.com/',
  cwd: 'D:/work/from-token',
  models: [{ id: 'a-model' }],
  env: { SHARED: 'from-token', A_ONLY: '1' },
  codexArgs: ['--profile', 'a'],
};

const CONFIG = {
  version: 1,
  defaults: DEFAULTS,
  bindings: [
    { path: 'D:/work', token: 'relay-a' },
    { path: 'D:/work/client-a', token: 'relay-b', baseUrl: 'https://b.example.com/', env: { SHARED: 'from-binding' } },
  ],
};

const TOKENS = { 'relay-a': TOKEN_A, 'relay-b': { name: 'relay-b', authToken: 'sk-b' } };

/**
 * 项目本地配置（§2.13）——`normalizeProjectConfig()` 的产物。
 * ⚠️ 形状必须与那个函数一致：`configPath` 是**产物的一部分**（报错点名 + `SOURCE.PROJECT` 的 detail）。
 */
const PROJECT = {
  configPath: 'D:/work/client-a/.cxt.json',
  version: 1,
  token: 'relay-a',
  models: [{ id: 'proj-model' }],
  env: { SHARED: 'from-project', P_ONLY: '1' },
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
  codexArgs: ['--project-flag'],
};

/** 默认调用：走 `run` 入口，cwd 落在最深的绑定里 */
function R(over = {}) {
  return resolve({ config: CONFIG, tokens: TOKENS, cwd: CWD, argv: {}, entry: 'run', platform: 'win32', ...over });
}

/** 带项目本地配置的调用 */
function RP(project = PROJECT, over = {}) {
  return R({ project, ...over });
}

const S = (r, field) => `${r[field].source}:${JSON.stringify(r[field].value)}`;

// ═══════════════ ★★ entry 分叉（§2.3 第五条）═══════════════

describe('★★ cwd 的入口分叉——本模块最该钉死的一条', () => {
  test('★ run：token.cwd 生效（弹新窗口，没有既有上下文可矛盾）', () => {
    const r = R({ entry: 'run', argv: { token: 'relay-a' } });
    assert.equal(r.cwd.value, 'D:/work/from-token');
    assert.equal(r.cwd.source, SOURCE.TOKEN);
  });

  test('★★ exec：**同一个 token、同一个 cwd**，结果却是进程目录——token.cwd 被跳过', () => {
    const r = R({ entry: 'exec', argv: { token: 'relay-a' } });
    assert.equal(r.cwd.value, CWD, 'exec 绝不能把人从当前目录拽走');
    assert.equal(r.cwd.source, SOURCE.PROCESS);
  });

  test('★ 两个入口在同一个输入上给出**不同**的 cwd（否则分叉没生效）', () => {
    const argv = { token: 'relay-a' };
    const run = R({ entry: 'run', argv });
    const exec = R({ entry: 'exec', argv });
    assert.notEqual(run.cwd.value, exec.cwd.value);
  });

  test('★ --cwd 在两个入口下都赢（它比 token.cwd 优先级高）', () => {
    for (const entry of /** @type {const} */ (['run', 'exec'])) {
      const r = R({ entry, argv: { cwd: 'D:/explicit', token: 'relay-a' } });
      assert.equal(r.cwd.value, 'D:/explicit');
      assert.equal(r.cwd.source, SOURCE.CLI);
    }
  });

  test('★ exec 且没有 --cwd 时，连 token 都不看（不是"看了但不用"）', () => {
    // token 没有 cwd 字段时两者本就相同——真正的分叉在"token 有 cwd"时（上面已测）
    const r = R({ entry: 'exec', argv: { token: 'relay-b' } });
    assert.equal(r.cwd.value, CWD);
  });

  test('★ exec 跳过 token.cwd 时给出告警（静默换目录 = 静默续错会话）', () => {
    const r = R({ entry: 'exec', argv: { token: 'relay-a' } });
    assert.ok(r.warnings.some((w) => w.code === 'token-cwd-skipped'),
      '不能默默忽略——用户配了 token.cwd 却在 exec 下没生效，必须说');
  });

  test('run 下**不**报这条告警（它本来就生效）', () => {
    const r = R({ entry: 'run', argv: { token: 'relay-a' } });
    assert.ok(!r.warnings.some((w) => w.code === 'token-cwd-skipped'));
  });

  test('resolveCwd 独立可调（契约点名了这个函数名）', () => {
    assert.equal(resolveCwd({ argv: {}, token: TOKEN_A, cwd: CWD }, 'run').value, 'D:/work/from-token');
    assert.equal(resolveCwd({ argv: {}, token: TOKEN_A, cwd: CWD }, 'exec').value, CWD);
  });

  test('★ entry 缺失 / 非法 → 抛错，**绝不默认成某个入口**', () => {
    for (const bad of [undefined, null, '', 'RUN', 'Run', 'window', 0, false]) {
      assert.throws(() => resolveCwd({ cwd: CWD }, /** @type {any} */ (bad)),
        (err) => err.code === 1 && /entry/.test(err.message), `entry=${JSON.stringify(bad)} 应被拒`);
    }
  });

  test('★ entry 非法时 resolve() 同样拒绝（不给默认值 = 不留静默错路）', () => {
    assert.throws(() => resolve({ config: CONFIG, tokens: TOKENS, cwd: CWD, argv: {} }),
      (err) => /entry/.test(err.message));
  });
});

// ═══════════════ token 选择级联 ═══════════════

describe('★ token 级联：--token → 绑定 → defaults.token → 无（§2.3）', () => {
  test('--token 最优先，压过绑定', () => {
    const r = R({ argv: { token: 'relay-a' } });   // 该目录绑的是 relay-b
    assert.equal(r.token.value, 'relay-a');
    assert.equal(r.token.source, SOURCE.CLI);
  });

  test('没给 --token → 用绑定命中的那个', () => {
    const r = R();
    assert.equal(r.token.value, 'relay-b');
    assert.equal(r.token.source, SOURCE.BINDING);
    assert.equal(r.bindingPath, 'D:/work/client-a');
  });

  test('★ 绑定取**最长前缀**：client-a 赢过 work', () => {
    assert.equal(R({ cwd: 'D:/work/client-a/src' }).token.value, 'relay-b');
    assert.equal(R({ cwd: 'D:/work/other' }).token.value, 'relay-a');
  });

  test('没绑定的目录 → defaults.token', () => {
    const config = { ...CONFIG, defaults: { ...DEFAULTS, token: 'relay-a' } };
    const r = resolve({ config, tokens: TOKENS, cwd: 'D:/elsewhere', argv: {}, entry: 'run', platform: 'win32' });
    assert.equal(r.token.value, 'relay-a');
    assert.equal(r.token.source, SOURCE.DEFAULTS);
  });

  test('★ 三层都没有 → 纯 defaults 模式（token = null，不是报错）', () => {
    const r = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: TOKENS, cwd: 'D:/elsewhere', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.token.value, null);
    assert.equal(r.token.source, SOURCE.NONE);
    assert.equal(r.profileName, '_default', '无 token 落到保留名 _default（§2.3）');
  });

  test('★★ 绑定匹配用**调用时的 cwd**，不是 token.cwd（拿它去匹配会成环）', () => {
    // relay-a 的 token.cwd 是 D:/work/from-token，它在 D:/work 绑定之下。
    // 若用 token.cwd 匹配，就会命中 relay-a 自己 → 自证循环。
    const r = R({ argv: { token: 'relay-a' } });
    assert.equal(r.bindingPath, 'D:/work/client-a', '绑定仍按调用目录 client-a 算');
    assert.equal(r.callCwd, CWD);
  });

  test('★ --cwd 参与绑定匹配（它是"调用时的 cwd"）', () => {
    const r = R({ argv: { cwd: 'D:/work/client-a' } });
    assert.equal(r.bindingPath, 'D:/work/client-a');
  });

  test('★ token 名指向不存在的文件 → 立刻抛错，不静默降级成"无 token"', () => {
    assert.throws(
      () => R({ argv: { token: 'typo' } }),
      (err) => err.code === 1 && /typo/.test(err.message) && /不存在/.test(err.message),
    );
  });

  test('不存在时的 hint 给出创建命令', () => {
    try {
      R({ argv: { token: 'typo' } });
      assert.fail('应当抛错');
    } catch (err) {
      assert.match(/** @type {any} */ (err).hint, /cxt token add typo/);
    }
  });

  test('★★ token 名**先校验再查表**：路径穿越必须报"名字非法"，不是"不存在"', () => {
    // 补这条的理由：不校验的话 `--token ../etc` 会走到"查表没查到 → 报不存在"，
    // 于是安全性**碰巧成立**（没查到就不会去拼路径），但报错信息会建议用户
    // `cxt token add ../etc ...`——既误导，又把安全押在"表里恰好没有"上。
    // token 名会变成目录名（profiles/<name>/），这里必须结构性拦住。
    for (const bad of ['../etc', '..', 'a/b', 'a\\b', 'C:evil', 'a\0b', 'NUL']) {
      assert.throws(
        () => R({ argv: { token: bad } }),
        (err) => err.code === 1
          && !/不存在/.test(err.message)
          && /(路径分隔符|不合法|保留设备名)/.test(err.message),
        `${JSON.stringify(bad)} 应当报"名字非法"而不是"不存在"`,
      );
    }
  });

  test('★ 大写 / 超长 / 空串同样拦在查表之前', () => {
    for (const bad of ['Relay-A', 'a'.repeat(33), '']) {
      assert.throws(() => R({ argv: { token: bad } }), (err) => err.code === 1);
    }
  });

  test('合法名字照常走查表（校验没有误伤）', () => {
    // relay-a 在 TOKENS 里，应当正常解析出来而不是被校验拦掉
    assert.equal(R({ argv: { token: 'relay-a' } }).token.value, 'relay-a');
  });
});

// ═══════════════ 各项的覆盖顺序 ═══════════════

describe('★ 四要素的覆盖顺序（§2.3 的表）', () => {
  test('baseUrl：--url → 绑定 → token → defaults', () => {
    assert.equal(R({ argv: { url: 'https://cli.example/' } }).baseUrl.value, 'https://cli.example/');
    assert.equal(R({ argv: { url: 'https://cli.example/' } }).baseUrl.source, SOURCE.CLI);

    // ★ 绑定层比 token 层更具体：即使显式 --token relay-a，绑定自带的 baseUrl 仍然赢
    assert.equal(R({ argv: { token: 'relay-a' } }).baseUrl.value, 'https://b.example.com/');
    assert.equal(R({ argv: { token: 'relay-a' } }).baseUrl.source, SOURCE.BINDING);

    // 离开绑定目录 → token 自己的 baseUrl
    const r = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: TOKENS, cwd: 'D:/x', argv: { token: 'relay-a' }, entry: 'run', platform: 'win32',
    });
    assert.equal(r.baseUrl.value, 'https://a.example.com/');
    assert.equal(r.baseUrl.source, SOURCE.TOKEN);

    // 都没有 → defaults
    const r2 = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r2.baseUrl.value, 'https://api.deepseek.com/');
    assert.equal(r2.baseUrl.source, SOURCE.DEFAULTS);
  });

  test('★★ `--token` 只换身份，**不换绑定提供的 baseUrl**——但这会混用，必须告警', () => {
    // 这是本表最容易踩的一脚：relay-a 的 key 配 relay-b 绑定的 URL。
    // 契约 §2.3 的表就是这么定的（绑定比 token 具体），但静默混用是安全坑。
    const r = R({ argv: { token: 'relay-a' } });
    assert.equal(r.token.value, 'relay-a');
    assert.equal(r.baseUrl.value, 'https://b.example.com/');
    assert.ok(r.warnings.some((w) => w.code === 'explicit-token-mixed-with-binding'),
      '身份来自 --token、地址来自绑定 → 必须提示，不能静默');
  });

  test('不混用时不报这条告警（否则天天响）', () => {
    assert.ok(!R().warnings.some((w) => w.code === 'explicit-token-mixed-with-binding'));
  });

  test('authToken：--token-value → 绑定 → token → defaults', () => {
    assert.equal(R({ argv: { tokenValue: 'sk-cli' } }).authToken.source, SOURCE.CLI);
    assert.equal(R().authToken.value, 'sk-b');            // 绑定 → token relay-b
    assert.equal(R({ argv: { token: 'relay-a' } }).authToken.value, 'sk-a');
  });

  test('★ authToken 与 token（名字）是两件事，别混（§2.3）', () => {
    const r = R({ argv: { token: 'relay-a', tokenValue: 'sk-override' } });
    assert.equal(r.token.value, 'relay-a', '--token 选身份');
    assert.equal(r.authToken.value, 'sk-override', '--token-value 改凭证');
  });

  test('providerId：绑定 → token → **派生**', () => {
    const derived = R({ argv: { token: 'relay-a' } });
    assert.equal(derived.providerId.value, 'cxt-relay-a');
    assert.equal(derived.providerId.source, SOURCE.DERIVED);

    const explicit = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: { t: { name: 't', providerId: 'my-own' } },
      cwd: 'D:/x', argv: { token: 't' }, entry: 'run', platform: 'win32',
    });
    assert.equal(explicit.providerId.value, 'my-own');
    assert.equal(explicit.providerId.source, SOURCE.TOKEN);
  });

  test('★ 无 token 时 providerId 派生为 cxt-default（不是 undefined）', () => {
    const r = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.providerId.value, 'cxt-default');
  });

  test('wireApi：… → 内置 "responses"', () => {
    const r = resolve({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.wireApi.value, 'responses');
    assert.equal(r.wireApi.source, SOURCE.BUILTIN);
  });

  test('★ catalog：绑定 → token → defaults（可选，缺了不是错）', () => {
    const r = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: { t: { name: 't', catalog: '~/c.json' } },
      cwd: 'D:/x', argv: { token: 't' }, entry: 'run', platform: 'win32',
    });
    assert.equal(r.catalog.value, '~/c.json');
    assert.equal(r.catalog.source, SOURCE.TOKEN);
    assert.ok(!r.missing.includes('catalog'), 'catalog 不是四要素之一');
  });
});

// ═══════════════ models / model ═══════════════

describe('★ models：整体覆盖，不合并（§2.5）', () => {
  test('绑定 → token → defaults，命中即整体替换', () => {
    assert.deepEqual(R({ argv: { token: 'relay-a' } }).models.value.map((m) => m.id), ['a-model']);
  });

  test('★ 不是并集（并集会让"只用 a-model"无法表达）', () => {
    const r = R({ argv: { token: 'relay-a' } });
    assert.ok(!r.models.value.some((m) => m.id === 'deepseek-flash'), '不该混进 defaults 的候选');
  });

  test('model 取 models[0]（优先级最高项）', () => {
    const r = R({ argv: { token: 'relay-a' } });
    assert.equal(r.model.value.id, 'a-model');
    assert.equal(r.model.source, SOURCE.TOKEN);
  });

  test('★ --model 走 CLI 差量，来源标 cli', () => {
    const r = R({ argv: { model: 'one-off' } });
    assert.equal(r.model.value.id, 'one-off');
    assert.equal(r.model.source, SOURCE.CLI);
    assert.deepEqual(r.models.value, R().models.value,
      '--model 只换本次的 model，**不动**优先级列表');
  });

  test('★ label 跟着 model 一起出来（展示要用）', () => {
    const r = R({ argv: { model: 'x' } });
    assert.equal(r.model.value.label, undefined);
    const r2 = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r2.model.value.label, 'Flash 1M');
  });
});

describe('★ 显式空 `[]` vs 没声明（§2.3 的表）', () => {
  const base = { version: 1, defaults: DEFAULTS, bindings: [] };

  test('三层都没声明 → **缺项**，四要素不齐', () => {
    const r = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, models: undefined }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.model.value, null);
    assert.ok(r.missing.includes('model'));
  });

  test('★★ 某层显式写 `[]` → **合法**，四要素齐全（不注入模型，用 Codex 自身默认）', () => {
    const r = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, models: [] }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.model.value, null);
    assert.equal(r.model.explicitEmpty, true);
    assert.ok(!r.missing.includes('model'), '显式空不是缺项——这两件事必须分开');
    assert.equal(r.missing.length, 0);
  });

  test('★ `[]` 在绑定层也能压掉下层（整体覆盖的必然结果）', () => {
    const r = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [{ path: 'D:/x', models: [] }] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.model.explicitEmpty, true);
    assert.deepEqual(r.models.value, []);
  });

  test('★ `--model` 能在 `[]` 之上给出模型（差量压过一切文件层）', () => {
    const r = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, models: [] }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: { model: 'm' }, entry: 'run', platform: 'win32',
    });
    assert.equal(r.model.value.id, 'm');
    assert.equal(r.missing.length, 0);
  });

  test('★ 空数组**不会**被当成"没说话"而继续往上继承', () => {
    const r = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [{ path: 'D:/x', models: [] }] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.notDeepEqual(r.models.value?.map((m) => m.id), ['deepseek-flash'],
      '继承会得到 defaults 的列表，那是错的');
  });
});

// ═══════════════ env / codexArgs ═══════════════

describe('★ env：三层**按键合并**（与 models 的整体覆盖刻意不同）', () => {
  test('三层各出各的键', () => {
    const r = R();
    assert.equal(r.env.value.RUST_LOG, 'warn');   // defaults
    assert.equal(r.env.value.A_ONLY, undefined);  // relay-b 没有
  });

  test('★ 同名键：绑定 > token > defaults', () => {
    const r = R();
    assert.equal(r.env.value.SHARED, 'from-binding');
    assert.equal(r.env.sources.SHARED, SOURCE.BINDING);
  });

  test('★ 每键记来源（`cxt resolve` 要能说清"这个变量谁设的"）', () => {
    // 绑定 relay-b 声明了 SHARED → 绑定层最具体，赢过 token 与 defaults
    const r = R({ argv: { token: 'relay-a' } });
    assert.equal(r.env.value.SHARED, 'from-binding');
    assert.equal(r.env.sources.SHARED, SOURCE.BINDING);
    assert.equal(r.env.sources.RUST_LOG, SOURCE.DEFAULTS);

    // 离开绑定目录 → token 层才露出来
    const r2 = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: TOKENS, cwd: 'D:/x', argv: { token: 'relay-a' }, entry: 'run', platform: 'win32',
    });
    assert.equal(r2.env.value.SHARED, 'from-token');
    assert.equal(r2.env.sources.SHARED, SOURCE.TOKEN);
    assert.equal(r2.env.value.A_ONLY, '1');
  });

  test('都没有 → null（不是空对象——"没设"与"设成空"要能区分）', () => {
    const r = resolve({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.env.value, null);
    assert.equal(r.env.source, SOURCE.NONE);
  });
});

describe('★ codexArgs：**拼接**（低 → 高），命令行 `--` 在最后', () => {
  test('defaults + token 依次排', () => {
    const r = R({ argv: { token: 'relay-a' } });
    assert.deepEqual(r.codexArgs.value, ['--no-alt-screen', '--profile', 'a']);
  });

  test('★ 命令行 `--` 追加在最后（排后面才能压过前面的同名参数）', () => {
    const r = R({ argv: { token: 'relay-a', extraArgs: ['--model', 'x'] } });
    assert.deepEqual(r.codexArgs.value, ['--no-alt-screen', '--profile', 'a', '--model', 'x']);
  });

  test('★ 不是覆盖——低层的开关不会因为高层有而消失', () => {
    const r = R({ argv: { token: 'relay-a' } });
    assert.ok(r.codexArgs.value.includes('--no-alt-screen'));
  });

  test('都没有 → null', () => {
    const r = resolve({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.codexArgs.value, null);
  });
});

// ═══════════════ ★★ 第四层：项目本地配置（§2.13）═══════════════

describe('★★ 项目本地配置：级联的第四层，插在 CLI 之下、绑定之上', () => {
  test('★★ 项目本地赢过绑定（这一层的全部意义）', () => {
    // 夹具里 cwd = D:/work/client-a 命中的是绑定 relay-b；项目文件说 relay-a。
    // 契约 §2.13 三：项目本地比绑定具体——它就是这个目录自己的声明。
    const r = RP();
    assert.equal(r.token.value, 'relay-a');
    assert.equal(r.token.source, SOURCE.PROJECT);
  });

  test('★ detail 点名**是哪一份** .cxt.json 赢了（光说"项目本地"等于没说）', () => {
    assert.equal(RP().token.detail, `项目本地 ${PROJECT.configPath}`);
  });

  test('★ 结果里带 project 与 projectPath（面板与 `cxt resolve` 都要用）', () => {
    const r = RP();
    assert.equal(r.project, PROJECT);
    assert.equal(r.projectPath, PROJECT.configPath);
  });

  test('★ models / sandboxMode / approvalPolicy / env / codexArgs 都多出这一层', () => {
    const r = RP();
    assert.deepEqual(r.models.value, [{ id: 'proj-model' }]);
    assert.equal(r.models.source, SOURCE.PROJECT);
    assert.equal(r.sandboxMode.value, 'danger-full-access');
    assert.equal(r.sandboxMode.source, SOURCE.PROJECT);
    assert.equal(r.approvalPolicy.value, 'never');
    assert.equal(r.approvalPolicy.source, SOURCE.PROJECT);
    assert.equal(r.env.value.SHARED, 'from-project');
    assert.ok(r.codexArgs.value.includes('--project-flag'));
  });

  test('★ 没有项目配置时一切照旧（`undefined` 与 `null` 同义 = 这一层没说话）', () => {
    const a = R();
    const b = R({ project: null });
    const c = R({ project: undefined });
    assert.deepEqual(a, b);
    assert.deepEqual(a, c);
    assert.equal(a.projectPath, null);
    assert.equal(a.project, null);
  });
});

describe('★★ 项目本地**没有**哪几条链（§2.13 二）——反向断言', () => {
  // 这组测试全部**手工构造**一个带禁键的 project 对象：它绕过了
  // `normalizeProjectConfig()` 的禁键表（那是第一道防线），
  // 这里要证明**级联本身**也没有这些行——第二道防线。
  // 少了它，将来有人"顺手"在 resolve.js 里补一行 `at(project, 'baseUrl')`
  // 就再也拦不住了：schema 会拒，但只要有**任何**别的路径喂进来一个 project 对象
  // （比如将来的插件、测试夹具、面板），key 就跑到 evil.com 去了。
  const EVIL = 'https://evil.example.com/v1';

  test('★★ baseUrl 盖不掉——这是外泄通道，不是"不方便"', () => {
    const r = RP({ ...PROJECT, baseUrl: EVIL });
    assert.notEqual(r.baseUrl.value, EVIL);
    assert.equal(r.baseUrl.value, 'https://b.example.com/');   // 仍然是绑定给的
    assert.equal(r.baseUrl.source, SOURCE.BINDING);
  });

  test('★★ authToken 盖不掉——token 只有一个落盘点（§2.7）', () => {
    const r = RP({ ...PROJECT, authToken: 'sk-stolen' });
    assert.notEqual(r.authToken.value, 'sk-stolen');
    assert.equal(r.authToken.value, 'sk-a');                   // 仍然来自 token relay-a
  });

  test('★ wireApi 盖不掉——它与 baseUrl 同属目的地描述符', () => {
    const r = RP({ ...PROJECT, wireApi: 'chat' });
    assert.equal(r.wireApi.value, 'responses');
    assert.equal(r.wireApi.source, SOURCE.DEFAULTS);
  });

  test('★ cwd 盖不掉——这份文件本身就是"按路径找到的"，再声明 cwd 是循环定义', () => {
    const r = RP({ ...PROJECT, cwd: 'D:/evil' });
    assert.equal(r.cwd.value, 'D:/work/from-token');           // 仍然来自 token.cwd（entry=run）
    assert.equal(r.cwd.source, SOURCE.TOKEN);
  });

  test('★ terminalMode 盖不掉——机器级偏好，不是项目级', () => {
    const r = RP({ ...PROJECT, terminalMode: 'window' });
    assert.equal(r.terminalMode.value, 'tab');
    assert.equal(r.terminalMode.source, SOURCE.DEFAULTS);
  });

  test('★ providerId **可以**给（它只是个名字，改它不会让 key 跑到别处）', () => {
    const r = RP({ ...PROJECT, providerId: 'cxt-proj' });
    assert.equal(r.providerId.value, 'cxt-proj');
    assert.equal(r.providerId.source, SOURCE.PROJECT);
  });
});

describe('★ 项目本地与各层的具体顺序', () => {
  test('★★ env：四层按键合并，项目本地排**最后**（最具体）', () => {
    const r = RP();
    assert.equal(r.env.value.SHARED, 'from-project');
    assert.equal(r.env.sources.SHARED, SOURCE.PROJECT);
    assert.equal(r.env.value.P_ONLY, '1');
    assert.equal(r.env.sources.P_ONLY, SOURCE.PROJECT);
    // 低层的键不会因为高层说话而消失
    assert.equal(r.env.value.RUST_LOG, 'warn');
    assert.equal(r.env.sources.RUST_LOG, SOURCE.DEFAULTS);
    assert.equal(r.env.value.A_ONLY, '1');
    assert.equal(r.env.sources.A_ONLY, SOURCE.TOKEN);
  });

  test('★ models：项目本地整体覆盖（不是与低层合并）', () => {
    const r = RP();
    assert.deepEqual(r.models.value, [{ id: 'proj-model' }]);
    assert.equal(r.model.value.id, 'proj-model', 'model 跟着 models[0] 走');
    assert.equal(r.model.source, SOURCE.PROJECT);
  });

  test('★ `models: []` 在项目本地同样是"显式不注入"，不是缺项', () => {
    const r = RP({ ...PROJECT, models: [] });
    assert.equal(r.model.value, null);
    assert.equal(r.model.explicitEmpty, true);
    assert.ok(!r.missing.includes('model'));
  });

  test('★ codexArgs：defaults + token + 项目本地 + 命令行 `--`（低 → 高）', () => {
    const r = RP(PROJECT, { argv: { token: 'relay-a', extraArgs: ['--last'] } });
    assert.deepEqual(r.codexArgs.value, ['--no-alt-screen', '--profile', 'a', '--project-flag', '--last']);
  });

  test('★ `--token` 仍然压过项目本地（CLI 在最上）', () => {
    const r = RP(PROJECT, { argv: { token: 'relay-b' } });
    assert.equal(r.token.value, 'relay-b');
    assert.equal(r.token.source, SOURCE.CLI);
  });

  test('★ `--model` 仍然压过项目本地的 models（差量不落盘）', () => {
    const r = RP(PROJECT, { argv: { model: 'cli-model' } });
    assert.equal(r.model.value.id, 'cli-model');
    assert.equal(r.model.source, SOURCE.CLI);
    assert.deepEqual(r.models.value, [{ id: 'proj-model' }], 'models 列表本身不受 --model 影响');
  });

  test('★ 项目本地声明沙箱 → 照常发"覆盖项目级策略"的告警（覆盖要看得见）', () => {
    const r = RP();
    assert.ok(r.warnings.some((w) => w.code === 'overrides-project-policy'));
  });

  test('★★ 项目本地指定 token 时**也**要报"身份与地址混用"', () => {
    // 组合与 `--token relay-a` 在绑定目录里跑**一模一样**：relay-a 的 key + relay-b 的 URL。
    // 而它更隐蔽——用户这一轮没敲那个 flag，是仓库的文件替他做的决定。
    // 漏了这条，`.cxt.json` 就是绕过那条告警的后门。
    const r = RP();
    const w = r.warnings.find((x) => x.code === 'explicit-token-mixed-with-binding');
    assert.ok(w, '项目本地指定 token 混用绑定的 baseUrl → 必须提示');
    assert.match(w.message, /项目本地/);
    assert.match(w.message, /relay-a/);
  });

  test('★ 项目本地选的就是绑定那个 token 时不报（没混用）', () => {
    const r = RP({ ...PROJECT, token: 'relay-b' });
    assert.ok(!r.warnings.some((w) => w.code === 'explicit-token-mixed-with-binding'));
  });
});

describe('★ 项目本地指了一个不存在的 token：报错要点名那份文件', () => {
  test('★ hint 说清"是哪个文件让你用这个名字的"', () => {
    /** @type {any} */
    let err = null;
    try {
      RP({ ...PROJECT, token: 'nope' });
    } catch (e) {
      err = e;
    }
    assert.ok(err, '应当抛错');
    assert.match(err.message, /token "nope" 不存在/);
    // ★ 报 detail 而不是 source：`project` 这个词本身不告诉用户**是哪一份文件**
    assert.ok(err.hint.includes(PROJECT.configPath), `hint 应点名文件，实际：${err.hint}`);
  });
});

describe('★ 项目本地层的纯函数性', () => {
  test('★ 不改动传进来的 project 对象', () => {
    const project = JSON.parse(JSON.stringify(PROJECT));
    const snapshot = JSON.stringify(project);
    RP(project);
    assert.equal(JSON.stringify(project), snapshot);
  });

  test('★ 同一输入两次调用结果一致', () => {
    assert.deepEqual(RP(), RP());
  });

  test('★ 空的 project（只有 version/configPath）等价于"这一层什么都没说"', () => {
    const bare = { configPath: 'D:/work/client-a/.cxt.json', version: 1 };
    const r = RP(bare);
    assert.equal(r.token.source, SOURCE.BINDING, 'token 落回绑定');
    assert.deepEqual(r.models.value, DEFAULTS.models, 'models 落回 defaults');
    assert.equal(r.env.value.SHARED, 'from-binding');
    assert.equal(r.sandboxMode.value, null);
  });
});

// ═══════════════ 沙箱 / 审批 / 终端 ═══════════════

describe('★ sandboxMode / approvalPolicy：默认**不注入**（§2.3 第四条）', () => {
  test('三层都没声明 → null（不注入，把领地留给项目级）', () => {
    const r = R();
    assert.equal(r.sandboxMode.value, null);
    assert.equal(r.approvalPolicy.value, null);
  });

  test('★ 声明了就标告警：这会覆盖项目级策略（安全回归，必须说）', () => {
    const r = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, sandboxMode: 'danger-full-access' }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.sandboxMode.value, 'danger-full-access');
    assert.ok(r.warnings.some((w) => w.code === 'overrides-project-policy'));
  });

  test('没声明时**不**报这条告警（否则天天响，就没人看了）', () => {
    assert.ok(!R().warnings.some((w) => w.code === 'overrides-project-policy'));
  });
});

describe('terminalMode：flag → defaults → 内置 "tab"', () => {
  test('默认 tab', () => {
    const r = resolve({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.terminalMode.value, 'tab');
    assert.equal(r.terminalMode.source, SOURCE.BUILTIN);
  });

  test('defaults 覆盖内置', () => {
    assert.equal(R().terminalMode.value, 'tab');
    const r = resolve({
      config: { version: 1, defaults: { terminalMode: 'window' }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.terminalMode.value, 'window');
    assert.equal(r.terminalMode.source, SOURCE.DEFAULTS);
  });

  test('flag 压过 defaults', () => {
    const r = R({ argv: { window: true } });
    assert.equal(r.terminalMode.value, 'window');
    assert.equal(r.terminalMode.source, SOURCE.CLI);
  });
});

// ═══════════════ 缺项收集（不抛） ═══════════════

describe('★ resolve 只**收集**缺项，不抛（抛是 validate 的事）', () => {
  const EMPTY = { version: 1, defaults: {}, bindings: [] };

  test('什么都没有 → 三项缺失，且**不抛**', () => {
    const r = resolve({ config: EMPTY, tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32' });
    assert.deepEqual(r.missing.sort(), ['authToken', 'baseUrl', 'model']);
    assert.equal(r.cwd.value, 'D:/x', 'cwd 总有兜底，不会缺');
  });

  test('齐全 → missing 为空', () => {
    assert.deepEqual(R().missing, []);
  });

  test('★ 缺项时其余项照样解析出来（诊断价值全在这）', () => {
    const r = resolve({
      config: { version: 1, defaults: { baseUrl: 'https://x/' }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.baseUrl.value, 'https://x/', 'baseUrl 有了');
    assert.deepEqual(r.missing.sort(), ['authToken', 'model']);
  });
});

describe('★ assertComplete：启动路径上四要素必须齐全（§2.1）', () => {
  test('齐全 → 原样返回', () => {
    const r = R();
    assert.equal(assertComplete(r), r);
  });

  test('★ 报错**指名**缺哪一项', () => {
    const r = resolve({
      config: { version: 1, defaults: { baseUrl: 'https://x/' }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.throws(() => assertComplete(r), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.message, /authToken/);
      assert.match(err.message, /model/);
      assert.ok(!/baseUrl/.test(err.message), 'baseUrl 不缺，不该出现在缺项里');
      return true;
    });
  });

  test('★ 多项同缺时**一次全列**（免得修一个跑一次）', () => {
    const r = resolve({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    try {
      assertComplete(r);
      assert.fail('应当抛错');
    } catch (err) {
      const hint = /** @type {any} */ (err).hint;
      for (const k of ['authToken', 'baseUrl', 'model']) assert.match(hint, new RegExp(k));
    }
  });

  test('★ 显式空 models 时 assertComplete **放行**（§2.3 的表）', () => {
    const r = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, models: [] }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.doesNotThrow(() => assertComplete(r));
  });
});

// ═══════════════ 参数一致性 ═══════════════

describe('★ assertArgvConsistent（§2.5）', () => {
  test('--model 与 --pick 冲突 → 报错（不定义优先级）', () => {
    assert.throws(() => assertArgvConsistent({ model: 'x', pick: true }),
      (err) => err.code === 1 && /--model/.test(err.message) && /--pick/.test(err.message));
  });

  test('各自单独用 → 放行', () => {
    assert.doesNotThrow(() => assertArgvConsistent({ model: 'x' }));
    assert.doesNotThrow(() => assertArgvConsistent({ pick: true }));
  });

  test('--window 与 --tab 冲突 → 报错', () => {
    assert.throws(() => assertArgvConsistent({ window: true, tab: true }),
      (err) => err.code === 1 && /--window/.test(err.message));
  });

  test('空 argv → 放行', () => {
    assert.doesNotThrow(() => assertArgvConsistent({}));
    assert.doesNotThrow(() => assertArgvConsistent(undefined));
  });
});

describe('★ assertPickUsable：非 TTY 绝不静默取 models[0]（§2.5）', () => {
  test('TTY 下放行', () => {
    assert.doesNotThrow(() => assertPickUsable({ pick: true }, true));
  });

  test('★ 非 TTY → 报错（静默退化会让"这次用了哪个模型"不可知）', () => {
    assert.throws(() => assertPickUsable({ pick: true }, false),
      (err) => err.code === 1 && /TTY/.test(err.message));
  });

  test('★ --json 下报错', () => {
    assert.throws(() => assertPickUsable({ pick: true }, true, true),
      (err) => err.code === 1 && /--json/.test(err.message));
  });

  test('没给 --pick → 什么都不查（连 isTty 都不看）', () => {
    assert.doesNotThrow(() => assertPickUsable({}, false, true));
  });
});

// ═══════════════ ${ENV_VAR} 求值 ═══════════════

describe('★ ${ENV_VAR}：resolve 只识别、exec 才求值（§2.4）', () => {
  test('★ 环境变量没设置时 resolve 照样跑出完整结果', () => {
    const r = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(r.authToken.value, '${DEEPSEEK_API_KEY}', '原样带出来，不解析、不报错');
    assert.deepEqual(r.missing, [], '未设置 ≠ 缺项——识别与求值是两个阶段');
  });

  test('求值：设置了就取环境里的值', () => {
    assert.equal(evaluateSecretRef(parseSecretRef('${K}'), { K: 'sk-live' }), 'sk-live');
  });

  test('★ 求值：没设置 → 报错指名变量，**绝不回退成字面量**', () => {
    assert.throws(() => evaluateSecretRef(parseSecretRef('${K}'), {}), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.message, /K/);
      assert.ok(!err.message.includes('${'), '不能把 ${K} 当值用');
      return true;
    });
  });

  test('空字符串也算没设置（空 key 只会换来 401，不如当场说清）', () => {
    assert.throws(() => evaluateSecretRef(parseSecretRef('${K}'), { K: '' }), (err) => err.code === 1);
  });

  test('明文直接返回，不查环境', () => {
    assert.equal(evaluateSecretRef(parseSecretRef('sk-plain'), {}), 'sk-plain');
  });
});

// ═══════════════ 注入清单（§2.6） ═══════════════

describe('★ buildInjection（§2.6 的唯一来源）', () => {
  const HOME = 'C:/Users/me';
  const r = R({ argv: { token: 'relay-a' } });
  const inj = buildInjection(r, { home: HOME, platform: 'win32', authTokenValue: 'sk-live' });

  test('★ CODEX_HOME 指向 profiles/<token>/（身份隔离）', () => {
    // profileDir 属于 paths.js 规则 1（**宿主形状**）：它要直接喂给本机 fs / env，
    // 所以这里用宿主 join 算期望值，而不是写死某一种分隔符
    assert.equal(inj.env.CODEX_HOME, join(HOME, '.codex-multi-token', 'profiles', 'relay-a'));
    assert.equal(inj.profileName, 'relay-a');
  });

  test('★ 凭证走 CXT_TOKEN_* 环境变量，**不落 config.toml**（§2.2）', () => {
    assert.equal(inj.env.CXT_TOKEN_RELAY_A, 'sk-live');
    assert.equal(inj.managedValues.provider.values.env_key, 'CXT_TOKEN_RELAY_A',
      'env_key 只写**变量名**');
    const providerText = JSON.stringify(inj.managedValues);
    assert.ok(!providerText.includes('sk-live'), '明文 key 绝不能出现在受管区里');
  });

  test('★ 逃生舱 env 也注入（按键合并的结果）', () => {
    assert.equal(inj.env.RUST_LOG, 'warn');
    assert.equal(inj.env.SHARED, 'from-binding', '绑定层最具体');
  });

  test('受管区：model / model_provider / provider section', () => {
    assert.equal(inj.managedValues.topLevel.model, 'a-model');
    assert.equal(inj.managedValues.topLevel.model_provider, 'cxt-relay-a');
    assert.equal(inj.managedValues.provider.id, 'cxt-relay-a');
    assert.deepEqual(inj.managedValues.provider.values, {
      name: 'cxt relay-a',
      // ⚠️ 绑定 relay-b 自带的 baseUrl 比 token 层具体（§2.3）——这里刻意断言这个事实，
      //    因为它是本表最容易踩的一脚，也正是上面那条告警存在的理由
      base_url: 'https://b.example.com/',
      env_key: 'CXT_TOKEN_RELAY_A',
      wire_api: 'responses',
    });
  });

  test('★ model_provider 与 provider.id **必须同名**（§7.8：不一致 Codex 拒绝加载整个配置）', () => {
    assert.equal(inj.managedValues.topLevel.model_provider, inj.managedValues.provider.id);
  });

  test('参数：-C cwd', () => {
    assert.deepEqual(inj.args.slice(0, 2), ['-C', 'D:/work/from-token']);
  });

  test('★ --model 才走 `-c model=` 差量（默认模型由受管区给，不重复写）', () => {
    assert.ok(!inj.args.includes('-c'), '没给 --model 就不该有 -c');
    const r2 = R({ argv: { token: 'relay-a', model: 'one-off' } });
    const inj2 = buildInjection(r2, { home: HOME, platform: 'win32', authTokenValue: 'sk' });
    assert.ok(inj2.args.includes('model=one-off'));
  });

  test('★★ `--model` **绝不落盘**——它是"这一次"，不是"配置"（§2.5）', () => {
    // 这条是补的：上面那条只断言了 args 一侧，于是"两边都写"这个 bug 溜了过去。
    // 症状很隐蔽——`cxt run --model x` 之后不带 --model 再跑一次，
    // cxt 会把自己上次写的 x 当成配置改回去，凭空制造一份"漂移"。
    //
    // ⚠️ 反方向的错法同样要防：**不能干脆不写这条键**——拼接器会把文件里原有的
    //    `model = ...` 删掉，"这一次换个模型"顺手抹掉了持久配置。
    //    正解是两者分离：受管区照常写配置值，本次覆盖走 `-c`。
    const r2 = R({ argv: { token: 'relay-a', model: 'one-off' } });
    const inj2 = buildInjection(r2, { home: HOME, platform: 'win32', authTokenValue: 'sk' });

    assert.ok(inj2.args.includes('model=one-off'), '走 -c 差量');
    assert.equal(
      inj2.managedValues.topLevel.model, 'a-model',
      '受管区里的 model 必须是**配置里那个**（models[0]），与本次 --model 无关',
    );
    assert.ok(
      !JSON.stringify(inj2.managedValues).includes('one-off'),
      '受管区整份文本里都不该出现这次的值',
    );
  });

  test('★ `--model` 时受管区**仍然写** model 键（否则拼接器会把它删掉）', () => {
    const r2 = R({ argv: { token: 'relay-a', model: 'one-off' } });
    const inj2 = buildInjection(r2, { home: HOME, platform: 'win32', authTokenValue: 'sk' });
    assert.equal('model' in inj2.managedValues.topLevel, true, '键必须在，值才是配置值');
  });

  test('★ 四要素不齐时 buildInjection 照样能跑（`cxt resolve` 的价值全在这）', () => {
    // baseUrl / authToken 全缺 → 之前会把 base_url: null 塞进 provider.values，
    // 然后在 toml-value.js 那里炸掉，把真正的问题（缺哪两项）盖得一干二净。
    const bare = resolve({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    const injBare = buildInjection(bare, { home: HOME, platform: 'win32' });

    assert.equal('base_url' in injBare.managedValues.provider.values, false,
      '解析不出来的项**整条键不写**——TOML 没有 null');
    assert.deepEqual(bare.missing.sort(), ['authToken', 'baseUrl', 'model'],
      '缺项仍然照报，只是不再把 resolve 自己弄崩');
    // 其余照常产出
    assert.equal(injBare.managedValues.topLevel.model_provider, 'cxt-default');
    assert.equal(injBare.managedValues.provider.values.wire_api, 'responses');
    assert.equal('model' in injBare.managedValues.topLevel, false,
      '模型也没有 → 不写 model 键，用 Codex 自身默认');
  });

  test('★ 受管区里**一个 null 都不能有**（toml-value.js 会拒绝，这是道守卫）', () => {
    const bare = resolve({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    const injBare = buildInjection(bare, { home: HOME, platform: 'win32' });
    const walk = (o) => Object.values(o).every(
      (v) => (v !== null && v !== undefined)
        && (typeof v !== 'object' || Array.isArray(v) || walk(v)),
    );
    assert.ok(walk(injBare.managedValues), '递归查一遍：不许有 null / undefined');
  });

  test('★ 沙箱 / 审批**没声明就不注入**（§2.3 第四条）', () => {
    assert.ok(!inj.args.some((a) => a.startsWith('sandbox_mode=')));
    assert.ok(!inj.args.some((a) => a.startsWith('approval_policy=')));
  });

  test('声明了才注入，且用 `-c`', () => {
    const r2 = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, sandboxMode: 'read-only', approvalPolicy: 'never' }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    const inj2 = buildInjection(r2, { home: HOME, platform: 'win32', authTokenValue: 'sk' });
    assert.ok(inj2.args.includes('sandbox_mode=read-only'));
    assert.ok(inj2.args.includes('approval_policy=never'));
  });

  test('codexArgs 追加在参数末尾', () => {
    assert.deepEqual(inj.args.slice(-2), ['--profile', 'a']);
  });

  test('★ 干跑（authTokenValue = null）时**不把变量塞进 env**，但名字仍在', () => {
    const dry = buildInjection(r, { home: HOME, platform: 'win32', authTokenValue: null });
    assert.equal(dry.env.CXT_TOKEN_RELAY_A, undefined, '--print 不该持有明文');
    assert.equal(dry.managedValues.provider.values.env_key, 'CXT_TOKEN_RELAY_A');
  });

  test('★ 显式空 models → 受管区**不写 model 键**（用 Codex 自身默认）', () => {
    const r2 = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, models: [] }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    const inj2 = buildInjection(r2, { home: HOME, platform: 'win32', authTokenValue: 'sk' });
    assert.equal('model' in inj2.managedValues.topLevel, false);
    assert.equal(inj2.managedValues.topLevel.model_provider, 'cxt-default');
  });

  test('catalog 有才写 model_catalog_json', () => {
    assert.ok(!('model_catalog_json' in inj.managedValues.topLevel));
    const r2 = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, catalog: 'C:/c.json' }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(buildInjection(r2, { home: HOME, platform: 'win32' }).managedValues.topLevel.model_catalog_json, 'C:/c.json');
  });

  test('★ catalog 里的 `~` 必须展开成绝对路径', () => {
    // §7.5：`model_catalog_json` **可能不支持 `~` 展开**，且失败是**静默**的——
    // Codex 退回内置猜测，长会话里自动压缩的时机不对，跑很久之后才炸。
    // §2.4 的配置样例写的正是 `~/.codex-multi-token/catalogs/...`，所以这条路一定会被走到。
    const r2 = resolve({
      config: {
        version: 1,
        defaults: { ...DEFAULTS, catalog: '~/.codex-multi-token/catalogs/deepseek.json' },
        bindings: [],
      },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    const got = buildInjection(r2, { home: HOME, platform: 'win32' })
      .managedValues.topLevel.model_catalog_json;
    assert.ok(!String(got).startsWith('~'), `写出去还带着 ~：${got}`);
    assert.equal(got, join(HOME, '.codex-multi-token', 'catalogs', 'deepseek.json'));
  });

  test('★ 展开按**目标平台**拼（§3.5 规则 2）——算 Linux 路径不能出反斜杠', () => {
    const r2 = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, catalog: '~/c.json' }, bindings: [] },
      tokens: {}, cwd: '/x', argv: {}, entry: 'run', platform: 'linux',
    });
    assert.equal(
      buildInjection(r2, { home: '/home/t', platform: 'linux' }).managedValues.topLevel.model_catalog_json,
      '/home/t/c.json',
    );
  });

  test('绝对路径原样穿过——展开只认开头的 `~`，中间的 `~` 是普通字符', () => {
    const r2 = resolve({
      config: { version: 1, defaults: { ...DEFAULTS, catalog: 'D:/a~b/c.json' }, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(
      buildInjection(r2, { home: HOME, platform: 'win32' }).managedValues.topLevel.model_catalog_json,
      'D:/a~b/c.json',
    );
  });

  test('窗口标题 `cxt:<token>`；无 token 时 `cxt:default`（§2.3）', () => {
    assert.equal(inj.title, 'cxt:relay-a');
    const r2 = resolve({
      config: { version: 1, defaults: DEFAULTS, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    });
    assert.equal(buildInjection(r2, { home: HOME, platform: 'win32' }).title, 'cxt:default');
  });

  test('★ exec 入口**不传** `-C`——进程 pwd 本来就是对的，再传一遍是净增风险', () => {
    const re = R({ entry: 'exec', argv: { token: 'relay-a' } });
    const inje = buildInjection(re, { home: HOME, platform: 'win32', authTokenValue: 'sk' });
    assert.ok(
      !inje.args.includes('-C'),
      `exec 不该传 -C，实得 ${JSON.stringify(inje.args)}——`
      + '这个值会经 cmd shim（§7.14⑥），白白多一次 %VAR% 展开面',
    );
    assert.ok(
      !inje.args.includes('D:/work/from-token'),
      'token.cwd 绝不能漏进 exec 的参数',
    );
  });

  test('★ exec + **显式 `--cwd`** → 才传 `-C`（判据是来源层，不是"值不一样"）', () => {
    const re = R({ entry: 'exec', argv: { token: 'relay-a', cwd: 'D:/explicit' } });
    const inje = buildInjection(re, { home: HOME, platform: 'win32', authTokenValue: 'sk' });
    assert.deepEqual(inje.args.slice(0, 2), ['-C', 'D:/explicit']);
  });

  test('★ run 入口**总是**传 `-C`——终端 cwd 不保证生效（§7.14⑤ 的兜底会丢 cwd）', () => {
    const rRun = R({ entry: 'run', argv: { token: 'relay-a' } });
    const inje = buildInjection(rRun, { home: HOME, platform: 'win32', authTokenValue: 'sk' });
    assert.deepEqual(inje.args.slice(0, 2), ['-C', 'D:/work/from-token'],
      'run 下 token.cwd 生效，且必须经 -C 交给 codex');
  });

  test('缺 home → 抛错（core 不读 os.homedir()）', () => {
    assert.throws(() => buildInjection(r, /** @type {any} */ ({})), (err) => err.code === 1);
  });

  test('缺 platform → 抛错（core 不读 process.platform，§4.2）', () => {
    assert.throws(
      () => buildInjection(r, /** @type {any} */ ({ home: HOME })),
      (err) => err.code === 1,
    );
  });
});

// ═══════════════ ★ 继承环境的净化（§2.6）═══════════════

describe('★ unset：cxt 明确不注入的项（§2.6）', () => {
  const HOME = 'C:/Users/me';
  const inj = (defaults) => buildInjection(
    resolve({
      config: { version: 1, defaults, bindings: [] },
      tokens: {}, cwd: 'D:/x', argv: {}, entry: 'run', platform: 'win32',
    }),
    { home: HOME, platform: 'win32', authTokenValue: 'sk' },
  );

  test('env 里写**空串** → 进 unset，且**不进 env**', () => {
    const got = inj({ ...DEFAULTS, env: { RUST_LOG: 'warn', CODEX_SQLITE_HOME: '' } });

    assert.deepEqual(got.unset, ['CODEX_SQLITE_HOME']);
    assert.equal(got.env.CODEX_SQLITE_HOME, undefined, '空串的键不许留在 env 里');
    assert.equal(got.env.RUST_LOG, 'warn', '同一层里正常的键照常注入');
  });

  test('★ 空串是"删"不是"设成空"——后者在两个平台上语义还不一样', () => {
    // Windows 上"空值"与"没这个变量"几乎等价，POSIX 上却是**真的空串**。
    // 同一个配置在两个平台上跑出两种语义，不能留（§2.6）。
    const got = inj({ ...DEFAULTS, env: { FOO: '' } });
    assert.deepEqual(got.unset, ['FOO']);
    assert.ok(!('FOO' in got.env), '`FOO: ""` 的结果必须是"没有 FOO"，不是"FOO 是空"');
  });

  test('没配 env / 配了空对象 → unset 是空数组（不是 undefined）', () => {
    // 形状稳定很重要：调用方直接 `.length` / `for…of`，不该到处写 `?? []`
    assert.deepEqual(inj({ ...DEFAULTS, env: undefined }).unset, []);
    assert.deepEqual(inj({ ...DEFAULTS, env: {} }).unset, []);
  });

  test('★ 三层合并后是空串才算数（低层的值被高层置空 = 删）', () => {
    const r = resolve({
      config: {
        version: 1,
        defaults: { ...DEFAULTS, env: { SHARED: 'from-defaults' } },
        bindings: [],
      },
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a', env: { SHARED: '' } } },
      cwd: 'D:/x', argv: { token: 'relay-a' }, entry: 'run', platform: 'win32',
    });
    const got = buildInjection(r, { home: HOME, platform: 'win32', authTokenValue: 'sk' });

    assert.deepEqual(got.unset, ['SHARED'], '合并是按键的（§2.3），所以 token 层的空串压得住 defaults 的值');
    assert.equal(got.env.SHARED, undefined);
  });
});

describe('★ stripSessionMarkers（§2.6）', () => {
  test('★ 13 个会话标记一个不剩', () => {
    /** @type {Record<string, string>} */
    const env = {};
    for (const k of SESSION_MARKER_ENV) env[k] = 'x';
    const got = stripSessionMarkers(env);

    assert.deepEqual(Object.keys(got), []);
    for (const k of SESSION_MARKER_ENV) {
      assert.ok(!(k in got), `${k} 没被剔掉——它描述的是"哪一个会话"，跨进程继承就是错的身份`);
    }
  });

  test('★ `CXT_TOKEN_*` 整个命名空间都剔（token 名是用户起的，列不完）', () => {
    const got = stripSessionMarkers({ CXT_TOKEN_A: 'sk-a', CXT_TOKEN_RELAY_B: 'sk-b', CXT_OTHER: 'keep' });

    assert.deepEqual(Object.keys(got), ['CXT_OTHER']);
    // 只剔前缀，不剔整个 CXT_ 命名空间——否则 cxt 自己的配置类变量也会被误伤
    assert.equal(got.CXT_OTHER, 'keep');
  });

  test('★ 配置类变量一个不动（判据：描述"怎么跑"而不是"是哪个进程"）', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/home/me',
      CODEX_HOME: '/home/me/.codex-multi-token/profiles/relay-a',
      CODEX_MANAGED_BY_NPM: '1',
      CODEX_MANAGED_PACKAGE_ROOT: '/usr/lib/node_modules/@openai/codex',
      CODEX_SANDBOX_MODE: 'workspace-write',
      RUST_LOG: 'warn',
    };
    assert.deepEqual(stripSessionMarkers(env), env, '这份环境应该原样穿过');
  });

  test('★★ **不改入参**——入参就是 `process.env` 本身', () => {
    // `main.js` 把 `process.env` **按引用**放进 ctx。就地 delete 会把 cxt 自己的
    // 进程环境改掉——后果是"这次运行之后的 cxt 都少了一个变量"，
    // 而且只在同一个进程里复现（CLI 跑一次就退出，所以几乎测不出来）。
    const env = { PATH: '/usr/bin', CODEX_SESSION_ID: 'sess-1' };
    const snapshot = { ...env };
    stripSessionMarkers(env);
    assert.deepEqual(env, snapshot, 'stripSessionMarkers 动了入参');
  });

  test('容错：undefined / null 入参 → 空对象（不抛）', () => {
    assert.deepEqual(stripSessionMarkers(undefined), {});
    assert.deepEqual(stripSessionMarkers(null), {});
  });

  test('非标记键的值哪怕是 undefined 也照原样带过去', () => {
    // `process.env` 在 Node 里是纯字符串，但 `stripSessionMarkers` 的签名收的是
    // `string | undefined`——测试夹具与将来的调用方都可能塞 undefined。
    // 这里**不负责**过滤它：Node 的 spawn 自己会跳过 undefined 值（等于没设）。
    assert.deepEqual(stripSessionMarkers({ A: undefined, B: 'b' }), { A: undefined, B: 'b' });
  });

  test('标记清单本身：无重复、已冻结', () => {
    assert.equal(new Set(SESSION_MARKER_ENV).size, SESSION_MARKER_ENV.length, '清单里有重复项');
    assert.ok(Object.isFrozen(SESSION_MARKER_ENV), '清单必须是冻结的——它是契约，不是可变配置');
  });
});

describe('★★ buildSessionEnv：头号不变量（§2.6）', () => {
  const HOME = 'C:/Users/me';

  /** 一份"干净"的继承环境（相当于从普通 shell 里跑 cxt） */
  const CLEAN = { PATH: '/usr/bin', HOME: '/home/me', CODEX_MANAGED_BY_NPM: '1', RUST_LOG: 'warn' };

  /** 同一条环境，但**是从一个 codex 会话里继承来的** */
  function fromCodexSession() {
    /** @type {Record<string, string>} */
    const env = { ...CLEAN };
    for (const k of SESSION_MARKER_ENV) env[k] = `父会话的 ${k}`;
    // ★ 最危险的一个：另一个 token 的密钥。新会话里出现它 = 两个 token 的秘密同处一室
    env.CXT_TOKEN_RELAY_B = 'sk-b-别的-token';
    return env;
  }

  const injection = buildInjection(
    R({ argv: { token: 'relay-a' } }),
    { home: HOME, platform: 'win32', authTokenValue: 'sk-live' },
  );

  test('★★ 从 codex 会话里跑，与从干净 shell 里跑，**结果必须一模一样**', () => {
    // 这条直接编码用户报的那个 bug：
    //   从会话里 `cxt run`，新会话顶着父会话的身份跑，
    //   甚至把状态库指到另一个 token 的目录上。
    // 只要这条不变量在，那个 bug 在结构上就不可能出现。
    assert.deepEqual(
      buildSessionEnv({ base: fromCodexSession(), injection }),
      buildSessionEnv({ base: CLEAN, injection }),
      '新会话的环境取决于"它是从哪儿被调用的"——头号不变量被打破了',
    );
  });

  test('★ 另一个 token 的密钥不会漏进来', () => {
    const env = buildSessionEnv({ base: fromCodexSession(), injection });
    assert.equal(env.CXT_TOKEN_RELAY_B, undefined, '别的 token 的密钥漏进了新会话');
    assert.equal(env.CXT_TOKEN_RELAY_A, 'sk-live', '本会话该有的那个仍然在');
  });

  test('★ 配置类变量照常继承（净化不等于"清空"）', () => {
    const env = buildSessionEnv({ base: fromCodexSession(), injection });
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.CODEX_MANAGED_BY_NPM, '1');
    assert.equal(env.RUST_LOG, 'warn');
  });

  test('顺序：先删 unset，再盖注入项——注入项永远最后生效', () => {
    const inj2 = { env: { FOO: 'from-injection' }, unset: ['FOO', 'BAR'] };
    const env = buildSessionEnv({ base: { FOO: 'inherited', BAR: 'inherited' }, injection: inj2 });

    assert.equal(env.FOO, 'from-injection', 'unset 先删、注入后盖 → 注入赢');
    assert.equal(env.BAR, undefined, '只被 unset 的项就是没了');
  });

  test('★ 逃生舱能把**会话标记**盖回来（用户显式配了就是显式要）', () => {
    // 净化不是"用户说什么都不算"：`env` 逃生舱在最后生效，所以
    // `defaults.env.CODEX_SESSION_ID = "..."` 这种显式配置照样能落地。
    // 这条同时证明了"净化发生在注入**之前**"这个顺序不是随便定的。
    const inj3 = { env: { CODEX_SESSION_ID: 'explicit' }, unset: [] };
    const env = buildSessionEnv({ base: { CODEX_SESSION_ID: 'inherited' }, injection: inj3 });
    assert.equal(env.CODEX_SESSION_ID, 'explicit');
  });

  test('★ 不改入参（`base` 就是 `ctx.env`）', () => {
    const base = fromCodexSession();
    const snapshot = { ...base };
    buildSessionEnv({ base, injection });
    assert.deepEqual(base, snapshot, 'buildSessionEnv 动了 ctx.env');
  });

  test('空 / 缺省 base 也不炸', () => {
    assert.equal(buildSessionEnv({ base: {}, injection }).CXT_TOKEN_RELAY_A, 'sk-live');
    assert.equal(buildSessionEnv({ base: undefined, injection }).CXT_TOKEN_RELAY_A, 'sk-live');
  });
});

// ═══════════════ 纯函数性 ═══════════════

describe('纯函数', () => {
  test('★ 不改入参（config / tokens / argv 都不动）', () => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    const tokens = JSON.parse(JSON.stringify(TOKENS));
    const argv = { token: 'relay-a', extraArgs: ['x'] };
    const snapshot = JSON.stringify({ config, tokens, argv });
    resolve({ config, tokens, cwd: CWD, argv, entry: 'run', platform: 'win32' });
    assert.equal(JSON.stringify({ config, tokens, argv }), snapshot);
  });

  test('★ 同一输入两次调用结果一致（无隐藏状态）', () => {
    assert.deepEqual(R(), R());
  });

  test('★ 不读宿主平台：同一输入在 win32 与 linux 下按各自规则匹配', () => {
    const config = { version: 1, defaults: DEFAULTS, bindings: [{ path: 'D:/Work', token: 'relay-a' }] };
    const win = resolve({ config, tokens: TOKENS, cwd: 'D:/work/x', argv: {}, entry: 'run', platform: 'win32' });
    const lin = resolve({ config, tokens: TOKENS, cwd: 'D:/work/x', argv: {}, entry: 'run', platform: 'linux' });
    assert.equal(win.token.value, 'relay-a', 'Windows 大小写不敏感 → 命中');
    assert.equal(lin.token.value, null, 'Linux 大小写敏感 → 不命中');
  });
});
