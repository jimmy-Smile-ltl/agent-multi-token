// @ts-check
/**
 * 终端驱动：进屏 → 收键 → 画帧 → 出屏。§面板 七 / §TUI-Win
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这一层是 `cli/` 里唯一碰 `process` / `stdin` / `stdout` 的地方
 *
 * 与 `core/` 那条"不许自己读 `process.env`"的纪律**同源，作用域降一级**：
 * `ui/` 的另外三个文件（`keys.js` / `render.js` / `app.js`）是纯的，可单测；
 * 真实终端的全部不确定性都收在这个文件里。
 *
 * 所以这里**不认识任何业务**——不认识 token、不认识模型、不认识向导。
 * 它只知道四件事：怎么把一帧写出去、怎么把字节变成事件、怎么把事件喂给
 * reducer、怎么把 reducer 吐出来的 effect 交给外面执行。`render` / `reduce` /
 * `exec` 全是注入的，于是**假 stdin/stdout 就能把整条链路跑一遍**（§6.1）。
 *
 * ## 两条写路径**不能互换**（§TUI-Win ①②）
 *
 * | 什么时候 | 走哪条 | 为什么 |
 * |---|---|---|
 * | 画帧、正常出屏 | `stdout.write()` | Windows 上 TTY 是**异步**写，但 libuv 会把 UTF-8 转成 UTF-16 再 `WriteConsoleW`；中文只有这条路是对的 |
 * | `process.on('exit')` 兜底 | `fs.writeSync(1, …)` | `'exit'` 里 `stdout.write()` **可能根本没送到**；而 `writeSync` 绕过 libuv、直接写裸字节，中文会按 CP936 解成乱码 |
 *
 * ⇒ **`RESTORE` 必须是纯 ASCII**，这条有单测钉着。纯 ASCII 下两条路径字节相同，
 * 于是"出屏到底走了哪条"不影响结果——这是把 §TUI-Win 那两条约束同时满足的唯一办法。
 *
 * ⚠️ 还有一条**顺序**理由：正常路径不能用 `writeSync`。帧是异步写的，
 * 同步写会**插队**到还没落地的帧前面——出屏序列先到、帧后到，
 * 用户就会在备用屏关掉之后才看见最后那一帧糊在主屏上。
 * ─────────────────────────────────────────────────────────────
 */

import fs from 'node:fs';
import process from 'node:process';

import { decode, initialState as emptyDecoder } from './keys.js';

// ───────────────────────────── 终端序列 ─────────────────────────────

const ALT_ON = '\u001b[?1049h';
const ALT_OFF = '\u001b[?1049l';
const CURSOR_OFF = '\u001b[?25l';
const CURSOR_ON = '\u001b[?25h';
const BRACKET_ON = '\u001b[?2004h';
const BRACKET_OFF = '\u001b[?2004l';
const CLEAR_HOME = '\u001b[2J\u001b[H';

/**
 * 进屏。**`[2J[H` 全项目只在这里出现一次**（§面板 五：此后每帧靠 `[K` 擦尾巴，
 * 再清一次屏就是闪一下）。括号粘贴（`?2004`）必须开——见 `keys.js` 顶上那段：
 * 不开的话，粘进来的 `\r` 会变成 Enter、粘进来的 `\x1b` 会变成**注入的按键**。
 *
 * ⚠️ `[200~` / `[201~` 是**没有 `?`** 的（`?` 只属于 DECSET/DECRST）。
 * 写成 `[?200~` 的话永远匹配不上，那串标记会当字面文本插进输入框。
 */
export const ENTER = ALT_ON + CLEAR_HOME + CURSOR_OFF + BRACKET_ON;

/**
 * 出屏。★★ **顺序不可换**，且**必须是纯 ASCII**。
 *
 * 顺序：先关括号粘贴（否则粘贴标记会漏到主屏的 shell 里）→ 再显示光标
 * → 最后回主屏。带着隐藏光标回主屏 = 用户看不见自己的 shell 光标，
 * 而那个状态**没有任何按键能救回来**（`?25h` 得由程序发）。
 *
 * ASCII：这条会被 `fs.writeSync(1, …)` 写出去，而非 ASCII 在那条路径上是乱码。
 */
export const RESTORE = BRACKET_OFF + CURSOR_ON + ALT_OFF;

/** `Esc` 歧义的等待窗口（§面板 三）。**计时器在这一层，不在 `keys.js` 里**。 */
export const ESC_MS = 30;

/** 尺寸轮询兜底（§TUI-Win M6）。`resize` 事件在 WT 里可靠，但这是 4 Hz 的两次整数比较。 */
export const POLL_MS = 250;

// ───────────────────────────── 尺寸 ─────────────────────────────

