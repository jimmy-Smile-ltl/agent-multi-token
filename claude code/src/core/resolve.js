// @ts-check
/**
 * 四要素解析级联（§2.3）——全项目的心脏。
 *
 * **纯函数**：输入 `{config, token, overrides, cwd, ctx, env}`，输出每一项的 `{value, source}`。
 * 不读 `process.*`、不碰 fs（§4.2）——所以整条解析链能在没有终端、没有 token 文件的机器上单测。
 *
 * ─────────────────────────────────────────────────────────────
 * **两阶段**，因为「用哪个 token」本身就是级联的一项，而 token 文件的内容又参与其余项的级联：
 *
 *     pickTokenName(...)  →  { name, source, binding }   ← 调用方据此去加载 token 文件
 *     resolveConfig(...)  →  完整解析结果                 ← 调用方把加载好的 token 传进来
 *
 * 于是本模块永远不需要知道 token 文件长什么样、存在哪里。
 * ─────────────────────────────────────────────────────────────
 *
 * **两条不对称的合并规则（§2.3，刻意为之，别"统一"掉）**：
 *
 * - `models` / `slots`：**整体覆盖**——那是一组连贯的选择集，拼接会产生语义不明的混合列表
 * - `env`：**按键合并**——那是一组独立开关，合并符合直觉
 *
 * **绑定匹配永远用「调用时的 cwd」**（`--cwd` 或进程当前目录），**绝不用 `token.cwd`**——
 * 后者是"这个 token 默认落在哪"，拿它去匹配绑定会成环。
 */
import { canonicalPath, matchBinding } from './bindings.js';
import { CmtError } from './errors.js';
import { fillDefaultSlots, promote, SLOT_ENV } from './models.js';
import { expandTilde, profileDir, profileNameFor } from './paths.js';
import { validateTokenName } from './schema.js';

/**
 * 每一项的来源层。`cmt resolve` 靠它回答"为什么这个目录用了这个 token"。
 *
 * ★ `project` 是 §2.11 引入的**第四层**（`.cmt.json`）。它的位置**在 binding 之上、
 * 命令行之下**——绑定按路径前缀匹配**一批**目录，项目文件只对它所在的那一棵树生效，
 * 更具体（§2.11 三）。
 *
 * @typedef {'cli' | 'project' | 'binding' | 'token' | 'defaults' | 'builtin' | 'cwd' | 'preflight' | 'pool' | 'none'} Source
 *
 * @template T
 * @typedef {{ value: T, source: Source, detail?: string }} Field
 */

/** @type {Record<Source, string>} */
export const SOURCE_LABEL = {
  cli: '命令行',
  project: '项目本地',
  binding: '路径绑定',
  token: 'token 自身',
  defaults: '全局默认',
  builtin: '内置默认',
  cwd: '当前目录',
  preflight: '启动前校验',
  pool: 'token 池',
  none: '未设置',
};

/** `${VAR}` 的**整串**匹配——只认整串，见 `evalEnvRef()` */
const ENV_REF_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

// ───────────────────────────── `${ENV_VAR}` ─────────────────────────────

/**
 * 识别整串 `${VAR}` 引用。不是整串引用 → `null`（由 `evalEnvRef()` 决定是报错还是当字面量）。
 * @param {unknown} raw
 * @returns {{ name: string } | null}
 */
export function parseEnvRef(raw) {
  if (typeof raw !== 'string') return null;
  const m = ENV_REF_RE.exec(raw);
  return m ? { name: m[1] } : null;
}

/**
 * 求值 `${ENV_VAR}`（§2.4）。
 *
 * **只认整串引用。** 任何"部分引用"（`sk-${VAR}`、`${A}${B}`）一律报错，
 * 而**不是**把 `${...}` 当字面量留在 token 里——那会变成一个恒被拒绝的假 token，最难排查。
 *
 * ⚠️ `resolveConfig()` 自己**不调用**这个函数（它要能在环境变量没设置时也跑出结果，
 * 好让 `cmt resolve` 显示「已设置 / 未设置」）。真正求值的是启动路径 `buildInjection()`。
 *
 * @param {string} raw
 * @param {Record<string, string | undefined>} env
 * @returns {{ value: string, ref: { name: string } | null }}
 */
