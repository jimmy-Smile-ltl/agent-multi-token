// @ts-check
/**
 * 数据结构定义与校验（§2.4）。
 *
 * ─────────────────────────────────────────────────────────────
 * 一条贯穿全文件的区分——**本文件最容易写错的地方**：
 *
 *     `models` / `slots` 字段 **不存在**  ≠  **为空数组 / 空对象**
 *     不存在 = 继承上一层；为空 = 显式声明"这一层就是没有"（§2.5 规则 4）
 *
 * 所以校验函数**绝不**把 `undefined` 补成 `[]` / `{}`。
 * 下游判断"该层有没有显式声明"请用 `hasModels()` / `hasSlots()`。
 * ─────────────────────────────────────────────────────────────
 */
import { CmtError, EnvError } from './errors.js';
import { POLICY } from './pool.js';
import { normalizeSeedMode } from './seed.js';

/** 本版 cmt 认的配置版本（§3.5：读到更高版本 → 拒绝启动，退出码 2） */
export const CONFIG_VERSION = 1;

export const AUTH_MODES = /** @type {const} */ (['token', 'key']);
export const SLOT_KEYS = /** @type {const} */ (['opus', 'sonnet', 'haiku', 'fable', 'subagent']);
export const TERMINAL_MODES = /** @type {const} */ (['tab', 'window']);

/** token 名约束（§2.8）：小写字母/数字开头，后续可含 `_` `-`，总长 1–32 */
export const TOKEN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Windows 保留设备名。token 名会成为目录名（`profiles/<token>/`），
 * 撞上这些名字在 Windows 上根本建不出目录。
 */
const WINDOWS_RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

// ───────────────────────────── 基础断言 ─────────────────────────────

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {string}
 */
function expectString(v, what) {
  if (typeof v !== 'string') throw new CmtError(`${what} 必须是字符串`);
  return v;
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {string}
 */
function expectNonEmptyString(v, what) {
  const s = expectString(v, what);
  if (s === '') throw new CmtError(`${what} 不能为空`);
  return s;
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {Record<string, any>}
 */
export function expectPlainObject(v, what) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new CmtError(`${what} 必须是对象`);
  }
  return /** @type {Record<string, any>} */ (v);
}

/**
 * 未知键直接报错——比静默忽略好，手写配置打错字能立刻发现。
 *
 * ★ 导出是因为 `project-config.js`（§2.11）是**第二个调用方**：
 * `.cmt.json` 的校验必须与 `config.json` 用同一套"未知字段"语义，
 * 各写一份必然分叉（一个报"未知字段"、一个报"格式不对"，用户得学两遍）。
 *
 * ⚠️ 调用方**必须先把禁键拦掉**再调它：禁键本来就不在允许列里，
 * 顺序反了会被"未知字段"抢先报掉，而那条信息说不出"这是攻击面"（§2.11 二）。
 *
 * @param {Record<string, any>} obj
 * @param {readonly string[]} allowed
 * @param {string} what
 */
export function rejectUnknownKeys(obj, allowed, what) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new CmtError(`${what} 里有未知字段 "${k}"`, {
        hint: `可用字段：${allowed.join(' / ')}`,
      });
    }
  }
}

// ───────────────────────────── token 名 ─────────────────────────────

/**
 * 校验 token 名。**必须拒绝路径穿越**（§2.8）——它是目录名与文件名的一部分。
 * @param {unknown} name
 * @returns {string} 校验通过的名字
 */
