// @ts-check
/**
 * ★★ 本地网页控制台的服务端（「面板 · Web 控制台」）。
 *
 * 起一个**只绑回环**的 HTTP 服务，把 `ops.view()` / `ops.apply()` 暴露成两个
 * JSON 端点，外加几个静态资产。浏览器里那套表单全是**原生控件**——服务端只管
 * 把状态送出去、把动作收回来。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么住在 `platform/`
 *
 * 监听端口、读 socket、装 SIGINT 全是**副作用**，和 spawn、网络请求同类（§4.2）。
 * `cli/` 那边只拿到 `{url, port, close, closed}`，一个 `process.*` 都不碰——
 * 于是「`cli/` 里唯一碰 stdio 的地方是 `runPlain()`」那句话继续成立。
 *
 * ## ★★ 威胁模型：要防的是**浏览器**，不是网络
 *
 * 服务只绑 `127.0.0.1`，外面进不来。真正的问题是：**你此刻开着的任何一个网页**
 * 都能向 `http://127.0.0.1:<任意端口>/…` 发请求。它读不到响应（我们从不发 CORS
 * 头），但它能**发**。
 *
 * | 对手 | 它能做什么 | 靠哪条挡 |
 * |---|---|---|
 * | 同机其它进程 | 直接连端口 | 路径口令（唯一入口） |
 * | 任意网页 | 简单请求 / CSRF | Origin 校验 + 口令 |
 * | 任意网页 | DNS rebinding（把自己的域名解析到 `127.0.0.1`） | Host 白名单 |
 * | 页面里的 XSS | 把状态外带出去 | CSP `default-src 'none'` |
 * | 磁盘缓存 | 把口令与路径留下 | 全部 `no-store` |
 *
 * 一句话：**口令是主防线，其余每一条都是纵深**。所以每一条都配了一个测试，
 * 删掉任意一条都应该有测试变红。
 *
 * ## ★ 逐字一致：这个文件与姊妹项目的那份**逐字相同**
 *
 * 所以这里**不许**出现：工具名、环境变量名、`CxtError`/`CmtError`、契约节号、
 * 以及任何写死到 stdout 的输出（`onLog` 是**注入**的）。见 §4.1。
 *
 * ## ★ `localhost` 与 `127.0.0.1`——两个方向都会错
 *
 * **发**出去的 URL 必须写 `127.0.0.1`：在「`localhost` 先解析到 `::1`」的机器上，
 * 一个绑 `127.0.0.1` 的服务会拒掉那条连接，而 URL 看上去完全正常。
 * **收**进来的 `Host` 必须两种拼法都认——用户会手敲。
 *
 * ## ★ 为什么返回四个字段而不是三个
 *
 * 调用方（`ui-web.js`）**必须能等到它自己关**——空闲退出和 SIGINT 都发生在这个
 * 文件里，调用方等不到就等于 CLI 立刻退出、服务器跟着死。所以除了
 * `{url, port, close}` 还有一个 `closed`（一个 Promise）。`close()` 是「我来关」，
 * `closed` 是「它关了」——两件事。
 * ─────────────────────────────────────────────────────────────
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import nodeHttp from 'node:http';

/**
 * 请求体上限：64 KiB。
 *
 * ★ 这个数不是「够用」，是「**任何比它大的东西都不可能是我们的前端发出来的**」——
 *   面板上能提交的最大的东西是一段路径，离 64 KiB 差三个数量级。
 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 排空上限：超过它的请求体不再读，直接掐连接（见 `readBody()`）。 */
const DRAIN_CAP = MAX_BODY_BYTES * 8;

/**
 * 每个响应都带这四个头。**一个都不能少**，理由逐条在下面。
 *
 * `default-src 'none'` 是这份 CSP 的承重墙：它让页面**发不出任何**外部请求，
 * 于是"XSS 把状态外带出去"这条路的终点被堵死。剩下的都是给这个页面开的口子，
 * 每一项都窄到只有一个来源。
 *
 * ★ 由此推出一条前端纪律：`index.html` **不许**有内联 `<script>` / `<style>` /
 *   `on*=` —— 它们会被 `script-src 'self'` / `style-src 'self'` 直接毙掉，
 *   而毙掉的表现是**页面白屏**，不是报错。
 */
