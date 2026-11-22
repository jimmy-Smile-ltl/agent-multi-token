// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseAvailable,
  dedupeModels,
  fillDefaultSlots,
  formatModel,
  modelsEqual,
  parseModelSpec,
  parseModelSpecs,
  promote,
  rotate,
} from '../src/core/models.js';

const A = { id: 'a' };
const B = { id: 'b' };
const C = { id: 'c' };

describe('rotate —— cmt model next', () => {
  test('首位移到末位，次位升首位', () => {
    assert.deepEqual(rotate([A, B, C]), [B, C, A]);
  });

  test('★ 反复轮转能回到原点，不丢项', () => {
    let cur = [A, B, C];
    for (let i = 0; i < 3; i++) cur = rotate(cur);
    assert.deepEqual(cur, [A, B, C]);
  });

  test('转 N-1 次即取到第 N 个候选', () => {
    assert.equal(rotate([A, B, C])[0].id, 'b');
    assert.equal(rotate(rotate([A, B, C]))[0].id, 'c');
  });

  test('单项 / 空列表是恒等操作', () => {
    assert.deepEqual(rotate([A]), [A]);
    assert.deepEqual(rotate([]), []);
  });

  test('不修改入参', () => {
    const src = [A, B, C];
    rotate(src);
    assert.deepEqual(src, [A, B, C]);
  });

  test('保留 label', () => {
    const withLabel = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
    assert.deepEqual(rotate(withLabel), [{ id: 'b', label: 'B' }, { id: 'a', label: 'A' }]);
  });
});

describe('promote —— cmt model use <id>', () => {
  test('提到首位，其余保持相对顺序', () => {
    assert.deepEqual(promote([A, B, C], 'c'), [C, A, B]);
  });

  test('原首位退到第二，便于切回', () => {
    const once = promote([A, B, C], 'c');
    assert.equal(once[0].id, 'c');
    assert.equal(once[1].id, 'a');
    assert.deepEqual(promote(once, 'a'), [A, C, B]);
  });

  test('★ 提拔已在首位的项 = 无变化', () => {
    assert.deepEqual(promote([A, B, C], 'a'), [A, B, C]);
  });

  test('不在列表里 → 插到首位', () => {
    assert.deepEqual(promote([A, B], 'x'), [{ id: 'x' }, A, B]);
  });

  test('保留被提拔项的 label', () => {
    const withLabel = [{ id: 'a' }, { id: 'b', label: 'B' }];
    assert.deepEqual(promote(withLabel, 'b'), [{ id: 'b', label: 'B' }, { id: 'a' }]);
  });

  test('不修改入参', () => {
    const src = [A, B, C];
    promote(src, 'c');
    assert.deepEqual(src, [A, B, C]);
  });

  test('空列表也能提拔', () => {
    assert.deepEqual(promote([], 'x'), [{ id: 'x' }]);
  });
});

describe('dedupeModels', () => {
  test('保留首次出现的位置', () => {
    assert.deepEqual(dedupeModels([A, B, A, C, B]), [A, B, C]);
  });

  test('无重复时原样', () => {
    assert.deepEqual(dedupeModels([A, B, C]), [A, B, C]);
  });
});

describe('parseModelSpec —— <id[:label]>', () => {
  test('无冒号 → 只有 id', () => {
    assert.deepEqual(parseModelSpec('deepseek-flash[1m]'), { id: 'deepseek-flash[1m]' });
  });

  test('切第一个冒号——label 里可以再有冒号', () => {
    assert.deepEqual(parseModelSpec('a:Flash: 1M'), { id: 'a', label: 'Flash: 1M' });
  });

  test('空 label 是允许的', () => {
    assert.deepEqual(parseModelSpec('a:'), { id: 'a', label: '' });
  });

  test('批量解析顺带去重', () => {
    assert.deepEqual(parseModelSpecs(['a', 'b:BB', 'a']), [{ id: 'a' }, { id: 'b', label: 'BB' }]);
  });
});

