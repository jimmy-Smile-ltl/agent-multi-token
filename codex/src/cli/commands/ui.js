// @ts-check
/**
 * `cxt ui` —— 交互面板（§2.14）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它是链条上的哪一环
 *
 * ```
 *   keys.js ──按键──┐
 *                   ├──▶ ui/app.js（纯 reducer）──effects──▶ **本文件** ──▶ fs / fetch / spawn
 *   本文件 ──结果────┘                                                      │
 * ```
 *
 * `ui/` 那四个文件一个副作用都没有（`app.test.js` 有一条断言钉着：整层
 * 不 import `node:`、不碰 `process`、不发请求）。**所有会改变世界的事都在这里**，
 * 而 reducer 只负责说"该做什么"（`effects` 是**数据**，不是 thunk）。
 *
 * 这样切的好处很具体：「面板会不会在某个按键上卡死」「向导第 3 步失败之后
 * 还能不能退出去」这类问题，全都能在纯函数层面穷举——**不需要 TTY、不需要网络**。
 *
 * ## ★ 启动那一步**不自己拼 argv**
 *
 * 面板的 Enter 与 `cxt run` 必须逐字相同，所以它调的是
 * `run.js` 的 `planLaunch()` + `startLaunch()`——**同一份级联、同一份
 * `execArgs`、同一个终端解析**。三条被否掉的路，理由都在 `planLaunch()` 的注释里：
 *
 * | 做法 | 为什么不行 |
 * |---|---|
 * | 调 `runCmd.run()` | 它往 stderr 写回执，那行字会横穿备用屏砸在某一帧上 |
 * | `spawn('cxt', ['run', ...])` | 那是**第三处**拼 argv 的地方 |
 * | 在这儿重算一遍 | 同上 |
 *
 * ## ★ 三条前端，一个状态机
 *
 * | 入口 | 条件 | 前端 |
 * |---|---|---|
 * | 裸 `cxt` | stdin+stdout 都是 TTY | **网页控制台**（`serve-web.js` + `src/web/`） |
 * | 裸 `cxt` | 否则 | 打印用法、退出 0（**与 CXT_UI 无关**，脚本不受影响） |
 * | `cxt ui` | `CXT_UI=web` 或 `--web` | 网页控制台（**不看 TTY**——它不需要终端） |
 * | `cxt ui` | `CXT_UI=plain` | 逐行输出（`runPlain()`） |
 * | `cxt ui` | 非 TTY | 报错退出 1（§6.2：宁可明确，不要静默） |
 * | `cxt ui` | 否则 | 全屏面板（`ui/term.js`） |
 *
 * 三条前端**共用同一个 reducer**，而且 plain 模式连**排版**都是
 * `render.js` 出的（`renderLines()`），只是把 ANSI 抹掉、把页脚换成
 * 逐行模式的那句提示。理由是 `CXT_UI=plain` 的全部意义是
 * **"备用屏坏了的时候，我还能看见同一份内容"**（§2.14 七）——
 * 内容不一样的话它就不是逃生舱，是另一个程序。
 *
 * ★ 网页控制台与全屏面板共用的是**更里面**的那一层：同一个 `buildPanelData()`、
 *   同一个 `makeSession()`（reducer + 执行器 + "跑到静止"那个循环）。
 *   只有呈现换了。细节在 `ui-web.js` 的文件头。
 * ─────────────────────────────────────────────────────────────
 */

import { existsSync, readdirSync } from 'node:fs';

import { findExactBinding } from '../../core/bindings.js';
import { CxtError, EXIT } from '../../core/errors.js';
import { PROJECT_CONFIG_FILENAME, profileDir, projectsPath, sessionInboxDir } from '../../core/paths.js';
import { STATUS, statusLabel, summarizePool } from '../../core/pool.js';
import { costOf, priceFor } from '../../core/prices.js';
import { statusFor } from '../../core/project-state.js';
import { modelsFor, modelOptionsFor, withFetchedModels } from '../../core/resources.js';
import { normalizeBinding, normalizeToken, validateTokenName, CONFIG_VERSION } from '../../core/schema.js';
import {
  listSessionMessages, readPool, readProjectConfig, readProjectState, readResources,
  readSessionMessage, readToken, writeResources,
} from '../../core/store.js';
import { fetchModels } from '../../platform/index.js';
import { resolveUserPath } from '../arg-path.js';
import { describeSecret } from '../format.js';
import { parseChoice } from '../pick.js';
import { autoSyncUsage } from '../pool-usage.js';
import { loadPriceTable } from '../price-table.js';
import { initialState as appInitial, reduce } from '../ui/app.js';
import { footerHint, layout, render, renderLines, visibleModels } from '../ui/render.js';
import { runPanel } from '../ui/term.js';
import { ensureRoot, mutateConfig, mutateToken, putToken } from '../state-edit.js';
import { loadState, resolveSession } from '../session.js';
import { listSessions } from '../sessions.js';
import { pickLayer, saveProjectAt, writeLayer } from './model.js';
import { planLaunch, startLaunch } from './run.js';
// ★ 与 `ui-web.js` 是一个**兄弟环**：它 import 本文件的 `buildPanelData` /
//   `makeSession`，本文件 import 它的 `runWeb`。这是安全的，而且**只**因为
//   那几个符号全是**函数声明**（会提升、在模块体跑之前就初始化好了），
//   而且两边**都没有**在顶层调用对方。往任一边加一句顶层调用就会炸成 TDZ。
//   ⚠️ 真要拆的话，把 `buildPanelData`/`makeSession` 提成第三个文件——
//   但那比"加一个入口"大得多，而这个环今天不欠任何债。
import { runWeb } from './ui-web.js';

/** @type {import('../types.js').Command['spec']} */
const spec = {
  // ⚠️ 这里**不该**声明 `--config`：它是全局 flag，`main.js` 的
  //    `extractGlobalConfig()` 在 dispatch 之前就把它抽走了（§2.13 一），
  //    再声明一遍等于第二处真相。
  boolean: ['help', 'web', 'no-open'],
  string: [],
  alias: { h: 'help' },
};

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @returns {Promise<number>} 退出码
 */
export async function run(args, ctx) {
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  // ★★ 网页控制台（§2.14 十）。两条入口是**同一个意思**：
  //    `cxt ui --web` 与 `CXT_UI=web`。
  //
  // ★ 它**绕过 TTY 闸门**——这正是它能当 e2e 钩子的原因（同 `CXT_UI=plain`
  //    在 §2.14 七③ 的角色）：控制台不需要终端，stdin 是管道照样起得来。
  //    下面那条"非 TTY 不许进全屏面板"一个字都没变。
  //
  // ⚠️ 顺序：排在 `plain` **前面**。两个变量同时设（`CXT_UI=web CXT_UI=plain`
  //    是不可能的，但 `--web` 配 `CXT_UI=plain` 完全可能）时，
  //    **命令行上那个显式的旗标赢**——这是"越具体越优先"。
  if (args.web === true || ctx.env.CXT_UI === 'web') {
    return await runWeb(ctx, { open: args['no-open'] !== true });
  }

  // ★ `CXT_UI=plain` 走逐行前端。**非 TTY 也允许**——它是给管道和 CI 用的
  //   （也正是 e2e 唯一跑得起来的那条路，§2.14 七③）。
  if (ctx.env.CXT_UI === 'plain') return await runPlain(ctx);

  if (ctx.stdinIsTTY !== true || ctx.isTTY !== true) {
    throw new CxtError('面板需要终端（stdin 与 stdout 都得是 TTY）', {
      hint: '非交互环境用 `CXT_UI=plain cxt ui`（逐行输出、不进备用屏）；'
        + '只想看解析结果用 `cxt resolve`，想启动用 `cxt run`',
    });
  }

  // ★ 打开面板顺手重算一次用量（按 `pool.usageSeconds` 的新鲜期，过期的才真的动）。
  //   放在**这里**、**不放进 `buildPanelData()`**——那个函数是"取数"，每敲一个键
  //   走 `reloaded` 都会再调它一次；把写盘埋在里面，等于让一次查询顺手改一次文件。
  //   启动时做一次就够，面板里的「重算用量」按钮是随时可用的手动出口。
  //   ★ 它**永不抛**（`autoSyncUsage()` 自己保证）：一个不可写的目录只该让这次的
  //     数字旧着，不该让面板打不开——那是别的事的锅，别在这儿连坐。
  autoSyncUsage(ctx);

  const code = await runPanel({
    stdin: process.stdin,
    stdout: process.stdout,
    // ★ 环境变量的**名字**在这一层解析，`ui/term.js` 只收值（§4.1：四个内核文件逐字一致，
    //   里面不许出现 `CXT_UI_COLS` 这种工具专有的名字）。原样传字符串——
    //   `0` 与"没设"的区别由内核的 `pickInt()` 判，这里先 `Number()` 掉就把它抹平了。
    sizeOverride: { cols: ctx.env.CXT_UI_COLS, rows: ctx.env.CXT_UI_ROWS },
    initial: appInitial(buildPanelData(ctx)),
    reduce,
    render,
    exec: makeExecutor(ctx),
  });
  // `runPanel` 只回两种码：0 正常退出 / 2 拿不到 raw mode（那是环境问题，§6.2）
  return code === 0 ? EXIT.OK : EXIT.ENV;
}

// ═══════════════════════════ 左栏：可启动项 ═══════════════════════════

/**
 * 一行的**用量与花费**（§2.15 九 9.3）。
 *
 * 输入是 `pool.json` 里那条 entry 的 `models` 明细 + 价格表：逐模型 `costOf()` 后相加。
 * 为什么按模型算而不是拿聚合的 `in`/`out` 乘一个价：一条 entry 底下常常是好几个模型、
 * 各不相同价，聚合数乘任何单一价都是编的。
 *
 * 三条容易写错的口径：
 * - 一个模型都查不到价 ⇒ `cost: null`（渲染 `—`）。**不是 0**——`$0` 会说"免费"。
 * - `unpriced` 数的是**模型个数**，不是 token 数：它要回答的是"有几个模型没价"，
 *   好让人知道去 `prices.json` 里补几条。
 * - `entries` 里没有这个名字（没入池）也给一份全零——**六个键恒定**，前端按"键一定在"写。
 *
 * @param {import('../../core/pool.js').PoolEntry | undefined} entry
 * @param {import('../../core/prices.js').PriceTable} table
 * @returns {import('../../core/pool.js').RowUsage}
 */
