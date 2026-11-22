// 手工冒烟用的一次性夹具：造一个假的 home，然后跑 cmt resolve。
// 不是测试套件的一部分（tests/ 里是纯函数单测），只是让我肉眼确认整条链的输出。
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('用法: node smoke-resolve.mjs <fixture-root>');

const HOME = join(ROOT, 'home');
const APP = join(HOME, '.claude-multi-token');

// ── 清场：只删**我们自己造过的**目录 ────────────────────────────────
// 以前这里是一句裸的 `rmSync(ROOT, { recursive: true, force: true })`，
// 而 ROOT 直接来自 argv —— `node smoke-resolve.mjs ~` 就是一次静默的家目录删除。
// 改成认领制，只有两种情况算"这是夹具、可以删"：
//   ① 上一轮留下的标记文件还在
//   ② 目录是空的（没东西可丢）
// 其余一律拒绝——宁可让人手工清，也不要删错。
const MARKER = join(ROOT, '.cmt-smoke-fixture');
if (existsSync(ROOT) && !existsSync(MARKER)) {
  const left = readdirSync(ROOT);
  if (left.length > 0) {
    throw new Error(
      `拒绝删除 ${ROOT}：它既不空、也没有本脚本的标记（${MARKER}）。\n` +
        `  里面有：${left.slice(0, 5).join('、')}${left.length > 5 ? ` 等 ${left.length} 项` : ''}\n` +
        '  换一个空目录，或先手工清掉它。',
    );
  }
}
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(join(APP, 'tokens'), { recursive: true });
mkdirSync(join(ROOT, 'work', 'client-a'), { recursive: true });
mkdirSync(join(ROOT, 'work', 'client-b'), { recursive: true });
writeFileSync(MARKER, '这个目录由 scripts/smoke-resolve.mjs 生成，可以安全删除。\n', 'utf8');

const w = (p, o) => writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`, 'utf8');

w(join(APP, 'config.json'), {
  version: 1,
  defaults: {
    authToken: '${DEEPSEEK_API_KEY}',
    authMode: 'token',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: [
      { id: 'deepseek-flash[1m]', label: 'Flash 1M' },
      { id: 'deepseek-flash', label: 'Flash' },
    ],
    slots: { haiku: 'deepseek-flash', subagent: 'deepseek-flash' },
    env: { CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '786432' },
    terminalMode: 'tab',
  },
  bindings: [
    { path: join(ROOT, 'work', 'client-a'), token: 'relay-a' },
    {
      path: join(ROOT, 'work', 'client-b'),
      token: 'relay-b',
      baseUrl: 'https://other.example.com',
      env: { CLAUDE_CODE_EFFORT_LEVEL: 'low' },
    },
  ],
});

w(join(APP, 'tokens', 'relay-a.json'), {
  name: 'relay-a',
  authToken: '${RELAY_A_TOKEN}',
  authMode: 'token',
  baseUrl: 'https://api.deepseek.com/anthropic',
  cwd: join(ROOT, 'work', 'client-a'),
  models: [{ id: 'deepseek-flash[1m]' }],
});

w(join(APP, 'tokens', 'relay-b.json'), {
  name: 'relay-b',
  authToken: 'sk-plaintext-demo-key-1234567890',
  baseUrl: 'https://api.deepseek.com/anthropic',
  cwd: join(ROOT, 'work', 'client-b'),
});

console.log(`fixture ready: ${ROOT}`);
console.log(`  HOME=${HOME}`);
console.log(`  client-a=${join(ROOT, 'work', 'client-a')}`);
console.log(`  client-b=${join(ROOT, 'work', 'client-b')}`);
