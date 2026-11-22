// 本机实测"终端拉起"（§4.4 第 8 步的验收动作 / §6.3 唯一的平台风险敞口）。
//
// 单元测试能验"决策"（tests/terminal.test.js 注入 deps 跑三平台规则），
// 但验不了**终端到底吃不吃我们这套 argv**——那只能在真机上跑一次。
// 这就是那个"跑一次"：它开**真的**终端标签页，让里面的 `cmt exec`
// 拉起一个**假的 claude**（一个 .cmd），假 claude 把环境变量与参数倒进文件，
// 脚本再把文件读出来断言。
//
// 于是下面这些"只能在真机上验"的东西就都有了证据：
//   1. wt.exe 接受 `-w cmt new-tab --title <t> --suppressApplicationTitle -d <cwd> <argv...>`
//      这个形状
//   2. ★ **两次启动的标签页落在同一个窗口里**（§7.7）。这条以前没人验过——
//      旧脚本的断言全是标签页**内容**（env / argv），而"落在哪个窗口"从内容里
//      根本看不出来。于是 `-w 0`（最近使用过的窗口）那个 bug 一路绿灯，
//      直到用户报"每次都是新窗口"才暴露。**缺的断言恰好就是坏掉的那条不变量。**
//   3. cwd 真的落到了目标目录（`cmt exec` 在窗口内解析出的 cwd 来源是 `cwd`）
//   4. 环境变量真的注进去了（CLAUDE_CONFIG_DIR / ANTHROPIC_* 在**新窗口的进程里**）
//   5. `.cmd` 经 `cmd.exe /c` 调用可行（§2.9 二·1 的 CVE-2024-27980 规避）
//   6. 路径含空格 / 非 ASCII 时参数传递不被撕开
//   7. ★ **标签页不继承调用方的 Claude 会话标记**（§2.6）。夹具故意往 `cmt run` 的环境里
//      塞了整套标记，模拟"从 Claude Code 会话里跑 cmt run"——那正是用户报的
//      "⚠ Transcript saving is off" 的现场（§7.7 实测：WT 会把调用方环境原样转发给新标签页）
//
// 用法：node scripts/live-terminal-check.mjs [--keep]
// 需要人在电脑前——会弹终端标签页（跑完自动关）。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SESSION_MARKER_ENV } from '../src/core/resolve.js';
import { findExecutable } from '../src/platform/find-executable.js';

const BIN = fileURLToPath(new URL('../bin/cmt.js', import.meta.url));
const KEEP = process.argv.includes('--keep');
const WAIT_MS = 20_000;

// ⚠️ 夹具目录名**故意**带空格与中文，好让第 6 条真的被测到。
// 别退回 `mkdtempSync(join(tmpdir(), 'cmt-live-'))`——Windows 的 tmpdir() 给的是
// **8.3 短名**（`C:\Users\ALICE~1\...`），既没空格也没中文，
// 那样"路径带空格也不撕参数"这条断言就是个空炮（实测踩过：第一版就是这么假过的）。
const ROOT = mkdtempSync(join(tmpdir(), 'cmt live 实测 '));
const HOME = join(ROOT, 'home');
const APP = join(HOME, '.claude-multi-token');
const WORK = join(ROOT, 'work', 'client-a');
const DUMP = join(ROOT, 'dump.json');
const RELEASE = join(ROOT, 'release');
const FAKE_CLAUDE = join(ROOT, 'fake-claude.cmd');
const DUMPER = join(ROOT, 'dumper.mjs');
const PS_PATH = join(ROOT, 'list-wt-windows.ps1');

mkdirSync(join(APP, 'tokens'), { recursive: true });
mkdirSync(WORK, { recursive: true });

const w = (p, s) => writeFileSync(p, s, 'utf8');
const wj = (p, o) => w(p, `${JSON.stringify(o, null, 2)}\n`);

