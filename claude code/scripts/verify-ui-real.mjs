// @ts-check
/**
 * ★ 真机验收：全屏 TUI 依赖的**七条 Windows 事实**（§7.8）。M1–M7。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么必须真跑，不能推断
 *
 * §2.12 的整套设计压在七条平台事实上（TTY 异步写、`writeSync` 的代码页、
 * `columns` 是缓冲宽度、raw mode 下的 Ctrl+C、`TerminateProcess`、
 * IME 光标锚点、CPR 有没有应答）。**这七条都是"文档没写、只能实测"的东西**，
 * 而其中任何一条不成立，对应的那部分设计就要重做。
 *
 * ## 手法：让证据落盘，不靠"我看见面板弹出来了"
 *
 * 与 `live-terminal-check.mjs` 一致——**每个探针都把原始字节/原始计数写进
 * `ui-real-report.json`**，断言读文件，不读人的印象。人的印象只在
 * 真的没法自动化的地方用（M5/M6/M7 要人去按键盘、拖窗口、强杀进程），
 * 那时脚本**问**、把答案记进同一份报告——它不猜。
 *
 * ⚠️ 全程不碰任何 token、不读 `~/.claude-multi-token`，只在 `tmpdir()` 里折腾。
 *
 * 用法：
 *   node scripts/verify-ui-real.mjs            # 自动的跑，交互的跳过
 *   node scripts/verify-ui-real.mjs --all      # 在**真终端**里跑，含交互探针
 * ─────────────────────────────────────────────────────────────
 */
import { spawn, spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 as win32Path } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

const ROOT = process.cwd();
const OUT = win32Path.join(ROOT, 'ui-real-report.json');
const SANDBOX = nodeFs.mkdtempSync(win32Path.join(tmpdir(), 'cmt-ui-real-'));
const ALL = process.argv.includes('--all');

const onTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;

/** @type {{id: string, title: string, verdict: string, detail: any}[]} */
const results = [];

/**
 * @param {string} id
 * @param {string} title
 * @param {string} verdict PASS / FAIL / SKIP / MANUAL
 * @param {any} detail
 */
function record(id, title, verdict, detail) {
  results.push({ id, title, verdict, detail });
  const mark = { PASS: '  ok  ', FAIL: ' FAIL ', SKIP: ' skip ', MANUAL: '  ?   ' }[verdict] ?? '  ??  ';
  console.log(`[${mark}] ${id}  ${title}`);
  if (verdict !== 'PASS' && detail?.note) console.log(`         ${detail.note}`);
}

/** 跑一个子 node，返回它的 stdout（**字符串**，按 UTF-8 解）。 */
function runChild(script, args = []) {
  const file = win32Path.join(SANDBOX, `child-${Math.abs(hash(script))}.mjs`);
  nodeFs.writeFileSync(file, script, 'utf8');
  const r = spawnSync(process.execPath, [file, ...args], { encoding: 'buffer', timeout: 20000 });
  return {
    raw: r.stdout ?? Buffer.alloc(0),
    stderr: String(r.stderr ?? ''),
    status: r.status,
  };
}

/** @param {string} s */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// ═══════════════════════ M1 ═══════════════════════

/**
 * M1：两条写路径。`fs.writeSync(1, …)` 在 CP936 控制台上会乱码，`stdout.write` 不会。
 *
 * ★ 自动的那一半只能证明"**在非 TTY 上两条路径字节相同**"——也就是
 * "差异只可能来自控制台那一层"。控制台上的那一眼**必须人看**：
 * 脚本会把命令打出来，人去 cmd 里跑。
 */
