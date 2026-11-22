# AGENTS.md — codex-multi-token（`cxt`）

本文件是本仓库的**架构契约**。给 Codex 的指令优先级：本文件 > 代码里的既有惯例 > 你的默认习惯。
改动架构前先改本文件，不要先改代码。

> 本仓库是 `agent_multi_token/claude code/`（CLI `cmt`）的 **Codex 兄弟项目**。骨架同源，但**承重原语完全不同**
> （Claude Code 靠环境变量 + `CLAUDE_CONFIG_DIR`；Codex 靠一份 TOML + `CODEX_HOME`）。
> **凡是本文件与 `cmt` 的 CLAUDE.md 冲突的地方，以本文件为准**——照抄 `cmt` 的设计会碎。
>
> ⚠️ 本文件同时是 Codex 会加载的 `AGENTS.md`，所以它既是契约、也是仓库指令。两条身份不冲突。

---

> ## ⚠️ 读之前：本文件会被 Codex 静默截断
>
> 本文件 ≈252 KB，而 Codex 的 `project_doc_max_bytes` **默认 32,768**——按默认配置，
> **Codex 只读到约 13% 处**（§5 命令面、§6 约定、§7 已核实事实、§8 开放问题全部读不到），
> 而且**没有任何报错**。每台开发机必须先往 `$CODEX_HOME/config.toml` 加：
>
> ```toml
> project_doc_max_bytes = 262144
> ```
>
> ⚠️⚠️ **2026-10-24：已顶到 262144，余量只剩几 KB**。别再往上调——每调一次，读契约的
> Codex 就少读到一块，而这正是本节在讲的事。**下一个大特性前必须先拆分**：把 §7 / §8
> 移进 `docs/`，主线只留 §1–§6，§7 开头留一行指路。历史记录已经这样搬走过一次
> （§4.4 → `docs/progress-log.md`）。**绝不能什么都不做**：静默截断比"文件太大报错"
> 危险得多，因为它伪装成"这份文档就是这么短"。
>
> 精确字节数别信本文里的数字——**以 `cxt doctor` 的实测输出为准**（§5、§6.3），
> 它会报出"将被截断到第 N 字节"。这条事实记在 §7.11——**自我指涉的坑，别踩第二遍**。

---

## 一、项目目标

### 1.1 要解决的问题

**Codex CLI 只有一份用户级配置。** 想同时开多个 Codex 窗口、每个窗口接不同的中转站 / 账号 / 模型，
只能反复手改同一个文件，且**全局唯一**——A 项目的 key 和 B 项目的 key 互相打架。

```bash
# 用户现在的手工做法（每次切项目都要重来一遍）
# 编辑 $CODEX_HOME/config.toml（默认 ~/.codex/config.toml）：
model          = "deepseek-flash"
model_provider = "deepseek"

[model_providers.deepseek]
name     = "deepseek"
base_url = "https://api.deepseek.com/"
env_key  = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

### 1.2 一句话承诺

> **把"全局唯一的一份 config.toml"变成"按路径解析的配置"：
> `cxt run` 在哪个目录跑，就自动套用哪个目录该用的 token / baseUrl / model。**

### 1.3 三条产品不变量

1. **一窗一 token**：窗口与 token **默认**显式绑定。未绑定时，可由 token 池**在启动前**挑一个
   （§2.15）——挑定之后整个会话只用它。不做会话内轮询、不做负载均衡、不做会话内切换。
2. **隔离彻底**：不同 token 的窗口之间，配置、登录态、会话历史互不可见。
3. **配置分层可解析**：全局默认兜底 → token 自有 → 路径绑定覆盖；任何一项都能被上层改掉，
   且**每项都能说出自己来自哪一层**（见 §2.3、`cxt resolve`）。

### 1.4 非目标（明确不做，别自作主张加）

- ❌ **不管外部 GUI**：ChatGPT 桌面端 / VS Code 扩展不认 `-c`，且它们与本工具共用同一份
  `~/.codex/config.toml`。**本工具只服务 `codex` CLI**，不要承诺"桌面端也生效"。
  > ⚠️ 这条**不**禁止**自带**界面。`cxt` 自己有两个，都算它的：
  > **① 全屏 TUI** `cxt ui`（§2.14）——跑在用户**已经打开的终端**里，不新起进程类型；
  > **② 本地网页控制台**（§2.14 十）——`node:http` 只绑 `127.0.0.1`，浏览器只是它的渲染器。
  > 两者都不碰 `~/.codex/`，也都不是"去适配别人的客户端"——别拿这条当理由把它们砍掉。
- ❌ 不做 token 轮询 / 负载均衡 / **会话内**自动切换
  > **启动前**按 `/models` 挑第一个存在的模型**不属于**这一条（§2.5「启动前校验」）：
  > 它只读不写、只发生一次、失败不阻塞启动，和"运行中换个模型接着聊"是两件事。
  > **启动前**从 token 池挑一个 token 同理（§2.15）：挑完就钉死，会话内不再看池。
- ❌ 不做代理服务本身（不管中转站的实现）
- ❌ 不加密存储 token（明文 JSON，README 明确警告）
- ❌ 不修改 Codex 本体、不 hook 其内部实现
- ❌ 不做**会话内**额度轮询，也不做计费 API 之外的额度反推。启动前的额度探测见 §2.15，
  用量统计见 §2.15 九（`cxt usage`）——两者都是**命令跑一次**，不是后台常驻。
- ❌ **不做 agent 间的自动投递 / 自动回复**：消息信箱是惰性数据、由人转达，
  工具不内置任何自动执行体（§2.16 三 / 六）。
- ❌ 不把 Redis 当主存储。池的真相永远在本地 `pool.json`；Redis 只在显式带 `--redis` 时读写（§2.15 五）
- ❌ 不引入任何 npm 运行时依赖（见 §4.3 零依赖铁律）
- ❌ **绝不写 `~/.codex/`**：用户的原始 CODEX_HOME 只读。cxt 只操作 `~/.codex-multi-token/`。
- ❌ **不生成 `[profiles.*]`**（理由见 §7.4，profile 会遮蔽 `model` / `model_provider` / `model_catalog_json`）

---

## 二、整体设计

### 2.1 会话规格：四要素（必须齐全）

启动一个 Codex 会话，需要**完整**的四项。缺任何一项都不许启动，报错要**指名缺哪一项**：

| 要素 | 字段 | 落到 Codex 的哪里 |
|------|------|------------------|
| **本地路径** | `cwd` | `codex -C <cwd>` |
| **token** | `authToken` | provider 的 `env_key` 指向的环境变量，值由 cxt 注入**进程环境** |
| **baseUrl** | `baseUrl` | `[model_providers.<providerId>].base_url`（受管区，§2.9） |
| **model** | `models[0]`（优先级最高项） | `model`（受管区）+ `-c model=` 差量 |

外加一个**派生量**（不是第五要素，因为它有默认值）：

| 派生量 | 默认 | 说明 |
|--------|------|------|
| `providerId` | `cxt-<tokenName>` | `[model_providers.<id>]` 的表名，也是 `model_provider` 的值。前缀 `cxt-` 避免撞上内置的 `openai` / `ollama` / `lmstudio` 与用户自有 provider。token 可显式覆盖 |

`cxt resolve` / `cxt run` 启动前都跑这套完整性校验，输出四要素**及其来源层**。

### 2.2 承重原语（只有四个，别再造第五个）

| 原语 | 作用 | 说明 |
|------|------|------|
| `CODEX_HOME` 环境变量 | **身份隔离** | 覆盖用户级配置目录（默认 `~/.codex`）。配置、凭证（`auth.json`）、会话历史、SQLite 状态库全部落到该目录下。这是本工具唯一的隔离手段，也是 `cmt` 的 `CLAUDE_CONFIG_DIR` 的对应物 |
| `profiles/<t>/config.toml` 的**受管区** | **静态身份声明** | cxt 写的 `model` / `model_provider` / `[model_providers.<id>]`。所有权与拼接规则见 §2.9 |
| `-c key=value` 命令行覆盖 | **差量覆盖** | 每次调用级，压过**所有**文件层（含项目级）。`--model` 之类的"临时切一下"走这里 |
| **进程环境变量** | **凭证注入** | provider 的 `env_key` 只写**变量名**，真正的 key 由 cxt 在 spawn 时注入子进程环境。**token 只有一个落盘点**（`tokens/<name>.json`） |

> **为什么凭证必须走 `env_key` 而不是 `experimental_bearer_token`：**
> 后者把 key 明文写进 config.toml。那样 key 就有了两个落盘点（token 文件 + config.toml），
> 且 config.toml 是**双作者文件**（§2.9），泄漏面与同步问题都翻倍。DeepSeek 官方脚本用
> `experimental_bearer_token` 是因为它只管一个账号；cxt 管 N 个，必须用 `env_key`。

### 2.3 配置解析级联（核心，实现时以此表为准）

优先级 **高 → 低**。解析结果必须记录每一项的来源层，供 `cxt resolve` 展示。

| 要素 | 解析顺序（左 = 优先级最高） |
|------|---------------------------|
| `cwd` | `--cwd` → 命中 token 的 `cwd` → 当前目录 —— ⚠️ **但 `token.cwd` 只在 `cxt run` 生效，`cxt exec` 下跳过**（见下方第五条）；**项目本地没有这一层** |
| `token` | `--token`（含位置参数） → **项目本地** → 路径绑定命中的 token → `defaults.token` → **无**（纯 defaults 模式） |
| `baseUrl` | `--url` → 路径绑定 → token → 全局默认 —— ⚠️ **项目本地没有这一层**（§2.13 禁 `baseUrl`） |
| `authToken` | `--token-value` → 路径绑定 → token → 全局默认 —— ⚠️ **项目本地没有这一层**（§2.13 禁 `authToken`） |
| `providerId` | **项目本地** → 路径绑定 → token → **派生** `cxt-<tokenName>`（无 token 时 `cxt-default`） |
| `wireApi` | 路径绑定 → token → 全局 → **内置 `"responses"`** |
| `models` | **项目本地** → 路径绑定 `models` → token `models` → 全局 `models`（**整体覆盖，不合并**） |
| `catalog` | **项目本地** → 路径绑定 → token → 全局（**整体覆盖**） |
| `env` | 全局 `env` ← token `env` ← 路径绑定 `env` ← **项目本地 `env`**（**按键合并**，右侧覆盖同名键） |
| `codexArgs` | 全局 `codexArgs` + token `codexArgs` + **项目本地** + 命令行 `--`（**拼接**，低 → 高） |
| `sandboxMode` / `approvalPolicy` | **项目本地** → 路径绑定 → token → 全局 → **不注入**（见下方"默认不碰"） |
| `terminalMode` | `--window`/`--tab` → `defaults.terminalMode` → 内置 `"tab"` |

> ★ **「项目本地」这一层是 2026-10-18 新加的（§2.13）**，位置固定在 **CLI 之下、路径绑定之上**。
> 它回答的是"**这个仓库**该怎么跑"，比"这个目录"（绑定）更具体、比命令行更稳定。
> 三处刻意的**缺席**（`baseUrl` / `authToken` / `cwd`）不是遗漏，是 §2.13 的安全边界——
> 那两个凭证/目的地字段一旦能从项目文件里给，克隆来的仓库就能把你的 key 送到任意主机。

四条容易踩的语义，实现时别想当然（cwd 的规则单独成节——它是全表**唯一**按入口分叉的要素）：

- **`--token` 是 token 的*名字*，`--token-value` 才是密钥本身。** 前者选身份（进而选 profile 目录），后者改凭证。
  > ★★ **但 `--token` 只换身份，不换绑定层提供的 baseUrl / authToken / providerId。**
  > 表里"绑定"排在"token"左边，所以在绑定了 `relay-b` 的目录里跑 `cxt run relay-a`，
  > 会得到 **relay-a 的 key 配 relay-b 绑定的 URL**——把 A 的凭证接到 B 的地址上。
  >
  > 这是**刻意的**（绑定描述的是"这个目录的环境"，比 token 文件更具体），但静默混用是安全坑，
  > 所以 `cxt resolve` / `cxt run` **必须告警**（`explicit-token-mixed-with-binding`）。
  > 想全用该 token 的配置：离开绑定目录，或显式加 `--url`。
  >
  > ★ **项目本地层同样触发这条告警**（§2.13 三）：`.cxt.json` 在 token 这条链上比绑定高，
  > 所以写 `"token": "relay-a"` 落在绑定了 `relay-b` 的目录里，会得到**一模一样**的组合——
  > 而它更隐蔽（用户这一轮没敲那个 flag，是仓库的文件替他做的决定）。
  > 少了这一条，`.cxt.json` 就成了绕过告警的后门。
  > ⚠️ 而**绑定自己点名的就是同一个 token** 时不报（`--token relay-b` 落在绑定 `relay-b` 上）：
  > 那是绑定自己的配对声明，不是混用。安全告警一旦有假阳性就会被无视。
- **绑定匹配永远用「调用时的 cwd」**（`--cwd` 或进程当前目录），**绝不用 `token.cwd`**——
  后者是"这个 token 默认落在哪"，拿它去匹配绑定会成环。
- **`codexArgs` 是拼接而非覆盖**：它是一串彼此独立的开关（像 `env`），不是"一组连贯的选择集"（像 `models`）。
  低层在前、高层在后，让更具体的层排在 argv 后面从而压过前面的同名参数。
- **`sandboxMode` / `approvalPolicy` 默认不注入**：它们是**仓库的安全策略**，领地属于项目级
  `.codex/config.toml`（§2.10）。cxt 贸然在用户层写一个 `sandbox_mode`，会把仓库自己声明的策略压掉——
  那是**安全回归**，不是便利。只有 token 显式声明时才写，且 `cxt resolve` 必须标红提示"这会覆盖项目级策略"。

#### ★ 第五条：`token.cwd` 只对 `cxt run` 生效，对 `cxt exec` 无效

cwd 的级联**按入口分叉**，这是全表唯一一处"同一个要素、两个入口两套规则"：

| 入口 | `token.cwd` 生效？ | 实际 cwd |
|------|:---:|---------|
| `cxt run`（弹新窗口） | ✅ | `--cwd` → `token.cwd` → 当前目录；然后经 `-C` 传给 codex |
| `cxt exec`（当前终端） | ❌ **跳过** | `--cwd` → 当前目录（**进程 pwd，不查 token**） |

**理由**：`cxt exec` 是在**已经存在的终端**里跑。用户此刻站在 `D:/random`，
把他拽到 `relay-a.cwd`（`D:/work/client-a`）会同时破坏两件事：

1. **心智模型**——shell 的 pwd 和 Codex 的工作根不一致，`git status`、相对路径、
   编辑器打开的文件全对不上；
2. **会话续接**——`resume --last` 的作用域是「`CODEX_HOME` + cwd」（§2.5、§7.6），
   cwd 被悄悄换掉 = **静默续错会话**，且没有任何提示。

`cxt run` 则相反：它要弹一个**新窗口**，没有既有上下文可以矛盾，`token.cwd` 正是
"这个 token 该落在哪"的声明——不生效反而没意义。

**两个入口因此自洽**：`run` 的流程本来就是"终端先 `cd` 到 `token.cwd`，再在窗口里调
`cxt exec`"（§2.7、§2.12），exec 不碰 cwd，正好与终端已经设好的 cwd 一致，不会二次覆盖。

> ⚠️ **实现约束**：这条分叉必须做成 `resolveCwd(input, entry)` 的显式参数，
> **不要**让 `exec` 路径"碰巧"拿到 `token.cwd` 再靠调用方不传 `-C` 来抵消——
> 那会在 `--print`、`doctor`、launch 脚本生成三条路径上各自漏一次。
> `resolve.js` 的签名应带 `entry: 'run' | 'exec'`，并有单测钉死两种入口的 cwd 结果。

**`models` 的缺省与显式空，是两件事**（与 §2.5 规则 3 配合）：

| 情况 | 含义 | 结果 |
|------|------|------|
| 三层**都没声明** `models` | 不知道用哪个模型 | **缺项**，`cxt run` 报错（§2.1） |
| 某层显式写了 `models: []` | "不注入，用 Codex 自身默认" | 合法，四要素齐全 |
| `--model <id>` | 显式指定 | 走 `-c model=<id>` 差量，**不改受管区** |

**纯 defaults 模式**（`token` 解析到「无」）：没有 token 身份，只有全局凭证。
此时 profile 目录用 `profiles/_default/`（§2.8），窗口标题 `cxt:default`。
`_default` 下划线开头，而 token 名只允许 `[a-z0-9]` 开头，**不可能撞车**。

**路径绑定匹配规则**：

- `bindings` 是数组，每项形如 `{ path, token?, baseUrl?, models?, providerId?, env? }`
- 按 **最长前缀匹配**（`D:/work/a/sub` 命中 `D:/work/a` 而不是 `D:/work`）
- **Windows 比较大小写不敏感**，分隔符先归一（`\` → `/`）再比
- 匹配不到绑定 → 直接走 token / 全局默认

### 2.4 数据模型

`~/.codex-multi-token/config.json`（**cxt 自己的状态一律用 JSON**，只有 Codex 的配置才是 TOML）：
```jsonc
{
  "version": 1,
  "defaults": {                        // 全局默认：四要素的兜底
    "authToken": "${DEEPSEEK_API_KEY}",// 支持 ${ENV_VAR} 引用；也接受明文
    "baseUrl": "https://api.deepseek.com/",
    "wireApi": "responses",
    "models": [                        // ★ 有序，越靠前优先级越高
      { "id": "deepseek-flash", "label": "Flash 1M" },
      { "id": "deepseek-v4-pro", "label": "V4 Pro" }
    ],
    "catalog": "~/.codex-multi-token/catalogs/deepseek.json",  // 可选：model_catalog_json 指向的文件
    "env": {                           // 任意环境变量逃生舱
      "RUST_LOG": "warn"
    },
    "terminalMode": "tab",             // "tab" | "window"
    "codexArgs": [],                   // 每次启动都附加的 codex 参数
    "token": "relay-a",                // 可选：没绑定的目录默认走哪个 token
    "preflight": true                  // ★ 启动前校验（§2.5）：false 关掉那次 /models 探测
  },
  "bindings": [                        // 路径 → 覆盖项（最长前缀匹配）
    { "path": "D:/work/client-a", "token": "relay-a" },
    { "path": "D:/work/client-b", "token": "relay-b", "baseUrl": "https://other.example.com/" }
  ]
}
```

`~/.codex-multi-token/tokens/<name>.json`：
```jsonc
{
  "name": "relay-a",
  "label": "阿里中转",                  // 可选，昵称：可中文、只用于展示（§2.4 末）
  "authToken": "${RELAY_A_TOKEN}",
  "baseUrl": "https://api.deepseek.com/",
  "providerId": "relay-a",             // 可选，默认 cxt-relay-a
  "wireApi": "responses",
  "cwd": "D:/work/client-a",           // ★ token → 文件夹：cxt run relay-a 的默认落点
  "models": [ /* 可选，有序，存在即整体覆盖全局 */ ],
  "catalog": "~/.codex-multi-token/catalogs/ds.json",
  "env":    { /* 可选，按键合并 */ },
  "codexArgs": []
}
```

**`config.json` 的 defaults 与"手工改 config.toml"完全等价**（照抄对照表）：

| 你的手工 TOML | 落在 cxt 配置哪里 |
|-------------|------------------|
| `model = "..."` | `defaults.models[0].id`（**不单独配**，由优先级列表首项决定） |
| `model_provider = "..."` | `defaults.providerId`（缺省则派生） |
| `[model_providers.<id>].base_url` | `defaults.baseUrl` |
| `[model_providers.<id>].env_key` | 由 cxt 生成，指向 `CXT_TOKEN_<TOKEN>`（不手配） |
| `[model_providers.<id>].wire_api` | `defaults.wireApi` |
| `model_catalog_json = "..."` | `defaults.catalog` |
| `model_reasoning_effort` / 其它 | `defaults.env` 或 token 的 `env`（逃生舱） |

**`<项目>/.cxt.json`（项目本地配置，§2.13——**它是第四层，但在项目目录里，不在上面那棵树里**）**：
```jsonc
{
  "version": 1,                        // ★ 必填，与 config.json 一致
  "token": "relay-a",                  // 引用 tokens/<name>.json 里的**名字**
  "models": [ { "id": "gpt-5.6-sol" } ],
  "env": { "RUST_LOG": "warn" },
  "sandboxMode": "danger-full-access",
  "codexArgs": []
}
```

**四层各自能写哪些字段**（`schema.js` 的 `rejectUnknownKeys` 按这张表拒绝未知键——
手写配置打错字能立刻发现，而不是被静默忽略）：

| 字段 | `defaults` | `tokens/<n>.json` | `bindings[]` | `.cxt.json` |
|------|:---:|:---:|:---:|:---:|
| `authToken` / `baseUrl` / `wireApi` | ✅ | ✅ | ✅ | ❌ **禁止** |
| `providerId` / `models` / `catalog` / `env` | ✅ | ✅ | ✅ | ✅ |
| `token`（默认走哪个 token） | ✅ | — | ✅ | ✅ |
| `cwd` | — | ✅ | — | ❌ **禁止** |
| `codexArgs` | ✅ | ✅ | — | ✅ |
| `sandboxMode` / `approvalPolicy` | ✅ | ✅ | ✅ | ✅ |
| `label`（token 昵称，§2.4 末） | — | ✅ | — | — |
| `terminalMode` / `codexBin` / `preflight` | ✅ | — | — | ❌ **禁止** |
| `version` | — | — | — | ✅ **必填** |

> ★ `label` **只属于 token**：它不进 `COMMON_KEYS`，所以写进 `defaults` / `bindings[]` /
> `.cxt.json` 会被 `rejectUnknownKeys` 直接拒绝。它是**昵称**（可中文），**不参与身份**——
> 不进路径、不进 profile 名、不进窗口标题、不进环境变量。**机器身份永远是 `name`。**
> `preflight` 是**机器级偏好**（§2.5）：只住在 `defaults` 里，别放进 token / 绑定 / 项目文件——
> "这台机器要不要在启动前摸一下网络"不是某个仓库该决定的事。

> ★ **`.cxt.json` 那一列的四个 ❌ 是本节最重要的东西**，理由在 §2.13。
> 实现上它**不是**"少写几个分支"——`normalizeProjectConfig()` 必须对这四类键
> **主动报错并指名**，因为静默忽略会给出一个"看起来配了、其实没生效"的假象。

三条刻意的不对称，别"补全"它们：

- **`defaults` 没有 `cwd`**：cwd 的级联是 `--cwd` → `token.cwd` → 当前目录（§2.3），
  且 `token.cwd` **只对 `cxt run` 生效**（§2.3 第五条）。
  凭空多一层"全局默认落点"只会让"我在哪跑"变得难猜。
- **`bindings[]` 没有 `cwd`**：绑定回答的是"**这个目录**用哪个 token"，不是"去哪个目录"。
- **`bindings[]` 没有 `codexArgs`**：绑定是"选身份"，不是"调行为"。

**`${ENV_VAR}` 引用的求值规则**（写死，别含糊）：

- **求值时机**：`cxt exec` 注入环境之前，从**新窗口的进程环境**读取。
- **只认整串引用**：`"${DEEPSEEK_API_KEY}"` ✅；`"sk-${VAR}"`、`"${A}${B}"` ❌ → **报错**。
  绝不把 `${...}` 当字面量留在 token 里。
- **未设置时**：报错，退出码 1，消息里指名变量（`引用的环境变量 DEEPSEEK_API_KEY 未设置`）。
  **绝不静默回退成字面量 `"${DEEPSEEK_API_KEY}"`**——那会变成一个恒被拒绝的假 token，最难排查。
- **展示时**：`cxt resolve` / `--print` 只标注「已设置 / 未设置」，**不打印值**。
- **`resolve.js` 只识别不求值**——它必须在环境变量没设置时也能跑出完整结果，
  否则 `cxt resolve` 就没法告诉你"哪一项没设置"。真正求值的是启动路径（`cxt exec`）。

**`label`（token 昵称）**（`normalizeTokenLabel()`，`core/schema.js`）：只接受字符串；
`trim()` 后为空 ⇒ **视为未设置**（调用方**删键**，绝不写 `""`）；≤32 个**码点**
（`Array.from().length`，一个 emoji 不算两个）；**单行**——拒绝 C0 控制字符与 DEL；
错误消息**只谈 label、不打印原值**；允许中文与空格，**不唯一**（身份仍是 `name`）。

### 2.5 模型 list = 有序优先级

**`models` 是有序优先级表，`models[0]` 优先级最高**，它就是本次会话的默认模型。

选择规则：
1. `--model <id>` 显式指定 → 走 `-c model=<id>` 差量（**不落盘**）
2. 否则 → `models[0]`（**不交互提问**；要挑用 `--pick`）
3. `models` 为 `[]` → 不注入模型，用 Codex 自身默认
4. `models` 字段不存在 → 继承上层

> ⚠️ **"优先级"不等于自动故障转移。** cxt **不实现**任何自动回退——Codex 没有等价的
> `--fallback-model` 机制，别假装能做到。`models[1..]` 的用途是**人工提拔栈**。
> 唯一的例外是**启动前那一次校验**（下一小节），它不是故障转移。

#### 启动前校验（不是故障转移）

`cxt exec` 在**真正启动之前**拉一次 `GET {baseUrl}/models`（**2 秒**超时），从 `models`
里挑第一个**确实存在**的：

| 情况 | 行为 |
|------|------|
| `models[0]` 在清单里 | 原样启动，**不提示**（绝大多数时候） |
| `models[0]` 不在、`models[k]` 在 | 本次改用 `models[k]`，stderr 打一行黄色 `cxt:`；**不写任何文件** |
| 一个都不在 | 仍按 `models[0]` 启动，打一行说明 |
| 拉取失败 / 超时 / 没有 `/models` | **静默**按配置启动（内网端点这是常态） |

四条边界，缺一条它就会变成别的东西：① **只读**——不写配置、不写 `resources.json`、
不碰受管区；② **只做一次**，不做会话内重试（那就成自动故障转移了，§1.4 明令不做）；
③ **只在真实启动路径做**，`--print` 不联网（诊断视图要秒回）；
④ 可关——`defaults.preflight: false`（机器级偏好，默认 `true`）。

⚠️ `--model <id>`（`source === 'cli'`）**不参与**校验：那是用户这次点名要的。
⚠️ 选中的模型走 `-c model=<id>`（与 `--model` 同路），**受管区照常写 `models[0]`**。
⚠️ 纯逻辑在 `core/models.js::chooseAvailable(models, availableIds)`：首位命中不动；否则把
第一个命中的**提到首位**（其余保序，与 `model next` / `model use` 同语义）；全不命中就
原样返回——**绝不**挑一个不相干的模型。

> ★★ **受管区里写的永远是 `models[0]`（配置值），不是本次生效的模型。**
> 规则 1 的"不落盘"要**两边都对**才成立，施工时两种错法都踩过：
>
> | 错法 | 后果 |
> |------|------|
> | 把本次生效的模型写进受管区 | 差量落盘了。下次不带 `--model` 再跑，cxt 会把它当配置改回去——**cxt 自己制造一份"漂移"** |
> | 干脆不写 `model` 键 | 拼接器会把文件里原有的 `model = ...` **删掉**。"这一次换个模型"顺手抹掉了持久配置，同样要再跑一次才恢复 |
>
> 正解是**两者分离**：受管区照常写 `models[0]`，本次覆盖交给 `-c model=<id>`。
> 一句话——**受管区只反映"配置里怎么写的"，不反映"这一次敲了什么"**。
> 测试要同时钉住这两侧，只断言 `args` 一侧会让上面第一种错法溜过去（真溜过一次）。

#### `--pick` 的语义（一次性覆盖，绝不落盘）

`--pick` 打开一个**交互式选择器**，从当前生效的 `models` 里挑一个，**只作用于本次启动**：

| 方面 | 规定 |
|------|------|
| 选项来源 | 当前路径**已解析出的** `models`（三层级联之后的那一份，不是全局那份） |
| 选中效果 | 等价于 `--model <选中的 id>`——**走 `-c` 差量，不写任何文件** |
| 列表为空 | `models` 为 `[]` 或不存在 → **报错退出（码 1）**，提示 `cxt model set ...`。**不要**退化成"让用户手敲一个 id" |
| 列表只有一项 | 仍然弹选择器（**不做"只有一项就自动选"的优化**）——那会让 `--pick` 在只有一项时静默变成 no-op，用户以为坏了 |
| 与 `--model` 同用 | **冲突，报错退出（码 1）**。两个都是"显式指定模型"，语义重叠，别定义优先级 |
| 与 `--print` 同用 | 合法：先选，再打印将要执行的命令 |
| **非 TTY**（管道 / CI / `--json`） | **报错退出（码 1）**，并提示改用 `--model <id>`。**绝不**静默取 `models[0]` |

**为什么强调"不落盘"**：`--pick` 是**临时**选择。想改默认请用 `cxt model use <id>`
（§2.5 工作流）——那是显式写盘的操作。两者**刻意分开**，避免"我随手挑了一下，
下次它自己变了"这类最难排查的隐式状态。这也是 §2.8 "没有 `cache/` 目录"的同一条原则：
**cxt 不记忆任何跨会话选择**。

实现上 `--pick` 是**读取 stdin 的极简 TUI**（几十行，数字键选择即可），
**不引入交互库**（§4.3 零依赖铁律）。

#### 模型切换工作流（人工故障转移 —— 本项目的一等场景）

```bash
# models[0] 不可用 → 提拔下一个优先级 → 同路径重启并续上刚才的会话
cxt model next      # 优先级列表轮转，下一个候选成为 models[0]
cxt run -c          # 新窗口，codex resume --last 继续该目录最近一次会话
```

- **`cxt model next`**：把列表**轮转**——`models[0]` 移到末位，原 `models[1]` 升为 `models[0]`。
  轮转而非删除，所以反复切换不会把候选耗光。
- **`cxt model use <id>`**：把指定模型**提到首位**，其余保持相对顺序（原首位退到第二，便于切回）。
- **`cxt run -c`**：给 codex 传 `resume --last`，继续**当前目录**最近一次会话（§7.6）。

**两条运算的边界**（都实现为纯函数，`core/models.js`）：

| 情形 | `next`（轮转） | `use <id>`（提拔） |
|------|---------------|-------------------|
| 空列表 | **报错退出（码 1）**，提示先 `cxt model set` | 结果 `[{id}]`——新候选不必先 `model set` 一遍 |
| 只有一项 | **报错退出（码 1）**："没有下一个" | 该项已在首位 → 内容不变，**报成功** |
| id 不在列表 | —（轮转不看 id） | **插到首位**，长度 +1 |
| 已在首位 | 轮转后变成末位（正常轮转） | **内容不变的 no-op**，报成功 |
| 传 `[]` 作为显式空 | 报错（同"空列表"） | 插到首位（`[]` 只是没候选，不是禁止） |

- **`next` 在少于两项时为什么报错而不是 no-op**：单元素列表"轮转"完还是它自己，
  用户敲完命令看不出任何变化，会以为工具坏了。**宁可明确报错**——这与上表 `--pick`
  "只有一项仍弹选择器"是同一条原则的两面：**别让一个动作静默地什么都不做**。
- **`use` 已在首位为什么算成功**：与 `next` 相反，这里用户要的**状态已经成立**，
  报成功是诚实的；而 `next` 的用户意图是"换一个"，没换成必须说。
- `use` 插入新条目时**不编造 label**；从已有条目提拔时 **label 跟着走**。
- 两条运算都**不落盘、不改入参**（返回新数组）——写哪一层是 CLI 的事（见下表）。

**`cxt model next` / `use` 写入哪一层**（默认按当前目录，可用 flag 显式指定）：

| flag | 写入目标 |
|------|---------|
| `--global` | `config.defaults.models` |
| `--token <t>` | `tokens/<t>.json` 的 `models` |
| `--path <p>` / 无 flag | `bindings` 中该路径的 `models`；**无匹配绑定则自动创建一条** |

若该路径原先继承 token / 全局的列表，`cxt model next` 会**物化**一份路径专属列表
（复制当前生效列表再轮转）。`cxt resolve` 会把来源层标为 `binding`——
变化显式可见，不做隐式魔法。

> ⚠️ **`resume --last` 的作用域是「CODEX_HOME + 当前目录」，与 token 值无关。**
> 会话历史存在 `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`。所以：
> - ✅ **只改 `authToken`（CODEX_HOME 不变）→ `resume --last` 依然回到原会话**
> - ❌ 改了 `CODEX_HOME`（换 profile）→ 那是另一份历史，`resume --last` 找不到
>   （`codex resume --all` 也不行——它跨的是**目录**，不是 CODEX_HOME）
>
> **在 cxt 里**，因为设计上"一 token 一 profile"（§2.8），**切到另一个 token 会连带换掉 CODEX_HOME**，
> 于是续聊失效。想换 key 又要续聊，正确做法是**改现有 token 的凭证**：
> `cxt token edit <name> --token <新值>`——profile 目录不动，历史与 `resume --last` 全部保留。
> **别用"切到另一个 token"来做换 key**，那是换身份，不是换钥匙。

### 2.6 注入清单（唯一来源：`core/resolve.js`）

| 注入项 | 来源 | 通道 |
|--------|------|------|
| **环境变量** `CODEX_HOME` | `profiles/<token>/` | 身份隔离（承重） |
| **环境变量** `CXT_TOKEN_<TOKEN>` | `authToken` | provider 的 `env_key` 指向它；**唯一的凭证注入点** |
| **环境变量** `env.*` | `env` | 逃生舱，任意键 |
| **环境变量** `CXT_SESSION_ID` | 会话 id（§2.16） | 由 `cxt exec` 在 `buildSessionEnv()` **之后**盖上——它是本工具的会话标记，不是解析产物；`msg send` 靠它识别发送者 |
| **受管区** `model` | `models[0]` | `profiles/<t>/config.toml`（§2.9） |
| **受管区** `model_provider` | `providerId` | 同上 |
| **受管区** `[model_providers.<id>]` | `baseUrl` / `wireApi` / 生成的 `env_key` | 同上 |
| **受管区** `model_catalog_json` | `catalog`（可选） | 同上；文件由 cxt 生成 |
| **参数** `-C <cwd>` | `cwd` | 工作根目录 |
| **参数** `-c model=<id>` | `--model` 差量 | 仅当命令行显式指定 |
| **参数** `-c sandbox_mode=` / `-c approval_policy=` | `sandboxMode` / `approvalPolicy` | **仅当显式声明**（§2.3 第四条） |
| **参数** `codexArgs` | 各层 `codexArgs` | 追加到命令行 |

**环境变量名的生成规则**：`CXT_TOKEN_` + token 名的大写（`-` → `_`）。
例：token `relay-a` → `CXT_TOKEN_RELAY_A`。纯 defaults 模式 → `CXT_TOKEN_DEFAULT`。

> ⚠️ **别用 `OPENAI_API_KEY` / `CODEX_API_KEY` 之类的通用名。**
> 它们是 Codex 自己的约定变量，注入会与 Codex 的认证优先级打架；
> 且 `shell_environment_policy` 默认会剥掉名字含 `KEY`/`SECRET`/`TOKEN` 的变量再交给子进程，
> 用一个 cxt 专属前缀能让"谁注入的"永远可辨认。

#### 继承环境的净化（`SESSION_MARKER_ENV` + `unset`）

**核心不变量：`cxt run` / `cxt exec` 的结果，不许取决于它是从哪儿被调用的。**

新会话的环境**不是**从零开始，而是**继承**来的（终端进程、父 shell、`cxt run` 的调用方）。
所以注入清单只描述"我们**加**什么"是不够的——还得说清"我们**删**什么"：

```
新会话环境 = 继承环境（剔掉会话标记） → 删掉 cxt 明确不注入的项（unset） → 盖上注入项
```

顺序要紧：**先删，再盖**。`injection.env` 永远最后生效，所以 `env` 逃生舱能盖回来任何一项。

**为什么必须净化**：`wt.exe` 的交接桩**不吞环境变量**——它把调用方的环境**原样转发**
给新标签页（§7.14 实测）。"不吞"对隔离测试是好消息，但它同时意味着
**"新终端 = 干净环境"是错的**：`cxt run` 从某个 codex 会话里被调用时，
新标签页拿到的是**那个会话的整套身份**。三处后果，按严重度排：

| 漏进来的东西 | 后果 |
|-------------|------|
| `CODEX_SQLITE_HOME`（指向**别的** profile 的状态库） | 新会话把状态写进另一个 token 的库——隔离不变量（§1.3 第 2 条）**静默失效** |
| `CXT_TOKEN_<别的 token>` | **两个 token 的密钥同时躺在同一个进程环境里**。本次会话只用一个，另一个纯属泄漏 |
| `CODEX_SESSION_ID` / `CODEX_THREAD_ID` / `CODEX_TOOL_CALL_ID` | 新会话顶着父会话的身份，`resume` 之类按 id 找会话的路径会串 |

`SESSION_MARKER_ENV`（`core/resolve.js`，`stripSessionMarkers()` 照它剔）：

| 变量 | 为什么是"身份" |
|------|---------------|
| `CODEX_SESSION_ID` | 父会话的会话 id |
| `CODEX_THREAD_ID` | 父会话的 thread id |
| `CODEX_TOOL_CALL_ID` | 父会话**当前正在跑的那次工具调用**的 id |
| `CODEX_SANDBOX` | "我这个进程在沙箱里" |
| `CODEX_SANDBOX_NETWORK_DISABLED` / `CODEX_SANDBOX_LAUNCH_COUNT` | 同上，沙箱状态 |
| `CODEX_STARTING_DIFF` / `CODEX_SNAPSHOT` | 父会话启动时的仓库快照 |
| `CODEX_ROLLOUT_TRACE_ROOT` / `CODEX_TUI_RECORD_SESSION` | 父会话的记录落盘位置 |
| `CODEX_DAEMON_JUNCTION_LINK` / `CODEX_PERMISSION_PROFILE` | 父进程的 daemon 连接与权限档 |
| `CODEX_SQLITE_HOME` | 父 profile 的状态库目录（上表第一行） |
| `CXT_SESSION_ID` | 父会话的 cxt 在场 id（§2.16）——嵌套 `cxt run` 会带着它，让新窗口的 `msg send` 把 `from` 认错会话 |

> **这份名单的来源**：从 `codex.exe` 里提取的 `CODEX_*` 字符串全集，逐个按上面的判据筛。
> ⚠️ **"codex 读这个变量"与"codex 把它导出给子进程"是两件事**，本机没有可靠手段把后者
> 单独测出来（`codex sandbox <cmd>` 探针只回 `CODEX_MANAGED_BY_NPM` /
> `CODEX_MANAGED_PACKAGE_ROOT` 两个 npm 转发脚本加的，不是会话标记）。
> 所以**名单按"宁可多剔"取**：多剔一个配置类变量的代价，是它下次被 `injection.env` 盖回来；
> 漏剔一个身份变量的代价，是隔离静默失效。两边不对称，所以偏保守。
> ⇒ 将来若真测出某个名字纯属配置，**按判据把它移出名单并在这里记一笔**，别默默删。

**明确不在表里的两个**（别"顺手"加进来）：

- **`CODEX_HOME`** —— 它是 cxt **自己的**注入项（身份隔离，§2.2），不是 codex 打的标记。
  它会被 `injection.env` 重新盖上，剔它属于"看起来对、其实是把承重原语当噪声"。
- **`CODEX_MANAGED_BY_NPM` / `CODEX_MANAGED_PACKAGE_ROOT`** —— npm 全局安装的
  转发脚本（`codex.cmd`）加的，描述"codex 装在哪"，是**配置**不是身份。

> **判据（将来加新标记照这条判）：值描述的是*某一个正在跑的进程 / 会话*——
> PID、会话 id、thread id、管道、端口、快照、记录路径——就**剔**；
> 值是*配置*（模型、沙箱档位、安装位置、开关）就**留**，那属于 cxt 该管的，
> 该管的会覆盖它。**

**`CXT_TOKEN_*` 按前缀整族清掉，不逐个列名。** 名字是 `CXT_TOKEN_` + token 名大写（§2.6 开头），
而**同时只允许存在当前 token 的那一个**。列名做不到这件事——token 名是用户起的，无边界；
前缀是 cxt 自己的命名空间，一个 `startsWith` 就够。清完之后 `injection.env` 会把正确的那一个盖回来。

**`unset`：cxt 明确决定不注入、所以继承来的值也不许顶上来。** 与 `CXT_TOKEN_*` 不同，
`unset` 由**解析结果**决定（`buildInjection()` 顺带产出），是一份变量名清单。

> ⚠️ **cxt 目前只有一处来源，这是如实记录，不是设计残缺。**
> `cmt` 那边有三处（认证二选一、模型槽位、显式空列表），因为它的注入面有"选择"；
> cxt 的注入面是**确定的**——`CODEX_HOME` 恒注入、凭证变量恒注入（§2.6 表）。
> 没有选择，就没有"没选中的那个"。**留着这个字段是为了接口形状**：
> 净化必须有一条**显式的"不注入"通道**，否则将来加认证档位 / 沙箱档位时，
> 会重蹈"不注入 = 用继承来的"这个覆辙（`cmt` 就是在那儿栽的）。

| 来源 | 例子 | 为什么 |
|------|------|--------|
| `env` 逃生舱里**显式置空串** | `env: { FOO: "" }` → `unset: ['FOO']` | ★ 空串在 Windows 上等于"删掉这个变量"，在 POSIX 上却是个**真的空值**——跨平台语义不一致。一律按"删"处理，两边才一致 |

> **`FOO: ""` 这条也是"删掉继承来的变量"的**唯一**通道**——没有它，
> 用户配了 `env` 也只能**加**变量，无法把父会话漏进来的某个变量请出去。
> 判据落在 `mergeEnv()` 之后的 `env.value` 上：**空串就是"删"**。

**`unset` 只覆盖 cxt 自己管理的变量。** `OPENAI_*` / `CODEX_API_KEY` 这些 cxt 不碰的，
继承就继承——那张表无边界，管不过来。（`CODEX_*` 里 cxt 不认识的同理，靠上面的判据逐条加。）

**`cxt run` 只剔标记，不盖注入项**（§2.12）。标签页的环境只是个**载体**：
往里面塞 `injection.env` 等于让 token 在窗口的 shell 里多出一份，
还把求值点从"新窗口里"挪到了"`cxt run` 这一侧"，与 §2.4「引用跨得过进程边界，
密钥跨不过，求值发生在新窗口里」直接冲突。真正的 codex 环境由窗口内的 `cxt exec`
用 `buildSessionEnv()` 算。

**两个入口点都是纯函数**（`core/resolve.js`）：

```js
stripSessionMarkers(env)                        // 剔标记 + 清 CXT_TOKEN_*，**返回新对象，绝不改入参**
buildSessionEnv({ base, injection })            // 剔标记 → 删 unset → 盖 env
```

> ⚠️ **"返回新对象"是硬要求，不是洁癖**：`cli/main.js` 的 `makeCtx()` 传进来的 `ctx.env`
> **就是 `process.env` 本身**（按引用）。就地 `delete` 会把 **cxt 自己的**进程环境改掉——
> 之后所有命令、所有 spawn 都在一个被悄悄动过的环境里跑。

### 2.7 数据流

```
cxt run relay-a
  │
  ├─ 0. 发现项目本地配置（§2.13）：`--config <p>` 显式给，否则从 cwd 往上找**最近的** `.cxt.json`
  ├─ 1. 解析四要素（§2.3 级联，含项目本地层），记录每项来源层
  ├─ 2. 完整性校验 → 缺项则报错指名（§2.1）
  ├─ 3. 确保 profile 就绪：profiles/relay-a/ 存在 + 受管区已同步（§2.9）
  ├─ 4. 探测终端 → spawnTerminal({ title, cwd, argv }, 净化后的环境)（§2.11 二·1，无脚本）
  │     └─ 兜底路径才落盘 profiles/relay-a/launch.{cmd,sh}（§2.12）
  └─ 5. 无状态写入（不记忆选择，§2.5 规则 2 已确定默认模型）

