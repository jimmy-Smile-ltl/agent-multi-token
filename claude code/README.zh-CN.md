# claude-multi-token（`cmt`）

**一个会话，一个 token。**

[English →](./README.md)

> **状态：已归档（2026 年 11 月）。** 本项目停止开发。以 MIT 协议原样发布，供参考设计与代码。
> 没有维护、没有路线图，也不保证仍适配当前版本的 Claude Code。
> 请把它当作一份**带可执行证据的设计文档**来读。

把「一台电脑只有一套全局环境变量」变成「按路径解析的配置」：
`cmt run` 在哪个目录跑，就自动给新开的 Claude Code 会话套用那个目录该用的
token / apiUrl / model。

零运行时依赖，Node ≥ 18，Windows / macOS / Linux。

> **懒得读文档？** 在终端里裸敲 `cmt`——它开一个本地**网页控制台**：下拉列表和勾选框组成的
> 表单。选目录、输 token、拉模型清单，**一次写好两处配置**；模型优先级靠勾选 + `↑` `↓` 调序。
> 那个窗口是 `cmt` 自己的——只绑 `127.0.0.1`，别的机器访问不到。
> 更习惯终端？`cmt ui` 开全屏**面板**（方向键；SSH 下能用的是它）。非 TTY 时裸 `cmt` 退回
> 打印用法、**退出 0**，脚本一个字都不受影响。

---

## 它解决什么问题

你想同时开三个 Claude Code 会话，各接一个中转站 / 账号。
但环境变量只有一套：

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<你的 key>
export ANTHROPIC_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

A 项目的 key 和 B 项目的 key 抢同一个槽位。切项目就得手工重 export 一遍，
而且**根本没法让两个同时存在**。

`cmt` 把上面那坨变成**按路径解析的配置**：

```bash
cmt bind D:/work/client-a --token relay-a
cmt bind D:/work/client-b --token relay-b
cmt run            # 在 D:/work/client-a 里跑 → 开的会话接 relay-a
```

---

## 安装

### 第 0 步：先装 Claude Code

`cmt` 是**启动器**，不是安装器——它不装、不更新、也不配置 Claude Code 本体
（见「cmt 明确不做」）。所以第一步是让 `claude` 出现在 PATH 上：

```bash
# macOS / Linux / WSL —— 官方原生安装器（推荐）
curl -fsSL https://claude.ai/install.sh | bash

# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
```

或者用包管理器：

```bash
brew install --cask claude-code          # macOS / Linuxbrew
winget install Anthropic.ClaudeCode      # Windows
```

装完**开一个新终端**再验证——PATH 的变更不会进已经开着的窗口：

```bash
claude --version     # 期望形如 2.1.211 (Claude Code)
claude doctor        # 官方自检：安装健康度 / 设置文件校验
```

> 官方也提供 `npm install -g @anthropic-ai/claude-code`，但那条路声明要求 **Node ≥ 22**，
> 而 `cmt` 自己只要 Node ≥ 18——**两个要求不是一回事**。想省心就用上面的原生安装器：
> 装的是同一个原生二进制，且会后台自动更新。

`cmt` 找 `claude` 是**四档顺序**：`配置里的 claudeBin` → `PATH` → 常见安装位置
（原生安装器的 `~/.local/bin/`、Homebrew 的 `/opt/homebrew/bin/` 都在内）→ 都没有就
报错，退出码 2。命中 PATH 或常见位置时会把绝对路径**写回配置**，下次免探测。

`cmt doctor` 的「claude 可执行文件」一节会打印命中了哪一档、**以及 PATH 上的那个是谁**——
当你发现用的不是 PATH 那个时，这一节立刻告诉你为什么。

### 再装 cmt

**从检出目录装。** 这个包从未发布到 npm —— 项目先归档了 —— 所以
`npm install -g claude-multi-token` 会返回 404：

```bash
cd "claude code"        # 在仓库根目录
npm install -g .        # → `cmt`
```

或者完全不安装，直接跑：

```bash
node bin/cmt.js --help
```

**没有任何依赖要装**——`dependencies` 是 `{}`，全部走 `node:` 内置模块。
这个包的 `npm ls` 按构造就是空的。这是设计承诺不是巧合：
没有供应链风险、没有构建步骤、审计友好、`npx` 秒装。

需要 **Node ≥ 18**。Node 18.20 / 20.12+ 出于安全（CVE-2024-27980）会拒绝直接 `spawn`
一个 `.cmd`/`.bat`；`cmt` 两边都经 `cmd.exe /c` 调用，所以 18.x 早期版本也能跑——
不过新一点更省心。

---

## 使用指南

下面按**你实际想干的事**组织。每条命令的输出都是真机跑出来的，可以直接照抄。

### 场景 1：第一次用，先跑通一个 token

```bash
# 1. 描述一个 token（密钥 + 端点）
cmt token add relay-a --token 'sk-...' --base-url https://api.deepseek.com/anthropic

# 2. 给它一份模型优先级列表（第一个优先级最高）
cmt model set --token relay-a 'deepseek-flash[1m]:Flash 1M' deepseek-flash

# 3. 把一个目录绑到它
cmt bind D:/work/client-a --token relay-a

# 4. 看这个目录到底解析出什么 —— 排查第一招
cmt resolve D:/work/client-a

# 5. 启动
cmt run
```

第 4 步的输出值得盯一眼：四要素**每一项都标了来自哪一层**。

```
  绑定   D:/work/client-a
  token  relay-a
  来源   ← 路径绑定（D:/work/client-a）

四要素
  ✓ 本地路径  D:\work\client-a                    ← 当前目录（当前目录）
  ✓ token     sk-****1111                          ← token 自身（token relay-a）
  ✓ apiUrl    https://api.deepseek.com/anthropic   ← token 自身（token relay-a）
  ✓ model     deepseek-flash[1m]  (Flash 1M)   （另有 1 个候选）
                                                   ← token 自身（token relay-a）

将要注入
  CLAUDE_CONFIG_DIR               ~/.claude-multi-token/profiles/relay-a
  ANTHROPIC_AUTH_TOKEN            sk-****1111
  ANTHROPIC_BASE_URL              https://api.deepseek.com/anthropic
  ANTHROPIC_MODEL                 deepseek-flash[1m]
  ...
命令行
  claude --name cmt:relay-a
```

**密钥或内网端点不想落盘？** `--token` 与 `--base-url` 都接受整串环境变量引用：

```bash
cmt token add relay-a --token '${DEEPSEEK_API_KEY}' --base-url '${RELAY_BASE_URL}'
```

落盘的是引用本身，值在启动那一刻才从环境里取：

```json
{ "name": "relay-a", "authToken": "${DEEPSEEK_API_KEY}", "baseUrl": "${RELAY_BASE_URL}" }
```

引用**只认整串**（`"${A}"` ✅，`"sk-${A}"` ❌ 报错）。变量没设置时 `cmt` 会**报错退出**，
指名是哪个变量——绝不静默回退成字面量 `"${A}"`，那会变成一个恒被拒绝的假 token
（端点则是一个解析不出来的域名）。

### 场景 2：两个项目、两个 token（核心场景）

这是这个工具存在的理由。**一个会话一个 token，靠目录区分**：

```bash
cmt token add corp    --token '${CORP_API_KEY}' --base-url https://relay.example.com
cmt token add deepseek --token '${DEEPSEEK_API_KEY}'              --base-url https://api.deepseek.com/anthropic

cmt model set --token corp    DeepSeek-V4.1-Flash
cmt model set --token deepseek 'deepseek-flash[1m]:Flash 1M' deepseek-flash

cmt bind D:/work/client-a --token corp
cmt bind D:/work/client-b --token deepseek
```

`cmt ls` 看全貌——**注意每个 token 的模型来源是「自己的列表」还是「继承全局的」**：

```
token（共 2 个）

  corp
    cwd     （未设）
    models  DeepSeek-V4.1-Flash   ← 自己的列表
    apiUrl  https://relay.example.com

  deepseek
    cwd     （未设）
    models  deepseek-flash[1m] → deepseek-flash   ← 自己的列表
    apiUrl  https://api.deepseek.com/anthropic

  绑定 2 条（`cmt bind ls` 看详情）
```

然后在每个目录里各开一个会话——默认两个都落进同一个 `cmt` 窗口的两个标签页，
标题分别是 `cmt:corp · client-a` 与 `cmt:deepseek · client-b`：

```bash
cd D:/work/client-a && cmt run     # → 用 corp
cd D:/work/client-b && cmt run     # → 用 deepseek
```

**绑定是前缀匹配**，所以子目录自动继承父目录那条：

```bash
cmt bind D:/work --token corp          # 整个 D:/work 都用 corp
cmt bind D:/work/client-b --token deepseek   # 只有 client-b 覆盖成 deepseek
```

更长的前缀优先。`cmt bind ls` 列出全部，`cmt bind rm <路径>` 删一条。

### 场景 3：临时换 token / 换模型，不改配置

```bash
cmt run relay-b                 # 这一次用 relay-b，配置不动
cmt run --model deepseek-reasoner   # 这一次换模型（会提到列表首位）
cmt run --url https://other.example.com/anthropic
cmt run --cwd D:/work/client-a  # 用别的目录的配置开一个会话
cmt run --pick                  # 从模型列表里交互挑一个
```

这些开关**只影响这一次启动**，不写盘。想确认它到底会跑成什么样，加 `--print`：

```bash
cmt run --print
```

