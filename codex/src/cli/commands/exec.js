// @ts-check
/**
 * `cxt exec [<token>]` —— 在**当前终端**启动 codex（§5、§2.12）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它是链条上的哪一环
 *
 * ```
 * cxt run  →  spawnTerminal（弹新窗口）
 *               └─ 直接拉起：argv 一路不经 shell
 *               └─ 兜底脚本：launch.cmd / launch.sh 里写的是
 *                            "<node>" "<cxt>" exec <token> %*
 *                                        └──────────────┘
 *                                              就是这里
 * ```
 *
 * ★ **launch 脚本里不内联 token**（§2.12）：脚本只调用 `cxt exec`，
 * 由 exec 在进程内注入环境。所以这个命令**必须能被独立跑通**——
 * 它是"脚本里没有密钥"这条设计成立的前提。
 *
 * ## 职责（§5）
 * 解析四要素 → 同步受管区 → 注入环境 → 定位 codex → `spawn(stdio:'inherit')` → 转发退出码
 *
 * 外加一次**启动前校验**（§2.5）：同步受管区之前拉一次 `/models`，从优先级里挑第一个
 * 确实存在的。只读、只做一次、失败静默、`--print` 不联网——四条边界缺一条它就成了
 * 被 §1.4 明令不做的"自动故障转移"。
 *
 * ## ⚠️ 两个与 `cxt run` 不同的地方
 * 1. **cwd 跳过 `token.cwd`**（§2.3 第五条）：exec 是在**已经存在**的终端里跑，
 *    把用户拽到别的目录会破坏 shell 与 Codex 的工作根一致性，
 *    并让 `resume --last` **静默续错会话**。所以只有 `--cwd` 显式给出才传 `-C`。
 * 2. **不补任何 git 相关 flag**（§7.6 订正）：`--skip-git-repo-check` 是
 *    **`codex exec` 子命令**专属，顶层 `codex` 不认它。补了 = 任何目录都启动不了。
 * ─────────────────────────────────────────────────────────────
 */

import { CxtError, EXIT } from '../../core/errors.js';
import { profileDir } from '../../core/paths.js';
import { buildSessionEnv, SESSION_MARKER_ENV } from '../../core/resolve.js';
import { ensureDir, writeProfileConfig } from '../../core/store.js';
import { readTrust } from '../../core/trust.js';
import { assertArgvConsistent } from '../../core/validate.js';
import { spawnForeground } from '../../platform/spawn-foreground.js';
import { cmdShimArgv, locateCodexBin } from '../codex-bin.js';
import { makePainter, maskEnv, table } from '../format.js';
import { preflightApplies, preflightModels } from '../preflight.js';
import { injectionFor, managedRegionDiff, resolveSession, toResolveArgv } from '../session.js';
import { recordSessionEnd, recordSessionStart } from '../sessions.js';

