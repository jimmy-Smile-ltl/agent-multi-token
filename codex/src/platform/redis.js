// @ts-check
/**
 * 零依赖的 Redis 客户端（RESP2）。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ **它是可选的，永远是配角。** 这个模块不认识"池"、不认识任何业务，
 * 只做一件事：把一个地址变成能 `call('GET', key)` 的东西。
 * 真相永远在本地那份 JSON 里，Redis 只是"多台机器看到同一份状态"的手段。
 * 所以它的每一种失败都应该是**可以吞掉的**——调用方要按这个前提写。
 *
 * ★ **为什么自己写、不引 `ioredis` / `redis`**：整个仓库零 npm 运行时依赖，
 * 而这里要的只是六个命令。RESP2 的协议简单到一页代码写完，引一个
 * 带连接池、集群、哨兵、脚本缓存的库换这六个命令不划算。
 *
 * ★ 只实现了**够用的子集**：没有连接池、没有订阅、没有集群、
 * 没有 `MOVED` 重定向。**一次只有一个命令在飞**（见 `call` 的串行化）。
 * ─────────────────────────────────────────────────────────────
 */

import net from 'node:net';
import tls from 'node:tls';

/** 没写端口时的默认值 */
export const DEFAULT_PORT = 6379;

/** 单条命令的默认超时。**宁可失败也不要挂着**——它的调用方在一条同步命令里 */
export const DEFAULT_TIMEOUT_MS = 5000;

const CRLF = Buffer.from('\r\n', 'utf8');

/* ── 地址解析 ─────────────────────────────────────────────── */

/**
 * @typedef {object} RedisTarget
 * @property {'redis' | 'rediss' | 'unix'} kind
 * @property {string} host       `unix` 时为空串
 * @property {number} port       `unix` 时为 0
 * @property {string} path       `unix` 时的套接字路径
 * @property {string} username   没写就是 `''`
 * @property {string} password   没写就是 `''`
 * @property {number | null} db  没写就是 `null`（= 不 SELECT）
 */

/**
 * 解一个 Redis 地址。
 *
 * ```
 * redis://[:password@]host[:port][/db]
 * rediss://[:password@]host[:port][/db]        # TLS
 * unix:///absolute/path/to/redis.sock[?db=N]
 * ```
 *
 * ★ 密码里的 `@` `:` `/` `#` 必须**百分号编码**——这是 URL 的规矩。
 * 不编码会被当成主机名的一部分解析，然后连到一个不存在的主机上去
 * （报错只写着"连不上"，完全看不出真正的原因）。
 *
 * ★ 也认 `user:password`：Redis 6 起 ACL 用户是正经功能。
 * 只写冒号（`:password`）就是老式 AUTH。
 *
 * ★ `unix://` 的路径就是套接字路径，没法再塞库号，所以库号走 `?db=N`。
 *
 * @param {string} raw
 * @returns {RedisTarget}
 */
export function parseRedisUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('Redis 地址是空的');
  }

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Redis 地址不是合法的 URL（形如 redis://主机:端口/库号）');
  }

  const username = decode(url.username);
  const password = decode(url.password);

  if (url.protocol === 'unix:') {
    const path = url.pathname;
    if (path === '' || path === '/') throw new Error('unix 地址里没有套接字路径');
    return {
      kind: 'unix',
      host: '',
      port: 0,
      path,
      username,
      password,
      db: dbFromQuery(url),
    };
  }

  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error(`不认识的协议 ${url.protocol}（只认 redis / rediss / unix）`);
  }

  if (url.hostname === '') throw new Error('Redis 地址里没有主机名');

  const port = url.port === '' ? DEFAULT_PORT : Number(url.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`端口不合法：${url.port}`);
  }

  return {
    kind: url.protocol === 'rediss:' ? 'rediss' : 'redis',
    host: url.hostname,
    port,
    path: '',
    username,
    password,
    db: dbFromPath(url.pathname) ?? dbFromQuery(url),
  };
}

/**
 * @param {string} value
 * @returns {string}
 */
function decode(value) {
  if (value === '') return '';
  try {
    return decodeURIComponent(value);
  } catch {
    // 写了一个非法的百分号编码：原样用，别让一个 `%` 挡住整条连接
    return value;
  }
}

