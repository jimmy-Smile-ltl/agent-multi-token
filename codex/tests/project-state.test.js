// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_STATUSES,
  MAX_STATUSES,
  PROJECTS_VERSION,
  STATUS_COLORS,
  UNKNOWN_STATUS,
  assignIds,
  defaultProjectState,
  hasStatus,
  isColor,
  normalizeProjectState,
  projectKey,
  statusFor,
  statusIdFor,
  usedStatuses,
  validateStatuses,
  withStatus,
  withStatuses,
} from '../src/core/project-state.js';
import { projectsPath } from '../src/core/paths.js';
import { readProjectState, writeProjectState } from '../src/core/store.js';

const WIN = 'win32';
const LINUX = 'linux';

/** 默认表的一个深拷贝，省得每条测试都手打一遍 */
const S = () => defaultProjectState();

// ───────────────────────────── 键 ─────────────────────────────

describe('projectKey：复用 normalizeForCompare，不另写一套', () => {
  test('尾部斜杠 / 正反斜杠 / 大小写 都归一到同一个键', () => {
    const a = projectKey('D:\\work\\proj', WIN);
    assert.equal(projectKey('D:/work/proj', WIN), a);
    assert.equal(projectKey('d:/work/proj/', WIN), a);
    assert.equal(projectKey('D:\\work\\PROJ', WIN), a);
  });

  test('★ Linux 上大小写**不能**折叠（那是两个目录）', () => {
    assert.notEqual(projectKey('/home/t/Work', LINUX), projectKey('/home/t/work', LINUX));
    assert.equal(projectKey('/home/t/work/', LINUX), projectKey('/home/t/work', LINUX));
  });
});

// ───────────────────────────── 默认 ─────────────────────────────

describe('默认状态表', () => {
  test('第一条是"没设过"的落点（未开始）', () => {
    assert.equal(DEFAULT_STATUSES[0].id, 'todo');
    assert.equal(DEFAULT_STATUSES[0].label, '未开始');
  });

  test('默认表里的每个颜色都在词表里', () => {
    for (const s of DEFAULT_STATUSES) assert.ok(isColor(s.color), s.color);
  });

  test('默认表是冻结的（没人能顺手改全局）', () => {
    assert.ok(Object.isFrozen(DEFAULT_STATUSES));
    for (const s of DEFAULT_STATUSES) assert.ok(Object.isFrozen(s));
  });

  test('defaultProjectState() 每次给一份**新的** statuses', () => {
    const a = S();
    const b = S();
    a.statuses[0].label = '被改了';
    assert.equal(b.statuses[0].label, '未开始');
    assert.notEqual(a.statuses[0], b.statuses[0]);
  });

  test('空状态里没有任何项目', () => {
    assert.deepEqual(S().projects, {});
    assert.equal(S().version, PROJECTS_VERSION);
  });
});

// ───────────────────────── 读：宽容（永不抛错） ─────────────────────────