/**
 * 尺寸：**覆盖值优先，终端自报次之**。
 *
 * ⚠️ 这里**不认识环境变量**。`CXT_UI_COLS` / `CMT_UI_COLS` 这类名字由**调用方**
 * 读出来、把**值**放进 `io.sizeOverride` 递进来——四个内核文件要逐字一致（§4.1），
 * 写死一个工具的环境变量名就一致不成了。
 *
 * @param {any} stdout
 * @param {{ cols?: string, rows?: string }} [override]
 * @returns {{cols: number, rows: number}}
 */
function readSize(stdout, override) {
  return {
    cols: pickInt(override?.cols, stdout?.columns, 80),
    rows: pickInt(override?.rows, stdout?.rows, 24),
  };
}

/**
 * 取第一个"像个正整数"的值。
 *
 * ⚠️ 不能写成 `Number(x) || dflt`：`0` 和 `''` 都是 falsy，会**静默**退回默认值，
 * 而"用户明明把列宽写成了 `0`"和"根本没设"是两件事。非有限数、小于 1、
 * 以及 `undefined`/`null` 才退回。
 *
 * @param {any} a 优先（调用方给的覆盖值，原样传进来，别先 `Number()` 掉）
 * @param {any} b 次之（终端自报）
 * @param {number} dflt
 */
function pickInt(a, b, dflt) {
  for (const v of [a, b]) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return dflt;
}

// ───────────────────────────── 驱动 ─────────────────────────────

/**
 * @typedef {(effect: any, dispatch: (ev: any) => void, signal: AbortSignal) => void | Promise<void>} Executor
 */

/**
 * 跑起面板。**返回的 Promise 在用户退出时兑现**，值是退出码。
 *
 * @param {{
 *   stdin: any,
 *   stdout: any,
 *   sizeOverride?: { cols?: string, rows?: string },
 *   initial: any,
 *   reduce: (state: any, ev: any) => { state: any, effects: any[] },
 *   render: (state: any, size: { cols: number, rows: number }) => { frame: string, cursor: { row: number, col: number } | null },
 *   exec: Executor,
 * }} io
 * @returns {Promise<number>} 0 正常退出 / 2 环境不支持（拿不到 raw mode）
 */
