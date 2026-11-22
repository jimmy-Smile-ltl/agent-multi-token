// @ts-check
/**
 * Token 池的纯逻辑。
 *
 * ─────────────────────────────────────────────────────────────
 * **池是一张覆盖层，不是第二份清单。** 它按 token **名**索引，记的是
 * "这个 token 上次探测是什么状态、用量多少"，**一个 `sk` 字段都没有**——
 * 密钥永远只有 `tokens/<name>.json` 那一个家。
 *
 * ★★ **本文件是纯函数**：不读 fs、不读 `process.env`、不读 `process.platform`、
 * 不发网络。探测在 CLI 层，落盘在 `core/store.js`。这样"什么时候该重探"
 * 和"挑谁"这两条最容易写错的规矩，可以在一张假数据上逐条钉死。
 *
 * ★ **读要宽容、永不抛错**：`pool.json` 是可丢弃的，手改坏了不该让启动失败，
 * 只该让池退化成"全都是 unknown"——那等价于全部重探一次。
 * ─────────────────────────────────────────────────────────────
 */

/** `pool.json` 的版本（独立于 `config.json` 的，别混） */
export const POOL_VERSION = 1;

/**
 * 状态词表。**六个，不多不少。**
 *
 * | 值 | 含义 | 谁写的 |
 * |---|---|---|
 * | `ok` | 探测拿到了 2xx —— 有余额 | 探测 |
 * | `no_quota` | 额度用尽 / 欠费 | 探测 |
 * | `invalid` | 密钥无效 / 认证失败 | 探测 |
 * | `net_fail` | 连不上（DNS / 超时 / TLS） | 探测 |
 * | `other` | 其它错误（5xx / 限流 / 看不懂的响应体） | 探测 |
 * | `unknown` | 从没探过，或者被手动清了 | 初始值 / `reset` |
 *
 * ★ 为什么把 `net_fail` 与 `other` 分开：**它们的重探策略不同**——
 * 网络故障说明不了密钥的事，一分钟后可能就好了；而 `other` 往往意味着
 * 服务端在闹脾气，重探太勤只是白烧请求。
 */
export const STATUS = Object.freeze({
  OK: 'ok',
  NO_QUOTA: 'no_quota',
  INVALID: 'invalid',
  NET_FAIL: 'net_fail',
  OTHER: 'other',
  UNKNOWN: 'unknown',
});

/** 词表的有序数组（给命令行/面板显示用）。顺序即"好坏顺序"，不是字母序。 */
export const STATUSES = Object.freeze([
  STATUS.OK,
  STATUS.NO_QUOTA,
  STATUS.INVALID,
  STATUS.NET_FAIL,
  STATUS.OTHER,
  STATUS.UNKNOWN,
]);

/**
 * 状态词 → 给人看的四个字。
 *
 * ★ 它是**共享的**，因为同一个状态会在三个地方出现：命令行的 `pool list`、
 * 网页控制台的状态丸、启动挑 token 失败时的那条错误。三处各写一份的话，
 * 迟早有一处把 `net_fail` 写成"网络错误"、另一处写成"连不上"——
 * 而用户看到的是同一件事的两种说法。
 *
 * @type {Record<string, string>}
 */
export const STATUS_LABEL = Object.freeze({
  [STATUS.OK]: '有余额',
  [STATUS.NO_QUOTA]: '无余额',
  [STATUS.INVALID]: '密钥无效',
  [STATUS.NET_FAIL]: '连不上',
  [STATUS.OTHER]: '异常',
  [STATUS.UNKNOWN]: '未检测',
});

/**
 * 分配策略。
 *
 * - `least-used`（默认）：用量少的优先，**并列时按游标轮询**。
 * - `round-robin`：不看用量，纯粹轮着来。
 *
 * ★ 两者都**只排候选顺序**，不做任何切换——挑一次就钉死（会话内不换 token 是铁律）。
 */
export const POLICY = Object.freeze({
  LEAST_USED: 'least-used',
  ROUND_ROBIN: 'round-robin',
});

/** 默认新鲜度窗口（秒）。`ok` / `other` / `net_fail` 都用它。 */
export const DEFAULT_CACHE_SECONDS = 300;

/**
 * `invalid` 的重探间隔（秒）。
 *
 * ★ 比默认窗口长得多：把一个**确认无效**的密钥每 5 分钟试一次，
 * 除了给服务端刷无效认证日志，没有任何收益。一天一次足够发现"它又被启用了"。
 */
export const INVALID_CACHE_SECONDS = 86400;

/**
 * 默认的**用量重算**间隔（秒）。
 *
 * ★ 与 `DEFAULT_CACHE_SECONDS` 是**两个窗口**，刻意不合并：探测要发一次真实请求
 * （真金白银），重算用量只读本机会话记录（不花钱，只耗一点 IO）。共用一个旋钮，
 * 等于"想少探测的人被迫少记账"，而这两件事的成本差着几个数量级。
 */
export const DEFAULT_USAGE_SECONDS = 600;

