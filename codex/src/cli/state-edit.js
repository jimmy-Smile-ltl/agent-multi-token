// @ts-check
/**
 * ★ **状态写入的唯一入口**（§3.5）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么要收成一个文件
 *
 * 不是为了少写几行，而是因为**几条不变量必须只有一个落点**：
 *
 * | 不变量 | 出处 | 怎么守 |
 * |--------|------|--------|
 * | `[projects.*]` 只增不减 | §2.9 铁律 2 | `writeProfileConfig` 的守门——但它**只有拿到原文才生效** |
 * | 原子写（不留半截文件） | §3.5 | 一律走 `writeJsonAtomic` / `writeTomlAtomic` |
 * | `version` 字段 | §3.5 | `writeConfig` 负责补，调用方不用记 |
 * | 路径只从 `core/paths.js` 取 | §3.5 | 本文件里**不出现**任何 `~/.codex-multi-token` 字面量 |
 * | 绝不碰 `~/.codex/` | §2.9 | 结构性保证：本文件只认 `ctx.home` 下的那三个目录 |
 *
 * 散在各命令里的话，**"忘了把原文传给守门"** 这种错不会报任何错——
 * 它只会安静地让 `[projects.*]` 保护失效，直到某天用户的信任记录被吃掉。
 *
 * ## ⚠️ 读-改-写不加锁（§3.5）
 *
 * 两个窗口同时 `cxt model next` 可能互相覆盖。原子写只保证**不产生半截文件**，
 * **不保证不丢更新**——别把两者混为一谈。v1 接受这个风险，本期不引入锁文件。
 * ─────────────────────────────────────────────────────────────
 */

import { existsSync, readdirSync, rmSync } from 'node:fs';

import { CxtError } from '../core/errors.js';
import {
  configPath, profileConfigPath, profileDir, profilesDir, rootDir, tokenPath, tokensDir,
} from '../core/paths.js';
import {
  ensureDir, readConfig, readProfileConfig, readToken, writeConfig,
  writeJsonAtomic, writeProfileConfig,
} from '../core/store.js';

/**
 * 读 → 改 → 写 `config.json`。
 *
 * `fn` 可以原地改 `config`（返回 `undefined`），也可以返回一份新的。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {(config: any) => any} fn
 * @returns {any} 写下去的那份配置
 */
export function mutateConfig(ctx, fn) {
  const config = readConfig(ctx.home);
  const next = fn(config) ?? config;
  writeConfig(ctx.home, next);
  return next;
}

/**
 * 读 → 改 → 写 `tokens/<name>.json`。**token 不存在直接抛**。
 *
 * ★ 报错用 `token "<name>" 不存在`，而不是"文件不存在"——后者会让用户
 * 以为是文件系统的问题（§2.8：名字非法与不存在是两回事，措辞也要分开）。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {string} name
 * @param {(token: any) => any} fn
 * @returns {any} 写下去的那份 token
 */
export function mutateToken(ctx, name, fn) {
  const token = requireToken(ctx, name);
  const next = fn(token) ?? token;
  writeJsonAtomic(tokenPath(ctx.home, name), next);
  return next;
}

/**
 * 读一个 token，不存在就抛（消息里带上"附近有哪些名字"）。
 *
 * 名字非法（`../etc` 之类）由 `readToken` → `normalizeToken` → `validateTokenName`
 * 抛出**另一种**错——这正是 §2.8 要的：`--token ../etc` 该报"名字非法"，
 * 不是"不存在"。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {string} name
 * @returns {any}
 */
export function requireToken(ctx, name) {
  const token = readToken(ctx.home, name);
  if (token !== null) return token;

  const siblings = listSiblingTokens(ctx);
  throw new CxtError(`token "${name}" 不存在`, {
    hint: siblings.length === 0
      ? `还没有任何 token。建一个：\`cxt token add ${name} --token <key>\``
      : `现有的：${siblings.join('、')}`,
  });
}

/**
 * 直接落一个 token 文件（`token add` 用；不经过读-改-写）。
 * @param {import('./types.js').Ctx} ctx
 * @param {string} name
 * @param {any} obj
 */
export function putToken(ctx, name, obj) {
  ensureDir(tokensDir(ctx.home));
  writeJsonAtomic(tokenPath(ctx.home, name), obj);
}

