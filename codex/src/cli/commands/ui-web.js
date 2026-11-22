// @ts-check
/**
 * `cxt ui --web` —— 本地网页控制台（§2.14 十）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它是链条上的哪一环
 *
 * ```
 *   浏览器 ──HTTP──▶ platform/serve-web.js ──▶ 本文件 ──▶ makeSession() ──▶ reducer
 *        ◀──视图模型 JSON──┘                     ◀──结果事件──┘
 * ```
 *
 * 与全屏面板的差别**只在两头**：输入不是按键而是表单动作，输出不是字符画
 * 而是 JSON。中间那一段——reducer、执行器、"跑到静止"那个循环——是**同一个**
 * `makeSession()`（`ui.js`）。于是"点得太快会不会把状态搞坏""向导第 3 步
 * 失败之后还能不能退出去"这类问题，在控制台上与在终端上**答案相同**，
 * 而且是同一份代码给的答案。
 *
 * ## ★★ 明文密钥永不过线
 *
 * 视图模型里**没有** `w.token.secret`，只有一个 `secretLength`。
 * 理由和 `ui/render.js` 那条一模一样（`app.js` 的 `Detail.masked` 注释）：
 * 一旦明文进了视图模型，它就会进 JSON、进浏览器的开发者工具、进内存快照，
 * 而**这条路本来不需要它**——用户是在页面上敲那个密钥的，他自己手里有。
 * 服务端要它只是为了写进 `tokens/<名字>.json`。
 *
 * ## ★ 这个文件与姊妹项目的那份**各写各的**
 *
 * 它认识 `PanelData`、认识 `ctx`、认识 reducer，所以它不可能逐字一致。
 * 逐字一致的是**它脚下的那两块**（`platform/serve-web.js`、`src/web/*`）
 * 和**它面前的那个形状**（`viewModel()` 的键集，两份契约里各写了一遍）。
 * ⇒ 改 `viewModel()` 的键必须**两个项目一起改**，否则浏览器里的
 * `src/web/app.js`（逐字一致的那份）会在另一边读到 `undefined`。
 *
 * ## ⚠️ 它为什么可以直接写 stdout
 *
 * §4.2 那条纪律管的是**终端状态**（raw mode、备用屏、光标显隐），
 * 判据是"碰了之后还能不能全身而退"——`cli/commands/` 里每个命令都在往
 * stdout 写输出，那不是它管的事。SIGINT 也**不在**这里装：那一条在
 * `platform/serve-web.js` 里（§2.14 十 第 13 条），所以本文件既不碰信号、
 * 也不碰终端状态。
 * ─────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'node:fs';

import { CxtError, EXIT } from '../../core/errors.js';
import { promoteModel } from '../../core/models.js';
import { STATUS, STATUSES, statusLabel } from '../../core/pool.js';
import {
  hasStatus, usedStatuses, validateStatuses, withStatus, withStatuses,
} from '../../core/project-state.js';
import { MAX_MODELS } from '../../core/resources.js';
import { normalizeConfig, normalizeEnv, normalizeToken } from '../../core/schema.js';
import {
  listSessionMessages, markSessionMessageRead, readProjectState, writeProjectState,
} from '../../core/store.js';
import { openHostBrowser, openPath, serveWeb } from '../../platform/index.js';
import { resolveUserPath } from '../arg-path.js';
import { makePainter } from '../format.js';
import { applyProbe, ensureEntry, loadPool, savePool } from '../pool-store.js';
import { autoSyncUsage, syncPoolUsage } from '../pool-usage.js';
import { probeConfiguredToken } from '../probe.js';
import { resumeSession } from '../resume.js';
import { mutateConfig, mutateToken } from '../state-edit.js';
import { initialState as appInitial } from '../ui/app.js';
import { buildPanelData, doApplyModels, doSaveToken, fetchAndRecordModels, makeSession } from './ui.js';

/**
 * 四个步骤的标题。
 *
 * ⚠️ 与 `ui/render.js` 的 `STEP_NAME` 是**同一组词**，但**故意不共享**：
 * §1.5 划的线是"共用的全是业务，不共用的全是呈现"，而 `render.js` 整个是
 * 终端呈现层（网页控制台一个字都不用它的）。为了四个字符串去 import
 * 一个排版模块，会把那条线搅浑。
 *
 * ★ 步骤的**身份**是 `w.step`（`1|2|3|4`），那个定义只有一处（`ui/app.js`）；
 *   这里重复的只是**叫法**。
 */
const STEPS = [
  { n: 1, title: '目标路径' },
  { n: 2, title: '身份' },
  { n: 3, title: '模型' },
  { n: 4, title: '落点' },
];

/**
 * 三件前端资产的清单：**URL 路径 → 文件名**。
 *
 * ★ 这是一个**精确路径查表**，不是目录扫描——`serve-web.js` 只认这张表，
 *   所以"路径穿越"在结构上就不存在（那边连 fs 都没有）。
 *
 * ⚠️ 三件的路径都是**相对于 `/<口令>/`** 的，前端里写的也是相对 URL
 *   （`fetch('api/state')`、`<link href="style.css">`）⇒ 前端零 base-path 逻辑。
 *
 * @type {{ path: string, file: string, type: string }[]}
 */
const ASSET_FILES = [
  { path: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { path: '/app.js', file: 'app.js', type: 'text/javascript; charset=utf-8' },
  { path: '/style.css', file: 'style.css', type: 'text/css; charset=utf-8' },
];

/**
 * 把 `src/web/` 那三件读进来，交给 `serveWeb()` 当 `assets`。
 *
 * ★ **启动时读一次**就够：它们不随运行变化，而每请求读一次盘等于把
 *   "文件被改了"变成一个会中途生效的变量——刷新到一半换了个前端，
 *   是最难复现的那类怪事。
 *
 * ⚠️ 读失败**当场抛**（不是"回一个空页面"）：`src/web/` 是随包发布的
 *   （`package.json` 的 `files: ["bin","src",…]`），它不在就说明这份安装
 *   是坏的，那种时候让用户看见一句真话比看见一个白屏强。
 *
 * @returns {Map<string, { type: string, body: Buffer }>}
 */
export function loadAssets() {
  /** @type {Map<string, { type: string, body: Buffer }>} */
  const assets = new Map();
  for (const a of ASSET_FILES) {
    let body;
    try {
      body = readFileSync(new URL(`../../web/${a.file}`, import.meta.url));
    } catch (err) {
      throw new CxtError(`前端资产读不了：src/web/${a.file}`, {
        hint: `这份安装不完整（${message(err)}）。重装一次 cxt 应该就好了`,
      });
    }
    assets.set(a.path, { type: a.type, body });
  }
  return assets;
}

// ═══════════════════════════ 视图模型 ═══════════════════════════

/**
 * ★★ **跨项目冻结的接口**——把 reducer 的状态压成"浏览器要的那一份"。
 *
 * 规矩有三条，每条都有测试盯着：
 *
 * | 规矩 | 为什么 |
 * |---|---|
 * | **纯数据**，`JSON.stringify` 之后能原样回来 | 它要过 HTTP |
 * | **键集固定**（成功的形状与失败一样） | 前端是逐字一致的那一份，某个项目少给一个键，只在**那个**项目里坏 |
 * | **不含明文密钥** | 见文件头 |
 *
 * ⚠️ 这里的键**不许**顺手加：加了就得两个项目一起加、两份契约一起改。
 *   前端要显示什么，先问"reducer 里有没有"，没有就去 reducer 里加——
 *   不要在中间这层现算（那会让同一个判断有两处定义）。
 *
/**
 * 数字兜底。
 *
 * ★ 为什么到处要它：视图模型要过 `JSON.stringify`，而 `undefined` / `NaN`
 *   到了那边会**静默变样**（前者整个键消失，后者变 `null`）。那种坏法在日志里
 *   一个字都没有，只是页面少了一格。
 *
 * @param {unknown} v
 * @param {number | null} fallback
 * @returns {any}
 */
function numOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 概览那十个键的兜底（§2.15 九 9.4）。
 *
 * ★ 空池 / 字段缺失时给的是**一个完整的空概览**，不是 `null`：
 *   页面按"`resourcesSummary` 一定是个对象"写，兜成 `null` 就是让页面
 *   在"还没算过用量"这个最常见的状态下崩掉。
 * ★ `counts` 里的中文是**搬过来的**（`summarizePool()` 算好的），
 *   这里只在它缺失时用 `statusLabel()` 补——`STATUS_LABEL` 仍只有一处定义。
 *
 * @param {any} raw
 * @returns {any}
 */
function summaryView(raw) {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    total: numOr(r.total, 0),
    counts: (Array.isArray(r.counts) ? r.counts : []).map((/** @type {any} */ c) => ({
      status: typeof c?.status === 'string' ? c.status : STATUS.UNKNOWN,
      label: typeof c?.label === 'string' ? c.label : statusLabel(c?.status),
      count: numOr(c?.count, 0),
    })),
    calls: numOr(r.calls, 0),
    in: numOr(r.in, 0),
    out: numOr(r.out, 0),
    // ★ 与行内 `cost` 同一条规矩：`null` 是**有意义的值**（"一个模型都查不到价"），
    //   兜成 0 就等于替它说"免费"。
    cost: r.cost === null || r.cost === undefined ? null : numOr(r.cost, null),
    costPartial: r.costPartial === true,
    unpriced: numOr(r.unpriced, 0),
    syncedAt: typeof r.syncedAt === 'string' ? r.syncedAt : '',
    insights: (Array.isArray(r.insights) ? r.insights : []).filter(
      (/** @type {unknown} */ s) => typeof s === 'string',
    ),
  };
}

/**
 * @param {any} state `ui/app.js` 的 `State`
 * @returns {any}
 */