async function m1() {
  const CHILD = `
import fs from 'node:fs';
const s = '中文测试';
process.stdout.write('A|stdout.write|' + s + '\\n');
fs.writeSync(1, 'B|writeSync   |' + s + '\\n');
`;
  const r = runChild(CHILD);
  const auto = {
    childExit: r.status,
    bytesAreUtf8: r.raw.includes(Buffer.from('中文测试', 'utf8')),
    text: r.raw.toString('utf8'),
    note: '非 TTY 上两条路径**字节相同**（都是 UTF-8）⇒ 差异只可能来自控制台那一层',
  };

  if (!onTTY) {
    record('M1', '两条写路径（stdout.write vs fs.writeSync）', 'MANUAL', {
      auto,
      manual: {
        how: '在**真终端**里重跑本脚本（`node scripts/verify-ui-real.mjs`）——它会自己把两行写出来问你',
        fallbackCmd: `node -e "process.stdout.write('A|'+'中文测试'+String.fromCharCode(10));require('fs').writeSync(1,'B|'+'中文测试'+String.fromCharCode(10))"`,
        expect: 'A 行正常显示「中文测试」；B 行是乱码（CP936 把裸 UTF-8 当 GBK 解）',
        ifBIsAlsoFine: '⇒ §7.8② 不成立，出屏可以只用一条写路径，简化 term.js',
        ifABothGarbled: '⇒ 连 stdout.write 都乱码，整条渲染路径要重做（改用 WriteConsoleW）',
      },
    });
    return;
  }

  // ★ 自动做不了的那一半：**控制台上那一眼**。脚本自己写两行，人来判——
  //   比让人手敲一条 `node -e` 靠谱（cmd 的引号转义 + CP936 会一起咬人）。
  process.stdout.write('\r\n  ↓ 下面两行，哪一行是乱码？\r\n');
  process.stdout.write('    A|stdout.write|中文测试\r\n');
  nodeFs.writeSync(1, '    B|writeSync   |中文测试\r\n');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let ans = '';
  try {
    ans = (await rl.question('    (A乱 / B乱 / 都不乱 / 都乱) ')).trim();
  } finally {
    rl.close();
  }

  const flat = ans.replace(/\s/g, '');
  const neitherBad = flat.includes('不乱');
  const bothBad = !neitherBad && (flat.includes('都乱') || (flat.includes('A') && flat.includes('B')));
  const onlyBBad = !neitherBad && !bothBad && flat.includes('B');
  record('M1', '两条写路径（stdout.write vs fs.writeSync）', bothBad ? 'FAIL' : onlyBBad ? 'PASS' : 'MANUAL', {
    auto,
    answer: ans,
    note: bothBad
      ? '★★ 两条都乱码 ⇒ 整条渲染路径要重做（得直接调 `WriteConsoleW`），`stdout.write` 也救不了'
      : onlyBBad
        ? '★ §7.8② 成立：`writeSync` 乱码、`stdout.write` 正常 ⇒ 两条路径不可互换'
        : '⚠️ B 行也正常 ⇒ §7.8② 不成立，出屏可以只用一条写路径（term.js 可简化）',
  });
}

// ═══════════════════════ M2 ═══════════════════════

/**
 * M2：`'exit'` 处理器里 `stdout.write` 会丢，`fs.writeSync` 不会。
 *
 * ★★ 这条是 `RESTORE` 必须走 `writeSync` 的**全部理由**（§7.8①）。
 * 不成立的话 `term.js` 的两条写路径可以合成一条。
 *
 * 小载荷与大载荷都测：小载荷有可能**碰巧**在 `'exit'` 前就落到内核缓冲里，
 * 只有大载荷才稳定暴露"没 flush"。
 */
async function m2() {
  /** @param {number} n */
  const child = (n) => `
import fs from 'node:fs';
const big = 'x'.repeat(${n});
process.stdout.write('BEFORE\\n');
process.on('exit', () => {
  process.stdout.write('EXIT-ASYNC-' + big + '-ASYNC-END\\n');
  try { fs.writeSync(1, 'EXIT-SYNC-END\\n'); } catch {}
});
`;
  /**
   * ★★ 判据必须是**载荷的尾巴**，不能是开头。
   *   开头那几十字节进得了管道缓冲，"收到了开头"证明不了"整段都送出去了"——
   *   第一版就是这么写的，于是不管丢没丢都"通过"，等于没测。
   *
   * @param {number} n
   */
  const probe = (n) => {
    const r = runChild(child(n));
    const text = r.raw.toString('utf8');
    return {
      payloadBytes: n,
      receivedBytes: r.raw.length,
      asyncStarted: text.includes('EXIT-ASYNC-'),
      asyncComplete: text.includes('-ASYNC-END'),
      syncArrived: text.includes('EXIT-SYNC-END'),
      status: r.status,
    };
  };
  const small = probe(0);
  const big = probe(200000);

  const syncOk = small.syncArrived && big.syncArrived;
  const asyncLost = !small.asyncComplete || !big.asyncComplete;
  // ★★ 管道这一路**结构上就不可能**证伪这条断言，所以没丢**不是 PASS**。
  //   Node 自己的 IO 表：文件 Windows/POSIX 同步、**管道与套接字 Windows 也是同步**、
  //   只有 **TTY 在 Windows 上是异步**。§7.8① 是"Windows **TTY**"的事实，
  //   拿管道去测，测的是一个同步 fd——两回事。
  //   把它记成 PASS 会让报告读起来像"验过了"，那正是这份脚本要避免的。
  const verdict = !syncOk ? 'FAIL' : asyncLost ? 'PASS' : 'MANUAL';
  record('M2', "`'exit'` 里的 `stdout.write` 会丢、`fs.writeSync` 不会", verdict, {
    small,
    big,
    stdoutKind: 'pipe（**同步** fd，见下）',
    note: !syncOk
      ? '★★ `writeSync` 都没到——那条兜底路径不成立，term.js 的退出保证要重做'
      : asyncLost
        ? '★ 复现了：异步写丢了尾巴、同步写到了 ⇒ §7.8① 成立，两条路径不可合并'
        : '⚠️ 管道上没丢，但**管道在 Windows 上是同步写**——这条探针结构上就证伪不了 §7.8①。'
          + '真正的判据只能是人看：加 --all 跑，脚本会开一个真控制台窗口做 M2-TTY',
    manual: asyncLost ? null : '`node scripts/verify-ui-real.mjs --all` → 看新开那个窗口按回车后回不回主屏',
  });
}

