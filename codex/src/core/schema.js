// @ts-check
/**
 * 数据结构定义与校验（§2.4）。
 *
 * ─────────────────────────────────────────────────────────────
 * 一条贯穿全文件的区分——**本文件最容易写错的地方**：
 *
 *     `models` 字段 **不存在**  ≠  **为空数组**
 *     不存在 = 继承上一层；为空 = 显式声明"不注入，用 Codex 自身默认"（§2.5 规则 3、4）
 *
 * 所以校验函数**绝不**把 `undefined` 补成 `[]`。
 * 下游判断"该层有没有显式声明"请用 `hasModels()`。
 * ─────────────────────────────────────────────────────────────
 *
 * ⚠️ 本文件**只做 cxt 自己的 JSON 配置**（`config.json` / `tokens/*.json`）。
 * Codex 的 `config.toml` 是另一回事：那是双作者文件，走 `core/toml-splice.js`
 * 的**行级拼接**，**不经过这里**（§2.9）。
 */
import { CxtError, EnvError } from './errors.js';
import { POLICY } from './pool.js';

/** 本版 cxt 认的配置版本（§3.5：读到更高版本 → 拒绝启动，退出码 2） */
export const CONFIG_VERSION = 1;

export const TERMINAL_MODES = /** @type {const} */ (['tab', 'window']);

/** §7.10：CLI `-s` 的三个可选值 */
export const SANDBOX_MODES = /** @type {const} */ (['read-only', 'workspace-write', 'danger-full-access']);

/**
 * §7.10：`approval_policy` 的合法取值。
 *
 * ⚠️ **刻意不含 `UnlessTrusted`**——它只在 resolved 结果里出现、CLI 不接受，
 * 是"信任三态"的产物而非可配置项（§7.3、§7.10 都点名了这条）。
 * 谁要是"顺手补全"这个枚举，就会让用户写进一个 Codex 根本不接受的档位。
 */
export const APPROVAL_POLICIES = /** @type {const} */ (['untrusted', 'on-request', 'never']);

/** token 名约束（§2.8）：小写字母/数字开头，后续可含 `_` `-`，总长 1–32 */
export const TOKEN_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * provider id 约束。它会成为 TOML 表名 `[model_providers.<id>]`。
 *
 * ⚠️ **必须拒绝 `.`**：`[model_providers.a.b]` 在 TOML 里是**嵌套表**，
 * 不是"id 为 a.b 的 provider"——写下去不报错，但 Codex 找不到这个 provider。
 * 这是本文件里唯一一处"写错不报错、只是静默失效"的校验，所以卡死。
 */
export const PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/;

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
export function expectString(v, what) {
  if (typeof v !== 'string') throw new CxtError(`${what} 必须是字符串`);
  return v;
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {string}
 */
export function expectNonEmptyString(v, what) {
  const s = expectString(v, what);
  if (s === '') throw new CxtError(`${what} 不能为空`);
  return s;
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {Record<string, any>}
 */
export function expectPlainObject(v, what) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new CxtError(`${what} 必须是对象`);
  }
  return /** @type {Record<string, any>} */ (v);
}

/**
 * 未知键直接报错——比静默忽略好，手写配置打错字能立刻发现。
 * @param {Record<string, any>} obj
 * @param {readonly string[]} allowed
 * @param {string} what
 */
export function rejectUnknownKeys(obj, allowed, what) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) {
      throw new CxtError(`${what} 里有未知字段 "${k}"`, {
        hint: `可用字段：${allowed.join(' / ')}`,
      });
    }
  }
}

// ───────────────────────────── token 名 ─────────────────────────────

/**
 * 校验 token 名。**必须拒绝路径穿越**（§2.8）——它是目录名、文件名、
 * 环境变量名、窗口标题的一部分。
 * @param {unknown} name
 * @returns {string} 校验通过的名字
 */
