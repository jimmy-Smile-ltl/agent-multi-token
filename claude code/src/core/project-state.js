// @ts-check
/**
 * 项目状态（§2.12 十一 的「项目状态与身份联动」）。
 *
 * ─────────────────────────────────────────────────────────────
 * **一个文件夹就是一个项目**；状态（未开始 / 进行中 / 已完成…）存在
 * `projects.json` 里，键是 `normalizeForCompare(path, platform)`。
 *
 * ★★ **本文件是纯函数**（§4.2）：不读 fs、不读 `process.env`、不读 `process.platform`。
 * 读写落在 `core/store.js` 的 `readProjectState()` / `writeProjectState()`。
 *
 * ★★ **为什么不把状态塞进 `config.json` 的 binding**：`schema.js` 对 binding 是
 * `rejectUnknownKeys` 的——旧版本读到一条带 `status` 的绑定会**整份拒载**。
 * 而且状态属于"文件夹"而不是"绑定"：从没绑过的目录也该能标状态。
 *
 * ★★ **颜色的值是"名字"不是 hex**（`slate` / `blue` / …）。明暗两套色值归
 * `src/web/style.css`，这里存 hex 会让暗色模式下的那一套彻底失效。
 * ─────────────────────────────────────────────────────────────
 */

import { normalizeForCompare } from './bindings.js';

/** `projects.json` 的版本（独立于 `config.json` 的，别混） */
export const PROJECTS_VERSION = 1;

/**
 * 可选的颜色词表。
 *
 * ★ 加一个颜色 = 同时改这里与 `src/web/style.css` 的两套变量（明暗各一份）。
 * 这是**故意**的两处：CSS 那一处是唯一知道"亮色下这个蓝是什么"的地方。
 */
export const STATUS_COLORS = Object.freeze([
  'slate', 'blue', 'teal', 'green', 'amber', 'red', 'purple', 'pink',
]);

/** 状态个数的上限。只防手滑，不给任何人一个"无限列表"的承诺。 */
export const MAX_STATUSES = 12;

/** 名称最长多少个字符（按 JS 的 UTF-16 单元算，一个汉字=1）。 */
const MAX_LABEL = 16;

/** 状态 id 的形态。**id 是内部主键，不是给人看的**（给人看的是 label）。 */
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

/**
 * 默认的五档。**第一条是"没设过"的默认值**（`statusFor()` 的回退目标），
 * 所以它一定得是"什么都没发生"那种状态。
 */
export const DEFAULT_STATUSES = Object.freeze([
  Object.freeze({ id: 'todo', label: '未开始', color: 'slate' }),
  Object.freeze({ id: 'doing', label: '进行中', color: 'blue' }),
  Object.freeze({ id: 'wait', label: '受阻', color: 'amber' }),
  Object.freeze({ id: 'done', label: '已完成', color: 'green' }),
  Object.freeze({ id: 'fail', label: '失败', color: 'red' }),
]);

/**
 * 状态指向一个**已经被删掉**的 id 时用的那个（灰色、不可选）。
 * `statusFor()` 只在那种情况下返回它——**绝不**把它写回文件。
 */
export const UNKNOWN_STATUS = Object.freeze({ id: '', label: '未知状态', color: 'slate' });

// ───────────────────────────── 键 ─────────────────────────────

/**
 * 项目在 `projects` 里的键。
 *
 * ★★ 复用 `normalizeForCompare()`——`D:\work` 与 `d:/work/` 必须是同一个项目。
 * **绝不在这里写第二套归一化**：那两套迟早会给出两个不同的键，而症状是
 * "我明明改过状态，它却变回去了"。
 *
 * @param {string} path
 * @param {NodeJS.Platform | string} platform
 */
export function projectKey(path, platform) {
  return normalizeForCompare(path, platform);
}

// ───────────────────────────── 读：宽容 ─────────────────────────────

/** @returns {{ version: number, statuses: {id: string, label: string, color: string}[], projects: Record<string, {status: string}> }} */
export function defaultProjectState() {
  return {
    version: PROJECTS_VERSION,
    statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
    projects: {},
  };
}

