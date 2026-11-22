// @ts-check
/**
 * ★ 模型目录生成（§7.5）——`model_catalog_json` 指向的那份 JSON。
 *
 * Codex 拿这份目录回答"这个模型上下文多大、支持哪些推理档位、有没有图片输入"。
 * 不写它，Codex 对一个陌生模型只能猜（`fallback model metadata` / `Unknown model`），
 * 猜错的后果是**自动压缩的时机不对**——而那是静默的，只在长会话里炸。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 🔴 两条"写错了就整个配置加载失败"的红线（真机实测）
 *
 * 1. **顶层必须是对象 `{"models": [...]}`**，裸数组 `[...]` 直接失败。
 * 2. **`models: []` 也是失败的**——空数组不是"没有目录"，是"非法目录"。
 *    ⇒ 所以 `buildCatalog()` 在模型列表为空时**抛错**，而不是生成一份空目录。
 *    `models` 为空的场景（`models: []` = "不注入模型"）**根本不该有 catalog**。
 *
 * 这两条的失败方式都是 `✗ config config could not be loaded`，
 * 即**整个 config.toml 作废**——比"目录没生效"严重得多（§7.5 的两类失败表）。
 * ─────────────────────────────────────────────────────────────
 *
 * ## 必填字段集来自 serde 报错（不是第三方样例）
 *
 * §7.5 那张第三方字段表**不完整**：它没有 `visibility`，而 `visibility` 是必填。
 * 照抄那张表写出来的目录会让配置整个加载失败。本文件的 `CATALOG_REQUIRED`
 * 是**用 `codex doctor` 当 oracle 逐项试出来的**（2026-10-17，0.163.0）：
 *
 * | 字段 | 去掉会怎样 |
 * |------|-----------|
 * | `slug` / `display_name` | ❌ 加载失败 |
 * | `supported_reasoning_levels` | ❌ |
 * | `shell_type` | ❌ |
 * | `visibility` | ❌（第三方表里没有它） |
 * | `supported_in_api` | ❌ |
 * | `priority` | ❌ |
 * | `support_verbosity` | ❌ |
 * | `truncation_policy`（非空对象） | ❌ `{}` 也不行 |
 * | `experimental_supported_tools` | ❌ |
 * | `base_instructions` 或 `model_messages.instructions_template` | ❌ 二者必须有其一（**自定义校验，不是 serde**） |
 * | `context_window` / `max_context_window` / `effective_context_window_percent` / `default_reasoning_level` / `input_modalities` | ✅ 可省，但省了这份目录就没意义了 |
 *
 * ## 取值域（同样是实测，别照抄文档）
 *
 * - `visibility`：**只有 `"list"` 与 `"none"`**（`"default"` / `"hidden"` / `"public"` 全失败）
 * - `shell_type`：`"default"` / `"shell_command"` / `"unified_exec"` 均可（读回时会归一成 `unified_exec`）
 * - `truncation_policy`：`{ mode, limit }`，`mode` 取 `"tokens"` 或 `"bytes"`
 * - `default_reasoning_level`：**不校验**（写 `"bogus"` 也过）——但别因此乱写
 *
 * ## ★ `base_instructions` 默认写**空串**（有意的）
 *
 * 它是这个模型的**系统提示词**（§7.12：config.toml 里的同名键会覆盖它）。
 * 真机实测 `base_instructions = ""` **能加载**，于是 cxt 不必编造一段提示词
 * 去顶掉 Codex 自己的行为——**空串 = 不替用户做这个决定**。
 * 要定制就在生成的文件里改这一条。
 *
 * ## ★ 与已有文件的关系：**只补不删**
 *
 * `catalogs/*.json` 是 cxt 的产物（§3.1），但用户很可能手工调过它
 * （改上下文窗口、加推理档位）。所以重建时：
 * - **同 slug 的条目原样保留**，只补它缺的必填字段
 * - **多出来的条目（orphans）原样保留**，只在报告里点名
 * - 只增不改不删 ⇒ "删掉它下次自动重建"（§3.4）依然成立
 *
 * ⚠️ **本模块是纯函数**（§4.2）：输入 `{models, existing}`，输出 `{catalog, report}`。
 * 读文件、写文件都是 `store.js` 的事。
 */

import { CxtError } from './errors.js';

// ───────────────────────────── 字段清单 ─────────────────────────────

/**
 * 真机验过的**必填**字段（serde 侧）。
 * 缺任何一个 → Codex **拒绝加载整个 config.toml**（不是"忽略这一条"）。
 * @type {readonly string[]}
 */
