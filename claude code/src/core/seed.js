// @ts-check
/**
 * 启动前播种（§3.6）——**纯函数：不碰 fs、不读 `process.*`、不 spawn**（§4.2）。
 *
 * 本模块只回答"该往 `.claude.json` 里补哪些键"，落盘在 `store.js` 的 `seedProfile()`。
 * 拆开是为了让"补什么"能脱离文件系统单测——它是这个特性里唯一有判断逻辑的部分。
 *
 * ─────────────────────────────────────────────────────────────
 * **为什么需要它**：Claude Code 的两道首启闸门**只认 `.claude.json`**（§7.6 二进制实测）。
 * `hasCompletedOnboarding` 不在任何 settings 层里，目录信任只有
 * `projects[<cwd>].hasTrustDialogAccepted` 一个入口——`--settings`、CLI 旗标、
 * 环境变量（570 个 `CLAUDE_CODE_*` 全枚举过）都表达不了。而 cmt 的定位是"开窗即用"，
 * 让用户每 token、每目录手点一遍，与定位直接矛盾。
 *
 * **三条不可动摇的性质**（有测试守着）：
 *
 * 1. **只增不改**：只补**缺失**的键，已存在的键一个字节都不动。
 *    `hasTrustDialogAccepted: false` 算**已表态**（用户可能真的拒绝过），**不覆盖**。
 * 2. **幂等**：补完再算一次必然 `changed === false` → 第一次启动之后自动退化成纯读取，
 *    **永远不会和 Claude Code 抢文件**。这是整个例外条款能成立的地基。
 * 3. **不复制 `~/.claude.json`**：只写下面列出的固定键。复制主配置会把个人 MCP、
 *    OAuth 会话、别的项目的信任记录一并搬进 profile——那既不是隔离，也不是最小骨架。
 *    （§8 开放问题 1 原文提的是"复制骨架"，**已否决**，理由在此。）
 * ─────────────────────────────────────────────────────────────
 */
import { CmtError } from './errors.js';

/** `defaults.seed` 的合法取值（§2.4） */
export const SEED_MODES = ['off', 'onboarding', 'full'];

/**
 * 不显式配置时的档位。
 *
 * **`"off"` 而不是 `"onboarding"`**：升级 cmt 不该悄悄改变已装机的行为，
 * 而"要不要让 cmt 替你动 Claude Code 的文件"必须由用户说出口。
 * 想要零点击的用户显式写 `"full"`，`cmt doctor` 会把当前档位报出来。
 */
export const DEFAULT_SEED_MODE = 'off';

/**
 * 校验 `defaults.seed`。
 * @param {unknown} v
 * @param {string} at
 * @returns {string}
 */
export function normalizeSeedMode(v, at) {
  if (typeof v !== 'string' || !SEED_MODES.includes(v)) {
    throw new CmtError(
      `${at} 只能是 ${SEED_MODES.map((m) => `"${m}"`).join(' / ')}，收到 ${JSON.stringify(v)}`,
      { hint: 'off = 不播种（默认）；onboarding = 只跳引导；full = 引导 + 目录信任' },
    );
  }
  return v;
}

/**
 * 项目键：`cwd` → `.claude.json` 里 `projects` 的键。
 *
 * 与 Claude Code 自己的算法一致（二进制 `vS(t,{foldCase:false})`）：
 * **NFC 归一 + 反斜杠转正斜杠，保留大小写**。
 *
 * ⚠️ **别 `toLowerCase()`**。`vS()` 的 `foldCase` 参数默认是 `true`，
 * 但那是给**比较**用的（`oy()` 拿它做路径等价判断）；**存储用 `false`**。
 * 本机 68 个真实键全部符合这个形状：0 个含反斜杠、0 个小写盘符、68/68 保留原大小写。
 * 大小写写错不会报错，只会得到一个**永远不命中**的键——最难查的那类。
 *
 * @param {string} cwd
 */
export function projectKey(cwd) {
  return String(cwd).normalize('NFC').replace(/\\/g, '/');
}

/**
 * 两个项目键是否指同一个目录。
 *
 * Windows / macOS 的文件系统大小写不敏感，键也按不敏感处理；
 * Linux 敏感（`/home/a` 与 `/home/A` 是两个目录）。判据与 §2.9 三一致。
 *
 * @param {string} a
 * @param {string} b
 * @param {NodeJS.Platform} platform
 */
function sameKey(a, b, platform) {
  return platform === 'linux' ? a === b : a.toLowerCase() === b.toLowerCase();
}