export function evalEnvRef(raw, env) {
  const ref = parseEnvRef(raw);
  if (ref) {
    const v = env[ref.name];
    if (v === undefined || v === '') {
      throw new CmtError(`引用的环境变量 ${ref.name} 未设置`, {
        hint: `先设置它（例：export ${ref.name}=<key>），或把明文写进 token 配置`,
      });
    }
    return { value: v, ref };
  }
  if (raw.includes('${')) {
    throw new CmtError(`不支持的 \${...} 写法：${JSON.stringify(raw)}`, {
      hint: '只支持整串引用，例："${DEEPSEEK_API_KEY}"；不支持 "sk-${VAR}" 这类拼接',
    });
  }
  return { value: raw, ref: null };
}

/**
 * 识别 `${VAR}` 并顺带回答"环境变量在不在"——**不求值**（§2.4）。
 *
 * `set` 只回答"当前环境里有没有值"，供 `cmt resolve` 印「已设置 / 未设置」；
 * 真正的求值只发生在 `buildInjection()`。空串等同未设置（空值一样打不通）。
 *
 * `authToken` 与 `baseUrl` **共用这一处判定**——两个字段的引用语义必须完全一致，
 * 各写一份必然漂移（同 `format.js` 里 `modelsState()` 的教训）。
 *
 * ★ 导出是给 `cli/format.js` 的 `describeSecret()` 用的：那里要给**还没解析过**的
 *   原始值（token 文件的 `authToken`）也印同一句「已设置 / 未设置」。显示侧再写一遍
 *   这个判据，就会和 `cmt resolve` 印的答案分叉——同一台机器上两个命令说法不一样，
 *   是最难让人相信的那类 bug。
 *
 * @param {unknown} raw
 * @param {Record<string, string | undefined>} env
 * @returns {{ name: string, set: boolean } | null}
 */
export function refInfo(raw, env) {
  const ref = parseEnvRef(raw);
  return ref ? { name: ref.name, set: env[ref.name] !== undefined && env[ref.name] !== '' } : null;
}

// ───────────────────────────── 阶段一：选 token ─────────────────────────────

/**
 * 阶段一：决定**用哪个 token 文件**（§2.3 的 `token` 行）。
 *
 *     --token → 项目本地（§2.11） → 路径绑定命中的 token → 全局默认 token → 无（纯 defaults 模式）
 *
 * ★ **项目本地插在绑定之上**：绑定按路径前缀匹配**一批**目录，而 `.cmt.json`
 * 只对它所在的那一棵树生效——更具体，所以更优先（§2.11 三）。
 *
 * @param {{
 *   config: any,
 *   overrides?: any,
 *   cwd: string,
 *   ctx: { platform: NodeJS.Platform, home: string },
 *   project?: any | null,
 * }} args `project` = `normalizeProjectConfig()` 的产物，没有就是 `null`/`undefined`。
 *        ⚠️ **加载动作不在这里**——`resolve.js` 是纯函数，读盘在 `cli/session.js`（§4.2）。
 * @returns {{ name: string | null, source: Source, detail?: string, binding: any | null }}
 */
export function pickTokenName({ config, overrides = {}, cwd, ctx, project = null }) {
  // 绑定匹配用的是**调用时的 cwd**（`--cwd` 或进程当前目录），不是 token.cwd
  const binding = matchBinding(config.bindings, overrides.cwd ?? cwd, ctx);

  if (overrides.token !== undefined && overrides.token !== null) {
    return { name: validateTokenName(overrides.token), source: 'cli', detail: '--token', binding };
  }
  if (project && project.token !== undefined) {
    return { name: project.token, source: 'project', detail: project.configPath, binding };
  }
  if (binding && binding.token !== undefined) {
    return { name: binding.token, source: 'binding', detail: binding.path, binding };
  }
  if (config.defaults.token !== undefined) {
    return { name: config.defaults.token, source: 'defaults', detail: 'config.defaults.token', binding };
  }
  return { name: null, source: 'none', binding };
}

// ───────────────────────────── 阶段二：完整解析 ─────────────────────────────

