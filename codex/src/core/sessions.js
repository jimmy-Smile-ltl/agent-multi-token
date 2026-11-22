// @ts-check
/**
 * 会话在场层与消息信箱的**纯逻辑**。
 *
 * ─────────────────────────────────────────────────────────────
 * **纯函数**：不读 fs、不读 `process.env` / `process.platform`、不发网络、不碰时间源
 * ——`now` / `rand` 一律由调用方注入。落盘在各自的 `core/store.js`，
 * 活性探测在 `platform/pid.js`（那是宿主能力，core 不碰）。
 * 与 `pool.js` 同一纪律：只导出**中立**函数，不认识工具名、环境变量名、契约节号。
 *
 * ★ **读要宽容、永不抛错**：在场记录与消息都是**可丢弃**的（契约 §3.4），
 * 手改坏了不该让任何命令失败——只该退化成"没有记录"。
 * ─────────────────────────────────────────────────────────────
 */

/** `meta.json` 的版本（独立于 `config.json` / `pool.json`，别混） */
export const SESSIONS_VERSION = 1;

/** 消息文件的版本（与 meta 分开演进：消息形状将来可能加线程，meta 不会） */
export const MESSAGE_VERSION = 1;

/**
 * 会话三态。**不落盘**——读时现算（落盘就多一个会过期的真相）。
 *
 * | 值 | 判据 |
 * |---|---|
 * | `live` | `endedAt` 为空 **且** pid 还活着 |
 * | `ended` | `endedAt` 非空（正常退出，带 `exitCode`） |
 * | `dead` | `endedAt` 为空但进程已经没了（崩溃 / 被杀 / 终端被关） |
 */
export const SESSION_STATE = Object.freeze({
  LIVE: 'live',
  ENDED: 'ended',
  DEAD: 'dead',
});

/** 消息类型词表。顺序即显示顺序。 */
export const MESSAGE_TYPES = Object.freeze(['info', 'action-request']);

/** 消息类型的默认值。**认不出的类型降级成它**，不丢消息。 */
export const DEFAULT_MESSAGE_TYPE = 'info';

/**
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * 会话 id 是否合法（同时是**目录名安全**的判据）。
 *
 * 形状：`<profile 名>-<base36 时间>-<pid>`。profile 名允许 `_default`（下划线开头），
 * 其余字符 ⊆ `[a-z0-9_-]`。**必须拒绝路径穿越**（`..`、`/`、`\`）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidSessionId(value) {
  return typeof value === 'string' && /^[a-z0-9_][a-z0-9_-]{0,127}$/.test(value);
}

/**
 * 生成会话 id：`<profile>-<base36 时间>-<pid>`。
 *
 * 可读（一眼看出哪个 token）、可按时间排序、逐次唯一（同一 token 同一毫秒同一 pid
 * 在物理上不可能出现两次启动）。
 * @param {{ profile?: string, at?: number, pid?: number }} input
 * @returns {string}
 */
export function makeSessionId(input = {}) {
  const profile =
    typeof input.profile === 'string' && input.profile !== '' ? input.profile : '_default';
  const at = Number.isFinite(input.at) && /** @type {number} */ (input.at) > 0
    ? Math.floor(/** @type {number} */ (input.at))
    : 0;
  const pid = Number.isInteger(input.pid) && /** @type {number} */ (input.pid) > 0
    ? /** @type {number} */ (input.pid)
    : 0;
  return `${profile}-${at.toString(36)}-${pid}`;
}

/**
 * `meta.json` 归一化：**宽容、永不抛**，且**白名单**只保留九个键。
 *
 * ★★ **白名单就是那条"meta 永不记 argv"的机器守卫**：调用方哪怕把整份 argv
 * 传进来，这里也只挑出这九个字段——`--token-value` 之类的明文不可能落进 meta。
 *
 * @param {unknown} raw
 * @param {string} [fallbackId] 文件所在目录名（`id` 字段坏了时用它兜底）
 * @returns {{
 *   v: number, id: string, token: string, cwd: string, pid: number,
 *   startedAt: string, endedAt: string, exitCode: number | null, model: string,
 * }}
 */
export function normalizeSessionMeta(raw, fallbackId = '') {
  /** @type {ReturnType<typeof emptyMeta>} */
  const out = emptyMeta();
  out.id = fallbackId;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;

  const r = /** @type {Record<string, unknown>} */ (raw);
  out.id = str(r.id) || fallbackId;
  out.token = str(r.token);
  out.cwd = str(r.cwd);
  out.pid = num(r.pid);
  out.startedAt = str(r.startedAt);
  out.endedAt = str(r.endedAt);
  if (typeof r.exitCode === 'number' && Number.isFinite(r.exitCode)) {
    out.exitCode = Math.trunc(r.exitCode);
  }
  out.model = str(r.model);
  return out;
}