```
（--print：以下都不会真的执行）

四要素
  本地路径  D:\work\client-a                    ← 当前目录（当前目录）
  token     corp                                ← 路径绑定（D:/work/client-a）
  apiUrl    https://relay.example.com           ← token 自身（token corp）
  model     DeepSeek-V4.1-Flash                 ← token 自身（token corp）

将要注入的环境
  CLAUDE_CONFIG_DIR               ~/.claude-multi-token/profiles/corp
  ANTHROPIC_AUTH_TOKEN            sk-****abcd
  ANTHROPIC_BASE_URL              https://relay.example.com
  ANTHROPIC_MODEL                 DeepSeek-V4.1-Flash
  ANTHROPIC_DEFAULT_OPUS_MODEL    DeepSeek-V4.1-Flash
  ...
```

密钥永远是打码的（前 3 后 4）。**键名**匹配 `TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL`
的一律打码，所以在 `env` 逃生舱里塞别的密钥也不会漏。

### 场景 4：模型挂了 —— 两步切到下一个

> ⚠️ **「优先级」不等于自动故障转移。** Claude Code 的 `--fallback-model`
> **仅 `--print` 模式有效**，交互模式下模型挂了**不会**自己跳到下一个候选。

所以切换是人工的，`cmt` 把它做成正好两条命令：

```bash
cmt model next      # models[0] 移到末位，下一个候选升上来
cmt run -c          # 新标签页；claude -c 续上该目录刚才那次会话
```

- `cmt model next` 是**轮转**不是删除，反复切不会把候选耗光
- `cmt model use <id>` 直接把指定模型提到首位，其余保持相对顺序
- 两者都接受 `--global` / `--token <t>` / `--path <p>`，默认按当前目录

```
✓ 已提拔（路径绑定 D:\work\client-a）

  1. DeepSeek-V4.1   ← 本次会话的默认
  2. DeepSeek-V4.1-Flash

  ℹ 该路径原先继承的列表已**物化**成本地一份——`cmt resolve` 会把来源层标成「路径绑定」
```

「物化」是刻意的：本来是继承来的列表，你改了它，`cmt` 就**明写一份路径专属的**，
来源层随之从 `token` 变成 `binding`——变化显式可见，不做隐式魔法。
不想要了用 `cmt model clear --path <p>` 删掉，它会退回去继承。

### 场景 5：换 key，但**不丢会话历史**

`-c` 的作用域是**配置目录 + 当前目录**，与 token 值无关。
会话历史存在 `<配置目录>/projects/<cwd-slug>/`。

- ✅ 只改 `ANTHROPIC_AUTH_TOKEN`（配置目录不变）→ `-c` 依然回到原会话
- ❌ 改了 `CLAUDE_CONFIG_DIR` → 那是另一份历史，`-c` 找不到

在 `cmt` 里「一 token 一 profile」意味着**切 token 会连带换掉配置目录**，于是 `-c` 失效。
想换 key 又要续聊，正确做法是**改现有 token 的凭证**：

```bash
cmt token edit relay-a --token 'sk-新key'   # profile 不动 → 历史与 -c 全部保留
```

**别用「切到另一个 token」来做换 key**——那是换身份，不是换钥匙。

### 场景 6：确认「我这个会话到底用的哪个 token」

三重保险，从最快到最准：

**① 看标签页（或窗口）标题** —— `cmt run` 会把会话名写进标题：

```
cmt:corp · claude code
   ↑token      ↑目录末段
```

默认每个会话都在**同一个 `cmt` 窗口**里占一个标签页（见「平台支持」），
所以扫一眼标签栏就知道哪个 token、哪个项目在哪个标签页里。
`cmt run --window` 则让每个会话独占一个窗口，标题格式不变。

**② `cmt resolve`** —— 当前目录解析出的四要素**和每一项来自哪一层**：

```bash
cmt resolve            # 当前目录
cmt resolve D:/work/client-a
```

```
绑定   D:/work/client-a
token  corp
来源   ← 路径绑定（D:/work/client-a）

四要素
  ✓ 本地路径  D:\work\client-a                    ← 当前目录（当前目录）
  ✓ token     ${CORP_API_KEY}（已设置）                   ← token 自身（token corp）
  ✓ apiUrl    https://relay.example.com           ← token 自身（token corp）
  ✓ model     DeepSeek-V4.1-Flash                 ← token 自身（token corp）
```

**③ 会话里直接问环境** —— `cmt` 注的是真环境变量，会话内可见：

```bash
echo $env:CLAUDE_CONFIG_DIR     # PowerShell
```

### 场景 7：排查

**第一招永远是 `cmt resolve`。** 它把「看到的」和「跑起来的」绑成同一条路径
（`cmt resolve` 和 `cmt run` 走的是同一份装配代码），所以它显示什么，启动就是什么。

```bash
cmt doctor          # 本机自检：node / claude / 终端探测 / 四要素 / 绑定悬空 / 非 ASCII 路径
cmt doctor --cwd D:/work/client-a
```

`cmt doctor` **永远返回 0**——它是诊断工具不是闸门，CI 里跑它不该因为本机没装 claude 就红。

| 现象 | 先看这个 |
|------|---------|
| 报「四要素不完整，缺 N 项」 | `cmt resolve` —— 每项都标了来源层，缺在哪层一目了然 |
| 明明绑了却说「绑定（无）」 | `cmt bind ls` 对一下归一化串；`cmt resolve` 会提示"末段相同、整串不同"的近似绑定 |
| 模型不对 | `cmt model ls` —— 标了生效列表来自哪一层（自己的 / 继承的） |
| 想确认会不会真启动 | `cmt run --print` —— 一个字节都不执行 |
| 会话开了但 claude 报错 | `cmt doctor` 看 `claude` 探测那节；再看非 ASCII 路径警告 |

### 场景 8：用第三方模型端点

`cmt` 只负责把环境变量注入对，**端点能不能用是端点的事**。第三方 Anthropic 兼容端点
常见两种噪音，都不是 `cmt` 的问题：

- **`unrecognized_model`**：Claude Code 不认识你给的模型名，打个警告继续跑，功能正常。
- **`authMode` 确认框**：用 `ANTHROPIC_API_KEY`（`X-Api-Key` 头）而非
  `ANTHROPIC_AUTH_TOKEN`（`Authorization: Bearer`）时，交互模式会弹一次确认。
  `cmt` 的 `authMode` **默认就是 `"token"`** 正是为了避开这个框。
  端点确实只吃 `X-Api-Key` 时才改：`cmt token edit relay-a --auth-mode key`。

### 场景 9：不想记命令

```bash
cmt          # 在终端里裸敲——就是网页控制台
```

**网页控制台**是一个本地页面，由原生 `<select>` 下拉、勾选框和按钮组成——没有要记的参数，
也不用方向键。和下面的面板是同四个步骤，全在一页上：

| 步骤 | 你做什么 |
|---|---|
| 1 目录 | 敲一个路径，或者从下拉里挑一个；旁边的「复制」把框里的路径抄走，「打开」在文件管理器里打开它 |
| 2 身份 | 挑一个已有 token，或者敲名字 + 密钥新建一个 |
| 3 模型 | **勾你要的**；下方「已选」列表里每条带 `↑` / `↓` 调优先级，勾完点「下一步」 |
| 4 落点 | 看一眼，然后写入——全局 `config.json` 里一条绑定，**外加**那个目录里一份 `.cmt.json` |

**工作台：项目状态，以及「身份 ↔ 服务端地址」成对。** 整页是两栏——**左栏**按状态给你的项目
计数（点一档就是按它筛），**右栏**是一张项目表，每行最左边就是那个项目的状态下拉。

- **一个文件夹就是一个项目。** 给它一档状态（默认五档：未开始 / 进行中 / 受阻 / 已完成 / 失败），
  那一行的颜色跟着变。颜色是**命名色**，明暗模式各一套取值——所以换主题不会失真。
- **状态表由你改。**「管理状态…」能改名、换色、调顺序、增删（1–12 档）。**还有项目在用的状态
  删不掉**，它会告诉你哪些项目还在用。
- **状态单独一个文件**：`~/.claude-multi-token/projects.json`，不进 `config.json`（那份的 schema
  是严格的，多一个键旧版就整份拒载）。键是**归一化之后的**文件夹路径——`D:\work` 与 `d:/work/`
  是同一个项目。第一次标状态时才写盘；对话框底部印着完整路径，想手改也行。
- **身份与地址是一对，两个都是下拉。** 第 2 步显示选中身份自己的地址；换身份，地址跟着走；
  挑一个地址，身份跟着切过去。列表里没有的地址用「自定义…」自己敲——这是给"我们照顾不到的
  情况"留的口子。第 4 步的摘要里会多一行「服务端 → …」，写入时真的写回 `tokens/<名字>.json`
  ——**不会背着你改一个你没看着的字段**。
- **模型那一列是下拉，选一下就写。** 点开、挑一个，走的就是 `cmt model use <id>` 那条路——把
  选中的**提到首位**，其余保持相对顺序，写回这一项**生效的那一层**（项目本地 / 绑定 / token /
  全局默认）。选「（不声明）」= 把**那一层**的 `models` 键删掉，退回继承；选末尾的「多个模型…」
  进原来那个多选 / 排序 / 手敲面板——**一个控件都没删**，只是不必先点一个按钮才进得去；清单里
  没有的模型就在那个面板里手敲。原来那颗「改模型」按钮没了：它想做的事，下拉和「多个模型…」
  各管一半。
