// @ts-check
/**
 * `cmt exec` —— **内部命令**（§5）：注入环境后 exec claude。
 *
 * 它是 §2.7 那条链的最后一环，也是**唯一真正启动 claude 的地方**：
 *
 *     cmt run relay-a
 *       └─ 新终端 → cmt exec relay-a --model <id>   ← 就是这里
 *            └─ 解析四要素 → 注入环境 → spawn claude（stdio 继承）
 *
 * 之所以拆成"外部 `run` 开窗口 + 窗口内 `exec` 注入"，是为了 §2.7 的那条铁律：
 * **launch 脚本不内联 token**。token 只有一个落盘点（`tokens/<name>.json`），
 * 不会在 profile 目录里多出第二份明文副本。
 *
 * 顺带一个跨平台红利（§2.9）：环境变量由 `spawn(cmd, args, { env })` 注入，
 * **不经过任何 shell**——于是绕开了 cmd / PowerShell / sh 三套引号与转义规则。
 *
 * token 位置参数**可选**：不给就是"纯 defaults 模式"（§2.3），
 * 用 `_default` 这个 profile。
 */
import { spawn } from 'node:child_process';

import { CmtError, EXIT, EnvError } from '../../core/errors.js';
import { profileNameFor } from '../../core/paths.js';
import { buildInjection, buildSessionEnv } from '../../core/resolve.js';
import { DEFAULT_SEED_MODE } from '../../core/seed.js';
import { seedProfile } from '../../core/store.js';
import { renderMissing } from '../../core/validate.js';
import { claudeSpawnSpec, locateClaude } from '../claude-bin.js';
import { preflightModels } from '../preflight.js';
import { claudePrintMode, pickOverrides, prepareSession, unresolvedBlocker } from '../session.js';
import { recordSessionEnd, recordSessionStart } from '../sessions.js';

export const execCommand = {
  spec: /** @type {any} */ ({
    boolean: ['help', 'continue'],
    string: ['model', 'url', 'token-value', 'auth-mode', 'claude-bin'],
    alias: { h: 'help', c: 'continue' },
  }),

  /**
   * @param {any} args
   * @param {import('../types.js').Ctx} ctx
   */
  async run(args, ctx) {
    if (args.help) {
      process.stdout.write(EXEC_HELP);
      return EXIT.OK;
    }

    // `cmt exec` 由新窗口调用，cwd 已由终端设好——所以解析目标就是进程当前目录，
    // 不提供 --cwd（改了也没用：claude 继承的是进程的 cwd，不是我们解析出来的那个值）。
    const tokenName = args._[0];
    const overrides = pickOverrides(args, undefined, tokenName);
    const session = prepareSession({ ctx, target: ctx.cwd, overrides, rest: args.rest });

    // 四要素不齐 → 不许启动（§2.1），且指名缺哪一项
    if (!session.check.ok) {
      throw new CmtError(renderMissing(session.check.missing));
    }

    // 四要素齐了，但**注入**仍可能失败——`unresolved` 是第二道闸门（§2.4）。
    // `validateSession()` 看不见的那一类：值非空、却不是合法的整串引用
    // （`"https://${H}/v1"`），四要素判定为"齐"，注入时才发现求不出值。
    // 少了 `ANTHROPIC_BASE_URL` 就悄悄退回一方端点、却还拿着中转站的 token——
    // 这正是 §2.4 说的"最难排查"，所以拦下而不是警告。
    const blocker = unresolvedBlocker(session.injection);
    if (blocker) throw blocker;

    // ── 启动前校验（§2.5 —— 不是故障转移）──────────────────────────
    //
    // ★ 位置是刻意的：**两道闸门之后、`locateClaude()` 之前**。
    //  - 闸门之后：引用求不出来时这次启动本来就要失败，不该再花 2 秒。
    //  - `locateClaude()` 之前：注入清单是它之后才组装 argv 的依据，换模型必须赶在那之前；
    //    而且"这次注定启动不了"时也就别联网了。
    //  - 播种在它**之后**：播种写的是 `.claude.json`，与用哪个模型无关，顺序无所谓；
    //    保持"只有一个网络点"在链条最前，排查时好定位。
    //
    // ★★ 换人了就**重算整份注入**：`ANTHROPIC_MODEL`、`--fallback-model`、五个别名槽
    //    全都在 `buildInjection()` 里从 `resolved` 现算，重算一次就全跟着走
    //    （契约 §2.5 那句「各 `slots` 的默认填充全部自动跟着走」靠的就是这条）。
    //    `--fallback-model` 因此天然变成"校验之后的 `models[1..]`"。
    //
    // ★ 用局部变量而不是回头改 `session`：下面每一个消费者都只该看见**这一次生效**的
    //   解析结果；把 `session` 就地改掉会让"prepareSession 给了什么"变得没人说得清。
    let resolved = session.resolved;
    let injection = session.injection;
    const pre = await preflightModels({ resolved, injection, enabled: resolved.preflight });
    if (pre.note !== null) process.stderr.write(`⚠ ${pre.note}\n`);
    if (pre.resolved !== resolved) {
      resolved = pre.resolved;
      injection = buildInjection(resolved, {
        home: ctx.home,
        env: ctx.env,
        print: claudePrintMode(args.rest),
      });
    }

    const claude = locateClaude({
      resolved,
      ctx,
      config: session.config,
      configExists: session.configExists,
      // 启动路径才写回缓存；`cmt resolve` 不碰配置
      persist: true,
    });
    for (const w of [...injection.warnings, ...claude.warnings]) {
      process.stderr.write(`⚠ ${w}\n`);
    }

    // ── 启动前播种（§3.6 —— §3.1 铁律的唯一例外）────────────────────
    // 位置是刻意的：**在 `locateClaude()` 之后、组装 argv 之前**。
    //  - 这里是 §2.7 那条链上唯一真正启动 claude 的地方，播种必须和启动同处，
    //    否则两者之间隔着的那段时间足够让 `.claude.json` 变样。
    //  - 排在 locateClaude 之后：启动注定要失败就别去动人家的文件。
    //  - `cmt run` **不播种**——它只开窗口，真正的 cwd 由这里说了算。
    //
    // 失败不拦启动：磁盘满 / JSON 坏了，正确的结局是"弹一次对话框"，
    // 不是"窗口打不开"。所以只看 warning，不抛。（`unresolvedBlocker` 那种
    // 必须拦的另当别论——它坏的是语义，这里坏的只是体验。）
    const seeded = seedProfile({
      home: ctx.home,
      profile: profileNameFor(session.resolved.tokenName.value),
      cwd: ctx.cwd,
      mode: session.config.defaults?.seed ?? DEFAULT_SEED_MODE,
      platform: ctx.platform,
    });
    if (seeded.warning) process.stderr.write(`⚠ ${seeded.warning}\n`);

    // ★ 用局部 `injection` 而**不是** `session.injection`：启动前校验换了人之后，
    // `--fallback-model` 与 `--name` 都可能在重算里变了。读回 session 就会拿旧的那份，
    // 结果是"模型换了、回退链还是老的"——静默，且只在 `--print` 模式下才看得见。
    const argv = [...injection.args];
    if (args.continue) argv.push('--continue');
    argv.push(...args.rest);

    const spec = claudeSpawnSpec(claude.path, argv, ctx);
    // 环境在这一步算**完**，交给 runChild 的是一份完整的环境（§2.6）：
    // 继承来的先剔会话标记、再删 cmt 明确不注入的、最后盖上注入项。
    let env = buildSessionEnv({ base: ctx.env, injection });

    // ── 在场层（§2.14 一）：写一条会话记录 ──
    //
    //   ★ 写者必须是 exec 自己：`cmt run` spawn 完就 detached + unref，
    //     根本看不到这个进程的生死（§2.14 一的来历）。
    //   ★ 失败**不阻塞**：recordSessionStart 内部兜住，只打一行警告——
    //     在场层坏了不许让窗口打不开。
    const sessionRecord = recordSessionStart(ctx, { resolved });
    if (sessionRecord !== null) {
      env = { ...env, CMT_SESSION_ID: sessionRecord.id };
    }

    const code = await runChild(spec, env);
    if (sessionRecord !== null) recordSessionEnd(ctx, sessionRecord.id, code);
    return code;
  },
};

