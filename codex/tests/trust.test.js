// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRUST_LEVELS, canonicalizeTrustPath, parseTrustEntries, readTrust, spliceTrust,
} from '../src/core/trust.js';

/** 断言抛的是完整性错误（退出码 3）——这类错误**绝不静默继续**（§6.2） */
const integrity = { name: 'IntegrityError' };
/** 断言抛的是用户错误（退出码 1） */
const userError = { name: 'CxtError' };

// 测试里反复出现的两条路径。JS 字面量里的 `\\` 是**一个**反斜杠，
// 与 TOML 字面字符串里的反斜杠一一对应——这正是 §7.3 要求写进文件的形态。
const P = 'D:\\work\\client-a';
const OTHER = 'D:\\work\\other';

// ═══════════════════════ canonicalizeTrustPath ═══════════════════════

describe('canonicalizeTrustPath —— 输入侧规整成「Codex 认得出的写形」', () => {
  test('已经是规范写形 → 原样返回（幂等）', () => {
    assert.equal(canonicalizeTrustPath(P, 'win32'), P);
  });

  test('★ 正斜杠必须转成反斜杠——这是最容易写错、且完全静默的一步（§7.3 铁律 1）', () => {
    assert.equal(canonicalizeTrustPath('D:/work/client-a', 'win32'), P);
    assert.equal(canonicalizeTrustPath('D:\\work/client-a', 'win32'), P);
  });

  test('去尾部分隔符，但保留「根」的形态', () => {
    assert.equal(canonicalizeTrustPath('D:\\work\\client-a\\', 'win32'), P);
    assert.equal(canonicalizeTrustPath('D:\\', 'win32'), 'D:\\');
    assert.equal(canonicalizeTrustPath('/', 'linux'), '/');
    assert.equal(canonicalizeTrustPath('/home/a/', 'linux'), '/home/a');
  });

  test('★ 剥掉 \\\\?\\ 前缀——带着它永不匹配（§7.3 规则表末行）', () => {
    assert.equal(canonicalizeTrustPath(`\\\\?\\${P}`, 'win32'), P);
    assert.equal(canonicalizeTrustPath('\\\\?\\UNC\\srv\\share', 'win32'), '\\\\srv\\share');
  });

  test('词法规整（`.` / `..` / 重复分隔符）——cwd 里不会出现这些', () => {
    assert.equal(canonicalizeTrustPath('D:\\work\\.\\client-a', 'win32'), P);
    assert.equal(canonicalizeTrustPath('D:\\work\\x\\..\\client-a', 'win32'), P);
    assert.equal(canonicalizeTrustPath('D:\\\\work\\\\client-a', 'win32'), P);
  });

  test('POSIX 平台不把反斜杠当分隔符（Linux 上那是合法文件名字符）', () => {
    assert.equal(canonicalizeTrustPath('/home/a\\b', 'linux'), '/home/a\\b');
    assert.equal(canonicalizeTrustPath('/home/a/b', 'linux'), '/home/a/b');
  });

  test('相对路径直接拒绝——Codex 拿它跟 cwd 比字符串，永远匹配不上', () => {
    assert.throws(() => canonicalizeTrustPath('work/a', 'win32'), userError);
    assert.throws(() => canonicalizeTrustPath('work/a', 'linux'), userError);
  });

  test('空路径拒绝', () => {
    assert.throws(() => canonicalizeTrustPath('', 'win32'), userError);
    assert.throws(() => canonicalizeTrustPath('   ', 'win32'), userError);
  });
});

// ═══════════════════════ readTrust：三态 ═══════════════════════

describe('readTrust —— 三态，不是二态（§7.3）', () => {
  test('trusted', () => {
    const t = `[projects.'${P}']\ntrust_level = "trusted"\n`;
    const r = readTrust(t, P, 'win32');
    assert.equal(r.state, 'trusted');
    assert.equal(r.entry?.line, 0);
  });

  test('★ untrusted（显式拒绝）与 unmarked（从未标记）语义不同——必须分开', () => {
    // 前者 resolved 成 UnlessTrusted，后者是 OnRequest。混为一谈会让用户困惑于
    // "我明明没标记过它，为什么说我不信任"
    const explicit = readTrust(`[projects.'${P}']\ntrust_level = "untrusted"\n`, P, 'win32');
    assert.equal(explicit.state, 'untrusted');

    const never = readTrust(`[projects.'${OTHER}']\ntrust_level = "trusted"\n`, P, 'win32');
    assert.equal(never.state, 'unmarked');
    assert.equal(never.entry, null);
  });

  test('表在、trust_level 键不在 → unmarked（不是 trusted）', () => {
    const r = readTrust(`[projects.'${P}']\n`, P, 'win32');
    assert.equal(r.state, 'unmarked');
    assert.equal(r.entry?.level, null);
  });

  test('空文件 → unmarked', () => {
    assert.equal(readTrust('', P, 'win32').state, 'unmarked');
  });
});

