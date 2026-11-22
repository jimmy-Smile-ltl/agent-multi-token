// @ts-check
/**
 * `cxt profile` —— profile 目录的排查入口（§5）。
 *
 * ```bash
 * cxt profile path <token>   # 打印 profile 目录（排查用）
 * cxt profile ls             # 有哪些 profile、谁是孤儿
 * ```
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么需要它
 *
 * `profiles/<token>/` 是 **Codex 的家**（`CODEX_HOME` 指过去），
 * 里面除了 cxt 写的受管区，还有**只有 Codex 才知道的东西**：
 * `auth.json`（登录态）、`sessions/`（会话历史）、`history.jsonl`。
 *
 * 排查时最常问的三句：
 * 1. "这个 token 的家到底在哪？" → `profile path`（**只打印路径**，方便 `cd` 进去）
 * 2. "为什么 `codex resume --last` 找不到刚才的会话？" → 多半是 profile 换了
 * 3. "这个目录能删吗？" → 看它有没有 Codex 数据
 *
 * ## ★ 孤儿 profile：`token rm` 的默认结果
 *
 * `cxt token rm <t>` **只删 `tokens/<t>.json`，保留 profile 目录**（§3.3）——
 * 因为那里面有登录态和会话历史，删了不可恢复。于是"目录在、token 没了"是**常态**。
 *
 * ⚠️ 而这条路径**没有 CLI 出口**：`cxt token rm <t> --purge` 会先
 * `requireToken`，token 文件已经没了就过不去。所以 `profile ls` 对孤儿
 * 给出的是**手工删除的准确命令**，而不是指一条走不通的路。
 * ─────────────────────────────────────────────────────────────
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CxtError, EXIT } from '../../core/errors.js';
import {
  DEFAULT_PROFILE_NAME, profileConfigPath, profileDir,
} from '../../core/paths.js';
import { validateTokenName } from '../../core/schema.js';
import {
  fileSize, listProfileNames, listTokenNames, readProfileConfig,
} from '../../core/store.js';
import { parseTrustEntries } from '../../core/trust.js';
import { makePainter, table } from '../format.js';

/** Codex 自己的东西——**cxt 一律不碰**（§3.1）。这里只用来判断"这个目录能不能删" */
const CODEX_ARTIFACTS = ['auth.json', 'sessions', 'history.jsonl'];

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'json'],
  string: [],
  alias: { h: 'help' },
};

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
    case 'ls': case 'list': return cmdLs(args, ctx);
    case 'path': return cmdPath(args, ctx);
    default:
      throw new CxtError(`未知子命令 \`cxt profile ${sub}\``, {
        hint: '可用：path <token> / ls',
      });
  }
}

// ───────────────────────────── path ─────────────────────────────

