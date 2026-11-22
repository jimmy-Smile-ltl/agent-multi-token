// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findExactBinding,
  looksLikeShortName,
  matchBinding,
  normalizeForCompare,
  rulesFor,
} from '../src/core/bindings.js';

// ───────────────────────────── 样本 ─────────────────────────────

const B = (path, extra = {}) => ({ path, ...extra });

// ═══════════════════ ★ 平台规则：三套互不串味 ═══════════════════

describe('★ 平台规则表（§2.3）', () => {
  test('Windows：大小写不敏感 + `\\` 是分隔符 + 不做 Unicode 归一', () => {
    assert.deepEqual(rulesFor('win32'), {
      caseInsensitive: true, backslashIsSeparator: true, nfcNormalize: false,
    });
  });

  test('macOS：大小写不敏感 + `\\` 不是分隔符 + **做 NFC 归一**', () => {
    assert.deepEqual(rulesFor('darwin'), {
      caseInsensitive: true, backslashIsSeparator: false, nfcNormalize: true,
    });
  });

  test('Linux：大小写**敏感** + `\\` 不是分隔符 + 不做归一', () => {
    assert.deepEqual(rulesFor('linux'), {
      caseInsensitive: false, backslashIsSeparator: false, nfcNormalize: false,
    });
  });

  test('未知平台退化为最保守的一套（宁可漏匹配，不可错匹配）', () => {
    assert.deepEqual(rulesFor('freebsd'), rulesFor('linux'));
    assert.deepEqual(rulesFor(/** @type {any} */ (undefined)), rulesFor('linux'));
  });

  test('★★ 在**任意宿主**上都能验三套规则（core 纯函数化的意义，§6.3）', () => {
    // 同一个输入，三个平台三种结果——这台机器是 Windows，照样能验 Linux 规则
    const p = 'C:\\Work\\A';
    assert.equal(normalizeForCompare(p, 'win32'), 'c:/work/a');   // 转分隔符 + 折叠
    assert.equal(normalizeForCompare(p, 'linux'), 'C:\\Work\\A'); // 原样，`\` 是普通字符
  });
});

// ═══════════════════ 归一化 ═══════════════════

describe('normalizeForCompare', () => {
  test('Windows：`\\` → `/`', () => {
    assert.equal(normalizeForCompare('D:\\work\\client-a', 'win32'), 'd:/work/client-a');
  });

  test('Windows：盘符大小写折叠', () => {
    assert.equal(normalizeForCompare('d:/work', 'win32'), normalizeForCompare('D:/WORK', 'win32'));
  });

  test('Windows：混合分隔符也认', () => {
    assert.equal(
      normalizeForCompare('D:\\work/client-a', 'win32'),
      normalizeForCompare('D:/work\\client-a', 'win32'),
    );
  });

  test('Linux：**不**把 `\\` 当分隔符（它是一个合法文件名字符）', () => {
    assert.equal(normalizeForCompare('/home/a\\b', 'linux'), '/home/a\\b');
    assert.notEqual(normalizeForCompare('/home/a\\b', 'linux'), normalizeForCompare('/home/a/b', 'linux'));
  });

  test('Linux：大小写**不**折叠', () => {
    assert.notEqual(normalizeForCompare('/home/Work', 'linux'), normalizeForCompare('/home/work', 'linux'));
  });

  test('macOS：大小写折叠', () => {
    assert.equal(normalizeForCompare('/Users/Me/Work', 'darwin'), '/Users/Me/Work'.toLowerCase());
  });

  test('★ macOS：NFC 与 NFD 归一后相等（APFS 存 NFD 的真坑）', () => {
    const nfc = '/Users/me/Caf\u00e9';        // é 单码点
    const nfd = '/Users/me/Cafe\u0301';       // e + 组合尖音符
    assert.notEqual(nfc, nfd, '前提：两者字节确实不同');
    assert.equal(normalizeForCompare(nfc, 'darwin'), normalizeForCompare(nfd, 'darwin'));
  });

  test('★ Linux：NFC 与 NFD **不**归一（是两个不同的文件名）', () => {
    const nfc = '/home/me/Caf\u00e9';
    const nfd = '/home/me/Cafe\u0301';
    assert.notEqual(normalizeForCompare(nfc, 'linux'), normalizeForCompare(nfd, 'linux'));
  });

  test('去尾部斜杠', () => {
    assert.equal(normalizeForCompare('D:/work/', 'win32'), 'd:/work');
    assert.equal(normalizeForCompare('/home/me///', 'linux'), '/home/me');
  });

  test('★ 根的尾斜杠必须留住（`D:/` 不能变成 `D:`，`/` 不能变成空串）', () => {
    assert.equal(normalizeForCompare('D:/', 'win32'), 'd:/');
    assert.equal(normalizeForCompare('D:\\', 'win32'), 'd:/');
    assert.equal(normalizeForCompare('/', 'linux'), '/');
    assert.equal(normalizeForCompare('///', 'linux'), '/');
  });

  test('大小写折叠在 NFC 之前（否则 `İ` 这类字符会脱离规范形态）', () => {
    const out = normalizeForCompare('İ', 'darwin');
    assert.equal(out, out.normalize('NFC'), '输出必须已经是 NFC 形态');
  });
});

