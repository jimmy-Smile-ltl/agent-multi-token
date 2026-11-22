// @ts-check
/**
 * 全部路径常量的**唯一来源**（§3.5：禁止在别处硬编码 `~/.codex-multi-token`）。
 *
 * 纯函数——`home` / `platform` 由调用方注入（§4.2：core 不读 `os.homedir()` / `process.platform`）。
 *
 * ─────────────────────────────────────────────────────────────
 * **两条路径规则，别混**：
 *
 * 1. **不接收 `platform` 的函数**（rootDir / configPath / tokenPath / profileDir / profileConfigPath）
 *    产出的是**宿主路径**——它们最终要交给本机的 fs / spawn 用。
 *    所以用 `node:path` 的原生 `join`，宿主是什么就用什么分隔符。✅
 *
 * 2. **接收 `platform` 的函数**（codexFallbackPaths / launchScriptPath / expandTilde）
 *    问的是"**那个平台**上路径长什么样"。必须按**目标平台**算，
 *    绝不能借宿主平台的 `join`——在 Windows 上 `join('/home/t','x')` 会得到
 *    `'\home\t\x'`，三平台规则就没法在本机单测了（§6.3）。
 *    注意 `launchScriptPath` 的 platform **不只决定扩展名**，是整条路径。
 *
 * 判据就一句：**这个函数收不收 `platform` 参数？**
 * ─────────────────────────────────────────────────────────────
 *
 * ⚠️ 还有**第三条**规则，只属于本项目：`[projects.'<path>']` 信任记录里的路径
 * 既不是规则 1 也不是规则 2——它是**Codex 的字符串比较输入**，
 * 必须保留 Windows 反斜杠原样。那件事在 `core/toml-value.js` 的
 * `toTomlPathKey()` 里，**别拿到这里来"顺手归一化"**（§2.11 三·2）。
 */
import { dirname, join, posix, win32 } from 'node:path';

/**
 * 按**目标平台**取 join（不是宿主平台）。规则 2 的实现。
 *
 * 导出是因为 `platform/find-executable.js` 也要按目标平台拼候选路径，
 * 而它同样需要"在 Windows 上算 Linux 路径"这种能力。
 * @param {NodeJS.Platform} platform
 */
export function joinFor(platform) {
  return platform === 'win32' ? win32.join : posix.join;
}

/**
 * 按**目标平台**取 dirname。规则 2 的实现，`joinFor()` 的姊妹。
 *
 * ★ 存在的理由是 `discoverProjectConfig()` 要**往上走**（§2.13 一），
 * 而"往上走"的终止条件只能靠 `dirname(p) === p`。
 * 这个等式在每个平台的根上都成立（本机实测 2026-10-18）：
 *
 * | 输入 | `dirname` | 终止 |
 * |------|-----------|:---:|
 * | `C:\` | `C:\` | ✅ |
 * | `C:\work` | `C:\` | — |
 * | `\\server\share` | 自己 | ✅ |
 * | `\\server\share\a` | `\\server\share\` | 下一轮终止 |
 * | `/` | `/` | ✅ |
 * | `.`（相对路径走到头） | `.` | ✅ |
 *
 * ⚠️ **`win32.join()` 会把正斜杠换成反斜杠**（`join('D:/x', 'y')` → `D:\x\y`），
 * 所以发现出来的路径**未必与传进来的 cwd 逐字同形**。本机运行时两者一致
 * （`process.cwd()` 本来就是宿主形状），差异只在跨平台单测里出现——而那正是要它正确的地方。
 * @param {NodeJS.Platform} platform
 */
export function dirnameFor(platform) {
  return platform === 'win32' ? win32.dirname : posix.dirname;
}

/** 运行时数据根目录名（挂在 home 下） */
export const APP_DIR_NAME = '.codex-multi-token';

/** @param {string} home */
export function rootDir(home) {
  return join(home, APP_DIR_NAME);
}

/** @param {string} home */
export function configPath(home) {
  return join(rootDir(home), 'config.json');
}

