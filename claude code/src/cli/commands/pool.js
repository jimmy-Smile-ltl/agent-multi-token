// @ts-check
/**
 * `cmt pool` —— token 池：清单状态 + 分配策略（§2.13）。
 *
 * ─────────────────────────────────────────────────────────────
 * **池不是第二份 token 清单**（§2.13 一）。`tokens/<name>.json` 仍然是密钥唯一的家，
 * 这里只维护一张**按 token 名索引的覆盖层**：
 *
 * | 命令 | 读写什么 |
 * |---|---|
 * | `list`   | 读 `tokens/*` + `pool.json`；**顺手重算过期的用量**（§2.13 九，不是纯只读） |
 * | `import` | 表格 → `tokens/<name>.json`（走 `saveToken()`）+ 建条目 |
 * | `check`  | 发一次最小真实请求（**会花钱**）→ 把状态盖到条目上 |
 * | `status` / `reset` | 手改条目状态 |
 * | `sync`   | 从 claude 自己写的 transcript 重算 `calls / in / out`（`--force` 全部重读） |
 * | `pull`   | 把 Redis 里的状态合并回本地（可选能力） |
 *
 * ## 用量不用手动记
 *
 * ★ `list` **不是纯只读命令**了：它开局先调 `autoSyncUsage()`，按
 *   `config.defaults.pool.usageSeconds`（默认 600 秒）判断用量是不是过期，
 *   过期才重算一次（`pool-usage-cache.json` 只重读变过的文件）。
 *   面板与控制台的启动路径调的也是**同一个** `autoSyncUsage()`。
 *   `sync --force` 是"别信缓存、全部重读"的手动出口。
 *
 * ★ **本地优先，Redis 永不当主**（§2.13 五）：`list` / `import` / `check` / `status` /
 *   `reset` 一行 Redis 代码都不碰；只有 `sync`（显式带 `--redis`）与 `pull` 会连。
 *   写穿失败只打一句 ⚠，**退出码不变**——本地写成功就算成功。
 *
 * ★ 所有输出**只印名字与状态**，永不回显任何 `sk`（§五 脱敏规则）。
 * ─────────────────────────────────────────────────────────────
 */
import nodeFs from 'node:fs';
import { extname, resolve as resolvePath } from 'node:path';

import { CmtError, EXIT } from '../../core/errors.js';
import {
  STATUS, STATUSES, isStale, mapImportRows, normalizeStatus, poolSettings, statusLabel,
} from '../../core/pool.js';
import { normalizeToken, validateTokenName } from '../../core/schema.js';
import { parseCsv, parseXlsx } from '../../core/sheet.js';
import { listTokenNames, loadConfig, loadToken, saveToken } from '../../core/store.js';
import { connect } from '../../platform/redis.js';
import { RESET, displayWidth, makePainter, padEnd } from '../format.js';
import { applyProbe, ensureEntry, loadPool, savePool } from '../pool-store.js';
import { autoSyncUsage, syncPoolUsage } from '../pool-usage.js';
import { probeConfiguredToken } from '../probe.js';

/**
 * @type {any}
 */
const spec = {
  boolean: ['help', 'json', 'all', 'force'],
  string: ['model', 'base-url', 'url', 'redis'],
  alias: { h: 'help', u: 'url' },
};

/** 有 token 但还没条目时的展示词（不是第六档状态——那是"未知"，这是"根本没入池"） */
const NOT_IN_POOL = '未入池';

// ★ Redis 键前缀是**本项目**的常量，不进共享文件（§2.13 五）。
const REDIS_PREFIX = 'cmt:pool';
const REDIS_NAMES = `${REDIS_PREFIX}:names`;
const REDIS_META = `${REDIS_PREFIX}:meta`;
/**
 * @param {string} name
 */
const redisStateKey = (name) => `${REDIS_PREFIX}:state:${name}`;

export const poolCommand = {
  spec,

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    const sub = args._[0];

    if (args.help || sub === undefined) {
      process.stdout.write(POOL_HELP);
      return EXIT.OK;
    }

    switch (sub) {
      case 'list':
      case 'ls':
        return cmdList(args, ctx);
      case 'import':
        return cmdImport(args, ctx);
      case 'check':
        return await cmdCheck(args, ctx);
      case 'status':
        return cmdStatus(args, ctx);
      case 'reset':
        return cmdReset(args, ctx);
      case 'sync':
        return await cmdSync(args, ctx);
      case 'pull':
        return await cmdPull(args, ctx);
      default:
        throw new CmtError(`未知子命令 \`cmt pool ${sub}\``, {
          hint: '可用：list / import / check / status / reset / sync / pull',
        });
    }
  },
};

