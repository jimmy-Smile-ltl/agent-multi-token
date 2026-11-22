// @ts-check
/**
 * "写进哪一层"（§2.5 的表）——`cmt model *` 与 `cmt slot set` 共用。
 *
 * 四个目标层：
 *   `--global`          → `config.defaults`
 *   `--token <t>`       → `tokens/<t>.json`
 *   `--path <p>` / 无参 → ★ **先看该路径的项目本地配置**（§2.11 五）：
 *                         `.cmt.json` 若声明了 `models`，目标层**就是那个文件**；
 *                         否则落到 `bindings` 里该路径那一条（**没有就自动创建一条**）
 *   `--config <p>`      → 全局 flag（§2.11 一）。给了它，**生效的项目本地层就是它**，
 *                         于是 `models` 的写入目标也跟着它，不再按 `--path` 去发现
 *
 * ── 关于"物化" ───────────────────────────────────────────────
 * 若该路径原先**继承** token / 全局的列表，`cmt model next` 会先把**当前生效的列表**
 * 复制一份到该绑定上，再轮转。于是"这个目录的模型从哪来"从"继承"变成"自己的"，
 * `cmt resolve` 会把来源层标成 `binding`——变化显式可见，不做隐式魔法。
 */
import { matchBinding } from '../core/bindings.js';
import { CmtError } from '../core/errors.js';
import { dirnameFor } from '../core/paths.js';
import { normalizeProjectConfig } from '../core/project-config.js';
import { validateTokenName } from '../core/schema.js';
import {
  findProjectConfig,
  loadConfig,
  loadToken,
  readProjectConfig,
  saveConfig,
  saveToken,
  writeProjectConfig,
} from '../core/store.js';

/**
 * @typedef {{ kind: 'defaults' }
 *   | { kind: 'token', name: string }
 *   | { kind: 'binding', path: string }
 *   | { kind: 'project', configPath: string, dir: string }} WriteTarget
 */

/**
 * 从 CLI 参数解析写入目标。互斥的 flag 同时出现 → 报错（别猜用户想写哪层）。
 *
 * ★ `key` 是**必需参数，不给默认值**。项目本地那一层只对 `models` 开
 *   （§2.11 二的允许键表里没有 `slots`），默认成 `'models'` 的话，将来有人给新键
 *   加命令时会**静默**走上这条升级路，而症状是"写进去了、schema 说禁键"——
 *   两句话各自都对、合起来看不懂。宁可让每个调用点把这一刀要切的键写出来。
 *
 * @param {any} args
 * @param {import('./types.js').Ctx} ctx
 * @param {'models' | 'slots'} key 这一刀要切的键（决定认不认项目本地那一层）
 * @returns {WriteTarget}
 */
export function pickWriteTarget(args, ctx, key) {
  const given = [
    args.global ? '--global' : null,
    args.token !== undefined ? '--token' : null,
    args.path !== undefined ? '--path' : null,
  ].filter(Boolean);

  if (given.length > 1) {
    throw new CmtError(`这几个选项只能给一个：${given.join(' / ')}`, {
      hint: '不写任何一个 = 按当前目录写进路径绑定',
    });
  }

  if (args.global) return { kind: 'defaults' };
  if (args.token !== undefined) return { kind: 'token', name: validateTokenName(args.token) };

  const path = args.path ?? ctx.cwd;

  // ★ §2.11 五：**写入目标跟着生效层走**。
  //   写到一个不生效的地方 = 命令静默失效——`cmt model next` 报"已轮转"、
  //   模型却纹丝不动，正是 §6.2「宁可明确」要避免的。
  //
  //   ⚠️ 只对 `models` 开这一层：`slots` 是 `.cmt.json` 的**禁键**（§2.11 二），
  //      升上去必然写不进去。所以这一层不是"路径目标的通用加强"，是 `models` 专有的。
  if (key === 'models') {
    const at = projectConfigAt(ctx, path);
    if (at !== null && at.cfg.models !== undefined) {
      return { kind: 'project', configPath: at.configPath, dir: at.dir };
    }
  }

  return { kind: 'binding', path };
}

