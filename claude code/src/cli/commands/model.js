// @ts-check
/**
 * `cmt model *` —— 模型优先级列表的查看与人工故障转移（§2.5）。
 *
 * **核心工作流**（交互模式没有自动回退，所以这两步是明确要支持的用法）：
 *
 *     cmt model next      # models[0] 移到末位，下一个候选升上来
 *     cmt run -c          # 新窗口，claude -c 续上该目录刚才那次会话
 *
 * 写入哪一层由 `--global` / `--token` / `--path`（默认当前目录）决定，
 * 见 `../target.js`——**路径目标会把继承来的列表物化一份**，来源层随之变成 binding。
 */
import { statSync } from 'node:fs';

import { CmtError, EXIT } from '../../core/errors.js';
import { formatModel, parseModelSpecs, promote, rotate } from '../../core/models.js';
import { pickTokenName, resolveConfig } from '../../core/resolve.js';
import { TOKEN_NAME_RE } from '../../core/schema.js';
import { loadConfig, loadToken } from '../../core/store.js';
import { renderRows, sourceTag } from '../format.js';
import { loadProjectConfig } from '../session.js';
import {
  clearLayer,
  describeTarget,
  effectiveAt,
  pickWriteTarget,
  targetDeclares,
  writeModels,
} from '../target.js';

