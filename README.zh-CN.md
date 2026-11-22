# agent-multi-token

> **状态：已归档（2026 年 11 月）。** 本项目停止开发。以 MIT 协议原样发布，供参考设计与代码。
> 没有维护、没有路线图，也不保证仍适配当前版本的 Claude Code / Codex CLI。
> 请把它当作一份**带可执行证据的设计文档**来读。

两个零依赖的 Node CLI，把 AI 编码助手的**一份全局配置**变成**按路径的独立身份**：

| | [`claude code/`](claude%20code/) | [`codex/`](codex/) |
|---|---|---|
| 命令 | **`cmt`** | **`cxt`** |
| npm 包 | `claude-multi-token` | `codex-multi-token` |
| 包装对象 | Claude Code CLI | Codex CLI |
| 隔离原语 | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` |
| 运行时根目录 | `~/.claude-multi-token/` | `~/.codex-multi-token/` |
| 架构契约 | [`CLAUDE.md`](claude%20code/CLAUDE.md) | [`AGENTS.md`](codex/AGENTS.md) |
| 使用手册 | [EN](claude%20code/README.md) · [中文](claude%20code/README.zh-CN.md) | [EN](codex/README.md) · [中文](codex/README.zh-CN.md) |

English: [README.md](README.md)

**这份文档是什么。** 两个工具的**总设计文档**：框架结构、逻辑体系，以及它们为什么长这样。
具体用法、旗标、排错在各项目自己的 README；不可违背的规则在各项目的契约里。建议阅读顺序：

1. 本文件 —— 共享设计；
2. `claude code/README.md` / `codex/README.md` —— 命令面与坑；
3. `CLAUDE.md` / `AGENTS.md` —— 权威规格，包括本文省略的部分。

---

## 快速上手

**前提：先有 agent 本体。** `cmt` / `cxt` 是**启动器**不是安装器——不装、不更新、也不配置
Claude Code / Codex。先把它装上，**开一个新终端**，确认 `claude --version` / `codex --version`
能跑。确切命令在各项目 README（[cmt 第 0 步](claude%20code/README.zh-CN.md#第-0-步先装-claude-code)、
[cxt 第 0 步](codex/README.zh-CN.md#第-0-步先装-codex-cli)）。

```bash
# 1. 从检出目录装两个 CLI —— Node ≥ 18，零依赖，无构建步骤
#    （两个包都没发布到 npm，见第 9 章）
cd "claude code" && npm install -g .    # 得到 `cmt`
cd ../codex      && npm install -g .    # 得到 `cxt`

# 2. 描述一个身份，把一个目录绑给它，在那个目录里启动
cmt token add relay-a --token 'sk-...' --base-url https://api.deepseek.com/anthropic
cmt model set --token relay-a 'deepseek-flash[1m]:Flash 1M'
cmt bind D:/work/client-a --token relay-a

cd D:/work/client-a
cmt resolve        # 四要素，每一项都标了来自哪一层
cmt run            # 或者裸 `cmt` —— 开网页控制台
```

`cxt` 是同样五步——端点差一处（Codex 要 `.../v1`），另外多一步 `cxt trust <路径>`，
把 Codex 启动时会问的「这个项目可信吗」提前答掉。

**不装也能试：** `node "claude code/bin/cmt.js" --help` 直接从检出目录跑。

**要验证的是隔离，不只是「窗口开起来了」。** 加第二个 token、绑第二个目录，两边各跑一次
`resolve`：token、端点、**profile 目录**三者都必须不同。那个「不同」才是产品本身（§1）；
一个窗口能开，证明不了太多。

---

## 目录

- [快速上手](#快速上手)
- [1. 问题](#1-问题)
- [2. 一套设计，两个目标](#2-一套设计两个目标)
- [3. 框架结构](#3-框架结构)
  - [3.1 四层，一个方向](#31-四层一个方向)
  - [3.2 模块地图](#32-模块地图)
  - [3.3 共享内核：23 个逐字节一致的文件](#33-共享内核23-个逐字节一致的文件)
  - [3.4 仓库布局](#34-仓库布局)
- [4. 逻辑体系](#4-逻辑体系)
  - [4.1 身份：四要素，各自带来源](#41-身份四要素各自带来源)
  - [4.2 配置：四层，一次合并](#42-配置四层一次合并)
  - [4.3 模型：有序优先级，不是故障切换](#43-模型有序优先级不是故障切换)
  - [4.4 启动前的两道闸](#44-启动前的两道闸)
  - [4.5 启动链：run 交给 exec](#45-启动链run-交给-exec)
  - [4.6 会话标记清洗](#46-会话标记清洗)
  - [4.7 隔离：一把 token 一个 profile](#47-隔离一把-token-一个-profile)
  - [4.8 在场层：会话注册表](#48-在场层会话注册表)
  - [4.9 信箱：消息是惰性数据](#49-信箱消息是惰性数据)
  - [4.10 注意力：面板说「需要你」的东西](#410-注意力面板说需要你的东西)
  - [4.11 令牌池：一层覆盖，不是第二份凭据库](#411-令牌池一层覆盖不是第二份凭据库)
  - [4.12 两个前端，一个 reducer](#412-两个前端一个-reducer)
  - [4.13 用量与成本](#413-用量与成本)
- [5. 两个工具刻意的差异](#5-两个工具刻意的差异)
- [6. 命令面](#6-命令面)
- [7. 安全边界](#7-安全边界)
- [8. 测试](#8-测试)
- [9. 安装与首次运行](#9-安装与首次运行)
- [10. 已知限制与坑](#10-已知限制与坑)
- [11. 平台说明](#11-平台说明)
- [12. 许可证](#12-许可证)

---

## 1. 问题

每个 AI 编码助手在每台机器上只有**一份**全局配置。Claude Code 认一套 `ANTHROPIC_*` 环境量；
Codex 认一个 `$CODEX_HOME/config.toml`。于是「项目 A 走 relay A、项目 B 走 relay B，而且同时开」
就退化成：要么手改全局文件，要么每换一次目录就重新 export 一片变量 —— 而最后设置的那个，
在所有目录里都生效。

```bash
# 手工流程，每换一个项目重来一遍
export ANTHROPIC_BASE_URL=https://relay.example.test
export ANTHROPIC_AUTH_TOKEN=...            # 只属于这个项目的 key
export ANTHROPIC_MODEL=model-a
```

`cmt` 与 `cxt` 把它换成**解析**：你在某个目录里运行命令，这个目录该用的 token / 端点 / 模型
就被选好了，而且**每个值都能说出自己来自哪一层**。

```bash
cmt run            # 在 D:/work/client-a  → token relay-a、model-a、https://a.example.test
cmt run            # 在 D:/work/client-b  → token relay-b、model-b、https://b.example.test
```

### 唯一承重的那个想法：会话隔离

配置切换器已经是一片拥挤的品类 —— [cc-switch](https://github.com/farion1231/cc-switch)
（[ccswitch.io](https://ccswitch.io/zh/)）与
[api-key-manager](https://github.com/pikecode/api-key-manager) 是其中两个。切换器的单位是
**整机配置**：它决定「下一次启动读哪一份身份」。按定义，同一时刻只有一个身份在用，
而助手那边始终只有一个配置目录。

这里的想法是反过来的那一个 —— **把隔离做成会话的属性** —— 本文几乎所有东西都是它的推论：

- 隔离原语（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`）指向 `profiles/<token>/`，
  于是配置、登录态、会话历史永远不会碰面（§4.7）；