export function validateTokenName(name) {
  if (typeof name !== 'string' || name === '') {
    throw new CxtError('token 名不能为空', { hint: '例：cxt token add relay-a --token <key>' });
  }
  // 先单独拦路径穿越——"不能包含 /" 比 "格式不对" 有用得多
  if (/[\\/:*?"<>|\0]/.test(name) || name.includes('..')) {
    throw new CxtError(`token 名不能包含路径分隔符或 ".."：${JSON.stringify(name)}`, {
      hint: 'token 名会成为目录名，只允许小写字母 / 数字 / _ / -',
    });
  }
  if (!TOKEN_NAME_RE.test(name)) {
    throw new CxtError(`token 名不合法：${JSON.stringify(name)}`, {
      hint: '要求：小写字母或数字开头，后续可含小写字母 / 数字 / _ / -，总长 1–32。例：relay-a',
    });
  }
  if (WINDOWS_RESERVED.has(name)) {
    throw new CxtError(`token 名 "${name}" 是 Windows 保留设备名，不能用作目录名`, {
      hint: '换一个名字，例：relay-a',
    });
  }
  return name;
}

/**
 * token 名 → provider id（§2.1 的派生量）。`null` → `cxt-default`。
 *
 * 前缀 `cxt-` 是为了**不撞内置 provider**（`openai` / `ollama` / `lmstudio`，§7.9）
 * 与用户自有 provider。
 * @param {string | null | undefined} tokenName
 */
export function deriveProviderId(tokenName) {
  return tokenName ? `cxt-${tokenName}` : 'cxt-default';
}

/**
 * token 名 → 凭证环境变量名（§2.6）。`relay-a` → `CXT_TOKEN_RELAY_A`。
 *
 * ⚠️ **别用 `OPENAI_API_KEY` / `CODEX_API_KEY` 之类的通用名**：
 * 它们是 Codex 自己的约定变量，注入会与 Codex 的认证优先级打架；
 * 且 `shell_environment_policy` 默认会剥掉名字含 `KEY`/`SECRET`/`TOKEN` 的变量
 * 再交给子进程——用 cxt 专属前缀能让"谁注入的"永远可辨认。
 * @param {string | null | undefined} tokenName
 */
export function deriveEnvKeyName(tokenName) {
  const base = tokenName ? tokenName.toUpperCase().replace(/-/g, '_') : 'DEFAULT';
  return `CXT_TOKEN_${base}`;
}

// ───────────────────────── `${ENV_VAR}` 引用（§2.4）─────────────────────────

/** 整串引用的形态。**只认整串**——`sk-${VAR}` / `${A}${B}` 一律报错。 */
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * 解析凭证字段：是 `${ENV_VAR}` 引用，还是明文？
 *
 * ⚠️ **只识别、不求值**（§2.4）。求值发生在启动路径（`cxt exec`）——
 * `resolve.js` 必须在环境变量没设置时也能跑出完整结果，
 * 否则 `cxt resolve` 就没法告诉你"哪一项没设置"。
 *
 * @param {string} value
 * @returns {{ kind: 'env', name: string } | { kind: 'literal', value: string }}
 */
export function parseSecretRef(value) {
  const m = ENV_REF_RE.exec(value);
  if (m) return { kind: 'env', name: m[1] };
  // 含 `${` 但不是整串引用 → 报错。绝不把 `${...}` 当字面量留在 token 里：
  // 那会变成一个恒被拒绝的假 token，最难排查（§2.4）。
  if (value.includes('${')) {
    throw new CxtError(`凭证里的环境变量引用必须是**整串**：${JSON.stringify(value)}`, {
      hint: '正确写法 "${DEEPSEEK_API_KEY}"；不支持 "sk-${VAR}" 或 "${A}${B}"',
    });
  }
  return { kind: 'literal', value };
}

/**
 * 把 `parseSecretRef()` 的结果**求值**成明文（§2.4）。
 *
 * ⚠️ **时机**：只在**启动路径**（`cxt exec` 注入环境之前）调用，从新窗口的进程环境读。
 * `cxt resolve` **绝不**调它——`resolve.js` 只识别不求值，否则环境变量没设置时
 * `cxt resolve` 就跑不出结果，而那正是最需要它的时候。
 *
 * **未设置时抛错，绝不静默回退成字面量 `"${DEEPSEEK_API_KEY}"`**——
 * 那会变成一个恒被拒绝的假 token，是最难排查的一种失败。
 *
 * @param {{ kind: 'env', name: string } | { kind: 'literal', value: string }} ref
 * @param {Record<string, string | undefined>} env 进程环境（由调用方注入，core 不读 process.env）
 * @returns {string}
 */
export function evaluateSecretRef(ref, env) {
  if (ref.kind === 'literal') return ref.value;

  const v = env?.[ref.name];
  if (typeof v !== 'string' || v === '') {
    throw new CxtError(`引用的环境变量 ${ref.name} 未设置`, {
      hint: `设置它（例：export ${ref.name}=<key>）后重试，`
        + '或把 token 文件里的 authToken 改成明文',
    });
  }
  return v;
}

/**
 * 除凭证外的字符串字段里出现 `${` 一律报错。
 *
 * 理由：`${ENV_VAR}` 只在 `authToken` 上有定义（§2.4）。别处写了它，
 * cxt 会当**字面量**用——于是 `baseUrl = "${MY_URL}"` 变成一个永远连不上的地址，
 * 报错信息还完全指不到病根。宁可在这里拦下。
 * @param {string} value
 * @param {string} what
 */
function rejectEnvRef(value, what) {
  if (value.includes('${')) {
    throw new CxtError(`${what} 不支持 ${'${ENV_VAR}'} 引用：${JSON.stringify(value)}`, {
      hint: '环境变量引用只在 authToken 上支持；这里请写实际值',
    });
  }
}

// ───────────────────────── 各字段的归一化 ─────────────────────────

/**
 * `models`：有序优先级表（§2.5）。`models[0]` 优先级最高。
 * 接受 `"id"` 或 `{ id, label? }`，统一归成对象形式。
 * @param {unknown} raw
 * @param {string} what
 * @returns {{ id: string, label?: string }[] | undefined} `undefined` = 该层没声明
 */
export function normalizeModels(raw, what) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new CxtError(`${what} 必须是数组`);

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
    if (k === '') throw new CxtError(`${what} 里有空的环境变量名`);
    if (typeof v !== 'string') {
      throw new CxtError(`${what}.${k} 必须是字符串`, {
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
 * @returns {'tab' | 'window' | undefined}
 */
export function normalizeTerminalMode(raw, what) {
  if (raw === undefined) return undefined;
  const s = expectString(raw, what);
  if (!TERMINAL_MODES.includes(/** @type {any} */ (s))) {
    throw new CxtError(`${what} 只能是 "tab" 或 "window"，收到 ${JSON.stringify(s)}`);
  }
  return /** @type {'tab' | 'window'} */ (s);
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {string | undefined}
 */
export function normalizeSandboxMode(raw, what) {
  if (raw === undefined) return undefined;
  const s = expectString(raw, what);
  if (!SANDBOX_MODES.includes(/** @type {any} */ (s))) {
    throw new CxtError(`${what} 取值非法：${JSON.stringify(s)}`, {
      hint: `可用：${SANDBOX_MODES.join(' / ')}`,
    });
  }
  return s;
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {string | undefined}
 */
export function normalizeApprovalPolicy(raw, what) {
  if (raw === undefined) return undefined;
  const s = expectString(raw, what);
  if (!APPROVAL_POLICIES.includes(/** @type {any} */ (s))) {
    throw new CxtError(`${what} 取值非法：${JSON.stringify(s)}`, {
      hint: `可用：${APPROVAL_POLICIES.join(' / ')}。`
        + '注意 UnlessTrusted 是 Codex 内部状态，不可配置（§7.10）',
    });
  }
  return s;
}

/**
 * `wireApi`。**当前 Codex 只接受 `"responses"`**（§7.9：0.59 起 `"chat"` 已移除，
 * 写 `chat` 会导致 Codex 无法启动）。
 *
 * 所以这里不提供 `chat` 选项——报错信息里说明原因，免得用户以为是自己写错了。
 * @param {unknown} raw
 * @param {string} what
 * @returns {'responses' | undefined}
 */
export function normalizeWireApi(raw, what) {
  if (raw === undefined) return undefined;
  const s = expectString(raw, what);
  if (s === 'responses') return 'responses';
  if (s === 'chat') {
    throw new CxtError(`${what} = "chat" 已不被 Codex 支持`, {
      hint: 'Codex 0.59 起移除了 chat wire API，写它会导致 Codex 无法启动。改成 "responses"',
    });
  }
  throw new CxtError(`${what} 取值非法：${JSON.stringify(s)}`, {
    hint: 'cxt 目前只认 "responses"（Codex 仅支持这一种 wire API）',
  });
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {string | undefined}
 */
export function normalizeProviderId(raw, what) {
  if (raw === undefined) return undefined;
  const s = expectNonEmptyString(raw, what);
  if (!PROVIDER_ID_RE.test(s)) {
    throw new CxtError(`${what} 不合法：${JSON.stringify(s)}`, {
      hint: '它会成为 TOML 表名 [model_providers.<id>]，只允许字母 / 数字 / _ / -。'
        + '⚠️ 不能含 "."——那会变成嵌套表而不是 provider id',
    });
  }
  return s;
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
    throw new CxtError(`${what} 最多 32 个字符（收到 ${points.length} 个）`, {
      hint: '昵称只是展示用，短一点更好认',
    });
  }
  for (const ch of points) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp < 0x20 || cp === 0x7f) {
      throw new CxtError(`${what} 不能包含控制字符（换行、制表符都不行）`);
    }
  }
  return s;
}

/**
 * @param {unknown} raw
 * @param {string} what
 * @returns {string[] | undefined}
 */
export function normalizeCodexArgs(raw, what) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new CxtError(`${what} 必须是数组`);
  return raw.map((a, i) => expectString(a, `${what}[${i}]`));
}

/**
 * defaults / token / binding 三层共有的字段（§2.4 字段表）。
 * 注意：**不补默认值**，只做类型校验与形状归一。
 * @param {Record<string, any>} raw
 * @param {string} what
 */
function normalizeCommonLayer(raw, what) {
  /** @type {Record<string, any>} */
  const out = {};

  if (raw.authToken !== undefined) {
    const s = expectNonEmptyString(raw.authToken, `${what}.authToken`);
    // 在这里就把 `${...}` 的形态校验掉（但不求值，§2.4）——typo 越早发现越好
    parseSecretRef(s);
    out.authToken = s;
  }
  if (raw.baseUrl !== undefined) {
    const s = expectNonEmptyString(raw.baseUrl, `${what}.baseUrl`);
    rejectEnvRef(s, `${what}.baseUrl`);
    out.baseUrl = s;
  }
  if (raw.wireApi !== undefined) out.wireApi = normalizeWireApi(raw.wireApi, `${what}.wireApi`);
  if (raw.providerId !== undefined) out.providerId = normalizeProviderId(raw.providerId, `${what}.providerId`);

  const models = normalizeModels(raw.models, `${what}.models`);
  if (models !== undefined) out.models = models;

  if (raw.catalog !== undefined) {
    const s = expectNonEmptyString(raw.catalog, `${what}.catalog`);
    rejectEnvRef(s, `${what}.catalog`);
    out.catalog = s;
  }

  const env = normalizeEnv(raw.env, `${what}.env`);
  if (env !== undefined) out.env = env;

  if (raw.sandboxMode !== undefined) {
    out.sandboxMode = normalizeSandboxMode(raw.sandboxMode, `${what}.sandboxMode`);
  }
  if (raw.approvalPolicy !== undefined) {
    out.approvalPolicy = normalizeApprovalPolicy(raw.approvalPolicy, `${what}.approvalPolicy`);
  }

  return out;
}

const COMMON_KEYS = [
  'authToken', 'baseUrl', 'wireApi', 'providerId', 'models', 'catalog', 'env',
  'sandboxMode', 'approvalPolicy',
];

/**
 * `config.defaults.pool`（§2.15 二）。
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
      throw new CxtError('config.defaults.pool.auto 必须是布尔值（true / false）', {
        hint: 'true = 没有 token 可解析时由池补空位；false = 完全关掉',
      });
    }
    out.auto = obj.auto;
  }

  if (obj.policy !== undefined) {
    if (obj.policy !== POLICY.LEAST_USED && obj.policy !== POLICY.ROUND_ROBIN) {
      throw new CxtError(
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
      throw new CxtError('config.defaults.pool.cacheSeconds 必须是正整数（秒）', {
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
      throw new CxtError('config.defaults.pool.usageSeconds 必须是正整数（秒）', {
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
 * `defaults`——全局兜底（§2.4）。
 *
 * 多出一个不属于四要素、但 §2.3 的级联需要它的字段：
 * - `token`：默认用哪个 token **文件**（名字）。没绑定的目录也走这个 token；
 *   不设则退化成"纯 defaults 模式"（没有 token 身份，profile 落 `_default`）
 *
 * 注意**没有** `cwd`：cwd 的级联是 `--cwd` → `token.cwd` → 当前目录（§2.3），
 * 不存在"全局默认落点"这一层——凭空多一层只会让"我在哪跑"变得难猜。
 * 同理也**没有** `sandboxMode` 之外的沙箱细项：领地属于项目级（§2.10）。
 * @param {unknown} raw
 */
export function normalizeDefaults(raw) {
  if (raw === undefined) return {};
  const obj = expectPlainObject(raw, 'config.defaults');
  rejectUnknownKeys(
    obj,
    [...COMMON_KEYS, 'token', 'terminalMode', 'codexArgs', 'codexBin', 'preflight', 'pool'],
    'config.defaults',
  );

  const out = normalizeCommonLayer(obj, 'config.defaults');
  if (obj.token !== undefined) out.token = validateTokenName(obj.token);
  if (obj.terminalMode !== undefined) {
    out.terminalMode = normalizeTerminalMode(obj.terminalMode, 'config.defaults.terminalMode');
  }
  // ★ 启动前校验的开关（§2.5）。**只能写在 defaults**：它是机器级偏好——
  //   写进 token 会让"同一个网关的两个身份行为不一样"，写进仓库文件更是
  //   让同事的每次启动都多一次网络探测（下面两条 allowlist 天然拒掉它们）。
  if (obj.preflight !== undefined) {
    if (typeof obj.preflight !== 'boolean') {
      throw new CxtError('config.defaults.preflight 必须是布尔值（true / false）');
    }
    out.preflight = obj.preflight;
  }
  if (obj.codexArgs !== undefined) {
    out.codexArgs = normalizeCodexArgs(obj.codexArgs, 'config.defaults.codexArgs');
  }
  if (obj.codexBin !== undefined) {
    const s = expectNonEmptyString(obj.codexBin, 'config.defaults.codexBin');
    rejectEnvRef(s, 'config.defaults.codexBin');
    out.codexBin = s;
  }
  // ★ 池的**偏好**（§2.15 二）：开不开、怎么排、探过多久算新鲜。
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
  rejectUnknownKeys(obj, ['name', ...COMMON_KEYS, 'cwd', 'codexArgs', 'label'], 'token 配置');

  if (expectedName !== undefined && obj.name !== undefined && obj.name !== expectedName) {
    throw new CxtError(
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
  if (obj.cwd !== undefined) {
    const s = expectNonEmptyString(obj.cwd, `token ${name}.cwd`);
    rejectEnvRef(s, `token ${name}.cwd`);
    out.cwd = s;
  }
  if (obj.codexArgs !== undefined) {
    out.codexArgs = normalizeCodexArgs(obj.codexArgs, `token ${name}.codexArgs`);
  }
  return out;
}

/**
 * 一条路径绑定（§2.3）。
 *
 * **没有 `cwd`**：绑定回答的是"**这个目录**用哪个 token"，不是"去哪个目录"。
 * **没有 `codexArgs`**：绑定是"选身份"，不是"调行为"。
 * @param {unknown} raw
 * @param {number} index
 */
export function normalizeBinding(raw, index) {
  const what = `config.bindings[${index}]`;
  const obj = expectPlainObject(raw, what);
  rejectUnknownKeys(obj, ['path', 'token', ...COMMON_KEYS], what);

  const out = normalizeCommonLayer(obj, what);
  const path = expectNonEmptyString(obj.path, `${what}.path`);
  rejectEnvRef(path, `${what}.path`);
  out.path = path;
  if (obj.token !== undefined) out.token = validateTokenName(obj.token);
  return out;
}

// ───────────────────────────── 版本与迁移 ─────────────────────────────

/**
 * 版本检查（§3.5）。
 * - 更高版本 → **拒绝启动**（退出码 2），绝不静默按当前 schema 解析未来格式
 * - 更低版本 → 返回旧版本号，由调用方（store.js）先备份再迁移
 *
 * @param {unknown} raw
 * @param {string} [what] 报错时点名的文件名。默认 `config.json`；
 *   `.cxt.json` 传**完整路径**（§2.13 四要求"指名文件路径"）
 * @returns {number} 该文件的版本号（≤ CONFIG_VERSION）
 */
export function checkVersion(raw, what = 'config.json') {
  const v = (raw === null || typeof raw !== 'object') ? undefined : /** @type {any} */ (raw).version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new CxtError(`${what} 缺少合法的 version 字段`, {
      hint: `期望 "version": ${CONFIG_VERSION}。文件损坏时可删掉它重新生成`,
    });
  }
  if (v > CONFIG_VERSION) {
    throw new EnvError(
      `${what} 版本为 ${v}，本版 cxt 只认到 ${CONFIG_VERSION}`,
      { hint: '这份配置由更高版本的 cxt 写入，请先升级 cxt 再运行' },
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
        hint: '这是 cxt 的 bug，请提 issue',
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
  if (!Array.isArray(bindingsRaw)) throw new CxtError('config.bindings 必须是数组');

  const bindings = bindingsRaw.map((b, i) => normalizeBinding(b, i));

  // 同一条 path 重复绑定 → 后写的赢是隐式魔法，直接报错（§2.3 最长前缀匹配的前提是无歧义）
  const seen = new Map();
  for (const b of bindings) {
    if (seen.has(b.path)) {
      throw new CxtError(`config.bindings 里有重复的 path：${JSON.stringify(b.path)}`, {
        hint: '同一条路径只能有一条绑定，用 `cxt bind ls` 查看后删掉多余的那条',
      });
    }
    seen.set(b.path, b);
  }

  return { version, defaults, bindings };
}

// ───────────────────────── 判断"该层是否声明" ─────────────────────────

/**
 * 该层是否**显式声明**了 models（§2.5 规则 4）。
 * `undefined` = 继承上层；`[]` = 显式无模型（不注入，用 Codex 自身默认）。
 * @param {any} layer
 */
export function hasModels(layer) {
  return layer != null && layer.models !== undefined;
}
