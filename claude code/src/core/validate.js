// @ts-check
/**
 * 四要素完整性校验（§2.1）。
 *
 * **启动一个 Claude 会话需要完整四项，缺任何一项都不许启动**，且报错要**指名缺哪一项**。
 * 本模块是 resolve 之后、spawn 之前的最后一道闸门。
 *
 * ─────────────────────────────────────────────────────────────
 * 与 §2.5 规则 3 的协调（容易看错，这里写死）：
 *
 *     `models` 从未被任何一层声明   → 缺项，报错（不知道用哪个模型）
 *     `models` 被声明为 `[]`        → **合法**（显式选择"不注入，用 Claude Code 自身默认"）
 *
 * 同理，`${VAR}` 引用但环境变量没设置 → 缺项（会在错误里指名那个变量，§2.4）。
 * ─────────────────────────────────────────────────────────────
 */

/**
 * 四要素的展示名与"缺了会怎样"（§2.1 的表）。
 * `key` 与四要素一一对应，供调用方按 key 定位（别只靠 label 文案）。
 */
const ELEMENTS = {
  cwd: { key: 'cwd', label: '本地路径', why: '不知道在哪跑' },
  token: { key: 'token', label: 'token', why: '无法认证' },
  apiUrl: { key: 'apiUrl', label: 'apiUrl', why: '打不到端点' },
  model: { key: 'model', label: 'model', why: '不知道用哪个模型' },
};

/**
 * @typedef {{ key: 'cwd' | 'token' | 'apiUrl' | 'model', label: string, why: string, hint: string }} Missing
 */

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isFilled(v) {
  return typeof v === 'string' && v !== '';
}

/**
 * 校验 `resolveConfig()` 的结果。
 *
 * **不抛异常**——返回结构化的缺项列表，让调用方自己决定是报错（`cmt run`）
 * 还是只展示一行状态（`cmt resolve`）。
 *
 * @param {any} resolved
 * @returns {{ ok: boolean, missing: Missing[] }}
 */
export function validateSession(resolved) {
  /** @type {Missing[]} */
  const missing = [];
  const tokenName = resolved?.tokenName?.value ?? null;

  if (!isFilled(resolved?.cwd?.value)) {
    missing.push({
      ...ELEMENTS.cwd,
      hint: '用 `cmt run --cwd <path>` 指定工作目录',
    });
  }

  const authTokenRef = resolved?.authToken?.ref ?? null;
  if (authTokenRef && !authTokenRef.set) {
    // §2.4：未设置时**指名变量**，绝不静默回退成字面量
    missing.push({
      ...ELEMENTS.token,
      hint: `引用的环境变量 ${authTokenRef.name} 未设置。先设置它（例：export ${authTokenRef.name}=<key>）`,
    });
  } else if (!isFilled(resolved?.authToken?.value)) {
    missing.push({
      ...ELEMENTS.token,
      hint: tokenName
        ? `token \`${tokenName}\` 没有 authToken。补上：\`cmt token edit ${tokenName} --token <key>\``
        : '没有任何一层提供 authToken。建一个 token：`cmt token add relay-a --token <key> --base-url <url>`',
    });
  }

  // baseUrl 与 authToken 同规则（§2.4）。`else if` 是必须的：
  // 否则「引用未设置」与「值为空」会同时报两条，同一屏上自相矛盾。
  const baseUrlRef = resolved?.baseUrl?.ref ?? null;
  if (baseUrlRef && !baseUrlRef.set) {
    // §2.4：未设置时**指名变量**，绝不静默回退成字面量
    missing.push({
      ...ELEMENTS.apiUrl,
      hint: `引用的环境变量 ${baseUrlRef.name} 未设置。先设置它（例：export ${baseUrlRef.name}=<url>）`,
    });
  } else if (!isFilled(resolved?.baseUrl?.value)) {
    missing.push({
      ...ELEMENTS.apiUrl,
      hint: tokenName
        ? `补上端点：\`cmt token edit ${tokenName} --base-url <url>\``
        : '没有任何一层提供 baseUrl。例：`cmt bind <path> --url https://api.deepseek.com/anthropic`',
    });
  }

  if (!resolved?.models?.declared) {
    missing.push({
      ...ELEMENTS.model,
      hint: '没有任何一层声明 models。例：`cmt model set --global deepseek-flash[1m]`（或显式设成 [] 表示用 Claude Code 自身默认）',
    });
  }

  return { ok: missing.length === 0, missing };
}

/**
 * 把缺项渲染成人能读的一段话（§6.2：报错必须给出下一步命令）。
 * @param {Missing[]} missing
 */
export function renderMissing(missing) {
  const lines = [`四要素不完整，缺 ${missing.length} 项：`];
  for (const m of missing) {
    lines.push(`  ✗ ${m.label} —— ${m.why}`);
    lines.push(`      ${m.hint}`);
  }
  return lines.join('\n');
}