- 身份在会话**启动之前**选定，并贯穿它的一生 —— 会话内不切换、不轮询、不做负载均衡
  （§4.1、§4.3）；
- 拿到哪个身份是**你在哪跑**的属性，由路径解析出来，不是一个全局开关（§4.2）；
- 会话一旦成为一等对象，就自然长出注册表、信箱与「需要你」清单 ——
  全是文件式的，全归包装器所有（§4.8–§4.10）。

邻居们在另一些方向上走得更深，而这边是刻意不去的：管理助手自己的会话与状态，
以及在助手**内部**给每个会话配不同的 LLM 配置。那两条都意味着 hook 或重新实现助手，
而契约明令禁止（§7）—— 一个只注入环境变量的包装器没有理由去做。**切换是配置变更，
隔离是状态边界。** 这个仓库里其余的一切 —— 两个前端、令牌池、信箱 —— 都是围着那条边界的脚手架。

---

## 2. 一套设计，两个目标

两个项目不是互相分叉，而是**同一套设计的两次实现**，对着两个不同的宿主，并且刻意让各自的
领域层形状保持一致：

| 共享概念 | 为什么共享 |
|---|---|
| **四要素** —— `cwd` / `token` / `baseUrl` / `model` | 一次会话四者缺一不可。缺任何一个都拒绝启动，**并指出缺的是哪个**。 |
| **每个解析值都带来源** | `resolve` 必须能回答「这个目录为什么用了这把 token」—— 所以每个值都记录它来自哪一层。 |
| **两道启动闸** | ① 四要素齐全；② 没有未展开的 `${...}`。两者都抛错，都不是警告 —— 交互式 TUI 一启动就把警告盖掉了。 |
| **用环境变量做隔离** | 一个环境变量把助手指向按 token 分目录的 profile。全部技巧就这一句。 |
| **凭据只以进程环境存在** | 不内联进启动脚本，不落第二份明文到磁盘。 |
| **分层配置，右者优先** | 全局默认 ← token ← 路径绑定 ← 项目本地文件，命令行旗标再压在最后做一次性覆盖。 |
| **有序模型优先级** | `models[0]` 是默认值；后面是显式的、由人推动的备选栈。 |
| **两个前端，一个 reducer** | 全屏 TUI 与本地网页控制台驱动**同一个**状态机。 |
| **在场层与信箱** | 一个文件式会话注册表、一个文件式收件箱，都归包装器所有，都能被 `cmt`/`cxt` 与面板读取。 |
| **零运行时依赖** | 只用 `node:` 内置模块。没有构建步骤，发布出的 tarball 就是源码。 |

### 产品不变式（两边一致）

1. **一会话一 token。** 不轮询、不做负载均衡、不会话内自动切换。
2. **彻底隔离。** 不同 token 互相看不到对方的配置、登录态、历史。
3. **分层且可解释。** 任何一层都能覆盖下层，且每个值能说出自己在哪一层。
4. **工具永不替用户行动。** 消息只有在人要求时才会被 agent 读到；工具不自动回复、不自动转发、不自动拉起任何东西。

### 非目标（两边一致）

- ❌ 不是中转 / 代理实现。它只负责指向一个。
- ❌ 不加密存储的 token —— 就是明文 JSON，文档里明说。
- ❌ 不修改、不 hook 被包装的助手。
- ❌ 没有外部 GUI 服务。（两边各自带**自己的**两个前端 —— 见下文。这不是一回事。）
- ❌ **零 npm 运行时依赖**，永远。只用 `node:` 内置模块。

---

## 3. 框架结构

### 3.1 四层，一个方向

两个项目用同一套分层。**箭头比目录名重要**：

```
bin/            argv → cli/                     只做 shebang 转发，不含逻辑
  │
  ▼
cli/            解析 · 调 core · 调 platform · 渲染
  │                │
  ▼                ▼
core/  ◀────────  platform/                      core 收到 platform，从不 import 它
纯规则            唯一知道宿主的一层
```

| 层 | 允许 | 禁止 |
|---|---|---|
| `bin/` | 转发到 `cli/main.js` | 任何判断、任何 I/O |
| `cli/` | 解析参数、编排、经 core 读写、渲染 | 拥有领域规则 |
| `core/` | 纯领域逻辑；`store.js` 是**唯一**的 fs 缝 | `process.env`、`process.platform`、`os.homedir()`、`spawn`、`node:http` |
| `platform/` | 具体 OS、终端、文件系统、网络 | 知道工具的业务规则 |

三个文件证明边界是真的：

- `platform/serve-web.js` 是唯一 import `node:http` 的文件。
- `cli/ui/term.js` 是 `cli/ui/` 下唯一碰 stdin/stdout 的文件。
- `platform/pid.js` 是唯一调用 `process.kill` 的文件。

`core/` 靠注入拿到平台事实（`{ ok, now, rand, ... }`），所以领域层测试不需要 mock Node 就是确定性的。

### 3.2 模块地图

两棵树是同一副骨架加上宿主专属件。标 **cxt+** 的是 `codex/` 独有：

