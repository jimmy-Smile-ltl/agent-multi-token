// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCxtCommandLine, buildLaunchCmd, buildLaunchScript, buildLaunchSh,
  quoteCmdValue, quoteShValue,
} from '../src/core/launch-script.js';

const userError = { name: 'CxtError' };

/** 一份典型输入——Windows 路径、带空格的目录、中文 token 名（见下方 ASCII 组） */
const BASE = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  cxtPath: 'D:\\tools\\cxt\\bin\\cxt.js',
  execArgs: ['relay-a'],
  platform: /** @type {const} */ ('win32'),
};

/** 逐行取（去掉末尾空行），断言时比整串好读 */
const lines = (s) => s.split(/\r?\n/).filter((l) => l !== '');

// ═══════════════════════ 唯一的 argv 源头 ═══════════════════════

describe('buildCxtCommandLine —— 两条路共用的那一条命令行', () => {
  test('★ 形状钉死：`[node, cxt, exec, ...execArgs]`', () => {
    assert.deepEqual(
      buildCxtCommandLine({ nodePath: 'N', cxtPath: 'C', execArgs: ['relay-a', '--cwd', 'D:/x'] }),
      ['N', 'C', 'exec', 'relay-a', '--cwd', 'D:/x'],
    );
  });

  test('★ 没有 execArgs 时也带 `exec`——空 token 不是"少一段"的理由', () => {
    assert.deepEqual(buildCxtCommandLine({ nodePath: 'N', cxtPath: 'C', execArgs: [] }),
      ['N', 'C', 'exec']);
  });

  test('★ `execArgs` 逐字进、不重排——顺序变了 token 就跑到 flag 后面去了', () => {
    const execArgs = ['--model', 'm', 'relay-a', '--', '--x'];
    const head = buildCxtCommandLine({ nodePath: 'N', cxtPath: 'C', execArgs });
    assert.deepEqual(head.slice(3), execArgs);
  });

  test('★ 两个脚本生成器都真的用它——脚本里 head 三段必须与它逐字一致', () => {
    // 这条守的是"只有一个源头"本身：将来谁在 buildLaunchCmd 里重新手拼一遍，
    // 就会和这里对不上。真机已经因为两处各拼一遍吃过两次亏（漏 exec / 漏 node）。
    const head = buildCxtCommandLine(BASE);
    const cmd = lines(buildLaunchCmd(BASE)).at(-1);
    const sh = lines(buildLaunchSh(BASE)).at(-1);

    for (const [what, line, q] of [
      ['launch.cmd', cmd, (s) => `"${s.replace(/%/g, '%%')}"`],
      // `.sh` 会把 `\` 换成 `/`（`\` 在 POSIX 上是合法文件名字符，但 Windows 路径必须转）
      ['launch.sh', sh, (s) => `'${s.replace(/\\/g, '/')}'`],
    ]) {
      assert.ok(line.includes(`${q(head[0])} ${q(head[1])} ${head[2]} `),
        `★ ${what} 的头部不是 buildCxtCommandLine() 的产物：\n    ${line}`);
    }
  });
});

// ═══════════════════════ 转义函数本身 ═══════════════════════

describe('quoteCmdValue / quoteShValue —— 两个平台完全不同的引号规则', () => {
  test('cmd：一律双引号包裹', () => {
    assert.equal(quoteCmdValue('D:\\a b\\c'), '"D:\\a b\\c"');
  });

  test('★ cmd：`%` 必须写成 `%%`——它在引号内**也会**展开', () => {
    assert.equal(quoteCmdValue('D:\\100%\\x'), '"D:\\100%%\\x"');
    assert.equal(quoteCmdValue('%PATH%'), '"%%PATH%%"');
  });

  test('cmd：路径含双引号 → 报错，不生成"看起来对、跑起来错"的脚本', () => {
    assert.throws(() => quoteCmdValue('D:\\a"b'), userError);
  });

  test('sh：一律单引号包裹——单引号内连 `\\` 和 `$` 都是字面量', () => {
    assert.equal(quoteShValue('D:/a b/c'), "'D:/a b/c'");
    assert.equal(quoteShValue('/a/$HOME/b'), "'/a/$HOME/b'");
    assert.equal(quoteShValue('/a\\b'), "'/a\\b'");
  });

  test("★ sh：内部的 `'` 用 `'\\''` 收尾重开（POSIX 唯一的例外）", () => {
    assert.equal(quoteShValue("/a/it's/b"), `'/a/it'\\''s/b'`);
  });
});

// ═══════════════════════ 契约 1：绝对路径，不依赖 PATH ═══════════════════════

