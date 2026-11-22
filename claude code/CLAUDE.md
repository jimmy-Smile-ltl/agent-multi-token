# CLAUDE.md — claude-multi-token

本文件是本仓库的**架构契约**。给 Claude 的指令优先级：本文件 > 代码里的既有惯例 > 你的默认习惯。
改动架构前先改本文件，不要先改代码。

---

## 一、项目目标

### 1.1 要解决的问题

**一台电脑只有一套环境变量。** 想同时开多个 Claude Code 窗口、每个窗口接不同的中转站 / 账号 / 模型，
只能靠手工 `export` 一整套变量，且**全局唯一**——A 项目的 key 和 B 项目的 key 互相打架。

```bash
# 用户现在的手工做法（每次切项目都要重来一遍）
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<你的 API Key>
export ANTHROPIC_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

### 1.2 一句话承诺

> **把"全局唯一的环境变量组"变成"按路径解析的配置"：
> `cmt run` 在哪个目录跑，就自动套用哪个目录该用的 token / apiUrl / model。**

### 1.3 三条产品不变量

1. **一会话一 token**：会话与 token **默认**显式绑定。未绑定时，可由 token 池**在启动前**挑一个
   （§2.13）——挑定之后整个会话只用它。不做会话内轮询、不做负载均衡、不做会话内切换。
   （默认一个 WT 窗口里多个标签页，每个标签页一个会话；`--window` 则一会话一窗口。两种都只做绑定。）
2. **隔离彻底**：不同 token 的窗口之间，配置、登录态、会话历史互不可见。
3. **配置分层可解析**：全局默认兜底 → token 自有 → 路径绑定覆盖 → **项目本地覆盖**（§2.11）；
   任何一项都能被上层改掉，且**每项都能说出自己来自哪一层**（见 §2.3、`cmt resolve`）。

### 1.4 非目标（明确不做，别自作主张加）

- ❌ 不做 token 轮询 / 负载均衡 / **会话内**自动切换（但见 §2.5 的 `--fallback-model`
  与**启动前校验**——两者都不是会话内故障转移）
  > **启动前**从 token 池挑一个 token 同理（§2.13）：挑完就钉死，会话内不再看池。
- ❌ 不做代理服务本身（不管中转站的实现）
- ❌ 不加密存储 token（明文 JSON，README 明确警告）
- ❌ 不修改 Claude Code 本体、不 hook 其内部实现
- ❌ 不做**会话内**额度轮询，也不做计费 API 之外的额度反推。启动前的额度探测见 §2.13，
  用量统计见 §2.13 九（`cmt usage`）——两者都是**命令跑一次**，不是后台常驻。
- ❌ **不做 agent 间的自动投递 / 自动回复**：消息信箱是惰性数据、由人转达，
  工具不内置任何自动执行体（§2.14 三 / 六）。
- ❌ 不把 Redis 当主存储。池的真相永远在本地 `pool.json`；Redis 只在显式带 `--redis` 时读写（§2.13 五）
- ❌ 不引入任何 npm 运行时依赖（见 §4.3 零依赖铁律）
- ❌ **不做外部 GUI**——桌面端、VS Code 扩展，一律不做。
  ★ 这条禁的是**外部** GUI。`cmt` 自己**有两个**界面，都算它的：
  **① 全屏 TUI** `cmt ui`（§2.12）——跑在你已经开着的终端里，**不新起进程类型**；
  **② 本地网页控制台**（§2.12 十一）——`node:http` **只绑 `127.0.0.1`**，
  浏览器只是它的渲染器，服务器进程还是 `cmt` 自己。
  两者都不碰 `~/.claude/`，也都不是"去适配别人的客户端"——
  **别拿这条当理由把它们砍掉。**（不写清楚的话，这两条读起来自相矛盾。）

---

## 二、整体设计

### 2.1 会话规格：四要素（必须齐全）

启动一个 Claude 会话，需要**完整**的四项。缺任何一项都不许启动，报错要**指名缺哪一项**：

| 要素 | 字段 | 缺失后果 |
|------|------|----------|
| **本地路径** | `cwd` | 不知道在哪跑 |
| **token** | `authToken` (+ `authMode`) | 无法认证 |
| **apiUrl** | `baseUrl` | 打不到端点 |
| **model** | `models[0]`（优先级最高项） | 不知道用哪个模型 |

`cmt resolve` / `cmt run` 启动前都跑这套完整性校验，输出四要素**及其来源层**。

### 2.2 承重原语（只有两个，别再造第三个）

| 原语 | 作用 | 说明 |
|------|------|------|
| `CLAUDE_CONFIG_DIR` 环境变量 | **身份隔离** | 官方文档明确推荐的"同时登录多个账号"方案。覆盖配置目录（默认 `~/.claude`），应用状态文件也落到该目录下。凭证位置分平台：Windows/Linux 为目录内 `.credentials.json`，macOS 为钥匙串条目且**按该目录哈希分槽**——故多 profile 不会互相覆盖登录态。 |
| `ANTHROPIC_*` / `CLAUDE_CODE_*` 环境变量 | **认证 + 模型 + 行为注入** | 见 §2.6 注入清单。 |

> 实测版本：Claude Code **2.1.251** / Node **v24.16.0**（2026-10 于 Windows 11）。

### 2.3 配置解析级联（核心，实现时以此表为准）

优先级 **高 → 低**。解析结果必须记录每一项的来源层，供 `cmt resolve` 展示。

| 要素 | 解析顺序（左 = 优先级最高） |
|------|---------------------------|
| `cwd` | `--cwd` → 命中 token 的 `cwd` → 当前目录 ⚠️ **项目本地没有这一层**（§2.11 三） |
| `token` | `--token`（含位置参数） → **项目本地** → 路径绑定命中的 token → `defaults.token` → **无**（纯 defaults 模式） |
| `baseUrl` | `--url` → 路径绑定 → token → 全局默认 ⚠️ **项目本地没有这一层**（§2.11 二） |
| `authToken` | `--token-value` → 路径绑定 → token → 全局默认 ⚠️ **项目本地没有这一层** |
| `authMode` | `--auth-mode` → 路径绑定 → token → 全局默认 → **内置 `"token"`** |
| `models` | **项目本地** → 路径绑定 `models` → token `models` → 全局 `models`（**整体覆盖，不合并**） |
| `slots` | 路径绑定 `slots` → token `slots` → 全局 `slots`（**整体覆盖**） ⚠️ **项目本地没有这一层**（§2.12 边界） |
| `env` | 全局 `env` ← token `env` ← 路径绑定 `env` ← **项目本地**（**按键合并**，右侧覆盖同名键） |
| `claudeArgs` | 全局 `claudeArgs` + token `claudeArgs` + **项目本地**（**拼接**，低 → 高，命令行 `--` 追加在最后） |
| `terminalMode` | `--window`/`--tab` → `defaults.terminalMode` → 内置 `"tab"`（= 在 `cmt` 专属窗口里开标签页，§2.9） |

**「项目本地」是 §2.11 引入的第四层**，文件是项目目录里的 `.cmt.json`。它插在
**命令行之下、路径绑定之上**——理由：它比绑定更具体（绑定按路径前缀匹配一批目录，
项目文件只对它所在的那一棵树生效），但比命令行弱（命令行是你这一下敲的）。
它**故意缺了三行**（`baseUrl` / `authToken` / `cwd`），那不是漏写，是 §2.11 二的安全设计。

三条容易踩的语义，实现时别想当然：

- **`--token` 是 token 的*名字*，`--token-value` 才是密钥本身。** 前者选身份（进而选 profile 目录），后者改凭证。
- **绑定匹配永远用「调用时的 cwd」**（`--cwd` 或进程当前目录），**绝不用 `token.cwd`**——
  后者是"这个 token 默认落在哪"，拿它去匹配绑定会成环。
- **`claudeArgs` 是拼接而非覆盖**：它是一串彼此独立的开关（像 `env`），不是"一组连贯的选择集"（像 `models`）。
  低层在前、高层在后，让更具体的层排在 argv 后面从而压过前面的同名参数。

**`models` 的缺省与显式空，是两件事**（与 §2.5 规则 3 配合）：

| 情况 | 含义 | 结果 |
|------|------|------|
| 三层**都没声明** `models` | 不知道用哪个模型 | **缺项**，`cmt run` 报错（§2.1） |
| 某层显式写了 `models: []` | "不注入，用 Claude Code 自身默认" | 合法，四要素齐全；**同时把继承环境里的 `ANTHROPIC_MODEL` 删掉**（§2.6 的 `unset`）——否则"默认"其实是父会话的模型 |
| `--model <id>` | 显式指定 | 把它**提到列表首位**（其余保持相对顺序，留作 `--print` 的 fallback） |

> ⚠️ 上表前两行的 `value` **都是空数组**，只能靠 `declared` 区分。所以这个判断
> **只准有一处实现**：`cli/format.js` 的 `modelsState()`（→ `missing` / `empty` / `list`），
> 渲染一律走 `modelText()`。曾经 `doctor` / `run --print` 各自写了
> `value.map(...).join() || '（显式空）'` 兜底，于是「没声明」被印成「（显式空）」——
> 偏偏同一屏下一行就写着「✗ 缺 model」，一个说合法一个说缺项（本机实测踩到）。
> 别在别处再写一遍 `value.length` 判断。

**纯 defaults 模式**（`token` 解析到「无」）：没有 token 身份，只有全局凭证。
此时 profile 目录用 `profiles/_default/`（§2.8），标签页标题 `cmt:_default · <cwd 末段>`（§2.9）。
`_default` 下划线开头，而 token 名只允许 `[a-z0-9]` 开头，**不可能撞车**。

**路径绑定匹配规则**：

- `bindings` 是数组，每项形如 `{ path, token?, baseUrl?, models?, slots?, env? }`
- 按 **最长前缀匹配**（`D:/work/a/sub` 命中 `D:/work/a` 而不是 `D:/work`）
- **Windows 比较大小写不敏感**，分隔符先归一（`\` → `/`）再比
- 匹配不到绑定 → 直接走 token / 全局默认

### 2.4 数据模型

`~/.claude-multi-token/config.json`：
```jsonc
{
  "version": 1,
  "defaults": {                        // 全局默认：四要素的兜底
    "authToken": "${DEEPSEEK_API_KEY}",// 支持 ${ENV_VAR} 引用；也接受明文
    "authMode": "token",               // "token" → ANTHROPIC_AUTH_TOKEN | "key" → ANTHROPIC_API_KEY
    "baseUrl": "https://api.deepseek.com/anthropic",  // 与 authToken 同规则，也可写整串 ${ENV_VAR}
    "models": [                        // ★ 有序，越靠前优先级越高
      { "id": "deepseek-flash[1m]", "label": "Flash 1M" },
      { "id": "deepseek-flash",     "label": "Flash" }
    ],
    "slots": {                         // 别名槽 → 模型 id（见 §2.5）
      "haiku": "deepseek-flash",
      "subagent": "deepseek-flash"
    },
    "env": {                           // 任意环境变量逃生舱
      "CLAUDE_CODE_EFFORT_LEVEL": "max",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "786432"
    },
    "terminalMode": "tab",             // "tab" = 在 cmt 专属窗口开新标签页（默认）；"window" = 每次开新窗口
    "claudeArgs": [],                  // 每次启动都附加的 claude 参数
    "token": "relay-a",                // 可选：没绑定的目录默认走哪个 token（§2.3）
    "seed": "off",                     // ★ 启动前播种（§3.6）：off | onboarding | full
    "preflight": true                  // ★ 启动前校验（§2.5）：false 关掉那次 /models 探测
  },
  "bindings": [                        // 路径 → 覆盖项（最长前缀匹配）
    { "path": "D:/work/client-a", "token": "relay-a" },
    { "path": "D:/work/client-b", "token": "relay-b", "baseUrl": "https://other.example.com" }
  ]
}
```

`~/.claude-multi-token/tokens/<name>.json`：
```jsonc
{
  "name": "relay-a",
  "label": "阿里中转",                  // 可选，昵称：可中文、只用于展示（§2.4 末）
  "authToken": "${RELAY_A_TOKEN}",
  "authMode": "token",
  "baseUrl": "${RELAY_A_BASE_URL}",    // ★ 也接受明文；内部端点这样写就不必落盘（§2.4）
  "cwd": "D:/work/client-a",           // ★ token → 文件夹：cmt run relay-a 的默认落点
  "models": [ /* 可选，有序，存在即整体覆盖全局 */ ],
  "slots":  { /* 可选，整体覆盖全局 */ },
  "env":    { /* 可选，按键合并 */ },
  "claudeArgs": []
}
```

**`config.json` 的 defaults 与你那组 export 完全等价**（照抄对照表）：

| 你的 export | 落在配置哪里 |
|-------------|-------------|
| `ANTHROPIC_BASE_URL` | `defaults.baseUrl` |
| `ANTHROPIC_AUTH_TOKEN` | `defaults.authToken` + `defaults.authMode: "token"` |
| `ANTHROPIC_MODEL` | `defaults.models[0].id`（**不单独配**，由优先级列表首项决定） |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `defaults.slots.opus` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `defaults.slots.sonnet` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `defaults.slots.haiku` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `defaults.slots.subagent` |
| `CLAUDE_CODE_EFFORT_LEVEL` | `defaults.env.CLAUDE_CODE_EFFORT_LEVEL` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `defaults.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` |

**各层各自能写哪些字段**（`schema.js` 的 `rejectUnknownKeys` 按这张表拒绝未知键——
手写配置打错字能立刻发现，而不是被静默忽略）：

| 字段 | `defaults` | `tokens/<n>.json` | `bindings[]` | `.cmt.json` |
|------|:---:|:---:|:---:|:---:|
| `authToken` / `authMode` / `baseUrl` | ✅ | ✅ | ✅ | ❌ **禁**（§2.11 二） |
| `models` / `env` | ✅ | ✅ | ✅ | ✅ |
| `slots` | ✅ | ✅ | ✅ | ❌ **禁**（§2.12 边界） |
| `token`（默认走哪个 token） | ✅ | — | ✅ | ✅ |
| `cwd` | — | ✅ | — | ❌ **禁**（循环定义） |
| `claudeArgs` | ✅ | ✅ | — | ✅ |
| `label`（token 昵称，§2.4 末） | — | ✅ | — | — |
| `terminalMode` / `claudeBin` / `seed` / `preflight` | ✅ | — | — | ❌ **禁**（机器级偏好） |

四层刻意的不对称，别"补全"它们：

- **`defaults` 没有 `cwd`**：cwd 的级联是 `--cwd` → `token.cwd` → 当前目录（§2.3）。
  凭空多一层"全局默认落点"只会让"我在哪跑"变得难猜。
- **`bindings[]` 没有 `cwd`**：绑定回答的是"**这个目录**用哪个 token"，不是"去哪个目录"。
- **`bindings[]` 没有 `claudeArgs`**：绑定是"选身份"，不是"调行为"。
- **`.cmt.json` 没有 `authToken` / `baseUrl` / `cwd` / `slots` / 机器级偏好**：
  前三个是安全设计（§2.11 二），后两个是范围设计（§2.12 边界）。

**`${ENV_VAR}` 引用的求值规则**（写死，别含糊）：

- **哪些字段支持**：**`authToken` 与 `baseUrl`，两者一视同仁**。`models` / `slots` / `env`
  逃生舱**不支持**。引用在**任何一层**都算数（`defaults` / `tokens/<n>.json` / `bindings[]`
  / `--token-value` / `--url`）——因为识别发生在级联**之后**的最终值上。
- **求值时机**：`cmt exec` 注入环境之前，从**新窗口的进程环境**读取。
- **只认整串引用**：`"${DEEPSEEK_API_KEY}"` ✅；`"sk-${VAR}"`、`"${A}${B}"` ❌ → **报错**。
  绝不把 `${...}` 当字面量留在 token 里。
- **未设置时**：报错，退出码 1，消息里指名变量（`引用的环境变量 DEEPSEEK_API_KEY 未设置`）。
  **绝不静默回退成字面量 `"${DEEPSEEK_API_KEY}"`**——那会变成一个恒被拒绝的假 token，最难排查。
  `baseUrl` 同理，且后果更隐蔽：**绝不把字面量 `${X}` 塞进 `ANTHROPIC_BASE_URL`**——轻则
  Claude Code 拿着一个不存在的域名去连接，重则悄悄退回一方端点、却带着中转站的 token。
- **两条失败路径都要拦在启动之前**（§2.7 的"两道闸门"）：
  - 「引用的变量未设置」→ 由 `validateSession()` 报成四要素缺项（它看得见 `ref.set === false`）。
  - 「值非空但不是合法整串引用」（`"https://${H}/v1"`）→ **`validateSession()` 看不见**，
    只有注入时才暴露。这条由 `unresolvedBlocker()` 拦，`cmt exec` 与 `cmt run` 都调用它。
  - 两者都**报错退出**，不是警告——`cmt exec` 的 stderr 会被 claude 的 TUI 盖掉，
    "提示过了"等于没提示。
- **展示时**：`cmt resolve` / `cmt run --print` / `cmt doctor` 只标注「已设置 / 未设置」，**不打印值**。
- **`resolveConfig()` 只识别不求值**——它必须在环境变量没设置时也能跑出完整结果，
  否则 `cmt resolve` 就没法告诉你"哪一项没设置"。真正求值的是启动路径（`cmt exec`）。
- **写入时不校验**：`cmt token add/edit`、`cmt bind` 原样落盘，形态错误等到求值时才报。
  `authToken` 与 `baseUrl` 在这一点上**必须一致**——别只给其中一个加写入期校验。

**`label`（token 昵称）的校验**（`normalizeTokenLabel()`，`core/schema.js`）：

- 只接受字符串；`trim()` 后为空 ⇒ **视为未设置**（调用方**删键**，绝不写 `""`）。
- ≤32 个**码点**（`Array.from(s).length`，不是 `.length`——否则一个 emoji 会被算成两下）。
- **单行**：拒绝 C0 控制字符与 DEL（换行、制表符都在里面）。
- 错误消息**只谈 label、不打印原值**（与密钥那条纪律同源）。
- 允许中文、空格与任意可见字符；**不唯一**——两个 token 可以取同一个昵称，身份仍然是 `name`。
- 它**不进 `COMMON_KEYS`**：写进 `defaults` / `bindings[]` / `.cmt.json` 会被 `rejectUnknownKeys`
  直接拒绝。它是**昵称**，**不参与身份**——不进路径、不进 profile 名、不进窗口标题、不进环境变量。

### 2.5 模型 list = 有序优先级 + 槽位映射

**`models` 是有序优先级表，`models[0]` 优先级最高**，它就是本次会话的默认模型。

选择规则：
1. `--model <id>` 显式指定 → 用它
2. 否则 → `models[0]`（**不交互提问**；要挑用 `--pick`）
3. `models` 为 `[]` → 不注入模型，用 Claude Code 自身默认
4. `models` 字段不存在 → 继承上层

**槽位映射 `slots`** 把模型填进 Claude Code 的别名槽（中转站必备——否则会话内 `/model` 切到
`opus` 会去请求一个中转站根本没有的模型）：

| slot 键 | 注入的环境变量 |
|---------|---------------|
| `opus` / `sonnet` / `haiku` / `fable` | `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` |
| `subagent` | `CLAUDE_CODE_SUBAGENT_MODEL` |

**默认规则：未在 `slots` 中列出的槽，自动填 `models[0]`。**
显式置 `null` 表示"该槽不注入"（保留 Claude Code 自身默认），**同时把继承环境里对应的那个
变量删掉**（§2.6 的 `unset`——留着它，"不注入"就等于"用父会话的"）。这条默认让"只有 deepseek 的中转站"
不会因为别名槽空着而请求不存在的 claude 模型。

> ⚠️ **"优先级"不等于自动故障转移。** Claude Code 的 `--fallback-model`（逗号分隔、按序尝试）
> **仅 `--print` 模式有效**（官方 help 原文 "(only works with --print)"）。
> 交互模式下 `models[0]` 只是默认选中项，**不会**在不可用时自动跳到 `models[1]`。
> `--print` 模式下 cmt 自动把 `models[1..]` 拼给 `--fallback-model`；交互模式**不要**假装能做到。
> 唯一的例外是**启动前那一次校验**（下一小节），它不是故障转移。

#### 启动前校验（不是故障转移）

`cmt exec` 在**真正启动之前**拉一次 `GET {baseUrl}/models`（**2 秒**超时），从 `models`
优先级里挑第一个**确实存在**的：

| 情况 | 行为 |
|------|------|
| `models[0]` 在清单里 | 原样启动，**不提示**（绝大多数时候） |
| `models[0]` 不在、`models[k]` 在 | 本次改用 `models[k]`，stderr 打一行 `⚠` 说明；**不写任何文件** |
| 一个都不在 | **仍按配置启动**（`models[0]`），打一行说明 |
| 拉取失败 / 超时 / 端点没有 `/models` | **静默**按配置启动（内网端点这是常态） |

四条边界，缺一条它就会变成别的东西：

1. **只读**：不写配置、不写 `resources.json`、不碰 profile。
2. **只做一次**，不做会话内重试——那就成自动故障转移了（§1.4 明令不做）。
3. **只在真实启动路径做**：只有 `cmt exec` 会联网。`cmt run --print` 是**诊断视图**，
   在 `planLaunch()` 之后就返回，根本走不到 `exec`，所以天然零网络。
   ⚠️ **`--` 之后的 `--print` 是 claude 自己的旗标**，那是一次真启动——校验照做，
   而且 `--fallback-model` 恰好是 `--print` 下唯一有意义的东西，最该跟着换。
4. **可关**：`defaults.preflight: false`（机器级偏好，默认 `true`）。

★ 实现上是**换掉解析结果再重算注入**（`buildInjection()`），于是 `ANTHROPIC_MODEL`、
`--fallback-model`、各 `slots` 的默认填充全部自动跟着走——**现有注入代码零改动**，
因为它们读的本来就是"级联之后的 `models`"。在校验之后再拼 `models[1..]` 给
`--fallback-model` 这件事因此也是自动正确的。
⚠️ `--model <id>` 的显式覆盖**不参与校验**：那是用户这一次点名要的，换掉它才是错的。
⚠️ 纯逻辑在 `core/models.js` 的 `chooseAvailable(models, availableIds)`：首位命中不动；
否则把第一个命中的**提到首位**（其余保持相对顺序，与 `model next` / `model use` 同一套语义）；
一个都不命中就原样返回——**绝不**挑一个不相干的模型。

#### 模型切换工作流（人工故障转移 —— 本项目的一等场景）

正因为交互模式没有自动回退，`models[1..]` 的用途是**人工提拔栈**：模型挂了就把它提上来，重启续聊。
这是明确要支持的用法，**整个流程必须两步各一条命令**：

```bash
# models[0] 不可用 → 提拔下一个优先级 → 同路径重启并续上刚才的会话
cmt model next      # 优先级列表轮转，下一个候选成为 models[0]
cmt run -c          # 在 cmt 窗口开新标签页，claude -c 继续该目录最近一次会话
```

- **`cmt model next`**：把列表**轮转**——`models[0]` 移到末位，原 `models[1]` 升为 `models[0]`。
  轮转而非删除，所以反复切换不会把候选耗光。
- **`cmt model use <id>`**：把指定模型**提到首位**，其余保持相对顺序（原首位退到第二，便于切回）。
- **`cmt run -c`**：给 claude 传 `-c/--continue`，继续**当前目录**最近一次会话。

**`cmt model next` / `use` 写入哪一层**（默认按当前目录，可用 flag 显式指定）：

| flag | 写入目标 |
|------|---------|
| `--global` | `config.defaults.models` |
| `--token <t>` | `tokens/<t>.json` 的 `models` |
| `--path <p>` / 无 flag | ★ **先看该路径的项目本地配置**（§2.11 五）：`.cmt.json` 若声明了 `models`，目标层**就是那个文件**；否则 `bindings` 中该路径的 `models`；**无匹配绑定则自动创建一条** |

若该路径原先继承 token / 全局的列表，`cmt model next` 会**物化**一份路径专属列表
（复制当前生效列表再轮转）。`cmt resolve` 会把来源层标为 `binding`（或项目本地那份的
`project`）——变化显式可见，不做隐式魔法。

> ★ 写到一个**不生效**的地方 = 命令静默失效，正是 §6.2「宁可明确」要避免的。
> 所以"写哪一层"必须跟着"哪一层生效"走——这两件事**只准有一处判断**。

> ⚠️ **`-c` 的作用域是「配置目录 + 当前目录」，与 token 值无关。**
> 会话历史存在 `<配置目录>/projects/<cwd-slug>/`（本机实测：目录名就是 cwd 的 slug，不含 token 派生信息）。所以：
> - ✅ **只改 `ANTHROPIC_AUTH_TOKEN`（配置目录不变）→ `-c` 依然回到原会话**
> - ❌ 改了 `CLAUDE_CONFIG_DIR`（换配置目录）→ 那是另一份历史，`-c` 找不到
>
> **在 cmt 里**，因为设计上"一 token 一 profile"（§2.8），**切到另一个 token 会连带换掉配置目录**，
> 于是 `-c` 失效。想换 key 又要续聊，正确做法是**改现有 token 的凭证**：
> `cmt token edit <name> --token <新值>`——profile 目录不动，历史与 `-c` 全部保留。
> **别用"切到另一个 token"来做换 key**，那是换身份，不是换钥匙。

### 2.6 注入清单（唯一来源：`core/resolve.js`）

| 注入项 | 来源 | 备注 |
|--------|------|------|
| **环境变量** `CLAUDE_CONFIG_DIR` | `profiles/<token>/` | 身份隔离（承重） |
| **环境变量** `ANTHROPIC_AUTH_TOKEN` | `authToken`（`authMode: "token"`，**默认**） | `Authorization: Bearer` |
| **环境变量** `ANTHROPIC_API_KEY` | `authToken`（`authMode: "key"`） | `X-Api-Key` |
| **环境变量** `ANTHROPIC_BASE_URL` | `baseUrl` | 端点 |
| **环境变量** `ANTHROPIC_MODEL` | `models[0]`（或 `--model`，或启动前校验挑中的那个） | 主模型 |
| **环境变量** `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` | `slots.*` | 别名槽 |
| **环境变量** `CLAUDE_CODE_SUBAGENT_MODEL` | `slots.subagent` | 子 agent 模型 |
| **环境变量** `env.*` | `env` | 逃生舱，任意键 |
| **环境变量** `CMT_SESSION_ID` | 会话 id（§2.14） | 由 `cmt exec` 在 `buildSessionEnv()` **之后**盖上——它是本工具的会话标记，不是解析产物；`msg send` 靠它识别发送者 |
| **参数** `--name "cmt:<token>"` | token 名 | 会话显示名，让 `/resume` 与终端标题能认出身份 |
| **参数** `--fallback-model` | `models[1..]`（启动前校验之后的） | **仅 `--print` 模式** |
| **参数** `claudeArgs` | 各层 `claudeArgs` | 追加到命令行 |

> **`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` 三项都可能来自
> `${ENV_VAR}` 引用**（§2.4）。求值在注入前一步完成：求不出来就**不注入**，并记进
> `unresolved`——**绝不把 `${...}` 字面量塞进去**。

**为什么 `authMode` 默认 `"token"`**：`ANTHROPIC_API_KEY` 在交互模式下会弹一次性的"使用自定义 API key？"
确认，而 `ANTHROPIC_AUTH_TOKEN` 不会。中转站场景默认走后者，少一次每 token 一次的打扰。

#### 继承环境的净化（`SESSION_MARKER_ENV` + `unset`）

**核心不变量：`cmt run` / `cmt exec` 的结果，不许取决于它是从哪儿被调用的。**

新会话的环境**不是**从零开始，而是**继承**来的（终端进程、父 shell、`cmt run` 的调用方）。
所以注入清单只描述"我们**加**什么"是不够的——还得说清"我们**删**什么"：

```
新会话环境 = 继承环境（剔掉会话标记） → 删掉 cmt 明确不注入的项（unset） → 盖上注入项
```

顺序要紧：**先删，再盖**。`injection.env` 永远最后生效，所以 `env` 逃生舱能盖回来任何一项。

**为什么必须净化**（2026-10 实测）：`cmt run` 从 Claude Code 会话里被调用时，
**Windows Terminal 会把调用方的整个环境原样转发给新标签页**（§7.7 有复现方式）。
于是新会话继承到的不只是一个标记，而是**一整套会话身份**——最刺眼的一条是
`CLAUDE_CODE_CHILD_SESSION=1`，Claude Code 见到它就打印
`⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`，
**该会话的对话记录不再落盘**；其余各条则让新会话顶着父会话的会话 id、甚至握着
指回父会话 IPC 管道的活凭证。

`SESSION_MARKER_ENV`（`core/resolve.js`，`stripSessionMarkers()` 照它剔）：

| 变量 | 为什么是"身份" |
|------|---------------|
| `CLAUDECODE` | "我在 Claude Code 里" |
| `CLAUDE_PID` | 父会话的进程号 |
| `CLAUDE_CODE_ENTRYPOINT` | 父会话怎么被拉起来的（`cli` / `sdk` / …） |
| `CLAUDE_CODE_SESSION_ID` | 父会话的会话 id |
| `CLAUDE_CODE_CHILD_SESSION` | "我是别人的子会话" → 关掉记录落盘 |
| `CLAUDE_CODE_MESSAGING_SOCKET` / `..._TOKEN` | 父会话的 IPC 管道 + 打开它的凭证 |
| `CLAUDE_CODE_EXECPATH` | 父会话的可执行文件路径 |
| `CLAUDE_CODE_SSE_PORT` | 父会话的端口（本机未观测到，同族，一并剔） |
| `CMT_SESSION_ID` | 父会话的 cmt 在场 id（§2.14）——嵌套 `cmt run` 会带着它，让新窗口的 `msg send` 把 `from` 认错会话 |

> **判据（将来加新标记照这条判）：值描述的是*某一个正在跑的进程 / 会话*——
> PID、会话 id、管道、端口、可执行文件路径、入口方式——就**剔**；
> 值是*配置*（模型、努力级别、开关）就**留**，那属于 cmt 该管的，该管的会覆盖它。**
>
> 按这条，`CLAUDE_CODE_EFFORT_LEVEL` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` /
> `CLAUDE_CODE_SUBAGENT_MODEL` / `CLAUDE_CODE_DISABLE_AUTOUPDATER` 都是**配置**，**不剔**。
> `SUBAGENT_MODEL` 更是 cmt 自己就会注入的槽（§2.5），剔掉反而错。

