// @ts-check
/**
 * ★★ 信任表读写（§7.3 / §2.10）——`[projects.'<path>'] trust_level = "..."`。
 *
 * 信任记录决定**项目级 `.codex/config.toml` 生不生效**（沙箱 / 审批 / hooks / rules 整层）。
 * 它住在**用户级** config.toml 里，所以随 `CODEX_HOME` 隔离 ⇒
 * **同一个项目，token A 信任过、token B 没信任过，切到 B 会再问一次**（§2.10）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 🔴 本模块存在的唯一理由：路径匹配是**字符串比较**
 *
 * Codex 拿 `[projects.<这里>]` 的键去跟 `cwd` **比字符串**。不是文件系统语义比较。
 * 于是下面每一条都**不报错、只是静默不生效**（§7.3 实测表）：
 *
 * | 写法 | 匹配 `C:\Users\Me\proj` |
 * |------|:---:|
 * | `'C:\Users\Me\proj'`（字面字符串 + 反斜杠） | ✅ |
 * | `"C:\\Users\\Me\\proj"`（转义基本字符串） | ✅ |
 * | `"C:/Users/Me/proj"`（**正斜杠**） | ❌ |
 * | `'c:\users\me\proj'`（全小写） | ✅ 大小写不敏感 |
 * | `'C:\Users\Me'`（父目录） | ❌ **不继承** |
 * | `'C:\Users\Me\proj\'`（尾部分隔符） | ❌ |
 * | `'\\?\C:\Users\Me\proj'`（UNC 前缀） | ❌ |
 *
 * ## ⚠️ 所以**不能**用 `bindings.js` 的 `normalizeForCompare()` 来做这里的比较
 *
 * 那个函数会把 `\` 折成 `/`（那是绑定的正确语义：`D:\work` 与 `D:/work` 是同一个目录）。
 * 但在这里，折叠会让**手工写坏的** `[projects."C:/x"]` 被我们判成"已存在且已信任"——
 * 于是 `cxt trust` 再也不会去修它，用户永远看到"我明明信任过了"。
 *
 * ⇒ 本模块的比较**比它更严**：
 * - **输入侧**规整成规范写形（win32 用反斜杠）——这是 §7.3 铁律 1，必须做
 * - **条目侧逐字节**比（只折叠大小写 + darwin 的 NFC），**不做**分隔符/尾斜杠归一
 * - 两者只在归一后才相等的，**不是命中**，而是"**写法错，Codex 认不出**"——
 *   单独报出来（`nearMisses`），由 `spliceTrust` 就地修好它
 *
 * ## 与 §7.3 铁律 4 的关系（别误读成"不许归一"）
 *
 * 铁律 4 禁的是 `path.resolve()` / `realpath`——**解析符号链接、把相对路径变绝对**，
 * 那会让"用户写的路径"与"实际匹配的路径"不再是同一个东西。
 * 本模块只做**词法**规整：分隔符、`.`/`..`、重复分隔符、尾部斜杠。
 * 这些形态**永远不可能**出现在 `cwd` 字符串里，所以把它们归到 cwd 的形状上是对的。
 *
 * ## 三态，不是二态（§7.3）
 *
 * `trusted` / 显式 `untrusted`（resolved 成 `UnlessTrusted`）/ **从未标记**（`OnRequest`）。
 * 后两者**语义不同**，`doctor` 必须分开报，否则用户会困惑于"我明明没标记过它"。
 *
 * ⚠️ **纯函数**（§4.2）：输入文本，输出文本。不碰 fs（那是 `store.js` 的事）。
 */

import { posix, win32 } from 'node:path';
import { CxtError, IntegrityError } from './errors.js';
import { toTomlPathKey, toTomlValue } from './toml-value.js';
import {
  analyze, findValueEnd, finishText, parseKeyValue, parseSectionHeader, prepareText,
} from './toml-splice.js';

// ───────────────────────────── 常量 ─────────────────────────────

/** `trust_level` 的合法值。**只有两个**（§7.3 铁律 5：这张表只有这一个字段）。 */
export const TRUST_LEVELS = /** @type {const} */ (['trusted', 'untrusted']);

/** 承载信任记录的表名。 */
const PROJECTS_TABLE = 'projects';

/** 这张表里唯一允许的键（§7.3 铁律 5：`struct ProjectTrustConfigToml with 1 element`）。 */
const TRUST_KEY = 'trust_level';

// ───────────────────────────── 平台规则 ─────────────────────────────

