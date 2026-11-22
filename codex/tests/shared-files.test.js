// @ts-check
/**
 * ★★ 共享文件：**两个项目的那几份必须逐字一致**。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 这条规矩一直存在，只是从来没有人守着
 *
 * 两份契约都写着「`ui/` 那四件在两个项目里逐字一致」。那是一条**真的**
 * 架构约束——`ui/app.js` 是 reducer 的家，「选中第 3 行」是什么意思
 * 只许有一处定义。但它一直靠**人记得跑 `diff`** 执行：
 *
 * | 加这条之前的事实 | 后果 |
 * |---|---|
 * | 两个测试套件里**没有任何一处**读对方的文件 | 一次编辑就能让它漂移，而**两边全绿** |
 * | 契约里只有一句话、没有清单 | 漂移了也没人知道"一共该有哪几份" |
 *
 * 网页控制台把这份名单从 4 件加到 9 件（`platform/` 两件 + `web/` 三件），
 * 而 `web/` 那三件**天生更容易漂**：`.html` 和 `.css` 没有语法检查、没有类型、
 * 改坏了不会报错，只会在浏览器里少一个按钮。⇒ 补上这条。
 *
 * 再往后又加了 2 件，凑成 11：**守着上面那两件的测试本身**。理由一样——那两个
 * 测试里没有工具名、没有节号，只 import 被测的共享模块，所以能逐字共用；而
 * "守卫漂了"和"被守卫的代码漂了"一样坏：一个项目会悄悄不再守同一件事。
 *
 * 再后来「在文件管理器里打开这个目录」又加了 2 件（实现 + 它的测试），凑成 13。
 * 那一件**特别**该共享：它把用户敲的路径交给 `spawn()`，而"一个字都不进 shell"
 * 这条纪律是两个项目**共同**的保证——一份松了口子，另一份就没在保证了。
 *
 * 往后是池（2 + 2 件）与可选的外部状态存储（1 + 1 件）。那一对**特别**该共享，
 * 理由和第 13 件一样但更硬：它是本仓库**唯一**一条自己开裸 socket、
 * 还要把口令发出去的路径。"口令不落日志、只走一条连接"这件事
 * 一旦两边各写一份，就总有一份会先忘掉。
 *
 * ## 它怎么判
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 本项目这一份不在 / 是空的 | **红**（改名了？那清单也得跟着改） |
 * | 姊妹项目那份不在 | **红**（有人删了，或者从来就没拷过去） |
 * | 两份都在，但字节不同 | **红**（报出两边的字节数） |
 * | 姊妹项目整个不在检出里（单克隆） | `t.skip`——**可见地跳过**，不是静默通过 |
 *
 * ★ 这里**曾经**有一个 `pending` 标记：网页控制台先在 cxt 落地、cmt 后跟，那段时间
 *   清单里有五条写着"还没移植"。移植一落地就把它**删了**——一个永远进不去的分支
 *   和一条永远绿的守卫一样坏。将来要是再有一份文件需要"单边先落地"，加回三处即可：
 *   一条 `{ path, pending }`、一处 `continue`、一处**反向**检查（标了 `pending` 而
 *   对方**已经有了** ⇒ 红）。没有那个反向检查，标记会烂在那儿，而"该摘了"没人知道。
 *
 * ★ 用 `Buffer.equals()` 比对，**不**读成 `'utf8'` 再 `===`：编码会把差异吃掉
 *   （BOM 变成 U+FEFF 一个普通字符、CRLF 被折成 LF），而 BOM 与换行**正是
 *   要抓的那两种**——`bin/` 的 shebang 就是被 BOM 顶掉的（`source-hygiene`）。
 *
 * ✗ 否决过的两种做法：
 *   · 在两处各钉一个 sha256 常量——它只保证"这个文件变了"，
 *     **不保证两个项目一致**（两个不同的哈希都能过）。
 *   · 从契约里读哈希——契约明令禁止把会变的数字放进断言。
 *
 * ## ⚠️ 这份文件在两个项目里**逐字一致**
 *
 * 所以姊妹项目的名字**不写死**（下面扫出来）。两份拷贝一旦能不一样，
 * 它们就会不一样，而那时两个项目守的是**两份不同的清单**——比没有测试更坏。
 * ─────────────────────────────────────────────────────────────
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import nodeFs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { win32 as win32Path } from 'node:path';

const ROOT = win32Path.dirname(win32Path.dirname(fileURLToPath(import.meta.url)));

/** 本项目的包名。用来把自己从"姊妹项目"里排除掉。 */
const MY_NAME = JSON.parse(nodeFs.readFileSync(win32Path.join(ROOT, 'package.json'), 'utf8')).name;