/**
 * 在已有的 `projects` 里找该目录**已经用过的**那个键，好复用它的拼写。
 *
 * 为什么要查重而不是直接用 `projectKey()`：万一某台机器上 Claude Code 写出的拼写
 * 与我们的算法有一处细微差异（大小写、symlink 解析），直接新建键会得到
 * **两份指向同一目录的条目**——我们写的那个被无视，用户照旧看到弹窗，
 * 而且症状是"播种明明成功了却没用"。复用已有拼写从结构上消灭这一整类问题。
 *
 * @param {Record<string, any>} projects
 * @param {string} cwd
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
function findExistingKey(projects, cwd, platform) {
  const want = projectKey(cwd);
  for (const k of Object.keys(projects)) {
    if (sameKey(k, want, platform)) return k;
  }
  return null;
}

/**
 * 新建项目条目的骨架——**照抄 Claude Code 自己写出来的形状**（二进制实测，2.1.251）。
 *
 * 只写 `{ hasTrustDialogAccepted: true }` 也能用，但任何"假设条目是完整的"读取路径
 * 都会撞上 `undefined`。照抄一份实测过的形状，比省这 8 个键划算。
 *
 * @returns {Record<string, any>}
 */
function freshProjectEntry() {
  return {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    enabledMcpjsonServers: [],
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: false,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
  };
}

/**
 * 算出该补哪些键。
 *
 * **不修改 `current`**——返回一份新的 `next`，好让调用方能拿原对象做并发比对（§3.6 写前重读）。
 *
 * @param {{
 *   current: any,              现有 `.claude.json` 的内容（不存在就给 `{}`）
 *   cwd: string,               即将启动 claude 的目录
 *   mode: string,              `defaults.seed` 的值
 *   platform: NodeJS.Platform, 大小写敏感性的判据
 * }} args
 * @returns {{ changed: boolean, next: any, added: string[] }} `added` 是给人看的键路径清单
 */
export function planSeed({ current, cwd, mode, platform }) {
  // 坏内容（null / 数组 / 字符串）当作空对象——播种不该因为别人的文件长得怪就崩，
  // 真读不动会在 store.js 那边先报出来
  const base =
    current && typeof current === 'object' && !Array.isArray(current)
      ? /** @type {Record<string, any>} */ (current)
      : {};

  /** @type {string[]} */
  const added = [];
  if (mode === 'off' || !SEED_MODES.includes(mode)) return { changed: false, next: base, added };

  /** @type {Record<string, any>} */
  const next = { ...base };

  // ── ① 引导：纯 UI 状态，零安全含义 ──────────────────────────────
  // 只有"看没看过主题选择器"这一件事。它不在任何 settings 层里（§7.6），
  // 所以除了写这里没有第二条路。
  //
  // **不写 `lastOnboardingVersion`**：二进制里它出现为对象字面量、落盘却是字符串
  // （本机实测 "2.1.251"），说明写它的路径不止一条，形态不可靠；
  // 而实测 `hasCompletedOnboarding` 单独就够了（§7.6）。
  // 少写一个我们没吃透的键，比多写一个强。
  if (base.hasCompletedOnboarding !== true) {
    next.hasCompletedOnboarding = true;
    added.push('hasCompletedOnboarding');
  }

  // ── ② 目录信任：这一档有安全含义，只在 full 下动 ─────────────────
  // 它等于声明"这个目录里的 CLAUDE.md / hooks / .mcp.json 可以执行"。
  if (mode === 'full') {
    const projects =
      base.projects && typeof base.projects === 'object' && !Array.isArray(base.projects)
        ? { ...base.projects }
        : {};
    const key = findExistingKey(projects, cwd, platform) ?? projectKey(cwd);
    const entry = projects[key];

    if (entry === undefined || entry === null) {
      // 从没在这个目录启动过 → 写一份完整骨架
      projects[key] = { ...freshProjectEntry(), hasTrustDialogAccepted: true };
      next.projects = projects;
      added.push(`projects["${key}"].hasTrustDialogAccepted`);
    } else if (typeof entry === 'object' && !Array.isArray(entry)) {
      // 条目在，但信任字段缺失（Claude Code 某些路径只写部分字段）
      if (entry.hasTrustDialogAccepted === undefined) {
        projects[key] = { ...entry, hasTrustDialogAccepted: true };
        next.projects = projects;
        added.push(`projects["${key}"].hasTrustDialogAccepted`);
      }
      // ⚠️ `hasTrustDialogAccepted === false` **明确不动**：那是"已表态"，
      //    用户可能真的拒绝过这个目录。覆盖它 = 替用户推翻他自己的安全决定，
      //    而 `cmt exec` 的 stderr 会被 claude 的 TUI 盖掉（§2.4）——
      //    也就是说覆盖**必然是静默的**。宁可让他多点一次。
    }
  }

  return { changed: added.length > 0, next, added };
}