export function viewModel(state) {
  const w = state.wizard;
  return {
    // ── 页头 ──
    // ★ 工具名**只许**从这里出去（`data.appName`）——这个文件里不写死 `cxt`，
    //   姊妹项目那份照抄结构、只换 `buildPanelData()` 给的字符串。
    appName: state.data.appName,
    cwd: state.data.cwd,
    projectFile: state.data.projectFile,
    // ★ 状态表存在哪个文件（绝对路径）。「管理状态」把它印在底部——
    //   要手改也行，能看见在哪儿是前提。
    statusFile: typeof state.data.statusFile === 'string' ? state.data.statusFile : '',

    // ── 全局提示 ──
    screen: state.screen,
    notice: state.notice,
    pending: state.pending === true,
    // ★★ 用户点了「退出」——reducer 的**终态**（`app.js` 的 `step()` 顶上有闸门：
    //   此后任何输入都是空操作）。页面靠它把自己关掉。
    //
    //   ⚠️ 它**必须**是视图模型里的一员，不许让页面去猜：
    //   ① 不许猜"我刚发的那个 op 叫 quit"——那是把服务端的语义抄到前端；
    //   ② 不许猜 `notice === '退出中…'`——拿一句给人看的文案当状态通道。
    //   两个都是"同一件事有两处定义"，而这里正好有一处。
    //
    //   ⚠️ 它**不是** `serve-web.js` 那个 `done`：`done` 是 `ui-web.js` 告诉
    //   服务器的控制位（"回完这条就关"），**不上线**。上线的是状态本身。
    quitting: state.quitting === true,
    // ★ 确认框走**行内横幅**，不用 `window.confirm()`：那个框在测试里
    //   根本到不了（没有测试框架能点它），而且它会冻住整个页面的事件循环。
    confirm: state.confirm === null
      ? null
      : { kind: state.confirm.kind, label: state.confirm.label },

    // ── 屏 1：绑定列表 ──
    // ★ `index` 由**这里**给出，页面原样回传 ⇒ "第 3 行"只有一个定义。
    //   `detail` 早就打好码了（`ui.js` 的 `buildPanelData()`），这里只是摊平。
    items: state.data.items.map((/** @type {any} */ it, /** @type {number} */ index) => ({
      index,
      kind: it.kind,
      label: it.label,
      token: it.token ?? '',
      path: it.path ?? '',
      masked: it.detail?.masked ?? '',
      baseUrl: it.detail?.baseUrl ?? '',
      source: it.detail?.source ?? '',
      models: it.detail?.models ?? [],
      active: it.detail?.active ?? -1,
      // ★ 「改模型」写回哪一层（`ui.js` 的 `layerFor()`：`project`/`binding`/
      //   `token`/`default`，或 `none` = 没有可写的一层）。
      //   页面**只**拿它设 `disabled`——`'none'` 时那个按钮点下去只会挨一句
      //   「这一项的模型不来自可写的一层」，而"点了才被骂"正是这个前端要消灭的东西。
      //   ⚠️ 这是**视图模型键集**里的一员，两个项目必须一起加。
      layer: it.layer ?? '',
      // ★ 项目状态（`{id,label,color}`）。**只挂在真的代表一个文件夹的那两行**
      //   （`cwd` / `binding`）——`token` / `new` 两行给 `null`，页面据此不画下拉。
      //   ⚠️ `null` 而不是 `undefined`：这个模型要过 HTTP，`JSON.stringify`
      //   会把 `undefined` 的键**整个丢掉**，于是"键集固定"当场破功。
      status: it.status ?? null,
      // ★ 模型下拉的候选：**已声明的在前（保持优先级）、登记拉到过的补在后**
      //   （`ui.js` 的 `modelOptionsFor()` 已经排好序、去过重，这里只搬）。
      //   在中间这层现算就会让"哪些模型出现过"有两处定义。
      modelOptions: Array.isArray(it.modelOptions) ? it.modelOptions : [],
    })),
    tokens: state.data.tokens.map((/** @type {any} */ t, /** @type {number} */ index) => ({
      index,
      name: t.name,
      // ★ 昵称（§2.4 末）：**只给人看，不是身份**。没设 = 空串——`JSON.stringify`
      //   会把 `undefined` 的键整个丢掉，而"键集固定"是这个模型的硬要求，
      //   所以这里兜成空串而不是 `undefined`（与 `buildPanelData()` 同一套话）。
      label: typeof t.label === 'string' ? t.label : '',
      masked: t.masked,
      baseUrl: t.baseUrl,
      // ★ **原始值**（没配 = 空串）。上面那个 `baseUrl` 是给人看的，
      //   空的时候写着「(未设置)」——拿它去比会把两个"都没配"的身份判成同一个地址。
      url: typeof t.url === 'string' ? t.url : '',
    })),

    // ── 屏 3：资源表（§2.14 十一）──
    // ★ **由 token 表驱动**，不是由登记驱动：每个 token 都有一行，没拉过的
    //   `models` 是 `[]`、`fetchedAt` 是空串（页面写「未拉取」）。
    //   `state.data.resources` 的形状由 `ui.js` 保证，这里只摊平 + 兜底。
    resources: (Array.isArray(state.data.resources) ? state.data.resources : []).map(
      (/** @type {any} */ r) => ({
        name: r.name ?? '',
        // ★ 昵称：身份列的副标题（`name` 是机器名，昵称是给人认的）。
        label: typeof r.label === 'string' ? r.label : '',
        masked: r.masked ?? '',
        // ★ 显示用（空 = 「(未设置)」）与**生效地址原值**两个都在：
        //   后者是页面判断"这份清单是不是从当前地址拉的"的唯一依据。
        baseUrl: r.baseUrl ?? '',
        url: typeof r.url === 'string' ? r.url : '',
        cachedUrl: typeof r.cachedUrl === 'string' ? r.cachedUrl : '',
        models: Array.isArray(r.models) ? r.models : [],
        fetchedAt: typeof r.fetchedAt === 'string' ? r.fetchedAt : '',
        // ★ 地址改了 → 清单是旧的。判据在服务端（`buildPanelData()` 拿**生效地址**
        //   比），前端只负责画一个标，不再算一遍。
        stale: r.stale === true,
        // ★ 「绑定数」：`config.json` 里**显式声明**了这个 token 的绑定条数。
        //   项目本地 `.cxt.json` 里的身份不扫——所以别把它叫「项目数」。
        projects: typeof r.projects === 'number' ? r.projects : 0,
        // ── 模型优先级（§2.14 十二）──
        // ★ `priority` 是 **token 级生效值**（`token.models ?? defaults.models`），
        //   不含 binding / 项目本地那两层——资源表是按 token 看的，把路径层混进来
        //   只会得到一列"看情况"的数字。要改路径层回主屏的模型下拉。
        priority: Array.isArray(r.priority)
          ? r.priority.map((/** @type {any} */ id) => String(id))
          : [],
        // `'own'`（自己声明了非空）/ `'empty'`（显式 `[]`）/ `'inherit'`（没有这个键）
        priorityState: r.priorityState === 'own' || r.priorityState === 'empty'
          ? r.priorityState
          : 'inherit',
        // ★ 同网关：生效 URL 相同的 token 数（含自己；URL 为空串时恒 1）。
        gatewayCount: typeof r.gatewayCount === 'number' ? r.gatewayCount : 1,
        // ★ 同组每个 token 的 `priority` 是否**逐项相等**。判据在服务端（比 id 字符串），
        //   页面只据此决定对话框里那个复选框的默认勾选态与「同网关不同」的小标。
        gatewayUnified: r.gatewayUnified !== false,
        // ★ env 逃生舱的**本层原文**（对话框预填用）。合并语义在解析那一侧（§2.3），
        //   这里只搬运；未设兜成 `{}`——`undefined` 过不了 `JSON.stringify` 的键集固定。
        env: r.env && typeof r.env === 'object' && !Array.isArray(r.env) ? r.env : {},
        // ── 池状态（§2.15 三）──
        // ★ 四个键**恒定**，没入池的那一行也一样（`unknown` / 「未检测」）。
        //   页面按"键一定在"写，少一个键坏的是那个项目后台，而症状只是状态丸不见了。
        // ★ `label` 是**算好的**中文：`STATUS_LABEL` 只该有一处定义，页面不自己翻。
        pool: {
          status: typeof r.pool?.status === 'string' ? r.pool.status : STATUS.UNKNOWN,
          label: typeof r.pool?.label === 'string' ? r.pool.label : statusLabel(r.pool?.status),
          detail: typeof r.pool?.detail === 'string' ? r.pool.detail : '',
          checkedAt: typeof r.pool?.checkedAt === 'string' ? r.pool.checkedAt : '',
        },

        // ── 用量与花费（§2.15 九 9.3）──
        // ★ **六个键恒定**，没算过的那一行也是全零 + `cost: null`。
        //   页面按"键一定在"写，少一个键坏的是那个项目后台，
        //   而症状只是"花费那格空了"——比抛错难查得多。
        // ★ `cost` 为 `null` 是**有意义的**（"一个模型都查不到价"），
        //   页面据此写 `—`；把它兜成 0 就等于说"免费"，那是谎话。
        usage: {
          calls: numOr(r.usage?.calls, 0),
          in: numOr(r.usage?.in, 0),
          out: numOr(r.usage?.out, 0),
          cost: r.usage?.cost === null || r.usage?.cost === undefined
            ? null
            : numOr(r.usage.cost, null),
          unpriced: numOr(r.usage?.unpriced, 0),
          syncedAt: typeof r.usage?.syncedAt === 'string' ? r.usage.syncedAt : '',
        },
      }),
    ),

    // ── 资源屏顶部的概览（§2.15 九 9.4 / 9.5）──
    // ★ **顶层键**，与 `resources[].usage` 一样属于视图模型契约（§2.15 九 9.6）：
    //   两个项目 + 两份契约 + 两边的黄金形状断言一起改。
    // ★ 十个键恒定——空池也给出 `total: 0` 而不是 `null`：页面按"一定是个对象"写。
    //   页面**只画不翻**：`counts` 里的中文标签、`insights` 的句子都是算好的。
    resourcesSummary: summaryView(state.data.resourcesSummary),

    // ── 会话条（§2.16 五）──
    // ★ **只给 live**（`ui.js` 已经滤过）；**七个键恒定**——页面按"键一定在"写，
    //   少一个键坏的是那个项目后台，而症状只是那一行空了，比抛错难查得多。
    // ★ `pool` 的两个键（状态词 + 中文标签）与资源行那份同一个口径：
    //   中文只在 `core/pool.js` 的 `STATUS_LABEL` 里定义一处。
    sessions: (Array.isArray(state.data.sessions) ? state.data.sessions : []).map(
      (/** @type {any} */ s) => ({
        id: typeof s.id === 'string' ? s.id : '',
        token: typeof s.token === 'string' ? s.token : '',
        cwd: typeof s.cwd === 'string' ? s.cwd : '',
        startedAt: typeof s.startedAt === 'string' ? s.startedAt : '',
        pid: numOr(s.pid, 0),
        unread: numOr(s.unread, 0),
        pool: {
          status: typeof s.pool?.status === 'string' ? s.pool.status : STATUS.UNKNOWN,
          label: typeof s.pool?.label === 'string' ? s.pool.label : statusLabel(s.pool?.status),
        },
      }),
    ),

    // ── 最近关闭（§2.16 五）：会话条里「恢复」的来源 ──
    // ★ 九个键恒定，`pool` 两个子键与 live 那条同口径。
    recentSessions: (Array.isArray(state.data.recentSessions) ? state.data.recentSessions : []).map(
      (/** @type {any} */ s) => ({
        id: typeof s.id === 'string' ? s.id : '',
        token: typeof s.token === 'string' ? s.token : '',
        cwd: typeof s.cwd === 'string' ? s.cwd : '',
        startedAt: typeof s.startedAt === 'string' ? s.startedAt : '',
        endedAt: typeof s.endedAt === 'string' ? s.endedAt : '',
        exitCode: s.exitCode === null || s.exitCode === undefined ? null : numOr(s.exitCode, null),
        state: s.state === 'ended' || s.state === 'dead' ? s.state : 'dead',
        unread: numOr(s.unread, 0),
        pool: {
          status: typeof s.pool?.status === 'string' ? s.pool.status : STATUS.UNKNOWN,
          label: typeof s.pool?.label === 'string' ? s.pool.label : statusLabel(s.pool?.status),
        },
      }),
    ),

    // ── 需要你处理（§2.16 五）──
    // ★ 服务端算好的注意力清单，**每条带动作描述符**（`{label, op, args}`）：
    //   页面只照单画按钮、不做任何判断。加一种新信号 = 只改服务端。
    // ★ 五个键恒定；`actions` 至多两个、每个三键；健康时是空数组（整块不显示）。
    attention: (Array.isArray(state.data.attention) ? state.data.attention : []).slice(0, 5).map(
      (/** @type {any} */ it) => ({
        kind: typeof it?.kind === 'string' ? it.kind : '',
        severity: it?.severity === 'high' ? 'high' : 'normal',
        title: typeof it?.title === 'string' ? it.title : '',
        detail: typeof it?.detail === 'string' ? it.detail : '',
        actions: (Array.isArray(it?.actions) ? it.actions : []).slice(0, 2).map(
          (/** @type {any} */ a) => ({
            label: typeof a?.label === 'string' ? a.label : '',
            op: typeof a?.op === 'string' ? a.op : '',
            args: a?.args !== null && typeof a?.args === 'object' && !Array.isArray(a.args)
              ? a.args
              : {},
          }),
        ),
      }),
    ),

    // ── 全局默认的 env（§2.14 环境变量编辑器）──
    // ★ 「默认环境」对话框的预填来源。与资源行的 `env` 同一套兜底话术。
    defaultsEnv: state.data.defaultsEnv && typeof state.data.defaultsEnv === 'object'
      && !Array.isArray(state.data.defaultsEnv) ? state.data.defaultsEnv : {},

    // ── 项目状态表 ──
    // ★ 这是**整张表**（不是被用到的那些），页面拿它画左栏与每一行的下拉。
    statuses: (Array.isArray(state.data.statuses) ? state.data.statuses : []).map(
      (/** @type {any} */ s) => ({ id: s.id, label: s.label, color: s.color }),
    ),

    // ── 池状态的词表（§2.15 三）──
    // ★ 与 `statuses` 同一个用途：**页面只画，不翻**。状态丸是个下拉，
    //   它需要"六档各叫什么"，而 `STATUS_LABEL` 只该在共享的 `core/pool.js`
    //   里有一处定义——页面自己写一份中文，就是第二处。
    //   ⚠️ 顺序即"好坏顺序"（`STATUSES` 排好了），页面的下拉不重排。
    poolStatuses: STATUSES.map((/** @type {string} */ s) => ({ status: s, label: statusLabel(s) })),

    // ── 屏 2：向导 ──
    wizard: w === null ? null : wizardView(w, state.data),
  };
}

