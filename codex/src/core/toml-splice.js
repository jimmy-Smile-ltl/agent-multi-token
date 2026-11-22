// @ts-check
/**
 * ★★ 受管区拼接器（§2.9）——本项目最难的模块。
 *
 * `profiles/<t>/config.toml` 是**双作者文件**：cxt 写"受管区"
 * （顶层 `model` / `model_provider` / `model_catalog_json` + `[model_providers.<id>]`），
 * Codex 写 `[projects.*]` 信任记录，用户还会手写注释与自己的键。
 *
 * ─────────────────────────────────────────────────────────────
 * **为什么是"行级拼接"而不是"TOML 解析 + 重序列化"**（§2.9）：
 *
 * 1. 零依赖铁律下 `node:` 里没有 TOML 库（§4.3）
 * 2. 更致命的是：解析再序列化会**丢掉注释与键序**——对一个双作者文件，
 *    那等于每次 `cxt run` 都毁掉用户和 Codex 写进去的内容。不可接受。
 *
 * 所以这里只做**外科手术**：认出受管的那几行，换掉；其余**逐字节保留**。
 *
 * **四条铁律**（违反即 bug）：
 * 1. 只改受管区的键，其余逐字节保留，**不许"顺手规范化"整个文件**
 * 2. **永不删除 `[projects.*]`**（那是用户的信任决定）
 * 3. **永不删除整个 `config.toml`**（只增改，不删文件）
 * 4. 首次写入前一次性备份（由 `store.js` 做，不在这里——本模块**不碰 fs**）
 *
 * **纯函数**：输入 `{existingText, managedValues}`，输出 `{newText, report}`（§4.2）。
 * 不碰 fs，所以可以用字符串字面量做穷举单测（§6.3）。
 * ─────────────────────────────────────────────────────────────
 */
import { CxtError, IntegrityError } from './errors.js';
import { toTomlPathValue, toTomlValue } from './toml-value.js';

// ───────────────────────────── 受管键清单（写死，别扩大，§2.9）─────────────────────────────

/** 受管的**顶层**键。顺序即写出去的顺序。 */
export const MANAGED_TOP_LEVEL_KEYS = /** @type {const} */ ([
  'model',
  'model_provider',
  'model_catalog_json',
]);

/**
 * 受管顶层键里"值是一条路径"的那些。
 *
 * 必须走 `toTomlPathValue()`（转正斜杠）而不是通用的 `toTomlValue()`——
 * 反斜杠在 TOML 基本字符串里是转义符，`model_catalog_json = "D:\x"` 会直接
 * 解析失败（§7.5：DeepSeek 脚本显式做过这一步）。
 *
 * 这张表能硬编码，是因为本模块**已经**硬编码了受管键清单（§2.9 要求写死）。
 */
const PATH_VALUED_KEYS = new Set(['model_catalog_json']);

/** provider section 的父表名。 */
const PROVIDER_TABLE = 'model_providers';

/**
 * cxt 生成的 provider id 前缀（`deriveProviderId`，§2.1）。
 *
 * 用它来认出"这条 `[model_providers.*]` 是我们以前写的"——即便 token 换了
 * providerId，陈旧的那条也要清掉，否则两条 provider 定义会同时留在文件里。
 * 用户自己的 provider 不带这个前缀，**绝不碰**。
 */
const PROVIDER_ID_PREFIX = 'cxt-';

/** 受管的 provider section 键（§2.9 清单，写死）。 */
export const MANAGED_PROVIDER_KEYS = /** @type {const} */ ([
  'name', 'base_url', 'env_key', 'wire_api',
  'http_headers', 'env_http_headers', 'requires_openai_auth',
  'request_max_retries', 'stream_max_retries', 'stream_idle_timeout_ms',
]);

// ───────────────────────────── 行扫描 ─────────────────────────────

/**
 * 多行值扫描状态。
 * @typedef {{ depth: number, quote: string | null, multi: string | null }} ScanState
 */

/** @returns {ScanState} */
function newScanState() {
  return { depth: 0, quote: null, multi: null };
}

/** 这个值写完了吗？（`depth>0` = 还有没闭合的 `[`/`{`） */
function isComplete(st) {
  return st.depth <= 0 && st.quote === null && st.multi === null;
}

