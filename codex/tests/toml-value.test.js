// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { toTomlPathKey, toTomlPathValue, toTomlValue } from '../src/core/toml-value.js';

// ───────────────────────── 通用值：字符串 ─────────────────────────

describe('toTomlValue —— 字符串引号选择（§7.14 末尾）', () => {
  test('普通串用字面字符串（零转义，手工复制到 shell 也不会炸）', () => {
    assert.equal(toTomlValue('abc'), "'abc'");
    assert.equal(toTomlValue('deepseek-chat'), "'deepseek-chat'");
    assert.equal(toTomlValue(''), "''");
  });

  test('双引号在字面字符串里不是特殊字符', () => {
    assert.equal(toTomlValue('say "hi"'), `'say "hi"'`);
  });

  test('tab 是字面字符串唯一允许的控制字符', () => {
    assert.equal(toTomlValue('a\tb'), "'a\tb'");
  });

  test('★ 含单引号 → 退化为转义基本字符串', () => {
    // 字面字符串不能含 '，硬写会截断 TOML 字符串、把后面整段配置吞掉
    assert.equal(toTomlValue("it's"), `"it's"`);
  });

  test('反斜杠：字面字符串里原样穿过，基本字符串里必须转义', () => {
    // 同一条路径，走哪条分支由"有没有单引号"决定
    assert.equal(toTomlValue('D:\\work\\x'), "'D:\\work\\x'");
    assert.equal(toTomlValue("D:\\it's\\x"), `"D:\\\\it's\\\\x"`);
  });

  test('含单引号时反斜杠成对转义（否则 TOML 会吞字符）', () => {
    // 断言的是字面文本：输出必须是 "a\\'b"（两个反斜杠 + 单引号 + b）
    const out = toTomlValue("a\\'b");
    assert.equal(out, '"a\\\\\'b"');
    assert.equal(out.slice(1, -1), 'a\\\\\'b');
  });

  test('★ 换行与控制字符必须转义——裸写会拆散整份配置', () => {
    assert.equal(toTomlValue('a\nb'), '"a\\nb"');
    assert.equal(toTomlValue('a\r\nb'), '"a\\r\\nb"');
    assert.equal(toTomlValue('a\u0001b'), '"a\\u0001b"');
    assert.equal(toTomlValue('a\u007fb'), '"a\\u007Fb"');
  });

  test('含 ${ENV_VAR} 的串原样写——本层不做引用求值（§2.4）', () => {
    assert.equal(toTomlValue('${MY_KEY}'), "'${MY_KEY}'");
  });

  test('非 ASCII 原样保留（TOML 是 UTF-8）', () => {
    assert.equal(toTomlValue('模型-甲'), "'模型-甲'");
  });
});

// ───────────────────────── 通用值：标量 ─────────────────────────

describe('toTomlValue —— 布尔与数字', () => {
  test('布尔裸写', () => {
    assert.equal(toTomlValue(true), 'true');
    assert.equal(toTomlValue(false), 'false');
  });

  test('★ 字符串 "true" 与布尔 true 是两种不同的 TOML 值', () => {
    // 这正是 §7.14 🟡 那条歧义的根：我们靠"字符串带引号"把它钉死。
    // 不过 shell 时没有这层歧义，但兜底 launch 脚本要处理
    assert.equal(toTomlValue('true'), "'true'");
    assert.notEqual(toTomlValue('true'), toTomlValue(true));
  });

  test('整数与浮点', () => {
    assert.equal(toTomlValue(0), '0');
    assert.equal(toTomlValue(42), '42');
    assert.equal(toTomlValue(-7), '-7');
    assert.equal(toTomlValue(1.5), '1.5');
  });

  test('大数与极小值走指数写法，仍是合法 TOML 浮点', () => {
    assert.match(toTomlValue(1e21), /^1e\+21$/);
    assert.match(toTomlValue(1e-7), /^1e-7$/);
  });

  test('★ NaN / Infinity 报错，绝不写出去', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      assert.throws(() => toTomlValue(v), /TOML 不支持/, `应拒绝 ${v}`);
    }
  });
});

