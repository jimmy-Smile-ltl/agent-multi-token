// @ts-check
/**
 * ★ **字节流 → 按键事件**（§面板 三）——纯函数，没有计时器、没有 stdin、没有终端。
 *
 * ```
 * decode(state, chunk) → { state, events }
 * ```
 *
 * ─────────────────────────────────────────────────────────────
 * ## ★★ 为什么是逐字符可中断的状态机，而不是对 chunk 跑正则
 *
 * 因为**序列会跨 chunk 分裂**。`ESC [` 可能先到、`A` 后到；粘贴中文时 UTF-8
 * 续字节同理（那一半交给 Node 的 `StringDecoder`——`stdin.setEncoding('utf8')`
 * 已经把这个状态机写好测好了，**不要自己再实现一遍**）。
 *
 * 正则式解码遇到分裂的 `ESC [` 只能把它当"未知按键"丢掉。用户看到的是
 * 「**方向键偶尔失灵**」——一个只在慢速、粘贴、多路复用下复现的幽灵 bug。
 * 状态机把"半个序列"当**合法的中间状态**，于是分裂是正常路径而不是异常路径。
 * 测试专门喂分裂输入（`'ESC['` + `'A'`、`'ESC[1;5'` + `'A'`、`'[201'` + `'~'`）。
 *
 * ## ★★ 粘贴是一个**模式**，不是后处理
 *
 * 开了括号粘贴（`?2004`）之后，终端把整段粘贴用 `ESC [ 200 ~` … `ESC [ 201 ~`
 * 包起来。在这两个标记**之间**的所有字节——`\r`、`\n`、`\x03`、`ESC`——
 * **逐字节都是字面文本**。
 *
 * 所以粘贴期间不许有任何按键语义泄漏出去，**包括 `\x03`**：
 * 粘一段含 Ctrl+C 的二进制内容绝不能把面板关掉。
 * 这条只有"模式"能做到；"先解码再判断是不是在粘贴"必然已经泄漏了。
 *
 * ## ★ 计时器**不进这个文件**
 *
 * 单独的 `ESC` 既可能是 Esc 键、也可能是某个序列的开头。消歧要靠 30 ms 计时，
 * 而计时器是副作用——它一旦进来，这个模块就不能在测试里同步跑完了。
 * ⇒ 驱动侧超时后**再调一次** `decode(state, '', { flush: true })`：
 * 仍停在 `esc` 态的单字节按 Esc 处理；更长的半截序列（`ESC [`）**不静默丢弃**，
 * 明确报 `unknown`（宁可明确，不要静默——§6.2 的同一纪律）。
 *
 * ## 认不出的东西怎么办
 *
 * 一律报 `unknown` 并把原文（控制字符转成可读写法）带出去，由状态行显示。
 * **不猜**：把 `ESC [ 27;5;13 ~` 猜成 Enter 会让"按了没反应"变成"按了做了别的事"，
 * 后者难查得多。
 *
 * 例外是**光标键上的修饰键**：`ESC [ 1 ; 5 A` 一律当 `↑`。
 * 面板里没有带修饰键的绑定，用户按 Ctrl+↑ 时想的就是"往上走"。
 * （`~` 结尾的那些不做这个让步：`ESC [ 3 ; 2 ~` 是 Shift+Delete，
 * 而 `ESC [ 3 ~` 是 Delete——把它们混起来会真的删错东西。）
 * ─────────────────────────────────────────────────────────────
 */

/** 转义字符。写成常量免得正文里到处是裸的 `\x1b`（看不见，最容易看错） */
const ESC = '\x1b';

/**
 * 一段粘贴最多攒这么多字符，超了就**停止累积**并在事件上打 `truncated`。
 *
 * 为什么要有上限：往输入框里粘一个 10 MB 的日志文件时，没有上限就意味着
 * 10 MB 的字符串被攒下来、再被塞进输入框、再被逐帧渲染——面板直接卡死。
 * 64 KiB 够放下一份超长的密钥或路径，而它绝不会是用户真想粘进输入框的东西。
 *
 * ⚠️ 截断**不静默**：`truncated: true` 会一路传到界面上说"粘贴内容过长，已截断"。
 */
