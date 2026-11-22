// @ts-check
/**
 * ★ **布局内核**（§面板 五）——纯函数，不碰 `process`、不碰 stdin/stdout、不认识终端。
 *
 * 这个文件只回答三个问题：
 *   1. 一行**放不放得下**（`frameWidth` / `fitLine`）
 *   2. 这一屏**怎么切**（`layout`）
 *   3. 光标在窗口里**滚到哪儿**（`scrollTop` / `pageMove`）
 *
 * 真正把内容拼成帧的 `render()` 在同一个文件的下半部分（任务 #36），
 * 但它**必须**让每一行都从 `fitLine()` 走一遍——那是唯一的出口。
 *
 * ─────────────────────────────────────────────────────────────
 * ## ★★ 为什么宽度函数要跟 `format.js` 的 `displayWidth()` 故意不一致
 *
 * | 函数 | 用途 | 歧义字符（`─ │ … ↑`）算几列 |
 * |---|---|---|
 * | `displayWidth()` | 内容对齐（表格） | 1 |
 * | `frameWidth()` | **这行放不放得下** | **2，永远不低估** |
 *
 * 代价不对称，所以规则不对称：
 *
 * - 低估 1 列 = 终端折行 = **整屏错位**（而且每帧重犯，全量重绘不自愈）
 * - 高估 1 列 = 行尾多一个空格，而装配时行尾本来就靠 `[K` 擦掉 = **零代价**
 *
 * ## ★ 结构字符一律 ASCII，一根横线都不画
 *
 * `U+2500–U+257F`（制表符）是 UAX #11 的 **Ambiguous**，而本机 WT 1.24
 * **没有** `ambiguousUnicodeWidth` 设置（1.25 才加）——我们没法让用户去关掉它。
 * 所以结构靠**空行 + 缩进 + 反显**表达，边框只用 `|`（ASCII）。
 * ⇒ ASCII 是"它本来就不会错"，`frameWidth` 是"我们算错了也不会烂屏"，**两层防御，理由不同**。
 *
 * 箭头 `↑↓` 是 Ambiguous 但只出现在**页脚**，有 `fitLine` 兜着。
 * **结构字符不许歧义，内容字符可以。**
 * ─────────────────────────────────────────────────────────────
 */

/** 面板低于这个尺寸就不画了（§面板 五）。三个数一起构成 too-small 条件。 */
export const MIN_COLS = 40;
/** @see MIN_COLS */
export const MIN_ROWS = 8;
/** 正文至少要留的行数。`rows >= 8` 时恒满足，留着是防有人调小 `MIN_ROWS`。 */
export const MIN_BODY_H = 3;

/**
 * ★★ **72 这个数是页脚定的，不是栏宽定的。**
 *
 * 页脚提示串加边距必须能一行放下（`footerWidth() <= TWO_PANE_MIN_COLS`），
 * 否则两栏模式下的页脚会被 `fitLine` 截掉尾巴——用户就看不见 `q 退出` 了。
 * **改提示串就得回头核这个常量**，`render.test.js` 有一条守护测试钉着这层耦合。
 */
export const TWO_PANE_MIN_COLS = 72;

/** 左栏宽度 = `clamp(cols * LEFT_RATIO, LEFT_MIN, LEFT_MAX)`。上下限防止极端尺寸下栏宽失控。 */
export const LEFT_RATIO = 0.34;
/** @see LEFT_RATIO */
export const LEFT_MIN = 20;
/** @see LEFT_RATIO */
export const LEFT_MAX = 40;

/** 页脚左侧留白。两栏模式下页脚是整屏一行，不跟左栏对齐。 */
export const FOOTER_MARGIN = 2;

/**
 * 页脚提示串。**它是 chrome 不是内容**——所以常量放这儿，
 * 好让"它跟 `TWO_PANE_MIN_COLS` 的耦合"能在同一个文件里被测试钉住。
 *
 * ★ **每一屏一句**，因为"`Enter` 启动"在向导里是错的（那里 `Enter` 是"下一步"）。
 * 提示串说错话比没有提示更糟：用户会照着做，然后得到意料之外的结果。
 * ⚠️ 新增一屏就得给一句提示，**而且每一句都要能一行放下**（`FOOTER_HINTS` 全表有守护测试）。
 */
export const FOOTER_HINT = '↑↓ 选择 · Enter 启动 · n 新建 · r 刷新 · q 退出';

/** @type {Record<string, string>} 屏 → 页脚提示。键与 `CHROME` 同一套。 */
export const FOOTER_HINTS = {
  list: FOOTER_HINT,
  'wizard:1': '输入路径 · ↑↓ 选子目录 · Tab 补全 · Enter 下一步 · Esc 返回',
  'wizard:2': '↑↓ 选择身份 · Enter 下一步 · Esc 返回',
  'wizard:3': '空格 勾选 · / 过滤 · r 重试 · m 手敲 · s 跳过 · Enter 下一步',
  'wizard:4': 'Enter 确认写入 · Esc 返回 · Ctrl+C 退出',
};

/** 页脚提示串的占宽（含边距）。**别让它超过 `TWO_PANE_MIN_COLS`**，见那条注释。 */
export function footerWidth(hint = FOOTER_HINT) {
  return FOOTER_MARGIN + frameWidth(hint);
}

/** 截断时的省略号。它是 Ambiguous（`frameWidth` 里算 2 列），所以留位时要按 2 留。 */
const ELLIPSIS = '…';
const ELLIPSIS_W = 2;

/** 转义字符。写成常量免得正文里到处是裸的 `\x1b`（看不见，最容易看错）。 */
const ESC = '\u001b';

/** 反显 / 复位。**故意不从 `format.js` 引**——那会让 `ui/` 依赖 `cli/format.js`，
 * 而 `format.js` 不在"逐字一致"的那四个文件里，两边的同名文件已经分叉了。 */
const RESET = '\u001b[0m';

// ───────────────────────────── 宽度 ─────────────────────────────

/**
 * 一个码点的**保守**宽度：`frameWidth` 专用。
 *
 * 与 `format.js` 的 `codePointWidth()` 的差别只有一条：**Ambiguous 算 2**。
 * 另外这里**没有零宽分支**——组合记号、零宽空格在本函数里算 1。
 * 那是故意的：算 1 是"可能多算"，算 0 是"可能少算"，而少算会折行。
 * （我们自己在帧里不发组合记号，所以这条的代价是零。）
 *
 * @param {number} cp
 * @returns {number}
 */