const EXEC_HELP = `cmt exec [<token>] [选项] [-- <claude 参数...>]

内部命令：解析四要素 → 注入环境变量 → 启动 claude。
launch 脚本与 \`cmt run\` 都走这里，一般不用手敲。

不给 <token> 就是"纯 defaults 模式"（用 _default 这个 profile）。

选项
  --model <id>         覆盖模型（默认取 models[0]）
  --url <u>            覆盖 API 端点
  --token-value <v>    覆盖凭证
  --auth-mode token|key  token → ANTHROPIC_AUTH_TOKEN；key → ANTHROPIC_API_KEY
  --claude-bin <path>  指定 claude 可执行文件
  -c, --continue       转发 claude --continue：继续当前目录最近一次会话
  -- <参数...>         其余参数原样透传给 claude
`;

/**
 * 拉起 claude 并等它结束，把退出码原样带回。
 *
 * `stdio: 'inherit'` —— claude 是交互式 TUI，必须直接接管这个终端。
 *
 * `env` 是**算好的完整环境**，不是"注入项"：调用方已经用 `buildSessionEnv()`（§2.6）
 * 把继承环境净化完、把 `unset` 删掉、把注入项盖上去了。这里只负责原样交给 `spawn`。
 * （PATH / HOME 之类的当然还在——净化只动会话标记与 cmt 明确不注入的那几项，
 * 否则 claude 自己 spawn 子进程（node、git…）时会找不到东西。）
 *
 * @param {{ command: string, args: string[] }} spec
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<number>}
 */
function runChild(spec, env) {
  return new Promise((resolve) => {
    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        stdio: 'inherit',
        env,
      });
    } catch (err) {
      throw new EnvError(`启动 claude 失败（${spec.command}）：${/** @type {any} */ (err).message}`, {
        hint: '用 `cmt run --print` 看将要执行的命令，再手工跑一遍看看',
      });
    }

    child.on('error', (err) => {
      process.stderr.write(
        `✗ 启动 claude 失败（${spec.command}）：${err.message}\n` +
          '  用 `cmt run --print` 看将要执行的命令，再手工跑一遍看看\n',
      );
      resolve(EXIT.ENV);
    });

    child.on('exit', (code, signal) => {
      if (signal) {
        // 被信号带走 → 按 128 + signum 惯例回传，别谎报成 0
        resolve(128 + (SIGNALS[signal] ?? 15));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

/** 常见的几个信号编号（只为把退出码报准，不求穷尽） */
const SIGNALS = /** @type {Record<string, number>} */ ({
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGKILL: 9,
  SIGTERM: 15,
});