/** `urlOptions` 里那个"我自己敲一个"的哨兵值（页面认的是同一个串）。 */
export const CUSTOM_URL = '__custom__';

/**
 * 第 2 步那个地址下拉的候选项——**在这里算好**。
 *
 * 前端是逐字一致的那份，它不该知道"哪些地址出现过"这种业务逻辑；
 * 它只负责把 `value` 原样回传，外加认出 `CUSTOM_URL` 展开一个输入框。
 *
 * 形状：`（未设置）` + 每个**被某个 token 用着的地址**（去重）+ `自定义…`。
 * ⚠️ 空串排第一：它既是"清空这个身份的地址"，也是"还没选"。
 *
 * @param {any} data `ui.js` 的 `PanelData`
 * @returns {{ value: string, label: string }[]}
 */
function urlOptionsOf(data) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {{ value: string, label: string }[]} */
  const opts = [];
  const rows = Array.isArray(data?.tokens) ? data.tokens : [];
  for (const t of rows) {
    const url = typeof t?.url === 'string' ? t.url : '';
    if (url === '' || seen.has(url)) continue;
    seen.add(url);
    opts.push({ value: url, label: url });
  }
  return [
    { value: '', label: '（未设置）' },
    ...opts,
    { value: CUSTOM_URL, label: '自定义…' },
  ];
}

/**
 * 向导那一半。拆出来只因为它有四个子对象，摊在主函数里会把"键集"读不清。
 *
 * @param {any} w `ui/app.js` 的 `Wizard`
 * @param {any} data `ui.js` 的 `PanelData`
 * @returns {any}
 */
function wizardView(w, data) {
  const checked = w.models.checked;
  return {
    step: w.step,
    // ★ 从主屏 `e` 进来的（只改模型）：页面据此藏掉第 1/2 步，并在第 3 步
    //   就摆出「写入」——与 TUI 的短路逐字一致（`panelWizard` 的 `apply` 那条）。
    edit: w.edit === true,
    notice: w.notice,

    // ★ 步骤条：页面**只**据此设 `disabled`，没有别的逻辑。
    //   "第几步是当前步"这件事在 `w.step` 里已经说完了，前端不该再判一次。
    steps: STEPS.map((s) => ({
      n: s.n,
      title: s.title,
      state: s.n < w.step ? 'done' : s.n === w.step ? 'active' : 'todo',
    })),

    path: {
      text: w.path.text,
      dirs: w.path.dirs.slice(),
      pending: w.path.pending === true,
    },

    token: {
      mode: w.token.mode,
      chosen: w.token.chosen,
      name: w.token.name,
      notice: w.token.notice,
      // ★★ 明文密钥**永不过线**。页面拿这个数字显示「已填 32 字符」，
      //    要写盘的那一份留在服务端的内存里。
      secretLength: String(w.token.secret ?? '').length,
      // ★ 当前显示的服务端地址（`''` = 未设置）。它与 `chosen` **成对**：
      //   跟着身份走，但用户可以单独改（改完在第 4 步写回那个身份）。
      baseUrl: typeof w.token.baseUrl === 'string' ? w.token.baseUrl : '',
      // ★ **预先算好**：页面只负责画 `<select>`，没有"哪些地址出现过"这种逻辑。
      urlOptions: urlOptionsOf(data),
    },

    models: {
      phase: w.models.phase,
      error: w.models.error,
      notice: w.models.notice,
      ids: w.models.ids.slice(),
      // ★ **预先算好** `canUp`/`canDown` ⇒ 浏览器里没有 `index === 0` 这种逻辑。
      //   越界的判据在 `ui/app.js` 的 `moveModel()` 里，只有那一处。
      checked: checked.map((/** @type {string} */ id, /** @type {number} */ i) => ({
        id,
        canUp: i > 0,
        canDown: i < checked.length - 1,
      })),
    },
  };
}

// ═══════════════════════════ 表单动作 → 事件 ═══════════════════════════