/**
 * 找姊妹项目：**父目录里另一个 `*-multi-token` 包**。
 *
 * ★ 用 `package.json` 的 `name` 认人，不是"那个目录在不在"——一个空目录、
 *   一份备份、一个 `.git` 残留都不该被当成姊妹项目（那会让比对**静默**变成
 *   "和一堆垃圾逐字一致"）。
 *
 * @returns {string | null} 姊妹项目的根；单克隆时给 `null`
 */
function findSibling() {
  const parent = win32Path.dirname(ROOT);
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = nodeFs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null; // 父目录读不了（理论上不会），当单克隆处理
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const pkgPath = win32Path.join(parent, e.name, 'package.json');
    if (!nodeFs.existsSync(pkgPath)) continue;
    /** @type {any} */
    let pkg;
    try {
      pkg = JSON.parse(nodeFs.readFileSync(pkgPath, 'utf8'));
    } catch {
      continue; // 不是 JSON 的 package.json 不是我们的姊妹
    }
    if (pkg.name === MY_NAME) continue;
    if (typeof pkg.name === 'string' && pkg.name.endsWith('-multi-token')) {
      return win32Path.join(parent, e.name);
    }
  }
  return null;
}

const SIBLING = findSibling();

/**
 * ★★ 逐字一致的清单。**两个项目各一份，内容相同**（这个文件本身也逐字一致）。
 *
 * ⚠️ 往这里加一件东西 = 两边的文件必须**同时**存在且逐字节相同。所以顺序永远是：
 *   先 `cp` 过去，再改这份清单。反过来做，另一边的套件会当场变红。
 *
 * @type {{ path: string }[]}
 */