// ═══════════════════════ 匹配规则（§7.3 实测表逐行）═══════════════════════

describe('★ 路径匹配规则——每条都对应 §7.3 实测表里的一行', () => {
  test('大小写不敏感 → 命中（不是 near-miss）', () => {
    const t = "[projects.'d:\\WORK\\client-a']\ntrust_level = \"trusted\"\n";
    const r = readTrust(t, P, 'win32');
    assert.equal(r.state, 'trusted');
    assert.deepEqual(r.nearMisses, []);
  });

  test('转义基本字符串 `"D:\\\\work\\\\client-a"` → 解析后同一个串 → 命中', () => {
    const t = '[projects."D:\\\\work\\\\client-a"]\ntrust_level = "trusted"\n';
    assert.equal(readTrust(t, P, 'win32').state, 'trusted');
  });

  test('★★ 正斜杠写法：**不命中**，而是 near-miss（本条是本模块存在的理由）', () => {
    // 若这里判成"命中"，cxt trust 就再也不会去修它——用户永远看到"我明明信任过了"，
    // 而 Codex 那边其实一直没生效。bindings.js 的 normalizeForCompare 正是这种折法。
    const t = '[projects."D:/work/client-a"]\ntrust_level = "trusted"\n';
    const r = readTrust(t, P, 'win32');
    assert.equal(r.state, 'unmarked');
    assert.equal(r.nearMisses.length, 1);
    assert.equal(r.nearMisses[0].path, 'D:/work/client-a');
    assert.equal(r.nearMisses[0].line, 1);
    assert.equal(r.nearMisses[0].reason, '用了正斜杠');
  });

  test('★ 父目录不继承（§7.3 铁律 3）', () => {
    const t = "[projects.'D:\\work']\ntrust_level = \"trusted\"\n";
    const r = readTrust(t, P, 'win32');
    assert.equal(r.state, 'unmarked');
    // 也不是 near-miss——那是另一个目录，不是"写法错"
    assert.deepEqual(r.nearMisses, []);
  });

  test('★ 尾部分隔符不匹配 → near-miss', () => {
    const t = `[projects.'${P}\\']\ntrust_level = "trusted"\n`;
    const r = readTrust(t, P, 'win32');
    assert.equal(r.state, 'unmarked');
    assert.equal(r.nearMisses[0].reason, '尾部多了分隔符');
  });

  test('★ \\\\?\\ 前缀不匹配 → near-miss', () => {
    const t = `[projects.'\\\\?\\${P}']\ntrust_level = "trusted"\n`;
    const r = readTrust(t, P, 'win32');
    assert.equal(r.state, 'unmarked');
    assert.equal(r.nearMisses[0].reason, '带了 \\\\?\\ 前缀');
  });

  test('混合分隔符 → near-miss', () => {
    const t = "[projects.'D:\\work/client-a']\ntrust_level = \"trusted\"\n";
    assert.equal(readTrust(t, P, 'win32').state, 'unmarked');
    assert.equal(readTrust(t, P, 'win32').nearMisses.length, 1);
  });

  test('Linux 上大小写敏感：`d:\\work\\client-a` 不命中', () => {
    // 与 Windows 相反——这条守着"别把平台规则统一掉"
    const t = `[projects.'/home/a']\ntrust_level = "trusted"\n`;
    assert.equal(readTrust(t, '/home/a', 'linux').state, 'trusted');
    assert.equal(readTrust(t, '/HOME/a', 'linux').state, 'unmarked');
    assert.equal(readTrust(t, '/HOME/a', 'linux').nearMisses.length, 0);
  });
});

// ═══════════════════════ spliceTrust：写入 ═══════════════════════

