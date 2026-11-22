// @ts-check
/**
 * `platform/open-path.js` —— 「在文件管理器里打开这个目录」。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这份文件守的是什么
 *
 * 1. **★★ 不过 shell**。`&` `|` `"` `^` 这些字符在命令行里有含义，
 *    在这里必须只是**文件名的一部分**。判据是 argv 的长度和内容
 *    **逐字**对得上——多一个参数、少一个引号都算破。
 * 2. **三平台的确切命令**。Windows 是 `explorer.exe`，**不是** `cmd start`。
 *    这条与 `open-browser.js` 故意不同：开 URL 没有可直接执行的入口，
 *    开目录有。少一层 shell 就少一类能出错的地方。
 * 3. **★★ 探针在 spawn 之前**。不存在的路径不该去拉起一个文件管理器——
 *    那样失败的原因是"路径不对"还是"文件管理器起不来"就混在一起了。
 * 4. **★ 这个函数从不抛错**。所有失败都是 `{ok:false, reason}`。
 * ─────────────────────────────────────────────────────────────
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { openPath } from '../src/platform/open-path.js';

// ───────────────────────────── 夹具 ─────────────────────────────

/**
 * 假 `spawn`：记下每次调用，下一个 tick 触发 `spawn`（或 `error`）。
 *
 * ⚠️ **必须异步触发**——`openPath()` 的整个"等 spawn"逻辑就活在
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
      pid: 4343,
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
 * 跑一次 `openPath()`，依赖全部注入。
 *
 * ★ `probe` 默认回 `'dir'`（**不碰磁盘**）——这条测试要证的是"命令发对了"，
 *   不是"这台机器的磁盘上有这个目录"。
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts.platform]
 * @param {import('../src/platform/open-path.js').PathKind | 'throw'} [opts.kind]
 *   探针结果；`'throw'` 用不上（探针自己吞异常），留着只为可读
 * @param {(call: { command: string, args: string[] }) => string | null} [opts.failWhen]
 */
function run(dir, opts = {}) {
  const sp = fakeSpawn({ failWhen: opts.failWhen });
  const kind = opts.kind ?? 'dir';
  const promise = openPath(dir, {
    platform: opts.platform ?? 'win32',
    deps: {
      spawn: /** @type {any} */ (sp.impl),
      probe: () => /** @type {any} */ (kind),
    },
  });
  return { promise, calls: sp.calls };
}

// ═══════════════════════ 三平台的确切命令 ═══════════════════════

describe('open-path —— 三平台', () => {
  test('★★ Windows 是 `explorer.exe <目录>`，**不是** `cmd start`', () => {
    const { promise, calls } = run('C:\\work\\client-a', { platform: 'win32' });
    return promise.then((r) => {
      assert.deepEqual(r, { ok: true, reason: '' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, 'explorer.exe');
      // ★★ 长度必须是 1：一旦哪天有人把 `cmd /c start "" <目录>` 抄回来，
      //    这里当场变红——而那正是 `open-browser.js` 里那个"空字符串标题位"
      //    的坑，开目录**不需要**踩。
      assert.deepEqual(calls[0].args, ['C:\\work\\client-a']);
      assert.equal(calls[0].options?.windowsVerbatimArguments, undefined,
        '开了 windowsVerbatimArguments 就等于绕过了 Node 的加引号');
    });
  });

  test('macOS 是 `open <目录>`', async () => {
    const { promise, calls } = run('/Users/x/work', { platform: 'darwin' });
    assert.deepEqual(await promise, { ok: true, reason: '' });
    assert.equal(calls[0].command, 'open');
    assert.deepEqual(calls[0].args, ['/Users/x/work']);
  });

  test('Linux（及其余一切）是 `xdg-open <目录>`', async () => {
    for (const platform of /** @type {NodeJS.Platform[]} */ (['linux', 'freebsd', 'openbsd'])) {
      const { promise, calls } = run('/home/x/work', { platform });
      assert.deepEqual(await promise, { ok: true, reason: '' });
      assert.equal(calls[0].command, 'xdg-open', `${platform} 走错了命令`);
      assert.deepEqual(calls[0].args, ['/home/x/work']);
    }
  });

  test('★ `detached` + `stdio:ignore`，而且 `unref()` 过（不吊住事件循环）', async () => {
    const { promise, calls } = run('C:\\work');
    await promise;
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.stdio, 'ignore');
    assert.equal(calls[0].unrefd, true, '没 unref，控制台会被文件管理器吊着不退出');
  });
});

