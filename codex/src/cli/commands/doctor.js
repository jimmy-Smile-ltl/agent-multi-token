// @ts-check
/**
 * `cxt doctor` —— 自检（§5）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它在链条上的位置
 *
 * `resolve` / `exec` / `run` 都**假设**环境是好的：codex 在、终端能开、
 * 配置没漂移、这个目录被信任过。假设错了，它们各自用一种难懂的方式失败
 * （窗口一闪而过 / codex 卡在信任提问 / 静默走默认 provider）。
 *
 * doctor 就是**把那些假设逐条问出来**。所以它的价值不在"报告问题"，
 * 而在**把"隐式假设"变成"显式的一行"**——尤其那些**静默**的：
 * AGENTS.md 被截断、信任写法不对、项目级键被丢弃，三者都不报错。
 *
 * ## 分工：判定在 core，采集在这里
 *
 * 判定逻辑全在 `core/doctor.js`（纯函数，可测）；本文件只做**采集**——
 * 读文件、探二进制、拼上下文。理由是 §4.2：`core/` 里只有 `store.js` 碰 fs。
 *
 * ## 退出码只有两种
 *
 * `0` = 没发现阻塞项（**warn 不算**——那是用户仓库的事，不是 cxt 坏了）；
 * `2` = 有阻塞项。把 warn 也算进去的话，用户会学会无视 doctor。
 * ─────────────────────────────────────────────────────────────
 */

import { posix, win32 } from 'node:path';

import {
  CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES,
  checkBom,
  checkDanglingBindings,
  checkDocTruncation,
  checkProjectLocalIgnoredKeys,
  checkShortName,
  checkTrustState,
  parseProjectDocMaxBytes,
  summarize,
} from '../../core/doctor.js';
import { CxtError, EXIT, renderError } from '../../core/errors.js';
import {
  DEFAULT_PROFILE_NAME,
  PROJECT_DOC_FILENAMES,
  configPath,
  launchScriptPath,
  profileConfigPath,
  projectLocalConfigPath,
} from '../../core/paths.js';
import { fileSize, readProfileConfig, readTextIfExists } from '../../core/store.js';
import { readTrust } from '../../core/trust.js';
import { detectTerminal } from '../../platform/index.js';
import { detectCodexBin } from '../codex-bin.js';
import { makePainter } from '../format.js';
import { loadState, managedRegionDiff, resolveSession } from '../session.js';

