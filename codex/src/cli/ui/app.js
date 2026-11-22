// @ts-check
/**
 * ★ **面板状态机**（§面板）——纯函数：`reduce(state, ev) → { state, effects }`。
 *
 * 这个文件里没有 `fs`、没有 `fetch`、没有 `spawn`、没有 `process`。
 * **所有副作用都以数据形式（`effects` 数组）交出去**，由 `commands/ui.js` 执行，
 * 执行完把结果**再喂回来**：
 *
 * ```
 *   keys.js ──按键──┐
 *                   ├──▶ app.js（本文件）──effects──▶ commands/ui.js ──▶ fs / fetch / spawn
 *   commands ──结果──┘                                          │
 *                                                               └── 结果事件喂回来
 * ```
 *
 * 这样整条状态迁移链在测试里**同步跑完**——没有 TTY、没有网络、没有等待、没有 mock 库。
 * 而"面板会不会在某个按键上卡死"这类问题，全都能在纯函数层面穷举出来。
 *
 * ## ★★ 第二条输入通道（§面板 · Web 控制台）
 *
 * 网页控制台把**表单动作**直接送进来（`{type:'panel', op, …}`），不走按键。
 * 理由只有一条：**调序这件事任何按键序列都表达不了**——`checked` 的顺序
 * 只可能是「勾选时追加」，没有哪个键能让第 3 项升到第 2 项。
 *
 * 但 op 与按键**走同一条分发**（`step()` 里按 `state.screen` 分流），而且
 * 步骤相关的 op 一律**回放成按键**（`replay()`）——于是"第 3 步的 `Enter`
 * 是什么意思"仍然只有一处定义，两个前端不会各错一半。
 *
 * ⚠️ 本文件的注释里**只许写节名**（「面板 · Web 控制台」），**永远不许写节号**——
 * 它与另一个项目的同名文件**逐字一致**，而那一节在两边的号数**不一样**
 * （契约 §4.1 那条规矩本来就预见了这件事）。
 *
 * ## ★ 光标窗口的高度**从 `render.js` 现算**，不在这儿数第二遍
 *
 * 正文高度随页脚行数变（§面板 五），各屏的列表又被标题占掉不同的行数。
 * 这个算术**只有一处**：`listHeight()`。自己再数一遍的表现是
 * 「光标能走到看不见的地方」——而那种 bug 只在特定尺寸下出现。
 *
 * ## ★ 输入模式独占键盘
 *
 * 输入框聚焦时，`q`/`n`/`r` 这些**都是文本**，不是命令。只有 `Esc`（返回上一层）
 * 与 `Ctrl+C`（直接退出）例外——它们是"我不管你在干什么"级别的按键。
 * 没有这条，用户在第 1 步输路径时打不出字母 `q`。
 */

import { listHeight, layout, pageMove, scrollTop, visibleModels } from './render.js';

// ───────────────────────────── 类型 ─────────────────────────────

/**
 * 左栏的一个**可启动项**。由 `commands/ui.js` 读配置后拼好——本文件不认识配置文件。
 *
 * @typedef {object} Item
 * @property {'cwd'|'binding'|'token'|'new'} kind
 * @property {string} label            左栏显示名
 * @property {string} [token]          绑定的 token 名（`new` 没有）
 * @property {string} [path]           启动目录（`new` 没有）
 * @property {'project'|'binding'|'token'|'default'|'none'} [layer]
 *   `e`（改模型）该写哪一层。`none` = 这一项没有可改的地方。
 * @property {Detail} [detail]         右栏详情（**已经打码过**）
 * @property {{id: string, label: string, color: string}} [status]
 *   项目状态（一个文件夹就是一个项目）。只有 `cwd` 与 `binding` 有——
 *   它是**浏览器那边**的东西，TUI 不认识它（§面板 · Web 控制台）。
 * @property {string[]} [modelOptions]
 *   模型下拉的候选（已声明在前、登记在后的去重清单）。同样只有网页那边用：
 *   TUI 的模型面板是「可选 / 已选」两栏，不需要这一份摊平的候选。
 */

/**
 * 右栏详情。★ `masked` 是**打码后**的串——明文密钥不许流到渲染层，
 * 渲染层一旦拿到明文，一个调试用的 `console.log(frame)` 就把它写进终端回滚缓冲了。
 *
 * @typedef {object} Detail
 * @property {string} masked        `sk-****abcd` / `(来自 ${ENV})`
 * @property {string} baseUrl
 * @property {string} source        `项目本地` / `路径绑定` / `默认`
 * @property {string} profile       `已建` / `未建`
 * @property {string} provider
 * @property {string[]} models
 * @property {number} active        生效模型在 `models` 里的下标（`-1` = 没配）
 * @property {number} catalog       服务端一共多少个（`0` = 不知道）
 */

/**
 * @typedef {object} TokenRow
 * @property {string} name
 * @property {string} masked
 * @property {string} baseUrl       给人看的那串（空的时候是「(未设置)」）
 * @property {string} [url]         原始值（`''` = 没配）。★ 第 2 步的联动要它——
 *   拿 `baseUrl` 去比会把两个"都没配"的 token 判成同一个地址。
 */

/**
 * 资源表的一行 = 一个 token（契约里「资源表：token 是身份」那节）。由 `commands/ui.js` 拼好，
 * 与 `TokenRow` 的区别是它多带**登记**（`resources.json` 里那份模型清单）。
 *
 * @typedef {object} ResourceRow
 * @property {string} name
 * @property {string} masked
 * @property {string} baseUrl       给人看的那串（空的时候是「(未设置)」）
 * @property {string} url           **生效**地址（token 层 → 全局默认），没配 = `''`
 * @property {string} cachedUrl     清单是从哪个地址拉的（没拉过 = `''`）
 * @property {string[]} models      登记里的模型 id（没拉过 = `[]`）
 * @property {string} fetchedAt     ISO 时间；没拉过 = `''`
 * @property {boolean} stale        `cachedUrl` 非空且与 `url` 不同 = 这份清单来自旧地址
 * @property {number} projects      显式声明了这个 token 的绑定条数（项目本地配置不扫）
 */

/**
 * @typedef {object} PanelData
 * @property {string} cwd
 * @property {Item[]} items
 * @property {TokenRow[]} tokens
 * @property {string} appName       标题栏里那个名字
 * @property {string} projectFile   项目本地配置的文件名
 * @property {{id: string, label: string, color: string}[]} [statuses]
 *   可选：可选的几档状态（§面板 · Web 控制台）。TUI 一个字都不用。
 * @property {ResourceRow[]} [resources]
 *   可选：资源表的行（同样只有网页用）。★ 由 **token 表**驱动——
 *   一个还没拉过清单的 token 也有一行，它的 `models` 是空的，不是"没有这行"。
 */

/**
 * 面板状态。**整棵树都是可 JSON 化的**——没有函数、没有闭包、没有类实例。
 * 这条不是洁癖：它让"把状态 dump 出来看看"在任何时候都可行。
 *
 * @typedef {object} State
 * @property {'list'|'wizard'} screen
 * @property {{cols: number, rows: number}} view  驱动侧 resize 时更新
 * @property {PanelData} data
 * @property {number} cursor
 * @property {number} top
 * @property {string} notice
 * @property {boolean} pending
 * @property {boolean} quitting        已经决定退出了；此后**任何输入都是空操作**
 * @property {Wizard|null} wizard
 * @property {{kind: 'delete-binding', path: string, label: string}|null} confirm
 */