export function validateTokenName(name) {
  if (typeof name !== 'string' || name === '') {
    throw new CmtError('token 名不能为空', { hint: '例：cmt token add relay-a --token <key>' });
  }
  // 先单独拦路径穿越——"不能包含 /" 比 "格式不对" 有用得多
  if (/[\\/:*?"<>|\0]/.test(name) || name.includes('..')) {
    throw new CmtError(`token 名不能包含路径分隔符或 ".."：${JSON.stringify(name)}`, {
      hint: 'token 名会成为目录名，只允许小写字母 / 数字 / _ / -',
    });
  }
  if (!TOKEN_NAME_RE.test(name)) {
    throw new CmtError(`token 名不合法：${JSON.stringify(name)}`, {
      hint: '要求：小写字母或数字开头，后续可含小写字母 / 数字 / _ / -，总长 1–32。例：relay-a',
    });
  }
  if (WINDOWS_RESERVED.has(name)) {
    throw new CmtError(`token 名 "${name}" 是 Windows 保留设备名，不能用作目录名`, {
      hint: '换一个名字，例：relay-a',
    });
  }
  return name;
}

// ───────────────────────── 各字段的归一化 ─────────────────────────

/**
 * `models`：有序优先级表（§2.5）。
 * 接受 `"id"` 或 `{ id, label? }`，统一归成对象形式。
 * @param {unknown} raw
 * @param {string} what
 * @returns {{ id: string, label?: string }[] | undefined} `undefined` = 该层没声明
 */
export function normalizeModels(raw, what) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new CmtError(`${what} 必须是数组`);

  return raw.map((m, i) => {
    const at = `${what}[${i}]`;
    if (typeof m === 'string') {
      return { id: expectNonEmptyString(m, at) };
    }
    const obj = expectPlainObject(m, at);
    rejectUnknownKeys(obj, ['id', 'label'], at);
    const id = expectNonEmptyString(obj.id, `${at}.id`);
    /** @type {{ id: string, label?: string }} */
    const out = { id };
    if (obj.label !== undefined) out.label = expectString(obj.label, `${at}.label`);
    return out;
  });
}

/**
 * `slots`：别名槽 → 模型 id（§2.5）。
 * **`null` 是合法取值**——表示"该槽不注入，保留 Claude Code 自身默认"。
 * @param {unknown} raw
 * @param {string} what
 * @returns {Record<string, string | null> | undefined}
 */
export function normalizeSlots(raw, what) {
  if (raw === undefined) return undefined;
  const obj = expectPlainObject(raw, what);

  /** @type {Record<string, string | null>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!SLOT_KEYS.includes(k)) {
      throw new CmtError(`${what} 里有未知槽位 "${k}"`, {
        hint: `可用槽位：${SLOT_KEYS.join(' / ')}`,
      });
    }
    if (v === null) {
      out[k] = null; // 显式不注入
      continue;
    }
    out[k] = expectNonEmptyString(v, `${what}.${k}`);
  }
  return out;
}

/**
 * `env`：逃生舱，任意键，值必须是字符串（它们要变成环境变量）。
 * @param {unknown} raw
 * @param {string} what
 * @returns {Record<string, string> | undefined}
 */
export function normalizeEnv(raw, what) {
  if (raw === undefined) return undefined;
  const obj = expectPlainObject(raw, what);

  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === '') throw new CmtError(`${what} 里有空的环境变量名`);
    if (typeof v !== 'string') {
      throw new CmtError(`${what}.${k} 必须是字符串`, {
        hint: '环境变量的值只能是字符串——数字请写 "123"',
      });
    }
    out[k] = v;
  }
  return out;
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {'token' | 'key' | undefined}
 */
export function normalizeAuthMode(raw, what) {
  if (raw === undefined) return undefined;
  const s = expectString(raw, what);
  if (!AUTH_MODES.includes(/** @type {any} */ (s))) {
    throw new CmtError(`${what} 只能是 "token" 或 "key"，收到 ${JSON.stringify(s)}`, {
      hint: '"token" → ANTHROPIC_AUTH_TOKEN（默认）｜"key" → ANTHROPIC_API_KEY',
    });
  }
  return /** @type {'token' | 'key'} */ (s);
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {string[] | undefined}
 */
export function normalizeClaudeArgs(raw, what) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new CmtError(`${what} 必须是数组`);
  return raw.map((a, i) => expectString(a, `${what}[${i}]`));
}

