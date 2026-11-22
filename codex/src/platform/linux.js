// @ts-check
/**
 * Linux 终端适配（§2.11 二·1）。
 *
 * | 首选 | 探测依据 | cwd 传递 | 兜底 |
 * |------|---------|---------|------|
 * | `$TERMINAL` → `x-terminal-emulator` → gnome-terminal / konsole / xterm | 逐个 `findExecutable` | `--working-directory` / `--workdir` / `-c` | `tmux new-window -c <cwd>` |
 *
 * ─────────────────────────────────────────────────────────────
 * ## ★ 为什么要一张"已知终端表"
 *
 * `$TERMINAL` 可以是**任何**终端（`kitty`、`alacritty`、`wezterm`…），
 * 而每个终端的 "cwd 参数" 都不一样。**认不出来时不许猜**——
 * 猜错的后果是"新窗口开在当前目录"这种**静默**错误（cwd 是承重要素：续错会话）。
 *
 * ⇒ 表里没有的名字：记进 `tried` 并**继续试下一个候选**，
 *   由 `resolveTerminal()` 把"为什么每个都不行"完整报给用户。
 *
 * ⚠️ **`x-terminal-emulator` 是 Debian 的 alternatives 软链**，光看名字认不出
 * 它到底指向谁——这正是 `TerminalDeps.realpath` 存在的原因（§2.11 二·1 的 types.js）。
 * 解析失败就按"认不出"处理，不猜。
 *
 * ⚠️ **`// UNVERIFIED`**：本机是 Windows，这一整个文件只做过静态审查（§4.4 第 11 步）。
 * ─────────────────────────────────────────────────────────────
 */

/**
 * 已知终端表。
 *
 * - `cwd`：把工作目录塞进 argv 的形式
 * - `title`：窗口/标签标题
 * - `sep`：分隔符（`--` 是"后面都是要跑的命令"的通用约定）
 *
 * @type {Record<string, {
 *   cwd: (p: string) => string[],
 *   title: (t: string) => string[],
 *   sep: string[],
 *   via: 'direct' | 'script',
 *   note?: string,
 * }>}
 */
export const LINUX_TERMINALS = Object.freeze({
  'gnome-terminal': {
    // gnome-terminal 只认 `--working-directory=` 这种带等号的写法（空格写法在新版被弃用）
    cwd: (p) => [`--working-directory=${p}`],
    title: (t) => [`--title=${t}`],
    sep: ['--'],
    via: 'direct',
  },
  konsole: {
    cwd: (p) => ['--workdir', p],
    // konsole 的标题是 profile 属性，不是一级选项
    title: (t) => ['-p', `tabtitle=${t}`],
    sep: ['-e'],
    via: 'direct',
  },
  'xfce4-terminal': {
    cwd: (p) => [`--working-directory=${p}`],
    title: (t) => [`--title=${t}`],
    sep: ['-x'],
    via: 'direct',
  },
  alacritty: {
    cwd: (p) => ['--working-directory', p],
    title: (t) => ['-t', t],
    sep: ['-e'],
    via: 'direct',
  },
  kitty: {
    cwd: (p) => ['--directory', p],
    title: (t) => ['--title', t],
    sep: [],                       // kitty 直接接命令，没有分隔符
    via: 'direct',
  },
  xterm: {
    // ★ xterm **没有** cwd 选项——这正是 §2.11 把它列为 `via: 'script'` 的原因：
    //   只能靠脚本里的 `cd`（§2.12 契约 2：兜底路径才写 cd）
    cwd: () => [],
    title: (t) => ['-T', t],
    sep: ['-e'],
    via: 'script',
    note: 'xterm 无 cwd 选项，只能走脚本（脚本里带 cd）',
  },
});

/** `$TERMINAL` 之后的固定候选顺序（§2.11 二·1 的表） */
export const LINUX_FALLBACK_ORDER = Object.freeze([
  'x-terminal-emulator',
  'gnome-terminal',
  'konsole',
  'xterm',
]);

/**
 * 从一个可执行文件路径认出它**实际**是哪个终端。
 *
 * 先看 basename，再看 `realpath` 的 basename——后者专治 `x-terminal-emulator`
 * 这种 alternatives 软链。
 *
 * @param {string} exePath
 * @param {(p: string) => string | null} [realpath]
 * @returns {keyof typeof LINUX_TERMINALS | null}
 */
export function identifyTerminal(exePath, realpath) {
  const base = (p) => String(p).split('/').pop() ?? '';
  const direct = base(exePath);
  if (direct in LINUX_TERMINALS) return /** @type {any} */ (direct);

  const resolved = realpath?.(exePath) ?? null;
  if (resolved !== null) {
    const r = base(resolved);
    if (r in LINUX_TERMINALS) return /** @type {any} */ (r);
  }
  return null;
}

/**
 * 按已知终端表拼 argv。
 *
 * @param {object} input
 * @param {keyof typeof LINUX_TERMINALS} input.name
 * @param {string} input.title
 * @param {string} input.cwd
 * @param {string[]} input.argv
 * @param {string} input.scriptPath   `via: 'script'` 时要用（xterm 那条）
 * @returns {{ args: string[], via: 'direct' | 'script', warnings: string[] }}
 */
export function linuxArgs({ name, title, cwd, argv, scriptPath }) {
  const spec = LINUX_TERMINALS[name];
  if (spec === undefined) {
    throw new Error(`linuxArgs() 收到表外的终端名：${JSON.stringify(name)}`);
  }

  const warnings = spec.note === undefined ? [] : [spec.note];

  // ★ `via: 'script'` 的（只有 xterm）：cwd 交给脚本里的 `cd`，argv 也由脚本承担。
  //   这里传的是脚本路径而不是用户 argv——两者不能混。
  const target = spec.via === 'script' ? [scriptPath] : argv;

  return {
    args: [...spec.cwd(cwd), ...spec.title(title), ...spec.sep, ...target],
    via: spec.via,
    warnings,
  };
}

/**
 * 兜底：`tmux new-window -c <cwd> -n <title> <argv…>`。
 *
 * ⚠️ 这条**只在用户已经在 tmux 里时才有意义**——`tmux new-window` 会连到
 * 当前 `$TMUX` 会话。不在 tmux 里跑它会得到 "no server running"。
 * 所以它是**最后**一个候选，且失败时要让用户看到这句话。
 *
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.cwd
 * @param {string[]} input.argv
 * @returns {{ args: string[], via: 'direct', warnings: string[] }}
 */
export function tmuxArgs({ title, cwd, argv }) {
  return {
    args: ['new-window', '-c', cwd, '-n', title, ...argv],
    via: 'direct',
    warnings: [],
  };
}