/**
 * 向导状态。四步各自一个子对象——摊平在一个对象里的话，十几个字段
 * "这一步用哪几个"就得靠读代码猜。
 *
 * @typedef {object} Wizard
 * @property {1|2|3|4} step
 * @property {boolean} edit            从主屏 `e` 进来的（第 4 步只改模型，不新建绑定）
 * @property {{path: string, token: string, layer: string}} target
 * @property {{text: string, dirs: string[], dirCursor: number, dirTop: number, pending: boolean}} path
 * @property {{mode: 'pick'|'new', cursor: number, top: number, name: string, secret: string,
 *   field: 'name'|'secret', chosen: string, notice: string,
 *   baseUrl: string, urlEdited: boolean}} token
 *   ★ `baseUrl` 跟着 `chosen` 走；`urlEdited` = 用户动过它 ⇒ 第 4 步才写回
 *   `tokens/<名字>.json`（§面板 · Web 控制台 的第 2 步联动）。
 * @property {{phase: 'idle'|'loading'|'ok'|'fail', error: string, ids: string[],
 *   checked: string[], cursor: number, top: number, filter: string, filtering: boolean,
 *   manual: boolean, manualText: string, notice: string}} models
 * @property {string} notice
 */

/**
 * 副作用。**是数据，不是 thunk**——thunk 会把 `fs`/`fetch` 的失败路径
 * 从测试里赶出去（"要么跑真的，要么 mock 掉"，而 mock 掉的那个不是真的）。
 *
 * @typedef {{type: 'quit'}} QuitEffect
 * @typedef {{type: 'launch', item: Item}} LaunchEffect
 * @typedef {{type: 'reload', clearNotice?: boolean}} ReloadEffect
 *   `clearNotice` = 这次重读是**用户按的那一下**（`r` / 「刷新」），
 *   它先前写的那句「读取配置…」是个**进行中**的提示，读完了就该消失。
 *   ⚠️ 向导写入之后的重读**不许**带它：那一次要留住「已写入 ✓」——
 *   那是**回执**，不是"还在读"。两者的区别只有发 effect 的人知道，
 *   所以判断放在这里，执行器照做即可（`reloaded` 自身沿用旧 `notice`）。
 * @typedef {{type: 'list-dirs', path: string}} ListDirsEffect
 * @typedef {{type: 'fetch-models', token: string}} FetchModelsEffect
 * @typedef {{type: 'save-token', name: string, secret: string, baseUrl?: string}} SaveTokenEffect
 * @typedef {{type: 'apply-wizard', path: string, token: string, models: string[],
 *   baseUrl?: string}} ApplyWizardEffect
 * @typedef {{type: 'apply-models', target: {path: string, token: string, layer: string},
 *   models: string[]}} ApplyModelsEffect
 * @typedef {{type: 'delete-binding', path: string}} DeleteBindingEffect
 * @typedef {QuitEffect|LaunchEffect|ReloadEffect|ListDirsEffect|FetchModelsEffect
 *   |SaveTokenEffect|ApplyWizardEffect|ApplyModelsEffect|DeleteBindingEffect} Effect
 */

/**
 * 喂回来的**结果事件**。与 `keys.js` 的事件共用一个 `type` 字段，
 * 但取值空间不重叠（那边是 `key`/`text`/`ctrl`/`paste`/`unknown`）——
 * 所以 `reduce()` 能在一个 switch 里分流，不需要第二个入口。
 *
 * @typedef {{type: 'resize', cols: number, rows: number}} ResizeEvent
 * @typedef {{type: 'reloaded', data: PanelData, notice?: string}} ReloadedEvent
 * @typedef {{type: 'dirs', path: string, names: string[]}} DirsEvent
 * @typedef {{type: 'models', token: string, ok: boolean, ids: string[], error: string}} ModelsEvent
 * @typedef {{type: 'launched', ok: boolean, error?: string}} LaunchedEvent
 * @typedef {{type: 'token-saved', ok: boolean, name: string, error?: string}} TokenSavedEvent
 * @typedef {{type: 'applied', ok: boolean, error?: string, wrote?: string[]}} AppliedEvent
 * @typedef {{type: 'deleted', ok: boolean, error?: string}} DeletedEvent
 * @typedef {{type: 'failed', error?: string}} FailedEvent
 */

/**
 * ★ **第二条输入通道**（§面板 · Web 控制台）——**语义**事件，不是按键。
 *
 * 网页控制台没有光标、没有退格、没有"第 3 行"这种概念，所以表单动作
 * 不能翻成按键再回放：调序尤其做不到（`checked` 的顺序只可能是勾选时追加）。
 *
 * 它与上面那些事件**走同一条分发**（`step()` 里按 `state.screen` 分流），
 * 所以两个前端的状态迁移永远一致——这正是它长在这里而不是长在
 * `commands/ui-web.js` 里的原因（"第 3 行是什么意思"只许有一处定义）。
 *
 * @typedef {object} PanelEvent
 * @property {'panel'} type
 * @property {string} op               动作名；认不出的一律 no-op
 * @property {number} [index]          列表行号（`activate`/`edit`/`delete`/`enter-dir`/`pick-token`）
 * @property {string} [id]             模型 id（`toggle-model`/`move-model`）
 * @property {number} [dir]            `move-model` 的方向，`-1` 上移 / `+1` 下移
 * @property {string} [value]          文本（`set-path`/`set-token-name`/`set-secret`/`manual-model`）
 */

// ───────────────────────────── 构造 ─────────────────────────────

/**
 * 初始状态。`view` 先给一个保守的默认值，驱动侧进屏后**立刻**发一个 `resize` 纠正它。
 *
 * @param {PanelData} data
 * @returns {State}
 */
export function initialState(data) {
  return {
    screen: 'list',
    view: { cols: 80, rows: 24 },
    data,
    cursor: 0,
    top: 0,
    notice: '',
    pending: false,
    quitting: false,
    wizard: null,
    confirm: null,
  };
}

/**
 * @param {string} cwd
 * @param {{step?: 1|2|3|4, edit?: boolean, path?: string, token?: string, layer?: string,
 *   checked?: string[], baseUrl?: string}} [opts]
 * @returns {Wizard}
 */
function newWizard(cwd, opts = {}) {
  return {
    step: opts.step ?? 1,
    edit: opts.edit === true,
    target: { path: opts.path ?? cwd, token: opts.token ?? '', layer: opts.layer ?? 'none' },
    path: {
      text: opts.path ?? cwd,
      dirs: [],
      dirCursor: 0,
      dirTop: 0,
      pending: false,
    },
    token: {
      mode: 'pick',
      cursor: 0,
      top: 0,
      name: '',
      secret: '',
      field: 'name',
      chosen: opts.token ?? '',
      notice: '',
      // ★ 与 `chosen` **成对**：换选中就换它（`pickToken()`）。
      //   `urlEdited` 只在用户亲手动过地址时为 true ⇒ 第 4 步才写回 token 文件。
      baseUrl: opts.baseUrl ?? '',
      urlEdited: false,
    },
    models: {
      phase: opts.checked ? 'loading' : 'idle',
      error: '',
      ids: [],
      checked: opts.checked ?? [],
      cursor: 0,
      top: 0,
      filter: '',
      filtering: false,
      manual: false,
      manualText: '',
      notice: '',
    },
    notice: '',
  };
}

// ───────────────────────────── 入口 ─────────────────────────────

