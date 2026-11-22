// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFIG_VERSION,
  checkVersion,
  hasModels,
  hasSlots,
  needsMigration,
  normalizeBinding,
  normalizeConfig,
  normalizeDefaults,
  normalizeModels,
  normalizeSlots,
  normalizeToken,
  normalizeTokenLabel,
  validateTokenName,
} from '../src/core/schema.js';
import { CmtError, EXIT } from '../src/core/errors.js';

describe('validateTokenName', () => {
  test('接受合法名字', () => {
    for (const n of ['a', 'a1', 'relay-a', 'relay_a', 'deepseek', 'a'.repeat(32), '0abc']) {
      assert.equal(validateTokenName(n), n);
    }
  });

  test('拒绝空与非字符串', () => {
    for (const n of ['', null, undefined, 42, {}]) {
      assert.throws(() => validateTokenName(n), CmtError);
    }
  });

  test('拒绝路径穿越——错误信息要点名原因', () => {
    for (const n of ['../etc', 'a/b', 'a\\b', 'a..b', '..', 'C:', 'a\0b']) {
      assert.throws(
        () => validateTokenName(n),
        (err) => {
          assert.ok(err instanceof CmtError);
          assert.match(err.message, /路径分隔符|不能为空/);
          return true;
        },
        `应拒绝 ${JSON.stringify(n)}`,
      );
    }
  });

  test('拒绝大写、前导 -/_、含点、超长', () => {
    for (const n of ['Relay', 'RELAY', '-a', '_a', 'a.b', 'a b', 'a'.repeat(33)]) {
      assert.throws(() => validateTokenName(n), CmtError, `应拒绝 ${JSON.stringify(n)}`);
    }
  });

  test('拒绝 Windows 保留设备名（token 名会变成目录名）', () => {
    for (const n of ['con', 'prn', 'aux', 'nul', 'com1', 'lpt9']) {
      assert.throws(
        () => validateTokenName(n),
        (err) => {
          assert.match(err.message, /保留设备名/);
          return true;
        },
        `应拒绝 ${n}`,
      );
    }
    // 仅完全相等时才是保留名
    assert.equal(validateTokenName('console'), 'console');
    assert.equal(validateTokenName('com10'), 'com10');
  });
});

describe('normalizeModels', () => {
  test('undefined 保持 undefined（= 继承上层，不是空列表）', () => {
    assert.equal(normalizeModels(undefined, 'x'), undefined);
  });

  test('空数组保持空数组（= 显式无模型）', () => {
    assert.deepEqual(normalizeModels([], 'x'), []);
  });

  test('字符串简写归成 { id }', () => {
    assert.deepEqual(normalizeModels(['a', 'b'], 'x'), [{ id: 'a' }, { id: 'b' }]);
  });

  test('保留 label，拒绝未知字段', () => {
    assert.deepEqual(
      normalizeModels([{ id: 'a', label: 'A' }], 'x'),
      [{ id: 'a', label: 'A' }],
    );
    assert.throws(() => normalizeModels([{ id: 'a', nope: 1 }], 'x'), CmtError);
  });

  test('拒绝非数组与空 id', () => {
    assert.throws(() => normalizeModels({}, 'x'), CmtError);
    assert.throws(() => normalizeModels([''], 'x'), CmtError);
    assert.throws(() => normalizeModels([{ label: 'A' }], 'x'), CmtError);
  });
});

describe('normalizeSlots', () => {
  test('null 是合法取值——表示该槽不注入（§2.5）', () => {
    assert.deepEqual(normalizeSlots({ haiku: null }, 'x'), { haiku: null });
  });

  test('拒绝未知槽位', () => {
    assert.throws(
      () => normalizeSlots({ turbo: 'a' }, 'x'),
      (err) => {
        assert.match(err.message, /未知槽位/);
        return true;
      },
    );
  });

  test('接受全部五个槽位', () => {
    const all = { opus: 'a', sonnet: 'b', haiku: 'c', fable: 'd', subagent: 'e' };
    assert.deepEqual(normalizeSlots(all, 'x'), all);
  });
});

describe('checkVersion', () => {
  test('当前版本通过', () => {
    assert.equal(checkVersion({ version: CONFIG_VERSION }), CONFIG_VERSION);
  });

  test('更高版本 → 退出码 2，绝不静默解析未来格式', () => {
    assert.throws(
      () => checkVersion({ version: CONFIG_VERSION + 1 }),
      (err) => {
        assert.equal(err.code, EXIT.ENV);
        assert.match(err.message, /只认到/);
        assert.match(err.hint, /升级/); // 报错必须给出下一步（§6.2）
        return true;
      },
    );
  });

  test('更低版本 → 不抛错，交由调用方迁移', () => {
    assert.equal(checkVersion({ version: 1 }), 1);
    assert.equal(needsMigration(1), false); // v1 即当前版本
  });

  test('缺失/非法 version → 用户错误', () => {
    for (const raw of [{}, { version: 0 }, { version: '1' }, { version: 1.5 }, null]) {
      assert.throws(() => checkVersion(raw), CmtError, `应拒绝 ${JSON.stringify(raw)}`);
    }
  });
});

