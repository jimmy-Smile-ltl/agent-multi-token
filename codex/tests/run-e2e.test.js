// @ts-check
/**
 * ★ `cxt run` 的端到端测试。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 测不了什么，以及为什么
 *
 * "真的弹出一个窗口、窗口里真的跑起 codex"**没法在这里断言**——
 * 那要等一个人去看。§4.4 第 11 步把它列为**本机实测**项，不在这份文件里。
 * 这份文件管的是**弹之前**的那一半：算出来的 argv 对不对、
 * 该拦的有没有拦住、该落盘的有没有落盘、`--print` 有没有骗人。
 *
 * ## 两个手法
 *
 * 1. **`USERPROFILE` 指向临时 home**——不碰真的 `~`（同 exec-e2e）。
 * 2. **`PATH` 里没有 `wt.exe`** → 走 `cmd /c start` 兜底 → `via: 'script'`。
 *    这是**唯一能在本机稳定拿到 `via: 'script'` 的办法**，而脚本路径
 *    （落盘 launch.cmd + 拒绝含密钥的调用）正是最需要测的一条。
 *    ⚠️ 这个手法只对 `--print` 与"该拦的"两组安全——它们都不 spawn。
 *       真去 spawn 会**真的弹一个 cmd 窗口**，所以那两组一律带 `--print`。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';
const ROOT = win32Path.dirname(dirname(fileURLToPath(import.meta.url)));
const CXT = win32Path.join(ROOT, 'bin', 'cxt.js');

const SECRET = 'sk-RUN-secret-value-abcd';

/** 本次跑出来的临时 home，收尾统一删（同 exec-e2e） */
const TEMP_HOMES = [];
after(() => {
  for (const h of TEMP_HOMES) {
    try {
      nodeFs.rmSync(h, { recursive: true, force: true });
    } catch { /* 删不掉就算了——临时目录的事不该影响测试结论 */ }
  }
});

/**
 * @param {{ path?: string, terminalMode?: string }} [opts]
 */