function rowUsage(entry, table) {
  /** @type {import('../../core/pool.js').RowUsage} */
  const out = { calls: 0, in: 0, out: 0, cost: null, unpriced: 0, syncedAt: '' };
  if (entry === null || typeof entry !== 'object') return out;

  // `readPool()` 已经归一过（`normalizeEntry`），这里再兜一层：`buildPanelData`
  // 也吃测试里手搓的对象，而"NaN 流进视图模型"在 JSON 里会静默变成 `null`。
  const n = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  out.calls = n(entry.calls);
  out.in = n(entry.in);
  out.out = n(entry.out);
  out.syncedAt = typeof entry.usageAt === 'string' ? entry.usageAt : '';

  let priced = 0;
  let cost = 0;
  let unpriced = 0;
  for (const [id, tokens] of Object.entries(entry.models ?? {})) {
    const c = costOf(tokens, priceFor(table, id));
    if (c === null) {
      unpriced++;
    } else {
      cost += c;
      priced++;
    }
  }
  out.cost = priced > 0 ? cost : null;
  out.unpriced = unpriced;
  return out;
}

/**
 * 读配置 → 拼出左栏的 `Item[]` 与第 2 步的 `TokenRow[]`。
 *
 * 四类项：
 *
 * | kind | 是什么 | 启动目录 |
 * |---|---|---|
 * | `cwd` | 面板启动时所在的目录（走默认解析，与裸 `cxt run` 同一条路） | `ctx.cwd` |
 * | `binding` | `config.bindings` 的每一条 | 那条绑定的路径 |
 * | `token` | **没有任何绑定指向**的 token（左栏显示成 `(未绑定) → 名字`） | `ctx.cwd` |
 * | `new` | 「+ 新建…」 | — |
 *
 * ★ 被绑定引用过的 token **不再单独列一行**：它的身份已经在绑定那一行上写着了
 * （`路径 → 身份`），再列一遍是同一个东西出现两次，而用户会以为那是两个入口。
 *
 * ★★ 每一项都**单独 try/catch**：一条坏掉的绑定（指向不存在的 token、
 * 或者那个目录里有一份读不了的 `.cxt.json`）只该让**那一行**的详情说"读不了"，
 * 不该把整个面板打死。面板的全部价值就是"让我看见现在是什么状况"——
 * 它在最需要被看见的时候崩掉是最坏的时机。
 *
 * @param {import('../types.js').Ctx} ctx
 * @returns {import('../ui/app.js').PanelData}
 */
