// @ts-check
/**
 * `cxt pool` —— token 池：清单的状态与用量，以及"额度还在不在"（§2.15）。
 *
 * ```bash
 * cxt pool list
 * cxt pool import <file.csv|file.xlsx>
 * cxt pool check [name...] [--all] [--force] [--model <m>]
 * cxt pool status <name> <status>
 * cxt pool reset <name>
 * cxt pool sync [--redis <url>] [--force]
 * cxt pool pull --redis <url>
 * ```
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这个命令管的是**覆盖层**，不是第二份清单
 *
 * `tokens/<name>.json` 拥有密钥，`pool.json` 只有"这个名字上次探测是什么状态、
 * 用了多少 token"。所以：
 *
 * - **`import` 不会覆盖已有 token**（那可能正在用），只跳过并计数；
 * - **`sync` 不会给没入池的 token 建条目**——入池是**明确动作**（`import` /
 *   `check <name>` / `status <name> <status>`），不是"有用量就算"；
 * - 本文件里**一个密钥字段都不碰**：`import` 把 sk 交给 `putToken()` 就再也不看它，
 *   任何输出都不回显（§2.15 七）。
 *
 * ## 用量不用手动记
 *
 * ★ `list` **不是纯只读命令**了：它开局先调 `autoSyncUsage()`，按
 *   `config.defaults.pool.usageSeconds`（默认 600 秒）判断用量是不是过期，
 *   过期才重算一次（`pool-usage-cache.json` 只重读变过的文件）。
 *   面板与控制台的启动路径调的也是**同一个** `autoSyncUsage()`。
 *   `sync --force` 是"别信缓存、全部重读"的手动出口。
 *
 * ## 本地优先，Redis 只做镜子
 *
 * ★ **只有 `sync --redis` 与 `pull --redis` 会连 Redis**。`list` / `check` /
 * `status` / `reset` / 启动路径全程不连——这是"优先本地"的硬保证，
 * 也让没有 Redis 的环境**零感知**。
 *
 * 写穿的语义照抄原方案：本地写成功即算成功，Redis 失败只打 WARNING、**退出码不变**。
 * ─────────────────────────────────────────────────────────────
 */
import nodeFs from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';

import { CxtError, EXIT } from '../../core/errors.js';
import {
  STATUS, STATUSES, isStale, mapImportRows, poolSettings,
} from '../../core/pool.js';
import { normalizeToken, validateTokenName } from '../../core/schema.js';
import { parseCsv, parseXlsx } from '../../core/sheet.js';
import { readAllTokens, readConfig, readToken } from '../../core/store.js';
import { connect } from '../../platform/redis.js';
import { displayWidth, makePainter, table } from '../format.js';
import { applyProbe, ensureEntry, loadPool, savePool } from '../pool-store.js';
import { autoSyncUsage, syncPoolUsage } from '../pool-usage.js';
import { probeConfiguredToken } from '../probe.js';
import { ensureRoot, putToken } from '../state-edit.js';

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'json', 'all', 'force'],
  string: ['model', 'base-url', 'url', 'redis'],
  alias: { h: 'help', u: 'url' },
};

// ───────────────────────────── 词表 ─────────────────────────────

/** 状态 → 中文短标签。**只在这里定义一次**，表格与 `--json` 都从它取。 */
const STATUS_LABEL = Object.freeze({
  [STATUS.OK]: '有余额',
  [STATUS.NO_QUOTA]: '无余额',
  [STATUS.INVALID]: '密钥无效',
  [STATUS.NET_FAIL]: '连不上',
  [STATUS.OTHER]: '异常',
  [STATUS.UNKNOWN]: '未检测',
});

/** "从来没入过池"——**不是** `STATUS` 的一个值，只是列表里的显示 */
const NOT_IN_POOL = '未入池';

/**
 * Redis 键空间。前缀属于**本命令**，不放共享文件里（§2.15 六）：
 * 另一个项目用的是它自己的前缀，两者的数据不该混在一起。
 */
