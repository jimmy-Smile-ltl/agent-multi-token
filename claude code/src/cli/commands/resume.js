// @ts-check
/**
 * `cmt resume <会话 id 或前缀>` —— 把关掉 / 崩溃的窗口「叫回来」（§2.14 一）。
 *
 * 恢复 = 同 token、同 cwd、带 `-c` 开一个新窗口（`claude -c` 续当前目录最近一次会话）。
 * live 会话拒绝。
 */
import { CmtError, EXIT } from '../../core/errors.js';
import { resumeSession } from '../resume.js';

const spec = {
  boolean: ['help'],
  string: [],
  alias: { h: 'help' },
};

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
async function run(args, ctx) {
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const id = typeof args._[0] === 'string' ? args._[0] : '';
  if (id === '') {
    throw new CmtError('要给一个会话 id（或前缀）', {
      hint: '先 `cmt sessions` 看有哪些 ended / dead 的会话',
    });
  }

  const r = await resumeSession(ctx, { id });
  process.stdout.write(
    `已在新窗口恢复 ${r.token !== '' ? r.token : '(default)'} · ${tailOf(r.cwd)}`
    + '（-c 续该目录最近一次会话）\n',
  );
  return EXIT.OK;
}

/**
 * 目录末两段（回执一行放得下）。
 * @param {string} cwd
 */
function tailOf(cwd) {
  if (cwd === '') return '';
  const parts = String(cwd).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.slice(-2).join('/');
}

const HELP = `cmt resume <会话 id 或前缀>

把已经关闭 / 崩溃的窗口叫回来：同 token、同 cwd、带 -c 开一个新窗口。
  ended   正常退出的
  dead    没有退出记录、进程也没了的（崩溃 / 被杀 / 窗口被关）

  ⚠️ live 会话拒绝——它还开着，切回那个窗口即可。
  ⚠️ 先 \`cmt sessions\` 看有哪些可恢复的会话。
`;

export const resumeCommand = { spec, run };