/**
 * 把盘上的东西收成**一定可用**的形状。**永不抛错**——调用方是每次重绘都要跑的
 * `buildPanelData()`，一份手改坏的 `projects.json` 不该让控制台打不开。
 *
 * 宽容到什么程度：
 * - 整个文件不是对象 → 全默认
 * - `statuses` 不是数组 / 一条都不合法 → 全默认
 * - 某一条的颜色认不出 → 落到 `slate`（保留名字与 id，好过让一整档消失）
 * - `projects` 里不合法的条目 → **丢掉那一条**（其余照常）
 * - 指向已删状态的条目 → **保留**（渲染时显示成"未知状态"，用户自己重新选）
 *
 * @param {unknown} raw
 */
export function normalizeProjectState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return defaultProjectState();
  }
  const obj = /** @type {Record<string, unknown>} */ (raw);

  /** @type {Record<string, {status: string}>} */
  const projects = {};
  const src = obj.projects;
  if (src !== null && typeof src === 'object' && !Array.isArray(src)) {
    for (const [key, value] of Object.entries(/** @type {Record<string, unknown>} */ (src))) {
      if (key === '') continue;
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      const status = /** @type {Record<string, unknown>} */ (value).status;
      if (typeof status !== 'string' || status === '') continue;
      projects[key] = { status };
    }
  }

  return {
    version: PROJECTS_VERSION,
    statuses: normalizeStatusList(obj.statuses),
    projects,
  };
}

/**
 * @param {unknown} raw
 * @returns {{id: string, label: string, color: string}[]}
 */
function normalizeStatusList(raw) {
  if (!Array.isArray(raw)) return DEFAULT_STATUSES.map((s) => ({ ...s }));

  /** @type {{id: string, label: string, color: string}[]} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= MAX_STATUSES) break;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const s = /** @type {Record<string, unknown>} */ (item);
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (!ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: cleanLabel(s.label) || id,
      color: isColor(s.color) ? /** @type {string} */ (s.color) : 'slate',
    });
  }
  return out.length > 0 ? out : DEFAULT_STATUSES.map((s) => ({ ...s }));
}

// ───────────────────────────── 查 ─────────────────────────────

/**
 * 这个项目当前**该显示**哪一档。
 *
 * 三种情况：设过 → 那一档；没设过 → 第一档（默认 = 未开始）；
 * 设过但那一档被删了 → `UNKNOWN_STATUS`。
 *
 * @param {{ statuses: {id: string, label: string, color: string}[], projects: Record<string, {status: string}> }} state
 * @param {string} path
 * @param {NodeJS.Platform | string} platform
 * @returns {{id: string, label: string, color: string}}
 */
export function statusFor(state, path, platform) {
  const entry = state.projects[projectKey(path, platform)];
  if (entry === undefined) return state.statuses[0] ?? { ...UNKNOWN_STATUS };
  return state.statuses.find((s) => s.id === entry.status) ?? { ...UNKNOWN_STATUS };
}

/**
 * 这个项目**存着的**状态 id（`''` = 从没设过）。页面设下拉的当前值时用它，
 * 不能拿 `statusFor()` 的结果——那会把"没设过"和"设成第一档"抹成一样。
 *
 * @param {{ projects: Record<string, {status: string}> }} state
 * @param {string} path
 * @param {NodeJS.Platform | string} platform
 */
export function statusIdFor(state, path, platform) {
  return state.projects[projectKey(path, platform)]?.status ?? '';
}

/** @param {unknown} color */
export function isColor(color) {
  return typeof color === 'string' && STATUS_COLORS.includes(color);
}

/** @param {unknown} id */
export function hasStatus(state, id) {
  return state.statuses.some((s) => s.id === id);
}

/**
 * 被**至少一个项目**用着的那些状态（删它们要被拒）。
 * 返回对象而不是 id，是为了错误提示能说人话（用户认的是"进行中"，不是 `doing`）。
 *
 * @param {{ statuses: {id: string, label: string, color: string}[], projects: Record<string, {status: string}> }} state
 * @returns {{id: string, label: string, color: string}[]}
 */
