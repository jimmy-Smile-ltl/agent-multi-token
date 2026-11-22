// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalPath,
  findCollisions,
  findNearMisses,
  isPathPrefix,
  matchBinding,
  normalizeForCompare,
} from '../src/core/bindings.js';

/** 归一化便捷函数（三个平台） */
const win = (p) => normalizeForCompare(p, 'win32');
const mac = (p) => normalizeForCompare(p, 'darwin');
const lin = (p) => normalizeForCompare(p, 'linux');

describe('normalizeForCompare —— 分隔符归一', () => {
  test('反斜杠与正斜杠等价', () => {
    assert.equal(win('D:\\work\\a'), win('D:/work/a'));
    assert.equal(lin('/srv\\x'), lin('/srv/x'));
  });

  test('重复分隔符塌缩', () => {
    assert.equal(lin('/srv//x///y'), '/srv/x/y');
  });
});

describe('normalizeForCompare —— 大小写（§2.9 三）', () => {
  test('Windows / macOS 不敏感', () => {
    assert.equal(win('D:/Work/A'), win('d:/work/a'));
    assert.equal(mac('/Users/T/Work'), mac('/users/t/work'));
  });

  test('Linux 敏感——大小写不同就是两条路径', () => {
    assert.notEqual(lin('/home/T/work'), lin('/home/t/work'));
    assert.equal(lin('/home/T/work'), '/home/T/work');
  });
});

describe('normalizeForCompare —— NFC 归一（macOS NFD 陷阱）', () => {
  const NFC = 'D:/work/caf\u00e9'; // é 单码位
  const NFD = 'D:/work/cafe\u0301'; // e + 组合重音

  test('两种写法归一到同一串', () => {
    assert.equal(mac(NFC), mac(NFD));
    assert.equal(win(NFC), win(NFD));
  });

  test('不归一的话 startsWith 会失配（本测试即回归护栏）', () => {
    assert.notEqual(NFC, NFD); // 前提：原始串确实不同
    assert.ok(mac(NFD).startsWith(mac(NFC)));
  });
});

describe('normalizeForCompare —— 盘符 / 根 / UNC', () => {
  test('盘符根保留斜杠，不塌成 "d:"', () => {
    assert.equal(win('D:/'), 'd:/');
    assert.equal(win('D:\\'), 'd:/');
  });

  test('盘符统一小写', () => {
    assert.equal(win('D:/work'), 'd:/work');
  });

  test('POSIX 根保留，多个前导斜杠塌成一个', () => {
    assert.equal(lin('/'), '/');
    assert.equal(lin('///'), '/');
    assert.equal(lin('//foo'), '/foo');
  });

  test('UNC 的双斜杠前缀保留（Windows 概念）', () => {
    assert.equal(win('//server/share/x'), '//server/share/x');
    assert.equal(win('\\\\server\\share\\x'), '//server/share/x');
  });

  test('UNC 与普通根路径不混淆', () => {
    assert.notEqual(win('//server/share'), win('/server/share'));
  });
});

describe('normalizeForCompare —— 消解 . 与 ..', () => {
  test('中间的 . 直接丢', () => {
    assert.equal(lin('/a/./b'), '/a/b');
  });

  test('.. 回退一级', () => {
    assert.equal(lin('/a/b/../c'), '/a/c');
    assert.equal(win('D:/work/a/../b'), 'd:/work/b');
  });

  test('根之上的 .. 保持根（字符串比较，不碰 fs）', () => {
    assert.equal(lin('/..'), '/');
    assert.equal(lin('/a/../../b'), '/b');
  });

  test('相对路径的前导 .. 要留着', () => {
    assert.equal(lin('../a'), '../a');
    assert.equal(lin('a/../../b'), '../b');
  });

  test('尾部斜杠去掉', () => {
    assert.equal(lin('/srv/x/'), '/srv/x');
    assert.equal(win('D:/work/a/'), 'd:/work/a');
  });
});