/**
 * 比较用的折叠。**只折叠 Codex 自己也折叠的东西**：
 * Windows / macOS 大小写不敏感；Linux 严格按字节。
 *
 * darwin 额外做 NFC——理由与 `bindings.js` 同（APFS 以 NFD 存盘，
 * 用户从 Finder 拿到的是 NFC，字节不同、肉眼相同）。
 *
 * ⚠️ **§7.3 那张规则表只在 Windows 上实测过**，macOS 的 NFC 这一条是**推断**，
 * 已列入"每次 Codex 升级要手工回归"的清单。未知平台按最保守的一套（大小写敏感）。
 *
 * @param {string} s
 * @param {NodeJS.Platform | string} platform
 */
function foldForTrust(s, platform) {
  if (platform === 'win32' || platform === 'darwin') {
    const lower = String(s).toLowerCase();
    return platform === 'darwin' ? lower.normalize('NFC') : lower;
  }
  return String(s);
}

/**
 * 用户给的路径 → **写进文件的规范形态**。
 *
 * 做四件事（都是 §7.3 规则表直接要求的）：
 * 1. 剥 `\\?\` / `\\?\UNC\` 前缀——带着它**永不匹配**
 * 2. 分隔符转成目标平台的原生形态——**这是本工具最容易写错、且完全静默的一步**
 * 3. 词法规整（`.` / `..` / 重复分隔符）——`cwd` 里不会出现这些
 * 4. 去尾部分隔符（根除外）——尾部分隔符**不匹配**
 *
 * **不做** `resolve()` / `realpath()`（§7.3 铁律 4）。
 *
 * @param {string} p 用户给的路径（必须绝对）
 * @param {NodeJS.Platform | string} platform
 * @returns {string}
 */
export function canonicalizeTrustPath(p, platform) {
  let s = String(p ?? '');
  if (s.trim() === '') {
    throw new CxtError('信任路径不能为空', {
      hint: "写当前目录请用它的绝对路径，例：cxt trust 'D:\\work\\client-a'",
    });
  }

  if (platform === 'win32') {
    // `\\?\UNC\server\share` → `\\server\share`；`\\?\C:\x` → `C:\x`
    if (s.startsWith('\\\\?\\UNC\\')) s = `\\\\${s.slice(8)}`;
    else if (s.startsWith('\\\\?\\')) s = s.slice(4);
    s = win32.normalize(s);
    s = stripTrailingSeparator(s, '\\');
  } else {
    s = posix.normalize(s);
    s = stripTrailingSeparator(s, '/');
  }

  const absolute = platform === 'win32' ? win32.isAbsolute(s) : posix.isAbsolute(s);
  if (!absolute) {
    throw new CxtError(`信任路径必须是绝对路径：${JSON.stringify(p)}`, {
      hint: 'Codex 拿这个键跟当前工作目录做**字符串**比较，相对路径永远匹配不上。'
        + '要写当前目录就把它的绝对路径传进来',
    });
  }

  return s;
}

/**
 * 去尾部分隔符，但**保留根**（`/` 不能变成空串、`C:\` 不能变成 `C:`）。
 * @param {string} s
 * @param {string} sep
 */
function stripTrailingSeparator(s, sep) {
  let out = s;
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1);
  // 折叠到底可能只剩盘符（`C:`）——那不是路径，退回带分隔符的形态
  if (/^[A-Za-z]:$/.test(out)) return out + sep;
  return out;
}

/**
 * 条目路径**是否被 Codex 认得出**（= 与规范写形只差大小写 / darwin 的 Unicode 形态）。
 *
 * ★ 这里**不**折叠分隔符——折叠了就等于把"写坏的条目"当成命中（见文件头）。
 * @param {string} entryPath
 * @param {string} canon
 * @param {NodeJS.Platform | string} platform
 */
function recognizedByCodex(entryPath, canon, platform) {
  return foldForTrust(entryPath, platform) === foldForTrust(canon, platform);
}

/**
 * 条目路径**是不是指向同一个目录、但写法 Codex 认不出**？
 *
 * 判据：拿**规范化的**条目路径去比——相等就说明"只差写法"。
 * （先排除已命中的情况，那是"认得出"，不是"认不出"。）
 * @param {string} entryPath
 * @param {string} canon
 * @param {NodeJS.Platform | string} platform
 */