const REDIS_PREFIX = 'cxmt:pool';
const REDIS_NAMES = `${REDIS_PREFIX}:names`;
const REDIS_META = `${REDIS_PREFIX}:meta`;
/** @param {string} name */
const redisStateKey = (name) => `${REDIS_PREFIX}:state:${name}`;

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
export async function run(args, ctx) {
  const sub = args._[0];

  if (args.help || sub === undefined) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  switch (sub) {
    case 'list': case 'ls': return cmdList(args, ctx);
    case 'import': return cmdImport(args, ctx);
    case 'check': return cmdCheck(args, ctx);
    case 'status': return cmdStatus(args, ctx);
    case 'reset': return cmdReset(args, ctx);
    case 'sync': return cmdSync(args, ctx);
    case 'pull': return cmdPull(args, ctx);
    default:
      throw new CxtError(`未知子命令 \`cxt pool ${sub}\``, {
        hint: '可用：list / import / check / status / reset / sync / pull',
      });
  }
}

// ───────────────────────────── list ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdList(args, ctx) {
  // ★ 先顺手重算一次用量（按 `pool.usageSeconds` 的新鲜期，过期的才真的动）。
  //   **不是**只读命令了：它可能在 `pool.json` 上写一次。这正是"用量不用手动记"
  //   的全部实现——`pool list` 与面板、控制台共用同一个 `autoSyncUsage()`。
  //   ★ 它**永不抛**：一条坏记录 / 一个不可写的目录，结局是"这次的数是旧的"，
  //     不是"清单打不开"。
  const autoSync = autoSyncUsage(ctx);

  const { pool, names, dropped } = loadPool(ctx);
  const settings = poolSettings(readConfig(ctx.home).defaults?.pool);
  // ★ 与 `cxt ls` 同一条纪律：坏掉的 token 文件**照样抛**，不静默跳过——
  //   一份静默缺了东西的清单正是这个命令最不该给的东西。
  const tokens = readAllTokens(ctx.home);

  /** @type {any[]} */
  const rows = names.map((name) => {
    const entry = pool.entries[name] ?? null;
    return {
      name,
      label: typeof tokens[name]?.label === 'string' ? tokens[name].label : null,
      inPool: entry !== null,
      status: entry ? entry.status : STATUS.UNKNOWN,
      statusLabel: entry ? (STATUS_LABEL[entry.status] ?? entry.status) : NOT_IN_POOL,
      detail: entry ? entry.detail : '',
      checkedAt: entry ? entry.checkedAt : '',
      calls: entry ? entry.calls : 0,
      in: entry ? entry.in : 0,
      out: entry ? entry.out : 0,
    };
  });
  const inPoolCount = rows.filter((r) => r.inPool).length;

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      agent: 'codex',
      updatedAt: pool.updatedAt,
      settings,
      // ★ `null` = 这次没重算（池是空的 / 全部还在新鲜期内）。有值才说明动过盘。
      autoSync: autoSync === null ? null : {
        filesRead: autoSync.filesRead,
        filesCached: autoSync.filesCached,
        tokens: autoSync.names.length,
      },
      counts: { tokens: rows.length, inPool: inPoolCount, dropped },
      // ★ 这里**没有** secret 这个键，也永远不该有（§2.15 铁律）
      tokens: rows,
      redisPreset: pool.redis !== '' || (typeof ctx.env.CXT_REDIS_URL === 'string' && ctx.env.CXT_REDIS_URL !== ''),
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  if (rows.length === 0) {
    process.stdout.write(
      '\n  还没有任何 token。\n'
      + '    单个加：cxt token add <name> --token <密钥> --base-url <端点>\n'
      + '    批量加：cxt pool import <file.csv|file.xlsx>（名字在第 1 列、密钥在第 2 列）\n\n',
    );
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  const out = [''];

  out.push(`  ${c.bold(`Token 池`)}  ${rows.length} 个 token · 入池 ${inPoolCount}`
    + `  ${c.dim(`（策略 ${settings.policy} · 新鲜期 ${settings.cacheSeconds}s · 重算 ${settings.usageSeconds}s · 补空位 ${settings.auto ? '开' : '关'}）`)}`);
  out.push('');

  // ★ 数忽然变了总得有个解释：说一句"这次重算过了"，否则用户只会以为算错了。
  //   没重算就一个字都不说——那是**常态**（TTL 内反复打开），说多了就成了噪音。
  if (autoSync !== null) {
    out.push(`  ${c.dim(`用量已顺手重算：读了 ${autoSync.filesRead} 份记录`
      + `（${autoSync.filesCached} 份没变，走的缓存）`)}`);
    out.push('');
  }

  out.push(table(
    ['token', '状态', '调用', '输入', '输出', '检测', '备注'],
    rows.map((r) => [
      r.label ? `${r.name}（${r.label}）` : r.name,
      // ★ 表格里**不上色**：`table()` 的 `color` 要的是 ANSI 码，
      //   而 painter 给的是包好码的闭包——塞进去就是把函数源码打进表格。
      //   需要颜色的地方（下面的"非 ok"清单）直接用 painter。
      r.statusLabel,
      fmtCount(r.calls),
      fmtCount(r.in),
      fmtCount(r.out),
      r.checkedAt === '' ? '—' : stamp(r.checkedAt),
      clip(r.detail, 40),
    ]),
  ));
  out.push('');

  // ★ `ok` 的 detail 是 `HTTP 200 · 812ms`，一眼能看见的就别重复；
  //   非 ok 的才是要找原因的，单独列出来（表格里放不下完整的 detail）。
  const troubles = rows.filter((r) => r.inPool && r.status !== STATUS.OK && r.detail !== '');
  if (troubles.length > 0) {
    out.push(`  ${c.bold('非 ok 的条目')}`);
    for (const r of troubles) {
      const label = padEndW(STATUS_LABEL[r.status] ?? r.status, 10);
      out.push(`    ${statusColor(c, r.status)(label)} ${r.name}`);
      out.push(`      ${c.dim(r.detail)}`);
    }
    out.push('');
  }

  if (inPoolCount === 0) {
    out.push(`  ${c.dim('池是空的：`cxt pool import <file>` 批量入池，或 `cxt pool check <名字>` 单独入池。')}`);
    out.push('');
  } else if (inPoolCount < rows.length) {
    out.push(`  ${c.dim(`有 ${rows.length - inPoolCount} 个 token 未入池——它们不会被自动挑中，也不会被 \`pool sync\` 更新。`)}`);
    out.push('');
  }

  out.push(`  ${c.dim('状态来自探测；`cxt pool check` 重探，`cxt pool status <name> <status>` 手动覆盖。')}`);
  if (dropped > 0) {
    out.push(`  ${c.dim(`（顺手清掉 ${dropped} 条孤立条目：对应的 token 文件已经不在，下次写盘就真的没了。）`)}`);
  }
  out.push('');

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ───────────────────────────── import ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdImport(args, ctx) {
  const file = args._[1];
  if (file === undefined) {
    throw new CxtError('缺少文件路径', {
      hint: 'cxt pool import <file.csv|file.xlsx>\n'
        + '表格第 1 列是 token 名、第 2 列是密钥；首行可以是表头。',
    });
  }

  const abs = resolvePath(ctx.cwd, String(file));
  const rows = readSheet(abs);

  const { items, skipped } = mapImportRows(rows);
  const { pool, names } = loadPool(ctx);
  const existing = new Set(names);
  const baseUrl = args['base-url'] ?? args.url;

  /** @type {string[]} */
  const created = [];
  let existed = 0;
  let bad = 0;
  /** @type {string | null} */
  let firstError = null;

  for (const item of items) {
    if (existing.has(item.name)) {
      existed += 1;
      continue;
    }
    /** @type {any} */
    let token;
    try {
      token = normalizeToken({
        name: item.name,
        authToken: item.secret,
        ...(baseUrl === undefined ? {} : { baseUrl }),
      }, item.name);
    } catch (err) {
      bad += 1;
      if (firstError === null) firstError = messageOf(err);
      continue;
    }

    // ★ 第一次真的要写盘时才建根目录：一份全是垃圾行的文件不该
    //   在用户 home 里留下一个空的 `.codex-multi-token/`。
    ensureRoot(ctx);
    putToken(ctx, item.name, token);
    ensureEntry(pool, item.name);
    existing.add(item.name);
    created.push(item.name);
  }

  const added = created.length;
  if (added > 0) savePool(ctx, pool);

  const total = added + existed + bad + skipped.blank + skipped.header + skipped.malformed + skipped.duplicate;

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'import',
      file: abs,
      added,
      created,
      skipped: {
        total: total - added,
        existing: existed,
        malformed: bad,
        blank: skipped.blank,
        header: skipped.header,
        duplicate: skipped.duplicate,
        badShape: skipped.malformed,
      },
      firstError,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  const out = [''];
  out.push(`  ${c.green('✓')} 读 ${abs}`);
  // ★ 契约钉死的那一行（§2.15 八）。多出来的类别**另起一行缩进**，
  //   不去挤这一句——它是被脚本认的。
  out.push(`  新增 ${added} / 跳过 ${total - added}（已存在 ${existed}、格式不符 ${bad + skipped.malformed}）`);

  /** @type {string[]} */
  const extras = [];
  if (skipped.blank > 0) extras.push(`空行 ${skipped.blank}`);
  if (skipped.header > 0) extras.push(`表头 ${skipped.header}`);
  if (skipped.duplicate > 0) extras.push(`重名 ${skipped.duplicate}`);
  if (extras.length > 0) out.push(`    ${c.dim(`另有：${extras.join('、')}`)}`);

  if (created.length > 0) {
    out.push('');
    out.push(`  已建：${created.join('、')}  ${c.dim('（密钥写进各自的 tokens/<name>.json，不在这份表格里）')}`);
  }
  if (firstError !== null) {
    out.push('');
    out.push(`  ${c.yellow('⚠')} 有一行没建成功，原因示例：${firstError}`);
  }
  if (added > 0) {
    out.push('');
    out.push(`  ${c.dim('下一步：`cxt pool check` 探一遍额度（每把 key 会发一次最小请求）。')}`);
  }
  out.push('');
  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

/**
 * 读表格 → `string[][]`。
 * @param {string} abs
 * @returns {string[][]}
 */
function readSheet(abs) {
  /** @type {Buffer} */
  let buf;
  try {
    buf = nodeFs.readFileSync(abs);
  } catch (err) {
    throw new CxtError(`读不到表格：${abs}`, {
      hint: `系统说：${messageOf(err)}\n路径是相对**当前目录**算的：${abs}`,
    });
  }

  const ext = extname(abs).toLowerCase();
  if (ext === '.xls') {
    throw new CxtError('不支持老式 .xls（二进制 BIFF 格式）', {
      hint: '用 Excel 另存为 .xlsx 或 .csv 再来。',
    });
  }

  try {
    if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(buf);
    if (ext === '.csv' || ext === '.txt' || ext === '') return parseCsv(buf.toString('utf8'));
  } catch (err) {
    throw new CxtError(`表格解析失败：${messageOf(err)}`, {
      hint: 'csv 用 UTF-8 或 GBK 另存为逗号分隔；xlsx 不要加密、不要只发一个链接文件。',
    });
  }

  throw new CxtError(`不认识的文件类型「${ext || '(无扩展名)'}」`, {
    hint: '只认 .csv / .txt / .xlsx / .xlsm。',
  });
}

// ───────────────────────────── check ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function cmdCheck(args, ctx) {
  const { pool, names } = loadPool(ctx);
  const settings = poolSettings(readConfig(ctx.home).defaults?.pool);

  const requested = args._.slice(1).map((v) => String(v));
  const known = new Set(names);
  const ghosts = requested.filter((n) => !known.has(n));
  if (ghosts.length > 0) {
    throw new CxtError(`没有这些 token：${ghosts.join('、')}`, {
      hint: '`cxt ls` 看全部；`cxt pool import <file>` 批量建。',
    });
  }

  // ★ 三档，别混：
  //   `check <名字>`  = 点名的（没入池的会就此入池）
  //   `check --all`   = **全部 token**（没入池的也拉进来）
  //   `check`（裸的） = 池里已有的条目
  // 裸命令不替用户做"把 18 个 token 全拉进池"这种决定——入池是明确动作。
  const targets = requested.length > 0
    ? requested
    : args.all === true
      ? names
      : Object.keys(pool.entries);

  if (targets.length === 0) {
    process.stdout.write(
      '\n  池里还没有条目。\n'
      + `    全部 ${names.length} 个 token 一起探：cxt pool check --all\n`
      + '    批量入池：cxt pool import <file.csv|file.xlsx>\n'
      + '    单个入池：cxt pool check <名字>\n\n',
    );
    return EXIT.OK;
  }

  const now = new Date();
  /** @type {any[]} */
  const results = [];
  let probed = 0;

  for (const name of targets) {
    const entry = ensureEntry(pool, name);
    if (args.force !== true && !isStale(entry, now, { cacheSeconds: settings.cacheSeconds })) {
      results.push({
        name,
        status: entry.status,
        statusLabel: STATUS_LABEL[entry.status] ?? entry.status,
        detail: entry.detail,
        checkedAt: entry.checkedAt,
        skipped: true,
      });
      continue;
    }

    // 只在真的要探、而且不止一个时才报进度——单个探测的等待感不值得多一行。
    if (targets.length > 1 && args.json !== true) {
      process.stderr.write(`  正在探测 ${probed + 1}/${targets.length} · ${name}\n`);
    }

    const r = await probeConfiguredToken(ctx, name, { model: args.model });
    applyProbe(entry, r, now);
    results.push({
      name,
      status: r.status,
      statusLabel: STATUS_LABEL[r.status] ?? r.status,
      detail: r.detail,
      checkedAt: now.toISOString(),
      httpStatus: r.httpStatus,
      elapsedMs: r.elapsedMs,
      model: r.model,
      skipped: false,
    });
    probed += 1;
  }

  if (probed > 0) savePool(ctx, pool, now);

  /** @type {Record<string, number>} */
  const byStatus = {};
  for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'check',
      probed,
      skipped: results.length - probed,
      byStatus,
      results,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  const out = [''];

  for (const r of results) {
    const mark = r.skipped ? c.dim('·') : r.status === STATUS.OK ? c.green('✓') : c.red('✗');
    const label = padEndW(r.statusLabel, 8);
    const when = r.skipped ? c.dim('（还是新鲜的，--force 可强探）') : c.dim(r.detail);
    out.push(`  ${mark} ${padEndW(r.name, 20)} ${statusColor(c, r.status)(label)} ${when}`);
  }

  out.push('');
  const parts = STATUSES
    .filter((s) => s !== STATUS.UNKNOWN && byStatus[s] !== undefined)
    .map((s) => `${STATUS_LABEL[s]} ${byStatus[s]}`);
  out.push(`  探测 ${probed} 个${results.length > probed ? `、跳过 ${results.length - probed} 个新鲜的` : ''}`
    + `${parts.length > 0 ? ` · ${parts.join(' / ')}` : ''}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ───────────────────────────── status / reset ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdStatus(args, ctx) {
  const name = validateTokenName(args._[1]);
  const want = args._[2];

  if (want === undefined) {
    throw new CxtError('缺少状态值', {
      hint: `可选：${STATUSES.join(' / ')}\n例：cxt pool status ${name} no_quota`,
    });
  }
  if (!STATUSES.includes(String(want))) {
    throw new CxtError(`不认识的 status「${String(want)}」`, {
      hint: `可选：${STATUSES.join(' / ')}`,
    });
  }
  if (readToken(ctx.home, name) === null) {
    throw new CxtError(`token "${name}" 不存在`, {
      hint: '`cxt ls` 看全部；要新建用 `cxt token add`。',
    });
  }

  const { pool } = loadPool(ctx);
  const entry = ensureEntry(pool, name);
  entry.status = /** @type {string} */ (String(want));
  // ★ 记 `manual` 而不是编一句假 detail：下次 `pool list` 一眼就能看出
  //   "这个状态是人说的，不是探出来的"。
  entry.detail = 'manual';
  entry.checkedAt = new Date().toISOString();
  savePool(ctx, pool);

  return ack(args, ctx, `已把 ${name} 标成「${STATUS_LABEL[entry.status] ?? entry.status}」`, {
    action: 'status', name, status: entry.status,
  });
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdReset(args, ctx) {
  const name = validateTokenName(args._[1]);
  if (readToken(ctx.home, name) === null) {
    throw new CxtError(`token "${name}" 不存在`, {
      hint: '`cxt ls` 看全部。',
    });
  }

  const { pool } = loadPool(ctx);
  const entry = ensureEntry(pool, name);
  // ★ 只清**状态**：`calls / in / out` 是账本，与"上次探得怎么样"无关。
  entry.status = STATUS.UNKNOWN;
  entry.detail = '';
  entry.checkedAt = '';
  savePool(ctx, pool);

  return ack(args, ctx, `已清掉 ${name} 的状态（用量保留，下次 pool check 会重探）`, {
    action: 'reset', name, status: STATUS.UNKNOWN,
  });
}

// ───────────────────────────── sync / pull ─────────────────────────────

/**
 * 从 rollout 重算用量。
 *
 * ★ 只更新**已入池**的 token：`pool sync` 是账本刷新，不是入池动作。
 * ★ 真正的活在 `cli/pool-usage.js` 的 `syncPoolUsage()` 里——网页控制台的
 *   「重算用量」按钮走的是**同一个函数**。两端各写一份的话，"页面上的花费"与
 *   "命令行里的花费"迟早对不上，而且**没有任何报错**。
 * ★ 它**按模型分开记**（`entry.models`）+ 盖 `entry.usageAt`：花费只能从模型
 *   明细算出来，而"0 用量"与"从没算过"必须能区分（§2.15 九 9.1）。
 * ★ **增量**：没变过的 rollout（`size + mtimeMs` 与缓存一致）直接复用上次的解析结果。
 *   `--force` 绕过缓存全部重读——只在"我怀疑账不对"时才需要。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function cmdSync(args, ctx) {
  const { pool } = loadPool(ctx);
  const names = Object.keys(pool.entries);

  if (names.length === 0) {
    process.stdout.write(
      '\n  池里还没有条目，没有可同步的对象。\n'
      + '    批量入池：cxt pool import <file.csv|file.xlsx>\n\n',
    );
    return EXIT.OK;
  }

  const { filesRead, filesCached, totals } = syncPoolUsage(
    ctx, pool, new Date(), { force: args.force === true },
  );

  const url = resolveRedisUrl(args, pool, ctx.env);
  /** @type {string | null} */
  let redisWarning = null;
  if (url !== null) {
    try {
      await writeThrough(url, pool);
    } catch (err) {
      redisWarning = messageOf(err);
    }
  }

  const rows = names.map((n) => ({ name: n, ...totals[n] }));

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'sync',
      files: filesRead,
      // ★ 走缓存没重读的份数。想让"每一份都真的重读"就 `--force`。
      cached: filesCached,
      force: args.force === true,
      redis: url === null ? null : { attempted: true, ok: redisWarning === null },
      warning: redisWarning,
      total: {
        calls: rows.reduce((s, r) => s + r.calls, 0),
        in: rows.reduce((s, r) => s + r.in, 0),
        out: rows.reduce((s, r) => s + r.out, 0),
      },
      tokens: rows,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  const out = [''];
  out.push(`  ${c.bold('同步用量')}  ${filesRead} 份 rollout`
    + (filesCached > 0 ? `  ${c.dim(`（另有 ${filesCached} 份没变，走的缓存；--force 可全部重读）`)}` : ''));
  out.push('');
  out.push(table(
    ['token', '调用', '输入', '输出'],
    rows.map((r) => [r.name, fmtCount(r.calls), fmtCount(r.in), fmtCount(r.out)]),
  ));
  out.push('');
  if (url === null) {
    out.push(`  ${c.dim('（没配 Redis，只写了本地 pool.json）')}`);
  } else if (redisWarning !== null) {
    // ★ 退出码不变：Redis 是镜子，镜子裂了不影响人照本地这份
    out.push(`  ${c.yellow('⚠')} Redis 写穿失败（本地已保存）：${redisWarning}`);
  } else {
    out.push(`  ${c.green('✓')} 已写穿到 Redis`);
  }
  out.push('');
  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

/**
 * 把 Redis 里的**状态**拉回本地。
 *
 * ★ 只搬 `status / detail / checkedAt` 三件：用量是本机 rollout 算出来的，
 *   "从别处拉一份用量回来"没有意义（那台机器的会话不在这台机器上）。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function cmdPull(args, ctx) {
  const { pool, names } = loadPool(ctx);
  const url = resolveRedisUrl(args, pool, ctx.env);
  if (url === null) {
    throw new CxtError('没有 Redis 地址', {
      hint: 'cxt pool pull --redis <url>\n'
        + '也可以设环境变量 CXT_REDIS_URL，或写进 pool.json 的 redis 字段。',
    });
  }

  const known = new Set(names);
  /** @type {any} */
  let client;
  try {
    client = await connect(url);
  } catch (err) {
    // ⚠️ 这里**不回显 url**——它可能带密码
    throw new CxtError(`连不上 Redis：${messageOf(err)}`, {
      hint: '检查地址 / 服务是否在跑 / 密码是否正确。',
    });
  }

  let loaded = 0;
  let kept = 0;
  let skippedUnknown = 0;
  let skippedEmpty = 0;
  try {
    const rawNames = await client.call('SMEMBERS', REDIS_NAMES);
    const remoteNames = Array.isArray(rawNames) ? rawNames.map((v) => String(v)).sort() : [];

    for (const name of remoteNames) {
      // 本地没有这个 token ⇒ 它的身份不在这台机器上，状态搬过来也没有用
      if (!known.has(name)) {
        skippedUnknown += 1;
        continue;
      }
      const flat = await client.call('HGETALL', redisStateKey(name));
      const obj = pairsToObject(flat);
      if (obj === null || obj.status === undefined) {
        skippedEmpty += 1;
        continue;
      }

      const entry = ensureEntry(pool, name);
      const incoming = {
        status: String(obj.status ?? ''),
        detail: String(obj.detail ?? ''),
        checkedAt: String(obj.checkedAt ?? ''),
      };
      // 本地更新就不覆盖：`pull` 是"补课"，不是"回滚"
      if (!isFresher(incoming.checkedAt, entry.checkedAt)) {
        kept += 1;
        continue;
      }
      entry.status = incoming.status;
      entry.detail = incoming.detail;
      entry.checkedAt = incoming.checkedAt;
      loaded += 1;
    }
  } finally {
    client.close();
  }

  if (loaded > 0) savePool(ctx, pool);

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'pull',
      merged: loaded,
      keptLocal: kept,
      skippedUnknown,
      skippedEmpty,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  const out = [''];
  out.push(`  ${c.green('✓')} 从 Redis 合并 ${loaded} 条状态`
    + `${kept > 0 ? ` · 本地更新、没覆盖 ${kept} 条` : ''}`);
  if (skippedUnknown > 0) out.push(`  ${c.dim(`跳过 ${skippedUnknown} 个本地没有的 token`)}`);
  if (skippedEmpty > 0) out.push(`  ${c.dim(`跳过 ${skippedEmpty} 个空条目`)}`);
  out.push('');
  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ───────────────────────────── Redis ─────────────────────────────

/**
 * 取址顺序：`--redis` ＞ 环境变量 ＞ `pool.json.redis`。
 * 三者都支持 `env:VAR` 间接引用（地址可能带密码，命令行会被 `ps` 看见）。
 *
 * @param {any} args
 * @param {{ redis: string }} pool
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function resolveRedisUrl(args, pool, env) {
  /** @type {unknown[]} */
  const candidates = [args.redis, env.CXT_REDIS_URL, pool.redis];
  for (const raw of candidates) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    return expandEnvRef(raw.trim(), env);
  }
  return null;
}

