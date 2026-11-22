// @ts-check
/**
 * `cxt model` —— 模型优先级列表的管理（§2.5）。
 *
 * ```bash
 * cxt model ls [<path>|<token>] [--path <p>]
 * cxt model set [--global|--token <t>|--path <p>] <id[:label]...>
 * cxt model use <id> [--global|--token <t>|--path <p>]
 * cxt model next [--global|--token <t>|--path <p>]
 * cxt model clear [--token <t>|--path <p>]
 * ```
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这是"人工故障转移"的手感来源
 *
 * ```bash
 * cxt model next      # models[0] 不可用 → 轮转，下一个候选上位
 * cxt run -c          # 新窗口，codex resume --last 续上刚才的会话
 * ```
 *
 * cxt **不实现**自动回退（Codex 没有等价的 `--fallback-model`，假装能做只会让人误判）。
 * 所以这两个命令是**给人按的**，手感比什么都重要：
 * `next` 轮转（反复按不会耗光候选）、`use <id>` 提拔（原首位退到第二，随时切回）。
 *
 * ## 写哪一层
 *
 * | flag | 目标 |
 * |------|------|
 * | `--global` | `config.defaults.models` |
 * | `--token <t>` | `tokens/<t>.json` 的 `models` |
 * | `--path <p>` / **无 flag** | `bindings` 里该路径的 `models`；**没有就建一条** |
 *
 * ★ **无 flag 时按当前目录**——这是默认最顺手的一层，也是"这个目录换个模型"的直觉落点。
 *
 * ★ **物化**（§2.5）：该路径原先继承 token / 全局的列表时，`use` / `next` 会先把
 * **当前生效的那份**复制过来再运算。不物化的话，`next` 得先猜"用户想改哪一层"，
 * 而"猜"在这里的代价是**改错层**——用户以为改了这个目录，实际动了全局。
 * `cxt model ls` 会把来源层标出来，变化因此是可见的。
 *
 * ## 一个刻意的缺口：`clear` 没有 `--global`
 *
 * §5 的签名是 `cxt model clear [--token <t>|--path <p>]`，**不含 `--global`**——
 * 因为 global 是级联的**顶层**，没有"上一层"可回退，`clear` 对它就失去意义了。
 * 传 `--global` 会得到一个说明这一点的报错，而不是一个悄悄生效的删除。
 * ─────────────────────────────────────────────────────────────
 */

import { findExactBinding, matchBinding } from '../../core/bindings.js';
import { CxtError, EXIT } from '../../core/errors.js';
import { configPath, dirnameFor, tokenPath } from '../../core/paths.js';
import { rotateNext, promoteModel, modelLabel } from '../../core/models.js';
import { normalizeBinding, normalizeToken } from '../../core/schema.js';
import { normalizeProjectConfig } from '../../core/project-config.js';
import {
  ensureDir, findProjectConfig, readAllTokens, readConfig, readProjectConfig, writeProjectConfig,
} from '../../core/store.js';
import { resolveUserPath } from '../arg-path.js';
import { makePainter, table } from '../format.js';
import { mutateConfig, mutateToken, requireToken } from '../state-edit.js';

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'json', 'global'],
  string: ['token', 'path', 'id'],
  alias: { h: 'help', p: 'path', g: 'global' },
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
    case 'set': return cmdSet(args, ctx);
    case 'use': return cmdUse(args, ctx);
    case 'next': return cmdNext(args, ctx);
    case 'clear': return cmdClear(args, ctx);
    default:
      throw new CxtError(`未知子命令 \`cxt model ${sub}\``, {
        hint: '可用：ls / set / use / next / clear',
      });
  }
}

