// @ts-check
/**
 * ★ **项目本地配置 `<项目>/.cmt.json`**（§2.11）——级联的**第四层**，
 * 也是唯一一层**跟着仓库走**的配置。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它补的是哪个洞
 *
 * 级联前三层（`defaults` / `token` / `binding`）**全住在 `~/.claude-multi-token/`**。
 * 于是"这个项目用 A 模型、这个项目努力级别拉满"这类**属于仓库**的声明
 * 只能塞进用户的全局配置——**换个同事的机器就没了**，而且全局配置里会堆满
 * 一次性的项目条目。`.cmt.json` 让这些声明跟着仓库走：可以提交、可以 review。
 *
 * ## ★★ 全模块只有一个真正重要的东西：**禁键表**
 *
 * 这个文件会被 `git add .` 提交、会被别人克隆。所以它的 schema **故意比
 * `config.json` 窄**——`authToken` / `baseUrl` 一律不许出现。
 *
 * 其中 `baseUrl` 是**攻击面**而不是"不方便"：克隆一个仓库，它写
 * `baseUrl: "https://evil.example.com"`，你 `cmt run` 一下，
 * **你的 key 就被送到那儿去了**。禁掉它，这条通道就不存在。
 *
 * ⇒ 副产品：**`.cmt.json` 天生不含密钥，可以安全提交。**
 *    这是"禁掉那几个键"的直接推论，不是额外承诺。
 *
 * ## ⚠️ `env.CLAUDE_CONFIG_DIR` 不是"顺手多禁一个"
 *
 * `buildInjection()`（§2.6）里，`env` 层的合并**排在 `CLAUDE_CONFIG_DIR` 种子之后**：
 *
 * ```js
 * env.CLAUDE_CONFIG_DIR = profileDir(home, profileNameFor(...));  // ← 先种下隔离落点
 * for (const [k, entry] of Object.entries(resolved.env)) env[k] = entry.value;  // ← 层可以盖掉它
 * ```
 *
 * 所以 `env: { "CLAUDE_CONFIG_DIR": "C:/Users/你/.claude" }` 真的会把隔离落点改掉，
 * 而**隔离（§2.2）是 cmt 存在的理由本身**——没了它，`cmt run` 会去动用户真实的
 * `~/.claude/`。空串那个"删掉这个变量"的写法同样能达成这个效果，所以
 * 这里**不看值、只看键名**。
 *
 * ⚠️ 按**大小写不敏感**判：Windows 的环境变量名不区分大小写，只拦
 * `CLAUDE_CONFIG_DIR` 会让 `env: { "claude_config_dir": "…" }` 在 Windows 上
 * 绕过去、在 Linux 上不生效——同一份仓库配置两个平台两种语义，正是要避免的东西。
 *
 * ## 其余 `env` 键为什么放行
 *
 * `env` 这个逃生舱本身是**要**的（§2.4）。身份与目的地都锁死了
 * （`token` 只认名字、`baseUrl`/`authToken` 禁写），所以 `env` 里能做的
 * 只是调行为（`CLAUDE_CODE_EFFORT_LEVEL` 之类），不是换端点。
 * 唯一的例外就是上面那个隔离原语，故单列。
 *
 * ## 纯函数（§4.2）
 *
 * 本模块**不碰 fs**：`discoverProjectConfig()` 收一个**注入的 `isFile` 谓词**。
 * 读盘是 `store.js` 的活（`findProjectConfig()` / `readProjectConfig()`）。
 * ─────────────────────────────────────────────────────────────
 */

import { CmtError } from './errors.js';
import { dirnameFor, joinFor, PROJECT_CONFIG_FILENAME } from './paths.js';
import {
  checkVersion,
  expectPlainObject,
  normalizeClaudeArgs,
  normalizeEnv,
  normalizeModels,
  rejectUnknownKeys,
  validateTokenName,
} from './schema.js';

/**
 * 允许出现的键（§2.11 二）。
 *
 * ★ 与 §2.11 的允许列表**逐格一致**——改一处必须改另一处。
 *
 * ⚠️ **`slots` 刻意不在列**：§2.12 的边界写明"槽位不进项目文件"，
 * 否则两个面板（`models` 与 `slots`）会分叉。槽位仍走 `cmt slot set`。
 */
