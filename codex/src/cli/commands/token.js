// @ts-check
/**
 * `cxt token` —— 凭证身份的管理（§5）。
 *
 * ```bash
 * cxt token add <name> --token <t> [--base-url <u>] [--cwd <path>] [--provider-id <id>]
 * cxt token rm <name> [--purge] [--yes]
 * cxt token show <name>
 * cxt token edit <name> [--token <v>] [--base-url <u>] [--cwd <p>] [--provider-id <id>]
 * ```
 *
 * ─────────────────────────────────────────────────────────────
 * ## 本命令最要紧的一件事：**凭证只有一个落盘点**（§2.2）
 *
 * `tokens/<name>.json`。它不写 `config.toml`、不进环境变量、不碰 profile。
 * 之所以把这条写在文件头上，是因为 `token edit` 的**卖点**正是它：
 *
 * > 改凭证 / 端点但**不动 profile 目录** ⇒ 会话历史保留，
 * > `codex resume --last` 依然有效（§2.5）
 *
 * 换句话说，"改 key 会不会把历史弄丢"这个问题的答案必须是**不会**——
 * 所以 `edit` 里**一行都不许出现 `profileDir`**。
 *
 * ## ⚠️ 明文存储（§1.4：不加密存储 token）
 *
 * token 文件是明文 JSON。这不是疏漏，是**明确的非目标**（加密要么要主密码、
 * 要么要系统钥匙串，两者都会把"零依赖"破掉）。所以：
 * 见到明文就**当场说一句**，且只在 POSIX 上 chmod 0600 ——
 * Windows 上 `fs.chmod` 基本是空操作，**别假装设了权限**（§2.11 五）。
 * ─────────────────────────────────────────────────────────────
 */

import { CxtError, EXIT } from '../../core/errors.js';
import { profileDir, tokenPath } from '../../core/paths.js';
import { normalizeToken, parseSecretRef, validateTokenName } from '../../core/schema.js';
import { readConfig, readToken } from '../../core/store.js';
import { describeSecret, isSecretKey, makePainter, table } from '../format.js';
import { promptConfirm } from '../pick.js';
import {
  bindingsReferencing, ensureRoot, mutateToken, putToken,
  removeProfileDir, removeTokenFile, requireToken,
} from '../state-edit.js';

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'json', 'purge', 'yes'],
  // `--token` 在这个命令里是**密钥本身**（§5），不是 token 的名字——
  // 名字是位置参数。别处（run / bind / trust）的 `--token` 才是名字。
  string: ['token', 'base-url', 'url', 'cwd', 'provider-id', 'label'],
  alias: { h: 'help', u: 'url' },
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
    case 'add': return cmdAdd(args, ctx);
    case 'edit': return cmdEdit(args, ctx);
    case 'rm': case 'remove': return cmdRm(args, ctx);
    case 'show': return cmdShow(args, ctx);
    default:
      throw new CxtError(`未知子命令 \`cxt token ${sub}\``, {
        hint: '可用：add / edit / rm / show（列全部 token 用 `cxt ls`）',
      });
  }
}

// ───────────────────────────── add ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdAdd(args, ctx) {
  const name = validateTokenName(args._[1]);
  const secret = args.token;

  if (secret === undefined) {
    throw new CxtError('缺少 --token <密钥>', {
      hint: `例：cxt token add ${name} --token sk-xxxx --base-url https://api.deepseek.com/\n`
        + '（想不落盘明文就写 ${ENV_VAR} 引用：--token \'${DEEPSEEK_API_KEY}\'）',
    });
  }
  if (readToken(ctx.home, name) !== null) {
    throw new CxtError(`token "${name}" 已存在`, {
      hint: `改它用 \`cxt token edit ${name} --token <新值>\`；`
        + `要先删掉用 \`cxt token rm ${name}\``,
    });
  }

  const obj = buildLayer(args, { name, authToken: secret });
  // ★ 校验一律交给 schema（§2.4）——别在这里手写第二套规则，
  //   那套规则迟早和 `resolve` 认的那套分叉，而症状是"能存进去但解析不出来"。
  const token = normalizeToken(obj, name);

  // §3.2：`token add` 触发时建根目录 + config.json（若无）
  ensureRoot(ctx);
  putToken(ctx, name, token);

  return report(ctx, args, {
    action: 'add',
    name,
    token,
    lines: [
      `已创建 token ${name}`,
      `  文件      ${tokenPathOf(ctx, name)}`,
      `  凭证      ${describeSecret(token.authToken, ctx.env).text}`,
      `  provider  ${token.providerId ?? `cxt-${name}（派生）`}`,
      ...plaintextWarning(token, ctx),
      ...posixPermNote(ctx),
    ],
  });
}

