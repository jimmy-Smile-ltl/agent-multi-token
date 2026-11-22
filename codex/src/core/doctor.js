// @ts-check
/**
 * `cxt doctor` 的**判定逻辑**（§5）——纯函数，不碰 fs、不读 `process.*`（§4.2）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么判定和采集要分开
 *
 * doctor 要问的东西大半在文件系统里（文件多大、目录在不在、二进制在哪），
 * 而 `core/` 里**只有 `store.js` 允许碰 fs**。于是这里只做一件事：
 * **收已经读好的事实，吐 `Finding`**。
 *
 * 好处不只是分层好看：判定逻辑因此**可测**——"AGENTS.md 100 B vs 上限 50 B"
 * 这种用例不需要在磁盘上造一个 100 字节的文件（真去造的话，测试里的那个
 * 数字就会变成 §7.11 警告过的"写进断言的具体字节数"）。
 *
 * ## Finding 的形状
 *
 * `id` 是**稳定标识**，`--json` 的消费方按它匹配。`title` 是给人看的一句话，
 * **随时可以改**——别拿它当键。
 *
 * | level | 含义 | 影响退出码 |
 * |-------|------|:---:|
 * | `ok` | 查了，没问题 | 否 |
 * | `info` | 查了，有个"知道就好"的事（如 §7.14① 的 BOM） | 否 |
 * | `warn` | 有问题但**不阻塞**（8.3 短名、AGENTS.md 会被截断、未信任项目） | 否 |
 * | `error` | **阻塞**：照现在这样跑不起来 | ✅ 是 |
 *
 * ★ **warn 不影响退出码**是有意的：doctor 是体检不是门禁。用户仓库的
 * AGENTS.md 太长、这个目录还没被信任——都是**用户自己的决定**，
 * 不是 cxt 坏了。让它们把 CI 变红，用户就会学会忽略 doctor 的输出。
 * ─────────────────────────────────────────────────────────────
 */

import { looksLikeShortName } from './bindings.js';
import { EXIT } from './errors.js';

/**
 * Codex 的 `project_doc_max_bytes` **默认值**（§7.11）。
 *
 * ⚠️⚠️ **这个数字和 §7.11 / §5 里那条"代码里不许出现任何具体字节常量"不冲突，
 * 但极易被误读，所以把两者的区别钉在这里：**
 *
 * - 被禁的是**文档自己的大小**。§7.11 给过一个实测值当量级感，但那句话本身
 *   就说了它会过期——**本文件里一个这样的数字都不许出现**，注释里也不许
 *   （`tests/doctor.test.js` 有一条源码扫描守着这件事）。理由是它必然说谎：
 *   文档每编辑一次，写死的数字就错一次，而"读到的"永远不会错。
 * - 被**要求**的是**配置项的缺省值**：§5 原文"缺省按 <这个数> 算"、
 *   §6.3 原文"`project_doc_max_bytes` 缺失时按 <同一个数> 兜底"。
 *   它不随本文档编辑而变，它是 Codex 的行为。
 *
 * ⇒ 所以：**文档大小一律从磁盘读，一个字节都不许写死；
 *    这个上限只在"配置里没写"时兜底，且全仓库只有这一处定义。**
 *    测试要断言它，也只许 import 这个名字，不许重打一遍字面量
 *    （`tests/doctor.test.js` 有一条源码扫描守着这件事：本文件里 4 位以上的
 *    数字字面量**只允许出现一次**，就是下面这一行）。
 */
export const CODEX_DEFAULT_PROJECT_DOC_MAX_BYTES = 32768;

/** @typedef {'ok' | 'info' | 'warn' | 'error'} Level */

/**
 * @typedef {object} Finding
 * @property {string} id     稳定标识（`--json` 消费方按它匹配；`title` 可以改，它不行）
 * @property {Level} level
 * @property {string} title  一句话结论
 * @property {string} [detail] 展开说明
 * @property {string} [hint]   下一步敲什么
 * @property {any} [data]      结构化明细（`--json` 用）
 */

// ═══════════════════════════ 文档截断（§7.11 / §5）═══════════════════════════

/**
 * 从 `config.toml` 文本里读 `project_doc_max_bytes`。
 *
 * ★ **只看顶层**：遇到第一个 `[table]` 表头就停。`[profiles.x]` 或
 * `[model_providers.x]` 底下就算有同名键，也不是 Codex 读的那个全局上限——
 * 把它当上限报出来，就是在制造一个"看起来查过了"的假结论。
 *
 * 返回**四态**而不是 `number | null`：`null` 分不清"没写"和"写了但读不懂"，
 * 而这两者该说的话完全不同（前者兜底、后者要提示用户）。
 *
 * @param {string} tomlText
 * @returns {{ present: boolean, value: number | null, raw: string | null, malformed: boolean }}
 *   `malformed: true` = 键在、值解析不出来（值不是整数 / 写成了字符串 / 是负数）
 */
