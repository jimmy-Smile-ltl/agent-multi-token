// @ts-check
/**
 * `cxt run [<token>]` —— 弹一个**新终端窗口**并在里面启动 codex（§2.7、§2.11、§2.12）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它是链条上的哪一环
 *
 * ```
 * cxt run                       ← 这里：算出 argv，弹窗口
 *   └─ 新窗口里跑：<node> <cxt> exec <token> [--model <id>] [--cwd <dir>] [-c]
 *                              └────────────────────────────────────────┘
 *                                   exec 再注入环境、定位 codex、交接
 * ```
 *
 * ★ **run 不直接启动 codex**，它启动的是**另一个 cxt**（`cxt exec`）。
 * 这不是绕路，而是 §2.7 那条设计成立的前提：**launch 脚本里不内联 token**——
 * 密钥只在 `tokens/<name>.json` 有一个落盘点，新窗口里的 `exec`
 * 自己从配置读出来注入进程环境。代价是 run 必须把"我解析出的结论"
 * 用**命令行参数**完整地转述给 exec，漏一个就会静默走偏（见 `buildExecArgs`）。
 *
 * ## 与 `cxt exec` 的三处差别
 *
 * | | `cxt run` | `cxt exec` |
 * |---|---|---|
 * | 在哪跑 | 新终端窗口 | 当前终端 |
 * | cwd | `--cwd` → `token.cwd` → 当前目录 | 只用 `--cwd` 或进程 pwd（跳过 `token.cwd`） |
 * | 谁启动 codex | 新窗口里的 `cxt exec` | 它自己 |
 *
 * ## 无状态
 *
 * run **不记忆任何选择**（§2.5 规则 2）：不写"上次用了哪个 token"，
 * 不写"上次用了哪个模型"。`--pick` 挑完也只影响这一次的 argv。
 * ─────────────────────────────────────────────────────────────
 */

import nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CxtError, EXIT } from '../../core/errors.js';
import { buildCxtCommandLine, buildLaunchScript } from '../../core/launch-script.js';
import { launchScriptPath, profileDir } from '../../core/paths.js';
import { SOURCE, stripSessionMarkers } from '../../core/resolve.js';
import { ensureDir, writeProfileConfig, writeTextAtomic } from '../../core/store.js';
import { spawnTerminal } from '../../platform/spawn-terminal.js';
import { resolveHostTerminal } from '../../platform/index.js';
import { buildTitle } from '../../platform/resolve-terminal.js';
import { makePainter, maskEnv, maskValue, table } from '../format.js';
import { promptChoice } from '../pick.js';
import { pickFromPool } from '../pool-pick.js';
import { injectionFor, managedRegionDiff, resolveSession, toResolveArgv } from '../session.js';

/**
 * `bin/cxt.js` 的绝对路径。
 *
 * ★ 三层 `..`：`src/cli/commands/` → `src/cli/` → `src/` → 仓库根。
 * 数错一层会得到一个**存在但不执行**的路径（`src/bin/cxt.js`），
 * 而症状是"新窗口闪一下就没了"——所以下面 `assertCxtEntryExists()` 兜一道。
 */
const CXT_ENTRY = fileURLToPath(new URL('../../../bin/cxt.js', import.meta.url));

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'print', 'resume', 'pick', 'pool', 'window', 'tab'],
  string: ['cwd', 'token', 'token-value', 'url', 'model'],
  alias: { h: 'help', t: 'token', m: 'model', c: 'resume' },
};

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
export async function run(args, ctx) {
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const argv = toResolveArgv(args, args._);
  const plan = await planLaunch(argv, ctx, { pick: args.pick === true });

  // ── `--print`：只打印不启动（§5，"排查首选"）──
  if (args.print === true) {
    process.stdout.write(renderPlan(plan));
    return EXIT.OK;
  }

  const { pid } = await startLaunch(plan);

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  // ★ 有具名窗口就说名字（今天只有 Windows 的 tab 模式）——用户最想知道的是
  //   "标签页开到哪去了"。没名字的平台（macOS / Linux 的"往当前窗口加"）就不说，
  //   硬写一个名字是假话（§2.11 二·1）。
  const where = plan.terminal.windowName === undefined
    ? `${c.bold(plan.terminal.terminal)} 中`
    : `${c.bold(`${plan.terminal.windowName} 窗口`)}的新标签页`;
  process.stderr.write(
    `${c.green('✓')} 已在 ${where}启动 ${c.cyan(plan.title)}`
    + `${pid === undefined ? '' : c.dim(`  (pid ${pid})`)}\n`,
  );
  if (plan.terminal.via === 'script') {
    process.stderr.write(`${c.dim(`     兜底脚本：${plan.scriptPath}`)}\n`);
  }
  for (const w of plan.terminal.warnings) process.stderr.write(`${c.yellow('⚠')} ${w}\n`);

  return EXIT.OK;
}

