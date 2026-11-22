// @ts-check
/**
 * cli 层内部类型。core/ 不 import 这里——它的类型在各模块自己头上。
 */

/**
 * 注入上下文：**core 层能看到的全部外界信息**。
 * 由 cli/main.js 唯一构造（§4.2）。
 *
 * core 层不许自己读 `process.env` / `process.platform` / `os.homedir()`——
 * 全部从这里拿。这样三平台规则能在任意一台机器上单测（§6.3）。
 *
 * @typedef {object} Ctx
 * @property {NodeJS.Platform} platform  process.platform
 * @property {string} home               os.homedir()，不带尾部分隔符
 * @property {Record<string, string | undefined>} env
 * @property {string} cwd                当前工作目录
 * @property {boolean} isTTY             `process.stdout.isTTY`——上色与否看它
 * @property {boolean} stdinIsTTY        `process.stdin.isTTY`——`--pick` 能不能用看它（§2.5）
 * @property {string | null} configPath  ★ 全局 flag `--config <path>`（§2.13 一）。
 *   给了就**跳过向上发现**、只读这一份；`null` = 没给，走发现。
 *   ⚠️ 由 `main.js` 在 dispatch **之前**抽出来（各命令的 spec 里**不该**再声明它）
 */

/**
 * 一个子命令。
 * @typedef {object} Command
 * @property {import('./parse-args.js').ParseSpec} spec
 * @property {(args: any, ctx: Ctx) => Promise<number> | number} run
 */