```
claude code/  (cmt)                         codex/  (cxt)
├── bin/cmt.js                              ├── bin/cxt.js
├── src/
│   ├── core/                               │   ├── core/
│   │   ├── paths · schema · validate       │   │   ├── (同)
│   │   ├── store            ← fs 缝        │   │   ├── (同)
│   │   ├── resolve · bindings              │   │   ├── (同)
│   │   ├── models · models-endpoint        │   │   ├── (同)
│   │   ├── project-config · project-state  │   │   ├── (同)
│   │   ├── resources · pool · sheet        │   │   ├── (同)
│   │   ├── sessions · usage · prices       │   │   ├── (同)
│   │   ├── launch-script · seed · errors   │   │   ├── (同)
│   │   │                                   │   │   ├── catalog      ← cxt+（codex config.toml 的 model）
│   │   │                                   │   │   ├── trust        ← cxt+（信任表）
│   │   │                                   │   │   ├── toml-splice  ← cxt+（行级编辑器）
│   │   │                                   │   │   ├── toml-value   ← cxt+
│   │   │                                   │   │   └── doctor       ← cxt+（托管区检查）
│   ├── cli/                                │   ├── cli/
│   │   ├── main · help · parse-args        │   │   ├── (同)
│   │   ├── format · arg-path · target      │   │   ├── (同)
│   │   ├── session · resume · sessions     │   │   ├── (同)
│   │   ├── pool-pick · pool-store          │   │   ├── (同)
│   │   ├── pool-usage · preflight          │   │   ├── (同)
│   │   ├── price-table · probe             │   │   ├── (同)
│   │   ├── usage-sources · pick · types    │   │   ├── (同)
│   │   ├── claude-bin                      │   │   ├── codex-bin
│   │   ├── commands/                       │   │   ├── commands/
│   │   │   ├── ls · resolve · run · exec   │   │   │   ├── (同)
│   │   │   ├── token · bind · model · slot │   │   │   ├── token · bind · model
│   │   │   ├── pool · doctor · profile     │   │   │   ├── pool · doctor · profile
│   │   │   ├── usage · ui · ui-web         │   │   │   ├── (同)
│   │   │   ├── sessions · msg · resume     │   │   │   ├── (同)
│   │   │   │                               │   │   │   ├── trust        ← cxt+
│   │   │   │                               │   │   │   └── (无 slot —— Codex 没有别名槽)
│   │   │                                   │   │   ├── state-edit     ← cxt+
│   │   └── ui/{app,keys,render,term}.js    │   │   └── ui/{app,keys,render,term}.js
│   ├── platform/                           │   ├── platform/
│   │   ├── index · windows · macos · linux │   │   ├── (同)
│   │   ├── find-executable                 │   │   ├── (同)
│   │   ├── fetch-models · open-browser     │   │   ├── (同)
│   │   ├── open-path · serve-web           │   │   ├── (同)
│   │   ├── redis · pid                     │   │   ├── (同)
│   │   │                                   │   │   ├── resolve-terminal   ← cxt+
│   │   │                                   │   │   ├── spawn-terminal     ← cxt+
│   │   │                                   │   │   └── spawn-foreground   ← cxt+
│   └── web/{index.html,app.js,style.css}   │   └── web/{index.html,app.js,style.css}
├── tests/                                  ├── tests/
├── scripts/                                ├── scripts/
├── CLAUDE.md                               ├── AGENTS.md
└── README.md / README.zh-CN.md             └── README.md / README.zh-CN.md
```

两条承重的约定：

- **命令文件只渲染，不做决定。** `cli/commands/*.js` 把参数接到 core、把结果排版。规则住在 `core/`。
- **面板是同一套命令面，不是第二份实现。** `ui.js` 与 `ui-web.js` 调的是 CLI 调的那批会话/池/token 函数。

### 3.3 共享内核：23 个逐字节一致的文件

两个都叫 `resolve.js` 的文件那是分叉。两个都叫 `core/sessions.js` 的文件那是**契约**：
「什么算一个活着的会话」必须只有一个定义，否则两边会在测试全绿的同时慢慢说不一样的话。

二十三个文件在两边各存一份，且**必须逐字节一致**：

```
src/cli/ui/{app,keys,render,term}.js                  面板内核 + reducer
src/platform/{serve-web,open-browser,open-path}.js    本地 HTTP、浏览器、文件管理器
src/web/{index.html,app.js,style.css}                 网页控制台本体
src/core/{pool,sheet,sessions}.js                     池逻辑、表格导入、在场层
src/platform/{redis,pid}.js                           RESP2 客户端、进程存活探测
tests/{serve-web,open-browser,open-path,pool,
       sheet,redis,sessions,pid}.test.js              它们的守卫
```

`tests/shared-files.test.js` 用 `Buffer.equals()` 比字节 —— 不用字符串相等，那会放过 BOM 和换行符
漂移 —— 并且在兄弟项目不在检出里时**显著地跳过**，而不是静默通过。

这条约束强加的要求：共享文件里**不出现工具名、不出现环境变量名、不出现父节号**。工具名从视图模型传进来；
环境变量名由调用方解析；契约引用按节名而非编号。否则一个项目的副本放到另一个项目里就是错的。

### 3.4 仓库布局

```
agent-multi-token/
├── README.md / README.zh-CN.md     ← 本设计文档（EN / 中文）
├── LICENSE                         ← MIT
├── .gitattributes                  ← 默认 LF；.cmd 用 CRLF；.sh 用 LF
├── .gitignore                      ← 运行时目录、密钥、test_resource/ 默认拒绝
├── claude code/                    ← cmt（bin、src、tests、scripts、CLAUDE.md、README ×2）
├── codex/                          ← cxt（bin、src、tests、scripts、AGENTS.md、README ×2）
└── test_resource/                  ← 可选的联调笔记与示例夹具
    ├── README.md                   ← 进仓库：wire API 结论 + Windows 陷阱
    ├── tokens.example.json         ← 进仓库：假 key，三种池状态
    ├── endpoints.example.json      ← 进仓库：占位端点 + 探测形状
    └── tokens.json / endpoints.json / probe*.py   ← 被忽略，只在本机，永不提交
```

`test_resource/` 是**默认拒绝**：一切都被忽略，只有 `README.md` 和 `*.example.json` 用显式 `!`
规则放回来。往里加文件不需要改 `.gitignore` —— 被挡住就是默认，这份摩擦是故意的。进仓库的文件里
没有任何真实 key 或内网地址；如果你在本机留着真实夹具，它们就留在本机。

---

## 4. 逻辑体系

整个产品就是一个环。下面每一节都是这张图的细节：

```
cwd ──解析──▶ 四要素 + 来源
                  │
                  ▼
           两道闸（齐了吗？展开完了吗？）
                  │
                  ▼
        cmt run ──拉起终端──▶ cmt exec
                                  │
                   清掉继承的会话标记 │
                   注入本次身份      ▼
                              spawn 助手
                                  │
          ┌───────────────────────┴───────────────────────┐
          ▼                       ▼                       ▼
   meta.json（在场）        inbox/（信箱）            接管 stdout
          │
   live → ended / dead ──▶ sessions · recentSessions · attention · resume
```

### 4.1 身份：四要素，各自带来源

一次会话由四个值定义：

```
cwd      助手在哪里跑
token    用哪把凭据（因此用哪个 profile）
baseUrl  请求发往哪里
model    助手默认请求哪个模型
```

