// @ts-check
/**
 * 新窗口要跑的那条命令行（`buildCxtCommandLine`）+ 它的兜底序列化
 * （`launch.{cmd,sh}`，§2.12）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## ★ 先说清楚：脚本是**兜底**，不是主路径
 *
 * 首选路径是 `platform.spawnTerminal({ title, cwd, argv }, env)` **直接拉起**——
 * 无 shell 解析、无引号歧义、无代码页，中文路径根本不经过 `.cmd`（Node 在 Windows
 * 上用 UTF-16 传参）。
 *
 * 只有三种情况才落盘这个脚本：
 * ① 终端只接受命令字符串（macOS `osascript`、`cmd /c start`）；
 * ② 终端没有 cwd 选项（如 `xterm`）；③ 用户想手工重跑。
 *
 * ⇒ **脚本是首选路径的忠实序列化**：argv 与直接拉起时**逐字一致**。
 *   任何"脚本里顺手多做一点"的改动都会让两条路分叉，那是 bug 不是特性。
 *
 * ## ★★ 所以 argv 只有**一个**源头：`buildCxtCommandLine()`
 *
 * 这不是洁癖，是真机实测换来的。这条命令行曾经在两个地方各拼一遍，
 * 于是**两处各错一半、症状还完全不同**：
 *
 * | 错法 | 症状 |
 * |------|------|
 * | 漏 `exec` 关键字 | 窗口正常弹出、标题正常，然后**一闪而过**——里面跑的是 `cxt relay-a`，dispatch 报"未知命令" |
 * | 漏 node 解释器 | 窗口弹出来，第一行是 `出现错误 2147942593 (0x800700c1)`——`cxt.js` 是**脚本不是 exe**，wt 拿它当程序名去 `CreateProcess` 得到 `ERROR_BAD_EXE_FORMAT` |
 *
 * 两个都只显示在**那个窗口里**，外面什么都看不见。而兜底脚本那条路一直是好的
 * （它自己补了 `exec`，也自己带了 node），于是症状是"脚本能跑、直连不能跑"。
 *
 * ⇒ 现在两处都从 `buildCxtCommandLine()` 取，`exec` 与 node 都只有一处能写错。
 * ─────────────────────────────────────────────────────────────
 *
 * ## 四条内容契约（§2.12，本模块的全部职责）
 *
 * | # | 契约 | 为什么 |
 * |---|------|--------|
 * | 1 | **绝对路径调用**：`"<node>" "<cxt>" exec <token>` | 新终端的 PATH 与启动时可能不同，**任何一步都不能依赖 PATH** |
 * | 2 | **默认不写 cwd** | cwd 由终端的 cwd 参数传。只有 ①② 兜底路径才写 `cd`，且 `doctor` 要标注编码风险 |
 * | 3 | **参数透传**：cmd 用 `%*`，sh 用 `"$@"` | 用户附加的 flag 要能落到 codex 上 |
 * | 4 | **不出现任何密钥** | §2.7 铁律：脚本可能被复制、被备份、被贴进 issue |
 *
 * ## 编码（§2.12 + §7.14③，两条规则**相反**，别混）
 *
 * - `.sh`：**LF** + `#!/bin/sh` + 调用方 `chmod 0755`
 * - `.cmd`：**CRLF**，且**整个文件纯 ASCII——注释也不例外**
 *
 * `.cmd` 纯 ASCII 不是洁癖：中文 Windows 的 cmd 默认跑在 **OEM 代码页**，
 * UTF-8 的中文注释会让它把后面的字节一起读花，**路径再 ASCII 也救不回来**。
 * 所以 `.cmd` 的注释写英文，理由留在这里。
 * （⚠️ 注意与 §7.14① 相反：**配置文件不能带 BOM，脚本可以**。别把规则搬错。）
 *
 * ⚠️ **本模块是纯函数**（§4.2）：输入路径与 argv，输出字符串。
 * 写盘、`chmod`、`mkdir` 都是 `store.js` / `platform/` 的事。
 */

import { CxtError } from './errors.js';

// ───────────────────────────── 转义 ─────────────────────────────

/**
 * `.cmd` 的值转义：一律 `"..."` 包裹，且 `%` 写成 `%%`。
 *
 * ★ `%` 在 cmd 里**即使在双引号内也会展开**（`%PATH%`、`%1`），
 * 所以必须转义——这是 `.cmd` 与 `.sh` 最大的一个不对称。
 *
 * ⚠️ 双引号本身**不**转义：cmd 没有可靠的引号内转义手段
 * （`\"` 不是 cmd 的转义，是给 C 运行时的）。含 `"` 的路径在 cmd 上无解，
 * 所以这里**报错**而不是生成一个看起来对、跑起来错的脚本。
 *
 * @param {string} s
 * @returns {string} 含双引号的值，例：`"D:\a b\c"`
 */
export function quoteCmdValue(s) {
  const v = String(s);
  if (v.includes('"')) {
    throw new CxtError(`路径里含双引号，无法安全写进 .cmd：${JSON.stringify(v)}`, {
      hint: 'cmd 没有引号内的引号转义手段。把该路径改名，或改用直接拉起（不走脚本）',
    });
  }
  // `%` → `%%`：cmd 在任何位置都会展开 `%`，包括引号内
  return `"${v.replace(/%/g, '%%')}"`;
}

