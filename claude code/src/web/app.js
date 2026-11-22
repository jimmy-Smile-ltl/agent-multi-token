/*
 * 网页控制台的前端（§面板 · Web 控制台）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## ★★ 这个文件与姊妹项目的那份**逐字相同**（「共享文件」那一节）
 *
 * 所以这里**不许**出现：工具名、环境变量名、契约节号、任何写死的路径或端口。
 * 工具名从视图模型的 `appName` 来，路径从视图模型来，API 地址是**相对 URL**
 * （`fetch('api/state')`）——服务器把页面挂在 `/<口令>/` 下，相对 URL 从那儿
 * 起正好解析对，于是这里**一行 base-path 逻辑都不需要**。
 *
 * ## 无框架、无构建、尽量无状态
 *
 * 一个 `render()` + 一个 `post()`，服务端每次回一份**完整的**视图模型，
 * 这边整屏重画。没有 diff、没有路由、没有虚拟 DOM。
 *
 * ★ 为什么不引框架：这是**零依赖**项目（「零依赖」那一节），而且——更要紧的——
 *   前端没有测试框架，**测不到的逻辑等于没测**。能测的部分全在服务器那边
 *   （`ui-web.js` 的视图模型与 `ui/app.js` 的 reducer），这边只做"把数据摆上去"。
 *
 * ★ 这里**确实有**几处本地状态（状态筛选、地址下拉的"自定义"模式、状态编辑
 *   对话框里那份草稿）。它们的共同点是：**都是"这一屏怎么摆"，不是"数据是
 *   什么"**——刷新一下页面就该没有的东西。凡是"关掉再开还在"的，一律归服务端。
 *
 * ## ★★ 只用 `textContent`，**永远不用 `innerHTML`**
 *
 * 模型 id、路径、身份名字都来自用户自己的配置文件——它们不是敌意输入，
 * 但"这一段拼进 HTML"这种写法，只要有一处漏了转义，这个页面就成了一个
 * 能读写本机配置的执行点。`textContent` 让那条路**结构上不存在**。
 * CSP 是第二道锁，不是第一道。
 *
 * ## ⚠️ 这个文件**不认识**"第几步该显示什么"
 *
 * 步骤条只据 `steps[].state` 设 `disabled`；↑/↓ 只据 `canUp`/`canDown` 设
 * `disabled`；确认框只据 `confirm` 画横幅。**判据一律在 reducer 里**
 * （`ui/app.js`），这边不做第二遍——"两处各判一次"就是迟早判得不一样。
 * ─────────────────────────────────────────────────────────────
 */

/** @param {string} id */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

/**
 * 地址下拉里那个"我自己敲一个"的哨兵值。
 *
 * ★ 服务端（`ui-web.js` 的 `CUSTOM_URL`）用的是**同一个字符串**，它是这个
 *   页面的协议的一部分——两边各写一遍是因为跨项目那道墙：那一边的文件这个
 *   页面根本 import 不到（它是 ESM 模块，这里没有构建步骤）。
 *   ⚠️ 改这里就必须改那边，而且两个项目一起改。
 */
const CUSTOM_URL = '__custom__';

/**
 * 模型下拉末尾那个"我要自己挑多个"的哨兵值。
 *
 * ★ 它**不上线**：选中它只换成另一个 op（`edit`，原来那个多选/排序/手敲的
 *   面板），服务端永远看不到这个字符串。所以它是页面自己的约定，
 *   只有这一处定义。
 *
 * ⚠️ 模型 id 里出现两段下划线包起来的保留词是极不可能的；真撞上了，
 *   用户只是没法从下拉里选它——手敲面板照旧能用。
 */
const MODEL_MORE = '__more__';

/**
 * 状态可用的颜色名。
 *
 * ★ 这里只负责**列出**（下拉里得有东西可选），值本身归样式的两套变量管；
 *   认出/拒绝哪一个仍然只有服务端一处（`validateStatuses()`）——
 *   这份列表短一个，用户只是少一个选项，不会写进去一个坏值。
 */
const COLORS = ['slate', 'blue', 'teal', 'green', 'amber', 'red', 'purple', 'pink'];

/** 颜色名 → 下拉里那句话 */
const COLOR_NAME = {
  slate: '灰',
  blue: '蓝',
  teal: '青',
  green: '绿',
  amber: '琥珀',
  red: '红',
  purple: '紫',
  pink: '粉',
};

// ───────────────────────────── 状态 ─────────────────────────────

/** 服务端最近一次给的视图模型。`null` = 还没连上。 */
let view = null;

/** 在飞的请求数。> 0 时所有控件都关掉——否则点了没反应还排一队。 */
let inflight = 0;

/**
 * 上一帧被**全局闸门**关掉的那些控件。
 *
 * ★★ 闸门是**一帧之内**的限制，不是永久状态，所以它必须可逆。没有这份记录时，
 *   闸门只能"加"不能"减"：一个**自己的规则不管它**的控件（第 1 步的「下一步」、
 *   第 2 步的两个下拉……）被关一次就再也回不来。触发条件很平常——两拍里发了
 *   两个动作（打字打快了、改完地址紧接着点上一步），第一拍回来时第二拍还在飞，
 *   那一帧 `isBusy()` 为真，于是整页从此点不动，而视图早已 `pending:false`。
 *
 * ★ 下一帧开头先把这些人原样放开，再让各自的规则重算——**顺序要紧**：
 *   反过来会把规则刚关上的控件又打开。
 */
let gated = new Set();

/** 页面点过「退出」了。之后一切动作都是空操作。 */
let closed = false;

/** 连不上 / 请求失败时要说的话。**优先于** `view.notice`。 */
let fatalText = '';

/** 首屏拉过一次了。轮询在它之前不跑（`boot()` 自己会拉）。 */
let booted = false;

/**
 * 左栏选中的状态筛选。`''` = 全部。
 *
 * ★ **纯客户端**：它不改变服务端的任何东西，也不会被下发。列表本来就整份
 *   在手，筛一下不需要一次往返——而且往返会让"点一下左栏"看起来像卡了一下。
 */
let filter = '';

/**
 * 左栏选中的那个**视图**：`'projects'`（绑定表）或 `'resources'`（身份表）。
 *
 * ★ 与 `filter` 同一类东西——**纯客户端**状态：两份数据都在同一个视图模型里，
 *   切换只是换一张表重画，不发请求、不写盘、不上线。所以它永远不会被服务端
 *   覆盖，刷新页面回到默认那一栏也是对的。
 */
let pane = 'projects';

/** 状态编辑对话框的草稿。`null` = 对话框没开。 */
let statusDraft = null;

/** 对话框里那句错误（服务端拒了之后原样显示在这儿，不抢全局那条提示）。 */
let statusError = '';

/** 模型优先级对话框的草稿（模型 id 的数组）。`null` = 对话框没开。 */
let priorityDraft = null;

/** 正在改哪个 token。草稿是它的一份副本，取消 = 整份丢掉。 */
let priorityName = '';

/** 优先级对话框里那句错误。 */
let priorityError = '';

/** 添加 token 对话框开没开（草稿就是那三个输入框自己的值，不用抄数组）。 */
let addOpen = false;

/** 添加 token 对话框里那句错误。 */
let addError = '';

/** 环境变量对话框开没开。草稿就是 textarea 里那段 JSON 文本。 */
let envOpen = false;

/** 环境变量对话框正在编辑哪个目标：`'token'`（行内按钮）或 `'defaults'`（表头按钮）。 */
let envTarget = 'token';

/** `envTarget === 'token'` 时对应的 token 名。 */
let envName = '';

/** 环境变量对话框里那句错误。 */
let envError = '';

const isBusy = () => closed || inflight > 0 || (view !== null && view.pending === true);

/**
 * 收下一份新视图。
 *
 * ★★ 「控制台结束了」这件事**只从视图里读**（`quitting`），不猜别的：
 *   ① 不猜"我刚发出去的那个 op 叫 `quit`"——那是把服务端的语义抄一份到前端；
 *   ② 不猜 `notice === '退出中…'`——拿一句**给人看的文案**当状态通道，
 *      文案一改，这条判断就静默失效。
 *
 * ★ `boot()` 也走这里：刷新一个已经退出的页面，应该看到同一句话，
 *   而不是一个看着还活着的控制台。
 *
 * @param {any} v 服务端回的视图模型
 */
function takeView(v) {
  view = v;
  if (v.quitting === true) closed = true;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function msg(err) {
  return err instanceof Error ? err.message : String(err);
}

// ───────────────────────── 与服务器说话 ─────────────────────────

/**
 * 动作队列的尾。
 *
 * ★★ **串行，不是"忙就丢"**。一次用户手势里可能冒出两个动作：路径框失焦会发
 *   `change`（把打完的路径推上去），紧接着目录 `<select>` 的 `change` 又发
 *   `enter-dir`。丢后一个的话，用户点了个目录却什么也没发生——而且**只在手快时**
 *   发生。服务端那边也串行化了一层（`serve-web.js`），这里是第一层。
 *
 * ★ 重复点击**不靠**这个队列挡：`render()` 的全局闸门在请求在飞时把控件全关了，
 *   一帧之内按钮就点不动了。
 */
let tail = Promise.resolve();

/**
 * 发一个表单动作，拿回一份新视图。
 *
 * ★ 动作对象**只有** `op` 加最多四个参数（`index`/`id`/`dir`/`value`）——
 *   服务端那边是白名单（`ui-web.js` 的 `toEvent()`），多塞的字段一律不落地。
 *   `statuses` 是唯一一个例外：它走的是那条**不进 reducer** 的旁路
 *   （`save-statuses`），在那条路上白名单不适用，校验在服务端的状态模块里。
 *
 * ★ 回的那份视图里 `quitting === true` = 服务端要关了（用户点了「退出」）。
 *   此后不再发请求（`takeView()` 把 `closed` 立起来，`post()` 直接返回）。
 *   ⚠️ 不是"读一个 `done` 字段"——那个字段不上线，见 `send()` 里那段注释。
 *
 * @param {string} op
 * @param {Record<string, any>} [args]
 * @returns {Promise<void>}
 */
async function post(op, args) {
  if (closed) return;
  inflight += 1;
  document.body.classList.add('busy');
  const run = tail.then(() => send(op, args));
  tail = run.then(noop, noop);
  try {
    await run;
  } finally {
    inflight -= 1;
    if (inflight === 0) document.body.classList.remove('busy');
    render();
  }
}

/** @returns {Promise<void>} */
async function send(op, args) {
  if (closed) return; // 排上队之后、轮到自己之前，用户点了「退出」
  try {
    const res = await fetch('api/op', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ op }, args)),
    });
    if (!res.ok) throw new Error(`服务端回了 ${res.status}`);
    // ★ `GET api/state` 与 `POST api/op` 回的是**同一个**视图模型，不是
    //   `{view, done}` 那种信封。服务端内部那个 `done` 是"回完这条就关"的
    //   收尾信号，**不上线**——上线的是视图里的 `quitting`。
    fatalText = '';
    takeView(await res.json());
  } catch (err) {
    fatalText = `这个动作没发出去：${msg(err)}。控制台可能已经退出了——刷新页面试试。`;
  }
}

function noop() {}

/** 首屏。`GET api/state` 与 `POST api/op` 拿的是**同一个**视图模型。 */
async function boot() {
  try {
    const res = await fetch('api/state');
    if (!res.ok) throw new Error(`服务端回了 ${res.status}`);
    takeView(await res.json());
  } catch (err) {
    fatalText = `连不上本地控制台：${msg(err)}。`;
  }
  booted = true;
  document.body.classList.remove('booting');
  render();
}

/**
 * 轮询：标签页**可见**时每 10 秒拉一次状态。
 *
 * ★ 只在可见时轮询；切后台就停——控制台「空闲 30 分钟自动关」靠的是"没人请求"，
 *   被一个遗忘的标签页钉住正是那条控制的失败模式。
 * ★ 有动作在飞时跳过这一拍（动作队列自己会回一份新视图，别和它抢）。
 * ★ 失败 = 控制台已退出（空闲关闭 / 进程被杀）：借页面横幅说出来，别白屏。
 */
const POLL_MS = 10000;
let polling = false;

async function refresh() {
  if (!booted || closed || polling || inflight > 0) return;
  if (document.visibilityState === 'hidden') return;
  polling = true;
  try {
    const res = await fetch('api/state');
    if (!res.ok) throw new Error(`服务端回了 ${res.status}`);
    takeView(await res.json());
    fatalText = '';
  } catch (err) {
    fatalText = `连不上本地控制台（${msg(err)}）——它可能已经退出，重新打开即可。`;
  } finally {
    polling = false;
  }
  render();
}

// ───────────────────────────── 重画 ─────────────────────────────

function render() {
  // ★ 先撤销上一帧的闸门，再画。谁该关着，下一段各自的规则会重新关回去；
  //   没有自己规则的控件则回到 HTML 里的默认态（多半是"能点"）。
  for (const el of gated) el.disabled = false;
  gated = new Set();

  paintFlash();
  if (view === null) return;

  const v = view;
  const busy = isBusy();

  // ★ 标题上的未读数——切回标签页的**第一眼**就知道有没有人在等你。
  //   两个数组都兜成 []：另一种版本的后台可能还没有这些键，页面只是少一个数字。
  const liveRowsForTitle = Array.isArray(v.sessions) ? v.sessions : [];
  const recentRowsForTitle = Array.isArray(v.recentSessions) ? v.recentSessions : [];
  const unreadTotal = liveRowsForTitle.reduce((n, s) => n + (s.unread ?? 0), 0)
    + recentRowsForTitle.reduce((n, s) => n + (s.unread ?? 0), 0);
  document.title = `${unreadTotal > 0 ? `(${unreadTotal}) ` : ''}${v.appName} · 控制台`;
  setText('app-name', v.appName);
  paintCwd(v.cwd);

  paintBanner(v);
  paintTop(v);
  paintFilters(v);
  // ★ 注意力清单只在列表屏（项目/资源）出现；进向导就藏起来——
  //   向导是一个"做事"的流程，顶上再压一排"等你去处理"只会打断它。
  paintAttention(v.screen === 'list' ? v.attention : []);

  const onList = v.screen === 'list';
  const onRes = onList && pane === 'resources';
  $('screen-list').hidden = !onList || onRes;
  $('screen-resources').hidden = !onRes;
  $('screen-wizard').hidden = onList;

  if (onList) {
    lastActiveStep = 0; // 回列表 = 向导关掉了，下次进来重新从"不滚"开始
    if (onRes) paintResources(v);
    else paintList(v);
  } else paintWizard(v);

  // ★ 全局闸门**最后**跑，而且只加不减：每个控件自己的规则已经在上面设好了。
  //   请求在飞的时候，任何控件都不许再发动作。
  //
  //   ⚠️ 只扫 `.shell`，**不扫整个文档**：状态编辑对话框在 `.shell` 外面。
  //   它里面的行**不会**在每次 `render()` 里重建，所以一旦被这里关掉就再也
  //   回不来（那是"点了一次保存，↑↓ 按钮从此全灰"的那种 bug）。
  //   对话框自己那颗保存按钮在 `saveStatuses()` 里单独关。
  if (busy) {
    for (const el of document.querySelectorAll('.shell button, .shell input, .shell select')) {
      // 本来就被自己的规则关着的**不记账**：放开它们不是闸门的责任。
      if (/** @type {any} */ (el).disabled) continue;
      /** @type {any} */ (el).disabled = true;
      gated.add(/** @type {any} */ (el));
    }
  }
  // 「保存」按钮的判据是**输入框里的实时值**（服务端那份只在保存时才更新，
  // 拿它判会让按钮永远是灰的）。所以它得排在闸门之后自己再算一次。
  syncSaveButton(busy);
}