// 假 claude 的"内脏"：把环境变量与参数写成 **UTF-8 的 JSON**。
// ⚠️ 别改用 cmd 的 `set > file`——它按 **OEM 代码页**（中文 Windows 上是 GBK）落盘，
// 而 Node 读 UTF-8，路径里的中文会变成 `ʵ��` 这种乱码，
// 于是"CLAUDE_CONFIG_DIR 对不对"这条断言会**假失败**（实测踩过）。
// 我们要测的是 cmt 传参传环境，不是 cmd 的文件编码。
//
// ⚠️ 写完**不能马上退出**：标签页里的进程一退出，标签页就关；那个窗口若只剩这一个
// 标签页，窗口也跟着关——于是第 2 条断言（"第二次启动复用同一个窗口"）就无从测起，
// 第二次必然"新开"一个窗口，**假失败**。所以这里等脚本放行：
// 两次启动的标签页在测量期间**同时活着**，窗口的归属才有意义。
// 放行文件由脚本在全部测量做完之后写；60s 超时兜底，免得脚本崩了留下僵尸标签页。
w(
  DUMPER,
  `import { existsSync, writeFileSync } from 'node:fs';\n` +
    `writeFileSync(\n` +
    `  process.env.CMT_LIVE_DUMP,\n` +
    `  JSON.stringify({ env: process.env, argv: process.argv.slice(2) }, null, 2),\n` +
    `  'utf8',\n` +
    `);\n` +
    `const buf = new Int32Array(new SharedArrayBuffer(4));\n` +
    `const deadline = Date.now() + 60_000;\n` +
    `while (!existsSync(process.env.CMT_LIVE_RELEASE) && Date.now() < deadline) {\n` +
    `  Atomics.wait(buf, 0, 0, 200);\n` +
    `}\n`,
);

// 假 claude：一个 .cmd，经 `cmd.exe /c` 调用（§2.9 二·1 的 CVE-2024-27980 规避）。
// 它**能跑起来**本身就是断言——说明 cmd.exe 认得出这个带空格与中文的路径。
//
// ⚠️⚠️ 这个 .cmd **必须全 ASCII**，所以两个路径都从环境变量取，绝不写进文件。
// 这不是洁癖，是实测：cmd.exe 按 **OEM 代码页**（中文 Windows = GBK）解码 .cmd 的字节，
// 而我们的生成器写的是 UTF-8——把中文路径硬编码进去，`E5 AE 9E`（"实"）会被当成
// 两个 GBK 字符，路径直接找不着，假 claude 静默不产出任何东西（实测踩过）。
// 环境变量走的是 UTF-16，没有这个问题。
//
// 这条正好是 §2.10"`.cmd` 整个文件都是纯 ASCII——注释也不例外"的现场证据，
// 而且说明**范围比注释更宽**：任何非 ASCII 路径只要被写进 .cmd 就会坏。
// 真实流程里 `launch.cmd` 会写进 cmt 自己的安装路径，所以仓库放在中文目录下
// 时它必坏——这正是"直接拉起优先、launch 脚本只是兜底"（§2.10）的理由，
// 也是 `cmt doctor` 必须报警的项（§2.10 编码规则末句）。
w(
  FAKE_CLAUDE,
  ['@echo off', '"%CMT_LIVE_NODE%" "%CMT_LIVE_DUMPER%" %*', 'exit /b 0', ''].join('\r\n'),
);

// ── 窗口计数器（§7.7）──────────────────────────────────────────────
//
// ⚠️ 为什么不是一句 `Get-Process WindowsTerminal | Where MainWindowHandle -ne 0`：
// WT 1.24 把**所有**窗口放在同一个 WindowsTerminal.exe 进程里，而 `MainWindowHandle`
// 是**按进程**给的，所以那个数恒等于 1——窗口开到天上去也看不出来。本项目就因为这个
// 错误读数白跑过一轮"用户报的 bug 不复现"（§7.7 记了这件事）。必须 EnumWindows。
//
// 文件写成 UTF-8 **带 BOM**：PowerShell 5.1 没有 BOM 时按 ANSI 读 .ps1，
// 里面一旦有中文就会被拆成乱码、甚至解析失败（实测踩过，见 §2.10）。
// 这里的内容本身是纯 ASCII，BOM 是为了让后来加注释的人不必再踩一次。
w(
  PS_PATH,
  '\uFEFF' +
    `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class CmtWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);

  delegate bool EnumProc(IntPtr h, IntPtr p);

  // 枚举某个进程的顶层窗口：可见、且没有 owner（GW_OWNER = 4）。
  // 后一条用来滤掉 WT 自己的弹窗与隐藏辅助窗口——它们不是"窗口"。
  public static List<string> Go(uint target) {
    var res = new List<string>();
    EnumWindows((h, p) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid == target && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) {
        var sb = new StringBuilder(512);
        GetWindowText(h, sb, 512);
        res.Add(h.ToInt64() + "|" + sb.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

foreach ($p in @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue)) {
  [CmtWin]::Go([uint32]$p.Id)
}
`,
);

