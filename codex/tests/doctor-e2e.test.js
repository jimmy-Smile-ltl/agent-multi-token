// @ts-check
/**
 * ★ `cxt doctor` 的端到端测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么这条检查必须走端到端
 *
 * §6.3 的契约是：**字节数比较用字节不用字符**（中文一字三字节，用 `.length`
 * 会算出 1/3 的假安全值——这正是本文档超限却"看起来不长"的原因）。
 *
 * 而"用错了 `.length`"是**调用方**的 bug，不是纯函数的 bug：
 * `core/doctor.js` 收的就是字节数，它自己永远是对的。所以
 * `doctor.test.js` 那种"喂两个数进去看话怎么说"的测法**测不到它**——
 * 必须真的在盘上放一个带中文的 AGENTS.md，让 cxt 自己去量。
 *
 * ⇒ 于是这个文件里出现了真实的中文字节。而它是**当场算的**
 * （`Buffer.byteLength(text)`），不是抄来的常量——§7.11 禁的是后者。
 *
 * ## 手法
 *
 * 同 exec-e2e / run-e2e：`USERPROFILE` 指向临时 home，**不碰真的 `~`**。
 * 每个用例自建 `proj/AGENTS.md`，`--cwd` 指过去。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES } from '../src/core/doctor.js';

const ROOT = win32Path.dirname(dirname(fileURLToPath(import.meta.url)));
const CXT = win32Path.join(ROOT, 'bin', 'cxt.js');

const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了——临时目录的事不该影响测试结论 */ }
  }
});

/**
 * 搭一个临时 home：一个 token、一个项目目录。
 *
 * ★ `defaults.token` 指到那个 token —— 否则 profileName 会落到 `_default`，
 * 而下面往 `profiles/<token>/config.toml` 写的 `project_doc_max_bytes`
 * 就读不到了。**这个"写在哪、读在哪"的对齐本身就是被测语义的一部分**
 * （doctor 读的是**解析出来的那个 profile** 的配置，不是随便哪个）。
 *
 * @param {{ docText?: string, docLimit?: string, corruptConfig?: boolean, bindingToken?: string,
 *           noProfile?: boolean }} [o]
 *   `noProfile: true` = **连 `profiles/<token>/` 都不建** —— 用来测 §3.2 的惰性
 *   （受管区不存在时报 info 而不是故障）。默认会建，因为绝大多数用例要往里写配置。
 */
function setup(o = {}) {
  const home = nodeFs.mkdtempSync(win32Path.join(tmpdir(), 'cxt-doctor-'));
  TEMP_HOMES.push(home);
  const appDir = win32Path.join(home, '.codex-multi-token');
  const projDir = win32Path.join(home, 'proj');
  nodeFs.mkdirSync(win32Path.join(appDir, 'tokens'), { recursive: true });
  nodeFs.mkdirSync(projDir, { recursive: true });

  nodeFs.writeFileSync(win32Path.join(appDir, 'config.json'),
    o.corruptConfig === true
      ? '{ this is not json'
      : JSON.stringify({
        version: 1,
        defaults: {
          token: 'relay-a',
          baseUrl: 'https://api.deepseek.com/',
          models: [{ id: 'deepseek-flash', label: 'Flash' }],
        },
        bindings: o.bindingToken === undefined ? [] : [{ path: projDir, token: o.bindingToken }],
      }, null, 2), 'utf8');

  nodeFs.writeFileSync(win32Path.join(appDir, 'tokens', 'relay-a.json'),
    JSON.stringify({ name: 'relay-a', authToken: 'sk-doctor-secret-wxyz' }, null, 2), 'utf8');

  if (o.noProfile !== true && (o.docLimit !== undefined || o.corruptConfig !== true)) {
    const profileDir = win32Path.join(appDir, 'profiles', 'relay-a');
    nodeFs.mkdirSync(profileDir, { recursive: true });
    nodeFs.writeFileSync(win32Path.join(profileDir, 'config.toml'),
      o.docLimit === undefined ? '# 没写 project_doc_max_bytes\n' : `project_doc_max_bytes = ${o.docLimit}\n`,
      'utf8');
  }

  if (o.docText !== undefined) {
    nodeFs.writeFileSync(win32Path.join(projDir, 'AGENTS.md'), o.docText, 'utf8');
  }

  return {
    home,
    appDir,
    projDir,
    docPath: win32Path.join(projDir, 'AGENTS.md'),
    /** 跑一次 `cxt doctor` */
    run(extra = []) {
      const r = spawnSync(process.execPath, [CXT, 'doctor', '--cwd', projDir, ...extra], {
        encoding: 'utf8',
        env: { ...process.env, USERPROFILE: home },
        cwd: ROOT,
      });
      let json = null;
      if (extra.includes('--json') && r.stdout) {
        try { json = JSON.parse(r.stdout); } catch { /* 解析失败就当没给，让断言自己报 */ }
      }
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', json };
    },
  };
}