解析对每个字段独立走层。结果不是一个值，而是 `{ value, source }` —— 这样 `resolve` 才能回答
出错时唯一重要的问题：

```bash
cmt resolve            # token relay-a（来源：绑定 D:/work/client-a）· model model-a（来源：token）
```

来源不是装饰。没有它，「这个窗口为什么用错了 key」除了手工翻遍每个配置文件之外无解。

### 4.2 配置：四层，一次合并

```
默认值（全局）  ←  token  ←  路径绑定  ←  项目本地文件
                                        （.cmt.json / .cxt.json）

            …… 而命令行旗标在一次调用里压过以上四层。
```

解析对每个字段自上而下走，结果记录哪一层胜出。`--model` 与 `--url` 不是第五层 —— 它们是一次调用的
意图，最后应用。

合并语义**按字段种类**不同，这份不对称是刻意的：

| 种类 | 规则 | 为什么 |
|---|---|---|
| `baseUrl` / `authToken` / `models` / `slots` | **整值替换** | 这些是一个连贯的选择。半个端点配半个端点的另一半不是配置。 |
| `env` | **逐键合并** | 互相独立的逃生阀变量。 |
| `claudeArgs` | **拼接**，低层在前 | 互相独立的开关；后者在 argv 解析里胜出。 |

两条规则比看起来更重要：

- **`env` 里的 `""`（空串）意味着*删除*，不是*注入空值*。** Windows 上空的进程环境变量就等于删除；
  POSIX 上它是一个真实的空值。一份配置不能在两个平台上意味着两件事 —— 所以 `""` 永远进
  「从继承环境里移除」的集合。
- **`models: []`（显式空）≠ `models` 缺省。** 缺省是「继承」；显式空是「不注入模型，用助手自己的默认」
  —— 因此也**必须移除继承来的模型覆盖**，否则「默认」会静默地变成「父会话的模型」。

项目本地文件（`.cmt.json`、`.cxt.json`）是第四层，而且**被刻意限制**：它可以点名一个 token、设置
模型/env/参数，但**不能携带凭据或 baseUrl**。一个能把你 key 改发到自己端点的克隆仓库是攻击面，
不是便利。代价换来一个特性：这些文件不含秘密，因此可以安全提交。发现方式是从 `cwd` 向上找到最近的
一个；`--config <path>` 跳过发现、直接点名。

### 4.3 模型：有序优先级，不是故障切换

```
models[0]   = 本次会话的默认
models[1..] = 候选，[0] 挂了由人提升上来
```

别名槽（`opus` / `sonnet` / `haiku` / `fable` / `subagent`，仅 cmt）映射到宿主的别名变量。任何没有
声明的槽都**用 `models[0]` 补齐** —— 否则用户一敲 `/model`，就会去请求一个中转不提供的别名。显式
`null` 意味着「不注入这个槽」，同时也移除继承来的变量。

> **优先级不是故障切换。** 会话内自动回退不存在。`--fallback-model` 链（Claude Code）只在 `--print`
> 模式下生效；交互式会话就是跑 `models[0]`。支持的工作流是两条命令：
>
> ```bash
> cmt model next     # 轮换：下一个候选成为 models[0]
> cmt run -c         # 新窗口，接着刚才断掉的对话
> ```
>
> `cxt model next` 做同样的事。轮换写进你指定的那一层配置，所以下一次启动 —— 和下一个窗口 —— 看到的就是新顺序。

只有一种自动行为，而且它**不是**故障切换：**启动前探测**。spawn 之前，工具可能发一条只读的
`GET {baseUrl}/models`，2 秒超时，取返回清单里实际存在的第一个模型。

| 情况 | 行为 |
|---|---|
| `models[0]` 在清单里 | 按配置启动，**什么都不说** |
| `models[0]` 不在、`models[k]` 在 | **仅本次**用 `models[k]`，stderr 一行 `⚠`，**什么都不写** |
| 一个都不匹配 | 按配置启动，一行说明 |
| 端点不可达 / 没有 `/models` | **静默**，按配置启动 —— 内网端点这是常态 |

不让它变成别的东西的边界：**只做一次**、**只走真实启动路径**（`--print` 诊断永不触网）、**永不**写
配置/资源/profile，可以用 `defaults.preflight: false` 关掉。

### 4.4 启动前的两道闸

两道都是硬拒绝，不是警告。在交互式 TUI 启动前打出的警告，是没人会看到的警告。

1. **完整性。** 四要素必须全部解析出来。错误信息指出缺的是哪一个，并打印能修好它的命令
   （`cmt bind ...`、`cmt token add ...`）。
2. **没有未展开的引用。** 凭据或 URL 里的 `${VAR}` 在解析时展开。如果展不开，就拒绝启动 ——
   工具绝不把字面量 `${VAR}` 当作 key 交给助手。

退出码是接口的一部分：**0** 成功，**1** 用户错误（token 名不存在、旗标冲突、缺要素），
**2** 环境错误（助手不在 `PATH`、终端探测失败、目录不可写）。脚本能区分「你要求错了」和
「这台机器缺东西」。

### 4.5 启动链：run 交给 exec

两个工具都把启动拆成**两个进程**，而这次拆分就是安全设计：

```
cmt run relay-a
  ├─ 1. 解析四要素（记录来源）
  ├─ 2. 完整性闸 → 拒绝，指出缺什么
  ├─ 3. 未展开引用闸 → 拒绝（绝不内联字面量 ${VAR}）
  ├─ 4. 探测终端，用 argv 数组拉起
  └─ 5. 什么都不写。无状态。

新窗口：  cmt exec relay-a --model <id>
  ├─ buildSessionEnv() = 清会话标记 → 删 unset → 应用注入
  ├─ 把会话记进 meta.json（在场层）
  ├─（可选）启动前探测 —— 只读 GET /models
  └─ spawn(claude, argv, { env, stdio: 'inherit' })   ← 唯一的 spawn 点
```

三条后果值得明说：

1. **启动脚本里永远没有 token。** 它只调用 `<abs node> <abs cmt> exec ...`。自包含的脚本就是 key 在
   磁盘上的又一份明文，永远存在。
2. **没有任何 shell 解析参数。** `argv` 一路保持数组直到 `spawn` —— 这就是为什么中文 Windows
   `cmd.exe`（OEM 代码页）里的中文路径不会坏。启动脚本只是给「只接受命令字符串」的终端用的**兜底**。
3. **`cmt run` 拒绝 `--token-value`** —— 这个值必须跨越一次进程边界，而所有跨越方式都要把它写到某个
   地方。一次性凭据走 `exec`（已经在窗口里）；可复用的走 `token add`。（`cxt run` 接受它，因为 Codex
   的启动器用法不同，但同样的偏好成立：用 `token add`。）