export function buildPanelData(ctx) {
  const { config, tokens } = loadState(ctx);
  const bindings = Array.isArray(config.bindings) ? config.bindings : [];

  // ★★ **每次重建都重读**：状态是另一个进程（另一个控制台窗口）可能刚改过的东西，
  //   缓存它就会让"左边那个窗口改完、右边这个还显示旧的"变成常态。
  //   `projects.json` 不存在时这里给的是全默认，而且**不写盘**。
  const projectState = readProjectState(ctx.home);

  // ★★ **每次重建都重读**（理由同上）：另一个控制台窗口可能刚拉过清单。
  //   它是一份可丢弃的登记，读坏了只会让下拉少几项（`readResources()` 自己吞）。
  const resources = readResources(ctx.home);

  // ★★ 池同样是**每次重建都重读**：另一个窗口（或者命令行 `cxt pool check`）
  //   可能刚探过一轮。它也是可丢弃的——读坏了退化成"全都未检测"，
  //   而那正好等价于"全都还没探过"，不会挡住任何事。
  //   ⚠️ 这里**不用** `loadPool()`：那个函数要再列一遍 token 名（`buildPanelData`
  //   手里已经有 `tokens` 了），而且它会顺手滤孤立条目——那是**写盘前**的活，
  //   面板只是来看一眼的。
  const pool = readPool(ctx.home);

  // ★★ **每次重建都重读**（理由同上）：另一个窗口可能刚「重算用量」，或者刚在
  //   面板里拉过清单（端点价会顺势更新）。价格表的读法是**与 `cxt usage` 同一份**
  //   ——`loadPriceTable()` 是唯一实现，两边各拼一遍就会出现"同一个模型两个价"（§2.15 九 9.2）。
  //   ⚠️ 读两次盘（`prices.json` + `resources.json`）换一次"永远显示当前值"：
  //   这点 I/O 相对一次面板重绘可以忽略，而缓存它就是"左边窗口改了、右边还显示旧的"。
  const prices = loadPriceTable(ctx);

  // 每个 token 被**显式**声明了多少次 —— 资源表的「绑定数」。
  //   ⚠️ 只数 `config.json` 的绑定：项目本地 `.cxt.json` 里的身份不扫，
  //   所以表头写「绑定数」而不是「项目数」，别假装能算全（§2.14 十一）。
  /** @type {Map<string, number>} */
  const bindingCount = new Map();
  for (const b of bindings) {
    const t = b?.token;
    if (typeof t === 'string' && t !== '') bindingCount.set(t, (bindingCount.get(t) ?? 0) + 1);
  }

  /** @type {any[]} */
  const items = [];

  /**
   * ★ 下拉候选在**这里**一次填好（`modelOptionsFor`：已声明在前、登记补后、去重）——
   *   前端是逐字共享的那份，它不该知道"哪些模型出现过"这种业务逻辑。
   *
   * @param {any} item
   */
  const push = (item) => {
    item.modelOptions = modelOptionsFor(
      item.detail?.models ?? [],
      modelsFor(resources, typeof item.token === 'string' ? item.token : ''),
    );
    items.push(item);
  };

  push({
    kind: 'cwd',
    label: '当前目录',
    path: ctx.cwd,
    // ★ 状态只挂在**真的代表一个文件夹**的那两行上（`cwd` / `binding`）。
    //   `token` 行讲的是身份、`new` 行是个按钮——给它们一个状态只会让人以为
    //   "这个 token 也归我管进度"。
    status: statusFor(projectState, ctx.cwd, ctx.platform),
    ...probeFor(ctx, ctx.cwd, null),
  });

  for (const b of bindings) {
    if (b === null || typeof b !== 'object' || typeof b.path !== 'string') continue;
    const declared = typeof b.token === 'string' && b.token !== '' ? b.token : null;
    push({
      kind: 'binding',
      label: b.path,
      path: b.path,
      status: statusFor(projectState, b.path, ctx.platform),
      // ⚠️ **不再自己写 `token:`**——那会被下面的 spread 盖掉（对象展开里
      //    后写的赢），而两处各写一遍正是分叉的温床。`probeFor()` 给的
      //    就是"这一行回车会用的身份"：声明了就用声明的，没声明就走级联
      //    （没声明 token 的绑定，在项目本地配置给了身份时**照样能启动**——
      //    以前这种行会被 `activate()` 判成"没有绑定身份"，纯属冤枉）。
      ...probeFor(ctx, b.path, declared, declared === null ? undefined : 'binding'),
    });
  }

  // ── 没被任何绑定引用的 token ──
  //   判据是"全表里有没有一条绑定指向它"，不是"在这里能不能匹配上"——
  //   后者会让同一个 token 在几个不同目录下各出现一次。
  //   （`bindingCount` 的键集就是"被显式声明过"的那些。）
  for (const name of Object.keys(tokens).sort()) {
    if (bindingCount.has(name)) continue;
    push({
      kind: 'token',
      label: '(未绑定)',
      token: name,
      path: ctx.cwd,
      ...probeFor(ctx, ctx.cwd, name, 'token'),
      // ★ 覆盖 `probeFor()` 的答案：这一项**没有绑定**，而 `e` 要改的是
      //   **这个 token 自己**的模型声明。按路径判的话会走到 `pickLayer()`
      //   的兜底分支 → 给当前目录凭空建一条绑定，而用户只想改 token。
      layer: 'token',
    });
  }

  push({ kind: 'new', label: '+ 新建…' });

  /** @type {string[]} */
  const names = Object.keys(tokens).sort();

  /** @type {any[]} */
  const tokenRows = names.map((name) => {
    const t = tokens[name] ?? {};
    return {
      name,
      // ★ 昵称（§2.4 末）：只给人看，**不是身份**。没设 = 空串（不是 `undefined`，
      //   视图模型要能 JSON 往返，§2.14 十一）。
      label: typeof t.label === 'string' ? t.label : '',
      masked: describeSecret(t.authToken, ctx.env).text || '(未设置)',
      baseUrl: typeof t.baseUrl === 'string' ? t.baseUrl : '(未设置)',
      // ★ **原始值**（没配 = 空串）。上面的 `baseUrl` 是**给人看的**，
      //   拿它去比会把两个"都没配"的 token 判成同一个地址——第 2 步的
      //   "改地址 → 换身份"联动要的是真值。
      url: typeof t.baseUrl === 'string' ? t.baseUrl : '',
    };
  });

  // ── 资源表（§2.14 十一）──
  //   ★ 由 **token 表**驱动，不是由登记驱动：用户要的是"全部 token"，
  //     一个还没拉过的 token 也必须有一行（模型清单列写「未拉取」）。
  //   ★ 登记里指向已删 token 的条目**不显示、也不自动删**（与"未知状态
  //     不自动改写"同一纪律：用户的数据我们不替他清）。
  const fallbackUrl = typeof config.defaults?.baseUrl === 'string' ? config.defaults.baseUrl : '';
  const defaultModels = Array.isArray(config.defaults?.models) ? config.defaults.models : [];

  /**
   * 生效地址（token 层 → 全局默认）。
   * ★ 资源表判"旧"与网关分组**共用这一处**——各算一遍就会在
   *   "没配地址、走全局默认"的那个 token 上分叉。
   */
  const effectiveUrlOf = (name) => {
    const own = typeof tokens[name]?.baseUrl === 'string' ? tokens[name].baseUrl : '';
    return own !== '' ? own : fallbackUrl;
  };

  /**
   * **token 级生效**的优先级（`token.models ?? defaults.models`），只取 id。
   * ⚠️ 不含项目本地与绑定层：资源表是按 token 看的（§2.14 十一）。
   */
  const priorityOf = (name) => {
    const list = Array.isArray(tokens[name]?.models) ? tokens[name].models : defaultModels;
    return list.map((m) => String(m?.id ?? m));
  };

  /**
   * 三态：`own` 自己声明了非空 / `empty` 显式 `[]` / `inherit` 没有这个键。
   * ★ 前端据此写「继承」「（显式空）」——**判断只在这里**。
   */
  const priorityStateOf = (name) => {
    const m = tokens[name]?.models;
    if (!Array.isArray(m)) return 'inherit';
    return m.length === 0 ? 'empty' : 'own';
  };

  /** 两条优先级是否**逐项相同**（只比 id，不比 label——§2.14 十一）。 */
  const samePriority = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

  /** @type {any[]} */
  const resourceRows = names.map((name) => {
    const t = tokens[name] ?? {};
    // ★ 用**生效地址**（token 层 → 全局默认）判"旧"。拿 `token.baseUrl` 的裸值比，
    //   会把"没配地址、走全局默认"的 token **永远**标成旧的。
    const url = effectiveUrlOf(name);
    const cachedUrl = typeof resources.tokens[name]?.url === 'string' ? resources.tokens[name].url : '';

    // ── "同网关"（§2.14 十一）──
    //   ★ 结论在**服务端**算好：前端拿到的必须是答案，不是"再去比一遍"的原料。
    //   ⚠️ 地址为空串时**恒 1**：没配端点的 token 之间没有"同一个网关"可言，
    //      否则所有"没配地址"的 token 会被归成一组，而它们可能根本不是一回事。
    const priority = priorityOf(name);
    const gatewayNames = url === '' ? [name] : names.filter((n) => effectiveUrlOf(n) === url);
    const gatewayCount = gatewayNames.length;
    const gatewayUnified = gatewayCount <= 1
      || gatewayNames.every((n) => samePriority(priorityOf(n), priority));

    // ── 池状态（§2.15 三）──
    // ★ **四个键恒定**：没入池的 token 也给一份 `unknown`，而不是 `null`。
    //   前端是逐字共享的那份，它按"键一定在"写；某一行忽然少一个键，
    //   坏的是**那个项目**的后台，而症状只是"状态丸不见了"。
    //   "未入池"与"入池但没探过"在显示上是同一件事（都写「未检测」），
    //   所以没有必要再多一个 `inPool` 键让两份契约都跟着改。
    const entry = pool.entries[name];

    return {
      name,
      label: typeof t.label === 'string' ? t.label : '',
      masked: describeSecret(t.authToken, ctx.env).text || '(未设置)',
      baseUrl: url !== '' ? url : '(未设置)',
      url,
      cachedUrl,
      models: modelsFor(resources, name),
      fetchedAt: resources.tokens[name]?.fetchedAt ?? '',
      stale: cachedUrl !== '' && cachedUrl !== url,
      projects: bindingCount.get(name) ?? 0,
      priority,
      priorityState: priorityStateOf(name),
      gatewayCount,
      gatewayUnified,
      // ★ env 逃生舱的**本层原文**（§2.3 合并发生在解析，这里只是给对话框预填）。
      //   未设 = `{}`：JSON 往返安全，前端不用判 undefined。
      env: t.env && typeof t.env === 'object' && !Array.isArray(t.env) ? t.env : {},
      // ★ 池状态：**显示用的那一份**（状态词 + 中文标签 + 补充 + 检测时间）。
      //   `detail` 是探测原话（`HTTP 200 · 812ms`）或 `manual`；页面把它放进 `title`。
      pool: {
        status: entry?.status ?? STATUS.UNKNOWN,
        label: statusLabel(entry?.status),
        detail: typeof entry?.detail === 'string' ? entry.detail : '',
        checkedAt: typeof entry?.checkedAt === 'string' ? entry.checkedAt : '',
      },
      // ★ 用量与花费（§2.15 九 9.3）：**六个键恒定**，没入池 / 没算过也给全零。
      //   前端是逐字共享的那份，它按"键一定在"写；某一行忽然少一个键，
      //   坏的是**那个项目**的后台，而症状只是"花费那格空了"。
      usage: rowUsage(entry, prices.table),
    };
  });

  // ★ 概览条的全部数字与提示（§2.15 九 9.4）：**纯函数**，页面只画不翻。
  //   口径与上面每一行同源——它加的就是 `rowUsage()` 算出来的 `cost`，
  //   自己不认识价格、不认识模型（那个文件与 cmt 逐字一致，`prices.js` 不是共享文件）。
  const resourcesSummary = summarizePool(resourceRows.map((r) => ({
    url: r.url,
    status: r.pool.status,
    checkedAt: r.pool.checkedAt,
    usage: r.usage,
  })));

  // ── 会话在场层（§2.16 五）──
  //   ★ **只给 live**：`ended`/`dead` 只进 `cxt sessions`——面板回答的是
  //     "现在有谁在跑"，历史记录不属于这里。
  //   ★ `pool` 只带**显示用的两个键**（状态词 + 算好的中文标签），与资源行那份
  //     同一个口径：`STATUS_LABEL` 只该在 `core/pool.js` 里有一处定义，
  //     页面（逐字共享的那份）不自己写第二份中文。
  const sessions = listSessions(ctx)
    .filter((s) => s.state === 'live')
    .map((s) => ({
      id: s.id,
      token: s.meta.token,
      cwd: s.meta.cwd,
      startedAt: s.meta.startedAt,
      pid: s.meta.pid,
      unread: s.unread,
      pool: {
        status: pool.entries[s.meta.token]?.status ?? STATUS.UNKNOWN,
        label: statusLabel(pool.entries[s.meta.token]?.status),
      },
    }));

  // ── 最近关闭（§2.16 五）：给「恢复」一个入口 ──
  //   ★ 只给 **24 小时内** 的 ended/dead，最多 5 条——"恢复刚才关掉的"是友好，
  //     "列出一周前的历史"是噪音。
  //   ★ 与 live 一样联查池状态：恢复出来的窗口用的还是那把 key。
  const nowMs = Date.now();
  const recentSessions = listSessions(ctx)
    .filter((s) => s.state !== 'live')
    .filter((s) => {
      const at = Date.parse(s.meta.endedAt !== '' ? s.meta.endedAt : s.meta.startedAt);
      return Number.isFinite(at) && nowMs - at <= 24 * 3_600_000;
    })
    .sort((a, b) => {
      const ta = Date.parse(a.meta.endedAt !== '' ? a.meta.endedAt : a.meta.startedAt);
      const tb = Date.parse(b.meta.endedAt !== '' ? b.meta.endedAt : b.meta.startedAt);
      return tb - ta; // 最近的在前（恢复按钮默认点它）
    })
    .slice(0, 5)
    .map((s) => ({
      id: s.id,
      token: s.meta.token,
      cwd: s.meta.cwd,
      startedAt: s.meta.startedAt,
      endedAt: s.meta.endedAt,
      exitCode: s.meta.exitCode,
      state: s.state,
      unread: s.unread,
      pool: {
        status: pool.entries[s.meta.token]?.status ?? STATUS.UNKNOWN,
        label: statusLabel(pool.entries[s.meta.token]?.status),
      },
    }));

  // ── 需要你处理（§2.16 五）：服务端算好的注意力清单 ──
  //   ★★ 每条带**动作描述符**（`{label, op, args}`）：前端只画按钮、不做判断。
  //     加一种新信号 = 只改这里，页面零改动；动作全部复用既有 op。
  //   ★ 顺序 = 该动手的先后：钥匙废了 > 未读纸条（先已关闭的，没人会去看）> 退出异常。
  //   ★ 最多 5 条；健康时是空数组——页面按"空了就整块不显示"写。
  /** @type {any[]} */
  const attention = [];

  // ① 活会话的钥匙废了：窗口在跑、key 不能用——比"有没有未读"更该先看到
  for (const r of resourceRows) {
    if (r.pool.status !== STATUS.NO_QUOTA && r.pool.status !== STATUS.INVALID) continue;
    const live = sessions.find((s) => s.token === r.name);
    if (!live) continue;
    attention.push({
      kind: 'token-bad',
      severity: 'high',
      title: `${r.name} 的钥匙${r.pool.label}，但会话还在跑`,
      detail: `正在用：${tailDir(live.cwd)}`,
      actions: [{ label: '重新检测', op: 'check-token', args: { name: r.name } }],
    });
  }

  // ② 未读纸条：先已关闭的（没人在看那个窗口），再 live 的
  //   ⚠️ `sessions` / `recentSessions` 的**视图条目**里没有 `state` 键
  //      （那是两个不同的冻结形状）——活性靠这份配对标记带进来，别去猜字段。
  const mailOwners = [
    ...recentSessions.map((s) => ({ s, live: false })),
    ...sessions.map((s) => ({ s, live: true })),
  ].filter((x) => x.s.unread > 0);
  for (const { s, live } of mailOwners) {
    const first = firstUnreadMessage(ctx.home, s.id);
    const preview = first === null ? '' : previewOf(first.body, 120);
    /** @type {any[]} */
    const actions = [];
    if (!live) {
      actions.push({ label: '恢复', op: 'resume-session', args: { session: s.id } });
    }
    actions.push({ label: '全部标已读', op: 'msg-read-all', args: { session: s.id } });
    attention.push({
      kind: 'mail',
      severity: live ? 'normal' : 'high',
      title: `${s.token} 有 ${s.unread} 条未读${live ? '' : '（窗口已关闭）'}`,
      detail: preview,
      actions,
    });
  }

  // ③ 最近关闭、退出码非 0、且没有未读（有未读的已经在 ② 里露过面了）
  for (const s of recentSessions) {
    if (s.exitCode === null || s.exitCode === 0 || s.unread > 0) continue;
    attention.push({
      kind: 'exit-fail',
      severity: 'normal',
      title: `${s.token} 上次退出异常（code ${s.exitCode}）`,
      detail: `${tailDir(s.cwd)} · ${s.endedAt.slice(0, 16).replace('T', ' ')}`,
      actions: [{ label: '恢复', op: 'resume-session', args: { session: s.id } }],
    });
  }

  return {
    cwd: ctx.cwd,
    items,
    tokens: tokenRows,
    // ★ 资源表：每个 token 的密钥打码、当前服务端、登记到的模型清单与拉取时间。
    resources: resourceRows,
    // ★ 会话条（§2.16 五）：活动会话 × 池状态 × 未读数，面板顶部那一行。
    sessions,
    // ★ 最近关闭：会话条里「恢复」那一个按钮的来源（24h / 至多 5 条）。
    recentSessions,
    // ★ 需要你处理：服务端算好的注意力清单（每条带动作描述符，最多 5 条）。
    attention: attention.slice(0, 5),
    // ★ 资源屏顶部那条概览（§2.15 九 9.5）。**顶层键**——与 `resources[].usage`
    //   同属视图模型契约，改一边就得两边一起改（§2.15 九 9.6）。
    resourcesSummary,
    // ★ 全局默认那份 env（「默认环境」对话框的预填来源）。未设 = `{}`，同上。
    defaultsEnv: config.defaults?.env && typeof config.defaults.env === 'object'
      && !Array.isArray(config.defaults.env) ? config.defaults.env : {},
    // 状态表的**当前定义**（第 2 步/状态列用的就是它）。
    // ⚠️ 这是只读副本；改它走 `save-statuses`，由 `ui-web.js` 拦下来写盘。
    statuses: projectState.statuses,
    // ★ 状态存哪儿（绝对路径）。控制台的「管理状态」把这一行印出来——
    //   "不知道怎么配" 的一半答案是"先告诉我在哪个文件里"。
    statusFile: projectsPath(ctx.home),
    appName: 'cxt',
    projectFile: PROJECT_CONFIG_FILENAME,
  };
}

/**
 * 一个会话 inbox 里**最新**的一条未读消息（注意力条目的摘要来源）。
 * 读不动 / 没有 → `null`。
 * @param {string} home
 * @param {string} sessionId
 */
function firstUnreadMessage(home, sessionId) {
  const files = listSessionMessages(home, sessionId);
  if (files.length === 0) return null;
  return readSessionMessage(sessionInboxDir(home, sessionId), files[files.length - 1]);
}