describe('isPathPrefix —— 必须落在分隔符边界上', () => {
  test('精确相等算命中', () => {
    assert.equal(isPathPrefix('d:/work', 'd:/work'), true);
  });

  test('子路径命中', () => {
    assert.equal(isPathPrefix('d:/work', 'd:/work/a'), true);
  });

  test('★ 同前缀的兄弟目录不命中', () => {
    assert.equal(isPathPrefix('d:/work', 'd:/workshop'), false);
    assert.equal(isPathPrefix('/home/t', '/home/tester'), false);
  });

  test('根前缀命中一切（但空串不命中）', () => {
    assert.equal(isPathPrefix('/', '/anything'), true);
    assert.equal(isPathPrefix('', '/anything'), false);
  });

  test('带尾斜杠的前缀也能用', () => {
    assert.equal(isPathPrefix('d:/', 'd:/work'), true);
  });
});

describe('matchBinding —— 最长前缀匹配（§2.3）', () => {
  const ctx = { platform: /** @type {any} */ ('win32'), home: 'C:\\Users\\t' };

  test('长的赢：D:/work/a/sub 命中 D:/work/a 而不是 D:/work', () => {
    const bindings = [
      { path: 'D:/work', token: 'outer' },
      { path: 'D:/work/a', token: 'inner' },
    ];
    assert.equal(matchBinding(bindings, 'D:/work/a/sub', ctx)?.token, 'inner');
    assert.equal(matchBinding(bindings, 'D:/work/b', ctx)?.token, 'outer');
    assert.equal(matchBinding(bindings, 'D:/work', ctx)?.token, 'outer');
  });

  test('命中顺序与书写顺序无关（先短后长也一样）', () => {
    const bindings = [
      { path: 'D:/work/a', token: 'inner' },
      { path: 'D:/work', token: 'outer' },
    ];
    assert.equal(matchBinding(bindings, 'D:/work/a/sub', ctx)?.token, 'inner');
  });

  test('大小写差异不影响命中（Windows）', () => {
    const bindings = [{ path: 'D:/Work/A', token: 'x' }];
    assert.equal(matchBinding(bindings, 'd:/work/a/sub', ctx)?.token, 'x');
  });

  test('分隔符差异不影响命中', () => {
    const bindings = [{ path: 'D:\\work\\a', token: 'x' }];
    assert.equal(matchBinding(bindings, 'D:/work/a', ctx)?.token, 'x');
  });

  test('★ 兄弟目录不误命中', () => {
    const bindings = [{ path: 'D:/work', token: 'x' }];
    assert.equal(matchBinding(bindings, 'D:/workshop', ctx), null);
  });

  test('匹配不到 → null（调用方继续走 token / 全局默认）', () => {
    assert.equal(matchBinding([], 'D:/x', ctx), null);
    assert.equal(matchBinding([{ path: 'D:/other' }], 'D:/x', ctx), null);
  });

  test('返回的是原对象，不是归一化副本', () => {
    const b = { path: 'D:/Work', token: 'x', extra: 1 };
    assert.equal(matchBinding([b], 'd:/work/sub', ctx), b);
  });

  test('Linux 上大小写敏感——/Home/t 不命中 /home/t', () => {
    const lctx = { platform: /** @type {any} */ ('linux'), home: '/home/t' };
    const bindings = [{ path: '/home/t', token: 'x' }];
    assert.equal(matchBinding(bindings, '/home/t/a', lctx)?.token, 'x');
    assert.equal(matchBinding(bindings, '/Home/t/a', lctx), null);
  });
});

describe('canonicalPath —— 绑定与匹配共用同一个函数', () => {
  test('展开 ~ 后再归一', () => {
    const ctx = { platform: /** @type {any} */ ('linux'), home: '/home/t' };
    assert.equal(canonicalPath('~/work', ctx), '/home/t/work');
    assert.equal(canonicalPath('/home/t/work/', ctx), '/home/t/work');
  });

  test('~ 展开的结果与写绝对路径等价（绑定时常用 ~，匹配时是绝对路径）', () => {
    const ctx = { platform: /** @type {any} */ ('win32'), home: 'C:\\Users\\t' };
    assert.equal(canonicalPath('~/work', ctx), canonicalPath('C:/Users/t/work', ctx));
  });
});