/**
 * 项目状态（§2.14 十 的「项目状态与身份联动」）。
 *
 * ★ 独立于 `config.json`：那份的 schema 是 `rejectUnknownKeys` 的，
 * 往里加字段会让旧版本**整份拒载**。
 * @param {string} home
 */
export function projectsPath(home) {
  return join(rootDir(home), 'projects.json');
}

/**
 * 资源登记（§2.14 十一 的「模型下拉与资源表」）：每个 token 拉到的模型清单、
 * 从哪个地址拉的、什么时候拉的。
 *
 * ★ 同样独立于 `config.json`。★ 它是**可丢弃**的：删了只会让下拉少几项，
 * 下一次「拉取」就回来了——这与 `config.json` / `tokens/` 的承重地位不同。
 * @param {string} home
 */
export function resourcesPath(home) {
  return join(rootDir(home), 'resources.json');
}

/**
 * token 池（§2.15）：按 token **名**索引的状态与用量覆盖层。
 *
 * ★ 与 `resources.json` 同一个地位——**可丢弃**。删了只会让下一次启动把所有
 * token 重探一遍，密钥与绑定一个都不会丢（那些在 `tokens/` 与 `config.json` 里）。
 * ★ 这里面**一个密钥都没有**，所以它坏掉时唯一的代价是多发几次探测请求。
 * @param {string} home
 */
export function poolPath(home) {
  return join(rootDir(home), 'pool.json');
}

/**
 * 价格表（§2.13 用量与花费）：模型 id → USD / 百万 token。
 *
 * ★ 独立于 `config.json`，且**没有就没有**——缺了只是花费那列显示 `—`，
 * 不是错误，`cxt usage` 照常跑。
 * @param {string} home
 */
export function pricesPath(home) {
  return join(rootDir(home), 'prices.json');
}

/**
 * 用量缓存（§2.13）：每份 rollout 的 `size + mtimeMs → 已解析的记录`。
 *
 * ★ 可丢弃的重建缓存（§3.4）——删了只会让下一次 `cxt usage` 慢一点。
 * @param {string} home
 */
export function usageCachePath(home) {
  return join(rootDir(home), 'usage-cache.json');
}

/**
 * **池**用量缓存（§2.13 九 9.1）：每份会话记录 `size + mtimeMs → 它的 calls/models`。
 *
 * ★★ 与 `usageCachePath()` **必须是两个文件**，别合并：那边存的是 `cxt usage`
 * 报表用的 `entries`（每条消息一行），这边存的是池记账用的**按模型汇总**。两个形状
 * 互不兼容，共用一个文件就等于谁后写谁把对方清空——而且**两边都不会报错**，
 * 只会表现为"下一次跑得慢了一点"或"用量忽然归零"。
 *
 * ★ 与它同一档：可丢弃的重建缓存（§3.4）。删了只会让下一次重算慢一点。
 * @param {string} home
 */
export function poolUsageCachePath(home) {
  return join(rootDir(home), 'pool-usage-cache.json');
}

/**
 * 版本迁移前的备份路径（§3.5）。
 * @param {string} home
 * @param {number} version 旧版本号
 */
export function configBackupPath(home, version) {
  return join(rootDir(home), `config.json.v${version}.bak`);
}

/** @param {string} home */
export function tokensDir(home) {
  return join(rootDir(home), 'tokens');
}

/**
 * @param {string} home
 * @param {string} name
 */
export function tokenPath(home, name) {
  return join(tokensDir(home), `${name}.json`);
}

/** @param {string} home */
export function profilesDir(home) {
  return join(rootDir(home), 'profiles');
}

/**
 * 会话在场层与消息信箱（§2.16）。
 *
 * ⚠️ **与 `profiles/<t>/sessions/` 无关**——那是 Codex 的会话历史
 * （Codex 所有，§3.1）；这里是 cxt 自己的在场记录。**同名不同物**。
 *
 * 收 `home` 但不收 `platform` → **规则 1（宿主形状）**，理由同 `profileDir()`。
 * @param {string} home
 */
export function sessionsDir(home) {
  return join(rootDir(home), 'sessions');
}