// ═══════════════════ 最长前缀匹配 ═══════════════════

describe('★ 最长前缀匹配（§2.3）', () => {
  const BINDINGS = [
    B('D:/work', { token: 'shallow' }),
    B('D:/work/client-a', { token: 'deep' }),
  ];

  test('命中更长的那个前缀', () => {
    const m = matchBinding(BINDINGS, 'D:/work/client-a', 'win32');
    assert.equal(m?.binding.token, 'deep');
    assert.equal(m?.index, 1);
  });

  test('子目录也命中更长的那条', () => {
    assert.equal(matchBinding(BINDINGS, 'D:/work/client-a/src', 'win32')?.binding.token, 'deep');
  });

  test('不在任何绑定下 → null', () => {
    assert.equal(matchBinding(BINDINGS, 'D:/other', 'win32'), null);
  });

  test('顺序颠倒也取最长（不是"先出现者赢"）', () => {
    const rev = [...BINDINGS].reverse();
    assert.equal(matchBinding(rev, 'D:/work/client-a/src', 'win32')?.binding.token, 'deep');
  });

  test('并列长时取先出现的那条', () => {
    const tie = [B('D:/a', { token: 'first' }), B('D:/a', { token: 'second' })];
    const m = matchBinding(tie, 'D:/a/sub', 'win32');
    assert.equal(m?.binding.token, 'first');
    assert.equal(m?.index, 0);
  });

  test('精确相等也算命中', () => {
    assert.equal(matchBinding(BINDINGS, 'D:/work', 'win32')?.binding.token, 'shallow');
  });

  test('空绑定表 / 非数组 → null', () => {
    assert.equal(matchBinding([], 'D:/a', 'win32'), null);
    assert.equal(matchBinding(/** @type {any} */ (undefined), 'D:/a', 'win32'), null);
  });

  test('跳过畸形条目（path 不是字符串）而不是崩', () => {
    const dirty = [/** @type {any} */ ({ token: 'x' }), null, B('D:/a', { token: 'ok' })];
    assert.equal(matchBinding(dirty, 'D:/a/b', 'win32')?.binding.token, 'ok');
  });
});

// ═══════════ ★ 路径边界：前缀相同但不是子目录 ═══════════

describe('★ 路径边界（裸 startsWith 会在这里出错）', () => {
  test('绑定 `D:/work/a` **不得**匹配 `D:/work/ab`', () => {
    const m = matchBinding([B('D:/work/a', { token: 'a' })], 'D:/work/ab', 'win32');
    assert.equal(m, null, '`ab` 是另一个目录，不是 `a` 的子目录');
  });

  test('绑定 `D:/work/a` 匹配 `D:/work/a/b`', () => {
    assert.equal(matchBinding([B('D:/work/a')], 'D:/work/a/b', 'win32')?.index, 0);
  });

  test('`D:/` 匹配一切 Windows 路径', () => {
    const m = matchBinding([B('D:/', { token: 'drive' })], 'D:/anything/at/all', 'win32');
    assert.equal(m?.binding.token, 'drive');
  });

  test('`/` 匹配一切 POSIX 路径', () => {
    assert.equal(matchBinding([B('/', { token: 'root' })], '/home/me/x', 'linux')?.binding.token, 'root');
  });

  test('`D:/` 与 `D:/work` 并存时，`D:/work/x` 取后者', () => {
    const m = matchBinding([B('D:/', { token: 'drive' }), B('D:/work', { token: 'work' })], 'D:/work/x', 'win32');
    assert.equal(m?.binding.token, 'work');
  });

  test('尾部斜杠不影响匹配', () => {
    assert.equal(matchBinding([B('D:/work/')], 'D:/work/x', 'win32')?.index, 0);
    assert.equal(matchBinding([B('D:/work')], 'D:/work/x/', 'win32')?.index, 0);
  });
});

// ═══════════ 绑定表里的路径与 cwd 用同一套规则 ═══════════

describe('★ 两边归一必须一致', () => {
  test('Windows：绑定的反斜杠写法能匹配正斜杠 cwd', () => {
    assert.equal(matchBinding([B('D:\\work\\a')], 'D:/work/a/sub', 'win32')?.index, 0);
  });

  test('Windows：大小写不同照样命中', () => {
    assert.equal(matchBinding([B('d:/WORK/A')], 'D:/work/a', 'win32')?.index, 0);
  });

  test('macOS：绑定写 NFC、cwd 是 NFD（APFS 实况）照样命中', () => {
    const m = matchBinding([B('/Users/me/Caf\u00e9')], '/Users/me/Cafe\u0301/src', 'darwin');
    assert.equal(m?.index, 0);
  });

  test('Linux：大小写不同**不**命中', () => {
    assert.equal(matchBinding([B('/home/me/Work')], '/home/me/work', 'linux'), null);
  });

  test('Linux：cwd 里的 `\\` 不被当成分隔符', () => {
    assert.equal(matchBinding([B('/home/me')], '/home/me/a\\b', 'linux')?.index, 0);
    assert.equal(matchBinding([B('/home/me/a')], '/home/me/a\\b', 'linux'), null,
      '`a\\b` 是 /home/me 下的一个文件，不是 /home/me/a 的子目录');
  });
});