function setup(opts = {}) {
  const home = nodeFs.mkdtempSync(win32Path.join(tmpdir(), 'cxt-run-'));
  TEMP_HOMES.push(home);
  const appDir = win32Path.join(home, '.codex-multi-token');
  nodeFs.mkdirSync(win32Path.join(appDir, 'tokens'), { recursive: true });

  nodeFs.writeFileSync(win32Path.join(appDir, 'config.json'), JSON.stringify({
    version: 1,
    defaults: {
      baseUrl: 'https://api.deepseek.com/',
      wireApi: 'responses',
      models: [{ id: 'deepseek-flash', label: 'Flash' }, { id: 'deepseek-pro', label: 'Pro' }],
      ...(opts.terminalMode === undefined ? {} : { terminalMode: opts.terminalMode }),
    },
    bindings: opts.path === undefined ? [] : [{ path: opts.path, token: 'relay-b' }],
  }, null, 2), 'utf8');

  nodeFs.writeFileSync(win32Path.join(appDir, 'tokens', 'relay-a.json'),
    JSON.stringify({ name: 'relay-a', authToken: SECRET, cwd: 'D:/work/from-token' }, null, 2), 'utf8');
  nodeFs.writeFileSync(win32Path.join(appDir, 'tokens', 'relay-b.json'),
    JSON.stringify({ name: 'relay-b', authToken: 'sk-other-value-wxyz', cwd: 'D:/work/bound' }, null, 2), 'utf8');

  return {
    home,
    appDir,
    profileDir: win32Path.join(appDir, 'profiles', 'relay-a'),
    /**
     * 跑一次 `cxt run`。
     * @param {string[]} extra
     * @param {{ noTerminal?: boolean }} [o] `noTerminal: true` → PATH 里没有 wt，走脚本兜底
     */
    run(extra = [], o = {}) {
      /** @type {Record<string, string | undefined>} */
      const env = { ...process.env, USERPROFILE: home };
      if (o.noTerminal === true) {
        // 只留 System32（`cmd.exe` 靠 %COMSPEC% 找，不走 PATH），
        // 于是 `findExecutable('wt')` 必失败 → cmd 兜底 → via: 'script'
        env.PATH = win32Path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
      }
      const r = spawnSync(process.execPath, [CXT, 'run', ...extra], {
        encoding: 'utf8',
        env,
        cwd: ROOT,
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },
  };
}

// ═══════════════════ --print：只看不跑 ═══════════════════

describe('cxt run --print — 只看不跑', { skip: !IS_WIN }, () => {
  test('★ 不建 profile 目录、不写 config.toml、不落盘脚本', () => {
    const s = setup();
    const r = s.run(['relay-a', '--print']);

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.equal(nodeFs.existsSync(s.profileDir), false, '★ --print 绝不该建目录');
    assert.equal(nodeFs.existsSync(win32Path.join(s.profileDir, 'launch.cmd')), false);
  });

  test('★★ 每条含 cxt 入口的 argv 都必须是**完整命令行**：<node> <cxt.js> exec …', () => {
    // 这条是**真机实测抓出来的**，两个缺陷各错一半、症状还完全不同：
    //
    //  ① 漏 `exec` 关键字 → 窗口里跑的是 `cxt relay-a`，那不是命令，
    //     dispatch 直接报"未知命令"，窗口**一闪而过**。
    //  ② 漏 node 解释器 → 窗口弹出来了，第一行却是
    //     `出现错误 2147942593 (0x800700c1)`：`cxt.js` 是**脚本不是 exe**，
    //     wt 拿它当程序名去 CreateProcess 得到 `ERROR_BAD_EXE_FORMAT`。
    //
    // 两个都**只显示在那个新窗口里**，外面看起来一切正常。而兜底脚本那条路一直是好的
    // （`buildLaunchScript` 自己补了 `exec`、也自己带了 node），
    // 于是症状是"脚本能跑、直连不能跑"，极具欺骗性。
    //
    // ⇒ 现在两处都从 `buildCxtCommandLine()` 取。这条测试守的就是那个源头：
    //   `--print` 里含 cxt 入口的行不止一条（终端的 argv、以及"新窗口里的 cxt exec"），
    //   所以**逐行都要查**——只查一行等于把另一条路放生。
    const s = setup();
    const r = s.run(['relay-a', '--print']);

    const lines = r.out.split('\n').filter((l) => /bin[\\/]cxt\.js/.test(l));
    assert.ok(lines.length >= 1, `--print 里一条含 cxt 入口的 argv 都没有？\n${r.out}`);
    for (const l of lines) {
      assert.match(l, /bin[\\/]cxt\.js["']?\s+exec\s/,
        `★ 这行少了 exec 关键字，照着敲会得到"未知命令"：\n    ${l.trim()}`);

      // ★ cxt 入口前面必须**紧挨着** node 解释器。
      //   用「紧挨着」而不是「这行里出现过 execPath」：后者在一个恰好被打印出来的
      //   无关路径上也能蒙混过关，而这里要守的正是**相邻关系**。
      const at = l.indexOf(CXT);
      assert.notEqual(at, -1, `这行里的 cxt 入口不是我们跑的那个路径？\n    ${l.trim()}`);
      const before = l.slice(0, at).trimEnd();
      assert.ok(before.endsWith(process.execPath),
        '★ cxt.js 前面必须紧跟 node 解释器——它是脚本不是 exe，'
        + `直接当程序名会得到 0x800700C1：\n    ${l.trim()}`);
    }
  });

  test('★ 把"新窗口里那个 cxt 会收到什么"完整说出来', () => {
    const s = setup();
    const r = s.run(['relay-a', '--print']);

    assert.match(r.out, /relay-a/);
    // ★ run 总是把 cwd 转述给 exec（旧契约说"run 不需要 -C"，已订正，见 buildExecArgs）
    assert.match(r.out, /--cwd/, 'run 必须把 cwd 显式交给 exec——终端丢 cwd 时那是唯一的补救');
    assert.match(r.out, /D:\/work\/from-token|D:\\\\work\\\\from-token/,
      '★ token.cwd 要在 run 这条路上生效（§2.3 第五条：exec 才跳过它）');
    assert.match(r.out, /CODEX_HOME/);
  });

  test('★ 凭证在 --print 里打码（§5）——argv 里那个是独立元素，得按参数名认', () => {
    const s = setup();
    const r = s.run(['relay-a', '--token-value', SECRET, '--print']);

    assert.equal(r.out.includes(SECRET), false, '★ 完整凭证出现在 --print 里就是 §5 被破了');
    assert.match(r.out, /sk-\*+/, '应该是打码形态');
  });

  test('★ `-c` 转述给新窗口', () => {
    const s = setup();
    const r = s.run(['relay-a', '-c', '--print']);
    assert.match(r.out, /-c/, 'resume 必须转述——否则新窗口里的 codex 不会续会话');
  });

  test('★ 用户 `--` 之后的 codex 参数转述给新窗口', () => {
    const s = setup();
    // ⚠️ `--print` 必须排在 `--` **之前**：`--` 之后的**一切**都进 rest 透传，
    //    写在后面会被当成 codex 的参数发给 codex（这条本身也是要守的语义）
    const r = s.run(['relay-a', '--print', '--', '--no-alt-screen', '--foo=bar']);
    assert.match(r.out, /--no-alt-screen/);
    assert.match(r.out, /--foo=bar/);
  });

  test('★ `--` 之后的参数**不会**被当成 cxt 自己的选项吃掉', () => {
    const s = setup();
    // 若 `--` 分隔失效，`--cwd` 会被 cxt 解析走，于是 exec 收到的是 D:/elsewhere
    // 而不是 token.cwd——这条断言守的是"分隔符真的生效了"
    const r = s.run(['relay-a', '--print', '--', '--cwd', 'D:/elsewhere']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /D:\/work\/from-token/, 'token.cwd 仍该生效');
    assert.match(r.out, /--cwd D:\/elsewhere|--cwd D:\\\\elsewhere/,
      '`--` 之后的 --cwd 是**给 codex 的**，得原样透传');
  });

  test('★ 绑定命中的目录：不带 token 名也能解析出 token', () => {
    const s = setup({ path: 'D:/work/bound' });
    const r = s.run(['--cwd', 'D:/work/bound', '--print']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /relay-b/, '绑定表该命中 relay-b');
  });
});

// ═══════════════════ 兜底路径（via: 'script'）═══════════════════

describe('★ cxt run 的脚本兜底路径（PATH 里没有 wt → cmd /c start）', { skip: !IS_WIN }, () => {
  test('★ --print 会标出 via script，并说明要落盘脚本', () => {
    const s = setup();
    const r = s.run(['relay-a', '--print'], { noTerminal: true });

    assert.equal(r.code, 0, `stderr:\n${r.err}`);
    assert.match(r.out, /script/, '该走脚本兜底');
    assert.match(r.out, /launch\.cmd/);
    // ★ 兜底路径丢 cwd（§7.14⑤）——所以 --cwd 的转述在这条路上更关键
    assert.match(r.out, /--cwd/);
  });

  test('★ 仍然不落盘（--print 就是 --print）', () => {
    const s = setup();
    s.run(['relay-a', '--print'], { noTerminal: true });
    assert.equal(nodeFs.existsSync(s.profileDir), false);
  });

  test('★ ★ `--token-value` 在这条路上被**拒绝**——脚本会被复制/备份/贴进 issue', () => {
    const s = setup();
    const r = s.run(['relay-a', '--token-value', SECRET, '--print'], { noTerminal: true });

    assert.equal(r.code, 1, '必须拒绝，而不是"写进去再警告"');
    assert.match(r.err, /token-value|密钥/);
    assert.equal(r.err.includes(SECRET), false, '报错信息本身也不该回显密钥');
    assert.equal(nodeFs.existsSync(s.profileDir), false, '★ 拒绝就要在落盘之前拒绝');
  });

  test('★ 拒绝发生在 `--print` 之前——`--print` 不许展示一个注定失败的方案', () => {
    // 用户出问题时第一反应就是 `--print`。那时给他看一个"看起来很完美、
    // 一跑就报错"的方案，比不给看更糟。
    const s = setup();
    const r = s.run(['relay-a', '--token-value', SECRET, '--print'], { noTerminal: true });
    assert.equal(r.out.includes('将要执行'), false, '不该先打印方案再报错');
  });

  test('直接拉起那条路上 `--token-value` 是**允许**的（只活在进程 argv 里，不落盘）', () => {
    const s = setup();
    const r = s.run(['relay-a', '--token-value', SECRET, '--print']);
    assert.equal(r.code, 0, `stderr:\n${r.err}`);
  });
});

// ═══════════════════ 该拦的必须拦住 ═══════════════════

describe('cxt run — 该拦的必须拦住', { skip: !IS_WIN }, () => {
  test('★ 四要素不齐 → 退出码 1', () => {
    const s = setup();
    nodeFs.writeFileSync(win32Path.join(s.appDir, 'tokens', 'bare.json'),
      JSON.stringify({ name: 'bare' }, null, 2), 'utf8');
    const r = s.run(['bare', '--print']);
    assert.equal(r.code, 1);
    assert.match(r.err, /四要素不齐全/);
  });

  test('★ 不存在的 token → 退出码 1', () => {
    const s = setup();
    const r = s.run(['nope', '--print']);
    assert.equal(r.code, 1);
    assert.match(r.err, /nope/);
  });

  test('★ 路径穿越的 token 名被拒（§2.8）', () => {
    const s = setup();
    const r = s.run(['../../etc/passwd', '--print']);
    assert.equal(r.code, 1);
    assert.match(r.err, /路径分隔符/);
  });

  test('★ `--model` 与 `--pick` 同时给 → 冲突（§2.5，两者都是"显式指定模型"）', () => {
    const s = setup();
    const r = s.run(['relay-a', '--model', 'x', '--pick', '--print']);
    assert.equal(r.code, 1);
    assert.match(r.err, /--pick|--model/);
  });

  test('★ `--pick` 在非 TTY 下报错而不是挂住（run 可能被脚本调起）', () => {
    const s = setup();
    // spawnSync 的 stdin 默认是 pipe → stdinIsTTY 为 false
    const r = s.run(['relay-a', '--pick', '--print']);
    assert.equal(r.code, 1);
    assert.match(r.err, /终端|--model/);
  });
});