describe('normalizeProjectState：读盘永远能读出一个可用的形状', () => {
  test('null / 数组 / 字符串 / 数字 都落到全默认', () => {
    for (const raw of [null, undefined, [], 'x', 42, true]) {
      const s = normalizeProjectState(raw);
      assert.equal(s.statuses.length, DEFAULT_STATUSES.length);
      assert.deepEqual(s.projects, {});
    }
  });

  test('statuses 不是数组 → 默认表', () => {
    assert.deepEqual(
      normalizeProjectState({ statuses: 'nope' }).statuses,
      DEFAULT_STATUSES.map((s) => ({ ...s })),
    );
  });

  test('一条都不合法 → 默认表（而不是空表）', () => {
    const s = normalizeProjectState({ statuses: [{ id: '../x', label: 'x', color: 'blue' }] });
    assert.equal(s.statuses.length, DEFAULT_STATUSES.length);
  });

  test('认不出的颜色落到 slate，**不丢这一档**', () => {
    const s = normalizeProjectState({ statuses: [{ id: 'a', label: '甲', color: 'chartreuse' }] });
    assert.deepEqual(s.statuses, [{ id: 'a', label: '甲', color: 'slate' }]);
  });

  test('重复的 id 只留第一条', () => {
    const s = normalizeProjectState({
      statuses: [
        { id: 'a', label: '甲', color: 'blue' },
        { id: 'a', label: '乙', color: 'red' },
      ],
    });
    assert.deepEqual(s.statuses.map((x) => x.label), ['甲']);
  });

  test('名称空了就用 id 顶上（不留一个点不中名字的空标签）', () => {
    const s = normalizeProjectState({ statuses: [{ id: 'a', label: '   ', color: 'blue' }] });
    assert.equal(s.statuses[0].label, 'a');
  });

  test('名称过长被截到 16 个字', () => {
    const s = normalizeProjectState({
      statuses: [{ id: 'a', label: '一二三四五六七八九十一二三四五六七八', color: 'blue' }],
    });
    assert.equal(s.statuses[0].label.length, 16);
  });

  test(`最多留 ${MAX_STATUSES} 条`, () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, label: `状态${i}`, color: 'slate' }));
    assert.equal(normalizeProjectState({ statuses: many }).statuses.length, MAX_STATUSES);
  });

  test('projects：坏条目丢掉，好条目留下', () => {
    const s = normalizeProjectState({
      projects: {
        'd:/work/a': { status: 'doing' },
        'd:/work/b': null,
        'd:/work/c': { status: 42 },
        'd:/work/d': { status: '' },
        '': { status: 'doing' },
        'd:/work/e': { status: 'doing', extra: 1 },
      },
    });
    assert.deepEqual(s.projects, {
      'd:/work/a': { status: 'doing' },
      'd:/work/e': { status: 'doing' },
    });
  });

  test('projects 不是对象 → 空表（但状态表还在）', () => {
    const s = normalizeProjectState({ statuses: DEFAULT_STATUSES, projects: 'x' });
    assert.deepEqual(s.projects, {});
    assert.equal(s.statuses.length, DEFAULT_STATUSES.length);
  });
});

// ───────────────────────────── 查 ─────────────────────────────

describe('statusFor / statusIdFor', () => {
  test('没设过 → 第一档；statusIdFor 仍然说"没设过"', () => {
    const s = S();
    assert.equal(statusFor(s, '/w/a', LINUX).id, 'todo');
    assert.equal(statusIdFor(s, '/w/a', LINUX), '');
  });

  test('设过之后两者一致', () => {
    const s = withStatus(S(), '/w/a', LINUX, 'doing');
    assert.equal(statusFor(s, '/w/a', LINUX).id, 'doing');
    assert.equal(statusIdFor(s, '/w/a', LINUX), 'doing');
  });

  test('★ 指向已删状态 → 未知状态（不崩、不回退成第一档）', () => {
    const s = withStatus(S(), '/w/a', LINUX, 'gone');
    assert.equal(statusFor(s, '/w/a', LINUX).label, UNKNOWN_STATUS.label);
    assert.equal(statusFor(s, '/w/a', LINUX).id, '');
    assert.equal(statusIdFor(s, '/w/a', LINUX), 'gone');  // 存着的还是它，只是显示不出来
  });

  test('同一个目录两种写法 → 同一档', () => {
    const s = withStatus(S(), 'D:/Work/A/', WIN, 'done');
    assert.equal(statusFor(s, 'd:\\work\\a', WIN).id, 'done');
  });
});

describe('withStatus：不改入参', () => {
  test('原状态对象一个字段都不变', () => {
    const s = S();
    const next = withStatus(s, '/w/a', LINUX, 'doing');
    assert.deepEqual(s.projects, {});
    assert.notEqual(next, s);
    assert.equal(next.projects['/w/a'].status, 'doing');
  });
});