export function parseProjectDocMaxBytes(tomlText) {
  /** @type {{ present: boolean, value: number | null, raw: string | null, malformed: boolean }} */
  const absent = { present: false, value: null, raw: null, malformed: false };
  if (typeof tomlText !== 'string' || tomlText === '') return absent;

  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    // 顶层键必须出现在任何表头之前——见到表头就收工（见上）
    if (line.startsWith('[')) return absent;

    const m = /^project_doc_max_bytes\s*=(.*)$/.exec(line);
    if (!m) continue;

    // ⚠️ 这里**不能**要求"等号后面有东西"才算这个键存在：
    //    `project_doc_max_bytes =`（值写漏了）是一行**坏配置**，
    //    而"键不在 → 用默认值"会把它静默读成"没配"——正是 doctor 要消灭的那类静默。
    const raw = m[1].trim();
    const value = parseTomlInteger(raw);
    // 负数没有意义（"最多读 -1 字节"），当读不懂处理
    if (value === null || value < 0) {
      return { present: true, value: null, raw, malformed: true };
    }
    return { present: true, value, raw, malformed: false };
  }
  return absent;
}

/**
 * 文档会不会被截断（§7.11）——**本模块最要紧的一条检查**。
 *
 * 为什么值得单列：**截断是完全静默的**。Codex 不报错、不警告，只是读到一半就停，
 * 表现是"文档后面那几节好像不存在"。用户不会怀疑工具，只会怀疑自己记错了。
 *
 * ★ 比的是**字节**不是字符（§6.3）：中文一个字三字节，拿 `String.length`
 * 去比会算出**只有真实值三分之一**的"安全余量"——正是本文档超限三倍
 * 却"看起来不长"的原因。
 *
 * @param {{ docBytes: number | null, docPath: string | null, maxBytes: number | null,
 *           maxBytesSource: 'config' | 'default' | 'malformed' }} input
 *   `docBytes: null` = 没找到文档 → 返回 `null`（"没有文档"不是这条检查的结论）
 *   `maxBytesSource: 'malformed'` = 配置里写了但读不懂 → 提示，不猜上限
 * @returns {Finding | null}
 */
export function checkDocTruncation(input) {
  const { docBytes, docPath, maxBytes, maxBytesSource } = input;

  // ★ "配置读不懂"排在"有没有文档"**之前**：这两个是独立的事，
  //   而且前者是**用户的配置坏了**，不该因为恰好没有 AGENTS.md 就被吞掉。
  if (maxBytesSource === 'malformed') {
    return {
      id: 'doc-max-bytes-malformed',
      level: 'warn',
      title: '配置里的 project_doc_max_bytes 读不出来，无法判断文档会不会被截断',
      detail: '它必须是个非负整数（TOML 整数）。cxt **不猜**——猜错了会给出一个'
        + '"查过了"的假结论，而截断本身是完全静默的。',
      hint: '改掉它，或删掉这一行改用 Codex 的默认上限',
      data: { docBytes: docBytes ?? null, docPath },
    };
  }

  if (docBytes === null || docBytes === undefined) return null;

  const name = docPath === null ? 'AGENTS.md' : baseNameOf(docPath);

  if (maxBytes === null) {
    return {
      id: 'doc-max-bytes-malformed',
      level: 'warn',
      title: '缺少可比的上限，无法判断文档会不会被截断',
      detail: '调用方既没读到配置值、也没给缺省值。这是 cxt 自己的 bug，请报 issue。',
      data: { docBytes, docPath },
    };
  }

  if (docBytes > maxBytes) {
    return {
      id: 'doc-truncated',
      level: 'warn',
      title: `${name} ${docBytes} B > project_doc_max_bytes ${maxBytes} B，Codex 将静默截断到第 ${maxBytes} 字节`,
      detail: `超了 ${docBytes - maxBytes} B（${(docBytes / maxBytes).toFixed(2)}×）。`
        + '截断**不报错**——文档后面那几节会像不存在一样，用户只会怀疑自己记错了。',
      hint: `在 ${maxBytesSource === 'default' ? 'config.toml' : '该 profile 的 config.toml'} 里`
        + `把 project_doc_max_bytes 调到 ${docBytes} 以上（这个键 cxt 不代管，得你自己写）`,
      data: { docBytes, docPath, maxBytes, maxBytesSource, overBy: docBytes - maxBytes },
    };
  }

  return {
    id: 'doc-ok',
    level: 'ok',
    title: `${name} ${docBytes} B ≤ 上限 ${maxBytes} B（不会被截断）`,
    data: { docBytes, docPath, maxBytes, maxBytesSource },
  };
}