// ───────────────────────── ★ 规划 / 启动：两半分开 ─────────────────────────

/**
 * ★★ **把"这一次要启动什么"算清楚，但一个副作用都不产生。**
 *
 * 拆出这一层的理由是**面板**（§2.14）：`cxt ui` 的 Enter 键要做的事，
 * 与 `cxt run` 逐字相同——同一份级联、同一份 `execArgs`、同一个终端解析。
 * 让面板去调 `runCmd.run()` 不行（它往 stderr 写回执，那行字会横穿备用屏
 * 砸在某一帧上）；让面板 `spawn('cxt', ['run', ...])` 更不行——那是**第三处**
 * 拼 argv 的地方，而"两处各拼一遍"正是 `buildExecArgs` 开头记着的那两个 bug
 * 的成因。所以：**拼 argv 的地方只能有一处，就是这里。**
 *
 * 名字叫 plan 而不是 resolve，是因为它比解析多做了三件事：
 * ① 缺项检查（`resolve` 是**故意**不抛的，它要能打印"缺哪一项"）；
 * ② `--pick` 的交互；
 * ③ 终端解析 + 两个守卫（`assertCxtEntryExists` / `assertNoSecretInScript`）。
 *
 * ⚠️ **守卫必须在这里，不能在 `startLaunch` 里**：`--print` 走的是
 * "plan 完就打印、根本不 start"那条路，而 `--print` 的全部意义是
 * **跑之前先看见**。守卫挪到 start 里，`--print` 就会展示一个注定失败的方案——
 * 骗的正是最需要它的那个场景。
 *
 * @param {any} argv `toResolveArgv()` 的产物
 * @param {import('../types.js').Ctx} ctx
 * @param {{ pick?: boolean, path?: string, quiet?: boolean }} [opts]
 *   `pick`：交互挑一个模型（仅本次生效，不落盘）。
 *   `path`：**"我站在哪个目录"**——面板启动一条绑定时传绑定路径，
 *   让绑定匹配与项目本地配置的发现都按那个目录算（§2.13 一）。
 *   ⚠️ 它**不是** `argv.cwd`：`--cwd` 会被当成 CLI 层显式声明（`SOURCE.CLI`），
 *   而面板点一下不是用户敲的 flag。
 *   `quiet`：不打进度行（面板用——备用屏上写 stderr 会横穿某一帧）。
 * @returns {Promise<LaunchPlan>}
 */
export async function planLaunch(argv, ctx, opts = {}) {
  let resolved = resolveSession(ctx, argv, 'run', { path: opts.path });

  // ── ★ token 池（§2.15 三）：**先**把 token 这一格填上，再做缺项检查 ──
  // 顺序不能反：没有 token 的时候，else 分支会立刻报"四要素缺 token"，
  // 而池存在的意义正是"让这一次不缺"。挑选只在两种情况下发生
  // （补空位 / `--pool`），判断全在 `pickFromPool()` 里。
  const picked = await pickFromPool(ctx, resolved, argv, {
    path: opts.path,
    notify: opts.quiet === true ? undefined : (line) => process.stderr.write(`  ${line}\n`),
  });
  if (picked !== null) resolved = picked.resolved;

  if (resolved.missing.length > 0) {
    throw new CxtError(`四要素不齐全，缺少：${resolved.missing.join('、')}`, {
      hint: '用 `cxt resolve` 看每项的来源层与补法；用 `cxt run --print` 只看不跑',
    });
  }

  // ── `--pick`：交互挑一个，**仅本次生效、绝不落盘**（§2.5）──
  const pickedId = opts.pick === true ? await pickModelId(resolved, ctx) : null;

  return planFrom({ resolved, argv, ctx, pickedId, poolNote: picked?.note ?? null });
}