/** §6.1：Node ≥ 18 */
const MIN_NODE_MAJOR = 18;

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'json'],
  string: ['cwd'],
  alias: { h: 'help' },
};

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
export async function run(args, ctx) {
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const cwd = typeof args.cwd === 'string' && args.cwd !== '' ? args.cwd : ctx.cwd;
  const findings = collect(ctx, cwd);
  const { counts, exitCode, hasError } = summarize(findings);

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: !hasError,
      cwd,
      home: ctx.home,
      counts,
      findings,
    }, null, 2)}\n`);
    return exitCode;
  }

  process.stdout.write(renderHuman(findings, { counts, cwd, ctx }));
  return exitCode;
}

// ───────────────────────────── 采集 ─────────────────────────────

/**
 * 把所有检查跑一遍。**永不抛**——每条检查自己的失败也是一条 finding
 * （doctor 崩掉的话，用户就失去了唯一能告诉他"哪里坏了"的工具）。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {string} cwd
 * @returns {import('../../core/doctor.js').Finding[]}
 */
function collect(ctx, cwd) {
  /** @type {import('../../core/doctor.js').Finding[]} */
  const findings = [];
  /** @param {any} f finding / finding 数组 / null */
  const push = (f) => {
    if (!f) return;
    if (Array.isArray(f)) findings.push(...f);
    else findings.push(f);
  };

  push(checkNode());
  push(checkCodex(ctx));

  // ── 读状态。★ 这里也必须 try：`config.json` 坏掉 / 版本比本程序新 /
  //    token 文件不是合法 JSON，都会在**读**的时候抛（§3.5）。
  //    让 doctor 在这种时候崩掉，等于"用户唯一能问诊的工具，恰好在最需要它时没了"。
  /** @type {any} */
  let config = { defaults: {}, bindings: [] };
  /** @type {Record<string, any>} */
  let tokens = {};
  try {
    const state = loadState(ctx);
    config = state.config;
    tokens = state.tokens;
  } catch (err) {
    push({
      id: 'state-unreadable',
      level: 'error',
      title: `读不出 cxt 的配置：${err instanceof Error ? err.message : String(err)}`,
      detail: '这之后的所有检查都会按"没有 token、没有绑定"来跑，'
        + '所以它们的结论仅供参考——**先修好这一条**。',
      hint: err instanceof CxtError ? err.hint : '检查 config.json 与 tokens/*.json 是不是合法 JSON',
    });
  }
  const tokenNames = Object.keys(tokens);

  // ── 解析（后面的检查大半要它算出的 profileName）──
  /** @type {any} */
  let resolved = null;
  try {
    resolved = resolveSession(ctx, {}, 'run', { path: cwd });
    push(checkResolution(resolved, cwd, tokenNames.length));
  } catch (err) {
    push({
      id: 'resolve-failed',
      level: 'error',
      title: `解析不出这个目录的会话：${err instanceof Error ? err.message : String(err)}`,
      hint: err instanceof CxtError ? err.hint : '`cxt resolve` 能看到更多',
      data: { cwd },
    });
  }

  const profileName = resolved?.profileName ?? DEFAULT_PROFILE_NAME;
  const cfgPath = profileConfigPath(ctx.home, profileName);
  const cfgText = readProfileConfig(ctx.home, profileName);
  const cfgExists = fileSize(cfgPath) !== null;

  push(checkTerminal(ctx, resolved, cwd, profileName));
  push(checkBindings(config, tokenNames));
  push(checkManagedRegion(ctx, resolved, cfgPath, cfgText, cfgExists));
  push(checkTrust(cfgText, cwd, ctx.platform));
  push(checkDoc(ctx, cwd, cfgText));
  push(checkProjectConfig(ctx, cwd));
  push(checkShortName(cwd, ctx.platform));

  return findings;
}

/** @returns {import('../../core/doctor.js').Finding} */
function checkNode() {
  const version = process.versions.node;
  const major = Number.parseInt(version.split('.')[0], 10);
  const ok = Number.isFinite(major) && major >= MIN_NODE_MAJOR;
  return {
    id: 'node',
    level: ok ? 'ok' : 'error',
    title: `node ${version}${ok ? '' : `（需要 ≥ ${MIN_NODE_MAJOR}）`}`,
    detail: process.execPath,
    hint: ok ? undefined : `升级 Node 到 ${MIN_NODE_MAJOR} 或更高`,
    data: { version, execPath: process.execPath, minMajor: MIN_NODE_MAJOR },
  };
}

/**
 * @param {import('../types.js').Ctx} ctx
 * @returns {import('../../core/doctor.js').Finding}
 */
function checkCodex(ctx) {
  const r = detectCodexBin(ctx);
  if (r.ok) {
    return {
      id: 'codex',
      level: 'ok',
      title: `codex 找到了（定位档 ${r.level}）：${r.path}`,
      detail: r.shim
        ? '★ 是 `.cmd`，要经 `cmd.exe /d /s /c` 调起——Node 18.20+/20.12+ 出于 '
          + 'CVE-2024-27980 会拒绝直接 spawn 它（§7.14⑥）。cxt 已经这么做了。'
        : undefined,
      data: { path: r.path, level: r.level, shim: r.shim },
    };
  }
  return {
    id: 'codex',
    level: 'error',
    title: `找不到 codex：${r.message}`,
    detail: ['找过这些位置：', ...r.tried.map((t) => `  ${t}`)].join('\n'),
    hint: `装它：\`npm i -g @openai/codex\`；或在本机 ${configPath(ctx.home)} 的 `
      + 'defaults.codexBin 里写绝对路径',
    data: { tried: r.tried },
  };
}

/**
 * @param {import('../types.js').Ctx} ctx
 * @param {any} resolved
 * @param {string} cwd
 * @param {string} profileName
 * @returns {import('../../core/doctor.js').Finding}
 */