/** `lastPick` 最多记多少条（按 cwd）。超出就丢最老的——它只是续接用的提示，不是账本。 */
export const MAX_LAST_PICK = 200;

/**
 * 默认的池偏好。
 *
 * ★ `auto: true` 是**默认开着补空位**的：没有 token 可解析时，池顶上去。
 * 这与"不改既有配置的行为"不冲突——一个根本没建过池的目录，候选表是空的，
 * 补空位自然什么也不做。
 * @returns {{ auto: boolean, policy: string, cacheSeconds: number, usageSeconds: number }}
 */
export function defaultPoolSettings() {
  return {
    auto: true,
    policy: POLICY.LEAST_USED,
    cacheSeconds: DEFAULT_CACHE_SECONDS,
    usageSeconds: DEFAULT_USAGE_SECONDS,
  };
}

/**
 * 把配置里那一节 `pool` 收成一定可用的四件。**永不抛错**——坏值逐项退回默认。
 *
 * ⚠️ 严格校验（坏类型就报错）在各自的配置 schema 里；这里是**运行期**的读法，
 * 面向的是"文件可能被手改过"的现实。
 * @param {unknown} raw
 * @returns {{ auto: boolean, policy: string, cacheSeconds: number, usageSeconds: number }}
 */
export function poolSettings(raw) {
  const out = defaultPoolSettings();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = /** @type {Record<string, unknown>} */ (raw);

  if (typeof r.auto === 'boolean') out.auto = r.auto;
  if (r.policy === POLICY.LEAST_USED || r.policy === POLICY.ROUND_ROBIN) {
    out.policy = /** @type {string} */ (r.policy);
  }
  const cache = num(r.cacheSeconds);
  if (cache > 0) out.cacheSeconds = cache;
  const usage = num(r.usageSeconds);
  if (usage > 0) out.usageSeconds = usage;

  return out;
}

/**
 * 一个模型的用量。
 *
 * ★ **没有"调用次数"这一项，是故意的**：transcript 的聚合键是
 *   (日期, 模型, 目录)，同一个模型同一天同一目录下的若干条消息**早就合并成一行**了，
 *   按模型拆分之后那个次数**算不回来**。写一个恒为 0 的字段，等于在邀请别人
 *   把它渲染成「0 次」——调用次数只有 token 级的 `PoolEntry.calls` 是真的。
 *
 * @typedef {object} ModelUsage
 * @property {number} input       输入 token 数（**不含**缓存那两档）
 * @property {number} cacheRead   缓存命中读
 * @property {number} cacheWrite  缓存写入
 * @property {number} output      输出 token 数
 */

/**
 * @typedef {object} PoolEntry
 * @property {string} status       `STATUS` 之一
 * @property {string} detail       人话补充（`HTTP 200 · 812ms` / `manual`）
 * @property {string} checkedAt    ISO 时间串；`''` = 从没探过
 * @property {number} calls        调用次数
 * @property {number} in           输入 token 数（= input + cacheRead + cacheWrite 的合计）
 * @property {number} out          输出 token 数
 * @property {string} usageAt      ISO 时间串：`usage` 那几项**上一次从 transcript 算出来的**时刻。
 *                                 `''` = 从没算过（或老版本写的条目）。★ 它与 `checkedAt` 是两件事：
 *                                 一个记"上次探测"，一个记"上次记账"。
 * @property {Record<string, ModelUsage>} models
 *                                 `模型 id → 用量`。**花费只能从这一份算**——一把 key 会同时
 *                                 跑好几个模型，只有一个总数的话，价格根本没处落。
 *                                 `{}` = 没有明细（老条目，或这个 token 一次都没用过）
 */

/**
 * @typedef {object} Pool
 * @property {number} version
 * @property {string} updatedAt 上一次落盘的时间（ISO 串；从没写过是 `''`）
 * @property {string} redis    Redis 地址（`''` = 没配）。**可能带密码**，所以它只住这里，
 *                             不进 `config.json`——那份文件是"旧版本会整份拒载"的承重配置
 * @property {number} rr      轮询游标
 * @property {Record<string, string>} lastPick cwd → 上次挑中的 token 名
 * @property {Record<string, PoolEntry>} entries
 */

/**
 * ★ **用量只存在 `entries[].in/out` 里，没有第二份。**
 * 早先的设计在顶层留了一张 `usage` 汇总表，但那张表与条目里的数字说的是同一件事，
 * 早晚会有一个先更新、一个后更新——"用量显示 0 却排到候选末尾"这种鬼故事就是这么来的。
 * @returns {Pool}
 */
export function defaultPool() {
  return { version: POOL_VERSION, updatedAt: '', redis: '', rr: 0, lastPick: {}, entries: {} };
}

/**
 * 把一个值收成**有限、非负的整数**。不是就不算（返回 0）。
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * 状态归一化：认不出来的**一律降级成 `unknown`**，不是丢掉这一条。
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeStatus(value) {
  return typeof value === 'string' && STATUSES.includes(value) ? value : STATUS.UNKNOWN;
}

/**
 * 状态的中文标签。**认不出来的按 `unknown`**，与 `normalizeStatus()` 同一个口径——
 * 显示与判定用两套规矩的话，表格里就会出现一个判不出、却又显示得很确定的词。
 * @param {unknown} value
 * @returns {string}
 */