/**
 * 一个会话的目录。`id` 由 `core/sessions.js` 的 `makeSessionId()` 生成，
 * **调用方必须先过 `isValidSessionId()`**（它是目录名，防路径穿越）。
 * @param {string} home
 * @param {string} id
 */
export function sessionDir(home, id) {
  return join(sessionsDir(home), id);
}

/** @param {string} home @param {string} id */
export function sessionMetaPath(home, id) {
  return join(sessionDir(home, id), 'meta.json');
}

/** @param {string} home @param {string} id */
export function sessionInboxDir(home, id) {
  return join(sessionDir(home, id), 'inbox');
}

/** @param {string} home @param {string} id */
export function sessionReadDir(home, id) {
  return join(sessionDir(home, id), 'read');
}

/** @param {string} home */
export function catalogsDir(home) {
  return join(rootDir(home), 'catalogs');
}

/**
 * 模型目录文件（§7.5 的 `model_catalog_json` 指向它）。
 * @param {string} home
 * @param {string} name
 */
export function catalogPath(home, name) {
  return join(catalogsDir(home), `${name}.json`);
}

/**
 * profile 目录的**段序列**——规则 1 与规则 2 共用，免得两处各写一遍再漂移。
 * @param {string} token
 */
function profileSegments(token) {
  return [APP_DIR_NAME, 'profiles', token];
}

/**
 * profile 目录 = `CODEX_HOME` 的落点（§2.8）。
 * **只按 token 命名，永远不带 cwd**——profile 与工作目录是 1:N。
 *
 * 收 `home` 但不收 `platform` → **规则 1（宿主形状）**。
 * 这是对的：它算出来的串要直接喂给本机的 fs / 环境变量，
 * 拿"别的平台"的规则去算只会得到一个本机打不开的路径。
 * @param {string} home
 * @param {string} token
 */
export function profileDir(home, token) {
  return join(home, ...profileSegments(token));
}

/**
 * ★ **双作者文件**（§2.9）——cxt 写受管区，Codex 写 `[projects.*]` 信任记录。
 *
 * 这是整个项目里唯一一个"别人的文件我们也要写"的地方，
 * 所以对它的读写必须走 `core/toml-splice.js`，**绝不整文件重写**。
 * @param {string} home
 * @param {string} token
 */
export function profileConfigPath(home, token) {
  return join(profileDir(home, token), 'config.toml');
}

/**
 * 首次写入受管区前的**一次性备份**（§2.9 铁律 4）。
 * 已存在则不覆盖——用户第一次那份原始配置才是最该留住的。
 * @param {string} home
 * @param {string} token
 */
export function profileBackupPath(home, token) {
  return join(profileDir(home, token), 'config.toml.cxt.bak');
}

/**
 * "纯 defaults 模式"用的 profile 名（§2.3：`token` 解析到「无」时）。
 *
 * 下划线开头——`validateTokenName()` 只认 `[a-z0-9]` 开头，
 * 所以这个名字**不可能**与真实 token 撞车（有测试守着这条）。
 */
export const DEFAULT_PROFILE_NAME = '_default';

/**
 * token 名 → profile 名。`null`（无 token）落到 `_default`。
 * @param {string | null | undefined} tokenName
 */
export function profileNameFor(tokenName) {
  return tokenName ?? DEFAULT_PROFILE_NAME;
}

/**
 * launch 脚本路径（§2.12 兜底产物）。
 *
 * 收 `platform` → **规则 2（目标平台形状）**，整条路径都按目标平台拼，
 * 不只是扩展名。理由同 `codexFallbackPaths()`：这样三平台的脚本路径
 * 都能在任意一台机器上断言（§6.3），而"只换扩展名、其余借宿主 join"
 * 会在跨平台调用时算出 `\home\t\...` 这种四不像。
 *
 * 实际运行时 `home` 与 `platform` 都来自本机，两种算法结果一致——
 * 差异只在测试里出现，而测试正是我们要它正确的地方。
 *
 * @param {string} home
 * @param {string} token
 * @param {NodeJS.Platform} platform
 */