function samePathWrongForm(entryPath, canon, platform) {
  if (recognizedByCodex(entryPath, canon, platform)) return false;
  let c;
  try {
    c = canonicalizeTrustPath(entryPath, platform);
  } catch {
    return false;   // 条目本身就不是绝对路径之类——不是我们能修的
  }
  return foldForTrust(c, platform) === foldForTrust(canon, platform);
}

/**
 * "为什么 Codex 认不出这条"——给用户看的一句话。§7.3 表里每一条都给个说法。
 * @param {string} entryPath
 * @param {string} canon
 */
function whyWrongForm(entryPath, canon) {
  if (entryPath.startsWith('\\\\?\\')) return '带了 \\\\?\\ 前缀';
  if (entryPath.replace(/\\/g, '/') === canon.replace(/\\/g, '/')) return '用了正斜杠';
  if (entryPath.replace(/[\\/]+$/, '') === canon) return '尾部多了分隔符';
  return '与规范写法不一致';
}

// ───────────────────────────── 解析 ─────────────────────────────

/**
 * @typedef {object} TrustEntry
 * @property {string} path        TOML 里那条路径**解析后**的字面值（未归一）
 * @property {'table' | 'dotted' | 'inline'} form
 *   `table` = `[projects.'<p>']`；`dotted` = `projects.'<p>'.trust_level = …`（二进制自己的写法）；
 *   `inline` = `projects."<p>" = { … }`——**我们改不了**，遇到要报错让用户手工转成表形式
 * @property {number} line        0-based：表头行（table）/ 键行（dotted / inline）
 * @property {number} keyIndex    0-based：`trust_level` 所在行；没有则 -1
 * @property {number} keyEnd      0-based：`trust_level` 值的结束行（多行值用）；没有则 -1
 * @property {string | null} level  解析出的 trust_level；缺键或值不是字符串则 null
 * @property {string | null} levelRaw 原文（排查用）
 */

/**
 * 扫一遍文本，列出全部信任条目。
 *
 * ⚠️ 所有行号都是 **0-based**；要给人看就 `+1`。
 *
 * @param {string} text
 * @returns {TrustEntry[]}
 */
export function parseTrustEntries(text) {
  return scanEntries(prepareText(text).lines);
}

/**
 * @param {string[]} lines
 * @returns {TrustEntry[]}
 */
