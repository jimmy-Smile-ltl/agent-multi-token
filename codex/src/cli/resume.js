// @ts-check
/**
 * 把一个 `ended` / `dead` 会话「叫回来」（§2.16 一）：**同 token、同 cwd、带 `-c`**
 * 开一个新窗口。
 *
 * ★ 与 `cxt run` 走**同一条路**（`planLaunch()` / `startLaunch()`），只是参数
 *   从会话记录里来——所以标题、终端模式、受管区同步、池/预检语义全部一致，
 *   不存在"恢复出来的是另一个东西"。
 *
 * ★ **只对非 live 会话有意义**：live 会话拒绝（它还在跑，再开一个是两个会话，
 *   而 `-c` 会指向同一个最近会话——两份写入同一个历史，是最坏的一种）。
 *
 * ★ **启动器可注入**（`io`）：测试里不许真开窗口（那会污染桌面）；
 *   单元测试传假函数、断言传出去的 argv 就够。
 */
import { CxtError } from '../core/errors.js';
import { planLaunch, startLaunch } from './commands/run.js';
import { listSessions } from './sessions.js';

/**
 * @typedef {object} ResumeIo
 * @property {typeof planLaunch} [planLaunch]
 * @property {typeof startLaunch} [startLaunch]
 */

/**
 * @typedef {object} ResumeResult
 * @property {string} id
 * @property {string} token
 * @property {string} cwd
 */

/**
 * 按 id（或前缀）恢复一个会话。
 *
 * @param {import('./types.js').Ctx} ctx
 * @param {{ id: string }} input
 * @param {ResumeIo} [io]
 * @returns {Promise<ResumeResult>}
 */
export async function resumeSession(ctx, input, io = {}) {
  const id = typeof input?.id === 'string' ? input.id.trim() : '';
  if (id === '') {
    throw new CxtError('要给一个会话 id（或 id 前缀）', {
      hint: '先 `cxt sessions` 看有哪些 ended / dead 的会话',
    });
  }

  const rows = listSessions(ctx);
  const matches = rows.filter((s) => s.id.startsWith(id));
  if (matches.length === 0) {
    throw new CxtError(`没有 id 以 ${id} 开头的会话`, {
      hint: resumableHint(rows),
    });
  }
  if (matches.length > 1) {
    throw new CxtError(`前缀 ${id} 匹配到 ${matches.length} 个会话，说不清是哪一个`, {
      hint: `把前缀写长一点：${matches.map((s) => s.id).join('、')}`,
    });
  }

  const row = matches[0];
  if (row.state === 'live') {
    throw new CxtError(`${row.id} 还在跑，不能「恢复」`, {
      hint: '它还开着——切回那个窗口即可。恢复只用于已经关闭 / 崩溃的会话',
    });
  }

  const meta = row.meta;
  /** @type {any} */
  const argv = { cwd: meta.cwd || ctx.cwd, resume: true };
  // `_default` 是纯 defaults 模式的占位名，不是合法 token 名——不能传给解析
  if (meta.token !== '' && meta.token !== '_default') argv.token = meta.token;

  const doPlan = io.planLaunch ?? planLaunch;
  const doStart = io.startLaunch ?? startLaunch;

  // `quiet`：备用屏/网页回执之外不该有 stderr 进度行；与面板启动同一条纪律
  const plan = await doPlan(argv, ctx, { quiet: true });
  await doStart(plan);

  return { id: row.id, token: meta.token, cwd: meta.cwd };
}

/**
 * 找不出可恢复会话时的那句提示：把最近的 ended/dead 列出来。
 * @param {import('./sessions.js').SessionRow[]} rows
 */
function resumableHint(rows) {
  const recent = rows.filter((s) => s.state !== 'live').slice(-5);
  return recent.length === 0
    ? '当前没有可恢复的会话。`cxt sessions` 看现状'
    : `可恢复的（最近的）：${recent.map((s) => s.id).join('、')}`;
}
