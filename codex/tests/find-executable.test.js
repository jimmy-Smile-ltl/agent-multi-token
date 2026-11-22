// @ts-check
/**
 * `findExecutable()` 的三平台规则（§2.11 四 + §6.3）。
 *
 * ★ 本文件跑在 Windows 上，但里面**每一组 POSIX 断言都是真的在测 POSIX 规则**——
 * 因为 `platform` 与 `fs` 都是注入的。这正是契约要求"不 spawn `which`"的回报。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

import {
  DEFAULT_PATHEXT, findExecutable, getEnvVar, realFindDeps, splitPath, splitPathext,
} from '../src/platform/find-executable.js';

/**
 * 假 fs：给一组"存在的文件"和一组"可执行的文件"，按目标平台大小写规则比较。
 *
 * ⚠️ Windows 上要**折叠大小写**，否则会测出一个真实系统上不存在的差异
 * （`codex` 找到 `C:\bin\CODEX.CMD` 在真机上是成立的）。
 */
function fakeFs(platform, { files = [], executable = [] } = {}) {
  const pathMod = platform === 'win32' ? win32 : posix;
  const fold = platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const fileSet = new Set(files.map(fold));
  const exeSet = new Set(executable.map(fold));
  return {
    join: pathMod.join,
    isFile: (p) => fileSet.has(fold(p)),
    isExecutable: (p) => exeSet.has(fold(p)),
    // 假 fs 也照样实现 realName：POSIX 上永远不该被调用（调用即测试失败），
    // Windows 上按存进 files 的**原始拼写**回话——这样"真实拼写"这件事在单测里也是可断言的行为
    realName: (p) => {
      if (platform !== 'win32') throw new Error(`realName() 不该在 POSIX 上被调用：${p}`);
      const target = fold(p);
      const hit = files.find((f) => fold(f) === target);
      return hit ?? p;
    },
  };
}

/** Windows 上 PATH 里的路径必须用 `;` 分隔，所以单独一个 helper 免得写错 */
const winPath = (...dirs) => dirs.join(';');
const posixPath = (...dirs) => dirs.join(':');

/** 宿主平台——几处"只在某平台上才成立"的断言要用（测试读 process.platform 是允许的，core 才不许） */
const IS_WIN = process.platform === 'win32';
const PLATFORM = /** @type {NodeJS.Platform} */ (process.platform);

// ═══════════════════════ 环境变量读取 ═══════════════════════

describe('getEnvVar —— Windows 大小写不敏感，POSIX 敏感', () => {
  test('★ Windows：真机常见的是 `Path` 而不是 `PATH`，两者都要能读到', () => {
    assert.equal(getEnvVar({ Path: 'C:\\bin' }, 'PATH', 'win32'), 'C:\\bin');
    assert.equal(getEnvVar({ PATH: 'C:\\bin' }, 'PATH', 'win32'), 'C:\\bin');
    assert.equal(getEnvVar({ pAtH: 'C:\\bin' }, 'PATH', 'win32'), 'C:\\bin');
  });

  test('★ POSIX：`Path` 与 `PATH` 是**两个不同的变量**，不许混', () => {
    assert.equal(getEnvVar({ Path: 'C:\\bin' }, 'PATH', 'linux'), undefined);
    assert.equal(getEnvVar({ PATH: '/bin' }, 'PATH', 'linux'), '/bin');
  });

  test('精确命中优先，且不做多余扫描', () => {
    assert.equal(getEnvVar({ PATH: 'exact', path: 'other' }, 'PATH', 'win32'), 'exact');
  });

  test('env 缺失 / 变量不存在 → undefined（不抛）', () => {
    assert.equal(getEnvVar(undefined, 'PATH', 'win32'), undefined);
    assert.equal(getEnvVar(null, 'PATH', 'linux'), undefined);
    assert.equal(getEnvVar({}, 'PATH', 'linux'), undefined);
  });

  test('空串是**有值**（区别于 undefined）', () => {
    assert.equal(getEnvVar({ PATH: '' }, 'PATH', 'linux'), '');
  });
});

// ═══════════════════════ PATH 拆分 ═══════════════════════

