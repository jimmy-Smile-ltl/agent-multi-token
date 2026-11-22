// @ts-check
/**
 * 配置读写（§4.1）——**本文件是 core 里唯一碰 fs 的地方**。
 *
 * 纯逻辑（级联、绑定匹配、列表运算）都在别的模块；这里只负责
 * "把文件变成对象"和"把对象变成文件"，外加 §3.5 的写入纪律：
 *
 * - 所有写入走 `writeJsonAtomic()`（临时文件 + rename），杜绝半截文件
 * - 目录创建统一走 `ensureDir()`
 * - 含 token 的文件在 POSIX 下 `chmod 0600`
 * - 版本不匹配：**更高** → 拒绝启动（退出码 2）；**更低** → 先备份再迁移
 *
 * ⚠️ **`writeJsonAtomic()` 只保证不产生半截文件，不保证不丢更新。**
 * 两个窗口同时 `cmt model next` 可能互相覆盖——单用户 CLI，接受此风险（§3.5）。
 *
 * ⚠️ Windows 上 `chmod` 基本是 no-op（只影响只读位），实际依赖用户目录 ACL。
 * 这里照样调用（在 POSIX 上真的生效），但**别假装它在 Windows 上设了权限**——README 必须说明。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CmtError, EnvError } from './errors.js';
import {
  configBackupPath,
  configPath,
  PROJECT_CONFIG_FILENAME,
  poolPath,
  profileDir,
  projectsPath,
  resourcesPath,
  rootDir,
  sessionDir,
  sessionInboxDir,
  sessionMetaPath,
  sessionReadDir,
  sessionsDir,
  tokenPath,
  tokensDir,
} from './paths.js';
import { discoverProjectConfig, normalizeProjectConfig } from './project-config.js';
import {
  isValidMessageFileName,
  isValidSessionId,
  normalizeMessage,
  normalizeSessionMeta,
} from './sessions.js';
import { defaultPool, normalizePool } from './pool.js';
import { defaultProjectState, normalizeProjectState } from './project-state.js';
import { defaultResources, normalizeResources } from './resources.js';
import { planSeed } from './seed.js';
import {
  checkVersion,
  CONFIG_VERSION,
  migrate,
  needsMigration,
  normalizeConfig,
  normalizeToken,
  validateTokenName,
} from './schema.js';

/** 新建 config.json 时的初始内容（§2.4） */
export function emptyConfig() {
  return { version: 1, defaults: {}, bindings: [] };
}

/**
 * `mkdir -p` 语义。
 * @param {string} dir
 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/**
 * 原子写文本（§3.5）：先写临时文件，再 rename 覆盖。
 *
 * rename 在同一文件系统内是原子的，所以**永远不会留下半截文件**——
 * 断电 / 并发 / 磁盘满都只会看到旧版本或新版本，不会看到残骸。
 *
 * ⚠️ 文本按**原样**写入，换行符由调用方决定（`.cmd` 要 CRLF、`.sh` 要 LF，§2.10）。
 *
 * @param {string} path
 * @param {string} content
 * @param {{ mode?: number }} [opts]
 */
export function writeFileAtomic(path, content, { mode = 0o600 } = {}) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, content, 'utf8');
    chmodSync(tmp, mode); // POSIX 生效；Windows 上无意义（见文件头）
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败不该盖住原始错误 */
    }
    throw new EnvError(`写不了 ${path}：${/** @type {any} */ (err).message}`, {
      hint: '检查该目录是否可写、磁盘是否已满',
    });
  }
}

/**
 * 原子写 JSON（§3.5）。
 * @param {string} path
 * @param {unknown} data
 */
