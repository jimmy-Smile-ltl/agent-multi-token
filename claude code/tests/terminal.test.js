// @ts-check
/**
 * 三平台终端决策的单测（§2.9 二·1）。
 *
 * 全是**注入依赖**的纯决策，所以 Windows / macOS / Linux 三支都能在本机跑——
 * 这正是把 `resolveTerminal()`（可测）与 `spawnTerminal()`（不可测）拆开的理由（§6.3）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as macos from '../src/platform/macos.js';
import * as linux from '../src/platform/linux.js';
import * as windows from '../src/platform/windows.js';

/**
 * 造一份"只找得到这几个可执行文件"的 deps。
 * @param {Record<string, string>} bins 名字 → 绝对路径
 * @param {string} [scriptPath]
 * @param {Record<string, string>} [links] 路径 → 软链真身（模拟 Debian alternatives）
 */
const depsOf = (
  bins,
  scriptPath = '/home/t/.claude-multi-token/profiles/relay-a/launch.sh',
  links = {},
) => ({
  findExecutable: (/** @type {string} */ n) => bins[n] ?? null,
  realpath: (/** @type {string} */ p) => links[p] ?? null,
  scriptPath,
});

/**
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} [env]
 */
const ctxOf = (platform, env = {}) => ({ platform, home: '/home/t', env, cwd: '/home/t/work' });

const ARGV = ['/usr/bin/node', '/opt/cmt/bin/cmt.js', 'exec', 'relay-a'];

// ───────────────────────────── Windows ─────────────────────────────

describe('windows.resolveTerminal', () => {
  test('有 wt → 直接拉起，-d 传 cwd，argv 原样追加', () => {
    const s = windows.resolveTerminal({
      title: 'cmt:relay-a',
      cwd: 'C:\\work\\client-a',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }),
      deps: depsOf({ wt: 'C:\\Users\\t\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' }),
    });
    assert.equal(s.via, 'direct');
    assert.equal(s.terminal, 'wt');
    assert.equal(s.windowName, 'cmt'); // 回执据此说"已在 cmt 窗口的新标签页启动"
    assert.deepEqual(s.args, [
      '-w',
      // ★ 故意硬写 'cmt' 而**不引用** WT_WINDOW_NAME：测试若与实现共用同一个常量，
      //   名字被改成别的值也照样"通过"，等于没测。
      'cmt', // tab 模式 = 进 cmt 专属窗口（有就加标签页，没有就建）
      'new-tab',
      '--title',
      'cmt:relay-a',
      // ★ 少了这一项，Claude Code 一跑起来就用 OSC 2 把标题覆盖成 "✳ cmt:relay-a"，
      //   cwd 末段丢失 —— 标题契约（§2.9）当场失效
      '--suppressApplicationTitle',
      '-d',
      'C:\\work\\client-a',
      ...ARGV,
    ]);
  });

  test('--window 模式用 -w -1（总是新窗口）', () => {
    const s = windows.resolveTerminal({
      title: 't',
      cwd: 'C:\\w',
      argv: ARGV,
      mode: 'window',
      ctx: ctxOf('win32'),
      deps: depsOf({ wt: 'C:\\wt.exe' }),
    });
    assert.deepEqual(s.args.slice(0, 2), ['-w', '-1']);
    // window 模式是"每次都新开一个"，没有"落在哪个窗口"可言 → 不许填 windowName
    assert.equal(s.windowName, undefined);
  });

  test('两种模式都带 --suppressApplicationTitle，且它在 new-tab 之后', () => {
    // --window 模式的标题一样会被标签页里的程序覆盖，所以两种模式都得加。
    // 顺序也是契约：`--title` 只负责"写上"，`--suppressApplicationTitle` 才负责"别被覆盖"，
    // 而 WT 只认出现在 `new-tab` 子命令**之后**的选项。
    for (const mode of /** @type {const} */ (['tab', 'window'])) {
      const s = windows.resolveTerminal({
        title: 't',
        cwd: 'C:\\w',
        argv: ARGV,
        mode,
        ctx: ctxOf('win32'),
        deps: depsOf({ wt: 'C:\\wt.exe' }),
      });
      const iTitle = s.args.indexOf('--title');
      const iSuppress = s.args.indexOf('--suppressApplicationTitle');
      assert.ok(iTitle >= 0, `${mode}: 缺 --title`);
      assert.equal(s.args[iTitle + 2], '--suppressApplicationTitle', `${mode}: 没紧跟 --title`);
      assert.ok(iSuppress > s.args.indexOf('new-tab'), `${mode}: 必须出现在 new-tab 之后`);
    }
  });

  test('没有 wt → 退到 cmd 脚本兜底，并报出试过什么', () => {
    const s = windows.resolveTerminal({
      title: 't',
      cwd: 'C:\\w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }),
      deps: depsOf({}),
    });
    assert.equal(s.via, 'script');
    assert.equal(s.terminal, 'cmd');
    assert.equal(s.command, 'C:\\Windows\\system32\\cmd.exe');
    // 第一个 "" 是 start 的窗口标题参数
    assert.deepEqual(s.args.slice(0, 3), ['/c', 'start', '']);
    assert.deepEqual(s.tried, ['wt']);
    assert.match(s.warnings[0], /wt\.exe/);
    // cmd 兜底没有标签页概念 —— tab 模式下必须明说，不能默默退化成开新窗口
    assert.match(s.warnings[1], /标签页/);
  });

  test('--window 模式走 cmd 兜底时不提标签页（本来就该开新窗口）', () => {
    const s = windows.resolveTerminal({
      title: 't',
      cwd: 'C:\\w',
      argv: ARGV,
      mode: 'window',
      ctx: ctxOf('win32', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' }),
      deps: depsOf({}),
    });
    assert.equal(s.warnings.length, 1);
    assert.doesNotMatch(s.warnings[0], /标签页/);
  });

  test('ComSpec 没设也能兜底（退到字面量 cmd.exe）', () => {
    const s = windows.resolveTerminal({
      title: 't',
      cwd: 'C:\\w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('win32'),
      deps: depsOf({}),
    });
    assert.equal(s.command, 'cmd.exe');
  });
});