wj(join(APP, 'config.json'), {
  version: 1,
  defaults: {
    authToken: 'sk-live-check-1234567890',
    authMode: 'token',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: [{ id: 'live-check-model' }],
    // 逃生舱顺带验一下：这几个变量就是这么传进新窗口的。
    // 两个路径必须走环境变量，不能写进 .cmd（见下面 fake-claude 的注释）。
    env: {
      CMT_LIVE_DUMP: DUMP,
      CMT_LIVE_RELEASE: RELEASE,
      CMT_LIVE_DUMPER: DUMPER,
      CMT_LIVE_NODE: process.execPath,
    },
    claudeBin: FAKE_CLAUDE,
    terminalMode: 'tab',
  },
  bindings: [{ path: WORK, token: 'relay-live' }],
});

wj(join(APP, 'tokens', 'relay-live.json'), {
  name: 'relay-live',
  authToken: 'sk-live-check-1234567890',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: [{ id: 'live-check-model' }],
});

console.log(`夹具就绪 ${ROOT}`);
console.log('开终端标签页，跑完会自动关……');

// 本机有没有 Windows Terminal —— 决定窗口身份那两条断言跑不跑得了。
// 没有 wt 时 `cmt run` 走 cmd 兜底（每次一个新窗口），"标签页落在哪个窗口"无从谈起。
const hasWt = findExecutable('wt', { platform: process.platform, env: process.env }) !== null;

/** @type {{hwnd: string, title: string}[] | null} */
const before = hasWt ? listWtWindows() : null;

launch('一');
const dump1 = waitDump();
/** @type {{hwnd: string, title: string}[] | null} */
const mid = hasWt ? listWtWindows() : null;

// 第二次之前必须把 dump 删掉——否则 waitFor 立刻拿到上一次的结果，等于没等
rmSync(DUMP, { force: true });

launch('二');
waitDump();
/** @type {{hwnd: string, title: string}[] | null} */
const after = hasWt ? listWtWindows() : null;

// 放行：两个标签页里的假 claude 一起退出，标签页与窗口随之关闭。
// 放行要赶在清理夹具之前，不然它们还占着 WORK 这个 cwd（Windows 会锁住进程的当前目录）。
w(RELEASE, '');

// ── 窗口身份：用**集合差**判，不看总数 ──────────────────────────────
// 增量而非绝对值：用户本来就开着的窗口、自己中途关掉的窗口都不该干扰结论。
const newInMid = diff(mid, before);
const newInAfter = diff(after, mid);

// 数不出窗口 = 这条断言**没跑**。绝不能当成通过——那正是当初 `-w 0` 蒙混过关的方式。
if (hasWt && (before === null || mid === null || after === null)) {
  fail('数不出 Windows Terminal 的窗口数（PowerShell 那条路走不通）——窗口身份断言没跑成，别当成通过');
}