/**
 * `planLaunch()` 的后半段：从已解析的会话算出全部执行细节。
 *
 * 单独拆出来是因为 `--pick` 必须**先**解析、**后**交互、**再**拼 argv——
 * 而 `--pick` 自己需要 `resolved`。把顺序写成一个函数的形状，
 * 就不存在"哪里再解析一遍"的余地了。
 *
 * @param {{ resolved: any, argv: any, ctx: import('../types.js').Ctx, pickedId: string | null,
 *   poolNote: string | null }} input
 * @returns {LaunchPlan}
 */
function planFrom({ resolved, argv, ctx, pickedId, poolNote }) {
  const execArgs = buildExecArgs(resolved, argv, pickedId);
  // ★★ 命令行整条从 `buildCxtCommandLine()` 取——node 解释器与 `exec` 关键字都由它补。
  //   这两个都曾经在这里漏掉过，而症状**只显示在那个新窗口里**（外面看起来一切正常）：
  //     漏 `exec` → 窗口一闪而过（里面跑的是 `cxt relay-a`，dispatch 报"未知命令"）
  //     漏 node   → 窗口弹出来，第一行是 `0x800700C1`——`cxt.js` 是脚本不是 exe
  //   而兜底脚本那条路一直是对的（它自己补了这两样），于是症状是"脚本能跑、直连不能跑"。
  //   ⇒ 别再在这里手拼：两处各拼一遍正是这两个 bug 的成因。
  const cxtArgs = buildCxtCommandLine({ nodePath: process.execPath, cxtPath: CXT_ENTRY, execArgs });

  const diff = managedRegionDiff(ctx, resolved);
  const injection = injectionFor(resolved, ctx);
  const cwd = typeof resolved.cwd.value === 'string' && resolved.cwd.value !== ''
    ? resolved.cwd.value
    : ctx.cwd;
  const mode = resolved.terminalMode.value === 'window' ? 'window' : 'tab';
  const title = buildTitle(resolved.token.value ?? 'default', cwd, ctx.platform);

  const scriptPath = launchScriptPath(ctx.home, resolved.profileName, ctx.platform);
  const terminal = resolveHostTerminal(
    { title, cwd, argv: cxtArgs, mode },
    { scriptPath, platform: ctx.platform, env: ctx.env },
  );

  // ── 能拦的先拦，**在 `--print` 之前** ──
  // `--print` 的全部意义是"跑之前先看见"。如果它展示了一个注定会失败的方案，
  // 那它就是在骗人——而且骗的正是最需要它的那个场景（出了问题时去看）。
  assertCxtEntryExists();
  if (terminal.via === 'script') assertNoSecretInScript(execArgs, scriptPath);

  return {
    resolved, argv, ctx, execArgs, cxtArgs, diff, injection, cwd, mode, title, scriptPath, terminal, poolNote,
  };
}

/**
 * ★ **执行一个 plan**（§2.7 第 3 步 + §2.12）。
 *
 * 与 `planLaunch()` 的分界线就是**副作用**：这里做四件会改变世界的事——
 * 建 profile 目录、写受管区、落盘兜底脚本、spawn 终端。
 *
 * ⚠️ 顺序不可换：兜底脚本必须在 `spawnTerminal()` **之前**落盘，
 * 因为终端进程一起来就会去读它（`cmd /c start "标题" "脚本"` 那一步没有重试）。
 *
 * ⚠️ `writeProfileConfig` 必须把 `diff.current` 传进去——它靠这个拒绝让
 * `[projects.*]` 变少（§2.9 最后一道保险：拼接器不许吃掉用户的信任记录）。
 *
 * @param {LaunchPlan} plan
 * @returns {Promise<{ pid?: number }>} `spawnTerminal()` 的产物
 */
