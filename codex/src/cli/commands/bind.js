// @ts-check
/**
 * `cxt bind` —— 路径 → 身份的绑定（§2.3）。
 *
 * ```bash
 * cxt bind <path> [--token <t>] [--url <u>] [--model <id>]
 * cxt bind ls
 * cxt bind rm <path>
 * ```
 *
 * ─────────────────────────────────────────────────────────────
 * ## 绑定回答的是"**这个目录**用哪个 token"
 *
 * 它是"多开"从"手动指定"变成"进目录就对"的那一步：
 * `cxt run` 不带 token 名时，按**当前目录**在这里查（§2.3 最长前缀匹配）。
 *
 * ## ★ 三条纪律，每条都对应一种**静默失效**
 *
 * 1. **`--token` 必须已存在**（`requireToken`）。否则存进去的是一条悬空绑定：
 *    写的时候不报错，`cxt run` 的时候才炸——而那时用户已经在另一个目录里了。
 * 2. **写用户的字面路径**（§7.3 铁律 4）。只展开 `~` 与补全相对路径，
 *    **不做** `resolve()` / `realpath`——那会让"写进去的"与
 *    "`process.cwd()` 给的"不再是同一个字符串，而匹配是**字符串比较**。
 * 3. **8.3 短名要出 warning**（§7.3）。`C:\Users\ALICE~1` 与
 *    `C:\Users\alice` 是同一个目录的两个合法拼写，字符串层面却是两个值。
 *    归一化会违反第 2 条，所以只能**警告**。
 *
 * ## 为什么 upsert 而不是"有则报错"
 *
 * `bind` 是**幂等**的：同一条路径反复 bind，第二次是改写那一条，
 * 不是追加第二条。追加会让"哪条生效"取决于书写顺序——而 `normalizeConfig`
 * 会直接对重复 path 报错，用户看到的是"配置坏了"，不是"我敲错命令了"。
 * ─────────────────────────────────────────────────────────────
 */

import { existsSync } from 'node:fs';

import { findExactBinding, looksLikeShortName, normalizeForCompare } from '../../core/bindings.js';
import { CxtError, EXIT } from '../../core/errors.js';
import { configPath, tokenPath } from '../../core/paths.js';
import { normalizeBinding } from '../../core/schema.js';
import { readConfig } from '../../core/store.js';
import { resolveUserPath } from '../arg-path.js';
import { makePainter, table } from '../format.js';
import { ensureRoot, mutateConfig, requireToken } from '../state-edit.js';

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'json', 'all'],
  // `--url` 与 `--base-url` 是**同一个字段**的两种拼写（§5 里 bind 写 `--url`、
  // token 写 `--base-url`）。两个都收，免得用户记岔了还以为命令坏了。
  string: ['token', 'url', 'base-url', 'model', 'provider-id', 'wire-api'],
  alias: { h: 'help', u: 'url' },
};

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
export async function run(args, ctx) {
  const sub = args._[0];

  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  switch (sub) {
    case undefined:
      throw new CxtError('缺少路径', {
        hint: '`cxt bind <path> --token <t>` 建绑定；`cxt bind ls` 看全部',
      });
    case 'ls': case 'list': return cmdLs(args, ctx);
    case 'rm': case 'remove': return cmdRm(args, ctx);
    default: return cmdUpsert(args, ctx);
  }
}

