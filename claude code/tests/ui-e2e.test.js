// @ts-check
/**
 * ★★ `cmt ui` 面板的端到端测试——走 `CMT_UI=plain` 那条路。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么 e2e 走 plain 而不是真 TTY
 *
 * 全屏面板要 raw mode + 备用屏，测试进程里造不出来（也**不该**造：那要真的
 * 抢一个终端）。`CMT_UI=plain` 是同一个 reducer、同一份 `renderLines()`，
 * 只换了两件事：输出方式（逐行而非定位）与输入方式（一行而非按键）。
 * 于是"向导四步走通没有""写到哪一层去了"这类**状态机与落盘**的问题
 * 在这里全能测到——真 TTY 独有的部分（进/出备用屏、光标、还原序列）
 * 归 `term.test.js` 与 `scripts/verify-ui-real.mjs`。
 *
 * ## 这份文件守的是什么
 *
 * 1. **★★ 入口的几条路**（§2.12 一）。非 TTY 的 `cmt ui` 必须**明确报错**
 *    （退出 1），而非 TTY 的裸 `cmt` 必须**立刻退出 0**——而且**没起过服务器**。
 *    后者是给脚本的承诺：`cmt` 出现在 CI 里不能变成一个等输入（或者更糟：
 *    一个活着不退）的程序。★ 而且 `CMT_UI` **不许**改变裸 `cmt` 的行为——
 *    那个变量的意思是"面板换一种画法"，不是"把非交互的 cmt 变成交互的"。
 *    这条对 `plain` 和 `web` 两个值都成立，两个各有一条测试。
 * 2. **★★ 向导四步真的落了两处盘**（§2.12 四）：全局 `config.bindings`
 *    **且** 项目 `.cmt.json`。用户原话就是"两个都写"。
 * 3. **★★「当前目录」那一行必须能启动、能改模型**。它的身份来自
 *    `prepareSession()` 的**级联**（项目本地 → 绑定 → defaults），不是
 *    某一条绑定——所以"这一项有没有 token"**不能**看它有没有绑定，
 *    得看解析结果。（这条在 `cxt` 那边真的写错过一次：`source` 明明印着
 *    「项目本地」，回车却说"没有绑定身份"，而那是裸 `cmt` 落上去的第一行。
 *    两份 `commands/ui.js` 的这段逻辑同源，所以这条断言在这边同样承重。）
 * 4. **★ `e` 写回的是"生效层"，不是"绑定的那一层"**（§2.11 五）。
 *    写到一个不生效的地方 = 命令静默失效。
 * 5. **★ 面板输出里不出现明文密钥**（§2.7）。面板是最容易把 sk 漏出去的地方
 *    ——它满屏都在显示身份。
 * 6. **★ 逐行模式输出里不许有裸 ANSI**（§2.12 七）。这条是从 `cxt` 那边
 *    一起带过来的：它的第一版漏了，`[1mcxt 面板[0m` 直接打在管道里——
 *    那种输出喂给 `grep` 是乱码，喂给日志是垃圾。同一份排版内核，同一个坑。
 * ─────────────────────────────────────────────────────────────
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { request } from 'node:http';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 as win32Path } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = win32Path.dirname(win32Path.dirname(fileURLToPath(import.meta.url)));
const CMT = win32Path.join(ROOT, 'bin', 'cmt.js');

/** 长名基准（`os.tmpdir()` 给的是 8.3 短名，见 token 相关 e2e 的说明） */
const TMP_BASE = nodeFs.realpathSync.native(tmpdir());

/** 一次性丢弃的测试密钥。★ 绝不用真 key——这份文件会被读、被复制。 */
const FAKE_KEY = 'sk-test-9999';

const TEMP_ROOTS = [];
after(() => {
  for (const r of TEMP_ROOTS) {
    try {
      nodeFs.rmSync(r, { recursive: true, force: true });
    } catch { /* 删不掉就算了 */ }
  }
});

/**
 * 一个沙箱：临时 home + 一个项目目录。
 *
 * ★ 靠 `USERPROFILE` 隔离——`os.homedir()` 在 Windows 上认它（已实测），
 * 所以**不必**碰用户真实的 `~/.claude-multi-token`。这是整个 e2e 的前提。
 *
 * @param {{ config?: any, tokens?: Record<string, any>, project?: any }} [opts]
 */