外层进程从不等待窗口，内层进程是唯一知道会话生命周期的那个。这就是为什么在场记录由 `exec` 写，而不是 `run`。

### 4.6 会话标记清洗

新终端**不是**干净环境：Windows Terminal 会把调用者的整个进程环境灌进新标签页。如果你是在一个 agent
会话里启动的，新会话就继承了父会话的身份 —— 包括 `CLAUDE_CODE_CHILD_SESSION=1`，它会把对话记录
**关掉**。

所以最终环境永远是算出来的，绝不盲目继承：

```
继承的环境
  → 清掉会话标记          （cmt：9 个 Claude 名单 · cxt：13 个 CODEX_* 名单）
  → 删除 unset 里的一切   （未选中的鉴权变量、显式空的 models/slots、env ""）
  → 应用注入值            （压过 unset，永远）
  → 加上本次会话 id       （CMT_SESSION_ID / CXT_SESSION_ID，给信箱用）
```

`cxt` 还会清掉**整个外来的 `CXT_TOKEN_*` 家族**，只保留本次会话注入的那一个 —— 否则父会话的旧凭据
仍然对子进程可见。会话 id 变量本身也在清洗名单上，所以嵌套窗口无法继承父会话的信箱身份。

不变式：**结果不能取决于你从哪里调用命令。** 有测试断言：同一份解析，在干净基底与彻底污染基底
下产出的环境逐字节相同。

### 4.7 隔离：一把 token 一个 profile

```
profiles/<token>/     ← profile；来自隔离变量
profiles/_default/    ← 保留名，代表「没有 token 身份」
```

profile 按 **token** 命名，绝不按目录。一把 token 用在五个目录，就共享一个 profile；助手在里面按目录
slug 区分历史。因此：

- `-c` / `--continue` 的作用域是**配置目录 + 当前目录** —— 不是 key 的值。
- **给已有 token 换 key 保留历史**：`cmt token edit <name> --token <new>`。切到*另一把 token* 就是换
  身份，`-c` 找不到那段对话。轮换 key 用前者，不要用后者。

不要把 `profiles/<token>/sessions/`（助手自己的对话历史）和下面说的包装器 `sessions/<id>/` 混为一谈。
它们共享一个词，别无其他；包装器从不读写助手的历史。

### 4.8 在场层：会话注册表

`run` 拉起终端就撒手。唯一横跨会话生命周期的进程是 `exec`，所以 `exec` 是在场记录的**唯一写者**：

```
<运行时根>/sessions/<id>/
├── meta.json                  {v, id, token, cwd, pid, startedAt, endedAt, exitCode, model}
├── inbox/<ms>-<rand>.json     未读
└── read/<ms>-<rand>.json      已读（rename 进来）
```

- **id 形状**：`<profile>-<base36 时间戳>-<pid>` —— 可读、可排序、每次启动唯一。
- **启动写一次、退出写一次**：`recordSessionStart()` / `recordSessionEnd()`。写失败时会话照常继续，
  只打一行警告 —— 在场层绝不能阻塞真实工作。
- **永远没有 argv**：`meta.json` 是九个字段的白名单。这在两处强制 —— 写者不传 argv，
  `normalizeSessionMeta()` 丢掉其他一切。原因很具体：`cxt exec --token-value` 就是明文 key，一次
  「顺手把命令行也记下来」的改动就会把它落到磁盘。
- **三态，读时计算**：
  - `live` —— 没有 `endedAt`，且 `process.kill(pid, 0)` 成功（EPERM 算活着：进程在，只是发不了信号）。
  - `ended` —— 有 `endedAt`。
  - `dead` —— 没有 `endedAt` 但进程已不在（崩溃、`kill -9`、关窗口）。
- **已知限制**：pid 复用会把 `dead` 报成 `live`。这是给人的概览，不是审计日志；契约里就是这么写的。

```bash
cmt sessions                 # 表格：状态 · 会话 · token · 未读 · 开始时间 · cwd
cmt sessions --json          # 机器可读
cmt sessions prune [--older-than 30d] [--force]
```

`prune` 删旧的 `ended`/`dead` 记录，从不删 `live`；有未读消息的会话，不加 `--force` 就拒绝删除。
`resume <id|前缀>` 把已关闭或崩溃的窗口找回来：同一个 token、同一个 `cwd`、在新窗口里带 `-c`。
它**拒绝 live 会话** —— 那个窗口还开着，切过去就是了。

面板从同一个注册表派生两个列表：

- `sessions[]` —— 只有 live，联上池状态与未读数。
- `recentSessions[]` —— **24 小时**内的 `ended`/`dead`，最多 **5** 条，最新在前。会话条上的「恢复」
  按钮就是用它建的。

### 4.9 信箱：消息是惰性数据

```
cmt msg send <id|--token <t>|--all> [--type info|action-request] "正文"
cmt msg inbox [--session <id>] [--peek] [--json]
cmt msg gc [--older-than 7d]
```

一条消息就是一个 JSON 文件：

```json
{ "v": 1, "id": "…", "ts": "…", "from": "human", "to": "<会话 id>",
  "type": "info", "body": "…" }
```

- **投递就是一个文件。** `msg send` 往 `<会话>/inbox/` 写一个文件。每个目标各拿一份；没有共享队列，
  没有广播守护进程。
- **已读就是一次 rename。** `msg inbox`（不带 `--peek`）把每条消息从 `inbox/` 挪到同目录的 `read/`
  —— 原子、没有中间态、没有第二本「读过什么」的账。`--peek` 只看不动。
- **只有 live 会话收信。** `send` 的目标是 `state === 'live'`；前缀必须恰好匹配一个 live 会话，
  「没有目标」是响亮的 exit-1，不是静默的 no-op。
- **发送者身份来自环境。** `exec` 注入 `CMT_SESSION_ID` / `CXT_SESSION_ID`。如果这个值缺失、非法，
  或者对应的 meta 记录不存在，`from` 就是 `"human"` —— 伪造的值冒充不了会话。
- **工具永不因消息行动。** 这是中心规则：消息是数据，不是命令。`type: info | action-request` 是给
  读者的标注，都不授予执行权。没有自动转发、没有自动回复、没有 agent 循环。唯一的送达机制是人告诉
  agent「跑 `cmt msg inbox`」—— 这也正是信箱不可能来回乒乓的原因。
- **保留期。** `msg gc` 默认删除超过 7 天的消息，`inbox/` 与 `read/` 都清。解析不了的时间戳或未来
  时间戳一律不动，不去猜。