/**
 * 把各层摆成一张**高 → 低**的表，免得每个字段各写一遍 if。
 *
 * ★ 顺序就是 §2.3 那张表的顺序：**项目本地 → 绑定 → token → 全局默认**。
 *
 * ⚠️ 项目本地层虽然排在最前，但它**根本没有** `baseUrl` / `authToken` / `slots` /
 * `cwd` 这几个键（§2.11 二的禁键表）——所以 `pickFrom()` 走到它时
 * `obj[key] === undefined`，自动落到下一层。**这不是"忘了接"，是禁键表的直接后果**：
 * 少写一个 `if`，是因为那些键在那份文件里压根不存在。
 *
 * @param {any} config
 * @param {any | null} token
 * @param {any | null} binding
 * @param {any | null} project `normalizeProjectConfig()` 的产物
 * @returns {{ source: Source, obj: any, detail?: string }[]}
 */
function buildLayers(config, token, binding, project = null) {
  /** @type {{ source: Source, obj: any, detail?: string }[]} */
  const out = [];
  // ⚠️ 项目本地的 `detail` 是**裸路径**，与 `pickTokenName()` 那条**逐字同形**。
  //    `cli/format.js` 的 `sourceTag()` 会把层名印在括号**外面**（`← 项目本地（<detail>）`），
  //    所以这里再写一遍「项目本地」会印成「← 项目本地（项目本地 C:\x\.cmt.json）」。
  //    同一个层只有一种 detail 写法——两处不一致时，症状是同一份配置在两行里长得不一样。
  if (project) out.push({ source: 'project', obj: project, detail: project.configPath });
  if (binding) out.push({ source: 'binding', obj: binding, detail: binding.path });
  if (token) out.push({ source: 'token', obj: token, detail: `token ${token.name}` });
  out.push({ source: 'defaults', obj: config.defaults ?? {}, detail: 'config.defaults' });
  return out;
}

/**
 * 整体覆盖式取第一个"声明了"的层。
 *
 * `undefined` = 该层没声明，继续往下找；
 * `[]` / `{}` / `null` 都是**有效值**，会立刻胜出（§2.5 规则 4）。
 *
 * @template T
 * @param {{ source: Source, obj: any, detail?: string }[]} layers
 * @param {string} key
 * @returns {Field<T | undefined>}
 */
function pickFrom(layers, key) {
  for (const l of layers) {
    if (l.obj[key] !== undefined) {
      return { value: l.obj[key], source: l.source, detail: l.detail };
    }
  }
  return { value: undefined, source: 'none' };
}

/**
 * @template T
 * @param {Field<T | undefined>} field
 * @param {Field<T>} fallback
 * @returns {Field<T>}
 */
function orElse(field, fallback) {
  return field.value === undefined ? fallback : /** @type {Field<T>} */ (field);
}

/**
 * `env` 是**按键合并**（§2.3 唯一的合并型字段）：
 * 全局 `env` ← token `env` ← 路径绑定 `env`，右侧覆盖同名键。
 *
 * @param {{ source: Source, obj: any, detail?: string }[]} layers 高 → 低
 * @returns {Record<string, { value: string, source: Source, detail?: string }>}
 */
export function mergeEnv(layers) {
  /** @type {Record<string, { value: string, source: Source, detail?: string }>} */
  const out = {};
  // 从最低层往高走，让高优先级**最后**写入（覆盖）
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i];
    if (!l.obj.env) continue;
    for (const [k, v] of Object.entries(l.obj.env)) {
      out[k] = { value: /** @type {string} */ (v), source: l.source, detail: l.detail };
    }
  }
  return out;
}

/**
 * 阶段二：完整解析（§2.3 全表）。
 *
 * @param {{
 *   config: any,
 *   token?: any | null,
 *   overrides?: any,
 *   cwd: string,
 *   ctx: { platform: NodeJS.Platform, home: string },
 *   env?: Record<string, string | undefined>,
 *   project?: any | null,
 * }} args `project` = `normalizeProjectConfig()` 的产物（§2.11）。**纯函数**：
 *        加载动作在 `cli/session.js` 的 `loadProjectConfig()` 里（§4.2）。
 */
