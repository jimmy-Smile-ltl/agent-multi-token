// @ts-check
/**
 * `cmt token *` —— token 的增删改查（§5）。
 *
 * ⚠️ **token 只有一个落盘点**：`tokens/<name>.json`（§2.7）。
 * 本命令绝不把密钥写进别处——尤其不写进 profile 目录。
 *
 * 三条刻意的不对称，别"补全"：
 * - `rm` **默认只删** `tokens/<name>.json`，profile（登录态 + 会话历史）保留；
 *   要连 profile 一起删得显式 `--purge`，且要二次确认（§3.3）。
 * - `rm` 时若该 token 仍被 `bindings` 引用 → **警告并列出引用它的路径**，
 *   不静默留悬空绑定（§3.3）。
 * - `edit` 是"换钥匙不换身份"（§2.5）：profile 目录不动，所以会话历史与 `claude -c` 全部保留。
 */
import { createInterface } from 'node:readline/promises';
import { rmSync } from 'node:fs';

import { CmtError, EXIT } from '../../core/errors.js';
import { profileDir, profileNameFor, tokenPath } from '../../core/paths.js';
import { parseEnvRef } from '../../core/resolve.js';
import { AUTH_MODES, normalizeTokenLabel, validateTokenName } from '../../core/schema.js';
import { deleteToken, loadConfig, loadToken, saveToken } from '../../core/store.js';
import { maskSecret, renderRows } from '../format.js';

