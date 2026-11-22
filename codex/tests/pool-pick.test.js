// @ts-check
/**
 * `pool-pick.js`：启动前从池里挑一个 token（§2.15 三）。
 *
 * ─────────────────────────────────────────────────────────────
 * 这一层的每条断言都对应一条**不能错**的性质：
 *
 * | 断言 | 错了会怎样 |
 * |---|---|
 * | 该出场时才出场 | 绑定被静默盖掉；或"没有任何 token"的报错把池挡在门外 |
 * | 新鲜 `ok` 时 0 次请求 | 每次启动都白花一次钱 |
 * | 挑完**再解析一次** | 名字换了，凭证/端点还是"没有 token"时的那份 |
 * | `lastPick` 的键是**挑选前**的 cwd | 下一次 `-c` 找不到它，静默开新会话 |
 * | `-c` 找不到记录就报错 | 用户以为在续，其实断了 |
 * | 失败列表只有名字与状态 | 密钥从错误信息里漏出去 |
 *
 * ⚠️ 全部在临时 home 里跑，`globalThis.fetch` 被打桩——**不碰真配置、不发真请求**。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CxtError } from '../src/core/errors.js';
import { configPath, poolPath, tokensDir } from '../src/core/paths.js';
import { STATUS } from '../src/core/pool.js';
import { pickFromPool } from '../src/cli/pool-pick.js';
import { resolveSession } from '../src/cli/session.js';

const BASE = 'https://pick.example.com/v1';

/** @type {string[]} */
const homes = [];
after(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});

/**
 * 造一个隔离的 home（外加一个 `work/` 当 cwd——`findProjectConfig` 要能 readdir）。
 * @param {{ tokens?: Record<string, any>, pool?: any | ((home: string) => any), config?: any }} [f]
 */
function mkHome(f = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cxt-pick-'));
  homes.push(home);
  fs.mkdirSync(tokensDir(home), { recursive: true });
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });

  for (const [name, over] of Object.entries(f.tokens ?? {})) {
    const body = { name, baseUrl: BASE, authToken: secretOfName(name), ...over };
    fs.writeFileSync(path.join(tokensDir(home), `${name}.json`), JSON.stringify(body), 'utf8');
  }
  if (f.pool !== undefined) {
    // `pool` 可以是 (home) => object：`lastPick` 的键得是这个 home 的目录
    const body = typeof f.pool === 'function' ? f.pool(home) : f.pool;
    fs.writeFileSync(poolPath(home), JSON.stringify(body), 'utf8');
  }
  if (f.config !== undefined) {
    fs.writeFileSync(configPath(home), JSON.stringify({ version: 1, ...f.config }), 'utf8');
  }
  return home;
}

/** 假密钥：带连字符，不会被仓库卫生测试当成真 key */
function secretOfName(name) {
  return `sk-test-${name}-aaaa`;
}

/** @param {string} home */
function ctxOf(home) {
  return {
    platform: /** @type {const} */ ('linux'),
    home,
    env: {},
    cwd: path.join(home, 'work'),
    isTTY: false,
    stdinIsTTY: false,
    configPath: null,
  };
}

/** @param {Partial<import('../src/core/pool.js').PoolEntry>} [over] */
function entry(over = {}) {
  return { status: STATUS.UNKNOWN, detail: '', checkedAt: '', calls: 0, in: 0, out: 0, ...over };
}

/** @param {Record<string, any>} entries */
function poolOf(entries, extra = {}) {
  return { version: 1, updatedAt: '', redis: '', rr: 0, lastPick: {}, entries, ...extra };
}

const nowIso = () => new Date().toISOString();
const oldIso = () => new Date(Date.now() - 3600_000).toISOString();

/**
 * 打桩 `fetch`：按 `Authorization` 里的密钥选路由。
 *
 * 路由值是 `{status, body}`；没配的默认 500——**测试里不该有"意外的 200"**。
 * @param {Record<string, {status: number, body?: string}>} routes
 */
function stubFetch(routes) {
  /** @type {{url: string, key: string, body: any}[]} */
  const calls = [];
  const prev = globalThis.fetch;
  // @ts-expect-error 测试桩不需要完整的 fetch 签名
  globalThis.fetch = async (url, init) => {
    const auth = String(init?.headers?.Authorization ?? '');
    const key = auth.replace(/^Bearer\s+/i, '');
    calls.push({ url: String(url), key, body: JSON.parse(String(init?.body ?? '{}')) });
    const r = routes[key] ?? { status: 500, body: 'no route' };
    return { status: r.status, text: async () => r.body ?? '' };
  };
  return {
    calls,
    restore: () => { globalThis.fetch = prev; },
  };
}

/** @param {string} home */
function readPoolFile(home) {
  return JSON.parse(fs.readFileSync(poolPath(home), 'utf8'));
}

