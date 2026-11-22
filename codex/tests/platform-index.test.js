// @ts-check
/**
 * `platform/index.js`（门面）的测试。
 *
 * 门面是**唯一读宿主真实值**的地方，所以这一组测试里有一半是**真机断言**：
 * 它们不是在测"逻辑对不对"，而是在测"这台机器上到底走哪条路"。
 * 那种断言在本机跑绿、在 CI 上跳过，是刻意的——见每条的 `if (!IS_WIN) return`。
 *
 * 纯逻辑的覆盖在 `resolve-terminal.test.js`（27 条）与 `find-executable.test.js`（55 条）。
 */

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { win32 as win32Path, posix as posixPath } from 'node:path';

import {
  hostPlatform,
  hostEnv,
  hostHome,
  findExecutable,
  realpathOrNull,
  resolveHostTerminal,
  detectTerminal,
  buildTitle,
} from '../src/platform/index.js';
import { EnvError } from '../src/core/errors.js';

const IS_WIN = process.platform === 'win32';

describe('门面 / 宿主值', () => {
  test('hostPlatform() 是 Node 认识的三个平台之一', () => {
    assert.ok(['win32', 'darwin', 'linux'].includes(hostPlatform()), `意外的平台：${hostPlatform()}`);
  });

  test('hostHome() 不带尾部分隔符（下游到处要用，别让他们各写一遍正则）', () => {
    const h = hostHome();
    assert.ok(typeof h === 'string' && h !== '');
    assert.ok(!/[\\/]$/.test(h), `home 带了尾部分隔符：${JSON.stringify(h)}`);
  });

  test('hostEnv() 就是 process.env（不是副本）', () => {
    assert.equal(hostEnv(), process.env);
  });

  test('realpathOrNull()：存在的给真路径，不存在的给 null（不抛）', () => {
    const here = realpathOrNull(process.execPath);
    assert.ok(typeof here === 'string' && here.length > 0, `realpath 失败：${process.execPath}`);
    assert.equal(realpathOrNull(win32Path.join(hostHome(), '__cxt_不存在__', 'x')), null);
  });
});

describe('门面 / findExecutable（宿主绑定）', () => {
  test('node 自己一定找得到——拿 process.execPath 的目录当 oracle', () => {
    // 把 node 所在目录塞进 PATH，然后找 node 的 basename。
    // ★ 这是唯一一种"不依赖本机装了什么"的真机断言。
    const dir = win32Path.dirname(process.execPath);
    const base = win32Path.basename(process.execPath);
    const env = { ...hostEnv(), PATH: dir };
    const hit = findExecutable(base, { platform: 'win32', env });

    assert.ok(hit !== null, `在 ${dir} 里没找到 ${base}`);
    assert.ok(nodeFs.existsSync(hit), `返回了不存在的路径：${hit}`);
  });

  test('★ 返回的是**磁盘上的真实拼写**——PATHEXT 是大写，磁盘上是小写', () => {
    if (!IS_WIN) return;
    const hit = findExecutable('codex');
    if (hit === null) return;   // 这台机器没装 codex，跳过（不假装通过）
    assert.ok(nodeFs.existsSync(hit), `返回了不存在的路径：${hit}`);
    // 真实拼写 = readdir 能列出来的那个名字
    const listed = nodeFs.readdirSync(win32Path.dirname(hit));
    assert.ok(listed.includes(win32Path.basename(hit)), `拼写与磁盘不符：${hit}`);
  });

  test('注入空 env → 找不到（别退化成"扫全盘"）', () => {
    assert.equal(findExecutable('codex', { platform: 'win32', env: {} }), null);
    assert.equal(findExecutable('codex', { platform: 'linux', env: {} }), null);
  });
});

