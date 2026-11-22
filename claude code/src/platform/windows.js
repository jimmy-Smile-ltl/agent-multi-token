// @ts-check
/**
 * Windows 终端拉起（§2.9 二·1）。
 *
 * | 顺序 | 终端 | 探测依据 | cwd 传递 | 路径 |
 * |------|------|---------|---------|------|
 * | 1 | `wt.exe` | `findExecutable('wt')` | `-d <cwd>` | 直接拉起 |
 * | 2 | `cmd /c start` | 兜底 | 写进脚本 | **launch 脚本** |
 *
 * ⚠️ **不要直接 `spawn` 一个 `.cmd` / `.bat` 文件**——Node 18.20+ / 20.12+ 出于安全
 * （CVE-2024-27980）会直接拒绝。一律经 `cmd.exe /c <脚本>` 调用（`cmd.exe` 是 `.exe`，不受限）。
 *
 * 本文件在**本机 Windows 11 + Windows Terminal 1.24 上实测**（§7.5 末）。
 */

/**
 * @typedef {import('./types.js').TerminalDeps} TerminalDeps
 * @typedef {import('./types.js').TerminalSpec} TerminalSpec
 */

/** @type {string} */
export const name = 'windows';

/**
 * cmt 专属 WT 窗口的名字（§2.9 二·1）。
 *
 * `-w <名字>`：**不存在就用这个名字新建一个窗口，存在就往里加标签页**（§7.7 实测）。
 * 于是"一个窗口多个标签页"是确定性的，且那个窗口被关掉后下次 `cmt run` 会自动重建（自愈）。
 *
 * **硬编码，不做配置键**——本工具的价值就在名字稳定可预期，可配置反而削弱它。
 */
export const WT_WINDOW_NAME = 'cmt';

/**
 * @param {{
 *   title: string,
 *   cwd: string,
 *   argv: string[],
 *   mode: 'tab' | 'window',
 *   ctx: import('../cli/types.js').Ctx,
 *   deps: TerminalDeps,
 * }} opts
 * @returns {TerminalSpec}
 */
export function resolveTerminal({ title, cwd, argv, mode, ctx, deps }) {
  /** @type {string[]} */
  const tried = [];

  const wt = deps.findExecutable('wt');
  if (wt) {
    return {
      terminal: 'wt',
      command: wt,
      // `-w <窗口名>`：有叫这个名字的窗口就往里加标签页，没有就用这个名字建一个。
      // 用固定名字而**不是** `-w 0` / `-w last`——那是"最近使用过的窗口"，多窗口时
      // 落点取决于"上次碰过哪个"，不可预期，观感就是"窗口到处乱开"（§2.9 二·1、§7.7）。
      // `--title` 只负责"把标题写上"，标签页里跑的程序一用 OSC 2 就能覆盖它；
      // 紧跟的 `--suppressApplicationTitle` 才负责"别被覆盖"。实测 Claude Code 会把
      // "cmt:relay-test · claude_test" 覆盖成 "✳ cmt:relay-test"，cwd 末段当场丢失。
      // ⚠️ 它必须出现在 `new-tab` 子命令**之后**。
      args: [
        '-w',
        mode === 'window' ? '-1' : WT_WINDOW_NAME,
        'new-tab',
        '--title',
        title,
        '--suppressApplicationTitle',
        '-d',
        cwd,
        ...argv,
      ],
      via: 'direct',
      tried,
      warnings: [],
      // 只有 tab 模式有"落在哪个窗口"可言（window 模式是每次都新开一个）
      windowName: mode === 'window' ? undefined : WT_WINDOW_NAME,
    };
  }
  tried.push('wt');

  // 兜底：cmd 只能接命令字符串（§2.10 ①）→ 走 launch 脚本。
  // 用 ComSpec 的绝对路径，不依赖 PATH。
  /** @type {string[]} */
  const warnings = ['没找到 Windows Terminal（wt.exe），退回到 cmd 脚本兜底'];
  if (mode === 'tab') {
    // `cmd /c start` 没有标签页概念——不能默默退化成开新窗口，得让用户知道
    warnings.push('cmd 兜底没有标签页概念，这次只能开一个新窗口（装 Windows Terminal 才有标签页）');
  }
  return {
    terminal: 'cmd',
    command: ctx.env.ComSpec ?? 'cmd.exe',
    // 第一个 "" 是 start 的窗口标题参数（缺了它 start 会把脚本路径当标题）
    args: ['/c', 'start', '', deps.scriptPath],
    via: 'script',
    tried,
    warnings,
  };
}