/**
 * M2-TTY：**只在真控制台上才能做的那一半**。
 *
 * 管道上异步写不会丢（Windows 上管道是同步 fd），所以必须让一个子进程
 * 拿到**真控制台**。而父进程一旦捕获它的 stdout 就又变成管道了——
 * 于是这里不捕获，改用**人的眼睛**：子进程进备用屏，在 `'exit'` 里
 * 用 `stdout.write` 发 `?1049l`，然后看那个窗口回没回主屏。
 *
 * ★ 这不是"模拟"：它就是 `term.js` 出屏那一行的机制本身。
 */
async function m2TTY(rl) {
  const child = win32Path.join(SANDBOX, 'exit-write.mjs');
  nodeFs.writeFileSync(child, `
process.stdout.write('\\u001b[?1049h\\u001b[2J\\u001b[H\\u001b[?25l');
process.stdout.write('  这一屏是**备用屏**。\\r\\n');
process.stdout.write('  按回车退出——退出时用 stdout.write 发 ?1049l。\\r\\n');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.once('data', () => process.exit(0));
process.on('exit', () => {
  // ★ 这就是被测的那一行：'exit' 里的**异步**写。
  //   送到了 → 回到主屏（§7.8① 成立，两条路径不可合并）；
  //   丢了 → 这个窗口卡在备用屏上，光标也不见了。
  process.stdout.write('\\u001b[?25h\\u001b[?1049l');
});
`, 'utf8');

  const title = 'cmt-m2-probe';
  spawn('cmd.exe', ['/c', 'start', `"${title}"`, process.execPath, child], { detached: true, stdio: 'ignore' }).unref();
  const ans = (await rl.question('\r\n  【M2-TTY】新开那个窗口按回车之后，它回到主屏了吗？(回到主屏/卡在备用屏/没看清) ')).trim();
  const stuck = ans.includes('卡') || ans.includes('备用屏');
  record('M2-TTY', "真控制台上 `'exit'` 里的 `stdout.write` 送得到吗", 'MANUAL', {
    answer: ans,
    note: stuck
      ? '★ 卡住了 ⇒ §7.8① 成立：出屏**必须**走 `fs.writeSync`，两条路径不可合并'
      : '⚠️ 回到了主屏 ⇒ 这条控制台上异步写没丢。`writeSync` 仍无代价（`RESTORE` 是纯 ASCII），'
        + '但 §7.8① 的措辞要从"会丢"改成"可能丢"',
  });
}

// ═══════════════════════ M3 / M4 ═══════════════════════

/**
 * M3 + M4：CPR（`ESC [ 6n`）有没有应答，以及 `─` 实测占几列。
 *
 * 两个探针共用一个会话：先量一个 ASCII 字符做**对照组**（必然是 1 列），
 * 再量 `─`（U+2500，UAX #11 的 Ambiguous）。差值就是终端实际给的列宽。
 *
 * ⚠️ M3 只决定"将来要不要提供 unicode 字形可选项"，**不阻塞开工**——
 * 因为 §2.12 五 已经选了 ASCII 结构字符，无论量出来是 1 还是 2 都不会烂屏。
 */