/**
 * 吃一个事件，吐新状态 + 副作用。**不改入参**。
 *
 * ★ 文本事件按**字符**折开逐个走完整条分发：`ev.text` 可能是一整串
 * （用户打得快、或者一次粘贴进了普通文本），而其中第一个字符就可能**换了屏**
 * （`n` 开向导、`/` 进过滤态）。整串一次性处理的话，`nr` 的第二个字符
 * 会被当成主屏的 `r`（重新读配置），而用户其实已经站在向导第 1 步里了。
 *
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
export function reduce(state, ev) {
  if (ev?.type === 'text' && typeof ev.text === 'string' && ev.text.length > 1) {
    let s = state;
    /** @type {Effect[]} */
    const fx = [];
    for (const ch of ev.text) {
      const r = reduce(s, { type: 'text', text: ch });
      s = r.state;
      fx.push(...r.effects);
    }
    return { state: s, effects: fx };
  }
  return step(state, ev);
}

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function step(state, ev) {
  // ★★ 闸门。已经决定退出之后，**任何事件都不许再改变状态、也不许再发 effect**。
  //   位置必须在 `switch` 之前而不是各个分支里——放分支里就要每个分支记得判一次，
  //   而"每个地方都记得做某件事"正是迟早会漏的那种约定。
  //   注意 `resize` 也一并挡掉：退出途中重画是没意义的（驱动侧已经在收尾了）。
  if (state.quitting === true) return none(state);

  switch (ev?.type) {
    case 'resize':
      return none({ ...state, view: { cols: num(ev.cols), rows: num(ev.rows) } });

    case 'reloaded': {
      const len = ev.data.items.length;
      return none({
        ...state,
        data: ev.data,
        cursor: clampInt(state.cursor, 0, Math.max(0, len - 1)),
        top: 0,
        pending: false,
        notice: ev.notice ?? state.notice,
      });
    }

    case 'dirs':
      return dirsArrived(state, ev);
    case 'models':
      return modelsArrived(state, ev);
    case 'launched':
      // ★ 必须收 `pending`——不收的话它**永远**停在 true，
      //   而"面板以为还在启动中"是个没有出口的状态。
      return none({
        ...state,
        pending: false,
        notice: ev.ok ? '已启动 ✓' : `启动失败：${ev.error ?? '未知原因'}`,
      });
    case 'token-saved':
      return tokenSaved(state, ev);
    case 'applied':
      return applied(state, ev);
    case 'deleted':
      return none({
        ...state,
        confirm: null,
        notice: ev.ok ? '已删除绑定 ✓' : `删除失败：${ev.error ?? '未知原因'}`,
        pending: false,
      });

    // ★★ 兜底：**effect 执行时抛了异常**。由 `term.js` 在 `exec` 抛错或
    //   reject 时发出来，是"某个 executor 忘了自己处理失败"的网。
    //   没有这一条的话，一个 EPERM 会表现为"按了 Enter 什么都没发生"——
    //   正是 §6.2 要消灭的那种静默。
    //
    //   ⚠️ **不清 `wizard`**：存 token 失败时用户要留在原处重试，
    //   把向导收掉等于把他刚敲的名字和密钥一起扔掉。
    //   `confirm` 反过来要清：那是个模态框，操作已经结束了，
    //   留着它用户就被卡在一个没有出口的框里。
    case 'failed':
      return none({
        ...state,
        confirm: null,
        pending: false,
        notice: `出错了：${ev.error ?? '未知原因'}`,
      });

    default:
      break;
  }

  // ★ 确认框是**独占**的：它开着的时候，别的按键一律不通。
  //   否则"我按了 d，然后手滑按了 n，结果绑定没了还开了个向导"。
  if (state.confirm !== null) return confirmKey(state, ev);

  // ★ 第二条输入通道（§面板 · Web 控制台）与按键**走同一条分发**。
  //   位置在确认框之后：确认框开着的时候，面板的按钮同样一个都不通——
  //   "删除确认"这件事对两个前端是同一件事。
  if (ev?.type === 'panel') {
    return state.screen === 'list' ? panelList(state, ev) : panelWizard(state, ev);
  }

  return state.screen === 'list' ? listEvent(state, ev) : wizardEvent(state, ev);
}

// ───────────────────────────── 主屏 ─────────────────────────────

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function listEvent(state, ev) {
  if (ev.type === 'ctrl') return ev.key === 'c' ? quit(state) : none(state);
  if (ev.type === 'unknown') return none({ ...state, notice: `认不出的按键：${ev.raw}` });
  if (ev.type === 'paste') {
    // 主屏没有输入框。粘贴**必须说出来**——静默丢掉的话，用户会以为
    // "粘贴能用，只是没反应"，然后一直粘（§6.2 宁可明确，不要静默）。
    return none({ ...state, notice: '主屏没有输入框；粘贴只在向导里有效' });
  }

  const len = state.data.items.length;
  const h = listHeight(state, state.view);

  if (ev.type === 'key') {
    const moved = nav({ cursor: state.cursor, top: state.top }, ev.key, len, h);
    if (moved !== null) return none({ ...state, ...moved });

    if (ev.key === 'enter') return activate(state);
    if (ev.key === 'escape') return quit(state);
    return none(state);
  }

  if (ev.type !== 'text') return none(state);

  switch (ev.text) {
    case 'q':
      return quit(state);
    case 'n':
      return openWizard(state, newWizard(state.data.cwd));
    case 'r':
      // ★ `clearNotice`：这句「读取配置…」是**进行中**的提示，重读完就得擦掉
      //   （`reloaded` 自己不擦，见 `ReloadEffect` 的注释）。
      return {
        state: { ...state, notice: '读取配置…', pending: true },
        effects: [{ type: 'reload', clearNotice: true }],
      };
    case 'e':
      return startEdit(state);
    case 'd':
      return askDelete(state);
    default:
      return none(state);
  }
}

/**
 * `Enter`：启动，或者开向导。
 *
 * ★ **只产生一个 effect**（`launch`）——面板**不自己 spawn**。
 * spawn 是 `commands/ui.js` 的事，理由与 §4.2 同源：`ui/` 整层是纯的，
 * 而"启动一个新会话"要碰 `process`、要碰终端、要处理失败。
 *
 * @param {State} state
 * @returns {{ state: State, effects: Effect[] }}
 */
function activate(state) {
  const item = state.data.items[state.cursor];
  if (!item) return none(state);

  if (item.kind === 'new') return openWizard(state, newWizard(state.data.cwd));

  if (!item.token) {
    // 没有 token 就启动不了（没有身份）。**说出来**，而不是"按了没反应"。
    return none({ ...state, notice: `「${item.label}」没有绑定身份，先按 n 新建一个` });
  }
  return { state: { ...state, notice: '', pending: true }, effects: [{ type: 'launch', item }] };
}

/**
 * @param {State} state
 * @param {Wizard} w
 * @returns {{ state: State, effects: Effect[] }}
 */
function openWizard(state, w) {
  return {
    state: { ...state, screen: 'wizard', wizard: w, notice: '', confirm: null },
    effects: [{ type: 'list-dirs', path: w.path.text }],
  };
}

/** `e`：改模型。只改**当前生效那一层**，不做层级选择器（v1 边界）。 */
function startEdit(state) {
  const item = state.data.items[state.cursor];
  if (!item || item.kind === 'new') return none({ ...state, notice: '这一项不能改模型' });
  if (!item.token) return none({ ...state, notice: '这一项没有绑定身份，没有模型可改' });
  if (!item.layer || item.layer === 'none') {
    return none({ ...state, notice: '这一项的模型不来自可写的一层，改不了' });
  }

  const w = newWizard(state.data.cwd, {
    step: 3,
    edit: true,
    path: item.path,
    token: item.token,
    layer: item.layer,
    checked: item.detail?.models ?? [],
  });
  return {
    state: { ...state, screen: 'wizard', wizard: w, notice: '', confirm: null },
    effects: [{ type: 'fetch-models', token: item.token }],
  };
}

/** `d`：删绑定。**要确认**——它改的是全局配置文件，而且没有撤销。 */
function askDelete(state) {
  const item = state.data.items[state.cursor];
  if (!item || item.kind !== 'binding' || !item.path) {
    return none({ ...state, notice: '只有路径绑定能删' });
  }
  return none({ ...state, confirm: { kind: 'delete-binding', path: item.path, label: item.label } });
}

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function confirmKey(state, ev) {
  const c = state.confirm;
  if (c === null) return none(state);

  // ★★ **只有明确的 `y` 才算同意**——`Enter` 不算。
  //
  // 这里原来把 `Enter` 也当成"是"，而标题行一直写着 `[y/N]`。两者对不上，
  // 而**错的那一半是代码**：`[y/N]` 的写法（大写 N）就是在说"默认是否"，
  // 而 `Enter` 恰恰是用户在面板上最顺手的那个键（它还是"启动"键，
  // 肌肉记忆已经建好了）。于是"手滑按了 d，再顺手按个回车"= 绑定没了，
  // 而且没有撤销。
  //
  // 判据不是"哪个更常见"，而是 §3.3 / `pick.js` 的 `promptConfirm()` 已经
  // 写死的那条纪律：**破坏性操作的默认值必须是否**——
  // 「回车、EOF、关管道、看不懂的输入，全都归到 `false`」。
  // 面板里回车是"取消"，与 `promptConfirm()` 逐字一致。
  //
  // ★ 网页控制台（§面板 · Web 控制台）是**例外**，而且是有意的：那边没有
  //   "回车"这个键，用户点的是一个**写着「删除」的按钮**——那个动作本身
  //   就是他明确说出的"是"。所以 `confirm-yes` 算同意，其余 op 一律当取消
  //   （包括 `confirm-no`，也包括页面拿旧状态点出来的任何东西）。
  const yes =
    (ev.type === 'text' && (ev.text === 'y' || ev.text === 'Y')) ||
    (ev.type === 'panel' && ev.op === 'confirm-yes');
  if (yes) {
    return {
      state: { ...state, confirm: null, pending: true, notice: '删除中…' },
      effects: [{ type: 'delete-binding', path: c.path }],
    };
  }
  return none({ ...state, confirm: null, notice: '已取消' });
}