function setup(opts = {}) {
  const root = nodeFs.mkdtempSync(join(TMP_BASE, 'cmt-ui-'));
  TEMP_ROOTS.push(root);
  const home = join(root, 'home');
  const proj = join(root, 'proj');
  const appDir = join(home, '.claude-multi-token');
  nodeFs.mkdirSync(join(appDir, 'tokens'), { recursive: true });
  nodeFs.mkdirSync(proj, { recursive: true });

  const write = (p, obj) => nodeFs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');

  if (opts.config !== undefined) write(join(appDir, 'config.json'), opts.config);
  for (const [name, obj] of Object.entries(opts.tokens ?? {})) {
    write(join(appDir, 'tokens', `${name}.json`), obj);
  }
  if (opts.project !== undefined) write(join(proj, '.cmt.json'), opts.project);

  const configPath = join(appDir, 'config.json');
  const projectPath = join(proj, '.cmt.json');

  return {
    root, home, proj, appDir, configPath, projectPath,
    readConfig: () => JSON.parse(nodeFs.readFileSync(configPath, 'utf8')),
    readToken: (n) => JSON.parse(nodeFs.readFileSync(join(appDir, 'tokens', `${n}.json`), 'utf8')),
    readProject: () => JSON.parse(nodeFs.readFileSync(projectPath, 'utf8')),
    hasProject: () => nodeFs.existsSync(projectPath),

    /**
     * @param {string[]} extra 命令与参数（不含 `cmt` 自己）
     * @param {{ input?: string, env?: Record<string, string> }} [o]
     */
    run(extra, o = {}) {
      const r = spawnSync(process.execPath, [CMT, ...extra], {
        encoding: 'utf8',
        input: o.input ?? '',
        cwd: proj,
        env: {
          ...process.env,
          USERPROFILE: home,
          HOME: home,          // POSIX 侧同一个意思；设了不亏
          NO_COLOR: '1',
          // 尺寸钉死：布局退化会改变可见行数，断言才稳
          CMT_UI_COLS: '96',
          CMT_UI_ROWS: '14',
          ...(o.env ?? {}),
        },
      });
      return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
    },

    /** 走逐行面板。`input` 每行一次按键/一次输入。 */
    panel(input) {
      return this.run(['ui'], { input, env: { CMT_UI: 'plain' } });
    },
  };
}

/** 跑一次完整向导：路径 → 身份 → 模型 → 落点 */
const WIZARD_INPUT = [
  'n',            // 新建
  '',             // 第 1 步：回车用预填的路径（= cwd = proj）
  '',             // 第 2 步：回车选上「+ 新建 token…」
  'relay-z',      //          名字
  FAKE_KEY,       //          密钥
  'm',            // 第 3 步：拉不到清单 → 手敲 id
  'gpt-9-probe',  //          手敲的 id
  '',             //          回车收下
  '',             // 第 4 步：回车写入
  ':q',
].join('\n') + '\n';

// ═══════════════════ 入口三条路 ═══════════════════

