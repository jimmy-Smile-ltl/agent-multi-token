// @ts-check
/**
 * macOS 终端拉起（§2.9 二·1）。
 *
 * ⚠️ **UNVERIFIED —— 本机没有 macOS，这一支只做过静态审查**（§8 开放问题 7）。
 * 逻辑按 AppleScript 的公开语义写，但没在真机上跑过。发 alpha 时 README 要明标。
 *
 * | 顺序 | 终端 | 探测依据 | 路径 |
 * |------|------|---------|------|
 * | 1 | iTerm2 | `$TERM_PROGRAM` 含 iTerm | **launch 脚本** |
 * | 2 | Terminal.app | 有 `osascript` | **launch 脚本** |
 * | 3 | `open -a Terminal` | 兜底 | **launch 脚本** |
 *
 * **macOS 上没有"直接拉起"这一档**：AppleScript 的 `do script` 只接受命令**字符串**，
 * 于是我们必然要往一个字符串里塞东西——那正是 §2.10 ① 说的"只能走字符串的适配器"。
 * 与其把 argv 拼成字符串（引号地狱），不如只塞一个**脚本路径**：
 * 字符串里唯一被插值的变量就是它，转义面缩到最小。
 */
import { shQuote } from '../core/launch-script.js';

/**
 * @typedef {import('./types.js').TerminalDeps} TerminalDeps
 * @typedef {import('./types.js').TerminalSpec} TerminalSpec
 */

/** @type {string} */
export const name = 'macos';

/**
 * 把一个字符串安全地塞进 AppleScript 的双引号字面量里。
 *
 * AppleScript 的字面量里只有两个字符需要转义：`\` 和 `"`。
 * **顺序要紧**：先转义 `\`，否则第二步会把第一步产生的 `\` 又转一遍。
 * @param {string} s
 */
export function appleScriptString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

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
  void title; // 见下方注释：这两个终端的 CLI 入口都不方便设标题
  void argv; // 因为 via === 'script'，真正要跑的命令在脚本里
  void cwd; // 同理，cwd 也由脚本里的 cd 负责（macOS 全档都是 ② 兜底路径）

  /** @type {string[]} */
  const tried = [];
  const cmd = shQuote(deps.scriptPath);
  const osa = deps.findExecutable('osascript');
  const termProgram = String(ctx.env.TERM_PROGRAM ?? '');

  if (osa && /iTerm/i.test(termProgram)) {
    const script =
      'tell application "iTerm"\n' +
      `  tell current window to create tab with default profile command "${appleScriptString(cmd)}"\n` +
      'end tell';
    return {
      terminal: 'iTerm2',
      command: osa,
      args: ['-e', script],
      via: 'script',
      tried,
      warnings: [],
    };
  }
  if (osa) {
    // Terminal.app：`do script` 直接开一个新窗口跑命令
    const script = `tell application "Terminal" to do script "${appleScriptString(cmd)}"`;
    return {
      terminal: 'Terminal',
      command: osa,
      args: ['-e', script],
      via: 'script',
      tried,
      warnings:
        mode === 'tab'
          ? ['Terminal.app 的 AppleScript 只能开新窗口，不支持开标签页——已按新窗口处理']
          : [],
    };
  }
  tried.push('osascript');

  const open = deps.findExecutable('open');
  if (open) {
    // 最后兜底：让 LaunchServices 用 Terminal 打开脚本。需要脚本可执行（chmod 0755，§2.10）
    return {
      terminal: 'open',
      command: open,
      args: ['-a', 'Terminal', deps.scriptPath],
      via: 'script',
      tried,
      warnings: ['没找到 osascript，退回到 `open -a Terminal`——无法设置窗口标题'],
    };
  }
  tried.push('open');

  // 走到这里说明这台 mac 上连 osascript / open 都没有，基本不可能
  return {
    terminal: 'none',
    command: '',
    args: [],
    via: 'script',
    tried,
    warnings: ['没找到任何可用的终端拉起方式（osascript / open 都没有）'],
  };
}