// ───────────────────────────── macOS ─────────────────────────────

describe('macos.resolveTerminal', () => {
  const deps = depsOf({ osascript: '/usr/bin/osascript', open: '/usr/bin/open' });

  test('$TERM_PROGRAM=iTerm.app → iTerm2 分支，走脚本', () => {
    const s = macos.resolveTerminal({
      title: 't',
      cwd: '/Users/t/work',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('darwin', { TERM_PROGRAM: 'iTerm.app' }),
      deps,
    });
    assert.equal(s.terminal, 'iTerm2');
    assert.equal(s.via, 'script');
    assert.match(s.args[1], /tell application "iTerm"/);
    assert.match(s.args[1], /create tab with default profile command/);
  });

  test('没有 iTerm → Terminal.app 的 do script', () => {
    const s = macos.resolveTerminal({
      title: 't',
      cwd: '/Users/t/work',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('darwin', { TERM_PROGRAM: 'Apple_Terminal' }),
      deps,
    });
    assert.equal(s.terminal, 'Terminal');
    assert.match(s.args[1], /tell application "Terminal" to do script/);
    // tab 模式做不到 → 明确说出来，别假装开了标签页
    assert.match(s.warnings[0], /新窗口/);
  });

  test('没有 osascript → open -a Terminal 兜底', () => {
    const s = macos.resolveTerminal({
      title: 't',
      cwd: '/Users/t/work',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('darwin'),
      deps: depsOf({ open: '/usr/bin/open' }),
    });
    assert.equal(s.terminal, 'open');
    assert.deepEqual(s.args, ['-a', 'Terminal', deps.scriptPath]);
    assert.deepEqual(s.tried, ['osascript']);
  });

  test('macOS 全档都是 script —— AppleScript 只吃字符串（§2.10 ①）', () => {
    for (const env of [{ TERM_PROGRAM: 'iTerm.app' }, { TERM_PROGRAM: 'Apple_Terminal' }, {}]) {
      const s = macos.resolveTerminal({
        title: 't',
        cwd: '/w',
        argv: ARGV,
        mode: 'tab',
        ctx: ctxOf('darwin', env),
        deps,
      });
      assert.equal(s.via, 'script', `env=${JSON.stringify(env)} 应走脚本`);
    }
  });

  test('appleScriptString：先转义反斜杠再转义引号（顺序反了会双重转义）', () => {
    assert.equal(macos.appleScriptString('/plain/path'), '/plain/path');
    assert.equal(macos.appleScriptString('/a"b'), '/a\\"b');
    assert.equal(macos.appleScriptString('/a\\b'), '/a\\\\b');
    // 关键：反斜杠 + 引号同时出现
    assert.equal(macos.appleScriptString('a\\"b'), 'a\\\\\\"b');
  });

  test('路径里的引号不会逃出 AppleScript 字符串', () => {
    const s = macos.resolveTerminal({
      title: 't',
      cwd: '/w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('darwin', { TERM_PROGRAM: 'Apple_Terminal' }),
      deps: depsOf({ osascript: '/usr/bin/osascript' }, '/tmp/it"s here/launch.sh'),
    });
    // 脚本路径是单引号包裹的（sh），其中的 " 又被 AppleScript 转义了一层
    assert.match(s.args[1], /do script "'\/tmp\/it\\"s here\/launch\.sh'"/);
  });
});

// ───────────────────────────── Linux ─────────────────────────────

describe('linux.resolveTerminal', () => {
  test('gnome-terminal：--working-directory + -- 分隔，直接拉起', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/home/t/work',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux'),
      deps: depsOf({ 'gnome-terminal': '/usr/bin/gnome-terminal' }),
    });
    assert.equal(s.via, 'direct');
    assert.equal(s.terminal, 'gnome-terminal');
    assert.deepEqual(s.args, [
      '--tab',
      '--working-directory=/home/t/work',
      '--',
      ...ARGV,
    ]);
  });

  test('konsole：--workdir + -e', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/home/t/work',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux'),
      deps: depsOf({ konsole: '/usr/bin/konsole' }),
    });
    assert.deepEqual(s.args, ['--new-tab', '--workdir', '/home/t/work', '-e', ...ARGV]);
  });

  test('★ xterm 没有 cwd 选项 → 退到脚本兜底（§2.10 ②）', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/home/t/work',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux'),
      deps: depsOf({ xterm: '/usr/bin/xterm' }),
    });
    assert.equal(s.via, 'script');
    assert.equal(s.terminal, 'xterm');
    assert.deepEqual(s.args, ['-e', '/home/t/.claude-multi-token/profiles/relay-a/launch.sh']);
    assert.match(s.warnings.at(-1), /没有传递工作目录的命令行选项/);
  });

  test('$TERMINAL 优先于探测表', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux', { TERMINAL: 'konsole' }),
      deps: depsOf({ konsole: '/usr/bin/konsole', 'gnome-terminal': '/usr/bin/gnome-terminal' }),
    });
    assert.equal(s.terminal, 'konsole');
  });

  test('$TERMINAL 指向找不到的东西 → 报警并继续探测', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux', { TERMINAL: 'nonexistent-term' }),
      deps: depsOf({ 'gnome-terminal': '/usr/bin/gnome-terminal' }),
    });
    assert.equal(s.terminal, 'gnome-terminal');
    assert.ok(s.warnings.some((w) => /找不到/.test(w)));
    assert.ok(s.tried.includes('$TERMINAL=nonexistent-term'));
  });

  test('$TERMINAL 认不出方言 → 最保守处理（不传 cwd，走脚本）', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux', { TERMINAL: 'weird-term' }),
      deps: depsOf({ 'weird-term': '/usr/bin/weird-term' }),
    });
    assert.equal(s.via, 'script');
    assert.deepEqual(s.args, ['-e', '/home/t/.claude-multi-token/profiles/relay-a/launch.sh']);
    assert.ok(s.warnings.some((w) => /不在已知方言表里/.test(w)));
  });

  test('★ x-terminal-emulator 靠 realpath 认领方言（Ubuntu 最常见的入口）', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux'),
      deps: depsOf(
        { 'x-terminal-emulator': '/usr/bin/x-terminal-emulator' },
        undefined,
        { '/usr/bin/x-terminal-emulator': '/usr/bin/gnome-terminal' },
      ),
    });
    assert.equal(s.via, 'direct');
    assert.equal(s.terminal, 'gnome-terminal');
    assert.ok(s.args.includes('--working-directory=/w'));
  });

  test('软链解析不出来 → 最保守（走脚本），不瞎猜', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux'),
      deps: depsOf({ 'x-terminal-emulator': '/usr/bin/x-terminal-emulator' }),
    });
    assert.equal(s.via, 'script');
    assert.deepEqual(s.args, ['-e', '/home/t/.claude-multi-token/profiles/relay-a/launch.sh']);
  });

  test('一个都没有 → terminal: none（由 index.js 转成 EnvError）', () => {
    const s = linux.resolveTerminal({
      title: 't',
      cwd: '/w',
      argv: ARGV,
      mode: 'tab',
      ctx: ctxOf('linux'),
      deps: depsOf({}),
    });
    assert.equal(s.terminal, 'none');
    assert.ok(s.tried.length >= 5); // 报错时能说出试过哪些
  });

  test('supportsDirectLaunch', () => {
    assert.equal(linux.supportsDirectLaunch('gnome-terminal'), true);
    assert.equal(linux.supportsDirectLaunch('/usr/bin/konsole'), true);
    assert.equal(linux.supportsDirectLaunch('xterm'), false);
    assert.equal(linux.supportsDirectLaunch('weird'), false);
    // 软链名认不出来时，靠 realpath 认领
    assert.equal(
      linux.supportsDirectLaunch('/usr/bin/x-terminal-emulator', () => '/usr/bin/konsole'),
      true,
    );
  });
});