/**
 * 退出。★ **置 `quitting` 之后这个状态就是终态**——见 `step()` 顶上的闸门。
 *
 * 为什么需要一个显式标志、而不是"反正驱动侧收到 quit 就不看了"：
 * 一次 `read()` 拿到的可能不止一个字符（连按、按键重复、慢终端合并），
 * 而 `reduce()` 是**逐字符**折开的 —— `'qq'` 会折成两次 `q`，
 * 第二次落在已经决定退出的状态上，于是**又发一个 `quit`**。
 * 效果是数据、驱动侧要一个个执行；"退出"这件事被说两遍，
 * 轻则重复写还原序列，重则第二个 effect 在第一个已经关掉终端之后才跑到。
 *
 * 更根本的一条：**决定退出之后，"下一个键是什么意思"这个问题没有答案**，
 * 所以诚实的答案是"什么都不做"。闸门放在 `step()` 里，
 * 于是"退出后还能按 n 打开向导"这类状态泄漏从结构上不可能发生。
 *
 * @param {State} state
 */
function quit(state) {
  return {
    state: { ...state, quitting: true, notice: '退出中…' },
    effects: [{ type: 'quit' }],
  };
}

// ─────────────── 第二条输入通道（§面板 · Web 控制台） ───────────────

/**
 * 把 op **回放成按键 / 文本**，再走一遍完整分发。
 *
 * ★ 这是为了「语义只有一处定义」：`next` 在第 1/2/3/4 步各自意味着什么、
 * `s` 要不要顺手清空勾选、`r` 是重拉模型还是重读配置——全由既有的
 * `stepPath` / `stepToken` / `stepModels` / `stepApply` 说了算。
 * 在面板这边照抄一遍，就是"两处各拼一遍、各错一半"。
 *
 * 回放的是 `key`/`text`，它们走的是既有那条路，**不会递归回本函数**。
 *
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function replay(state, ev) {
  return step(state, ev);
}

/**
 * 主屏的 `panel` op（§面板 · Web 控制台 屏 1）。
 *
 * `activate`/`edit`/`delete` 带的 `index` 来自 `view()` 吐出去的那一份
 * `items[]`，所以**越界 = 页面拿的是旧状态**（列表刚 reload 过、
 * 或者另一个标签页刚删了一条）。越界一律 **no-op**：夹到边界上会变成
 * "点了第 5 行却删了第 3 行"，那比"没反应"坏得多。
 *
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function panelList(state, ev) {
  switch (ev.op) {
    case 'quit': return quit(state);
    // ★ 这两个也走回放，不走直接调用：将来给 `r`/`n` 加一条前提
    //   （比如"正在 pending 时不许重读"），面板这边自动跟上。
    case 'reload': return replay(state, { type: 'text', text: 'r' });
    case 'new': return replay(state, { type: 'text', text: 'n' });
    default: break;
  }

  const at = seekItem(state, ev.index);
  if (at === null) return none(state);

  switch (ev.op) {
    case 'activate': return activate(at);
    case 'edit': return startEdit(at);
    case 'delete': return askDelete(at);
    default: return none(state);
  }
}

/**
 * 按 `index` 把光标**移到那一项上**，返回移好光标的新状态。
 *
 * @param {State} state
 * @param {unknown} index
 * @returns {State|null} `null` = 越界 / 不是整数（调用方一律 no-op）
 */
function seekItem(state, index) {
  const items = state.data.items;
  if (nth(items, index) === undefined) return null;
  return { ...state, ...settle(state.top, Number(index), items.length, listHeight(state, state.view)) };
}

/**
 * `arr[index]`，**越界就给 `undefined`**。
 *
 * ★ 这里**绝不能**用 `clampInt`：它是"夹到范围内"的，于是"页面点了第 9 个目录"
 * 会静默变成"进了第 3 个目录"。面板的 index 来自一份**可能已经过期的**快照
 * （列表刚 reload 过、或者另一个标签页刚删了一条），越界只说明那份快照旧了——
 * 唯一的正确答案是**什么都不做**。
 *
 * @template T
 * @param {T[]} arr
 * @param {unknown} index
 * @returns {T|undefined}
 */
function nth(arr, index) {
  if (typeof index !== 'number' || !Number.isInteger(index)) return undefined;
  return arr[index];
}

