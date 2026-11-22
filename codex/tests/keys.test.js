// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { decode, initialState } from '../src/cli/ui/keys.js';

// ───────────────────────────── 夹具 ─────────────────────────────

const ESC = '\x1b';

/**
 * 逐个 chunk 喂进去。`flush` 只作用在**最后一个** chunk 上——
 * 那正是驱动侧计时器到点时的调用形态。
 *
 * @param {string[]} chunks
 * @param {{ flush?: boolean }} [opts]
 */
function feed(chunks, { flush = false } = {}) {
  let state = initialState();
  /** @type {any[]} */
  const events = [];
  chunks.forEach((c, i) => {
    const r = decode(state, c, { flush: flush && i === chunks.length - 1 });
    state = r.state;
    events.push(...r.events);
  });
  return { state, events };
}

/** @param {string[]} chunks @param {{flush?: boolean}} [opts] */
const ev = (chunks, opts) => feed(chunks, opts).events;

/** 单个 chunk 的简写 @param {string} s */
const one = (s) => ev([s]);

/** @param {any[]} events */
const keys = (events) => events.filter((e) => e.type === 'key').map((e) => e.key);

/** @param {any[]} events */
const texts = (events) => events.filter((e) => e.type === 'text').map((e) => e.text);

/** @param {any[]} events */
const unknowns = (events) => events.filter((e) => e.type === 'unknown').map((e) => e.raw);

/** 断言"就这一个按键，别的什么都没有"——防止漏出多余的 text/unknown 事件 */
/** @param {any[]} events @param {string} k */
function onlyKey(events, k) {
  assert.deepEqual(events, [{ type: 'key', key: k }]);
}

// ═══════════════ 基本按键 ═══════════════

describe('keys —— 基本按键', () => {
  test('Enter：`\\r` 与 `\\n` 都算（终端发哪个随平台）', () => {
    onlyKey(one('\r'), 'enter');
    onlyKey(one('\n'), 'enter');
  });

  test('Tab', () => onlyKey(one('\t'), 'tab'));
  test('Shift+Tab = `ESC [ Z`', () => onlyKey(one(`${ESC}[Z`), 'shift-tab'));

  test('★ Backspace：`\\x7f` 与 `\\x08` 都认（到底是哪个随终端而异）', () => {
    onlyKey(one('\x7f'), 'backspace');
    onlyKey(one('\x08'), 'backspace');
  });

  test('★ 空格是**独立的按键**，不混进文本', () => {
    // 混进文本的话，"输入框里能不能打空格"与"列表里勾没勾上"就纠缠在一起了
    onlyKey(one(' '), 'space');
    assert.deepEqual(texts(one('a b')), ['a', 'b']);
    assert.deepEqual(keys(one('a b')), ['space']);
  });

  test('Ctrl+C 走 ctrl 事件（面板据此退出）', () => {
    assert.deepEqual(one('\x03'), [{ type: 'ctrl', key: 'c' }]);
  });

  test('其余 Ctrl+字母', () => {
    assert.deepEqual(one('\x01'), [{ type: 'ctrl', key: 'a' }]);
    assert.deepEqual(one('\x1a'), [{ type: 'ctrl', key: 'z' }]);
    assert.deepEqual(one('\x0b'), [{ type: 'ctrl', key: 'k' }]);
    assert.deepEqual(one('\x1c'), [{ type: 'ctrl', key: '\\' }]);
  });

  test('Ctrl+@（NUL）不编名字，报 unknown', () => {
    assert.equal(unknowns(one('\x00')).length, 1);
  });

  test('可打印字符攒成一段发，不是逐字符', () => {
    assert.deepEqual(one('hello'), [{ type: 'text', text: 'hello' }]);
  });

  test('中文整串进来是一段', () => {
    assert.deepEqual(one('中文'), [{ type: 'text', text: '中文' }]);
  });
});

// ═══════════════ 方向键与功能键 ═══════════════

