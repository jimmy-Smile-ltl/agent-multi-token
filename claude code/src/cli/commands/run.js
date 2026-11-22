// @ts-check
/**
 * `cmt run` —— 主命令（§5）：解析四要素 → 校验 → 探测终端 → 开新窗口。
 *
 * ─────────────────────────────────────────────────────────────
 * **数据流（§2.7）**：
 *
 *     cmt run relay-a
 *       ├─ 1. 解析四要素（§2.3 级联），记录每项来源层
 *       ├─ 2. 完整性校验 → 缺项则报错指名（§2.1）
 *       ├─ 3. 探测终端 → spawnTerminal({ title, cwd, argv })，argv 是数组、无脚本
 *       │     └─ 兜底路径才落盘 profiles/<t>/launch.{cmd,sh}
 *       └─ 4. 无状态写入（不记忆选择）
 *
 * **无状态**（§2.8）：本命令不记忆"上次用了哪个模型"——
 * `models[0]` 已经确定了默认值（§2.5 规则 2），记忆只会让"为什么这次跑的是这个模型"变难猜。
 * ─────────────────────────────────────────────────────────────
 */
import { fileURLToPath } from 'node:url';

import { CmtError, EXIT } from '../../core/errors.js';
import { buildLaunchScript, urlCarriesCredential } from '../../core/launch-script.js';
import { launchScriptPath, profileDir, profileNameFor } from '../../core/paths.js';
import { stripSessionMarkers } from '../../core/resolve.js';
import { ensureDir, writeFileAtomic } from '../../core/store.js';
import { renderMissing } from '../../core/validate.js';
import { resolveTerminal, spawnTerminal } from '../../platform/index.js';
import { locateClaude } from '../claude-bin.js';
import { fieldText, maskEnv, modelText, renderRows, sourceTag } from '../format.js';
import { pickModel } from '../pick.js';
import { pickFromPool } from '../pool-pick.js';
import { pickOverrides, prepareSession, terminalTitle, unresolvedBlocker } from '../session.js';

/** cmt 入口的绝对路径——写进 launch 脚本，不依赖 PATH（§2.10 契约 1） */
const CMT_ENTRY = fileURLToPath(new URL('../../../bin/cmt.js', import.meta.url));