async function m34() {
  if (!onTTY) {
    record('M3/M4', 'CPR 应答与 `─` 实测列宽', 'SKIP', {
      note: '需要在真终端里跑：node scripts/verify-ui-real.mjs --all',
    });
    return;
  }
  const stdin = process.stdin;
  const stdout = process.stdout;
  const wasRaw = stdin.isRaw === true;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  /** @type {string} */
  let buf = '';
  /** @type {((v: string | null) => void) | null} */
  let waiter = null;
  const onData = (/** @type {string} */ c) => {
    buf += c;
    if (waiter && /\u001b\[\d+;\d+R/.test(buf)) { const w = waiter; waiter = null; w(buf); }
  };
  stdin.on('data', onData);

  /** @param {number} ms */
  const cpr = (ms = 400) => new Promise((/** @type {(v: string | null) => void} */ res) => {
    buf = '';
    waiter = res;
    stdout.write('\u001b[6n');
    setTimeout(() => { if (waiter) { const w = waiter; waiter = null; w(null); } }, ms);
  });
  /** @param {string | null} s */
  const col = (s) => {
    const m = s === null ? null : /\u001b\[(\d+);(\d+)R/.exec(s);
    return m === null ? null : { row: Number(m[1]), col: Number(m[2]) };
  };

  const before = col(await cpr());
  if (before === null) {
    record('M4', 'CPR（`ESC [ 6n`）有没有应答', 'FAIL', {
      note: '★ 没有应答 ⇒ 一切靠 CPR 的探针作废，只能目测；面板本身不依赖 CPR，不受影响',
    });
    record('M3', '`─` 实测列宽', 'SKIP', { note: 'M4 没应答，量不了' });
  } else {
    record('M4', 'CPR（`ESC [ 6n`）有没有应答', 'PASS', { firstAnswer: before });
    /** @param {string} ch */
    const width = async (ch) => {
      const a = col(await cpr());
      stdout.write(ch);
      const b = col(await cpr());
      return a && b ? b.col - a.col : null;
    };
    const wAscii = await width('A');
    const wBox = await width('─');
    const wArrow = await width('↑');
    record('M3', '`─` / `↑` 实测列宽（Ambiguous）', 'PASS', {
      asciiA: wAscii,
      boxDrawing: wBox,
      arrow: wArrow,
      note: `对照 A=${wAscii} 列；§2.12 五 已按"永远不低估"保守处理，量出来是几都不烂屏`,
    });
  }

  stdout.write('\u001b[2K\r\n');
  stdin.removeListener('data', onData);
  if (!wasRaw) stdin.setRawMode(false);
  stdin.pause();
}

// ═══════════════════════ M5 ═══════════════════════

/**
 * M5：raw mode 下方向键到达的是 `ESC [ A` 这种序列，不是扫描码。
 *
 * ★ 不成立的话整个 `keys.js` 的解码方案作废（§2.12 三）。
 */
async function m5(rl) {
  if (!onTTY) {
    record('M5', 'raw mode 下方向键的字节形态', 'SKIP', { note: '需要真终端 + 人按键盘' });
    return;
  }
  const stdin = process.stdin;
  const stdout = process.stdout;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  stdout.write('\r\n  请依次按：↑  ↓  ←  →  Enter 然后 q（q 结束采集）\r\n');

  /** @type {string[]} */
  const got = [];
  await new Promise((/** @type {() => void} */ done) => {
    /** @param {string} c */
    const onData = (c) => {
      got.push(c);
      if (c.includes('q')) { stdin.removeListener('data', onData); done(); }
    };
    stdin.on('data', onData);
  });
  const bytes = got.join('');
  stdin.setRawMode(false);
  stdin.pause();
  stdout.write('\r\n');

  const want = ['\u001b[A', '\u001b[B', '\u001b[D', '\u001b[C'];
  const missing = want.filter((w) => !bytes.includes(w));
  record('M5', 'raw mode 下方向键 = `ESC [ A/B/C/D`', missing.length === 0 ? 'PASS' : 'FAIL', {
    seen: JSON.stringify(bytes),
    missing,
    note: missing.length === 0
      ? '★ 解码器方案成立'
      : '★★ 方向键不是 CSI 序列 ⇒ keys.js 的整个假设作废，要按实际形态重做',
  });
  void rl;
}

// ═══════════════════════ M6 ═══════════════════════

/**
 * M6：`stdout.on('resize')` 在 WT 里可靠吗。
 *
 * 不可靠也不致命——`term.js` 里已经挂着 250 ms 的轮询兜底，这条只是
 * 告诉我们兜底是不是**必需**的。
 */
async function m6(rl) {
  if (!onTTY) {
    record('M6', "`stdout.on('resize')` 可靠吗", 'SKIP', { note: '需要真终端 + 人拖窗口' });
    return;
  }
  let n = 0;
  /** @type {{cols: number|undefined, rows: number|undefined}[]} */
  const sizes = [];
  const onResize = () => { n++; sizes.push({ cols: process.stdout.columns, rows: process.stdout.rows }); };
  process.stdout.on('resize', onResize);

  await rl.question('\r\n  请把窗口**拖大再拖小**（改两次以上），然后按 Enter：');
  process.stdout.removeListener('resize', onResize);

  record('M6', "`stdout.on('resize')` 可靠吗", n > 0 ? 'PASS' : 'FAIL', {
    events: n,
    sizes,
    note: n > 0
      ? '★ 事件到了；250 ms 轮询仍保留（4 Hz 两次整数比较，代价可忽略）'
      : '⚠️ 没收到事件 ⇒ 轮询兜底是**必需**的，不是保险',
  });
}

// ═══════════════════════ M7 ═══════════════════════

/**
 * M7：`taskkill /F` 之后备用屏残留吗、控制台模式自愈吗。
 *
 * ⚠️ 这条**只能人验**：要验的场景是"面板正跑在**你自己的**终端里，被强杀"，
 * 而脚本没法一边自杀一边观察自己。所以脚本起一个**独立的**窗口演示，
 * 人去看那个窗口的下场。
 *
 * 残留的话，`CMT_UI=plain` 就从"逃生舱"升级为**默认**（§2.12 七）。
 */
async function m7(rl) {
  if (!ALL) {
    record('M7', '`taskkill /F` 之后备用屏残留吗', 'SKIP', { note: '加 --all 跑（会开一个独立窗口）' });
    return;
  }
  const child = win32Path.join(SANDBOX, 'alt-screen.mjs');
  nodeFs.writeFileSync(child, `
process.stdout.write('\\u001b[?1049h\\u001b[2J\\u001b[H\\u001b[?25l');
process.stdout.write('这个窗口在备用屏里。它马上会被 taskkill /F 强杀。\\r\\n');
setInterval(() => {}, 1000);
`, 'utf8');

  const title = 'cmt-m7-probe';
  spawn('cmd.exe', ['/c', 'start', `"${title}"`, process.execPath, child], { detached: true, stdio: 'ignore' }).unref();
  await new Promise((r) => setTimeout(r, 1800));
  spawnSync('taskkill', ['/F', '/FI', `WINDOWTITLE eq ${title}`], { encoding: 'utf8' });
  const ans = (await rl.question('\r\n  那个窗口被强杀之后，它**关掉了**还是**留在备用屏里**？(关掉/残留/没看清) ')).trim();
  record('M7', '`taskkill /F` 之后备用屏残留吗', ans.includes('残留') ? 'FAIL' : 'MANUAL', {
    answer: ans,
    note: ans.includes('残留')
      ? '★ 残留 ⇒ `CMT_UI=plain` 从逃生舱升级为默认（§2.12 七），并写进 README'
      : '⚠️ 独立窗口关掉时终端状态随窗口销毁，**证明不了**"在用户自己的终端里被强杀"也干净；README 仍要写清逃生舱',
  });
}

// ═══════════════════════ 主流程 ═══════════════════════

async function main() {
  console.log('\n═══ cmt 面板真机验收（§7.8）═══');
  console.log(`node ${process.version} · TTY ${onTTY ? 'yes' : 'no'} · WT_SESSION ${process.env.WT_SESSION ? 'yes' : 'no'}\n`);

  await m1();
  await m2();
  await m34();

  if (ALL && onTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await m2TTY(rl);
      await m5(rl);
      await m6(rl);
      await m7(rl);
    } finally {
      rl.close();
    }
  } else {
    const why = onTTY ? '加 --all 跑' : '需要在真终端里跑：node scripts/verify-ui-real.mjs --all';
    for (const [id, title] of [
      ['M2-TTY', "真控制台上 `'exit'` 里的 `stdout.write` 送得到吗"],
      ['M5', 'raw mode 下方向键的字节形态'],
      ['M6', "`stdout.on('resize')` 可靠吗"],
      ['M7', '`taskkill /F` 之后备用屏残留吗'],
    ]) {
      record(id, title, 'SKIP', { note: why });
    }
  }

  const report = {
    when: new Date().toISOString(),
    node: process.version,
    tty: onTTY,
    wt: process.env.WT_SESSION === true || Boolean(process.env.WT_SESSION),
    platform: process.platform,
    results,
  };
  nodeFs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf8');

  const bad = results.filter((r) => r.verdict === 'FAIL');
  console.log(`\n报告：${OUT}`);
  console.log(bad.length === 0
    ? '没有 FAIL。MANUAL/SKIP 的项按上面 detail 里的说明补。\n'
    : `★ ${bad.length} 项 FAIL：${bad.map((r) => r.id).join(', ')} —— 对应设计要重做\n`);
  process.exitCode = bad.length === 0 ? 0 : 1;
}

await main();