// ── 断言 ──────────────────────────────────────────────────────────
const { env, argv } = JSON.parse(readFileSync(dump1, 'utf8'));
/** @type {[string, boolean | null][]} */
const checks = [
  // 自检：夹具路径真的带空格与中文吗？不带的话下面那条断言就是空炮
  ['夹具路径确实含空格与中文（否则下一条是假过）', / /.test(ROOT) && /[^\x00-\x7F]/.test(ROOT)],

  // ★ 本次修复的核心（§7.7）。`null` = 本机没有 wt，标签页不适用 → 跳过而不是假过。
  ['第二次启动没有新开窗口（标签页落进了已有窗口）', hasWt ? newInAfter.length === 0 : null],
  ['第一次启动最多只多开一个窗口（= 新建 cmt 窗口）', hasWt ? newInMid.length <= 1 : null],

  ['标签页里跑的是 cmt exec 注入的那份环境', env.CLAUDE_CONFIG_DIR === join(APP, 'profiles', 'relay-live')],
  ['凭证注入了（新窗口的进程里）', env.ANTHROPIC_AUTH_TOKEN === 'sk-live-check-1234567890'],
  ['端点注入了', env.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic'],
  ['主模型注入了', env.ANTHROPIC_MODEL === 'live-check-model'],
  ['别名槽按 models[0] 自动填了', env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'live-check-model'],
  ['逃生舱 env 注入了', env.CMT_LIVE_DUMP === DUMP],
  ['PATH 之类的没被顶掉（只加不减）', Boolean(env.PATH || env.Path)],
  // ★ 用户报的那个 bug 的现场（§2.6）：夹具塞了整套标记，标签页里必须一个都找不到。
  // 判据是"一个都没有"而不是"CHILD_SESSION 没有"——标记是一整套身份，
  // 漏掉哪一条都意味着新会话顶着父会话的某个身份在跑。
  ['★ 会话标记一个都没漏进标签页（§2.6 净化）', SESSION_MARKER_ENV.every((k) => !(k in env))],
  ['claude 侧参数带上了会话名', argv.includes('--name') && argv.includes('cmt:relay-live')],
  ['空格 / 中文路径没把参数撕开（参数就该只有这一对）', argv.length === 2],
];

console.log('\n窗口实况（§7.7）');
console.log(`  第 1 次启动前  ${count(before)}`);
console.log(`  第 1 次启动后  ${count(mid)}${describe(newInMid)}`);
console.log(`  第 2 次启动后  ${count(after)}${describe(newInAfter)}`);

console.log('\n新标签页里的实况');
console.log(`  CLAUDE_CONFIG_DIR = ${env.CLAUDE_CONFIG_DIR ?? '（无）'}`);
console.log(`  ANTHROPIC_MODEL   = ${env.ANTHROPIC_MODEL ?? '（无）'}`);
// 夹具在 `cmt run` 那一侧塞了这个值；标签页里该是"（无）"——用户报的就是它漏进来的样子
console.log(`  CLAUDE_CODE_CHILD_SESSION = ${env.CLAUDE_CODE_CHILD_SESSION ?? '（无）'}`);
console.log(`  claude 侧参数     = ${argv.join(' ')}`);

console.log('');
let bad = 0;
let skipped = 0;
for (const [what, ok] of checks) {
  console.log(`  ${ok === null ? '⊘' : ok ? '✓' : '✗'} ${what}`);
  if (ok === false) bad += 1;
  if (ok === null) skipped += 1;
}

// 等假 claude 自己退干净再删夹具，否则 WORK 还被那两个标签页锁着（EPERM）
sleep(1_500);
if (!KEEP) {
  // 关窗是要花点时间的；Windows 会锁住"某个进程的当前目录"，
  // 于是 rmSync 报 EPERM。这不是测试失败，是还没关完；留着让系统自己回收。
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {
    console.log(`\n（夹具没删掉——标签页还开在这个目录里，关掉它即可：${ROOT}）`);
  }
} else console.log(`\n（--keep：夹具留在 ${ROOT}）`);

if (bad > 0) fail(`${bad} 项没通过——终端拉起这条链在本机是坏的`);
if (skipped > 0) {
  console.log(`\n⚠ 终端拉起实测通过，但有 ${skipped} 项**跳过没验**（本机没有 wt.exe）`);
} else {
  console.log('\n✓ 终端拉起实测通过');
}

// ─────────────────────────────────────────────────────────────────

/**
 * 跑一次 `cmt run`，把它的输出原样转出来。
 *
 * ⚠️ 环境里**故意**塞了整套 Claude 会话标记（§2.6）：模拟"从 Claude Code 会话里跑
 * `cmt run`"。**必须是夹具自己塞**，不能指望"脚本恰好从 Claude Code 里启动"——
 * 那样换个地方跑（CI、普通终端）这条断言就成了空炮，还照样报"通过"。
 *
 * @param {string} nth
 */
function launch(nth) {
  console.log(`\n第 ${nth} 次 cmt run ……`);
  const r = spawnSync(process.execPath, [BIN, 'run', '--cwd', WORK], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME,
      USERPROFILE: HOME,
      // 假装自己是 Claude Code 会话：9 个标记一个不少
      ...Object.fromEntries(SESSION_MARKER_ENV.map((k) => [k, 'live-check-父会话'])),
    },
    timeout: 30_000,
  });
  process.stdout.write(r.stdout ?? '');
  if (r.stderr) process.stderr.write(r.stderr);
  return r;
}