export function launchScriptPath(home, token, platform) {
  const j = joinFor(platform);
  return j(home, ...profileSegments(token), platform === 'win32' ? 'launch.cmd' : 'launch.sh');
}

/**
 * **项目级**配置：`<项目>/.codex/config.toml`——**Codex 的约定，不是 cxt 的数据**。
 *
 * ⚠️ 这个路径**不在 cxt 的所有权表里**（§3.1）：它是用户仓库里的文件，
 * cxt **只读不写**。`cxt doctor` 读它只为了两件事——提示禁区键（§7.3），
 * 以及确认"这个目录有没有自己的配置"。写它从来不是 cxt 的活。
 *
 * 收 `platform` → 规则 2（目标平台形状），与 `launchScriptPath()` 同理：
 * 这样三平台的形状都能在任意一台机器上断言（§6.3）。
 * 运行时 `platform` 就是宿主，两种算法结果一致。
 *
 * @param {string} cwd
 * @param {NodeJS.Platform} platform
 */
export function projectLocalConfigPath(cwd, platform) {
  return joinFor(platform)(cwd, '.codex', 'config.toml');
}

/**
 * 项目文档的候选文件名（§7.11 的 `project_doc_fallback_filenames` 默认值）。
 *
 * ★ 只有 `AGENTS.md`——契约 §5 的截断检查点名的就是它。
 * 把 CLAUDE.md / CONTRIBUTING.md 也算进来的话，报出来的"将被截断"会指向
 * 一份 Codex 未必真读的文件，那是个**看起来更周全、实际更容易误导**的结论。
 */
export const PROJECT_DOC_FILENAMES = Object.freeze(['AGENTS.md']);

/**
 * 项目本地配置的文件名（§2.13）。
 *
 * ⚠️ **没有扩展名以外的平台差异**——三个平台都叫这个。
 * 与 `launchScriptPath()` 不同（那里 `.cmd` / `.sh` 是整条路径的差异），
 * 这里只有一个常量，所以**不接收 `platform`**。
 */
export const PROJECT_CONFIG_FILENAME = '.cxt.json';

/**
 * codex 可执行文件的常见安装位置（§2.12 定位顺序第 3 档）。
 *
 * 按**目标平台**算——所以 Windows 分支在 Linux 上测也能得到 `C:\...` 形状的答案（§6.3）。
 *
 * ⚠️ **Windows 命中 `.cmd`**（本机实测：`npm i -g @openai/codex` 落在
 * `%APPDATA%\npm\codex.cmd`，同目录还有 `codex.ps1` 与给 Git Bash 用的 `codex`）。
 * `.cmd` **不能直接 spawn**——Node 18.20+/20.12+ 出于 CVE-2024-27980 会拒绝，
 * 必须经 `cmd.exe /c` 调用。这件事由 `cli/codex-bin.js` 负责，
 * 这里只回答"文件在哪"。
 *
 * @param {string} home
 * @param {NodeJS.Platform} platform
 * @returns {string[]}
 */
export function codexFallbackPaths(home, platform) {
  const j = joinFor(platform);
  if (platform === 'win32') {
    return [
      j(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
      j(home, 'AppData', 'Roaming', 'npm', 'codex.exe'),
      j(home, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe'),
    ];
  }
  return [
    j(home, '.local', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
  ];
}

/**
 * 展开开头的 `~`（配置里允许写 `~/work` 这种路径）。
 * 只认**开头**的 `~` / `~/` / `~\`——中间的 `~` 是普通字符。
 *
 * 收 `platform` → 属于规则 2，按**目标平台**拼。
 * （cmt 踩过一次：用宿主 `join` 拼，Linux 路径在 Windows 上会变成 `\home\t\proj`，
 *  测试立刻抓出来了——这正是规则 2 存在的理由。）
 *
 * @param {string} p
 * @param {string} home
 * @param {NodeJS.Platform} platform
 */
export function expandTilde(p, home, platform) {
  const j = joinFor(platform);
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return j(home, p.slice(2));
  return p;
}