/**
 * @param {string} value
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
function expandEnvRef(value, env) {
  if (!value.startsWith('env:')) return value;
  const name = value.slice('env:'.length).trim();
  if (name === '') {
    throw new CxtError('`env:` 后面没写变量名', { hint: '例：--redis env:MY_REDIS_URL' });
  }
  const v = env[name];
  if (typeof v !== 'string' || v === '') {
    throw new CxtError(`环境变量 ${name} 没设置（或者为空）`, {
      hint: `要么先设置它，要么直接给地址：--redis <url>`,
    });
  }
  return v.trim();
}

/**
 * 把整个池写进 Redis。
 *
 * 失败**向上抛**，由调用方决定是"警告"还是"报错"——`sync` 选警告（本地已写），
 * `pull` 根本不走这里。
 * @param {string} url
 * @param {ReturnType<typeof loadPool>['pool']} pool
 */
async function writeThrough(url, pool) {
  const client = await connect(url);
  try {
    /** @type {string[]} */
    const names = [];
    for (const [name, e] of Object.entries(pool.entries)) {
      names.push(name);
      await client.call(
        'HSET', redisStateKey(name),
        'status', e.status,
        'detail', e.detail,
        'checkedAt', e.checkedAt,
        'calls', String(e.calls),
        'in', String(e.in),
        'out', String(e.out),
      );
    }
    if (names.length > 0) await client.call('SADD', REDIS_NAMES, ...names);
    await client.call('HSET', REDIS_META, 'updatedAt', pool.updatedAt, 'version', String(pool.version));
  } finally {
    client.close();
  }
}

