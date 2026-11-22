// @ts-check
/**
 * ★ `resolve` / `exec` / `run` **共用的会话装配**（§3 文件树）。
 *
 * 三个命令的差别只在"拿到解析结果之后干什么"：
 * `resolve` 打印它、`exec` 在当前终端执行、`run` 弹一个新窗口。
 * **解析这一步必须只有一份实现**——三份拷贝迟早会在某个边界上分叉，
 * 而分叉出来的表现是"resolve 显示的和执行的不是一回事"，最难查。
 *
 * ─────────────────────────────────────────────────────────────
 * 这一层是 cli 层，所以**它才是读 `process.*` 与 fs 的地方**：
 * `core/resolve.js` 只收 `{config, tokens, cwd, argv, entry, platform}`。
 * ─────────────────────────────────────────────────────────────
 */
import { callCwdOf, resolve as coreResolve } from '../core/resolve.js';
import { buildInjection } from '../core/resolve.js';
import { CxtError } from '../core/errors.js';
import {
  findProjectConfig, readAllTokens, readConfig, readProfileConfig, readProjectConfig,
} from '../core/store.js';
import { spliceManagedRegion } from '../core/toml-splice.js';
import { parseSecretRef } from '../core/schema.js';

/**
 * 读一份完整的 cxt 状态（config + 全部 token）。
 * @param {import('./types.js').Ctx} ctx
 */
export function loadState(ctx) {
  return {
    config: readConfig(ctx.home),
    tokens: readAllTokens(ctx.home),
  };
}

/**
 * ★ 找到并读入**项目本地配置**（§2.13 一）。没有就是 `null`。
 *
 * 两条路，**互不fallback**：
 *
 * | 来源 | 行为 |
 * |------|------|
 * | `--config <p>`（`ctx.configPath`） | 只读它。**文件不存在直接报错**，绝不回退到发现 |
 * | 没有 `--config` | 从 `callCwd` 往上找**最近的** `.cxt.json` |
 *
 * ⚠️ **发现用的是 `callCwd`（`--cwd` 优先），不是 `ctx.cwd`**——
 * `cxt run relay-a --cwd D:/proj` 要发现的是 `D:/proj` 那份配置，
 * 不是你恰好站着敲命令的那个目录。这与绑定匹配用的是同一个定义
 * （`callCwdOf()`，§2.3），所以那个函数只有一处实现。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {any} argv 已经过 `toResolveArgv` 映射
 * @param {string} cwd "我站在哪个目录"（`cxt resolve <path>` 会覆盖它）
 * @returns {any | null} `normalizeProjectConfig()` 的产物
 */
export function loadProjectConfig(ctx, argv, cwd) {
  if (ctx.configPath !== null && ctx.configPath !== undefined) {
    // 显式给了路径却悄悄用别的文件，是最难排查的一类静默失效（§2.13 一）
    return readProjectConfig(ctx.configPath);
  }

  const found = findProjectConfig({ cwd: callCwdOf(argv, cwd), platform: ctx.platform });
  return found === null ? null : readProjectConfig(found.configPath);
}

/**
 * ★ 把解析后的命令行映射成 `core/resolve.js` 要的 `argv` 形状。
 *
 * 单独放一个函数是为了**三个命令用同一套映射**——`--token-value` 到
 * `tokenValue` 这种改名散落在三处，迟早有一处忘改，而症状是
 * "`cxt resolve --token-value x` 显示的值和 `cxt run --token-value x` 用的不一样"。
 *
 * ⚠️ 全局 flag `--config` **不在这里**：它在 `main.js` 就被抽走了（进 `ctx.configPath`），
 * 所以不会出现在 `args` 里，也不需要在这里映射。
 *
 * @param {any} args parseArgs 的产物
 * @param {string[]} [positional] 位置参数（`cxt run <token>` / `cxt resolve <path>`）
 */
export function toResolveArgv(args, positional = []) {
  /** @type {any} */
  const argv = {};
  if (args.token !== undefined) argv.token = args.token;
  if (args['token-value'] !== undefined) argv.tokenValue = args['token-value'];
  if (args.url !== undefined) argv.url = args.url;
  if (args.cwd !== undefined) argv.cwd = args.cwd;
  if (args.model !== undefined) argv.model = args.model;
  if (args.pick === true) argv.pick = true;
  // ★ `--pool` 必须跟着走：挑选发生在 `resolveSession()` **之后**
  //   （`pool-pick.js` 读 `argv.pool`），漏了它就是"旗标静默失效"
  if (args.pool === true) argv.pool = true;
  if (args.window === true) argv.window = true;
  if (args.tab === true) argv.tab = true;
  if (args.resume === true) argv.resume = true;
  if (Array.isArray(args.rest) && args.rest.length > 0) argv.extraArgs = args.rest;
  if (positional.length > 0) argv.token = positional[0];
  return argv;
}

