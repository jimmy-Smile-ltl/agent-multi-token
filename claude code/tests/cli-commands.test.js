// @ts-check
/**
 * §5 命令面的端到端（`--json` 是断言载体，§5）。
 *
 * 与 `cli-resolve.test.js` 的分工：那个文件验**只读**的解析链，所以共用一份夹具；
 * 本文件里的命令**会改盘**（写 config / token / 删 profile），共用夹具会互相污染，
 * 于是每个用例都开一份**全新的假 home**（`makeHome()`），用完即删。
 *
 * 隔离手段同前：`os.homedir()` 在 Windows 读 `USERPROFILE`、在 POSIX 读 `HOME`，
 * 两个都设上，子进程就落进临时夹具里，碰不到真实配置。
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/cmt.js', import.meta.url));

/** 全部临时夹具，after 里统一清掉 */
const ROOTS = /** @type {string[]} */ ([]);

after(() => {
  for (const r of ROOTS) rmSync(r, { recursive: true, force: true });
});

/**
 * 开一份全新的假 home。
 *
 * @param {{ config?: any, tokens?: Record<string, any> }} [seed]
 */
function makeHome(seed = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cmt-cmd-'));
  ROOTS.push(root);
  const home = join(root, 'home');
  const app = join(home, '.claude-multi-token');
  mkdirSync(join(app, 'tokens'), { recursive: true });
  mkdirSync(join(root, 'work', 'a'), { recursive: true });
  mkdirSync(join(root, 'work', 'b'), { recursive: true });

  const w = (/** @type {string} */ p, /** @type {unknown} */ o) =>
    writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`, 'utf8');

  w(join(app, 'config.json'), {
    version: 1,
    defaults: { models: [{ id: 'g-1' }, { id: 'g-2' }] },
    bindings: [],
    ...seed.config,
  });
  for (const [name, tok] of Object.entries(seed.tokens ?? {})) {
    w(join(app, 'tokens', `${name}.json`), { name, ...tok });
  }

  return {
    root,
    home,
    app,
    workA: join(root, 'work', 'a'),
    workB: join(root, 'work', 'b'),
    /** 跑一次 cmt（在 `cwd` 目录里） */
    run(/** @type {string[]} */ argv, /** @type {{ cwd?: string, env?: Record<string, string> }} */ opts = {}) {
      try {
        const stdout = execFileSync(process.execPath, [BIN, ...argv], {
          encoding: 'utf8',
          cwd: opts.cwd ?? root,
          env: { ...process.env, HOME: home, USERPROFILE: home, ...opts.env },
        });
        return { code: 0, stdout, stderr: '' };
      } catch (err) {
        const e = /** @type {any} */ (err);
        return { code: e.status ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
      }
    },
    /** 跑一次并断言成功，返回解析后的 JSON */
    json(/** @type {string[]} */ argv, /** @type {any} */ opts) {
      const r = this.run([...argv, '--json'], opts);
      assert.equal(r.code, 0, `期望退出码 0，实际 ${r.code}\n${r.stderr}`);
      return JSON.parse(r.stdout);
    },
    /** 读回配置 */
    config() {
      return JSON.parse(readFileSync(join(app, 'config.json'), 'utf8'));
    },
    token(/** @type {string} */ name) {
      return JSON.parse(readFileSync(join(app, 'tokens', `${name}.json`), 'utf8'));
    },
    profile(/** @type {string} */ name) {
      return join(app, 'profiles', name);
    },
  };
}

// ───────────────────────────── token ─────────────────────────────

describe('cmt token —— 增删改查', () => {
  test('add 落盘到 tokens/<name>.json，且只落这一处', () => {
    const h = makeHome();
    const r = h.run(['token', 'add', 'relay-a', '--token', 'sk-aaaa11112222', '--base-url', 'https://x.example.com']);
    assert.equal(r.code, 0, r.stderr);

    assert.equal(h.token('relay-a').authToken, 'sk-aaaa11112222');
    assert.equal(h.token('relay-a').baseUrl, 'https://x.example.com');
    // §2.7：token 只有一个落盘点——别在 profile 目录里多出第二份明文
    assert.equal(existsSync(h.profile('relay-a')), false);
  });

  test('add 重名 → 退出码 1，且给下一步', () => {
    const h = makeHome({ tokens: { dup: { authToken: 'sk-x' } } });
    const r = h.run(['token', 'add', 'dup', '--token', 'sk-y']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /已存在/);
    assert.match(r.stderr, /token edit dup/);
  });

  test('★ 非法 token 名（路径穿越）→ 退出码 1', () => {
    const h = makeHome();
    for (const bad of ['../evil', 'a/b', 'a\\b', 'C:', 'A-B', '']) {
      const r = h.run(['token', 'add', bad, '--token', 'sk-x']);
      assert.equal(r.code, 1, `"${bad}" 不该被接受`);
    }
    // 一个都没落盘
    assert.equal(existsSync(join(h.app, 'tokens', 'evil.json')), false);
  });

  test('show 打码，不泄漏明文', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-secret-abcdefgh1234' } } });
    const r = h.run(['token', 'show', 'relay']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /sk-secret-abcdefgh1234/, '明文不该出现在输出里');
    assert.match(r.stdout, /sk-\*\*\*\*1234/);
  });

  test('引用型的 authToken 不打码，改印「引用，值在环境变量里」（§2.4）', () => {
    const h = makeHome({ tokens: { relay: { authToken: '${MY_KEY}' } } });
    const r = h.run(['token', 'show', 'relay']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\$\{MY_KEY\}（引用，值在环境变量里）/);
    assert.doesNotMatch(r.stdout, /\*/, '引用不是秘密，不该被打码');
  });

  test('引用型的 baseUrl 同样标注（端点也走 ${VAR}）', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x', baseUrl: '${MY_URL}' } } });
    const r = h.run(['token', 'show', 'relay']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\$\{MY_URL\}（引用，值在环境变量里）/);
  });

  test('★ 宽松正则的回归守卫：${1BAD} 不是引用，别显示成"引用"', () => {
    // 曾经的 displayAuth 就地写了 /^\$\{[^}]+\}$/，把 ${1BAD} 也认成引用——
    // 而它在启动时必然报错（ENV_REF_RE 要求标识符）。显示成"引用"等于向用户
    // 保证一件 cmt 不会兑现的事。现在收敛到共享的 parseEnvRef。
    const h = makeHome({ tokens: { relay: { authToken: '${1BAD}' } } });
    const r = h.run(['token', 'show', 'relay']);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /引用/);
    assert.doesNotMatch(r.stdout, /\$\{1BAD\}/, '非法写法该按密钥打码，不该原样印');
  });

  test('★ edit 改凭证但**不动 profile 目录**（§2.5：换钥匙不换身份）', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-old-1111' } } });
    mkdirSync(h.profile('relay'), { recursive: true });

    const r = h.run(['token', 'edit', 'relay', '--token', 'sk-new-2222']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(h.token('relay').authToken, 'sk-new-2222');
    // profile 目录还在原处 —— 会话历史与 claude -c 才保得住
    assert.equal(existsSync(h.profile('relay')), true);
  });

  test('rm 默认**保留** profile（§3.3）', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x' } } });
    mkdirSync(h.profile('relay'), { recursive: true });

    const r = h.run(['token', 'rm', 'relay']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(join(h.app, 'tokens', 'relay.json')), false);
    assert.equal(existsSync(h.profile('relay')), true, 'profile 不该被删');
  });

  test('rm 被绑定时警告悬空引用，并列出是哪些路径（§3.3）', () => {
    const h = makeHome({
      config: { bindings: [{ path: join(process.cwd(), 'x'), token: 'relay' }] },
      tokens: { relay: { authToken: 'sk-x' } },
    });
    const r = h.run(['token', 'rm', 'relay']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /悬空/);
    assert.match(r.stdout, /x/, '该列出引用它的路径');
  });

  test('★ rm --purge 在非 TTY 下拒绝，且**一处都不动**', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x' } } });
    mkdirSync(h.profile('relay'), { recursive: true });

    const r = h.run(['token', 'rm', 'relay', '--purge']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--yes/);
    // 回归：曾经"先删 token 文件、再问确认"，于是拒绝之后 token 已经没了
    assert.equal(existsSync(join(h.app, 'tokens', 'relay.json')), true, 'token 文件不该被动');
    assert.equal(existsSync(h.profile('relay')), true, 'profile 不该被动');
  });

  test('rm --purge --yes 才真的连 profile 一起删', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x' } } });
    mkdirSync(join(h.profile('relay'), 'projects'), { recursive: true });

    const r = h.run(['token', 'rm', 'relay', '--purge', '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(join(h.app, 'tokens', 'relay.json')), false);
    assert.equal(existsSync(h.profile('relay')), false);
  });
});

// ───────────────────────────── bind ─────────────────────────────

describe('cmt bind —— 路径绑定', () => {
  test('新建绑定并落盘', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x' } } });
    const r = h.run(['bind', h.workA, '--token', 'relay', '--url', 'https://x.example.com']);
    assert.equal(r.code, 0, r.stderr);

    const b = h.config().bindings;
    assert.equal(b.length, 1);
    assert.equal(b[0].token, 'relay');
    assert.equal(b[0].baseUrl, 'https://x.example.com');
  });

  test('--model 可重复给，顺序即优先级', () => {
    const h = makeHome();
    h.run(['bind', h.workA, '--model', 'm-1:一号', '--model', 'm-2']);
    const b = h.config().bindings[0];
    assert.deepEqual(b.models, [{ id: 'm-1', label: '一号' }, { id: 'm-2' }]);
  });

  test('★ 同一路径再 bind 是**更新**而不是新增（归一化后比）', () => {
    const h = makeHome();
    h.run(['bind', h.workA, '--url', 'https://one.example.com']);
    h.run(['bind', h.workA, '--url', 'https://two.example.com']);
    const b = h.config().bindings;
    assert.equal(b.length, 1, '不该出现两条同路径绑定');
    assert.equal(b[0].baseUrl, 'https://two.example.com');
  });

  test('bind 到不存在的 token → 退出码 1', () => {
    const h = makeHome();
    const r = h.run(['bind', h.workA, '--token', 'ghost']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ghost/);
  });

  test('bind ls --json 给出归一化路径', () => {
    const h = makeHome();
    h.run(['bind', h.workA, '--url', 'https://x.example.com']);
    const j = h.json(['bind', 'ls']);
    assert.equal(j.bindings.length, 1);
    assert.ok(j.bindings[0].normalized, '该带上归一化后的串供对照（§2.9 三）');
  });

  test('bind rm 删得掉；删不存在的 → 退出码 1', () => {
    const h = makeHome();
    h.run(['bind', h.workA, '--url', 'https://x.example.com']);
    assert.equal(h.run(['bind', 'rm', h.workA]).code, 0);
    assert.equal(h.config().bindings.length, 0);
    assert.equal(h.run(['bind', 'rm', h.workA]).code, 1);
  });
});

// ───────────────────────────── model ─────────────────────────────

describe('cmt model —— 优先级列表与人工故障转移', () => {
  test('set --global 整份替换，顺序即优先级', () => {
    const h = makeHome();
    const r = h.run(['model', 'set', '--global', 'a:甲', 'b', 'c']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(h.config().defaults.models, [
      { id: 'a', label: '甲' },
      { id: 'b' },
      { id: 'c' },
    ]);
  });

  test('★ next 轮转一位：models[0] 移到末位', () => {
    const h = makeHome();
    const r = h.run(['model', 'next', '--global']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(h.config().defaults.models.map((/** @type {any} */ m) => m.id), ['g-2', 'g-1']);
  });

  test('★ 反复 next 能回到原点（轮转不丢项）', () => {
    const h = makeHome();
    h.run(['model', 'set', '--global', 'a', 'b', 'c']);
    for (let i = 0; i < 3; i++) h.run(['model', 'next', '--global']);
    assert.deepEqual(h.config().defaults.models.map((/** @type {any} */ m) => m.id), ['a', 'b', 'c']);
  });

  test('use 提拔到首位，其余保持相对顺序', () => {
    const h = makeHome();
    h.run(['model', 'set', '--global', 'a', 'b', 'c']);
    h.run(['model', 'use', '--global', 'c']);
    assert.deepEqual(h.config().defaults.models.map((/** @type {any} */ m) => m.id), ['c', 'a', 'b']);
  });

  test('use 一个不在列表里的 → 插到首位', () => {
    const h = makeHome();
    h.run(['model', 'use', '--global', 'zzz']);
    assert.deepEqual(h.config().defaults.models.map((/** @type {any} */ m) => m.id), ['zzz', 'g-1', 'g-2']);
  });

  test('★ next 在路径绑定上会**物化**继承来的列表（§2.5）', () => {
    const h = makeHome();
    // 只建绑定、不给它自己的 list → 它继承全局的 [g-1, g-2]
    h.run(['bind', h.workA, '--url', 'https://x.example.com']);
    assert.equal(h.config().bindings[0].models, undefined);

    const r = h.run(['model', 'next', '--path', h.workA]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(
      h.config().bindings[0].models.map((/** @type {any} */ m) => m.id),
      ['g-2', 'g-1'],
      '该把继承来的列表复制一份再轮转',
    );
  });

  test('★ next 在没有任何匹配绑定的路径上会自动建一条（§2.5）', () => {
    const h = makeHome();
    assert.equal(h.config().bindings.length, 0);
    const r = h.run(['model', 'next', '--path', h.workB]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(h.config().bindings.length, 1);
    assert.deepEqual(h.config().bindings[0].models.map((/** @type {any} */ m) => m.id), ['g-2', 'g-1']);
  });

  test('clear 删掉该层 → 回退上一层', () => {
    const h = makeHome();
    h.run(['model', 'set', '--global', 'a', 'b']);
    assert.equal(h.run(['model', 'clear', '--global']).code, 0);
    assert.equal(h.config().defaults.models, undefined);
  });

  test('只有 1 个模型时 next → 退出码 1 且说清为什么', () => {
    const h = makeHome({ config: { defaults: { models: [{ id: 'only' }] } } });
    const r = h.run(['model', 'next', '--global']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /只有 1 个/);
  });

  test('★ 互斥 flag 同时给 → 退出码 1（别猜用户想写哪层）', () => {
    const h = makeHome();
    assert.equal(h.run(['model', 'next', '--global', '--token', 'x']).code, 1);
    assert.equal(h.run(['model', 'next', '--global', '--path', h.workA]).code, 1);
    assert.equal(h.run(['model', 'next', '--token', 'x', '--path', h.workA]).code, 1);
  });

  test('model ls --json 标出来源层', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x', models: [{ id: 'own-1' }] } } });
    const j = h.json(['model', 'ls', 'relay']);
    assert.equal(j.source, 'token');
    assert.deepEqual(j.models.map((/** @type {any} */ m) => m.id), ['own-1']);
  });

  test('model ls 位置参数：存在的 token 名当 token，否则当路径', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x', models: [{ id: 'own-1' }] } } });
    assert.equal(h.json(['model', 'ls', 'relay']).source, 'token');
    assert.equal(h.json(['model', 'ls', h.workB]).source, 'defaults');
  });

  test('★ model ls <打错的 token 名> → 报错，而不是静默当路径', () => {
    // 回归：`loadToken()` 会先校验名字，路径里的分隔符会让它抛错，
    // 于是 `cmt model ls <路径>` 曾直接崩在"token 名非法"上。
    // 反过来也不能矫枉过正——"像 token 名但不存在"必须报错：
    // 静默按路径解析会拿当前目录的结果冒充你要看的那个 token。
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x' } } });
    const r = h.run(['model', 'ls', 'relay-typo']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /既不是 token 也不是目录/);
  });

  test('★ 不点名 token 时，token 由路径绑定决定（回归）', () => {
    // 回归：`resolveConfig()` 只按**已加载**的 token 分层，它自己不去读 token 文件。
    // 于是 `cmt model ls` 曾在绑定目录里报「三层都没声明 models」，
    // 而同一目录的 `cmt resolve` 却正确显示 `← token 自身`——同一件事两个答案。
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x', models: [{ id: 'own-1' }, { id: 'own-2' }] } } });
    // 绑定要指向夹具的真实路径，建好 home 才知道，所以这里补写一次
    const cfg = h.config();
    cfg.bindings = [{ path: h.workA, token: 'relay' }];
    writeFileSync(join(h.app, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const j = h.json(['model', 'ls'], { cwd: h.workA });
    assert.equal(j.source, 'token', `该从 token 层取，实际 ${j.source}`);
    assert.deepEqual(j.models.map((/** @type {any} */ m) => m.id), ['own-1', 'own-2']);
  });

  test('★ model ls --path <p> 认这个开关（回归）', () => {
    // 回归：`--path` 声明在 spec 里却没人读，`cmt model ls --path X` 静默按当前目录解析。
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x', models: [{ id: 'own-1' }] } } });
    const cfg = h.config();
    cfg.bindings = [{ path: h.workB, token: 'relay' }];
    writeFileSync(join(h.app, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const j = h.json(['model', 'ls', '--path', h.workB], { cwd: h.workA });
    assert.equal(j.source, 'token', `--path 该生效，实际 ${j.source}`);
    assert.deepEqual(j.models.map((/** @type {any} */ m) => m.id), ['own-1']);
  });

  test('位置参数给路径时同样吃到该路径的 token 层', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x', models: [{ id: 'own-1' }] } } });
    const cfg = h.config();
    cfg.bindings = [{ path: h.workB, token: 'relay' }];
    writeFileSync(join(h.app, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const j = h.json(['model', 'ls', h.workB], { cwd: h.workA });
    assert.equal(j.source, 'token');
  });
});

// ───────────────────────────── slot ─────────────────────────────

describe('cmt slot —— 别名槽', () => {
  test('set 写进目标层，未列出的槽仍由 models[0] 自动填（§2.5）', () => {
    const h = makeHome();
    const r = h.run(['slot', 'set', '--global', 'haiku=small-model']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(h.config().defaults.slots, { haiku: 'small-model' });
  });

  test('★ null 是**有效值**（= 该槽不注入），不是删除键', () => {
    const h = makeHome();
    h.run(['slot', 'set', '--global', 'fable=null']);
    assert.deepEqual(h.config().defaults.slots, { fable: null });
  });

  test('★ 物化：改一个槽不会把别的槽弄丢', () => {
    const h = makeHome({
      config: { defaults: { models: [{ id: 'g-1' }], slots: { opus: 'big', haiku: 'small' } } },
    });
    h.run(['slot', 'set', '--path', h.workA, 'subagent=mid']);
    assert.deepEqual(h.config().bindings[0].slots, { opus: 'big', haiku: 'small', subagent: 'mid' });
  });

  test('未知槽位 → 退出码 1，并列出可用槽位', () => {
    const h = makeHome();
    const r = h.run(['slot', 'set', 'nope=x']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /opus/);
    assert.match(r.stderr, /subagent/);
  });

  test('缺 = 号 → 退出码 1', () => {
    const h = makeHome();
    assert.equal(h.run(['slot', 'set', 'haiku']).code, 1);
  });

  test('空值 → 退出码 1（并提示 null 才是"不注入"）', () => {
    const h = makeHome();
    const r = h.run(['slot', 'set', 'haiku=']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /null/);
  });

  test('★ ls --json 区分「显式声明」与「自动填 models[0]」（§2.5 默认规则）', () => {
    const h = makeHome({
      config: { defaults: { models: [{ id: 'g-1' }, { id: 'g-2' }], slots: { haiku: 'small' } } },
    });
    const j = h.json(['slot', 'ls', '--global']);

    assert.equal(j.autoFill, 'g-1', '自动填充值就是 models[0]');
    assert.deepEqual(
      { value: j.slots.haiku.value, explicit: j.slots.haiku.explicit },
      { value: 'small', explicit: true },
    );
    assert.deepEqual(
      { value: j.slots.opus.value, explicit: j.slots.opus.explicit },
      { value: 'g-1', explicit: false },
      '没声明的槽该标成自动填，而不是冒充成你写的',
    );
    assert.equal(j.slots.opus.env, 'ANTHROPIC_DEFAULT_OPUS_MODEL');
  });

  test('★ ls 显式 null 与「没声明」是两回事，--json 里分得开', () => {
    const h = makeHome({
      config: { defaults: { models: [{ id: 'g-1' }], slots: { fable: null } } },
    });
    const j = h.json(['slot', 'ls', '--global']);
    assert.deepEqual(
      { value: j.slots.fable.value, explicit: j.slots.fable.explicit },
      { value: null, explicit: true },
      '显式 null = 不注入，和"没声明→自动填"必须能区分',
    );
    assert.equal(j.slots.opus.value, 'g-1', '别的槽照常自动填');
  });

  test('ls 只读——不建绑定、不改配置', () => {
    const h = makeHome();
    const before = JSON.stringify(h.config());
    assert.equal(h.run(['slot', 'ls', '--path', h.workB]).code, 0);
    assert.equal(JSON.stringify(h.config()), before, 'ls 不该写盘');
  });
});

// ─────────────── 项目本地层：写入目标跟着生效层走（§2.11 五）───────────────

/**
 * ★ 这一节守的是「**写到一个不生效的地方 = 命令静默失效**」（§6.2 宁可明确）。
 *
 * `cmt model next` 报"已轮转"、模型却纹丝不动，是这类 bug 唯一的症状——
 * 而它看起来完全正常。所以"写哪一层"必须跟着"哪一层生效"走，
 * 且这两件事**只准有一处判断**（`cli/target.js` 的 `pickWriteTarget`）。
 */
describe('★ 项目本地层：写入目标跟着生效层走（§2.11 五）', () => {
  /**
   * 在假 home 里造一个**真实**目录（可带一份 `.cmt.json`）。
   * ⚠️ 必须是真目录：发现走 `statSync().isFile()`（§2.11 一）。
   * @param {ReturnType<typeof makeHome>} h
   * @param {Record<string, any>} [files]
   * @param {string} [name]
   */
  function makeProj(h, files = {}, name = 'proj') {
    const dir = join(h.root, name);
    mkdirSync(dir, { recursive: true });
    for (const [f, body] of Object.entries(files)) {
      writeFileSync(join(dir, f), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    }
    return dir;
  }

  /** 读回项目文件（不存在会抛——所以"文件还在吗"另用 existsSync 断言） */
  const readProj = (/** @type {string} */ dir) =>
    JSON.parse(readFileSync(join(dir, '.cmt.json'), 'utf8'));

  /** 项目文件里的模型 id 列表 */
  const ids = (/** @type {any[]} */ models) => models.map((m) => m.id);

  test('★★ 项目文件声明了 models → `set --path` 写进**那个文件**，不碰绑定', () => {
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, token: 'relay-a', models: [{ id: 'p1' }] } });

    const r = h.run(['model', 'set', '--path', dir, 'n1', 'n2']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(ids(readProj(dir).models), ['n1', 'n2']);
    // ★ 写到了生效的那一层，就不该顺手建一条绑定出来
    assert.deepEqual(h.config().bindings, []);
    assert.match(r.stdout, /项目本地/, '回执要说清写到了哪一层');
  });

  test('★ 写项目文件时**保留其余键**（token / env / claudeArgs 一个都不能丢）', () => {
    const h = makeHome();
    const dir = makeProj(h, {
      '.cmt.json': {
        version: 1,
        token: 'relay-a',
        env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
        claudeArgs: ['--verbose'],
        models: [{ id: 'p1' }],
      },
    });

    assert.equal(h.run(['model', 'set', '--path', dir, 'n1']).code, 0);
    const f = readProj(dir);
    assert.equal(f.token, 'relay-a');
    assert.deepEqual(f.env, { CLAUDE_CODE_EFFORT_LEVEL: 'max' });
    assert.deepEqual(f.claudeArgs, ['--verbose']);
    assert.deepEqual(ids(f.models), ['n1']);
    assert.equal(f.version, 1);
  });

  test('★★ 产物里**不含 `configPath`**，且 cmt 自己写得回来（自洽回环）', () => {
    // `normalizeProjectConfig()` 的产物多一个 `configPath`（"这份是从哪读来的"），
    // 那不是文件字段。不剥掉就会把**本机绝对路径**写进用户的仓库，
    // 而且下一次读取会被自己的"未知字段"拒掉——自己把自己写坏。
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });

    assert.equal(h.run(['model', 'set', '--path', dir, 'n1']).code, 0);
    assert.equal('configPath' in readProj(dir), false, '★ configPath 不是文件字段');

    // 回环：写完之后还能读（读不回来就是上面那条漏了）
    const j = h.json(['model', 'ls', '--path', dir]);
    assert.deepEqual(ids(j.models), ['n1']);
  });

  test('★ `use` 走的是**项目本地那条链**：物化出来的就是项目本地当前生效的那份', () => {
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });

    const r = h.run(['model', 'use', '--path', dir, 'p2']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(ids(readProj(dir).models), ['p2', 'p1']);
  });

  test('★★ 项目文件**没**声明 models → 写入仍然落到绑定（那一层没说话）', () => {
    // 反向断言：不这么分的话，`model set --path` 会让项目文件**凭空开始管模型**——
    // 而它原本只声明了 token。
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, token: 'relay-a' } });

    const r = h.run(['model', 'set', '--path', dir, 'm1']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(ids(h.config().bindings[0].models), ['m1']);
    assert.equal(readProj(dir).models, undefined, '★ 项目文件不该被凭空加上 models');
  });

  test('★★ `ls` 与 `set` 的判据一致：来源标成项目本地，并指出是**哪一份**文件', () => {
    // ★ 回归守卫。曾经 `model ls` 不加载项目本地层（只有 `prepareSession` 那条路加载），
    //   于是同一个目录下 `cmt resolve` 说「项目本地」、`cmt model ls` 说「路径绑定」——
    //   两句话各自都对、合起来看不懂（本机实测踩到）。
    //   §2.11 一：「是哪一份赢了」必须印出来——用户的机器上可能有好几份（"最近优先"）。
    const h = makeHome({ config: { defaults: { models: [{ id: 'g-1' }] }, bindings: [] } });
    const dir = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });
    // 先让绑定上有一份**不同**的列表：判据错了就会拿到它
    assert.equal(h.run(['model', 'set', '--path', dir, 'b-1']).code, 0);
    assert.equal(h.run(['model', 'set', '--path', dir, 'p1', 'p2']).code, 0, '写回项目文件');

    const j = h.json(['model', 'ls', '--path', dir]);
    assert.equal(j.source, 'project');
    assert.equal(j.detail, join(dir, '.cmt.json'));
    assert.deepEqual(ids(j.models), ['p1', 'p2'], '★ 报的必须是**生效**的那份');
    assert.match(h.run(['model', 'ls', '--path', dir]).stdout, /项目本地/);
  });

  test('★★ `ls` 认项目本地那一层的 **token**（不止 models）——级联是整条的', () => {
    // 这条覆盖的是 `pickTokenName({ project })`：项目文件声明 token 时，
    // 它就压过绑定命中的那个。观察口是"models 落到哪个 token 上"——
    // 项目文件自己不声明 models，于是继承链往下走，走到**项目指定的**那个 token。
    const h = makeHome({
      config: {
        defaults: { models: [{ id: 'g-1' }] },
        bindings: [{ path: 'PLACEHOLDER', token: 'relay-b' }],
      },
      tokens: {
        'relay-a': { authToken: 'sk-a', baseUrl: 'https://a.example.com', models: [{ id: 'a-m' }] },
        'relay-b': { authToken: 'sk-b', baseUrl: 'https://b.example.com', models: [{ id: 'b-m' }] },
      },
    });
    const dir = makeProj(h, { '.cmt.json': { version: 1, token: 'relay-a' } });
    // 绑定路径要指向真目录，得建好之后再补
    const cfg = h.config();
    cfg.bindings[0].path = dir;
    writeFileSync(join(h.app, 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');

    const j = h.json(['model', 'ls', '--path', dir]);
    assert.deepEqual(ids(j.models), ['a-m'], '★ 项目本地的 token 赢过绑定的 token');
    assert.equal(j.source, 'token');
  });

  test('★★ `clear` 只删 models，**不删文件**、也不建绑定', () => {
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, token: 'relay-a', models: [{ id: 'p1' }] } });

    const r = h.run(['model', 'clear', '--path', dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(join(dir, '.cmt.json')), true, '★ 文件本身还在（它是用户的）');
    assert.equal(readProj(dir).token, 'relay-a', '★ 其余键一个都不许丢');
    assert.equal(readProj(dir).models, undefined);
    assert.deepEqual(h.config().bindings, []);
    assert.match(r.stdout, /项目本地/);
  });

  test('★★ 在**子目录**里跑 → 发现的是祖先那份，写回**那个文件**（不新建一份）', () => {
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });

    const r = h.run(['model', 'next', '--path', sub]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(join(sub, '.cmt.json')), false,
      '★ 不该在子目录里新建一份——那会让"最近优先"从此指向它');
    assert.deepEqual(ids(readProj(dir).models), ['p2', 'p1']);
  });

  test('★ 项目文件坏了 → 硬报错（不静默回退到绑定），且什么都不写', () => {
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, baseUrl: 'https://evil.example.com/v1' } });

    const r = h.run(['model', 'set', '--path', dir, 'm1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /baseUrl/);
    assert.deepEqual(h.config().bindings, [], '★ 报错了就什么都不该写');
  });

  // ── slots 是禁键：写入目标**不认**项目本地层（§2.11 二）────────────────

  test('★★ `slot set --path` **永远不写项目文件**（slots 是 `.cmt.json` 的禁键）', () => {
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'p1' }] } });

    const r = h.run(['slot', 'set', '--path', dir, 'haiku=deepseek-flash']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readProj(dir).slots, undefined, '★ 禁键不许被写进去（schema 也会拒）');
    assert.deepEqual(ids(readProj(dir).models), ['p1'], '★ 项目文件一个字节都不该动');
    // 落到绑定：这就是那条"路径目标不升级"的规则
    assert.equal(h.config().bindings[0].slots.haiku, 'deepseek-flash');
    assert.match(r.stdout, /路径绑定/);
  });

  test('★ 但 `slot ls` **读**的时候认项目本地层（§2.12 十：面板不配 slots，槽位仍走这条命令）', () => {
    // 写与读**故意不对称**：写不进项目文件，但"没列出的槽自动填 models[0]"里的那个
    // models[0] 必须是**真正生效**的那份——否则 `cmt slot ls` 会拿绑定的列表冒充它。
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'p1' }, { id: 'p2' }] } });
    assert.equal(h.run(['model', 'set', '--path', dir, 'b-1']).code, 0, '绑定上一份不同的');
    assert.equal(h.run(['model', 'set', '--path', dir, 'p1', 'p2']).code, 0, '写回项目文件');

    const j = h.json(['slot', 'ls', '--path', dir]);
    assert.equal(j.autoFill, 'p1', '★ 自动填的必须是生效的 models[0]，不是绑定的');
    assert.equal(j.slots.haiku.explicit, false);
  });

  // ── `--config`：全局 flag，压过 `--path` 的发现（§2.11 一）──────────────

  test('★★ `--config` 压过 `--path` 的发现：目标层是**它**，不是 `--path` 那份', () => {
    // ★ 给了 `--config` 就是"这一份才是我的项目配置"——于是**生效层**是它，
    //   写入目标自然得跟着它。不这么写的话，`cmt --config A model next` 会跑去改
    //   `--path` 那份（或 cwd 的绑定），而真正生效的是 A：正是 §2.11 五 要消灭的静默失效。
    //   两者一致时（多数情况）这条分支看不出来，所以它只能靠测试钉住，不能靠"显然"。
    const h = makeHome();
    const a = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'a-1' }, { id: 'a-2' }] } }, 'a');
    const b = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'b-1' }, { id: 'b-2' }] } }, 'b');

    const r = h.run(['model', 'next', '--path', a, '--config', join(b, '.cmt.json')]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(ids(readProj(b).models), ['b-2', 'b-1'], '★ 动的是 --config 那份');
    assert.deepEqual(ids(readProj(a).models), ['a-1', 'a-2'], '★ --path 那份一个字节都不该动');
    assert.deepEqual(h.config().bindings, []);
    assert.match(r.stdout, new RegExp(`项目本地 .*b`), '回执要指名是哪一份');
  });

  test('★ `--config` 生效时，`ls` 也照同一份算（读与写的判据只准有一处）', () => {
    const h = makeHome();
    const a = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'a-1' }] } }, 'a');
    const b = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'b-1' }, { id: 'b-2' }] } }, 'b');

    const j = h.json(['model', 'ls', '--path', a, '--config', join(b, '.cmt.json')]);
    assert.equal(j.source, 'project');
    assert.equal(j.detail, join(b, '.cmt.json'));
    assert.deepEqual(ids(j.models), ['b-1', 'b-2']);
  });

  test('★★ `--config` 指向不存在的文件 → 硬报错，**不静默回退**到按 `--path` 发现', () => {
    // 显式给了路径却悄悄用别的文件，是最难排查的一类静默失效（§2.11 一）。
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'p1' }] } });

    const r = h.run(['model', 'set', '--path', dir, '--config', join(h.root, 'nope', '.cmt.json'), 'm1']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /找不到项目本地配置/);
    assert.deepEqual(ids(readProj(dir).models), ['p1'], '★ 不能偷偷改 `--path` 那份');
    assert.deepEqual(h.config().bindings, [], '★ 也不能退化成建一条绑定');
  });

  test('★ `--config` 那份**没声明 models** → 不升级目标，落到绑定（与发现那条同判据）', () => {
    const h = makeHome();
    const dir = makeProj(h, { '.cmt.json': { version: 1, models: [{ id: 'p1' }] } });
    const other = makeProj(h, { '.cmt.json': { version: 1, token: 'relay-a' } }, 'other');

    const r = h.run(['model', 'set', '--path', dir, '--config', join(other, '.cmt.json'), 'm1']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(ids(h.config().bindings[0].models), ['m1']);
    assert.equal(readProj(other).models, undefined, '★ 它没说话，就别让它开始管模型');
    assert.deepEqual(ids(readProj(dir).models), ['p1'], '★ 生效的是 --config 那份，所以 --path 那份也不该动');
  });
});

// ───────────────────────────── profile ─────────────────────────────

describe('cmt profile', () => {
  test('path 打印 profile 目录，且不创建它（§3.2 惰性）', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x' } } });
    const j = h.json(['profile', 'path', 'relay']);
    assert.equal(j.dir, h.profile('relay'));
    assert.equal(j.initialized, false);
    assert.equal(existsSync(h.profile('relay')), false, '查询不该建目录');
  });

  test('_default 是保留名，可直接查（纯 defaults 模式的落点）', () => {
    const h = makeHome();
    const j = h.json(['profile', 'path', '_default']);
    assert.ok(j.dir.endsWith('_default'));
    assert.equal(j.token, null);
  });

  test('不存在的 token → 退出码 1', () => {
    const h = makeHome();
    assert.equal(h.run(['profile', 'path', 'ghost']).code, 1);
  });
});

// ───────────────────────────── doctor ─────────────────────────────

describe('cmt doctor', () => {
  test('★ 永远返回 0——它是诊断工具不是闸门', () => {
    // 这份 home 什么都没有：没 token、没绑定、四要素全缺。
    // 即便如此也不该"失败"——CI 里跑它不该因为本机没装 claude 就红。
    const h = makeHome({ config: { defaults: {} } });
    const r = h.run(['doctor']);
    assert.equal(r.code, 0, `doctor 不该非零退出\n${r.stderr}`);
    assert.match(r.stdout, /四要素/);
  });

  test('--json 结构完整，且覆盖 §5 要求的五类自检', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x' } } });
    const j = h.json(['doctor']);
    assert.ok(j.platform);
    assert.ok(j.node.version);
    const titles = j.groups.map((/** @type {any} */ g) => g.title).join('|');
    for (const k of ['node', 'claude', '终端', '四要素', '绑定']) {
      assert.match(titles, new RegExp(k), `缺少「${k}」这一类自检`);
    }
  });

  test('悬空绑定被检出（§5）', () => {
    const h = makeHome({
      config: { bindings: [{ path: '/nowhere/at/all', token: 'ghost' }] },
    });
    const j = h.json(['doctor']);
    const g = j.groups.find((/** @type {any} */ x) => x.title === '路径绑定');
    assert.ok(g.rows.some((/** @type {any} */ r) => r.level === 'bad'), '该报悬空');
    assert.match(g.notes.join('\n'), /ghost/);
  });

  test('四要素齐全时，这一组是 ✓', () => {
    const h = makeHome({
      config: {
        defaults: { authToken: 'sk-x', baseUrl: 'https://x.example.com', models: [{ id: 'm' }] },
      },
    });
    const j = h.json(['doctor', '--cwd', h.workA]);
    const g = j.groups.find((/** @type {any} */ x) => x.title.startsWith('四要素'));
    assert.ok(g.rows.some((/** @type {any} */ r) => r.mark === '✓'), g.rows.map((/** @type {any} */ r) => r.text).join('\n'));
  });

  /** 取「四要素」那一组里 model 那一行 */
  function modelRow(/** @type {any} */ j) {
    const g = j.groups.find((/** @type {any} */ x) => x.title.startsWith('四要素'));
    return g.rows.find((/** @type {any} */ r) => r.text.startsWith('model'));
  }

  test('★ 三层都没声明 models → 印「缺」，不能印「显式空」（回归）', () => {
    // 老 bug：`value.join() || '（显式空）'` 把「没声明」和「显式空」印成同一句话，
    // 于是这一行说"显式空"（合法）、下一行说"✗ 缺 model"（缺项），自相矛盾。
    const h = makeHome({ config: { defaults: {} } });
    const j = h.json(['doctor', '--cwd', h.workA]);
    const row = modelRow(j);
    assert.ok(row, '该有 model 这一行');
    assert.match(row.text, /缺/, `没声明该印「缺」，实际：${row.text}`);
    assert.doesNotMatch(row.text, /显式空/, `没声明不许印「显式空」，实际：${row.text}`);
  });

  test('★ 某层显式写了 models: [] → 印「显式空」，且四要素算齐全（回归）', () => {
    // §2.5 规则 3：显式空 = "不注入，用 Claude Code 自身默认"，是合法选择不是缺项。
    const h = makeHome({
      config: { defaults: { authToken: 'sk-x', baseUrl: 'https://x.example.com', models: [] } },
    });
    const j = h.json(['doctor', '--cwd', h.workA]);
    const row = modelRow(j);
    assert.match(row.text, /显式空/, `显式空该印「显式空」，实际：${row.text}`);

    const g = j.groups.find((/** @type {any} */ x) => x.title.startsWith('四要素'));
    assert.ok(
      g.rows.some((/** @type {any} */ r) => r.mark === '✓'),
      `显式空是合法状态，四要素该齐全：\n${g.rows.map((/** @type {any} */ r) => r.text).join('\n')}`,
    );
  });
});

// ───────────────────────────── run ─────────────────────────────

describe('cmt run —— 启动闸门与参数转发（§2.4 / §2.7 / §2.10）', () => {
  /**
   * 四要素齐全、且 claude 指向 node 本身。
   *
   * 指向 node 是为了**不依赖本机装没装 claude**：`locateClaude()` 对显式配置只查
   * `existsSync`，于是 `process.execPath` 永远命中。这样下面的用例在任何机器上
   * 都跑到"该跑到的那个闸门"，而不是先死在"找不到 claude"上。
   */
  const ready = () =>
    makeHome({
      config: { defaults: { claudeBin: process.execPath, models: [{ id: 'g-1' }, { id: 'g-2' }] } },
      tokens: { relay: { authToken: 'sk-aaaa11112222', baseUrl: 'https://x.example.com' } },
    });

  // 下面几条都带上 `--print`：闸门排在 `--print` 之前，所以断言的是同一件事，
  // 但万一哪天闸门被改坏，也只会打印而**不会真的弹出一个终端窗口**。
  // （`run()` 里的顺序：--token-value 拒绝 → userinfo 拒绝 → check.ok
  //   → unresolvedBlocker → … → --print）

  test('★ --token-value 被拒绝：凭证没法跨进程送进新窗口而不落盘（§2.7）', () => {
    const h = ready();
    const r = h.run(['run', 'relay', '--token-value', 'sk-secret9999', '--print']);

    assert.equal(r.code, 1);
    assert.match(r.stderr, /不支持 --token-value/);
    assert.match(r.stderr, /cmt exec --token-value/, '要给出下一步，不能只说"不行"');
    // 拒绝的理由是"落盘"，那就更不能把值本身回显出来
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /sk-secret9999/);
    // 一个字节都不该动
    assert.equal(existsSync(h.profile('relay')), false, '拦在启动前，profile 都不该建');
  });

  test('★ --url 带 userinfo 被拒绝：userinfo 就是凭证，内联进脚本等于落盘（§2.7）', () => {
    const h = ready();
    const r = h.run(['run', 'relay', '--url', 'https://user:hunter2@relay.example.com/v1', '--print']);

    assert.equal(r.code, 1);
    assert.match(r.stderr, /userinfo/);
    assert.match(r.stderr, /§2\.7/);
    assert.match(r.stderr, /cmt token edit|cmt exec --url/, '要给出不落盘的替代写法');
    // 拒绝的理由是"别把凭证写下来"，那就更不能把它回显出来
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /hunter2/);
    assert.equal(existsSync(h.profile('relay')), false, '拦在启动前，profile 都不该建');
  });

  test('★ 同样带 userinfo，但写成 ${VAR} 引用 → 放行（引用不是密钥）', (t) => {
    // 反向守卫：别把"带凭证的 URL"拦成"凡 URL 都拦"。引用串本身不含密钥，
    // 求值发生在新窗口里，磁盘上只留 ${...} 五个字符。
    const h = ready();
    const r = h.run(['run', 'relay', '--url', '${RELAY_URL}', '--print'], {
      env: { RELAY_URL: 'https://user:hunter2@relay.example.com/v1' },
    });
    if (r.code !== 0 && /找不到可用的终端/.test(r.stderr)) {
      t.skip('本机没有可探测的终端');
      return;
    }

    assert.equal(r.code, 0, r.stderr);
    // 转发的必须是引用串本身，不是求值结果
    assert.match(r.stdout, /--url \$\{RELAY_URL\}/);
    assert.doesNotMatch(r.stdout, /--url https:\/\/user:/, '命令行上该是引用串');

    // 关键在**磁盘**：`--print` 的「将要注入」会照实打印求值后的 URL（那是它的职责，
    // 且 ANTHROPIC_BASE_URL 按 §5 不打码），但脚本里绝不能落下来。
    const dir = h.profile('relay');
    const scriptName = readdirSync(dir).find((f) => f.startsWith('launch.'));
    assert.ok(scriptName, `--print 该落一份 launch 脚本，实际目录里：${readdirSync(dir).join('、')}`);
    const script = readFileSync(join(dir, /** @type {string} */ (scriptName)), 'utf8');
    assert.match(script, /\$\{RELAY_URL\}/);
    assert.doesNotMatch(script, /hunter2/, '§2.7：凭证不许落进 launch 脚本');
  });

  test('★ --url 的部分引用（拼接）→ 拦下，不带着残缺环境启动（§2.4）', () => {
    // 这是改动前**静默漏过**的那一类：值非空、四要素判定为"齐"，
    // 注入时才发现求不出值，于是窗口里没有 ANTHROPIC_BASE_URL。
    const h = ready();
    const r = h.run(['run', 'relay', '--url', 'https://${RELAY_HOST}/v1', '--print'], {
      env: { RELAY_HOST: 'relay.example.com' },
    });

    assert.equal(r.code, 1);
    assert.match(r.stderr, /ANTHROPIC_BASE_URL/, '要点名是哪个变量没注入');
    assert.match(r.stderr, /不支持的/);
    assert.match(r.stderr, /整串引用/, 'hint 要说清正确的写法长什么样');
    assert.equal(existsSync(h.profile('relay')), false, '拦在启动前，profile 都不该建');
  });

  test('--url 的整串引用没设置 → 同样拦下，且指名变量（§2.4）', () => {
    const h = ready();
    const r = h.run(['run', 'relay', '--url', '${NOT_SET_ANYWHERE}', '--print']);

    assert.equal(r.code, 1);
    assert.match(r.stderr, /NOT_SET_ANYWHERE/);
    assert.equal(existsSync(h.profile('relay')), false);
  });

  test('★ 转发 --url / --auth-mode 给内层 exec，且转的是引用串不是求值结果（§2.10）', (t) => {
    // 改动前：`cmt run --url X` 只把 X 用在了自己的解析里，转发给 `cmt exec` 的
    // 命令行里**没有** --url——于是"回执说的"和"窗口里跑的"是两套。
    const h = ready();
    const r = h.run(['run', 'relay', '--url', '${RELAY_URL}', '--auth-mode', 'key', '--print'], {
      env: { RELAY_URL: 'https://relay.example.com' },
    });

    // `--print` 也要先过终端探测；本机没有可探测的终端时这里没有可断言的东西。
    if (r.code !== 0 && /找不到可用的终端/.test(r.stderr)) {
      t.skip('本机没有可探测的终端');
      return;
    }
    assert.equal(r.code, 0, r.stderr);

    // ① 新窗口内真正跑的那条命令
    assert.match(r.stdout, /exec relay --model g-1 --url \$\{RELAY_URL\} --auth-mode key/);
    assert.doesNotMatch(
      r.stdout,
      /exec relay .*--url https:\/\/relay\.example\.com/,
      '转发的该是引用串——求值发生在新窗口里，那里才有用户当下的环境',
    );

    // ② 脚本是那条命令的忠实序列化（§2.10）：两处必须一致
    const dir = h.profile('relay');
    const scriptName = readdirSync(dir).find((f) => f.startsWith('launch.'));
    assert.ok(scriptName, `--print 该落一份 launch 脚本，实际目录里：${readdirSync(dir).join('、')}`);
    const script = readFileSync(join(dir, /** @type {string} */ (scriptName)), 'utf8');
    assert.match(script, /--url "\$\{RELAY_URL\}" --auth-mode "key"/);
    assert.doesNotMatch(script, /relay\.example\.com/, '脚本里不该出现求值后的端点（§2.7 精神）');
  });

  test('不转发 --url 时，内层 exec 的命令行里也不该有它（别凭空造选项）', (t) => {
    const h = ready();
    const r = h.run(['run', 'relay', '--print']);
    if (r.code !== 0 && /找不到可用的终端/.test(r.stderr)) {
      t.skip('本机没有可探测的终端');
      return;
    }
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /exec relay --model g-1$/m);
    assert.doesNotMatch(r.stdout, /exec relay .*--url/);
  });
});

// ───────────────────────── token 昵称（--label，§2.4 末）─────────────────────────

describe('cmt token 的 --label', () => {
  test('add 带 --label：落盘、show 多一行「昵称」', () => {
    const h = makeHome();
    const r = h.run(['token', 'add', 'relay-a', '--token', 'sk-aaaa11112222', '--label', '阿里中转']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(h.token('relay-a').label, '阿里中转');

    const shown = h.run(['token', 'show', 'relay-a']);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /昵称/);
    assert.match(shown.stdout, /阿里中转/);
  });

  test('★ `--label ""` = 清除昵称：**删键**，不是写空串', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x', label: '旧昵称' } } });
    const r = h.run(['token', 'edit', 'relay', '--label', '']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal('label' in h.token('relay'), false,
      '★ 写空串会让"没设置"和"设成空"变成两回事，而它们本该是同一件事');
  });

  test('★ 坏 label 在**写盘之前**就被拒：文件不动', () => {
    const h = makeHome({ tokens: { relay: { authToken: 'sk-x' } } });
    const before = readFileSync(join(h.app, 'tokens', 'relay.json'), 'utf8');
    const r = h.run(['token', 'edit', 'relay', '--label', `a${String.fromCharCode(127)}b`]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /控制字符/);
    assert.equal(readFileSync(join(h.app, 'tokens', 'relay.json'), 'utf8'), before);
  });

  test('★ 超过 32 个码点被拒', () => {
    const h = makeHome();
    const r = h.run(['token', 'add', 'relay-a', '--token', 'sk-x', '--label', 'x'.repeat(33)]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /32 个字符/);
    assert.equal(existsSync(join(h.app, 'tokens', 'relay-a.json')), false);
  });
});