/**
 * `HGETALL` 的扁平数组 → 对象。
 *
 * ★ 不能假定 `type: 'map'`：老版本 / 某些客户端库的回包形状不同，
 *   而这个客户端就是按"扁平数组"解的。
 * @param {unknown} flat
 * @returns {Record<string, string> | null}
 */
function pairsToObject(flat) {
  if (!Array.isArray(flat)) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out[String(flat[i])] = String(flat[i + 1]);
  }
  return out;
}

/**
 * `incoming` 是否比 `local` 更晚。
 * @param {string} incoming
 * @param {string} local
 */
function isFresher(incoming, local) {
  const a = Date.parse(incoming);
  const b = Date.parse(local);
  if (!Number.isFinite(a)) return false;
  if (!Number.isFinite(b)) return true;
  return a > b;
}

// ───────────────────────────── 渲染小工具 ─────────────────────────────

/**
 * @param {ReturnType<typeof makePainter>} c
 * @param {string} status
 */
function statusColor(c, status) {
  switch (status) {
    case STATUS.OK: return c.green;
    case STATUS.NO_QUOTA:
    case STATUS.OTHER: return c.yellow;
    case STATUS.INVALID:
    case STATUS.NET_FAIL: return c.red;
    default: return c.dim;
  }
}

/** @param {any} args @param {import('../types.js').Ctx} ctx @param {string} line @param {any} extra */
function ack(args, ctx, line, extra) {
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...extra }, null, 2)}\n`);
    return EXIT.OK;
  }
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  process.stdout.write(`\n  ${c.green('✓')} ${line}\n\n`);
  return EXIT.OK;
}

/**
 * 紧凑数字：表宽有限，十亿量级逐位加逗号会把 80 列终端撑爆。
 * （精确值走 `--json`，那里没有宽度约束。）
 * @param {number} n
 */
function fmtCount(n) {
  const abs = Math.abs(n);
  if (abs < 10_000) return String(n);
  if (abs < 1_000_000) return `${trimZero(n / 1000)}k`;
  if (abs < 1_000_000_000) return `${trimZero(n / 1e6)}M`;
  return `${trimZero(n / 1e9)}B`;
}

/** @param {number} n */
function trimZero(n) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** @param {string} iso */
function stamp(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 按**显示宽度**补齐（中文占两格）。
 * @param {string} s
 * @param {number} width
 */
function padEndW(s, width) {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/**
 * @param {string} s
 * @param {number} max
 */
function clip(s, max) {
  if (displayWidth(s) <= max) return s;
  const chars = [...s];
  let w = 0;
  let i = 0;
  while (i < chars.length && w + displayWidth(chars[i]) <= max - 1) {
    w += displayWidth(chars[i]);
    i += 1;
  }
  return `${chars.slice(0, i).join('')}…`;
}

/** @param {unknown} err */
function messageOf(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

const HELP = `cxt pool <子命令> [选项]

