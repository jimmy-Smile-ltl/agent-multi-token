// @ts-check
/**
 * `cmt slot set` —— 别名槽映射（§2.5）。
 *
 * 槽位把模型填进 Claude Code 的别名槽，**中转站必备**：
 * 不填的话，会话内 `/model` 切到 `opus` 会去请求一个中转站根本没有的模型。
 *
 * 默认规则（`core/models.js` 的 `fillDefaultSlots`）：**未列出的槽自动填 `models[0]`**；
 * 显式 `null` = 该槽不注入，保留 Claude Code 自身默认。
 */
import { CmtError, EXIT } from '../../core/errors.js';
import { SLOT_ENV } from '../../core/models.js';
import { SLOT_KEYS } from '../../core/schema.js';
import { loadConfig } from '../../core/store.js';
import { renderRows } from '../format.js';
import { describeTarget, effectiveAt, pickWriteTarget, writeSlots } from '../target.js';

export const slotCommand = {
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
      process.stdout.write(SLOT_HELP);
      return EXIT.OK;
    }
    if (sub === 'ls' || sub === 'list') return ls(args, ctx);
    if (sub !== 'set') {
      throw new CmtError(`未知子命令 \`cmt slot ${sub}\``, { hint: '可用：set / ls' });
    }

    const spec = args._[1];
    if (spec === undefined) {
      throw new CmtError('缺 <槽>=<模型id>', {
        hint: `用法：cmt slot set haiku=deepseek-flash（槽位：${SLOT_KEYS.join(' / ')}）`,
      });
    }

    const eq = spec.indexOf('=');
    if (eq === -1) {
      throw new CmtError(`写法不对：${spec}`, {
        hint: `要写成 <槽>=<模型id>，例如 haiku=deepseek-flash。可用槽位：${SLOT_KEYS.join(' / ')}`,
      });
    }

    const slot = spec.slice(0, eq);
    const value = spec.slice(eq + 1);
    if (!SLOT_KEYS.includes(/** @type {any} */ (slot))) {
      throw new CmtError(`未知槽位 "${slot}"`, {
        hint: `可用槽位：${SLOT_KEYS.join(' / ')}（对应 ${SLOT_KEYS.map((k) => SLOT_ENV[k]).join(' / ')}）`,
      });
    }
    if (value === '') {
      throw new CmtError(`槽 ${slot} 的值是空的`, {
        hint: `写 \`${slot}=null\` 表示"该槽不注入"，而不是留空`,
      });
    }

    const target = pickWriteTarget(args, ctx, 'slots');
    const { config } = loadConfig({ home: ctx.home });
    // 物化：把当前生效的整份 slots 复制过来再改这一项，别把别的槽弄丢
    const slots = { ...effectiveAt({ config, target, ctx }, 'slots') };
    // `null` 是**有效值**（= 不注入），不是"删除键"
    slots[slot] = value === 'null' ? null : value;

    const { wrote } = writeSlots({ target, slots, ctx });

    /** @type {[string, string][]} */
    const rows = SLOT_KEYS.filter((k) => Object.hasOwn(slots, k)).map((k) => [
      k,
      slots[k] === null ? '（不注入，保留 Claude Code 自身默认）' : String(slots[k]),
    ]);

    process.stdout.write(
      `✓ 已设 ${slot} = ${value}（${describeTarget(target)}）\n\n` +
        `${renderRows(rows)}\n\n` +
        `  写进了 ${wrote}\n` +
        `  没列出的槽会自动填 models[0]（§2.5 默认规则）\n` +
        `  生效：\`cmt run -c\`\n`,
    );
    return EXIT.OK;
  },
};

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function ls(args, ctx) {
  // ★ 传 `'slots'`：`slots` 是 `.cmt.json` 的禁键（§2.11 二），写入目标**不认**项目本地层。
  //   但 `effectiveAt()` 读的时候照样会看那一层——所以下面 `models` 那一行拿到的
  //   仍是**真正生效**的列表（§2.12 十：面板不配 slots，槽位仍走这条命令）。
  const target = pickWriteTarget(args, ctx, 'slots');
  const { config } = loadConfig({ home: ctx.home });
  const slots = effectiveAt({ config, target, ctx }, 'slots');
  const models = effectiveAt({ config, target, ctx }, 'models');
  const fallback = models[0]?.id;

  /** 该槽是**显式声明的**还是"没声明、由 models[0] 自动填"的 */
  const entries = SLOT_KEYS.map((k) => {
    if (Object.hasOwn(slots, k)) {
      const v = slots[k];
      return { slot: k, value: v, explicit: true, env: SLOT_ENV[k] };
    }
    return { slot: k, value: fallback ?? null, explicit: false, env: SLOT_ENV[k] };
  });

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          target: describeTarget(target),
          autoFill: fallback ?? null,
          slots: Object.fromEntries(
            entries.map((e) => [e.slot, { value: e.value, explicit: e.explicit, env: e.env }]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    return EXIT.OK;
  }

  /** @type {[string, string][]} */
  const rows = entries.map((e) => {
    if (!e.explicit) {
      return [
        e.slot,
        e.value !== null ? `${e.value}   ← 自动填 models[0]` : '（未声明，且没有 models 可填）',
      ];
    }
    return [e.slot, e.value === null ? '（显式不注入）' : String(e.value)];
  });

  process.stdout.write(
    `\n别名槽（${describeTarget(target)}）\n\n${renderRows(rows)}\n\n` +
      SLOT_KEYS.map((k) => `  ${k} → ${SLOT_ENV[k]}`).join('\n') +
      '\n\n',
  );
  return EXIT.OK;
}

const SLOT_HELP = `cmt slot set [--global|--token <t>|--path <p>] <槽>=<模型id>
cmt slot ls  [--global|--token <t>|--path <p>]

把模型填进 Claude Code 的别名槽（中转站必备——否则会话内 /model 切到
opus/sonnet 会去请求一个中转站根本没有的模型）。

槽位
  opus / sonnet / haiku / fable   → ANTHROPIC_DEFAULT_<槽>_MODEL
  subagent                        → CLAUDE_CODE_SUBAGENT_MODEL

  <模型id> 写 null 表示"该槽不注入"（保留 Claude Code 自身默认）。
  **没列出的槽会自动填 models[0]**——所以只有 deepseek 的中转站不用逐个配。

⚠️ 槽位**写不进**项目本地配置（.cmt.json 的禁键表里有 slots，§2.11 二）：
   --path <p> 一律写该路径的绑定，哪怕那份 .cmt.json 声明了 models。
   （读的时候会认那一层——\`cmt slot ls\` 报的 models[0] 是真正生效的那份。）

示例
  cmt slot set --global haiku=deepseek-flash
  cmt slot set --path D:/work/a subagent=deepseek-flash
`;
