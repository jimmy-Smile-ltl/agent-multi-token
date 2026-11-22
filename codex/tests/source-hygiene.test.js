// @ts-check
/**
 * 源码卫生：**裸控制字符与 BOM 不许进源码**。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么这是一条**真**规则，不是洁癖
 *
 * 裸的 `ESC`（U+001B）写在模板串或正则里是**合法 JS**，运行时的值与 `\u001b`
 * 一字不差——所以**任何行为测试都抓不到它**。抓不到，又看不见：
 *
 * | 在哪 | 会怎样 |
 * |---|---|
 * | 编辑器 | 不显示，光标却会跳一格，看着像拼错了 |
 * | `git diff` | 两行**看起来一模一样**，改动显示成空 |
 * | code review | 审的人看不见，只能选择相信 |
 * | 复制粘贴 / 编辑器"清理不可见字符" | **静默消失**，而症状在很远的地方 |
 *
 * 本仓库已经踩过五次（`term.js` 8 处、`term.test.js` 16 处、
 * `verify-ui-real.mjs` 8 处、`macos.js` 2 处、`resolve-terminal.test.js` 2 处）。
 * 第五次之后加了这条——**能机器守的约定就别靠记性**。
 *
 * ## 那个"看不见"的代价具体长什么样
 *
 * `macos.js` 里原来有一行 `printf '%s' '<ESC>]0;标题<BEL>'`。
 * 它是对的，但没人看得出它对；把那个 `<ESC>` 删掉，**diff 是空的**，
 * 而窗口标题就再也设不上了。现在源码里写 `\u001b` / `\u0007`，
 * 值由 `resolve-terminal.test.js` 那条 OSC 0 的断言钉着。
 *
 * ## BOM
 *
 * `bin/` 下是带 shebang 的入口。BOM 会让内核看到的第一个字节不是 `#`，
 * Unix 上直接 `Exec format error`；而 Windows 上 Node 自己会吃掉 BOM，
 * 于是这个错**在开发机上永远复现不出来**——正是最该机器守的那种。
 *
 * ## 为什么 `.md` 也扫
 *
 * 不是"顺手多扫一点"。加这条规则时扫全仓，**唯一**的漏网之鱼就是
 * `AGENTS.md` —— 而且其中两处**已经在那里躺了好几天**，从加进去那天起
 * 每一次 `git diff` 都没显示出来过。契约文件是本仓库读的人最多的文件，
 * 它上面挂着一个看不见的字节，比代码里挂一个更坏。
 *
 * ## 为什么 `.html` / `.css` 也扫
 *
 * `src/web/` 那三件是**随包发布**的前端资产，而且还要**逐字复制**到姊妹项目
 * （「共享文件」那一节）。一个看不见的控制字符在这里比在 `.js` 里更坏：
 * `diff` 显示不出来 ⇒ "逐字一致"当场破掉，而共享文件测试只会报一句
 * "内容不同"，指不出是哪个字节。
 *
 * ⚠️ 这三件是本仓库**头一份** `.html` / `.css`。在那之前 `walk()` 的扩展名表里
 * 根本没有这两项——**文件在仓库里，却一条规则都不受**。这就是下面那句
 * 「扫描面真的覆盖到了」存在的理由：谁把扩展名删回去，四条规则会静默变回空转。
 * ─────────────────────────────────────────────────────────────
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

/**
 * 递归列出源码文件，路径**相对仓库根**（带尾斜杠的目录拼出来的，所以是 POSIX 风格）。
 *
 * @param {string} rel
 * @returns {string[]}
 */
function walk(rel) {
  /** @type {string[]} */
  const out = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(new URL(rel, ROOT), { withFileTypes: true });
  } catch {
    return out; // 目录不存在（将来删了 scripts/ 之类）不算失败
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(`${rel}${e.name}/`));
    } else if (/\.(js|mjs|cjs|md|html|css)$/.test(e.name)) {
      out.push(`${rel}${e.name}`);
    }
  }
  return out;
}

// ★ 从**仓库根**开始走，不是从四个子目录开始——`AGENTS.md` / `README.md`
//   就躺在根上，只列子目录会正好漏掉最该扫的那个（第一版就是这么漏的，
//   而"扫描面"那条守卫当场把它抓了出来）。
const FILES = walk('').sort();