function checkTerminal(ctx, resolved, cwd, profileName) {
  const scriptPath = launchScriptPath(ctx.home, profileName, ctx.platform);
  const title = `cxt:${resolved?.token?.value ?? 'default'} · ${cwd}`;
  // ⚠️ `detectTerminal` 内部固定用 `mode: 'tab'` 探测（它只回答"走哪条路"，
  //    不回答"用户这次想要窗口还是标签页"）。所以下面报的是**配置里那个默认值**，
  //    并说明 `--window` / `--tab` 能覆盖它——把探测用的 tab 说成"你这次会开标签页"
  //    就是在报告一个我们没测过的东西。
  const mode = resolved?.terminalMode?.value ?? 'tab';
  const r = detectTerminal({ title, cwd, scriptPath, platform: ctx.platform, env: ctx.env });

  if (r.ok) {
    /** @type {string[]} */
    const notes = [];
    notes.push(`本次默认模式：${mode}（探测固定按 tab 走，\`--window\` / \`--tab\` 可覆盖）`);
    if (r.spec.via === 'script') {
      notes.push(`这条路径只吃命令串 → 会先落盘兜底脚本 ${scriptPath}（§2.12）`);
    }
    for (const w of r.spec.warnings ?? []) notes.push(w);

    return {
      id: 'terminal',
      level: 'ok',
      title: `终端可用：${r.spec.terminal}（via ${r.spec.via}）`,
      detail: notes.join('\n'),
      data: { terminal: r.spec.terminal, via: r.spec.via, mode, warnings: r.spec.warnings ?? [] },
    };
  }
  return {
    id: 'terminal',
    level: 'error',
    title: `终端探测失败：${r.message}`,
    detail: ['试过这些：', ...r.tried.map((t) => `  ${t}`)].join('\n'),
    hint: '`cxt exec` 不依赖终端，可以先在**当前**终端里用它；'
      + '`cxt run` 要弹窗口，需要 wt / cmd / Terminal.app 之一',
    data: { tried: r.tried },
  };
}

/**
 * 四要素完整性（§2.1）。
 *
 * ★ **"一个 token 都没有"与"有 token 但这个目录解析不出来"必须分开报**：
 * 前者是刚装好还没配（`info`，不是故障），后者才是真的会拦路（`error`）。
 * 混成一条的话，新装用户第一次跑 doctor 就看到一个红色错误——那是**狼来了**，
 * 而 doctor 最怕的就是用户学会无视它。
 *
 * @param {any} resolved
 * @param {string} cwd
 * @param {number} tokenCount
 * @returns {import('../../core/doctor.js').Finding}
 */
function checkResolution(resolved, cwd, tokenCount) {
  const missing = resolved.missing ?? [];
  const sources = {
    cwd: resolved.cwd.source,
    authToken: resolved.authToken.source,
    baseUrl: resolved.baseUrl.source,
    model: resolved.model.source,
  };

  if (missing.length === 0) {
    return {
      id: 'four-elements',
      level: 'ok',
      title: `四要素齐全（token：${resolved.token.value ?? '纯 defaults 模式'}，profile：${resolved.profileName}）`,
      detail: Object.entries(sources).map(([k, v]) => `${k} ← ${v}`).join('、'),
      data: { sources, token: resolved.token.value, profileName: resolved.profileName },
    };
  }

  const noTokens = tokenCount === 0;
  return {
    id: 'four-elements',
    level: noTokens ? 'info' : 'error',
    title: noTokens
      ? '还没有任何 token——四要素暂时无处可解析（这不是故障，是还没配）'
      : `四要素不齐全，缺少：${missing.join('、')}`,
    detail: `在 ${cwd} 下解析：`
      + Object.entries(sources).map(([k, v]) => `${k} ← ${v}`).join('、'),
    hint: noTokens
      ? '`cxt token add <名字> --token <key> --base-url <url>` 建一个，然后 `cxt run <名字>`'
      : '`cxt resolve` 会逐项列出**每一项的来源层**，一眼看出该补哪一层',
    data: { missing, sources, cwd, tokenCount },
  };
}

/**
 * @param {any} config
 * @param {string[]} tokenNames
 * @returns {import('../../core/doctor.js').Finding[]}
 */
function checkBindings(config, tokenNames) {
  return checkDanglingBindings({ bindings: config?.bindings ?? [], tokenNames });
}

/**
 * 受管区：存在性 + BOM + 漂移（§2.9 / §7.14①）。
 *
 * @returns {import('../../core/doctor.js').Finding[]}
 */