// ───────────────────────── 通用值：容器 ─────────────────────────

describe('toTomlValue —— 数组', () => {
  test('空数组', () => {
    assert.equal(toTomlValue([]), '[]');
  });

  test('元素递归序列化', () => {
    assert.equal(toTomlValue(['a', 'b']), "['a', 'b']");
    assert.equal(toTomlValue([1, true, 'x']), "[1, true, 'x']");
    assert.equal(toTomlValue([['a'], []]), "[['a'], []]");
  });
});

describe('toTomlValue —— 内联表（§7.14 末尾：优先字面字符串）', () => {
  test('空表', () => {
    assert.equal(toTomlValue({}), '{}');
  });

  test('★ 无尾逗号——TOML 1.0 内联表不允许', () => {
    const out = toTomlValue({ a: 1, b: 'x' });
    assert.equal(out, "{ a = 1, b = 'x' }");
    assert.ok(!/,\s*\}/.test(out), `内联表出现了尾逗号：${out}`);
  });

  test('嵌套', () => {
    assert.equal(
      toTomlValue({ name: 'fake', tags: ['a'], sub: { k: 1 } }),
      "{ name = 'fake', tags = ['a'], sub = { k = 1 } }",
    );
  });

  test('裸键不加引号，特殊键加引号', () => {
    assert.equal(toTomlValue({ 'my-key_1': 1 }), '{ my-key_1 = 1 }');
    assert.equal(toTomlValue({ 'a b': 1 }), "{ 'a b' = 1 }");
    assert.equal(toTomlValue({ 'a.b': 1 }), "{ 'a.b' = 1 }");
  });

  test('★ provider 定义的真实形状（§7.9）', () => {
    // 这是 cxt 真正要写进 -c 的那种值，拿来当端到端样本
    const provider = {
      name: 'cxt relay-a',
      base_url: 'https://api.example.com/v1',
      env_key: 'CXT_TOKEN_RELAY_A',
      wire_api: 'responses',
    };
    assert.equal(
      toTomlValue(provider),
      "{ name = 'cxt relay-a', base_url = 'https://api.example.com/v1',"
        + " env_key = 'CXT_TOKEN_RELAY_A', wire_api = 'responses' }",
    );
  });
});

describe('toTomlValue —— 拒绝 TOML 里不存在的东西', () => {
  test('null / undefined 报错，不悄悄变成空串', () => {
    assert.throws(() => toTomlValue(null), /TOML 没有 null/);
    assert.throws(() => toTomlValue(undefined), /TOML 没有 null/);
  });

  test('函数 / Symbol / BigInt 报错', () => {
    assert.throws(() => toTomlValue(() => {}), /无法把 function/);
    assert.throws(() => toTomlValue(Symbol('x')), /无法把 symbol/);
    assert.throws(() => toTomlValue(1n), /无法把 bigint/);
  });

  test('★ 数组里的 null 同样报错（不能只查顶层）', () => {
    assert.throws(() => toTomlValue(['a', null]), /TOML 没有 null/);
    assert.throws(() => toTomlValue({ k: null }), /TOML 没有 null/);
  });
});

// ═══════════════════════ ★ 两条相反的路径规则 ═══════════════════════
//
// §6.3 把"Windows 路径转正斜杠"列在 toTomlValue 名下；本模块把它拆成
// `toTomlPathValue`——因为通用序列化器无从判断"这个字符串是不是一条路径"。
// 契约要的是"两条规则相反、绝不共用归一化"，下面的断言直接钉这件事。

