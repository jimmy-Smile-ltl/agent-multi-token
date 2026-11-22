// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseAvailable,
  currentModel,
  isEmptyList,
  mergeModels,
  modelIds,
  modelLabel,
  promoteModel,
  rotateNext,
} from '../src/core/models.js';

// ───────────────────────────── 样本 ─────────────────────────────

const M = (id, label) => (label === undefined ? { id } : { id, label });
const ids = (list) => list.map((m) => m.id);

const THREE = [M('flash', 'Flash 1M'), M('pro', 'V4 Pro'), M('max')];

// ═══════════════════ currentModel / modelIds ═══════════════════

describe('currentModel（models[0] 即本次会话默认模型）', () => {
  test('取首位', () => {
    assert.equal(currentModel(THREE)?.id, 'flash');
  });

  test('空表 → null', () => {
    assert.equal(currentModel([]), null);
  });

  test('没声明 → null', () => {
    assert.equal(currentModel(undefined), null);
  });

  test('不改入参', () => {
    const list = [M('a')];
    currentModel(list);
    assert.deepEqual(list, [M('a')]);
  });
});

describe('modelIds', () => {
  test('顺序即优先级', () => {
    assert.deepEqual(modelIds(THREE), ['flash', 'pro', 'max']);
  });

  test('非数组 → 空表', () => {
    assert.deepEqual(modelIds(undefined), []);
  });
});

describe('modelLabel', () => {
  test('有 label 用 label', () => {
    assert.equal(modelLabel(M('flash', 'Flash 1M')), 'Flash 1M');
  });

  test('没 label 退回 id', () => {
    assert.equal(modelLabel(M('flash')), 'flash');
  });

  test('空 label 也退回 id（空串不是个名字）', () => {
    assert.equal(modelLabel(M('flash', '')), 'flash');
  });
});

// ═══════════════════ ★ 轮转 ═══════════════════

describe('★ rotateNext：轮转一位，候选不耗光（§2.5）', () => {
  test('`[a,b,c]` → `[b,c,a]`', () => {
    assert.deepEqual(ids(rotateNext([M('a'), M('b'), M('c')])), ['b', 'c', 'a']);
  });

  test('★★ 反复 next 能回到原点（轮转而非删除）', () => {
    let list = THREE;
    const start = ids(list);
    for (let i = 0; i < 3; i++) list = rotateNext(list);
    assert.deepEqual(ids(list), start, '转满一圈必须回到最初的顺序');
  });

  test('★ 长度恒定——转多少次都不会少候选', () => {
    let list = THREE;
    for (let i = 0; i < 10; i++) {
      list = rotateNext(list);
      assert.equal(list.length, 3);
    }
  });

  test('★ label 跟着条目走，不会被丢掉', () => {
    const after = rotateNext(THREE);
    assert.equal(after[0].id, 'pro');
    assert.equal(after[0].label, 'V4 Pro', '提拔上来的条目要带着自己的 label');
    assert.equal(after[2].label, 'Flash 1M');
  });

  test('不改入参', () => {
    const list = [M('a'), M('b')];
    rotateNext(list);
    assert.deepEqual(ids(list), ['a', 'b']);
  });

  test('★ 空表 → 报错（码 1），不静默返回空', () => {
    assert.throws(() => rotateNext([]), (err) => err.code === 1 && /没有下一个/.test(err.message));
  });

  test('★ 单项 → 报错而不是 no-op（用户会以为命令坏了）', () => {
    assert.throws(
      () => rotateNext([M('only')]),
      (err) => err.code === 1 && /只有一项/.test(err.message),
    );
  });

  test('报错带 hint（给出下一步命令）', () => {
    try {
      rotateNext([M('only')]);
      assert.fail('应当抛错');
    } catch (err) {
      assert.match(/** @type {any} */ (err).hint, /cxt model set/);
    }
  });
});

// ═══════════════════ ★ 提拔 ═══════════════════

describe('★ promoteModel：提到首位，其余相对顺序不变（§2.5）', () => {
  test('`[a,b,c]` 提拔 `c` → `[c,a,b]`', () => {
    assert.deepEqual(ids(promoteModel([M('a'), M('b'), M('c')], 'c')), ['c', 'a', 'b']);
  });

  test('★ 原首位退到第二，便于 `use a` 切回', () => {
    const after = promoteModel(THREE, 'max');
    assert.deepEqual(ids(after), ['max', 'flash', 'pro']);
    assert.deepEqual(ids(promoteModel(after, 'flash')), ['flash', 'max', 'pro']);
  });

  test('提拔中间项：其余保持相对顺序', () => {
    assert.deepEqual(ids(promoteModel([M('a'), M('b'), M('c'), M('d')], 'c')), ['c', 'a', 'b', 'd']);
  });

  test('★ 目标不在列表 → 插到首位', () => {
    assert.deepEqual(ids(promoteModel([M('a'), M('b')], 'new')), ['new', 'a', 'b']);
  });

  test('★ 不在列表时**不编造 label**', () => {
    const after = promoteModel([M('a', 'A 的标签')], 'new');
    assert.equal(after[0].label, undefined);
  });

  test('空表 + 新 id → `[{id}]`', () => {
    assert.deepEqual(promoteModel([], 'x'), [{ id: 'x' }]);
    assert.deepEqual(promoteModel(undefined, 'x'), [{ id: 'x' }]);
  });

  test('已在首位 → 内容不变（合法的 no-op：用户要的状态已成立）', () => {
    assert.deepEqual(ids(promoteModel(THREE, 'flash')), ['flash', 'pro', 'max']);
  });

  test('★ 提拔不丢项：长度要么不变、要么 +1', () => {
    assert.equal(promoteModel(THREE, 'pro').length, 3);
    assert.equal(promoteModel(THREE, 'brand-new').length, 4);
  });

  test('★ label 跟着条目走', () => {
    const after = promoteModel(THREE, 'pro');
    assert.equal(after[0].label, 'V4 Pro');
  });

  test('不改入参', () => {
    const list = [M('a'), M('b')];
    promoteModel(list, 'b');
    assert.deepEqual(ids(list), ['a', 'b']);
  });
});