**`unset`：cmt 明确决定不注入、所以继承来的值也不许顶上来。** 四处来源：

| 来源 | 例子 | 为什么 |
|------|------|--------|
| 没选中的那个认证变量 | `authMode: "token"` → `unset: ['ANTHROPIC_API_KEY']` | ⚠️ **必需**：§7.2 的优先级是 `ANTHROPIC_AUTH_TOKEN` 压过 `ANTHROPIC_API_KEY`。`authMode: "key"` 时若继承来一个 `AUTH_TOKEN`，**它会赢**——配的是 key，跑的却是别人的 token |
| `models` 显式为空（§2.3） | `models: []` → `unset: ['ANTHROPIC_MODEL', ...槽]` | 语义是"不注入，用 Claude Code 自身默认"，那就得把继承来的也清掉，否则"默认"其实是父会话的模型 |
| 值为 `null` 的槽（§2.5） | `slots: { opus: null }` → `unset: ['ANTHROPIC_DEFAULT_OPUS_MODEL']` | 同上：显式 `null` = "该槽不注入" |
| `env` 逃生舱里**显式置空串** | `env: { FOO: "" }` → `unset: ['FOO']` | ★ 空串在 Windows 上等于"删掉这个变量"，在 POSIX 上却是个**真的空值**——同一个配置在两个平台跑出两种语义，不能留，一律按"删"处理。**这也是"把父会话漏进来的变量请出去"的唯一通道**：没有它，`env` 只能**加**变量、不能删（§7.7：`wt.exe` 会把调用方的整套环境原样转发进新标签页）。判据落在**合并之后**的值上：空串就是"删"，且**不写进 `env`** |

**`unset` 只覆盖 cmt 自己管理的变量。** `ANTHROPIC_CUSTOM_HEADERS` / `ANTHROPIC_PROFILE` /
`ANTHROPIC_CUSTOM_MODEL_OPTION` 这些 cmt 不碰的，继承就继承——那张表无边界，管不过来。

**`cmt run` 只剔标记，不盖注入项**（§2.7 步骤 3）。标签页的环境只是个**载体**：
往里面塞 `injection.env` 等于让 token 在窗口的 shell 里多出一份，还把求值点从
"新窗口里"挪到了"`cmt run` 这一侧"，与 §2.7「引用跨得过进程边界，密钥跨不过，
求值发生在新窗口里」直接冲突。真正的 claude 环境由窗口内的 `cmt exec` 用
`buildSessionEnv()` 算。

**两个入口点都是纯函数**（`core/resolve.js`）：

```js
stripSessionMarkers(env)                        // 剔标记，**返回新对象，绝不改入参**
buildSessionEnv({ base, injection })            // 剔标记 → 删 unset → 盖 env
```

> ⚠️ **"返回新对象"是硬要求，不是洁癖**：`cli/main.js` 的 `makeCtx()` 传进来的 `ctx.env`
> **就是 `process.env` 本身**（按引用）。就地 `delete` 会把 **cmt 自己的**进程环境改掉——
> 之后所有命令、所有 spawn 都在一个被悄悄动过的环境里跑。

### 2.7 数据流

```
cmt run relay-a [--url X] [--auth-mode token|key]
  │
  ├─ 0. 发现项目本地配置：从 cwd 往上找最近的 `.cmt.json`（§2.11 一）
  ├─ 1. 解析四要素（§2.3 级联，含第 0 步找到的那一层），记录每项来源层
  ├─ 2. 完整性校验 → 缺项则报错指名（§2.1）
  ├─ 2b. 注入闸门：injection.unresolved 非空 → 报错退出（§2.4）
  ├─ 3. 探测终端 → spawnTerminal({ title, cwd, argv }, stripSessionMarkers(ctx.env))（§2.9 二·1，无脚本）
  │     └─ 兜底路径才落盘 profiles/relay-a/launch.{cmd,sh}（§2.10）
  └─ 4. 无状态写入（不记忆选择，§2.5 规则 2 已确定默认模型）

新窗口内：cmt exec relay-a → buildSessionEnv() 算环境（§2.6）→ **定位 claude → 启动前播种（§3.6）** → 启动 claude
（cwd 已由终端设好）

> 播种排在**定位 claude 之后、组装 argv 之前**，两个边界都是刻意的：
> 启动注定要失败（找不到 claude）就别去动人家的文件；
> 而播种与启动之间不留缝，否则那段时间足够让 `.claude.json` 变样。
> **`cmt run` 不播种**——它只开窗口，真正的 cwd 由窗口里的 `cmt exec` 说了算。
```

**两道启动闸门，缺一不可**：`check.ok`（§2.1，四要素缺项）与 `unresolved`（§2.4，
求不出值的引用）。第二道不是冗余——**`validateSession()` 看不见"值非空但不是合法整串引用"**
（`"https://${H}/v1"` 在它眼里是齐的），只有注入时才暴露。少了 `ANTHROPIC_BASE_URL`
就悄悄退回一方端点却仍拿着中转站的 token，正是 §2.4 点名"最难排查"的那一类。
两道闸门都在 `cli/session.js` 里共用：`unresolvedBlocker()` 返回可直接 `throw` 的错误。

> **别把它降级成 stderr 警告**：`cmt exec` 用 `stdio: 'inherit'` 把终端交给 claude，
> 警告会在 TUI 铺屏的瞬间被盖掉。`cmt resolve` / `--print` 是诊断视图，**不调用**它。

**关键设计：launch 脚本不内联 token。** 它只调用 `cmt exec`（写绝对路径，不依赖 PATH），
由 `cmt exec` 在进程内注入环境后 `exec` 掉 claude。理由：token 只有一个落盘点
（`tokens/<name>.json`），不会在 profile 目录里多出第二份明文副本。
（已否决的替代方案：把 `ANTHROPIC_AUTH_TOKEN` 直接写进 launch 脚本——自包含但多一份泄漏面。）

**推论：`cmt run` 不支持 `--token-value`**，见到就报错退出。新窗口里的 `cmt exec`
只能从命令行拿到这个值，而那条命令行要么进 launch 脚本、要么留在终端 argv 里——
两条都是"第二个落盘点"。一次性凭证走 `cmt exec --token-value`（已在窗口里，直接注入
进程环境），要复用的走 `cmt token add`。**非密钥**的覆盖项（`--url` / `--auth-mode`）
则可以内联进脚本，`--url` 常常就是 `${RELAY_BASE_URL}` 这类引用串——
引用跨得过进程边界，密钥跨不过：求值发生在新窗口里。

**推论二：`cmt run --url` 拒绝带 userinfo 的值**（`https://user:pass@host/…`）。
「`--url` 是非密钥覆盖项」这句话**只对不带 userinfo 的值成立**——userinfo 就是凭证本身，
内联它等于把密钥写进 `profiles/<t>/launch.{cmd,sh}`，与上一条是同一类事，处理方式也相同
（拒绝，不是警告：文件会一直躺在磁盘上，而换个写法的成本几乎为零）。
判据是 `core/launch-script.js` 的 `urlCarriesCredential()`，两条边界都很关键：

- **整串 `${VAR}` 引用不算**——否则我们推荐的 `--url '${RELAY_BASE_URL}'` 反而会被拒。
- **只在 authority 段找 `@`**（`scheme://` 之后到第一个 `/`、`?`、`#` 为止），
  否则 `https://host/path@2x.png` 这种正常 URL 会被误判。

`cmt exec` 不受这条限制：它只把值注入进程环境，不落盘。

### 2.8 运行时数据目录布局

```
~/.claude-multi-token/                 # 根目录，所有路径常量集中在 core/paths.js
├── config.json                        # 全局默认 + 路径绑定表
├── tokens/
│   └── <token>.json                   # 每 token 一份，文件名 = token 名
├── profiles/
│   ├── <token>/                       # ← CLAUDE_CONFIG_DIR 指向这里，Claude Code 自行填充
│   │   ├── .claude.json               #   应用状态：OAuth 会话 / 项目信任 / 个人 MCP / UI 开关
│   │   ├── .credentials.json          #   凭证（Windows/Linux；macOS 走钥匙串，按目录哈希分槽）
│   │   ├── settings.json              #   用户设置：env / permissions / hooks
│   │   ├── projects/ sessions/ ...    #   会话历史、并发会话探测（Claude Code 所有）
│   │   └── launch.cmd | launch.sh     #   ★ cmt 生成的启动脚本（cmt 唯一写入此目录的文件）
│   └── _default/                      #   纯 defaults 模式（没有 token 身份时）的落点，§2.3
└── sessions/                          # ★ 在场层与消息信箱（§2.14）：<id>/meta.json + inbox/ + read/
                                       #   ⚠️ 与 profiles/<t>/sessions/（Claude Code 的会话历史）
                                       #   **无关**——同名不同物，别在文档/代码里混用
```

> **`_default` 是保留名。** `validateTokenName()` 只认 `[a-z0-9]` 开头，
> 所以这个名字**不可能**与真实 token 撞车——有测试守着这条不变量。

> **没有 `cache/` 目录**——本设计不记忆任何跨会话状态（§2.5 规则 2 让"上次选择"变得多余）。
> 不要为了"记住上次用的模型"再加回来。**"上次用的模型"仍然不记**；模型清单有一份
> **可见、可刷新**的登记（§2.12 六 / 十二），但它**从不代替现拉**。

**profile 与工作目录是 1:N。** 同一 token 在多个目录启动时**共用同一个 profile**，
Claude Code 在 `projects/` 下按 cwd-slug 分目录存历史。推论：

- `claude -c` 只续**当前目录**的历史（§7.5），同一 token 在别的目录的会话互不干扰。
- 换 token 才是换 profile / 换整份历史；换目录只是换 profile 里的一个子目录。
- 因此**不要**把 cwd 编进 profile 目录名——profile 按 token 命名，永远只按 token 命名。

**token 名约束**：`^[a-z0-9][a-z0-9_-]{0,31}$`。
它是目录名、文件名、窗口标题的一部分，必须校验；**必须拒绝路径穿越**（`..`、`/`、`\`、盘符）。

### 2.9 跨平台适配

#### 分层：先分清哪一层真的需要适配

| 层 | 内容 | 成本 |
|----|------|------|
| **一、已抽象掉** | 环境变量注入、密钥落盘、进程启动 | **零**（见下方设计红利） |
| **二、必须逐平台实现** | 终端探测与拉起、可执行文件定位、文件权限 | 适配层的主要工作 |
| **三、暗礁（静默出错）** | 路径比较、编码、换行、WSL 边界 | 最容易漏，必须单测覆盖 |

**设计红利（不要破坏它）**：环境变量**不在 shell 脚本里注入**，而由 `cmt exec` 用
`spawn(cmd, args, { env })` 注入。这一步绕开了 cmd / PowerShell / sh 三套完全不同的引号与转义规则——
**这是 §2.7「launch 脚本不内联 token」带来的最大跨平台收益**。别为了"自包含"退回去。

#### 二·1 终端拉起：统一抽象

适配层只暴露一个接口，`argv` **始终是数组**，一路不被 shell 解析：

```js
platform.spawnTerminal({ title, cwd, argv }, env)   // argv: string[]；env: Record<string,string>
```

**`env` 是必填的第二个参数**——新终端会**继承**调用方的环境（§2.6），所以必须由调用方
明确给出"用哪份环境去拉"。平台层**不认识** Claude 的会话标记，它只负责把这份环境交给
`spawn`；剔除是 `core/resolve.js` 的事（`run.js` 传 `stripSessionMarkers(ctx.env)`）。
Windows Terminal 会把这份环境**原样转发**给新标签页（§7.7 实测），所以这里是净化的**唯一**
关口——漏了它，标签页就会带着调用方的会话身份跑起来。

| 平台 | 首选 | 探测依据 | cwd 传递 | 兜底 |
|------|------|---------|---------|------|
| Windows | `wt.exe` | `findExecutable('wt')` | `-d <cwd>` | `cmd /c start "" <脚本>` |
| macOS | iTerm2 / Terminal.app | `$TERM_PROGRAM` | `do script "cd ..."`（字符串） | `open -a Terminal <脚本>` |
| Linux | `$TERMINAL` → `x-terminal-emulator` → gnome-terminal / konsole / xterm | 逐个 `findExecutable` | `--working-directory` / `--workdir` / `-c` | `tmux new-window -c <cwd>` |

**Windows 的 argv 形状**（`-w` 决定窗口落在哪；语义依据见 §7.7，**别凭印象改**）：

```bash
wt.exe -w <cmt|-1> new-tab --title <标题> --suppressApplicationTitle -d <cwd> <argv...>
```

| `-w` 取值 | 语义 | 何时用 |
|-----------|------|--------|
| `cmt`（窗口名，**硬编码**） | 有名为 `cmt` 的窗口 → 往里加标签页；没有 → **用这个名字建一个** | `terminalMode: "tab"`（默认） |
| `-1` | 总是新窗口（可读写法是 `new`；保留 `-1` 只为不动已验过的行为） | `terminalMode: "window"` |

- **不要用 `-w 0` / `-w last`**：那是"**最近使用过的**窗口"。用户开了多个 WT 窗口时，标签页会落进
  "上次碰过的那个"而不是"正在看的那个"——**行为不可预期**，观感就是"窗口到处乱开"。`-w cmt`
  把它钉死成一个专属窗口；该窗口被关掉后，下次 `cmt run` 会自动重建（自愈）。
- 窗口名**硬编码 `'cmt'`，不做配置键**：本工具的价值就在名字稳定可预期，可配置反而削弱它。
- `TerminalSpec.windowName` **只在 tab 模式填**（`'cmt'`），window 模式**不填**。回执据此说
  "已在 cmt 窗口的新标签页启动"。**cli 层不许硬写窗口名**——macOS / Linux 的"开标签页"就是
  往当前窗口加，没有名字可言，硬写在那儿就是假话。
- `--suppressApplicationTitle` **两种模式都要给**，理由见下面的标题契约。
- `cmd /c start` 兜底**没有标签页概念**，只能开新窗口 → `terminalMode: "tab"` 走到这条兜底路时
  **必须报警**（进 `warnings`），不能默默退化成开新窗口。

**只有必须走字符串的适配器**（macOS `osascript`、Windows `cmd /c start`、无 cwd 选项的 `xterm`）
才做转义，**且这些适配器必须各自带转义单测**。

**不要直接 `spawn` 一个 `.cmd` / `.bat` 文件**——Node 18.20+ / 20.12+ 出于安全（CVE-2024-27980）
会直接拒绝。一律经 `cmd.exe /c <脚本>` 调用（`cmd.exe` 是 `.exe`，不受限）。

`--window` / `--tab` 覆盖 `defaults.terminalMode`（`--tab` = 进 `cmt` 专属窗口开标签页，`--window` = 每次开新窗口）。探测失败时报出**试过哪些终端**，别只说"失败"。

**标签页 / 窗口标题**：`cmt:<token> · <cwd 末段>`，**总是**带 cwd 末段。
本工具的卖点就是"一眼分辨哪个窗口是哪个 token"，**标题必须能区分**——这是功能不是装饰。

> 曾经的写法是"同一 token 已开多窗时才追加 cwd 末段"。**做不到**：`cmt run` 是无状态的
> （§2.7 步骤 4，不记忆任何跨会话状态），它**无从知道**当前是否已有同 token 的窗口。
> 与其做一个永远猜不准的条件追加，不如每次都带上——标题恒定可分辨，且不必引入状态。
> 纯 defaults 模式（无 token）时 `<token>` 段是 `_default`（§2.8 的保留名）。

**标题得靠 `--suppressApplicationTitle` 才守得住**（本机实测，§7.7）：Claude Code 一跑起来就用
OSC 2 改写终端标题，把 `cmt:relay-test · claude_test` 覆盖成 `✳ cmt:relay-test`——**cwd 末段没了**，
于是同 token 多目录的标签页长得一模一样，上面那条"必须能区分"当场失效。所以 Windows 的 `wt` argv 里
`--title` 之后**必须**紧跟 `--suppressApplicationTitle`，且它必须出现在 `new-tab` 子命令**之后**
（`--title` 只负责"把标题写上"，这一项才负责"别被覆盖"）。**两种模式都加**——`--window` 模式同样被覆盖。
代价：标签页不再显示 Claude 的动态标题（`✳` 转圈那类活动提示）。这是**有意取舍**——
本工具要的是"一眼认出是哪个 token / 哪个项目"，那比活动动画重要。

#### 三 路径归一化（绑定匹配的成败在此）

`normalizeForCompare(p, platform)`——**纯函数，platform 由调用方注入**：

1. `String(p).normalize('NFC')` —— **macOS 暗礁**：macOS 文件名可能以 NFD 存储，
   文件系统查找本身不敏感，但**我们自己的 `startsWith` 前缀匹配是字节级敏感的**——
   用户输入的 NFC 与配置里存的 NFD 会匹配失败。统一归一化即可消除。
   （Claude Code 自己对配置目录也做 `.normalize("NFC")`，二进制中可见——这是同类问题的已知解，照做。）
2. 分隔符统一为 `/`
3. Windows / macOS：`toLowerCase()`（APFS 默认大小写不敏感）；**Linux 保持大小写**
4. 消解 `.` / `..` 段；去掉尾部 `/`（保留根 `/`，Windows 保留 `C:/`）

**不做 `realpath`（不解析 symlink）**：会引入 IO 开销与"绑定突然失效"的困惑。
v1 按字符串前缀匹配，`cmt resolve` 打印**归一化后**的路径供对照。

**WSL 边界**：`/mnt/c/...`（WSL 内）与 `C:\...`（宿主）是两套字符串，绑定**不互通**。
文档说明即可，**不做路径转换**。

#### 四 可执行文件定位

`findExecutable(name, { platform, env })`——**纯 JS 实现，不 spawn `which` / `where`**：

- POSIX：按 `:` 拆 `PATH`，逐个 `fs.accessSync(X_OK)`
- Windows：按 `;` 拆 `PATH`，对每个目录尝试 `PATHEXT` 中的扩展名（`.COM;.EXE;.BAT;.CMD`）；
  **Windows 上 `X_OK` 无意义，只看存在性**

纯 JS + 注入 platform → **三大平台的定位规则都能在任意一台机器上单测**（§6.3）。

> ⚠️ **`node:path` 的 `join` 用的是「宿主」规则，不是「目标」规则。**
> 在 Windows 上 `join('/home/t', 'x')` 得到 `'\home\t\x'`——路径被彻底改形。
> 所以凡是"为某个平台算路径"的函数**必须按注入的 platform 选 `win32.join` / `posix.join`**，
> 借宿主的 `join` 会让三平台规则无法在本机单测（实测踩过）。
> 反之，产出**宿主路径**（要交给本机 fs / spawn 用）的函数才用原生 `join`。
> 两条规则的分界：**函数收不收 `platform` 参数**。

#### 五 权限与凭证清理

- POSIX：`chmod 0600`；**Windows 上 `fs.chmod` 基本是 no-op**（只影响只读位），
  实际依赖用户目录 ACL。README 必须说明差异，**别假装设了权限**。
- **macOS 凭证在钥匙串**（§7.1）：`cmt token rm --purge` 删掉 profile 目录后
  **钥匙串条目仍会残留**。v1 在 macOS 上删除时**打印提示**让用户手动清理，**不静默**。

### 2.10 直接拉起优先，launch 脚本是兜底产物

**首选路径：不生成脚本。** 直接 `platform.spawnTerminal({ title, cwd, argv }, stripSessionMarkers(ctx.env))`，
`argv = [nodePath, cmtPath, 'exec', token, '--model', id, ...]`（环境那份见 §2.6）。

好处是**消灭了整整一类问题**：无 shell 解析、无转义、无代码页——
Node 在 Windows 上用 UTF-16 传参，**中文路径不会经过 `.cmd`**。
cwd 也由终端的 cwd 参数传递（`wt -d` / `--working-directory` / `-c`），同样不进脚本。

**仅在三种情况生成 `profiles/<token>/launch.{cmd,sh}`**：
① 终端只接受命令字符串（macOS `osascript`、`cmd /c start`）；
② 终端无 cwd 选项（如 `xterm`）；③ `--print` 或用户要手工重跑。

生成时**内容只允许**包含下面四件事：

1. **绝对路径调用**：`"<node 绝对路径>" "<bin/cmt.js 绝对路径>" exec <token> --model <id> [--url <u>] [--auth-mode token|key] [-c]`
   - `node` 用 `process.execPath`，**不用 `node` 字面量**；cmt 入口用 `fileURLToPath(import.meta.url)`
   - 理由：新终端的 PATH 与启动时可能不同，**任何一步都不能依赖 PATH**
   - 脚本的 argv 与「直接拉起」路径**逐字一致**——脚本是首选路径的忠实序列化，
     所以"手工重跑脚本"与 `cmt run` 不会跑出两套语义
   - ⚠️ **这条序列有三处副本**：`run.js` 的 argv、`buildLaunchScript()` 的 cmd 分支与 sh 分支
     （引号规则不同，合并不了）。**改一处必须改三处**——它们漂移过一次：`cmt run --url X`
     只把 X 用在自己的解析里，转发给内层 `cmt exec` 的命令行里却没有 `--url`，
     于是"回执说的"与"窗口里跑的"成了两套。有测试守着两边一致。
   - 只转发**命令行上真给了的**覆盖项，不转发 `resolved` 里的解析结果——
     内层 `cmt exec` 会照着同样的配置自己再解析一遍，把配置层的结果抄进脚本
     反而会让 profile 目录里多出一份配置副本（§2.7）
   - **没有 `--token-value`**，这是 §2.7 铁律的结构性保证（`buildLaunchScript()` 压根
     没有这个入参）；`cmt run` 见到该选项直接报错，见 §2.7 末
   - `--url` 的值若带 userinfo 也进不来：`cmt run` 用 `urlCarriesCredential()` 提前拒了
     （同上，见 §2.7 末）
2. **不放 cwd**（由终端的 cwd 参数传入）。只有在①/②兜底路径下才写 `cd /d "<cwd>"`（cmd）/
   `cd "<cwd>"`（sh）——此时 `cmt doctor` 要标注该路径的**编码风险**。
3. **参数透传**：cmd 用 `%*`，sh 用 `"$@"`——**且必须紧跟在 `--` 之后**：
   `... exec <token> --model <id> [--url <u>] [-c] -- "$@"`。
   理由：脚本末尾的参数会原样落进 `cmt exec` 的 argv，而 **cmt 自己的解析器会拒收陌生选项**
   （它不认识 `--verbose` / `--dangerously-skip-permissions` 这些 claude 的旗标）。
   少了这个分隔符，`launch.cmd --verbose` 会死在"未知选项 --verbose"上，永远到不了 claude。
4. **不出现任何密钥**（§2.7 铁律）。`--url` / `--auth-mode` 是**非密钥**覆盖项，可以内联
   （`--url` 常常写成 `${RELAY_BASE_URL}` 这类引用串——引用跨得过进程边界，密钥跨不过）。
   ⚠️ **例外**：`--url` 带 userinfo（`https://user:pass@host/…`）时它**就是**密钥，
   `cmt run` 提前拒绝，所以到不了这里——判据 `urlCarriesCredential()`，见 §2.7 末。

**转义**（脚本本身就是字符串产物，所以必做，且必须带单测）：

| 目标 | 规则 |
|------|------|
| `.cmd` | 值一律 `"..."` 包裹；**`%` 要写成 `%%`**（cmd 里 `%` 即使在引号内也会展开）。`%*` 是唯一**故意不转义**的片段，别让它经过引号函数变成 `%%*` |
| `.sh` | 值一律 `'...'` 包裹；内部的 `'` 用 `'\''` 收尾重开 |

固定关键字（`exec` / `--model` / `--url` / `--auth-mode` / `-c`）不加引号，只有**值**加引号。

**编码规则**（生成脚本时）：`.sh` 用 LF + `#!/bin/sh` + `chmod 0755`；
`.cmd` 用 CRLF 且**整个文件都是纯 ASCII——注释也不例外**。
（中文 Windows 的 cmd 默认跑在 OEM 代码页，UTF-8 的中文注释会让它把后面的字节一起读花，
路径再 ASCII 也救不回来。所以 `.cmd` 的注释写英文，理由留在这里和代码注释里。）
检测到必需路径含非 ASCII → `cmt doctor` 报警并建议走"直接拉起"路径。

> ⚠️ **实测补充（2026-10，Windows 11 中文版）：范围比"注释"宽得多——任何非 ASCII 路径
> 只要被*写进* `.cmd` 就会坏，不只是注释。** cmd.exe 按 OEM 代码页（GBK）解码 .cmd 的字节，
> 而生成器写的是 UTF-8：路径里的「实」是 `E5 AE 9E`，被当成两个 GBK 字符，
> 于是 cmd 拿着一个根本不存在的路径去执行，**静默失败、什么都不输出**（最难查的那种）。
> 而**同一个路径走环境变量就完全正常**——环境变量在 Windows 上是 UTF-16，不经代码页。
> 推论：`launch.cmd` 里必然写进 cmt 自己的安装路径，所以**仓库放在中文目录下时它必坏**。
> 这正是"直接拉起优先、launch 脚本只是兜底"（§2.10 开头）真正的分量所在，
> 也是 `cmt doctor` 那条报警必须存在的原因。复现脚本见 `scripts/live-terminal-check.mjs`。

`cmt exec` 的职责：解析四要素 → `buildSessionEnv()` 算出这份会话的环境（§2.6）→ **定位 claude** →
`spawn(stdio: 'inherit', env)` → 转发退出码。

**claude 可执行文件定位顺序**（与上面同理，不依赖 PATH）：

| 顺序 | 来源 |
|------|------|
| 1 | `defaults.claudeBin`（显式配置） |
| 2 | `findExecutable('claude')`（§2.9 四，纯 JS，不 spawn `which`/`where`） |
| 3 | 常见安装路径：Windows `%USERPROFILE%\.local\bin\claude.exe`；macOS/Linux `~/.local/bin/claude` |
| 4 | 都找不到 → 退出码 2，提示安装命令 |

命中 2 或 3 时把**绝对路径写回 `defaults.claudeBin`**，下次免探测。

---

### 2.11 ★ 项目本地配置 `.cmt.json`（第四层，2026-10-18 新增）

**一句话：让一个仓库自己带上"我该用哪个身份、跑哪些模型"，克隆下来就能用。**

#### 一、发现规则

- 文件名 **`.cmt.json`**，放在**项目目录**里（不是 `~/.claude-multi-token/`）。
- 发现：**从调用时的 cwd 逐级往上找，最近的胜出**，直到文件系统根。
- `--config <路径>`：读**同一份 schema** 的显式路径。**不引入第二套 schema**——
  两套 schema 就等于两处真相，迟早分叉。
- 绑定匹配仍然永远用**调用时的 cwd**（§2.3），**不是** `.cmt.json` 所在目录。
  两者通常相同，不同时以调用 cwd 为准——这条与 §2.3「绝不用 `token.cwd` 匹配绑定」同源。
- **cmt 绝不自动创建它**（§3.2 惰性）。只有面板向导（§2.12）或用户自己动手才写。

#### 二、★★ 受限 schema：**不许放凭证**

```jsonc
{
  "version": 1,                    // 必填，与全局 config.json 一致
  "token": "relay-a",              // 引用 tokens/<name>.json 里的名字，不是密钥本身
  "models": [{ "id": "deepseek-flash" }],
  "env": { "CLAUDE_CODE_EFFORT_LEVEL": "max" },
  "claudeArgs": []
}
```

**允许**：`version` / `token` / `models` / `env` / `claudeArgs`

**禁止，且给专门的报错**（每个禁键一条测试，断言报错信息**点它的名**）：

| 禁掉的键 | 为什么 |
|---|---|
| `authToken` | §2.7「token 只有一个落盘点」。多一个落盘点就多一份明文副本 |
| `baseUrl` | ★ **这是外泄通道**：克隆来的仓库里写 `baseUrl: "https://evil.example.com"`，你 `cmt run` 一下，你的 key 就被送到那儿去了。这条不是"不方便"，是攻击面 |
| `env.CLAUDE_CONFIG_DIR` | 隔离原语（§2.2）。项目文件不许改身份落点——改了它，profile 与登录态就跟着项目走了 |
| `cwd` | 文件本身就是"按路径找到的"，再声明 cwd 是循环定义 |
| `slots` | §2.12 边界：槽位不进项目文件（否则两个面板分叉） |
| `claudeBin` / `terminalMode` / `seed` | 机器级偏好，不是项目级 |

> **地址跟着身份走。** 要换端点，写在 `tokens/<名字>.json` 的 `baseUrl` 里（§2.4）。
> 一个 token = 一份凭证 + 一个端点，这个等式不许在项目文件里被拆开。

⇒ **副产品：`.cmt.json` 天生不含密钥，可以安全提交进仓库。** 写进 README 当卖点。

#### 三、优先级（§2.3 表已列，这里只讲理由）

