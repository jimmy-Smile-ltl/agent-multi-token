// @ts-check
/**
 * ★ `cxt profile` 的端到端测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这份文件守的是什么
 *
 * `profile path` 是**唯一一个刻意不 `requireToken` 的命令**，而这不是偷懒：
 * token 文件被删了、目录还在，**恰恰是最需要它的时候**（§3.3：`token rm` 默认保留目录）。
 * 所以第一条要守的就是"token 没了它照样工作"。
 *
 * 第二条是 `profile path` 的输出**必须是一行干净的路径**。它生来就是给
 * `cd "$(cxt profile path relay-a)"` 和管道用的——多一行"ℹ 目录已创建于…"
 * 就把它毁了。这条不靠"读代码时注意"，靠**逐字符比对**。
 *
 * 第三条是孤儿 profile 的那句实话：**没有 CLI 出口**。`token rm --purge`
 * 会先 `requireToken`，token 文件已经没了就过不去。所以 `profile ls` 必须给出
 * **手工删除的准确命令**，并先列清楚会丢掉什么——而不是指一条走不通的路。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ROOT = win32Path.dirname(dirname(fileURLToPath(import.meta.url)));
const CXT = win32Path.join(ROOT, 'bin', 'cxt.js');

/** 长名基准（`os.tmpdir()` 给的是 8.3 短名，见 token-e2e 的说明） */
const TMP_BASE = nodeFs.realpathSync.native(tmpdir());

const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了 */ }
  }
});

/**
 * @param {{ config?: any, tokens?: Record<string, any>,
 *           profiles?: Record<string, { toml?: string, codexData?: string[] }> }} [opts]
 */