export function statusLabel(value) {
  return STATUS_LABEL[normalizeStatus(value)];
}

/**
 * 单条记录归一化。**不是对象就返回 `null`**（由调用方丢掉）。
 * @param {unknown} raw
 * @returns {PoolEntry | null}
 */
export function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  return {
    status: normalizeStatus(r.status),
    detail: str(r.detail),
    checkedAt: str(r.checkedAt),
    calls: num(r.calls),
    in: num(r.in),
    out: num(r.out),
    usageAt: str(r.usageAt),
    models: normalizeModelUsage(r.models),
  };
}

/**
 * `models` 那张表的归一化。**认不出的条目丢掉，认得出的按 0 补齐**。
 *
 * ★ **全零的行不保留**：`{m1:{input:0,…}}` 与"没有这一行"说的是同一件事，
 *   留着它只会让 `pool.json` 随模型清单一起长胖，还会让"没价的模型"那个计数虚高。
 *
 * @param {unknown} raw
 * @returns {Record<string, ModelUsage>}
 */
export function normalizeModelUsage(raw) {
  /** @type {Record<string, ModelUsage>} */
  const out = {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw)) {
    if (id === '') continue;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = /** @type {Record<string, unknown>} */ (value);
    const row = {
      input: num(r.input),
      cacheRead: num(r.cacheRead),
      cacheWrite: num(r.cacheWrite),
      output: num(r.output),
    };
    if (row.input + row.cacheRead + row.cacheWrite + row.output === 0) continue;
    out[id] = row;
  }
  return out;
}

/**
 * 把盘上的东西收成**一定可用**的形状。**永不抛错**。
 *
 * 宽容到什么程度：
 * - 整个文件不是对象 → 全默认
 * - `entries` / `lastPick` 不是对象 → 空表
 * - 某一条不是对象 → 丢掉那一条（其余照常）
 * - 顶层多出来的键（旧版本写的 `usage` 之类）→ **不认，也不报错**
 * - `lastPick` 超过上限 → 只留前 `MAX_LAST_PICK` 个键
 *
 * ⚠️ **这里没法判断"孤立条目"**（即 `tokens/<name>.json` 已不存在）——
 * 那要知道盘上有哪些 token，是 I/O。过滤在 CLI 层做。
 *
 * @param {unknown} raw
 * @returns {Pool}
 */
export function normalizePool(raw) {
  const out = defaultPool();
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = /** @type {Record<string, unknown>} */ (raw);

  out.version = POOL_VERSION;
  out.updatedAt = str(r.updatedAt);
  out.redis = str(r.redis).trim();
  out.rr = num(r.rr);

  if (r.entries && typeof r.entries === 'object' && !Array.isArray(r.entries)) {
    for (const [name, value] of Object.entries(r.entries)) {
      if (name === '') continue;
      const entry = normalizeEntry(value);
      if (entry !== null) out.entries[name] = entry;
    }
  }

  if (r.lastPick && typeof r.lastPick === 'object' && !Array.isArray(r.lastPick)) {
    const pairs = Object.entries(r.lastPick)
      .filter(([k, v]) => k !== '' && typeof v === 'string' && v !== '')
      .slice(0, MAX_LAST_PICK);
    for (const [k, v] of pairs) out.lastPick[k] = /** @type {string} */ (v);
  }

  return out;
}

/**
 * 一个条目的总量（输入 + 输出）。
 *
 * ★ **`calls` 不参与**：一次调用可能吞掉十万 token，也可能只吞两个。
 * 按"次数"分配会让长会话的那把 key 一直被优先挑走，与"省额度"的目的正好相反。
 * @param {PoolEntry | undefined | null} entry
 * @returns {number}
 */
export function totalUsed(entry) {
  if (!entry) return 0;
  return num(entry.in) + num(entry.out);
}

/**
 * 一行的用量（**已经算好花费**）。
 *
 * ★ `cost: null` 与 `cost: 0` 是两件事：前者是"不知道"（没有任何一个模型查得到价），
 *   后者是"确实花了 0"。渲染成 `$0` 而真相是"没配价格"，是本项目反复栽的那个坑。
 *
 * @typedef {object} RowUsage
 * @property {number} calls
 * @property {number} in
 * @property {number} out
 * @property {number | null} cost    已定价那部分的花费；`null` = 一个模型都查不到价
 * @property {number} unpriced       有用量、但查不到价的模型**个数**
 * @property {string} syncedAt       这一行的用量是什么时候算出来的；`''` = 没算过
 */

/**
 * 概览的输入：一行一个 token。**只放概览用得上的东西**，不是整个视图模型。
 *
 * @typedef {object} SummaryRow
 * @property {string} url
 * @property {string} status
 * @property {string} checkedAt
 * @property {RowUsage} usage
 */