/**
 * `cxt profile path <token>` —— **只打印一行路径**。
 *
 * ★ 刻意不加任何装饰：这个命令的用途就是"我要 `cd` 进去看看"或
 * "把它喂给别的命令"，多一行说明文字就毁了它。要看细节用
 * `cxt profile ls` 或 `--json`。
 *
 * ⚠️ **不 `requireToken`**：token 文件被删了、目录还在，**恰恰是最需要它的时候**
 * （见文件头的"孤儿 profile"）。但名字仍要过 `validateTokenName`——
 * §2.8：名字非法与不存在是两回事，`--token ../etc` 该报"名字非法"。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdPath(args, ctx) {
  const name = requireProfileName(args._[1]);
  const dir = profileDir(ctx.home, name);
  const cfgPath = profileConfigPath(ctx.home, name);

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      token: name === DEFAULT_PROFILE_NAME ? null : name,
      profile: name,
      dir,
      exists: existsSync(dir),
      configToml: cfgPath,
      configExists: fileSize(cfgPath) !== null,
      codexData: CODEX_ARTIFACTS.filter((f) => existsSync(join(dir, f))),
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  process.stdout.write(`${dir}\n`);
  return EXIT.OK;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function requireProfileName(raw) {
  if (raw === undefined || raw === '') {
    throw new CxtError('缺少 token 名', {
      hint: '用法：`cxt profile path <token>`；不确定有哪些：`cxt profile ls`',
    });
  }
  const name = String(raw);
  // `_default` 是"纯 defaults 模式"的 profile 名（§2.3），不是 token 名，
  // 所以它过不了 validateTokenName（下划线开头）——单独放行。
  if (name === DEFAULT_PROFILE_NAME) return name;
  return validateTokenName(name);
}

// ───────────────────────────── ls ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdLs(args, ctx) {
  const tokenNames = new Set(listTokenNames(ctx.home));
  /** @type {string[]} */
  const names = listProfileNames(ctx.home);

  const rows = names.map((name) => {
    const dir = profileDir(ctx.home, name);
    const cfgPath = profileConfigPath(ctx.home, name);
    const hasCfg = fileSize(cfgPath) !== null;

    let trust = null;
    let trustError = null;
    if (hasCfg) {
      try {
        trust = parseTrustEntries(readProfileConfig(ctx.home, name)).length;
      } catch (err) {
        trustError = err instanceof Error ? err.message : String(err);
      }
    }

    const isDefault = name === DEFAULT_PROFILE_NAME;
    const tokenExists = !isDefault && tokenNames.has(name);

    return {
      profile: name,
      token: isDefault ? null : name,
      tokenExists,
      orphan: !isDefault && !tokenExists,
      dir,
      configToml: cfgPath,
      configExists: hasCfg,
      trustCount: trust,
      trustError,
      codexData: CODEX_ARTIFACTS.filter((f) => existsSync(join(dir, f))),
    };
  });

  const orphans = rows.filter((r) => r.orphan);

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      profiles: rows,
      orphans: orphans.map((r) => r.profile),
      total: rows.length,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });

  if (rows.length === 0) {
    process.stdout.write(`\n  ${c.dim('还没有任何 profile 目录。')}\n`
      + `  ${c.dim('它在首次 `cxt run`（或 `cxt trust`）时才创建——§3.2：惰性，绝不预建空目录。')}\n\n`);
    return EXIT.OK;
  }

  const tableRows = rows.map((r) => [
    r.profile,
    r.token === null
      ? c.dim('—（纯 defaults 模式）')
      : (r.tokenExists ? `${c.green('✓')} ${r.token}` : `${c.red('✗')} ${r.token} ${c.red('已删除')}`),
    existsSync(r.dir) ? `${c.green('✓')}` : c.dim('—'),
    r.configExists ? `${c.green('✓')}` : c.dim('—'),
    r.trustError !== null
      ? c.red('读不出')
      : (r.trustCount === null ? c.dim('—') : `${r.trustCount} 条`),
    r.codexData.length === 0 ? c.dim('—') : r.codexData.join(' '),
  ]);

  /** @type {string[]} */
  const out = ['', table(['profile', 'token', '目录', 'config.toml', '信任', 'Codex 数据'], tableRows), ''];

  if (orphans.length > 0) {
    out.push(`  ${c.yellow('⚠ 有 ' + orphans.length + ' 个孤儿 profile')}${c.dim('（token 文件已删、目录还在）')}`);
    out.push(`  ${c.dim('这是 `cxt token rm` 的**默认**结果——它保留目录，因为里面有登录态与会话历史（§3.3）。')}`);
    for (const r of orphans) {
      const hasData = r.codexData.length > 0;
      out.push('');
      out.push(`    ${r.profile}   ${c.dim(r.dir)}`);
      if (hasData) {
        out.push(`      ${c.yellow('含')} ${r.codexData.join('、')}${c.dim('——删掉之后 Codex 的登录态与历史一起没了，不可恢复')}`);
      }
      out.push(`      想彻底删掉，手工删这个目录（CLI 到不了这里：\`token rm --purge\` 要求 token 文件还在）：`);
      out.push(`        ${deleteHint(r.dir, ctx.platform)}`);
      out.push(`      ${c.dim('或者先 `cxt token add ' + r.profile + ' …` 把它建回来，再 `cxt token rm ' + r.profile + ' --purge`')}`);
    }
    out.push('');
  }

  out.push(`  ${c.dim(`${rows.length} 个 profile · ${ctx.home}`)}`);
  out.push(`  ${c.dim('★ cxt **只**写 config.toml 的受管区。auth.json / sessions / history 是 Codex 的，一律不碰（§3.1）。')}`);
  out.push(`  ${c.dim('看某个 profile 的路径：cxt profile path <token>')}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

/**
 * 手工删目录的命令（按平台给对语法）。
 * @param {string} dir
 * @param {NodeJS.Platform | string} platform
 */
function deleteHint(dir, platform) {
  return platform === 'win32'
    ? `Remove-Item -Recurse -Force '${dir}'`
    : `rm -rf '${dir}'`;
}

const HELP = `cxt profile —— profile 目录的排查入口（§5）

profiles/<token>/ 就是那个 token 的 **CODEX_HOME**——Codex 的家。
里面除了 cxt 写的受管区，还有**只有 Codex 才知道的东西**：
auth.json（登录态）、sessions/（会话历史）、history.jsonl。

用法：
  cxt profile path <token>
      **只打印一行路径**——方便 \\\`cd\\\` 进去，或喂给别的命令。
      ⚠️ 不要求 token 还存在：token 删了、目录还在，恰恰是最需要它的时候。
  cxt profile ls
      有哪些 profile、各自的 config.toml 与信任记录条数、
      **谁是孤儿**（token 已删、目录还在——\\\`cxt token rm\\\` 的默认结果，§3.3）。

⚠️ 孤儿 profile **没有 CLI 出口**：\\\`token rm --purge\\\` 会先要求 token 文件存在。
   \\\`profile ls\\\` 会给出手工删除的准确命令，并把目录里的 Codex 数据列出来
   ——删之前先看清会丢什么。

⚠️ cxt **只**写 config.toml 的**受管区**。auth.json / sessions / history.jsonl
   是 Codex 的，cxt 一律不读不写不删（§3.1）。

选项：
  --json       机器可读输出
  -h, --help   本帮助

相关：
  cxt ls            有哪些 token（含 profile 建了没）
  cxt trust ls      信任表（三态）
  cxt doctor        自检
`;

export const command = { spec, run };
