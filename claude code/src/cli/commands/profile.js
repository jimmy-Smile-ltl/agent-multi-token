// @ts-check
/**
 * `cmt profile path <token>` —— 打印 profile 目录（§5，排查用）。
 *
 * profile 目录就是 `CLAUDE_CONFIG_DIR` 的落点（§2.8），它同时决定了
 * **会话历史存在哪**：`<profile>/projects/<cwd-slug>/`（§7.5）。
 *
 * 所以排查"`claude -c` 为什么找不到上次的会话"时，第一步就是看这个路径对不对。
 */
import { existsSync, readdirSync } from 'node:fs';

import { CmtError, EXIT } from '../../core/errors.js';
import { DEFAULT_PROFILE_NAME, profileDir, profileNameFor, profilesDir } from '../../core/paths.js';
import { validateTokenName } from '../../core/schema.js';
import { DEFAULT_SEED_MODE } from '../../core/seed.js';
import { loadConfig, loadToken } from '../../core/store.js';
import { renderRows } from '../format.js';

export const profileCommand = {
  spec: /** @type {any} */ ({
    boolean: ['help', 'json'],
    string: [],
    alias: { h: 'help' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    const sub = args._[0];
    if (args.help || sub === undefined) {
      process.stdout.write(PROFILE_HELP);
      return EXIT.OK;
    }

    if (sub === 'path') return path(args, ctx);
    if (sub === 'ls' || sub === 'list') return list(args, ctx);

    // 只给一个名字（`cmt profile relay-a`）也当 path——这是最常用的那件事
    return path({ ...args, _: ['path', sub] }, ctx);
  },
};

const PROFILE_HELP = `cmt profile path <token>    打印该 token 的 profile 目录（= CLAUDE_CONFIG_DIR）
cmt profile ls              列出全部 profile 目录（含各自有没有初始化过）

排查 claude -c 找不到会话时，第一步就是看这个路径。
ℹ 会话历史在 <profile>/projects/<cwd 的 slug>/ 下（§7.5）。
ℹ 本命令只读不写——profile 是 Claude Code 的地盘（§3.1）。
ℹ 唯一会写 profile 的是启动前播种（§3.6），由 defaults.seed 控制，默认关闭。
`;

/**
 * "这个 profile 还没初始化"后面该跟哪句话——**取决于 `defaults.seed`**（§3.6）。
 *
 * 播种关着的时候，"会走一遍引导"是实话；开着的时候还说同一句就是吓人。
 * 读配置失败（版本更高 / JSON 坏了）**不该让这个诊断命令本身挂掉**——
 * 那正是最需要它还能跑的时候。所以退回一句不含承诺的中性话。
 *
 * @param {import('../types.js').Ctx} ctx
 */
function uninitializedText(ctx) {
  try {
    const { config } = loadConfig({ home: ctx.home });
    const mode = config.defaults?.seed ?? DEFAULT_SEED_MODE;
    if (mode === 'full') return '否（首次 run 会先播种，不会走引导，§3.6）';
    if (mode === 'onboarding') return '否（首次 run 会先跳引导，但仍会问目录信任，§3.6）';
    return '否（首次 run 会走一遍引导；要零点击就设 defaults.seed = "full"，§3.6）';
  } catch {
    return '否（首次 run 会走一遍引导，§3.6）';
  }
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function path(args, ctx) {
  const raw = args._[1];
  if (raw === undefined) {
    throw new CmtError('缺 <token>', { hint: '用法：cmt profile path <token>（用 `cmt ls` 看有哪些）' });
  }

  // 允许显式写 `_default`——它是保留名，不是 token，但用户排查时确实会想查它
  const name = raw === DEFAULT_PROFILE_NAME ? DEFAULT_PROFILE_NAME : validateTokenName(raw);
  const isDefault = name === DEFAULT_PROFILE_NAME;

  if (!isDefault) {
    const { exists } = loadToken({ home: ctx.home, name });
    if (!exists) {
      throw new CmtError(`token "${name}" 不存在`, {
        hint: '用 `cmt ls` 看现有 token；纯 defaults 模式用 `cmt profile path _default`',
      });
    }
  }

  const dir = profileDir(ctx.home, profileNameFor(isDefault ? null : name));
  const initialized = existsSync(dir);

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        { token: isDefault ? null : name, profileName: profileNameFor(isDefault ? null : name), dir, initialized },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  /** @type {[string, string][]} */
  const rows = [
    ['profile 目录', dir],
    ['已初始化', initialized ? '是（Claude Code 已经写过东西）' : uninitializedText(ctx)],
    ['会话历史', `${dir}${sep(ctx)}projects${sep(ctx)}<cwd 的 slug>${sep(ctx)}`],
  ];
  if (isDefault) {
    rows.push(['说明', '纯 defaults 模式的落点（没有 token 身份时）']);
  }

  process.stdout.write(`\n${renderRows(rows)}\n\n`);
  return EXIT.OK;
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function list(args, ctx) {
  const dir = profilesDir(ctx.home);

  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    names = []; // 目录还不存在 = 一个 profile 都没建过，不是错误
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ profilesDir: dir, profiles: names }, null, 2)}\n`,
    );
    return EXIT.OK;
  }

  if (names.length === 0) {
    process.stdout.write(`\n  （还没有任何 profile——第一次 \`cmt run\` 时才会建，§3.2）\n\n`);
    return EXIT.OK;
  }

  /** @type {[string, string][]} */
  const rows = names.map((n) => [
    n === DEFAULT_PROFILE_NAME ? `${n}（纯 defaults 模式）` : n,
    profileDir(ctx.home, n),
  ]);
  process.stdout.write(`\nprofile（共 ${names.length} 个，在 ${dir}）\n\n${renderRows(rows)}\n\n`);
  return EXIT.OK;
}

/**
 * @param {import('../types.js').Ctx} ctx
 */
function sep(ctx) {
  return ctx.platform === 'win32' ? '\\' : '/';
}