- **左栏顶上多一个「资源」视图。** 切过去是一张资源表，**每个 token 一行**：身份 · 服务端 ·
  模型优先级 · 绑定数 · 操作。
  - **身份那一格是 token 本身**：打码的密钥（`sk-****aaaa`，等宽字体）+ 一个**昵称**输入框。
    昵称存在 `tokens/<名字>.json` 的 `label` 里，中文、空格都行，**只用来展示**——不进
    profile 目录名、不进环境变量名、不进窗口标题。清空输入框 = 删掉这个键。
  - **模型优先级那一格点得开。** 点它弹一个对话框：`↑` / `↓` 调序、`×` 删掉、下面一行
    `datalist` 输入框加一个（拉到的清单就是候选，也可以手敲任意 id）。保存 = 写回该 token
    自己的 `models` 数组——**那个数组就是优先级**。列表清空 = 删掉这个键，回到继承；
    没声明过的 token 那格显示灰色的「继承」，显式清空的显示「（显式空）」。
  - **同一个网关的两个 token 可以一起改。** 对话框里勾上「同网关的 N 个 token 一并套用」，
    服务端自己按**生效的服务端地址**找出同组的 token（不信前端报的数），逐个写。已经统一
    的默认勾上；不勾就只改自己，那一行随即标「同网关不同」。
  - **表头有「＋ 添加 token」，空表也能就地开一条。** 输入名字、密钥（密码框，全程掩码）与
    可选的端点，保存后走的就是向导第 2 步那条写盘路径——校验、重名、空密钥都由它回一句话，
    **失败时一个字节都不写**。明文密钥只在这一次 POST 里过一趟，回执里永远只有打码值。
  - **`env` 也能在这张表里改。** 每行的「环境」与表头的「默认环境」各开一个对话框（一个 JSON
    文本框）：前者改**这个 token 自己那一层**的 `env`，后者改 `config.json` 的 `defaults.env`
    （所有 token 共享的兜底）。框里是**那一层自己写的原文**，不是四层合并之后的结果——合并
    发生在解析时。`JSON.parse` 的早反馈在页面上，真正的校验（`normalizeEnv`）在服务端：空键名、
    非字符串值都会被点名拒绝，**文件一个字节不动**。值 `""` 是有意义的——注入时**删掉继承来的
    那个变量**；存 `{}` = **删掉这个键**回到继承。成功的判据是**回执里的 `env` 与草稿一致**，
    不靠提示语。
  - 没拉过的行写「未拉取」，点「拉取」现问一次 `GET {baseUrl}/models`；页头的「全部拉取」
    并发问全部，回一句「拉取完成：N 成功 · M 失败」。拉到的清单登记在
    `~/.claude-multi-token/resources.json`（每条带 `url` 与 `fetchedAt`），于是模型下拉里除了
    你声明过的，还能看到服务端真有的那些。**改了某个 token 的服务端地址**，那一行会标
    「地址已变」——清单来自旧地址，按一下「拉取」就换新。这份登记是**看得见、可丢弃**的：
    坏了只退回空表，向导第 3 步仍然每次现拉，**绝不拿旧清单冒充新清单**。
  - **表头多一条概览，每行多一组「用量 · 花费」两列。** 概览（几个 token · 调用 · 输入 ·
    输出 · 花费 · 多久之前算的）加的就是表里那几行，**口径同源**；花费按三级取价：你的
    `prices.json` ＞ 拉取模型清单时端点自报的价 ＞ 没有价。一个模型都查不到价的行，花费写
    「—」，**绝不写 `$0`**；有模型没价时数字后面带 `+`，意思是"这只是下限"。
  - **「重算用量」按钮就是 `cmt pool sync`。** 它读本机 transcript（Claude Code 自己写的
    那份记账）重算整池，落盘 `pool.json` 后页面重新载入——命令行与页面因此看到同一个数。
    **它只算用量、不动状态**（要刷新状态请按「检测」）；一份记录都没找到时它会明说，
    不把旧数字留着充数。
  - **多数时候不必按它。** 打开面板、打开网页控制台、或跑一次 `cmt pool list`，都会先在
    **数字比 `usageSeconds`（默认 600 秒）旧**的时候顺手重算——600 秒这个窗口只管"读本机
    文件"，与探测额度的 300 秒刻意分开。重算也很便宜：**size 与 mtime 都没变**的文件直接从
    `pool-usage-cache.json` 取，所以真正被重读的只有你确实追加过内容的那几份。这份缓存只存
    每个文件的模型明细，**不存 `in` / `out` 合计**——合计永远是合并时现算的，"
    概览 = 明细之和"因此不可能漂。删掉缓存只丢速度、不丢准确度；`--force` 才是全部重读。

**它跑在哪，以及为什么别人访问不到。** `cmt` 起一个 `node:http` 服务，绑在 **`127.0.0.1`**
上——只绑回环，绝不 `0.0.0.0`——端口**随机**，而每个 URL 里都带着一个每次运行现生成的
**32 位 hex 路径口令**。不带它的请求拿到一个空 404（连"这个路径存在"都不说）；`Host` 或
`Origin` 不是这个服务的请求会被拒。没有配置文件、没有缓存、没有锁——端口和口令只在内存里，
随进程一起消失。

**三条退路**：「退出」按钮 · `Ctrl+C` · 空闲 30 分钟（它自己关掉，所以绝不会比你的终端活得久）。

**没有浏览器？** 控制台会打印 URL 并打开它，优先开一个 Chrome/Edge 的**应用窗口**（没有地址栏——
看着像个客户端，不像一个标签页），找不到就退回你的默认浏览器。两条都不行它会说出来，并把 URL
交给你。`--no-open` 只打印 URL、什么都不开，顺带让口令不进终端的回滚缓冲：

```bash
cmt ui --web --no-open   # 只打印 URL，不开任何窗口
```

#### 全屏面板（`cmt ui`）

**同一个 reducer，同样四个步骤——方向键代替鼠标。** 它除了一个终端什么都不需要，所以 SSH、
容器里、或者一台根本没有浏览器的机器上，能用的是它。

```
 当前目录                         │authToken: sk-****abcd        │模型 (2)
 agent_multi_token  → relay-a │baseUrl:   https://api.deep…  │▸ deepseek-flash[1m]
 (未绑定)              → relay-b │source:    路径绑定               │  deepseek-flash
 + 新建…                        │profile:   已建                 │
```

方向键选，**回车启动**（等价 `cmt run`，开新标签页）。★ 启动后**面板留在原地**并显示
「已启动 ✓」——所以你可以连着开好几个会话。

| 键 | 作用 |
|---|---|
| `↑` `↓` / `PgUp` `PgDn` / `Home` `End` | 移动光标 |
| `Enter` | 启动 |
| `n` | 新建向导（选目录 → 身份 → 模型 → 落点） |
| `e` / `d` | 改这一项生效那一层的模型 / 删掉这条绑定 |
| `r` / `q` | 重新读配置 / 退出 |

**左栏是「可启动项」，不是 token 列表**：当前目录、每条绑定、没被任何绑定引用的 token、
`+ 新建…`。面板要回答的问题是「**我要在哪开**」，token 只是答案的一部分。

**向导第 3 步会去拉 `GET {baseUrl}/models`。** 中转站常在内网、或者根本没实现这个端点，
所以拉不到时给三条出路：`[r]` 重试 · `[m]` 手敲 id · `[s]` 跳过。**拉不到不会卡死在这儿。**

**向导第 4 步一次写两处**：全局 `config.json` 加一条绑定，**并且**在那个目录里写一份
`.cmt.json`（见下）。于是那个目录从此"自带身份"——即使配置被拷到别的机器上。

> **终端被强杀后备用屏残留了？** Windows 上 `taskkill /F`、任务管理器、直接关窗口都是
> 无条件 `TerminateProcess`，**没有回调可以拦**，所以备用屏可能留在那儿。出路是
> `CMT_UI=plain cmt ui`——逐行输出、不进备用屏，同一份内容、同一套按键。见「坑」。

### 场景 10：让项目自己带着配置走

在项目根目录放一份 `.cmt.json`：

```json
{ "version": 1, "token": "relay-a", "models": [{ "id": "deepseek-flash[1m]" }] }
```

从那个目录（或它的任何子目录）启动，它就自动生效，**赢过路径绑定**。克隆一份仓库下来、
进目录、`cmt run`——身份对了，不用先想起来 `cmt bind`。

★ 这份文件**天生不含密钥**（`authToken` / `baseUrl` 一律禁止，见下），所以**可以安全提交进
仓库**。团队里每人只要 `cmt token add relay-a --token <自己的 key>`，其余照抄。

---

## 核心概念

### 四要素（缺一不可）

启动一个 Claude 会话需要**完整**的四项。缺任何一项 `cmt` 都拒绝启动，
并**指名缺的是哪一项**：

| 要素 | 字段 | 缺了会怎样 |
|------|------|-----------|
| 本地路径 | `cwd` | 不知道在哪跑 |
| token | `authToken`（+ `authMode`） | 无法认证 |
| apiUrl | `baseUrl` | 打不到端点 |
| model | `models[0]` | 不知道用哪个模型 |

### 配置解析级联

优先级**高 → 低**。每一项都能说出自己来自哪一层。

| 要素 | 解析顺序（左 = 优先级最高） |
|------|---------------------------|
| `cwd` | `--cwd` → token 的 `cwd` → 当前目录 |
| `token` | `--token` → 路径绑定 → `defaults.token` → 无 |
| `baseUrl` | `--url` → 绑定 → token → 全局默认 |
| `authToken` | `--token-value` → 绑定 → token → 全局默认 |
| `authMode` | `--auth-mode` → 绑定 → token → 全局默认 → 内置 `"token"` |
| `models` | 绑定 → token → 全局（**整体覆盖，不合并**） |
| `slots` | 绑定 → token → 全局（**整体覆盖**） |
| `env` | 全局 ← token ← 绑定（**按键合并**） |
| `claudeArgs` | 全局 + token（**拼接**，命令行 `--` 追加在最后） |
| `terminalMode` | `--window`/`--tab` → `defaults.terminalMode` → 内置 `"tab"` |

三条容易想当然的语义：

