// @ts-check
/**
 * 终端输出：对齐 + 脱敏（§5）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## CJK 宽度：`length` 不是显示宽度
 *
 * 表格里只要有中文，`padEnd()` 就一定会歪——JS 的 `String.length` 数的是
 * **码元**，而终端里一个汉字占**两列**。`'token'` 与 `'令牌'` 都是 5 个码元，
 * 但显示宽度是 5 与 4。
 *
 * 所以对齐必须自己算宽度。这里只做**够用**的近似：把
 * CJK 统一表意文字、全角标点、假名、谚文算 2 列，其余算 1 列。
 * 不追求覆盖全部 Unicode（emoji 变体选择符、组合字符等），
 * 因为本工具的表格里不会出现那些。
 * ─────────────────────────────────────────────────────────────
 *
 * ## 脱敏（§5）：**按键名，不按值的形态**
 *
 * 规则：键名匹配 `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` 的值一律打码。
 *
 * ⚠️ **不要只硬编码 `CXT_TOKEN_*`**——`env` 逃生舱里可能塞了别的密钥
 * （`OPENAI_API_KEY`、`HF_TOKEN`…），只认自己的前缀就会把它们原样打印出来。
 * 反过来也**不要按值打码**（"看起来像 sk- 开头的就打"）：那既会误伤
 * （一个正好叫 `sk-xxx` 的模型名），又漏掉不以此为前缀的中转站 key。
 */

/** 打码时保留的前缀/后缀长度（§5：「前 3 后 4」） */
const KEEP_HEAD = 3;
const KEEP_TAIL = 4;

/** 键名里出现这些词 → 值打码（§5） */
const SECRET_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;

/**
 * @param {string} key
 * @returns {boolean}
 */
export function isSecretKey(key) {
  return SECRET_KEY_RE.test(key);
}

/**
 * 打码一个值：`sk-abcdefghijkl` → `sk-****hijkl`（前 3 后 4）。
 *
 * 太短的值**整个**打成 `****`——"前 3 后 4"对 7 个字符的值等于全露。
 * @param {unknown} value
 * @returns {string}
 */
export function maskValue(value) {
  const s = String(value ?? '');
  if (s === '') return '';
  if (s.length <= KEEP_HEAD + KEEP_TAIL) return '****';
  return `${s.slice(0, KEEP_HEAD)}****${s.slice(-KEEP_TAIL)}`;
}

/**
 * ★ 按**键名**决定打不打码（§5）。
 * @param {string} key
 * @param {unknown} value
 */
export function maskIfSecret(key, value) {
  return isSecretKey(key) ? maskValue(value) : String(value ?? '');
}

/**
 * 打码一个「环境变量表」。返回新对象，不改入参。
 * @param {Record<string, unknown> | null | undefined} env
 * @returns {Record<string, string>}
 */
export function maskEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) out[k] = maskIfSecret(k, v);
  return out;
}

/**
 * ★ 一个**凭证字段**该怎么显示（§2.4 + §5）。
 *
 * 分两种情况，因为它们的"敏感点"不同：
 *
 * | 存的是什么 | 显示 | 为什么 |
 * |-----------|------|--------|
 * | `${ENV_VAR}` 引用 | 原样显示引用串 + 「已设置 / 未设置」 | 引用串是**变量名**，不是密钥；藏着它反而让人查不出"到底要设哪个变量"。而**变量的值**一个字都不打印（§2.4） |
 * | 明文 | 打码成前 3 后 4（§5） | 明文本身就是密钥 |
 *
 * @param {unknown} raw 存进 token 文件的那个值
 * @param {Record<string, string | undefined>} env 用来判断"设了没有"
 * @returns {{ text: string, kind: 'env' | 'literal' | 'empty', envName?: string, envSet?: boolean }}
 */
export function describeSecret(raw, env = {}) {
  const s = String(raw ?? '');
  if (s === '') return { text: '', kind: 'empty' };

  const ref = parseSecretRefLoose(s);
  if (ref === null) return { text: maskValue(s), kind: 'literal' };

  const set = typeof env[ref] === 'string' && env[ref] !== '';
  return {
    text: `${s}  ${set ? '（已设置）' : '（⚠ 未设置）'}`,
    kind: 'env',
    envName: ref,
    envSet: set,
  };
}

/**
 * 认一认"这串是不是整串 `${VAR}` 引用"。
 *
 * ⚠️ **故意不复用 `schema.parseSecretRef`**：那个是**校验器**，遇到
 * `sk-${VAR}` 这种半吊子写法会抛错——那是对的（写入时该拦），但**显示时不该抛**：
 * 用户手改坏了 token 文件，`cxt token show` 恰恰是他唯一能看清坏在哪的工具。
 * 所以这里只做"认得出就标注，认不出就当明文打码"。
 *
 * @param {string} s
 * @returns {string | null} 变量名；不是整串引用 → null
 */
function parseSecretRefLoose(s) {
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(s);
  return m === null ? null : m[1];
}

// ───────────────────────────── 宽度与对齐 ─────────────────────────────

/**
 * 一个码点的显示宽度（0 / 1 / 2）。
 * @param {number} cp 码点
 */