| 关系 | 谁赢 | 为什么 |
|------|------|--------|
| 项目本地 vs 命令行 | **命令行** | 你这一下敲的，比仓库里躺着的更权威 |
| 项目本地 vs 路径绑定 | **项目本地** | 绑定按路径前缀匹配**一批**目录；项目文件只对它所在的那一棵树生效——更具体 |
| 项目本地 vs token / defaults | **项目本地** | 越具体越优先，与其余各层一致 |

⚠️ **项目本地层没有 `cwd` / `baseUrl` / `authToken` / `slots`**（§2.3 表里那四个 ⚠️）。
`resolveCwd()` 与注入清单都**不认**这一层——不是忘了接，是上面那张禁键表的直接后果。

#### 四、坏文件必须硬报错

JSON 非法、`version` 缺失或不是 1、出现禁键、未知键 → **报错退出（码 1）**，
**绝不静默跳过**。理由与 `readAllTokens` 同纪律：静默跳过一个坏配置，
用户看到的是"我明明配了它却没用"，而唯一的线索是某个他不知道自己该去看的地方。

#### 五、`cmt model set/use/next/clear` 的写入目标跟着生效层走

`--path <p>` 那条路要**多认一层**：该路径的项目本地配置若声明了 `models`，
**目标层就是那个文件**，而不是 `bindings[]`。

理由：写到一个不生效的地方 = 命令静默失效，正是 §6.2「宁可明确」要避免的。
（`models.js` 已有"先物化再轮转"的逻辑，扩一层即可。）

★ **`--config` 也在这条规则里，不是它的例外。** 生效层是"哪一份文件在说话"，
而 `--config` 正是"这一份才是我的项目配置"（§2.11 一）——所以
`cmt --config A model set --path B` 写的是 **A**（B 那份连发现都不做）。
判据**只有一处**：`cli/target.js` 的 `projectConfigAt(ctx, dir)`，
`pickWriteTarget()` 与 `effectiveAt()` 共用它。面板的 `e` 走的也是 `pickWriteTarget()`
（§2.12 二），所以命令行与面板**不可能**分叉——在 `ui.js` 里再认一遍 `--config`
就是第二处真相。

⚠️ 判据是**"那一份有没有声明 `models`"**，不是"给没给 `--config`"：
`--config` 指的那份若只声明了 `token`，写入**仍然落到 binding**
（它没说话 = 不参与这一项）。否则一个只管 token 的文件会**凭空开始管模型**——
而那是它自己下一次 `cmt resolve` 才会露出来的变化。

#### 六、cmt 绝不自动创建它

见 §3.1 的所有权表：`.cmt.json` 是**新的一类**——cmt 只在你让它建的时候建
（面板向导第 4 步，§2.12 四），**绝不**因为"这个目录还没有"就替你写一个。

---

### 2.12 面板：全屏 TUI 与网页控制台（2026-10-18 新增）

**一句话：不记 flag、不查文档，选一个条目、回车，就开一个新会话——
终端里用方向键（TUI），浏览器里用鼠标点（控制台）。**

#### 一、入口

**两个前端，两条入口**：`cmt ui` 进全屏 TUI，裸 `cmt` 开网页控制台（§十一）。

| 命令 | TTY | 非 TTY |
|------|-----|--------|
| `cmt`（裸） | **开网页控制台** | **打印用法、退出 0**（脚本不受影响） |
| `cmt ui` | 进全屏 TUI | **报错退出 1**（与 `--pick` 同纪律，§2.5） |
| `cmt ui --web` / `CMT_UI=web` | 开网页控制台 | **也开**——它不需要终端（e2e 的钩子，同 `CMT_UI=plain` 的角色） |
| `cmt ui --web --no-open` | 只打印 URL，不开浏览器 | 同左（**口令不进 argv**） |
| 其它子命令 | 一律照旧，面板不参与 | 同左 |

> **为什么裸 `cmt` 也进面板**：Claude Code 自己无参数就是交互式 TUI，用户对"裸敲一个
> CLI 名"的预期已经是那样了。非 TTY 退回用法保证了 `cmt | grep` 这类脚本仍然工作——
> 这条**必须**有测试（§6.3）。
> ★ **"控制台成为默认"不等于"管道里也是"**：非 TTY 那条闸门原样保留，
> 否则 `cmt | grep` 会挂住等一个永远不退的服务器。
> ★ **`CMT_UI` 管不着裸 `cmt`**（`plain` 和 `web` 都不行）：那个变量的意思是"面板换一种
> 画法"，不是"把非交互的 `cmt` 变成交互的"。两条各有一个 e2e。

#### 二、形态与键位

```
 当前目录                      ← 面板启动时所在目录，走默认解析
 agent_multi_token   → relay-cmt
 (未绑定)            → relay-a
 + 新建…

 authToken: sk-****abcd         模型 (3/12)
 baseUrl:   https://oneapi-…     ▸ deepseek-flash
 source:    路径绑定              deepseek-flash[1m]
 profile:   已建                  gpt-5.6-sol
```

| 键 | 作用 |
|---|---|
| `↑` `↓` / `Home` `End` / `PgUp` `PgDn` | 移动光标（边缘滚动，见 §2.12 五） |
| `Enter` | **启动**（等价 `cmt run`，开新标签页）。★ **面板留在原地**并显示「已启动 ✓」，这样可以连着开好几个 |
| `n` / `e` / `d` | 新建向导 / 改模型 / 删绑定 |
| `r` | 重新读配置（外部改了文件时用） |
| `q` / `Esc` / `Ctrl+C` | 退出 |

**左栏是「可启动项」，不是裸 token 列表**：当前目录、每条绑定、没有绑定的 token、
`+ 新建…`。理由是面板要回答的问题是"**我要在哪开**"，token 只是答案的一部分。

★★ **每一项的身份来自"解析结果"，不是来自"它有没有绑定"**。四类项各按各的路走：

| 项 | 喂给解析的 | 于是「当前目录」那一行 |
|---|---|---|
| 当前目录 | **什么都不喂**（= 裸 `cmt run` 那条路） | 走完整级联：项目本地 → 绑定 → `defaults.token` |
| 每条绑定 | 那条绑定声明的 token 名 | —— |
| 未绑定的 token | 那个 token 名 | —— |
| `+ 新建…` | —— | 没有身份，回车进向导 |

判据是**解析出来的 `token` 名**。这一条不是实现细节，是承重的：`Enter`（启动）与
`e`（改模型）**都靠它判"这一项有没有身份"**。少了它，「当前目录」那一行会既启动不了
也改不了模型——而那正是裸 `cmt` 落上去的第一行。

**来源层的名字要如实**：绑定行与未绑定 token 行是**把 token 名当 `argv.token`** 喂进
解析的，于是来源恒为 `cli`——照直印出来就是「来源：命令行」，而用户从没在命令行上
给过任何东西。这两行必须**指定来源层的代号**，且翻译成中文只做一处
（两条路各拼一遍，迟早拼得不一样）。

#### 三、★ 括号粘贴必须开（这是 bug 修复，不是优化）

关掉 `?2004` 时，终端把粘贴内容**当成用户逐字敲的**灌进输入流，于是：

1. **粘贴内容里的 `\r`/`\n` 会被当成 Enter。** 复制一段带尾换行的 `sk-…` 粘进第 2 步 →
   **中途触发提交**。静默、破坏性。
2. **粘贴内容里的 `ESC` 会被当成转义序列开头。** 从别的终端粘一段带 ANSI 的日志 →
   那不是文本，是**注入的按键**（能触发 `q` 退出）。

开 `?2004` 后整段粘贴被 `[200~` … `[201~` 包住，里面**逐字节都是字面文本**，
两条一起消失。

> ⚠️ **标记是 `ESC [ 200 ~` / `ESC [ 201 ~`，没有 `?`。** `?` 只在 DECSET/DECRST 的
> 设置序列里。写成 `ESC [ ? 200 ~` 是经典 bug：**永远匹配不上**，于是 `[200~`
> 变成插进输入框的字面文本。这条要有单测。
>
> ⚠️ **粘贴必须是解码器的一个"模式"，不是后处理**——粘贴期间不许有任何按键语义泄漏出去，
> **包括 `\x03`**。粘一段含 Ctrl+C 的二进制内容绝不能把面板关掉。

残余风险（写进 README）：不支持 `?2004` 的老终端会忽略 DECSET，退化回上面两条。
这是唯一无法在代码里消除的。

#### 四、新建向导（四步）

| 步 | 屏 | 交互 |
|---|---|---|
| 1/4 | **路径** | 文本框，预填 cwd；下方实时列出该目录的子目录（↑↓ 选、Tab 补全） |
| 2/4 | **身份** | 列出已有 token（↑↓ 选）＋「+ 新建 token」（输入名字 + 粘贴 sk，sk 全程掩码显示） |
| 3/4 | **模型** | 用该 token 拉 `GET {baseUrl}/models` → 列表；**空格勾选，勾选顺序即优先级**；`/` 过滤。失败时给 `[r] 重试 / [m] 手敲 id / [s] 跳过`——端点在**内网**，拉不到是常态 |
| 4/4 | **落点** | **两个都写**：全局 `config.bindings += {path, token}` **且**项目 `.cmt.json = {version, token, models}` |

⚠️ 直觉上的顺序是「选本地路径 → 获取模型 list → 输入 token」，但**没有 token 就拉不到
模型列表**（端点要 `Authorization: Bearer`）。所以实现顺序是 **路径 → token → 模型**。
这是约束不是选择。

**向导第 4 步写两处，是刻意的**：全局那份让"下次换个目录也认得这个 token"，
项目那份让"这个仓库自己带着配置"。两者不重复——一个记"谁"，一个记"这个仓库怎么跑"。

#### 五、★ 布局：每行严格 `≤ cols`

**★★ 唯一不能破的规则：每一行在"终端自己的列宽"意义下都必须 ≤ `cols`。**

破了不是烂一行，是**烂整屏**：终端自动折行 → 那一行之后所有行的实际屏幕行号 +1 →
右栏内容跑到左栏下一行的位置、页脚出屏；**而且每帧重犯**（全量重绘不自愈）。
所以这条要**机器守住**：`render()` 出口是唯一一条路，出口前必过 `fitLine()`。

守门的宽度函数是**保守版**，与 `format.js` 的 `displayWidth()` **故意不一致**：

| 函数 | 用途 | 歧义字符（`─ │ … ↑`）算几列 |
|---|---|---|
| `displayWidth()` | 内容对齐 | 1（与 CJK 终端的窄渲染一致） |
| **`frameWidth()`（新）** | **这行放不放得下** | **2，永远不低估** |

代价不对称所以规则不对称：低估 1 列 = 折行 = 整屏错位；
**高估 1 列 = 行尾多一个空格，而装配时尾部空格被去掉，零代价**。

**边框一律 ASCII，且竖线之外一根横线都不画。** 结构靠**空行 + 缩进 + 反显**表达
（htop/btop/lazygit 早就不画 `┌──┬──┐` 了）。理由：`U+2500–U+257F` 是 UAX #11 的
Ambiguous，而**本机 WT 1.24 没有 `ambiguousUnicodeWidth` 设置（那是 1.25 才加的）**，
我们无法让用户去关掉它。ASCII 是"它本来就不会错"，`frameWidth` 是"我们算错了也不会烂屏"
——两层防御，理由不同。（箭头 `↑↓` 是 Ambiguous 但它在**页脚**，有 `fitLine` 兜着，
最坏是少显示一个字。**结构字符不许歧义，内容字符可以。**）

三级退化（常量集中在 `render.js` 顶部，每个都带来历注释）：

| 档 | 条件 | 表现 |
|---|---|---|
| too-small | `cols < 40` 或 `rows < 8` 或 `bodyH < 3` | 屏幕正中一行「终端太小（当前 30×6，至少 40×8）」 |
| single | `cols < 72` | 只画列表；Enter 进详情、Esc/← 回列表；页脚**换行成 2 行** |
| two | `cols ≥ 72` | 左列表（`clamp(cols*0.34, 20, 40)`）/ 1 列分隔 / 右详情 |

★ **72 这个数是页脚定的，不是栏宽定的**（页脚提示串宽 46，`72 - 2 边距 = 70 ≥ 46`）。
改提示串就得改这个常量——有一条**守护测试**钉住这层耦合。

行号算术（1-based，与终端 `CUP` 同一套）：`1 标题 / 2 空行 / 3..2+bodyH 正文 / 其后页脚`，
守恒式 **`2 + bodyH + ftr === rows`** 必须单测。

滚动：**边缘滚动**（`top` 进 state），不做"光标永远居中"（每按一次整列都动，用户失去位置
锚点）。PgUp/PgDn **必须显式滚 `top`**——只靠 `scrollTop` 的话，光标在窗口顶部时按 PgDn
会"认为光标还在窗口里"而不滚，用户按了翻页却只看见光标下移，那正是"静默地什么都不做"。
「还有多少没显示」用**栏标题**报（`模型 (3/12)`），不占正文行。

防闪烁三件事，缺一不可：**① 除进屏那次永不 `[2J`**（要擦上一帧更长的尾巴，那是
`[K` 的活）；**② 一帧一次 `write()`**（不是省系统调用，是让终端把一帧当一帧）；
**③ 行尾不补空格，一律 `[K`**（补空格必须补正好 `cols` 个，多一个就折行）。

**不做 diff。** 120×40 一帧 ≈ 5 KB，30 次/秒 = 150 KB/s，JS 拼接是微秒级；而 diff 要维护
影子缓冲 + 切 run + 每个 run 一次 `CUP`——在 Windows 上那是**更多次、更小的控制台写调用**，
正是最容易撕裂的模式。且 WT 的 AtlasEngine 本来就只重绘变化的格子。**不设 diff 开关**
（留着就会有人打开）。

#### 六、模型清单：**每次现拉**，拉到的另行登记

**`/models` 有三个消费者，全部现拉、互不共用缓存**：① 面板第 3 步（本节四）；
② 资源表的「拉取 / 全部拉取」（本节十二）；③ **启动前校验**（§2.5，超时 2 秒而不是 10 秒）。
第三个消费者尤其不能拿 `resources.json` 顶替——缓存只喂下拉候选与资源表，
"这个模型现在到底存不存在"必须问端点本人。

`GET {baseUrl}/models`，头 `Authorization: Bearer <sk>`，`AbortSignal.timeout(10000)`。
**绝不打印 token**；错误信息只带 HTTP 状态与响应体片段。

每次进向导都现拉——**绝不拿旧清单冒充新清单**（§2.5「不记忆任何跨会话选择」）。
代价是内网端点慢时第 3 步要等。

> **2026-10-24 订正**：这里原来写的是「不落盘、不跨会话缓存……不缓存就没有失效问题」。
> 现在确实记一份（`resources.json`，见本节十二），但那**不是**"拿旧值代替现拉"：
> 它是用户**看得见**的资源登记，带 `url` 与 `fetchedAt`，地址一变就标「地址已变」，
> 随时能手动「拉取 / 全部拉取」；第 3 步仍然每次现拉。**绝对化的措辞作废，
> 「不拿旧清单冒充新清单」这条不变。**

#### 七、非 TTY 与 `CMT_UI=plain` 逃生舱

`CMT_UI=plain`：不进备用屏、不进 raw mode，用**逐行输出**。它同时是
① 终端被强杀后备用屏残留时的出路 ② **e2e 的测试路径**（无需真 TTY）。

★ `CMT_UI=plain` **不许**改变裸 `cmt` 的行为——那个变量的意思是"面板换一种画法"，
不是"把非交互的 cmt 变成交互的"。裸 `cmt` 在非 TTY 下**永远**打印用法退出 0。

#### 八、★ 保证还原（`ui/term.js` 的全部职责）

进屏：`?1049h`（备用屏）+ `[2J[H`（**只此一次**）+ `?25l` + `?2004h`
出屏：`?2004l` → `?25h` → `?1049l`（**顺序不可换**：光标状态是终端的，
带着隐藏光标回主屏 = 用户看不见自己的 shell 光标）

`RESTORE` 序列必须**纯 ASCII**（§7.8 的 `writeSync` 代码页事实），且有单测逐字节钉住。

#### 九、Windows 专有暗礁

见 **§7.8**。那一节是本节实现细节的依据，别绕过它。

#### 十、cmt 侧的边界（与 cxt 面板的差异）

| 差异 | 处置 |
|------|------|
| **`slots` 不进面板** | v1 面板只配 `models`；`slots` 仍走 `cmt slot set`。理由：`fillDefaultSlots` 会拿 `models[0]` 填未设的槽，配 `models` 已覆盖绝大多数场景；把槽位塞进向导会让两个面板分叉 |
| **禁键是 `env.CLAUDE_CONFIG_DIR`** | cxt 那边是 `env.CODEX_HOME`，同一条隔离原语 |
| **`ui/` 四个内核文件逐字一致** | 见 §4.1。工具名、项目配置文件名、**环境变量名**、**契约父节号**四样**都不许**写进那四个文件——前两样从 `PanelData` 进来，环境变量由调用方解析成值、父节号写成「面板 §五」这种节名 + 子节号。所以两份拷贝能真的 `diff` 为空 |

#### 十一、Web 控制台（2026-10-18 新增）

**一句话：同一个面板，换成浏览器里的一个表单——下拉、勾选框、按钮，鼠标点。**

用户原话：「`cmt ui` 这种在终端显示的 ui 界面操作麻烦。不是我期待的那种 ui，
我期待的是传统的、类似 app client 界面的那种下拉列表、checkbox 这种组件组成的一个表单。」
⇒ 这是**换一种前端形态**，不是修补 TUI。方向键驱动不是他要的东西。

两个前端**共用同一套副作用词表、结果事件、`reduce()` 与 `makeExecutor()`**——
共用的全是「业务」，不共用的全是「呈现」（TUI 走 `render.js` + `term.js`，
控制台走 HTML/CSS + `platform/serve-web.js`）。所以**没有第二套写配置的路径**。

**入口见「一、入口」那张表**——两张表一定会漂移，所以只留一张。

启动时**总是**打印「打不开浏览器？用 `cmt ui` 进全屏面板（SSH/无头环境）」：
SSH 下浏览器是**够不着**的，而控制台又成了裸命令的默认——不提示的话，
用户会以为这个工具在服务器上坏了。**这是保留 TUI 最强的理由。**

**威胁模型**：它**会写配置文件、还会收到明文 sk**。所以有 14 条控制，每条一个测试（§6.3）：

| # | 控制 | 确切检查 | 挡什么 |
|---|------|---------|--------|
| 1 | 只绑回环 | `listen(0, '127.0.0.1')`——绝不 `0.0.0.0`、绝不 `::` | 局域网可达 |
| 2 | 随机端口 | `listen(0)` 后读回 `address().port` | 冲突、可预测 |
| 3 | **路径口令** | `randomBytes(16)` 的 32 位 hex；首段**逐字节相等**（`timingSafeEqual`），否则 404 | 本机其它进程。**主防线** |
| 4 | Host 白名单 | `Host` ∈ {`127.0.0.1:<port>`, `localhost:<port>`}，**每个请求都查，含资产** | **DNS rebinding** |
| 5 | Origin 校验 | POST 时**缺失即拒**；`null` 拒 | CSRF |
| 6 | 永不发 CORS | 绝不出现 `Access-Control-Allow-*`；`OPTIONS` → 405 | 跨源**读** |
| 7 | CSP | `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'` | XSS 外带、点击劫持 |
| 8 | 响应头 | `charset=utf-8` + `nosniff` + `Referrer-Policy: no-referrer` | MIME 混淆、口令经 referrer 泄漏 |
| 9 | body 上限 | 64 KiB，**边读边判**（超限 `req.destroy()` → 413），**不信 `Content-Length`** | 内存耗尽、chunked 绕过 |
| 10 | 方法白名单 | 资产/`api/state` 只 GET/HEAD；`api/op` 只 POST；否则 405 | |
| 11 | API 不缓存 | `/api/*` 带 `Cache-Control: no-store` | 状态进磁盘缓存 |
| 12 | 空闲退出 | `idleMs`（默认 30 min）无请求 ⇒ 关 | 服务器活得比终端久 |
| 13 | SIGINT | `process.on('SIGINT', close)`，`close()` 里摘掉。★ **放 `serve-web.js` 里，不放 `cli/`** | 孤儿进程 |
| 14 | 不记 body | `onLog` 只收 `method path status ms`——**永不收 body** | 密钥进日志 |

★ **`localhost` ↔ `127.0.0.1` 两个方向都会错**：开的必须是 `http://127.0.0.1:<port>/…`
（在 `localhost` 先解析到 `::1` 的机器上，绑 v4 的服务器会拒连，而 URL 看着完全正常）；
查的 `Host` 白名单必须**两种拼法都收**（用户会手敲）。两个方向各一条测试。

★ **`ops.apply` 要串行化**（单槽 promise 链）：没有它，两个在飞的 POST 会交错，
把唯一的共享 reducer 状态搞坏。

**路由**（前缀 = 口令）：

| 方法 | 路径 | → |
|------|------|---|
| GET/HEAD | `/<tok>/` 与 `/<tok>/<name>` | `assets` 里**精确路径**查表（无 fs、无拼接 ⇒ 路径穿越结构上不可能） |
| GET | `/<tok>`（无斜杠） | 301 → `/<tok>/`（相对 URL 解析要用） |
| GET | `/<tok>/api/state` | `ops.view()` |
| POST | `/<tok>/api/op` | `ops.apply(body)`；回**裸视图**（见下）。`done:true` ⇒ 冲完响应再关 |
| 其它 | | **404 空体**（不是 403——不给探测口） |

相对 URL（`fetch('api/state')`、`<link href="style.css">`）从 `/<tok>/` 起正确解析
⇒ **前端零 base-path 逻辑**。

★★ **两个 API 回的是同一个东西：裸视图模型本身。没有信封。**

| | 上线吗 | 谁读它 |
|---|---|---|
| 响应体 = 视图模型 | ✅ | 页面（`web/app.js` 的 `takeView()`） |
| `ops.apply()` 返回的 `done` | ❌ **不上线** | `serve-web.js` 自己（"回完这条就关"的收尾信号） |
| 视图里的 `quitting` | ✅ | 页面靠它把自己关掉 |

⚠️ **这不是可有可无的措辞**：`GET api/state` 与 `POST api/op` 回**同一个形状**，
所以页面只有一条解析路径。**曾经真的写错过**——前端读 `data.view`，而服务端发的是
裸视图 ⇒ 第一个动作之后 `view` 是 `undefined`，**整页炸**，而两个项目的单测**全绿**
（前端没有测试框架，零依赖 ⇒ 那一半没有任何测试能碰到）。
★ 抓它的是 `ui-e2e.test.js`：真起一个进程、真发一个 POST、真读回来的那个字节。
⇒ 前端**不许猜**服务端的意思（"我刚发的 op 叫 `quit`"、"`notice === '退出中…'`"
都是"同一件事有两处定义"）；**状态只从视图里读**。`ui-web.test.js` 有一条源码守卫
盯着这三个词（`data.view` / `.done ===` / `quitting`）。

**视图模型**（`viewModel(state)`，从 `ui-web.js` 导出）。
★ **这个形状是跨项目冻结的接口**：`ui-web.js` 两个项目各写各的，喂给**逐字一致**的
`web/app.js`——所以键集**两边都要有**，缺一个只会在缺的那一边坏。

| 字段 | 来源 | 说明 |
|------|------|------|
| `appName` `cwd` `projectFile` | `state.data.*` | 驱动 `<title>` 与页头——**工具名只许出现在这里** |
| `screen` `notice` `pending` `quitting` `confirm` | `state.*` | `confirm` 渲染成**行内横幅**（**不用 `window.confirm`**：那个测不了）。★★ `quitting` = reducer 的**终态**（`step()` 顶上有闸门，此后任何输入都是空操作）——**页面靠这一位收工**，见上面"裸视图"那段 |
| `items[]` | `state.data.items` | `{index, kind, label, token, path, masked, baseUrl, source, models[], active, layer}` |
| `tokens[]` | `state.data.tokens` | `{index, name, label, masked, baseUrl}` |
| `wizard.steps[]` | 由 `wizard.step` 派生 | `{n, title, state:'done'\|'active'\|'todo'}`——前端只据此设 `disabled`，**无逻辑** |
| `wizard.path` | `w.path` | `{text, dirs[]}` |
| `wizard.token` | `w.token` | `{mode, chosen, name, secretLength}`——★ **明文密钥永不过线** |
| `wizard.models` | `w.models` | `{phase, error, ids[], checked:[{id, canUp, canDown}]}`——**预先算好** ⇒ 浏览器里没有 `index===0` 这种逻辑 |
| `sessions[]` | 在场层（§2.14） | `{id, token, cwd, startedAt, pid, unread, pool:{status,label}}`——**只给 live**；`ended`/`dead` 不进面板（只进 `cmt sessions`）；`pool` 两个键与资源行同口径（中文只在 `core/pool.js` 定义一处） |
| `recentSessions[]` | 在场层（§2.14） | `{id, token, cwd, startedAt, endedAt, exitCode, state, unread, pool:{status,label}}`——**24 小时内的 ended/dead**（至多 5 条），会话条「恢复」按钮的来源 |
| `attention[]` | 在场层 + 池 + 信箱（§2.14） | `{kind, severity:'high'\|'normal', title, detail, actions:[{label, op, args}]}`——★ **服务端算好的「需要你处理」清单**（至多 5 条，`actions` 至多两个）；健康时是空数组、整块不显示。页面只照单画按钮，**不做任何判断** |

★ `items[].layer` 是**给 `disabled` 用的**：`ui.js` 的 `layerFor()` 给出 `project`/`binding`/
`token`/`default`，或 `none` = **没有可写的一层**。页面只拿它设那个按钮的 `disabled`——
`'none'` 时点下去只会挨一句「这一项的模型不来自可写的一层」，而**"点了才被骂"正是这个前端要消灭的东西**。
⚠️ 所以它**是键集里的一员**，不是前端能自己算出来的（算出来就是第二处定义）。
⚠️ 共享的 `ui/app.js` 里 `Item.layer` 的类型是**更宽**的一份（多一个 `'token'`）——
那是给"指名道姓改某个 token"的调用方留的。`layerFor()` 调 `pickWriteTarget()` 时不给
`--token`，所以**今天这个字段不会出现 `'token'`**；别照着那份宽类型去写 `case`。

⚠️ **键集变了就是接口变了**：两个项目一起改，§6.3 的黄金形状断言跟着改。
**别在一边加个"顺手"的字段**——另一边看不见它，而失败会发生在**另一边**。

★ **明文密钥永不过线**：`view()` 只发打码值（`describeSecret` 早就打好码了）。
唯一的例外是"新建 token"表单里**用户自己敲进去**的那个。

**第二条输入通道**：reducer 是**按键**形状的，而表单没有光标、没有退格。所以 `ui/app.js`
多一个 `panel` 事件族（`{type:'panel', op, …}`），它是**语义**事件。绝大多数 op 是既有
handler 的别名；**`move-model` 是真新增**——`checked` 的顺序只可能是"勾选时追加"（§2.12 四），
**没有任何按键序列能表达调序**。

> ⚠️ `ui/app.js` 与 `cxt` 的同名文件**逐字一致**（§4.1）。新增那段的注释里
> **只许写节名**（「面板 · Web 控制台」），**永远不许写节号**——本节在 cmt 是「十一」，
> 在 cxt 是「十」。

**第 1 步的两个小按钮：`复制` 与 `打开`。**

- `复制` **完全在前端**，不碰服务器：优先 `navigator.clipboard`，不可用（非安全上下文 / 权限拒绝）
  时退回 `execCommand('copy')` + 一个屏幕外的 `<textarea>`（CSP 禁内联样式，那几条全在
  `style.css`）。两个按钮都只在框里有字时可点。
- `打开` 走后端：`{op:'open-path', value}`。★ 它**不是 `panel` 事件、不进 reducer**——
  终端里没有"弹一个文件管理器"这回事，硬塞进去会让 reducer 多出一个它永远不会产生的状态。
  `ui-web.js` 在 `toEvent()` **之前**按 `body.op` 把它拦下，reducer 一个字节都不动。
  路径解析复用「进子目录」那一路的 `resolveUserPath()`（`~` 展开与相对路径补全只此一处）。
  成功**不写 `notice`**（资源管理器窗口本身就是回执），失败才借 `notice` 说一句——
  **不新增视图模型字段**（键集冻结）。
  ★★ 它把**用户敲的路径**原样交给 `spawn()`，所以 `platform/open-path.js` 三平台都是
  `[目录]` 一个参数、**不过任何 shell**——与 `open-browser.js` 的 `cmd start` 那条路故意不同：
  开目录有可直接执行的 `explorer.exe` / `open` / `xdg-open`。Windows 的 `explorer.exe`
  **成功也回 1**（§7.8 M10），所以只等 `spawn` 事件，不等 `exit`。

**第 3 步的出口是「下一步」按钮**（`{op:'next'}`）。

★ 它只是**回放一个 `Enter`**（`replay(state, { type:'key', key:'enter' })`）——
"第 3 步回车去哪"依然只有 reducer 一处定义（有模型就进第 4 步；改模型那条短路直接写入）。
网页上没有"回车就走"这回事，少了这颗按钮，第 3 步就是**死胡同**（勾完模型也到不了第 4 步）。
`wizard.edit` 时它藏起来——那时候第 3 步就是最后一步，`edit-apply` 那颗「写入」才是出口。

**退出**：页面上的「退出」按钮（`{op:'quit'}`）· `Ctrl+C` · 空闲超时。
★ `quit` **执行器不认**（`ui.js` 的 `default:` 会把它变成 `failed`），所以 `makeSession.feed`
**自己先把它滤掉**，不送进 `exec`——于是"退出"在桥那一侧是**读一个状态位**
（`state.quitting`），不是"接住一个副作用"。三种退出**全在 `serve-web.js` 里**收口。

