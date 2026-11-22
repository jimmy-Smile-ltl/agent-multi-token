// @ts-check
/**
 * ★★ **四要素解析级联**（§2.3）+ 注入清单生成（§2.6）。
 *
 * 这是整个工具的**心脏**：`cxt resolve` 只是把它打印出来，`cxt run` / `cxt exec`
 * 只是把它的结果变成环境变量与命令行。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 纯函数铁律（§4.2）
 *
 * 输入 `{ config, tokens, cwd, argv, entry, platform }`，输出 `{值, 来源层}`。
 * **不读 fs、不读 `process.env`、不读 `process.platform`、不 spawn。**
 *
 * 代价是调用方（`cli/`）要先把配置和 token 文件读进来——**这正是我们要的**：
 * 解析链因此可以拿字符串字面量做穷举单测，而它恰恰是最容易出错的一环。
 * ─────────────────────────────────────────────────────────────
 *
 * ## ★ `entry` 必填，且不给默认值
 *
 * `entry: 'run' | 'exec'` 决定 **`token.cwd` 生不生效**（§2.3 第五条）：
 *
 * | 入口 | `token.cwd` | 实际 cwd |
 * |------|:---:|---------|
 * | `run`（弹新窗口） | ✅ | `--cwd` → `token.cwd` → 当前目录 |
 * | `exec`（当前终端） | ❌ 跳过 | `--cwd` → 当前目录 |
 *
 * **不给默认值的理由**：给了默认值就等于留了一条"忘了传也能跑"的静默错路，
 * 而这条错路的表现是**续错会话**——最难排查的一类 bug。
 *
 * ⚠️ 这条分叉**只在 `resolveCwd()` 里实现一次**，别让 exec 路径"碰巧"拿到
 * `token.cwd` 再靠调用方不传 `-C` 来抵消——那会在 `--print`、`doctor`、
 * launch 脚本生成三条路径上各自漏一次。
 *
 * ⚠️ **项目本地配置（§2.13）不在这条链上**，这也是刻意的：这份文件本身
 * 就是"**按路径找到的**"，再让它声明 cwd 是循环定义（拿它去匹配绑定会成环，
 * §2.3 已有同类教训）。所以入参里根本没有 `project`。
 *
 * ## 来源层词表（`SOURCE`）
 *
 * `cxt resolve` 要把每一项标出来源，所以**每一层都有名字**，不许含糊：
 * `cli` / `project` / `binding` / `token` / `defaults` / `builtin` / `preflight` /
 * `pool` / `derived` / `process` / `merged` / `none`
 *
 * ## ⚠️ 绑定匹配永远用「调用时的 cwd」
 *
 * `--cwd` 或进程当前目录，**绝不用 `token.cwd`**——后者是"这个 token 默认落在哪"，
 * 拿它去匹配绑定会**成环**（§2.3）。
 */

import { matchBinding } from './bindings.js';
import { currentModel } from './models.js';
import { CxtError } from './errors.js';
import { deriveEnvKeyName, deriveProviderId, validateTokenName } from './schema.js';
import { expandTilde, profileDir, profileNameFor } from './paths.js';

/**
 * 来源层词表。`cxt resolve` 直接打印这些字符串（§2.3）。
 * @type {Record<string, Source>}
 */
export const SOURCE = {
  /** 命令行显式给出（`--url` / `--token` / `--cwd` …） */
  CLI: 'cli',
  /** ★ `<项目>/.cxt.json`（§2.13）——**唯一一层跟着仓库走的配置** */
  PROJECT: 'project',
  /** 路径绑定命中的那一条（§2.3 最长前缀匹配） */
  BINDING: 'binding',
  /** `tokens/<name>.json` */
  TOKEN: 'token',
  /** `config.json` 的 `defaults` */
  DEFAULTS: 'defaults',
  /** cxt 内置兜底（`wireApi` → `"responses"`、`terminalMode` → `"tab"`） */
  BUILTIN: 'builtin',
  /**
   * ★ 启动前校验换掉了首位（§2.5）——**不是**某一层配置给的，所以单列。
   *
   * 混进 `token` / `defaults` 会让 `cxt resolve` 撒谎（"这个模型是配置里写的"
   * 而其实是端点清单挑出来的）。它也不会被写进受管区：受管区永远写 `models[0]`。
   */
  PREFLIGHT: 'preflight',
  /**
   * ★★ **token 池挑的**（§2.15 三）——同样不是某一层配置给的。
   *
   * 它**永远由 cli 层盖上去**：core 的 `resolve()` 根本不认识池（池是 I/O + 网络，
   * 见 §4.2）。挑选发生在 `resolve()` 之后，挑完再解析一次，然后把这个值
   * 盖到 `token.source` 上——所以它出现时，其余每一项都已经是"选中那个 token
   * 之后"的正确值，而不是"没有任何 token"时的那份。
   */
  POOL: 'pool',
  /** 派生量（`providerId` → `cxt-<token>`） */
  DERIVED: 'derived',
  /** 进程当前目录（`cwd` 的最终兜底） */
  PROCESS: 'process',
  /** 多层按键合并 / 拼接（`env`、`codexArgs`） */
  MERGED: 'merged',
  /** 没有任何一层说话 */
  NONE: 'none',
};

/**
 * @typedef {'cli'|'project'|'binding'|'token'|'defaults'|'builtin'|'preflight'|'pool'|'derived'|'process'|'merged'|'none'} Source
 */

/**
 * ★★ **"调用时的 cwd"**（§2.3）——`--cwd` 优先，否则进程当前目录。
 *
 * 两个地方必须用**同一个定义**，所以只写一处：
 * 1. **绑定匹配**（`resolve()` 里那条最长前缀匹配）
 * 2. **项目本地配置的发现**（§2.13 一——`cxt run relay-a --cwd D:/proj`
 *    要发现的是 `D:/proj` 的那份，不是你恰好站着敲命令的那个目录）
 *
 * 反例：拿 `token.cwd` 来算会**成环**（§2.3 反复点名的那条）。
 *
 * @param {{ cwd?: any } | undefined | null} argv
 * @param {string} cwd 进程当前目录（调用方注入）
 */