// ═══════════════════════ ★★ 不过 shell ═══════════════════════

describe('open-path —— 一个字节都不进 shell', () => {
  test('★★ 带元字符的路径**原样**是一个 argv，不是几条命令', async () => {
    // 这些字符在 cmd / sh 里全都有含义。这里它们必须只是文件名的一部分。
    const nasty = 'C:\\a & calc.exe | "quoted" ^ %PATH% > out';
    const { promise, calls } = run(nasty);
    assert.deepEqual(await promise, { ok: true, reason: '' });
    assert.equal(calls[0].args.length, 1, '被切成了多个参数 —— 有东西在分词');
    assert.equal(calls[0].args[0], nasty, '路径被改写了');
    // ★ 命令本身是常量，路径只出现在 argv 里——所以注入面为零。
    assert.equal(calls[0].command, 'explorer.exe');
  });
});

// ═══════════════════════ 探针在 spawn 之前 ═══════════════════════

describe('open-path —— 路径先验，再 spawn', () => {
  test('★★ 目录不存在 → `ok:false`，而且**根本没有 spawn**', async () => {
    const { promise, calls } = run('C:\\nope', { kind: 'missing' });
    const r = await promise;
    assert.equal(r.ok, false);
    assert.match(r.reason, /不存在/);
    assert.equal(calls.length, 0, '探针失败了还去拉文件管理器 —— 失败原因就混了');
  });

  test('★ 是个文件不是目录 → 说清楚是**哪一种**，同样不 spawn', async () => {
    const { promise, calls } = run('C:\\a.txt', { kind: 'file' });
    const r = await promise;
    assert.equal(r.ok, false);
    assert.match(r.reason, /不是目录/);
    assert.equal(calls.length, 0);
  });

  test('★ 空路径 / 纯空白 → 不 spawn', async () => {
    for (const bad of ['', '   ', null, undefined, 42]) {
      const { promise, calls } = run(/** @type {any} */ (bad));
      const r = await promise;
      assert.equal(r.ok, false, `这个输入不该成功：${String(bad)}`);
      assert.equal(calls.length, 0);
    }
  });

  test('★★ 带控制字符的路径 → 不 spawn（spawn 会为此抛 ERR_INVALID_ARG_VALUE）', async () => {
    // ★ 控制字符在**运行时**造出来，源码里不写那个转义——本仓库里写出 NUL 的
    //   转义序列会**落成真的控制字节**，于是这行测试自己就成了卫生违规项。
    const withNul = `C:\\a${String.fromCharCode(0)}b`;
    const withNewline = `C:\\a${String.fromCharCode(10)}b`;
    for (const bad of [withNul, withNewline]) {
      const { promise, calls } = run(bad);
      const r = await promise;
      assert.equal(r.ok, false);
      assert.match(r.reason, /控制字符/);
      assert.equal(calls.length, 0, '控制字符喂进 spawn 会把异常抛到进程外面');
    }
  });
});

// ═══════════════════════ 失败不是异常 ═══════════════════════

describe('open-path —— 从不抛错', () => {
  test('★ 命令不存在（ENOENT）→ `ok:false`，不是 reject', async () => {
    const { promise } = run('C:\\work', { failWhen: () => 'spawn explorer.exe ENOENT' });
    const r = await promise; // 抛了的话这里就红了
    assert.equal(r.ok, false);
    assert.match(r.reason, /ENOENT/);
  });

  test('★ `spawn` 自己同步抛（参数非法等）→ 也收敛成 `ok:false`', async () => {
    const r = await openPath('C:\\work', {
      platform: 'win32',
      deps: {
        probe: () => 'dir',
        spawn: /** @type {any} */ (() => { throw new TypeError('boom'); }),
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /boom/);
  });
});