/**
 * 跑一次挑选。
 * @param {object} f 见 `mkHome()`
 * @param {{ argv?: any, opts?: any, notify?: string[] }} [o]
 */
async function pick(f, o = {}) {
  const home = mkHome(f);
  const ctx = ctxOf(home);
  const argv = o.argv ?? {};
  const resolved = resolveSession(ctx, argv, 'run');
  const opts = { ...(o.opts ?? {}) };
  if (o.notify !== undefined) opts.notify = (line) => o.notify.push(line);
  const result = await pickFromPool(ctx, resolved, argv, opts);
  return { home, ctx, resolved, result };
}

// ───────────────────────────── 该不该出场 ─────────────────────────────

describe('出场条件：补空位 / --pool', () => {
  test('★ 已有 token 就不接管（池不是"总是重挑"）', async () => {
    const { result } = await pick(
      { tokens: { pinned: {}, alpha: {} }, pool: poolOf({ alpha: entry({ status: STATUS.OK, checkedAt: nowIso() }) }) },
      { argv: { token: 'pinned' } },
    );
    assert.equal(result, null);
  });

  test('没有 token + 池里有条目 → 补上空位', async () => {
    const { result } = await pick({
      tokens: { alpha: {} },
      pool: poolOf({ alpha: entry({ status: STATUS.OK, checkedAt: nowIso() }) }),
    });
    assert.equal(result.resolved.token.value, 'alpha');
  });

  test('没有 token 但池是空的 → 什么也不做（照旧走没 token 的老路）', async () => {
    const { result } = await pick({ tokens: { alpha: {} } });
    assert.equal(result, null);
  });

  test('auto:false 关掉补空位；但 --pool 仍然有效（强制优先于配置）', async () => {
    const f = {
      tokens: { alpha: {} },
      pool: poolOf({ alpha: entry({ status: STATUS.OK, checkedAt: nowIso() }) }),
      config: { defaults: { pool: { auto: false } } },
    };
    assert.equal((await pick(f)).result, null);

    const forced = await pick(f, { argv: { pool: true } });
    assert.equal(forced.result.resolved.token.value, 'alpha');
  });

  test('--pool 覆盖显式 token / 绑定：挑的是池里的人', async () => {
    const { result } = await pick(
      { tokens: { pinned: {}, alpha: {} }, pool: poolOf({ alpha: entry({ status: STATUS.OK, checkedAt: nowIso() }) }) },
      { argv: { token: 'pinned', pool: true } },
    );
    assert.equal(result.resolved.token.value, 'alpha');
    // @ts-expect-error 来历是字符串常量
    assert.equal(result.resolved.token.source, 'pool');
  });

  test('--pool 但池是空的 → 报错（不是静默不挑：用户明确要求了）', async () => {
    await assert.rejects(
      () => pick({ tokens: { alpha: {} } }, { argv: { pool: true } }),
      (err) => err instanceof CxtError && /池里还没有条目/.test(err.message),
    );
  });

  test('条目的 token 文件都不在了（孤立条目）→ 等于空池', async () => {
    const { result } = await pick({ pool: poolOf({ ghost: entry({ status: STATUS.OK, checkedAt: nowIso() }) }) });
    assert.equal(result, null);
  });
});

// ───────────────────────────── 花不花钱 ─────────────────────────────

