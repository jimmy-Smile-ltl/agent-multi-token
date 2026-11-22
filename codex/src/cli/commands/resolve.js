// @ts-check
/**
 * `cxt resolve [<path>]` —— **排查神器**（§5）。
 *
 * 一眼看出"为什么这个目录用了这个 token"，因为**每项都标了来源层**（§2.3）。
 *
 * ─────────────────────────────────────────────────────────────
 * ★ 这个命令**不需要终端探测、不需要 spawn、不需要 codex 存在**，
 * 所以它是整条解析链的第一道可验证关口（§4.4 第 8 步）：
 * 在碰平台层（风险最高、无法单测）之前，解析链已经肉眼可验。
 * ─────────────────────────────────────────────────────────────
 *
 * ⚠️ 它**不抛"四要素缺项"错**——那正是它要展示的东西。
 * 缺项在表里显示成 `(缺)`，并给出该去哪配。
 */

import { EXIT } from '../../core/errors.js';
import { orderCandidates } from '../../core/pool.js';
import { SOURCE } from '../../core/resolve.js';
import { assertArgvConsistent } from '../../core/validate.js';
import { describeSecret, maskEnv, makePainter, table } from '../format.js';
import { loadPool } from '../pool-store.js';
import { managedRegionDiff, resolveSession, toResolveArgv } from '../session.js';

/** @type {import('../types.js').Command['spec']} */
const spec = {
  // ⚠️ **故意不认 `--pick`**：resolve 的全部价值就在于"不需要终端探测"（§4.4 第 8 步），
  //    给它一个交互式选择器会把这条性质毁掉。要挑模型用 `cxt run --pick`。
  //    `--window` / `--tab` 则要留着——它们影响 terminalMode 的解析结果。
  boolean: ['json', 'help', 'window', 'tab'],
  string: ['cwd', 'token', 'token-value', 'url', 'model'],
  alias: { h: 'help', t: 'token', m: 'model' },
};

/** 来源层 → 人看的说法（§2.3） */
const SOURCE_LABEL = {
  [SOURCE.CLI]: '命令行',
  [SOURCE.PROJECT]: '项目本地',
  [SOURCE.BINDING]: '路径绑定',
  [SOURCE.TOKEN]: 'token 文件',
  [SOURCE.DEFAULTS]: '全局默认',
  [SOURCE.BUILTIN]: '内置',
  [SOURCE.PREFLIGHT]: '启动前校验',
  [SOURCE.POOL]: 'token 池',
  [SOURCE.DERIVED]: '派生',
  [SOURCE.PROCESS]: '进程目录',
  [SOURCE.MERGED]: '多层合并',
  [SOURCE.NONE]: '未设置',
};

/** 四要素：显示在最前面，且缺了要显眼 */
const ELEMENTS = ['cwd', 'authToken', 'baseUrl', 'model'];

/** 其余需要展示的项，按重要性排 */
const OTHERS = ['token', 'providerId', 'wireApi', 'models', 'catalog', 'sandboxMode', 'approvalPolicy', 'terminalMode'];

/**
 * @param {any} args
 * @param {import('../types.js').Ctx} ctx
 */
export async function run(args, ctx) {
  if (args.help) {
    process.stdout.write(HELP);
    return EXIT.OK;
  }

  const path = args._[0];
  const argv = toResolveArgv(args, []);
  assertArgvConsistent(argv);

  const resolved = resolveSession(ctx, argv, 'run', { path });
  // ★ 只算一次：受管区差异与注入清单是同一份推导，两边各算一遍迟早会不一致
  const diff = managedRegionDiff(ctx, resolved);

  if (args.json) {
    process.stdout.write(`${JSON.stringify(toJson(resolved, diff, ctx), null, 2)}\n`);
    return EXIT.OK;
  }

  process.stdout.write(renderHuman(resolved, diff, ctx));
  // ★ 缺项不是"命令失败"——`cxt resolve` 的职责就是把缺什么说清楚。
  //   真要拦启动的是 `cxt run` / `cxt exec`（§2.1）。所以这里仍然返回 0。
  return EXIT.OK;
}

// ───────────────────────────── JSON 输出 ─────────────────────────────

