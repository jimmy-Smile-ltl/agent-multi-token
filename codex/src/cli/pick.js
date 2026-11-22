// @ts-check
/**
 * `--pick`：从当前生效的模型列表里交互挑一个（§2.5）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 三条设计约束
 *
 * 1. **仅本次生效，绝不落盘**（§2.5）。挑完只改这一次 spawn 的 argv，
 *    `config.json` / `catalogs/` 一个字都不动。想要持久用 `cxt model use`。
 * 2. **单元素列表也弹选择器**。看着多余，但"我敲了 `--pick` 却什么都没发生"
 *    比"弹了个只有一项的列表"更让人困惑——与 `rotateNext()` 少于两项报错
 *    是同一条原则（宁可明确，不要静默）。
 * 3. **非 TTY 直接报错，不猜**。`cxt run` 可能被脚本调起，那时 stdin 不是终端，
 *    读下去只会挂住。这时正确的做法是让调用方改用 `--model <id>`。
 *
 * ## 为什么不用 readline
 *
 * `node:readline` 会把 stdin 设成 raw mode 并接管按键，为"读一行数字"
 * 引入一整套终端状态管理（还要负责还原）。这里只读一行，
 * `process.stdin.once('data')` 够用且没有任何需要还原的状态。
 * 代价是要自己处理"用户按了 Ctrl+C / 关了管道"——见下面的 `close` 分支。
 * ─────────────────────────────────────────────────────────────
 */

import { CxtError } from '../core/errors.js';
import { modelLabel } from '../core/models.js';
import { makePainter } from './format.js';

/**
 * 把用户输入的一行解析成序号（0-based）。
 *
 * 接受 `1`..`n` 这样的**人类序号**（1-based）。纯函数，单独测。
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
 * 弹选择器，返回选中的下标。
 *
 * @param {{ models: import('../core/models.js').ModelEntry[], ctx: import('./types.js').Ctx, what: string }} input
 * @returns {Promise<number>}
 */
export async function promptChoice({ models, ctx, what }) {
  if (ctx.stdinIsTTY !== true) {
    throw new CxtError(`${what}需要交互输入，但 stdin 不是终端`, {
      hint: '改用显式指定：`--model <id>`；或直接在终端里跑',
    });
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  const out = process.stderr; // 提示走 stderr：stdout 留给 `--json` 之类的产物
  out.write(`\n  ${c.bold(what)}\n`);
  models.forEach((m, i) => {
    const label = modelLabel(m);
    out.write(`    ${c.cyan(String(i + 1))}) ${label}${label === m.id ? '' : c.dim(`  (${m.id})`)}\n`);
  });
  out.write(`\n  ${c.dim('序号（回车取消）')}: `);

  const line = await readLine();
  if (line === null) {
    // 回车 / EOF / 管道关闭——三种都归到"取消"，退出码走 CxtError 的默认值（1）
    throw new CxtError('已取消');
  }
  const idx = parseChoice(line, models.length);
  if (idx === null) {
    throw new CxtError(`看不懂的选择：${JSON.stringify(line.trim())}`, {
      hint: `输入 1 到 ${models.length} 之间的序号`,
    });
  }
  return idx;
}

/**
 * ★ 二次确认（`cxt token rm --purge` 用，§3.3）。
 *
 * 三条与 `promptChoice` 同源的纪律，外加一条**专属于破坏性操作**的：
 *
 * 1. **非 TTY 一律不确认 = 不执行**。`--purge` 在脚本里没带 `--yes` 时
 *    **报错**而不是默默删掉——"没人看着的时候默认删"是这类命令最糟的默认值。
 * 2. **默认是"否"**：回车、EOF、关管道、看不懂的输入，全都归到 `false`。
 *    只有明确敲 `y` / `yes` 才算同意。
 * 3. 提示走 **stderr**，stdout 留给产物（与 `promptChoice` 一致）。
 *
 * @param {{ ctx: import('./types.js').Ctx, what: string, detail?: string }} input
 * @returns {Promise<boolean>}
 */
export async function promptConfirm({ ctx, what, detail }) {
  if (ctx.stdinIsTTY !== true) {
    throw new CxtError(`${what}需要确认，但 stdin 不是终端`, {
      hint: '在终端里跑，或显式加 `--yes` 表示你已经知道后果',
    });
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  const out = process.stderr;
  out.write(`\n  ${c.bold(what)}\n`);
  if (detail) {
    for (const line of String(detail).split('\n')) out.write(`    ${c.dim(line)}\n`);
  }
  out.write(`\n  ${c.dim('确认？输入 y 继续（回车取消）')}: `);

  const line = await readLine();
  return line !== null && /^(y|yes)$/i.test(line.trim());
}

/**
 * 读一行 stdin。
 *
 * ⚠️ 三个出口都要有，少一个就会**挂住**：
 * - `data`   —— 正常读到一行
 * - `end`    —— 管道被关（`echo 1 | cxt run --pick` 读完就走这里）
 * - `close`  —— 同上，但某些平台只发这个
 *
 * @returns {Promise<string | null>} null = 没读到（EOF / 空行）
 */
function readLine() {
  return new Promise((resolve) => {
    /** @param {() => void} fn */
    const done = (fn) => {
      process.stdin.removeListener('data', onData);
      process.stdin.removeListener('end', onEnd);
      process.stdin.removeListener('close', onEnd);
      process.stdin.pause();
      fn();
    };
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      const s = String(chunk).replace(/\r?\n$/, '');
      done(() => resolve(s === '' ? null : s));
    };
    const onEnd = () => done(() => resolve(null));

    process.stdin.setEncoding('utf8');
    process.stdin.once('data', onData);
    process.stdin.once('end', onEnd);
    process.stdin.once('close', onEnd);
    process.stdin.resume();
  });
}
