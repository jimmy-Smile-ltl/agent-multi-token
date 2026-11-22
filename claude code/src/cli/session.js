// @ts-check
/**
 * 会话装配——`resolve` / `exec` / `run` 三个命令**共用的前置步骤**。
 *
 * 抽出来是因为这三个命令的区别只在"装配完之后干什么"：
 * `resolve` 打印它、`run` 拿它去开窗口、`exec` 拿它去启动 claude。
 * 装配过程（两阶段解析 → 注入 → 校验）必须只有一份实现，
 * 否则"看到的"与"跑起来的"迟早会漂移。
 *
 * 仍然是纯装配：**不 spawn、不写盘**（写盘在调用方）。
 */
import { buildInjection, pickTokenName, resolveConfig } from '../core/resolve.js';
import { CmtError } from '../core/errors.js';
import {
  findProjectConfig,
  listTokenNames,
  loadConfig,
  loadToken,
  readProjectConfig,
} from '../core/store.js';
import { validateSession } from '../core/validate.js';
import { profileNameFor } from '../core/paths.js';

/**
 * 一次把**全局配置 + 全部 token**读进来（§2.12 面板的左栏要列全）。
 *
 * ★ 与 `prepareSession()` 的分工：那个装配**一个**会话（用户指名了目录/token），
 *   这个只是"把世界读一遍"，**不做任何解析**。面板要先知道有哪些 token 才谈得上选。
 *
 * ⚠️ **读不出来的 token 直接跳过，不抛。** 与 `prepareSession()` 的纪律不同，
 *   那是有意的：面板是"总览"，一个坏掉的 token 文件不该让整块面板打不开——
 *   恰恰相反，那正是用户需要面板的时刻（他要看见"有个 token 是坏的"）。
 *   单条命令那边则相反：`cmt run <坏 token>` 必须当场报错（§2.11 四）。
 *
 * @param {import('./types.js').Ctx} ctx
 * @returns {{ config: any, tokens: Record<string, any> }}
 */
export function loadState(ctx) {
  const { config } = loadConfig({ home: ctx.home });
  /** @type {Record<string, any>} */
  const tokens = {};
  for (const name of listTokenNames({ home: ctx.home })) {
    const { token, exists } = loadToken({ home: ctx.home, name });
    if (exists) tokens[name] = token;
  }
  return { config, tokens };
}

/**
 * 把 CLI 参数映射成 `resolveConfig()` 认识的 overrides。
 *
 * ⚠️ **`target` 传 `undefined` 表示"用户没显式指定目录"**，别用 `ctx.cwd` 顶替——
 * 那会让来源层谎报成「命令行（--cwd）」。cwd 的级联是
 * `--cwd` → `token.cwd` → 当前目录（§2.3），后两档必须留给 `resolveConfig()` 自己走。
 * 绑定匹配用的具体目录是另一回事，由调用方单独传给 `prepareSession({ target })`。
 *
 * @param {any} args
 * @param {string | undefined} target 用户显式给的目录（`--cwd` / 位置参数），没给就 `undefined`
 * @param {string} [tokenName] 位置参数里给的 token 名（`run` / `exec` 的位置参数是 token，不是路径）
 */
export function pickOverrides(args, target, tokenName) {
  /** @type {any} */
  const o = {};
  if (target !== undefined) o.cwd = target;

  // 位置参数与 --token 都是"指定 token"，后者是显式写法，冲突时以位置参数为准
  // （`cmt run relay-a` 里 relay-a 就是用户当下敲的那个名字）
  const t = tokenName ?? args.token;
  if (t !== undefined) o.token = t;

  if (args.model !== undefined) o.model = args.model;
  if (args.url !== undefined) o.baseUrl = args.url;
  if (args['token-value'] !== undefined) o.authToken = args['token-value'];
  if (args['auth-mode'] !== undefined) o.authMode = args['auth-mode'];
  if (args['claude-bin'] !== undefined) o.claudeBin = args['claude-bin'];
  if (args.window) o.terminalMode = 'window';
  else if (args.tab) o.terminalMode = 'tab';
  return o;
}

/**
 * ★ 找到并读入**项目本地配置**（§2.11 一）。没有就是 `null`。
 *
 * 两条路，**互不 fallback**：
 *
 * | 来源 | 行为 |
 * |------|------|
 * | `--config <p>`（`ctx.configPath`） | 只读它。**文件不存在直接报错**，绝不回退到发现 |
 * | 没有 `--config` | 从 `callCwd` 往上找**最近的** `.cmt.json` |
 *
 * ⚠️ **发现用的是 `callCwd`（`--cwd` 优先），不是 `ctx.cwd`**——
 * `cmt run relay-a --cwd D:/proj` 要发现的是 `D:/proj` 那份配置，
 * 不是你恰好站着敲命令的那个目录。
 *
 * ⚠️ 但**绑定匹配仍然永远用调用时的 cwd**（§2.11 一）：两者通常相同，
 * 不同时以调用 cwd 为准——这条与 §2.3「绝不用 `token.cwd` 匹配绑定」同源。
 * 所以这个函数**只负责"发现哪份文件"**，不参与 `resolveConfig()` 的 `cwd` 入参。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {string} callCwd "我站在哪个目录"（`--cwd` 优先，`cmt resolve <path>` 会覆盖它）
 * @returns {any | null} `normalizeProjectConfig()` 的产物
 */
export function loadProjectConfig(ctx, callCwd) {
  if (ctx.configPath !== null && ctx.configPath !== undefined) {
    // 显式给了路径却悄悄用别的文件，是最难排查的一类静默失效（§2.11 一）
    return readProjectConfig(ctx.configPath);
  }

  const found = findProjectConfig({ cwd: callCwd, platform: ctx.platform });
  return found === null ? null : readProjectConfig(found.configPath);
}

