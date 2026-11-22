// @ts-check
/**
 * `.cmt.json` 的 schema 与发现（§2.11）——**第四层**配置。
 *
 * ★ 本文件最承重的一段是**禁键表**：这份文件会被 `git add .` 提交、会被别人克隆，
 * 所以"不许放什么"比"能放什么"重要得多。每个禁键一条测试，且断言报错**点它的名**。
 *
 * 与 `codex/tests/project-config.test.js` 是同构的两份（工具不同、禁键表不同），
 * 改一边时对着另一边看一遍。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROJECT_ALLOWED_KEYS,
  PROJECT_FORBIDDEN_KEYS,
  discoverProjectConfig,
  normalizeProjectConfig,
} from '../src/core/project-config.js';
import { PROJECT_CONFIG_FILENAME } from '../src/core/paths.js';
import { CONFIG_VERSION } from '../src/core/schema.js';
import { EXIT } from '../src/core/errors.js';

const P = 'D:/work/.cmt.json';

/** 跑一遍归一，返回产物 */
const N = (raw) => normalizeProjectConfig(raw, P);

/** 跑一遍归一，返回错误（没抛就断言失败） */
function errOf(raw) {
  try {
    N(raw);
  } catch (e) {
    return /** @type {any} */ (e);
  }
  throw new Error(`期望抛错，但通过了：${JSON.stringify(raw)}`);
}

// ═══════════════ ★★ 禁键表（§2.11 二）——本文件最该钉死的一段 ═══════════════

describe('★★ 禁键：每个都必须是**专门的**报错，且点它的名', () => {
  // 数据驱动：表里加一个禁键，这里自动多一条测试。
  // ★ 这正是禁键表被写成数据而不是一串 if 的原因（§2.11 二）。
  for (const entry of PROJECT_FORBIDDEN_KEYS) {
    test(`★ 禁 ${entry.key}：报错点名它，并说出为什么`, () => {
      const err = errOf({ version: 1, [entry.key]: 'x' });
      assert.equal(err.code, EXIT.USER);
      // ★ 断言**点名**——报成"未知字段"就是白禁了：
      //   "未知字段"只说 cmt 不认识它，说不出"这是攻击面"。
      assert.match(err.message, new RegExp(`"${entry.key}"`), `报错必须点名 ${entry.key}`);
      assert.match(err.message, /不许出现/);
      // 还要点名**是哪一份文件**——用户手上可能有好几个 .cmt.json（"最近优先"）
      assert.ok(err.message.includes(P), `报错应含文件路径，实际：${err.message}`);
      assert.ok(err.hint && err.hint.length > 0, '禁键必须带 hint');
    });
  }

  test('★★ baseUrl 的报错必须说清"这是外泄通道"，不是"不方便"', () => {
    const err = errOf({ version: 1, baseUrl: 'https://evil.example.com/v1' });
    assert.match(err.hint, /外泄通道|攻击面/);
  });

  test('★ 禁键**抢在**未知字段之前报（顺序反了禁键就永远报不出来）', () => {
    // 禁键本来就不在允许列里。若 rejectUnknownKeys 先跑，
    // 用户看到的是"未知字段 baseUrl"，而不是"这是攻击面"。
    const err = errOf({ version: 1, zzz: 1, baseUrl: 'https://evil.example.com/v1' });
    assert.match(err.message, /"baseUrl"/);
  });

  test('★ 一次报**第一个**禁键（按用户手写的顺序），不是一屏', () => {
    const err = errOf({ version: 1, authToken: 'sk-x', baseUrl: 'https://evil.example.com/v1' });
    assert.match(err.message, /"authToken"/);
    assert.doesNotMatch(err.message, /"baseUrl"/);
  });

  test('★ 禁键**只有键名说了算**——值是 null / 空串照样拒', () => {
    // 值是什么不重要，重要的是这份文件会被 `git add .` 提交上去，
    // 而克隆它的人会照着跑。留一个 "baseUrl": null 就是在邀请下一个人填上。
    for (const v of [null, '', 0, false]) {
      const err = errOf({ version: 1, baseUrl: v });
      assert.match(err.message, /"baseUrl"/, `值为 ${JSON.stringify(v)} 时也必须拒`);
    }
  });

  test('★ 禁键表与允许列**不重叠**（重叠 = 一条永远赢不了的死规则）', () => {
    for (const e of PROJECT_FORBIDDEN_KEYS) {
      assert.ok(!PROJECT_ALLOWED_KEYS.includes(e.key), `${e.key} 同时在允许列里`);
    }
  });

  test('★ `slots` 在禁键表里，且理由指向 §2.12 边界（不是"忘了加"）', () => {
    // 槽位在 `config.json` / `tokens/` / `bindings[]` 里都合法，唯独项目文件里不合法——
    // 这一条不对称必须是有理由的，理由就是"两个面板各配一套必然分叉"（§2.12 十）。
    const err = errOf({ version: 1, slots: { haiku: 'deepseek-flash' } });
    assert.match(err.message, /"slots"/);
    assert.match(err.hint, /槽位|面板/);
  });

  test('★ 机器级偏好三个（claudeBin / terminalMode / seed）理由都是"不是项目级"', () => {
    // `seed` 尤其要说清：它是 §3.1 铁律的唯一例外（会写 profile 目录），
    // 跟着仓库走等于"别人克隆下来就触发一次写盘"。
    for (const k of ['claudeBin', 'terminalMode', 'seed']) {
      const err = errOf({ version: 1, [k]: 'x' });
      assert.match(err.hint, /机器级|全局/, `${k} 的 hint 该说清它属于哪一层`);
    }
  });
});