describe('cmt ui —— 入口', () => {
  test('★★ 非 TTY 跑 `cmt ui` → 退出 1，且说清出路', () => {
    const s = setup();
    const r = s.run(['ui']);
    assert.equal(r.code, 1);
    assert.match(r.err, /面板需要终端/);
    // ★ 报错必须给下一步。只说"需要终端"等于把用户丢在原地
    assert.match(r.err, /CMT_UI=plain/);
  });

  test('★★ 非 TTY 裸 `cmt` → 打印用法，退出 0，**没起服务器**（脚本不受影响）', () => {
    const s = setup();
    const r = s.run([]);
    assert.equal(r.code, 0);
    assert.match(r.out, /cmt <命令> \[选项\]/);
    // ★ 用的是那一组的**组名**（`前端`）——不是"面板"。裸 `cmt` 开的是网页控制台，
    //   所以那一组里坐着两个前端；组名要是还叫「面板」，`--help` 就在说谎。
    assert.match(r.out, /前端/);
    // ★★ 这一条是**补的**，因为真出过事：`help.js` 一度写着
    //    「裸 `cmt`（不带参数）在终端里**就是它**」——把裸命令指成了 TUI。
    //    那句话是**假的**（裸 `cmt` 开的是控制台），而当时这里的断言（只要出现
    //    「面板」二字）照样绿。所以钉的是"用法里**必须有** `--web` 这条"：
    //    它一旦丢了，就等于命令面把控制台从文档里删掉了——而裸命令正开着它。
    assert.match(r.out, /--web/);
    // ★★ 「没起服务器」的判据。`spawnSync` 能返回本身就说明进程退了
    //    （服务器是活到被关掉为止的），但"退了"不等于"没起过"——
    //    起过、然后被空闲超时收掉，也是"退了"。所以断言它**一个字都没宣告**。
    //    宣告只有一处：`runWeb()` 打的那行 URL。
    assert.doesNotMatch(r.out, /网页控制台已启动/);
    assert.doesNotMatch(r.out, /127\.0\.0\.1/);
  });

  test('★★ `CMT_UI=plain` 不许把裸 `cmt` 变成会等输入的程序', () => {
    const s = setup();
    const r = s.run([], { env: { CMT_UI: 'plain' } });
    assert.equal(r.code, 0);
    assert.match(r.out, /cmt <命令> \[选项\]/);
  });

  test('★★ `CMT_UI=web` 也不许——它同样是"换一种画法"，不是"换一个入口"', () => {
    const s = setup();
    const r = s.run([], { env: { CMT_UI: 'web' } });
    assert.equal(r.code, 0);
    assert.match(r.out, /cmt <命令> \[选项\]/);
    // ★ 这一条比上一条更要紧：`web` 是**会起服务器**的那个值，
    //   在管道里它一旦生效，`cmt | grep` 就永远等不到 EOF 了。
    assert.doesNotMatch(r.out, /网页控制台已启动/);
    assert.doesNotMatch(r.out, /127\.0\.0\.1/);
  });

  test('`cmt ui --help` → 退出 0，且不进面板', () => {
    const s = setup();
    const r = s.run(['ui', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.out, /cmt ui/);
    assert.match(r.out, /CMT_UI=plain/);
  });
});

// ═══════════════════ 逐行面板 ═══════════════════

describe('cmt ui —— 逐行模式（CMT_UI=plain）', () => {
  test('★ 输出里没有裸 ANSI 转义', () => {
    const s = setup();
    const r = s.panel(':q\n');
    assert.equal(r.code, 0);
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(r.out, /\u001b\[/);
    assert.match(r.out, /cmt 面板/);
  });

  test('★★ 向导四步：全局绑定与项目 .cmt.json **两个都写**', () => {
    const s = setup();
    const r = s.panel(WIZARD_INPUT);
    assert.equal(r.code, 0, r.err);

    // ① 全局：一条指向 proj 的绑定
    const cfg = s.readConfig();
    assert.equal(cfg.bindings.length, 1);
    assert.equal(cfg.bindings[0].token, 'relay-z');
    assert.equal(
      win32Path.normalize(cfg.bindings[0].path).toLowerCase(),
      win32Path.normalize(s.proj).toLowerCase(),
    );

    // ② 身份：新 token 落盘了
    assert.equal(s.readToken('relay-z').authToken, FAKE_KEY);

    // ③ 项目本地：token + 勾选的模型（勾选顺序即优先级）
    const proj = s.readProject();
    assert.equal(proj.version, 1);
    assert.equal(proj.token, 'relay-z');
    assert.deepEqual(proj.models, [{ id: 'gpt-9-probe' }]);
  });

  test('★★ 面板输出里不出现明文密钥', () => {
    const s = setup();
    const r = s.panel(WIZARD_INPUT);
    assert.equal(r.code, 0, r.err);
    assert.ok(!r.out.includes(FAKE_KEY), '明文密钥漏进面板输出了');
    assert.ok(!r.err.includes(FAKE_KEY), '明文密钥漏进 stderr 了');
    // 打码的那一份要在——否则上面那条可能是"什么都没显示"换来的
    assert.match(r.out, /sk-\*{4}9999/);
  });

  test('★★「当前目录」那一行的身份来自级联，不来自绑定', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { 'relay-z': { authToken: FAKE_KEY, name: 'relay-z' } },
      project: { version: 1, token: 'relay-z', models: [{ id: 'gpt-9-probe' }] },
    });
    const r = s.panel(':q\n');
    assert.equal(r.code, 0, r.err);

    // 图例里那一行带上了身份 ⇒ `activate()` / `startEdit()` 不会再判它"没有绑定身份"
    assert.match(r.out, /1\) 当前目录 → relay-z/);
    // 而且来源层说对了
    assert.match(r.out, /source:\s*项目本地/);
  });

  test('★ `e` 改模型写回**生效层**（项目本地），全局配置一个字不动', () => {
    const s = setup({
      config: { version: 1, defaults: {}, bindings: [] },
      tokens: { 'relay-z': { authToken: FAKE_KEY, name: 'relay-z' } },
      project: {
        version: 1,
        token: 'relay-z',
        models: [{ id: 'keep-me' }, { id: 'drop-me' }],
      },
    });
    const before = nodeFs.readFileSync(s.configPath, 'utf8');

    // e → 取消勾选第 2 个 → 回车写入 → 退出
    const r = s.panel('e\n2\n\n:q\n');
    assert.equal(r.code, 0, r.err);

    assert.deepEqual(s.readProject().models, [{ id: 'keep-me' }]);
    assert.equal(nodeFs.readFileSync(s.configPath, 'utf8'), before, '全局配置被动了');
    // 改的是**项目本地**那一层——落点得说出来
    assert.match(r.out, /项目本地/);
  });

  test('★ `d` 删绑定只删全局那一条，项目 .cmt.json 原样留着（§3.2 惰性）', () => {
    const s = setup({
      config: {
        version: 1,
        defaults: {},
        bindings: [{ path: 'D:\\work\\client-a', token: 'relay-z' }],
      },
      tokens: { 'relay-z': { authToken: FAKE_KEY, name: 'relay-z' } },
      project: { version: 1, token: 'relay-z' },
    });
    const projBefore = nodeFs.readFileSync(s.projectPath, 'utf8');

    // j 移到第 2 项（那条绑定）→ d 删 → y 确认 → 退出
    const r = s.panel('j\nd\ny\n:q\n');
    assert.equal(r.code, 0, r.err);

    assert.deepEqual(s.readConfig().bindings, []);
    assert.equal(nodeFs.readFileSync(s.projectPath, 'utf8'), projBefore);
    assert.match(r.out, /敲 y 确认/);
  });
});