/** @param {string} id @param {string} text */
function setText(id, text) {
  const el = $(id);
  if (el !== null) el.textContent = text;
}

/**
 * 侧栏那条「当前目录」。
 *
 * ★ 不能走 `setText`，两个理由：
 *
 * 1. **折行点**。整串里一个空格都没有，浏览器只好硬切——于是出现
 *    `…\Documents\P` / `ython code\…` 这种半个词，看着像被啃了一口。
 *    `<wbr>` 把"分隔符后面可以断"告诉浏览器，这正是它要挑的地方。
 * 2. **出口**。宽度不够时会夹到两行，尾巴注定丢掉一大截，
 *    所以 `title` 得带上全文——省略号必须配一个出口。
 *
 * @param {string} cwd
 */
function paintCwd(cwd) {
  const el = $('cwd');
  if (el === null) return;
  el.textContent = '';
  el.appendChild(wbrText(cwd));
  el.title = cwd;
}

/**
 * 提示条。三条优先级，从上往下：
 *
 * 1. `fatalText`（请求失败）——"这条路断了"，压过一切；
 * 2. `closed`（用户点了退出）——服务端这就关了，页面得说句收尾的话，
 *    不能停在视图里那句「退出中…」上（那句永远等不到下文）；
 * 3. `view.notice`——reducer 说的话（"上一步做了什么"）。
 */
function paintFlash() {
  const el = $('flash');

  // ★「管理状态」开着的时候让位：那个对话框是**模态**的，它自己那条错误行
  //   才是此刻要读的那句。两处并排显示同一句话，看起来像页面在重复念叨。
  //   ⚠️ 请求失败（`fatalText`）例外——"这条路断了"是页面级的，不能说藏就藏。
  if (statusDraft !== null && fatalText === '') {
    el.hidden = true;
    return;
  }

  /** @type {string} */
  let text;
  /** @type {string} */
  let cls = 'flash';
  if (fatalText !== '') {
    text = fatalText;
    cls = 'flash bad';
  } else if (closed) {
    text = '控制台已退出，这个标签页可以关掉了。';
    cls = 'flash good';
  } else {
    text = view === null ? '正在连接本地控制台…' : view.notice;
  }
  el.hidden = text === '';
  el.textContent = text;
  el.className = cls;
}

/** 确认框：**行内横幅**，不是 `window.confirm()`。 */
function paintBanner(v) {
  const el = $('banner');
  const c = v.confirm;
  el.hidden = c === null;
  if (c === null) return;
  setText('banner-label', `确定要删掉这条绑定吗？${c.label}（改的是全局配置，没有撤销）`);
}

/** @param {any} v */
function paintTop(v) {
  const onList = v.screen === 'list';
  const onRes = onList && pane === 'resources';

  // ★ 每个视图有自己的一套出口：项目那边是「＋ 新建」，资源那边是「全部拉取」
  //   「全部检测」「默认环境」和「＋ 添加 token」。「刷新」两边都要——它问的是
  //   服务端"现在是什么样"，与看哪张表无关。
  $('act-new').hidden = !onList || onRes;
  $('act-sync').hidden = !onRes;
  $('act-fetch-all').hidden = !onRes;
  $('act-check-all').hidden = !onRes;
  $('act-defaults-env').hidden = !onRes;
  $('act-add-token').hidden = !onRes;
  $('act-reload').hidden = !onList;

  // 视图切换与状态筛选只在列表页上有意义：向导是一段流程，不是一张表。
  $('views').hidden = !onList;
  $('nav-status').hidden = !onList || onRes;

  setText('pane-title', onRes ? '资源' : '项目');
  $('view-projects').classList.toggle('is-on', !onRes);
  $('view-projects').setAttribute('aria-pressed', String(!onRes));
  $('view-resources').classList.toggle('is-on', onRes);
  $('view-resources').setAttribute('aria-pressed', String(onRes));

  $('act-quit').disabled = closed;
  if (closed) setText('act-quit', '已退出');
}

// ── 左栏：状态筛选 ──

/**
 * 每一档一行：色点 + 名字 + 计数。
 *
 * ★ 顺序就是 `v.statuses` 的顺序——那是用户在「管理状态」里排好的顺序，
 *   左栏**不重新排**（"我明明把它挪到第一个了，这里怎么还是按字母"）。
 *
 * ★ 计数只数**真的代表一个文件夹的那些行**（`status !== null`）。状态表里
 *   一档都没用上也照样画出来——"这一档存在但还没人用"是一个有用的信息。
 */
function paintFilters(v) {
  const ul = $('filters');
  ul.replaceChildren();

  const known = new Set(v.statuses.map((/** @type {any} */ s) => s.id));

  // ★ 选中的那一档被删掉了：退回「全部」。不这么做的话，页面会停在
  //   "一个筛选条件已经不存在的空表"上，而左栏里找不到任何一个亮着的项。
  if (filter !== '' && !known.has(filter)) filter = '';

  /** @type {Map<string, number>} */
  const counts = new Map();
  let total = 0;
  for (const it of v.items) {
    if (it.status === null) continue;
    total += 1;
    if (!known.has(it.status.id)) continue; // 指向已删状态的行：不算进任何一档
    counts.set(it.status.id, (counts.get(it.status.id) ?? 0) + 1);
  }

  ul.appendChild(filterItem('', '全部', total, ''));
  for (const s of v.statuses) ul.appendChild(filterItem(s.id, s.label, counts.get(s.id) ?? 0, s.color));
}

/**
 * @param {string} id 状态 id（`''` = 全部）
 * @param {string} label
 * @param {number} count
 * @param {string} color 颜色名（`''` = 不用色点）
 */
function filterItem(id, label, count, color) {
  const li = document.createElement('li');

  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'filt';
  b.dataset.id = id;
  b.setAttribute('aria-pressed', String(filter === id));
  if (filter === id) b.classList.add('is-on');

  const dot = document.createElement('span');
  dot.className = 'dot';
  if (color === '') dot.classList.add('all');
  else dot.dataset.color = color;

  const name = document.createElement('span');
  name.className = 'fname';
  name.textContent = label;

  const n = document.createElement('span');
  n.className = 'fcount';
  n.textContent = String(count);

  b.append(dot, name, n);
  li.appendChild(b);
  return li;
}

// ── 屏 1：项目表 ──

/** @param {any} v */
function paintList(v) {
  const tbody = $('rows');
  tbody.replaceChildren();

  let shown = 0;

  for (const it of v.items) {
    // ★ 「+ 新建…」**不画成表格行**——它是一个动作，不是一条数据；画进来就
    //   会变成表里一个横跨六列的大按钮，把「哪几条是我的项目」这件事糊掉。
    //   这个动作在页头（`#act-new`），那里才是它该在的地方。
    //   ⚠️ 视图模型里它**照旧是一条 item**（`ui.js` 的 `buildPanelData()` 给的，
    //   `ui-web.test.js` 的黄金形状断言盯着那个顺序）——这里只是不渲染。
    if (it.kind === 'new') continue;

    // ★ 筛选是**本地**的（见 `filter` 那段注释）：不匹配就不画，
    //   但服务端那份数据一个字都不动——清掉筛选立刻全回来。
    if (filter !== '' && (it.status === null || it.status.id !== filter)) continue;

    const tr = document.createElement('tr');
    // ★ 「当前目录」这一行是页面唯一的"你在这里"：它拿一层极浅的强调底色
    //   和左边一条 3px 竖线，别的行靠悬停才拿到同样的提示。
    if (it.kind === 'cwd') tr.className = 'is-cwd';

    // ⓪ 状态：原生下拉，底色与字色跟着那一档的颜色走。
    //   `token` 那一行（"这个身份还没被任何目录用到"）不是文件夹，给一条破折号。
    tr.appendChild(statusCell(v, it));

    // ① 目录：标签与路径**同一行**，路径长的时候从分隔符处折行
    const tdTarget = document.createElement('td');
    const tcell = document.createElement('div');
    tcell.className = 'target-cell';
    // ★ 标签只在「这一行跟别的行不一样」时才戴：
    //   · `cwd`   → 「当前目录」，全表唯一的"你在这里"；
    //   · `token` → 「未绑定身份」，它压根不是一条目录绑定；
    //   · `binding` → **不戴**。表里绝大多数行都是它，每行盖一个「路径绑定」
    //     等于每行盖一个"正常"——真正的提醒会被这层噪音淹掉，路径也白白
    //     少掉一个标签的宽度（长路径因此多折一行）。
    if (it.kind !== 'binding') tcell.appendChild(chip(it.kind));
    const p = document.createElement('div');
    p.className = 'target';
    if (it.kind === 'token') {
      // ★ 这一行是"这个身份还没被任何目录用到"，不是"这个目录没有身份"。
      //   写成 `(未绑定) relay-a` 会把主语弄反，读起来像路径叫 relay-a。
      p.textContent = '还没有绑定到目录';
    } else {
      p.appendChild(wbrText(it.path));
      // 折行之后整条路径就看不全了——`title` 让鼠标停一下能看到原文
      p.title = it.path;
    }
    tcell.appendChild(p);
    tdTarget.appendChild(tcell);
    tr.appendChild(tdTarget);

    // ② 身份：**名字在上、打码密钥在下**。
    //   ★ 只印一串 `sk-****cccc` 时，两条绑定用同一个身份也看不出来——
    //     名字才是人认得的那一半，密钥只是"确实配上了"的凭据。来源挤在
    //     同一行的末尾，不再单独占一列：它是身份的属性，不是目录的。
    const tdIdent = document.createElement('td');
    // ★ 窄屏要整列藏起来时，**单元格自己**也得有个能被选中的类名：只藏表头
    //   会把数据留在原地，整张表当场错位（与 ③ 的 `url-cell` 同一个理由）。
    tdIdent.className = 'ident-cell';
    const ident = document.createElement('div');
    ident.className = 'ident';

    const identName = document.createElement('span');
    identName.className = 'ident-name';
    identName.textContent = it.token === '' ? '(未绑定)' : it.token;
    identName.title = it.token;
    ident.appendChild(identName);

    const identSub = document.createElement('span');
    identSub.className = 'ident-sub';
    const key = document.createElement('span');
    key.className = 'ident-key mono';
    key.textContent = it.masked;
    identSub.appendChild(key);
    const src = document.createElement('span');
    src.className = 'ident-src';
    src.textContent = it.source;
    identSub.appendChild(src);
    ident.appendChild(identSub);
    tdIdent.appendChild(ident);
    tr.appendChild(tdIdent);

    // ③ 服务端：完整的地址，只在**主机之后**给一个折行点。
    //   ★ 以前每个 `/` 之后都允许折行，于是短窗口里会先断成孤零零的一行
    //     协议头——单独占一行，读起来像地址坏了。
    const tdUrl = document.createElement('td');
    tdUrl.className = 'url-cell';
    tdUrl.appendChild(urlText(it.baseUrl));
    tdUrl.title = it.baseUrl;
    tr.appendChild(tdUrl);

    // ④ 模型：一行一个下拉，选中即生效（见 `modelCell()`）。
    tr.appendChild(modelCell(it));

    // ⑤ 操作
    const tdOps = document.createElement('td');
    tdOps.className = 'c-ops';
    const ops = document.createElement('div');
    ops.className = 'ops';

    // ★ 行内按钮一律 `mini`：默认尺寸是给页头那几个的，塞进表格里会让
    //   每一行都显得比它承载的信息更重。**一行只留一个实心按钮**（启动）；
    //   删除是 `.ghost`，悬停才浮出来——它不是每行都要扫一遍的动作。
    //   ⚠️ 改模型**不再是按钮**：它现在是 ④ 号那一列的下拉（`modelCell()`），
    //   想勾多个/排序/手敲就走下拉末尾的「多个模型…」，那条短路还在。
    const launch = button('启动', 'primary mini', () => { void post('activate', { index: it.index }); });
    launch.disabled = it.token === '';
    launch.title = it.token === '' ? '这一项没有绑定身份' : `用 ${it.token} 启动`;
    ops.appendChild(launch);

    if (it.kind === 'binding') {
      const del = button('删除', 'ghost mini danger-ghost', () => { void post('delete', { index: it.index }); });
      del.title = '删掉这条绑定（只影响配置，不动目录）';
      ops.appendChild(del);
    }

    tdOps.appendChild(ops);
    tr.appendChild(tdOps);

    tbody.appendChild(tr);
    // ★ 只数**代表一个文件夹**的行：那个"未绑定身份"的行也在表里，
    //   但它不是项目。页头那个数和左栏「全部」必须是同一个数——
    //   两个数并排摆着却差一，谁都会先怀疑页面坏了。
    //   ⚠️ 现在 `filter !== ''` 时剩下的本来就都有状态，所以这里不必再分情况。
    if (it.status !== null) shown += 1;
  }

  setText('list-count', String(shown));

  // ★ 空表只剩一行表头，读起来像"页面坏了"。空状态只说**去哪儿点**，
  //   不复述界面——那颗按钮就在页头。筛选筛空了是另一句话：那时候该说的是
  //   "把筛选清掉"，而不是"去新建一个"。
  if (shown === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 6;
    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = filter === '' ? '还没有项目' : '这个状态下还没有项目';
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = filter === ''
      ? '点右上角的「＋ 新建」，从当前目录开始。'
      : '换一个状态，或者点左栏的「全部」。';
    cell.append(title, hint);
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }
}

/**
 * 一行里的状态下拉。
 *
 * ★ 用原生 `<select>` 而不是自绘菜单：键盘、读屏、移动端的滚轮选择器全是
 *   浏览器白送的。样式只改外观（`appearance: none` + 一个三角），不改语义。
 *
 * ★ `data-color` 让 CSS 去认那八种颜色——**这里不碰任何色值**（明暗两套都在
 *   样式里）。指向一档已被删掉的状态时，服务端给的是一个 `id === ''` 的
 *   "未知状态"：这里把它画成一个**选不中、也删不掉**的占位项，好让用户能把它
 *   改成任何一档（那一步就是一个普通的 `set-status`）。
 *
 * @param {any} v 视图模型（要 `statuses`）
 * @param {any} it 一项
 */