export const runCommand = {
  spec: /** @type {any} */ ({
    boolean: ['help', 'print', 'pick', 'window', 'tab', 'continue', 'pool'],
    string: ['cwd', 'model', 'url', 'token-value', 'auth-mode', 'claude-bin', 'token'],
    alias: { h: 'help', c: 'continue' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    if (args.help) {
      process.stdout.write(RUN_HELP);
      return EXIT.OK;
    }

    // `cmt run --token-value` **在启动路径上无法兑现**，所以直接拒绝而不是静默忽略。
    // 新窗口里的 `cmt exec` 只能从命令行拿到这个值，而那条命令行要么写进
    // `profiles/<t>/launch.{cmd,sh}`、要么作为终端 argv 留在进程参数里——
    // 两条都给凭证添了"第二个落盘点"，正是 §2.7 铁律要避免的。
    // 一次性凭证有 `cmt exec --token-value`（已在窗口里，直接注入进程环境），
    // 要复用的凭证有 `cmt token add`（token 文件是它唯一的设计归宿）。
    if (args['token-value'] !== undefined) {
      throw new CmtError('`cmt run` 不支持 --token-value：凭证没法跨进程送进新窗口而不落盘（§2.7）', {
        hint:
          '改用其中一条：\n' +
          '  · 要一次性用：`cmt exec --token-value <v>`（在当前窗口直接注入）\n' +
          '  · 要反复用：`cmt token add <name> --token <v>`，然后 `cmt run <name>`\n' +
          '  · 只想看它会解析成什么：`cmt resolve --token-value <v>`',
      });
    }

    // `--url` 一般可以内联（它是非密钥的覆盖项），但 **userinfo 是例外**：
    // `https://user:pass@host/…` 里的 `user:pass` 就是凭证，内联它等于把密钥写进
    // `profiles/<t>/launch.{cmd,sh}`（§2.7 铁律）。所以与 `--token-value` 同样处理：
    // 拒绝，而不是警告——这个文件会一直躺在磁盘上，而"改一下写法"的成本几乎为零。
    // 注意 `--url '${RELAY_URL}'` 这类**引用**不受影响：引用不是密钥（见 urlCarriesCredential）。
    if (args.url !== undefined && urlCarriesCredential(args.url)) {
      throw new CmtError('`cmt run --url` 的值里带了凭证（userinfo），写进 launch 脚本就等于落盘（§2.7）', {
        hint:
          '换一种给法，三种都不落盘：\n' +
          '  · 写成引用：`cmt run --url \'${RELAY_BASE_URL}\'`（推荐，端点留在环境变量里）\n' +
          '  · 写进 token 配置：`cmt token edit <token> --base-url <u>`（token 文件本就是密钥的归宿）\n' +
          '  · 只在当前窗口用一次：`cmt exec --url <u>`（注入进程环境，不落盘）',
      });
    }

    const plan = await planLaunch(args, ctx);

    // ── --print：打印将要执行的完整环境与命令，不启动（§5）────────
    // 注意这**不是** claude 的 --print——那是 `cmt run -- --print`，走 args.rest。
    if (args.print) {
      // §2.10 ③：--print 也落一份脚本，好让打印出来的那个路径**可以手工重跑**
      writeFileAtomic(plan.script.path, plan.script.content, { mode: plan.script.mode });
      process.stdout.write(
        `${renderPrint({ session: plan.session, claude: plan.claude, spec: plan.spec, script: plan.script, argv: plan.argv, title: plan.title, poolNote: plan.poolNote })}\n`,
      );
      return EXIT.OK;
    }

    startLaunch(plan, ctx);
    return EXIT.OK;
  },
};

// ─────────────────── 装配 → 启动：面板复用这两步 ───────────────────

/**
 * 解析四要素 → 两道闸门 → 定位 claude → 探测终端 → 算出 launch 脚本规格。
 * **不写盘、不 spawn**——那是 `startLaunch()` 的事。
 *
 * ★ 抽出来是为了 `cmt ui` 面板（§2.12）：面板的 `Enter` 必须与 `cmt run` 走**同一条**
 *   路，否则"面板说会这么启动"与"命令行真的那么启动"迟早漂移。面板只喂两样东西
 *   （见 `commands/ui.js`）：token 名与路径——而它们映射到的正是
 *   `cmt run <token> --cwd <path>`，不多不少。
 *
 * @param {any} argv 与 `cmt run` 的 `args` **同形**（位置参数 token 在 `argv._[0]`）。
 *   ⚠️ 收同形对象而不是拆成几个字段：`pickOverrides()` 认的是这一整张表
 *   （`token` / `model` / `url` / `token-value` / `auth-mode` / `claude-bin` / `window` / `tab`），
 *   在这里先拆一遍再拼回去，就是同一件事的第二处实现。
 * @param {import('../types.js').Ctx} ctx
 * @param {{ path?: string, quiet?: boolean }} [opts] `path` = 面板选中的路径，等价于 `--cwd`；
 *   `quiet` = 别往 stderr 写进度行（面板传它：备用屏上写一行会横穿某一帧）。命令行调用都不传。
 * @returns {Promise<any>} `startLaunch()` / `renderPrint()` 要的一切
 */
export async function planLaunch(argv, ctx, opts = {}) {
  // 位置参数是 **token 名**（`cmt run relay-a`），不是路径——要指目录用 --cwd
  const tokenName = argv._?.[0];
  // 两者要分开：`explicitCwd` 决定四要素里的"本地路径"从哪一层来（§2.3），
  // 而绑定匹配**永远**得有个具体目录可匹配。
  const explicitCwd = argv.cwd ?? opts.path;
  const matchTarget = explicitCwd ?? ctx.cwd;
  const rest = argv.rest ?? [];
  let overrides = pickOverrides(argv, explicitCwd, tokenName);

  let session = prepareSession({ ctx, target: matchTarget, overrides, rest });

  // ── ★ token 池（§2.13 三）：**先**把 token 这一格填上，再做缺项检查 ──
  // 顺序不能反：没有 token 的时候，下一行会立刻报"四要素缺 authToken"，
  // 而池存在的意义正是"让这一次不缺"。挑选只在两种情况下发生
  // （补空位 / `--pool`），判断全在 `pickFromPool()` 里。
  // ★ `notify` 走 stderr：探测进度是**过程**信息，不该混进 `--print` 的正文；
  //   面板传 `quiet: true`——备用屏上写一行 stderr 会横穿某一帧。
  const picked = await pickFromPool(ctx, session, argv, {
    target: matchTarget,
    overrides,
    rest,
    notify: opts.quiet === true ? undefined : (line) => process.stderr.write(`  ${line}\n`),
  });
  const poolNote = picked?.note ?? null;
  if (picked !== null) {
    session = picked.session;
    // ★ 池换掉了 token，`overrides` 也要跟着换：后面 `--pick` 重装配时若不带上它，
    //   挑出来的 token 会**当场消失**（回到"没有 token"再报一次缺项）。
    overrides = { ...overrides, token: picked.session.resolved.tokenName.value };
  }

  // ── 2. 四要素完整性（§2.1）：缺任何一项都不许启动，且指名缺哪一项 ──
  if (!session.check.ok) {
    throw new CmtError(renderMissing(session.check.missing));
  }

  // 与 `cmt exec` 同一道第二闸门（§2.4）：四要素判定为"齐"、注入却失败的那些
  // （值非空但不是合法整串引用）。在这里就拦下，好让错误落在**当前**这个终端里，
  // 而不是新窗口一闪而过。`--pick` 只换 model，改不了 baseUrl / authToken，故排它之前。
  const blocker = unresolvedBlocker(session.injection);
  if (blocker) throw blocker;

  // ── --pick：唯一会交互提问的地方（§2.5 规则 2 默认不提问）──────
  if (argv.pick) {
    const chosen = await pickModel(session.resolved.models.value, ctx);
    // 挑中的模型要重新装配一遍，好让 slots 也按它重算（§2.5 默认槽位跟着 models[0]）
    overrides = { ...overrides, model: chosen };
    session = prepareSession({ ctx, target: matchTarget, overrides, rest });
  }

    // ── 预检 claude：现在就报错，别让新窗口一闪而过 ────────────────
    // （真正启动 claude 的是新窗口里的 `cmt exec`，但在这里先探一次，
    //   失败信息才能落在用户当前这个终端里）
    const claude = locateClaude({
      resolved: session.resolved,
      ctx,
      config: session.config,
      configExists: session.configExists,
      // --print 是干跑，不该改配置
      persist: !argv.print,
    });

    const { resolved } = session;
    const effectiveToken = resolved.tokenName.value;
    const model = resolved.models.value[0]?.id ?? null;

    // ── 3. 组装新窗口要跑的命令行 ──────────────────────────────────
    // 与 launch 脚本**逐字一致**（§2.10）：脚本是这条命令的忠实序列化，
    // 所以"手工重跑脚本"与"cmt run"不会跑出两套语义。
    //
    // 只转发**命令行上真给了的**覆盖项，不转发 `resolved` 里的解析结果——
    // 内层 `cmt exec` 会照着同样的配置自己再解析一遍，把配置层的结果抄进
    // 脚本反而会让 profile 目录里多出一份配置副本（§2.7）。
    // `--url` 给的是引用串（`${RELAY_BASE_URL}`）时也照转：引用跨得过进程边界，
    // 密钥跨不过——求值发生在新窗口里（§2.4）。
    /** @type {string[]} */
    const innerArgv = [process.execPath, CMT_ENTRY, 'exec'];
    if (effectiveToken) innerArgv.push(effectiveToken);
    if (model) innerArgv.push('--model', model);
    if (argv.url !== undefined) innerArgv.push('--url', argv.url);
    if (argv['auth-mode'] !== undefined) innerArgv.push('--auth-mode', argv['auth-mode']);
    if (argv.continue) innerArgv.push('-c');
    if (rest.length > 0) innerArgv.push('--', ...rest);

    const title = terminalTitle(effectiveToken, resolved.cwd.value);
    const scriptPath = launchScriptPath(
      ctx.home,
      profileNameFor(effectiveToken),
      ctx.platform,
    );

    const spec = resolveTerminal(
      {
        title,
        cwd: resolved.cwd.value,
        argv: innerArgv,
        mode: resolved.terminalMode.value,
        scriptPath,
      },
      ctx,
    );

    const script = buildScript({ spec, resolved, effectiveToken, model, args: argv, ctx, scriptPath });

    return { session, claude, spec, script, argv: innerArgv, title, effectiveToken, model, resolved, poolNote };
}

/**
 * 落盘（仅兜底路径）→ 建 profile 目录 → 开新窗口 → 打回执。
 *
 * ★ 与 `planLaunch()` 分成两半，是为了 `cmt run --print`：它只要前一半
 *   （**不** spawn、**不**建 profile 目录，只落一份脚本好让人手工重跑）。
 *   合起来写的话 `--print` 就得自己再走一遍后半段——那正是"两处各写一半"。
 *
 * @param {any} plan `planLaunch()` 的返回值
 * @param {import('../types.js').Ctx} ctx
 */
export function startLaunch(plan, ctx) {
  const { spec, script, resolved, effectiveToken, model, title, claude, poolNote } = plan;

  // ── 4. 落盘与启动 ──────────────────────────────────────────────
  // 首选路径（via === 'direct'）**不生成脚本**——argv 一路是数组，
  // 无 shell 解析、无转义、无代码页问题（§2.10）。
  if (spec.via === 'script') {
    writeFileAtomic(script.path, script.content, { mode: script.mode });
    for (const w of script.warnings) process.stderr.write(`⚠ ${w}\n`);
  }

  // §3.2：profile 目录由 cmt 在首次 run 时建；其余内容归 Claude Code（§3.1 铁律）
  ensureDir(profileDir(ctx.home, profileNameFor(effectiveToken)));

  // 环境：**只剔会话标记，不盖注入项**（§2.6）。
  // 标签页的环境只是个载体——把 injection.env 塞进来等于让 token 在窗口的 shell 里
  // 多出一份，还把 `${VAR}` 的求值点从"新窗口里"挪到了这一侧，与 §2.7 的铁律冲突。
  // 真正的 claude 环境由窗口内的 `cmt exec` 用 buildSessionEnv() 算。
  spawnTerminal(spec, stripSessionMarkers(ctx.env));

  process.stdout.write(`${renderLaunched({ spec, resolved, effectiveToken, model, title, claude, poolNote })}\n`);
}

const RUN_HELP = `cmt run [<token>] [选项] [-- <claude 参数...>]

按当前目录解析四要素，启动 Claude Code（默认在 cmt 专属窗口里开新标签页）。
不带 <token> 就按当前目录匹配路径绑定——这就是"不同路径不同 token"的入口。

选项
  --cwd <path>         指定工作目录（也是绑定匹配的目标）
  --model <id>         覆盖模型（默认取 models[0]）
  --url <u>            覆盖 API 端点（接受 \${ENV_VAR} 整串引用）
  --auth-mode token|key  token → ANTHROPIC_AUTH_TOKEN；key → ANTHROPIC_API_KEY
  --claude-bin <path>  指定 claude 可执行文件
  --pick               从模型优先级列表里交互挑一个（默认不问，直接取 models[0]）
  -c, --continue       转发 claude -c：继续该目录最近一次会话
  --pool               无视绑定/配置，从 token 池里挑一个（§2.13 三）
                       与 -c 同用时只认"上次在这个目录挑过的那个"——换一个
                       等于开新会话，所以宁可报错也不静默续到别的身份上
  --window | --tab     覆盖 defaults.terminalMode：
                       tab（默认）= 在名为 cmt 的专属窗口里开新标签页
                       window     = 每次都开一个新窗口
  --print              只打印将要执行的完整环境与命令，不启动
  -- <参数...>         其余参数原样透传给 claude

不支持 --token-value
  凭证没法跨进程送进新窗口而不落盘（§2.7）。要一次性用就 \`cmt exec --token-value <v>\`，
  要反复用就 \`cmt token add <name> --token <v>\`。

不支持带 userinfo 的 --url
  \`https://user:pass@host/…\` 里的 user:pass 就是凭证，内联进 launch 脚本等于落盘（§2.7）。
  改成 \${ENV_VAR} 引用、写进 token 配置，或改用 \`cmt exec --url <u>\`。

模型挂了怎么办（§2.5 人工故障转移）
  cmt model next        把下一个候选提为 models[0]
  cmt run -c            新标签页，claude -c 续上该目录刚才那次会话
`;

/**
 * 生成 launch 脚本规格。**只在 `via === 'script'` 或 `--print` 时才会被调用**（§2.10）。
 *
 * 只传**命令行上的**覆盖项（`--url` / `--auth-mode`），不传解析结果：
 * 脚本要能被手工重跑，就必须复现"同一个命令行"，而不是把这次解析的产物钉死。
 * `--token-value` 不在此列——它压根不该走到这里（`run()` 开头就拒了，§2.7）；
 * 带 userinfo 的 `--url` 同理（同上，`urlCarriesCredential()`）。
 *
 * @param {any} p
 */
function buildScript({ spec, resolved, effectiveToken, model, args, ctx, scriptPath }) {
  const built = buildLaunchScript({
    platform: ctx.platform,
    home: ctx.home,
    tokenName: effectiveToken,
    nodePath: process.execPath,
    cmtPath: CMT_ENTRY,
    model,
    url: args.url ?? null,
    authMode: args['auth-mode'] ?? null,
    cwd: resolved.cwd.value,
    cont: Boolean(args.continue),
    // 走脚本 = 终端给不了 cwd / 只能吃命令字符串，所以 cd 只能写进脚本（§2.10 ①②）
    needCd: spec.via === 'script',
  });
  // 路径由 paths.js 算（唯一来源），这里只是断言两者一致，避免以后漂移
  if (built.path !== scriptPath) {
    throw new CmtError(`launch 脚本路径不一致：${built.path} ≠ ${scriptPath}`, {
      hint: '这是内部错误：launchScriptPath() 与 buildLaunchScript() 应当同源',
    });
  }
  return built;
}

// ───────────────────────────── 输出 ─────────────────────────────

/**
 * 启动成功的回执。
 * @param {any} p
 */
function renderLaunched({ spec, resolved, effectiveToken, model, title, claude, poolNote }) {
  /** @type {[string, string][]} */
  const rows = [
    ['会话名', title],
    ['目录', resolved.cwd.value],
    ['token', effectiveToken ?? '（纯 defaults 模式）'],
    ['模型', model ?? '（不注入，用 Claude Code 自身默认）'],
    ['终端', `${spec.terminal}（${spec.via === 'direct' ? '直接拉起' : 'launch 脚本兜底'}）`],
    ['claude', claude.path],
  ];
  const isWindow = resolved.terminalMode.value === 'window';
  // 落在哪个窗口由适配器说了算：Windows 是 `wt -w cmt`，macOS / Linux 没有"命名窗口"这回事，
  // 它们的 spec 不带 windowName（§2.9 二·1）。所以这里**不许硬写 'cmt'**。
  let where = '✓ 已在新标签页启动';
  if (isWindow) where = '✓ 已在新窗口启动';
  else if (spec.windowName) where = `✓ 已在 ${spec.windowName} 窗口的新标签页启动`;

  /** @type {string[]} */
  const out = [where, renderRows(rows)];
  // ★ 池挑出来的那一格要说一句：上面那行「token relay-a」长得和"你点名要了它"一模一样，
  //   而这一次是**池替你挑的**——不说，用户下次就会以为自己的绑定生效了（§2.13 三）。
  if (poolNote !== null) out.push(`  ℹ ${poolNote}`);
  for (const w of spec.warnings) out.push(`  ⚠ ${w}`);
  if (spec.via === 'direct') {
    out.push(
      isWindow
        ? '  ℹ 窗口标题应显示为上面那个「会话名」——一眼就能认出是哪个 token / 哪个项目'
        : '  ℹ 标签页标题应显示为上面那个「会话名」——多个 token 的标签页一眼就能分辨',
    );
  }
  return out.join('\n');
}

/**
 * `--print` 的输出（§5：打印**将要执行的完整环境与命令**，不实际启动）。
 * @param {any} p
 */
function renderPrint({ session, claude, spec, script, argv, title, poolNote }) {
  const { resolved, injection } = session;
  /** @type {string[]} */
  const out = ['', '（--print：以下都不会真的执行）', ''];

  out.push('四要素');
  out.push(
    renderRows([
      ['本地路径', `${resolved.cwd.value}   ${sourceTag(resolved.cwd)}`],
      ['token', `${resolved.tokenName.value ?? '（无 —— 纯 defaults 模式）'}   ${sourceTag(resolved.tokenName)}`],
      ['apiUrl', `${fieldText(resolved.baseUrl)}   ${sourceTag(resolved.baseUrl)}`],
      ['model', `${modelText(resolved.models)}   ${sourceTag(resolved.models)}`],
    ]),
  );
  // ★ 挑的那一格已经在上面标了「← token 池」，这一行补的是**挑的理由**
  //   （探测结果或"缓存：…"）——否则读者只知道"是池挑的"，不知道"凭什么是它"（§2.13 三）。
  if (poolNote !== null) out.push(`  ℹ ${poolNote}`);

  out.push('');
  out.push('将要注入的环境');
  out.push(renderRows(Object.entries(maskEnv(injection.env))));
  for (const u of injection.unresolved) out.push(`  ⚠ ${u.envVar} 未注入：${u.reason}`);
  // 环境是继承来的：只说"加什么"，读者就答不出"我明明没配 ANTHROPIC_MODEL，它从哪来的"（§2.6）
  if (injection.unset.length > 0) {
    out.push('');
    out.push('将从继承的环境里删掉');
    out.push(`  ${injection.unset.join('  ')}`);
  }

  out.push('');
  out.push('终端命令');
  out.push(`  ${spec.command} ${spec.args.map(quoteIfNeeded).join(' ')}`);

  out.push('');
  out.push('新窗口内执行的命令');
  out.push(`  ${argv.map(quoteIfNeeded).join(' ')}`);
  out.push(`  （claude 侧参数由 cmt exec 追加：${injection.args.join(' ')}）`);

  out.push('');
  out.push('launch 脚本');
  out.push(`  ${script.path}`);
  out.push(
    spec.via === 'script'
      ? '  （已落盘——这个终端只能吃命令字符串 / 给不了 cwd，必须靠脚本）'
      : '  （首选路径本来不需要脚本；--print 仍落了一份，方便手工重跑）',
  );

  const notes = [...resolved.warnings, ...injection.warnings, ...spec.warnings, ...script.warnings];
  if (notes.length > 0) {
    out.push('');
    for (const n of notes) out.push(`  ⚠ ${n}`);
  }
  out.push('');
  out.push(`  会话名 ${title} · claude ${claude.path}`);
  out.push('');
  return out.join('\n');
}

/**
 * @param {string} s
 */
function quoteIfNeeded(s) {
  return /[\s"']/.test(s) ? JSON.stringify(s) : s;
}
