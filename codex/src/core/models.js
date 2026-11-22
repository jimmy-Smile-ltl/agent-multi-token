// @ts-check
/**
 * ★ `models` 的**有序优先级表**运算（§2.5）。
 *
 * `models[0]` 优先级最高，它就是本次会话的默认模型。
 * `models[1..]` 不是"自动故障转移队列"——cxt **不实现**会话内自动回退
 * （Codex 没有等价的 `--fallback-model`，假装能做到只会让人误判）。
 * 它们是**人工提拔栈**：
 *
 * ```bash
 * cxt model next      # 轮转一位：models[1] 升为首位
 * cxt run -c          # 新窗口，codex resume --last 续上刚才的会话
 * ```
 *
 * 唯一的例外是**启动前那一次校验**（`chooseAvailable`，§2.5）：它不是故障转移——
 * 只读、只做一次、失败不阻塞，而且**只发生在新进程启动之前**。
 *
 * ─────────────────────────────────────────────────────────────
 * **两条运算，刻意不同**：
 *
 * | 运算 | 语义 | 反复执行 |
 * |------|------|---------|
 * | `rotateNext` | `[a,b,c]` → `[b,c,a]` | **不会耗光候选**（转回来了） |
 * | `promoteModel(id)` | `[a,b,c]` + `c` → `[c,a,b]` | 幂等（已在首位则不动） |
 *
 * **轮转而非删除**是有意的：故障切换时人可能来回试好几次，
 * 删掉就等于每试一次少一个候选，最后没得选。
 *
 * 纯函数：**不落盘、不改入参**（返回新数组）。写哪一层是 CLI 的事（§2.5 的表）。
 * ─────────────────────────────────────────────────────────────
 */
import { CxtError } from './errors.js';

/**
 * @typedef {object} ModelEntry
 * @property {string} id
 * @property {string} [label] 展示名；缺省时显示 `id`
 */

/**
 * 当前生效的模型（`models[0]`）。空表返回 `null`。
 * @param {ModelEntry[] | undefined} models
 * @returns {ModelEntry | null}
 */
export function currentModel(models) {
  return models != null && models.length > 0 ? models[0] : null;
}

/**
 * 列表里的全部 id，顺序即优先级。给 `--pick` 的选择器与 `resolve --print` 用。
 * @param {ModelEntry[] | undefined} models
 * @returns {string[]}
 */
export function modelIds(models) {
  return Array.isArray(models) ? models.map((m) => m.id) : [];
}

/**
 * 展示用的名字：有 `label` 用 `label`，否则退回 `id`。
 * @param {ModelEntry} m
 */
export function modelLabel(m) {
  return m.label && m.label !== '' ? m.label : m.id;
}

/**
 * ★ 轮转一位：`[a,b,c]` → `[b,c,a]`（§2.5）。
 *
 * 长度不变，所以**反复 next 一定能回到原点**——这是"候选不会被耗光"的保证。
 *
 * ⚠️ **少于两项时抛错，而不是静默 no-op。** 理由与 §2.5 `--pick` 那条一致：
 * 单元素列表"轮转"完还是它自己，用户敲完 `cxt model next` 看不出任何变化，
 * 会以为命令坏了。**宁可明确报错**，告诉他"这个列表里没有下一个"。
 * （`--pick` 单元素仍弹选择器，是同一条原则的另一个面。）
 *
 * @param {ModelEntry[]} models
 * @returns {ModelEntry[]} 新数组
 */
export function rotateNext(models) {
  const list = Array.isArray(models) ? models : [];

  if (list.length === 0) {
    throw new CxtError('优先级列表是空的，没有下一个模型', {
      hint: '先用 `cxt model set <id>[:label] ...` 声明候选（顺序即优先级）',
    });
  }
  if (list.length === 1) {
    throw new CxtError(`优先级列表只有一项（${list[0].id}），没有下一个`, {
      hint: '再加几个候选：`cxt model set <id1> <id2> ...`——'
        + '轮转的意义就是在候选之间切换',
    });
  }

  return [...list.slice(1), list[0]];
}