describe('门面 / detectTerminal（宿主绑定）', () => {
  const SCRIPT = IS_WIN
    ? 'C:\\h\\profiles\\a\\launch.cmd'
    : posixPath.join(hostHome(), 'h', 'profiles', 'a', 'launch.sh');

  test('★ 真机：本机能算出一条可用的终端规格（不抛错）', () => {
    const r = detectTerminal({ title: 'cxt:probe · x', cwd: hostHome(), scriptPath: SCRIPT });

    assert.equal(r.ok, true, `终端探测失败：${r.ok === false ? r.message : ''}`);
    if (r.ok !== true) return;
    assert.ok(['wt', 'cmd', 'iterm2', 'terminal-app', 'open', 'tmux'].includes(r.spec.terminal)
      || r.spec.terminal.includes('terminal')
      || r.spec.terminal.includes('konsole')
      || r.spec.terminal.includes('xterm'),
    `意外的终端名：${r.spec.terminal}`);
    assert.ok(r.spec.command.length > 0);
    assert.ok(r.spec.args.every((a) => typeof a === 'string'));
  });

  test('★ 真机：Windows 上若 wt 在，必须选它（§2.11 的首选）', () => {
    if (!IS_WIN) return;
    const wt = findExecutable('wt');
    if (wt === null) return;   // 没装 Windows Terminal，跳过
    const r = detectTerminal({ title: 'cxt:probe · x', cwd: hostHome(), scriptPath: SCRIPT });
    assert.equal(r.ok, true);
    if (r.ok !== true) return;
    assert.equal(r.spec.terminal, 'wt', 'wt 在 PATH 上却没被选中——§7.14⑤ 的兜底可能又坏了');
    assert.equal(r.spec.via, 'direct');
    assert.equal(r.spec.verbatimArgs, undefined, 'wt 这条路不该置 verbatimArgs（会让含空格的路径被切开）');
  });

  test('★ cmd 兜底必须置 verbatimArgs（否则 Node 会把引号加工成 cmd 不认的 `\\"`）', () => {
    // 用注入的空 PATH 逼出兜底路径——这条在任何机器上都跑得起来
    const r = detectTerminal({
      title: 'cxt:probe · x',
      cwd: 'C:\\work',
      scriptPath: 'C:\\h\\launch.cmd',
      platform: 'win32',
      env: { COMSPEC: 'C:\\Windows\\system32\\cmd.exe', PATH: '' },
    });

    assert.equal(r.ok, true);
    if (r.ok !== true) return;
    assert.equal(r.spec.terminal, 'cmd');
    assert.equal(r.spec.via, 'script');
    assert.equal(r.spec.verbatimArgs, true);
    assert.deepEqual(r.spec.args.slice(0, 3), ['/d', '/s', '/c']);
  });

  test('★ 探测全失败 → ok:false 且 tried 逐条带原因（doctor 靠它说话）', () => {
    const r = detectTerminal({
      title: 'cxt:probe · x',
      cwd: '/work',
      scriptPath: '/h/launch.sh',
      platform: 'linux',
      env: { PATH: '' },
    });

    assert.equal(r.ok, false);
    if (r.ok === true) return;
    assert.ok(r.tried.length >= 4, `tried 太短：${JSON.stringify(r.tried)}`);
    assert.ok(r.tried.some((t) => t.includes('gnome-terminal')), 'tried 里没有 gnome-terminal');
    assert.ok(r.tried.some((t) => t.includes('$TMUX')), 'tried 里没说清为什么跳过 tmux');
  });

  test('detectTerminal 用的是占位 argv（doctor 不该把真实命令摆出来）', () => {
    const r = detectTerminal({
      title: 't', cwd: 'C:\\w', scriptPath: 'C:\\h\\launch.cmd',
      platform: 'win32', env: { COMSPEC: 'cmd.exe', PATH: '' },
    });
    assert.equal(r.ok, true);
    if (r.ok !== true) return;

    // ★ 两条路的 argv 去处不同，断言也得分开写：
    //   `direct` 路径 argv 就在命令行里 → 必须是占位符；
    //   `script` 路径 argv 被落进了脚本 → 命令行里**根本不该有**它（更不该有真实命令）。
    if (r.spec.via === 'direct') {
      assert.ok(r.spec.args.some((a) => a.includes('<argv>')), 'argv 占位符没进命令');
    } else {
      assert.ok(!r.spec.args.some((a) => a.includes('codex')), 'script 路径的命令行里不该出现真实命令');
    }
  });
});

describe('门面 / resolveHostTerminal', () => {
  test('scriptPath 由调用方给——platform 层不知道 profiles/ 怎么排布', () => {
    // ★ 用 win32 + 空 PATH 逼出 cmd 兜底：它是**唯一**把 scriptPath 放进命令行的路径，
    //   所以这条断言能确定性地验"调用方给的 scriptPath 一路传到了 args 里"。
    //   （不拿 linux 的 xterm 来测：`$PATH` 在 linux 规则下按 `:` 切，
    //     而 Windows 的临时目录自带 `C:` —— 那正是 find-executable.test.js 里
    //     已经踩过并记下来的盘符冒号坑。）
    const r = detectTerminal({
      title: 't', cwd: 'C:\\w', scriptPath: 'C:\\custom\\launch.cmd',
      platform: 'win32', env: { COMSPEC: 'cmd.exe', PATH: '' },
    });
    assert.equal(r.ok, true);
    if (r.ok !== true) return;
    assert.ok(r.spec.args.at(-1).includes('C:\\custom\\launch.cmd'), `scriptPath 没传进去：${r.spec.args.at(-1)}`);
  });

  test('探测失败时抛 EnvError(2)——`cxt run` 靠这个退出码', () => {
    assert.throws(
      () => resolveHostTerminal(
        { title: 't', cwd: '/w', argv: ['codex'] },
        { scriptPath: '/h/launch.sh', platform: 'linux', env: { PATH: '' } },
      ),
      EnvError,
    );
  });

  test('buildTitle 从门面转出来（cli 层只 import 门面，不直接摸适配器）', () => {
    assert.equal(buildTitle('a', '/w/proj', 'linux'), 'cxt:a · proj');
  });
});
