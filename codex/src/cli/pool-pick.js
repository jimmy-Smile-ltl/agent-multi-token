// @ts-check
/**
 * ★ 启动前从**池**里挑一个 token（§2.15 三 / 四）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它插在哪
 *
 * `planLaunch()` 里 `resolveSession()` **之后**、缺项检查**之前**：
 *
 * ```
 * resolveSession()  →  没有 token？ ──→ 池：挑一个 → 再解析一次 → 盖上来历
 *                   ↓
 *              缺项检查 → planFrom() → buildExecArgs()
 * ```
 *
 * 顺序不能反：`buildExecArgs()` 用 `resolved.token.value` 拼 argv，
 * 而"没有 token"会立刻让缺项检查报错——池必须在**那之前**把这一格填上。
 *
 * ## 两个触发条件（二者之一）
 *
 * | 触发 | 含义 |
 * |---|---|
 * | `token` 解析出来是 `null` 且 `defaults.pool.auto !== false` | **补空位**：一个没建过池的目录，候选是空的，于是什么也不做 |
 * | `--pool` | **显式强制**：覆盖绑定 / 项目本地 / defaults 任何一层 |
 *
 * ## 三条不许越的界
 *
 * 1. **只挑一次**。选中就钉死，整个会话不再换（§1.4：会话内不做故障转移）。
 * 2. **`-c` 只认 `lastPick[cwd]`**。profile 名 = token 名，换一个 token 续接
 *    等于**静默开一个全新会话**——用户以为在续，其实断了。所以宁可直接报错。
 * 3. **挑选的产物必须"再解析一次"**。只改 `token.value` 的话，
 *    `authToken` / `profileName` / `baseUrl` 还是"没有任何 token"时的那份——
 *    那是四要素里三项是错的、但看起来一切正常的方案。
 * ─────────────────────────────────────────────────────────────
 */
import { CxtError } from '../core/errors.js';
import { MAX_LAST_PICK, STATUS, isStale, orderCandidates, poolSettings, statusLabel } from '../core/pool.js';
import { SOURCE } from '../core/resolve.js';
import { readConfig } from '../core/store.js';
import { applyProbe, ensureEntry, loadPool, savePool } from './pool-store.js';
import { probeConfiguredToken } from './probe.js';
import { resolveSession } from './session.js';
import { activeTokensOf } from './sessions.js';

/**
 * @typedef {object} PickOptions
 * @property {string} [path]     "我站在哪个目录"（面板启动一条绑定时传绑定点）
 * @property {(line: string) => void} [notify] 进度行（**只报名字与序号**）。
 *   面板不传——备用屏上写一行 stderr 会横穿某一帧。
 */

/**
 * 该不该挑、挑谁。**没挑就返回 `null`**（"这一次不该池出场"）。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {any} resolved `resolveSession()` 的产物
 * @param {any} argv `toResolveArgv()` 的产物（`argv.pool` 是那个强制旗标）
 * @param {PickOptions} [opts]
 * @returns {Promise<{ resolved: any, note: string } | null>}
 */
