// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 as win32Path } from 'node:path';

import {
  SHIM_EXTENSIONS,
  cmdShimArgv,
  needsCmdShim,
  pickCodexBin,
  quoteForCmdShim,
  shimCommandLine,
} from '../src/cli/codex-bin.js';
import { EnvError, EXIT } from '../src/core/errors.js';
import { codexFallbackPaths } from '../src/core/paths.js';

const IS_WIN = process.platform === 'win32';
const FAKE_HOME = 'C:\\fake\\home';

// ═══════════════════ needsCmdShim ═══════════════════

describe('needsCmdShim', () => {
  test('Windows 上 `.cmd` / `.bat` 要走 cmd', () => {
    assert.equal(needsCmdShim('C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd', 'win32'), true);
    assert.equal(needsCmdShim('C:\\tools\\thing.bat', 'win32'), true);
  });

  test('扩展名大小写不敏感', () => {
    assert.equal(needsCmdShim('C:\\x\\CODEX.CMD', 'win32'), true);
    assert.equal(needsCmdShim('C:\\x\\Codex.Cmd', 'win32'), true);
  });

  test('`.exe` / 无扩展名 / `.js` 都**不**走 cmd', () => {
    for (const p of ['C:\\x\\codex.exe', 'C:\\x\\codex', 'C:\\x\\codex.js', 'C:\\x\\codex.ps1']) {
      assert.equal(needsCmdShim(p, 'win32'), false, p);
    }
  });

  test('★ 非 Windows 一律 false——POSIX 上 `foo.cmd` 就是个普通文件', () => {
    for (const plat of ['linux', 'darwin', 'freebsd']) {
      assert.equal(needsCmdShim('/usr/local/bin/codex.cmd', plat), false, plat);
      assert.equal(needsCmdShim('/usr/local/bin/codex.bat', plat), false, plat);
    }
  });

  test('★ 只认**结尾**——目录名叫 `a.cmd` 不算', () => {
    assert.equal(needsCmdShim('C:\\a.cmd\\codex.exe', 'win32'), false);
  });
});

// ═══════════════════ quoteForCmdShim（纯转义规则）═══════════════════

describe('quoteForCmdShim', () => {
  test('朴素参数：加引号，内容不动', () => {
    assert.equal(quoteForCmdShim('hello'), '"hello"');
    assert.equal(quoteForCmdShim('hello world'), '"hello world"');
  });

  test('★ 尾随反斜杠翻倍（否则闭引号被吃掉）', () => {
    assert.equal(quoteForCmdShim('D:\\proj\\'), '"D:\\proj\\\\"');
    assert.equal(quoteForCmdShim('D:\\proj\\\\'), '"D:\\proj\\\\\\\\"');
  });

  test('中间的反斜杠**不**翻倍', () => {
    assert.equal(quoteForCmdShim('D:\\a\\b'), '"D:\\a\\b"');
  });

  test('★ 引号 → `""`', () => {
    assert.equal(quoteForCmdShim('say "hi"'), '"say ""hi"""');
  });

  test('★ 引号前的反斜杠也翻倍（`\\"` 会被读成转义引号）', () => {
    assert.equal(quoteForCmdShim('a\\"b'), '"a\\\\""b"');
  });

  test('★ 两条规则叠加时**不互相踩**（链式 replace 会在这里出错）', () => {
    // 尾随 `\"` 同时踩中"引号前反斜杠"和"引号转义"两条规则：
    // 反斜杠翻倍 + 引号成对，且**不能**把 `""` 再当成待处理的引号
    assert.equal(quoteForCmdShim('a\\"'), '"a\\\\"""');
    // 逐字符扫一遍：`a` + `\\`(翻倍) + `""` + 结尾无反斜杠
    assert.equal(quoteForCmdShim('a\\"').match(/""/g)?.length, 1, '只应出现一对 `""`');
  });

  test('空串 → `""`', () => {
    assert.equal(quoteForCmdShim(''), '""');
  });

  test('中文与空格原样保留', () => {
    assert.equal(quoteForCmdShim('D:\\工作\\我的 项目'), '"D:\\工作\\我的 项目"');
  });

  test('★ `%` 不动它（转不了，只能靠 cmdShimArgv 报警）', () => {
    assert.equal(quoteForCmdShim('%PATH%'), '"%PATH%"');
  });
});