const PASTE_MAX = 64 * 1024;

/**
 * 按键事件的联合类型。
 *
 * @typedef {{ type: 'key', key: KeyName }} KeyEvent
 * @typedef {{ type: 'text', text: string }} TextEvent
 * @typedef {{ type: 'ctrl', key: string }} CtrlEvent
 * @typedef {{ type: 'paste', text: string, truncated: boolean }} PasteEvent
 * @typedef {{ type: 'unknown', raw: string }} UnknownEvent
 * @typedef {KeyEvent | TextEvent | CtrlEvent | PasteEvent | UnknownEvent} Event
 */

/**
 * 有名字的键。**这是全部**——面板的键位表（§面板 二）不许超出这个集合。
 *
 * @typedef {'up'|'down'|'left'|'right'|'home'|'end'|'pgup'|'pgdn'
 *   |'enter'|'tab'|'shift-tab'|'backspace'|'delete'|'insert'|'space'|'escape'
 *   |'f1'|'f2'|'f3'|'f4'|'f5'|'f6'|'f7'|'f8'|'f9'|'f10'|'f11'|'f12'} KeyName
 */

/**
 * 解码器状态。**对调用方不透明**——只许原样带回来，不许自己拼。
 *
 * `mode` 的含义：
 *
 * | mode | 含义 |
 * |---|---|
 * | `ground` | 正常文本态 |
 * | `esc` | 刚收到一个 `ESC`，还不知道它是 Esc 键还是序列开头 |
 * | `csi` | 正在收 `ESC [ …`（含粘贴标记） |
 * | `ss3` | 刚收到 `ESC O`（应用光标键那一套） |
 * | `osc` / `osc-esc` | 正在吃掉一段 OSC（内容不要，但必须吃干净） |
 * | `paste` | 粘贴模式：内容是字面文本 |
 * | `paste-esc` / `paste-csi` | 粘贴模式里**可能**遇到了结束标记的开头 |
 *
 * @typedef {object} DecoderState
 * @property {'ground'|'esc'|'csi'|'ss3'|'osc'|'osc-esc'|'paste'|'paste-esc'|'paste-csi'} mode
 * @property {string} buf  半截序列（`esc` / `csi` / `ss3` 态用）
 * @property {string} paste 已攒下的粘贴内容（`paste*` 态用）
 */

/**
 * 初始状态。**每次返回新对象**——共享一个常量迟早会被人就地改掉。
 * @returns {DecoderState}
 */
export function initialState() {
  return { mode: 'ground', buf: '', paste: '' };
}

/**
 * 吃一段输入，吐出按键事件。
 *
 * @param {DecoderState} state 上一轮的返回值（首次用 `initialState()`）
 * @param {string} chunk 已解码成字符串的输入（**不要传 Buffer**：UTF-8 分裂交给 StringDecoder）
 * @param {{ flush?: boolean }} [opts]
 *   `flush: true` = "短时间内不会再有输入了，把悬着的东西按歧义的最可能解处理掉"。
 *   驱动侧的 30 ms 计时器到点后调用；**解码器自己不设计时器**。
 * @returns {{ state: DecoderState, events: Event[] }}
 */