export function resolveConfig({ config, token = null, overrides = {}, cwd, ctx, env = {}, project = null }) {
  const picked = pickTokenName({ config, overrides, cwd, ctx, project });
  const binding = picked.binding;
  const layers = buildLayers(config, token, binding, project);

  /** @type {string[]} */
  const warnings = [];
  if (picked.name !== null && token === null) {
    warnings.push(`token 文件 "${picked.name}" 未加载（来源：${SOURCE_LABEL[picked.source]}）`);
  }

  /** @type {Field<string>} */
  const cli = (v, detail) => ({ value: v, source: 'cli', detail });
  /** @type {Field<string>} */
  const builtin = (v, detail) => ({ value: v, source: 'builtin', detail });

  // ── cwd：--cwd → 命中 token 的 cwd → 当前目录 ───────────────────────
  /** @type {Field<string>} */
  let cwdField;
  if (overrides.cwd !== undefined) {
    cwdField = cli(expandTilde(overrides.cwd, ctx.home, ctx.platform), '--cwd');
  } else if (token && token.cwd !== undefined) {
    cwdField = {
      value: expandTilde(token.cwd, ctx.home, ctx.platform),
      source: 'token',
      detail: `token ${token.name}`,
    };
  } else {
    cwdField = { value: cwd, source: 'cwd', detail: '当前目录' };
  }

  // ── baseUrl：--url → 绑定 → token → 全局 ───────────────────────────
  const baseUrl = overrides.baseUrl !== undefined
    ? cli(overrides.baseUrl, '--url')
    : pickFrom(layers, 'baseUrl');

  // ── authToken：--token-value → 绑定 → token → 全局 ─────────────────
  const authToken = overrides.authToken !== undefined
    ? cli(overrides.authToken, '--token-value')
    : pickFrom(layers, 'authToken');

  // 只**识别**引用，不求值——求值要等真正启动（见 evalEnvRef 的注释）。
  // authToken 与 baseUrl 一视同仁（§2.4）：判定只此一处。
  const baseUrlRef = refInfo(baseUrl.value, env);
  const authTokenRef = refInfo(authToken.value, env);

  // ── authMode：--auth-mode → 绑定 → token → 全局 → 内置 "token" ─────
  const authMode = orElse(
    overrides.authMode !== undefined ? cli(overrides.authMode, '--auth-mode') : pickFrom(layers, 'authMode'),
    builtin('token', 'ANTHROPIC_AUTH_TOKEN（不弹确认框）'),
  );

  // ── models：--model 提到首位 → 项目本地 → 绑定 → token → 全局（整体覆盖）──
  const modelsRaw = pickFrom(layers, 'models');
  const declared = modelsRaw.value !== undefined || overrides.model !== undefined;
  /** @type {Field<any[]>} */
  let models;
  if (overrides.model !== undefined) {
    models = cli(promote(modelsRaw.value ?? [], overrides.model), '--model');
  } else {
    models = { value: modelsRaw.value ?? [], source: modelsRaw.source, detail: modelsRaw.detail };
  }

  // ── slots：绑定 → token → 全局（整体覆盖），再补默认槽位 ────────────
  //   ★ 两份都留着：`slots` 是**补完默认值**的结果（注入直接用），
  //     `slotsDeclared` 是**没补过**的那张表（§2.5 启动前校验换模型后要重算）。
  //     只留补完的那份，换个 `models[0]` 之后那些"跟着默认走"的槽会继续指着旧模型。
  const slotsRaw = pickFrom(layers, 'slots');
  const slots = fillDefaultSlots(slotsRaw.value, models.value);
  // ── env：按键合并（全局 ← token ← 绑定 ← 项目本地）─────────────────
  const envMap = mergeEnv(layers);

  // ── claudeArgs：各层**拼接**（低 → 高，让更具体的层排在后面好覆盖）──
  const claudeArgs = [...layers].reverse().flatMap((l) => l.obj.claudeArgs ?? []);

  // ── terminalMode / claudeBin：只在 defaults 与命令行 ────────────────
  const terminalMode = orElse(
    overrides.terminalMode !== undefined
      ? cli(overrides.terminalMode, '--window/--tab')
      : pickFrom(layers, 'terminalMode'),
    builtin('tab', '默认在当前窗口开新标签页'),
  );
  const claudeBin = orElse(
    overrides.claudeBin !== undefined ? cli(overrides.claudeBin, '--claude-bin') : pickFrom(layers, 'claudeBin'),
    { value: null, source: /** @type {Source} */ ('none'), detail: '自动探测' },
  );

  return {
    // 四要素
    cwd: cwdField,
    authToken: { ...authToken, ref: authTokenRef },
    baseUrl: { ...baseUrl, ref: baseUrlRef },
    models: { ...models, declared },
    // 身份
    tokenName: { value: picked.name, source: picked.source, detail: picked.detail },
    binding,
    token,
    /** ★ §2.11 的项目本地配置本身（没有就是 `null`）——面板与 `cmt resolve` 要显示它 */
    project,
    /** 那份文件在哪（`cmt doctor` 用来提示"你这份是从哪儿发现的"）；没有就是 `null` */
    projectPath: project?.configPath ?? null,
    // 其余注入项
    authMode,
    slots,
    /** ★ 补默认值**之前**的那张槽位表——只有启动前校验用它（§2.5），别的地方读 `slots` */
    slotsDeclared: slotsRaw.value,
    env: envMap,
    claudeArgs,
    terminalMode,
    claudeBin,
    // ★ 启动前校验的总闸（`defaults.preflight`，§2.5）。默认开；只能写在 defaults。
    preflight: config?.defaults?.preflight !== false,
    // 诊断
    warnings,
    /** 归一化后的 cwd——`cmt resolve` 打印它供对照（§2.9 三：绑定按归一化串匹配） */
    cwdNormalized: canonicalPath(cwdField.value, ctx),
  };
}

