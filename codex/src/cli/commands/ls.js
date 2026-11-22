// @ts-check
/**
 * `cxt ls` —— token 列表 + 各自 cwd / 模型来源（§5）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这张表回答的是"我现在到底有几个身份、它们各自什么样"
 *
 * 四列，每一列都对应一个用户**必须能一眼看到**的事实：
 *
 * | 列 | 为什么要有 |
 * |----|-----------|
 * | token | 名字——所有别的命令都用它 |
 * | 模型来源 | `own` / `global` / `—`。§2.5 的级联最容易让人困惑的是"我明明没给这个 token 设模型，它怎么用了那个" |
 * | profile | 目录在不在。**在不在**是 `cxt token rm` 与 `--purge` 的分界线（§3.3） |
 * | 绑定 | 哪些目录会走它。悬空/未被引用都值得看一眼 |
 *
 * ## ⚠️ 凭证**一个字都不打印**
 *
 * 这不是"打码"，是根本不取那个字段。`ls` 是个概览命令，没有理由碰凭证——
 * 想看打了码的凭证用 `cxt token show`（§5）。
 * ─────────────────────────────────────────────────────────────
 */

import { existsSync } from 'node:fs';

import { looksLikeShortName } from '../../core/bindings.js';
import { EXIT } from '../../core/errors.js';
import { profileDir, profileNameFor } from '../../core/paths.js';
import { readAllTokens, readConfig } from '../../core/store.js';
import { makePainter, table } from '../format.js';

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
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const config = readConfig(ctx.home);
  // ★ 用 `readAllTokens`（坏文件照样抛）而不是"跳过坏的继续"——
  //   与 `cxt resolve` 同一条纪律：宁可报错，也不要给一份**静默缺了东西**的清单。
  //   而"某个 token 文件坏了"恰恰是这时候最该知道的事。
  const tokens = readAllTokens(ctx.home);
  const names = Object.keys(tokens).sort();

  /** @type {Record<string, string[]>} */
  const boundTo = {};
  for (const b of config.bindings ?? []) {
    if (typeof b?.token !== 'string') continue;
    (boundTo[b.token] ??= []).push(b.path);
  }

  /** @param {string} name */
  const row = (name) => {
    const t = tokens[name];
    const dir = profileDir(ctx.home, name);
    return {
      name,
      models: t.models ?? null,
      modelsSource: t.models !== undefined
        ? 'own'
        : (config.defaults?.models !== undefined ? 'global' : 'none'),
      cwd: t.cwd ?? null,
      baseUrl: t.baseUrl ?? null,
      providerId: t.providerId ?? null,
      profileDir: dir,
      profileExists: existsSync(dir),
      boundPaths: boundTo[name] ?? [],
    };
  };

  const rows = names.map(row);
  const defaultRow = {
    name: profileNameFor(null),
    profileDir: profileDir(ctx.home, profileNameFor(null)),
    profileExists: existsSync(profileDir(ctx.home, profileNameFor(null))),
  };

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      tokens: rows,
      // 纯 defaults 模式的落点（§2.3：解析不出 token 时 profile 落 _default）。
      // 它**不是一个 token**——只是让脚本能知道这个目录在哪。
      defaultProfile: defaultRow,
      defaults: {
        token: config.defaults?.token ?? null,
        models: config.defaults?.models ?? null,
        baseUrl: config.defaults?.baseUrl ?? null,
      },
      bindings: (config.bindings ?? []).map((/** @type {any} */ b) => ({
        path: b.path, token: b.token ?? null,
      })),
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });

  // ★ 告警先算出来——**必须在"一个 token 都没有"那条早退之前**。
  //   恰恰是"刚把最后一个 token 删掉"的时候最容易留下一堆悬空绑定，
  //   而那时如果只打印"还没有任何 token"，用户就看不到自己的配置已经指空了。
  /** @type {string[]} */
  const warnings = [];
  if (config.defaults?.token !== undefined && tokens[config.defaults.token] === undefined) {
    warnings.push(`  ${c.yellow('⚠')} config.defaults.token = ${config.defaults.token}，但那个 token 不存在`
      + '（没被绑定的目录会解析不出身份）');
  }
  for (const [name, paths] of Object.entries(boundTo)) {
    if (tokens[name] === undefined) {
      warnings.push(`  ${c.yellow('⚠')} 有 ${paths.length} 条绑定指向不存在的 token ${name}：${paths.join('、')}`);
    }
  }

  if (names.length === 0) {
    process.stdout.write(`\n  ${c.dim('还没有任何 token。')}\n`
      + `  ${c.dim('建一个：cxt token add relay-a --token sk-xxxx --base-url https://api.deepseek.com/')}\n`
      + (warnings.length === 0 ? '' : `\n${warnings.join('\n')}\n`)
      + '\n');
    return EXIT.OK;
  }

  const tableRows = rows.map((r) => [
    r.name,
    modelsCell(r, c, config),
    profileCell(r, c),
    r.boundPaths.length === 0
      ? c.dim('—')
      : r.boundPaths.map((p) => (looksLikeShortName(p, ctx.platform) ? `${p} ${c.yellow('⚠8.3')}` : p)).join('、'),
  ]);

  const out = ['', table(['token', '模型', 'profile', '绑定路径'], tableRows), ''];
  if (warnings.length > 0) {
    out.push(...warnings, '');
  }

  out.push(`  ${c.dim(`${names.length} 个 token · ${(config.bindings ?? []).length} 条绑定`)}${
    defaultRow.profileExists ? c.dim(` · 纯 defaults 模式的 profile 在 ${defaultRow.profileDir}`) : ''}`);
  out.push(`  ${c.dim('模型列的 (own) = 这个 token 自己设的；(global) = 继承 config.defaults。')}`);
  out.push(`  ${c.dim('profile 列的 ✓ = 目录已建（首次 cxt run 时创建）。')}`);
  out.push(`  ${c.dim('看某个 token 的细节：cxt token show <name>；看某条路径解析出什么：cxt resolve')}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

/**
 * 模型那一列。
 *
 * ★ **来源要标出来**（§2.5）。`own` 与 `global` 的区分是这张表存在的主要理由：
 * 用户给 token 设过模型就显示它自己的，没设就显示"继承来的"——
 * 后者最容易让人误以为"我没设它怎么有模型"。
 *
 * ⚠️ **单元格必须单行**：`table()` 按行算宽度，一个含 `\n` 的格子会把整张表撑歪
 * （而且歪得很难看懂——第二行只有一列有内容）。
 * @param {any} r
 * @param {ReturnType<typeof makePainter>} c
 * @param {any} config
 */
function modelsCell(r, c, config) {
  if (r.models !== null) {
    if (r.models.length === 0) return `${c.dim('[] 不注入')} ${c.dim('(own)')}`;
    return `${r.models.map((/** @type {any} */ m) => m.id).join(' > ')} ${c.dim('(own)')}`;
  }
  if (config.defaults?.models !== undefined) {
    const ids = config.defaults.models.map((/** @type {any} */ m) => m.id);
    const body = ids.length === 0 ? '[] 不注入' : ids.join(' > ');
    return `${c.dim(body)} ${c.dim('(global)')}`;
  }
  return c.dim('—');
}

/**
 * profile 那一列。**在不在**是 `--purge` 的分界线（§3.3），所以要显眼。
 * @param {any} r
 * @param {ReturnType<typeof makePainter>} c
 */
function profileCell(r, c) {
  return r.profileExists ? `${c.green('✓')} ${c.dim('已建')}` : c.dim('— 未建');
}

const HELP = `cxt ls —— 列出全部 token（§5）

列：token 名 / 生效的模型（并标出来自 own 还是 global）/ profile 目录建了没 /
    哪些路径绑定指向它。

⚠️ **不打印凭证**——一个字都不取。要看（打了码的）凭证用 \`cxt token show <name>\`。
⚠️ 某个 token 文件坏了会**直接报错**，而不是跳过它继续列——
   一份静默缺了东西的清单比一条明确的错误危险得多。

选项：
  --json       机器可读输出（含 defaults 与 bindings）
  -h, --help   本帮助

相关：
  cxt token show <name>   某个 token 的细节
  cxt resolve [<path>]    某条路径解析出的四要素 + 每项来自哪一层
  cxt bind ls             全部路径绑定
  cxt doctor              自检（含悬空绑定 / 未信任项目 / 文档截断）
`;

export const command = { spec, run };