// ═══════════════ ★★ env 里的禁键：隔离原语（§2.11 二）═══════════════

describe('★ env 里的禁键：隔离原语（§2.11 二）', () => {
  test('★★ CLAUDE_CONFIG_DIR 被拒——它真能盖掉隔离落点', () => {
    // buildInjection() 里 env 层的合并**排在 CLAUDE_CONFIG_DIR 种子之后**：
    //   env.CLAUDE_CONFIG_DIR = profileDir(...);   // ← 先种
    //   for (...) env[k] = v;                      // ← 层能盖掉它
    // 所以这不是"顺手多禁一个"，是隔离（§2.2）本身。
    const err = errOf({ version: 1, env: { CLAUDE_CONFIG_DIR: 'C:/Users/x/.claude' } });
    assert.match(err.message, /不许设置 CLAUDE_CONFIG_DIR/);
    assert.match(err.hint, /隔离/);
  });

  test('★ 大小写不敏感：claude_config_dir / Claude_Config_Dir 一样拒', () => {
    // Windows 的环境变量名不区分大小写。只拦全大写会让同一份仓库配置
    // 在 Windows 上绕过、在 Linux 上不生效——两个平台两种语义。
    for (const k of ['claude_config_dir', 'Claude_Config_Dir', 'CLAUDE_config_DIR']) {
      const err = errOf({ version: 1, env: { [k]: '/tmp/x' } });
      assert.match(err.message, /不许设置/);
      // 报**用户实际写的那个名字**——他写 claude_config_dir，你报大写，他找不到
      assert.ok(err.message.includes(k), `报错应含 ${k}，实际：${err.message}`);
    }
  });

  test('★★ 空串同样拒——那是"删掉这个继承来的变量"，后果一样', () => {
    const err = errOf({ version: 1, env: { CLAUDE_CONFIG_DIR: '' } });
    assert.match(err.message, /不许设置 CLAUDE_CONFIG_DIR/);
  });

  test('其余 env 键放行（逃生舱本身是要的，§2.4）', () => {
    const out = N({ version: 1, env: { CLAUDE_CODE_EFFORT_LEVEL: 'max', HTTPS_PROXY: 'http://127.0.0.1:7890' } });
    assert.deepEqual(out.env, {
      CLAUDE_CODE_EFFORT_LEVEL: 'max',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    });
  });
});

// ═══════════════ 允许的键（§2.11 二）═══════════════