describe('★ 路径作为「值」：toTomlPathValue —— 转正斜杠', () => {
  test('Windows 路径转正斜杠（§2.11 三·1 表末行）', () => {
    assert.equal(toTomlPathValue('D:\\work\\x'), '"D:/work/x"');
    assert.equal(
      toTomlPathValue('C:\\Users\\Me\\.codex-multi-token\\models.json'),
      '"C:/Users/Me/.codex-multi-token/models.json"',
    );
  });

  test('★ 输出里绝不残留反斜杠', () => {
    // 反斜杠在 TOML 基本字符串里是转义符——残留一个就可能拼出 \U 之类的非法转义
    const out = toTomlPathValue('D:\\work\\a\\b');
    assert.ok(!out.includes('\\'), `不应出现反斜杠：${out}`);
  });

  test('POSIX 路径是恒等变换', () => {
    assert.equal(toTomlPathValue('/home/t/.codex-multi-token/models.json'),
      '"/home/t/.codex-multi-token/models.json"');
  });

  test('混合分隔符也统一成 /', () => {
    assert.equal(toTomlPathValue('D:\\work/sub\\x'), '"D:/work/sub/x"');
  });
});

describe('★ 路径作为「表键」：toTomlPathKey —— 保留反斜杠', () => {
  test('§7.3 实测能匹配的写法：字面字符串 + 反斜杠', () => {
    assert.equal(
      toTomlPathKey('C:\\Users\\alice\\codex-test-proj'),
      "'C:\\Users\\alice\\codex-test-proj'",
    );
  });

  test('★ 绝不转正斜杠——那会静默失配（§7.3 规则表）', () => {
    const key = toTomlPathKey('D:\\work\\a');
    assert.equal(key, "'D:\\work\\a'");
    assert.ok(key.includes('\\'), `必须保留反斜杠：${key}`);
    assert.ok(!key.includes('/'), `绝不能出现正斜杠：${key}`);
  });

  test('★ 含单引号 → 退化为转义基本字符串（§7.3 铁律 2）', () => {
    assert.equal(toTomlPathKey("D:\\it's\\a"), `"D:\\\\it's\\\\a"`);
  });

  test('路径含空格不需要退化（字面字符串可以含空格）', () => {
    assert.equal(toTomlPathKey('D:\\work\\a b'), "'D:\\work\\a b'");
  });

  test('★ 不做归一化：正斜杠输入原样返回，不"顺手修好"', () => {
    // 契约 §7.3 铁律 4："写的是用户给的字面路径"。
    // 分隔符的平台转换由 trust.js 在调用前做——那里才有 platform。
    // 本函数若擅自转换，就变成了第三个"路径归一化"，正是要防的事。
    assert.equal(toTomlPathKey('D:/work/a'), "'D:/work/a'");
    assert.equal(toTomlPathKey('c:\\users\\me'), "'c:\\users\\me'");
  });

  test('不做 NFC 归一（§7.3 铁律 4）', () => {
    const nfd = 'D:\\cafe\u0301';   // e + 组合尖音符
    const nfc = 'D:\\caf\u00e9';    // é
    assert.notEqual(toTomlPathKey(nfd), toTomlPathKey(nfc));
    assert.equal(toTomlPathKey(nfd), `'${nfd}'`);
  });

  test('返回的是**含引号**的键，可直接拼进 [projects.<键>]', () => {
    assert.match(toTomlPathKey('D:\\a'), /^'.*'$/);
    assert.equal(`[projects.${toTomlPathKey('D:\\a')}]`, "[projects.'D:\\a']");
  });
});

describe('★ 两个函数必须保持相反（防止有人"统一"它们）', () => {
  test('同一输入产出不同结果', () => {
    const p = 'D:\\work\\a';
    assert.notEqual(toTomlPathValue(p), toTomlPathKey(p));
  });

  test('值里没有反斜杠、键里有反斜杠', () => {
    const p = 'D:\\work\\a';
    assert.ok(!toTomlPathValue(p).includes('\\'));
    assert.ok(toTomlPathKey(p).includes('\\'));
  });

  test('是两个不同的函数对象', () => {
    assert.notEqual(toTomlPathValue, toTomlPathKey);
  });

  test('★ 通用 toTomlValue 不替谁做决定：反斜杠原样穿过（靠字面字符串）', () => {
    // 这正是"不能只靠一个通用函数"的理由：它无从知道这个串是不是路径，
    // 于是走字面字符串把字节原样留住。要转正斜杠必须显式调 toTomlPathValue。
    assert.equal(toTomlValue('D:\\work\\a'), "'D:\\work\\a'");
  });
});