/** @type {import('../types.js').Command['spec']} */
const spec = {
  boolean: ['help', 'print', 'resume'],
  string: ['cwd', 'token', 'token-value', 'url', 'model'],
  // `-c` 与 `--resume` 同义。⚠️ 别和 codex 的 `-p/--profile` 搞混（§5 的提醒）。
  alias: { h: 'help', t: 'token', m: 'model', c: 'resume' },
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

  // ★ 位置参数就是 token 名（`cxt exec relay-a`）——**必须传给 `toResolveArgv`**，
  //   不然它只认 `--token`，位置参数被静默丢掉，
  //   症状是"明明给了 token 名，却报四要素缺 authToken"。
  const argv = toResolveArgv(args, args._);
  assertArgvConsistent(argv);

  // ★ entry 必须是 'exec'（§2.3 第五条）——不许让 exec 路径"碰巧"拿到 token.cwd
  //   再靠调用方不传 -C 来抵消。那个抵消会在 --print / doctor / 脚本生成
  //   三条路径上各自漏一次。
  let resolved = resolveSession(ctx, argv, 'exec');
  // ★ 四要素不齐 → **拒绝启动**（§2.1）。`cxt resolve` 会展示缺项，exec 直接拦。
  if (resolved.missing.length > 0) {
    throw new CxtError(`四要素不齐全，缺少：${resolved.missing.join('、')}`, {
      hint: '用 `cxt resolve` 看每项的来源层与补法；用 `cxt exec --print` 只看不跑',
    });
  }

  // ★ 下面两个都是 `const`：校验只可能换掉**本次生效**的东西，
  //   受管区要写的内容永远按配置算（见启动前校验那一段的注释）。
  const diff = managedRegionDiff(ctx, resolved);
  let injection = injectionFor(resolved, ctx);
  const codexBin = locateCodexBin(ctx);

  // ── 组装最终 argv ──
  // ★ 只有这一份数组：`--print` 显示的和真正 spawn 的是**同一个引用**。
  //   分头组装迟早会不一致（§2.3 第五条的同一条教训）。
  //   转义不在这里做——`cmdShimArgv` 才是唯一做转义的地方（它带 %VAR% 检测），
  //   所以打印出来的就是跑的。
  //
  //   ★ `let` 而不是 `const`：启动前校验可能换掉模型，那一轮得换成重算过的数组。
  //     只更新 `plan.codexArgs` 而把这里的旧数组递给 spawn，就是"打印的和跑的不是同一份"
  //     ——本仓库刚踩过（e2e 里 argv 是空的，而 `--print` 一切正常）。
  let codexArgs = injection.args;

  // ── 组装环境：继承环境**先净化**，再盖上注入项（§2.6）──
  //
  //   ⚠️ **不要写成 `{ ...ctx.env, ...injection.env }`**。那个写法看着等价，
  //   实际少了"剔掉调用方会话标记"这一步——而 `wt.exe` 会把调用方的整套环境
  //   **原样转发**进新标签页（§7.14 实测），于是从 codex 会话里 `cxt run` 出来的窗口
  //   会顶着父会话的身份跑，甚至把 `CODEX_SQLITE_HOME` 指向**另一个 token 的**状态库。
  //   契约与判据见 §2.6「继承环境的净化」。
  let env = buildSessionEnv({ base: ctx.env, injection });

  const plan = {
    codexBin: codexBin.path,
    shim: codexBin.shim,
    env,
    /** 会被删掉的继承变量（§2.6）——`--print` 要印，否则"我明明没配 X"无从解释 */
    unset: injection.unset,
    codexArgs,
    profile: injection.profile,
    cwd: resolved.cwd.value,
    resume: resolved.resume === true,
  };

  // ── `--print`：只打印不启动（§5，"排查首选"）──
  //   ★ 放在启动前校验**之前**：诊断视图不联网，端点不通也要秒回（§2.5 边界③）。
  if (args.print === true) {
    process.stdout.write(renderPlan(resolved, diff, plan, ctx));
    return EXIT.OK;
  }

  // ── 启动前校验（§2.5）──
  //
  //   ★ 在受管区同步**之前**：它可能换掉本次生效的模型，而 `-c model=` 是
  //     从 resolved 现算的——先同步再校验的话，这一轮会带着旧值启动。
  //   ★ `plan` 是按"原始 resolved"拼的，换了人就得把**与模型有关的那几项**重拼；
  //     `codexBin` / `profile` / `cwd` 不受模型影响，不动。
  const pre = await preflightModels({ resolved, injection, enabled: resolved.preflight });
  if (pre.note !== null) {
    process.stderr.write(`${makePainter({ isTTY: ctx.isTTY, env: ctx.env }).yellow('cxt:')} ${pre.note}\n`);
  }
  if (pre.resolved !== resolved) {
    resolved = pre.resolved;
    // ★ **不重算 `diff`**（§2.5「只读」）。受管区写的是**配置值** `models[0]`，
    //   而校验的结论只对**这一次运行**有效、不落盘。重算的话，端点某次没列 `a`
    //   就会把 `model = 'b'` 永久写进 config.toml——一次**只读探测**顺手改了
    //   用户的持久配置，而用户下次可能根本不联网，压根没机会被纠正回来。
    //   `injection` 必须重算：`-c model=` 是从它现拼的，这一条才是"本次生效"。
    injection = injectionFor(resolved, ctx);
    env = buildSessionEnv({ base: ctx.env, injection });
    codexArgs = injection.args;
    plan.codexArgs = codexArgs;
    plan.env = env;
    plan.unset = injection.unset;
  }

  syncManagedRegion(ctx, resolved, diff);
  // ★ `mkdir -p profiles/<token>/`（§7.1）——**Codex 不会自动创建自定义 CODEX_HOME**，
  //   路径必须预先存在，否则它报 `CODEX_HOME points to "...", but that path does not exist`
  //   然后回落/失败。症状是"隔离没生效"，最难查的一步。
  ensureDir(profileDir(ctx.home, resolved.profileName));

  warnAboutTrust(resolved, diff, ctx);

  // ★ 转不了的参数要**在实跑时也说一遍**，不能只在 `--print` 里出现。
  //   `%VAR%` 会被 cmd 展开且无法转义（§7.14⑥）——静默改掉用户参数是最坏的一种失败，
  //   而 `--print` 是"用户主动去看"才有的路径，指望不上。
  const shim = codexBin.shim ? cmdShimArgv(codexBin.path, codexArgs) : null;
  if (shim !== null && shim.warnings.length > 0) {
    const painter = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
    for (const w of shim.warnings) process.stderr.write(`${painter.yellow('cxt:')} ${w}\n`);
  }

  // ── 在场层（§2.16 一）：写一条会话记录 ──
  //
  //   ★ 位置：`--print` 分支之后、spawn 之前——打印不启动，不该留下记录。
  //   ★ 写者必须是 exec 自己：`cxt run` spawn 完就 detached + unref，
  //     根本看不到这个进程的生死（§2.16 一的来历）。
  //   ★ 失败**不阻塞**：recordSessionStart 内部兜住，只打一行警告——
  //     在场层坏了不许让窗口打不开。
  const sessionRecord = recordSessionStart(ctx, { resolved });
  if (sessionRecord !== null) {
    env = { ...env, CXT_SESSION_ID: sessionRecord.id };
  }

  const code = await spawnForeground({
    command: shim !== null ? comspecOf(ctx.env) : codexBin.path,
    args: shim !== null ? shim.args : codexArgs,
    env,
    // ★ exec 不设 cwd：让 codex 继承**本进程**的 cwd（= 终端已经设好的那个）
    cwd: null,
    verbatimArgs: shim !== null ? true : undefined,
    label: 'codex',
  });

  if (sessionRecord !== null) recordSessionEnd(ctx, sessionRecord.id, code);
  return code;
}

