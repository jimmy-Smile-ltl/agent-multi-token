// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_POLICIES,
  CONFIG_VERSION,
  deriveEnvKeyName,
  deriveProviderId,
  hasModels,
  normalizeBinding,
  normalizeConfig,
  normalizeDefaults,
  normalizeModels,
  normalizeToken,
  normalizeTokenLabel,
  parseSecretRef,
  validateTokenName,
} from '../src/core/schema.js';

// ───────────────────────────── token 名 ─────────────────────────────

describe('validateTokenName（§2.8）', () => {
  test('合法名通过', () => {
    for (const n of ['a', 'relay-a', 'relay_a', 'a1', 'x'.repeat(32)]) {
      assert.equal(validateTokenName(n), n);
    }
  });

  test('★ 路径穿越一律拒绝（它是目录名）', () => {
    for (const n of ['..', '../etc', 'a/../b', 'a/b', 'a\\b', 'C:', 'C:\\x', '/abs']) {
      assert.throws(() => validateTokenName(n), /不能包含路径分隔符|不合法/, `应拒绝 ${n}`);
    }
  });

  test('大写与开头符号被拒（会与环境变量名混淆）', () => {
    for (const n of ['Relay', 'RELAY', '-a', '_a', '.a', 'a b']) {
      assert.throws(() => validateTokenName(n), /不合法|不能包含/, `应拒绝 ${n}`);
    }
  });

  test('超长被拒', () => {
    assert.throws(() => validateTokenName('x'.repeat(33)), /不合法/);
  });

  test('Windows 保留设备名被拒（会建不出目录）', () => {
    for (const n of ['con', 'nul', 'aux', 'com1', 'lpt9']) {
      assert.throws(() => validateTokenName(n), /保留设备名/, `应拒绝 ${n}`);
    }
  });

  test('空名给出可操作的提示', () => {
    assert.throws(() => validateTokenName(''), /token 名不能为空/);
    assert.throws(() => validateTokenName(undefined), /token 名不能为空/);
  });
});

// ───────────────────────── 派生名（§2.1 / §2.6）─────────────────────────

describe('deriveProviderId / deriveEnvKeyName', () => {
  test('providerId 带 cxt- 前缀，避开内置 provider（§7.9）', () => {
    assert.equal(deriveProviderId('relay-a'), 'cxt-relay-a');
    assert.equal(deriveProviderId(null), 'cxt-default');
  });

  test('★ 派生出的 providerId 绝不撞内置 id', () => {
    // 内置：openai / ollama / lmstudio（§7.9）
    for (const builtin of ['openai', 'ollama', 'lmstudio']) {
      assert.notEqual(deriveProviderId(builtin), builtin);
    }
  });

  test('环境变量名：大写 + `-` 换 `_`（§2.6）', () => {
    assert.equal(deriveEnvKeyName('relay-a'), 'CXT_TOKEN_RELAY_A');
    assert.equal(deriveEnvKeyName('a_b'), 'CXT_TOKEN_A_B');
    assert.equal(deriveEnvKeyName(null), 'CXT_TOKEN_DEFAULT');
  });

  test('★ 绝不用 OPENAI_API_KEY 这类通用名（§2.6）', () => {
    // 回归护栏：通用名会与 Codex 自己的认证优先级打架
    for (const t of ['relay-a', null, undefined]) {
      const n = deriveEnvKeyName(t);
      assert.ok(n.startsWith('CXT_TOKEN_'), `${n} 必须带 cxt 专属前缀`);
      assert.notEqual(n, 'OPENAI_API_KEY');
      assert.notEqual(n, 'CODEX_API_KEY');
    }
  });
});

// ───────────────────────── `${ENV_VAR}`（§2.4）─────────────────────────