/**
 * 向导的 `panel` op（§面板 · Web 控制台 屏 2）。
 *
 * ★ 每个 op 都**先验自己的前提**（在第几步、哪个子模式）。前提不成立就是
 * no-op——页面拿的是旧状态时，宁可"没反应"，也不要"在错误的步骤上执行了
 * 正确的动作"：那会**静默写错文件**，而用户看到的是一次成功。
 *
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function panelWizard(state, ev) {
  const w = state.wizard;
  if (w === null) return none(state);

  switch (ev.op) {
    // ── 两屏通用 ──
    case 'quit': return quit(state);
    case 'back': return wizardBack(state);
    case 'next': return replay(state, { type: 'key', key: 'enter' });

    // ── 第 1 步：路径 ──
    case 'set-path':
      return w.step === 1 ? setPath(state, sanitize(ev.value)) : none(state);
    case 'enter-dir': {
      if (w.step !== 1) return none(state);
      const name = nth(w.path.dirs, ev.index);
      return typeof name === 'string' ? setPath(state, joinPath(w.path.text, name)) : none(state);
    }

    // ── 第 2 步：身份 ──
    case 'pick-token': {
      if (w.step !== 2) return none(state);
      const row = nth(state.data.tokens, ev.index);
      return row === undefined ? none(state) : pickToken(state, row.name);
    }
    case 'new-token':
      return w.step === 2 ? replay(state, { type: 'text', text: 'n' }) : none(state);
    case 'set-token-name':
      return w.step === 2 && w.token.mode === 'new'
        ? none({ ...state, wizard: { ...w, token: { ...w.token, name: sanitize(ev.value), notice: '' } } })
        : none(state);
    case 'set-secret':
      return w.step === 2 && w.token.mode === 'new'
        ? none({ ...state, wizard: { ...w, token: { ...w.token, secret: sanitize(ev.value), notice: '' } } })
        : none(state);
    case 'save-token': {
      if (w.step !== 2 || w.token.mode !== 'new') return none(state);
      // ★ 表单里名字与密钥**同时可见**，所以名字这道坎在这儿补一次——
      //   TUI 那条路是 `Enter` 落在名字框上时先挡（`tokenNew`），
      //   而 TUI 上是可以 `Tab` 跳过名字框直接停在密钥框上的。
      if (w.token.name.trim() === '') {
        return none({ ...state, wizard: { ...w, token: { ...w.token, notice: '名字不能为空' } } });
      }
      return saveToken(state);
    }

    // ── 第 2 步：地址 ↔ 身份 的联动（§面板 · Web 控制台） ──
    //
    // ★★ 三个 op 都**只认第 2 步**（`select-token` / `confirm-token` 还要求
    //   `mode==='pick'`）。页面手里可能是旧状态（它还停在"新建"表单里、
    //   而服务端已经在第 3 步）——那种时候唯一的正确答案是**什么都不做**：
    //   "在错误的步骤上执行了正确的动作"会静默写错文件，而用户看到的是一次成功。
    case 'select-token': {
      if (w.step !== 2 || w.token.mode !== 'pick') return none(state);
      const row = nth(state.data.tokens, ev.index);
      if (row === undefined) return none(state);
      return none({
        ...state,
        wizard: {
          ...w,
          token: { ...w.token, chosen: row.name, baseUrl: urlOfRow(row), urlEdited: false, notice: '' },
        },
      });
    }
    case 'set-base-url': {
      if (w.step !== 2) return none(state);
      const url = sanitize(ev.value).trim();
      // ★ 双向联动：地址若正好属于**另一个 token**，选中项跟着切过去。
      //   而且此时 `urlEdited` 回到 false——那个地址本来就是它的，没什么要写回的。
      //   "新建"模式里没有"另一个 token"可切，原样记下。
      const owner = w.token.mode === 'pick' ? tokenWithUrl(state, url, w.token.chosen) : null;
      return none({
        ...state,
        wizard: {
          ...w,
          token: owner === null
            ? { ...w.token, baseUrl: url, urlEdited: true, notice: '' }
            : { ...w.token, chosen: owner, baseUrl: url, urlEdited: false, notice: '' },
        },
      });
    }
    case 'confirm-token': {
      if (w.step !== 2 || w.token.mode !== 'pick') return none(state);
      if (w.token.chosen === '') {
        return none({ ...state, wizard: { ...w, token: { ...w.token, notice: '先选一个身份' } } });
      }
      return fetchModelsFor(state, w.token.chosen);
    }

    // ── 第 3 步：模型 ──
    case 'toggle-model':
      return w.step === 3 ? toggleModel(state, ev.id) : none(state);
    case 'move-model':
      return w.step === 3 ? moveModel(state, ev.id, ev.dir) : none(state);
    case 'manual-model':
      return w.step === 3 ? addManualModel(state, ev.value) : none(state);
    case 'retry':
      return w.step === 3 ? replay(state, { type: 'text', text: 'r' }) : none(state);
    case 'skip':
      return w.step === 3 ? replay(state, { type: 'text', text: 's' }) : none(state);

    // ── 第 4 步：落点 ──
    // 第 4 步，或"改模型"那条短路（第 3 步 `Enter` 即写，与 TUI 一致）。
    // ★ 这里**直接调 `applyNow`**，不像别处那样回放 `Enter`：页面上那个按钮
    //   写着「写入」，它不该有"其实只是翻了一页"的可能。
    case 'apply':
      return w.step === 4 || w.edit ? applyNow(state) : none(state);

    default:
      return none(state);
  }
}

// ───────────────────────────── 向导 ─────────────────────────────

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function wizardEvent(state, ev) {
  const w = state.wizard;
  if (w === null) return none(state);

  // ★ 只有两个按键能穿过输入模式：`Esc`（回上一层）与 `Ctrl+C`（直接退出）。
  if (ev.type === 'ctrl') return ev.key === 'c' ? quit(state) : none(state);
  if (ev.type === 'key' && ev.key === 'escape') return wizardBack(state);
  if (ev.type === 'unknown') return none({ ...state, notice: `认不出的按键：${ev.raw}` });

  switch (w.step) {
    case 1: return stepPath(state, ev);
    case 2: return stepToken(state, ev);
    case 3: return stepModels(state, ev);
    default: return stepApply(state, ev);
  }
}

/**
 * `Esc`：**逐层退**。向导里退到主屏，主屏上才是退出。
 *
 * 这样"我在向导第 3 步想放弃"是连按三次 Esc，而不是**按一下就把面板关了**
 * ——后者会让用户丢掉刚敲的路径与刚选的 token。
 *
 * @param {State} state
 */
function wizardBack(state) {
  const w = state.wizard;
  if (w === null) return none(state);

  if (w.models.filtering) {
    return none({ ...state, wizard: { ...w, models: { ...w.models, filtering: false, filter: '' } } });
  }
  if (w.models.manual) {
    return none({ ...state, wizard: { ...w, models: { ...w.models, manual: false, manualText: '' } } });
  }
  if (w.token.mode === 'new') {
    return none({
      ...state,
      wizard: {
        ...w,
        token: {
          ...w.token,
          mode: 'pick',
          name: '',
          secret: '',
          field: 'name',
          notice: '',
          // 放弃的那份"新建"里如果挑过地址，**不能留下来**——它属于一个
          // 从没存在过的 token。回到选中项自己的地址。
          baseUrl: baseUrlOf(state.data, w.token.chosen),
          urlEdited: false,
        },
      },
    });
  }
  if (w.edit) return none({ ...state, screen: 'list', wizard: null, notice: '已取消' });
  if (w.step === 1) return none({ ...state, screen: 'list', wizard: null });

  const prev = /** @type {1|2|3} */ (w.step - 1);
  return none({ ...state, wizard: { ...w, step: prev, notice: '' } });
}

// ── 第 1 步：路径 ──

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function stepPath(state, ev) {
  const w = /** @type {Wizard} */ (state.wizard);
  const p = w.path;
  const h = listHeight(state, state.view);
  const len = p.dirs.length;

  if (ev.type === 'key') {
    const moved = nav({ cursor: p.dirCursor, top: p.dirTop }, ev.key, len, h);
    if (moved !== null) {
      return none({ ...state, wizard: { ...w, path: { ...p, dirCursor: moved.cursor, dirTop: moved.top } } });
    }

    if (ev.key === 'tab') {
      const pick = p.dirs[p.dirCursor];
      if (!pick) return none(state);
      return setPath(state, joinPath(p.text, pick));
    }
    if (ev.key === 'enter') {
      if (p.text.trim() === '') return none({ ...state, wizard: { ...w, notice: '路径不能为空' } });
      return none({ ...state, wizard: { ...w, step: 2, notice: '' } });
    }
    if (ev.key === 'backspace') {
      if (p.text === '') return none(state);
      return setPath(state, p.text.slice(0, -1));
    }
    if (ev.key === 'space') return setPath(state, `${p.text} `);
    return none(state);
  }

  if (ev.type === 'text') return setPath(state, p.text + sanitize(ev.text));
  if (ev.type === 'paste') return setPath(state, p.text + sanitize(ev.text), ev.truncated);

  return none(state);
}

/**
 * 改路径 → **重列子目录**。
 *
 * ⚠️ 每次按键都发一个 `list-dirs` effect，而结果是**异步**回来的。
 * 用 `ev.path === 当前文本` 做**陈旧响应守卫**：晚到的旧结果不许覆盖新列表
 * （否则快速敲路径时列表会跳回上一个目录的内容，看起来像"输错了"）。
 *
 * @param {State} state
 * @param {string} text
 * @param {boolean} [truncated]
 */
function setPath(state, text, truncated = false) {
  const w = /** @type {Wizard} */ (state.wizard);
  const next = {
    ...w,
    path: { ...w.path, text, dirs: [], dirCursor: 0, dirTop: 0, pending: true },
    notice: truncated ? '粘贴内容过长，已截断' : '',
  };
  return {
    state: { ...state, wizard: next },
    effects: [{ type: 'list-dirs', path: text }],
  };
}

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function dirsArrived(state, ev) {
  const w = state.wizard;
  if (w === null || w.step !== 1) return none(state);
  if (ev.path !== w.path.text) return none(state); // ★ 陈旧响应，丢掉
  return none({
    ...state,
    wizard: { ...w, path: { ...w.path, dirs: ev.names ?? [], dirCursor: 0, dirTop: 0, pending: false } },
  });
}