export function callCwdOf(argv, cwd) {
  return argv?.cwd !== undefined ? argv.cwd : cwd;
}

/**
 * @template T
 * @typedef {object} Resolved
 * @property {T | null} value 解析出的值；`null` = 没有任何一层给出
 * @property {Source} source 它来自哪一层
 * @property {string} [detail] 人看的补充（flag 名、绑定路径、token 名…）
 */

/**
 * @param {unknown} entry
 * @returns {'run' | 'exec'}
 */
function assertEntry(entry) {
  if (entry !== 'run' && entry !== 'exec') {
    throw new CxtError(`entry 必须是 'run' 或 'exec'，收到 ${JSON.stringify(entry)}`, {
      hint: 'entry 决定 token.cwd 生不生效（§2.3 第五条），必须显式传——不给默认值',
    });
  }
  return entry;
}

/**
 * 取第一个"该层确实说了话"的候选。
 *
 * ⚠️ **判据是 `value !== undefined`，不是真值判断**：`models: []` 与 `""`
 * 都是**显式声明**，被 `||` 吞掉就会退化成"继承上一层"（§2.5 规则 3/4 的坑）。
 * @template T
 * @param {(Resolved<T> | null | undefined)[]} candidates
 * @returns {Resolved<T>}
 */
function firstOf(candidates) {
  for (const c of candidates) {
    if (c != null && c.value !== undefined) return c;
  }
  return { value: null, source: SOURCE.NONE };
}

/**
 * 造一个候选：`has` 为假时返回 `null`（= 这一层没说话），交 `firstOf` 跳过。
 * @template T
 * @param {boolean} has
 * @param {T} value
 * @param {Source} source
 * @param {string} [detail]
 * @returns {Resolved<T> | null}
 */
function cand(has, value, source, detail) {
  return has ? { value, source, detail } : null;
}

// ───────────────────────── ★ cwd 的入口分叉 ─────────────────────────

/**
 * ★★ **cwd 的入口分叉**（§2.3 第五条）——全表唯一一处"同一个要素、两个入口两套规则"。
 *
 * 独立成函数是**契约的硬性要求**（§2.3 的实现约束）：分叉必须是一个显式参数，
 * 不能靠调用方"记得不传 `-C`"来抵消。
 *
 * `cxt exec` 跳过 `token.cwd` 的理由（两条都会静默出事）：
 * 1. **心智模型**——shell 的 pwd 与 Codex 的工作根不一致，`git status`、
 *    相对路径、编辑器打开的文件全对不上；
 * 2. **会话续接**——`resume --last` 的作用域是「`CODEX_HOME` + cwd」，
 *    cwd 被悄悄换掉 = **静默续错会话**。
 *
 * @param {{ argv?: any, token?: any, cwd?: string }} input
 * @param {'run' | 'exec'} entry
 * @returns {Resolved<string>}
 */
export function resolveCwd(input, entry) {
  assertEntry(entry);

  const flag = input?.argv?.cwd;
  if (flag !== undefined) {
    return { value: flag, source: SOURCE.CLI, detail: '--cwd' };
  }

  // ★ 分叉就在这一行：只有 run 才看 token.cwd
  if (entry === 'run' && input?.token?.cwd !== undefined) {
    return {
      value: input.token.cwd,
      source: SOURCE.TOKEN,
      detail: `token ${input.token.name ?? ''}.cwd`.trim(),
    };
  }

  return { value: input?.cwd ?? null, source: SOURCE.PROCESS, detail: '进程当前目录' };
}

// ───────────────────────────── 主解析 ─────────────────────────────

/**
 * 解析出四要素及其它全部注入项，**每项带来源层**（§2.3）。
 *
 * **不抛"缺项"错**——缺项收集在 `missing` 里。想让它抛，用 `validate.js` 的
 * `assertComplete()`。分开的理由：`cxt resolve` 的价值恰恰在于
 * **告诉你哪一项没设置**，一上来就抛错就什么都看不到了。
 *
 * 但**结构性错误照抛不误**（如 `--token` 指了一个不存在的 token 文件）：
 * 那不是"缺项"，是配置本身坏了，继续往下解析只会得到一屏误导性的"全缺"。
 *
 * @param {{
 *   config?: any,                    // normalizeConfig() 的产物
 *   tokens?: Record<string, any>,    // token 名 → normalizeToken() 的产物（或 null）
 *   cwd: string,                     // 进程当前目录（调用方给，core 不读 process.cwd()）
 *   argv?: any,                      // 解析后的命令行
 *   entry: 'run' | 'exec',           // ★ 必填，无默认
 *   platform?: string,               // 绑定匹配的路径规则（§2.3）
 *   project?: any,                   // ★ §2.13 的项目本地配置，`normalizeProjectConfig()` 的产物
 * }} input
 */