/**
 * 机器可读形态（`--json`）。
 *
 * 只挑该给外面看的字段：`tokenObject` / `binding` 是内部结构，**不导出**——
 * 前者原样带着明文 `authToken`，漏出去就等于把打码白做了。
 *
 * @param {any} r
 * @param {any} diff `managedRegionDiff()` 的产物
 * @param {import('../types.js').Ctx} ctx
 */
function toJson(r, diff, ctx) {
  /** @param {string} f */
  const cell = (f) => ({ value: r[f].value, source: r[f].source, detail: r[f].detail ?? null });

  return {
    entry: r.entry,
    callCwd: r.callCwd,
    bindingPath: r.bindingPath,
    /** ★ 生效的项目本地配置（§2.13）——`null` = 没发现 */
    projectPath: r.projectPath,
    profile: r.profileName,
    profileDir: diff.injection.profile,
    envKeyName: r.envKeyName,
    missing: r.missing,
    warnings: r.warnings,
    // ★ 凭证只给打码值 / 引用串（§5 + §2.4）——`--json` 是给脚本消费的，更要守规矩
    authToken: secretCell(r, ctx),
    cwd: cell('cwd'),
    baseUrl: cell('baseUrl'),
    model: cell('model'),
    token: cell('token'),
    providerId: cell('providerId'),
    wireApi: cell('wireApi'),
    models: { ...cell('models'), value: r.models.value },
    catalog: cell('catalog'),
    sandboxMode: cell('sandboxMode'),
    approvalPolicy: cell('approvalPolicy'),
    terminalMode: cell('terminalMode'),
    env: { value: maskEnv(r.env.value), sources: r.env.sources },
    // ★ 会被删掉的继承变量（§2.6）。脚本要判断"新会话里到底有没有 X"，
    //   得把这一份和 `env` 一起看——只看 `env` 会漏掉"显式删掉"这种情形。
    unset: diff.injection.unset ?? [],
    codexArgs: cell('codexArgs'),
    managedRegion: { changed: diff.changed, report: diff.report },
  };
}

/**
 * ★ 凭证那一格（§2.4 + §5）。
 *
 * **不能一律 `maskValue`**：`${DEEPSEEK_API_KEY}` 是**变量名**，不是密钥。
 * 把它打成 `${D****_KEY}` 之后，用户看不出该 export 哪一个变量——
 * 而"这个目录为什么解析成这样"正是 `cxt resolve` 存在的理由。
 * §2.4 的原话是「展示时只标注「已设置 / 未设置」，**不打印值**」：
 * 打印的是**引用串**，变量的**值**一个字都不出现。
 *
 * `describeSecret` 正好就是这个语义（明文才走 `maskValue`），
 * `cxt token show` 用的是同一个函数——两处显示成两样，比哪一种选错都糟。
 *
 * @param {any} r
 * @param {import('../types.js').Ctx} ctx
 */
function secretCell(r, ctx) {
  const raw = r.authToken.value;
  const d = describeSecret(raw, ctx.env);
  return {
    value: raw === null ? null : d.text,
    source: r.authToken.source,
    detail: r.authToken.detail ?? null,
    // 脚本要判断"这个引用到底设了没有"不用去解析人读文案
    kind: d.kind,
    envName: d.envName ?? null,
    envSet: d.envSet ?? null,
  };
}

// ───────────────────────────── 人类输出 ─────────────────────────────

/**
 * @param {any} r
 * @param {any} diff
 * @param {import('../types.js').Ctx} ctx
 */