★ **`slots` 不许进控制台**（与「十、cmt 侧的边界」同一条）：控制台只配 `models`，
`slots` 仍走 `cmt slot set`。⚠️ 这条**不只是产品取舍，还是逐字一致的前提**——
`web/app.js` 是两份**逐字相同**的拷贝，一旦 `slots` 进了控制台，
`index.html` 就得为 `cmt` 多出一块 `cxt` 没有的控件，那份纪律当场崩。
⇒ 将来要做，**两个项目一起做**，先回答"槽位在表单里长什么样"。

**项目状态与身份联动（2026-10-24 新增）**

用户原话：「一个文件夹就是一个项目，开始 完成 进行中 失败 等等状态，不同状态不同配色，
下拉框选择」「token 与 api url 应该存在一一对应的关系，改了一个，应该允许改另外一个」
「考虑到我们不能全面适配所有情况，应该允许用户自行配置」。

**状态是 `projects.json`，不是 `config.json`。**

```jsonc
{ "version": 1,
  "statuses": [{ "id": "todo", "label": "未开始", "color": "slate" }, …],
  "projects": { "<normalizeForCompare 之后的路径>": { "status": "doing" } } }
```

★ **键是 `normalizeForCompare(path, platform)`**（`core/bindings.js`），不是用户给的字面路径——
`D:\work` 与 `d:/work/` 必须是同一个项目。**别写第二个归一化函数。**

★ **为什么不进 `config.json`**：`schema.js` 对 binding 是 `rejectUnknownKeys` 的，
旧版读到带 `status` 的绑定会**整份拒载**。而且状态属于"文件夹"——没绑定的目录也该有状态。

★ **颜色是命名色**（`slate blue teal green amber red purple pink`），明暗两套值归 CSS。
存 hex 会让暗色模式失真。状态可增删改（1–12 个），**仍在用的状态不许删**——
这条由 `core/project-state.js` 的 `validateStatuses()` 判，不是前端。

★ 文件不存在 = 全默认、**不写盘**；第一次改状态才写（`writeJsonAtomic()`）。
`projects` 里指向已删状态的条目**不崩、不自动改写**，渲染成灰色的"未知状态"。

**视图模型多四个键**（`ui-web.js` 的 `viewModel()`，键集仍然冻结）：
`items[].status`、`statuses[]`（`{id,label,color}`）、`tokens[].url`（**原始值**——
`baseUrl` 仍是显示用的那串）、`wizard.token.baseUrl` + `wizard.token.urlOptions`
（**预先算好**：前端没有"哪些地址出现过"这种逻辑）。

**第 2 步的联动**：`ui/app.js` 加三个 `panel` op，**只在第 2 步、`mode==='pick'` 时生效**——

| op | 行为 |
|---|---|
| `select-token {index}` | 换选中，`baseUrl` 跟着走，**不换步**（TUI 的 `pick-token` 仍"选中即进第 3 步"） |
| `set-base-url {value}` | 改地址；若它恰好属于另一个 token，选中项跟着切过去 |
| `confirm-token` | 进第 3 步并拉模型 |

`w.token.baseUrl` 跟着 `chosen` 走，`w.token.urlEdited` 记"用户动过它" ⇒ 第 4 步才写回
`tokens/<名字>.json` 的 `baseUrl`，且回执里明写「服务端 → …」——**不静默改一个用户没看着的字段**。

★ **状态写盘不进 reducer**（与 `open-path` 同一条路）：`ui-web.js` 在 `toEvent()` **之前**
按 `body.op` 拦下 `set-status` / `save-statuses`，写盘后 `session.feed({type:'reloaded', …})`。
终端里没有"项目状态"这回事，让 reducer 多背一套只有浏览器才有的语义，等于给共享的
`ui/app.js` 再开一个分叉口。

**两个状态 op 的载荷**（校验全在 `core/project-state.js`，错误原样借 `notice` 说）：

| op | 载荷 | 成功 | 失败（全部走 `notice`，**不新增字段**） |
|---|---|---|---|
| `set-status` | `{op, index, id}` | 写盘 → `reloaded` | 「列表已经变了，刷新一下再试」·「只有「当前目录」和有绑定的目录能标状态」·「认不出的状态：…」 |
| `save-statuses` | `{op, statuses:[{id,label,color}]}`，**新行 `id === ''`** | 写盘 → `reloaded` → `notice:'状态表已保存'` | `validateStatuses()` 的 `r.error` |

★ **新行的内部 id 由服务端分配**（`s1/s2…`）：让浏览器生成主键，就是把唯一性交给一个
没有全局视野的地方。★ **写盘之后从盘上重读**再 `reloaded`，不从 `session.state.data` 推——
两个控制台窗口可能都在开，"以盘为准"是唯一不会分叉的规则。★ `save-statuses` 成功**要**说一句
（与 `open-path` 相反）：那边资源管理器窗口本身就是回执，这边唯一的回执是"对话框关掉了"——
不说的话，页面会在关掉对话框之后继续挂着**上一次失败**的那句红字。

**视图模型第五个键 `statusFile`**：`projectsPath(home)` 的完整路径（`ui.js` 恒给出，
`ui-web.js` 只在拿到字符串时透传，否则 `''`）。前端**不拼路径**，只把它印在「管理状态」
对话框底部——这是"自定义出口"的一部分：用户得看得见状态存在哪、能自己去看。

★ **`CUSTOM_URL = '__custom__'`**：`urlOptions` 最后一项（「自定义…」）的 `value` 是
**哨兵字符串**，不是 `''`（`''` 是「（未设置）」）。`ui-web.js` **导出** `CUSTOM_URL`，
`src/web/app.js` 里有一份同名 `const`——两处必须字面一致。这是**跨项目接口的一部分**：
两份 `ui-web.js` 各写各的、喂给**逐字一致**的 `app.js`，哨兵漂移只会在漂移的那一边坏。

★★ **BUSY 闸门只关"一帧"**：`isBusy()`（有请求在飞 / `pending` / 已退出）为真时，
`app.js` 把 `.shell` 里所有控件置 `disabled`——但**下一帧开头先原样放开上一帧关掉的
那些**（`gated` 那个 `Set`），再由各控件自己的规则重算。**缺了"放开"这一步，闸门就是单向的**：
一个没有自己规则的控件（第 1 步的「下一步」、第 2 步的两个下拉……）被关一次就再也
回不来。触发条件平常得很——两拍里发了两个动作（打字打快了、改完地址紧接着点上一步），
第一拍回来时第二拍还在飞，那一帧之后整页点不动，而视图早就 `pending:false` 了。
（脚本实测：一次重叠请求之后，`.shell` 里的控件全被关死，而 `GET api/state` 早已 `pending:false`。）

#### 十二、模型下拉与资源表（2026-10-24 新增）

**主屏的模型列是一个原生 `<select>`**，不再有「改模型」按钮。选中即写，写的就是
`cmt model use` 那条路：**把选中的模型提到首位**（`core/models.js` 的 `promoteModel()`，
幂等），写回该行的 `layer`（`probeFor()` 给的 `project` / `binding` / `token` / `default`）。

| 下拉项 | 含义 |
|---|---|
| 「（不声明）」 | 清掉**那一层**的 `models` 键（不是写 `[]`）——回到继承 |
| 某个 id | 提到首位；原本不在清单里就插到首位 |
| 「多个模型…」 | 老的多选 / 排序 / 手敲面板（`{op:'edit'}`），一个像素都没删 |

⚠️ **`detail.models` 是 id 字符串数组**（`probeFor()` 里 `models.map(m => m.id)`），
而 `promoteModel()` 认的是 `{id}` 条目。中间必须包一层，否则 `findIndex(m => m.id === …)`
恒为 `-1`，结果是**把对象混进字符串数组**——JS 当场不报错，写盘时才炸。

`disabled` 与原来那颗按钮同一条判据（`token === ''` / `layer === ''|'none'`）：
判据本身在 reducer 里，前端只是照抄结论。

★ 下拉**只配 `models`，不碰 `slots`**（§2.12 十 的边界不变）。

**三个 op 全部在 `toEvent()` 之前拦**（与 `set-status` 同一条路，reducer 一行不动）：

| op | 载荷 | 说明 |
|---|---|---|
| `set-model` | `{index, id}` | 写那一层 → `reloaded` → `notice` = 回执（`doApplyModels()` 原话） |
| `refresh-models` | `{name}` | 现拉 → 成功登记 → `reloaded`；失败**保留旧记录** |
| `refresh-all-models` | — | 并发拉全部，成功的**一次**落盘，`notice` = `N 成功 · M 失败` |

⚠️ `refresh-all-models` **不许**每个 token 各写一次盘：`readResources` → 改 → `writeResources`
不是原子的，N 个并发写会互相覆盖。**并发拉、一次写。**

**资源表**（左栏「项目 / 资源」切换）由 **token 表**驱动，不是由缓存驱动——
用户要的是"全部 token"，一个还没拉过的 token 也必须有一行（模型清单列写「未拉取」）。

`resources.json`（新文件，`paths.resourcesPath()`）：

```jsonc
{ "version": 1,
  "tokens": { "relay-a": { "url": "…", "models": ["…"], "fetchedAt": "…" } } }
```

- `url` 是**拉取时实际用的地址**（`token.baseUrl ?? defaults.baseUrl`）。判"旧"也用它：
  拿 `token.baseUrl` 裸值比，会把"没配地址、走全局默认"的 token **永远标成旧的**。
- `models` 保持**服务端原序**（§2.12 六：解析器只报告服务端说了什么）；排序是下拉的事。
- 坏 JSON **不硬报**：`readJson()` 对 `config.json` 是抛错的（§2.4），但资源表是可丢弃的
  缓存——`readResources()` 自己吞掉退回空表。**一份坏缓存不许把面板打死。**
- 指向已删 token 的条目**不显示、不自动删**（与"未知状态不自动改写"同一纪律）。
- 上限 500 个 id（`MAX_MODELS`）：一个坏响应不该把下拉撑成不可用。

**视图模型多两个键**（键集仍冻结）：顶层 `resources[]`
（`{name,label,masked,baseUrl,url,cachedUrl,models,fetchedAt,stale,projects,
priority,priorityState,gatewayCount,gatewayUnified}`，后四个见下）与
`items[].modelOptions`（已声明在前、缓存补后、去重；**在服务端算好**——
前端不认"哪些模型出现过"这种事）。

（另有两个 token 池相关的键：顶层 `poolStatuses` 与 `resources[].pool`——见 §2.13 七。）

「绑定数」= **显式声明了这个 token 的绑定**条数（不扫项目本地配置里的 token）。表头就这么写，
别假装能算全。

⚠️ `ui/app.js` 只多了 typedef（`Item.modelOptions?` / `PanelData.resources?` /
`ResourceRow`），**reducer 一行没动**——这正是"三个 op 都走 bypass"的回报。

##### ★ 价格：`/models` 顺路报的挂牌价（2026-10-24）

**`resources.json` 的每条 token 记录还有一个可选键 `pricing`**——拉清单时端点顺路
报的价（OpenRouter 形态：每项 `pricing: {prompt, completion, input_cache_read,
input_cache_write}`，USD/token 的**字符串小数**）。`priceFromEndpoint()` ×1e6 归一成
`{input, output, cacheRead, cacheWrite}`（USD/百万 token；`cacheWrite` 缺省按输入价）。

- **没报价的模型不进表**——"没报价" ≠ "免费"，不进表调用方才知道"不知道"。
- 只认 `pricing` 这个键名；`price` / `cost` 这类自创字段一概不猜——**错的价格比没有
  价格更糟**，用户会照着它做决定。
- **再拉一次没报价 → 旧价整个键消失**：端点已经不挂牌，还按老价算钱就是"涨了价
  却报旧账"。
- 键在则一定是非空对象；绝大多数中转站不报价格，所以**缺省就没有这个键**，
  落盘的 JSON 少一行噪音。
- ⚠️ **价格不进视图模型**：资源表不需要知道，视图模型仍是冻结的 14 键。

`usage`（§五）合成一张表时，价格三级优先：**① 手写 `prices.json`（结算价）→
② 端点自报价（挂牌价，从 `resources.json`）→ ③ 无价 → 渲染 `—`，绝不冒充 $0**。
①永远压过②——用户写的实际结算价不能被网关挂牌价默默盖掉。多个网关报同名模型
不同价时按 token 名字母序取第一个（规则简单且稳定）。

##### ★ 资源表：token 是身份（2026-10-24）

**一行 = 一个 token，身份列就是那把 token 本身**——用户认的是"这把 key"，`name` 只是它在
配置里的标识符。

| 列 | 内容 | 可编辑 |
|---|---|---|
| 身份（token） | `sk-****abcd`（mono，主）+ 昵称输入框 + 机器名 `relay-a`（次要） | 昵称 |
| 服务端 | 生效 URL（复用已有的 `url` 字段） | — |
| 模型优先级 | 前 3 项带 `①②③`，其余 `+N`；点开对话框 | ✅ |
| 绑定数 | 原语义不变（本节末） | — |
| 操作 | 拉取（原有） | — |

★ 「密钥」列**删掉**——它和身份列重复；打码值全表只出现一次。

**昵称**走 `{op:'set-label', name, label}`：空值 = **删键**（不是写 `""`）。
校验在 `normalizeTokenLabel()`（§2.4 末）；它只是展示，**绝不进路径 / profile / 标题 / 环境**。

**优先级**：资源表里的 `priority` 是 **token 级生效值**（`token.models ?? defaults.models`），
`priorityState` 区分 `own`（自己声明了非空）/ `empty`（显式 `[]`）/ `inherit`（没有这个键）。
⚠️ 它**不含**项目本地与绑定层——资源表是按 token 看的；把路径层混进来只会得到一列
"看情况"的数字。要改路径层，回主屏的模型下拉（本节上半）。

**同网关**：`gatewayCount` = 生效 URL 相同的 token 数（含自己；URL 为空串时恒 1）；
`gatewayUnified` = 同组每个 token 的 `priority` **逐个相等**。判据只比 **id 字符串**，
不比 `label`，也不比缓存清单。

**两个新 op**（同样在 `toEvent()` 之前拦，reducer 一行不动）：

| op | 载荷 | 行为 |
|---|---|---|
| `set-label` | `{name, label}` | `mutateToken` + `normalizeToken`；空 ⇒ 删键；成功 `reloadPanel`，失败只借 `notice`，**文件不动** |
| `save-priority` | `{name, ids, scope:'token'\|'gateway'}` | 清洗后写该 token 的 `models`；空数组 ⇒ **删键**（回继承），不写 `[]`；`scope:'gateway'` 时服务端**自己**按生效 URL 找同组 token |

`save-priority` 的清洗**在服务端做、不信前端**：`Array.isArray` + 逐项 `trim` + 丢空 +
去重保序 + ≤500 项 + 单项 ≤128 字 + 拒控制字符。`scope:'gateway'` 逐个 `mutateToken`，
中途失败就停，`notice` 说成功几个（`已更新 N 个 token`）。

**优先级对话框**（`#priority-dialog`，照 `#status-dialog` 的模子）：**纯前端草稿**，不写盘——
↑ / ↓ 调序、× 删除、输入框 + `<datalist>` 候选（= 资源表出现过的全部 id ∪ 当前 `priority`，
服务端给，前端**不查网络**）、手敲任意 id 也行。复选框「同网关的 N 个 token 一并套用」
只在 `gatewayCount ≥ 2` 时出现，**默认勾选当且仅当 `gatewayUnified`**——已经统一的保持统一，
已经分叉的默认只改自己（统一必须是一次显式动作，绝不在别处隐式发生）。
底部一行灰字「空列表 = 回到继承」。

⚠️ **不做拖拽**：没有指针基础设施，↑/↓ 与状态对话框是同一套交互，键盘也能用。

##### ★ 资源表：添加 token（2026-10-25）

**资源板块不再只读**——空表时不必切回项目屏走向导第 2 步。

| op | 载荷 | 行为 |
|---|---|---|
| `add-token` | `{name, secret, baseUrl?}` | 服务端**直接复用向导的 `doSaveToken()`**（`ui.js`，因网页控制台同路而导出，同 `doApplyModels` 例）；校验/重名/空密钥 ⇒ `notice` + **一个字节不写**；成功 ⇒ `reloadPanel` + `notice`「已添加 \<name\>」 |

- `name` 走 `validateTokenName()`（§2.4）；`secret` 必须非空字符串；`baseUrl` 可选，
  空串 = 不写键。**明文密钥只在 POST body → 落盘这一趟**，回执视图**永不含 secret**
  （§2.12 十一文件头铁律）。
- 前端：资源屏表头「＋ 添加 token」入口 + `#add-dialog`（照 `#priority-dialog` 模子：
  name 文本框 / secret 密码框 / baseUrl 选填，`.sheet-ops` 取消+保存）；
  成功判据 = **回执 `resources` 里出现新行**，不靠 notice。空表提示改指向本入口。
- 视图模型键集**不变**（bypass op），reducer 一行不动。

##### ★ 资源表：环境变量编辑器（2026-10-25）

`env` 逃生舱（§2.3 按键合并、§2.6 空串=删继承变量）此前只能手改 JSON——写死的
注入面盖不住每一种情况，这个入口把它搬进资源板块。

| op | 载荷 | 行为 |
|---|---|---|
| `save-env` | `{target:'token'\|'defaults', name?, env}` | token → `mutateToken`；defaults → `mutateConfig` 改 `defaults.env`。`{}` = **删键**（回继承，与 `save-priority` 空数组同语义）。校验**只在服务端** `normalizeEnv()`（空键名 / 非字符串值 ⇒ `notice`，文件一个字节不动） |

- `env` 是**解析好的对象**（`JSON.parse` 的早反馈在前端）；值**原样过线**
  （`baseUrl` 先例）——回执带回来给对话框预填，`authToken` 仍打码。
- 值为 `""` 的键**有意义**：注入时删掉继承来的那个变量（§2.6），对话框提示写明。
- **视图模型键集变化（接口变化）**：资源行 14 键 → **15 键**（+`env`，未设 = `{}`）；
  顶层 +`defaultsEnv`。两边 + 两份契约 + 黄金形状一起改。
- 前端：资源行操作列「环境」按钮 + 资源屏表头「默认环境」+ `#env-dialog`
  （照 `#add-dialog` 模子，textarea 承载 JSON 文本草稿）；成功判据 = **回执比对**
  （行 `env` / `defaultsEnv` 与草稿一致），不靠 notice。

---

### 2.13 ★ Token 池：清单状态与分配策略（2026-10-31 新增）

> 来源：用户现成的团队工具 `token_pool.py`（Redis 为主 + xlsx 导入 + 额度探测）。
> 移植时的硬要求：**放弃 Redis 依赖，改成不依赖数据库的本地方式；Redis 能力保留但降为可选。**

#### 一、池是覆盖层，不是第二份清单

原方案里池**拥有** sk。本项目里 `tokens/<name>.json` 已经拥有 sk 了（§3.1 所有权）。
再存一份 = 第二个家，且两份状态必然漂移。所以：

> **池 = 挂在既有 token 集合上的一张状态/用量覆盖层，按 token 名索引，没有一个 `sk` 字段。**

- `cmt token add` 仍是建 token 的唯一入口；`pool import` 只是"批量 `token add` + 建条目"。
- 池里出现的名字，若 `tokens/<name>.json` 不存在 ⇒ 读取时**直接丢弃**（不报错、不复活）。
- 反向不成立：有 token 没条目 = **未入池**，`pool list` 标出来，不自动补条目。

#### 二、数据模型 `pool.json`

`poolPath(home)` 加进 `core/paths.js`；**可丢弃**（删了只丢状态与用量，下次探测就回来，同 `resources.json`）。

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-31T08:00:00.000Z",
  "rr": 4,                        // 轮询游标
  "lastPick": { "C:\\work\\x": "relay-a" },  // -c 守卫用（§2.13 三·3）
  "entries": {
    "relay-a": {
      "status": "ok",             // ok|no_quota|invalid|net_fail|other|unknown
      "detail": "HTTP 200 · 812ms",
      "checkedAt": "2026-10-31T07:59:00.000Z",
      "calls": 12, "in": 32000, "out": 9000,   // 会话条数 / 输入侧（含缓存）/ 输出侧
      "usageAt": "2026-10-31T08:00:00.000Z",   // 用量是什么时候算的；'' = 从没算过
      "models": {                 // ★ 按模型分开记——花费只能从这里算（§2.13 九）
        "deepseek-flash": { "input": 12000, "cacheRead": 20000, "cacheWrite": 0, "output": 9000 }
      }
    }
  }
}
```

- ★ `models` 的每一行**恰好四个键**：`input` / `cacheRead` / `cacheWrite` / `output`，**没有 `calls`**。
  `calls` 是消息条数，摊到模型上既不可导也无人读；多一个键不会报错，只会在 `pool.json` 里
  静默多出一行噪音，而那份文件用户是要手看的。**聚合 `in` 必须恰好等于明细之和**（§2.13 九）。
- **不加锁**：沿用 §六「并发读-改-写不加锁」的既有裁决；写入仍走 `writeJsonAtomic()`，
  但**必须先读-改-写整份**（`resources.json` 被整份覆盖的坑在这里同样成立）。
- `config.json` 只加一个**不含密钥**的 `pool` 键（进 `normalizeDefaults` 白名单）：
  `{ "auto": true, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 }`。
  ★ 两个秒数**不是一回事**：`cacheSeconds` 管额度探测，`usageSeconds` 管用量重算（§2.13 九 9.7）。
- ★ **Redis 地址不进 `config.json`**：它可能带密码，而 `config.json` 是"旧版本会整份拒载"的承重文件。
  取址顺序 `--redis <url>` ＞ 环境变量 ＞ `pool.json.redis`；三者都支持 `env:VAR` 间接引用。

#### 三、启动接线（唯一会"自动挑"的地方）

1. **插入点**：`planLaunch()` 里 `resolveSession()` 之后、`planFrom()` 之前——
   **必须在拼 exec argv 之前**，因为窗口标题与 argv 都用 `resolved.tokenName.value`。
   返回 `{resolved, note}`（形状照抄 `src/cli/preflight.js`），但**不沿用它的"永不抛"**：
   `preflight` 失败只是少个模型，池挑不出来却是"这次根本没有身份"——那时必须直接报错，
   否则用户拿到的是"四要素缺 authToken"，而那句话对"我明明加了 `--pool`"毫无解释力。
   `SOURCE` 加一个 `POOL`，`run --print` / `resolve` 的来源列直接显示。
2. **触发条件**（二者之一）：
   - `resolved.tokenName.value === null` 且 `defaults.pool.auto !== false` —— **补空位**；
   - `--pool` —— **显式强制**，覆盖 binding / project / defaults 任何一层。
3. ★★ **`-c` 守卫（原方案没有，本项目必须有）**：`-c` 按 profile 续接，而 profile 名 = token 名。
   若池第二次挑了另一个 token，`-c` 会**静默开一个全新会话**——用户以为在续，其实断了。所以：
   - `resume === true` 且要挑时，**只认 `lastPick[cwd]`**；
   - 没有记录 / 那个 token 已不可用 ⇒ 报错，并给出两个出路（先显式指定 token，或不用 `-c`）；
   - 每次成功挑都写回 `lastPick`（最多 200 条，按 cwd 去重）。★ 键是**挑选之前**算出来的 cwd：
     `token.cwd` 会在挑中之后改写 `resolved.cwd`，拿改后的值当键，下一次 `-c` 就对不上。
4. **三个调用方**必须一致：

   | 入口 | 是否挑 | 理由 |
   |---|---|---|
   | `cmt run` / 面板「启动」 | ✅ | 都走 `planLaunch()` |
   | `cmt run --print` | ✅ | 「跑之前先看见」正是它存在的意义，必须显示真的会挑谁 |
   | `cmt resolve` | ❌ 只提示 | 只读诊断命令不该为看一眼发网络请求；打一行「池可提供」 |

   `--pool` 要**同时**进 argv 声明与 `toResolveArgv()`，漏一处就是静默失效。

#### 四、分配顺序与探测时序

```
候选 = 全部条目中 status ∉ {no_quota, invalid}
排序 = 按总用量升序 → 并列时按 rr 游标轮询        ← orderCandidates()，纯函数
逐个探测，遇到第一个 ok 立刻停                     ← 常态 1 次请求；TTL 内 0 次
全部失败 → 抛 CmtError，逐条列出失败原因
```

★ **「在用靠后」因子**（§2.14）：排序前，把**当前活动会话正持有的 token**（在场层）
移到候选表**末尾**——不在用的全排完才轮到在用的。它只是**排序，不是排除**：
在用 ≠ 不能用（同一 token 多开是允许的，§8 第 5 条）；在场层为空时行为与旧版一致。

**新鲜度**（沿用原方案，`core/pool.js` 纯函数 `isStale()`）：

| 上次状态 | 何时重探 |
|---|---|
| 没有 `checkedAt` | 立刻 |
| `ok` | 超过 `cacheSeconds`（默认 300） |
| `no_quota` | **跨月才重探**（月初额度自动刷新——这是原方案最关键的语义） |
| `invalid` | 24 小时后 |

- 探测 = 发**一次最小真实请求**（用户 2026-10-31 拍板）：cmt 走 `/v1/messages`，`max_tokens: 1`。
  分类：2xx ⇒ `ok`；响应含 `insufficient_user_quota` / 额度 / quota（或 402）⇒ `no_quota`；
  401 / 无效 / 认证 / invalid / unauthor ⇒ `invalid`；连不上 ⇒ `net_fail`；其余 ⇒ `other`。
- 只在**真要探**时打一行 `正在探测 3/18 …`（stderr）。`pool.auto = false` 可彻底关回今天的行为。
- ★ 探测**会花钱**（输入 + 1 个输出 token），所以 TTL + 早停不是优化而是必需。
  分配本身**不需要探测**——排序只读本地用量缓存。

#### 五、Redis：可选能力，永不当主

- `platform/redis.js` 是**通用 RESP2 客户端**（零依赖，`node:net` / `node:tls`），
  不认识"池"：`connect(url)` → `{call, close}`。支持 `redis://` / `rediss://` / `unix://`、`AUTH`、`SELECT`。
- 写穿语义照抄原方案 `MirrorBackend`：**本地写成功即算成功**，Redis 失败只 WARNING，退出码不变。
- 键前缀是各项目自己的常量（`cxmt:pool:*` / `cmt:pool:*`），**不进共享文件**。
- ★ **只有 `pool sync --redis` / `pool pull` 会连 Redis**；`check` / `run` / `pool list` 全程不连——
  这是"优先本地"的硬保证，也让没有 Redis 的环境零感知。

#### 六、批量导入（零依赖）

- `core/sheet.js`：`parseCsv()` + `parseXlsx()`，都用 `node:zlib`，**不碰 fs**。
  xlsx 走**中央目录**（EOCD 倒扫）→ `inflateRawSync` → 正则读 sheet XML；
  必须按 `r` 属性定位列（★ 实测用户的表有 200 个 `<row>` 但只有 38 个 `<c>`，**空行要跳过**）。
- 列映射：第 0 列名、第 1 列 sk；首行第二列匹配 `/^(sk|key|apikey|api[ _-]?key|密钥)$/i` 当表头。
- 已存在的名字**跳过并计数，不覆盖**（防误覆盖正在用的 key）。
- 输出只有 `新增 N / 跳过 M（已存在 X、格式不符 Y）`，**永不回显 sk**（§5）。

#### 七、网页控制台

**不新增第 6 列**（640px 已经要藏 3 列）。池状态挂进 `.r-ident` 那一栏，检测入口挂在 `.r-ops`：

- `.r-ident` 里一枚**状态丸**（原生 `<select>`，复用 `[data-color]` 那 8 个 `--st-*` 配色，
  **不新增颜色**）：既能看（六档中文 + `title` 里的 `detail` 与检测时间），也能手动标。
  配色映射：`ok` 绿 · `no_quota` 红 · `invalid` 紫 · `net_fail` 灰 · `other` 琥珀 · `unknown` 灰。
- `.r-ops` 的「检测」= op `check-token`；**没有服务端地址的行禁用**（与「拉取」同一条判据）。
- 表头「全部检测」= **前端顺序循环调 `check-token`**（服务端**不做**批量：一次探测最长 10 秒，
  18 个 token 将近三分钟——那会把整页钉在"忙"一个态，还会和 `serve-web` 的空闲计时打架）。
  循环遍历的是**点下去那一刻的视图快照**，没有地址的行跳过，页面一关就停。

**视图模型多两个键**（键集仍冻结，见 §2.12 十二）：

- `resources[].pool = {status, label, detail, checkedAt}`，**四键恒定**——没入池的那一行也是
  `unknown` / 「未检测」 / `''` / `''`，不是 `null`。
- 顶层 `poolStatuses = [{status, label}]`，顺序 = `STATUSES`（好坏顺序）。页面**只画不翻**：
  六档的中文只在 `core/pool.js` 的 `STATUS_LABEL` 里定义一处。

**两个 op 也在 `toEvent()` 之前拦**（与 `set-status` 同一条路，reducer 一行不动）：

| op | 载荷 | 行为 |
|---|---|---|
| `check-token` | `{name}` | 现探（**无视 TTL**：手动点＝"现在就看"）→ `applyProbe()` → 一次 `savePool()` → `reloaded`；`notice` = 名字 + 状态 + detail 摘要 |
| `set-pool-status` | `{name, status}` | 六档之一：`detail='manual'` + 时间戳；`unknown` = **清状态**（`detail`/`checkedAt` 清空），与 `cmt pool reset` 同义 |