describe('允许的键：逐字段归一，且复用 schema.js 的归一函数', () => {
  test('★ 一份完整的合法文件全字段通过', () => {
    const out = N({
      version: 1,
      token: 'relay-a',
      models: [{ id: 'deepseek-flash', label: 'Flash' }, 'deepseek-flash[1m]'],
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
      claudeArgs: ['--verbose'],
    });
    assert.equal(out.version, 1);
    assert.equal(out.token, 'relay-a');
    assert.deepEqual(out.models, [{ id: 'deepseek-flash', label: 'Flash' }, { id: 'deepseek-flash[1m]' }]);
    assert.deepEqual(out.env, { CLAUDE_CODE_EFFORT_LEVEL: 'max' });
    assert.deepEqual(out.claudeArgs, ['--verbose']);
    assert.equal(out.configPath, P);
  });

  test('★ 空文件（只有 version）通过，且不凭空补字段', () => {
    const out = N({ version: 1 });
    assert.deepEqual(Object.keys(out).sort(), ['configPath', 'version']);
  });

  test('★ 产物里带 configPath——SOURCE.PROJECT 的 detail 就是它', () => {
    // 让调用方自己再传一遍 = 总有一天有人忘了传，然后 `cmt resolve`
    // 只能说"项目本地赢了"却指不出是哪一份。
    assert.equal(N({ version: 1 }).configPath, P);
  });

  test('token 走的是**名字**校验（路径穿越照样拒，§2.8）', () => {
    for (const bad of ['../etc', 'a/b', 'A', '']) {
      const err = errOf({ version: 1, token: bad });
      assert.ok(err.code === EXIT.USER, `${bad} 应被拒`);
    }
    assert.equal(N({ version: 1, token: 'relay_a' }).token, 'relay_a');
  });

  test('★ token 只认**名字**——写成密钥的样子会被名字校验拦下', () => {
    // 这是"禁 authToken"那条规则的**第二道防线**：有人把 key 塞进 token 字段，
    // 名字校验会拒（`sk-...` 含非法字符）。两道都失效才会漏出去。
    // ★ 夹具是**编的**（§6.3）：形状要像真 key——含大写字母才会被名字校验拦下。
    const err = errOf({ version: 1, token: 'sk-FAKE-TEST-KEY-0000000000000000' });
    assert.match(err.message, /token 名不合法/);
  });

  test('models 用的是同一个归一函数（不是这里重写的一份）', () => {
    // 第二处真相的典型症状：全局 config.json 认的形状，项目文件不认（或反之）
    assert.deepEqual(N({ version: 1, models: [] }).models, [], 'models: [] 合法 = 显式不注入');
    assert.throws(() => N({ version: 1, models: 'deepseek-flash' }), /必须是数组/);
    assert.throws(() => N({ version: 1, models: [{ name: 'x' }] }), /未知字段 "name"/);
  });

  test('env 的值必须是字符串（它们要变成环境变量）', () => {
    assert.throws(() => N({ version: 1, env: { PORT: 8080 } }), /必须是字符串/);
  });

  test('claudeArgs 必须是字符串数组', () => {
    assert.deepEqual(N({ version: 1, claudeArgs: [] }).claudeArgs, []);
    assert.throws(() => N({ version: 1, claudeArgs: '--verbose' }), /必须是数组/);
    assert.throws(() => N({ version: 1, claudeArgs: [1] }), /必须是字符串/);
  });
});

// ═══════════════ version（§2.11 四）═══════════════

describe('version：必填、只能等于或低于本版', () => {
  test('★ 缺 version 直接拒（并告诉用户期望什么）', () => {
    const err = errOf({ token: 'relay-a' });
    assert.match(err.message, /缺少合法的 version/);
    assert.match(err.hint, new RegExp(`"version": ${CONFIG_VERSION}`));
  });

  test('★ 非法 version（0 / 小数 / 字符串 / null）一律拒', () => {
    for (const v of [0, -1, 1.5, '1', null, true]) {
      assert.match(errOf({ version: v }).message, /缺少合法的 version/, `version=${JSON.stringify(v)}`);
    }
  });

  test('★★ 高于本版 → 退出码 2（环境错误），不是 1', () => {
    // 这不是用户敲错了，是本机 cmt 太旧——§6.2 的码要能区分这两种。
    const err = errOf({ version: CONFIG_VERSION + 1 });
    assert.equal(err.code, EXIT.ENV);
    assert.match(err.message, /版本为/);
    assert.match(err.hint, /升级 cmt/);
  });

  test('★ 不做"备份 + 迁移"——这份文件在用户仓库里', () => {
    // config.json 读到低版本会先备份（§3.5）；`.cmt.json` 不备份：
    // 丢一个 .cmt.json.v1.bak 进用户的 git status 是骚扰。
    // 这条测试是**反向**的：低版本就是正常通过，产物里没有任何 backup 字段。
    const out = N({ version: 1 });
    assert.equal(out.version, 1);
    assert.equal(out.backupPath, undefined);
  });
});

// ═══════════════ 未知字段 ═══════════════