function statusCell(v, it) {
  const td = document.createElement('td');
  td.className = 'c-status';

  if (it.status === null) {
    const dash = document.createElement('span');
    dash.className = 'dash';
    dash.textContent = '—';
    td.appendChild(dash);
    return td;
  }

  const wrap = document.createElement('span');
  wrap.className = 'status-pick';
  wrap.dataset.color = it.status.color;

  const sel = document.createElement('select');
  sel.className = 'status-select';
  sel.setAttribute('aria-label', `状态：${it.path}`);

  if (!v.statuses.some((/** @type {any} */ s) => s.id === it.status.id)) {
    const o = document.createElement('option');
    o.value = it.status.id;
    o.textContent = it.status.label;
    o.disabled = true;
    sel.appendChild(o);
  }
  for (const s of v.statuses) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.label;
    sel.appendChild(o);
  }
  sel.value = it.status.id;
  sel.addEventListener('change', () => {
    void post('set-status', { index: it.index, id: sel.value });
  });

  wrap.appendChild(sel);
  td.appendChild(wrap);
  return td;
}

/**
 * 一行里的模型下拉。
 *
 * ★ 选一个就**当场生效**，写进去的语义是"提到首位"（`[a,b,c]` 里选 `b`
 *   得到 `[b,a,c]`）——与命令行那条"下一个模型"逐字同义，服务端也只认这一种。
 *   所以这里**没有**"保存"：下拉一关，那一层就已经写好了。
 *
 * ★ 「（不声明）」= 把那一层的模型声明整个删掉，退回"用继承来的那一份"。
 *   它不是"选了一个空模型"——这两件事在配置里差一个键。
 *
 * ★ 下拉装不下"排优先级"，所以末尾留一个「多个模型…」：选它进原来那个
 *   多选/排序/手敲的面板（`edit`），勾完在那里写入。这样"想换个当前模型"
 *   是一步，"想重排一整份清单"还是原来那条路。
 *
 * ★ 候选 = 这一层已声明的（按优先级）∪ 那份身份拉取过的清单（按字母）。
 *   一个都没有时下拉只剩两项，其中「多个模型…」就是手敲的入口——空表也走得通。
 *
 * @param {any} it 一项
 */
function modelCell(it) {
  const td = document.createElement('td');
  // ★ 列名在 `index.html` 的 `th` 上，单元格拿同一个类名，窄屏才藏得齐整。
  td.className = 'c-models';

  const wrap = document.createElement('span');
  wrap.className = 'model-pick';

  const box = document.createElement('span');
  box.className = 'model-box';

  const sel = document.createElement('select');
  sel.className = 'model-select mono';
  sel.setAttribute('aria-label', `模型：${it.label}`);

  /** @param {string} value @param {string} text */
  const opt = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
    return o;
  };

  opt('', '（不声明）');

  const cur = it.active >= 0 ? it.models[it.active] : '';
  const ids = Array.isArray(it.modelOptions) ? it.modelOptions : [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') continue;
    seen.add(id);
    opt(id, id);
  }
  // ★ 当前生效的那个万一不在候选里（理论上不该发生——候选包含已声明的），
  //   补一项进去。否则下拉会静默落到「（不声明）」上，看起来像这一项没配。
  if (typeof cur === 'string' && cur !== '' && !seen.has(cur)) opt(cur, cur);

  opt(MODEL_MORE, '多个模型…');

  // ★ `layer` 为 `none` 表示"没有可写的一层"；没有身份时也无处可写。
  //   判据本身在服务端（`modelEditBlocker()`），这里只是照抄它的结论——
  //   与其让人选完被回一句"改不了"，不如当场灰掉。
  sel.disabled = it.token === '' || it.layer === '' || it.layer === 'none';
  sel.title = sel.disabled ? '这一项的模型不来自可写的一层' : '选中即生效，写的是"提到首位"';
  sel.value = typeof cur === 'string' ? cur : '';

  sel.addEventListener('change', () => {
    if (sel.value === MODEL_MORE) {
      void post('edit', { index: it.index });
      return;
    }
    void post('set-model', { index: it.index, id: sel.value });
  });

  box.appendChild(sel);
  wrap.appendChild(box);

  // 一排"后面的那些"还剩几个。下拉只看得到当前生效的那一个，
  // 这枚小标是"它其实还有优先级更低的选择"的唯一提示。
  if (it.models.length > 1) {
    const rest = document.createElement('span');
    rest.className = 'model-more';
    rest.textContent = `+${it.models.length - 1}`;
    rest.title = it.models.join('\n');
    wrap.appendChild(rest);
  }
  wrap.title = it.models.length === 0
    ? '这一层还没有声明模型'
    : `按优先级：\n${it.models.join('\n')}`;

  td.appendChild(wrap);
  return td;
}

/** @param {string} kind */
function chip(kind) {
  const el = document.createElement('span');
  const NAME = { cwd: '当前目录', binding: '路径绑定', token: '未绑定身份' };
  el.className = `chip ${kind}`;
  el.textContent = NAME[kind] ?? kind;
  return el;
}

/**
 * 把一段"没有空格的长串"塞进 DOM，在指定的分隔符**之后**各放一个 `<wbr>`。
 *
 * ★ 为什么要这么麻烦：路径与 URL 都没有空格，浏览器只能靠 `word-break: break-all`
 *   硬切——于是 `…\python code\Spider` 被切成 `…\python cod` / `e\Spider`，
 *   `relay.example.org/openai` 被切成 `…/o` / `penai`，两行都读不出断在哪。
 *   （示例故意不写协议头——这个文件里**一个绝对 URL 都不许有**，注释也不行。）
 *   分隔符本来就是最自然的折行点，`<wbr>` 把"这里可以断"告诉浏览器，
 *   同时**不插任何字符**（复制出来还是原样）。
 *
 * ★ 仍然只造**文本节点**，不拼 HTML（CSP 之外的第二道，见文件头）。
 *
 * @param {string} text
 * @param {string} [breaks] 可以在其后折行的字符，默认是路径的两种分隔符
 * @returns {DocumentFragment}
 */
function wbrText(text, breaks = '/\\') {
  const frag = document.createDocumentFragment();
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (breaks.includes(text[i])) {
      frag.appendChild(document.createTextNode(text.slice(start, i + 1)));
      frag.appendChild(document.createElement('wbr'));
      start = i + 1;
    }
  }
  if (start < text.length) frag.appendChild(document.createTextNode(text.slice(start)));
  return frag;
}

/**
 * 服务端地址：协议头 + 主机**必须留在同一段**，只在主机之后的第一个 `/` 折行。
 *
 * ★ 这是"显示真实地址"那条要求的另一半：地址本来就一字不改地印出来，但
 *   折行要落在**主机之后**。按每个 `/` 折的话，短窗口里会先断成孤零零的
 *   `协议:` / `//relay…`，谁看都觉得地址被截过。
 *
 * ★ 没有协议头（或整串是个错误说明）就退回普通的按分隔符折行——别猜。
 *
 * @param {string} text
 * @returns {Node}
 */
function urlText(text) {
  const scheme = text.indexOf('://');
  if (scheme === -1) return wbrText(text, '/?&');
  const hostEnd = text.indexOf('/', scheme + 3);
  // 只有主机、没有路径：整串不可断——本来就不长
  if (hostEnd === -1) return document.createTextNode(text);
  const frag = document.createDocumentFragment();
  // ★ 折行点放在**斜杠之前**：行尾是 `host:port`，下一行从 `/` 起。
  //   带上斜杠的话，`host:port/` 比列宽多出一个字符，浏览器只好在端口
  //   冒号前硬切，变成 `…internal.lab` / `:8443/v1`。
  frag.appendChild(document.createTextNode(text.slice(0, hostEnd)));
  frag.appendChild(document.createElement('wbr'));
  frag.appendChild(wbrText(text.slice(hostEnd), '/?&'));
  return frag;
}

// ── 屏 1b：资源表 ──

/**
 * 资源表：**一行一个身份（token）**，而不是一个目录。
 *
 * ★ 身份列就是**那把 token 本身**——用户认的是"这把 key"，`name` 只是它在
 *   配置文件里的标识符。所以这一列的主次是：打码密钥（主）→ 昵称（可编辑）
 *   → 机器名（次要）。打码值**全表只出现这一次**，不再单开一列。
 *
 * ★ 这张表回答四个问题，顺序也照它排：**这是谁**（打码密钥 + 昵称 + 机器名）、
 *   **它连哪儿**（服务端地址）、**它按什么顺序挑模型**（优先级）、
 *   **还有多少地方在用它**（绑定数）。
 *
 * ★ 行由**身份表**驱动，不是由缓存驱动：一个从没拉过的身份照样在表里
 *   （服务端那一格写着「未拉取」），正是它该出现的位置——不然"我明明有这个
 *   身份，怎么这儿没有"会变成一个要翻配置文件才能回答的问题。
 *
 * ★ 密钥永远是**打码**的那一串：这里只显示视图模型给的那份，
 *   它从设计上就不带明文（见视图模型那条"永不过线"的规矩）。
 *
 * @param {any} v */
function paintResources(v) {
  const tbody = $('res-rows');
  tbody.replaceChildren();

  const rows = Array.isArray(v.resources) ? v.resources : [];
  setText('list-count', String(rows.length));
  paintSessions(v.sessions, v.recentSessions);
  paintSummary(v.resourcesSummary);

  for (const r of rows) {
    const tr = document.createElement('tr');

    // ① 身份
    tr.appendChild(identCell(r, v));

    // ② 服务端：地址照原样印出来，第二行是"这份清单是什么时候、从哪儿拉的"
    const tdUrl = document.createElement('td');
    tdUrl.className = 'r-url';
    const urlBox = document.createElement('div');
    urlBox.className = 'res-url';

    const urlLine = document.createElement('div');
    urlLine.className = 'res-url-text';
    urlLine.appendChild(urlText(r.baseUrl));
    // ★ 地址夹到两行之后，长路径就看不全了——`title` 让鼠标停一下能看到原文。
    //   与项目表那条路径（`.target`）同一条规矩：**省略号必须配一个出口**。
    urlLine.title = r.baseUrl;
    urlBox.appendChild(urlLine);

    const meta = document.createElement('div');
    meta.className = 'res-meta';
    // ★ 「地址已变」只在**拉取用的地址**与**现在生效的地址**不一样时出现：
    //   说明下面那份清单是旧地址上的，未必还作数。
    if (r.stale) {
      const stale = document.createElement('span');
      stale.className = 'res-stale';
      stale.textContent = '地址已变';
      stale.title = `清单拉取自 ${r.cachedUrl}`;
      meta.appendChild(stale);
    }
    const when = document.createElement('span');
    when.className = 'res-when';
    if (r.fetchedAt === '') {
      when.textContent = '未拉取';
    } else {
      when.textContent = shortStamp(r.fetchedAt);
      when.title = `拉取于 ${r.fetchedAt}`;
    }
    meta.appendChild(when);

    urlBox.appendChild(meta);
    tdUrl.appendChild(urlBox);
    tr.appendChild(tdUrl);

    // ③ 模型优先级（只读；点开是一个对话框）
    const tdPrio = document.createElement('td');
    tdPrio.className = 'r-priority';
    tdPrio.appendChild(priorityCell(r));
    tr.appendChild(tdPrio);

    // ④ 绑定数
    const tdCount = document.createElement('td');
    tdCount.className = 'r-count';
    tdCount.textContent = String(r.projects);
    tdCount.title = '显式声明了这个身份的项目数';
    tr.appendChild(tdCount);

    // ⑤ 用量 ⑥ 花费：**两格都只画服务端算好的数**（`r.usage` 六键，见契约）。
    //    前端不做除法、不查价格表——那会是"同一个数有两处定义"。
    tr.appendChild(usageCell(r.usage));
    tr.appendChild(costCell(r.usage));

    // ⑦ 操作：检测 + 拉取 + 环境。这张表**不提供**改名/改密钥/删除——那是配置的事，
    //    走命令行或向导；这里只做"看一眼 + 探一下 + 拉一遍 + 补几个变量"。
    const tdOps = document.createElement('td');
    tdOps.className = 'r-ops';
    const ops = document.createElement('div');
    ops.className = 'ops';
    // ★ 「检测」放最前面：池的意义就是"哪把还能用"，而这是唯一能回答它的按钮。
    //   与「拉取」同一个约束——没有服务端地址时探测只会得到一句"没有 baseUrl"，
    //   那不是用户想看的答案，所以先关掉并说明白。
    const checkOne = button('检测', 'mini', () => {
      void post('check-token', { name: r.name });
    });
    checkOne.disabled = r.url === '';
    checkOne.title = r.url === ''
      ? '这个身份还没有服务端地址'
      : `发一条最小请求探一下额度（会真实计费一次）· ${r.baseUrl}`;
    ops.appendChild(checkOne);
    const fetchOne = button('拉取', 'mini', () => {
      void post('refresh-models', { name: r.name });
    });
    fetchOne.disabled = r.url === '';
    fetchOne.title = r.url === ''
      ? '这个身份还没有服务端地址'
      : `从 ${r.url} 拉取模型清单`;
    ops.appendChild(fetchOne);
    const envBtn = button('环境', 'mini', () => {
      openEnvDialog('token', r.name);
    });
    envBtn.title = '编辑这个身份的环境变量（JSON）';
    ops.appendChild(envBtn);
    tdOps.appendChild(ops);
    tr.appendChild(tdOps);

    tbody.appendChild(tr);
  }

  if (rows.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const cell = document.createElement('td');
    cell.colSpan = 7;
    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = '还没有身份';
    const hint = document.createElement('p');
    hint.className = 'empty-hint';
    hint.textContent = '右上「＋ 添加 token」加一个身份，它就会出现在这里。';
    cell.append(title, hint);
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }
}