export const CATALOG_REQUIRED = Object.freeze([
  'slug',
  'display_name',
  'supported_reasoning_levels',
  'shell_type',
  'visibility',
  'supported_in_api',
  'priority',
  'support_verbosity',
  'truncation_policy',
  'experimental_supported_tools',
]);

/**
 * 非必填，但**不写就失去 catalog 的意义**的那批（§7.5）。
 * `doctor` 会提示缺了哪几项。
 * @type {readonly string[]}
 */
export const CATALOG_RECOMMENDED = Object.freeze([
  'context_window',
  'max_context_window',
  'effective_context_window_percent',
  'default_reasoning_level',
  'input_modalities',
]);

/**
 * 每条目录项的默认元数据。**全部来自真机实测的形状**，不是抄文档。
 *
 * ⚠️ `context_window` 的默认值**刻意保守**。理由（§7.12）：
 * 报小了 → 自动压缩提前触发，浪费上下文，但**能跑**；
 * 报大了 → 压缩不触发，跑到一半 API 报错，**整个会话白跑**。
 * 两种错法不对称，所以往小的一边站。真实模型更大就在这里改。
 *
 * 注意这是**冻结的浅拷贝源**：`buildCatalog()` 每次深拷贝一份再改，
 * 免得某个调用方"顺手"改到了全局常量，把后面所有目录都带偏。
 */
export const CATALOG_DEFAULTS = Object.freeze({
  context_window: 65536,
  max_context_window: 65536,
  effective_context_window_percent: 95,
  default_reasoning_level: 'medium',
  supported_reasoning_levels: Object.freeze([
    Object.freeze({ effort: 'low', description: '快速回答' }),
    Object.freeze({ effort: 'medium', description: '平衡' }),
    Object.freeze({ effort: 'high', description: '深度推理' }),
  ]),
  input_modalities: Object.freeze(['text']),
  shell_type: 'default',
  visibility: 'list',
  supported_in_api: true,
  support_verbosity: false,
  truncation_policy: Object.freeze({ mode: 'tokens', limit: 60_000 }),
  experimental_supported_tools: Object.freeze([]),
  // ★ 空串是**有意**的：不编造系统提示词去顶掉 Codex 自己的行为（见文件头）
  base_instructions: '',
});

/** 写出去的键序——固定住，重复生成才能逐字节稳定（幂等）。 */
const KEY_ORDER = [
  'slug', 'display_name', 'description',
  'context_window', 'max_context_window', 'effective_context_window_percent',
  'default_reasoning_level', 'supported_reasoning_levels', 'input_modalities',
  'shell_type', 'visibility', 'supported_in_api', 'priority',
  'support_verbosity', 'truncation_policy', 'experimental_supported_tools',
  'base_instructions',
];

// ───────────────────────────── 工具 ─────────────────────────────

/**
 * 深拷贝（只处理 JSON 里会出现的形态）。用 `structuredClone` 也行，
 * 但那会连函数/类实例一起搬——这里刻意只认 JSON 值，别的东西**报错**更好。
 * @template T
 * @param {T} v
 * @returns {T}
 */
function cloneJson(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return /** @type {any} */ (v.map(cloneJson));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = cloneJson(x);
  return /** @type {any} */ (out);
}

/**
 * 按 `KEY_ORDER` 重排键，**未知键原样追加在后面**。
 *
 * 重排不是为了好看：JSON 的键序会影响 `JSON.stringify` 的字节输出，
 * 而"重建一次文件内容不变"（幂等）是 `doctor` 判断漂移的依据（§2.9 同一思路）。
 * 用户自己加的键（Codex 的目录里还有几十个可选字段）**一个都不能丢**，
 * 所以是"重排 + 追加"，不是"按白名单过滤"。
 * @param {Record<string, any>} entry
 */
function orderKeys(entry) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of KEY_ORDER) {
    if (Object.prototype.hasOwnProperty.call(entry, k)) out[k] = entry[k];
  }
  for (const [k, v] of Object.entries(entry)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
  }
  return out;
}

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 某个必填字段的兜底值。
 *
 * ⚠️ **不能直接查 `CATALOG_DEFAULTS`**：`slug` / `display_name` / `priority` 三个
 * 依赖具体模型与它在列表里的位置，放不进全局常量（`priority` 就是位置本身）。
 * 早先的写法直接查表，于是给已有条目补 `priority` 时补出个 `undefined`——
 * 而 `undefined` 在 JSON 里会被 `JSON.stringify` **整个丢掉**，
 * 结果就是"补了，但文件里还是没有"，真机加载失败。
 *
 * @param {string} key
 * @param {{ id: string, label?: string }} model
 * @param {number} index
 */