export function decode(state, chunk, opts = {}) {
  const src = typeof chunk === 'string' ? chunk : '';

  let mode = state.mode;
  let buf = state.buf;
  let acc = state.paste;
  let truncated = false;

  /** @type {Event[]} */
  const events = [];

  // ── 可打印字符攒成一段再发 ──
  //   不是为了省事件，是为了让上层"一次插入一串"而不是逐字符插入——
  //   中文、emoji 都可能在一次输入里连成一串，逐字符发出去它们就成了 N 个事件。
  let run = '';
  const flushRun = () => {
    if (run !== '') {
      events.push({ type: 'text', text: run });
      run = '';
    }
  };
  /** @param {KeyName} k */
  const emitKey = (k) => {
    flushRun();
    events.push({ type: 'key', key: k });
  };
  /** @param {Event} e */
  const emitRaw = (e) => {
    flushRun();
    events.push(e);
  };

  /** 往粘贴缓冲区追加字面文本（超上限就停止累积，但**继续扫描结束标记**） */
  const appendPaste = (/** @type {string} */ s) => {
    if (acc.length >= PASTE_MAX) {
      truncated = true;
      return;
    }
    acc += s;
  };
  /** 粘贴结束：把攒下的内容作为一个事件发出去 */
  const finishPaste = () => {
    if (acc !== '') events.push({ type: 'paste', text: acc, truncated });
    acc = '';
    truncated = false;
  };

  for (const ch of src) {
    switch (mode) {
      // ═════════════ 正常态 ═════════════
      case 'ground': {
        if (ch === ESC) {
          mode = 'esc';
          buf = '';
        } else if (ch === '\r' || ch === '\n') {
          emitKey('enter');
        } else if (ch === '\t') {
          emitKey('tab');
        } else if (ch === '\x7f' || ch === '\x08') {
          // ★ 两个都认：Backspace 到底是 `\x08` 还是 `\x7f` 随终端而异（§TUI-Win · Backspace）。
          //   代价是丢掉 Ctrl+H 与 Backspace 的区分——本面板不需要那个区分。
          emitKey('backspace');
        } else if (ch === ' ') {
          // ★ 空格**单独成事件**，不混进文本：面板用空格勾选（§面板 四），
          //   混进文本的话"输入框里能不能打空格"和"列表里勾没勾上"就纠缠在一起了。
          emitKey('space');
        } else if (ch < ' ') {
          emitRaw(ctrlEvent(ch));
        } else {
          run += ch;
        }
        break;
      }

      // ═════════════ ESC 之后 ═════════════
      case 'esc': {
        if (ch === '[') {
          mode = 'csi';
          buf = '';
        } else if (ch === ']') {
          mode = 'osc';
          buf = '';
        } else if (ch === 'O') {
          mode = 'ss3';
          buf = '';
        } else {
          // `ESC` + 别的字符。Alt+字母在多数终端上就是这个样子，
          // 我们不绑定 Alt，所以报 unknown 让状态行说出来——**不猜**。
          emitRaw({ type: 'unknown', raw: `${vis(ESC)} ${vis(ch)}` });
          mode = 'ground';
        }
        break;
      }

      // ═════════════ ESC [ … ═════════════
      case 'csi': {
        if (isCsiParam(ch)) {
          buf += ch;
          break;
        }
        if (!isCsiFinal(ch)) {
          emitRaw({ type: 'unknown', raw: `${vis(ESC)} [ ${vis(buf)} ${vis(ch)}` });
          mode = 'ground';
          buf = '';
          break;
        }

        // ── 括号粘贴的两个标记 ──
        //   ⚠️ 标记是 `ESC [ 200 ~` / `ESC [ 201 ~`，**没有 `?`**。
        //      `?` 只在 DECSET/DECRST 的设置序列里。写成 `ESC [ ? 200 ~` 是经典 bug：
        //      永远匹配不上，于是 `[200~` 变成插进输入框的字面文本（§面板 三）。
        if (buf === '200' && ch === '~') {
          mode = 'paste';
          acc = '';
          truncated = false;
          buf = '';
          break;
        }
        if (buf === '201' && ch === '~') {
          // 没开粘贴却收到结束标记：说明我们错过了开始标记（终端被抢过？）。
          // 明确报出来，别把状态机搞乱。
          emitRaw({ type: 'unknown', raw: '粘贴结束标记（没见到开始标记）' });
          mode = 'ground';
          buf = '';
          break;
        }

        for (const e of csiEvents(buf, ch)) emitRaw(e);
        mode = 'ground';
        buf = '';
        break;
      }

      // ═════════════ ESC O … ═════════════
      case 'ss3': {
        // 应用光标键模式（DECCKM）下方向键走这一套。我们不设 DECCKM，
        // 但 ConPTY 与某些终端照样会发——两条都认，成本是一张表。
        const k = SS3_KEYS[ch];
        if (k !== undefined) emitKey(k);
        else emitRaw({ type: 'unknown', raw: `${vis(ESC)} O ${vis(ch)}` });
        mode = 'ground';
        break;
      }

      // ═════════════ OSC（内容全丢，但必须吃干净）═════════════
      case 'osc': {
        if (ch === '\x07') {
          mode = 'ground'; // BEL 收尾
        } else if (ch === ESC) {
          mode = 'osc-esc';
        }
        // 其余字节：**吃掉，不留**。OSC 是终端对查询的应答，不是用户的按键。
        break;
      }

      case 'osc-esc': {
        if (ch === '\\') {
          mode = 'ground'; // ST（ESC \）收尾
        } else if (ch !== ESC) {
          mode = 'osc'; // 那个 ESC 是内容的一部分，继续吃
        }
        break;
      }

      // ═════════════ 粘贴模式 ═════════════
      case 'paste': {
        if (ch === ESC) mode = 'paste-esc';
        else appendPaste(ch);
        break;
      }

      case 'paste-esc': {
        if (ch === '[') {
          mode = 'paste-csi';
          buf = '';
        } else {
          // 不是结束标记的开头 ⇒ 那个 ESC 是**粘贴内容**
          appendPaste(ESC);
          appendPaste(ch);
          mode = 'paste';
        }
        break;
      }

      case 'paste-csi': {
        if (isCsiParam(ch)) {
          buf += ch;
          break;
        }
        if (ch === '~' && buf === '201') {
          finishPaste();
          mode = 'ground';
          buf = '';
          break;
        }
        // 其余一律当内容（含 `ESC [ …` 的原文），回到粘贴态继续攒
        appendPaste(`${ESC}[${buf}${ch}`);
        buf = '';
        mode = 'paste';
        break;
      }
    }
  }

  flushRun();

  // ═════════════ flush：把悬着的歧义解掉 ═════════════
  if (opts.flush === true) {
    switch (mode) {
      case 'ground':
        break;

      case 'esc':
        // ★ 单独一个 ESC + 没有后续 = **Esc 键**。这就是 30 ms 计时器存在的全部理由。
        events.push({ type: 'key', key: 'escape' });
        mode = 'ground';
        break;

      case 'csi':
      case 'ss3':
        // 更长的半截序列：**不静默丢弃**，明确报出来（§面板 三）
        emitRaw({
          type: 'unknown',
          raw: `${vis(ESC)}${mode === 'csi' ? '[' : 'O'}${vis(buf)}（半截序列，超时未收尾）`,
        });
        mode = 'ground';
        buf = '';
        break;

      case 'osc':
      case 'osc-esc':
        emitRaw({ type: 'unknown', raw: '未收尾的 OSC 序列' });
        mode = 'ground';
        break;

      case 'paste':
      case 'paste-esc':
      case 'paste-csi':
        // ⚠️ 正常情况下不会走到这里：驱动侧的计时器只在 `esc` 态启动。
        //    真走到这里说明粘贴没收到结束标记（终端被强杀？）。
        //    把已经攒下的**当粘贴交出去**——总比默默吞掉强。
        if (mode === 'paste-esc') appendPaste(ESC);
        if (mode === 'paste-csi') appendPaste(`${ESC}[${buf}`);
        finishPaste();
        mode = 'ground';
        buf = '';
        break;
    }
  }

  return { state: { mode, buf, paste: acc }, events };
}

