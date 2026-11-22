// @ts-check
/**
 * 用量归集（§2.13）：把 transcript 读成**同一种记录**，再按任意维度汇总。
 *
 * 这一层是**纯函数**——不读文件、不碰 `process`、不知道"现在"是几点
 * （`--days` 的窗口由调用方按记录里的 `day` 过滤）。理由与 core/ 其余模块一致：
 * 能单测的东西不该混进 I/O。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ 两种 agent 的 `input_tokens` **语义相反**，这是本文件存在的头号理由：
 *
 *   | | `input_tokens` 含不含缓存 |
 *   |---|---|
 *   | Claude Code | **不含**。`input + cache_read + cache_creation + output` 才是总量 |
 *   | Codex | **含**。`total_tokens === input_tokens + output_tokens`（9 个真实会话实测 7/7），
 *   |         | 而 `cached_input_tokens` / `cache_write_input_tokens` 是它的**子集** |
 *
 *   不在这一层统一，两条链路算出来的钱就会一条偏高、一条偏低，而且**都看不出错**。
 *   所以对外只给「互不重叠的四项」：
 *
 *     input      真正现算的输入（不含任何缓存）
 *     cacheRead  命中缓存的输入
 *     cacheWrite 写入缓存的输入
 *     output     输出（**含** reasoning / thinking——它们本来就是 output 的一部分，
 *                再加一次就是重复计费；`reasoning_output_tokens` 因此只读不累）
 *
 *   四项相加 = 计费口径下的 token 总量。缓存三档单价不同，所以**不能只留一个总数**。
 * ─────────────────────────────────────────────────────────────
 *
 * 另一条实测结论：Claude 的 transcript 里**同一条 assistant 消息会重复落盘**
 * （33,895 行里只有 5,844 个不同的 `message.id`，其中 0 个 id 的前后 `usage` 不一致）。
 * 直接累加会**翻倍**，所以按 `message.id` 去重、取首次出现——这是无损的。
 */
import { normalizeForCompare } from './bindings.js';

/**
 * @typedef {object} Tokens
 * @property {number} input      现算输入
 * @property {number} cacheRead  缓存命中
 * @property {number} cacheWrite 缓存写入
 * @property {number} output     输出（含 reasoning）
 */

/**
 * 一条可汇总的记录。**已按 (day, model, project) 合并过**，不是"一次调用一条"。
 * @typedef {object} UsageEntry
 * @property {string} day     本地日期 `YYYY-MM-DD`
 * @property {string} model   模型 id（未知时为空串）
 * @property {string} project 工作目录（原样，仅展示用；比较一律先归一）
 * @property {Tokens} tokens
 */

/**
 * @typedef {object} ParseStats
 * @property {number} lines      读到的非空行数
 * @property {number} badJson    解析失败的行数
 * @property {number} messages   真正算进账的消息条数
 * @property {number} duplicates 因 `message.id` 重复被丢弃的条数（Claude）
 * @property {number} noUsage    没有 usage 字段的条数
 */

/** 四个计数项的唯一权威顺序——渲染、相加、JSON 都按它走。 */
export const TOKEN_KEYS = /** @type {const} */ (['input', 'cacheRead', 'cacheWrite', 'output']);

/** 四个计数项的中文标签（表头用）。 */
export const TOKEN_LABELS = /** @type {const} */ ({
  input: '输入',
  cacheRead: '缓存读',
  cacheWrite: '缓存写',
  output: '输出',
});

/** @returns {Tokens} */
export function zeroTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/**
 * 计费口径的 token 总量。
 * @param {Tokens} t
 */