// ═══════════════════ 网页控制台（--web） ═══════════════════

/**
 * 发一个 HTTP 请求。
 *
 * ★ 这里**故意**不用 `fetch()`，只为一件事：**`Origin` 得由我说了算**。
 *   `Origin` 在浏览器里是"禁止设置"的请求头，而 `fetch()` 是照浏览器的规矩
 *   实现的——它会不会被悄悄抹掉，取决于手上这个 Node 的版本。而下面那条测试
 *   守的**恰恰是** `Origin` 校验（`serve-web.js` 的 S4：POST 缺 `Origin` 一律
 *   403）。用一条可能被抹平的路径去测它，测出来的"通过"什么都说明不了。
 *
 * @param {string} method
 * @param {string} url
 * @param {{ headers?: Record<string, string>, body?: string }} [o]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, text: string }>}
 */
function httpReq(method, url, o = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers: o.headers ?? {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { text += d; });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        });
      },
    );
    r.on('error', reject);
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}

/**
 * 起一个**真的**控制台进程，等它把那行 URL 打出来。
 *
 * ★ `--no-open`：这条测试要在开发机上跑，不加它 `openHostBrowser()` 会真的
 *   弹出一个浏览器窗口——测试不许有这种副作用（CI 上更是没有浏览器）。
 *
 * ★ 走 `spawn` 而不是 `spawnSync`：这个进程**活到被关掉为止**，同步版会
 *   一直卡在这儿。
 *
 * ★ `stdio: ['ignore','pipe','pipe']` ⇒ 两个 TTY 都不是。这正是要证的：
 *   `--web` **绕过 TTY 闸门**（它不需要终端），地位等同 `CMT_UI=plain`。
 *
 * @param {ReturnType<typeof setup>} s
 * @returns {{ url: Promise<string>, done: Promise<{ code: number | null, out: string, err: string }>, child: import('node:child_process').ChildProcess }}
 */
