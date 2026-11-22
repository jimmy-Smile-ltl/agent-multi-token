// @ts-check
/**
 * `cmt resolve` —— ★ 排查神器（§5）。
 *
 * 一眼看出"为什么这个目录用了这个 token"，因为**每项都标了来源层**。
 *
 * 它同时是**整条解析链的验证入口**（§4.4 第 6 步刻意排在终端探测之前）：
 * 不需要终端、不需要真的启动 claude，就能把 §2.3 的级联跑完并展示出来。
 *
 * 输出分四段：身份 → 四要素 → 将要注入 → 命令行。
 * `--json` 给脚本消费（也是 e2e 冒烟测试的断言载体）。
 *
 * **退出码永远是 0**——这是诊断命令，四要素不齐也要把话说完整。
 * 脚本要看结论就读 `--json` 的 `.ok`。
 */
import { canonicalPath, findNearMisses } from '../../core/bindings.js';
import { EXIT } from '../../core/errors.js';
import { formatModel } from '../../core/models.js';
import { orderCandidates } from '../../core/pool.js';
import { loadConfig, loadToken } from '../../core/store.js';
import { renderMissing, validateSession } from '../../core/validate.js';
import { fieldText, maskEnv, modelsState, renderRows, sourceTag } from '../format.js';
import { loadPool } from '../pool-store.js';
import { pickOverrides, prepareSession } from '../session.js';

/** 四要素的展示名 → `validateSession()` 的 key（两处文案解耦，靠这张表对齐） */
const ELEMENT_KEY = {
  本地路径: 'cwd',
  token: 'token',
  apiUrl: 'apiUrl',
  model: 'model',
};