function renderHuman(r, diff, ctx) {
  const c = makePainter({ isTTY: ctx.isTTY, env: ctx.env, json: false });
  /** @type {string[]} */
  const out = [];

  out.push('');
  out.push(`  ${c.bold('cxt resolve')}  ${c.dim('—')} ${r.callCwd}`);
  out.push(`  ${c.dim(`入口 ${r.entry}：${r.entry === 'run' ? 'token.cwd 生效' : 'token.cwd 被跳过（§2.3 第五条）'}`)}`);
  if (r.bindingPath !== null) {
    out.push(`  ${c.dim(`命中绑定 ${r.bindingPath}`)}`);
  } else {
    out.push(`  ${c.dim('没有命中任何路径绑定')}`);
  }
  // ★ §2.13 一：**是哪一份** `.cxt.json` 赢了，和"命中绑定"一样必须印出来。
  //   只写"来源：项目本地"等于没说——用户的机器上可能有好几份（§2.13 的"最近优先"）。
  if (r.projectPath !== null) {
    out.push(`  ${c.dim(`项目本地配置 ${r.projectPath}`)}`);
  }
  out.push('');

  // ── 四要素 ──
  out.push(`  ${c.bold('四要素')}`);
  out.push(table(['', '项', '值', '来源'], [
    ...ELEMENTS.map((f) => elementRow(r, f, c, ctx.env)),
  ]));
  out.push('');

  // ── 其余解析项 ──
  const rest = OTHERS.filter((f) => f !== 'models' || r.models.value !== null);
  out.push(`  ${c.bold('其余解析项')}`);
  out.push(table(['', '项', '值', '来源'], rest.map((f) => row(r, f, c, ctx.env))));
  out.push('');

  // ── token 池能不能补上这一格（§2.15 三）──
  // ★ 这里**只提示、不挑**：探测要发一次真实请求（要花钱），而 resolve 存在的
  //   理由是"不用碰网络就能看清为什么"（§4.4 第 8 步）。为了一眼结果去挑，
  //   等于把这条性质毁掉——真挑发生在 `cxt run`。
  if (r.token.value === null) {
    const { pool } = loadPool(ctx);
    const total = Object.keys(pool.entries).length;
    if (total > 0) {
      const pickable = orderCandidates(pool.entries).length;
      out.push(`  ${c.dim(`token 池：${pickable} 个可挑（共 ${total} 个条目）——`
        + 'cxt run --pool 会在启动前挑一个')}`);
      out.push('');
    }
  }

  // ── 派生量 ──
  out.push(`  ${c.bold('派生')}`);
  out.push(table(['项', '值'], [
    ['providerId', r.providerId.value],
    ['凭证环境变量', r.envKeyName],
    ['profile（CODEX_HOME）', `${r.profileName}  →  ${diff.injection.profile}`],
    ['窗口标题', diff.injection.title],
  ]));
  out.push('');

  // ── 注入的环境变量 ──
  const envMasked = maskEnv(r.env.value);
  const envRows = Object.entries(envMasked);
  if (envRows.length > 0) {
    out.push(`  ${c.bold('注入的环境变量')}${c.dim('（逃生舱，按名打码）')}`);
    out.push(table(['变量', '值', '来源'], envRows.map(([k, v]) => [k, v, SOURCE_LABEL[r.env.sources[k]] ?? r.env.sources[k]])));
    out.push('');
  }

  // ── 会被删掉的继承变量（§2.6）──
  // ★ 这一段回答的是"我明明 export 了 X，新会话里怎么没有"。
  //   不印出来的话，唯一的解释渠道就只剩读源码了。
  const unset = diff.injection.unset ?? [];
  if (unset.length > 0) {
    out.push(`  ${c.bold('删掉的继承变量')} ${c.dim('（§2.6：env 里写空串 = 删掉，不是设成空）')}`);
    out.push(`    ${unset.join('、')}`);
    out.push('');
  }

  // ── 受管区 ──
  out.push(`  ${c.bold('受管区')} ${c.dim('profiles/' + r.profileName + '/config.toml')}`);
  if (diff.report.created) {
    // 文件/受管区还不存在——这不是"漂移"，是首次写入，别吓唬人
    out.push(`  ${c.dim('（尚未创建；cxt run / cxt exec 首次运行时会写入以下内容）')}`);
    out.push(...renderManagedPreview(diff, c));
  } else if (diff.changed) {
    out.push(`  ${c.yellow('⚠ 与当前文件不一致（漂移）——cxt run / cxt exec 会就地修正')}`);
    out.push(...renderManagedPreview(diff, c));
  } else {
    out.push(`  ${c.green('✓ 与当前文件一致（幂等，无漂移）')}`);
  }
  out.push('');

  // ── 缺项 ──
  if (r.missing.length > 0) {
    out.push(`  ${c.red('✗ 四要素不齐全，缺少：' + r.missing.join('、'))}`);
    out.push(`  ${c.dim('cxt run / cxt exec 会拒绝启动；补法见 `cxt resolve --help`')}`);
    out.push('');
  }

  // ── 告警 ──
  for (const w of r.warnings) {
    out.push(`  ${c.yellow('⚠')} ${w.message}`);
  }
  if (r.warnings.length > 0) out.push('');

  return out.join('\n');
}