/**
 * `.sh` 的值转义：一律 `'...'` 包裹，内部的 `'` 用 `'\''` 收尾重开。
 *
 * 单引号里**没有任何字符**有特殊含义（连 `\` 和 `$` 都是字面量），
 * 所以这是 POSIX 下最省心的引法——唯一的例外就是单引号自己。
 *
 * @param {string} s
 * @returns {string} 含单引号的值，例：`'D:/a b/c'`
 */
export function quoteShValue(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** `\` → `/`（POSIX 上 `\` 是合法文件名字符，但 Windows 路径必须转） */
function toPosixPath(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * 全 ASCII 校验。**`.cmd` 专用**（§7.14③）。
 *
 * 与其"生成完再检查"，不如在**每个片段拼进去之前**查——那样报错能指到具体是哪一段
 * （token 名？路径？），而不是甩给用户一个"文件里有非 ASCII"。
 *
 * @param {string} s
 * @param {string} what 报错时点名用（"node 路径" / "token 名" …）
 */
function assertAscii(s, what) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0x7f) {
      throw new CxtError(`.cmd 脚本的${what}含非 ASCII 字符：${JSON.stringify(s)}`, {
        hint: '中文 Windows 的 cmd 跑在 OEM 代码页，非 ASCII 会把后面的字节一起读花。'
          + '这是 §2.12 要求 .cmd 全 ASCII 的原因。'
          + '把该路径/名字改成 ASCII，或改用直接拉起（不走脚本）',
      });
    }
  }
}

// ───────────────────────────── 生成 ─────────────────────────────

/**
 * @typedef {object} LaunchScriptInput
 * @property {string} nodePath   `process.execPath`——**不是 `node` 字面量**
 * @property {string} cxtPath    `bin/cxt.js` 的绝对路径
 * @property {string[]} execArgs
 *   ★ **交给 `cxt exec` 的全部参数**，`exec` 这个关键字本身不算在内。
 *   例：`['relay-a', '--model', 'deepseek-flash', '-c', '--', '--no-alt-screen']`
 *
 *   ⚠️ 这个字段是**数组而不是 `token` / `model` / `extraArgs` 三个语义字段**，
 *   是刻意的（§2.12）：脚本必须是"直接拉起"那条路的**忠实序列化**。
 *   一旦这里按语义重新拼一遍 argv，就有了两个拼 argv 的地方，
 *   而它们迟早会分叉——`cxt run` 加一个新 flag 时只改一处就够了。
 *   契约要的是"逐字一致"，那就只能有**一个**源头。
 * @property {string | null} [cwd]
 *   写 `cd` 用的目录。**只有兜底路径才传**——传了就写 `cd`，
 *   直接拉起那条路传 null（§2.12 契约 2）。
 * @property {NodeJS.Platform} platform
 */

/** `buildCxtCommandLine()` 前几段的名字，报错时点名用（超出部分是 exec 参数） */
const HEAD_LABELS = ['node 路径', 'cxt 入口路径', 'exec 关键字'];

/**
 * ★★ **唯一的 argv 源头**：新窗口里要跑的那条完整命令行。
 *
 * ```js
 * ['C:\\Program Files\\nodejs\\node.exe', 'D:\\…\\bin\\cxt.js', 'exec', 'relay-a', '--cwd', 'D:/x']
 * ```
 *
 * 两条路都从这里取：
 * - **首选**（直接拉起）：`cxt run` 把它当 `argv` 交给 `spawnTerminal()`，环境由第二个参数带过去
 * - **兜底**（`via: 'script'`）：`buildLaunchCmd` / `buildLaunchSh` 把它序列化进脚本
 *
 * ### 为什么第一段必须是 node，而不是直接给 `cxt.js`
 *
 * `bin/cxt.js` 是**脚本不是可执行文件**。终端的 `-e` / `start` 那条路最终走到
 * `CreateProcess`，拿一个 `.js` 当程序名会得到 `0x800700C1`（`ERROR_BAD_EXE_FORMAT`），
 * 而**报错只显示在那个新窗口里**——外面看起来一切正常。
 *
 * ⚠️ 别指望 shebang：`#!/usr/bin/env node` 只在 POSIX 上由内核解释，
 * Windows 上没人看它。而且 `'node'` 字面量会依赖新终端的 PATH，
 * 与"任何一步都不依赖 PATH"（契约 1）冲突——所以收的是 `nodePath`，不是 `'node'`。
 *
 * ### 为什么 `exec` 也在这里补
 *
 * 它和 node 是同一类东西：**命令行结构的一部分**，不是调用方能随手拼的。
 * 留给调用方补的代价已经付过一次了（见文件头那张表）。
 *
 * @param {{ nodePath: string, cxtPath: string, execArgs: string[] }} input
 * @returns {string[]} `[nodePath, cxtPath, 'exec', ...execArgs]`
 */
export function buildCxtCommandLine({ nodePath, cxtPath, execArgs }) {
  return [nodePath, cxtPath, 'exec', ...execArgs];
}

/**
 * 生成 `launch.cmd` 的内容（CRLF + 纯 ASCII）。
 *
 * 形如：
 * ```cmd
 * @echo off
 * REM cxt fallback launcher - generated, safe to delete
 * REM Prefer `cxt run <token>`; this file is for terminals that need a command string.
 * "<node>" "<cxt>" exec "relay-a" "--model" "deepseek-flash" %*
 * ```
 *
 * @param {LaunchScriptInput} input
 * @returns {string}
 */
export function buildLaunchCmd(input) {
  const { cwd = null } = input;
  const head = buildCxtCommandLine(input);

  // 拼之前逐段查 ASCII——报错能指到具体哪一段（见 assertAscii 的注释）
  head.forEach((a, i) => assertAscii(a, HEAD_LABELS[i] ?? `exec 参数[${i - HEAD_LABELS.length}]`));
  if (cwd !== null) assertAscii(cwd, 'cwd');

  const lines = [
    '@echo off',
    // ★ 注释必须英文（§2.12）：中文 Windows 的 cmd 跑在 OEM 代码页
    'REM cxt fallback launcher - generated file, safe to delete',
    'REM Prefer "cxt run <token>". This exists for terminals that only take a command string.',
  ];

  // 契约 2：只有兜底路径才写 cd（`/d` 让它能跨盘符切换）
  if (cwd !== null) lines.push(`cd /d ${quoteCmdValue(cwd)}`);

  // 契约 1：绝对路径，一个都不依赖 PATH
  // 契约 3：`%*` **故意不转义**——它必须原样透传，别让它经过 quoteCmdValue 变成 `%%*`
  //
  // ⚠️ `execArgs` **整份都加引号**，包括 `--model` 这种 flag 本身。
  //    契约原先写的是"固定关键字不加引号，只有值加"，但那要求这个函数**认识**
  //    `exec` 的 flag 集合——于是每加一个 flag 都要回来改一次，正是要避免的分叉。
  //    统一加引号后规则只剩一条"`exec` 不加，其余都加"，且语义完全等价
  //    （cmd 与 sh 都把 `"--model"` 当 `--model`）。
  // ★ 唯一不加引号的就是 `head[2]`（`exec` 关键字）——它的位置由 buildCxtCommandLine 保证
  const argv = [quoteCmdValue(head[0]), quoteCmdValue(head[1]), head[2]];
  for (const a of head.slice(HEAD_LABELS.length)) argv.push(quoteCmdValue(a));
  argv.push('%*');
  lines.push(argv.join(' '));

  // 契约 4：整条链上没有任何密钥——token 传的是**名字**，值是 exec 自己从环境读的
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * 生成 `launch.sh` 的内容（LF + `#!/bin/sh`）。
 *
 * 调用方负责 `chmod 0755`（本模块是纯函数，不碰 fs）。
 *
 * @param {LaunchScriptInput} input
 * @returns {string}
 */
export function buildLaunchSh(input) {
  const { cwd = null } = input;
  const head = buildCxtCommandLine(input);

  const lines = [
    '#!/bin/sh',
    '# cxt fallback launcher - generated file, safe to delete',
    '# Prefer "cxt run <token>". This exists for terminals that only take a command string.',
  ];

  if (cwd !== null) lines.push(`cd ${quoteShValue(toPosixPath(cwd))}`);

  // 契约 3：`"$@"` **故意不转义**——双引号是必须的，它保证每个参数各自成一个词
  const argv = [quoteShValue(toPosixPath(head[0])), quoteShValue(toPosixPath(head[1])), head[2]];
  for (const a of head.slice(HEAD_LABELS.length)) argv.push(quoteShValue(a));
  argv.push('"$@"');
  lines.push(argv.join(' '));

  return `${lines.join('\n')}\n`;
}

/**
 * 按平台生成**文件名**与内容。
 *
 * 文件名与内容一起给，是因为"`.cmd` 配 CRLF、`.sh` 配 LF"是一条不可分的约束——
 * 拆成两个函数迟早会有人在 Windows 上要 `.sh` 却拿到 CRLF（`#!/bin/sh\r`
 * 在多数 shell 上会报 `bad interpreter`，且报错信息完全不指向换行符）。
 *
 * @param {LaunchScriptInput} input
 * @returns {{ fileName: 'launch.cmd' | 'launch.sh', text: string, eol: 'CRLF' | 'LF', needsChmod: boolean }}
 */
export function buildLaunchScript(input) {
  const platform = input.platform;
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new CxtError(`buildLaunchScript() 收到未知 platform：${JSON.stringify(platform)}`, {
      hint: 'core 不读 process.platform（§4.2）——由 platform/ 层传进来',
    });
  }

  if (platform === 'win32') {
    return { fileName: 'launch.cmd', text: buildLaunchCmd(input), eol: 'CRLF', needsChmod: false };
  }
  return { fileName: 'launch.sh', text: buildLaunchSh(input), eol: 'LF', needsChmod: true };
}