// ───────────────────────────── ls ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdLs(args, ctx) {
  const config = readConfig(ctx.home);
  const tokens = readAllTokens(ctx.home);
  const raw = args._[1];

  // ★ 位置参数与 `--path` 是**同一件事的两种写法**（`ls [<path>|<token>]`）：
  //   位置参数给人敲，`--path` 给脚本。同时给就没法判断问的是哪个了——
  //   而"猜"在这里的表现是**静默列出另一个目录**，正是最该避免的一类失效。
  if (args.path !== undefined && raw !== undefined) {
    throw new CxtError('`cxt model ls` 的位置参数与 `--path` 只能给一个', {
      hint: '位置参数既能当路径也能当 token 名（`cxt model ls relay-a`），'
        + '再给一个 --path 就分不清你想问哪个了',
    });
  }

  /** @type {{ models: any[] | undefined, source: string, what: string, file: string | null }} */
  let view;

  if (raw !== undefined && tokens[raw] !== undefined) {
    // ── 问的是**某个 token**：给它的生效列表，忽略绑定 ──
    //   （在绑定目录里敲 `cxt model ls relay-a`，用户问的是那个 token，不是这个目录）
    const t = tokens[raw];
    const list = t.models ?? config.defaults?.models;
    view = {
      models: list,
      source: t.models !== undefined ? 'token' : (config.defaults?.models !== undefined ? 'defaults' : 'none'),
      what: `token ${raw}`,
      file: tokenPath(ctx.home, raw),
    };
  } else {
    // ── 问的是**某条路径**（缺省当前目录）：完整走一遍
    //    项目本地 → 绑定 → token → defaults（§2.13 三，与 `use` 同一条链）──
    const pathArg = args.path !== undefined ? args.path : raw;
    const path = pathArg === undefined ? ctx.cwd : resolveUserPath(pathArg, ctx).path;
    const r = effectiveForDir(ctx, config, tokens, path);
    view = { models: r.models, source: r.source, what: path, file: r.file };
  }

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      what: view.what,
      source: view.source,
      models: view.models ?? null,
      current: view.models != null && view.models.length > 0 ? view.models[0] : null,
      file: view.file ?? configPath(ctx.home),
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  const out = ['', `  ${c.bold(`模型优先级 · ${view.what}`)}`, ''];

  if (view.models === undefined) {
    out.push(`  ${c.dim('没有任何一层声明模型——Codex 会用它自己的默认。')}`);
    out.push(`  ${c.dim('设一个：cxt model set --path "' + view.what + '" <id>')}`);
  } else if (view.models.length === 0) {
    out.push(`  ${c.yellow('[] 显式空列表')} ${c.dim('—— 不注入模型，用 Codex 自身默认（§2.5 规则 3）')}`);
    out.push(`  ${c.dim('来源层：')}${view.source}`);
  } else {
    out.push(table(['#', '模型', 'label'], view.models.map((/** @type {any} */ m, i) => [
      i === 0 ? c.cyan('▶') : String(i + 1),
      m.id,
      m.label ?? '',
    ])));
    out.push('');
    out.push(`  ${c.dim('来源层：')}${view.source}`
      + `${view.models.length === 1 ? c.dim('   （只有一项，`cxt model next` 会报错——没有下一个）') : ''}`);
  }
  out.push('');

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

// ───────────────────────────── set ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdSet(args, ctx) {
  const target = pickLayer(args, ctx);
  const models = parseModelArgs(args);

  writeLayer(ctx, target, models);

  return report(args, ctx, {
    action: 'set',
    target,
    models,
    lines: [
      `已设置 ${describeTarget(target)} 的模型列表`,
      ...modelLines(models),
      `  （顺序即优先级，第一个最高。切换用 \`cxt model next\` / \`cxt model use <id>\`）`,
    ],
  });
}

// ───────────────────────────── use / next ─────────────────────────────