⚠️ 手动标注那个 op **叫 `set-pool-status`，不叫 `set-status`**——后者已经是项目状态的 op，
同一个 dispatch 链里重名会被**静默吞掉**（先匹配到的赢，页面看起来"点了没反应"）。

★ 两条路都写 `pool-store.js`（`loadPool` + `ensureEntry` + `applyProbe`/手改 + `savePool`），
与 `cmt pool check` / `cmt pool status` / `cmt pool reset` 是**同一份实现**——面板和命令行
不可能给出两种状态。★ 两者都**只写本地**，不连 Redis（§五）。

★ 拒绝路径全部只借 `notice` 说一句话、**一个字节都不写**：没有这个 token / 认不出的状态词。

★ 资源屏还有**用量与花费**：顶部一条概览、表里两列、一个 `sync-usage` op——它们与
`cmt pool sync` 是**同一份记账**，见 §2.13 九。

#### 八、命令面

| 命令 | 作用 |
|---|---|
| `cmt pool list` | 所有 token + 状态 + 用量；有 token 无条目标「未入池」 |
| `cmt pool import <file.csv\|xlsx>` | 批量建 token + 建条目 |
| `cmt pool check [name...] [--all] [--force]` | 探测；不带参数 = `--all`；`--force` 无视 TTL |
| `cmt pool status <name> <status>` | 手动覆盖（`detail` 记 `manual`） |
| `cmt pool reset <name>` | 清状态（回到 `unknown`） |
| `cmt pool sync [--redis <url>]` | 从会话记录重算用量；带 `--redis` 时写穿 |
| `cmt pool pull --redis <url>` | 反向：把 Redis 里的状态拉回本地 |

`pool` 与既有 `token` 是**两个命名空间**，别混：`token` 管身份与密钥，`pool` 管状态与分配。

#### 九、用量与花费：记录 → 计算 → 呈现

**一句话：`pool sync` 把会话记录里的用量按模型记进 `pool.json`，价格三级取，
资源表因此才有「用量 / 花费」两列和一条概览。它不必等人按——面板打开与
`pool list` 会按 `usageSeconds` 顺手重算一次（9.7）。**

参考对象是 `clash_proxy` 的 `cmd_status`（概览块）/ `cmd_stats`（明细表）/ `cmd_netcheck`
（概览 + 一条 💡 提示）——**概览与明细两处口径必须同源**，那是用户最初的要求。

##### 9.1 记账：`syncPoolUsage()`，只此一处

`src/cli/pool-usage.js` 的 `syncPoolUsage(ctx, pool, now)`，**命令行 `pool sync` 与网页
「重算用量」共用**。两处各写一份的话，"页面上说花了 3 块、命令行说 5 块"没有任何报错，
只有人把两张表摆在一起才会发现。

它写 entry 上的两个字段（形状见 §二 的 JSON）：`models` 与 `usageAt`。四条不变式：

| 不变式 | 破了会怎样 |
|---|---|
| **聚合 = 明细之和**：`in` = 各模型 `input+cacheRead+cacheWrite`；`out` = 各模型 `output` | 页面与命令行各算一遍，**静默**对不上 |
| **重算是覆盖，不是累加** | 连跑两次翻倍，而第二次看起来完全正常 |
| **没 model 的记账落进 `（未知模型）`** | 那部分花费从总额与明细里**一起消失**，且什么都不报 |
| **只算 `pool.entries` 里有的名字**；池外 profile 与未托管的 `~/.claude/projects` 一律不算 | 未托管那份被算进来就翻倍；池外的会凭空多出一个条目 |

★ 目录发现与解析复用 `usage-sources.js` + `core/usage.js`——与 `cmt usage` 同一份。
★ `usageAt` 取一次、**整批共用**：同一次重算算出来的数，就该有同一个时刻。
★ 入了池但一份记录都没有 ⇒ 归零 + 照样盖 `usageAt`——**"0 用量"与"从没算过"必须能区分**。

##### 9.2 花费：价格三级，绝不说免费

`costOf(tokens, price)`（`core/prices.js`），`PRICE_UNIT = 1_000_000`（USD / 百万 token）。
价格三级、**优先级从高到低**（与 `cmt usage` 完全同源，见 §2.12 十二 价格小节）：

1. **`prices.json`**（手写结算价）
2. **`resources.json` 里端点自报的 `pricing`**（挂牌价）
3. 都没有 ⇒ **`—`**，**绝不冒充 `$0`**

- **①永远压过②**：用户写的实际结算价不能被网关挂牌价默默盖掉。
- `costOf()` 在没有价格时返回 **`null`，不是 0**——`$0` 会说"免费"，那是谎话。
- ★★ **价格逻辑不许进 `core/pool.js`**：那个文件与 cxt **逐字一致**，而 `core/prices.js`
  **不是**共享文件。⇒ `summarizePool()` 只把**已经算好的 `cost` 数字**加起来，
  它不认识价格、不认识模型。价格在这一层之上算（§9.3）。
- ★ **取价只有一处实现**：把 `commands/usage.js` 里的 `loadPrices()` + `loadEndpointPrices()`
  + 三级合并提成 `loadPriceTable(ctx)`，`usage` 与面板**都调它**。两份各拼一遍，
  就是"同一个模型在两个页面两个价"——而那不会有任何报错。

##### 9.3 每一行的 `usage`（`buildPanelData` 算，进视图模型）

```js
{ calls, in, out, cost, unpriced, syncedAt }   // 六个键恒定，没有第七个
```

- 输入是 entry 的 `models` + 价格表：逐模型 `costOf()` 后相加。
- `cost` = **这一行已定价部分之和**；`null` = 这一行**一个模型都查不到价**（渲染 `—`）。
- `unpriced` = 有用量、但查不到价的**模型个数**（不是 token 数）。
- `syncedAt` = entry.`usageAt`（`''` = 还没算过）。

##### 9.4 概览 `resourcesSummary`（顶层视图模型键）

`summarizePool(rows, now)`（`core/pool.js`，**纯函数，页面只画不翻**）：

```js
{ total, counts, calls, in, out, cost, costPartial, unpriced, syncedAt, insights }
```

- `counts` = `[{status, label, count}]`，顺序 = `STATUSES`（好坏顺序），**只留 `count > 0` 的**。
- **`cost` 的三条规矩**（与 `usage` 同源）：没有任何用量 ⇒ `null`；有用量但一个模型都没价
  ⇒ `null`；部分无价 ⇒ 数字是**下限**，`costPartial: true`（渲染成 `$0.42+`，不是 `$0.42`）。
- `insights` **最多两条**（当前 6 条规则见 `buildInsights()`）。全给出来等于没给——
  概览条只有一行，第三条一定被挤掉，而用户不知道还有第三条。

##### 9.5 网页：概览条 + 两列 + 一个 op

- **概览条**钉在资源屏顶部：`total` / `counts` / `calls` / `in` / `out` / `cost`
  （`costPartial` 时加 `+`）/ `syncedAt`，后面跟至多两条 `insights`。
- 表格新增**两列**「用量」「花费」（列已经很多，折叠规则沿用既有那套）；
  花费 `null` 时写 `—`，`syncedAt` 为空时写「未算过」。
- **`sync-usage` op**（载荷 `{}`）：`loadPool(ctx)` → `syncPoolUsage()` → `reloadPanel()`；
  `notice` = 重算回执（`N 个 token · 读了 M 份记录`）。★ 与 `check-token` / `set-pool-status`
  同一条路：**在 `toEvent()` 之前按 `body.op` 拦下**，reducer 一行不动。
- **不新增颜色**（状态色仍是既有 `--st-*`）。

##### 9.6 键集冻结：这是跨项目接口

新增的 `resources[].usage` 与顶层 `resourcesSummary` **都是视图模型键**（§2.12 十一 的
"键集冻结"管着它们）。⇒ **两个项目 + 两份契约 + 两边的黄金形状断言一起改**；
在一边加、另一边没加，失败只会发生在**没加的那一边**。

##### 9.7 什么时候重算：`usageSeconds` + 增量缓存

9.1～9.6 里 `sync` 只由人按。实际用起来才知道那不够——用量是个一直在长的数，
而人不会每次开页面都记得按一下。所以补两件：**到点自己算**、**没变过的文件不重读**。

**触发点（五个，两种时机）**：

| 谁 | 什么时候 | 无条件 / 过期才做 |
|---|---|---|
| `cmt pool list` | 开局 | 过期才做 |
| 面板（`cmt ui`） | `commands/ui.js` 的 `run()`，**一次** | 过期才做 |
| 网页控制台（`cmt ui --web`） | `commands/ui-web.js` 的 `runWeb()`，**一次** | 过期才做 |
| 网页「重算用量」 | `sync-usage` op（9.5） | 无条件 |
| `cmt pool sync` | 命令行 | 无条件 |

- ★ **`autoSyncUsage()` 只在启动路径上调一次，绝不放进 `buildPanelData()`**：后者每次
  `reloaded` 都跑（切个 tab、点个按钮），放进去等于"每按一下就扫一遍 transcript"。
- ★ **`runPlain` 不调**（`ui/render.js` 里一个 `usage` 都没有）：`--json` / 纯文本是给脚本读的，
  顺手写盘会让同一条命令在两次运行之间悄悄变样。
- `autoSyncUsage()` **永不抛**：整段包在 `try/catch` 里。失败就是"这次没算成"，面板照常显示
  旧数字＋旧的 `usageAt`——因为算用量失败而打不开面板才是更坏的结果。
  返回 `null` = 什么都没做（空池 / 全部新鲜 / 出错），**不是错误**。

**「过期」= `usageStale(entries, now, opts)`**（`core/pool.js`，纯函数，进共享清单）：

| 情形 | 算不算过期 |
|---|---|
| 空池 / 不是对象 | **不算** |
| 任何一条 `usageAt` 为空、解析不出、或在未来 | 立刻 |
| 任何一条距今超过 `usageSeconds` | 立刻 |
| 全部新鲜 | 不算 |

- ★ **是「任何一条」不是「全部」**：池里只要还剩一条旧账，就整池重算——因为
  `syncPoolUsage()` 本来就是**全池覆盖**，它不是增量记账器。
- ★ **`usageSeconds` 默认 600，与 `cacheSeconds`（300）是两个数、两种用途**：300 管的是
  **额度探测**（发真请求、可能花钱），600 管的是**读本机文件重算**（不花钱，只花 IO）。
  合成一个数的话，要么探测太贵、要么用量太旧。
- 空池返回 `false` 是有意的：`autoSyncUsage()` 靠它早退，不必自己再判一遍。
- 配置：`config.defaults.pool.usageSeconds`，schema 校验为**正整数**；`poolSettingsOf(ctx)`
  读不到就退回默认，**不抛**。

**增量缓存：`pool-usage-cache.json`（`poolUsageCachePath(home)`）**

重算要扫整份 profile 目录——实测 67 份、813 MB，`pool list` 每次全读是不能接受的。

```jsonc
{ "version": 1,
  "files": { "<绝对路径>": { "size": 1234, "mtimeMs": 1.7e12, "calls": 3, "models": { … } } } }
```

- **命中判据 = `size` 与 `mtimeMs` 一起相等**。两个一起变才叫"文件动过"；单独一样变也重读
  （宁可多读一次，不许漏算一轮）。
- ★★ **缓存里只有 `calls` / `models`，没有 `in` / `out`**。存了聚合数就是第二处真相：
  哪天对不上，「聚合 = 明细之和」（9.1）就没有任何东西守着了。这一层**只存原料**，
  `in` / `out` 永远在合并时现算。
- **只留这一轮见过的文件**：`tokens/` 里删掉的 profile，它的记录也跟着从缓存里消失——
  否则这份缓存只增不减。
- **读缓存永不抛**：半截 JSON / 形状不对 / `version` 对不上，一律当"没有缓存"、照常全读；
  写缓存失败也吞掉。缓存坏了是慢一点，不是算错。
- 缓存**可以随时删**：删了只丢速度、不丢数。（与 `pool.json` 不同——那份丢了要重新探测。）
- 收尾回执里 `filesRead` / `filesCached` 分开报：前者是"真读了几份"，后者是"省了几份"。

**`sync --force`**：不信缓存、全部重读。★ 它**不改变算出来的数，只改变"读了几份"**——
要是它改变了数，说明命中判据本身有洞。

---

### 2.14 ★ 会话在场层与消息信箱（2026-11-04 新增）

**一句话：每个窗口在启动时留下一条记录，并可以给对方留一张纸条——纸条是惰性数据，工具永不因它行动。**

> 参考 `deepseek-ai/dsh-superagent-prototype` 的域设计（Ticket 自有状态 / 惰性消息 / 授权与上下文分离），
> 但**只抄纪律、不抄形状**：那套是单 Engine + SQLite 的中心化总线，本工具是点对点文件——不引 daemon、
> 不加锁、不加 LLM 路由器（§1.4 不 hook、命令跑一次，不是后台常驻）。

#### 一、在场层：`sessions/<id>/meta.json`

- 目录在**状态根**下：`~/.claude-multi-token/sessions/<id>/`。
  ⚠️ **与 `profiles/<t>/sessions/` 无关**——那个是 Claude Code 的会话历史（Claude Code 所有，§3.1），
  这里的是 cmt 自己的在场记录。**同名不同物**，文档与代码里不许混用。
- **写者是 `cmt exec`，而且只有它**（`recordSessionStart` / `recordSessionEnd`）：
  - 启动时写 `{v:1, id, token, cwd, pid, startedAt, endedAt:null, exitCode:null, model}`；
  - 正常退出时**读-改-写**补 `endedAt` 与 `exitCode`；
  - ★ **写失败绝不阻塞会话**：整段 try/catch，stderr 一行警告，会话照常启动。
    在场层是锦上添花，不是承重件——它坏了不许让窗口打不开。
- ★★ **meta 永不记 argv**。`cmt exec` 的 `--token-value` 是明文 sk（§5）；这里只记
  `token` 名 / `cwd` / `pid` / 时间 / `model` 五类**安全字段**。
  与 §3.1「池不含 sk」同源：在场层也是一个覆盖层，**不是第二个密钥落盘点**。
- **id 形状**：`<profile 名>-<base36 时间>-<pid>`。可读、可按时间排序、逐次唯一。
- **`-c` 续接不受影响**：续接是 `claude -c` 的语义（按 profile + cwd，§2.5），
  与在场层无关；在场层只回答"现在有哪些窗口开着"。

#### 二、活性判定与它的边界

三态，读时现算（**不落盘状态**——落盘就多一个会过期的真相）：

| 态 | 判据 |
|---|---|
| `live` | `endedAt` 为空 **且** `process.kill(pid, 0)` 说得通（EPERM 也算活） |
| `ended` | `endedAt` 非空（正常退出，带 `exitCode`） |
| `dead` | `endedAt` 为空但进程已经没了（崩溃 / `kill -9` / 终端被关） |

★ **pid 复用是已知风险**：Windows 的 pid 会被快速复用，一个 `dead` 的旧会话可能因为
pid 恰好被别的进程占用而被报成 `live`。评估：`cmt sessions` 是给人看的概览，
**不是审计凭证**；`startedAt` 与 id 里的时间戳让人能看出真伪。要精确需比对进程启动时间，
**本期不做**，如实记录在这里（§8 第 19 条）。

#### 三、消息信箱：一消息一文件，惰性数据

```
sessions/<id>/inbox/<ms>-<rand>.json   # 未读
sessions/<id>/read/<ms>-<rand>.json    # 已读：同目录 rename 进来（原子）
```

- 消息形状：`{v:1, id, ts, from:"human"|<sessionId>, to, type:"info"|"action-request", body}`。
- **写 = `writeJsonAtomic`；读 = rename**（同目录原子）。「已读」不是一个字段，是文件的位置。
- ★★ **消息是惰性数据：工具自己永不因消息行动。** 没有 daemon、没有 hook、没有"收到消息就
  投进某个会话"（那要写 settings.json / 改 agent 本体，§3.1 禁止）。
  唯一送达方式：**人告诉 agent「去看一下信箱」→ agent 自己跑 `cmt msg inbox`**。
  这是「执行权只经人、永不因投递产生」在 v1 的可执行形态——
  `type: "action-request"` 只是给**读者**的标注，不产生任何执行权。
- **发送者识别**：`cmt exec` 把 `CMT_SESSION_ID` 注入 agent 环境（§2.6 注入表加一行，
  净化表同样加一行——嵌套 `cmt run` 不许继承父会话的身份）。
  `cmt msg send` 读到该变量且会话仍 `live` ⇒ `from` = 会话 id；否则 `"human"`。
- **回环刹车（v1 靠结构，不靠计数）**：没有自动转发、没有自动回复，A 让 B 回消息需要
  两次人工动作，**回环物理上不存在**。`observe` / `auto` 放量档**不在 v1**：它们的前提是
  存在一个"会自动读信箱并回复"的执行体，而本工具按 §1.4 不内置任何执行体。
  将来先有执行体，再按 dsh 的 off→observe→auto 顺序引入；**不预先实现空开关**
  （一个不驱动行为的设置比没有更糟）。

#### 四、命令面

| 命令 | 作用 |
|---|---|
| `cmt sessions [--json]` | 列出全部会话（live / ended / dead 三态 + 未读数） |
| `cmt sessions prune [--older-than 30d] [--force]` | 删 `ended`/`dead` 且超龄的会话目录；**有未读时拒绝，`--force` 才放行** |
| `cmt resume <id前缀>` | 恢复 `ended`/`dead` 会话：同 token、同 cwd、带 `-c` 开新窗口；**live 拒绝** |
| `cmt msg send <id前缀\|--token <t>> [--type info\|action-request] <文本...>` | 投一条消息（只投给 **live** 会话；`--all` 广播） |
| `cmt msg inbox [--session <id>] [--peek] [--json]` | 看信箱；默认看自己的（在会话内）或全部 live（在会话外）；**默认读完即标记已读** |
| `cmt msg gc [--older-than 7d]` | 清理超龄消息（inbox 与 read 都算） |

- 消息与在场记录**都可丢弃**：删了不损坏任何东西——这是它们的可重建级别（§3.4）。
- `msg send` 的目标解析不出 live 会话 ⇒ **报错**（不是静默丢弃）：用户敲了命令，
  就必须知道纸条有没有送到。
- 输出**只打印 token 名 / 会话 id / 时间**，消息体原样打印——
  ⚠️ 文档要警告：**不要把密钥贴进消息**（消息是明文 JSON，与 `pool.json` 同一地位）。

#### 五、网页控制台

资源屏顶部一条**会话条**：live 会话一行一个（token、cwd 末段、状态点、未读徽章），
全部健康且无未读时折叠成一行计数；`ended`/`dead` 不出现（它们只进 `cmt sessions`）。
视图模型加顶层 `sessions` 键（**键集冻结**，两边 + 黄金断言 + 两份契约一起改，§2.12 十一 / §8 第 17 条）。
「全部标已读」走旁路 op `msg-read-all`（`{session}`），成功 `reloadPanel`——
与 `set-status` 同一条路：**在 `toEvent()` 之前拦下**，reducer 一行不动。

会话条下方还给**最近关闭**（24 小时内、至多 5 条）一条恢复入口：有未读的逐行显示，
其余折成一行「恢复最近的」。恢复 = 同 token、同 cwd、带 `-c` 开新窗口
（旁路 op `resume-session`，与 `cmt resume` 同一实现 `resumeSession()`）。
浏览器标题显示**未读总数**；页面在**可见时**每 10 秒以盘为准重拉一次
（切到后台即停——控制台的空闲退出靠"没人请求"，不许被一个遗忘的标签页钉住）。

列表顶部还有一块**「需要你处理」**（`attention[]` 视图键）：把三类信号合成一张清单——
① `token-bad`：live 会话正在用的 token 在池里已废（`no_quota` / `invalid`）；
② `mail`：有未读纸条的会话（已关闭的排前面、severity `high`，live 的 `normal`）；
③ `exit-fail`：最近关闭但退出码非 0 的会话（有未读的不重复出现）。
★★ **每一条连同动作一起由服务端算好**（`actions:[{label, op, args}]`，至多两个）：
页面只照单画按钮、不做任何判断——**加一种新信号 = 只改服务端，前端一行不动**。
至多 5 条；全部健康时是空数组，整块不显示（页面没有"空状态"）。
动作全部复用既有旁路 op（`check-token` / `msg-read-all` / `resume-session`），没有新 op。

#### 六、v1 不做（写在这里，防止被当作"漏了"）

- **自动投递 / 自动回复 / observe→auto 放量**：需要自动执行体，v1 没有（见第三节）。
- **跨工具总线（cmt ↔ cxt）**：两个状态根互不相认；与 §8 第 9 条「是否合并」同一条边界。
- **消息线程 / reply / hops 自动转发**：v1 消息是平的，靠 `ts` 与 `from` 读上下文。

---

## 三、文件夹创建与管理策略

### 3.1 所有权三分类（最重要的表，违反即 bug）

| 路径 | 所有者 | cmt 的权限 |
|------|--------|-----------|
| `config.json`、`projects.json`、`tokens/*.json` | **cmt** | 读写 |
| `pool.json`（§2.13） | **cmt** | 读写。★ **不含任何 sk**——它是挂在 `tokens/*.json` 上的状态/用量覆盖层 |
| `sessions/**`（§2.14） | **cmt** | 读写。★ **不含任何密钥**——只记 token 名 / cwd / pid / 时间；消息体是用户自己写的文本 |
| `profiles/<t>/launch.{cmd,sh}` | **cmt** | 写（每次 run 重生成） |
| `profiles/<t>/.claude.json` | **Claude Code** | ⚠️ **唯一例外**：`defaults.seed` 开启时**只增不改**（§3.6） |
| `profiles/<t>/` 下**其余一切**（含 `settings.json`） | **Claude Code** | ❌ 绝不写、绝不删、绝不改 |
| **用户项目里的 `.cmt.json`** | **用户** | ⚠️ **新的一类**：**只在被要求时写**（面板向导第 4 步，§2.12 四），**绝不自动创建**（§2.11 六） |
| **网页控制台**（§2.12 十一）的端口与路径口令 | **没有人** | ❌ **不拥有任何文件**——只在内存里。无状态文件、无缓存、无锁；进程一关就没了 |

> ★ 最后一行是**故意**的：控制台唯一会写的文件就是 `config.json` / `projects.json` /
> `tokens/*.json` / `.cmt.json`——走的是**既有**的 `writeJsonAtomic()`，**不是它自己的一套**。
> 所以"控制台有没有多出一个真相源"这个问题，答案是**没有**。

> ★ 最后一行是 §2.11 引入的第四类所有权，与上面四行**都不同**：前三行都在
> `~/.claude-multi-token/` 里（那是 cmt 自己的地盘），第四行在**用户的仓库**里。
> 在别人家里，默认动作只能是"什么都不做"——所以它没有"首次 run 时顺便建一个"这种路径。
> `cmt model set --path` 是唯一的例外通道（§2.11 五）：那是**你指名要改这一层**，
> 与"cmt 觉得这里该有一个"是两回事。

> **铁律：cmt 不写 Claude Code 的任何配置文件。** 环境注入走进程环境变量，不走改配置文件。
> 这条保证 cmt 不会随 Claude Code 配置格式演进而碎掉。
>
> **唯一的例外是 `profiles/<t>/.claude.json`，且必须由用户显式开启**（`defaults.seed`，
> 默认 `"off"`）。理由不是"图方便"，而是**没有第二条路**：Claude Code 的首次引导闸门
> 只读这个文件，settings 的五个层、命令行标志、全部 570 个 `CLAUDE_CODE_*` 环境变量里
> **一个开关都没有**（§7.6 是逐条查证的结果）。想让新 profile 零点击，就只能写它。
>
> 例外被三条不变量箍死，`seedProfile()`（`core/store.js`）逐条实现、`tests/seed.test.js` 逐条钉住：
>
> 1. **只增不改**：只补缺失的键。已存在的键——尤其是 `hasTrustDialogAccepted: false`
>    这种**明确的拒绝表态**——一个字节都不动。替用户推翻他自己的安全决定，而 `cmt exec`
>    的 stderr 又会被 TUI 盖掉（§2.4），那必然是静默的。
> 2. **幂等**：补完即静默。第二次启动退化成纯读取，文件字节不变——所以"每天开十次"与"开一次"
>    对磁盘的影响相同，也让"播种出问题"只可能发生在首次。
> 3. **绝不复制 `~/.claude.json`**：不搬 OAuth 会话、不搬个人 MCP、不搬别的项目的信任记录。
>    只写 §7.6 那九个字段的最小骨架。**这不是"跳过引导"，是"替用户回答那两个问题"**——
>    多搬一样东西，隔离不变量（§1.3 第 2 条）就破了。
>
> **`settings.json` 不在例外里，将来也不该在。** 主题与 `skipDangerousModePermissionPrompt`
> 确实也住在 Claude Code 的文件里（后者不写就会弹 bypass 警告），但那些是**设置**——
> 有公开 schema、有五层级联、用户随时会在会话里改。写它们等于 cmt 与用户在同一个文件上
> 长期争夺，而 `.claude.json` 的那九个字段是**一次性的**：写对了，Claude Code 从此自己维护。
> 真要覆盖设置，正确的路是 `--settings <cmt 自己的文件>`（§7.4 的按键覆盖，不落盘到 profile），
> **不是**往 profile 里写 `settings.json`。

### 3.2 创建时机（惰性，绝不预建空目录）

| 触发 | 创建 |
|------|------|
| `cmt token add` / `cmt bind` | 根目录、`config.json`（若无）、`tokens/<t>.json` |
| 首次 `cmt run <t>` | `profiles/<t>/`、`launch.*` |
| 首次 `cmt exec <t>`（**仅 `defaults.seed` 开启时**） | `profiles/<t>/`、`.claude.json`（§3.6） |
| `cmt pool import` / `cmt pool check` / 首次成功从池里挑（§2.13） | `pool.json` |
| 每次 `cmt exec`（§2.14） | `sessions/<id>/meta.json`（写失败只警告，不阻塞启动） |

> 播种那一行与"惰性"不冲突：它排在 `locateClaude()` **之后**（§2.7），
> 也就是说只有"claude 找得到、这次注定要启动"时才会建目录。

### 3.3 删除与防误删

- `cmt token rm <t>` **默认只删** `tokens/<t>.json`——profile 里有登录态和会话历史，**保留**。
- `cmt token rm <t> --purge` 才连 `profiles/<t>/` 一起删，且需二次确认（`--yes` 跳过）。
- `cmt token rm <t>` 若该 token 仍被 `bindings` 引用 → **警告并列出引用它的路径**，不静默留悬空绑定。
- **任何情况下都不删 `~/.claude/`**（用户主配置）。

### 3.4 可重建性分级

| 级别 | 内容 | 处置 |
|------|------|------|
| 不可重建 | `tokens/*.json`（token 本身）、`profiles/*/`（会话历史） | 删除需显式确认 |
| 可重建 | `profiles/*/launch.*` | 可随时删，下次 run 自动重建 |
| 可重建 | `pool.json`（§2.13）——只丢状态与用量缓存 | 删了下次 `pool check` 就回来；⚠️ 但 `lastPick` 一起没了，`-c` 需重新指定 token |
| 可重建 | `sessions/`（§2.14）——只丢在场记录与未读纸条 | 删了下次启动重新出现；`sessions prune` 遇未读要求 `--force` |

### 3.5 写入纪律

- 所有 JSON 写入走 `writeJsonAtomic()`（临时文件 + `rename`），杜绝半截文件。
- 目录创建统一走 `ensureDir()`（`mkdir -p` 语义）。
- 新写文件在 POSIX 下 `chmod 0600`（含 token 的文件）；Windows 依赖用户目录 ACL，README 说明差异。
- 路径**只能**从 `core/paths.js` 取，禁止在别处硬编码 `~/.claude-multi-token`。
- **并发读-改-写不加锁**（单用户 CLI，接受此风险）。`writeJsonAtomic()` 只保证**不产生半截文件**，
  **不保证不丢更新**——两个窗口同时 `cmt model next` 可能互相覆盖。
  真要并发安全再引入锁文件，**本期不做**，但别误以为原子写等于并发安全。
- **`version` 不匹配的处理**：读到**更高**版本的 `config.json` → 拒绝启动（退出码 2）并提示升级 cmt；
  读到**更低**版本 → 自动迁移，迁移前把原文件备份为 `config.json.v<旧版本>.bak`。
  绝不静默按当前 schema 解析未来格式。

### 3.6 启动前播种（§3.1 铁律的唯一例外）

**问题**：空 profile 首次启动会走主题选择 + 工作目录信任确认，每 token 一次。
这两个对话框**挡住启动**——用户得坐在那儿点，而 cmt 的卖点恰恰是"开窗即用"。
更糟的是 `cmt run` 是无状态的（§2.7 步骤 4），它**没法知道**哪些 profile 已经点过了。

**开关**：`defaults.seed`，三档，**默认 `"off"`**。

| 档 | 补什么 | 用途 |
|----|--------|------|
| `"off"` | 什么都不做 | 默认。不写文件、不建目录，连读都不读 |
| `"onboarding"` | `hasCompletedOnboarding: true` | 只跳主题选择（纯 UI 状态，零安全含义） |
| `"full"` | 上面 + 当前目录的 `hasTrustDialogAccepted: true` | 零点击启动 |

**默认为什么是 `"off"` 而不是 `"onboarding"`**：升级 cmt 不该悄悄改变已装机的行为，
而"要不要让 cmt 替你动 Claude Code 的文件"必须由用户说出口。想零点击就显式写 `"full"`。

**实现分两半，这个分界是刻意的**：