// ═══════════════════════════ 8.3 短名（§7.3）═══════════════════════════

/**
 * 路径长得像 8.3 短名 → 提示（§7.3 铁律：**只提示，绝不归一化**）。
 *
 * 同一个目录在 Windows 上有两个都合法的拼写（`C:\Users\alice` /
 * `C:\Users\ALICE~1`），而**信任记录是字符串比较**：拿短名写的信任，
 * 长名 cwd 匹配不上，反之亦然。这是"信任明明写了却不生效"的另一个静默来源。
 *
 * ⚠️ 判据是**长什么样**，不是"它是不是真的短名"——判断后者要读盘
 * （且 `%TEMP%` 这种由系统给的值本来就没得选）。所以这里只提醒，
 * 且提醒里要说清"如果它确实指向你要的那个目录"。
 *
 * @param {string | null} p
 * @param {string} platform
 * @returns {Finding | null}
 */
export function checkShortName(p, platform) {
  if (typeof p !== 'string' || p === '') return null;
  if (!looksLikeShortName(p, platform)) return null;
  return {
    id: 'short-name',
    level: 'warn',
    title: `${p} 看起来是 8.3 短名`,
    detail: '同一个目录在 Windows 上有两个合法拼写（`C:\\Users\\alice` 与 '
      + '`C:\\Users\\ALICE~1`），而信任记录是**字符串比较**：'
      + '用短名写的信任，长名 cwd 匹配不上，反之亦然。',
    hint: '如果它确实指向你要的那个目录，把命令里的路径换成**长名**再试一次；'
      + 'cxt 不替你归一化（§7.3 铁律 4：写的是用户给的字面路径）',
    data: { path: p, platform },
  };
}

// ═══════════════════════════ 信任三态（§7.3 / §7.6）═══════════════════════════

/**
 * 当前目录的信任状态 → Finding。
 *
 * ★ **三态不是二态**（§7.3 真机实测）。`untrusted` 与"从没见过"在 Codex 里
 * 是**两个不同的状态**，resolved 出来的 `approval_policy` 都不一样
 * （`UnlessTrusted` vs `OnRequest`）。报成一句"未受信任"，用户就会困惑于
 * "我明明没标记过它"——所以两条的措辞必须分开。
 *
 * @param {{ state: 'trusted' | 'untrusted' | 'unmarked', path: string,
 *           nearMisses?: { path: string, line: number, reason: string }[] }} input
 * @returns {Finding[]} 主结论 + （有的话）写法错条目
 */
export function checkTrustState(input) {
  const { state, path } = input;
  const nearMisses = input.nearMisses ?? [];
  /** @type {Finding[]} */
  const out = [];

  if (state === 'trusted') {
    out.push({
      id: 'trust-trusted',
      level: 'ok',
      title: `${path} 已标记为可信`,
      data: { state, path },
    });
  } else if (state === 'untrusted') {
    out.push({
      id: 'trust-untrusted',
      level: 'warn',
      title: `${path} 被**显式**标记为不可信（trust_level = "untrusted"）`,
      detail: '这和"从没见过"不是一回事：Codex 内部是三个状态，'
        + '这条走的审批档位是 `UnlessTrusted`，未标记走的是 `OnRequest`。'
        + '项目级 `.codex/config.toml` 不会生效。',
      hint: `要改成可信：\`cxt trust ${path}\``,
      data: { state, path },
    });
  } else {
    out.push({
      id: 'trust-unmarked',
      level: 'warn',
      title: `${path} 没有任何信任记录（从未标记过）`,
      detail: '这个目录下启动 codex 会**问你**要不要信任它（走 `OnRequest`）'
        + '——这是你自己的安全策略，cxt 不绕、也不替你决定。'
        + '⚠️ 这条与 Codex 的 `exec` 子命令要求 git 仓库**无关**（§7.6）：'
        + 'cxt 启动的是交互式 codex，那条 git 要求跟我们没关系。',
      hint: `要预先标记：\`cxt trust ${path}\``,
      data: { state, path },
    });
  }

  // ★ 写法错的条目单独报：它们是**静默失配**的元凶，而 readTrust 已经把它们
  //   认出来了（正斜杠 / `\\?\` 前缀 / 尾部分隔符）。不报出来，用户看到的就是
  //   "我明明写了信任却不生效"。
  for (const nm of nearMisses) {
    out.push({
      id: 'trust-near-miss',
      level: 'warn',
      title: `信任记录第 ${nm.line} 行的写法 Codex 认不出：${nm.reason}`,
      detail: `写的是 ${nm.path}`,
      hint: '信任记录是**字符串比较**（§7.3）：路径必须用 Windows 原生反斜杠。'
        + '`cxt trust <path>` 会就地把它修成规范写法',
      data: nm,
    });
  }

  return out;
}