新窗口内：cxt exec relay-a → 注入环境 + 同步受管区 → 启动 codex（cwd 已由终端设好，
               exec **不再**应用 token.cwd，见 §2.3 第五条）
```

> ⚠️ 第 0 步在**新窗口里会重跑一遍**——新窗口的 cwd 就是 `token.cwd`，
> 于是可能发现**另一份** `.cxt.json`。这是**预期行为**（项目本地配置本来就跟着目录走），
> 但意味着 `cxt run` 与窗口里那次 `cxt exec` 的解析结果**可以不同**。
> 想让两者一致，用 `--config` 把路径钉死；`cxt run --print` 会把第 0 步的发现结果印出来。

**关键设计：launch 脚本不内联 token。** 它只调用 `cxt exec`（写绝对路径，不依赖 PATH），
由 `cxt exec` 在进程内注入环境后 `exec` 掉 codex。理由：token 只有一个落盘点
（`tokens/<name>.json`），不会在 profile 目录里多出第二份明文副本。

### 2.8 运行时数据目录布局

```
~/.codex-multi-token/                  # 根目录，所有路径常量集中在 core/paths.js
├── config.json                        # 全局默认 + 路径绑定表
├── tokens/
│   └── <token>.json                   # 每 token 一份，文件名 = token 名
├── catalogs/
│   └── <name>.json                    # 可选：model_catalog_json 指向的模型目录（§7.5）
├── profiles/
│   ├── <token>/                       # ← CODEX_HOME 指向这里，Codex 自行填充
│   │   ├── config.toml                #   ★ 双作者文件：cxt 写受管区，Codex 写 [projects.*]（§2.9）
│   │   ├── auth.json                  #   凭证（Codex 所有）
│   │   ├── sessions/YYYY/MM/DD/       #   会话历史 rollout-*.jsonl（Codex 所有）
│   │   ├── history.jsonl              #   命令历史（Codex 所有）
│   │   ├── log/                       #   日志（Codex 所有）
│   │   ├── *.sqlite                   #   状态库（Codex 所有）
│   │   └── launch.cmd | launch.sh     #   ★ cxt 生成的兜底启动脚本
│   └── _default/                      #   纯 defaults 模式（没有 token 身份时）的落点，§2.3
└── sessions/                          # ★ 在场层与消息信箱（§2.16）：<id>/meta.json + inbox/ + read/
                                       #   ⚠️ 与 profiles/<t>/sessions/（Codex 的会话历史）**无关**
                                       #   ——同名不同物，别在文档/代码里混用
```

> **`_default` 是保留名。** `validateTokenName()` 只认 `[a-z0-9]` 开头，
> 所以这个名字**不可能**与真实 token 撞车——有测试守着这条不变量。

> **没有 `cache/` 目录**——本设计不记忆任何跨会话状态（§2.5 规则 2 让"上次选择"变得多余）。
> 不要为了"记住上次用的模型"再加回来。**"上次用的模型"仍然不记**；模型清单有一份
> **可见、可刷新**的登记（§2.14 六 / 十一），但它**从不代替现拉**。

> **`.cxt.json` 也不在这棵树里。** 它在**项目目录**里（§2.13），生命周期跟着那个仓库走。
> ⇒ `cxt token rm --purge` 不碰它；把 `~/.codex-multi-token/` 整个删光，它还在。
> 这是刻意的：它是**仓库的**声明，不是 cxt 的状态。

**profile 与工作目录是 1:N。** 同一 token 在多个目录启动时**共用同一个 profile**，
Codex 在 `sessions/` 下按日期、在 `[projects.*]` 里按路径分别记账。推论：

- `codex resume --last` 只续**当前目录**的历史（§7.6），同一 token 在别的目录的会话互不干扰。
- 换 token 才是换 profile / 换整份历史；换目录只是换 profile 里的一个子目录。
- 因此**不要**把 cwd 编进 profile 目录名——profile 按 token 命名，永远只按 token 命名。

**token 名约束**：`^[a-z0-9][a-z0-9_-]{0,31}$`。
它是目录名、文件名、环境变量名、窗口标题的一部分，必须校验；
**必须拒绝路径穿越**（`..`、`/`、`\`、盘符）。

> ★★ **顺序要求：先校验名字，再查表。**（施工时踩过）
>
> `resolve()` 里 `--token ../etc` 若不校验就直接查表，会走到"表里没有 → 报 token 不存在"。
> 于是**安全性碰巧成立**（没查到就不会去拼路径），但报错信息会建议用户
> `cxt token add ../etc ...`——既误导，又把安全押在"表里恰好没有"这个巧合上。
> 将来任何一条按文件名直接读的路径（`readToken(home, name)`）都会让穿越变成真的。
>
> 校验放在**解析的入口边界**，安全性就不再依赖下游的巧合。
> 注意 `defaults.token` / `binding.token` 已被 `normalizeConfig()` 校验过，
> 只有命令行能注入未校验的名字——但**统一在 resolve 里校验一遍**更省心，
> 且代价为零（`validateTokenName` 是纯函数）。

### 2.9 ★ `config.toml` 的所有权与受管区（Codex 专有，最容易写错的一节）

**这是本项目与 `cmt` 最大的结构差异。** `cmt` 靠环境变量注入、一个配置文件都不写；
cxt 必须写 `profiles/<t>/config.toml`，而**Codex 也在写同一个文件**。

#### 两个作者

| 作者 | 写什么 |
|------|--------|
| **cxt** | **受管区**：顶层 `model` / `model_provider` / `model_catalog_json` + `[model_providers.<providerId>]` 整段 |
| **Codex** | `[projects.'<path>']` 信任记录（§2.10，**反斜杠 + 字面字符串**），以及未来版本它自己想写的任何键 |

#### 四条铁律（违反即 bug）

1. **cxt 只改受管区的键。** 其余内容**逐字节保留**——注释、空行、缩进风格、未知键、
   `[projects.*]`、用户手写的任何东西。**不许"顺手规范化"整个文件。**
2. **cxt 永不删除 `[projects.*]`。** 那是用户的信任决定，删掉等于让用户重新确认一遍。
3. **cxt 永不删除整个 `config.toml`。** 只增改，不删文件。
4. **首次写入前一次性备份**为 `config.toml.cxt.bak`（已存在则不覆盖），并在 `cxt doctor` 里报告备份路径。

#### 实现：行级拼接器，**不是** TOML 解析器

`core/toml-splice.js`。**为什么不做通用 TOML 解析 + 重序列化：**

- 零依赖铁律下没有 TOML 库可用（`node:` 里没有 TOML）
- 更致命的是：**解析再序列化会丢掉注释与键序**，等于每次 run 都毁掉用户和 Codex 写的内容。
  对一个双作者文件，这是不可接受的。

**算法**（照抄 DeepSeek 官方 setup 脚本 v1.4.0 的成熟做法，本机实测其产物）：

1. 逐行扫描，跟踪**当前 section header** 与**多行值状态**（数组 / 内联表跨行）
2. 命中 cxt 受管的 **section header** → 跳过整段（含其下所有行），稍后用新内容重写
3. 命中 cxt 受管的**顶层键** → 就地替换该行（若是多行值，消费掉整个值块）
4. **其余行原样输出**
5. 缺失的受管键 → 插在**第一个 section header 之前**
   （保证它们确实是顶层键；若插在 section 之后就变成那个 section 的键了——这是个静默语义错误）
6. 输出 UTF-8 **无 BOM**、LF 换行

**必须带单测的边界**：多行数组值、内联表值、`[section]` 与 `[[array-of-tables]]` 的区分、
带引号的 section 名（`[projects.'D:\a b']`——**注意这里是反斜杠 + 字面字符串**，见 §2.11 三·1）、
注释行、文件末尾无换行、受管键在文件中出现两次（应报错而非静默取第一个）。

#### 受管键清单（写死，别扩大）

- `model`
- `model_provider`
- `model_catalog_json`（**仅当** token 声明了 `catalog`）
- `[model_providers.<providerId>]`：`name` / `base_url` / `env_key` / `wire_api`，
  可选 `http_headers` / `env_http_headers` / `requires_openai_auth` / `request_max_retries` /
  `stream_max_retries` / `stream_idle_timeout_ms`

> ★ **受管区里一个 `null` 都不许有**（施工时踩过）。TOML 没有 null，所以
> "这一项还没解析出来"的正确表达是**整条键不写**，不是 `base_url = null`。
>
> 这道规矩的真实作用不是洁癖，而是**让 `cxt resolve` 能在四要素不齐的配置上跑起来**——
> 那正是它最该干活的场景。漏了它，resolve 会在最该诊断的时候抛一个 `toml-value.js`
> 的错，把"缺哪两项"这个真正的问题盖得一干二净。
>
> ⚠️ **别把这道保险下沉到 `toml-splice.js`**：那里的 null 报错是**守卫**，它刚抓出过这个
> bug。生产侧负责不产出 null，消费侧负责拒绝 null，两边都做对才叫防御；
> 把守卫改成静默跳过只是把 bug 藏起来。

#### 明确**不碰**的键（列出来，防止"顺手写一下"）

- `approval_policy` / `sandbox_mode` / `sandbox_workspace_write.*`
  —— 领地属于**项目级**（§2.10）。用户级只在 token 显式声明时才写（§2.3 第四条）
- `[projects.*]` —— Codex 的
- `[profiles.*]` 与顶层 `profile` —— 🟢 **理由已更新（§7.4）**：在 0.163.0 里这是
  **legacy 形态**，与 `-p/--profile` 同用会**硬失败**（`--profile X cannot be used while
  ... contains legacy [profiles.X] config`）。cxt 一旦写进去，用户想用 `-p` 就炸。
  ⇒ **绝不写**。新形态是独立文件 `$CODEX_HOME/<name>.config.toml`（那是另一条通道，见 §7.4）
- `openai_base_url` / `chatgpt_base_url` —— 全局端点劫持键，绝不写（§7.3）
- **会覆盖模型元数据的那批键**（DeepSeek 脚本显式删除的清单）：
  `model_context_window`、`model_auto_compact_token_limit`、`model_auto_compact_token_limit_scope`、
  `base_instructions`、`model_instructions_file`、`compact_prompt`、
  `experimental_compact_prompt_file`、`service_tier`、`model_verbosity`、
  `model_reasoning_summary`、`plan_mode_reasoning_effort`、`experimental_use_unified_exec_tool`
  —— 它们会与 `model_catalog_json` 的声明冲突，让自动压缩/推理档位静默走偏

#### 漂移检测

`cxt doctor` 把受管区**重新算一遍**并与文件现状逐行对比，报告：

- 「身份区已漂移」——用户手工改过受管键（附 diff）
- 「受管区缺失」——config.toml 被删或键被移除
- 「未信任项目」——见 §2.10
- 备份文件路径与时间

`cxt run` **不**自动"修复"漂移，只同步受管区（因为那本来就是 cxt 的领地）；
漂移里属于"用户故意改的"部分，同步即被覆盖——所以 `cxt doctor` 的提示必须显眼。

### 2.10 ★ 项目级 `.codex/config.toml` 与信任（Codex 专有）

#### 项目级配置**是干什么的**

仓库根目录（可嵌套，从仓库根向 cwd 逐层）的 `.codex/config.toml`，定位是**整个仓库的共同安全策略**：

- `sandbox_mode` / `approval_policy` / `sandbox_workspace_write.*`（含 `network_access`、`writable_roots`）
- 项目专用 hooks、rules、MCP servers、feature flags

#### 项目级配置**写不了什么**（本工具存在的理由）

Codex **静默忽略**（并打一条启动警告）以下键——它们会重定向凭证、改 provider 认证、
选 profile、跑机器本地命令或上报遥测，属于"仓库不该能自己决定"的东西：

```
openai_base_url          chatgpt_base_url        model_provider
model_providers          notify                  profile
profiles                 otel                    experimental_realtime_ws_base_url
apps_mcp_product_sku
```

启动警告长这样（🟢 原文取自二进制，`<path>` 处是实际项目路径）：

> `Ignored unsupported project-local config keys in <path>. If you want these settings to apply, manually set them in your user-level config.toml.`

⚠️ **这条警告不会出现在 `codex doctor` 里**（doctor 的 22 个检查项中没有 trust 类检查），
只在真正的启动路径上打印。**别用"doctor 没警告"推断"没被忽略"。**

**⇒ 结论：中转站身份（provider / baseUrl / env_key）只能在「用户层 config.toml」、
「profile 文件（§7.4）」或「`-c` 覆盖」里。**
这正是 cxt 的 `CODEX_HOME` per token + 受管区方案要解决的问题。**别试图把 provider 写进项目级**——
那是最常见、也最容易被误判为"配置没生效"的坑。

#### 信任门（Trust Gate）

- 项目级配置**仅当项目被标记为可信时**才加载。**未信任 → Codex 整个跳过 `.codex/` 层**
  （config、hooks、rules 一起跳过），回落到用户层 + CLI。
- 信任记录写在**用户级** `config.toml` 里，该表**只有 `trust_level` 一个字段**：

```toml
# ✅ 正确：TOML 字面字符串 + Windows 原生反斜杠
[projects.'D:\work\client-a']
trust_level = "trusted"

[projects.'D:\work\random-clone']
trust_level = "untrusted"
```

```toml
# ❌ 错误：正斜杠 —— 不报错，但静默不匹配，信任永远不生效
[projects."D:/work/client-a"]
trust_level = "trusted"
```

- 🟢 ★ **路径匹配是字符串比较，规则已实测**（详见 §7.3 末的规则表）。四条要点：
  1. **必须反斜杠**（正斜杠静默失配，**这是本工具最容易写错的一步**）
  2. **大小写不敏感**
  3. **只认精确路径，不继承父目录**——信任 `D:\work` **不会**覆盖 `D:\work\client-a`
  4. 不接受尾部 `\`，也不接受 `\\?\` 前缀
- 🟢 ★ **信任是三态，不是二态**：`trusted` / 显式 `untrusted` / **从未标记**。
  后两者的 resolved 审批档位不同（`UnlessTrusted` vs `OnRequest`）。
  ⇒ `cxt doctor` 报"未受信任"时**必须区分**"显式拒绝过"与"从没见过"，
  否则用户会困惑于"我明明没标记过它"。

#### ★ 关键推论：信任是 (token × 项目) 矩阵

因为一 token 一 `CODEX_HOME`（§2.8），而信任记录住在**用户级 config.toml**，
所以**信任记录也跟着 profile 隔离**。后果：

> **同一个项目，token A 信任过，token B 没信任过——切到 B 时 Codex 会再问一次。**

N 个 token × M 个项目 = 最多 N×M 次人工确认。这是本方案唯一的显著体验代价，
必须在 README 里写清楚，**不要假装它不存在**。

#### cxt 的处置：显式命令 + 检测提示，**绝不静默写**

| 行为 | 做法 |
|------|------|
| 写信任 | **只**由 `cxt trust <path> [--token <t>]` 显式触发。`cxt run` **绝不**代写 |
| 撤销信任 | `cxt trust <path> --untrust`（写 `trust_level = "untrusted"`，**不删条目**） |
| 批量 | `cxt trust --all --token <t>`：把当前 token 的全部绑定路径一次标记为可信 |
| 检测 | `cxt doctor` 遍历绑定路径，报告「该 profile 下 N 个项目尚未信任，首次 run 会走一遍确认」 |

**理由**：代写信任等于 cxt 替用户做了安全决定，且用户看不到。显式命令让"我信任了这个目录"
成为一个**有意的、可审计的**动作——与 §3.1 的所有权铁律同源。

#### 安全性质（值得写进 README）

> **项目级配置改不了 provider / base_url，也改不了 `CODEX_HOME`。**
> 所以克隆一个恶意仓库，它**劫持不了**你的 token 与端点，也偷不走凭证——
> 最多只能在自己的目录里声明沙箱策略，而那还要你先信任它。

这与 `cmt` 的"项目设置无法设置 `CLAUDE_CONFIG_DIR`"是同一类保证，是本方案的**安全卖点**。

#### 注入与信任**正交**（重要，别混）

| 层 | 受信任门影响？ |
|----|--------------|
| cxt 的注入（`CODEX_HOME` + 受管区 + `-c` + 环境变量） | **不受影响**，永远生效 |
| 仓库自己的 `.codex/config.toml`（沙箱 / hooks / rules） | **受影响**，未信任则整层跳过 |

也就是说：**身份永远能用，只有仓库自声明的安全策略需要信任。** 排查时先分清是哪一层的问题。

### 2.11 跨平台适配

#### 分层：先分清哪一层真的需要适配

| 层 | 内容 | 成本 |
|----|------|------|
| **一、已抽象掉** | 环境变量注入、密钥落盘、进程启动 | **零**（见下方设计红利） |
| **二、必须逐平台实现** | 终端探测与拉起、可执行文件定位、文件权限 | 适配层的主要工作 |
| **三、暗礁（静默出错）** | TOML 值序列化、路径比较、编码、换行、WSL 边界 | 最容易漏，必须单测覆盖 |

**设计红利（不要破坏它）**：环境变量与 `-c` 参数**都不在 shell 脚本里拼**，而由 `cxt exec` 用
`spawn(cmd, args, { env })` 注入，**`args` 始终是数组**。这一步绕开了 cmd / PowerShell / sh
三套完全不同的引号与转义规则——**这是 §2.12「launch 脚本不内联 token」带来的最大跨平台收益**。
别为了"自包含"退回去。

#### 二·1 终端拉起：统一抽象

适配层只暴露一个接口，`argv` **始终是数组**，一路不被 shell 解析：

```js
platform.spawnTerminal({ title, cwd, argv }, env)   // argv: string[]；env: Record<string,string|undefined>
```

**`env` 是必填的第二个参数。** 新终端会**继承**调用方的环境（§7.14 的交接桩实测），
所以"用哪份环境去拉"必须由调用方明说，不能靠 `spawn` 的默认继承。平台层**不认识**
Codex 的会话标记，它只负责把这份环境交给 `spawn`；剔除是 `core/resolve.js` 的事
（`run.js` 传 `stripSessionMarkers(ctx.env)`，§2.6）。

| 平台 | 首选 | 探测依据 | cwd 传递 | 兜底 |
|------|------|---------|---------|------|
| Windows | `wt.exe` | `findExecutable('wt')` | `-d <cwd>` | `cmd /c start "" <脚本>` |
| macOS | iTerm2 / Terminal.app | `$TERM_PROGRAM` | `do script "cd ..."`（字符串） | `open -a Terminal <脚本>` |
| Linux | `$TERMINAL` → `x-terminal-emulator` → gnome-terminal / konsole / xterm | 逐个 `findExecutable` | `--working-directory` / `--workdir` / `-c` | `tmux new-window -c <cwd>` |

**Windows 的 argv 形状**（`-w` 决定标签页落在哪，语义依据见 §7.14 的实测表，**别凭印象改**）：

```bash
wt.exe -w <cxt|new> new-tab --title <标题> --suppressApplicationTitle -d <cwd> <argv...>
```

| `-w` 取值 | 语义 | 何时用 |
|-----------|------|--------|
| `cxt`（窗口名，**硬编码**） | 有名为 `cxt` 的窗口 → 往里加标签页；没有 → **用这个名字建一个** | `terminalMode: "tab"`（默认） |
| `-1`（可读写法 `new`） | 总是新窗口 | `terminalMode: "window"` |

- ⚠️ **不要用 `-w 0` / `-w last`**：那是"**最近使用过的**窗口"，不是"当前窗口"、也不是"第一个窗口"。
  用户开着多个 WT 窗口时，标签页会落进"上次碰过的那个"——本机实测就是这么落进
  **用户的 Claude Code 窗口**里的，观感是"窗口到处乱开"。`-w cxt` 把它钉死成一个专属窗口；
  该窗口被关掉后，下次 `cxt run` 自动重建（自愈）。**这条是本工具默认模式的核心体验，别退回去。**
- 窗口名**硬编码 `'cxt'`，不做配置键**：本工具的价值就在名字稳定可预期，可配置反而削弱它。
- `TerminalSpec.windowName` **只在 tab 模式填**（`'cxt'`），window 模式**不填**。
  回执据此说"已在 cxt 窗口的新标签页启动"。**cli 层不许硬写窗口名**——macOS / Linux 的
  "开标签页"就是往当前窗口加，没有名字可言，硬写在那儿就是假话。
- `new-tab` 子命令**必须显式写出来**（不写时 `wt` 走的是自己的默认行为）：
  `--suppressApplicationTitle` 只有出现在 `new-tab` **之后**才生效。
- `--suppressApplicationTitle` **两种模式都要给**，理由见下面的标题契约。
- `cmd /c start` 兜底**没有标签页概念**，只能开新窗口 → `terminalMode: "tab"` 走到这条兜底路时
  **必须报警**（进 `warnings`），不能默默退化成开新窗口。

**只有必须走字符串的适配器**（macOS `osascript`、Windows `cmd /c start`、无 cwd 选项的 `xterm`）
才做转义，**且这些适配器必须各自带转义单测**。

**不要直接 `spawn` 一个 `.cmd` / `.bat` 文件**——Node 18.20+ / 20.12+ 出于安全（CVE-2024-27980）
会直接拒绝。一律经 `cmd.exe /c <脚本>` 调用（`cmd.exe` 是 `.exe`，不受限）。

`--window` / `--tab` 覆盖 `defaults.terminalMode`。探测失败时报出**试过哪些终端**，别只说"失败"。

**窗口标题**：`cxt:<token> · <cwd 末段>`（总是带 cwd 末段，理由同 `cmt`：无状态，无从知道
"是不是第二个窗口"，与其做一个猜不准的条件追加，不如每次都带上）。
本工具的卖点就是"一眼分辨哪个窗口是哪个 token / 哪个项目"——**标题必须能区分**，这是功能不是装饰。

**标题得靠 `--suppressApplicationTitle` 才守得住**（本机实测，§7.14）：`codex` 一跑起来就用
OSC 2 改写终端标题，把 `cxt:relay-cxt · client-a` 覆盖成 `client-a`——**`cxt:` 前缀和 token 名
全没了**，上面那条"必须能区分"当场失效（实测三开时三个标签页长得一模一样，只剩目录名）。
所以 Windows 的 `wt` argv 里 `--title` 之后**必须**紧跟 `--suppressApplicationTitle`，
且它必须出现在 `new-tab` 子命令**之后**（`--title` 只负责"把标题写上"，这一项才负责"别被覆盖"）。
**两种模式都加**——`--window` 模式同样被覆盖。代价：标签页不再显示 codex 的动态标题。
这是**有意取舍**——本工具要的是"一眼认出是哪个 token / 哪个项目"，那比活动动画重要。

#### 三·1 ★ TOML 值序列化（Codex 专有暗礁）

`-c key=value` 的 value 是 **TOML**，不是 JSON，也不是 shell 字符串。必须有一个
**纯函数** `toTomlValue(v)`（`core/toml-value.js`），且必须单测：

| JS 值 | TOML 输出 | 坑 |
|-------|----------|-----|
| 字符串 | `"..."` | 内部 `"` 与 `\` 转义；含换行/控制字符时改用字面量字符串或报错 |
| 布尔 | `true` / `false` | ⚠️ 经 shell 时 `-c key="true"` 会变成 TOML 布尔；要字符串得写 `-c key='"true"'`。**我们的 argv 不过 shell，所以这层歧义不存在**——但兜底脚本路径必须处理 |
| 数字 | `1` | 前导零、`_` 分隔符 |
| 数组 | `["a", "b"]` | 元素递归序列化 |
| 对象 | `{k = "v", n = 1}` | **内联表**；键名含特殊字符要加引号 |
| Windows 路径 | `"D:/work/x"` | ⚠️ **TOML 里反斜杠是转义字符**。作为**值**时一律转成正斜杠再写（DeepSeek 脚本显式做过这件事，注释写着"backslash is an escape character in TOML"） |

> 🔴 ★ **但上表最后一行只适用于「作为 TOML 值的路径」，不适用于「作为 TOML 表键的路径」。**
> 这两者规则**相反**，是本项目最容易混淆的一处：
>
> | 用途 | 例 | 分隔符 | 理由 |
> |------|----|-------|------|
> | TOML **值**（`base_url`、`model_catalog_json`、`writable_roots`…） | `base_url = "https://x/v1"` | **正斜杠** | 反斜杠是转义符，且 URL/路径比较语义不敏感 |
> | TOML **表键**（`[projects.'<path>']` 信任记录） | `[projects.'D:\work\a']` | **必须是反斜杠** | Codex 拿它跟 cwd 做**字符串**比较，正斜杠静默失配（§7.3 规则表） |
>
> ⇒ 实现上**必须分成两个函数**：`toTomlValue(p)`（转正斜杠）与 `toTomlPathKey(p)`（**保留反斜杠、
> 用字面字符串 `'...'`**，含单引号时退化为转义基本字符串）。**绝不要共用一个"路径归一化"。**

#### 三·2 路径归一化（绑定匹配的成败在此）

`normalizeForCompare(p, platform)`——**纯函数，platform 由调用方注入**：

1. `String(p).normalize('NFC')` —— **macOS 暗礁**：macOS 文件名可能以 NFD 存储，
   文件系统查找本身不敏感，但**我们自己的 `startsWith` 前缀匹配是字节级敏感的**——
   用户输入的 NFC 与配置里存的 NFD 会匹配失败。统一归一化即可消除。
2. 分隔符统一为 `/`
3. Windows / macOS：`toLowerCase()`（APFS 默认大小写不敏感）；**Linux 保持大小写**
4. 消解 `.` / `..` 段；去掉尾部 `/`（保留根 `/`，Windows 保留 `C:/`）

**不做 `realpath`（不解析 symlink）**：会引入 IO 开销与"绑定突然失效"的困惑。
v1 按字符串前缀匹配，`cxt resolve` 打印**归一化后**的路径供对照。

**WSL 边界**：`/mnt/c/...`（WSL 内）与 `C:\...`（宿主）是两套字符串，绑定**不互通**。
文档说明即可，**不做路径转换**。