/** 从 `--json` 输出里取某条 finding */
const finding = (j, id) => (j?.findings ?? []).find((/** @type {any} */ f) => f.id === id);

/** 递归列出一个目录下所有文件的相对路径（用来验"doctor 什么都没写"） */
function tree(dir, base = dir) {
  /** @type {string[]} */
  const out = [];
  for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const p = win32Path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tree(p, base));
    else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}

// ═══════════════════ ★ 字节 vs 字符（§6.3 点名的契约）═══════════════════

describe('★ AGENTS.md 截断检查——用字节不用字符', () => {
  test('★★ 带中文的文档：报出来的字节数 = Buffer.byteLength，**不是** .length', () => {
    // 每行都是中文，一个字三字节 → 字节数约为字符数的三倍。
    // 若实现里写成 `text.length`，报出来的会是 1/3 —— 一个"看起来很安全"的假值。
    const text = `${'中文文档内容，用来验证字节数。\n'.repeat(20)}`;
    assert.notEqual(Buffer.byteLength(text, 'utf8'), text.length,
      '前提：这份测试内容必须是多字节的，否则这条测试是空的');

    const s = setup({ docText: text });
    const r = s.run(['--json']);
    const f = finding(r.json, 'doc-truncated') ?? finding(r.json, 'doc-ok');

    assert.ok(f, `没找到文档检查项：\n${r.out}`);
    assert.equal(f.data.docBytes, Buffer.byteLength(text, 'utf8'),
      '★ 报的必须是**字节数**');
    assert.notEqual(f.data.docBytes, text.length,
      '★ 报成了字符数——中文场景下这会给出三分之一的假安全值');
    assert.equal(f.data.docPath, s.docPath);
  });

  test('★ 超限时的话里同时有"实际字节"和"截断到第 N 字节"（§5 的措辞要求）', () => {
    const text = 'x'.repeat(50);
    const s = setup({ docText: text, docLimit: '10' });
    const r = s.run(['--json']);
    const f = finding(r.json, 'doc-truncated');

    assert.equal(f?.level, 'warn');
    assert.equal(f.data.docBytes, 50);
    assert.equal(f.data.maxBytes, 10);
    assert.equal(f.data.overBy, 40);
    assert.match(f.title, /截断到第 10 字节/);
  });

  test('★ 不超限 → doc-ok（且不该同时出现 doc-truncated）', () => {
    const s = setup({ docText: 'short\n', docLimit: '10000' });
    const r = s.run(['--json']);
    assert.ok(finding(r.json, 'doc-ok'), `实得：\n${r.out}`);
    assert.equal(finding(r.json, 'doc-truncated'), undefined);
  });

  test('★ 边界：正好等于上限 → 不报超限（`>` 不是 `>=`）', () => {
    const s = setup({ docText: 'x'.repeat(10), docLimit: '10' });
    const r = s.run(['--json']);
    assert.ok(finding(r.json, 'doc-ok'));
  });
});

// ═══════════════════ 上限从哪来 ═══════════════════

