// @ts-check
/**
 * 路径绑定：归一化 + 最长前缀匹配（§2.3）。
 *
 * **纯函数**——`platform` / `home` 必须由调用方传入（§4.2 铁律），
 * 不许读 `process.platform` / `os.homedir()`。否则 Windows 的路径规则在 Linux CI 上就没法测了（§6.3）。
 *
 * ⚠️ **本模块的第一不变量：绑定与匹配必须走同一个 `canonicalPath()`。**
 * 只要写入侧和读取侧的归一化有任何一处不同，绑定就会**静默失配**——
 * 用户看到的是"我明明绑了，怎么没生效"，最难排查的一类 bug。
 */
import { expandTilde } from './paths.js';

/**
 * 归一化成**可比较的形式**（§2.9 三）。四步，顺序不能换：
 *
 * 1. `normalize('NFC')` —— macOS 暗礁：文件名可能以 NFD 存储，
 *    文件系统查找本身不敏感，但**我们的 `startsWith` 是字节级敏感的**。
 *    （Claude Code 自己对配置目录也做 `.normalize("NFC")`，二进制中可见。）
 * 2. 分隔符统一为 `/`
 * 3. Windows / macOS 转小写（APFS 默认大小写不敏感）；**Linux 保持大小写**
 * 4. 消解 `.` / `..` 段、去掉尾部 `/`（保留根 `/`、`C:/`、UNC 的 `//`）
 *
 * **不解析 symlink**（不做 realpath）：会引入 IO 开销与"绑定突然失效"的困惑（§2.9 三）。
 *
 * @param {string} p
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function normalizeForCompare(p, platform) {
  if (typeof p !== 'string' || p === '') return '';

  let s = p.normalize('NFC').replace(/\\/g, '/');

  if (platform === 'win32' || platform === 'darwin') {
    s = s.toLowerCase();
  }

  return resolveDots(s, platform);
}

/**
 * 消解 `.` / `..`，并规范化前导部分（根 / 盘符 / UNC）。
 *
 * 我们只做**字符串比较**、不碰文件系统，所以不追求与 fs 完全一致的语义，
 * 只求「同一条路径的两种写法归一到同一串」。
 * @param {string} s 已统一分隔符、已按需小写
 * @param {NodeJS.Platform} platform
 */
function resolveDots(s, platform) {
  let prefix = '';
  let rest = s;

  // UNC 是 Windows 概念：`\\server\share`。POSIX 上 `//foo` 就是 `/foo`
  // （POSIX 允许 `//` 有实现自定义含义，但我们不做特殊处理——统一塌成 `/`）。
  if (platform === 'win32' && rest.startsWith('//')) {
    prefix = '//';
    rest = rest.slice(2);
  } else if (rest.startsWith('/')) {
    prefix = '/';
    rest = rest.replace(/^\/+/, ''); // 多个前导斜杠塌成一个
  }

  // Windows 盘符：`d:/...` → 前缀 `d:/`。
  // 不这样处理的话 `D:/` 会被当成一个普通段 `d:`，与 `D:` 混为一谈。
  const drive = /^([a-z]):(?:\/|$)/.exec(rest);
  if (drive) {
    prefix += `${drive[1]}:/`;
    rest = rest.slice(drive[0].length);
  }

  /** @type {string[]} */
  const out = [];
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (prefix === '') out.push('..'); // 相对路径的前导 `..` 要留着
      continue;
    }
    out.push(seg);
  }

  const joined = out.join('/');
  if (prefix === '') return joined;
  return joined ? prefix + joined : prefix;
}

/**
 * 绑定的**规范形式**：先展开 `~`，再归一化。
 *
 * 写入侧（`cmt bind`）与读取侧（匹配）**必须都走这里**——见文件头的不变量。
 *
 * @param {string} p
 * @param {{ platform: NodeJS.Platform, home: string }} ctx
 */
export function canonicalPath(p, ctx) {
  return normalizeForCompare(expandTilde(String(p), ctx.home, ctx.platform), ctx.platform);
}

/**
 * `prefix` 是否是 `p` 的**路径前缀**（落在分隔符边界上）。
 *
 * 关键在边界：`D:/work` **不能**匹配 `D:/workshop`——直接 `startsWith` 就会犯这个错。
 * @param {string} prefix 已归一化
 * @param {string} p 已归一化
 */