/**
 * 把 POST 上来的那坨 JSON 翻成一个 `panel` 事件。
 *
 * ★★ **白名单，不是黑名单**：只搬 `op`/`index`/`id`/`dir`/`value` 五个字段，
 * 页面多塞的一律**不落地**。这一条不是洁癖——事件对象会进 reducer，
 * 而 reducer 是那个"决定要不要写盘"的东西；让它看见页面随手加的字段，
 * 等于给未来的某次改动留了一个"从浏览器往状态里塞东西"的口子。
 *
 * ⚠️ 认不出的 `op` **原样放行**（不在这里拦）：reducer 的 `default:` 分支
 * 本来就是 no-op（`panelList`/`panelWizard` 两个 switch 各有一个），
 * 而"哪些 op 是合法的"这件事的定义在那边。这里拦一遍就是第二处定义。
 *
 * @param {any} body 已解析的 JSON
 * @returns {{ type: 'panel', op: string, index?: number, id?: string, dir?: number, value?: string } | null}
 *   `null` = 连 `op` 都不是个字符串，调用方当 no-op 处理
 */
export function toEvent(body) {
  if (body === null || typeof body !== 'object') return null;
  const op = body.op;
  if (typeof op !== 'string' || op === '') return null;

  /** @type {any} */
  const ev = { type: 'panel', op };
  if (typeof body.index === 'number') ev.index = body.index;
  if (typeof body.id === 'string') ev.id = body.id;
  if (typeof body.dir === 'number') ev.dir = body.dir;
  if (typeof body.value === 'string') ev.value = body.value;
  return ev;
}

/**
 * 「在文件管理器里打开」这个动作的 op 名。
 *
 * ★ 它**不是** `panel` 事件族的一员，**不走 reducer**：`ui/app.js` 那边
 *   根本没有这个概念（终端里没有"弹一个资源管理器"这回事），硬塞进去会让
 *   一个纯终端的状态机多出一个它永远不会产生的状态。这里在 `toEvent()`
 *   **之前**把它拦下来，reducer 的状态一个字节都不动。
 *
 * ⚠️ 判别式是 `body.op`，**不是** `ev.type`——`ev` 是 `toEvent()` 的产物，
 *   而这个动作恰恰不进 `toEvent()`。
 */
const OPEN_OP = 'open-path';

/**
 * 打开第 1 步那个目录（在系统文件管理器里）。
 *
 * ★ 路径解析复用 `resolveUserPath()`——「进子目录」那个 effect 走的是同一个
 *   函数（`ui.js` 的 `doListDirs`），所以 `~` 展开、相对路径按 cwd 补全这两条
 *   规矩在这里和在那边**是同一套**。这里自己再写一遍，两边迟早不一样。
 *
 * @param {unknown} value 页面上那个输入框里的文字（**原样**，没解析过）
 * @param {import('../types.js').Ctx} ctx
 * @returns {Promise<string>} 失败时要说的话；成功时是**空串**
 */
async function openInFileManager(value, ctx) {
  const raw = typeof value === 'string' ? value : '';
  const { path } = resolveUserPath(raw, ctx);
  const r = await openPath(path);
  return r.ok ? '' : r.reason;
}

// ── 项目状态：两个 op，也**不进 reducer** ──
//
// ★★ 理由与 `open-path` 一模一样：终端里没有"项目状态"这回事（`ui/app.js`
//   是共享文件），让 reducer 多背一套只有浏览器才有的语义，等于给它再开一个分叉口。
//   所以这里在 `toEvent()` **之前**按 `body.op` 拦下，写盘之后**重读整个面板数据**
//   （`reloaded`）——状态只存在 `projects.json` 里，reducer 不认识它，
//   "更新视图"就是"重新 `buildPanelData()`"。

/** 给一行改状态。`body = {op, index, id}` —— index 与视图模型里的一致。 */
const SET_STATUS_OP = 'set-status';

/** 整张状态表换掉。`body = {op, statuses:[{id,label,color}]}`（新行 `id === ''`）。 */
const SAVE_STATUSES_OP = 'save-statuses';

/**
 * 状态写完之后把视图拽回最新。
 *
 * ⚠️ **从盘上重读，不是从 `session.state.data` 推**：两个控制台窗口可能都在开，
 *   而"以盘为准"是这整件事里唯一不会分叉的规则。
 */
function reloadPanel(session, ctx) {
  session.feed({ type: 'reloaded', data: buildPanelData(ctx) });
}

/**
 * `set-status` —— 把第 `index` 行标成一档。
 *
 * 三层校验，**全部借 `notice` 说出来**（不新增视图模型字段）：
 * 行还在不在 · 这一行是不是一个文件夹 · 这一档认不认识。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applySetStatus(session, ctx, body) {
  const view = () => viewModel(session.state);
  const items = session.state.data.items;
  const index = body.index;
  const item = typeof index === 'number' && Number.isInteger(index) ? items[index] : undefined;

  if (item === undefined) {
    // 页面拿的是旧列表（另一个窗口删了一条绑定）。**不猜**它指哪一行。
    return { view: { ...view(), notice: '列表已经变了，刷新一下再试' }, done: false };
  }
  if (item.kind !== 'cwd' && item.kind !== 'binding') {
    return { view: { ...view(), notice: '只有「当前目录」和有绑定的目录能标状态' }, done: false };
  }

  const state = readProjectState(ctx.home);
  const id = typeof body.id === 'string' ? body.id : '';
  if (!hasStatus(state, id)) {
    return { view: { ...view(), notice: `认不出的状态：${id || '（空）'}` }, done: false };
  }

  writeProjectState(ctx.home, withStatus(state, item.path, ctx.platform, id));
  reloadPanel(session, ctx);
  return { view: view(), done: false };
}

/**
 * `save-statuses` —— "管理状态"对话框点保存时走这里。
 *
 * ★★ **校验全在 `core/project-state.js` 的 `validateStatuses()` 里**（1–12 个、
 *   名字不能空、颜色必须在词表、id 唯一、**仍在用的不许删**）。
 *   这里只把它的错误原样交给页面——前端再写一遍就是第二处定义。
 *
 * ⚠️ 新行的内部 id **由服务端分配**（`s1/s2…`）：让浏览器生成主键，
 *   就是把唯一性交给一个没有全局视野的地方。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applySaveStatuses(session, ctx, body) {
  const view = () => viewModel(session.state);
  const state = readProjectState(ctx.home);

  const r = validateStatuses(body.statuses, usedStatuses(state));
  if (!r.ok) return { view: { ...view(), notice: r.error }, done: false };

  writeProjectState(ctx.home, withStatuses(state, r.statuses));
  reloadPanel(session, ctx);
  // ★ 成功时**要**说一句（与 `open-path` 相反）：那边资源管理器窗口就是回执，
  //   这边唯一的回执是"对话框关掉了"——不说一句的话，页面会在对话框关掉之后
  //   继续挂着**上一次失败**的那句红字，看起来像这次也没成。
  return { view: { ...view(), notice: '状态表已保存' }, done: false };
}

// ── 模型下拉与资源表：三个 op，同样**不进 reducer** ──
//
// ★ 理由与上面那组一样：`ui/app.js` 是**逐字共享**的那份，而"下拉选一个模型"
//   与"拉模型清单"都是浏览器才有的动作（TUI 用 `e` 进向导、用第 3 步现拉）。
//   往 reducer 里塞，会给姊妹项目那份共享文件多背一套它永远不会产生的状态。
//
// ★★ 但**写盘那一半不重写**：`set-model` 落到 `ui.js` 的 `doApplyModels()`
//   （与向导第 4 步同一个函数），`refresh-*` 落到 `fetchAndRecordModels()`
//   （与向导第 3 步同一个函数）。这里只做**校验与措辞**。

/** 下拉选一个模型。`body = {op, index, id}`；`id === ''` = 清掉这一层的声明。 */
const SET_MODEL_OP = 'set-model';

/** 现拉一个 token 的清单并登记。`body = {op, name}`。 */
const REFRESH_MODELS_OP = 'refresh-models';

/** 现拉全部 token 的清单。`body = {op}`。 */
const REFRESH_ALL_OP = 'refresh-all-models';

/**
 * 这一行能不能改模型？不能就回一句**为什么**（借 `notice`，不新增视图字段）。
 *
 * 判据与前端画 `disabled` 用的是**同一组**：行还在 / 是三选一之一 /
 * 有身份 / 有一层可写。前端禁用只是省一次往返，真正的闸门在这儿。
 *
 * @param {any} item
 * @returns {string} 不能改的理由；空串 = 能改
 */
function modelEditBlocker(item) {
  if (item.kind !== 'cwd' && item.kind !== 'binding' && item.kind !== 'token') {
    return '这一行没有可改的模型';
  }
  if (typeof item.token !== 'string' || item.token === '') {
    return '这一项没有身份，先给它选一个 token';
  }
  if (typeof item.layer !== 'string' || item.layer === '' || item.layer === 'none') {
    return '这一项的模型不来自可写的一层';
  }
  return '';
}