// ───────────────────────────── argv 组装 ─────────────────────────────

/** `%COMSPEC%`，没设就退回 `cmd.exe`（§7.14④） */
function comspecOf(env) {
  const c = env.COMSPEC;
  return (typeof c === 'string' && c !== '') ? c : 'cmd.exe';
}

// ───────────────────────────── 受管区同步 ─────────────────────────────

/**
 * 把受管区写成该有的样子（§2.9）。
 *
 * ⚠️ `writeProfileConfig` 收到 `previousText` 时会**拒绝让 `[projects.*]` 变少**
 * ——那是"拼接器吃掉了用户的信任记录"的最后一道保险。所以这里必须把
 * `diff.current` 传进去，不能省。
 *
 * @param {import('../types.js').Ctx} ctx
 * @param {any} resolved
 * @param {any} diff
 */
function syncManagedRegion(ctx, resolved, diff) {
  if (!diff.changed) return;
  writeProfileConfig(ctx.home, resolved.profileName, diff.next, diff.current);
}

// ───────────────────────────── 信任提示 ─────────────────────────────

/**
 * 目录没被标记过时提醒一句——**但不拦、不绕、不替用户写**（§2.3 第四条）。
 *
 * 信任门是仓库自己的安全策略，`cxt run` **绝不静默写信任**（§2.9 铁律）。
 * 这里只做一件事：让用户知道"接下来 codex 会问你"，
 * 免得他把交互式提问当成卡死。
 *
 * ⚠️ 信任匹配是**字符串比较**、**不继承父目录**（§7.3），所以查的就是 cwd 本身。
 *
 * @param {any} resolved
 * @param {any} diff
 * @param {import('../types.js').Ctx} ctx
 */