/**
 * 这个目录**生效**的那份项目本地配置是哪个？没有就是 `null`。
 *
 * 两条路，与 `cli/session.js` 的 `loadProjectConfig()` **逐条对齐**（§2.11 一）：
 *
 * | 来源 | 行为 |
 * |------|------|
 * | `--config <p>`（`ctx.configPath`） | 就是它，**不做发现**；文件不在就硬报错，不回退 |
 * | 没有 `--config` | 从 `dir` 往上找**最近的** `.cmt.json` |
 *
 * ★ 两处判据必须一致——不一致会让 `cmt model ls` 与 `cmt run` 各说各话，
 *   而那种分歧只在"用户给了 `--config`"或"祖先目录里有配置文件"时才露头，
 *   也就是最难在手工点测里撞见的那一类。
 *
 * ⚠️ `--config` **优先于**按 `dir` 发现：给了它就是"这一份才是我的项目配置"，
 *   于是**生效层**就是它，写入目标自然得跟着它。不这么写的话，
 *   `cmt --config D:/a/.cmt.json model next` 会跑去改 cwd 那份绑定，而真正生效的是
 *   `D:/a`——正是 §2.11 五 那条规则要消灭的那种静默失效。
 *   两者一致时（多数情况）这条分支看不出来，所以它只能靠注释和测试钉住，不能靠"显然"。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {string} dir `--path` / 当前目录（只在没有 `--config` 时用得上）
 * @returns {{ configPath: string, dir: string, cfg: any } | null} `cfg` = `normalizeProjectConfig()` 的产物
 */
function projectConfigAt(ctx, dir) {
  if (ctx.configPath !== null && ctx.configPath !== undefined) {
    return {
      configPath: ctx.configPath,
      dir: dirnameFor(ctx.platform)(ctx.configPath),
      cfg: readProjectConfig(ctx.configPath),
    };
  }

  const found = findProjectConfig({ cwd: dir, platform: ctx.platform });
  if (found === null) return null;
  return { configPath: found.configPath, dir: found.dir, cfg: readProjectConfig(found.configPath) };
}

/**
 * 目标层的人话标签（回执里用）。
 * @param {WriteTarget} t
 */
export function describeTarget(t) {
  if (t.kind === 'defaults') return '全局默认（config.defaults）';
  if (t.kind === 'token') return `token ${t.name}`;
  if (t.kind === 'project') return `项目本地 ${t.configPath}`;
  return `路径绑定 ${t.path}`;
}

/**
 * 目标层**当前生效**的列表——即"继承链上第一个声明了的那份"（§2.3）。
 *
 * 用在物化：`cmt model next` 要先把这份复制下来再轮转。
 * 没声明 → `[]`（不是 undefined：调用方拿它当"起点列表"，空列表是合法起点）。
 *
 * @param {{ config: any, target: WriteTarget, ctx: import('./types.js').Ctx }} p
 * @param {'models' | 'slots'} key
 * @returns {any}
 */
export function effectiveAt({ config, target, ctx }, key) {
  if (target.kind === 'project') {
    const proj = readProjectConfig(target.configPath);
    if (proj[key] !== undefined) return proj[key];
    // 走不到这里——`pickWriteTarget()` 只在项目本地**声明了该键**时才把目标升上来。
    // 但真走到了也不该炸：项目本地层不说话的键，就照它所在的那个目录继续往下问
    // （`--config` 那条路上 `dir` 与 cwd 可以毫无关系，所以只能问 `dir`，不能问 cwd）。
    return effectiveAt({ config, target: { kind: 'binding', path: target.dir }, ctx }, key);
  }

  if (target.kind === 'binding') {
    // ★ 项目本地层插在绑定**之上**（§2.11 三）——这里必须认它，否则 `cmt slot ls`
    //   报的"没列出的槽会自动填 models[0]"会拿绑定的列表冒充真正生效的那份。
    //   （对 `cmt model *` 的写入路径来说这条**恒为 no-op**：项目本地声明了 models 时
    //     `pickWriteTarget()` 早就把目标升上去了，走不到这个分支。）
    const at = projectConfigAt(ctx, target.path);
    if (at !== null && at.cfg[key] !== undefined) return at.cfg[key];

    const b = matchBinding(config.bindings, target.path, ctx);
    if (b?.[key] !== undefined) return b[key];
    // 该绑定没声明 → 落到 token（绑定上的 token，否则全局默认 token）→ 全局
    const name = b?.token ?? config.defaults.token;
    if (name !== undefined) {
      const { token } = loadToken({ home: ctx.home, name });
      if (token?.[key] !== undefined) return token[key];
    }
    return config.defaults[key] ?? (key === 'models' ? [] : {});
  }

  if (target.kind === 'token') {
    const { token, exists } = loadToken({ home: ctx.home, name: target.name });
    if (!exists) {
      throw new CmtError(`token "${target.name}" 不存在`, {
        hint: `先建一个：\`cmt token add ${target.name} --token <密钥>\``,
      });
    }
    if (token?.[key] !== undefined) return token[key];
    return config.defaults[key] ?? (key === 'models' ? [] : {});
  }

  return config.defaults[key] ?? (key === 'models' ? [] : {});
}