function codePointWidth(cp) {
  // 组合用记号等零宽字符
  if (cp === 0x200B || cp === 0xFEFF) return 0;
  if (cp >= 0x0300 && cp <= 0x036F) return 0;

  return (
    (cp >= 0x1100 && cp <= 0x115F) ||   // 谚文字母
    (cp >= 0x2E80 && cp <= 0x303E) ||   // CJK 部首 / 标点
    (cp >= 0x3041 && cp <= 0x33FF) ||   // 假名 / CJK 兼容
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK 扩展 A
    (cp >= 0x4E00 && cp <= 0x9FFF) ||   // CJK 统一表意文字
    (cp >= 0xA000 && cp <= 0xA4CF) ||   // 彝文
    (cp >= 0xAC00 && cp <= 0xD7A3) ||   // 谚文音节
    (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK 兼容表意文字
    (cp >= 0xFE30 && cp <= 0xFE6F) ||   // CJK 兼容形式
    (cp >= 0xFF00 && cp <= 0xFF60) ||   // 全角形式
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x20000 && cp <= 0x3FFFD)    // CJK 扩展 B 及以上
  ) ? 2 : 1;
}

/**
 * 字符串的**显示宽度**（CJK 算 2 列）。
 * @param {unknown} s
 * @returns {number}
 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += codePointWidth(/** @type {number} */ (ch.codePointAt(0)));
  return w;
}

/**
 * 按**显示宽度**右侧补空格（`String.prototype.padEnd` 的中文安全版）。
 * @param {unknown} s
 * @param {number} width
 */
export function padEndW(s, width) {
  const str = String(s ?? '');
  const pad = width - displayWidth(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

/** @param {unknown} s @param {number} width */
export function padStartW(s, width) {
  const str = String(s ?? '');
  const pad = width - displayWidth(str);
  return pad > 0 ? ' '.repeat(pad) + str : str;
}

/**
 * 截断到显示宽度（超长时末尾用 `…` 顶替）。
 * @param {unknown} s
 * @param {number} max
 */
export function truncateW(s, max) {
  const str = String(s ?? '');
  if (displayWidth(str) <= max) return str;

  let out = '';
  let w = 0;
  for (const ch of str) {
    const cw = codePointWidth(/** @type {number} */ (ch.codePointAt(0)));
    if (w + cw > max - 1) break;   // 留 1 列给省略号
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

// ───────────────────────────── 表格 ─────────────────────────────

/**
 * 渲染一张对齐的表。
 *
 * `rows` 里每格可以是 `string`，或 `{ text, color }`——颜色用 ANSI 码，
 * **不计入宽度**（所以不会把对齐搞歪）。
 *
 * @param {string[]} headers
 * @param {any[][]} rows
 * @param {{ indent?: string, gap?: string }} [opts]
 * @returns {string}
 */
export function table(headers, rows, opts = {}) {
  const indent = opts.indent ?? '  ';
  const gap = opts.gap ?? '  ';

  /** @param {any} cell */
  const textOf = (cell) => (cell != null && typeof cell === 'object' ? String(cell.text ?? '') : String(cell ?? ''));
  /** @param {any} cell */
  const colorOf = (cell) => (cell != null && typeof cell === 'object' ? (cell.color ?? '') : '');

  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => displayWidth(textOf(r[i])))));

  return all
    .map((r, ri) => {
      const line = r
        .map((cell, i) => {
          const painted = padEndW(textOf(cell), widths[i]);
          const color = colorOf(cell);
          return color ? `${color}${painted}${RESET}` : painted;
        })
        .join(gap)
        .replace(/\s+$/, '');
      return `${indent}${line}`;
    })
    .join('\n');
}

// ───────────────────────────── 颜色 ─────────────────────────────

export const RESET = '\u001b[0m';
const DIM = '\u001b[2m';
const RED = '\u001b[31m';
const YELLOW = '\u001b[33m';
const GREEN = '\u001b[32m';
const CYAN = '\u001b[36m';

/**
 * 是否给输出上色。
 *
 * ⚠️ **只在 TTY 上色**：管道里给出去的颜色码会变成垃圾字符，
 * 而 `cxt resolve --json` 的输出是要被脚本解析的。
 * 尊重 `NO_COLOR`（https://no-color.org 的事实标准）。
 * @param {{ isTTY?: boolean, env?: Record<string, string | undefined>, json?: boolean }} o
 */
export function makePainter({ isTTY = false, env = {}, json = false } = {}) {
  const on = isTTY && !json && env.NO_COLOR === undefined && env.TERM !== 'dumb';
  /** @param {string} code */
  const wrap = (code) => (/** @type {string} */ s) => (on ? `${code}${s}${RESET}` : String(s));

  return {
    enabled: on,
    dim: wrap(DIM),
    red: wrap(RED),
    yellow: wrap(YELLOW),
    green: wrap(GREEN),
    cyan: wrap(CYAN),
    bold: wrap('\u001b[1m'),
  };
}

/** @typedef {ReturnType<typeof makePainter>} Painter */

// ───────────────────────────── 小工具 ─────────────────────────────

/**
 * 缩进一个多行块（用来把 hint 挂在主消息下面）。
 * @param {string} text
 * @param {string} [prefix]
 */
export function indentBlock(text, prefix = '  ') {
  return String(text).split('\n').map((l) => (l === '' ? l : prefix + l)).join('\n');
}

/**
 * 把 `{...}` 渲染成一行 `k=v k=v`（环境变量、参数都用它）。
 * @param {Record<string, string>} obj
 */
export function inlinePairs(obj) {
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(' ');
}