describe('spliceTrust —— 新增', () => {
  test('★ 写出来的是「TOML 字面字符串 + 原生反斜杠」，且只写 trust_level 一个键', () => {
    const { newText, report } = spliceTrust('', { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(newText, `[projects.'${P}']\ntrust_level = 'trusted'\n`);
    assert.equal(report.action, 'added');
    assert.equal(report.changed, true);
    assert.equal(report.created, true);
    assert.equal(report.line, 2);
    assert.equal(report.path, P);
  });

  test('★ 用户传正斜杠 → 写出来仍是反斜杠（否则 Codex 静默不认）', () => {
    const { newText } = spliceTrust('', { path: 'D:/work/client-a', level: 'trusted', platform: 'win32' });
    assert.ok(newText.includes(`[projects.'${P}']`));
    assert.ok(!newText.includes('D:/work/client-a'));
  });

  test('追加在文件末尾，不动任何既有行（包括末尾空行）', () => {
    const before = '[model_providers.x]\nname = \'x\'\n\n';
    const { newText } = spliceTrust(before, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(newText, `${before}[projects.'${P}']\ntrust_level = 'trusted'\n`);
  });

  test('★ 幂等：同样的参数连跑两次，第二次 changed === false', () => {
    const one = spliceTrust('', { path: P, level: 'trusted', platform: 'win32' });
    const two = spliceTrust(one.newText, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(two.report.changed, false);
    assert.equal(two.report.action, 'unchanged');
    assert.equal(two.newText, one.newText);
  });
});

describe('spliceTrust —— 改写既有条目', () => {
  const base = [
    '# 我的配置（这行注释必须原样留着）',
    `[projects.'${P}']`,
    'trust_level = "trusted"',
    '',
    `[projects.'${OTHER}']`,
    'trust_level = "untrusted"',
    '',
  ].join('\n');

  test('★ 写入不删其它 [projects.*] 条目（§2.9 铁律 2）', () => {
    const { newText } = spliceTrust(base, { path: 'D:\\work\\third', level: 'trusted', platform: 'win32' });
    assert.ok(newText.includes(`[projects.'${P}']`));
    assert.ok(newText.includes(`[projects.'${OTHER}']`));
    assert.ok(newText.includes(`[projects.'D:\\work\\third']`));
    assert.ok(newText.includes('# 我的配置（这行注释必须原样留着）'));
    assert.equal(parseTrustEntries(newText).length, 3);
  });

  test('★ --untrust 不删条目，只改值', () => {
    const { newText, report } = spliceTrust(base, { path: P, level: 'untrusted', platform: 'win32' });
    assert.equal(report.action, 'updated');
    assert.equal(parseTrustEntries(newText).length, 2);
    assert.equal(readTrust(newText, P, 'win32').state, 'untrusted');
    // 另一条**逐字节**未动（连引号风格都还是原来那双引号）
    assert.ok(newText.includes(`[projects.'${OTHER}']\ntrust_level = "untrusted"\n`));
    assert.ok(newText.includes('# 我的配置（这行注释必须原样留着）'));
  });

  test('表在、trust_level 键不在 → 插在表头正下方', () => {
    const { newText, report } = spliceTrust(`[projects.'${P}']\n`, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(newText, `[projects.'${P}']\ntrust_level = 'trusted'\n`);
    assert.equal(report.action, 'added');
    assert.equal(report.line, 2);
  });

  test('值已经是目标值 → 不动', () => {
    const t = `[projects.'${P}']\ntrust_level = 'trusted'\n`;
    const { newText, report } = spliceTrust(t, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(report.changed, false);
    assert.equal(report.action, 'unchanged');
    assert.equal(newText, t);
  });

  test('大小写不同的条目算命中 → 只改值，不新增、不修表头', () => {
    const t = "[projects.'d:\\work\\client-a']\ntrust_level = \"trusted\"\n";
    const { newText, report } = spliceTrust(t, { path: P, level: 'untrusted', platform: 'win32' });
    assert.equal(report.action, 'updated');
    assert.equal(report.repairedFrom, null);
    assert.equal(parseTrustEntries(newText).length, 1);
  });
});

describe('★ spliceTrust —— 就地修好「写法认不出」的条目', () => {
  test('正斜杠条目 → 改成反斜杠（只改表头那一行）', () => {
    const t = '[projects."D:/work/client-a"]\ntrust_level = "trusted"\n';
    const { newText, report } = spliceTrust(t, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(report.action, 'repaired');
    assert.equal(report.repairedFrom, 'D:/work/client-a');
    assert.equal(newText, `[projects.'${P}']\ntrust_level = 'trusted'\n`);
    // 修完真的生效了
    assert.equal(readTrust(newText, P, 'win32').state, 'trusted');
  });

  test('★ 修复是「就地改」，不是「再追加一条」——追加会撞成重复表，整个文件作废', () => {
    const t = '[projects."D:/work/client-a"]\ntrust_level = "trusted"\n';
    const { newText } = spliceTrust(t, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(parseTrustEntries(newText).length, 1);
  });

  test('修复也幂等：修完再跑一次 → unchanged', () => {
    const t = '[projects."D:/work/client-a"]\ntrust_level = "trusted"\n';
    const one = spliceTrust(t, { path: P, level: 'trusted', platform: 'win32' });
    const two = spliceTrust(one.newText, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(two.report.changed, false);
  });

  test('尾部分隔符的条目 → 去掉尾部', () => {
    const { newText, report } = spliceTrust(
      `[projects.'${P}\\']\ntrust_level = "trusted"\n`,
      { path: P, level: 'trusted', platform: 'win32' },
    );
    assert.equal(report.action, 'repaired');
    assert.equal(newText, `[projects.'${P}']\ntrust_level = 'trusted'\n`);
  });

  test('★ 有多条写坏的条目时只修第一条，其余点名上报（修两条会变重复表）', () => {
    const t = [
      '[projects."D:/work/client-a"]',
      'trust_level = "trusted"',
      '',
      `[projects.'${P}\\']`,
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const { newText, report } = spliceTrust(t, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(report.repairedFrom, 'D:/work/client-a');
    assert.equal(report.nearMisses.length, 1);
    assert.equal(report.nearMisses[0].line, 4);
    // 文件里仍然只有一条**认得出**的
    assert.equal(readTrust(newText, P, 'win32').state, 'trusted');
  });
});

describe('spliceTrust —— dotted 形式（二进制自己就这么写，§7.3 铁律 5）', () => {
  test('读得出', () => {
    const t = `projects.'${P}'.trust_level = "trusted"\n`;
    const r = readTrust(t, P, 'win32');
    assert.equal(r.state, 'trusted');
    assert.equal(r.entry?.form, 'dotted');
  });

  test('改值保持 dotted 形态', () => {
    const t = `projects.'${P}'.trust_level = "trusted"\n`;
    const { newText, report } = spliceTrust(t, { path: P, level: 'untrusted', platform: 'win32' });
    assert.equal(newText, `projects.'${P}'.trust_level = 'untrusted'\n`);
    assert.equal(report.action, 'updated');
  });

  test('dotted 形式写坏 → 就地改成规范写形', () => {
    const t = 'projects."D:/work/client-a".trust_level = "trusted"\n';
    const { newText, report } = spliceTrust(t, { path: P, level: 'trusted', platform: 'win32' });
    assert.equal(report.action, 'repaired');
    assert.equal(newText, `projects.'${P}'.trust_level = 'trusted'\n`);
  });
});

// ═══════════════════════ 完整性：绝不写出坏文件 ═══════════════════════

describe('★ 完整性错误（退出码 3）——遇到就停下，绝不静默继续（§6.2）', () => {
  test('同一张表定义两次 → 报错（TOML 本身就不允许）', () => {
    const t = `[projects.'${P}']\ntrust_level = "trusted"\n\n[projects.'${P}']\ntrust_level = "trusted"\n`;
    assert.throws(() => parseTrustEntries(t), integrity);
  });

  test('trust_level 出现两次 → 报错（静默取第一个会让结果取决于文件顺序）', () => {
    const t = `[projects.'${P}']\ntrust_level = "trusted"\ntrust_level = "untrusted"\n`;
    assert.throws(() => parseTrustEntries(t), integrity);
  });

  test('数组表 [[projects.x]] → 报错', () => {
    const t = `[[projects.'${P}']]\ntrust_level = "trusted"\n`;
    assert.throws(() => parseTrustEntries(t), integrity);
  });

  test('projects 被写成了一个值 → 报错', () => {
    assert.throws(() => parseTrustEntries('projects = "x"\n'), integrity);
  });

  test('内联表形式 → 报错并给出改写命令（改不了就别装作改了）', () => {
    const t = `projects.'${P}' = { trust_level = "trusted" }\n`;
    assert.throws(
      () => spliceTrust(t, { path: P, level: 'trusted', platform: 'win32' }),
      integrity,
    );
  });

  test('归一后重复（大小写不同但同一条路径）→ 报错', () => {
    const t = "[projects.'d:\\work\\client-a']\ntrust_level = \"trusted\"\n\n"
      + `[projects.'${P}']\ntrust_level = "untrusted"\n`;
    assert.throws(() => readTrust(t, P, 'win32'), integrity);
  });

  test('level 不是 trusted / untrusted → 用户错误（不是完整性错误）', () => {
    assert.deepEqual([...TRUST_LEVELS], ['trusted', 'untrusted']);
    assert.throws(() => spliceTrust('', { path: P, level: 'maybe', platform: 'win32' }), userError);
  });
});

// ═══════════════════════ 解析边界 ═══════════════════════

describe('parseTrustEntries —— 只认真正的条目', () => {
  test('多行字符串里的「假条目」不算条目', () => {
    // 顶层键值对必须整段跳过（含多行值），否则 `parseKeyValue` 只看单行，会认得出这行
    const t = 'note = """\n'
      + `projects.'${P}'.trust_level = "trusted"\n`
      + '"""\n';
    assert.deepEqual(parseTrustEntries(t), []);
    assert.equal(readTrust(t, P, 'win32').state, 'unmarked');
  });

  test('多行数组值里的行不被误读', () => {
    const t = 'notify = [\n  "a",\n  "b",\n]\n\n'
      + `[projects.'${P}']\ntrust_level = "trusted"\n`;
    assert.equal(parseTrustEntries(t).length, 1);
  });

  test('section 里的注释与空行不影响解析', () => {
    const t = `[projects.'${P}']\n# 我信任这个目录\ntrust_level = "trusted"\n`;
    assert.equal(readTrust(t, P, 'win32').state, 'trusted');
  });

  test('带引号与空格、含 `]` 的路径解析正确', () => {
    const weird = 'D:\\work\\a b]c';
    const t = `[projects.'${weird}']\ntrust_level = "trusted"\n`;
    assert.equal(readTrust(t, weird, 'win32').state, 'trusted');
  });

  test('路径含单引号 → 退化为转义基本字符串，仍能读回', () => {
    const q = "D:\\work\\it's";
    const { newText } = spliceTrust('', { path: q, level: 'trusted', platform: 'win32' });
    assert.ok(newText.includes('"D:\\\\work\\\\it\'s"'));
    assert.equal(readTrust(newText, q, 'win32').state, 'trusted');
  });

  test('不碰别的 section 里的同名键', () => {
    const t = `[other.'${P}']\ntrust_level = "trusted"\n`;
    assert.deepEqual(parseTrustEntries(t), []);
  });
});

// ═══════════════════════ BOM / CRLF（§7.14①）═══════════════════════

describe('BOM 与 CRLF 归一', () => {
  test('★ 带 BOM 的文件能读，产物不带 BOM', () => {
    const t = `\uFEFF[projects.'${P}']\ntrust_level = "trusted"\n`;
    assert.equal(readTrust(t, P, 'win32').state, 'trusted');
    const { newText, report } = spliceTrust(t, { path: P, level: 'untrusted', platform: 'win32' });
    assert.equal(report.hadBom, true);
    assert.ok(!newText.startsWith('\uFEFF'));
  });

  test('★ CRLF 归一为 LF——写信任不能成为唯一往文件里塞 CR 的路径', () => {
    const t = `[projects.'${P}']\r\ntrust_level = "trusted"\r\n`;
    const { newText, report } = spliceTrust(t, { path: P, level: 'untrusted', platform: 'win32' });
    assert.equal(report.normalizedEol, true);
    assert.ok(!newText.includes('\r'));
  });

  test('原文件末尾没有换行 → 产物也不加', () => {
    const t = `[projects.'${P}']\ntrust_level = "trusted"`;
    const { newText } = spliceTrust(t, { path: P, level: 'untrusted', platform: 'win32' });
    assert.equal(newText.endsWith('\n'), false);
  });
});