export function writeJsonAtomic(path, data) {
  writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

/**
 * 读 JSON，把"文件不存在"与"文件坏了"分开报。
 *
 * **剥 BOM**：PowerShell 的 `Out-File -Encoding utf8` 会带 BOM，
 * 而 `JSON.parse` 见到 BOM 直接抛——Windows 用户手写配置时极易踩。
 *
 * @param {string} path
 * @returns {{ exists: false } | { exists: true, value: any }}
 */
function readJsonIfExists(path) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return { exists: false };
    throw new EnvError(`读不了 ${path}：${/** @type {any} */ (err).message}`);
  }

  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return { exists: true, value: JSON.parse(clean) };
  } catch (err) {
    throw new CmtError(`${path} 不是合法 JSON：${/** @type {any} */ (err).message}`, {
      hint: '对照 README 检查括号与逗号；文件损坏时可删掉它重新生成',
    });
  }
}

/**
 * 读取并归一 `config.json`。
 *
 * **文件不存在不是错误**——返回一份空配置，且**不创建文件**（§3.2 惰性创建：
 * 目录与文件由 `cmt token add` / `cmt bind` 按需建立）。
 *
 * @param {{ home: string }} args
 * @returns {{ config: any, path: string, exists: boolean }}
 */
export function loadConfig({ home }) {
  const path = configPath(home);
  const r = readJsonIfExists(path);
  if (!r.exists) return { config: emptyConfig(), path, exists: false };

  const version = checkVersion(r.value); // 更高版本 → EnvError（退出码 2）
  let raw = r.value;

  if (needsMigration(version)) {
    // §3.5：迁移前先把原文件备份成 config.json.v<旧版本>.bak
    writeJsonAtomic(configBackupPath(home, version), raw);
    raw = migrate(raw, version);
    writeJsonAtomic(path, raw);
  }

  return { config: normalizeConfig(raw), path, exists: true };
}

/**
 * @param {{ home: string, config: any }} args
 */
export function saveConfig({ home, config }) {
  writeJsonAtomic(configPath(home), config);
}

// ───────────────────────── 项目状态（§2.12 十一）─────────────────────────

/**
 * 读项目状态（§2.12 十一 的「项目状态与身份联动」）。
 *
 * **文件不存在不是错误**——返回一份全默认（`defaultProjectState()`），
 * 而且**不写盘**：只在用户真的改了一档之后才出现这个文件（§3.2 的惰性）。
 *
 * @param {string} home
 * @returns {ReturnType<typeof defaultProjectState>}
 */
export function readProjectState(home) {
  const r = readJsonIfExists(projectsPath(home));
  return r.exists ? normalizeProjectState(r.value) : defaultProjectState();
}

/**
 * 写项目状态。整体 `writeJsonAtomic()`——与 `config.json` 同一个写口，
 * **没有第二套**（§3.1）。
 *
 * ★ 写之前再过一遍 `normalizeProjectState()`：调用方可能只改了 `projects` 的一半，
 * 落盘的那一份必须是完整的形状（否则下次读回来 `statuses` 是空的）。
 *
 * @param {string} home
 * @param {ReturnType<typeof defaultProjectState>} state
 */
export function writeProjectState(home, state) {
  writeJsonAtomic(projectsPath(home), normalizeProjectState(state));
}

/**
 * 读资源登记（§2.14 十二）。
 *
 * ★★ **坏文件不硬报**——这是它与 `readProjectState()`（以及 `loadConfig()`）**故意**的差别：
 * `readJsonIfExists()` 对坏 JSON 是抛 `CmtError` 的，因为 `config.json` / `tokens/` 是承重配置，
 * 读不懂就必须让人知道。而 `resources.json` 是**可丢弃的登记**：它坏了只该让下拉少几项、
 * 资源表回到「未拉取」，下一次「拉取」就重建。**一份坏缓存不许把面板打死。**
 *
 * 文件不存在同样不是错误，返回空表，而且**不写盘**（§3.2 的惰性）。
 *
 * @param {string} home
 * @returns {ReturnType<typeof defaultResources>}
 */
export function readResources(home) {
  try {
    const r = readJsonIfExists(resourcesPath(home));
    return r.exists ? normalizeResources(r.value) : defaultResources();
  } catch {
    return defaultResources();
  }
}

