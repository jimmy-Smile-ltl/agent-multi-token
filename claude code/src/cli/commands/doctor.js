// @ts-check
/**
 * `cmt doctor` —— 自检（§5）。
 *
 * 检查项：node / claude / 终端探测 / 四要素完整性 / 绑定悬空引用，
 * 外加 §2.10 的**非 ASCII 路径告警**（那条实测出来的坑：仓库放在中文目录下时
 * `launch.cmd` 必坏，因为 cmd.exe 按 OEM 代码页解码 .cmd 的字节）。
 *
 * ─────────────────────────────────────────────────────────────
 * **本命令永远返回 0**（除非自身崩了）：它是诊断工具，不是闸门。
 * "发现问题"是它的产出，不是它的失败——CI 里跑它不该因为本机没装 claude 就红。
 * 每一条问题都带 `✓ / ⚠ / ✗` 与**下一步命令**（§6.2）。
 * ─────────────────────────────────────────────────────────────
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { EXIT } from '../../core/errors.js';
import { launchScriptPath, profileNameFor } from '../../core/paths.js';
import { loadConfig, loadToken } from '../../core/store.js';
import { renderMissing, validateSession } from '../../core/validate.js';
import { findExecutable, resolveTerminal } from '../../platform/index.js';
import { locateClaude } from '../claude-bin.js';
import { fieldText, modelText, renderRows, sourceTag } from '../format.js';
import { pickOverrides, prepareSession } from '../session.js';

/** cmt 入口的绝对路径——非 ASCII 检查要连着它一起看（§2.10） */
const CMT_ENTRY = fileURLToPath(new URL('../../../bin/cmt.js', import.meta.url));