describe('splitPath —— 分隔符按目标平台选', () => {
  test('POSIX 按 `:` 拆', () => {
    assert.deepEqual(splitPath('/usr/bin:/bin', 'linux'), ['/usr/bin', '/bin']);
    assert.deepEqual(splitPath('/usr/bin:/bin', 'darwin'), ['/usr/bin', '/bin']);
  });

  test('Windows 按 `;` 拆', () => {
    assert.deepEqual(splitPath(winPath('C:\\a', 'D:\\b'), 'win32'), ['C:\\a', 'D:\\b']);
  });

  test('★ 拿 `:` 拆 Windows 的 PATH 会把它碎成一地——所以必须按平台选分隔符', () => {
    const v = winPath('C:\\a', 'D:\\b');
    assert.deepEqual(splitPath(v, 'win32'), ['C:\\a', 'D:\\b']);
    // 反面：POSIX 规则下连**盘符的冒号**都成了分隔符，两个目录被碎成三个垃圾段
    assert.deepEqual(splitPath(v, 'linux'), ['C', '\\a;D', '\\b']);
  });

  test('★ 空段丢掉（连续分隔符 / 首尾分隔符）', () => {
    assert.deepEqual(splitPath('/a::/b', 'linux'), ['/a', '/b']);
    assert.deepEqual(splitPath(':/a:', 'linux'), ['/a']);
    assert.deepEqual(splitPath(winPath('', 'C:\\a', ''), 'win32'), ['C:\\a']);
  });

  test('★ 空段**不**当成"当前目录"——那是能执行到任意 pwd 下同名文件的危险语义', () => {
    // `/a::/b` 若把空段当 cwd，结果里会多一个 '.' 或 ''，从而在 cwd 里搜可执行文件
    assert.ok(!splitPath('/a::/b', 'linux').some((d) => d === '' || d === '.'));
  });

  test('纯空白段也丢', () => {
    assert.deepEqual(splitPath('/a:   :/b', 'linux'), ['/a', '/b']);
  });

  test('undefined / 空串 → []', () => {
    assert.deepEqual(splitPath(undefined, 'linux'), []);
    assert.deepEqual(splitPath('', 'win32'), []);
  });
});

// ═══════════════════════ PATHEXT 拆分 ═══════════════════════

describe('splitPathext —— 缺失时退回默认集，不是"没有扩展名可试"', () => {
  test('缺失 / 空 / 纯空白 → 默认集', () => {
    assert.deepEqual(splitPathext(undefined), [...DEFAULT_PATHEXT]);
    assert.deepEqual(splitPathext(''), [...DEFAULT_PATHEXT]);
    assert.deepEqual(splitPathext('   '), [...DEFAULT_PATHEXT]);
    assert.deepEqual(splitPathext(';;;'), [...DEFAULT_PATHEXT]);
  });

  test('★ 默认集里有 `.CMD`——`codex` 在 Windows 上就是个 .cmd，这条是命根子', () => {
    assert.ok(DEFAULT_PATHEXT.includes('.CMD'));
  });

  test('★ 默认集里**没有** `.PS1`（PowerShell 脚本不能直接当可执行文件跑）', () => {
    assert.ok(!DEFAULT_PATHEXT.includes('.PS1'));
  });

  test('统一成大写（Windows 上大小写不敏感，`;.exe;` 也得认）', () => {
    assert.deepEqual(splitPathext('.exe;.Cmd'), ['.EXE', '.CMD']);
  });

  test('顺序保留（自定义 PATHEXT 的优先级是有意义的）', () => {
    assert.deepEqual(splitPathext('.CMD;.EXE'), ['.CMD', '.EXE']);
  });

  test('DEFAULT_PATHEXT 是冻结的——别让谁顺手 push 进去', () => {
    assert.throws(() => /** @type {any} */ (DEFAULT_PATHEXT).push('.PS1'), TypeError);
  });
});

// ═══════════════════════ POSIX 定位规则 ═══════════════════════

