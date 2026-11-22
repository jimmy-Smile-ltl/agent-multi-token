// @ts-check
/**
 * 命令分发（§4.1）。
 *
 * 分层纪律（§4.2）：**这里只读 `process.*` 的标量**——`argv` / `isTTY` / `env` / `cwd`，
 * 读完塞进 `ctx` 注入下去。core/ 拿到的 platform / home / env / cwd 全部由这里注入。
 *
 * ⚠️ 但**别在这儿碰 `stdin` / `stdout` 的流**：那是 `ui/term.js` 的事（§4.2）。
 *    这句话早先写的是"唯一读取 process.* 的地方"——§2.12 引入面板之后不再成立，
 *    读作上面这条。判据不是"读没读 process"，是"读的是不是**标量**"。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';

import { CmtError, EXIT, renderError } from '../core/errors.js';
import { parseArgs } from './parse-args.js';
import { USAGE, COMMANDS_HELP, EXAMPLES } from './help.js';
import { resolveCommand } from './commands/resolve.js';
import { runCommand } from './commands/run.js';
import { execCommand } from './commands/exec.js';
import { lsCommand } from './commands/ls.js';
import { bindCommand } from './commands/bind.js';
import { tokenCommand } from './commands/token.js';
import { modelCommand } from './commands/model.js';
import { slotCommand } from './commands/slot.js';
import { profileCommand } from './commands/profile.js';
import { doctorCommand } from './commands/doctor.js';
import { uiCommand } from './commands/ui.js';
import { usageCommand } from './commands/usage.js';
import { poolCommand } from './commands/pool.js';
import { sessionsCommand } from './commands/sessions.js';
import { msgCommand } from './commands/msg.js';
import { resumeCommand } from './commands/resume.js';
import { runWeb } from './commands/ui-web.js';

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

/** 已实现的命令。键 = 命令名，值 = { spec, run } */
const COMMANDS = /** @type {Record<string, import('./types.js').Command>} */ ({
  run: runCommand,
  exec: execCommand,
  resolve: resolveCommand,
  ls: lsCommand,
  bind: bindCommand,
  token: tokenCommand,
  model: modelCommand,
  slot: slotCommand,
  profile: profileCommand,
  doctor: doctorCommand,
  ui: uiCommand,
  usage: usageCommand,
  pool: poolCommand,
  sessions: sessionsCommand,
  msg: msgCommand,
  resume: resumeCommand,
});

/**
 * 尚未实现的命令 → 实施顺序（§4.4）第几步。
 * 有了这张表，任何阶段敲 `cmt xxx` 都能得到准确答复，而不是含混的"未知命令"。
 *
 * §5 的命令面已全部落地，这张表现在是空的——留着它，
 * 以后加新命令时先挂这儿，用户敲到就知道"还没做"而不是"敲错了"。
 * @type {Record<string, number>}
 */
const PENDING = {};

/**
 * 构造注入上下文——**core 层拿到的全部环境信息**。
 *
 * ★ 两个 TTY 字段是**标量**，所以在这里读、注入下去是合规的（§4.2）：
 *   - `isTTY`：上不上色看它（`format.js` 的 `makePainter`）
 *   - `stdinIsTTY`：`--pick` / 二次确认能不能用看它（§2.5）
 *   ⚠️ 判据一律写成 `=== true`，不要用真值判断：`undefined`（管道）与
 *      `false`（重定向到文件）在这里含义相同，但 `'0'` 之类的字符串不是。
 * @returns {import('./types.js').Ctx}
 */
function makeCtx(configPath) {
  return {
    platform: process.platform,
    home: os.homedir(),
    env: process.env,
    cwd: process.cwd(),
    isTTY: process.stdout.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    configPath,
  };
}

/**
 * ★ 抽取**全局** flag `--config <path>`（§2.11 一）。
 *
 * 为什么在 `dispatch()` 最前面抽，而不是让每个命令自己在 spec 里声明：
 *
 * 1. 它是**全局**的——`run` / `exec` / `resolve` / `doctor` / 面板都要认。
 *    每个 spec 各写一遍 = 总有一天漏一个，而症状是"`cmt resolve --config x`
 *    能用、`cmt doctor --config x` 说未知选项"。
 * 2. 抽出来塞进 `ctx.configPath`，于是它**不出现在任何命令的 `args` 里**——
 *    子命令想忽略它都做不到，这正是我们要的。
 *
 * ⚠️ `--` **之后一律不碰**：那里是透传给 claude 的，原样留给子命令
 * （`cmt run -- --config foo` 里的 `--config` 是 claude 的参数，不是 cmt 的）。
 *
 * ⚠️ 给了不止一次 → **报错**而不是"最后一个赢"：同时只认一份项目本地配置
 * （§2.11 一），静默取一个会让用户以为另一份也生效了。
 *
 * @param {string[]} argv
 * @returns {{ argv: string[], configPath: string | null }}
 */
