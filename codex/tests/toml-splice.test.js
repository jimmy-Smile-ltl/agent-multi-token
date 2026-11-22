// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MANAGED_PROVIDER_KEYS,
  MANAGED_TOP_LEVEL_KEYS,
  findValueEnd,
  parseKeyValue,
  parseSectionHeader,
  spliceManagedRegion,
} from '../src/core/toml-splice.js';

// ───────────────────────────── 样本 ─────────────────────────────

const TOP = { model: 'deepseek-chat', model_provider: 'cxt-relay-a' };

const PROVIDER = {
  id: 'cxt-relay-a',
  values: {
    name: 'cxt relay-a',
    base_url: 'https://api.example.com/v1',
    env_key: 'CXT_TOKEN_RELAY_A',
    wire_api: 'responses',
  },
};

const PROVIDER_BLOCK = [
  '[model_providers.cxt-relay-a]',
  "name = 'cxt relay-a'",
  "base_url = 'https://api.example.com/v1'",
  "env_key = 'CXT_TOKEN_RELAY_A'",
  "wire_api = 'responses'",
].join('\n');

/**
 * 跑一次并断言没有意外抛错。
 *
 * ★ **自动配对 provider**：真实调用方（`resolve.js`）产出受管值时，
 * `model_provider` 与它的 provider section **永远成对**（§7.8 真机实测：
 * 指向不存在的 provider 会让整个 `config.toml` 不可加载）。
 * 所以这里复现同样的形状——绝大多数用例关心的是拼接机制，不该被这条约束绊住。
 *
 * 显式传了 `provider`（哪怕是 `null`）就不覆盖——**守卫本身单开一节直测**，
 * 走 `spliceManagedRegion` 而不是这个 helper。
 */
function splice(existingText, managedValues) {
  const mv = { ...managedValues };
  if (mv.topLevel?.model_provider != null && !('provider' in mv)) {
    mv.provider = PROVIDER;
  }
  return spliceManagedRegion({ existingText, managedValues: mv });
}

// ═══════════════════════ 铁律：其余内容逐字节保留 ═══════════════════════

describe('★ 铁律 2：永不删除 [projects.*]（§2.9）', () => {
  test('受管值全空时，一份只有信任记录的文件原样返回', () => {
    const src = "[projects.'D:\\work\\a']\ntrust_level = \"trusted\"\n";
    const { newText, report } = splice(src, {});
    assert.equal(newText, src);
    assert.equal(report.changed, false);
  });

  test('写入受管区时，信任记录逐字节不动', () => {
    const src = [
      '# 我的配置',
      '',
      "[projects.'D:\\work\\a']",
      'trust_level = "trusted"',
      '',
      "[projects.'D:\\work\\a b']",
      'trust_level = "untrusted"',
      '',
    ].join('\n');
    const { newText } = splice(src, { topLevel: TOP, provider: PROVIDER });

    for (const line of [
      "[projects.'D:\\work\\a']",
      "[projects.'D:\\work\\a b']",
      'trust_level = "trusted"',
      'trust_level = "untrusted"',
      '# 我的配置',
    ]) {
      assert.ok(newText.includes(line), `应保留：${line}`);
    }
  });

  test('★ 反斜杠 + 字面字符串的 section 名不被改写（§2.11 三·1）', () => {
    const src = "[projects.'D:\\work\\a']\ntrust_level = \"trusted\"\n";
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes("[projects.'D:\\work\\a']"));
    // 反向断言：绝不能"顺手"转成正斜杠——那会让信任静默失效
    assert.ok(!newText.includes('D:/work/a'));
  });
});

describe('★ 铁律 3：永不删除整个文件', () => {
  test('空受管值 + 空文件 → 不产出内容', () => {
    const { newText, report } = splice('', {});
    assert.equal(newText, '');
    assert.equal(report.created, true);
  });

  test('用户内容一条不少', () => {
    const src = [
      'approval_policy = "never"',
      'sandbox_mode = "workspace-write"',
      '',
      '[mcp_servers.foo]',
      'command = "node"',
      '',
    ].join('\n');
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes('approval_policy = "never"'));
    assert.ok(newText.includes('sandbox_mode = "workspace-write"'));
    assert.ok(newText.includes('[mcp_servers.foo]'));
    assert.ok(newText.includes('command = "node"'));
  });
});