/**
 * 解析一次会话。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {any} argv 已经过 `toResolveArgv` 映射
 * @param {'run' | 'exec'} entry ★ 必传
 * @param {{ path?: string }} [opts] `path` 覆盖"我站在哪个目录"（`cxt resolve <path>`）
 */
export function resolveSession(ctx, argv, entry, opts = {}) {
  const { config, tokens } = loadState(ctx);
  // ★ 不用 `process.cwd()` 之外的东西：core 不读它，所以这里显式给
  const cwd = opts.path ?? ctx.cwd;
  return coreResolve({
    config,
    tokens,
    cwd,
    argv,
    entry,
    platform: ctx.platform,
    // ★ 第 0 步（§2.7）：发现项目本地配置。放在这里而不是 core 里，
    //   是因为 core 不碰 fs（§4.2）——`resolve()` 只收它的产物。
    project: loadProjectConfig(ctx, argv, cwd) ?? undefined,
  });
}

/**
 * 从解析结果生成注入清单（§2.6）。
 *
 * @param {any} resolved
 * @param {import('./types.js').Ctx} ctx
 * @param {{ evaluate?: boolean }} [opts]
 *   `evaluate: true`（默认）会把 `${ENV_VAR}` 求值成明文——**只有真正要 spawn 时才这么做**。
 *   `cxt resolve` / `--print` 走 `evaluate: false`，此时凭证变量根本不进 `env`。
 */
export function injectionFor(resolved, ctx, opts = {}) {
  const evaluate = opts.evaluate !== false;

  /** @type {string | null} */
  let authTokenValue = null;
  if (evaluate && resolved.authToken.value !== null) {
    // ★ 求值只在这里发生（§2.4）：从**新窗口的进程环境**读
    const ref = parseSecretRef(resolved.authToken.value);
    authTokenValue = ref.kind === 'literal'
      ? ref.value
      : requireEnv(ref.name, ctx.env);
  }

  return buildInjection(resolved, { home: ctx.home, platform: ctx.platform, authTokenValue });
}

/**
 * 取环境变量，没设置就抛错（§2.4）。
 *
 * **绝不静默回退成字面量 `"${VAR}"`**——那会变成一个恒被拒绝的假 token，
 * 报错信息还完全指不到病根。
 * @param {string} name
 * @param {Record<string, string | undefined>} env
 */
export function requireEnv(name, env) {
  const v = env[name];
  if (typeof v !== 'string' || v === '') {
    throw new CxtError(`引用的环境变量 ${name} 未设置`, {
      hint: `设置它（例：export ${name}=<key>）后重试，或把 token 里的 authToken 改成明文`,
    });
  }
  return v;
}

/**
 * ★ 受管区漂移检测（§2.9）：把当前文件重新拼一遍，看结果是否逐字节相同。
 *
 * **幂等性就是漂移检测的原语**——同样的受管值再拼一次若产生不同文本，
 * 说明文件被手工改过（或 cxt 的拼接逻辑变了）。
 *
 * ⚠️ 用 `evaluate: false`——**检测漂移不需要求值凭证**，
 * 受管区里本来就只写变量名（§2.2）。顺带的好处：`cxt resolve`
 * 在 `${ENV_VAR}` 没设时也能正常跑出来（§2.4）。
 *
 * 返回值里带上 `injection`，是因为调用方（`cxt resolve`）本来就要拿它
 * 显示窗口标题 / profile 路径——不带上就会各算一遍，而两遍迟早会不一致。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {any} resolved
 * @returns {{ injection: any, current: string, next: string, changed: boolean, report: any }}
 */
export function managedRegionDiff(ctx, resolved) {
  const injection = injectionFor(resolved, ctx, { evaluate: false });
  const current = readProfileConfig(ctx.home, resolved.profileName);
  const { newText, report } = spliceManagedRegion({
    existingText: current,
    managedValues: injection.managedValues,
  });
  return { injection, current, next: newText, changed: report.changed, report };
}