/**
 * 消息正文压成一行短预览（≤ `max` 码点）。
 *
 * ★ 注意力条目是"看一眼发生了什么"，不是阅读器——全文在命令行。
 *   压平空白是为了让多行消息不把条目撑高。
 * @param {unknown} body
 * @param {number} max
 */
function previewOf(body, max) {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  return points.length > max ? `${points.slice(0, max).join('')}…` : flat;
}

/** cwd 的末两段（注意力条目一行放得下）。 */
function tailDir(p) {
  if (typeof p !== 'string' || p === '') return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/**
 * 一项的**全部**探测结果：右栏详情 + `e` 该写回哪一层。
 *
 * 两件事一起算是因为它们**读的是同一份解析结果**——分两个函数就得多解析一遍，
 * 而"两处各解析一遍"正是最容易悄悄分叉的形状。
 *
 * 详情里**打码在这里做，明文不许流到渲染层**（`app.js` 的 `Detail` 注释）。
 *
 * ⚠️ `tokenName` 为 `null` 时走"这个目录的默认解析"——`resolveSession()` 不传
 * `argv.token` 就是那条路，与裸 `cxt run` 逐字一致。
 *
 * ★★ 返回值里的 **`token` 是承重的**，不是详情的附属品：`app.js` 的
 * `activate()`（回车启动）与 `startEdit()`（`e`）**都靠它判"这一项有没有身份"**。
 * 少了它，「当前目录」这一行会既启动不了也改不了模型——而那正是裸 `cxt`
 * 落上去的第一行，是面板最重要的一个入口。（这个 bug 真的发生过：身份来自
 * 项目本地配置时，`source` 明明写着「项目本地」，回车却说"没有绑定身份"。）
 *
 * ★ `forcedSource` 只在**身份是被强制指定**时才传（绑定行 / 未绑定 token 行）：
 * 那两行把 token 名字当 `argv.token` 喂进解析，于是 `tokenPick.source` 恒为
 * `cli`——照直印出来就是「来源：命令行」，而用户从没在命令行上给过任何东西。
 * 打码那件事同理：详情说什么，行上就得是什么。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} path
 * @param {string | null} tokenName
 * @param {string} [forcedSource] 来源层的**代号**（`SOURCE` 那套：`binding` / `token`…），
 *   不给就用解析出来的。⚠️ 传的是代号不是中文——翻译**只在这一处**做，
 *   否则两条路会各自拼一遍，而它们迟早拼得不一样（第一版就漏了，印出个 `token`）。
 * @returns {{ detail: import('../ui/app.js').Detail, layer: string, token?: string }}
 */
function probeFor(ctx, path, tokenName, forcedSource) {
  /** @type {any} */
  let r;
  try {
    r = resolveSession(ctx, tokenName === null ? {} : { token: tokenName }, 'run', { path });
  } catch (err) {
    return {
      detail: {
        masked: '（读不了）',
        baseUrl: message(err),
        source: '—',
        profile: '—',
        provider: '',
        models: [],
        active: -1,
        catalog: 0,
      },
      // 解析都失败了，`e` 写哪儿都是猜——退回 `pickLayer()` 的兜底判断，
      // 它至少是"这个路径该写哪一层"的既有答案。
      layer: layerFor(ctx, path),
      // 名字是**调用方给的**，不依赖解析成功——坏掉的那一行照样知道自己是谁。
      token: tokenName ?? undefined,
    };
  }

  const models = Array.isArray(r.models.value) ? r.models.value : [];
  const ids = models.map((/** @type {any} */ m) => m.id);
  const activeId = r.model?.value?.id ?? null;
  const active = activeId === null ? -1 : ids.indexOf(activeId);

  return {
    detail: {
      masked: describeSecret(r.authToken.value, ctx.env).text || '(未设置)',
      baseUrl: typeof r.baseUrl.value === 'string' && r.baseUrl.value !== '' ? r.baseUrl.value : '(未设置)',
      source: sourceLabel(forcedSource ?? r.token.source),
      profile: existsSync(profileDir(ctx.home, r.profileName)) ? '已建' : '未建',
      provider: typeof r.providerId.value === 'string' ? r.providerId.value : '',
      models: ids,
      active,
      // ★ 面板**不拉模型清单**（那要网络，而主屏是同步画的）。
      //   所以这里恒为 0 = "不知道服务端一共有几个"，栏标题就只报已选（`模型 (3)`）。
      //   填一个假的数字比不填更坏。
      catalog: 0,
    },
    layer: layerFor(ctx, path),
    token: typeof r.token.value === 'string' && r.token.value !== '' ? r.token.value : undefined,
  };
}

/**
 * ★ 这个路径上，"改模型"该写回**哪一层**（§2.13 五）。
 *
 * **不重写 `pickLayer()` 的判断**——直接问它，再把它的 `kind` 词表翻成
 * `app.js` 的 `Item.layer` 词表（两者只差一个名字：`global` ↔ `default`）。
 * 抄一遍判断的话，`cxt model set --path .` 与面板的 `e` 迟早会写到不同的层，
 * 而那种分叉没有任何测试会发现。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} path
 * @returns {'project'|'binding'|'default'|'none'}
 */
function layerFor(ctx, path) {
  try {
    const kind = pickLayer({ path }, ctx).kind;
    return kind === 'global' ? 'default' : /** @type {any} */ (kind);
  } catch {
    // 项目本地配置读不了（JSON 坏了）：`e` 就不该往那儿写。退回绑定层是安全的
    // ——它一定写得进去，而且详情里已经写着「（读不了）」了。
    return 'binding';
  }
}

/** 来源层的**中文名**。`cxt resolve` 打的是英文码，面板打中文——两处都要看得懂。 */
const SOURCE_LABEL = /** @type {Record<string, string>} */ ({
  cli: '命令行',
  project: '项目本地',
  binding: '路径绑定',
  token: 'token 文件',
  defaults: '全局默认',
  builtin: '内置默认',
  derived: '派生',
  process: '进程目录',
  merged: '多层合并',
  none: '没配',
});

/** @param {string} s */
function sourceLabel(s) {
  return SOURCE_LABEL[s] ?? String(s ?? '没配');
}

/**
 * ★ `e`（改模型）该写回哪一层（§2.13 五）。
 *
 * 判据与 `model.js` 的 `pickLayer()` **同源**，所以这里不重写那套判断，
 * 只是把 `app.js` 给的 `{path, token, layer}` 翻成 `LayerTarget`：
 *
 * | `layer` | 目标 |
 * |---|---|
 * | `token` | `{kind:'token'}` |
 * | `default` | `{kind:'global'}` |
 * | `project` / `binding` | 交给 `pickLayer()` 按路径判 |
 *
 * ⚠️ **`--config` 在这里不再是个例外**（它曾经是）：那时 `pickLayer()` 只认**自动发现**
 * （`findProjectConfig()`），显式给了 `--config` 它会去找**另一个**文件，
 * 所以这里得先自己认一下。现在 `pickLayer()` 内部走的是 `projectConfigAt()`，
 * 那一个函数就认 `ctx.configPath`——于是这一刀**只准留在那儿**。
 * 在这里再认一遍就是第二处真相，而两处判据漂移的症状正是 §2.13 一 点名的
 * "显式给了路径却悄悄用别的文件"。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {any} target `app.js` 的 `wizard.target`
 * @returns {any} `LayerTarget`
 */
export function layerTargetFor(ctx, target) {
  const layer = target?.layer;
  if (layer === 'token') return { kind: 'token', name: target.token };
  if (layer === 'default') return { kind: 'global' };
  return pickLayer({ path: target?.path ?? ctx.cwd }, ctx);
}

// ═══════════════════════════ 副作用执行器 ═══════════════════════════

/**
 * 把 `effects` 变成真事。**一个 `do*` 一个 effect**——每个自己把失败翻译成
 * reducer 认的那个 `*-failed` 事件（措辞比兜底那句准得多）。
 *
 * 外面那层 `try/catch` 是**第二张网**：`term.js` 的 `run()` 里还有一张
 * （`exec` 抛错或 reject → `{type:'failed'}`）。两张都留着不是冗余——
 * 这张负责"我知道这个 effect 会怎么失败"，那张负责"我忘了处理的那种"。
 *
 * @param {import('../types.js').Ctx} ctx
 * @returns {import('../ui/term.js').Executor}
 */
export function makeExecutor(ctx) {
  return async function exec(fx, dispatch, _signal) {
    try {
      switch (fx.type) {
        case 'launch':
          await doLaunch(ctx, fx.item);
          dispatch({ type: 'launched', ok: true });
          return;

        case 'reload':
          // ⚠️ 重读**不动向导**（`reloaded` 只换 `data`），所以中途重读是安全的
          // ★ `notice: ''` **只给用户按的那一下**（`clearNotice`）：它先前写的那句
          //   「读取配置…」是进行中的提示，读完了字还挂着就是骗人。
          //   向导写入后的重读**不许**擦——那一次要留住「已写入 ✓」这条回执
          //   （`reloaded` 自己沿用旧 `notice`，判据在发 effect 的那一处）。
          dispatch({
            type: 'reloaded',
            data: buildPanelData(ctx),
            notice: fx.clearNotice === true ? '' : undefined,
          });
          return;

        case 'list-dirs':
          // 纯读、绝不出错（读不了就是"没有子目录"）
          dispatch({ type: 'dirs', path: fx.path, names: listDirs(fx.path, ctx) });
          return;

        case 'fetch-models': {
          // ★ `fetchModels()` **不抛错**（§2.14 六）——失败是返回值的一部分。
          //   所以这里没有 catch 分支，`ok:false` 原样喂回去。
          // ★ 成功的拉取**顺手登记**（这是 `resources.json` 最自然的来源）——
          //   而那件事只写在 `fetchAndRecordModels()` 一处，网页控制台的
          //   「拉取」走的是同一个函数。向导第 3 步仍然**每次现拉**，
          //   登记只是"拉到了什么"的留痕，从不代替现拉（§2.14 十一）。
          const [r] = await fetchAndRecordModels(ctx, fx.token);
          dispatch({ type: 'models', token: fx.token, ok: r.ok, ids: r.ids, error: r.error ?? '' });
          return;
        }

        case 'save-token':
          try {
            doSaveToken(ctx, fx.name, fx.secret, fx.baseUrl);
            dispatch({ type: 'token-saved', ok: true, name: fx.name });
          } catch (err) {
            dispatch({ type: 'token-saved', ok: false, name: fx.name, error: message(err) });
          }
          return;

        case 'apply-wizard':
          try {
            const wrote = doApplyWizard(ctx, fx);
            dispatch({ type: 'applied', ok: true, wrote });
          } catch (err) {
            dispatch({ type: 'applied', ok: false, error: message(err) });
          }
          return;

        case 'apply-models':
          try {
            const wrote = doApplyModels(ctx, fx.target, fx.models);
            dispatch({ type: 'applied', ok: true, wrote });
          } catch (err) {
            dispatch({ type: 'applied', ok: false, error: message(err) });
          }
          return;

        case 'delete-binding':
          try {
            doDeleteBinding(ctx, fx.path);
            dispatch({ type: 'deleted', ok: true });
          } catch (err) {
            dispatch({ type: 'deleted', ok: false, error: message(err) });
          }
          return;

        default:
          // `quit` 到不了这里（`term.js` 自己拦了）；其余是将来加了新 effect
          // 而忘了在这儿接线——**说出来**，别静默。
          dispatch({ type: 'failed', error: `认不出的副作用：${fx?.type}` });
      }
    } catch (err) {
      dispatch({ type: 'failed', error: message(err) });
    }
  };
}

/**
 * ★★ **启动**：与 `cxt run` 逐字同一条路。
 *
 * ⚠️ `planLaunch()` 的第三个参数是 `{path}` 而**不是** `argv.cwd`：
 * `--cwd` 会被当成 CLI 层显式声明（`SOURCE.CLI`），而"在面板上点一下"
 * 不是用户敲的 flag。`opts.path` 让绑定匹配与项目本地配置的发现
 * 都按那一项的目录算，而 `resolved.cwd.source` 仍然是它本来该是的那一层。
 *
 * ⚠️ 即使这一项是绑定（`kind:'binding'`）也**照样显式传 token**：
 * 用户指的就是那一行的身份。副作用是 `resolve()` 会记一条
 * `explicit-token-mixed-with-binding` 警告——面板**不打印 warnings**
 * （面板没有"启动前先看一眼"那个环节，而 `--print` 有），所以它无害。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {any} item
 */
async function doLaunch(ctx, item) {
  const argv = item?.token ? { token: item.token } : {};
  // ★ `quiet`：备用屏上写一行 stderr 会横穿某一帧（池的探测进度正是那种行）
  const plan = await planLaunch(argv, ctx, { path: item?.path, quiet: true });
  return startLaunch(plan);
}

/**
 * `GET {baseUrl}/models`。
 *
 * ★ **端点只能从 token 层解析**：`fetch-models` 这个 effect 里只有 token 名
 * （`app.js` 的 `FetchModelsEffect` 就长这样，而它是纯的、不认识配置）。
 * 所以这里是 `token.baseUrl` → `defaults.baseUrl`，**不含绑定层与项目本地层**。
 *
 * 这是 v1 的边界，写进 README：一个"只在某条绑定上配了 baseUrl"的 token
 * 在第 3 步会去默认端点拉清单。**不静默**——拉回来的清单不对时，
 * 用户看得见第 4 步要写的是什么，而 `m`（手敲 id）始终是出路。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} tokenName
 */
async function doFetchModels(ctx, tokenName) {
  const { config, tokens } = loadState(ctx);
  const token = tokens[tokenName];
  if (token === undefined) {
    return { ok: false, ids: [], status: null, error: `没有 token \`${tokenName}\``, url: null, baseUrl: '' };
  }

  // 凭证可能是 `${ENV_VAR}` 引用——这里必须求值，否则请求头里发的是那六个字符
  const raw = String(token.authToken ?? '');
  const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw);
  const secret = m === null ? raw : (ctx.env[m[1]] ?? '');
  if (secret === '') {
    return {
      ok: false, ids: [], pricing: {}, status: null, url: null, baseUrl: '',
      error: m === null ? `token \`${tokenName}\` 没有凭证` : `环境变量 ${m[1]} 没设置`,
    };
  }

  const baseUrl = token.baseUrl ?? config.defaults?.baseUrl ?? '';
  if (baseUrl === '') {
    return {
      ok: false, ids: [], pricing: {}, status: null, url: null, baseUrl: '',
      error: '这个 token 没有 baseUrl，也没有全局默认',
    };
  }

  // ★ 多带一个 `baseUrl`：`recordModels()` 要把它一起登记进 `resources.json`
  //   （「这份清单是从哪个地址拉的」——地址一变，资源表就标「地址已变」）。
  return { ...(await fetchModels({ baseUrl, authToken: secret })), baseUrl };
}