const BASE_HEADERS = {
  'content-security-policy': [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; '),
  // MIME 混淆：没有它，浏览器会"猜"类型，一个 .css 可能被当脚本执行
  'x-content-type-options': 'nosniff',
  // ★ 口令就在 URL 里。默认的 referrer 策略会把它带给任何被访问的外部站点，
  //   而 CSP 恰好让这个页面访问不了任何外部站点——两道一起上才叫关死。
  'referrer-policy': 'no-referrer',
  // ★ 连静态资产也 no-store：URL 里含口令，让它进磁盘缓存等于把口令留在盘上。
  //   代价是刷新时多拉三个小文件，而这个页面一共就三个。
  'cache-control': 'no-store',
};

/** 绑定的字面量。★ 绝不 `0.0.0.0`、绝不 `::`——那是"局域网可达"，不是"本机"。 */
const LOOPBACK = { port: 0, host: '127.0.0.1' };

/**
 * 起服务。**只绑 `127.0.0.1` 的随机端口**，路径第一段是随机口令。
 *
 * @param {object} input
 * @param {{ view: () => any | Promise<any>, apply: (body: any) => any | Promise<any> }} input.ops
 *   `view()` 回一个视图模型（`GET …/api/state`）；`apply(body)` 收一个已经
 *   `JSON.parse` 过的动作对象，回 `{ view, done? }`（`POST …/api/op`）。
 *   ★ `done: true` = 「回完这一条就关」——这是工具侧对服务器的**全部**控制词表，
 *     一个布尔。用不着更多。
 * @param {Map<string, { type?: string, body: string | Buffer }> | Record<string, { type?: string, body: string | Buffer }>} input.assets
 *   **精确路径 → 内容**。没有 fs、没有路径拼接 ⇒ 路径穿越**结构上不可能**。
 * @param {string} [input.index] 首页在 `assets` 里的键，默认 `'/'`
 * @param {number} [input.idleMs] 空闲多久自己关；`<= 0` 表示不关。默认 30 分钟
 * @param {(entry: { method: string, path: string, status: number, ms: number }) => void} [input.onLog]
 *   **注入**的日志口。★ 只有这四个字段，**永远不含请求体**（里面是明文密钥）；
 *   `path` 已经剥掉口令（口令少出现一次就少一处泄漏面）。
 * @param {() => number} [input._now] 测试注入
 * @param {() => string} [input._random] 测试注入（生成口令）
 * @param {(server: import('node:http').Server, opts: { port: number, host: string }) => Promise<void>} [input._listen]
 *   测试注入。★ 注入它 = **接管整个监听**，包括真的 bind——想同时观察参数又想
 *   真起服务的话，注入版自己调 `server.listen()`（测试里就是这么写的）。
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>, closed: Promise<void> }>}
 */
export async function serveWeb(input) {
  const ops = input.ops;
  if (!ops || typeof ops.view !== 'function' || typeof ops.apply !== 'function') {
    throw new Error('serveWeb 需要 ops.view() 与 ops.apply()');
  }

  const onLog = typeof input.onLog === 'function' ? input.onLog : null;
  const now = input._now ?? Date.now;
  const random = input._random ?? (() => randomBytes(16).toString('hex'));
  const idleMs = input.idleMs ?? 30 * 60_000;
  const listen = input._listen ?? realListen;

  const assets = normalizeAssets(input.assets);
  const indexKey = input.index ?? '/';
  if (!assets.has(indexKey)) throw new Error(`assets 里没有 ${indexKey}——首页得有人给`);

  const token = random();
  // ★ 口令必须是 URL 里安全的一段：它要是带个 `/`，路由的第一段就不再是口令了。
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('口令只能是 [A-Za-z0-9_-] 且不能为空');
  }

  // ── S1 绑定 ────────────────────────────────────────────────
  const server = nodeHttp.createServer((req, res) => void handle(req, res));
  // ★ 内置超时默认 **300 秒**——对一个本机控制台太长了：一条卡住的连接能把它
  //   按在地上五分钟，而这期间用户什么都做不了。请求都很小，10/30 秒绰绰有余。
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;

  await listen(server, { ...LOOPBACK });
  const addr = server.address();
  const port = addr !== null && typeof addr === 'object' ? addr.port : 0;

  // ★ 发给用户的那一行**只写 `127.0.0.1`**（见文件头）。尾斜杠不能省：
  //   前端所有请求都是相对 URL，少了它，`fetch('api/state')` 会解析到上一层去。
  const url = `http://127.0.0.1:${port}/${token}/`;

  /** @type {Promise<void> | null} */
  let closing = null;
  /** @type {NodeJS.Timeout | null} */
  let idleTimer = null;

  // ★ `closed` 与 `close()` 是两件事：`close()` 是「我来关」，`closed` 是「它关了」。
  //   调用方要的是后者——空闲退出和 SIGINT 都不是它发起的。
  /** @type {() => void} */
  let resolveClosed = () => {};
  const closed = new Promise((resolve) => {
    resolveClosed = () => resolve();
  });

  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();

  /**
   * ★ 空闲计时。每来一个请求就重置。
   *
   * `unref()`：这个定时器**不该成为"进程还活着"的理由**。它的职责是关掉服务，
   * 不是吊住进程。
   */
  function bumpIdle() {
    if (!(idleMs > 0)) return;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close(), idleMs);
    idleTimer.unref?.();
  }

  // ── S1 SIGINT ──────────────────────────────────────────────
  // ★ 装在**这里**而不是 `cli/`：这样 `ui-web.js` 一个 `process.*` 都不碰，
  //   「`cli/` 里唯一刻意的例外是 `runPlain()`」那句话继续成立（§4.2）。
  const onSigint = () => void close();
  process.on('SIGINT', onSigint);

  /**
   * 关掉服务。**幂等**——SIGINT、空闲、页面点了「退出」三条路都会走到这儿。
   *
   * @returns {Promise<void>}
   */
  function close() {
    if (closing !== null) return closing;
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    // ★ 不摘掉的话，`ui-web.js` 跑完还挂着一个 SIGINT 监听——
    //   下一个用 Ctrl+C 的人会发现它没反应。
    process.removeListener('SIGINT', onSigint);

    closing = new Promise((resolve) => {
      // ★ `server.close()` 只是"不再收新连接"：**已经握着的 keep-alive 连接**
      //   会让它的回调一直不来。浏览器就是 keep-alive 的，所以这里三道一起上：
      //   ① 先关空闲的（刚回完响应的那条正好是）；
      //   ② 给还在传的留 300 毫秒；
      //   ③ 到点一锤子，并且无论如何都 resolve——调用方在等这个。
      server.close(() => resolve());
      server.closeIdleConnections?.();
      const hammer = setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 300);
      hammer.unref?.();
    });
    void closing.then(() => resolveClosed());
    return closing;
  }

  bumpIdle();

  // ── S3–S8 请求处理 ─────────────────────────────────────────

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const t0 = now();
    const rawUrl = req.url ?? '';
    const method = (req.method ?? 'GET').toUpperCase();
    bumpIdle();

    let status = 500;
    try {
      status = await respond(req, res, method, rawUrl);
    } catch {
      // ★ 只有**我们自己的**代码会走到这儿（`ops.view`/`ops.apply` 抛错）。
      //   响应已经发出去一半的话就别再写了，那会把一个正常的响应接上半个错误页。
      if (!res.headersSent) {
        send(res, 500, { 'content-type': 'text/plain; charset=utf-8' }, '服务端出错');
        status = 500;
      } else {
        res.destroy();
      }
    }

    if (onLog !== null) {
      // ★ 日志炸了不许影响响应：用户要的是那个页面，不是日志。
      try {
        onLog({ method, path: pathForLog(rawUrl), status, ms: now() - t0 });
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} method
   * @param {string} rawUrl
   * @returns {Promise<number>}
   */
  async function respond(req, res, method, rawUrl) {
    const path = stripQuery(rawUrl);
    const segs = path.split('/');

    // ── S5 口令：**先验它，再谈别的** ──
    // ★ 顺序是刻意的：口令不对时一律 404，不给「这个路径存在吗」的口子。
    //   对手拿不到口令，于是他连"哪些路径存在"都问不出来。
    if (segs[0] !== '' || typeof segs[1] !== 'string' || !tokenMatches(segs[1], token)) {
      return deny(res, 404);
    }

    // ── S4 Host：每个请求都查，**含资产** ──
    // ★ 挡的是 DNS rebinding：对手把自己的域名解析到 127.0.0.1，于是同源策略
    //   以为"这是我们自己的域"，而 `Host` 出卖了他。
    if (!hostAllowed(req.headers.host, port)) return deny(res, 403);

    // ── S4 Origin ──
    // ★ POST 一律**必须自报家门**：缺失即拒。浏览器在 POST 上总会带 `Origin`，
    //   而"不带 Origin 的 POST"只可能是本机其它程序——它本来就有口令之外的
    //   一百种办法，但没必要给它这条。
    // ★ GET/HEAD 上只拒**明确的外人**：合法导航根本不会带 `Origin`，带了又不
    //   是自己人的，那就是跨源页面在发简单请求（读不到响应，但没必要让它进来）。
    const origin = req.headers.origin;
    if (method === 'POST') {
      if (typeof origin !== 'string' || !originAllowed(origin, port)) return deny(res, 403);
    } else if (origin !== undefined && (typeof origin !== 'string' || !originAllowed(origin, port))) {
      return deny(res, 403);
    }

    const rest = segs.slice(2).join('/');

    // `/<口令>`（没有尾斜杠）→ 301 到 `/<口令>/`。
    // ★ 存在的唯一理由是**相对 URL**：前端写的是 `fetch('api/state')`，少了尾斜杠
    //   它会解析到 `/<口令>/api/state` 的上一层去。口令每次运行都换，所以这条
    //   301 不会被缓存命中——但仍然是 301（HTTP 语义上"这个资源就该带斜杠"）。
    if (segs.length === 2) {
      if (method !== 'GET' && method !== 'HEAD') return deny(res, 405, 'GET, HEAD');
      return redirect(res, `${path}/`);
    }

    if (rest === 'api/state') {
      if (method !== 'GET' && method !== 'HEAD') return deny(res, 405, 'GET, HEAD');
      return sendJson(res, 200, await ops.view());
    }

    if (rest === 'api/op') {
      if (method !== 'POST') return deny(res, 405, 'POST');
      return await applyOp(req, res);
    }

    // ── S5 资产：**精确路径查表** ──
    // ★ 没有 fs、没有路径拼接。`/…/../../etc/passwd` 查不到就是查不到——
    //   穿越在这里不是"被挡住了"，是**结构上不存在**。
    if (method !== 'GET' && method !== 'HEAD') return deny(res, 405, 'GET, HEAD');
    const asset = assets.get(rest === '' ? indexKey : `/${rest}`);
    if (asset === undefined) return deny(res, 404);
    return send(res, 200, { 'content-type': asset.type }, asset.body);
  }

  /**
   * `POST …/api/op`。读体 → 解析 → **串行**交给 `ops.apply()` → 回视图。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @returns {Promise<number>}
   */
  async function applyOp(req, res) {
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      return body.reason === 'too-large'
        ? deny(res, 413, null, '请求体太大')
        : deny(res, 400, null, '读请求体失败');
    }

    /** @type {any} */
    let parsed;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return deny(res, 400, null, '请求体不是 JSON');
    }

    // ── ★ 并发串行化 ──
    // ★ 没有它，两个在飞的 POST 会交错着进 `ops.apply`，而它背后是**唯一一份**
    //   reducer 状态。前端"点得快"和"点了两下"都会撞上这条路。
    const result = await enqueue(() => ops.apply(parsed));

    const view = result !== null && typeof result === 'object' ? result.view : result;
    const done = result !== null && typeof result === 'object' && result.done === true;

    sendJson(res, 200, view);
    // ★ 「回完这一条就关」：等响应**真的写完**再关，不然那条 200 会跟着连接一起没。
    if (done) res.once('finish', () => void close());
    return 200;
  }

  /**
   * 单槽 promise 链。前一个失败了也得接着跑下一个，而链子自己**不许**被拒绝拖死。
   *
   * @template T
   * @param {() => T | Promise<T>} fn
   * @returns {Promise<T>}
   */
  function enqueue(fn) {
    const p = tail.then(fn, fn);
    tail = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  return { url, port, close, closed };
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * 资产表归一化：`{type, body}` → `{type, body: Buffer}`，并把 key 钉成 `/…`。
 *
 * 两种形状都收（Map / 普通对象）纯粹是为了调用方好写——**不改变任何行为**。
 *
 * @param {Map<string, { type?: string, body: string | Buffer }> | Record<string, { type?: string, body: string | Buffer }>} [raw]
 * @returns {Map<string, { type: string, body: Buffer }>}
 */
function normalizeAssets(raw) {
  /** @type {Map<string, { type: string, body: Buffer }>} */
  const out = new Map();
  /** @type {[string, { type?: string, body: string | Buffer }][]} */
  const entries = raw instanceof Map ? [...raw] : Object.entries(raw ?? {});
  for (const [key, v] of entries) {
    if (!key.startsWith('/')) throw new Error(`资产路径必须以 / 开头：${key}`);
    if (v === null || typeof v !== 'object') throw new Error(`资产 ${key} 得是 { type, body }`);
    const body = Buffer.isBuffer(v.body) ? v.body : Buffer.from(String(v.body ?? ''), 'utf8');
    out.set(key, { type: withCharset(v.type ?? 'application/octet-stream'), body });
  }
  return out;
}

/**
 * 把 `charset=utf-8` 补齐。
 *
 * ★ 这条不是顺手：`Content-Type` 少了 charset，浏览器对 `text/html` 会去猜编码，
 *   而我们的页面里有中文——猜错就是满屏乱码，且**只在别人的机器上出现**。
 *
 * @param {string} type
 * @returns {string}
 */
function withCharset(type) {
  if (/charset=/i.test(type)) return type;
  if (/^(text\/|application\/(json|javascript|xml)\b)/i.test(type)) return `${type}; charset=utf-8`;
  return type;
}

/**
 * 去掉 `?query`。
 * @param {string} rawUrl
 * @returns {string}
 */
function stripQuery(rawUrl) {
  const q = rawUrl.indexOf('?');
  return q === -1 ? rawUrl : rawUrl.slice(0, q);
}

/**
 * 日志里那条路径：**剥掉口令**（第一段）。
 *
 * ★ 口令本来就该只出现在"发给用户的那一行 URL"里。日志会进终端回滚、进日志文件，
 *   每多一处就多一处泄漏面——而它对排查问题没有任何用处。
 *
 * @param {string} rawUrl
 * @returns {string}
 */
function pathForLog(rawUrl) {
  const segs = stripQuery(rawUrl).split('/');
  if (segs[0] !== '') return '/';
  return `/${segs.slice(2).join('/')}`;
}

/**
 * ★★ 口令比对。**等长时用 `timingSafeEqual`**。
 *
 * 长度不等直接 false：`timingSafeEqual` 在长度不等时会**抛错**，而且长度本身
 * 从 URL 就能看出来——这里不假装能藏住它。真正的秘密是内容，不是长度。
 *
 * @param {string} got
 * @param {string} want
 * @returns {boolean}
 */
function tokenMatches(got, want) {
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(want, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `Host` 白名单。★ **两种拼法都收**——用户会手敲 `localhost`，而浏览器给的是
 * 地址栏里那一份。大小写不敏感（HTTP 的 host 本来就大小写不敏感）。
 *
 * @param {string | undefined} host
 * @param {number} port
 * @returns {boolean}
 */
function hostAllowed(host, port) {
  if (typeof host !== 'string') return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/**
 * `Origin` 是不是自己人。**空、`null`、别的源，一律不是。**
 *
 * @param {string} origin
 * @param {number} port
 * @returns {boolean}
 */
function originAllowed(origin, port) {
  const o = origin.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

/**
 * 读请求体，**边读边判**。
 *
 * ★ 不信 `Content-Length`：chunked 编码可以没有它，而有了它也不代表真的是那个数。
 *   这里只数**实际收到的字节**。
 *
 * ★ 超限之后**立刻把已经收下的扔掉**——这条控制的全部意义就是内存，不是带宽。
 *   然后继续读（丢弃），好让客户端把请求写完、能读到我们的 413；否则连接一断，
 *   客户端看到的会是 `socket hang up`，而不是"太大了"。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<{ ok: true, text: string } | { ok: false, reason: 'too-large' | 'error' }>}
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    /** @param {{ ok: true, text: string } | { ok: false, reason: 'too-large' | 'error' }} r */
    const settle = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        if (!settled) {
          chunks.length = 0;
          settle({ ok: false, reason: 'too-large' });
        } else if (size > DRAIN_CAP) {
          // ★ 排空也有上限：不然一条永远不挂断的连接能让我们**一直**读下去。
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ ok: false, reason: 'error' }));
  });
}

