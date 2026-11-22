// @ts-check
/**
 * 启动前的**完整性校验**（§2.1）+ 参数一致性校验（§2.5）。
 *
 * ─────────────────────────────────────────────────────────────
 * ## 为什么和 `resolve.js` 分开
 *
 * `resolve()` **不抛"缺项"错**——它把缺项收集在 `missing` 里。
 * 分开的理由很实际：`cxt resolve` 的价值恰恰在于**告诉你哪一项没设置**，
 * 一上来就抛错就什么都看不到了。
 *
 * 真正"不许启动"的是**启动路径**：`cxt run` / `cxt exec` 在 spawn 之前调
 * `assertComplete()`，缺项就指名报错退出（码 1）。
 *
 * 一句话：**resolve 负责"尽量解析出来"，validate 负责"不够就别启动"。**
 * ─────────────────────────────────────────────────────────────
 *
 * ⚠️ 本文件只做**结构性**判断，不做任何 I/O、不读环境变量。
 * `${ENV_VAR}` 的求值发生在 `cxt exec` 注入环境之前（§2.4），那是启动路径的事——
 * 在这里求值会让 `cxt resolve` 在变量没设时直接跑不出结果。
 */

import { CxtError } from './errors.js';

/**
 * 四要素的展示名与"该去哪配"的提示（§2.1 的表）。
 * `hint` 是给用户下一步该敲什么，不是泛泛的说明。
 */
const ELEMENT_HELP = {
  cwd: {
    label: 'cwd（本地路径）',
    hint: '加 --cwd <路径>，或给 token 加 cwd 字段：`cxt token edit <name> --cwd <路径>`'
      + '（⚠️ token.cwd 只对 `cxt run` 生效，`cxt exec` 会用你当前所在的目录）',
  },
  authToken: {
    label: 'authToken（凭证）',
    hint: '加 --token-value <key>，或在 token / defaults 里配 authToken：'
      + '`cxt token edit <name> --token <key>`',
  },
  baseUrl: {
    label: 'baseUrl（服务地址）',
    hint: '加 --url <地址>，或在 token / defaults 里配 baseUrl：'
      + '`cxt token edit <name> --url https://api.deepseek.com/`',
  },
  model: {
    label: 'model（模型）',
    hint: '声明候选列表：`cxt model set <id>[:<label>] ...`（首项即默认），'
      + '或本次临时指定：`cxt run --model <id>`',
  },
};

/**
 * 列出缺了哪些四要素。**只报，不抛。**
 * @param {any} resolved `resolve()` 的产物
 * @returns {string[]}
 */
export function findMissing(resolved) {
  const m = resolved?.missing;
  return Array.isArray(m) ? [...m] : [];
}

/**
 * ★ **四要素必须齐全，缺任何一项都不许启动**（§2.1）。
 *
 * 报错要**指名缺哪一项**——"配置不完整"这种话等于没说。
 * 多项同时缺就一次全列出来，免得用户修一个跑一次。
 *
 * @param {any} resolved
 * @returns {any} 原样返回，便于链式调用
 */
export function assertComplete(resolved) {
  const missing = findMissing(resolved);
  if (missing.length === 0) return resolved;

  const labels = missing.map((k) => ELEMENT_HELP[k]?.label ?? k);
  const hint = missing
    .map((k) => `· ${ELEMENT_HELP[k]?.label ?? k}：${ELEMENT_HELP[k]?.hint ?? '见 cxt --help'}`)
    .join('\n');

  throw new CxtError(
    `四要素不齐全，缺少：${labels.join('、')}`,
    { hint: `${hint}\n（用 \`cxt resolve\` 可以看完整的解析结果与每一项的来源层）` },
  );
}

/**
 * 参数一致性校验（§2.5）。
 *
 * 只校验**互斥**——语义重叠的两个选项不许"定义个优先级"糊过去，
 * 因为用户永远记不住谁压谁，出问题时也看不出是自己写错了。
 *
 * @param {any} argv 解析后的命令行
 */
export function assertArgvConsistent(argv) {
  const a = argv ?? {};

  // §2.5：`--model` 与 `--pick` 都是"显式指定模型"，语义重叠
  if (a.model !== undefined && a.pick === true) {
    throw new CxtError('--model 与 --pick 不能同时用', {
      hint: '两者都是"显式指定模型"。要指定具体某个用 --model <id>，'
        + '要从候选里挑一个用 --pick',
    });
  }

  // §2.3：`terminalMode` 的两个来源是同层的，别让"后写的赢"
  if (a.window === true && a.tab === true) {
    throw new CxtError('--window 与 --tab 不能同时用', {
      hint: '选一个：--window 开新窗口，--tab 在当前窗口开标签页',
    });
  }

  return a;
}

/**
 * ★ 非 TTY 下 `--pick` 必须报错，**绝不静默取 `models[0]`**（§2.5）。
 *
 * 静默退化是最糟的一种"成功"：CI 里跑出来的会话用了哪个模型，
 * 用户以为自己挑过，其实没有。
 *
 * @param {any} argv
 * @param {boolean} isTty
 * @param {boolean} [jsonMode]
 */
export function assertPickUsable(argv, isTty, jsonMode = false) {
  if (argv?.pick !== true) return;

  if (jsonMode) {
    throw new CxtError('--pick 不能与 --json 同用', {
      hint: '选择器要读 stdin，输出 JSON 时没有交互的地方。改用 --model <id>',
    });
  }
  if (!isTty) {
    throw new CxtError('--pick 需要交互式终端（stdin 不是 TTY）', {
      hint: '管道 / CI 环境请改用 --model <id> 显式指定。'
        + 'cxt 不会替你静默选一个——那会让"这次用了哪个模型"变得不可知',
    });
  }
}