function defaultFor(key, model, index) {
  switch (key) {
    case 'priority': return index;
    case 'slug': return model.id;
    case 'display_name': return model.label && model.label !== '' ? model.label : model.id;
    default: return cloneJson(/** @type {any} */ (CATALOG_DEFAULTS)[key]);
  }
}

/**
 * `CATALOG_DEFAULTS` 覆盖不住的那些必填键——它们由 `defaultFor()` 现算。
 * `validateCatalog()` 与测试都拿它来守"常量表没漏项"。
 */
export const CATALOG_DERIVED_REQUIRED = /** @type {const} */ (['slug', 'display_name', 'priority']);

/**
 * 内部一致性哨兵：产出的条目必须带齐必填字段。
 *
 * 为什么值得一个运行时检查：`undefined` 在 `JSON.stringify` 里会被**静默丢掉**，
 * 于是"漏了一个必填字段"在产物里表现成"这个键根本不存在"——
 * 而 Codex 的失败方式是**拒绝加载整个 config.toml**。
 * 与其让用户去 `codex doctor` 的输出里大海捞针，不如在这里当场炸。
 * @param {Record<string, any>} entry
 * @param {string} slug
 */
function assertComplete(entry, slug) {
  for (const k of CATALOG_REQUIRED) {
    if (entry[k] === undefined) {
      throw new CxtError(`生成 catalog 条目 ${slug} 时漏了必填字段 "${k}"`, {
        hint: '这是 cxt 自身的缺陷（CATALOG_REQUIRED 与 CATALOG_DEFAULTS / CATALOG_DERIVED_REQUIRED 脱节了）。'
          + '别绕过去——缺字段会让 Codex 拒绝加载整个 config.toml',
      });
    }
  }
}

// ───────────────────────────── 生成 ─────────────────────────────

/**
 * @typedef {object} BuildReport
 * @property {string[]} added     新建的 slug（本次加进目录的模型）
 * @property {string[]} kept      已存在、原样保留的 slug
 * @property {Record<string, string[]>} filled
 *   已存在但缺必填字段、被补齐的：`{ slug: [字段名] }`
 * @property {string[]} orphans   在目录里但不在 `models` 列表里的 slug（**保留**，只点名）
 * @property {boolean} unchanged  产物与 `existing` 逐字节等价吗
 */

/**
 * 由模型列表生成/补齐一份目录。
 *
 * @param {{
 *   models?: { id: string, label?: string }[],  // 解析出的 models（顺序即优先级）
 *   existing?: unknown,                          // 已有目录文件的内容（没有就给 null）
 * }} input
 * @returns {{ catalog: { models: Record<string, any>[] }, report: BuildReport }}
 */
export function buildCatalog({ models, existing = null } = {}) {
  const list = Array.isArray(models) ? models : [];

  // ★ 空列表必须抛错，不能生成 `{"models": []}`——真机实测那是**加载失败**（见文件头）。
  //   调用方在"没有模型"时该做的是**不写这份文件**，不是写一份空的。
  if (list.length === 0) {
    throw new CxtError('模型列表为空，不能生成 catalog', {
      hint: '真机实测：{"models": []} 会让 Codex 拒绝加载整个 config.toml。'
        + '没有模型时应当**不写**这份目录，而不是写一份空的',
    });
  }

  const prev = isPlainObject(existing) && Array.isArray(existing.models)
    ? /** @type {Record<string, any>[]} */ (existing.models)
    : [];
  /** @type {Map<string, Record<string, any>>} */
  const prevBySlug = new Map();
  for (const e of prev) {
    if (isPlainObject(e) && typeof e.slug === 'string' && !prevBySlug.has(e.slug)) {
      prevBySlug.set(e.slug, e);
    }
  }

  /** @type {Record<string, any>[]} */
  const out = [];
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const kept = [];
  /** @type {Record<string, string[]>} */
  const filled = {};
  /** @type {Set<string>} */
  const used = new Set();

  list.forEach((m, index) => {
    const slug = String(m?.id ?? '');
    if (slug === '') {
      throw new CxtError('模型 id 不能为空，无法生成 catalog 条目', {
        hint: '检查 config.json / token 文件里的 models 列表',
      });
    }
    if (used.has(slug)) return;   // 同 slug 只写一条（真机允许重复，但重复没有意义）
    used.add(slug);

    const before = prevBySlug.get(slug);
    if (before === undefined) {
      // 新条目 = 全部默认元数据 + 三个"由模型与位置现算"的必填键
      /** @type {Record<string, any>} */
      const entry = { slug, display_name: defaultFor('display_name', m, index), ...cloneJson(CATALOG_DEFAULTS) };
      for (const k of CATALOG_DERIVED_REQUIRED) {
        if (entry[k] === undefined) entry[k] = defaultFor(k, m, index);
      }
      assertComplete(entry, slug);
      out.push(orderKeys(entry));
      added.push(slug);
      return;
    }

    // 已存在 → 原样保留（保住用户的手工调整），只补它缺的必填字段
    const entry = cloneJson(before);
    /** @type {string[]} */
    const missing = [];
    for (const k of CATALOG_REQUIRED) {
      if (entry[k] === undefined) {
        entry[k] = defaultFor(k, m, index);
        missing.push(k);
      }
    }
    // `base_instructions` / `model_messages` 二者必有其一的**自定义**校验
    if (entry.base_instructions === undefined && !isPlainObject(entry.model_messages)) {
      entry.base_instructions = CATALOG_DEFAULTS.base_instructions;
      missing.push('base_instructions');
    }
    if (missing.length > 0) filled[slug] = missing;
    assertComplete(entry, slug);
    out.push(orderKeys(entry));
    kept.push(slug);
  });

  /** @type {string[]} */
  const orphans = [];
  for (const e of prev) {
    const slug = isPlainObject(e) && typeof e.slug === 'string' ? e.slug : null;
    if (slug === null || used.has(slug)) continue;
    used.add(slug);
    orphans.push(slug);
    out.push(cloneJson(e));   // ★ 保留：删掉它只是"目录里少一条元数据"，但那是用户的编辑
  }

  const catalog = { models: out };
  // 逐字节等价 ⇒ 调用方可以跳过写盘（幂等，§2.9 同一套判据）。
  // 比的是**整个对象**而不是 `models` 数组：顶层多一个用户加的键也算变了。
  const unchanged = isPlainObject(existing) && JSON.stringify(catalog) === JSON.stringify(existing);

  return { catalog, report: { added, kept, filled, orphans, unchanged } };
}

