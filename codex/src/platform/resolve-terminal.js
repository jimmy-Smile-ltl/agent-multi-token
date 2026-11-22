// @ts-check
/**
 * 终端解析器——**纯决策**（§2.11 二·1）。
 *
 * 拆成两步是刻意的：把"决策"从"副作用"里剥出来，测试就能覆盖
 * "在 Linux 上算 Windows 的终端命令"这种本机跑不了的场景。
 * 副作用（真的 `spawn`）在 `spawn-terminal.js`，本文件**不 spawn、不读盘、不读 env**。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 探测失败时**必须列出试过哪些**
 *
 * "拉起失败"这条错误信息，如果只写"找不到终端"，用户下一步只能瞎猜。
 * 所以 `TerminalSpec.tried` 是**每一个候选 + 它为什么不行**：
 *
 * ```
 * 拉不起新终端。已尝试：
 *   · wt: PATH 里没找到
 *   · x-terminal-emulator: 认不出是哪个终端（已知表里没有），不猜它的 cwd 参数
 *   · gnome-terminal: PATH 里没找到
 * ```
 *
 * ## 认不出就不猜
 *
 * `$TERMINAL` 可以是任何终端。**猜错 cwd 参数 = 静默在错误的目录里开会话**，
 * 而 cwd 是承重的（续错会话比开不起来更糟）。所以表外的名字一律记进
 * `tried` 然后继续下一个候选——**绝不套用别的终端的参数**。
 * ─────────────────────────────────────────────────────────────
 */

import { win32 as win32Path, posix as posixPath } from 'node:path';
import { EnvError } from '../core/errors.js';
import { WINDOWS_TERMINALS, CXT_WINDOW_NAME, comspecOf, windowsArgs, windowsFallbackArgs } from './windows.js';
import { preferredFromTermProgram, iterm2Args, terminalAppArgs, openTerminalArgs } from './macos.js';
import { LINUX_FALLBACK_ORDER, identifyTerminal, linuxArgs, tmuxArgs } from './linux.js';

/**
 * 窗口标题：`cxt:<token> · <cwd 末段>`（§2.11 二·1）。
 *
 * 标题是**功能不是装饰**：多开时一堆同名窗口分不清谁是谁，
 * 用户就只能靠切进去看提示符来认——那正是这个工具要消灭的体验。
 *
 * @param {string} token
 * @param {string} cwd
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function buildTitle(token, cwd, platform) {
  const pathMod = platform === 'win32' ? win32Path : posixPath;
  // 末段可能为空（cwd 是盘根 `C:\` 或 `/`）——那就退回整条路径，别留个空标题
  const base = pathMod.basename(pathMod.normalize(cwd)) || cwd;
  return `cxt:${token} · ${base}`;
}

/**
 * @param {import('./types.js').SpawnRequest & { mode?: 'window' | 'tab' }} request
 * @param {object} ctx
 * @param {NodeJS.Platform} ctx.platform
 * @param {Record<string, string | undefined>} ctx.env
 * @param {import('./types.js').TerminalDeps} ctx.deps
 * @returns {import('./types.js').TerminalSpec}
 */
export function resolveTerminal(request, { platform, env, deps }) {
  const { title, cwd, argv, mode = 'tab' } = request;
  /** @type {string[]} */
  const tried = [];

  if (platform === 'win32') return resolveWindows({ title, cwd, argv, mode }, { env, deps, tried });
  if (platform === 'darwin') return resolveMac({ title, cwd, argv }, { env, deps, tried });
  if (platform === 'linux') return resolveLinux({ title, cwd, argv }, { env, deps, tried });

  throw new EnvError(`不支持的平台：${platform}`, {
    hint: 'cxt 支持 win32 / darwin / linux。用 `cxt exec <token>` 在当前终端里跑（不需要拉起新终端）',
  });
}

// ───────────────────────────── Windows ─────────────────────────────