const SHARED = [
  // ── 面板内核四件套（两个项目都已经有） ──
  //    「选中第 3 行」是什么意思，只许有一处定义（reducer 在 `app.js`）。
  { path: 'src/cli/ui/app.js' },
  { path: 'src/cli/ui/keys.js' },
  { path: 'src/cli/ui/render.js' },
  { path: 'src/cli/ui/term.js' },

  // ── 网页控制台那五件 ──
  //    `platform/` 两件是"工具无关"的：不 import 各自的错误类、不写工具名、
  //    不写节号、日志靠注入。`web/` 三件是**随包发布**的前端，直接发给浏览器。
  { path: 'src/platform/serve-web.js' },
  { path: 'src/platform/open-browser.js' },
  { path: 'src/web/index.html' },
  { path: 'src/web/app.js' },
  { path: 'src/web/style.css' },

  // ── 「在文件管理器里打开这个目录」那一对 ──
  //    ★ 它**不**在网页控制台那五件里，因为它不是控制台的一部分：`ui-web.js`
  //    只是它的一个调用方。它自己是一条平台能力（spawn 一个文件管理器），
  //    和 `open-browser.js` 平级——所以单独列，理由也单独写。
  //    ★★ 共享的核心理由：这份代码把**用户敲的路径**交给 `spawn()`。
  //    "一个字都不进 shell" 是**两个项目共同的**保证，一份松了口子就都不算数了。
  { path: 'src/platform/open-path.js' },

  // ── 守着上面那些的测试，它们自己也是共享的 ──
  //    ★ 这两条**不在最初的清单里**（那时只有 9 件）。但这两个测试里一个工具名、
  //    一个节号都没有——它们只 import 被测的那两件共享模块，所以能逐字共用。
  //    而"守卫漂了"和"被守卫的代码漂了"一样坏：一个项目会悄悄不再守同一件事。
  { path: 'tests/serve-web.test.js' },
  { path: 'tests/open-browser.test.js' },
  { path: 'tests/open-path.test.js' },

  // ── 池的两件纯逻辑，以及守着它们的两个测试 ──
  //    ★ 它们是**纯函数**：不碰 fs、不读环境、不读平台。所以两边逐字共用，
  //    而"什么时候该重探""挑谁先试""这张表怎么读成网格"三件事只有一处定义。
  //    ★★ 池里**一个密钥字段都没有**：它只是挂在既有 token 上的状态/用量覆盖层，
  //    明文密钥永远只有一个家。所以这两件也是"工具无关"的。
  { path: 'src/core/pool.js' },
  { path: 'src/core/sheet.js' },
  { path: 'tests/pool.test.js' },
  { path: 'tests/sheet.test.js' },

  // ── 可选外部状态存储的那一对 ──
  //    ★★ 本仓库**只有这一处**自己开裸 socket：解析地址、发 AUTH、切库、
  //    按帧拆应答。它失败的方式全都很难在本地复现（半截帧、分块到达、
  //    先报错再照常工作），而它对**口令**的处理只有一份正确答案。
  //    所以实现与守着它的测试一起进清单——测试里那个假服务端才是
  //    "协议对不对"的唯一证据。
  { path: 'src/platform/redis.js' },
  { path: 'tests/redis.test.js' },

  // ── 会话在场层的纯逻辑与活性探测，以及守着它们的两个测试 ──
  //    ★ `core/sessions.js` 纯得像 `pool.js`：不碰 fs、不读环境、不读平台，
  //    `now` / `rand` 一律注入。会话 id 形状、三态判据、消息规整、超龄过滤
  //    四件事**只有一处定义**——两边各写一遍，迟早一边把 dead 判成 live。
  //    ★ `platform/pid.js` 是唯一读 `process.kill` 的地方：ESRCH/EPERM 的判据
  //    跨平台且容易各写各的（把 EPERM 当死 = 别的用户的会话全被误报）。
  //    ★★ 两件都**不含任何密钥**：meta 归一化是**白名单**，argv 根本进不来
  //    （`--token-value` 是明文 sk——这条白名单就是它的机器守卫）。
  { path: 'src/core/sessions.js' },
  { path: 'tests/sessions.test.js' },
  { path: 'src/platform/pid.js' },
  { path: 'tests/pid.test.js' },
];

/**
 * 读成 Buffer。不在（或读不动）给 `null`。
 * @param {string} abs
 * @returns {Buffer | null}
 */
function readOrNull(abs) {
  try {
    return nodeFs.readFileSync(abs);
  } catch {
    return null;
  }
}

