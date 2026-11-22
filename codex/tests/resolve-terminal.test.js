// @ts-check
/**
 * `resolve-terminal.js` 的测试（§2.11 二·1）。
 *
 * ★ 这一组测试的**全部价值**在于：本机是 Windows，但下面每一条 macOS / Linux
 * 的断言都在本机跑得起来——因为 `resolveTerminal()` 把 `platform` 和 `env`
 * 当参数收，决策与副作用是分开的（这正是 §2.11 要求拆两步的原因）。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTerminal, buildTitle } from '../src/platform/resolve-terminal.js';
import { EnvError, EXIT } from '../src/core/errors.js';

/**
 * 造一份假的 `TerminalDeps`。
 *
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.found]     名字 → 路径（不在表里的就是"没找到"）
 * @param {Record<string, string>} [opts.links]     realpath 映射（专治 x-terminal-emulator）
 * @param {string} [opts.scriptPath]
 */
function fakeDeps({ found = {}, links = {}, scriptPath = '/h/profiles/a/launch.sh' } = {}) {
  return {
    findExecutable: (name) => found[name] ?? null,
    realpath: (p) => links[p] ?? null,
    scriptPath,
  };
}

/** 一次调用要的固定入参 */
const REQ = { title: 'cxt:relay-a · proj', cwd: '/work/proj', argv: ['codex', 'exec', 'hi'] };

/** gnome-terminal 的典型路径（多个 describe 都要用，所以放模块作用域） */
const G = '/usr/bin/gnome-terminal';

/**
 * @param {NodeJS.Platform} platform
 * @param {Record<string, string | undefined>} env
 * @param {Parameters<typeof fakeDeps>[0]} [depsOpts]
 */
function resolve(platform, env, depsOpts) {
  return resolveTerminal(REQ, { platform, env, deps: fakeDeps(depsOpts) });
}

// ═══════════════════════════ 标题 ═══════════════════════════

describe('buildTitle', () => {
  test('取 cwd 末段，两种路径风格都对', () => {
    assert.equal(buildTitle('relay-a', 'D:\\work\\proj', 'win32'), 'cxt:relay-a · proj');
    assert.equal(buildTitle('relay-a', '/work/proj', 'linux'), 'cxt:relay-a · proj');
  });

  test('★ 末尾有分隔符时末段不能是空串', () => {
    // `basename('/work/proj/')` 是 'proj'，但 `basename('/work/proj//')` 在
    // 某些实现下会给出空串——标题成了 `cxt:relay-a · `，等于没标题
    assert.equal(buildTitle('t', '/work/proj/', 'linux'), 'cxt:t · proj');
    assert.equal(buildTitle('t', 'D:\\work\\proj\\', 'win32'), 'cxt:t · proj');
  });

  test('cwd 是根目录时退回整条路径（不留空标题）', () => {
    assert.equal(buildTitle('t', '/', 'linux'), 'cxt:t · /');
    assert.equal(buildTitle('t', 'C:\\', 'win32'), 'cxt:t · C:\\');
  });
});

// ═══════════════════════════ Windows ═══════════════════════════