// ═══════════════════════════ list ═══════════════════════════

/**
 * 所有 token + 池状态 + 用量。**不是纯只读命令**：开局先按 `pool.usageSeconds`
 * 判断用量是否过期，过期才重算一次（§2.13 九）。没重算时一个字节都不写。
 *
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
  const settings = poolSettings(loadConfig({ home: ctx.home }).config.defaults?.pool);
  const painter = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: args.json === true });

  /** @type {any[]} */
  const rows = [];
  for (const name of names) {
    const { token } = loadToken({ home: ctx.home, name });
    const entry = pool.entries[name];
    const inPool = entry !== undefined;
    rows.push({
      name,
      label: token?.label ?? '',
      inPool,
      status: inPool ? entry.status : STATUS.UNKNOWN,
      statusLabel: inPool ? statusLabel(entry.status) : NOT_IN_POOL,
      detail: inPool ? entry.detail : '',
      checkedAt: inPool ? entry.checkedAt : '',
      calls: inPool ? entry.calls : 0,
      in: inPool ? entry.in : 0,
      out: inPool ? entry.out : 0,
    });
  }

  const inPoolCount = rows.filter((r) => r.inPool).length;

  if (args.json) {
    // ⚠️ 这里**没有** secret 键，将来也别加：`--json` 是会被贴进 issue 的形态。
    process.stdout.write(`${JSON.stringify({
      agent: 'claude-code',
      updatedAt: pool.updatedAt,
      settings,
      // ★ `null` = 这次没重算（池是空的 / 全部还在新鲜期内）。有值才说明动过盘。
      autoSync: autoSync === null ? null : {
        filesRead: autoSync.filesRead,
        filesCached: autoSync.filesCached,
        tokens: autoSync.names.length,
      },
      counts: { tokens: rows.length, inPool: inPoolCount, dropped },
      tokens: rows,
      redisPreset: pool.redis,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const policyText = settings.policy === 'round-robin' ? '轮询' : '最少消耗';
  /** @type {string[]} */
  const out = [
    `Token 池  ${rows.length} 个 token · 入池 ${inPoolCount}`
      + `  （策略 ${policyText} · 新鲜期 ${settings.cacheSeconds}s`
      + ` · 重算 ${settings.usageSeconds}s · 补空位 ${settings.auto ? '开' : '关'}）`,
    '',
  ];

  // ★ 数忽然变了总得有个解释：说一句"这次重算过了"，否则用户只会以为算错了。
  //   没重算就一个字都不说——那是**常态**（TTL 内反复打开），说多了就成了噪音。
  if (autoSync !== null) {
    out.push(`  ${painter.dim(`用量已顺手重算：读了 ${autoSync.filesRead} 份记录`
      + `（${autoSync.filesCached} 份没变，走的缓存）`)}`);
    out.push('');
  }

  if (rows.length === 0) {
    out.push('  还没有任何 token。两条路：');
    out.push('    cmt token add <name> --token <sk-...>     建一个');
    out.push('    cmt pool import <file.csv|file.xlsx>        从表格批量建');
    out.push('');
    process.stdout.write(out.join('\n'));
    return EXIT.OK;
  }

  out.push(renderTable(painter, rows));
  out.push('');

  // 「非 ok 的条目」单独摆一遍：表里那一列在 80 列终端上放不下 detail，
  // 而 detail 恰恰是"为什么不是 ok"的唯一线索。
  const notOk = rows.filter((r) => r.inPool && r.status !== STATUS.OK && r.status !== STATUS.UNKNOWN);
  if (notOk.length > 0) {
    out.push('  非 ok 的条目');
    for (const r of notOk) {
      const tint = statusColor(painter, r.status);
      out.push(
        `    ${padEnd(r.name, 20)} ${tint(padEnd(r.statusLabel, 8))}`
          + `  ${r.detail === '' ? painter.dim('（没有说明）') : clip(r.detail, 60)}`,
      );
    }
    out.push('');
  }

  const missing = rows.filter((r) => !r.inPool);
  if (missing.length > 0) {
    const shown = missing.slice(0, 8).map((r) => r.name).join('、');
    const more = missing.length > 8 ? ` 等 ${missing.length} 个` : '';
    out.push(`  ℹ 还没入池：${shown}${more}`);
    out.push('    `cmt pool check --all` 会顺带把条目建上并各探一次');
    out.push('');
  }
  if (dropped > 0) {
    out.push(`  ℹ 忘了 ${dropped} 个已删 token 的条目（下次写盘时真的删掉）`);
    out.push('');
  }

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

/**
 * @param {import('../format.js').Painter} painter
 * @param {any[]} rows
 */
function renderTable(painter, rows) {
  /** @type {any[][]} */
  const body = rows.map((r) => [
    r.name,
    { text: r.statusLabel, paint: statusColor(painter, r.status) },
    fmtCount(r.calls),
    fmtCount(r.in),
    fmtCount(r.out),
    stamp(r.checkedAt),
    clip(r.detail, 40),
  ]);
  return table(['token', '状态', '调用', '输入', '输出', '检测', '备注'], body);
}

// ═══════════════════════════ import ═══════════════════════════

/**
 * `cmt pool import <file.csv|file.xlsx>`：批量建 token + 建条目。
 *
 * ★ 已存在的名字**跳过并计数，不覆盖**——防误覆盖正在用的 key。
 * ★ 输出**永不回显 sk**，只报"新增几个 / 跳过几个（为什么）"。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdImport(args, ctx) {
  const file = args._[1];
  if (file === undefined) {
    throw new CmtError('缺少文件路径', {
      hint: 'cmt pool import <file.csv|file.xlsx>\n表格第 1 列是 token 名、第 2 列是密钥；首行可以是表头。',
    });
  }

  const abs = resolvePath(ctx.cwd, String(file));
  const rows = readSheet(abs);
  const mapped = mapImportRows(rows);

  const { pool, names } = loadPool(ctx);
  const existing = new Set(names);

  let added = 0;
  let existed = 0;
  let bad = 0;
  /** @type {string | null} */
  let firstError = null;
  /** @type {string[]} */
  const created = [];

  for (const item of mapped.items) {
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
        ...(args['base-url'] === undefined ? {} : { baseUrl: args['base-url'] }),
      }, item.name);
    } catch (err) {
      bad += 1;
      if (firstError === null) firstError = messageOf(err);
      continue;
    }
    // ★ 密钥落进 `tokens/<name>.json`——它的唯一归宿（§2.13 一）。
    //   不先 ensureDir：`saveToken()` 的原子写会自己建目录（§3.2 惰性）。
    saveToken({ home: ctx.home, token });
    ensureEntry(pool, item.name);
    existing.add(item.name);
    created.push(item.name);
    added += 1;
  }

  if (added > 0) savePool(ctx, pool);

  const skippedTotal =
    existed + bad + mapped.skipped.blank + mapped.skipped.header
    + mapped.skipped.malformed + mapped.skipped.duplicate;
  const total = added + skippedTotal;

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'import',
      file: abs,
      added,
      created,
      skipped: {
        total: skippedTotal,
        existing: existed,
        malformed: bad + mapped.skipped.malformed,
        blank: mapped.skipped.blank,
        header: mapped.skipped.header,
        duplicate: mapped.skipped.duplicate,
        badShape: bad,
      },
      firstError,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  /** @type {string[]} */
  const out = [`✓ 读 ${abs}`];
  out.push(`  新增 ${added} / 跳过 ${skippedTotal}（已存在 ${existed}、格式不符 ${bad + mapped.skipped.malformed}）`);

  /** @type {string[]} */
  const extras = [];
  if (mapped.skipped.blank > 0) extras.push(`空行 ${mapped.skipped.blank}`);
  if (mapped.skipped.header > 0) extras.push(`表头 ${mapped.skipped.header}`);
  if (mapped.skipped.duplicate > 0) extras.push(`表内重名 ${mapped.skipped.duplicate}`);
  if (extras.length > 0) out.push(`  另有：${extras.join('、')}`);

  if (added > 0) {
    const shown = created.slice(0, 10).join('、') + (created.length > 10 ? ' …' : '');
    out.push(`  已建：${shown}（密钥写进各自的 tokens/<name>.json，不在这份表格里）`);
    out.push('  下一步：`cmt pool check` 各探一次额度（会各发一次最小请求）');
  }
  if (firstError !== null) out.push(`  ⚠ 有一行没建成功，原因示例：${firstError}`);
  if (added === 0 && skippedTotal > 0) out.push('  （一行都没建——看看是不是都在池里了，或者第一列不是 token 名）');

  process.stdout.write(`${out.join('\n')}\n`);
  return EXIT.OK;
}

/**
 * 读表格。CSV 与 xlsx 都支持（§2.13 六，零依赖）。
 *
 * @param {string} abs
 * @returns {string[][]}
 */
function readSheet(abs) {
  /** @type {Buffer} */
  let buf;
  try {
    buf = nodeFs.readFileSync(abs);
  } catch (err) {
    throw new CmtError(`读不到表格：${abs}`, {
      hint: `系统说：${messageOf(err)}\n路径是相对**当前目录**算的：${process.cwd()}`,
    });
  }

  const ext = extname(abs).toLowerCase();

  if (ext === '.xls') {
    throw new CmtError('不支持老式 .xls（二进制 BIFF 格式）', {
      hint: '用 Excel 另存为 .xlsx 或 .csv 再来。',
    });
  }

  try {
    if (ext === '.xlsx' || ext === '.xlsm') return parseXlsx(buf);
    if (ext === '.csv' || ext === '.txt' || ext === '') return parseCsv(buf.toString('utf8'));
  } catch (err) {
    throw new CmtError(`表格解析失败：${messageOf(err)}`, {
      hint: '确认它是 Excel 存出来的 .xlsx（不是改后缀得到的），CSV 则是 UTF-8 编码。',
    });
  }

  throw new CmtError(`不认识的文件类型「${ext || '(无扩展名)'}」`, {
    hint: '只认 .csv / .txt / .xlsx / .xlsm。',
  });
}

// ═══════════════════════════ check ═══════════════════════════

/**
 * 额度探测。**会花钱**（每个探到的 token 发一次最小真实请求）。
 *
 * 目标三档：给了名字 → 只探它们；`--all` → 全部 token；什么都不给 → 池里的条目。
 * 每条先看新鲜度，除非 `--force`（§2.13 四）。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function cmdCheck(args, ctx) {
  const { pool, names } = loadPool(ctx);
  const settings = poolSettings(loadConfig({ home: ctx.home }).config.defaults?.pool);
  const painter = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: args.json === true });

  const requested = args._.slice(1).map(String);
  const ghosts = requested.filter((n) => !names.includes(n));
  if (ghosts.length > 0) {
    throw new CmtError(`没有这些 token：${ghosts.join('、')}`, {
      hint: '`cmt ls` 看全部；`cmt pool import <file>` 批量建。',
    });
  }

  /** @type {string[]} */
  const targets = requested.length > 0
    ? requested
    : args.all === true
      ? names
      : Object.keys(pool.entries);

  if (targets.length === 0) {
    process.stdout.write(
      '池里还没有条目。三种建法：\n'
      + '  · `cmt token add <name> --token <sk-...>` 建一个 token\n'
      + '  · `cmt pool import <file.csv|file.xlsx>` 从表格批量建\n'
      + '  · `cmt pool check --all` 给现有 token 全部建条目并探一遍\n',
    );
    return EXIT.OK;
  }

  const now = new Date();
  /** @type {Record<string, number>} */
  const byStatus = {};
  for (const s of STATUSES) byStatus[s] = 0;

  /** @type {any[]} */
  const results = [];
  let probed = 0;
  let skipped = 0;

  for (const name of targets) {
    const entry = ensureEntry(pool, name);

    if (args.force !== true && !isStale(entry, now, { cacheSeconds: settings.cacheSeconds })) {
      skipped += 1;
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
      results.push({
        name,
        status: entry.status,
        statusLabel: statusLabel(entry.status),
        detail: entry.detail,
        checkedAt: entry.checkedAt,
        httpStatus: null,
        elapsedMs: null,
        model: null,
        skipped: true,
      });
      continue;
    }

    // 进度走 stderr：它是**过程**信息，混进 stdout 会把 `--json` 弄坏。
    if (targets.length > 1 && args.json !== true) {
      process.stderr.write(`  正在探测 ${probed + 1}/${targets.length} · ${name}\n`);
    }

    const r = await probeConfiguredToken(ctx, name, { model: args.model });
    applyProbe(entry, r, now);
    probed += 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    results.push({
      name,
      status: r.status,
      statusLabel: statusLabel(r.status),
      detail: r.detail,
      checkedAt: entry.checkedAt,
      httpStatus: r.httpStatus,
      elapsedMs: r.elapsedMs,
      model: r.model,
      skipped: false,
    });
  }

  if (probed > 0) savePool(ctx, pool, now);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'check',
      probed,
      skipped,
      byStatus,
      results,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  /** @type {string[]} */
  const out = [''];
  for (const r of results) {
    const mark = r.skipped ? '·' : r.status === STATUS.OK ? '✓' : '✗';
    const tint = statusColor(painter, r.status);
    const note = r.skipped
      ? painter.dim('（还是新鲜的，--force 可强探）')
      : clip(r.detail, 70);
    out.push(
      `  ${mark} ${padEnd(r.name, 20)} ${tint(padEnd(r.statusLabel, 8))}  ${note}`,
    );
  }
  out.push('');
  out.push(
    `  探测 ${probed} 个${skipped > 0 ? ` · 跳过 ${skipped} 个（新鲜）` : ''}`
      + ` · 有余额 ${byStatus[STATUS.OK] ?? 0} / 无余额 ${byStatus[STATUS.NO_QUOTA] ?? 0}`,
  );
  out.push('');
  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ═══════════════════════════ status / reset ═══════════════════════════

/**
 * 手动覆盖状态。`detail` 记 `manual`——让"这是人标的"与"这是探出来的"永远分得开。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdStatus(args, ctx) {
  const name = validateTokenName(args._[1]);
  const want = args._[2];

  if (want === undefined) {
    throw new CmtError('缺少状态值', {
      hint: `可选：${STATUSES.join(' / ')}\n例：cmt pool status ${name} no_quota`,
    });
  }
  const status = String(want);
  if (!STATUSES.includes(status)) {
    throw new CmtError(`不认识的 status「${status}」`, {
      hint: `可选：${STATUSES.join(' / ')}`,
    });
  }

  const { token } = loadToken({ home: ctx.home, name });
  if (token === null) {
    throw new CmtError(`token "${name}" 不存在`, {
      hint: '`cmt ls` 看全部；要新建用 `cmt token add`。',
    });
  }

  const { pool } = loadPool(ctx);
  const entry = ensureEntry(pool, name);
  entry.status = status;
  entry.detail = 'manual';
  entry.checkedAt = new Date().toISOString();
  savePool(ctx, pool);

  return ack(args, ctx, `已把 ${name} 标成「${statusLabel(status)}」`);
}

/**
 * 清状态回 `unknown`。**用量字段保留**——reset 只回答"这条状态还作数吗"。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdReset(args, ctx) {
  const name = validateTokenName(args._[1]);

  const { token } = loadToken({ home: ctx.home, name });
  if (token === null) {
    throw new CmtError(`token "${name}" 不存在`, {
      hint: '`cmt ls` 看全部；要新建用 `cmt token add`。',
    });
  }

  const { pool } = loadPool(ctx);
  const entry = ensureEntry(pool, name);
  entry.status = STATUS.UNKNOWN;
  entry.detail = '';
  entry.checkedAt = '';
  savePool(ctx, pool);

  return ack(args, ctx, `已清掉 ${name} 的状态（下次 check 会重探）`);
}

// ═══════════════════════════ sync ═══════════════════════════

/**
 * 从 claude 自己写的 transcript 重算池里每个 token 的用量。
 *
 * ★ 真正的活在 `cli/pool-usage.js` 的 `syncPoolUsage()` 里——网页控制台的
 *   「重算用量」按钮走的是**同一个函数**。两端各写一份的话，"页面上的花费"与
 *   "命令行里的花费"迟早对不上，而且**没有任何报错**。
 * ★ `calls` 记的是 `stats.messages`（真正算进账的消息条数），不是 `entries.length`
 *   （entries 按 (day, model, project) 聚合过，条数会少一大截）。
 * ★ 没变过的文件走缓存（`pool-usage-cache.json`）：`--force` 才是"全部重读"。
 *   缓存是**优化不是真相**——删了它只会让下一次慢一点，数一个不差。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function cmdSync(args, ctx) {
  const { pool } = loadPool(ctx);
  const names = Object.keys(pool.entries);

  if (names.length === 0) {
    process.stdout.write(
      '池里还没有条目——先 `cmt pool import <file>` 或 `cmt pool check <name>`。\n'
      + '（`sync` 只给池里的 token 记用量；不在池里的 token 用 `cmt usage` 看。）\n',
    );
    return EXIT.OK;
  }

  const { filesRead, filesCached, totals } = syncPoolUsage(
    ctx, pool, new Date(), { force: args.force === true },
  );

  let redisAttempted = false;
  let redisOk = false;
  /** @type {string | null} */
  let redisWarning = null;

  const url = resolveRedisUrl(args, pool, ctx.env);
  if (url !== null) {
    redisAttempted = true;
    try {
      await writeThrough(url, pool);
      redisOk = true;
    } catch (err) {
      // 写穿失败**不是**命令失败：本地已经存好了。
      redisWarning = messageOf(err);
    }
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'sync',
      files: filesRead,
      // ★ 走缓存没重读的份数。想让"每一份都真的重读"就 `--force`。
      cached: filesCached,
      force: args.force === true,
      redis: { attempted: redisAttempted, ok: redisOk },
      warning: redisWarning,
      total: {
        calls: names.reduce((s, n) => s + totals[n].calls, 0),
        in: names.reduce((s, n) => s + totals[n].in, 0),
        out: names.reduce((s, n) => s + totals[n].out, 0),
      },
      tokens: names.map((n) => ({ name: n, ...totals[n] })),
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const painter = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  /** @type {string[]} */
  const out = ['同步用量  ' + `${filesRead} 份 transcript`
    + (filesCached > 0
      ? `  ${painter.dim(`（另有 ${filesCached} 份没变，走的缓存；--force 可全部重读）`)}`
      : ''),
  ''];
  out.push(table(['token', '调用', '输入', '输出'], names.map((n) => [
    n,
    fmtCount(totals[n].calls),
    fmtCount(totals[n].in),
    fmtCount(totals[n].out),
  ])));
  out.push('');
  if (!redisAttempted) {
    out.push(`  ${painter.dim('（没配 Redis，只写了本地 pool.json）')}`);
  } else if (redisOk) {
    out.push(`  ${painter.green('✓')} 已写穿到 Redis`);
  } else {
    out.push(`  ⚠ Redis 写穿失败（本地已保存）：${redisWarning ?? '未知原因'}`);
  }
  out.push('');
  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ═══════════════════════════ pull ═══════════════════════════

/**
 * 反向：把 Redis 里的状态合并回本地。**只合 `status / detail / checkedAt`**——
 * 用量以本地 `sync` 为准，不拿远端覆盖。
 *
 * 合并判据是**谁更新**（`checkedAt` 时间戳），不是"谁先来"：本地更新就不动。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function cmdPull(args, ctx) {
  const { pool } = loadPool(ctx);
  const url = resolveRedisUrl(args, pool, ctx.env);

  if (url === null) {
    throw new CmtError('没有 Redis 地址', {
      hint: 'cmt pool pull --redis <url>\n也可以设环境变量 CMT_REDIS_URL，或写进 pool.json 的 redis 字段。',
    });
  }

  /** @type {import('../../platform/redis.js').RedisClient} */
  let client;
  try {
    client = await connect(url);
  } catch (err) {
    // ⚠️ **绝不回显 url**——它可能带着密码（§2.13 五）。
    throw new CmtError(`连不上 Redis：${messageOf(err)}`, {
      hint: '检查地址 / 服务是否在跑 / 密码是否正确。',
    });
  }

  const known = new Set(listTokenNames({ home: ctx.home }));

  let merged = 0;
  let keptLocal = 0;
  let skippedUnknown = 0;
  let skippedEmpty = 0;

  try {
    const rawNames = await client.call('SMEMBERS', REDIS_NAMES);
    const remoteNames = Array.isArray(rawNames) ? rawNames.map(String).sort() : [];

    for (const name of remoteNames) {
      // 远端有、本地没有的 token：不建条目。池里出现的名字必须对应一个真 token
      // （§2.13 一），凭空复活一个已删的身份比丢掉一条状态更糟。
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
      const incomingCheckedAt = typeof obj.checkedAt === 'string' ? obj.checkedAt : '';

      if (!isFresher(incomingCheckedAt, entry.checkedAt)) {
        keptLocal += 1;
        continue;
      }

      entry.status = normalizeStatus(obj.status);
      entry.detail = typeof obj.detail === 'string' ? obj.detail : '';
      entry.checkedAt = incomingCheckedAt;
      merged += 1;
    }
  } finally {
    client.close();
  }

  if (merged > 0) savePool(ctx, pool);

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: 'pull',
      merged,
      keptLocal,
      skippedUnknown,
      skippedEmpty,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const painter = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  /** @type {string[]} */
  const out = [];
  if (merged > 0) {
    out.push(`\n  ✓ 从 Redis 合并 ${merged} 条状态 · 本地更新、没覆盖 ${keptLocal} 条`);
  } else {
    out.push(`\n  从 Redis 没合并到更新的状态 · 本地保留 ${keptLocal} 条`);
  }
  if (skippedUnknown > 0) {
    out.push(`  ${painter.dim(`跳过 ${skippedUnknown} 个本地没有的 token（不凭空建条目）`)}`);
  }
  if (skippedEmpty > 0) {
    out.push(`  ${painter.dim(`跳过 ${skippedEmpty} 个空条目`)}`);
  }
  out.push('');
  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ═══════════════════════════ Redis 小工具 ═══════════════════════════

/**
 * 取 Redis 地址（§2.13 二）：`--redis` ＞ `CMT_REDIS_URL` ＞ `pool.json` 的 `redis`。
 *
 * @param {any} args
 * @param {any} pool
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
function resolveRedisUrl(args, pool, env) {
  const candidates = [args.redis, env.CMT_REDIS_URL, pool.redis];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value === '') continue;
    return expandEnvRef(value, env);
  }
  return null;
}

/**
 * `env:VAR` 间接引用。**只认整串**——半个引用等于半个秘密。
 *
 * @param {string} value
 * @param {Record<string, string | undefined>} env
 */
function expandEnvRef(value, env) {
  if (!value.startsWith('env:')) return value;

  const name = value.slice('env:'.length).trim();
  if (name === '') {
    throw new CmtError('`env:` 后面没写变量名', { hint: '例：--redis env:MY_REDIS_URL' });
  }
  const v = env[name];
  if (v === undefined || v === '') {
    throw new CmtError(`环境变量 ${name} 没设置（或者为空）`, {
      hint: '要么先设置它，要么直接给地址：--redis <url>',
    });
  }
  return v;
}

/**
 * 把整份池镜像进 Redis。键空间见文件头的常量。
 *
 * @param {string} url
 * @param {any} pool
 */
async function writeThrough(url, pool) {
  const client = await connect(url);
  try {
    for (const [name, entry] of Object.entries(pool.entries)) {
      await client.call(
        'HSET', redisStateKey(name),
        'status', entry.status,
        'detail', entry.detail,
        'checkedAt', entry.checkedAt,
        'calls', String(entry.calls),
        'in', String(entry.in),
        'out', String(entry.out),
      );
    }
    const names = Object.keys(pool.entries);
    if (names.length > 0) await client.call('SADD', REDIS_NAMES, ...names);
    await client.call(
      'HSET', REDIS_META,
      'updatedAt', pool.updatedAt ?? '',
      'version', String(pool.version ?? 1),
    );
  } finally {
    client.close();
  }
}

/**
 * HGETALL 的平铺数组 → 对象。不是数组就返回 `null`（调用方据此跳过）。
 *
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
 * `incoming` 比 `local` 更新吗？解析不出来的时间戳按"旧"处理——
 * 宁可不覆盖，也不要让一条坏时间戳把本地状态冲掉。
 *
 * @param {string} incoming
 * @param {string} local
 */
function isFresher(incoming, local) {
  const a = Date.parse(incoming);
  if (!Number.isFinite(a)) return false;
  const b = Date.parse(local);
  if (!Number.isFinite(b)) return true; // 本地没时间戳 = 没探过，随便什么都更新
  return a > b;
}

// ═══════════════════════════ 渲染小工具 ═══════════════════════════

/**
 * 状态 → 配色（与网页控制台的六档配色同一套语义）。
 *
 * @param {import('../format.js').Painter} painter
 * @param {string} status
 */
function statusColor(painter, status) {
  switch (status) {
    case STATUS.OK: return painter.green;
    case STATUS.NO_QUOTA:
    case STATUS.OTHER: return painter.yellow;
    case STATUS.INVALID:
    case STATUS.NET_FAIL: return painter.red;
    default: return painter.dim;
  }
}

/**
 * 写盘成功后的回执。`--json` 只给 `{ok:true, ...extra}`——脚本要的是"成没成"。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @param {string} line
 * @param {Record<string, unknown>} [extra]
 */
function ack(args, ctx, line, extra = {}) {
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...extra }, null, 2)}\n`);
    return EXIT.OK;
  }
  process.stdout.write(`\n  ✓ ${line}\n\n`);
  return EXIT.OK;
}