/**
 * `set-model` —— 下拉里选了一个模型。
 *
 * ★★ **语义 = 「提到首位」**，与 `cxt model use <id>` **逐字节同义**：
 *   `[a,b,c]` 里选 `b` → 写 `[b,a,c]`。所以这里调的正是那个 `promoteModel()`
 *   （`core/models.js`），不是"删掉再插"。
 *
 * ⚠️ `detail.models` 是 **id 字符串数组**（`probeFor()` 里 `models.map(m => m.id)`），
 *   而 `promoteModel()` 认的是 `{id}` 条目——**必须先包一层**。不包的话
 *   `findIndex(m => m.id === target)` 恒为 -1，结果是"把对象混进字符串数组"，
 *   写进配置的是一堆 `"[object Object]"`。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applySetModel(session, ctx, body) {
  const view = () => viewModel(session.state);
  const items = session.state.data.items;
  const index = body.index;
  const item = typeof index === 'number' && Number.isInteger(index) ? items[index] : undefined;

  if (item === undefined) {
    // 页面拿的是旧列表（另一个窗口删了一条绑定）。**不猜**它指哪一行。
    return { view: { ...view(), notice: '列表已经变了，刷新一下再试' }, done: false };
  }
  const blocked = modelEditBlocker(item);
  if (blocked !== '') {
    return { view: { ...view(), notice: blocked }, done: false };
  }

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const current = Array.isArray(item.detail?.models) ? item.detail.models : [];
  const ids = id === ''
    ? []   // 空串 = 清掉这一层的声明（`doApplyModels` 传 `[]` 就是删键，与 CLI 同义）
    : promoteModel(current.map((/** @type {string} */ s) => ({ id: s })), id)
      .map((/** @type {{id: string}} */ e) => e.id);

  /** @type {string[]} */
  let wrote;
  try {
    wrote = doApplyModels(ctx, { path: item.path, token: item.token, layer: item.layer }, ids);
  } catch (err) {
    // 写层失败（目录不可写、`.cxt.json` 坏掉…）→ 说清楚，**面板照常**。
    return { view: { ...view(), notice: message(err) }, done: false };
  }

  reloadPanel(session, ctx);
  // ★ 回执就是 `doApplyModels()` 那句话（"绑定 D:\work ← 2 个模型" / "…的模型声明已清掉"），
  //   与向导第 4 步**一字不差**——两个入口做的是同一件事，说的话也该一样。
  return { view: { ...view(), notice: wrote.join('；') }, done: false };
}

/**
 * `refresh-models` —— 资源表某一行的「拉取」。
 *
 * ★ 失败时**保留旧登记**（`fetchAndRecordModels()` 只登记成功的那些），
 *   而且旧清单本来就是"上次拉到过什么"，不该因为一次网络抖动被抹掉。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {Promise<{ view: any, done: boolean }>}
 */
async function applyRefreshModels(session, ctx, body) {
  const view = () => viewModel(session.state);
  const name = typeof body.name === 'string' ? body.name : '';
  const rows = Array.isArray(session.state.data.tokens) ? session.state.data.tokens : [];
  if (!rows.some((/** @type {any} */ t) => t?.name === name)) {
    return { view: { ...view(), notice: `没有 token：${name === '' ? '（空）' : name}` }, done: false };
  }

  const [r] = await fetchAndRecordModels(ctx, name);
  if (r === undefined) {
    return { view: { ...view(), notice: '拉取没有执行' }, done: false };
  }
  if (!r.ok) {
    return { view: { ...view(), notice: `拉取失败：${r.error ?? ''}` }, done: false };
  }

  reloadPanel(session, ctx);
  return { view: { ...view(), notice: `${name} ← ${r.ids.length} 个模型` }, done: false };
}

/**
 * `refresh-all-models` —— 页头那个「全部拉取」。
 *
 * ★★ 并发拉、**一次写**：`fetchAndRecordModels()` 收一批名字，网络并发、
 *   落盘只有一次（N 次"读-改-写"会互相覆盖，最后只剩最后一个）。
 *
 * ★ 一个失败**不影响**其余：全部拉完再给一句汇总。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @returns {Promise<{ view: any, done: boolean }>}
 */
async function applyRefreshAll(session, ctx) {
  const view = () => viewModel(session.state);
  const names = (Array.isArray(session.state.data.tokens) ? session.state.data.tokens : [])
    .map((/** @type {any} */ t) => t?.name)
    .filter((/** @type {any} */ n) => typeof n === 'string' && n !== '');

  if (names.length === 0) {
    return { view: { ...view(), notice: '还没有 token 可拉' }, done: false };
  }

  const results = await fetchAndRecordModels(ctx, names);
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  reloadPanel(session, ctx);

  const notice = failed === 0 ? `拉取完成：${ok} 成功`
    : ok === 0
      ? `拉取完成：0 成功 · ${failed} 失败（${results.find((r) => !r.ok)?.error ?? ''}）`
      : `拉取完成：${ok} 成功 · ${failed} 失败`;
  return { view: { ...view(), notice }, done: false };
}

// ── 资源表：昵称与模型优先级（§2.14 十二）──
//
// ★ 与前面两组同一条路：在 `toEvent()` **之前**按 `body.op` 拦下。
//   "给 token 取个昵称""调模型优先级"都是浏览器才有的动作——`ui/app.js` 是
//   两份逐字共享的那份，TUI 那边根本没有这两个概念。

/** 改 token 昵称。`body = {op, name, label}`；`label` 为空 = **删键**（不是写 `""`）。 */
const SET_LABEL_OP = 'set-label';

/** 写模型优先级。`body = {op, name, ids, scope:'token'|'gateway'}`。 */
const SAVE_PRIORITY_OP = 'save-priority';

/** 建 token。`body = {op, name, secret, baseUrl?}`——资源板块直接添加。 */
const ADD_TOKEN_OP = 'add-token';

/** 编辑 env 逃生舱。`body = {op, target:'token'|'defaults', name?, env}`（§2.14 环境变量编辑器）。 */
const SAVE_ENV_OP = 'save-env';

/** 单项模型 id 的长度上限。一个字面量，没有别的模块需要它。 */
const MAX_MODEL_ID_LEN = 128;

/**
 * 把页面上送来的那串 id 洗成能写盘的样子。
 *
 * ★★ **清洗在服务端做**：那是浏览器里的一个草稿数组，而它是**从 HTTP 来的**。
 *   前端校验过没有，这里一律不关心——"不信前端"不是不信任那个页面，
 *   而是"任何跨过网络边界的值都要在这一侧再过一遍"。
 *
 * 规则（契约 §2.14 十二逐条对应）：必须是数组 · 逐项 `trim` · 丢空 ·
 * 去重保序 · 最多 {@link MAX_MODELS} 项 · 单项不超过 {@link MAX_MODEL_ID_LEN} 字 ·
 * 拒控制字符。
 *
 * @param {unknown} raw
 * @returns {{ ok: true, ids: string[] } | { ok: false, error: string }}
 */
function sanitizePriority(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: '模型列表必须是一个数组' };
  // 先去重再判数量也行，但那要先走一遍可能上百万项的数组——这里直接按原始长度挡
  if (raw.length > MAX_MODELS) return { ok: false, error: `一次最多 ${MAX_MODELS} 个模型` };

  /** @type {string[]} */
  const ids = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: '模型 id 必须是字符串' };
    const id = item.trim();
    if (id === '') continue; // 空行 = 没填，不是错误
    if (id.length > MAX_MODEL_ID_LEN) {
      return { ok: false, error: `模型 id 太长（上限 ${MAX_MODEL_ID_LEN} 字）` };
    }
    // 控制字符会把配置文件和网页表格一起撑坏，而它不可能是合法的模型 id。
    // ⚠️ 用码点判而不是正则字面量：那条正则在源码里要写转义，而转义在
    //   "写文件"这一层是会落成裸字节的（§6.3 的卫生规则正是为这个）。
    for (const ch of Array.from(id)) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < 0x20 || cp === 0x7f) return { ok: false, error: '模型 id 里不能有控制字符' };
    }
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return { ok: true, ids };
}

/**
 * 把一串 id 写进某个 token 的 `models`。
 *
 * ★ **空数组 = 删键**（回到继承），绝不写 `[]`——在 schema 里 `[]` 是
 *   "显式不注入，用 Codex 自身默认"，那是**另一个意思**（§2.5 规则 4）。
 *   这个区分只准在这里判一次：对话框底部那句「空列表 = 回到继承」说的是同一件事。
 *
 * ★ 旧条目上的 `label` **跟着 id 走**：用户只调了个顺序，不该把写了好久的中文名
 *   抹掉（`models` 条目允许 `{id,label}`，见 `normalizeModels()`）。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} name
 * @param {string[]} ids
 */
function writePriority(ctx, name, ids) {
  mutateToken(ctx, name, (t) => {
    /** @type {Record<string, any>} */
    const next = { ...t };
    if (ids.length === 0) {
      delete next.models;
    } else {
      /** @type {Map<string, string>} */
      const labels = new Map();
      if (Array.isArray(t.models)) {
        for (const m of t.models) {
          if (typeof m?.id === 'string' && typeof m.label === 'string' && m.label !== '') {
            labels.set(m.id, m.label);
          }
        }
      }
      next.models = ids.map((id) => {
        const label = labels.get(id);
        return label === undefined ? { id } : { id, label };
      });
    }
    // 合并后整体过一遍 schema（与 `cxt token edit` 的写法一致）
    return normalizeToken(next, name);
  });
}

/**
 * 生效 URL 与 `name` 相同的那些 token（含自己）。
 *
 * ★★ **服务端自己算**，不看前端送来的任何名单或计数——浏览器里的那个
 *   `gatewayCount` 可能已经过期（另一个窗口刚改过地址）。
 * ★ 判据就是 `buildPanelData()` 算好的 `resources[].url`（**生效地址**，
 *   `token.baseUrl || defaults.baseUrl`）：与资源行的 `gatewayCount` 同一处定义。
 *   ⚠️ URL 为空串时**恒只有自己**——两个都没配端点的 token 不是"同一个网关"。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} name
 * @returns {string[]}
 */
function sameGatewayTokens(ctx, name) {
  const data = buildPanelData(ctx);
  const rows = Array.isArray(data.resources) ? data.resources : [];
  const me = rows.find((/** @type {any} */ r) => r?.name === name);
  if (me === undefined) return [name];

  const url = typeof me.url === 'string' ? me.url : '';
  if (url === '') return [name];
  const same = rows
    .filter((/** @type {any} */ r) => typeof r?.url === 'string' && r.url === url)
    .map((/** @type {any} */ r) => String(r.name));
  return same.length === 0 ? [name] : same;
}