describe('normalizeConfig', () => {
  test('最小配置', () => {
    const cfg = normalizeConfig({ version: 1 });
    assert.deepEqual(cfg, { version: 1, defaults: {}, bindings: [] });
  });

  test('重复 path 直接报错（最长前缀匹配的前提是无歧义）', () => {
    assert.throws(
      () =>
        normalizeConfig({
          version: 1,
          bindings: [{ path: 'D:/work' }, { path: 'D:/work' }],
        }),
      (err) => {
        assert.match(err.message, /重复的 path/);
        return true;
      },
    );
  });

  test('未知字段报错（手写配置打错字能立刻发现）', () => {
    assert.throws(() => normalizeConfig({ version: 1, nope: 1 }), CmtError);
    assert.throws(
      () => normalizeConfig({ version: 1, defaults: { nope: 1 } }),
      CmtError,
    );
    assert.throws(
      () => normalizeConfig({ version: 1, bindings: [{ path: 'a', nope: 1 }] }),
      CmtError,
    );
  });

  test('binding 的 token 名同样校验', () => {
    assert.throws(
      () => normalizeConfig({ version: 1, bindings: [{ path: 'D:/x', token: '../evil' }] }),
      CmtError,
    );
  });

  test('env 的值必须是字符串（它们要变成环境变量）', () => {
    assert.throws(
      () => normalizeConfig({ version: 1, defaults: { env: { N: 123 } } }),
      (err) => {
        assert.match(err.message, /必须是字符串/);
        return true;
      },
    );
  });

  test('models 的"不存在"与"为空"被区分保留', () => {
    const cfg = normalizeConfig({
      version: 1,
      defaults: { models: [] },
      bindings: [{ path: 'D:/a' }],
    });
    assert.equal(hasModels(cfg.defaults), true);
    assert.deepEqual(cfg.defaults.models, []);
    assert.equal(hasModels(cfg.bindings[0]), false);
  });
});

describe('normalizeToken', () => {
  test('name 缺省时取文件名', () => {
    const t = normalizeToken({ authToken: 'sk-x' }, 'relay-a');
    assert.equal(t.name, 'relay-a');
  });

  test('name 与文件名不一致 → 报错', () => {
    assert.throws(
      () => normalizeToken({ name: 'other' }, 'relay-a'),
      (err) => {
        assert.match(err.message, /与文件名/);
        return true;
      },
    );
  });

  test('authMode 只认 token / key', () => {
    assert.equal(normalizeToken({ name: 'a', authMode: 'key' }, 'a').authMode, 'key');
    assert.throws(() => normalizeToken({ name: 'a', authMode: 'oauth' }, 'a'), CmtError);
  });

  test('未知字段报错', () => {
    assert.throws(() => normalizeToken({ name: 'a', nope: 1 }, 'a'), CmtError);
  });
});

describe('normalizeBinding', () => {
  test('path 必填', () => {
    assert.throws(() => normalizeBinding({}, 0), CmtError);
    assert.equal(normalizeBinding({ path: 'D:/x' }, 0).path, 'D:/x');
  });

  test('只允许 path/token/公共层字段', () => {
    assert.throws(() => normalizeBinding({ path: 'D:/x', nope: 1 }, 0), CmtError);
  });
});

describe('hasSlots', () => {
  test('区分"没声明"与"声明为空"', () => {
    assert.equal(hasSlots({}), false);
    assert.equal(hasSlots({ slots: {} }), true);
    assert.equal(hasSlots(null), false);
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
    assert.throws(() => L(42), CmtError);
  });
});

describe('normalizeToken 的 label', () => {
  test('label 落地', () => {
    assert.equal(normalizeToken({ name: 'a', label: '中转' }, 'a').label, '中转');
  });

  test('空白 label **不写这个键**（不是写空串）', () => {
    const t = normalizeToken({ name: 'a', label: '   ' }, 'a');
    assert.equal('label' in t, false);
  });

  test('★ label 不属于 COMMON_KEYS：defaults / binding 一律拒绝', () => {
    assert.throws(() => normalizeDefaults({ label: 'x' }), CmtError);
    assert.throws(() => normalizeBinding({ path: 'D:/x', label: 'x' }, 0), CmtError);
  });
});
