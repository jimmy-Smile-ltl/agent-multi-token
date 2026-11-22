// @ts-check
/**
 * `cmt ls` —— token 列表 + 各自的 cwd / 模型来源（§5）。
 *
 * "模型来源"是本命令的重点：一眼看出每个 token 用的是**自己的**列表还是**继承全局**的。
 */
import { EXIT } from '../../core/errors.js';
import { profileDir } from '../../core/paths.js';
import { listTokenNames, loadConfig, loadToken } from '../../core/store.js';
import { renderRows } from '../format.js';

export const lsCommand = {
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
    if (args.help) {
      process.stdout.write(LS_HELP);
      return EXIT.OK;
    }

    const { config, path: configFile, exists: configExists } = loadConfig({ home: ctx.home });
    const names = listTokenNames({ home: ctx.home });

    /** @type {any[]} */
    const rows = [];
    for (const name of names) {
      const { token, exists } = loadToken({ home: ctx.home, name });
      if (!exists || !token) continue; // 文件在但读不出来 → 跳过，别让整个列表崩掉
      rows.push({
        name,
        cwd: token.cwd ?? null,
        models: token.models ? token.models.map((/** @type {any} */ m) => m.id) : null,
        modelsSource: token.models ? 'own' : 'global',
        baseUrl: token.baseUrl ?? null,
        authMode: token.authMode ?? null,
        profile: profileDir(ctx.home, name),
      });
    }

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            configFile,
            configExists,
            home: ctx.home,
            defaults: {
              token: config.defaults.token ?? null,
              baseUrl: config.defaults.baseUrl ?? null,
              models: config.defaults.models?.map((/** @type {any} */ m) => m.id) ?? null,
            },
            tokens: rows,
            bindings: config.bindings.length,
          },
          null,
          2,
        )}\n`,
      );
      return EXIT.OK;
    }

    /** @type {string[]} */
    const out = [];

    if (config.defaults.models || config.defaults.baseUrl || config.defaults.token) {
      out.push('');
      out.push('全局默认（config.defaults）');
      /** @type {[string, string][]} */
      const d = [];
      if (config.defaults.token) d.push(['默认 token', config.defaults.token]);
      if (config.defaults.baseUrl) d.push(['apiUrl', config.defaults.baseUrl]);
      if (config.defaults.models) {
        d.push(['models', config.defaults.models.map((/** @type {any} */ m) => m.id).join(' → ')]);
      }
      out.push(renderRows(d));
    }

    out.push('');
    if (rows.length === 0) {
      out.push('  （还没有任何 token）');
      out.push('');
      out.push('  建一个：`cmt token add <name> --token <密钥>`');
      out.push('');
      process.stdout.write(`${out.join('\n')}\n`);
      return EXIT.OK;
    }

    out.push(`token（共 ${rows.length} 个）`);
    for (const r of rows) {
      /** @type {[string, string][]} */
      const t = [['cwd', r.cwd ?? '（未设）']];
      t.push([
        'models',
        r.models
          ? `${r.models.join(' → ')}   ← 自己的列表`
          : '（继承全局）',
      ]);
      if (r.baseUrl) t.push(['apiUrl', r.baseUrl]);
      if (r.authMode) t.push(['authMode', r.authMode]);
      out.push('');
      out.push(`  ${r.name}`);
      out.push(renderRows(t, { indent: '    ' }));
    }

    out.push('');
    out.push(`  绑定 ${config.bindings.length} 条（\`cmt bind ls\` 看详情）`);
    out.push(`  看某个目录怎么解析：\`cmt resolve <路径>\``);
    out.push('');

    process.stdout.write(`${out.join('\n')}\n`);
    return EXIT.OK;
  },
};

const LS_HELP = `cmt ls [--json]

列出全部 token，以及各自的 cwd 与**模型列表来源**（自己的 / 继承全局的）。
`;