export const PROJECT_ALLOWED_KEYS = Object.freeze([
  'version',
  'token',
  'models',
  'env',
  'claudeArgs',
]);

/**
 * 禁止出现的键 + **每个键自己的理由**（§2.11 二）。
 *
 * ★ 数据驱动而不是一串 `if`：报错信息里的理由是这段代码里**唯一会被用户读到**的
 * 部分，把它和键名放在一起，将来加一个禁键就只改一行数据。
 *
 * ⚠️ 每个禁键都必须是**专门的报错**，不能落进 `rejectUnknownKeys` 的
 * "未知字段"——"未知字段"只说明 cmt 不认识它，说不出"这是攻击面"。
 *
 * @type {readonly { key: string, why: string, hint: string }[]}
 */
export const PROJECT_FORBIDDEN_KEYS = Object.freeze([
  Object.freeze({
    key: 'authToken',
    why: '§2.7 铁律「token 只有一个落盘点」——多一个落盘点就多一份明文副本，'
      + '而这一份会被 `git add .` 一起提交上去',
    hint: '要新身份就 `cmt token add <名字> --token <key>`，'
      + '然后在这里写 "token": "<名字>"（引用的是**名字**，不是 key）',
  }),
  Object.freeze({
    key: 'baseUrl',
    why: '★★ 这是**外泄通道**：克隆一个仓库，它写 baseUrl: "https://evil.example.com"，'
      + '你 `cmt run` 一下，你的 key 就被送到那儿去了。这条不是"不方便"，是攻击面',
    hint: '地址跟着身份走——写在 tokens/<名字>.json 的 baseUrl 里（§2.11 二）',
  }),
  Object.freeze({
    key: 'cwd',
    why: '这份文件本身就是"**按路径找到的**"——再声明 cwd 是循环定义'
      + '（拿它去匹配绑定会成环，§2.3 已有同类教训）',
    hint: 'cwd 的级联是 `--cwd` → token.cwd → 进程当前目录（§2.3）',
  }),
  Object.freeze({
    key: 'slots',
    why: '§2.12 边界：槽位不进项目文件——两个面板各配一套（models 与 slots）必然分叉',
    hint: '槽位仍走 `cmt slot set`（写在全局 defaults 或 tokens/<名字>.json 里）',
  }),
  Object.freeze({
    key: 'claudeBin',
    why: '机器级偏好，不是项目级——写进仓库只会让同事的机器按你的安装位置找 claude',
    hint: 'claudeBin 写在全局 config.json 的 defaults 里',
  }),
  Object.freeze({
    key: 'terminalMode',
    why: '机器级偏好，不是项目级——写进仓库只会让同事的终端按你的习惯开标签页/窗口',
    hint: 'terminalMode 写在全局 config.json 的 defaults 里，或命令行 `--tab` / `--window`',
  }),
  Object.freeze({
    key: 'seed',
    why: '机器级偏好，不是项目级——而且它是 §3.1 铁律的唯一例外（会去写 profile 目录），'
      + '跟着仓库走等于让别人克隆下来就触发一次写盘',
    hint: 'seed 写在全局 config.json 的 defaults 里（§3.6）',
  }),
]);

/** 禁键表 → 查找表。`normalizeProjectConfig()` 每次调用都要查，别线性扫。 */
const FORBIDDEN_KEY_MAP = new Map(PROJECT_FORBIDDEN_KEYS.map((e) => [e.key, e]));

/**
 * `env` 里禁止设置的变量名（§2.11 二）——**隔离原语**。
 *
 * 值一律小写，比对时把用户写的键也转小写（Windows 环境变量名不区分大小写）。
 */
const FORBIDDEN_ENV_KEYS = new Map([
  ['claude_config_dir', {
    canonical: 'CLAUDE_CONFIG_DIR',
    why: 'CLAUDE_CONFIG_DIR 是**隔离原语**（§2.2）——它决定 cmt 把 profile 落在哪。'
      + '项目文件改它，profile 与登录态就跟着项目走了，`cmt run` 会去动你真实的 ~/.claude/',
    hint: '隔离落点由 cmt 自己算（~/.claude-multi-token/profiles/<token>/），不许覆盖',
  }],
]);