/**
 * 目标层**自己**声明了这个键吗？（不往上找，只看这一层）
 *
 * 与 `effectiveAt()` 的区别：那个是"生效的是哪份"（会往上继承），
 * 这个是"这一层自己有没有"。用来如实报告"刚才这次写入是不是物化"——
 * 物化了就说物化了，本来就有的别跟着说（回执里的话必须是事实）。
 *
 * @param {{ target: WriteTarget, key: 'models' | 'slots', ctx: import('./types.js').Ctx }} p
 */
export function targetDeclares({ target, key, ctx }) {
  const { config } = loadConfig({ home: ctx.home });

  if (target.kind === 'defaults') return config.defaults[key] !== undefined;

  if (target.kind === 'token') {
    const { token } = loadToken({ home: ctx.home, name: target.name });
    return token?.[key] !== undefined;
  }

  if (target.kind === 'project') {
    return readProjectConfig(target.configPath)[key] !== undefined;
  }

  const b = matchBinding(config.bindings, target.path, ctx);
  return b?.[key] !== undefined;
}

/**
 * 把 `models` 写进目标层。
 *
 * @param {{ target: WriteTarget, models: any[], ctx: import('./types.js').Ctx }} p
 * @returns {{ wrote: string }} 写到了哪个文件（回执用）
 */
export function writeModels({ target, models, ctx }) {
  return writeLayer({ target, key: 'models', value: models, ctx });
}

/**
 * 把 `slots` 写进目标层。
 * @param {{ target: WriteTarget, slots: any, ctx: import('./types.js').Ctx }} p
 */
export function writeSlots({ target, slots, ctx }) {
  return writeLayer({ target, key: 'slots', value: slots, ctx });
}

/**
 * 删掉目标层的某个键（`cmt model clear`）——删掉即"回退上一层"。
 *
 * 与写入不同：**找不到目标层不算错**（本来就没有，删了等于没删），
 * 但仍如实报告"没找到可删的东西"，免得用户以为生效了。
 *
 * @param {{ target: WriteTarget, key: 'models' | 'slots', ctx: import('./types.js').Ctx }} p
 * @returns {{ changed: boolean, where: string }}
 */
export function clearLayer({ target, key, ctx }) {
  const { config } = loadConfig({ home: ctx.home });

  if (target.kind === 'defaults') {
    const changed = config.defaults[key] !== undefined;
    delete config.defaults[key];
    if (changed) saveConfig({ home: ctx.home, config });
    return { changed, where: 'config.defaults' };
  }

  if (target.kind === 'token') {
    const { token, exists } = loadToken({ home: ctx.home, name: target.name });
    if (!exists) {
      throw new CmtError(`token "${target.name}" 不存在`, { hint: '用 `cmt ls` 看现有 token' });
    }
    const changed = token[key] !== undefined;
    delete token[key];
    if (changed) saveTokenAt({ ctx, token });
    return { changed, where: `tokens/${target.name}.json` };
  }

  if (target.kind === 'project') {
    // ★ 只删这一个键，**不删文件**：里面可能还有 token / env / claudeArgs，
    //   删文件等于顺手清掉了用户在仓库里写的别的声明。
    //   （整个文件是用户自己的东西，cmt 不代劳——§2.11 六 惰性原则。）
    const cur = readProjectConfig(target.configPath);
    const changed = cur[key] !== undefined;
    if (changed) {
      const next = { ...cur };
      delete next[key];
      saveProjectAt(ctx, target.configPath, next);
    }
    return { changed, where: `项目本地 ${target.configPath}` };
  }

  const b = matchBinding(config.bindings, target.path, ctx);
  if (!b) return { changed: false, where: `（没有匹配 ${target.path} 的绑定）` };
  const changed = b[key] !== undefined;
  delete b[key];
  if (changed) saveConfig({ home: ctx.home, config });
  return { changed, where: `bindings["${b.path}"]` };
}

// ───────────────────────────── 内部 ─────────────────────────────

/**
 * @param {{ target: WriteTarget, key: string, value: any, ctx: import('./types.js').Ctx }} p
 * @returns {{ wrote: string }}
 */