export function resolve(input) {
  const entry = assertEntry(input?.entry);
  const config = input?.config ?? {};
  const tokens = input?.tokens ?? {};
  const argv = input?.argv ?? {};
  const cwd = input?.cwd;
  const platform = input?.platform;
  // ★ 项目本地配置（§2.13）。**发现动作不在这里**——本函数是纯的，
  //   加载是 cli 层的事（`store.findProjectConfig()` + `store.readProjectConfig()`）。
  //   没找到就是 `undefined`，与"没传"同义：这一层没说话。
  const project = input?.project ?? null;

  if (typeof cwd !== 'string' || cwd === '') {
    throw new CxtError('resolve() 需要调用时的 cwd', {
      hint: 'core 不读 process.cwd()（§4.2），由 cli 层注入',
    });
  }

  const defaults = config.defaults ?? {};
  const bindings = config.bindings ?? [];

  // ★ 绑定匹配用**调用时的 cwd**（`--cwd` 优先），**不是** token.cwd——
  //   拿 token.cwd 去匹配绑定会成环（§2.3）。
  //   ⚠️ 项目本地配置的**发现**用的也是这一个值（`callCwdOf()`，§2.13 一）——
  //   同一个定义，同一个函数，不许各算一遍。
  const callCwd = callCwdOf(argv, cwd);
  const match = matchBinding(bindings, callCwd, platform);
  /** @type {any} */
  const binding = match?.binding ?? null;
  const bindingDetail = binding ? `绑定 ${binding.path}` : undefined;
  const projectDetail = project ? `项目本地 ${project.configPath}` : undefined;

  // ── token 选择：--token（含位置参数） → 项目本地 → 绑定 → defaults.token → 无 ──
  const tokenPick = firstOf([
    cand(argv.token !== undefined, argv.token, SOURCE.CLI, '--token'),
    cand(project?.token !== undefined, project?.token, SOURCE.PROJECT, projectDetail),
    cand(binding?.token !== undefined, binding?.token, SOURCE.BINDING, bindingDetail),
    cand(defaults.token !== undefined, defaults.token, SOURCE.DEFAULTS, 'defaults.token'),
  ]);

  const tokenName = tokenPick.value;
  let token = null;
  if (tokenName !== null) {
    // ★★ **先校验名字，再查表**（§2.8）。
    //    token 名会变成目录名（`profiles/<name>/`）、环境变量名、窗口标题，
    //    所以这里必须拒绝路径穿越。
    //
    //    顺序很关键：不校验的话 `--token ../etc` 会走到"查表没查到 → 报不存在"，
    //    于是**安全性碰巧成立**（没查到就不会去拼路径），但报错信息会建议用户
    //    `cxt token add ../etc ...`——既误导，又把安全押在"表里恰好没有"上。
    //    将来任何一条按文件名直接读的路径都会让穿越变成真的。
    validateTokenName(tokenName);

    token = tokens[tokenName] ?? null;
    if (token === null) {
      throw new CxtError(`token "${tokenName}" 不存在`, {
        // ★ 报 `detail` 而不是 `source`：`project` / `binding` 这类词本身不告诉用户
        //   **是哪一份文件**说话，而"我明明建了这个 token"十有八九是看错了层。
        hint: `来源：${tokenPick.detail ?? tokenPick.source}。`
          + `用 \`cxt token add ${tokenName} --token <key>\` 创建，或 \`cxt ls\` 看看有哪些`,
      });
    }
  }

  /**
   * 某一层的来源名。⚠️ 判据是**对象同一性**，所以 `null` 层（没命中绑定 / 没有项目配置）
   * 会一路落到 `DEFAULTS`——无害：`at()` 传进来的 `null` 层 `has` 必为 false，
   * 这个返回值根本用不上（见 `cand()`）。
   */
  const sourceOf = (layer) => (
    layer === project ? SOURCE.PROJECT
      : layer === binding ? SOURCE.BINDING
        : layer === token ? SOURCE.TOKEN
          : SOURCE.DEFAULTS
  );
  const layerDetail = (layer) => (
    layer === project ? projectDetail
      : layer === binding ? bindingDetail
        : layer === token ? `token ${tokenName}` : undefined
  );
  /** 取某一层上的某个字段——**该层没声明就返回 `null`**（= 这一层没说话） */
  const at = (layer, field) => cand(layer?.[field] !== undefined, layer?.[field], sourceOf(layer), layerDetail(layer));

  // ── cwd（唯一按入口分叉的要素）──
  const cwdR = resolveCwd({ argv, token, cwd }, entry);

  // ── 四要素之二 / 之三：baseUrl、authToken ──
  //   ⚠️ **这两条链上没有项目本地层**（§2.13 二），是刻意的，不是漏写：
  //   凭证与目的地只许来自 tokens/<name>.json。`baseUrl` 写进 `.cxt.json`
  //   就是一条外泄通道——克隆来的仓库写个 evil.com，你的 key 就送过去了。
  const baseUrl = firstOf([
    cand(argv.url !== undefined, argv.url, SOURCE.CLI, '--url'),
    at(binding, 'baseUrl'),
    at(token, 'baseUrl'),
    at(defaults, 'baseUrl'),
  ]);

  const authToken = firstOf([
    cand(argv.tokenValue !== undefined, argv.tokenValue, SOURCE.CLI, '--token-value'),
    at(binding, 'authToken'),
    at(token, 'authToken'),
    at(defaults, 'authToken'),
  ]);

  // ── 派生量 providerId（有默认值，所以不是第五要素）──
  //   ⚠️ 没有 defaults 这一层（既有行为）：providerId 是个纯派生量，
  //   全局默认它没有意义。项目本地层则是**允许**的（§2.13 二）——它只是个名字。
  const providerIdRaw = firstOf([
    at(project, 'providerId'),
    at(binding, 'providerId'),
    at(token, 'providerId'),
  ]);
  const providerId = providerIdRaw.value !== null
    ? providerIdRaw
    : {
      value: deriveProviderId(tokenName),
      source: SOURCE.DERIVED,
      detail: tokenName ? `由 token 名 ${tokenName} 派生` : '无 token → cxt-default',
    };

  // ── wireApi：… → 内置 "responses" ──
  //   ⚠️ 项目本地层**禁止**（§2.13 二）：它与 baseUrl 同属"怎么跟那个端点说话"，
  //   是目的地描述符的一部分。
  const wireApiRaw = firstOf([at(binding, 'wireApi'), at(token, 'wireApi'), at(defaults, 'wireApi')]);
  const wireApi = wireApiRaw.value !== null
    ? wireApiRaw
    : { value: 'responses', source: SOURCE.BUILTIN, detail: 'Codex 仅支持这一种（§7.9）' };

  // ── models：整体覆盖，**不合并**（§2.5）──
  const models = firstOf([at(project, 'models'), at(binding, 'models'), at(token, 'models'), at(defaults, 'models')]);

  // ── model（第四要素）：`--model` 差量 → models[0] ──
  //    ⚠️ `models: []` 是**合法的"不注入"**，不算缺项（§2.3 的表）。
  const model = argv.model !== undefined
    ? { value: { id: argv.model }, source: SOURCE.CLI, detail: '--model 差量（不落盘）' }
    : (models.value !== null && models.value.length > 0
      ? { value: currentModel(models.value), source: models.source, detail: models.detail }
      : {
        value: null,
        source: models.value !== null ? models.source : SOURCE.NONE,
        detail: models.value !== null ? '显式空列表 → 不注入模型' : undefined,
        explicitEmpty: models.value !== null,
      });

  // ── catalog（可选）──
  const catalog = firstOf([
    at(project, 'catalog'), at(binding, 'catalog'), at(token, 'catalog'), at(defaults, 'catalog'),
  ]);

  // ── env：四层**按键合并**（低 → 高），右侧覆盖同名键 ──
  //   ★ 项目本地排**最后**（§2.3）：它是"这个仓库该怎么跑"，比任何全局层都具体。
  //   ⚠️ `CODEX_HOME` 之类的隔离原语已经在 `normalizeProjectConfig()` 里拦掉了
  //   （§2.13 二）——因为 `buildInjection()` 的 env 合并排在 `CODEX_HOME` 种子之后，
  //   放进来是真的能盖掉隔离落点的。
  const env = mergeEnv([
    [SOURCE.DEFAULTS, defaults.env],
    [SOURCE.TOKEN, token?.env],
    [SOURCE.BINDING, binding?.env],
    [SOURCE.PROJECT, project?.env],
  ]);

  // ── codexArgs：**拼接**（低 → 高），命令行 `--` 追加在最后 ──
  const codexArgs = concatArgs(defaults.codexArgs, token?.codexArgs, project?.codexArgs, argv.extraArgs);

  // ── sandboxMode / approvalPolicy：默认**不注入**（§2.3 第四条）──
  //   ⚠️ 项目本地层在这条链上**排在 binding 之上**，这与"沙箱是仓库的安全策略、
  //   领地属于项目级"（§2.3 第四条）看起来打架，其实不是：`.codex/config.toml`
  //   是**仓库自己**声明的策略，而 `.cxt.json` 同样是仓库里的文件（§2.13 三）。
  //   真正被这条链压掉的是**仓库的文件**，而它仍然是用户此刻在编辑的那个仓库的意志。
  //   注意 `collectWarnings()` 会为这两项照常发告警——覆盖行为要看得见。
  const sandboxMode = firstOf([
    at(project, 'sandboxMode'), at(binding, 'sandboxMode'), at(token, 'sandboxMode'), at(defaults, 'sandboxMode'),
  ]);
  const approvalPolicy = firstOf([
    at(project, 'approvalPolicy'), at(binding, 'approvalPolicy'), at(token, 'approvalPolicy'), at(defaults, 'approvalPolicy'),
  ]);

  // ── terminalMode：flag → defaults → 内置 "tab" ──
  //   ⚠️ 项目本地层**禁止**（§2.13 二）：机器级偏好，写进仓库只会让同事的终端
  //   按你的习惯开标签页/窗口。
  const terminalMode = firstOf([
    cand(argv.window === true, 'window', SOURCE.CLI, '--window'),
    cand(argv.tab === true, 'tab', SOURCE.CLI, '--tab'),
    cand(defaults.terminalMode !== undefined, defaults.terminalMode, SOURCE.DEFAULTS, 'defaults.terminalMode'),
  ]);
  if (terminalMode.value === null) {
    terminalMode.value = 'tab';
    terminalMode.source = SOURCE.BUILTIN;
    terminalMode.detail = 'cxt 默认开标签页';
  }

  const profileName = profileNameFor(tokenName);

  const result = {
    entry,
    cwd: cwdR,
    token: tokenName === null
      ? { value: null, source: SOURCE.NONE, detail: '纯 defaults 模式' }
      : { value: tokenName, source: tokenPick.source, detail: tokenPick.detail },
    tokenObject: token,
    binding,
    bindingPath: binding?.path ?? null,
    /**
     * ★ 本次生效的项目本地配置（§2.13）+ 它的路径。
     *
     * 带上整份对象而不是只带路径：`cxt model` 的 `pickLayer()` 要按它决定
     * "写回哪一层"（§2.13 五），面板也要拿它显示"这一项是项目本地给的"。
     * `null` = 没发现，或 `--config` 没给。
     */
    project,
    projectPath: project?.configPath ?? null,
    authToken,
    baseUrl,
    providerId,
    wireApi,
    models,
    model,
    catalog,
    env,
    codexArgs,
    /**
     * ★ `-c` / `--resume`：**不是四要素，不进级联**——它只影响交给 codex 的 argv
     * （`resume --last`）。放在这里而不是让命令层自己拼，理由和 `-C` 一样：
     * `--print`、实跑、launch 脚本三条路径必须看到同一份 argv。
     */
    resume: argv.resume === true,
    /**
     * ★ 启动前校验开不开（§2.5）。**机器级偏好**，只有 `defaults` 能写（§2.4）。
     *
     * 这里刻意是**裸布尔**、不是 `{value, source, detail}`：它不是配置值，
     * 是"这一轮要不要多问端点一句"的开关；`cxt resolve` 不展示来源层，
     * 展示也没意义（用户只可能在一个地方写它）。
     */
    preflight: defaults.preflight !== false,
    sandboxMode,
    approvalPolicy,
    terminalMode,
    profileName,
    /** 凭证环境变量名（§2.6）——**只注入这一处** */
    envKeyName: deriveEnvKeyName(tokenName),
    /** 该条绑定是否真的命中了（`cxt resolve` 要显示"为什么是这个 token"） */
    bindingMatched: match !== null,
    callCwd,
  };

  return { ...result, missing: findMissing(result), warnings: collectWarnings(result) };
}