describe('注释与空行逐字节保留', () => {
  test('缩进怪异的注释、连续空行原样留下', () => {
    const src = [
      '#  缩进怪异的注释',
      '',
      '',
      'approval_policy = "never"',
      '',
      '',
      "[projects.'D:\\a']",
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes('#  缩进怪异的注释\n\n\napproval_policy'));
  });

  test('★ 受管键那一行的行尾注释会消失——那行是 cxt 的领地', () => {
    // 这是**有意**的行为，不是漏判：值都换了，附着在旧值上的注释多半已经说谎。
    // 想留注释请写在独立行上。doctor 会把这类手工改动报成"身份区已漂移"（§2.9）
    const { newText } = splice('model = "old"   # 我临时改的\n', { topLevel: TOP });
    assert.ok(newText.includes("model = 'deepseek-chat'"));
    assert.ok(!newText.includes('我临时改的'));
  });

  test('注释里的假 section 不被当成 header', () => {
    const src = '# [projects.\'D:\\x\']\napproval_policy = "never"\n';
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes("# [projects.'D:\\x']"));
  });
});

// ═══════════════════════ 插入位置 ═══════════════════════

describe('★ 受管键必须插在第一个 section 之前（§2.9 步骤 5）', () => {
  test('插在 [projects.*] 之前——插到后面就变成那个 section 的键了', () => {
    const src = "[projects.'D:\\a']\ntrust_level = \"trusted\"\n";
    const { newText } = splice(src, { topLevel: TOP });
    const lines = newText.split('\n');

    assert.equal(lines[0], "model = 'deepseek-chat'");
    assert.equal(lines[1], "model_provider = 'cxt-relay-a'");
    assert.ok(
      lines.indexOf("model = 'deepseek-chat'") < lines.indexOf("[projects.'D:\\a']"),
      '顶层键必须出现在第一个 section header 之前',
    );
  });

  test('provider section 也插在其它 section 之前', () => {
    const src = "[projects.'D:\\a']\ntrust_level = \"trusted\"\n";
    const { newText } = splice(src, { topLevel: TOP, provider: PROVIDER });
    const lines = newText.split('\n');
    assert.ok(lines.indexOf('[model_providers.cxt-relay-a]') < lines.indexOf("[projects.'D:\\a']"));
  });

  test('已有顶层键就**就地替换**，不搬家', () => {
    const src = [
      '# 头注释',
      'approval_policy = "never"',
      'model = "old"',
      '',
      "[projects.'D:\\a']",
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const { newText, report } = splice(src, { topLevel: TOP });
    const lines = newText.split('\n');
    assert.equal(lines[0], '# 头注释');
    assert.equal(lines[1], 'approval_policy = "never"');
    assert.equal(lines[2], "model = 'deepseek-chat'");
    assert.deepEqual(report.replacedTopLevel, ['model']);
    assert.deepEqual(report.insertedTopLevel, ['model_provider']);
  });

  test('没有 section 时插在文件末尾', () => {
    const { newText } = splice('approval_policy = "never"\n', { topLevel: TOP });
    assert.equal(
      newText,
      'approval_policy = "never"\n'
      + "\nmodel = 'deepseek-chat'\nmodel_provider = 'cxt-relay-a'\n"
      + `\n${PROVIDER_BLOCK}\n`,
    );
    assert.ok(!newText.startsWith('\n'), '全新内容不该以空行开头');
  });
});

// ═══════════════════════ 多行值 ═══════════════════════

describe('★ 多行值消费（§2.9 边界）', () => {
  test('受管键的多行数组值被整块吃掉', () => {
    const src = 'model = [\n  "a",\n  "b",\n]\napproval_policy = "never"\n';
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes("model = 'deepseek-chat'"));
    assert.ok(!newText.includes('"a"'), '数组的残留行必须被消费掉');
    assert.ok(newText.includes('approval_policy = "never"'));
  });

  test('受管键的多行内联表值被整块吃掉', () => {
    const src = 'model_provider = {\n  name = "old",\n}\n';
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes("model_provider = 'cxt-relay-a'"));
    assert.ok(!newText.includes('name = "old"'));
  });

  test('★ 非受管键的多行值不被碰——哪怕里面有以 [ 开头的行', () => {
    // 嵌套数组的第二行就是 "  ["。不跟踪多行状态的话，这里会被误判成 section header，
    // 后面的受管键就会插到数组中间，把文件写坏
    const src = [
      'foo = [',
      '  [',
      '    "x",',
      '  ],',
      ']',
      '',
      "[projects.'D:\\a']",
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes('foo = [\n  [\n    "x",\n  ],\n]'), '嵌套数组必须原样保留');
    assert.equal(newText.split('\n')[6], "model = 'deepseek-chat'");
  });

  test('多行字符串里的方括号不算数', () => {
    const src = 'note = """\n[not.a.section]\n"""\n';
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes('note = """\n[not.a.section]\n"""'));
    assert.ok(newText.indexOf("model = 'deepseek-chat'") > newText.indexOf('"""'));
  });

  test('findValueEnd 单行值就返回本行', () => {
    assert.equal(findValueEnd(['model = "x"'], 0), 0);
    assert.equal(findValueEnd(['model = [', '  "a",', ']'], 0), 2);
    assert.equal(findValueEnd(['a = "]"'], 0), 0, '引号里的 ] 不算闭合');
    assert.equal(findValueEnd(['a = "x" # ]'], 0), 0, '注释里的 ] 不算闭合');
  });
});