describe('★ project_doc_max_bytes 的来源', () => {
  test('★ 配置里没写 → 按 Codex 的默认值兜底，并在 data 里标明来源', () => {
    const s = setup({ docText: 'x\n' });
    const r = s.run(['--json']);
    const f = finding(r.json, 'doc-ok') ?? finding(r.json, 'doc-truncated');

    assert.equal(f?.data.maxBytes, CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES);
    assert.equal(f?.data.maxBytesSource, 'default');
  });

  test('★ 配置里写了 → 用配置的，**不是**默认值（默认值只是兜底）', () => {
    // ★ 上限故意取得**远小于**文档：这样"漏读了配置、退回默认值"这种实现
    //   会把结论从 `doc-truncated` 翻成 `doc-ok` —— **id 本身就分得开两种实现**，
    //   不必依赖 data 里那个数字（数字只用来复核方向对不对）。
    const docText = 'x'.repeat(20);
    const s = setup({ docText, docLimit: '4' });
    const r = s.run(['--json']);
    const f = finding(r.json, 'doc-truncated');

    assert.ok(f, `配置里的上限没被读到（退回默认值了）：\n${r.out}`);
    assert.equal(f.data.maxBytes, 4);
    assert.equal(f.data.maxBytesSource, 'config');
    assert.notEqual(f.data.maxBytes, CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES);
    assert.equal(f.data.docBytes, Buffer.byteLength(docText, 'utf8'));
  });

  test('★ 读的是**解析出来的那个 profile** 的配置，不是别的 profile', () => {
    // 上面 setup 把值写进 profiles/relay-a/config.toml，而 defaults.token = relay-a。
    // 若实现里读成了 `_default` 或硬编码路径，这里会退化成"默认值"——
    // 于是 doc-ok，下面那条 assert.ok 会红。
    const s = setup({ docText: 'x'.repeat(20), docLimit: '7' });
    const r = s.run(['--json']);
    const f = finding(r.json, 'doc-truncated');
    assert.ok(f, `没读到 profile 里的配置——多半是读错了 profile：\n${r.out}`);
    assert.equal(f.data.maxBytes, 7);
    assert.equal(f.data.maxBytesSource, 'config', '没读到 profile 里的配置——多半是读错了 profile');
  });

  test('配置里写了但读不懂 → warn 提示，**不猜**上限', () => {
    const s = setup({ docText: 'x\n', docLimit: '"big"' });
    const r = s.run(['--json']);
    const f = finding(r.json, 'doc-max-bytes-malformed');
    assert.equal(f?.level, 'warn');
    assert.match(f.title, /读不出来/);
  });
});

// ═══════════════════ 该报的其它项 ═══════════════════

describe('cxt doctor —— 其它检查项', () => {
  test('★ 找不到 AGENTS.md → info（不是故障）', () => {
    const s = setup({});
    const r = s.run(['--json']);
    const f = finding(r.json, 'doc-absent');
    // ⚠️ 这条依赖一件事：临时 home 的**各级祖先目录里都没有 AGENTS.md**。
    //    查找是从 cwd 逐级向上的（`findDocUpward`），而临时目录挂在 %TEMP% 下，
    //    祖先链出了这个用例的掌控范围。真在 `C:\Users\<你>\AGENTS.md` 放了一份的话，
    //    这里会红——**那是环境的事，不是实现的事**，所以消息里直接说清。
    assert.ok(f, `从 cwd 向上找到了别处的 AGENTS.md（祖先链上有干扰文件）：\n${r.out}`);
    assert.equal(f.level, 'info');
  });

  test('★ 悬空绑定 → warn，并列出引用它的路径', () => {
    const s = setup({ docText: 'x\n', bindingToken: 'ghost' });
    const r = s.run(['--json']);
    const f = finding(r.json, 'bindings-dangling');
    assert.equal(f?.level, 'warn');
    assert.match(f.detail, /ghost/);
    assert.equal(f.data.dangling[0].token, 'ghost');
  });

  test('★ 未信任项目 → warn，且措辞是"从未标记过"（三态之一）', () => {
    const s = setup({ docText: 'x\n' });
    const r = s.run(['--json']);
    const f = finding(r.json, 'trust-unmarked');
    assert.equal(f?.level, 'warn');
    assert.match(f.title, /从未标记过/);
  });

  test('★ 信任记录写法不对（正斜杠）→ 额外报 near-miss（静默失配的元凶）', () => {
    const s = setup({ docText: 'x\n' });
    // 模拟"用户手工写了一条 Codex 认不出的信任"
    nodeFs.writeFileSync(
      win32Path.join(s.appDir, 'profiles', 'relay-a', 'config.toml'),
      `[projects."${s.projDir.replace(/\\/g, '/')}"]\ntrust_level = "trusted"\n`,
      'utf8',
    );
    const r = s.run(['--json']);
    const f = finding(r.json, 'trust-near-miss');
    assert.ok(f, `该报 near-miss：\n${r.out}`);
    assert.match(f.title, /正斜杠/);
  });

  test('★ 受管区尚未创建 → info（§3.2：惰性，不是故障）', () => {
    // ★ 必须 `noProfile`：默认的 setup 会把 config.toml 建出来，
    //   那样测到的是"文件在、受管区漂移"，不是"文件根本还没建"。
    const s = setup({ docText: 'x\n', noProfile: true });
    const r = s.run(['--json']);
    assert.equal(finding(r.json, 'managed-region-absent')?.level, 'info');
    assert.equal(finding(r.json, 'managed-region-drift'), undefined,
      '文件都不存在，不该同时报漂移');
  });

  test('★ 项目级禁区键 → info，并点名是哪几个（§7.3）', () => {
    const s = setup({ docText: 'x\n' });
    nodeFs.mkdirSync(win32Path.join(s.projDir, '.codex'), { recursive: true });
    nodeFs.writeFileSync(win32Path.join(s.projDir, '.codex', 'config.toml'),
      'model_provider = "project-provider"\n[sandbox_workspace_write]\nnetwork_access = false\n', 'utf8');

    const r = s.run(['--json']);
    const f = finding(r.json, 'project-local-ignored-keys');
    assert.equal(f?.level, 'info');
    assert.deepEqual(f.data.keys, ['model_provider'], 'sandbox_* 不在禁区里');
  });
});

