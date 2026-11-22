// @ts-check
/**
 * 自写参数解析（§4.3 零依赖铁律——不用 commander）。
 *
 * 支持：
 *   --flag              布尔开关
 *   --key value         取值选项
 *   --key=value         取值选项（内联）
 *   -c                  短名（经 alias 映射到规范名）
 *   --                  之后的一切原样进 `rest`，**不做任何解析**
 *
 * 不支持的（刻意）：短名合并（`-abc`）。本项目没有需要它的场景，
 * 而合并会让 `--` 透传的语义变得含混。
 *
 * ⚠️ 对 cxt 尤其重要：`--` 之后的内容会**原样转给 codex**，
 * 中间不经过任何 shell。所以 `--` 的"不解析"必须是彻底的——
 * 连 `--foo=bar` 这种形态也不能碰（§2.11 设计红利）。
 */
import { CxtError } from '../core/errors.js';

/**
 * @typedef {object} ParseSpec
 * @property {string[]} [boolean] 布尔开关名
 * @property {string[]} [string] 取值选项名
 * @property {Record<string, string>} [alias] 别名/短名 → 规范名
 */

/**
 * @param {string[]} argv
 * @param {ParseSpec} [spec]
 * @returns {{ _: string[], rest: string[] } & Record<string, any>}
 */
export function parseArgs(argv, spec = {}) {
  const bools = new Set(spec.boolean ?? []);
  const strs = new Set(spec.string ?? []);
  const alias = spec.alias ?? {};

  /** @type {any} */
  const out = { _: [], rest: [] };
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (passthrough) {
      out.rest.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      continue;
    }
    // 位置参数（`-` 单独出现按位置参数处理，习惯上表示 stdin）
    if (!arg.startsWith('-') || arg === '-') {
      out._.push(arg);
      continue;
    }

    const isLong = arg.startsWith('--');
    const body = isLong ? arg.slice(2) : arg.slice(1);
    const eq = body.indexOf('=');
    const rawName = eq === -1 ? body : body.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
    const name = alias[rawName] ?? rawName;

    if (bools.has(name)) {
      if (inlineValue !== undefined) {
        throw new CxtError(`选项 ${arg} 不接受取值`, {
          hint: `去掉 "=${inlineValue}"，或改用 --help 查看用法`,
        });
      }
      out[name] = true;
      continue;
    }

    if (strs.has(name)) {
      let value = inlineValue;
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) {
          throw new CxtError(`选项 ${arg} 缺少取值`, { hint: `用法：--${name} <值>` });
        }
      }
      // 同一选项重复出现 → 收成数组（`--model a --model b`）
      if (out[name] === undefined) out[name] = value;
      else if (Array.isArray(out[name])) out[name].push(value);
      else out[name] = [out[name], value];
      continue;
    }

    throw new CxtError(`未知选项 ${arg}`, { hint: '用 `cxt --help` 查看可用选项' });
  }

  return out;
}

/**
 * 把某个选项统一成数组（无论用户敲了几次）。
 * @param {unknown} v
 * @returns {string[]}
 */
export function toArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