// ── 第 2 步：身份 ──

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function stepToken(state, ev) {
  const w = /** @type {Wizard} */ (state.wizard);
  const t = w.token;

  if (t.mode === 'new') return tokenNew(state, ev);

  const len = state.data.tokens.length + 1; // 末行是「+ 新建 token…」
  const h = listHeight(state, state.view);

  if (ev.type === 'key') {
    const moved = nav({ cursor: t.cursor, top: t.top }, ev.key, len, h);
    if (moved !== null) {
      return none({ ...state, wizard: { ...w, token: { ...t, cursor: moved.cursor, top: moved.top } } });
    }
    if (ev.key !== 'enter') return none(state);

    if (t.cursor >= state.data.tokens.length) {
      return none({ ...state, wizard: { ...w, token: { ...t, mode: 'new', name: '', secret: '', field: 'name', notice: '', baseUrl: '', urlEdited: false } } });
    }
    const row = state.data.tokens[t.cursor];
    return pickToken(state, row.name);
  }

  if (ev.type === 'text' && ev.text === 'n') {
    return none({ ...state, wizard: { ...w, token: { ...t, mode: 'new', name: '', secret: '', field: 'name', notice: '', baseUrl: '', urlEdited: false } } });
  }
  return none(state);
}

/**
 * 选定身份 → 进第 3 步并**立刻拉模型**。
 *
 * ★ `baseUrl` 跟着身份走（`tokens[].url` 就是它的来源）。第三方调用方
 * （`tokenSaved()` 里刚存下的那个 token 还不在 `data` 里）可以显式给一个。
 *
 * @param {State} state
 * @param {string} name
 * @param {string} [baseUrl] 不给就按 `name` 从 `state.data.tokens` 里查
 * @returns {{ state: State, effects: Effect[] }}
 */
function pickToken(state, name, baseUrl = baseUrlOf(state.data, name)) {
  const w = /** @type {Wizard} */ (state.wizard);
  const next = {
    ...w,
    step: /** @type {3} */ (3),
    token: {
      ...w.token,
      chosen: name,
      baseUrl,
      // 地址是从 token 文件里读出来的，不是用户改的 ⇒ 第 4 步没有要写回的
      urlEdited: false,
      mode: /** @type {'pick'} */ ('pick'),
      notice: '',
    },
    models: { ...w.models, phase: /** @type {'loading'} */ ('loading'), error: '', ids: [], cursor: 0, top: 0, notice: '' },
  };
  return {
    state: { ...state, wizard: next },
    effects: [{ type: 'fetch-models', token: name }],
  };
}

/**
 * "进入第 3 步并拉模型"那一步——`pickToken()` 与 `confirm-token` 共用。
 *
 * ★ 与 `pickToken()` 的差别：**不动 `token` 这一整块**。所以
 *   - 不改 `chosen`（网页上"选身份"与"下一步"是两个动作：选一下就要联网拉清单，
 *     会让人以为选错了也没法回头）；
 *   - 刚敲的 `baseUrl` 与写回记号 `urlEdited` **原样留着**——用户在第 2 步
 *     改了地址再按下一步，那处修改不该在翻页时被悄悄抹掉（TUI 那条走的是
 *     `pickToken()`，键盘那边没有"改地址"这个动作）。
 *
 * @param {State} state
 * @param {string} name
 * @returns {{ state: State, effects: Effect[] }}
 */
function fetchModelsFor(state, name) {
  const w = /** @type {Wizard} */ (state.wizard);
  return {
    state: {
      ...state,
      wizard: {
        ...w,
        step: /** @type {3} */ (3),
        models: { ...w.models, phase: /** @type {'loading'} */ ('loading'), error: '', ids: [], cursor: 0, top: 0, notice: '' },
      },
    },
    effects: [{ type: 'fetch-models', token: name }],
  };
}

/**
 * 一行 token 的**原始**地址（`''` = 没配）。
 * 不用 `TokenRow.baseUrl`——那是给人看的，空的时候写着「(未设置)」。
 * @param {any} row
 * @returns {string}
 */
function urlOfRow(row) {
  return typeof row?.url === 'string' ? row.url : '';
}

/**
 * @param {PanelData} data
 * @param {string} name
 * @returns {string}
 */
function baseUrlOf(data, name) {
  const rows = Array.isArray(data?.tokens) ? data.tokens : [];
  const row = rows.find((r) => r.name === name);
  return row === undefined ? '' : urlOfRow(row);
}

/**
 * 这个地址是不是**某个 token 的**？是就把它的名字给回来（双向联动的关键）。
 *
 * ★ 多个 token 共用同一个地址时**优先留在当前这个**——用户只是把地址
 *   重新选成了它原本的值，不该顺带把他选中的身份换掉。
 *
 * @param {State} state
 * @param {string} url
 * @param {string} current 当前选中的 token 名（可能是 `''`）
 * @returns {string|null} 空串地址 / 没人认领 → `null`
 */
function tokenWithUrl(state, url, current) {
  if (url === '') return null;
  const rows = Array.isArray(state.data?.tokens) ? state.data.tokens : [];
  const matches = rows.filter((r) => urlOfRow(r) === url);
  if (matches.length === 0) return null;
  const same = matches.find((r) => r.name === current);
  return (same ?? matches[0]).name;
}

/**
 * 「+ 新建 token」：两个输入框（名字、密钥）。
 *
 * ★ **密钥全程掩码显示**（§面板 四）——而掩码是**渲染层**用 `secret.length` 画的，
 * 明文一个字节都不进帧。这条有测试钉着（`render.test.js`）。
 *
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function tokenNew(state, ev) {
  const w = /** @type {Wizard} */ (state.wizard);
  const t = w.token;
  const set = (/** @type {Partial<typeof t>} */ patch) =>
    none({ ...state, wizard: { ...w, token: { ...t, ...patch } } });

  if (ev.type === 'key') {
    if (ev.key === 'tab') return set({ field: t.field === 'name' ? 'secret' : 'name' });
    if (ev.key === 'backspace') {
      const cur = t.field === 'name' ? t.name : t.secret;
      return set({ [t.field]: cur.slice(0, -1) });
    }
    if (ev.key === 'space') {
      // 名字里可以打空格；密钥里不行（sk-… 从不含空格，而空格是粘贴事故的常见残留）
      return t.field === 'name' ? set({ name: `${t.name} ` }) : none(state);
    }
    if (ev.key === 'enter') {
      if (t.field === 'name') {
        if (t.name.trim() === '') return set({ notice: '名字不能为空' });
        return set({ field: 'secret', notice: '' });
      }
      return saveToken(state);
    }
    return none(state);
  }

  if (ev.type === 'text') {
    const cur = t.field === 'name' ? t.name : t.secret;
    return set({ [t.field]: cur + sanitize(ev.text) });
  }
  if (ev.type === 'paste') {
    const cur = t.field === 'name' ? t.name : t.secret;
    return set({
      [t.field]: cur + sanitize(ev.text),
      notice: ev.truncated ? '粘贴内容过长，已截断' : '',
    });
  }
  return none(state);
}

/**
 * 真正发出 `save-token`。**TUI 的 `Enter`（落在密钥框上）与网页控制台的
 * 「保存」共用这一处**（§面板 · Web 控制台）——不提出来的话，两边对
 * "密钥为空怎么办"迟早给出两种提示，而那是同一件事。
 *
 * ⚠️ 这里**不校验名字**。TUI 上名字那道坎在 `Enter` 落在名字框时已经过了，
 * 在这儿再判一次会**改变既有行为**：`Tab` 是可以跳过名字框、直接停在
 * 密钥框上的，今天那样能存下去。面板那条路的名字校验在 `panelWizard` 里补。
 *
 * @param {State} state
 * @returns {{ state: State, effects: Effect[] }}
 */