- `core/seed.js` 的 `planSeed({ current, cwd, mode, platform })` —— **纯函数**：
  不碰 fs、不读 `process.*`、不 spawn（§4.2）。输入当前内容，输出 `{ changed, next, added }`。
  `added` 是**给人看的**变更清单（`projects["C:/x"].hasTrustDialogAccepted`），
  让"播种到底动了什么"永远可回答——这个特性一旦出错是静默的（键写歪了只是不生效）。
- `core/store.js` 的 `seedProfile({ home, profile, cwd, mode, platform })` —— 只管 IO，
  且**从不抛错**，失败只回一个 `warning`。播种是锦上添花：磁盘满 / JSON 坏了，
  正确的结局是"弹一次对话框"，不是"窗口打不开"。

**写什么**（`mode: "full"`，全新 profile）：

```jsonc
{
  "hasCompletedOnboarding": true,
  "projects": {
    "<projectKey(cwd)>": {
      "allowedTools": [], "mcpContextUris": [], "mcpServers": {},
      "enabledMcpjsonServers": [], "disabledMcpjsonServers": [],
      "hasTrustDialogAccepted": true,
      "hasClaudeMdExternalIncludesApproved": false,
      "hasClaudeMdExternalIncludesWarningShown": false
    }
  }
}
```

**不写 `lastOnboardingVersion`**：它在二进制里是对象字面量、落盘却是字符串
（本机实测 `"2.1.251"`），说明写它的路径不止一条，形态不可靠。
而 `hasCompletedOnboarding` 单独就够了——本机实测：用户主配置里该字段为 `true`
而 `lastOnboardingVersion` 停在 `"2.1.156"`，二进制已升到 2.1.251，跨版本升级再没见过向导。

**键的形状**（`projectKey()`，与 Claude Code 的 `vS(t,{foldCase:false})` 对齐）：

1. `.normalize('NFC')` —— 与 §2.9 三同理
2. `\` → `/`
3. **保留大小写**。⚠️ `foldCase` 默认是 `true`，但那是给**比较**用的（`oy()`），
   **存储用 `false`**。本机 68 个真实键 68/68 保留原大小写、0 个含反斜杠、
   0 个小写盘符——写小了就是一个**永远不命中**的键，而症状只是"弹窗照旧"。

复用已有键时**大小写不敏感地找**（Windows）：Claude Code 可能写的是 `c:/work/a`
而我们算出来是 `C:/work/A`，不复用就会得到两份指向同一目录的条目——
**我们写的那份被无视，弹窗照旧**。Linux 则大小写敏感，两个拼写是两个目录。

**并发护栏（`seedProfile` 里，别删）**：写入前**重读一次**，与手里的快照比对，
不一致就撒手（回 `raced`，不算失败）。因为**`writeJsonAtomic()` 挡不住这个**——
它保证不产生半截文件，**不保证不丢更新**（§3.5 明写）。原子 ≠ 并发安全。
Claude Code 可能正在写同一个文件，拿旧快照覆盖会抹掉它刚写的东西。

**备份**：首次播种前留一份 `.claude.json.cmt.bak`，**只留一次**（不覆盖已有备份）。
改的是别人的文件，出事时得能原样退回去。

**验证方式（真机实测过，别再重新发明）**：让 `cmt exec` 配一个**假 claude**
（`--claude-bin <一个打印完就退的 .cmd>`）——真 Claude Code 从没跑过，
于是 profile 里留下的字节**只可能是 cmt 写的**。判据是那些 Claude Code 启动时
才会写的字段（`numStartups` / `userID` / `machineID` / `firstStartTime`）**一个都不在**。

---

## 四、代码结构

### 4.1 仓库布局

```
claude-multi-token/
├── CLAUDE.md                    # 本文件（架构契约）
├── README.md / README.zh-CN.md  # 面向用户：英文为主 + 中文
├── package.json                 # bin: { cmt: "./bin/cmt.js" }, dependencies: {}
├── bin/cmt.js                   # 入口（shebang，只做转发）
├── src/
│   ├── cli/
│   │   ├── main.js              # 命令分发（★ 只读 process.* 的标量：argv / isTTY / env / cwd）
│   │   ├── parse-args.js        # 自写参数解析（不用 commander）
│   │   ├── format.js            # 终端对齐（CJK 算 2 列）+ 脱敏 + makePainter（§5）
│   │   ├── session.js           # ★ 三命令共用的装配 + 两道启动闸门（§2.1 / §2.4）
│   │   ├── claude-bin.js        # 定位 claude 可执行文件（§2.10 末）+ cmd.exe 套壳（CVE-2024-27980）
│   │   ├── help.js              # 用法文本
│   │   ├── types.js             # Ctx / Command 的 JSDoc 类型
│   │   ├── pick.js              # `--pick` 的极简行式 TUI（§2.5）；`CMT_UI=plain` 也复用它
│   │   ├── probe.js             # ★ §2.13 额度探测：发一次最小真实请求（**会花钱**，只在 check / 启动前挑时跑）
│   │   ├── pool-pick.js         # ★ §2.13 启动前挑 token（I/O 层，形状照抄 preflight.js）
│   │   ├── ui/                  # ★ 全屏面板内核（§2.12）。前三个是纯函数，第四个不是
│   │   │   ├── keys.js          #   字节流 → 按键事件。逐字节可中断状态机，**不是对 chunk 跑正则**
│   │   │   ├── render.js        #   (state, {cols,rows}) → {frame, cursor}；含 frameWidth / fitLine / layout / scrollTop
│   │   │   ├── app.js           #   reducer：(state, key) → {state, effects}
│   │   │   └── term.js          #   ★★ `cli/ui/` 里唯一碰 process.stdin/stdout 的文件（§4.2）
│   │   │                        # ★★ 这四个文件与 `cxt` 的同名文件**逐字一致**（§8 开放问题 10）。
│   │   │                        #    改一个必须改另一个。验证手段就是 `diff`，它必须**空**。
│   │   │                        #    ⇒ 凡是"两个工具不一样"的东西，**一律不许出现在这四个文件里**：
│   │   │                        #      ① 工具名 / 项目配置文件名 → 从 `PanelData.appName` / `.projectFile` 进来
│   │   │                        #      ② 环境变量名 → 由**调用方**解析成值再传进 `runPanel(io)`；
│   │   │                        #         `term.js` 不认识 `CMT_UI_COLS` / `CMT_UI=plain` 这些**名字**
│   │   │                        #      ③ 契约的**父节号**（cmt §2.12 / cxt §2.14）→ 一律写成
│   │   │                        #         「面板 §五」这种**节名 + 子节号**；两份契约的子节号逐条相同，
│   │   │                        #         父节号不同（§7.8 / §7.17 同理，写「TUI-Win M6」）
│   │   └── commands/            # resolve / run / exec / bind / token / model / slot / ls / profile / doctor / ui / ui-web / usage / pool
│   │       └── pool.js          # ★ §2.13 token 池：list / import / check / status / reset / sync / pull
│   ├── core/                    # 领域层：纯逻辑，无 IO 副作用
│   │   ├── paths.js             # ★ 全部路径常量（唯一来源）
│   │   ├── store.js             # 配置读写 + writeJsonAtomic + seedProfile（★ core 里唯一碰 fs 的）
│   │   ├── schema.js            # 数据结构定义与校验（含 token 名 / 路径穿越校验）
│   │   ├── seed.js              # ★ 启动前播种的纯规划器（§3.6）：不碰 fs、不读 process.*
│   │   ├── project-config.js    # ★ §2.11 的受限 schema + 禁键表 + 向上发现
│   │   ├── bindings.js          # ★ 路径绑定：归一化 + 最长前缀匹配
│   │   ├── models.js            # ★ 优先级列表运算：轮转 / 提拔 / 槽位（§2.5 工作流）
│   │   ├── models-endpoint.js   # ★ §2.12 六：`/models` 的 URL 拼装与响应解析（纯）
│   │   ├── resolve.js           # ★ 四要素解析级联（§2.3）+ buildInjection / stripSessionMarkers / buildSessionEnv（§2.6）
│   │   ├── validate.js          # 四要素完整性校验（§2.1）
│   │   ├── launch-script.js     # 兜底产物：生成 launch.cmd / launch.sh（§2.10）
│   │   ├── pool.js              # ★ §2.13 池的纯逻辑：状态词表 / isStale / classifyProbe / orderCandidates
│   │   ├── sheet.js             # ★ §2.13 批量导入：parseCsv + parseXlsx（零依赖，node:zlib）
│   │   └── errors.js            # 错误类型 + 退出码
│   │                            # ★ `pool.js` / `sheet.js` 与 `cxt` 的同名文件**逐字一致**（§2.13）；
│   │                            #   同理：只抛裸 `Error`，错误类型在各自的 CLI 层翻译
│   └── platform/                # 平台适配：唯一知道具体终端的地方
│       ├── index.js             # detectTerminal() / spawnTerminal() / resolveTerminal() / findExecutable() / fetchModels() / serveWeb() / openBrowser() / openPath()
│       ├── fetch-models.js      # ★ §2.12 六：`/models` 的网络代码（fetch + Bearer + 超时）
│       │                        #   ⚠️ 它不再是**唯一**的网络代码——另有 §2.13 的 `cli/probe.js`
│       ├── serve-web.js         # ★★ §2.12 十一：**唯一 import `node:http` 的文件**。回环 + 路径口令 + 那 14 条控制
│       ├── open-browser.js      # ★ §2.12 十一：开窗口（Chrome/Edge `--app=` 优先，退回默认浏览器）
│       ├── open-path.js         # ★ §2.12 十一：在文件管理器里打开目录（三平台都 `[目录]` 一个参数，不过 shell）
│       ├── redis.js             # ★ §2.13 手写 RESP2 客户端（tcp/tls/unix）。**从不当主存储**
│       └── windows.js / macos.js / linux.js
│       # ★★ `serve-web.js` / `open-browser.js` / `open-path.js` / `redis.js` 与 `cxt` 的同名文件**逐字一致**。
│       #    §2.12 十一 比 `ui/` 那三条**多一条**禁令：不 import 各家的错误类型（**一律抛裸 `Error`**）——
│       #    否则 `CmtError` / `CxtError` 的名字就进共享文件了。
│   ├── web/                     # ★ 网页控制台的前端资产（§2.12 十一）。无框架、无构建、无内联 script/style
│   │   ├── index.html           #   表单骨架：原生 <select> / <input type=checkbox> / <button>
│   │   ├── app.js               #   render(view) + post(op)；无状态、无 diff、无路由；只用 textContent
│   │   └── style.css
│   │                            # ★★ 这三件与 `cxt` 的同名文件**逐字一致**——同 `ui/` 那四条的规矩与理由：
│   │                            #    **工具名 / 环境变量名 / 契约父节号**，一条都不许进来
│   │                            #    （工具名从视图模型拿，§2.12 十一；节号只写节名，理由见那节的 ⚠️）。
├── tests/                       # node --test（core 单测 + cli 端到端冒烟 + ui/ 纯函数单测
│                                #   + serve-web 安全 + 共享文件逐字一致 + 网页控制台）
├── scripts/
│   ├── smoke-resolve.mjs        # 造一份假 home，供肉眼冒烟（非测试套件的一部分）
│   ├── live-terminal-check.mjs  # ★ 真机验"终端拉起"：开一个真标签页，里面跑假 claude 回写实况
│   └── verify-ui-real.mjs       # ★ 真机验面板的 Windows 事实（§7.8 的 M1–M7），证据落 ui-real-report.json
└── docs/
    ├── design.md                # 详细设计（本文件是铁律索引，那份是展开）
    └── config-reference.md      # 配置字段逐项说明
