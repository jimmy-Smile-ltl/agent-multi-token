// @ts-check
/**
 * `cxt msg` —— 会话之间的**文件信箱**（§2.16 三）。
 *
 *     cxt msg send <id前缀|--token <t>|--all> [--type info|action-request] <文本...>
 *     cxt msg inbox [--session <id>] [--peek] [--json]
 *     cxt msg gc [--older-than 7d]
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ **消息是惰性数据：工具自己永不因消息行动。**
 * 没有 daemon、没有 hook、没有"收到消息就投进某个会话"（那要写 Codex 的状态文件，
 * §3.1 禁止）。唯一送达方式：**人告诉 agent「去看一下信箱」→ agent 自己跑
 * `cxt msg inbox`**。这是「执行权只经人、永不因投递产生」在 v1 的可执行形态——
 * `--type action-request` 只是给**读者**的标注，不产生任何执行权。
 *
 * ★ 发送者识别：`cxt exec` 把 `CXT_SESSION_ID` 注入 agent 环境（§2.6）。
 * 从会话里跑 `msg send`，`from` 就是那个会话 id；否则是 `"human"`。
 *
 * ★ **回环刹车靠结构**：没有自动转发/自动回复，A 让 B 回信需要两次人工动作。
 * ─────────────────────────────────────────────────────────────
 */
import { randomBytes } from 'node:crypto';

import { CxtError, EXIT } from '../../core/errors.js';
import {
  DEFAULT_MESSAGE_TYPE,
  MESSAGE_TYPES,
  MESSAGE_VERSION,
  isValidSessionId,
  messageFileTime,
  messageFileName,
  normalizeMessage,
  olderThan,
  parseSpan,
  toMs,
} from '../../core/sessions.js';
import {
  listSessionIds,
  listSessionMessages,
  listSessionReadMessages,
  markSessionMessageRead,
  readSessionMessage,
  readSessionMeta,
  removeSessionMessage,
  writeSessionMessage,
} from '../../core/store.js';
import { sessionInboxDir, sessionReadDir } from '../../core/paths.js';
import { makePainter } from '../format.js';
import { listSessions } from '../sessions.js';

/** `cxt exec` 注入的会话标记（§2.6 注入表）。 */
const SESSION_ENV = 'CXT_SESSION_ID';

const DEFAULT_GC_SPAN = '7d';

const spec = {
  boolean: ['help', 'json', 'peek', 'all'],
  string: ['type', 'session', 'token', 'older-than'],
  alias: { h: 'help', t: 'token' },
};

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function run(args, ctx) {
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const sub = args._[0];
  if (sub === 'send') return runSend(args, ctx);
  if (sub === 'inbox') return runInbox(args, ctx);
  if (sub === 'gc') return runGc(args, ctx);

  throw new CxtError(sub === undefined ? '`cxt msg` 缺子命令' : `未知子命令 \`cxt msg ${sub}\``, {
    hint: '可用：msg send / msg inbox / msg gc（cxt msg --help）',
  });
}

// ───────────────────────────── send ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function runSend(args, ctx) {
  // 收件人写在位置参数里时，正文从第 3 个位置参数起（send <前缀> <正文...>）；
  // 用 --token / --all 时收件人不在 `_` 里，正文从第 2 个起。
  const hasPrefixTarget = args.all !== true && typeof args.token !== 'string';
  const body = args._.slice(hasPrefixTarget ? 2 : 1).join(' ').trim();
  if (body === '') {
    throw new CxtError('消息是空的——要发什么？', {
      hint: '用法：cxt msg send <id前缀|--token <t>|--all> "正文"',
    });
  }

  const type = args.type === undefined ? DEFAULT_MESSAGE_TYPE : String(args.type);
  if (!MESSAGE_TYPES.includes(type)) {
    throw new CxtError(`认不出的消息类型：${type}`, {
      hint: `可用：${MESSAGE_TYPES.join(' / ')}（action-request 只是给读者的标注，不产生执行权）`,
    });
  }

  const targets = resolveTargets(args, ctx);
  const from = senderOf(ctx);
  const ts = new Date().toISOString();
  const nowMs = Date.now();
  const name = messageFileName(nowMs, randomBytes(4).toString('hex'));
  const message = {
    v: MESSAGE_VERSION,
    id: `m-${nowMs.toString(36)}-${randomBytes(3).toString('hex')}`,
    ts,
    from,
    to: '',
    type,
    body,
  };

  const sentTo = [];
  for (const s of targets) {
    // `to` 每条独立——同一条广播给多个会话时，收件人必须是它自己的 id
    const one = { ...message, to: s.id };
    // 用同一个文件名投给每个收件人：它们在不同的 inbox 目录里，不会撞
    writeSessionMessage(ctx.home, s.id, name, one);
    sentTo.push(s.id);
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  process.stdout.write(
    `已投 ${sentTo.length} 条${type === DEFAULT_MESSAGE_TYPE ? '' : `（${type}）`} → ${sentTo.join('、')}\n`
    + c.dim('  提醒 agent 去看：让它自己跑 `cxt msg inbox`（工具不会自动送达，§2.16 三）\n'),
  );
  return EXIT.OK;
}