// ───────────────────────────── 注入清单 ─────────────────────────────

/**
 * `CLAUDE_CONFIG_DIR` 是**承重原语**（§2.2），不允许被 `env` 逃生舱覆盖——
 * 覆盖它等于换身份，而"一会话一 token"是本项目的核心不变量（§1.3）。
 */
export const PROTECTED_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * Claude Code 给自己子进程打的**会话标记**（§2.6）——描述"我是哪个进程 / 哪个会话"，
 * 不是配置。新会话继承到它们就会顶着父会话的身份跑。
 *
 * 判据（加新条目照这条判）：值描述的是**某一个正在跑的进程 / 会话**——PID、会话 id、
 * 管道、端口、可执行文件路径、入口方式——就剔；值是**配置**（模型、努力级别、开关）就留，
 * 那属于 cmt 该管的，该管的会覆盖它。
 *
 * ⚠️ 所以 `CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` /
 * `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_DISABLE_AUTOUPDATER` **不在**这张表里：
 * 它们是配置，而且 `SUBAGENT_MODEL` 还是 cmt 自己就会注入的槽（§2.5）。
 *
 * 为什么必须剔（2026-10 实测，§7.7）：`cmt run` 从 Claude Code 会话里被调用时，
 * **Windows Terminal 会把调用方的整个环境原样转发给新标签页**。最刺眼的一条是
 * `CLAUDE_CODE_CHILD_SESSION=1`——Claude Code 见到它就打印
 * `⚠ Transcript saving is off`，该会话的对话记录不再落盘。
 * @type {readonly string[]}
 */
export const SESSION_MARKER_ENV = Object.freeze([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  // 本机未观测到，同族标记（父会话的 SSE 端口），一并剔
  'CLAUDE_CODE_SSE_PORT',
  // ★ cmt **自己**的在场标记（§2.14）：父会话的会话 id。嵌套 `cmt run` 若带着它，
  //   新窗口的 `msg send` 会把 `from` 认成父会话——剔掉，新窗口的 exec 会生成自己的。
  'CMT_SESSION_ID',
]);

/**
 * 剔掉会话标记，**返回新对象**。
 *
 * ⚠️ **"返回新对象"是硬要求，不是洁癖**：`cli/main.js` 的 `makeCtx()` 传进来的 `ctx.env`
 * **就是 `process.env` 本身**（按引用）。就地 `delete` 会把 **cmt 自己的**进程环境改掉——
 * 之后所有命令、所有 spawn 都在一个被悄悄动过的环境里跑。
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string | undefined>}
 */