describe('探测的花费：新鲜就不探，遇到第一个 ok 就停', () => {
  test('★ 新鲜的 ok → 0 次请求', async () => {
    const f = stubFetch({});
    try {
      const { result } = await pick({
        tokens: { alpha: {}, beta: {} },
        pool: poolOf({
          alpha: entry({ status: STATUS.OK, checkedAt: nowIso(), in: 5 }),
          beta: entry({ status: STATUS.OK, checkedAt: nowIso(), in: 1 }),
        }),
      });
      // 按用量升序：beta 在前
      assert.equal(result.resolved.token.value, 'beta');
      assert.equal(f.calls.length, 0);
    } finally {
      f.restore();
    }
  });

  test('★ 一个 402、一个 200 → 挑第二个，只发两次请求', async () => {
    /** @type {string[]} */
    const lines = [];
    const f = stubFetch({
      [secretOfName('alpha')]: { status: 402, body: 'insufficient_user_quota' },
      [secretOfName('beta')]: { status: 200, body: '{}' },
    });
    try {
      const { home, result } = await pick(
        {
          tokens: { alpha: {}, beta: {} },
          pool: poolOf({ alpha: entry(), beta: entry() }),
        },
        { notify: lines },
      );
      assert.equal(result.resolved.token.value, 'beta');
      assert.deepEqual(f.calls.map((c) => c.key), [secretOfName('alpha'), secretOfName('beta')]);
      assert.equal(f.calls[0].url, `${BASE}/responses`);

      const saved = readPoolFile(home);
      assert.equal(saved.entries.alpha.status, STATUS.NO_QUOTA);
      assert.equal(saved.entries.beta.status, STATUS.OK);
      assert.notEqual(saved.entries.beta.checkedAt, '');

      // 进度行只有位置与名字，没有密钥
      assert.equal(lines.length, 2);
      assert.match(lines[0], /1\/2.*alpha/);
      assert.ok(!lines.join('\n').includes(secretOfName('alpha')));
    } finally {
      f.restore();
    }
  });

  test('★ 新鲜但非 ok 的条目**不重探**（TTL 不是摆设）', async () => {
    const f = stubFetch({});
    try {
      await assert.rejects(
        () => pick({
          tokens: { alpha: {} },
          pool: poolOf({ alpha: entry({ status: STATUS.OTHER, checkedAt: nowIso() }) }),
        }),
        (err) => err instanceof CxtError && /池里的 token 这次都不能用/.test(err.message)
          && /异常/.test(String(err.hint)),
      );
      assert.equal(f.calls.length, 0);
    } finally {
      f.restore();
    }
  });

  test('--model 会带进探测请求体', async () => {
    const f = stubFetch({ [secretOfName('alpha')]: { status: 200, body: '{}' } });
    try {
      await pick({ tokens: { alpha: {} }, pool: poolOf({ alpha: entry() }) }, { argv: { pool: true, model: 'probe-x' } });
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].body.model, 'probe-x');
    } finally {
      f.restore();
    }
  });
});

// ───────────────────────────── 全 失 败 ─────────────────────────────

describe('一个都不成', () => {
  test('★ 报错列出每个名字与原因，且**不含密钥**（网关回显也不许漏）', async () => {
    const f = stubFetch({
      [secretOfName('alpha')]: { status: 401, body: `invalid api key: ${secretOfName('alpha')}` },
      [secretOfName('beta')]: { status: 500, body: 'upstream boom' },
    });
    try {
      await assert.rejects(
        () => pick({ tokens: { alpha: {}, beta: {} }, pool: poolOf({ alpha: entry(), beta: entry() }) }),
        (err) => {
          assert.ok(err instanceof CxtError);
          assert.match(err.message, /池里的 token 这次都不能用/);
          assert.match(String(err.hint), /alpha：密钥无效/);
          assert.match(String(err.hint), /beta：异常/);
          assert.ok(!String(err.hint).includes('sk-test-'), '密钥从错误信息里漏出去了');
          return true;
        },
      );
    } finally {
      f.restore();
    }
  });

  test('全是 no_quota / invalid → 一次请求都不发，直接说清楚', async () => {
    const f = stubFetch({});
    try {
      await assert.rejects(
        () => pick({
          tokens: { alpha: {}, beta: {} },
          pool: poolOf({
            alpha: entry({ status: STATUS.NO_QUOTA, checkedAt: nowIso() }),
            beta: entry({ status: STATUS.INVALID, checkedAt: nowIso() }),
          }),
        }),
        (err) => err instanceof CxtError && /没有可用的 token/.test(err.message)
          && /alpha：无余额/.test(err.message) && /beta：密钥无效/.test(err.message),
      );
      assert.equal(f.calls.length, 0);
    } finally {
      f.restore();
    }
  });
});

// ───────────────────────────── `-c` 守卫 ─────────────────────────────

describe('`-c`：续接必须用同一个 token', () => {
  test('没有 lastPick → 报错（两个出路），一次请求都不发', async () => {
    const f = stubFetch({});
    try {
      await assert.rejects(
        () => pick({ tokens: { alpha: {} }, pool: poolOf({ alpha: entry() }) }, { argv: { resume: true } }),
        (err) => err instanceof CxtError && /-c/.test(err.message)
          && /cxt run <token> -c/.test(String(err.hint)),
      );
      assert.equal(f.calls.length, 0);
    } finally {
      f.restore();
    }
  });

  test('记得的那个已经无余额 → 报错，不偷偷换一个', async () => {
    const f = stubFetch({});
    try {
      await assert.rejects(
        () => pick(
          {
            tokens: { alpha: {}, beta: {} },
            pool: (home) => poolOf(
              {
                alpha: entry({ status: STATUS.NO_QUOTA, checkedAt: nowIso() }),
                beta: entry({ status: STATUS.OK, checkedAt: nowIso() }),
              },
              { lastPick: { [path.join(home, 'work')]: 'alpha' } },
            ),
          },
          { argv: { resume: true } },
        ),
        (err) => err instanceof CxtError && /alpha/.test(err.message) && /无余额/.test(err.message),
      );
      assert.equal(f.calls.length, 0);
    } finally {
      f.restore();
    }
  });

  test('记得的那个新鲜 ok → 沿用它，哪怕别人更省', async () => {
    const f = stubFetch({});
    try {
      const { result } = await pick(
        {
          tokens: { alpha: {}, beta: {} },
          pool: (home) => poolOf(
            {
              alpha: entry({ status: STATUS.OK, checkedAt: nowIso(), in: 999 }),
              beta: entry({ status: STATUS.OK, checkedAt: nowIso() }),
            },
            { lastPick: { [path.join(home, 'work')]: 'alpha' } },
          ),
        },
        { argv: { resume: true } },
      );
      assert.equal(result.resolved.token.value, 'alpha');
      assert.equal(f.calls.length, 0);
    } finally {
      f.restore();
    }
  });

  test('记得的那个过期了 → 探**它**（不探别人）', async () => {
    const f = stubFetch({ [secretOfName('alpha')]: { status: 200, body: '{}' } });
    try {
      const { result } = await pick(
        {
          tokens: { alpha: {}, beta: {} },
          pool: (home) => poolOf(
            { alpha: entry({ status: STATUS.OK, checkedAt: oldIso() }), beta: entry() },
            { lastPick: { [path.join(home, 'work')]: 'alpha' } },
          ),
        },
        { argv: { resume: true } },
      );
      assert.equal(result.resolved.token.value, 'alpha');
      assert.deepEqual(f.calls.map((c) => c.key), [secretOfName('alpha')]);
    } finally {
      f.restore();
    }
  });
});