- **消息是明文 JSON。** 不要往里粘秘密；帮助文本就是这么写的。

### 4.10 注意力：面板说「需要你」的东西

面板不让浏览器决定哪里有问题。服务器算出一个短列表，**最多 5 行**，每行带一个页面无需理解即可渲染的
动作描述：

```json
{ "kind": "mail", "severity": "high",
  "title": "relay-a 有 2 条未读（窗口已关）",
  "detail": "最旧一条的首行…",
  "actions": [{ "label": "恢复", "op": "resume-session", "args": { "session": "…" } },
              { "label": "全部已读", "op": "msg-read-all", "args": { "session": "…" } }] }
```

三类，按优先级排序：

| 类别 | 何时 | 严重度 |
|---|---|---|
| `token-bad` | **live** 会话的 token 变成 `no_quota` 或 `invalid` | high |
| `mail` | 会话有未读消息；**已关闭**的排在 live 之前 | high / normal |
| `exit-fail` | 近期关闭、退出码非 0（且没有未读） | normal |

动作复用已有操作（`check-token`、`msg-read-all`、`resume-session`），所以新增一种信号只改服务器。
空列表就是健康，渲染成折叠块 —— 面板从不显示空的「需要处理」区。

### 4.11 令牌池：一层覆盖，不是第二份凭据库

`pool.json` 装的是已存在 token 的额度状态与用量。它**永远不含 key**：

```
tokens/<name>.json   ← 明文凭据唯一的家
pool.json            ← 状态、checkedAt、用量、模型；按 token 名联表
```

六种状态，一套词汇：`ok` · `no_quota` · `invalid` · `net_fail` · `other` · `unknown`。
`pool check` 对每把 key 发一条**最小真实请求**（会花一点钱）并归类响应 —— 402 是 `no_quota`，
401 是 `invalid`，body 里的额度字样压过状态码。

新鲜度按状态算，不是一个全局 TTL：

| 状态 | 多久后重探 |
|---|---|
| `ok` / `other` / `net_fail` | 300 秒（可配） |
| `no_quota` | 跨月（本地日历） |
| `invalid` | 24 小时 |
| `unknown` | 立刻 |

选 token（`--pool`，或解析不出来时自动填）是排序，不是会话内负载均衡：

- 策略：最少用量（总用量），平局时轮询。
- **被 live 会话占着的 token 排到末尾 —— 不是排除。** 用一把 token 开两个窗口是允许的；默认只是
  避开别人正在用的那把。
- **`-c` 受 `lastPick[cwd]` 保护。** 如果 `--pool` 会挑一把不同于「写下这段被续对话的那把」的 token，
  工具拒绝，而不是悄悄换身份开一个全新会话。续会话不是换身份的时刻。
- 一次挑选，整段会话钉住。永不进行会话内切换。

Redis 是可选**镜像**，不是家：`pool sync --redis` 写过去；`pool pull --redis` 读回来。
`pool list` / `check` / `status` / `reset` 和所有启动路径从不连接 Redis。没有 Redis，一切照常。

### 4.12 两个前端，一个 reducer

两个工具都不逼你背旗标。各自带：

- **`cmt ui` / `cxt ui`** —— 就在你已有的终端里开全屏 TUI（方向键、粘贴安全、严格按显示宽度断行所以
  中文不会把布局撑坏、退出必恢复终端）。
- **在 TTY 上裸敲命令** —— **本地网页控制台**：原生 `<select>`、复选框、按钮，由你的浏览器渲染，
  对面的服务器仍然是 CLI 进程本身。

```
commands/ui.js        ← 业务：副作用、结果事件、视图模型
  ├─ commands/ui-web.js   ← 桥（HTTP）
  │     └─ platform/serve-web.js  ← 只绑 127.0.0.1、随机端口、路径令牌
  └─ cli/ui/{app,keys,render,term}.js  ← TUI 呈现
```

共享的是**全部业务逻辑**：副作用词汇表、reducer、视图模型。不共享的是**呈现**。不存在第二条写配置的
路径。浏览器专属操作（`set-status`、`set-model`、`check-token`、`set-pool-status`、`sync-usage`、
`resume-session`、`msg-read-all`、`open-path` 等）在共享 reducer 看到之前就被拦截；其余一切都变成
TUI 会产生的同一个事件。

**视图模型**是两个项目共享的冻结键集：一个构建打开的面板，能被另一个项目的测试读懂。它带
`items`、`tokens`、`resources`、`poolStatuses`、`sessions`、`recentSessions`、`attention`、
`statuses`、`wizard`、`notice` …… 而且**永远不带明文 key**。线上只走打码值（`sk-****abcd`）与
`secretLength`；唯一的例外是用户在新 token 表单里自己的输入。

**威胁模型** —— 控制台会写配置文件、会接收明文 key，所以它按本地服务来建，而不是开发服务器：
只绑 `127.0.0.1` · 随机端口 · 32 位十六进制**路径令牌**，`timingSafeEqual` 比较（主防线）· 每个请求
校验 `Host` 白名单（DNS rebinding）· POST 必须带 `Origin`（CSRF）· 从不发 CORS 头 · 严格 CSP ·
读取过程中就强制的 64 KiB 体积上限 · 按方法白名单 · API `no-store` · 30 分钟空闲退出 · SIGINT 清理 ·
请求日志从不含 body。每一项都有一个「移除该控制就必须变红」的测试。

### 4.13 用量与成本

两个工具都读取助手本来就在写的对话记录文件，报告 token 用量；价格走三级链：

```
手写 prices.json（结算价）
  > 端点广告的价格（随 /models 拉取）
    > 未知 → 渲染成「—」，绝不假装是 $0
```

手写价永远赢，因为网关广告的价格不该静默覆盖你实际付的价。用量从本地文件重算，按 size + mtime 增量
缓存；池的聚合等于各 token 明细之和，作为不变式被断言。

```bash
cmt usage --days 7 --by model
cxt usage --days 7 --by token --json
```

---

## 5. 两个工具刻意的差异

以上全部共享。下面这些差异来自宿主，不来自口味。

### `cmt`：什么都不写

Claude Code 完全通过**环境变量**配置。所以 `cmt` 只有一条铁律：**永不写助手的配置文件。**
这让工具不会在 Claude Code 配置格式演进时随之崩掉。

只有一个例外，而且是可选的，默认关闭：`defaults.seed`（`off` | `onboarding` | `full`）可以**补充**
`profiles/<token>/.claude.json` 里缺失的键，让新 profile 免弹窗启动。它是只增不改的（已有的
`hasTrustDialogAccepted: false` 绝不翻转）、幂等的、备份一次的，并且**永不复制用户真实的
`~/.claude.json`**。`settings.json` 被永久排除。

