// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG_DEFAULTS, CATALOG_DERIVED_REQUIRED, CATALOG_RECOMMENDED, CATALOG_REQUIRED,
  buildCatalog, validateCatalog,
} from '../src/core/catalog.js';

const userError = { name: 'CxtError' };

// ═══════════════════════ 常量表自身的完整性 ═══════════════════════

describe('★ 常量表的一致性——守着一类"补了个 undefined"的静默 bug', () => {
  test('每个必填字段都有来源：CATALOG_DEFAULTS 或 CATALOG_DERIVED_REQUIRED', () => {
    // 早先 `priority` 只出现在 CATALOG_REQUIRED 里，两边都没有兜底值，
    // 于是"给已有条目补必填字段"补出个 undefined——而 JSON.stringify 会把它整个丢掉，
    // 产物里那个键**根本不存在**，真机直接拒绝加载整个 config.toml。
    for (const k of CATALOG_REQUIRED) {
      const covered = Object.prototype.hasOwnProperty.call(CATALOG_DEFAULTS, k)
        || CATALOG_DERIVED_REQUIRED.includes(/** @type {any} */ (k));
      assert.ok(covered, `必填字段 ${k} 既不在 CATALOG_DEFAULTS 也不在 CATALOG_DERIVED_REQUIRED 里`);
    }
  });

  test('CATALOG_DEFAULTS 的每个值都是 JSON 可序列化的真值（没有 undefined）', () => {
    for (const [k, v] of Object.entries(CATALOG_DEFAULTS)) {
      assert.notEqual(v, undefined, `${k} 是 undefined——它会被 JSON.stringify 静默丢掉`);
    }
  });

  test('★ 生成物里不存在 undefined 值的键（JSON 往返后逐字节不变）', () => {
    const { catalog } = buildCatalog({ models: [{ id: 'a', label: 'A' }] });
    assert.equal(JSON.stringify(JSON.parse(JSON.stringify(catalog))), JSON.stringify(catalog));
    for (const e of catalog.models) {
      for (const [k, v] of Object.entries(e)) assert.notEqual(v, undefined, `${k} 是 undefined`);
    }
  });
});

/** 一份"真机已验过"的目录条目——`scripts/verify-real-codex.mjs` 用的就是这个形状 */
function verifiedEntry(slug = 'deepseek-chat') {
  return {
    slug,
    display_name: 'DeepSeek Chat',
    description: 'DeepSeek 直连',
    context_window: 65536,
    max_context_window: 65536,
    effective_context_window_percent: 95,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: '快' },
      { effort: 'medium', description: '中' },
      { effort: 'high', description: '深' },
    ],
    input_modalities: ['text'],
    shell_type: 'default',
    visibility: 'list',
    supported_in_api: true,
    priority: 1,
    support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 60_000 },
    experimental_supported_tools: [],
    base_instructions: 'You are a coding agent.',
  };
}

// ═══════════════════════ 生成 ═══════════════════════