export async function startLaunch(plan) {
  const { resolved, execArgs, scriptPath, terminal, diff, ctx } = plan;

  // ── 让 profile 就绪（§2.7 第 3 步）──
  // 新窗口里的 exec 也会做一遍，但在这里做有两个好处：报错发生在前台
  // （用户看得见），以及兜底脚本落在**已存在**的目录里。
  ensureDir(profileDir(ctx.home, resolved.profileName));
  if (diff.changed) writeProfileConfig(ctx.home, resolved.profileName, diff.next, diff.current);

  // ── 兜底路径：先落盘 launch 脚本，再 spawn（§2.12）──
  if (terminal.via === 'script') writeLaunchScript({ resolved, execArgs, scriptPath, ctx });

  return spawnTerminal(terminal, stripSessionMarkers(ctx.env));
}

/**
 * `planLaunch()` 的产物。
 *
 * 带上 `ctx` 而不是让 `startLaunch(plan, ctx)` 收两个参数：两者**必须**是同一个
 * ctx（`plan` 里的路径、标题、profile 全是用它算出来的），传两个就等于留了
 * "拿 A 的 plan 配 B 的 home"这条静默错路。
 *
 * @typedef {object} LaunchPlan
 * @property {any} resolved
 * @property {any} argv
 * @property {import('../types.js').Ctx} ctx
 * @property {string[]} execArgs 交给新窗口里 `cxt exec` 的参数
 * @property {string[]} cxtArgs 整条命令行（含 node 与 `exec`）
 * @property {any} diff 受管区漂移
 * @property {any} injection 注入清单（**未求值**——`evaluate: false`）
 * @property {string} cwd
 * @property {'window' | 'tab'} mode
 * @property {string} title
 * @property {string} scriptPath
 * @property {any} terminal `resolveHostTerminal()` 的产物
 * @property {string | null} poolNote 池挑 token 时的一句话（没挑就是 `null`）
 */

// ───────────────────────────── execArgs：把结论转述给新窗口 ─────────────────────────────

/**
 * ★ **这个函数是 `cxt run` 最容易出错的地方，所以它的规则要写死。**
 *
 * 新窗口里跑的是 `cxt exec`，它会**从头再解析一遍**四要素。于是有一个必须
 * 想清楚的问题：**哪些东西要显式传过去，哪些让它自己算？**
 *
 * 判据只有一条：**exec 在新窗口里重算，能不能得到同一个答案？**
 *
 * | 项 | 传吗 | 为什么 |
 * |----|------|--------|
 * | token 名 | ✅ **总是**（有的话） | 绑定是**按目录**匹配的，而新窗口的 cwd 是 run 算出来的（可能来自 `token.cwd`）。不显式传，绑定表在另一个目录上会匹配出**另一个 token** |
 * | `--model` | ✅ 仅当用户明说（含 `--pick` 的结果） | 配置里的模型 exec 自己会算出来，重复传反而会把它钉死在"CLI 来源"上 |
 * | `--url` / `--token-value` | ✅ 仅当用户明说 | 这两个是**临时覆盖**，配置里没有，不传就丢了 |
 * | `--cwd` | ✅ **总是** | 见下 |
 * | `-c` | ✅ 仅当用户明说 | 同上 |
 * | `--` 透传的 codex 参数 | ✅ **只传用户 `--` 之后那几个** | ⚠️ 不能传 `resolved.codexArgs`——那是 defaults + token + CLI **合并后**的结果，exec 会再合并一次 defaults 和 token，于是**每个参数出现两遍** |
 *
 * ### 为什么 `--cwd` 总是传（这里与 §2.12 的旧说法相反）
 *
 * §2.12 原文说"`run` 那条路径不需要 `-C`——终端的 cwd 参数已经把目录设好了"。
 * 但 §7.14⑤ 实测：Windows 的 `cmd /c start` 兜底路径**会丢 cwd**。
 * 而 cwd 传错不只是"目录不对"——§7.6 的 `resume --last` 是**按 cwd 作用域**的，
 * 传错 = 静默续上别的目录的会话，用户毫无察觉。
 *
 * 所以 run **总是**把算出来的 cwd 显式交给 exec，让它走 `--cwd` 那条路
 * 给 codex 补 `-C`。`-C` 是**不依赖终端**的那条信道：终端把 cwd 设对了它是空操作，
 * 终端没设对它是唯一的补救。代价是它要过一次 cmd shim（§7.14⑥），
 * 路径含 `%` 时 exec 会打警告——那是可见的代价，比静默续错会话好。
 *
 * @param {any} resolved
 * @param {any} argv `toResolveArgv()` 的产物
 * @param {string | null} pickedId `--pick` 挑中的模型 id
 * @returns {string[]} 交给 `cxt exec` 的参数（**不含** `exec` 这个关键字本身）
 */