/**
 * ★ 读 → 改 → 写 `profiles/<t>/config.toml`（**双作者文件**）。
 *
 * `fn` 收**原文**、返回**新全文**。原文会原样传给 `writeProfileConfig` 的守门，
 * 所以"新文本少了 `[projects.*]`"会当场抛 `IntegrityError`（§2.9 铁律 2）。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {string} profileName
 * @param {(text: string) => string} fn
 * @returns {{ before: string, after: string }}
 */
export function mutateProfileToml(ctx, profileName, fn) {
  const before = readProfileConfig(ctx.home, profileName);
  const after = fn(before);
  if (typeof after !== 'string') {
    // 拼接器写坏了返回类型的话，`writeProfileConfig` 会把它当空串写下去——
    // 那是**整份 config.toml 被清空**，比报错严重得多。在这里拦住。
    throw new CxtError(`内部错误：受管区拼接没有返回文本（profile ${profileName}）`, {
      hint: '这是 cxt 自己的 bug，请提 issue。为安全起见**没有写盘**',
    });
  }
  ensureDir(profileDir(ctx.home, profileName));
  writeProfileConfig(ctx.home, profileName, after, before);
  return { before, after };
}

/**
 * §3.2：`token add` / `bind` 触发时建根目录 + `config.json`（若无）。
 *
 * **惰性**：绝不预建 `profiles/`、`catalogs/`——那两个由真正用到它们的命令建。
 * @param {import('./types.js').Ctx} ctx
 */
export function ensureRoot(ctx) {
  ensureDir(rootDir(ctx.home));
  if (!existsSync(configPath(ctx.home))) {
    writeConfig(ctx.home, { defaults: {}, bindings: [] });
  }
}

/**
 * 删一个 token 文件。
 *
 * ★ 只删 `tokens/<name>.json`——**profile 目录保留**（§3.3）：
 * 那里有 Codex 的登录态和会话历史，删了不可恢复。
 * @param {import('./types.js').Ctx} ctx
 * @param {string} name
 */
export function removeTokenFile(ctx, name) {
  rmSync(tokenPath(ctx.home, name), { force: true });
}

/**
 * ★ 删整个 profile 目录（`token rm --purge` 专用）。
 *
 * 两道结构性保险，因为这是本工具**唯一一处递归删除**：
 * 1. 只接受**已校验过的 token 名**——`validateTokenName` 拦掉 `/`、`..`、
 *    Windows 保留名，所以路径不可能穿出 `profiles/`。
 * 2. 删之前再核一次目标路径**确实在 `profiles/` 底下**——万一将来有人
 *    绕开校验传进一个裸路径，这里也不会把别处删掉。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {string} name 已校验的 token 名
 * @returns {boolean} 真的删了吗（目录本来就不存在 → false）
 */
export function removeProfileDir(ctx, name) {
  const dir = profileDir(ctx.home, name);
  const parent = profilesDir(ctx.home);
  if (!dir.startsWith(parent) || dir === parent) {
    throw new CxtError(`拒绝删除 ${dir}：它不在 profiles/ 目录下`, {
      hint: '这是 cxt 自己的 bug，请提 issue。**没有删任何东西**',
    });
  }
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 哪些绑定引用了这个 token？（§3.3：删除前要警告，不静默留悬空绑定）
 * @param {any} config
 * @param {string} name
 * @returns {string[]} 引用它的路径
 */
export function bindingsReferencing(config, name) {
  return (config?.bindings ?? [])
    .filter((/** @type {any} */ b) => b?.token === name)
    .map((/** @type {any} */ b) => b.path);
}

/**
 * `tokens/` 下现有的名字。用来在"不存在"的报错里给点线索。
 * @param {import('./types.js').Ctx} ctx
 * @returns {string[]}
 */
function listSiblingTokens(ctx) {
  try {
    // 不用 `store.listTokenNames`：那个会把**坏掉的** token 文件也读一遍并抛错，
    // 而这里只是要给"不存在"那条报错补点线索——它不该因为别处有个坏文件就崩掉。
    return readdirSync(tokensDir(ctx.home))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
}

/** `profiles/<t>/config.toml` 的绝对路径（给"写进哪了"的提示用） */
export { profileConfigPath };