// ═══════════════════ cmdShimArgv ═══════════════════

describe('cmdShimArgv', () => {
  const BIN = 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd';

  test('★ `/d /s /c` 三件套 + 整条再包一层引号', () => {
    const r = cmdShimArgv(BIN, ['exec', '--model', 'gpt-5']);
    assert.deepEqual(r.args.slice(0, 3), ['/d', '/s', '/c']);
    const line = shimCommandLine(r.args);
    assert.ok(line.startsWith('"'), '整条命令串要有一层外层引号（`/s` 剥的正是它）');
    assert.ok(line.endsWith('"'), '外层引号要闭合');
  });

  test('★ `verbatimArgs: true`——不然 Node 会把 `\\"` 转义一遍，前功尽弃', () => {
    assert.equal(cmdShimArgv(BIN, ['x']).verbatimArgs, true);
  });

  test('命令串 = 可执行文件 + 各参数，各自加引号', () => {
    const line = shimCommandLine(cmdShimArgv(BIN, ['exec', 'tok']).args);
    assert.equal(line, `""${BIN}" "exec" "tok""`);
  });

  test('没有参数时只有可执行文件', () => {
    assert.equal(shimCommandLine(cmdShimArgv(BIN, []).args), `""${BIN}""`);
  });

  test('★ `%VAR%` 报警——这是转不了的硬限制，必须说出来', () => {
    const r = cmdShimArgv(BIN, ['-C', 'D:\\100%\\proj']);
    assert.equal(r.warnings.length, 0, '`100%` 不是变量引用，不该报');
  });

  test('★ `%PATH%` 形态要报警', () => {
    const r = cmdShimArgv(BIN, ['-C', 'D:\\%TEMP%\\proj']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /%TEMP%/);
    assert.match(r.warnings[0], /展开/);
  });

  test('`50% off 20%` 不误报（`%` 后是空格，不是变量名）', () => {
    assert.equal(cmdShimArgv(BIN, ['50% off 20%']).warnings.length, 0);
  });

  test('多个参数里多个变量引用 → 多条警告', () => {
    assert.equal(cmdShimArgv(BIN, ['%A%', 'ok', '%B%']).warnings.length, 2);
  });

  test('正常参数不产生警告', () => {
    assert.deepEqual(cmdShimArgv(BIN, ['exec', '--model', 'gpt-5', 'D:\\work\\proj']).warnings, []);
  });
});

// ═══════════════════ pickCodexBin（四级定位，纯决策）═══════════════════