describe('parseSecretRef —— 只识别不求值', () => {
  test('整串引用被识别', () => {
    assert.deepEqual(parseSecretRef('${DEEPSEEK_API_KEY}'), {
      kind: 'env',
      name: 'DEEPSEEK_API_KEY',
    });
  });

  test('明文原样返回', () => {
    assert.deepEqual(parseSecretRef('sk-abc123'), { kind: 'literal', value: 'sk-abc123' });
  });

  test('★ 只认整串：部分引用报错，绝不退化成字面量', () => {
    // 退化成字面量的后果是"一个恒被拒绝的假 token"，最难排查（§2.4）
    assert.throws(() => parseSecretRef('sk-${VAR}'), /必须是\*\*整串\*\*/);
    assert.throws(() => parseSecretRef('${A}${B}'), /必须是\*\*整串\*\*/);
    assert.throws(() => parseSecretRef('${A}suffix'), /必须是\*\*整串\*\*/);
  });

  test('空引用名报错', () => {
    assert.throws(() => parseSecretRef('${}'), /必须是\*\*整串\*\*/);
    assert.throws(() => parseSecretRef('${1BAD}'), /必须是\*\*整串\*\*/);
  });
});

// ───────────────────────────── models ─────────────────────────────

describe('normalizeModels —— 「没声明」与「显式空」是两件事（§2.5）', () => {
  test('undefined 保持 undefined（= 继承上层）', () => {
    assert.equal(normalizeModels(undefined, 'x'), undefined);
    assert.equal(hasModels({}), false);
  });

  test('[] 保持 []（= 显式不注入）', () => {
    assert.deepEqual(normalizeModels([], 'x'), []);
    assert.equal(hasModels({ models: [] }), true);
  });

  test('★ 绝不把 undefined 补成 []', () => {
    // 这条是回归护栏：补了之后"缺项"会静默变成"显式空"，run 不再报错
    const out = normalizeDefaults({});
    assert.equal('models' in out, false);
    assert.equal(hasModels(out), false);
  });

  test('字符串与对象两种写法都接受', () => {
    assert.deepEqual(normalizeModels(['a', { id: 'b', label: 'B' }], 'x'), [
      { id: 'a' },
      { id: 'b', label: 'B' },
    ]);
  });

  test('未知字段报错', () => {
    assert.throws(() => normalizeModels([{ id: 'a', oops: 1 }], 'x'), /未知字段/);
  });

  test('非数组报错', () => {
    assert.throws(() => normalizeModels('a', 'x'), /必须是数组/);
  });
});

// ───────────────────────── 三层字段表（§2.4）─────────────────────────

describe('三层各自的字段集（§2.4 的刻意不对称）', () => {
  test('defaults 不接受 cwd——不存在"全局默认落点"', () => {
    assert.throws(() => normalizeDefaults({ cwd: 'D:/x' }), /未知字段 "cwd"/);
  });

  test('binding 不接受 cwd——绑定是"选身份"不是"去哪个目录"', () => {
    assert.throws(() => normalizeBinding({ path: 'D:/x', cwd: 'D:/y' }, 0), /未知字段 "cwd"/);
  });

  test('binding 不接受 codexArgs——绑定是"选身份"不是"调行为"', () => {
    assert.throws(
      () => normalizeBinding({ path: 'D:/x', codexArgs: ['--foo'] }, 0),
      /未知字段 "codexArgs"/,
    );
  });

  test('token 接受 cwd 与 codexArgs', () => {
    const t = normalizeToken({ name: 'a', cwd: 'D:/x', codexArgs: ['--foo'] });
    assert.equal(t.cwd, 'D:/x');
    assert.deepEqual(t.codexArgs, ['--foo']);
  });

  test('defaults 接受 terminalMode / codexBin，token 不接受', () => {
    assert.equal(normalizeDefaults({ terminalMode: 'window' }).terminalMode, 'window');
    assert.equal(normalizeDefaults({ codexBin: 'D:/codex.exe' }).codexBin, 'D:/codex.exe');
    assert.throws(() => normalizeToken({ name: 'a', terminalMode: 'tab' }), /未知字段/);
    assert.throws(() => normalizeToken({ name: 'a', codexBin: 'x' }), /未知字段/);
  });

  test('sandboxMode / approvalPolicy 三层都接受（§2.3 第四条）', () => {
    const d = normalizeDefaults({ sandboxMode: 'read-only', approvalPolicy: 'never' });
    assert.equal(d.sandboxMode, 'read-only');
    assert.equal(d.approvalPolicy, 'never');
    const t = normalizeToken({ name: 'a', sandboxMode: 'workspace-write' });
    assert.equal(t.sandboxMode, 'workspace-write');
    const b = normalizeBinding({ path: 'D:/x', approvalPolicy: 'on-request' }, 0);
    assert.equal(b.approvalPolicy, 'on-request');
  });
});