/**
 * 扫一行，推进状态。**必须能正确处理**：
 * 单行基本串（含 `\"` 转义）、单行字面串、多行串（`"""` / `'''`）、
 * 数组与内联表的嵌套、以及 `#` 注释。
 *
 * 只要有一处漏判，"多行数组值消费"就会提前收工，把数组的剩余行当成普通行——
 * 那会**写坏用户的文件**。所以这里宁可保守（认不出就当作没结束）。
 * @param {string} line
 * @param {ScanState} st
 */
function scanValue(line, st) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (st.multi) {
      if (line.startsWith(st.multi, i)) { i += st.multi.length - 1; st.multi = null; continue; }
      // 多行基本串里 `\` 仍然转义（多行字面串不转义）
      if (st.multi === '"""' && ch === '\\') i++;
      continue;
    }
    if (st.quote) {
      if (st.quote === '"' && ch === '\\') { i++; continue; }
      if (ch === st.quote) st.quote = null;
      continue;
    }
    if (ch === '#') return;                                  // 注释吃掉本行剩余
    if (line.startsWith('"""', i)) { st.multi = '"""'; i += 2; continue; }
    if (line.startsWith("'''", i)) { st.multi = "'''"; i += 2; continue; }
    if (ch === '"' || ch === "'") { st.quote = ch; continue; }
    if (ch === '[' || ch === '{') { st.depth++; continue; }
    if (ch === ']' || ch === '}') { st.depth--; continue; }
  }
}

/**
 * 从 `start` 行开始，返回这条**键值对**的结束行号（含）。
 *
 * 单行值就返回 `start`；多行数组 / 多行内联表 / 多行字符串会一直吃到闭合。
 * 导出的理由：`trust.js` 也要在同一套规则下找 section 边界，
 * 两处各写一份扫描器必然漂移（§2.9 的"多行值消费"是写坏文件的高发点）。
 *
 * @param {string[]} lines
 * @param {number} start
 * @returns {number} 结束行号（含）；未闭合则返回最后一行
 */
export function findValueEnd(lines, start) {
  const st = newScanState();
  scanValue(lines[start] ?? '', st);
  let i = start;
  while (!isComplete(st) && i + 1 < lines.length) {
    i++;
    scanValue(lines[i], st);
  }
  return i;
}

// ───────────────────────────── 行内语法 ─────────────────────────────

/**
 * 把 `a.b.'c d'` 拆成 `['a', 'b', 'c d']`。认不出（引号未闭合等）返回 null。
 * @param {string} s
 * @returns {string[] | null}
 */
function parseDottedKey(s) {
  /** @type {string[]} */
  const parts = [];
  let i = 0;

  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;

    const q = s[i];
    if (q === '"' || q === "'") {
      let j = i + 1;
      let buf = '';
      let closed = false;
      while (j < s.length) {
        const c = s[j];
        if (q === '"' && c === '\\') { buf += unescapeSimple(s[j + 1]); j += 2; continue; }
        if (c === q) { closed = true; j++; break; }
        buf += c;
        j++;
      }
      if (!closed) return null;
      parts.push(buf);
      i = j;
    } else {
      const j = i;
      while (i < s.length && s[i] !== '.' && s[i] !== ' ' && s[i] !== '\t') i++;
      if (i === j) return null;
      parts.push(s.slice(j, i));
    }

    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    if (s[i] !== '.') return null;
    i++;
  }

  return parts.length > 0 ? parts : null;
}

/** 基本字符串里的转义——只处理我们比较时会遇到的几种，其余原样保留。 */
function unescapeSimple(c) {
  switch (c) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    default: return c ?? '';
  }
}

/**
 * 找 section header 的收尾方括号——**必须跳过引号里的内容**。
 *
 * `[projects.'D:\a]b']` 是合法 TOML，路径里就能带 `]`。
 * 用 `indexOf(']')` 会在这里截断，把 section 名解析错。
 * @param {string} s
 * @param {number} from
 * @param {boolean} isArray
 */
function findHeaderClose(s, from, isArray) {
  const close = isArray ? ']]' : ']';
  let quote = null;
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (s.startsWith(close, i)) return i;
  }
  return -1;
}