describe('pickCodexBin', () => {
  /** @param {{found?: string|null, files?: string[]}} o */
  const deps = (o = {}) => ({
    findExecutable: () => o.found ?? null,
    isFile: (p) => (o.files ?? []).includes(p),
  });

  test('1 级：显式配置且文件在 → 直接用，不探 PATH', () => {
    let probedPath = false;
    const r = pickCodexBin({
      configured: 'D:\\tools\\codex.exe',
      platform: 'win32',
      home: FAKE_HOME,
      deps: { findExecutable: () => { probedPath = true; return 'C:\\npm\\codex.cmd'; }, isFile: () => true },
    });
    assert.equal(r?.path, 'D:\\tools\\codex.exe');
    assert.equal(r?.level, 1);
    assert.equal(probedPath, false, '1 级命中就不该再探 PATH');
  });

  test('★ 1 级配了但文件不在 → **抛错，不静默回落**', () => {
    // 静默回落会让用户以为"我配的那个在用"，实际跑的是另一个版本
    assert.throws(
      () => pickCodexBin({
        configured: 'D:\\nope\\codex.exe',
        platform: 'win32',
        home: FAKE_HOME,
        deps: deps({ found: 'C:\\npm\\codex.cmd' }),
      }),
      (err) => {
        assert.ok(err instanceof EnvError);
        assert.equal(err.code, EXIT.ENV);
        assert.match(err.message, /D:\\nope\\codex\.exe/);
        assert.match(err.hint, /codexBin/);
        return true;
      },
    );
  });

  test('2 级：PATH 命中', () => {
    const r = pickCodexBin({
      configured: undefined,
      platform: 'win32',
      home: FAKE_HOME,
      deps: deps({ found: 'C:\\npm\\codex.cmd' }),
    });
    assert.equal(r?.path, 'C:\\npm\\codex.cmd');
    assert.equal(r?.level, 2);
    assert.deepEqual(r?.tried, [], '2 级就命中，没试过别的');
  });

  test('3 级：PATH 没有，常见安装路径命中', () => {
    const fallbacks = codexFallbackPaths(FAKE_HOME, 'win32');
    const r = pickCodexBin({
      configured: null,
      platform: 'win32',
      home: FAKE_HOME,
      deps: deps({ found: null, files: [fallbacks[0]] }),
    });
    assert.equal(r?.path, fallbacks[0]);
    assert.equal(r?.level, 3);
    assert.match(r?.tried[0] ?? '', /PATH 里没找到/);
  });

  test('★ 本机真实布局：`%APPDATA%\\npm\\codex.cmd` 是 3 级的首选', () => {
    assert.equal(codexFallbackPaths(FAKE_HOME, 'win32')[0], win32Path.join(FAKE_HOME, 'AppData', 'Roaming', 'npm', 'codex.cmd'));
  });

  test('3 级：跳过不存在的，取第一个存在的', () => {
    const fallbacks = codexFallbackPaths(FAKE_HOME, 'win32');
    const r = pickCodexBin({
      configured: null,
      platform: 'win32',
      home: FAKE_HOME,
      deps: deps({ found: null, files: [fallbacks[2]] }),
    });
    assert.equal(r?.path, fallbacks[2]);
    assert.equal(r?.tried.filter((t) => t.includes('不存在')).length, 2, '前两个要记进 tried');
  });

  test('4 级：全都找不到 → null（由调用方给"装它"的提示）', () => {
    const r = pickCodexBin({
      configured: null, platform: 'win32', home: FAKE_HOME, deps: deps(),
    });
    assert.equal(r, null);
  });

  test('POSIX 走另一套常见路径', () => {
    const fallbacks = codexFallbackPaths('/home/me', 'linux');
    assert.deepEqual(fallbacks, ['/home/me/.local/bin/codex', '/usr/local/bin/codex', '/opt/homebrew/bin/codex']);
    const r = pickCodexBin({
      configured: null, platform: 'linux', home: '/home/me', deps: deps({ files: ['/usr/local/bin/codex'] }),
    });
    assert.equal(r?.path, '/usr/local/bin/codex');
    assert.equal(r?.level, 3);
  });

  test('空串配置 = 没配（不是"配了一个空路径"）', () => {
    const r = pickCodexBin({
      configured: '', platform: 'win32', home: FAKE_HOME, deps: deps({ found: 'C:\\npm\\codex.cmd' }),
    });
    assert.equal(r?.level, 2);
  });
});

// ═══════════════════ ★ 真机往返：转义到底对不对 ═══════════════════