export const tokenCommand = {
  spec: /** @type {any} */ ({
    boolean: ['help', 'purge', 'yes'],
    string: ['token', 'base-url', 'cwd', 'auth-mode', 'label'],
    alias: { h: 'help', y: 'yes' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    const sub = args._[0];
    if (args.help || sub === undefined) {
      process.stdout.write(TOKEN_HELP);
      return EXIT.OK;
    }

    switch (sub) {
      case 'add':
        return add(args, ctx);
      case 'rm':
      case 'remove':
        return await rm(args, ctx);
      case 'show':
        return show(args, ctx);
      case 'edit':
        return edit(args, ctx);
      default:
        throw new CmtError(`未知子命令 \`cmt token ${sub}\``, {
          hint: '可用：add / rm / show / edit',
        });
    }
  },
};

const TOKEN_HELP = `cmt token <子命令>

  add <name> --token <密钥>   新建一个 token（--base-url / --cwd / --auth-mode / --label 可选）
  rm <name> [--purge] [--yes] 删掉 token；默认**保留** profile（登录态与会话历史）
                              --purge 才连 profile 一起删，需二次确认（--yes 跳过）
  show <name>                 打码显示一个 token（有昵称时多一行「昵称」）
  edit <name> [选项]          改凭证 / 端点 / cwd——**不动 profile**，会话历史与 claude -c 保留
                              --label "" = 清除昵称（删键，不是写空串）

选项
  --token <v>          密钥本身（也接受 \${ENV_VAR} 引用）
  --base-url <u>       API 端点
  --cwd <path>         该 token 默认落在哪个目录（cmt run <name> 不带 --cwd 时用它）
  --auth-mode token|key  token → ANTHROPIC_AUTH_TOKEN（默认）；key → ANTHROPIC_API_KEY
  --label <昵称>        展示用的昵称：可中文、可空格、≤32 字；**不参与身份**

⚠️ 密钥以**明文**存在 tokens/<name>.json 里（§1.4：不加密存储）。
   介意的话就用 \${ENV_VAR} 引用，让密钥留在环境变量里。
`;

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function add(args, ctx) {
  const name = validateTokenName(args._[1]);
  const value = args.token;
  if (value === undefined) {
    throw new CmtError(`缺 --token <密钥>`, {
      hint: `用法：cmt token add ${name} --token <密钥>（或 '--token "\${MY_ENV_VAR}"'）`,
    });
  }

  const { exists } = loadToken({ home: ctx.home, name });
  if (exists) {
    throw new CmtError(`token "${name}" 已存在`, {
      hint: `改它用 \`cmt token edit ${name}\`；或换个名字`,
    });
  }

  /** @type {any} */
  const token = { name, authToken: value };
  if (args['base-url'] !== undefined) token.baseUrl = args['base-url'];
  if (args.cwd !== undefined) token.cwd = args.cwd;
  if (args['auth-mode'] !== undefined) token.authMode = checkAuthMode(args['auth-mode']);
  if (args.label !== undefined) {
    // ★ 昵称是展示用的（§2.4 末）：唯一一个**写盘前就校验**的字段——
    //   控制字符会把终端和网页表格撑坏，而空串 = 没设（不写这个键）。
    const label = normalizeTokenLabel(args.label, '--label');
    if (label !== undefined) token.label = label;
  }

  saveToken({ home: ctx.home, token });

  process.stdout.write(
    `✓ 已建 token "${name}"\n` +
      renderRows([
        ['文件', tokenPath(ctx.home, name)],
        ['密钥', displayAuth(value)],
        ['profile', profileDir(ctx.home, name)],
      ]) +
      `\n\n  下一步：把它绑到一个目录——\`cmt bind <目录> --token ${name}\`\n`,
  );
  return EXIT.OK;
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function rm(args, ctx) {
  const name = validateTokenName(args._[1]);
  const { exists } = loadToken({ home: ctx.home, name });
  if (!exists) {
    throw new CmtError(`token "${name}" 不存在`, { hint: '用 `cmt ls` 看现有 token' });
  }

  const prof = profileDir(ctx.home, profileNameFor(name));

  // ── 先问，再删（顺序要紧）─────────────────────────────────────
  // 曾经写反过：先把 token 文件删了再问 --purge，于是用户在确认框上敲 no
  // （或非 TTY 直接抛错）时，token 文件**已经没了**——而提示语还写着"确认无误就加 --yes"，
  // 让人以为什么都没发生。现在拒绝 = 整个操作取消，一处都不动。
  if (args.purge) {
    const ok = await confirm(
      `连 profile 一起删？${prof}\n  （里面有登录态与会话历史，删了不可恢复）`,
      args.yes,
      ctx,
    );
    if (!ok) {
      throw new CmtError(`已取消——什么都没删`, {
        hint: `只想删 token 文件、保留 profile：\`cmt token rm ${name}\``,
      });
    }
  }

  // §3.3：仍被引用的 token 不许静默删——先把引用它的路径列出来
  const { config } = loadConfig({ home: ctx.home });
  const refs = config.bindings.filter((/** @type {any} */ b) => b.token === name);
  const isDefault = config.defaults.token === name;

  deleteToken({ home: ctx.home, name });

  /** @type {string[]} */
  const out = [`✓ 已删 tokens/${name}.json`];

  if (refs.length > 0 || isDefault) {
    out.push('');
    out.push('  ⚠ 仍有地方引用它，现在这些引用是**悬空**的：');
    for (const b of refs) out.push(`      - 绑定 ${b.path}`);
    if (isDefault) out.push('      - config.defaults.token');
    out.push('    改掉它们：`cmt bind <路径> --token <别的>` / `cmt bind rm <路径>`');
  }

  if (args.purge) {
    rmProfile(ctx, prof);
    out.push(`✓ 已删 profile ${prof}`);
  } else {
    out.push('');
    out.push(`  ℹ profile 保留在 ${prof}（登录态与会话历史都在里面）`);
    out.push(`    要连它一起删：\`cmt token rm ${name} --purge\``);
  }

  if (ctx.platform === 'darwin') {
    // §2.9 五：macOS 凭证在钥匙串，删目录删不掉它——只提示，不静默
    out.push('');
    out.push('  ⚠ macOS：凭证在钥匙串里，删 profile 不会清掉它。');
    out.push('    手动清理：打开「钥匙串访问」，搜 Claude Code，删掉对应条目。');
  }

  process.stdout.write(`${out.join('\n')}\n`);
  return EXIT.OK;
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function show(args, ctx) {
  const name = validateTokenName(args._[1]);
  const { token, exists, path } = loadToken({ home: ctx.home, name });
  if (!exists) {
    throw new CmtError(`token "${name}" 不存在`, { hint: '用 `cmt ls` 看现有 token' });
  }

  /** @type {[string, string][]} */
  const rows = [
    ['name', token.name],
    ...(token.label === undefined ? [] : [/** @type {[string, string]} */ (['昵称', token.label])]),
    ['authToken', displayAuth(token.authToken)],
    ['authMode', token.authMode ?? 'token（内置默认）'],
    ['baseUrl', token.baseUrl ? displayUrl(token.baseUrl) : '（未声明 → 用全局默认）'],
    ['cwd', token.cwd ?? '（未声明）'],
    ['models', token.models ? token.models.map(fmt).join(' → ') : '（未声明 → 继承全局）'],
    ['slots', token.slots ? JSON.stringify(token.slots) : '（未声明 → 继承全局）'],
    ['env', token.env ? JSON.stringify(token.env) : '（未声明）'],
    ['claudeArgs', token.claudeArgs ? JSON.stringify(token.claudeArgs) : '（未声明）'],
    ['文件', path],
    ['profile', profileDir(ctx.home, name)],
  ];
  process.stdout.write(`\n${renderRows(rows)}\n\n`);
  return EXIT.OK;
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function edit(args, ctx) {
  const name = validateTokenName(args._[1]);
  const { token, exists } = loadToken({ home: ctx.home, name });
  if (!exists) {
    throw new CmtError(`token "${name}" 不存在`, {
      hint: `先建一个：\`cmt token add ${name} --token <密钥>\``,
    });
  }

  /** @type {string[]} */
  const changed = [];
  if (args.token !== undefined) {
    token.authToken = args.token;
    changed.push(`authToken → ${displayAuth(args.token)}`);
  }
  if (args['base-url'] !== undefined) {
    token.baseUrl = args['base-url'];
    changed.push(`baseUrl → ${displayUrl(args['base-url'])}`);
  }
  if (args.cwd !== undefined) {
    token.cwd = args.cwd;
    changed.push(`cwd → ${args.cwd}`);
  }
  if (args['auth-mode'] !== undefined) {
    token.authMode = checkAuthMode(args['auth-mode']);
    changed.push(`authMode → ${token.authMode}`);
  }
  if (args.label !== undefined) {
    // ★ `--label ""` = **清除昵称**（删键，不是写空串，§2.4 末）
    const label = normalizeTokenLabel(args.label, '--label');
    if (label === undefined) {
      delete token.label;
      changed.push('昵称 → （已清除）');
    } else {
      token.label = label;
      changed.push(`昵称 → ${label}`);
    }
  }

  if (changed.length === 0) {
    throw new CmtError('没给任何要改的东西', {
      hint: `用法：cmt token edit ${name} --token <新密钥> [--base-url <u>] [--cwd <p>] [--auth-mode token|key] [--label <昵称>]`,
    });
  }

  saveToken({ home: ctx.home, token });

  process.stdout.write(
    `✓ 已改 token "${name}"\n` +
      changed.map((c) => `    ${c}`).join('\n') +
      `\n\n  ℹ profile 目录没动（${profileDir(ctx.home, name)}）\n` +
      `    → 会话历史保留，\`cmt run ${name} -c\` 依然能续上原来的会话（§2.5）\n`,
  );
  return EXIT.OK;
}

// ───────────────────────────── 小工具 ─────────────────────────────

/**
 * 引用型保留 `${VAR}` 原文（引用不是秘密，值才是）；明文才打码。
 *
 * ⚠️ 用共享的 `parseEnvRef`，**别**就地写 `/^\$\{[^}]+\}$/`——那个宽松正则会把
 * `${1BAD}` / `${a b}` 也认成引用，而它们在启动时必然报错（§2.4）。
 * 显示成"引用"等于向用户保证一件 cmt 不会兑现的事。
 *
 * @param {string} v
 */
function displayAuth(v) {
  return parseEnvRef(v) ? `${v}（引用，值在环境变量里）` : maskSecret(v);
}

/**
 * 同 `displayAuth`，但 baseUrl 不是秘密——明文原样印（端点本来就写在配置里）。
 * @param {string} v
 */
function displayUrl(v) {
  return parseEnvRef(v) ? `${v}（引用，值在环境变量里）` : v;
}

/**
 * @param {string} m
 */
function checkAuthMode(m) {
  if (!AUTH_MODES.includes(/** @type {any} */ (m))) {
    throw new CmtError(`auth-mode 只能是 ${AUTH_MODES.join(' 或 ')}，给的是 "${m}"`, {
      hint: 'token → ANTHROPIC_AUTH_TOKEN（默认，交互模式不弹确认）；key → ANTHROPIC_API_KEY',
    });
  }
  return m;
}

/**
 * @param {any} m
 */
function fmt(m) {
  return m.label ? `${m.id} (${m.label})` : m.id;
}

/**
 * 二次确认。非 TTY 直接拒绝而不是傻等（脚本里跑要显式 `--yes`）。
 *
 * ★ `ctx` 是必需的，不是可选：TTY 判据一律走注入的 `ctx.stdinIsTTY`（§4.2），
 *   命令层不自己去读 `process.stdin`。
 * @param {string} question
 * @param {boolean} skip
 * @param {import('../types.js').Ctx} ctx
 */
async function confirm(question, skip, ctx) {
  if (skip) return true;
  if (!ctx.stdinIsTTY) {
    throw new CmtError('这个操作需要确认，但当前不是交互式终端', {
      hint: '确认无误就加 --yes',
    });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question}\n  确认请输入 yes：`)).trim().toLowerCase();
    return a === 'yes' || a === 'y';
  } finally {
    rl.close();
  }
}

/**
 * 删 profile 目录（§3.3：只有 `--purge` + 确认才走到这里）。
 *
 * **只删 `profiles/<token>/`**，绝不碰 `~/.claude/`（§3.3 铁律）。
 * @param {import('../types.js').Ctx} ctx
 * @param {string} prof
 */
function rmProfile(ctx, prof) {
  rmSync(prof, { recursive: true, force: true });
}