- **`--token` 是 token 的*名字*，`--token-value` 才是密钥本身。**
  前者选身份（进而选 profile 目录），后者改凭证。
  **`cmt run` 不接受 `--token-value`**——新终端里的 `cmt exec` 只能从命令行拿到这个值，
  而那条命令行要么写进 `launch.cmd`、要么留在终端 argv 里，两条都是凭证的**第二个落盘点**，
  正是"token 只有一个落盘点"的设计要避免的。一次性用 `cmt exec --token-value <v>`，
  要复用就 `cmt token add <name> --token <v>`。非密钥的 `--url` / `--auth-mode` **会**转发，
  而 `--url` 通常本来就写成 `${ENV_VAR}` 引用——引用跨得过进程边界，因为它不是密钥。
  **`cmt run --url` 同样不收带 userinfo 的值**（`https://user:pass@host/…`）：userinfo
  就是凭证本身，内联进 launch 脚本等于把它落盘。写成 `${ENV_VAR}` 引用、放进 token 配置
  （`cmt token edit <t> --base-url <u>`），或者改用 `cmt exec --url <u>`（不落盘）。
- **绑定匹配永远用「调用时的 cwd」**，绝不用 `token.cwd`。
  后者是"这个 token 默认落在哪"——拿它去匹配会成环。
- **`models` 是一组互斥的选择，`claudeArgs` 是一串彼此独立的开关。**
  所以前者整体覆盖，后者拼接。

### 路径绑定

`bindings` 是数组，每项形如 `{ path, token?, baseUrl?, models?, slots?, env? }`，
按**最长前缀匹配**：`D:/work/a/sub` 命中 `D:/work/a` 而不是 `D:/work`。

比较前先归一化：NFC（macOS 文件名可能以分解形式存储，而我们自己的 `startsWith`
是字节级敏感的，这条很关键）、`\` → `/`、Windows/macOS 转小写而 **Linux 保持大小写**、
消解 `.`/`..`、去掉尾部 `/`。**不解析 symlink**——那会让绑定莫名其妙地失效。
`cmt resolve` 会打印归一化后的串，让你看见到底按什么匹配的。

> WSL：`/mnt/c/...` 与 `C:\...` 是两套字符串，绑定**不互通**。这是刻意的，不做路径转换。

### 项目本地配置（`.cmt.json`）

一份放在**项目目录**里的配置，从 `cwd` **往上逐级找，最近的一份胜出**，直到文件系统根。

```json
{
  "version": 1,
  "token": "relay-a",
  "models": [{ "id": "deepseek-flash[1m]" }],
  "env": { "CLAUDE_CODE_EFFORT_LEVEL": "max" },
  "claudeArgs": []
}
```

**允许**：`version`（必填）· `token` · `models` · `env` · `claudeArgs`

**禁止**，而且每一个都有专门的报错指名道姓：

| 禁掉的键 | 为什么 |
|---|---|
| `authToken` | 凭证只有一个落点：`tokens/<name>.json`。多一个落点就多一份明文副本，而这一份会被 `git add .` 一起提交上去 |
| `baseUrl` | ★ **这是外泄通道**：克隆来的仓库里写 `baseUrl: "https://evil.example.com"`，你 `cmt run` 一下，key 就被送到那儿了。这条不是"不方便"，是攻击面 |
| `env.CLAUDE_CONFIG_DIR` | 隔离原语（§2.2）。项目文件改它，profile 与登录态就跟着项目走，`cmt run` 会去动你真实的 `~/.claude/` |
| `cwd` | 文件本身就是「按路径找到的」，再声明 cwd 是循环定义 |
| `slots` | ★ 槽位刻意不进项目文件——面板只配 `models`。两个面板各配一套（`models` 与 `slots`）必然分叉 |
| `claudeBin` / `terminalMode` / `seed` | 机器级偏好，不是项目级 |

⇒ **副产品：`.cmt.json` 天生不含密钥，可以安全提交进仓库。**

它**绝不会被自动创建**（`cmt` 的惰性纪律）。要么用面板的向导，要么自己写一份。
`--config <路径>` 可以指定一份别的（同一份 schema，跳过向上发现）：

```bash
cmt --config ./sub/.cmt.json resolve
```

读不了（JSON 非法 / schema 错）→ **硬报错**，不静默跳过。

### 模型优先级列表

`models` 是**有序优先级表**，`models[0]` 就是本次会话的默认模型。

1. `--model <id>` → 用它
2. 否则 → `models[0]`（**不交互提问**；要挑用 `--pick`）
3. `models: []` → 不注入模型，用 Claude Code 自身默认
4. `models` 不存在 → 继承上层

**`slots`** 把模型填进 Claude Code 的别名槽——**中转站必备**，
否则会话内 `/model opus` 会去请求一个中转站根本没有的模型：

| slot 键 | 注入的环境变量 |
|---------|---------------|
| `opus` / `sonnet` / `haiku` / `fable` | `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` |
| `subagent` | `CLAUDE_CODE_SUBAGENT_MODEL` |

**未在 `slots` 中列出的槽，自动填 `models[0]`。** 显式写 `null` 表示"该槽不注入"。
这条默认规则让"只有 deepseek 的中转站"不用手工配五个槽。

---

## 模型故障转移：为什么是人工的

> ⚠️ **「优先级」不等于自动故障转移。** Claude Code 的 `--fallback-model`
> **仅 `--print` 模式有效**（官方 help 原文 "(only works with --print)"）。
> 交互模式下 `models[0]` 只是默认选中项，模型挂了**不会**自己跳到 `models[1]`。

这是上游的限制，不是 `cmt` 的选择。`cmt` 能做的是把人工切换压到最短：**两条命令**，
且 `next` 是**轮转**而非删除，反复切换不会把候选耗光。

具体走法见「使用指南」的场景 4（模型挂了）与场景 5（换 key 不丢历史）。

**「一 token 一 profile」的代价**：切 token 会连带换掉 `CLAUDE_CONFIG_DIR`，
而 `-c` 的作用域正是**配置目录 + 当前目录**——所以换 key 要改现有 token 的凭证
（`cmt token edit`），而不是切到另一个 token。那是换身份，不是换钥匙。

---

## Token 池

上面所有内容回答的是"这个目录该跑什么"。池回答的是一个更窄的问题——**下一个窗口该用哪个
token**——而且只在别处都没有答案的时候才回答。

它存在的场景是团队式的：N 把 key、额度每月 1 号自动刷新、没有余额查询接口、不试一下就说不出
哪把已经用完。`token_pool.py`（本次移植的原型）把这个数据放在 Redis 里；在这里真相是一份本地
文件，Redis 只是一个要你显式开启的镜像。

### 池是什么，不是什么

`pool.json` 是**按 token 名索引的状态/用量覆盖层**。它不持有任何凭证：key 唯一的落点仍然是
`tokens/<name>.json`。`cmt token add` 仍然是创建身份的唯一入口，`cmt pool import` 只是
"批量 `token add` 加一个条目"。

- 条目对应的 `tokens/<name>.json` 已经不在了 → 读取时**直接丢弃**，不报错、不复活。
- 有 token 没有条目 → **未入池**：`pool list` 会标出来，而且它永远不会被自动挑中。入池是一个
  显式动作（`import` / `check <name>` / `status <name> <status>`）。
- `pool.json` 不存在或被手改坏了都不是错误——池退化成"所有条目都是未知"，代价只是重探一遍。

### 六种状态

| 状态 | 标签 | 含义 |
|---|---|---|
| `ok` | 有余额 | 探测拿到 2xx |
| `no_quota` | 无余额 | 额度耗尽 / 欠费 |
| `invalid` | 密钥无效 | 401，或响应体明说这把 key 不行 |
| `net_fail` | 连不上 | DNS / 超时 / TLS——对 key 本身什么都没说明 |
| `other` | 异常 | 5xx、限流、看不懂的响应 |
| `unknown` | 未检测 | 从没探过，或被清空 |

`net_fail` 与 `other` 分开是刻意的：两者重探的时机不同，而且**都不会**把一把 key 从候选里剔除。

### 探测 = 一次最小的真实请求

没有余额接口，所以"这把 key 还能不能用"只能靠**真发一次最小的请求**来回答。cmt 发的是
`POST {baseUrl}/v1/messages`，`max_tokens: 1`，认证方式跟着这个 token 自己的配置走
（`Authorization: Bearer` 或 `x-api-key`）。每把 key 花掉一点点钱，所以池只在必须的时候探：

| 上次状态 | 何时重探 |
|---|---|
| 从没探过，或 `checkedAt` 读不懂 | 立刻 |
| `ok` | 超过 `cacheSeconds`（默认 300 秒） |
| `no_quota` | **跨过月初**——额度 1 号刷新 |
| `invalid` | 24 小时之后 |

`no_quota` 不是"更长的超时"，而是一条不同的规则：额度在 1 号刷新，用一段固定时长去近似它，
会让一把早已恢复的 key 继续躺着被判死刑。

探测只发生在两处：`cmt pool check`（以及控制台上的「检测」），和下面那次启动前的挑选。
没有后台轮询，会话里也从不重探。

### 怎么挑

候选 = 除 `no_quota` 与 `invalid` 之外的全部条目，按**总用量升序**排列（`in + out`；调用次数
刻意不作为依据——一次调用就能吃掉十万 token）。并列时按 `rr` 游标轮转，于是同样未被用过的一组
会轮着上。

然后**按顺序逐个探测，遇到第一个 `ok` 立刻停**——常态是一次请求；赢家状态还新鲜时是零次。
一个都不成，启动失败，报出每个名字和原因，**从不报 key**。

### 什么时候会挑

只在窗口打开之前，绝不在会话之中：

| 情形 | 行为 |
|---|---|
| `cmt run` 解析不到任何 token | 补上空位（`defaults.pool.auto: false` 可关） |
| `cmt run --pool` | 强制挑一个，**盖过绑定和 `defaults.token`** |
| `cmt run --print` | 显示挑中的是谁、来源是 `pool`——花钱之前先看见 |
| `cmt resolve` | 只提示；只读的诊断命令不该为看一眼而发请求 |
| `cmt exec` | 从不——它跑到的时候 token 早就定了 |

★ **`-c` 守卫。** `-c` 续的是 Claude 在**这个 profile 里、这个目录下**最近一次会话，而
profile 属于某一个 token。如果第二次 `cmt run -c` 挑了另一个 token，它会**静默开一个新会话**
（另一份 profile，另一份历史），而你以为在续旧的。所以带 `-c` 时池只用 `lastPick[cwd]`——
上次从这个目录挑中的那个 token。没有记录，或记录的那个人已经不可用 → 报错，并给出两条出路
（显式指名一个 token，或者去掉 `-c`）。键是**挑选之前**算出来的 cwd：挑中之后 `token.cwd` 会
改写生效的 cwd，拿改后的值当键，下一次就对不上。

`defaults.pool` 可以关掉或重新调：

```json
{ "defaults": { "pool": { "auto": false, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 } } }
```

`policy: "round-robin"` 不看用量、直接轮转。两种策略都不会中途换人——挑是一次性的决定。

### 命令

```bash
cmt pool list                       # 所有 token + 状态 + 用量；没入池的标出来
cmt pool import tokens.xlsx         # 批量 token add + 建条目；已存在的名字跳过，不覆盖
cmt pool check [name...] [--all] [--force] [--model <m>]
                                    # 立刻探测；不给名字 = --all；--force 无视新鲜度窗口