// ───────────────────────────── 合并语义 ─────────────────────────────

/**
 * `env` 的**按键合并**（§2.3）。
 *
 * 与 `models` 的"整体覆盖"刻意不同：`env` 是一堆彼此独立的逃生舱开关，
 * 而 `models` 是"一组连贯的选择集"——把 `models` 并集起来，
 * 用户就没法用 `models: [x]` 表达"这个目录只用 x"了。
 *
 * @param {[Source, Record<string, string> | undefined][]} layers 低 → 高
 * @returns {Resolved<Record<string, string>> & { sources: Record<string, Source> }}
 */
function mergeEnv(layers) {
  /** @type {Record<string, string>} */
  const out = {};
  /** @type {Record<string, Source>} */
  const sources = {};

  for (const [source, layer] of layers) {
    if (layer == null) continue;
    for (const [k, v] of Object.entries(layer)) {
      out[k] = v;
      sources[k] = source;   // 右侧覆盖同名键 → 后面的层写赢
    }
  }

  const keys = Object.keys(out);
  return {
    value: keys.length > 0 ? out : null,
    source: keys.length > 0 ? SOURCE.MERGED : SOURCE.NONE,
    detail: keys.length > 0 ? `${keys.length} 个变量` : undefined,
    sources,
  };
}

