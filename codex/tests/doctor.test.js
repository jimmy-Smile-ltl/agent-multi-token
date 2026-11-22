// @ts-check
/**
 * `core/doctor.js` 的单元测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ 这个文件里**没有任何一个"文档有多大"的字节数**（§7.11）。
 *
 * 需要字节数的地方（截断检查）一律用**随手编的一对数**（如 1000 vs 999）——
 * 它们和任何真实文档都无关，只用来验证"两个数怎么比、话怎么说"。
 * 真实文档的大小由 `doctor-e2e.test.js` 从磁盘读，一个数字都不写死。
 *
 * 反过来说：这里断言 `CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES` 是**允许**的
 * ——那是 Codex 的配置默认值，不是文档大小（见 `core/doctor.js` 顶部那段）。
 * 而且只 import 名字，不重打字面量。
 * ─────────────────────────────────────────────────────────────
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES,
  PROJECT_LOCAL_IGNORED_KEYS,
  checkBom,
  checkDanglingBindings,
  checkDocTruncation,
  checkProjectLocalIgnoredKeys,
  checkShortName,
  checkTrustState,
  parseProjectDocMaxBytes,
  summarize,
} from '../src/core/doctor.js';
import { EXIT } from '../src/core/errors.js';

// ═══════════════════════ 读配置里的上限 ═══════════════════════

describe('parseProjectDocMaxBytes —— 只认顶层那个键', () => {
  test('没有 → present:false（调用方才知道该不该兜底）', () => {
    assert.deepEqual(parseProjectDocMaxBytes('model = "x"\n'), {
      present: false, value: null, raw: null, malformed: false,
    });
    assert.equal(parseProjectDocMaxBytes('').present, false);
    assert.equal(parseProjectDocMaxBytes(undefined).present, false);
  });

  test('顶层写了 → 读到值', () => {
    const r = parseProjectDocMaxBytes('project_doc_max_bytes = 12345\n');
    assert.deepEqual(r, { present: true, value: 12345, raw: '12345', malformed: false });
  });

  test('★ 只看顶层：表头之后的同名键不是全局上限', () => {
    // 把 `[profiles.x]` 底下的当上限报出来，就是一个"看起来查过了"的假结论
    const text = [
      '[profiles.small]',
      'project_doc_max_bytes = 10',
      '',
      '[model_providers.p]',
      'name = "p"',
      '',
    ].join('\n');
    assert.equal(parseProjectDocMaxBytes(text).present, false);
  });

  test('★ 顶层键在表头**之前**才作数（顺序敏感是有意的）', () => {
    const text = 'project_doc_max_bytes = 999\n[profiles.x]\nname = "y"\n';
    assert.equal(parseProjectDocMaxBytes(text).value, 999);
  });

  test('注释掉的那行不算——否则"我明明注释了"会变成一个假的超限告警', () => {
    assert.equal(parseProjectDocMaxBytes('# project_doc_max_bytes = 5\n').present, false);
    // 行尾注释照常
    assert.equal(parseProjectDocMaxBytes('project_doc_max_bytes = 777 # 我调的\n').value, 777);
  });

  test('★ 引号里的 `#` 不是注释起点（朴素 split 会在这里切错）', () => {
    assert.equal(parseProjectDocMaxBytes('model = "a#b"\nproject_doc_max_bytes = 4242\n').value, 4242);
  });

  test('TOML 整数：`_` 分隔符与进制前缀都认', () => {
    assert.equal(parseProjectDocMaxBytes('project_doc_max_bytes = 1_000_000\n').value, 1000000);
    assert.equal(parseProjectDocMaxBytes('project_doc_max_bytes = 0x1000\n').value, 4096);
    assert.equal(parseProjectDocMaxBytes('project_doc_max_bytes = +500\n').value, 500);
  });

  test('★ 读不懂的值 → malformed，**不猜**（猜出来的上限会伪装成"查过了"）', () => {
    for (const bad of ['"12345"', '1.5', 'abc', 'true', '-1', '']) {
      const r = parseProjectDocMaxBytes(`project_doc_max_bytes = ${bad}\n`);
      assert.equal(r.present, true, `值 ${JSON.stringify(bad)} 应该算"键在"`);
      assert.equal(r.malformed, true, `值 ${JSON.stringify(bad)} 应该算读不懂`);
      assert.equal(r.value, null);
      assert.equal(r.raw, bad);
    }
  });
});

// ═══════════════════════ 截断检查（§6.3 点名的那条）═══════════════════════

describe('★ checkDocTruncation —— 比字节、报"截断到第 N 字节"', () => {
  /** 随手编的一对数——与任何真实文档无关（见文件头） */
  const DOC = 1000;
  const LIMIT = 999;

  test('超限 → warn，且**两个数都出自入参**（没有写死的常量混进话里）', () => {
    const f = checkDocTruncation({ docBytes: DOC, docPath: 'D:/p/AGENTS.md', maxBytes: LIMIT, maxBytesSource: 'config' });
    assert.equal(f?.level, 'warn');
    assert.equal(f?.id, 'doc-truncated');
    assert.match(f.title, new RegExp(String(DOC)), '实际字节数必须出现在话里');
    assert.match(f.title, new RegExp(String(LIMIT)), '上限必须出现在话里');
    assert.match(f.title, new RegExp(`截断到第 ${LIMIT} 字节`), '§5 要求报出"截断到第 N 字节"');
    assert.equal(f.data.overBy, DOC - LIMIT);
  });

  test('★ 换一对数字，话跟着换——证明没有常量泄漏', () => {
    const a = checkDocTruncation({ docBytes: 7, docPath: null, maxBytes: 5, maxBytesSource: 'default' });
    const b = checkDocTruncation({ docBytes: 70000, docPath: null, maxBytes: 3, maxBytesSource: 'config' });
    assert.notEqual(a?.title, b?.title);
    assert.match(a.title, /7 B > .* 5 B/);
    assert.match(b.title, /70000 B > .* 3 B/);
  });

  test('不超限 → ok', () => {
    const f = checkDocTruncation({ docBytes: LIMIT, docPath: null, maxBytes: DOC, maxBytesSource: 'config' });
    assert.equal(f?.level, 'ok');
    assert.equal(f?.id, 'doc-ok');
  });

  test('★ 边界：正好等于上限不算超（`>` 不是 `>=`）', () => {
    assert.equal(checkDocTruncation({ docBytes: 5, docPath: null, maxBytes: 5, maxBytesSource: 'config' })?.id, 'doc-ok');
    assert.equal(checkDocTruncation({ docBytes: 6, docPath: null, maxBytes: 5, maxBytesSource: 'config' })?.id, 'doc-truncated');
  });

  test('没找到文档 → null（"没有文档"不是这条检查的结论，调用方另有话说）', () => {
    assert.equal(checkDocTruncation({ docBytes: null, docPath: null, maxBytes: LIMIT, maxBytesSource: 'config' }), null);
  });

  test('★ 配置读不懂 → warn，且**排在"有没有文档"之前**', () => {
    // 这两个是独立的事：用户的配置坏了，不该因为恰好没有 AGENTS.md 就被吞掉
    const f = checkDocTruncation({ docBytes: null, docPath: null, maxBytes: null, maxBytesSource: 'malformed' });
    assert.equal(f?.id, 'doc-max-bytes-malformed');
    assert.equal(f?.level, 'warn');
  });

  test('文件名从路径里取（两种分隔符都认）', () => {
    for (const p of ['D:/p/AGENTS.md', 'D:\\p\\AGENTS.md']) {
      assert.match(checkDocTruncation({ docBytes: 2, docPath: p, maxBytes: 1, maxBytesSource: 'config' })?.title ?? '', /AGENTS\.md/);
    }
  });
});