// ───────────────────────────── edit ─────────────────────────────

/**
 * ★ 改凭证 / 端点，**不动 profile 目录**（§5）。
 *
 * 这不是"顺手优化"，是这个子命令存在的理由：profile 目录里是 Codex 的
 * `auth.json` 与会话历史，动它 = `codex resume --last` 失效。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdEdit(args, ctx) {
  const name = validateTokenName(args._[1]);
  const before = requireToken(ctx, name);

  /** @type {Record<string, any>} */
  const patch = {};
  if (args.token !== undefined) patch.authToken = args.token;
  const baseUrl = baseUrlOf(args);
  if (baseUrl !== undefined) patch.baseUrl = baseUrl;
  if (args.cwd !== undefined) patch.cwd = args.cwd;
  if (args['provider-id'] !== undefined) patch.providerId = args['provider-id'];
  // ★ `--label ""` 是**清除昵称**：合并后 schema 会把它当成"未设置"而删键（§2.4 末）。
  //   这是这个命令里**唯一**能删字段的选项——因为 label 不参与四要素，删掉不会让
  //   token 变成半截状态，而 `--cwd ""` / `--token ""` 会。
  if (args.label !== undefined) patch.label = args.label;

  if (Object.keys(patch).length === 0) {
    throw new CxtError('没有给出要改的字段', {
      hint: `至少给一个：--token <v> / --base-url <u> / --cwd <path> / --provider-id <id> / --label <昵称>\n`
        + `（除 --label 外想清空某个字段：先 \`cxt token rm ${name}\` 再 \`cxt token add\`——`
        + 'cxt 不提供"删掉单个字段"，那会让 token 在半路上变成四要素不齐的状态）',
    });
  }

  // 合并后整体过一遍 schema：patch 里写坏了就在**写盘之前**抛
  const token = mutateToken(ctx, name, (t) => normalizeToken({ ...t, ...patch }, name));

  /** @type {string[]} */
  const lines = [`已更新 token ${name}`];
  for (const k of Object.keys(patch)) {
    let shown;
    if (k === 'authToken') shown = describeSecret(token.authToken, ctx.env).text;
    else if (k === 'label') shown = token.label ?? '（已清除）';
    else shown = String(token[k]);
    lines.push(`  ${k.padEnd(10)} ${shown}`);
  }
  lines.push(...plaintextWarning(token, ctx));
  // ★ 这句要显式说出来：用户改 key 时最怕的就是"会不会把历史弄丢"
  lines.push(`  profile    ${profileDir(ctx.home, name)}（**未改动**——会话历史保留，codex resume --last 依然有效）`);
  if (before.authToken !== token.authToken) {
    lines.push('  ⚠ 凭证变了：下次启动才会生效，已经开着的 codex 窗口仍用旧 key');
  }

  return report(ctx, args, { action: 'edit', name, token, lines });
}