describe('fillDefaultSlots —— §2.5 默认规则', () => {
  test('未列出的槽自动填 models[0]', () => {
    assert.deepEqual(fillDefaultSlots(undefined, [A, B]), {
      opus: 'a', sonnet: 'a', haiku: 'a', fable: 'a', subagent: 'a',
    });
  });

  test('★ 显式 null 保持 null——该槽不注入', () => {
    const out = fillDefaultSlots({ haiku: null }, [A]);
    assert.equal(out.haiku, null);
    assert.equal(out.opus, 'a');
  });

  test('显式指定的槽不被覆盖', () => {
    const out = fillDefaultSlots({ opus: 'b' }, [A]);
    assert.equal(out.opus, 'b');
    assert.equal(out.sonnet, 'a');
  });

  test('models 为空 → 未声明的槽就空着，不硬填', () => {
    assert.deepEqual(fillDefaultSlots(undefined, []), {});
    assert.deepEqual(fillDefaultSlots({ opus: 'x' }, []), { opus: 'x' });
  });

  test('五个槽位齐全（与 SLOT_KEYS 对齐）', () => {
    assert.deepEqual(Object.keys(fillDefaultSlots(undefined, [A])).sort(), [
      'fable', 'haiku', 'opus', 'sonnet', 'subagent',
    ]);
  });
});

describe('formatModel / modelsEqual', () => {
  test('有 label 才显示括号', () => {
    assert.equal(formatModel({ id: 'a' }), 'a');
    assert.equal(formatModel({ id: 'a', label: 'A' }), 'a  (A)');
  });

  test('等价判断是顺序敏感的', () => {
    assert.equal(modelsEqual([A, B], [{ id: 'a' }, { id: 'b' }]), true);
    assert.equal(modelsEqual([A, B], [B, A]), false);
    assert.equal(modelsEqual([A], [A, B]), false);
    assert.equal(modelsEqual([{ id: 'a', label: 'A' }], [A]), false);
  });
});

// ═══════════════════ chooseAvailable（启动前校验的纯逻辑，§2.5）═══════════════════

const idsOf = (/** @type {any[]} */ list) => list.map((m) => m.id);

describe('★ chooseAvailable —— 从优先级里挑第一个端点确实有的', () => {
  test('首位命中 → 原样，picked = 0', () => {
    const list = [{ id: 'a', label: 'A' }, B, C];
    const r = chooseAvailable(list, ['a', 'b']);
    assert.deepEqual(idsOf(r.models), ['a', 'b', 'c']);
    assert.equal(r.picked, 0);
    assert.deepEqual(r.missing, ['c']);
  });

  test('中间命中 → 提到首位，其余保序（与 model next / use 同语义）', () => {
    const r = chooseAvailable([A, B, C], ['c', 'b']);
    assert.deepEqual(idsOf(r.models), ['b', 'a', 'c']);
    assert.equal(r.picked, 1);
    assert.deepEqual(r.missing, ['a']);
  });

  test('★ label 跟着条目一起走（旋转不能把展示名丢掉）', () => {
    const r = chooseAvailable([A, { id: 'b', label: 'B 别名' }], ['b']);
    assert.equal(r.models[0].label, 'B 别名');
  });

  test('★★ 一个都不命中 → 原样返回 picked = -1，绝不随便挑一个', () => {
    const r = chooseAvailable([A, B], ['x', 'y']);
    assert.deepEqual(idsOf(r.models), ['a', 'b']);
    assert.equal(r.picked, -1);
    assert.deepEqual(r.missing, ['a', 'b']);
  });

  test('空清单 / 空 models → -1，且不抛', () => {
    assert.equal(chooseAvailable([A], []).picked, -1);
    assert.equal(chooseAvailable([], ['a']).picked, -1);
    assert.equal(chooseAvailable(undefined, ['a']).picked, -1);
    assert.equal(chooseAvailable([A], undefined).picked, -1);
  });

  test('顺序即优先级：命中项不相邻时也取**最靠前**的那个', () => {
    assert.deepEqual(idsOf(chooseAvailable([A, B, C], ['c', 'b']).models), ['b', 'a', 'c']);
  });

  test('不改入参（两个数组都不改）', () => {
    const list = [A, B];
    const have = ['b'];
    chooseAvailable(list, have);
    assert.deepEqual(idsOf(list), ['a', 'b']);
    assert.deepEqual(have, ['b']);
  });
});