describe('未知字段：报错而不是静默忽略（手写文件打错字要立刻发现）', () => {
  test('★ 打错字（model 少个 s）当场报', () => {
    const err = errOf({ version: 1, model: 'deepseek-flash' });
    assert.match(err.message, /未知字段 "model"/);
    assert.match(err.hint, /可用字段/);
  });

  test('★ 别的工具的项目文件名也算未知字段（.cxt.json 的键搬不过来）', () => {
    // 两个项目同名同构，用户很容易把 `codexArgs` / `catalog` 抄过来。
    // 静默忽略的话，他会以为"配了"，然后奇怪为什么没生效。
    assert.match(errOf({ version: 1, codexArgs: [] }).message, /未知字段 "codexArgs"/);
    assert.match(errOf({ version: 1, catalog: 'x.json' }).message, /未知字段 "catalog"/);
  });

  test('允许列里列出的键都能被认出（与报错里的"可用字段"一致）', () => {
    // 允许列是**唯一**的真相：漏掉一个键的表现是"合法文件被报未知字段"。
    for (const k of PROJECT_ALLOWED_KEYS) {
      if (k === 'version') continue;
      // 值给 `undefined`：键在（`Object.keys` 看得见），但归一阶段会被跳过。
      // 这一条只测"键被认识"，不测值的形状。
      assert.doesNotThrow(
        () => N({ version: 1, [k]: undefined }),
        `${k} 不该被判成未知字段`,
      );
    }
  });
});

// ═══════════════ 入参守卫 ═══════════════

describe('入参守卫：core 不猜', () => {
  test('非对象 / 数组被拒', () => {
    for (const raw of [null, 'x', 1, [], undefined]) {
      assert.match(errOf(raw).message, /必须是对象/);
    }
  });

  test('★ 缺 configPath 被拒（报错要点名文件，不能报个 undefined）', () => {
    assert.throws(() => normalizeProjectConfig({ version: 1 }, ''), /需要 configPath/);
    assert.throws(() => normalizeProjectConfig({ version: 1 }, /** @type {any} */ (undefined)), /需要 configPath/);
  });
});

// ═══════════════ ★★ 发现：最近优先（§2.11 一）═══════════════

/**
 * 假 fs：只有列出来的路径算文件，并记下**探测顺序**。
 * @param {string[]} files
 */
function probeFs(files) {
  const set = new Set(files);
  /** @type {string[]} */
  const probed = [];
  return {
    probed,
    isFile: (/** @type {string} */ p) => { probed.push(p); return set.has(p); },
  };
}

