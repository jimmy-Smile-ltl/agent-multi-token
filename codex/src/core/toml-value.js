// @ts-check
/**
 * TOML 值序列化（§2.11 三·1）。
 *
 * `codex -c key=value` 的 value 是 **TOML**，不是 JSON、也不是 shell 字符串。
 * 本文件是把它拼出来的**唯一**地方。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ **本文件的核心是"两条相反的路径规则"**（§2.11 三·1）：
 *
 * | 用途 | 例 | 分隔符 | 引号 |
 * |------|----|-------|------|
 * | TOML **值**里的路径 | `model_catalog_json = "D:/x/m.json"` | **正斜杠** | 基本字符串 |
 * | TOML **表键**里的路径 | `[projects.'D:\work\a']` | **必须反斜杠** | 字面字符串 |
 *
 * 为什么相反：
 * - **值**：反斜杠在 TOML 里是转义符，且路径/URL 的比较语义对分隔符不敏感。
 *   统一转正斜杠，读起来就是一条路径，永远不会撞上转义。
 * - **表键**：Codex 拿它跟 cwd 做**字符串**比较（§7.3 真机实测）。
 *   正斜杠写法**不报错、但静默不匹配**——信任永远不生效，且没有任何提示。
 *
 * ⇒ 所以这里**刻意**是三个函数、不是两个"可配置"的函数：
 *   `toTomlValue`（通用）/ `toTomlPathValue`（值路径，转正斜杠）
 *   / `toTomlPathKey`（表键路径，**保留**反斜杠）。
 *   **绝不要"统一"它们，也绝不要共用一个路径归一化函数**（§6.3 有反向断言守着）。
 * ─────────────────────────────────────────────────────────────
 */
import { CxtError } from './errors.js';

// ───────────────────────────── 引号选择 ─────────────────────────────

/** 单行字面字符串 `'...'` 不能含单引号，也不能含换行；其余控制字符同样不行。 */
// eslint-disable-next-line no-control-regex
const LITERAL_FORBIDDEN_RE = /['\u0000-\u0008\u000A-\u001F\u007F]/;

/**
 * 这个串能不能安全地写成 TOML **字面字符串**（单引号）？
 *
 * 能，就用它——字面字符串**不做任何转义**，所以：
 * - Windows 路径里的 `\` 原样穿过，不会撞上转义规则（§7.14 ②）
 * - 用户把它从 `--print` 里复制进 PowerShell 也不会被 PS 5.1 撕碎（§7.14 末尾）
 * @param {string} s
 */
function canBeLiteral(s) {
  return !LITERAL_FORBIDDEN_RE.test(s);
}

/**
 * 转义成 TOML **基本字符串**的内容部分（不含两侧引号）。
 * @param {string} s
 */
function escapeBasic(s) {
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\b': out += '\\b'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\f': out += '\\f'; break;
      case '\r': out += '\\r'; break;
      default: {
        const c = ch.codePointAt(0) ?? 0;
        if (c < 0x20 || c === 0x7f) {
          out += `\\u${c.toString(16).toUpperCase().padStart(4, '0')}`;
        } else {
          out += ch;
        }
      }
    }
  }
  return out;
}

/**
 * 字符串 → TOML 字面量，**优先字面字符串**。
 *
 * 为什么优先单引号而不是双引号：字面字符串零转义，所以
 * "写进去的字节"与"读出来的字符串"永远相等，且手工复制到 shell 里也安全。
 * 含 `'` 或控制字符时才退化为转义基本字符串。
 * @param {string} s
 */
function quoteString(s) {
  return canBeLiteral(s) ? `'${s}'` : `"${escapeBasic(s)}"`;
}

// ───────────────────────────── 通用值 ─────────────────────────────

/**
 * 把 JS 值序列化成 TOML 值字面量。
 *
 * 支持的 JS 类型：`string` / `boolean` / `number` / 数组 / 纯对象。
 * **没有 `null`**——TOML 里不存在空值，遇到直接报错而不是悄悄写个 `""`。
 *
 * @param {unknown} v
 * @returns {string}
 */