/**
 * ★ 扫描面 = 本项目源码 **+ 共享 `test_resource/` 里会被提交的那几个文件**。
 *
 * 后者在两个项目的 `ROOT` 之外——**而真值恰恰就是在那儿被发现的**。
 * 只扫本项目等于把后门留在案发现场：`test_resource/README.md` 被
 * `.gitignore` 的 `!README.md` 显式放行，是要跟着仓库走的。
 *
 * 只列**会被提交**的（`README.md` 与 `*.example.json`）。同目录下的
 * `tokens.json` / `endpoints.json` 是被忽略的，**不该扫**——真值本来就该在那儿。
 *
 * ★ `src/web/` 那三件**不必**在这儿单独列：它们进了 `FILES` 就进了 `SCAN`
 *   （`walk()` 的扩展名表已经收 `.html` / `.css`）。要加的是**断言**，
 *   不是这一行——见下面「扫描面覆盖到了」。
 */
const SCAN = [
  ...FILES,
  '../test_resource/README.md',
  '../test_resource/tokens.example.json',
  '../test_resource/endpoints.example.json',
].filter((rel) => existsSync(new URL(rel, ROOT)));

const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;

describe('★★ 源码卫生 —— 裸控制字符 / BOM', () => {
  test('★ 扫描面真的覆盖到了源码（不然下面两条是空转）', () => {
    // 没有这条的话，"一个文件都没扫到"会让下面两条**永远绿**——
    // 一条永远绿的守卫比没有守卫更坏。
    assert.ok(FILES.length > 60, `只扫到 ${FILES.length} 个文件——路径写错了？`);
    assert.ok(FILES.includes('src/cli/ui/term.js'), '没扫到 ui/term.js');
    assert.ok(FILES.includes('AGENTS.md'), '没扫到契约文件——`.md` 那条扩展名丢了？');
    // ★ 前端资产：这三件是**随包发布**的，而且还要逐字复制给姊妹项目。
    //   它们不在扫描面里的时候，下面四条规则对它们**全都不存在**——
    //   而"不在扫描面里"是完全看不出来的（测试照常全绿）。
    assert.ok(FILES.includes('src/web/index.html'), '没扫到 web 资产——`.html` 那条扩展名丢了？');
    assert.ok(FILES.includes('src/web/style.css'), '没扫到 web 资产——`.css` 那条扩展名丢了？');
    assert.ok(FILES.some((f) => f.startsWith('bin/')), '没扫到 bin/');
    assert.ok(FILES.every((f) => !f.includes('node_modules')), '扫进了 node_modules');
  });

  test('★★ 不许有裸控制字符（制表 / 换行 / 回车除外）', () => {
    /** @type {string[]} */
    const bad = [];
    for (const rel of FILES) {
      const src = readFileSync(new URL(rel, ROOT), 'utf8');
      for (let i = 0; i < src.length; i++) {
        const c = src.charCodeAt(i);
        if (c < 0x20 && c !== TAB && c !== LF && c !== CR) {
          bad.push(`${rel}:${src.slice(0, i).split('\n').length}  U+${c.toString(16).padStart(4, '0')}`);
        }
      }
    }
    assert.deepEqual(bad, [], '★ 一律写成 \\uXXXX；裸控制字符在编辑器和 diff 里都看不见');
  });

  test('★ 不许有 BOM（`bin/` 的 shebang 会被它顶掉）', () => {
    /** @type {string[]} */
    const bad = [];
    for (const rel of FILES) {
      if (readFileSync(new URL(rel, ROOT), 'utf8').charCodeAt(0) === 0xfeff) bad.push(rel);
    }
    assert.deepEqual(bad, [], '★ BOM 在 Windows 上被 Node 吃掉，所以这个错在开发机上复现不出来');
  });

  test('★ `bin/` 的入口第一行是 shebang（BOM 那条只防了一半，这条防另一半）', () => {
    for (const rel of FILES.filter((f) => f.startsWith('bin/'))) {
      const first = readFileSync(new URL(rel, ROOT), 'utf8').split('\n')[0];
      assert.ok(first.startsWith('#!'), `${rel} 第一行不是 shebang：${JSON.stringify(first)}`);
    }
  });
});

// ═══════════ ★★ 不许把"真东西"带进仓库 ═══════════