/**
 * `set-label` —— 资源表里改昵称（失焦即保存）。
 *
 * ★ 失败**只借 `notice` 说一句，文件一个字节都不动**：`mutateToken()` 是
 *   "算完整个新对象才写盘"，而 `normalizeToken()`（`normalizeTokenLabel()`）
 *   在写盘之前抛——所以"太长 / 带控制字符"这类错误不会留下半截文件。
 * ★ 空串 = 删键：交给 `normalizeToken()` 判（`normalizeTokenLabel()` 返回
 *   `undefined` ⇒ 键不存在），这里**不自己写 `delete`**——那会让"空 = 未设置"
 *   有两处定义。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applySetLabel(session, ctx, body) {
  const view = () => viewModel(session.state);
  const name = typeof body.name === 'string' ? body.name : '';
  const rows = Array.isArray(session.state.data.tokens) ? session.state.data.tokens : [];
  if (name === '' || !rows.some((/** @type {any} */ t) => t?.name === name)) {
    return { view: { ...view(), notice: `没有 token：${name === '' ? '（空）' : name}` }, done: false };
  }
  // ★ 非字符串一律拒，**不**当成"清空"：把一个 `null` 静默理解成"删掉昵称"
  //   是最不该有的那种理解。
  if (typeof body.label !== 'string') {
    return { view: { ...view(), notice: '昵称必须是文本' }, done: false };
  }

  try {
    mutateToken(ctx, name, (t) => normalizeToken({ ...t, label: body.label }, name));
  } catch (err) {
    return { view: { ...view(), notice: message(err) }, done: false };
  }

  reloadPanel(session, ctx);
  // ★ 成功**不写** `notice`（与 `open-path` 同一条）：行内那个输入框自己已经
  //   显示成新昵称了，再塞一句话只会盖掉上一次的失败提示。
  return { view: view(), done: false };
}

// ── 资源表：池状态（§2.15 三）──
//
// ★ 与前几组同一条路：在 `toEvent()` **之前**按 `body.op` 拦下，不进 reducer。
//   "探一次额度""手动标一档状态"都是网页这边才有的动作——TUI 那边用
//   `cxt pool check` / `cxt pool status`（**同一份落盘函数**，见下）。
//
// ⚠️ 手动标注的 op **不能**叫 `set-status`：那个名字已经被**项目**状态占了
//   （`SET_STATUS_OP`，改的是 `projects.json`）。两个都叫 `set-status` 的话，
//   先判到的那个会把另一个吃掉——而症状是"点项目状态去改了池""点池状态没反应"，
//   两者都不报错。

/** 现探一个 token 的额度。`body = {op, name}`。 */
const CHECK_TOKEN_OP = 'check-token';

/** 手动标一档池状态。`body = {op, name, status}`；`status === 'unknown'` = 清掉（同 `pool reset`）。 */
const SET_POOL_STATUS_OP = 'set-pool-status';

/** 从 rollout 重算用量与花费。`body = {op}`。 */
const SYNC_USAGE_OP = 'sync-usage';

/** 把一个会话的未读纸条全部标为已读。`body = {op, session}`（§2.16 五）。 */
const MSG_READ_ALL_OP = 'msg-read-all';

/** 恢复一个已关闭的会话：同 token、同 cwd、带 -c 开新窗口。`body = {op, session}`。 */
const RESUME_SESSION_OP = 'resume-session';

/**
 * `check-token` —— 资源表某一行的「检测」。
 *
 * ★★ **这里真的会花钱**（§2.15 二）：探测就是发一条最小的真实请求。所以：
 * ① 这是**显式动作**，不是"渲染时顺手探一下"；
 * ② 不做批量——「全部检测」是前端**逐条**发这个 op（`src/web/app.js`），
 *    服务端一次只探一个。18 个 token ≈ 40 秒，塞进一个请求里会把
 *    `serve-web` 的空闲计时和用户耐心一起耗光。
 *
 * ★ **不看 TTL、直接探**：用户点了「检测」就是在说"别管缓存，现在探"。
 *   TTL 管的是**自动**那一路（启动挑 token），不是手动这一下。
 *
 * ★ 判断与落盘全部复用 `probeConfiguredToken()` + `applyProbe()`——与
 *   `cxt pool check` 是同一份实现，"面板探出来的"和"命令行探出来的"
 *   不可能有两个答案。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {Promise<{ view: any, done: boolean }>}
 */
async function applyCheckToken(session, ctx, body) {
  const view = () => viewModel(session.state);
  const name = typeof body.name === 'string' ? body.name : '';
  const rows = Array.isArray(session.state.data.tokens) ? session.state.data.tokens : [];
  if (name === '' || !rows.some((/** @type {any} */ t) => t?.name === name)) {
    return { view: { ...view(), notice: `没有 token：${name === '' ? '（空）' : name}` }, done: false };
  }

  const r = await probeConfiguredToken(ctx, name);
  const { pool } = loadPool(ctx);
  const now = new Date();
  applyProbe(ensureEntry(pool, name), r, now);
  savePool(ctx, pool, now);

  reloadPanel(session, ctx);
  // ★ 回执只给**名字 + 状态 + 一句原话**——`detail` 里可能有网关回的错误文本，
  //   而 `probeToken()` 已经保证它不含密钥、不超过 200 字。这里再夹一次，
  //   是为了那条提示栏只有一行。
  const why = r.detail === '' ? '' : `（${clipText(r.detail, 80)}）`;
  return {
    view: { ...view(), notice: `${name}：${statusLabel(r.status)}${why}` },
    done: false,
  };
}

/**
 * `set-pool-status` —— 手动标一档池状态（状态丸本身是个下拉）。
 *
 * ★★ 语义与 `cxt pool status` **逐项相同**：写 `detail = 'manual'`，好让
 *   下次 `pool list` 一眼看出"这个状态是人说的，不是探出来的"。
 *
 * ★ 选「未检测」= **清掉**（状态、detail、检测时间），与 `cxt pool reset` 同义：
 *   用户选它想要的是"回到没探过的样子，下次自动重探"，不是"标成未检测但
 *   五分钟内不许重探"。⚠️ 这一条与 `pool status <n> unknown` 不同——
 *   那条会记 `manual`+时间戳；面板上只给一个「未检测」选项，所以取 reset 的语义。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applySetPoolStatus(session, ctx, body) {
  const view = () => viewModel(session.state);
  const name = typeof body.name === 'string' ? body.name : '';
  const rows = Array.isArray(session.state.data.tokens) ? session.state.data.tokens : [];
  if (name === '' || !rows.some((/** @type {any} */ t) => t?.name === name)) {
    return { view: { ...view(), notice: `没有 token：${name === '' ? '（空）' : name}` }, done: false };
  }

  const status = typeof body.status === 'string' ? body.status : '';
  if (!STATUSES.includes(status)) {
    return {
      view: { ...view(), notice: `认不出的池状态：${status === '' ? '（空）' : status}` },
      done: false,
    };
  }

  const { pool } = loadPool(ctx);
  const entry = ensureEntry(pool, name);
  const now = new Date();

  if (status === STATUS.UNKNOWN) {
    // ★ 只清**状态**：`calls / in / out` 是账本，与"上次探得怎么样"无关。
    entry.status = STATUS.UNKNOWN;
    entry.detail = '';
    entry.checkedAt = '';
  } else {
    entry.status = status;
    entry.detail = 'manual';
    entry.checkedAt = now.toISOString();
  }
  savePool(ctx, pool, now);

  reloadPanel(session, ctx);
  const notice = status === STATUS.UNKNOWN
    ? `已清掉 ${name} 的状态（用量保留，下次检测会重探）`
    : `${name} 已标成「${statusLabel(status)}」`;
  return { view: { ...view(), notice }, done: false };
}

/**
 * `resume-session` —— 恢复一个已关闭的会话（§2.16 五）。
 *
 * ★ 与命令行的 `cxt resume` 调的是**同一个** `resumeSession()`——同 token、同 cwd、
 *   带 `-c` 开新窗口。面板和命令行不可能给出两种"恢复"。
 * ★ 判据是**当前视图里的 recentSessions**（列表可能刚刷新过，与 `set-status` 同一纪律）。
 * ★ 启动失败只借 `notice` 说一句（键集冻结）；成功刷新面板让新会话出现在会话条里。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @param {{ resumeSession?: typeof resumeSession }} [deps]
 *   测试注入：真启动会弹窗口，单测里换成假的（与 `serve-web` 的 `_listen` 同一手段）。
 * @returns {Promise<{ view: any, done: boolean }>}
 */
async function applyResumeSession(session, ctx, body, deps = {}) {
  const view = () => viewModel(session.state);
  const doResume = typeof deps.resumeSession === 'function' ? deps.resumeSession : resumeSession;
  const sid = typeof body.session === 'string' ? body.session : '';
  const rows = Array.isArray(session.state.data.recentSessions) ? session.state.data.recentSessions : [];
  if (sid === '' || !rows.some((/** @type {any} */ s) => s?.id === sid)) {
    return {
      view: { ...view(), notice: `没有这个会话：${sid === '' ? '（空）' : sid}` },
      done: false,
    };
  }

  try {
    const r = await doResume(ctx, { id: sid });
    reloadPanel(session, ctx);
    return {
      view: {
        ...view(),
        notice: `已在新窗口恢复 ${r.token !== '' ? r.token : '(default)'} · ${tailPathOf(r.cwd)}（-c）`,
      },
      done: false,
    };
  } catch (err) {
    // 失败只借既有的 notice（键集冻结），把"为什么"原样说出来（含下一步提示）
    return { view: { ...view(), notice: message(err) }, done: false };
  }
}

/**
 * cwd 的末两段（回执一行放得下）。
 * @param {string} cwd
 */
function tailPathOf(cwd) {
  if (cwd === '') return '';
  const parts = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.slice(-2).join('/');
}