function checkManagedRegion(ctx, resolved, cfgPath, cfgText, cfgExists) {
  /** @type {import('../../core/doctor.js').Finding[]} */
  const out = [];

  if (!cfgExists) {
    out.push({
      id: 'managed-region-absent',
      level: 'info',
      title: `受管区尚未创建：${cfgPath}`,
      detail: '这是正常的——首次 `cxt exec` / `cxt run` 才会建（§3.2：惰性，绝不预建空目录）。',
      data: { path: cfgPath },
    });
    return out;
  }

  out.push(checkBom({ text: cfgText, path: cfgPath }));

  if (resolved === null) return out;

  try {
    const diff = managedRegionDiff(ctx, resolved);
    if (diff.changed) {
      out.push({
        id: 'managed-region-drift',
        level: 'warn',
        title: '受管区与预期不一致（漂移）',
        detail: '把受管值重新拼一遍，得到的文本与盘上的不同——说明文件被手工改过，'
          + '或者 cxt 的拼接逻辑变了。**下一次 exec 会就地修正它**，'
          + '`[projects.*]` 一条都不会动（§2.9 铁律 2）。',
        hint: '想先看看差在哪：`cxt run <token> --print`',
        data: { path: cfgPath, report: diff.report },
      });
    } else {
      out.push({
        id: 'managed-region-ok',
        level: 'ok',
        title: '受管区与预期一致（幂等）',
        data: { path: cfgPath },
      });
    }
  } catch (err) {
    out.push({
      id: 'managed-region-error',
      level: 'error',
      title: `受管区拼接失败：${err instanceof Error ? err.message : String(err)}`,
      detail: '这类错误**绝不能放过**——写下去的就是一份语义可疑的配置，'
        + '而双作者文件被写坏是不可逆的（§2.9）。cxt 会拒绝写，直到原因消除。',
      hint: err instanceof CxtError ? err.hint : `检查 ${cfgPath} 里受管键有没有重复出现`,
      data: { path: cfgPath },
    });
  }

  return out;
}

/**
 * 信任三态（§7.3 / §7.6）。
 * @returns {import('../../core/doctor.js').Finding[]}
 */
function checkTrust(cfgText, cwd, platform) {
  try {
    const r = readTrust(cfgText, cwd, platform);
    return checkTrustState({ state: r.state, path: cwd, nearMisses: r.nearMisses });
  } catch (err) {
    return [{
      id: 'trust-unreadable',
      level: 'warn',
      title: `读不出信任记录：${err instanceof Error ? err.message : String(err)}`,
      hint: '受管区文件本身可能坏了——上面「受管区拼接失败」那条会说明原因',
    }];
  }
}

/**
 * ★ AGENTS.md 截断（§7.11）——本命令最要紧的一条。
 *
 * 三件事各自都要对：
 * 1. **文档大小从磁盘读**（`fileSize` 给的是**字节**）——一个数字都不许写死（§7.11）；
 * 2. **上限从配置读**，读不到才用 Codex 的默认值（§5）；
 * 3. **比字节不比字符**（§6.3）——中文一字三字节，`.length` 会算出三分之一的假安全值。
 *
 * @returns {import('../../core/doctor.js').Finding[]}
 */
function checkDoc(ctx, cwd, cfgText) {
  /** @type {import('../../core/doctor.js').Finding[]} */
  const out = [];
  const maxInfo = parseProjectDocMaxBytes(cfgText);

  const docPath = findDocUpward(cwd, ctx.platform);
  const docBytes = docPath === null ? null : fileSize(docPath);

  const finding = checkDocTruncation({
    docBytes,
    docPath,
    maxBytes: maxInfo.present && !maxInfo.malformed
      ? maxInfo.value
      : CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES,
    maxBytesSource: maxInfo.malformed ? 'malformed' : (maxInfo.present ? 'config' : 'default'),
  });
  if (finding) out.push(finding);

  if (docPath === null && !maxInfo.malformed) {
    out.push({
      id: 'doc-absent',
      level: 'info',
      title: `从 ${cwd} 向上没找到 AGENTS.md`,
      detail: `找的是 ${PROJECT_DOC_FILENAMES.join(' / ')}——Codex 读项目根的那一份，`
        + '而这里是从 cwd 向上找最近的一份（多数时候是同一个文件）。',
      data: { cwd, names: [...PROJECT_DOC_FILENAMES] },
    });
  }

  return out;
}

/**
 * 项目级 `.codex/config.toml` 的禁区键（§7.3）——**只读不写**。
 * @returns {import('../../core/doctor.js').Finding | null}
 */
function checkProjectConfig(ctx, cwd) {
  const p = projectLocalConfigPath(cwd, ctx.platform);
  const text = readTextIfExists(p);
  return checkProjectLocalIgnoredKeys(text === null ? null : { text, path: p });
}

/**
 * 从 `cwd` 向上找最近的一份项目文档（§7.11）。
 *
 * ⚠️ **这是近似，不是 Codex 的算法**：Codex 读的是 `project_root_markers`
 * （默认 `.git`）定出的**项目根**那一份。这里从 cwd 逐级向上、谁先有就用谁——
 * 好处是不用解析 `.git`（一个目录可以是 git 仓库的子目录却不在根上），
 * 坏处是在嵌套仓库里可能指到另一份。所以报出来的是**我们实际查的那个路径**，
 * 用户能自己判断；`doc-absent` 那条也把这件事写明了。
 *
 * @param {string} cwd
 * @param {NodeJS.Platform} platform
 * @returns {string | null}
 */
