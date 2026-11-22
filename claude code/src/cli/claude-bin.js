// @ts-check
/**
 * 定位 claude 可执行文件（§2.10 末的四档顺序）。
 *
 * 1. `defaults.claudeBin`（显式配置，或上次探测后写回的缓存）
 * 2. `findExecutable('claude')`——纯 JS 查 PATH，不 spawn `which` / `where`
 * 3. 常见安装路径 `claudeFallbackPaths()`
 * 4. 都没有 → `EnvError`（退出码 2）
 *
 * 命中 2 或 3 时把绝对路径**写回 `defaults.claudeBin`**，下次免探测。
 *
 * ─────────────────────────────────────────────────────────────
 * ⚠️ **Windows 上的 `.cmd` 陷阱**：npm 全局装的 claude 是 `claude.cmd`（批处理），
 * 而 Node 18.20+ / 20.12+ 出于安全（CVE-2024-27980）**拒绝直接 spawn `.cmd` / `.bat`**。
 * 所以真正拉起时必须经 `cmd.exe /c`——见 `claudeSpawnSpec()`。
 * 这一条与 §2.10 里"launch 脚本不能直接 spawn"是同一个坑，只是发生在另一个位置。
 * ─────────────────────────────────────────────────────────────
 */
import { existsSync } from 'node:fs';

import { EnvError } from '../core/errors.js';
import { claudeFallbackPaths, expandTilde } from '../core/paths.js';
import { saveConfig } from '../core/store.js';
import { findExecutable } from '../platform/index.js';

/**
 * @param {{
 *   resolved: any,
 *   ctx: import('./types.js').Ctx,
 *   config: any,
 *   configExists: boolean,
 *   persist?: boolean,
 * }} args
 * @returns {{ path: string, source: 'configured' | 'path' | 'fallback', warnings: string[] }}
 */
export function locateClaude({ resolved, ctx, config, configExists, persist = false }) {
  /** @type {string[]} */
  const warnings = [];

  // ── 1) 显式配置 ─────────────────────────────────────────────────
  // 配了就用它，**配错了就报错**——静默往下探测会让"我明明配了却没生效"极难排查。
  const configured = resolved.claudeBin?.value;
  if (configured) {
    const p = expandTilde(configured, ctx.home, ctx.platform);
    if (!existsSync(p)) {
      throw new EnvError(`配置里指定的 claude 可执行文件不存在：${p}`, {
        hint: '改掉配置里的 claudeBin，或用 `cmt run --claude-bin <绝对路径>` 临时指定',
      });
    }
    return { path: p, source: 'configured', warnings };
  }

  // ── 2) PATH ────────────────────────────────────────────────────
  const onPath = findExecutable('claude', { platform: ctx.platform, env: ctx.env });
  if (onPath) {
    warnings.push(...persistBin({ config, configExists, ctx, path: onPath, persist }));
    return { path: onPath, source: 'path', warnings };
  }

  // ── 3) 常见安装位置 ─────────────────────────────────────────────
  for (const p of claudeFallbackPaths(ctx.home, ctx.platform)) {
    if (existsSync(p)) {
      warnings.push(...persistBin({ config, configExists, ctx, path: p, persist }));
      return { path: p, source: 'fallback', warnings };
    }
  }

  // ── 4) 找不到 ──────────────────────────────────────────────────
  throw new EnvError('找不到 claude 可执行文件', {
    hint:
      '确认已安装（`npm i -g @anthropic-ai/claude-code`，或官方安装脚本），' +
      '或用 `cmt run --claude-bin <绝对路径>` / 配置 defaults.claudeBin 指定',
  });
}

/**
 * 把探测到的绝对路径写回 `defaults.claudeBin`，下次免探测。
 *
 * **写不进去不算失败**——缓存而已，`cmt run` 该照常跑。所以只返回一条警告。
 *
 * @param {{ config: any, configExists: boolean, ctx: import('./types.js').Ctx, path: string, persist: boolean }} a
 * @returns {string[]}
 */
function persistBin({ config, configExists, ctx, path, persist }) {
  if (!persist) return [];
  // §3.2 惰性创建：不为了缓存一个路径就凭空造出 config.json。
  // （真没有 config.json 时也必然没有 token，cmt run 走不到这里。）
  if (!configExists) return [];

  try {
    config.defaults = { ...config.defaults, claudeBin: path };
    saveConfig({ home: ctx.home, config });
    return [];
  } catch (err) {
    return [`探测到 claude 在 ${path}，但写回配置失败（${/** @type {any} */ (err).message}）——不影响本次启动`];
  }
}

/**
 * 真正 spawn 时用的 `{command, args}`。
 *
 * 只在 Windows 且目标是 `.cmd` / `.bat` 时才套一层 `cmd.exe /c`
 * （CVE-2024-27980：Node 直接拒绝 spawn 批处理）。
 *
 * @param {string} binPath
 * @param {string[]} args
 * @param {{ platform: NodeJS.Platform, env: Record<string, string | undefined> }} ctx
 * @returns {{ command: string, args: string[] }}
 */
export function claudeSpawnSpec(binPath, args, ctx) {
  if (ctx.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath)) {
    return { command: ctx.env.ComSpec ?? 'cmd.exe', args: ['/c', binPath, ...args] };
  }
  return { command: binPath, args };
}
