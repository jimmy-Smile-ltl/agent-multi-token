// @ts-check
/**
 * `cxt sessions` —— 会话在场层（§2.16）。
 *
 *     cxt sessions [--json]                          全部会话的三态 + 未读数
 *     cxt sessions prune [--older-than 30d] [--force]
 *
 * ⚠️ 这是**人看的概览**，不是审计凭证：pid 复用可能把 `dead` 报成 `live`
 * （§2.16 二 / §8 第 18 条）。
 */
import { CxtError, EXIT } from '../../core/errors.js';
import { parseSpan } from '../../core/sessions.js';
import { makePainter, table } from '../format.js';
import { listSessions, pruneSessions } from '../sessions.js';

const DEFAULT_PRUNE_SPAN = '30d';

/** @type {Record<string, string>} */
const STATE_LABEL = { live: '在跑', ended: '已退出', dead: '已断' };

const spec = {
  boolean: ['help', 'json', 'force'],
  string: ['older-than'],
  alias: { h: 'help' },
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
  if (sub === 'prune') return runPrune(args, ctx);
  if (sub !== undefined) {
    throw new CxtError(`未知子命令 \`cxt sessions ${sub}\``, {
      hint: '可用：cxt sessions [--json] · cxt sessions prune [--older-than 30d] [--force]',
    });
  }
  return runList(args, ctx);
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function runList(args, ctx) {
  const rows = listSessions(ctx);

  if (args.json === true) {
    const plain = rows.map((s) => ({
      id: s.id,
      token: s.meta.token,
      cwd: s.meta.cwd,
      pid: s.meta.pid,
      state: s.state,
      startedAt: s.meta.startedAt,
      endedAt: s.meta.endedAt,
      exitCode: s.meta.exitCode,
      unread: s.unread,
    }));
    process.stdout.write(`${JSON.stringify(plain, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  if (rows.length === 0) {
    process.stdout.write('还没有会话记录——`cxt run` 开的窗口会在这里留下一条。\n');
    return EXIT.OK;
  }

  const lines = rows.map((s) => [
    STATE_LABEL[s.state] ?? s.state,
    s.id,
    s.meta.token,
    String(s.unread),
    s.meta.startedAt.slice(0, 16).replace('T', ' '),
    tailOf(s.meta.cwd),
  ]);
  process.stdout.write(`${table(['状态', '会话', 'token', '未读', '开始', '目录'], lines)}\n`);

  const live = rows.filter((s) => s.state === 'live').length;
  process.stdout.write(c.dim(`  ${rows.length} 条记录 · ${live} 个在跑\n`));
  return EXIT.OK;
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function runPrune(args, ctx) {
  const spanText = typeof args['older-than'] === 'string' ? args['older-than'] : DEFAULT_PRUNE_SPAN;
  const olderThanMs = parseSpan(spanText);
  if (olderThanMs === null) {
    throw new CxtError(`认不出 --older-than 的值：${spanText}`, {
      hint: '用法：--older-than 30d（单位 m / h / d，例：12h、90m、7d）',
    });
  }

  const r = pruneSessions(ctx, { olderThanMs, force: args.force === true });
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });

  process.stdout.write(`删掉 ${r.removed.length} 条超龄会话记录\n`);
  if (r.keptLive > 0) {
    process.stdout.write(c.dim(`  ${r.keptLive} 个在跑的没动（活的永不删）\n`));
  }
  if (r.keptYoung > 0) {
    process.stdout.write(c.dim(`  ${r.keptYoung} 条还没到 ${spanText}\n`));
  }
  if (r.keptUnread.length > 0) {
    process.stdout.write(
      c.yellow(`  ${r.keptUnread.length} 条有未读纸条，保留：${r.keptUnread.join('、')}\n`)
      + c.dim('  确认不要了再加 --force\n'),
    );
  }
  return EXIT.OK;
}

/**
 * 目录的末两段（cwd 太长，表格放不下）。
 * @param {string} cwd
 */
function tailOf(cwd) {
  if (cwd === '') return '';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.slice(-2).join('/');
}

const HELP = `cxt sessions [--json]
cxt sessions prune [--older-than 30d] [--force]

会话在场层（§2.16）：每个窗口在启动时留下一条记录，这里列出它的三态。
  live   在跑（pid 还活着）
  ended  正常退出（带退出码）
  dead   没有退出记录、进程也没了（崩溃 / 被杀 / 窗口被关）

选项
  --json                 机器可读
  prune                  删超龄的 ended/dead 记录（30d 是默认门槛）
    --older-than <span>  单位 m/h/d，例：12h、90d
    --force              即使还有未读纸条也删

⚠️ pid 复用可能把 dead 报成 live——这是给人看的概览，不是审计凭证。
`;

export const command = { spec, run };
