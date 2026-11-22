// @ts-check
/**
 * ★ 启动前校验（§2.5「启动前校验」）——部署在 `cxt exec` 真正 spawn **之前**。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 它是什么，不是什么
 *
 * 是：启动前拉**一次** `GET {baseUrl}/models`（2 秒超时），从 `models`
 * 里挑第一个**端点确实有**的。中转站下线某个模型时，用户不用先撞一次 404。
 *
 * **不是**故障转移。四条边界缺一条它就变成别的东西了：
 *
 * | 边界 | 为什么 |
 * |------|--------|
 * | **只读** | 不写配置、不写 `resources.json`、不碰受管区——"看一眼"不该留下痕迹 |
 * | **只做一次** | 会话内重试 = 自动故障转移（§1.4 明令不做） |
 * | **只在真实启动路径** | `--print` 是诊断视图，端点不通也得秒回 |
 * | **可关** | `defaults.preflight: false` |
 *
 * ## 为什么"失败"一律静默
 *
 * 内网端点、没有 `/models` 的网关、偶发超时——这三种都是**常态**。
 * 每次都喊一嗓子，用户学会的第一件事就是无视这条警告，而那正是
 * "真出事时他也看不见"的前奏。**只有端点明确答复了、而结论和配置不一样**，
 * 才值得说话。
 *
 * ## 为什么凭证从 `injection.env` 取
 *
 * 那条路已经做完 `${ENV_VAR}` 求值（§2.4），**不新增第二条取密钥的路**
 * ——多一条路就多一处能在错误消息里漏出明文的地方。
 * ─────────────────────────────────────────────────────────────
 */

import { chooseAvailable } from '../core/models.js';
import { SOURCE } from '../core/resolve.js';
import { fetchModels } from '../platform/fetch-models.js';

/**
 * 启动前校验的**超时**。
 *
 * 10 秒是面板第 3 步的预算（那里用户盯着屏幕等结果）；
 * 这里是**每次启动**都要付的等待，2 秒是"足以走完一次 TLS 握手 + 一次往返"与
 * "端点挂了也不至于让人以为 cxt 卡死"之间的取舍（§2.14 六）。
 */
const PREFLIGHT_TIMEOUT_MS = 2000;

/**
 * 这一轮**该不该**校验。纯判断，不发请求——`--print` 也调它（只为了印一行说明）。
 *
 * @param {any} resolved
 * @param {boolean} [enabled] 默认读 `resolved.preflight`
 * @returns {boolean}
 */
export function preflightApplies(resolved, enabled = resolved?.preflight !== false) {
  if (enabled === false) return false;
  // ★ `--model` 是用户这次点名要的，不参与（§2.5）——猜错他的话不如照他说
  if (resolved?.model?.source === SOURCE.CLI) return false;
  const models = resolved?.models?.value;
  return Array.isArray(models) && models.length >= 2;
}

/**
 * 校验并（可能）旋转 `resolved`。
 *
 * **永不抛、永不落盘、永不阻塞**——最坏情况就是原样放行。
 *
 * @param {object} input
 * @param {any} input.resolved `resolveSession()` 的产物
 * @param {any} input.injection `injectionFor()` 的产物（已求值）
 * @param {boolean} [input.enabled] 默认读 `resolved.preflight`
 * @param {(i: any) => Promise<{ok: boolean, ids: string[]}>} [input.fetch] 测试注入
 * @returns {Promise<{ resolved: any, note: string | null }>}
 *   `resolved` 是**同一个对象**（没换人）或一份旋转过的新副本；`note` 是给人看的一句话
 */
export async function preflightModels({ resolved, injection, enabled, fetch = fetchModels }) {
  const none = { resolved, note: null };
  if (!preflightApplies(resolved, enabled)) return none;

  const baseUrl = resolved.baseUrl?.value;
  if (typeof baseUrl !== 'string' || baseUrl === '') return none;

  const authToken = injection?.env?.[resolved.envKeyName];
  if (typeof authToken !== 'string' || authToken === '') return none;

  /** @type {{ok: boolean, ids: string[]}} */
  let got;
  try {
    got = await fetch({ baseUrl, authToken, timeoutMs: PREFLIGHT_TIMEOUT_MS });
  } catch {
    return none; // §"为什么失败一律静默"
  }
  if (got === null || typeof got !== 'object' || got.ok !== true) return none;
  if (!Array.isArray(got.ids) || got.ids.length === 0) return none;

  const list = resolved.models.value;
  const first = list[0].id;
  const { models, picked } = chooseAvailable(list, got.ids);

  if (picked === 0) return none;
  if (picked < 0) {
    return {
      resolved,
      note: `启动前校验：${baseUrl} 的清单里没有 ${first}，仍按配置启动`,
    };
  }

  // ★ `models` 与 `model` **一起**换：`model` 不跟着走的话，
  //   `-c model=` 拼的还是旧值，而 resolved 里又多出一个"首位是 b"的谎。
  const rotated = {
    ...resolved,
    models: { ...resolved.models, value: models },
    model: {
      ...resolved.model,
      // ★ 与 `models.value[0]` 是**同一个对象**（`chooseAvailable` 保住了引用，
      //   label 也跟着来）——这两处指向不同对象的话，"当前模型"就有了两个版本。
      value: models[0],
      source: SOURCE.PREFLIGHT,
      detail: `启动前校验：${first} 不在端点清单里`,
    },
  };

  return {
    resolved: rotated,
    note: `启动前校验：${first} 不在 ${baseUrl} 的清单里，本次改用 ${models[0].id}`,
  };
}
