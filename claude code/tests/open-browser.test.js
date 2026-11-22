// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openBrowser } from '../src/platform/open-browser.js';

// ───────────────────────────── 夹具 ─────────────────────────────

const URL_ = 'http://127.0.0.1:1234/abc/';
const WIN_CMD = 'C:\\Windows\\system32\\cmd.exe';

/**
 * 假 `spawn`：记下每次调用，下一个 tick 触发 `spawn`（或 `error`）。
 *
 * ⚠️ **必须异步触发**——`openBrowser` 的整个"等 spawn"逻辑就活在
 * "`spawn()` 返回了但事件还没来"那一小段时间里。同步触发的话，
 * 那段时间根本不存在，等于什么都没测。
 *
 * @param {{ failWhen?: (call: { command: string, args: string[] }) => string | null }} [opts]
 */
function fakeSpawn(opts = {}) {
  /** @type {{ command: string, args: string[], options: any, unrefd?: boolean }[]} */
  const calls = [];

  const impl = (/** @type {string} */ command, /** @type {string[]} */ args, /** @type {any} */ options) => {
    const call = { command, args, options };
    calls.push(call);

    /** @type {Record<string, ((...a: any[]) => void)[]>} */
    const handlers = { spawn: [], error: [] };
    const child = {
      pid: 4242,
      unref() {
        call.unrefd = true;
      },
      once(/** @type {string} */ ev, /** @type {any} */ fn) {
        (handlers[ev] ??= []).push(fn);
        return child;
      },
      removeListener(/** @type {string} */ ev, /** @type {any} */ fn) {
        handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn);
        return child;
      },
    };

    setImmediate(() => {
      const boom = opts.failWhen ? opts.failWhen(call) : null;
      if (boom !== null) {
        for (const f of handlers.error ?? []) f(Object.assign(new Error(boom), { code: 'ENOENT' }));
      } else {
        for (const f of handlers.spawn ?? []) f();
      }
    });
    return child;
  };

  return { calls, impl };
}

/**
 * 跑一次 `openBrowser()`，依赖全部注入。
 *
 * ★ `findExecutable` 默认回 `null`（**不搜 PATH**）——否则跑测的这台机器上
 *   恰好装了什么就会让断言漂移。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts.platform]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {string} [opts.home]
 * @param {string[]} [opts.files] 磁盘上"存在"的路径
 * @param {Record<string, string>} [opts.onPath] PATH 查找结果
 * @param {(call: { command: string, args: string[] }) => string | null} [opts.failWhen]
 */
function run(url, opts = {}) {
  const sp = fakeSpawn({ failWhen: opts.failWhen });
  const files = new Set(opts.files ?? []);
  const onPath = new Map(Object.entries(opts.onPath ?? {}));
  const promise = openBrowser(url, {
    platform: opts.platform ?? 'win32',
    env: opts.env ?? {},
    home: opts.home ?? '',
    deps: {
      spawn: /** @type {any} */ (sp.impl),
      isFile: (p) => files.has(p),
      findExecutable: (n) => onPath.get(n) ?? null,
    },
  });
  return { calls: sp.calls, promise };
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('★★ Windows 兜底：那个空的 "" 是标题位', () => {
  test('★★ 没有 Chrome/Edge 时走 cmd，且命令里**空的 "" 标题位在**', async () => {
    const { calls, promise } = run(URL_, { env: { COMSPEC: WIN_CMD } });
    const r = await promise;

    assert.equal(r.ok, true);
    assert.equal(r.via, 'default');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, WIN_CMD);
    // ★★ 这个数组就是整条控制线：少了 `""`，`start` 会把 URL 当标题，
    //    什么都不会打开，而退出码还是 0——静默失败里最难查的一种。
    assert.deepEqual(calls[0].args, ['/d', '/s', '/c', `"start "" "${URL_}""`]);
    assert.equal(calls[0].options.windowsVerbatimArguments, true);
  });

  test('★★ 那条命令是**一整条字符串**，没有被拆成多个参数', async () => {
    const { calls, promise } = run(URL_, { env: { COMSPEC: WIN_CMD } });
    await promise;
    // `cmd /c` 对后面那串是"先剥首尾引号再分词"：拆开传必然被切碎
    assert.equal(calls[0].args.length, 4);
    assert.ok(calls[0].args[3].startsWith('"'), '整条命令要自带最外层引号（配合 /s）');
    assert.ok(calls[0].args[3].endsWith('"'));
  });

  test('★ `%COMSPEC%` 缺失时退回裸 `cmd.exe`', async () => {
    const { calls, promise } = run(URL_, { env: {} });
    await promise;
    assert.equal(calls[0].command, 'cmd.exe');
  });

  test('★ `COMSPEC` 大小写不敏感（真机上常写作 `ComSpec`）', async () => {
    const { calls, promise } = run(URL_, { env: { ComSpec: 'D:\\cmd.exe' } });
    await promise;
    assert.equal(calls[0].command, 'D:\\cmd.exe');
  });

  test('★ 非 Windows 平台**绝不**走 cmd', async () => {
    for (const platform of ['darwin', 'linux', 'freebsd']) {
      const { calls, promise } = run(URL_, { platform: /** @type {any} */ (platform) });
      await promise;
      assert.notEqual(calls[0].command, 'cmd.exe', `${platform} 上不该出现 cmd`);
      assert.equal(calls[0].options.windowsVerbatimArguments, false);
    }
  });
});