// ═══════════════════════ §7.11：源码里不许有文档字节数 ═══════════════════════

describe('★ §7.11 的机器守护：core/doctor.js 里不许出现具体字节常量', () => {
  const SRC = readFileSync(
    fileURLToPath(new URL('../src/core/doctor.js', import.meta.url)), 'utf8',
  );

  test('★ 4 位以上的数字字面量，全文件**只有**那一个配置默认值', () => {
    // 这是 §7.11「别把本文档里的字节数写进任何代码或断言」的可执行版本。
    // 将来谁加一句 `if (bytes > 131072)` 或把某次实测的 108737 抄进注释，
    // 这条会立刻红——而它红了正是好事：那个数字**必然**会过期。
    const found = [...SRC.matchAll(/\b\d{4,}\b/g)].map((m) => m[0]);
    const uniq = [...new Set(found)];
    assert.deepEqual(uniq, [String(CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES)],
      `core/doctor.js 里出现了别的具体数字：${uniq.join('、')}。`
      + '文档大小必须从磁盘读，不许写死（§7.11）');
  });

  test('★ 那条常量只被用来当"配置里没写"时的兜底（全文件只有一处字面量）', () => {
    const literal = String(CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES);
    const hits = SRC.match(new RegExp(literal, 'g')) ?? [];
    assert.equal(hits.length, 1,
      `字面量 ${literal} 在 core/doctor.js 里出现了 ${hits.length} 次——`
      + '注释里也不许重打它：那样下一次改默认值时总有一处会被漏掉。'
      + '要提它就用常量名（§7.11）');
  });
});

// ═══════════════════════ 8.3 短名（§7.3）═══════════════════════