/**
 * `wt.exe` → `cmd /c start` 兜底。
 *
 * ⚠️ 兜底**丢 cwd**（`start` 没有设置工作目录的能力，只能靠 `launch.cmd` 里的 `cd`），
 * 而 §2.12 明确：**兜底路径才写 `cd`**。所以这条不是"次等公民"，
 * 只是多了一层 shell —— 但要在 warning 里说清，别让用户以为行为和 wt 一样。
 *
 * ⚠️ 兜底**也没有标签页概念**（`start` 只能开新窗口）。所以 `mode: 'tab'` 走到这条路上
 * 必须**报警**——用户要的是标签页，拿到的是新窗口，不能默默退化（§2.11 二·1）。
 *
 * @param {{ title: string, cwd: string, argv: string[], mode: 'window' | 'tab' }} req
 * @param {{ env: Record<string, string | undefined>, deps: import('./types.js').TerminalDeps, tried: string[] }} ctx
 * @returns {import('./types.js').TerminalSpec}
 */
function resolveWindows(req, { env, deps, tried }) {
  for (const name of WINDOWS_TERMINALS) {
    const exe = deps.findExecutable(name);
    if (exe === null) {
      // ★ 这条能走到，本身就说明 §7.14⑤ 的 App Execution Alias 兜底在起作用：
      //   `wt.exe` 是 WindowsApps 下的重解析点，`existsSync` 对它返回 false。
      tried.push(`${name}: PATH 里没找到`);
      continue;
    }
    const { args, via, warnings } = windowsArgs(req);
    /** @type {import('./types.js').TerminalSpec} */
    const spec = { terminal: name, command: exe, args, via, tried, warnings };
    // ★ 只有 tab 模式有"具名窗口"可言（§2.11 二·1）——
    //   window 模式的语义是"总是新窗口"，那个窗口没有名字，回执也就不该提名字。
    if (req.mode === 'tab') spec.windowName = CXT_WINDOW_NAME;
    return spec;
  }

  // 兜底：cmd.exe 由 %COMSPEC% 保证，不走 findExecutable
  const comspec = comspecOf(env);
  const { args, via, warnings } = windowsFallbackArgs({ title: req.title, scriptPath: deps.scriptPath });
  tried.push(`cmd: 兜底（用 %COMSPEC% = ${comspec}）`);
  return {
    terminal: 'cmd',
    command: comspec,
    args,
    via,
    // ★ 这条路的参数是我们自己拼好引号的，绝不能让 Node 再加工一遍（见 types.js 的 verbatimArgs）
    verbatimArgs: true,
    tried,
    warnings: [
      ...warnings,
      '走 cmd 兜底：cwd 由 launch.cmd 里的 cd 承担（start 本身不支持设置工作目录）',
      // ★ 用户要标签页、我们给新窗口——这是**降级**，必须说出来（§2.11 二·1）
      ...(req.mode === 'tab'
        ? ['走 cmd 兜底：`start` 没有标签页概念，这次会**开一个新窗口**而不是标签页（要标签页得让 wt.exe 可用）']
        : []),
    ],
  };
}

// ───────────────────────────── macOS ─────────────────────────────

/**
 * `$TERM_PROGRAM` → iTerm2 / Terminal.app → `open -a Terminal` 兜底。
 *
 * ⚠️ **`$TERM_PROGRAM` 认不出时，不试 iTerm2**：`tell application "iTerm2"`
 * 在没装 iTerm2 的机器上会弹一个"要找到 iTerm2 吗"的系统对话框——
 * 那是比"拉不起来"更糟的失败形态（它会卡住脚本）。
 * Terminal.app 是系统自带的，可以放心试。
 *
 * @param {{ title: string, cwd: string, argv: string[] }} req
 * @param {{ env: Record<string, string | undefined>, deps: import('./types.js').TerminalDeps, tried: string[] }} ctx
 * @returns {import('./types.js').TerminalSpec}
 */
