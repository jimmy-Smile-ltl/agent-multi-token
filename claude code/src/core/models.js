// @ts-check
/**
 * 模型优先级列表的运算（§2.5）。
 *
 * `models` 是**有序优先级表**，`models[0]` 优先级最高，它就是本次会话的默认模型。
 *
 * ⚠️ **"优先级"不等于自动故障转移。** Claude Code 的 `--fallback-model` 仅 `--print` 模式有效，
 * 交互模式下 `models[0]` 只是默认选中项，不会在不可用时自动跳到 `models[1]`。
 * 所以 `models[1..]` 的用途是**人工提拔栈**：
 *
 *     cmt model next   # 轮转，下一个候选升为 models[0]
 *     cmt run -c       # 新窗口，claude -c 继续该目录最近一次会话
 *
 * 本模块只做列表数学——"写进哪一层"是 CLI 的事（§2.5 的表）。
 */
import { SLOT_KEYS } from './schema.js';

/**
 * @typedef {{ id: string, label?: string }} ModelEntry
 */

/**
 * 槽位 → 注入的环境变量名（§2.5）。
 *
 * 中转站必备——否则会话内 `/model` 切到 `opus` 会去请求一个中转站根本没有的模型。
 * @type {Record<string, string>}
 */
export const SLOT_ENV = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
};

/**
 * 轮转一位：`models[0]` 移到末位，原 `models[1]` 升为 `models[0]`。
 *
 * **轮转而非删除**——所以反复 `next` 不会把候选耗光，转满一圈能回到原点。
 * @param {ModelEntry[]} models
 * @returns {ModelEntry[]}
 */
export function rotate(models) {
  if (models.length <= 1) return models.slice();
  return [...models.slice(1), models[0]];
}

/**
 * 把 `id` 提到首位，**其余保持相对顺序**（原首位退到第二，便于切回）。
 *
 * 目标 id 不在列表里 → 插到首位（`cmt model use` 一个全新模型是合法操作）。
 * @param {ModelEntry[]} models
 * @param {string} id
 * @returns {ModelEntry[]}
 */
export function promote(models, id) {
  const hit = models.find((m) => m.id === id);
  const rest = models.filter((m) => m.id !== id);
  return [hit ?? { id }, ...rest];
}

/**
 * 去掉重复 id，保留**首次出现**的位置。
 *
 * 重复 id 会让 `promote` / `rotate` 的语义变得含混（同一项出现两次，谁代表它？），
 * 所以归一化阶段就清掉。
 * @param {ModelEntry[]} models
 * @returns {ModelEntry[]}
 */
export function dedupeModels(models) {
  const seen = new Set();
  /** @type {ModelEntry[]} */
  const out = [];
  for (const m of models) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * 解析 CLI 的 `<id[:label]>` 写法（§5 `cmt model set`）。
 *
 * 只切**第一个** `:`——所以 id 里不能含冒号，label 里可以。
 * （中转站的模型 id 基本是 `deepseek-flash[1m]` 这种，含冒号的极少见。）
 * @param {string} spec
 * @returns {ModelEntry}
 */
export function parseModelSpec(spec) {
  const i = spec.indexOf(':');
  if (i === -1) return { id: spec };
  return { id: spec.slice(0, i), label: spec.slice(i + 1) };
}

/**
 * 批量解析，并顺带去重。
 * @param {string[]} specs
 * @returns {ModelEntry[]}
 */
export function parseModelSpecs(specs) {
  return dedupeModels(specs.map(parseModelSpec));
}

/**
 * 渲染成给人看的一行：`deepseek-flash[1m]  (Flash 1M)`
 * @param {ModelEntry} m
 */
export function formatModel(m) {
  return m.label ? `${m.id}  (${m.label})` : m.id;
}

/**
 * 填默认槽位（§2.5）：**未在 `slots` 中列出的槽，自动填 `models[0]`**。
 *
 * 这条默认让"只有 deepseek 的中转站"不会因为别名槽空着而去请求一个根本不存在的 claude 模型。
 *
 * 两个例外必须保持：
 * - 显式写 `null` 的槽 → **不注入**（保留 Claude Code 自身默认）
 * - `models` 为空 → 没有可填的，未声明的槽就空着
 *
 * @param {Record<string, string | null> | undefined} slots 该层生效的 slots
 * @param {ModelEntry[]} models 该层生效的 models
 * @returns {Record<string, string | null>} 完整的槽位表
 */
export function fillDefaultSlots(slots, models) {
  const fallback = models[0]?.id;
  /** @type {Record<string, string | null>} */
  const out = {};

  for (const k of SLOT_KEYS) {
    if (slots && Object.hasOwn(slots, k)) {
      out[k] = slots[k]; // 显式给了（含 null）就照办
    } else if (fallback !== undefined) {
      out[k] = fallback;
    }
  }
  return out;
}

/**
 * 两个列表是否等价（顺序敏感）。
 * @param {ModelEntry[]} a
 * @param {ModelEntry[]} b
 */
export function modelsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.id === b[i].id && m.label === b[i].label);
}

/**
 * ★ 从优先级里挑第一个**端点确实有**的候选（§2.5「启动前校验」）。
 *
 * 语义与 {@link promote} 同一套：被选中的那个提到首位，**其余保持相对顺序**——
 * 于是"本次用 b"之后，列表看起来就是你手动 `cmt model use b` 会得到的那个顺序。
 *
 * | 情况 | `picked` | `models` |
 * |------|----------|----------|
 * | 首位就在清单里 | `0` | 原样（**新数组**，便于调用方辨别） |
 * | 第 k 位命中 | `k` | 命中项提前，其余保序 |
 * | 一个都不命中 | `-1` | 原样 |
 *
 * ⚠️ 一个都不命中时**绝不**随便挑一个：那等于把用户没写过的模型拿去跑。
 * 保留配置顺序、让他自己看见"清单里没有"，比替他猜一个安全得多。
 *
 * @param {ModelEntry[]} models 配置的优先级列表
 * @param {string[]} availableIds 端点 `/models` 说它有的那些 id
 * @returns {{ models: ModelEntry[], picked: number, missing: string[] }}
 *   `picked` 是**原列表里的下标**（没有命中为 `-1`）；`missing` 是配置里有、端点没说的
 */
export function chooseAvailable(models, availableIds) {
  const list = Array.isArray(models) ? models : [];
  const have = new Set(Array.isArray(availableIds) ? availableIds : []);
  const missing = list.filter((m) => !have.has(m.id)).map((m) => m.id);
  const at = list.findIndex((m) => have.has(m.id));
  if (at < 0) return { models: [...list], picked: -1, missing };
  return { models: [list[at], ...list.slice(0, at), ...list.slice(at + 1)], picked: at, missing };
}
