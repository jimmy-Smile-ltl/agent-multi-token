// @ts-check
/**
 * 启动前播种（§3.6）——§3.1 铁律的唯一例外，所以这里的断言比别处更该狠一点。
 *
 * 重点不是"能不能补上"，而是**补的时候有没有碰不该碰的东西**：
 * 已存在的键、别的项目的条目、显式拒绝过的信任、原对象本身。
 * 这个特性一旦出错是静默的（键写歪了只是不生效），所以边界必须由测试钉死。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig, normalizeDefaults } from '../src/core/schema.js';
import {
  DEFAULT_SEED_MODE,
  SEED_MODES,
  normalizeSeedMode,
  planSeed,
  projectKey,
} from '../src/core/seed.js';
import { seedProfile } from '../src/core/store.js';

/** 一个临时 home，用完删干净 */
function withTempHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'cmt-seed-'));
  try {
    return fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const WIN = /** @type {NodeJS.Platform} */ ('win32');
const LINUX = /** @type {NodeJS.Platform} */ ('linux');

describe('projectKey：与 Claude Code 的键形状对齐（§7.6）', () => {
  test('反斜杠转正斜杠', () => {
    assert.equal(projectKey('C:\\Users\\t\\proj'), 'C:/Users/t/proj');
  });

  test('保留大小写——别 toLowerCase()', () => {
    // vS() 的 foldCase 默认 true 是给**比较**用的，存储用 false。
    // 本机 68 个真实键全部保留原大小写，写小了就是一个永远不命中的键。
    assert.equal(projectKey('C:\\Users\\alice\\Documents'), 'C:/Users/alice/Documents');
  });

  test('NFC 归一（macOS NFD 陷阱，§2.9 三）', () => {
    const nfd = 'C:/Users/t/´e'.normalize('NFD');
    assert.equal(projectKey(nfd), projectKey(nfd).normalize('NFC'));
  });

  test('已经是正斜杠的路径原样通过', () => {
    assert.equal(projectKey('C:/already/slashed'), 'C:/already/slashed');
  });

  test('混合分隔符全部归一', () => {
    assert.equal(projectKey('C:\\a/b\\c'), 'C:/a/b/c');
  });
});

describe('planSeed：只增不改', () => {
  test('mode=off 什么都不做', () => {
    const r = planSeed({ current: {}, cwd: 'C:/p', mode: 'off', platform: WIN });
    assert.equal(r.changed, false);
    assert.deepEqual(r.added, []);
  });

  test('未知 mode 按 off 处理（不炸）', () => {
    const r = planSeed({ current: {}, cwd: 'C:/p', mode: 'nonsense', platform: WIN });
    assert.equal(r.changed, false);
  });

  test('onboarding 只补 hasCompletedOnboarding', () => {
    const r = planSeed({ current: {}, cwd: 'C:/p', mode: 'onboarding', platform: WIN });
    assert.equal(r.changed, true);
    assert.deepEqual(r.added, ['hasCompletedOnboarding']);
    assert.equal(r.next.hasCompletedOnboarding, true);
  });

  test('onboarding 不写 lastOnboardingVersion（形态不可靠，§7.6）', () => {
    const r = planSeed({ current: {}, cwd: 'C:/p', mode: 'onboarding', platform: WIN });
    assert.equal('lastOnboardingVersion' in r.next, false);
  });

  test('onboarding 不碰 projects——信任是另一档的事', () => {
    const r = planSeed({ current: {}, cwd: 'C:/p', mode: 'onboarding', platform: WIN });
    assert.equal('projects' in r.next, false);
  });

  test('幂等：补完再算一次必然 changed=false', () => {
    const first = planSeed({ current: {}, cwd: 'C:/p', mode: 'full', platform: WIN });
    const second = planSeed({ current: first.next, cwd: 'C:/p', mode: 'full', platform: WIN });
    assert.equal(second.changed, false);
    assert.deepEqual(second.added, []);
  });

  test('幂等：三次也不漂', () => {
    let cur = {};
    for (let i = 0; i < 3; i++) {
      const r = planSeed({ current: cur, cwd: 'C:/p', mode: 'full', platform: WIN });
      cur = r.next;
      if (i > 0) assert.equal(r.changed, false, `第 ${i + 1} 次不该再有变化`);
    }
  });

  test('不修改传入的 current（调用方要拿它做并发比对）', () => {
    const cur = { hasCompletedOnboarding: false, keep: 1 };
    const snapshot = JSON.stringify(cur);
    planSeed({ current: cur, cwd: 'C:/p', mode: 'full', platform: WIN });
    assert.equal(JSON.stringify(cur), snapshot);
  });

  test('已有键原样保留', () => {
    const cur = { userID: 'abc', numStartups: 15, seenNotifications: { a: 1 } };
    const r = planSeed({ current: cur, cwd: 'C:/p', mode: 'full', platform: WIN });
    assert.equal(r.next.userID, 'abc');
    assert.equal(r.next.numStartups, 15);
    assert.deepEqual(r.next.seenNotifications, { a: 1 });
  });

  test('坏 current（null / 数组 / 字符串）当作空对象，不炸', () => {
    for (const bad of [null, [], 'nope', 42]) {
      const r = planSeed({ current: bad, cwd: 'C:/p', mode: 'full', platform: WIN });
      assert.equal(r.changed, true);
      assert.equal(r.next.hasCompletedOnboarding, true);
    }
  });
});

describe('planSeed：信任条目（mode=full）', () => {
  test('新目录写一份完整骨架 + 信任', () => {
    const r = planSeed({ current: {}, cwd: 'C:/work/a', mode: 'full', platform: WIN });
    const entry = r.next.projects['C:/work/a'];
    assert.equal(entry.hasTrustDialogAccepted, true);
    // 骨架照抄 Claude Code 自己写的形状（§7.6）
    assert.deepEqual(entry.allowedTools, []);
    assert.deepEqual(entry.mcpContextUris, []);
    assert.deepEqual(entry.mcpServers, {});
    assert.deepEqual(entry.enabledMcpjsonServers, []);
    assert.deepEqual(entry.disabledMcpjsonServers, []);
    assert.equal(entry.hasClaudeMdExternalIncludesApproved, false);
    assert.equal(entry.hasClaudeMdExternalIncludesWarningShown, false);
  });

  test('cwd 的反斜杠在键里被归一', () => {
    const r = planSeed({ current: {}, cwd: 'C:\\work\\a', mode: 'full', platform: WIN });
    assert.ok(r.next.projects['C:/work/a']);
  });

  test('⚠️ hasTrustDialogAccepted:false 是已表态——不覆盖', () => {
    // 用户可能真的拒绝过这个目录。覆盖它 = 替用户推翻他自己的安全决定，
    // 而 cmt exec 的 stderr 会被 TUI 盖掉（§2.4）——那必然是静默的。
    const cur = {
      projects: { 'C:/work/a': { hasTrustDialogAccepted: false, lastCost: 7 } },
    };
    const r = planSeed({ current: cur, cwd: 'C:/work/a', mode: 'full', platform: WIN });
    assert.equal(r.next.projects['C:/work/a'].hasTrustDialogAccepted, false);
    // 引导那一项照补（它跟信任无关），但**信任这一项绝不出现在 added 里**
    assert.deepEqual(r.added, ['hasCompletedOnboarding']);
    assert.equal(r.next.projects['C:/work/a'].lastCost, 7);
  });

  test('条目在但信任字段缺失 → 补上，且不丢别的字段', () => {
    const cur = { projects: { 'C:/work/a': { lastCost: 7, exampleFiles: ['x'] } } };
    const r = planSeed({ current: cur, cwd: 'C:/work/a', mode: 'full', platform: WIN });
    const entry = r.next.projects['C:/work/a'];
    assert.equal(entry.hasTrustDialogAccepted, true);
    assert.equal(entry.lastCost, 7);
    assert.deepEqual(entry.exampleFiles, ['x']);
  });

  test('大小写不敏感地复用已有键的拼写（Windows）', () => {
    // Claude Code 写的可能是 c:/work/a，我们算出来是 C:/work/a。
    // 不复用就会得到两份指向同一目录的条目——我们写的那个被无视，弹窗照旧。
    const cur = { projects: { 'c:/WORK/a': { hasTrustDialogAccepted: false } } };
    const r = planSeed({ current: cur, cwd: 'C:\\work\\A', mode: 'full', platform: WIN });
    assert.deepEqual(Object.keys(r.next.projects), ['c:/WORK/a']);
  });

  test('Linux 大小写敏感——不同大小写是两个目录', () => {
    const cur = { projects: { '/work/A': {} } };
    const r = planSeed({ current: cur, cwd: '/work/a', mode: 'full', platform: LINUX });
    assert.deepEqual(Object.keys(r.next.projects).sort(), ['/work/A', '/work/a']);
  });

  test('别的项目的条目一个字节都不动', () => {
    const other = { hasTrustDialogAccepted: false, lastCost: 99, nested: { deep: [1, 2] } };
    const cur = { projects: { 'C:/other': other } };
    const before = JSON.stringify(cur.projects['C:/other']);
    const r = planSeed({ current: cur, cwd: 'C:/work/a', mode: 'full', platform: WIN });
    assert.equal(JSON.stringify(r.next.projects['C:/other']), before);
  });

  test('projects 是坏值时重建，不炸', () => {
    const r = planSeed({ current: { projects: 'nope' }, cwd: 'C:/p', mode: 'full', platform: WIN });
    assert.ok(r.next.projects['C:/p']);
  });
});

describe('normalizeSeedMode：打错字要响，不能静默忽略', () => {
  test('三个合法值都过', () => {
    for (const m of SEED_MODES) assert.equal(normalizeSeedMode(m, 'at'), m);
  });

  test('拼错的值报错，且提示里列出合法值', () => {
    assert.throws(() => normalizeSeedMode('onboading', 'config.defaults.seed'), /off/);
  });

  test('非字符串报错', () => {
    assert.throws(() => normalizeSeedMode(true, 'at'), /只能是/);
  });

  test('默认档位是 off——升级不该悄悄改行为', () => {
    assert.equal(DEFAULT_SEED_MODE, 'off');
  });
});

describe('schema 接线：defaults.seed', () => {
  test('合法值被归一保留', () => {
    assert.equal(normalizeDefaults({ seed: 'full' }).seed, 'full');
  });

  test('拼错的值在配置加载期就报错', () => {
    assert.throws(() => normalizeDefaults({ seed: 'onboading' }), /seed/);
  });

  test('不写就不出现——保持"未声明"与"显式声明"可区分', () => {
    assert.equal('seed' in normalizeDefaults({}), false);
  });

  test('config.json 顶层接受它', () => {
    const c = normalizeConfig({ version: 1, defaults: { seed: 'onboarding' }, bindings: [] });
    assert.equal(c.defaults.seed, 'onboarding');
  });
});

describe('seedProfile：IO 与并发护栏（§3.6）', () => {
  const base = { home: '', profile: 'relay-a', cwd: 'C:/work/a', platform: WIN };

  test('mode=off 连文件都不建', () => {
    withTempHome((home) => {
      const r = seedProfile({ ...base, home, mode: 'off' });
      assert.equal(r.changed, false);
      assert.equal(existsSync(join(home, '.claude-multi-token', 'profiles', 'relay-a')), false);
    });
  });

  test('全新 profile：建目录 + 写文件', () => {
    withTempHome((home) => {
      const r = seedProfile({ ...base, home, mode: 'full' });
      assert.equal(r.changed, true);
      assert.equal(r.warning, null);
      const f = join(home, '.claude-multi-token', 'profiles', 'relay-a', '.claude.json');
      const written = JSON.parse(readFileSync(f, 'utf8'));
      assert.equal(written.hasCompletedOnboarding, true);
      assert.equal(written.projects['C:/work/a'].hasTrustDialogAccepted, true);
    });
  });

  test('第二次调用是纯读取——文件字节不变', () => {
    withTempHome((home) => {
      seedProfile({ ...base, home, mode: 'full' });
      const f = join(home, '.claude-multi-token', 'profiles', 'relay-a', '.claude.json');
      const first = readFileSync(f, 'utf8');
      const r = seedProfile({ ...base, home, mode: 'full' });
      assert.equal(r.changed, false);
      assert.equal(readFileSync(f, 'utf8'), first, '幂等：第二次不该动文件');
    });
  });

  test('已有文件：先留一份备份，且只留一次', () => {
    withTempHome((home) => {
      const dir = join(home, '.claude-multi-token', 'profiles', 'relay-a');
      const f = join(dir, '.claude.json');
      mkdirSync(dir, { recursive: true });
      writeFileSync(f, JSON.stringify({ numStartups: 3 }), 'utf8');

      seedProfile({ ...base, home, mode: 'full' });
      const bak = `${f}.cmt.bak`;
      assert.equal(existsSync(bak), true);
      assert.equal(JSON.parse(readFileSync(bak, 'utf8')).numStartups, 3);
      assert.equal(JSON.parse(readFileSync(f, 'utf8')).numStartups, 3, '原有键要保留');

      // 再改一次文件后重新播种（换个目录），备份不该被覆盖
      writeFileSync(f, JSON.stringify({ numStartups: 3, extra: 1 }), 'utf8');
      seedProfile({ ...base, home, cwd: 'C:/work/b', mode: 'full' });
      assert.equal(JSON.parse(readFileSync(bak, 'utf8')).numStartups, 3);
      assert.equal('extra' in JSON.parse(readFileSync(bak, 'utf8')), false, '备份只留第一次');
    });
  });

  test('文件是坏 JSON → 回警告，不抛（播种不该拦住启动）', () => {
    withTempHome((home) => {
      const dir = join(home, '.claude-multi-token', 'profiles', 'relay-a');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.claude.json'), '{ 这不是 JSON', 'utf8');

      let r;
      assert.doesNotThrow(() => {
        r = seedProfile({ ...base, home, mode: 'full' });
      });
      assert.equal(r.changed, false);
      assert.match(r.warning, /跳过播种/);
    });
  });

  test('坏文件不被覆写——原样留在磁盘上等 Claude Code 自己修', () => {
    withTempHome((home) => {
      const dir = join(home, '.claude-multi-token', 'profiles', 'relay-a');
      mkdirSync(dir, { recursive: true });
      const f = join(dir, '.claude.json');
      writeFileSync(f, '{ 坏', 'utf8');
      seedProfile({ ...base, home, mode: 'full' });
      assert.equal(readFileSync(f, 'utf8'), '{ 坏');
    });
  });
});