export function buildExecArgs(resolved, argv, pickedId) {
  /** @type {string[]} */
  const out = [];

  if (resolved.token.value !== null) out.push(resolved.token.value);

  const modelId = pickedId ?? (typeof argv.model === 'string' ? argv.model : null);
  if (modelId !== null) out.push('--model', modelId);

  if (typeof argv.url === 'string') out.push('--url', argv.url);
  if (typeof argv.tokenValue === 'string') out.push('--token-value', argv.tokenValue);

  if (typeof resolved.cwd.value === 'string' && resolved.cwd.value !== '') {
    out.push('--cwd', resolved.cwd.value);
  }

  if (resolved.resume === true) out.push('-c');

  // ★ 只传**用户 `--` 之后**的那几个（`argv.extraArgs`），
  //   不是 `resolved.codexArgs.value`——后者已含 defaults + token，会重复（见上表）
  if (Array.isArray(argv.extraArgs) && argv.extraArgs.length > 0) {
    out.push('--', ...argv.extraArgs);
  }

  return out;
}

// ───────────────────────────── 各种守卫 ─────────────────────────────

/**
 * ★ 打印 argv 时按**参数名**打码（§5）。
 *
 * 环境变量那套打码（`maskEnv`）按**键名**判断，而 argv 里的密钥是**另一个元素**：
 * `['relay-a', '--token-value', 'sk-xxx']`——没有键值对可查，得知道
 * `--token-value` 后面跟的是值。
 *
 * ⚠️ 别把它写成"凡是长得像密钥的就打码"：那会在参数名上误判，
 * 而且 §5 的规则本来就是**按名**而不是按形。
 *
 * @param {string[]} argv
 * @returns {string[]}
 */
export function maskArgv(argv) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    out.push(argv[i]);
    // 只看 `--token-value`：这是 `exec` 上唯一接收密钥的选项。
    // 新增这类选项时**必须回来加一条**——这是本模块唯一一处"按名单维护"的地方。
    if (argv[i] === '--token-value' && i + 1 < argv.length) {
      out.push(maskValue(argv[++i]));
    }
  }
  return out;
}

/** `bin/cxt.js` 不在就早报——否则症状是"新窗口闪一下就没了"，极难查 */
function assertCxtEntryExists() {
  if (!nodeFs.existsSync(CXT_ENTRY)) {
    throw new CxtError(`cxt 入口不存在：${CXT_ENTRY}`, {
      hint: '这是安装被移动/删除的信号。重装：`npm i -g .`（在本仓库根目录）',
    });
  }
}

/**
 * ★ 契约 4（§2.12）：**脚本里绝不出现密钥**。
 *
 * `--token-value` 是唯一能走到这里的密钥——它是个**临时覆盖**，
 * 配置里没有，所以必须经命令行转述。直接拉起那条路上它只活在进程 argv 里
 * （短暂、不落盘）；但兜底路径会把它**写进 `profiles/<t>/launch.cmd`**，
 * 那是个会被复制、被备份、被贴进 issue 的文件。
 *
 * 所以这里**拒绝**而不是"写进去再警告"：拒绝是安全的默认，
 * 而用户有两条明确的出路（见 hint）。
 *
 * @param {string[]} execArgs
 * @param {string} scriptPath
 */
function assertNoSecretInScript(execArgs, scriptPath) {
  const i = execArgs.indexOf('--token-value');
  if (i === -1) return;
  throw new CxtError('兜底脚本路径下不能用 `--token-value`：密钥会被写进脚本文件', {
    hint: `脚本 ${scriptPath} 会被复制/备份/贴进 issue，所以 cxt 拒绝往里写密钥。`
      + '两个出路：① 把凭证落到配置里（`cxt token edit <name> --token <v>`），'
      + '这样脚本里只有**名字**；② 改用 `cxt exec` 在**当前**终端跑（不生成脚本）',
  });
}