function codePointWidth(cp) {
  if (cp < 0x80) return 1; // 快路径：ASCII 既不宽也不歧义
  if (inRanges(cp, WIDE)) return 2;
  if (inRanges(cp, AMBIGUOUS)) return 2;
  return 1;
}

/**
 * ★ 宽字符表（East Asian Wide / Fullwidth）。**与 `format.js` 那张同源**，
 * 两边不一致会让"表格里的中文"和"面板里的中文"算出不同宽度。
 *
 * @type {[number, number][]} 闭区间对，**必须按 lo 升序**（`inRanges` 用二分）
 */
const WIDE = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0x303e], // CJK 部首 / 标点
  [0x3041, 0x33ff], // 假名 / CJK 兼容
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xa000, 0xa4cf], // 彝文
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0xfe30, 0xfe6f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角形式
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji（多数终端按 2 列画）
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK 扩展 B 及以上
];

/**
 * ★ 歧义字符表（UAX #11 Ambiguous）——**只收我们会遇到的那些块**。
 *
 * 表不全时的方向是安全的：漏掉一个 Ambiguous = 少算 1 列 = 可能折行，
 * 而**我们自己只往帧里放 ASCII 结构字符**（见文件头），符号只有页脚那几个。
 * 所以这张表覆盖到"我们可能发的符号 + 用户标签里常见的标点"就够了。
 * **宁可多列，不要漏列**：多列一两个码点最多让某行早断一个字。
 *
 * @type {[number, number][]} 闭区间对，**必须按 lo 升序**
 */
const AMBIGUOUS = [
  [0x00a1, 0x00a1], [0x00a4, 0x00a4], [0x00a7, 0x00a8], [0x00aa, 0x00aa],
  [0x00ad, 0x00ae], [0x00b0, 0x00b4], [0x00b6, 0x00ba], [0x00bc, 0x00bf],
  [0x00c6, 0x00c6], [0x00d0, 0x00d0], [0x00d7, 0x00d8], [0x00de, 0x00e1],
  [0x00e6, 0x00e6], [0x00e8, 0x00ea], [0x00ec, 0x00ed], [0x00f0, 0x00f0],
  [0x00f2, 0x00f3], [0x00f7, 0x00fa], [0x00fc, 0x00fc], [0x00fe, 0x00fe],
  [0x2010, 0x2010], [0x2013, 0x2016], [0x2018, 0x2019], [0x201c, 0x201d],
  [0x2020, 0x2022], [0x2024, 0x2027], [0x2030, 0x2030], [0x2032, 0x2033],
  [0x2035, 0x2035], [0x203b, 0x203b], [0x203e, 0x203e],
  [0x2074, 0x2074], [0x207f, 0x207f], [0x2081, 0x2084], [0x20ac, 0x20ac],
  [0x2103, 0x2103], [0x2105, 0x2105], [0x2109, 0x2109], [0x2113, 0x2113],
  [0x2116, 0x2116], [0x2121, 0x2122], [0x2126, 0x2126], [0x212b, 0x212b],
  [0x2153, 0x2154], [0x215b, 0x215e], [0x2160, 0x216b], [0x2170, 0x2179],
  [0x2190, 0x2199], // ★ 我们的 ↑↓ 在这儿
  [0x21b8, 0x21b9], [0x21d2, 0x21d2], [0x21d4, 0x21d4], [0x21e7, 0x21e7],
  [0x2200, 0x2200], [0x2202, 0x2203], [0x2207, 0x2208], [0x220b, 0x220b],
  [0x220f, 0x220f], [0x2211, 0x2211], [0x2215, 0x2215], [0x221a, 0x221a],
  [0x221d, 0x2220], [0x2223, 0x2223], [0x2225, 0x2225], [0x2227, 0x222c],
  [0x222e, 0x222e], [0x2234, 0x2237], [0x223c, 0x223d], [0x2248, 0x2248],
  [0x224c, 0x224c], [0x2252, 0x2252], [0x2260, 0x2261], [0x2264, 0x2267],
  [0x226a, 0x226b], [0x226e, 0x226f], [0x2282, 0x2283], [0x2286, 0x2287],
  [0x2295, 0x2295], [0x2299, 0x2299], [0x22a5, 0x22a5], [0x22bf, 0x22bf],
  [0x22da, 0x22db], [0x2312, 0x2312],
  [0x2460, 0x24e9], [0x24eb, 0x254b],
  [0x2550, 0x2573], // ★ 制表符——**我们一根都不发**，但用户粘进来的可能有
  [0x2580, 0x258f], [0x2592, 0x2595], [0x25a0, 0x25a1], [0x25a3, 0x25a9],
  [0x25b2, 0x25b3], [0x25b6, 0x25b8], [0x25bc, 0x25bd], [0x25c0, 0x25c1],
  // ☝ 25B8（`▸`，右栏那个"当前模型"标记）在 UAX #11 里其实是 **Neutral**，
  //    标准 CJK 终端按 1 列画。这里**故意算 2**——「宁可多列」的方向永远是安全的，
  //    而少算一列就要折行烂整屏。**我们自己的标记符号一律按 Ambiguous 处理。**
  [0x25c6, 0x25c8], [0x25cb, 0x25cb], [0x25ce, 0x25d1], [0x25e2, 0x25e5],
  [0x25ef, 0x25ef], [0x2605, 0x2606], [0x2609, 0x2609], [0x260e, 0x260f],
  [0x2614, 0x2615], [0x261c, 0x261c], [0x261e, 0x261e], [0x2640, 0x2640],
  [0x2642, 0x2642], [0x2660, 0x2661], [0x2663, 0x2665], [0x2667, 0x266a],
  [0x266c, 0x266d], [0x266f, 0x266f], [0x269e, 0x269f], [0x26be, 0x26bf],
  [0x26c4, 0x26c6], [0x26cd, 0x26cd], [0x26e2, 0x26e2], [0x26e4, 0x26e7],
  [0x26f6, 0x26f6], [0x26fd, 0x26fd],
  [0x2700, 0x2700], [0x2702, 0x2702], [0x2705, 0x2705], [0x2708, 0x2709],
  [0x270c, 0x270d], [0x270f, 0x270f], [0x2712, 0x2714], // 含 2713 `✓`（同 25B8，故意多算）
  [0x2716, 0x2716], [0x271d, 0x271d], [0x2721, 0x2721], [0x272a, 0x272a],
  [0x272f, 0x272f], [0x2735, 0x2736], [0x273b, 0x273d], [0x2744, 0x2744],
  [0x2747, 0x2747], [0x274b, 0x274b], [0x274f, 0x2752], [0x2758, 0x2758],
  [0x275b, 0x2760], [0x2761, 0x2761], [0x2763, 0x2764], [0x2768, 0x2775],
  [0x2776, 0x2793], [0x27a1, 0x27a1], [0x27bf, 0x27bf],
  [0x2b55, 0x2b59],
  [0x3248, 0x324f], [0x3251, 0x325f], [0x327e, 0x327e], [0x32b1, 0x32bf],
  [0xe000, 0xf8ff], // 私用区（图标字体常落这儿）
  [0xfe00, 0xfe0f], // 变体选择符——按 2 算是多算，但方向安全
  [0xfffd, 0xfffd],
];