### `cxt`：一个有两个作者的文件

Codex 并非一切都能从环境变量来。它必须在 `$CODEX_HOME/config.toml` 里找到 provider —— 而这个文件
**Codex 自己也在写**（`[projects.*]` 信任记录）。所以这个文件有两个作者，`cxt` 只编辑其中一块
**托管区**：

```toml
model = 'model-a'
model_provider = 'cxt-relay-a'

[model_providers.cxt-relay-a]
name = 'relay-a'
base_url = 'https://a.example.test/v1'
env_key = 'CXT_TOKEN_RELAY_A'      # 只是名字；值在 spawn 时注入
wire_api = 'responses'
```

四条规则让它安全：只碰托管的键 · 永不删 `[projects.*]` · 永不删文件 · 只备份一次
（`config.toml.cxt.bak`）。编辑器是**行级拼接器**，不是 TOML 解析器 —— 解析再序列化会丢掉注释与键序，
也就是每次运行都把另一个作者的工作毁掉。缺失的托管键插在**第一个节头之前**，插在节头之后就静默变成了
那一节的键。

> 凭据仍然不进文件。`env_key` 只存变量**名**；`cxt` 把值注入子进程环境。
> `experimental_bearer_token` 会把 key 内联，给它第二个家、把泄露面翻倍。

### 信任（仅 cxt）

Codex 在 `config.toml` 的 `[projects.'<path>']` 里按项目路径记信任。`cxt trust` 用**操作系统原样
拼写**的路径写这条记录（Windows 反斜杠保留，TOML 字面量字符串）。正斜杠写法不会报错 —— 它静默地
永远匹配不上，这是整个工具里最容易犯的错。`--untrust` 写 `"untrusted"` 而不是删记录；`--all` 标记
一把 token 的所有绑定；`trust ls` 只读。

### 终端落点

`cmt run` 默认在名为 `cmt` 的**窗口里开标签页**，这样多把 token 共用一窗而标题各异。`cxt run` 默认开
**新窗口**。两者都接受 `--window` / `--tab`，对单次启动覆盖 `defaults.terminalMode`。

### wire API 与 `baseUrl`

两个宿主说不同的协议，所以期望不同的 URL：

| | 协议 | 端点 | 你配的 `baseUrl` |
|---|---|---|---|
| `cmt` | Anthropic Messages | `/v1/messages` | **不带** `/v1` |
| `cxt` | OpenAI Responses | `/v1/responses` | **要带** `/v1` |

两边都自己拼 `/v1/...`，写反了就是 `/v1/v1/...` 加 404。

而 `cxt` 的 **`models[0]` 必须是 OpenAI 系的模型**：Codex ≥ 0.59 只接受
`wire_api = "responses"`，而很多中转只为自己的 OpenAI 渠道实现 `/v1/responses`。一个模型可以出现在
`/models` 清单里、`/v1/chat/completions` 也通，**仍然不能被 `cxt` 用**。配 token 之前先跑探测。

---

## 6. 命令面

完整列表见 `cmt --help` / `cxt --help` 与各自的 README。形状是：

| 关注点 | 命令 | 备注 |
|---|---|---|
| token | `token add / show / edit / rm`、`ls` | `show` 永远打码；`edit` 换 key 不丢历史 |
| 绑定 | `bind`、`bind ls`、`bind rm` | 归一化路径上的最长前缀匹配 |
| 解析 | `resolve`、`doctor` | `resolve` 打印每个值**及其来源层** |
| 模型 | `model ls / set / use / next / clear` | `cmt` 另有 `slot`；`cxt` 没有（无别名槽） |
| 启动 | `run`、`exec` | `run` 开终端；`exec` 是窗口内的那一半 |
| 会话 | `sessions`、`sessions prune`、`resume` | 三态、未读保护、按 id/前缀恢复 |
| 信箱 | `msg send / inbox / gc` | 惰性文件；已读是 inbox → read 的移动 |
| 令牌池 | `pool list / import / check / status / reset / sync / pull` | `import` 吃 CSV 或 xlsx |
| 用量 | `usage [--days] [--by token\|project\|model\|day]` | 读本地对话记录；价格分层 |
| 前端 | `ui`、`ui --web`、裸命令 | TUI 与网页控制台共享一个 reducer |
| profile | `profile path`、`profile ls` | 目录就是隔离变量 |
| 信任 | `cxt trust …` | 仅 `cxt` |

通用旗标：`--json`（机器输出）、`--config <path>`（点名项目本地文件，跳过向上发现）、`--cwd`、
`--model`、`--url`、`--print`（只显示环境与命令，不启动）、`--`（其余参数转交助手）。

---

## 7. 安全边界

- **一把 token 在磁盘上只有一个家**：`~/.{claude,codex}-multi-token/tokens/<name>.json`。
  它不加密。请保护好你的家目录；不要把这类文件同步到共享存储。
- **启动脚本不含凭据。** `cmt run` 拒绝 `--token-value`，也拒绝带 `user:pass@` 的 `--url`。
  `cxt` 只把环境变量*名*写进 `config.toml`。
- **`cmt` 从不写助手的 `settings.json`**；它唯一可能碰的文件是 `.claude.json`，只增不改、可选、默认关闭。
- **`cxt` 只编辑 `config.toml` 的托管区**，从不移除 `[projects.*]`。标记块以外的一切属于 Codex 或用户。
- **项目本地文件不能携带 key 或端点**，所以克隆来的仓库无法偷你的 key —— 它只能*点名*一个已经在你家目录里的 token。
- **网页控制台只绑回环地址**，带每次运行随机生成的路径令牌；局域网不可达，也不是服务 —— 进程结束它就没了。
- **在场层与信箱不含任何秘密**：`meta.json` 是九字段白名单；消息是用户自己写的明文文本，帮助文本告诫不要粘 key。
- **永不提交真实 key 或内网地址。** `test_resource/` 默认拒绝，进仓库的文件里只有示例。测试夹具一律假 key；
  源码卫生测试遇到 `sk-…` 形状的字符串会让整个套件失败。

---

## 8. 测试

```bash
cd "claude code" && npm test     # = node --test
cd codex         && npm test     # = node --test
```

没有测试框架，没有开发依赖。套件覆盖：

- **纯逻辑**（`core/`）：路径归一化（NFC、大小写规则、分隔符）、最长前缀绑定、解析顺序与来源、
  环境合并与清洗、模型轮换/提升、schema 校验、启动脚本生成规则、池的新鲜度与排序、会话状态分类、
  消息规整。