/**
 * 概览条的全部数字与提示（`resourcesSummary`）。**纯函数，页面只画不翻。**
 *
 * 为什么要集中算：概览里每一个数字都是"所有行加起来"，而"加起来"至少有三处
 * 容易各写各的——合计花费、部分无价的标记、以及"哪些状态该出现"。
 * 让浏览器各算一遍，结果是同一个页面上两个数字互相对不上。
 *
 * 花费的三条规矩（与 `usage` 完全同源）：
 * - **没有任何用量 ⇒ `null`**（渲染 `—`，不是 `$0`）
 * - **有用量但一个模型都没价 ⇒ `null`**（同上；`$0` 会说"免费"，那是谎话）
 * - **部分无价 ⇒ 数字是下限**，`costPartial = true`（渲染成 `$0.42+`）
 *
 * `insights` **最多两条**，按"现在就该动手"的程度排序。全给出来等于没给——
 * 概览条只有一行，第三条一定被挤掉，而用户不知道还有第三条。
 *
 * @param {SummaryRow[]} rows
 * @param {Date | number | string} [now]
 * @returns {{
 *   total: number,
 *   counts: { status: string, label: string, count: number }[],
 *   calls: number, in: number, out: number,
 *   cost: number | null, costPartial: boolean, unpriced: number,
 *   syncedAt: string,
 *   insights: string[],
 * }}
 */
export function summarizePool(rows, now = new Date()) {
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r !== null && typeof r === 'object' && !Array.isArray(r))
    .map((r) => {
      const o = /** @type {Record<string, unknown>} */ (r);
      return {
        url: str(o.url),
        status: normalizeStatus(o.status),
        checkedAt: str(o.checkedAt),
        usage: normalizeRowUsage(o.usage),
      };
    });

  /** 状态计数：**只留有条目的状态**，顺序是 `STATUSES`（好坏顺序，不是字母序）。 */
  const counts = STATUSES.map((status) => ({
    status,
    label: STATUS_LABEL[status],
    count: list.filter((r) => r.status === status).length,
  })).filter((c) => c.count > 0);

  let calls = 0;
  let inTokens = 0;
  let outTokens = 0;
  let priced = 0;
  let unpriced = 0;
  let syncedAt = '';
  let hasUsage = false;

  for (const row of list) {
    const u = row.usage;
    calls += u.calls;
    inTokens += u.in;
    outTokens += u.out;
    unpriced += u.unpriced;
    if (u.cost !== null) priced += u.cost;
    if (u.calls + u.in + u.out > 0) hasUsage = true;
    if (u.syncedAt !== '' && newerThan(u.syncedAt, syncedAt)) syncedAt = u.syncedAt;
  }

  const costPartial = unpriced > 0;
  const cost = priced > 0 || (!costPartial && hasUsage) ? priced : null;

  return {
    total: list.length,
    counts,
    calls,
    in: inTokens,
    out: outTokens,
    cost,
    costPartial,
    unpriced,
    syncedAt,
    insights: buildInsights(list, { counts, unpriced, syncedAt, now }),
  };
}

/**
 * 概览里的那一行提示。**最多两条**，越靠前越该现在动手。
 * @param {{ url: string, status: string, checkedAt: string, usage: RowUsage }[]} list
 * @param {{ counts: { status: string, count: number }[], unpriced: number, syncedAt: string, now: Date | number | string }} ctx
 * @returns {string[]}
 */
function buildInsights(list, ctx) {
  /** @type {string[]} */
  const out = [];
  const total = list.length;
  if (total === 0) return ['还没有 token——先加一个，或者从表格批量导入'];

  const countOf = (/** @type {string} */ status) =>
    ctx.counts.find((c) => c.status === status)?.count ?? 0;
  const ok = countOf(STATUS.OK);
  const unknown = countOf(STATUS.UNKNOWN);

  // ① 一把能用的都没有。★ 全是 unknown 时**不能说"没有可用的"**——
  //    没探过不等于不能用，那句会把一个从没检测过的新池吓成"全挂了"。
  if (ok === 0 && unknown === total) {
    out.push(`${total} 个 token 都没检测过——「全部检测」跑一遍就知道谁有余额`);
  } else if (ok === 0) {
    out.push(`${total} 个 token 没有一个处于「有余额」——先换一把 key，或等月初额度刷新`);
  }

  // ② 花费算不全
  if (ctx.unpriced > 0) {
    out.push(`${ctx.unpriced} 个模型查不到价格，合计花费只是下限`);
  }

  // ③ 从没算过用量
  if (ctx.syncedAt === '') {
    out.push('用量还没算过——「重算用量」跑一次才有数');
  }

  // ④ 全挤在一个网关上
  /** @type {Map<string, number>} */
  const byUrl = new Map();
  for (const row of list) {
    if (row.url === '') continue;
    byUrl.set(row.url, (byUrl.get(row.url) ?? 0) + 1);
  }
  let top = 0;
  for (const n of byUrl.values()) top = Math.max(top, n);
  if (top >= 2 && top * 2 >= total) {
    out.push(`${top} 个 token 共用同一个网关（共 ${total} 个）——网关一挂，全都没得用`);
  }

  // ⑤ 用量放久了
  const ageHours = (toMs(ctx.now) - toMs(ctx.syncedAt)) / 3_600_000;
  if (ctx.syncedAt !== '' && Number.isFinite(ageHours) && ageHours >= 24) {
    out.push(`用量是 ${Math.floor(ageHours / 24)} 天前算的——会话记录变了，重算一次才准`);
  }

  // ⑥ 跨月了：`no_quota` 的额度按月刷新，这是最容易白等一个月的一条
  const rolled = list.filter(
    (r) => r.status === STATUS.NO_QUOTA && crossedMonth(r.checkedAt, ctx.now),
  ).length;
  if (rolled > 0) {
    out.push(`${rolled} 个「无余额」的 token 跨月了，额度多半已刷新——再检测一次`);
  }

  return out.slice(0, 2);
}