describe('★ 契约 1 —— 绝对路径调用，任何一步都不依赖 PATH', () => {
  test('node 与 cxt 都用传入的绝对路径，不出现裸 `node` / `cxt`', () => {
    const text = buildLaunchCmd(BASE);
    assert.ok(text.includes('"C:\\Program Files\\nodejs\\node.exe"'));
    assert.ok(text.includes('"D:\\tools\\cxt\\bin\\cxt.js"'));
    // 命令行的开头就是 node 的绝对路径——不是 `node ...`
    assert.match(lines(text).at(-1) ?? '', /^"C:\\Program Files\\nodejs\\node\.exe" /);
  });

  test('sh 版把反斜杠转成正斜杠（POSIX 上 `\\` 只是普通字符）', () => {
    const text = buildLaunchSh({ ...BASE, platform: 'linux' });
    assert.ok(text.includes(`'C:/Program Files/nodejs/node.exe'`));
    assert.ok(text.includes(`'D:/tools/cxt/bin/cxt.js'`));
  });
});

// ═══════════════════════ 契约 2：默认不写 cwd ═══════════════════════

describe('★ 契约 2 —— 默认不写 cwd（cwd 由终端的 cwd 参数传）', () => {
  test('cwd 省略 → 脚本里没有 cd', () => {
    assert.ok(!/\bcd\b/.test(buildLaunchCmd(BASE)));
    assert.ok(!/\bcd\b/.test(buildLaunchSh({ ...BASE, platform: 'linux' })));
  });

  test('cwd 显式给出 → 才写 cd（兜底路径 ①②）', () => {
    assert.ok(buildLaunchCmd({ ...BASE, cwd: 'D:\\work\\client-a' }).includes('cd /d "D:\\work\\client-a"'));
    assert.ok(buildLaunchSh({ ...BASE, platform: 'linux', cwd: '/work/a' }).includes("cd '/work/a'"));
  });

  test('★ cmd 的 cd 带 `/d`——否则跨盘符切换会静默失败', () => {
    // `cd D:\x` 在 C: 盘上不换盘，只改 C: 盘的当前目录；`cd /d` 才真的切过去
    assert.match(buildLaunchCmd({ ...BASE, cwd: 'D:\\work' }), /cd \/d /);
  });

  test('cd 写在命令行**之前**', () => {
    const ls = lines(buildLaunchCmd({ ...BASE, cwd: 'D:\\work' }));
    assert.ok(ls.findIndex((l) => l.startsWith('cd /d')) < ls.findIndex((l) => l.startsWith('"C:')));
  });
});

// ═══════════════════════ 契约 3：参数透传 ═══════════════════════

describe('★ 契约 3 —— 参数透传', () => {
  test('★ cmd 用 `%*`，且它**不被**转义成 `%%*`', () => {
    const text = buildLaunchCmd(BASE);
    assert.ok(text.includes(' %*'));
    assert.ok(!text.includes('%%*'), '`%*` 被 quoteCmdValue 处理了——透传会失效');
  });

  test('★ sh 用 `"$@"`（带双引号，保证每个参数各自成一个词）', () => {
    assert.ok(buildLaunchSh({ ...BASE, platform: 'linux' }).includes(' "$@"'));
  });

  test('token 作为位置参数传，且是**值**所以加引号', () => {
    assert.ok(buildLaunchCmd(BASE).includes(' exec "relay-a"'));
    assert.ok(buildLaunchSh({ ...BASE, platform: 'linux' }).includes(" exec 'relay-a'"));
  });

  test('`execArgs` 逐个加引号——**flag 自己也加**（规则只有"`exec` 不加，其余都加"）', () => {
    // 契约原先写的是"固定关键字不加引号，只有值加"，但那要求本函数**认识**
    // `exec` 的 flag 集合：每加一个 flag 都要回来改一次，正是 §2.12 要避免的分叉。
    // 统一加引号后语义完全等价（cmd 与 sh 都把 `"--model"` 当 `--model`）。
    const cmd = buildLaunchCmd({ ...BASE, execArgs: ['relay-a', '--model', 'deepseek-chat', '-c'] });
    assert.ok(cmd.includes('"--model" "deepseek-chat" "-c"'));
    const sh = buildLaunchSh({ ...BASE, platform: 'linux', execArgs: ['relay-a', '--model', 'x'] });
    assert.ok(sh.includes("'--model' 'x'"));
  });

  test('★ `--` 分隔符也照常加引号，且位置不变（它是 cxt 与 codex 的分界）', () => {
    const cmd = buildLaunchCmd({ ...BASE, execArgs: ['relay-a', '--', '--no-alt-screen'] });
    assert.ok(cmd.includes('"--" "--no-alt-screen"'));
  });

  test('execArgs 为空 → 只有裸 `exec`，不留多余空格', () => {
    const cmd = lines(buildLaunchCmd({ ...BASE, execArgs: [] })).at(-1) ?? '';
    assert.ok(cmd.endsWith('cxt.js" exec %*'), `实得：${cmd}`);
  });

  test('execArgs 排在 `%*` / `"$@"` 之前（用户附加的 flag 落在最后）', () => {
    const cmd = lines(buildLaunchCmd({ ...BASE, execArgs: ['relay-a', '--no-alt-screen'] })).at(-1) ?? '';
    assert.ok(cmd.includes('"--no-alt-screen"'));
    assert.ok(cmd.indexOf('"--no-alt-screen"') < cmd.indexOf('%*'));
  });
});