/**
 * `cxt model use <id>` —— 提拔到首位（§2.5）。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdUse(args, ctx) {
  const target = pickLayer(args, ctx);
  const id = args._[1];
  if (id === undefined) {
    throw new CxtError('缺少模型 id', { hint: '用法：`cxt model use <id>`，例：cxt model use deepseek-reasoner' });
  }

  const before = effectiveModels(ctx, target);
  // ★ 物化的判据是"**这一层自己**有没有列表"，不是"读到的列表是不是空"。
  //   拿 `before === undefined` 当判据会漏掉最常见的一种：该层没声明，
  //   但上层（token / defaults）有——那正是"复制一份上来"的典型场景。
  const materialized = !hasOwnModels(ctx, target);
  // ★ 空列表也照做（§2.5 的表：`use` 在空列表上得到 `[{id}]`）——
  //   新候选没必要非得先 `model set` 一遍。
  const after = promoteModel(before ?? [], id);

  return writeAndReport(args, ctx, target, before, after, 'use', materialized);
}

/**
 * `cxt model next` —— 轮转一位（§2.5）。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdNext(args, ctx) {
  const target = pickLayer(args, ctx);
  const before = effectiveModels(ctx, target);
  const materialized = !hasOwnModels(ctx, target);

  // ★ 少于两项时 `rotateNext` 抛错（不是静默 no-op）：单元素列表"轮转"完
  //   还是它自己，用户敲完看不出变化，会以为工具坏了（§2.5）。
  const after = rotateNext(before ?? []);

  return writeAndReport(args, ctx, target, before, after, 'next', materialized);
}

/**
 * 写 + 报告（`use` / `next` 共用）。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @param {any} target
 * @param {any[] | undefined} before 运算前的**生效**列表（可能来自上层）
 * @param {any[]} after
 * @param {string} action
 * @param {boolean} materialized 该层原先没有自己的列表（= 这次复制了一份上来）
 */
function writeAndReport(args, ctx, target, before, after, action, materialized) {
  writeLayer(ctx, target, after);

  /** @type {string[]} */
  const lines = [`已${action === 'use' ? '提拔' : '轮转'} ${describeTarget(target)} 的模型列表`];
  if (before !== undefined && before.length > 0) {
    lines.push(`  ${modelLabel(before[0])}  ${'→'}  ${modelLabel(after[0])}`);
  }
  lines.push(...modelLines(after));
  if (materialized) {
    // ★ 物化要**说出来**：不然用户以为只是轮转了一下，实际多了一份路径专属列表，
    //   从此这个目录不再跟着 token / 全局变了（§2.5：变化显式可见）
    lines.push('');
    lines.push('  ℹ 该层原先没有自己的列表，已**物化**一份（复制当时生效的列表再运算）。');
    lines.push('    从此它不再随上层变化；想回退上层用 `cxt model clear ' + clearFlagFor(target) + '`。');
  }
  lines.push(`  （切换后想续上刚才的会话：\`cxt run -c\`——新窗口 + codex resume --last）`);

  return report(args, ctx, { action, target, models: after, lines });
}

// ───────────────────────────── clear ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdClear(args, ctx) {
  if (args.global === true) {
    throw new CxtError('`cxt model clear` 不支持 --global', {
      hint: 'global 是级联的**顶层**，没有上一层可回退（§5 的签名里就没有它）。\n'
        + '想改全局默认：`cxt model set --global <id>`；想彻底不注入全局模型，'
        + `手工把 ${configPath(ctx.home)} 里 defaults.models 删掉`,
    });
  }

  const target = pickLayer(args, ctx);

  // ★ 该层本来就没有自己的列表 → **什么都不写**。
  //   不拦的话，`writeLayer` 会为了"删掉 models"而**新建**一条空绑定
  //   ——用户敲了一句 clear，配置里却多出一条 `{path}` 垃圾。
  if (!hasOwnModels(ctx, target)) {
    return report(args, ctx, {
      action: 'clear',
      target,
      models: null,
      lines: [
        `${describeTarget(target)} 本来就没有自己的模型列表，无需清理`,
        `  ${'（它一直是从上层继承的）'}`,
      ],
    });
  }

  const before = effectiveModels(ctx, target);
  writeLayer(ctx, target, undefined);

  /** @type {string[]} */
  const lines = [`已删除 ${describeTarget(target)} 自己的模型列表（回退到上一层）`];
  if (before !== undefined && before.length > 0) {
    lines.push(`  原来它生效的是  ${before.map(modelLabel).join(' > ')}`);
  }
  return report(args, ctx, { action: 'clear', target, models: null, lines });
}

// ───────────────────────────── 层选择 ─────────────────────────────

/**
 * 这一刀要切在哪一层。
 *
 * ⚠️ **`project` 是 2026-10-18 新加的一层**（§2.13 五）：`--path <p>`（或无 flag，
 * 即当前目录）若在该路径上发现了 `.cxt.json`，**且它声明了 `models`**，
 * 那目标层就是**那个文件**——因为只有它生效。
 * 它没声明 `models` 的话，写入落到 binding 上仍然是生效的（项目层不说话 = 不参与），
 * 所以那种情况照旧走 binding。
 *
 * @typedef {{ kind: 'global' }
 *   | { kind: 'token', name: string }
 *   | { kind: 'binding', path: string }
 *   | { kind: 'project', configPath: string, dir: string }} LayerTarget
 */