// ───────────────────────────── 跨平台一致性 ─────────────────────────────

describe('三平台共同的形状', () => {
  const cases = [
    ['win32', windows, { wt: 'C:\\wt.exe' }, {}],
    ['darwin', macos, { osascript: '/usr/bin/osascript' }, { TERM_PROGRAM: 'iTerm.app' }],
    ['linux', linux, { 'gnome-terminal': '/usr/bin/gnome-terminal' }, {}],
  ];

  test('via 只会是 direct / script 两者之一', () => {
    for (const [platform, adapter, bins, env] of cases) {
      const s = /** @type {any} */ (adapter).resolveTerminal({
        title: 't',
        cwd: '/w',
        argv: ARGV,
        mode: 'tab',
        ctx: ctxOf(/** @type {any} */ (platform), /** @type {any} */ (env)),
        deps: depsOf(/** @type {any} */ (bins)),
      });
      assert.ok(['direct', 'script'].includes(s.via), `${platform} 的 via=${s.via}`);
      assert.equal(typeof s.command, 'string');
      assert.ok(Array.isArray(s.args));
      assert.ok(Array.isArray(s.tried));
      assert.ok(Array.isArray(s.warnings));
    }
  });

  test('direct 时 argv 是独立数组元素——没有被拼成字符串', () => {
    for (const [platform, adapter, bins, env] of cases) {
      const s = /** @type {any} */ (adapter).resolveTerminal({
        title: 't',
        cwd: '/w',
        argv: ['/n', '/c.js', 'exec', 'tok'],
        mode: 'tab',
        ctx: ctxOf(/** @type {any} */ (platform), /** @type {any} */ (env)),
        deps: depsOf(/** @type {any} */ (bins)),
      });
      if (s.via !== 'direct') continue;
      // 每个 argv 元素都原封不动地出现在 args 里，且没有任何元素是拼接产物
      for (const a of ['/n', '/c.js', 'exec', 'tok']) {
        assert.ok(s.args.includes(a), `${platform}: ${a} 应作为独立元素出现`);
      }
    }
  });
});
