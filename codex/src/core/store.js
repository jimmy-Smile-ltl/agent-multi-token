// @ts-check
/**
 * 配置读写（§2.8）。
 *
 * ─────────────────────────────────────────────────────────────
 * ★★ **本文件是 `core/` 里唯一允许碰 fs 的模块**（§4.2 的明文例外）。
 *
 * 其余 core 模块一律纯函数——`resolve.js` 拿到的 `config` / `tokens`
 * 就是从这里读出来再喂进去的。保持这条边界，解析链才能拿字面量穷举单测。
 *
 * **读写 cxt 自己的东西**（`~/.codex-multi-token/`）：
 * `config.json` / `tokens/*.json` / `catalogs/*.json`。
 * `profiles/<t>/config.toml` 是**双作者文件**，走 `toml-splice.js` + `writeTomlAtomic`，
 * **绝不整文件重写**（§2.9 铁律）。
 *
 * ⚠️ **唯一的例外**：`<项目>/.cxt.json`（§2.13）**不在 cxt 的数据目录里**，
 * 它在用户的仓库里。读写它仍然走本文件（"core 里只有这里碰 fs"这条边界不破），
 * 但**只在用户显式要求时写**——§3.2 的惰性原则在这里同样成立，
 * 而它唯一的写入口是面板向导第 4 步（§2.14 四）。
 * ─────────────────────────────────────────────────────────────
 *
 * ⚠️ **不读 `process.env` / `os.homedir()`**——`home` 一律由调用方传入（§4.2）。
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { CxtError, IntegrityError } from './errors.js';
import {
  CONFIG_VERSION, checkVersion, migrate, needsMigration,
  normalizeConfig, normalizeToken,
} from './schema.js';
import {
  catalogPath, configBackupPath, configPath, poolPath, profileConfigPath,
  profilesDir, projectsPath, resourcesPath, sessionDir, sessionInboxDir,
  sessionMetaPath, sessionReadDir, sessionsDir, tokenPath, tokensDir,
} from './paths.js';
import { discoverProjectConfig, normalizeProjectConfig } from './project-config.js';
import {
  isValidMessageFileName, isValidSessionId, normalizeMessage, normalizeSessionMeta,
} from './sessions.js';
import { defaultProjectState, normalizeProjectState } from './project-state.js';
import { defaultPool, normalizePool } from './pool.js';
import { defaultResources, normalizeResources } from './resources.js';

// ───────────────────────────── 底层 ─────────────────────────────

/** 目录不存在就建（递归）。存在则什么都不做。 */
export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * 读文本；文件不存在返回 `null`（**不是空串**——"没有"与"是空的"要能区分）。
 * @param {string} p
 * @returns {string | null}
 */