/**
 * 按**显示宽度**对齐的表格（`format.js` 里没有 `table()`，这里补一个本命令专用的）。
 *
 * 单元格可以是字符串，也可以是 `{text, paint}`——`paint` 是 `makePainter()` 给的
 * 上色函数，**在补齐宽度之后**才套上去（先上色再补空格会把宽度算错）。
 *
 * @param {string[]} headers
 * @param {any[][]} rows
 * @param {{ indent?: string, gap?: string }} [opts]
 */
function table(headers, rows, opts = {}) {
  const indent = opts.indent ?? '  ';
  const gap = opts.gap ?? '  ';

  /** @param {any} cell */
  const textOf = (cell) => (cell != null && typeof cell === 'object'
    ? String(cell.text ?? '')
    : String(cell ?? ''));
  /** @param {any} cell */
  const paintOf = (cell) => (cell != null && typeof cell === 'object' && typeof cell.paint === 'function'
    ? cell.paint
    : (/** @type {string} */ s) => s);

  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => displayWidth(textOf(r[i])))));

  return all
    .map((r) => {
      const line = r
        .map((cell, i) => paintOf(cell)(padEnd(textOf(cell), widths[i])))
        .join(gap)
        .replace(/\s+$/, '');
      return `${indent}${line}`;
    })
    .join('\n');
}