/**
 * 落盘兜底脚本（§2.12）。
 *
 * ★ 内容来自**同一个 `execArgs`**——脚本是"直接拉起"那条路的忠实序列化，
 * 不是另拼一份。这条纪律由 `buildLaunchScript({ execArgs })` 的接口形状保证：
 * 它压根不接收 token / model / 附加参数这些语义字段，没有第二个拼 argv 的地方。
 *
 * @param {{ resolved: any, execArgs: string[], scriptPath: string, ctx: import('../types.js').Ctx }} input
 */
function writeLaunchScript({ resolved, execArgs, scriptPath, ctx }) {
  const { fileName, text, needsChmod } = buildLaunchScript({
    nodePath: process.execPath,
    cxtPath: CXT_ENTRY,
    execArgs,
    // ★ 契约 2：只有兜底路径才写 `cd`——cwd 本该由终端的 cwd 参数传，
    //   而这条路径恰恰是"终端没有 cwd 选项 / 只吃命令串"的那两种（§2.12 ①②）
    cwd: typeof resolved.cwd.value === 'string' ? resolved.cwd.value : null,
    platform: ctx.platform,
  });

  ensureDir(profileDir(ctx.home, resolved.profileName));
  writeTextAtomic(scriptPath, text);

  if (needsChmod) {
    // ⚠️ Windows 上 `chmod` 基本是空操作（§2.11 五）——**别假装设了权限**。
    //    这段只在 `.sh` 分支（POSIX）上跑，所以是真的设上了。
    nodeFs.chmodSync(scriptPath, 0o755);
  }
  return fileName;
}

/** `--pick`：从当前生效的列表里挑一个，返回 id */
async function pickModelId(resolved, ctx) {
  const models = Array.isArray(resolved.models.value) ? resolved.models.value : [];
  if (models.length === 0) {
    throw new CxtError('没有可挑的模型：当前生效的列表是空的', {
      hint: '先声明候选：`cxt model set <id>[:label] ...`（顺序即优先级）',
    });
  }
  const idx = await promptChoice({ models, ctx, what: '挑一个模型（仅本次生效，不落盘）' });
  return models[idx].id;
}

// ───────────────────────────── `--print` ─────────────────────────────

/**
 * @param {any} p
 * @returns {string}
 */
