// @ts-check
/**
 * ★ 真机验收：`cxt run` 真的弹出一个窗口，窗口里那条链真的跑到了 codex。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么必须真跑
 *
 * `tests/run-e2e.test.js` 能证明"我们**以为**会弹什么"，但证明不了
 * 窗口真的弹出来了、新窗口里的 `cxt exec` 真的能找到 cxt 入口、
 * 真的注入对了环境、真的把 cwd 带到了 codex。
 * 这一段跨越了 `spawn(detached)` + 真实终端 + 第二个 node 进程 + cmd shim，
 * **没有任何单测能替它**（§6.3 的"唯一无法单测的部分"）。
 *
 * ## 怎么做到"看得见结果"
 *
 * 把 `defaults.codexBin` 指向一个**假 codex**（一个 `.cmd`），
 * 它把 `{argv, cwd, codexHome, tokenVar}` 写进一个 JSON 文件再退出。
 * 于是断言是**读文件**，不是"我看着窗口弹出来了"——
 * 后者是主观的，而且没法进 CI。
 *
 * ⚠️ 全程 `USERPROFILE` 指向临时目录，**不碰真的 `~`**。
 *    `defaults.codexBin` 是显式配置，所以**真的 codex 压根不会被调用**
 *    （§2.12 第 1 级定位：配了就听配置的）。
 *
 * 用法：node scripts/verify-run-real.mjs
 * ─────────────────────────────────────────────────────────────
 */
import { spawnSync } from 'node:child_process';
import nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 as win32Path } from 'node:path';

const ROOT = process.cwd();
const CXT = win32Path.join(ROOT, 'bin', 'cxt.js');

/** 一个带**空格**的 cwd——最容易在引号上翻车的那种（§2.12 的设计红利就在这） */
const home = nodeFs.mkdtempSync(win32Path.join(tmpdir(), 'cxt-real-'));
const appDir = win32Path.join(home, '.codex-multi-token');
const workDir = win32Path.join(home, 'work dir with spaces');
const evidence = win32Path.join(home, 'evidence.json');

nodeFs.mkdirSync(win32Path.join(appDir, 'tokens'), { recursive: true });
nodeFs.mkdirSync(workDir, { recursive: true });

// ── 假 codex：把"子进程实际拿到了什么"写下来 ──
const probeJs = win32Path.join(home, 'probe.js');
nodeFs.writeFileSync(probeJs, [
  `import nodeFs from 'node:fs';`,
  `nodeFs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({`,
  `  argv: process.argv.slice(2),`,
  `  cwd: process.cwd(),`,
  `  codexHome: process.env.CODEX_HOME ?? null,`,
  `  tokenVar: process.env.CXT_TOKEN_RELAY_A ?? null,`,
  `  ppidChain: process.env.CXT_E2E_MARK ?? null,`,
  `}, null, 2), 'utf8');`,
  '',
].join('\n'), 'utf8');

// 假 codex 是个 `.cmd`——**和真机 npm 装出来的形态一致**，
// 于是这条链顺带把 §7.14⑥ 的 cmd shim 也真跑了一遍
const fakeCodex = win32Path.join(home, 'fake-codex.cmd');
nodeFs.writeFileSync(fakeCodex, [
  '@ECHO off',
  'SETLOCAL',
  'SET "_prog=node"',
  `endLocal & "%_prog%" "${probeJs}" %*`,
  '',
].join('\r\n'), 'ascii');

nodeFs.writeFileSync(win32Path.join(appDir, 'config.json'), JSON.stringify({
  version: 1,
  defaults: {
    baseUrl: 'https://api.deepseek.com/',
    wireApi: 'responses',
    models: [{ id: 'deepseek-flash', label: 'Flash' }],
    codexBin: fakeCodex,
  },
  bindings: [],
}, null, 2), 'utf8');

nodeFs.writeFileSync(win32Path.join(appDir, 'tokens', 'relay-a.json'), JSON.stringify({
  name: 'relay-a',
  authToken: 'sk-REAL-secret-value-efgh',
  cwd: workDir,
}, null, 2), 'utf8');