// ═══════════════════════ 契约 4：不出现任何密钥 ═══════════════════════

describe('★ 契约 4 —— 脚本里绝不出现密钥（§2.7 铁律）', () => {
  test('token 传的是**名字**，不是值', () => {
    const text = buildLaunchCmd({ ...BASE, execArgs: ['relay-a'] });
    assert.ok(text.includes('"relay-a"'));
    // 值的形态（sk- 开头）不该出现——`run` 压根不会把它放进 execArgs
    assert.ok(!/sk-/.test(text));
  });

  test('★ 本模块不接收环境值——密钥由 exec 自己从进程环境读，不经过脚本', () => {
    const text = buildLaunchCmd(BASE);
    assert.ok(!text.includes('CXT_TOKEN'));
    assert.ok(!text.includes('CODEX_HOME'));
  });

  test('★ 接口上没有任何"环境 / 凭证"入口（结构保证，不是靠过滤）', () => {
    // ⚠️ 这条保证**比它看起来弱**，必须说清楚：
    //   `execArgs` 是个字符串数组，理论上能塞进 `--token-value sk-xxx`。
    //   本模块**拦不住**它（也无从判断哪个字符串是密钥）——拦住它的是**调用方**：
    //   `cxt run` 在走脚本兜底路径时会直接拒绝带 `--token-value` 的调用（见 run.js）。
    //   所以这里断言的是"**本模块自己不产生**任何密钥字段"，
    //   返回值里也不该冒出多余的东西。
    const keys = Object.keys(buildLaunchScript({ ...BASE, platform: 'win32', cwd: null }));
    assert.deepEqual(keys.sort(), ['eol', 'fileName', 'needsChmod', 'text']);
  });
});

// ═══════════════════════ 编码：CRLF / LF / 纯 ASCII ═══════════════════════

describe('★ 编码规则（§2.12 + §7.14③）', () => {
  test('★ `.cmd` 用 CRLF', () => {
    const text = buildLaunchCmd(BASE);
    assert.ok(text.includes('\r\n'));
    assert.equal(text.split('\r\n').length - 1, text.split('\n').length - 1, '有裸 LF 混进来了');
  });

  test('★ `.sh` 用 LF，且**一个 CR 都没有**', () => {
    // `#!/bin/sh\r` 在多数 shell 上报 `bad interpreter`，报错完全不指向换行符
    const text = buildLaunchSh({ ...BASE, platform: 'linux' });
    assert.ok(!text.includes('\r'));
    assert.ok(text.startsWith('#!/bin/sh\n'));
  });

  test('`.sh` 以换行结尾（没有的话 `chmod +x` 后最后一行可能被吞）', () => {
    assert.ok(buildLaunchSh({ ...BASE, platform: 'linux' }).endsWith('\n'));
  });

  test('★ `.cmd` 整个文件纯 ASCII——中文注释会让 cmd 把后面的字节读花', () => {
    const text = buildLaunchCmd({ ...BASE, cwd: 'D:\\work\\a' });
    assert.ok([...text].every((c) => c.charCodeAt(0) <= 0x7f), '有非 ASCII 字符');
  });

  test('★ `.cmd` 注释必须是英文（理由同上）', () => {
    const comments = lines(buildLaunchCmd(BASE)).filter((l) => l.startsWith('REM '));
    assert.ok(comments.length > 0);
    for (const c of comments) {
      assert.ok([...c].every((ch) => ch.charCodeAt(0) <= 0x7f), `注释含非 ASCII：${c}`);
    }
  });

  test('★ 非 ASCII 在**拼进去之前**就被拦下，且报错点名是哪一段', () => {
    // 与其"生成完再检查"，不如逐段查——报错才能指到具体是哪一段
    assert.throws(() => buildLaunchCmd({ ...BASE, cwd: 'D:\\工作\\a' }), (err) => {
      assert.equal(err.name, 'CxtError');
      assert.match(err.message, /cwd/);
      return true;
    });
    assert.throws(() => buildLaunchCmd({ ...BASE, execArgs: ['中继'] }), /exec 参数\[0\]/);
    assert.throws(() => buildLaunchCmd({ ...BASE, nodePath: 'C:\\程序\\node.exe' }), /node 路径/);
  });

  test('sh 版**不**受 ASCII 限制（Linux 上中文路径完全正常）', () => {
    const text = buildLaunchSh({ ...BASE, platform: 'linux', cwd: '/home/t/工作' });
    assert.ok(text.includes("cd '/home/t/工作'"));
  });
});