// ═══════════════════ 显式空 vs 没声明 ═══════════════════

describe('★ 显式空 `[]` 与"没声明"是两件事（§2.5 规则 4）', () => {
  test('`[]` 是显式空', () => {
    assert.equal(isEmptyList([]), true);
  });

  test('`undefined` 不是显式空（= 继续往上继承）', () => {
    assert.equal(isEmptyList(undefined), false);
  });

  test('非空表不是', () => {
    assert.equal(isEmptyList(THREE), false);
  });
});

describe('★ mergeModels：覆盖层存在即**整体替换**，不做并集（§2.4）', () => {
  test('覆盖层有值 → 整体替换', () => {
    assert.deepEqual(ids(mergeModels(THREE, [M('only')]) ?? []), ['only']);
  });

  test('★ 覆盖层是 `[]` → 结果就是 `[]`（能表达"这个目录不用任何模型"）', () => {
    assert.deepEqual(mergeModels(THREE, []), []);
  });

  test('覆盖层没声明 → 继承', () => {
    assert.deepEqual(mergeModels(THREE, undefined), THREE);
  });

  test('两层都没有 → undefined', () => {
    assert.equal(mergeModels(undefined, undefined), undefined);
  });

  test('★ 不是并集（并集会让"只用 x"无法表达）', () => {
    const merged = mergeModels([M('a'), M('b')], [M('b')]);
    assert.deepEqual(ids(merged ?? []), ['b'], '并集会得到 [a,b]，那是错的');
  });
});

// ═══════════════════ 工作流端到端 ═══════════════════

describe('★ 模型故障切换工作流（§2.5 一等场景）', () => {
  test('next 一次 → 新模型上任；next 满一圈 → 回到起点', () => {
    const start = [M('flash'), M('pro'), M('max')];
    let list = start;

    list = rotateNext(list);
    assert.equal(currentModel(list)?.id, 'pro', '第一个候选挂了，提拔第二个');

    list = rotateNext(list);
    assert.equal(currentModel(list)?.id, 'max');

    list = rotateNext(list);
    assert.deepEqual(ids(list), ids(start), '三个都试过，回到起点');
  });

  test('穿插 use 之后仍不丢项', () => {
    let list = [M('a'), M('b'), M('c')];
    list = rotateNext(list);          // [b,c,a]
    list = promoteModel(list, 'a');   // [a,b,c]
    assert.deepEqual(ids(list), ['a', 'b', 'c']);
    assert.equal(list.length, 3);
  });
});

// ═══════════════════ chooseAvailable（启动前校验的纯逻辑，§2.5）═══════════════════

describe('★ chooseAvailable —— 从优先级里挑第一个端点确实有的', () => {
  test('首位命中 → 原样，picked = 0', () => {
    const list = [M('a', 'A'), M('b'), M('c')];
    const r = chooseAvailable(list, ['a', 'b']);
    assert.deepEqual(ids(r.models), ['a', 'b', 'c']);
    assert.equal(r.picked, 0);
    assert.deepEqual(r.missing, ['c']);
  });

  test('中间命中 → 提到首位，其余保序（与 model next / use 同语义）', () => {
    const r = chooseAvailable([M('a'), M('b'), M('c')], ['c', 'b']);
    assert.deepEqual(ids(r.models), ['b', 'a', 'c']);
    assert.equal(r.picked, 1);
    assert.deepEqual(r.missing, ['a']);
  });

  test('★ label 跟着条目一起走（旋转不能把展示名丢掉）', () => {
    const r = chooseAvailable([M('a'), M('b', 'B 别名')], ['b']);
    assert.equal(r.models[0].label, 'B 别名');
  });

  test('★★ 一个都不命中 → 原样返回 picked = -1，绝不随便挑一个', () => {
    const r = chooseAvailable([M('a'), M('b')], ['x', 'y']);
    assert.deepEqual(ids(r.models), ['a', 'b']);
    assert.equal(r.picked, -1);
    assert.deepEqual(r.missing, ['a', 'b']);
  });

  test('空清单 / 空 models → -1，且不抛', () => {
    assert.equal(chooseAvailable([M('a')], []).picked, -1);
    assert.equal(chooseAvailable([], ['a']).picked, -1);
    assert.equal(chooseAvailable(undefined, ['a']).picked, -1);
    assert.equal(chooseAvailable([M('a')], undefined).picked, -1);
  });

  test('顺序即优先级：命中项不相邻时也取**最靠前**的那个', () => {
    assert.deepEqual(ids(chooseAvailable([M('a'), M('b'), M('c')], ['c', 'b']).models), ['b', 'a', 'c']);
  });

  test('不改入参（两个数组都不改）', () => {
    const list = [M('a'), M('b')];
    const have = ['b'];
    chooseAvailable(list, have);
    assert.deepEqual(ids(list), ['a', 'b']);
    assert.deepEqual(have, ['b']);
  });
});