Token 池：给已有的 token 记一份"额度还在不在 + 用了多少"，并在启动前挑一个。
★ 池**不是**第二份 token 清单——密钥永远只在 tokens/<name>.json 里，
  pool.json 只记名字、状态、用量（可随时删掉，删了只是重探一次）。

子命令：
  cxt pool list
      所有 token + 状态 + 用量。没入池的标「未入池」。
  cxt pool import <file.csv|file.xlsx>
      批量建 token + 建条目。第 1 列名字、第 2 列密钥；首行可以是表头。
      ★ 已存在的名字**跳过**，不覆盖（那可能正在用）。
  cxt pool check [name...] [--all] [--force] [--model <m>]
      探测额度：对每把 key 发一次最小的真实请求（会真的花一点点钱）。
      不带参数 = 池里已有的条目；--all = **全部 token**（没入池的拉进来）；
      --force 无视新鲜度窗口。
      ★ 只有 check 点名 / --all / import 才会把一个 token 拉进池。
  cxt pool status <name> <status>
      手动覆盖状态（detail 记 "manual"）。
      status: ${STATUSES.join(' | ')}
  cxt pool reset <name>
      清掉状态（回到 unknown），用量保留。
  cxt pool sync [--redis <url>]
      从本机 rollout 重算用量。带 --redis 时**额外**写穿一份到 Redis。
  cxt pool pull --redis <url>
      反向：把 Redis 里的**状态**拉回本地（用量不动）。

选项：
  --redis <url>      redis:// | rediss:// | unix://；也可写 env:VAR 间接引用
                     取址顺序：--redis ＞ 环境变量 CXT_REDIS_URL ＞ pool.json 的 redis
  --model <m>        探测用的模型（默认取该 token 的 models[0]，再不行用内置默认）
  --base-url <u>     import 时给所有新 token 一个端点（别名 --url）
  --json             机器可读输出
  -h, --help         本帮助

新鲜度（不再白烧请求）：
  没探过 ⇒ 立刻探；ok / 异常 / 连不上 ⇒ 超过 cacheSeconds（默认 300 秒）才重探；
  无余额 ⇒ **跨月**才重探（额度按月刷新）；密钥无效 ⇒ 24 小时后重探。

本地优先：list / check / status / reset / 启动全程**不连 Redis**。
  只有 sync --redis 与 pull 会连；Redis 写失败只警告，退出码不变。
`;

export const command = { spec, run };