// ═══════════════════════ section 识别 ═══════════════════════

describe('★ [[array-of-tables]] 不误判（§2.9 边界）', () => {
  test('用户自己的数组表原样保留', () => {
    const src = '[[history]]\nid = 1\n\n[[history]]\nid = 2\n';
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes('[[history]]\nid = 1'));
    assert.ok(newText.includes('[[history]]\nid = 2'));
    assert.ok(newText.indexOf("model = 'deepseek-chat'") < newText.indexOf('[[history]]'));
  });

  test('★ 受管 provider id 上出现数组表 → 报错（会和我们要写的 [..] 撞键）', () => {
    const src = '[[model_providers.cxt-relay-a]]\nname = "x"\n';
    assert.throws(
      () => splice(src, { topLevel: TOP, provider: PROVIDER }),
      /数组表/,
    );
  });

  test('parseSectionHeader 区分单双括号', () => {
    assert.deepEqual(parseSectionHeader('[a.b]'), { name: ['a', 'b'], isArray: false });
    assert.deepEqual(parseSectionHeader('[[a.b]]'), { name: ['a', 'b'], isArray: true });
  });
});

describe('★ 带引号的 section 名（反斜杠 + 字面字符串）', () => {
  test('解析 [projects.\'D:\\a b\']', () => {
    assert.deepEqual(parseSectionHeader("[projects.'D:\\a b']"), {
      name: ['projects', 'D:\\a b'],
      isArray: false,
    });
  });

  test('★ 路径里的 ] 不截断 header（用 indexOf 就会踩这个坑）', () => {
    assert.deepEqual(parseSectionHeader("[projects.'D:\\a]b']"), {
      name: ['projects', 'D:\\a]b'],
      isArray: false,
    });
  });

  test('转义基本字符串形态也认', () => {
    assert.deepEqual(parseSectionHeader('[projects."D:\\\\a"]'), {
      name: ['projects', 'D:\\a'],
      isArray: false,
    });
  });

  test('header 后的行尾注释允许', () => {
    assert.deepEqual(parseSectionHeader('[a.b] # 说明'), { name: ['a', 'b'], isArray: false });
  });

  test('不是 header 的行返回 null', () => {
    for (const s of ['', '# [a]', 'a = "x"', '[a', 'a]', '[a] b']) {
      assert.equal(parseSectionHeader(s), null, `不该认成 header：${JSON.stringify(s)}`);
    }
  });
});

describe('parseKeyValue', () => {
  test('普通键', () => {
    assert.deepEqual(parseKeyValue('model = "x"'), { key: 'model', segments: ['model'] });
  });

  test('带引号的键', () => {
    assert.deepEqual(parseKeyValue("'a b' = 1"), { key: 'a b', segments: ['a b'] });
  });

  test('★ 点分键的 segments 有多个——调用方靠它排除顶层误判', () => {
    assert.deepEqual(parseKeyValue('a.b = 1'), { key: 'a.b', segments: ['a', 'b'] });
  });

  test('等号在引号里不算', () => {
    assert.equal(parseKeyValue('"a=b" = 1').key, 'a=b');
  });

  test('不是键值行返回 null', () => {
    for (const s of ['', '# c', '[a]', 'novalue', '= 1']) {
      assert.equal(parseKeyValue(s), null, `不该认成键值行：${JSON.stringify(s)}`);
    }
  });
});