describe('buildCatalog —— 新建', () => {
  test('一个模型 → 一条完整条目', () => {
    const { catalog, report } = buildCatalog({ models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }] });
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0].slug, 'deepseek-chat');
    assert.equal(catalog.models[0].display_name, 'DeepSeek Chat');
    assert.deepEqual(report.added, ['deepseek-chat']);
    assert.deepEqual(report.kept, []);
    assert.deepEqual(report.orphans, []);
    assert.equal(report.unchanged, false);
  });

  test('★ 每条都必须带齐真机验过的必填字段（缺一个 = 整个 config.toml 加载失败）', () => {
    const { catalog } = buildCatalog({ models: [{ id: 'm1' }, { id: 'm2' }] });
    for (const e of catalog.models) {
      for (const k of CATALOG_REQUIRED) {
        assert.notEqual(e[k], undefined, `${e.slug} 缺 ${k}`);
      }
      // base_instructions / model_messages 二者必有其一的**自定义**校验
      assert.equal(typeof e.base_instructions, 'string');
    }
  });

  test('没有 label → display_name 退回 slug（别写空串）', () => {
    const { catalog } = buildCatalog({ models: [{ id: 'm1' }] });
    assert.equal(catalog.models[0].display_name, 'm1');
  });

  test('priority 按列表顺序（顺序即优先级）', () => {
    const { catalog } = buildCatalog({ models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    assert.deepEqual(catalog.models.map((m) => m.priority), [0, 1, 2]);
  });

  test('★ 幂等：同一份输入连跑两次，产物逐字节相同', () => {
    const models = [{ id: 'a', label: 'A' }, { id: 'b' }];
    const one = buildCatalog({ models });
    const two = buildCatalog({ models, existing: one.catalog });
    assert.equal(two.report.unchanged, true);
    assert.equal(JSON.stringify(two.catalog), JSON.stringify(one.catalog));
  });

  test('★ 空模型列表 → 抛错，**不是**生成 {"models": []}', () => {
    // 真机实测：空数组会让 Codex 拒绝加载整个 config.toml。
    // 没有模型时正确的做法是**不写**这份文件，而不是写一份空的。
    assert.throws(() => buildCatalog({ models: [] }), userError);
    assert.throws(() => buildCatalog({}), userError);
  });

  test('模型 id 为空 → 抛错', () => {
    assert.throws(() => buildCatalog({ models: [{ id: '' }] }), userError);
  });

  test('同 slug 出现两次 → 只写一条', () => {
    const { catalog, report } = buildCatalog({ models: [{ id: 'a' }, { id: 'a' }] });
    assert.equal(catalog.models.length, 1);
    assert.deepEqual(report.added, ['a']);
  });

  test('★ 默认上下文窗口刻意保守（报小了只是提前压缩，报大了整个会话白跑）', () => {
    const { catalog } = buildCatalog({ models: [{ id: 'a' }] });
    const e = catalog.models[0];
    assert.equal(e.context_window, CATALOG_DEFAULTS.context_window);
    assert.equal(e.max_context_window, CATALOG_DEFAULTS.max_context_window);
    assert.ok(e.truncation_policy.limit < e.context_window);
  });

  test('★ base_instructions 默认空串——不替用户编造系统提示词', () => {
    const { catalog } = buildCatalog({ models: [{ id: 'a' }] });
    assert.equal(catalog.models[0].base_instructions, '');
  });

  test('visibility 默认 list（真机只认 list / none）', () => {
    const { catalog } = buildCatalog({ models: [{ id: 'a' }] });
    assert.equal(catalog.models[0].visibility, 'list');
  });
});

// ═══════════════════════ 与已有文件合并：只补不删 ═══════════════════════

describe('★ buildCatalog —— 重建时保住用户的手工调整', () => {
  test('已存在的同 slug 条目原样保留（用户改过的上下文窗口不能被抹掉）', () => {
    const existing = { models: [{ ...verifiedEntry(), context_window: 200_000, 我加的键: 'x' }] };
    const { catalog, report } = buildCatalog({ models: [{ id: 'deepseek-chat' }], existing });
    assert.equal(catalog.models[0].context_window, 200_000);
    assert.equal(catalog.models[0]['我加的键'], 'x');
    assert.deepEqual(report.kept, ['deepseek-chat']);
    assert.deepEqual(report.added, []);
  });

  test('已存在但缺必填字段 → 补齐，并在报告里点名', () => {
    const existing = { models: [{ slug: 'a', display_name: 'A' }] };
    const { catalog, report } = buildCatalog({ models: [{ id: 'a' }], existing });
    // base_instructions 不在 CATALOG_REQUIRED 里——它走的是"与 model_messages 二者必有其一"
    // 那条**自定义**校验，所以单独算进来
    const expected = [
      ...CATALOG_REQUIRED.filter((k) => k !== 'slug' && k !== 'display_name'),
      'base_instructions',
    ];
    assert.deepEqual([...report.filled.a].sort(), [...expected].sort());
    for (const k of CATALOG_REQUIRED) assert.notEqual(catalog.models[0][k], undefined);
  });

  test('★ 孤儿条目（不在 models 列表里）**保留**，只点名', () => {
    const existing = { models: [verifiedEntry('old-model')] };
    const { catalog, report } = buildCatalog({ models: [{ id: 'new-model' }], existing });
    assert.deepEqual(report.orphans, ['old-model']);
    assert.deepEqual(catalog.models.map((m) => m.slug).sort(), ['new-model', 'old-model']);
  });

  test('★ 只补不删 ⇒ "删掉文件下次自动重建"依然成立（§3.4）', () => {
    const one = buildCatalog({ models: [{ id: 'a' }] });
    const two = buildCatalog({ models: [{ id: 'a' }], existing: one.catalog });
    assert.equal(JSON.stringify(two.catalog), JSON.stringify(one.catalog));
  });

  test('existing 形状不对（裸数组 / 垃圾）→ 当没有，不崩', () => {
    for (const junk of [null, [], 'x', 42, { models: 'nope' }, { nope: 1 }]) {
      const { catalog } = buildCatalog({ models: [{ id: 'a' }], existing: junk });
      assert.equal(catalog.models.length, 1);
    }
  });

  test('已有条目用了 model_messages 而不是 base_instructions → 不再补 base_instructions', () => {
    const existing = { models: [{ ...verifiedEntry(), base_instructions: undefined, model_messages: { instructions_template: '' } }] };
    const { catalog, report } = buildCatalog({ models: [{ id: 'deepseek-chat' }], existing });
    assert.equal(catalog.models[0].base_instructions, undefined);
    assert.ok(!(report.filled['deepseek-chat'] ?? []).includes('base_instructions'));
  });
});

