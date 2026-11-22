// @ts-check
/**
 * `serveWeb()` —— 本地网页控制台的服务端。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这个文件为什么这么大
 *
 * 因为它守的是**唯一一处真正对外的面**。服务只绑 `127.0.0.1`，所以网络层进不来；
 * 要防的是**浏览器**——你此刻开着的任何一个网页都能向本机任意端口发请求。
 * 于是下面每一条控制都配一个能变红的测试：**删掉控制，就有测试红**。
 *
 * | # | 控制 | 在哪 |
 * |---|---|---|
 * | 1 | 只绑回环 | 「只绑回环」那组 |
 * | 2 | 随机端口 | 同上 |
 * | 3 | 路径口令 | 「路径口令」那组 |
 * | 4 | Host 白名单 | 「Host 白名单」那组 |
 * | 5 | Origin 校验 | 「Origin 校验」那组 |
 * | 6 | 永不发 CORS | 「永不发 CORS」那组 |
 * | 7 | CSP | 「响应头」那组 |
 * | 8 | charset + nosniff | 同上 |
 * | 9 | body 上限 | 「请求体上限」那组 |
 * | 10 | 方法白名单 | 「方法白名单」那组 |
 * | 11 | API 不缓存 | 「响应头」那组 |
 * | 12 | 空闲退出 | 「退出路径」那组 |
 * | 13 | SIGINT | 同上 |
 * | 14 | 不记 body | 「日志」那组 |
 *
 * ## 两个夹具上的讲究
 *
 * ★ 头相关的控制一律走**裸 `http.request`**：`fetch` 不许你改 `Host`，也不许你
 *   发重复头——而那正是这几条控制要验的东西。反过来，走正常路子的用例就用
 *   `fetch`（它更像真实浏览器）。
 *
 * ★ `fetch` **不会**自己带 `Origin`（浏览器会）。所以本文件里 POST 一律显式带上
 *   `Origin`——这不是绕过校验，这就是浏览器会发的那一份。
 * ─────────────────────────────────────────────────────────────
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';

import { MAX_BODY_BYTES, serveWeb } from '../src/platform/serve-web.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/** 口令是注入的——固定的口令才能让每个用例都拿它拼 URL。 */
const TOKEN = 'T0KEN';

const ASSETS = new Map([
  ['/', { type: 'text/html', body: '<!doctype html><html><body>控制台</body></html>' }],
  ['/app.js', { type: 'application/javascript', body: 'console.log(1)' }],
  ['/style.css', { type: 'text/css', body: 'body{margin:0}' }],
]);

/**
 * @param {object} [opts]
 * @param {() => any} [opts.view]
 * @param {(body: any) => any} [opts.apply]
 */
function makeOps(opts = {}) {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    ops: {
      view: async () => (opts.view ? opts.view() : { screen: 'list', items: [] }),
      apply: async (/** @type {any} */ body) => {
        calls.push(body);
        return opts.apply ? await opts.apply(body) : { view: { ok: true } };
      },
    },
  };
}

/**
 * 起一个服务，**用完必须 `close()`**（不然 SIGINT 监听会累积到下一个用例）。
 *
 * @param {object} [opts]
 * @param {Parameters<typeof makeOps>[0]} [opts.opsOpts]
 * @param {Partial<Parameters<typeof serveWeb>[0]>} [opts.input]
 */
async function start(opts = {}) {
  const { ops, calls } = makeOps(opts.opsOpts);
  /** @type {any[]} */
  const logs = [];
  const srv = await serveWeb(
    /** @type {any} */ ({
      ops,
      assets: ASSETS,
      onLog: (/** @type {any} */ e) => logs.push(e),
      _random: () => TOKEN,
      ...opts.input,
    }),
  );
  return { srv, ops, calls, logs };
}

/**
 * 裸 `http.request`。**凡是验证请求头的用例都走这里**——`fetch` 不许改 `Host`。
 *
 * @param {number} port
 * @param {object} [req]
 * @param {string} [req.method]
 * @param {string} [req.path]
 * @param {Record<string, string>} [req.headers]
 * @param {string | Buffer | null} [req.body]
 * @param {boolean} [req.autoHost] `false` = **不发 Host 头**
 */
function raw(port, req = {}) {
  const { method = 'GET', path = '/', headers = {}, body = null, autoHost = true } = req;
  return new Promise((/** @type {(v: any) => void} */ resolve, /** @type {(e: any) => void} */ reject) => {
    const r = http.request(
      { host: '127.0.0.1', port, method, path, headers, setHost: autoHost },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8') });
        });
      },
    );
    r.on('error', reject);
    r.end(body ?? undefined);
  });
}

/** 一条请求该带的那两个头（自己人的 Host / Origin）。 */
const selfHeaders = (/** @type {number} */ port) => ({
  host: `127.0.0.1:${port}`,
  origin: `http://127.0.0.1:${port}`,
});

/**
 * 往端口上**原样写一段字节**，回全部响应文本。
 *
 * ★ 只有它能发出一条 HTTP/1.0、没有 `Host` 的请求——`http.request` 做不到
 *   （HTTP/1.1 下 Node 自己就把无 Host 的请求挡了，见「Host 白名单」那组）。
 *
 * @param {number} port
 * @param {string} request
 * @returns {Promise<string>}
 */