// ═══════════════════ findExactBinding ═══════════════════

describe('findExactBinding（`cxt bind` 判断新建还是改写）', () => {
  const BINDINGS = [B('D:/work', { token: 'a' }), B('D:/work/client-a', { token: 'b' })];

  test('精确命中返回下标', () => {
    assert.equal(findExactBinding(BINDINGS, 'D:/work/client-a', 'win32'), 1);
  });

  test('★ 只是"在其下"不算精确命中（否则会改错条目）', () => {
    assert.equal(findExactBinding(BINDINGS, 'D:/work/client-a/src', 'win32'), -1);
  });

  test('大小写/分隔符差异仍算同一条', () => {
    assert.equal(findExactBinding(BINDINGS, 'd:\\WORK', 'win32'), 0);
  });

  test('没有 → -1', () => {
    assert.equal(findExactBinding(BINDINGS, 'D:/nope', 'win32'), -1);
    assert.equal(findExactBinding([], 'D:/nope', 'win32'), -1);
  });
});

// ═══════════════════ ★ 8.3 短名探测（§7.3 的"第二种拼写"）═══════════════════

describe('looksLikeShortName', () => {
  test('★ 本机真实用例：`%TEMP%` 给的**就是**短名', () => {
    // 这台机器的 %TEMP% = C:\Users\ALICE~1\AppData\Local\Temp（真机实测）
    assert.equal(looksLikeShortName('C:\\Users\\ALICE~1', 'win32'), true);
    assert.equal(looksLikeShortName('C:\\Users\\ALICE~1\\AppData\\Local\\Temp', 'win32'), true);
    assert.equal(looksLikeShortName('C:\\Users\\alice', 'win32'), false);
  });

  test('经典的 PROGRA~1 家族', () => {
    for (const p of [
      'C:\\PROGRA~1',
      'C:\\Program Files (x86)\\PROGRA~2\\App',
      'C:\\Windows\\SYSWOW~1',
      'D:\\WORK\\MYPROJ~1\\src',
    ]) {
      assert.equal(looksLikeShortName(p, 'win32'), true, p);
    }
  });

  test('带扩展名的短名也认', () => {
    assert.equal(looksLikeShortName('C:\\PROGRA~1\\COMMON~1.TXT', 'win32'), true);
  });

  test('前缀超过 6 字符 → 不是合法 8.3 名，别误报', () => {
    assert.equal(looksLikeShortName('C:\\my project~1', 'win32'), false);
    assert.equal(looksLikeShortName('C:\\abcdefg~1', 'win32'), false);
  });

  test('`~` 后面不是数字 → 不是短名（`~` 是合法文件名字符）', () => {
    assert.equal(looksLikeShortName('C:\\backup~old', 'win32'), false);
    assert.equal(looksLikeShortName('C:\\a~', 'win32'), false);
  });

  test('★ 非 Windows 一律 false——别把 `a~1` 这种合法目录名在 Linux 上误报', () => {
    for (const plat of ['linux', 'darwin', 'freebsd']) {
      assert.equal(looksLikeShortName('C:\\PROGRA~1', plat), false, plat);
      assert.equal(looksLikeShortName('/home/a~1', plat), false, plat);
    }
  });

  test('退化输入不崩', () => {
    assert.equal(looksLikeShortName('', 'win32'), false);
    assert.equal(looksLikeShortName(null, 'win32'), false);
    assert.equal(looksLikeShortName(undefined, 'win32'), false);
    assert.equal(looksLikeShortName('C:\\', 'win32'), false);
  });

  test('它只回答"像不像"，**不做归一化**（铁律 4：写用户的字面路径）', () => {
    // 探测归探测，路径本身一个字符都不能变
    const p = 'C:\\Users\\ALICE~1\\proj';
    looksLikeShortName(p, 'win32');
    assert.equal(p, 'C:\\Users\\ALICE~1\\proj');
    // 而且归一化**不会**把短名展开成长名——那正是它不能当"修好"手段的原因
    assert.notEqual(normalizeForCompare(p, 'win32'), normalizeForCompare('C:\\Users\\alice\\proj', 'win32'));
  });
});

// ═══════════════════ 纯函数性 ═══════════════════

describe('纯函数', () => {
  test('不改入参', () => {
    const bindings = [B('D:/a', { token: 'x' })];
    const snapshot = JSON.stringify(bindings);
    matchBinding(bindings, 'D:/a/b', 'win32');
    findExactBinding(bindings, 'D:/a', 'win32');
    normalizeForCompare('D:/a', 'win32');
    assert.equal(JSON.stringify(bindings), snapshot);
  });
});