function scanEntries(lines) {
  const { isHeader, sectionOf } = analyze(lines);
  /** @type {TrustEntry[]} */
  const entries = [];
  /** @type {Map<string, TrustEntry>} */
  const byPath = new Map();
  /** @type {TrustEntry | null} */
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const sec = sectionOf[i];

    // ── ① 表头 ──
    if (isHeader[i]) {
      current = null;
      if (sec !== null && sec.length === 2 && sec[0] === PROJECTS_TABLE) {
        const hdr = parseSectionHeader(trimmed);
        if (hdr?.isArray) {
          throw new IntegrityError(
            `config.toml 里有数组表 [[${PROJECTS_TABLE}.${sec[1]}]]`,
            {
              hint: `Codex 的信任记录是单表形式 [${PROJECTS_TABLE}.'<路径>']。`
                + '数组表会让整个 config.toml 无法解析——手工把它改成单表再运行',
            },
          );
        }
        const dup = byPath.get(sec[1]);
        if (dup !== undefined) {
          throw new IntegrityError(
            `同一张表定义了两次：[${PROJECTS_TABLE}.${sec[1]}]（第 ${dup.line + 1} 行与第 ${i + 1} 行）`,
            { hint: 'TOML 不允许重复定义同一张表，Codex 会拒绝加载整个 config.toml。手工删掉多余的那条' },
          );
        }
        current = {
          path: sec[1], form: 'table', line: i,
          keyIndex: -1, keyEnd: -1, level: null, levelRaw: null,
        };
        entries.push(current);
        byPath.set(current.path, current);
      }
      continue;
    }

    // ── ② 表体内（`[projects.*]` 下的 trust_level）──
    if (current !== null && sec !== null
      && sec.length === 2 && sec[0] === PROJECTS_TABLE && sec[1] === current.path) {
      const kv = parseKeyValue(trimmed);
      if (!kv) continue;
      const end = findValueEnd(lines, i);
      if (kv.segments.length === 1 && kv.segments[0] === TRUST_KEY) {
        if (current.keyIndex >= 0) {
          throw new IntegrityError(
            `[${PROJECTS_TABLE}.${current.path}] 里 ${TRUST_KEY} 出现了两次`
            + `（第 ${current.keyIndex + 1} 行与第 ${i + 1} 行）`,
            { hint: '静默取第一个会让"实际生效的信任状态"取决于文件顺序。手工删掉多余的那条' },
          );
        }
        current.keyIndex = i;
        current.keyEnd = end;
        current.levelRaw = extractValueText(lines, i, end);
        current.level = parseStringLiteral(current.levelRaw);
      }
      i = end;
      continue;
    }

    // ── ③ 顶层的 dotted 形式（`projects."<p>".trust_level`，二进制自己就这么写）──
    if (sec === null) {
      const kv = parseKeyValue(trimmed);
      if (!kv) continue;
      // ★ 顶层键值对一律整段跳过（含多行值）。
      //   不跳的话，一个多行字符串里写着 `projects."C:\x".trust_level = "trusted"`
      //   就会被当成真条目——`parseKeyValue` 只看这一行，它当然认得出。
      const end = findValueEnd(lines, i);
      if (kv.segments[0] === PROJECTS_TABLE) {
        if (kv.segments.length === 1) {
          throw new IntegrityError(
            `config.toml 把 ${PROJECTS_TABLE} 定义成了一个值（第 ${i + 1} 行）`,
            {
              hint: `这样就没法再写 [${PROJECTS_TABLE}.'<路径>'] 了——`
                + 'Codex 的信任记录需要它是一张表。手工改掉再运行',
            },
          );
        }
        if (kv.segments.length === 2) {
          // `projects."<p>" = { ... }` —— 我们改不了内联表，但要记下来，
          // 否则 spliceTrust 会以为"没有这条"而追加一张同名的表 ⇒ 整个文件作废
          const dup = byPath.get(kv.segments[1]);
          if (dup === undefined) {
            const e = /** @type {TrustEntry} */ ({
              path: kv.segments[1], form: 'inline', line: i,
              keyIndex: -1, keyEnd: -1, level: null, levelRaw: null,
            });
            entries.push(e);
            byPath.set(e.path, e);
          }
        } else if (kv.segments.length === 3 && kv.segments[2] === TRUST_KEY) {
          const p = kv.segments[1];
          const dup = byPath.get(p);
          if (dup !== undefined) {
            throw new IntegrityError(
              `${p} 在 config.toml 里被定义了两次（第 ${dup.line + 1} 行与第 ${i + 1} 行）`,
              { hint: '同一张表不能定义两次，Codex 会拒绝加载整个 config.toml' },
            );
          }
          const raw = extractValueText(lines, i, end);
          const e = /** @type {TrustEntry} */ ({
            path: p, form: 'dotted', line: i,
            keyIndex: i, keyEnd: end,
            level: parseStringLiteral(raw), levelRaw: raw,
          });
          entries.push(e);
          byPath.set(p, e);
        }
      }
      i = end;
      continue;
    }
  }

  return entries;
}

/**
 * 取 `key = <这里>` 的原文（跨行值拼起来）。认不出 `=` 就返回空串。
 * @param {string[]} lines
 * @param {number} start
 * @param {number} end
 */
function extractValueText(lines, start, end) {
  const first = lines[start] ?? '';
  const eq = first.indexOf('=');
  /** @type {string[]} */
  const parts = [eq >= 0 ? first.slice(eq + 1) : ''];
  for (let i = start + 1; i <= end; i++) parts.push(lines[i] ?? '');
  return parts.join('\n').trim();
}

/**
 * TOML 字符串字面量 → JS 字符串。**只认单行**的 `'…'` 与 `"…"`。
 *
 * 不追求完备（`trust_level` 的值只有 `trusted` / `untrusted` 两种，永远不含转义）——
 * 但认不出时返回 `null` 而不是猜，让上层把它当"值可疑"报出来。
 * @param {string | null} raw
 * @returns {string | null}
 */
function parseStringLiteral(raw) {
  const s = String(raw ?? '').trim();
  if (s.includes('\n')) return null;
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(.)/g, (_, c) => {
      switch (c) {
        case 'n': return '\n';
        case 't': return '\t';
        case 'r': return '\r';
        case 'b': return '\b';
        case 'f': return '\f';
        default: return c;
      }
    });
  }
  return null;
}

// ───────────────────────────── 读取（三态）─────────────────────────────