/**
 * `a` 是不是比 `b` 新。`b` 为 `''` 时恒真（第一个非空的时间就是最新的）。
 * 两个都解析不出来时**保留先遇到的那个**——宁可显示一个早了的时间，也不要 `''`。
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function newerThan(a, b) {
  if (b === '') return true;
  const ma = toMs(a);
  const mb = toMs(b);
  if (!Number.isFinite(ma)) return false;
  if (!Number.isFinite(mb)) return true;
  return ma > mb;
}

/**
 * 两个时间是不是**不同的月**（本机时区）。解析不出来 ⇒ `false`（不敢下结论）。
 * @param {string} checkedAt
 * @param {Date | number | string} now
 * @returns {boolean}
 */
function crossedMonth(checkedAt, now) {
  const a = toDate(checkedAt);
  const b = toDate(now);
  if (a === null || b === null) return false;
  return a.getFullYear() !== b.getFullYear() || a.getMonth() !== b.getMonth();
}

/**
 * 概览输入的 `usage` 归一化。**认不出的一律按 0 / null**（同 `normalizeEntry` 的宽容）。
 * @param {unknown} raw
 * @returns {RowUsage}
 */
function normalizeRowUsage(raw) {
  /** @type {RowUsage} */
  const out = { calls: 0, in: 0, out: 0, cost: null, unpriced: 0, syncedAt: '' };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const r = /** @type {Record<string, unknown>} */ (raw);
  out.calls = num(r.calls);
  out.in = num(r.in);
  out.out = num(r.out);
  out.unpriced = num(r.unpriced);
  out.syncedAt = str(r.syncedAt);
  // 花费是小数（美元），不能走 num()——那个会 floor 成 0
  const c = r.cost;
  if (typeof c === 'number' && Number.isFinite(c) && c >= 0) out.cost = c;
  return out;
}

/**
 * @param {Date | number | string} value
 * @returns {number} 毫秒；认不出来返回 `NaN`
 */
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}

/**
 * @param {Date | number | string} value
 * @returns {Date | null}
 */