```

### 4.2 分层与依赖方向（单向，不许反向）

```
bin → cli → core ← platform
```

- `core/` **不 import `platform/`**、**不读 `process.env` / `process.platform` / `os.homedir()`**、**不 spawn**。
  这些一律由 cli 层以 `{ platform, home, env }` 注入。纯函数化 → 可单测，
  且**三大平台的路径规则能在任意一台机器上测**（§6.3）。
  `resolve.js` 尤其必须纯：输入 `{config, token, bindings, cwd, argv}`，输出 `{值, 来源层}`。
- **`core/bindings.js` 的 `normalizeForCompare(p, platform)` 必须把 `platform` 当参数**，
  不许读全局——否则 Windows 的路径规则在 Linux CI 上就没法测了。
- `cli/` 只做：解析参数 → 调 core → 调 platform → 渲染输出。
- `platform/` 不 import `cli/`，导出这几件事：`spawnTerminal()`（§2.9 二·1）、
  `resolveTerminal()`、`findExecutable()`（§2.9 四）、`fetchModels()`（§2.12 六，
  唯一碰网络的地方，与"唯一知道具体终端的地方"同源），以及
  **`serveWeb()`** / **`openBrowser()`** / **`openPath()`**（§2.12 十一）。
  ★ **`platform/serve-web.js` 是全项目唯一 `import node:http` 的文件**——与
  「`cli/ui/term.js` 是 `cli/ui/` 里唯一碰那两个流的文件」是同一种写法，理由也相同：
  **能单测的规则，就不要让它依赖宿主**。它收 `{ops, assets, onLog, …}`，自己不读 `process.*`。
  唯一一处例外是 **SIGINT**（§2.12 十一 第 13 条）——它**刻意**放在这里而不是 `cli/`：
  **装信号的人就得负责摘它**，而"谁来收尾"这件事只该有一处定义（`close()` 是幂等的，
  三条退出路都走它）。⚠️ 但这**不是**为了"让 `ui-web.js` 一个 `process.*` 都不碰"——
  它**照样写 `process.stdout` / `process.stderr`**（URL、提示、请求流水），
  和 `cli/commands/` 下其余十二个命令**一模一样**。那是对的：判据见下面那条，
  **这条纪律管的是终端状态，不是"有没有碰那两个流"**。

**`ui/term.js` 是 `cli/` 层里的同一条纪律，作用域降一级。** `core/` 那条是"不读 `process.*`"，
`ui/` 这条是"**`cli/ui/` 里只有 `term.js` 碰 `process.stdin` / `process.stdout`**"：

```
cli/ui/keys.js    纯：字节流进，按键事件出
cli/ui/render.js  纯：(state, {cols,rows}) 进，{frame, cursor} 出
cli/ui/app.js     纯：reducer，(state, key) 进，{state, effects} 出
cli/ui/term.js    ★★ `cli/ui/` 里唯一碰 stdin/stdout 的那个
```

于是面板的**状态机与排版能整层被测**，而不必真抢一个终端（§6.3）。
`main.js` 仍然只读 `process.*` 的**标量**（argv / isTTY / env / cwd）并把它们塞进 `ctx`。
§4.1 里那句「`main.js` 是唯一读 `process.*` 的地方」在 §2.12 之后**不再成立**，读作上面这条。

★ **`cli/commands/ui.js` 的 `runPlain()` 是这条纪律唯一的一处例外，且是刻意的**（§2.12 七）：
它直接读 `process.stdin` 的行、直接写 `process.stdout`。判据不是"碰没碰那两个流"——
每个命令都在往 stdout 写输出，那不是这条纪律管的事——而是**"碰了终端状态之后还能不能全身而退"**。
`runPlain()` **绝不碰 raw mode、备用屏、光标显隐，一个 ANSI 字节都不发**，
所以它在管道里、在 CI 里、在备用屏已经卡住的终端里都跑得起来，而那正是它存在的理由。
**例外只此一处**：`cli/ui/` 之外再有人去动终端状态，就是违规。
⚠️ **`cli/commands/ui-web.js` 不是例外，也不需要是**：它写 `process.stdout` / `process.stderr`，
但它一个终端状态字节都不碰（和 `resolve` / `doctor` 那些命令一样），所以上面那句继续成立。

### 4.3 零依赖铁律

`dependencies: {}`——只用 `node:` 内置模块。

- 参数解析自己写（约 120 行，够用）
- 测试用内置 `node:test`
- **面板也是手写的**：raw mode + ANSI 转义序列，`node:` 内置够用，**没引 TUI 库**（§2.12）
- 网络用内置 `fetch` + `AbortSignal.timeout()`（§2.12 六），**没引 HTTP 库**
- **HTTP 服务端不引库**（§2.12 十一）：`node:http` + `node:crypto` 够用。
  一个只绑回环、只服务一个表单的服务器不需要 express——它需要的那几样
  （路由、静态资产查表、body 上限）在这个规模上各是十几行。
- **前端不引框架、无构建**（§2.12 十一）：手写 HTML/CSS/JS，控件全是**原生**的
  （`<select>` / `<input type=checkbox>` / `<button>`）。没有 bundler、没有前端
  `node_modules`、**没有构建步骤**——`src/web/` 里那三件就是发给浏览器的字节。
- 好处：`npx` 秒装、无供应链风险、无构建步骤、审计友好

**这是本项目对外的卖点之一，不是权宜之计。** 需要新能力时先问：内置模块能不能做？

### 4.4 实施顺序（每步独立可验证，按序做）

| # | 交付 | 验证方式 |
|---|------|---------|
| 1 | `package.json` + `bin/cmt.js` + `src/` 三层骨架 | `node bin/cmt.js --help` 有输出 |
| 2 | `core/paths.js` + `core/schema.js` + 测试 | `node --test` 绿 |
| 3 | `core/bindings.js` + 测试 | 最长前缀 / NFC / 大小写 / 分隔符归一 边界全绿（三平台规则均可在本机测） |
| 4 | `core/models.js` + 测试 | 轮转回原点、提拔保序、不在列表则插首位 |
| 5 | `core/resolve.js` + `core/validate.js` + 测试 | 级联七项覆盖顺序 + 来源层标注 |
| 6 | `cli/commands/resolve.js` → `cmt resolve` | ★ **不需终端探测即可验证整条解析链** |
| 7 | `core/launch-script.js` + 测试 | 脚本内容断言（§2.10 契约四条） |
| 8 | `platform/*` + `cmt exec` + `cmt run` | **`node scripts/live-terminal-check.mjs`** 本机实测弹窗（已通过，12/12）；**macOS/Linux 分支此处只能静态审查**，标 `// UNVERIFIED` 注释 |
| 9 | `cmt doctor` / `ls` / `bind` / `model` / `token` 全套 | 手工走一遍 §5 全部命令 |
| 10 | README（含 §7.3 的坑 + 卸载说明） | `npm ls` 为空（零依赖审计） |
| 11 | **契约先行**：本文件（§2.11 / §2.12 / §7.8 + 上表各处） | 本节与 §2.3 / §2.4 / §3.1 / §4.1 的交叉引用对得上 |
| 12 | `cli/format.js` 移植 `makePainter`；`main.js` 的 `ctx` 补 `isTTY` / `stdinIsTTY` | 现有 440 条测试仍全绿（这是加，不是重写） |
| 13 | `core/project-config.js` + `paths.js` + `resolve.js` 第四层（含来源层 `project`）+ 单测 | ★★ **项目本地赢过 binding**；三个禁键各自报错点名 |
| 14 | `core/models-endpoint.js` + `platform/fetch-models.js` + 单测 | 三种响应形态；错误体；baseUrl 带不带尾斜杠 |
| 15 | `cli/ui/` 四件套（**从 `cxt` 逐字拷贝**，`diff` 必须为空）+ 单测 | 尺寸不变量扫尺寸、分裂输入逐键喂、`RESTORE` 纯 ASCII |
| 16 | `cli/commands/ui.js` 面板 + 向导 + 全局 `--config` + 裸 `cmt` 入口 + `CMT_UI=plain` + e2e | e2e 走 plain：非 TTY 裸 `cmt` 退 0、`cmt ui` 退 1、向导四步**两处都写** |
| 17 | README（含 §2.12 十 的边界 + 备用屏卡住怎么办） | 与 `cxt` 的两份 README 结构对齐 |
| 18 | **契约先行**：本文件（§1.4 / §2.12 十一 + §3.1 / §4.1 / §4.2 / §4.3 / §5 / §6.3 / §7.8 / §8） | 纯文档改动：`npm test` 全绿 |
| 19 | `cli/ui/app.js` 加 `panel` 事件族（含**真新增**的 `move-model`） | 每个 op 的状态迁移全绿；`move-model` 两端越界 = no-op；★ **四个 `ui/` 文件 `diff` 仍必须为空**；`term.test.js` 仍绿（那个目录还是恰好 4 个文件） |
| 20 | `platform/serve-web.js` + 测试 | ★★ **14 条控制逐条删掉看测试变红**（§2.12 十一）——不是"写了就算" |
| 21 | `platform/open-browser.js` + 测试 | 三平台确切 argv；★ Windows 那条要断言 `cmd /c start "" <url>` 里**那个空 `""` 在**（它是标题位，少了就开不出来） |
| 22 | `cli/commands/ui.js` 提出 `makeSession()`（**并让 `runPlain` 改用它**）+ `commands/ui-web.js` | ★★ **`ui-e2e.test.js` 一字不改且全绿**——这就是提取忠实的证明 |
| 23 | `src/web/` 三件 + `source-hygiene` 的扩展名表加 `html\|css` | `GET /<tok>/` 能出；断言 `index.html` **没有**内联 `<script>`/`<style>`/`on*=`（CSP 会当场拦掉，但那条只有真浏览器看得见） |
| 24 | 接线：`main.js` 裸命令分支、`ui --web` / `CMT_UI=web` | e2e：非 TTY 裸 `cmt` 退 0 **且没起服务器**；`--web` 起得来、`POST {op:'quit'}` 退 0 |
| 25 | `tests/shared-files.test.js` | ★ **头一次有东西真的守着"两个项目逐字一致"**（在那之前纯靠 §4.1 那段话 + 人记得跑 `diff`）。改 `ui/app.js` 一个字节 → 变红 |
| 26 | README 两份（含控制台那节 + §2.12 十 的边界） | 与 `cxt` 的两份 README 结构对齐 |

**顺序是刻意的：第 6 步在第 8 步之前**——先把解析链跑通并**可验证**，再碰平台层
（终端探测无法单测，是风险最高的一步，要留到最后且有 `--print` 兜底）。

**11–17 的顺序同样是刻意的**：11 改契约（本文件的规矩），12 是**移植而非重写**
（颜色系统与 `ctx` 字段都是"补齐到与 `cxt` 对齐"，对齐之后 440 条测试必须仍然全绿——
这条是回归闸门），13/14 是纯逻辑（好测），15 是**逐字拷贝**（`diff` 为空就是验收），
16 才接线。**把 15 排在 16 前面**是因为内核错了会烂整屏，而它恰好是最能单测的一层。

**18–26 的顺序与 `cxt` 逐条相同**（这不是巧合：两边共享二十三个文件，
施工顺序一旦分叉，中途就会各改各的），理由也逐条相同：

> ⚠️ 别去 `cxt` 的 §4.4 里找"第 18 步"——**那边的主表只编到第 13 步**，
> 面板与控制台那两段记在它下面的「施工进度」表里（按**名字**分行，没有编号）。
> 本文件把它排成 14–26 是**同一个顺序的编号版**，纯粹为了方便移植时逐步对照。
> 两边真正的锚点是**共享文件**，不是号数。

- **19 是唯一一处动共享内核的步骤**（`ui/app.js`），所以它单独一步、单独一道闸门。
  它是本方案**最大的架构代价**：那个文件 ×2 逐字一致，**一个笔误就静默分叉**
  （改了一边忘了另一边，两边测试**都绿**）。闸门就是第 25 步那个测试。
  **兜底方案**（不推荐）：op → 事件的翻译全放 `ui-web.js`，内核只加 `move-model`——
  但那会抄一遍 `arrows()` / `cursorOf()`，让"选中第 3 行"**有两处定义**。
- **把 19 排在 20 前面**：`ui-web.js` 要发 `panel` 事件，而事件词表只许有一处定义。
- **22 是提取而非新写**：`makeSession()` 从 `runPlain()` 里提出来、**并让 `runPlain` 改用它**，
  于是 `ui-e2e` 那批端到端断言**同时压着两个前端脚下的同一段驱动**。
  验收方式就是"那个文件一字不改且全绿"。
- **23 的卫生扩展名要和资产同一批落**：晚一步，`src/web/` 三件就躺在仓库里
  **一条规则都不受**（`walk()` 的扩展名表把它们整个跳过，四条规则静默变空转）。

### 4.5 v1 完成定义

- §5 命令面**全部可用**（`cmt exec` 除外，它是内部命令）
- §4.4 第 1–26 步全部完成
- **本机实测走通**：`cmt bind D:/x --token a` → `cmt resolve` 四要素齐全且来源层正确
  → `cmt run` 在 cmt 窗口开出新标签页且落在 `D:/x` → 标签页内 `/status` 显示的正是该 token
- `cmt model next` + `cmt run -c` 能续上原会话（§2.5 工作流）
- **项目本地配置走通**：在项目里放一份 `.cmt.json` → `cmt resolve` 的 `source` 显示「项目本地」
  → `cmt run` 用的是它声明的模型 → 删掉文件即回落到绑定
- **面板走通**：真终端里 `cmt ui` 进得去、出得来、**退出后终端状态完全还原**
  （含 Ctrl+C、含向导中途 `q`）；非 TTY 下 `cmt ui` 报错退 1、裸 `cmt` 打印用法退 0
- **网页控制台可用**（§2.12 十一）：裸 `cmt` 在 TTY 下开出窗口、四个步骤点得通、
  勾选框下方那区能调序且**真的改变了优先级**；第 1 步的「打开」真的弹出文件管理器；
  `--no-open` 只打印 URL。
  ★ 且**非 TTY 裸 `cmt` 仍打印用法、退出 0**——不许变成"起一个永远不退的服务器"。
  ★ 14 条安全控制**逐条删掉看测试变红**（§6.3），不是"写了就算"。
- **共享文件与 `cxt` 的同名文件 `diff` 为空**（§4.1）：`cli/ui/` 四件 +
  `platform/{serve-web,open-browser,open-path}.js` + `src/web/` 三件。
  ★ 而且这一条**现在有测试守着**（`tests/shared-files.test.js`），不再靠人记得跑 `diff`
  ——在那之前，**一次编辑就能让它漂移而两边全绿**。
- `node --test` 全绿；`dependencies: {}`
- README 写完 §7.3 的坑 + 卸载清理（删 `~/.claude-multi-token/` 即可，**不影响 `~/.claude/`**）

---

## 五、命令面

```bash
cmt                                 # ★ TTY → 开网页控制台（§2.12 十一）；非 TTY → 打印用法、退出 0
cmt ui                              # ★ 显式进全屏 TUI。非 TTY → 报错退出 1
                                    #   CMT_UI=plain → 逐行输出，不进备用屏（§2.12 七）
cmt ui --web [--no-open]            # ★ 开网页控制台。**非 TTY 也开**（它不需要终端）
                                    #   只绑 127.0.0.1 + 随机端口 + 路径口令（§2.12 十一）
                                    #   --no-open：只打印 URL，不开浏览器（口令不进 argv）
                                    #   CMT_UI=web 等价
cmt run [<token>] [--cwd <path>] [--model <id>] [--url <u>]
        [--auth-mode token|key] [--pick] [--pool] [-c] [--window|--tab] [--print] [-- <claude 参数...>]
                                    #   ★ 没有 --token-value：见 §2.7 末（凭证跨进程必落盘）
                                    #   --url / --auth-mode 会转发给内层 exec，并写进 launch 脚本
                                    #   ★ --url 也不收带 userinfo 的值（同上，userinfo 即凭证）
                                    #   --pool：启动前从 token 池里挑一个，覆盖任何一层的绑定（§2.13）
cmt resolve [<path>]                # ★ 打印该路径解析出的四要素 + 每项来源层（token 打码）
                                    #   也吃 --url / --token-value / --auth-mode（"当作传了"）
cmt exec [<token>] [--model <id>] [--url <u>] [--token-value <v>] [--auth-mode token|key] [-c]
                                    #   内部命令：算好环境后 exec claude（launch 脚本调用）
                                    #   省略 <token> = 纯 defaults 模式（profile 落 _default）
                                    #   ★ 唯一能接一次性凭证的地方（不落盘，只进进程环境）
cmt ls                              # token 列表 + 各自 cwd / 模型来源（own / global）
cmt bind <path> [--token <t>] [--url <u>] [--model <id>]
cmt bind ls                         # 列出全部路径绑定
cmt bind rm <path>
cmt token add <name> --token <t> [--base-url <u>] [--cwd <path>] [--auth-mode token|key]
              [--label <昵称>]
cmt token rm <name> [--purge] [--yes]
cmt token show <name>               # token 打码显示：sk-****abcd；有昵称时多一行「昵称」
cmt token edit <name> [--token <v>] [--base-url <u>] [--cwd <p>] [--auth-mode token|key]
                     [--label <昵称>]  # ★ --label "" = 清除昵称（删键，不是写空串）
                                    # ★ 改凭证/端点但不动 profile 目录
                                    #   → 会话历史保留，claude -c 依然有效（§2.5）
cmt model ls [<path>|<token>]       # 看生效的优先级列表（标注来自哪一层）
cmt model set [--global|--token <t>|--path <p>] <id[:label]...>   # 顺序即优先级，第一个最高
cmt model use <id> [--global|--token <t>|--path <p>]   # ★ 提拔到首位（模型故障切换）
cmt model next [--global|--token <t>|--path <p>]       # ★ 轮转一位（模型故障切换）
cmt model clear [--token <t>|--path <p>]               # 删掉该层 list → 回退上一层
cmt slot set [--global|--token <t>|--path <p>] <slot>=<modelId>   # opus|sonnet|haiku|fable|subagent
cmt profile path <token>            # 打印 profile 目录（排查用）
cmt usage [--days <n>|all] [--by token|project|model|day] [--json] [--refresh]
                                    # ★ 用量与花费（§2.12 十二 价格小节）：按 claude 自己写的
                                    #   会话 jsonl 统计 token 用量，按价格表折算美元。只读不联网
                                    #   价格三级：手写 prices.json > 端点自报价（resources.json）
                                    #   > 无价 →「—」，绝不冒充 $0；--json 带 pricesFile /
                                    #   endpointPrices 说清价格从哪来
cmt pool list                       # 所有 token + 池状态 + 用量；有 token 无条目标「未入池」（§2.13）
cmt pool import <file.csv|xlsx>     # 批量建 token + 建条目；已存在的名字跳过不覆盖
cmt pool check [<name>...] [--all] [--force]
                                    # 额度探测（发一次最小真实请求，**会花钱**）
                                    # 不带参数 = --all；--force 无视 TTL
cmt pool status <name> <status>     # 手动覆盖：ok|no_quota|invalid|net_fail|other|unknown
cmt pool reset <name>               # 清状态回 unknown
cmt pool sync [--redis <url>]       # 从会话记录重算用量；带 --redis 时写穿到 Redis
cmt pool pull --redis <url>         # 反向：把 Redis 里的状态拉回本地
                                    # ★ --redis 也认 env:VAR；平时**完全不连 Redis**（§2.13 五）
cmt sessions [--json]               # ★ 在场层（§2.14）：窗口会话三态（live / ended / dead）+ 未读数
cmt sessions prune [--older-than 30d] [--force]
                                    # 删超龄的 ended/dead 记录；有未读时拒绝（--force 才放行）
cmt resume <id前缀>                 # 恢复 ended/dead 会话：同 token、同 cwd、带 -c 开新窗口
cmt msg send <id前缀|--token <t>|--all> [--type info|action-request] <文本...>
                                    # 给 live 会话留一张纸条——惰性数据，工具永不自动读它（§2.14 三）
cmt msg inbox [--session <id>] [--peek] [--json]
                                    # 看信箱；默认读完即标记已读（--peek 只看不动）
cmt msg gc [--older-than 7d]        # 清理超龄消息（inbox 与 read 都算）
cmt doctor                          # 自检：node / claude / 终端探测 / 四要素完整性 / 绑定悬空引用
```

- `cmt run` **不带 token 名**时按当前目录匹配绑定（§2.3），这就是"不同路径不同 token"的入口。
- **全局选项**：`--config <路径>`（显式指定项目本地配置，§2.11 一）· `--json`（`ls` / `resolve` /
  `model ls` / `bind ls` / `doctor`）· `-h` / `--help` · `-v` / `--version`。放在子命令**后面**。
- `cmt run -c` 转发 `-c/--continue` 给 claude——**模型故障切换的第二步**（§2.5 工作流）。
- `--print` 打印**将要执行的完整环境与命令**，不实际启动——排查首选。
  **"将要注入的" 与 "将要删掉的"（§2.6 的 `unset`）都要印**：只印加的那一半，
  读者没法回答"我明明没配 `ANTHROPIC_MODEL`，它从哪来的"。
- `cmt resolve` 是排查神器：一眼看出"为什么这个目录用了这个 token"，因为**每项都标了来源层**。
- **输出格式**：人类可读表格为默认；`ls` / `resolve` / `model ls` / `bind ls` / `doctor`
  必须支持 `--json`（供脚本消费，也是 e2e 冒烟测试的断言载体）。
- **脱敏规则**（`--print` / `cmt resolve` / `cmt token show` 共用）：键名匹配
  `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` 的值一律打码为「前 3 后 4」。
  **不要只硬编码打码 `ANTHROPIC_AUTH_TOKEN`**——`env` 逃生舱里可能塞了别的密钥。

---

## 六、开发约定

### 6.1 语言与风格

- Node ≥ 18，ESM（`"type": "module"`），import 一律带 `node:` 前缀
- 纯 JS + `// @ts-check` + JSDoc 类型标注——**不上 TypeScript，不引入构建步骤**
- 2 空格缩进 / 单引号 / 分号
- 函数短小；`core/` 一模块一职责

### 6.2 错误与退出码

抛带 `code` 字段的错误对象，CLI 层统一渲染为人类可读信息。

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 用户错误（token 不存在、名字非法、参数冲突、四要素缺项） |
| 2 | 环境错误（claude 不在 PATH、终端探测失败、目录不可写） |

报错必须**给出下一步命令**。例："路径 `D:/work/x` 解析不到 token（无绑定、无全局默认）。
可用：`cmt bind D:/work/x --token relay-a`"。

### 6.3 测试

- `npm test`（= `node --test`，靠 Node 自带的测试文件发现）。
  ⚠️ **不要写 `node --test tests/`**——实测（Node 24.16 / Windows）**目录形式的路径一律失败**：
  `tests` / `tests/` / `./tests` 都被当成 glob 匹配到目录条目本身，Node 转而把目录当测试文件执行，
  报 `Cannot find module '...\tests'`（0 pass / 1 fail）。可用的是**无路径**（自动发现）
  或**显式 glob**（`node --test "tests/*.test.js"`）。package.json 的 `test` 脚本已按前者写好。
- `core/` 必须有测试（纯函数，好测），重点六处：
  - `bindings.js`：最长前缀匹配、**NFC 归一（macOS NFD 陷阱）**、Windows/macOS 大小写不敏感、
    Linux 大小写敏感、分隔符归一、边界（相同前缀、`D:/` vs `D:/work`）
  - `resolve.js`：级联七项各自的覆盖顺序、来源层标注正确；
    **以及 §2.6 的净化**——`stripSessionMarkers` 剔干净 9 个标记而 `PATH` / `ANTHROPIC_MODEL` /
    `CLAUDE_CODE_EFFORT_LEVEL` 一个不动、**不改入参**（入参就是 `process.env` 本身）、
    `unset` 三处来源各自的内容、以及**头号不变量**：同一个 `resolved` 配"干净环境"与
    "Claude Code 会话环境"两种 `base`，`buildSessionEnv()` 的结果必须 `deepEqual`
    （这条直接编码用户报的那个 bug）
  - `models.js`：轮转不丢项（反复 next 能回到原点）、`use` 提拔后其余相对顺序不变、
    目标 id 不在列表时插到首位
  - `schema.js`：token 名校验（含路径穿越 `..` / `/` / `\` / 盘符）
  - `launch-script.js`：§2.10 四条契约 + **换行符**（`.sh` 必须 LF，`.cmd` 必须 CRLF）
  - `seed.js`（§3.6）：**边界比别处更该狠一点**，因为这是唯一一处 cmt 写 Claude Code 的文件，
    且出错是静默的。重点：`projectKey` 的大小写保留与反斜杠归一、幂等（补完再算必然
    `changed=false`）、**`hasTrustDialogAccepted: false` 不被覆盖**、别的项目的条目一个字节不动、
    不修改传入的 `current`（调用方要拿它做并发比对）、坏 `current` / 坏 `projects` 不炸，
    以及 `seedProfile` 的 IO 侧：`off` 连目录都不建、第二次调用文件字节不变、坏 JSON 回警告而不抛、
    **坏文件不被覆写**。
- `core/` 的新增四处（§4.4 第 13–15 步）：
  - `project-config.js`（§2.11）：schema 允许/禁止键——**每个禁键一条，断言报错信息指名它**；
    发现是"**最近优先**"（三层嵌套目录）；`version` 必填；坏 JSON 硬报错；`--config` 走同一份 schema
  - `resolve.js` 扩充：★★ **项目本地赢过 binding**；项目本地**没有** `baseUrl` / `authToken` /
    `cwd` / `slots` 那几层（断言它盖不掉）；`env` 按键合并顺序；`claudeArgs` 拼接顺序
  - `models-endpoint.js`（§2.12 六）：三种响应形态（`{data:[{id}]}` / `{data:["id"]}` / 裸数组）；
    OpenAI 错误体；baseUrl 带不带尾斜杠
  - `cli/ui/keys.js`：每个键；★ **分裂输入逐行**（`'['`+`'A'`、`'[1;5'`+`'A'`、`'[201'`+`'~'`）；
    裸 Esc 与 flush；OSC 被吃掉；**粘贴期间 `\x03` 不泄漏**
  - `cli/ui/render.js`：五条最高价值断言（**穷举型，不是"跑个例子看看"**）——
    ① ★ **尺寸不变量**：扫 `[40,8] [45,9] [71,24] [72,24] [120,40] [200,60]`，
    行数恒等于 `rows`、每行 `frameWidth ≤ cols`（**必须扫尺寸，退化分支才是 bug 的藏身处**）；
    ② ★ **光标可见性**：`len × h × cursor` 三重循环；
    ③ ★ **CJK 截断**：中文标签不把右栏挤出去，且不切半个宽字符；
    ④ ★ **退化分级边界**（39/40、71/72、7/8）+ 行号守恒式 `2 + bodyH + ftr === rows`；
    ⑤ ★ **页脚与 `TWO_PANE_MIN_COLS` 的耦合**（改提示串没改常量 → 立刻红）
  - `cli/ui/term.test.js`：注入假 stdin/stdout（EventEmitter + 假 `isTTY`）跑全链路；
    ★ **`RESTORE` 的字节逐字断言，且断言它是纯 ASCII**（§7.8）
  - `cli/ui/app.test.js`：向导状态机——每步的 Enter/Esc 去向；勾选顺序 = 优先级
- **e2e 走 `CMT_UI=plain`**（不是真 TTY）：全屏面板要 raw mode + 备用屏，测试进程里造不出来
  （也**不该**造：那要真的抢一个终端）。plain 是同一个 reducer、同一份 `renderLines()`，
  只换输出方式与输入方式。重点五条：
  ① ★★ 非 TTY 的 `cmt ui` 明确报错退 1、非 TTY 的裸 `cmt` 立刻退 0 **且没起服务器**
  （判据是它**一个字都没宣告**——"退了"不等于"没起过"，起过再被空闲超时收掉也是"退了"）；
  ② ★★ `CMT_UI` **不许**改变裸 `cmt` 的行为，**`plain` 与 `web` 两个值各一条**。
  后一条比前一条更要紧：`web` 是**会起服务器**的那个值，在管道里它一旦生效，
  `cmt | grep` 就永远等不到 EOF 了；③ ★★ 向导四步**两处都写**；
  ④ ★★「当前目录」那一行的身份来自**级联**而非绑定（§2.12 二）；
  ⑤ ★ 面板输出里**不出现明文密钥**、且不许有裸 ANSI（喂给 `grep` 是乱码，喂给日志是垃圾）。
  沙箱靠 `USERPROFILE` / `HOME` 隔离（`os.homedir()` 在 Windows 上认它，已实测），
  **绝不碰用户真实的 `~/.claude-multi-token/`**；尺寸用 `CMT_UI_COLS` / `CMT_UI_ROWS` 钉死
  （布局退化会改变可见行数，断言才稳）。★ **夹具一律用一次性假 key，绝不用真 key——
  这份文件会被读、被复制。**

> ★★ **`cli/help.js` 也是命令面，而且是这次真的漏过的一处。**
> `main.js` 的裸命令分支改完了、§5 改了、四份 README 也改了——**只有 `help.js` 没改**，
> 于是 `cmt --help` 继续写着「裸 `cmt`（不带参数）在终端里**就是它**」（指 TUI）。
> **那句话是假的**，而当时的断言（`assert.match(r.out, /面板/)`，只要出现那两个字）
> 照样绿——它测的是"用法里有这组"，不是"这组说的是真的"。
> ⇒ 现在钉的是**结构**不是标签：那一组必须叫 `前端`，且用法里**必须有 `--web`**。
> 判据已经验过——把 `--web` 那行从 `help.js` 删掉，这条**当场变红**（13 → 12 pass）。
> **教训**：「改命令面」= §5 + `help.js` + README，**三处**，一处都不能少；
> 而"存在性断言"（出现了某个词）**永远抓不住"这句话是假的"**。
- **e2e 还要多两条**（§4.4 第 24 步），都在 `ui-e2e.test.js` 的末尾：
  `--web` 起得来（**非 TTY！它绕过 TTY 闸门**——它不需要终端，这正是 e2e 的钩子，
  地位等同 `CMT_UI=plain`）→ 解析打印出的 URL → `GET api/state` → `POST {op:'quit'}` → 断言退出码 0；
  再加一条**口令改一位 → 404，连资产也是**——"连'哪些路径存在'都问不出来"。
  ★ 发请求**故意不用 `fetch()`**，用 `node:http.request`：`Origin` 在浏览器里是禁止设置的请求头，
  而 `fetch()` 是照浏览器的规矩实现的，它会不会被悄悄抹掉取决于手上这个 Node 的版本——
  而那条测试守的**恰恰是** `Origin` 校验。用一条可能被抹平的路径去测它，测出来的"通过"什么都说明不了。
- **网页控制台的测试是四份新的 + 一处扩面**（§4.4 第 19–25 步）：
  - `platform/serve-web.test.js`（★ **安全是承重的**）：假 `ops` + 真 `http` + 全局 `fetch`，
    注入 `_random` / `_now` / `_listen`。**验收方式是 §2.12 十一 那 14 条控制逐条删掉、看测试变红**
    ——不是"写了就算"。另有：口令不符 → 404、坏 `Host` → 403、`Origin: null` → 403、
    `OPTIONS` → 405、100 KiB body → 413、空闲 → 关闭，以及 ★ **两个并发 POST → 串行**。
  - `platform/open-browser.test.js`：注入 `spawn`，断言**三平台的确切 argv**。
    ★ Windows 那条要断言 `cmd /c start "" <url>` 里**那个空 `""` 在**（它是标题位，少了就开不出来）；
    ★ 还有"应用窗口优先"那条：找得到 Chrome/Edge → `--app=<url>`，找不到 → 退回默认浏览器。
  - `platform/open-path.test.js`：注入 `spawn`，断言**三平台的确切 argv** 都**不过 shell**
    （`explorer.exe <目录>` / `open <目录>` / `xdg-open <目录>`）；**先 probe 再 spawn**
    （`missing` / `file` / `dir` 说三句不同的话）；**只等 `spawn` 事件、不等 `exit`**——
    Windows 上等退出码会把每一次成功都读成失败（§7.8 M10）；控制字符在 spawn 之前挡掉。
  - `cli/commands/ui-web.test.js`：`runEffect` 的关联 / 超时 / `failed` 路径；
    ★★ **「每个 effect 恰好 dispatch 一次」**——这是整个桥**依赖的隐式不变量**
    （正因为如此，它才不需要给每个请求配一个关联 id），在这里把它钉住；
    视图模型的**黄金形状**（断言键集，并断言**没有明文密钥**）；
    `panel` 每个 op 的状态迁移；`move-model` 两端越界 = no-op、未知 op = no-op。
    ⚠️ 那个黄金形状断言是**跨项目接口**的守卫：键集**两边都要有**，
    缺一个只会在缺的那一边坏（§2.12 十一）。
  - `tests/shared-files.test.js`（★ **补上一直完全没有的那条**）：`SHARED` = `ui/` 四件 +
    `platform/{serve-web,open-browser,open-path}.js` + `web/` 三件 + 三个测试。**总是**断言每个路径存在且非空
    （防重命名把列表悄悄清空）；**兄弟项目在**（本机永远成立）逐文件比对，
    用 `Buffer.equals()` 而**不是** `===`——BOM / 换行差异正是要抓的；
    **兄弟项目不在**（单克隆）`t.skip('兄弟项目不在检出里')`——**可见地跳过**，不是静默通过。
    ✗ 否决：在两处钉 sha256 常量——它只保证"这个文件变了"，**不保证两个项目一致**
    （两个不同的哈希都能过）；✗ 否决：从契约里读哈希——§7.11 明令禁止把会变的数字放进断言。
  - **`source-hygiene` 的扫描面要扩**：`walk()` 的扩展名表加 `html|css`，`SCAN` 里加 `src/web/*`。
    ★ 并给"扫描面覆盖到了"补一条断言——**没有它，将来谁把扩展名删回去，四条规则会静默变回空转**：
    `assert.ok(FILES.includes('src/web/index.html'), '没扫到 web 资产——\`.html\` 那条扩展名丢了？')`
    （`127.0.0.1` 已被 `hostAllowed()` 放行，前端天然安全。）
- **平台规则单机全平台可测**：因为 `core/` 的 `platform` 是**注入**的，
  `bindings.js` 与 `findExecutable()` 的三套规则**在任意一台机器上都能跑**——
  测试里传不同的 `platform` 值即可（Linux CI 上也能验 Windows 盘符规则）。
- **源码卫生有两条机器守着的规则**（`source-hygiene.test.js`）：**裸控制字符**与 **BOM** 不许进源码。
  这不是洁癖——裸 `ESC` 写在模板串或正则里是**合法 JS**，运行时的值与 `\u001b` **一字不差**，
  所以**任何行为测试都抓不到它**；抓不到又看不见：编辑器不显示、`git diff` 里两行**看起来一模一样**、
  review 的人只能选择相信，而复制粘贴或编辑器"清理不可见字符"会让它**静默消失**，
  症状却在很远的地方（`format.js` 里那七处 ANSI 码少一个 `ESC`，颜色就没了，**而 diff 是空的**）。
  规则是从 `cxt` 那边带过来的（那边踩过五次之后才加的）；本仓库自己踩过**两次**，
  两次都是移植时跟着过来的——`CLAUDE.md` 10 处（§2.12 三 里 `[200~` 那些例子）、
  `format.js` 7 处（`makePainter` 的 ANSI 码）。**第三次就是这份测试文件自己**：
  写它的时候注释里那三处转义写法落盘成了裸字节，是这条断言当场逐个列出来的，
  而人眼看那几行与现在**一模一样**。想"手写那个字节"本来就是不可靠的。
  BOM 那条同理：`bin/` 的 shebang 被它顶掉，Unix 上 `Exec format error`，
  而 **Windows 上 Node 自己会吃掉 BOM**，所以这个错在开发机上永远复现不出来。
  ⚠️ 扫描面**从仓库根开始，且含 `.md`**——这条规则在 `cxt` 那边加的时候扫全仓，
  唯一的漏网之鱼就是它的契约文件，其中两处**已经躺在那里好几天**，每一次 `git diff` 都没显示出来过。
  契约文件是本仓库读的人最多的文件，它上面挂一个看不见的字节比代码里挂一个更坏。
  ⚠️ 值本身由行为测试钉着（`term.test.js` 对 `ENTER` / `RESTORE` 的**逐字节**断言、
  `render.test.js` 对 `[7m` / `[K` / `[2J` 的断言），**两条各管一半**：
  卫生规则管"怎么写的"，行为断言管"写出来是什么"。
- **不许把"真东西"带进仓库**（同文件第三组）：**真密钥**与**内网地址**。
  ★ 起因：`test_resource/README.md` 里曾经同时躺着 18 位同事的**真名**和一个**内网域名**，
  而那个文件是**会被提交**的（`.gitignore` 里显式 `!README.md`）——两者都不是"写错了一个字符"，
  一个是看着很正常的成员名单表格，一个是复制粘贴出来的示例命令。**能机器守的约定就别靠记性。**
  ★ 两条规则**都不含任何真值**。key 那条查 `sk-` 后跟 16 位以上字母数字的**形状**；
  地址那条是**默认拒绝**——凡 `https://` 后面的 host 不在 `OK_DOMAINS`（RFC 2606 的
  `example.*` + 少数文档确实引用的公开站点）或保留 TLD（`.example` / `.invalid` / `.test`）里就报错。
  **写死内网域名的黑名单有两个毛病**：等于把那个域名又抄进仓库一遍，而且只防得住**已经漏过的那个**。
  ⚠️ 报错里**只印前 3 位和长度**，不印整个串——否则这条守卫自己就成了新的泄漏点。
  ⚠️ 两个例外写进了规则：紧跟 `…` 的 host 是**打码后的显示值**（`https://oneapi…`）；
  没有点的 host 是 `https://x` 这种占位符。两者都不是真地址。
  ⚠️ **扫描面 = 本项目源码 + 共享 `test_resource/` 里会被提交的那几个文件**（`README.md` 与
  `*.example.json`，即测试里那个 `SCAN`）。★ 这一条是补出来的：第一版只扫本项目，
  而**真值恰恰就是在 `test_resource/README.md` 里被发现的**——那个文件在项目的 `ROOT` 之外，
  等于把后门留在了案发现场。被忽略的 `tokens.json` / `endpoints.json` **不该扫**：真值本来就该在那儿。
  与 `codex/tests/source-hygiene.test.js` 是同构的两份，改一边时对着另一边看一遍。
- **CI 矩阵**：GitHub Actions `windows-latest` / `macos-latest` / `ubuntu-latest` 跑 `node --test`。
  矩阵验的是真实 FS 行为（大小写、NFC、权限）与 Node 版本差异，**不是**路径规则本身。
- **真正只能手工验的只剩"终端拉起"这一件事**：靠 `cmt doctor` + 本机实测。
  这是本项目**唯一的平台风险敞口**，`--print` 是它的兜底。
  - 实测用 `node scripts/live-terminal-check.mjs`：开**真**标签页（连开两次），里面的 `cmt exec`
    拉起一个**假 claude**（一个 .cmd），假 claude 把环境与参数写成 UTF-8 JSON 回传，
    脚本断言十三项——含"路径带空格与中文时参数不被撕开"，**"第二次启动的标签页落进了
    同一个窗口"**（§7.7：旧版没有这条，于是 `-w 0` 的 bug 一路绿灯），以及
    **"标签页里没有 `CLAUDE_CODE_CHILD_SESSION`"**（§2.6）。**Windows 已实测通过**。
    - ⚠️ 夹具里的假 claude 写完**不马上退出**，等脚本放行。理由：标签页里的进程一退出标签页就关，
      只剩一个标签页的窗口跟着关，于是"第二次会不会复用同一个窗口"就无从测起（第二次必然
      "新开"→ **假失败**）。测"窗口归属"就必须让两次的标签页**同时活着**。
    - 数窗口用 `EnumWindows`，**不是** `MainWindowHandle`（§7.7 那个坑）。数不出来时脚本
      **报错退出**而不是当成 0——"断言没跑成"和"断言通过"绝不能长得一样。
    - 那条净化断言靠**夹具自己往 `launch()` 的 env 里塞 `CLAUDE_CODE_CHILD_SESSION=1`** 来成立，
      而不是靠"脚本恰好从 Claude Code 里启动"——后者换个地方跑就成了空炮。
  - 新平台要验的就是这个脚本，别另起炉灶——§8 第 7 条（macOS/Linux 谁来验）等的就是它。
- **面板的真机验收走 `node scripts/verify-ui-real.mjs`**（§7.8）：**用夹具，不靠"看见面板弹出来了"
  下结论**——让面板把事件流、实测尺寸、还原序列落盘再逐项断言，与 `live-terminal-check.mjs`
  的手法一致。跑 M1–M7，结果**回填 §7.8 的标记**（🟢 / 🔴），标 🔴 的连带改代码。
  ⚠️ **非 TTY 会话里只能跑出 M1 的字节级那一半**，其余七项结构性地测不了——
  那些**必须有人在一个真终端里跑 `--all`**，别拿"脚本退出 0"当通过。
- 面板的人工验收（脚本之外，人得亲眼看）：
  ① 真终端里 `cmt ui` 进得去、出得来、**退出后终端状态完全还原**（含 Ctrl+C、含向导中途 `q`）；
  ② ★ **粘贴实测**：50 字符 `sk-…` 粘进向导第 2 步输入框完整落入；
  **再粘一段带尾换行的**，确认没有中途提交；
  ③ ★ **在 `cmt run` 弹出的新 WT 标签页里也跑一遍面板**（§7.7 已记过 WT 里 tab/窗口语义会打架，
  新标签页是 ConPTY 不是裸 conhost）；
  ④ 拉模型实测：对真实端点跑一次 `GET /models`，确认 `Authorization: Bearer` 可用、数量合理；
  ⑤ 向导跑通一次：**确认全局 binding 与项目 `.cmt.json` 都写对了** →
  `cmt resolve` 确认项目本地层赢 → `cmt run` 起得来。
  ⑥ ★ **网页控制台的人工验收**（§2.12 十一——脚本只验得到 API 那一层，页面本身零测试）：
  裸 `cmt` 真的开出无地址栏窗口、四个步骤点得通、**勾选框下方那区调序真的改变了优先级**
  （用 `cmt model ls` 读回来对）；★ `Ctrl+C` 后端口真的释放（再起一次，端口不同）；
  ★ 临时把 `idleMs` 改成 30 秒，确认空闲真的自己退。
  ⚠️ **Windows 防火墙弹窗？** 绑 `127.0.0.1` **应该**不弹（只有 `0.0.0.0` 才弹），
  但**本机未验证**——按 §7.8 的探针纪律记 🔵，**别假设**。

### 6.4 提交

`feat|fix|docs|refactor|test: 中文简述`

---

## 七、已核实的技术事实（别再重复调研）

来源：官方文档（`code.claude.com/docs`，2026-10 拉取）+ 本机 **Claude Code 2.1.251** 二进制实测。
**直接采信，不要再重复调研。**

### 7.1 隔离与配置目录

- ✅ `CLAUDE_CONFIG_DIR` 是官方推荐的"同时登录多个账号"方案，原文：*"give each account its own
  configuration directory... Each directory has its own settings, session history, and claude.ai login
  or API key."*
- ✅ 二进制实测：`process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')`；应用状态文件
  （`.claude<平台后缀>.json`）同样 join 到该目录下 → **profile 内自带一份**，与主配置互不干扰。
- ✅ 凭证位置分平台：Windows/Linux 为配置目录内 `.credentials.json`；macOS 为钥匙串条目，
  按配置目录哈希分槽（二进制中 `sha256(configDir)` 后缀逻辑，`CLAUDE_SECURESTORAGE_CONFIG_DIR` 可覆盖）。
- ⚠️ **无 key 的 Console 登录不被隔离**——该类登录存在配置目录**之外**（`%APPDATA%\Anthropic`）。
  中转 / API-key 场景不受影响，但别向用户承诺"任何登录形态都隔离"。
- ⚠️ 同一 config dir 的跨进程锁语义**无官方文档**；`sessions/` 仅用于并发会话探测
  → 更应坚持"一 token 一 profile"。
- ⚠️ 自动更新器按会话在后台运行，多实例并发更新的行为无文档 → 多窗口同时启动可能看到更新提示。

### 7.2 认证（优先级高 → 低）

云厂商变量 → `ANTHROPIC_AUTH_TOKEN` → `ANTHROPIC_API_KEY` → `apiKeyHelper` →
`CLAUDE_CODE_OAUTH_TOKEN` → Anthropic profile/WIF → `/login` 凭证。

- ✅ **环境变量永远压过已存储的登录态**——本项目注入方案成立的前提。
- ✅ `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer <v>`；`ANTHROPIC_API_KEY` → `X-Api-Key`。
- ✅ `ANTHROPIC_CUSTOM_HEADERS`：`Name: Value` 格式，换行分隔多个（v2.1.227+）。
- ⚠️ `ANTHROPIC_PROFILE` **不是**通用多账号开关——它是 Console / WIF 企业档概念，存于配置目录之外。
  **本项目不使用**，别被名字误导。
- ⚠️ CLI **没有** `--profile` / `--config-dir` 标志。

### 7.3 模型（本项目重度依赖，逐条已核实）

- ✅ 优先级：`/model`（会话内）→ `--model` → `ANTHROPIC_MODEL` → settings 的 `model` 键 →
  `ANTHROPIC_DEFAULT_MODEL`（新会话默认，v2.1.236+）。
- ✅ 官方对多终端场景的原文建议：*"To run different models in different terminals at the same time,
  launch each one with its own `--model` flag rather than switching with `/model`."*
- ✅ 别名集合：`default` / `best` / `fable` / `sonnet` / `opus` / `haiku` / `sonnet[1m]` / `opus[1m]` /
  `fable[1m]` / `opusplan` / `opusplan[1m]`。校验 `model.id` 时可参照。
- ✅ **别名重映射变量全部存在**（二进制实测）：`ANTHROPIC_DEFAULT_OPUS_MODEL`、
  `ANTHROPIC_DEFAULT_SONNET_MODEL`、`ANTHROPIC_DEFAULT_HAIKU_MODEL`、`ANTHROPIC_DEFAULT_FABLE_MODEL`。
  各带 `_NAME` / `_DESCRIPTION` / `_SUPPORTED_CAPABILITIES` 兄弟变量（`_NAME` 控制选择器标签）。
  → §2.5 的 `slots` 就映射到这四个。
- ✅ `CLAUDE_CODE_SUBAGENT_MODEL` 存在（二进制实测）→ `slots.subagent`。
- ✅ **`--fallback-model` 仅 `--print` 有效**（help 原文 "(only works with --print)"），
  接受逗号分隔列表按序尝试，且"每个用户轮次开始时重试主模型"。
  → 交互模式**没有**自动回退能力，别把 `models` 的优先级说成故障转移（§2.5 已写明）。
- ✅ `--effort <low|medium|high|xhigh|max>` 与 `--autocompact <auto|tokens>` 是这两个 env 的等价参数。
- ✅ `CLAUDE_CODE_EFFORT_LEVEL`、`CLAUDE_CODE_AUTO_COMPACT_WINDOW` 存在（二进制实测）。
- ✅ **自定义模型选择器确实存在**：`modelPicker` 设置键（行含 `model`/`label`/`description`/`behavesAs`，
  可 `replaceBuiltInOptions`；v2.1.242+；**只从 managed / `--settings` / 用户设置读取**）
  与 `ANTHROPIC_CUSTOM_MODEL_OPTION`（单个自定义项）。→ 见 §8 待议。
- ⚠️ `ANTHROPIC_SMALL_FAST_MODEL` **已废弃**（改用 `ANTHROPIC_DEFAULT_HAIKU_MODEL`）；
  `ANTHROPIC_DEFAULT_SMALL_FAST_MODEL` **文档中查无此物，不要写**。
- ⚠️ `ANTHROPIC_BASE_URL` 指向非一方域名时会**默认关闭 MCP tool search**（需 `ENABLE_TOOL_SEARCH=true`
  重新开启，该变量二进制中已确认存在）并**关闭 Remote Control**（v2.1.196+）。
  中转站用户必踩，README 必须写。

### 7.4 设置与优先级

- ✅ 高 → 低：managed → `--settings` → `.claude/settings.local.json` → `.claude/settings.json`
  → `~/.claude/settings.json`。
- ✅ `--settings` 是**按键覆盖**：*"Keys you omit keep their file-based values"*；会话级，不落盘。
- ✅ **`~/.claude.json` 与 `~/.claude/settings.json` 是两个不同的文件**：前者是应用状态
  （OAuth 会话、项目信任、个人 MCP、UI 开关），后者才是设置（`permissions` / `hooks` / `env` 属于后者）。
  排查"配置没生效"时先分清这两个。
- ✅ **项目/本地设置无法设置 `CLAUDE_CONFIG_DIR`**（文档明示）
  → 恶意仓库劫持不了你的 token profile。这是本方案的安全保证之一，值得写进 README。
- ⚠️ **managed 设置压过一切**（含 `--settings`）。位置：Windows `C:\Program Files\ClaudeCode\`
  + 注册表 `HKLM\SOFTWARE\Policies\ClaudeCode`；macOS `/Library/Application Support/ClaudeCode/`；
  Linux `/etc/claude-code/`。注入不生效时先查这里。
- ✅ `--setting-sources user,project,local` 控制加载哪些来源。

### 7.5 其他 CLI 事实

- ✅ 标志：`--settings <file-or-json>`、`--model <alias|full>`、`-n/--name <name>`、`--setting-sources`、
  `--fallback-model`、`--effort`、`--autocompact`、`--bg`（后台会话，配 `claude attach` / `logs` /
  `stop` / `rm`）。
- ✅ **会话续接**：`-c/--continue` = *"Continue the most recent conversation **in the current
  directory**"*；`-r/--resume [id]` 按 session ID 恢复或开交互选择器；`--fork-session` 恢复时另起
  新 session ID（与 `-r` / `-c` 同用）。
- ✅ **会话历史的归属**：`<配置目录>/projects/<cwd-slug>/<session>.jsonl`
  （本机实测：`~/.claude/projects/` 下的目录名就是 cwd 的 slug，如
  `C--Users-alice-Documents-Python-code-...`）。
  → **`-c` 的作用域是「配置目录 + 当前目录」，与 token 值无关**：
  改 `ANTHROPIC_AUTH_TOKEN` 不影响历史，`-c` 照样续上；只有改 `CLAUDE_CONFIG_DIR` 才换历史。
  **别再写成"换 token 就找不到会话"——那是 cmt 的 profile 设计带来的推论，不是 Claude Code 的行为。**
- ✅ `claude auth login|logout|status`（`--text` 出 JSON，含 `configDirectory` 字段，v2.1.268+）；
  `claude setup-token` 出一年期 OAuth token（仅订阅计划）。

**本机开发环境**（可直接实测，无需额外安装）：

- Windows 11，Windows Terminal **1.24.11911.0** 已安装且 `wt.exe` 在 PATH
- 当前 Claude 会话本身就跑在 Windows Terminal 内（`WT_SESSION` 已设）
  → §2.9 的 Windows 首选路径（`wt.exe -w cmt new-tab --title ... --suppressApplicationTitle -d ...`）
    可在本机直接验证；窗口语义（`-w` 各取值的含义、怎么数窗口）见 §7.7

### 7.6 首次启动闸门（§3.6 的依据，已逐条查证）

**闸门只有一个，而且只读 `.claude.json`。** 二进制里的判定（`q7()`）依次是：

```
if (env.CLAUDE_CODE_SANDBOXED) return true;   // 沙箱内直接放行
if (K5()) return true;                        // 已信任的旁路
if (wt()) return true;                        // 同上
let cfg = readGlobalConfig();                 // ← profile 里的 .claude.json
let key = projectKey(cwd);
if (cfg.projects?.[key]?.hasTrustDialogAccepted) return true;
return checkParents(cfg, cwd);                // 父目录继承，但只上溯到 git 根
```

**没有别的开关。** 已穷举确认：

- settings 的五个层（managed → `--settings` → `.claude/settings.local.json` →
  `.claude/settings.json` → `~/.claude/settings.json`，§7.4）
  **没有**对应键——`hasCompletedOnboarding` 与 `hasTrustDialogAccepted` 都**不是** settings 键
- 命令行**没有**跳过引导 / 跳过信任的标志
- 全部 **570** 个 `CLAUDE_CODE_*` 环境变量名**逐个枚举过**，一个都不是干这个的
  （`CLAUDE_CODE_SANDBOXED` 只在沙箱内为真，不是给用户设的）

⇒ **"不写 `.claude.json`" 与"零点击"物理上互斥。** 这不是取舍，是没有第二条路。

**父目录继承只上溯到 git 根**，不是任意祖先——所以在 `D:/work/a/sub` 启动，
若 `D:/work/a` 是 git 根且已信任，可以继承；否则必须自己有一条。
**别指望"信任一次父目录，子目录全都过"**。

**项目键的形状**（二进制 `vS(t, { foldCase: false })`）：

| 步骤 | 规则 |
|------|------|
| 1 | `String(p).normalize('NFC')` |
| 2 | `\` → `/` |
| 3 | **保留大小写** |

⚠️ `foldCase` 默认值是 `true`，但那是给**比较**用的（`oy()`）；**存储走 `false`**。
本机 `~/.claude.json` 实测：**68/68 个键保留原大小写，0 个含反斜杠，0 个小写盘符**。
写小了不会报错，只会得到一个**永不命中的键**——症状是"弹窗照旧"，
而排查的人不会想到去看大小写。

**新项目条目的标准骨架**（Claude Code 自己创建时写的形状，照抄）：

```jsonc
{
  "allowedTools": [], "mcpContextUris": [], "mcpServers": {},
  "enabledMcpjsonServers": [], "disabledMcpjsonServers": [],
  "hasTrustDialogAccepted": false,
  "hasClaudeMdExternalIncludesApproved": false,
  "hasClaudeMdExternalIncludesWarningShown": false
}
```

**`hasCompletedOnboarding` 单独就够，不需要 `lastOnboardingVersion`。**
后者在二进制里出现为**对象字面量**（`{ISSUES_EXPLAINER, PACKAGE_URL, README_URL, ...}`）
而落盘却是**字符串**，说明写它的路径不止一条、形态不可靠。
本机实测佐证：用户主配置 `hasCompletedOnboarding: true` + `lastOnboardingVersion: "2.1.156"`，
二进制已升到 2.1.251 —— 跨了好几个版本，向导再没出现过。

**引导向导会把主题写进 `settings.json`**（本机主配置里是 `"theme": "dark-daltonized"`）。
⇒ 反过来说，**"`settings.json` 里没多出 `theme` 键"就是"向导没跑过"的判据**——
§3.6 的真机验证用的正是这条。

### 7.7 Windows Terminal 的窗口语义（本机实测 2026-10-18，WT 1.24.11911.0 / Windows 11 26200）

**这节是 §2.9 那个 argv 的依据，也是"别用直觉数窗口"的教训。**

- ⚠️ **WT 1.24 把*所有*窗口放在同一个进程里。** 于是
  `Get-Process WindowsTerminal | Where-Object { $_.MainWindowHandle -ne 0 }` **恒等于 1**——
  开几个窗口都只数出 1 个。**要数窗口必须 EnumWindows 枚举顶层窗口**：

  ```powershell
  # 该进程的顶层可见窗口（= "开了几个 WT 窗口"）；GetWindow(h,4)==0 排除 owned 弹窗
  Add-Type -TypeDefinition @'
  using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
  public class WTWin {
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    delegate bool EnumProc(IntPtr h, IntPtr p);
    public static List<string> Go(uint target) {
      var res = new List<string>();
      EnumWindows((h, p) => {
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (pid == target && IsWindowVisible(h) && GetWindow(h, 4) == IntPtr.Zero) {
          var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
          res.Add(h.ToInt64() + "|" + sb.ToString());
        }
        return true;
      }, IntPtr.Zero);
      return res;
    }
  }
  '@
  ```
  > 这个坑真的害过人：用 `MainWindowHandle` 数出"始终 1 个窗口"，于是得出
  > "标签页本来就是好的、报的 bug 复现不了"——**结论完全反了**。凡是"窗口数量"类断言，
  > 先确认计数方法本身是对的。
- ✅ `-w <名字>`：**不存在就用这个名字新建一个窗口；存在就往里加标签页。** 实测连发两次
  `wt -w cmtprobeA new-tab`：第 1 次窗口数 +1，第 2 次 +0。§2.9 的 `-w cmt` 靠的就是这条。
- ✅ `-w 0` / `-w last` = **最近使用过的**窗口（不是"当前窗口"，也不是"第一个窗口"）。
  多窗口时落点取决于"上次碰过哪个"，**不可预期**。
- ✅ `-w -1` / `-w new` = **总是新窗口**。
- ✅ **`--title` 会被标签页里跑的程序用 OSC 2 覆盖**，只有 `new-tab` **之后**的
  `--suppressApplicationTitle` 能钉住它。实测 Claude Code 把 `cmt:relay-test · claude_test`
  覆盖成 `✳ cmt:relay-test`（cwd 末段丢失）。
- ⚠️ **合成 `WM_CLOSE` / `WM_SYSCOMMAND(SC_CLOSE)` 关不掉多标签页的 WT 窗口**：它会弹一个
  **渲染在窗口内部**的确认框（"是否要关闭所有标签页?"）。那个框**不是独立 hwnd**
  （不是 `#32770`），所以 `EnumWindows` 看不见、`PostMessage` 也点不到——只能靠 UI Automation
  （`InvokePattern`）去点。写"自动关窗口"的脚本时别踩。

上面这些现在都有断言兜着了：`scripts/live-terminal-check.mjs` 连开两次 `cmt run`，
用上面的 EnumWindows 量**窗口集合**，断言"第二次没有新开窗口"（§6.3）。
**动 `-w` 之前先跑它**——这条不变量光看标签页内容（env / argv）是看不出来的。

- ⚠️ **WT 会把调用方的进程环境原样转发给新标签页**（含 `wt -w <名> new-tab` 这条路）。
  这是 §2.6「继承环境的净化」的**唯一依据**，也是它必须存在的原因：`cmt run` 从 Claude Code
  会话里被调用时，新标签页拿到的就是那个会话的整套身份变量。

  复现方式（一次性探针，别留在仓库里）：写一个只做
  `JSON.stringify(process.env)` 落盘的小 .mjs，然后**从 Claude Code 会话里**执行

  ```bash
  wt.exe -w cmtprobe new-tab --title envprobe --suppressApplicationTitle -d <temp> <node> <probe.mjs>
  ```

  读回落盘的 JSON：`CLAUDE_CODE_SESSION_ID` **就是发起方的会话 id**，`CLAUDE_CODE_CHILD_SESSION=1`、
  `CLAUDE_CODE_MESSAGING_SOCKET` / `..._TOKEN`、`CLAUDE_PID`、`CLAUDE_CODE_EXECPATH`、
  `CLAUDE_CODE_ENTRYPOINT`、`CLAUDECODE` 一应俱全。

  ⇒ 推论：**"新终端 = 干净环境"是错的**。凡是把环境交给 `spawn` 的地方（§2.9 二·1 的
  `spawnTerminal`、§2.10 末的 `cmt exec`）都得自己决定传哪份环境，不能靠默认继承。

---

### 7.8 面板（全屏 TUI + 网页控制台）的 Windows 事实（🔵 **整节待真机复现**，2026-10-18 立）

**这节是 §2.12 九的依据；M8–M10 是 §2.12 十一 的依据。⚠️ 与 §7 其余条目不同：
下面没有一条在本机跑过**——它们来自 Node/libuv 的既有行为与 Windows 控制台的既有实测，一律标 🔵。
`node scripts/verify-ui-real.mjs`（§6.3 手工验）就是为这张表写的：
**跑完把标记改成 🟢 / 🔴，标 🔴 的连带改代码**（右列写着改哪一块）。
M8–M9 **暂时没有脚本**（它们是 §6.3 人工验收第 ⑥ 条里的两条，即 §4.5 的 W1/W2），
所以**它们只能是 🔵，别写成 🟢**。

> **首次跑：2026-10-18，非 TTY 会话**（`WT_SESSION=yes`，但 stdout 是管道）。
> 跑得出的只有 M1 的字节级那一半和 M2，而 **M2 在管道上结构性地测不了**（见纪律 2）。
> **M1 后半 / M2-TTY / M3 / M4 / M5 / M6 / M7 全部待人在真终端里跑 `--all`。**
> 原始证据落在 `ui-real-report.json`（**已 gitignore**：那是这台机器的实测快照，不是源码）。

★ **两条探针纪律**（都是第一次跑时踩出来的，别再犯）：

1. **判据必须是载荷的尾巴，不能是开头。** M2 第一版断言 `'exit'` 写出的那段里
   `includes('EXIT-ASYNC')`——而那串在**载荷开头**。开头那几十字节进得了管道缓冲，
   "收到了开头"证明不了"整段都送出去了"。于是那条断言**不管丢没丢都通过**，等于没测。
   改成要求**末尾的哨兵**之后才有意义（实测 200043 B 全到，一个不少）。
2. **管道测不了 TTY 的事。** Node 的 stdio 表：文件 Windows/POSIX 同步、
   **管道与套接字在 Windows 上也是同步**、**只有 TTY 在 Windows 上是异步**。
   M2 说的是 **TTY**，拿管道去测是测一个同步 fd——**两回事**。
   ⇒ 管道上"没丢"**不是 PASS**，脚本记的是 `MANUAL`。真正的判据只能是人看：
   `--all` 会开一个真控制台窗口做 **M2-TTY**（子进程进备用屏、
   在 `'exit'` 里用 `stdout.write` 发 `?1049l`，看它回不回主屏）——
   ★ 那不是"模拟"，它就是 `term.js` 出屏那一行的机制本身。

| M | 事实 | 不成立时怎么办 |
|---|------|---------------|
| M1 | ★★ **`fs.writeSync(1, '中文')` 在 Windows 上乱码**：libuv 走 `WriteConsoleW` 时会做 UTF-8→UTF-16 转换（**与代码页无关**），`writeSync` 绕过它、直接落裸 UTF-8 字节，被 CP936 按 GBK 解码。而 `stdout.write('中文')` 正常 | 两条写路径的规则（**画帧走 `stdout.write`、出屏走 `writeSync`**）要重做 |
| M2 | ★★ **Windows 上 TTY 写入是异步的**（libuv 的 IO 表：文件 Windows 同步 / **TTY Windows 异步** / TTY POSIX 同步）⇒ `process.on('exit')` 里的 `stdout.write()` **可能送不出去**。⚠️ **管道上验不出来**（管道在 Windows 上也是同步写）⇒ 判据是 `--all` 的 **M2-TTY**，不是那个管道探针 | 出屏可以简化成一条写路径——**但仍建议保留 `writeSync`**：它是 M1 的另一半，是唯一能保证"最后一次写一定送到"的手段 |
| M3 | WT 1.24 下 `─`（U+2500，UAX #11 的 **Ambiguous**）实测占几列 | **不阻塞开工**，只决定将来要不要提供 unicode 字形可选项。§2.12 五"边框只用 ASCII"的理由**不依赖这条**（那理由是"我们无法决定用户的宽度设置"） |
| M4 | `ESC [ 6 n`（CPR，光标位置报告）在 WT/ConPTY 下**有没有应答** | 探针作废，只剩目测尺子 |
| M5 | raw mode 下方向键到达的是 **`ESC [ A`**，不是扫描码 | **整个 `ui/keys.js` 的解码方案作废**——这是最坏情况，得改走别的输入通道 |
| M6 | `stdout.on('resize')` 在 WT 里可靠 | 加 250 ms 轮询兜底。**别改成"只轮询"**——resize 事件是即时的，轮询是它的补充 |
| M7 | `taskkill /F` 后**备用屏是否残留**、控制台**模式**是否自愈 | 残留 ⇒ `CMT_UI=plain` 从"逃生舱"**升级为默认**；README 必须写清"备用屏卡住怎么办" |
| M8 | ★ **Windows 上开 URL 必须走 `cmd /c start "" <url>`**——那个空 `""` 是 `start` 的**窗口标题位**：`start` 把第一个带引号的参数当标题，少了它就会把 URL 当成标题、**什么也不开**，而且**静默**。★ 另外 `start` 是 cmd 的**内建**命令，**不能** `spawn('start', …)` | 那条路开不出来 ⇒ 退回"用默认浏览器打开"（`shell: true` 或 `powershell Start-Process`）。**别改回"直接把 URL 丢给 `spawn`"**——那在 Windows 上从来没开出来过 |
| M9 | ★ **`localhost` 可能先解析到 `::1`**，而服务器绑的是 `127.0.0.1` ⇒ 用户看到「无法访问此网站」，**而地址栏里那个 URL 看着完全正常**（最难排查的一种失败） | 开的 URL 必须写 **`http://127.0.0.1:<port>/…`**，**不写 `localhost`**；而 `Host` 白名单**两种拼法都要收**（用户会手敲地址栏）。两个方向各一条测试（§2.12 十一） |
| M10 | ★ **`explorer.exe` 成功也回退出码 1**（它是把请求转给已有的资源管理器进程，自己立刻退）⇒ 等 `exit` 会把每一次成功都读成失败 | 只等 `spawn` 事件（"命令发出去了吗"），**不等 `exit`**——`platform/open-path.js` 就是这么写的。⚠️ 这条**不适用于** `open-browser.js`：那个走 `cmd /c start`，`start` 是异步的，本来就没有可等的退出码 |

**以下几条不做专门探针**（要么只能在真用中观察，要么是既定事实）：

- **raw mode 下 Ctrl+C 不是 SIGINT，是 `\x03`** ⇒ 退出清理走**解码器**那条路；
  `process.on('SIGINT')` 只是 raw mode 还没生效那段时间的保险。**两条都要有。**
- **Backspace 是 `\x08` 还是 `\x7f` 存疑** ⇒ **两个都认**。代价是丢掉 Ctrl+H 与 Backspace 的区分
  （本面板不需要）。
- **中文输入法候选框锚在光标位置** ⇒ 输入模式下必须把**真光标** `CUP` 到输入框那一格并 `?25h`。
  **这就是 `render()` 返回 `{frame, cursor}` 而不是一个字符串的原因**——
  光标的行列只能由排版的**同一份算术**得出；让它算第二遍，就是"两处各拼一遍、各错一半"的又一次复刻。
- **WT 1.24 没有 `ambiguousUnicodeWidth` 设置**（1.25 才加）⇒ `─` 这类字符的列数**不由我们决定**，
  这是 §2.12 五"结构字符不许歧义"的直接理由。**别拿"用户可以去设置里关掉"当借口。**
- **`process.stdout.columns` 在 Windows 上是"屏幕缓冲宽度"不是"可见窗口宽度"**
  （libuv 走 `GetConsoleScreenBufferInfo`，`dwSize` 与 `srWindow` 在旧 conhost 里可以不等）。
  WT 里两者恒等所以本机没事，但**这是 Windows 独有的失败模式** ⇒ 留 `CMT_UI_COLS` / `CMT_UI_ROWS` 覆盖。

**不变量（与上表无关，永远成立，有单测守着）：**

- **画帧走 `stdout.write()`、出屏走 `fs.writeSync(1, RESTORE)`，两者不可互换**（M1 + M2 合起来的结论）
- ⇒ **`RESTORE` 必须是纯 ASCII**（它走 `writeSync`，非 ASCII 必乱码）
- **面板不发 `OSC 0/2`**（不碰窗口标题）——§7.7 已记：标题是标签页的，程序去改它只会打架

---

## 八、开放问题（未决，动手前先问）

1. ~~**首次 onboarding**~~ —— **已结，见 §3.6**（编号保留，别处有 `§8.1` 的交叉引用）。
   结论：**提供 `defaults.seed`**（`off` / `onboarding` / `full`，默认 `"off"`），
   开启时由 `cmt exec` 在启动前播种 `profiles/<t>/.claude.json`。
   三条当时的判断，记下来免得将来被重新讨论一遍：

   - **"能不能不写文件"这个问题被彻底排除了**，不是没试：§7.6 穷举了 settings 五层、
     命令行标志、以及全部 570 个 `CLAUDE_CODE_*` 环境变量，**一个开关都没有**。
     ⇒ 「守住铁律」与「零点击」物理上互斥，只能二选一。用户选了后者。
   - **原设想（`cmt run --seed` 从 `~/.claude.json` 复制最小骨架）被否决。**
     那会把个人 MCP 服务器、OAuth 会话、**别的项目的信任记录**一并搬进 profile——
     既不是隔离（§1.3 第 2 条），也不是"最小骨架"。改成只写九个字段的白名单。
   - **不做成 `cmt run --seed` 标志**：`cmt run` 不知道真正的 cwd（窗口里的 `cmt exec` 才知道），
     在那里播种会留一段缝隙。而且"要不要让 cmt 动 Claude Code 的文件"是个**长期设置**，
     不是每次敲的开关——所以它进了 `config.json`。
   - 另：**`cmt doctor` 从来没有实现过**当初设想的那个"未初始化"检测（写这句话时是设想，
     一直没落地）。现在这句话在 `cmt profile path` 里，且会读 `defaults.seed` 说人话。
2. **`modelPicker` 原生选择器**：§7.3 已确认 `modelPicker` 可从 `--settings` 读取（v2.1.242+），
   意味着优先级列表有机会**原生出现在 `/model` 选择器里**，而不只是启动时选一次。
   本期按"启动时选 `models[0]`"实现；此项列为 **v1.1 候选**，动手前先问。
3. **绑定粒度**：当前绑定只认路径前缀。是否需要支持 `git` 仓库维度（识别 `.git` 上溯）或
   `package.json` 名？——**本期不做**，先看真实使用反馈。
4. **`--setting-sources`**：默认不限制来源（保留项目级配置的正常行为，用户就是要在自己项目里跑）。
   是否额外提供 `--isolated` 开关（等价 `--setting-sources user`）作为逃生舱？待议。
5. **同 token 多窗**：当前设计下共享同一 profile（等同原生多窗行为），符合预期；如需窗口级隔离再议。
6. **token 与 profile 是否解耦**：当前一 token 一 profile（§2.8），"换 key 续聊"靠
   `cmt token edit` 改现有 token 的凭证——profile 不动，历史与 `-c` 保留（§2.5）。
   另一种形态是允许两个 token **共享同一个 profile**，换 key 时不必覆盖原凭证、可来回切。
   代价是打破"一 token 一身份"的隔离不变量（§1.3 第 2 条）。**本期不做**，先看真实需求。
7. **macOS / Linux 的终端分支谁来验**：本机只有 Windows 可实测（§7.5 末），
   macOS 的 `osascript` 字符串转义、Linux 的 `$TERMINAL` 探测顺序都只能静态审查。
   选项：(a) 发 alpha 时在 README 里明标"macOS/Linux 未实测，欢迎反馈"；
   (b) 找一个 macOS / Linux 环境实测后再发。
   **v1 先走 (a)**，并在 `platform/macos.js` / `platform/linux.js` 顶部加 `// UNVERIFIED` 注释。
8. **WSL 是否算独立平台**：§2.9 三已定"绑定不互通、不做路径转换"。
   但 WSL 内能否用 `wt.exe`（经 `/mnt/c/.../wt.exe` 调 Windows 终端开窗）值得单独确认——
   **本期按 Linux 处理**（用 WSL 自带终端），不特殊适配。
9. **与 `cxt` 是否合并成一个 CLI**：当前设计是 `cmt` 与 `cxt` 各自独立、配置目录分开
   （`~/.claude-multi-token/` vs `~/.codex-multi-token/`）。
   父目录名叫 `agent_multi_token`，暗示将来可能统一成 `amt run --agent claude|codex`。
   **本期不做**——先让两个工具各自把承重原语吃透，再谈抽象。
   ⚠️ 面板、池、在场层叠加之后，支持成本涨到了 **二十三个文件**两份**逐字拷贝**
   （`ui/` 四件 + `platform/` 五件 + `web/` 三件 + `core/` 三件 + 八个共享测试，
   见 §4.1 与 §6.3）。
   这比 `parse-args.js` 那条"同源双份"的旧惯例**更严**——那份允许
   `CxtError` / `CmtError` 这类标识符分叉，而这些文件**一个字节都不许差**
   （代价是它们的注释里不许出现工具名、环境变量名、契约父节号，见 §4.1）。**合并的诱惑会变大，但结论不变**——
   合并要解决的是"两个 CLI 的身份模型不同"（`slots` vs `models`、`settings.json` vs
   `config.toml`），而那与"两个前端长得一样"无关。
10. **模型清单要不要缓存？**（§2.12 六 / 十二）**拉取不缓存、结果登记**：每次进向导仍然现拉；
    拉到的清单写进 `resources.json`，只喂下拉候选与资源表，带 `url` + `fetchedAt`、可手动刷新。
    **"拿缓存代替现拉"仍然不做**——那会把"模型列表变了"变成幽灵 bug。登记是可见、有出处的，不等同。
11. **面板要不要管 `slots`？** v1 明确不做（§2.12 十）：面板只配 `models`，`slots` 仍走
    `cmt slot set`。理由是 `fillDefaultSlots` 会拿 `models[0]` 填未设的槽，配 `models`
    已覆盖绝大多数场景；把槽位塞进向导会让两个面板分叉。**将来要做，先回答
    "槽位在向导里长什么样"**（N 个槽 × 模型列表，一屏放不下，而面板没有滚动嵌套的预算）。
12. **面板的 `e`（改模型）只改"当前生效那一层"**（§2.12 二）。多层同时存在时
    （defaults + token + binding + 项目本地），用户想改的未必是生效那层——
    但层级选择器是 `cmt model set --global|--token|--path` 的活，面板只做"最常见的那一下"。
    若真实反馈说不够，**先看能不能在详情栏把"改哪层"显示清楚**，再谈加交互。
13. **`.cmt.json` 要不要支持 `extends` / 多份逐级合并？**（§2.11）**不做。**
    发现规则是"**最近的胜出**"而不是"逐级合并"——后者会让"这个仓库到底跑的是哪套配置"
    变成一个需要推理的问题，而 `cmt resolve` 存在的全部意义正是让这个问题**一眼可见**。
14. **面板要不要认 `git` 仓库根？**（与第 3 条同源）`.cmt.json` 的发现是**纯目录上溯**，
    不识别 `.git`。好处是可预测、可解释；代价是"monorepo 里每个子包各放一份"时，
    最近的胜出可能不是你想要的那份。**本期不做**，先看真实使用反馈。
15. **两个控制台能同时跑，都写同一份 `config.json`**（§2.12 十一）。
    原子写保证**不损坏**（§3.5），但**后写赢**——A 窗口里刚点的模型优先级可能被 B 窗口盖掉。
    这与 §3.5 那条"并发读-改-写不加锁"是**同一个已接受的风险**，控制台只是让它更容易撞上
    （浏览器窗口比终端窗口更容易忘在那儿）。**本期不加锁**；真要加，先想清楚
    "面板要不要显示'配置被别处改过'"——那比加锁更接近用户真正需要的东西。
16. **路径口令会出现在进程命令行里**（开浏览器那条 argv，§2.12 十一）。
    **接受**：威胁模型是**跨源网页**，不是本机用户——能读本机进程命令行的人，
    本来就能读 `tokens/*.json`。给 `--no-open` 让口令不出终端，已经够"想避开的人能避开"。
    ⚠️ 别为了这个把口令改成"从 stdin 读"：那会把"敲一下就能用"这件事弄没，
    而那正是做控制台的全部理由。
17. **视图模型是一个无类型的跨项目接口**（§2.12 十一）。
    `ui-web.js` 两个项目各写各的，喂给**逐字一致**的 `web/app.js`——
    ⇒ cmt 漏一个字段**只会在 cmt 坏**，而 cxt 全绿。**唯一的防线是两边的黄金形状断言**（§6.3），
    所以那个键集**要同时写进两份契约**：它是接口的一部分，不是实现细节。
    ⚠️ 与之相连的一条边界：**`slots` 不许进控制台**（第 11 条）。一旦进了，
    `src/web/index.html` 就得分叉，逐字一致纪律**当场崩**。
18. ★ **改 `ui/app.js` 是"两个前端"方案里最大的架构代价**（§2.12 十一）。
    那个文件**逐字一致 ×2**，而它现在同时是 TUI 与网页控制台的 reducer——
    一个笔误就静默分叉（改了一边忘了另一边，**两边测试都绿**）。
    **兜底方案**：把 op → 事件的翻译全放进 `ui-web.js`，内核只加 `move-model`——
    但那会抄一遍 `arrows()` / `cursorOf()`，让"选中第 3 行"**有两处定义**，
    比逐字一致**更难守**。**本期选"逐字一致 + `shared-files.test.js` 当闸门"**（§6.3）。
19. ★ **会话在场层的 pid 复用**（§2.14 二）：Windows 的 pid 会被快速复用，一个 `dead` 的旧会话
    可能因为 pid 恰好被别的进程占用而被报成 `live`。本期接受（`cmt sessions` 是概览、不是审计凭证）；
    要精确需比对进程启动时间，先不引入平台专用的进程查询。
    同一节还记着两条边界：**agent 间的自动投递/自动回复**不在 v1（需自动执行体，本工具不内置，§2.14 六）；
    **跨工具总线（cmt↔cxt）**同样不做（与第 9 条同一边界）。
