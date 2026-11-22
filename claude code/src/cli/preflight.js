// @ts-check
/**
 * ★ 启动前校验（契约 §2.5「启动前校验（不是故障转移）」）。
 *
 * 真正启动之前**拉一次** `GET {baseUrl}/models`，从配置的优先级里挑第一个
 * **端点确实有**的模型。挑中了别人就换成本次生效的那个；挑不中/问不到就按配置走。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 四条边界（缺一条它就不再是"校验"，而是 §1.4 明令不做的"自动故障转移"）
 *
 * 1. **只读**：不写配置、不写 `resources.json`、不碰 profile。结论只对**这一次运行**有效。
 * 2. **只做一次**：不在会话里重试、不监听中途失败——那是运维平台的事，不是 CLI 的。
 * 3. **只在真实启动路径做**：`--print` 不联网（它是诊断视图，要秒回）。
 * 4. **可关**：`defaults.preflight: false`（机器级偏好，默认 `true`）。
 *
 * ## 为什么失败一律静默
 *
 * 内网端点、临时断网、没有 `/models` 的老网关——失败是**常态**。每次启动都喊一嗓子，
 * 用户学会的是**无视这一行**，而那时真正要紧的那条提示也一起被无视了。
 * 所以只有"问到了、而且确实换了模型"和"问到了、一个都不在"这两种**有信息的**情况才说话。
 * ─────────────────────────────────────────────────────────────
 */
import { chooseAvailable, fillDefaultSlots } from '../core/models.js';
import { fetchModels } from '../platform/index.js';

/**
 * 2 秒，不是面板那 10 秒（`platform/fetch-models.js` 的默认值）。
 *
 * 判据是**谁在付这个等待**：面板的拉取是用户点了按钮、等着看清单；
 * 启动前校验是**每次启动都要付**的一次等待，2 秒没答案就当端点不可达。
 */
const PREFLIGHT_TIMEOUT_MS = 2000;

/**
 * 这一次启动该不该去问端点。
 *
 * 四种"连问都不问"：总闸关了 · `--model` 点名了 · 候选不足两个 · 没有清单。
 *
 * ★ `--model` 不参与校验（与 cxt 的 `model.source === 'cli'` 同一条）：那是用户
 * 这一次**点名要的**模型，端点没有也不换——换掉它才是错的。
 * 注意 cmt 在 `resolveConfig()` 里就把 `--model` 写成了 `models` 的来源，
 * 所以判据是 `models.source`，不是另有一个 `model` 字段。
 *
 * @param {any} resolved
 * @param {boolean} [enabled] 缺省读 `resolved.preflight`（`defaults.preflight`，§2.5）
 * @returns {boolean}
 */
export function preflightApplies(resolved, enabled = resolved?.preflight) {
  if (enabled === false) return false;
  if (resolved?.models?.source === 'cli') return false;
  const models = resolved?.models?.value;
  return Array.isArray(models) && models.length >= 2;
}

/**
 * 校验一次。**永不抛、永不阻塞**（最坏情况就是那 2 秒超时）。
 *
 * @param {{
 *   resolved: any,
 *   injection: { env?: Record<string, string> },
 *   enabled?: boolean,
 *   fetch?: typeof fetchModels,
 * }} input
 * @returns {Promise<{ resolved: any, note: string | null }>}
 *   `resolved` 与入参**同一个对象** = 没换人；换了人才是新对象。
 */
export async function preflightModels({ resolved, injection, enabled, fetch = fetchModels }) {
  const none = { resolved, note: null };
  if (!preflightApplies(resolved, enabled)) return none;

  const baseUrl = resolved.baseUrl?.value;
  if (typeof baseUrl !== 'string' || baseUrl === '') return none;

  // ★ 凭证**从注入结果里取**，不在这里再走一遍 `${VAR}` 求值：
  //   求值点只该有一处（§2.4）。求不出来时 `injection.unresolved` 已经把这次启动拦下了，
  //   这里连问都不问。
  const authToken = authTokenOf(resolved, injection);
  if (authToken === '') return none;

  /** @type {any} */
  let got;
  try {
    got = await fetch({ baseUrl, authToken, timeoutMs: PREFLIGHT_TIMEOUT_MS });
  } catch {
    return none;                          // 抛错 = 问不到 → 静默（边界：见文件头）
  }
  if (got === null || typeof got !== 'object' || got.ok !== true) return none;
  if (!Array.isArray(got.ids) || got.ids.length === 0) return none;

  const list = resolved.models.value;
  const first = list[0].id;
  const { models, picked } = chooseAvailable(list, got.ids);

  if (picked === 0) return none;          // 首位就在 → 原样（大多数时候）

  if (picked < 0) {
    // ★ 一个都不在**不能静默**：用户配的模型全没了，而他多半正要去查"为什么跑不起来"。
    return { resolved, note: `启动前校验：${baseUrl} 的清单里没有 ${first}，仍按配置启动` };
  }

  const rotated = {
    ...resolved,
    models: {
      ...resolved.models,
      value: models,
      source: 'preflight',
      detail: `启动前校验：${first} 不在端点清单里`,
    },
    // ★★ 槽位必须**从声明的那张表重算**，不能沿用解析时补好的那份：
    //    `resolved.slots` 是 `fillDefaultSlots(声明表, 旧 models)` 的结果，
    //    其中"跟着默认走"的那些槽指向的是**旧** `models[0]`。只换 `models` 不动它，
    //    本次会话的主模型是 b、而 opus/sonnet/haiku/subagent 四个槽还指着 a——
    //    那正是"看起来切了、实际没切"的那种失败。
    slots: fillDefaultSlots(resolved.slotsDeclared, models),
  };
  return { resolved: rotated, note: `启动前校验：${first} 不在 ${baseUrl} 的清单里，本次改用 ${models[0].id}` };
}

/**
 * 注入结果里那个认证值。
 *
 * `authMode` 决定落在哪个变量上（§2.6）：`"token"` → `ANTHROPIC_AUTH_TOKEN`（Bearer），
 * `"key"` → `ANTHROPIC_API_KEY`。两个都看一遍是**兜底**：`buildInjection()` 保证只注入一个，
 * 但它也可能是被 `env` 逃生舱写进来的——那同样是一份可用的凭证。
 *
 * @param {any} resolved
 * @param {{ env?: Record<string, string> }} injection
 * @returns {string}
 */
function authTokenOf(resolved, injection) {
  const env = injection?.env ?? {};
  const preferred = resolved.authMode?.value === 'key' ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
  for (const name of [preferred, 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    const v = env[name];
    if (typeof v === 'string' && v !== '') return v;
  }
  return '';
}