cmt pool status relay-a no_quota    # 手动覆盖（detail 记 manual）
cmt pool reset relay-a              # 回到 unknown；用量保留
cmt pool sync [--redis <url>] [--force]
                                    # 从本机 transcript 重算用量；带 --redis 时同时写 Redis
                                    # 没变过的文件走缓存，--force 才全部重读
cmt pool pull --redis <url>         # 反向：把 Redis 里的状态拉回本地
```

`pool list` / `check` / `status` / `reset` 和启动那条路**全程不连 Redis**。

### 导入：CSV 或 xlsx

第 1 列是名字，第 2 列是密钥；表头行会被识别并跳过；`Bearer ` 前缀会被剥掉；空行（Excel 很爱
留几百行）**按单元格判断跳过**，不是按行号。已存在的名字**跳过并计数**，绝不覆盖——那把 key
可能正在用。回执是 `新增 N / 跳过 M`，并且从不回显密钥。

两种格式都在进程内用 `node:zlib` 解析——没有电子表格依赖。

### Redis 是镜像，不是家

`platform/redis.js` 是一个手写的小型 RESP2 客户端（`node:net` / `node:tls`），所以连它也不带
任何依赖。支持 `redis://`、`rediss://`、`unix://`，以及 `AUTH`（含 `user:pass`）和 `SELECT db`。

规则是单向的：**本地文件才是真相。** `--redis` 在本地写成功之后才写穿；Redis 失败只打一行
WARNING，退出码不变。只有 `pool sync --redis` 和 `pool pull --redis` 会建立连接，所以一台没有
Redis 的机器根本感知不到这个功能的存在。

### 在网页控制台里

每个资源行带一枚状态丸（一个原生 `<select>`，所以它同时也是你手工标注 key 的地方），`title`
里是探测的 `detail` 与时间，旁边是「检测」按钮；表头有「全部检测」，由页面在前端循环调用。
两件值得知道的事：

- 「检测」**无视新鲜度窗口**——你点了它，意思就是"现在就看"。
- 「全部检测」是 N 次请求，可能要几分钟。服务端不做批量：一次探测可能要 10 秒，18 把 key
  会把整个控制台钉在"忙"一个状态里。

两条路写的是命令用的同一份 `pool-store.js`，而且都只写本地。

---

## 会话在场与消息信箱

每次 `cmt exec` 都会在 `sessions/<id>/meta.json` 留下一条记录——token 名、cwd、pid、
开始/结束时间、退出码。写者是 exec 进程自己（它的生命周期就是会话的生命周期）；
`cmt run` 只负责开窗口然后撒手，看不到进程生死。写失败**绝不阻塞**会话。
记录**刻意不存 argv**：`--token-value` 是明文密钥。

`cmt sessions` 把所有窗口列成三态，读时现算：`live`（没有结束时间且 pid 还在）、
`ended`（记了正常退出）、`dead`（没有退出记录、进程也没了）。
它是给人看的概览，不是审计凭证——pid 被复用可能让 dead 记录看起来像 live。

`cmt msg send <id|--token <t>|--all> "正文"` 往一个**在跑**会话的 `inbox/` 投一个消息文件。
消息是**惰性数据**：cmt 里没有任何东西会读它并行动。送达是人工动作——
告诉 agent 自己去跑 `cmt msg inbox`。`msg inbox` 把展示过的消息 rename 进 `read/`
（同目录原子）标记已读；`msg gc` 按年龄清理；`sessions prune` 遇到还有未读的会话
会拒绝删除（除非 `--force`）。`type: info | action-request` 只是给读者的标注——
消息永远不产生执行权。

`cmt resume <会话 id>` 把已关闭 / 崩溃的会话原样重开（同 token、同目录、带 `-c`）。
会话条下方还有一条「最近关闭」（24 小时内）：一键恢复最近关掉的那个；
浏览器标题会带上未读总数，页面在标签页可见时每 10 秒自动刷新（切到后台就停，
控制台的空闲退出照旧生效）。

网页控制台在资源屏顶部显示一条会话条：全部健康且无未读时折叠成一行，
每个会话带「全部标已读」。

首页顶部还有一块**「需要你处理」**：把三类信号合成一张清单——活会话正在用的钥匙
在池里已废（无余额 / 无效）、有未读纸条的会话（已关闭的排前面）、上次退出码非 0 的会话。
每一条连同按钮一起由服务端算好（最多 5 条），页面只管照单画；
全部健康时整块不显示。

⚠️ 消息是明文 JSON，与 `pool.json` 同一信任级别：**不要把密钥贴进消息**。

---

## 命令一览

```
前端
  cmt                                       ★ 裸敲（无参数）= 网页控制台。
                                            非 TTY 时退回打印用法、退出 0
  cmt ui                                    显式进全屏面板。CMT_UI=plain cmt ui =
                                            逐行输出、不进备用屏
  cmt ui --web [--no-open]                  网页控制台。没有终端也能开（它不需要终端）。
                                            --no-open 只打印 URL、不开浏览器；
                                            CMT_UI=web 等价

会话
  cmt run [<token>] [--cwd <p>] [--model <id>] [--url <u>]
                    [--auth-mode token|key] [--pick] [--pool] [-c]
                    [--window|--tab] [--print] [-- <claude 参数...>]
                    # 没有 --token-value：凭证没法跨进程进新终端而不落盘
                    # （理由见「配置级联」那一节）
                    # --pool：从 token 池里挑一个，覆盖任何一层的绑定（见「Token 池」）
  cmt exec [<token>] [--model <id>] [--url <u>] [--token-value <v>]
                    [--auth-mode token|key] [-c]
                                           内部命令：注入环境后启动 claude
                                           ★ 一次性凭证唯一放得下的地方
  cmt resolve [<路径>]                     ★ 四要素 + 每项来源层

在场层与信箱（§2.14）
  cmt sessions [--json]                    每个窗口的三态之一——在跑 / 已退出 / 已断——
                                           外加未读数
  cmt sessions prune [--older-than 30d] [--force]
                                           删超龄的 ended/dead 记录；在跑的永不删，
                                           有未读纸条时拒绝，--force 才放行
  cmt resume <id|前缀>                     把已关闭/崩溃的窗口叫回来：同 token、同 cwd，
                                           带 `-c` 开新标签页。在跑的会话拒绝——它还开着，
                                           切回那个窗口即可
  cmt msg send <id|--token <t>|--all> [--type info|action-request] <正文...>
                                           给**在跑**的会话留一张纸条。消息是惰性数据，
                                           工具永不因它行动。送达 = 你告诉 agent 去跑
                                           `cmt msg inbox`
  cmt msg inbox [--session <id>] [--peek] [--json]
                                           看信箱；展示过的从 inbox/ 挪进 read/
                                           （同目录 rename），--peek 只看不动
  cmt msg gc [--older-than 7d]             清理超龄留言（inbox 与 read 都算）

配置
  cmt ls [--json]                          token 列表 + 各自 cwd / 模型来源
  cmt bind <路径> [--token <t>] [--url <u>] [--model <id>]
  cmt bind ls [--json]
  cmt bind rm <路径>
  cmt token add <name> --token <t> [--base-url <u>] [--cwd <p>] [--auth-mode token|key]
  cmt token rm <name> [--purge] [--yes]
  cmt token show <name>
  cmt token edit <name> [--token <v>] [--base-url <u>] [--cwd <p>] [--auth-mode token|key]

模型
  cmt model ls [<路径>|<token>] [--json]
  cmt model set [--global|--token <t>|--path <p>] <id[:label]>...
  cmt model use <id>   [--global|--token <t>|--path <p>]
  cmt model next       [--global|--token <t>|--path <p>]
  cmt model clear      [--token <t>|--path <p>]
  cmt slot set [--global|--token <t>|--path <p>] <槽>=<模型id>
  cmt slot ls  [--global|--token <t>|--path <p>]

排查
  cmt profile path <token>   打印 profile 目录（= CLAUDE_CONFIG_DIR）
  cmt profile ls             列出全部 profile 目录
  cmt doctor [--cwd <路径>]  自检：node / claude / 终端探测 / 四要素完整性 /
                             绑定悬空引用 / 非 ASCII 路径

用量
  cmt usage [--days <n>] [--by token|project|model|day] [--json] [--refresh]
                             按 token / 项目 / 模型 / 日期统计 token 用量与花费
                             ★ 只读 transcript，价格从 prices.json 取（USD / 百万 token）

Token 池（§2.13）
  cmt pool list              所有 token + 额度状态 + 用量；没入池的标「未入池」
  cmt pool import <csv|xlsx> 批量建 token + 入池（第 1 列名字、第 2 列密钥；已存在的跳过）
  cmt pool check [name...] [--all] [--force] [--model <m>]
                             探测额度：每把 key 发一次**最小的真实请求**（会花一点点钱）
                             不带参数 = 池里的全部；--force 无视新鲜度窗口
  cmt pool status <name> <s> 手动覆盖状态（detail 记 manual）
  cmt pool reset <name>      清状态（回到 unknown），用量保留
  cmt pool sync [--redis <url>] [--force]
                            从本机 transcript 重算用量；带 --redis 时写穿到 Redis；
                            没变过的文件走缓存，--force 才全部重读
  cmt pool pull --redis <url>      反向：把 Redis 里的状态拉回本地
                             ★ 池只是状态/用量覆盖层，**密钥永远只在 tokens/<name>.json**
                             ★ list / check / status / reset / 启动 全程不连 Redis

全局
  --config <路径>  ★ 指定一份项目本地配置（.cmt.json），跳过向上发现
  --json     机器可读输出（ls / resolve / model ls / bind ls / profile / doctor /
              usage / pool）
  -h, --help
  -v, --version
```