/**
 * `/0` → 0；`/` 或空 → `null`（不 SELECT）。**其它形状一律报错**——
 * 悄悄当作没写，人就永远不知道为什么一直连到 0 号库。
 * @param {string} pathname
 * @returns {number | null}
 */
function dbFromPath(pathname) {
  if (pathname === '' || pathname === '/') return null;
  const m = /^\/(\d{1,4})$/.exec(pathname);
  if (m === null) throw new Error(`路径只能是库号（形如 /1），拿到的是 ${pathname}`);
  return Number(m[1]);
}

/**
 * @param {URL} url
 * @returns {number | null}
 */
function dbFromQuery(url) {
  const raw = url.searchParams.get('db');
  if (raw === null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 9999) throw new Error(`库号不合法：${raw}`);
  return n;
}

/* ── 命令编码 ─────────────────────────────────────────────── */

/**
 * 把一条命令编成一串 RESP 数组：`*N\r\n` 后跟 N 个 `$len\r\n<payload>\r\n`。
 *
 * ★ **长度按字节算，不按字符**：中文值、或者正好含 `\r\n` 的值，按字符算长度
 * 会把协议写坏——服务端会一直等后面的字节，表现成"连上了但没反应"。
 *
 * @param {unknown[]} args
 * @returns {Buffer}
 */
export function encodeCommand(args) {
  /** @type {Buffer[]} */
  const parts = [Buffer.from(`*${args.length}\r\n`, 'utf8')];

  for (const arg of args) {
    const body = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8');
    parts.push(Buffer.from(`$${body.length}\r\n`, 'utf8'), body, CRLF);
  }

  return Buffer.concat(parts);
}

/* ── 应答解析 ─────────────────────────────────────────────── */

/**
 * 试着从 `buf[at..]` 读一个完整的 RESP 值。
 *
 * @param {Buffer} buf
 * @param {number} at
 * @returns {{ value?: unknown, error?: string, offset: number } | null}
 *   不完整返回 `null`（等更多字节）；协议坏掉抛错。
 */
export function tryParse(buf, at) {
  if (at >= buf.length) return null;

  const type = buf[at];
  const lineEnd = buf.indexOf(CRLF, at + 1);
  if (lineEnd < 0) return null;

  const line = buf.toString('utf8', at + 1, lineEnd);
  const next = lineEnd + 2;

  switch (type) {
    case 0x2b: // +
      return { value: line, offset: next };

    case 0x2d: // -
      return { error: line, offset: next };

    case 0x3a: // :
      return { value: Number(line), offset: next };

    case 0x24: {
      // $
      const len = Number(line);
      if (!Number.isInteger(len)) throw new Error('Redis 应答里的长度不是整数');
      if (len < 0) return { value: null, offset: next }; // $-1 = 没有这个键
      if (buf.length < next + len + 2) return null;
      return { value: buf.toString('utf8', next, next + len), offset: next + len + 2 };
    }

    case 0x2a: {
      // *
      const count = Number(line);
      if (!Number.isInteger(count)) throw new Error('Redis 应答里的数组长度不是整数');
      if (count < 0) return { value: null, offset: next };

      /** @type {unknown[]} */
      const items = [];
      let cursor = next;
      for (let i = 0; i < count; i += 1) {
        const sub = tryParse(buf, cursor);
        if (sub === null) return null;
        if (sub.error !== undefined) return { error: sub.error, offset: sub.offset };
        items.push(sub.value);
        cursor = sub.offset;
      }
      return { value: items, offset: cursor };
    }

    default:
      throw new Error(`无法识别的 Redis 应答类型 0x${type.toString(16)}`);
  }
}

/* ── 连接 ─────────────────────────────────────────────────── */

/**
 * @typedef {object} RedisClient
 * @property {(...args: unknown[]) => Promise<unknown>} call 发一条命令
 * @property {() => void} close 断开（幂等）
 * @property {RedisTarget} target 解出来的地址（**密码就在里面**，别打印）
 */

/**
 * 连上去，做完 AUTH / SELECT，返回一个能 `call` 的客户端。
 *
 * @param {string} url
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<RedisClient>}
 */
