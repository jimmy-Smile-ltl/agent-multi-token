// @ts-check
/**
 * `cxt trust` —— 写 Codex 的**信任记录**（§7.3 / §2.10）。**Codex 专有**。
 *
 * ```bash
 * cxt trust <path> [--token <t>]      # 写 trust_level = "trusted"
 * cxt trust <path> --untrust          # 写 "untrusted"（**不删条目**）
 * cxt trust --all [--token <t>]       # 把该 token 的全部绑定路径一次标记
 * cxt trust ls [--token <t>]          # 只读：三态
 * ```
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它为什么存在（不是"顺手加的"）
 *
 * 项目级 `.codex/config.toml`（沙箱 / 审批 / hooks / rules）**未受信任就整层跳过**。
 * 而信任记录住在**用户级** config.toml 里 ⇒ 随 `CODEX_HOME` 隔离 ⇒
 * **同一个项目，token A 信任过、token B 没信任过，切到 B 会再问一次**（§2.10）。
 *
 * 这是本方案唯一的显著体验代价（N 个 token × M 个项目 = 最多 N×M 次确认）。
 * cxt 的处置是**显式命令 + 检测提示**，`cxt run` **绝不代写**——
 * 代写等于替用户做了安全决定，且用户看不见（§2.10）。
 *
 * ## 🔴 本命令最容易写错、且**完全静默**的一步：路径形态
 *
 * Codex 拿 `[projects.<键>]` 去跟 `cwd` **比字符串**。§7.3 实测：
 *
 * | 写法 | 匹配 `C:\Users\Me\proj` |
 * |------|:---:|
 * | `'C:\Users\Me\proj'`（字面字符串 + 反斜杠） | ✅ |
 * | `"C:/Users/Me/proj"`（正斜杠） | ❌ **静默不生效** |
 * | `'C:\Users\Me'`（父目录） | ❌ **不继承** |
 * | `'C:\Users\Me\proj\'`（尾部分隔符） | ❌ |
 * | `'\\?\C:\Users\Me\proj'`（UNC 前缀） | ❌ |
 *
 * 规整（分隔符 / 尾斜杠 / `\\?\`）在 `core/trust.js` 的 `canonicalizeTrustPath()`，
 * 本文件只负责**把它做过的改动说出来**——用户看得见"我敲的 `D:/a` 变成了 `D:\a`"，
 * 才不会以为工具自作主张。
 *
 * ## 与 `bind` 的 8.3 短名告警同源（§7.3）
 *
 * 本机 `%TEMP%` 给的就是短名 `C:\Users\ALICE~1`，而 `os.homedir()` 给的是长名。
 * 两条 `existsSync` 都是 `true`（同一个目录），字符串却是两个值 ⇒ 又一条静默失配。
 * 铁律 4 禁止我们归一化（写的是用户的字面路径），所以只能**警告**。
 * ─────────────────────────────────────────────────────────────
 */

import { matchBinding, looksLikeShortName, normalizeForCompare } from '../../core/bindings.js';
import { CxtError, EXIT } from '../../core/errors.js';
import { DEFAULT_PROFILE_NAME, profileConfigPath, profileNameFor } from '../../core/paths.js';
import {
  fileSize, listProfileNames, readConfig, readProfileConfig, readToken,
} from '../../core/store.js';
import { parseTrustEntries, readTrust, spliceTrust } from '../../core/trust.js';
import { resolveUserPath } from '../arg-path.js';
import { makePainter, table } from '../format.js';
import { bindingsReferencing, mutateProfileToml, requireToken } from '../state-edit.js';

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'json', 'untrust', 'all'],
  string: ['token', 'cwd'],
  alias: { h: 'help' },
};

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
export async function run(args, ctx) {
  const sub = args._[0];

  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  switch (sub) {
    case 'ls': case 'list': return cmdLs(args, ctx);
    case 'rm': case 'remove': case 'delete': return refuseRm(ctx);
    default: break;
  }

  if (args.all === true) {
    if (sub !== undefined) {
      throw new CxtError(`--all 与路径不能同时给（收到路径 ${JSON.stringify(sub)}）`, {
        hint: '`cxt trust --all` 标的是**该 token 的全部绑定路径**；要标单个目录就别带 --all',
      });
    }
    return cmdAll(args, ctx);
  }

  if (sub === undefined) {
    throw new CxtError('缺少路径', {
      hint: '`cxt trust <路径>` 标记为可信；`cxt trust --all` 标记该 token 的全部绑定路径；'
        + '`cxt trust ls` 看现状',
    });
  }
  return cmdOne(args, ctx, sub);
}

