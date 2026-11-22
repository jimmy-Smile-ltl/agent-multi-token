// @ts-check
/**
 * platform 层的类型（§2.9 二·1）。
 *
 * 适配层只暴露一件事：`resolveTerminal()` 决定**怎么拉起**，`spawnTerminal()` 真的拉。
 * 拆成两步是因为前者是纯决策、可以在任何机器上单测，后者是唯一无法单测的部分（§6.3）。
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
 *   windowName?: string,
 * }} TerminalSpec
 *
 * `via` 的含义：
 * - `'direct'` —— **首选路径**。argv 是数组，一路不被 shell 解析（§2.10）。
 * - `'script'` —— 只能给命令字符串，需要 `profiles/<t>/launch.{cmd,sh}` 兜底。
 *   调用方看到 `'script'` 就必须**先落盘脚本**再 spawn。
 *
 * `windowName` 的含义：标签页/窗口**落进哪个窗口**（如果这个平台有"命名窗口"这回事）。
 * Windows 的 `wt -w cmt` 是唯一会填它的适配器（§2.9 二·1）；macOS / Linux 的"开标签页"
 * 就是往当前窗口加，没有名字可言，**不填**。回执据此说"已在 cmt 窗口开标签页"——
 * 所以**别在 cli 层硬写窗口名**，那在 macOS / Linux 上就是假话。
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

export {};