/**
 * 紧凑计数：表格里的位数长了会把 80 列终端撑爆。
 * 精确值走 `--json`（那里没有宽度约束）。
 *
 * @param {number} n
 */
function fmtCount(n) {
  const abs = Math.abs(n);
  if (abs < 10_000) return String(n);
  if (abs < 1_000_000) return `${trimZero(n / 1_000)}k`;
  if (abs < 1_000_000_000) return `${trimZero(n / 1e6)}M`;
  return `${trimZero(n / 1e9)}B`;
}

/**
 * @param {number} n
 */
function trimZero(n) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * ISO 时间 → `MM-DD HH:mm`（空串给 `—`）。
 *
 * @param {string} iso
 */
function stamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const pad = (/** @type {number} */ v) => String(v).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 从尾部截断（保留前缀）。中文按显示宽度算，不会切半个宽字符。
 *
 * @param {string} s
 * @param {number} max
 */
function clip(s, max) {
  if (displayWidth(s) <= max) return s;
  const chars = [...s];
  let w = 0;
  let out = '';
  for (const c of chars) {
    const cw = displayWidth(c);
    if (w + cw > max - 1) break;
    w += cw;
    out += c;
  }
  return `${out}…`;
}

/**
 * @param {unknown} err
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

// ═══════════════════════════ 帮助 ═══════════════════════════

const POOL_HELP = `cmt pool —— token 池：状态与分配（§2.13）

池是挂在既有 token 上的一张**状态/用量覆盖层**，按 token 名索引，不含任何密钥——
密钥永远只在 tokens/<name>.json 里。

子命令
  cmt pool list                     所有 token + 状态 + 用量（没入池的标「未入池」）
                                    ★ 顺手按 usageSeconds 重算过一次期的用量（不是纯只读）
  cmt pool import <file.csv|xlsx>   批量建 token + 建条目；已存在的名字跳过，不覆盖
                                    表格第 1 列是 token 名、第 2 列是密钥；首行可以是表头
  cmt pool check [<name>...]        额度探测（发一次最小真实请求，**会花钱**）
        [--all] [--force]           不带名字 = 探池里全部条目；--all = 探所有 token 并建条目
                                    --force 无视新鲜期，强制重探
  cmt pool status <name> <status>   手动覆盖：${STATUSES.join(' / ')}
  cmt pool reset <name>             清状态回 unknown（用量保留）
  cmt pool sync [--redis <url>] [--force]
                                    从 claude 的 transcript 重算用量；带 --redis 时写穿
                                    ★ 没变过的文件走缓存，--force 才全部重读
  cmt pool pull --redis <url>       反向：把 Redis 里的状态合并回本地

选项
  --redis <url>    Redis 地址（redis:// / rediss:// / unix://），也认 env:VAR
                   取址顺序：--redis ＞ CMT_REDIS_URL ＞ pool.json 的 redis
  --model <id>     探测用的模型（默认取该 token 的 models[0]，再退回全局默认）
  --base-url <u>   import 时顺带给新建的 token 写 baseUrl（别名 --url）
  --json           机器可读输出（不含任何密钥）
  -h, --help       显示本帮助

新鲜度（决定 check 要不要真探）
  · 没探过                → 立刻探
  · ok / 异常 / 连不上    → 超过 cacheSeconds 才重探（默认 300 秒，config.json 的 defaults.pool）
  · 无余额                → **跨月**才重探（月初额度会自动刷新）
  · 密钥无效              → 24 小时后重探
  --force 无视上面全部。

本地优先（§2.13 五）
  list / import / check / status / reset / 启动时挑选 全程**不连 Redis**。
  只有 sync --redis 与 pull 会连。Redis 写穿失败只打一句 ⚠，退出码不变——
  本地写成功就算成功。

下一步
  cmt run --pool          启动前从池里挑一个（见 cmt run --help）
  cmt usage               按 token / 项目 / 模型看用量与花费
`;