// ═══════════════════════════ 绑定悬空引用（§3.3）═══════════════════════════

/**
 * 绑定表里指向不存在的 token → 报出来（§3.3：不静默留悬空绑定）。
 *
 * @param {{ bindings: { path?: string, token?: string }[], tokenNames: string[] }} input
 * @returns {Finding[]} 一条汇总（悬空项全列在 `data` 里）
 */
export function checkDanglingBindings(input) {
  const { bindings, tokenNames } = input;
  const known = new Set(tokenNames);
  const dangling = bindings
    .map((b, i) => ({ index: i, path: b?.path ?? '', token: b?.token ?? '' }))
    .filter((b) => !known.has(b.token));

  if (dangling.length === 0) {
    return [{
      id: 'bindings-ok',
      level: 'ok',
      title: `绑定表 ${bindings.length} 条，全部指向存在的 token`,
      data: { count: bindings.length },
    }];
  }

  return [{
    id: 'bindings-dangling',
    level: 'warn',
    title: `${dangling.length} 条绑定指向不存在的 token`,
    detail: dangling.map((d) => `  ${d.path} → ${d.token}`).join('\n'),
    hint: '这些路径下解析不出 token（四要素会缺一项）。'
      + '`cxt bind ls` 看全表；`cxt bind <path> --token <t>` 重指，或删掉 `tokens/<t>.json` 的那条绑定',
    data: { dangling },
  }];
}

// ═══════════════════════════ 受管区卫生（§7.14①）═══════════════════════════

/**
 * 受管区文件带 BOM → **提示级**（§7.14① 已降级）。
 *
 * ★ 别把它写成"致命"：0.163.0 实测**带 BOM 照样通过** config 检查，
 * provider section 也照样被读到。理由从"Codex 会拒绝"换成了"卫生与可移植"——
 * `config.toml` 是双作者文件，用户可能用别的 TOML 工具读它，那些工具**会**被 BOM 噎住。
 *
 * @param {{ text: string, path: string }} input
 * @returns {Finding }
 */
export function checkBom(input) {
  const { text, path } = input;
  if (!text.startsWith('\uFEFF')) {
    return { id: 'bom-ok', level: 'ok', title: '受管区文件不带 BOM', data: { path } };
  }
  return {
    id: 'bom-present',
    level: 'info',
    title: '受管区文件带 BOM（当前 Codex 能容忍，其它 TOML 工具不一定）',
    detail: '0.163.0 实测带 BOM 也能正常加载（**当前这个版本容忍它**），所以不是故障。'
      + '但 TOML 规范本身不容许 BOM，而 `config.toml` 是双作者文件——'
      + '编辑器插件、CI 脚本、别的语言的 TOML 库都可能在它上面噎住。',
    hint: '下次 `cxt exec` 会顺手剥掉它（拼接器每次都剥），不必手工处理',
    data: { path },
  };
}

// ═══════════════════════════ 项目级禁区键（§7.3）═══════════════════════════

/**
 * ★ **提示清单，不是判据。**
 *
 * Codex 在**项目级** `.codex/config.toml` 里静默忽略这些键（§7.3）。用户把它们
 * 写在那儿，唯一的症状是"我明明配了却不生效"——所以值得提示。
 *
 * ⚠️ 三条纪律，写代码时别越界：
 * 1. §7.3 原文："**禁区清单随版本演进，写代码时不要硬编码假设**"。
 *    所以这个清单只用来**说一句话**，绝不参与任何判定（不决定退出码、不决定写不写）。
 * 2. 别拿"没警告"推断"没被忽略"——Codex 那条警告**只在真正的启动路径上打印**，
 *    `codex doctor` 里根本不出现（§7.3）。
 * 3. `sandbox_mode` / `approval_policy` / `sandbox_workspace_write.*`
 *    **不在**禁区里（§7.3 有真机证据，且点名有一份第三方清单把它们列错了）。
 *    别"顺手补全"进来。
 */