export function runPanel(io) {
  const { stdin, stdout, sizeOverride = {}, initial, reduce, render, exec } = io;

  let state = initial;
  let dec = emptyDecoder();
  let done = false;
  /** @type {any} */
  let escTimer = null;
  /** @type {any} */
  let pollTimer = null;
  const ac = new AbortController();

  /** @type {(code: number) => void} */
  let settle = () => {};
  const finished = new Promise((/** @type {(code: number) => void} */ res) => { settle = res; });

  // ── 画帧 ──
  //   ★ 一帧**一次** `write()`。不是为了省系统调用，是为了让终端把一帧当一帧
  //   （§面板 五②）——拆成几次写，中间那一瞬间的半屏就是"撕裂"。
  //   光标可见性也在这里发：`render()` 返回 `null` 就藏起来（§TUI-Win · 输入法，
  //   输入法候选框锚在真光标上，所以有输入框时不但要显示、还得先 `CUP` 过去）。
  function draw() {
    if (done) return;
    const { frame, cursor } = render(state, readSize(stdout, sizeOverride));
    stdout.write(cursor === null
      ? frame + CURSOR_OFF
      : `${frame}\u001b[${cursor.row};${cursor.col}H${CURSOR_ON}`);
  }

  // ── 分发 ──
  //   ★ 收键与 effect 回执**走同一条路**。分成两条的话，"按键到达"与
  //   "异步结果到达"就会有两套更新顺序，而那正是最难复现的一类竞态。
  /** @param {any} ev */
  function pump(ev) {
    if (done) return;
    const r = reduce(state, ev);
    state = r.state;
    draw();
    for (const fx of r.effects) run(fx);
  }

  /** @param {any} fx */
  function run(fx) {
    // `quit` 是驱动层自己的事：它要的是**出屏**，不是"执行一个动作"。
    // 交给外面执行的话，外面就得知道怎么关终端——那就分了两处真相。
    if (fx.type === 'quit') { finish(0); return; }

    let p;
    try {
      p = exec(fx, pump, ac.signal);
    } catch (err) {
      pump({ type: 'failed', error: message(err) });
      return;
    }
    // ★★ 兜底：executor **抛出来**的异常必须变成看得见的提示。
    //   没有这一条的话，一个 EPERM 会表现为"按了 Enter 什么都没发生"——
    //   正是 §6.2 要消灭的那种静默。各 executor 自己发的 `*-failed` 事件措辞更准，
    //   这里是"忘了处理"的网。
    if (p && typeof p.then === 'function') {
      p.catch((/** @type {any} */ err) => pump({ type: 'failed', error: message(err) }));
    }
  }

  /** @param {any} err */
  function message(err) {
    return String(err?.message ?? err ?? '未知原因');
  }

  // ── 输入 ──
  /** @param {Buffer | string} chunk */
  function onData(chunk) {
    if (done) return;
    const r = decode(dec, typeof chunk === 'string' ? chunk : String(chunk));
    dec = r.state;
    armEsc();
    for (const ev of r.events) pump(ev);
  }

  //   ★★ 只在 `esc` 态起表。`keys.js` 顶上写着这条约定，而它是对的：
  //   序列**会**跨 chunk 分裂（`[` 先到、`A` 后到），但**分裂的那两半之间
  //   不会有 30 ms 的间隔**——真有的话那是终端坏了。给每个非 ground 态都起表
  //   反而会把一个正常的、只是慢了一点的序列从中间切开，然后报一句
  //   "半截序列"的假警报。
  function armEsc() {
    if (escTimer !== null) { clearTimeout(escTimer); escTimer = null; }
    if (dec.mode !== 'esc') return;
    escTimer = setTimeout(() => {
      escTimer = null;
      if (done) return;
      const r = decode(dec, '', { flush: true });
      dec = r.state;
      for (const ev of r.events) pump(ev);
    }, ESC_MS);
  }

  /** @param {any} chunk */
  function onEnd() { finish(0); }

  // ── 尺寸 ──
  function onResize() {
    if (done) return;
    const s = readSize(stdout, sizeOverride);
    if (s.cols === state.view.cols && s.rows === state.view.rows) return;
    pump({ type: 'resize', cols: s.cols, rows: s.rows });
  }

  // ── 出屏 ──
  /** @param {number} code */
  function finish(code) {
    if (done) return;
    done = true;
    teardown();
    settle(code);
  }

  function teardown() {
    if (escTimer !== null) { clearTimeout(escTimer); escTimer = null; }
    if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
    stdin.removeListener('data', onData);
    stdin.removeListener('end', onEnd);
    stdin.removeListener('close', onEnd);
    stdin.removeListener('error', onEnd);
    stdout.removeListener('resize', onResize);
    process.removeListener('exit', onProcessExit);
    ac.abort();
    setRaw(false);
    if (typeof stdin.pause === 'function') stdin.pause();
    // ★ 正常路径走**异步** `write`（不是 `writeSync`）：帧是异步写的，
    //   同步写会插队到还没落地的帧前面——出屏先到、帧后到，最后那帧就糊在主屏上了。
    try { stdout.write(RESTORE); } catch { /* 终端已经没了，尽力而为 */ }
  }

  /**
   * `process.on('exit')` 兜底：**没走到 `teardown()` 就退出**的那些路
   * （未捕获异常、别处 `process.exit()`、raw mode 生效前的 Ctrl+C）。
   *
   * ⚠️ 这条路径只能用 `fs.writeSync`——`'exit'` 里 `stdout.write()` 可能根本没送到
   * （§TUI-Win ①）。好在 `RESTORE` 是纯 ASCII，两条路径字节相同。
   *
   * ⚠️ `SIGTERM` / 任务管理器在 Windows 上是无条件 `TerminateProcess`（§TUI-Win M7）：
   * 没有 `'exit'`、没有回调，**这条兜底也拦不住**。那种情况下的出路是
   * 调用方那个"逐行输出"的逃生舱（§面板 七）。
   */
  function onProcessExit() {
    try { fs.writeSync(1, RESTORE); } catch { /* 尽力而为 */ }
  }

  /** @param {boolean} on */
  function setRaw(on) {
    if (typeof stdin.setRawMode !== 'function') return false;
    try { stdin.setRawMode(on); return true; } catch { return false; }
  }

  // ── 起飞 ──
  //   ⚠️ 顺序：先 raw 再进屏。反过来的话，`setRawMode` 抛异常时
  //   备用屏已经进去了，而那条异常路径上没有出屏——终端就卡在备用屏里。
  if (!setRaw(true)) return Promise.resolve(2);

  stdout.write(ENTER);
  //   只接管**真终端**的退出路径。测试里注入的假 stdout 不是 `process.stdout`，
  //   给它挂 `fs.writeSync(1, …)` 只会把出屏序列打进测试输出里。
  const ownsRealTerminal = stdout === process.stdout;
  if (ownsRealTerminal) process.on('exit', onProcessExit);

  if (typeof stdin.setEncoding === 'function') stdin.setEncoding('utf8');
  stdin.on('data', onData);
  stdin.on('end', onEnd);
  stdin.on('close', onEnd);
  stdin.on('error', onEnd);
  stdout.on('resize', onResize);
  if (typeof stdin.resume === 'function') stdin.resume();

  pollTimer = setInterval(onResize, POLL_MS);
  if (typeof pollTimer?.unref === 'function') pollTimer.unref();

  // ★ 首帧：先把驱动测到的真实尺寸喂进去，再画。
  //   `initialState()` 里的 80×24 是保守默认值，不纠正的话第一帧会按 80 列排版，
  //   窄终端上**第一帧就是折行的**。
  pump({ type: 'resize', cols: readSize(stdout, sizeOverride).cols, rows: readSize(stdout, sizeOverride).rows });

  return finished;
}