function warnAboutTrust(resolved, diff, ctx) {
  const cwd = resolved.cwd.value;
  if (typeof cwd !== 'string' || cwd === '') return;

  /** @type {any} */
  let trust;
  try {
    // 用**同步后**的文本：这一轮刚写的受管区不影响 [projects.*]，
    // 但用新文本能顺带避开"文件刚被创建"的边界。
    trust = readTrust(diff.changed ? diff.next : diff.current, cwd, ctx.platform);
  } catch {
    return; // 信任表本身有问题 → 交给 `cxt doctor` 报，exec 不在这里拦路
  }

  if (trust.state === 'trusted') return;

  const painter = makePainter({ isTTY: ctx.isTTY, env: ctx.env });
  const what = trust.state === 'untrusted'
    ? '这个目录被**显式标记为不信任**，codex 的审批档位会是 UnlessTrusted'
    : '这个目录**从未被标记过**，codex 会先问你信不信它';

  process.stderr.write(
    `${painter.yellow('cxt:')} ${what}\n`
    + `${painter.dim(`      ${cwd}`)}\n`
    + `${painter.dim('      cxt 不替你写信任记录（§2.9）；要预先标记用 `cxt trust <路径>`')}\n`,
  );

  // ★ 同一个目录、写法 Codex 认不出的条目——静默失配的元凶（§7.3），值得单独点出来
  for (const nm of trust.nearMisses) {
    process.stderr.write(
      `${painter.yellow('cxt:')} 第 ${nm.line} 行的 ${JSON.stringify(nm.path)} 指向同一个目录，`
      + `但写法 Codex 认不出（${nm.reason}）\n`,
    );
  }
}

// ───────────────────────────── `--print` ─────────────────────────────

/**
 * @param {any} resolved
 * @param {any} diff
 * @param {any} plan
 * @param {import('../types.js').Ctx} ctx
 */