/**
 * 这份仓库是要**开源**的，所以有两类字面量永远不该出现在会被提交的文件里：
 * **真密钥**和**内网地址**。
 *
 * ★ 起因：`test_resource/README.md` 里曾经同时躺着 18 位同事的**真名**和一个
 *   **内网域名**——而那个文件是**会被提交**的（`.gitignore` 里显式 `!README.md`）。
 *   两者都不是"写错了一个字符"：一个是看着很正常的成员名单表格，一个是
 *   复制粘贴出来的示例命令。与上面那条 ESC 规则同源——**能机器守的约定就别靠记性**。
 *
 * ★ 规则本身**不含任何真值**。地址那条是**默认拒绝**：凡 `https://` 后面的 host
 *   不在白名单里就报错。写死内网域名的黑名单有两个毛病：等于把那个域名又抄进
 *   仓库一遍，而且只防得住**已经漏过的那个**。
 */
const OK_DOMAINS = [
  // RFC 2606：文档专用，随便用
  'example.com', 'example.net', 'example.org',
  // 文档里确实引用到的公开站点（想加之前先问：这个域名真的非写出来不可吗？）
  'deepseek.com', 'claude.ai', 'no-color.org', 'nodejs.org',
  // 测试夹具里的"攻击者"与短名
  'evil.com', 'x.com',
];

/** RFC 6761 的保留 TLD：`.example` / `.invalid` / `.test` */
const OK_TLDS = ['example', 'invalid', 'test', 'localhost'];

/**
 * host 在白名单里吗（含子域）。
 * @param {string} h
 */
function hostAllowed(h) {
  if (h === '127.0.0.1' || h === 'localhost') return true;
  if (/^\d+(\.\d+){3}$/.test(h)) return true; // 裸 IP 一律放行（本机 / 私网示例）
  if (OK_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) return true;
  return OK_TLDS.some((t) => h.endsWith(`.${t}`));
}

/**
 * 字符下标 → 行号（1-based）。
 * @param {string} src
 * @param {number} i
 */
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

describe('★★ 不许把真密钥 / 内网地址带进仓库（这份仓库要开源）', () => {
  test('★ 扫描面覆盖到了（不然下面两条是空转）', () => {
    assert.ok(FILES.length > 60, `只扫到 ${FILES.length} 个文件——路径写错了？`);
    assert.ok(FILES.includes('AGENTS.md'), '没扫到契约文件');
    // ★ 共享目录**必须**扫到：真值就是在那个文件里被发现的
    assert.ok(
      SCAN.some((rel) => rel === '../test_resource/README.md'),
      '没扫到 test_resource/README.md——那正是真值被发现的同一个文件',
    );
    // ★ 前端资产**必须**在 `SCAN` 里（不只是 `FILES`）：它是本仓库唯一一份
    //   **要发给浏览器**的源码。一个真 key 粘进 `index.html` 比粘在任何地方
    //   都更容易发生——示例命令、`placeholder`、注释里随手一贴。
    assert.ok(SCAN.includes('src/web/index.html'), '没扫到 web 资产——`.html` 那条扩展名丢了？');
  });

  test('★★ 没有真 key 形状的串（`sk-` 后跟 16 位以上字母数字）', () => {
    /** @type {string[]} */
    const bad = [];
    for (const rel of SCAN) {
      const src = readFileSync(new URL(rel, ROOT), 'utf8');
      for (const m of src.matchAll(/\bsk-[A-Za-z0-9]{16,}/g)) {
        // ★ 报错里**只印前 3 位和长度**——否则这条守卫自己就成了新的泄漏点
        bad.push(`${rel}:${lineOf(src, m.index)}  ${m[0].slice(0, 3)}…（${m[0].length} 字符）`);
      }
    }
    assert.deepEqual(bad, [], '★ 夹具一律用一次性假 key；示例用短串（`sk-aaaa11112222` 这种）');
  });

  test('★★ 没有白名单之外的 hostname（默认拒绝）', () => {
    /** @type {string[]} */
    const bad = [];
    for (const rel of SCAN) {
      const src = readFileSync(new URL(rel, ROOT), 'utf8');
      for (const m of src.matchAll(/https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)/g)) {
        // 紧跟 `…` = 这是**打码后的显示值**（`https://oneapi…`），不是真地址
        if (src[m.index + m[0].length] === '…') continue;
        const h = m[1].replace(/\.+$/, '');
        // 没有点 = `https://x` 这种占位符（测试里到处都是），不可能是真地址
        if (!h.includes('.')) continue;
        if (!hostAllowed(h)) bad.push(`${rel}:${lineOf(src, m.index)}  ${h}`);
      }
    }
    assert.deepEqual(bad, [], '★ 换成 example.com，或明确加进 OK_DOMAINS（加之前先问：非写不可吗？）');
  });
});