describe('★ 真机往返（经真 cmd.exe 跑一个 .cmd）', () => {
  /**
   * 造一个 npm 风格的 `.cmd`：把参数原样转交给一个 Node 脚本，
   * 脚本把 `process.argv.slice(2)` 写成 JSON。这样"子进程到底收到了什么"
   * 就是可读的事实，而不是靠肉眼看控制台（控制台还有 OEM 编码干扰）。
   */
  function makeShim() {
    const dir = nodeFs.mkdtempSync(win32Path.join(tmpdir(), 'cxt-bin-'));
    const dumpJs = win32Path.join(dir, 'dump.js');
    const probeCmd = win32Path.join(dir, 'probe.cmd');
    const outFile = win32Path.join(dir, 'argv.json');

    nodeFs.writeFileSync(
      dumpJs,
      `import nodeFs from 'node:fs';\n`
      + `nodeFs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify(process.argv.slice(2)), 'utf8');\n`,
      'utf8',
    );
    nodeFs.writeFileSync(
      probeCmd,
      ['@ECHO off', 'SETLOCAL', 'SET "_prog=node"', `"%_prog%" "${dumpJs}" %*`, 'ENDLOCAL'].join('\r\n') + '\r\n',
      'ascii',
    );

    return {
      dir,
      probeCmd,
      /** 经我们自己的 cmdShimArgv 跑一遍 */
      viaShim(args) {
        nodeFs.rmSync(outFile, { force: true });
        const shim = cmdShimArgv(probeCmd, args);
        const r = spawnSync(process.env.COMSPEC ?? 'cmd.exe', shim.args, {
          encoding: 'utf8',
          windowsVerbatimArguments: shim.verbatimArgs,
        });
        if (r.error) throw r.error;
        return { argv: JSON.parse(nodeFs.readFileSync(outFile, 'utf8')), warnings: shim.warnings };
      },
      /** 基准真相：不经任何 shell */
      direct(args) {
        nodeFs.rmSync(outFile, { force: true });
        const r = spawnSync(process.execPath, [dumpJs, ...args], { encoding: 'utf8' });
        if (r.error) throw r.error;
        return JSON.parse(nodeFs.readFileSync(outFile, 'utf8'));
      },
    };
  }

  const CASES = [
    ['朴素', 'hello'],
    ['带空格', 'hello world'],
    ['和号', 'a & b'],
    ['脱字符', 'a ^ b'],
    ['竖线', 'a | b'],
    ['重定向', 'a > b'],
    ['裸百分号', '100%'],
    ['中文 + 空格', 'D:\\工作\\我的 项目'],
    ['双引号', 'say "hi"'],
    ['反斜杠结尾', 'D:\\proj\\'],
    ['双反斜杠结尾', 'D:\\proj\\\\'],
    ['盘符根', 'D:\\'],
    ['等号与逗号', '--config a=b,c=d'],
  ];

  test('★ 逐例对照基准真相——13/13 必须一字不差', { skip: !IS_WIN }, () => {
    const s = makeShim();
    /** @type {string[]} */
    const bad = [];
    for (const [label, arg] of CASES) {
      const want = s.direct([arg]);
      const got = s.viaShim([arg]).argv;
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        bad.push(`${label}: 期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}`);
      }
    }
    assert.deepEqual(bad, [], `经 cmd shim 后参数走样：\n${bad.join('\n')}`);
  });

  test('★ 多参数一起过（顺序与边界都不能串）', { skip: !IS_WIN }, () => {
    const s = makeShim();
    const args = ['exec', '--model', 'gpt-5', '-C', 'D:\\工作\\my proj\\', '--', 'say "hi"'];
    assert.deepEqual(s.viaShim(args).argv, s.direct(args));
  });

  test('★ `%VAR%` 确实会被展开——这是**已知且已报警**的硬限制', { skip: !IS_WIN }, () => {
    const s = makeShim();
    const arg = '%PATH%';
    const want = s.direct([arg]);
    const { argv, warnings } = s.viaShim([arg]);

    assert.deepEqual(want, ['%PATH%'], '前提：不经 shell 时它是字面量');
    assert.notDeepEqual(argv, want, '经 cmd 就是会被展开——本用例把这个事实钉住');
    assert.equal(warnings.length, 1, '★ 展开是不可避免的，但**必须报警**');
    assert.match(warnings[0], /%PATH%/);
  });

  test('★ 非变量形态的百分号**不**被展开（报警规则不能过宽）', { skip: !IS_WIN }, () => {
    const s = makeShim();
    for (const arg of ['100%', '50% off 20%']) {
      const { argv, warnings } = s.viaShim([arg]);
      assert.deepEqual(argv, s.direct([arg]), `${arg} 不该被改动`);
      assert.deepEqual(warnings, [], `${arg} 不该报警`);
    }
  });

  test('真实 codex.cmd 的存在性（本机装了才跑）', { skip: !IS_WIN }, () => {
    const npmDir = win32Path.join(process.env.APPDATA ?? '', 'npm');
    if (!nodeFs.existsSync(win32Path.join(npmDir, 'codex.cmd'))) return;
    assert.equal(needsCmdShim(win32Path.join(npmDir, 'codex.cmd'), 'win32'), true);
    // ★ 它**没有** `.exe` 兄弟——所以 shim 这条路绕不开
    assert.equal(nodeFs.existsSync(win32Path.join(npmDir, 'codex.exe')), false,
      '若这里变 true，说明 npm 改了安装布局，可以去掉 cmd shim 了');
  });
});

// ═══════════════════ 常量 ═══════════════════

describe('SHIM_EXTENSIONS', () => {
  test('冻结且只含 Node 拒绝直接 spawn 的两类', () => {
    assert.deepEqual([...SHIM_EXTENSIONS], ['.cmd', '.bat']);
    assert.ok(Object.isFrozen(SHIM_EXTENSIONS));
  });
});
