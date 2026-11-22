// @ts-check
/**
 * 终端输出的小工具：对齐、脱敏（§5）。
 *
 * 只有 cli 层用——core 层不关心怎么显示。
 */
import { refInfo } from '../core/resolve.js';

/**
 * 字符的终端显示宽度：CJK 全角算 2 列。
 *
 * 不做这件事的话，中英混排的表格在终端里会参差不齐——
 * 中文提示语是本项目的默认语言，所以这不是锦上添花。
 * @param {number} c 码点
 */
function isWide(c) {
  return (
    (c >= 0x1100 && c <= 0x115f) || // 韩文字母
    (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) || // CJK 部首 / 假名 / 汉字
    (c >= 0xac00 && c <= 0xd7a3) || // 韩文音节
    (c >= 0xf900 && c <= 0xfaff) || // CJK 兼容汉字
    (c >= 0xfe30 && c <= 0xfe6f) || // CJK 兼容形式
    (c >= 0xff00 && c <= 0xff60) || // 全角 ASCII
    (c >= 0xffe0 && c <= 0xffe6) || // 全角符号
    (c >= 0x20000 && c <= 0x3fffd) // CJK 扩展
  );
}

/**
 * @param {string} s
 * @returns {number}
 */
export function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += isWide(/** @type {number} */ (ch.codePointAt(0))) ? 2 : 1;
  return w;
}

/**
 * 右侧补空格到指定显示宽度（已超宽则原样返回）。
 * @param {string} s
 * @param {number} width
 */
export function padEnd(s, width) {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/**
 * 渲染一组 `[键, 值]` 为对齐的两列文本。
 * @param {[string, string][]} rows
 * @param {{ indent?: string }} [opts]
 */
export function renderRows(rows, { indent = '  ' } = {}) {
  if (rows.length === 0) return '';
  const w = Math.max(...rows.map(([k]) => displayWidth(k)));
  return rows.map(([k, v]) => `${indent}${padEnd(k, w)}  ${v}`).join('\n');
}

// ───────────────────────────── 脱敏（§5）─────────────────────────────

/**
 * 键名里出现这些词 → 值一律打码。
 *
 * **不要只硬编码打码 `ANTHROPIC_AUTH_TOKEN`**——`env` 逃生舱里可能塞了别的密钥
 * （`ANTHROPIC_CUSTOM_HEADERS`、第三方 key…）。
 * @param {string} key
 */
export function isSecretKey(key) {
  return /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(key);
}

/**
 * 打码成「前 3 后 4」。
 * @param {unknown} value
 */
export function maskSecret(value) {
  const s = String(value ?? '');
  if (s === '') return '';
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
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
 * ★ 判据走 `core/resolve.js` 的 `refInfo()`——与 `cmt resolve` 印的是**同一个答案**。
 *   显示侧自己再认一遍 `${...}`，就会出现"`cmt resolve` 说未设置、面板说已设置"。
 *
 * ⚠️ 故意**不复用** `evalEnvRef()`：那个遇到求不出值会**抛错**——那是对的（启动时该拦），
 * 但**显示时不该抛**：用户手改坏了 token 文件时，恰恰只有显示类命令能让他看清坏在哪。
 *
 * @param {unknown} raw 存进 token 文件的那个值（**没经过级联**的原始值）
 * @param {Record<string, string | undefined>} env 用来判断"设了没有"
 * @returns {{ text: string, kind: 'env' | 'literal' | 'empty', envName?: string, envSet?: boolean }}
 */
export function describeSecret(raw, env = {}) {
  const s = String(raw ?? '');
  if (s === '') return { text: '', kind: 'empty' };

  const ref = refInfo(s, env);
  if (ref === null) return { text: maskSecret(s), kind: 'literal' };

  return {
    text: `${s}  ${ref.set ? '（已设置）' : '（⚠ 未设置）'}`,
    kind: 'env',
    envName: ref.name,
    envSet: ref.set,
  };
}

/**
 * 按 §5 的规则给整个环境变量表脱敏。
 * @param {Record<string, string>} env
 * @returns {Record<string, string>}
 */
export function maskEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = isSecretKey(k) ? maskSecret(v) : v;
  }
  return out;
}