/**
 * 解析 section header 行（**已 trim**）。不是 header 就返回 null。
 *
 * 认得出 `[a.b]`、`[[a.b]]`、`[projects.'D:\a b']`；
 * 尾部只允许空白与注释（`[a] # 说明`）。
 * @param {string} trimmed
 * @returns {{ name: string[], isArray: boolean } | null}
 */
export function parseSectionHeader(trimmed) {
  if (!trimmed.startsWith('[')) return null;
  const isArray = trimmed.startsWith('[[');
  const open = isArray ? 2 : 1;
  const end = findHeaderClose(trimmed, open, isArray);
  if (end < 0) return null;

  const name = parseDottedKey(trimmed.slice(open, end));
  if (!name) return null;

  const rest = trimmed.slice(end + (isArray ? 2 : 1)).trim();
  if (rest !== '' && !rest.startsWith('#')) return null;

  return { name, isArray };
}

/** 找顶层（不在引号里的）`=`。 */
function findTopLevelEquals(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (quote === '"' && ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '=') return i;
  }
  return -1;
}

/**
 * 解析键值行的**键**部分（**已 trim**）。不是键值行就返回 null。
 *
 * 只回答"这行的键是谁"——值是什么、有几行，由 `findValueEnd()` 回答。
 * @param {string} trimmed
 * @returns {{ key: string, segments: string[] } | null}
 */
export function parseKeyValue(trimmed) {
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('[')) return null;
  const eq = findTopLevelEquals(trimmed);
  if (eq < 0) return null;
  const segments = parseDottedKey(trimmed.slice(0, eq));
  if (!segments) return null;
  return { key: segments.join('.'), segments };
}

// ───────────────────────── 整文件结构分析 ─────────────────────────

/**
 * 扫一遍全文件，标出每行"是不是真正的 section header"以及"属于哪个 section"。
 *
 * 一次扫描解决三件事：多行值内部的 `[` 不会被误判成 header、
 * 顶层键的判定（`sectionOf[i] === null`）、受管 section 的范围。
 *
 * ⚠️ **导出给 `trust.js` 用**（不是给外部 API 用）：它要在同一套规则下
 * 找 `[projects.'…']` 的边界。两处各写一份扫描器必然漂移，
 * 而漂移的后果是"把用户的多行值当成 section header"——直接写坏双作者文件。
 * @param {string[]} lines
 */
export function analyze(lines) {
  const isHeader = new Array(lines.length).fill(false);
  /** @type {(string[] | null)[]} */
  const sectionOf = new Array(lines.length).fill(null);

  /** @type {string[] | null} */
  let current = null;
  /** @type {ScanState | null} */
  let pending = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ① 还在上一行的多行值里——整行都属于那个值，不可能是 header
    if (pending) {
      scanValue(line, pending);
      if (isComplete(pending)) pending = null;
      sectionOf[i] = current;
      continue;
    }

    const trimmed = line.trim();
    const header = parseSectionHeader(trimmed);
    if (header) {
      isHeader[i] = true;
      current = header.name;
      sectionOf[i] = current;
      continue;
    }

    sectionOf[i] = current;

    // ② 这行开了个跨行的值吗？
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      const st = newScanState();
      scanValue(line, st);
      if (!isComplete(st)) pending = st;
    }
  }

  return { isHeader, sectionOf };
}

// ───────────────────────────── 输入归一 ─────────────────────────────

/**
 * BOM / CRLF / 末尾换行的归一（§7.14①、§2.9 步骤 6）。
 *
 * - **BOM 必须剥掉**：Codex 的 TOML 解析器不接受带 BOM 的配置，
 *   带 BOM = 整个配置加载失败，且是**静默的全盘失败**（§7.14①）。
 * - **CRLF → LF**：§2.9 步骤 6 要求输出 LF。PowerShell 5.1 写出来的是 CRLF，
 *   不归一的话文件会变成混合换行。逐行剥尾部 `\r` 后，"其余内容逐字节保留"
 *   在 LF 语义下依然成立。
 * - **末尾换行**：原文件有就保留、没有就不加（逐字节保留原则）；
 *   全新文件则以换行收尾。
 *
 * ⚠️ **导出给 `trust.js` 用**：BOM / CRLF 的归一必须两边一致，
 * 否则"写信任记录"会成为唯一一条会往文件里塞 CRLF 的路径。
 * @param {string} input
 */