/**
 * token 昵称（`label`，§2.4 末）。
 *
 * 只用于展示：可中文、可空格、**不唯一**——身份仍然是 `name`。
 * - `trim()` 后为空 ⇒ 视为未设置：返回 `undefined`，调用方**删键**，绝不写 `""`。
 * - 上限按**码点**算（`Array.from`），否则一个 emoji 会被算成两下。
 * - **单行**：C0 控制字符与 DEL 一律拒绝（换行、制表符都在里面）。
 * - 错误消息**只谈 label、不打印原值**（与密钥那条纪律同源）。
 * @param {unknown} raw
 * @param {string} what
 * @returns {string | undefined}
 */
export function normalizeTokenLabel(raw, what) {
  const s = expectString(raw, what).trim();
  if (s === '') return undefined;

  const points = Array.from(s);
  if (points.length > 32) {
    throw new CmtError(`${what} 最多 32 个字符（收到 ${points.length} 个）`, {
      hint: '昵称只是展示用，短一点更好认',
    });
  }
  for (const ch of points) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp < 0x20 || cp === 0x7f) {
      throw new CmtError(`${what} 不能包含控制字符（换行、制表符都不行）`);
    }
  }
  return s;
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {'tab' | 'window' | undefined}
 */
export function normalizeTerminalMode(raw, what) {
  if (raw === undefined) return undefined;
  const s = expectString(raw, what);
  if (!TERMINAL_MODES.includes(/** @type {any} */ (s))) {
    throw new CmtError(`${what} 只能是 "tab" 或 "window"，收到 ${JSON.stringify(s)}`);
  }
  return /** @type {'tab' | 'window'} */ (s);
}

/**
 * defaults / token / binding 三层共有的字段（§2.4）。
 * 注意：**不补默认值**，只做类型校验与形状归一。
 * @param {Record<string, any>} raw
 * @param {string} what
 */
function normalizeCommonLayer(raw, what) {
  /** @type {Record<string, any>} */
  const out = {};
  if (raw.authToken !== undefined) out.authToken = expectNonEmptyString(raw.authToken, `${what}.authToken`);
  if (raw.authMode !== undefined) out.authMode = normalizeAuthMode(raw.authMode, `${what}.authMode`);
  if (raw.baseUrl !== undefined) out.baseUrl = expectNonEmptyString(raw.baseUrl, `${what}.baseUrl`);

  const models = normalizeModels(raw.models, `${what}.models`);
  if (models !== undefined) out.models = models;

  const slots = normalizeSlots(raw.slots, `${what}.slots`);
  if (slots !== undefined) out.slots = slots;

  const env = normalizeEnv(raw.env, `${what}.env`);
  if (env !== undefined) out.env = env;

  return out;
}

const COMMON_KEYS = ['authToken', 'authMode', 'baseUrl', 'models', 'slots', 'env'];

/**
 * `config.defaults.pool`（§2.13 二）。
 *
 * ★ **这里只有"怎么用池"的偏好，一个秘密都没有**——所以它才配进 `config.json`。
 *   外部状态存储（Redis）的地址**不在这里**：它可能带口令，而 `config.json`
 *   是旧版本会整份拒载的承重文件，把口令写进去等于让降级变成一场事故。
 *
 * ★ 与 `preflight` 同一条理由：**只写在 defaults**。写进 token 会让"同一个网关的
 *   两个身份行为不一样"，写进仓库文件更是让同事每次启动都换一套策略。
 *
 * 四个字段都是可选的，**不填就不出现**（与其它层同一条惰性规则）——
 * 运行期的默认值在 `core/pool.js` 的 `poolSettings()` 里，不在这里补。
 *
 * ★ `cacheSeconds` 与 `usageSeconds` 是**两个窗口**，别当成一个的别名：
 *   前者管"探一次额度之后多久不再探"（每次探测都发真实请求，花钱）；
 *   后者管"隔多久重算一次用量"（只读本机会话记录，不花钱）。合并成一个旋钮，
 *   等于让"想少探测的人"被迫少记账。
 *
 * @param {unknown} raw
 * @returns {Record<string, any>}
 */