describe('checkShortName —— 只提示，绝不归一化', () => {
  test('win32 短名 → warn', () => {
    const f = checkShortName('C:\\Users\\ALICE~1', 'win32');
    assert.equal(f?.level, 'warn');
    assert.equal(f?.id, 'short-name');
    assert.match(f.hint ?? '', /不替你归一化/, '提示里必须说清"cxt 不动它"');
  });

  test('长名 → null', () => {
    assert.equal(checkShortName('C:\\Users\\alice', 'win32'), null);
    assert.equal(checkShortName('D:/work/proj', 'win32'), null);
  });

  test('★ 非 win32 平台一律 null——`~1` 在 POSIX 上是普通目录名', () => {
    for (const p of ['linux', 'darwin']) {
      assert.equal(checkShortName('/home/ALICE~1', p), null);
    }
  });

  test('空值不炸', () => {
    assert.equal(checkShortName('', 'win32'), null);
    assert.equal(checkShortName(null, 'win32'), null);
    assert.equal(checkShortName(undefined, 'win32'), null);
  });
});

// ═══════════════════════ 信任三态（§7.3）═══════════════════════

describe('★ checkTrustState —— 三态必须报成三条不同的话', () => {
  const P = 'D:\\work\\proj';

  test('★ trusted / untrusted / unmarked → 三个不同的 id', () => {
    const ids = ['trusted', 'untrusted', 'unmarked']
      .map((s) => checkTrustState({ state: /** @type {any} */ (s), path: P })[0].id);
    assert.deepEqual(ids, ['trust-trusted', 'trust-untrusted', 'trust-unmarked']);
  });

  test('★ `untrusted` 与"没记录"的措辞必须分开——否则用户会困惑于"我没标记过它啊"', () => {
    const untrusted = checkTrustState({ state: 'untrusted', path: P })[0];
    const unmarked = checkTrustState({ state: 'unmarked', path: P })[0];
    assert.match(untrusted.title, /显式/);
    assert.match(unmarked.title, /从未标记过/);
    assert.match(untrusted.detail ?? '', /UnlessTrusted/, '要说清走的是哪个审批档位');
    assert.match(unmarked.detail ?? '', /OnRequest/);
    assert.notEqual(untrusted.title, unmarked.title);
  });

  test('★ 未标记的提示里要点明"与 codex exec 的 git 要求无关"（§7.6 那条订正）', () => {
    const f = checkTrustState({ state: 'unmarked', path: P })[0];
    assert.match(f.detail ?? '', /git/);
  });

  test('trusted 是 ok（不是 warn）——已信任不该出现在告警里', () => {
    assert.equal(checkTrustState({ state: 'trusted', path: P })[0].level, 'ok');
  });

  test('★ nearMiss 单独成条：写法错是"静默失配"的元凶', () => {
    const out = checkTrustState({
      state: 'unmarked',
      path: P,
      nearMisses: [{ path: 'D:/work/proj', line: 3, reason: '用了正斜杠' }],
    });
    assert.equal(out.length, 2);
    const nm = out[1];
    assert.equal(nm.id, 'trust-near-miss');
    assert.equal(nm.level, 'warn');
    assert.match(nm.title, /第 3 行/);
    assert.match(nm.title, /用了正斜杠/);
    assert.match(nm.detail ?? '', /D:\/work\/proj/, '要原样回显那条写法');
  });

  test('没有 nearMiss 时不产生多余的条目', () => {
    assert.equal(checkTrustState({ state: 'trusted', path: P }).length, 1);
    assert.equal(checkTrustState({ state: 'trusted', path: P, nearMisses: [] }).length, 1);
  });
});

// ═══════════════════════ 绑定悬空（§3.3）═══════════════════════

describe('checkDanglingBindings', () => {
  test('全部指向存在的 token → ok', () => {
    const [f] = checkDanglingBindings({
      bindings: [{ path: 'D:/a', token: 'x' }, { path: 'D:/b', token: 'y' }],
      tokenNames: ['x', 'y'],
    });
    assert.equal(f.level, 'ok');
    assert.equal(f.data.count, 2);
  });

  test('★ 悬空引用 → warn，且**逐条列出**（§3.3：不静默留悬空绑定）', () => {
    const [f] = checkDanglingBindings({
      bindings: [{ path: 'D:/a', token: 'x' }, { path: 'D:/b', token: 'gone' }],
      tokenNames: ['x'],
    });
    assert.equal(f.level, 'warn');
    assert.match(f.detail ?? '', /D:\/b/);
    assert.match(f.detail ?? '', /gone/);
    assert.equal(f.data.dangling.length, 1);
    assert.equal(f.data.dangling[0].index, 1, '要报出它在 bindings 里的下标');
  });

  test('空绑定表也是 ok', () => {
    assert.equal(checkDanglingBindings({ bindings: [], tokenNames: [] })[0].level, 'ok');
  });
});