// ═══════════════════════ buildLaunchScript：文件名与内容绑在一起 ═══════════════════════

describe('buildLaunchScript —— 文件名、换行符、chmod 三者不可分', () => {
  test('win32 → launch.cmd / CRLF / 不需要 chmod', () => {
    const r = buildLaunchScript({ ...BASE, platform: 'win32' });
    assert.equal(r.fileName, 'launch.cmd');
    assert.equal(r.eol, 'CRLF');
    assert.equal(r.needsChmod, false);
    assert.equal(r.text, buildLaunchCmd(BASE));
  });

  test('linux → launch.sh / LF / 需要 chmod', () => {
    const r = buildLaunchScript({ ...BASE, platform: 'linux' });
    assert.equal(r.fileName, 'launch.sh');
    assert.equal(r.eol, 'LF');
    assert.equal(r.needsChmod, true);
  });

  test('darwin → 同 linux', () => {
    const r = buildLaunchScript({ ...BASE, platform: 'darwin' });
    assert.equal(r.fileName, 'launch.sh');
    assert.equal(r.needsChmod, true);
  });

  test('★ 文件名与换行符不会错配（`.sh` 拿到 CRLF 是最难查的一类 bug）', () => {
    for (const p of ['win32', 'linux', 'darwin']) {
      const r = buildLaunchScript({ ...BASE, platform: /** @type {any} */ (p) });
      if (r.fileName === 'launch.cmd') assert.ok(r.text.includes('\r\n'), `${p}: cmd 却不是 CRLF`);
      else assert.ok(!r.text.includes('\r'), `${p}: sh 却有 CR`);
    }
  });

  test('未知 platform → 报错（不猜、不默认）', () => {
    assert.throws(() => buildLaunchScript({ ...BASE, platform: /** @type {any} */ ('freebsd') }), userError);
    assert.throws(() => buildLaunchScript({ ...BASE, platform: /** @type {any} */ (undefined) }), userError);
  });
});

// ═══════════════════════ 端到端形状 ═══════════════════════

describe('产物的整体形状（改坏了这里会先红）', () => {
  test('★ cmd 全文逐字', () => {
    assert.equal(buildLaunchCmd(BASE), [
      '@echo off',
      'REM cxt fallback launcher - generated file, safe to delete',
      'REM Prefer "cxt run <token>". This exists for terminals that only take a command string.',
      '"C:\\Program Files\\nodejs\\node.exe" "D:\\tools\\cxt\\bin\\cxt.js" exec "relay-a" %*',
      '',
    ].join('\r\n'));
  });

  test('★ sh 全文逐字', () => {
    assert.equal(buildLaunchSh({ ...BASE, platform: 'linux' }), [
      '#!/bin/sh',
      '# cxt fallback launcher - generated file, safe to delete',
      '# Prefer "cxt run <token>". This exists for terminals that only take a command string.',
      "'C:/Program Files/nodejs/node.exe' 'D:/tools/cxt/bin/cxt.js' exec 'relay-a' \"$@\"",
      '',
    ].join('\n'));
  });

  test('★ 脚本的 argv 与「直接拉起」路径逐字一致（脚本只是序列化）', () => {
    // §2.12：脚本是首选路径的**忠实序列化**。直接拉起的 argv 是
    // [nodePath, cxtPath, 'exec', ...execArgs]，脚本里去掉引号后应当能还原出同一个序列。
    //
    // ⚠️ 这条断言在"按语义字段拼 argv"的旧版下是**真在防分叉**的；
    //    改成收 `execArgs` 之后它变成了同义反复——因为源头已经只有一个。
    //    留着它是因为它现在守的是**引号规则**：只要还原不出来，
    //    就说明某个参数被引号切错了（比如路径里的空格没被保护住）。
    const execArgs = ['relay-a', '--model', 'deepseek-chat', '-c', '--', '--no-alt-screen'];
    const cmd = lines(buildLaunchCmd({ ...BASE, execArgs })).at(-1) ?? '';
    // 剥掉引号与 %*，按空格切——路径里的空格已被引号保护，所以能还原
    const argv = (cmd.match(/"[^"]*"|[^\s"]+/g) ?? []).slice(0, -1)
      .map((t) => (t.startsWith('"') ? t.slice(1, -1) : t));
    assert.deepEqual(argv, [BASE.nodePath, BASE.cxtPath, 'exec', ...execArgs]);
  });
});