/**
 * 这个目录**生效**的那份项目本地配置是哪个？没有就是 `null`。
 *
 * 两条路，与 `cli/session.js` 的 `loadProjectConfig()` **逐条对齐**（§2.13 一）：
 *
 * | 来源 | 行为 |
 * |------|------|
 * | `--config <p>`（`ctx.configPath`） | 就是它，**不做发现**；文件不在就硬报错，不回退 |
 * | 没有 `--config` | 从 `dir` 往上找**最近的** `.cxt.json` |
 *
 * ★ 两处判据必须一致——不一致会让 `cxt model ls` 与 `cxt run` 各说各话，
 *   而那种分歧只在"用户给了 `--config`"或"祖先目录里有配置文件"时才露头，
 *   也就是最难在手工点测里撞见的那一类。
 *
 * ⚠️ `--config` **优先于**按 `dir` 发现：给了它就是"这一份才是我的项目配置"，
 *   于是**生效层**就是它，写入目标自然得跟着它。不这么写的话，
 *   `cxt --config D:/a/.cxt.json model next` 会跑去改 `--path`（或 cwd）那份绑定，
 *   而真正生效的是 `D:/a`——正是 §2.13 五 那条规则要消灭的那种静默失效。
 *   两者一致时（多数情况）这条分支看不出来，所以它只能靠注释和测试钉住，不能靠"显然"。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} dir `--path` / 当前目录（只在没有 `--config` 时用得上）
 * @returns {{ configPath: string, dir: string, cfg: any } | null} `cfg` = `normalizeProjectConfig()` 的产物
 */
function projectConfigAt(ctx, dir) {
  if (ctx.configPath !== null && ctx.configPath !== undefined) {
    return {
      configPath: ctx.configPath,
      dir: dirnameFor(ctx.platform)(ctx.configPath),
      cfg: readProjectConfig(ctx.configPath),
    };
  }

  const found = findProjectConfig({ cwd: dir, platform: ctx.platform });
  if (found === null) return null;
  return { configPath: found.configPath, dir: found.dir, cfg: readProjectConfig(found.configPath) };
}

/**
 * ★ 导出是给面板的 `e`（改模型）用的（§2.14）：面板手里只有
 * `app.js` 给出的 `{path, token, layer}`，要把它翻成这里的目标层。
 * **不许在 ui.js 里重写一遍这套判断**——「写到一个不生效的地方 = 命令静默失效」
 * 这条理由（§2.13 五）对命令和面板同样成立。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @returns {LayerTarget}
 */
export function pickLayer(args, ctx) {
  const given = [
    args.global === true ? '--global' : null,
    args.token !== undefined ? '--token' : null,
    args.path !== undefined ? '--path' : null,
  ].filter((x) => x !== null);

  if (given.length > 1) {
    throw new CxtError(`--global / --token / --path 只能给一个（收到 ${given.join(' 与 ')}）`, {
      hint: '它们指的是**三个不同的层**，同时给没法判断你想改哪个',
    });
  }

  if (args.global === true) return { kind: 'global' };
  if (args.token !== undefined) {
    // 悬空的 token 层没有意义：写进去也没人读得到
    requireToken(ctx, args.token);
    return { kind: 'token', name: args.token };
  }

  const raw = args.path !== undefined ? args.path : ctx.cwd;
  const path = resolveUserPath(raw, ctx).path;

  // ★ §2.13 五：**写入目标跟着生效层走**。
  //   写到一个不生效的地方 = 命令静默失效——`cxt model next` 报"已轮转"、
  //   模型却纹丝不动，正是 §6.2「宁可明确」要避免的。
  const at = projectConfigAt(ctx, path);
  if (at !== null && at.cfg.models !== undefined) {
    return { kind: 'project', configPath: at.configPath, dir: at.dir };
  }

  return { kind: 'binding', path };
}