/**
 * 写资源登记。整体 `writeJsonAtomic()`——与 `config.json` 同一个写口，**没有第二套**（§3.1）。
 *
 * ★ 写之前再过一遍 `normalizeResources()`：调用方可能只拼了半份，落盘的必须是完整形状。
 *
 * @param {string} home
 * @param {ReturnType<typeof defaultResources>} resources
 */
export function writeResources(home, resources) {
  writeJsonAtomic(resourcesPath(home), normalizeResources(resources));
}

/**
 * 读 token 池（§2.13）。
 *
 * ★★ **坏文件不硬报**——与 `readResources()` 同一条理由：`pool.json` 是可丢弃的
 * 状态覆盖层，它坏掉只该让整个池退化成"全都是 unknown"（= 全部重探一遍），
 * 而**不该让 `cmt run` 起不来**。密钥在 `tokens/` 里，一个都没丢。
 *
 * ★ **孤立条目在这里不过滤**——那要知道盘上有哪些 token，是另一件事，
 * 由 CLI 层用 `listTokenNames()` 交叉一遍（§2.13 二）。
 *
 * 文件不存在同样返回空池，而且**不写盘**（§3.2 的惰性）。
 *
 * @param {string} home
 * @returns {ReturnType<typeof defaultPool>}
 */
export function readPool(home) {
  try {
    const r = readJsonIfExists(poolPath(home));
    return r.exists ? normalizePool(r.value) : defaultPool();
  } catch {
    return defaultPool();
  }
}

/**
 * 写 token 池。整体 `writeJsonAtomic()`——与 `config.json` 同一个写口，**没有第二套**（§3.1）。
 *
 * ★ **调用方必须是"先读-改-写整份"**：这个函数收的是一整份池，不是补丁。
 * 只捏出 `{entries: {这一个}}` 就写下去，会把其余条目和 `lastPick` 一起抹掉。
 *
 * @param {string} home
 * @param {ReturnType<typeof defaultPool>} pool
 */
export function writePool(home, pool) {
  writeJsonAtomic(poolPath(home), normalizePool(pool));
}

/**
 * 读取并归一 `tokens/<name>.json`。
 *
 * **文件不存在不是错误**——返回 `token: null`，由调用方决定怎么说
 * （`cmt resolve` 只提示，`cmt run` 报错）。
 *
 * @param {{ home: string, name: string }} args
 * @returns {{ token: any | null, path: string, exists: boolean }}
 */
export function loadToken({ home, name }) {
  validateTokenName(name);
  const path = tokenPath(home, name);
  const r = readJsonIfExists(path);
  if (!r.exists) return { token: null, path, exists: false };
  return { token: normalizeToken(r.value, name), path, exists: true };
}

/**
 * @param {{ home: string, token: any }} args
 */
export function saveToken({ home, token }) {
  validateTokenName(token.name);
  writeJsonAtomic(tokenPath(home, token.name), token);
}

/**
 * @param {{ home: string, name: string }} args
 */
export function deleteToken({ home, name }) {
  validateTokenName(name);
  const path = tokenPath(home, name);
  if (!existsSync(path)) {
    throw new CmtError(`token "${name}" 不存在`, {
      hint: '用 `cmt ls` 查看现有 token',
    });
  }
  rmSync(path);
}

/**
 * 列出全部 token 名（按字母序）。
 *
 * 目录不存在 → 空列表，**不创建目录**（§3.2）。
 * @param {{ home: string }} args
 * @returns {string[]}
 */
export function listTokenNames({ home }) {
  const dir = tokensDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .filter((n) => {
      try {
        validateTokenName(n);
        return true;
      } catch {
        return false; // 手工塞进去的非法文件名，忽略而不是让整个列表崩掉
      }
    })
    .sort();
}

/**
 * 根目录是否已存在（`cmt doctor` 用来判断"从没用过"）。
 * @param {{ home: string }} args
 */