function normalizePoolSection(raw) {
  const obj = expectPlainObject(raw, 'config.defaults.pool');
  rejectUnknownKeys(obj, ['auto', 'policy', 'cacheSeconds', 'usageSeconds'], 'config.defaults.pool');

  /** @type {Record<string, any>} */
  const out = {};

  if (obj.auto !== undefined) {
    if (typeof obj.auto !== 'boolean') {
      throw new CmtError('config.defaults.pool.auto 必须是布尔值（true / false）', {
        hint: 'true = 没有 token 可解析时由池补空位；false = 完全关掉',
      });
    }
    out.auto = obj.auto;
  }

  if (obj.policy !== undefined) {
    if (obj.policy !== POLICY.LEAST_USED && obj.policy !== POLICY.ROUND_ROBIN) {
      throw new CmtError(
        `config.defaults.pool.policy 只能是 "${POLICY.LEAST_USED}" 或 "${POLICY.ROUND_ROBIN}"`,
        { hint: `least-used = 用得少的优先（并列时轮询）；round-robin = 纯轮询。收到 ${JSON.stringify(obj.policy)}` },
      );
    }
    out.policy = obj.policy;
  }

  if (obj.cacheSeconds !== undefined) {
    if (
      typeof obj.cacheSeconds !== 'number' ||
      !Number.isInteger(obj.cacheSeconds) ||
      obj.cacheSeconds <= 0
    ) {
      throw new CmtError('config.defaults.pool.cacheSeconds 必须是正整数（秒）', {
        hint: '它决定"探过一次之后多久不再探"——填 0 就等于每次启动都花一次请求',
      });
    }
    out.cacheSeconds = obj.cacheSeconds;
  }

  if (obj.usageSeconds !== undefined) {
    if (
      typeof obj.usageSeconds !== 'number' ||
      !Number.isInteger(obj.usageSeconds) ||
      obj.usageSeconds <= 0
    ) {
      throw new CmtError('config.defaults.pool.usageSeconds 必须是正整数（秒）', {
        hint: '它决定"打开面板 / 跑 pool list 时，用量多久才重算一次"——'
          + '重算只读本机会话记录，不花钱；填很小就等于每次打开都全量扫一遍',
      });
    }
    out.usageSeconds = obj.usageSeconds;
  }

  return out;
}

// ───────────────────────────── 三层结构 ─────────────────────────────

/**
 * `defaults`——全局兜底（§2.4）。就是用户那组 export 的等价物。
 *
 * 多出一个不在那组 export 里的字段，但 §2.3 的级联需要它：
 * - `token`：默认用哪个 token **文件**（名字）。没绑定的目录也走这个 token；
 *   不设则退化成"纯 defaults 模式"（没有 token 身份，只有全局凭证 + 一个 `_default` profile）
 *
 * 注意**没有** `cwd`：cwd 的级联是 `--cwd` → `token.cwd` → 当前目录（§2.3），
 * 不存在"全局默认落点"这一层——凭空多一层只会让"我在哪跑"变得难猜。
 * @param {unknown} raw
 */