/**
 * `codexArgs` 的**拼接**（§2.3）。低层在前、高层在后——
 * 让更具体的层排在 argv 后面，从而压过前面的同名参数。
 *
 * @param {...(string[] | undefined)} lists
 * @returns {Resolved<string[]>}
 */
function concatArgs(...lists) {
  /** @type {string[]} */
  const out = [];
  for (const l of lists) if (Array.isArray(l)) out.push(...l);

  return out.length > 0
    ? { value: out, source: SOURCE.MERGED, detail: `${out.length} 个参数` }
    : { value: null, source: SOURCE.NONE };
}

// ───────────────────────── 缺项与告警（§2.1）─────────────────────────

/**
 * 四要素缺了哪些（§2.1）。**只报缺项，不抛错**——`cxt resolve` 要能打印出来。
 * @param {any} r resolve() 的产物
 * @returns {string[]}
 */
function findMissing(r) {
  /** @type {string[]} */
  const missing = [];
  if (r.cwd.value === null) missing.push('cwd');
  if (r.authToken.value === null) missing.push('authToken');
  if (r.baseUrl.value === null) missing.push('baseUrl');
  // ⚠️ models 是 `[]` → **不算缺**（显式声明"不注入"，§2.3 的表）
  if (r.model.value === null && r.model.explicitEmpty !== true) missing.push('model');
  return missing;
}

/**
 * 需要用户知道的副作用（`cxt resolve` 会标出来）。
 * @param {any} r
 * @returns {{ code: string, message: string }[]}
 */
function collectWarnings(r) {
  /** @type {{ code: string, message: string }[]} */
  const warnings = [];

  // §2.3 第四条：沙箱 / 审批是**仓库的安全策略**，领地属于项目级 .codex/config.toml。
  // 我们在用户层写一份，会把仓库自己声明的策略压掉——那是安全回归，不是便利。
  for (const [field, label] of [['sandboxMode', 'sandboxMode'], ['approvalPolicy', 'approvalPolicy']]) {
    if (r[field].value !== null) {
      warnings.push({
        code: 'overrides-project-policy',
        message: `${label} 将在受管区写死为 "${r[field].value}"`
          + `（来源：${r[field].source}），会覆盖项目级 .codex/config.toml 里声明的策略`,
      });
    }
  }

  if (r.entry === 'exec' && r.tokenObject?.cwd !== undefined && r.cwd.source !== SOURCE.CLI) {
    warnings.push({
      code: 'token-cwd-skipped',
      message: `token ${r.token.value} 声明了 cwd = ${JSON.stringify(r.tokenObject.cwd)}，`
        + '但 cxt exec 不应用它（§2.3 第五条）——要用它请走 `cxt run`',
    });
  }

  // ★★ 身份与地址来自不同层——本表最容易踩的一脚（§2.3 的表：绑定比 token 具体）。
  //    `cxt run relay-a` 落在绑定了 relay-b 的目录里，会得到
  //    **relay-a 的 key 配 relay-b 绑定的 URL**。契约就是这么定的（绑定更具体），
  //    但静默混用凭证与端点是安全坑，必须说出来。
  //
  //    ⚠️ **`project` 也算**（§2.13 三）：项目本地在 token 这条链上比绑定高，
  //    于是 `.cxt.json` 写 `"token": "relay-a"`、落在绑定了 relay-b 的目录里，
  //    会得到**一模一样**的组合——而它比 `--token` 更隐蔽：用户这一轮没敲那个 flag，
  //    是**仓库的文件**替他做的决定。少这一条，`.cxt.json` 就成了绕过这条告警的后门。
  if ((r.token.source === SOURCE.CLI || r.token.source === SOURCE.PROJECT) && r.bindingMatched) {
    const fromBinding = ['baseUrl', 'authToken', 'providerId'].filter(
      (f) => r[f].source === SOURCE.BINDING,
    );
    // ★ 绑定自己点名的就是**同一个** token → 没混用，不报。
    //   绑定 `{token: "relay-b", baseUrl: "https://b/"}` 本来就是"relay-b 配这个地址"
    //   的声明；项目文件或 `--token` 再选一次 relay-b 得到的是同一件事。
    //   ⚠️ 这条是**安全告警**——假阳性会把它变成背景噪音，然后真出事时没人看。
    const sameIdentity = r.binding?.token !== undefined && r.binding.token === r.token.value;
    if (fromBinding.length > 0 && !sameIdentity) {
      // CLI 用 `--token <名字>`（用户这一轮敲的就是它）；项目本地用
      // `<文件> 里的 "<名字>"`——它不是用户敲的，是仓库的文件替他做的决定。
      const identity = r.token.source === SOURCE.PROJECT
        ? `${r.token.detail} 里的 "${r.token.value}"`
        : `--token ${r.token.value}`;
      warnings.push({
        code: 'explicit-token-mixed-with-binding',
        message: `身份取自 ${identity}，但 ${fromBinding.join(' / ')} 取自绑定 `
          + `${r.bindingPath}（绑定层比 token 层更具体，§2.3）——`
          + '这会把 A 的凭证接到 B 的地址上。想全用该 token 的配置，请离开绑定目录或显式加 --url',
      });
    }
  }

  return warnings;
}