- **端到端**，用一个**假助手二进制**把它收到的内容原样写回 —— argv、env、cwd —— 包括在 Windows 上
  穿过真实的 `.cmd` shim、退出码传递、两道闸的拒绝路径。
- **在场层与信箱**，对沙箱家目录：启动 → live，正常退出 → ended，pid 不可达 → dead，inbox → read
  原子移动，`--peek` 不动文件，prune 遇未读拒绝除非 `--force`，`resume` 拒绝 live 会话。
- **终端/面板**：恢复序列的字节级断言、跨视口尺寸的尺寸不变式、分段按键输入、粘贴模式吞掉控制字符。
- **安全**：控制台的每一项控制、路径/`Host`/`Origin` 检查、API 只返回裸视图模型、跨项目接口的
  黄金键集、以及 23 个共享文件。
- **源码卫生**（`tests/source-hygiene.test.js`）：没有 `sk-…` 形状的秘密、没有 RFC 2606 占位符或保留
  TLD 之外的 `https://` 主机、没有裸控制字符、没有 BOM。错误信息只打印前 3 个字符和长度 ——
  守卫不能变成下一个泄露点。

契约禁止把易变数字（测试计数、哈希）写进断言；守卫断言的是**结构与关系**，不是它们的快照。

---

## 9. 安装与首次运行

五条命令的走通路径在文首：[快速上手](#快速上手)。本节是它周围的安装细节。

**Node ≥ 18。** 没有构建步骤，也没有依赖：两个包的 `dependencies` 都是 `{}`，所有 import 都是
`node:` 内置模块 —— 没有东西要审计，也没有东西会因为供应链坏掉。

**两个包都没发布到 npm。** 本项目在发布之前就归档了，所以 `npm install -g claude-multi-token`
会返回 404。从检出目录安装：

```bash
cd "claude code" && npm install -g .    # → `cmt`
cd ../codex      && npm install -g .    # → `cxt`
```

完全不想安装：

```bash
node "claude code/bin/cmt.js" --help
node codex/bin/cxt.js --help
```

**它往哪里写。** `~/.claude-multi-token/` 与 `~/.codex-multi-token/` —— `config.json`、
`tokens/*.json`（明文，见第 7 章）、`profiles/<token>/`（agent 自己的状态，一个身份一份）、
`sessions/`。除这两棵树和你亲手绑定的目录之外，它不碰别处。

**彻底卸载：**

```bash
npm uninstall -g claude-multi-token codex-multi-token
rm -rf ~/.claude-multi-token ~/.codex-multi-token    # Windows 用 Remove-Item -Recurse
```

agent 真实的 `~/.claude/` 与 `~/.codex/` 从未被写过（见第 7 章与 §4.7），所以删掉这两个目录
就等于撤销了 `cmt` / `cxt` 做过的全部事情。

各项目 README 覆盖完整命令面、向导、面板与坑。各项目的契约（`CLAUDE.md` / `AGENTS.md`）是权威规格
—— 改行为之前先读它，并且**先改契约，再改代码**。

---

## 10. 已知限制与坑

- **已归档。** 被包装的助手在变，这份代码不变。依赖 Claude Code / Codex 内部实现的行为，请先核对契约。
- **pid 复用。** pid 被回收时，`dead` 会话可能被报成 `live`。在场层是概览，不是审计日志。
- **信件投递要靠人。** 工具从不通知 agent；必须有人告诉它跑 `msg inbox`。这是刻意的安全属性，不是缺失功能。
- **`${VAR}` 支持不对称。** `cmt` 在 `authToken` 与 `baseUrl` 里都接受环境引用。`cxt` **只接受
  `authToken`** 里的 —— `baseUrl` / `catalog` / `codexBin` / `cwd` 里出现 `${` 会在加载时被拒，而且
  因为所有 token 文件是急切加载的，**一个坏文件会让那个家目录里所有会加载配置的命令 exit 1**
  （包括 `ls`）。刻意如此、已记录，而且只会咬你一次。
- **会话标记家族按工具不同。** `cmt` 清 Claude 的名单，`cxt` 清 Codex 的。不要假设一个工具的清洗
  覆盖另一个。
- **`--continue` 按 profile 且按目录。** 换 token 就丢了；用 `token edit` 换 key 则保留。
- **把 `models` 当故障切换是错的。** 它是有序偏好加手动提升栈。只有 `--print` 有真正的回退链，
  只有启动前探测会自动纠正 —— 一次，只读。
- **控制台并发。** 两个控制台可以同时写 `config.json`；原子写防止的是损坏，不是丢失更新。最后写者胜。
  单人 CLI 接受这个。
- **`cxt trust` 匹配的是路径写法，不是路径本身。** Windows 路径的正斜杠写法会被接受，然后静默地永不匹配；
  用原生写法。
- **`cxt -c` 不是 Codex 的 `-p`。** `cxt -c` 续对话；Codex 自己的 `-p` 是选 profile。两个旗标在不同
  的解析器里，意思不同。
- **macOS / Linux 未在真实终端里验证。** 适配器存在，并用注入的平台规则做了单测；没在真机上跑过的分支
  标了 `// UNVERIFIED`。

---

## 11. 平台说明

Windows 是主要、测试最多的平台（Windows Terminal、PowerShell、`cmd.exe`）。有几条硬碰硬换来的事实被
写进了两个项目，不可商量：

- **`.cmd` 文件全 ASCII。** 批处理文件里的中文路径会在 OEM 代码页上坏掉 —— **静默地坏**，而同一个路径
  走环境变量却完好。这就是为什么「argv 数组、不经 shell」是主启动路径，脚本只是兜底。
- **`.cmd` shim 经 `cmd.exe /c` 调用**（CVE-2024-27980）；在 shim 里，`ENDLOCAL` 必须用 `&` 串联，
  否则子进程的退出码被吞掉。
- **`wt.exe -w <name> new-tab`** 复用命名窗口。绝不用 `-w 0` / `-w last`（歧义），且
  `--suppressApplicationTitle` 必须放在 `--title` 之后，否则助手的标题会压过去。
- **数窗口要 `EnumWindows`**；`MainWindowHandle` 对整个进程只报 1。
- **`explorer.exe` 成功时返回退出码 1。**
- **控制台是 GBK**：打印模型回复里的 emoji 会抛 `UnicodeEncodeError` —— 请求其实成功了。需要的地方
  显式把 stdout 配成 UTF-8。

macOS 与 Linux 适配器存在，并用注入的平台规则做了单测，但真机终端验证目前只在 Windows 上做过；
那些分支标了 `// UNVERIFIED`。

---

## 12. 许可证

MIT —— 见 [LICENSE](LICENSE)。两个 npm 包声明同一协议。