function rawSocket(port, request) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const sock = net.connect({ host: '127.0.0.1', port }, () => sock.write(request));
    sock.setEncoding('utf8');
    sock.on('data', (c) => {
      buf += c;
    });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
    sock.setTimeout(3000, () => {
      sock.destroy();
      resolve(buf);
    });
  });
}

/**
 * `POST …/api/op`，带 `Origin`（浏览器会带的那一份）。
 *
 * @param {{ url: string, port: number }} srv
 * @param {any} body
 * @param {Record<string, string>} [headers]
 */
function post(srv, body, headers = {}) {
  return fetch(`${srv.url}api/op`, {
    method: 'POST',
    headers: { ...selfHeaders(srv.port), 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * 注入版监听：**真的 bind**，只是可以换端口、并把收到的参数记下来。
 *
 * ★ 想验"传下去的到底是 `127.0.0.1` 还是 `localhost`"，只能在这一层看——
 *   真 bind 之后 `server.address()` 对这两种拼法可能给出同一个字符串。
 *
 * @param {number} port
 * @param {{ port: number, host: string }[]} seen
 */
function listenAt(port, seen) {
  return (/** @type {any} */ server, /** @type {any} */ opts) =>
    new Promise((/** @type {() => void} */ resolve, /** @type {(e: any) => void} */ reject) => {
      seen.push(opts);
      server.once('error', reject);
      server.listen(port, opts.host, () => resolve());
    });
}

/** 试着连一下某个 host:port，**只回答"连上了没有"**。 */
function tryConnect(/** @type {string} */ host, /** @type {number} */ port, ms = 3000) {
  return new Promise((/** @type {(v: boolean) => void} */ resolve) => {
    const req = http.request({ host, port, path: '/', method: 'GET', timeout: ms }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** 本机的一个非回环 IPv4，没有就返回 `null`。 */
function lanIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

// ═══════════ 控制 1 / 2：只绑回环、随机端口 ═══════════

describe('★★ serveWeb —— 只绑回环、随机端口', () => {
  test('★ 传给 listen 的是**端口 0** 和 `127.0.0.1` 这个字面量', async () => {
    /** @type {{ port: number, host: string }[]} */
    const seen = [];
    const srv = await serveWeb(/** @type {any} */ ({
      ops: makeOps().ops,
      assets: ASSETS,
      _random: () => TOKEN,
      _listen: listenAt(0, seen),
    }));
    try {
      assert.deepEqual(seen, [{ port: 0, host: '127.0.0.1' }], '★ 端口要 0（由系统挑），host 要字面量 127.0.0.1');
    } finally {
      await srv.close();
    }
  });

  test('★★ `::1` 上连不上——绑的是 IPv4 回环，不是"某个回环"', async () => {
    const { srv } = await start();
    try {
      // ★ 这条是控制 1 的另一半：`listen(0, 'localhost')` 在"先解析到 ::1"的机器上
      //   会绑到 IPv6 上，于是 127.0.0.1 那条路根本连不上。
      assert.equal(await tryConnect('::1', srv.port), false, '★ ::1 上有东西在听 = 绑得太宽了');
      assert.equal(await tryConnect('127.0.0.1', srv.port), true, '★ 127.0.0.1 上必须能连');
    } finally {
      await srv.close();
    }
  });

  test('★★ 局域网上连不上（"只绑回环"的全部意义）', async (t) => {
    const lan = lanIPv4();
    if (lan === null) {
      t.skip('这台机器没有非回环 IPv4');
      return;
    }
    const { srv } = await start();
    try {
      assert.equal(await tryConnect(lan, srv.port), false, `★ ${lan}:${srv.port} 连上了 = 同一网段的人能进控制台`);
    } finally {
      await srv.close();
    }
  });

  test('★ 端口是随机的：两个服务端口不同，且都能用', async () => {
    const a = await start();
    const b = await start();
    try {
      assert.notEqual(a.srv.port, b.srv.port);
      assert.ok(a.srv.port > 0 && b.srv.port > 0);
      assert.equal((await fetch(`${a.srv.url}api/state`)).status, 200);
      assert.equal((await fetch(`${b.srv.url}api/state`)).status, 200);
    } finally {
      await a.srv.close();
      await b.srv.close();
    }
  });

  test('★ 发出去的 URL 写 `127.0.0.1`，**不是** `localhost`', async () => {
    const { srv } = await start();
    try {
      // ★ 另一条路：在"localhost 先解析到 ::1"的机器上，`http://localhost:<port>/`
      //   会连到一个我们没绑的地址上——URL 看着完全正常，页面却打不开。
      assert.ok(srv.url.startsWith('http://127.0.0.1:'), `URL 是 ${srv.url}`);
      assert.ok(srv.url.endsWith(`/${TOKEN}/`), '★ 尾斜杠不能省：前端全是相对 URL');
      assert.equal((await fetch(srv.url)).status, 200);
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 控制 3：路径口令 ═══════════

describe('★★ serveWeb —— 路径口令（主防线）', () => {
  test('★★ 口令不对 → 404，**空体**（不给"这儿有东西"的暗示）', async () => {
    const { srv } = await start();
    try {
      const r = await raw(srv.port, { path: '/WRONG/api/state', headers: selfHeaders(srv.port) });
      assert.equal(r.status, 404);
      assert.equal(r.body, '');
      assert.equal(r.headers['content-length'], '0');
    } finally {
      await srv.close();
    }
  });

  test('★ 长度一样但内容不对 → 404（走的是 `timingSafeEqual` 那条路）', async () => {
    const { srv } = await start();
    try {
      const same = 'X'.repeat(TOKEN.length);
      assert.equal(same.length, TOKEN.length);
      assert.equal((await raw(srv.port, { path: `/${same}/api/state`, headers: selfHeaders(srv.port) })).status, 404);
    } finally {
      await srv.close();
    }
  });

  test('★ 口令对 → 200', async () => {
    const { srv } = await start();
    try {
      assert.equal((await fetch(`${srv.url}api/state`)).status, 200);
    } finally {
      await srv.close();
    }
  });

  test('★★ 没有口令时，连"这个路径存不存在"都问不出来', async () => {
    const { srv } = await start();
    try {
      const h = selfHeaders(srv.port);
      const a = await raw(srv.port, { path: '/WRONG/app.js', headers: h });
      const b = await raw(srv.port, { path: '/WRONG/nope.txt', headers: h });
      assert.equal(a.status, 404);
      assert.equal(b.status, 404);
      // ★ `date` 是**应答时刻**，不是内容——两次请求跨过整秒边界就会不同，
      //   拿它一起比等于给这条断言埋一个"一秒一次"的假失败。
      //   要比的是"对一个不知道口令的人，这两个路径看起来是否一样"。
      /** @param {any} r */
      const shape = (r) => ({ status: r.status, body: r.body, headers: { ...r.headers, date: '<时刻>' } });
      assert.deepEqual(shape(a), shape(b), '★ 存在的与不存在的必须**一模一样**——否则这就是个探测口');
    } finally {
      await srv.close();
    }
  });

  test('★ 口令只在第一段：`/<口令>/x/<口令>` 里后面那个不算数', async () => {
    const { srv } = await start();
    try {
      assert.equal((await raw(srv.port, { path: `/${TOKEN}/${TOKEN}`, headers: selfHeaders(srv.port) })).status, 404);
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 控制 4：Host 白名单（DNS rebinding） ═══════════

describe('★★ serveWeb —— Host 白名单', () => {
  test('★★ 别人的 Host → 403', async () => {
    const { srv } = await start();
    try {
      // 这就是 DNS rebinding 的形态：对手把 evil.example 解析到 127.0.0.1，
      // 于是同源策略以为"这是我们自己的域"——而 Host 出卖了他。
      const r = await raw(srv.port, { path: `/${TOKEN}/api/state`, headers: { host: 'evil.example' } });
      assert.equal(r.status, 403);
      assert.equal(r.body, '');
    } finally {
      await srv.close();
    }
  });

  test('★ 两种拼法都收（用户会手敲 `localhost`）', async () => {
    const { srv } = await start();
    try {
      for (const host of [`127.0.0.1:${srv.port}`, `localhost:${srv.port}`, `LOCALHOST:${srv.port}`]) {
        const r = await raw(srv.port, { path: `/${TOKEN}/api/state`, headers: { host } });
        assert.equal(r.status, 200, `Host: ${host} 被拒了`);
      }
    } finally {
      await srv.close();
    }
  });

  test('★ 端口不对的 Host → 403（只有这一个端口是自己人）', async () => {
    const { srv } = await start();
    try {
      const r = await raw(srv.port, { path: `/${TOKEN}/api/state`, headers: { host: '127.0.0.1:1' } });
      assert.equal(r.status, 403);
    } finally {
      await srv.close();
    }
  });

  test('★ 没有 Host 头 → 403（HTTP/1.1 上 Node 自己先挡了一道，这条兜 HTTP/1.0）', async () => {
    const { srv } = await start();
    try {
      // ★ HTTP/1.1 少了 Host，Node 的服务器在**我们之前**就回 400 了——这是白送的
      //   一道前置防线，所以这里断言的不是 403 而是"根本没进来"。
      const http11 = await raw(srv.port, { path: `/${TOKEN}/api/state`, autoHost: false });
      assert.equal(http11.status, 400, '★ Node 不该放一条没有 Host 的 HTTP/1.1 请求进来');
      // ★ HTTP/1.0 不要求 Host，能一路走到我们这儿——`hostAllowed(undefined)` 就是给它兜的。
      const text = await rawSocket(srv.port, `GET /${TOKEN}/api/state HTTP/1.0\r\n\r\n`);
      assert.match(text, /^HTTP\/1\.1 403 /, `HTTP/1.0 那条没被我们挡住：${text.split('\r\n')[0]}`);
    } finally {
      await srv.close();
    }
  });

  test('★★ 资产也要查 Host——rebinding 不走 API，走的是页面本身', async () => {
    const { srv } = await start();
    try {
      const r = await raw(srv.port, { path: `/${TOKEN}/`, headers: { host: 'evil.example' } });
      assert.equal(r.status, 403);
      assert.equal(r.body, '', '★ 首页一个字都不许漏出去');
    } finally {
      await srv.close();
    }
  });

  test('★ Host 检查在口令**之后**（口令不对仍然是 404，不是 403）', async () => {
    const { srv } = await start();
    try {
      const r = await raw(srv.port, { path: '/WRONG/api/state', headers: { host: 'evil.example' } });
      assert.equal(r.status, 404, '★ 顺序反了的话，403 就成了"这个端口上有服务"的告示牌');
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 控制 5：Origin 校验（CSRF） ═══════════

describe('★★ serveWeb —— Origin 校验', () => {
  test('★★ POST **没有** Origin → 403（这就是本机其它程序与浏览器的分界线）', async () => {
    const { srv, calls } = await start();
    try {
      const r = await raw(srv.port, {
        method: 'POST',
        path: `/${TOKEN}/api/op`,
        headers: { host: `127.0.0.1:${srv.port}`, 'content-type': 'application/json' },
        body: '{"op":"quit"}',
      });
      assert.equal(r.status, 403);
      assert.deepEqual(calls, [], '★ 被拒的请求绝不许到达 ops.apply');
    } finally {
      await srv.close();
    }
  });

  test('★★ `Origin: null` → 403（沙箱 iframe / 本地文件就是它）', async () => {
    const { srv } = await start();
    try {
      assert.equal((await post(srv, { op: 'quit' }, { origin: 'null' })).status, 403);
    } finally {
      await srv.close();
    }
  });

  test('★★ 别人的源 → 403', async () => {
    const { srv } = await start();
    try {
      assert.equal((await post(srv, { op: 'quit' }, { origin: 'https://evil.example' })).status, 403);
      // ★ 端口对但主机名不对、主机名对但端口不对，都不算自己人
      assert.equal((await post(srv, { op: 'quit' }, { origin: 'http://127.0.0.1:1' })).status, 403);
      assert.equal((await post(srv, { op: 'quit' }, { origin: `https://127.0.0.1:${srv.port}` })).status, 403);
    } finally {
      await srv.close();
    }
  });

  test('★ 自己人的两种拼法都放行', async () => {
    const { srv } = await start();
    try {
      assert.equal((await post(srv, { op: 'a' }, { origin: `http://127.0.0.1:${srv.port}` })).status, 200);
      assert.equal((await post(srv, { op: 'b' }, { origin: `http://localhost:${srv.port}` })).status, 200);
    } finally {
      await srv.close();
    }
  });

  test('★ GET 上**不带** Origin 是正常的（导航本来就不带），带了别人的就拒', async () => {
    const { srv } = await start();
    try {
      assert.equal((await raw(srv.port, { path: `/${TOKEN}/api/state`, headers: selfHeaders(srv.port) })).status, 200);
      const foreign = await raw(srv.port, {
        path: `/${TOKEN}/api/state`,
        headers: { host: `127.0.0.1:${srv.port}`, origin: 'https://evil.example' },
      });
      assert.equal(foreign.status, 403);
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 控制 6：永不发 CORS ═══════════

describe('★★ serveWeb —— 永不发 CORS', () => {
  test('★★ 任何响应里都没有 `Access-Control-*`（跨源页面永远读不到响应）', async () => {
    const { srv } = await start();
    try {
      const h = selfHeaders(srv.port);
      /** @type {any[]} */
      const resps = [
        await raw(srv.port, { path: `/${TOKEN}/`, headers: h }),
        await raw(srv.port, { path: `/${TOKEN}/app.js`, headers: h }),
        await raw(srv.port, { path: `/${TOKEN}/api/state`, headers: h }),
        await raw(srv.port, { path: `/${TOKEN}/nope`, headers: h }),
        await raw(srv.port, { path: '/WRONG/', headers: h }),
        await raw(srv.port, { path: `/${TOKEN}/`, headers: { host: 'evil.example' } }),
        await raw(srv.port, { method: 'POST', path: `/${TOKEN}/api/op`, headers: h, body: '{}' }),
        await raw(srv.port, { method: 'OPTIONS', path: `/${TOKEN}/api/op`, headers: h }),
      ];
      for (const r of resps) {
        for (const k of Object.keys(r.headers)) {
          assert.ok(!k.startsWith('access-control-'), `★ 出现了 ${k}——跨源页面从此能读响应`);
        }
      }
    } finally {
      await srv.close();
    }
  });

  test('★ OPTIONS（预检）→ 405', async () => {
    const { srv } = await start();
    try {
      const r = await raw(srv.port, {
        method: 'OPTIONS',
        path: `/${TOKEN}/api/op`,
        headers: {
          ...selfHeaders(srv.port),
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
      assert.equal(r.status, 405, '★ 预检拿不到 200，浏览器就不发真请求了');
      assert.equal(r.headers['access-control-allow-origin'], undefined);
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 控制 7 / 8 / 11：响应头 ═══════════

describe('★★ serveWeb —— 响应头', () => {
  test('★★ CSP 每一段都在（`default-src none` 是承重墙）', async () => {
    const { srv } = await start();
    try {
      const r = await raw(srv.port, { path: `/${TOKEN}/`, headers: selfHeaders(srv.port) });
      const csp = /** @type {string} */ (r.headers['content-security-policy']);
      assert.ok(csp, '★ 没有 CSP');
      for (const part of [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        "img-src 'self' data:",
        "form-action 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
      ]) {
        assert.ok(csp.includes(part), `CSP 少了 ${part}`);
      }
      // ★ `default-src 'none'` 要是被写成 `'self'`，XSS 就能把状态外带出去
      assert.ok(!/default-src[^;]*'self'/.test(csp), '★ default-src 不许放开');
    } finally {
      await srv.close();
    }
  });

  test('★★ 每个响应都带 charset + nosniff + no-referrer', async () => {
    const { srv } = await start();
    try {
      const h = selfHeaders(srv.port);
      /** @type {any[]} */
      const resps = [
        await raw(srv.port, { path: `/${TOKEN}/`, headers: h }),
        await raw(srv.port, { path: `/${TOKEN}/app.js`, headers: h }),
        await raw(srv.port, { path: `/${TOKEN}/api/state`, headers: h }),
        await raw(srv.port, { path: `/${TOKEN}/nope`, headers: h }),
      ];
      for (const r of resps) {
        assert.match(/** @type {string} */ (r.headers['content-type']), /charset=utf-8/, '★ 少 charset = 别人机器上满屏乱码');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.equal(r.headers['referrer-policy'], 'no-referrer', '★ 口令就在 URL 里，referrer 不能带出去');
      }
    } finally {
      await srv.close();
    }
  });

  test('★★ API 与资产**都不许进缓存**（URL 里含口令）', async () => {
    const { srv } = await start();
    try {
      const h = selfHeaders(srv.port);
      for (const p of ['api/state', '', 'app.js']) {
        const r = await raw(srv.port, { path: `/${TOKEN}/${p}`, headers: h });
        assert.equal(r.headers['cache-control'], 'no-store', `${p} 可缓存`);
      }
    } finally {
      await srv.close();
    }
  });

  test('★ 资产的 Content-Type 原样送出去，没带 charset 的补上', async () => {
    const { srv } = await start();
    try {
      const h = selfHeaders(srv.port);
      assert.equal((await raw(srv.port, { path: `/${TOKEN}/`, headers: h })).headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(
        (await raw(srv.port, { path: `/${TOKEN}/app.js`, headers: h })).headers['content-type'],
        'application/javascript; charset=utf-8',
      );
      assert.equal((await raw(srv.port, { path: `/${TOKEN}/style.css`, headers: h })).headers['content-type'], 'text/css; charset=utf-8');
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 控制 9：请求体上限 ═══════════

describe('★★ serveWeb —— 请求体上限', () => {
  /** 造一个**字节数正好**是 `bytes` 的 JSON 体。 */
  function bodyOfBytes(bytes) {
    const head = '{"pad":"';
    const tail = '"}';
    return `${head}${'x'.repeat(bytes - head.length - tail.length)}${tail}`;
  }

  test('★★ 100 KiB → 413（而且 `ops.apply` 一次都没被叫）', async () => {
    const { srv, calls } = await start();
    try {
      const r = await post(srv, bodyOfBytes(100 * 1024));
      assert.equal(r.status, 413);
      assert.deepEqual(calls, [], '★ 超限的体绝不许走到业务逻辑');
    } finally {
      await srv.close();
    }
  });

  test('★ 上限之内照常；**正好等于上限**也算过（边界是 `>`，不是 `>=`）', async () => {
    const { srv, calls } = await start();
    try {
      assert.equal((await post(srv, bodyOfBytes(1024))).status, 200);
      assert.equal((await post(srv, bodyOfBytes(MAX_BODY_BYTES))).status, 200, '正好 64 KiB 不该被拒');
      assert.equal((await post(srv, bodyOfBytes(MAX_BODY_BYTES + 1))).status, 413, '多一个字节就该拒');
      assert.equal(calls.length, 2, '★ 只该有前两个走到 ops.apply');
    } finally {
      await srv.close();
    }
  });

  test('★★ 声明 100 MiB、实际只写 65 KiB —— **不等传完**就回 413', async () => {
    const { srv } = await start();
    try {
      /** @type {import('node:http').ClientRequest | null} */
      let held = null;
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: srv.port,
            method: 'POST',
            path: `/${TOKEN}/api/op`,
            headers: {
              ...selfHeaders(srv.port),
              'content-type': 'application/json',
              // ★ 这个数**我们不信**——下面只写 65 KiB，而请求故意不 end()
              'content-length': String(100 * 1024 * 1024),
            },
          },
          (r) => {
            r.resume();
            resolve(r);
          },
        );
        held = req;
        req.on('error', reject);
        req.write(Buffer.alloc(MAX_BODY_BYTES + 1024, 0x78));
      });
      assert.equal(res.statusCode, 413, '★ 等到 body 传完才判 = 内存保护是假的');
      held?.destroy();
    } finally {
      await srv.close();
    }
  });

  test('★★ chunked（**没有** Content-Length）一样挡得住', async () => {
    const { srv } = await start();
    try {
      const big = bodyOfBytes(200 * 1024);
      const r = await new Promise((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: srv.port,
            method: 'POST',
            path: `/${TOKEN}/api/op`,
            headers: { ...selfHeaders(srv.port), 'content-type': 'application/json' },
          },
          (res2) => {
            res2.resume();
            resolve(res2);
          },
        );
        req.on('error', reject);
        // 不设 content-length ⇒ Node 自己走 chunked
        req.write(big.slice(0, 100 * 1024));
        req.end(big.slice(100 * 1024));
      });
      assert.equal(/** @type {any} */ (r).statusCode, 413);
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 控制 10：方法白名单 ═══════════

describe('★★ serveWeb —— 方法白名单', () => {
  test('★ 资产上 POST / DELETE → 405 + `Allow`', async () => {
    const { srv, calls } = await start();
    try {
      for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
        const r = await raw(srv.port, { method, path: `/${TOKEN}/app.js`, headers: selfHeaders(srv.port) });
        assert.equal(r.status, 405, `${method} 不该被受理`);
        assert.equal(r.headers.allow, 'GET, HEAD');
      }
      assert.deepEqual(calls, [], '★ 405 的请求不许碰到 ops');
    } finally {
      await srv.close();
    }
  });

  test('★ `api/state` 只认 GET/HEAD，`api/op` 只认 POST', async () => {
    const { srv } = await start();
    try {
      const h = selfHeaders(srv.port);
      const a = await raw(srv.port, { method: 'POST', path: `/${TOKEN}/api/state`, headers: h, body: '{}' });
      assert.equal(a.status, 405);
      assert.equal(a.headers.allow, 'GET, HEAD');
      const b = await raw(srv.port, { method: 'GET', path: `/${TOKEN}/api/op`, headers: h });
      assert.equal(b.status, 405);
      assert.equal(b.headers.allow, 'POST');
    } finally {
      await srv.close();
    }
  });

  test('★ 未知路径 + 未知方法 → **405**：方法先于路径判，所以"存在与否"根本进不了这个判断', async () => {
    const { srv } = await start();
    try {
      const h = selfHeaders(srv.port);
      const r = await raw(srv.port, { method: 'DELETE', path: `/${TOKEN}/nope`, headers: h });
      assert.equal(r.status, 405);
      // ★ 反过来说：**顺序不能倒**。先查路径的话，`POST /存在的资产` 会是 405、
      //   `POST /不存在的资产` 会是 404——同一个方法两个码，那就是个探测口。
      const exists = await raw(srv.port, { method: 'DELETE', path: `/${TOKEN}/app.js`, headers: h });
      assert.deepEqual([r.status, r.body], [exists.status, exists.body], '★ 存在与不存在必须一模一样');
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 控制 12 / 13：退出路径 ═══════════

describe('★★ serveWeb —— 退出路径', () => {
  test('★★ 空闲到点自己关（一个会写配置的服务器不该活得比终端久）', async () => {
    const { srv } = await start({ input: { idleMs: 60 } });
    await srv.closed;
    await assert.rejects(fetch(srv.url), '★ 到点了还连得上');
  });

  test('★ 有请求就一直不关（每次请求都重置计时）', async () => {
    const { srv } = await start({ input: { idleMs: 120 } });
    try {
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 50));
        assert.equal((await fetch(`${srv.url}api/state`)).status, 200, '第 ' + i + ' 次被关掉了');
      }
    } finally {
      await srv.close();
    }
  });

  test('★★ SIGINT 关服务，并且**把监听摘干净**', async () => {
    const before = process.listenerCount('SIGINT');
    const { srv } = await start();
    assert.equal(process.listenerCount('SIGINT'), before + 1, '★ 起服务就该挂上 SIGINT');
    process.emit('SIGINT');
    await srv.closed;
    assert.equal(process.listenerCount('SIGINT'), before, '★ 关掉之后不摘 = 下一个用 Ctrl+C 的人发现它没反应');
    await assert.rejects(fetch(srv.url));
  });

  test('★ `close()` 幂等，且 `closed` 与它同时成立', async () => {
    const { srv } = await start();
    await Promise.all([srv.close(), srv.close(), srv.close()]);
    await srv.closed;
    assert.equal(process.listenerCount('SIGINT'), 0, '★ 三次 close 不该摘出问题');
  });

  test('★★ 关掉之后端口**真的**释放（能原地再绑一次）', async () => {
    const a = await serveWeb(
      /** @type {any} */ ({ ops: makeOps().ops, assets: ASSETS, _random: () => 'AAA', _listen: listenAt(0, []) }),
    );
    const port = a.port;
    await a.close();
    // ★ 端口没放掉的话，这一句会 EADDRINUSE
    const b = await serveWeb(
      /** @type {any} */ ({ ops: makeOps().ops, assets: ASSETS, _random: () => 'BBB', _listen: listenAt(port, []) }),
    );
    try {
      assert.equal(b.port, port);
    } finally {
      await b.close();
    }
  });
});

// ═══════════ 控制 14：日志 ═══════════

describe('★★ serveWeb —— 日志', () => {
  test('★★ `onLog` 只有那四个字段，**永远不含请求体**（里面是明文密钥）', async () => {
    const { srv, logs } = await start();
    try {
      await post(srv, { op: 'set-secret', secret: 'sk-SECRET-MARKER-0123456789' });
      assert.ok(logs.length >= 1);
      for (const e of logs) {
        assert.deepEqual(Object.keys(e).sort(), ['method', 'ms', 'path', 'status'], '★ 多一个字段就可能多一条密钥');
        assert.equal(typeof e.ms, 'number');
      }
      assert.doesNotMatch(JSON.stringify(logs), /SECRET-MARKER/, '★ 密钥进日志了');
    } finally {
      await srv.close();
    }
  });

  test('★★ 日志里的 path **不含口令**（口令少出现一次就少一处泄漏面）', async () => {
    const { srv, logs } = await start();
    try {
      await fetch(`${srv.url}api/state`);
      assert.ok(logs.some((e) => e.path === '/api/state'), JSON.stringify(logs));
      assert.doesNotMatch(JSON.stringify(logs), new RegExp(TOKEN), '★ 口令进了日志');
    } finally {
      await srv.close();
    }
  });

  test('★ 每个响应都记一条，带状态码', async () => {
    const { srv, logs } = await start();
    try {
      await raw(srv.port, { path: '/WRONG/', headers: selfHeaders(srv.port) });
      await fetch(`${srv.url}app.js`);
      assert.deepEqual(
        logs.map((e) => [e.method, e.path, e.status]),
        [
          ['GET', '/', 404],
          ['GET', '/app.js', 200],
        ],
      );
    } finally {
      await srv.close();
    }
  });

  test('★ `onLog` 自己抛错不许影响响应', async () => {
    const { srv } = await start({
      input: {
        onLog: () => {
          throw new Error('日志炸了');
        },
      },
    });
    try {
      assert.equal((await fetch(srv.url)).status, 200);
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 路由 ═══════════

describe('★ serveWeb —— 路由', () => {
  test('★★ `/<口令>`（没有尾斜杠）→ 301 到 `/<口令>/`', async () => {
    const { srv } = await start();
    try {
      const r = await raw(srv.port, { path: `/${TOKEN}`, headers: selfHeaders(srv.port) });
      assert.equal(r.status, 301);
      assert.equal(r.headers.location, `/${TOKEN}/`);
      // ★ 存在的唯一理由是**相对 URL**：前端写的是 `fetch('api/state')`，
      //   少了尾斜杠它会解析到上一层去。所以这里必须跟着跳一次，看真的能拿到首页。
      const followed = await fetch(`${srv.url}`, { redirect: 'follow' });
      assert.equal(followed.status, 200);
      assert.match(await followed.text(), /控制台/);
    } finally {
      await srv.close();
    }
  });

  test('★ 首页 / 三个资产 / 未知路径', async () => {
    const { srv } = await start();
    try {
      assert.match(await (await fetch(srv.url)).text(), /doctype html/);
      assert.equal(await (await fetch(`${srv.url}app.js`)).text(), 'console.log(1)');
      assert.equal(await (await fetch(`${srv.url}style.css`)).text(), 'body{margin:0}');
      const missing = await fetch(`${srv.url}nope.txt`);
      assert.equal(missing.status, 404);
      assert.equal(await missing.text(), '');
    } finally {
      await srv.close();
    }
  });

  test('★★ 路径穿越**结构上不可能**（查表，不拼路径）', async () => {
    const { srv } = await start();
    try {
      const h = selfHeaders(srv.port);
      // ★ 用裸请求发：`fetch` 会**在客户端**就把 `./` 归一化掉，那样测的就不是
      //   服务端了。这里要的是让这些串**原样**到达服务端。
      for (const p of ['../src/cli/main.js', '..%2f..%2fetc%2fpasswd', 'a/b/c', './app.js', '%2e%2e/app.js', '.']) {
        const r = await raw(srv.port, { path: `/${TOKEN}/${p}`, headers: h });
        assert.equal(r.status, 404, `${p} 不该被受理`);
      }
      // 反过来：正常的那个还在
      assert.equal((await raw(srv.port, { path: `/${TOKEN}/app.js`, headers: h })).status, 200);
    } finally {
      await srv.close();
    }
  });

  test('★ HEAD：头都在，body 一个字节都没有', async () => {
    const { srv } = await start();
    try {
      const r = await raw(srv.port, { method: 'HEAD', path: `/${TOKEN}/app.js`, headers: selfHeaders(srv.port) });
      assert.equal(r.status, 200);
      assert.equal(r.body, '');
      assert.equal(r.headers['content-length'], '14', '★ HEAD 的 Content-Length 要说真话');
      assert.equal(r.headers['content-type'], 'application/javascript; charset=utf-8');
    } finally {
      await srv.close();
    }
  });

  test('★ 带查询串不影响路由', async () => {
    const { srv } = await start();
    try {
      assert.equal((await fetch(`${srv.url}api/state?x=1&y=2`)).status, 200);
      assert.equal((await fetch(`${srv.url}app.js?v=1`)).status, 200);
    } finally {
      await srv.close();
    }
  });

  test('★ `/<口令>/api/state/`（多一个斜杠）**不是** api/state', async () => {
    const { srv } = await start();
    try {
      assert.equal((await fetch(`${srv.url}api/state/`)).status, 404);
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ ops 契约 ═══════════

describe('★★ serveWeb —— ops 契约', () => {
  test('★ `apply` 收到的是**解析后的对象**，回的 `view` 原样送回去', async () => {
    const { srv, calls } = await start({ opsOpts: { apply: (b) => ({ view: { echo: b } }) } });
    try {
      const r = await post(srv, { op: 'toggle-model', id: 'gpt-x' });
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { echo: { op: 'toggle-model', id: 'gpt-x' } });
      assert.deepEqual(calls, [{ op: 'toggle-model', id: 'gpt-x' }]);
    } finally {
      await srv.close();
    }
  });

  test('★ 坏 JSON → 400，且**不碰** `ops.apply`', async () => {
    const { srv, calls } = await start();
    try {
      const r = await post(srv, '{ 这不是 json');
      assert.equal(r.status, 400);
      assert.deepEqual(calls, []);
    } finally {
      await srv.close();
    }
  });

  test('★★ `apply` 抛错 → 500，而且**服务还活着**', async () => {
    let n = 0;
    const { srv } = await start({
      opsOpts: {
        apply: () => {
          n += 1;
          if (n === 1) throw new Error('内部炸了');
          return { view: { ok: true } };
        },
      },
    });
    try {
      const bad = await post(srv, { op: 'x' });
      assert.equal(bad.status, 500);
      assert.equal((await post(srv, { op: 'y' })).status, 200, '★ 一次失败不该把服务带走');
    } finally {
      await srv.close();
    }
  });

  test('★ `view` 抛错 → 500', async () => {
    const { srv } = await start({
      opsOpts: {
        view: () => {
          throw new Error('读状态炸了');
        },
      },
    });
    try {
      assert.equal((await fetch(`${srv.url}api/state`)).status, 500);
    } finally {
      await srv.close();
    }
  });

  test('★★ 两个并发 POST **串行**（不然会交错着改唯一那份 reducer 状态）', async () => {
    /** @type {string[]} */
    const order = [];
    const { srv } = await start({
      opsOpts: {
        apply: async (/** @type {any} */ b) => {
          order.push(`start${b.n}`);
          await new Promise((r) => setTimeout(r, 40));
          order.push(`end${b.n}`);
          return { view: { n: b.n } };
        },
      },
    });
    try {
      const [a, b] = await Promise.all([post(srv, { n: 1 }), post(srv, { n: 2 })]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2'], '★ 交错 = 两个动作各改一半');
    } finally {
      await srv.close();
    }
  });

  test('★ 前一个 POST 失败了，链子**不断**（后面那个照样跑）', async () => {
    let n = 0;
    const { srv } = await start({
      opsOpts: {
        apply: async () => {
          n += 1;
          if (n === 1) throw new Error('第一个炸了');
          return { view: { ok: n } };
        },
      },
    });
    try {
      const [a, b] = await Promise.all([post(srv, { n: 1 }), post(srv, { n: 2 })]);
      assert.equal(a.status, 500);
      assert.equal(b.status, 200);
      assert.deepEqual(await b.json(), { ok: 2 });
    } finally {
      await srv.close();
    }
  });

  test('★★ `done: true` → **回完响应**才关（那条 200 不许跟着连接一起没）', async () => {
    const { srv } = await start({ opsOpts: { apply: () => ({ view: { bye: true }, done: true }) } });
    const r = await post(srv, { op: 'quit' });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { bye: true });
    await srv.closed;
    await assert.rejects(fetch(srv.url));
  });

  test('★ `done` 不写就**不关**（默认是"接着开")', async () => {
    const { srv } = await start();
    try {
      await post(srv, { op: 'x' });
      assert.equal((await fetch(`${srv.url}api/state`)).status, 200);
    } finally {
      await srv.close();
    }
  });
});

// ═══════════ 启动前的校验 ═══════════

describe('★ serveWeb —— 启动前就把错的挡掉', () => {
  test('★ 没有 `ops.view` / `ops.apply` → 抛', async () => {
    const assets = ASSETS;
    await assert.rejects(
      serveWeb(/** @type {any} */ ({ assets })),
      /ops\.view/,
    );
    await assert.rejects(
      serveWeb(/** @type {any} */ ({ ops: { view: () => ({}) }, assets })),
      /ops\.apply/,
    );
  });

  test('★ `assets` 里没有首页 → 抛（不然起得来但打不开）', async () => {
    await assert.rejects(
      serveWeb(/** @type {any} */ ({ ops: makeOps().ops, assets: new Map() })),
      /首页/,
    );
  });

  test('★ 口令必须是 URL 安全的一段（带 `/` 的话路由第一段就不是口令了）', async () => {
    await assert.rejects(
      serveWeb(/** @type {any} */ ({ ops: makeOps().ops, assets: ASSETS, _random: () => 'a/b' })),
      /口令/,
    );
    await assert.rejects(
      serveWeb(/** @type {any} */ ({ ops: makeOps().ops, assets: ASSETS, _random: () => '' })),
      /口令/,
    );
  });

  test('★ 资产路径必须以 `/` 开头', async () => {
    await assert.rejects(
      serveWeb(
        /** @type {any} */ ({ ops: makeOps().ops, assets: new Map([['nope', { body: 'x' }]]) }),
      ),
      /以 \/ 开头/,
    );
  });

  test('★ 普通对象也能当 `assets`（省得调用方包一层 Map）', async () => {
    const srv = await serveWeb(
      /** @type {any} */ ({
        ops: makeOps().ops,
        assets: { '/': { type: 'text/html', body: 'hi' } },
        _random: () => TOKEN,
      }),
    );
    try {
      assert.equal(await (await fetch(srv.url)).text(), 'hi');
    } finally {
      await srv.close();
    }
  });
});