export function appDirExists({ home }) {
  return existsSync(rootDir(home));
}

/**
 * 拼一个供测试 / 提示用的展示路径。
 * @param {string} home
 * @param {string} name
 */
export function tokenFilePath(home, name) {
  return join(tokensDir(home), `${name}.json`);
}

// ───────────────────────── 项目本地配置（§2.11）─────────────────────────

/**
 * 从 `cwd` 往上找最近的 `.cmt.json`。找不到返回 `null`。
 *
 * 逻辑全在 `project-config.js` 的 `discoverProjectConfig()` 里（纯函数、可穷举单测）；
 * 这里只做一件事：**把 `isFile` 谓词接上真实的 fs**。
 *
 * ⚠️ `statSync` 而不是 `existsSync`：一个叫 `.cmt.json` 的**目录**不是配置文件，
 * 发现要继续往上走，而不是拿它去读、然后撞一个让人摸不着头脑的 `EISDIR`。
 * 顺带把权限错误之类的怪情况也一起吞掉（当作"这里没有"），
 * 否则一个读不了的子目录会让整个 `cmt run` 失败在一个跟配置无关的地方。
 *
 * @param {{ cwd: string, platform: NodeJS.Platform }} input
 * @returns {{ configPath: string, dir: string } | null}
 */
export function findProjectConfig({ cwd, platform }) {
  return discoverProjectConfig({
    cwd,
    platform,
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
  });
}

/**
 * 读并校验一份项目本地配置（§2.11 二）。
 *
 * ★ **坏文件硬报错**（§2.11 四）：JSON 非法 / 缺 `version` / 含禁键 → 抛错，
 * **绝不静默跳过**。静默跳过的表现是"我明明配了，怎么没生效"——
 * 而这句话会消耗掉用户半小时。
 *
 * ⚠️ 与 `loadConfig()` 不同，**文件不存在是错误**：调用方要么是"发现"找出来的
 * （那就一定存在，不存在说明两次 fs 调用之间被删了），要么是 `--config <path>`
 * 显式给的——而"显式给了路径却悄悄用别的文件"是最难排查的一类静默失效（§2.11 一）。
 *
 * ⚠️ **没有备份 + 迁移**（理由见 `normalizeProjectConfig()` 的注释）。
 *
 * @param {string} configPath
 * @returns {ReturnType<typeof normalizeProjectConfig>}
 */
export function readProjectConfig(configPath) {
  const what = `项目本地配置 ${configPath}`;

  /** @type {import('node:fs').Stats} */
  let st;
  try {
    st = statSync(configPath);
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') {
      throw new CmtError(`找不到项目本地配置：${configPath}`, {
        hint: '`--config <path>` 给的路径必须存在（cmt 不回退到"往上找"，§2.11 一）；'
          + '想用自动发现就别带 `--config`',
      });
    }
    throw err;
  }
  if (st.isDirectory()) {
    throw new CmtError(`项目本地配置是个目录，不是文件：${configPath}`, {
      hint: `要的是里面的 ${PROJECT_CONFIG_FILENAME} 文件本身`,
    });
  }

  const r = readJsonIfExists(configPath);
  if (!r.exists) {
    // statSync 说在、readFileSync 说不在——两次调用之间被删了。罕见但要说清楚。
    throw new CmtError(`项目本地配置读不到：${configPath}`, {
      hint: '文件在读取前被删掉了。重新建一份，或去掉 `--config`',
    });
  }

  return normalizeProjectConfig(r.value, configPath);
}

/**
 * 写项目本地配置（§2.11）。
 *
 * ★★ **这是 `.cmt.json` 唯一的写入口，而它只该被两处调用**：
 * ① 面板向导第 4 步（§2.12 四）；② `cmt model set/use/next/clear --path <p>`
 * 在该路径**已有**一份声明了 `models` 的 `.cmt.json` 时（§2.11 五）。
 * 除此之外 cmt **绝不自动创建**它（§2.11 六 / §3.1 惰性）。
 *
 * 写成 2 空格缩进 + 结尾换行（与其它 `writeJsonAtomic` 一致）——
 * 这份文件是要被提交、被 review 的，diff 得好看。
 *
 * @param {string} configPath
 * @param {{ version?: number, token?: string, models?: any[],
 *   env?: Record<string, string>, claudeArgs?: string[] }} value
 */