/**
 * 装配一个会话。
 *
 * @param {{
 *   ctx: import('./types.js').Ctx,
 *   target: string,
 *   overrides: any,
 *   rest?: string[],
 * }} args `target` = **绑定匹配**用的具体目录（永远有值，调用方用 `显式目录 ?? ctx.cwd` 兜底）；
 *        `rest` = `--` 之后的透传参数（只用来判断 claude 是否处于 --print 模式）
 */
export function prepareSession({ ctx, target, overrides, rest = [] }) {
  const { config, path: configFile, exists: configExists } = loadConfig({ home: ctx.home });

  // ★ 项目本地配置（§2.11）——插在绑定之上、命令行之下。
  // ⚠️ 发现用 `overrides.cwd ?? target`（"用户说的那个目录"），绑定匹配仍用 `target`。
  const project = loadProjectConfig(ctx, overrides.cwd ?? target);

  // 阶段一：先定 token 名，加载它，再完整解析（§2.3 的两阶段）
  const picked = pickTokenName({ config, overrides, cwd: target, ctx, project });
  const { token, exists: tokenExists } = picked.name
    ? loadToken({ home: ctx.home, name: picked.name })
    : { token: null, exists: false };

  // 阶段二
  const resolved = resolveConfig({ config, token, overrides, cwd: target, ctx, env: ctx.env, project });

  // `print` 指的是**claude 的** --print 模式（§2.5：--fallback-model 仅 --print 有效），
  // 不是 cmt 自己的 --print（那是"别启动，打印给我看"）。
  // 所以这里看的是 `--` 之后的透传参数，而不是 cmt 的开关。
  const injection = buildInjection(resolved, {
    home: ctx.home,
    env: ctx.env,
    print: claudePrintMode(rest),
  });

  const check = validateSession(resolved);

  return {
    config,
    configFile,
    configExists,
    project,
    picked,
    token,
    tokenExists,
    resolved,
    injection,
    check,
  };
}

/**
 * `injection.unresolved` 里有没有**必须拦下**的项（§2.4）。
 *
 * `unresolved` = "本该注入却没能注入"。在**启动路径**上它非空只有一种成因：
 * 某个字段里出现了 `${...}`，但不构成整串引用（§2.4 只认整串），于是求值失败。
 * 那是**配置错误**，不是"环境还没准备好"——重试多少次都一样，所以拦下而不是警告。
 *
 * ⚠️ **别把它降级成 stderr 警告**：`cmt exec` 用 `stdio: 'inherit'` 把终端交给 claude，
 * 那条警告会在 claude 的 TUI 铺满屏幕的瞬间被盖掉——"提示过了"就成了一句空话。
 * 而放它过去，claude 会带着半个环境启动：少了 `ANTHROPIC_BASE_URL` 就悄悄退回
 * 一方端点却仍拿着中转站的 token，少了 token 就变成一个恒被拒绝的假身份。
 * `buildInjection()` 的文档把这条写成了契约：「`cmt exec` 报错退出」。
 *
 * **`cmt resolve` / `--print` 不调用它**：那两条是诊断视图，职责是把问题**展示出来**
 * 而不是拦下（`resolve` 的退出码永远是 0，§5）。
 *
 * @param {{ unresolved?: { envVar: string, reason: string }[] }} injection
 * @returns {CmtError | null} 没问题返回 `null`，否则是可直接 `throw` 的错误
 */
export function unresolvedBlocker(injection) {
  const list = injection?.unresolved ?? [];
  if (list.length === 0) return null;

  const lines = list.map((u) => `  ✗ ${u.envVar} 没能注入：${u.reason}`);
  return new CmtError(`有 ${list.length} 项环境变量注入失败，不能带着残缺的环境启动：\n${lines.join('\n')}`, {
    hint:
      '`${ENV_VAR}` 只认整串引用："${A}" 可以，"https://${A}/v1" 这类拼接不行。\n' +
      '  看完整解析：`cmt resolve`；只想看不启动：`cmt run --print`',
  });
}

/**
 * 透传参数里有没有 claude 的 `--print` / `-p`。
 *
 * 有 → `buildInjection()` 会把 `models[1..]` 拼成 `--fallback-model`
 * （§2.5：该参数**仅 --print 模式有效**，交互模式下不要假装能做到）。
 *
 * @param {string[]} rest `--` 之后的参数
 */
export function claudePrintMode(rest) {
  return rest.some((a) => a === '--print' || a === '-p');
}

/**
 * 路径的最后一段（窗口标题用）。
 * @param {string} p
 */
export function cwdTail(p) {
  const parts = String(p).split(/[\\/]+/).filter((s) => s !== '');
  return parts.length > 0 ? /** @type {string} */ (parts[parts.length - 1]) : String(p);
}

/**
 * 窗口标题：`cmt:<token> · <cwd 末段>`（§2.9）。
 *
 * **总是**带 cwd 末段，不是"同 token 开多窗时才加"——
 * 本工具的卖点就是"一眼分辨哪个窗口是哪个 token / 哪个项目"，
 * 而"有没有第二个窗口"这件事 cmt 根本无从知道（无状态，§2.7 步骤 4）。
 * 与其做一个猜不准的条件追加，不如每次都带上，标题永远可分辨。
 *
 * @param {string | null | undefined} tokenName
 * @param {string} cwd
 */
export function terminalTitle(tokenName, cwd) {
  return `cmt:${profileNameFor(tokenName)} · ${cwdTail(cwd)}`;
}