export function toTomlValue(v) {
  // 先拦 null / undefined：这是最常见的误用（把"这个字段没设"当成一个值传进来）。
  // 放在最前面，所以数组元素、内联表字段里的 null 也会在这里被拦下。
  if (v === null || v === undefined) {
    throw new CxtError(`TOML 没有 null / undefined，不能把 ${describe(v)} 写成值`, {
      hint: '要表达"没有"就整条键不写——不要拿空串顶替，那会变成一个真值',
    });
  }

  if (typeof v === 'string') return quoteString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';

  if (typeof v === 'number') {
    if (!Number.isFinite(v)) {
      throw new CxtError(`TOML 不支持 ${String(v)}`, {
        hint: 'TOML 只有整数与浮点数，没有 NaN / Infinity',
      });
    }
    // String(n) 不会产出前导零；1e21 这类会写成 "1e+21"，是合法的 TOML 浮点
    return String(v);
  }

  if (Array.isArray(v)) {
    return `[${v.map((x) => toTomlValue(x)).join(', ')}]`;
  }

  if (typeof v === 'object') {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (v));
    if (entries.length === 0) return '{}';
    const body = entries
      .map(([k, x]) => `${quoteKey(k)} = ${toTomlValue(x)}`)
      .join(', ');
    // 内联表：TOML 1.0 **不允许尾逗号**，所以最后一项后面直接跟 " }"
    return `{ ${body} }`;
  }

  throw new CxtError(`无法把 ${describe(v)} 写成 TOML 值`, {
    hint: 'TOML 只有字符串 / 布尔 / 数字 / 数组 / 内联表，没有函数、Symbol 与 BigInt',
  });
}

/**
 * 内联表的键。裸键（`[A-Za-z0-9_-]+`）不加引号，其余走 `quoteString`。
 * @param {string} k
 */
function quoteKey(k) {
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
  return quoteString(k);
}

/**
 * @param {unknown} v
 */
function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  return typeof v;
}

// ───────────────────────── 路径：作为「值」（§2.11 三·1）─────────────────────────

/**
 * 路径 → TOML **值**。★ 与 `toTomlPathKey` 规则**相反**：这里把 `\` 转成 `/`。
 *
 * 用在 `model_catalog_json` 这类"值本身是一条路径"的受管键上。
 * DeepSeek 的官方脚本显式做过这件事，注释写着 "backslash is an escape character in TOML"
 * ——那正是本函数的理由（§2.11 三·1 表末行）。
 *
 * ⚠️ 只在 `\` 出现时才改写。POSIX 路径本来就没有反斜杠，
 * 所以这条路在 Linux/macOS 上是恒等变换，不会动到 `/home/a\b` 这种
 * 病态但合法的文件名……不，它**会**动到。这是**有意**的取舍：
 * 一个含字面反斜杠的 POSIX 文件名写进 TOML 配置里本就近乎不可用，
 * 而"Windows 路径必须转正斜杠"是每次都会遇到的真问题。
 *
 * @param {string} p
 */
export function toTomlPathValue(p) {
  const s = String(p);
  // 转完就没有反斜杠了，所以用基本字符串——读起来就是一条路径
  return `"${escapeBasic(s.replace(/\\/g, '/'))}"`;
}

// ──────────────────────── 路径：作为「表键」（§7.3 铁律）────────────────────────

/**
 * 路径 → TOML **表键**（`[projects.<这里>]` 里的那一段，**含引号**）。
 *
 * ★ 与 `toTomlPathValue` 规则**相反**：这里**保留反斜杠**、**不转正斜杠**。
 * 理由（§7.3 真机实测表）：Codex 拿这个键跟 cwd 做**字符串**比较——
 *
 * | 写法 | 是否匹配 `C:\Users\Me\proj` |
 * |------|:---:|
 * | `'C:\Users\Me\proj'`（字面字符串 + 反斜杠） | ✅ |
 * | `"C:/Users/Me/proj"`（正斜杠） | ❌ **静默不匹配** |
 *
 * 写错了**不报错**，只是"信任没生效"。所以这个函数**一个字节都不改**：
 * 不转分隔符、不做 `path.resolve()`、不做 NFC 归一（§7.3 铁律 4）。
 *
 * 分隔符的平台差异（Windows 要 `\`、POSIX 要 `/`）由 `trust.js` 在**调用前**处理，
 * 那里才有 `platform`。**别把平台判断塞进来**——那会让这个函数
 * 在"值路径"和"表键路径"之外又多出一种行为，正是 §6.3 反向断言要防的事。
 *
 * 引号：优先字面字符串 `'...'`（免转义，§7.3 铁律 2）；
 * 路径含单引号时退化为转义基本字符串（`\` → `\\`）。
 *
 * @param {string} p
 * @returns {string} 含引号的 TOML 键，例：`'D:\work\a'`
 */
export function toTomlPathKey(p) {
  return quoteString(String(p));
}