/**
 * 某一层**当前生效**的列表（= 沿 §2.3 的级联往上找）。
 *
 * ★ 读用 `matchBinding`（**前缀**匹配），写用 `findExactBinding`（精确匹配）——
 * 这个不对称是刻意的：`next` 要复制的是"此刻在这个目录里生效的那份"，
 * 而它可能来自一条**祖先目录**的绑定。写的时候则必须落到本目录自己的那条上，
 * 否则会改掉一个共享的祖先绑定（那是"改错层"最隐蔽的一种）。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {LayerTarget} target
 * @returns {any[] | undefined} `undefined` = 没有任何一层声明
 */
function effectiveModels(ctx, target) {
  const config = readConfig(ctx.home);
  const tokens = readAllTokens(ctx.home);

  if (target.kind === 'global') return config.defaults?.models;

  if (target.kind === 'token') {
    return tokens[target.name]?.models ?? config.defaults?.models;
  }

  // project 与 binding 走**同一条**"按目录解析"的链——项目本地层只是插在
  // 绑定之上的那一层，不是另一套级联（§2.13 三）。分开写必然分叉。
  const dir = target.kind === 'project' ? target.dir : target.path;
  return effectiveForDir(ctx, config, tokens, dir).models;
}

/**
 * 某个目录里**生效**的模型列表 + 它来自哪一层
 * （`project` → `binding` → `token` → `defaults`）。
 *
 * ⚠️ 这是 `core/resolve.js` 那条级联在 `models` 一项上的**局部复刻**。
 * 之所以敢复刻：`models` 是"整体覆盖、不合并"（§2.5），链上只有四个候选，
 * 而且这里只用于"复制一份上来"和"告诉用户生效的是哪份"。
 * **别把它扩成第二个 `resolve()`**——要更多信息就去调 `resolveSession()`。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {any} config
 * @param {Record<string, any>} tokens
 * @param {string} dir
 * @returns {{ models: any[] | undefined, source: string, file: string | null }}
 */
function effectiveForDir(ctx, config, tokens, dir) {
  // ★ 发现用的是 `dir` 本身（`--path` 或 cwd），与 `resolveSession()` 里
  //   `loadProjectConfig()` 的判据一致——两处不一致会让 `ls` 和 `use` 各说各话。
  //   ⚠️ 判据落在 `projectConfigAt()` 里（含 `--config` 那条分支），**别在这儿再发现一遍**：
  //      `next` 复制的是"生效的那份"，判据与 `pickLayer()` 分叉就是"复制一份、改另一份"。
  const at = projectConfigAt(ctx, dir);
  const project = at === null ? null : at.cfg;

  if (project?.models !== undefined) {
    return { models: project.models, source: `项目本地 ${at.configPath}`, file: at.configPath };
  }

  const hit = matchBinding(config.bindings ?? [], dir, ctx.platform);
  if (hit?.binding?.models !== undefined) {
    return { models: hit.binding.models, source: `binding ${hit.binding.path}`, file: null };
  }

  // token 名：项目本地层也在链上（§2.3），且它比绑定更具体
  const tName = project?.token ?? hit?.binding?.token ?? config.defaults?.token;
  const t = tName !== undefined ? tokens[tName] : undefined;
  if (t?.models !== undefined) return { models: t.models, source: `token ${tName}`, file: null };
  if (config.defaults?.models !== undefined) {
    return { models: config.defaults.models, source: 'defaults', file: null };
  }
  return { models: undefined, source: 'none', file: null };
}

/**
 * 该层**自己**声明了 models 吗？（`clear` 用它判断"有没有东西可删"）
 *
 * ⚠️ 与 `effectiveModels` 的区别是这里**不看上层**——
 * `clear` 要删的是这一层自己的声明，删一个本来就不存在的声明是**有害**的：
 * 它会顺带把这个层"物化"出来（一条只有 path 的空绑定 / 一个空对象）。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {LayerTarget} target
 */
function hasOwnModels(ctx, target) {
  const config = readConfig(ctx.home);
  if (target.kind === 'global') return config.defaults?.models !== undefined;
  if (target.kind === 'token') return readAllTokens(ctx.home)[target.name]?.models !== undefined;
  if (target.kind === 'project') {
    return readProjectConfig(target.configPath).models !== undefined;
  }

  const at = findExactBinding(config.bindings ?? [], target.path, ctx.platform);
  return at >= 0 && config.bindings[at].models !== undefined;
}