// ── 「需要你处理」：注意力清单（面板 · 注意力）──
//
// ★ 条目与动作**全部来自服务端**：每条的 `actions` 是 `{label, op, args}` 描述符，
//   页面只照单画按钮、把 op 原样 post 回去——这里**没有任何判断**。
//   （加一种新信号 = 只改服务端；这正是"页面只画不翻"那条纪律的用法。）
// ★ 健康时是空数组：整块 hidden、不占一行。
// ★ 每条最多两个按钮：一个主、一个次。三个以上等于让人选，等于没给建议。
function paintAttention(items0) {
  const wrap = $('attention');
  wrap.replaceChildren();
  const items = Array.isArray(items0) ? items0 : [];
  wrap.hidden = items.length === 0;
  if (wrap.hidden) return;

  const head = document.createElement('p');
  head.className = 'att-head';
  head.textContent = '需要你处理';
  wrap.appendChild(head);

  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'att-row';

    const dot = document.createElement('span');
    dot.className = 'att-dot';
    dot.dataset.color = it.severity === 'high' ? 'red' : 'amber';
    row.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'att-body';
    const title = document.createElement('div');
    title.className = 'att-title';
    title.textContent = it.title;
    body.appendChild(title);
    if (it.detail !== '') {
      const detail = document.createElement('div');
      detail.className = 'att-detail';
      detail.textContent = it.detail;
      body.appendChild(detail);
    }
    row.appendChild(body);

    const acts = document.createElement('div');
    acts.className = 'att-actions';
    for (const a of Array.isArray(it.actions) ? it.actions : []) {
      if (a.op === '') continue;
      const btn = button(a.label, 'mini', () => {
        void post(a.op, a.args);
      });
      acts.appendChild(btn);
    }
    row.appendChild(acts);

    wrap.appendChild(row);
  }
}

// ── 屏 1b：会话条（面板 · 会话在场层）──
//
// ★ 资源屏顶部那一行回答的是"**现在有谁在跑**"——这是面板上唯一回答它的地方。
// ★ 全部健康且无未读 → **折叠成一行计数**（健康态不占地方是这条的设计前提）；
//   有未读纸条、或身份状态不在「有余额 / 未检测」时，才逐行展开。
// ★ 页面**只画不翻**：状态词、中文标签、未读数全是服务端算好的。
// ★ 「全部标已读」走 `msg-read-all`，与命令行读信箱是**同一条 IO**
//   （inbox → read 的 rename），所以两边不可能给出两种状态。
function paintSessions(rows0, recent0) {
  const wrap = $('res-sessions');
  wrap.replaceChildren();
  const rows = Array.isArray(rows0) ? rows0 : [];
  const recent = Array.isArray(recent0) ? recent0 : [];
  wrap.hidden = rows.length === 0 && recent.length === 0;
  if (wrap.hidden) return;

  const unread = rows.reduce((n, r) => n + r.unread, 0);
  const alert = rows.filter((r) => r.pool.status !== 'ok' && r.pool.status !== 'unknown');

  if (rows.length > 0 && unread === 0 && alert.length === 0) {
    const line = document.createElement('p');
    line.className = 'res-sessions-line';
    line.textContent = `${rows.length} 个会话在跑 · 无未读`;
    wrap.appendChild(line);
  } else {
    for (const r of rows) wrap.appendChild(sessionRow(r, false));
  }

  // ── 最近关闭：有未读的逐行（能读、能恢复）；其余折成一行，只给「恢复最近的」 ──
  //   ★ 恢复 = 同 token、同目录、带 -c 开新窗口（与服务端的启动路径同一条）。
  const unreadRecent = recent.filter((r) => r.unread > 0);
  for (const r of unreadRecent) wrap.appendChild(sessionRow(r, true));

  const shown = new Set(unreadRecent.map((r) => r.id));
  const rest = recent.filter((r) => !shown.has(r.id));
  if (rest.length > 0) {
    const line = document.createElement('div');
    line.className = 'res-session-row is-closed';

    const text = document.createElement('span');
    text.className = 'ses-closed';
    text.textContent = `最近关闭 ${rest.length} 个`;
    line.appendChild(text);

    const resume = button('恢复最近的', 'mini', () => {
      void post('resume-session', { session: rest[0].id });
    });
    resume.title = `恢复 ${rest[0].token} · ${tailPath(rest[0].cwd)}（同 token、同目录、带 -c）`;
    line.appendChild(resume);

    wrap.appendChild(line);
  }
}

/**
 * 一行会话。`closed` 时多一个「已关闭」标记与「恢复」按钮（最近关闭的行）。
 * @param {any} r
 * @param {boolean} closed
 */
function sessionRow(r, closed) {
  const row = document.createElement('div');
  row.className = closed ? 'res-session-row is-closed' : 'res-session-row';

  const dot = document.createElement('span');
  dot.className = 'ses-dot';
  dot.dataset.color = POOL_COLOR[r.pool.status] ?? 'slate';
  dot.title = `身份状态：${r.pool.label}`;
  row.appendChild(dot);

  const name = document.createElement('span');
  name.className = 'ses-token';
  name.textContent = r.token;
  name.title = r.id;
  row.appendChild(name);

  const cwd = document.createElement('span');
  cwd.className = 'ses-cwd';
  cwd.textContent = tailPath(r.cwd);
  cwd.title = r.cwd;
  row.appendChild(cwd);

  if (closed) {
    const state = document.createElement('span');
    state.className = 'ses-closed';
    state.textContent = '已关闭';
    row.appendChild(state);
  }

  if (r.pool.status !== 'ok' && r.pool.status !== 'unknown') {
    const warn = document.createElement('span');
    warn.className = 'ses-warn';
    warn.textContent = r.pool.label;
    warn.dataset.color = POOL_COLOR[r.pool.status] ?? 'slate';
    row.appendChild(warn);
  }

  if (r.unread > 0) {
    const badge = document.createElement('span');
    badge.className = 'sum-count ses-unread';
    badge.dataset.color = 'amber';
    badge.textContent = `${r.unread} 条未读`;
    badge.title = '有人给这个会话留了纸条';
    row.appendChild(badge);

    const readAll = button('全部标已读', 'mini', () => {
      void post('msg-read-all', { session: r.id });
    });
    readAll.title = '把 inbox 里的纸条挪到 read（与命令行的「读完即已读」同一条 IO）';
    row.appendChild(readAll);
  }

  if (closed) {
    const resume = button('恢复', 'mini', () => {
      void post('resume-session', { session: r.id });
    });
    resume.title = '同 token、同目录、带 -c 开一个新窗口';
    row.appendChild(resume);
  }

  return row;
}

/** cwd 的末两段——会话条一行放不下整条路径（`title` 里有全文）。 */
function tailPath(p) {
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.slice(-2).join('/');
}

// ── 屏 1b：用量与花费（概览条 + 两列）──
//
// ★★ 这一整块的数字**全部来自服务端**：概览是 `resourcesSummary`，每行是 `r.usage`
//    （六键 `{calls, in, out, cost, unpriced, syncedAt}`）。页面**只格式化，不重算**。
//    在这里再 SUM 一遍，两处口径就会分叉——而分叉的那天不会有任何报错，
//    只有人把命令行 `pool sync` 的输出和页面摆在一起才会发现。
//    ⇒ 与 `clash_proxy` 的 `cmd_status` / `cmd_stats` 同一条规矩：概览与明细必须同源。
//
// ★ 格式化函数是**抄**的（`usage.js` 的 `fmtMoney` / `fmtCount` 那两条阈值），
//    不是"另立一套"：浏览器不能 import CLI，但**同一套阈值**得两边一样，
//    否则 12000 在这边写 `12.0k`、在那边写 `12k`。

/** 没算过的行（老服务端 / 缺字段）：形状与 `r.usage` 一致，`syncedAt:''` 让它画「未算过」。 */
const NO_USAGE = Object.freeze({ calls: 0, in: 0, out: 0, cost: null, unpriced: 0, syncedAt: '' });

/**
 * 千分位 / k / M / B——阈值与 `src/cli/commands/usage.js` 的 `fmtCount()` **逐个相同**。
 * 阈值是 `<10_000` 才用千分位：`12,345` 比 `12.3k` 长，而 `9999` 又短得不必缩写。
 * @param {unknown} n @returns {string}
 */
function fmtCount(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 10000) return n.toLocaleString('en-US');
  if (abs < 1e6) return `${trimZero(n / 1000)}k`;
  if (abs < 1e9) return `${trimZero(n / 1e6)}M`;
  return `${trimZero(n / 1e9)}B`;
}

/** `12.0` → `12`，但 `12.3` 留着——缩写要短，不要整齐。 */
function trimZero(n) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * 美元。**没有价格时是 `—`，不是 `$0`**——`$0` 说的是"免费"，那是谎话
 * （与 `core/prices.js` 的 `costOf()` 返回 `null` 同一条）。
 *
 * `partial` = 这一行/这一池有模型查不到价 ⇒ 加一个 `+`，表示**这是下限**。
 * @param {unknown} cost @param {boolean} partial @returns {string}
 */
function fmtMoney(cost, partial) {
  if (typeof cost !== 'number' || !Number.isFinite(cost)) return '—';
  let text;
  if (!(cost > 0)) text = '$0';
  else if (cost < 0.01) text = '<$0.01';
  else text = '$' + cost.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return partial ? `${text}+` : text;
}

/** 概览条里的一个「标签 + 数」：标签小字在前，数稍大在后，读起来是「身份 6」。 */
function sumStat(value, label) {
  const el = document.createElement('span');
  el.className = 'sum-stat';
  const l = document.createElement('span');
  l.className = 'sum-label';
  l.textContent = label;
  const b = document.createElement('b');
  b.className = 'sum-value';
  b.textContent = value;
  el.append(l, b);
  return el;
}

/**
 * 概览条。空池时**整条隐藏**——一行「0 个身份」压在空表提示上方，只是噪音。
 * @param {any} s0 */
function paintSummary(s0) {
  const el = $('res-summary');
  el.replaceChildren();

  const s = s0 !== null && typeof s0 === 'object' ? s0 : null;
  if (s === null || !(s.total > 0)) {
    el.hidden = true;
    return;
  }
  el.hidden = false;

  const row = document.createElement('div');
  row.className = 'sum-row';

  row.appendChild(sumStat(String(s.total), '身份'));

  // 池状态计数：**顺序与文字都由服务端给**（`counts` 已按 STATUSES 排好、只留 >0 的）。
  // 颜色只映射到既有的 `--st-*`，与行里那枚状态丸同一套墨。
  for (const c of Array.isArray(s.counts) ? s.counts : []) {
    const chip = document.createElement('span');
    chip.className = 'sum-count';
    chip.dataset.color = POOL_COLOR[c.status] ?? 'slate';
    chip.textContent = `${c.label} ${c.count}`;
    chip.title = `池里「${c.label}」的有 ${c.count} 个`;
    row.appendChild(chip);
  }

  const sep = document.createElement('span');
  sep.className = 'sum-sep';
  sep.setAttribute('aria-hidden', 'true');
  row.appendChild(sep);

  row.appendChild(sumStat(fmtCount(s.calls), '调用'));
  row.appendChild(sumStat(fmtCount(s.in), '输入'));
  row.appendChild(sumStat(fmtCount(s.out), '输出'));

  const cost = sumStat(fmtMoney(s.cost, s.costPartial === true), '花费');
  cost.title = s.cost === null
    ? (s.unpriced > 0 ? `${s.unpriced} 个模型查不到价格——这一池的花费算不出来` : '还没有用量')
    : s.costPartial === true
      ? `${s.unpriced} 个模型查不到价格，合计只是下限`
      : '按价格表折算（手写价 > 端点挂牌价）';
  row.appendChild(cost);

  // ★ `syncedAt` 为空 = 从没算过，写「未算过」而不是「—」：
  //   后者与"查不到价"撞形状，而这**两件事的处理方式完全不同**（一个去点重算，一个去补价格）。
  const when = sumStat(s.syncedAt === '' || s.syncedAt === undefined ? '未算过' : shortStamp(String(s.syncedAt)), '用量');
  if (s.syncedAt) when.title = `用量重算于 ${s.syncedAt}`;
  row.appendChild(when);

  el.appendChild(row);

  // 「提示」至多两条（服务端已截断）。**不带 emoji、不新增颜色**——一个琥珀色小圆点
  // 就够它和数字分开，而整页的墨仍是那套 `--st-*`。
  for (const text of Array.isArray(s.insights) ? s.insights : []) {
    const p = document.createElement('p');
    p.className = 'sum-insight';
    p.textContent = text;
    el.appendChild(p);
  }
}

/**
 * 「用量」那一格：`12 次` / `34.0k / 9.0k`（输入 / 输出）。
 * 两行都夹在窄列里，所以**小字只放得下最要紧的两个数**，其余进 `title`。
 * @param {any} u */
function usageCell(u) {
  const td = document.createElement('td');
  td.className = 'r-usage';
  const usage = u !== null && typeof u === 'object' ? u : NO_USAGE;

  if (usage.syncedAt === '') {
    const none = document.createElement('span');
    none.className = 'res-when';
    none.textContent = '未算过';
    none.title = '按会话记录算一次——点表头「重算用量」';
    td.appendChild(none);
    return td;
  }

  const box = document.createElement('div');
  box.className = 'res-usage';

  const calls = document.createElement('span');
  calls.className = 'res-calls';
  calls.textContent = `${fmtCount(usage.calls)} 次`;
  box.appendChild(calls);

  const split = document.createElement('span');
  split.className = 'res-split';
  split.textContent = `${fmtCount(usage.in)} / ${fmtCount(usage.out)}`;
  box.appendChild(split);

  box.title = `调用 ${usage.calls.toLocaleString('en-US')} 次\n`
    + `输入 ${usage.in.toLocaleString('en-US')} · 输出 ${usage.out.toLocaleString('en-US')}\n`
    + `重算于 ${usage.syncedAt}`;
  td.appendChild(box);
  return td;
}

/**
 * 「花费」那一格。`null` → `—`（不是 `$0`）；有模型没价 → 加 `+`（下限）。
 * @param {any} u */
function costCell(u) {
  const td = document.createElement('td');
  td.className = 'r-cost';
  const usage = u !== null && typeof u === 'object' ? u : NO_USAGE;

  const money = document.createElement('span');
  const priced = typeof usage.cost === 'number' && Number.isFinite(usage.cost);
  money.className = priced ? 'res-money' : 'res-money none';
  money.textContent = fmtMoney(usage.cost, priced && usage.unpriced > 0);
  money.title = !priced
    ? (usage.syncedAt === '' ? '还没算过用量' : `${usage.unpriced} 个模型查不到价格`)
    : usage.unpriced > 0
      ? `${usage.unpriced} 个模型查不到价格，这个数只是下限`
      : '按价格表折算（手写价 > 端点挂牌价）';
  td.appendChild(money);
  return td;
}

/** 优先级那三枚序号：`①②③`。**是语义不是装饰**——第一个就是默认模型。 */
const NUMERALS = ['①', '②', '③'];

/**
 * 池状态的配色。
 *
 * ★ **只映射到已有的 8 个 `--st-*` 色**（`style.css` 的 `[data-color]`），
 *   不新增颜色：这张表的每一枚丸都该和项目表的状态丸用同一套墨。
 *   语义是"要不要换一把 key"：
 *
 * | 状态 | 色 | 为什么 |
 * |---|---|---|
 * | 有余额 | green | 能用 |
 * | 无余额 | red | 这个月不能用了，**换人** |
 * | 密钥无效 | purple | 配置错了（不是没钱），处理方式不同 |
 * | 异常 / 连不上 | amber / slate | 说不清原因，别急着扔掉 |
 * | 未检测 | slate | 中性 |
 *
 * ⚠️ `无余额` 与 `密钥无效` 颜色必须不同：一个是"钱花完了，等月初"，
 *   一个是"这把 key 是错的，现在就要改"——同色会把两件事混成一个。
 * @type {Record<string, string>}
 */
