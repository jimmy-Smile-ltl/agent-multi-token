// @ts-check
/**
 * 真机验收：cxt 的产物能不能被**真实 Codex** 接受（§6.3 的"手工验第②件"）。
 *
 * 契约 §6.3 说得很直白：**"每次 Codex 升级都要手工回归一次"**，
 * 因为 §7 的事实全部来自文档与第三方实测。这个脚本把那句话变成一条命令：
 *
 * ```bash
 * node scripts/verify-real-codex.mjs
 * ```
 *
 * 它在**临时 CODEX_HOME** 里造环境，**绝不碰用户真实的 `~/.codex/`**（§2.9 铁律 1）。
 *
 * ⚠️ 与 `tests/` 的分工：那些是**纯函数**单测（快、无外部依赖、跑在 CI 上）；
 * 这个是**真机集成验收**（慢、要装 codex、只在人手动跑时跑）。
 * 两者不重叠：单测保证"我们的逻辑自洽"，这个保证"Codex 认我们的输出"。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { spliceManagedRegion } from '../src/core/toml-splice.js';
import { spliceTrust } from '../src/core/trust.js';

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? '';
const SANDBOX = join(HOME, '.codex-cxt-verify');
const PROJ = join(HOME, 'cxt-verify-proj');
const CONFIG = join(SANDBOX, 'config.toml');
const CATALOG = join(SANDBOX, 'models.json');

const TOKEN = 'relay-a';
const ENV_KEY = 'CXT_TOKEN_RELAY_A';
const PROVIDER_ID = 'cxt-relay-a';
const SLUG = 'deepseek-chat';
const CONTEXT_WINDOW = 65536;

rmSync(SANDBOX, { recursive: true, force: true });
rmSync(PROJ, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
mkdirSync(PROJ, { recursive: true });

// ───────────────────────────── 仪器 ─────────────────────────────

/** 跑 codex 并**总是**返回输出（doctor 有 Notes 时会非零退出，那不算失败）。 */
function codex(args, extraEnv = {}) {
  // ⚠️ codex 在 Windows 上是 .cmd —— Node 18.20+/20.12+ 拒绝直接 spawn，必须经 cmd.exe /c（§2.12）
  const cmd = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'codex';
  const argv = process.platform === 'win32' ? ['/c', 'codex', ...args] : args;
  try {
    return { ok: true, out: execFileSync(cmd, argv, {
      cwd: PROJ,
      env: { ...process.env, CODEX_HOME: SANDBOX, ...extraEnv },
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    }) };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let passed = 0;
/** @type {string[]} */
const failures = [];

/**
 * @param {string} label
 * @param {boolean} cond
 * @param {string} [detail]
 */
function check(label, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✅ ${label}`); } else {
    failures.push(label);
    console.log(`  ❌ ${label}${detail ? `\n       ${detail}` : ''}`);
  }
}

/** config.toml 里有没有"配置加载失败"（doctor 的 Notes 里） */
const configLoadFailed = (out) => /✗ config/.test(out);

/** @param {string} body */
function writeConfig(body) { writeFileSync(CONFIG, body, 'utf8'); }

// ───────────────────────────── ① 拼接器产物 ─────────────────────────────

console.log('\n① 拼接器产出的 config.toml 被真解析器接受');

const SRC = [
  '# 用户手写的注释',
  'approval_policy = "on-request"',
  '',
  '[model_providers.mine]',
  'name = "我自己接的"',
  'base_url = "https://mine.example/v1"',
  '',
  `[projects.'${PROJ}']`,
  'trust_level = "trusted"',
  '',
].join('\n');

const { newText, report } = spliceManagedRegion({
  existingText: SRC,
  managedValues: {
    topLevel: { model: SLUG, model_provider: PROVIDER_ID, model_catalog_json: CATALOG.replace(/\\/g, '/') },
    provider: {
      id: PROVIDER_ID,
      values: {
        name: `cxt ${TOKEN}`, base_url: 'https://api.deepseek.com/v1',
        env_key: ENV_KEY, wire_api: 'responses',
      },
    },
  },
});
writeConfig(newText);

// catalog 必须一起写好，否则 config 会因 catalog schema 失败（见 ③）
writeFileSync(CATALOG, JSON.stringify({ models: [{
  slug: SLUG,
  display_name: 'DeepSeek Chat',
  description: 'DeepSeek 直连',
  context_window: CONTEXT_WINDOW,
  max_context_window: CONTEXT_WINDOW,
  effective_context_window_percent: 95,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [
    { effort: 'low', description: '快' },
    { effort: 'medium', description: '中' },
    { effort: 'high', description: '深' },
  ],
  input_modalities: ['text'],
  shell_type: 'default',
  visibility: 'list',
  supported_in_api: true,
  priority: 1,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 60_000 },
  experimental_supported_tools: [],
  base_instructions: 'You are a coding agent.',
}] }, null, 2), 'utf8');

const doc1 = codex(['doctor']);
check('codex doctor 不报 ✗ config（配置可加载）', !configLoadFailed(doc1.out),
  doc1.out.split('\n').filter((l) => /✗ config|error/i.test(l)).slice(0, 3).join(' / '));

check('[projects.*] 仍在（铁律 2）', readFileSync(CONFIG, 'utf8').includes(`[projects.'${PROJ}']`));
check('用户自己的 [model_providers.mine] 仍在', readFileSync(CONFIG, 'utf8').includes('[model_providers.mine]'));
check('Codex 没有改写文件（逐字节）', readFileSync(CONFIG, 'utf8') === newText);
check('产物无 BOM、无 CR', !newText.startsWith('﻿') && !newText.includes('\r'));
check('report.changed = true（首轮确实写了东西）', report.changed === true);

// ───────────────────────────── ② 注入链 ─────────────────────────────

console.log('\n② 注入链：config → provider → env_key → 环境变量');

const docNoEnv = codex(['doctor']);
check(`未注入环境变量时，doctor 点名我们生成的 ${ENV_KEY}`,
  docNoEnv.out.includes(`Set ${ENV_KEY}`),
  '这一行同时反证了 provider section 被采纳、env_key 被读出');

const docEnv = codex(['doctor'], { [ENV_KEY]: 'sk-fake-not-used' });
check('注入环境变量后 ✓ auth（整条链全通）',
  /✓ auth\s+auth is provided by the active model provider/.test(docEnv.out),
  docEnv.out.split('\n').find((l) => /auth/.test(l)) ?? '(没有 auth 行)');

// ───────────────────────────── ③ catalog ─────────────────────────────

console.log('\n③ catalog 真的被采纳（不只是"文件写对了"）');

const models = codex(['debug', 'models']);
let loaded = null;
try { loaded = JSON.parse(models.out).models.find((m) => m.slug === SLUG); } catch { /* 下面断言会报 */ }
check('codex debug models 里能看到我们的 slug', loaded != null);
check(`读回的 context_window = ${CONTEXT_WINDOW}`, loaded?.context_window === CONTEXT_WINDOW,
  `实际 ${loaded?.context_window}`);

// 反例：顶层裸数组必须被拒（真机验过）
writeFileSync(CATALOG, JSON.stringify([{ slug: SLUG }]), 'utf8');
check('catalog 顶层是裸数组 → 被拒（必须是 {models:[...]}）',
  configLoadFailed(codex(['doctor']).out));

// ★ §7.5 原本只有"第三方观察：`model_catalog_json` **可能不支持** `~` 展开"。
//   这里把它判成事实——cxt 为此专门在 buildInjection 里做展开（见 resolve.js）。
//
//   ⚠️ 用 `TILDE_CW = 98765` 这种**绝不可能撞上默认值**的数当判据。
//   拿 65536 去判是假信号：它既像"我们的目录被读了"，也像"Codex 给未知模型的默认值"，
//   两种情况长得一模一样——这正是 §7.5 那张"两类失败"表里最难分辨的一格。
const TILDE_CW = 98765;
const TILDE_CATALOG = join(PROJ, 'tilde-catalog.json');
writeFileSync(TILDE_CATALOG, JSON.stringify({ models: [{
  slug: SLUG,
  display_name: 'DeepSeek Chat',
  context_window: TILDE_CW,
  max_context_window: TILDE_CW,
  effective_context_window_percent: 95,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: [{ effort: 'low', description: '快' }],
  input_modalities: ['text'],
  shell_type: 'default',
  visibility: 'list',
  supported_in_api: true,
  priority: 0,
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 60_000 },
  experimental_supported_tools: [],
  base_instructions: '',
}] }, null, 2), 'utf8');

const TILDE_REF = `~/${basename(PROJ)}/tilde-catalog.json`;
/** 跑一次并读回 slug 对应的 context_window */
function catalogWindow(ref) {
  writeConfig(`model = '${SLUG}'\nmodel_catalog_json = "${ref}"\n`);
  try {
    return JSON.parse(codex(['debug', 'models']).out).models.find((m) => m.slug === SLUG)?.context_window ?? null;
  } catch { return null; }
}

// 先立**阴性对照**：指向一个不存在的文件时，读回来绝不能是 TILDE_CW。
// 没有这一步，下面那条 ✅ 可能只是"Codex 对未知模型恰好返回了某个数"。
const bogus = catalogWindow(`~/${basename(PROJ)}/does-not-exist.json`);
check('阴性对照：指向不存在的目录文件 → 读不到我们的值',
  bogus !== TILDE_CW, `实际 ${bogus}——若等于 ${TILDE_CW} 说明这条判据根本不成立`);

const tildeWindow = catalogWindow(TILDE_REF);
check(`Codex 自己会展开 \`~\` 吗？（§7.5 的 ⚠️ 待定项，ref=${TILDE_REF}）`,
  tildeWindow === TILDE_CW,
  `实际 ${tildeWindow}（期望 ${TILDE_CW}）——不等于则说明**不展开**，`
  + 'cxt 在 buildInjection 里展开 `~` 就是**必需**的，不是保险');

// ───────────────────────────── ④ model_provider 成对约束 ─────────────────────────────

console.log('\n④ model_provider 必须与 provider section 成对（§7.8）');

writeConfig(`model = '${SLUG}'\nmodel_provider = 'cxt-ghost'\n`);
check('model_provider 指向不存在的 provider → 整个配置不可加载',
  configLoadFailed(codex(['doctor']).out),
  '所以拼接器必须在写入前就拒绝半份受管区');

// ───────────────────────────── ⑤ BOM ─────────────────────────────

console.log('\n⑤ BOM：事实复核 + cxt 仍然剥掉（§7.14①）');

// 契约原本说"带 BOM → 配置加载失败"。2026-10-17 复核：**0.163.0 上不成立**。
// 这条断言是**故意反向**的——它记录"当前版本容忍 BOM"这个事实，
// 将来 Codex 若收紧，这里会红，提醒回去改 §7.14①。
writeFileSync(CONFIG, `﻿model = '${SLUG}'\n`, 'utf8');
const bomBytes = readFileSync(CONFIG).subarray(0, 3).toString('hex');
check('BOM 字节确实写进了文件（前置条件）', bomBytes === 'efbbbf', `实际 ${bomBytes}`);
check('带 BOM 的 config.toml 在 0.163.0 上**仍能加载**（§7.14① 已修正）',
  !configLoadFailed(codex(['doctor']).out),
  '契约原来断言它会失败；复核发现不会。若这里变红，说明 Codex 收紧了，回去改 §7.14①');

// cxt 自己的行为：无论 Codex 容不容忍，我们都不写 BOM（卫生 + 可移植）
const bomSplice = spliceManagedRegion({
  existingText: `﻿model = 'old'\n`,
  managedValues: { topLevel: { model: SLUG } },
});
check('★ 拼接器仍然剥掉 BOM 并报 hadBom（§2.9 步骤 6 不变）',
  !bomSplice.newText.startsWith('﻿') && bomSplice.report.hadBom === true,
  `hadBom=${bomSplice.report.hadBom}`);

// ───────────────────────────── ⑥ 信任门（§7.3 规则表逐行）─────────────────────────────

console.log('\n⑥ 信任门：§7.3 的路径匹配规则表逐行复核');

// 项目级配置：这两个键**都不在** §7.3 的禁区里，所以可信时应当完整生效。
// 用它们当"信任生效了没有"的探针，比读某个内部状态可靠。
mkdirSync(join(PROJ, '.codex'), { recursive: true });
writeFileSync(join(PROJ, '.codex', 'config.toml'),
  'model = "project-model"\napproval_policy = "never"\n', 'utf8');

// 用户级把 model 设成**另一个值**，好分辨"谁赢了"
const USER_BASE = [
  'model = "user-model"',
  'model_provider = "probe-prov"',
  '',
  '[model_providers.probe-prov]',
  'name = "probe"',
  'base_url = "https://probe.example.invalid/v1"',
  'env_key = "PROBE_KEY"',
  'wire_api = "responses"',
  '',
].join('\n');

/**
 * 写信任文本 → 跑 doctor → 读回 (model, approval)。
 *
 * `model` 回答"项目级配置生效了吗"，`approval` 回答"生效到哪一档"——
 * 后者能把 `untrusted`（UnlessTrusted）与"从未标记"（OnRequest）分开，
 * 而这两个在只读 `model` 时长得一模一样。
 *
 * ⚠️ 正则用 `\s{2,}`：doctor 的键值之间是**多空格**对齐，
 * 而 `model provider` 那一行是**单空格**——正好靠这个把它们区分开。
 * @param {string} trustText
 */
function trustProbe(trustText) {
  writeConfig(USER_BASE + trustText);
  const out = codex(['doctor']).out;
  return {
    model: out.match(/^\s*model\s{2,}(\S+)/m)?.[1] ?? null,
    approval: out.match(/^\s*approval policy\s+(\S+)/m)?.[1] ?? null,
  };
}

/** 走 cxt 自己的写入路径——验的是"**我们的产物** Codex 认不认" */
const writeTrust = (level, path = PROJ) =>
  spliceTrust('', { path, level, platform: process.platform }).newText;

const unmarked = trustProbe('');
check('从未标记 → 项目级被跳过，model 回落用户级', unmarked.model === 'user-model',
  `实际 ${unmarked.model}`);
check('从未标记 → approval = OnRequest（保守默认）', unmarked.approval === 'OnRequest',
  `实际 ${unmarked.approval}`);

const trusted = trustProbe(writeTrust('trusted'));
check('★ trusted（cxt 写的形态）→ 项目级 model 生效', trusted.model === 'project-model',
  `实际 ${trusted.model}`);
check('★ trusted → approval = Never（项目级的仓库安全策略也生效了）',
  trusted.approval === 'Never', `实际 ${trusted.approval}`);

// ★★ 反向断言：正斜杠**必须**静默失配。
// `trust.js` 的 canonicalizeTrustPath / near-miss 修复整个模块就是为这一步存在的。
// 若这里变绿，说明 Codex 开始容忍正斜杠了——§7.3 铁律 1 可以放宽，回来改契约。
const forward = trustProbe(`[projects."${PROJ.replace(/\\/g, '/')}"]\ntrust_level = "trusted"\n`);
check('★★ 正斜杠写法**静默不生效**（本工具最容易写错的一步）',
  forward.model === 'user-model' && forward.approval === 'OnRequest',
  `实际 model=${forward.model} approval=${forward.approval}`);

const untrusted = trustProbe(writeTrust('untrusted'));
check('★ 显式 untrusted ≠ 从未标记：approval = UnlessTrusted（三态确认为真）',
  untrusted.approval === 'UnlessTrusted',
  `实际 ${untrusted.approval}——若等于 OnRequest 说明退化成二态了`);

const lower = trustProbe(writeTrust('trusted', PROJ.toLowerCase()));
check('全小写路径仍生效（Windows 大小写不敏感）', lower.model === 'project-model',
  `实际 ${lower.model}`);

const parent = trustProbe(writeTrust('trusted', HOME));
check('★ 父目录不继承（§7.3 铁律 3）', parent.model === 'user-model',
  `实际 ${parent.model}`);

const trailing = trustProbe(`[projects.'${PROJ}\\']\ntrust_level = "trusted"\n`);
check('尾部分隔符不匹配', trailing.model === 'user-model', `实际 ${trailing.model}`);

// 收尾：把项目级配置撤掉，免得污染下次运行
rmSync(join(PROJ, '.codex'), { recursive: true, force: true });

// ───────────────────────────── 汇总 ─────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (failures.length === 0) {
  console.log(`✅ 真机验收全通过（${passed} 项）`);
  console.log(`   临时环境：${SANDBOX}（可随时删）`);
} else {
  console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const f of failures) console.log(`   · ${f}`);
}
console.log(`   codex 版本：${codex(['--version']).out.trim()}`);
process.exit(failures.length === 0 ? 0 : 1);