/**
 * 把**一次成功拉取**的结果登记进 `~/.codex-multi-token/resources.json`（§2.14 十一）。
 *
 * ★ **一批一次读、一次写**：`readResources()` → 逐个 `withFetchedModels()` → `writeResources()`。
 *   不能每条各读各写——`refresh-all-models` 是并发的，N 次"读-改-写"会互相覆盖，
 *   最后落盘只剩一条。
 *
 * ★★ **整段吞错**（这也是它与其余写盘的唯一区别）：登记是可丢弃的，
 *   写不进去只该让下拉少几项，**绝不该把向导/刷新的结果弄成失败**——
 *   模型清单已经拉到并显示出来了，那才是用户要的东西。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {{ name: string, url: string, models: string[],
 *           pricing?: Record<string, import('../../core/prices.js').Price> }[]} entries
 */
export function recordModels(ctx, entries) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return;
  try {
    let resources = readResources(ctx.home);
    for (const e of list) {
      resources = withFetchedModels(
        resources, e?.name, e?.url, e?.models, new Date().toISOString(), e?.pricing ?? null,
      );
    }
    writeResources(ctx.home, resources);
  } catch {
    // 写不进去就算了——见上面那条注释。
  }
}

/**
 * 现拉一个或几个 token 的模型清单，**成功的顺手登记**（§2.14 十一）。
 *
 * ★ 这是网页控制台「拉取」/「全部拉取」那两下走的门。做成**收一批**而不是收一个，
 *   是为了让"全部拉取"天然只有**一次写盘**：`recordModels()` 内部是一次
 *   读-改-写，N 个 token 各调一次就会互相覆盖，最后落盘只剩最后一个。
 *   并发的是**网络**，落盘永远只有一次。
 *
 * ★ 用 `Promise.all` 并发：一个慢端点不该让后面九个排队。
 *   `doFetchModels()` 不抛错（失败是返回值），所以这里不需要 allSettled。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string | string[]} names
 * @returns {Promise<{ name: string, ok: boolean, ids: string[], error?: string, baseUrl?: string }[]>}
 */
export async function fetchAndRecordModels(ctx, names) {
  const list = (Array.isArray(names) ? names : [names])
    .filter((n) => typeof n === 'string' && n !== '');

  const results = await Promise.all(
    list.map((name) => doFetchModels(ctx, name).then((r) => ({ name, ...r }))),
  );

  recordModels(
    ctx,
    results.filter((r) => r.ok).map((r) => ({
      name: r.name, url: r.baseUrl ?? '', models: r.ids, pricing: r.pricing,
    })),
  );
  return results;
}

/**
 * 建 token。**与 `cxt token add` 同一条路**（`token.js` 的 `cmdAdd`）——
 * 校验一律交给 schema，别在这儿手写第二套规则（§2.4）。
 *
 * ★ `baseUrl` 可选（第 2 步新建表单里那个地址框）。空串 = 不写这个键——
 *   `normalizeToken` 的 `expectNonEmptyString()` 不收空串，而且"地址是空串"
 *   与"没有地址"在解析链里必须是同一件事。
 *
 * ★ 导出是因为网页控制台资源板块的 `add-token` 走的是**同一条路**（§2.14 十二）
 *   ——同 `doApplyModels`：绝不在 `ui-web.js` 里另写一份建 token 逻辑。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} name
 * @param {string} secret
 * @param {string} [baseUrl]
 */
export function doSaveToken(ctx, name, secret, baseUrl) {
  validateTokenName(name);
  if (readToken(ctx.home, name) !== null) {
    throw new CxtError(`token "${name}" 已存在`, {
      hint: `改它用 \`cxt token edit ${name} --token <新值>\`；要换名字就在第 2 步另起一个`,
    });
  }
  /** @type {{authToken: string, baseUrl?: string}} */
  const raw = { authToken: secret };
  const url = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (url !== '') raw.baseUrl = url;

  const token = normalizeToken(raw, name);
  ensureRoot(ctx);
  putToken(ctx, name, token);
}

/**
 * ★★ **第 4 步：两个都写**（用户已定）。
 *
 * ① `config.bindings += {path, token}` —— 与 `bind.js` 的 `cmdUpsert()` 同一条路：
 *    `findExactBinding` 精确匹配（**不是** `matchBinding` 的前缀匹配）、
 *    命中就**合并**不替换（那条绑定可能还有 `models` / `env` / `cwd`）、
 *    最后整体过 `normalizeBinding()`。
 *
 * ② `<path>/.cxt.json`（或 `--config` 指的那份）—— **保留其余键**，只写
 *    `token` 与 `models`。这三步（保留 / 过 schema / 剥掉 `configPath`）
 *    与 `model.js` 的 `writeLayer()` project 分支逐字同源：
 *    漏掉任何一步都是**静默的数据丢失**（用户仓库里配的 `env` / `sandboxMode`
 *    会被这一次"新建绑定"顺手清掉）。
 *
 * ③ **服务端地址写回那个 token**（只有 `fx.baseUrl` 是字符串时才做）。
 *    第 2 步的"身份 ↔ 地址"是一一对应的（用户已定）：他在那儿改了地址，
 *    意思就是改**这个身份**的地址。空串 = **删掉这个键**（schema 不收空串）。
 *    回执里明写一行「服务端 → …」——不静默改别人的文件。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {{path: string, token: string, models: string[], baseUrl?: string}} fx
 * @returns {string[]} 写进了哪几处（回执里显示）
 */
function doApplyWizard(ctx, fx) {
  const path = resolveUserPath(fx.path, ctx).path;
  if (path === '') throw new CxtError('路径不能为空', { hint: '回到第 1 步给一个目录' });

  // ── ① 全局绑定 ──
  ensureRoot(ctx);
  mutateConfig(ctx, (cfg) => {
    const list = [...cfg.bindings];
    const at = findExactBinding(list, path, ctx.platform);
    const next = at >= 0
      ? { ...list[at], token: fx.token }      // ★ 合并，不替换
      : { path, token: fx.token };
    const normalized = normalizeBinding(next, at >= 0 ? at : list.length);
    if (at >= 0) list[at] = normalized;
    else list.push(normalized);
    return { ...cfg, bindings: list };
  });

  // ── ② 项目本地配置 ──
  const configPath = ctx.configPath ?? joinProject(path, ctx);
  writeProjectLayer(configPath, fx.token, fx.models, ctx);

  const wrote = [
    `绑定 ${shortenHome(path, ctx)} → ${fx.token}`,
    `项目本地 ${basenameOf(configPath)}`,
  ];

  // ── ③ 服务端地址（只在第 2 步动过它时才带）──
  if (typeof fx.baseUrl === 'string') {
    const url = fx.baseUrl.trim();
    const before = readToken(ctx.home, fx.token);
    const beforeUrl = typeof before?.baseUrl === 'string' ? before.baseUrl : '';

    if (before === null || beforeUrl !== url) {
      // ⚠️ token 不存在时 `mutateToken()` 会抛那句标准措辞（"token … 不存在"），
      //    这里不自己再拼一遍。
      mutateToken(ctx, fx.token, (t) => {
        const copy = { ...t };
        if (url === '') delete copy.baseUrl;
        else copy.baseUrl = url;
        return copy;
      });
      wrote.push(`服务端 ${fx.token} → ${url === '' ? '（已清空）' : url}`);
    }
  }

  return wrote;
}

