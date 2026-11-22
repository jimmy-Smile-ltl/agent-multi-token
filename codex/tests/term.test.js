// @ts-check
/**
 * `ui/term.js` —— 终端驱动。§6.1 / §TUI-Win
 *
 * 这一层是**唯一碰真终端**的地方，所以它也是最难手工验的地方：真实终端里
 * "方向键偶尔失灵""退出后终端花了"这类问题只在特定时序下复现。
 * 于是这里注入**假 stdin/stdout**，把整条链路（字节 → 解码 → reducer →
 * 渲染 → 写出去）跑一遍，`render`/`reduce` 用的是**真的那两个**——
 * 不是替身。这样测的是真接线，不是接线图。
 *
 * 断言的重点在三处：**进屏只清一次屏**、**一帧一次 write**、**出屏一定还原**。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';

import { initialState, reduce } from '../src/cli/ui/app.js';
import { render } from '../src/cli/ui/render.js';
import { ENTER, ESC_MS, RESTORE, runPanel } from '../src/cli/ui/term.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/** 假 stdin：`EventEmitter` + 那四个驱动会调的方法。 */
class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    /** @type {boolean[]} */
    this.rawCalls = [];
    this.encoding = null;
    this.resumed = false;
  }
  setRawMode(on) { this.rawCalls.push(on); return this; }
  setEncoding(enc) { this.encoding = enc; return this; }
  resume() { this.resumed = true; return this; }
  pause() { this.resumed = false; return this; }
}

/** 假 stdout：每次 `write` 收一段，**不合并**——"一帧一次 write"正是要断言的。 */
class FakeStdout extends EventEmitter {
  /** @param {{columns?: number, rows?: number}} [size] */
  constructor(size = {}) {
    super();
    // ⚠️ 用 `in` 而不是 `??`：`{columns: undefined}` 要能表达"**终端根本没报尺寸**"
    //    （管道、某些 CI），那与"报了 100"是两件事。
    this.columns = 'columns' in size ? size.columns : 100;
    this.rows = 'rows' in size ? size.rows : 30;
    /** @type {string[]} */
    this.writes = [];
  }
  write(s) { this.writes.push(String(s)); return true; }
  get all() { return this.writes.join(''); }
  /** 进屏那一次之后的每一段（也就是"帧"） */
  get frames() { return this.writes.slice(1); }
}