// ───────────────────────────── 校验 ─────────────────────────────

/**
 * 禁键检查。**必须在 `rejectUnknownKeys()` 之前跑**——禁键本来就不在允许列里，
 * 顺序反了就会被"未知字段"抢先报掉，而那条信息说不出"这是攻击面"。
 *
 * 报**文件里第一个**出现的禁键（按 `Object.keys` 的插入序，也就是用户手写的顺序）：
 * 一次修一个，比一次列一屏更好读。
 *
 * @param {Record<string, any>} obj
 * @param {string} what 报错时点名的文件路径
 */
function rejectForbiddenKeys(obj, what) {
  for (const k of Object.keys(obj)) {
    const entry = FORBIDDEN_KEY_MAP.get(k);
    if (entry) {
      throw new CmtError(`${what} 不许出现 "${entry.key}" 字段`, {
        hint: `${entry.why}。${entry.hint}`,
      });
    }
  }
}

/**
 * `env` 的禁键检查（大小写不敏感，见文件头）。
 *
 * ⚠️ **不看值**：空串是"删掉这个继承来的变量"（§2.6），
 * `env: { "CLAUDE_CONFIG_DIR": "" }` 与写一个真地址是同一个后果。
 *
 * @param {Record<string, string>} env
 * @param {string} what
 */
function rejectForbiddenEnvKeys(env, what) {
  for (const k of Object.keys(env)) {
    const entry = FORBIDDEN_ENV_KEYS.get(k.toLowerCase());
    if (entry) {
      // 报**用户实际写的那个名字**——他写的是 claude_config_dir，你报大写，他会找不到
      throw new CmtError(`${what} 不许设置 ${k}`, {
        hint: `${entry.why}。${entry.hint}`,
      });
    }
  }
}

/**
 * 校验并归一 `.cmt.json`（§2.11 二）。
 *
 * 与 `normalizeConfig()` / `normalizeDefaults()` 的关系：**同一套字段归一函数，
 * 不同的允许键集合**。逐字段复用 `schema.js` 的 `normalizeModels` / `normalizeEnv` /
 * `normalizeClaudeArgs`——**不许在这里重写一遍**，那会让"什么算合法 models"
 * 出现第二处真相。
 *
 * ### 为什么返回里带 `configPath`
 *
 * 两个地方要用，且都省不掉：① 报错要点名文件（§2.11 四）；②
 * `resolveConfig()` 里 `project` 层的 `detail` 就是它——`cmt resolve` 得告诉用户
 * **是哪一份** `.cmt.json` 赢了。让调用方自己再传一遍 = 总有一天有人忘了传。
 *
 * ### 没有"备份 + 迁移"
 *
 * `config.json` 读到低版本会先备份再迁移（§3.5）；**这里不做**：
 * 这份文件在**用户的仓库里**，往里丢一个 `.cmt.json.v1.bak` 会出现在
 * `git status` 里，那是骚扰。它本来就是手写的小文件、又受版本控制，
 * 将来真需要迁移时让用户自己改更合适。
 * 读到**更高**版本照样拒绝（退出码 2，`checkVersion()` 负责）。
 *
 * @param {unknown} raw 已 `JSON.parse` 的内容
 * @param {string} configPath 该文件的路径（报错点名 + `project` 层的 detail）
 * @returns {{
 *   configPath: string, version: number,
 *   token?: string,
 *   models?: { id: string, label?: string }[],
 *   env?: Record<string, string>, claudeArgs?: string[],
 * }}
 */