export function stripSessionMarkers(env) {
  /** @type {Record<string, string | undefined>} */
  const out = { ...env };
  for (const k of SESSION_MARKER_ENV) delete out[k];
  return out;
}

/**
 * 算出**这个会话真正要交给 claude 的环境**（§2.6）：
 *
 * ```
 * 继承环境（剔掉会话标记） → 删掉 cmt 明确不注入的项（injection.unset） → 盖上注入项
 * ```
 *
 * 顺序要紧：**先删，再盖**。`injection.env` 永远最后生效，所以 `env` 逃生舱能盖回来任何一项。
 *
 * 这条函数就是那条不变量的实现：**`cmt run` / `cmt exec` 的结果，不许取决于它是从哪儿被调用的。**
 * @param {{ base: Record<string, string | undefined>, injection: { env: Record<string, string>, unset: string[] } }} p
 * @returns {Record<string, string | undefined>}
 */
export function buildSessionEnv({ base, injection }) {
  const env = stripSessionMarkers(base);
  for (const k of injection.unset) delete env[k];
  return { ...env, ...injection.env };
}

/**
 * 把解析结果变成**实际要注入的环境变量与命令行参数**（§2.6 注入清单）。
 *
 * 这是注入清单的**唯一来源**——`cmt resolve`（展示）与 `cmt exec`（真注入）
 * 都走这里，所以"看到的"永远等于"跑起来的"。
 *
 * **不抛异常、不编造值**：`${VAR}` 求不出来时，那个变量**干脆不注入**，
 * 并把变量名记进 `unresolved`。由调用方决定——`cmt resolve` 展示它，`cmt exec` 报错退出。
 * （绝不塞一个假 token 进去，那是最难排查的一类问题，§2.4。）
 *
 * `unset` 是"cmt 明确决定不注入、所以**继承来的值也不许顶上来**"的变量名（§2.6）。
 * 光有 `env` 只说了"加什么"；没有 `unset`，"没加"就等于"沿用调用方的"，而调用方是谁不该影响结果。
 * 调用方用 `buildSessionEnv()` 把两者合起来。
 *
 * @param {any} resolved `resolveConfig()` 的结果
 * @param {{ home: string, print?: boolean, env?: Record<string, string | undefined> }} opts
 *        `print` = 是否处于 `--print` 模式；`env` = 拿来求值 `${VAR}` 的进程环境
 * @returns {{
 *   env: Record<string, string>,
 *   unset: string[],
 *   args: string[],
 *   unresolved: { envVar: string, reason: string }[],
 *   warnings: string[],
 * }}
 */