function saveToken(state) {
  const w = /** @type {Wizard} */ (state.wizard);
  const t = w.token;

  if (t.secret.trim() === '') {
    return none({ ...state, wizard: { ...w, token: { ...t, field: 'secret', notice: '密钥不能为空' } } });
  }
  /** @type {any} */
  const fx = { type: 'save-token', name: t.name.trim(), secret: t.secret.trim() };
  // ★ 只有**真的填了**才带上这个键：TUI 那条路从不给地址，而测试用 `deepEqual`
  //   钉着 `{type:'save-token', name, secret}` 这个形状（两个前端同一个落点）。
  //   多一个恒为空的 `baseUrl` 只会让那条断言去守一个没人用的字段。
  const url = t.baseUrl.trim();
  if (url !== '') fx.baseUrl = url;

  return {
    state: { ...state, pending: true, wizard: { ...w, token: { ...t, notice: '保存中…' } } },
    effects: [fx],
  };
}

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function tokenSaved(state, ev) {
  const w = state.wizard;
  if (w === null) return none({ ...state, pending: false });

  if (!ev.ok) {
    return none({
      ...state,
      pending: false,
      wizard: { ...w, token: { ...w.token, notice: `保存失败：${ev.error ?? '未知原因'}` } },
    });
  }
  // 存好了：拿这个名字当选中身份，直接进第 3 步。
  // ⚠️ 同时发一个 `reload`——新 token 要出现在主屏与第 2 步的列表里。
  //    重读**不动向导**（`reloaded` 只换 `data`），所以中途重读是安全的。
  // ★ 地址走显式参数：这个 token 还不在 `state.data.tokens` 里，默认查不到。
  const r = pickToken({ ...state, pending: false }, ev.name, w.token.baseUrl.trim());
  return { state: r.state, effects: [...r.effects, { type: 'reload' }] };
}

// ── 第 3 步：模型 ──

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function stepModels(state, ev) {
  const w = /** @type {Wizard} */ (state.wizard);
  const m = w.models;

  if (m.filtering) return modelFilter(state, ev);
  if (m.manual) return modelManual(state, ev);

  const rows = visibleModels(m);
  const h = listHeight(state, state.view);

  if (ev.type === 'key') {
    const moved = nav({ cursor: m.cursor, top: m.top }, ev.key, rows.length, h);
    if (moved !== null) {
      return none({ ...state, wizard: { ...w, models: { ...m, cursor: moved.cursor, top: moved.top } } });
    }

    if (ev.key === 'space') return toggleModel(state, rows[m.cursor]);
    if (ev.key === 'enter') {
      if (w.edit) return applyNow(state);
      return none({ ...state, wizard: { ...w, step: 4, notice: '' } });
    }
    return none(state);
  }

  if (ev.type !== 'text') return none(state);

  switch (ev.text) {
    case '/':
      return none({ ...state, wizard: { ...w, models: { ...m, filtering: true, filter: '', cursor: 0, top: 0 } } });
    case 'r':
      return {
        state: { ...state, wizard: { ...w, models: { ...m, phase: 'loading', error: '', cursor: 0, top: 0, notice: '' } } },
        effects: [{ type: 'fetch-models', token: w.token.chosen }],
      };
    case 'm':
      return none({ ...state, wizard: { ...w, models: { ...m, manual: true, manualText: '' } } });
    case 's':
      // 跳过：**清空勾选**再走。留着勾了一半的列表走人，第 4 步会写出
      // 一个用户以为"跳过了"的模型列表——那是最糟的一种"我按了但你没听"。
      return none({
        ...state,
        wizard: { ...w, step: 4, models: { ...m, checked: [], notice: '已跳过模型选择' } },
      });
    default:
      return none(state);
  }
}

/** `/` 过滤态：输入的每个字符都进过滤串，`Enter`/`Esc` 收工。 */
function modelFilter(state, ev) {
  const w = /** @type {Wizard} */ (state.wizard);
  const m = w.models;
  const set = (/** @type {Partial<typeof m>} */ patch) =>
    none({ ...state, wizard: { ...w, models: { ...m, ...patch } } });

  if (ev.type === 'key') {
    if (ev.key === 'enter' || ev.key === 'escape') {
      // Esc 在 wizardEvent 那层就被吃掉了（回上一层），所以这里只管 Enter。
      return set({ filtering: false, filter: '', cursor: 0, top: 0 });
    }
    if (ev.key === 'backspace') return set({ filter: m.filter.slice(0, -1), cursor: 0, top: 0 });
    if (ev.key === 'space') return set({ filter: `${m.filter} ` });
    return none(state);
  }
  if (ev.type === 'text') return set({ filter: m.filter + sanitize(ev.text), cursor: 0, top: 0 });
  if (ev.type === 'paste') return set({ filter: m.filter + sanitize(ev.text), cursor: 0, top: 0 });
  return none(state);
}

/** `m` 手敲 id 态。**拉不到模型列表时的主要出路**（§面板 四）。 */
function modelManual(state, ev) {
  const w = /** @type {Wizard} */ (state.wizard);
  const m = w.models;
  const set = (/** @type {Partial<typeof m>} */ patch) =>
    none({ ...state, wizard: { ...w, models: { ...m, ...patch } } });

  if (ev.type === 'key') {
    if (ev.key === 'backspace') return set({ manualText: m.manualText.slice(0, -1) });
    if (ev.key === 'enter') {
      const p = manualPatch(m, m.manualText);
      // ★ 空 id 时**不退出手敲态**：用户正要重打一个，把他弹出去等于让他再按一次 `m`。
      //   所以"退出"跟着"收下了"走，而不是跟着"按了回车"走。
      if (p === null) return set({ notice: MANUAL_EMPTY });
      return set({ ...p, manual: false, manualText: '' });
    }
    return none(state);
  }
  if (ev.type === 'text') return set({ manualText: m.manualText + sanitize(ev.text) });
  if (ev.type === 'paste') return set({ manualText: m.manualText + sanitize(ev.text) });
  return none(state);
}

/** 手敲了空 id 时的提示。**两个前端共用这一句**（§面板 · Web 控制台）。 */
const MANUAL_EMPTY = '模型 id 不能为空';

/**
 * 手敲的 id 加进已选——**TUI 的 `m` 模式与网页控制台共用这一处**
 * （§面板 · Web 控制台）。连"加进去之后说什么"都定在这儿，
 * 免得两边给出两种提示。
 *
 * ★ 返回 `null` = **没收下**（空 id）。接下来怎么办由调用方定，
 * 因为两边不一样：TUI 要**留在手敲态**让用户接着打，面板那边输入框
 * 本来就一直摆在那儿、没有"态"可退。
 *
 * @param {Wizard['models']} m
 * @param {unknown} raw
 * @returns {{checked: string[], notice: string}|null}
 */
function manualPatch(m, raw) {
  const id = sanitize(raw).trim();
  if (id === '') return null;
  // ★ 用 `addChecked` 而不是直接 push：重复的 id 不该在已选区里排两遍
  return { checked: addChecked(m.checked, id), notice: `已加入 ${id}` };
}

/**
 * 网页控制台那条「加入」按钮（§面板 · Web 控制台）。
 * 与 TUI 的手敲态**同一个落点**——`manualPatch`。
 *
 * @param {State} state
 * @param {unknown} value
 * @returns {{ state: State, effects: Effect[] }}
 */
function addManualModel(state, value) {
  const w = /** @type {Wizard} */ (state.wizard);
  const m = w.models;
  const p = manualPatch(m, value);
  return none({ ...state, wizard: { ...w, models: { ...m, ...(p ?? { notice: MANUAL_EMPTY }) } } });
}

/**
 * ★ **勾选顺序即优先级**（§面板 四）——所以 `checked` 是**数组**不是集合，
 * 取消再勾上会**排到末尾**。这不是 bug，是"最后勾的那个优先级最低"这个语义。
 *
 * @param {string[]} checked
 * @param {string|undefined} id
 */
function toggleModel(state, id) {
  if (id === undefined) return none(state);
  const w = /** @type {Wizard} */ (state.wizard);
  const m = w.models;
  const next = m.checked.includes(id)
    ? m.checked.filter((x) => x !== id)
    : addChecked(m.checked, id);
  return none({ ...state, wizard: { ...w, models: { ...m, checked: next } } });
}

/**
 * @param {string[]} checked
 * @param {string} id
 * @returns {string[]}
 */
