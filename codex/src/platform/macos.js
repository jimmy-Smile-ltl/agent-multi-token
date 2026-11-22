// @ts-check
/**
 * macOS 终端适配（§2.11 二·1）。
 *
 * | 首选 | 探测依据 | cwd 传递 | 兜底 |
 * |------|---------|---------|------|
 * | iTerm2 / Terminal.app | `$TERM_PROGRAM` | `do script "cd …"`（字符串） | `open -a Terminal <脚本>` |
 *
 * ─────────────────────────────────────────────────────────────
 * ## ★ 一条设计决定：让 macOS 也**跑脚本**，而不是把 argv 拼成字符串
 *
 * §2.11 说"只有必须走字符串的适配器才做转义，**且必须各自带转义单测**"。
 * AppleScript 确实只吃字符串，但**不意味着 argv 得进那个字符串**——
 * 让 AppleScript 去执行 `launch.sh`（argv 由脚本承担），字符串里就只剩下
 * **一个路径 + 一个标题**，转义面从"每个参数"缩到"两处"。
 *
 * ⇒ argv 一路是数组，直到被 `core/launch-script.js` 序列化进 `launch.sh`。
 *   这与 §2.12「脚本是首选路径的忠实序列化」是同一件事的两面。
 *
 * ## 标题怎么设
 *
 * iTerm2 / Terminal.app 的 AppleScript 都不接受"给新会话设标题"的参数，
 * 所以标题用 OSC 转义序列在命令开头设一次（`printf '\033]0;<t>\007'`）。
 * ⇒ 字符串里于是有**两处**用户数据（标题、脚本路径），两处都要转义，两处都有单测。
 *
 * ⚠️ **`// UNVERIFIED`**：本机是 Windows，这一整个文件只做过静态审查（§4.4 第 11 步）。
 * ─────────────────────────────────────────────────────────────
 */

import { quoteShValue } from '../core/launch-script.js';

/** `$TERM_PROGRAM` 的值 → 我们的适配器名 */
export const TERM_PROGRAM_MAP = Object.freeze({
  iTerm: 'iterm2',
  Apple_Terminal: 'terminal-app',
  // 这两个也设 $TERM_PROGRAM，但行为与 Terminal.app 不同，先不声称支持（认不出就不猜）
  vscode: null,
  Hyper: null,
});

/**
 * 把一个 JS 字符串变成 **AppleScript 字面量**（含两侧双引号）。
 *
 * ⚠️ 这是**第二层**转义，别和 shell 那层混：AppleScript 的 `"…"` 里
 * `\` 与 `"` 要转义；而 shell 那层由 `quoteShValue()` 用单引号处理。
 * 两层各管各的，且**顺序不能反**（先 shell 转义，再塞进 AppleScript）。
 *
 * @param {string} s
 */
export function appleScriptString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * 拼出"设标题 + 跑脚本"的那条 **shell** 命令。
 *
 * 只有两处用户数据：`title` 与 `scriptPath`。`title` 先按 POSIX 单引号规则
 * 转义再嵌进 `printf` 的格式串里——这样标题里的 `'`、`$`、`\` 都只是字面量。
 *
 * @param {string} title
 * @param {string} scriptPath
 */
export function launchCommandLine(title, scriptPath) {
  return `printf '%s' ${quoteShValue(`\u001b]0;${title}\u0007`)}; exec ${quoteShValue(scriptPath)}`;
}

/**
 * iTerm2：`create window with default profile command "<命令>"`。
 *
 * ⚠️ iTerm2 的 `command` **直接执行**，不经过用户 shell——所以标题得靠
 * 命令里的 `printf` 自己设（见上）。
 *
 * @param {{ title: string, scriptPath: string }} input
 * @returns {{ args: string[], via: 'script', warnings: string[] }}
 */
export function iterm2Args({ title, scriptPath }) {
  const cmd = launchCommandLine(title, scriptPath);
  return {
    args: [
      '-e',
      `tell application "iTerm2" to create window with default profile command ${appleScriptString(cmd)}`,
    ],
    via: 'script',
    warnings: [],
  };
}

/**
 * Terminal.app：`do script "<命令>"`。
 *
 * ⚠️ `do script` 走**用户 shell**（`$SHELL`），会经过用户的 `.zshrc` 等配置；
 * iTerm2 的 `command` 不会。两者行为不同，别当成一回事。
 *
 * @param {{ title: string, scriptPath: string }} input
 * @returns {{ args: string[], via: 'script', warnings: string[] }}
 */
export function terminalAppArgs({ title, scriptPath }) {
  const cmd = launchCommandLine(title, scriptPath);
  return {
    args: ['-e', `tell application "Terminal" to do script ${appleScriptString(cmd)}`],
    via: 'script',
    warnings: [],
  };
}

/**
 * 兜底：`open -a Terminal <launch.sh>`。
 *
 * ⚠️ 标题在这条路上**设不了**（`open` 没有这个能力）——所以这条会给 warning，
 * 让用户知道"这个窗口的标题不会显示 token"。静默丢掉一个承重功能是不行的。
 *
 * ⚠️ `open` 对 `.sh` 的处理取决于它有没有可执行位与 shebang，
 * 所以 §2.12 要求调用方 `chmod 0755`，那不是可选项。
 *
 * @param {{ scriptPath: string }} input
 * @returns {{ args: string[], via: 'script', warnings: string[] }}
 */
export function openTerminalArgs({ scriptPath }) {
  return {
    args: ['-a', 'Terminal', scriptPath],
    via: 'script',
    warnings: ['`open -a Terminal` 无法设置窗口标题——这个窗口不会显示 token 名'],
  };
}

/**
 * 按 `$TERM_PROGRAM` 选首选适配器。
 * @param {Record<string, string | undefined>} env
 * @returns {'iterm2' | 'terminal-app' | null}
 */
export function preferredFromTermProgram(env) {
  const v = env.TERM_PROGRAM;
  if (typeof v !== 'string' || v === '') return null;
  return TERM_PROGRAM_MAP[v] ?? null;
}