const POOL_COLOR = {
  ok: 'green',
  no_quota: 'red',
  invalid: 'purple',
  net_fail: 'slate',
  other: 'amber',
  unknown: 'slate',
};

/**
 * 身份那一格：打码密钥（主）+ 昵称输入框 + 机器名（次要）+ 池状态丸。
 *
 * ★ 昵称只在前端**攒到 `change`**（失焦 / 回车）才发出去。每敲一个字就写一次盘，
 *   等于把半截昵称也写进去；而且每次回执都会把这一格重建成服务端那份——
 *   打字打到一半字就没了。
 *
 * ★ 清空 = **删键**（回到"没有昵称"）。这件判断在服务端（`set-label` 那条路），
 *   前端只把框里的原值递上去——不 trim、不截断，免得和 `normalizeTokenLabel()`
 *   变成两处定义。
 *
 * ★★ 池状态丸是一枚**下拉**：既能看，也能手动标。
 *   候选来自视图模型的 `poolStatuses`（与项目状态那张表同一条路：**词表只有
 *   服务端一处定义**，页面只画）。选完立刻发 `set-pool-status`，没有"保存"——
 *   与「拉取」「改昵称」同一条交互纪律。
 *
 * @param {any} r 资源行（视图模型里的一行）
 * @param {any} v 视图模型（要 `poolStatuses`）
 */
function identCell(r, v) {
  const cell = document.createElement('td');
  cell.className = 'r-ident';

  const box = document.createElement('div');
  box.className = 'res-ident';

  const head = document.createElement('div');
  head.className = 'res-ident-head';

  const key = document.createElement('span');
  key.className = 'res-key mono';
  key.textContent = r.masked;
  key.title = `打码后的密钥；完整凭证在 tokens/${r.name}.json 里`;

  const name = document.createElement('span');
  name.className = 'res-name mono';
  name.textContent = r.name;
  name.title = `配置里的名字：${r.name}`;

  const label = document.createElement('input');
  label.type = 'text';
  label.className = 'res-label';
  label.value = typeof r.label === 'string' ? r.label : '';
  label.placeholder = '昵称';
  label.setAttribute('aria-label', `${r.name} 的昵称`);
  // ★ 与服务端 `normalizeTokenLabel()` 的上限一致（那边是权威，这里只是不让敲超）。
  label.maxLength = 32;
  // ★ 回车 = 收工（与别的输入框一致）；提交仍走 `change`，不另设按键分支。
  label.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Enter') label.blur();
  });
  label.addEventListener('change', () => {
    void post('set-label', { name: r.name, label: label.value });
  });

  head.append(key, name, poolPill(r, v));
  box.append(head, label);
  cell.appendChild(box);
  return cell;
}

/**
 * 池状态丸：一枚看着像标签、其实是个 `<select>` 的小控件。
 *
 * ★ 为什么**不**做成"点一下轮换下一档"的按钮：那会把"我想把它标成无余额"
 *   变成一次猜谜（得点几下才对）。下拉是能看全的，而且和项目表的状态列
 *   是同一种交互。
 *
 * ★ `title` 是这一粒里**唯一**能放下探测原话的地方（`detail` 可能是网关回的
 *   一整句错误）：鼠标停一下就看得见，也不占行高。
 *
 * @param {any} r 资源行
 * @param {any} v 视图模型
 */
function poolPill(r, v) {
  const pool = r.pool !== null && typeof r.pool === 'object' ? r.pool : {};
  const status = typeof pool.status === 'string' ? pool.status : 'unknown';

  // ★ 外套一层 `.pool-pick`：小三角是 `::after` 画的（`<select>` 内部画不进去），
  //   与项目表那枚状态丸同一个做法。`--c` / `--cs` 由 `data-color` 定，挂在**外套**上，
  //   于是三角形和底色用的是同一组变量。
  const wrap = document.createElement('span');
  wrap.className = 'pool-pick';
  wrap.dataset.color = POOL_COLOR[status] ?? 'slate';

  const sel = document.createElement('select');
  sel.className = 'pool-pill';
  sel.setAttribute('aria-label', `${r.name} 的池状态`);

  const options = Array.isArray(v.poolStatuses) ? v.poolStatuses : [];
  // ★ 服务端给的词表里没有它（旧页面 + 新后台）⇒ 先塞一个**选不中**的占位，
  //   否则 `sel.value = status` 会把下拉悄悄设成第一项，看着像"状态刚变过"。
  if (!options.some((/** @type {any} */ o) => o?.status === status)) {
    const o = document.createElement('option');
    o.value = status;
    o.textContent = typeof pool.label === 'string' ? pool.label : status;
    o.disabled = true;
    sel.appendChild(o);
  }
  for (const o of options) {
    const el = document.createElement('option');
    el.value = o.status;
    el.textContent = o.label;
    sel.appendChild(el);
  }
  sel.value = status;
  sel.addEventListener('change', () => {
    void post('set-pool-status', { name: r.name, status: sel.value });
  });

  // ★ 补充信息放 `title`：探测原话（`HTTP 200 · 812ms` / `manual`）+ 检测时间。
  const bits = [];
  if (typeof pool.detail === 'string' && pool.detail !== '') bits.push(pool.detail);
  bits.push(typeof pool.checkedAt === 'string' && pool.checkedAt !== ''
    ? `检测于 ${shortStamp(pool.checkedAt)}`
    : '还没检测过');
  wrap.title = bits.join(' · ');
  sel.title = wrap.title;

  wrap.appendChild(sel);
  return wrap;
}

/**
 * 模型优先级那一格：`①②③` 的小标签，整格是一颗按钮，点开是对话框。
 *
 * ★ 这里显示的是 **token 级生效值**（`token.models ?? defaults.models`），
 *   不含路径层——资源表是按 token 看的。状态用一个灰标签标出来：
 *   「继承」= 没自己声明（跟着走）、「（显式空）」= 显式写了 `[]`。
 *   ⚠️ 两种都**画出来**而不是藏起来：用户得看得见"现在实际用的是哪几个"。
 *
 * ★ 「同网关不同」那个小标只在一个时候出现：同一个服务端下有多个 token，
 *   而它们的优先级不一样。那是"我明明统一过"这类疑问的唯一答案。
 *
 * ★ 不在这一格里平铺全部：一份清单可能有几十个 id，平铺会把这一行撑成
 *   一堵墙。鼠标停上去看全文（`title`），要改就点开。
 *
 * @param {any} r 资源行（视图模型里的一行）
 */
function priorityCell(r) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'res-models-btn';

  const box = document.createElement('span');
  box.className = 'res-models';

  const list = Array.isArray(r.priority) ? r.priority : [];
  if (list.length === 0) {
    const none = document.createElement('span');
    none.className = 'res-none';
    none.textContent = r.priorityState === 'empty' ? '（显式空）' : '继承';
    box.appendChild(none);
  } else {
    for (const [i, id] of list.slice(0, 3).entries()) {
      const chip = document.createElement('span');
      chip.className = 'res-model mono';
      chip.textContent = `${NUMERALS[i] ?? ''} ${id}`.trim();
      box.appendChild(chip);
    }
    if (list.length > 3) {
      const rest = document.createElement('span');
      rest.className = 'res-plus';
      rest.textContent = `+${list.length - 3}`;
      box.appendChild(rest);
    }
    if (r.priorityState === 'inherit') {
      const tag = document.createElement('span');
      tag.className = 'res-tag';
      tag.textContent = '继承';
      tag.title = '自己没声明，用的是全局默认那份';
      box.appendChild(tag);
    }
  }

  btn.appendChild(box);

  if (r.gatewayUnified === false) {
    const badge = document.createElement('span');
    badge.className = 'res-badge';
    badge.textContent = '同网关不同';
    badge.title = `同一个服务端下有 ${r.gatewayCount} 个身份，优先级却不一样`;
    btn.appendChild(badge);
  }

  btn.title = list.length === 0
    ? '还没有优先级——点开加几个'
    : `点开调整优先级（共 ${list.length} 个）：${list.join(' → ')}`;
  btn.setAttribute('aria-label', `${r.name} 的模型优先级`);
  btn.addEventListener('click', () => { openPriorityDialog(r.name); });
  return btn;
}

/**
 * 把时间戳收成 `MM-DD HH:mm`（本地时区）。
 *
 * ★ 表格里要的是"多久以前"，不是精确到毫秒的时刻——完整那一份在 `title` 里。
 *   解析不了的字符串原样返回：宁可显示一个怪值，也别显示 `Invalid Date`。
 *
 * @param {string} iso
 */
function shortStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── 屏 2：向导 ──

/**
 * 上一次画出来的"当前步"。
 *
 * ★ 四节一页排下来比一屏高，"下一步"之后新的一节往往还在下面折叠线以外。
 *   这里只认**换步**：`set-path` 那种每 220 毫秒一次的重画不抢滚动。
 * ★ 0 = 还没进过向导。第一次进来不滚（人刚点的「＋ 新建」，本来就看着页头）。
 */
let lastActiveStep = 0;

/** @param {any} v */
function paintWizard(v) {
  const w = v.wizard;
  if (w === null) return; // 到不了：`screen === 'wizard'` 时 reducer 一定给了向导

  paintSteps(w);
  paintBack(w);
  setWizardFlash(w.notice);

  paintPath(w);
  paintToken(v, w);
  paintModels(w);
  paintApply(v, w);

  const active = w.steps.find((/** @type {any} */ s) => s.state === 'active');
  const n = active === undefined ? 0 : active.n;
  if (n !== lastActiveStep) {
    if (lastActiveStep !== 0) revealStep(n);
    lastActiveStep = n;
  }
}

/**
 * 把某一步滚进视野。
 *
 * ★ `scroll-margin-top` 在样式里（页头是吸顶的，不扣掉就被它盖住）；
 *   `behavior` 跟着系统的"减少动态效果"走。
 *
 * ★ `block: 'start'`，不是 `'nearest'`：这是四节连在一起的一张长表，点「下一步」
 *   时新的一节**通常已经在视口下缘露了个头**——`nearest` 认为"看见了"就只挪
 *   最小的一点点，于是标题还在屏幕外，用户看到的是一节没有标题的控件。
 *   向导每次换步都要把新节的标题送到页头正下方。
 */
function revealStep(/** @type {number} */ n) {
  const ids = ['fs-path', 'fs-token', 'fs-models', 'fs-apply'];
  const el = $(ids[n - 1]);
  if (el === null) return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
}

/** 步骤条。**只**据 `steps[].state` 设禁用——没有第二处判断。 */
function paintSteps(w) {
  const ol = $('steps');
  ol.replaceChildren();
  for (const s of w.steps) {
    const li = document.createElement('li');
    li.className = s.state;
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = String(s.n);
    li.appendChild(n);
    li.appendChild(document.createTextNode(s.title));
    ol.appendChild(li);
  }

  // ★ 每个 fieldset 的启用状态**就是**它那一步的状态：`active` 才可动。
  //   于是"第 3 步不许改第 1 步的路径"这条规矩只有一处定义。
  const at = (/** @type {number} */ n) => w.steps[n - 1] !== undefined && w.steps[n - 1].state === 'active';
  $('fs-path').disabled = !at(1);
  $('fs-token').disabled = !at(2);
  $('fs-models').disabled = !at(3);
  $('fs-apply').disabled = !at(4);

  // ★ "走过的"与"还没到的"**都是 disabled**，可读者得一眼分开它们：
  //   `data-done` 让样式把走完的步画得亮一点、图例的序号转绿（还没到的是灰的）。
  //   判据仍然只有 `steps[].state` 一处——这里只是把它抄到一个属性上给 CSS 用。
  const ids = ['fs-path', 'fs-token', 'fs-models', 'fs-apply'];
  for (let i = 0; i < ids.length; i++) {
    $(ids[i]).toggleAttribute('data-done', w.steps[i] !== undefined && w.steps[i].state === 'done');
  }

  // 「改模型」那条短路（从主屏的 `e` 进来）：第 1/2/4 步整个不摆出来，
  // 「写入」直接放在第 3 步里——与终端逐字一致。
  $('fs-path').hidden = w.edit;
  $('fs-token').hidden = w.edit;
  $('fs-apply').hidden = w.edit;
  $('edit-apply-box').hidden = !w.edit;
  $('models-next-box').hidden = w.edit;
}

/** 「← 返回」这一个按钮要顶终端的三个键（Esc / 换身份 / 上一步），所以标签是活的。 */
function paintBack(w) {
  const label = w.token.mode === 'new' ? '← 换一个身份'
    : w.edit ? '← 取消'
      : w.step === 1 ? '← 返回列表'
        : '← 上一步';
  setText('wiz-back', label);
}

/** @param {string} text */
function setWizardFlash(text) {
  const el = $('wizard-flash');
  el.hidden = text === '';
  el.textContent = text;
}

/**
 * 上一次画进 `<select>` 的那份子目录清单。
 *
 * ★ 没有它就得每次 `render()` 都重建一遍，而 `render()` 在打路径的时候
 *   每 220 毫秒跑一次（防抖的 `set-path` 回来就重画）。重建会把用户当前的
 *   选中项和键盘焦点一起抹掉——一个只在打字时出现的"选择框自己弹回去了"。
 */
let lastDirs = [];

/** 第 1 步：路径。 */
function paintPath(w) {
  const text = $('path-text');
  // ★ 用户正在这个框里打字时**不许**回写：服务端那份是 220 毫秒前的快照，
  //   回写会把光标顶到末尾，而用户的下一个字符就落到别处去了。
  if (document.activeElement !== text && text.value !== w.path.text) text.value = w.path.text;

  setText('path-pending', w.path.pending ? '读取中…' : '');

  if (!sameList(lastDirs, w.path.dirs)) {
    lastDirs = w.path.dirs.slice();
    const sel = $('path-dirs');
    sel.replaceChildren();
    for (const name of lastDirs) {
      // ★ 不给 `value`：`<option>` 的 `value` 默认就是它的文字，而这里
      //   **只**用 `selectedIndex`（位置即索引，和 `enter-dir{index}` 对齐）。
      const o = document.createElement('option');
      o.textContent = name;
      sel.appendChild(o);
    }
  }
  syncPathEnter();
  syncPathOps();
}

/**
 * 「复制」「打开」跟着框里的**实时**文字走：空的就都点不动。
 *
 * ★ 判据是输入框里的值，不是 `w.path.text`：那份是 220 毫秒前的快照。
 *   用户把路径删空的那一刻这两个按钮就该灰，而不是等一次往返。
 */