export function isPathPrefix(prefix, p) {
  if (prefix === '') return false;
  if (p === prefix) return true;
  return p.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/**
 * 最长前缀匹配（§2.3）：`D:/work/a/sub` 命中 `D:/work/a` 而不是 `D:/work`。
 *
 * 命中不到 → 返回 `null`（调用方继续走 token / 全局默认）。
 *
 * @param {{ path: string }[]} bindings
 * @param {string} cwd
 * @param {{ platform: NodeJS.Platform, home: string }} ctx
 * @returns {any | null} 命中的绑定（原对象，不是归一化副本）
 */
export function matchBinding(bindings, cwd, ctx) {
  const target = canonicalPath(cwd, ctx);

  /** @type {any | null} */
  let best = null;
  let bestLen = -1;

  for (const b of bindings) {
    const bp = canonicalPath(b.path, ctx);
    if (!isPathPrefix(bp, target)) continue;
    // 同长度时先出现的赢——结果确定，不随遍历顺序抖动
    if (bp.length > bestLen) {
      best = b;
      bestLen = bp.length;
    }
  }

  return best;
}

/**
 * 该路径**是否已被某个绑定精确覆盖**（不是"落在其下"）。
 *
 * 与 `matchBinding()` 的区别是这一条：`D:/work/a` 对目标 `D:/work/a/sub` 算**命中**
 * （前缀），但对目标 `D:/work/a` 才算**精确**。两个问题不一样，所以两个函数。
 *
 * 谁用它：`cmt bind`（"是新建还是改写"）、面板向导第 4 步（同左）、面板的 `d`（删绑定）。
 * 判据必须是**精确**——用前缀匹配去决定"改写哪一条"，`cmt bind D:/work/a` 会改写掉
 * `D:/work/a/sub` 那条，而用户想动的是另一条。
 *
 * @param {{ path: string }[]} bindings
 * @param {string} p
 * @param {{ platform: NodeJS.Platform, home: string }} ctx
 * @returns {number} 下标；没有则 -1
 */
export function findExactBinding(bindings, p, ctx) {
  if (!Array.isArray(bindings)) return -1;
  const target = canonicalPath(p, ctx);
  for (let i = 0; i < bindings.length; i++) {
    const b = bindings[i];
    if (b == null || typeof b.path !== 'string') continue;
    if (canonicalPath(b.path, ctx) === target) return i;
  }
  return -1;
}

/**
 * 找出**归一化后互相冲突**的绑定（`D:/work` vs `D:/WORK`）。
 *
 * `schema.js` 的重复检查比的是原始字符串，看不出这种冲突；
 * 归一化后同串的两条绑定谁赢取决于书写顺序——`cmt doctor` 用它来报警。
 *
 * @param {{ path: string }[]} bindings
 * @param {{ platform: NodeJS.Platform, home: string }} ctx
 * @returns {{ key: string, paths: string[] }[]}
 */
export function findCollisions(bindings, ctx) {
  /** @type {Map<string, string[]>} */
  const byKey = new Map();
  for (const b of bindings) {
    const k = canonicalPath(b.path, ctx);
    const list = byKey.get(k);
    if (list) list.push(b.path);
    else byKey.set(k, [b.path]);
  }
  return [...byKey.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([key, paths]) => ({ key, paths }));
}

/**
 * 找出"看着就是同一个目录、字符串却对不上"的绑定。
 *
 * 为什么需要它：绑定是**字符串前缀匹配**，刻意不做 `realpath`（§2.9 三）。
 * 于是同一个目录可以有多种写法，而 `cmt resolve` 只会干巴巴地说一句「绑定（无）」——
 * 用户盯着 `cmt bind ls` 里那条看起来一模一样的路径，完全不知道差在哪个字符。
 * 实测踩到的真实形态：
 *
 *   - Windows 8.3 短名：`C:/Users/ALICE~1/work` vs `C:/Users/alice/work`
 *     （Git Bash 会把 `/tmp/...` 这类参数塞成短名，而 `process.cwd()` 给的是长名）
 *   - 同一目录的另一种拼法：macOS 的 `/tmp/x` vs `/private/tmp/x`、软链与实体路径
 *
 * 注意**大小写不在此列**：`canonicalPath()` 已经在 Windows/macOS 上折成小写，
 * 大小写差异会被归一化直接吃掉（于是要么正常命中，要么在 Linux 上本就是两个目录），
 * 永远走不到这里。所以这里直接比字符串就是各平台该有的语义，不必另写大小写规则。
 *
 * 判据刻意收得很窄：**末段（basename）相同**，但整串不是目标的前缀。
 * 这样既盖住上面两种，又不会把"你绑的是隔壁 client-b"这类噪音报出来。
 *
 * @param {{ path: string }[]} bindings
 * @param {string} cwd
 * @param {{ platform: NodeJS.Platform, home: string }} ctx
 * @returns {any[]} 疑似"本该匹配上"的绑定（原对象）
 */
export function findNearMisses(bindings, cwd, ctx) {
  const target = canonicalPath(cwd, ctx);
  const tail = lastSegment(target);
  if (tail === '') return [];

  return bindings.filter((b) => {
    const bp = canonicalPath(b.path, ctx);
    // 已经匹配上的不算——那条走的是正常路径
    if (isPathPrefix(bp, target)) return false;
    return lastSegment(bp) === tail;
  });
}

/**
 * 归一化路径的末段。根（`/`、`c:/`）没有末段，返回 `''`。
 * @param {string} p 已归一化
 */
function lastSegment(p) {
  const s = p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
  const i = s.lastIndexOf('/');
  return i === -1 ? s : s.slice(i + 1);
}