/**
 * `e`（改模型）的落点。
 *
 * ⚠️ 空列表 = **删掉这一层的 `models` 声明**（`undefined`），不是写一个空数组。
 * 空数组在级联里的语义是"这一层说：没有模型"，而用户把勾全取消的意思是
 * **"这一层别说话，让下面那层生效"**——两者完全不同，而前者会让
 * `cxt run` 报"没有可用的模型"。
 *
 * ★ 导出是因为网页控制台的 `set-model` 走的是**同一条路**（§2.14 十一）：
 *   下拉选一个 = `promoteModel()` 之后调这里，与向导第 4 步逐字节同义。
 *   **绝不在 `ui-web.js` 里另写一份写层逻辑**——那会让"空列表 = 删键"
 *   这条规矩有两处定义。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {any} target
 * @param {string[]} ids
 * @returns {string[]}
 */
export function doApplyModels(ctx, target, ids) {
  const layer = layerTargetFor(ctx, target);
  const entries = Array.isArray(ids) && ids.length > 0 ? ids.map((id) => ({ id })) : undefined;
  writeLayer(ctx, layer, entries);

  const where = layer.kind === 'global' ? '全局默认'
    : layer.kind === 'token' ? `token ${layer.name}`
      : layer.kind === 'project' ? `项目本地 ${basenameOf(layer.configPath)}`
        : `绑定 ${shortenHome(layer.path, ctx)}`;
  return [ids.length > 0 ? `${where} ← ${ids.length} 个模型` : `${where} 的模型声明已清掉`];
}

/**
 * 删绑定。★ **只删那一条绑定，绝不删 `.cxt.json` 文件**（§3.2 惰性原则）：
 * 那个文件里可能还有 `env` / `sandboxMode` / `models`，删文件等于顺手清掉了
 * 用户的仓库配置。整个文件的删除是用户自己的事。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} path
 */
function doDeleteBinding(ctx, path) {
  mutateConfig(ctx, (cfg) => {
    const list = [...cfg.bindings];
    const at = findExactBinding(list, path, ctx.platform);
    if (at < 0) return cfg;             // 已经不在了：无事发生，不算错
    list.splice(at, 1);
    return { ...cfg, bindings: list };
  });
}

// ── 项目本地配置的读写小件 ──