// ───────────────────────── 枚举校验（§7.9 / §7.10）─────────────────────────

describe('枚举校验', () => {
  test('sandboxMode 只认三个值（§7.10）', () => {
    for (const v of ['read-only', 'workspace-write', 'danger-full-access']) {
      assert.equal(normalizeDefaults({ sandboxMode: v }).sandboxMode, v);
    }
    assert.throws(() => normalizeDefaults({ sandboxMode: 'none' }), /取值非法/);
  });

  test('approvalPolicy 只认三个值（§7.10）', () => {
    assert.deepEqual([...APPROVAL_POLICIES], ['untrusted', 'on-request', 'never']);
  });

  test('★ approvalPolicy 拒绝 UnlessTrusted——它是内部状态，不可配置', () => {
    // 回归护栏：UnlessTrusted 只在 resolved 结果里出现，CLI 不接受（§7.3 / §7.10）。
    // 谁"顺手补全"枚举，就会让用户写进一个 Codex 根本不接受的档位。
    assert.throws(() => normalizeDefaults({ approvalPolicy: 'UnlessTrusted' }), /取值非法/);
    assert.throws(() => normalizeDefaults({ approvalPolicy: 'unlesstrusted' }), /取值非法/);
  });

  test('wireApi 只认 responses（§7.9）', () => {
    assert.equal(normalizeDefaults({ wireApi: 'responses' }).wireApi, 'responses');
  });

  test('★ wireApi = "chat" 给出专门的理由，不是笼统的"非法"', () => {
    // Codex 0.59 起移除了 chat；写下去 Codex 直接起不来，所以要说清原因
    assert.throws(() => normalizeDefaults({ wireApi: 'chat' }), /已不被 Codex 支持/);
  });

  test('wireApi 其它值报错并说明 cxt 只认 responses', () => {
    // 可操作的那半句在 `hint` 里（CLI 层 renderError 会把 message + hint 一起渲染）
    assert.throws(
      () => normalizeDefaults({ wireApi: 'grpc' }),
      (err) => {
        assert.match(err.message, /取值非法/);
        assert.match(err.hint, /只认 "responses"/);
        return true;
      },
    );
  });
});

describe('providerId 校验', () => {
  test('字母数字下划线连字符通过', () => {
    assert.equal(normalizeDefaults({ providerId: 'my-relay_1' }).providerId, 'my-relay_1');
  });

  test('★ 拒绝含 "." 的 id——那会变成嵌套表而不是 provider id', () => {
    // [model_providers.a.b] 在 TOML 里是嵌套表。写下去不报错，只是 Codex 找不到 provider。
    assert.throws(() => normalizeDefaults({ providerId: 'a.b' }), /不合法/);
  });

  test('拒绝空格与引号', () => {
    assert.throws(() => normalizeDefaults({ providerId: 'a b' }), /不合法/);
    assert.throws(() => normalizeDefaults({ providerId: 'a"b' }), /不合法/);
  });
});

// ───────────────────────── 字符串字段里的 ${} ─────────────────────────

describe('${ENV_VAR} 只允许出现在 authToken 上（§2.4）', () => {
  test('authToken 支持', () => {
    assert.equal(normalizeDefaults({ authToken: '${MY_KEY}' }).authToken, '${MY_KEY}');
  });

  test('authToken 里的畸形引用在 schema 阶段就报错', () => {
    assert.throws(() => normalizeDefaults({ authToken: 'sk-${MY_KEY}' }), /必须是\*\*整串\*\*/);
  });

  test('★ 其它字段出现 ${} 直接报错，不留成字面量', () => {
    // 留成字面量的后果：baseUrl 变成永远连不上的地址，报错完全指不到病根
    assert.throws(() => normalizeDefaults({ baseUrl: '${MY_URL}' }), /不支持 \$\{ENV_VAR\} 引用/);
    assert.throws(() => normalizeDefaults({ catalog: '${MY_CAT}' }), /不支持/);
    assert.throws(() => normalizeDefaults({ codexBin: '${MY_BIN}' }), /不支持/);
    assert.throws(() => normalizeBinding({ path: '${P}' }, 0), /不支持/);
  });
});