// ───────────────────────── 注入清单（§2.6）─────────────────────────

/**
 * ★ **丢掉值为 `null` 的键**——TOML 里没有 null（`toml-value.js` 会直接抛错）。
 *
 * 这里不写 `base_url = null`，而是**整条键不写**：那是"这一项还没解析出来"，
 * 不是"这一项是空的"。两者在 TOML 里的正确表达都是**键不存在**。
 *
 * ⚠️ 这个函数存在的理由不是"顺手清理"，而是 `cxt resolve` 必须能在
 * **四要素不齐**的配置上跑起来——那正是它最该干活的场景。少了这一层，
 * 它会在最该诊断的时候抛一个 `toml-value.js` 的错，把真正的问题盖住。
 *
 * ⚠️ **别把这道保险下沉到 `toml-splice.js`**：那里的 null 报错是**守卫**，
 * 它刚刚就抓出了这个 bug。生产侧负责不产出 null，消费侧负责拒绝 null，
 * 两边都做对才叫防御，把守卫改成静默跳过只是把 bug 藏起来。
 *
 * @param {Record<string, unknown>} obj
 */
function omitNulls(obj) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * 把解析结果变成**实际要注入的东西**（§2.6 的唯一来源）。
 *
 * 三样产物，对应三种通道：
 * - `env`：`CODEX_HOME`（身份隔离）+ `CXT_TOKEN_*`（**唯一凭证注入点**）+ 逃生舱 `env.*`
 * - `managedValues`：交给 `toml-splice.js` 写进 `profiles/<t>/config.toml` 的受管区
 * - `args`：追加到 codex 命令行的参数
 *
 * ⚠️ **凭证不落 config.toml**（§2.2）：`env_key` 只写**变量名**，
 * 真正的值走进程环境。config.toml 是双作者文件，明文 key 进去会多一个落盘点。
 *
 * @param {any} r `resolve()` 的产物
 * @param {{ home: string, platform: NodeJS.Platform, authTokenValue?: string | null }} opts
 *   `authTokenValue` 是**已求值**的明文（`${ENV_VAR}` 已展开）。
 *   传 `null` 表示干跑（`--print`）——此时**不把变量塞进 env**，只留名字。
 */