export function totalOf(t) {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

/**
 * @param {Tokens} a
 * @param {Tokens} b
 * @returns {Tokens}
 */
export function addTokens(a, b) {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/**
 * 只认**有限正数**。负数、NaN、字符串一律记 0——
 * transcript 里的 `-1`（某些端点用来表示"按量后付"）绝不能把总额拉成负数。
 * @param {unknown} v
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * ISO 时间戳 → **本地**日期 `YYYY-MM-DD`。
 *
 * 用本地而不是 UTC：用户问"今天花了多少"时，指的是他墙上的日历，
 * 不是格林尼治的。代价是同一天的边界随机器时区变——但那是**正确的**边界。
 * 解析不了就返回空串，调用方把它归入"日期未知"。
 * @param {unknown} iso
 * @returns {string}
 */
export function dayOf(iso) {
  if (typeof iso !== 'string' || iso === '') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 合并键。
 *
 * ★ 用 `JSON.stringify` 而不是 `\u0000` 之类的分隔符：本仓库有一条反复踩到的坑——
 *   源码里的转义序列经某些编辑路径会**落地成裸控制字符**，肉眼看不见、JSON 里非法。
 *   `JSON.stringify(数组)` 天然无歧义，且不含任何控制字符。
 * @param {string[]} parts
 */
function keyOf(parts) {
  return JSON.stringify(parts);
}

/**
 * 往累加表里塞一条（首见即建）。
 * @param {Map<string, UsageEntry>} acc
 * @param {string} day
 * @param {string} model
 * @param {string} project
 * @param {Tokens} tokens
 */
function push(acc, day, model, project, tokens) {
  const k = keyOf([day, model, project]);
  const hit = acc.get(k);
  if (hit) {
    hit.tokens = addTokens(hit.tokens, tokens);
    return;
  }
  acc.set(k, { day, model, project, tokens });
}

// ═══════════════════════ Claude Code ═══════════════════════

/**
 * 解析 Claude Code 的 transcript（`<configDir>/projects/<slug>/<session>.jsonl`）。
 *
 * 只认 `type === 'assistant'` 的行；`user` 行没有 usage。`<synthetic>` 是
 * 记账用的假消息（例如"上下文已被压缩"），usage 全零，不计。
 *
 * ★ 去重按 `message.id`，**只在本文件内去重**——这让增量缓存（按文件）仍然成立。
 *   跨文件同一个 id 在实践中不存在（id 是会话内生成的），即便出现，
 *   代价是少算一条而不是重复计账，方向是安全的。
 *
 * @param {string[]} lines
 * @returns {{ entries: UsageEntry[], stats: ParseStats }}
 */
export function claudeFromLines(lines) {
  /** @type {Map<string, UsageEntry>} */
  const acc = new Map();
  /** @type {Set<string>} */
  const seen = new Set();
  const stats = /** @type {ParseStats} */ ({
    lines: 0, badJson: 0, messages: 0, duplicates: 0, noUsage: 0,
  });
  /**
   * 文件内**向上继承**的 cwd。
   *
   * 不是所有行都带 `cwd`（subagent transcript 里尤其如此），而一手一个
   * 「未知目录」会把同一个项目劈成两块，看着像丢数据。同一个文件里 cwd 是固定的，
   * 记住最近一次见到的值就够了。
   */
  let project = '';

  for (const raw of lines) {
    if (raw === '') continue;
    stats.lines++;
    /** @type {any} */
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      stats.badJson++;
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    // 先收 cwd 再判类型：`user` 行也带 cwd，可能正是本文件唯一的线索。
    if (typeof o.cwd === 'string' && o.cwd) project = o.cwd;
    if (o.type !== 'assistant') continue;

    const msg = o.message;
    if (!msg || typeof msg !== 'object') {
      stats.noUsage++;
      continue;
    }

    const id = typeof msg.id === 'string' ? msg.id : '';
    if (id !== '') {
      if (seen.has(id)) {
        stats.duplicates++;
        continue;
      }
      // 先登记再看 usage：同一条消息的重复行**总是带着同样的 usage**
      // （实测 0 处不一致），所以"首见即算"是安全的。
      seen.add(id);
    }

    const model = typeof msg.model === 'string' ? msg.model : '';
    if (model === '<synthetic>') continue;

    const u = msg.usage;
    if (!u || typeof u !== 'object') {
      stats.noUsage++;
      continue;
    }

    const tokens = {
      // ★ Claude 的三项本来就互不重叠，原样搬过来即可（见文件头那张表）。
      input: num(u.input_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
      output: num(u.output_tokens),
    };
    if (totalOf(tokens) === 0) continue;

    stats.messages++;
    push(acc, dayOf(o.timestamp), model, project, tokens);
  }

  return { entries: [...acc.values()], stats };
}

// ═══════════════════════ Codex ═══════════════════════

/**
 * 把 codex 的一条 usage 记录换算成互不重叠的四项。
 *
 * ★★ `input_tokens` **含缓存**（实测 `total_tokens === input_tokens + output_tokens`，
 *    且 `cached + cacheWrite` 从不超过 `input_tokens`）——必须剥掉，
 *    否则缓存那部分会按原价再算一遍。
 *
 * `reasoning_output_tokens` 是 `output_tokens` 的**子集**，不加。
 * `Math.max(0, …)` 只是防御：真出现负数说明 provider 口径又变了，
 * 宁可这一项记 0，也不要把总额做成负的。
 *
 * @param {any} u
 * @returns {Tokens}
 */
export function codexTokens(u) {
  const cacheRead = num(u.cached_input_tokens);
  const cacheWrite = num(u.cache_write_input_tokens);
  const raw = num(u.input_tokens);
  return {
    input: Math.max(0, raw - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: num(u.output_tokens),
  };
}

/**
 * 解析 Codex 的 rollout（`<profile>/sessions/YYYY/MM/DD/rollout-*.jsonl`）。
 *
 * 两个数据源，**只取其一，绝不叠加**：
 *
 *   1. `token_usage_record` —— 每条一个 response 的**增量**，自带 `turn_id` 与时间戳。
 *      有它就用它：能把用量摊到正确的日期和模型上（`turn_context` 里有同 `turn_id` 的 model/cwd）。
 *   2. `event_msg` + `payload.type === 'token_count'` —— `info.total_token_usage` 是**累计值**，
 *      只能取最后一条，且整段会话都会被记到那一个时间点上。
 *
 * 实测两者算出来的总量**逐字段相等**（5/5 个文件），所以选谁都不影响总额，
 * 差别只在于日期/模型的归属精度。
 *
 * @param {string[]} lines
 * @returns {{ entries: UsageEntry[], stats: ParseStats }}
 */
export function codexFromLines(lines) {
  const stats = /** @type {ParseStats} */ ({
    lines: 0, badJson: 0, messages: 0, duplicates: 0, noUsage: 0,
  });

  /** turn_id → { model, cwd } */
  /** @type {Map<string, { model: string, cwd: string }>} */
  const turns = new Map();
  let sessionCwd = '';
  let sessionModel = '';
  let lastCount = /** @type {Tokens | null} */ (null);
  let lastCountTs = '';
  /** @type {{ day: string, model: string, project: string, tokens: Tokens }[]} */
  const records = [];

  /** @param {any} o */
  const noteTurn = (o) => {
    const p = o.payload;
    if (!p || typeof p !== 'object') return;
    if (typeof p.turn_id !== 'string') return;
    const prev = turns.get(p.turn_id) ?? { model: '', cwd: '' };
    turns.set(p.turn_id, {
      model: typeof p.model === 'string' && p.model ? p.model : prev.model,
      cwd: typeof p.cwd === 'string' && p.cwd ? p.cwd : prev.cwd,
    });
  };

  for (const raw of lines) {
    if (raw === '') continue;
    stats.lines++;
    /** @type {any} */
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      stats.badJson++;
      continue;
    }
    if (!o || typeof o !== 'object') continue;
    const p = o.payload;
    if (!p || typeof p !== 'object') continue;

    if (o.type === 'session_meta') {
      if (typeof p.cwd === 'string' && p.cwd) sessionCwd = p.cwd;
      continue;
    }
    if (o.type === 'turn_context') {
      noteTurn(o);
      if (typeof p.model === 'string' && p.model) sessionModel = p.model;
      continue;
    }
    if (o.type === 'token_usage_record') {
      // `usage` 是这一条 response 的增量；`turn_token_usage` / `thread_token_usage`
      // 是汇总视图，**不要**再算一遍。
      noteTurn(o); // 有些版本把 model/cwd 也写在这儿
      if (!p.usage || typeof p.usage !== 'object') {
        stats.noUsage++;
        continue;
      }
      const turn = turns.get(typeof p.turn_id === 'string' ? p.turn_id : '');
      records.push({
        day: dayOf(o.timestamp),
        model: turn?.model || sessionModel,
        project: turn?.cwd || sessionCwd,
        tokens: codexTokens(p.usage),
      });
      continue;
    }
    if (p.type === 'token_count') {
      const tot = p.info?.total_token_usage;
      if (tot && typeof tot === 'object') {
        lastCount = codexTokens(tot);
        lastCountTs = typeof o.timestamp === 'string' ? o.timestamp : '';
      }
    }
  }

  /** @type {Map<string, UsageEntry>} */
  const acc = new Map();
  if (records.length > 0) {
    stats.messages = records.length;
    for (const r of records) push(acc, r.day, r.model, r.project, r.tokens);
  } else if (lastCount && totalOf(lastCount) > 0) {
    // 老格式：只有一个累计值，时间只能归到它最后出现的那个点。
    stats.messages = 1;
    push(acc, dayOf(lastCountTs), sessionModel, sessionCwd, lastCount);
  }

  return { entries: [...acc.values()], stats };
}

// ═══════════════════════ 汇总 ═══════════════════════

/** 可以按哪些维度分组。顺序 = `--by` 的帮助文本顺序。 */
export const DIMENSIONS = /** @type {const} */ (['token', 'project', 'model', 'day']);

/** @typedef {'token' | 'project' | 'model' | 'day'} Dimension */

/**
 * @typedef {object} UsageGroup
 * @property {string} key             展示用的键（首次出现的原样值）
 * @property {Tokens} tokens
 * @property {UsageEntry[]} entries   落进这一组的记录——算花费要按 model 逐条查价
 */

/**
 * 给一批记录打上"来自哪个 token"。
 *
 * transcript 本身不知道 token 是谁——是**目录**告诉我们它是谁的（profile 名）。
 * 这个标记只在内存里存在，**不写进缓存**：缓存是按文件存的，而文件属于谁
 * 由调用时的目录结构决定，不该固化。
 *
 * @param {UsageEntry[]} entries
 * @param {string} token
 * @returns {(UsageEntry & { token: string })[]}
 */
export function tagToken(entries, token) {
  return entries.map((e) => ({ ...e, token }));
}

/**
 * 按维度分组，**总量降序**（同量按 key 排），让"最花钱的"永远在最上面。
 *
 * `project` 比较时走 `normalizeForCompare()`——Windows 上 `C:\A` 与 `c:\a`
 * 是同一个项目，但展示保留首次见到的写法（用户认的是自己的路径大小写）。
 *
 * `token` 维度要求记录先过一遍 `tagToken()`；没打标记的落进「（未知 token）」。
 *
 * @param {(UsageEntry & { token?: string })[]} entries
 * @param {Dimension} dim
 * @param {{ platform?: NodeJS.Platform }} [opts]
 * @returns {UsageGroup[]}
 */
export function groupEntries(entries, dim, { platform = 'linux' } = {}) {
  /** @type {Map<string, UsageGroup>} */
  const acc = new Map();

  for (const e of entries) {
    const raw = dim === 'day' ? (e.day || '（日期未知）')
      : dim === 'model' ? (e.model || '（未知模型）')
        : dim === 'token' ? (e.token || '（未知 token）')
          : (e.project || '（未知目录）');
    const k = dim === 'project' ? normalizeForCompare(e.project, platform) : raw;

    const hit = acc.get(k);
    if (hit) {
      hit.tokens = addTokens(hit.tokens, e.tokens);
      hit.entries.push(e);
    } else {
      acc.set(k, { key: raw, tokens: e.tokens, entries: [e] });
    }
  }

  return [...acc.values()].sort(
    (a, b) => totalOf(b.tokens) - totalOf(a.tokens) || a.key.localeCompare(b.key),
  );
}

/**
 * 把一天的窗口换算成下限日期（含）。
 *
 * `--days 1` = 今天；`--days 7` = 含今天在内往前数 7 天。`days <= 0` 表示不设下限。
 *
 * @param {number} days
 * @param {Date} [now] 测试注入用
 * @returns {string} `YYYY-MM-DD`，空串表示不限
 */
export function cutoffDay(days, now = new Date()) {
  if (!(days > 0)) return '';
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - (days - 1));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * 丢掉窗口之外的记录。`cutoff` 为空串时不筛。
 * @param {UsageEntry[]} entries
 * @param {string} cutoff
 */
export function sinceEntries(entries, cutoff) {
  if (cutoff === '') return entries;
  // `YYYY-MM-DD` 的字典序 == 时间序，直接比字符串即可。
  // 日期未知（空串）的**保留**：宁可在窗口里多显示一条，也别把账悄悄抹掉。
  return entries.filter((e) => e.day === '' || e.day >= cutoff);
}