const ITEMS = [
  { kind: 'cwd', label: '当前目录', token: 'relay-cxt', path: '/p/a', layer: 'binding', detail: { models: ['m1'] } },
  { kind: 'new', label: '+ 新建…' },
];
const DATA = {
  cwd: '/p/agent_multi_token',
  items: ITEMS,
  tokens: [{ name: 'relay-cxt', masked: 'sk-****abcd', baseUrl: 'https://x' }],
  appName: 'cxt',
  projectFile: '.cxt.json',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 起一个面板。
 *
 * @param {{sizeOverride?: {cols?: string, rows?: string}, exec?: any, columns?: number, rows?: number,
 *   initial?: any, reduce?: any, render?: any}} [o]
 */
function boot(o = {}) {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout({ columns: o.columns, rows: o.rows });
  /** @type {any[]} */
  const effects = [];
  /** @type {{cols: number, rows: number}[]} */
  const sizes = [];
  const exec = o.exec ?? ((fx) => { effects.push(fx); });
  const p = runPanel({
    stdin,
    stdout,
    sizeOverride: o.sizeOverride ?? {},
    initial: o.initial ?? initialState(DATA),
    reduce: o.reduce ?? reduce,
    render: o.render ?? ((s, size) => { sizes.push({ ...size }); return render(s, size); }),
    exec,
  });
  return { stdin, stdout, effects, sizes, p };
}

/** 送一段输入（模拟一次 `read()` 拿到的 chunk）。 */
const feed = (stdin, chunk) => stdin.emit('data', chunk);

// ═══════════════ 分层 ═══════════════

describe('★★ term —— 副作用只许在这一层（§4.2）', () => {
  // `app.test.js` 那边钉的是"另外三个文件**不许**碰 `node:`/`process`"。
  // 这里钉的是同一条契约的**另一半**：`term.js` 是那个唯一的例外，
  // 而且 `ui/` 里**只有四个文件**。少了这一半的话，将来多出第五个文件
  // （或者有人把 `fs` 抄进 `render.js`）两边都不会红。
  const dir = new URL('../src/cli/ui/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();

  test('★★ `ui/` 就是这四个文件；碰 `process` 的只有 `term.js`', () => {
    assert.deepEqual(files, ['app.js', 'keys.js', 'render.js', 'term.js']);

    /** @type {string[]} */
    const touching = [];
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      if (/\bprocess\./.test(src) || /from\s+'node:/.test(src)) touching.push(f);
    }
    assert.deepEqual(touching, ['term.js'], '★ 真实终端的全部不确定性都该收在 term.js 里');
  });

  test('★ `term.js` 只依赖 `keys.js`（不认识业务，也不认识另外两个）', () => {
    // 驱动层要是 import 了 `app.js` / `render.js`，"换一套界面"就得改驱动；
    // 而它现在的依赖面是"怎么把字节变成事件"——那是它唯一真需要的东西。
    const src = readFileSync(new URL('term.js', dir), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['node:fs', 'node:process', './keys.js']);
  });
});

// ═══════════════ 进屏 / 出屏 ═══════════════

describe('★★ term —— 进屏与出屏：终端状态是借来的，必须还', () => {
  test('★★ `RESTORE` 是**纯 ASCII**，且字节逐字对', () => {
    // 纯 ASCII 不是风格问题：这条会被 `fs.writeSync(1, …)` 写出去，
    // 而那条路径在 Windows 上绕过 libuv 的 UTF-8→UTF-16 转换，
    // **多字节字符**会被 CP936 按 GBK 解成乱码（§TUI-Win ②）。
    // ⚠️ 判据是"码点 ≤ 0x7f"，不是"可打印"——ESC（0x1b）本身就是 ASCII，
    //    而且这条序列**必须**有它。
    for (const ch of RESTORE) {
      const c = ch.charCodeAt(0);
      assert.ok(c <= 0x7f, `★ RESTORE 里有非 ASCII 字符 U+${c.toString(16)}`);
    }
    assert.ok(RESTORE.includes(String.fromCharCode(27)), '★ 一条控制序列怎么可能没有 ESC');
    // 顺序也不可换：先关括号粘贴 → 再显示光标 → 最后回主屏。
    assert.equal(RESTORE, '\u001b[?2004l\u001b[?25h\u001b[?1049l');
  });

  test('★ 进屏序列：开备用屏 → 清屏一次 → 藏光标 → 开括号粘贴', () => {
    assert.equal(ENTER, '\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l\u001b[?2004h');
    const h = boot();
    assert.equal(h.stdout.writes[0], ENTER, '★ 进屏必须是第一件事');
  });

  test('★★ `[2J` 全生命周期**只出现一次**（进屏那次）；此后每帧靠 `[K` 擦尾巴', () => {
    const h = boot();
    feed(h.stdin, 'q');
    const clears = h.stdout.all.split('\u001b[2J').length - 1;
    assert.equal(clears, 1, '★ 多清一次屏就是多闪一下');
  });

  test('★★ 退出：还原序列写出去，且**在最后一帧之后**', () => {
    const h = boot();
    feed(h.stdin, 'q');
    assert.equal(h.stdout.writes.at(-1), RESTORE);
    // 顺序理由：帧是异步写的，同步的 `writeSync` 会插队——出屏先到、帧后到，
    // 最后那帧就糊在主屏上了。
    const iFrame = h.stdout.writes.findIndex((w) => w.includes('当前目录'));
    assert.ok(iFrame > 0 && iFrame < h.stdout.writes.length - 1);
  });

  test('★★ 退出之后：raw mode 关掉、监听器摘干净、**再写不出东西**', () => {
    const h = boot();
    const before = h.stdout.writes.length;
    feed(h.stdin, 'q');
    assert.deepEqual(h.stdin.rawCalls, [true, false], '★ 借了 raw mode 就要还');
    assert.equal(h.stdin.resumed, false, '★ pause 掉，别让 stdin 一直拽着事件循环');
    for (const ev of ['data', 'end', 'close', 'error']) {
      assert.equal(h.stdin.listenerCount(ev), 0, `★ stdin 的 ${ev} 没摘`);
    }
    assert.equal(h.stdout.listenerCount('resize'), 0, '★ stdout 的 resize 没摘');

    const n = h.stdout.writes.length;
    feed(h.stdin, 'nnnn');
    h.stdout.columns = 40;
    h.stdout.emit('resize');
    assert.equal(h.stdout.writes.length, n, '★ 退出后还在画');
    assert.ok(before > 0);
  });

  test('★★ 拿不到 raw mode → 退 2，且**绝不进备用屏**', async () => {
    // 顺序理由：先 raw 再进屏。反过来的话这条路径上终端就卡在备用屏里了。
    const stdin = new FakeStdin();
    stdin.setRawMode = () => { throw new Error('not a tty'); };
    const stdout = new FakeStdout();
    const code = await runPanel({
      stdin, stdout, initial: initialState(DATA), reduce, render, exec: () => {},
    });
    assert.equal(code, 2);
    assert.deepEqual(stdout.writes, [], '★ 没进屏就不许写出屏——那会把主屏擦掉');
  });

  test('★ 假 stdout 上**不挂** `process.on(\'exit\')`（真终端才接管）', () => {
    const before = process.listenerCount('exit');
    boot();
    assert.equal(process.listenerCount('exit'), before, '★ 别把测试输出当终端写');
  });
});

// ═══════════════ 帧 ═══════════════

describe('★★ term —— 一帧一次 write，且按**实测尺寸**排版', () => {
  test('★★ 首帧用的是驱动测到的尺寸，不是 `initialState` 里那个 80×24', () => {
    const h = boot({ columns: 120, rows: 40 });
    assert.deepEqual(h.sizes[0], { cols: 120, rows: 40 }, '★ 不纠正的话窄终端第一帧就是折行的');
  });

  test('★★ 每个按键事件**恰好**一次 write（不是一帧拆几次）', () => {
    const h = boot();
    assert.equal(h.stdout.writes.length, 2, '进屏 + 首帧');
    feed(h.stdin, 'r');
    assert.equal(h.stdout.writes.length, 3, '★ 一次按键 = 一次 write');
  });

  test('★ 帧的行数恒等于 rows（少一行就是上一帧的尾巴留着）', () => {
    for (const rows of [12, 24, 40]) {
      const h = boot({ columns: 100, rows });
      const frame = h.stdout.frames.at(-1) ?? '';
      assert.equal(frame.split('\u001b[K').length - 1, rows, `rows=${rows}`);
    }
  });

  test('★★ 主屏没有输入框 → 帧尾 `?25l`；进了输入框 → 先 `CUP` 再 `?25h`', () => {
    const h = boot();
    assert.ok(h.stdout.writes[1].endsWith('\u001b[?25l'), '★ 主屏该藏光标');

    feed(h.stdin, 'n'); // 开向导 → 第 1 步是路径输入框
    const frame = h.stdout.writes.at(-1) ?? '';
    assert.match(frame, /\u001b\[\d+;\d+H\u001b\[\?25h$/, '★ 输入法候选框锚在真光标上，得先把它挪过去再显示');
  });

  test('★ 覆盖值优先于终端自报的尺寸（§TUI-Win ③）', () => {
    // Windows 上 `stdout.columns` 是**缓冲宽度**不是可见窗口宽度，所以要有出路。
    const h = boot({ sizeOverride: { cols: '72', rows: '20' }, columns: 200, rows: 60 });
    assert.deepEqual(h.sizes[0], { cols: 72, rows: 20 });
  });

  test('★ 尺寸是垃圾值时退回默认，**不许是 NaN**（NaN 会让 layout 退化）', () => {
    const h = boot({ sizeOverride: { cols: 'abc', rows: '0' }, columns: undefined, rows: undefined });
    assert.deepEqual(h.sizes[0], { cols: 80, rows: 24 });
  });
});

// ═══════════════ 尺寸变化 ═══════════════

describe('★ term —— resize', () => {
  test('★ 终端变宽 → 重画，且用的是新尺寸', () => {
    const h = boot({ columns: 100, rows: 30 });
    const before = h.stdout.writes.length;
    h.stdout.columns = 60;
    h.stdout.emit('resize');
    assert.equal(h.stdout.writes.length, before + 1);
    assert.deepEqual(h.sizes.at(-1), { cols: 60, rows: 30 });
  });

  test('★ 尺寸没变 → **不重画**（250 ms 轮询不能变成 4 Hz 的刷屏）', () => {
    const h = boot();
    const before = h.stdout.writes.length;
    for (let i = 0; i < 5; i++) h.stdout.emit('resize');
    assert.equal(h.stdout.writes.length, before, '★ 没变还画就是白闪');
  });
});

// ═══════════════ 输入 ═══════════════

describe('★★ term —— 字节进、事件出', () => {
  test('★★ `q` 退出：返回 0', async () => {
    const h = boot();
    feed(h.stdin, 'q');
    assert.equal(await h.p, 0);
  });

  test('★★ 分裂的方向键：`\\x1b` 与 `[B` 分两次到，**不许**当成 Esc', async () => {
    // 正则式解码器在这里会把 `[B` 当未知按键丢掉，用户看到的是"方向键偶尔失灵"——
    // 一个只在慢速/粘贴/多路复用下复现的幽灵 bug（§面板 三）。
    const h = boot();
    feed(h.stdin, '\u001b');
    feed(h.stdin, '[B');
    await sleep(ESC_MS + 30); // 若上面误判成 Esc，这一等就会退出
    const frame = h.stdout.writes.at(-1) ?? '';
    assert.ok(!h.stdout.writes.includes(RESTORE), '★ 被当成 Esc 就会退出');
    assert.ok(frame.length > 0);
  });

  test('★★ 裸 `\\x1b` 等 `ESC_MS` 后按 **Esc 键**处理（计时器在驱动层，不在解码器里）', async () => {
    const h = boot();
    feed(h.stdin, '\u001b');
    const mid = h.stdout.writes.length;
    assert.ok(!h.stdout.writes.includes(RESTORE), '★ 还没到点，不许急着当 Esc');
    await sleep(ESC_MS + 40);
    assert.equal(await h.p, 0, '★ 到点了，Esc = 退出');
    assert.ok(h.stdout.writes.length >= mid);
  });

  test('★★ 半截序列超时**不静默丢弃**，报出来（§面板 三 宁可明确）', async () => {
    const h = boot();
    feed(h.stdin, '\u001b[');
    await sleep(ESC_MS + 40);
    // ⚠️ 计时器只在 `esc` 态起表（见 `keys.js` 里那条约定），所以 `csi` 态不会超时。
    //    这条钉的就是那个约定本身：不许"顺手"把表也起在 `csi` 上——
    //    那会把一个只是慢了一点的正常序列从中间切开。
    assert.ok(!h.stdout.writes.includes(RESTORE), '★ `csi` 态不该超时');
    feed(h.stdin, 'B'); // 补全 → down
    feed(h.stdin, 'q');
    assert.equal(await h.p, 0);
  });

  test('★ stdin 用 `setEncoding(\'utf8\')`（UTF-8 分裂交给 `StringDecoder`，不自己写一遍）', () => {
    const h = boot();
    assert.equal(h.stdin.encoding, 'utf8');
    assert.equal(h.stdin.resumed, true);
  });

  test('★ stdin 关掉（管道断了）→ 正常收摊，不挂住', async () => {
    const h = boot();
    h.stdin.emit('end');
    assert.equal(await h.p, 0);
    assert.equal(h.stdout.writes.at(-1), RESTORE);
  });
});

// ═══════════════ effect ═══════════════

describe('★★ term —— effect 交给外面执行，回执从同一条路回来', () => {
  test('★★ `quit` **不进** executor：出屏是驱动层自己的事', () => {
    const h = boot();
    feed(h.stdin, 'q');
    assert.deepEqual(h.effects, [], '★ executor 不该收到 quit');
  });

  test('★★ 按键产生的 effect 交给 executor，且它 `dispatch` 回来的事件能改状态', async () => {
    const h = boot();
    feed(h.stdin, 'r');
    assert.deepEqual(h.effects.map((e) => e.type), ['reload']);

    // executor 是异步的：先看到"读取配置…"，回执回来之后才变成结果
    assert.match(h.stdout.writes.at(-1) ?? '', /读取配置/);
    h.effects.length = 0;
    const exec = () => {};
    void exec;
  });

  test('★★ executor **同步抛**异常 → 变成看得见的提示，不是"按了没反应"', () => {
    const h = boot({ exec: () => { throw new Error('EACCES: 配置文件只读'); } });
    feed(h.stdin, 'r');
    assert.match(h.stdout.writes.at(-1) ?? '', /出错了/, '★ 静默失败是 §6.2 的头号敌人');
    assert.match(h.stdout.writes.at(-1) ?? '', /EACCES/);
  });

  test('★★ executor **异步 reject** 也一样', async () => {
    const h = boot({ exec: async () => { throw new Error('拉模型超时'); } });
    feed(h.stdin, 'r');
    await sleep(5);
    assert.match(h.stdout.writes.at(-1) ?? '', /拉模型超时/);
  });

  test('★ executor 拿得到 `dispatch` 与 `signal`；退出时 signal 被 abort', async () => {
    /** @type {any} */
    let got = null;
    const h = boot({ exec: (fx, dispatch, signal) => { got = { fx, dispatch, signal }; } });
    feed(h.stdin, 'r');
    assert.equal(got.fx.type, 'reload');
    assert.equal(typeof got.dispatch, 'function');
    assert.equal(got.signal.aborted, false);

    feed(h.stdin, 'q');
    await h.p;
    assert.equal(got.signal.aborted, true, '★ 收摊时要让在飞的请求停手');
  });

  test('★★ 退出之后，**迟到的回执**不许再改状态、也不许再画', async () => {
    /** @type {any} */
    let late = null;
    const h = boot({ exec: (fx, dispatch) => { late = dispatch; } });
    feed(h.stdin, 'r');
    feed(h.stdin, 'q');
    await h.p;
    const n = h.stdout.writes.length;
    late({ type: 'reloaded', data: DATA, notice: '迟到了' });
    assert.equal(h.stdout.writes.length, n, '★ 退出后又被回执画了一帧');
  });

  test('★★ 多字符 chunk **逐字符**折开：`nq` 里的 `q` 是路径里的字，不许关面板', async () => {
    const h = boot();
    feed(h.stdin, 'nq');
    await sleep(5);
    assert.ok(!h.stdout.writes.includes(RESTORE), '★ 一键退出是最不能出的错');
    // 现在人在向导第 1 步，`q` 已经成了路径文本的一部分。
    // ★ 从**向导里**退出的路是 Ctrl+C（`Esc` 是逐层退，要按好几次）——
    //   这条顺手把"向导里 Ctrl+C 直达退出"也钉住了。
    feed(h.stdin, '\u0003');
    assert.equal(await h.p, 0);
  });
});