export const doctorCommand = {
  spec: /** @type {any} */ ({
    boolean: ['help', 'json'],
    string: ['cwd'],
    alias: { h: 'help' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    if (args.help) {
      process.stdout.write(DOCTOR_HELP);
      return EXIT.OK;
    }

    const report = check(args, ctx);

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return EXIT.OK;
    }

    /** @type {string[]} */
    const out = ['', `cmt doctor —— 本机自检（${report.platform} / node ${report.node.version}）`, ''];

    for (const g of report.groups) {
      out.push(`  ${g.title}`);
      out.push(renderRows(g.rows.map((/** @type {any} */ r) => [r.mark, r.text]), { indent: '    ' }));
      for (const n of g.notes) out.push(`      ${n}`);
      out.push('');
    }

    const bad = report.groups.flatMap((/** @type {any} */ g) => g.rows).filter((/** @type {any} */ r) => r.level === 'bad');
    const warn = report.groups.flatMap((/** @type {any} */ g) => g.rows).filter((/** @type {any} */ r) => r.level === 'warn');

    if (bad.length === 0 && warn.length === 0) {
      out.push('  全部通过。`cmt run` 应该能正常开窗口。');
    } else {
      out.push(`  ${bad.length} 项有问题、${warn.length} 项提示——按上面的提示逐条处理。`);
    }
    out.push('');

    process.stdout.write(`${out.join('\n')}\n`);
    return EXIT.OK;
  },
};

const DOCTOR_HELP = `cmt doctor [--cwd <path>] [--json]

自检本机环境，逐项给出结论与下一步命令：

  node / cmt 版本        是否满足最低要求
  claude 可执行文件      四档定位顺序走一遍，命中哪一档
  终端探测               本机会用哪个终端、以哪种方式（新标签页 / 新窗口）拉起 Claude
  四要素完整性           按当前目录（或 --cwd）解析一遍，缺哪项
  绑定悬空引用           指向不存在 token 的绑定
  非 ASCII 路径          仓库 / home 含中文时 launch.cmd 会坏（§2.10）

本命令**永远返回 0**——它是诊断工具不是闸门，发现问题不算失败。
`;

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @returns {any}
 */
function check(args, ctx) {
  /** @type {any[]} */
  const groups = [];

  // ── 1. node / cmt ────────────────────────────────────────────
  groups.push(checkNode());

  // ── 2. 配置能读出来吗 ────────────────────────────────────────
  const cfg = checkConfig(ctx);

  // ── 3. claude 可执行文件 ─────────────────────────────────────
  groups.push(checkClaude(ctx, cfg));

  // ── 4. 终端探测 ──────────────────────────────────────────────
  groups.push(checkTerminal(ctx, cfg));

  // ── 5. 四要素完整性 ──────────────────────────────────────────
  const session = checkSession(args, ctx);
  groups.push(session.group);

  // ── 6. 绑定悬空引用 ──────────────────────────────────────────
  groups.push(checkDangling(ctx, cfg));

  // ── 7. 非 ASCII 路径（§2.10）────────────────────────────────
  groups.push(checkAscii(ctx, session.resolved));

  return {
    platform: ctx.platform,
    home: ctx.home,
    cwd: ctx.cwd,
    node: { version: process.version, execPath: process.execPath },
    cmtEntry: CMT_ENTRY,
    groups,
  };
}

/**
 * @param {import('../types.js').Ctx} ctx
 */
function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  // §4.1：Node ≥ 18。而 18.20 / 20.12 是 CVE-2024-27980 的分界——
  // 我们两边都走 `cmd.exe /c`，所以这条只提示不拦。
  const tooOld = major < 18;
  const preCve = major === 18 && minor < 20;

  /** @type {any[]} */
  const rows = [
    {
      level: tooOld ? 'bad' : 'ok',
      mark: tooOld ? '✗' : '✓',
      text: `node ${process.version}${tooOld ? '  —— 需要 ≥ 18' : ''}`,
    },
    { level: 'ok', mark: '·', text: `node 本体 ${process.execPath}` },
  ];
  /** @type {string[]} */
  const notes = [];

  if (tooOld) {
    notes.push('升级 Node：https://nodejs.org/（或 `nvm install 22`）');
  } else if (preCve) {
    // 只在真的落在那个区间时才说，别对每个版本都念一遍
    rows.push({
      level: 'warn',
      mark: '⚠',
      text: `node ${major}.${minor} 早于 18.20 —— spawn .cmd 的行为与新版不同`,
    });
    notes.push('cmt 两边都走 `cmd.exe /c`，不受影响；但升级到 ≥ 18.20 更省心');
  }

  return { title: 'node', rows, notes };
}

/**
 * @param {import('../types.js').Ctx} ctx
 */
function checkConfig(ctx) {
  try {
    const { config, path, exists } = loadConfig({ home: ctx.home });
    return { ok: true, config, path, exists, error: null };
  } catch (err) {
    return { ok: false, config: null, path: null, exists: false, error: /** @type {any} */ (err) };
  }
}

/**
 * @param {import('../types.js').Ctx} ctx
 * @param {any} cfg
 */
function checkClaude(ctx, cfg) {
  if (!cfg.ok) {
    return {
      title: 'claude 可执行文件',
      rows: [{ level: 'warn', mark: '⚠', text: '配置读不出来，跳过' }],
      notes: [],
    };
  }

  /** @type {any[]} */
  const rows = [];
  /** @type {string[]} */
  const notes = [];

  try {
    const located = locateClaude({
      resolved: { claudeBin: { value: cfg.config.defaults?.claudeBin } },
      ctx,
      config: cfg.config,
      configExists: cfg.exists,
      persist: false, // 自检不该改配置
    });
    const where = { configured: '配置里的 claudeBin', path: 'PATH', fallback: '常见安装位置' };
    rows.push({ level: 'ok', mark: '✓', text: `${located.path}` });
    rows.push({ level: 'ok', mark: '·', text: `来自 ${where[located.source] ?? located.source}` });
    if (/\.(cmd|bat)$/i.test(located.path)) {
      notes.push('是批处理，启动时会经 `cmd.exe /c`（CVE-2024-27980：Node 拒绝直接 spawn .cmd）');
    }
  } catch (err) {
    rows.push({ level: 'bad', mark: '✗', text: `找不到 claude` });
    notes.push(...String(/** @type {any} */ (err).hint ?? '').split('\n').filter(Boolean));
  }

  // PATH 上有没有——即便上面命中了配置，这个信息也有用（排查"为什么不是 PATH 那个"）
  const onPath = findExecutable('claude', { platform: ctx.platform, env: ctx.env });
  if (onPath) {
    rows.push({ level: 'ok', mark: '·', text: `PATH 上的：${onPath}` });
  }

  return { title: 'claude 可执行文件', rows, notes };
}