/**
 * 把列表写进那一层。`models === undefined` = **删掉该层的声明**（`clear`）。
 *
 * ★ 导出理由同 `pickLayer()`：面板的 `e` 与 `cxt model set` 必须是**同一次写入**。
 * 面板自己拼一份 `mutateConfig` 的话，`.cxt.json` 的"保留其余键 + 过 schema +
 * 剥掉 configPath"这三步就多了一处副本，而漏掉任何一步都是**静默的数据丢失**。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {LayerTarget} target
 * @param {any[] | undefined} models
 */
export function writeLayer(ctx, target, models) {
  if (target.kind === 'global') {
    mutateConfig(ctx, (cfg) => {
      const defaults = { ...cfg.defaults };
      if (models === undefined) delete defaults.models;
      else defaults.models = models;
      return { ...cfg, defaults };
    });
    return;
  }

  if (target.kind === 'token') {
    mutateToken(ctx, target.name, (t) => {
      const next = { ...t };
      if (models === undefined) delete next.models;
      else next.models = models;
      // 整体过一遍 schema（§2.4）——别在这里手写第二套规则
      return normalizeToken(next, target.name);
    });
    return;
  }

  if (target.kind === 'project') {
    // ★ 项目本地配置（§2.13）：**保留其余键**，只动 models。
    //   `clear` 时删掉 models 而**不删文件**——文件里可能还有 token / env /
    //   sandboxMode 那些声明，删文件等于顺手清掉了用户的仓库配置。
    //   （整个文件的删除是用户自己的事，cxt 不代劳——§3.2 惰性原则。）
    const cur = readProjectConfig(target.configPath);
    /** @type {Record<string, any>} */
    const next = { ...cur };
    if (models === undefined) delete next.models;
    else next.models = models;

    // ⚠️ `cur` 是**归一产物**，带着 `configPath`；摘它那一步在 `saveProjectAt()` 里
    //    （只此一处，别在这里再 `delete` 一遍——两个调用点各删一次正是它漂移的方式）。
    saveProjectAt(ctx, target.configPath, next);
    return;
  }

  mutateConfig(ctx, (cfg) => {
    const list = [...cfg.bindings];
    const at = findExactBinding(list, target.path, ctx.platform);

    // 没有这条绑定、又只是在"删"——那没什么可删的，别凭空建一条空绑定出来。
    // （正常路径上 `cmdClear` 已经用 `hasOwnModels` 拦住了，这里是第二道保险。）
    if (at < 0 && models === undefined) return cfg;

    /** @type {Record<string, any>} */
    let next;
    if (at >= 0) {
      next = { ...list[at] };
    } else {
      // §2.5：无匹配绑定则**自动创建一条**
      next = { path: target.path };
    }
    if (models === undefined) delete next.models;
    else next.models = models;

    const normalized = normalizeBinding(next, at >= 0 ? at : list.length);
    if (at >= 0) list[at] = normalized;
    else list.push(normalized);
    return { ...cfg, bindings: list };
  });
}

/**
 * `.cxt.json` 的**唯一写入姿势**：保留其余键 → 过 schema → 剥掉 `configPath`。
 *
 * ★ 导出理由同 `pickLayer()` / `writeLayer()`：面板的向导第 4 步（§2.14 四）
 * 也要写这份文件。**别在 ui.js 里再拼一遍这三步**——漏掉任何一步都是**静默的**：
 * 少"保留其余键"会清掉用户在仓库里写的声明，少"过 schema"会让坏值落盘，
 * 少"剥 configPath"会把本机绝对路径写进用户的仓库、还让下一次读取被自己拒掉。
 *
 * ⚠️ **`configPath` 要在**两头**各摘一次，顺序还不能反**：
 *
 * 1. **归一之前**：`readProjectConfig()` 的产物带着 `configPath`（那是"这份是从哪读来的"
 *    的记账，不是文件字段），而 `normalizeProjectConfig()` 会把不在允许键表里的东西
 *    当**未知字段拒掉**——于是"自己读出来的东西自己写不回去"。
 * 2. **落盘之前**：归一的**产物**又会把 `configPath` 加回来（同一件事的记账），
 *    不摘就会把本机绝对路径写进用户的仓库，还会在下一次读取时被自己拒掉。
 *
 * ★ 这一刀必须落在**这里**，不能交给调用点：`{...readProjectConfig(...)}` 再改一个键
 *   是各个调用点的**常规**姿势。曾经它写在调用点上，而两个调用点里有一个忘了——
 *   症状是 `cxt model clear --path` 报「有未知字段 "configPath"」，
 *   而那文件是**它自己上一次读进来的**（姊妹项目 `cmt` 实测踩到，测试逮住）。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} configPath
 * @param {Record<string, any>} value 已经删掉要删的键的**完整**内容
 */