/**
 * `msg-read-all` —— 把一个会话的未读纸条全部标为已读（§2.16 五）。
 *
 * ★ 与 `set-status` 同一条路：在 `toEvent()` 之前拦下，reducer 一行不动
 *   （终端面板里没有"未读纸条"这回事）。
 * ★ 与 `cxt msg inbox` 共用同一条 IO（`markSessionMessageRead`：inbox→read rename），
 *   所以"面板点了已读"与"命令行读过了"不可能是两种状态。
 * ★ 判据是**当前视图里的会话**（列表可能刚 reload 过——与 `set-status` 同一条纪律）。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applyMsgReadAll(session, ctx, body) {
  const view = () => viewModel(session.state);
  const sid = typeof body.session === 'string' ? body.session : '';
  const rows = Array.isArray(session.state.data.sessions) ? session.state.data.sessions : [];
  if (sid === '' || !rows.some((/** @type {any} */ s) => s?.id === sid)) {
    return {
      view: { ...view(), notice: `没有这个会话：${sid === '' ? '（空）' : sid}` },
      done: false,
    };
  }

  let n = 0;
  for (const f of listSessionMessages(ctx.home, sid)) {
    if (markSessionMessageRead(ctx.home, sid, f)) n += 1;
  }
  reloadPanel(session, ctx);
  return {
    view: { ...view(), notice: n === 0 ? '这个会话没有未读消息' : `已把 ${n} 条标为已读` },
    done: false,
  };
}

/**
 * `sync-usage` —— 从 rollout 重算用量与花费（§2.15 九）。
 *
 * ★★ 与 `cxt pool sync` 调的是**同一个** `syncPoolUsage()`。两处各写一份的话，
 *   页面和命令行会给出两个数，而**没有任何东西会报错**——只有人把两张表
 *   摆在一起才看得出来。这也是为什么这里不做任何"顺手多算一点"的加工。
 *
 * ★ 不需要 `name`：一次就是整池。逐行重算会让"合计"与"明细"分两次取时刻，
 *   数字看起来完全正常，却是两份时间点的快照拼出来的。
 *
 * ★ 不新增视图模型字段：回执借既有的 `notice` 说一句（那条键集是跨项目冻结的）。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @returns {{ view: any, done: boolean }}
 */
function applySyncUsage(session, ctx) {
  const view = () => viewModel(session.state);
  const { pool } = loadPool(ctx);
  const r = syncPoolUsage(ctx, pool, new Date());
  reloadPanel(session, ctx);

  // ★ 回执要让"什么都没找到"与"找到了但都是 0"能区分开：前者多半是
  //   还没跑过会话（或者 profile 目录不对），后者是真的没用过。
  const notice = r.filesRead === 0
    ? `重算了 ${r.names.length} 个 token：一份会话记录都没找到（用量已归零）`
    : `重算了 ${r.names.length} 个 token · 读了 ${r.filesRead} 份记录`;
  return { view: { ...view(), notice }, done: false };
}

/**
 * 把一段可能很长的文本夹成一行。
 *
 * ★ 只在这里用：`notice` 是**一条**横贯页面顶部的话，塞进三行错误体就把
 *   整块内容顶下去了。全文仍可在状态丸的 `title` 里看到（那里不夹）。
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function clipText(s, max) {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * `save-priority` —— 优先级对话框点保存。
 *
 * 两种 scope：
 * - `'token'`：只改这一个 token；
 * - `'gateway'`：**服务端**按生效 URL 找出同组的全部 token，逐个写。
 *   中途失败就停，`notice` 说清楚成功几个——**不许**静默跳过剩下的。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applySavePriority(session, ctx, body) {
  const view = () => viewModel(session.state);
  const name = typeof body.name === 'string' ? body.name : '';
  const rows = Array.isArray(session.state.data.tokens) ? session.state.data.tokens : [];
  if (name === '' || !rows.some((/** @type {any} */ t) => t?.name === name)) {
    return { view: { ...view(), notice: `没有 token：${name === '' ? '（空）' : name}` }, done: false };
  }

  const clean = sanitizePriority(body.ids);
  if (!clean.ok) return { view: { ...view(), notice: clean.error }, done: false };

  const targets = body.scope === 'gateway' ? sameGatewayTokens(ctx, name) : [name];

  /** @type {string[]} */
  const written = [];
  for (const target of targets) {
    try {
      writePriority(ctx, target, clean.ids);
      written.push(target);
    } catch (err) {
      // ★ 先把已经写下去的看相拽回面板（它们**真的**改了），再报错。
      //   不刷新的话，页面会显示成"一次都没成功"，而磁盘上是半套。
      reloadPanel(session, ctx);
      const why = message(err);
      const notice = written.length === 0
        ? why
        : `已更新 ${written.length} 个 token，然后失败：${why}`;
      return { view: { ...view(), notice }, done: false };
    }
  }

  reloadPanel(session, ctx);
  const n = clean.ids.length;
  const what = n === 0
    ? (written.length === 1 ? `${written[0]} ← 回到继承` : `${written.length} 个 token ← 回到继承`)
    : (written.length === 1 ? `${written[0]} ← ${n} 个模型` : `${n} 个模型 → ${written.length} 个 token`);
  return { view: { ...view(), notice: `已保存：${what}` }, done: false };
}

/**
 * `add-token` —— 资源板块直接建 token（§2.14 十二）。
 *
 * ★ 建的动作**原样复用向导第 2 步的 `doSaveToken()`**（`ui.js`）——校验、重名
 *   报错、`baseUrl` 空串不写键，全是那一条路的既有行为，这里一个字不重写。
 * ★★ `secret` 只在 POST body → `doSaveToken()` 落盘这一趟；回执是 `reloadPanel`
 *   重读后的视图（打码值），**绝不含明文**——本文件头的铁律。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applyAddToken(session, ctx, body) {
  const view = () => viewModel(session.state);
  // ★ 与 `applySetLabel` 同一套手艺：非字符串/空串一律拒，绝不"善意理解"。
  if (typeof body.name !== 'string' || body.name.trim() === '') {
    return { view: { ...view(), notice: '名字必须是文本' }, done: false };
  }
  if (typeof body.secret !== 'string' || body.secret.trim() === '') {
    return { view: { ...view(), notice: '密钥不能为空' }, done: false };
  }
  if (body.baseUrl !== undefined && typeof body.baseUrl !== 'string') {
    return { view: { ...view(), notice: '服务端地址必须是文本' }, done: false };
  }

  try {
    doSaveToken(ctx, body.name, body.secret, body.baseUrl ?? '');
  } catch (err) {
    return { view: { ...view(), notice: message(err) }, done: false };
  }

  reloadPanel(session, ctx);
  return { view: { ...view(), notice: `已添加：${body.name}` }, done: false };
}

/**
 * `save-env` —— 环境变量编辑器（§2.14 环境变量编辑器）。
 *
 * `body = {target:'token'|'defaults', name?, env}`，`env` 是**解析好的对象**
 * （`JSON.parse` 的早反馈在前端做过了，但校验**只认这里**——跨过网络边界的值
 * 一律在本侧再过一遍 `normalizeEnv()`）。
 *
 * - `target:'token'` → `mutateToken` 改那个 token 的 `env`，整体过 `normalizeToken()`；
 * - `target:'defaults'` → `mutateConfig` 改 `defaults.env`。⚠️ `writeConfig()` 只盖
 *   version 章**不校验**（`store.js`），所以 defaults 这条路必须在回调里把整份
 *   config 过一遍 `normalizeConfig()` 再写——与 token 侧的 `normalizeToken` 对称。
 * - `{}` = **删键**（回继承，与 `save-priority` 空数组同语义），绝不往盘上写 `{}`。
 * - 值为 `""` 的键**合法且有含义**：注入时删掉继承来的那个变量（§2.6）。
 *
 * ★ 失败只借 `notice` 说一句，文件一个字节不动（`normalizeEnv()` 在写盘之前抛）。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx
 * @param {any} body
 * @returns {{ view: any, done: boolean }}
 */
function applySaveEnv(session, ctx, body) {
  const view = () => viewModel(session.state);
  if (body.target !== 'token' && body.target !== 'defaults') {
    return { view: { ...view(), notice: 'env 目标必须是 token 或 defaults' }, done: false };
  }
  // ★ 与 `applySetLabel` 同一手艺：非对象一律拒，不把 `null` "善意理解"成清空。
  if (body.env === null || typeof body.env !== 'object' || Array.isArray(body.env)) {
    return { view: { ...view(), notice: '环境变量必须是 JSON 对象' }, done: false };
  }

  let name = '';
  if (body.target === 'token') {
    name = typeof body.name === 'string' ? body.name : '';
    const rows = Array.isArray(session.state.data.tokens) ? session.state.data.tokens : [];
    if (name === '' || !rows.some((/** @type {any} */ t) => t?.name === name)) {
      return { view: { ...view(), notice: `没有 token：${name === '' ? '（空）' : name}` }, done: false };
    }
  }

  const entries = Object.keys(/** @type {Record<string, unknown>} */ (body.env)).length;
  try {
    if (body.target === 'token') {
      mutateToken(ctx, name, (t) => {
        /** @type {Record<string, any>} */
        const next = { ...t };
        if (entries === 0) delete next.env;
        else next.env = body.env;
        return normalizeToken(next, name);
      });
    } else {
      mutateConfig(ctx, (config) => {
        /** @type {Record<string, any>} */
        const next = { ...config, defaults: { ...(config.defaults ?? {}) } };
        if (entries === 0) delete next.defaults.env;
        else next.defaults.env = body.env;
        // ★ 整份过 schema：`writeConfig` 不校验，这里不补的话坏形状要到下次
        //   `readConfig` 才炸——那时已经找不到"是谁写坏的"了。
        return normalizeConfig(next);
      });
    }
  } catch (err) {
    return { view: { ...view(), notice: message(err) }, done: false };
  }

  reloadPanel(session, ctx);
  // ★ 成功**不写** `notice`（与 `set-label` 同一条）：回执里的 `env` / `defaultsEnv`
  //   就是答案，对话框比对回执后自己关掉；再塞一句话只会盖掉上一次的失败提示。
  return { view: view(), done: false };
}