/**
 * @param {any} r
 * @param {string} f
 * @param {import('../format.js').Painter} c
 * @param {Record<string, string | undefined>} env
 */
function elementRow(r, f, c, env) {
  const missing = r.missing.includes(f);
  const mark = missing ? c.red('✗') : c.green('✓');
  const value = missing ? c.red('(缺)') : displayValue(r, f, c, env);
  return [mark, c.bold(f), value, c.dim(SOURCE_LABEL[r[f].source] ?? r[f].source)];
}

/**
 * @param {any} r
 * @param {string} f
 * @param {import('../format.js').Painter} c
 * @param {Record<string, string | undefined>} env
 */
function row(r, f, c, env) {
  return [' ', f, displayValue(r, f, c, env), c.dim(SOURCE_LABEL[r[f].source] ?? r[f].source)];
}

/**
 * 值 → 展示串。**凭证走 `describeSecret`**（§2.4 + §5）：
 * 明文打码成前 3 后 4，`${VAR}` 引用**原样显示 + 标注已设置/未设置**。
 * @param {any} r
 * @param {string} f
 * @param {import('../format.js').Painter} c
 * @param {Record<string, string | undefined>} env
 */
function displayValue(r, f, c, env) {
  const cell = r[f];
  if (cell.value === null) return c.dim('—');

  switch (f) {
    case 'authToken':
      return describeSecret(cell.value, env).text;
    case 'model':
      return `${cell.value.id}${cell.value.label ? ` ${c.dim(`(${cell.value.label})`)}` : ''}`;
    case 'models':
      return cell.value.map((m) => m.id).join(' > ');
    case 'codexArgs':
      return cell.value.join(' ');
    default:
      return String(cell.value);
  }
}

/**
 * 受管区要变的那几行。
 *
 * **不做 LCS/完整 diff**（那要引 diff 算法，违反零依赖）。用**多重集差**：
 * `next` 里有而 `current` 里没有的行 = 新增，反之 = 删除。
 *
 * 对这份文件这个近似是**精确**的，因为拼接器的全部动作就是
 * "在受管区里增删整行"——非受管区的行两边完全一样，多重集差里自然抵消。
 * 代价是行序变化看不出来（移动一行 = 一增一删），但那在受管区里不会发生。
 *
 * @param {{ current: string, next: string }} diff
 * @param {import('../format.js').Painter} c
 */
function renderManagedPreview(diff, c) {
  /** @param {string} t */
  const lines = (t) => t.split('\n').filter((l) => l.trim() !== '');

  /** @type {Map<string, number>} */
  const tally = new Map();
  for (const l of lines(diff.current)) tally.set(l, (tally.get(l) ?? 0) + 1);

  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const kept = [];
  for (const l of lines(diff.next)) {
    const n = tally.get(l) ?? 0;
    if (n > 0) {
      tally.set(l, n - 1);
      kept.push(l);
    } else {
      added.push(l);
    }
  }
  const removed = [...tally].filter(([, n]) => n > 0).flatMap(([l, n]) => Array(n).fill(l));

  return [
    ...added.map((l) => `    ${c.green('+')} ${l}`),
    ...removed.map((l) => `    ${c.red('-')} ${l}`),
  ];
}

const HELP = `cxt resolve [<path>] [选项]

打印该路径解析出的四要素 + 每项来源层（凭证打码）。排查"为什么这个目录
用了这个 token"的第一招——**每项都标了来源层**，不用猜。

  <path>                 按该目录解析（默认：当前目录）
  --cwd <path>           覆盖 cwd 要素本身（与 <path> 不同：它也参与绑定匹配）
  --token <name>         token 的**名字**（不是密钥）
  --token-value <v>      直接给密钥
  --url <u>              覆盖 baseUrl
  --model <id>           覆盖模型（走 -c 差量，不落盘）
  --json                 机器可读输出
  -h, --help             本帮助

⚠️ 与 cxt run 的差别：resolve 一律按 **run 入口** 解析（token.cwd 生效）。
   想看 exec 入口的解析结果，用 \`cxt exec --print\`。
`;

export const command = { spec, run };