function renderPlan(resolved, diff, plan, ctx) {
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  /** @type {string[]} */
  const out = [''];

  out.push(`  ${c.bold('cxt exec --print')}  ${c.dim('—')} 只打印，不启动`);
  out.push('');

  // ── 命令 ──
  out.push(`  ${c.bold('将要执行')}`);
  if (plan.shim) {
    const shim = cmdShimArgv(plan.codexBin, plan.codexArgs);
    out.push(`    ${c.dim('（经 cmd.exe——codex 是个 .cmd，Node 拒绝直接 spawn 它，§7.14⑥）')}`);
    out.push(`    ${comspecOf(ctx.env)} ${shim.args.slice(0, 3).join(' ')}`);
    out.push(`      ${shim.args[3]}`);
    // ★ 转不了的参数要在这里就说出来——`--print` 的意义正是"跑之前先看见"
    for (const w of shim.warnings) out.push(`    ${c.yellow('⚠')} ${w}`);
  } else {
    out.push(`    ${plan.codexBin} ${plan.codexArgs.join(' ')}`);
  }
  out.push('');

  // ★ 真跑时可能会换模型，而这里印的是配置顺序——**说清楚**，
  //   不然用户会以为"打印出来的就是跑起来的"（§5 的同一条原则）。
  //   只印一行，不联网（§2.5 边界③）。
  if (preflightApplies(resolved)) {
    out.push(`  ${c.dim('启动前校验已开启：真跑时会先拉一次 /models，挑第一个确实存在的候选；'
      + '--print 不联网，上面印的是配置顺序（§2.5）')}`);
    out.push('');
  }

  // ── 环境 ──
  out.push(`  ${c.bold('注入的环境')}${c.dim('（按名打码，§5）')}`);
  const masked = maskEnv(
    Object.fromEntries(Object.entries(plan.env).filter(([k]) => k === 'CODEX_HOME' || k in (resolved.env.value ?? {}) || k === resolved.envKeyName)),
  );
  out.push(table(['变量', '值'], Object.entries(masked)));
  // ★ 「看到的 = 跑起来的」是契约（§5）：要印的不只是**加了什么**，还有**删了什么**。
  //   用户配了 `env: { FOO: "" }` 却没看到这一行的话，"我明明设了 FOO 怎么没有"
  //   就无从解释——而 `--print` 存在的全部意义正是消掉这种疑问。
  if (plan.unset.length > 0) {
    out.push(`  ${c.dim(`删掉的继承变量：${plan.unset.join('、')}`)}`);
  }
  out.push(`  ${c.dim(`（调用方的会话标记已剔除（${SESSION_MARKER_ENV.length} 项，§2.6）；`
    + `另有 ${Object.keys(plan.env).length - Object.keys(masked).length} 个继承自当前进程的变量，未列出）`)}`);
  // ★ 「看到的 = 跑起来的」：会话 id 是启动那一刻现生成的，这里诚实交代它一定会出现。
  out.push(`  ${c.dim('真跑时还会注入 CXT_SESSION_ID——每次启动现生成的会话 id（§2.16）')}`);
  out.push('');

  // ── cwd ──
  out.push(`  ${c.bold('工作目录')}`);
  out.push(`    ${plan.cwd ?? c.dim('（无）')}`);
  out.push(`    ${c.dim(resolved.cwd.source === 'cli'
    ? '--cwd 显式给出 → 经 -C 交给 codex'
    : '进程 pwd → 不传 -C，codex 直接继承（§2.3 第五条）')}`);
  out.push('');

  // ── 受管区 ──
  out.push(`  ${c.bold('受管区')} ${c.dim(`profiles/${resolved.profileName}/config.toml`)}`);
  if (diff.report.created) {
    out.push(`  ${c.dim('（尚未创建；本次会写入）')}`);
  } else if (diff.changed) {
    out.push(`  ${c.yellow('⚠ 与当前文件不一致（漂移）——本次会就地修正')}`);
  } else {
    out.push(`  ${c.green('✓ 与当前文件一致（幂等）')}`);
  }
  out.push('');

  return out.join('\n');
}

const HELP = `cxt exec [<token>] [选项]

在**当前终端**启动 codex：同步受管区 → 注入环境 → 定位 codex → 交接终端。
不给 token 就是"纯 defaults 模式"（profile 落 _default）。

★ 这是 launch 脚本调用的那个命令（§2.12）——脚本里不内联 token，
  环境由 exec 在进程内注入，所以脚本本身不含任何密钥。

  <token>                token 的**名字**（不是密钥）
  --cwd <path>           显式指定工作目录（★ 只有给了它才传 -C）
  --model <id>           覆盖模型（走 -c 差量，不落盘）
  --token-value <v>      直接给密钥
  --url <u>              覆盖 baseUrl
  -c, --resume           转发 codex resume --last：续该目录最近一次会话
  --print                只打印将要执行的完整环境与命令，不启动
  -h, --help             本帮助

⚠️ 与 cxt run 的差别：
   · cwd 跳过 token.cwd，只用 --cwd 或进程 pwd（§2.3 第五条）
   · 不弹新窗口，就在当前终端跑（要新窗口用 cxt run）
`;

export const command = { spec, run };