describe('★★ 发现：从 cwd 往上，最近的一个胜出', () => {
  test('★★ 近的赢过远的（不是"找到就停"，也不是"远的赢"）', () => {
    const fs = probeFs([
      'D:\\work\\.cmt.json',
      'D:\\work\\a\\.cmt.json',
      'D:\\work\\a\\sub\\.cmt.json',
    ]);
    const found = discoverProjectConfig({ cwd: 'D:\\work\\a\\sub', platform: 'win32', isFile: fs.isFile });
    assert.equal(found?.configPath, 'D:\\work\\a\\sub\\.cmt.json');
    assert.equal(found?.dir, 'D:\\work\\a\\sub');
    // ★ 第一个就命中 → 只探一次。若实现是"先收集再挑"，这里会是 3
    assert.equal(fs.probed.length, 1);
  });

  test('★ 当前目录没有就往上走，第一个找到的胜出', () => {
    const fs = probeFs(['D:\\work\\.cmt.json', 'D:\\work\\a\\.cmt.json']);
    const found = discoverProjectConfig({ cwd: 'D:\\work\\a\\sub', platform: 'win32', isFile: fs.isFile });
    assert.equal(found?.configPath, 'D:\\work\\a\\.cmt.json');
    assert.deepEqual(fs.probed, [
      'D:\\work\\a\\sub\\.cmt.json',
      'D:\\work\\a\\.cmt.json',
    ]);
  });

  test('★ 探到根为止；根上也没有 → null（不是抛错）', () => {
    const fs = probeFs([]);
    const found = discoverProjectConfig({ cwd: 'D:\\work\\a', platform: 'win32', isFile: fs.isFile });
    assert.equal(found, null);
    // D:\work\a → D:\work → D:\ → 停（dirname('D:\\') === 'D:\\'）
    assert.deepEqual(fs.probed, [
      'D:\\work\\a\\.cmt.json',
      'D:\\work\\.cmt.json',
      'D:\\.cmt.json',
    ]);
  });

  test('★ 根上**有**就返回它（走到根是合法的终点，不是失败）', () => {
    const fs = probeFs(['D:\\.cmt.json']);
    const found = discoverProjectConfig({ cwd: 'D:\\work\\a', platform: 'win32', isFile: fs.isFile });
    assert.equal(found?.configPath, 'D:\\.cmt.json');
  });

  test('★ posix 侧同样成立（三平台规则能在任意一台机器上单测，§6.3）', () => {
    const fs = probeFs(['/home/u/proj/.cmt.json']);
    const found = discoverProjectConfig({ cwd: '/home/u/proj/src/deep', platform: 'linux', isFile: fs.isFile });
    assert.equal(found?.configPath, '/home/u/proj/.cmt.json');
    assert.deepEqual(fs.probed, [
      '/home/u/proj/src/deep/.cmt.json',
      '/home/u/proj/src/.cmt.json',
      '/home/u/proj/.cmt.json',
    ]);
  });

  test('darwin 与 linux 同规则', () => {
    const fs = probeFs([]);
    assert.equal(discoverProjectConfig({ cwd: '/Users/u/p', platform: 'darwin', isFile: fs.isFile }), null);
    assert.equal(fs.probed[0], '/Users/u/p/.cmt.json');
  });

  test('★ 相对路径不会死循环（`.` 的 dirname 是它自己）', () => {
    const fs = probeFs([]);
    assert.equal(discoverProjectConfig({ cwd: '.', platform: 'win32', isFile: fs.isFile }), null);
    assert.equal(fs.probed.length, 1);
  });

  test('★ 一个叫 .cmt.json 的**目录**不是配置——发现要接着往上走', () => {
    // 判据是 isFile 而不是 exists。少了这一条会拿目录去读、撞一个
    // 让人摸不着头脑的 EISDIR，而且**找不到真正该用的那一份**。
    const fs = probeFs(['D:\\work\\.cmt.json']);   // a\sub\.cmt.json 是个目录 → 不在文件集里
    const found = discoverProjectConfig({ cwd: 'D:\\work\\a\\sub', platform: 'win32', isFile: fs.isFile });
    assert.equal(found?.configPath, 'D:\\work\\.cmt.json');
  });

  test('文件名常量只有一个真相（store.js 也用它）', () => {
    assert.equal(PROJECT_CONFIG_FILENAME, '.cmt.json');
    const fs = probeFs(['/p/.cmt.json']);
    discoverProjectConfig({ cwd: '/p', platform: 'linux', isFile: fs.isFile });
    assert.equal(fs.probed[0], `/p/${PROJECT_CONFIG_FILENAME}`);
  });

  test('★ 不跨越盘符——C: 上找不到不会跑去 D: 找', () => {
    const fs = probeFs(['D:\\.cmt.json']);
    const found = discoverProjectConfig({ cwd: 'C:\\work\\a', platform: 'win32', isFile: fs.isFile });
    assert.equal(found, null);
    assert.ok(fs.probed.every((p) => p.startsWith('C:')), `只该探 C: 盘：${fs.probed}`);
  });

  test('★ 发现**不认** cmt 自己的数据目录（§2.8）', () => {
    // `~/.claude-multi-token/` 里**不该**有 `.cmt.json`——它是 cmt 自己的地盘，
    // 而 `.cmt.json` 是"跟着仓库走"的那一类。这条是反面的：
    // 发现路径纯粹是 cwd 上溯，不特判、不跳过、也不额外插入任何目录。
    const fs = probeFs(['C:\\Users\\u\\.claude-multi-token\\.cmt.json']);
    const found = discoverProjectConfig({ cwd: 'C:\\work\\a', platform: 'win32', isFile: fs.isFile });
    assert.equal(found, null, '数据目录不在 cwd 上溯链上，探不到它');
    assert.ok(fs.probed.every((p) => !p.includes('.claude-multi-token')));
  });
});

describe('发现的入参守卫：这里猜错的后果是**静默找不到配置**', () => {
  test('★ 未知 platform 直接抛（而不是"不是 win32 就当 posix"）', () => {
    const fs = probeFs([]);
    assert.throws(
      () => discoverProjectConfig({ cwd: '/p', platform: /** @type {any} */ ('aix'), isFile: fs.isFile }),
      /未知 platform/,
    );
    assert.equal(fs.probed.length, 0, '平台都不认识，一次 fs 都不该碰');
  });

  test('缺 cwd / 空 cwd 被拒', () => {
    const fs = probeFs([]);
    for (const cwd of ['', /** @type {any} */ (undefined), /** @type {any} */ (null)]) {
      assert.throws(() => discoverProjectConfig({ cwd, platform: 'win32', isFile: fs.isFile }), /需要 cwd/);
    }
  });

  test('★ 缺 isFile 谓词被拒（core 不碰 fs，§4.2）', () => {
    assert.throws(
      () => discoverProjectConfig({ cwd: '/p', platform: 'linux', isFile: /** @type {any} */ (undefined) }),
      /需要注入 isFile/,
    );
  });
});