function renderPlan(p) {
  const { resolved, diff, injection, terminal, cxtArgs, cwd, title, mode, scriptPath, ctx, poolNote } = p;
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  /** @type {string[]} */
  const out = [''];

  out.push(`  ${c.bold('cxt run --print')}  ${c.dim('—')} 只打印，不启动`);
  out.push('');

  // ── 终端 ──
  // ★ 把"标签页落到哪个窗口"写进这一行：`-w last` 那个 bug 的观感就是
  //   "标签页不知道跑哪去了"，而 `--print` 是排查它的第一现场（§7.16）。
  const where = terminal.windowName === undefined ? mode : `${mode} → ${terminal.windowName} 窗口`;
  out.push(`  ${c.bold('将要执行')} ${c.dim(`（${terminal.terminal}，via ${terminal.via}，${where}）`)}`);
  // ★ 这一行**也要打码**：终端 args 里嵌着同一份 cxt argv，
  //   漏了这一处，密钥就从"看起来最像命令行的那一行"漏出去了
  //   （`--print` 里有两行都含 argv，只打码一行等于没打）
  out.push(`    ${terminal.command} ${maskArgv(terminal.args).join(' ')}`);
  if (terminal.via === 'script') {
    out.push(`    ${c.dim(`（终端只吃命令串 → 会先落盘 ${scriptPath}）`)}`);
  }
  out.push('');

  // ── 新窗口里那个 cxt 会收到的参数 ──
  out.push(`  ${c.bold('新窗口里的 cxt exec')}`);
  out.push(`    ${c.dim('（run 把解析结论转述给它——漏一项就会静默走偏，见 buildExecArgs）')}`);
  out.push(`    ${maskArgv(cxtArgs).join(' ')}`);
  out.push('');

  // ── token 池（§2.15 三）──
  // ★ 只在**真挑了**的时候才印：没挑的时候多一行永远不变的文字，
  //   只会让 `--print` 更难扫。而挑了的时候，这一行是"为什么这次是这个 token"
  //   的唯一现场——`execArgs` 里只有一个裸名字，看不出它从哪来。
  if (resolved.token?.source === SOURCE.POOL) {
    out.push(`  ${c.bold('token')} ${c.cyan(resolved.token.value)} ${c.dim('（来源：token 池——启动前挑一次，整个会话钉死）')}`);
    if (poolNote !== null) out.push(`    ${c.dim(poolNote)}`);
    out.push('');
  }

  // ── 环境 ──
  out.push(`  ${c.bold('注入的环境')}${c.dim('（按名打码，§5）')}`);
  const masked = maskEnv(
    Object.fromEntries(Object.entries(injection.env)
      .filter(([k]) => k === 'CODEX_HOME' || k === resolved.envKeyName)),
  );
  out.push(table(['变量', '值'], Object.entries(masked)));
  // ★ 新标签页的环境**不是** cxt 的环境（§2.6 头号不变量）：会话标记在
  //   `spawnTerminal` 那一步就被剔掉了。从 codex 会话里跑 `cxt run` 的人，
  //   这一行就是他"新窗口会不会带着父会话身份"这个问题的答案。
  out.push(`  ${c.dim('新标签页的环境 = 当前环境剔掉会话标记（§2.6）。'
    + '上面这些注入项**不在**标签页的环境里——由窗口内的 cxt exec 现算（§2.7）')}`);
  out.push('');

  // ── cwd ──
  out.push(`  ${c.bold('工作目录')}  ${title}`);
  out.push(`    ${cwd}`);
  out.push(`    ${c.dim('同时经 --cwd 转述给 exec，让它给 codex 补 -C——'
    + '终端丢 cwd 时（§7.14⑤）那是唯一的补救')}`);
  out.push('');

  // ── 受管区 ──
  out.push(`  ${c.bold('受管区')} ${c.dim(`profiles/${resolved.profileName}/config.toml`)}`);
  if (diff.report.created) out.push(`  ${c.dim('（尚未创建；本次会写入）')}`);
  else if (diff.changed) out.push(`  ${c.yellow('⚠ 与当前文件不一致（漂移）——本次会就地修正')}`);
  else out.push(`  ${c.green('✓ 与当前文件一致（幂等）')}`);
  out.push('');

  return out.join('\n');
}

const HELP = `cxt run [<token>] [选项]

弹一个**新终端窗口**，在里面用指定的 token 启动 codex。
不给 token 就是按当前目录匹配绑定（这就是"不同路径不同 token"的入口）。

★ run 自己不启动 codex：它弹的窗口里跑的是 \`cxt exec\`，
  由 exec 读配置、注入环境。所以密钥不会出现在任何脚本里（§2.7）。

  <token>                token 的**名字**（不是密钥）
  --cwd <path>           新窗口落在哪个目录（默认：命中 token 的 cwd → 当前目录）
  --model <id>           覆盖模型（仅本次生效，不落盘）
  --pick                 从当前生效的模型列表里交互挑一个（仅本次生效，不落盘）
  --pool                 无视绑定/配置，从 **token 池**里挑一个（§2.15 三）
                         ★ 不给这个旗标时，只有"一个 token 都解析不出来"才会自动
                           由池补空位；给了它，绑定也会被盖掉（仅本次启动）
  --token-value <v>      直接给密钥（★ 兜底脚本路径下会被拒绝——脚本不能含密钥）
  --url <u>              覆盖 baseUrl
  -c, --resume           让新窗口里的 codex 续该目录最近一次会话（resume --last）
  --window / --tab       新窗口 / 新标签页（默认看 defaults.terminalMode，内置 tab）
                         ★ tab 是开在**名为 cxt 的那个窗口**里（没有就建一个，
                           关掉了下次自动重建）；不是"最近用过的窗口"（§7.16）
  --print                只打印将要执行的完整命令与环境，不启动
  -h, --help             本帮助

⚠️ 别把 -c 写成 -p：Codex 的 -p 是 --profile（选配置档），不是"继续"。
`;

export const command = { spec, run };