describe('usedStatuses：只报**真的在用**的', () => {
  test('没有项目 → 空', () => {
    assert.deepEqual(usedStatuses(S()), []);
  });

  test('同一个状态被两个项目用着，只报一次', () => {
    let s = withStatus(S(), '/w/a', LINUX, 'doing');
    s = withStatus(s, '/w/b', LINUX, 'doing');
    s = withStatus(s, '/w/c', LINUX, 'done');
    assert.deepEqual(usedStatuses(s).map((x) => x.id), ['doing', 'done']);
  });

  test('★ 指向已删状态的条目不算"在用"（它没得删）', () => {
    const s = withStatus(S(), '/w/a', LINUX, 'gone');
    assert.deepEqual(usedStatuses(s), []);
  });
});

describe('hasStatus', () => {
  test('认 id', () => {
    assert.equal(hasStatus(S(), 'doing'), true);
    assert.equal(hasStatus(S(), 'gone'), false);
    assert.equal(hasStatus(S(), ''), false);
  });
});

// ───────────────────────── 写：严格校验 ─────────────────────────

describe('validateStatuses：写盘时一点不含糊', () => {
  test('原样收下', () => {
    const r = validateStatuses(DEFAULT_STATUSES.map((s) => ({ ...s })));
    assert.equal(r.ok, true);
    assert.equal(/** @type {any} */ (r).statuses.length, DEFAULT_STATUSES.length);
  });

  test('新行（id 为空）由服务端分配 s1/s2…', () => {
    const r = validateStatuses([
      { id: '', label: '甲', color: 'blue' },
      { id: '', label: '乙', color: 'red' },
    ]);
    assert.equal(r.ok, true);
    assert.deepEqual(/** @type {any} */ (r).statuses.map((s) => s.id), ['s1', 's2']);
  });

  test('分配新 id 时避开已有的 s1', () => {
    const r = validateStatuses([
      { id: 's1', label: '甲', color: 'blue' },
      { id: '', label: '乙', color: 'red' },
    ]);
    assert.deepEqual(/** @type {any} */ (r).statuses.map((s) => s.id), ['s1', 's2']);
  });

  test('一条都不留 → 拒', () => {
    assert.equal(validateStatuses([]).ok, false);
  });

  test(`超过 ${MAX_STATUSES} 条 → 拒`, () => {
    const many = Array.from({ length: MAX_STATUSES + 1 }, (_, i) => ({ id: '', label: `x${i}`, color: 'slate' }));
    assert.equal(validateStatuses(many).ok, false);
  });

  test('名字为空 → 拒（不留一个点不中的空标签）', () => {
    const r = validateStatuses([{ id: '', label: '   ', color: 'blue' }]);
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).error, /名称不能为空/);
  });

  test('认不出的颜色 → 拒（不静默改成 slate）', () => {
    const r = validateStatuses([{ id: '', label: '甲', color: '#ff0000' }]);
    assert.equal(r.ok, false);
    assert.match(/** @type {any} */ (r).error, /颜色/);
  });

  test('非法 id → 拒', () => {
    for (const id of ['../x', 'A', 'a b', '-x', 'x'.repeat(25)]) {
      assert.equal(validateStatuses([{ id, label: '甲', color: 'blue' }]).ok, false, id);
    }
  });

  test('重复 id → 拒', () => {
    const r = validateStatuses([
      { id: 'a', label: '甲', color: 'blue' },
      { id: 'a', label: '乙', color: 'red' },
    ]);
    assert.equal(r.ok, false);
  });

  test('★★ 删掉仍在用的状态 → 拒，且说人话（用名称，不用内部 id）', () => {
    let s = withStatus(S(), '/w/a', LINUX, 'doing');
    s = withStatus(s, '/w/b', LINUX, 'done');
    const keep = s.statuses.filter((x) => x.id !== 'doing').map((x) => ({ ...x }));
    const r = validateStatuses(keep, usedStatuses(s));
    assert.equal(r.ok, false);
    const msg = /** @type {any} */ (r).error;
    assert.match(msg, /进行中/);
    assert.doesNotMatch(msg, /doing/);
  });

  test('删掉没人用的状态 → 放行', () => {
    const keep = S().statuses.filter((x) => x.id !== 'fail').map((x) => ({ ...x }));
    assert.equal(validateStatuses(keep, usedStatuses(S())).ok, true);
  });

  test('改名不换 id → 放行（项目指向它，改名不该把它弄丢）', () => {
    let s = withStatus(S(), '/w/a', LINUX, 'doing');
    const renamed = s.statuses.map((x) => (x.id === 'doing' ? { ...x, label: '在做' } : { ...x }));
    const r = validateStatuses(renamed, usedStatuses(s));
    assert.equal(r.ok, true);
  });

  test('不是数组 → 拒', () => {
    assert.equal(validateStatuses('x').ok, false);
  });

  test('数组里混了非对象 → 拒', () => {
    assert.equal(validateStatuses([null]).ok, false);
    assert.equal(validateStatuses(['x']).ok, false);
  });
});