function extractGlobalConfig(argv) {
  /** @type {string[]} */
  const rest = [];
  /** @type {string | null} */
  let configPath = null;

  /**
   * @param {string} v
   */
  const take = (v) => {
    if (configPath !== null) {
      throw new CmtError('`--config` 给了不止一次', {
        hint: `前一个是 ${JSON.stringify(configPath)}，又来了一个 ${JSON.stringify(v)}。`
          + '同时只认一份项目本地配置（§2.11 一）',
      });
    }
    configPath = v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--') {
      // `--` 之后全是透传给 claude 的，原样留下（连 `--` 自己）
      rest.push(...argv.slice(i));
      break;
    }
    if (a === '--config') {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new CmtError('`--config` 后面要跟一个路径', {
          hint: '例：cmt resolve --config ./sub/.cmt.json',
        });
      }
      take(v);
      i++;                       // 吃掉值，别让它漏进子命令的 argv
      continue;
    }
    if (a.startsWith('--config=')) {
      const v = a.slice('--config='.length);
      if (v === '') {
        throw new CmtError('`--config=` 后面要跟一个路径', {
          hint: '例：cmt resolve --config=./sub/.cmt.json',
        });
      }
      take(v);
      continue;
    }

    rest.push(a);
  }

  return { argv: rest, configPath };
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>} 退出码
 */
export async function main(argv) {
  try {
    return await dispatch(argv);
  } catch (err) {
    if (err instanceof CmtError) {
      process.stderr.write(renderError(err) + '\n');
      return err.code;
    }
    throw err;
  }
}

/**
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
async function dispatch(argv) {
  // ★ 全局 flag 先抽掉——`cmt --config x run relay-a` 这种写法因此也能用（§5）
  const { argv: rest, configPath } = extractGlobalConfig(argv);

  // 顶层只认 --help / --version，其余交给子命令（子命令有自己的 spec）
  const head = rest[0];

  if (head === undefined) {
    // ★ 裸 `cmt`（§2.12 一）：在终端里就是**网页控制台**，其余一律退回打印用法。
    //
    // 判据是**两个 TTY 都得是**——只 stdout 是 TTY 的话（`cmt | tee`）进任何
    // 交互前端都会立刻卡在一个没人能敲的 stdin 上。网页控制台虽然不读 stdin，
    // 但它会起一个**活到被关掉为止**的服务器；管道里的 `cmt` 必须立刻退出。
    //
    // ⚠️ 这里**刻意不看 `CMT_UI`**（§2.12 七）：那个变量的意思是"面板换一种画法"，
    //    不是"把非交互的 `cmt` 变成一个会等输入的程序"。CI 脚本里
    //    `export CMT_UI=plain` 之后，`cmt` 必须仍然立刻退出——否则
    //    "脚本里的行为一个字都没变"这句承诺就是假的。要逐行面板得显式 `cmt ui`。
    //
    // ★ 为什么直接调 `runWeb()` 而不是 `uiCmd.run()`：`ui.js` 的 `run()` 默认
    //   进全屏 TUI，而裸命令的默认已经换成网页控制台了。给 `ui.js` 加一个
    //   "我这次是裸命令"的旗标，等于让同一个默认值有两处定义——这里调谁，
    //   那里就是谁。`--web` 那条路（`cmt ui --web`）仍然归 `ui.js` 管。
    if (process.stdout.isTTY === true && process.stdin.isTTY === true) {
      return await runWeb(makeCtx(configPath));
    }
    process.stdout.write(USAGE + COMMANDS_HELP + EXAMPLES);
    return EXIT.OK;
  }
  if (head === '-h' || head === '--help' || head === 'help') {
    process.stdout.write(USAGE + COMMANDS_HELP + EXAMPLES);
    return EXIT.OK;
  }
  if (head === '-v' || head === '--version' || head === 'version') {
    process.stdout.write(`${pkg.version}\n`);
    return EXIT.OK;
  }
  if (head.startsWith('-')) {
    throw new CmtError(`未知选项 ${head}`, { hint: '用 `cmt --help` 查看用法' });
  }

  const cmd = COMMANDS[head];
  if (!cmd) {
    if (PENDING[head] !== undefined) {
      throw new CmtError(`命令 \`cmt ${head}\` 尚未实现（实施顺序 §4.4 第 ${PENDING[head]} 步）`, {
        hint: '当前可用：cmt resolve / cmt --help',
      });
    }
    throw new CmtError(`未知命令 \`${head}\``, { hint: '用 `cmt --help` 查看全部命令' });
  }

  const args = parseArgs(rest.slice(1), cmd.spec);
  return await cmd.run(args, makeCtx(configPath));
}