// ───────────────────────────── 内部 ─────────────────────────────

/** @type {Record<string, KeyName>} */
const SS3_KEYS = {
  A: 'up', B: 'down', C: 'right', D: 'left',
  H: 'home', F: 'end',
  P: 'f1', Q: 'f2', R: 'f3', S: 'f4',
};

/**
 * CSI 的参数字节（ECMA-48：`0x30`–`0x3F`）与中间字节（`0x20`–`0x2F`）。
 * @param {string} ch
 */
function isCsiParam(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f);
}

/**
 * CSI 的终结字节（ECMA-48：`0x40`–`0x7E`）。
 * @param {string} ch
 */
function isCsiFinal(ch) {
  const c = ch.charCodeAt(0);
  return c >= 0x40 && c <= 0x7e;
}

/**
 * `ESC [ <params> <final>` → 事件。
 *
 * ★ **字母结尾的一律忽略参数**：`ESC [ 1 ; 5 A` 就是 `↑`（见文件头那段说明）。
 * `~` 结尾的**只看精确匹配**：认不出就报 unknown，绝不猜。
 *
 * @param {string} params
 * @param {string} final
 * @returns {Event[]}
 */
function csiEvents(params, final) {
  switch (final) {
    case 'A': return [{ type: 'key', key: 'up' }];
    case 'B': return [{ type: 'key', key: 'down' }];
    case 'C': return [{ type: 'key', key: 'right' }];
    case 'D': return [{ type: 'key', key: 'left' }];
    case 'H': return [{ type: 'key', key: 'home' }];
    case 'F': return [{ type: 'key', key: 'end' }];
    case 'Z': return [{ type: 'key', key: 'shift-tab' }];
    case '~': return tildeEvents(params);
    default:
      return [{ type: 'unknown', raw: `${vis(ESC)} [ ${vis(params)}${vis(final)}` }];
  }
}