function syncPathOps() {
  const blank = $('path-text').value.trim() === '';
  $('path-copy').disabled = blank;
  $('path-open').disabled = blank;
}

/**
 * 选中了才让进。
 *
 * ★★ 为什么**不**在 `change` 里直接进目录：`size > 1` 的 `<select>` 是
 *    列表框，**方向键也会发 `change`**。直接进的话，"往下翻一屏"会连着进
 *    好几个目录，而用户只是想看看里面有什么。进目录是个有后果的动作
 *    （会改路径、会重列目录），得有一次明确的点击或回车。
 */
function syncPathEnter() {
  $('path-enter').disabled = $('path-dirs').selectedIndex < 0;
}

function enterDir() {
  const sel = $('path-dirs');
  const i = sel.selectedIndex;
  if (i < 0) return;
  // ★ 进完就把选中抹掉：浏览器只在值**变化**时发 `change`，不抹的话
  //   "再点同一格"按钮是灰的（`syncPathEnter()` 会把它关掉）。
  sel.selectedIndex = -1;
  syncPathEnter();
  void post('enter-dir', { index: i });
}

/** @param {string[]} a @param {string[]} b */
function sameList(a, b) {
  return a.length === b.length && a.every((x, /** @type {number} */ i) => x === b[i]);
}

/**
 * 用户点了「自定义…」但还没敲字的那个状态。
 *
 * ★★ 为什么必须有这个本地变量：选完「自定义…」的那一帧，服务端手里的地址
 *   还是空的——下一次 `render()` 会照着"空地址不是自定义的"把选择框弹回
 *   「（未设置）」，用户手指还没落到输入框上，那一格就自己关了。
 *
 * ★ 它**只在一屏之内有效**：换步 / 换身份 / 换模式时清掉（`urlKey` 那条）。
 */
let urlCustom = false;

/** 上一次算 `urlCustom` 时的"身份是谁"——用来认出"换人了，草稿作废"。 */
let urlKey = '';

/** 第 2 步：身份与服务端地址（两者成对联动）。 */
function paintToken(v, w) {
  const t = w.token;
  const isNew = t.mode === 'new';

  // ── 选一个现成的 ──
  $('token-pick-box').hidden = isNew;
  $('token-pick-ops').hidden = isNew;
  $('token-newbox').hidden = !isNew;

  const sel = $('token-pick');
  sel.replaceChildren();
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = v.tokens.length === 0 ? '— 还没有身份，先新建一个 —' : '— 选一个身份 —';
  sel.appendChild(ph);
  for (const row of v.tokens) {
    const o = document.createElement('option');
    o.value = String(row.index);
    o.textContent = `${row.name} · ${row.masked}`;
    sel.appendChild(o);
  }
  const hit = v.tokens.find((/** @type {any} */ r) => r.name === t.chosen);
  sel.value = hit === undefined ? '' : String(hit.index);

  // ── 服务端地址：下拉 + 自定义 ──
  //
  // ★★ 候选项**服务端已经算好了**（`urlOptions`）：`（未设置）` + 每个被
  //   某个身份用着的地址（去重）+ `自定义…`。这里只画，不判断"哪些地址出现过"。
  const urls = $('token-url');
  urls.replaceChildren();
  for (const o of t.urlOptions) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    urls.appendChild(opt);
  }

  // 换步 / 换身份 / 换模式 ⇒ 上一个身份的"自定义"草稿作废
  const key = `${w.step}|${t.mode}|${t.chosen}`;
  if (key !== urlKey) {
    urlKey = key;
    urlCustom = false;
  }
  const listed = t.urlOptions.some((/** @type {any} */ o) => o.value !== '' && o.value === t.baseUrl);
  const custom = urlCustom || (t.baseUrl !== '' && !listed);
  urls.value = custom ? CUSTOM_URL : t.baseUrl;

  $('token-url-custom-box').hidden = !custom;
  const box = $('token-url-custom');
  if (!custom) {
    if (box.value !== '') box.value = '';
  } else if (document.activeElement !== box && box.value !== t.baseUrl) {
    box.value = t.baseUrl;
  }

  // ── 新建一个 ──
  const name = $('token-name');
  if (document.activeElement !== name && name.value !== t.name) name.value = t.name;
  if (!isNew && document.activeElement !== name) name.value = '';

  // ★★ 明文密钥**不进视图模型**（服务端那份只有长度），所以这个框的值
  //    **只**来自用户的手，永远不由 `render()` 写回。离开"新建"态时清掉它。
  const secret = $('token-secret');
  if (!isNew && document.activeElement !== secret) secret.value = '';

  const len = secret.value.length;
  setText('token-len', len === 0 ? '密钥只在这个框里，保存时走一次本机回环。' : `已填 ${len} 个字符。`);
}

/** 第 3 步：模型。 */
function paintModels(w) {
  const m = w.models;

  const PHASE = {
    idle: '还没拉过清单。',
    loading: '正在拉取清单…',
    ok: `拉到 ${m.ids.length} 个模型。`,
    // ★ 裸的 `fetch failed` 看不出**哪件事**失败了——那一行旁边就是勾选框，
    //   不说清楚它读起来像"勾选坏了"。服务端给的错误本身是有上下文的，补一句前缀。
    fail: `拉取失败：${m.error}`,
  };
  const state = $('models-state');
  state.textContent = PHASE[m.phase] ?? m.phase;
  state.className = m.phase === 'fail' ? 'hint bad' : m.phase === 'ok' ? 'hint good' : 'hint';

  // ★ 回执（「已加入 xxx」）必须**单独一行**：拉取失败时 phase 一直是 `fail`，
  //   把它拼进上面那一行就等于用错误色宣布一次成功（真实的观感错乱）。
  const note = $('models-notice');
  note.textContent = m.notice;
  note.hidden = m.notice === '';

  // ── 可选（勾选框） ──
  const list = $('models-list');
  list.replaceChildren();
  if (m.ids.length === 0) {
    list.appendChild(emptyLine('清单是空的——可以在下面手敲一个 id。'));
  } else {
    const picked = new Set(m.checked.map((/** @type {any} */ c) => c.id));
    for (const id of m.ids) {
      const li = document.createElement('li');
      const lab = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = picked.has(id);
      box.dataset.id = id;
      lab.appendChild(box);
      lab.appendChild(document.createTextNode(id));
      li.appendChild(lab);
      list.appendChild(li);
    }
  }

  // ── 已选（按优先级）──
  const ol = $('models-picked');
  ol.replaceChildren();
  if (m.checked.length === 0) {
    ol.appendChild(emptyLine('还没选。一个都不选也行——那一层就不声明模型。'));
  } else {
    m.checked.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
      const li = document.createElement('li');

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = `${i + 1}.`;
      li.appendChild(rank);

      const name = document.createElement('span');
      name.className = 'grow';
      name.textContent = c.id;
      li.appendChild(name);

      // ★ 两端的 `disabled` **预先算好了**（`canUp`/`canDown`）——
      //   这里没有 `i === 0` 这种判断，"第几项能往上"只有一处定义。
      li.appendChild(mini('↑', c.id, -1, !c.canUp));
      li.appendChild(mini('↓', c.id, 1, !c.canDown));

      ol.appendChild(li);
    });
  }
}

/** @param {string} text @param {string} id @param {number} dir @param {boolean} off */
function mini(text, id, dir, off) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'mini';
  b.textContent = text;
  b.dataset.id = id;
  b.dataset.dir = String(dir);
  b.disabled = off;
  b.title = dir < 0 ? '往上提一位（越靠前优先级越高）' : '往下挪一位';
  return b;
}

/** 第 4 步：落点。 */
function paintApply(v, w) {
  const dl = $('apply-summary');
  dl.replaceChildren();

  const row = (/** @type {string} */ k, /** @type {string} */ val) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = val;
    dl.appendChild(dt);
    dl.appendChild(dd);
  };

  row('目录', w.path.text);
  row('身份', w.token.chosen === '' ? '（还没选）' : w.token.chosen);
  // ★ 地址是第 2 步改过之后**会写回那个身份**的那个值——写之前就摆出来。
  //   没改过的话这里就是它自己的地址，写盘那一步会跳过（不重复写同一个值）。
  row('服务端', w.token.baseUrl === '' ? '（未设置）' : w.token.baseUrl);
  row('模型', w.models.checked.length === 0
    ? '0 个（不声明）'
    : `${w.models.checked.length} 个：${w.models.checked.map((/** @type {any} */ c) => c.id).join(' → ')}`);
  // ★ 这一行的**标签**不能叫「写入」——下面那颗按钮就叫「写入」，两处一字不差
  //   会让人以为标签是按钮的一部分。
  row('写到', `全局绑定表 + 项目本地 ${v.projectFile}`);

  $('apply-go').disabled = w.token.chosen === '' || (!w.edit && w.step !== 4);
}

/** @param {string} text */
function emptyLine(text) {
  const el = document.createElement('li');
  el.className = 'empty-line';
  el.textContent = text;
  return el;
}

// ───────────────────── 状态管理对话框 ─────────────────────

/**
 * 打开「管理状态」。
 *
 * ★ 草稿**从视图里抄一份**，之后只在草稿上改——点「取消」就是丢掉这份草稿，
 *   一个字节都没写到盘上（与"改一处写一处"正好相反，见 `index.html` 那段注释）。
 */
function openStatusDialog() {
  if (view === null) return;
  statusDraft = view.statuses.map((/** @type {any} */ s) => ({ id: s.id, label: s.label, color: s.color }));
  statusError = '';
  paintStatusDialog();

  const dlg = $('status-dialog');
  // ★ `showModal()` 才有焦点陷阱；老浏览器上退回 `open` 属性（至少能看见）。
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeStatusDialog() {
  const dlg = $('status-dialog');
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
  statusDraft = null;
  statusError = '';
}

/** 把草稿画进对话框。**只在开、增、删、改色时调**——不跟着每次 `render()`。 */
function paintStatusDialog() {
  if (statusDraft === null || view === null) return;

  const ul = $('status-edit');
  ul.replaceChildren();
  statusDraft.forEach((s, i) => ul.appendChild(statusRow(s, i)));

  setText('status-file', view.statusFile === '' ? '' : `存在：${view.statusFile}`);

  const err = $('status-error');
  err.hidden = statusError === '';
  err.textContent = statusError;
}

/**
 * 对话框里的一行。
 *
 * @param {{id: string, label: string, color: string}} s 草稿里的一项
 * @param {number} i 它在草稿里的位置（`data-i` 让事件找得回来）
 */
function statusRow(s, i) {
  const li = document.createElement('li');
  li.className = 'srow';
  li.dataset.i = String(i);

  // ★ 色点与下拉**并排**：下拉管"选哪种颜色"，色点管"看起来是什么样"。
  //   只留下拉的话，用户在点开之前根本不知道 `琥珀` 长什么样。
  const dot = document.createElement('span');
  dot.className = 'swatch';
  dot.dataset.color = s.color;

  const color = document.createElement('select');
  color.className = 'srow-color';
  color.setAttribute('aria-label', '颜色');
  for (const c of COLORS) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = COLOR_NAME[c];
    color.appendChild(o);
  }
  color.value = s.color;

  const label = document.createElement('input');
  label.type = 'text';
  label.className = 'srow-label';
  label.value = s.label;
  // ★ 与服务端 `cleanLabel()` 的上限一致（那边是权威，这里只是不让敲超）。
  label.maxLength = 16;
  label.placeholder = '状态名称';
  label.setAttribute('aria-label', '名称');

  // ★ 两端的禁用**在这里**算（`canUp` 那套的同一手法）：挪不动的箭头当场灰掉，
  //   而不是点一下才被服务端拒。
  const up = button('↑', 'mini', () => moveStatus(i, -1));
  up.disabled = i === 0;
  up.title = '往前挪一位';
  const down = button('↓', 'mini', () => moveStatus(i, 1));
  down.disabled = i === statusDraft.length - 1;
  down.title = '往后挪一位';
  const del = button('删除', 'mini danger-ghost', () => dropStatus(i));
  del.title = '删掉这一档（还有项目在用的话，保存时会被拒）';

  li.append(dot, color, label, up, down, del);
  return li;
}

/** @param {number} i @param {number} dir */
function moveStatus(i, dir) {
  if (statusDraft === null) return;
  const j = i + dir;
  if (j < 0 || j >= statusDraft.length) return;
  const [row] = statusDraft.splice(i, 1);
  statusDraft.splice(j, 0, row);
  paintStatusDialog();
}

/** @param {number} i */
function dropStatus(i) {
  if (statusDraft === null) return;
  statusDraft.splice(i, 1);
  paintStatusDialog();
}

/**
 * 「保存」：**一次**提交整张表。
 *
 * ★★ 成功与否**不靠** `notice` 猜：服务端成功时不写 `notice`（那条通道是给
 *   用户看的话，不是给程序读的信号），所以拿"notice 变没变"判断会在
 *   "连续两次同样的错误"上判反。这里比的是**回执本身**——服务端把 id 补齐、
 *   名字去掉首尾空白之后回了一份，它和草稿一模一样就是存进去了。
 *   （名字的上限由输入框的 `maxLength` 保证，所以不必在这里再截一次。）
 */
async function saveStatuses() {
  if (statusDraft === null || view === null) return;

  const draft = statusDraft.map((s) => ({ id: s.id, label: s.label, color: s.color }));
  const save = $('status-save');
  const cancel = $('status-cancel');
  save.disabled = true;
  cancel.disabled = true;
  await post('save-statuses', { statuses: draft });
  save.disabled = false;
  cancel.disabled = false;

  if (view === null) return;
  const saved = view.statuses.length === draft.length
    && view.statuses.every((/** @type {any} */ s, /** @type {number} */ i) => (
      s.label === draft[i].label.trim() && s.color === draft[i].color
    ));

  if (saved) {
    closeStatusDialog();
    return;
  }
  // ★ 请求**根本没发出去**时 `view` 一个字都没变，`notice` 还是旧的那句——
  //   拿它当错误显示会把人引到错的方向去。那种情况下要说的是"断线了"。
  statusError = fatalText !== ''
    ? fatalText
    : view.notice !== '' ? view.notice : '没能保存，再试一次。';
  paintStatusDialog();
}

// ───────────────────── 模型优先级对话框 ─────────────────────

/** 资源表里找一行。对话框开着、那一行却被别处删掉时返回 `null`。 */
function rowOf(name) {
  const rows = view !== null && Array.isArray(view.resources) ? view.resources : [];
  return rows.find((/** @type {any} */ r) => r.name === name) ?? null;
}

/**
 * 打开某个 token 的优先级对话框。
 *
 * ★ 草稿**从视图里抄一份**，之后只在草稿上改——点「取消」就是丢掉这份草稿，
 *   一个字节都没写到盘上（与状态对话框同一个模子）。
 *
 * @param {string} name token 名（资源表那一行的 `name`）
 */