/**
 * `cxt trust rm` —— **刻意不存在**（§7.3 铁律 1）。
 *
 * 报错要给出路：撤销用 `--untrust`，真要抹掉条目就手工编辑那个文件。
 * 只说"不支持"的话，用户下一步多半是去删文件——那比删条目危险得多。
 * @param {import('../types.js').Ctx} ctx
 */
function refuseRm(ctx) {
  throw new CxtError('cxt 不删信任条目', {
    hint: '`[projects.*]` 是**你的**信任决定，cxt 只增不减（§7.3 铁律 1）。\n'
      + '  撤销信任：`cxt trust <路径> --untrust`——它会写 trust_level = "untrusted"，'
      + '条目留着，语义比"没记录"更强（Codex 走 UnlessTrusted 而不是 OnRequest）。\n'
      + `  真要抹掉条目，手工编辑 ${profileConfigPath(ctx.home, DEFAULT_PROFILE_NAME)} 所在的那个 `
      + 'profiles/<token>/config.toml（用 `cxt profile ls` 找）',
  });
}

// ───────────────────────────── 写单条 ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @param {string} rawPath
 */
function cmdOne(args, ctx, rawPath) {
  const level = args.untrust === true ? 'untrusted' : 'trusted';
  const { path, from } = resolveUserPath(rawPath, ctx);
  const picked = pickProfile(args, ctx, path);

  const cfgPath = profileConfigPath(ctx.home, picked.profileName);
  const hadFile = fileSize(cfgPath) !== null;

  /** @type {import('../../core/trust.js').TrustSpliceReport | null} */
  let rep = null;
  mutateProfileToml(ctx, picked.profileName, (text) => {
    const r = spliceTrust(text, { path, level, platform: ctx.platform });
    rep = r.report;
    return r.newText;
  });
  const report = /** @type {import('../../core/trust.js').TrustSpliceReport} */ (rep);

  /** @type {string[]} */
  const lines = [
    headline(report.action, level, report.path),
    ...(from === null
      ? []
      : [`  路径      ${rawPath} → ${path}（相对路径按当前目录补全）`]),
    // ★ 规整这一步**必须说出来**：写进文件的是 `C:\x\y`，用户敲的是 `C:/x/y`，
    //   两者看起来"就是同一个路径"。不解释的话，下次他手工改这个文件时
    //   会照自己的习惯写回正斜杠——而那正是静默不生效的那一种（§7.3）。
    ...(report.path === path
      ? []
      : [`  规范化    ${path} → ${report.path}`,
        '            （Windows 用反斜杠 + 去尾部分隔符 + 剥 \\\\?\\ 前缀——'
        + 'Codex 只认这种写法，别的写法**不报错但静默不匹配**，§7.3）']),
    `  profile   ${picked.profileName}${picked.tokenName === null ? '（纯 defaults 模式）' : `（token ${picked.tokenName}）`}`,
    `  写进      [projects.${quoteToml(report.path)}]  trust_level = ${JSON.stringify(level)}`
      + `${report.line === null ? '' : `   ← 第 ${report.line} 行`}`,
  ];

  if (report.action === 'repaired') {
    // ★ 这条最要紧：原来那条**看着写了、实际 Codex 认不出**。
    //   不报的话，用户会以为自己早就信任过了，而"信任没生效"是静默的。
    lines.push('');
    lines.push(`  ⚠ 原来那条写法 Codex **认不出**：${report.repairedFrom}`);
    lines.push('    已就地改成规范写形（只动了表头那一行，表体一字未动）。');
    lines.push('    这正是"我明明信任过它"最常见的成因。');
  }
  if (level === 'untrusted') {
    // ★ 为什么写 "untrusted" 而不是删条目——不说清楚，用户下次会自己去删，
    //   而那会把一个**更强**的语义（UnlessTrusted）降级成"从未见过"（OnRequest）。
    lines.push('');
    lines.push('  ℹ 条目**留着**，只是把值改成 "untrusted"。这不是"撤销到没记录过"：');
    lines.push('    Codex 内部是三态，显式 untrusted 走 UnlessTrusted，从未标记走 OnRequest。');
    lines.push('    cxt 从不删 `[projects.*]`（§7.3 铁律 1）——那是你的信任决定，只有你能撤。');
  }
  if (report.nearMisses.length > 0) {
    lines.push('');
    lines.push(`  ⚠ 还有 ${report.nearMisses.length} 条指向同一个目录、但写法同样认不出——**没改**：`);
    for (const m of report.nearMisses) {
      lines.push(`      第 ${m.line} 行  ${m.path}  （${m.reason}）`);
    }
    lines.push('    一次只修一条：改两条会变成两张同名表，整个 config.toml 直接作废。');
    lines.push('    手工删掉多余的那几条再跑一次。');
  }
  if (report.hadBom) lines.push('', '  ℹ 原文件带 BOM，已剥掉（Codex 可能不认带 BOM 的 TOML，§7.14①）');
  if (report.normalizedEol) lines.push('', '  ℹ 原文件的 CRLF 已归一为 LF');
  if (!hadFile) {
    lines.push('');
    lines.push(`  ℹ 这是新建的 config.toml（profiles/${picked.profileName}/ 之前不存在）。`);
    lines.push('    受管区还没写——首次 `cxt run` 时才写（§3.2：惰性，绝不预建）。');
  }

  lines.push(...formNotes(report.path, picked, ctx));

  return emit({ args, ctx, action: report.action, path: report.path, level, picked, lines, report });
}

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdAll(args, ctx) {
  const level = args.untrust === true ? 'untrusted' : 'trusted';
  const config = readConfig(ctx.home);

  const tokenName = args.token ?? config.defaults?.token;
  if (tokenName === undefined) {
    throw new CxtError('--all 不知道该给哪个 token 标记', {
      hint: '`cxt trust --all --token <t>`——或先在 config.defaults.token 里设一个默认 token',
    });
  }
  requireToken(ctx, tokenName);

  const paths = bindingsReferencing(config, tokenName);
  if (paths.length === 0) {
    throw new CxtError(`token ${tokenName} 没有任何绑定路径`, {
      hint: '`--all` 标的是**这个 token 的绑定路径**（§2.10）。先绑一个：'
        + `\`cxt bind <路径> --token ${tokenName}\`；或者用 \`cxt trust <路径>\` 标单个目录`,
    });
  }

  const profileName = profileNameFor(tokenName);
  const cfgPath = profileConfigPath(ctx.home, profileName);
  const hadFile = fileSize(cfgPath) !== null;

  /** @type {{ path: string, report: any }[]} */
  const done = [];
  /** @type {{ raw: string, reason: string }[]} */
  const skipped = [];

  mutateProfileToml(ctx, profileName, (text) => {
    let t = text;
    for (const p of paths) {
      try {
        const r = spliceTrust(t, { path: p, level, platform: ctx.platform });
        t = r.newText;
        done.push({ path: r.report.path, report: r.report });
      } catch (err) {
        // 一条坏的（相对路径 / 内联表 / 重复表）不该让整批停下——
        // 其余那些路径的信任是**独立**的，标好了就是标好了。
        skipped.push({ raw: p, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return t;
  });

  return emit({
    args,
    ctx,
    action: 'all',
    path: null,
    level,
    picked: { tokenName, profileName, dangling: false, notes: [] },
    lines: [
      `已把 token ${tokenName} 的 ${done.length} 条绑定路径标记为`
        + `${level === 'trusted' ? '可信' : '**不可信**'}`,
      ...(hadFile ? [] : [`  ℹ 这是新建的 config.toml（profiles/${profileName}/ 之前不存在）`]),
      ...(skipped.length === 0
        ? []
        : ['', `  ⚠ 有 ${skipped.length} 条跳过了（其余照标）：`,
          ...skipped.map((s) => `      ${s.raw}  —— ${s.reason}`)]),
      ...formNotes(null, { tokenName, profileName, dangling: false, notes: [] }, ctx),
    ],
    report: null,
    done,
    skipped,
  });
}

/** @type {Record<string, string>} */
const ACTION_TEXT = {
  added: '已标记为',
  updated: '已把信任状态改成',
  repaired: '已修复写法并标记为',
  unchanged: '信任状态未变（本来就一样）',
};

/**
 * 首行。
 *
 * ★ **`action` 与 `level` 是两个维度**，别混：前者说"这次动了什么"（新增/改写/修好/没变），
 * 后者说"标成了什么"（trusted / untrusted）。只按 action 出文案的话，
 * `--untrust` 会打印"已标记为可信"——一条**说反了**的确认，比没有还糟。
 *
 * @param {string} action
 * @param {string} level
 * @param {string} path
 */
function headline(action, level, path) {
  const text = ACTION_TEXT[action] ?? action;
  if (action === 'unchanged') return `${text}：${path}`;
  return `${text}${level === 'trusted' ? '可信' : '**不可信**'}：${path}`;
}

/**
 * 路径形态上的两类提示——§7.3 的两条静默失配。
 *
 * @param {string | null} canon 写进文件的规范路径（`--all` 时为 null）
 * @param {{ tokenName: string | null, profileName: string, dangling: boolean }} picked
 * @param {import('../types.js').Ctx} ctx
 * @returns {string[]}
 */
function formNotes(canon, picked, ctx) {
  /** @type {string[]} */
  const out = [];

  if (canon !== null) {
    if (looksLikeShortName(canon, ctx.platform)) {
      out.push('');
      out.push('  ⚠ 这条路径看着像 **8.3 短名**（形如 `PREFIX~1`）。');
      out.push('    Windows 上同一个目录有两个都合法的拼写，而信任是**字符串比较**：');
      out.push('    用短名写的信任，长名 cwd 匹配不上，反之亦然——症状与"正斜杠写错"一模一样。');
      out.push('    cxt **刻意不归一化**（§7.3 铁律 4），所以请确认你平时用哪种拼写进这个目录。');
    }

    // §7.3：**不继承**。给父目录写信任不会覆盖子项目——这是用户最常见的误解。
    const self = normalizeForCompare(canon, ctx.platform);
    const config = readConfig(ctx.home);
    const children = (config.bindings ?? [])
      .map((/** @type {any} */ b) => b.path)
      .filter((/** @type {string} */ p) => {
        const n = normalizeForCompare(p, ctx.platform);
        return n !== self && n.startsWith(`${self}/`);
      });
    if (children.length > 0) {
      out.push('');
      out.push(`  ⚠ 有 ${children.length} 个已绑定目录在它**之下**——信任**不继承**（§7.3）：`);
      for (const p of children.slice(0, 5)) out.push(`      ${p}`);
      if (children.length > 5) out.push(`      …还有 ${children.length - 5} 个`);
      out.push('    在那些目录里跑 codex 仍然会问一遍。要它们也免问，逐个 `cxt trust`。');
    }
  }

  if (picked.dangling) {
    out.push('');
    out.push(`  ⚠ token ${picked.tokenName} 现在**不存在**（绑定指向了它，但文件没了）。`);
    out.push(`    记录写进了 profiles/${picked.profileName}/config.toml——把那个 token 加回来它就生效。`);
    out.push(`    要改成别的身份：\`cxt trust <路径> --token <t>\`。`);
  }

  return out;
}

// ───────────────────────────── 选 profile ─────────────────────────────

/**
 * 这一刀切在**哪个 profile** 上。
 *
 * ★ 默认那条走的是与 `cxt run` **同一条级联**（绑定 → defaults），
 * 理由很实际：信任记录必须落在**那个目录实际会用的** profile 里，
 * 否则写完了 run 起来照样问一遍——而用户以为已经信任过了。
 *
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 * @param {string} path
 * @returns {{ tokenName: string | null, profileName: string, dangling: boolean }}
 */
function pickProfile(args, ctx, path) {
  const config = readConfig(ctx.home);

  if (args.token !== undefined) {
    requireToken(ctx, args.token);   // 显式指定的必须存在：写错名字是用户的错，要说出来
    return { tokenName: args.token, profileName: profileNameFor(args.token), dangling: false };
  }

  const hit = matchBinding(config.bindings ?? [], path, ctx.platform);
  const tokenName = hit?.binding?.token ?? config.defaults?.token ?? null;
  return {
    tokenName,
    profileName: profileNameFor(tokenName),
    // 级联给出的 token 可能已被删——**不报错**（写这个文件是安全且幂等的），
    // 但要**说出来**：不然用户在一条永远不会被读到的 profile 里写了信任，还以为是好的。
    dangling: tokenName !== null && readToken(ctx.home, tokenName) === null,
  };
}

// ───────────────────────────── ls ─────────────────────────────

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
function cmdLs(args, ctx) {
  const config = readConfig(ctx.home);
  const cwd = args.cwd !== undefined && args.cwd !== '' ? resolveUserPath(args.cwd, ctx).path : ctx.cwd;

  // 当前目录落在哪个 profile 下——与 `cxt run` 同一条级联
  const hit = matchBinding(config.bindings ?? [], cwd, ctx.platform);
  const cwdToken = hit?.binding?.token ?? config.defaults?.token ?? null;
  const cwdProfile = profileNameFor(cwdToken);

  /** @type {string[]} */
  let names;
  if (args.token !== undefined) {
    requireToken(ctx, args.token);
    names = [profileNameFor(args.token)];
  } else {
    names = listProfileNames(ctx.home);
    // ★ 当前目录的 profile 一定要列——哪怕它还没有目录。
    //   "我这个目录到底被信任了没" 正是敲这条命令时最想问的那句，
    //   而它多半还没被 run 过，于是目录不存在。
    if (!names.includes(cwdProfile)) names = [...names, cwdProfile].sort();
  }

  /** @type {any[]} */
  const profiles = [];
  for (const name of names) {
    const file = profileConfigPath(ctx.home, name);
    const exists = fileSize(file) !== null;
    const text = readProfileConfig(ctx.home, name);
    /** @type {any[]} */
    const entries = [];
    /** @type {string | null} */
    let error = null;

    try {
      for (const e of parseTrustEntries(text)) {
        entries.push({
          path: e.path,
          state: e.level === 'trusted' ? 'trusted'
            : e.level === 'untrusted' ? 'untrusted'
              : 'malformed',
          levelRaw: e.levelRaw,
          form: e.form,
          // ★ 表形式下 `e.line` 是**表头**行，`trust_level` 在它下面几行。
          //   报表头行号会让用户翻到那一行发现"这里没有 trust_level"。
          line: (e.keyIndex >= 0 ? e.keyIndex : e.line) + 1,
        });
      }
    } catch (err) {
      // 一个 profile 的表坏了，不该让其余几个也看不见（doctor 同一条纪律）
      error = err instanceof Error ? err.message : String(err);
    }

    let cwdState = null;
    if (name === cwdProfile && error === null) {
      try {
        const r = readTrust(text, cwd, ctx.platform);
        cwdState = { state: r.state, entryPath: r.entry?.path ?? null, nearMisses: r.nearMisses };
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    }

    profiles.push({
      profile: name,
      token: name === DEFAULT_PROFILE_NAME ? null : name,
      file,
      exists,
      entries,
      cwdState,
      isCwdProfile: name === cwdProfile,
      error,
    });
  }

  const total = profiles.reduce((n, p) => n + p.entries.length, 0);

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      cwd,
      cwdToken,
      cwdProfile,
      profiles,
      total,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  /** @type {string[]} */
  const out = ['', `  ${c.bold('信任表')}  ${c.dim(`— 当前目录 ${cwd}`)}`, ''];

  for (const p of profiles) {
    const label = `${p.profile}${p.isCwdProfile ? c.dim('   ← 当前目录用的就是它') : ''}`;
    out.push(`  ${c.bold(label)}`);

    if (p.error !== null) {
      out.push(`    ${c.red('✗ 读不出来：')}${p.error}`);
      out.push('');
      continue;
    }
    if (!p.exists) {
      // ★ 目录都没有时，**当前目录那一问仍要回答**——"我这个目录被信任了没"
      //   正是敲这条命令时最想问的那句，而它多半就落在这种还没建过的 profile 上。
      out.push(p.isCwdProfile
        ? `    ${STATE_ICON.unmarked} ${c.dim('未标记')}  ${c.dim(cwd)}  ${c.cyan('← 当前目录')}`
          + `${c.dim('（这个 profile 还没有 config.toml）')}`
        : `    ${c.dim('还没有 config.toml —— 这个 profile 一条信任记录都没有')}`);
      out.push('');
      continue;
    }
    if (p.entries.length === 0 && (p.cwdState === null || p.cwdState.state !== 'unmarked')) {
      out.push(`    ${c.dim('（没有任何信任记录）')}`);
      out.push('');
      continue;
    }

    const rows = p.entries.map((e) => [
      `${STATE_ICON[e.state] ?? '?'} ${stateText(e.state, c)}`,
      e.path + (looksLikeShortName(e.path, ctx.platform) ? ` ${c.yellow('⚠8.3')}` : ''),
      p.cwdState?.entryPath === e.path ? c.cyan('← 当前目录') : c.dim(`第 ${e.line} 行`),
    ]);
    // ★ 三态里的第三态：**从未标记**。它与显式 untrusted 语义不同（§7.3），
    //   而这一行恰恰是"我这个目录现在跑 codex 会不会被问"的直接答案。
    if (p.cwdState !== null && p.cwdState.state === 'unmarked') {
      rows.push([`${STATE_ICON.unmarked} ${c.dim('未标记')}`, c.dim(cwd), c.cyan('← 当前目录')]);
    }
    out.push(table(['状态', '路径', ''], rows, { indent: '    ' }));

    for (const m of p.cwdState?.nearMisses ?? []) {
      out.push(`    ${c.yellow('⚠')} 第 ${m.line} 行 ${m.path} 指向同一个目录，但写法 Codex 认不出（${m.reason}）`);
    }
    out.push('');
  }

  out.push(`  ${c.dim(`${profiles.length} 个 profile · ${total} 条信任记录`)}`);
  out.push(`  ${c.dim('三态：✓ trusted / ✗ 显式 untrusted / · 从未标记。后两者语义不同（§7.3）——')}`);
  out.push(`  ${c.dim('显式 untrusted 走 UnlessTrusted，从未标记走 OnRequest。')}`);
  out.push(`  ${c.dim('★ 信任是 (token × 项目) 矩阵：同一个项目换个 token 要重新信任（§2.10）')}`);
  out.push('');

  process.stdout.write(out.join('\n'));
  return EXIT.OK;
}

/** @type {Record<string, string>} */
const STATE_ICON = { trusted: '✓', untrusted: '✗', malformed: '?', unmarked: '·' };

/**
 * @param {string} state
 * @param {ReturnType<typeof makePainter>} c
 */
function stateText(state, c) {
  if (state === 'trusted') return c.green('trusted');
  if (state === 'untrusted') return c.red('untrusted');
  return c.yellow('值可疑');
}

// ───────────────────────────── 输出 ─────────────────────────────

/**
 * @param {{ args: any, ctx: import('../types.js').Ctx, action: string, path: string | null,
 *   level: string, picked: any, lines: string[], report: any,
 *   done?: any[], skipped?: any[] }} r
 */
function emit(r) {
  const { args, ctx } = r;

  if (args.json === true) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      action: r.action,
      path: r.path,
      level: r.level,
      token: r.picked.tokenName,
      profile: r.picked.profileName,
      file: profileConfigPath(ctx.home, r.picked.profileName),
      report: r.report,
      done: r.done ?? null,
      skipped: r.skipped ?? null,
    }, null, 2)}\n`);
    return EXIT.OK;
  }

  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  process.stdout.write(`\n  ${c.green('✓')} ${r.lines[0]}\n`
    + `${r.lines.slice(1).map((l) => (l === '' ? '' : `  ${l}`)).join('\n')}\n\n`);
  return EXIT.OK;
}

/**
 * 把路径放进 `[projects.<这里>]` 的样子——**照抄** `toml-value.js` 的选择：
 * 路径不含单引号就用字面字符串（§7.3 铁律 2）。
 * @param {string} p
 */
function quoteToml(p) {
  return p.includes("'") ? JSON.stringify(p) : `'${p}'`;
}

const HELP = `cxt trust —— 写 Codex 的信任记录（§7.3 / §2.10）★ Codex 专有

项目级 .codex/config.toml（沙箱 / 审批 / hooks / rules）**未受信任就整层跳过**。
信任记录住在用户级 config.toml 里 ⇒ 随 CODEX_HOME 隔离 ⇒
**同一个项目换个 token 要重新信任**（N 个 token × M 个项目）。这是本方案唯一的
显著体验代价，cxt 不假装它不存在。

用法：
  cxt trust <路径> [--token <t>]
      写 [projects.'<路径>'] trust_level = "trusted"。
      --token 省略时按**当前目录**走与 \\\`cxt run\\\` 同一条级联
      （绑定 → config.defaults.token），保证记录落在那个目录**实际会用的** profile 里。
  cxt trust <路径> --untrust
      写 "untrusted"——**不删条目**。它与"从未标记"不是一回事：
      Codex 内部走的是 UnlessTrusted 而不是 OnRequest（§7.3）。
  cxt trust --all [--token <t>]
      把该 token 的**全部绑定路径**一次标记（§2.10 批量）。
  cxt trust ls [--token <t>] [--cwd <p>]
      只读。列出各 profile 的信任表，标注三态：trusted / 显式 untrusted / **从未标记**。

🔴 **路径形态是本命令最容易写错、且完全静默的一处**（§7.3 真机实测）：
  ✅ 'C:\\Users\\Me\\proj'     字面字符串 + **Windows 反斜杠**
  ❌ "C:/Users/Me/proj"       正斜杠 —— 不匹配
  ❌ 'C:\\Users\\Me'           父目录 —— **不继承**
  ❌ 'C:\\Users\\Me\\proj\\'    尾部分隔符 —— 不匹配
  ❌ '\\\\?\\C:\\Users\\Me\\proj'  UNC 前缀 —— 不匹配
  cxt 会把路径规整成规范写形（分隔符 / 尾斜杠 / UNC 前缀）并**在输出里说明**，
  但**不做** resolve/realpath（§7.3 铁律 4：写的是你给的**字面**路径，
  cxt 与 Codex 读的是同一个 process.cwd() 字符串）。

⚠️ 8.3 短名（C:\\Users\\ALICE~1 与 C:\\Users\\alice 是同一个目录的两个拼写）
   会出 warning 而不是归一化——理由同上。

⚠️ \`cxt trust rm\` **不存在**：cxt 只增不减（§7.3 铁律 1）。撤销用 --untrust。
⚠️ \`cxt run\` **绝不**代写信任——代写等于替你做了安全决定，且你看不见（§2.10）。

选项：
  --token <t>   写哪个 profile 的信任表（缺省：按路径解析出的身份）
  --untrust     写 "untrusted" 而不是 "trusted"
  --all         批量：该 token 的全部绑定路径
  --cwd <p>     配合 ls：体检哪个目录（默认当前目录）
  --json        机器可读输出
  -h, --help    本帮助
`;

export const command = { spec, run };