**退出码**：`0` 成功 · `1` 用户错误（token 不存在、名字非法、四要素缺项）·
`2` 环境错误（claude 不在 PATH、终端探测失败、目录不可写）。

报错**必须给出下一步命令**。例：

> 路径 `D:/work/x` 解析不到 token（无绑定、无全局默认）。
> 可用：`cmt bind D:/work/x --token relay-a`

---

## 配置文件

所有东西都在 `~/.claude-multi-token/` 下：

```
~/.claude-multi-token/
├── config.json              # 全局默认 + 路径绑定表
├── projects.json            # 项目状态：文件夹 → 状态（控制台里那套；不进 config.json）
├── pool.json                # token 池：状态 + 用量，**不含任何凭证**（见下）
├── pool-usage-cache.json    # 重算缓存：每份 transcript 的 size + mtime（删了不影响正确性）
├── tokens/<name>.json       # 每个 token 一份
└── profiles/<token>/        # ← CLAUDE_CONFIG_DIR 指向这里，Claude Code 自行填充
    ├── .claude.json         #   应用状态：OAuth 会话 / 项目信任 / 个人 MCP
    ├── .credentials.json    #   凭证（Windows/Linux）
    ├── settings.json        #   用户设置
    ├── projects/ sessions/  #   会话历史、并发会话探测
    └── launch.cmd | .sh     #   ★ cmt 写入此目录的文件之一（另一个见 defaults.seed）
```

一切都是**惰性**创建的：`cmt` 从不预建空的 `profiles/`。一个目录存在，
是因为有东西真的用到了它。

> **另一份配置不在这个目录里**：项目本地的 `<项目>/.cmt.json`（见「项目本地配置」）。
> 它属于**你的仓库**，不属于 `cmt`——`cmt` 只在向导里、或你显式让它写的时候才碰它。

### `<项目>/.cmt.json`（项目本地配置）

```json
{ "version": 1, "token": "relay-a", "models": [{ "id": "deepseek-flash[1m]" }] }
```

从 `cwd` 往上找**最近**的一份，赢过路径绑定。**不含密钥**（`authToken` / `baseUrl` 等一律
禁止，见「项目本地配置」一节），所以可以安全提交进仓库。

**它天生是"项目的"，不是"你的"**：clone 下来就生效，不用先 `cmt bind`。

`config.json` 就是你那组 export，换了个地方放：

```jsonc
{
  "version": 1,
  "defaults": {
    "authToken": "${DEEPSEEK_API_KEY}",   // 支持 ${ENV_VAR} 引用（authToken 与 baseUrl 都支持）；也接受明文
    "authMode": "token",                  // "token" → ANTHROPIC_AUTH_TOKEN | "key" → ANTHROPIC_API_KEY
    "baseUrl": "https://api.deepseek.com/anthropic",
    "models": [                           // ★ 有序，越靠前优先级越高
      { "id": "deepseek-flash[1m]", "label": "Flash 1M" },
      { "id": "deepseek-flash",     "label": "Flash" }
    ],
    "slots": { "haiku": "deepseek-flash", "subagent": "deepseek-flash" },
    "env": {                              // 任意环境变量逃生舱
      "CLAUDE_CODE_EFFORT_LEVEL": "max",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "786432"
    },
    "terminalMode": "tab",                // "tab" = 在 cmt 专属窗口开新标签页（默认）；"window" = 每次都开新窗口
    "claudeArgs": [],
    "seed": "off",                        // 跳过首启弹窗："off" | "onboarding" | "full"
    "preflight": true,                    // ★ 启动前那次 /models 校验；false 关掉
    "pool": { "auto": true, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 }
  },
  "bindings": [
    { "path": "D:/work/client-a", "token": "relay-a" }
  ]
}
```

| 你的 export | 落在配置哪里 |
|-------------|-------------|
| `ANTHROPIC_BASE_URL` | `defaults.baseUrl` |
| `ANTHROPIC_AUTH_TOKEN` | `defaults.authToken` + `defaults.authMode: "token"` |
| `ANTHROPIC_MODEL` | `defaults.models[0].id`（**不单独配**） |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `defaults.slots.opus` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `defaults.slots.sonnet` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `defaults.slots.haiku` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `defaults.slots.subagent` |
| `CLAUDE_CODE_EFFORT_LEVEL` | `defaults.env.CLAUDE_CODE_EFFORT_LEVEL` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `defaults.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` |

未知键会被**拒绝**而不是静默忽略——手写配置打错字能立刻发现。

`${ENV_VAR}` 引用：**`authToken` 与 `baseUrl` 都支持**，且任何一层都能写（全局默认、
路径绑定、token 文件、`--token`、`--url`）。**只认整串引用**（`"${A}"` ✅，`"sk-${A}"` ❌ → 报错）。
在启动时从**新窗口的进程环境**读取。变量未设置 → 报错，退出码 1，消息里指名变量。
**绝不静默回退成字面量 `"${A}"`**——那会变成一个恒被拒绝的假 token（端点则是一个解析不出来的
域名），是最难排查的一类问题。`cmt resolve` 只标注「已设置 / 未设置」，不打印值。

> **`cmt` 读的是 `process.env`，它自己不解析 `.env`。** 加载那个文件是你 shell 的事
> （`source .env`、direnv、shell profile、CI secret）。所以「把内网端点挡在仓库外」是两步：
> `RELAY_BASE_URL=…` 放在不提交的文件里，`"${RELAY_BASE_URL}"` 放在 `config.json` 里。
> 本项目的 `.gitignore` 已经拦掉 `.env` 与 `.env.*`，就是给这个用法准备的。

### `pool.json`

token 池的落点。**它也是明文，但一个凭证都不装**——按 token **名**索引的状态/用量覆盖层，
全文件没有 `sk` 字段。`tokens/<name>.json` 仍然是密钥唯一的落盘点。

```jsonc
{
  "version": 1,
  "updatedAt": "2026-10-31T08:00:00.000Z",
  "rr": 4,                                   // 轮询游标
  "lastPick": { "C:/work/x": "relay-a" },    // -c 守卫：上次从这个目录挑中的 token
  "entries": {
    "relay-a": {
      "status": "ok",                        // ok|no_quota|invalid|net_fail|other|unknown
      "detail": "HTTP 200 · 812ms",
      "checkedAt": "2026-10-31T07:59:00.000Z",
      "calls": 12, "in": 32000, "out": 9000, // 会话条数 / 输入侧（含缓存）/ 输出侧
      "usageAt": "2026-10-31T08:00:00.000Z", // 用量是什么时候算的；'' = 从没算过
      "models": {                            // ★ 按模型分开记——花费只能从这里算
        "deepseek-flash": { "input": 12000, "cacheRead": 20000, "cacheWrite": 0, "output": 9000 }
      }
    }
  }
}
```

⚠️ **它可丢弃，删了不丢凭证。** 丢掉的是每把 key 的状态、用量计数，以及 `lastPick`——
最后那个有一个具体代价：`cmt run -c` 会要求你指名一个 token（见「Token 池」的 `-c` 守卫）。

`pool.json` 不存在或被手改坏了都**不算错误**：池退化成"全部未检测"，下一次探测就回来。
它和 `resources.json` 同一档次——**可重建的缓存，不是真相**；真相是 `tokens/` 与 `config.json`。

`defaults.pool` 只接受四个键——`auto`、`policy`、`cacheSeconds`、`usageSeconds`。
两个秒数**不可互换**：`cacheSeconds` 是探测窗口（发真请求、花一点钱），`usageSeconds`
是重算窗口（读本机文件、不花钱）。**里面没有 Redis 地址**：
它可能带密码，而 `config.json` 是"旧版本会整份拒载"的承重文件。地址走 `--redis <url>`。

---

## 坑

### 面板把终端留在备用屏里了

**症状**：终端看起来"卡住"了、没有光标、敲字有回显但提示符不回来。

**原因**：Windows 上 `taskkill /F`、任务管理器、直接关终端窗口都是无条件
`TerminateProcess`——**没有 `'exit'`、没有回调**，`cmt` 的还原代码根本没机会跑。
（正常退出、`Ctrl+C`、向导中途 `q` 都会还原，那些路径都挂了网。）

**出路**（按顺序试）：

```bash
CMT_UI=plain cmt ui     # ① 逐行模式：不进备用屏，同一份内容、同一套按键
```