// ───────────────────────────── 建 / 改 ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdUpsert(args, ctx) {
  const raw = args._[0];
  const { path, from } = resolveUserPath(raw, ctx);

  /** @type {Record<string, any>} */
  const patch = {};
  if (args.token !== undefined) {
    // ★ 先验证存在（§3.3）。悬空绑定写的时候不报错，`cxt run` 时才炸。
    requireToken(ctx, args.token);
    patch.token = args.token;
  }
  const url = args['base-url'] ?? args.url;
  if (url !== undefined) patch.baseUrl = url;
  if (args['provider-id'] !== undefined) patch.providerId = args['provider-id'];
  if (args['wire-api'] !== undefined) patch.wireApi = args['wire-api'];

  const models = toModelList(args.model);
  if (models !== undefined) patch.models = models;

  if (Object.keys(patch).length === 0) {
    throw new CxtError('没有给出要绑定的内容', {
      hint: `至少给一个：--token <t> / --url <u> / --model <id>\n`
        + `例：cxt bind ${quoteForShell(raw)} --token relay-a`,
    });
  }

  ensureRoot(ctx);   // §3.2：bind 触发时建根目录 + config.json（若无）

  /** @type {{ action: string, index: number, binding: any }} */
  const result = { action: 'created', index: -1, binding: {} };

  const config = mutateConfig(ctx, (cfg) => {
    const list = [...cfg.bindings];
    const at = findExactBinding(list, path, ctx.platform);

    // 合并而非替换：`cxt bind <p> --url u` 不该把已有的 --token 抹掉。
    // 想清空某个字段就 `cxt bind rm <p>` 再建（与 `cxt token edit` 同一条纪律：
    // cxt 不提供"删掉单个字段"——半路的配置最容易变成四要素不齐的状态）。
    const merged = at >= 0 ? { ...list[at], ...patch } : { path, ...patch };
    const normalized = normalizeBinding(merged, at >= 0 ? at : list.length);

    if (at >= 0) {
      const before = list[at];
      result.action = sameJson(before, normalized) ? 'unchanged' : 'updated';
      result.index = at;
      list[at] = normalized;
    } else {
      result.index = list.length;
      list.push(normalized);
    }
    result.binding = normalized;
    return { ...cfg, bindings: list };
  });

  return report(args, ctx, {
    action: result.action,
    path,
    rewrittenFrom: from,
    binding: result.binding,
    lines: [
      `${ACTION_TEXT[result.action] ?? result.action} ${path}`,
      ...(from === null ? [] : [`  路径      ${raw} → ${path}（相对路径按当前目录补全，写盘的是补全后的）`]),
      `  绑定项    ${describeBinding(result.binding)}`,
      ...fileNotes(ctx, config, result.binding),
    ],
  });
}

/** @type {Record<string, string>} */
const ACTION_TEXT = { created: '已绑定', updated: '已更新绑定', unchanged: '绑定未变（本来就一样）' };

/**
 * 写完之后的两类提示：8.3 短名（§7.3）与"被更具体的绑定盖住"。
 * @param {import('../types.js').Ctx} ctx
 * @param {any} config 写下去的那份配置
 * @param {any} binding 刚写的这条
 * @returns {string[]}
 */
function fileNotes(ctx, config, binding) {
  /** @type {string[]} */
  const out = [];

  if (looksLikeShortName(binding.path, ctx.platform)) {
    out.push('');
    out.push('  ⚠ 这条路径看着像 **8.3 短名**（形如 `PREFIX~1`）。');
    out.push('    Windows 上同一个目录有两个都合法的拼写，而匹配是**字符串比较**：');
    out.push('    用短名 `cd` 进去、用长名 `cd` 进去，会是两个不同的值。');
    out.push('    cxt **刻意不归一化**（§7.3 铁律 4：写你的字面路径），所以请确认');
    out.push('    你平时是用哪种拼写进这个目录的。');
  }

  // 更长的绑定会盖住这条的一部分——这是最长前缀匹配的正常行为，但值得说一句
  const self = normalizeForCompare(binding.path, ctx.platform);
  const shadowing = (config.bindings ?? []).filter((/** @type {any} */ b) => {
    if (b.path === binding.path) return false;
    const n = normalizeForCompare(b.path, ctx.platform);
    return n.length > self.length && n.startsWith(`${self}/`);
  });
  if (shadowing.length > 0) {
    out.push('');
    out.push(`  ℹ 有 ${shadowing.length} 条更具体的绑定在它之下，那些子目录仍走它们自己的 token：`);
    for (const b of shadowing) out.push(`      ${b.path}  →  ${b.token ?? '(未指定 token)'}`);
  }

  return out;
}