export function writeProjectConfig(configPath, value) {
  const { version = CONFIG_VERSION, ...rest } = value;
  writeJsonAtomic(configPath, { version, ...rest });
}

/**
 * 启动前播种 `profiles/<profile>/.claude.json`（§3.6）——**§3.1 铁律的唯一例外**。
 *
 * 只**新增缺失的键**，落盘决策全在 `planSeed()`（纯函数，那边有完整理由）。
 * 这里只负责三件 IO 上的事，每一件都是"宁可不做也不能做错"：
 *
 * 1. **写前重读**（并发护栏）。两次读之间文件变了 → 说明 Claude Code 正在写同一个文件，
 *    我们手里这份快照已经旧了，拿它覆盖会抹掉对方刚写的东西。撒手，回 `raced`。
 *    ⚠️ `writeJsonAtomic()` **挡不住这个**——它保证不产生半截文件，
 *    **不保证不丢更新**（§3.5 明写）。原子 ≠ 并发安全。
 * 2. **首次播种前留一份备份**，且只留一次（不覆盖已有备份）。改的是 Claude Code 的文件，
 *    出事时得能原样退回去。
 * 3. **从不抛错**。播种是锦上添花：磁盘满 / JSON 坏了，正确的结局是"弹一次对话框"，
 *    不是"窗口打不开"。所以失败只回一个 `warning`，由调用方决定怎么喊。
 *
 * @param {{
 *   home: string,
 *   profile: string,            profile 名（`profileNameFor(tokenName)`，不是 token 名）
 *   cwd: string,                即将启动 claude 的目录
 *   mode: string,               `defaults.seed`
 *   platform: NodeJS.Platform,
 * }} args
 * @returns {{ changed: boolean, added: string[], warning: string | null, raced?: boolean }}
 */
export function seedProfile({ home, profile, cwd, mode, platform }) {
  if (!mode || mode === 'off') return { changed: false, added: [], warning: null };

  const path = join(profileDir(home, profile), '.claude.json');

  /** @type {any} */
  let before;
  let existed;
  try {
    const r = readJsonIfExists(path);
    existed = r.exists;
    before = r.exists ? r.value : {};
  } catch (err) {
    // 读不动 / 不是合法 JSON。Claude Code 自己会修它（二进制里有 auto-repair 路径），
    // 我们插一脚只会更糟。回一句警告就走，绝不拦启动。
    return { changed: false, added: [], warning: `跳过播种：${/** @type {any} */ (err).message}` };
  }

  const plan = planSeed({ current: before, cwd, mode, platform });
  if (!plan.changed) return { changed: false, added: [], warning: null };

  try {
    const again = readJsonIfExists(path);
    const now = again.exists ? again.value : {};
    if (JSON.stringify(now) !== JSON.stringify(before)) {
      return { changed: false, added: [], warning: null, raced: true };
    }
  } catch {
    // 第二次读都读不动了 → 对面正在改，同上撒手
    return { changed: false, added: [], warning: null, raced: true };
  }

  try {
    if (existed && !existsSync(`${path}.cmt.bak`)) {
      writeFileAtomic(`${path}.cmt.bak`, readFileSync(path, 'utf8'), { mode: 0o600 });
    }
    writeJsonAtomic(path, plan.next);
  } catch (err) {
    return { changed: false, added: [], warning: `播种失败：${/** @type {any} */ (err).message}` };
  }

  return { changed: true, added: plan.added, warning: null };
}

// ───────────────────── 会话在场层与消息信箱（§2.14）─────────────────────