function resolveMac(req, { env, deps, tried }) {
  const scriptPath = deps.scriptPath;
  const preferred = preferredFromTermProgram(env);
  if (preferred === null) {
    tried.push(
      `$TERM_PROGRAM=${JSON.stringify(env.TERM_PROGRAM ?? null)}: 认不出（只认 iTerm / Apple_Terminal），`
      + '不猜 iTerm2 是否装了——`tell application` 找不到 app 会弹系统对话框',
    );
  }

  const osascript = deps.findExecutable('osascript');
  if (osascript === null) {
    tried.push('osascript: PATH 里没找到（macOS 自带，找不到说明 PATH 被改坏了）');
  } else {
    // ★ 这里没有"先试 iTerm2、失败再试 Terminal.app"的循环——因为**分辨不出来**：
    //   iTerm2 是个 .app bundle，`findExecutable` 看不见它，而 `tell application`
    //   在 app 不存在时**不会返回错误**，它会弹一个"要找到 iTerm2 吗"的系统对话框卡在那里。
    //   ⇒ 只有在 `$TERM_PROGRAM` 明确说"你正跑在 iTerm 里"时才选它，其余一律 Terminal.app。
    const name = preferred === 'iterm2' ? 'iterm2' : 'terminal-app';
    const built = name === 'iterm2'
      ? iterm2Args({ title: req.title, scriptPath })
      : terminalAppArgs({ title: req.title, scriptPath });
    return { terminal: name, command: osascript, args: built.args, via: built.via, tried, warnings: built.warnings };
  }

  // 兜底：open -a Terminal（`open` 在 /usr/bin，一定在）
  const open = deps.findExecutable('open');
  if (open !== null) {
    const built = openTerminalArgs({ scriptPath });
    tried.push('open -a Terminal: 兜底');
    return { terminal: 'open', command: open, args: built.args, via: built.via, tried, warnings: built.warnings };
  }
  tried.push('open: PATH 里没找到（/usr/bin/open，找不到说明 PATH 被改坏了）');

  throw new EnvError(`拉不起新终端。已尝试：\n${bullet(tried)}`, {
    hint: '用 `cxt exec <token>` 在当前终端里跑（不需要拉起新终端）',
  });
}

// ───────────────────────────── Linux ─────────────────────────────

/**
 * `$TERMINAL` → `LINUX_FALLBACK_ORDER` → `tmux` 兜底。
 *
 * @param {{ title: string, cwd: string, argv: string[] }} req
 * @param {{ env: Record<string, string | undefined>, deps: import('./types.js').TerminalDeps, tried: string[] }} ctx
 * @returns {import('./types.js').TerminalSpec}
 */
function resolveLinux(req, { env, deps, tried }) {
  /** @type {string[]} */
  const candidates = [];
  const termEnv = env.TERMINAL;
  if (typeof termEnv === 'string' && termEnv !== '') candidates.push(termEnv);
  for (const name of LINUX_FALLBACK_ORDER) {
    if (!candidates.includes(name)) candidates.push(name);
  }

  for (const name of candidates) {
    const exe = deps.findExecutable(name);
    if (exe === null) {
      tried.push(`${name}: PATH 里没找到`);
      continue;
    }
    const kind = identifyTerminal(exe, deps.realpath);
    if (kind === null) {
      tried.push(`${name}: 认不出是哪个终端（已知表里没有），不猜它的 cwd 参数`);
      continue;
    }
    const built = linuxArgs({ name: kind, title: req.title, cwd: req.cwd, argv: req.argv, scriptPath: deps.scriptPath });
    return { terminal: kind, command: exe, args: built.args, via: built.via, tried, warnings: built.warnings };
  }

  // 兜底：tmux（只在已经在 tmux 里时才有意义）
  const inTmux = typeof env.TMUX === 'string' && env.TMUX !== '';
  if (!inTmux) {
    tried.push('tmux: 不在 tmux 里（$TMUX 未设置），`tmux new-window` 会得到 "no server running"');
  } else {
    const tmux = deps.findExecutable('tmux');
    if (tmux === null) {
      tried.push('tmux: $TMUX 有值但 PATH 里没找到 tmux');
    } else {
      const built = tmuxArgs({ title: req.title, cwd: req.cwd, argv: req.argv });
      tried.push('tmux new-window: 兜底');
      return { terminal: 'tmux', command: tmux, args: built.args, via: built.via, tried, warnings: built.warnings };
    }
  }

  throw new EnvError(`拉不起新终端。已尝试：\n${bullet(tried)}`, {
    hint: '装一个终端（`apt install gnome-terminal`），或用 `$TERMINAL=<你的终端> cxt run …`，'
      + '或用 `cxt exec <token>` 在当前终端里跑',
  });
}

/** @param {string[]} lines */
function bullet(lines) {
  return lines.map((l) => `  · ${l}`).join('\n');
}