function openPriorityDialog(name) {
  const r = rowOf(name);
  if (r === null) return;
  priorityName = name;
  priorityDraft = Array.isArray(r.priority) ? r.priority.slice() : [];
  priorityError = '';
  $('pr-new').value = '';
  paintPriorityDialog();

  const dlg = $('priority-dialog');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closePriorityDialog() {
  const dlg = $('priority-dialog');
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
  priorityDraft = null;
  priorityName = '';
  priorityError = '';
}

/** 把草稿画进对话框。**只在开、增、删、调序、保存失败时调**——不跟着每次 `render()`。 */
function paintPriorityDialog() {
  if (priorityDraft === null) return;

  // ★ 标题的主次与资源表第一列一致：打码密钥 → 昵称 → 机器名。
  const r = rowOf(priorityName);
  const masked = r === null ? priorityName : r.masked;
  const label = r === null || r.label === '' ? '' : ` · ${r.label}`;
  setText('pr-title', `${masked}${label} · ${priorityName}`);

  const list = $('pr-list');
  list.replaceChildren();
  if (priorityDraft.length === 0) {
    list.appendChild(emptyLine('还没有任何一项。加一个模型 id，第一个就是默认模型。'));
  }
  priorityDraft.forEach((id, i) => list.appendChild(priorityRow(id, i)));

  // ★ 候选由服务端给（资源表里出现过的 id ∪ 本行优先级），前端**不查网络**——
  //   这个对话框不该有"打开就转圈"的状态，拉取是资源表那一列的事。
  const data = $('pr-candidates');
  data.replaceChildren();
  for (const id of candidateIds()) {
    const o = document.createElement('option');
    o.value = id;
    data.appendChild(o);
  }

  // ★ 复选框只在**真有同网关的邻居**时出现，默认勾选当且仅当这组已经统一：
  //   已统一的保持统一，已分叉的默认只改自己——统一必须是一次显式动作。
  const count = r === null || !Number.isFinite(r.gatewayCount) ? 1 : r.gatewayCount;
  $('pr-gate-wrap').hidden = count < 2;
  $('pr-gateway').checked = r !== null && r.gatewayUnified === true;
  setText('pr-gate-text', `同网关的 ${count} 个 token 一并套用`);

  const err = $('pr-error');
  err.hidden = priorityError === '';
  err.textContent = priorityError;
}

/**
 * 候选模型 id：本行现在的优先级 + 资源表里出现过的全部 id（去重保序）。
 *
 * ★ 全是**服务端已经给过的**数据——这个对话框不查网络。
 *   本行的排最前：正在改的那几个最可能还要再挑一次。
 */
function candidateIds() {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  /** @param {any} id */
  const add = (id) => {
    if (typeof id !== 'string' || id === '' || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const id of priorityDraft ?? []) add(id);
  const rows = view !== null && Array.isArray(view.resources) ? view.resources : [];
  for (const r of rows) for (const id of Array.isArray(r.models) ? r.models : []) add(id);
  return out;
}

/**
 * 对话框里的一行：`序号 | id（mono） | ↑ ↓ 删除`。
 *
 * @param {string} id 模型 id
 * @param {number} i 它在草稿里的位置（`data-i` 让事件找得回来）
 */
function priorityRow(id, i) {
  const li = document.createElement('li');
  li.className = 'prow';
  li.dataset.i = String(i);

  const n = document.createElement('span');
  n.className = 'prow-n';
  n.textContent = String(i + 1);

  const text = document.createElement('span');
  text.className = 'prow-id mono';
  text.textContent = id;
  text.title = id;

  // ★ 两端的禁用**在这里**算（与状态对话框同一手法）：挪不动的箭头当场灰掉。
  const total = priorityDraft === null ? 0 : priorityDraft.length;
  const up = button('↑', 'mini', () => { movePriority(i, -1); });
  up.disabled = i === 0;
  up.title = '提到更前面（更优先）';
  const down = button('↓', 'mini', () => { movePriority(i, 1); });
  down.disabled = i === total - 1;
  down.title = '往后挪一位';
  const del = button('删除', 'mini danger-ghost', () => { dropPriority(i); });
  del.title = '从列表里去掉（全删光就是回到继承）';

  li.append(n, text, up, down, del);
  return li;
}

/** @param {number} i @param {number} dir */
function movePriority(i, dir) {
  if (priorityDraft === null) return;
  const j = i + dir;
  if (j < 0 || j >= priorityDraft.length) return;
  const [row] = priorityDraft.splice(i, 1);
  priorityDraft.splice(j, 0, row);
  priorityError = '';
  paintPriorityDialog();
}

/** @param {number} i */
function dropPriority(i) {
  if (priorityDraft === null) return;
  priorityDraft.splice(i, 1);
  priorityError = '';
  paintPriorityDialog();
}

/**
 * 「加入」：手敲的 id 也算——候选只是方便，不是限制。
 *
 * ★ 重复项当场拒并说一句，而不是静默忽略：静默忽略会让人以为加进去了，
 *   然后一路保存，回来发现列表里只有一个。
 */
function addPriority() {
  if (priorityDraft === null) return;
  const input = $('pr-new');
  const id = input.value.trim();
  if (id === '') return;
  if (priorityDraft.includes(id)) {
    priorityError = `「${id}」已经在列表里了`;
    paintPriorityDialog();
    return;
  }
  priorityDraft.push(id);
  input.value = '';
  priorityError = '';
  paintPriorityDialog();
  // ★ 画完输入框还是同一个 DOM 节点，焦点不丢——接着敲下一个。
  input.focus();
}

/**
 * 「保存」：**一次**提交整张列表。
 *
 * ★★ 成功与否**不靠** `notice` 猜（与 `saveStatuses()` 同一条理由）：服务端成功时
 *   不写 `notice`，拿它判断会在"连续两次同样的错误"上判反。这里比**回执本身**。
 *
 * ★★ 空列表那一支要看 `priorityState`：服务端把空数组**删键**（回到继承），
 *   于是回执里的 `priority` 是继承来的那份、不是 `[]`。拿数组比会永远判成失败。
 */
async function savePriority() {
  if (priorityDraft === null || view === null) return;

  // ★ 先抄下来：`await` 期间按 Esc 会把这两个变量清掉。
  const name = priorityName;
  const ids = priorityDraft.slice();
  // ★ 复选框藏起来时**不认它的值**：`hidden` 只是看不见，DOM 里那个勾还在。
  const gateway = $('pr-gateway').checked && !$('pr-gate-wrap').hidden;
  const save = $('pr-save');
  const cancel = $('pr-cancel');
  save.disabled = true;
  cancel.disabled = true;
  await post('save-priority', { name, ids, scope: gateway ? 'gateway' : 'token' });
  save.disabled = false;
  cancel.disabled = false;

  if (view === null) return;
  if (prioritySaved(name, ids)) {
    closePriorityDialog();
    return;
  }
  // ★ 请求没发出去时 `view` 一个字都没变，`notice` 还是旧的那句——那种情况要说"断线了"。
  priorityError = fatalText !== ''
    ? fatalText
    : view.notice !== '' ? view.notice : '没能保存，再试一次。';
  paintPriorityDialog();
}

/**
 * 存进去了没有？——比**回执**，不猜文案。
 *
 * @param {string} name token 名
 * @param {string[]} ids 刚提交的那份列表
 */
function prioritySaved(name, ids) {
  const r = rowOf(name);
  if (r === null) return false;
  if (ids.length === 0) return r.priorityState === 'inherit';
  const now = Array.isArray(r.priority) ? r.priority : [];
  return now.length === ids.length && now.every((id, i) => id === ids[i]);
}

// ───────────────────── 添加 token 对话框 ─────────────────────

/**
 * 打开添加对话框。三格输入框清空重来——上一次没保存的东西不该"还在"。
 *
 * ★ 草稿就是那三个输入框自己的值：没有 ↑/↓、没有逐行编辑，不需要抄数组。
 */
function openAddDialog() {
  addOpen = true;
  addError = '';
  $('ad-name').value = '';
  $('ad-secret').value = '';
  $('ad-url').value = '';
  $('ad-error').hidden = true;

  const dlg = $('add-dialog');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function closeAddDialog() {
  const dlg = $('add-dialog');
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
  addOpen = false;
  addError = '';
}

/**
 * 「保存」：一条 `add-token`。
 *
 * ★★ 成功与否**比回执不猜文案**（与 `savePriority()` 同一条理由）：成功判据是
 *   回执 `resources` 里**出现这一行**——notice 会被下一次渲染换掉，行不会。
 */
async function saveAddToken() {
  if (!addOpen) return;
  const name = $('ad-name').value.trim();
  const secret = $('ad-secret').value;
  const baseUrl = $('ad-url').value.trim();
  if (name === '') { showAddError('名字不能为空'); return; }
  if (secret.trim() === '') { showAddError('密钥不能为空'); return; }

  const save = $('ad-save');
  const cancel = $('ad-cancel');
  save.disabled = true;
  cancel.disabled = true;
  await post('add-token', { name, secret, baseUrl });
  save.disabled = false;
  cancel.disabled = false;

  // ★ 密钥**立刻**清掉：无论成败，它留在框里只有肩窥一个用处。
  $('ad-secret').value = '';
  if (view !== null && Array.isArray(view.resources)
      && view.resources.some((/** @type {any} */ r) => r?.name === name)) {
    closeAddDialog();
    return;
  }
  showAddError(fatalText !== ''
    ? fatalText
    : view !== null && view.notice !== '' ? view.notice : '没能保存，再试一次。');
}

/** @param {string} text */
function showAddError(text) {
  addError = text;
  const err = $('ad-error');
  err.hidden = text === '';
  err.textContent = text;
}

// ───────────────────── 环境变量对话框（env 编辑器） ─────────────────────

/**
 * 打开环境变量对话框。
 *
 * @param {'token'|'defaults'} target 编辑哪个目标
 * @param {string} name `target === 'token'` 时的 token 名
 */
function openEnvDialog(target, name) {
  envTarget = target;
  envName = name;
  envError = '';

  // ★ 预填**本层原文**（不是合并结果）：对话框改的就是这一层，把合并后的
  //   值填进来，一保存就把继承来的键"物化"成本层键了。
  let src = {};
  if (target === 'token') {
    const row = view !== null && Array.isArray(view.resources)
      ? view.resources.find((/** @type {any} */ r) => r?.name === name)
      : undefined;
    if (row !== undefined && row.env && typeof row.env === 'object') src = row.env;
    setText('env-title', `身份 ${name === '' ? '' : `${name} · `}的本层环境变量`);
  } else {
    if (view !== null && view.defaultsEnv && typeof view.defaultsEnv === 'object') {
      src = view.defaultsEnv;
    }
    setText('env-title', '全局默认的环境变量（每层 token 可再覆盖）');
  }
  // 两个空格缩进：手改 JSON 的可读性靠它，值里有换行也照样成立。
  $('env-text').value = Object.keys(src).length === 0 ? '{\n  \n}' : JSON.stringify(src, null, 2);
  $('env-error').hidden = true;

  const dlg = $('env-dialog');
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  envOpen = true;
}

function closeEnvDialog() {
  const dlg = $('env-dialog');
  if (typeof dlg.close === 'function') dlg.close();
  else dlg.removeAttribute('open');
  envOpen = false;
  envError = '';
  // 草稿随手清：留在 textarea 里的 JSON 下次打开会被预填覆盖，但万一这次
  // 填的是敏感值，不该有"关了还躺在那儿"的一屏。
  $('env-text').value = '';
}

/**
 * 「保存」：一条 `save-env`。
 *
 * ★ `JSON.parse` 的早反馈在这里给（行号列号都指向用户刚敲的那段文本）；
 *   正式校验（空键名 / 值必须是字符串）只在服务端——前端永远不做最裁决。
 * ★★ 成功判据 = **回执比对**（行 `env` / `defaultsEnv` 与草稿一致），
 *   不猜 notice（与 `saveAddToken()` 同一条理由）。
 */
async function saveEnv() {
  if (!envOpen) return;
  const text = $('env-text').value;
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    showEnvError(`JSON 解析失败：${msg(err)}`);
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    showEnvError('必须是 JSON 对象，例如 {"FOO": "1"}');
    return;
  }

  const save = $('env-save');
  const cancel = $('env-cancel');
  save.disabled = true;
  cancel.disabled = true;
  const body = envTarget === 'token'
    ? { target: 'token', name: envName, env: parsed }
    : { target: 'defaults', env: parsed };
  await post('save-env', body);
  save.disabled = false;
  cancel.disabled = false;

  // 回执比对：服务器存下的那份与草稿**逐键一致**才算成。
  let receipt = undefined;
  if (envTarget === 'token') {
    const row = view !== null && Array.isArray(view.resources)
      ? view.resources.find((/** @type {any} */ r) => r?.name === envName)
      : undefined;
    receipt = row !== undefined ? row.env : undefined;
  } else if (view !== null) {
    receipt = view.defaultsEnv;
  }
  if (receipt !== undefined && sameEnv(receipt, parsed)) {
    closeEnvDialog();
    return;
  }
  showEnvError(fatalText !== ''
    ? fatalText
    : view !== null && view.notice !== '' ? view.notice : '没能保存，再试一次。');
}

/**
 * 两份 env 是否逐键一致（键集 + 每个值）。深比较只到字符串值这一层——
 * `normalizeEnv()` 保证不会再深了。
 *
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function sameEnv(a, b) {
  if (a === null || typeof a !== 'object' || Array.isArray(a)) return false;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && b[k] === a[k]);
}

/** @param {string} text */
function showEnvError(text) {
  envError = text;
  const err = $('env-error');
  err.hidden = text === '';
  err.textContent = text;
}

// ───────────────────────────── 小件 ─────────────────────────────

/**
 * @param {string} text
 * @param {string} cls
 * @param {() => void} onClick
 */
function button(text, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  if (cls !== '') b.className = cls;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** 「保存并继续」只在名字非空时可用。判据是**框里的实时值**，不是服务端那份。 */
function syncSaveButton(busy) {
  $('token-save').disabled = busy || $('token-name').value.trim() === '';
}

// ───────────────────────────── 接线 ─────────────────────────────

// ── 页头 / 左栏 ──
$('act-reload').addEventListener('click', () => { void post('reload'); });
$('act-new').addEventListener('click', () => { void post('new'); });
$('act-fetch-all').addEventListener('click', () => { void post('refresh-all-models'); });

/**
 * 页头那颗「全部检测」。
 *
 * ★★ **前端逐条发 `check-token`，服务端不做批量**。理由有两条，
 *   都跟时间有关：一次探测最长 10 秒，18 个 token 就是将近三分钟——把这么长
 *   的活塞进**一个** `POST api/op`，等于让整页在期间只有"忙"一个态
 *   （服务端还有一个空闲计时在跑）。逐条发则每探完一个就重画一行，
 *   用户看得见它在往前走，也随时能停手。
 *
 * ★ 名单是**这一帧的快照**（`view.resources`）：探测本身不改名单，
 *   中途有别的窗口加了 token 不该让这次循环多跑一个。
 * ★ 没有地址的那些**跳过**——与行上那颗「检测」按钮的 `disabled` 同一判据，
 *   探了也只会得到一句"没有 baseUrl"。
 */
async function checkAllTokens() {
  if (view === null) return;
  const rows = (Array.isArray(view.resources) ? view.resources : [])
    .filter((/** @type {any} */ r) => typeof r?.url === 'string' && r.url !== '' && typeof r?.name === 'string');
  for (const r of rows) {
    await post('check-token', { name: r.name });
    // ★ 用户点了「退出」：`post()` 之后 `closed` 会是 true，这时继续发只是空转。
    if (closed) return;
  }
}

$('act-check-all').addEventListener('click', () => { void checkAllTokens(); });
// ★ 「重算用量」与命令行的 `pool sync` 走**同一份记账**（服务端 `syncPoolUsage()`）：
//   这里只发一个空载荷的 op，页面一个数都不自己算。
$('act-sync').addEventListener('click', () => { void post('sync-usage', {}); });
$('act-add-token').addEventListener('click', openAddDialog);
$('act-defaults-env').addEventListener('click', () => { openEnvDialog('defaults', ''); });
$('env-cancel').addEventListener('click', closeEnvDialog);
$('env-save').addEventListener('click', () => { void saveEnv(); });
// ★ `close` 事件在 Esc / 点 backdrop / 程序化 close() 时都会来——草稿的重置
//   收口在这里，三条路走同一份逻辑（与 add-dialog 同一模式）。
$('env-dialog').addEventListener('close', () => {
  envOpen = false;
  envError = '';
  $('env-text').value = '';
});

/**
 * 切视图。**只重画，不发请求**——两份数据本来就在同一份视图模型里。
 *
 * ★ 切走时不把 `filter` 清掉：那是"项目"那一栏自己的筛选条件，切回来还是
 *   刚才那一档才是对的（一个视图的临时状态不该被另一个视图顺手抹掉）。
 *
 * @param {string} next
 */
function switchPane(next) {
  if (pane === next) return;
  pane = next;
  render();
}

$('view-projects').addEventListener('click', () => { switchPane('projects'); });
$('view-resources').addEventListener('click', () => { switchPane('resources'); });
$('act-quit').addEventListener('click', () => { void post('quit'); });
$('status-manage').addEventListener('click', openStatusDialog);

/**
 * 左栏筛选：纯本地的一次重画（理由见 `filter` 那段注释）。
 *
 * ★ 用**事件委托**：那一列是每次 `render()` 重建的，逐个挂监听等于每帧
 *   漏一批闭包，而且新画出来的那些还得再挂一遍。
 */
$('filters').addEventListener('click', (/** @type {any} */ e) => {
  const b = e.target.closest('button[data-id]');
  if (b === null) return;
  filter = b.dataset.id ?? '';
  render();
});

// ── 确认横幅。★ 「是」是一个**写着"删除"的按钮**——那个动作本身就是明确同意，
//      所以这里可以直接发 `confirm-yes`（终端那边只有 `y` 算同意，`Enter` 不算）。
$('banner-yes').addEventListener('click', () => { void post('confirm-yes'); });
$('banner-no').addEventListener('click', () => { void post('confirm-no'); });

// ── 向导：通用 ──
$('wiz-back').addEventListener('click', () => { void post('back'); });

// ── 第 1 步 ──
/**
 * 把输入框里**此刻**的文字推给服务端。
 *
 * ★ 路径框是边打边推（带防抖），所以点「下一步」时服务端手上那份可能还是
 *   220 毫秒前的。不先冲一下的话，用户"打完就点下一步"会带着**旧路径**过关——
 *   一个只在手快时出现的 bug。
 */
async function flushPath() {
  if (view === null || view.wizard === null) return;
  const el = $('path-text');
  if (el.value === view.wizard.path.text) return;
  await post('set-path', { value: el.value });
}

let pathTimer = 0;
$('path-text').addEventListener('input', () => {
  syncPathOps();
  clearTimeout(pathTimer);
  pathTimer = setTimeout(() => { void flushPath(); }, 220);
});
$('path-text').addEventListener('change', () => {
  clearTimeout(pathTimer);
  void flushPath();
});
$('path-text').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  clearTimeout(pathTimer);
  void (async () => { await flushPath(); await post('next'); })();
});

$('path-dirs').addEventListener('change', syncPathEnter);
$('path-dirs').addEventListener('dblclick', enterDir);
$('path-enter').addEventListener('click', enterDir);
$('path-next').addEventListener('click', () => { void (async () => { await flushPath(); await post('next'); })(); });

/**
 * 「打开」：在系统的文件管理器里打开这个目录。
 *
 * ★ 路径**在服务端**解析并 spawn——浏览器碰不到本地磁盘，这是这个按钮
 *   唯一可能的落点。前端只把框里那几个字原样递上去，`~` 展开与相对路径补全
 *   都由服务端那条唯一的路径解析做（和「进子目录」用的是同一套）。
 *
 * ★ 发的是框里**此刻**的字，不是视图模型里那份：用户可能刚敲完就点了。
 *   这里不必像「下一步」那样先 `flushPath()`——那边要的是**状态**（后面的
 *   步骤都读它），这边只要一个值，带上就够了。
 */
$('path-open').addEventListener('click', () => {
  void post('open-path', { value: $('path-text').value });
});

/** 「复制」按钮上那句反馈要自己消失的计时器。 */
let copyTimer = 0;

/**
 * 「复制」：把框里的路径放进剪贴板。
 *
 * ★ 复制的是**字面**（用户看到什么就得到什么），不是服务端解析后的绝对路径：
 *   这个按钮和上面的输入框是一对，"我写的东西我自己拿走"，没有第二种解释。
 */
async function copyPath() {
  const text = $('path-text').value;
  if (text.trim() === '') return;
  let ok = false;
  try {
    // ★ `navigator.clipboard` 只在**安全上下文**里有。回环地址算安全上下文，
    //   但它仍是"可能没有"的——所以有兜底，而不是一个 `?.` 了事。
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = legacyCopy(text);
  }
  // ★ 成不成都只在按钮上闪一下：失败时再弹一句红字比"没反应"更吵，
  //   而那时用户下一步本来就是手动选中那行字。
  setText('path-copy', ok ? '已复制' : '复制失败');
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => setText('path-copy', '复制'), 1200);
}