function findDocUpward(cwd, platform) {
  const { dirname, join } = platform === 'win32' ? win32 : posix;

  let dir = cwd;
  // 上限只是防御性的：正常路径几级就到根了，而畸形输入不该把 doctor 挂住
  for (let i = 0; i < 64; i++) {
    for (const name of PROJECT_DOC_FILENAMES) {
      const p = join(dir, name);
      if (fileSize(p) !== null) return p;
    }
    const parent = dirname(dir);
    if (parent === dir || parent === '') return null;
    dir = parent;
  }
  return null;
}

// ───────────────────────────── 渲染 ─────────────────────────────

/** 级别 → 图标与颜色键。顺序即渲染顺序。 */
const LEVEL_ORDER = ['error', 'warn', 'info', 'ok'];
const LEVEL_ICON = { error: '✗', warn: '⚠', info: '·', ok: '✓' };
const LEVEL_COLOR = { error: 'red', warn: 'yellow', info: 'dim', ok: 'green' };

/**
 * @param {import('../../core/doctor.js').Finding[]} findings
 * @param {{ counts: Record<string, number>, cwd: string, ctx: import('../types.js').Ctx }} p
 * @returns {string}
 */
function renderHuman(findings, p) {
  const { counts, cwd, ctx } = p;
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  /** @type {string[]} */
  const out = [''];

  out.push(`  ${c.bold('cxt doctor')}  ${c.dim(`— ${cwd}`)}`);
  out.push('');

  for (const level of LEVEL_ORDER) {
    const group = findings.filter((f) => f.level === level);
    if (group.length === 0) continue;
    const paint = /** @type {(s: string) => string} */ (c[LEVEL_COLOR[level]]);
    for (const f of group) {
      out.push(`  ${paint(LEVEL_ICON[level])} ${f.title}`);
      if (f.detail) for (const line of String(f.detail).split('\n')) out.push(`      ${c.dim(line)}`);
      if (f.hint) out.push(`      ${c.dim('→')} ${f.hint}`);
    }
    out.push('');
  }

  const parts = [];
  if (counts.error > 0) parts.push(c.red(`${counts.error} 个阻塞项`));
  if (counts.warn > 0) parts.push(c.yellow(`${counts.warn} 个警告`));
  if (counts.info > 0) parts.push(c.dim(`${counts.info} 条提示`));
  out.push(`  ${counts.error > 0 ? c.red('✗') : c.green('✓')} `
    + (parts.length > 0 ? parts.join(c.dim('、')) : c.green('一切正常')));
  if (counts.error > 0) {
    out.push(`  ${c.dim('（有阻塞项 → 退出码 2；警告与提示不影响退出码，'
      + '它们是「你的仓库」的事，不是 cxt 坏了）')}`);
  }
  out.push('');

  return out.join('\n');
}

const HELP = `cxt doctor [--cwd <path>] [--json]

自检：把 \`cxt run\` / \`cxt exec\` **假设成立的那些事**逐条问出来。

检查项：
  node                    版本与可执行文件位置（需 ≥ ${MIN_NODE_MAJOR}）
  codex                   能不能定位到（含 \`.cmd\` shim 的判定）
  终端                    能不能弹窗口（探测失败不算致命：\`cxt exec\` 不需要终端）
  四要素                  这个目录解析出的 token / authToken / baseUrl / model
  受管区                  是否已创建、是否漂移、是否带 BOM（§7.14①）
  信任                    ★ 三态：trusted / 显式 untrusted / 从未标记（§7.3）
  绑定                    有没有指向不存在 token 的悬空引用
  AGENTS.md               ★ 会不会超过 project_doc_max_bytes 被**静默截断**（§7.11）
  项目级配置              有没有写了却被 Codex 静默忽略的键（§7.3）
  8.3 短名                路径是不是 \`C:\\Users\\ALICE~1\` 这种拼写（§7.3）

  --cwd <path>           体检哪个目录（默认：当前目录）
  --json                 机器可读输出
  -h, --help             本帮助

★ 退出码只有两种：\`0\` = 没发现阻塞项（**警告不影响退出码**——那是你的仓库
  或你的目录的事，不是 cxt 坏了）；\`2\` = 有阻塞项。

★ 只读：doctor 不创建目录、不写任何 cxt 或 Codex 的文件。
  ⚠️ 唯一的例外是"读 \`config.json\` 本身"——版本过旧时**读它会触发一次自动迁移**
  （§3.5，所有命令共有，迁移前会先备份）。这不是 doctor 特有的行为。
`;

export const command = { spec, run };