export async function pickFromPool(ctx, resolved, argv, opts = {}) {
  const forced = argv?.pool === true;
  const settings = poolSettings(readConfig(ctx.home).defaults?.pool);

  // ── 该不该出场 ──
  if (!forced) {
    // ★ 已有 token 就**不接管**：池是"补空位 + 显式强制"，不是"总是重挑"
    if (resolved.token?.value !== null && resolved.token?.value !== undefined) return null;
    if (settings.auto === false) return null;
  }

  const { pool } = loadPool(ctx);
  if (Object.keys(pool.entries).length === 0) {
    // 补空位时"池是空的"= 这个目录没启用过池，照旧走没 token 的老路
    if (!forced) return null;
    throw new CxtError('池里还没有条目，没有可挑的 token', {
      hint: '先建池：`cxt pool import <xlsx|csv>`，或者 `cxt pool check <name>`（点一个名就把它拉进池）',
    });
  }

  const cwd = launchCwd(resolved, ctx);
  const now = new Date();
  const cacheSeconds = settings.cacheSeconds;
  /** @type {Parameters<typeof probeConfiguredToken>[2]} */
  const probeOpts = typeof argv?.model === 'string' ? { model: argv.model } : {};

  /**
   * 成功：写 `lastPick`、推进游标、落盘，然后**再解析一次**。
   * @param {string} name
   * @param {string} detail 探测或缓存里的一句话
   */
  const success = (name, detail) => {
    remember(pool, cwd, name);
    pool.rr += 1; // 游标只负责"并列时先试谁"（见 orderCandidates），挑完就得走一格
    savePool(ctx, pool, new Date());

    const next = resolveSession(ctx, { ...argv, token: name }, 'run', { path: opts.path });
    // ★ 来历盖在 **token 这一格**：其余每一项都是"选中它之后"的真值，
    //   只有"谁挑的"这件事是 resolve() 不知道的
    next.token = { value: name, source: SOURCE.POOL, detail: 'token 池（启动前挑一次）' };
    return { resolved: next, note: `token 池挑了 ${name}（${detail}）` };
  };

  // ── `-c` 守卫：续接必须用**同一个** token（§2.15 三·3）──
  if (resolved.resume === true) {
    const remembered = typeof pool.lastPick[cwd] === 'string' ? pool.lastPick[cwd] : '';
    if (remembered === '' || pool.entries[remembered] === undefined) {
      throw new CxtError('`-c` 需要确定是哪一个 token，而这个目录还没有挑过', {
        hint: '两个出路：① 直接点名（`cxt run <token> -c`）；② 去掉 `-c`，开一个新会话',
      });
    }
    const entry = pool.entries[remembered];
    if (entry.status === STATUS.NO_QUOTA || entry.status === STATUS.INVALID) {
      throw new CxtError(
        `上次在这个目录用的是 ${remembered}，但它现在${statusLabel(entry.status)}`,
        {
          hint: `续接必须用同一个 token（profile 名就是 token 名），换一个等于开新会话。`
            + `先 \`cxt pool check ${remembered} --force\` 确认它是不是真不能用了；`
            + '确实是的话，去掉 `-c` 换一个 token 开新会话',
        },
      );
    }
    if (!isStale(entry, now, { cacheSeconds })) return success(remembered, `缓存：${detailOf(entry)}`);

    notify(opts, `正在探测 ${remembered}（-c 必须用它）…`);
    const probe = await probeConfiguredToken(ctx, remembered, probeOpts);
    applyProbe(entry, probe, new Date());
    if (probe.status !== STATUS.OK) {
      savePool(ctx, pool, new Date()); // 把这次探测记下来，别下一次再白试一遍
      throw new CxtError(
        `续接要用的 ${remembered} 这次探测不通过：${statusLabel(probe.status)}（${probe.detail}）`,
        { hint: '去掉 `-c` 换一个 token 开新会话；或者先修好这把 key 再来续' },
      );
    }
    return success(remembered, probe.detail);
  }

  // ── 正常路径：先看"新鲜的 ok"（0 次请求），没有才按序探 ──
  //   ★ 「在用靠后」（§2.15 四 / §2.16）：活动会话正持有的 token 排到候选末尾。
  //     只是排序不是排除——全都排完才轮到在用的。
  const candidates = orderCandidates(pool.entries, {
    policy: settings.policy,
    rr: pool.rr,
    activeTokens: activeTokensOf(ctx),
  });
  if (candidates.length === 0) throw allExcluded(pool.entries);

  for (const name of candidates) {
    const entry = pool.entries[name];
    if (entry.status === STATUS.OK && !isStale(entry, now, { cacheSeconds })) {
      return success(name, `缓存：${detailOf(entry)}`);
    }
  }

  // ★ 只探**过期的**：新鲜但非 ok 的条目（5 分钟前刚失败过）现在就重试，
  //   等于把 TTL 当摆设——而 TTL 存在的唯一意义就是别把探测烧成一串请求。
  /** @type {string[]} */
  const stale = candidates.filter((n) => isStale(pool.entries[n], now, { cacheSeconds }));
  /** @type {string[]} */
  const failures = [];
  /** @type {number} */
  let probed = 0;

  for (const name of candidates) {
    const entry = ensureEntry(pool, name);
    if (!stale.includes(name)) {
      failures.push(`${name}：${detailOf(entry)}`);
      continue;
    }

    probed += 1;
    notify(opts, `正在探测 ${probed}/${stale.length}：${name} …`);
    const probe = await probeConfiguredToken(ctx, name, probeOpts);
    applyProbe(entry, probe, new Date());
    if (probe.status === STATUS.OK) return success(name, probe.detail);
    failures.push(`${name}：${statusLabel(probe.status)}（${probe.detail}）`);
  }

  // 一个都不成：把探测到的结论带出去（否则下一次还得再烧一遍才知道）
  savePool(ctx, pool, new Date());
  throw new CxtError('池里的 token 这次都不能用', {
    hint: `${failures.join('；')}。—— 详情 \`cxt pool list\`；`
      + '确认恢复了的用 `cxt pool check <name> --force` 立刻重探',
  });
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * `lastPick` 的键：**启动那一刻**算出来的 cwd。
 *
 * ★ 故意用"挑选之前"的那个值：下一次同样不带 token 地跑 `-c`，
 *   解析出来的还是它——即便挑中的 token 自己有 `token.cwd`（那会把
 *   `resolved.cwd` 改掉，拿改后的值当键就对不上了）。
 * @param {any} resolved
 * @param {import('./types.js').Ctx} ctx
 */
function launchCwd(resolved, ctx) {
  const v = resolved.cwd?.value;
  return typeof v === 'string' && v !== '' ? v : ctx.cwd;
}

/**
 * 记一条 `lastPick`（按 cwd 去重，`MAX_LAST_PICK` 封顶）。
 * @param {import('../core/pool.js').Pool} pool
 * @param {string} cwd
 * @param {string} name
 */
function remember(pool, cwd, name) {
  // 先删再写：同一个 cwd 只留最新那条，而且它的插入顺序会挪到最后
  delete pool.lastPick[cwd];
  pool.lastPick[cwd] = name;

  const keys = Object.keys(pool.lastPick);
  if (keys.length > MAX_LAST_PICK) {
    for (const k of keys.slice(0, keys.length - MAX_LAST_PICK)) delete pool.lastPick[k];
  }
}

/**
 * 条目的一句话说明（状态 + 上次探测的那行）。
 * @param {import('../core/pool.js').PoolEntry} entry
 */
function detailOf(entry) {
  const when = entry.checkedAt === '' ? '没探过' : entry.checkedAt.slice(0, 16).replace('T', ' ');
  return entry.detail === ''
    ? `${statusLabel(entry.status)} · ${when}`
    : `${statusLabel(entry.status)} · ${entry.detail}`;
}

/**
 * 候选被**硬排除**光了（全是 `no_quota` / `invalid`）。
 * @param {Record<string, import('../core/pool.js').PoolEntry>} entries
 */
function allExcluded(entries) {
  const lines = Object.entries(entries).map(([name, e]) => `${name}：${statusLabel(e.status)}`);
  return new CxtError(`池里现在没有可用的 token（${lines.join('；')}）`, {
    hint: '额度用尽的要等月初刷新；密钥无效的得换一把 key。'
      + '手动改过的用 `cxt pool reset <name>` 回到未检测，下一次启动会重探',
  });
}

/**
 * @param {PickOptions} opts
 * @param {string} line
 */
function notify(opts, line) {
  if (typeof opts.notify === 'function') opts.notify(line);
}