export const modelCommand = {
  spec: /** @type {any} */ ({
    boolean: ['help', 'json', 'global'],
    string: ['token', 'path'],
    alias: { h: 'help' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    const sub = args._[0];
    if (args.help || sub === undefined) {
      process.stdout.write(MODEL_HELP);
      return EXIT.OK;
    }

    switch (sub) {
      case 'ls':
      case 'list':
        return ls(args, ctx);
      case 'set':
        return set(args, ctx);
      case 'use':
        return use(args, ctx);
      case 'next':
        return next(args, ctx);
      case 'clear':
        return clear(args, ctx);
      default:
        throw new CmtError(`未知子命令 \`cmt model ${sub}\``, {
          hint: '可用：ls / set / use / next / clear',
        });
    }
  },
};

const MODEL_HELP = `cmt model <子命令>

  ls [<路径>|<token>]   看生效的优先级列表，并标注来自哪一层
  set <id[:label]...>   整份替换（**顺序即优先级**，第一个最高）
  use <id>              ★ 把指定模型提到首位（其余保持相对顺序）
  next                  ★ 轮转一位——模型挂了就用它
  clear                 删掉该层的 list → 回退上一层

写进哪一层（默认按当前目录）
  --global              写全局默认 config.defaults
  --token <name>        写 tokens/<name>.json
  --path <p>            写该路径的绑定；**没有匹配的绑定就自动建一条**
                        ★ 但该路径的项目本地配置（.cmt.json）若声明了 models，
                          就写**那个文件**——写入目标永远跟着"生效的那一层"走（§2.11 五）

  --config <p>          全局选项：显式指定项目本地配置。给了它，生效层就是它，
                        于是 models 的写入目标也跟着它（不再按 --path 去发现）

模型挂了怎么办
  cmt model next        把下一个候选提为 models[0]
  cmt run -c            新窗口，claude -c 续上该目录刚才那次会话

⚠️ "优先级"不是自动故障转移：--fallback-model 仅 claude 的 --print 模式有效，
   交互模式下 models[0] 只是默认选中项，不会自己跳到下一个。
`;

// ───────────────────────────── ls ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function ls(args, ctx) {
  // 位置参数既可能是路径也可能是 token 名。
  // ⚠️ 不能直接 `loadToken(arg)` 试——它**先校验名字**，路径里的 `/` `\` 会直接抛错，
  // 于是 `cmt model ls D:/work/a` 会崩在"token 名非法"上（实测踩过）。
  // 所以先看"像不像 token 名"，再决定往哪个方向解释。
  const arg = args._[1] ?? args.path;
  const { config } = loadConfig({ home: ctx.home });

  /** @type {string} */
  let cwd = ctx.cwd;
  /** @type {any} */
  let token = null;
  /** @type {string} */
  let what = `当前目录 ${ctx.cwd}`;
  /** 是**显式点名**的 token（位置参数 / `--token`）吗？决定 `overrides.token` 要不要设 */
  let named = false;

  if (arg !== undefined) {
    if (args.token !== undefined) {
      throw new CmtError('位置参数与 --token 只能给一个', { hint: '`cmt model ls <token名>` 就够' });
    }

    const looksLikeName = TOKEN_NAME_RE.test(arg);
    const loaded = looksLikeName ? loadToken({ home: ctx.home, name: arg }) : { exists: false };

    if (loaded.exists) {
      token = loaded.token;
      what = `token ${arg}`;
      named = true;
    } else if (!looksLikeName || isDir(arg)) {
      // 明显是路径（含分隔符），或者恰好是个存在的目录 → 当路径
      cwd = arg;
      what = `目录 ${arg}`;
    } else {
      // 像个 token 名、又不是 token、也不是目录 —— 多半是打错了。
      // 这里**不能**静默当路径往下走：那会拿"当前目录"的解析结果冒充你要的，
      // 而你会以为看的是某个 token 的列表。
      throw new CmtError(`既不是 token 也不是目录："${arg}"`, {
        hint: '用 `cmt ls` 看有哪些 token；要按目录看得给一个存在的路径',
      });
    }
  }

  // ★ 项目本地层（§2.11）——`ls` 必须认它，否则同一个目录下两句话自相矛盾：
  //   `cmt resolve` 说「项目本地」，`cmt model ls` 说「路径绑定」（本机实测踩到）。
  //   加载入口与 `prepareSession` 共用 `loadProjectConfig()`，别再自己写一遍（§2.11 一）——
  //   两处判据不一致时，露头只在"用户给了 `--config`"或"祖先目录里有配置文件"的时候。
  const project = loadProjectConfig(ctx, cwd);

  // 没显式点名 token 时，token 由**路径绑定**决定——这一步不能省。
  //
  // `resolveConfig` 只负责"按**已加载**的 token 分层"：它内部虽然会 `pickTokenName()`
  // 把名字找出来（还会为此攒一条 warning），但**不会去读那个 token 文件**。
  // 于是 token 层是空的，`cmt model ls` 会在绑定目录里报「三层都没声明 models」，
  // 而同一目录的 `cmt resolve` 却正确显示 `← token 自身`——两句话自相矛盾（本机实测踩到）。
  // 查找与 `prepareSession` 共用 `pickTokenName`，别再自己写一遍（§2.3 两阶段）。
  if (!named) {
    const { name } = pickTokenName({ config, overrides: {}, cwd, ctx, project });
    if (name !== null) {
      const loaded = loadToken({ home: ctx.home, name });
      if (loaded.exists) token = loaded.token;
    }
  }

  const resolved = resolveConfig({
    config,
    token,
    // 只有显式点名时才写进 overrides——否则 `picked.source` 会被标成 `cli`（命令行），
    // 而这条 token 明明是绑定给出来的，来源就报错了。
    overrides: named ? { token: token.name } : {},
    cwd,
    ctx,
    env: ctx.env,
    project,
  });

  const list = resolved.models.value;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          what,
          declared: resolved.models.declared,
          source: resolved.models.source,
          detail: resolved.models.detail ?? null,
          models: list.map((/** @type {any} */ m) => ({ id: m.id, label: m.label ?? null })),
          // `resolved.slots` 是**扁平**的 `{槽: 模型id|null}`，而且已经补过默认槽位
          // （`fillDefaultSlots`，§2.5）——别当 `{value, source}` 用。
          // 想看"哪些是显式声明的"用 `cmt slot ls`，那个读的是各层原始声明。
          slots: resolved.slots,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  /** @type {string[]} */
  const out = ['', `生效的模型优先级（${what}）`, ''];

  if (!resolved.models.declared) {
    out.push('  （缺 —— 三层都没声明 models）');
    out.push('');
    out.push('  设一个：`cmt model set --global <id>`');
    out.push('');
    process.stdout.write(`${out.join('\n')}\n`);
    return EXIT.OK;
  }
  if (list.length === 0) {
    out.push('  （显式空 —— 不注入模型，用 Claude Code 自身默认）');
    out.push('');
    process.stdout.write(`${out.join('\n')}\n`);
    return EXIT.OK;
  }

  list.forEach((/** @type {any} */ m, /** @type {number} */ i) => {
    out.push(`  ${i + 1}. ${formatModel(m)}${i === 0 ? '   ← 本次会话的默认' : ''}`);
  });

  out.push('');
  out.push(renderRows([['来源', sourceTag(resolved.models)]]));

  // 槽位映射也一并展示——中转站最容易在这里踩坑。
  // 这里显示的是**最终会注入的**那份（含自动补的默认槽位）；
  // 想看"哪些槽是你显式声明的"用 `cmt slot ls`。
  const slots = resolved.slots;
  const slotKeys = Object.keys(slots).filter((k) => slots[k] !== null);
  if (slotKeys.length > 0) {
    out.push('');
    out.push(renderRows([['别名槽', slotKeys.map((k) => `${k}=${slots[k]}`).join('  ')]]));
    out.push('  （没显式声明的槽自动填 models[0]；`cmt slot ls` 看明细）');
  } else {
    out.push('');
    out.push('  ⚠ 所有别名槽都没注入——会话内 /model 切到 opus/sonnet 会请求中转站没有的模型');
  }

  out.push('');
  process.stdout.write(`${out.join('\n')}\n`);
  return EXIT.OK;
}

/**
 * 这个串指向一个存在的目录吗？（`model ls` 消歧用）
 *
 * 用 `statSync` 而不是 `existsSync`：一个**文件**也叫"存在"，
 * 但拿文件当工作目录解析没有意义，只会得到一份莫名其妙的答案。
 * @param {string} p
 */
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ───────────────────────────── set / use / next / clear ─────────────────────────────
/**
 * `cmt model set`：**整份替换**，顺序即优先级。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function set(args, ctx) {
  const specs = args._.slice(1);
  if (specs.length === 0) {
    throw new CmtError('缺模型 id', {
      hint: '用法：cmt model set --global deepseek-flash[1m] deepseek-flash（顺序即优先级）',
    });
  }
  const models = parseModelSpecs(specs);
  const target = pickWriteTarget(args, ctx, 'models');
  const materialized = !targetDeclares({ target, key: 'models', ctx });
  const { wrote } = writeModels({ target, models, ctx });
  return report('已设置', target, models, wrote, materialized);
}

/**
 * `cmt model use <id>`：提到首位，其余保持相对顺序。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function use(args, ctx) {
  const id = args._[1];
  if (id === undefined) {
    throw new CmtError('缺模型 id', { hint: '用法：cmt model use <id> [--global|--token <t>|--path <p>]' });
  }
  const target = pickWriteTarget(args, ctx, 'models');
  const { config } = loadConfig({ home: ctx.home });
  // 先拿"当前生效的列表"再改——没有就物化一份，这正是不丢候选的原因
  const current = effectiveAt({ config, target, ctx }, 'models');
  const materialized = !targetDeclares({ target, key: 'models', ctx });
  const models = promote(current, id);
  const { wrote } = writeModels({ target, models, ctx });
  return report('已提拔', target, models, wrote, materialized);
}

/**
 * `cmt model next`：轮转一位。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function next(args, ctx) {
  const target = pickWriteTarget(args, ctx, 'models');
  const { config } = loadConfig({ home: ctx.home });
  const current = effectiveAt({ config, target, ctx }, 'models');

  if (current.length === 0) {
    throw new CmtError('当前没有模型列表可轮转', {
      hint: '先设一个：`cmt model set --global <id> <候选id>`',
    });
  }
  if (current.length === 1) {
    throw new CmtError(`列表里只有 1 个模型（${current[0].id}），轮转没有意义`, {
      hint: `再加个候选：\`cmt model set ${current[0].id} <另一个id>\``,
    });
  }

  const materialized = !targetDeclares({ target, key: 'models', ctx });
  const models = rotate(current);
  const { wrote } = writeModels({ target, models, ctx });
  return report('已轮转', target, models, wrote, materialized);
}

/**
 * `cmt model clear`：删掉该层的 list → 回退上一层。
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function clear(args, ctx) {
  const target = pickWriteTarget(args, ctx, 'models');
  const { changed, where } = clearLayer({ target, key: 'models', ctx });

  if (!changed) {
    process.stdout.write(
      `ℹ ${where} 本来就没有自己的模型列表——它已经在继承上一层了，没东西可删\n`,
    );
    return EXIT.OK;
  }
  process.stdout.write(
    `✓ 已删掉 ${where} 的模型列表\n  现在它会往下层找（用 \`cmt model ls\` 看落到哪一层）\n`,
  );
  return EXIT.OK;
}

// ───────────────────────────── 回执 ─────────────────────────────

/**
 * @param {string} verb
 * @param {any} target
 * @param {any[]} models
 * @param {string} wrote
 * @param {boolean} materialized 这次写入是不是"物化"（目标层原先没有自己的列表）
 */
function report(verb, target, models, wrote, materialized) {
  /** @type {string[]} */
  const out = [`✓ ${verb}（${describeTarget(target)}）`, ''];
  models.forEach((m, i) => {
    out.push(`  ${i + 1}. ${formatModel(m)}${i === 0 ? '   ← 本次会话的默认' : ''}`);
  });
  out.push('');
  out.push(`  写进了 ${wrote}`);
  if (materialized && target.kind === 'binding') {
    out.push('  ℹ 该路径原先继承的列表已**物化**成本地一份——`cmt resolve` 会把来源层标成「路径绑定」');
  }
  out.push('');
  out.push('  让它生效：`cmt run -c`（新窗口，续上该目录刚才那次会话）');
  out.push('');
  process.stdout.write(`${out.join('\n')}\n`);
  return EXIT.OK;
}