export function buildInjection(r, { home, platform, authTokenValue = null }) {
  if (typeof home !== 'string' || home === '') {
    throw new CxtError('buildInjection() 需要 home', { hint: 'core 不读 os.homedir()（§4.2）' });
  }
  // ★ 必填，理由和 home 一样：`~` 展开要按**目标平台**拼（§3.5 规则 2）。
  //   缺了它就只能拿宿主平台凑合，而 core 不许读 process.platform（§4.2）。
  if (platform !== 'win32' && platform !== 'darwin' && platform !== 'linux') {
    throw new CxtError('buildInjection() 需要 platform', {
      hint: 'core 不读 process.platform（§4.2）——由 CLI 层从 ctx.platform 传进来',
    });
  }

  const profile = profileDir(home, r.profileName);

  /** @type {Record<string, string>} */
  const env = { CODEX_HOME: profile };

  if (authTokenValue !== null) env[r.envKeyName] = authTokenValue;

  /**
   * ★ **空串 = "删掉这个继承来的变量"**，不是"设成空"（§2.6）。
   *
   * 理由有两条，第二条才是承重的：
   * 1. 空串在 Windows 上本来就等于"变量不存在"，在 POSIX 上却是个**真的空值**——
   *    同一个配置在两个平台上跑出两种语义，不能留。
   * 2. **这是"把父会话漏进来的变量请出去"的唯一通道。** 没有它，用户配 `env`
   *    就只能**加**变量，没法删——而 `wt.exe` 会把调用方的整套环境原样转发进新标签页
   *    （§7.14 实测），"想删掉某一个"是真实需求，不是洁癖。
   *
   * 删的动作在 `buildSessionEnv()` 里做（那里才有"继承来的环境"），
   * 这里只负责**把它挑出来放进 `unset`**、并且**不写进 `env`**。
   *
   * @type {string[]}
   */
  const unset = [];
  for (const [k, v] of Object.entries(r.env.value ?? {})) {
    if (v === '') {
      unset.push(k);
      continue;
    }
    env[k] = v;
  }

  /** @type {Record<string, unknown>} */
  const topLevel = {};
  // ★ 受管区写的是**配置里那个模型**（`models[0]`），**不是**本次生效的模型。
  //
  //   `--model` 是"这一次只用它"（§2.5），走 `-c` 差量，绝不落盘。
  //   两种错法都要避开：
  //   · 写成本次的值 → 差量落盘了，下次不带 `--model` 再跑会把它改回去，
  //     cxt 自己制造一份"漂移"；
  //   · 干脆不写这条键 → 拼接器会把文件里原有的 `model = ...` **删掉**，
  //     于是"这一次换个模型"顺手抹掉了持久配置，同样要再跑一次才恢复。
  //
  //   正确做法是**两者分离**：受管区照常写配置值，本次覆盖交给 `-c`。
  const persistedModel = (r.models.value !== null && r.models.value.length > 0)
    ? currentModel(r.models.value)
    : null;
  if (persistedModel !== null) topLevel.model = persistedModel.id;
  topLevel.model_provider = r.providerId.value;
  // ★ 展开成绝对路径再交给拼接器转正斜杠（§2.11 三·1）。
  //
  //   为什么要展开：§2.4 的配置样例写的是 `~/.codex-multi-token/catalogs/...`，
  //   而 §7.5 原本只有一句"第三方观察：`model_catalog_json` **可能不支持** `~` 展开"，
  //   且这条失败是**静默**的（Codex 退回内置猜测，长会话里压缩时机不对）。
  //
  //   2026-10-17 用 `scripts/verify-real-codex.mjs` 在 0.163.0 上判成了事实：
  //   **它其实会展开 `~`**（判据用了 98765 这种绝不可能撞上默认值的数，
  //   并配了"指向不存在的文件读不到该值"的阴性对照）。
  //
  //   ⇒ 所以这一步是**保险，不是必需**：把"依赖 Codex 的版本行为"换成"我们自己的确定性变换"。
  //     一行代价，换掉一个静默失败面，值。别因为验出来"其实支持"就把它删掉。
  if (r.catalog.value !== null) {
    topLevel.model_catalog_json = expandTilde(r.catalog.value, home, platform);
  }

  const provider = {
    id: r.providerId.value,
    values: omitNulls({
      name: r.token.value ? `cxt ${r.token.value}` : 'cxt default',
      base_url: r.baseUrl.value,
      // ★ 只写变量名。值是进程环境注入的，**不落盘**（§2.2）
      env_key: r.envKeyName,
      wire_api: r.wireApi.value,
    }),
  };

  /** @type {string[]} */
  const args = [];

  // ★ `-C` 的入口分叉（§2.3 第五条）——**这是全表第二处按入口分叉的地方**
  //   （第一处是 `resolveCwd` 自己）。
  //
  //   | 入口 | 传 `-C` 吗 | 为什么 |
  //   |------|-----------|--------|
  //   | `run` | ✅ 总是传 | 终端的 cwd 参数**不保证生效**——§7.14⑤ 记着兜底路径
  //   |       |           | （`cmd /c start`）会丢 cwd。`-C` 是不依赖终端的那条信道，
  //   |       |           | 而 §2.5 的 `resume --last` 按 cwd 作用域，传错=静默续错会话 |
  //   | `exec`| ⚠️ 只在 `--cwd` 显式给出时 | 进程 pwd 本来就是对的，再传一遍是**净增风险**：
  //   |       |           | 这个值会经 cmd shim（§7.14⑥），白白多一次 `%VAR%` 展开面 |
  //
  //   `exec` 判据用 `source === SOURCE.CLI` 而不是"值不等于 pwd"——值相等与否是巧合，
  //   来源才是**用户有没有明说**这个事实。
  const cwdExplicit = r.entry === 'run' || r.cwd.source === SOURCE.CLI;
  if (cwdExplicit && r.cwd.value !== null && r.cwd.value !== undefined) {
    args.push('-C', r.cwd.value);
  }

  // ★ 启动前校验换掉的首位走**同一条** `-c` 差量（§2.5）：受管区写的是配置值，
  //   本次生效值不落盘。两条来源都要认——只认 `cli` 的话，校验挑出来的模型
  //   会只在受管区里生效，而那要等同步时序，**本次运行可能还没写**。
  if ((r.model.source === SOURCE.CLI || r.model.source === SOURCE.PREFLIGHT)
    && r.model.value !== null) {
    args.push('-c', `model=${r.model.value.id}`);
  }
  if (r.sandboxMode.value !== null) args.push('-c', `sandbox_mode=${r.sandboxMode.value}`);
  if (r.approvalPolicy.value !== null) args.push('-c', `approval_policy=${r.approvalPolicy.value}`);

  // ★ `-c` → `resume --last`（§2.5 模型故障切换的第二步）。
  //   **位置有讲究**：codex 的语法是 `codex [OPTIONS] <COMMAND> [ARGS]`，
  //   `resume` 就是那个 COMMAND，所以必须在全局选项**之后**、
  //   `codexArgs`（用户 `--` 透传的）**之前**——否则用户的透传参数会被
  //   当成 resume 的参数。
  if (r.resume === true) args.push('resume', '--last');

  if (r.codexArgs.value !== null) args.push(...r.codexArgs.value);

  return {
    profile,
    profileName: r.profileName,
    env,
    /**
     * ★ "cxt 明确决定不注入、所以继承来的值也不许顶上来"的变量名（§2.6）。
     * 今天只有一处来源：`env` 逃生舱里显式写了空串的键。**留着这个字段是为了接口形状**
     * ——净化必须有一条显式的"不注入"通道，否则将来加认证档位时会重蹈
     * "不注入 = 用继承来的"这个覆辙。
     */
    unset,
    /** 交给 `toml-splice.js` 的 `managedValues`（§2.9） */
    managedValues: { topLevel, provider },
    args,
    /** `cxt run` 的窗口标题：`cxt:<token>`（§2.3） */
    title: `cxt:${r.token.value ?? 'default'}`,
  };
}

// ───────────────────── 继承环境的净化（§2.6）─────────────────────