describe('keys —— 方向键 / 功能键', () => {
  test('CSI 形态的四个方向键', () => {
    onlyKey(one(`${ESC}[A`), 'up');
    onlyKey(one(`${ESC}[B`), 'down');
    onlyKey(one(`${ESC}[C`), 'right');
    onlyKey(one(`${ESC}[D`), 'left');
  });

  test('★ SS3 形态也认（应用光标键模式 / ConPTY 会发这一套）', () => {
    onlyKey(one(`${ESC}OA`), 'up');
    onlyKey(one(`${ESC}OD`), 'left');
    onlyKey(one(`${ESC}OH`), 'home');
    onlyKey(one(`${ESC}OP`), 'f1');
  });

  test('Home / End 的两种写法', () => {
    onlyKey(one(`${ESC}[H`), 'home');
    onlyKey(one(`${ESC}[F`), 'end');
    onlyKey(one(`${ESC}[1~`), 'home');
    onlyKey(one(`${ESC}[4~`), 'end');
  });

  test('PgUp / PgDn / Delete / Insert', () => {
    onlyKey(one(`${ESC}[5~`), 'pgup');
    onlyKey(one(`${ESC}[6~`), 'pgdn');
    onlyKey(one(`${ESC}[3~`), 'delete');
    onlyKey(one(`${ESC}[2~`), 'insert');
  });

  test('功能键 F1–F12 两套编码', () => {
    onlyKey(one(`${ESC}[11~`), 'f1');
    onlyKey(one(`${ESC}[15~`), 'f5');
    onlyKey(one(`${ESC}[24~`), 'f12');
    onlyKey(one(`${ESC}OQ`), 'f2');
  });

  test('★ 方向键上的修饰键一律忽略：`ESC [ 1 ; 5 A` 就是 ↑', () => {
    // 面板里没有带修饰键的绑定，用户按 Ctrl+↑ 时想的就是"往上走"
    onlyKey(one(`${ESC}[1;5A`), 'up');
    onlyKey(one(`${ESC}[1;2B`), 'down');
    onlyKey(one(`${ESC}[5D`), 'left');
  });

  test('★ 但 `~` 结尾的**不做这个让步**：Shift+Delete 不能被当成 Delete', () => {
    // `ESC [ 3 ~` 是 Delete，`ESC [ 3 ; 2 ~` 是 Shift+Delete。
    // 混起来会真的删错东西，所以后者报 unknown。
    const u = unknowns(one(`${ESC}[3;2~`));
    assert.equal(u.length, 1);
    assert.match(u[0], /3;2/);
  });
});

// ═══════════════ ★★ 分裂输入 ═══════════════

describe('★★ keys —— 序列跨 chunk 分裂（这是写成状态机的唯一理由）', () => {
  test('`ESC [` 先到、`A` 后到 → 仍然是 ↑', () => {
    onlyKey(ev([`${ESC}[`, 'A']), 'up');
  });

  test('逐字节喂也认', () => {
    onlyKey(ev([ESC, '[', 'A']), 'up');
  });

  test('`ESC [ 1 ; 5` 先到、`A` 后到 → 仍然是 ↑', () => {
    onlyKey(ev([`${ESC}[1;5`, 'A']), 'up');
  });

  test('`~` 那一族分裂在 `~` 前面', () => {
    onlyKey(ev([`${ESC}[5`, '~']), 'pgup');
  });

  test('★★ 半个序列是**合法的中间状态**，不报错也不丢', () => {
    // 这条正是"正则式解码"会挂掉的地方：它只能把 `ESC [` 当未知按键丢掉，
    // 于是用户看到"方向键偶尔失灵"。
    const r = feed([`${ESC}[`]);
    assert.deepEqual(r.events, []);
    assert.equal(r.state.mode, 'csi');
  });

  test('分裂之后还能接着认后面的键', () => {
    const r = feed([`${ESC}[`, 'A', 'x']);
    assert.deepEqual(r.events, [
      { type: 'key', key: 'up' },
      { type: 'text', text: 'x' },
    ]);
  });

  test('粘贴标记也能分裂（`[201` + `~`）', () => {
    const events = ev([`${ESC}[200~ab`, `${ESC}[201`, '~']);
    assert.deepEqual(events, [{ type: 'paste', text: 'ab', truncated: false }]);
  });

  test('中文跨 chunk 各自成段（UTF-8 分裂由 StringDecoder 管，不归这里）', () => {
    assert.deepEqual(texts(ev(['中', '文'])), ['中', '文']);
  });
});

// ═══════════════ ★★ 粘贴模式 ═══════════════