function addChecked(checked, id) {
  return checked.includes(id) ? checked : [...checked, id];
}

/**
 * ★★ **调序——网页控制台里唯一真新增的能力**（§面板 · Web 控制台）。
 *
 * 其余 op 都能在既有 handler 里找到落点（步骤相关的还一律回放成按键），
 * 只有这一个不行：`checked` 的顺序**只可能是「勾选时追加」**，
 * 没有任何按键序列能让第 3 项升到第 2 项。而勾选顺序**就是**优先级
 * （§面板 四），所以调序是"这个功能到底有没有用"的分水岭。
 *
 * ★ **两端越界 = no-op，不是绕回**。第一项再往上、最后一项再往下，都什么都不做：
 * 循环调序会让用户"点了一下 ↑，优先级却从第一掉到最末"——那种惊吓比没反应坏得多。
 * 页面上那两个按钮的 `disabled` 也照这个算，而且是**在视图模型里预先算好的**
 * （`canUp`/`canDown`），浏览器里没有 `i === 0` 这种逻辑。
 *
 * @param {State} state
 * @param {string|undefined} id
 * @param {number|undefined} dir      `-1` 上移 / `+1` 下移
 * @returns {{ state: State, effects: Effect[] }}
 */
function moveModel(state, id, dir) {
  if (typeof id !== 'string' || (dir !== -1 && dir !== 1)) return none(state);

  const w = /** @type {Wizard} */ (state.wizard);
  const m = w.models;
  const i = m.checked.indexOf(id);
  if (i < 0) return none(state); // 没勾上的东西没有"位置"可言

  const j = i + dir;
  if (j < 0 || j >= m.checked.length) return none(state); // ★ 两端越界

  const next = m.checked.slice();
  next[i] = next[j];
  next[j] = id;
  return none({ ...state, wizard: { ...w, models: { ...m, checked: next } } });
}

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function modelsArrived(state, ev) {
  const w = state.wizard;
  if (w === null || w.step !== 3) return none(state);
  if (ev.token !== w.token.chosen) return none(state); // ★ 陈旧响应

  const m = w.models;
  return none({
    ...state,
    pending: false,
    wizard: {
      ...w,
      models: {
        ...m,
        phase: ev.ok ? 'ok' : 'fail',
        ids: ev.ok ? ev.ids : [],
        error: ev.ok ? '' : (ev.error || '拉不到模型列表'),
        cursor: 0,
        top: 0,
      },
    },
  });
}

// ── 第 4 步：落点 ──

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function stepApply(state, ev) {
  const w = /** @type {Wizard} */ (state.wizard);

  if (ev.type === 'key' && ev.key === 'enter') return applyNow(state);
  if (ev.type === 'text' && ev.text === 'q') return wizardBack(state);
  return none(state);
}

/**
 * ★ 第 4 步的落点：**两个都写**（§面板 四）。
 * 写哪两个是 `commands/ui.js` 的事；这里只说"用这个路径、这个身份、这些模型"。
 *
 * @param {State} state
 * @returns {{ state: State, effects: Effect[] }}
 */
function applyNow(state) {
  const w = /** @type {Wizard} */ (state.wizard);
  const models = w.models.checked;

  if (w.edit) {
    return {
      state: { ...state, pending: true, wizard: { ...w, notice: '写入中…' } },
      effects: [{ type: 'apply-models', target: w.target, models }],
    };
  }
  if (w.token.chosen === '') {
    return none({ ...state, wizard: { ...w, notice: '没有选定身份' } });
  }
  return {
    state: { ...state, pending: true, wizard: { ...w, notice: '写入中…' } },
    effects: [{
      type: 'apply-wizard',
      path: w.path.text.trim(),
      token: w.token.chosen,
      models,
      // ★ 只在用户**动过**地址时才带：没动过就不该有一个"写回同一个值"的动作
      //   （那会让回执里出现一行没变化的「服务端 → …」）。
      //   清空地址也要写回（`baseUrl: ''`）——那是"把这个 token 的地址去掉"。
      ...(w.token.urlEdited ? { baseUrl: w.token.baseUrl.trim() } : {}),
    }],
  };
}

/**
 * @param {State} state
 * @param {any} ev
 * @returns {{ state: State, effects: Effect[] }}
 */
function applied(state, ev) {
  if (!ev.ok) {
    const w = state.wizard;
    return none({
      ...state,
      pending: false,
      notice: `写入失败：${ev.error ?? '未知原因'}`,
      wizard: w === null ? null : { ...w, notice: `写入失败：${ev.error ?? '未知原因'}` },
    });
  }

  const wrote = Array.isArray(ev.wrote) && ev.wrote.length > 0 ? `（${ev.wrote.join(' + ')}）` : '';
  return {
    state: {
      ...state,
      screen: 'list',
      wizard: null,
      cursor: 0,
      top: 0,
      pending: true,
      notice: `已写入 ✓ ${wrote}`.trim(),
    },
    // 写完了要把新配置读回来——否则主屏还是旧的，用户会以为没生效
    effects: [{ type: 'reload' }],
  };
}

// ───────────────────────────── 小件 ─────────────────────────────

/**
 * 列表导航。**所有列表共用它**——一处算术，处处一致。
 *
 * @param {{cursor: number, top: number}} list
 * @param {string} key
 * @param {number} len
 * @param {number} h
 * @returns {{cursor: number, top: number}|null} `null` = 不是导航键
 */
function nav(list, key, len, h) {
  const cursor = clampInt(list.cursor, 0, Math.max(0, len - 1));
  const top = clampInt(list.top, 0, Math.max(0, len - h));

  switch (key) {
    case 'up': return settle(top, cursor - 1, len, h);
    case 'down': return settle(top, cursor + 1, len, h);
    case 'home': return settle(0, 0, len, h);
    case 'end': return settle(top, len - 1, len, h);
    // ★ PgUp/PgDn 必须显式滚 top（§面板 五）——只挪光标的话，
    //   光标在窗口顶部时按 PgDn 会"认为光标还在窗口里"而不滚。
    case 'pgup': return pageMove({ top, len, h, cursor, dir: -1 });
    case 'pgdn': return pageMove({ top, len, h, cursor, dir: 1 });
    default: return null;
  }
}

/** @param {number} top @param {number} cursor @param {number} len @param {number} h */
function settle(top, cursor, len, h) {
  const c = clampInt(cursor, 0, Math.max(0, len - 1));
  const t = clampInt(top, 0, Math.max(0, len - h));
  return { cursor: c, top: scrollTop({ top: t, len, h, cursor: c }) };
}

/**
 * ★ **输入框一律剥掉控制字符**（§面板 四）。
 *
 * 粘贴是输入 key 的主要方式，而复制来的 key 十有八九带一个尾换行——
 * 那个换行绝不能进 token 文件。剥在**输入框这一层**，不是剥在粘贴事件那一层：
 * 手动敲的与粘贴的走同一条路，才不会有"粘进去的干净、敲进去的不干净"这种
 * 一半对一半错的状态。
 *
 * @param {unknown} s
 */
export function sanitize(s) {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '');
}

/**
 * 拼路径。**不碰 fs**（`ui/` 整层是纯的）——只做字符串那一半。
 * 分隔符取 `text` 里已有的那个（Windows 用户敲 `\`、POSIX 用户敲 `/`）。
 *
 * @param {string} base
 * @param {string} name
 */
function joinPath(base, name) {
  if (base === '') return name;
  if (/[\\/]$/.test(base)) return base + name;
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base + sep + name;
}

/** @param {unknown} v */
function num(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** @param {number} n @param {number} lo @param {number} hi */
function clampInt(n, lo, hi) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * @param {State} state
 * @returns {{ state: State, effects: Effect[] }}
 */
function none(state) {
  return { state, effects: [] };
}

/**
 * 该屏的正文高度（**算给测试与驱动看的**，reducer 内部用 `listHeight`）。
 * @param {State} state
 */
export function bodyHeight(state) {
  return layout(state.view).bodyH;
}