/**
 * 码点落在哪一段里。**二分**——一帧几千个字符，线性扫 170 段是白扔的。
 * @param {number} cp
 * @param {[number, number][]} ranges 按 lo 升序
 * @returns {boolean}
 */
function inRanges(cp, ranges) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * `str[i]` 处是不是一个 ANSI 序列？是就返回它的长度，不是返回 0。
 *
 * ⚠️ **半截序列返回 0**（那个 `ESC` 按 1 列算）——保守方向，见文件头。
 * 上色是整行包裹（前缀 + 后缀），所以正常路径上不会有半截。
 *
 * @param {string} str
 * @param {number} i
 * @returns {number}
 */
function ansiLen(str, i) {
  if (str.charCodeAt(i) !== 0x1b) return 0;
  const kind = str.charCodeAt(i + 1);

  if (kind === 0x5b) {
    // CSI：`ESC [ 参数/中间字节 终结字节`
    for (let j = i + 2; j < str.length; j++) {
      const c = str.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) return j - i + 1;
      if (!((c >= 0x30 && c <= 0x3f) || (c >= 0x20 && c <= 0x2f))) return 0;
    }
    return 0;
  }

  if (kind === 0x5d) {
    // OSC：BEL 或 ST（`ESC \`）收尾
    for (let j = i + 2; j < str.length; j++) {
      const c = str.charCodeAt(j);
      if (c === 0x07) return j - i + 1;
      if (c === 0x1b && str.charCodeAt(j + 1) === 0x5c) return j - i + 2;
    }
    return 0;
  }

  return 0;
}

/**
 * ★ **这一行放不放得下**——保守宽度，ANSI 不计。
 *
 * @param {unknown} s
 * @returns {number}
 */