// ═══════════════════════ 校验 ═══════════════════════

describe('validateCatalog —— doctor 用', () => {
  test('自己生成的目录必然通过校验', () => {
    const { catalog } = buildCatalog({ models: [{ id: 'a' }, { id: 'b' }] });
    assert.deepEqual(validateCatalog(catalog), { errors: [], notes: [] });
  });

  test('★ 空 models 是**错误**（真机会拒绝加载整个配置）', () => {
    const { errors } = validateCatalog({ models: [] });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /空数组/);
  });

  test('裸数组 / 非对象 → 错误', () => {
    assert.match(validateCatalog([]).errors[0], /顶层必须是对象/);
    assert.match(validateCatalog('x').errors[0], /顶层必须是对象/);
    assert.match(validateCatalog(null).errors[0], /顶层必须是对象/);
  });

  test('缺必填字段 → 逐个点名', () => {
    const { errors } = validateCatalog({ models: [{ slug: 'a', display_name: 'A' }] });
    for (const k of CATALOG_REQUIRED.filter((x) => x !== 'slug' && x !== 'display_name')) {
      assert.ok(errors.some((e) => e.includes(k)), `没点到 ${k}`);
    }
  });

  test('★ visibility 只认 list / none（真机实测）', () => {
    const base = buildCatalog({ models: [{ id: 'a' }] }).catalog;
    for (const bad of ['default', 'hidden', 'public', 'visible', 'all']) {
      const c = structuredClone(base);
      c.models[0].visibility = bad;
      assert.match(validateCatalog(c).errors.join(), /visibility/);
    }
    for (const ok of ['list', 'none']) {
      const c = structuredClone(base);
      c.models[0].visibility = ok;
      assert.deepEqual(validateCatalog(c).errors, []);
    }
  });

  test('★ truncation_policy = {} 是错误（真机实测会加载失败）', () => {
    const c = buildCatalog({ models: [{ id: 'a' }] }).catalog;
    c.models[0].truncation_policy = {};
    assert.match(validateCatalog(c).errors.join(), /truncation_policy/);
  });

  test('缺 base_instructions 且无 model_messages → 错误', () => {
    const c = buildCatalog({ models: [{ id: 'a' }] }).catalog;
    delete c.models[0].base_instructions;
    assert.match(validateCatalog(c).errors.join(), /base_instructions/);
  });

  test('缺推荐字段 → 只是 notes（提醒会自动压缩时机不对），不是错误', () => {
    const c = buildCatalog({ models: [{ id: 'a' }] }).catalog;
    for (const k of CATALOG_RECOMMENDED) delete c.models[0][k];
    const { errors, notes } = validateCatalog(c);
    assert.deepEqual(errors, []);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /自动压缩/);
  });

  test('同 slug 重复 → notes（真机允许，但只会生效一条）', () => {
    const c = buildCatalog({ models: [{ id: 'a' }] }).catalog;
    c.models.push(structuredClone(c.models[0]));
    assert.deepEqual(validateCatalog(c).errors, []);
    assert.match(validateCatalog(c).notes.join(), /重复/);
  });
});