function setup(opts = {}) {
  const home = nodeFs.mkdtempSync(join(TMP_BASE, 'cxt-profile-'));
  TEMP_HOMES.push(home);
  const appDir = join(home, '.codex-multi-token');
  nodeFs.mkdirSync(join(appDir, 'tokens'), { recursive: true });

  nodeFs.writeFileSync(join(appDir, 'config.json'),
    `${JSON.stringify(opts.config ?? { version: 1, defaults: {}, bindings: [] }, null, 2)}\n`, 'utf8');

  for (const [name, obj] of Object.entries(opts.tokens ?? {})) {
    nodeFs.writeFileSync(join(appDir, 'tokens', `${name}.json`),
      `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  }

  for (const [name, spec] of Object.entries(opts.profiles ?? {})) {
    const dir = join(appDir, 'profiles', name);
    nodeFs.mkdirSync(dir, { recursive: true });
    if (spec.toml !== undefined) nodeFs.writeFileSync(join(dir, 'config.toml'), spec.toml, 'utf8');
    for (const f of spec.codexData ?? []) {
      // `sessions` 这类是目录，其余是文件
      if (f === 'sessions') {
        nodeFs.mkdirSync(join(dir, 'sessions'), { recursive: true });
        nodeFs.writeFileSync(join(dir, 'sessions', 'rollout-1.jsonl'), '{"n":1}\n', 'utf8');
      } else {
        nodeFs.writeFileSync(join(dir, f), '{}\n', 'utf8');
      }
    }
  }

  return {
    home,
    appDir,
    profileDir: (n) => join(appDir, 'profiles', n),
    /**
     * @param {string[]} extra
     */
    run(extra) {
      const r = spawnSync(process.execPath, [CXT, 'profile', ...extra], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home, NO_COLOR: '1' },
        cwd: ROOT,
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },
  };
}

// ═══════════════════ path ═══════════════════

describe('cxt profile path —— 只打印一行，方便 cd 进去', () => {
  test('★★ 输出是**一行干净的路径**，没有任何装饰', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } } });
    const r = s.run(['path', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(r.out, `${s.profileDir('relay-a')}\n`,
      '★ 多一行说明文字就毁了 `cd "$(cxt profile path x)"` 这个用法');
    assert.equal(r.err, '', '这条命令连 stderr 都不该有输出');
  });

  test('★★ token 文件已删、目录还在 → **照样工作**（这恰恰是最需要它的时候）', () => {
    const s = setup({
      profiles: { ghost: { toml: '[projects.\'D:\\work\\x\']\ntrust_level = "trusted"\n' } },
      // tokens/ 是空的——`cxt token rm` 的默认结果（§3.3）
    });
    const r = s.run(['path', 'ghost']);

    assert.equal(r.code, 0, `stderr:\n${r.err}——`+'`requireToken` 在这里会把它拦死，而它正是排查孤儿 profile 的入口');
    assert.equal(r.out, `${s.profileDir('ghost')}\n`);
  });

  test('目录还不存在也照常给路径（命令是纯计算，不建任何东西）', () => {
    const s = setup({ tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } } });
    const r = s.run(['path', 'relay-a']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.profileDir('relay-a')), false, '★ `profile path` 绝不该建目录');
  });

  test('`_default` 单独放行（它是"纯 defaults 模式"的 profile 名，不是 token 名，§2.3）', () => {
    const s = setup();
    const r = s.run(['path', '_default']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(r.out, `${s.profileDir('_default')}\n`);
  });

  test('★ 路径穿越的名字被拒（§2.8：名字非法与不存在是两回事）', () => {
    const s = setup();
    for (const bad of ['../etc', 'a/b', '..']) {
      const r = s.run(['path', bad]);
      assert.equal(r.code, 1, `${bad} 该被拒`);
      assert.equal(r.out, '', '拒了就不该往 stdout 写东西——那会被 `cd` 吃掉');
    }
  });

  test('缺参数 → 退出 1，并指路 profile ls', () => {
    const s = setup();
    const r = s.run(['path']);
    assert.equal(r.code, 1);
    assert.match(r.err, /缺少 token 名/);
    assert.match(r.err, /profile ls/);
  });

  test('--json 的形状：目录 + config.toml + Codex 数据清单', () => {
    const s = setup({
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } },
      profiles: {
        'relay-a': {
          toml: '[projects.\'D:\\work\\x\']\ntrust_level = "trusted"\n',
          codexData: ['auth.json', 'sessions'],
        },
      },
    });
    const r = s.run(['path', 'relay-a', '--json']);
    const j = JSON.parse(r.out);

    assert.equal(j.token, 'relay-a');
    assert.equal(j.profile, 'relay-a');
    assert.equal(j.dir, s.profileDir('relay-a'));
    assert.equal(j.exists, true);
    assert.equal(j.configToml, join(s.profileDir('relay-a'), 'config.toml'));
    assert.equal(j.configExists, true);
    assert.deepEqual(j.codexData, ['auth.json', 'sessions']);
  });

  test('`_default` 在 --json 里 token 是 null（它不是 token）', () => {
    const s = setup();
    const j = JSON.parse(s.run(['path', '_default', '--json']).out);
    assert.equal(j.token, null);
    assert.equal(j.profile, '_default');
  });
});

// ═══════════════════ ls ═══════════════════

describe('cxt profile ls —— 有哪些 profile、谁是孤儿', () => {
  test('一个 profile 都没有时说清楚它**什么时候**才会出现（§3.2 惰性）', () => {
    const s = setup();
    const r = s.run(['ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /还没有任何 profile 目录/);
    assert.match(r.out, /惰性|绝不预建/);
  });

  test('列出 profile，并标出 token 还在不在', () => {
    const s = setup({
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } },
      profiles: {
        'relay-a': { toml: '[projects.\'D:\\work\\x\']\ntrust_level = "trusted"\n' },
      },
    });
    const r = s.run(['ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /relay-a/);
    assert.match(r.out, /1 条/, '该报出信任记录条数');
  });

  test('★★ 孤儿 profile 要给**手工删除的准确命令**，并先列清会丢什么', () => {
    const s = setup({
      profiles: {
        ghost: { toml: '[projects.\'D:\\work\\x\']\ntrust_level = "trusted"\n', codexData: ['auth.json', 'sessions'] },
      },
    });
    const r = s.run(['ls']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /孤儿/);
    assert.match(r.out, /auth\.json/, '删之前先看清会丢什么');
    assert.match(r.out, /不可恢复/);
    assert.match(r.out, /token rm --purge/,
      '要说明为什么 CLI 到不了这里——否则用户会去敲那条命令然后困惑');

    const expected = IS_WIN
      ? `Remove-Item -Recurse -Force '${s.profileDir('ghost')}'`
      : `rm -rf '${s.profileDir('ghost')}'`;
    assert.ok(r.out.includes(expected), `该给出这条命令：\n    ${expected}\n实际输出：\n${r.out}`);
  });

  test('★ 平台不同 → 删除命令的语法也不同（别在 PowerShell 里教人 `rm -rf`）', () => {
    const s = setup({ profiles: { ghost: {} } });
    const r = s.run(['ls']);
    if (IS_WIN) {
      assert.match(r.out, /Remove-Item -Recurse -Force/);
      assert.equal(/rm -rf/.test(r.out), false);
    } else {
      assert.match(r.out, /rm -rf/);
      assert.equal(/Remove-Item/.test(r.out), false);
    }
  });

  test('★ 孤儿也要给出**第二条**出路：建回来再 purge', () => {
    const s = setup({ profiles: { ghost: {} } });
    const r = s.run(['ls']);
    assert.match(r.out, /cxt token add ghost/);
    assert.match(r.out, /--purge/);
  });

  test('★ `profile ls` 是只读的——跑完一个文件都不许变', () => {
    const s = setup({
      profiles: {
        ghost: { toml: '[projects.\'D:\\work\\x\']\ntrust_level = "trusted"\n', codexData: ['auth.json'] },
      },
    });
    const before = nodeFs.readFileSync(join(s.profileDir('ghost'), 'config.toml'), 'utf8');
    const listing = nodeFs.readdirSync(s.profileDir('ghost')).sort();

    s.run(['ls']);
    s.run(['ls', '--json']);

    assert.equal(nodeFs.readFileSync(join(s.profileDir('ghost'), 'config.toml'), 'utf8'), before);
    assert.deepEqual(nodeFs.readdirSync(s.profileDir('ghost')).sort(), listing);
  });

  test('--json：profiles / orphans / total', () => {
    const s = setup({
      tokens: { 'relay-a': { name: 'relay-a', authToken: 'sk-a' } },
      profiles: {
        'relay-a': { toml: '[projects.\'D:\\work\\x\']\ntrust_level = "trusted"\n' },
        ghost: {},
      },
    });
    const r = s.run(['ls', '--json']);
    const j = JSON.parse(r.out);

    assert.equal(j.total, 2);
    assert.deepEqual(j.orphans, ['ghost']);
    const a = j.profiles.find((/** @type {any} */ p) => p.profile === 'relay-a');
    assert.equal(a.orphan, false);
    assert.equal(a.tokenExists, true);
    assert.equal(a.trustCount, 1);
    assert.equal(a.configExists, true);
  });

  test('★ 一个 profile 的表读不出来，不影响其余的显示', () => {
    const s = setup({
      profiles: {
        broken: { toml: '[projects.\'D:\\work\\x\']\ntrust_level = "trusted"\n\n[projects.\'D:\\work\\x\']\ntrust_level = "untrusted"\n' },
        ok: { toml: '[projects.\'D:\\work\\y\']\ntrust_level = "trusted"\n' },
      },
    });
    const r = s.run(['ls']);

    assert.equal(r.code, 0, '一个坏掉不该让整个 ls 失败');
    assert.match(r.out, /读不出/);
    assert.match(r.out, /ok/);
  });

  test('页脚要写明 cxt 只碰 config.toml 的受管区（§3.1）', () => {
    const s = setup({ profiles: { 'relay-a': {} } });
    const r = s.run(['ls']);
    assert.match(r.out, /auth\.json/);
    assert.match(r.out, /不碰|一律/);
  });
});

// ═══════════════════ 分发 ═══════════════════

describe('cxt profile —— 分发与帮助', () => {
  test('没有子命令 → 打帮助，退出 0', () => {
    const s = setup();
    const r = s.run([]);
    assert.equal(r.code, 0);
    assert.match(r.out, /cxt profile path/);
    assert.match(r.out, /孤儿/);
  });

  test('--help → 退出 0', () => {
    const s = setup();
    const r = s.run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /CODEX_HOME/);
  });

  test('未知子命令 → 退出 1，并列出可用的', () => {
    const s = setup();
    const r = s.run(['nope']);
    assert.equal(r.code, 1);
    assert.match(r.err, /未知子命令/);
    assert.match(r.err, /path/);
    assert.match(r.err, /ls/);
  });
});