describe('findCollisions —— 归一化后打架的绑定', () => {
  test('大小写差异在 Windows 上是冲突，在 Linux 上不是', () => {
    const bindings = [{ path: 'D:/work' }, { path: 'D:/WORK' }];
    const w = findCollisions(bindings, { platform: /** @type {any} */ ('win32'), home: '' });
    assert.equal(w.length, 1);
    assert.deepEqual(w[0].paths, ['D:/work', 'D:/WORK']);

    const l = findCollisions(bindings, { platform: /** @type {any} */ ('linux'), home: '' });
    assert.equal(l.length, 0);
  });

  test('无冲突时返回空数组', () => {
    const bindings = [{ path: 'D:/a' }, { path: 'D:/b' }];
    assert.deepEqual(findCollisions(bindings, { platform: /** @type {any} */ ('win32'), home: '' }), []);
  });
});

describe('findNearMisses —— "看着就是同一个目录"的绑定', () => {
  const win = { platform: /** @type {any} */ ('win32'), home: '' };
  const lin = { platform: /** @type {any} */ ('linux'), home: '' };

  test('★ Windows 8.3 短名：末段相同、中段不同 → 报出来', () => {
    // 实测踩到的形态：Git Bash 把 /tmp/... 塞成短名，而 process.cwd() 给的是长名
    const bindings = [{ path: 'C:/Users/ALICE~1/work/client-a' }];
    const got = findNearMisses(bindings, 'C:/Users/alice/work/client-a', win);
    assert.equal(got.length, 1);
    assert.equal(got[0].path, 'C:/Users/ALICE~1/work/client-a');
  });

  test('已经匹配上的绑定不算 near miss（那是正常路径）', () => {
    const bindings = [{ path: 'C:/work/client-a' }];
    assert.deepEqual(findNearMisses(bindings, 'C:/work/client-a/sub', win), []);
    assert.deepEqual(findNearMisses(bindings, 'C:/work/client-a', win), []);
  });

  test('末段不同 → 不报（别把"隔壁目录"当噪音塞进来）', () => {
    const bindings = [{ path: 'C:/work/client-b' }];
    assert.deepEqual(findNearMisses(bindings, 'C:/work/client-a', win), []);
  });

  test('★ 大小写差异走的是归一化，不是 near miss（各平台语义都正确）', () => {
    // Windows：`D:/Work/A` 归一化后与 `D:/work/a` **完全同串** → 那是正常命中，不是 near miss。
    // （所以 `cmt resolve` 根本不会为它报 near miss——这也正是我们想要的。）
    const b = [{ path: 'D:/Work/A' }];
    assert.deepEqual(findNearMisses(b, 'D:/work/a', win), []);
    assert.equal(matchBinding(b, 'D:/work/a', win)?.path, 'D:/Work/A', '前提：它本来就命中');

    // Linux：保持大小写 → 末段 A ≠ a → 也不报（那本来就是两个目录）
    assert.deepEqual(findNearMisses(b, 'D:/work/a', lin), []);
  });

  test('Linux 上中段大小写不同、末段相同 → 报（如实描述，不宣称是同一目录）', () => {
    const b = [{ path: '/Home/t/work' }];
    const got = findNearMisses(b, '/home/t/work', lin);
    assert.equal(got.length, 1, '末段相同就该摆出来让用户自己看');
    assert.equal(matchBinding(b, '/home/t/work', lin), null, '前提：它确实匹配不上');
  });

  test('尾部分隔符不影响判定', () => {
    const bindings = [{ path: 'C:/work/client-a/' }];
    assert.equal(findNearMisses(bindings, 'C:/other/client-a', win).length, 1);
  });

  test('目标是根 / 末段为空 → 不报（根没有末段可比）', () => {
    const bindings = [{ path: 'C:/work' }];
    assert.deepEqual(findNearMisses(bindings, 'C:/', win), []);
  });

  test('没有绑定 → 空数组', () => {
    assert.deepEqual(findNearMisses([], 'C:/work/a', win), []);
  });
});