describe('★★ 三平台的确切 argv', () => {
  test('★★ Windows + Chrome → `<chrome.exe> --app=<url>`（**不过 shell**）', async () => {
    const chrome = 'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    const { calls, promise } = run(URL_, {
      env: { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local', COMSPEC: WIN_CMD },
      files: [chrome],
    });
    const r = await promise;

    assert.deepEqual(r, { ok: true, via: 'app', browser: 'chrome', exe: chrome, reason: '' });
    assert.equal(calls[0].command, chrome);
    assert.deepEqual(calls[0].args, [`--app=${URL_}`]);
    // ★ 有绝对路径就**直接 spawn**，不经过 cmd——绕开一整套引号戏法
    assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
  });

  test('★★ macOS + Chrome → `/Applications/.../Google Chrome --app=<url>`', async () => {
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const { calls, promise } = run(URL_, { platform: 'darwin', files: [chrome] });
    const r = await promise;

    assert.equal(r.via, 'app');
    assert.equal(r.browser, 'chrome');
    assert.equal(calls[0].command, chrome);
    assert.deepEqual(calls[0].args, [`--app=${URL_}`]);
  });

  test('★★ macOS 没找到 → `open <url>`（只有 URL 一个参数）', async () => {
    const { calls, promise } = run(URL_, { platform: 'darwin' });
    const r = await promise;

    assert.equal(r.via, 'default');
    assert.equal(calls[0].command, 'open');
    assert.deepEqual(calls[0].args, [URL_]);
  });

  test('★★ Linux + Chrome → `google-chrome --app=<url>`', async () => {
    const { calls, promise } = run(URL_, {
      platform: 'linux',
      onPath: { 'google-chrome': '/usr/bin/google-chrome' },
    });
    const r = await promise;

    assert.equal(r.via, 'app');
    assert.equal(calls[0].command, '/usr/bin/google-chrome');
    assert.deepEqual(calls[0].args, [`--app=${URL_}`]);
  });

  test('★★ Linux 没找到 → `xdg-open <url>`', async () => {
    const { calls, promise } = run(URL_, { platform: 'linux' });
    const r = await promise;

    assert.equal(r.via, 'default');
    assert.equal(calls[0].command, 'xdg-open');
    assert.deepEqual(calls[0].args, [URL_]);
  });

  test('★ 认不出的平台 → 退 `xdg-open`（不是"什么都不做"）', async () => {
    const { calls, promise } = run(URL_, { platform: /** @type {any} */ ('freebsd') });
    const r = await promise;
    assert.equal(r.ok, true);
    assert.equal(calls[0].command, 'xdg-open');
  });

  test('★ 三个平台都是 detached + stdio:ignore + unref', async () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const { calls, promise } = run(URL_, { platform: /** @type {any} */ (platform), env: {} });
      await promise;
      assert.equal(calls[0].options.detached, true, platform);
      assert.equal(calls[0].options.stdio, 'ignore', platform);
      assert.equal(calls[0].unrefd, true, `${platform}：不 unref 会吊住事件循环`);
    }
  });
});

describe('★★ 两档：应用窗口起不来要往下退', () => {
  test('★★ 找到 Chrome 但 spawn 失败 → 退回默认浏览器，并说明为什么', async () => {
    const chrome = 'C:\\chrome.exe';
    const { calls, promise } = run(URL_, {
      env: { COMSPEC: WIN_CMD },
      onPath: { chrome },
      // 只有应用窗口那一条失败；默认浏览器那条照常
      failWhen: (c) => (c.args[0]?.startsWith('--app=') ? 'ENOENT: 被杀软拦了' : null),
    });
    const r = await promise;

    assert.equal(r.ok, true, '应用窗口开不出来**不该**是致命错误');
    assert.equal(r.via, 'default');
    assert.equal(calls.length, 2, '两条都试过');
    assert.equal(calls[1].command, WIN_CMD);
    assert.match(r.reason, /应用窗口起不来/);
  });

  test('★★ 两档都失败 → `ok:false`，**不抛**', async () => {
    const { promise } = run(URL_, {
      env: { COMSPEC: WIN_CMD },
      failWhen: () => 'ENOENT: 没有这个命令',
    });
    const r = await promise;

    assert.equal(r.ok, false);
    assert.equal(r.via, null);
    assert.match(r.reason, /ENOENT/);
  });

  test('★ 失败时四个字段一个不少（调用方不用做 undefined 检查）', async () => {
    const { promise } = run(URL_, { failWhen: () => 'boom' });
    const r = await promise;
    assert.deepEqual(Object.keys(r).sort(), ['browser', 'exe', 'ok', 'reason', 'via']);
  });
});