function writeLayer({ target, key, value, ctx }) {
  const { config } = loadConfig({ home: ctx.home });

  if (target.kind === 'defaults') {
    config.defaults[key] = value;
    saveConfig({ home: ctx.home, config });
    return { wrote: 'config.defaults' };
  }

  if (target.kind === 'token') {
    const { token, exists } = loadToken({ home: ctx.home, name: target.name });
    if (!exists) {
      throw new CmtError(`token "${target.name}" 不存在`, {
        hint: `先建一个：\`cmt token add ${target.name} --token <密钥>\``,
      });
    }
    token[key] = value;
    saveTokenAt({ ctx, token });
    return { wrote: `tokens/${target.name}.json` };
  }

  if (target.kind === 'project') {
    // ⚠️ 到不了 `key !== 'models'` 的分支：`pickWriteTarget()` 只对 `models` 开这一层。
    //    真到了就是内部接线错了——**宁可抛**，也别把 `slots` 写进一个禁它的文件、
    //    让用户在 schema 的"未知/禁键"报错里猜自己敲错了哪一步。
    if (key !== 'models') {
      throw new CmtError(`内部错误：${key} 不该写进项目本地配置（§2.11 二 的允许键表里没有它）`, {
        hint: '这是 cmt 的接线问题，不是你敲错了——请把它报给维护者',
      });
    }
    // ★ 项目本地配置：**保留其余键**，只动 models。
    //   整份过一遍 `normalizeProjectConfig()`——别在这里手写第二套校验，
    //   与 token 分支同源的理由：schema 只准有一处真相。
    //   ⚠️ `cur` 是**归一产物**，带着 `configPath`；摘它那一步在 `saveProjectAt()` 里
    //      （只此一处，别在这里再 `delete` 一遍——两个调用点各删一次正是它漂移的方式）。
    const cur = readProjectConfig(target.configPath);
    const next = { ...cur };
    next.models = value;
    saveProjectAt(ctx, target.configPath, next);
    return { wrote: target.configPath };
  }

  // 路径绑定：没有就建一条（§2.5："无匹配绑定则自动创建一条"）
  const path = target.path;
  let b = matchBinding(config.bindings, path, ctx);
  if (!b) {
    b = { path };
    config.bindings.push(b);
  }
  b[key] = value;
  saveConfig({ home: ctx.home, config });
  return { wrote: `bindings["${b.path}"]` };
}

/**
 * 过 schema 再落盘（`.cmt.json` 的唯一写入姿势）。
 *
 * ⚠️ **`configPath` 要在**两头**各摘一次，顺序还不能反**：
 *
 * 1. **归一之前**：`readProjectConfig()` 的产物带着 `configPath`（那是"这份是从哪读来的"
 *    的记账，不是文件字段），而 `normalizeProjectConfig()` 会把不在允许键表里的东西
 *    当**未知字段拒掉**——于是"自己读出来的东西自己写不回去"。
 * 2. **落盘之前**：归一的**产物**又会把 `configPath` 加回来（同一件事的记账），
 *    不摘就会把本机绝对路径写进用户的仓库，还会在下一次读取时被自己拒掉。
 *
 * ★ 这一刀必须落在**这里**，不能交给调用点：`{...readProjectConfig(...)}` 再改一个键
 *   是这两个调用点的**常规**姿势（`writeLayer` / `clearLayer` 都是），漏一个就是
 *   一条命令整条坏掉。曾经 `writeLayer` 自己 `delete` 了一次而 `clearLayer` 忘了——
 *   症状是 `cmt model clear --path` 报「有未知字段 "configPath"」，
 *   而那文件是**它自己上一次读进来的**（实测踩到，测试逮住）。
 *
 * ★ 导出是给**面板向导第 4 步**用的（§2.12 四）：它写 `.cmt.json` 也必须走这一处，
 *   否则就是第三个"忘了摘 `configPath`"的调用点——而这一次踩到的会是用户的仓库。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {string} configPath
 * @param {Record<string, any>} value 已经删掉要删的键的**完整**内容
 */
export function saveProjectAt(ctx, configPath, value) {
  const clean = { ...value };
  delete clean.configPath;
  const normalized = normalizeProjectConfig(clean, configPath);
  const toWrite = { ...normalized };
  delete toWrite.configPath;
  writeProjectConfig(configPath, toWrite);
}

/**
 * @param {{ ctx: import('./types.js').Ctx, token: any }} p
 */
function saveTokenAt({ ctx, token }) {
  saveToken({ home: ctx.home, token });
}