/**
 * ★ 把指定模型**提到首位**，其余保持相对顺序（§2.5）。
 *
 * `[a,b,c]` 提拔 `c` → `[c,a,b]`。**原首位退到第二**，所以随时能 `use a` 切回去
 * ——这正是"人工故障转移"要的手感。
 *
 * - id 已在首位 → 原样返回（内容相同的新数组）。这是**合法的** no-op：
 *   用户要的状态已经成立，报成功是诚实的
 * - id 不在列表里 → **插到首位**（§6.3）。新候选没必要非得先 `model set` 一遍
 * - 空列表 → `[{ id }]`
 *
 * `label` 从原条目带过来；插入新条目时不编造 label。
 *
 * @param {ModelEntry[] | undefined} models
 * @param {string} id
 * @returns {ModelEntry[]} 新数组
 */
export function promoteModel(models, id) {
  const list = Array.isArray(models) ? models : [];
  const target = String(id);

  const at = list.findIndex((m) => m.id === target);
  if (at < 0) return [{ id: target }, ...list];
  if (at === 0) return [...list];

  // 带出原条目（保住 label），其余保持相对顺序
  return [list[at], ...list.slice(0, at), ...list.slice(at + 1)];
}

/**
 * ★ 启动前校验的纯逻辑（§2.5「启动前校验」）：从优先级里挑第一个**端点确实有的**。
 *
 * ```
 * chooseAvailable(['a','b','c'], ['b','c'])  → { models: [b,c,a], picked: 1, missing: ['a'] }
 * chooseAvailable(['a','b','c'], ['a','b'])  → { models: [a,b,c], picked: 0, missing: ['c'] }
 * chooseAvailable(['a','b'],      ['x'])     → { models: [a,b],   picked: -1, missing: ['a','b'] }
 * ```
 *
 * **旋转而不是直接返回 `b`**：被选中的提到首位、其余保持相对顺序——与
 * `rotateNext` / `promoteModel` 同一套语义。这样"本次用 b"这件事在
 * resolved 里是**看得见**的（`model` 就是 `models[0]`），而 `--fallback-model`
 * 之类下游逻辑天然接着取 `models[1..]`。
 *
 * ⚠️ **一个都不在时绝不"随便挑一个"**（`picked === -1`）：那等于替用户
 * 决定"用哪个模型跑"，而这类猜测的错法要到 Codex 报 404 时才显形——**离现场太远**。
 *
 * 纯函数：不改入参、不落盘、不发请求。
 *
 * @param {ModelEntry[] | undefined} models 配置里的优先级
 * @param {string[] | undefined} availableIds 端点说的清单（顺序无意义）
 * @returns {{ models: ModelEntry[], picked: number, missing: string[] }}
 *   `picked` 是**原索引**（0 = 首位命中，-1 = 一个都没有）；
 *   `missing` 是不在清单里的 id（保序，用来拼那句提示）
 */
export function chooseAvailable(models, availableIds) {
  const list = Array.isArray(models) ? models : [];
  const have = new Set(Array.isArray(availableIds) ? availableIds : []);
  const missing = list.filter((m) => !have.has(m.id)).map((m) => m.id);

  const at = list.findIndex((m) => have.has(m.id));
  if (at < 0) return { models: [...list], picked: -1, missing };

  return {
    models: [list[at], ...list.slice(0, at), ...list.slice(at + 1)],
    picked: at,
    missing,
  };
}

/**
 * 该列表是否**显式为空**（`[]`）。
 *
 * 与"没声明"是两件事（§2.5）：`[]` = "不注入模型，用 Codex 自身默认"，合法；
 * `undefined` = 该层没说话，继续往上继承。
 * @param {unknown} models
 */
export function isEmptyList(models) {
  return Array.isArray(models) && models.length === 0;
}

/**
 * 合并两份列表（上层 + 覆盖层），**覆盖层存在即整体替换**，不做并集。
 *
 * §2.4 的表里写着 `models` 在 binding / token / defaults 三层都能写，
 * 且是"**整体覆盖**"而非按键合并——这条容易被"顺手合并一下"改坏：
 * 一旦并集，用户就没法用 `models: [x]` 表达"这个目录只用 x"了。
 *
 * @param {ModelEntry[] | undefined} inherited
 * @param {ModelEntry[] | undefined} override
 * @returns {ModelEntry[] | undefined}
 */
export function mergeModels(inherited, override) {
  return override !== undefined ? override : inherited;
}