export function normalizeDefaults(raw) {
  if (raw === undefined) return {};
  const obj = expectPlainObject(raw, 'config.defaults');
  rejectUnknownKeys(
    obj,
    [...COMMON_KEYS, 'token', 'terminalMode', 'claudeArgs', 'claudeBin', 'seed', 'preflight', 'pool'],
    'config.defaults',
  );

  const out = normalizeCommonLayer(obj, 'config.defaults');
  if (obj.token !== undefined) out.token = validateTokenName(obj.token);
  if (obj.terminalMode !== undefined) out.terminalMode = normalizeTerminalMode(obj.terminalMode, 'config.defaults.terminalMode');
  if (obj.claudeArgs !== undefined) out.claudeArgs = normalizeClaudeArgs(obj.claudeArgs, 'config.defaults.claudeArgs');
  if (obj.claudeBin !== undefined) out.claudeBin = expectNonEmptyString(obj.claudeBin, 'config.defaults.claudeBin');
  // 启动前播种（§3.6）——§3.1 铁律的唯一例外，所以取值必须严格校验：
  // 打错一个字（"onboading"）如果被静默忽略，症状就是"我明明配了却还在弹窗"，
  // 而那时没人会想到去查拼写。
  if (obj.seed !== undefined) out.seed = normalizeSeedMode(obj.seed, 'config.defaults.seed');
  // ★ 启动前校验的开关（§2.5）。**只能写在 defaults**：它是机器级偏好——
  //   写进 token 会让"同一个网关的两个身份行为不一样"，写进仓库文件更是
  //   让同事的每次启动都多一次网络探测（上面两处的 allowlist 天然拒掉它们）。
  if (obj.preflight !== undefined) {
    if (typeof obj.preflight !== 'boolean') {
      throw new CmtError('config.defaults.preflight 必须是布尔值（true / false）');
    }
    out.preflight = obj.preflight;
  }
  // ★ 池的**偏好**（§2.13 二）：开不开、怎么排、探过多久算新鲜。
  //   池本身（状态与用量）在 `pool.json`，那是可丢弃的；这里是配置。
  if (obj.pool !== undefined) out.pool = normalizePoolSection(obj.pool);
  return out;
}

/**
 * `tokens/<name>.json`（§2.4）。
 * @param {unknown} raw
 * @param {string} [expectedName] 文件名，用于交叉校验
 */
export function normalizeToken(raw, expectedName) {
  const obj = expectPlainObject(raw, 'token 配置');
  rejectUnknownKeys(
    obj,
    ['name', ...COMMON_KEYS, 'cwd', 'claudeArgs', 'label'],
    'token 配置',
  );

  if (expectedName !== undefined && obj.name !== undefined && obj.name !== expectedName) {
    throw new CmtError(
      `token 文件里的 name（${JSON.stringify(obj.name)}）与文件名（${expectedName}）不一致`,
      { hint: `改回 "${expectedName}"，或把文件重命名为 ${obj.name}.json` },
    );
  }
  const name = obj.name === undefined && expectedName !== undefined
    ? expectedName
    : validateTokenName(obj.name);

  const out = normalizeCommonLayer(obj, `token ${name}`);
  out.name = name;
  if (obj.label !== undefined) {
    const label = normalizeTokenLabel(obj.label, `token ${name}.label`);
    if (label !== undefined) out.label = label;
  }
  if (obj.cwd !== undefined) out.cwd = expectNonEmptyString(obj.cwd, `token ${name}.cwd`);
  if (obj.claudeArgs !== undefined) out.claudeArgs = normalizeClaudeArgs(obj.claudeArgs, `token ${name}.claudeArgs`);
  return out;
}

/**
 * 一条路径绑定（§2.3）。
 * @param {unknown} raw
 * @param {number} index
 */
export function normalizeBinding(raw, index) {
  const what = `config.bindings[${index}]`;
  const obj = expectPlainObject(raw, what);
  rejectUnknownKeys(obj, ['path', 'token', ...COMMON_KEYS], what);

  const out = normalizeCommonLayer(obj, what);
  out.path = expectNonEmptyString(obj.path, `${what}.path`);
  if (obj.token !== undefined) out.token = validateTokenName(obj.token);
  return out;
}

// ───────────────────────────── 版本与迁移 ─────────────────────────────

/**
 * 版本检查（§3.5）。
 * - 更高版本 → **拒绝启动**（退出码 2），绝不静默按当前 schema 解析未来格式
 * - 更低版本 → 返回旧版本号，由调用方（store.js）先备份再迁移
 *
 * ★ `what` 是**报错点名的对象**：默认 `config.json`，`project-config.js`（§2.11）
 * 传的是那份 `.cmt.json` 的**完整路径**。不点名的话，用户在项目里写错
 * `version` 会看到一句"config.json 缺少合法的 version 字段"，
 * 而那个文件可能根本不存在——他会去查一个不相干的文件。
 *
 * @param {unknown} raw
 * @param {string} [what] 报错时点名的文件
 * @returns {number} 该文件的版本号（≤ CONFIG_VERSION）
 */