// ───────────────────────────── rm ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function cmdRm(args, ctx) {
  const name = validateTokenName(args._[1]);
  requireToken(ctx, name);

  const refs = bindingsReferencing(readConfig(ctx.home), name);
  const dir = profileDir(ctx.home, name);

  // ★ 先确认**再**删（§3.3）。顺序反了的话，用户在提示里按了取消，
  //   文件却已经没了——"二次确认"就退化成了一个装饰。
  if (args.purge === true && args.yes !== true) {
    const ok = await promptConfirm({
      ctx,
      what: `要连 profile 目录一起删掉吗？`,
      detail: `${dir}\n`
        + '⚠ 该目录含 **Codex 的 auth.json**（登录态）、**会话历史**，以及 cxt 的备份文件。\n'
        + '⚠ 删掉之后 `codex resume --last` 会找不到这个 token 的会话。\n'
        + '   只想撤销这个 token 的身份，不加 --purge 即可（profile 会保留）。',
    });
    if (!ok) {
      process.stderr.write('  已取消，什么都没删。\n');
      return EXIT.OK;
    }
  }

  removeTokenFile(ctx, name);
  const purged = args.purge === true ? removeProfileDir(ctx, name) : false;

  /** @type {string[]} */
  const lines = [`已删除 token ${name}`];
  if (args.purge === true) {
    lines.push(purged
      ? `  已连 profile 目录一起删除：${dir}`
      : `  profile 目录本来就不存在：${dir}`);
  } else {
    lines.push(`  profile 目录**保留**：${dir}`);
    lines.push('  （里面有登录态与会话历史；要一起删用 `cxt token rm ' + name + ' --purge`）');
  }

  if (refs.length > 0) {
    lines.push('');
    lines.push(`  ⚠ 有 ${refs.length} 条路径绑定仍指向它——这些目录现在解析不出 token：`);
    for (const p of refs) lines.push(`      ${p}`);
    lines.push(`  改指：\`cxt bind <path> --token <别的>\`；或删掉：\`cxt bind rm <path>\``);
  }

  return report(ctx, args, {
    action: 'rm', name, purged, danglingBindings: refs, lines,
  });
}