// ═══════════════════ 退出码 ═══════════════════

describe('★ cxt doctor 的退出码', () => {
  test('★★ 有警告（会被截断 + 未信任）→ **仍然 0**——体检不是门禁', () => {
    const s = setup({ docText: 'x'.repeat(50), docLimit: '10' });
    const r = s.run(['--json']);
    assert.ok(r.json.counts.warn >= 2, `前提：该有警告，实得 ${JSON.stringify(r.json.counts)}`);
    assert.equal(r.json.counts.error, 0);
    assert.equal(r.code, 0, '★ 警告把退出码顶红了的话，用户会学会无视 doctor');
    assert.equal(r.json.ok, true);
  });

  test('★ 有阻塞项（config.json 坏了）→ 退出码 2，且**不是**崩掉', () => {
    const s = setup({ corruptConfig: true });
    const r = s.run(['--json']);

    assert.equal(r.code, 2, `不该是崩溃退出：${r.err}`);
    assert.equal(r.json.ok, false);
    const f = finding(r.json, 'state-unreadable');
    assert.equal(f?.level, 'error');
    assert.ok(r.json.findings.length > 1, '★ 状态读不出来之后，其它检查**照跑不误**——'
      + '崩掉的话用户就失去了唯一能问诊的工具');
  });
});

// ═══════════════════ 只读 ═══════════════════

describe('★ cxt doctor 不写任何东西', () => {
  test('★ 跑前跑后目录树逐字相同', () => {
    const s = setup({ docText: 'x\n' });
    const before = tree(s.home);
    const r = s.run(['--json']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.deepEqual(tree(s.home), before, '★ doctor 创建或改动了文件');
  });

  test('★ `--json` 是纯 JSON（没有夹杂人读的表格）', () => {
    const s = setup({ docText: 'x\n' });
    const r = s.run(['--json']);
    assert.doesNotThrow(() => JSON.parse(r.out), `--json 的输出不是合法 JSON：\n${r.out.slice(0, 400)}`);
  });

  test('★ `--json` 里不该出现完整凭证（§5 脱敏）', () => {
    const s = setup({ docText: 'x\n' });
    const r = s.run(['--json']);
    // doctor 的 finding 里本来就不该有凭证值；这条守着"将来别顺手加进去"
    assert.equal(r.out.includes('sk-doctor-secret-wxyz'), false);
  });
});
