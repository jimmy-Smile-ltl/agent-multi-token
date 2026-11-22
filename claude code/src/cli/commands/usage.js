// @ts-check
/**
 * `cmt usage` —— 按 token / 项目 / 模型 / 日期统计用量与花费（§2.13）。
 *
 * 数据来源是 **claude 自己写的 transcript**，不是我们记账：
 * `<configDir>/projects/<slug>/**\/*.jsonl`。这带来两个必须知道的事实：
 *
 *   1. **同一个项目会出现在多个 token 下**——profile 是隔离的，所以
 *      「按项目」只能回答"这个目录一共花了多少"，回答不了"哪个 token 花的"。
 *      想知道后者就按 token 看，或者 `--by token` 看每一行。
 *   2. **subagent 也有独立的 transcript**（藏在 `<slug>/<session>/subagents/`），
 *      它们是真金白银的调用，递归时不能漏。
 *
 * ★ 这是**只读**命令：除了自己的 `usage-cache.json`（可丢弃的重建缓存），
 *   不碰任何配置、不碰 `resources.json`、不联网。
 */
import nodeFs from 'node:fs';
import { join } from 'node:path';

import { CmtError, EXIT } from '../../core/errors.js';
import {
  DIMENSIONS, addTokens, claudeFromLines, cutoffDay, groupEntries, sinceEntries,
  tagToken, totalOf, zeroTokens,
} from '../../core/usage.js';
import { costOf, priceFor } from '../../core/prices.js';
import { profilesDir, usageCachePath } from '../../core/paths.js';
import { displayWidth } from '../format.js';
// ★ 取价**只有一处实现**：资源屏与这里看的是同一份价格表（§2.13 九 9.2）。
import { loadPriceTable } from '../price-table.js';
// ★ 目录发现只此一处：`pool sync` 用的是**同一个** `discoverSources()`，
//   否则"池里的用量"与"usage 的用量"迟早对不上（见 usage-sources.js 文件头）。
import { discoverSources } from '../usage-sources.js';

/** 缓存格式版本。**改了 entries 的编码就必须加一**，否则旧缓存会被当成新格式读。 */
const CACHE_VERSION = 1;

const DEFAULT_DAYS = 7;