/** @param {string} dir @param {import('../types.js').Ctx} ctx */
function joinProject(dir, ctx) {
  const sep = ctx.platform === 'win32' ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${PROJECT_CONFIG_FILENAME}`;
}

/**
 * 把 `token` + `models` 写进一份项目本地配置，**保留其余键**。
 *
 * ⚠️ 真正落盘的是 `saveProjectAt()`（`commands/model.js`）——"保留其余键 + 过 schema +
 * 剥掉 `configPath`"那三步**只准有一处**。这里只负责**决定内容**：
 * 读旧的（没有就从零建）、补 `version`、写 token 与 models。
 *
 * @param {string} configPath
 * @param {string} token
 * @param {string[]} models
 * @param {import('../types.js').Ctx} ctx
 */
function writeProjectLayer(configPath, token, models, ctx) {
  // `--config` 给的路径**必须存在**（§2.13 一：不回退到"往上找"）；
  // 自动发现那条路上，文件可能还没有（向导的常见情况），那就是从零建一份。
  const explicit = ctx.configPath !== null && ctx.configPath !== undefined;
  /** @type {Record<string, any>} */
  let cur = {};
  if (explicit || existsSync(configPath)) cur = readProjectConfig(configPath);

  /** @type {Record<string, any>} */
  const next = { ...cur };
  // ★ `version` 是**必填**的（`checkVersion()` 会拦），而新文件是**从零建的**——
  //   不补这一行，向导第 4 步在"这个目录还没有 .cxt.json"时必然写失败，
  //   而那恰恰是它最常见的用法。已存在的文件沿用原 version（不偷偷升级格式）。
  next.version = typeof cur.version === 'number' ? cur.version : CONFIG_VERSION;
  next.token = token;
  if (models.length > 0) next.models = models.map((id) => ({ id }));
  else delete next.models;

  saveProjectAt(ctx, configPath, next);
}

/** @param {string} p */
function basenameOf(p) {
  const parts = String(p).split(/[\\/]/).filter((x) => x !== '');
  return parts[parts.length - 1] ?? String(p);
}

/** 回执里把 home 换成 `~`——回执是要被看、被复制的，绝对路径太长。 */
function shortenHome(p, ctx) {
  const s = String(p);
  return s.startsWith(ctx.home) ? `~${s.slice(ctx.home.length)}` : s;
}

/**
 * 列一个目录下的**子目录**（不要文件，不要隐藏目录）。**绝不抛错**。
 *
 * ★ 不抛错是刻意的：用户在第 1 步敲到一半时，路径**必然**有一半是无效的
 * （`D:\wor`）。那时候报一个错出来，用户看到的是"我还没敲完你就骂我"。
 * 读不了 = 这个目录下没有可选的子目录，列表空着，而用户可以接着敲。
 *
 * ⚠️ `statSync` 那类权限错误也一起吞——一个读不了的目录不该让面板的
 * 第 1 步卡住。
 *
 * @param {string} raw 用户敲的原文（可能带 `~`、可能是相对路径）
 * @param {import('../types.js').Ctx} ctx
 * @returns {string[]}
 */
export function listDirs(raw, ctx) {
  const text = String(raw ?? '').trim();
  if (text === '') return [];
  const dir = resolveUserPath(text, ctx).path;

  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => {
      if (e.name.startsWith('.')) return false;   // 隐藏目录不进列表（但手敲仍可进）
      if (e.isDirectory()) return true;
      // Windows 的交汇点/符号链接 `isDirectory()` 是 false，得再问一次 fs
      if (!e.isSymbolicLink()) return false;
      try {
        return existsSync(`${dir}${ctx.platform === 'win32' ? '\\' : '/'}${e.name}`);
      } catch {
        return false;
      }
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'zh'));
}

// ═══════════════════════════ 会话：三个驱动共用 ═══════════════════════════

/**
 * 面板的**会话**：一份状态 + 一个执行器 + "跑到静止"那个循环。
 *
 * ★★ 提出来是因为驱动已经**有三个**：
 *
 * | 驱动 | 输入 | 在哪 |
 * |---|---|---|
 * | 全屏面板 | 按键（raw mode） | `ui/term.js` |
 * | 逐行 | 整行文本 | `runPlain()` |
 * | 网页控制台 | HTTP 请求 | `ui-web.js` |
 *
 * 三者共用同一个 reducer、同一个执行器。**"跑到静止"的规则只该有一处定义**——
 * 抄第二遍的话，`list-dirs` 合并、64 轮上限、"`quit` 不当作要执行的动作"
 * 这三条迟早会在某一份里漂移，而漂移的表现是**某个前端悄悄多做或少做了一次副作用**。
 *
 * ★ 状态用 getter 暴露而不是返回一个可变引用：`feed()` 会整个换掉那个对象
 *   （reducer 是纯的），拿在手里的旧引用**立刻就是陈旧的**。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {any} initial 初始状态（`{ ...appInitial(buildPanelData(ctx)), view }`）
 * @returns {{
 *   readonly state: any,
 *   feed: (ev: any) => void,
 *   settle: () => Promise<void>,
 *   abort: () => void,
 * }}
 */
export function makeSession(ctx, initial) {
  let state = initial;
  const exec = makeExecutor(ctx);

  /** exec 的回执先入队——直接在 exec 里 feed 会重入（`settle()` 正跑到一半）。 */
  /** @type {any[]} */
  const queue = [];
  /** @type {any[]} */
  const effects = [];

  /** @param {any} ev */
  const feed = (ev) => {
    const r = reduce(state, ev);
    state = r.state;
    // `quit` 由驱动层自己处理（"跳出主循环"／"回完这条就关服务"），
    // 不当作一个要执行的动作
    for (const fx of r.effects) if (fx.type !== 'quit') effects.push(fx);
  };

  const ac = new AbortController();

  /**
   * 把攒下的 effect 全部执行完，包括它们**新产生的** effect。
   * 有轮数上限：effect 反复生 effect 说明接线成了环，那种情况下
   * **明说**比挂死好（§6.2）。
   */
  const settle = async () => {
    for (let round = 0; round < 64; round++) {
      while (queue.length > 0) feed(queue.shift());
      if (effects.length === 0) return;
      const batch = coalesce(effects.splice(0, effects.length));
      for (const fx of batch) await exec(fx, (ev) => queue.push(ev), ac.signal);
    }
    feed({ type: 'failed', error: '副作用反复产生新副作用（面板接线成环了）' });
  };

  return {
    get state() {
      return state;
    },
    feed,
    settle,
    abort: () => ac.abort(),
  };
}

// ═══════════════════════════ CXT_UI=plain ═══════════════════════════

/**
 * 逐行前端（§2.14 七）。
 *
 * 它解决三件事：
 * 1. **备用屏残留时的出路**——Windows 上 `taskkill /F` 是 `TerminateProcess`，
 *    拦不住（§7.17⑤），所以"终端被强杀之后怎么办"必须有一个答案；
 * 2. CI / 录屏 / 无障碍——那些地方不该进备用屏、也不该进 raw mode；
 * 3. ★ **e2e 的测试路径**——没有它，面板的一切都只能手工验。
 *
 * ★ 它驱动的是**同一个 reducer**。所以"面板会不会在某个键上卡死"这类问题
 * 在 plain 模式下同样成立，而 e2e 验的就是真状态机。
 *
 * ⚠️ 与 TUI 的**唯一**差别是输入：这边读整行、那边读按键。`lineToEvents()`
 * 负责把这行翻译成按键事件——它不自己改状态，也不认识配置。
 *
 * @param {import('../types.js').Ctx} ctx
 * @returns {Promise<number>}
 */
export async function runPlain(ctx) {
  const out = process.stdout;
  const size = plainSize(ctx);
  const session = makeSession(ctx, { ...appInitial(buildPanelData(ctx)), view: size });

  const nextLine = makeLineReader(process.stdin);

  for (;;) {
    await session.settle();
    if (session.state.quitting) break;

    printPlain(session.state, size, out);

    const line = await nextLine();
    if (line === null) {
      // EOF / 管道关了：与 Ctrl+C 同义。**必须有个出口**，否则
      // `printf '' | cxt ui` 会一直等一个永远不来的输入。
      session.feed({ type: 'ctrl', key: 'c' });
      break;
    }
    for (const ev of lineToEvents(session.state, line)) {
      session.feed(ev);
      if (session.state.quitting) break;
    }
  }

  await session.settle();
  session.abort();
  return EXIT.OK;
}

/**
 * 只留最后一个 `list-dirs`。
 *
 * 第 1 步每敲一个字符就发一个 `list-dirs`（`setPath()` 的设计），
 * 而在面板里那是"每次按键重列一次目录"——正确且便宜。plain 模式下一行
 * 却是一次敲完的（`D:\work\proj` 是 12 个字符 = 12 次 readdir），
 * 前 11 次的**结果没人要**。
 *
 * ★ 丢掉它们是**安全**的，理由不在这个函数里：`dirsArrived()` 本来就有
 * 陈旧响应守卫（`ev.path !== w.path.text` 就丢），所以"只执行最后一个"
 * 与"全执行完"对状态的影响**逐字节相同**。这不是优化，是去掉白干的活。
 *
 * @param {any[]} list
 * @returns {any[]}
 */
function coalesce(list) {
  let lastDirs = -1;
  for (let i = 0; i < list.length; i++) if (list[i].type === 'list-dirs') lastDirs = i;
  if (lastDirs < 0) return list;
  return list.filter((fx, i) => fx.type !== 'list-dirs' || i === lastDirs);
}

/**
 * 打印一屏。
 *
 * ★ 正文来自 `renderLines()`——**与全屏面板同一份排版**。抹掉 ANSI 是
 * 因为 plain 模式的用途是"看得见、能复制、能 grep"（贴进 issue 的时候
 * 夹一堆 `\u001b[7m` 是最坏的结果），而**行尾的填充空格要去掉**：
 * 那是给屏幕补满 `rows` 行用的，在滚动缓冲里只是噪声。
 *
 * @param {any} state
 * @param {{cols: number, rows: number}} size
 * @param {NodeJS.WriteStream} out
 */
function printPlain(state, size, out) {
  const lines = renderLines(state, size);
  const l = layout(size, footerHint(state));

  // 页脚整段切掉：面板那句「↑↓ 选择 · Enter 启动」在逐行模式下是**假话**
  // （这里要敲编号）。切几行由 `layout()` 现算——窄终端下页脚会折成 2 行，
  // 写死 1 就少切一行。
  const body = l.tier === 'too-small'
    ? lines
    : lines.slice(0, Math.max(0, lines.length - l.footerLines.length));

  while (body.length > 0 && String(body[body.length - 1]).trim() === '') body.pop();

  out.write(`\n${clean(body).join('\n')}\n`);

  // 编号表。**面板不需要它**（有反显的选中条），逐行模式需要——
  // 没有它，"输入编号启动"就是一句没有着落的指令。
  const legend = clean(plainLegend(state));
  if (legend.length > 0) out.write(`\n${legend.join('\n')}\n`);

  out.write(`\n  ${plainPrompt(state)}\n> `);
}

/**
 * 一组行 → 可读的纯文本行：抹掉 ANSI、去掉行尾填充、丢掉末尾的**空白行**。
 *
 * ⚠️ "空白行"的判据要连**列分隔符**一起算：双栏排版里一行长这样
 * `左栏……|右栏……`，而两栏都没内容时它就是 `                  |`——
 * 去掉了行尾空格仍然是个 `|`，**不是空串**。只按 `=== ''` 判的话，
 * 屏幕上那十几行补白会原样留在滚动缓冲里，把真正的输出顶到屏幕外。
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function clean(lines) {
  const out = lines.map((s) => stripAnsi(s).replace(/[ \t]+$/, ''));
  while (out.length > 0 && out[out.length - 1].replace(/[|\s]/g, '') === '') out.pop();
  return out;
}

/**
 * 抹掉 CSI 转义序列（`\u001b[1m` / `\u001b[0m` / `\u001b[7m` …）。
 *
 * 只认 CSI 就够：面板**一个 OSC 都不发**（§7.17⑧：不碰窗口标题）。
 * 留个 OSC 分支等于给"将来有人加了 OSC"留一个静默漏网的口子，
 * 不如让它显式地不匹配——真加了 OSC 的那天，测试会看见乱码。
 *
 * @param {string} s
 */
function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/**
 * 编号表：把"第几项是什么"摊开。
 *
 * ⚠️ 它**不是**第二套排版——正文那份排版还是 `render.js` 出的。
 * 这一份是**索引键**：`renderLines()` 画的是"当前窗口里的行"，
 * 而逐行模式要回答的是"敲 3 是哪一个"。索引必须来自 reducer 认的
 * **同一个数组**（`items` / `dirs` / `tokens` / `visibleModels`），
 * 否则编号与 `parseChoice()` 数的个数会对不上。
 *
 * @param {any} state
 * @returns {string[]}
 */
function plainLegend(state) {
  const w = state.wizard;

  if (state.screen === 'list') {
    return state.data.items.map((/** @type {any} */ it, /** @type {number} */ i) =>
      `  ${i + 1}) ${it.label}${it.token ? ` → ${it.token}` : ''}`);
  }
  if (w === null) return [];

  if (w.step === 1) {
    return w.path.dirs.map((/** @type {string} */ d, /** @type {number} */ i) => `  ${i + 1}) ${d}/`);
  }
  if (w.step === 2 && w.token.mode === 'pick') {
    const rows = state.data.tokens.map((/** @type {any} */ t, /** @type {number} */ i) =>
      `  ${i + 1}) ${t.name}  ${t.masked}`);
    rows.push(`  ${state.data.tokens.length + 1}) + 新建 token`);
    return rows;
  }
  if (w.step === 3 && !w.models.manual && !w.models.filtering) {
    const rows = visibleModels(w.models);
    const cap = 40;
    const shown = rows.slice(0, cap).map((/** @type {string} */ id, /** @type {number} */ i) =>
      `  ${i + 1}) ${w.models.checked.includes(id) ? '[x]' : '[ ]'} ${id}`);
    if (rows.length > cap) {
      shown.push(`  … 还有 ${rows.length - cap} 个没列出来（直接敲 id 也能勾）`);
    }
    return shown;
  }
  return [];
}

/**
 * 这一屏该敲什么。**逐行模式的页脚**——面板那句提示的对应物。
 * @param {any} state
 */
function plainPrompt(state) {
  if (state.confirm !== null) {
    return `删除「${state.confirm.label}」的绑定？敲 y 确认（回车/Esc 取消）`;
  }
  if (state.screen === 'list') {
    return '编号=启动 · j/k 移动 · n 新建 · e 改模型 · d 删绑定 · r 刷新 · q 退出';
  }

  const w = state.wizard;
  if (w === null) return '';

  if (w.models.filtering) return '过滤词（回车收工）';
  if (w.models.manual) return '模型 id（回车加入，留空取消）';
  if (w.token.mode === 'new') {
    return w.token.field === 'name'
      ? 'token 名字（回车下一步 · :b 返回 · :q 退出）'
      // ⚠️ 说实话：plain 模式进不了 raw mode，终端**一定会回显**这一行。
      //    面板里那段掩码是渲染层画的（明文一个字节都不进帧），这里做不到。
      : '密钥（终端会回显——这是 plain 模式的代价）';
  }

  switch (w.step) {
    case 1:
      return '回车用上面的路径，直接输入=替换 · 编号=进入该子目录 · :b 返回 · :q 退出';
    case 2:
      return '身份编号 · :b 返回 · :q 退出';
    case 3:
      return '编号=勾选/取消（勾选顺序即优先级）· 回车=下一步 · m 手敲 id · s 跳过 · r 重试 · :b 返回';
    default:
      return '回车=写入 · :b 返回 · :q 退出';
  }
}

/**
 * 把用户敲的一行翻译成**按键事件**。
 *
 * ★ 它**不改状态、不读配置**——`reduce()` 仍是唯一的状态迁移入口。
 * 这一层的存在只是因为两条前端的输入设备不一样：那边是键盘，这边是行。
 *
 * 三条约定的来历：
 * - **`:` 开头是 plain 模式自己的命令**（vim 那套）。只有 `:q`（= Ctrl+C）
 *   与 `:b`（= Esc）两个——Esc 敲不出来，而"想退出去"是必须有的出口。
 *   别的 `:` 开头**不静默吞掉**，报 `unknown` 让用户看见（§6.2）。
 * - **空行 = 回车**。面板上回车是"确认/下一步"，这里是同一件事。
 * - **第 3 步可以直接敲 id**（逗号或空格分隔）。那里可能有几百个 id，
 *   让用户去数编号是荒唐的；而"敲 id"用的仍是同一个
 *   `nav` + `space` 机制——不是第二条勾选通路。
 *
 * ★ **分支顺序就是优先级**，四层依次是：
 * `:` 命令 → 确认框（独占）→ 第 3 步勾选 → **第 1 步的数字（进子目录）**
 * → 有输入框的屏（整行替换）→ 编号选中 → 单字母命令。
 *
 * ⚠️ 第 1 步必须在"有输入框"**之前**判：那一步既有输入框（路径）又有编号
 * （子目录列表），而 `3` 在那里只可能是"进第 3 个子目录"——路径不可能是一个
 * 光秃秃的数字。反过来放的话，用户敲 `3` 会看到路径被替换成 `3`，
 * 而提示里明明白白写着"编号=进入该子目录"。
 *
 * @param {any} state
 * @param {string} line
 * @returns {any[]}
 */
export function lineToEvents(state, line) {
  const t = String(line ?? '').trim();

  if (t.startsWith(':')) {
    if (t === ':q') return [{ type: 'ctrl', key: 'c' }];
    if (t === ':b') return [{ type: 'key', key: 'escape' }];
    return [{ type: 'unknown', raw: t }];
  }

  // ★★ **空行 = 回车，永远如此**——包括"有输入框的屏"。
  //
  // 这一条曾经写成"空行也要先清空输入框再回车"，后果是第 1 步的
  // **预填路径被自己抹掉**：提示写着「回车用上面的路径」，用户敲回车，
  // 得到的是「路径不能为空」。而且它只在"输入框里已经有字"时才现形
  // （面板上直接敲回车没事）——正是最不容易在手工点几下时发现的那种。
  //
  // 判据是**"空行"与"我要改成空"不是一回事**：想清空就在面板里按退格，
  // 在逐行模式里这个需求不存在（一行就是一次完整的意图）。
  if (t === '') return [{ type: 'key', key: 'enter' }];

  // 确认框是**独占**的（`app.js`），所以先判它
  if (state.confirm !== null) return [{ type: 'text', text: t }];

  const w = state.wizard;

  // ── 向导第 3 步：勾选 ──
  if (w !== null && w.step === 3 && !w.models.manual && !w.models.filtering) {
    if (/^[a-z]$/i.test(t)) return [{ type: 'text', text: t }];   // m / s / r 这些单字母
    const rows = visibleModels(w.models);
    /** @type {any[]} */
    const out = [];
    for (const tok of t.split(/[,\s]+/).filter((x) => x !== '')) {
      const n = parseChoice(tok, rows.length);
      const at = n !== null ? n : rows.indexOf(tok);
      if (at < 0) {
        out.push({ type: 'unknown', raw: tok });   // 认不出就**说出来**
        continue;
      }
      out.push(...arrows(w.models.cursor, at, rows.length));
      out.push({ type: 'key', key: 'space' });
    }
    return out;
  }

  // ── 向导第 1 步：纯数字 = 进那个子目录（不是把路径改成"3"）──
  if (w !== null && w.step === 1 && /^\d+$/.test(t)) {
    const n = parseChoice(t, w.path.dirs.length);
    if (n !== null) {
      return [...arrows(w.path.dirCursor, n, w.path.dirs.length), { type: 'key', key: 'tab' }];
    }
  }

  // ── 有输入框的屏：整行替换 ──
  //   面板是逐字敲进去的，这边一次给一整行 ⇒ 先按退格清空，再逐字喂。
  //   `reduce()` 是逐字符折开的，所以两边的落点逐字节相同。
  //   ⚠️ 走到这里 `t` **一定非空**（上面那个提前返回），所以"清空"不会
  //   误伤"只想回车"的情形。
  const field = inputField(state);
  if (field !== null) {
    /** @type {any[]} */
    const out = [];
    for (let i = 0; i < field.value.length; i++) out.push({ type: 'key', key: 'backspace' });
    for (const ch of t) out.push({ type: 'text', text: ch });
    out.push({ type: 'key', key: 'enter' });
    return out;
  }

  // ── 其余：编号 = 选中那一项，别的当单字母命令 ──
  const len = selectableCount(state);
  if (len > 0) {
    const n = parseChoice(t, len);
    if (n !== null) return [...arrows(cursorOf(state), n, len), { type: 'key', key: 'enter' }];
  }

  // ★★ `j` / `k` = 上下移动，**不动别的**。
  //
  // 没有它，`e`（改模型）与 `d`（删绑定）在逐行模式下**只能作用在第一项上**：
  // 编号那条路是"移过去 + 回车"，而回车 = 启动。于是"想删第 2 条绑定"
  // 在面板里是 `↓ d y`，在这里却无路可走——一个功能在一条前端上不可达，
  // 比它长得不好看严重得多。
  //
  // ⚠️ 必须放在 `inputField` **之后**：输入框里 `j`/`k` 是字母。
  if (t === 'j' || t === 'down') return [{ type: 'key', key: 'down' }];
  if (t === 'k' || t === 'up') return [{ type: 'key', key: 'up' }];

  return [{ type: 'text', text: t }];
}

/**
 * 这一屏上"正在被编辑的那个字符串"——没有就返回 `null`。
 *
 * 覆盖三处：第 1 步的路径、第 2 步新建 token 的名字与密钥、
 * 第 3 步手敲 id 与过滤词。**逐字对应 `app.js` 里各自的分支**。
 *
 * @param {any} state
 * @returns {{ value: string } | null}
 */
function inputField(state) {
  const w = state.wizard;
  if (w === null) return null;

  if (w.step === 1) return { value: w.path.text };
  if (w.token.mode === 'new') return { value: w.token.field === 'name' ? w.token.name : w.token.secret };
  if (w.step === 3 && w.models.manual) return { value: w.models.manualText };
  if (w.step === 3 && w.models.filtering) return { value: w.models.filter };
  return null;
}

/** 这一屏上有多少个"可以被编号选中"的项。`0` = 这屏不吃编号。 */
function selectableCount(state) {
  if (state.screen === 'list') return state.data.items.length;
  const w = state.wizard;
  if (w === null) return 0;
  if (w.step === 1) return w.path.dirs.length;
  if (w.step === 2 && w.token.mode === 'pick') return state.data.tokens.length + 1;
  return 0;
}

/**
 * 这一屏的**光标**当前在哪。⚠️ 三屏的游标存在**三个不同的字段**里
 * （`state.cursor` / `w.path.dirCursor` / `w.token.cursor`）——它们是各自
 * 独立滚动的。这里必须跟着 `selectableCount()` 一起对，两处错一个就是
 * "敲了编号 5，跳到了别的项"。
 */
function cursorOf(state) {
  const w = state.wizard;
  if (w === null) return 0;
  if (w.step === 1) return w.path.dirCursor;
  if (w.step === 2 && w.token.mode === 'pick') return w.token.cursor;
  return 0;
}

/**
 * 从 `from` 走到 `to` 的导航键序列。
 *
 * ★ 走的是 `nav()` 认的那两个键（`up`/`down`），所以**滚动窗口的算术
 * 只有一处**（`scrollTop()` / `pageMove()` 在 `render.js` 里）。
 * 这里直接算"要按几次下"，而不是"把 cursor 设成 n"——
 * 后者要求我在这边也维护一份 `top`，那就是第二处算术，
 * 而它会和 `listHeight()` 悄悄分叉（表现：光标走到窗口外）。
 *
 * @param {number} from @param {number} to @param {number} len
 * @returns {any[]}
 */
function arrows(from, to, len) {
  const delta = Math.max(0, Math.min(len - 1, to)) - from;
  const key = delta >= 0 ? 'down' : 'up';
  return Array.from({ length: Math.abs(delta) }, () => ({ type: 'key', key }));
}

/**
 * 逐行模式的"虚拟屏幕"尺寸。
 *
 * `CXT_UI_COLS` / `CXT_UI_ROWS` **照样认**——与 `term.js` 的 `readSize()` 同源，
 * 这样两条前端可以用同一组环境变量在任意尺寸下被测试。
 *
 * 行数的默认值给 **40** 而不是 24：逐行模式的输出进的是**滚动缓冲**，
 * 没有"屏幕"会被撑破，所以"一次多显示几行"纯赚。列数取终端真实宽度
 * （管道下没有 `columns`，退回 80）。
 *
 * @param {import('../types.js').Ctx} ctx
 */
function plainSize(ctx) {
  return {
    cols: pickInt(ctx.env.CXT_UI_COLS, process.stdout.columns, 80),
    rows: pickInt(ctx.env.CXT_UI_ROWS, null, 40),
  };
}

/**
 * @param {any} a 优先（环境变量覆盖）
 * @param {any} b 次之（终端自报）
 * @param {number} dflt
 */
function pickInt(a, b, dflt) {
  for (const v of [a, b]) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  }
  return dflt;
}

/**
 * 逐行读 stdin。
 *
 * ⚠️ **必须能区分"空行"与"没有更多输入"**——这正是 `pick.js` 的 `readLine()`
 * 做不到的那件事（那边 `''` 和 EOF 都归到 `null`，因为对它来说两者同义）。
 * 这边不同义：主屏的空行是**回车**（启动），第 3 步的空行是**下一步**。
 * 混起来的话，`printf '\n' | cxt ui` 会变成"什么也没发生"。
 *
 * 内部按 `\n` 切分并缓冲残余，所以一次 `data` 里到几行就产出几行——
 * 管道输入不会因为"一次全到了"而只被当成一行。
 *
 * @param {any} stdin
 * @returns {() => Promise<string | null>} `''` = 空行；`null` = 没有了
 */
export function makeLineReader(stdin) {
  stdin.setEncoding('utf8');
  /** @type {string[]} */
  const queue = [];
  let rest = '';
  let eof = false;
  /** @type {Array<() => void>} */
  const wake = [];

  const kick = () => { while (wake.length > 0) /** @type {() => void} */ (wake.shift())(); };
  /** @param {string} s */
  const push = (s) => queue.push(s.replace(/\r$/, ''));

  stdin.on('data', (/** @type {any} */ chunk) => {
    rest += String(chunk);
    let i;
    while ((i = rest.indexOf('\n')) >= 0) {
      push(rest.slice(0, i));
      rest = rest.slice(i + 1);
    }
    kick();
  });
  const onEnd = () => {
    eof = true;
    if (rest !== '') push(rest);   // 最后一行没有换行结尾（`printf '1'`）
    rest = '';
    kick();
  };
  stdin.on('end', onEnd);
  stdin.on('close', onEnd);

  return async function nextLine() {
    while (queue.length === 0 && !eof) {
      await new Promise((/** @type {() => void} */ res) => wake.push(res));
    }
    return queue.length > 0 ? /** @type {string} */ (queue.shift()) : null;
  };
}

// ── 小件 ──

/** @param {unknown} err */
function message(err) {
  return String(/** @type {any} */ (err)?.message ?? err ?? '未知原因');
}

export const command = { spec, run };

const HELP = `cxt ui —— 交互面板