② 还是不行就换一个终端窗口，或者 `reset`（POSIX）/ 关掉重开（Windows）。
③ 想彻底避免：裸敲 `cmt`——**网页控制台**——压根不接管你的终端（它是浏览器里的一个页面，
不是终端里的一块屏）。或者日常就用 `CMT_UI=plain`，或者干脆用 `cmt run` / `cmt resolve` 那套命令。

> 这不是能"修好"的东西——**拦不住的信号没有 API**。所以 `CMT_UI=plain` 不是可选项，
> 是设计的一部分。

### `ANTHROPIC_BASE_URL` 指向非一方域名

Claude Code 会因此**默认关闭 MCP tool search**，并**关闭 Remote Control**（v2.1.196+）。
中转站用户必踩。要重新打开 tool search：

```jsonc
"env": { "ENABLE_TOOL_SEARCH": "true" }
```

### `authMode` 默认 `"token"` 是刻意的

`ANTHROPIC_API_KEY` 在交互模式下会弹一次性的"使用自定义 API key？"确认，
`ANTHROPIC_AUTH_TOKEN` 不会。中转站场景默认走后者，省掉每个 token 一次的打扰。

### 跳过首启弹窗（`defaults.seed`）

空 profile 首次启动会走主题选择与工作目录信任确认，每个 token 一次，而且**两个都挡住启动**。
**没有**任何环境变量、设置键或命令行标志能跳过它们——Claude Code 的首次闸门只读
`.claude.json` 里那两个字段，所以写它就是唯一的办法。`defaults.seed` 让 cmt 在启动前替你写：

| 取值 | cmt 补什么 | 效果 |
|------|-----------|------|
| `"off"` | 什么都不做 | **默认** —— cmt 绝不往 profile 里写东西 |
| `"onboarding"` | `hasCompletedOnboarding: true` | 跳过主题选择 |
| `"full"` | 上面那条 + 当前目录的 `hasTrustDialogAccepted: true` | 零点击 |

```jsonc
"defaults": { "seed": "full" }
```

它是**只增不改、幂等**的：已存在的键一个字节都不动——包括你**明确拒绝过**某个目录时留下的
`hasTrustDialogAccepted: false`——且从第二次启动起退化成纯读取。首次播种前留一份
`.claude.json.cmt.bak`。

`seed` 只管那两个挡住启动的对话框，别的一概不碰。它**不写 `settings.json`**：
全新 profile 会先用 Claude Code 的默认主题（直到你自己挑一个），并且会弹一次
bypass 权限警告——除非该 profile 的 `settings.json` 里有 `skipDangerousModePermissionPrompt`。
那些是**设置**而非一次性回答，cmt 不掺和（见下面「cmt 不写 Claude Code 的设置」）。

### managed 设置压过一切

注入看起来没生效时，先查 managed 设置：Windows
`C:\Program Files\ClaudeCode\` + 注册表 `HKLM\SOFTWARE\Policies\ClaudeCode`，macOS
`/Library/Application Support/ClaudeCode/`，Linux `/etc/claude-code/`。
它们压过 `--settings` 和一切文件层。

### `~/.claude.json` 与 `~/.claude/settings.json` 是两个不同的文件

前者是应用状态（OAuth 会话、项目信任、个人 MCP、UI 开关），后者才是设置
（`permissions` / `hooks` / `env`）。排查"配置没生效"时先分清这两个。

### 绑定"看起来一模一样"却匹配不上

绑定匹配是**字符串前缀匹配**——刻意不做 `realpath`（见「路径绑定」）。
于是一个目录可以有多种写法，而你的配置里只存了其中一种。
Windows 上的经典形态是 **8.3 短名**：
`C:/Users/ALICE~1/work` 与 `C:/Users/alice/work` 是同一个目录，但字符串不同。

遇到这种情况，`cmt resolve` 不会只丢一句"绑定（无）"——它会指出末段相同的那条绑定，
并把两个归一化串都印出来，让你逐字符对照：

```
  绑定   （无）
         ⚠ 这条绑定的末段相同、整串却对不上：
             C:/Users/alice/work/client-a
             归一化 c:/users/alice/work/client-a   ← 与上面的归一化目录逐字符比一比
```

修法是**按你启动时用的那个写法重新 bind 一次**。
注意**大小写永远不是原因**——归一化在比较前就把 Windows/macOS 上的大小写折掉了，
纯大小写差异会直接命中。

---

## 安全须知

**token 以明文存储**（`tokens/<name>.json`）。这是 v1 的刻意选择，不是疏漏——
本项目不加密存储。介意的话用环境变量引用，让密钥留在环境里：

```bash
cmt token add relay-a --token '${DEEPSEEK_API_KEY}'
```

**`pool.json` 同样是明文，但它一个凭证都不装。** 它是一张按 token **名**索引的状态/用量
覆盖层，全文件没有 `sk` 字段，`tokens/<name>.json` 仍然是密钥唯一的落盘点。`cmt pool import`
也不是第二个家：它先把密钥走一遍 `token add` 那条路写进 token 文件，然后才记下池条目。

**launch 脚本不含任何密钥。** 生成的 `launch.cmd` / `launch.sh` 只用绝对路径调用
`cmt exec`，密钥由 `cmt exec` 自己注入进进程环境。token 只有一个落盘点——
profile 目录里不会多出第二份明文副本。你在命令行上给过的**非密钥**覆盖项
（`--url` / `--auth-mode`）**会**被写进去，因为脚本必须逐字复现你那条命令；
而 `--url` 通常写的就是 `${ENV_VAR}` 引用，落盘也无妨。带 userinfo 的 `--url`
（`https://user:pass@host/…`）会被拒绝，理由与 `--token-value` 相同——那个 userinfo
就是凭证，不能落到文件里。

**项目/本地设置无法设置 `CLAUDE_CONFIG_DIR`**（Claude Code 官方行为）。
因此恶意仓库劫持不了你的 token profile。这也是本方案建立在 `CLAUDE_CONFIG_DIR`
而不是"改配置文件"之上的理由之一。

**cmt 不写 Claude Code 的设置。** 环境注入走进程环境变量，不走改配置文件。
`cmt` 在 profile 目录里会写的文件只有 `profiles/<token>/launch.{cmd,sh}`，
以及——**只在你显式开启时**——`profiles/<token>/.claude.json`（见上面「跳过首启弹窗」）。

第二条是**唯一的例外**，且默认关闭。它存在是因为 Claude Code 的首次闸门只读那一个文件，
**别的什么都不认**——不是设置键、不是命令行标志、也不是 570 个 `CLAUDE_CODE_*` 环境变量中的
任何一个——所以「绝不写它」与「不用手点」不可能同时成立。开启后它只增不改、幂等，
且只写九个字段。即便如此 `settings.json` 依然不碰：主题与 `skipDangerousModePermissionPrompt`
是你会反复改的**设置**，不是一次性回答，一个会重写它们的工具就是永远在同一个文件上跟你较劲的工具。

**脱敏**（`--print` / `cmt resolve` / `cmt token show`）：键名匹配
`/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` 的值一律打码为「前 3 后 4」。
不是只硬编码打码 `ANTHROPIC_AUTH_TOKEN`——`env` 逃生舱里可能塞了别的密钥。

**网页控制台从不把凭证发给浏览器。** 视图模型里带的是一个打码值和一个**长度**；明文密钥始终
留在服务端进程的内存里，唯一过线的密钥是你自己在表单里敲进去的那个。控制台真正暴露给的是
**你这台机器上的其它页面**——威胁模型是**跨源**，不是"本机的另一个用户"（能读
`tokens/*.json` 的人本来就有那把密钥）。所以才有：只绑回环、每次运行现生成的路径口令、
`Host` / `Origin` 校验，以及一条 `default-src 'none'` 的 CSP。也所以才有 `--no-open`——
如果你不愿意口令出现在进程列表里。

---

## 平台支持

| 平台 | 终端拉起 | 状态 |
|------|---------|------|
| Windows | `wt.exe -w cmt new-tab --title <t> --suppressApplicationTitle -d <cwd> <argv>` → `cmd /c start` 兜底 | **已实测**（Windows 11 + Windows Terminal 1.24） |
| macOS | iTerm2 / Terminal.app，经 `osascript` → `open -a Terminal` | 代码已写，**未实测** |
| Linux | `$TERMINAL` → `x-terminal-emulator` → gnome-terminal / konsole / xterm | 代码已写，**未实测** |

**`tab`（默认）与 `window` 的区别。** Windows 上 `--tab` 是往一个**名为 `cmt` 的窗口**里
加标签页——第一次用时建出来，之后一直复用，你把它关掉下次会自动重建。于是"N 个目录 N 个会话"
就是**一个窗口里的 N 个标签页**，标题各自是 `cmt:<token> · <cwd 末段>`。
`--window` 走 `-w -1`（永远新开窗口），标题格式不变——想把不同项目摊到不同显示器上就用它。

那条 argv 里有两处是承重的：

- **用 `-w cmt` 而不是 `-w 0`。** `-w 0` / `-w last` 的含义是「**最近使用过的**窗口」，
  不是「当前这个」。开了多个 WT 窗口时，标签页落在哪取决于你上次碰过哪个——
  **不可预期**。写死一个名字才是确定的。
- **`--suppressApplicationTitle`，紧跟 `new-tab`。** 光有 `--title` 只是个建议：
  标签页里跑的程序可以用 OSC 2 覆盖它，而 Claude Code 恰好就会这么干
  （`cmt:relay-test · claude_test` → `✳ cmt:relay-test`，目录末段当场丢失）。
  没有这个开关，上面那条标题契约**就是假的**。它必须出现在 `new-tab` 子命令**之后**，
  否则 WT 根本不认。