export function buildInjection(resolved, { home, print = false, env: procEnv = {} }) {
  /** @type {Record<string, string>} */
  const env = {};
  /** @type {string[]} */
  const unset = [];
  /** @type {{ envVar: string, reason: string }[]} */
  const unresolved = [];
  /** @type {string[]} */
  const warnings = [];

  // 1) 身份隔离——承重，先落定
  env.CLAUDE_CONFIG_DIR = profileDir(home, profileNameFor(resolved.tokenName.value));

  // 2) 认证：authMode 决定用哪个变量名（§2.6）
  const useKey = resolved.authMode.value === 'key';
  const authVar = useKey ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
  // ⚠️ 没选中的那个必须进 unset，**不是**可有可无：§7.2 的优先级是
  // `ANTHROPIC_AUTH_TOKEN` 压过 `ANTHROPIC_API_KEY`。`authMode: "key"` 时若继承来一个
  // AUTH_TOKEN，**它会赢**——配的是 key，跑的却是别人的 token。
  unset.push(useKey ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY');
  const raw = resolved.authToken.value;
  if (typeof raw === 'string' && raw !== '') {
    try {
      env[authVar] = evalEnvRef(raw, procEnv).value;
    } catch (err) {
      // 求不出来就**不注入**，并记下原因——绝不塞一个假 token（§2.4）
      unresolved.push({ envVar: authVar, reason: /** @type {Error} */ (err).message });
    }
  } else {
    unresolved.push({ envVar: authVar, reason: '没有任何一层提供 authToken' });
  }

  // 3) 端点与模型
  const rawUrl = resolved.baseUrl.value;
  if (typeof rawUrl === 'string' && rawUrl !== '') {
    try {
      env.ANTHROPIC_BASE_URL = evalEnvRef(rawUrl, procEnv).value;
    } catch (err) {
      // 求不出来就**不注入**，并记下原因——绝不把字面量 `${...}` 塞进
      // ANTHROPIC_BASE_URL（§2.4）：那会让 claude 拿着一个不存在的域名去连接
      unresolved.push({ envVar: 'ANTHROPIC_BASE_URL', reason: /** @type {Error} */ (err).message });
    }
  } else {
    // 缺端点比缺 token 更隐蔽：claude 会悄悄退回它自己的一方端点，
    // 却仍然带着中转站的 token。所以这一条与 authToken 一样要记下来。
    unresolved.push({ envVar: 'ANTHROPIC_BASE_URL', reason: '没有任何一层提供 baseUrl' });
  }
  const head = resolved.models.value[0];
  if (head) {
    env.ANTHROPIC_MODEL = head.id;
  } else if (resolved.models.declared) {
    // 显式 `models: []`（§2.3）：语义是"不注入，用 Claude Code 自身默认"。
    // 那就得把继承来的也清掉，否则所谓的"默认"其实是父会话的模型。
    unset.push('ANTHROPIC_MODEL');
  }

  // 4) 别名槽——显式 null 表示"不注入"（§2.5）
  for (const [slot, varName] of Object.entries(SLOT_ENV)) {
    const v = resolved.slots[slot];
    if (v != null) env[varName] = v;
    // `undefined` 也走这里：`models` 为空时 fillDefaultSlots 填不出值，
    // 与"显式 null"是同一件事——cmt 不注入这一项。
    else unset.push(varName);
  }

  // 5) env 逃生舱（任意键）——放在最后，让用户能压过上面的推导值。
  // 它也能盖过 `unset`（buildSessionEnv 是"先删后盖"），这正是我们想要的：
  // 谁想显式带上一个会话标记，写进 `env` 就能带。
  //
  // ⚠️ **例外：空串 = "删掉这个继承来的变量"**（§2.6），不是"设成空"。
  // 两条理由：第一，空串在 Windows 上本来就等于"变量不存在"，在 POSIX 上却是个
  // 真的空值——同一个配置两个平台两种语义，不能留；第二（承重的），**这是把父会话
  // 漏进来的变量请出去的唯一通道**——没有它，`env` 只能加不能删，而 `wt.exe` 会把
  // 调用方的整套环境原样转发进新标签页（§7.7）。删的动作在 `buildSessionEnv()` 里做
  // （那里才有"继承来的环境"），这里只负责把它挑进 `unset`、且**不写进 `env`**。
  for (const [k, entry] of Object.entries(resolved.env)) {
    if (k === PROTECTED_ENV) {
      warnings.push(
        `${PROTECTED_ENV} 不能被 env 覆盖（它决定用哪个 profile）——该设置已忽略。` +
          '想换身份请用 `cmt run <token>`',
      );
      continue;
    }
    if (entry.value === '') {
      // 前面几步可能已经写过这个键（如槽位推导出的 ANTHROPIC_DEFAULT_HAIKU_MODEL）：
      // 空串是"别注入它"，所以连已写的那个也要撤掉，否则"删"会被自己的默认值盖回来。
      delete env[k];
      if (!unset.includes(k)) unset.push(k);
      continue;
    }
    env[k] = entry.value;
  }

  // 6) 命令行参数
  /** @type {string[]} */
  const args = ['--name', `cmt:${resolved.tokenName.value ?? 'default'}`];
  if (print && resolved.models.value.length > 1) {
    // ⚠️ --fallback-model 仅 --print 有效（§2.5）——交互模式不要假装能做到
    args.push('--fallback-model', resolved.models.value.slice(1).map((m) => m.id).join(','));
  }
  args.push(...resolved.claudeArgs);

  return { env, unset, args, unresolved, warnings };
}