> ⚠️ **上面这套归一化只用于 cxt 自己的 `bindings` 匹配**（我们自己的前缀比较、展示、排序）。
> **绝不要拿它去改写 Codex 的 `[projects.*]` 信任条目**——那套路径是**另一套规则**：
> 大小写不敏感 ✅、但**反斜杠必需**、**不继承父目录**、**精确匹配**、不做 NFC 归一化（§7.3 规则表）。
>
> 两套规则的差异是**有意保留**的，不要"统一"它们：
> - cxt 的 bindings 是**我们自己的**数据结构，可以随意归一化以便前缀匹配；
> - Codex 的 trust 键是**它的**字符串比较输入，改一个字节就失配。
>
> 关于"代写"：`cxt` **不静默写**信任（§2.10），但 `cxt trust` 显式命令**会写**——
> 写的时候必须走 `toTomlPathKey()`（保留反斜杠、字面字符串），**不能**走归一化后的正斜杠形式。

#### 四 可执行文件定位

`findExecutable(name, { platform, env })`——**纯 JS 实现，不 spawn `which` / `where`**：

- POSIX：按 `:` 拆 `PATH`，逐个 `fs.accessSync(X_OK)`
- Windows：按 `;` 拆 `PATH`，对每个目录尝试 `PATHEXT` 中的扩展名（`.COM;.EXE;.BAT;.CMD`）；
  **Windows 上 `X_OK` 无意义，只看存在性**

纯 JS + 注入 platform → **三大平台的定位规则都能在任意一台机器上单测**（§6.3）。

实现里额外定了四条（施工时撞出来的，`tests/find-executable.test.js` 有对应断言）：

1. **`env` 读取在 Windows 上要大小写不敏感**。真机上变量名常写作 `Path` 而非 `PATH`；
   靠 `process.env` 自带的魔法能侥幸跑通，但本项目到处在**注入** `env`（普通对象没有那个魔法），
   换个人工构造的 env 就静默找不到。
2. **`PATHEXT` 缺失/为空 → 退回默认集**，不是"没有扩展名可试"（服务账户、某些 CI 真会缺）。
3. **不返回裸名**：Windows 上不带扩展名的文件不算可执行文件（`CreateProcess` 要求扩展名在
   `PATHEXT` 里）。返回 `C:\bin\codex` 只会让调用方在 spawn 时收到一个不指向原因的错。
   `where.exe` 同此行为。
4. **返回磁盘上的真实拼写**，不是 `PATHEXT` 拼出来的候选名。`PATHEXT` 是大写
   （`.COM;.EXE;.BAT;.CMD`），而 npm 装出来的是 `codex.cmd`——不加这一步会返回
   `codex.CMD`，而这个字符串会被写进 `defaults.codexBin`（§2.12 第 3 级），
   用户在配置里看到磁盘上不存在的拼写很难解释。代价刻意压在：只在命中之后、
   只对命中的那一个目录、只做一次 `readdir`（不是每个 PATH 目录都扫）。

> ★★ **`statSync` 看不见 App Execution Alias**（2026-10-17 真机实测，见 §7.14⑤）。
> 判定"是不是文件"**必须带 `lstatSync` 兜底**，否则 §2.11 二·1 的 Windows 首选
> （`wt.exe`）会**静默**失效，每次都悄悄退到 `cmd /c start` 兜底。
> 兜底**只在 Windows 上开**：POSIX 的悬空符号链接不该被当成可执行文件，
> 那边由 `accessSync(X_OK)` 自然处理。

> ⚠️ **`node:path` 的 `join` 用的是「宿主」规则，不是「目标」规则。**
> 在 Windows 上 `join('/home/t', 'x')` 得到 `'\home\t\x'`——路径被彻底改形。
> 所以凡是"为某个平台算路径"的函数**必须按注入的 platform 选 `win32.join` / `posix.join`**，
> 借宿主的 `join` 会让三平台规则无法在本机单测（实测踩过）。
> 反之，产出**宿主路径**（要交给本机 fs / spawn 用）的函数才用原生 `join`。
> 两条规则的分界：**函数收不收 `platform` 参数**。

#### 五 权限与凭证清理

- POSIX：`chmod 0600`（含 token 的文件）；**Windows 上 `fs.chmod` 基本是 no-op**（只影响只读位），
  实际依赖用户目录 ACL。README 必须说明差异，**别假装设了权限**。
- `cxt token rm <t> --purge` 删 profile 目录时，**`config.toml.cxt.bak` 也一并删**，
  但删除前提示里面含旧的身份配置。

### 2.12 直接拉起优先，launch 脚本是兜底产物

**首选路径：不生成脚本。** 直接 `platform.spawnTerminal({ title, cwd, argv }, env)`，
`argv = [nodePath, cxtPath, 'exec', token, '--model', id, ...]`。
`env` 是**必填**的第二个参数，传的是 `stripSessionMarkers(ctx.env)`（§2.6）。

好处是**消灭了整整一类问题**：无 shell 解析、无 TOML 引号歧义、无代码页——
Node 在 Windows 上用 UTF-16 传参，**中文路径不会经过 `.cmd`**。
cwd 也由终端的 cwd 参数传递（`wt -d` / `--working-directory` / `-c`），同样不进脚本。

**仅在三种情况生成 `profiles/<token>/launch.{cmd,sh}`**：
① 终端只接受命令字符串（macOS `osascript`、`cmd /c start`）；
② 终端无 cwd 选项（如 `xterm`）；③ 用户要手工重跑。

生成时**内容只允许**包含下面四件事：

1. **绝对路径调用**：`"<node 绝对路径>" "<bin/cxt.js 绝对路径>" exec <token> [--model <id>] [-c]`
   - `node` 用 `process.execPath`，**不用 `node` 字面量**；cxt 入口用 `fileURLToPath(import.meta.url)`
   - 理由：新终端的 PATH 与启动时可能不同，**任何一步都不能依赖 PATH**
   - 脚本的 argv 与「直接拉起」路径**逐字一致**——脚本是首选路径的忠实序列化
2. **不放 cwd**（由终端的 cwd 参数传入）。只有在①/②兜底路径下才写 `cd /d "<cwd>"`（cmd）/
   `cd "<cwd>"`（sh）——此时 `cxt doctor` 要标注该路径的**编码风险**
3. **参数透传**：cmd 用 `%*`，sh 用 `"$@"`
4. **不出现任何密钥**（§2.7 铁律）

**转义**（脚本本身就是字符串产物，所以必做，且必须带单测）：

| 目标 | 规则 |
|------|------|
| `.cmd` | 值一律 `"..."` 包裹；**`%` 要写成 `%%`**（cmd 里 `%` 即使在引号内也会展开）。`%*` 是唯一**故意不转义**的片段，别让它经过引号函数变成 `%%*` |
| `.sh` | 值一律 `'...'` 包裹；内部的 `'` 用 `'\''` 收尾重开 |

> 🔴 **订正（实现期，2026-10-17）：`exec` 之外的片段一律加引号，包括 `--model` / `-c` 这些 flag 本身。**
> 原文写的是"固定关键字不加引号，只有**值**加引号"——那要求生成器**认识** `exec` 的 flag 集合，
> 于是每加一个 flag 都要回来改一次，正是本节要消灭的那种分叉。
> 统一加引号后规则只剩一条「`exec` 不加，其余都加」，语义完全等价
> （cmd 与 sh 都把 `"--model"` 当 `--model`）。
> ⇒ token 是**位置参数（值）**，从来都加引号，这条没变。

> ★★ **订正（真机实测，2026-10-17）：argv 只有**一个**源头，`node` 与 `exec` 都由它补。**
> 本节第 1 条要求"脚本的 argv 与直接拉起路径**逐字一致**"。实现时这条被当成
> 一句口号，两处**各拼了一遍**，于是**各错一半、症状还完全不同**（详见 §7.14 ⑦）：
>
> | 错法 | 症状 |
> |------|------|
> | 直接拉起漏 `exec` | 窗口一闪而过（里面跑的是 `cxt relay-a`，"未知命令"） |
> | 直接拉起漏 node | 窗口弹出来，第一行 `0x800700C1`（`cxt.js` 是脚本不是 exe） |
>
> 而兜底脚本那条路**一直是对的**——它自己补了这两样。于是症状是
> **"脚本能跑、直连不能跑"**，极具欺骗性。
> ⇒ 现在两处都从 `core/launch-script.js` 的 `buildCxtCommandLine()` 取，
> 返回 `[nodePath, cxtPath, 'exec', ...execArgs]`。
> **"逐字一致"靠接口形状保证，不靠纪律**——调用方拿不到"自己拼头部"的机会。
> ⚠️ 由此推论：**`execArgs` 的契约是"`exec` 之后的一切"**，不含 `exec` 关键字本身。

**编码规则**（生成脚本时）：`.sh` 用 LF + `#!/bin/sh` + `chmod 0755`；
`.cmd` 用 CRLF 且**整个文件都是纯 ASCII——注释也不例外**。
（中文 Windows 的 cmd 默认跑在 OEM 代码页，UTF-8 的中文注释会让它把后面的字节一起读花，
路径再 ASCII 也救不回来。所以 `.cmd` 的注释写英文，理由留在这里和代码注释里。）

`cxt exec` 的职责：解析四要素 → 同步受管区 → 注入环境 → **定位 codex** →
`spawn(stdio: 'inherit')` → 转发退出码。

> ⚠️ **`cxt exec` 的 cwd 规则与 `cxt run` 不同**（§2.3 第五条）：
> **exec 跳过 `token.cwd`**，只用 `--cwd` 或进程当前 pwd。它是"在**已经存在**的终端里启动"，
> 把用户拽到别的目录会破坏 shell 与 Codex 的工作根一致性，并让 `resume --last` **静默续错会话**。
> 因此 **exec 只在 `--cwd` 显式给出时才传 `-C`**；否则让 codex 继承进程 cwd。
>
> 🔴 **订正（实现期，2026-10-17）：`run` 那条路径**也**总是把 cwd 转述给 exec（即总是走 `--cwd` → `-C`）。**
> 原文说"`run` 那条路径不需要 `-C`——终端的 cwd 参数已经把目录设好了"。
> 但 §7.14 ⑤ 实测：Windows 的 `cmd /c start` 兜底路径**会丢 cwd**。
> 而 cwd 传错不只是"目录不对"——§7.6 的 `resume --last` 是**按 cwd 作用域**的，
> 传错 = **静默续上别的目录的会话**，用户毫无察觉。
> ⇒ `-C` 是**不依赖终端**的那条信道：终端把 cwd 设对了它是空操作，
> 终端没设对它是唯一的补救。代价是它要过一次 cmd shim（§7.14 ⑥），
> 路径含 `%` 时 exec 会打警告——那是**可见的**代价，比静默续错会话好。
> ⇒ 真机验收已确认 `-C` 真的到了 codex 手里（`scripts/verify-run-real.mjs`）。
>
> 实现约束：`resolve.js` 必须显式接收 `entry: 'run' | 'exec'`，
> **不许**让 exec 路径"碰巧"拿到 `token.cwd` 再靠调用方不传 `-C` 来抵消——
> 那会在 `--print`、`doctor`、launch 脚本生成三条路径上各自漏一次（§2.3 第五条）。

**codex 可执行文件定位顺序**（与上面同理，不依赖 PATH）：

| 顺序 | 来源 |
|------|------|
| 1 | `defaults.codexBin`（显式配置） |
| 2 | `findExecutable('codex')`（§2.11 四，纯 JS，不 spawn `which`/`where`） |
| 3 | 常见安装路径：Windows `%APPDATA%\npm\codex.cmd`；macOS/Linux `~/.local/bin/codex` |
| 4 | 都找不到 → 退出码 2，提示安装命令（`npm i -g @openai/codex`） |

命中 2 或 3 时把**绝对路径写回 `defaults.codexBin`**，下次免探测。

### 2.13 ★ 项目本地配置 `.cxt.json`（第四层，2026-10-18 新增）

**一句话：把"这个仓库该怎么跑"写进仓库自己，而不是写进用户的全局配置。**

`cxt` 的级联前三层（`defaults` / `token` / `binding`）**全部住在 `~/.codex-multi-token/`**。
于是"这个项目要用 A 模型、这个项目要 `danger-full-access`"这类**属于仓库**的声明，
只能塞进用户的全局配置——**换个同事的机器就没了**，而且全局配置里堆满了一次性项目。

`.cxt.json` 补上这一层：文件在**项目目录**里，跟着仓库走，可以提交、可以 review。

#### 一、发现规则

| 来源 | 规则 |
|------|------|
| 默认 | 从 **cwd 往上逐级**找 `.cxt.json`，**最近的一个胜出**，直到文件系统根 |
| `--config <path>` | 显式指定，**跳过发现**。读的是**同一份 schema**，不是第二套 |

> ★ **`--config` 复用同一份 schema 是刻意的。** 另立一套"显式配置文件格式"会让
> `cxt doctor` / `cxt resolve` / 面板三处各需要一套校验，且它们迟早分叉。
> 一份 schema、一个 `normalizeProjectConfig()`，没有第二条路。

- **往上找是"最近优先"而不是"找到就停"**：在 `D:/work/a/sub` 里跑，
  若 `sub/` 没有而 `a/` 有，就用 `a/` 的那份——这与 `bindings` 的最长前缀匹配是**同一个直觉**。
- ★ **"cwd" 一律指「调用时的 cwd」**：`--cwd` 优先，否则进程当前目录——与绑定匹配用的是
  **同一个定义**（`callCwdOf()`，§2.3），**只有一处实现**。
  `cxt run relay-a --cwd D:/proj` 要发现的是 `D:/proj` 的那份配置，
  不是你恰好站着敲命令的那个目录。拿 `token.cwd` 来发现会**成环**（§2.3 已点名这条）。
  ⚠️ 实现落在 cli 层（`session.js` 的 `loadProjectConfig()`）：core 不碰 fs，
  `discoverProjectConfig()` 只收一个**注入的 `isFile` 谓词**（§4.2）。
- **不跨越盘符/挂载点**：走到根就停，不去猜"用户家目录的那份算不算"。
  cxt 的数据目录**不是**发现路径的一部分（§2.8 已说明 `.cxt.json` 不在那棵树里）。
- **`--config` 指定的文件不存在** → 报错退出 1，**不回退到发现**。
  显式给了路径却悄悄用别的文件，是最难排查的一类静默失效。

#### 二、★★ 受限 schema：**不许放凭证**

| 允许 | `version`（**必填**）/ `token` / `providerId` / `models` / `catalog` / `env` / `sandboxMode` / `approvalPolicy` / `codexArgs` |
|---|---|
| **禁止** | `authToken` / `baseUrl` / `wireApi` / `cwd` / `codexBin` / `terminalMode` / `env.CODEX_HOME` |

> 这张表与 §2.4 的字段表**逐格一致**，别只改一处。
> `providerId` 在允许列、`wireApi` 在禁止列不是随手分的：
> **`providerId` 只是个名字**（TOML 表名），改它不会让 key 跑到别处；
> 而 `wireApi` 与 `baseUrl` 同属「**怎么跟那个端点说话**」，是目的地描述符的一部分。

每个禁键都要有**专门的报错**（不是笼统的"未知键"），理由逐个写死：

| 禁掉的键 | 为什么 |
|---------|--------|
| `authToken` | §2.7 铁律「**token 只有一个落盘点**」。多一个落盘点就多一份明文副本，且这份会被 `git add .` |
| `baseUrl` | ★★ **这是外泄通道**：克隆一个仓库，它写 `baseUrl: "https://evil.example.com/v1"`，你 `cxt run` 一下，**你的 key 就被送到那儿去了**。这条不是"不方便"，是**攻击面** |
| `wireApi` | 同属目的地描述符。且它当前**只有一个合法值**（`"responses"`，§7.9），允许写等于允许写错 |
| `cwd` | 文件本身就是"按路径找到的"，再声明 cwd 是**循环定义**（拿它去匹配绑定会成环，§2.3 已有同类教训） |
| `env.CODEX_HOME` | **隔离原语**（§2.2）。项目文件不许改身份落点，否则 `cxt run` 会去动用户真实的 `~/.codex/` |
| `codexBin` / `terminalMode` | 机器级偏好，不是项目级——写进仓库只会让同事的机器按你的终端习惯走 |

> ⚠️ **`env` 的禁键要按大小写不敏感判**：Windows 的环境变量名不区分大小写，
> 只拦 `CODEX_HOME` 会让 `env: { "codex_home": "..." }` 在 Windows 上**绕过去**，
> 而在 Linux 上不生效——同一份仓库配置两个平台两种语义，正是要避免的东西。

> ⇒ **副产品，要写进 README 当卖点：`.cxt.json` 天生不含密钥，可以安全提交。**
> 这一条是上面那张表的**直接推论**，不是额外承诺——它是"禁掉那几个键"换来的。

**凭证与目的地只能来自 `tokens/<name>.json`**（`token` 字段引用的是**名字**）。
要新身份 → `cxt token add`，然后项目文件里写那个名字。**没有第二条路**。

#### 三、优先级（§2.3 表已列，这里只讲理由）

**位置固定在 CLI 之下、路径绑定之上。** 为什么在绑定之上：

- 绑定回答的是"**这个目录**用哪个 token"——它是**路径**维度，粒度可能很粗
  （`D:/work` 一条绑定罩住底下几十个仓库）。
- 项目文件回答的是"**这个仓库**该怎么跑"——它是**仓库**维度，是用户此刻真正在编辑的东西。
- 用户的心智模型是"我在这个仓库里，我要它这样跑"。**越具体越靠上**，仓库比目录具体。

#### 四、坏文件必须硬报错

JSON 非法 / `version` 缺失 / 含禁键 → **退出码 1，指名文件路径与具体问题**。
**绝不静默跳过。** 理由与 `readAllTokens` 一致：静默跳过的表现是
"我明明配了，怎么没生效"——而这句话会消耗掉用户半小时。

`version` 的处理与 `config.json` 一致（§3.5）：读到**更高**版本 → 拒绝（退出码 2）。

#### 五、`cxt model` 的写入目标跟着生效层走

`cxt model set/use/next/clear --path <p>`：若该路径的项目本地配置**声明了** `models`，
**目标层就是那个 `.cxt.json`**；否则才是 binding。

理由：写到一个**不生效**的地方 = 命令静默失效。`model.js` 已有
`pickLayer()` / `materialized` / `effectiveModels` 这套"先物化再轮转"的逻辑，
扩一层即可——**别新写一套**。

★ **`--config` 也在这条规则里，不是它的例外。** 生效层是"哪一份文件在说话"，
而 `--config` 正是"这一份才是我的项目配置"（§2.13 一）——所以
`cxt --config A model set --path B` 写的是 **A**（B 那份连发现都不做）。
判据**只有一处**：`model.js` 的 `projectConfigAt(ctx, dir)`，`pickLayer()` 与
`effectiveForDir()` 共用它。面板的 `e` 走的也是 `pickLayer()`（§2.14 二），
所以命令行与面板**不可能**分叉——在 `ui.js` 里再认一遍 `--config` 就是第二处真相。

⚠️ 判据是**"那一份有没有声明 `models`"**，不是"给没给 `--config`"：
`--config` 指的那份若只声明了 `token`，写入**仍然落到 binding**
（它没说话 = 不参与这一项）。否则一个只管 token 的文件会**凭空开始管模型**——
而那是它自己下一次 `cxt resolve` 才会露出来的变化。

#### 六、cxt 绝不自动创建它

`.cxt.json` 只在两种情况下出现：① 用户在面板向导里选了"写进本项目"（§2.14 四）；
② 用户自己写。**任何命令都不许"顺手建一个"**——§3.2 的惰性原则在这里同样成立。

---

### 2.14 面板：全屏 TUI 与网页控制台（2026-10-18 新增）

**一句话：不记 flag、不查文档，选一个条目、回车，就开一个新会话——
终端里用方向键（TUI），浏览器里用鼠标点（控制台）。**

#### 一、入口

**两个前端，两条入口**：`cxt ui` 进全屏 TUI，裸 `cxt` 开网页控制台（§十）。

| 命令 | TTY | 非 TTY |
|------|-----|--------|
| `cxt`（裸） | **开网页控制台** | **打印用法、退出 0**（脚本不受影响） |
| `cxt ui` | 进全屏 TUI | **报错退出 1**（与 `--pick` 同纪律，§2.5） |
| `cxt ui --web` / `CXT_UI=web` | 开网页控制台 | **也开**——它不需要终端（e2e 的钩子，同 `CXT_UI=plain` 的角色） |
| `cxt ui --web --no-open` | 只打印 URL，不开浏览器 | 同左（**口令不进 argv**） |
| 其它子命令 | 一律照旧，面板不参与 | 同左 |

> **为什么裸 `cxt` 也进面板**：Codex 自己无参数就是交互式 TUI，用户对"裸敲一个 CLI 名"
> 的预期已经是那样了。非 TTY 退回用法保证了 `cxt | grep` 这类脚本仍然工作——
> 这条**必须**有测试（§6.3）。
> ★ **"控制台成为默认"不等于"管道里也是"**：非 TTY 那条闸门原样保留，
> 否则 `cxt | grep` 会挂住等一个永远不退的服务器。

#### 二、形态与键位

```
 当前目录                      ← 面板启动时所在目录，走默认解析
 agent_multi_token   → relay-cxt
 (未绑定)            → relay-a
 + 新建…

 authToken: sk-****abcd         模型 (3/12)
 baseUrl:   https://oneapi-…     ▸ gpt-5.6-sol
 source:    路径绑定              gpt-6.1-sol
```

| 键 | 作用 |
|---|---|
| `↑` `↓` / `Home` `End` / `PgUp` `PgDn` | 移动光标（边缘滚动，见 §2.14 五） |
| `Enter` | **启动**（等价 `cxt run`，开新标签页）。★ **面板留在原地**并显示「已启动 ✓」，这样可以连着开好几个 |
| `n` / `e` / `d` | 新建向导 / 改模型 / 删绑定 |
| `r` | 重新读配置（外部改了文件时用） |
| `q` / `Esc` / `Ctrl+C` | 退出 |

**左栏是「可启动项」，不是裸 token 列表**：当前目录、每条绑定、没有绑定的 token、
`+ 新建…`。理由是面板要回答的问题是"**我要在哪开**"，token 只是答案的一部分。

★★ **每一项的身份来自"解析结果"，不是来自"它有没有绑定"**。四类项各按各的路走：

| 项 | 喂给解析的 | 于是「当前目录」那一行 |
|---|---|---|
| 当前目录 | **什么都不喂**（= 裸 `cxt run` 那条路） | 走完整级联：项目本地 → 绑定 → `defaults.token` |
| 每条绑定 | 那条绑定声明的 token 名 | —— |
| 未绑定的 token | 那个 token 名 | —— |
| `+ 新建…` | —— | 没有身份，回车进向导 |

判据是**解析出来的 `token` 名**。这一条不是实现细节，是承重的：`Enter`（启动）与
`e`（改模型）**都靠它判"这一项有没有身份"**。少了它，「当前目录」那一行会既启动不了
也改不了模型——而那正是裸 `cxt` 落上去的第一行。这个 bug 真的发生过：
身份来自项目本地配置时，`source` 明明印着「项目本地」，回车却说"没有绑定身份"。
⇒ 回归断言在 §6.3 的 `ui-e2e.test.js` ③。

**来源层的名字要如实**：绑定行与未绑定 token 行是**把 token 名当 `argv.token`** 喂进
解析的，于是 `tokenPick.source` 恒为 `cli`——照直印出来就是「来源：命令行」，
而用户从没在命令行上给过任何东西。这两行必须**指定来源层的代号**，
且翻译成中文只做一处（两条路各拼一遍，迟早拼得不一样：第一版就漏了，印出个 `token`）。

#### 三、★ 括号粘贴必须开（这是 bug 修复，不是优化）

关掉 `?2004` 时，终端把粘贴内容**当成用户逐字敲的**灌进输入流，于是：

1. **粘贴内容里的 `\r` / `\n` 会被当成 Enter** —— 复制一段带尾换行的 `sk-…` 粘进
   输入框，**中途触发提交**。静默、破坏性。
2. **粘贴内容里的 `ESC` 会被当成转义序列的开头** —— 从别的终端粘一段带 ANSI 的日志，
   那不是文本，是**注入的按键**（能触发 `q` 退出）。

开 `?2004` 后整段粘贴被 `[200~` … `[201~` 包住，里面**逐字节都是字面文本**，两条一起消失。

> ⚠️ **标记是 `ESC [ 200 ~` / `ESC [ 201 ~`，没有 `?`。** `?` 只在 DECSET/DECRST 的
> 设置序列里。写成 `ESC [ ? 200 ~` 是经典 bug：**永远匹配不上**，于是 `[200~`
> 变成插进输入框的字面文本。这条要有单测。
>
> ⚠️ **粘贴必须是解码器的一个"模式"，不是后处理**——粘贴期间不许有任何按键语义泄漏出去，
> **包括 `\x03`**。粘一段含 Ctrl+C 的二进制内容绝不能把面板关掉。
>
> ⚠️ **解码器必须是逐字节可中断的状态机，不是对 chunk 跑正则。**
> 序列**会**跨 chunk 分裂（`ESC [` 先到、`A` 后到；粘贴中文时 UTF-8 续字节同理）。
> 正则式解码这时把 `ESC [` 当"未知按键"丢掉，用户看到的是"**方向键偶尔失灵**"——
> 一个只在慢速 / 粘贴 / 多路复用下复现的幽灵 bug。状态机把"半个序列"当**合法的中间状态**，
> 于是分裂是正常路径而不是异常路径。**测试必须专门喂分裂输入**（§6.3）。
> ⇒ **stdin 用 `setEncoding('utf8')`，解码器收 `string` 不收 `Buffer`**：UTF-8 多字节字符
> 同样会跨 chunk 分裂，而 Node 的 `StringDecoder` 已经把这个状态机写好测好了——
> **不要自己再实现一遍**（那是第二处真相）。
> ⇒ **Esc 歧义**（单独一个 `ESC` 既可能是 Esc、也可能是序列开头）用 **30 ms 计时器**，
> 但 **计时器不进 `keys.js`**——那会让纯函数变成有副作用的东西。驱动侧超时后带
> `flush: true` 再调一次 `decode()`，此时仍停在 `esc` 态的单字节按 Esc 处理；
> 更长的半截序列（`ESC [`）**不静默丢弃**，明确报 `unknown` 并显示在状态行
> （宁可明确，不要静默——§6.2 的同一纪律）。
>
> **残余风险**（写进 README）：不支持 `?2004` 的老终端会忽略 DECSET，退化回上面两条。
> 这是唯一**无法在代码里消除**的一条。
>
> ⚠️ **空格是独立的按键事件，不混进文本。** 面板用空格勾选（本节四第 3 步），
> 混进文本的话"输入框里能不能打空格"与"列表里勾没勾上"就纠缠在一起了。
>
> ⚠️ **方向键上的修饰键一律忽略**（`ESC [ 1 ; 5 A` 就是 `↑`）：面板里没有带修饰键的
> 绑定，用户按 Ctrl+↑ 时想的就是"往上走"。**但 `~` 结尾的不做这个让步**——
> `ESC [ 3 ~` 是 Delete、`ESC [ 3 ; 2 ~` 是 Shift+Delete，混起来会真的删错东西。
>
> ⚠️ **一段粘贴最多攒 64 KiB**，超了停止累积并在事件上打 `truncated`，
> 界面必须说出来。没有上限的话，往输入框粘一个 10 MB 日志文件会让面板直接卡死
> （攒字符串 → 塞进输入框 → 逐帧渲染）。**截断不许静默。**

#### 四、新建向导（四步）

| 步 | 屏 | 交互 |
|---|---|---|
| 1/4 | **路径** | 文本框，预填 cwd；下方实时列出该目录的子目录（`↑↓` 选、`Tab` 补全） |
| 2/4 | **身份** | 列出已有 token（`↑↓` 选）＋「+ 新建 token」（输入名字 + 粘贴 sk，**全程掩码显示**） |
| 3/4 | **模型** | 用该 token 拉 `GET {baseUrl}/models` → 列表；**空格勾选，勾选顺序即优先级**；`/` 过滤。失败时给 `[r] 重试 / [m] 手敲 id / [s] 跳过` |
| 4/4 | **落点** | **两个都写**：`config.bindings += {path, token}` **且** `<path>/.cxt.json = {version, token, models}` |

> ⚠️ **第 3 步在第 2 步之后，是约束不是选择。** "先选路径、再看模型列表、最后输 token"
> 这个顺序做不到——`/models` 要 `Authorization: Bearer`，**没有 token 就拉不到列表**。
>
> ⚠️ **第 3 步的失败是常态**（中转站常在内网，或者根本没实现 `/models`），
> 所以**必须有"手敲 id"和"跳过"两条出路**。拉不到就卡死在这儿是不能接受的。
>
> ★ **输入框一律剥掉控制字符**（`\r` `\n` `\t` 及其余 C0）。粘贴是输入 key 的主要方式，
> 而复制来的 key 十有八九带一个尾换行——那个换行绝不能进 token 文件。
> 剥在**输入框这一层**，不是剥在粘贴事件那一层：手动敲的与粘贴的走同一条路，
> 才不会有"粘进去的干净、敲进去的不干净"这种一半对一半错的状态。
>
> ★ **第 4 步写 `.cxt.json` 的三个坑**（三个都真踩过）：
>
> | 坑 | 后果 | 规矩 |
> |---|---|---|
> | 新文件从零建，**没写 `version`** | `checkVersion()` 拦下 → 第 4 步在"这个目录还没有 `.cxt.json`"时**必然写失败**——而那恰恰是它最常见的用法 | `version` 是**必填**，新建时补 `CONFIG_VERSION` |
> | 把已有的 `version` 一起重写 | 悄悄升级了用户文件的格式版本 | **沿用原 `version`**，不偷偷升级 |
> | 整个文件替换 | 用户自己写的 `env` / `catalog` / `sandboxMode` 全没了 | **合并**（`{...cur}`），只动 `token` / `models` |
>
> ⚠️ 还有一处反直觉：`normalizeProjectConfig()` 的产物里**多一个 `configPath`**
> ——那是校验函数用来拼错误信息的，**不是文件里的字段**，写盘前必须摘掉。
> 照着校验产物原样落盘的话，用户的 `.cxt.json` 里会多出一个莫名其妙的键。

#### 五、★ 布局：每行严格 `≤ cols`

**这是全节唯一不能破的规则。** 破了不是烂一行，是**烂整屏**：

终端自动折行 → 那一行之后**所有**行的实际屏幕行号 +1 → 右栏内容跑到左栏下一行的位置、
页脚出屏、最后一行的内容把整屏顶一格；**而且每帧重犯**（全量重绘不自愈）。
⇒ 必须**机器守住**：`render()` 出口是唯一一条路，出口前必过 `fitLine()`。

守门用的是**保守宽度** `frameWidth()`，与 `format.js` 的 `displayWidth()` **故意不一致**：

| 函数 | 用途 | 歧义字符（`─ │ … ↑`）算几列 |
|---|---|---|
| `displayWidth()` | 内容对齐 | 1 |
| **`frameWidth()`** | **这行放不放得下** | **2，永远不低估** |

代价不对称，所以规则不对称：**低估 1 列 = 折行 = 整屏错位；高估 1 列 = 行尾多一个空格，
而装配时尾部空格本来就被去掉，零代价。**

**边框一律 ASCII，且竖线之外一根横线都不画**（结构靠**空行 + 缩进 + 反显**表达）。
理由：`U+2500–U+257F` 是 UAX #11 的 **Ambiguous**，而**本机 WT 1.24 没有
`ambiguousUnicodeWidth` 设置（1.25 才加）**——我们无法让用户去关掉它。
⇒ ASCII 是"它本来就不会错"，`frameWidth` 是"我们算错了也不会烂屏"，**两层防御，理由不同**。
（箭头 `↑↓` 也是 Ambiguous 但它在**页脚**，有 `fitLine` 兜着。**结构字符不许歧义，内容字符可以。**）

三级退化：

| 档 | 条件 | 表现 |
|---|---|---|
| too-small | `cols < 40` 或 `rows < 8` 或 `bodyH < 3` | 正中一行「终端太小（当前 30×6，至少 40×8）」 |
| single | `cols < 72` | 只画列表；`Enter` 进详情、`Esc`/`←` 回列表 |
| two | `cols ≥ 72` | 左列表（`clamp(cols*0.34, 20, 40)`）/ 1 列分隔 / 右详情 |

> ★ **72 这个数是页脚定的，不是栏宽定的**（页脚提示串 `FOOTER_HINT` **实测宽 53**，
> 加 2 列边距 = **55**，而 `72 - 2 边距 = 70 ≥ 55`，余量 17）。
> 改提示串就得回头核这个常量 —— **要有守护测试钉住这层耦合**
> （`footerWidth() <= TWO_PANE_MIN_COLS`），否则常量会悄悄脱节。
> ⚠️ 两栏档下页脚**必须一行放得下**：放不下就会被 `fitLine` 截掉尾巴，
> 用户就看不见 `q 退出` 了——那是所有退化里最糟的一种。

行号算术（1-based，与终端 `CUP` 同一套）：`1 标题 / 2 空行 / 3..2+bodyH 正文 / 其后页脚`，
守恒式 **`2 + bodyH + ftr === rows`** 必须单测。

> ★★ **`ftr` 由页脚内容现算，不许按档写死**：`ftr = footerLines.length`，
> 而 `layout()` 把 `footerLines` 一并返回（一处算、一处用，别让装配侧再拼一遍）。
> 写死成"单栏 2 行、两栏 1 行"的话，71 列下页脚其实**一行**就装得下
> （`splitFooter(71).length === 1`），于是帧少画一行 ——
> **而少画一行就是上一帧的最后一行留在屏幕上**：`[2J` 只在进屏那一次，
> 全量重绘**不自愈**。帧的行数必须**正好** `rows`。
> ⚠️ `too-small` 档**不遵守守恒式**（整屏只有一行提示，`bodyH`/`ftr` 都是 0），扫守恒式的测试要跳过它。

**滚动是边缘滚动**（`top` 进 state），不做"光标永远居中"（每按一次整列都动，
用户失去位置锚点）。⚠️ **`PgUp`/`PgDn` 必须显式滚 `top`**：只靠 `scrollTop` 的话，
光标在窗口顶部时按 `PgDn` 会"认为光标还在窗口里"而不滚——用户按了翻页却只看见光标下移，
那正是"静默地什么都不做"。
「还有多少没显示」用**栏标题**报（`模型 (3/12)`），不用占行的滚动指示器（正文行是稀缺资源）。

**防闪烁三件事，缺一不可**：① 除进屏那次**永不 `[2J`**（要擦上一帧更长的尾巴，那是 `[K` 的活）；
② **一帧一次 `write()`**（不是省系统调用，是让终端把一帧当一帧）；
③ **行尾不补空格，一律 `[K`**（补空格必须补**正好** `cols` 个，多一个就折行）。

**不做 diff 渲染，也不留 diff 开关**：一帧 ≈ 5 KB，30 次/秒 = 150 KB/s，JS 拼接是微秒级；
而 diff 要维护影子缓冲 + 切 run + 每个 run 一次 `CUP` —— 在 Windows 上那是
**更多次、更小的控制台写调用**，正是最容易撕裂的模式。且 WT 的渲染引擎本来就只重绘变化的格子。

