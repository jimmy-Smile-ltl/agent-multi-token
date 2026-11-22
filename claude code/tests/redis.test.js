// @ts-check
/**
 * RESP2 客户端：编解码、握手、时序。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ **不起真 Redis**。这一份起一个 `net.Server` 冒充服务端：
 * 收到什么命令、回什么字节，全部由测试说了算。这样能造出真服务器
 * **很难造**的那几种形状——半截帧、分块到达、`$0` 空串、
 * 先报错再照常工作——而它们正是协议实现最容易写错的地方。
 *
 * ★ 这一份不碰磁盘、不碰环境、不认业务。所以两个项目逐字共用。
 * ─────────────────────────────────────────────────────────────
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  connect,
  encodeCommand,
  parseRedisUrl,
  tryParse,
} from '../src/platform/redis.js';

/* ── 冒充服务端的几块砖 ───────────────────────────────────── */

/**
 * 从 `buf` 里读一条**客户端发来的**命令（`*N` + N 个 `$len`）。
 * 不完整返回 `null`。
 *
 * @param {Buffer} buf
 * @returns {{ args: string[], offset: number } | null}
 */
function readRequest(buf) {
  let at = 0;
  if (buf.length === 0 || buf[0] !== 0x2a) return null; // 不是数组头

  const firstEnd = buf.indexOf('\r\n', 0);
  if (firstEnd < 0) return null;
  const count = Number(buf.toString('utf8', 1, firstEnd));
  at = firstEnd + 2;

  /** @type {string[]} */
  const args = [];
  for (let i = 0; i < count; i += 1) {
    const lineEnd = buf.indexOf('\r\n', at);
    if (lineEnd < 0) return null;
    const len = Number(buf.toString('utf8', at + 1, lineEnd));
    const bodyStart = lineEnd + 2;
    if (buf.length < bodyStart + len + 2) return null;
    args.push(buf.toString('utf8', bodyStart, bodyStart + len));
    at = bodyStart + len + 2;
  }

  return { args, offset: at };
}

/**
 * 起一个假服务端。
 *
 * `onCommand(args, socket)` 返回：
 * - 字符串 / Buffer ⇒ 原样写回去；
 * - `{ chunks: [...] }` ⇒ 一块一块地写（用来造"分块到达"）；
 * - `undefined` ⇒ 什么都不写（用来造超时）。
 *
 * @param {(args: string[], socket: import('node:net').Socket) => unknown} onCommand
 * @returns {Promise<{
 *   port: number,
 *   commands: string[][],
 *   connections: () => number,
 *   close: () => Promise<void>,
 * }>}
 */