export function usedStatuses(state) {
  const ids = new Set(
    Object.values(state.projects)
      .map((p) => p?.status)
      .filter((id) => typeof id === 'string' && id !== ''),
  );
  return state.statuses.filter((s) => ids.has(s.id));
}

// ───────────────────────────── 写：严格 ─────────────────────────────

/**
 * 校验一份**用户刚编辑完**的状态表（"管理状态"对话框点保存时走这里）。
 *
 * 与 `normalizeProjectState()` 的宽容是**故意相反**的：读盘要能容错，
 * 写盘时用户敲错的名字必须被拦下来——静默改成别的颜色，用户下次打开会以为自己在做梦。
 *
 * @param {unknown} raw 页面上那组 `{id, label, color}`（新行 `id === ''`）
 * @param {{id: string, label: string, color: string}[]} [used] 被项目用着的状态
 * @returns {{ ok: true, statuses: {id: string, label: string, color: string}[] }
 *   | { ok: false, error: string }}
 */
export function validateStatuses(raw, used = []) {
  if (!Array.isArray(raw)) return { ok: false, error: '状态列表得是一个数组' };
  if (raw.length === 0) return { ok: false, error: '至少要留一个状态' };
  if (raw.length > MAX_STATUSES) return { ok: false, error: `状态最多 ${MAX_STATUSES} 个` };

  /** @type {{id: string, label: string, color: string}[]} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, error: '每个状态都得是一条，不能是别的东西' };
    }
    const s = /** @type {Record<string, unknown>} */ (item);
    const id = typeof s.id === 'string' ? s.id.trim() : '';
    if (id !== '' && !ID_RE.test(id)) return { ok: false, error: `状态的内部 id 不合法：${id}` };
    if (id !== '' && seen.has(id)) return { ok: false, error: `状态的内部 id 重复了：${id}` };
    const label = cleanLabel(s.label);
    if (label === '') return { ok: false, error: '状态的名称不能为空' };
    if (!isColor(s.color)) return { ok: false, error: `认不出的颜色：${String(s.color)}` };
    if (id !== '') seen.add(id);
    out.push({ id, label, color: /** @type {string} */ (s.color) });
  }

  const statuses = assignIds(out);
  const ids = new Set(statuses.map((s) => s.id));
  const missing = used.filter((s) => !ids.has(s.id));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `这些状态还有项目在用，不能删：${missing.map((s) => `「${s.label}」`).join('、')}`,
    };
  }
  return { ok: true, statuses };
}

/**
 * 给新行补上内部 id。**服务端分配**（页面传来的一律当 `''`）——
 * 让浏览器生成主键就是把"唯一性"交给一个没有全局视野的地方。
 *
 * @param {{id: string, label: string, color: string}[]} list
 */
export function assignIds(list) {
  const used = new Set(list.map((s) => s.id).filter((id) => id !== ''));
  let n = 1;
  return list.map((s) => {
    if (s.id !== '') return { ...s };
    while (used.has(`s${n}`)) n++;
    const id = `s${n}`;
    used.add(id);
    return { ...s, id };
  });
}

/**
 * 给一个项目**换一档**。返回新对象，不改入参（与 reducer 同一个纪律）。
 *
 * @param {{ version: number, statuses: any[], projects: Record<string, {status: string}> }} state
 * @param {string} path
 * @param {NodeJS.Platform | string} platform
 * @param {string} id
 */
export function withStatus(state, path, platform, id) {
  const key = projectKey(path, platform);
  return { ...state, projects: { ...state.projects, [key]: { status: id } } };
}

/**
 * 换一整张状态表。**不校验**（`validateStatuses()` 已经校验过了）——
 * 这里只负责把 `statuses` 换掉，`projects` 的指向原样保留。
 *
 * @param {{ version: number, statuses: any[], projects: Record<string, {status: string}> }} state
 * @param {{id: string, label: string, color: string}[]} statuses
 */
export function withStatuses(state, statuses) {
  return { ...state, statuses: statuses.map((s) => ({ ...s })) };
}

// ───────────────────────────── 小件 ─────────────────────────────

/**
 * @param {unknown} v
 * @returns {string}
 */
function cleanLabel(v) {
  return typeof v === 'string' ? v.trim().slice(0, MAX_LABEL) : '';
}