#### 六、模型清单：**每次现拉**，拉到的另行登记

**`/models` 有三个消费者，全部现拉、互不共用缓存**：① 面板第 3 步（本节四）；
② 资源表的「拉取 / 全部拉取」（本节十一）；③ **启动前校验**（§2.5，超时 2 秒而不是 10 秒）。
第三个消费者尤其不能拿 `resources.json` 顶替——缓存只喂下拉候选与资源表，
"这个模型现在到底存不存在"必须问端点本人。

每次进第 3 步都现拉——**绝不拿旧清单冒充新清单**。理由与 §2.5 规则 2 同源：
清单会变（中转站加模型、key 换端点），而"什么时候失效"没有好答案。

> **2026-10-24 订正**：这里原来写的是「模型清单也一样不缓存……不缓存就没有失效问题」。
> 现在确实记一份（`resources.json`，见本节十一），但那**不是**"拿旧值代替现拉"：
> 它是用户**看得见**的资源登记，带 `url` 与 `fetchedAt`，地址一变就标「地址已变」，
> 随时能手动「拉取 / 全部拉取」；第 3 步仍然每次现拉。**绝对化的措辞作废，
> 「不拿旧清单冒充新清单」这条不变。**

**响应形态容三种**（`core/models-endpoint.js`，纯函数）：`{data:[{id}]}` /
`{data:["id"]}` / 裸数组。只认第一种的话，第二三种的站点会显示成"拉不到"
——**而它其实拉到了**，只是我们没看。id 一律**只认 `id` 字段**，不猜
`name`/`model`/`slug`：猜错的表现是往优先级列表里塞一个不存在的模型名，
而那个错误要到 `cxt run` 时才由 Codex 报出来——**离现场太远**。

> **2026-10-18 实测**（内网 One API 中转，用真实 key 跑通整条链；地址不进仓库）：
> 形态是 **OpenAI 那一种**（`{data:[{id, object, created, owned_by, root, parent…}]}`），
> 200 拿到 27 个模型；坏 key 回的是 **401 + `{"error":{…}}` 里的中文消息**
> （`无效的令牌 (request id: …)`）——解析层原样透出，读得懂。
> ⚠️ **服务端顺序是插入序，没有意义**（`Gemini / Grok / Claude / gpt-… / Kimi` 混着来）。
> 解析层**保持原序**（解析器的职责是报告服务端说了什么，不是替它排序），
> **排序是面板第 3 步的事**（27 项拿方向键翻，有序才好找）。

⚠️ **HTTP 200 也可能是错误体**（网关转发成功、上游用错误 JSON 回话），
所以 `parseModelsResponse()` **先认 `error` 再看状态码**——否则用户看到的是
"该端点没有返回任何模型"，而真因是"你的 key 无效"。
同理，**"列表是空的"与"一项都认不出"必须分开报**：前者是合法回答（该让用户手敲），
后者是我们看不懂人家的形状（该报错）。

**`fetchModels()` 不抛错**，返回 `{ok, ids, status, error, url}`——理由与
`detectTerminal()`（§4.2）一致：**拉不到是常态，不是异常**。中转站常在内网、
或者干脆没实现 `/models`；界面必须能显示"为什么拉不到"再给三条出路（本节四）。
它必须自带 `AbortSignal.timeout()`：**没有超时的话，一个不响应的内网地址会让面板
永远卡在第 3 步**，而那是 raw mode 里——用户连 Ctrl+C 都出不去（本节八）。

##### ★★ 密钥出门口：`redactSecret()`

`Authorization: Bearer` 是**全项目唯一带着明文密钥出门**的地方。而密钥会**回来**：

1. undici 的错误消息在某些形态下带着完整的请求描述（含请求头）；
2. 有些网关把收到的 `Authorization` 原样写进错误体。

两处都不是我们造的，但**是我们递出去的**——所以由我们负责擦干净。
⇒ `fetchModels()` 是**薄壳**：真正的活在 `fetchModelsRaw()`，出口处统一
`redactSecret()` 一遍。做成单一出口而不是在每个 `return` 上写一遍，
理由与 §2.9 的"唯一入口"同源：**漏掉一处就等于没做**，
而漏掉的那一处正是没人测到的那条分支。

⚠️ **短于 8 字符的密钥不抹**：`replaceAll` 一个 2 字符的"密钥"会把
`fetch failed` 打成 `fetch f***iled`——错误信息直接变成噪音，
而 2 个字符的 bearer token 在任何真实网关上都不可能通过。**代价不对称。**

#### 七、非 TTY 与 `CXT_UI=plain` 逃生舱

`CXT_UI=plain` → **不进备用屏、不进 raw mode**，用逐行输出（复用 `pick.js` 的
`parseChoice` 那套）。它是三件事：

1. 终端被强杀后**备用屏残留**时的出路（见 §2.14 八）；
2. CI / 录屏 / 无障碍场景；
3. ★ **e2e 的测试路径**——没有它，面板的一切都只能手工验。

**两条前端共用一个 reducer，连排版都是 `render.js` 出的**（`renderLines()`），
只换两件事：输出方式（逐行而非定位）、输入方式（一行而非按键）。理由是
`CXT_UI=plain` 的全部意义是"**备用屏坏了的时候，我还能看见同一份内容**"——
内容不一样的话它就不是逃生舱，是另一个程序。

**输入语言**（一行 = 一次完整意图）：

| 敲什么 | 等于 |
|---|---|
| `:q` / `:b` | `Ctrl+C` / `Esc`——**Esc 在行里敲不出来**，而"想退出去"必须有出口 |
| 空行 | **回车，永远如此**（含"有输入框的屏"）。★ 见下面那条 |
| 数字 | 主屏/列表屏 = 移到那一项并回车；第 1 步 = 进那个子目录；第 3 步 = 勾选/取消 |
| 第 3 步的 id | 直接敲 id（逗号或空格分隔）——几百个 id 让用户去数编号是荒唐的 |
| `j` / `k` | 上下移动，**不动别的**。见下面那条 |
| 别的单字母 | 主屏的 `n` / `e` / `d` / `r` / `q` |
| 别的行 | 有输入框的屏 = **整行替换**（先退格清空再逐字喂，与逐字敲逐字节同落点） |

★ **空行 ≠ "我要改成空"**。第一版把空行实现成"先清空输入框再回车"，于是第 1 步的
**预填路径被自己抹掉**：提示写着「回车用上面的路径」，用户敲回车，得到的是
「路径不能为空」。它**只在输入框里已经有字时才现形**——正是手工点几下最不容易
发现的那种。判据：想清空就在面板里按退格；逐行模式里一行就是一次完整意图。

★★ **没有 `j`/`k` 的话，`e` 与 `d` 在逐行模式下只能作用在第一项上**：编号那条路是
"移过去 + 回车"，而回车 = 启动。于是"想删第 2 条绑定"在面板里是 `↓ d y`，
在这里却无路可走——**一个功能在一条前端上不可达，比它长得不好看严重得多**。
（顺序上它必须排在"有输入框的屏"**之后**：输入框里 `j`/`k` 是字母。）

#### 八、★ 保证还原（`ui/term.js` 的全部职责）

进屏：`?1049h` + `[2J[H`（**只此一次**）+ `?25l` + `?2004h`
出屏：`?2004l` → `?25h` → `?1049l`（**顺序不可换**：光标状态是终端的，
带着隐藏光标回主屏 = 用户看不见自己的 shell 光标）

要挂的网（**顺序：先挂网，再进屏**——反过来的话，进屏与挂网之间崩了就没救了）：
`exit` / `SIGINT` / `SIGBREAK` / `uncaughtException` / `unhandledRejection` /
`stdin` 的 `end` + `close`。还原函数必须**幂等**（多条路径可能同时触发，
双份 `?1049l` 会把备用屏弹两次）。

**拦不住的**：`taskkill /F`、任务管理器、关终端窗口——Windows 上是
`TerminateProcess`，**没有 `'exit'`、没有回调**。所以 `CXT_UI=plain` 不是可选项。
README 必须写清"备用屏卡住了怎么办"。

#### 九、Windows 专有暗礁

全部实测事实见 **§7.17**。三条最容易踩的：TTY 写是**异步**的（`exit` 里必须 `writeSync`）、
而 `writeSync` 写中文会**乱码**（所以画帧与出屏是**两条不能互换的写路径**）、
`process.stdout.columns` 在 Windows 上是**屏幕缓冲宽度**不是可见窗口宽度。
另有 IME 候选框锚在光标位置 ⇒ 输入模式下必须把真光标 `CUP` 到输入框那一格并 `?25h`
——**这是 `render()` 返回 `{frame, cursor}` 而不是一个字符串的原因**。

#### 十、Web 控制台（2026-10-18 新增）

**一句话：同一个面板，换成浏览器里的一个表单——下拉、勾选框、按钮，鼠标点。**

用户原话：「`cxt ui` 这种在终端显示的 ui 界面操作麻烦。不是我期待的那种 ui，
我期待的是传统的、类似 app client 界面的那种下拉列表、checkbox 这种组件组成的一个表单。」
⇒ 这是**换一种前端形态**，不是修补 TUI。方向键驱动不是他要的东西。

两个前端**共用同一套副作用词表、结果事件、`reduce()` 与 `makeExecutor()`**——
共用的全是「业务」，不共用的全是「呈现」（TUI 走 `render.js` + `term.js`，
控制台走 HTML/CSS + `platform/serve-web.js`）。所以**没有第二套写配置的路径**。

**入口见「一、入口」那张表**——两张表一定会漂移，所以只留一张。

启动时**总是**打印「打不开浏览器？用 `cxt ui` 进全屏面板（SSH/无头环境）」：
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
| `sessions[]` | 在场层（§2.16） | `{id, token, cwd, startedAt, pid, unread, pool:{status,label}}`——**只给 live**；`ended`/`dead` 不进面板（只进 `cxt sessions`）；`pool` 两个键与资源行同口径（中文只在 `core/pool.js` 定义一处） |
| `recentSessions[]` | 在场层（§2.16） | `{id, token, cwd, startedAt, endedAt, exitCode, state, unread, pool:{status,label}}`——**24 小时内的 ended/dead**（至多 5 条），会话条「恢复」按钮的来源 |
| `attention[]` | 在场层 + 池 + 信箱（§2.16） | `{kind, severity:'high'\|'normal', title, detail, actions:[{label, op, args}]}`——★ **服务端算好的「需要你处理」清单**（至多 5 条，`actions` 至多两个）；健康时是空数组、整块不显示。页面只照单画按钮，**不做任何判断** |

★ `items[].layer` 是**给 `disabled` 用的**：`ui.js` 的 `layerFor()` 给出 `project`/`binding`/
`token`/`default`，或 `none` = **没有可写的一层**。页面只拿它设那个按钮的 `disabled`——
`'none'` 时点下去只会挨一句「这一项的模型不来自可写的一层」，而**"点了才被骂"正是这个前端要消灭的东西**。
⚠️ 所以它**是键集里的一员**，不是前端能自己算出来的（算出来就是第二处定义）。

⚠️ **键集变了就是接口变了**：两个项目一起改，§6.3 的黄金形状断言跟着改。
**别在一边加个"顺手"的字段**——另一边看不见它，而失败会发生在**另一边**。

★ **明文密钥永不过线**：`view()` 只发打码值（`probeFor` 早就打好码了）。
唯一的例外是"新建 token"表单里**用户自己敲进去**的那个。

**第二条输入通道**：reducer 是**按键**形状的，而表单没有光标、没有退格。所以 `ui/app.js`
多一个 `panel` 事件族（`{type:'panel', op, …}`），它是**语义**事件。绝大多数 op 是既有
handler 的别名；**`move-model` 是真新增**——`checked` 的顺序只可能是"勾选时追加"（§2.14 四），
**没有任何按键序列能表达调序**。

> ⚠️ `ui/app.js` 与 `cmt` 的同名文件**逐字一致**（§4.1）。新增那段的注释里
> **只许写节名**（「面板 · Web 控制台」），**永远不许写节号**——本节在 cxt 是「十」，
> 在 cmt 是「十一」。

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
  **成功也回 1**（§7.17 M10），所以只等 `spawn` 事件，不等 `exit`。

**第 3 步的出口是「下一步」按钮**（`{op:'next'}`）。

★ 它只是**回放一个 `Enter`**（`replay(state, { type:'key', key:'enter' })`）——
"第 3 步回车去哪"依然只有 reducer 一处定义（有模型就进第 4 步；改模型那条短路直接写入）。
网页上没有"回车就走"这回事，少了这颗按钮，第 3 步就是**死胡同**（勾完模型也到不了第 4 步）。
`wizard.edit` 时它藏起来——那时候第 3 步就是最后一步，`edit-apply` 那颗「写入」才是出口。

**退出**：页面上的「退出」按钮（`{op:'quit'}`）· `Ctrl+C` · 空闲超时。
★ `quit` **执行器不认**（`ui.js` 的 `default:` 会把它变成 `failed`），所以 `makeSession.feed`
**自己先把它滤掉**，不送进 `exec`——于是"退出"在桥那一侧是**读一个状态位**
（`state.quitting`），不是"接住一个副作用"。三种退出**全在 `serve-web.js` 里**收口。

★ **`slots` 不许进控制台**（与 §8 第 12 条同一条）：控制台只配 `models`，
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

#### 十一、模型下拉与资源表（2026-10-24 新增）

**主屏的模型列是一个原生 `<select>`**，不再有「改模型」按钮。选中即写，写的就是
`cxt model use` 那条路：**把选中的模型提到首位**（`core/models.js` 的 `promoteModel()`，
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
- `models` 保持**服务端原序**（§2.14 六：解析器只报告服务端说了什么）；排序是下拉的事。
- 坏 JSON **不硬报**：`readJson()` 对 `config.json` 是抛错的（§2.4），但资源表是可丢弃的
  缓存——`readResources()` 自己吞掉退回空表。**一份坏缓存不许把面板打死。**
- 指向已删 token 的条目**不显示、不自动删**（与"未知状态不自动改写"同一纪律）。
- 上限 500 个 id（`MAX_MODELS`）：一个坏响应不该把下拉撑成不可用。

**视图模型多两个键**（键集仍冻结）：顶层 `resources[]`
（`{name,label,masked,baseUrl,url,cachedUrl,models,fetchedAt,stale,projects,
priority,priorityState,gatewayCount,gatewayUnified}`，后四个见下）与
`items[].modelOptions`（已声明在前、缓存补后、去重；**在服务端算好**——
前端不认"哪些模型出现过"这种事）。

（另有两个 token 池相关的键：顶层 `poolStatuses` 与 `resources[].pool`——见 §2.15 七。）

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

**一行 = 一个 token，身份列就是那把 key 本身**——用户认的是"这把 key"，`name` 只是配置标识符。

| 列 | 内容 | 可编辑 |
|---|---|---|
| 身份（token） | `sk-****abcd`（mono，主）+ 昵称输入框 + 机器名 `relay-a`（次要） | 昵称 |
| 服务端 | 生效 URL（复用已有的 `url` 字段） | — |
| 模型优先级 | 前 3 项带 `①②③`，其余 `+N`；点开对话框 | ✅ |
| 绑定数 | 原语义不变 | — |
| 操作 | 拉取（原有） | — |

★ 「密钥」列**删掉**——与身份列重复，打码值全表只出现一次。
**昵称**走 `set-label`；校验在 `normalizeTokenLabel()`（§2.4 末），空值 = **删键**；
它只是展示，**绝不进路径 / profile / 标题 / 环境**。

**优先级**：`priority` 是 **token 级生效值**（`token.models ?? defaults.models`），
`priorityState` 分 `own` / `empty`（显式 `[]`）/ `inherit`。⚠️ **不含**绑定与项目层——
资源表是按 token 看的；要改路径层回主屏的模型下拉。

**同网关**：`gatewayCount` = 生效 URL 相同的 token 数（含自己；URL 为空时恒 1）；
`gatewayUnified` = 同组每个 token 的 `priority` **逐个相等**。只比 **id 字符串**。

**两个新 op**（同样在 `toEvent()` 之前拦，reducer 一行不动）：

| op | 载荷 | 行为 |
|---|---|---|
| `set-label` | `{name, label}` | `mutateToken` + `normalizeToken`；空 ⇒ 删键；成功 `reloadPanel`，失败借 `notice`，**文件不动** |
| `save-priority` | `{name, ids, scope}` | 清洗后写 `models`；空数组 ⇒ **删键**（回继承）；`gateway` 时服务端**自己**按生效 URL 找同组 token |

`save-priority` 的清洗**在服务端做、不信前端**：`Array.isArray` + 逐项 `trim` + 丢空 +
去重保序 + ≤500 项 + 单项 ≤128 字 + 拒控制字符。`scope:"gateway"` 逐个 `mutateToken`，
中途失败就停，`notice` 说「已更新 N 个 token」。

**`#priority-dialog`**（照 `#status-dialog` 的模子）：**纯前端草稿**、不写盘——↑/↓ 调序、
× 删除、输入框 + `<datalist>` 候选（资源表出现过的 id ∪ 当前 `priority`，服务端给，
前端**不查网络**）、手敲 id 也行。复选框「同网关的 N 个 token 一并套用」只在
`gatewayCount ≥ 2` 出现，**默认勾选当且仅当 `gatewayUnified`**——已统一的保持统一，
已分叉的只改自己（统一必须是显式动作）。底部灰字「空列表 = 回到继承」。
⚠️ **不做拖拽**：没有指针基础设施，↑/↓ 与状态对话框同一套交互，键盘也能用。

##### ★ 资源表：添加 token（2026-10-25）

**资源板块不再只读**——空表时不必切回项目屏走向导第 2 步。

| op | 载荷 | 行为 |
|---|---|---|
| `add-token` | `{name, secret, baseUrl?}` | 服务端**直接复用向导的 `doSaveToken()`**（`ui.js`，因网页控制台同路而导出，同 `doApplyModels` 例）；校验/重名/空密钥 ⇒ `notice` + **一个字节不写**；成功 ⇒ `reloadPanel` + `notice`「已添加 \<name\>」 |

- `name` 走 `validateTokenName()`（§2.4）；`secret` 必须非空字符串；`baseUrl` 可选，
  空串 = 不写键。**明文密钥只在 POST body → 落盘这一趟**，回执视图**永不含 secret**
  （§2.14 十文件头铁律）。
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

### 2.15 ★ Token 池：清单状态与分配策略（2026-10-31 新增）

> 来源：用户现成的团队工具 `token_pool.py`（Redis 为主 + xlsx 导入 + 额度探测）。
> 移植时的硬要求：**放弃 Redis 依赖，改成不依赖数据库的本地方式；Redis 能力保留但降为可选。**

#### 一、池是覆盖层，不是第二份清单

原方案里池**拥有** sk。本项目里 `tokens/<name>.json` 已经拥有 sk 了（§3.1 所有权）。
再存一份 = 第二个家，且两份状态必然漂移。所以：

> **池 = 挂在既有 token 集合上的一张状态/用量覆盖层，按 token 名索引，没有一个 `sk` 字段。**

- `cxt token add` 仍是建 token 的唯一入口；`pool import` 只是"批量 `token add` + 建条目"。
- 池里出现的名字，若 `tokens/<name>.json` 不存在 ⇒ 读取时**直接丢弃**（不报错、不复活）。
- 反向不成立：有 token 没条目 = **未入池**，`pool list` 标出来，不自动补条目。

#### 二、数据模型 `pool.json`