**macOS 与 Linux 的终端拉起没有在真机上验证过。** 代码路径是完整的，
相关模块顶部标了 `// UNVERIFIED`，它们需要的转义规则也各自带了单测——
但只有 Windows 端到端跑通过。欢迎反馈与 PR。

网页控制台的**服务端**那一半在 Windows 上是端到端跑过的——测试套件真的 spawn 一个
`cmt ui --web`、用 HTTP 跟它说话、再把它退掉。**没在真机上验证过**的是：真的开出一个
Chrome/Edge **应用窗口**（断言的是 argv 形状，不是那个窗口）、以及 Windows 防火墙会不会弹窗。
绑回环**应该**永远不弹——但那是推理，不是实测，所以它写在开放问题里，而不是写在这张表里。

`cmt doctor` 就是为这件事准备的：它会报告探测过哪些终端、每个候选为什么失败；
`cmt run --print` 则能在不启动任何东西的前提下，把将要执行的内容原样打出来。

### 环境变量注入在构造上就是跨平台中立的

环境变量**不在 shell 脚本里注入**。`cmt exec` 用 `spawn(cmd, args, { env })` 注入，
这一步绕开了 cmd / PowerShell / sh 三套完全不同的引号与转义规则。
`argv` 始终是数组、一路不被 shell 解析——这也是带空格与中文的路径能正常工作的原因。
`launch.cmd` 是纯 ASCII + CRLF（因为 cmd.exe 按 OEM 代码页解码 `.cmd` 文件），
`launch.sh` 是 LF。

### 新会话不继承调用方的会话身份

新终端**不是**干净环境。Windows Terminal 会把调用方的进程环境**原样转发**给新标签页——
`wt -w <名> new-tab` 这条路也照转（Windows 11 / WT 1.24 实测）。于是从 Claude Code 会话里
跑 `cmt run` 时，新标签页本会带着那个会话的**整套身份**：

| 继承来的变量 | 对新会话做了什么 |
|--------------|------------------|
| `CLAUDE_CODE_CHILD_SESSION=1` | 打印 `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker`，并且**对话记录不再落盘** |
| `CLAUDE_CODE_SESSION_ID` | 新会话顶着**父会话的**会话 id |
| `CLAUDE_CODE_MESSAGING_SOCKET` + `..._TOKEN` | 指回父会话的 IPC 管道，还附带一个能打开它的活凭证 |
| `CLAUDECODE` / `CLAUDE_PID` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_EXECPATH` / `CLAUDE_CODE_SSE_PORT` | 全部描述的是父进程 |

`cmt` 在两条 spawn 路径上（`cmt run` 的终端、`cmt exec` 的 claude）都会把这九个剔掉，所以：

> **`cmt run` / `cmt exec` 的结果，不取决于它是从哪儿被调用的。**
> 新会话环境 = 继承环境**剔掉会话标记** → **删掉 cmt 明确不注入的项** → **盖上 cmt 的注入项**。

中间那一步管的是 cmt **决定不注入**、但继承来的值会顶上去的 `ANTHROPIC_*`：
`models: []`（"用 Claude Code 自身默认"）与 `slots: { opus: null }`（"该槽不注入"）都会把
继承来的 `ANTHROPIC_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` **删掉**，而不是任由它冒充默认值。
没选中的那个认证变量同理——`ANTHROPIC_AUTH_TOKEN` 的优先级压过 `ANTHROPIC_API_KEY`，
所以 `authMode: "key"` 时继承来的 `AUTH_TOKEN` 会**悄悄赢**。

判据是**身份 vs 配置**：值描述的是*某一个正在跑的进程 / 会话*（进程号、会话 id、管道、端口、
可执行文件路径、入口方式）就**剔**；值是*配置*（`CLAUDE_CODE_EFFORT_LEVEL`、
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_CODE_DISABLE_AUTOUPDATER` …）就**留**——
那些本来就归 cmt 管，而 cmt 管的那些会被它自己的配置覆盖掉。

`cmt resolve` 与 `cmt run --print` 两半都印：**将要注入什么**，以及**将从继承环境里删掉什么**。
注入永远在最后一步，所以 `env` 逃生舱随时能把任何一项盖回来。

### 权限

POSIX 下含 token 的文件 `chmod 0600`。**Windows 上 `fs.chmod` 基本是 no-op**——
实际依赖用户目录 ACL。我们不假装设了权限。

**macOS**：凭证在钥匙串里而不是 profile 目录里，所以 `cmt token rm --purge`
清不掉它。`cmt` 会打印提示让你手工清理，而不是静默留一份残留。

---

## 卸载

```bash
npm uninstall -g claude-multi-token
rm -rf ~/.claude-multi-token     # Windows: rmdir /s %USERPROFILE%\.claude-multi-token
```

**这不影响 `~/.claude/`**——你的 Claude Code 主配置、登录态与会话历史原封不动。
`cmt` 从不读写那个目录。

删掉 `~/.claude-multi-token/` 会一并删掉 token、绑定和全部 profile 目录
（含各 token 的会话历史）。想留历史的话先备份
`~/.claude-multi-token/profiles/`。

---

## cmt 明确不做

- ❌ **不做*会话中*的 token 轮询 / 负载均衡 / 自动故障转移。** 窗口一开，身份就钉死了，整场会话
  不会再换。**启动之前**挑一次不算：`cmt run` 在需要时从 token 池里挑一个（只要一次），
  `--pool` 也只是让这一次挑覆盖绑定——挑完就不再回头看。启动前那次 `/models` 校验同理：
  只读、只做一次、失败不阻塞，而且都发生在你按下回车之前。见上面「模型故障转移」「Token 池」。
- ❌ 不做代理服务本身——不管中转站的实现
- ❌ 不加密存储 token（明文 JSON，上文已警告）
- ❌ 不安装 / 不更新 Claude Code 本体（安装是「第 0 步」，得你自己做）
- ❌ 不修改 Claude Code 本体、不 hook 其内部实现
- ❌ **没有余额 API，因为它不存在。** `cmt usage` 读的是**你本机的 transcript 记录**，从不向中转站
  打听额度。真正出网的只有你主动触发的两种：`cmt pool check` 每把 key 发一次**最小请求**
  （这要花一点点钱），以及 `cmt exec` 启动时拉一次 `/models`。没有后台轮询、没有统计爬取、
  没有猜出来的额度。
- ❌ **不做外部 GUI**——桌面端、VS Code 扩展，一律不做。
  （★ 这条禁的是**外部** GUI。`cmt` 自带**两个**界面——本地**网页控制台**（裸 `cmt`）和全屏
  **面板**（`cmt ui`）。两者都不碰 `~/.claude/`，也都不是"去适配别人的客户端"。
  不写清楚的话，这条和那两个前端读起来自相矛盾。）
- ❌ 不引入任何 npm 运行时依赖。`dependencies: {}`——只用 `node:` 内置模块。
  **两个前端也都是手写的**：面板是 raw mode + ANSI 转义序列（没引 TUI 库），
  网页控制台是 `node:http` 加一个 `fetch`（没引框架、没有构建步骤）。

### 面板的 v1 边界

- **项目本地配置不许放凭证。** 要新身份走 `cmt token add`。
- **`slots` 不进面板。** 向导只配 `models`；槽位映射仍走 `cmt slot set`。
  （`fillDefaultSlots` 会拿 `models[0]` 填未设的槽，所以配 `models` 已覆盖绝大多数场景。）
- **不缓存模型清单。** 每次进第 3 步都重新拉——`cmt` 不记忆任何跨会话的选择。
- **不做主题、不做鼠标、不做 diff 渲染、不设 diff 开关。** 留着就会有人打开。
- **面板的 `e` 只改「当前生效那一层」**，不给你层级选择器。想精确指定用
  `cmt model set --global|--token|--path`。
- **不改 `--pick` 的行为。** 新内核只服务面板；`cmt run --pick` 仍是原来那个极简行式选择器。

---

## 设计

架构契约在 [`CLAUDE.md`](./CLAUDE.md)——面向贡献者的权威文档，涵盖解析级联、
`~/.claude-multi-token/` 下每个路径的所有权规则、launch 脚本契约、以及平台适配层。

承重原语只有两个，也刻意只有两个：

| 原语 | 作用 |
|------|------|
| `CLAUDE_CONFIG_DIR` | **身份隔离**——一个 token 一份 profile |
| `ANTHROPIC_*` / `CLAUDE_CODE_*` | **认证 + 模型 + 行为注入** |

```
bin → cli → core ← platform
```

`core/` 是纯逻辑、无 IO 副作用——它不读 `process.env`、不读 `process.platform`、
不读 `os.homedir()`、不 spawn。这些一律由 cli 层以 `{ platform, home, env }` 注入。
正因如此，Windows / macOS / Linux 三套路径规则**在任意一台机器上都能单测**。

面板把这条纪律**降一级复制**到了 `cli/` 内部：`cli/ui/` 里 `keys.js` / `render.js` /
`app.js` 三个文件是纯的（字节流进、帧和副作用清单出），**只有 `ui/term.js` 碰
`process.stdin` / `process.stdout`**。所以面板的状态机与排版能整层被测，而不必真抢一个终端。

网页控制台则把它**横向**复制了一遍：浏览器那一半（`src/web/`）是当字节发出去的，**一行测试都
没有**，所以它不许搞错的东西全在线的服务端一侧——`commands/ui-web.js` 造视图模型，而
**`platform/serve-web.js` 是唯一 import `node:http` 的文件**（也是唯一装 `SIGINT` 处理器的，
所以上面那句「例外只此一处」继续成立）。两半在一个 JSON 形状上会合，那个形状有测试逐键断言。

```bash
npm test                         # node --test —— 1566 个测试，不联网、不需要 claude
node scripts/verify-ui-real.mjs  # 把面板的七条 Windows 事实（M1–M7）落盘到 ui-real-report.json
```

---

## 许可

MIT