// ═══════════════════════ BOM（§7.14①）═══════════════════════

describe('★ checkBom —— 已降级为提示，不是致命错误', () => {
  test('★ 带 BOM → **info**（§7.14①：0.163.0 实测能容忍）', () => {
    const f = checkBom({ text: '\uFEFFmodel = "x"\n', path: 'D:/c.toml' });
    assert.equal(f.id, 'bom-present');
    assert.equal(f.level, 'info', '降级成提示是契约明确要求的——别改回 error');
  });

  test('提示里要说清"能容忍"与"其它工具不一定"两件事', () => {
    const f = checkBom({ text: '\uFEFF', path: 'D:/c.toml' });
    assert.match(f.detail ?? '', /容忍/);
    assert.match(f.detail ?? '', /TOML 规范/);
  });

  test('不带 BOM → ok', () => {
    assert.equal(checkBom({ text: 'model = "x"\n', path: 'D:/c.toml' }).level, 'ok');
    assert.equal(checkBom({ text: '', path: 'D:/c.toml' }).level, 'ok');
  });
});

// ═══════════════════════ 项目级禁区键（§7.3）═══════════════════════

describe('checkProjectLocalIgnoredKeys', () => {
  test('文件不存在 → null（正常情况，不该产生噪音）', () => {
    assert.equal(checkProjectLocalIgnoredKeys(null), null);
  });

  test('没有禁区键 → null', () => {
    assert.equal(checkProjectLocalIgnoredKeys({ text: 'model = "x"\n', path: 'p' }), null);
  });

  test('顶层赋值与表头两种写法都认', () => {
    const a = checkProjectLocalIgnoredKeys({ text: 'model_provider = "p"\n', path: 'p' });
    assert.equal(a?.id, 'project-local-ignored-keys');
    assert.deepEqual(a?.data.keys, ['model_provider']);

    const b = checkProjectLocalIgnoredKeys({ text: '[model_providers.p]\nname = "p"\n', path: 'p' });
    assert.deepEqual(b?.data.keys, ['model_providers']);
  });

  test('★ `sandbox_mode` / `approval_policy` **不**在禁区里（§7.3 点名有清单把它们列错了）', () => {
    const text = [
      'sandbox_mode = "workspace-write"',
      'approval_policy = "on-request"',
      '[sandbox_workspace_write]',
      'network_access = false',
      '',
    ].join('\n');
    assert.equal(checkProjectLocalIgnoredKeys({ text, path: 'p' }), null,
      '把这两个列进禁区是本项目点名纠正过的错误');
  });

  test('重复出现只报一次', () => {
    const f = checkProjectLocalIgnoredKeys({ text: 'notify = []\nnotify = ["a"]\n', path: 'p' });
    assert.deepEqual(f?.data.keys, ['notify']);
  });

  test('注释里的不算', () => {
    assert.equal(checkProjectLocalIgnoredKeys({ text: '# model_provider = "p"\n', path: 'p' }), null);
  });

  test('★ 级别是 info——它只说一句话，不参与任何判定（§7.3：清单随版本演进）', () => {
    const f = checkProjectLocalIgnoredKeys({ text: 'otel = {}\n', path: 'p' });
    assert.equal(f?.level, 'info');
    assert.ok(PROJECT_LOCAL_IGNORED_KEYS.includes('otel'));
    assert.ok(Object.isFrozen(PROJECT_LOCAL_IGNORED_KEYS), '这张清单必须冻住');
  });
});

// ═══════════════════════ 汇总与退出码 ═══════════════════════

describe('★ summarize —— warn 不影响退出码', () => {
  const f = (level) => ({ id: 'x', level, title: 't' });

  test('全 ok → 退出码 0', () => {
    assert.equal(summarize([f('ok'), f('ok')]).exitCode, EXIT.OK);
  });

  test('★ 有 warn / info → **仍然** 0（doctor 是体检不是门禁）', () => {
    const r = summarize([f('ok'), f('warn'), f('warn'), f('info')]);
    assert.equal(r.exitCode, EXIT.OK);
    assert.equal(r.hasError, false);
    assert.deepEqual(r.counts, { ok: 1, info: 1, warn: 2, error: 0 });
  });

  test('★ 有 error → 2', () => {
    const r = summarize([f('warn'), f('error')]);
    assert.equal(r.exitCode, EXIT.ENV);
    assert.equal(r.hasError, true);
  });

  test('空输入 → 0 且全零', () => {
    const r = summarize([]);
    assert.equal(r.exitCode, EXIT.OK);
    assert.deepEqual(r.counts, { ok: 0, info: 0, warn: 0, error: 0 });
  });
});