export const PROJECT_LOCAL_IGNORED_KEYS = Object.freeze([
  'openai_base_url',
  'chatgpt_base_url',
  'model_provider',
  'model_providers',
  'notify',
  'profile',
  'profiles',
  'otel',
  'experimental_realtime_ws_base_url',
  'apps_mcp_product_sku',
]);

/**
 * 项目级配置里出现了禁区键 → 提示（§7.3）。
 *
 * 只做**文本扫描**：这个文件可能满是用户手写的注释与格式，正经解析它是
 * `toml-splice.js` 的活，而这里只需要"提到了没有"。
 *
 * @param {{ text: string, path: string } | null} input `null` = 该文件不存在（正常）
 * @returns {Finding | null} 文件不存在 → `null`
 */
export function checkProjectLocalIgnoredKeys(input) {
  if (input === null) return null;
  const { text, path } = input;

  /** @type {string[]} */
  const found = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (line === '') continue;

    // 表头 `[model_providers.x]` / 顶层赋值 `model_provider = "x"`，两种都算
    const m = /^\[+\s*([A-Za-z0-9_-]+)/.exec(line)
      ?? /^([A-Za-z0-9_-]+)\s*=/.exec(line);
    if (!m) continue;
    const key = m[1];
    if (PROJECT_LOCAL_IGNORED_KEYS.includes(key) && !found.includes(key)) found.push(key);
  }

  if (found.length === 0) return null;

  return {
    id: 'project-local-ignored-keys',
    level: 'info',
    title: `项目级配置里有 ${found.length} 个键会被 Codex 静默忽略：${found.join('、')}`,
    detail: 'Codex 在项目级 `.codex/config.toml` 里丢弃这些键（§7.3），'
      + '**不报错**——症状只是"我明明配了却不生效"。'
      + '官方理由是：项目文件不能覆盖"重定向凭证、改 provider 认证、选 profile、'
      + '跑机器本地命令或上报遥测"的设置。',
    hint: '要它们生效，得写进**用户级** config.toml（即该 profile 的 config.toml）。'
      + '⚠️ 但 cxt 只代管受管区——`model_provider` / `model_providers` 正是受管区的内容，'
      + '用 `cxt token edit` 改配置即可',
    data: { path, keys: found },
  };
}

// ═══════════════════════════ 汇总 ═══════════════════════════

/**
 * 汇总 findings → 计数与退出码。
 *
 * ★ **只有 `error` 影响退出码**（见文件头）。warn 是"你的仓库/你的目录"的事，
 * 不是"cxt 坏了"——把两者混在一起，用户就会学会无视 doctor。
 *
 * @param {Finding[]} findings
 * @returns {{ counts: Record<Level, number>, exitCode: number, hasError: boolean }}
 */
export function summarize(findings) {
  /** @type {Record<Level, number>} */
  const counts = { ok: 0, info: 0, warn: 0, error: 0 };
  for (const f of findings) counts[f.level] += 1;
  const hasError = counts.error > 0;
  return { counts, exitCode: hasError ? EXIT.ENV : EXIT.OK, hasError };
}

// ═══════════════════════════ 小工具 ═══════════════════════════

/**
 * 去掉 TOML 行内注释——**引号里的 `#` 不是注释**。
 *
 * 朴素地 `split('#')[0]` 在 `foo = "a#b"` 上会切错；这里只需处理单行，
 * 所以按引号状态走一遍就够（多行字符串不属于本函数要认的那几个键）。
 *
 * @param {string} line
 */
function stripTomlComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote === '') {
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '#') return line.slice(0, i);
    } else if (ch === quote) {
      quote = '';
    }
  }
  return line;
}

/**
 * TOML 整数 → number；不是整数就 `null`。
 *
 * 支持 `_` 分隔符与 `0x`/`0o`/`0b` 前缀（TOML 都合法），**不支持浮点**
 * ——"最多读 N.5 字节"是没意义的，宁可当读不懂报出来。
 *
 * @param {string} raw
 * @returns {number | null}
 */
function parseTomlInteger(raw) {
  const s = raw.replace(/_/g, '').trim();
  if (/^[+-]?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^[+-]?0x[0-9a-fA-F]+$/.test(s)) return Number.parseInt(s, 16);
  if (/^[+-]?0o[0-7]+$/.test(s)) return Number.parseInt(s.slice(2), 8);
  if (/^[+-]?0b[01]+$/.test(s)) return Number.parseInt(s.slice(2), 2);
  return null;
}

/**
 * 取路径最后一段（`AGENTS.md` / `CLAUDE.md`）。
 * 两种分隔符都认——win32 上 cwd 可能来自任何来源。
 * @param {string} p
 */
function baseNameOf(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? p : p.slice(i + 1);
}