export function saveProjectAt(ctx, configPath, value) {
  const clean = { ...value };
  delete clean.configPath;
  // 整体过一遍 schema——与 token 分支同理，别在这里手写第二套规则
  const normalized = normalizeProjectConfig(clean, configPath);
  const toWrite = { ...normalized };
  delete toWrite.configPath;
  ensureDir(dirnameFor(ctx.platform)(configPath));
  writeProjectConfig(configPath, toWrite);
}

// ───────────────────────────── 参数解析 ─────────────────────────────

/**
 * `cxt model set` 的模型列表。
 *
 * 两种写法，**`--id` 是为了躲开 `:` 的歧义**：
 *
 * | 写法 | 结果 |
 * |------|------|
 * | `<id>` | `{ id }` |
 * | `<id>:<label>` | `{ id, label }`，**按第一个 `:` 切** |
 * | `--id <id>` | `{ id }`，**一个字都不切** |
 *
 * ⚠️ 为什么必须有 `--id`：OpenRouter 那类中转站的模型 id **自己就带冒号**
 * （`meta-llama/llama-3.1-70b:free`）。按 `:` 切的话，这种 id 会被切成
 * `meta-llama/llama-3.1-70b` + label `free` —— **id 悄悄少了一截**，
 * 而报错要等到 Codex 启动时才出现（"模型不存在"）。
 * 有了 `--id` 这条路，带冒号的 id 就有了**无歧义**的写法。
 *
 * @param {any} args
 * @returns {{ id: string, label?: string }[]}
 */
function parseModelArgs(args) {
  /** @type {{ id: string, label?: string }[]} */
  const out = [];

  for (const raw of toArray(args.id)) {
    const id = String(raw).trim();
    if (id === '') throw new CxtError('--id 不能为空');
    out.push({ id });
  }

  for (const raw of args._.slice(1)) {
    const s = String(raw);
    const at = s.indexOf(':');
    if (at < 0) {
      out.push({ id: s });
      continue;
    }
    const id = s.slice(0, at);
    const label = s.slice(at + 1);
    if (id === '') {
      throw new CxtError(`模型 id 不能为空：${JSON.stringify(s)}`, {
        hint: '形如 `<id>:<label>`，冒号左边是 id。只想给 id 就别写冒号',
      });
    }
    // label 为空（`id:`）= 显式"没有 label"，`modelLabel` 会退回显示 id
    out.push(label === '' ? { id } : { id, label });
  }

  if (out.length === 0) {
    throw new CxtError('没有给出模型 id', {
      hint: '用法：`cxt model set [--global|--token <t>|--path <p>] <id[:label]...>`\n'
        + '例：cxt model set deepseek-chat deepseek-reasoner\n'
        + '    cxt model set --path D:/work/a "deepseek-chat:DS 对话"',
    });
  }
  return out;
}

/**
 * @param {unknown} v
 * @returns {string[]}
 */
function toArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// ───────────────────────────── 输出 ─────────────────────────────

/**
 * @param {LayerTarget} t
 */
function describeTarget(t) {
  if (t.kind === 'global') return 'config.defaults（全局）';
  if (t.kind === 'token') return `token ${t.name}`;
  if (t.kind === 'project') return `项目本地 ${t.configPath}`;
  return `路径 ${t.path}`;
}

/**
 * `clear` 要回退上层时该敲哪个 flag。
 *
 * ⚠️ `project` 与 `binding` 都回落到 `--path`：`--path <目录>` 会**重新走一遍**
 * `pickLayer()`，那时文件里已经没有 `models` 了，于是目标自然变成 binding
 * ——正是"回退到上一层"。给它单独发明一个 flag 只会多一条要维护的路。
 *
 * @param {LayerTarget} t
 */