/**
 * `serveWeb()` 要的那两个 op。
 *
 * ★ `apply()` **永远回一个视图**，即使这一下是 no-op：页面拿的可能是旧状态
 *   （列表刚 reload 过、或者两个标签页在打架），回一份**当前**的视图正好
 *   把它拽回来。回 4xx 的话，前端除了"报个错"什么也做不了。
 *
 * ★★ `done` 只可能是 `quitting` 变 true 那一下。`quit` 这个 effect
 *   **不经过执行器**（`makeSession.feed` 就把它滤掉了）——所以"退出"这件事
 *   在这里是**读一个状态位**，不是"接住一个副作用"。这是 §1.3 第 1 条
 *   那个耦合的处理：`exec` 不认识 `quit`，网页桥自己拦。
 *
 * @param {ReturnType<typeof makeSession>} session
 * @param {import('../types.js').Ctx} ctx 解析用户敲的路径要用它（`home` / `cwd` / `platform`）
 * @returns {{ view: () => any, apply: (body: any) => Promise<{ view: any, done: boolean }> }}
 */
export function makeOps(session, ctx, deps = {}) {
  return {
    view: () => viewModel(session.state),
    apply: async (body) => {
      // ★ 「打开」在**这里**分叉，不进 reducer。
      if (body !== null && typeof body === 'object' && body.op === OPEN_OP) {
        const bad = await openInFileManager(body.value, ctx);
        const view = viewModel(session.state);
        // ★ 成功时**不写** `notice`：资源管理器窗口本身就是回执，硬塞一句话
        //   反而会把上一步的提示盖掉。失败时才借 `notice` 这个**已有**的键
        //   说一句——不新增视图模型字段（那条键集是跨项目冻结的）。
        return { view: bad === '' ? view : { ...view, notice: bad }, done: false };
      }
      // ★ 项目状态的两个 op，同样在 reducer 外面收口（理由见上面那一节）。
      if (body !== null && typeof body === 'object') {
        if (body.op === SET_STATUS_OP) return applySetStatus(session, ctx, body);
        if (body.op === SAVE_STATUSES_OP) return applySaveStatuses(session, ctx, body);
        // ★ 模型下拉与资源表（§2.14 十一）：同样在 reducer 外面收口。
        //   注意这里**没有** `await session.settle()`——这三下都不产生 effect。
        if (body.op === SET_MODEL_OP) return applySetModel(session, ctx, body);
        if (body.op === REFRESH_MODELS_OP) return applyRefreshModels(session, ctx, body);
        if (body.op === REFRESH_ALL_OP) return applyRefreshAll(session, ctx);
        // ★ 资源表的两个（§2.14 十二）：昵称与模型优先级。同样不进 reducer——
        //   TUI 里没有"给 token 改昵称"这回事。
        if (body.op === SET_LABEL_OP) return applySetLabel(session, ctx, body);
        if (body.op === SAVE_PRIORITY_OP) return applySavePriority(session, ctx, body);
        // ★ 资源表的池状态（§2.15 三）：检测（要网络）与手动标注（只写本地）。
        //   ⚠️ 手动那条叫 `set-pool-status` 而不是 `set-status`——后者是项目状态的，
        //   见那两个常量的注释。
        if (body.op === CHECK_TOKEN_OP) return applyCheckToken(session, ctx, body);
        if (body.op === SET_POOL_STATUS_OP) return applySetPoolStatus(session, ctx, body);
        // ★ 会话条上的「全部标已读」（§2.16 五）：与 `cxt msg inbox` 同一条 IO。
        if (body.op === MSG_READ_ALL_OP) return applyMsgReadAll(session, ctx, body);
        // ★ 最近关闭那一行的「恢复」：与 `cxt resume` 同一条启动路径。
        if (body.op === RESUME_SESSION_OP) return applyResumeSession(session, ctx, body, deps);
        // ★ 用量与花费（§2.15 九）：与 `cxt pool sync` 同一份记账，同样不进 reducer。
        if (body.op === SYNC_USAGE_OP) return applySyncUsage(session, ctx);
        // ★ 资源板块建 token（§2.14 十二末）：复用向导那条路，reducer 同样不动。
        if (body.op === ADD_TOKEN_OP) return applyAddToken(session, ctx, body);
        // ★ env 编辑器（§2.14 环境变量编辑器）：同样 bypass，reducer 一行不动。
        if (body.op === SAVE_ENV_OP) return applySaveEnv(session, ctx, body);
      }
      const ev = toEvent(body);
      if (ev !== null) {
        session.feed(ev);
        await session.settle();
      }
      return { view: viewModel(session.state), done: session.state.quitting === true };
    },
  };
}

// ═══════════════════════════ 驱动 ═══════════════════════════

/**
 * 起控制台、开浏览器、等着它被关掉。
 *
 * 退出有三条路，**都在 `serve-web.js` 里**（本文件一条都不装）：
 * 页面点了「退出」（`done: true`）、空闲超时、`Ctrl+C`。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {{ open?: boolean, idleMs?: number }} [opts] `open: false` = 只打印 URL
 *   （`--no-open`：口令不出终端、SSH 里可以自己转发端口）
 * @returns {Promise<number>} 退出码
 */
export async function runWeb(ctx, opts = {}) {
  const out = process.stdout;
  const err = process.stderr;
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });

  // ★ 与全屏面板**同一个位置、同一个理由**（`ui.js` 的 `run()`）：
  //   启动时顺手重算一次过期的用量，然后才取面板数据。放进 `buildPanelData()`
  //   就会变成"每敲一下、每刷新一次都写盘"。
  //   ★ 它也**永不抛**——控制台起不来的理由不该是"用量没算成"。
  autoSyncUsage(ctx);

  // ★ 初始状态与全屏面板**一模一样**：同一个 `buildPanelData(ctx)`、
  //   同一个 `appInitial()`。差一个字段的话，"两个前端看到的是同一份东西"
  //   这句话当场作废。
  const session = makeSession(ctx, appInitial(buildPanelData(ctx)));

  /** @type {Awaited<ReturnType<typeof serveWeb>>} */
  let server;
  try {
    server = await serveWeb({
      ops: makeOps(session, ctx),
      assets: loadAssets(),
      idleMs: opts.idleMs,
      // ★ 只记 `method path status ms`——**永不记 body**（那里面是明文密钥）。
      //   口令也进不来：`serve-web.js` 的 `pathForLog()` 把第一段剥掉了。
      //   写 stderr 而不是 stdout：stdout 上那几行是给人看的"怎么用"，
      //   请求流水是排查用的，混在一起两边都不好读。
      onLog: (e) => err.write(c.dim(`   ${e.method} ${e.path} ${e.status} ${e.ms}ms\n`)),
    });
  } catch (err2) {
    throw new CxtError(`本地控制台起不来：${message(err2)}`, {
      hint: '端口是系统分配的（不是写死的），所以冲突极少见；'
        + '真起不来就退回全屏面板：`cxt ui`',
    });
  }

  out.write(`\n  ${c.green('网页控制台已启动')}\n\n    ${c.bold(server.url)}\n\n`);

  if (opts.open === false) {
    out.write(`  ${c.dim('（--no-open：自己把上面那行粘进浏览器）')}\n\n`);
  } else {
    const r = await openHostBrowser(server.url);
    if (r.ok && r.via === 'app') {
      out.write(`  ${c.dim(`已用 ${r.browser} 的应用窗口打开（没有地址栏，像个客户端）`)}\n\n`);
    } else if (r.ok) {
      out.write(`  ${c.dim('已交给默认浏览器打开')}`
        + `${r.reason === '' ? '' : ` ${c.dim(`（${r.reason}）`)}`}\n\n`);
    } else {
      // ★ 开不出浏览器**不是**致命错误——用户手里有那行 URL。
      out.write(`  ${c.yellow('浏览器没打开')}${c.dim(`（${r.reason}）`)}`
        + `${c.dim('——把上面那行粘进浏览器就行')}\n\n`);
    }
  }

  // ★ 这句**总是**要打：控制台在 SSH 里、在没装浏览器的机器上、
  //   在只想看 URL 的场景下都是"打不开"的，而那时唯一能用的前端是 TUI。
  //   这也是保留 TUI 最强的理由（§九 E）。
  out.write(`  ${c.dim('打不开浏览器 / SSH / 无头环境？用 `cxt ui` 进全屏面板。')}\n`);
  out.write(`  ${c.dim('Ctrl+C 退出（空闲 30 分钟也会自己退）。')}\n\n`);

  try {
    // ★ 等 `closed`（**它关了**），不是等 `close()`（**我来关**）。
    //   空闲退出和 SIGINT 都不是本函数发起的，只有 `closed` 三种情况都会 resolve。
    await server.closed;
  } finally {
    // 跑到这儿说明服务已经关了。收尾两件事都不能省：
    // ① 掐掉在飞的 `fetch-models`（否则一个 20 秒的请求会吊着进程不退出）；
    // ② `close()` 是幂等的，SIGINT 那条路已经关过一次，这次是白跑。
    session.abort();
    await server.close();
  }

  out.write(`  ${c.dim('控制台已关闭。')}\n`);
  return EXIT.OK;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function message(err) {
  return err instanceof Error ? err.message : String(err);
}