// ───────────────────────── 顶层 config ─────────────────────────

describe('normalizeConfig', () => {
  test('最小合法配置', () => {
    const c = normalizeConfig({ version: 1 });
    assert.equal(c.version, 1);
    assert.deepEqual(c.bindings, []);
  });

  test('★ 同一条 path 重复绑定直接报错（最长前缀匹配的前提是无歧义）', () => {
    assert.throws(
      () => normalizeConfig({
        version: 1,
        bindings: [{ path: 'D:/a' }, { path: 'D:/a' }],
      }),
      /重复的 path/,
    );
  });

  test('未知顶层键报错', () => {
    assert.throws(() => normalizeConfig({ version: 1, nope: 1 }), /未知字段/);
  });

  test('bindings 不是数组报错', () => {
    assert.throws(() => normalizeConfig({ version: 1, bindings: {} }), /必须是数组/);
  });
});

describe('版本检查（§3.5）', () => {
  test('当前版本通过', () => {
    assert.equal(normalizeConfig({ version: CONFIG_VERSION }).version, CONFIG_VERSION);
  });

  test('缺少 version 报错', () => {
    assert.throws(() => normalizeConfig({}), /缺少合法的 version 字段/);
  });

  test('★ 更高版本拒绝启动，绝不按当前 schema 解析未来格式', () => {
    assert.throws(() => normalizeConfig({ version: CONFIG_VERSION + 1 }), /只认到/);
  });
});

// ───────────────────────── token 文件交叉校验 ─────────────────────────

describe('normalizeToken 的文件名交叉校验', () => {
  test('name 缺省时用文件名补上', () => {
    assert.equal(normalizeToken({}, 'relay-a').name, 'relay-a');
  });

  test('★ name 与文件名不一致直接报错', () => {
    assert.throws(
      () => normalizeToken({ name: 'other' }, 'relay-a'),
      /与文件名（relay-a）不一致/,
    );
  });
});

// ───────────────────────── token 昵称（§2.4 末）─────────────────────────

describe('normalizeTokenLabel', () => {
  const L = (v) => normalizeTokenLabel(v, 'token a.label');

  test('正常值原样返回：中文、空格都行，两端空白被 trim', () => {
    assert.equal(L('阿里中转'), '阿里中转');
    assert.equal(L('  relay A  '), 'relay A');
  });

  test('★ 空白 ⇒ 未设置（调用方删键，绝不写空串）', () => {
    assert.equal(L(''), undefined);
    assert.equal(L('   '), undefined);
  });

  test('★ 上限按**码点**算：32 个 emoji 通过、33 个拒绝', () => {
    const e = '🙂';
    assert.equal(L(e.repeat(32)), e.repeat(32));
    assert.throws(() => L(e.repeat(33)), /32 个字符/);
  });

  test('★ 单行：换行 / 制表符 / DEL 一律拒绝（错误消息不打印原值）', () => {
    assert.throws(() => L('a\nb'), /控制字符/);
    assert.throws(() => L('a\tb'), /控制字符/);
    assert.throws(() => L(`a${String.fromCharCode(127)}b`), /控制字符/);
  });

  test('非字符串拒绝', () => {
    assert.throws(() => L(42), /必须是字符串/);
  });
});

describe('normalizeToken 的 label', () => {
  test('label 落地', () => {
    assert.equal(normalizeToken({ label: '中转' }, 'a').label, '中转');
  });

  test('空白 label **不写这个键**（不是写空串）', () => {
    const t = normalizeToken({ label: '   ' }, 'a');
    assert.equal('label' in t, false);
  });

  test('★ label 不属于 COMMON_KEYS：defaults / binding 一律拒绝', () => {
    assert.throws(() => normalizeDefaults({ label: 'x' }), /未知字段/);
    assert.throws(() => normalizeBinding({ path: 'D:/x', label: 'x' }, 0), /未知字段/);
  });
});