// ───────────────────────────── show ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdShow(args, ctx) {
  const name = validateTokenName(args._[1]);
  const token = requireToken(ctx, name);

  const dir = profileDir(ctx.home, name);
  const secret = describeSecret(token.authToken, ctx.env);
  const providerId = token.providerId ?? `cxt-${name}`;
  const envKey = `CXT_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`;
  const refs = bindingsReferencing(readConfig(ctx.home), name);

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      name,
      // ★ label 是展示用的昵称，不是身份；没设置就 null（§2.4 末）
      label: token.label ?? null,
      // ★ 明文永远不出现在 --json 里（§5）。env 引用**原样给**——
      //   它是变量名，藏起来只会让人查不出该设哪个变量。
      authToken: { kind: secret.kind, value: secret.text, envName: secret.envName ?? null, envSet: secret.envSet ?? null },
      baseUrl: token.baseUrl ?? null,
      providerId,
      providerIdExplicit: token.providerId !== undefined,
      envKeyName: envKey,
      cwd: token.cwd ?? null,
      models: token.models ?? null,
      catalog: token.catalog ?? null,
      wireApi: token.wireApi ?? null,
      sandboxMode: token.sandboxMode ?? null,
      approvalPolicy: token.approvalPolicy ?? null,
      env: token.env ?? null,
      codexArgs: token.codexArgs ?? null,
      profileDir: dir,
      boundPaths: refs,
      file: tokenPathOf(ctx, name),
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  /** @type {string[]} */
  const out = [''];
  out.push(`  ${c.bold(`token ${name}`)}  ${c.dim(tokenPathOf(ctx, name))}`);
  out.push('');

  /** @type {[string, string][]} */
  const rows = [
    ...(token.label === undefined ? [] : [/** @type {[string, string]} */ (['昵称', token.label])]),
    ['authToken', secret.text],
    ['baseUrl', token.baseUrl ?? c.dim('(未设——会继承 defaults 或绑定)')],
    ['providerId', `${providerId}${token.providerId === undefined ? c.dim('（派生）') : ''}`],
    ['凭证环境变量', `${envKey} ${c.dim('（cxt 启动时注入，§2.2）')}`],
    ['cwd', token.cwd ?? c.dim('(未设——cxt run 用当前目录)')],
    ['models', token.models === undefined ? c.dim('(未设——继承 defaults)') : token.models.map((/** @type {any} */ m) => m.id).join(' > ')],
  ];
  if (token.catalog !== undefined) rows.push(['catalog', token.catalog]);
  if (token.wireApi !== undefined) rows.push(['wireApi', token.wireApi]);
  if (token.sandboxMode !== undefined) rows.push(['sandboxMode', token.sandboxMode]);
  if (token.approvalPolicy !== undefined) rows.push(['approvalPolicy', token.approvalPolicy]);
  if (token.codexArgs !== undefined) rows.push(['codexArgs', token.codexArgs.join(' ')]);

  out.push(table(['字段', '值'], rows));
  out.push('');

  out.push(`  ${c.bold('env 逃生舱')}`);
  out.push(token.env === undefined
    ? `  ${c.dim('(空)')}`
    : table(['变量', '值'], Object.entries(token.env).map(([k, v]) => [
      k,
      // ★ 按**键名**打码（§5）——不硬编码 `CXT_TOKEN_*`：
      //   逃生舱里可能塞着 OPENAI_API_KEY / HF_TOKEN 之类，只认自己的前缀
      //   就会把它们原样打印出来。
      //
      // ⚠️ 判据必须是**键名**，不能图省事写 `describeSecret(v)`——那个是**按键值**
      //   决定打不打码的，于是 `PLAIN_SETTING = "not-a-secret"` 会被打成
      //   `not****cret`：一个既不安全（该藏的不一定藏住）、又没法读（不该藏的
      //   全给藏了）的结果。而 `resolve` / `exec` / `run` 三处都走 `maskEnv`
      //   （按键名）——同一个值在两个命令里显示成两样，比哪一种选错都糟。
      //   键名命中时才用 `describeSecret`：它能多认出 `${VAR}` 引用并标注
      //   「已设置 / 未设置」，而引用串是变量名，不是密钥（§2.4）。
      isSecretKey(k) ? describeSecret(v, ctx.env).text : String(v ?? ''),
    ])));
  out.push('');

  out.push(`  ${c.bold('profile')}  ${dir}`);
  out.push(`  ${c.dim(refs.length === 0
    ? '没有被任何路径绑定引用'
    : `${refs.length} 条绑定指向它：${refs.join('、')}`)}`);
  out.push('');

  out.push(`  ${c.dim('⚠ 凭证以**明文**存在这个 JSON 里（§1.4：不加密存储）。'
    + '想避免落盘就把它写成 ${ENV_VAR} 引用。')}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ───────────────────────────── 公共 ─────────────────────────────

/**
 * 从命令行拼出这一层的字段（`add` 用；`edit` 走 patch 合并）。
 * @param {any} args
 * @param {Record<string, any>} base
 */
function buildLayer(args, base) {
  /** @type {Record<string, any>} */
  const out = { ...base };
  const baseUrl = baseUrlOf(args);
  if (baseUrl !== undefined) out.baseUrl = baseUrl;
  if (args.cwd !== undefined) out.cwd = args.cwd;
  if (args['provider-id'] !== undefined) out.providerId = args['provider-id'];
  if (args.label !== undefined) out.label = args.label;
  return out;
}

/**
 * `--base-url` 与 `--url` 都收。
 *
 * §5 里 token 命令写的是 `--base-url`，而 `run` / `bind` 写的是 `--url`。
 * 两个拼写指的是**同一个字段**，所以这里做别名而不是报"未知选项"——
 * 报错能拦住手滑，但拦不住"我记得别处是这么写的"，
 * 而后者才是常态（两者不会静默做不同的事，所以没有歧义风险）。
 * @param {any} args
 */
function baseUrlOf(args) {
  return args['base-url'] ?? args.url;
}

/**
 * 明文凭证的告警行（§1.4 + §2.11 五）。
 * @param {any} token
 * @param {import('../types.js').Ctx} ctx
 * @returns {string[]}
 */
function plaintextWarning(token, ctx) {
  const ref = parseSecretRef(token.authToken);
  if (ref.kind !== 'literal') return [];
  return [
    '',
    '  ⚠ 这是**明文**，直接写进了 tokens/<name>.json（§1.4：cxt 不加密存储）。',
    `    想让它不落盘：cxt token edit ${token.name} --token '\${YOUR_ENV_VAR}'`,
    ...(ctx.platform === 'win32'
      ? ['    ⚠ Windows 上 cxt 不做任何权限收紧（fs.chmod 在这里基本是空操作，§2.11 五）——',
        '      保护它的是你的用户目录 ACL。别把 home 共享给别人。']
      : ['    POSIX 上也**不会**自动 chmod（见下）——要收紧就自己来。']),
  ];
}

/**
 * POSIX 权限说明。
 *
 * ⚠️ `writeJsonAtomic` 里**没有** chmod —— 这里如实说明，**不假装设了权限**。
 * 原子写是"临时文件 + rename"，而 rename 出来的新文件继承的是**临时文件**的
 * 权限位（受 umask 影响），不是被覆盖那个文件的。所以"写的时候顺手 chmod"
 * 必须显式做，而本版没做——如实写出来，比让 README 吹一句"已加固"强。
 * @param {import('../types.js').Ctx} ctx
 */
function posixPermNote(ctx) {
  if (ctx.platform === 'win32') return [];
  return [
    '',
    '  ℹ 权限：cxt 目前**不显式 chmod** token 文件，它由你的 umask 决定。',
    '    要收紧：chmod 600 ~/.codex-multi-token/tokens/*.json',
  ];
}

/**
 * 统一的"干完了"输出。
 * @param {import('../types.js').Ctx} ctx
 * @param {any} args
 * @param {{ action: string, name: string, lines: string[], token?: any, purged?: boolean,
 *           danglingBindings?: string[] }} r
 */
function report(ctx, args, r) {
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: r.action,
      name: r.name,
      purged: r.purged ?? false,
      danglingBindings: r.danglingBindings ?? [],
      file: tokenPathOf(ctx, r.name),
    }, null, 2)}\n`);
    return EXIT.OK;
  }
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  process.stdout.write(`\n  ${c.green('✓')} ${r.lines[0]}\n`
    + `${r.lines.slice(1).map((l) => (l === '' ? '' : `  ${l}`)).join('\n')}\n\n`);
  return EXIT.OK;
}

