// @ts-check
/**
 * `--pick`：从当前生效的模型列表里交互挑一个（§2.5）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 三条设计约束
 *
 * 1. **仅本次生效，绝不落盘**（§2.5）。挑完只改这一次 spawn 的 argv，
 *    `config.json` 一个字都不动。想要持久用 `cmt model use`。
 * 2. **单元素列表直接返回，不弹选择器**。`models[0]` 已经就是答案，
 *    再问一遍是让用户为一个已经定好的结果按一次回车。
 * 3. **非 TTY 直接报错，不猜**（与 `cmt ui` 同纪律）。`cmt run` 可能被脚本调起，
 *    那时 stdin 不是终端，读下去只会挂住。这时正确的做法是让调用方改用 `--model <id>`。
 *
 * ## ★ `parseChoice()` 是**两条前端共用的那一小块**
 *
 * 全屏面板的逐行模式（`CMT_UI=plain`，§2.12 七）要把「敲 3」翻译成
 * 「选中第 3 项」，而这里要把「敲 3」翻译成「第 3 个模型」——**同一件事**。
 * 所以它放在这儿、被 `commands/ui.js` 引，而不是各写一份：
 * 两处各写一遍的话，"序号从 1 数"这条约定迟早会在一边变成从 0 数。
 * ─────────────────────────────────────────────────────────────
 */

import { createInterface } from 'node:readline/promises';

import { CmtError } from '../core/errors.js';
import { formatModel } from '../core/models.js';

/**
 * 把用户输入的一行解析成序号（0-based）。
 *
 * 接受 `1`..`n` 这样的**人类序号**（1-based）。纯函数，单独测。
 *
 * ⚠️ 返回 `null` 与返回 `0` 是两回事：`0` 是"第一项"，
 * `null` 是"这行我看不懂"。调用方必须分开处理，否则"敲了 abc"
 * 会静默变成"选了第一项"。
 *
 * @param {string} line 用户敲的那一行（可带空白）
 * @param {number} count 候选个数
 * @returns {number | null} 0-based 下标；解析不出来返回 null
 */
export function parseChoice(line, count) {
  const t = String(line).trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  if (n < 1 || n > count) return null;
  return n - 1;
}

/**
 * 弹选择器，返回选中的模型 id。
 *
 * 这是 `cmt run` **唯一**会提问的地方——§2.5 规则 2 明确要求默认不提问。
 *
 * ★ `ctx` 是必需的，不是可选：TTY 判据一律走注入的 `ctx.stdinIsTTY`（§4.2），
 *   命令层不自己去读 `process.stdin`——否则这个分支在测试里就没法拨到两边。
 *
 * @param {any[]} models `resolved.models.value`（已按优先级排好）
 * @param {import('./types.js').Ctx} ctx
 * @returns {Promise<string>} 选中的模型 id
 */
export async function pickModel(models, ctx) {
  if (models.length === 0) {
    throw new CmtError('模型列表为空，没得挑', {
      hint: '先设一个：`cmt model set --global <id>`，或直接用 `--model <id>`',
    });
  }
  if (models.length === 1) return models[0].id;
  if (!ctx.stdinIsTTY) {
    throw new CmtError('--pick 需要交互式终端', {
      hint: `非交互环境下请直接指定：--model ${models[0].id}`,
    });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write('选择模型（顺序即优先级）：\n');
    models.forEach((m, i) => {
      process.stdout.write(`  ${i + 1}) ${formatModel(m)}\n`);
    });
    const ans = (await rl.question(`序号 [1-${models.length}]，回车取 1：`)).trim();
    if (ans === '') return models[0].id;
    const idx = parseChoice(ans, models.length);
    if (idx === null) {
      throw new CmtError(`无效的序号：${ans}`, { hint: `请输入 1 到 ${models.length} 之间的整数` });
    }
    return models[idx].id;
  } finally {
    rl.close();
  }
}