// ───────────────────────────── 挑完之后 ─────────────────────────────

describe('挑完之后：再解析一次 + 记账', () => {
  test('★★ 凭证/端点/profile 都是**挑中那个**的真值（不是只改了名字）', async () => {
    const { resolved: before, result } = await pick({
      tokens: { alpha: {} },
      pool: poolOf({ alpha: entry({ status: STATUS.OK, checkedAt: nowIso() }) }),
    });
    // 挑之前：没有 token ⇒ 凭证与端点两格都是空的
    assert.equal(before.token.value, null);
    assert.deepEqual(before.missing, ['authToken', 'baseUrl', 'model']);

    assert.equal(result.resolved.token.value, 'alpha');
    assert.equal(result.resolved.authToken.value, secretOfName('alpha'));
    assert.equal(result.resolved.baseUrl.value, BASE);
    assert.equal(result.resolved.profileName, 'alpha');
    // ★ 池只补 token 这一格：凭证与端点跟着它一起有了，**模型不在它的职责里**
    assert.deepEqual(result.resolved.missing, ['model']);
    assert.match(result.note, /alpha/);
  });

  test('★★ lastPick 的键是**挑选前**的 cwd（不是 token.cwd 改出来的那个）', async () => {
    const home0 = mkHome({ tokens: { alpha: {} } });
    const other = path.join(home0, 'elsewhere');
    const { home, result } = await pick({
      tokens: { alpha: { cwd: other } },
      pool: poolOf({ alpha: entry({ status: STATUS.OK, checkedAt: nowIso() }) }),
    });
    // 选中之后，token.cwd 确实生效了……
    assert.equal(result.resolved.cwd.value, other);

    // ……但 lastPick 记的是启动那一刻算出来的目录（下一次 -c 会重新算出同一个）
    const saved = readPoolFile(home);
    assert.equal(saved.lastPick[path.join(home, 'work')], 'alpha');
    assert.equal(saved.lastPick[other], undefined);
  });

  test('挑成功才推进 rr 游标；失败不推', async () => {
    const ok = await pick({
      tokens: { alpha: {} },
      pool: poolOf({ alpha: entry({ status: STATUS.OK, checkedAt: nowIso() }) }, { rr: 7 }),
    });
    assert.equal(readPoolFile(ok.home).rr, 8);

    const f = stubFetch({});
    try {
      const home = mkHome({ tokens: { alpha: {} }, pool: poolOf({ alpha: entry() }, { rr: 7 }) });
      const ctx = ctxOf(home);
      await assert.rejects(() => pickFromPool(ctx, resolveSession(ctx, {}, 'run'), {}));
      assert.equal(readPoolFile(home).rr, 7);
    } finally {
      f.restore();
    }
  });

  test('不落盘就没有文件：只读的判定不该写盘（auto:false 时连 pool.json 都不碰）', async () => {
    const home = mkHome({
      tokens: { alpha: {} },
      pool: poolOf({ alpha: entry({ status: STATUS.OK, checkedAt: nowIso() }) }),
      config: { defaults: { pool: { auto: false } } },
    });
    const before = fs.readFileSync(poolPath(home), 'utf8');
    const ctx = ctxOf(home);
    const r = await pickFromPool(ctx, resolveSession(ctx, {}, 'run'), {});
    assert.equal(r, null);
    assert.equal(fs.readFileSync(poolPath(home), 'utf8'), before);
  });
});