/**
 * @param {import('../types.js').Ctx} ctx
 * @param {any} cfg
 */
function checkTerminal(ctx, cfg) {
  /** @type {any[]} */
  const rows = [];
  /** @type {string[]} */
  const notes = [];
  const mode = cfg.ok ? (cfg.config.defaults?.terminalMode ?? 'tab') : 'tab';

  try {
    const spec = resolveTerminal(
      {
        title: 'cmt:doctor · probe',
        cwd: ctx.cwd,
        argv: ['probe'],
        mode,
        scriptPath: launchScriptPath(ctx.home, profileNameFor(null), ctx.platform),
      },
      ctx,
    );
    rows.push({ level: 'ok', mark: '✓', text: `${spec.terminal}（${spec.via === 'direct' ? '直接拉起' : 'launch 脚本兜底'}）` });
    rows.push({ level: 'ok', mark: '·', text: spec.command });
    // 模式要显出来：tab / window 决定"标签页落进哪个窗口"，是这次最要紧的一行
    rows.push({
      level: 'ok',
      mark: '·',
      text:
        mode === 'window'
          ? '启动方式：每次开一个新窗口'
          : `启动方式：开新标签页${spec.windowName ? `，落进 ${spec.windowName} 窗口` : ''}`,
    });
    if (spec.via === 'script') {
      notes.push('这个终端只能吃命令字符串 / 给不了 cwd → 每次 run 会落一份 launch 脚本');
    }
    for (const w of spec.warnings) notes.push(`⚠ ${w}`);
  } catch (err) {
    const e = /** @type {any} */ (err);
    rows.push({ level: 'bad', mark: '✗', text: e.message });
    notes.push(...String(e.hint ?? '').split('\n').filter(Boolean));
  }

  return { title: '终端探测', rows, notes };
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function checkSession(args, ctx) {
  const explicitCwd = args.cwd;
  const target = explicitCwd ?? ctx.cwd;

  /** @type {any} */
  let session = null;
  try {
    session = prepareSession({
      ctx,
      target,
      overrides: pickOverrides(args, explicitCwd, undefined),
    });
  } catch (err) {
    return {
      group: {
        title: `四要素（${target}）`,
        rows: [{ level: 'bad', mark: '✗', text: `解析就失败了：${/** @type {any} */ (err).message}` }],
        notes: [String(/** @type {any} */ (err).hint ?? '')].filter(Boolean),
      },
      resolved: null,
    };
  }

  const { resolved, check: result } = session;
  /** @type {any[]} */
  const rows = [
    { level: 'ok', mark: '·', text: `本地路径  ${resolved.cwd.value}   ${sourceTag(resolved.cwd)}` },
    { level: 'ok', mark: '·', text: `token     ${resolved.tokenName.value ?? '（无 —— 纯 defaults 模式）'}   ${sourceTag(resolved.tokenName)}` },
    { level: 'ok', mark: '·', text: `apiUrl    ${fieldText(resolved.baseUrl)}   ${sourceTag(resolved.baseUrl)}` },
    { level: 'ok', mark: '·', text: `model     ${modelText(resolved.models)}   ${sourceTag(resolved.models)}` },
  ];

  if (result.ok) {
    rows.unshift({ level: 'ok', mark: '✓', text: '齐全——`cmt run` 可以直接启动' });
  } else {
    rows.unshift({
      level: 'bad',
      mark: '✗',
      text: `缺 ${result.missing.length} 项：${result.missing.map((/** @type {any} */ m) => m.label).join('、')}`,
    });
  }

  return {
    group: {
      title: `四要素（${target}）`,
      rows,
      notes: result.ok ? [] : renderMissing(result.missing).split('\n').slice(1).map((s) => s.trim()),
    },
    resolved,
  };
}

/**
 * @param {import('../types.js').Ctx} ctx
 * @param {any} cfg
 */
function checkDangling(ctx, cfg) {
  if (!cfg.ok) {
    return { title: '路径绑定', rows: [{ level: 'warn', mark: '⚠', text: '配置读不出来，跳过' }], notes: [] };
  }

  /** @type {any[]} */
  const rows = [];
  /** @type {string[]} */
  const notes = [];

  const bindings = cfg.config.bindings ?? [];
  /** @type {string[]} */
  const dangling = [];

  for (const b of bindings) {
    if (b.token === undefined) continue;
    const { exists } = loadToken({ home: ctx.home, name: b.token });
    if (!exists) dangling.push(`${b.path} → ${b.token}`);
  }

  if (cfg.config.defaults?.token) {
    const { exists } = loadToken({ home: ctx.home, name: cfg.config.defaults.token });
    if (!exists) dangling.push(`config.defaults.token → ${cfg.config.defaults.token}`);
  }

  if (dangling.length === 0) {
    rows.push({ level: 'ok', mark: '✓', text: `${bindings.length} 条绑定，无悬空引用` });
  } else {
    rows.push({ level: 'bad', mark: '✗', text: `${dangling.length} 处悬空引用（指向不存在的 token）` });
    for (const d of dangling) notes.push(`- ${d}`);
    notes.push('改掉：`cmt bind <路径> --token <别的>`，或 `cmt token add <名字> --token <密钥>` 补回来');
  }

  return { title: '路径绑定', rows, notes };
}

/**
 * §2.10 的非 ASCII 告警。
 *
 * 实测：`launch.cmd` 里**只要写进非 ASCII 路径就会坏**（cmd.exe 按 OEM 代码页解码 .cmd 字节），
 * 而脚本里必然写进 cmt 自己的安装路径。所以仓库放在中文目录下 = 兜底路径必坏。
 * 首选路径（直接拉起，argv 是数组）不受影响——所以这里是 ⚠ 不是 ✗。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {any} resolved
 */
function checkAscii(ctx, resolved) {
  const nonAscii = (/** @type {string} */ s) => /[^\x00-\x7F]/.test(s);

  /** @type {any[]} */
  const rows = [];
  /** @type {string[]} */
  const notes = [];

  /** @type {[string, string][]} */
  const spots = [
    ['cmt 安装路径', CMT_ENTRY],
    ['home', ctx.home],
    ['当前目录', resolved?.cwd?.value ?? ctx.cwd],
  ];

  const bad = spots.filter(([, v]) => nonAscii(v));

  if (bad.length === 0) {
    rows.push({ level: 'ok', mark: '✓', text: '全部是 ASCII——launch 脚本不会被代码页搞坏' });
  } else {
    for (const [what, v] of bad) {
      rows.push({ level: 'warn', mark: '⚠', text: `${what} 含非 ASCII：${v}` });
    }
    notes.push(
      '`launch.cmd` 里只要写进非 ASCII 路径就会坏（cmd.exe 按 OEM 代码页解码 .cmd 字节，§2.10）。',
    );
    notes.push(
      '首选路径（直接拉起，argv 走 UTF-16）**不受影响**——只有当终端探测落到"launch 脚本兜底"时才会出问题。',
    );
    notes.push('要彻底避开：把 cmt 装到纯 ASCII 路径下（例如 C:/tools/claude-multi-token）。');
  }

  return { title: '非 ASCII 路径（§2.10）', rows, notes };
}