describe('assignIds', () => {
  test('已有 id 原样保留', () => {
    assert.deepEqual(
      assignIds([{ id: 'doing', label: '甲', color: 'blue' }]).map((s) => s.id),
      ['doing'],
    );
  });

  test('空白 id 按出现顺序补', () => {
    assert.deepEqual(
      assignIds([
        { id: '', label: '甲', color: 'blue' },
        { id: 'x', label: '乙', color: 'red' },
        { id: '', label: '丙', color: 'teal' },
      ]).map((s) => s.id),
      ['s1', 'x', 's2'],
    );
  });
});

describe('withStatuses', () => {
  test('换表但不动 projects 的指向', () => {
    const s = withStatus(S(), '/w/a', LINUX, 'doing');
    const next = withStatuses(s, [{ id: 'doing', label: '在做', color: 'teal' }]);
    assert.equal(next.statuses.length, 1);
    assert.equal(next.projects['/w/a'].status, 'doing');
    assert.equal(statusFor(next, '/w/a', LINUX).label, '在做');
  });
});

// ───────────────────────── store 往返 ─────────────────────────

describe('readProjectState / writeProjectState', () => {
  test('★ 文件不存在 = 全默认，且**不写盘**（惰性）', () => {
    const home = mkdtempSync(join(tmpdir(), 'cxt-proj-'));
    try {
      const s = readProjectState(home);
      assert.deepEqual(s.projects, {});
      assert.equal(s.statuses.length, DEFAULT_STATUSES.length);
      assert.throws(() => readFileSync(projectsPath(home), 'utf8'), /ENOENT/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('写一次之后读回来一模一样', () => {
    const home = mkdtempSync(join(tmpdir(), 'cxt-proj-'));
    try {
      const s = withStatus(S(), '/w/a', LINUX, 'doing');
      writeProjectState(home, s);
      const back = readProjectState(home);
      assert.deepEqual(back.statuses, s.statuses);
      assert.deepEqual(back.projects, s.projects);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('落盘的那份是完整形状（statuses 一定在）', () => {
    const home = mkdtempSync(join(tmpdir(), 'cxt-proj-'));
    try {
      // 故意只给半个对象：写口自己补全
      writeProjectState(home, /** @type {any} */ ({ projects: { 'd:/w': { status: 'done' } } }));
      const raw = JSON.parse(readFileSync(projectsPath(home), 'utf8'));
      assert.equal(raw.version, PROJECTS_VERSION);
      assert.equal(raw.statuses.length, DEFAULT_STATUSES.length);
      assert.deepEqual(raw.projects, { 'd:/w': { status: 'done' } });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('坏 JSON 会抛（与 config.json 一致，不静默吞掉）', () => {
    const home = mkdtempSync(join(tmpdir(), 'cxt-proj-'));
    try {
      const p = projectsPath(home);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, '{ nope', 'utf8');
      assert.throws(() => readProjectState(home), /projects\.json/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