/**
 * 写响应。**所有响应都从这里出去**——`Content-Length` 与那四个公共头只写一次。
 *
 * HEAD 不用特判：Node 对 HEAD 请求本来就不写 body，而 `Content-Length` 是我们
 * 显式给的，照样发出去（这正是 HEAD 该有的样子）。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {string | Buffer} [body]
 * @returns {number} 就是 `status`，方便调用方 `return send(...)`
 */
function send(res, status, headers, body = '') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(status, {
    ...BASE_HEADERS,
    // ★ 默认 `text/plain`：**每个响应都得有 content-type**，包括空体的 403/404。
    //   空体不缺这一个头，缺的是"有个分支忘了设"——而那一条分支正是没人测的那条。
    'content-type': 'text/plain; charset=utf-8',
    ...headers,
    'content-length': String(buf.length),
  });
  res.end(buf);
  return status;
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} value
 * @returns {number}
 */
function sendJson(res, status, value) {
  return send(res, status, { 'content-type': 'application/json; charset=utf-8' }, JSON.stringify(value ?? null));
}

/**
 * 拒绝。★ **默认空体**——403/404/405 什么都不说。
 *
 * 理由：能走到这几条的都是"口令对但别的不对"或者"口令就不对"，两种情况下
 * 我们都没有理由再告诉对方一点什么。`allow`（405 用）和 `text` 是两个例外：
 * 前者是 HTTP 规范要求的，后者只出现在**已经通过口令之后**（400/413）。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string | null} [allow]
 * @param {string} [text]
 * @returns {number}
 */
function deny(res, status, allow = null, text = '') {
  /** @type {Record<string, string>} */
  const headers = {};
  if (allow !== null) headers.allow = allow;
  return send(res, status, headers, text);
}

/**
 * @param {import('node:http').ServerResponse} res
 * @param {string} location
 * @returns {number}
 */
function redirect(res, location) {
  return send(res, 301, { location });
}

/**
 * 真的 listen。
 *
 * ★ `host` 是 `'127.0.0.1'` 这个**字面量**（见 `LOOPBACK`）——不是 `'localhost'`。
 *   后者由系统去解析，在"先解析到 `::1`"的机器上会绑到一个 IPv6 地址上，于是
 *   `127.0.0.1` 那条路根本连不上，而 `server.address()` 会显示 `::1`。
 *
 * @param {import('node:http').Server} server
 * @param {{ port: number, host: string }} opts
 * @returns {Promise<void>}
 */
function realListen(server, opts) {
  return new Promise((resolve, reject) => {
    const onError = (/** @type {Error} */ err) => {
      server.removeListener('listening', onOk);
      reject(new Error(`控制台起不来：${err.message}`));
    };
    const onOk = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(opts.port, opts.host);
  });
}
