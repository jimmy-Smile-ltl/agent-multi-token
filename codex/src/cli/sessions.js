// @ts-check
/**
 * 会话在场层（§2.16 一 / 二）的 CLI 层：写 meta、列会话、清会话。
 *
 * 三条纪律：
 *
 * 1. **写失败绝不阻塞会话**——`recordSessionStart` 整段 try/catch，只打一行警告。
 *    在场层是锦上添花，它坏了不许让窗口打不开（§2.16 一）。
 * 2. **写者是 `cxt exec`**（会话进程本身），不是 `cxt run`——后者 spawn 完就撒手，
 *    detached + unref，根本看不到这个进程的生死（§2.16 一的来历）。
 * 3. **活性三态读时现算**（`core/sessions.js` + `platform/pid.js`），**不落盘状态**
 *    ——落盘就多一个会过期的真相（§2.16 二）。
 *
 * ⚠️ **meta 永不记 argv**：`normalizeSessionMeta()` 是白名单，这里也**只挑安全字段**。
 * `--token-value` 是明文 sk，落进 meta 就是第二个密钥落盘点（§2.16 一）。
 */
import { emptyMeta, makeSessionId, olderThan, sessionStateOf } from '../core/sessions.js';
import { profileNameFor } from '../core/paths.js';
import {
  listSessionIds,
  listSessionMessages,
  readSessionMeta,
  removeSessionDir,
  writeSessionMeta,
} from '../core/store.js';
import { isPidAlive } from '../platform/pid.js';

/**
 * @typedef {object} SessionRow
 * @property {string} id
 * @property {ReturnType<typeof emptyMeta>} meta
 * @property {boolean} alive
 * @property {string} state  `live` | `ended` | `dead`
 * @property {number} unread  inbox 里的消息条数
 */

/**
 * 启动时写一条在场记录。**永不抛**——失败只警告，会话照常启动。
 * @param {import('./types.js').Ctx} ctx
 * @param {{ resolved: any }} input 解析产物（`tokenName` / `cwd` / `models` 三项只读）
 * @returns {{ id: string } | null} 写成功时的会话 id（exec 用它注入 `CXT_SESSION_ID`）
 */
export function recordSessionStart(ctx, input) {
  try {
    const resolved = input?.resolved ?? {};
    const profile = typeof resolved.profileName === 'string' && resolved.profileName !== ''
      ? resolved.profileName
      : profileNameFor(resolved.tokenName?.value ?? null);

    const id = makeSessionId({ profile, at: Date.now(), pid: process.pid });

    const cwdValue = resolved.cwd?.value;
    const cwd = typeof cwdValue === 'string' && cwdValue !== '' ? cwdValue : ctx.cwd;

    const models = resolved.models?.value;
    const model =
      Array.isArray(models) && models.length > 0 && typeof models[0]?.id === 'string'
        ? models[0].id
        : '';

    writeSessionMeta(ctx.home, {
      ...emptyMeta(),
      id,
      token: profile,
      cwd,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      model,
    });
    return { id };
  } catch (err) {
    process.stderr.write(`⚠ 在场记录没写成（不影响本次会话）：${/** @type {any} */ (err)?.message ?? err}\n`);
    return null;
  }
}

/**
 * 正常退出时补 `endedAt` / `exitCode`（**读-改-写整份**）。**永不抛**。
 * @param {import('./types.js').Ctx} ctx
 * @param {string} id
 * @param {number | null | undefined} exitCode
 */
export function recordSessionEnd(ctx, id, exitCode) {
  try {
    const meta = readSessionMeta(ctx.home, id);
    if (meta === null) return;
    writeSessionMeta(ctx.home, {
      ...meta,
      endedAt: new Date().toISOString(),
      exitCode: Number.isInteger(exitCode) ? /** @type {number} */ (exitCode) : null,
    });
  } catch {
    /* 退出收尾失败不打扰任何人——记录已经尽力了 */
  }
}

/**
 * 全部会话（三态现算）+ 未读数。**只对"没有 endedAt"的候选探 pid**（§2.16 二）。
 * @param {import('./types.js').Ctx} ctx
 * @returns {SessionRow[]}
 */
export function listSessions(ctx) {
  /** @type {SessionRow[]} */
  const out = [];
  for (const id of listSessionIds(ctx.home)) {
    const meta = readSessionMeta(ctx.home, id);
    if (meta === null) continue;
    const alive = meta.endedAt === '' ? isPidAlive(meta.pid) : false;
    out.push({
      id,
      meta,
      alive,
      state: sessionStateOf(meta, alive),
      unread: listSessionMessages(ctx.home, id).length,
    });
  }
  return out;
}

/**
 * 活动会话正持有的 token（池排序的「在用靠后」因子用，§2.15 四）。
 * @param {import('./types.js').Ctx} ctx
 * @returns {Set<string>}
 */
export function activeTokensOf(ctx) {
  const set = new Set();
  for (const s of listSessions(ctx)) {
    if (s.state === 'live' && s.meta.token !== '') set.add(s.meta.token);
  }
  return set;
}

/**
 * 删超龄会话。规则（§2.16 四）：
 *
 * | 情形 | 处置 |
 * |---|---|
 * | `live` | **永不删**——无论多老 |
 * | 未超龄 | 保留 |
 * | 超龄但**有未读** | 保留，**除非 `force`**——纸条可能还没人看 |
 * | 其余 | 删 |
 *
 * ★ 超龄判据用 `endedAt`（异常退出没有它，退回 `startedAt`）。
 * @param {import('./types.js').Ctx} ctx
 * @param {{ olderThanMs: number, force?: boolean, now?: Date }} opts
 * @returns {{ removed: string[], keptLive: number, keptUnread: string[], keptYoung: number }}
 */
export function pruneSessions(ctx, opts) {
  const now = opts.now ?? new Date();
  const force = opts.force === true;
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const keptUnread = [];
  let keptLive = 0;
  let keptYoung = 0;

  for (const s of listSessions(ctx)) {
    if (s.state === 'live') {
      keptLive += 1;
      continue;
    }
    const stamp = s.meta.endedAt !== '' ? s.meta.endedAt : s.meta.startedAt;
    if (!olderThan(stamp, now, opts.olderThanMs)) {
      keptYoung += 1;
      continue;
    }
    if (s.unread > 0 && !force) {
      keptUnread.push(s.id);
      continue;
    }
    if (removeSessionDir(ctx.home, s.id)) removed.push(s.id);
  }

  return { removed, keptLive, keptUnread, keptYoung };
}