describe('findExecutable —— POSIX：按**可执行位**判定', () => {
  const fs = fakeFs('linux', {
    files: ['/usr/bin/codex', '/usr/local/bin/codex', '/opt/bin/codex'],
    executable: ['/usr/local/bin/codex', '/opt/bin/codex'],   // /usr/bin 那个没有可执行位
  });
  const env = { PATH: posixPath('/usr/bin', '/usr/local/bin', '/opt/bin') };

  test('★ 按 PATH 顺序返回**第一个可执行的**（跳过存在但不可执行的那个）', () => {
    assert.equal(findExecutable('codex', { platform: 'linux', env, fs }), '/usr/local/bin/codex');
  });

  test('PATH 顺序换了，结果就跟着换（不是"随便找一个"）', () => {
    const flipped = { PATH: posixPath('/opt/bin', '/usr/local/bin', '/usr/bin') };
    assert.equal(findExecutable('codex', { platform: 'linux', env: flipped, fs }), '/opt/bin/codex');
  });

  test('★ 存在但不可执行 → null（POSIX 上"存在"不等于"能跑"）', () => {
    const only = { PATH: '/usr/bin' };
    assert.equal(findExecutable('codex', { platform: 'linux', env: only, fs }), null);
  });

  test('哪里都没有 → null（不抛）', () => {
    assert.equal(findExecutable('nope', { platform: 'linux', env, fs }), null);
  });

  test('★ 空 PATH / 缺 PATH → null（不是"退回当前目录"）', () => {
    assert.equal(findExecutable('codex', { platform: 'linux', env: {}, fs }), null);
    assert.equal(findExecutable('codex', { platform: 'linux', env: { PATH: '' }, fs }), null);
  });

  test('darwin 与 linux 规则相同（都是 POSIX）', () => {
    assert.equal(findExecutable('codex', { platform: 'darwin', env, fs }), '/usr/local/bin/codex');
  });

  test('★ POSIX 下**不**追加扩展名（`codex` 不会去找 `codex.EXE`）', () => {
    const f2 = fakeFs('linux', { files: ['/bin/codex.exe'], executable: ['/bin/codex.exe'] });
    assert.equal(findExecutable('codex', { platform: 'linux', env: { PATH: '/bin' }, fs: f2 }), null);
  });

  test('名字为空 / 非字符串 → null', () => {
    assert.equal(findExecutable('', { platform: 'linux', env, fs }), null);
    assert.equal(findExecutable(/** @type {any} */ (null), { platform: 'linux', env, fs }), null);
  });
});

// ═══════════════════════ Windows 定位规则 ═══════════════════════

