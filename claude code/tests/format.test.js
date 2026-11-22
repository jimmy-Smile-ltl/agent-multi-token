// @ts-check
/**
 * `format.js` 的纯函数单测。
 *
 * 重点是 `modelsState` / `modelText`：它守着一个**两种状态长得一样、含义却相反**的坑
 * （§2.3 表）——「三层都没写 models」是**缺项**，「某层显式写了 `models: []`」是**合法**。
 * 两者 `value` 都是空数组，只靠 `declared` 区分。
 *
 * 回归来源：早先 `cmt doctor` / `cmt run --print` 用 `value.map(...).join() || '（显式空）'`
 * 兜底，于是「没声明」也被印成「（显式空）」——偏偏同一屏的下一行就写着「✗ model 不知道用哪个模型」，
 * 一个说合法、一个说缺项，用户看到的是自相矛盾的两句话（本机实测踩到）。
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  displayWidth,
  fieldText,
  isSecretKey,
  maskEnv,
  maskSecret,
  modelText,
  modelsState,
} from '../src/cli/format.js';

// ───────────────────────── modelsState / modelText ─────────────────────────

describe('modelsState —— 「没声明」与「显式空」是两件事（§2.3 表）', () => {
  test('★ 没声明 → missing（缺项，不是"显式空"）', () => {
    assert.equal(modelsState({ value: [], declared: false }), 'missing');
  });

  test('★ 显式声明为 [] → empty（合法）', () => {
    assert.equal(modelsState({ value: [], declared: true }), 'empty');
  });

  test('有列表 → list', () => {
    assert.equal(modelsState({ value: [{ id: 'a' }], declared: true }), 'list');
  });

  test('防御：字段整个缺失也算 missing', () => {
    assert.equal(modelsState(undefined), 'missing');
    assert.equal(modelsState(null), 'missing');
    assert.equal(modelsState({}), 'missing');
  });

  test('防御：declared 为真但 value 缺失 → empty 而非炸', () => {
    assert.equal(modelsState({ declared: true }), 'empty');
  });
});

describe('modelText —— 表格里的一行', () => {
  test('★ missing 与 empty 印出来的话必须不同', () => {
    const missing = modelText({ value: [], declared: false });
    const empty = modelText({ value: [], declared: true });
    assert.notEqual(missing, empty, '这两种状态印成同一句话就是老 bug');
    assert.match(missing, /缺/);
    assert.match(empty, /显式空/);
  });

  test('列表按优先级顺序用 → 连起来', () => {
    const s = modelText({ value: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], declared: true });
    assert.equal(s, 'a → b → c');
  });

  test('单个模型不带箭头', () => {
    assert.equal(modelText({ value: [{ id: 'solo' }], declared: true }), 'solo');
  });
});

// ───────────────────────── 脱敏（§5） ─────────────────────────

describe('脱敏 —— 按**键名**判断，不硬编码 ANTHROPIC_AUTH_TOKEN', () => {
  test('键名命中 TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL 就算密钥', () => {
    for (const k of [
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_API_KEY',
      'MY_SECRET',
      'DB_PASSWORD',
      'AWS_CREDENTIAL',
      'some_apiKey', // 大小写不敏感
    ]) {
      assert.equal(isSecretKey(k), true, `${k} 该被判为密钥`);
    }
  });

  test('普通键名不算密钥', () => {
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL']) {
      assert.equal(isSecretKey(k), false, `${k} 不该被打码`);
    }
  });

  test('打码是「前 3 后 4」，短值不泄漏', () => {
    assert.equal(maskSecret('sk-1234567890abcd'), 'sk-****abcd');
    // 太短就整个盖掉——别让 3+4 的规则把 5 个字符的密钥露出来 2 个
    assert.doesNotMatch(maskSecret('short'), /short/);
  });

  test('maskEnv 只动密钥键，其余原样', () => {
    const out = maskEnv({ ANTHROPIC_AUTH_TOKEN: 'sk-1234567890abcd', ANTHROPIC_BASE_URL: 'https://x.example.com' });
    assert.equal(out.ANTHROPIC_BASE_URL, 'https://x.example.com');
    assert.doesNotMatch(out.ANTHROPIC_AUTH_TOKEN, /1234567890/);
  });

  test('★ env 逃生舱里塞的别的密钥也会被打码（别只认 ANTHROPIC_*）', () => {
    const out = maskEnv({ MY_CUSTOM_SECRET: 'super-secret-value-here' });
    assert.doesNotMatch(out.MY_CUSTOM_SECRET, /secret-value/);
  });
});

// ───────────────────────── fieldText（四要素的「值」列） ─────────────────────────

describe('fieldText —— 引用型 / 明文型 / 打码型，判定只此一处', () => {
  test('空串与 undefined 都印「（缺）」——显示不该比校验（isFilled）宽松', () => {
    assert.equal(fieldText({ value: undefined }), '（缺）');
    assert.equal(fieldText({ value: '' }), '（缺）');
    assert.equal(fieldText(undefined), '（缺）');
  });

  test('引用型：印引用原文 + 设置状态', () => {
    const f = { value: '${RELAY_URL}', ref: { name: 'RELAY_URL', set: true } };
    assert.equal(fieldText(f), '${RELAY_URL}（已设置）');
    assert.equal(fieldText({ ...f, ref: { name: 'RELAY_URL', set: false } }), '${RELAY_URL}（未设置）');
  });

  test('★ 引用型恒不打码——印的是引用，不是值（mask: true 也不许盖住它）', () => {
    const f = { value: '${MY_KEY}', ref: { name: 'MY_KEY', set: true } };
    const s = fieldText(f, { mask: true });
    assert.equal(s, '${MY_KEY}（已设置）');
    assert.doesNotMatch(s, /\*/);
  });

  test('明文型：不打码就原样（端点不是秘密）', () => {
    assert.equal(fieldText({ value: 'https://api.example' }), 'https://api.example');
  });

  test('明文型 + mask：走 maskSecret（密钥）', () => {
    assert.equal(fieldText({ value: 'sk-1234567890abcd' }, { mask: true }), 'sk-****abcd');
  });
});

// ───────────────────────── 对齐 ─────────────────────────

describe('displayWidth —— CJK 算 2 列', () => {
  test('中文是英文的两倍宽', () => {
    assert.equal(displayWidth('abc'), 3);
    assert.equal(displayWidth('中文'), 4);
    assert.equal(displayWidth('中a'), 3);
  });

  test('空串是 0', () => {
    assert.equal(displayWidth(''), 0);
  });
});