/**
 * `navigator.clipboard` 用不了时的兜底：造一个看不见的 `<textarea>` 选中再复制。
 *
 * @param {string} text
 * @returns {boolean}
 */
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.className = 'offscreen';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

$('path-copy').addEventListener('click', () => { void copyPath(); });

// ── 第 2 步 ──
//
// ★★ 三个动作，三种语义（判据全在 reducer 里，这里只发）：
//    · 选身份  → `select-token`：地址跟着走，**不换步**（换步才是联网那一下）；
//    · 选/敲地址 → `set-base-url`：地址若属于另一个身份，选中项跟着切过去；
//    · 「下一步」→ `confirm-token`：进第 3 步并拉模型清单。
$('token-pick').addEventListener('change', () => {
  const sel = $('token-pick');
  if (sel.value === '') return;
  void post('select-token', { index: Number(sel.value) });
});

$('token-url').addEventListener('change', () => {
  const sel = $('token-url');
  if (sel.value === CUSTOM_URL) {
    // ★ 只翻出一格输入框，**不发请求**：用户还没敲字，此刻提交上去
    //   只会把当前地址原样写回一遍（`urlEdited` 还会被误标成"改过"）。
    urlCustom = true;
    const box = $('token-url-custom-box');
    box.hidden = false;
    const text = $('token-url-custom');
    text.value = view === null || view.wizard === null ? '' : view.wizard.token.baseUrl;
    text.focus();
    return;
  }
  urlCustom = false;
  void post('set-base-url', { value: sel.value });
});

$('token-url-custom').addEventListener('change', () => {
  void post('set-base-url', { value: $('token-url-custom').value });
});

/**
 * 「下一步」：先把手敲的那个地址冲上去，再进第 3 步。
 *
 * ★ 与路径框的 `flushPath()` 同一个理由：地址是边打边推吗？**不是**——
 *   它只在 `change`（失焦 / 回车）时推。所以这里必须自己先冲一下，
 *   否则"敲完地址直接点下一步"会带着旧地址过关。
 */
async function confirmTokenOp() {
  if (view === null || view.wizard === null) return;
  if (!$('token-url-custom-box').hidden) {
    const box = $('token-url-custom');
    if (box.value.trim() !== view.wizard.token.baseUrl) await post('set-base-url', { value: box.value });
  }
  await post('confirm-token');
}

$('token-next').addEventListener('click', () => { void confirmTokenOp(); });
$('token-url-custom').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  void confirmTokenOp();
});

$('token-new').addEventListener('click', () => { void post('new-token'); });
$('token-name').addEventListener('input', () => syncSaveButton(isBusy()));
$('token-secret').addEventListener('input', () => {
  const n = $('token-secret').value.length;
  setText('token-len', n === 0 ? '密钥只在这个框里，保存时走一次本机回环。' : `已填 ${n} 个字符。`);
});
/**
 * ★ 名字与密钥**一起**发，而且只在按「保存」时发一次。
 *
 * 密钥当然可以边打边推（回环、同一台机器、同一个进程——反正终点就是它），
 * 但那样它会在**每一次按键**上都过一次 HTTP。少过一次就少一处能留下它的地方，
 * 而这条路上一点代价都没有：`save-token` 本来就读服务端记着的那份。
 *
 * ★ 地址也在这一步带上：新建身份时用户可能已经从下拉里挑了一个（那次
 *   `set-base-url` 已经发过了），也可能刚在「自定义」里敲完还没失焦。
 */
$('token-save').addEventListener('click', () => {
  void (async () => {
    await post('set-token-name', { value: $('token-name').value });
    await post('set-secret', { value: $('token-secret').value });
    if (!$('token-url-custom-box').hidden) {
      await post('set-base-url', { value: $('token-url-custom').value });
    }
    await post('save-token');
  })();
});

// ── 第 3 步 ──
$('models-retry').addEventListener('click', () => { void post('retry'); });

$('models-list').addEventListener('change', (/** @type {any} */ e) => {
  const box = e.target;
  if (box instanceof HTMLInputElement && box.type === 'checkbox' && box.dataset.id !== undefined) {
    void post('toggle-model', { id: box.dataset.id });
  }
});

$('models-picked').addEventListener('click', (/** @type {any} */ e) => {
  const b = e.target.closest('button');
  if (b === null || b.dataset.dir === undefined) return;
  void post('move-model', { id: b.dataset.id, dir: Number(b.dataset.dir) });
});

/**
 * 手敲一个 id。
 *
 * ⚠️ 这里**故意不接** `skip`（「跳过」）：`ui/app.js` 里那个 op 会**清空勾选**
 *   再跳到第 4 步。在终端上那是个明确的按键，在这个页面上却会变成
 *   "我勾了五个，点一下全没了"——一个界面不该把同一句话说得更狠。
 *   要一个都不选，把勾去掉就行。
 */
function addManual() {
  const el = $('model-manual');
  const v = el.value.trim();
  if (v === '') return;
  void post('manual-model', { value: v }).then(() => { el.value = ''; });
}
$('model-add').addEventListener('click', addManual);
$('model-manual').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addManual();
});

/**
 * 第 3 步的出口。
 *
 * ★ `next` 只是**回放一个 `Enter`**——与终端上按的那一下是同一件事，所以
 *   "第 3 步回车去哪"依然只有 reducer 一处定义（有模型就进第 4 步，
 *   `wizard.edit` 那条短路则直接写入）。
 */
$('models-next').addEventListener('click', () => { void post('next'); });

// ── 第 4 步 / 改模型那条短路 ──
$('apply-go').addEventListener('click', () => { void (async () => { await flushPath(); await post('apply'); })(); });
$('edit-apply').addEventListener('click', () => { void post('apply'); });

// ── 状态管理对话框 ──
$('status-add').addEventListener('click', () => {
  if (statusDraft === null) return;
  // ★ 新行的 id 留空——**服务端分配**（让浏览器生成主键就是把唯一性交给
  //   一个没有全局视野的地方）。
  statusDraft.push({ id: '', label: '', color: 'slate' });
  paintStatusDialog();
});

$('status-edit').addEventListener('input', (/** @type {any} */ e) => {
  const li = e.target.closest('li[data-i]');
  if (li === null || statusDraft === null) return;
  if (!e.target.classList.contains('srow-label')) return;
  statusDraft[Number(li.dataset.i)].label = e.target.value;
});

$('status-edit').addEventListener('change', (/** @type {any} */ e) => {
  const li = e.target.closest('li[data-i]');
  if (li === null || statusDraft === null) return;
  if (!e.target.classList.contains('srow-color')) return;
  const i = Number(li.dataset.i);
  statusDraft[i].color = e.target.value;
  // ★ 色点跟着下拉立即变——不然要等一次「保存」才知道自己选了什么颜色。
  const dot = li.querySelector('.swatch');
  if (dot !== null) dot.dataset.color = e.target.value;
});

$('status-save').addEventListener('click', () => { void saveStatuses(); });
$('status-cancel').addEventListener('click', closeStatusDialog);

// ★ Esc 关掉对话框时，那份草稿也得丢掉（否则下次打开会看见上次没保存的改动）。
$('status-dialog').addEventListener('close', () => {
  statusDraft = null;
  statusError = '';
});

// ── 模型优先级对话框 ──
$('pr-add').addEventListener('click', addPriority);

// ★ 回车 = 加入（与第 3 步那个「手敲一个模型 id」一致）。不 `preventDefault()`
//   的话，在表单里回车会触发默认提交；这里虽然没有 `<form>`，但一旦将来包进
//   `<form>`，这个习惯能救一次。
$('pr-new').addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  addPriority();
});

$('pr-save').addEventListener('click', () => { void savePriority(); });
$('pr-cancel').addEventListener('click', closePriorityDialog);

$('priority-dialog').addEventListener('close', () => {
  priorityDraft = null;
  priorityName = '';
  priorityError = '';
});

// ── 添加 token 对话框 ──
$('ad-save').addEventListener('click', () => { void saveAddToken(); });
$('ad-cancel').addEventListener('click', closeAddDialog);

// ★ Esc 关掉时也复位（与优先级对话框同一条：别让下次打开看见上次的错误）。
$('add-dialog').addEventListener('close', () => {
  addOpen = false;
  addError = '';
});

// ── 轮询与「切回前台立即刷新」 ──
setInterval(() => { void refresh(); }, POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void refresh();
});

// ── 走起 ──
void boot();