describe('★ 候选优先级', () => {
  test('★ Chrome 排在 Edge 前面：两个都在时用 Chrome', async () => {
    const chrome = 'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const { calls, promise } = run(URL_, {
      env: {
        LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        COMSPEC: WIN_CMD,
      },
      files: [chrome, edge],
    });
    const r = await promise;

    assert.equal(r.browser, 'chrome');
    assert.equal(calls[0].command, chrome);
  });

  test('★ Chrome 自己的第三条才命中，也不会被 Edge 抢走', async () => {
    const chrome = 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const { calls, promise } = run(URL_, {
      env: {
        LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
        PROGRAMFILES: 'C:\\Program Files',
        'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        COMSPEC: WIN_CMD,
      },
      // ★ Edge 的第一条候选和 Chrome 的第三条在**同一个变量**下——顺序表说了算
      files: [chrome, edge],
    });
    const r = await promise;

    assert.equal(r.browser, 'chrome');
    assert.equal(calls[0].command, chrome);
  });

  test('★ 只有 Edge 时用 Edge（64 位 Edge 的历史位置在 `PROGRAMFILES(X86)`）', async () => {
    const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
    const { calls, promise } = run(URL_, {
      env: { 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', COMSPEC: WIN_CMD },
      files: [edge],
    });
    const r = await promise;

    assert.equal(r.browser, 'edge');
    assert.equal(calls[0].command, edge);
  });

  test('★ macOS 的 `~/Applications` 靠**注入的 home** 展开', async () => {
    const chrome = '/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const { calls, promise } = run(URL_, { platform: 'darwin', home: '/Users/x', files: [chrome] });
    const r = await promise;

    assert.equal(r.browser, 'chrome');
    assert.equal(calls[0].command, chrome);
  });

  test('★ `home` 没给时 `~/` 候选**直接跳过**，不猜', async () => {
    const chrome = '/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    // home 空着，但文件"存在"——不能因为磁盘上有就当成自己的家目录
    const { calls, promise } = run(URL_, { platform: 'darwin', files: [chrome] });
    const r = await promise;

    assert.equal(r.via, 'default', '展开不了就该退，而不是拼一个 `undefined/...` 出来');
    assert.equal(calls[0].command, 'open');
  });
});

describe('★★ URL 白名单', () => {
  test('★★ 含 `&` 的 URL 直接拒，**一个子进程都不 spawn**', async () => {
    const { calls, promise } = run('http://127.0.0.1:1/a&calc.exe', { env: { COMSPEC: WIN_CMD } });
    const r = await promise;

    assert.equal(r.ok, false);
    assert.equal(calls.length, 0, '拒掉的 URL 绝不能走到 spawn');
  });

  test('★ 非 http/https 一律拒', async () => {
    for (const bad of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'vbscript:x', 'ftp://x/']) {
      const { calls, promise } = run(bad, { env: { COMSPEC: WIN_CMD } });
      const r = await promise;
      assert.equal(r.ok, false, bad);
      assert.equal(calls.length, 0, bad);
    }
  });

  test('★ 空白、引号、`%`、反斜杠、管道符一律拒', async () => {
    for (const bad of ['http://a b/', 'http://a"b/', "http://a'b/", 'http://a%b/', 'http://a\\b/', 'http://a|b/']) {
      const { calls, promise } = run(bad, { env: { COMSPEC: WIN_CMD } });
      const r = await promise;
      assert.equal(r.ok, false, bad);
      assert.equal(calls.length, 0, bad);
    }
  });

  test('★★ 控制字符天然进不来——白名单是**正向**的，不用写 `U+0000` 的转义', async () => {
    // ★ 那个字节在运行时构造：本仓库里**写出** `U+0000` 的转义会被落成一个
    //   真的裸 NUL 字节，等于测试自己制造了一个要测的东西。
    const NUL = String.fromCharCode(0);
    for (const bad of [`http://a${NUL}b/`, 'http://a\nb/', 'http://a\tb/']) {
      const { calls, promise } = run(bad, { env: { COMSPEC: WIN_CMD } });
      const r = await promise;
      assert.equal(r.ok, false, JSON.stringify(bad));
      assert.equal(calls.length, 0, JSON.stringify(bad));
    }
  });

  test('★ 正常 URL 照过（端口、路径、查询串都在白名单里）', async () => {
    for (const good of [
      'http://127.0.0.1:1234/abc/',
      'https://example.com/a/b.html?x=1',
      'http://localhost:1/',
    ]) {
      const { promise } = run(good, { platform: 'darwin' });
      assert.equal((await promise).ok, true, good);
    }
  });
});