describe('★★ 共享文件 —— 两个项目的那几份必须逐字一致', () => {
  test('★ 清单没被清空（不然下面两条是空转）', () => {
    // 一条永远绿的守卫比没有守卫更坏。删掉清单里的一项**看不出任何异常**，
    // 所以这里留一个下限：加文件随便加，**减**要过这一关。
    assert.ok(SHARED.length >= 23, `清单只剩 ${SHARED.length} 项——被谁删了？`);
    assert.ok(
      SHARED.some((e) => e.path === 'src/cli/ui/app.js'),
      '四件套不在清单里了——reducer 的家就那一处',
    );
    assert.ok(
      SHARED.some((e) => e.path.startsWith('src/web/')),
      '网页控制台那三件不在清单里了',
    );
    assert.ok(
      SHARED.some((e) => e.path === 'src/platform/serve-web.js'),
      '唯一 import `node:http` 的那件不在清单里了',
    );
    // ★ "不过 shell" 那条纪律只在**一次** spawn 里兑现，而它被两个项目共用。
    //   实现了却没人守，等于两条规矩各守一边。
    assert.ok(
      SHARED.some((e) => e.path === 'src/platform/open-path.js'),
      '把用户路径交给 spawn 的那件不在清单里了',
    );
    // ★ 「什么时候重探」「并列时挑谁」这两条最容易写错的规矩，只有那一处定义。
    //   它漂了不会报错，只会让一个项目开始偷偷多烧请求、或者总是挑同一把 key。
    assert.ok(
      SHARED.some((e) => e.path === 'src/core/pool.js'),
      '池的纯逻辑不在清单里了——新鲜度与候选顺序的家就那一处',
    );
    // ★ 整个仓库只有这一处把口令发出去；它漂了不会有别的测试喊。
    assert.ok(
      SHARED.some((e) => e.path === 'src/platform/redis.js'),
      '自己开裸 socket 的那件不在清单里了',
    );
    // ★ 会话三态的判据只有一处定义——它漂了，一个项目会开始把活会话报成死的。
    assert.ok(
      SHARED.some((e) => e.path === 'src/core/sessions.js'),
      '会话在场层的纯逻辑不在清单里了——三态判据的家就那一处',
    );
    for (const e of SHARED) {
      assert.ok(typeof e.path === 'string' && e.path !== '', `有条目没有 path：${JSON.stringify(e)}`);
    }
    // ★ 清单里**不许**再出现别的键：`pending` 那个机制删掉了，谁把它加回来
    //   而忘了加配套的两处检查，就会得到一个"标了却没人在看"的标记。
    for (const e of SHARED) {
      assert.deepEqual(
        Object.keys(e),
        ['path'],
        `${e.path} 上多了字段——加共享文件是"拷过去再改清单"，不是"先标个记号"`,
      );
    }
  });

  test('★★ 每一份在本项目里都在，而且非空', () => {
    /** @type {string[]} */
    const bad = [];
    for (const e of SHARED) {
      const abs = win32Path.join(ROOT, e.path);
      if (!nodeFs.existsSync(abs)) {
        bad.push(`${e.path}：不在——改名了？那清单也得改`);
        continue;
      }
      // ★ 零字节能通过"两边都是零字节"的 diff。非空是"这份文件还在"的最低证据。
      if (nodeFs.statSync(abs).size === 0) bad.push(`${e.path}：是空的`);
    }
    assert.deepEqual(bad, [], '★ 路径写错一个字母，这条清单就再也守不住那个文件了');
  });

  test('★★ 与姊妹项目逐字节一致', (t) => {
    if (SIBLING === null) {
      // ★ 单克隆（只检出其中一个项目）时**可见地跳过**——报告里"没测"和
      //   "测过了"必须长得不一样。静默通过会让人以为这条守卫生效了。
      t.skip('姊妹项目不在检出里——共享文件没法比对');
      return;
    }

    /** @type {string[]} */
    const bad = [];
    for (const e of SHARED) {
      const mine = readOrNull(win32Path.join(ROOT, e.path));
      const theirs = readOrNull(win32Path.join(SIBLING, e.path));
      if (mine === null) continue; // 上一条测试管这个，这里不重复报

      if (theirs === null) {
        bad.push(`${e.path}：姊妹项目那份**没了**（本项目的还在，${mine.length} B）`);
      } else if (!mine.equals(theirs)) {
        bad.push(`${e.path}：两个项目不一致（本 ${mine.length} B / 它 ${theirs.length} B）`);
      }
    }
    assert.deepEqual(
      bad,
      [],
      '★ 改一份就得改两份，改完跑这个测试——它是唯一会告诉你"忘了另一份"的地方',
    );
  });
});