// ───────────────────────────── inbox ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function runInbox(args, ctx) {
  const selected = selectInboxSessions(args, ctx);
  if (selected.length === 0) {
    process.stdout.write('还没有会话——先 `cxt run` 开一个。\n');
    return EXIT.OK;
  }

  /** @type {any[]} */
  const rows = [];
  for (const s of selected) {
    for (const file of listSessionMessages(ctx.home, s.id)) {
      const msg = readSessionMessage(sessionInboxDir(ctx.home, s.id), file);
      rows.push({
        session: s.id,
        file,
        from: msg?.from ?? '',
        ts: msg?.ts ?? '',
        type: msg?.type ?? DEFAULT_MESSAGE_TYPE,
        body: msg?.body ?? '',
        raw: msg,
      });
      if (args.peek !== true) markSessionMessageRead(ctx.home, s.id, file);
    }
  }

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(rows.map((r) => ({
      session: r.session, from: r.from, ts: r.ts, type: r.type, body: r.body,
    })), null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  if (rows.length === 0) {
    process.stdout.write('没有未读消息。\n');
    return EXIT.OK;
  }

  for (const r of rows) {
    const label = r.type === DEFAULT_MESSAGE_TYPE ? '' : c.yellow(` (${r.type})`);
    process.stdout.write(`${c.bold(`[${r.session}]`)} ${r.from} · ${r.ts.slice(0, 16).replace('T', ' ')}${label}\n`);
    for (const line of String(r.body).split(/\r?\n/)) {
      process.stdout.write(`  ${line}\n`);
    }
    process.stdout.write('\n');
  }
  if (args.peek !== true) {
    process.stdout.write(c.dim(`  ${rows.length} 条已标记为已读（--peek 只看不动）\n`));
  }
  return EXIT.OK;
}