export function normalizeProjectConfig(raw, configPath) {
  if (typeof configPath !== 'string' || configPath === '') {
    throw new CmtError('normalizeProjectConfig() 需要 configPath', {
      hint: 'core 不知道文件在哪——路径由调用方（store.js）传进来',
    });
  }

  // ⚠️ 顺序：禁键 → 未知键。反了的话禁键会被"未知字段"抢先报掉（见 rejectForbiddenKeys）
  const obj = expectPlainObject(raw, configPath);
  rejectForbiddenKeys(obj, configPath);
  rejectUnknownKeys(obj, PROJECT_ALLOWED_KEYS, configPath);

  const version = checkVersion(obj, configPath);

  /** @type {Record<string, any>} */
  const out = { configPath, version };

  if (obj.token !== undefined) out.token = validateTokenName(obj.token);

  const models = normalizeModels(obj.models, `${configPath}.models`);
  if (models !== undefined) out.models = models;

  const env = normalizeEnv(obj.env, `${configPath}.env`);
  if (env !== undefined) {
    rejectForbiddenEnvKeys(env, `${configPath}.env`);
    out.env = env;
  }

  if (obj.claudeArgs !== undefined) {
    out.claudeArgs = normalizeClaudeArgs(obj.claudeArgs, `${configPath}.claudeArgs`);
  }

  return out;
}

// ───────────────────────────── 发现 ─────────────────────────────

/**
 * 从 `cwd` **往上逐级**找 `.cmt.json`，**最近的一个胜出**（§2.11 一）。
 *
 * ```
 * D:/work/a/sub   →  sub/.cmt.json ?  a/.cmt.json ?  D:/.cmt.json ?  →  null
 * ```
 *
 * ### 为什么是"最近优先"而不是"找到就停"
 *
 * 同一件事：**越具体越靠上**。在 `a/sub` 里跑而 `sub/` 没配、`a/` 配了，
 * 就该用 `a/` 那份——这与 `bindings` 的最长前缀匹配是同一个直觉（§2.11 三）。
 *
 * ### 终止条件
 *
 * `dirname(dir) === dir` —— 每个平台的根都满足这个等式（`C:\`、`/`、
 * `\\server\share`、以及相对路径走到头的 `.`）。本机实测表在
 * `paths.js` 的 `dirnameFor()` 上。
 *
 * **不跨越盘符/挂载点**：走到根就停，不去猜"用户家目录的那份算不算"。
 * cmt 自己的数据目录（`~/.claude-multi-token/`）**不是**发现路径的一部分（§2.8）。
 *
 * ### `isFile` 为什么是注入的谓词
 *
 * ① core 不碰 fs（§4.2）；② 名字本身就把语义说清楚了：**一个叫 `.cmt.json` 的
 * 目录不是配置文件**，发现要**继续往上走**，而不是拿它去读、然后撞一个
 * 让人摸不着头脑的 `EISDIR`。传 `statSync(p).isFile()` 就对了。
 *
 * @param {{ cwd: string, platform: NodeJS.Platform, isFile: (p: string) => boolean }} input
 * @returns {{ configPath: string, dir: string } | null} 找不到返回 `null`（**不是**抛错）
 */
export function discoverProjectConfig({ cwd, platform, isFile }) {
  if (typeof cwd !== 'string' || cwd === '') {
    throw new CmtError('discoverProjectConfig() 需要 cwd', {
      hint: 'core 不读 process.cwd()（§4.2）——由 cli 层从 ctx.cwd 传进来',
    });
  }
  if (typeof isFile !== 'function') {
    throw new CmtError('discoverProjectConfig() 需要注入 isFile 谓词', {
      hint: 'core 不碰 fs（§4.2）。传一个 (p) => statSync(p).isFile() 进来',
    });
  }
  // 校验而不是"不是 win32 就当 posix"：这里猜错的后果是**静默找不到配置**，
  // 而静默正是本项目最不能接受的一种失败。
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new CmtError(`discoverProjectConfig() 收到未知 platform：${JSON.stringify(platform)}`, {
      hint: 'core 不读 process.platform（§4.2）——由 platform/ 层传进来',
    });
  }

  const dirname = dirnameFor(platform);
  const join = joinFor(platform);

  let dir = cwd;
  for (;;) {
    const candidate = join(dir, PROJECT_CONFIG_FILENAME);
    if (isFile(candidate)) return { configPath: candidate, dir };

    const parent = dirname(dir);
    // ★ 终止判据。`dirname` 在根上返回自己（不是 ''），所以这一条对所有平台都成立。
    if (parent === dir) return null;
    dir = parent;
  }
}
