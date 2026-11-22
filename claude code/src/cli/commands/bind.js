// @ts-check
/**
 * `cmt bind *` —— 路径绑定（§5）。
 *
 * 绑定回答的是「**这个目录**用哪个 token / 端点 / 模型」，不是"去哪个目录"——
 * 所以 `bindings[]` **刻意没有 `cwd`**（§2.4 的三条不对称之一）。
 *
 * 匹配是**最长前缀**（§2.3）：`D:/work/a/sub` 命中 `D:/work/a` 而不是 `D:/work`。
 */
import { canonicalPath, findExactBinding } from '../../core/bindings.js';
import { CmtError, EXIT } from '../../core/errors.js';
import { parseModelSpecs } from '../../core/models.js';
import { validateTokenName } from '../../core/schema.js';
import { loadConfig, loadToken, saveConfig } from '../../core/store.js';
import { renderRows } from '../format.js';

export const bindCommand = {
  spec: /** @type {any} */ ({
    boolean: ['help', 'json'],
    string: ['token', 'url', 'model'],
    alias: { h: 'help' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    const sub = args._[0];
    // 什么都不给 = 想看帮助（别报"缺 <路径>"——用户还没说要干什么呢）
    if (args.help || (sub === undefined && args.token === undefined && args.url === undefined && args.model === undefined)) {
      process.stdout.write(BIND_HELP);
      return EXIT.OK;
    }
    if (sub === 'ls' || sub === 'list') return list(args, ctx);
    if (sub === 'rm' || sub === 'remove') return rm(args, ctx);

    // 其余情况：第一个位置参数就是路径（`cmt bind D:/work/x --token a`）
    return set(args, ctx);
  },
};

const BIND_HELP = `cmt bind <路径> [选项]     新增 / 更新一条路径绑定
cmt bind ls                列出全部绑定
cmt bind rm <路径>         删掉一条绑定

选项
  --token <name>   该路径用哪个 token（同时决定了 CLAUDE_CONFIG_DIR / 会话历史）
  --url <u>        API 端点
  --model <id>     模型；可重复给多次，**顺序即优先级**（第一个最高）

示例
  cmt bind D:/work/client-a --token relay-a
  cmt bind D:/work/client-b --token relay-b --url https://other.example.com
  cmt bind D:/work/client-b --model deepseek-flash[1m] --model deepseek-flash

ℹ 绑定按**最长前缀**匹配：D:/work/a/sub 会命中 D:/work/a 而不是 D:/work。
ℹ 只写路径不写选项 = 建一条空绑定（先占位，之后再补）。
`;

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function set(args, ctx) {
  const rawPath = args._[0];
  if (rawPath === undefined) {
    throw new CmtError('缺 <路径>', { hint: '用法：cmt bind <路径> [--token <name>]' });
  }

  const { config } = loadConfig({ home: ctx.home });

  // 先按归一化串找已有的，免得 D:/work 与 D:/WORK 各存一条（§2.9 三）。
  // ★ 判据是**精确**匹配，不是 `matchBinding` 的前缀匹配：`D:/work/a/sub` 那条
  //   也是 `D:/work/a` 的"命中"，拿它当"就是这一条"会改写错对象。
  const at = findExactBinding(config.bindings, rawPath, ctx);
  const samePath = at === -1 ? null : config.bindings[at];

  /** @type {any} */
  const b = samePath ?? { path: rawPath };

  if (args.token !== undefined) {
    const name = validateTokenName(args.token);
    const { exists } = loadToken({ home: ctx.home, name });
    if (!exists) {
      throw new CmtError(`token "${name}" 不存在`, {
        hint: `先建一个：\`cmt token add ${name} --token <密钥>\`（或看看 \`cmt ls\`）`,
      });
    }
    b.token = name;
  }
  if (args.url !== undefined) b.baseUrl = args.url;
  if (args.model !== undefined) {
    const list = parseModelSpecs(Array.isArray(args.model) ? args.model : [args.model]);
    b.models = list;
  }

  if (!samePath) config.bindings.push(b);
  saveConfig({ home: ctx.home, config });

  const rows = [
    ['路径', b.path],
    ['归一化', canonicalPath(b.path, ctx)],
    ['token', b.token ?? '（未设 → 往下层找）'],
    ['apiUrl', b.baseUrl ?? '（未设 → 往下层找）'],
    ['models', b.models ? b.models.map((/** @type {any} */ m) => m.id).join(' → ') : '（未设 → 往下层找）'],
  ];

  process.stdout.write(
    `✓ ${samePath ? '已更新' : '已新增'}路径绑定\n${renderRows(rows)}\n\n` +
      `  看看这个目录现在解析出什么：\`cmt resolve ${b.path}\`\n`,
  );
  return EXIT.OK;
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function list(args, ctx) {
  const { config, path: configFile, exists } = loadConfig({ home: ctx.home });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          configFile,
          exists,
          bindings: config.bindings.map((/** @type {any} */ b) => ({
            ...b,
            normalized: canonicalPath(b.path, ctx),
          })),
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  if (config.bindings.length === 0) {
    process.stdout.write(
      `\n  （还没有任何路径绑定）\n\n` +
        `  建一条：\`cmt bind <目录> --token <name>\`\n\n`,
    );
    return EXIT.OK;
  }

  process.stdout.write('\n');
  for (const b of config.bindings) {
    /** @type {[string, string][]} */
    const rows = [['路径', b.path]];
    const norm = canonicalPath(b.path, ctx);
    if (norm !== b.path) rows.push(['', `（归一化 ${norm}，按这个匹配）`]);
    rows.push(['token', b.token ?? '（未设）']);
    if (b.baseUrl !== undefined) rows.push(['apiUrl', b.baseUrl]);
    if (b.models !== undefined) {
      rows.push(['models', b.models.map((/** @type {any} */ m) => m.id).join(' → ')]);
    }
    process.stdout.write(`${renderRows(rows)}\n\n`);
  }
  return EXIT.OK;
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function rm(args, ctx) {
  const rawPath = args._[1];
  if (rawPath === undefined) {
    throw new CmtError('缺 <路径>', { hint: '用法：cmt bind rm <路径>（先 `cmt bind ls` 看看）' });
  }

  const { config } = loadConfig({ home: ctx.home });
  const target = canonicalPath(rawPath, ctx);
  const before = config.bindings.length;
  config.bindings = config.bindings.filter(
    (/** @type {any} */ b) => canonicalPath(b.path, ctx) !== target,
  );

  if (config.bindings.length === before) {
    throw new CmtError(`没有匹配 "${rawPath}" 的绑定`, {
      hint: '用 `cmt bind ls` 看看现有绑定（匹配按归一化后的路径）',
    });
  }

  saveConfig({ home: ctx.home, config });
  process.stdout.write(`✓ 已删 ${before - config.bindings.length} 条绑定（${rawPath}）\n`);
  return EXIT.OK;
}