/**
 * `tokens/<name>.json` 的路径。
 *
 * ★ 一律走 `core/paths.js`——**本文件里不许出现 `.codex-multi-token` 字面量**
 * （§3.5：路径只能有一个来源）。
 * @param {import('../types.js').Ctx} ctx
 * @param {string} name
 */
function tokenPathOf(ctx, name) {
  return tokenPath(ctx.home, name);
}

const HELP = `cxt token <子命令> [选项]

管理凭证身份。**一个 token = 一份凭证 + 一套端点 + 一个 profile 目录**
（CODEX_HOME 落点），这就是"多开"的单位。

子命令：
  cxt token add <name> --token <密钥> [--base-url <u>] [--cwd <path>] [--provider-id <id>]
                   [--label <昵称>]
      建一个 token。<name> 只允许小写字母 / 数字 / _ / -（1–32 位，见 §2.8）。
      --token 收的是**密钥本身**（不是名字）：可以是明文，也可以是 \`\${ENV_VAR}\`
      整串引用（引用会在**启动时**从环境求值，没设就报错，绝不静默当字面量，§2.4）。
      --label 是**昵称**：只用于展示，可中文、可空格、不唯一；身份永远是 <name>。
  cxt token show <name>
      看它的全部字段。凭证打码显示；有昵称时多一行「昵称」；
      \`\${ENV_VAR}\` 引用则原样显示并标注「已设置 / 未设置」——引用串是变量名，
      藏起来反而查不出该设哪个。
  cxt token edit <name> [--token <v>] [--base-url <u>] [--cwd <p>] [--provider-id <id>]
                    [--label <昵称>]
      ★ 改凭证 / 端点，但**不动 profile 目录** ⇒ 会话历史保留，
        \`codex resume --last\` 依然有效（§2.5）。换 key 不用重开历史，就用它。
      ★ \`--label ""\` = **清除昵称**（删键，不是写空串）。
  cxt token rm <name> [--purge] [--yes]
      默认**只删** tokens/<name>.json，profile 目录保留（里面有 Codex 的
      auth.json 与全部会话历史，删了不可恢复，§3.3）。
      --purge 才连 profiles/<name>/ 一起删，且要先确认（--yes 跳过）。
      ⚠️ 任何情况下都不会碰 ~/.codex/（你原本的 CODEX_HOME）。

选项：
  --base-url <u>         端点地址（别名 --url，与 cxt bind / cxt run 一致）
  --cwd <path>           该 token 的默认落点（★ 只对 \`cxt run\` 生效，§2.3 第五条）
  --provider-id <id>     [model_providers.<id>] 的表名，缺省派生 cxt-<name>
  --label <昵称>         展示用的昵称（可中文、可空格、≤32 字；不参与身份）。
                         edit 时给空串 = 清除
  --json                 机器可读输出
  -h, --help             本帮助

⚠️ 明文存储：token 文件是明文 JSON（§1.4 明确的非目标，加密会破坏零依赖）。
   不想落盘就写 \`--token '\${DEEPSEEK_API_KEY}'\`。
`;

export const command = { spec, run };
