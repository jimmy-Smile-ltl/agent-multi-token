// @ts-check
/**
 * Linux 终端拉起（§2.9 二·1）。
 *
 * ⚠️ **UNVERIFIED —— 本机没有 Linux 桌面，这一支只做过静态审查**（§8 开放问题 7）。
 *
 * 探测顺序：`$TERMINAL` → `x-terminal-emulator` → gnome-terminal / konsole / xterm。
 *
 * 各家的 cwd 与"执行命令"参数**互不兼容**，所以这里用一张表描述而不是一堆 if：
 *
 * | 终端 | cwd | 执行命令 | 开标签页 |
 * |------|-----|---------|---------|
 * | gnome-terminal | `--working-directory=<d>` | `--` | `--tab` |
 * | konsole | `--workdir <d>` | `-e` | `--new-tab` |
 * | xfce4-terminal | `--working-directory=<d>` | `-x` | `--tab` |
 * | alacritty | `--working-directory <d>` | `-e` | ❌ |
 * | xterm | ❌ **没有 cwd 选项** | `-e` | ❌ |
 *
 * `xterm` 那一行的 ❌ 就是 §2.10 ② 说的"终端无 cwd 选项"——此时只能写 `cd` 进脚本。
 *
 * `$TERMINAL` 只给一个**二进制名**，不告诉我们它是什么终端，所以按 basename 去表里认领；
 * 认不出来就当成"只有 `-e`、没有 cwd 选项"处理（走脚本兜底，最保守）。
 */

/**
 * @typedef {import('./types.js').TerminalDeps} TerminalDeps
 * @typedef {import('./types.js').TerminalSpec} TerminalSpec
 */

/** @type {string} */
export const name = 'linux';

/**
 * 各家终端的方言表。
 *
 * `cwdArgs` 返回 `null` = 这个终端没有 cwd 选项（必须走脚本兜底）。
 * @type {{
 *   bin: string,
 *   cwdArgs: (cwd: string) => string[] | null,
 *   runSep: string,
 *   tabArg: string | null,
 * }[]}
 */
export const LINUX_TERMINALS = [
  {
    bin: 'gnome-terminal',
    cwdArgs: (cwd) => [`--working-directory=${cwd}`],
    runSep: '--',
    tabArg: '--tab',
  },
  {
    bin: 'konsole',
    cwdArgs: (cwd) => ['--workdir', cwd],
    runSep: '-e',
    tabArg: '--new-tab',
  },
  {
    bin: 'xfce4-terminal',
    cwdArgs: (cwd) => [`--working-directory=${cwd}`],
    runSep: '-x',
    tabArg: '--tab',
  },
  {
    bin: 'alacritty',
    cwdArgs: (cwd) => ['--working-directory', cwd],
    runSep: '-e',
    tabArg: null,
  },
  {
    bin: 'xterm',
    cwdArgs: () => null, // ← 没有 cwd 选项，只能写 cd 进脚本
    runSep: '-e',
    tabArg: null,
  },
];

/** `x-terminal-emulator` 是 Debian 系的 alternatives 软链，指向上面某一个 */
const ALTERNATIVES_BIN = 'x-terminal-emulator';

/**
 * 按 basename 认领一个终端方言；认不出来返回 `null`。
 * @param {string} binPath
 */
export function flavorOf(binPath) {
  const base = String(binPath).split('/').pop() ?? '';
  return LINUX_TERMINALS.find((t) => t.bin === base) ?? null;
}

/**
 * 认领方言，多试几个来源（顺序 = 可信度）：
 *   1. 找到的路径名——正常情况
 *   2. `$TERMINAL` 的原值——路径被包装过时兜底
 *   3. **软链解析后的真名**——`x-terminal-emulator` 是 Debian 的 alternatives 软链，
 *      只看软链名认不出方言；不解析的话最常见的 Ubuntu 桌面反而退化到脚本兜底
 *
 * @param {string} binPath
 * @param {string} pref
 * @param {TerminalDeps['realpath']} realpath
 */
function claimFlavor(binPath, pref, realpath) {
  const direct = flavorOf(binPath) ?? flavorOf(pref);
  if (direct) return direct;
  const real = realpath ? realpath(binPath) : null;
  return real ? flavorOf(real) : null;
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
  void title; // 这些终端的命令行都不方便设标题（gnome-terminal 的 --title 已废弃）

  /** @type {string[]} */
  const tried = [];
  /** @type {string[]} */
  const warnings = [];

  /** @type {{ bin: string, path: string, flavor: any } | null} */
  let hit = null;

  // 1) $TERMINAL —— 用户显式指定，优先级最高
  const pref = String(ctx.env.TERMINAL ?? '').trim();
  if (pref !== '') {
    const p = deps.findExecutable(pref);
    if (p) {
      const flavor = claimFlavor(p, pref, deps.realpath);
      hit = { bin: pref, path: p, flavor };
      if (!flavor) {
        warnings.push(
          `$TERMINAL 指定的 "${pref}" 不在已知方言表里，按最保守方式处理（不传 cwd，走脚本兜底）`,
        );
      }
    } else {
      tried.push(`$TERMINAL=${pref}`);
      warnings.push(`$TERMINAL 指定的 "${pref}" 找不到，继续探测其他终端`);
    }
  }

  // 2) 已知方言表 + alternatives 软链
  if (!hit) {
    for (const bin of [ALTERNATIVES_BIN, ...LINUX_TERMINALS.map((t) => t.bin)]) {
      const p = deps.findExecutable(bin);
      if (p) {
        // x-terminal-emulator 是软链，按软链名认领不到方言 → 靠 realpath 解析出真名
        hit = { bin, path: p, flavor: claimFlavor(p, bin, deps.realpath) };
        break;
      }
      tried.push(bin);
    }
  }

  if (!hit) {
    return {
      terminal: 'none',
      command: '',
      args: [],
      via: 'script',
      tried,
      warnings: [...warnings, '没找到任何可用的终端模拟器'],
    };
  }

  const { path: binPath, flavor } = hit;
  const cwdArgs = flavor?.cwdArgs(cwd) ?? null;
  /** @type {string[]} */
  const prefix = [];

  if (mode === 'tab' && flavor?.tabArg) prefix.push(flavor.tabArg);

  if (cwdArgs) {
    // ✅ 有 cwd 选项 → 直接拉起，argv 不经 shell
    return {
      terminal: flavor.bin,
      command: binPath,
      args: [...prefix, ...cwdArgs, flavor.runSep, ...argv],
      via: 'direct',
      tried,
      warnings,
    };
  }

  // ❌ 没有 cwd 选项（xterm / 认不出的 $TERMINAL）→ 只能把 cd 写进脚本
  warnings.push(
    `${flavor?.bin ?? hit.bin} 没有传递工作目录的命令行选项，改用 launch 脚本兜底（§2.10 ②）`,
  );
  return {
    terminal: flavor?.bin ?? hit.bin,
    command: binPath,
    args: [...prefix, flavor?.runSep ?? '-e', deps.scriptPath],
    via: 'script',
    tried,
    warnings,
  };
}

/**
 * `cmt doctor` 用：这个终端方言能不能直接拉起（不需要脚本）。
 * @param {string} bin
 * @param {TerminalDeps['realpath']} [realpath]
 */
export function supportsDirectLaunch(bin, realpath) {
  const f = claimFlavor(bin, bin, realpath);
  return f ? f.cwdArgs('/x') !== null : false;
}