默认进**全屏 TUI**：左边是**可启动项**（当前目录 / 每条路径绑定 / 没绑定的 token），
右边是选中项的详情（凭证打码、baseUrl、来源层、profile 建没建、模型列表）。

  ↑↓ / Home / End / PgUp / PgDn   选择
  Enter                           启动（= \`cxt run\`，新终端标签页，面板不退出）
  n                               新建：路径 → 身份 → 模型 → 落点（四步向导）
  e                               改当前项的模型（只改**生效的那一层**）
  d                               删掉一条路径绑定（要敲 y 确认；不删 .cxt.json）
  r                               重新读配置
  q / Esc                         退出

★ 面板**不自己拼命令**：Enter 走的是 \`cxt run\` 那条路（同一份解析、同一个终端）。
  所以 \`cxt run --print\` 能预演的，面板启动的也是同一件事。

★ 裸 \`cxt\`（不带任何参数）在终端里进的是**网页控制台**（下面那条）；
  非 TTY 时退回打印用法（退出 0），脚本里的行为一个字都没变。

  --web             进**网页控制台**：本机 127.0.0.1 上一个随机端口，
                    下拉框和勾选框组成的一张表单，用浏览器操作。
                    同一份状态机、同一个向导，只是换了张脸。
  --no-open         配 --web：只打印那行 URL，不自动开浏览器
                    （口令就不会出现在任何命令行里；SSH 里也能自己转发端口）

★ \`--web\` 与 \`CXT_UI=web\` 等价，而且**不看 TTY**——网页控制台不需要终端。
★ 打不开浏览器 / 在 SSH 里 / 无头环境：去掉 \`--web\` 就是全屏 TUI。
★ 想连备用屏都不进（逐行输出）：\`CXT_UI=plain cxt ui\`。
  ——终端被强杀（\`taskkill /F\`）之后备用屏可能残留、且 Windows 上拦不住（§7.17⑤），
  那条命令就是它的出路。

  --config <path>   全局 flag：显式指定项目本地配置（§2.13 一）
  -h, --help        本帮助
`;