// ═══════════════════════ 顶层判定 ═══════════════════════

describe('只有**顶层**的同名键才受管', () => {
  test('section 里的 model 不动', () => {
    const src = '[model_providers.mine]\nname = "x"\nmodel = "oops"\n';
    const { newText } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes('model = "oops"'), 'section 内的 model 不是顶层键');
  });

  test('点分键 model.x 不算顶层 model', () => {
    const src = 'model.x = 1\n';
    const { newText, report } = splice(src, { topLevel: TOP });
    assert.ok(newText.includes('model.x = 1'));
    assert.deepEqual(report.replacedTopLevel, []);
    assert.deepEqual(report.insertedTopLevel, ['model', 'model_provider']);
  });
});

// ═══════════════════════ provider section ═══════════════════════

describe('provider section 的增改删', () => {
  test('就地重写，保持位置', () => {
    const src = [
      'model = "old"',
      '',
      '[model_providers.cxt-relay-a]',
      "name = 'stale'",
      '',
      "[projects.'D:\\a']",
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const { newText, report } = splice(src, { topLevel: TOP, provider: PROVIDER });
    assert.ok(!newText.includes("name = 'stale'"));
    assert.ok(newText.includes(PROVIDER_BLOCK));
    assert.equal(report.replacedProvider, 'cxt-relay-a');
    assert.deepEqual(report.removedProviders, []);
    assert.ok(newText.indexOf('[model_providers.cxt-relay-a]') < newText.indexOf("[projects.'D:\\a']"));
  });

  test('★ 换了 providerId → 陈旧的 cxt-* section 被清掉', () => {
    const src = [
      '[model_providers.cxt-old]',
      "name = 'old'",
      '',
      "[projects.'D:\\a']",
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const { newText, report } = splice(src, { topLevel: TOP, provider: PROVIDER });
    assert.ok(!newText.includes('cxt-old'), '陈旧的受管 provider 必须清掉');
    assert.deepEqual(report.removedProviders, ['cxt-old']);
    assert.ok(newText.includes("[projects.'D:\\a']"));
  });

  test('★ 用户自己的 provider 绝不碰', () => {
    const src = '[model_providers.mine]\nname = "我的"\nbase_url = "https://me/v1"\n';
    const { newText, report } = splice(src, { topLevel: TOP, provider: PROVIDER });
    assert.ok(newText.includes('[model_providers.mine]'));
    assert.ok(newText.includes('base_url = "https://me/v1"'));
    assert.deepEqual(report.removedProviders, []);
  });

  test('provider = null → 旧 section 被清掉且不写新的', () => {
    // 注意：`provider: null` 与 `model_provider` 同时出现是**非法**的（见下方守卫一节），
    // 所以这里 topLevel 只留 `model`——"这一轮没有 provider"的合法形态。
    const src = "[model_providers.cxt-relay-a]\nname = 'x'\n";
    const { newText, report } = splice(src, { topLevel: { model: 'deepseek-chat' }, provider: null });
    assert.equal(newText.trim(), "model = 'deepseek-chat'");
    assert.deepEqual(report.removedProviders, ['cxt-relay-a']);
    assert.equal(report.wroteProvider, null);
  });

  test('可选键照写：布尔与数字不加引号', () => {
    const { newText } = splice('', {
      provider: {
        id: 'cxt-a',
        values: {
          name: 'a', base_url: 'https://x/v1', env_key: 'K', wire_api: 'responses',
          requires_openai_auth: false, request_max_retries: 3,
        },
      },
    });
    assert.ok(newText.includes('requires_openai_auth = false'));
    assert.ok(newText.includes('request_max_retries = 3'));
  });

  test('键按 MANAGED_PROVIDER_KEYS 的顺序写（幂等的前提）', () => {
    const { newText } = splice('', {
      provider: {
        id: 'cxt-a',
        // 故意乱序传入
        values: { wire_api: 'responses', name: 'a', env_key: 'K', base_url: 'https://x' },
      },
    });
    const body = newText.split('\n').slice(1).filter((l) => l !== '');
    const order = body.map((l) => l.split(' = ')[0]);
    const expected = MANAGED_PROVIDER_KEYS.filter((k) => order.includes(k));
    assert.deepEqual(order, expected);
  });
});

// ═══════════════════════ 路径值 ═══════════════════════

describe('★ model_catalog_json 走 toTomlPathValue（转正斜杠，§7.5）', () => {
  test('反斜杠被转成正斜杠', () => {
    const { newText } = splice('', {
      topLevel: { model_catalog_json: 'C:\\Users\\Me\\.codex-multi-token\\models.json' },
    });
    assert.ok(newText.includes(
      'model_catalog_json = "C:/Users/Me/.codex-multi-token/models.json"',
    ));
    assert.ok(!newText.includes('C:\\Users'), '绝不能留下反斜杠');
  });

  test('其它受管键不享受这个待遇（只有路径键转）', () => {
    const { newText } = splice('', { topLevel: { model: 'a\\b' } });
    assert.ok(newText.includes("model = 'a\\b'"));
  });
});

// ═══════════════════════ 输入归一 ═══════════════════════

describe('★ 输出无 BOM + LF（§7.14①）', () => {
  test('BOM 被剥掉并报告', () => {
    const { newText, report } = splice('\uFEFFmodel = "old"\n', { topLevel: TOP });
    assert.equal(report.hadBom, true);
    assert.ok(!newText.includes('\uFEFF'));
    assert.equal(newText.charCodeAt(0), 'm'.charCodeAt(0));
  });

  test('无 BOM 时报告为 false', () => {
    assert.equal(splice('model = "old"\n', { topLevel: TOP }).report.hadBom, false);
  });

  test('CRLF 归一为 LF 并报告', () => {
    const src = 'approval_policy = "never"\r\n\r\nmodel = "old"\r\n';
    const { newText, report } = splice(src, { topLevel: TOP });
    assert.equal(report.normalizedEol, true);
    assert.ok(!newText.includes('\r'), '产物里不能有 CR');
  });

  test('★ 只有 BOM 变了也要报告 changed（文件确实需要重写）', () => {
    const src = '\uFEFFapproval_policy = "never"\n';
    const { newText, report } = splice(src, {});
    assert.equal(report.changed, true);
    assert.equal(newText, 'approval_policy = "never"\n');
  });
});

describe('末尾换行', () => {
  test('原文件有换行 → 产物有换行', () => {
    assert.ok(splice('model = "old"\n', { topLevel: TOP }).newText.endsWith('\n'));
  });

  test('原文件无换行 → 产物也不加', () => {
    const { newText } = splice('model = "old"', { topLevel: TOP });
    assert.ok(!newText.endsWith('\n'));
  });

  test('全新文件以换行收尾', () => {
    assert.ok(splice('', { topLevel: TOP }).newText.endsWith('\n'));
  });

  test('全空白文件当全新文件处理', () => {
    const { newText, report } = splice('\n\n  \n', { topLevel: TOP });
    assert.equal(report.created, true);
    assert.ok(!newText.startsWith('\n'));
  });
});

// ═══════════════════════ 完整性 ═══════════════════════

describe('★ 受管键出现两次 → 报错而非静默取第一个（§2.9 边界）', () => {
  test('顶层受管键重复', () => {
    assert.throws(
      () => splice('model = "a"\nmodel = "b"\n', { topLevel: TOP }),
      (err) => {
        assert.match(err.message, /出现了两次/);
        assert.equal(err.code, 3, '完整性错误退出码必须是 3');
        return true;
      },
    );
  });

  test('第二次出现在 section 之后不算重复（它是 section 的键）', () => {
    const src = 'model = "a"\n\n[foo]\nmodel = "b"\n';
    assert.doesNotThrow(() => splice(src, { topLevel: TOP }));
  });

  test('两个不同的受管键各出现一次是正常的', () => {
    assert.doesNotThrow(() => splice('model = "a"\nmodel_provider = "b"\n', { topLevel: TOP }));
  });
});

describe('★ 受管区不许扩大（§2.9 清单写死）', () => {
  test('未知的顶层受管键被拒', () => {
    assert.throws(
      () => splice('', { topLevel: { approval_policy: 'never' } }),
      /不在受管键清单里/,
    );
  });

  test('未知的 provider 键被拒', () => {
    assert.throws(
      () => splice('', { provider: { id: 'cxt-a', values: { sandbox_mode: 'x' } } }),
      /不在受管键清单里/,
    );
  });

  test('provider id 含 "." 被拒（会变成嵌套表）', () => {
    assert.throws(() => splice('', { provider: { id: 'a.b', values: {} } }), /不能含 "\."/);
  });

  test('清单本身没被偷偷加长', () => {
    assert.deepEqual([...MANAGED_TOP_LEVEL_KEYS], ['model', 'model_provider', 'model_catalog_json']);
    assert.ok(!MANAGED_PROVIDER_KEYS.includes(/** @type {any} */ ('approval_policy')));
    assert.ok(!MANAGED_PROVIDER_KEYS.includes(/** @type {any} */ ('sandbox_mode')));
  });
});

// ═══════════ ★ `model_provider` 必须与 provider section 成对同名（§7.8 真机）═══════════

/**
 * 真机实测（0.163.0）：`config.toml` 里出现 `model_provider` 却没有同名
 * `[model_providers.<id>]` 时，Codex **拒绝加载整个配置**
 * （`✗ config config could not be loaded` / `entity not found`）——
 * 不是忽略、不是警告。也就是说写出半份受管区 = 当场把用户的配置搞成不可加载。
 *
 * 这一节**故意绕过 helper 的自动配对**，直接调 `spliceManagedRegion`。
 */
describe('★ model_provider 必须与 provider section 成对同名（§7.8 真机）', () => {
  test('有 model_provider、没有 provider → 拒绝', () => {
    assert.throws(
      () => spliceManagedRegion({
        existingText: '',
        managedValues: { topLevel: { model: 'm', model_provider: 'cxt-a' } },
      }),
      (err) => err.name === 'IntegrityError' && /却没有 provider 定义/.test(err.message),
    );
  });

  test('provider = null 配 model_provider → 同样拒绝', () => {
    assert.throws(
      () => spliceManagedRegion({
        existingText: '',
        managedValues: { topLevel: { model_provider: 'cxt-a' }, provider: null },
      }),
      /却没有 provider 定义/,
    );
  });

  test('★ id 对不上 → 拒绝（否则写出的就是"引用不存在的 provider"）', () => {
    assert.throws(
      () => spliceManagedRegion({
        existingText: '',
        managedValues: {
          topLevel: { model: 'm', model_provider: 'cxt-a' },
          provider: { id: 'cxt-b', values: { name: 'b', base_url: 'https://b/v1' } },
        },
      }),
      (err) => err.name === 'IntegrityError' && /对不上/.test(err.message),
    );
  });

  test('只有 provider、没有 model_provider → 放行（孤立的 section 无害，真机验过）', () => {
    const { newText } = spliceManagedRegion({
      existingText: '',
      managedValues: { topLevel: { model: 'm' }, provider: PROVIDER },
    });
    assert.ok(newText.includes('[model_providers.cxt-relay-a]'));
    assert.ok(!newText.includes('model_provider ='));
  });

  test('成对同名 → 放行，且两条都写进去', () => {
    const { newText } = spliceManagedRegion({
      existingText: '',
      managedValues: { topLevel: TOP, provider: PROVIDER },
    });
    assert.ok(newText.includes("model_provider = 'cxt-relay-a'"));
    assert.ok(newText.includes('[model_providers.cxt-relay-a]'));
  });

  test('★ 拒绝时**不产出任何文本**——半份受管区绝不上盘', () => {
    let produced = null;
    try {
      spliceManagedRegion({
        existingText: 'approval_policy = "never"\n',
        managedValues: { topLevel: { model_provider: 'cxt-a' } },
      });
      produced = 'no-throw';
    } catch { /* 预期路径 */ }
    assert.equal(produced, null, '抛错路径上不该有任何 newText 被交出去');
  });
});

// ═══════════════════════ 幂等与报告 ═══════════════════════

describe('★ 幂等：同一份受管值连跑两次，第二次 changed 必为 false', () => {
  const CASES = [
    ['全新文件', ''],
    ['已有信任记录', "[projects.'D:\\a']\ntrust_level = \"trusted\"\n"],
    ['已有顶层键', 'approval_policy = "never"\nmodel = "old"\n'],
    ['已有陈旧 provider', '[model_providers.cxt-old]\nname = "x"\n'],
    ['多行值', 'model = [\n  "a",\n]\n'],
    ['CRLF + BOM', '\uFEFFmodel = "old"\r\n'],
    ['末尾无换行', 'model = "old"'],
  ];

  for (const [label, src] of CASES) {
    test(label, () => {
      const mv = { topLevel: TOP, provider: PROVIDER };
      const first = splice(src, mv);
      const second = splice(first.newText, mv);
      assert.equal(second.newText, first.newText, '第二次的产物必须与第一次逐字节相同');
      assert.equal(second.report.changed, false);
    });
  }
});

describe('报告字段', () => {
  test('全新文件：created + 全部 inserted', () => {
    const { report } = splice('', { topLevel: TOP, provider: PROVIDER });
    assert.equal(report.created, true);
    assert.deepEqual(report.insertedTopLevel, ['model', 'model_provider']);
    assert.deepEqual(report.replacedTopLevel, []);
    assert.equal(report.wroteProvider, 'cxt-relay-a');
    assert.equal(report.replacedProvider, null);
  });

  test('★ 陈旧受管键被删时记进 removedTopLevel', () => {
    // 上一轮 token 有 catalog，这一轮没有了 → 必须删掉，否则旧路径继续生效
    const { newText, report } = splice(
      'model_catalog_json = "D:/old.json"\n',
      { topLevel: TOP },
    );
    assert.deepEqual(report.removedTopLevel, ['model_catalog_json']);
    assert.ok(!newText.includes('old.json'));
  });

  test('无变化时 changed = false', () => {
    // src 就是拼接器自己的产物（含 provider section）——再跑一次必须一个字节都不动
    const src = "model = 'deepseek-chat'\nmodel_provider = 'cxt-relay-a'\n"
      + `\n${PROVIDER_BLOCK}\n`;
    assert.equal(splice(src, { topLevel: TOP }).report.changed, false);
  });
});

// ═══════════════════════ 端到端样本 ═══════════════════════

describe('端到端：一份像真文件的 config.toml', () => {
  const SRC = [
    '# Codex 配置（这份文件由 cxt 与 Codex 共同维护）',
    'approval_policy = "on-request"',
    '',
    '[model_providers.mine]',
    'name = "我自己接的"',
    'base_url = "https://mine.example/v1"',
    '',
    "[projects.'D:\\work\\client-a']",
    'trust_level = "trusted"',
    '',
    "[projects.'D:\\work\\client-b']",
    'trust_level = "untrusted"',
    '',
  ].join('\n');

  test('受管区写进去，别人的东西一个字节都没动', () => {
    const { newText } = splice(SRC, { topLevel: TOP, provider: PROVIDER });

    // 用户的四样东西全在
    for (const line of [
      '# Codex 配置（这份文件由 cxt 与 Codex 共同维护）',
      'approval_policy = "on-request"',
      '[model_providers.mine]',
      'name = "我自己接的"',
      "[projects.'D:\\work\\client-a']",
      'trust_level = "trusted"',
      "[projects.'D:\\work\\client-b']",
      'trust_level = "untrusted"',
    ]) {
      assert.ok(newText.includes(line), `丢了：${line}`);
    }

    // 受管区在第一个 section 之前
    assert.ok(newText.indexOf("model = 'deepseek-chat'") < newText.indexOf('[model_providers.mine]'));
    assert.ok(newText.includes(PROVIDER_BLOCK));
    assert.ok(!newText.includes('\r') && !newText.includes('\uFEFF'));
  });

  test('再跑一次完全稳定', () => {
    const once = splice(SRC, { topLevel: TOP, provider: PROVIDER }).newText;
    const twice = splice(once, { topLevel: TOP, provider: PROVIDER });
    assert.equal(twice.newText, once);
    assert.equal(twice.report.changed, false);
  });
});