// ───────────────────────────── 校验 ─────────────────────────────

/**
 * 结构校验。**`doctor` 用**——但注意 §7.5 的告诫：
 * 光看"JSON 合法"不够，真正的验收是把它喂给 Codex（`codex debug models`）。
 * 这里只能抓"我们已知会炸"的那几种，抓不到"Codex 换了 schema"。
 *
 * @param {unknown} catalog 目录文件的内容
 * @returns {{ errors: string[], notes: string[] }}
 */
export function validateCatalog(catalog) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const notes = [];

  if (!isPlainObject(catalog)) {
    errors.push('顶层必须是对象 {"models": [...]}——裸数组会让 Codex 拒绝加载整个配置');
    return { errors, notes };
  }
  if (!Array.isArray(catalog.models)) {
    errors.push('缺少 models 数组');
    return { errors, notes };
  }
  if (catalog.models.length === 0) {
    errors.push('models 是空数组——真机实测这会让 Codex 拒绝加载整个 config.toml');
    return { errors, notes };
  }

  const seen = new Set();
  catalog.models.forEach((e, i) => {
    const at = `models[${i}]`;
    if (!isPlainObject(e)) {
      errors.push(`${at} 不是对象`);
      return;
    }
    const slug = typeof e.slug === 'string' ? e.slug : '';
    if (slug === '') errors.push(`${at} 缺 slug（必填）`);
    else if (seen.has(slug)) notes.push(`${at} 与前面某条重复（slug=${slug}）——真机允许，但只会生效一条`);
    else seen.add(slug);

    for (const k of CATALOG_REQUIRED) {
      if (e[k] === undefined) errors.push(`${at}（${slug || '?'}）缺必填字段 ${k}`);
    }
    if (e.base_instructions === undefined && !isPlainObject(e.model_messages)) {
      errors.push(`${at}（${slug || '?'}）base_instructions 与 model_messages 必须有其二`);
    }
    if (isPlainObject(e.truncation_policy) && Object.keys(e.truncation_policy).length === 0) {
      errors.push(`${at}（${slug || '?'}）truncation_policy 不能是空表——真机实测 {} 会加载失败`);
    }
    if (e.visibility !== undefined && e.visibility !== 'list' && e.visibility !== 'none') {
      errors.push(`${at}（${slug || '?'}）visibility 只能是 "list" 或 "none"，收到 ${JSON.stringify(e.visibility)}`);
    }
    const miss = CATALOG_RECOMMENDED.filter((k) => e[k] === undefined);
    if (miss.length > 0) {
      notes.push(`${at}（${slug || '?'}）没写 ${miss.join(' / ')}——`
        + 'Codex 会退回内置猜测，长会话里的自动压缩时机可能不对');
    }
  });

  return { errors, notes };
}