describe('resolveTerminal / win32', () => {
  test('wt 在 → 直接拉起（argv 不被任何 shell 解析）', () => {
    const spec = resolve('win32', { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }, {
      found: { wt: 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe' },
      scriptPath: 'C:\\h\\profiles\\a\\launch.cmd',
    });

    assert.equal(spec.terminal, 'wt');
    assert.equal(spec.command, 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe');
    assert.equal(spec.via, 'direct');
    assert.deepEqual(spec.args, [
      '-w', 'cxt',
      'new-tab',
      '--title', 'cxt:relay-a · proj',
      '--suppressApplicationTitle',
      '-d', '/work/proj',
      'codex', 'exec', 'hi',
    ]);
    assert.deepEqual(spec.warnings, []);
    assert.deepEqual(spec.tried, [], '首选就命中，不该有任何"试过但失败"的候选');
  });

  test('★ tab 模式落在**具名窗口**里，不是 `-w last`（§7.16）', () => {
    // `-w last` 的语义是"最近用过的窗口"——不是"上一个"、更不是"cxt 自己的窗口"。
    // 实测症状：连开三次 `cxt run`，**一个新窗口都没开**，三个标签页全落进了
    // 用户当时正在用的那个窗口（这里是 Claude Code 的窗口）。
    // 具名窗口的语义是"没有就建、有就加标签"，正好是我们要的自愈行为。
    const wt = { wt: 'C:\\wt.exe' };
    const tab = resolveTerminal(REQ, { platform: 'win32', env: {}, deps: fakeDeps({ found: wt }) });

    assert.deepEqual(tab.args.slice(0, 2), ['-w', 'cxt']);
    assert.ok(!tab.args.includes('last'), '`-w last` 是个坑，不许回来');
  });

  test('mode=window 用 `-w new`（总是新窗口），且**不报窗口名**', () => {
    const wt = { wt: 'C:\\wt.exe' };
    const win = resolveTerminal({ ...REQ, mode: 'window' }, { platform: 'win32', env: {}, deps: fakeDeps({ found: wt }) });

    assert.deepEqual(win.args.slice(0, 2), ['-w', 'new']);
    // ★ 只有 tab 模式有"具名窗口"可言。window 模式那个窗口没有名字，
    //   回执说"已在 cxt 窗口"就是假话（§2.11 二·1）。
    assert.equal(win.windowName, undefined);
  });

  test('★ tab 模式报窗口名（回执要说"标签页开到哪去了"）', () => {
    const spec = resolve('win32', {}, { found: { wt: 'C:\\wt.exe' } });
    assert.equal(spec.windowName, 'cxt');
  });

  test('★ `--suppressApplicationTitle` 必须**排在 `new-tab` 之后、`--title` 之后**', () => {
    // 两个"之后"各有一个实测理由（§7.16）：
    //   · `new-tab` 之后 —— 它是 `new-tab` 子命令的选项，写在前面 wt 不认；
    //   · `--title` 之后 —— 它压的是"应用程序自己设标题"这件事，
    //     顺序反了 codex 的 OSC 2 会赢，标签页显示成光秃秃的 `client-a`。
    const args = resolve('win32', {}, { found: { wt: 'C:\\wt.exe' } }).args;

    const iNewTab = args.indexOf('new-tab');
    const iSuppress = args.indexOf('--suppressApplicationTitle');
    const iTitle = args.indexOf('--title');
    assert.ok(iNewTab !== -1 && iSuppress !== -1 && iTitle !== -1, `三个都在才对：${JSON.stringify(args)}`);
    assert.ok(iNewTab < iSuppress, '`--suppressApplicationTitle` 得在 `new-tab` 之后');
    assert.ok(iTitle < iSuppress, '`--suppressApplicationTitle` 得在 `--title` 之后');
    assert.equal(args[iTitle + 1], 'cxt:relay-a · proj', '`--title` 后面紧跟标题本身');
  });

  test('wt 不在 → 退到 cmd，且**明确告知 cwd 由脚本承担**', () => {
    const spec = resolve('win32', { COMSPEC: 'C:\\Windows\\system32\\cmd.exe' }, {
      scriptPath: 'C:\\h\\profiles\\a\\launch.cmd',
    });

    assert.equal(spec.terminal, 'cmd');
    assert.equal(spec.command, 'C:\\Windows\\system32\\cmd.exe');
    assert.equal(spec.via, 'script', '走脚本 → 调用方必须先落盘 launch.cmd');
    assert.deepEqual(spec.args, [
      '/d', '/s', '/c',
      '"start "cxt:relay-a · proj" "C:\\h\\profiles\\a\\launch.cmd""',
    ]);
    assert.deepEqual(spec.tried, ['wt: PATH 里没找到', 'cmd: 兜底（用 %COMSPEC% = C:\\Windows\\system32\\cmd.exe）']);
    assert.equal(spec.warnings.length, 2, `tab 模式下有两条：cwd + 标签页降级\n${spec.warnings.join('\n')}`);
    assert.match(spec.warnings[0], /cwd 由 launch\.cmd 里的 cd 承担/);
    // ★ 用户要标签页、我们给新窗口——这是**降级**，不能默默发生（§2.11 二·1）
    assert.match(spec.warnings[1], /没有标签页概念/);
  });

  test('★ cmd 兜底 + mode=window → 只有 cwd 那条 warning（窗口正是用户要的）', () => {
    const spec = resolveTerminal(
      { ...REQ, mode: 'window' },
      { platform: 'win32', env: {}, deps: fakeDeps({ scriptPath: 'C:\\a\\launch.cmd' }) },
    );
    assert.equal(spec.warnings.length, 1);
    assert.match(spec.warnings[0], /cwd 由 launch\.cmd 里的 cd 承担/);
  });

  test('COMSPEC 缺失/为空 → 用 cmd.exe 字面量（别生成一个空命令）', () => {
    assert.equal(resolve('win32', {}).command, 'cmd.exe');
    assert.equal(resolve('win32', { COMSPEC: '' }).command, 'cmd.exe');
  });

  test('COMSPEC 的大小写变体都认（Windows 环境变量名不区分大小写）', () => {
    assert.equal(resolve('win32', { ComSpec: 'D:\\cmd.exe' }).command, 'D:\\cmd.exe');
  });

  test('路径里有 `;` → wt 会当成分屏符，必须出 warning 而不是静默出错', () => {
    const spec = resolveTerminal(
      { ...REQ, cwd: 'D:\\a;b\\proj' },
      { platform: 'win32', env: {}, deps: fakeDeps({ found: { wt: 'C:\\wt.exe' } }) },
    );
    assert.equal(spec.warnings.length, 1);
    assert.match(spec.warnings[0], /结构符/);
  });

  test('标题里的双引号在 cmd 兜底路径上被替换并出 warning', () => {
    const spec = resolveTerminal(
      { ...REQ, title: 'cxt:"weird"' },
      { platform: 'win32', env: {}, deps: fakeDeps({ scriptPath: 'C:\\a\\launch.cmd' }) },
    );
    assert.match(spec.args[3], /start "cxt:'weird'" /);
    assert.match(spec.warnings.join('\n'), /双引号已替换成单引号/);
  });
});

// ═══════════════════════════ macOS ═══════════════════════════

describe('resolveTerminal / darwin', () => {
  const OSA = '/usr/bin/osascript';
  const OPEN = '/usr/bin/open';

  test('$TERM_PROGRAM=iTerm → iTerm2（via script，脚本承担 argv）', () => {
    // ★ argv 里放一个**不可能自然出现**的标记，才能证明"argv 没进字符串"。
    //   别拿 `exec` / `codex` 这种词去断言——`launchCommandLine()` 自己就带 `exec`，
    //   那种断言会在自己人身上误报。
    const MARK = 'ZZ9-marker-argv';
    const spec = resolveTerminal(
      { ...REQ, argv: ['codex', MARK] },
      {
        platform: 'darwin',
        env: { TERM_PROGRAM: 'iTerm' },
        deps: fakeDeps({ found: { osascript: OSA, open: OPEN }, scriptPath: '/h/profiles/a/launch.sh' }),
      },
    );

    assert.equal(spec.terminal, 'iterm2');
    assert.equal(spec.command, OSA);
    assert.equal(spec.via, 'script');
    assert.equal(spec.args[0], '-e');
    assert.match(spec.args[1], /^tell application "iTerm2" to create window with default profile command "/);
    // ★ argv 一个都不该出现在 AppleScript 字符串里——只有脚本路径与标题
    assert.ok(!spec.args[1].includes(MARK), 'argv 泄漏进了 AppleScript 字符串');
    assert.ok(spec.args[1].includes('/h/profiles/a/launch.sh'), 'AppleScript 字符串里必须有脚本路径');
    assert.ok(spec.args[1].includes('cxt:relay-a'), 'AppleScript 字符串里必须有标题（否则窗口认不出来）');
  });

  test('★★ 设标题用的是 OSC 0：`ESC ] 0 ; 标题 BEL` —— 三个字节一个都不能少', () => {
    // ★ 这条是**源码卫生**那条规则（`source-hygiene.test.js`）的护栏。
    //   这三个字节原来在 `macos.js` 里是**裸的控制字符**——在编辑器里、
    //   在 diff 里、在 code review 里**都看不见**，谁"顺手清理一下"就悄悄没了，
    //   而症状是"窗口标题设不上"，离现场十万八千里。
    //   现在源码写的是 `\u001b` / `\u0007`，这条钉住**运行时的值**没变。
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    const spec = resolveTerminal(
      { ...REQ, argv: ['codex'] },
      {
        platform: 'darwin',
        env: { TERM_PROGRAM: 'iTerm' },
        deps: fakeDeps({ found: { osascript: OSA, open: OPEN }, scriptPath: '/h/profiles/a/launch.sh' }),
      },
    );

    // 整条匹配（而不是 `includes`）才证明得了"ESC 在 BEL 之前、中间是标题"。
    const m = new RegExp(`${ESC}\\]0;([^${BEL}]*)${BEL}`).exec(spec.args[1]);
    assert.ok(m !== null, `AppleScript 里没有完整的 OSC 0：${JSON.stringify(spec.args[1])}`);
    assert.match(m[1], /^cxt:relay-a/, 'OSC 0 的载荷该是标题');
  });

  test('★ $TERM_PROGRAM 认不出时**不许**试 iTerm2（会弹系统对话框卡住）', () => {
    for (const env of [{}, { TERM_PROGRAM: 'vscode' }, { TERM_PROGRAM: '' }]) {
      const spec = resolve('darwin', env, { found: { osascript: OSA, open: OPEN } });
      assert.equal(spec.terminal, 'terminal-app', `env=${JSON.stringify(env)} 时选了 ${spec.terminal}`);
    }
  });

  test('$TERM_PROGRAM=Apple_Terminal → Terminal.app', () => {
    const spec = resolve('darwin', { TERM_PROGRAM: 'Apple_Terminal' }, { found: { osascript: OSA, open: OPEN } });
    assert.equal(spec.terminal, 'terminal-app');
    assert.match(spec.args[1], /^tell application "Terminal" to do script "/);
  });

  test('osascript 不在 → 退到 `open -a Terminal`，且告知标题设不了', () => {
    const spec = resolve('darwin', {}, {
      found: { open: OPEN },
      scriptPath: '/h/profiles/a/launch.sh',
    });
    assert.equal(spec.terminal, 'open');
    assert.deepEqual(spec.args, ['-a', 'Terminal', '/h/profiles/a/launch.sh']);
    assert.equal(spec.via, 'script');
    assert.match(spec.warnings[0], /无法设置窗口标题/);
    assert.ok(spec.tried.some((t) => t.startsWith('osascript:')));
  });

  test('两样都没有 → EnvError(2)，且 tried 列出全部候选', () => {
    assert.throws(
      () => resolve('darwin', { TERM_PROGRAM: 'iTerm' }),
      (err) => {
        assert.ok(err instanceof EnvError);
        assert.equal(err.code, EXIT.ENV);
        assert.match(err.message, /osascript:/);
        assert.match(err.message, /open:/);
        assert.match(err.hint, /cxt exec/);
        return true;
      },
    );
  });
});

// ═══════════════════════════ Linux ═══════════════════════════

describe('resolveTerminal / linux', () => {
  const G = '/usr/bin/gnome-terminal';

  test('$TERMINAL=gnome-terminal → 直接拉起，cwd 走 --working-directory=', () => {
    const spec = resolve('linux', { TERMINAL: 'gnome-terminal' }, { found: { 'gnome-terminal': G } });

    assert.equal(spec.terminal, 'gnome-terminal');
    assert.equal(spec.command, G);
    assert.equal(spec.via, 'direct');
    assert.deepEqual(spec.args, [
      '--working-directory=/work/proj',
      '--title=cxt:relay-a · proj',
      '--',
      'codex', 'exec', 'hi',
    ]);
  });

  test('$TERMINAL 是表外的终端 → 不猜参数，继续下一个候选', () => {
    const spec = resolve('linux', { TERMINAL: 'wezterm' }, {
      found: { wezterm: '/usr/bin/wezterm', 'gnome-terminal': G },
    });

    assert.equal(spec.terminal, 'gnome-terminal');
    assert.equal(spec.command, G);
    assert.equal(spec.tried[0], 'wezterm: 认不出是哪个终端（已知表里没有），不猜它的 cwd 参数');
  });

  test('$TERMINAL 指了个不存在的名字 → 记进 tried 再继续', () => {
    const spec = resolve('linux', { TERMINAL: 'nope' }, { found: { konsole: '/usr/bin/konsole' } });
    assert.equal(spec.terminal, 'konsole');
    // 第一条必须是它——顺序即"用户先被问到的是什么"
    assert.equal(spec.tried[0], 'nope: PATH 里没找到');
    assert.ok(spec.tried.some((t) => t.startsWith('x-terminal-emulator:')));
  });

  test('★ x-terminal-emulator 指向 .wrapper 时**认不出**（wrapper 的参数不一定和本体一样）', () => {
    const link = '/usr/bin/x-terminal-emulator';
    assert.throws(
      () => resolve('linux', {}, { found: { 'x-terminal-emulator': link }, links: { [link]: '/usr/bin/gnome-terminal.wrapper' } }),
      (err) => {
        assert.match(err.message, /x-terminal-emulator: 认不出是哪个终端/);
        return true;
      },
    );
  });

  test('★ x-terminal-emulator → 直接指向表内终端时能认出来', () => {
    const link = '/usr/bin/x-terminal-emulator';
    const spec = resolve('linux', {}, {
      found: { 'x-terminal-emulator': link },
      links: { [link]: '/usr/bin/konsole' },
    });

    assert.equal(spec.terminal, 'konsole');
    assert.equal(spec.command, link, 'command 用的是软链路径本身（它才在 PATH 上）');
    assert.deepEqual(spec.args.slice(0, 2), ['--workdir', '/work/proj']);
  });

  test('xterm 没有 cwd 选项 → via script + 明确 warning', () => {
    const spec = resolve('linux', {}, {
      found: { 'x-terminal-emulator': '/usr/bin/xterm' },
      scriptPath: '/h/profiles/a/launch.sh',
    });

    assert.equal(spec.terminal, 'xterm');
    assert.equal(spec.via, 'script');
    assert.deepEqual(spec.args, ['-T', 'cxt:relay-a · proj', '-e', '/h/profiles/a/launch.sh']);
    assert.match(spec.warnings[0], /xterm 无 cwd 选项/);
  });

  test('全都没有、且不在 tmux 里 → EnvError(2)，tried 逐条说明为什么不行', () => {
    assert.throws(
      () => resolve('linux', {}),
      (err) => {
        assert.ok(err instanceof EnvError);
        assert.equal(err.code, EXIT.ENV);
        assert.match(err.message, /x-terminal-emulator: PATH 里没找到/);
        assert.match(err.message, /gnome-terminal: PATH 里没找到/);
        assert.match(err.message, /konsole: PATH 里没找到/);
        assert.match(err.message, /xterm: PATH 里没找到/);
        assert.match(err.message, /tmux: 不在 tmux 里/);
        assert.match(err.hint, /\$TERMINAL=/);
        return true;
      },
    );
  });

  test('tmux 兜底：只在 $TMUX 有值时用', () => {
    const spec = resolve('linux', { TMUX: '/tmp/tmux-1000/default,123,0' }, {
      found: { tmux: '/usr/bin/tmux' },
    });
    assert.equal(spec.terminal, 'tmux');
    assert.deepEqual(spec.args, ['new-window', '-c', '/work/proj', '-n', 'cxt:relay-a · proj', 'codex', 'exec', 'hi']);
    assert.equal(spec.via, 'direct');
  });

  test('$TMUX 有值但 tmux 不在 PATH → 报错里点出这个矛盾', () => {
    assert.throws(
      () => resolve('linux', { TMUX: 'x' }),
      (err) => {
        assert.match(err.message, /\$TMUX 有值但 PATH 里没找到 tmux/);
        return true;
      },
    );
  });

  test('$TERMINAL 优先于固定候选顺序', () => {
    const spec = resolve('linux', { TERMINAL: 'alacritty' }, {
      found: { alacritty: '/usr/bin/alacritty', 'gnome-terminal': G },
    });
    assert.equal(spec.terminal, 'alacritty');
  });
});

// ═══════════════════════════ 其它 ═══════════════════════════

describe('resolveTerminal / 边界', () => {
  test('未知平台 → EnvError，且提示 `cxt exec` 这条不需要终端的路', () => {
    assert.throws(
      () => resolve(/** @type {any} */ ('freebsd'), {}),
      (err) => {
        assert.ok(err instanceof EnvError);
        assert.match(err.hint, /cxt exec/);
        return true;
      },
    );
  });

  test('返回值形状统一：四个平台分支都给全七个字段', () => {
    const specs = [
      resolve('win32', {}, { found: { wt: 'C:\\wt.exe' } }),
      resolve('win32', {}, { scriptPath: 'C:\\a\\launch.cmd' }),
      resolve('darwin', {}, { found: { osascript: '/usr/bin/osascript' } }),
      resolve('linux', {}, { found: { 'gnome-terminal': G } }),
    ];
    for (const spec of specs) {
      for (const k of ['terminal', 'command', 'args', 'via', 'tried', 'warnings']) {
        assert.ok(k in spec, `缺字段 ${k}：${JSON.stringify(spec)}`);
      }
      assert.ok(Array.isArray(spec.args) && Array.isArray(spec.tried) && Array.isArray(spec.warnings));
      assert.ok(spec.via === 'direct' || spec.via === 'script');
      assert.ok(typeof spec.command === 'string' && spec.command !== '');
    }
  });
});