export function frameWidth(s) {
  const str = String(s ?? '');
  let w = 0;
  for (let i = 0; i < str.length; ) {
    const a = ansiLen(str, i);
    if (a > 0) {
      i += a;
      continue;
    }
    const cp = str.codePointAt(i) ?? 0;
    w += codePointWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

/**
 * ★★ **唯一的守门人**（§面板 五）。`render()` 拼出来的每一行都要从这儿过。
 *
 * 放得下就原样返回；放不下就截到 `cols - 2` 再补 `…`（`…` 是 Ambiguous，
 * 按 2 列留位——这就是 `format.js` 的 `truncateW()` 那个潜在 bug 的修法，
 * 表格里看不出来，**满宽的面板里会立刻炸**）。
 *
 * ★ **只在码点边界上切**：宽字符不会被切成半个（那会让终端画一个替代字形，
 * 宽度算 1 还是 2 全看终端，比折行还难查）。
 *
 * ★ **行尾空格顺手去掉**：装配侧靠 `[K` 擦尾巴，这里去掉是为了让返回值能直接拼。
 *
 * @param {unknown} s
 * @param {number} cols
 * @returns {string}
 */
export function fitLine(s, cols) {
  const str = String(s ?? '');
  const limit = Math.max(0, Math.floor(cols));

  if (frameWidth(str) <= limit) return trimTail(str);
  if (limit < ELLIPSIS_W) return '';

  const room = limit - ELLIPSIS_W;
  let out = '';
  let w = 0;
  for (let i = 0; i < str.length; ) {
    const a = ansiLen(str, i);
    if (a > 0) {
      out += str.slice(i, i + a);
      i += a;
      continue;
    }
    const cp = str.codePointAt(i) ?? 0;
    const size = cp > 0xffff ? 2 : 1;
    const cw = codePointWidth(cp);
    if (w + cw > room) break;
    out += str.slice(i, i + size);
    w += cw;
    i += size;
  }
  // `RESET` 挡在被截断的内容与省略号之间：内容如果带着颜色，省略号不该继承它。
  // ⚠️ 内容里**根本没有转义序列**时不发——否则 `fitLine('中', 2)` 会变成 `RESET + …`，
  //    多出 4 个字节的噪音，而且让"截断后的字符串长什么样"变得难断言。
  const head = trimTail(out);
  return head === '' || !head.includes(ESC) ? `${head}${ELLIPSIS}` : `${head}${RESET}${ELLIPSIS}`;
}

/**
 * 按**帧宽度**右侧补空格（`padEndW` 的保守版）。两栏拼装时左栏要靠它对齐分隔符。
 * @param {unknown} s
 * @param {number} width
 * @returns {string}
 */
export function padEndFrame(s, width) {
  const str = String(s ?? '');
  const pad = width - frameWidth(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

/** @param {string} s */
function trimTail(s) {
  return s.replace(/[ \t]+$/, '');
}

// ───────────────────────────── 版面 ─────────────────────────────

/**
 * @typedef {object} Layout
 * @property {'too-small'|'single'|'two'} tier
 * @property {number} cols
 * @property {number} rows
 * @property {number} titleRow   标题行行号（1-based，与终端 `CUP` 同一套）
 * @property {number} bodyTop    正文首行行号
 * @property {number} bodyH      正文行数
 * @property {number} footerTop  页脚首行行号
 * @property {number} ftr        页脚占的行数（= `footerLines.length`）
 * @property {string[]} footerLines 页脚内容（不含左边距）。**帧必须正好画这么多行**
 * @property {number} left       左栏列宽（单栏时 = cols）
 * @property {number} sep        栏间分隔列数（单栏 0、两栏 1）
 * @property {number} right      右栏列宽（单栏 0）
 */

/**
 * ★ 这一屏怎么切（§面板 五）。
 *
 * 行号算术（1-based）：`1 标题 / 2 空行 / 3..2+bodyH 正文 / 其后页脚`，
 * 守恒式 **`2 + bodyH + ftr === rows`**（有单测钉着，扫尺寸）。
 *
 * 三级退化：
 *
 * | 档 | 条件 | 表现 |
 * |---|---|---|
 * | `too-small` | `cols < 40` 或 `rows < 8` 或 `bodyH < 3` | 正中一行提示 |
 * | `single` | `cols < 72` | 只画列表；页脚**最多** 2 行 |
 * | `two` | `cols >= 72` | 左列表 / 1 列分隔 / 右详情 |
 *
 * ★ **页脚的行数由 `splitFooter()` 现算，不写死**：`ftr = footerLines.length`。
 * 写死成"单栏 2 行、两栏 1 行"的话，71 列下页脚其实一行就装得下，
 * 于是帧少画一行——**而少画一行就是上一帧的最后一行留在屏幕上**（全量重绘不自愈）。
 * 行数守恒式要成立，`ftr` 就必须来自"页脚真正有几行"。
 *
 * ⚠️ `too-small` 档**不遵守守恒式**——整屏只有一行提示，`bodyH`/`ftr` 都是 0。
 * 测试扫守恒式时要跳过这一档。
 *
 * @param {{ cols?: number, rows?: number }} size
 * @param {string} [hint] 页脚提示串。**只有一屏一句这个理由**——不给就按主屏算
 * @returns {Layout}
 */
export function layout(size, hint = FOOTER_HINT) {
  const cols = Math.max(0, Math.floor(size.cols ?? 0));
  const rows = Math.max(0, Math.floor(size.rows ?? 0));

  if (cols < MIN_COLS || rows < MIN_ROWS) return tooSmall(cols, rows);

  const tier = cols < TWO_PANE_MIN_COLS ? 'single' : 'two';
  const footerLines = splitFooter(cols, hint);
  const ftr = footerLines.length;
  const bodyH = rows - 2 - ftr;

  // `rows >= 8` 时恒不成立（8-2-2=4 >= 3），留着是防有人调小 `MIN_ROWS`
  if (bodyH < MIN_BODY_H) return tooSmall(cols, rows);

  const left = tier === 'two' ? clamp(Math.round(cols * LEFT_RATIO), LEFT_MIN, LEFT_MAX) : cols;
  const sep = tier === 'two' ? 1 : 0;

  return {
    tier,
    cols,
    rows,
    titleRow: 1,
    bodyTop: 3,
    bodyH,
    footerTop: 3 + bodyH,
    ftr,
    footerLines,
    left,
    sep,
    right: tier === 'two' ? cols - left - sep : 0,
  };
}

/** @param {number} cols @param {number} rows @returns {Layout} */
function tooSmall(cols, rows) {
  return {
    tier: 'too-small',
    cols,
    rows,
    titleRow: 0,
    bodyTop: 0,
    bodyH: 0,
    footerTop: 0,
    ftr: 0,
    footerLines: [],
    left: 0,
    sep: 0,
    right: 0,
  };
}

/**
 * too-small 档那一行提示。放在这儿而不是 `render()` 里：
 * **它的数字就是 `MIN_COLS`/`MIN_ROWS`**，两处各拼一遍迟早对不上。
 *
 * @param {{ cols?: number, rows?: number }} size
 * @returns {string}
 */
export function tooSmallHint(size) {
  const cols = Math.max(0, Math.floor(size.cols ?? 0));
  const rows = Math.max(0, Math.floor(size.rows ?? 0));
  return `终端太小（当前 ${cols}×${rows}，至少 ${MIN_COLS}×${MIN_ROWS}）`;
}

/**
 * 把页脚提示串切成 **1~2 行**，每行 `<= cols - FOOTER_MARGIN`。
 *
 * 窄屏（`cols` 小）时提示串一行放不下，而**直接 `fitLine` 会把尾巴截掉，
 * 用户就看不见 `q 退出` 了**——所以按 ` · ` 分段贪心装，最后一行实在装不下
 * 才让 `fitLine` 去截。
 *
 * ★ **`layout()` 用它算 `ftr`**：页脚真有几行，正文就让出几行。
 * 写死行数会让帧少画一行，而少画一行 = 上一帧的尾巴留在屏幕上。
 *
 * @param {number} cols
 * @param {string} [hint] 页脚提示串（默认主屏那句）
 * @returns {string[]} 1 或 2 行（不含左边距）——**这正是 `layout().ftr` 的取值**
 */
export function splitFooter(cols, hint = FOOTER_HINT) {
  const limit = Math.max(1, Math.floor(cols) - FOOTER_MARGIN);
  const parts = hint.split(' · ');
  if (frameWidth(hint) <= limit) return [hint];

  const lines = [];
  let cur = '';
  for (const p of parts) {
    const cand = cur === '' ? p : `${cur} · ${p}`;
    if (cur !== '' && frameWidth(cand) > limit) {
      lines.push(cur);
      cur = p;
    } else {
      cur = cand;
    }
  }
  if (cur !== '') lines.push(cur);

  if (lines.length <= 2) return lines;
  // 两行还装不下（极窄的 cols）：前一行整段留，后一行拼起来交给 fitLine 截
  return [lines[0], fitLine(lines.slice(1).join(' · '), limit)];
}

// ───────────────────────────── 滚动 ─────────────────────────────

/**
 * ★ 边缘滚动（§面板 五）：光标撞到窗口边才动 `top`，不做"光标永远居中"
 * （那样每按一次整列都动，用户失去位置锚点）。
 *
 * 做成**纯函数**的全部意义是：光标可见性可以被穷举测试
 * （`len × h × cursor` 三重循环），而那正是"光标跑出窗口"这类 bug 的藏身处。
 *
 * @param {{ top?: number, len?: number, h?: number, cursor?: number }} a
 * @returns {number} 新的 `top`（0-based）
 */
export function scrollTop(a) {
  const len = Math.max(0, Math.floor(a.len ?? 0));
  const h = Math.max(0, Math.floor(a.h ?? 0));
  const cursor = clamp(Math.floor(a.cursor ?? 0), 0, Math.max(0, len - 1));
  let top = Math.floor(a.top ?? 0);

  if (len <= h || h === 0) return 0;

  if (cursor < top) top = cursor;
  else if (cursor >= top + h) top = cursor - h + 1;

  return clamp(top, 0, len - h);
}

/**
 * ★ `PgUp` / `PgDn`：**必须显式滚 `top`**（§面板 五）。
 *
 * 只挪光标再让 `scrollTop()` 收尾是不够的：光标在窗口顶部时按 `PgDn`，
 * `scrollTop` 会认为"光标还在窗口里"而不滚——用户按了翻页却只看见光标下移，
 * 那正是"静默地什么都不做"。
 *
 * @param {{ top?: number, len?: number, h?: number, cursor?: number, dir?: number }} a
 *   `dir`：`+1` = `PgDn`，`-1` = `PgUp`
 * @returns {{ top: number, cursor: number }}
 */
export function pageMove(a) {
  const len = Math.max(0, Math.floor(a.len ?? 0));
  const h = Math.max(1, Math.floor(a.h ?? 1));
  const dir = (a.dir ?? 1) < 0 ? -1 : 1;
  const step = dir * h;

  const cursor = clamp(Math.floor(a.cursor ?? 0), 0, Math.max(0, len - 1));
  const top = clamp(Math.floor(a.top ?? 0), 0, Math.max(0, len - h));

  return {
    top: clamp(top + step, 0, Math.max(0, len - h)),
    cursor: clamp(cursor + step, 0, Math.max(0, len - 1)),
  };
}

/** @param {number} n @param {number} lo @param {number} hi */
function clamp(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : n > hi ? hi : n;
}

// ═════════════════════════ 取景与装配（任务 #36） ═════════════════════════

/**
 * 反显 / 加粗。**故意不从 `format.js` 引**（理由同 `RESET`）：
 * 这四个文件要在两个项目之间**逐字一致**，而 `format.js` 不在其中。
 */
const REV = '\u001b[7m';
const BOLD = '\u001b[1m';

/** 光标定位（`CUP`，1-based——与 `layout()` 的行号同一套）。 */
const cup = (/** @type {number} */ r, /** @type {number} */ c) => `\u001b[${r};${c}H`;

/** 擦到行尾（`EL`）。**行尾不补空格，一律 `[K`**（§面板 五）。 */
const EL = '\u001b[K';

/** 清屏 + 回原点。**只在进屏那一次发**——唯一的例外是 too-small 档，见 `render()`。 */
const CLEAR = '\u001b[2J\u001b[H';

/**
 * 各屏被标题占掉的行数。**`listHeight()` 与各屏的取景函数共用这一张表**——
 * 分成两处写就是"两处各拼一遍"，而它一旦不一致，表现是"光标能走到看不见的地方"。
 *
 * | 屏 | 占几行 | 是什么 |
 * |---|---|---|
 * | `list` | 0 | 正文全是列表 |
 * | `wizard:1` | 2 | 路径输入框 + 子目录栏标题 |
 * | `wizard:2` | 0 | 正文全是身份列表 |
 * | `wizard:3` | 1 | 模型栏标题 |
 * | `wizard:4` | 0 | 正文全是摘要（没有列表） |
 *
 * @type {Record<string, number>}
 */
const CHROME = { list: 0, 'wizard:1': 2, 'wizard:2': 0, 'wizard:3': 1, 'wizard:4': 0 };

/**
 * 这一屏的键。向导按**步**分屏（第 1 步与第 3 步的正文结构不一样）。
 * @param {any} state
 */
function screenKey(state) {
  return state.screen === 'list' ? 'list' : `wizard:${state.wizard?.step ?? 1}`;
}

/**
 * 该屏的页脚提示串。未知的屏**退回主屏那句**（不会崩，但会显示一句不完全对的提示——
 * 所以新增一屏必须同时补 `FOOTER_HINTS`，测试会替你把宽度也验了）。
 *
 * ★ 导出是给**逐行模式**那个逃生舱用的（§面板 七）：它复用 `renderLines()`
 * 的正文，但**必须把页脚整段切掉**换成自己的提示——面板那句
 * 「↑↓ 选择 · Enter 启动」在逐行模式下是**假话**（那里要敲编号）。
 * 切几行不能靠数：`ftr` 是 `splitFooter()` 按宽度现算的（窄终端会折成 2 行），
 * 所以这里给出**和 `renderLines()` 同一个** `footerHint`，让它算第二遍也只是复用。
 *
 * @param {any} state
 */
export function footerHint(state) {
  return FOOTER_HINTS[screenKey(state)] ?? FOOTER_HINT;
}

/**
 * ★ 该屏的**列表**能显示几行。
 *
 * `app.js` 的滚动算术**必须用它**——自己再数一遍就是"两处各拼一遍"，
 * 而这两处一旦不一致，表现是「光标能走到看不见的地方」：按 ↓ 时光标移出了窗口，
 * `scrollTop` 却认为"还在窗口里"（因为它拿到的是另一个高度）→ 光标在屏幕上消失了。
 *
 * @param {any} state
 * @param {{cols?: number, rows?: number}} size
 * @returns {number} 恒 ≥ 1（`too-small` 档也给 1，免得下游除零/夹到负数）
 */
export function listHeight(state, size) {
  const l = layout(size, footerHint(state));
  if (l.tier === 'too-small') return 1;
  return Math.max(1, l.bodyH - (CHROME[screenKey(state)] ?? 0));
}

/**
 * ★ **面板的入口**：`(state, size) → { frame, cursor }`。
 *
 * `frame` 是**完整的一帧**，已经带好了每行的 `CUP` 与 `[K`，**一次 `write()` 发出去**。
 * 一帧正好 `rows` 行——少一行就是上一帧的尾巴留在屏幕上（§面板 五）。
 *
 * `cursor` 是**真光标**该去的位置（1-based），没有输入框聚焦时是 `null`。
 * 它是 `{frame, cursor}` 而不是一个字符串的全部理由：**输入法候选框锚在光标位置**，
 * 而光标的行列只能由排版的**同一份算术**得出（§TUI-Win · 输入法）。让它算第二遍，
 * 就是"两处各拼一遍、各错一半"的又一次复刻。
 *
 * ⚠️ `too-small` 档**每帧发 `[2J`**，是全项目唯一的例外：那一档整屏只有一行提示，
 * 而 `rows` 在那种尺寸下本来就不可信——清干净比留一屏陈旧内容好，且一行内容没有闪烁可言。
 *
 * @param {any} state
 * @param {{cols?: number, rows?: number}} size
 * @returns {{ frame: string, cursor: {row: number, col: number}|null }}
 */
export function render(state, size) {
  const { lines, cursor, tooSmall } = compose(state, size);

  let frame = tooSmall ? CLEAR : '';
  for (let i = 0; i < lines.length; i++) frame += cup(i + 1, 1) + lines[i] + EL;

  return { frame, cursor: tooSmall ? null : cursor };
}

/**
 * 一帧的**行数组**（已过 `fitLine`，每行 `≤ cols`）。
 *
 * 单独导出的理由是**逐行模式**那个逃生舱（§面板 七）要的就是这个：逐行打印，
 * 不要 `CUP`、不要备用屏。它同时让测试能直接对每一行断言宽度，
 * 而不必把 `frame` 再拆开——**不需要测试专用的后门**。
 *
 * @param {any} state
 * @param {{cols?: number, rows?: number}} size
 * @returns {string[]} `too-small` 档是 1 行，其余正好 `rows` 行
 */
export function renderLines(state, size) {
  return compose(state, size).lines;
}

/**
 * 拼行 + 定光标。**每一行都从 `fitLine()` 出去**——这是唯一的出口（§面板 五）。
 *
 * @param {any} state
 * @param {{cols?: number, rows?: number}} size
 * @returns {{ lines: string[], cursor: {row: number, col: number}|null, tooSmall: boolean }}
 */
function compose(state, size) {
  const l = layout(size, footerHint(state));

  if (l.tier === 'too-small') {
    return { lines: [fitLine(tooSmallHint(size), l.cols)], cursor: null, tooSmall: true };
  }

  const body = screenKey(state) === 'list' ? listBody(state, l) : wizardBody(state, l);

  const lines = [
    titleLine(titleLeft(state), titleRight(state), l.cols),
    '',
    ...exact(body.lines, l.bodyH),
    ...l.footerLines.map((f) => fitLine(' '.repeat(FOOTER_MARGIN) + f, l.cols)),
  ].map((x) => fitLine(x, l.cols));

  return { lines, cursor: body.cursor, tooSmall: false };
}

/**
 * 补/截到**正好** `h` 行。★ 帧的行数守恒靠它——`2 + bodyH + ftr === rows`。
 * @param {string[]} lines @param {number} h
 */
function exact(lines, h) {
  const out = lines.slice(0, h);
  while (out.length < h) out.push('');
  return out;
}

/**
 * 放进正好 `w` 列宽的格子：先截断（放不下补 `…`），再补空格。
 * 反显的选中条要铺满整格，所以**补空格这一步不能省**。
 * @param {string} s @param {number} w
 */
function cell(s, w) {
  return padEndFrame(fitLine(s, w), w);
}

/**
 * 左右两段撑满 `w`：放得下就右对齐，放不下**先截左边**——
 * 右边那半（token 名、路径）是标识符，截了就认不出来了；
 * 左边那半（标签）截了还看得出是什么。
 * @param {string} a @param {string} b @param {number} w
 */
function twoPart(a, b, w) {
  const wa = frameWidth(a);
  const wb = frameWidth(b);
  if (b === '') return fitLine(a, w);
  if (wa + wb + 1 <= w) return a + ' '.repeat(w - wa - wb) + b;

  const rightW = Math.min(wb, Math.max(6, Math.floor(w / 2)));
  const leftW = w - rightW - 1;
  if (leftW < 4) return fitLine(a, w);
  return `${cell(a, leftW)} ${cell(b, rightW)}`;
}

/**
 * 从**右**往左取能放下的部分。输入框放不下时显示尾巴——
 * 光标永远在末尾，**末尾必须在屏幕上**（否则用户看不见自己刚敲的字）。
 * @param {string} s @param {number} cols
 */
function fitTail(s, cols) {
  const str = String(s ?? '');
  const limit = Math.max(0, Math.floor(cols));
  if (frameWidth(str) <= limit) return str;

  const cps = [...str];
  let out = '';
  let w = 0;
  for (let i = cps.length - 1; i >= 0; i--) {
    const cw = codePointWidth(cps[i].codePointAt(0) ?? 0);
    if (w + cw > limit) break;
    out = cps[i] + out;
    w += cw;
  }
  return out;
}

/**
 * 按**帧宽度**折行（不是按字符数——中文一个字两列，按字符数折会溢出一倍）。
 * 最多 `maxLines` 行，末行放不下就交给 `fitLine` 补 `…`。
 * @param {string} s @param {number} cols @param {number} maxLines
 * @returns {string[]}
 */
function wrapLine(s, cols, maxLines) {
  const limit = Math.max(1, Math.floor(cols));
  const str = String(s ?? '');
  if (frameWidth(str) <= limit) return [str];

  /** @type {string[]} */
  const out = [];
  let cur = '';
  let w = 0;
  for (const ch of str) {
    const cw = codePointWidth(ch.codePointAt(0) ?? 0);
    if (w + cw > limit) {
      out.push(cur);
      if (out.length === maxLines) return out;
      cur = '';
      w = 0;
    }
    cur += ch;
    w += cw;
  }
  if (cur !== '') out.push(cur);
  return out.slice(0, maxLines);
}

/**
 * 标题行：左边是"我在哪"，右边是"刚发生了什么"。
 *
 * 右边没话可说时**显示 cwd**——它一直是用户最需要确认的那条信息
 * （"我要在哪开"是面板要回答的问题）。
 * @param {string} left @param {string} right @param {number} cols
 */
function titleLine(left, right, cols) {
  const head = `${BOLD}${left}${RESET}`;
  if (right === '') return head;

  const pad = cols - frameWidth(left) - frameWidth(right);
  if (pad >= 2) return `${head}${' '.repeat(pad)}${right}`;
  return fitLine(`${left} ${right}`, cols);
}

/** @param {any} state */
function titleLeft(state) {
  if (state.screen === 'list') return `${state.data.appName} 面板`;
  const w = state.wizard;
  if (w.edit) return '改模型 · 选择模型';
  return `新建 ${w.step}/4 · ${STEP_NAME[w.step] ?? ''}`;
}

const STEP_NAME = { 1: '目标路径', 2: '身份', 3: '模型', 4: '落点' };

/** @param {any} state */
function titleRight(state) {
  if (state.confirm !== null && state.confirm !== undefined) {
    return `删除「${state.confirm.label}」的绑定？[y/N]`;
  }
  if (state.notice !== '') return state.notice;
  if (state.screen === 'list') return state.data.cwd;

  const w = state.wizard;
  if (w.step === 1) return '目标目录';
  if (w.step === 2) return w.token.chosen === '' ? '选择身份' : w.token.chosen;
  if (w.step === 3) return w.token.chosen;
  return '';
}

// ───────────────────────────── 主屏 ─────────────────────────────

/**
 * 左栏可启动项 / 右栏详情。单栏档只画左栏。
 * @param {any} state @param {Layout} l
 */
function listBody(state, l) {
  const items = state.data.items;
  const cur = state.data.items[state.cursor];
  const right = l.tier === 'two' && cur?.detail ? detailRows(cur.detail, l) : null;
  const top = clamp(Math.floor(state.top ?? 0), 0, Math.max(0, items.length - l.bodyH));

  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < l.bodyH; i++) {
    const it = items[top + i];
    const selected = top + i === state.cursor;
    const w = l.tier === 'two' ? l.left : Math.max(1, l.cols - 1);

    const left = selected
      ? `${REV}${cell(it ? itemText(it, w) : '', w)}${RESET}`
      : cell(it ? itemText(it, w) : '', w);

    lines.push(l.tier === 'two' ? `${left}|${right?.[i] ?? ''}` : left);
  }
  // 主屏没有输入框 ⇒ 没有真光标。`null` 会让驱动侧 `?25l`。
  return { lines, cursor: null };
}

/**
 * 一项在左栏那一行的样子：` 标签 → 身份`。
 *
 * ★★ **宽度必须由调用方传进来**，不许写死。写死一个数（比如 30）的话：
 * 栏比它窄时先按 30 拼好再被 `cell` 截一刀 —— `→ relay-a` 被拦腰砍成 `→…`，
 * **用户就看不出这一项绑的是哪个身份了**（而"我要在哪开、用谁的身份"正是左栏存在的全部理由）；
 * 栏比它宽时右端又贴不到栏边，`→ 身份` 那一列参差不齐。
 *
 * @param {any} it
 * @param {number} w 这一格的总宽（含前导空格）
 */
function itemText(it, w) {
  if (it.kind === 'new') return fitLine(' + 新建…', w);
  return ` ${twoPart(it.label ?? '', it.token ? `→ ${it.token}` : '', Math.max(1, w - 1))}`;
}

/**
 * 右栏：左半边是凭据、右半边是模型。**两个子栏各占一半**。
 * @param {any} d @param {Layout} l
 * @returns {string[]} 正好 `l.bodyH` 行（右半部分，不含左栏与分隔符）
 */
function detailRows(d, l) {
  const inner = l.right;
  const credsW = Math.max(16, Math.floor((inner - 1) / 2));
  const modelsW = Math.max(1, inner - credsW - 1);

  /** @type {string[]} */
  const creds = [
    `authToken: ${d.masked}`,
    `baseUrl:   ${d.baseUrl}`,
    `source:    ${d.source}`,
    `profile:   ${d.profile}`,
  ];
  if (d.provider) creds.push(`provider:  ${d.provider}`);

  // ★ 栏标题报数，不占正文行（§面板 五）。`已选/总数`：总数不知道就只报已选。
  const total = d.catalog > 0 ? `/${d.catalog}` : '';
  /** @type {string[]} */
  const models = [`模型 (${d.models.length}${total})`];
  if (d.models.length === 0) models.push('  (没配)');
  d.models.forEach((id, i) => models.push(`${i === d.active ? '▸' : ' '} ${id}`));

  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < l.bodyH; i++) {
    const a = creds[i] ?? '';
    const b = models[i] ?? '';
    if (a === '' && b === '') {
      out.push('');
      continue;
    }
    out.push(`${cell(a, credsW)}|${fitLine(b, modelsW)}`);
  }
  return out;
}

// ───────────────────────────── 向导 ─────────────────────────────

/** @param {any} state @param {Layout} l */
function wizardBody(state, l) {
  const w = state.wizard;
  switch (w.step) {
    case 1: return step1Body(w, l);
    case 2: return step2Body(state, w, l);
    case 3: return step3Body(w, l);
    default: return step4Body(state, w, l);
  }
}

/**
 * 输入框那一行 + **真光标的位置**。
 *
 * 放不下时显示**尾巴**（`fitTail`）并把光标顶到最右——输入法候选框要跟着光标走，
 * 而光标在末尾，所以末尾必须在屏幕上。
 *
 * @param {string} prefix @param {string} text @param {number} cols @param {number} row
 */
function inputRow(prefix, text, cols, row) {
  const pw = frameWidth(prefix);
  const room = Math.max(1, cols - 1 - pw);
  const tail = fitTail(text, room);
  const line = prefix + tail;
  return { line, cursor: { row, col: Math.min(Math.max(1, cols - 1), frameWidth(line) + 1) } };
}

/** 1/4 目标路径：输入框 + 子目录列表。 */
function step1Body(w, l) {
  const p = w.path;
  const box = inputRow(' 路径: ', p.text, l.cols, l.bodyTop);

  const listH = Math.max(0, l.bodyH - 2);
  const top = clamp(Math.floor(p.dirTop ?? 0), 0, Math.max(0, p.dirs.length - listH));

  /** @type {string[]} */
  const lines = [box.line, ` 子目录 (${p.dirs.length})${p.pending ? '  读取中…' : ''}`];
  for (let i = 0; i < listH; i++) {
    const name = p.dirs[top + i];
    if (name === undefined) {
      lines.push('');
      continue;
    }
    const selected = top + i === p.dirCursor;
    const w1 = Math.max(1, l.cols - 1);
    lines.push(selected ? `${REV}${cell(`   ${name}`, w1)}${RESET}` : cell(`   ${name}`, w1));
  }
  return { lines, cursor: box.cursor };
}

/** 2/4 身份：已有 token 列表 + 「+ 新建 token…」；新建态是两个输入框。 */
function step2Body(state, w, l) {
  const t = w.token;

  if (t.mode === 'new') {
    const nameBox = inputRow(' 名字: ', t.name, l.cols, l.bodyTop);
    // ★ 密钥**只按长度**画掩码——明文一个字节都不进帧。
    //   （渲染层一旦拿到明文，一个调试用的 console.log(frame) 就把它写进回滚缓冲了。）
    const dots = '•'.repeat(Math.min(t.secret.length, 40));
    const secretBox = inputRow(' 密钥: ', dots, l.cols, l.bodyTop + 1);
    const note = `  ${t.secret.length} 字符 · Tab 切换 · Enter 下一步`;

    return {
      lines: [nameBox.line, secretBox.line, fitLine(note, l.cols - 1)],
      cursor: t.field === 'name' ? nameBox.cursor : secretBox.cursor,
    };
  }

  const rows = state.data.tokens;
  const total = rows.length + 1; // 末行是「+ 新建 token…」
  const top = clamp(Math.floor(t.top ?? 0), 0, Math.max(0, total - l.bodyH));

  /** @type {string[]} */
  const lines = [];
  for (let i = 0; i < l.bodyH; i++) {
    const idx = top + i;
    if (idx >= total) {
      lines.push('');
      continue;
    }
    const selected = idx === t.cursor;
    const w1 = Math.max(1, l.cols - 1);
    const text = idx >= rows.length
      ? '  + 新建 token…'
      : `  ${twoPart(rows[idx].name, rows[idx].masked ?? '', w1 - 2)}`;
    lines.push(selected ? `${REV}${cell(text, w1)}${RESET}` : cell(text, w1));
  }
  return { lines, cursor: null };
}

/** 3/4 模型：栏标题 + 勾选列表；拉取失败时是三条出路。 */
function step3Body(w, l) {
  const m = w.models;
  const rows = visibleModels(m);
  const total = m.ids.length + m.checked.filter((id) => !m.ids.includes(id)).length;

  const right = m.filtering ? `过滤: /${m.filter}` : (m.notice || phaseNote(m));
  const head = ` 模型 (${m.checked.length}${total > 0 ? `/${total}` : ''})`;

  /** @type {string[]} */
  const lines = [titleLine(head, right, l.cols)];

  const listH = Math.max(0, l.bodyH - 1);

  if (m.phase === 'fail' && m.ids.length === 0 && !m.manual) {
    // ★ 拉不到是常态，不是异常（§面板 六）——**必须有出路**，卡死在这儿不能接受。
    for (const x of wrapLine(` ${m.error}`, l.cols - 1, Math.max(1, listH - 1))) {
      lines.push(fitLine(x, l.cols - 1));
    }
    lines.push(fitLine(' [r] 重试 · [m] 手敲 id · [s] 跳过', l.cols - 1));
    return { lines, cursor: null };
  }

  if (m.manual) {
    const box = inputRow(' 模型 id: ', m.manualText, l.cols, l.bodyTop + 1);
    lines.push(box.line);
    lines.push(fitLine(' Enter 加入 · Esc 取消', l.cols - 1));
    return { lines, cursor: box.cursor };
  }

  if (m.phase === 'loading' || m.phase === 'idle') {
    lines.push(fitLine(' 拉取中…', l.cols - 1));
    return { lines, cursor: null };
  }

  const top = clamp(Math.floor(m.top ?? 0), 0, Math.max(0, rows.length - listH));
  for (let i = 0; i < listH; i++) {
    const id = rows[top + i];
    if (id === undefined) {
      lines.push('');
      continue;
    }
    const selected = top + i === m.cursor;
    const w1 = Math.max(1, l.cols - 1);
    // `✓` = 已勾选（勾选顺序即优先级），反显 = 光标在哪一行。**两个记号，两种含义。**
    const text = ` ${m.checked.includes(id) ? '✓' : ' '} ${id}`;
    lines.push(selected ? `${REV}${cell(text, w1)}${RESET}` : cell(text, w1));
  }
  return { lines, cursor: null };
}

/** @param {any} m */
function phaseNote(m) {
  if (m.phase === 'fail') return '拉取失败';
  if (m.phase === 'loading') return '拉取中…';
  if (m.ids.length === 0) return '没有可选模型';
  return '';
}

/** 4/4 落点：**写哪儿要说清楚**——两个都写是这一屏存在的全部理由。 */
function step4Body(state, w, l) {
  const models = w.models.checked.length > 0 ? w.models.checked.join(', ') : '(不配)';
  const pairs = w.edit
    ? [['路径', w.target.path], ['身份', w.target.token], ['模型', models]]
    : [
      ['路径', w.path.text],
      ['身份', w.token.chosen],
      ['模型', models],
      ['绑定', '全局 config.json（按路径绑定）'],
      ['项目', `${state.data.projectFile}（项目本地配置）`],
    ];

  const labelW = 6;
  /** @type {string[]} */
  const lines = [];
  for (const [k, v] of pairs) {
    // 值可能很长（路径、模型列表）——折行而不是截断：**这一屏是给用户核对的**
    const parts = wrapLine(v, Math.max(1, l.cols - labelW - 1), 3);
    parts.forEach((p, i) => {
      lines.push(fitLine(` ${cell(i === 0 ? k : '', labelW)}${p}`, l.cols - 1));
    });
  }
  if (w.notice !== '') lines.push('', fitLine(` ${w.notice}`, l.cols - 1));
  return { lines, cursor: null };
}

/**
 * 过滤后的候选。★ **已勾选的排前面**——用户最想看见的是自己选了什么，
 * 而剩下的保持**服务端原序**（服务端顺序是插入序、没有意义，但"替它排序"
 * 是解析层的越权；排序是面板的事，而面板的排序规则只有这一条）。
 *
 * 手敲进来的 id 不在服务端列表里，**也得看得见**——否则用户会以为"没加进去"。
 *
 * ★★ **导出给 `app.js` 用，不许在那边再写一份**：列表有几行是**滚动算术的输入**
 * （`app.js` 要拿它算 `nav` 的长度），画出来几行是**渲染的输出**——
 * 两边各算一遍就是又一次「两处各拼一遍、各错一半」。与 `listHeight()` 同一个道理。
 *
 * @param {any} m
 * @returns {string[]}
 */
export function visibleModels(m) {
  const f = String(m.filter ?? '').toLowerCase();
  const filtered = f === '' ? m.ids : m.ids.filter((/** @type {string} */ id) => id.toLowerCase().includes(f));
  const chosen = filtered.filter((/** @type {string} */ id) => m.checked.includes(id));
  const rest = filtered.filter((/** @type {string} */ id) => !m.checked.includes(id));
  const manual = m.checked.filter((/** @type {string} */ id) => !filtered.includes(id));
  return [...chosen, ...manual, ...rest];
}