function toDate(value) {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * 从没探过 ⇒ 立刻该探。
 * @param {string} checkedAt
 * @param {Date | number | string} now
 * @returns {boolean}
 */
function neverChecked(checkedAt, now) {
  if (checkedAt === '') return true;
  const checked = toMs(checkedAt);
  const at = toMs(now);
  if (!Number.isFinite(checked) || !Number.isFinite(at)) return true;
  // 时间倒流（改了系统时钟 / 手改坏了文件）⇒ 当作没探过
  return checked > at;
}

/**
 * **这个条目该不该重探？** 池的全部成本都由这一个函数决定。
 *
 * | 上次状态 | 判据 |
 * |---|---|
 * | 从没探过 / `checkedAt` 坏了 | 立刻 |
 * | `no_quota` | **跨月才重探**（额度按月刷新） |
 * | `invalid` | 超过 `INVALID_CACHE_SECONDS` |
 * | 其余（`ok` / `net_fail` / `other` / `unknown`） | 超过 `cacheSeconds` |
 *
 * ★★ **`no_quota` 那条不是"更大的超时"，是另一条规则**：额度是按自然月重置的，
 * 月初 00:00 一过，昨天还"用尽"的 key 就又是满的。拿时间差近似它，
 * 结果就是月初第一天把整池都当成"还没恢复"，白白错过一整个月的额度。
 *
 * 月份按**本机时区**算——用户看的是自己的日历，不是 UTC。
 *
 * @param {PoolEntry | undefined | null} entry
 * @param {Date | number | string} now
 * @param {{ cacheSeconds?: number }} [opts]
 * @returns {boolean}
 */
export function isStale(entry, now, opts = {}) {
  if (!entry) return true;
  if (neverChecked(entry.checkedAt, now)) return true;

  const checked = /** @type {Date} */ (toDate(entry.checkedAt));
  const at = /** @type {Date} */ (toDate(now));
  const ageSeconds = (at.getTime() - checked.getTime()) / 1000;

  if (entry.status === STATUS.NO_QUOTA) {
    return (
      checked.getFullYear() !== at.getFullYear() || checked.getMonth() !== at.getMonth()
    );
  }

  const window =
    entry.status === STATUS.INVALID
      ? INVALID_CACHE_SECONDS
      : num(opts.cacheSeconds) > 0
        ? num(opts.cacheSeconds)
        : DEFAULT_CACHE_SECONDS;

  return ageSeconds >= window;
}

/**
 * **池的用量该不该重算？** —— 与 `isStale()` 平行的一道判据，管的是另一件事。
 *
 * | 情况 | 判据 |
 * |---|---|
 * | 池里没有条目 | **不算**（没事可做，也就不该碰盘） |
 * | 任何一条 `usageAt` 为空 / 坏了 / 在未来 | 立刻 |
 * | 任何一条超过 `usageSeconds` | 立刻 |
 * | 全部新鲜 | 不算 |
 *
 * ★★ **"任何一条"而不是"全部"**：重算一次是**整池覆盖**——遍历一遍会话记录，
 * 把所有条目的 `models` 一起重写。所以只要有一条落后，做一遍就顺手把全体都追上。
 * 反过来若要求"全部过期"，一个刚入池的新 token 会**永远拖着整池不刷新**：
 * 它的 `usageAt` 是 `''`（立刻该算），而老条目的还没到期 —— 两条判据互相等，
 * 结果是两边都不动。
 *
 * ★ 判据落在**条目**而不是"上次整体重算的时刻"：`pool.json` 里没有那个字段，
 * 硬加一个就是第二处真相。契约「用量与花费」那节 9.1 的"重算是覆盖"靠的正是 `usageAt`
 * 一条一条写、整批共用同一个时刻。
 *
 * ★ 空池返回 `false` 是有意的：调用方（面板启动 / `pool list`）据此**完全不碰磁盘**。
 * "没有可重算的对象"不该留下任何痕迹。
 *
 * @param {Record<string, PoolEntry>} entries
 * @param {Date | number | string} now
 * @param {{ usageSeconds?: number }} [opts]
 * @returns {boolean}
 */
export function usageStale(entries, now = new Date(), opts = {}) {
  if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) return false;
  const list = Object.values(entries);
  if (list.length === 0) return false;

  const at = toMs(now);
  if (!Number.isFinite(at)) return true;
  const window =
    num(opts.usageSeconds) > 0 ? num(opts.usageSeconds) : DEFAULT_USAGE_SECONDS;

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const stamp = /** @type {PoolEntry} */ (entry).usageAt;
    if (stamp === '') return true;
    const spent = toMs(stamp);
    // 坏了 / 时间倒流（手改过文件或改了系统时钟）⇒ 当作没算过
    if (!Number.isFinite(spent) || spent > at) return true;
    if ((at - spent) / 1000 >= window) return true;
  }
  return false;
}

/**
 * 额度探测的**分类器**——把一次 HTTP 应答翻成状态词。纯函数，不联网。
 *
 * 判定顺序是刻意的：
 *
 * 1. **2xx 就是有余额**，不看响应体。（有的网关成功也带 `quota` 字样，
 *    比如回来了个 `remaining_quota` 字段——先看状态码就不会误伤。）
 * 2. `402 Payment Required` ⇒ 无余额。这是**协议级**的信号，比任何字符串都硬。
 * 3. **`429` 单独处理**：它是限流，不是没钱。默认放行（`other`，仍然参与候选），
 *    只有正文明确说到余额/欠费才判死。★ 这一条是**原方案没有的**——
 *    直接把 `429` 里出现的 `quota` 当成"额度用尽"，会让一个只是撞上
 *    限流的 key 被排除到**下个月**，等于平白丢掉一整个账户。
 * 4. 响应体里有额度耗尽的字样 ⇒ 无余额。各家中转站的措辞五花八门，
 *    但 `insufficient_user_quota` / `额度` / `quota` 这几样覆盖了绝大多数，
 *    所以宁可宽一点（判错的代价只是少一个候选，不是少一个可用会话）。
 * 5. `401` ⇒ 密钥无效。同样是协议级信号。
 * 6. 响应体里有认证失败的字样 ⇒ 密钥无效（有的网关把无效 key 报成 403/400）。
 * 7. 剩下的一律 `other`。**默认不冤枉任何一把 key**——`other` 不会被排除出候选。
 *
 * @param {{ status?: number, body?: unknown }} input
 *   `status` 不是有限数字（网络没通）⇒ `net_fail`；`body` 可以是字符串或对象。
 * @returns {string} `STATUS` 之一（不会是 `unknown`）
 */
export function classifyProbe(input) {
  const status = input && typeof input.status === 'number' ? input.status : NaN;
  if (!Number.isFinite(status) || status <= 0) return STATUS.NET_FAIL;

  if (status >= 200 && status < 300) return STATUS.OK;
  if (status === 402) return STATUS.NO_QUOTA;

  const text = bodyText(input.body);

  if (status === 429) {
    return STRONG_QUOTA_HINTS.some((hint) => text.includes(hint))
      ? STATUS.NO_QUOTA
      : STATUS.OTHER;
  }

  if (QUOTA_HINTS.some((hint) => text.includes(hint))) return STATUS.NO_QUOTA;
  if (status === 401) return STATUS.INVALID;
  if (INVALID_HINTS.some((hint) => text.includes(hint))) return STATUS.INVALID;
  return STATUS.OTHER;
}

