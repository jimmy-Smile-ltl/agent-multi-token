// @ts-check
/**
 * 命令分发（§4.1）。
 *
 * 分层纪律（§4.2）：**这里是唯一读取 process.* 的地方**。
 * core/ 拿到的 platform / home / env / cwd 全部由这里注入。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';

import { CxtError, EXIT, renderError } from '../core/errors.js';
import { parseArgs } from './parse-args.js';
import { USAGE, COMMANDS_HELP, EXAMPLES } from './help.js';
import { command as resolveCmd } from './commands/resolve.js';
import { command as execCmd } from './commands/exec.js';
import { command as runCmd } from './commands/run.js';
import { command as doctorCmd } from './commands/doctor.js';
import { command as tokenCmd } from './commands/token.js';
import { command as lsCmd } from './commands/ls.js';
import { command as bindCmd } from './commands/bind.js';
import { command as modelCmd } from './commands/model.js';
import { command as trustCmd } from './commands/trust.js';
import { command as profileCmd } from './commands/profile.js';
import { command as uiCmd } from './commands/ui.js';
import { command as usageCmd } from './commands/usage.js';
import { command as poolCmd } from './commands/pool.js';
import { command as sessionsCmd } from './commands/sessions.js';
import { command as msgCmd } from './commands/msg.js';
import { command as resumeCmd } from './commands/resume.js';
import { runWeb } from './commands/ui-web.js';

const pkg = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

/** 已实现的命令。键 = 命令名，值 = { spec, run } */
const COMMANDS = /** @type {Record<string, import('./types.js').Command>} */ ({
  resolve: resolveCmd,
  exec: execCmd,
  run: runCmd,
  doctor: doctorCmd,
  token: tokenCmd,
  ls: lsCmd,
  bind: bindCmd,
  model: modelCmd,
  trust: trustCmd,
  profile: profileCmd,
  ui: uiCmd,
  usage: usageCmd,
  pool: poolCmd,
  sessions: sessionsCmd,
  msg: msgCmd,
  resume: resumeCmd,
});

/**
 * 尚未实现的命令 → 实施顺序（§4.4）第几步。
 * 有了这张表，任何阶段敲 `cxt xxx` 都能得到准确答复，而不是含混的"未知命令"。
 *
 * 每落地一个命令就从这里删一条。全部清空 = §4.4 走完。
 * @type {Record<string, number>}
 */
const PENDING = {};

/**
 * 构造注入上下文——**core 层拿到的全部环境信息**。
 * @param {string | null} configPath `--config` 给的路径（§2.13 一），没给就是 `null`
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
 * ★ 抽取**全局** flag `--config <path>`（§2.13 一）。
 *
 * ### 为什么在 `dispatch()` **之前**抽
 *
 * 1. 它是**全局**的——`run` / `exec` / `resolve` / `doctor` / `model` / 面板都要认。
 *    让每个命令的 spec 各写一遍，迟早漏掉一两个，而漏掉的表现是
 *    "`--config` 在这个命令上不生效"——静默、且只在那个命令上复现。
 * 2. 抽出来之后子命令的 `parseArgs()` 根本看不到它，也就不会把它当
 *    "未知选项"报掉（各命令的 spec 里**不该**再声明它）。
 *
 * ### ⚠️ 扫到第一个 `--` 就停
 *
 * `cxt run relay-a -- --config foo` 里的 `--config foo` 是**给 codex 的**，
 * 不是给 cxt 的（`--` 之后一律透传，§2.7）。少了这一条，
 * 用户想给 codex 传 `--config` 就会把自己的 cxt 解析指向一个乱七八糟的文件。
 *
 * ### 重复给就报错
 *
 * 后一个静默盖掉前一个属于隐式魔法——用户会以为两个都生效了。
 *
 * @param {string[]} argv 完整 argv（**含命令名**）
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
      throw new CxtError('`--config` 给了不止一次', {
        hint: `前一个是 ${JSON.stringify(configPath)}，又来了一个 ${JSON.stringify(v)}。`
          + '同时只认一份项目本地配置（§2.13 一）',
      });
    }
    configPath = v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--') {
      // `--` 之后全是透传给 codex 的，原样留下（连 `--` 自己）
      rest.push(...argv.slice(i));
      break;
    }
    if (a === '--config') {
      const v = argv[i + 1];
      if (v === undefined) {
        throw new CxtError('`--config` 后面要跟一个路径', {
          hint: '例：cxt resolve --config ./sub/.cxt.json',
        });
      }
      take(v);
      i++;                       // 吃掉值，别让它漏进子命令的 argv
      continue;
    }
    if (a.startsWith('--config=')) {
      const v = a.slice('--config='.length);
      if (v === '') {
        throw new CxtError('`--config=` 后面要跟一个路径', {
          hint: '例：cxt resolve --config=./sub/.cxt.json',
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
    if (err instanceof CxtError) {
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
  // ★ 全局 flag 先抽掉——`cxt --config x run relay-a` 这种写法因此也能用（§5）
  const { argv: rest, configPath } = extractGlobalConfig(argv);

  // 顶层只认 --help / --version，其余交给子命令（子命令有自己的 spec）
  const head = rest[0];

  if (head === undefined) {
    // ★ 裸 `cxt`（§2.14 一）：在终端里就是**网页控制台**，其余一律退回打印用法。
    //
    // 判据是**两个 TTY 都得是**——只 stdout 是 TTY 的话（`cxt | tee`）进任何
    // 交互前端都会立刻卡在一个没人能敲的 stdin 上。网页控制台虽然不读 stdin，
    // 但它会起一个**活到被关掉为止**的服务器；管道里的 `cxt` 必须立刻退出。
    //
    // ⚠️ 这里**刻意不看 `CXT_UI`**：那个变量的意思是"面板换一种画法"，
    //    不是"把非交互的 `cxt` 变成一个会等输入的程序"。CI 脚本里
    //    `export CXT_UI=plain` 之后，`cxt` 必须仍然立刻退出——否则
    //    "脚本里的行为一个字都没变"这句承诺就是假的。要逐行面板得显式
    //    `cxt ui`。
    //
    // ★ 为什么直接调 `runWeb()` 而不是 `uiCmd.run()`：`ui.js` 的 `run()` 默认
    //   进全屏 TUI，而裸命令的默认已经换成网页控制台了。给 `ui.js` 加一个
    //   "我这次是裸命令"的旗标，等于让同一个默认值有两处定义——这里调谁，
    //   那里就是谁。`--web` 那条路（`cxt ui --web`）仍然归 `ui.js` 管。
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
    throw new CxtError(`未知选项 ${head}`, { hint: '用 `cxt --help` 查看用法' });
  }

  const cmd = COMMANDS[head];
  if (!cmd) {
    if (PENDING[head] !== undefined) {
      throw new CxtError(`命令 \`cxt ${head}\` 尚未实现（实施顺序 §4.4 第 ${PENDING[head]} 步）`, {
        hint: '用 `cxt --help` 查看全部命令',
      });
    }
    throw new CxtError(`未知命令 \`${head}\``, { hint: '用 `cxt --help` 查看全部命令' });
  }

  const args = parseArgs(rest.slice(1), cmd.spec);
  return await cmd.run(args, makeCtx(configPath));
}