export async function connect(url, opts = {}) {
  const target = parseRedisUrl(url);
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

  const socket = await openSocket(target, timeoutMs);
  const client = makeClient(socket, target, timeoutMs);

  try {
    if (target.password !== '') {
      if (target.username !== '') await client.call('AUTH', target.username, target.password);
      else await client.call('AUTH', target.password);
    }
    if (target.db !== null) await client.call('SELECT', String(target.db));
  } catch (err) {
    client.close();
    throw err;
  }

  return client;
}

/**
 * @param {RedisTarget} target
 * @param {number} timeoutMs
 * @returns {Promise<import('node:net').Socket>}
 */
function openSocket(target, timeoutMs) {
  return new Promise((resolve, reject) => {
    /** @type {import('node:net').Socket} */
    let socket;

    const fail = (/** @type {Error} */ err) => {
      socket.destroy();
      reject(err);
    };

    const ready = () => {
      // ★ 连上之后必须把"连接超时"那个 error 监听摘掉：留着它，之后任何一次
      //   网络抖动都会走到 `fail` 里把**已经在用的**连接 destroy 掉。
      socket.removeListener('error', fail);
      socket.setNoDelay(true);
      socket.setTimeout(0);
      resolve(socket);
    };

    if (target.kind === 'unix') {
      socket = net.connect({ path: target.path });
    } else if (target.kind === 'rediss') {
      // servername 只在真主机名时给：给一个 IP 会被 TLS 层当成 SNI 主机名，
      // 而证书校验随后会拿它去比对，结果是一条**必然失败**的连接
      const isIp = /^\d+(\.\d+){3}$/.test(target.host);
      socket = tls.connect({
        host: target.host,
        port: target.port,
        servername: isIp ? undefined : target.host,
      });
    } else {
      socket = net.connect({ host: target.host, port: target.port });
    }

    socket.setTimeout(timeoutMs, () => fail(new Error('连接 Redis 超时')));
    socket.once('error', fail);
    socket.once(target.kind === 'rediss' ? 'secureConnect' : 'connect', ready);
  });
}

/**
 * @param {import('node:net').Socket} socket
 * @param {RedisTarget} target
 * @param {number} timeoutMs
 * @returns {RedisClient}
 */
function makeClient(socket, target, timeoutMs) {
  /** @type {Buffer} */
  let inbox = Buffer.alloc(0);
  /** @type {{ resolve: (v: unknown) => void, reject: (e: Error) => void } | null} */
  let pending = null;
  /** @type {Error | null} */
  let fatal = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let closed = false;

  const settle = (/** @type {Error | null} */ err, /** @type {unknown} */ value) => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === null) return;
    const slot = pending;
    pending = null;
    if (err !== null) slot.reject(err);
    else slot.resolve(value);
  };

  const die = (/** @type {Error} */ err) => {
    if (fatal === null) fatal = err;
    settle(fatal, undefined);
    if (!closed) {
      closed = true;
      socket.destroy();
    }
  };

  socket.on('data', (chunk) => {
    inbox = inbox.length === 0 ? chunk : Buffer.concat([inbox, chunk]);

    // 一次只有一个命令在飞，所以第一帧完整应答就是它的
    if (pending === null) return;
    try {
      const parsed = tryParse(inbox, 0);
      if (parsed === null) return;
      inbox = inbox.subarray(parsed.offset);
      if (parsed.error !== undefined) settle(new Error(`Redis 报错：${parsed.error}`), undefined);
      else settle(null, parsed.value);
    } catch (err) {
      die(err instanceof Error ? err : new Error(String(err)));
    }
  });

  socket.on('error', (err) => die(err));
  socket.on('close', () => die(new Error('Redis 连接已断开')));

  // ★ 串行化：**一次只发一条**。
  //   并发发多条就得按顺序配对回包、还得处理"前面那条报错后面照常"的语义——
  //   这个模块的调用方（一条同步命令里跑几条 HGETALL）根本用不上，不值那个复杂度。
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  return {
    target,

    call(...args) {
      const run = chain.then(() => {
        if (fatal !== null) throw fatal;
        return new Promise((resolve, reject) => {
          pending = { resolve, reject };
          timer = setTimeout(() => {
            die(new Error('Redis 命令超时'));
          }, timeoutMs);
          socket.write(encodeCommand(args));
        });
      });
      // 前一条失败了不该堵住后面的：链条只负责排列，不负责传递失败
      chain = run.catch(() => {});
      return run;
    },

    close() {
      die(new Error('Redis 连接已关闭'));
    },
  };
}