function startWeb(s) {
  const child = spawn(process.execPath, [CMT, 'ui', '--web', '--no-open'], {
    cwd: s.proj,
    env: { ...process.env, USERPROFILE: s.home, HOME: s.home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { err += d; });

  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, out, err }));
  });

  const url = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`20 秒没等到 URL。\nstdout:\n${out}\nstderr:\n${err}`));
    }, 20_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/)/.exec(out);
      if (m !== null) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('close', () => {
      clearTimeout(timer);
      reject(new Error(`没报出 URL 就退了（code=${child.exitCode}）。`
        + `\nstdout:\n${out}\nstderr:\n${err}`));
    });
  });

  return { url, done, child };
}

describe('cmt ui —— 网页控制台（--web）', () => {
  test('★★ 非 TTY 起得来；页面读得到状态，「退出」点得掉、进程退得干净', async () => {
    const s = setup({ config: { version: 1, defaults: {}, bindings: [] } });
    const w = startWeb(s);
    try {
      const raw = await w.url;
      const base = new URL(raw);

      // ★ 口令的形状：32 位 hex、**只在路径里**——不是查询串、不是头。
      //   顺带钉住了"只绑回环"：主机名必须是字面量 127.0.0.1。
      assert.match(base.pathname.slice(1, -1), /^[0-9a-f]{32}$/);
      assert.equal(base.hostname, '127.0.0.1');
      assert.equal(base.search, '');

      // ① 页面本体
      const page = await httpReq('GET', raw);
      assert.equal(page.status, 200);
      assert.match(String(page.headers['content-type'] ?? ''), /text\/html/);

      // ② 状态：起手就在屏 1
      const state = await httpReq('GET', new URL('api/state', raw).href);
      assert.equal(state.status, 200);
      const view = JSON.parse(state.text);
      assert.equal(view.screen, 'list');
      assert.ok(typeof view.appName === 'string' && view.appName !== '');
      assert.ok(Array.isArray(view.items));

      // ③ 「退出」：POST + 口令 + Origin 三个都对才收
      const quit = await httpReq('POST', new URL('api/op', raw).href, {
        headers: { 'content-type': 'application/json', origin: base.origin },
        body: JSON.stringify({ op: 'quit' }),
      });
      assert.equal(quit.status, 200);
      // ★★ 回的是**视图模型本身**，与 `GET api/state` 同一个形状——不是
      //    `{view, done}` 那种信封。`done` 是 `ui-web.js` 告诉 `serve-web.js`
      //    的收尾信号（"回完这条就关"），不上线；上线的是视图里的 `quitting`，
      //    页面（`web/app.js` 的 `takeView()`）就靠它把自己关掉。
      //    ⚠️ 这一条曾经真的对不上：前端读 `data.view`，服务端发裸视图。
      assert.equal(JSON.parse(quit.text).quitting, true);

      // ④ `done:true` 真的把进程放走了——**退出码 0**，不是被杀的、不是超时的
      const r = await w.done;
      assert.equal(r.code, 0, r.err);
    } finally {
      if (w.child.exitCode === null) w.child.kill();
    }
  });

  test('★ 口令不对一律 404——连"哪些路径存在"都问不出来', async () => {
    const s = setup({ config: { version: 1, defaults: {}, bindings: [] } });
    const w = startWeb(s);
    try {
      const raw = await w.url;
      // ★ 从**真口令**改一位造一个假的：这样测的是"值对不对"，
      //   而不是"像不像一个 32 位 hex"——后者是个更弱的性质。
      const real = new URL(raw).pathname.slice(1, -1);
      const fake = (real[0] === '0' ? '1' : '0') + real.slice(1);
      const bad = new URL(raw);
      bad.pathname = `/${fake}/`;

      assert.equal((await httpReq('GET', bad.href)).status, 404);
      // ★ 资产也在口令后面：不是"页面随便开、只有数据要口令"
      assert.equal((await httpReq('GET', new URL('app.js', bad.href).href)).status, 404);
      // ★ 而真口令那份是好的——否则上面两条可能是"什么都 404"换来的
      assert.equal((await httpReq('GET', new URL('app.js', raw).href)).status, 200);
    } finally {
      if (w.child.exitCode === null) w.child.kill();
      await w.done;
    }
  });
});