describe('★★ keys —— 粘贴是一个模式，不是后处理（§面板 三）', () => {
  test('整段被 `[200~` … `[201~` 包住 → 一个 paste 事件', () => {
    assert.deepEqual(ev([`${ESC}[200~sk-abc${ESC}[201~`]), [
      { type: 'paste', text: 'sk-abc', truncated: false },
    ]);
  });

  test('★★ 粘贴里的 `\\r` / `\\n` 是字面文本，**不触发 Enter**', () => {
    // 关掉 ?2004 时，粘一段带尾换行的 sk-… 会中途提交——静默、破坏性。
    const events = ev([`${ESC}[200~sk-a\r\nsk-b\n${ESC}[201~`]);
    assert.deepEqual(events, [{ type: 'paste', text: 'sk-a\r\nsk-b\n', truncated: false }]);
    assert.deepEqual(keys(events), []);
  });

  test('★★ 粘贴里的 `\\x03` 不产生按键语义——绝不能把面板关掉', () => {
    const events = ev([`${ESC}[200~a\x03b${ESC}[201~`]);
    assert.deepEqual(events, [{ type: 'paste', text: 'a\x03b', truncated: false }]);
  });

  test('粘贴里的裸 ESC 是字面文本', () => {
    assert.deepEqual(ev([`${ESC}[200~a${ESC}b${ESC}[201~`]), [
      { type: 'paste', text: `a${ESC}b`, truncated: false },
    ]);
  });

  test('粘贴里的 `ESC [` 若不是结束标记，原样留着', () => {
    assert.deepEqual(ev([`${ESC}[200~a${ESC}[31mb${ESC}[201~`]), [
      { type: 'paste', text: `a${ESC}[31mb`, truncated: false },
    ]);
  });

  test('嵌套的 `[200~` 是内容，只有 `[201~` 收尾', () => {
    assert.deepEqual(ev([`${ESC}[200~a${ESC}[200~b${ESC}[201~`]), [
      { type: 'paste', text: `a${ESC}[200~b`, truncated: false },
    ]);
  });

  test('粘贴结束后回到正常态，后面的键照常解', () => {
    const events = ev([`${ESC}[200~a${ESC}[201~`, 'q']);
    assert.deepEqual(events, [
      { type: 'paste', text: 'a', truncated: false },
      { type: 'text', text: 'q' },
    ]);
  });

  test('空粘贴不产生事件', () => {
    assert.deepEqual(ev([`${ESC}[200~${ESC}[201~`]), []);
  });

  test('★★ 标记里**没有 `?`**：`ESC [ ? 200 ~` 绝不能进粘贴模式', () => {
    // 写成 `[?200~` 是经典 bug——永远匹配不上，`[200~` 变成插进输入框的字面文本。
    // 这里反过来断言：那个写法**认不出**，明确报 unknown。
    const events = ev([`${ESC}[?200~abc`]);
    assert.equal(events.filter((e) => e.type === 'paste').length, 0, '★ 不许进粘贴模式');
    assert.equal(unknowns(events).length, 1);
    assert.deepEqual(texts(events), ['abc']);
  });

  test('★ 超过上限的粘贴被截断，且**明说截断了**', () => {
    const big = 'x'.repeat(70 * 1024);
    const events = ev([`${ESC}[200~${big}${ESC}[201~`]);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'paste');
    assert.equal(events[0].truncated, true, '★ 截断必须说出来，不许静默');
    assert.equal(events[0].text.length, 64 * 1024);
  });

  test('截断之后仍然认得出结束标记', () => {
    const big = 'x'.repeat(70 * 1024);
    const events = ev([`${ESC}[200~${big}${ESC}[201~`, 'q']);
    assert.deepEqual(events[1], { type: 'text', text: 'q' });
  });
});

// ═══════════════ OSC 被吃掉 ═══════════════

describe('keys —— OSC 序列吃干净（内容不留，但不许漏成按键）', () => {
  test('BEL 收尾', () => {
    assert.deepEqual(ev([`${ESC}]0;窗口标题\x07`]), []);
  });

  test('ST（`ESC \\`）收尾', () => {
    assert.deepEqual(ev([`${ESC}]0;标题${ESC}\\`]), []);
  });

  test('★ 跨 chunk 分裂的 OSC', () => {
    assert.deepEqual(ev([`${ESC}]0;ti`, `tle\x07`, 'q']), [{ type: 'text', text: 'q' }]);
  });

  test('★ OSC 里的 `ESC` 不会把它提前结束', () => {
    assert.deepEqual(ev([`${ESC}]0;a${ESC}b\x07q`]), [{ type: 'text', text: 'q' }]);
  });
});