/**
 * ★ Codex 给自己子进程打的**会话标记**——描述"是哪个进程 / 哪个会话"，**不是配置**。
 *
 * 为什么必须剔：`wt.exe` 的交接桩**不吞环境变量**，它把调用方的环境**原样转发**
 * 给新标签页（§7.14 实测）。"不吞"对隔离测试是好消息，但它同时意味着
 * **"新终端 = 干净环境"是错的**——`cxt run` 从某个 codex 会话里被调用时，
 * 新标签页拿到的是那个会话的整套身份。
 *
 * 三处后果，按严重度排：
 * 1. `CODEX_SQLITE_HOME` 指向**别的** profile 的状态库 → 隔离不变量（§1.3 第 2 条）**静默失效**；
 * 2. `CXT_TOKEN_<别的 token>` → 两个 token 的密钥同时躺在同一个进程环境里（见下面那个前缀）；
 * 3. `CODEX_SESSION_ID` / `CODEX_THREAD_ID` / `CODEX_TOOL_CALL_ID` → 新会话顶着父会话的身份。
 *
 * **明确不在表里的两个**（别"顺手"加进来）：
 * - `CODEX_HOME` —— 它是 cxt **自己的**注入项（身份隔离，§2.2），不是 codex 打的标记。
 *   它会被 `injection.env` 重新盖上，剔它属于"把承重原语当噪声"。
 * - `CODEX_MANAGED_BY_NPM` / `CODEX_MANAGED_PACKAGE_ROOT` —— npm 全局安装的转发脚本
 *   （`codex.cmd`）加的，描述"codex 装在哪"，是**配置**不是身份。
 *
 * > **判据（将来加新标记照这条判）：值描述的是*某一个正在跑的进程 / 会话*——
 * > PID、会话 id、thread id、管道、端口、快照、记录路径——就**剔**；
 * > 值是*配置*（模型、沙箱档位、安装位置、开关）就**留**，那属于 cxt 该管的，该管的会覆盖它。**
 *
 * ⚠️ **名单的来源**：从 `codex.exe` 里提取的 `CODEX_*` 字符串全集，逐个按上面那条判据筛。
 * "codex 读这个变量"与"codex 把它导出给子进程"是两件事，本机没有可靠手段把后者单独测出来
 * （`codex sandbox <cmd>` 探针只回 npm 转发脚本加的那两个）。所以**按"宁可多剔"取**：
 * 多剔一个配置类变量的代价是它被 `injection.env` 盖回来，漏剔一个身份变量的代价是隔离静默失效——
 * 两边不对称。
 */
export const SESSION_MARKER_ENV = Object.freeze([
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_TOOL_CALL_ID',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
  'CODEX_SANDBOX_LAUNCH_COUNT',
  'CODEX_STARTING_DIFF',
  'CODEX_SNAPSHOT',
  'CODEX_ROLLOUT_TRACE_ROOT',
  'CODEX_TUI_RECORD_SESSION',
  'CODEX_DAEMON_JUNCTION_LINK',
  'CODEX_PERMISSION_PROFILE',
  'CODEX_SQLITE_HOME',
  // ★ cxt **自己**的在场标记（§2.16）：父会话的会话 id。嵌套 `cxt run` 若带着它，
  //   新窗口的 `msg send` 会把 `from` 认成父会话——剔掉，新窗口的 exec 会生成自己的。
  'CXT_SESSION_ID',
]);

/**
 * cxt **自己的**凭证命名空间（§2.6 开头的生成规则：`CXT_TOKEN_` + token 名大写）。
 *
 * **整族清掉，不逐个列名**——同时只允许存在**当前 token** 的那一个。
 * 列名做不到这件事：token 名是用户起的，无边界；而前缀是 cxt 自己的命名空间，
 * 一个 `startsWith` 就够。清完之后 `injection.env` 会把正确的那一个盖回来。
 */
export const CREDENTIAL_ENV_PREFIX = 'CXT_TOKEN_';

/**
 * 剔掉会话标记与**别的 token 的**凭证，返回一份可以安全继承的环境。
 *
 * ⚠️ **返回新对象，绝不改入参**——这不是洁癖：`cli/main.js` 的 `makeCtx()` 传进来的
 * `ctx.env` **就是 `process.env` 本身**（按引用）。就地 `delete` 会把 **cxt 自己的**
 * 进程环境改掉，之后所有命令、所有 spawn 都在一个被悄悄动过的环境里跑。
 *
 * @param {Record<string, string | undefined> | null | undefined} env
 * @returns {Record<string, string | undefined>}
 */
export function stripSessionMarkers(env) {
  /** @type {Record<string, string | undefined>} */
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (SESSION_MARKER_ENV.includes(k)) continue;
    if (k.startsWith(CREDENTIAL_ENV_PREFIX)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * ★ **继承环境 → 这个会话真正要跑的环境**（§2.6）。这是净化的唯一出口。
 *
 * ```
 * 新会话环境 = 继承环境（剔掉会话标记） → 删掉 cxt 明确不注入的项（unset） → 盖上注入项
 * ```
 *
 * **顺序要紧：先删，再盖。** `injection.env` 永远最后生效，所以 `env` 逃生舱
 * 能盖回来任何一项——包括上面刚被剔掉的会话标记（用户显式配了就是显式要）。
 *
 * **核心不变量：`cxt run` / `cxt exec` 的结果，不许取决于它是从哪儿被调用的。**
 * 换句话说：`base` 取"干净环境"还是"从某个 codex 会话里继承来的环境"，
 * 本函数的结果必须**逐字节相同**。这条有测试直接钉着（§6.3）。
 *
 * ⚠️ `cxt run` **只剔标记，不盖注入项**——它调的是 `stripSessionMarkers()` 而不是本函数。
 * 标签页的环境只是个**载体**：往里面塞 `injection.env` 等于让 token 在窗口的 shell 里
 * 多出一份，还把求值点从"新窗口里"挪到了"`cxt run` 这一侧"（§2.4 铁律）。
 *
 * @param {object} input
 * @param {Record<string, string | undefined> | null | undefined} input.base 继承来的环境（通常就是 `ctx.env`）
 * @param {{ env: Record<string, string>, unset: string[] }} input.injection `buildInjection()` 的产物
 * @returns {Record<string, string>}
 */
export function buildSessionEnv({ base, injection }) {
  const env = stripSessionMarkers(base);
  for (const k of injection.unset) delete env[k];
  return /** @type {Record<string, string>} */ ({ ...env, ...injection.env });
}