/**
 * 读一份会话 meta。
 *
 * ★ **宽容、永不抛**：在场记录是可丢弃的（§3.4）。不存在 / 半截 JSON / 手改坏了，
 * 一律回 `null`——一份坏的在场记录不该让任何命令失败。
 * @param {string} home
 * @param {string} id
 * @returns {ReturnType<typeof normalizeSessionMeta> | null}
 */
export function readSessionMeta(home, id) {
  try {
    const r = readJsonIfExists(sessionMetaPath(home, id));
    return r.exists ? normalizeSessionMeta(r.value, id) : null;
  } catch {
    return null;
  }
}

/**
 * 写一份会话 meta（整体 `writeJsonAtomic()`）。
 * ★ 调用方要做**读-改-写整份**：退出时只补 `endedAt` / `exitCode`，不是拼一份新的。
 * @param {string} home
 * @param {ReturnType<typeof normalizeSessionMeta>} meta
 */
export function writeSessionMeta(home, meta) {
  writeJsonAtomic(sessionMetaPath(home, meta.id), meta);
}

/**
 * 列出全部会话 id（`sessions/` 下的目录名）。
 *
 * 目录不存在 → `[]`，**不创建目录**（§3.2 的惰性）。非法目录名跳过。
 * @param {string} home
 * @returns {string[]}
 */
export function listSessionIds(home) {
  const dir = sessionsDir(home);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isValidSessionId(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 删一个会话目录（`sessions prune`）。不存在 → `false`。
 * @param {string} home
 * @param {string} id
 */
export function removeSessionDir(home, id) {
  const dir = sessionDir(home, id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 投一条消息到目标会话的 inbox（§2.14 三）。**一消息一文件**，原子写。
 * @param {string} home
 * @param {string} sessionId
 * @param {string} fileName
 * @param {ReturnType<typeof normalizeMessage>} message
 */
export function writeSessionMessage(home, sessionId, fileName, message) {
  writeJsonAtomic(join(sessionInboxDir(home, sessionId), fileName), message);
}

/**
 * 列一个目录里的消息文件名（按名字排序 = 时间顺序）。坏名跳过。
 * @param {string} dir
 * @returns {string[]}
 */
function listMessageFiles(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => isValidMessageFileName(f)).sort();
  } catch {
    return [];
  }
}

/** @param {string} home @param {string} sessionId */
export function listSessionMessages(home, sessionId) {
  return listMessageFiles(sessionInboxDir(home, sessionId));
}

/** @param {string} home @param {string} sessionId */
export function listSessionReadMessages(home, sessionId) {
  return listMessageFiles(sessionReadDir(home, sessionId));
}

/**
 * 读一条消息（目录 + 文件名）。坏 JSON → `null`。
 * @param {string} fileDir
 * @param {string} fileName
 * @returns {ReturnType<typeof normalizeMessage>}
 */
export function readSessionMessage(fileDir, fileName) {
  try {
    const r = readJsonIfExists(join(fileDir, fileName));
    return r.exists ? normalizeMessage(r.value) : null;
  } catch {
    return null;
  }
}

/**
 * 标记一条消息已读：inbox → read，**同一会话目录树内 rename**（原子，§2.14 三）。
 * 「已读」不是一个字段，是文件的位置。
 * @param {string} home
 * @param {string} sessionId
 * @param {string} fileName
 * @returns {boolean}
 */
export function markSessionMessageRead(home, sessionId, fileName) {
  const to = join(sessionReadDir(home, sessionId), fileName);
  ensureDir(dirname(to));
  try {
    renameSync(join(sessionInboxDir(home, sessionId), fileName), to);
    return true;
  } catch {
    return false;
  }
}

/**
 * 删一条消息文件（`msg gc` 用）。返回是否删掉了。
 * @param {string} fileDir
 * @param {string} fileName
 */
export function removeSessionMessage(fileDir, fileName) {
  try {
    rmSync(join(fileDir, fileName), { force: true });
    return true;
  } catch {
    return false;
  }
}