/**
 * 一份空 meta（`normalizeSessionMeta` 的底）。
 * @returns {{
 *   v: number, id: string, token: string, cwd: string, pid: number,
 *   startedAt: string, endedAt: string, exitCode: number | null, model: string,
 * }}
 */
export function emptyMeta() {
  return {
    v: SESSIONS_VERSION,
    id: '',
    token: '',
    cwd: '',
    pid: 0,
    startedAt: '',
    endedAt: '',
    exitCode: null,
    model: '',
  };
}

/**
 * 三态分类。**读时现算**——`alive` 由调用方用 `platform/pid.js` 探好传进来
 * （只对"没有 endedAt"的候选探，`ended` 不必探）。
 * @param {{ endedAt?: string } | null | undefined} meta
 * @param {boolean} alive
 * @returns {string} `SESSION_STATE` 之一
 */
export function sessionStateOf(meta, alive) {
  if (meta === null || meta === undefined) return SESSION_STATE.DEAD;
  if (str(meta.endedAt) !== '') return SESSION_STATE.ENDED;
  return alive === true ? SESSION_STATE.LIVE : SESSION_STATE.DEAD;
}

/**
 * 消息归一化。不是对象 ⇒ `null`（由调用方丢掉那一条）。
 *
 * ★ **认不出的 `type` 降级成 `info`**，不丢整条消息：类型只是给读者的标注，
 * 而消息本身是用户写的字——因为一个拼错的字段就把字丢了，是拿宽容换苛刻。
 * @param {unknown} raw
 * @returns {{
 *   v: number, id: string, ts: string, from: string, to: string,
 *   type: string, body: string,
 * } | null}
 */
export function normalizeMessage(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const type = str(r.type);
  return {
    v: MESSAGE_VERSION,
    id: str(r.id),
    ts: str(r.ts),
    from: str(r.from),
    to: str(r.to),
    type: MESSAGE_TYPES.includes(type) ? type : DEFAULT_MESSAGE_TYPE,
    body: str(r.body),
  };
}

/**
 * 消息文件名：`<ms>-<rand>.json`。
 *
 * ★ 时间戳排在前面，`readdir` 的原生顺序≈时间顺序；`rand` 防同一毫秒撞名
 * （两个方向同时给同一个会话发消息是真事）。
 * @param {number} atMs
 * @param {string} rand 1–16 个 `[a-z0-9]`
 * @returns {string}
 */
export function messageFileName(atMs, rand) {
  const t = Number.isFinite(atMs) && atMs > 0 ? Math.floor(atMs) : 0;
  const r = typeof rand === 'string' && /^[a-z0-9]{1,16}$/.test(rand) ? rand : '000000';
  return `${t}-${r}.json`;
}

/**
 * 消息文件名是否合法（**不合法的一律跳过**，别让一个手塞进来的怪文件把列表打崩）。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isValidMessageFileName(name) {
  return typeof name === 'string' && /^\d{1,16}-[a-z0-9]{1,16}\.json$/.test(name);
}

/**
 * 从消息文件名取时间戳（毫秒）。不合法 → `NaN`（`msg gc` 会当"说不清"跳过，不删）。
 *
 * ★ 年龄判据**不读文件内容**：文件名里的时间戳是写的那一刻，而读内容要打开文件——
 * 清理是批量动作，能省一次 IO 就省一次；何况内容坏了也照样能按年龄清掉。
 * @param {string} name
 * @returns {number}
 */
export function messageFileTime(name) {
  if (!isValidMessageFileName(name)) return NaN;
  return Number(name.slice(0, name.indexOf('-')));
}

/**
 * `--older-than` 的解析：`30d` / `12h` / `90m`。**认不出返回 `null`**，由调用方报错。
 * @param {unknown} text
 * @returns {number | null} 毫秒
 */
export function parseSpan(text) {
  if (typeof text !== 'string') return null;
  const m = /^(\d{1,6})([mhd])$/.exec(text.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
  return n * unit;
}

/**
 * 超龄判据（`sessions prune` 与 `msg gc` 共用）。
 *
 * ★ **解析不出来 / 时间在未来 ⇒ 不算超龄**：清理是删除动作，"不敢确定"时
 * 唯一的正确选择是**不删**（与 `pool.json` 的"读要宽容"同一个方向）。
 * @param {string} stamp ISO 时间串
 * @param {Date | number | string} now
 * @param {number} maxAgeMs
 * @returns {boolean}
 */
export function olderThan(stamp, now, maxAgeMs) {
  if (typeof stamp !== 'string' || stamp === '') return false;
  const t = Date.parse(stamp);
  const n = toMs(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return false;
  if (t > n) return false;
  const max = Number.isFinite(maxAgeMs) && maxAgeMs > 0 ? maxAgeMs : 0;
  return n - t >= max;
}

/**
 * @param {Date | number | string} value
 * @returns {number} 毫秒；认不出来返回 `NaN`
 */
export function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value === 'string' && value !== '') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  }
  return NaN;
}