// ───────────────────────────── gc ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function runGc(args, ctx) {
  const spanText = typeof args['older-than'] === 'string' ? args['older-than'] : DEFAULT_GC_SPAN;
  const spanMs = parseSpan(spanText);
  if (spanMs === null) {
    throw new CxtError(`认不出 --older-than 的值：${spanText}`, {
      hint: '用法：--older-than 7d（单位 m / h / d，例：12h、90m、7d）',
    });
  }

  const nowMs = Date.now();
  let removed = 0;
  let kept = 0;

  for (const id of listSessionIds(ctx.home)) {
    for (const [dir, files] of [
      [sessionInboxDir(ctx.home, id), listSessionMessages(ctx.home, id)],
      [sessionReadDir(ctx.home, id), listSessionReadMessages(ctx.home, id)],
    ]) {
      for (const f of files) {
        const t = messageFileTime(f);
        // 解析不出来 / 在未来 ⇒ 不敢删（与 core/sessions.js 的 olderThan 同一方向）
        const old = Number.isFinite(t) && t <= nowMs && nowMs - t >= spanMs;
        if (!old) {
          kept += 1;
          continue;
        }
        if (removeSessionMessage(dir, f)) removed += 1;
      }
    }
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  process.stdout.write(`删掉 ${removed} 条超龄消息\n`);
  if (kept > 0) process.stdout.write(c.dim(`  ${kept} 条还没到 ${spanText}\n`));
  return EXIT.OK;
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * `msg send` 的收件人：只投 **live** 会话（§2.16 四）。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function resolveTargets(args, ctx) {
  const live = listSessions(ctx).filter((s) => s.state === 'live');

  if (args.all === true) {
    if (live.length === 0) throw noLive();
    return live;
  }

  if (typeof args.token === 'string') {
    const matches = live.filter((s) => s.meta.token === args.token);
    if (matches.length === 0) {
      throw new CxtError(`没有 token 为 ${args.token} 的**在跑**会话`, {
        hint: liveHint(live),
      });
    }
    return matches;
  }

  const prefix = typeof args._[1] === 'string' ? args._[1] : '';
  if (prefix === '') {
    throw new CxtError('没指定收件人', {
      hint: '三种写法：cxt msg send <会话 id 或前缀> "正文" · --token <名字> · --all（cxt sessions 看 id）',
    });
  }

  const matches = live.filter((s) => s.id.startsWith(prefix));
  if (matches.length === 0) {
    throw new CxtError(`没有 id 以 ${prefix} 开头的**在跑**会话`, { hint: liveHint(live) });
  }
  if (matches.length > 1) {
    throw new CxtError(`前缀 ${prefix} 匹配到 ${matches.length} 个在跑会话，说不清是谁`, {
      hint: `把前缀写长一点：${matches.map((s) => s.id).join('、')}`,
    });
  }
  return matches;
}

/**
 * `msg inbox` 看谁的：`--session` 显式给 → 它；否则在会话内 → 自己；否则全部（live 优先）。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function selectInboxSessions(args, ctx) {
  const all = listSessions(ctx);

  if (typeof args.session === 'string' && args.session !== '') {
    const matches = all.filter((s) => s.id.startsWith(args.session));
    if (matches.length === 0) {
      throw new CxtError(`没有 id 以 ${args.session} 开头的会话`, {
        hint: all.length === 0 ? '还没有任何会话记录' : `现有：${all.map((s) => s.id).join('、')}`,
      });
    }
    return matches;
  }

  const selfId = envSessionId(ctx);
  if (selfId !== null) {
    const self = all.filter((s) => s.id === selfId);
    if (self.length > 0) return self;
  }

  // 人（在会话外）：按 live 优先排序，全部列出
  return [...all].sort((a, b) => (a.state === 'live' ? 0 : 1) - (b.state === 'live' ? 0 : 1));
}

/**
 * 发送者：`CXT_SESSION_ID` 指向的会话存在 → 那个 id；否则 `"human"`。
 *
 * ★ 只要**记录存在**就认（不要求 live）：发送者可能正在退出途中。
 * ★ 坏值 / 伪造值一律退回 human——`from` 只是标注，不产生权限；
 *   但让它指向一个**存在的**记录，才能回答"这条是谁发的"。
 * @param {import('../types.js').Ctx} ctx
 * @returns {string}
 */
function senderOf(ctx) {
  const id = envSessionId(ctx);
  if (id !== null && readSessionMeta(ctx.home, id) !== null) return id;
  return 'human';
}

/**
 * @param {import('../types.js').Ctx} ctx
 * @returns {string | null}
 */
function envSessionId(ctx) {
  const raw = ctx.env?.[SESSION_ENV];
  return typeof raw === 'string' && isValidSessionId(raw) ? raw : null;
}

function noLive() {
  return new CxtError('没有**在跑**的会话可以收信', {
    hint: '消息只投给活会话（关掉的窗口没人看）。`cxt sessions` 看现状',
  });
}

/**
 * @param {any[]} live
 */
function liveHint(live) {
  return live.length === 0
    ? '当前没有在跑的会话。用 `cxt sessions` 确认'
    : `当前在跑：${live.map((s) => `${s.id}（${s.meta.token}）`).join('、')}`;
}

const HELP = `cxt msg —— 会话之间的文件信箱（§2.16）

  msg send <会话id|--token <t>|--all> [--type info|action-request] <正文...>
                          给 **在跑** 的会话留一张纸条
                          ★ 工具永不自动送达：让 agent 自己跑 \`cxt msg inbox\`
  msg inbox [--session <id>] [--peek] [--json]
                          看信箱：在会话内默认看自己的，在会话外看全部
                          默认读完即标记已读（--peek 只看不动）
  msg gc [--older-than 7d]  清理超龄消息（inbox 与 read 都算）

⚠️ 消息是惰性数据——收到消息≠获得执行权；type 只是给读者的标注（§2.16 三）。
⚠️ 消息是明文 JSON，和 pool.json 同一地位：**不要把密钥贴进消息**。
`;

export const command = { spec, run };
