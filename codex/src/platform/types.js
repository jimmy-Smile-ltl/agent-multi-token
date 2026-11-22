// @ts-check
/**
 * platform 层的类型（§2.11 二·1）。
 *
 * 适配层只暴露两件事：
 *   - `resolveTerminal()` —— **纯决策**：算出该怎么拉起（可在任何机器上单测）
 *   - `spawnTerminal()`   —— **真的拉**：唯一无法单测的部分（§6.3）
 *
 * 拆成两步是刻意的：把"决策"从"副作用"里剥出来，测试就能覆盖
 * "在 Linux 上算 Windows 的终端命令"这种本机跑不了的场景。
 */

/**
 * `resolveTerminal()` 的返回：一份**可直接交给 `child_process.spawn` 的规格**。
 *
 * @typedef {{
 *   terminal: string,
 *   command: string,
 *   args: string[],
 *   via: 'direct' | 'script',
 *   tried: string[],
 *   warnings: string[],
 *   verbatimArgs?: boolean,
 *   windowName?: string,
 * }} TerminalSpec
 *
 * `via` 的含义（§2.12）：
 * - `'direct'` —— **首选路径**。`argv` 是数组，一路不被 shell 解析。
 *   无 shell、无 TOML 引号歧义、无代码页问题——**这是跨平台设计红利**。
 * - `'script'` —— 终端只吃命令字符串（macOS `osascript`、Windows `cmd /c start`）
 *   或没有 cwd 选项（`xterm`）。调用方看到 `'script'` 就必须**先落盘
 *   `profiles/<t>/launch.{cmd,sh}`** 再 spawn，并让用户知道产生了这个文件。
 *
 * `tried` 是探测失败的**全部候选**——报错时必须列出来，别只说"失败"（§2.11 二·1）。
 *
 * `windowName` **只在"标签页落进了一个具名窗口"时填**（今天只有 Windows 的 tab 模式，
 * 值是 `CXT_WINDOW_NAME`）。回执据此说"已在 cxt 窗口的新标签页启动"。
 *
 * ⚠️ **cli 层不许硬写窗口名**——macOS / Linux 的"开标签页"就是往**当前**窗口加，
 * 没有名字可言；在那里写死 `'cxt'` 就是假话。有名字才说名字，没有就不说。
 *
 * ─────────────────────────────────────────────────────────────
 * ## `verbatimArgs`：给 `spawn` 传 `windowsVerbatimArguments: true`
 *
 * **只有 Windows 的 `cmd` 兜底**会置它（`windowsFallbackArgs`）。理由：
 *
 * Node 在 Windows 上默认会给每个参数加引号、并把内部 `"` 转义成 `\"`。
 * 但 `\"` **不是 cmd 的转义**（那是给 C 运行时的），cmd 只认 `""` 与 `^"`。
 * ⇒ 我们精心拼好的 `"/d /s /c" + 一整条命令串`（§7.14④）会被 Node 再加工一遍，
 *   结果是 cmd 拿到一堆 `\"` 并把它当字面反斜杠——命令直接跑不起来。
 *
 * 所以这条路上必须 `verbatimArgs: true`：**参数原样传，一个字符都别动**。
 * 代价是这条路得自己负责全部引号——`windowsFallbackArgs()` 正是干这个的，
 * 它也因此有自己的转义单测。
 *
 * ⚠️ 别的路径**不能**置它：`wt.exe` / `osascript` / 各 Linux 终端都按
 * Windows/POSIX 的正常规则解析 argv，原样传会让含空格的路径被从中间切开。
 * ─────────────────────────────────────────────────────────────
 */

/**
 * 终端适配器拿到的依赖。**全部注入**，所以 `resolveTerminal()` 能在任意宿主机上测。
 *
 * `realpath` 可选：解析软链用（Linux 的 `x-terminal-emulator` 是 alternatives 软链，
 * 只看软链名认不出它到底是哪个终端）。解析失败返回 `null`，不抛。
 *
 * @typedef {{
 *   findExecutable: (name: string) => string | null,
 *   realpath?: (p: string) => string | null,
 *   scriptPath: string,
 * }} TerminalDeps
 */

/**
 * `spawnTerminal()` 的入参（§2.11 二·1）。
 *
 * ⚠️ `argv` **始终是数组**，一路不被 shell 解析。这是承重约束：
 * 一旦某个适配器把 argv 拼成字符串，就要各自处理引号与转义，
 * §2.11 的"设计红利"就没了。
 *
 * `title` 形如 `cxt:<token> · <cwd 末段>`——**总是带 cwd 末段**，
 * 因为本工具无状态、无从知道"是不是第二个窗口"，与其猜不准不如每次带上（§2.11 二·1）。
 *
 * @typedef {{
 *   title: string,
 *   cwd: string,
 *   argv: string[],
 * }} SpawnRequest
 */

export {};