export const usageCommand = {
  spec: /** @type {any} */ ({
    boolean: ['help', 'json', 'refresh'],
    string: ['days', 'by'],
    alias: { h: 'help' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    if (args.help) {
      process.stdout.write(USAGE_HELP);
      return EXIT.OK;
    }

    const days = parseDays(args.days);
    const by = /** @type {import('../../core/usage.js').Dimension} */ (String(args.by ?? 'token'));
    if (!DIMENSIONS.includes(by)) {
      throw new CmtError(`--by 只认 ${DIMENSIONS.join(' / ')}，收到「${by}」`, {
        hint: '例如 `cmt usage --by project`',
      });
    }

    // ── 收集 ────────────────────────────────────────────────────────
    // ★ 取价**只有一处实现**（`cli/price-table.js`）：资源屏看的是同一份表（§2.13 九 9.2）。
    const prices = loadPriceTable(ctx);
    const table = prices.table;
    const pricesFile = prices.file;
    const userPrices = prices.handwritten.length;
    const endpointUsed = prices.fromEndpoint;
    const cache = loadCache(ctx.home);
    const sources = discoverSources(ctx.home);

    /** @type {Record<string, any>} */
    const nextFiles = {};
    /** @type {{token: string, files: number, entries: number}[]} */
    const sourceStats = [];
    /** @type {(import('../../core/usage.js').UsageEntry & {token?: string})[]} */
    const tagged = [];
    let parsedAny = false;
    let changed = false;
    let transcriptCount = 0;

    for (const src of sources) {
      /** @type {import('../../core/usage.js').UsageEntry[]} */
      const entries = [];
      let files = 0;

      for (const file of src.files) {
        const hit = readOne(file, cache, args.refresh === true);
        if (!hit) continue;
        parsedAny = true;
        changed = changed || hit.changed;
        files++;
        transcriptCount++;
        nextFiles[file] = cache.files[file];
        for (const e of hit.entries) entries.push(e);
      }

      sourceStats.push({ token: src.token, files, entries: entries.length });
      if (entries.length > 0) tagged.push(...tagToken(entries, src.token));
    }

    // 只保留**这次仍然存在**的文件条目，否则缓存会随着删掉的会话无限长大。
    if (Object.keys(cache.files).length !== Object.keys(nextFiles).length) changed = true;
    if (changed) {
      cache.files = nextFiles;
      saveCache(ctx.home, cache);
    }

    if (!parsedAny) {
      process.stdout.write(
        '没有找到任何 transcript。\n' +
          `  找过：${profilesDir(ctx.home)} 与 ${join(ctx.home, '.claude', 'projects')}\n` +
          '  transcript 是 claude 自己写的——先跑一次 `cmt exec <token>`（或 `cmt run`）才会有。\n',
      );
      return EXIT.OK;
    }

    // ── 汇总 ────────────────────────────────────────────────────────
    const cutoff = cutoffDay(days);
    const entries = sinceEntries(tagged, cutoff);
    const groups = groupEntries(entries, by, { platform: ctx.platform })
      .map((g) => ({ key: g.key, ...summarize(g.entries, table) }));
    const overall = summarize(entries, table);

    // ── 输出 ────────────────────────────────────────────────────────
    if (args.json) {
      process.stdout.write(JSON.stringify({
        agent: 'claude-code',
        window: { days, cutoff },
        by,
        groups,
        total: overall,
        sources: sourceStats,
        pricesFile: userPrices > 0 ? pricesFile : null,
        endpointPrices: endpointUsed,
      }, null, 2) + '\n');
      return EXIT.OK;
    }

    const windowText = days > 0 ? `最近 ${days} 天` : '全部时间';
    const head = `Claude Code 用量 · ${windowText} · ${transcriptCount} 份 transcript`;
    const lines = [head, ''];

    if (groups.length === 0) {
      lines.push(`  ${windowText}内没有记录（试 \`--days 0\` 看全部）。`, '');
    } else {
      lines.push(renderTable(groups, by, cutoff ? `${cutoff} 起` : ''));
      lines.push('');
    }

    // 价格表的状况必须说清楚：没有价格时花费那列全是 `—`，
    // 不解释一句用户只会以为"算不出来 = 没花钱"。
    const unpriced = overall.unpriced;
    if (unpriced.length > 0) {
      lines.push(`  ⚠ 这些模型没有价格，花费记为「≥」或「—」：${unpriced.join('、')}`);
      if (Object.keys(table.models).length === 0) {
        lines.push('    还没有价格。两条路：');
        lines.push('      1) 在面板里「拉取」——端点自报价（OpenRouter 形态的 pricing）时会自动记进 resources.json');
        lines.push(`      2) 新建 ${pricesFile}（**优先于**端点价），写：`);
        lines.push('         {"models": {"你的模型 id": {"input": 3, "output": 15, "cacheRead": 0.3}}}');
        lines.push('         单位是 USD / 百万 token；cacheRead / cacheWrite 不写就按 input 算。');
      } else {
        lines.push(`    往 ${pricesFile} 里补上即可（优先于端点价；支持 "前缀*" 通配）。`);
      }
      lines.push('');
    }
    for (const p of table.problems) lines.push(`  ⚠ 价格表：${p}`);

    process.stdout.write(lines.join('\n'));
    return EXIT.OK;
  },
};

// ═══════════════════════ 解析 ═══════════════════════

// 目录发现（哪些 profile、哪些 `.jsonl`）**不在这里**——`cmt pool sync` 要数出
// 一模一样的数字，所以它只有一份实现：`cli/usage-sources.js`。

/**
 * 读一份 transcript，**能用缓存就用缓存**。
 *
 * 判"没变"只看 `size + mtimeMs`：transcript 是追加写的，长度一变就重算整份。
 * 不搞"只读新增的那截"——跨批次去重（按 `message.id`）会因此在批次边界漏掉重复，
 * 那等于**多算钱**，为了快几秒不值得。
 *
 * @param {string} file
 * @param {any} cache
 * @param {boolean} refresh
 * @returns {{ entries: import('../../core/usage.js').UsageEntry[], changed: boolean } | null}
 */
function readOne(file, cache, refresh) {
  /** @type {import('node:fs').Stats} */
  let st;
  try {
    st = nodeFs.statSync(file);
  } catch {
    return null;
  }

  const hit = cache.files[file];
  if (!refresh && hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
    return { entries: decodeEntries(hit.entries), changed: false };
  }

  /** @type {string} */
  let text;
  try {
    text = nodeFs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  text = ''; // 早点放开这份大字符串（单份最大 190MB 量级）
  const { entries } = claudeFromLines(lines);

  cache.files[file] = { size: st.size, mtimeMs: st.mtimeMs, entries: encodeEntries(entries) };
  return { entries, changed: true };
}

/**
 * 记录 → 紧凑数组。键序固定，省掉 6 份字段名——90 份 transcript 下来差很多。
 * @param {import('../../core/usage.js').UsageEntry[]} entries
 */
function encodeEntries(entries) {
  return entries.map((e) => [
    e.day, e.model, e.project,
    e.tokens.input, e.tokens.cacheRead, e.tokens.cacheWrite, e.tokens.output,
  ]);
}

/**
 * @param {unknown} arr
 * @returns {import('../../core/usage.js').UsageEntry[]}
 */
function decodeEntries(arr) {
  if (!Array.isArray(arr)) return [];
  /** @type {import('../../core/usage.js').UsageEntry[]} */
  const out = [];
  for (const r of arr) {
    if (!Array.isArray(r) || r.length < 7) continue;
    const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    out.push({
      day: String(r[0] ?? ''),
      model: String(r[1] ?? ''),
      project: String(r[2] ?? ''),
      tokens: { input: n(r[3]), cacheRead: n(r[4]), cacheWrite: n(r[5]), output: n(r[6]) },
    });
  }
  return out;
}

// ═══════════════════════ 缓存 ═══════════════════════

/** @param {string} home */
function loadCache(home) {
  try {
    const o = JSON.parse(nodeFs.readFileSync(usageCachePath(home), 'utf8'));
    if (o && o.version === CACHE_VERSION && o.files && typeof o.files === 'object') return o;
  } catch { /* 坏了就当没有——它本来就是可重建的（§3.4） */ }
  return { version: CACHE_VERSION, files: {} };
}

/**
 * 缓存写失败**不算错**：下一次顶多慢一点。
 * @param {string} home
 * @param {any} cache
 */
function saveCache(home, cache) {
  try {
    nodeFs.mkdirSync(join(home, '.claude-multi-token'), { recursive: true });
    nodeFs.writeFileSync(usageCachePath(home), JSON.stringify(cache), 'utf8');
  } catch { /* 磁盘满 / 只读：不影响这次报表 */ }
}

// ═══════════════════════ 价格与花费 ═══════════════════════

// 取价的三级合并**不在这里**——`cmt ui` 的资源屏要数出一模一样的数字，
// 所以它只有一份实现：`cli/price-table.js`。

/**
 * 一个分组（或整体）的用量与花费。
 *
 * `cost` 的口径：**已定价部分之和**。`complete = false` 表示还有没定价的条目，
 * 所以这个数是**下界**——渲染成 `≥$x`，绝不冒充总额。
 *
 * @param {import('../../core/usage.js').UsageEntry[]} entries
 * @param {import('../../core/prices.js').PriceTable} table
 */
function summarize(entries, table) {
  let tokens = zeroTokens();
  let cost = 0;
  let complete = true;
  /** @type {Set<string>} */
  const unpriced = new Set();

  for (const e of entries) {
    tokens = addTokens(tokens, e.tokens);
    const c = costOf(e.tokens, priceFor(table, e.model));
    if (c === null) {
      complete = false;
      unpriced.add(e.model || '（未知模型）');
    } else {
      cost += c;
    }
  }

  return {
    tokens,
    total: totalOf(tokens),
    // 一条都没定上价 ⇒ 真不知道，给 null（渲染成 `—`），不要给 0
    cost: complete || cost > 0 ? cost : null,
    complete,
    unpriced: [...unpriced].sort(),
  };
}

// ═══════════════════════ 渲染 ═══════════════════════

/**
 * 数字列右对齐、键列左对齐的两段式表格。
 *
 * 宽度按**显示宽度**算（`displayWidth()`），否则中文/emoji 会把列拉歪。
 * @param {{ key: string, total: number, tokens: any, cost: number | null, complete: boolean }[]} groups
 * @param {string} by
 * @param {string} windowNote
 */
function renderTable(groups, by, windowNote) {
  const keyHead = by === 'project' ? '项目' : by === 'model' ? '模型' : by === 'day' ? '日期' : 'token';
  const maxKey = by === 'project' ? 48 : 30;

  /** @type {string[][]} */
  const rows = groups.map((g) => [
    clip(g.key || '（未知）', maxKey),
    fmtCount(g.tokens.input),
    fmtCount(g.tokens.cacheRead),
    fmtCount(g.tokens.cacheWrite),
    fmtCount(g.tokens.output),
    fmtCount(g.total),
    fmtCost(g.cost, g.complete),
  ]);

  rows.push([
    '合计',
    fmtCount(groups.reduce((s, g) => s + g.tokens.input, 0)),
    fmtCount(groups.reduce((s, g) => s + g.tokens.cacheRead, 0)),
    fmtCount(groups.reduce((s, g) => s + g.tokens.cacheWrite, 0)),
    fmtCount(groups.reduce((s, g) => s + g.tokens.output, 0)),
    fmtCount(groups.reduce((s, g) => s + g.total, 0)),
    totalCostText(groups),
  ]);

  const head = [keyHead, '输入', '缓存读', '缓存写', '输出', '合计', '花费'];
  const sepAt = rows.length - 1;

  const widths = head.map((h, i) => Math.max(
    displayWidth(h),
    ...rows.map((r) => displayWidth(r[i] ?? '')),
  ));

  /** @param {string[]} cells @param {string} prefix */
  const line = (cells, prefix) => prefix + cells.map((c, i) => {
    const gap = widths[i] - displayWidth(c);
    return i === 0 ? c + ' '.repeat(gap) : ' '.repeat(gap) + c;
  }).join('  ').replace(/\s+$/, '');

  const out = [line(head, '  '), '  ' + '─'.repeat(widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1))];
  for (let i = 0; i < rows.length; i++) {
    if (i === sepAt) out.push('  ' + '─'.repeat(widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1)));
    out.push(line(rows[i], '  '));
  }
  if (windowNote) out.push('', `  （自 ${windowNote}）`);
  return out.join('\n');
}

/**
 * 合计行的花费：全部定上价就给确数，否则给下界。
 * @param {{ cost: number | null, complete: boolean }[]} groups
 */
function totalCostText(groups) {
  let sum = 0;
  let known = 0;
  let unknown = 0;
  for (const g of groups) {
    if (g.cost === null) unknown++;
    else {
      sum += g.cost;
      if (!g.complete) known++; // 有数但只是下界
    }
  }
  if (unknown > 0 && sum === 0) return '—';
  return (unknown > 0 || known > 0) ? `≥${fmtMoney(sum)}` : fmtMoney(sum);
}

/**
 * @param {number | null} cost
 * @param {boolean} complete
 */
function fmtCost(cost, complete) {
  if (cost === null) return '—';
  return complete ? fmtMoney(cost) : `≥${fmtMoney(cost)}`;
}

/**
 * @param {number} n
 */
function fmtMoney(n) {
  if (!(n > 0)) return '$0';
  if (n < 0.01) return '<$0.01';
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * 表格里的 token 数用**紧凑单位**。
 *
 * 实测数据是十亿量级（一次会话的缓存读就能上到 6,194,692,992），
 * 逐位加逗号会把表宽撑到 150 列，在 80 列的终端上直接折行——
 * 一张折了行的表等于没有表。**精确值走 `--json`**，那里没有宽度约束。
 *
 * @param {number} n
 */
function fmtCount(n) {
  const abs = Math.abs(n);
  if (abs < 10_000) return n.toLocaleString('en-US');
  if (abs < 1_000_000) return `${trimZero(n / 1000)}k`;
  if (abs < 1_000_000_000) return `${trimZero(n / 1e6)}M`;
  return `${trimZero(n / 1e9)}B`;
}

/**
 * 一位小数，但整数不显示 `.0`（`12.0M` 读起来像刚好 1200 万，其实不是）。
 * @param {number} n
 */
function trimZero(n) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * 从**尾部**截断——项目路径的重点在最后一段（目录名本身），
 * 砍头不砍尾才认得出是哪个项目。
 * @param {string} s
 * @param {number} max
 */
function clip(s, max) {
  if (displayWidth(s) <= max) return s;
  const chars = [...s];
  let w = 0;
  let i = chars.length;
  while (i > 0) {
    const cw = displayWidth(chars[i - 1]);
    if (w + cw > max - 1) break;
    w += cw;
    i--;
  }
  return '…' + chars.slice(i).join('');
}

// ═══════════════════════ 参数 ═══════════════════════

/**
 * `--days`：正整数 = 含今天在内往前数 N 天；`0` / `all` = 全部时间。
 * @param {unknown} raw
 */
function parseDays(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DAYS;
  const s = String(raw).trim().toLowerCase();
  if (s === 'all' || s === '0') return 0;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) {
    throw new CmtError(`--days 要一个非负整数（或 all），收到「${String(raw)}」`, {
      hint: '例如 `cmt usage --days 30`；`--days 0` 看全部',
    });
  }
  return n;
}

const USAGE_HELP = `cmt usage —— 用量与花费统计

用法
  cmt usage [选项]

按 claude 自己写的 transcript 统计 token 用量，并按价格表折算成美元。
只读：不碰配置、不联网。

选项
  --days <n>    统计窗口：含今天在内往前 n 天（默认 ${DEFAULT_DAYS}）；0 或 all = 全部
  --by <维度>   token（默认）| project | model | day
  --json        输出机器可读的 JSON
  --refresh     忽略缓存，重新解析全部 transcript
  -h, --help    显示本帮助

价格表
  ${'<home>/.claude-multi-token/prices.json'}，单位 USD / 百万 token：

    {"models": {
      "claude-sonnet-4-5":     {"input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75},
      "deepseek-*":            {"input": 0.28, "output": 0.42}
    }}

  先精确匹配，再按 \`前缀*\` 通配（取最长前缀）。cacheRead / cacheWrite 不写就按 input 算。
  没有价格的模型花费显示成「—」，**不会**当成 0。

  价格还可能自动来：在面板里「拉取」模型清单时，端点自报的价（OpenRouter 形态的
  pricing）会记进 resources.json 垫在下面。手写的这份**永远优先**。

示例
  cmt usage                    最近 7 天，按 token
  cmt usage --by project       哪个目录最费钱
  cmt usage --days 30 --by model --json
`;