`poolPath(home)` 加进 `core/paths.js`；**可丢弃**（删了只丢状态与用量，下次探测就回来，同 `resources.json`）。

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-31T08:00:00.000Z",
  "rr": 4,                        // 轮询游标
  "lastPick": { "C:\\work\\x": "relay-a" },  // -c 守卫用（§2.15 三·3）
  "entries": {
    "relay-a": {
      "status": "ok",             // ok|no_quota|invalid|net_fail|other|unknown
      "detail": "HTTP 200 · 812ms",
      "checkedAt": "2026-10-31T07:59:00.000Z",
      "calls": 12, "in": 32000, "out": 9000,   // 会话条数 / 输入侧（含缓存）/ 输出侧
      "usageAt": "2026-10-31T08:00:00.000Z",   // 用量是什么时候算的；'' = 从没算过
      "models": {                 // ★ 按模型分开记——花费只能从这里算（§2.15 九）
        "deepseek-flash": { "input": 12000, "cacheRead": 20000, "cacheWrite": 0, "output": 9000 }
      }
    }
  }
}
```

- ★ `models` 的每一行**恰好四个键**：`input` / `cacheRead` / `cacheWrite` / `output`，**没有 `calls`**。
  `calls` 是消息条数，摊到模型上既不可导也无人读；多一个键不会报错，只会在 `pool.json` 里
  静默多出一行噪音，而那份文件用户是要手看的。**聚合 `in` 必须恰好等于明细之和**（§2.15 九）。
- **不加锁**：沿用 §六「并发读-改-写不加锁」的既有裁决；写入仍走 `writeJsonAtomic()`，
  但**必须先读-改-写整份**（`resources.json` 被整份覆盖的坑在这里同样成立）。
- `config.json` 只加一个**不含密钥**的 `pool` 键（进 `normalizeDefaults` 白名单）：
  `{ "auto": true, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 }`。
  ★ 两个秒数**不是一回事**：`cacheSeconds` 管额度探测，`usageSeconds` 管用量重算（§2.15 九 9.7）。
- ★ **Redis 地址不进 `config.json`**：它可能带密码，而 `config.json` 是"旧版本会整份拒载"的承重文件。
  取址顺序 `--redis <url>` ＞ 环境变量 ＞ `pool.json.redis`；三者都支持 `env:VAR` 间接引用。

#### 三、启动接线（唯一会"自动挑"的地方）

1. **插入点**：`planLaunch()` 里 `resolveSession()` 之后、`planFrom()` 之前——
   **必须在 `buildExecArgs()` 之前**，因为窗口标题与 argv 都用 `resolved.token.value`。
   返回 `{resolved, note}`（形状照抄 `src/cli/preflight.js`），但**不沿用它的"永不抛"**：
   `preflight` 失败只是少个模型，池挑不出来却是"这次根本没有身份"——那时必须直接报错，
   否则用户拿到的是"四要素缺 authToken"，而那句话对"我明明加了 `--pool`"毫无解释力。
   `SOURCE` 加一个 `POOL`，`run --print` / `resolve` 的来源列直接显示。
2. **触发条件**（二者之一）：
   - `resolved.token.value === null` 且 `defaults.pool.auto !== false` —— **补空位**；
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
   | `cxt run` / 面板「启动」 | ✅ | 都走 `planLaunch()` |
   | `cxt run --print` | ✅ | 「跑之前先看见」正是它存在的意义，必须显示真的会挑谁 |
   | `cxt resolve` | ❌ 只提示 | 只读诊断命令不该为看一眼发网络请求；打一行「池可提供」 |

   `--pool` 要**同时**进 argv 声明与 `toResolveArgv()`，漏一处就是静默失效。

#### 四、分配顺序与探测时序

```
候选 = 全部条目中 status ∉ {no_quota, invalid}
排序 = 按总用量升序 → 并列时按 rr 游标轮询        ← orderCandidates()，纯函数
逐个探测，遇到第一个 ok 立刻停                     ← 常态 1 次请求；TTL 内 0 次
全部失败 → 抛 CxtError，逐条列出失败原因
```

★ **「在用靠后」因子**（§2.16）：排序前，把**当前活动会话正持有的 token**（在场层）
移到候选表**末尾**——不在用的全排完才轮到在用的。它只是**排序，不是排除**：
在用 ≠ 不能用（同一 token 多开是允许的，§8 第 6 条）；在场层为空时行为与旧版一致。

**新鲜度**（沿用原方案，`core/pool.js` 纯函数 `isStale()`）：

| 上次状态 | 何时重探 |
|---|---|
| 没有 `checkedAt` | 立刻 |
| `ok` | 超过 `cacheSeconds`（默认 300） |
| `no_quota` | **跨月才重探**（月初额度自动刷新——这是原方案最关键的语义） |
| `invalid` | 24 小时后 |

- 探测 = 发**一次最小真实请求**（用户 2026-10-31 拍板）：cxt 按 token 自己的 `wireApi` 走
  `/chat/completions` 或 `/responses`，输出上限取协议下限；cmt 走 `/v1/messages`（`max_tokens: 1`）。
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

**视图模型多两个键**（键集仍冻结，见 §2.14 十一）：

- `resources[].pool = {status, label, detail, checkedAt}`，**四键恒定**——没入池的那一行也是
  `unknown` / 「未检测」 / `''` / `''`，不是 `null`。
- 顶层 `poolStatuses = [{status, label}]`，顺序 = `STATUSES`（好坏顺序）。页面**只画不翻**：
  六档的中文只在 `core/pool.js` 的 `STATUS_LABEL` 里定义一处。

**两个 op 也在 `toEvent()` 之前拦**（与 `set-status` 同一条路，reducer 一行不动）：

| op | 载荷 | 行为 |
|---|---|---|
| `check-token` | `{name}` | 现探（**无视 TTL**：手动点＝"现在就看"）→ `applyProbe()` → 一次 `savePool()` → `reloaded`；`notice` = 名字 + 状态 + detail 摘要 |
| `set-pool-status` | `{name, status}` | 六档之一：`detail='manual'` + 时间戳；`unknown` = **清状态**（`detail`/`checkedAt` 清空），与 `cxt pool reset` 同义 |

⚠️ 手动标注那个 op **叫 `set-pool-status`，不叫 `set-status`**——后者已经是项目状态的 op，
同一个 dispatch 链里重名会被**静默吞掉**（先匹配到的赢，页面看起来"点了没反应"）。

★ 两条路都写 `pool-store.js`（`loadPool` + `ensureEntry` + `applyProbe`/手改 + `savePool`），
与 `cxt pool check` / `cxt pool status` / `cxt pool reset` 是**同一份实现**——面板和命令行
不可能给出两种状态。★ 两者都**只写本地**，不连 Redis（§五）。

★ 拒绝路径全部只借 `notice` 说一句话、**一个字节都不写**：没有这个 token / 认不出的状态词。

★ 资源屏还有**用量与花费**：顶部一条概览、表里两列、一个 `sync-usage` op——它们与
`cxt pool sync` 是**同一份记账**，见 §2.15 九。

#### 八、命令面

| 命令 | 作用 |
|---|---|
| `cxt pool list` | 所有 token + 状态 + 用量；有 token 无条目标「未入池」 |
| `cxt pool import <file.csv\|xlsx>` | 批量建 token + 建条目 |
| `cxt pool check [name...] [--all] [--force]` | 探测。**三档**：点名 = 只探这几个（没入池的就此入池）；`--all` = **全部 token**；裸的 = **池里已有的条目**（这一档是常态，探测会花钱，不该因为"盘上还有 5 个没入池的"就顺手探一遍）。`--force` 无视 TTL |
| `cxt pool status <name> <status>` | 手动覆盖（`detail` 记 `manual`） |
| `cxt pool reset <name>` | 清状态（回到 `unknown`） |
| `cxt pool sync [--redis <url>]` | 从 rollout 重算用量；带 `--redis` 时写穿 |
| `cxt pool pull --redis <url>` | 反向：把 Redis 里的状态拉回本地 |

`pool` 与既有 `token` 是**两个命名空间**，别混：`token` 管身份与密钥，`pool` 管状态与分配。

#### 九、用量与花费：记录 → 计算 → 呈现

**一句话：`pool sync` 把 rollout 里的用量按模型记进 `pool.json`，价格三级取，
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
| **只算 `pool.entries` 里有的名字**；池外 profile 与未托管的 `~/.codex/sessions` 一律不算 | 未托管那份被算进来就翻倍；池外的会凭空多出一个条目 |

★ 目录发现与解析复用 `usage-sources.js` + `core/usage.js`——与 `cxt usage` 同一份。
★ `usageAt` 取一次、**整批共用**：同一次重算算出来的数，就该有同一个时刻。
★ 入了池但一份 rollout 都没有 ⇒ 归零 + 照样盖 `usageAt`——**"0 用量"与"从没算过"必须能区分**。

##### 9.2 花费：价格三级，绝不说免费

`costOf(tokens, price)`（`core/prices.js`），`PRICE_UNIT = 1_000_000`（USD / 百万 token）。
价格三级、**优先级从高到低**（与 `cxt usage` 完全同源，见 §2.14 十一 价格小节）：

1. **`prices.json`**（手写结算价）
2. **`resources.json` 里端点自报的 `pricing`**（挂牌价）
3. 都没有 ⇒ **`—`**，**绝不冒充 `$0`**

- **①永远压过②**：用户写的实际结算价不能被网关挂牌价默默盖掉。
- `costOf()` 在没有价格时返回 **`null`，不是 0**——`$0` 会说"免费"，那是谎话。
- ★★ **价格逻辑不许进 `core/pool.js`**：那个文件与 cmt **逐字一致**，而 `core/prices.js`
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

新增的 `resources[].usage` 与顶层 `resourcesSummary` **都是视图模型键**（§2.14 十 的
"键集冻结"管着它们）。⇒ **两个项目 + 两份契约 + 两边的黄金形状断言一起改**；
在一边加、另一边没加，失败只会发生在**没加的那一边**。

##### 9.7 什么时候重算：`usageSeconds` + 增量缓存

9.1～9.6 里 `sync` 只由人按。实际用起来才知道那不够——用量是个一直在长的数，
而人不会每次开页面都记得按一下。所以补两件：**到点自己算**、**没变过的文件不重读**。

**触发点（五个，两种时机）**：

| 谁 | 什么时候 | 无条件 / 过期才做 |
|---|---|---|
| `cxt pool list` | 开局 | 过期才做 |
| 面板（`cxt ui`） | `commands/ui.js` 的 `run()`，**一次** | 过期才做 |
| 网页控制台（`cxt ui --web`） | `commands/ui-web.js` 的 `runWeb()`，**一次** | 过期才做 |
| 网页「重算用量」 | `sync-usage` op（9.5） | 无条件 |
| `cxt pool sync` | 命令行 | 无条件 |

- ★ **`autoSyncUsage()` 只在启动路径上调一次，绝不放进 `buildPanelData()`**：后者每次
  `reloaded` 都跑（切个 tab、点个按钮），放进去等于"每按一下就扫一遍 rollout"。
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

### 2.16 ★ 会话在场层与消息信箱（2026-11-04 新增）

**一句话：每个窗口在启动时留下一条记录，并可以给对方留一张纸条——纸条是惰性数据，工具永不因它行动。**

> 参考 `deepseek-ai/dsh-superagent-prototype` 的域设计（Ticket 自有状态 / 惰性消息 / 授权与上下文分离），
> 但**只抄纪律、不抄形状**：那套是单 Engine + SQLite 的中心化总线，本工具是点对点文件——不引 daemon、
> 不加锁、不加 LLM 路由器（§1.4 不 hook、命令跑一次，不是后台常驻）。

#### 一、在场层：`sessions/<id>/meta.json`

- 目录在**状态根**下：`~/.codex-multi-token/sessions/<id>/`。
  ⚠️ **与 `profiles/<t>/sessions/` 无关**——那个是 Codex 的会话历史（Codex 所有，§3.1），
  这里的是 cxt 自己的在场记录。**同名不同物**，文档与代码里不许混用。
- **写者是 `cxt exec`，而且只有它**（`recordSessionStart` / `recordSessionEnd`）：
  - 启动时写 `{v:1, id, token, cwd, pid, startedAt, endedAt:null, exitCode:null, model}`；
  - 正常退出时**读-改-写**补 `endedAt` 与 `exitCode`；
  - ★ **写失败绝不阻塞会话**：整段 try/catch，stderr 一行警告，会话照常启动。
    在场层是锦上添花，不是承重件——它坏了不许让窗口打不开。
- ★★ **meta 永不记 argv**。`cxt exec` 的 `--token-value` 是明文 sk（§5）；这里只记
  `token` 名 / `cwd` / `pid` / 时间 / `model` 五类**安全字段**。
  与 §3.1「池不含 sk」同源：在场层也是一个覆盖层，**不是第二个密钥落盘点**。
- **id 形状**：`<profile 名>-<base36 时间>-<pid>`。可读、可按时间排序、逐次唯一。
- **`-c` / `resume --last` 续接不受影响**：续接是 codex 的语义（按 CODEX_HOME + cwd，§2.5），
  与在场层无关；在场层只回答"现在有哪些窗口开着"。

#### 二、活性判定与它的边界

三态，读时现算（**不落盘状态**——落盘就多一个会过期的真相）：

| 态 | 判据 |
|---|---|
| `live` | `endedAt` 为空 **且** `process.kill(pid, 0)` 说得通（EPERM 也算活） |
| `ended` | `endedAt` 非空（正常退出，带 `exitCode`） |
| `dead` | `endedAt` 为空但进程已经没了（崩溃 / `kill -9` / 终端被关） |

★ **pid 复用是已知风险**：Windows 的 pid 会被快速复用，一个 `dead` 的旧会话可能因为
pid 恰好被别的进程占用而被报成 `live`。评估：`cxt sessions` 是给人看的概览，
**不是审计凭证**；`startedAt` 与 id 里的时间戳让人能看出真伪。要精确需比对进程启动时间，
**本期不做**，如实记录在这里（§8 第 18 条）。

#### 三、消息信箱：一消息一文件，惰性数据

```
sessions/<id>/inbox/<ms>-<rand>.json   # 未读
sessions/<id>/read/<ms>-<rand>.json    # 已读：同目录 rename 进来（原子）
```

- 消息形状：`{v:1, id, ts, from:"human"|<sessionId>, to, type:"info"|"action-request", body}`。
- **写 = `writeJsonAtomic`；读 = rename**（同目录原子）。「已读」不是一个字段，是文件的位置。
- ★★ **消息是惰性数据：工具自己永不因消息行动。** 没有 daemon、没有 hook、没有"收到消息就
  投进某个会话"（那要写 Codex 的状态文件 / 改 agent 本体，§3.1 禁止）。
  唯一送达方式：**人告诉 agent「去看一下信箱」→ agent 自己跑 `cxt msg inbox`**。
  这是「执行权只经人、永不因投递产生」在 v1 的可执行形态——
  `type: "action-request"` 只是给**读者**的标注，不产生任何执行权。
- **发送者识别**：`cxt exec` 把 `CXT_SESSION_ID` 注入 agent 环境（§2.6 注入表加一行，
  净化表同样加一行——嵌套 `cxt run` 不许继承父会话的身份）。
  `cxt msg send` 读到该变量且会话仍 `live` ⇒ `from` = 会话 id；否则 `"human"`。
- **回环刹车（v1 靠结构，不靠计数）**：没有自动转发、没有自动回复，A 让 B 回消息需要
  两次人工动作，**回环物理上不存在**。`observe` / `auto` 放量档**不在 v1**：它们的前提是
  存在一个"会自动读信箱并回复"的执行体，而本工具按 §1.4 不内置任何执行体。
  将来先有执行体，再按 dsh 的 off→observe→auto 顺序引入；**不预先实现空开关**
  （一个不驱动行为的设置比没有更糟）。

#### 四、命令面

| 命令 | 作用 |
|---|---|
| `cxt sessions [--json]` | 列出全部会话（live / ended / dead 三态 + 未读数） |
| `cxt sessions prune [--older-than 30d] [--force]` | 删 `ended`/`dead` 且超龄的会话目录；**有未读时拒绝，`--force` 才放行** |
| `cxt resume <id前缀>` | 恢复 `ended`/`dead` 会话：同 token、同 cwd、带 `-c` 开新窗口；**live 拒绝** |
| `cxt msg send <id前缀\|--token <t>> [--type info\|action-request] <文本...>` | 投一条消息（只投给 **live** 会话；`--all` 广播） |
| `cxt msg inbox [--session <id>] [--peek] [--json]` | 看信箱；默认看自己的（在会话内）或全部 live（在会话外）；**默认读完即标记已读** |
| `cxt msg gc [--older-than 7d]` | 清理超龄消息（inbox 与 read 都算） |

- 消息与在场记录**都可丢弃**：删了不损坏任何东西——这是它们的可重建级别（§3.4）。
- `msg send` 的目标解析不出 live 会话 ⇒ **报错**（不是静默丢弃）：用户敲了命令，
  就必须知道纸条有没有送到。
- 输出**只打印 token 名 / 会话 id / 时间**，消息体原样打印——
  ⚠️ 文档要警告：**不要把密钥贴进消息**（消息是明文 JSON，与 `pool.json` 同一地位）。

#### 五、网页控制台

资源屏顶部一条**会话条**：live 会话一行一个（token、cwd 末段、状态点、未读徽章），
全部健康且无未读时折叠成一行计数；`ended`/`dead` 不出现（它们只进 `cxt sessions`）。
视图模型加顶层 `sessions` 键（**键集冻结**，两边 + 黄金断言 + 两份契约一起改，§2.14 十 / §8 第 17 条）。
「全部标已读」走旁路 op `msg-read-all`（`{session}`），成功 `reloadPanel`——
与 `set-status` 同一条路：**在 `toEvent()` 之前拦下**，reducer 一行不动。

会话条下方还给**最近关闭**（24 小时内、至多 5 条）一条恢复入口：有未读的逐行显示，
其余折成一行「恢复最近的」。恢复 = 同 token、同 cwd、带 `-c` 开新窗口
（旁路 op `resume-session`，与 `cxt resume` 同一实现 `resumeSession()`）。
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
- **跨工具总线（cxt ↔ cmt）**：两个状态根互不相认；与 §8 第 10 条「是否合并」同一条边界。
- **消息线程 / reply / hops 自动转发**：v1 消息是平的，靠 `ts` 与 `from` 读上下文。

---

## 三、文件夹创建与管理策略

### 3.1 所有权三分类（最重要的表，违反即 bug）

| 路径 | 所有者 | cxt 的权限 |
|------|--------|-----------|
| `config.json`、`projects.json`、`tokens/*.json`、`catalogs/*.json` | **cxt** | 读写 |
| `pool.json`（§2.15） | **cxt** | 读写。★ **不含任何 sk**——它是挂在 `tokens/*.json` 上的状态/用量覆盖层 |
| `sessions/**`（§2.16） | **cxt** | 读写。★ **不含任何密钥**——只记 token 名 / cwd / pid / 时间；消息体是用户自己写的文本 |
| `profiles/<t>/config.toml` 的**受管区**（§2.9） | **cxt** | 读写（每次 exec 同步） |
| `profiles/<t>/config.toml` 的**其余部分**（含 `[projects.*]`） | **Codex / 用户** | ❌ 绝不写、绝不删 |
| `profiles/<t>/launch.{cmd,sh}`、`config.toml.cxt.bak` | **cxt** | 写 |
| `profiles/<t>/` 下**其余一切**（auth.json / sessions / history / log / sqlite） | **Codex** | ❌ 绝不写、绝不删、绝不改 |
| `<项目>/.cxt.json`（§2.13） | **用户 / 仓库** | ⚠️ **只读**，唯一例外是面板向导第 4 步里用户明确选了"写进本项目"（§2.14 四）。**绝不自动创建**（§2.13 六） |
| `~/.codex/`（用户原始 CODEX_HOME） | **用户 / Codex** | ❌ **任何情况下都不读不写不删** |
| **网页控制台**（§2.14 十）的端口与路径口令 | **没有人** | ❌ **不拥有任何文件**——只在内存里。无状态文件、无缓存、无锁；进程一关就没了 |

> **铁律：cxt 不写 Codex 的任何状态文件。** 不碰 `auth.json`、不碰 `sessions/`、
> 不碰 `history.jsonl`。**唯一的例外**是 `config.toml` 的受管区——那是设计上必须的，
> 且被 §2.9 的四条铁律严格圈定。
> 注意这与 `cmt` 的"一个配置文件都不写"不同：Codex 没有等价于 `CLAUDE_CONFIG_DIR` 之外的
> 纯环境变量注入通道，所以受管区是**必要的妥协**，不是可以随便扩大的许可。
> ★ 控制台那行是**故意**的：它唯一会写的文件就是 `config.json` / `projects.json` / `.cxt.json`——
> 走的是**既有**的 `writeJsonAtomic()`，**不是它自己的一套**。所以"控制台有没有
> 多出一个真相源"这个问题，答案是**没有**。

### 3.2 创建时机（惰性，绝不预建空目录）

| 触发 | 创建 |
|------|------|
| `cxt token add` / `cxt bind` | 根目录、`config.json`（若无）、`tokens/<t>.json` |
| 首次 `cxt run <t>` | `profiles/<t>/`、`config.toml`（受管区）、`launch.*`（仅兜底路径） |
| 首次用到 `catalog` | `catalogs/<name>.json` |
| `cxt pool import` / `cxt pool check` / 首次成功从池里挑（§2.15） | `pool.json` |
| 每次 `cxt exec`（§2.16） | `sessions/<id>/meta.json`（写失败只警告，不阻塞启动） |
| **面板向导第 4 步**（§2.14 四） | **`<项目>/.cxt.json`** —— ⚠️ **这是唯一一条会创建它的路**（§2.13 六） |

### 3.3 删除与防误删

- `cxt token rm <t>` **默认只删** `tokens/<t>.json`——profile 里有登录态和会话历史，**保留**。
- `cxt token rm <t> --purge` 才连 `profiles/<t>/` 一起删，且需二次确认（`--yes` 跳过）。
  **删前必须提示**：该目录含 Codex 的 `auth.json`、会话历史，以及 cxt 的备份文件。
- `cxt token rm <t>` 若该 token 仍被 `bindings` 引用 → **警告并列出引用它的路径**，不静默留悬空绑定。
- **任何情况下都不删 `~/.codex/`**（用户主配置）。

### 3.4 可重建性分级

| 级别 | 内容 | 处置 |
|------|------|------|
| 不可重建 | `tokens/*.json`（token 本身）、`profiles/*/`（会话历史、信任记录） | 删除需显式确认 |
| 可重建 | `profiles/*/config.toml` 的**受管区**、`catalogs/*.json`、`launch.*` | 可随时删，下次 exec 自动重建 |
| 可重建 | `pool.json`（§2.15）——只丢状态与用量缓存 | 删了下次 `pool check` 就回来；⚠️ 但 `lastPick` 一起没了，`-c` 需重新指定 token |
| 可重建 | `sessions/`（§2.16）——只丢在场记录与未读纸条 | 删了下次启动重新出现；`sessions prune` 遇未读要求 `--force` |
| **不可重建（Codex 的）** | `profiles/*/config.toml` 的**非受管区**（尤其 `[projects.*]` 信任记录） | **cxt 绝不碰**；丢了要用户重新信任一遍 |

### 3.5 写入纪律

- 所有 JSON 写入走 `writeJsonAtomic()`（临时文件 + `rename`），杜绝半截文件。
- **`config.toml` 的写入走 `writeTomlAtomic()`**（临时文件 + `rename`），
  且**必须先在内存里完成拼接再落盘**——绝不"边读边写同一个文件"。
- 目录创建统一走 `ensureDir()`（`mkdir -p` 语义）。
- 新写文件在 POSIX 下 `chmod 0600`（含 token 的文件）；Windows 依赖用户目录 ACL，README 说明差异。
- 路径**只能**从 `core/paths.js` 取，禁止在别处硬编码 `~/.codex-multi-token`。
- **并发读-改-写不加锁**（单用户 CLI，接受此风险）。`writeJsonAtomic()` / `writeTomlAtomic()`
  只保证**不产生半截文件**，**不保证不丢更新**——两个窗口同时 `cxt model next` 可能互相覆盖。
  真要并发安全再引入锁文件，**本期不做**，但别误以为原子写等于并发安全。
- **`version` 不匹配的处理**：读到**更高**版本的 `config.json` → 拒绝启动（退出码 2）并提示升级 cxt；
  读到**更低**版本 → 自动迁移，迁移前把原文件备份为 `config.json.v<旧版本>.bak`。
  绝不静默按当前 schema 解析未来格式。

---

## 四、代码结构

### 4.1 仓库布局

```
codex-multi-token/
├── AGENTS.md                    # 本文件（架构契约 + 仓库指令）
├── README.md / README.zh-CN.md  # 面向用户：英文为主 + 中文
├── package.json                 # bin: { cxt: "./bin/cxt.js" }, dependencies: {}
├── bin/cxt.js                   # 入口（shebang，只做转发）
├── src/
│   ├── cli/
│   │   ├── main.js              # 命令分发（读 process.*，但 ★ 只读 argv/isTTY 这几个标量）
│   │   ├── parse-args.js        # 自写参数解析（不用 commander）
│   │   ├── format.js            # 终端对齐（CJK 算 2 列）+ 脱敏 + makePainter（§5）
│   │   ├── help.js              # 用法文本
│   │   ├── types.js             # Ctx / Command 的 JSDoc 类型
│   │   ├── session.js           # ★ resolve / exec / run 共用的会话装配（含 §2.13 的发现）
│   │   ├── codex-bin.js         # codex 可执行文件定位（§2.12）
│   │   ├── pick.js              # `--pick` 的极简行式 TUI（§2.5）；`CXT_UI=plain` 也复用它
│   │   ├── probe.js             # ★ §2.15 额度探测：发一次最小真实请求（**会花钱**，只在 check / 启动前挑时跑）
│   │   ├── pool-pick.js         # ★ §2.15 启动前挑 token（I/O 层，形状照抄 preflight.js）
│   │   ├── ui/                  # ★ 全屏面板内核（§2.14）。前三个是纯函数，第四个不是
│   │   │   ├── keys.js          #   字节流 → 按键事件。逐字节可中断状态机，**不是对 chunk 跑正则**
│   │   │   ├── render.js        #   (state, {cols,rows}) → {frame, cursor}；含 frameWidth / fitLine / layout / scrollTop
│   │   │   ├── app.js           #   reducer：(state, key) → {state, effects}
│   │   │   └── term.js          #   ★★ `cli/ui/` 里唯一碰 process.stdin/stdout 的文件（§4.2）
│   │   │                        # ★★ 这四个文件与 `cmt` 的同名文件**逐字一致**（§8 开放问题 10）。
│   │   │                        #    改一个必须改另一个。验证手段就是 `diff`，它必须**空**。
│   │   │                        #    ⇒ 凡是"两个工具不一样"的东西，**一律不许出现在这四个文件里**：
│   │   │                        #      ① 工具名 / 项目配置文件名 → 从 `PanelData.appName` / `.projectFile` 进来
│   │   │                        #      ② 环境变量名 → 由**调用方**解析成值再传进 `runPanel(io)`；
│   │   │                        #         `term.js` 不认识 `CXT_UI_COLS` / `CXT_UI=plain` 这些**名字**
│   │   │                        #      ③ 契约的**父节号**（cxt §2.14 / cmt §2.12）→ 一律写成
│   │   │                        #         「面板 §五」这种**节名 + 子节号**；两份契约的子节号逐条相同，
│   │   │                        #         父节号不同（§7.17 / §7.8 同理，写「TUI-Win M6」）
│   │   └── commands/            # resolve / run / exec / bind / token / model / trust / ls / profile / doctor / ui / ui-web / usage / pool
│   │       └── pool.js          # ★ §2.15 token 池：list / import / check / status / reset / sync / pull
│   ├── core/                    # 领域层：纯逻辑，无 IO 副作用
│   │   ├── paths.js             # ★ 全部路径常量（唯一来源）
│   │   ├── store.js             # 配置读写 + writeJsonAtomic / writeTomlAtomic（★ core 里唯一碰 fs 的）
│   │   ├── schema.js            # 数据结构定义与校验（含 token 名 / 路径穿越校验）
│   │   ├── project-config.js    # ★ §2.13 的受限 schema + 禁键表 + 向上发现
│   │   ├── bindings.js          # ★ 路径绑定：归一化 + 最长前缀匹配
│   │   ├── models.js            # ★ 优先级列表运算：轮转 / 提拔
│   │   ├── models-endpoint.js   # ★ §2.14 六：`/models` 的 URL 拼装与响应解析（纯）
│   │   ├── resolve.js           # ★ 四要素解析级联（§2.3）+ buildInjection（§2.6）
│   │   ├── validate.js          # 四要素完整性校验（§2.1）
│   │   ├── toml-splice.js       # ★★ 受管区拼接器（§2.9）——本项目最难的模块
│   │   ├── toml-value.js        # ★ TOML 值序列化（§2.11 三·1）
│   │   ├── catalog.js           # model_catalog_json 生成（§7.5）
│   │   ├── trust.js             # 项目信任记录读写（§2.10）——唯一被允许写非受管区的地方
│   │   ├── launch-script.js     # 兜底产物：生成 launch.cmd / launch.sh（§2.12）
│   │   ├── pool.js              # ★ §2.15 池的纯逻辑：状态词表 / isStale / classifyProbe / orderCandidates
│   │   ├── sheet.js             # ★ §2.15 批量导入：parseCsv + parseXlsx（零依赖，node:zlib）
│   │   └── errors.js            # 错误类型 + 退出码
│   │                            # ★ `pool.js` / `sheet.js` 与 `cmt` 的同名文件**逐字一致**（§2.15）；
│   │                            #   同理：只抛裸 `Error`，错误类型在各自的 CLI 层翻译
│   └── platform/                # 平台适配：唯一知道具体终端的地方
│       ├── index.js             # detectTerminal() / spawnTerminal() / findExecutable() / fetchModels() / serveWeb() / openBrowser()
│       ├── fetch-models.js      # ★ §2.14 六：`/models` 的网络代码（fetch + Bearer + 超时）
│       │                        #   ⚠️ 它不再是**唯一**的网络代码——另有 §2.15 的 `cli/probe.js`
│       ├── serve-web.js         # ★★ §2.14 十：**唯一 import `node:http` 的文件**。回环 + 路径口令 + 那 14 条控制
│       ├── open-browser.js      # ★ §2.14 十：开窗口（Chrome/Edge `--app=` 优先，退回默认浏览器）
│       ├── open-path.js         # ★ §2.14 十：在文件管理器里打开目录（三平台都 `[目录]` 一个参数，不过 shell）
│       ├── redis.js             # ★ §2.15 手写 RESP2 客户端（tcp/tls/unix）。**从不当主存储**
│       └── windows.js / macos.js / linux.js
│       # ★★ `serve-web.js` / `open-browser.js` / `open-path.js` / `redis.js` 与 `cmt` 的同名文件**逐字一致**。
│       #    §2.14 十 比 `ui/` 那三条**多一条**禁令：不 import 各家的错误类型（**一律抛裸 `Error`**）——
│       #    否则 `CxtError` / `CmtError` 的名字就进共享文件了。
│   ├── web/                     # ★ 网页控制台的前端资产（§2.14 十）。无框架、无构建、无内联 script/style
│   │   ├── index.html           #   表单骨架：原生 <select> / <input type=checkbox> / <button>
│   │   ├── app.js               #   render(view) + post(op)；无状态、无 diff、无路由；只用 textContent
│   │   └── style.css
│   │                            # ★★ 这三件与 `cmt` 的同名文件**逐字一致**——同 `ui/` 那四条的规矩与理由：
│   │                            #    **工具名 / 环境变量名 / 契约父节号**，一条都不许进来
│   │                            #    （工具名从视图模型拿，§2.14 十；节号只写节名，理由见那节的 ⚠️）。
├── tests/                       # node --test（core 单测 + cli 端到端冒烟 + ui/ 纯函数单测
│                                #   + serve-web 安全 + 共享文件逐字一致 + 网页控制台）
├── scripts/
│   ├── verify-real-codex.mjs    # ★ 真机验收：产物能不能被**真实 Codex** 接受（§6.3 手工验第②件）
│   └── verify-ui-real.mjs       # ★ 真机验收：面板的 Windows 事实（§7.17 的 M1–M7）
└── docs/
    ├── design.md                # 详细设计（本文件是铁律索引，那份是展开）
    └── config-reference.md      # 配置字段逐项说明（含 §2.13 的 `.cxt.json`）