// ───────────────────────────── ls ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdLs(args, ctx) {
  const config = readConfig(ctx.home);
  const list = config.bindings ?? [];

  // ★ 归一后撞车 = 两条绑定指向同一个目录，谁生效取决于书写顺序（§2.3 的
  //   最长前缀匹配在"并列取先出现的"这条上就变得不可预测了）。
  //   `normalizeConfig` 只按**原始串**查重，所以 `D:/x` 与 `D:\x` 能同时存进来。
  const byNorm = new Map();
  /** @type {string[][]} */
  const collisions = [];
  for (const b of list) {
    const n = normalizeForCompare(b.path, ctx.platform);
    if (byNorm.has(n)) collisions.push([/** @type {string} */ (byNorm.get(n)), b.path]);
    else byNorm.set(n, b.path);
  }

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      bindings: list.map((/** @type {any} */ b) => ({
        path: b.path,
        token: b.token ?? null,
        baseUrl: b.baseUrl ?? null,
        providerId: b.providerId ?? null,
        wireApi: b.wireApi ?? null,
        models: b.models ?? null,
        env: b.env ?? null,
      })),
      collisions: collisions.map(([a, b]) => ({ a, b })),
      file: configPath(ctx.home),
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  if (list.length === 0) {
    process.stdout.write(`\n  ${c.dim('还没有任何路径绑定。')}\n`
      + `  ${c.dim('加一条：cxt bind D:/work/client-a --token relay-a')}\n\n`);
    return EXIT.OK;
  }

  const rows = list.map((/** @type {any} */ b) => {
    const t = b.token ?? '';
    // 悬空引用（token 被删了）要显眼——它只会在 `cxt run` 时才炸
    const dangling = t !== '' && !tokenFileExists(ctx, t);
    return [
      // ⚠️ 平台必须来自 ctx，不能写死 'win32'：`looksLikeShortName` 对非 win32
      //    **恒返回 false**（8.3 短名是 Windows 独有的概念）。写死的话，
      //    macOS / Linux 上一个名叫 `build~1` 的**正常目录**会被标成"8.3 短名"——
      //    一个不存在的风险提示，比不提示更糟（它会让人去改一条本来正确的绑定）。
      looksLikeShortName(b.path, ctx.platform) ? `${b.path} ${c.yellow('⚠8.3')}` : b.path,
      t === '' ? c.dim('(未指定)') : (dangling ? c.red(`${t} ✗不存在`) : t),
      describeBinding(b),
    ];
  });

  const out = ['', table(['路径', 'token', '覆盖项'], rows), ''];
  if (collisions.length > 0) {
    out.push(`  ${c.yellow('⚠ 有绑定在归一后指向同一个目录（谁生效取决于书写顺序）：')}`);
    for (const [a, b] of collisions) out.push(`      ${a}  ≡  ${b}`);
    out.push('');
  }
  out.push(`  ${c.dim(`${list.length} 条绑定 · ${configPath(ctx.home)}`)}`);
  out.push(`  ${c.dim('匹配规则：最长前缀优先；并列取先出现的那条（§2.3）')}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ───────────────────────────── rm ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdRm(args, ctx) {
  const raw = args._[1];
  if (raw === undefined) {
    throw new CxtError('缺少要删的路径', { hint: '用法：`cxt bind rm <path>`（路径要和绑定里写的一致）' });
  }
  const { path } = resolveUserPath(raw, ctx);

  /** @type {any} */
  let removed = null;
  mutateConfig(ctx, (cfg) => {
    const list = [...cfg.bindings];
    const at = findExactBinding(list, path, ctx.platform);
    if (at < 0) {
      throw new CxtError(`没有绑定指向 ${path}`, {
        hint: `用 \`cxt bind ls\` 看现有绑定。`
          + '⚠️ 这里是**精确匹配**，不是前缀匹配——要删的是绑定时写下的那条路径',
      });
    }
    removed = list[at];
    list.splice(at, 1);
    return { ...cfg, bindings: list };
  });

  return report(args, ctx, {
    action: 'rm',
    path,
    binding: removed,
    lines: [
      `已删除绑定 ${path}`,
      `  原来是    ${describeBinding(removed)}`,
      '',
      '  ℹ 只删了这条**路径绑定**。token 文件、profile 目录、信任记录都没动。',
    ],
  });
}

// ───────────────────────────── 公共 ─────────────────────────────

/**
 * `--model a --model b` → `[{id:a},{id:b}]`。没给 → `undefined`（= 该层不声明，继承上层）。
 *
 * ⚠️ **空数组与不声明是两件事**（§2.4）：前者是"显式不注入模型"。
 * 所以这里没给 flag 时返回 `undefined`，绝不返回 `[]`。
 * @param {unknown} raw
 * @returns {{ id: string }[] | undefined}
 */
function toModelList(raw) {
  if (raw === undefined) return undefined;
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((id) => ({ id: String(id) }));
}

/**
 * 一条绑定覆盖了哪些项——给表格和"已绑定"那行共用。
 * @param {any} b
 */