/**
 * `models` 解析结果处于三种状态里的哪一种。
 *
 * 这里必须靠 `declared` 而不是 `value.length` 来分辨——因为**「没声明」和「显式声明为空」
 * 长得一模一样**（`value` 都是 `[]`），含义却相反（§2.3 表）：
 *
 *   - `missing`：三层**都没写** `models` → 不知道用哪个模型 → **缺项**，`cmt run` 报错
 *   - `empty`  ：某层**显式写了** `models: []` → "不注入，用 Claude Code 自身默认" → **合法**
 *   - `list`   ：正常的有序优先级列表
 *
 * 早先 `cmt doctor` / `cmt run --print` 用 `value.map(...).join() || '（显式空）'` 兜底，
 * 于是「没声明」也被印成「（显式空）」——偏偏同一屏的下一行就写着「✗ model 不知道用哪个模型」，
 * 一个说合法、一个说缺项，自相矛盾。所以这个判断只留这一处，三处调用方共用。
 *
 * @param {any} field resolve 出来的 `models` 字段（`{value, source, declared}`）
 * @returns {'missing' | 'empty' | 'list'}
 */
export function modelsState(field) {
  if (!field?.declared) return 'missing';
  return field.value?.length ? 'list' : 'empty';
}

/**
 * 表格里的一行渲染（`cmt doctor` / `cmt run --print` 共用）。
 * @param {any} field
 */
export function modelText(field) {
  const state = modelsState(field);
  if (state === 'missing') return '（缺 —— 没有任何一层声明 models）';
  if (state === 'empty') return '（显式空：不注入，用 Claude Code 自身默认）';
  return field.value.map((/** @type {any} */ m) => m.id).join(' → ');
}

/**
 * 四要素表格里「值」那一列（`cmt resolve` / `cmt run --print` / `cmt doctor` 共用）。
 *
 * 三种形态的判断**只留这一处**——三个命令各写一遍必然漂移
 * （`modelText` 的「没声明 / 显式空」就是这么漂移出老 bug 的，见 `modelsState()`）：
 *
 *   - 引用型 `${VAR}`：印**引用本身 + 设置状态**，绝不印值（§2.4）
 *   - 明文 + `mask`：打码（authToken 是密钥）
 *   - 明文 + 不打码：原样（baseUrl —— 端点不是秘密）
 *
 * 空串与 `undefined` 一律印「（缺）」：校验（`isFilled`）也是这么判的，
 * 显示不该比校验宽松。
 *
 * @param {any} field resolve 出来的字段（`{ value, source, ref? }`）
 * @param {{ mask?: boolean }} [opts] `mask` = 明文是否打码；引用型**恒不打码**（印的是引用，不是值）
 * @returns {string}
 */
export function fieldText(field, { mask = false } = {}) {
  const raw = field?.value;
  if (raw === undefined || raw === '') return '（缺）';
  if (field.ref) return `${raw}（${field.ref.set ? '已设置' : '未设置'}）`;
  return mask ? maskSecret(raw) : raw;
}

/**
 * 取值的来源层标签（`cmt resolve` 右栏用）。
 * @param {any} field
 */
export function sourceTag(field) {
  const labels = {
    cli: '命令行',
    project: '项目本地',
    binding: '路径绑定',
    token: 'token 自身',
    defaults: '全局默认',
    builtin: '内置默认',
    cwd: '当前目录',
    // ★ 池挑出来的那一格：来源是 `pool`，但**中文名与 `core/resolve.js` 的
    //   `SOURCE_LABEL` 必须一样**——两处各写一遍是既有事实，那么至少不许写成两个词。
    pool: 'token 池',
    none: '未设置',
  };
  const label = labels[field?.source] ?? field?.source ?? '?';
  return field?.detail ? `← ${label}（${field.detail}）` : `← ${label}`;
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
 * 而 `cmt resolve --json` 的输出是要被脚本解析的。
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