/**
 * 额度耗尽的字样。**小写比较**（中文没有大小写，不受影响）。
 * @type {readonly string[]}
 */
const QUOTA_HINTS = Object.freeze([
  'insufficient_user_quota',
  'insufficient_quota',
  'quota',
  '额度',
  '余额不足',
  '欠费',
]);

/**
 * 额度耗尽的**硬**字样：见到就能断定"这个账户没钱了"，不会被限流混淆。
 * @type {readonly string[]}
 */
const STRONG_QUOTA_HINTS = Object.freeze([
  'insufficient_user_quota',
  'insufficient_quota',
  '额度不足',
  '余额不足',
  '欠费',
  '余额已用尽',
]);

/**
 * 认证失败的字样。
 * @type {readonly string[]}
 */
const INVALID_HINTS = Object.freeze([
  'invalid',
  'unauthor',
  'authentication',
  'api key',
  '无效',
  '认证失败',
]);

/**
 * 把响应体摊成一段可搜索的小写文本。
 *
 * ★ 对象要 `JSON.stringify` **再小写**——直接 `String(obj)` 会得到 `[object Object]`，
 * 那就一个关键字都搜不到了。
 * @param {unknown} body
 * @returns {string}
 */
function bodyText(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body.toLowerCase();
  if (Buffer.isBuffer(body)) return body.toString('utf8').toLowerCase();
  try {
    return JSON.stringify(body).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 排候选顺序。**只排队，不探测、不排除"没探过"**。
 *
 * 规则：
 * - **硬排除** `no_quota` 与 `invalid` —— 这两类再试也是白试；
 * - 按总用量**升序**；用量相同按名字**升序**（保证结果与文件里的键顺序无关，
 *   否则同一份数据在两台机器上可能挑出不同的 key）；
 * - 然后**只把"并列最小的那一组"按游标 `rr` 循环左移**。
 *
 * ★★ 为什么游标只转**头一组**、不转整张表：整张表转的话，游标每走一格，
 * 排在最前面的就会落到"用量最多的"头上——那等于**主动**把最该歇着的那把 key
 * 挑出来用，"少用优先"当场失效。游标在这个设计里只有一个职责：
 * **在同样少用的几个之间决定先试谁**。所以它只碰并列第一组，其余顺序一字不动。
 *
 * （全部用量相同 = 只有一个组 = 整张表都在转，那就是纯粹的轮询——也正该如此。）
 *
 * `round-robin` 策略不看用量：整张表按名字排序后直接轮转。
 *
 * ★★ **「在用靠后」因子**（`opts.activeTokens`）：把**正在被活动会话持有**的 token
 * 移到候选表**末尾**——所有不在用的排完，才轮到在用的。它只是**排序，不是排除**：
 * 在用 ≠ 不能用（同一个 token 多开是允许的，契约 §8 的"同 token 多窗"条目），
 * 只是默认别抢人家正在用的那把钥匙。传空 / 不传时行为与旧版**逐字节一致**。
 *
 * @param {Record<string, PoolEntry>} entries
 * @param {{ policy?: string, rr?: number, activeTokens?: Set<string> | string[] }} [opts]
 * @returns {string[]} 依次尝试的名字
 */
export function orderCandidates(entries, opts = {}) {
  const table = entries && typeof entries === 'object' ? entries : {};
  const active = toActiveSet(opts.activeTokens);
  /** @type {string[]} */
  const fresh = [];
  /** @type {string[]} */
  const inUse = [];

  for (const [name, entry] of Object.entries(table)) {
    if (name === '') continue;
    const status = normalizeStatus(entry && entry.status);
    if (status === STATUS.NO_QUOTA || status === STATUS.INVALID) continue;
    (active !== null && active.has(name) ? inUse : fresh).push(name);
  }

  // 两组各按策略排好，再拼接——不在用的全排完才轮在用的。
  return byPolicy(fresh, table, opts).concat(byPolicy(inUse, table, opts));
}

/**
 * `opts.activeTokens` 容两种写法（Set 或数组）；认不出 → `null`（= 旧行为）。
 * @param {unknown} raw
 * @returns {Set<string> | null}
 */
function toActiveSet(raw) {
  if (raw instanceof Set) return raw;
  if (Array.isArray(raw)) {
    return new Set(raw.filter((x) => typeof x === 'string'));
  }
  return null;
}

/**
 * 按策略给**一组**名字排序（`orderCandidates` 的内核；分组 = 不在用 / 在用）。
 *
 * 游标 `rr` 只作用于这一组里"并列最小的那一组"——分组的引入不改变它的职责
 * （见 `rotateTies` 上的那段）。
 *
 * @param {string[]} names
 * @param {Record<string, PoolEntry>} table
 * @param {{ policy?: string, rr?: number }} opts
 * @returns {string[]}
 */
function byPolicy(names, table, opts) {
  if (names.length === 0) return [];
  if (opts.policy === POLICY.ROUND_ROBIN) {
    return rotate(names.slice().sort(), num(opts.rr));
  }
  const sorted = names.slice().sort((a, b) => {
    const d = totalUsed(table[a]) - totalUsed(table[b]);
    if (d !== 0) return d;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return rotateTies(sorted, table, num(opts.rr));
}

/**
 * 只转"并列最小的那一组"。
 * @param {string[]} sorted 已按 (用量, 名字) 排好序
 * @param {Record<string, PoolEntry>} table
 * @param {number} by
 * @returns {string[]}
 */
function rotateTies(sorted, table, by) {
  if (sorted.length < 2) return sorted.slice();

  const head = totalUsed(table[sorted[0]]);
  let end = 1;
  while (end < sorted.length && totalUsed(table[sorted[end]]) === head) end += 1;

  return rotate(sorted.slice(0, end), by).concat(sorted.slice(end));
}

/**
 * 循环左移。**负数与超出长度的游标都要能算**——游标是盘上的一个数，
 * 手改过、或者条目被删过，都会让它落在合法范围外。
 * @template T
 * @param {T[]} list
 * @param {number} by
 * @returns {T[]}
 */
export function rotate(list, by) {
  const n = list.length;
  if (n === 0) return [];
  const k = ((by % n) + n) % n;
  if (k === 0) return list.slice();
  return list.slice(k).concat(list.slice(0, k));
}

/**
 * 把批量的表格行映射成 `{name, secret}`。
 *
 * 规矩：
 * - 只认**第 0 列名字、第 1 列密钥**（现状工具的表就是这么排的）；
 * - 全空的行跳过（Excel 常在末尾屯一堆空行）；
 * - **首行可能是表头**：第二列是 `sk` / `key` / `密钥` 之类，或者第一列是
 *   `name` / `名称`，就当表头跳过。只看首行——正文里出现一个叫 "key" 的 token
 *   是真事，不能按行判断；
 * - 密钥前面粘了 `Bearer ` 的，剥掉（从命令行粘过来的人常常带）；
 * - **同一个文件里重名的，只留第一个**（后面的丢进 `duplicate`）。
 *
 * ⚠️ 这里**不判断"这个名字已经存在"**——那要读盘，是 I/O。CLI 层再滤一遍。
 *
 * @param {string[][]} rows
 * @returns {{
 *   items: { name: string, secret: string }[],
 *   skipped: { blank: number, header: number, malformed: number, duplicate: number },
 * }}
 */
export function mapImportRows(rows) {
  const items = [];
  const skipped = { blank: 0, header: 0, malformed: 0, duplicate: 0 };
  /** @type {Set<string>} */
  const seen = new Set();
  let first = true;

  for (const row of Array.isArray(rows) ? rows : []) {
    const name = str(Array.isArray(row) ? row[0] : '').trim();
    let secret = str(Array.isArray(row) ? row[1] : '').trim();

    if (name === '' && secret === '') {
      skipped.blank += 1;
      continue;
    }

    if (/^bearer\s+/i.test(secret)) secret = secret.replace(/^bearer\s+/i, '').trim();

    if (first) {
      first = false;
      if (looksLikeHeader(name, secret)) {
        skipped.header += 1;
        continue;
      }
    }

    if (!isImportableName(name) || !isImportableSecret(secret)) {
      skipped.malformed += 1;
      continue;
    }

    if (seen.has(name)) {
      skipped.duplicate += 1;
      continue;
    }

    seen.add(name);
    items.push({ name, secret });
  }

  return { items, skipped };
}

/**
 * @param {string} name
 * @param {string} secret
 * @returns {boolean}
 */
function looksLikeHeader(name, secret) {
  return (
    /^(name|名称|名字|token|令牌|备注)$/i.test(name) ||
    /^(sk|key|apikey|api[ _-]?key|secret|密钥|密钥值)$/i.test(secret)
  );
}

/**
 * 名字的**最低限度**校验。真正的规矩（长度上限、路径穿越、保留字）
 * 在各项目自己的 schema 里——这里只滤掉"明显是表格垃圾"的东西。
 * @param {string} name
 * @returns {boolean}
 */
function isImportableName(name) {
  if (name === '' || name.length > 64) return false;
  return !/[\\/:*?"<>|\x00-\x1f]/.test(name);
}

/**
 * 密钥的**形状**校验。
 *
 * ★ 只要求"像一把凭证"：8–200 个 URL 安全的字符。**不要求 `sk-` 前缀**——
 * 中转站自签的键、JWT、随机 hex 都真实存在，硬套前缀会把好行当成垃圾。
 * @param {string} secret
 * @returns {boolean}
 */
function isImportableSecret(secret) {
  if (secret.length < 8 || secret.length > 200) return false;
  return !/[^A-Za-z0-9._\-]/.test(secret);
}