// ═══════════════ flush：歧义的收尾 ═══════════════

describe('★ keys —— flush（计时器在驱动侧，不在这里）', () => {
  test('★★ 单独一个 ESC + flush = Esc 键', () => {
    onlyKey(ev([ESC], { flush: true }), 'escape');
  });

  test('★ 没有 flush 时，单独一个 ESC **什么都不产生**（还在等后续）', () => {
    const r = feed([ESC]);
    assert.deepEqual(r.events, []);
    assert.equal(r.state.mode, 'esc');
  });

  test('★★ 半截序列不静默丢弃：`ESC [` + flush → unknown，且说明是半截', () => {
    const u = unknowns(ev([`${ESC}[`], { flush: true }));
    assert.equal(u.length, 1);
    assert.match(u[0], /半截/);
    assert.match(u[0], /ESC\[/);
  });

  test('更长的半截（`ESC [ 1 ; 5`）同样报出来', () => {
    const u = unknowns(ev([`${ESC}[1;5`], { flush: true }));
    assert.match(u[0], /1;5/);
  });

  test('`ESC O` + flush → unknown', () => {
    assert.match(unknowns(ev([`${ESC}O`], { flush: true }))[0], /半截/);
  });

  test('未收尾的 OSC + flush → unknown', () => {
    assert.match(unknowns(ev([`${ESC}]0;x`], { flush: true }))[0], /OSC/);
  });

  test('★ flush 之后状态回到正常态，后续输入照常', () => {
    // 计时器到点 → 带 flush 收尾 → 用户接着敲的字符必须是普通文本
    const a = decode(initialState(), `${ESC}[`, { flush: true });
    assert.equal(unknowns(a.events).length, 1);
    assert.equal(a.state.mode, 'ground');

    const b = decode(a.state, 'q');
    assert.deepEqual(b.events, [{ type: 'text', text: 'q' }]);
  });

  test('正常态 flush 不产生任何事件', () => {
    assert.deepEqual(ev(['abc'], { flush: true }), [{ type: 'text', text: 'abc' }]);
  });

  test('空 chunk + flush 也不炸', () => {
    assert.deepEqual(ev([''], { flush: true }), []);
  });
});

// ═══════════════ 认不出就报，不猜 ═══════════════

describe('★ keys —— 认不出的序列报 unknown，绝不猜', () => {
  test('CSI 里没见过的终结字节', () => {
    assert.match(unknowns(one(`${ESC}[1;2;3X`))[0], /ESC \[ 1;2;3X/);
  });

  test('`~` 里没见过的编号', () => {
    assert.match(unknowns(one(`${ESC}[99~`))[0], /99/);
  });

  test('Alt+字母（`ESC` + 字母）报 unknown，不当成文本', () => {
    const events = one(`${ESC}x`);
    assert.deepEqual(texts(events), []);
    assert.equal(unknowns(events).length, 1);
  });

  test('★ 没有开始标记的 `[201~` 明确报出来，而不是把状态搞乱', () => {
    const events = one(`${ESC}[201~`);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'unknown');
    assert.match(events[0].raw, /开始标记/);
  });

  test('★ 状态行里的控制字符是可读写法（ESC 直接打出来会把终端搞乱）', () => {
    const raw = unknowns(one(`${ESC}[99~`))[0];
    assert.ok(!raw.includes(ESC), '★ 不许把裸 ESC 放进要显示的文本');
    assert.match(raw, /ESC/);
  });
});

// ═══════════════ 纯度 ═══════════════

describe('keys —— 纯函数', () => {
  test('不改入参', () => {
    const s = initialState();
    const snapshot = JSON.stringify(s);
    decode(s, `${ESC}[A`);
    assert.equal(JSON.stringify(s), snapshot);
  });

  test('同输入同输出', () => {
    const a = JSON.stringify(feed([`${ESC}[200~x${ESC}[201~q`]));
    const b = JSON.stringify(feed([`${ESC}[200~x${ESC}[201~q`]));
    assert.equal(a, b);
  });

  test('★ 分两次喂与一次喂，事件序列一致（这才是状态机的意义）', () => {
    const whole = ev([`${ESC}[A${ESC}[Bx`]);
    const split = ev([`${ESC}[A${ESC}[`, 'Bx']);
    assert.deepEqual(split, whole);
  });
});