console.log('临时 home :', home);
console.log('token.cwd :', workDir, '（带空格）');
console.log('假 codex  :', fakeCodex);
console.log('');

// ── 1. 先 --print 看一眼（不弹窗）──
const p = spawnSync(process.execPath, [CXT, 'run', 'relay-a', '--print'], {
  encoding: 'utf8', env: { ...process.env, USERPROFILE: home }, cwd: ROOT,
});
console.log('═══ 1. --print ═══');
console.log(p.stdout);
if (p.stderr) console.log('stderr:', p.stderr);
if (p.status !== 0) { console.error('--print 就失败了，先查这个'); process.exit(1); }

// ── 2. 真的弹窗 ──
console.log('═══ 2. cxt run relay-a（真的弹窗）═══');
const r = spawnSync(process.execPath, [CXT, 'run', 'relay-a'], {
  encoding: 'utf8', env: { ...process.env, USERPROFILE: home }, cwd: ROOT,
});
console.log('退出码:', r.status);
console.log('stdout:', r.stdout.trim());
console.log('stderr:', r.stderr.trim());
console.log('');

// ── 3. 等窗口里那条链把证据写回来 ──
console.log('═══ 3. 等新窗口里的链跑完 ═══');
const deadline = Date.now() + 30_000;
// 同步睡：起一个 node 进程当闹钟太慢，`Atomics.wait` 才是零依赖的 sleep
const nap = new Int32Array(new SharedArrayBuffer(4));
while (!nodeFs.existsSync(evidence) && Date.now() < deadline) {
  Atomics.wait(nap, 0, 0, 250);
}
console.log('');

if (!nodeFs.existsSync(evidence)) {
  console.error('✖ 30 秒内没等到证据文件——窗口没弹出来，或窗口里的链断在半路');
  const win = spawnSync('powershell', ['-NoProfile', '-Command',
    'Get-Process WindowsTerminal -ErrorAction SilentlyContinue | '
    + 'ForEach-Object { "$($_.Id)  $($_.MainWindowTitle)" }'], { encoding: 'utf8' });
  console.error('   当前 Windows Terminal 窗口：');
  console.error(win.stdout?.trim() || '   （一个都没有）');
  console.error('   ⚠️ 窗口里的报错**只显示在窗口里**，这里看不见——');
  console.error('      看屏幕上那个窗口，或手工跑一次 `cxt exec relay-a`（同一份 config）');
  console.error('   临时目录留着：', home);
  process.exit(1);
}

const got = JSON.parse(nodeFs.readFileSync(evidence, 'utf8'));
const expectProfile = win32Path.join(appDir, 'profiles', 'relay-a');

/** @type {[string, boolean, string][]} */
const checks = [
  ['CODEX_HOME 落在该 token 的 profile', got.codexHome === expectProfile, String(got.codexHome)],
  ['凭证注入到了新窗口的进程里', got.tokenVar === 'sk-REAL-secret-value-efgh',
    got.tokenVar === null ? 'null' : '（已注入，值略）'],
  ['★ codex 的工作目录 = token.cwd（带空格的那条路径）',
    win32Path.resolve(got.cwd) === win32Path.resolve(workDir), String(got.cwd)],
  ['★ `-C` 到了 codex 手里（终端丢 cwd 时的唯一补救）',
    got.argv.includes('-C') && got.argv.includes(workDir), JSON.stringify(got.argv)],
];

console.log('═══ 4. 断言 ═══');
let bad = 0;
for (const [what, ok, detail] of checks) {
  console.log(`  ${ok ? '✓' : '✖'} ${what}${ok ? '' : `\n      实得：${detail}`}`);
  if (!ok) bad++;
}

console.log('');
console.log(bad === 0 ? '★ 全部通过——窗口真的弹了，链真的跑到了 codex' : `✖ ${bad} 项失败`);
console.log('临时目录留着供检查：', home);
process.exit(bad === 0 ? 0 : 1);