```

### 4.2 分层与依赖方向（单向，不许反向）

```
bin → cli → core ← platform
```

- `core/` **不 import `platform/`**、**不读 `process.env` / `process.platform` / `os.homedir()`**、**不 spawn**。
  这些一律由 cli 层以 `{ platform, home, env }` 注入。纯函数化 → 可单测，
  且**三大平台的路径规则能在任意一台机器上测**（§6.3）。
  `resolve.js` 尤其必须纯：输入 `{config, tokens, cwd, argv, entry, platform, project}`，
  输出 `{值, 来源层}`。**`entry` 是 `'run' | 'exec'`**——它决定 `token.cwd` 生不生效
  （§2.3 第五条）。**必填参数，不给默认值**：给了默认值就等于给了一条"忘了传也能跑"的
  静默错路，而这条错路的表现是"续错会话"，最难排查。
  > ★ **`project` 是 §2.13 的项目本地配置**（`normalizeProjectConfig()` 的产物，没有就是 `undefined`）。
  > **加载动作不在 core 里**——`resolve.js` 收的是**已加载好的对象**，
  > 读文件是 `store.js` + `cli/session.js` 的事。保持纯，才能对级联做穷举单测。

  > ★ **`tokens` 是「名字 → 已加载 token 对象」的表，不是单个 token**（施工时定的）。
  > 因为 token **选择本身**就是级联的一环（`--token` → 绑定 → `defaults.token` → 无，§2.3），
  > 它必须留在 core 里才能被单测覆盖；若把选择放到 cli 层，`resolve.js` 就只能拿到
  > 一个"已经选好的 token"，那条级联反而落到测试之外了。
  > `tokens[name]` 为 `null`/缺失 = 该名字不存在 → **当场抛错**（不是记成缺项）。
  >
  > 同理 `platform` 是**必传**的：绑定匹配的路径规则（大小写 / 分隔符 / NFC）要按它算
  > （`core/bindings.js`），不传就退化成"按宿主平台猜"，跨平台单测立刻失效。
  > `cwd` 也由调用方给——**core 不读 `process.cwd()`**。
- **`core/bindings.js` 的 `normalizeForCompare(p, platform)` 必须把 `platform` 当参数**，
  不许读全局——否则 Windows 的路径规则在 Linux CI 上就没法测了。
- **`core/toml-splice.js` 必须纯**：输入 `{existingText, managedValues}`，输出 `{newText, report}`。
  **不碰 fs**——文件读写留在 `store.js`。这样拼接逻辑可以用字符串字面量做穷举单测（§6.3）。
- `cli/` 只做：解析参数 → 调 core → 调 platform → 渲染输出。
- `platform/` 不 import `cli/`，导出：`spawnTerminal()`（§2.11 二·1）、`findExecutable()`（§2.11 四）、
  **`fetchModels()`**（§2.14 六）、**`serveWeb()`** / **`openBrowser()`** / **`openPath()`**（§2.14 十）。
  网络与进程都是副作用，所以它们**必须**在这一层：`core/models-endpoint.js` 只做 URL 拼装与响应解析（纯、可单测），
  `fetch` 本身在这里。**`core/` 里不许出现 `fetch(`**——这条与"core 不 spawn"是同一条纪律。
  ★ **`platform/serve-web.js` 是全项目唯一 `import node:http` 的文件**——与
  「`cli/ui/term.js` 是 `cli/ui/` 里唯一碰那两个流的文件」是同一种写法，理由也相同：
  **能单测的规则，就不要让它依赖宿主**。它收 `{ops, assets, onLog, …}`，自己不读 `process.*`。
  唯一一处例外是 **SIGINT**（§2.14 十 第 13 条）——它**刻意**放在这里而不是 `cli/`：
  **装信号的人就得负责摘它**，而"谁来收尾"这件事只该有一处定义（`close()` 是幂等的，
  三条退出路都走它）。⚠️ 但这**不是**为了"让 `ui-web.js` 一个 `process.*` 都不碰"——
  它**照样写 `process.stdout` / `process.stderr`**（URL、提示、请求流水），
  和 `cli/commands/` 下其余十二个命令**一模一样**。那是对的：判据见下面那条，
  **这条纪律管的是终端状态，不是"有没有碰那两个流"**。
- **`cli/ui/term.js` 是 `cli/ui/` 里唯一碰 `process.stdin` / `process.stdout` 的文件。**
  这是"core 不读 `process.*`"那条纪律**降一级**的版本，理由相同：**能在任意机器上单测的规则，
  就不要让它依赖宿主**。于是 `keys.js` / `render.js` / `app.js` 是纯函数，
  测试里不需要 TTY、不需要真终端（§6.3）。`main.js` 仍读 `process.argv` 与 `isTTY` 这几个标量
  ——它们是**注入给** `ui/` 的输入，不是 `ui/` 自己去读的。
  ★ **`cli/commands/ui.js` 的 `runPlain()` 是这条纪律唯一的一处例外，且是刻意的**（§2.14 七）：
  它直接读 `process.stdin` 的行、直接写 `process.stdout`。判据不是"碰没碰那两个流"——
  每个命令都在往 stdout 写输出，那不是这条纪律管的事——而是**"碰了终端状态之后还能不能全身而退"**。
  `runPlain()` **绝不碰 raw mode、备用屏、光标显隐，一个 ANSI 字节都不发**，
  所以它在管道里、在 CI 里、在备用屏已经卡住的终端里都跑得起来，而那正是它存在的理由。
  **例外只此一处**：`cli/ui/` 之外再有人去动终端状态，就是违规。

### 4.3 零依赖铁律

`dependencies: {}`——只用 `node:` 内置模块。

- 参数解析自己写（约 120 行，够用）
- **TOML 不引库**：只写"受管区拼接器"（§2.9）与"值序列化"（§2.11 三·1），
  **不写通用 TOML 解析器**——那是无底洞，且我们根本不需要
- **TUI 不引库**（§2.14）：`node:` 的 `stdin.setRawMode()` + 自己发 ANSI 序列就够。
  需要的东西只有四样——备用屏、光标显隐、原始终端模式、按键解码——**加起来不到 500 行**。
  引一个 TUI 框架会把"零依赖"这条卖点当场作废，换来的只是我们并不需要的布局引擎。
- **HTTP 不引库**（§2.14 六）：Node 18+ 内置 `fetch` 与 `AbortSignal.timeout()` 够用。
  一个 `GET /models` 不需要 axios。
- **HTTP 服务端不引库**（§2.14 十）：`node:http` + `node:crypto` 够用。
  一个只绑回环、只服务一个表单的服务器不需要 express——它需要的那几样
  （路由、静态资产查表、body 上限）在这个规模上各是十几行。
- **前端不引框架、无构建**（§2.14 十）：手写 HTML/CSS/JS，控件全是**原生**的
  （`<select>` / `<input type=checkbox>` / `<button>`）。没有 bundler、没有前端
  `node_modules`、**没有构建步骤**——`src/web/` 里那三件就是发给浏览器的字节。
- 测试用内置 `node:test`
- 好处：`npx` 秒装、无供应链风险、无构建步骤、审计友好

**这是本项目对外的卖点之一，不是权宜之计。** 需要新能力时先问：内置模块能不能做？

### 4.4 实施顺序（每步独立可验证，按序做）

| # | 交付 | 验证方式 |
|---|------|---------|
| 1 | `package.json` + `bin/cxt.js` + `src/` 三层骨架 | `node bin/cxt.js --help` 有输出 |
| 2 | `core/paths.js` + `core/schema.js` + 测试 | `node --test` 绿 |
| 3 | `core/toml-value.js` + 测试 | ★ **两个函数分开测**（§2.11 三·1）：`toTomlValue`（值 → 正斜杠）与 `toTomlPathKey`（表键 → **保留反斜杠 + 字面字符串**）。断言含：字符串转义 / 内联表 / 数组 / 布尔 / 路径含单引号时的退化 |
| 4 | **`core/toml-splice.js` + 测试** | ★ 受管区插入位置 / 多行值 / `[projects.'D:\a b']`（**反斜杠字面字符串**）/ 重复键报错 / 其余字节保留 / **输出无 BOM + LF**（§7.14 ①） |
| 5 | `core/bindings.js` + 测试 | 最长前缀 / NFC / 大小写 / 分隔符归一 边界全绿（三平台规则均可在本机测） |
| 6 | `core/models.js` + 测试 | 轮转回原点、提拔保序、不在列表则插首位 |
| 7 | `core/resolve.js` + `core/validate.js` + 测试 | 级联各项覆盖顺序 + 来源层标注 + **`entry` 参数的 cwd 分叉**（§2.3 第五条） |
| 8 | `cli/commands/resolve.js` → `cxt resolve` | ★ **不需终端探测即可验证整条解析链** |
| 9 | `core/catalog.js` + `core/trust.js` + 测试 | catalog 生成 / 信任表读写（含"不删条目"不变量）+ ★ **信任键必须反斜杠、精确匹配、不继承父目录**（§7.3 规则表，**用真机跑一遍往返验证**：写 → `codex doctor` 读回 → 确认项目级生效） |
| 10 | `core/launch-script.js` + 测试 | 脚本内容断言（§2.12 四条契约）+ ★ **纯 ASCII**（§7.14 ③：非 ASCII 会被 PowerShell 5.1 的 ANSI 解码破坏） |
| 11 | `platform/*` + `cxt exec` + `cxt run` | 本机 Windows Terminal 实测弹窗；★ **spawn 前必须 `mkdir` 目标 CODEX_HOME**（§7.1：Codex 不自动建目录）；~~非 git 目录自动补 `--skip-git-repo-check`~~ **← 已订正为错误，见 §7.6：那个 flag 是 `codex exec` 子命令专属，顶层不认，补了会导致完全启动不了**；**macOS/Linux 分支此处只能静态审查**，标 `// UNVERIFIED` |
| 12 | `cxt doctor` / `ls` / `bind` / `model` / `token` / `trust` 全套 | 手工走一遍 §5 全部命令；★ doctor 需检测 **BOM / 受管区漂移 / 项目信任三态 / AGENTS.md 截断**（§5 检查项） |
| 13 | README（含 §7.3 的坑 + 信任矩阵说明 + 卸载说明） | `npm ls` 为空（零依赖审计） |

**顺序是刻意的：第 4 步（拼接器）在第 11 步（平台层）之前，且第 8 步在第 11 步之前**——
拼接器与解析链都能纯单测，先把它们跑通并**可验证**，再碰终端探测
（无法单测，是风险最高的一步，要留到最后且有 `--print` 兜底）。

#### 施工进度

每一步的完成状态、跑过的测试条数、以及当场撞出来的 bug 与教训（2026-10-17 记），
已移到 [`docs/progress-log.md`](docs/progress-log.md)——**历史记录，不是契约**。
完成新的一步时往那里追加，不往这里堆。


### 4.5 v1 完成定义

- §5 命令面**全部可用**（`cxt exec` 是启动路径、不是用户日常命令，但它**必须可用**——
  `cxt run` 的整个流程靠它落地，见 §4.4 第 11 步）
- §4.4 第 1–13 步全部完成
- **本机实测走通**：`cxt bind D:/x --token a` → `cxt resolve` 四要素齐全且来源层正确
  → `cxt run` 弹出新窗口且落在 `D:/x` → 窗口内 `/status` 显示的正是该 token 的模型
  → `cxt trust D:\y --token a` 写出一条信任记录
  → 在 `D:\y` 里跑 `codex doctor` **确认项目级配置真的生效**（看 `model` / `approval policy`
  是否变成项目级的值，§7.3 的判据）→ 再 `cxt run` **该条目仍在**（受管区没吃掉它）
  ⚠️ **这一条是信任链的端到端验收，必须用反斜杠路径 + doctor 读回**——
  只断言"文件里有这一行"是不够的（正斜杠写法同样"文件里有这一行"但**不生效**）。
- **cwd 分叉实测**（§2.3 第五条）：在 `D:/other` 里跑 `cxt exec a`（而 `a.cwd = D:/x`），
  确认 codex 落在 `D:/other` **而不是** `D:/x`；再跑 `cxt run a`，确认新窗口落在 `D:/x`
- `cxt model next` + `cxt run -c` 能续上原会话（§2.5 工作流）
- **网页控制台可用**（§2.14 十）：裸 `cxt` 在 TTY 下开出窗口、四个步骤点得通、
  勾选框下方那区能调序且**真的改变了优先级**；第 1 步的「打开」真的弹出文件管理器；
  `--no-open` 只打印 URL。
  ★ 且**非 TTY 裸 `cxt` 仍打印用法、退出 0**——不许变成"起一个永远不退的服务器"。
  ★ 14 条安全控制**逐条删掉看测试变红**（§6.3），不是"写了就算"。
- `node --test` 全绿；`dependencies: {}`
- README 写完 §7.3 的坑 + 信任矩阵代价 + 卸载清理
  （删 `~/.codex-multi-token/` 即可，**不影响 `~/.codex/`**）

#### 本机实测进度（2026-10-17）

`scripts/verify-run-real.mjs` 已把**弹窗那条链**验到"读新窗口写回的文件"这一级
（4/4 通过）：窗口真的弹出 → 落在 `token.cwd`（用的是**带空格**的路径，
顺带把引号那关一起过了）→ `CODEX_HOME` 落在该 token 的 profile →
凭证注入到了新窗口的进程里 → `-C` 到了 codex 手里。
手段是 `defaults.codexBin` 指向一个**假 codex**（`.cmd`，于是 cmd shim 那条路也真跑了），
它把 `{argv, cwd, codexHome, tokenVar}` 写成 JSON 再退出。**真的 codex 全程没被调用。**

| §4.5 的实测项 | 状态 |
|---|---|
| `cxt run` 弹出新窗口且落在 `D:/x` | ✅ 已验（用的是 `token.cwd`，含空格） |
| 窗口内 `/status` 显示的正是该 token 的模型 | ⏳ **要人**：得用真凭证起真 codex。链的**前半段**已验（`CODEX_HOME` + 受管区 + 凭证都到位，见 `verify-real-codex.mjs`） |
| cwd 分叉（exec 落在 `D:/other`、run 落在 `D:/x`） | ✅ exec 侧在 `tests/exec-e2e.test.js`（断言 `-C` 不传 / 传对值）；run 侧同上 |
| `cxt model next` + `cxt run -c` 续上原会话 | ⏳ 待 `model` 命令落地（第 12–13 步）；`-c` → `resume --last` 已在 exec 侧验过 |
| `cxt trust` 写入 + `codex doctor` 读回生效 | ⏳ 待 `trust` 命令落地 |

⚠️ **`cxt run` 的退出码 0 不代表窗口里跑起来了**——`wt.exe` 是交接桩（§7.14 ⑦），
它把请求转给常驻进程就退了。所以上面这些项**必须**读新窗口写回的文件才算数，
"看见窗口弹出来了"不是证据。

---

## 五、命令面

```bash
cxt                                 # ★ TTY → 开网页控制台（§2.14 十）；非 TTY → 打印用法、退出 0
cxt ui                              # ★ 显式进全屏 TUI。非 TTY → 报错退出 1
                                    #   CXT_UI=plain → 逐行输出，不进备用屏（§2.14 七）
cxt ui --web [--no-open]            # ★ 开网页控制台。**非 TTY 也开**（它不需要终端）
                                    #   只绑 127.0.0.1 + 随机端口 + 路径口令（§2.14 十）
                                    #   --no-open：只打印 URL，不开浏览器（口令不进 argv）
                                    #   CXT_UI=web 等价
cxt run [<token>] [--cwd <path>] [--model <id>] [--url <u>] [--token-value <v>]
        [--pick] [--pool] [-c] [--window|--tab] [--print] [-- <codex 参数...>]
        # --pick：交互式从当前生效的 models 里挑一个，仅本次生效、不落盘（§2.5）
        # --pool：启动前从 token 池里挑一个，覆盖任何一层的绑定（§2.15）
        # ★ 全局 flag --config <path>：显式指定项目本地配置，跳过向上发现（§2.13 一）
cxt resolve [<path>]                # ★ 打印该路径解析出的四要素 + 每项来源层（token 打码）
                                    #   含「项目本地」层，以及它是从哪个 .cxt.json 读的
cxt exec [<token>] [--cwd <path>] [--model <id>] [-c]
                                    # 同步受管区 + 注入环境后启动 codex（stdio inherit）
                                    # ★ cwd：只用 --cwd 或进程 pwd，**跳过 token.cwd**（§2.3 第五条）
                                    #   省略 <token> = 纯 defaults 模式（profile 落 _default）
cxt ls                              # token 列表 + 各自 cwd / 模型来源（own / global）
cxt bind <path> [--token <t>] [--url <u>] [--model <id>]
cxt bind ls                         # 列出全部路径绑定
cxt bind rm <path>
cxt token add <name> --token <t> [--base-url <u>] [--cwd <path>] [--provider-id <id>] [--label <昵称>]
cxt token rm <name> [--purge] [--yes]
cxt token show <name>               # token 打码显示：sk-****abcd；有昵称时多一行「昵称」
cxt token edit <name> [--token <v>] [--base-url <u>] [--cwd <p>] [--provider-id <id>] [--label <昵称>]
                                    # ★ 改凭证/端点但不动 profile 目录
                                    #   → 会话历史保留，codex resume --last 依然有效（§2.5）
                                    # ★ --label "" = 清除昵称（删键，不是写空串）
cxt model ls [<path>|<token>]       # 看生效的优先级列表（标注来自哪一层）
cxt model set [--global|--token <t>|--path <p>] <id[:label]...>   # 顺序即优先级，第一个最高
cxt model use <id> [--global|--token <t>|--path <p>]   # ★ 提拔到首位（模型故障切换）
cxt model next [--global|--token <t>|--path <p>]       # ★ 轮转一位（模型故障切换）
cxt model clear [--token <t>|--path <p>]               # 删掉该层 list → 回退上一层
cxt trust <path> [--token <t>]      # ★ Codex 专有：写 [projects.'<path>'] trust_level = "trusted"
                                    #   ⚠️ 路径**保留 Windows 反斜杠**、用 TOML 字面字符串（§7.3 规则表）
                                    #   正斜杠写法**静默不生效**——这是本工具最容易写错的一处
cxt trust <path> --untrust          #   写 "untrusted"（不删条目）
cxt trust --all [--token <t>]       #   把该 token 的全部绑定路径一次标记为可信
cxt trust ls [--token <t>]          #   列出各 profile 的信任表（只读）；标注三态：
                                    #   trusted / untrusted / 未标记（后两者语义不同，§7.3）
cxt profile path <token>            # 打印 profile 目录（排查用）
cxt usage [--days <n>|all] [--by token|project|model|day] [--json] [--refresh]
                                    # ★ 用量与花费（§2.14 十一 价格小节）：按 codex 自己写的
                                    #   rollout 统计 token 用量，按价格表折算美元。只读不联网
                                    #   价格三级：手写 prices.json > 端点自报价（resources.json）
                                    #   > 无价 →「—」，绝不冒充 $0；--json 带 pricesFile /
                                    #   endpointPrices 说清价格从哪来
cxt pool list                       # 所有 token + 池状态 + 用量；有 token 无条目标「未入池」（§2.15）
cxt pool import <file.csv|xlsx>     # 批量建 token + 建条目；已存在的名字跳过不覆盖
cxt pool check [<name>...] [--all] [--force]
                                    # 额度探测（发一次最小真实请求，**会花钱**）
                                    # 三档：点名 = 只探这些（顺带入池）/ --all = 全部 token /
                                    #   裸的 = 池内条目；--force 无视 TTL
cxt pool status <name> <status>     # 手动覆盖：ok|no_quota|invalid|net_fail|other|unknown
cxt pool reset <name>               # 清状态回 unknown
cxt pool sync [--redis <url>]       # 从 rollout 重算用量；带 --redis 时写穿到 Redis
cxt pool pull --redis <url>         # 反向：把 Redis 里的状态拉回本地
                                    # ★ --redis 也认 env:VAR；平时**完全不连 Redis**（§2.15 五）
cxt sessions [--json]               # ★ 在场层（§2.16）：窗口会话三态（live / ended / dead）+ 未读数
cxt sessions prune [--older-than 30d] [--force]
                                    # 删超龄的 ended/dead 记录；有未读时拒绝（--force 才放行）
cxt resume <id前缀>                 # 恢复 ended/dead 会话：同 token、同 cwd、带 -c 开新窗口
cxt msg send <id前缀|--token <t>|--all> [--type info|action-request] <文本...>
                                    # 给 live 会话留一张纸条——惰性数据，工具永不自动读它（§2.16 三）
cxt msg inbox [--session <id>] [--peek] [--json]
                                    # 看信箱；默认读完即标记已读（--peek 只看不动）
cxt msg gc [--older-than 7d]        # 清理超龄消息（inbox 与 read 都算）
cxt doctor                          # 自检：node / codex / 终端探测 / 四要素完整性 /
                                    #   受管区漂移 / 受管区带 BOM（§7.14①）/ 未信任项目 /
                                    #   绑定悬空引用 /
                                    #   ★ AGENTS.md 是否超 project_doc_max_bytes（会被静默截断，§7.11）
```

> ⚠️ **`cxt doctor` 的"文档截断"检查项**：读 `$CODEX_HOME/config.toml` 的 `project_doc_max_bytes`
> （缺省按 32768 算），与仓库 `AGENTS.md` 的**字节数**比较；超了就报
> 「AGENTS.md <实际字节> B > project_doc_max_bytes <上限> B，Codex 将静默截断到第 N 字节」。
> 这是**本仓库自己的踩坑**（§7.11），也是所有用户的共同盲区——截断不报错，只伪装成"文档就这么短"。
> ⚠️ **代码里不许出现任何具体字节常量**（§7.11）——只做"读到的文件大小 vs 读到的配置上限"这个比较。

- `cxt run` **不带 token 名**时按当前目录匹配绑定（§2.3），这就是"不同路径不同 token"的入口。
- ★ **项目本地配置（§2.13）参与解析**：从 cwd 向上找到**最近的一个** `.cxt.json`，
  它排在「路径绑定」之上、命令行之下。`--config <path>` 显式指定并**跳过发现**。
  ⇒ 同一个目录，`.cxt.json` 一放进去 `cxt run` 的行为就变了——这是本特性的全部意义，
  也是 `cxt resolve` **必须把 `project` 这一层印出来**的原因（否则就成了"静默换身份"）。
- **`run` 与 `exec` 的分工**（别把两者当同一件事的两个名字）：

  | | `cxt run` | `cxt exec` |
  |---|---|---|
  | 在哪跑 | **弹一个新终端窗口**（`platform.spawnTerminal`，§2.11） | **当前终端**（`spawn stdio:inherit`） |
  | cwd | `--cwd` → `token.cwd` → 当前目录，**经 `-C` 传给 codex** | `--cwd` → 进程 pwd，**跳过 `token.cwd`**（§2.3 第五条） |
  | 用户日常会敲吗 | ✅ 主要入口 | ⚠️ 通常由 launch 脚本 / `run` 调起；也可手敲（就是"在这个终端里用某个 token 开 codex"） |

- `cxt run -c` 转发 `resume --last` 给 codex——**模型故障切换的第二步**（§2.5 工作流）。
  ⚠️ **别把 `-c` 写成 `-p`**：Codex 的 `-p` 是 `--profile`（选配置 profile），**不是**"continue"。
  这是与 Claude Code 最容易混的一处。
  ⚠️ 且 `resume --last` 按 **cwd 作用域**（§2.5、§7.6）——所以 `run` 的 cwd 必须真的落到
  `token.cwd`，否则续的是别的目录的会话。
- `--print` 打印**将要执行的完整环境与命令**，不实际启动——排查首选。
  必须打印出：`CODEX_HOME`、注入的环境变量（打码）、完整的 `-c` 参数、以及**受管区的预期内容与
  当前文件的 diff**。
- `cxt resolve` 是排查神器：一眼看出"为什么这个目录用了这个 token"，因为**每项都标了来源层**。
- **输出格式**：人类可读表格为默认；`ls` / `resolve` / `model ls` / `bind ls` / `trust ls` / `doctor`
  必须支持 `--json`（供脚本消费，也是 e2e 冒烟测试的断言载体）。
- **脱敏规则**（`--print` / `cxt resolve` / `cxt token show` 共用）：键名匹配
  `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` 的值一律打码为「前 3 后 4」。
  **不要只硬编码打码 `CXT_TOKEN_*`**——`env` 逃生舱里可能塞了别的密钥。

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
| 2 | 环境错误（codex 不在 PATH、终端探测失败、目录不可写） |
| 3 | **文件完整性错误**（`config.toml` 受管键重复 / 拼接失败 / 版本不兼容）——**绝不静默继续** |

报错必须**给出下一步命令**。例："路径 `D:/work/x` 解析不到 token（无绑定、无全局默认）。
可用：`cxt bind D:/work/x --token relay-a`"。

### 6.3 测试

- `npm test`（= `node --test`，由 Node 自己发现 `**/*.test.js`）
  ⚠️ **别写 `node --test tests/`**：Node 24 下它把目录当模块解析，报 `MODULE_NOT_FOUND`。
- `core/` 必须有测试（纯函数，好测），重点如下：
  - **`toml-splice.js`（最高优先）**：受管区插入必须在第一个 section 之前、多行数组值消费、
    内联表值、`[projects.'D:\a b']` 带引号 section 名（**反斜杠 + 字面字符串**，§2.11 三·1）、
    `[[array.of.tables]]` 不误判、
    注释与空行逐字节保留、末尾无换行、受管键出现两次 → 报错、**输出无 BOM + LF**（§7.14①）
  - `toml-value.js`：**两个函数分别测**（§2.11 三·1）——
    `toTomlValue`：字符串转义、内联表、数组、布尔、数字、**Windows 路径转正斜杠**；
    `toTomlPathKey`：**保留反斜杠、输出字面字符串、路径含 `'` 时退化为转义基本字符串**
    （★ 这一条要有"正斜杠写法不得通过"的反向断言，防止有人"统一"两个函数）
  - `bindings.js`：最长前缀匹配、**NFC 归一（macOS NFD 陷阱）**、Windows/macOS 大小写不敏感、
    Linux 大小写敏感、分隔符归一、边界（相同前缀、`D:/` vs `D:/work`）
  - `resolve.js`：级联各项各自的覆盖顺序、来源层标注正确、
    **`entry: 'run' | 'exec'` 的 cwd 分叉**（§2.3 第五条——同一个 token，
    传 `'run'` 得到 `token.cwd`、传 `'exec'` 得到进程 pwd，两条断言钉死，防止将来"顺手统一"改回去）；
    **以及 §2.6 的净化**——`stripSessionMarkers` 剔干净 `SESSION_MARKER_ENV` 里每一个，
    而 `PATH` / `HOME` / `CODEX_HOME` / `CODEX_MANAGED_BY_NPM` 一个不动；
    `CXT_TOKEN_*` 整族清掉（含当前这一个——**注入会把它盖回来**）；
    **不改入参**（入参就是 `process.env` 本身）；
    `env: { FOO: "" }` → `unset` 含 `FOO`；
    以及**头号不变量**：同一个 `resolved`，`base` 取"干净环境"与"从 codex 会话里继承的环境"
    两种，`buildSessionEnv()` 的结果必须 `deepEqual`
  - `resolve-terminal.js` / `windows.js`：Windows argv 的形状是**契约**（§2.11 二·1）——
    tab 模式必须含 `-w cxt`、**不含** `-w last`；window 模式含 `-w new`；
    两种模式都含 `new-tab`，且 `--suppressApplicationTitle` **排在 `new-tab` 之后**、
    **排在 `--title` 之后**；`TerminalSpec.windowName` 只在 tab 模式填。
    ★ 这几条都是**真机踩出来的**（§7.16 两个 ★），不是风格偏好——别让它们退回去
  - `models.js`：轮转不丢项（反复 next 能回到原点）、`use` 提拔后其余相对顺序不变、
    目标 id 不在列表时插到首位
  - `schema.js`：token 名校验（含路径穿越 `..` / `/` / `\` / 盘符）
  - `trust.js`：写入不删其它 `[projects.*]` 条目、`--untrust` 不删条目只改值
  - `launch-script.js`：§2.12 四条契约 + **换行符**（`.sh` 必须 LF，`.cmd` 必须 CRLF）
  - **`doctor.js` 的文档截断检查**（§5）：字节数比较用**字节**不用字符（中文一字三字节，
    用 `.length` 会算出 1/3 的假安全值——这正是本文件超限却"看起来不长"的原因）；
    `project_doc_max_bytes` 缺失时按 32768 兜底；报出"截断到第 N 字节"而非只报超限
  - **`--pick` 的边界**（§2.5）：`models` 为空 → 报错码 1（**不退化成手敲 id**）；
    与 `--model` 同用 → 报错码 1；**非 TTY → 报错码 1**（**绝不静默取 `models[0]`**）；
    选中后**断言没有写任何文件**（不落盘是它的契约）
  - **`project-config.js`（§2.13）**：发现是"**最近的胜出**"（`a/b/.cxt.json` 赢过 `a/.cxt.json`，
    且发现**从 cwd 起、含 cwd**）；`--config` 跳过发现；`version` 必填。
    ★ **每个禁键一条测试**（`authToken` / `baseUrl` / `env.CODEX_HOME` / `cwd` /
    `codexBin` / `terminalMode`），且**断言报错信息点它的名**——
    只断言"抛错了"是不够的，用户得知道是**哪个键**、**为什么不行**
  - **`resolve.js` 的项目本地层**：★★ **项目本地赢过 binding**（这条错了，整个特性就是假的）；
    ★ **反向断言**：项目本地**盖不掉** `baseUrl` / `authToken` / `cwd`
    （§2.13 二的安全边界——将来有人"顺手补齐"就会踩到那条外泄通道）；
    `env` 是**按键合并**且项目本地最后盖；`SOURCE.PROJECT` 的标注正确
  - **`models-endpoint.js`**：三种响应形态（`{data:[{id}]}` / `{data:["id"]}` / 裸数组）、
    OpenAI 错误体给可读信息、`baseUrl` 带不带尾斜杠都得到同一个 URL
    （★ 还有一条：`https://x.com/` 不能被 `replace(/\/+$/,'')` 写成
    `https:/x.com/models`——**请求直接打错主机**，是这条正则的经典错法）；
    ★ **"空列表"与"一项都认不出"分开**；只认 `id` 不猜 `name`
  - **`fetch-models.js`**：`fetchImpl` 注入假 fetch，**不发真请求**。四条——
    ① ★ 请求带对了 `Bearer` / `Accept` / `signal`（`signal` 是 `AbortSignal`）；
    ② ★★ 四种失败各一条（非 2xx / 200+错误体 / 网络抛错 / 超时），**且都返回
    `{ok:false}` 而不是抛**；③ ★★ **密钥不许外泄**——网络层错误消息里带上
    `Authorization`、或响应体回显了密钥，**两个方向的泄漏各一条测试**；
    ④ ★ 短密钥不抹（否则错误信息变噪音）
  - **`ui/keys.js`（§2.14 三）**：每个键一条；
    ★★ **分裂输入逐行喂**（`'\u001b['` + `'A'`、`'\u001b[1;5'` + `'A'`、`'[201'` + `'~'`）——
    **这是解码器写成状态机（而不是对 chunk 跑正则）的唯一理由**，
    不测它就退化成"方向键偶尔失灵"这种只在慢速/粘贴/多路复用下复现的幽灵 bug；
    裸 Esc 与 `flush: true`；`paste` 模式期间 `\x03` / `\r` **都不产生按键语义**
  - **`ui/render.js`（§2.14 五）**：六条，**穷举型而不是"跑个例子看看"**——
    ① ★ 尺寸不变量：扫 `[40,8] [45,9] [71,24] [72,24] [120,40] [200,60]`，
    行数恒等于 `rows`、每行 `frameWidth ≤ cols`（**必须扫尺寸，退化分支才是 bug 的藏身处**）；
    ② ★ 光标必落在窗口内（`len × h × cursor` 三重循环——把滚动做成纯函数的全部意义就在这里）；
    ③ ★ CJK 标签不把右栏挤出去、且不切半个宽字符；
    ④ ★ 退化分级边界（39/40、71/72）与行号守恒式 **`2 + bodyH + ftr === rows`**，
    且 **`ftr === footerLines.length`**（71 列下页脚只占 1 行 ⇒ 正文多一行 ⇒ 帧仍是 `rows` 行）；
    ⑤ ★ **页脚宽度与 `TWO_PANE_MIN_COLS` 的耦合**（改了提示串没改常量 → 立刻红），
    并断言两栏档的页脚**没被截断**、**任何列宽下 `q 退出` 都还在**；
    ⑥ `render` 不改入参、同输入同输出
  - **`ui/term.js`**：注入假 stdin/stdout（EventEmitter + 假 `isTTY`）跑全链路；
    ★ **`RESTORE` 的字节逐字断言，且断言它是纯 ASCII**（§7.17 不变量：它走 `writeSync`，
    非 ASCII 在 Windows 上必乱码）
  - **`ui/app.js`**：向导状态机每步的 Enter/Esc 去向；**勾选顺序 = 优先级**；
    主屏 `Enter` 只产生"启动"这一个 effect（**面板不自己 spawn**，那是 commands 层的事）
  - **e2e（`ui-e2e.test.js`）**：走 `CXT_UI=plain`——**这是 e2e 唯一能覆盖面板的路径**，
    真 TTY 进不了 CI（全屏那部分归 `term.test.js` 与 `verify-ui-real.mjs`）。
    沙箱靠 `USERPROFILE` 指到临时目录（`os.homedir()` 认它，已实测），
    所以**不碰用户真实的 `~/.codex-multi-token`**。十条，五条承重：
    ① ★★ 入口三条路——非 TTY `cxt ui` → **退出 1 且给得出路**；非 TTY 裸 `cxt` →
    打印用法且**退出码 0**（"脚本不受影响"是它的契约）；★ 而且 `CXT_UI=plain`
    **不许**把裸 `cxt` 变成会等输入的程序（那个变量只改画法，不改行为，§2.14 一）；
    ★★ 这一条现在钉的是**结构**而不是标签：那一组必须叫 `前端`，且用法里
    **必须有 `--web`**。⚠️ **`cli/help.js` 也是命令面，而且姊妹项目真的漏过它**——
    裸命令分支改了、§5 改了、四份 README 也改了，**只有 `help.js` 没改**，
    于是 `--help` 继续写着「裸 `cxt` 在终端里**就是它**」（指 TUI）。
    **那句话是假的**，而当时那个断言（只要出现「面板」二字）照样绿——
    它测的是"用法里有这组"，不是"这组说的是真的"。
    判据已验过：把 `--web` 那行从 `help.js` 删掉，这条**当场变红**。
    ⇒ **改命令面 = §5 + `help.js` + README，三处**；而"存在性断言"永远抓不住"这句话是假的"；
    ② ★★ 向导四步**两个落点都写了**（全局 `config.bindings` **且** 项目 `.cxt.json`）；
    ③ ★★ **「当前目录」那一行的身份来自级联**（断言图例里出现 `1) 当前目录 → <token>`）
    —— 这条钉的是一个真发生过的 bug：`probeFor()` 不返回解析出来的 token 名，
    于是身份来自项目本地配置时，`source` 明明印着「项目本地」，回车却说"没有绑定身份"；
    ④ ★★ **面板输出里不出现明文密钥**，且打码的那一份要在
    （否则这条可能是"什么都没显示"换来的）；
    ⑤ ★ `e` 写回**生效层**（项目本地）且全局 `config.json` **逐字节不变**；
    ★ `d` 删绑定后项目 `.cxt.json` **原样留着**（§3.2 惰性）；
    ★ 逐行输出里**没有裸 ANSI**（第一版漏过，`[1mcxt 面板[0m` 直接打进管道）
  - **`ui/app.js` 的 `panel` 事件族（§2.14 十）**：每个 op 的状态迁移各一条；
    ★★ **`move-model` 两端越界 = no-op**（首项上移 / 末项下移），**未知 op = no-op**；
    ★ **顺序真的改了**——断言 `checked` 的**数组顺序**变了，而不只是 `cursor` 动了。
    这条错了，控制台那个"调优先级"就是装饰品。
  - **`serve-web.js`（§2.14 十）——安全是承重的**：假 `ops` + 真 `http` + 全局 `fetch`，
    `_random` / `_now` / `_listen` 注入（否则测不了随机口令与空闲退出）。
    ★★ **那 14 条控制逐条删掉、看测试变红**——这是这一节唯一的验收方式；
    只写"有测试"而不做这一步，等于没测。
    另加：口令不符 → **404（不是 403）**、坏 `Host` → 403、`Origin: null` → 403、
    `OPTIONS` → 405、100 KiB body → 413、空闲 → 自动关、
    ★ **两个并发 POST 必须串行**（没有那条单槽链，共享 reducer 会被写坏）
  - **`open-browser.js`（§2.14 十）**：`spawn` 注入，断言三平台的**确切 argv**。
    ★ Windows 那条要断言 `cmd /c start "" <url>` 里**那个空 `""` 在**——它是**标题位**，
    少了就开不出来，而且**失败是静默的**。
    ★ 应用窗口优先那条：找到 Chrome/Edge → `--app=<url>`；找不到 → 退回默认浏览器。
  - **`open-path.js`（§2.14 十）**：`spawn` 注入，断言三平台的**确切 argv** 都**不过 shell**
    （`explorer.exe <目录>` / `open <目录>` / `xdg-open <目录>`）；**先 probe 再 spawn**
    （`missing` / `file` / `dir` 说三句不同的话）；**只等 `spawn` 事件、不等 `exit`**——
    Windows 上等退出码会把每一次成功都读成失败（§7.17 M10）；控制字符在 spawn 之前挡掉。
  - **`ui-web.js`（§2.14 十）**：★★ **「每个 effect 恰好 dispatch 一次」**——今天它只是
    隐式不变量（见 §一 那段复用面分析），这里钉住；`runEffect` 的关联 / 超时 / `failed`
    三条路径；视图模型**黄金形状**（断言键集，且 ★ **断言里面没有明文密钥**）。
  - **`shared-files.test.js`——本仓库头一次有东西守着"两个项目逐字一致"**（§4.1）：
    `ui/` 四件套 + `platform/{serve-web,open-browser,open-path}.js` + `web/` 三件
    + 守着它们的三个测试，共 **13 项**。
    加它之前纯靠契约那段话 + 人记得跑 `diff`——**一次编辑就能让它漂移而全套测试全绿**
    （已核实：两个测试套件里**没有任何一处**读对方的文件）。
    - **总是**断言每个路径存在且非空（防重命名把列表悄悄清空 ⇒ 守卫变空转），
      外加一条**清单长度下限**——删掉一项是**看不出任何异常**的，而"加"随便加
    - 姊妹项目在 ⇒ 逐文件比对，断言**空**；不在（单克隆）⇒ `t.skip`——**可见地跳过**
    - ★ 用 `Buffer.equals()` 比对，**不用 `===` 字符串**：BOM / 换行差异正是要抓的东西
      （`readFileSync(…, 'utf8')` 会把 BOM 变成 U+FEFF 一个普通字符、把 CRLF 折成 LF）
    - ★ **`pending` 标记，不是"先跳过"**：`web/` 那五件在姊妹项目落地之前标着
      `pending`，而它是**两个方向都查**的——标了 `pending` 而对方**已经有了** ⇒ 红
      （"该摘标记了"）；没标而对方**没有** ⇒ 红（"有人删了，或者从来就没拷过去"）。
      ⇒ 移植那一步是**被推着走**的，标记不会烂在那儿
    - ★ **姊妹项目靠扫父目录找**（认 `package.json` 的 `name` 后缀 `-multi-token`），
      **不写死目录名**——写死就意味着两份拷贝不一样，而两份拷贝一旦能不一样，
      它们就会不一样，那时两个项目守的是**两份不同的清单**，比没有测试更坏
    - ✗ 否决：在两处钉 sha256 常量——它只保证"这个文件变了"，**不保证两个项目一致**
      （两个不同的哈希都能过）。✗ 否决：从契约里读哈希——§7.11 明令禁止把会变的数字放进断言。
    - ★ **验收方式是变异**：往 `style.css` 塞一个裸 ESC ⇒ 卫生测试红；
      改 `ui/app.js` 一个字节 ⇒ 本条红（报出两边的字节数）；在姊妹项目里凭空造一份 ⇒
      红（"`pending` 该摘了"）；父目录里没有姊妹项目 ⇒ **`skipped 1`**，不是静默通过。
- **平台规则单机全平台可测**：因为 `core/` 的 `platform` 是**注入**的，
  `bindings.js` 与 `findExecutable()` 的三套规则**在任意一台机器上都能跑**——
  测试里传不同的 `platform` 值即可（Linux CI 上也能验 Windows 盘符规则）。
- **源码卫生有两条机器守着的规则**（`source-hygiene.test.js`）：**裸控制字符**与 **BOM** 不许进源码。
  这不是洁癖——裸 `ESC` 写在模板串或正则里是**合法 JS**，运行时的值与 `\u001b` **一字不差**，
  所以**任何行为测试都抓不到它**；抓不到又看不见：编辑器不显示、`git diff` 里两行**看起来一模一样**、
  review 的人只能选择相信，而复制粘贴或编辑器"清理不可见字符"会让它**静默消失**，
  症状却在很远的地方（`macos.js` 那行 OSC 0 少一个 `ESC`，窗口标题就再也设不上，**而 diff 是空的**）。
  本仓库踩过五次之后加的。BOM 那条同理：`bin/` 的 shebang 被它顶掉，Unix 上 `Exec format error`，
  而 **Windows 上 Node 自己会吃掉 BOM**，所以这个错在开发机上永远复现不出来。
  ⚠️ 扫描面**从仓库根开始，且含 `.md`**——加这条规则时扫全仓，唯一的漏网之鱼就是
  `AGENTS.md`，其中两处**已经躺在那里好几天**，每一次 `git diff` 都没显示出来过。
  契约文件是本仓库读的人最多的文件，它上面挂一个看不见的字节比代码里挂一个更坏。
  ⚠️ **扩展名表原来只有 `/\.(js|mjs|cjs|md)$/`**——加 `src/web/` 时**必须**一起加 `html|css`，
  否则那三件新资产**根本不在 `FILES` 里**，四条规则（裸控制字符 / BOM / 真密钥 / 内网地址）
  会**全部静默跳过**：文件在仓库里，却一条规则都不受。★ 已加，并且「扫描面覆盖到了」
  那条断言**同步加了** `assert.ok(FILES.includes('src/web/index.html'))` 与 `…style.css`——
  没有它，将来谁把扩展名删回去，四条规则会**再次静默变回空转**，而这次没有人会发现。
  ★ 为什么 `.html` / `.css` 比 `.js` 更该扫：那三件**随包发布**、还要**逐字复制**给姊妹项目，
  而它们没有语法检查、没有类型、改了不报错。一个看不见的控制字符在这里**比在 `.js` 里更坏**
  ——`diff` 显示不出来 ⇒ "逐字一致"当场破掉，而 `shared-files` 只会报一句"内容不同"，
  指不出是哪个字节。
  ⚠️ 值本身由行为测试钉着（`resolve-terminal.test.js` 那条 OSC 0 的断言），
  **两条各管一半**：卫生规则管"怎么写的"，行为断言管"写出来是什么"。
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
- **`toml-splice.js` 的测试用字符串字面量做输入输出**（因为它是纯函数、不碰 fs），
  这样每个边界都是一行 fixture，跑得飞快。
- **CI 矩阵**：GitHub Actions `windows-latest` / `macos-latest` / `ubuntu-latest` 跑 `node --test`。
  矩阵验的是真实 FS 行为（大小写、NFC、权限）与 Node 版本差异，**不是**路径规则本身。
- **真正只能手工验的只剩四件事**：① 终端拉起；② **与真实 Codex 的交互**
  （受管区写进去后 Codex 是否照单接受、`[projects.*]` 是否被保留）；
  ③ **全屏 TUI 的真机行为**（§7.17 —— 那节的条目**全部**是 🔵，只有真机跑得出来）；
  ④ **网页控制台的真机行为**（§7.17 的 M8–M9）——`--app=` 那个窗口真开得出来吗
  （这台机器装没装 Chrome/Edge、认不认那个 flag）；**Windows 防火墙弹不弹**
  （绑 `127.0.0.1` **应该**不弹，只有 `0.0.0.0` 才弹——但**本机未验证，别假设**）。
  ★ 控制台能自动化的部分**比 TUI 多得多**（HTTP 层可以用真请求测到底），
  但"窗口开出来了、鼠标点得动"这一层仍然要人。
  ⇒ 🟡 **第 ③ 件只自动化了一半，别把另一半说成自动化了**：
  `node scripts/verify-ui-real.mjs` 跑 §7.17 的 M1–M7，**能自动的那一半已经自动**
  （字节级对比、`'exit'` 写路径、CPR 应答、尺寸与还原序列），证据落盘到
  `ui-real-report.json`，不靠"看见面板弹出来了"下结论（与 `verify-real-codex.mjs` 同一手法）。
  ⚠️ **另一半自动不了**：M5（按方向键）、M6（拖窗口）、M7（强杀）、
  M1 的后半（**控制台上那一眼**）都要**人**。所以脚本分两档——
  不带参数跑自动的（`M1/M2` 落成 `MANUAL`，交互项 `SKIP`）；
  在**真终端**里加 `--all` 跑交互的，此时脚本**问**人、把答案记进同一份报告：**它不猜。**
  **跑完把结果回填 §7.17 每条的置信度标记。**
  ⚠️ 一条通用教训：**"我加了个验收脚本"不等于"验过了"**。第一版 M2 的断言
  匹配的是载荷**开头**，于是不管丢没丢都通过——**一条永远绿的守卫比没有守卫更坏**。
  写探针时先问一句"这个断言在**失败**的时候会长什么样"。
  第 ② 件是 Codex 专有的风险敞口——**每次 Codex 升级都要手工回归一次**，
  因为 §7 的事实全部来自文档与第三方实测，**没有一条是在本机二进制上验过的**（见 §7 开头）。
  ⇒ 🟢 **第 ② 件已自动化**：`node scripts/verify-real-codex.mjs`（**26 项断言**，
  在临时 CODEX_HOME 里跑，不碰用户真实 `~/.codex/`）。它验的是**契约自己**——
  其中几项是**故意反向**的断言（如 BOM 那条、信任门的正斜杠那条），Codex 若收紧就会变红，
  提醒回来改 §7。**升级 Codex 后先跑它。**
  六节的分工：① 拼接器产物被真解析器接受 ② 注入链（config→provider→env_key→环境变量）
  ③ catalog 真被采纳（含 `~` 展开的事实判定 + 阴性对照）④ `model_provider` 成对约束
  ⑤ BOM ⑥ **§7.3 信任门规则表逐行**。
  ⑥ 的判据是"**项目级配置到底生不生效**"，不是"文件里写对了吗"——
  项目写 `model = "project-model"` + `approval_policy = "never"`，用户级写 `model = "user-model"`，
  读 `codex doctor` 看谁赢。**只读 `model` 分不出 `untrusted` 与"从未标记"**，得看 `approval`。
  ⇒ 它**不进 CI、不进 `node --test`**：要装 codex、要几十秒，
  且它的失败含义是"契约过期了"，不是"代码写错了"——两者混在一起会让人分不清该改哪边。

### 6.4 提交

`feat|fix|docs|refactor|test: 中文简述`

---

## 七、已核实的技术事实（别再重复调研）

> **验证状态（2026-10-17 更新）：本节已经过真机回归。**
> 本机已安装 **Codex CLI 0.163.0**（`npm i -g @openai/codex`），并在
> `CODEX_HOME=C:\Users\alice\.codex-a` + 测试项目 `C:\Users\alice\codex-test-proj`
> 上跑完了 §8.9 事实回归。下列每条标注：
> **🟢 真机实测**（本机复现过，含原始输出）、**🟡 官方帮助文本**（`--help` 原文，等价可信）、
> **🔵 文档/脚本来源**（未真机复现，仍待验证）。
>
> 回归方法（可重跑）：装好后用 `codex doctor --json` 读 `checks.config.load.details`，
> 它直接给出生效的 `model` / `model provider` / `cwd` / `CODEX_HOME`；
> 用 `codex exec` 的启动 banner 读 `workdir / model / provider / approval`。
> **这两个是本项目最好的两个"生效性"仪器**，比读文档猜可靠得多。
>
> ⚠️ 回归中**推翻了三条原结论**（§7.2 次序存疑已定案、§7.4 profile 机制整体改写、
> §7.6 resume 作用域定案）。**看到与旧记录冲突时以本节为准。**

### 7.1 隔离与配置目录

- 🟢 **`CODEX_HOME` 存在且真的被读**，默认 `~/.codex`，可用它重定位整个用户级目录。
  直接证据：DeepSeek 官方脚本第 55 行
  `$CodexHomeDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }`；
  真机证据：设 `CODEX_HOME=.codex-a` 后 `codex doctor --json` 报
  `state.paths.CODEX_HOME = C:\Users\alice\.codex-a`、
  `config.load.details."config.toml" = <CODEX_HOME>\config.toml`、
  `"sqlite home"` / `"log dir"` 全部落在该目录下。
  它承载 config、凭证（`auth.json`）、`history.jsonl`、`sessions/`、SQLite 状态库。
  **这是本项目唯一的隔离原语**，对应 `cmt` 的 `CLAUDE_CONFIG_DIR`。
- 🟢 ★ **Codex 不会自动创建自定义 `CODEX_HOME` 目录**——路径必须**预先存在**。
  否则报 `CODEX_HOME points to "...", but that path does not exist` 并回落/失败。
  ⇒ **`cxt run` / `cxt exec` 在 spawn 前必须 `mkdir -p profiles/<token>/`**，
  这是实现时最容易漏、且症状最迷惑的一步（表现为"隔离没生效"，而非报错）。
- 🟡 `codex doctor` 的 `state.paths` 检查项在**配置加载失败时仍能报告 CODEX_HOME**
  （原文 summary：`CODEX_HOME was resolved without config`）——可用来单独定位"目录问题"还是"配置问题"。
- 🟡 同一 CODEX_HOME 的跨进程锁语义**无文档**。→ 更应坚持"一 token 一 profile"。
- 🟡 自动更新器按会话在后台运行，多实例并发更新的行为无文档 → 多窗口同时启动可能看到更新提示。

### 7.2 配置层级与优先级

高 → 低（企业环境在之上还有 `requirements.toml` 与 managed defaults，**它们压过 CLI `--config`**）：

1. **CLI 参数与 `-c` 覆盖**
2. **项目级 `.codex/config.toml`**（仅当项目可信；从仓库根向 cwd 逐层，**离 cwd 最近的赢**）
3. **profile 层**：`-p <name>` 把 **`$CODEX_HOME/<name>.config.toml`** 叠在用户配置之上
4. **用户级 `$CODEX_HOME/config.toml`**
5. 系统级 `/etc/codex/config.toml`（仅 Unix）
6. 内置默认

- 🟢 ★ **原先"第 2 与第 3 谁先"的信源打架，已定案：项目级 > profile。**
  真机判别法：磁盘上放三层不同的 `model`，看 `codex exec` banner 报哪个——
  `user=user-model` / profile 文件 `=file-model` / 项目级 `=project-model`（项目已信任）：

  | 场景 | banner 的 `model:` | 结论 |
  |------|------------------|------|
  | 仅项目级（可信） | `project-model` | 项目级 > 用户级 |
  | 项目级 + profile | `project-model` | **项目级 > profile** |
  | 项目级 + `-c model=cli-model` | `cli-model` | **`-c` > 项目级** |
  | 项目级 + profile + `-c` | `cli-model` | `-c` 最高 |

  ⇒ **本文件 §2.3 的级联表次序正确，无需改动**；第三方"profile 在项目级之上"的说法是错的。
- 🟡 **`--profile` / `-p` 是 profile 选择，不是 print 模式**——与 Claude Code 的 `-p` 语义完全不同。
  值类型在帮助里标为 `CONFIG_PROFILE_V2`，见 §7.4（**机制已换代，别按老文档写**）。
- 🟡 `-p/--profile` **只被 `exec` / `resume` / `fork` 接受**；`doctor` / `debug` / `review` / `apply`
  都不收（真机验证：`codex doctor -p x` → `error: unexpected argument '-p' found`）。
  ⇒ **`cxt doctor` 无法直接观测 profile 层**，要验证 profile 只能借道 `codex exec` 的 banner。

### 7.3 ★ 项目级配置的禁区（本工具存在的理由）

**Codex 在项目级 `.codex/config.toml` 中静默忽略以下键：**

```
openai_base_url              chatgpt_base_url             model_provider
model_providers              notify                       profile
profiles                     otel                         experimental_realtime_ws_base_url
apps_mcp_product_sku
```

- 🟢 **真机确认：`model_provider` 在项目级被忽略，且与信任状态无关。**
  测试项目写 `model_provider = "project-provider"` + 完整 `[model_providers.project-provider]` 表，
  在**项目已信任**状态下 `codex doctor` 仍报 `model provider = openai`，
  `codex exec` banner 仍报 `provider: openai`。**同一文件里的 `model = "project-model"`
  却正常生效**——证明是"按键白名单丢弃"，不是"整个文件没读"。
- 🟢 **警告原文（从二进制字符串提取）**：
  `Ignored unsupported project-local config keys in <path>. If you want these settings to apply, manually set them in your user-level config.toml.`
  ⚠️ 该警告**在 `codex doctor` 中不出现**（doctor 的检查项里也没有 trust 类检查），
  只在真正的启动路径上打印。**别用 doctor 的"没警告"推断"没被忽略"。**
- 🟡 官方理由：项目文件**不能**覆盖"重定向凭证、改 provider 认证、选 profile、
  跑机器本地命令或上报遥测"的设置。
- 🟡 回归实例：**PR #20098 / issue #22222**（Codex CLI 0.130.0）——项目级 `model_provider` /
  `model_providers` 被丢弃，静默回落到默认 OpenAI 路由。
- 🟢 **`sandbox_mode` / `approval_policy` / `sandbox_workspace_write.*` 不在禁区里**，
  在**可信**项目里可以正常生效。（有一份第三方清单把它们也列进禁区，**是错的**，别照抄。）
  真机证据：项目写 `approval_policy = "never"`，信任后 doctor 报 `approval policy = Never`。
- ⚠️ **禁区清单随版本演进**，写代码时不要硬编码假设——`cxt doctor` 应把
  "项目级出现了禁区键"当作可提示项。

#### ★ 信任门是三态，不是二态（真机实测）

同一个测试项目，只改 `~/.codex-a/config.toml` 里的 `trust_level`：

| 状态 | 生效 `model` | 生效 `approval_policy` | 说明 |
|------|-------------|----------------------|------|
| `trusted` | `project-model` ✅ 项目级生效 | `Never` ✅ 项目级生效 | 项目配置正常 |
| `untrusted`（显式） | `<default>` ❌ | **`UnlessTrusted`** | 与"从没见过"**不同** |
| 无记录（从未标记） | `<default>` ❌ | **`OnRequest`** | 保守默认 |

⇒ **`untrusted` ≠ "没记录"**，Codex 内部是**三个**状态。`UnlessTrusted` 是一个
**只在 resolved 结果里出现、CLI 不接受**的审批档位（见 §7.10）。
`cxt doctor` 报"项目未受信任"时，**必须区分这两者**，否则用户会困惑于"我明明没标记过它"。

#### ★ 信任记录的路径匹配规则（真机实测，`cxt trust` 必须照此实现）

`[projects.'<path>'] trust_level = "..."` 里的 `<path>` 与 cwd 的匹配是**字符串比较**，
不是文件系统语义比较。逐条实测：

| 写法 | 是否匹配 `C:\Users\alice\codex-test-proj` |
|------|:---:|
| `'C:\Users\alice\codex-test-proj'`（TOML **字面字符串**） | ✅ |
| `"C:\\Users\\alice\\codex-test-proj"`（转义基本字符串） | ✅ |
| `"C:/Users/alice/codex-test-proj"`（**正斜杠**） | ❌ **不匹配** |
| `'c:\users\alice\codex-test-proj'`（全小写） | ✅ **大小写不敏感** |
| `'C:\Users\alice'`（父目录） | ❌ **不继承**，只认精确路径 |
| `'C:\Users\alice\codex-test-proj\'`（尾部分隔符） | ❌ |
| `'\\?\C:\Users\alice\codex-test-proj'`（UNC 前缀） | ❌ |
| `'C:\Users\alice/codex-test-proj'`（混合分隔符） | ❌ |

⇒ **实现铁律**：
1. **必须写 Windows 原生反斜杠**（`path.win32` 形式，不转正斜杠）——这是最容易写错、
   且**完全静默**的一步：写错了不报错，只是"信任没生效"。
2. 写 TOML 时**优先用字面字符串 `'...'`**（免转义）；路径含单引号时退化为
   转义基本字符串（`\\`）。
3. **不要**给父目录写信任来"覆盖子项目"——不支持继承，必须逐个项目写。
4. 比较前**不要**做 `path.resolve()`/`realpath` 归一化后再写盘——写的是**用户给的字面路径**，
   Codex 拿它跟 cwd 字符串比。大小写不敏感是 Codex 侧的容错，不是我们归一化的理由。
5. 🟢 **二进制里的写入格式**：`projects."<path>".trust_level`（经 app-server 的
   `config/batchWrite`），且该表**只有 `trust_level` 一个字段**
   （`struct ProjectTrustConfigToml with 1 element`）。**别往里加别的键。**

#### ★ 同一目录的**第二种拼写**：8.3 短名（真机实测，2026-10-17）

Windows 上同一个目录可以有**两个都合法**的字符串拼写：

```
长名  C:\Users\alice          ← %USERPROFILE%，os.homedir() 给的是这个
短名  C:\Users\ALICE~1            ← %TEMP% 给的**就是**这个（本机实测）
```

两条 `existsSync` 都是 `true`，写进去的文件互相看得见——**文件系统层面是同一个目录，
字符串层面是两个值**。而 §7.3 的匹配是字符串比较 ⇒ 这是又一条**静默失配**的路。

🔴 **关键：`realpathSync` 的两种实现行为相反**（真机实测，别记混）：

| 输入 | `fs.realpathSync`（JS 版） | `fs.realpathSync.native` |
|------|--------------------------|--------------------------|
| `C:\Users\ALICE~1` | `C:\Users\ALICE~1`（**原样保留**） | `C:\Users\alice`（**展开**） |
| `C:\Users\ALICE~1\AppData\Local\Temp` | 同上，原样保留 | `C:\Users\alice\AppData\Local\Temp` |
| `C:\Users\ALICE~1\...\cxt-83b-6vlYuf` | 同上，原样保留 | 前缀展开，末段原样 |
| `C:\Users\alice`（对照） | 不变 | 不变 |

⇒ **JS 版不是规范化器**（它只解析软链与 `..`/`.`），**`.native` 才是**
（它走 `GetFinalPathNameByHandleW`，逐段给出规范拼写）。
这正是 `platform/index.js` 的 `realpathOrNull()` 用 `.native` 的原因——
第一条理由是重解析点（§7.14⑤），这是第二条。

⇒ **对 `cxt` 的影响，两条都不能违反**：
1. **写信任表仍然写用户的字面路径**（铁律 4 不变）——不许拿 `realpath` 归一化后写盘。
   理由是自洽性：`cxt` 与 Codex 读的是**同一个** `process.cwd()` 字符串。
2. ⚠️ **但"短名 cwd"是可达的**：本机 `%TEMP%` 就是短名，所以
   `cd %TEMP%\proj` 之后 `process.cwd()` 给的就是短名。此时若用户
   **用短名进去 `cxt bind`、之后用长名 `cd` 进去跑 `cxt run`**，
   两条字符串对不上 → **信任静默不生效**（症状与正斜杠写错一模一样）。

⇒ **对策（`cxt trust` / `cxt bind` / `cxt doctor` 都该做）**：
写路径前用 `core/bindings.js` 的 `looksLikeShortName(p, platform)` 探一下，
命中就**出 warning**（不是报错——`a~1` 这种目录名合法，会误伤）：
"这条路径看着像 8.3 短名，与长名拼写不互通，信任可能不生效"。
**警告而非归一化**：归一化会违反铁律 4，而铁律 4 是为了自洽。


⇒ 🟢 **上面两张表都已自动化，不用再手工跑**（2026-10-17 复核）：
`node scripts/verify-real-codex.mjs` 第 **⑥** 节把逐行规则都做成了断言——
判据不是"文件里写对了吗"，而是**项目级配置到底生不生效**（项目写 `model = "project-model"`
+ `approval_policy = "never"`，用户级写 `model = "user-model"`，读 `codex doctor` 看谁赢）。
其中两条是**反向断言**，专门守着"别把规则改宽"：
- **正斜杠必须静默失配**（若变绿，说明 Codex 开始容忍正斜杠了，铁律 1 可以放宽）；
- **`untrusted` 必须解析成 `UnlessTrusted` 而不是 `OnRequest`**（若变绿，说明三态退化成二态了）。

⇒ 三态那两条断言的分工值得记一笔：**只读 `model` 分不出 `untrusted` 与"从未标记"**
（两者都是项目级被跳过）。`approval` 才分得开。所以 `cxt doctor` 报"项目未受信任"时，
必须照 §7.10 的三档去分辨，别只看"项目配置生效了没有"。

### 7.4 ★★ profile 机制已换代：是**独立文件**，不是 `[profiles.*]` 表（本节整体改写）

> 🔴 **原结论作废。** 本节此前写的是"profile 会遮蔽身份键，别用 profile"——那是**基于
> `[profiles.<name>]` 表**这个旧形态的判断。0.163.0 实测：**profile 是独立文件，
> 而且它不受 §7.3 的项目级禁区约束，能正常承载 provider 身份。** 这是回归中最大的一处推翻。

#### 机制（🟢 真机实测 + 🟡 官方帮助文本）

- 🟡 `codex --help` 对 `-p, --profile <CONFIG_PROFILE_V2>` 的原文：
  *"Layer `$CODEX_HOME/<name>.config.toml` on top of the base user config"*。
- 🟢 **`[profiles.<name>]` 表是 legacy，且与 `-p` 同用是硬错误**。真机报错原文：
  ```
  Error loading config.toml: --profile `tblprof` cannot be used while
  C:\Users\alice\.codex-a\config.toml contains legacy `profile = "tblprof"`
  or `[profiles.tblprof]` config; move those settings into
  C:\Users\alice\.codex-a\tblprof.config.toml and remove the legacy profile
  selector/table.
  ```
  ⇒ 报错信息**自己给出了迁移目标路径**，这就是新机制的权威定义。
  ⇒ 这也解释了 DeepSeek 脚本为什么要删 `[profiles.*]`（"此版本已禁止写入"）——
  它删的是 **legacy 形态**，不是"profile 这个能力"。
- 🟢 **profile 文件不存在时不报错**：`-p ghost`（无同名文件、无同名表）→ 正常启动，
  静默按无该层处理。**⇒ `cxt` 不能指望 Codex 帮我们校验 profile 文件存在性，
  必须自己先 `stat`。**
- 🟡 顶层 `profile = "<name>"` 选择器同样是 legacy；`-c profile=<name>` 会直接
  `config could not be loaded / invalid data`（真机验证）——**别用 `-c` 设 profile**。

#### ★ 关键发现：profile 文件**可以**承载 provider 身份（🟢 真机实测）

在**项目不可信**（项目级配置被完全忽略）的前提下，只靠 profile 文件：

```toml
# $CODEX_HOME/testprof.config.toml
model = "file-model"
model_provider = "prof-prov"

[model_providers.prof-prov]
name = "prof-prov"
base_url = "https://prof.example.invalid/"
env_key = "PROF_KEY"
wire_api = "responses"
```

`codex exec -p testprof hi` 的 banner 报 **`provider: prof-prov`** ✅
（把 `base_url` 换成 `127.0.0.1:9` 后连接被拒，进一步证明 base_url 真被使用）。

⇒ **profile 文件位于 `$CODEX_HOME`，属于用户级，因此不在 §7.3 的项目级禁区里。**
**它是一条完整的、可用的身份注入通道**，能设 `model` / `model_provider` /
`model_providers` / `base_url` / `env_key` / `wire_api`。

#### 那 `cxt` 要不要改用它做主通道？——**不改，但要知道它的存在**

- **主通道仍是 `CODEX_HOME` 隔离**（§2.2）。理由：`CODEX_HOME` 同时隔离
  `auth.json` / `sessions/` / `history.jsonl` / SQLite —— **profile 文件只切配置，不切凭证与会话**。
  一个 token 一个目录，才是"多开"的完整语义。
- **profile 文件的正确用途**：同一个 token 内的**变体切换**（不同 model / 不同 wire_api /
  灰度另一条 base_url），不必新建一整个 CODEX_HOME。这是 v1 可选的增强项，**不是必需**。
- ⚠️ **不要**把 profile 与 `CODEX_HOME` 隔离混着用来表达"同一个 token 的两个身份"——
  凭证仍会共享，语义会变得难以解释。
- ⚠️ 既然 legacy `[profiles.*]` 与 `-p` 冲突会**硬失败**，`cxt` 写受管区时
  **绝不要**往 `config.toml` 里写 `[profiles.*]` 或顶层 `profile`——
  否则用户一旦想用 `-p` 就炸。**已加入 §2.9 的不碰键清单。**

### 7.5 模型目录 `model_catalog_json`

- ✅ 顶层键 `model_catalog_json` 指向一个 JSON 文件，声明模型的上下文窗口、推理档位、
  工具能力等元数据。DeepSeek 脚本把它写成
  `model_catalog_json = "<CODEX_HOME>/models.json"`（**正斜杠**，注释说明
  *"backslash is an escape character in TOML"*，且 Windows 上 `~` 不保证被展开、
  失败时是静默的，所以**写解析后的绝对路径**）。
- ✅ 目录里每条模型的字段（DeepSeek 脚本实测样例）：`slug`、`display_name`、`description`、
  `context_window` / `max_context_window`（1048576）、`effective_context_window_percent`（95）、
  `default_reasoning_level` / `supported_reasoning_levels[]`（`effort` + `description`）、
  `input_modalities`（`["text"]` 或 `["text","image"]`）、`web_search_tool_type`、
  `supports_parallel_tool_calls`、`shell_type`、`base_instructions`、`priority`、
  `minimal_client_version`、`truncation_policy` 等。

#### 🔴 真机实测（0.163.0，2026-10-17）：必填字段集与"静默"假设的修正

上面那份字段表来自第三方脚本，**不完整**。用 Codex 自己的 serde 报错当 oracle
（`missing field \`X\`` → 补上 → 重跑，直到加载通过）试出的**真正必填集**是：

| 类别 | 字段 |
|------|------|
| 必填（serde） | `slug`、`display_name`、`supported_reasoning_levels[]`、`shell_type`、`visibility`、`supported_in_api`、`priority`、`support_verbosity`、`truncation_policy{}`、`experimental_supported_tools[]` |
| 必填（**自定义校验**，非 serde） | `base_instructions` **或** `model_messages.instructions_template` 二者其一 |
| cxt 应当写（虽非必填，但不写就失去 catalog 的意义） | `context_window`、`max_context_window`、`effective_context_window_percent`、`default_reasoning_level`、`input_modalities` |

> ⚠️ **`visibility` 是必填，而上面那份字段表里没有它**——照抄那张表写出来的 catalog
> 会**整个配置加载失败**。这正是"第三方样例 ≠ schema"的代价。

- 🔴 **顶层形状必须是对象 `{"models": [...]}`，裸数组 `[...]` 会失败。**
  （真机对照：对象 ✅ 加载通过 + `debug models` 可见；裸数组 ❌ 加载失败。）
- 🔴 **§7.5 原来说"加载失败是静默的"——只对了一半，必须分清两类失败**：

  | 失败类型 | 表现 | 严重度 |
  |---------|------|-------|
  | **路径问题**（文件不存在 / `~` 没展开） | 静默 fallback（`fallback model metadata` / `Unknown model`） | 隐蔽，但能跑 |
  | **schema 问题**（缺必填字段 / 顶层形状错 / JSON 语法错） | **整个配置加载失败**：`codex doctor` 报 `✗ config config could not be loaded`，`codex exec` 直接退出 | **致命** |

  ⇒ `cxt doctor` 对 catalog 的检查不能只看"JSON 合法"，**必须真的把它喂给 Codex 验一遍**。
- 🟢 **两个现成的验证仪器**（`cxt doctor` 应当调用，比自己猜可靠得多）：
  - `codex debug models` —— 把**实际加载后**的模型目录渲染成 JSON。
    `grep` 目标 slug 就能确证"catalog 真的被采纳了"，而不只是"文件写对了"。
  - `codex doctor` 的 **`auth` 检查项** —— 会点名我们生成的 `env_key`
    （`active model provider auth env var is missing - Set CXT_TOKEN_<TOKEN>`）。
    这一行**同时证明了整条注入链**：config 被解析 → provider section 被采纳 →
    `env_key` 被读出 → 我们注入的环境变量是它期待的那个。
    **`✓ auth  auth is provided by the active model provider` = 注入链全通。**
- 🟢 **`model_catalog_json` 会展开 `~`**（2026-10-17 在 0.163.0 上判成事实，原为
  "⚠️ 第三方观察：可能不支持"）。判据：目录里写 `context_window = 98765`，
  配置里用 `model_catalog_json = "~/<proj>/tilde-catalog.json"` 引用它，
  `codex debug models` 读回 `98765`；并配了阴性对照（指向不存在的文件时读不到该值，
  排除"这个数其实是未知模型的默认值"）。
  ⇒ 契约仍然要求 **cxt 一律写绝对路径**（§2.4 的样例是 `~/...` 形式，
  所以 `buildInjection()` 里做 `expandTilde`）。但要说清楚这是**保险，不是必需**：
  它把"依赖 Codex 的版本行为"换成"我们自己的确定性变换"，一行代价换掉一个静默失败面。
  **别因为验出来"其实支持"就把那行删掉。**
  回归入口：`scripts/verify-real-codex.mjs` 第 ③ 节。

### 7.6 会话、历史与续接

- ✅ 会话记录：`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-*.jsonl`（按日期分目录）
- ✅ 命令历史：`<CODEX_HOME>/history.jsonl`；另有 SQLite 状态库（`sqlite_home` 可另指）
- ✅ 续接命令：
  - `codex resume --last`（`-l`）——最近的会话，**不带选择器**
  - `codex resume`——交互式选择器
  - `codex resume <SESSION_ID>`——指定会话
  - `codex resume --all`——跨目录
  - `codex exec resume --last "..."` / `codex exec resume <ID> "..."`——非交互续接
  - `codex fork`——从现有会话分叉出新 session id
- ✅ `-c experimental_resume="<rollout jsonl 绝对路径>"` 可直接按文件恢复（**实验性**）
- 🟢 ★ **`resume --last` 默认按 cwd 过滤，已定案。** 官方帮助对 `--all` 的原文：
  *"Show all sessions (disables cwd filtering and shows CWD column)"* ——
  **"disables cwd filtering" 直接反证默认是过滤的**，且 `--all` 会多显示一列 `CWD`。
  ⇒ §2.5 的模型切换工作流成立：同一个 CODEX_HOME 下，不同项目目录的会话不会互相串。
- 🟡 另有 `--include-non-interactive`：*"Include non-interactive sessions in the resume
  picker and --last selection"* ⇒ **默认会把非交互会话（`exec` 产生的）排除在
  `resume --last` 之外**。`cxt` 若想让 `cxt exec` 的会话可被 `cxt run` 续接，
  必须显式带这个 flag。
- 🟢 **`codex exec` 要求身处 git 仓库**，否则拒绝启动：
  `Not inside a trusted directory and --skip-git-repo-check was not specified.`
  ⚠️ 注意措辞把"git 仓库"和"受信任"混在一起说，**别误读成"信任门"**——
  实测：**已有有效信任记录但目录不是 git 仓库时，依然报这条**。
  ⇒ 用 `git init` 造一个空 `.git/` 目录**不够**（要真仓库）。
- ✅ `codex exec` 另有：`--json`（JSONL 输出）、`-o/--output-last-message <FILE>`、
  `--output-schema <FILE>`、`--ephemeral`、`--ignore-user-config`、`--ignore-rules`、`--skip-git-repo-check`

- 🔴 ★ **订正（2026-10-17 真机实测）：`--skip-git-repo-check` 是 `codex exec` 子命令专属，
  顶层 `codex` 不认它——`cxt exec` 绝不能自动补这个 flag。**

  | 调用 | 结果 |
  |------|------|
  | `codex --help \| grep skip-git` | **无输出**（顶层没有这个 flag） |
  | `codex exec --help \| grep skip-git` | ✅ 第 87 行：`--skip-git-repo-check` |
  | `codex --skip-git-repo-check --version` | ❌ `error: unexpected argument '--skip-git-repo-check' found` |

  ⇒ 本文档此前在 §4.4 第 11 步与本节都写过"`cxt exec` 在非 git 目录下必须自动补
  `--skip-git-repo-check`"——**那条是错的**，它把 Codex 的 `exec` **子命令**
  与 cxt 的 `exec` **命令**当成了同一个东西。真按它实现，结果是
  **`cxt exec` 在任何目录下都启动不了**（不是"只影响非 git 目录"）。
  ⇒ 正确的分工：
  - **`cxt exec` 启动的是交互式 `codex`**（无子命令）→ 不补任何 git 相关 flag。
  - `codex exec`（非交互）**cxt 从不调用**，那条 git 要求与我们无关。
  - 非 git 目录下交互式 codex 的拦路虎是**信任门**（§2.3 第四条），
    而信任门是用户自己的安全策略，cxt **不绕、不补 flag**，只在
    `cxt doctor` / 启动前**提示**"这个目录没被标记过，codex 会问你"。
  ⇒ **教训（与 §7.14 各条同源）**：契约里凡是"必须自动补某个 CLI flag"的句子，
  落笔前都要拿 `--help` 验一次**它属于哪一层**。参数面的层级
  （顶层 / 子命令）是文档最容易想当然的地方，而错的代价是"命令完全跑不起来"。

### 7.7 CLI 参数面（🟢 0.163.0 本机 `--help` 实测）

- 🟢 **全局**：`-C/--cd <DIR>`、`-p/--profile <CONFIG_PROFILE_V2>`、`-c/--config <key=value>`、
  `-m/--model <MODEL>`、`-s/--sandbox <read-only|workspace-write|danger-full-access>`、
  `-a/--ask-for-approval <on-request|never>`、`--dangerously-bypass-approvals-and-sandbox`、
  `--search`、`--add-dir <DIR>`、`-i/--image <FILE>`、`--enable/--disable <FEATURE>`、
  `--remote <ADDR>`、`--remote-auth-token-env <ENV_VAR>`、`--strict-config`、`--oss`、
  `--local-provider <lmstudio|ollama>`、`--worktree`、`--no-alt-screen`、`--no-daemon`、
  `--approve-for-me`、`--dangerously-bypass-hook-trust`
- 🔴 **修正：`-a/--ask-for-approval` 的可选值只有 `on-request` 与 `never` 两个**
  （旧记录写的 `untrusted` 是**错的**——那是 `approval_policy` 配置键的历史取值，
  且 `UnlessTrusted` 只作为 **resolved 结果**出现，CLI 不接受，见 §7.10）。
- 🟢 **子命令全表**：`exec`(e) · `review` · `login` · `logout` · `mcp` · `plugin` ·
  `app-server` · `remote-control` · `app` · `completion` · `update` · `doctor` · `sandbox` ·
  `debug` · `apply`(a) · `resume` · `queue` · `archive` · `delete` · `migrate-rollouts` ·
  `unarchive` · `fork` · `cloud` · `exec-server` · `features` · `agents` · `help`
- 🟢 **`codex doctor` 的真实选项面**（比想象中窄）：
  `-c` / `--enable` / `--disable` / `--json` / `--summary` / `--all` / `--no-color` / `--ascii`。
  **没有 `--cwd`** ⇒ 它吃**进程当前目录**，`cxt doctor` 要检查项目级配置必须
  `cwd` 到该项目再 spawn。**也没有 `-p`** ⇒ 观测不到 profile 层。
- 🟢 `codex doctor --json` 的顶层键：`schemaVersion` / `generatedAt` / `overallStatus` /
  `codexVersion` / `checks`；`checks` 以 **check id 为键**（22 项，如 `config.load`、
  `network.provider_reachability`、`sandbox.helpers`、`state.paths`、`terminal.env`…）。
  **没有 trust 类检查项。**
- 🟢 **`codex debug` 有两个对 `cxt` 极有用的子命令**：
  - `codex debug models` —— 把**原始模型目录**渲染成 JSON（可用于交叉验证
    §7.5 的 `model_catalog_json` 是否真的加载上了）
  - `codex debug prompt-input` —— 把**模型可见的 prompt 输入列表**渲染成 JSON
    （可用于验证 §7.11 的 AGENTS.md 截断问题：能直接看到喂进去的文档片段）
  ⚠️ `debug` **不接受 `-p`**。
- ⚠️ `--full-auto` **已废弃**，且只在 `exec` 下列出（"prefer `--sandbox workspace-write`"）
- 🟡 **`codex features` 能列出每个 feature flag 的"生效值 + 是哪一层设置的"** ——
  `cxt doctor` 应当调用它来交叉验证我们的注入是否真的生效（比自己猜可靠）

### 7.8 `-c` 覆盖的语义（承重 —— 🟢 已真机验证通过）

- 🟢 形式 `key=value`，**可重复**；key 支持**点号路径**到达嵌套键
  （`-c model_providers.<id>.base_url="..."`、`-c agents.max_threads=12`）
- 🟢 **value 按 TOML 解析**（不是 JSON）；解析失败则当字符串。
  ⇒ 内联表可以一次定义整个 provider：
  ```bash
  codex -c model_providers.p='{name="p", base_url="https://api.example.com/", env_key="P_KEY", wire_api="responses"}' \
        -c model_provider="p" -c model="some-model"
  ```
- 🟢 优先级：**配置专用 flag（如 `--model`）> `-c` > 所有文件层**（§7.2 表已实测）
- 🟢 ★★ **"`-c` 能否凭空创建一个此前不存在的嵌套表" —— 能。已实测通过。**
  这是本设计里唯一"若不成则架构要改"的假设，**现在不再是风险**。判别实验：

  | 命令 | 结果 |
  |------|------|
  | `-c model=some-model`（标量） | ✅ 配置加载成功 |
  | `-c model_provider=fake`（**表不存在**） | ❌ 失败 |
  | `-c model_providers.fake='{...}' -c model_provider=fake`（**先建表再引用**） | ✅ 成功 |

  🔴 **同一条约束在 `config.toml` 里同样成立（2026-10-17 真机补测）**：

  | `config.toml` 内容 | 结果 |
  |------|------|
  | 有 `model_provider = 'cxt-ghost'`，**无** `[model_providers.cxt-ghost]` | ❌ **整个配置加载失败**（`✗ config`，`entity not found`） |
  | 有 `model_provider`，**有**同名 section | ✅ 通过 |
  | **无** `model_provider`，有多余的 provider section | ✅ 通过（孤立的 section 无害） |

  ⇒ ★ **拼接器的硬约束**：`model_provider` 与它的 provider section
  **必须同一次写入里成对出现**。任何"先写一半、下次再补"的路径（比如 provider 值解析失败时
  只写顶层键）都会让用户的 `config.toml` **当场变成不可加载**——比不写还糟。
  `toml-splice.js` 用"`managedValues.provider` 为 `null` 就不写 `model_provider`"来守这条，
  单测里有对应断言。

  且**证明 provider 真的被使用**（不只是"没报错"）：`codex doctor` 报
  `fake API inference URL = https://example.invalid/responses`、
  `reachability mode = provider auth`、可达性 = 失败（因为主机不可达）。
  ⇒ **base_url、env_key、wire_api 三者全部被尊重**，`wire_api="responses"`
  正确地拼出了 `/responses` 路径。
- 🔴 **PowerShell 引号陷阱（真机踩到）**：经 PowerShell 传内联表时，
  **双引号会被 PS 5.1 转义破坏**，Codex 报 `error: invalid data`。
  ```
  ✗  -c 'model_providers.fake={name="fake", ...}'    # PS 破坏双引号 → invalid data
  ✓  -c 'model_providers.fake={name=''fake'', ...}'  # 改用 TOML 单引号字面字符串
  ```
  ⇒ **`cxt` 走数组 argv 不过 shell，这层歧义不存在**；但两点要记住：
  ① 兜底 launch 脚本必须处理；② **`toTomlValue` 生成内联表时应优先用 TOML
  字面字符串（单引号）**，这样即便用户手工复制粘贴到 shell 里也不会炸。
- 🟡 引号陷阱（另一层）：经 shell 时 `-c key="true"` → TOML 布尔；要字符串得 `-c key='"true"'`。

### 7.9 provider 定义与凭证

- ✅ `[model_providers.<id>]` 字段：`name`、`base_url`、`env_key`、`wire_api`、
  `http_headers`、`env_http_headers`、`query_params`、`requires_openai_auth`、
  `request_max_retries`、`stream_max_retries`、`stream_idle_timeout_ms`；
  另有 `[model_providers.<id>.auth]` 可跑命令取 bearer token
- ✅ `env_key` 的值是**环境变量名**，不是 key 本身（`env_key = "ARK_API_KEY"` → 你 export `ARK_API_KEY`）
- ✅ 内置 provider id：`openai`、`ollama`、`lmstudio`（**别撞名**，故 cxt 用 `cxt-` 前缀）
- ✅ `requires_openai_auth = false` 可阻止 Codex 假设 key 有 `sk-` 前缀
- ⚠️ **`wire_api` 目前只接受 `"responses"`**（0.59 起 `"chat"` 已移除）。
  DeepSeek 脚本更狠：它会把 `wire_api = "chat"` **改写**成 `"responses"`，理由是
  *"此版本 `chat` 会导致 Codex 无法启动"*。⇒ cxt 的内置默认就是 `"responses"`，别提供 `chat` 选项
- ✅ `experimental_bearer_token` 存在，但把 key 明文写进 config.toml——**cxt 不用它**（§2.2）

### 7.10 沙箱与审批

- 🟢 `sandbox_mode`：`read-only` | `workspace-write` | `danger-full-access`
  （CLI `-s` 的三个可选值，官方帮助实测）
- 🟡 `approval_policy`：`untrusted`（默认）| `on-request` | `never` | `{ granular = {...} }`
- 🟢 ★ **resolved 后会出现第三个值 `UnlessTrusted`**，它**只能被观测到、CLI 不接受**。
  真机三态（§7.3 表）：`trusted`→`Never`、显式 `untrusted`→`UnlessTrusted`、
  无记录→`OnRequest`。⚠️ 别把 `UnlessTrusted` 写进 `cxt` 的任何参数校验里。
- 🟢 **`codex exec` 的 banner 里 `approval:` 恒为 `never`** —— 非交互模式下无法提问，
  这是 exec 的固有行为，**不是配置生效的证据**。判断审批档位要用 `codex doctor`。
- 🟡 `[sandbox_workspace_write]`：`writable_roots`、`network_access`、
  `exclude_tmpdir_env_var`、`exclude_slash_tmp`
- 🟡 更细的 `[permissions.<name>]`（filesystem / network / domains）与内置档位
  `:read-only` / `:workspace` / `:danger-full-access`，经 `default_permissions` 选择
- ⚠️ `network_access = false` + 需要网络的工具 = **静默挂起**，没有清晰报错。
  README 要写这条（用户会以为是 cxt 的问题）
- 🟢 **Windows 观察**：`codex doctor` 在本机（Windows 11 26200）恒报
  `filesystem sandbox = restricted` + `sandbox backend = disabled`，
  **即使项目级 `sandbox_mode = "workspace-write"` 已生效**。
  ⇒ **在 Windows 上不要用 doctor 的 `sandbox.*` 检查项去判断项目级沙箱配置是否生效**
  （后端未启用，字段不反映配置）；判断"项目级是否生效"要用 `approval policy` 或 `model` 这类
  会随配置变化的字段。**这是本平台最容易误判的一处。**

### 7.11 AGENTS.md 与项目文档

- ✅ `project_doc_fallback_filenames`（默认含 `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md`）
- ✅ `project_doc_max_bytes`（默认 **32768**）
- 🔴 **实测：本文件已超限 7 倍**（2026-10-18 `wc -c` 实测 **≈245 KB** / 32,768 B 上限 ≈ **7.5×**。
  同一天更早一次是 ≈239 KB ≈ 7.3×，再早是 ≈220 KB ≈ 6.7×，2026-10-17 那次是 ≈109 KB ≈ 3.3×——
  **§2.13 / §2.14 / §7.17 加完就翻了一倍，网页控制台（§2.14 十）又加了一截**）。
  按默认值 Codex 只读到全文约 **13%** 处，**§3 之后全部读不到且无任何报错**。
  → 每台开发机须设 `project_doc_max_bytes = 262144`（见文件头的醒目提示）。
  ⚠️ **离这个值只剩 ≈17 KB（6.6%）**——下一个大特性之前，先做下面那件事。
  → **再要加东西，就先把 §7 / §8 挪进 `docs/`**：它们是最长、最独立、也最少被通读的两节
  （§7 是 Codex 的事实清单，§8 是未决问题）。本文件留"铁律 + 索引"，
  正好回到它自己开头说的定位——**铁律索引，展开在 `docs/`**。
  → `cxt doctor` 必须检查这条，因为**截断是静默的**（对比：`agent_multi_token/claude code/CLAUDE.md`
  现约 155 KB，Claude Code 无此限制，所以那边没暴露这个问题——**这是 Codex 专有的坑**）。
  → 若某个用户仓库的 `AGENTS.md` 很大，`cxt doctor` 应能报出"将被截断到 N 字节"。
  → ⚠️ **别把本文档里的字节数写进任何代码或断言**——它每次编辑都过期
  （本节上面那些数字也一样，只是给人一个量级感）。
  代码只认"读文件算字节 vs 读配置算上限"这个**比较**，不认任何具体数值。
- ✅ `project_root_markers`（默认 `[".git"]`）
- ✅ `model_instructions_file` 可整体替换内置指令
- ⚠️ 全局 `~/.codex/AGENTS.md` 是否存在、与项目级如何合并，**未确认**——别在文档里断言

### 7.12 会与模型元数据打架的键（别主动写）

DeepSeek 脚本会**删除**以下键，理由都是"会覆盖 models.json 的声明"：

| 键 | 脚本给的理由 |
|----|------------|
| `model_context_window` | 报大会导致自动压缩不触发，跑到一半 API 报错 |
| `model_auto_compact_token_limit` / `_scope` | 覆盖自动压缩时机 |
| `base_instructions` / `model_instructions_file` | 覆盖 models.json 的 base_instructions |
| `compact_prompt` / `experimental_compact_prompt_file` | 覆盖上下文压缩提示词 |
| `service_tier` | 残留值会作为参数发给 API，可能 400 |
| `model_verbosity` | 残留值可能超出模型支持范围 |
| `model_reasoning_summary` | 与 `default_reasoning_summary=none` 冲突 |
| `plan_mode_reasoning_effort` | 可能是 xhigh，而 models.json 只声明 low/high/max |
| `experimental_use_unified_exec_tool` | 与 `shell_type=shell_command` 冲突 |

### 7.13 认证

- 🟡 `preferred_auth_method = "apikey"` 与 `forced_login_method = "api"` 可跳过 ChatGPT 账号登录流程
  （DeepSeek 脚本写入这对组合，目的就是让 API key 模式直接生效）
- 🟡 `codex login --with-api-key`（从 stdin 读 key）/ `--device-auth` / `codex login status`
- 🟡 `codex logout` 移除已存凭证
- 🟢 **未登录时的可观测症状**：`codex doctor` 的 `auth.credentials` 检查项失败；
  且 `codex exec` 会在打完 banner 后**挂起等待**（不是快速报错）。
  ⇒ `cxt` 的启动前预检应依赖 `doctor` 的 `auth.credentials`，**不要**靠"跑一次 exec 看它多久失败"。
- ⚠️ `auth.json` 的具体结构未确认——**cxt 不读不写它**，所以不影响设计

### 7.14 ★ TOML 写入暗礁（直接约束 §2.9 的拼接器）

- 🟡 **① BOM —— 结论保留，但"致命"的理由已被真机推翻（2026-10-17 复核）。**
  原记录说"Codex 的 TOML 解析器不接受带 BOM 的配置文件 → 配置直接加载失败"。
  **在 0.163.0 上复现不出来**：十六进制确认 `EF BB BF` 确实在文件头，
  而 `codex doctor` 的 config 检查**照样通过**，provider section 也照样被读到
  （auth 行正确点名了 section 里的 `env_key`）。带 BOM 与不带 BOM 表现一致。

  | 文件 | `codex doctor` config 检查 |
  |------|:---:|
  | 无 BOM | ✅ 通过 |
  | 带 BOM（`ef bb bf` 已在盘上确认） | ✅ **通过** |
  | 带 BOM + 完整受管区 | ✅ 通过（provider 仍被采纳） |

  ⇒ **"必须无 BOM 写出"这条规则不变，但理由要换**：不再是"Codex 会拒绝"，
  而是**卫生与可移植**——TOML 规范本身不容许 BOM；`config.toml` 是双作者文件，
  用户可能用别的工具（编辑器插件、CI 脚本、其它语言的 TOML 库）读它，
  那些工具**会**被 BOM 噎住。写出去的东西不该依赖"当前这个版本的 Codex 恰好容忍"。
  ⇒ `cxt doctor` 仍把"受管区文件带 BOM"列为可检测项，但**降级为提示**（提示里
  说明"当前 Codex 能容忍，但其它 TOML 工具不一定"），**不再当作致命错误**。
  ⇒ `PowerShell 5.1` 的 `Out-File -Encoding utf8` 确实会写 BOM —— 这条事实不变，
  仍然要用 `New-Object System.Text.UTF8Encoding($false)`。
  ⇒ ⚠️ **别把这条当成"BOM 无所谓"**：契约 §2.9 步骤 6 仍要求输出无 BOM，
  `toml-splice.js` 仍会剥掉 BOM 并在 `report.hadBom` 里报出来。
  只是"不剥会炸"改成了"不剥不炸，但不该留"。
- 🔴 **② TOML 基本字符串里反斜杠是转义符，Windows 路径必须用字面字符串。**
  `[projects."C:\Users\..."]` → `invalid configuration, line 1, column 16`
  （`\U` 开启了 Unicode 转义序列）。两种正确写法：**字面字符串** `'C:\Users\...'`
  或**转义基本字符串** `"C:\\Users\\..."`。
  ⇒ §7.3 已据此规定：**信任记录一律用字面字符串**。
  ⇒ ⚠️ 字面字符串**不能包含单引号**——路径含 `'` 时必须退化为转义基本字符串。
- 🔴 **③ PowerShell 5.1 按 ANSI 解码无 BOM 的 `.ps1`，非 ASCII 字符会破坏语法。**
  真机现象：脚本里一行**中文注释**被错误解码后吞掉了后续引号，报
  `Unexpected token ')' in expression or statement`。
  ⇒ **`cxt` 生成的兜底 launch 脚本（§2.12）必须写成纯 ASCII**，
  或者带 BOM 写出（但注意 ①：配置文件不能带 BOM，**脚本可以**——两者规则相反，别混）。
  ⇒ 本项目的**探针/测试脚本一律用英文注释**。

- 🔴 **④ `cmd /c "<带空格的路径>" ...` 会把路径从中间切开。**
  真机现象（`scripts/_smoke-launch.mjs` 里撞出来的）：
  ```
  cmd.exe /c C:\Users\...\cxt-launch-test\sub dir with spaces\launch.cmd
  → 'C:\Users\alice\cxt-launch-test\sub' 不是内部或外部命令
  ```
  cmd 对 `/c` 之后那串的解析是**先剥首尾引号再分词**，所以带空格的脚本路径
  即使加了引号也会被拆开。稳健写法是 `/d /s /c` + 把整条命令当成**一个**字符串：
  `cmd /d /s /c ""<带空格的路径>" <args>"`。
  ⇒ **影响 §2.12 兜底路径 ①**（`cmd /c start` 那条）与 §4.4 第 11 步的
  `platform/spawn-terminal.js`。**首选路径（直接 spawn，无 shell）不受影响**——
  这正是 §2.12 把"直接拉起"定为首选的理由之一。
  ⇒ ⚠️ 排查时注意别把它误判成"脚本生成错了"：脚本内容里的引号规则
  （`%*` 不转义、值一律加引号）是**另一件事**，由 `launch-script.js` 的单测覆盖。
  两者混在一起测，会让一个 harness 的坑伪装成"生成的脚本有问题"。

- 🔴 **⑤ `statSync` 看不见 App Execution Alias——`existsSync` 也是 `false`。**
  2026-10-17 真机实测 `%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe`
  （Microsoft Store 的应用别名，**Windows Terminal 就装成这样**）：

  | 调用 | 结果 |
  |------|------|
  | `statSync(p)` | **EACCES** —— 它要跟随重解析点，而目标在 MSIX 包目录里，普通用户没权限 |
  | `existsSync(p)` | **false** —— 内部就是 `statSync` |
  | `lstatSync(p)` | OK：`isSymbolicLink() === true`、`isFile() === false` |
  | `accessSync(p, F_OK)` | OK（**与 `existsSync` 结论相反**） |
  | `readdirSync(目录)` | OK，`wt.exe` 就在列表里 |

  ⇒ **判定"是不是文件"必须带 `lstatSync` 兜底**（stat 失败 → 看它是不是重解析点）。
  否则 `findExecutable('wt')` **静默返回 null**，而 §2.11 二·1 的 Windows 首选就是
  `wt.exe`——结果是**首选路径永远不生效**，每次都悄悄退到 `cmd /c start` 兜底
  （丢 cwd、丢窗口标题、多一层 shell），**不报任何错**。
  ⇒ ⚠️ **兜底只在 Windows 上开**：POSIX 的悬空符号链接不该被当成可执行文件
  （那边由 `accessSync(X_OK)` 自然处理，它会失败，正是我们要的）。
  ⇒ 与 §7.15 的 `python` 存根是**同一个机制**——那个也是 `WindowsApps` 里的别名。
  两者现象不同（`wt.exe` 能跑、`python.exe` 直接 exit 49），但**探测手段的坑是共用的**。
  ⇒ 回归断言在 `tests/find-executable.test.js`，含一条拿 `where wt` 当 oracle 的
  真机条件断言（本机没装 Windows Terminal 时自动不作断言）。

- 🔴 **⑥ Windows 上 `codex` 是个 `.cmd`，Node 拒绝直接 spawn 它 ⇒ argv 被迫过一遍 cmd 解析。**
  2026-10-17 真机实测（`scripts/_probe-codexbin.mjs` / `_probe-shim-args.mjs`，
  结论已固化为 `tests/codex-bin.test.js` 的 13 例往返）：

  | 调用 | 结果 |
  |------|------|
  | `findExecutable('codex')` | `C:\Users\<user>\AppData\Roaming\npm\codex.cmd` |
  | `spawnSync(bin, ['--version'])` | **EINVAL** —— Node 从 18.20 / 20.12 起拒绝 spawn `.cmd`/`.bat`（CVE-2024-27980） |
  | `cmd.exe /d /s /c "\"<path>\" --version"` + `windowsVerbatimArguments` | ✅ status 0，`codex-cli 0.163.0` |
  | 同目录下的 `codex.exe` | **不存在**（只有 `codex` / `codex.cmd` / `codex.ps1`）⇒ 这条路**绕不开** |

  ⇒ **§2.12 的"直接拉起"红利在这条路上没有**：argv 会经过 cmd 的解析。
  实测差异（对照 `spawn(node, [js, ...args])` 的基准真相）：

  | 参数 | 直接 spawn | 经 shim 不转义 | 处置 |
  |------|:---:|:---:|------|
  | `hello world` / `a & b` / `a ^ b` / `a \| b` / `a > b` / `100%` | ✅ | ✅ | 引号内安全，无需处理 |
  | `D:\工作\我的 项目` | ✅ | ✅ | **中文没问题**（曾误判为乱码——那是控制台 OEM 码页的显示问题，不是参数被改） |
  | `say "hi"` | ✅ | ❌ → `say hi` | `"` → `""`（实测 ✅） |
  | `D:\proj\` | ✅ | ❌ → `D:\proj"` | 尾随 `\` **翻倍**（`CommandLineToArgvW`：引号前 N 个反斜杠要写成 2N 个） |
  | `%PATH%` | ✅ | ❌ **被展开成真 PATH** | **无解**，只能检测 + 报警 |

  ⇒ **`%VAR%` 是硬限制**：实测 `%%PATH%%` 与 `^%PATH^%` 两种候选转义**都无效**
  （cmd 在 `/c` 命令行这一层不认这两种写法）。所以 `quoteForCmdShim()` **不假装能修**，
  由 `cmdShimArgv()` 把它报进 `warnings`——静默传一个被展开的路径比直接报错更贵。
  报警规则收窄到 `/%[A-Za-z_][A-Za-z0-9_]*%/`，`100%` 与 `50% off 20%` 不误报（实测）。
  ⇒ ⚠️ **别用链式 `replace` 做这两条转义**：先换 `"`→`""` 再处理"引号前反斜杠"，
  会把刚写进去的引号又当成目标（双倍转义）。`quoteForCmdShim()` 是**逐字符一趟扫**，
  `tests/codex-bin.test.js` 有一条专门钉这个叠加顺序。
  ⇒ `/s` **不是装饰**：实测去掉它则**全部用例都失败**（连朴素参数都跑不起来）。
  完整形态 = `['/d', '/s', '/c', '"<整条命令串>"']` + `windowsVerbatimArguments: true`。
  ⇒ **只对 `.cmd` / `.bat` 开**（`needsCmdShim`）：POSIX 上一个叫 `foo.cmd` 的文件
  就是个普通文件，套 `cmd.exe` 是错的。

- 🔴 **⑦ 终端的 argv 必须是"完整命令行"，且**新窗口里的失败在外面完全看不见**。**
  2026-10-17 `cxt run` 真机验收（`scripts/verify-run-real.mjs`）撞出来的两个缺陷，
  它们是**同一类**的：§2.12 要求"脚本与直接拉起逐字一致"，但实现时两处**各拼了一遍**头部。

  | 漏掉 | 真机现象 | 根因 |
  |------|---------|------|
  | `exec` 关键字 | 窗口正常弹出、标题正常，**一闪而过** | 里面跑的是 `cxt relay-a`，不是命令 → dispatch 报"未知命令" |
  | node 解释器 | 窗口弹出来，第一行 `出现错误 2147942593 (0x800700c1)` | `bin/cxt.js` 是**脚本不是 exe**；wt 拿它当程序名去 `CreateProcess` → `ERROR_BAD_EXE_FORMAT` |

  ⇒ **`cxt.js` 前面必须紧跟 node**。别指望 shebang：`#!/usr/bin/env node` 只在 POSIX 上
  由内核解释，Windows 上没人看它；而且 `'node'` 字面量会依赖新终端的 PATH，
  与"任何一步都不依赖 PATH"（§2.12 契约 1）冲突——所以收的是 `process.execPath`。
  ⇒ **修法不是补两处，是消灭第二处**：`core/launch-script.js` 的
  `buildCxtCommandLine()` 是唯一源头，直接拉起与脚本序列化都从它取。
  这条与 §2.12 的 `execArgs` 是**同一个教训的第二次**——接口形状 > 纪律。

  ### ⚠️ 最贵的一条：**新窗口里的报错只显示在那个窗口里**
  `wt.exe` 是**单实例 + 交接桩**（App Execution Alias，见 ⑤）：调用方 spawn 的
  那个 `wt.exe` 只是个把手，它把请求交给常驻的 `WindowsTerminal.exe` 就退了。
  于是：

  - `cxt run` 的退出码 **0** 只代表"交接请求发出去了"，**不代表窗口里的命令跑起来了**
  - 上面两个缺陷，`cxt run` 自己**一个字都看不到**——用户看到的是屏幕上闪一下
  - ⇒ 排查这类问题时，**`cxt run --print` 的输出就是全部证据**。
    它打印的那行 `wt.exe … <node> <cxt.js> exec …` 是可以**直接粘进终端**复现的，
    而那个窗口会**停住**并把错误显示出来（不会一闪而过）。
    ⚠️ 本项目**两次**都是"`--print` 早就诚实地印出了缺陷，只是没人细看"——
    写 `--print` 的断言时要**逐行**查，别只查第一行。

  ### 🟢 交接桩**不**吞环境变量（这条排除了一个很贵的怀疑方向）
  曾怀疑"新窗口拿到的是 `WindowsTerminal.exe` 的环境，而不是调用方的"——
  若成立，则 `USERPROFILE` 指向临时 home 的**所有隔离测试手段全部失效**。
  实测**不成立**，三种测法一致：新窗口里 `%USERPROFILE%`、新增的变量、
  **被改过值**的变量（`set` 全量 dump 对照）**都**是调用方的值。
  ⇒ WT 的交接是**每次调用各带一份环境**，不是继承常驻进程的。
  ⇒ 所以 §6 那套"`USERPROFILE` → 临时 home"的隔离手法在 `run` 路径上**同样有效**
  （`scripts/verify-run-real.mjs` 与 `tests/run-e2e.test.js` 都建立在这条之上）。
  ⚠️ 读 `cmd` 的 `set` 输出时注意 **OEM 码页（GBK/936）**：按 UTF-8 读会得到乱码，
  进而**伪造出一堆"变量没传过去"的假失败**。让 node 直接 dump JSON，别解析 cmd 的输出。

  ### ⚠️ 同一条事实的**反面**：正因为原样转发，调用方的会话身份也会跟着进新标签页
  "不吞环境变量"是好消息（隔离手法有效），但它同时意味着**"新终端 = 干净环境"是错的**。
  `cxt run` 从某个 codex 会话里被调用时，新标签页拿到的是**那个会话的整套环境**。
  ⇒ 凡是把环境交给 `spawn` 的地方（§2.11 二·1 的 `spawnTerminal`、§2.12 末的 `cxt exec`）
  都得**自己决定传哪份环境**，不能靠默认继承。契约见 §2.6「继承环境的净化」。

### 7.16 Windows Terminal 的窗口语义（本机实测 2026-10-18，WT 1.24.11911.0 / Windows 11 26200）

**这节是 §2.11 二·1 那个 argv 的依据，也是"别用直觉数窗口"的教训。**
（`wt` 的窗口语义是**终端自己的**行为，与本工具无关；这批事实在 `cmt` 项目里逐条实测过，
`cxt` 在同一台机器、同一个 WT 版本上复现了其中的症状两条——见下面标 ★ 的行。）

- ⚠️ **WT 1.24 把*所有*窗口放在同一个进程里。** 于是
  `Get-Process WindowsTerminal | Where-Object { $_.MainWindowHandle -ne 0 }` **恒等于 1**——
  开几个窗口都只数出 1 个。**要数窗口必须 `EnumWindows` 枚举顶层窗口**。
  > 这个坑真的害过人：用 `MainWindowHandle` 数出"始终 1 个窗口"，于是得出
  > "标签页本来就是好的、报的 bug 复现不了"——**结论完全反了**。凡是"窗口数量"类断言，
  > 先确认计数方法本身是对的。
- ✅ `-w <名字>`：**不存在就用这个名字新建一个窗口；存在就往里加标签页**（自愈）。
  §2.11 二·1 的 `-w cxt` 靠的就是这条。
- ★ ✅ `-w 0` / `-w last` = **最近使用过的**窗口。**cxt 实测踩到**：三次 `cxt run`
  一个窗口都没新开，三个标签页全部落进**用户当时正在用的 Claude Code 窗口**。
- ✅ `-w -1` / `-w new` = **总是新窗口**。
- ★★ ✅ **`--title` 会被标签页里跑的程序用 OSC 2 覆盖**，只有 `new-tab` **之后**的
  `--suppressApplicationTitle` 能钉住它。**cxt 实测踩到**：`cxt run --print` 里 `--title`
  明明给了 `cxt:relay-cxt · client-a`，标签页上显示的却是光秃秃的 `client-a`——
  `cxt:` 前缀与 token 名全被 codex 的 OSC 2 冲掉了。
  **A/B 实测（2026-10-18）**：拿一个只做两件事的夹具当 `codexBin`——① 把自己的环境落盘，
  ② 往 stdout 写 `ESC ] 0 ; BARE-NAME-FROM-APP BEL`（就是 codex 盖标题用的那个序列）：
  - 基线（同一条 wt 命令，**只少** `--suppressApplicationTitle`）→ 窗口标题变成 `BARE-NAME-FROM-APP`
  - 经 `cxt run`（带该 flag）→ 标题稳在 `cxt:default · codex`

  ⇒ 这条不是"文档说应该这样"，是**本机 A/B 出来的**。
  ★ 同一个夹具顺带把 §2.6 的净化也验了（**这是那节的现场证据**）：父 shell 里 export 的
  `CODEX_SESSION_ID` / `CODEX_THREAD_ID` / `CODEX_SQLITE_HOME` / `CXT_TOKEN_OTHER`
  在标签页里**一个都不在**，而 `PATH` 在内的 95 个继承变量照旧，注入项（`CODEX_HOME`、
  `CXT_TOKEN_DEFAULT`）盖在最上面。**夹具当 `codexBin` 是个通用手法**：
  它让"spawn 出去的环境"变成可落盘、可 diff 的事实，不必去猜。
  ★ 顺带验了 tab 模式的多开：连跑三次 `cxt run` → **一个**窗口、**三个**标签页。
- ⚠️ **合成 `WM_CLOSE` / `WM_SYSCOMMAND(SC_CLOSE)` 关不掉多标签页的 WT 窗口**：它会弹一个
  **渲染在窗口内部**的确认框（"是否要关闭所有标签页?"）。那个框**不是独立 hwnd**
  （不是 `#32770`），所以 `EnumWindows` 看不见、`PostMessage` 也点不到——只能靠 UI Automation
  （`InvokePattern`）去点。写"自动关窗口"的脚本时别踩。
- 🔧 **枚举标签页**用 UI Automation：`Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes`
  → 找 `RootElement` 下 `ClassNameProperty = 'CASCADIA_HOSTING_WINDOW_CLASS'` 的窗口
  → 在其 `Descendants` 里取 `ControlTypeProperty = [System.Windows.Automation.ControlType]::TabItem`。
  本节几条 ★ 事实就是这样取到的（`WINDOW: ◐ … / TAB: client-a`）。
  ⚠️ **`Add-Type` 与类型字面量不能写在同一个 `.ps1` 里**：PowerShell 会**先把整个脚本文件
  编译一遍**再执行，于是 `[System.Windows.Automation.AutomationElement]::RootElement`
  在编译期就报 `Unable to find type`——哪怕上一行的 `Add-Type` 看起来"已经加载了"。
  解法：把 `Add-Type` 留在**调用方**（交互式会话/`-Command`），脚本文件里只写类型字面量。

### 7.15 本机开发环境事实（影响实现与测试，非 Codex 语义）

- 🟢 **`python` 在本机是 Microsoft Store 占位存根**（`...\WindowsApps\python.exe`），
  执行**直接 exit 49 且无任何输出**——不是报错，是静默失败，极易误判为"脚本有问题"。
  **真解释器是 `py`**（`C:\Windows\py.exe`，Python 3.12.3）。
  ⚠️ 本项目是 Node 的（§4.3 零依赖），所以只影响**测试脚本**；但排查时别被骗。
  ⇒ 它和 §7.14⑤ 的 `wt.exe` 是**同一种东西**（`WindowsApps` 里的应用别名）。
  想知道"本机到底装了什么"，用 `where`（Windows 自带），别信 `existsSync`。
- 🟢 `node` v24.16.0；`git` 在 `C:\Program Files\Git\cmd\git.exe`；
  终端为 **Windows Terminal**（`WT_SESSION` 存在），与 §2.11 的首选一致。
- 🟢 `codex` 由 npm 全局安装：包根 `...\npm\node_modules\@openai\codex`，
  原生二进制在其 `node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`（约 341 MB）。
  ⇒ **二进制就在本地，字符串可用 `strings` 式提取**——本次回归靠它拿到了
  §7.3 的警告原文与信任写入格式。**下次遇到"文档没写"的问题，先挖二进制。**
- 🟢 Codex **自带 `rg.exe`**（`runtime.search` 检查项报 `search provider = bundled`），不依赖系统 ripgrep。

---

### 7.17 面板（全屏 TUI + 网页控制台）的 Windows 事实（🔵 **整节待真机复现**，2026-10-18 立）

**这节是 §2.14 九的依据；M8–M10 是 §2.14 十 的依据。⚠️ 与 §7 其余条目不同：
下面没有一条在本机跑过**——它们来自 Node/libuv 的既有行为与 Windows 控制台的既有实测，一律标 🔵。
`node scripts/verify-ui-real.mjs`（§6.3 手工验第 ③ 件）就是为这张表写的：
**跑完把标记改成 🟢 / 🔴，标 🔴 的连带改代码**（右列写着改哪一块）。
M8–M9 暂时没有脚本（W1–W6 里的两条，见 §4.5），所以**它们只能是 🔵，别写成 🟢**。

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
| M3 | WT 1.24 下 `─`（U+2500，UAX #11 的 **Ambiguous**）实测占几列 | **不阻塞开工**，只决定将来要不要提供 unicode 字形可选项。§2.14 五"边框只用 ASCII"的理由**不依赖这条**（那理由是"我们无法决定用户的宽度设置"） |
| M4 | `ESC [ 6 n`（CPR，光标位置报告）在 WT/ConPTY 下**有没有应答** | 探针作废，只剩目测尺子 |
| M5 | raw mode 下方向键到达的是 **`ESC [ A`**，不是扫描码 | **整个 `ui/keys.js` 的解码方案作废**——这是最坏情况，得改走别的输入通道 |
| M6 | `stdout.on('resize')` 在 WT 里可靠 | 加 250 ms 轮询兜底。**别改成"只轮询"**——resize 事件是即时的，轮询是它的补充 |
| M7 | `taskkill /F` 后**备用屏是否残留**、控制台**模式**是否自愈 | 残留 ⇒ `CXT_UI=plain` 从"逃生舱"**升级为默认**；README 必须写清"备用屏卡住怎么办" |
| M8 | ★ **Windows 上开 URL 必须走 `cmd /c start "" <url>`**——那个空 `""` 是 `start` 的**窗口标题位**：`start` 把第一个带引号的参数当标题，少了它就会把 URL 当成标题、**什么也不开**，而且**静默**。★ 另外 `start` 是 cmd 的**内建**命令，**不能** `spawn('start', …)` | 那条路开不出来 ⇒ 退回"用默认浏览器打开"（`shell: true` 或 `powershell Start-Process`）。**别改回"直接把 URL 丢给 `spawn`"**——那在 Windows 上从来没开出来过 |
| M9 | ★ **`localhost` 可能先解析到 `::1`**，而服务器绑的是 `127.0.0.1` ⇒ 用户看到「无法访问此网站」，**而地址栏里那个 URL 看着完全正常**（最难排查的一种失败） | 开的 URL 必须写 **`http://127.0.0.1:<port>/…`**，**不写 `localhost`**；而 `Host` 白名单**两种拼法都要收**（用户会手敲地址栏）。两个方向各一条测试（§2.14 十） |
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
  这是 §2.14 五"结构字符不许歧义"的直接理由。**别拿"用户可以去设置里关掉"当借口。**

**不变量（与上表无关，永远成立，有单测守着）：**

- **画帧走 `stdout.write()`、出屏走 `fs.writeSync(1, RESTORE)`，两者不可互换**（M1 + M2 合起来的结论）
- ⇒ **`RESTORE` 必须是纯 ASCII**（它走 `writeSync`，非 ASCII 必乱码）
- **面板不发 `OSC 0/2`**（不碰窗口标题）——§7.16 已记：标题是标签页的，程序去改它只会打架

---

## 八、开放问题（未决，动手前先问）

1. **受管区的边界会不会扩大？** 当前受管区只有 4 个键 + 1 个 section（§2.9）。
   随着 Codex 演进（比如出现新的身份类键），很可能需要扩。**扩之前必须先改本文件**，
   并想清楚"这个键为什么不能在 `-c` 里给"——`-c` 能给的，就不要进受管区。
2. **首次 onboarding**：空 profile 首次启动会走登录/信任确认，每 token 一次。
   v1 的处理：**让它走一遍**（不擅自写 Codex 的状态文件，守住 §3.1 铁律），
   由 `cxt doctor` 检测并提示"该 profile 尚未初始化，首次 run 会走一遍引导"。
   是否提供 `cxt run --seed` 从 `~/.codex/` 复制最小骨架跳过？——涉及铁律，**不要擅自实现**。
3. **信任矩阵的代价能不能降？**（§2.10）N×M 次确认是真实痛点。
   候选：`cxt trust --all`（已设计）；或在 `cxt token add` 时问一句"要不要从现有 profile 继承信任表"。
   后者等于跨 profile 复制信任决定——**安全语义要重新论证**，别顺手做。
4. **`codex features` 交叉验证**：§7.7 提到它能报"生效值 + 来源层"。
   是否把 `cxt doctor` 做成直接解析它的输出，从而**不依赖我们自己猜的优先级表**？
   ⚠️ **注意**：§7.2 的次序不确定**已在 2026-10-17 实测解决**（`-c` > 项目级 > profile > 用户级），
   所以这条不再是"解决次序问题的正解"，而降级为**可选的冗余校验**。
   仍值得做，理由是它能覆盖我们**没有实测过的那批键**（§7.2 只测了 `model` 一个键）。
4b. **`project_doc_max_bytes` 要不要进受管区？**（§7.11 的截断坑）
   现状：文档要求用户手工往 `$CODEX_HOME/config.toml` 加一行。但 cxt 本来就在写这个文件的受管区——
   顺手代写似乎更省事。**先别做**，理由有二：
   ① 它**不是身份键**，与受管区"只放身份"的定位（§2.9）不符，开了这个口子受管区会越滚越大；
   ② 更重要的——**它治不了根本问题**：cxt 是给任意仓库用的，某个用户的 `AGENTS.md` 有多大
   cxt 无从预知，代写一个固定值只是把截断点挪远。
   真正对的做法是 §5 设计的**检测+报告**（`cxt doctor` 报"将被截断到第 N 字节"），
   把决定权留给用户。**保持现状。**
5. **绑定粒度**：当前绑定只认路径前缀。是否需要支持 `git` 仓库维度（识别 `.git` 上溯，
   正好对齐 Codex 的 `project_root_markers`）或 `package.json` 名？——**本期不做**，
   先看真实使用反馈。注意 `.git` 维度与 Codex 的信任粒度天然对齐，可能更自然。
6. **同 token 多窗**：当前设计下共享同一 profile（等同原生多窗行为），符合预期；
   如需窗口级隔离再议。
7. **token 与 profile 是否解耦**：当前一 token 一 profile（§2.8），"换 key 续聊"靠
   `cxt token edit` 改现有 token 的凭证——profile 不动，历史与 `resume --last` 保留（§2.5）。
   另一种形态是允许两个 token **共享同一个 profile**，换 key 时不必覆盖原凭证、可来回切。
   代价是打破"一 token 一身份"的隔离不变量（§1.3 第 2 条）。**本期不做**，先看真实需求。
8. **macOS / Linux 的终端分支谁来验**：本机只有 Windows 可实测，
   macOS 的 `osascript` 字符串转义、Linux 的 `$TERMINAL` 探测顺序都只能静态审查。
   选项：(a) 发 alpha 时在 README 里明标"macOS/Linux 未实测，欢迎反馈"；
   (b) 找一个 macOS / Linux 环境实测后再发。**v1 先走 (a)**，并在
   `platform/macos.js` / `platform/linux.js` 顶部加 `// UNVERIFIED` 注释。
9. ~~**本机没有 Codex 这件事**~~ → ✅ **已完成（2026-10-17）**。
   已安装 **Codex CLI 0.163.0** 并跑完事实回归，结果全部回填 §7（置信度标记已升级为
   🟢/🟡/🔵 三档）。**回归结论摘要**：
   - ✅ **通过**：`CODEX_HOME` 隔离、`-c` 凭空建表（§7.8，原本最大的架构风险）、
     项目级禁区（§7.3）、优先级次序（§7.2）、`resume` 按 cwd 过滤（§7.6）
   - 🔴 **被推翻**：profile 机制整体改写（§7.4 —— 是独立文件，且**能**承载 provider 身份）
   - 🔴 **新增暗礁**：BOM 被拒、TOML 反斜杠转义、PowerShell 引号与编码（§7.14）
   - ⚠️ **仍待验证**：§7.5 `model_catalog_json` 的实际加载、§7.9 的 `[model_providers.<id>.auth]`
     子表、§7.12 那批"会打架的键"的真实行为——**这三块没在本次回归覆盖**。
   - ⚠️ 回归环境是 `CODEX_HOME=.codex-a` + 测试项目 `codex-test-proj`，
     **未登录**（`auth.credentials` 失败），所以所有验证都止步于"配置解析/生效性"，
     **没有一次真实的模型请求**。涉及"请求真的发出去了吗"的事实仍需联网+凭证才能确认。

9b. **Windows 上 `sandbox_mode = "workspace-write"` 到底有没有实际效果？**（§7.10）
   实测本机 `codex doctor` 恒报 `sandbox backend = disabled` + `filesystem sandbox = restricted`，
   即使项目级已生效。可能只是 doctor 的字段不反映配置，也可能是**Windows 后端真未启用**。
   这决定了 README 里"沙箱在 Windows 上的行为"该怎么写——**别在没验证前承诺任何沙箱语义**。
   验证方法：在 `workspace-write` 下让 Codex 跑一条越界写命令，看是否被拦。

9c. **`$CODEX_HOME/<name>.config.toml` 要不要升为 cxt 的一等特性？**（§7.4 的新发现）
   它能承载完整 provider 身份且不受项目级禁区约束。当前设计**不依赖**它（主通道是
   `CODEX_HOME` 隔离），但它是"同 token 内切换 model/端点"的天然载体。
   v1 先不做；若要加，需先想清楚它与 `cxt token` 的语义边界
   （**同一个 token 的两个 profile 文件 = 两个身份吗？凭证仍共享，答案不显然**）。
10. **与 `cmt` 是否合并成一个 CLI**：当前设计是 `cxt` 与 `cmt` 各自独立、配置目录分开
    （`~/.codex-multi-token/` vs `~/.claude-multi-token/`）。
    父目录名叫 `agent_multi_token`，暗示将来可能统一成 `amt run --agent codex|claude`。
    **本期不做**——先让两个工具各自把承重原语吃透，再谈抽象。
    ⚠️ 面板、池、在场层叠加之后，支持成本涨到了**二十三个文件**两份逐字拷贝
    （`ui/` 四件 + `platform/` 五件 + `web/` 三件 + `core/` 三件 + 八个共享测试）。
    这比 `parse-args.js` 那条"同源双份"的旧惯例**更严**——那份允许
    `CxtError` / `CmtError` 这类标识符分叉，而这四个文件**一个字节都不许差**
    （代价是它们的注释里不许出现工具名、环境变量名、契约父节号，见 §4.1）。**合并的诱惑会变大，但结论不变**——
    合并要解决的是"两个 CLI 的身份模型不同"（`slots` vs `models`、`settings.json` vs
    `config.toml`），而那与"TUI 内核长得一样"无关。
11. **模型清单要不要缓存？**（§2.14 六 / 十一）**拉取不缓存、结果登记**：每次进向导仍然现拉；
    拉到的清单写进 `resources.json`，只喂下拉候选与资源表，带 `url` + `fetchedAt`、可手动刷新。
    **"拿缓存代替现拉"仍然不做**——那会把"模型列表变了"变成幽灵 bug。登记是可见、有出处的，不等同。
12. **面板要不要管 `cmt` 的 `slots`？** v1 明确不做：面板只配 `models`，`slots` 仍走 `cmt slot set`。
    理由是 `fillDefaultSlots` 会拿 `models[0]` 填未设的槽，配 `models` 已覆盖绝大多数场景；
    把槽位塞进向导会让两个面板分叉。**将来要做，先回答"槽位在向导里长什么样"**
    （N 个槽 × 模型列表，一屏放不下，而面板没有滚动嵌套的预算）。
13. **面板的 `e`（改模型）只改"当前生效那一层"**（§2.14 二）。多层同时存在时
    （defaults + token + binding + 项目本地），用户想改的未必是生效那层——
    但层级选择器是 `cxt model set --global|--token|--path` 的活，面板只做"最常见的那一下"。
    若真实反馈说不够，**先看能不能在详情栏把"改哪层"显示清楚**，再谈加交互。
14. **`.cxt.json` 要不要支持 `extends` / 多份逐级合并？**（§2.13）**不做。**
    发现规则是"**最近的胜出**"而不是"逐级合并"——后者会让"这个仓库到底跑的是哪套配置"
    变成一个需要推理的问题，而 `cxt resolve` 存在的全部意义正是让这个问题**一眼可见**。
15. **两个控制台能同时跑，都写同一份 `config.json`**（§2.14 十）。
    原子写保证**不损坏**（§3.5），但**后写赢**——A 窗口里刚点的模型优先级可能被 B 窗口盖掉。
    这与 §3.5 那条"并发读-改-写不加锁"是**同一个已接受的风险**，控制台只是让它更容易撞上
    （浏览器窗口比终端窗口更容易忘在那儿）。**本期不加锁**；真要加，先想清楚
    "面板要不要显示'配置被别处改过'"——那比加锁更接近用户真正需要的东西。
16. **路径口令会出现在进程命令行里**（开浏览器那条 argv，§2.14 十）。
    **接受**：威胁模型是**跨源网页**，不是本机用户——能读本机进程命令行的人，
    本来就能读 `tokens/*.json`。给 `--no-open` 让口令不出终端，已经够"想避开的人能避开"。
    ⚠️ 别为了这个把口令改成"从 stdin 读"：那会把"敲一下就能用"这件事弄没，
    而那正是做控制台的全部理由。
17. **视图模型是一个无类型的跨项目接口**（§2.14 十）。
    `ui-web.js` 两个项目各写各的，喂给**逐字一致**的 `web/app.js`——
    ⇒ cmt 漏一个字段**只会在 cmt 坏**，而 cxt 全绿。**唯一的防线是两边的黄金形状断言**（§6.3），
    所以那个键集**要同时写进两份契约**：它是接口的一部分，不是实现细节。
    ⚠️ 与之相连的一条边界：**`slots` 不许进控制台**（第 12 条）。一旦进了，
    `src/web/index.html` 就得分叉，逐字一致纪律**当场崩**。
18. ★ **会话在场层的 pid 复用**（§2.16 二）：Windows 的 pid 会被快速复用，一个 `dead` 的旧会话
    可能因为 pid 恰好被别的进程占用而被报成 `live`。本期接受（`cxt sessions` 是概览、不是审计凭证）；
    要精确需比对进程启动时间，先不引入平台专用的进程查询。
    同一节还记着两条边界：**agent 间的自动投递/自动回复**不在 v1（需自动执行体，本工具不内置，§2.16 六）；
    **跨工具总线（cxt↔cmt）**同样不做（与第 10 条同一边界）。
