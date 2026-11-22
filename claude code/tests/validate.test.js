// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMissing, validateSession } from '../src/core/validate.js';
import { resolveConfig } from '../src/core/resolve.js';
import { normalizeConfig, normalizeToken } from '../src/core/schema.js';

const CTX = { platform: /** @type {NodeJS.Platform} */ ('linux'), home: '/home/t' };
const CWD = '/home/t/work';

const cfg = (raw) => normalizeConfig({ version: 1, ...raw });
const tok = (raw) => normalizeToken(raw, raw.name);

const resolve = (config, token = null, overrides = {}, env = {}) =>
  resolveConfig({ config, token, overrides, cwd: CWD, ctx: CTX, env });

/** 一份四要素齐全的最小配置 */
const FULL = {
  defaults: {
    authToken: 'sk-x',
    baseUrl: 'https://api.example',
    models: [{ id: 'flash' }],
  },
};

describe('validateSession —— 齐全', () => {
  test('四要素齐全 → ok，无缺项', () => {
    const r = validateSession(resolve(cfg(FULL)));
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
  });

  test('★ models 显式 [] 也算齐全（§2.5 规则 3：用 Claude Code 自身默认）', () => {
    const config = cfg({ defaults: { ...FULL.defaults, models: [] } });
    const r = validateSession(resolve(config));
    assert.equal(r.ok, true);
  });
});

describe('validateSession —— 缺项指名', () => {
  test('缺 token → 指出 authToken，并给下一步命令', () => {
    const config = cfg({ defaults: { baseUrl: 'https://a', models: [{ id: 'm' }] } });
    const r = validateSession(resolve(config));
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].key, 'token');
    assert.match(r.missing[0].hint, /cmt token add/);
  });

  test('缺 apiUrl → 指出 baseUrl', () => {
    const config = cfg({ defaults: { authToken: 'sk-x', models: [{ id: 'm' }] } });
    const r = validateSession(resolve(config));
    assert.deepEqual(r.missing.map((m) => m.key), ['apiUrl']);
  });

  test('缺 model → 指出 models', () => {
    const config = cfg({ defaults: { authToken: 'sk-x', baseUrl: 'https://a' } });
    const r = validateSession(resolve(config));
    assert.deepEqual(r.missing.map((m) => m.key), ['model']);
    assert.match(r.missing[0].hint, /cmt model set/);
  });

  test('★ 三项全缺 → 一次全列出来，不是只报第一个', () => {
    const r = validateSession(resolve(cfg({})));
    assert.deepEqual(r.missing.map((m) => m.key).sort(), ['apiUrl', 'model', 'token']);
  });

  test('每一项都带 why（§2.1 的表）', () => {
    const r = validateSession(resolve(cfg({})));
    for (const m of r.missing) {
      assert.ok(m.label && m.why && m.hint, `${m.key} 缺 label/why/hint`);
    }
  });

  test('有 token 名时，提示语带上它（可直接复制粘贴）', () => {
    const config = cfg({ bindings: [{ path: '/home/t/work', token: 'relay-a' }] });
    const r = validateSession(resolve(config, tok({ name: 'relay-a', models: [{ id: 'm' }] })));
    const tokenMissing = r.missing.find((m) => m.key === 'token');
    assert.match(tokenMissing.hint, /cmt token edit relay-a/);
    const urlMissing = r.missing.find((m) => m.key === 'apiUrl');
    assert.match(urlMissing.hint, /cmt token edit relay-a/);
  });
});

describe('validateSession —— ${VAR} 未设置算缺项（§2.4）', () => {
  test('★ 指名变量，退出前能照着修', () => {
    const config = cfg({ defaults: { ...FULL.defaults, authToken: '${MY_KEY}' } });
    const r = validateSession(resolve(config, null, {}, {}));
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing.map((m) => m.key), ['token']);
    assert.match(r.missing[0].hint, /MY_KEY/);
  });

  test('设置好了就齐全', () => {
    const config = cfg({ defaults: { ...FULL.defaults, authToken: '${MY_KEY}' } });
    const r = validateSession(resolve(config, null, {}, { MY_KEY: 'sk-real' }));
    assert.equal(r.ok, true);
  });

  test('未设置的引用不会同时触发"没有 authToken"（只报一次）', () => {
    const config = cfg({ defaults: { ...FULL.defaults, authToken: '${MY_KEY}' } });
    const r = validateSession(resolve(config, null, {}, {}));
    assert.equal(r.missing.filter((m) => m.key === 'token').length, 1);
  });
});

describe('validateSession —— baseUrl 的 ${VAR} 与 authToken 同规则（§2.4）', () => {
  test('★ 指名变量，退出前能照着修', () => {
    const config = cfg({ defaults: { ...FULL.defaults, baseUrl: '${RELAY_BASE_URL}' } });
    const r = validateSession(resolve(config, null, {}, {}));
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing.map((m) => m.key), ['apiUrl']);
    assert.match(r.missing[0].hint, /RELAY_BASE_URL/);
    // 提示语是 URL 味的，不是 authToken 那套 `<key>`
    assert.match(r.missing[0].hint, /<url>/);
  });

  test('设置好了就齐全', () => {
    const config = cfg({ defaults: { ...FULL.defaults, baseUrl: '${RELAY_BASE_URL}' } });
    const r = validateSession(resolve(config, null, {}, { RELAY_BASE_URL: 'https://relay.example.com' }));
    assert.equal(r.ok, true);
  });

  test('★ 未设置的引用不会同时触发"没有 baseUrl"（只报一次）', () => {
    // 守着 validate.js 里的 `else if`——写成两个独立 if 就会同一屏报两条
    const config = cfg({ defaults: { ...FULL.defaults, baseUrl: '${RELAY_BASE_URL}' } });
    const r = validateSession(resolve(config, null, {}, {}));
    assert.equal(r.missing.filter((m) => m.key === 'apiUrl').length, 1);
  });

  test('★ baseUrl 没设不牵连 authToken（两个字段各自判定）', () => {
    const config = cfg({ defaults: { ...FULL.defaults, baseUrl: '${RELAY_BASE_URL}' } });
    const r = validateSession(resolve(config, null, {}, {}));
    assert.equal(r.missing.filter((m) => m.key === 'token').length, 0);
  });

  test('明文 baseUrl 照常通过（别把所有 URL 都当引用）', () => {
    const r = validateSession(resolve(cfg(FULL)));
    assert.equal(r.ok, true);
  });
});

describe('renderMissing —— 人能读，且给下一步', () => {
  test('列出条数与每项的 why / hint', () => {
    const { missing } = validateSession(resolve(cfg({})));
    const text = renderMissing(missing);
    assert.match(text, /缺 3 项/);
    assert.match(text, /无法认证/);
    assert.match(text, /打不到端点/);
    assert.match(text, /不知道用哪个模型/);
    assert.match(text, /cmt token add/);
  });
});

describe('validateSession —— 防御性', () => {
  test('传空对象不炸，报全部缺项', () => {
    const r = validateSession({});
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 4);
  });

  test('空串 cwd 算缺项', () => {
    const good = resolve(cfg(FULL));
    const r = validateSession({ ...good, cwd: { value: '', source: 'cli' } });
    assert.ok(r.missing.some((m) => m.key === 'cwd'));
  });
});