export function readTextIfExists(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * ★ **原子写文本**——先写同目录临时文件，再 rename 覆盖。
 *
 * rename 在同一文件系统内是原子的，所以**读者永远看不到半截文件**。
 * 直接 `writeFileSync` 到目标路径则可能在写到一半时被读到（或断电留个残file）。
 *
 * ⚠️ 只保证**不产生半截文件**，**不保证不丢更新**——两个窗口同时
 * `cxt model next` 仍可能互相覆盖（§3.5 已记录，v1 接受）。
 *
 * @param {string} p
 * @param {string} text
 */
export function writeTextAtomic(p, text) {
  ensureDir(dirname(p));
  const tmp = join(dirname(p), `.${basename(p)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    // 失败时别留垃圾
    try { rmSync(tmp, { force: true }); } catch { /* 尽力而为 */ }
    throw err;
  }
}

/**
 * 原子写 JSON（2 空格缩进 + 末尾换行——`git diff` 友好）。
 * @param {string} p
 * @param {unknown} value
 */
export function writeJsonAtomic(p, value) {
  writeTextAtomic(p, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 原子写 `config.toml` 的**新全文**。
 *
 * ⚠️ `text` **必须**是 `toml-splice.js` 的产物。任何"手工拼一份 TOML"
 * 都会把双作者文件里的用户内容抹掉（§2.9 铁律 1）。
 * @param {string} p
 * @param {string} text
 */
export function writeTomlAtomic(p, text) {
  writeTextAtomic(p, text);
}

/**
 * 一次性备份：**已存在就不覆盖**（§2.9 铁律 4）。
 * 用户第一次那份原始配置才是最该留住的。
 * @param {string} from
 * @param {string} to
 * @returns {boolean} 是否真的写了备份
 */
export function backupOnce(from, to) {
  if (existsSync(to)) return false;
  const text = readTextIfExists(from);
  if (text === null) return false;
  writeTextAtomic(to, text);
  return true;
}

// ───────────────────────────── JSON 读 ─────────────────────────────

/**
 * @param {string} p
 * @param {string} what 人看的名字（报错用）
 * @returns {any}
 */
function readJson(p, what) {
  const text = readTextIfExists(p);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new CxtError(`${what} 不是合法 JSON：${p}`, {
      hint: `${/** @type {any} */ (err).message}\n`
        + '手改坏了可以删掉它重新生成（token 文件删了要重新 `cxt token add`）',
    });
  }
}

/**
 * 读全局配置（§2.4）。
 *
 * **文件不存在不是错误**——首次运行就是这个状态，返回一份空配置。
 * @param {string} home
 * @returns {{ version: number, defaults: any, bindings: any[] }}
 */
export function readConfig(home) {
  const p = configPath(home);
  const raw = readJson(p, 'config.json');
  if (raw === null) return { version: CONFIG_VERSION, defaults: {}, bindings: [] };

  const version = checkVersion(raw);

  if (needsMigration(version)) {
    // ★ 迁移前先备份（§3.5）——迁移逻辑写错了还能救回来
    const bak = configBackupPath(home, version);
    writeJsonAtomic(bak, raw);
    const migrated = migrate(raw, version);
    const normalized = normalizeConfig(migrated);
    writeJsonAtomic(p, normalized);
    return normalized;
  }

  return normalizeConfig(raw);
}

/**
 * 写全局配置。
 * @param {string} home
 * @param {any} config
 */
export function writeConfig(home, config) {
  writeJsonAtomic(configPath(home), { version: CONFIG_VERSION, ...config });
}

/**
 * 读项目状态（§2.14 十 的「项目状态与身份联动」）。
 *
 * **文件不存在不是错误**——返回一份全默认（`defaultProjectState()`），
 * 而且**不写盘**：只在用户真的改了一档之后才出现这个文件（§3.2 的惰性）。
 *
 * @param {string} home
 * @returns {ReturnType<typeof defaultProjectState>}
 */
export function readProjectState(home) {
  const raw = readJson(projectsPath(home), 'projects.json');
  return raw === null ? defaultProjectState() : normalizeProjectState(raw);
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
 * 读资源登记（§2.14 十一）。
 *
 * ★★ **坏文件不硬报**——这是它与 `readProjectState()`（以及 `readConfig()`）**故意**的差别：
 * `readJson()` 对坏 JSON 是抛 `CxtError` 的，因为 `config.json` / `tokens/` 是承重配置，
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
    const raw = readJson(resourcesPath(home), 'resources.json');
    return raw === null ? defaultResources() : normalizeResources(raw);
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
 * 读 token 池（§2.15）。
 *
 * ★★ **坏文件不硬报**——与 `readResources()` 同一条理由：`pool.json` 是可丢弃的
 * 状态覆盖层，它坏掉只该让整个池退化成"全都是 unknown"（= 全部重探一遍），
 * 而**不该让 `cxt run` 起不来**。密钥在 `tokens/` 里，一个都没丢。
 *
 * ★ **孤立条目在这里不过滤**——那要知道盘上有哪些 token，是另一件事，
 * 由 CLI 层用 `listTokenNames()` 交叉一遍（§2.15 二）。
 *
 * 文件不存在同样返回空池，而且**不写盘**（§3.2 的惰性）。
 *
 * @param {string} home
 * @returns {ReturnType<typeof defaultPool>}
 */
export function readPool(home) {
  try {
    const raw = readJson(poolPath(home), 'pool.json');
    return raw === null ? defaultPool() : normalizePool(raw);
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
 * 读一个 token（§2.4）。**不存在返回 `null`**，由调用方决定怎么说。
 * @param {string} home
 * @param {string} name
 * @returns {any | null}
 */
export function readToken(home, name) {
  const raw = readJson(tokenPath(home, name), `token ${name}`);
  return raw === null ? null : normalizeToken(raw, name);
}

/**
 * 列出 `tokens/` 下的 token 名（去扩展名，已排序）。
 * 目录不存在 → 空表。
 * @param {string} home
 * @returns {string[]}
 */
export function listTokenNames(home) {
  const dir = tokensDir(home);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * 一次读全部 token，供 `resolve()` 的 `tokens` 参数用（§4.2）。
 *
 * 坏掉的 token 文件**照样抛错**——不要"跳过坏的继续"：
 * 那会让 `cxt resolve` 显示的是一份静默缺了东西的结果，
 * 而它恰恰是用来排查"为什么不对"的工具。
 * @param {string} home
 * @returns {Record<string, any>}
 */
export function readAllTokens(home) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const name of listTokenNames(home)) {
    out[name] = readToken(home, name);
  }
  return out;
}

// ─────────────────────── config.toml（双作者文件）───────────────────────

/**
 * 读 `profiles/<t>/config.toml` 的**原文**。不存在 → `''`。
 *
 * ★ 返回**原文**而不是解析结果——那是双作者文件，我们只做行级拼接，
 * 不做 TOML 解析（§2.9 实现：行级拼接器，不是 TOML 解析器）。
 * @param {string} home
 * @param {string} token
 */
export function readProfileConfig(home, token) {
  return readTextIfExists(profileConfigPath(home, token)) ?? '';
}

/**
 * 写回 `profiles/<t>/config.toml`。
 *
 * ★★ **`text` 必须是 `spliceManagedRegion()` 的产物**。
 * 这里额外守一道：如果新文本比原文少了 `[projects.` 出现次数，直接拒写——
 * 那意味着有人绕过拼接器整文件重写了，而 `[projects.*]` 是 Codex 的信任记录，
 * **删掉它 = 静默让所有项目重新变成未信任**（§2.9 铁律 2）。
 *
 * @param {string} home
 * @param {string} token
 * @param {string} text
 * @param {string} [previousText] 原文；给了才做上面的守门
 */
export function writeProfileConfig(home, token, text, previousText) {
  if (previousText !== undefined) {
    const before = countProjects(previousText);
    const after = countProjects(text);
    if (after < before) {
      throw new IntegrityError(
        `拒写 ${profileConfigPath(home, token)}：新文本少了 ${before - after} 条 [projects.*] 记录`,
        { hint: '这是拼接器的 bug——它必须逐字节保留非受管区内容（§2.9 铁律 1/2）。'
            + '请先备份该文件再提 issue' },
      );
    }
  }
  writeTomlAtomic(profileConfigPath(home, token), text);
}

/** @param {string} text */
function countProjects(text) {
  return (text.match(/^\s*\[\[?projects\./gm) ?? []).length;
}

/**
 * 列出 `profiles/` 下的**目录名**（已排序）。目录不存在 → 空表。
 *
 * ★ 判据是"**是个目录**"，不是"有 config.toml"。
 * 因为 `cxt profile ls` / `cxt trust ls` 要回答的一个问题恰恰是
 * 「哪些 profile 是**孤儿**」——`cxt token rm` 默认保留 profile 目录（§3.3），
 * 所以目录在、token 没了是**常态**，而那种目录往往连 config.toml 都没有。
 * 只列有 config.toml 的那些，就会把最需要看见的东西藏起来。
 *
 * @param {string} home
 * @returns {string[]}
 */
export function listProfileNames(home) {
  const dir = profilesDir(home);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];   // 权限之类的问题不该让"看一眼有哪些 profile"这个动作整个失败
  }
}

// ───────────────────────────── 其它 ─────────────────────────────

/**
 * catalog 文件（§7.5）——cxt 生成，Codex 只读。
 * @param {string} home
 * @param {string} name
 */
export function readCatalog(home, name) {
  return readJson(catalogPath(home, name), `catalog ${name}`);
}

/**
 * @param {string} home
 * @param {string} name
 * @param {unknown} value
 */
export function writeCatalog(home, name, value) {
  writeJsonAtomic(catalogPath(home, name), value);
}

/**
 * 文件多大（字节）？不存在 → `null`。`doctor` 用它查 AGENTS.md 截断（§7.11）。
 * @param {string} p
 */
export function fileSize(p) {
  try {
    return statSync(p).size;
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') return null;
    throw err;
  }
}

// ─────────────────────── 项目本地配置（§2.13）───────────────────────

/**
 * 从 `cwd` 往上找最近的 `.cxt.json`。找不到返回 `null`。
 *
 * 逻辑全在 `project-config.js` 的 `discoverProjectConfig()` 里（纯函数、可穷举单测）；
 * 这里只做一件事：**把 `isFile` 谓词接上真实的 fs**。
 *
 * ⚠️ `statSync` 而不是 `existsSync`：一个叫 `.cxt.json` 的**目录**不是配置文件，
 * 发现要继续往上走，而不是拿它去读、然后撞一个让人摸不着头脑的 `EISDIR`。
 * 顺带把权限错误之类的怪情况也一起吞掉（当作"这里没有"），
 * 否则一个读不了的子目录会让整个 `cxt run` 失败在一个跟配置无关的地方。
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
 * 读并校验一份项目本地配置（§2.13 二）。
 *
 * ★ **坏文件硬报错**（§2.13 四）：JSON 非法 / 缺 `version` / 含禁键 → 抛错，
 * **绝不静默跳过**。静默跳过的表现是"我明明配了，怎么没生效"——
 * 而这句话会消耗掉用户半小时。
 *
 * ⚠️ 与 `readConfig()` 不同，**文件不存在是错误**：调用方要么是"发现"找出来的
 * （那就一定存在，不存在说明两次 fs 调用之间被删了），要么是 `--config <path>`
 * 显式给的——而"显式给了路径却悄悄用别的文件"是最难排查的一类静默失效（§2.13 一）。
 *
 * ⚠️ **没有备份 + 迁移**（理由见 `normalizeProjectConfig()` 的注释）。
 *
 * @param {string} configPath
 * @returns {ReturnType<typeof normalizeProjectConfig>}
 */
export function readProjectConfig(configPath) {
  const what = `项目本地配置 ${configPath}`;

  let st;
  try {
    st = statSync(configPath);
  } catch (err) {
    if (/** @type {any} */ (err).code === 'ENOENT') {
      throw new CxtError(`找不到项目本地配置：${configPath}`, {
        hint: '`--config <path>` 给的路径必须存在（cxt 不回退到"往上找"，§2.13 一）；'
          + '想用自动发现就别带 `--config`',
      });
    }
    throw err;
  }
  if (st.isDirectory()) {
    throw new CxtError(`项目本地配置是个目录，不是文件：${configPath}`, {
      hint: `要的是里面的 ${basename(configPath)} 文件本身`,
    });
  }

  const raw = readJson(configPath, what);
  if (raw === null) {
    // statSync 说在、readTextIfExists 说不在——两次调用之间被删了。罕见但要说清楚。
    throw new CxtError(`项目本地配置读不到：${configPath}`, {
      hint: '文件在读取前被删掉了。重新建一份，或去掉 `--config`',
    });
  }

  return normalizeProjectConfig(raw, configPath);
}

/**
 * 写项目本地配置（§2.13）。
 *
 * ★★ **这是 `.cxt.json` 唯一的写入口，而它只该被面板向导第 4 步调用**
 * （§3.2 / §2.13 六：cxt **绝不自动创建**它）。
 *
 * 写成 2 空格缩进 + 结尾换行（与其它 `writeJsonAtomic` 一致）——
 * 这份文件是要被提交、被 review 的，diff 得好看。
 *
 * @param {string} configPath
 * @param {{ version?: number, token?: string, models?: any[], catalog?: any,
 *   providerId?: string, env?: Record<string, string>, sandboxMode?: string,
 *   approvalPolicy?: string, codexArgs?: string[] }} value
 */
export function writeProjectConfig(configPath, value) {
  const { version = CONFIG_VERSION, ...rest } = value;
  writeJsonAtomic(configPath, { version, ...rest });
}

// ───────────────────── 会话在场层与消息信箱（§2.16）─────────────────────

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
    const raw = readJson(sessionMetaPath(home, id), '会话记录');
    return raw === null ? null : normalizeSessionMeta(raw, id);
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
 * 投一条消息到目标会话的 inbox（§2.16 三）。**一消息一文件**，原子写。
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
    const raw = readJson(join(fileDir, fileName), '消息');
    return raw === null ? null : normalizeMessage(raw);
  } catch {
    return null;
  }
}

/**
 * 标记一条消息已读：inbox → read，**同一会话目录树内 rename**（原子，§2.16 三）。
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