/**
 * `ESC [ <n> ~` 那一族。**只有表里这些认，其余报 unknown。**
 * @param {string} params
 * @returns {Event[]}
 */
function tildeEvents(params) {
  /** @type {Record<string, KeyName>} */
  const T = {
    1: 'home', 2: 'insert', 3: 'delete', 4: 'end',
    5: 'pgup', 6: 'pgdn', 7: 'home', 8: 'end',
    11: 'f1', 12: 'f2', 13: 'f3', 14: 'f4', 15: 'f5',
    17: 'f6', 18: 'f7', 19: 'f8', 20: 'f9', 21: 'f10',
    23: 'f11', 24: 'f12',
  };
  const k = T[params];
  if (k !== undefined) return [{ type: 'key', key: k }];
  return [{ type: 'unknown', raw: `${vis(ESC)} [ ${vis(params)}~` }];
}

/**
 * 控制字符 → `ctrl` 事件。
 *
 * ⚠️ `\x08` / `\x09` / `\x0a` / `\x0d` / `\x1b` **到不了这里**（上面已各自分流）。
 * `\x00` 也不认——Ctrl+@ 在面板里没有意义，报 unknown 比编一个名字好。
 *
 * @param {string} ch
 * @returns {Event}
 */
function ctrlEvent(ch) {
  const c = ch.codePointAt(0) ?? 0;
  // 1..26 → Ctrl+A..Ctrl+Z
  if (c >= 1 && c <= 26) return { type: 'ctrl', key: String.fromCharCode(96 + c) };
  // 28..31 → Ctrl+\ Ctrl+] Ctrl+^ Ctrl+_
  if (c >= 28 && c <= 31) return { type: 'ctrl', key: '\\]^_'[c - 28] };
  return { type: 'unknown', raw: `^${String.fromCharCode(64 + (c % 32))}` };
}

/**
 * 控制字符 → 人看得见的写法。**状态行要显示它**，而 `\x1b` 直接打出来
 * 会把终端搞乱（它本身就是转义开头）。
 * @param {string} s
 * @returns {string}
 */
function vis(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === ESC) out += 'ESC';
    else if (c === 0x7f) out += 'DEL';
    else if (c < 0x20) out += `^${String.fromCharCode(64 + c)}`;
    else out += ch;
  }
  return out;
}