function clearFlagFor(t) {
  if (t.kind === 'token') return `--token ${t.name}`;
  if (t.kind === 'project') return `--path "${t.dir}"`;
  if (t.kind === 'binding') return `--path "${t.path}"`;
  return '--global';   // 到不了这里（clear 拒收 --global）
}

/**
 * @param {any[]} models
 * @returns {string[]}
 */
function modelLines(models) {
  if (models.length === 0) {
    return ['  [] 显式空列表 —— 不注入模型，用 Codex 自身默认（§2.5 规则 3）'];
  }
  return models.map((m, i) => `  ${i === 0 ? '▶' : ' '} ${i + 1}. ${modelLabel(m)}${m.label ? `  (${m.id})` : ''}`);
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @param {{ action: string, target: LayerTarget, models: any[] | null, lines: string[] }} r
 */
function report(args, ctx, r) {
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: r.action,
      target: r.target,
      models: r.models,
      current: r.models != null && r.models.length > 0 ? r.models[0] : null,
      file: r.target.kind === 'token' ? tokenPath(ctx.home, r.target.name)
        : r.target.kind === 'project' ? r.target.configPath
          : configPath(ctx.home),
    }, null, 2)}\n`);
    return EXIT.OK;
  }
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  process.stdout.write(`\n  ${c.green('✓')} ${r.lines[0]}\n`
    + `${r.lines.slice(1).map((l) => (l === '' ? '' : `  ${l}`)).join('\n')}\n\n`);
  return EXIT.OK;
}

const HELP = `cxt model —— 模型优先级列表（§2.5）

models[0] 优先级最高，它就是这次会话的默认模型。后面的不是自动回退队列
（cxt **不实现**自动回退——Codex 没有等价的 --fallback-model），
而是**人工提拔栈**：

  cxt model next      # 轮转一位：models[1] 升为首位（反复按不会耗光候选）
  cxt run -c          # 新窗口，codex resume --last 续上刚才的会话

写哪一层：
  --global             config.defaults.models
  --token <t>          tokens/<t>.json
  --path <p> / 无 flag  见下；无 flag 时按当前目录

  ★ --path 的落点**跟着生效层走**（§2.13 五）：该路径往上找到的最近一份
    .cxt.json 若声明了 models，就写进**那个文件**（否则写进去也不生效）；
    没声明（或根本没有该文件）才写 bindings 里该路径那条（**无则自动建一条**）。

子命令：
  cxt model ls [<path>|<token>] [--path <p>]
      看生效的列表 + **它来自哪一层**（项目本地 / binding / token / defaults）。
      <token> 恰好是个 token 名时按 token 解释，否则按路径解释（缺省当前目录）。
      ★ --path <p> 是"按路径解释"那一支的另一种写法（给脚本用，免得去猜
        <p> 会不会撞上某个 token 名）。两者**只能给一个**。
  cxt model set [层 flag] <id[:label]...>
      整份替换，顺序即优先级。
      ★ 模型 id 自己带冒号时（如 OpenRouter 的 ':free'）用 --id <id>——
        那个写法**不做冒号切分**，位置参数的 <id>:<label> 才切。
  cxt model use <id> [层 flag]
      ★ 提拔到首位，其余保持相对顺序（原首位退到第二，便于切回）。
        id 不在列表里 → 插到首位；已在首位 → 报成功（要的状态已经成立）。
  cxt model next [层 flag]
      ★ 轮转一位。**少于两项时报错**（不是静默 no-op——那看起来像工具坏了）。
  cxt model clear [--token <t>|--path <p>]
      删掉该层自己的列表 → 回退上一层。
      ⚠️ **没有 --global**：global 是级联的顶层，没有上一层可回退（§5）。

★ **物化**：该路径原先继承 token / 全局的列表时，use / next 会先把**当前生效的那份**
  复制过来再运算，并明确告诉你——从此这个目录不再随上层变化（§2.5：变化显式可见）。

选项：
  --json       机器可读输出
  -h, --help   本帮助
`;

export const command = { spec, run };