function describeBinding(b) {
  /** @type {string[]} */
  const parts = [];
  if (b.token !== undefined) parts.push(`token=${b.token}`);
  if (b.baseUrl !== undefined) parts.push(`url=${b.baseUrl}`);
  if (b.providerId !== undefined) parts.push(`provider=${b.providerId}`);
  if (b.wireApi !== undefined) parts.push(`wireApi=${b.wireApi}`);
  if (b.models !== undefined) {
    parts.push(b.models.length === 0
      ? 'models=[]（不注入）'
      : `models=${b.models.map((/** @type {any} */ m) => m.id).join(' > ')}`);
  }
  if (b.env !== undefined) parts.push(`env=${Object.keys(b.env).length} 项`);
  return parts.length === 0 ? '(空)' : parts.join('  ');
}

/**
 * 两个对象**逐字段**相同吗（键序无关）。
 *
 * 用来区分"改写了"与"本来就是这样"——`bind` 是幂等的，
 * 第二次跑不该报"已更新"（那会让人以为改动了什么）。
 * @param {any} a
 * @param {any} b
 */
function sameJson(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

/** @param {any} o */
function sortKeys(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(sortKeys);
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
  return out;
}

/**
 * `tokens/<name>.json` 在不在。
 *
 * ⚠️ 只 `existsSync`，**不读文件**——这里问的是"悬空了吗"。
 * 读进来解析而抛错的话，`cxt bind ls` 会因为一条**无关的**坏 token 整个看不了，
 * 而那正是用户想用它排查问题的时候。
 * @param {import('../types.js').Ctx} ctx
 * @param {string} name
 */
function tokenFileExists(ctx, name) {
  // ★ 路径一律走 core/paths.js（§3.5）——本文件里不许出现 `.codex-multi-token` 字面量
  return existsSync(tokenPath(ctx.home, name));
}

/**
 * 给提示语里的路径加引号（路径含空格时不加会让人直接复制粘贴失败）。
 * @param {string} p
 */
function quoteForShell(p) {
  return /[\s'"]/.test(p) ? `"${p}"` : p;
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @param {{ action: string, path: string, rewrittenFrom: string | null, binding: any, lines: string[] }} r
 */
function report(args, ctx, r) {
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: r.action,
      path: r.path,
      binding: r.binding ?? null,
      file: configPath(ctx.home),
    }, null, 2)}\n`);
    return EXIT.OK;
  }
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  process.stdout.write(`\n  ${c.green('✓')} ${r.lines[0]}\n`
    + `${r.lines.slice(1).map((l) => (l === '' ? '' : `  ${l}`)).join('\n')}\n\n`);
  return EXIT.OK;
}

const HELP = `cxt bind —— 路径 → 身份的绑定（§2.3）

让"进哪个目录就用哪个 token"变成自动的：\`cxt run\` 不带 token 名时，
按**当前目录**在这里查（最长前缀优先，并列取先出现的那条）。

用法：
  cxt bind <path> [--token <t>] [--url <u>] [--model <id>]
      建或改一条绑定。<path> 是**目录**，写你的字面路径——
      cxt 只展开开头的 ~ 与补全相对路径，**不做** resolve/realpath
      （§7.3 铁律 4：匹配是字符串比较，归一化会让它静默失配）。
      --token 必须是**已存在**的 token（否则写出来就是一条悬空绑定）。
      同一条路径反复 bind 是**改写**那一条，不会堆出第二条。
  cxt bind ls
      列出全部绑定（含覆盖项；悬空的 token 引用会标红）。
  cxt bind rm <path>
      删掉指向该路径的那条绑定。**精确匹配**，不是前缀匹配。
      只删绑定——token 文件、profile 目录、信任记录都不动。

选项：
  --token <t>        这条路径用哪个 token（必须已存在）
  --url <u>          [model_providers.<id>] 的 base_url（别名 --base-url）
  --model <id>       这条路径的模型（可重复：--model a --model b，顺序即优先级）
  --provider-id <id> 覆盖 provider 表名
  --wire-api <v>     目前只接受 "responses"
  --json             机器可读输出
  -h, --help         本帮助

⚠️ 沙箱与审批策略**不在这里**：它们是**项目的**安全策略，属于仓库里的
   .codex/config.toml（§2.3 第四条），cxt 不替你决定。要改信任用 \`cxt trust\`。

例：
  cxt bind D:\\work\\client-a --token relay-a
  cxt bind . --token relay-b --model deepseek-chat
  cxt bind ls

⚠️ 第一个位置参数是 \`ls\` / \`rm\` 时按**子命令**解释。真要绑一个名叫 ls 的
   目录，写 \`cxt bind ./ls --token <t>\`。
`;

export const command = { spec, run };