export const resolveCommand = {
  spec: /** @type {any} */ ({
    boolean: ['json', 'help'],
    string: ['token', 'cwd', 'model', 'url', 'token-value', 'auth-mode'],
    alias: { h: 'help' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    if (args.help) {
      process.stdout.write(RESOLVE_HELP);
      return EXIT.OK;
    }

    // 位置参数 = 要解析的目录；不给就用当前目录
    const explicitCwd = args._[0] ?? args.cwd;
    const matchTarget = explicitCwd ?? ctx.cwd;
    const overrides = pickOverrides(args, explicitCwd);

    // 装配走的是 `run` / `exec` 的**同一条路径**——所以这里看到的，
    // 就是那两者真正会用的（§2.7："看到的"必须等于"跑起来的"）
    const { resolved, injection, check, configFile, configExists, tokenExists } = prepareSession({
      ctx,
      target: matchTarget,
      overrides,
    });

    // 没匹配上任何绑定、但存在"看着就是同一个目录"的绑定时，把两个串都摆出来。
    // 不做这一步的话，用户只会看到一句「绑定（无）」，然后对着 `cmt bind ls` 里
    // 那条一模一样的路径发呆——差在哪个字符全靠肉眼找（实测踩过：Windows 8.3 短名）。
    const { config } = loadConfig({ home: ctx.home });
    const nearMisses = resolved.binding
      ? []
      : findNearMisses(config.bindings, matchTarget, ctx).map((/** @type {any} */ b) => ({
          path: b.path,
          normalized: canonicalPath(b.path, ctx),
        }));

    if (args.json) {
      const payload = toJson({ resolved, injection, check, ctx, nearMisses });
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return EXIT.OK;
    }

    const report = render({
      resolved,
      injection,
      check,
      configFile,
      configExists,
      tokenExists,
      nearMisses,
      // ★ 池能不能补上 token 这一格（§2.13 三）：**只提示、不挑**——
      //   探测要发一次真实请求（会花钱），而 resolve 存在的理由正是
      //   "不碰网络就能看清为什么"。真挑发生在 `cmt run`。
      poolHint: resolved.tokenName.value === null ? poolHint(ctx) : null,
    });
    process.stdout.write(`${report}\n`);
    return EXIT.OK;
  },
};

const RESOLVE_HELP = `cmt resolve [<path>] [选项]

打印 <path>（默认当前目录）解析出的四要素与每一项的来源层，token 自动打码。
不启动任何东西，纯诊断——四要素不齐也照样输出，退出码仍是 0。

选项
  --token <name>        当作指定了 token 名来解析（不改任何配置）
  --cwd <path>          当作在该目录下运行（参与绑定匹配）
  --model <id>          当作传了 --model
  --url <u>             当作传了 --url
  --token-value <v>     当作传了 --token-value
  --auth-mode token|key 当作传了 --auth-mode
  --json                机器可读输出（含 .ok / .missing，供脚本判断）
`;

// ───────────────────────────── --json ─────────────────────────────

/**
 * 结构化输出。
 *
 * ⚠️ 脱敏规则（§5）对 `--json` **一样生效**——它是给人贴到 issue 里的主要形态。
 * 引用型保留 `${VAR}` 原文（引用不是秘密，值才是），`authToken` 与 `baseUrl` 同理。
 * 两者唯一的差别：`authToken.value` 是**展示串**（明文会被打码），
 * 而 `baseUrl.value` 是**原样值**——端点不是秘密，脚本要拿它直接用。
 * @param {any} p
 */
function toJson({ resolved, injection, check, ctx, nearMisses }) {
  return {
    ok: check.ok,
    missing: check.missing,
    home: ctx.home,
    cwd: resolved.cwd,
    cwdNormalized: resolved.cwdNormalized,
    tokenName: resolved.tokenName,
    binding: resolved.binding ? { path: resolved.binding.path } : null,
    nearMisses,
    elements: {
      cwd: resolved.cwd,
      authToken: {
        source: resolved.authToken.source,
        detail: resolved.authToken.detail,
        ref: resolved.authToken.ref,
        value: fieldText(resolved.authToken, { mask: true }),
      },
      baseUrl: resolved.baseUrl,
      model: {
        ...resolved.models,
        value: resolved.models.value.map((/** @type {any} */ m) => m.id),
      },
    },
    authMode: resolved.authMode,
    slots: resolved.slots,
    claudeArgs: resolved.claudeArgs,
    terminalMode: resolved.terminalMode,
    env: maskEnv(injection.env),
    unset: injection.unset,
    args: injection.args,
    unresolved: injection.unresolved,
    warnings: [...resolved.warnings, ...injection.warnings],
  };
}

// ───────────────────────────── 人类可读 ─────────────────────────────

/**
 * 池能不能补上 token 那一格的一句话（§2.13 三）。**不探测、不发请求。**
 *
 * 只数本地条目：`orderCandidates()` 会滤掉 `no_quota` / `invalid` 这些硬排除项，
 * 所以"可挑"说的是"按已知状态还有几个能试"，不是"现在一定有额度"——
 * 那一句话只有探测能回答，而探测不在这个命令里。
 *
 * @param {import('../types.js').Ctx} ctx
 * @returns {string | null} 池是空的时候返回 `null`（没什么可提示的）
 */
function poolHint(ctx) {
  const { pool } = loadPool(ctx);
  const total = Object.keys(pool.entries).length;
  if (total === 0) return null;
  const pickable = orderCandidates(pool.entries).length;
  return `token 池：${pickable} 个可挑（共 ${total} 个条目）——`
    + '`cmt run --pool` 会在启动前挑一个';
}

/**
 * @param {any} p
 */
function render({ resolved, injection, check, configFile, configExists, tokenExists, nearMisses, poolHint: hint }) {
  /** @type {string[]} */
  const out = [''];
  const near = nearMisses ?? [];

  // ── 段一：身份（谁、在哪、为什么）────────────────────────────────
  /** @type {[string, string][]} */
  const idRows = [['目录', resolved.cwd.value]];
  if (resolved.cwdNormalized !== resolved.cwd.value) {
    // §2.9 三：绑定按归一化串匹配，所以两个串都印出来供对照
    idRows.push(['', `（归一化 ${resolved.cwdNormalized}，绑定按这个串匹配）`]);
  }
  idRows.push(['绑定', resolved.binding ? resolved.binding.path : '（无）']);
  // ★ §2.11 一：**是哪一份** `.cmt.json` 赢了，和"命中绑定"一样必须印出来。
  //   只写「来源：项目本地」等于没说——用户的机器上可能有好几份（"最近优先"），
  //   而"我改的那份没生效"正是这个功能最容易踩的坑。
  if (resolved.projectPath !== null) {
    idRows.push(['项目本地配置', resolved.projectPath]);
  }
  // 末段相同、整串不同 —— 极可能是同一个目录的另一种写法（8.3 短名 / 大小写）。
  // 这种失败**静默且费解**，所以宁可多印两行，也别让用户自己去逐个字符对。
  for (const nm of near) {
    idRows.push(['', `⚠ 这条绑定的末段相同、整串却对不上：`]);
    idRows.push(['', `    ${nm.path}`]);
    idRows.push(['', `    归一化 ${nm.normalized}   ← 与上面的归一化目录逐字符比一比`]);
  }
  idRows.push([
    'token',
    resolved.tokenName.value
      ? `${resolved.tokenName.value}${tokenExists ? '' : '   ⚠ 文件不存在'}`
      : '（无 —— 纯 defaults 模式，profile 用 _default）',
  ]);
  idRows.push(['来源', sourceTag(resolved.tokenName)]);
  out.push(renderRows(idRows));

  // ── 段二：四要素 ────────────────────────────────────────────────
  out.push('');
  out.push('四要素');
  const missingKeys = new Set(check.missing.map((/** @type {any} */ m) => m.key));
  /** @type {[string, string][]} */
  const elRows = [
    ['本地路径', resolved.cwd.value, sourceTag(resolved.cwd)],
    ['token', fieldText(resolved.authToken, { mask: true }), sourceTag(resolved.authToken)],
    ['apiUrl', fieldText(resolved.baseUrl), sourceTag(resolved.baseUrl)],
    ['model', modelText(resolved), sourceTag(resolved.models)],
  ].map(([label, value, tag]) => {
    const key = ELEMENT_KEY[label];
    const mark = missingKeys.has(key) ? '✗' : '✓';
    return [`${mark} ${label}`, `${value}   ${tag}`];
  });
  out.push(renderRows(elRows));
  // ★ 「token 缺了」是最常见的一次 resolve，而池恰恰是这个缺项的答案——
  //   不说这一句，用户只会去翻 `cmt token add` 的用法，不知道手上已经有一池子 key（§2.13 三·4）。
  if (hint) out.push(`  ℹ ${hint}`);

  // ── 段三：将要注入 ──────────────────────────────────────────────
  out.push('');
  out.push('将要注入');
  out.push(renderRows(Object.entries(maskEnv(injection.env))));
  for (const u of injection.unresolved) {
    out.push(`  ⚠ ${u.envVar} 未注入：${u.reason}`);
  }
  // 只有"将要加什么"是不够的：环境是**继承**来的，读者还得知道 cmt 会**删**什么——
  // 否则"我明明没配 ANTHROPIC_MODEL，它从哪来的"这个问题无从回答（§2.6 / §5）。
  if (injection.unset.length > 0) {
    out.push('');
    out.push('将从继承的环境里删掉');
    out.push(`  ${injection.unset.join('  ')}`);
  }

  // ── 段四：命令行 ────────────────────────────────────────────────
  out.push('');
  out.push('命令行');
  out.push(`  claude ${injection.args.map(quoteIfNeeded).join(' ')}`.trimEnd());

  // ── 收尾：警告与下一步 ──────────────────────────────────────────
  const notes = [...resolved.warnings, ...injection.warnings];
  if (notes.length > 0) {
    out.push('');
    for (const n of notes) out.push(`  ⚠ ${n}`);
  }
  if (!configExists) {
    out.push('');
    out.push(`  ℹ 还没有配置文件（${configFile}）——用 \`cmt token add\` / \`cmt bind\` 建一个`);
  }
  if (!check.ok) {
    out.push('');
    // 缺项提示统一由 validate.js 出（含"下一步敲什么命令"，§6.2）
    out.push(indent(renderMissing(check.missing)));
  }
  out.push('');
  return out.join('\n');
}

/**
 * @param {any} resolved
 */
function modelText(resolved) {
  // 三种状态的判定统一走 modelsState（format.js）——别再就地写 `value.length` 判断，
  // 那正是 doctor 把「没声明」印成「显式空」的老 bug 来源。
  const state = modelsState(resolved.models);
  if (state === 'missing') return '（缺 —— 没有任何一层声明 models）';
  // §2.5 规则 3：显式空 = 合法，不是缺项
  if (state === 'empty') return '（显式空：不注入，用 Claude Code 自身默认）';
  const list = resolved.models.value;
  const head = formatModel(list[0]);
  return list.length > 1 ? `${head}   （另有 ${list.length - 1} 个候选）` : head;
}

/**
 * @param {string} s
 */
function quoteIfNeeded(s) {
  return /[\s"']/.test(s) ? JSON.stringify(s) : s;
}

/**
 * @param {string} text
 * @param {string} [pad]
 */
function indent(text, pad = '  ') {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}