export function checkVersion(raw, what = 'config.json') {
  const v = (raw === null || typeof raw !== 'object') ? undefined : /** @type {any} */ (raw).version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new CmtError(`${what} 缺少合法的 version 字段`, {
      hint: `期望 "version": ${CONFIG_VERSION}。文件损坏时可删掉它重新生成`,
    });
  }
  if (v > CONFIG_VERSION) {
    throw new EnvError(
      `${what} 版本为 ${v}，本版 cmt 只认到 ${CONFIG_VERSION}`,
      { hint: '这份配置由更高版本的 cmt 写入，请先升级 cmt 再运行' },
    );
  }
  return v;
}

/**
 * 迁移表：`{ 目标版本: (旧配置) => 新配置 }`。
 * v1 是初始 schema，故为空——将来加字段时在这里补一条，
 * **不要**在别处写"顺手补个默认值"的迁移。
 * @type {Record<number, (raw: any) => any>}
 */
const MIGRATIONS = {};

/**
 * 需要迁移吗？
 * @param {number} fromVersion
 */
export function needsMigration(fromVersion) {
  return fromVersion < CONFIG_VERSION;
}

/**
 * 逐版本迁移到 CONFIG_VERSION。调用方**必须**先备份原文件（§3.5）。
 * @param {any} raw
 * @param {number} fromVersion
 */
export function migrate(raw, fromVersion) {
  let cur = raw;
  for (let v = fromVersion + 1; v <= CONFIG_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) {
      throw new EnvError(`缺少从 v${v - 1} 到 v${v} 的迁移逻辑`, {
        hint: '这是 cmt 的 bug，请提 issue',
      });
    }
    cur = step(cur);
    cur.version = v;
  }
  return cur;
}

// ───────────────────────────── 顶层 config ─────────────────────────────

/**
 * 校验并归一 `config.json`。
 * @param {unknown} raw
 * @returns {{ version: number, defaults: any, bindings: any[] }}
 */
export function normalizeConfig(raw) {
  const obj = expectPlainObject(raw, 'config.json');
  rejectUnknownKeys(obj, ['version', 'defaults', 'bindings'], 'config.json');

  const version = checkVersion(obj);
  const defaults = normalizeDefaults(obj.defaults);

  const bindingsRaw = obj.bindings === undefined ? [] : obj.bindings;
  if (!Array.isArray(bindingsRaw)) throw new CmtError('config.bindings 必须是数组');

  const bindings = bindingsRaw.map((b, i) => normalizeBinding(b, i));

  // 同一条 path 重复绑定 → 后写的赢是隐式魔法，直接报错（§2.3 最长前缀匹配的前提是无歧义）
  const seen = new Map();
  for (const b of bindings) {
    if (seen.has(b.path)) {
      throw new CmtError(`config.bindings 里有重复的 path：${JSON.stringify(b.path)}`, {
        hint: '同一条路径只能有一条绑定，用 `cmt bind ls` 查看后删掉多余的那条',
      });
    }
    seen.set(b.path, b);
  }

  return { version, defaults, bindings };
}

// ───────────────────────── 判断"该层是否声明" ─────────────────────────

/**
 * 该层是否**显式声明**了 models（§2.5 规则 4）。
 * `undefined` = 继承上层；`[]` = 显式无模型（不注入，用 Claude Code 自身默认）。
 * @param {any} layer
 */
export function hasModels(layer) {
  return layer != null && layer.models !== undefined;
}

/**
 * 该层是否**显式声明**了 slots。
 * @param {any} layer
 */
export function hasSlots(layer) {
  return layer != null && layer.slots !== undefined;
}