/**
 * @typedef {object} TrustState
 * @property {'trusted' | 'untrusted' | 'unmarked'} state
 *   ★ **三态**（§7.3）：`untrusted`（显式拒绝）与 `unmarked`（从未标记）**语义不同**
 *   ——resolved 的审批档位分别是 `UnlessTrusted` 与 `OnRequest`。
 * @property {TrustEntry | null} entry        命中的那条（`unmarked` 时为 null）
 * @property {string} canonicalPath           本次查询用的规范写形
 * @property {{ path: string, line: number, reason: string }[]} nearMisses
 *   指向同一个目录、但**写法 Codex 认不出**的条目——静默失配的元凶，`doctor` 要报
 */

/**
 * 查一个路径在该文件里的信任状态。
 *
 * @param {string} text `config.toml` 的内容（不存在就给空串）
 * @param {string} path 要查的路径
 * @param {NodeJS.Platform | string} platform
 * @returns {TrustState}
 */
export function readTrust(text, path, platform) {
  const canon = canonicalizeTrustPath(path, platform);
  const entries = scanEntries(prepareText(text).lines);

  /** @type {TrustEntry[]} */
  const hits = [];
  /** @type {{ path: string, line: number, reason: string }[]} */
  const nearMisses = [];
  for (const e of entries) {
    if (recognizedByCodex(e.path, canon, platform)) hits.push(e);
    else if (samePathWrongForm(e.path, canon, platform)) {
      nearMisses.push({ path: e.path, line: e.line + 1, reason: whyWrongForm(e.path, canon) });
    }
  }

  if (hits.length === 0) {
    return { state: 'unmarked', entry: null, canonicalPath: canon, nearMisses };
  }

  // 同一条路径在归一后仍出现两次：`[projects.'C:\x']` 与 `[projects.'c:\X']`。
  // TOML 层面合法（两个不同的键），但 Codex 会看到两条同路径的记录 ⇒ 谁生效取决于顺序。
  if (hits.length > 1) {
    throw new IntegrityError(
      `config.toml 里有 ${hits.length} 条记录都指向 ${canon}（第 ${hits.map((h) => h.line + 1).join(' / ')} 行）`,
      { hint: 'Codex 比较时大小写不敏感，所以这几条会互相覆盖、谁生效取决于文件顺序。手工只留一条' },
    );
  }

  const e = hits[0];
  const state = e.level === 'trusted' ? 'trusted' : e.level === 'untrusted' ? 'untrusted' : 'unmarked';
  return { state, entry: e, canonicalPath: canon, nearMisses };
}

// ───────────────────────────── 写入 ─────────────────────────────

/**
 * @typedef {object} TrustSpliceReport
 * @property {boolean} changed
 * @property {boolean} created       原文本为空 → 这是全新文件
 * @property {boolean} hadBom        原文件带 BOM（已剥掉）→ `doctor` 要报（§7.14①）
 * @property {boolean} normalizedEol 原文件含 CR（已归一为 LF）
 * @property {'added' | 'updated' | 'repaired' | 'unchanged'} action
 *   `repaired` = 条目本来就有，但**写法 Codex 认不出**，已改成规范写形
 * @property {string} path           实际写进文件的路径（规范写形）
 * @property {string} level
 * @property {number | null} line    写入后 `trust_level` 的 1-based 行号
 * @property {string | null} repairedFrom 被修好的原写法（没修就是 null）
 * @property {{ path: string, line: number, reason: string }[]} nearMisses
 *   **仍然**写坏的其它条目（我们只修一条——修两条会撞成重复表）
 */

/**
 * 写一条信任记录。**幂等**：同样的参数连跑两次，第二次 `changed === false`。
 *
 * ★ **四条不变量**（违反即 bug）：
 * 1. **永不删除任何 `[projects.*]` 条目**（那是用户的信任决定，§2.9 铁律 2）
 * 2. **永不删除整个文件**——空文件就是"追加一条"
 * 3. 路径写**规范写形**：win32 反斜杠 + TOML 字面字符串（§7.3 铁律 1、2）
 * 4. 表里**只写 `trust_level` 一个键**（§7.3 铁律 5）——别往里加别的
 *
 * 遇到"写法认不出"的既有条目时**就地修好它**（只改表头那一行，表体一字不动），
 * 而不是再追加一条同路径的新条目——那会让 TOML 直接报"重复定义"，
 * 整个 config.toml 作废，比信任没生效严重得多。
 *
 * @param {string} text
 * @param {{ path: string, level: string, platform: NodeJS.Platform | string }} opts
 * @returns {{ newText: string, report: TrustSpliceReport }}
 */