function startServer(onCommand) {
  return new Promise((resolve) => {
    /** @type {string[][]} */
    const commands = [];
    /** @type {Set<import('node:net').Socket>} */
    const live = new Set();
    let opened = 0;

    const server = net.createServer((socket) => {
      opened += 1;
      live.add(socket);
      /** @type {Buffer} */
      let buf = Buffer.alloc(0);

      socket.on('close', () => live.delete(socket));
      socket.on('error', () => {}); // 客户端中途 destroy 是测试的常态

      socket.on('data', (chunk) => {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
        for (;;) {
          const parsed = readRequest(buf);
          if (parsed === null) return;
          buf = buf.subarray(parsed.offset);
          commands.push(parsed.args);

          const reply = onCommand(parsed.args, socket);
          if (reply === undefined) continue;
          if (reply !== null && typeof reply === 'object' && 'chunks' in reply) {
            const { chunks } = /** @type {{ chunks: (string | Buffer)[] }} */ (reply);
            let i = 0;
            const tick = () => {
              if (i >= chunks.length || socket.destroyed) return;
              socket.write(chunks[i]);
              i += 1;
              setTimeout(tick, 2);
            };
            tick();
            continue;
          }
          socket.write(/** @type {string | Buffer} */ (reply));
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const address = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        port: address.port,
        commands,
        connections: () => opened,
        close: () =>
          new Promise((done) => {
            for (const s of live) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** `redis://127.0.0.1:<port>` */
function urlFor(port) {
  return `redis://127.0.0.1:${port}`;
}

/* ── 地址解析 ─────────────────────────────────────────────── */

describe('parseRedisUrl', () => {
  test('最简形状：默认端口、默认库、没有口令', () => {
    assert.deepEqual(parseRedisUrl('redis://localhost'), {
      kind: 'redis',
      host: 'localhost',
      port: DEFAULT_PORT,
      path: '',
      username: '',
      password: '',
      db: null,
    });
  });

  test('端口与库号', () => {
    const t = parseRedisUrl('redis://localhost:6380/3');
    assert.equal(t.port, 6380);
    assert.equal(t.db, 3);
    assert.equal(t.kind, 'redis');
  });

  test('末尾只有一个斜杠 = 不选库', () => {
    assert.equal(parseRedisUrl('redis://localhost/').db, null);
    assert.equal(parseRedisUrl('redis://localhost').db, null);
  });

  test('只写冒号 = 老式 AUTH（没有用户名）', () => {
    const t = parseRedisUrl('redis://:pw@localhost/2');
    assert.equal(t.username, '');
    assert.equal(t.password, 'pw');
    assert.equal(t.db, 2);
  });

  test('写了用户名 = ACL 用户', () => {
    const t = parseRedisUrl('redis://worker:pw@localhost');
    assert.equal(t.username, 'worker');
    assert.equal(t.password, 'pw');
  });

  test('★ 口令里的 @ : / 必须百分号编码，解出来要还原', () => {
    // 编码过的 `p@ss:w/rd#1`
    const t = parseRedisUrl('redis://:p%40ss%3Aw%2Frd%231@localhost');
    assert.equal(t.password, 'p@ss:w/rd#1');
    assert.equal(t.host, 'localhost');
  });

  test('★ 非法的百分号编码原样留着，不能因此连都连不上', () => {
    assert.equal(parseRedisUrl('redis://:100%@localhost').password, '100%');
  });

  test('rediss:// 走 TLS', () => {
    assert.equal(parseRedisUrl('rediss://localhost:6380').kind, 'rediss');
  });

  test('unix:// 取套接字路径，库号走查询串', () => {
    const t = parseRedisUrl('unix:///var/run/redis.sock');
    assert.equal(t.kind, 'unix');
    assert.equal(t.path, '/var/run/redis.sock');
    assert.equal(t.port, 0);
    assert.equal(t.db, null);
    assert.equal(parseRedisUrl('unix:///var/run/redis.sock?db=2').db, 2);
  });

  test('首尾空白被修掉', () => {
    assert.equal(parseRedisUrl('  redis://localhost  ').host, 'localhost');
  });

  test('空地址 / 不是 URL / 不认识的协议 都抛', () => {
    for (const bad of ['', '   ', 'not a url', 'http://localhost', 'ftp://localhost']) {
      assert.throws(() => parseRedisUrl(bad), /redis/i, JSON.stringify(bad));
    }
  });

  test('没有主机名 抛', () => {
    assert.throws(() => parseRedisUrl('redis://'), /Redis/);
  });

  test('★ 路径不是库号就抛——悄悄当作没写会让人永远连在 0 号库', () => {
    assert.throws(() => parseRedisUrl('redis://localhost/data'), /库号/);
  });

  test('库号不是数字 抛', () => {
    assert.throws(() => parseRedisUrl('unix:///tmp/x.sock?db=abc'), /库号/);
    assert.throws(() => parseRedisUrl('unix:///tmp/x.sock?db=-1'), /库号/);
  });

  test('unix:// 没有路径 抛', () => {
    assert.throws(() => parseRedisUrl('unix:///'), /套接字/);
  });

  test('非字符串 抛（不返回奇怪的东西）', () => {
    for (const bad of [null, undefined, 42, {}]) {
      // @ts-expect-error 故意传错类型
      assert.throws(() => parseRedisUrl(bad), /Redis/);
    }
  });
});

/* ── 命令编码 ─────────────────────────────────────────────── */

describe('encodeCommand', () => {
  test('单个词', () => {
    assert.equal(encodeCommand(['PING']).toString('utf8'), '*1\r\n$4\r\nPING\r\n');
  });

  test('多个词，顺序与个数都要对', () => {
    assert.equal(
      encodeCommand(['SET', 'k', 'v']).toString('utf8'),
      '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\nv\r\n',
    );
  });

  test('★★ 长度按字节算：中文 3 字节一个', () => {
    const buf = encodeCommand(['SET', 'k', '中文']);
    assert.equal(buf.toString('utf8'), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$6\r\n中文\r\n');
  });

  test('★ 值里带 CRLF 也不会把帧写坏（长度是字节数，不是行数）', () => {
    const buf = encodeCommand(['SET', 'k', 'a\r\nb']);
    assert.equal(buf.toString('utf8'), '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$4\r\na\r\nb\r\n');
  });

  test('Buffer 原样进去（不经过字符串）', () => {
    const raw = Buffer.from([0x00, 0xff, 0x0a]);
    const buf = encodeCommand(['SET', 'k', raw]);
    const header = '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\n';
    assert.equal(buf.subarray(0, header.length).toString('utf8'), header);
    // 那三个字节一个字都不能被改写，后面紧跟帧尾
    assert.deepEqual([...buf.subarray(header.length)], [0x00, 0xff, 0x0a, 0x0d, 0x0a]);
  });

  test('数字被转成字符串', () => {
    assert.equal(encodeCommand([1, 2]).toString('utf8'), '*2\r\n$1\r\n1\r\n$1\r\n2\r\n');
  });
});

/* ── 应答解析 ─────────────────────────────────────────────── */

describe('tryParse', () => {
  /** @param {string} raw */
  const parse = (raw) => tryParse(Buffer.from(raw, 'utf8'), 0);

  test('简单串', () => {
    assert.deepEqual(parse('+OK\r\n'), { value: 'OK', offset: 5 });
  });

  test('错误行带在结果上，不是抛出去', () => {
    assert.deepEqual(parse('-ERR boom\r\n'), { error: 'ERR boom', offset: 11 });
  });

  test('整数', () => {
    assert.deepEqual(parse(':42\r\n'), { value: 42, offset: 5 });
    assert.deepEqual(parse(':-7\r\n'), { value: -7, offset: 5 });
  });

  test('批量串', () => {
    assert.deepEqual(parse('$5\r\nhello\r\n'), { value: 'hello', offset: 11 });
  });

  test('★ $0 是空串，不是 null（键存在但值是空的——很常见）', () => {
    assert.deepEqual(parse('$0\r\n\r\n'), { value: '', offset: 6 });
  });

  test('$-1 是 null（没有这个键）', () => {
    assert.deepEqual(parse('$-1\r\n'), { value: null, offset: 5 });
  });

  test('数组里混着空串与 null', () => {
    assert.deepEqual(parse('*3\r\n$3\r\nfoo\r\n:1\r\n$-1\r\n'), {
      value: ['foo', 1, null],
      offset: 22,
    });
  });

  test('嵌套数组', () => {
    assert.deepEqual(parse('*1\r\n*2\r\n+a\r\n+b\r\n'), { value: [['a', 'b']], offset: 16 });
  });

  test('*-1 = 空数组也是 null', () => {
    assert.deepEqual(parse('*-1\r\n'), { value: null, offset: 5 });
  });

  test('帧不完整一律 null（等下一块数据，不是报错）', () => {
    for (const raw of ['+OK', '$5\r\nhell', '*2\r\n+a\r\n', '$3\r\nab', '*']) {
      assert.equal(parse(raw), null, JSON.stringify(raw));
    }
  });

  test('空缓冲 null', () => {
    assert.equal(tryParse(Buffer.alloc(0), 0), null);
  });

  test('从非零偏移读，offset 是绝对的', () => {
    const buf = Buffer.from('+OK\r\n+NO\r\n', 'utf8');
    const first = tryParse(buf, 0);
    assert.equal(first?.value, 'OK');
    const second = tryParse(buf, /** @type {number} */ (first?.offset));
    assert.equal(second?.value, 'NO');
    assert.equal(second?.offset, 10);
  });

  test('认不出的类型抛（协议坏了，不能当没看见）', () => {
    assert.throws(() => parse('?x\r\n'), /Redis/);
  });

  test('长度不是整数抛', () => {
    assert.throws(() => parse('$abc\r\n'), /长度/);
    assert.throws(() => parse('*abc\r\n'), /长度/);
  });
});

/* ── 连上之后 ─────────────────────────────────────────────── */

describe('connect / call', () => {
  test('发一条，回一条', async () => {
    const server = await startServer(() => '+PONG\r\n');
    try {
      const client = await connect(urlFor(server.port));
      assert.equal(await client.call('PING'), 'PONG');
      assert.deepEqual(server.commands, [['PING']]);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('带口令与库号时，先 AUTH 再 SELECT，然后才轮到业务命令', async () => {
    const server = await startServer((args) => (args[0] === 'AUTH' ? '+OK\r\n' : '+OK\r\n'));
    try {
      const client = await connect(`redis://:pw@127.0.0.1:${server.port}/3`);
      await client.call('PING');
      assert.deepEqual(server.commands, [['AUTH', 'pw'], ['SELECT', '3'], ['PING']]);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('有用户名时 AUTH 是三段式', async () => {
    const server = await startServer(() => '+OK\r\n');
    try {
      const client = await connect(`redis://worker:pw@127.0.0.1:${server.port}`);
      assert.deepEqual(server.commands, [['AUTH', 'worker', 'pw']]);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('没有口令就不发 AUTH（多余的 AUTH 会被某些服务端直接断开）', async () => {
    const server = await startServer(() => '+PONG\r\n');
    try {
      const client = await connect(urlFor(server.port));
      await client.call('PING');
      assert.deepEqual(server.commands, [['PING']]);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('握手被拒 ⇒ connect 自己抛，且不留下一条活着的连接', async () => {
    const server = await startServer(() => '-WRONGPASS bad\r\n');
    try {
      await assert.rejects(() => connect(`redis://:pw@127.0.0.1:${server.port}`), /WRONGPASS/);
    } finally {
      await server.close();
    }
  });

  test('★ 错误行变成 reject；连接**还能继续用**', async () => {
    let n = 0;
    const server = await startServer(() => {
      n += 1;
      return n === 1 ? '-WRONGTYPE Operation against a key\r\n' : '+OK\r\n';
    });
    try {
      const client = await connect(urlFor(server.port));
      await assert.rejects(() => client.call('GET', 'a'), /WRONGTYPE/);
      // 一个命令报错不该把整条连接弄死——批量同步时一条失败不该毁掉其余
      assert.equal(await client.call('PING'), 'OK');
      client.close();
    } finally {
      await server.close();
    }
  });

  test('★ 一条应答分几块到达，仍然拼得对', async () => {
    const server = await startServer(() => ({
      chunks: ['*3\r\n$3\r\nfoo\r\n', ':1\r\n', '$-1\r\n'],
    }));
    try {
      const client = await connect(urlFor(server.port));
      assert.deepEqual(await client.call('LRANGE', 'k', '0', '-1'), ['foo', 1, null]);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('★ 一块里挤着两条应答，一条都不能丢', async () => {
    // 一次写两条；客户端一次只有一个命令在飞，所以第二条要等下一次 call 才被消费
    const server = await startServer(() => '+A\r\n+B\r\n');
    try {
      const client = await connect(urlFor(server.port));
      assert.equal(await client.call('PING'), 'A');
      assert.equal(await client.call('PING'), 'B');
      client.close();
    } finally {
      await server.close();
    }
  });

  test('连续多条命令共用一条连接', async () => {
    let n = 0;
    const server = await startServer(() => {
      n += 1;
      return `:${n}\r\n`;
    });
    try {
      const client = await connect(urlFor(server.port));
      assert.equal(await client.call('INCR', 'c'), 1);
      assert.equal(await client.call('INCR', 'c'), 2);
      assert.equal(await client.call('INCR', 'c'), 3);
      assert.equal(server.connections(), 1);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('★ 不 await 连发两条，也按顺序配对上', async () => {
    let n = 0;
    const server = await startServer(() => {
      n += 1;
      return `:${n}\r\n`;
    });
    try {
      const client = await connect(urlFor(server.port));
      const a = client.call('INCR', 'c');
      const b = client.call('INCR', 'c');
      assert.deepEqual(await Promise.all([a, b]), [1, 2]);
      assert.deepEqual(server.commands, [
        ['INCR', 'c'],
        ['INCR', 'c'],
      ]);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('★ 前一条失败，后一条照常发出（链条不传递失败）', async () => {
    const server = await startServer((args) => (args[1] === 'bad' ? '-ERR no\r\n' : '+OK\r\n'));
    try {
      const client = await connect(urlFor(server.port));
      const bad = client.call('GET', 'bad');
      const good = client.call('GET', 'fine');
      await assert.rejects(() => bad, /ERR no/);
      assert.equal(await good, 'OK');
      client.close();
    } finally {
      await server.close();
    }
  });

  test('超时 ⇒ reject，不是永远挂着', async () => {
    const server = await startServer(() => undefined); // 一个字都不回
    try {
      const client = await connect(urlFor(server.port), { timeoutMs: 80 });
      await assert.rejects(() => client.call('PING'), /超时/);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('服务端断开 ⇒ 在飞的命令 reject', async () => {
    const server = await startServer((_args, socket) => {
      setImmediate(() => socket.destroy());
      return undefined;
    });
    try {
      const client = await connect(urlFor(server.port));
      await assert.rejects(() => client.call('PING'), /断开/);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('连不上的端口 ⇒ connect reject', async () => {
    // 端口 1 在测试环境里没有任何东西在听
    await assert.rejects(() => connect('redis://127.0.0.1:1', { timeoutMs: 300 }));
  });

  test('★ close 之后再 call 立刻 reject（不是静默成功）', async () => {
    const server = await startServer(() => '+PONG\r\n');
    try {
      const client = await connect(urlFor(server.port));
      client.close();
      await assert.rejects(() => client.call('PING'), /关闭/);
      client.close(); // 幂等，再来一次也不抛
    } finally {
      await server.close();
    }
  });

  test('协议坏了（服务端回了一堆垃圾）⇒ reject，不当成数据', async () => {
    const server = await startServer(() => '乱码乱码\r\n');
    try {
      const client = await connect(urlFor(server.port));
      await assert.rejects(() => client.call('PING'), /Redis/);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('target 上有解析出来的地址（但不能拿去打印——里面可能有口令）', async () => {
    const server = await startServer(() => '+PONG\r\n');
    try {
      const client = await connect(`redis://:pw@127.0.0.1:${server.port}/2`);
      assert.equal(client.target.host, '127.0.0.1');
      assert.equal(client.target.port, server.port);
      assert.equal(client.target.db, 2);
      client.close();
    } finally {
      await server.close();
    }
  });

  test('默认超时是个正数', () => {
    assert.ok(DEFAULT_TIMEOUT_MS > 0);
  });
});