/** @returns {string} */
function waitDump() {
  if (!waitFor(DUMP)) {
    fail(`等了 ${WAIT_MS / 1000}s，新窗口里的假 claude 没写出可解析的 ${DUMP}`);
  }
  return DUMP;
}

/**
 * 数本机**真正的** Windows Terminal 窗口。
 *
 * 返回 `null` 表示**数不出来**（PowerShell 没跑成 / 输出形状不认识）——
 * 与"零个窗口"（`[]`）是两码事，调用方必须区别对待：前者是断言没跑，后者是事实。
 *
 * @returns {{hwnd: string, title: string}[] | null}
 */
function listWtWindows() {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS_PATH],
    { encoding: 'utf8', timeout: 60_000 },
  );
  if (r.error || r.status !== 0) {
    if (r.stderr) process.stderr.write(`  （窗口计数失败）${r.stderr}\n`);
    return null;
  }
  /** @type {{hwnd: string, title: string}[]} */
  const out = [];
  for (const line of (r.stdout ?? '').split(/\r?\n/)) {
    const s = line.trim();
    if (s === '') continue;
    const i = s.indexOf('|');
    if (i < 0) {
      // 输出形状不认识 → 别猜。猜出来的数字正是当初"问题不复现"的来源。
      process.stderr.write(`  （窗口计数输出不认识）${s}\n`);
      return null;
    }
    out.push({ hwnd: s.slice(0, i), title: s.slice(i + 1) });
  }
  return out;
}

/**
 * `after` 里有而 `before` 里没有的窗口（按 hwnd 比）。
 * @param {{hwnd: string}[] | null} after
 * @param {{hwnd: string}[] | null} before
 * @returns {{hwnd: string, title: string}[]}
 */
function diff(after, before) {
  if (after === null || before === null) return [];
  const seen = new Set(before.map((x) => x.hwnd));
  return after.filter((x) => !seen.has(x.hwnd));
}

/** @param {{hwnd: string, title: string}[] | null} list */
function count(list) {
  if (!hasWt) return '（本机没有 wt.exe，不适用）';
  return list === null ? '数不出来' : `${list.length} 个窗口`;
}

/** @param {{hwnd: string, title: string}[]} added */
function describe(added) {
  if (!hasWt || added.length === 0) return '   ← 无新增';
  return `   ← 新增 ${added.map((x) => `「${x.title || '(无标题)'}」`).join(' ')}`;
}

/** @param {string} p */
function waitFor(p) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(p)) {
      // 写完才算数：JSON 是一段段落的，读到半截会 JSON.parse 失败
      try {
        JSON.parse(readFileSync(p, 'utf8'));
        return true;
      } catch {
        /* 还没写完，接着等 */
      }
    }
    sleep(250);
  }
  return false;
}

/** @param {number} ms */
function sleep(ms) {
  // 同步睡：这个脚本是给人看的一次性检查，不值得为它上 async
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @param {string} msg */
function fail(msg) {
  // 放行 + 稍等：别把还开着的标签页留在那儿（它们 60s 后也会自己走，但别让人等）
  try {
    w(RELEASE, '');
  } catch {
    /* 夹具可能已经没了 */
  }
  sleep(1_500);
  if (!KEEP && existsSync(ROOT)) {
    // 标签页可能还没关完，WORK 被锁着 → EPERM。删不掉不是失败，别让它盖掉真正的错因。
    try {
      rmSync(ROOT, { recursive: true, force: true });
    } catch {
      /* 留给系统回收 */
    }
  }
  process.stderr.write(`\n✗ ${msg}\n`);
  process.exit(1);
}
