// @ts-check
/**
 * Windows 终端适配（§2.11 二·1）。
 *
 * | 首选 | 探测依据 | cwd 传递 | 兜底 |
 * |------|---------|---------|------|
 * | `wt.exe` | `findExecutable('wt')` | `-d <cwd>` | `cmd /c start "" <脚本>` |
 *
 * ─────────────────────────────────────────────────────────────
 * ## ⚠️ 两个真机暗礁都落在这一层
 *
 * **① `wt.exe` 是 App Execution Alias**（§7.14⑤）：`statSync` 看不见它，
 * `existsSync` 也是 `false`。定位必须走 `find-executable.js` 那条带 `lstatSync`
 * 兜底的路——**自己写 `existsSync(join(dir, 'wt.exe'))` 会静默失败**，
 * 后果是首选路径永远不生效、每次都悄悄退到兜底，且不报任何错。
 *
 * **② `cmd /c "<带空格的路径>"` 会被从中间切开**（§7.14④）。
 * 兜底那条必须写成 `/d /s /c` + 整条命令一个字符串。
 * ─────────────────────────────────────────────────────────────
 */

/** 候选名。顺序即优先级（§2.11 二·1）。 */
export const WINDOWS_TERMINALS = Object.freeze(['wt']);

/**
 * tab 模式的**专属窗口名**（§2.11 二·1）。
 *
 * **硬编码，不做配置键**：本工具的价值就在"名字稳定可预期"，
 * 让它可配置反而削弱它。纯 defaults 模式（无 token）也落进同一个窗口——
 * 标题里的 `cxt:default` 已经能区分，没必要为它单开一个窗口。
 */
export const CXT_WINDOW_NAME = 'cxt';

/**
 * 兜底用的解释器。不走 `findExecutable`——`cmd.exe` 由 `%COMSPEC%` 保证。
 * @param {Record<string, string | undefined>} env
 */
export function comspecOf(env) {
  const v = env.COMSPEC ?? env.ComSpec ?? env.comspec;
  return typeof v === 'string' && v !== '' ? v : 'cmd.exe';
}

/**
 * `wt.exe` 的 argv。
 *
 * ## `-w` 决定标签页落在哪（§7.16 的实测表，**别凭印象改**）
 *
 * | 取值 | 语义 | 用途 |
 * |------|------|------|
 * | `cxt` | 有名为 `cxt` 的窗口 → 往里加标签页；没有 → **用这个名字建一个**（自愈） | `tab`（默认） |
 * | `new` | 总是新窗口 | `window` |
 *
 * ⚠️ **绝不用 `-w 0` / `-w last`**：那是"**最近使用过的**窗口"，不是"当前窗口"。
 * 用户开着多个 WT 窗口时，标签页会落进"上次碰过的那个"——本机实测就是这么落进
 * **用户正在用的 Claude Code 窗口**里的，观感是"窗口到处乱开"。`-w cxt` 把它钉死。
 *
 * ## `new-tab` 与 `--suppressApplicationTitle` 都不能省
 *
 * - `new-tab` 必须**显式写**：不写时 wt 走自己的默认行为，而且
 *   `--suppressApplicationTitle` 只有出现在 `new-tab` **之后**才生效。
 * - `--suppressApplicationTitle` 必须紧跟 `--title`：**codex 一跑起来就用 OSC 2
 *   改写终端标题**，把 `cxt:relay-cxt · client-a` 冲成光秃秃的 `client-a`——
 *   token 名与 `cxt:` 前缀全没了，"标题必须能区分"当场失效（本机实测，§7.16）。
 *   代价是标签页不再显示 codex 的动态标题，这是**有意取舍**。
 *
 * ⚠️ **`;` 与 `,` 在 wt 的命令行里有结构含义**（分屏 / 多标签分隔符）。
 * 参数里出现它们**可能**被 wt 当成结构符而不是字面量。路径里带 `;` 罕见但合法，
 * 所以这里出 warning 而不是静默出错。（这条是从 `cmt` 带过来的怀疑，
 * 本机没有专门造过含 `;` 的路径去坐实——所以措辞是"可能"，别当成已证实的事实。）
 *
 * @param {object} input
 * @param {string} input.title     窗口标题 `cxt:<token> · <cwd 末段>`
 * @param {string} input.cwd
 * @param {string[]} input.argv    要在新标签页里跑的完整 argv（`[node, cxt.js, 'exec', <token>, …]`）
 * @param {'window' | 'tab'} [input.mode]
 * @returns {{ args: string[], via: 'direct', warnings: string[] }}
 */
export function windowsArgs({ title, cwd, argv, mode = 'tab' }) {
  /** @type {string[]} */
  const warnings = [];
  for (const a of [cwd, title, ...argv]) {
    if (/[;,`]/.test(a)) {
      warnings.push(
        `参数里有 wt 的结构符（; , \`）：${JSON.stringify(a)}——`
        + 'wt 可能把它当成分屏/标签分隔符而不是字面量。'
        + '若出现"标签页没落在预期目录 / 平白多了几个分屏"，先怀疑这里；改名该目录是最直接的规避',
      );
    }
  }

  return {
    args: [
      ...(mode === 'window' ? ['-w', 'new'] : ['-w', CXT_WINDOW_NAME]),
      'new-tab',
      '--title', title,
      // ★ 必须紧跟在 `--title` 之后、且在 `new-tab` 之后——否则 codex 的 OSC 2 会赢
      '--suppressApplicationTitle',
      '-d', cwd,
      ...argv,
    ],
    via: 'direct',
    warnings,
  };
}

/**
 * 兜底：`cmd /d /s /c start "<title>" "<script>"`。
 *
 * ⚠️ 这条是 `via: 'script'`——调用方必须**先落盘** `launch.cmd` 再 spawn（§2.12）。
 *
 * 写法理由（§7.14④）：`cmd /c` 对后面那串是"先剥首尾引号再分词"，所以带空格的
 * 脚本路径即使加了引号也会被切开。稳健形态是 `/d /s /c` + 一整条命令字符串，
 * 且**整条再包一层引号**（`/s` 的语义正是"剥掉最外层引号后原样传递"）。
 *
 * @param {object} input
 * @param {string} input.title
 * @param {string} input.scriptPath  `launch.cmd` 的绝对路径
 * @returns {{ args: string[], via: 'script', warnings: string[] }}
 */
export function windowsFallbackArgs({ title, scriptPath }) {
  /** @type {string[]} */
  const warnings = [];

  // `start` 的第一个带引号的参数**是窗口标题**——正是 §2.11 表里 `start "" <脚本>`
  // 那个空串的位置。标题是功能不是装饰（§2.11 二·1），所以填真的。
  //
  // ⚠️ 标题里含 `"` 就没救了：cmd 与 start 都没有引号内的引号转义手段。
  //    这种标题直接把引号换成 `'` 并在 warning 里说明，而不是生成一个跑不起来的命令。
  let t = title;
  if (t.includes('"')) {
    t = t.replace(/"/g, "'");
    warnings.push(`窗口标题里的双引号已替换成单引号（cmd 无法在引号内转义引号）：${JSON.stringify(title)}`);
  }
  if (scriptPath.includes('"')) {
    warnings.push(
      `launch.cmd 的路径含双引号，兜底路径无法拉起：${JSON.stringify(scriptPath)}——请把该目录改名`,
    );
  }

  return {
    args: ['/d', '/s', '/c', `"start "${t}" "${scriptPath}""`],
    via: 'script',
    warnings,
  };
}