describe('findExecutable —— Windows：按 PATHEXT 试扩展名，只看存在性', () => {
  test('★ `codex` 命中 `codex.cmd`——这就是本工具在 Windows 上的真实形态', () => {
    const fs = fakeFs('win32', { files: ['C:\\Users\\t\\AppData\\Roaming\\npm\\codex.cmd'] });
    const env = { Path: 'C:\\Users\\t\\AppData\\Roaming\\npm', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(
      findExecutable('codex', { platform: 'win32', env, fs }),
      'C:\\Users\\t\\AppData\\Roaming\\npm\\codex.cmd',
    );
  });

  test('★ 返回**磁盘上的真实拼写**，不是 PATHEXT 拼出来的候选名', () => {
    // PATHEXT 全大写、磁盘全小写是 Windows 上的**常态**（npm 装出来的就是 codex.cmd）。
    // 若直接返回候选名会得到 `codex.CMD`——功能上能跑，但这个字符串会被写进
    // `defaults.codexBin`（§2.12 第 3 级），用户在配置里看到磁盘上不存在的拼写会懵。
    const fs = fakeFs('win32', { files: ['C:\\bin\\codex.cmd'] });
    const env = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    const got = findExecutable('codex', { platform: 'win32', env, fs });
    assert.equal(got, 'C:\\bin\\codex.cmd');
    assert.ok(!got.endsWith('.CMD'), '返回了候选名而不是真实名');
  });

  test('★ 大小写不敏感：`codex` 也能找到 `CODEX.CMD`，且返回它**本来的大写**', () => {
    const fs = fakeFs('win32', { files: ['C:\\bin\\CODEX.CMD'] });
    const env = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(findExecutable('codex', { platform: 'win32', env, fs }), 'C:\\bin\\CODEX.CMD');
  });

  test('★ 遍历顺序是「目录在外、扩展名在内」——早目录的 .bat 赢过后目录的 .exe', () => {
    const fs = fakeFs('win32', { files: ['C:\\a\\foo.bat', 'C:\\b\\foo.exe'] });
    const env = { PATH: winPath('C:\\a', 'C:\\b'), PATHEXT: '.EXE;.BAT' };
    assert.equal(findExecutable('foo', { platform: 'win32', env, fs }), 'C:\\a\\foo.bat');
  });

  test('同一目录内按 PATHEXT 顺序（`.EXE` 排在 `.CMD` 前面就先赢）', () => {
    const fs = fakeFs('win32', { files: ['C:\\bin\\foo.exe', 'C:\\bin\\foo.cmd'] });
    assert.equal(
      findExecutable('foo', { platform: 'win32', env: { PATH: 'C:\\bin', PATHEXT: '.EXE;.CMD' }, fs }),
      'C:\\bin\\foo.exe',
    );
  });

  test('★ 名字已带扩展名 → **不重复追加**（`wt.exe` 不该变成 `wt.exe.EXE`）', () => {
    const fs = fakeFs('win32', { files: ['C:\\bin\\wt.exe'] });
    const env = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(findExecutable('wt.exe', { platform: 'win32', env, fs }), 'C:\\bin\\wt.exe');
    // 反面证据：若追加了，假 fs 里会存在 `C:\bin\wt.exe.EXE` 才可能命中——它不存在
    assert.equal(fs.isFile('C:\\bin\\wt.exe.EXE'), false);
  });

  test('★ **不返回裸名**：`C:\\bin\\codex`（无扩展名）不算可执行文件', () => {
    // 真机上 CreateProcess 要扩展名在 PATHEXT 里，返回裸名只会让调用方在 spawn 时炸
    const fs = fakeFs('win32', { files: ['C:\\bin\\codex'] });
    const env = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(findExecutable('codex', { platform: 'win32', env, fs }), null);
  });

  test('★ PATHEXT 缺失 → 用默认集（`codex.cmd` 照样找得到）', () => {
    const fs = fakeFs('win32', { files: ['C:\\bin\\codex.cmd'] });
    assert.equal(
      findExecutable('codex', { platform: 'win32', env: { PATH: 'C:\\bin' }, fs }),
      'C:\\bin\\codex.cmd',
    );
  });

  test('★ `.PS1` 找不到——默认 PATHEXT 里没有它，这是有意的', () => {
    const fs = fakeFs('win32', { files: ['C:\\bin\\foo.ps1'] });
    assert.equal(findExecutable('foo', { platform: 'win32', env: { PATH: 'C:\\bin' }, fs }), null);
    // 但显式带上扩展名，且 PATHEXT 里有它时能找到
    const withPs1 = { PATH: 'C:\\bin', PATHEXT: '.EXE;.PS1' };
    assert.equal(findExecutable('foo.ps1', { platform: 'win32', env: withPs1, fs }), 'C:\\bin\\foo.ps1');
  });

  test('★ 不追加扩展名时**也不**去看 `X_OK`（Windows 上它没有意义）', () => {
    // 假 fs 里 `isExecutable` 全空——Windows 路径必须仍能被找到
    const fs = fakeFs('win32', { files: ['C:\\bin\\codex.cmd'], executable: [] });
    assert.equal(
      findExecutable('codex', { platform: 'win32', env: { PATH: 'C:\\bin' }, fs }),
      'C:\\bin\\codex.cmd',
    );
  });

  test('PATH 里的空段丢掉，不搜当前目录', () => {
    const fs = fakeFs('win32', { files: ['codex.cmd'] });
    assert.equal(findExecutable('codex', { platform: 'win32', env: { PATH: ';' }, fs }), null);
  });
});

// ═══════════════════════ 含分隔符的名字 ═══════════════════════

describe('名字含路径分隔符 → 按路径处理，不搜 PATH（与 which / where 同语义）', () => {
  test('POSIX：绝对路径直接判可执行位', () => {
    const fs = fakeFs('linux', { files: ['/opt/x/codex'], executable: ['/opt/x/codex'] });
    assert.equal(findExecutable('/opt/x/codex', { platform: 'linux', env: { PATH: '/nowhere' }, fs }), '/opt/x/codex');
  });

  test('POSIX：路径存在但不可执行 → null', () => {
    const fs = fakeFs('linux', { files: ['/opt/x/codex'], executable: [] });
    assert.equal(findExecutable('/opt/x/codex', { platform: 'linux', env: { PATH: '/nowhere' }, fs }), null);
  });

  test('★ Windows：绝对路径仍要按 PATHEXT 补齐扩展名（`where` 就是这么干的）', () => {
    const fs = fakeFs('win32', { files: ['C:\\tools\\codex.cmd'] });
    assert.equal(
      findExecutable('C:\\tools\\codex', { platform: 'win32', env: { PATHEXT: '.CMD' }, fs }),
      'C:\\tools\\codex.cmd',
    );
  });

  test('★ 不会被 PATH 污染成 `C:\\bin\\/opt/x/codex` 这种荒唐组合', () => {
    const fs = fakeFs('win32', { files: ['C:\\bin\\codex.cmd'] });
    // 带分隔符的名字 + 一个能命中裸名的 PATH：必须**不**去 PATH 里找
    assert.equal(
      findExecutable('sub\\codex', { platform: 'win32', env: { PATH: 'C:\\bin', PATHEXT: '.CMD' }, fs }),
      null,
    );
  });
});

// ═══════════════════════ 同一份输入、两个平台、两个答案 ═══════════════════════

describe('★ 跨平台对照——这才是"注入 platform"买到的东西', () => {
  test('同一个名字，Windows 找 `.cmd`、POSIX 找裸名（同目录两种形态都在）', () => {
    // ⚠️ 两个平台必须各用**自己形状**的路径：win32.join 会把 `/opt/bin` 掰成 `\\opt\\bin`，
    //    拿 POSIX 形状的路径去喂 Windows 规则，测的就不是真实场景了。
    const env = { PATHEXT: '.CMD' };

    const linuxFs = fakeFs('linux', {
      files: ['/opt/bin/codex', '/opt/bin/codex.cmd'],
      executable: ['/opt/bin/codex'],            // 只有裸名那个有可执行位
    });
    assert.equal(
      findExecutable('codex', { platform: 'linux', env: { ...env, PATH: '/opt/bin' }, fs: linuxFs }),
      '/opt/bin/codex',
    );

    const winFs = fakeFs('win32', { files: ['C:\\opt\\bin\\codex', 'C:\\opt\\bin\\codex.cmd'] });
    assert.equal(
      findExecutable('codex', { platform: 'win32', env: { ...env, PATH: 'C:\\opt\\bin' }, fs: winFs }),
      'C:\\opt\\bin\\codex.cmd',                 // 裸名在 Windows 上不算数
    );
  });

  test('★ POSIX 认可执行位、Windows 认存在性——同一个文件集，两个答案', () => {
    // 裸名文件：POSIX 上 chmod 755 就能跑，Windows 上根本不是可执行文件
    const noExec = { files: ['/opt/bin/tool', 'C:\\opt\\bin\\tool'], executable: [] };
    assert.equal(
      findExecutable('tool', {
        platform: 'linux', env: { PATH: '/opt/bin' }, fs: fakeFs('linux', noExec),
      }),
      null,
    );
    // Windows 侧：`tool` 无扩展名 → 依然 null（原因不同：不是缺可执行位，是缺扩展名）
    assert.equal(
      findExecutable('tool', {
        platform: 'win32', env: { PATH: 'C:\\opt\\bin', PATHEXT: '.EXE' }, fs: fakeFs('win32', noExec),
      }),
      null,
    );
  });
});

// ═══════════════════════ App Execution Alias（Windows 重解析点）═══════════════════════

/**
 * 假 fs **模块**（不是假 FindDeps）——用来单测 `realFindDeps()` 自己的兜底逻辑。
 *
 * 真机上这个场景长这样（2026-10-17 实测 `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`）：
 * `statSync` 抛 **EACCES**（重解析点的目标在 MSIX 包里，没权限跟过去），
 * 而 `lstatSync` 看得到它是个符号链接。
 *
 * ⚠️ `platform` 必须传：win32 上路径要**折叠大小写**，否则候选名 `wt.EXE`
 * （大写来自 PATHEXT）匹配不上磁盘上的 `wt.exe`——那会造出一个真机上不存在的失败。
 */
function fakeFsMod(platform, { plain = [], links = [], dirs = [] } = {}) {
  const fold = platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const has = (list, p) => list.some((x) => fold(x) === fold(p));
  const st = (kind) => ({
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link',
  });
  const err = (code, p) => {
    const e = new Error(`${code}: ${p}`);
    // @ts-ignore
    e.code = code;
    return e;
  };
  return {
    constants: { X_OK: 1, F_OK: 0 },
    statSync: (p) => {
      if (has(plain, p)) return st('file');
      if (has(dirs, p)) return st('dir');
      // ★ 重解析点：跟随失败，而且是权限问题不是不存在——正是真机的形态
      if (has(links, p)) throw err('EACCES', p);
      throw err('ENOENT', p);
    },
    lstatSync: (p) => {
      if (has(plain, p)) return st('file');
      if (has(dirs, p)) return st('dir');
      if (has(links, p)) return st('link');
      throw err('ENOENT', p);
    },
    // ⚠️ `links` 在这里**故意不算通过**：POSIX 的 `X_OK` 对悬空链接必须失败。
    //    Windows 那条路压根不走 accessSync（`isExecutable` 直接委托 `isFile`）。
    accessSync: (p, mode) => {
      if (has(plain, p)) return;
      if (has(dirs, p) && mode === 0) return;
      throw err('EACCES', p);
    },
    readdirSync: (d) => [...plain, ...links, ...dirs]
      .filter((p) => fold(p).startsWith(fold(d)))
      .map((p) => p.slice(d.length).replace(/^[/\\]/, '')),
  };
}

describe('★★ App Execution Alias —— `statSync` 看不见它，但 Windows 跑得动它', () => {
  const ALIAS = 'C:\\Users\\t\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe';
  const ENV = {
    PATH: 'C:\\Users\\t\\AppData\\Local\\Microsoft\\WindowsApps',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  };

  test('★ 真机上会 EACCES 的重解析点，必须仍被当成可执行文件', () => {
    const deps = realFindDeps('win32', fakeFsMod('win32', { links: [ALIAS] }));
    assert.equal(deps.isFile(ALIAS), true);
    assert.equal(deps.isExecutable(ALIAS), true);
  });

  test('★★ 端到端：`wt` 能被找到——否则 §2.11 的 Windows 首选会**静默**失效', () => {
    // 这条是本模块最值钱的一条断言：没有它，`findExecutable('wt')` 返回 null，
    // `cxt run` 就每次都悄悄退到 `cmd /c start` 兜底（丢 cwd、丢窗口标题、多一层 shell），
    // 而且**不报任何错**。
    const fs = realFindDeps('win32', fakeFsMod('win32', { links: [ALIAS] }));
    assert.equal(findExecutable('wt', { platform: 'win32', env: ENV, fs }), ALIAS);
    assert.equal(findExecutable('wt.exe', { platform: 'win32', env: ENV, fs }), ALIAS);
  });

  test('★ 兜底**只在 Windows 上开**：POSIX 的悬空符号链接不算可执行文件', () => {
    const dead = '/usr/bin/tool';
    const deps = realFindDeps('linux', fakeFsMod('linux', { links: [dead] }));
    assert.equal(deps.isFile(dead), false, 'POSIX 上把悬空链接当成了文件');
    assert.equal(deps.isExecutable(dead), false, 'POSIX 上悬空链接通过了 X_OK');
  });

  test('★ 普通目录依然不是文件（兜底不能把目录也放进来）', () => {
    const d = 'C:\\bin\\somedir.exe';
    const deps = realFindDeps('win32', fakeFsMod('win32', { dirs: [d] }));
    assert.equal(deps.isFile(d), false);
  });

  test('★ 真机条件断言：这台机器上真有 wt.exe 的话，必须找得到', () => {
    // 条件化是因为 CI / 服务器上可能没装 Windows Terminal——不是"跳过"，是"本机没有就无从断言"
    if (!IS_WIN) return;
    const whereSays = (() => {
      try {
        const { execSync } = require('node:child_process');
        return execSync('where wt', { encoding: 'utf8' }).trim().split(/\r?\n/)[0] || null;
      } catch { return null; }
    })();
    if (whereSays === null) return;      // 本机没装 → 没有可对照的 oracle
    assert.equal(
      findExecutable('wt', { platform: 'win32', env: process.env }),
      whereSays,
      '`where wt` 找得到，我们的 findExecutable 却找不到',
    );
  });
});

// ═══════════════════════ 真 fs 集成 ═══════════════════════

describe('realFindDeps —— 对**真文件系统**跑一遍（假 fs 测不出 accessSync 的语义）', () => {
  const join = IS_WIN ? win32.join : posix.join;
  const dir = mkdtempSync(join(tmpdir(), 'cxt-find-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  /** Windows 上候选名会带扩展名，所以落盘时也得带上 */
  const onDisk = (name) => (IS_WIN ? `${name}.cmd` : name);

  test('真 fs：造一个可执行文件，按宿主平台规则找到它（返回**磁盘上的拼写**）', () => {
    const file = join(dir, onDisk('cxt-probe-tool'));
    writeFileSync(file, IS_WIN ? '@echo off\r\n' : '#!/bin/sh\n', 'utf8');
    if (!IS_WIN) chmodSync(file, 0o755);

    const found = findExecutable('cxt-probe-tool', {
      platform: PLATFORM,
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    assert.ok(found, '真 fs 上没找到刚建的文件');
    assert.equal(found, file);
  });

  test('★ 真 fs：返回的是 readdir 读到的真实名，不是 PATHEXT 拼出的候选名', () => {
    if (!IS_WIN) return;   // 这条只在大小写不敏感的平台上才有意义
    const file = join(dir, 'CXT-PROBE-CASE.CMD');   // 故意全大写落盘
    writeFileSync(file, '@echo off\r\n', 'utf8');

    const found = findExecutable('cxt-probe-case', {
      platform: PLATFORM,
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    assert.equal(found, file);
  });

  test('★ 真 fs：**目录**不会被当成可执行文件（假 fs 的 `isFile` 是断言的，这里才是真的）', () => {
    mkdirSync(join(dir, onDisk('cxt-probe-dir')), { recursive: true });

    const found = findExecutable('cxt-probe-dir', {
      platform: PLATFORM,
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    });
    assert.equal(found, null, '目录被当成了可执行文件');
  });

  test('★ 真 fs：POSIX 上**没有可执行位**的文件找不到（accessSync(X_OK) 的真实语义）', () => {
    if (IS_WIN) return;   // Windows 没有可执行位，这条不是"跳过"而是根本不适用
    const file = join(dir, 'cxt-probe-noexec');
    writeFileSync(file, '#!/bin/sh\n', 'utf8');
    chmodSync(file, 0o644);

    assert.equal(
      findExecutable('cxt-probe-noexec', { platform: PLATFORM, env: { PATH: dir } }),
      null,
    );
  });

  test('真 fs：找不到 → null，不抛（不存在的 PATH 目录也不抛）', () => {
    assert.equal(
      findExecutable('definitely-not-here-9f3a', {
        platform: PLATFORM,
        env: { PATH: join(dir, 'no-such-dir') },
      }),
      null,
    );
  });

  test('★ realName 读不到目录时退回构造名（不为"好看"把定位搞失败）', () => {
    // 直接喂一个不存在的目录：readdirSync 抛，realName 必须吞掉
    const deps = realFindDeps(PLATFORM);
    assert.equal(deps.realName(join(dir, 'no-such-dir', 'x.cmd')), join(dir, 'no-such-dir', 'x.cmd'));
  });

  test('realFindDeps 的 join 按**目标平台**选，不是宿主', () => {
    // 这是 §2.11 那条"node:path 的 join 用宿主规则"的直接回归测试
    assert.equal(realFindDeps('win32').join('C:\\a', 'b'), 'C:\\a\\b');
    assert.equal(realFindDeps('linux').join('/a', 'b'), '/a/b');
    // 在 Windows 上 posix.join 也必须给出 POSIX 形状——否则跨平台单测全是假的
    assert.equal(realFindDeps('darwin').join('/a', 'b'), '/a/b');
  });
});