export function prepareText(input) {
  let text = input == null ? '' : String(input);

  const hadBom = text.charCodeAt(0) === 0xfeff;
  if (hadBom) text = text.slice(1);

  const normalizedEol = text.includes('\r');

  /** 全空白（含空串）→ 当成全新文件，不把那些空行写进产物 */
  const created = text.trim() === '';

  let lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const trailingNewline = created ? true : text.endsWith('\n');
  if (trailingNewline && lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (created) lines = [];

  return { lines, created, hadBom, normalizedEol, trailingNewline };
}

/**
 * 行数组 → 文本。**`prepareText()` 的逆运算**，必须成对使用：
 * `prepareText` 剥掉的（BOM / CRLF / 末尾换行）在这里决定要不要加回去。
 *
 * 单独成函数是因为 `trust.js` 也要走同一套收尾——两处各写一遍
 * `join('\n') + (trailing ? '\n' : '')` 迟早有一处忘了末尾换行。
 * @param {string[]} lines
 * @param {boolean} trailingNewline
 */
export function finishText(lines, trailingNewline) {
  return lines.length === 0 ? '' : lines.join('\n') + (trailingNewline ? '\n' : '');
}

/**
 * 校验调用方给的受管值。**受管区不许扩大**（§2.9）——
 * 多出来的键一律拒绝，而不是"顺手也写进去"。
 * @param {any} mv
 */
function normalizeManagedValues(mv) {
  /** @type {Record<string, unknown>} */
  const topLevel = {};
  for (const [k, v] of Object.entries(mv?.topLevel ?? {})) {
    if (v === undefined) continue;
    if (!MANAGED_TOP_LEVEL_KEYS.includes(/** @type {any} */ (k))) {
      throw new CxtError(`"${k}" 不在受管键清单里，拒绝写入`, {
        hint: `受管顶层键只有：${MANAGED_TOP_LEVEL_KEYS.join(' / ')}（§2.9）。`
          + '要把新键纳入受管区，得先改契约',
      });
    }
    topLevel[k] = v;
  }

  /** @type {{ id: string, values: Record<string, unknown> } | null} */
  let provider = null;
  if (mv?.provider != null) {
    const id = String(mv.provider.id ?? '');
    if (id === '') throw new CxtError('受管 provider 缺 id');
    if (id.includes('.') || /[\s"'\][{}]/.test(id)) {
      throw new CxtError(`provider id 不能含 "." 或空白 / 引号：${JSON.stringify(id)}`, {
        hint: '它会成为 TOML 表名 [model_providers.<id>]，含 "." 会变成嵌套表',
      });
    }

    /** @type {Record<string, unknown>} */
    const values = {};
    for (const [k, v] of Object.entries(mv.provider.values ?? {})) {
      if (v === undefined) continue;
      if (!MANAGED_PROVIDER_KEYS.includes(/** @type {any} */ (k))) {
        throw new CxtError(`provider 的 "${k}" 不在受管键清单里，拒绝写入`, {
          hint: `受管 provider 键只有：${MANAGED_PROVIDER_KEYS.join(' / ')}（§2.9）`,
        });
      }
      values[k] = v;
    }
    provider = { id, values };
  }

  // ★ `model_provider` 与它的 provider section **必须成对且同名**（§7.8 真机实测）。
  //   Codex 遇到"引用一个不存在的 provider"时不是忽略、不是警告，而是
  //   **拒绝加载整个 config.toml**（`✗ config ... entity not found`）。
  //   也就是说：写出半份受管区 = 当场把用户的配置搞成不可加载，比不写还糟。
  //   所以这里宁可拒绝，也不产出半份。
  if (topLevel.model_provider != null) {
    if (provider === null) {
      throw new IntegrityError(
        `受管值给了 model_provider = ${JSON.stringify(topLevel.model_provider)}，却没有 provider 定义`,
        {
          hint: 'Codex 会因"引用了不存在的 provider"拒绝加载整个 config.toml（§7.8 实测）。'
            + '要么补上 managedValues.provider，要么把 model_provider 一起去掉',
        },
      );
    }
    if (provider.id !== topLevel.model_provider) {
      throw new IntegrityError(
        `model_provider = ${JSON.stringify(topLevel.model_provider)} `
        + `与 provider section 的 id ${JSON.stringify(provider.id)} 对不上`,
        {
          hint: '两者必须同名——否则同样是"引用一个不存在的 provider"，'
            + 'Codex 会拒绝加载整个 config.toml（§7.8 实测）',
        },
      );
    }
  }

  return { topLevel, provider };
}

// ───────────────────────────── 渲染 ─────────────────────────────

/** @param {string} key @param {unknown} value */
function renderTopLevel(key, value) {
  const rendered = PATH_VALUED_KEYS.has(key)
    ? toTomlPathValue(String(value))
    : toTomlValue(value);
  return `${key} = ${rendered}`;
}

/**
 * 渲染受管 provider section。
 * @param {{ id: string, values: Record<string, unknown> }} provider
 * @returns {string[]}
 */
function renderProviderSection(provider) {
  const head = /^[A-Za-z0-9_-]+$/.test(provider.id) ? provider.id : toTomlValue(provider.id);
  /** @type {string[]} */
  const lines = [`[${PROVIDER_TABLE}.${head}]`];
  for (const k of MANAGED_PROVIDER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(provider.values, k)) {
      lines.push(`${k} = ${toTomlValue(provider.values[k])}`);
    }
  }
  return lines;
}

/**
 * 在 `at` 处插入一段，并在需要时补空行分隔。
 * 前后都不留双空行——重复同步时产物必须**稳定**（幂等），否则每次 run 都在改文件。
 * @param {string[]} lines
 * @param {number} at
 * @param {string[]} block
 */
function spliceBlock(lines, at, block) {
  if (block.length === 0) return lines;
  const out = lines.slice();
  const before = out[at - 1];
  const after = out[at];
  /** @type {string[]} */
  const insert = [];
  if (before !== undefined && before.trim() !== '') insert.push('');
  insert.push(...block);
  if (after !== undefined && after.trim() !== '') insert.push('');
  out.splice(at, 0, ...insert);
  return out;
}

// ───────────────────────────── 主函数 ─────────────────────────────

/**
 * @typedef {object} ManagedValues
 * @property {Record<string, unknown>} [topLevel]
 *   `model` / `model_provider` / `model_catalog_json`。**没声明的键就不写**，
 *   且文件里存在的陈旧同名键会被删掉（受管区由 cxt 决定，不由残留决定）。
 * @property {{ id: string, values: Record<string, unknown> } | null} [provider]
 *   当前 token 的 provider 定义。给 `null` = 本轮不该有 provider section。
 */

/**
 * @typedef {object} SpliceReport
 * @property {boolean} changed      `newText !== existingText`
 * @property {boolean} created      原文本为空 → 这是全新文件
 * @property {boolean} hadBom       原文件带 BOM（已剥掉）→ `doctor` 要报（§7.14①）
 * @property {boolean} normalizedEol 原文件含 CR（已归一为 LF）
 * @property {string[]} insertedTopLevel 新插入的顶层键
 * @property {string[]} replacedTopLevel 就地替换的顶层键
 * @property {string[]} removedTopLevel  从文件里删掉的陈旧受管键
 * @property {string | null} wroteProvider 本轮写入的 provider id
 * @property {string | null} replacedProvider 就地重写的 provider id
 * @property {string[]} removedProviders 清掉的陈旧 provider section
 */

/**
 * 把受管区同步进 `config.toml` 的文本。
 *
 * **幂等**：同一份 `managedValues` 连跑两次，第二次的 `report.changed` 必为 `false`。
 * 这是 `cxt doctor` 判断"身份区已漂移"的依据（§2.9）——doctor 拿同样的值重算一遍，
 * `changed === true` 就是漂移。
 *
 * @param {{ existingText?: string, managedValues?: ManagedValues }} input
 * @returns {{ newText: string, report: SpliceReport }}
 */
export function spliceManagedRegion({ existingText = '', managedValues = {} } = {}) {
  const managed = normalizeManagedValues(managedValues);
  const prep = prepareText(existingText);
  const lines = prep.lines;
  const { isHeader, sectionOf } = analyze(lines);

  const managedProviderId = managed.provider?.id ?? null;

  /** @type {string[]} */
  const out = [];
  /** 第一个 section header 的落点——缺失的顶层键要插在它**之前**（§2.9 步骤 5） */
  let insertIndex = -1;
  /** 受管 provider section 的落点（就地重写用） */
  let providerSlot = -1;

  /** @type {string[]} */
  const insertedTopLevel = [];
  /** @type {string[]} */
  const replacedTopLevel = [];
  /** @type {string[]} */
  const removedTopLevel = [];
  /** @type {string[]} */
  const removedProviders = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string | null} */
  let replacedProvider = null;

  for (let i = 0; i < lines.length; i++) {
    // ── section header ──
    if (isHeader[i]) {
      if (insertIndex < 0) insertIndex = out.length;
      const name = sectionOf[i] ?? [];

      if (name.length === 2 && name[0] === PROVIDER_TABLE
        && (name[1] === managedProviderId || name[1].startsWith(PROVIDER_ID_PREFIX))) {
        // `[[model_providers.cxt-a]]` 是数组表，与我们要写的 `[...]` 同名会撞键
        if (parseSectionHeader(lines[i].trim())?.isArray) {
          throw new IntegrityError(
            `config.toml 里有数组表 [[${PROVIDER_TABLE}.${name[1]}]]，与受管的 provider section 撞名`,
            { hint: `手工把它删掉，或改成 [${PROVIDER_TABLE}.${name[1]}]` },
          );
        }
        // 整段跳过（header 行到下一个 header 之前），稍后重写
        if (providerSlot < 0) providerSlot = out.length;
        if (name[1] === managedProviderId) replacedProvider = name[1];
        else removedProviders.push(name[1]);

        let j = i + 1;
        while (j < isHeader.length && !isHeader[j]) j++;
        i = j - 1;
        continue;
      }

      out.push(lines[i]);
      continue;
    }

    // ── 顶层键 ──
    if (sectionOf[i] === null) {
      const kv = parseKeyValue(lines[i].trim());
      if (kv && kv.segments.length === 1 && MANAGED_TOP_LEVEL_KEYS.includes(/** @type {any} */ (kv.key))) {
        if (seen.has(kv.key)) {
          throw new IntegrityError(
            `config.toml 里受管键 "${kv.key}" 出现了两次（第 ${i + 1} 行是第二次）`,
            {
              hint: '受管键必须唯一——静默取第一个会让"实际生效的值"取决于文件顺序。'
                + '手工删掉多余的那条再运行',
            },
          );
        }
        seen.add(kv.key);

        const end = findValueEnd(lines, i);
        if (Object.prototype.hasOwnProperty.call(managed.topLevel, kv.key)) {
          out.push(renderTopLevel(kv.key, managed.topLevel[kv.key]));
          replacedTopLevel.push(kv.key);
        } else {
          // 本轮不该有这个键 → 连同它的（可能多行的）值一起删掉
          removedTopLevel.push(kv.key);
        }
        i = end;
        continue;
      }
    }

    out.push(lines[i]);
  }

  if (insertIndex < 0) insertIndex = out.length;

  // ── 先补 provider section，再补顶层键 ──
  // 顺序是刻意的：providerSlot >= insertIndex 恒成立，先插后面的不会挪动前面的下标；
  // 而两者相等时（provider section 就是第一个 section），顶层键会落在它**之前**，
  // 正好是我们想要的版式。
  let final = out;
  const providerLines = managed.provider ? renderProviderSection(managed.provider) : [];
  if (providerLines.length > 0) {
    final = spliceBlock(final, providerSlot >= 0 ? providerSlot : insertIndex, providerLines);
  }

  /** @type {string[]} */
  const missing = [];
  for (const k of MANAGED_TOP_LEVEL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(managed.topLevel, k) && !seen.has(k)) {
      missing.push(renderTopLevel(k, managed.topLevel[k]));
      insertedTopLevel.push(k);
    }
  }
  if (missing.length > 0) final = spliceBlock(final, insertIndex, missing);

  const newText = finishText(final, prep.trailingNewline);

  return {
    newText,
    report: {
      changed: newText !== String(existingText ?? ''),
      created: prep.created,
      hadBom: prep.hadBom,
      normalizedEol: prep.normalizedEol,
      insertedTopLevel,
      replacedTopLevel,
      removedTopLevel,
      wroteProvider: managed.provider?.id ?? null,
      replacedProvider,
      removedProviders,
    },
  };
}