export function spliceTrust(text, { path, level, platform }) {
  if (!TRUST_LEVELS.includes(/** @type {any} */ (level))) {
    throw new CxtError(
      `${TRUST_KEY} 只能是 ${TRUST_LEVELS.join(' / ')}，收到 ${JSON.stringify(level)}`,
      { hint: 'Codex 的信任表只有这两个值（§7.3 铁律 5）。撤销信任用 --untrust，不是删条目' },
    );
  }

  const canon = canonicalizeTrustPath(path, platform);
  const prep = prepareText(text);
  const out = prep.lines.slice();
  const levelLine = `${TRUST_KEY} = ${toTomlValue(level)}`;

  const entries = scanEntries(prep.lines);
  /** @type {TrustEntry[]} */
  const hits = [];
  /** @type {TrustEntry[]} */
  const broken = [];
  for (const e of entries) {
    if (recognizedByCodex(e.path, canon, platform)) hits.push(e);
    else if (samePathWrongForm(e.path, canon, platform)) broken.push(e);
  }

  if (hits.length > 1) {
    throw new IntegrityError(
      `config.toml 里有 ${hits.length} 条记录都指向 ${canon}（第 ${hits.map((h) => h.line + 1).join(' / ')} 行）`,
      { hint: 'Codex 比较时大小写不敏感，这几条会互相覆盖。手工只留一条再运行' },
    );
  }

  /** @type {TrustSpliceReport} */
  const report = {
    changed: false,
    created: prep.created,
    hadBom: prep.hadBom,
    normalizedEol: prep.normalizedEol,
    action: 'unchanged',
    path: canon,
    level,
    line: null,
    repairedFrom: null,
    nearMisses: [],
  };

  /** @type {TrustEntry | null} */
  let target = hits[0] ?? null;
  const repairing = target === null && broken.length > 0;
  if (repairing) {
    target = broken[0];
    report.repairedFrom = target.path;
    // 剩下的那些**只报不改**：改两条会变成两张同名表 ⇒ 文件直接作废
    for (const e of broken.slice(1)) {
      report.nearMisses.push({ path: e.path, line: e.line + 1, reason: whyWrongForm(e.path, canon) });
    }
  }

  if (target === null) {
    // ── 全新条目：追加在文件末尾 ──
    // 受管区在**文件开头**（§2.9），信任记录追加在**末尾**，两者互不干扰。
    // 不动任何既有行——包括末尾的空行（"逐字节保留"原则）。
    if (out.length > 0 && out[out.length - 1].trim() !== '') out.push('');
    out.push(`[${PROJECTS_TABLE}.${toTomlPathKey(canon)}]`, levelLine);
    report.line = out.length;   // levelLine 的 1-based 行号
    report.action = 'added';
  } else if (target.form === 'inline') {
    throw new IntegrityError(
      `config.toml 把 ${canon} 写成了内联表（第 ${target.line + 1} 行）`,
      {
        hint: `内联表没法安全地就地改。手工把它改成两行：\n`
          + `  [${PROJECTS_TABLE}.${toTomlPathKey(canon)}]\n`
          + `  ${TRUST_KEY} = ${toTomlValue(level)}`,
      },
    );
  } else if (target.form === 'dotted') {
    // 二进制自己就是这种写法（§7.3 铁律 5）——保持形态，只换那一行
    const newLine = `${PROJECTS_TABLE}.${toTomlPathKey(canon)}.${TRUST_KEY} = ${toTomlValue(level)}`;
    const same = out[target.keyIndex] === newLine;
    out.splice(target.keyIndex, target.keyEnd - target.keyIndex + 1, newLine);
    report.line = target.keyIndex + 1;
    report.action = repairing ? 'repaired' : (same ? 'unchanged' : 'updated');
  } else {
    // ── 表形式 ──
    if (repairing) out[target.line] = `[${PROJECTS_TABLE}.${toTomlPathKey(canon)}]`;

    if (target.keyIndex < 0) {
      // 表在、键不在 → 插在表头正下方（留空行也行，紧贴也行；紧贴更稳）
      out.splice(target.line + 1, 0, levelLine);
      report.line = target.line + 2;
      report.action = repairing ? 'repaired' : 'added';
    } else {
      const newLine = levelLine;
      const same = out[target.keyIndex] === newLine;
      out.splice(target.keyIndex, target.keyEnd - target.keyIndex + 1, newLine);
      report.line = target.keyIndex + 1;
      report.action = repairing ? 'repaired' : (same ? 'unchanged' : 'updated');
    }
  }

  const newText = finishText(out, prep.trailingNewline);
  report.changed = newText !== String(text ?? '');
  return { newText, report };
}
