# codex-multi-token（`cxt`）

**一个窗口，一个 token。**

[English →](./README.md)

> **状态：已归档（2026 年 11 月）。** 本项目停止开发。以 MIT 协议原样发布，供参考设计与代码。
> 没有维护、没有路线图，也不保证仍适配当前版本的 Codex CLI。
> 请把它当作一份**带可执行证据的设计文档**来读。

把「一台机器只有一个全局 `CODEX_HOME`」变成「**按路径解析的身份**」：你在哪个目录敲
`cxt run`，它开出来的 Codex 窗口就用那个目录对应的 token / 地址 / 模型。两个客户项目、
两个中转站、两个模型，两个窗口同时开着，一个配置文件都不用手工改。

零运行时依赖。Node ≥ 18。Windows / macOS / Linux。

> **不想读文档？** 在终端里裸敲 `cxt`——它开一个本地**网页控制台**：下拉列表和勾选框组成的
> 表单。选目录、输 token、拉模型清单，**一次写好两处配置**；模型优先级靠勾选 + `↑` `↓` 调序，
> 左栏的「资源」视图里还能就地改每个 token 的优先级和昵称。那个窗口是 `cxt` 自己的——只绑
> `127.0.0.1`，别的机器访问不到。
> 更习惯终端？`cxt ui` 开全屏**面板**（方向键；SSH 下能用的是它）。非 TTY 时裸 `cxt` 退回
> 打印用法、**退出 0**，脚本一个字都不受影响。

---

## 它解决什么问题

Codex 只读一个配置文件：`$CODEX_HOME/config.toml`，而 `CODEX_HOME` 默认是 `~/.codex`。
于是一台机器只有一个身份。想用第二个中转站，就得改那个文件，用完再改回来：

```toml
model = "deepseek-chat"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

这是一个**全局开关**。它没法表达「这个目录用客户 A 的线路，那个目录用 B 的」，也没法同时
持有两份。在 shell 里 `export DEEPSEEK_API_KEY` 也没用——**指名用哪个 key 的是 provider
块**，而 provider 块只有一份。

最直接的办法是每个 shell 指一个不同的 `CODEX_HOME`。能用，但你要手工维护 N 份
`config.toml`；而且 Codex 会往每份里写自己的状态（`auth.json`、`sessions/`、
`history.jsonl`），于是它们会各自漂移，而 `model_provider` 与 `[model_providers.*]`
必须成对同步——否则整个 `config.toml` 加载失败。

`cxt` 做的是同一件事，但**推导**出来：token 名来自你所在的目录，`CODEX_HOME` 来自 token 名，
provider 块来自 token 的 `baseUrl`——每次启动前重新生成，所以它漂不了。

---

## 安装

### 第 0 步：先装 Codex CLI

```bash
npm install -g @openai/codex
codex --version        # codex-cli 0.163.0
```

`cxt` 不捆绑 Codex，它启动你已经装好的那个。找二进制分三级，`cxt doctor` 会告诉你命中了哪级：

1. `config.json` 里的 `defaults.codexBin`（显式覆盖）
2. `PATH` —— `codex`（POSIX）/ 逐个试 `PATHEXT`（Windows）
3. 常见安装位置（`npm root -g`、`%APPDATA%\npm`、`/usr/local/bin` …）

三级都没命中 → 报错，退出码 2，并列出它试过的每一个路径。

```console
$ cxt doctor
  ✓ codex 找到了（定位档 1）：C:\Users\…\AppData\Roaming\npm\codex.cmd
      ★ 是 `.cmd`，要经 `cmd.exe /d /s /c` 调起——Node 18.20+/20.12+ 出于 CVE-2024-27980
        会拒绝直接 spawn 它（§7.14⑥）。cxt 已经这么做了。
```

> **Windows：** `codex` 装出来是个 **`.cmd` 转发脚本**，而 Node ≥ 18.20 / 20.12 拒绝直接
> `spawn` 一个 `.cmd`（`EINVAL`，CVE-2024-27980 的修复带来的）。`cxt` 在 Windows 上一律走
> `cmd.exe /d /s /c "…"`。你不用做任何事——但如果你自己写 Node 脚本包 `cxt`，要知道裸的
> `spawn('codex', …)` 会以同样的方式失败，那**不是** `cxt` 的 bug。

### 再装 cxt

**从检出目录装。** 这个包从未发布到 npm —— 项目先归档了 —— 所以
`npm install -g codex-multi-token` 会返回 404：

```bash
cd codex                # 在仓库根目录
npm install -g .        # → `cxt`
cxt --version           # 0.1.0
```

或者完全不安装，直接跑：

```bash
node bin/cxt.js --help
```

---

## 使用指南

下面的输出全部来自真实运行（机器相关的绝对路径用 `…` 省略）。

### 场景 1：让一个 token 跑起来

```bash
cxt token add relay-a --base-url https://api.deepseek.com/ --token 'sk-…' --label '阿里中转'
cxt model set --token relay-a 'deepseek-chat:DS 对话' 'deepseek-reasoner:DS 推理'
```

`--label` 是给这个身份起的**昵称**（可选，只为看得懂——身份永远是 `relay-a`）。

label 用**冒号**接在 id 后面。如果模型 id 自己就带冒号（OpenRouter 的 `…-70b:free`），改用
`--id <id>`——那个写法完全不做切分。

`cxt token add` 的 `--token` 收的是**密钥本身**。注意这个坑：在 `cxt token add` 里
`--token` 是*密钥*；在 `cxt bind` / `cxt run` / `cxt trust` 里 `--token` 是*token 的名字*。
两处都写作 `--token`，而且互不接受对方那种。

看一眼——列全部 token 是 `cxt ls`，**没有** `cxt token ls`：

```console
$ cxt ls
  token    模型                                     profile  绑定路径
  relay-a  deepseek-chat > deepseek-reasoner (own)  ✓ 已建   D:/work/client-a
  relay-b  gpt-5-codex (own)                        — 未建   D:/work/client-b

  2 个 token · 2 条绑定
```

然后启动：

```bash
cxt run --token relay-a
```

它会开一个新的终端窗口，把 `CODEX_HOME` 指到 `~/.codex-multi-token/profiles/relay-a/`，
把 provider 块写进那个 profile 的 `config.toml`，然后启动 Codex。那个目录之外的东西
一个都没动。

### 场景 2：把项目目录绑定到 token

这个工具的意义所在：不用再打 `--token`。

```bash
cd D:\work\client-a
cxt bind . --token relay-a
```

之后在那个目录**及其任意子目录**里：

```bash
cxt run          # → relay-a，从你所在的位置解析出来
```

```console
$ cxt resolve D:/work/client-a
  cxt resolve  — D:/work/client-a
  入口 run：token.cwd 生效
  命中绑定 D:/work/client-a

  四要素
     项         值                         来源
  ✓  cwd        D:/work/client-a           进程目录
  ✓  authToken  sk-****1111                token 文件
  ✓  baseUrl    https://api.deepseek.com/  token 文件
  ✓  model      deepseek-chat (DS 对话)    路径绑定
  …
```

`cxt resolve` 是排查工具：**每一项都标了来源层**，所以「这个目录为什么用了那个 token」
是读出来的，不是猜出来的。它不需要终端、不 spawn 任何东西、不要求装了 Codex——这正是
出问题时它还能用的原因。

绑定按**最长前缀**匹配；并列时取先声明的那条。

### 场景 3：两个项目、两个身份，同时开着

```bash
cxt bind D:\work\client-a --token relay-a
cxt bind D:\work\client-b --token relay-b

cxt run --cwd D:\work\client-a     # 窗口 1：relay-a
cxt run --cwd D:\work\client-b     # 窗口 2：relay-b
```

两个窗口、两个 `CODEX_HOME`、两个中转站、两个模型，互不干扰。每个窗口的 Codex 把会话历史
写进自己的 profile 目录，所以窗口 1 里的 `codex resume --last` 只会回到窗口 1 的历史。

### 场景 4：模型列表就是故障转移优先级

```bash
cxt model ls                     # 当前生效的是哪个，来自哪一层
cxt model next                   # 轮到下一个
```

```console
$ cxt model ls D:/work/client-a
  模型优先级 · D:/work/client-a

  #  模型               label
  ▶  deepseek-chat      DS 对话
  2  deepseek-reasoner  DS 推理

  来源层：binding D:/work/client-a
```

第一个模型开始报错时，`cxt model next` 把列表轮转一位，新的首位就是新模型。反复按一定能
回到起点——列表是个环，不是会耗光的队列。

想续上刚才那段会话，加 `-c` 重新启动：

```bash
cxt run -c        # 新窗口 + codex resume --last
```

> ⚠️ **`-c` 不是 `-p`。** Codex 自己的 `-p` 是 `--profile`（选配置档），不是「继续」。
> `cxt run -c` 映射到 `codex resume --last`；而 `-p` 会去选一个 `[profiles.*]` 块——
> 那是遗留形态，`cxt` 从不生成。

**启动也会先问一句。** `cxt exec` 在真正拉起 Codex **之前**拉一次 `GET {baseUrl}/models`
（2 秒超时），从你的优先级里挑第一个**端点确实还有**的——中转站下线了某个模型，你不用先撞一次
404 才知道：

```console
$ cxt exec relay-a
cxt: 启动前校验：deepseek-chat 不在 https://… 的清单里，本次改用 deepseek-reasoner
```

它**不写任何文件**：受管区照常写你配的首位，换人只作用于**这一次运行**（走 `-c` 差量）。
端点不通、没有 `/models`、清单是空的——这三种都是内网中转站的常态，所以它**一句话都不说**，
按配置启动；只有端点明确答复了、而结论和你的配置不一样，它才开口。关掉它：
`"preflight": false`（见「配置文件」）。`--print` 永远不联网，它会明确告诉你"印出来的是配置
顺序，真跑时可能会换人"。

### 场景 5：告诉 Codex 这个项目是可信的

Codex 第一次在某个目录里干活时会要一次确认。在 `CODEX_HOME` 指向
`profiles/relay-a/` 的窗口里回答「是」，这个回答**只记在那个 profile 下**。换个 token 在
同一个项目里启动，它会再问一遍。`cxt trust` 把这件事提前做掉：

```bash
cxt trust 'D:\work\client-a' --token relay-a
```

```console
$ cxt trust 'D:\work\client-a' --token relay-a
  ✓ 已标记为可信：D:\work\client-a
    profile   relay-a（token relay-a）
    写进      [projects.'D:\work\client-a']  trust_level = "trusted"   ← 第 2 行
```

想把某个 token 名下的全部路径一次做完：

```bash
cxt trust --all --token relay-a      # 该 token 的每一条绑定路径
cxt trust ls                         # 整个矩阵，三态
```

这个方案的代价见下面「坑 → 信任」。那是 `cxt` 唯一会让你多敲键盘的地方，在你手上攒够十个
项目之前值得先看懂。

### 场景 6：别让密钥落盘

任何凭证字段都接受 `${VAR}` 引用：

```bash
cxt token add relay-b --base-url https://relay.example.com/v1 --token '${RELAY_B_TOKEN}'
```

引用在**窗口启动时**从那个窗口的环境里求值。变量没设置时，`cxt exec` **报错并退出 1，
消息里指名变量**——它绝不静默回退成字面量 `${RELAY_B_TOKEN}`，因为那会变成一个恒被拒绝的
假 token，是最难排查的一种失败。

`cxt resolve` 和 `cxt token show` 会**原样打印引用串**并标注已设置/未设置，绝不打印值：

```console
$ cxt token show relay-b
  token relay-b  …\.codex-multi-token\tokens\relay-b.json

  字段          值
  authToken     ${RELAY_B_TOKEN}  （⚠ 未设置）
  baseUrl       https://relay.example.com/v1
  providerId    cxt-relay-b（派生）
  凭证环境变量  CXT_TOKEN_RELAY_B （cxt 启动时注入，§2.2）
  …
```

想把已经写进去的明文换成引用，又**不动 profile 目录**（会话历史因此保留）：

```bash
cxt token edit relay-b --token '${RELAY_B_TOKEN}'
```

> 只认**整串**引用。`"sk-${VAR}"` 和 `"${A}${B}"` 会在**解析时直接报错**，不会被当成字面量
> 悄悄收下。

### 场景 7：换个终端

```bash
cxt run --window      # 强制新窗口（Windows 默认走 wt.exe，否则开新控制台）
cxt run --tab         # 在**名为 cxt 的那个窗口**开标签页——没有就建，关掉了自动重建
cxt run --print       # 什么都不启动——只打印将要执行什么
```

> `--tab` 的目标是**具名**窗口 `cxt`，不是"最近用过的那个窗口"。后者是 `wt -w last` 的语义，
> 症状是标签页悄悄落进你当时正看着的那个窗口里。具名窗口则是按需创建、关掉后自愈。

`--print` 是所有情况的逃生舱：它显示解析出的命令行、注入的环境（打码）、工作目录和受管区，
而且**可以直接粘贴**。如果新窗口开了又立刻关掉，`cxt run --print` 就是你能拿到的全部证据——
因为新窗口里的报错，从启动它的那个窗口是看不见的。

```console
$ cxt run --cwd D:/work/client-a --print
  cxt run --print  — 只打印，不启动

  将要执行 （wt，via direct，tab → cxt 窗口）
    wt.exe -w cxt new-tab --title cxt:relay-a · client-a --suppressApplicationTitle
      -d D:/work/client-a <node> <…>/cxt.js exec relay-a --cwd D:/work/client-a

  注入的环境（按名打码，§5）
  变量               值
  CODEX_HOME         …\.codex-multi-token\profiles\relay-a
  CXT_TOKEN_RELAY_A  sk-****1111
  新标签页的环境 = 当前环境剔掉会话标记（§2.6）。上面这些注入项**不在**标签页的环境里
  ——由窗口内的 cxt exec 现算（§2.7）
```

`--suppressApplicationTitle` 不是装饰而是承重的：没有它，Codex 的 OSC 2 会盖掉标签页标题，
你得到一排写着 `client-a` / `client-b` / `client-c` 的标签，分不出哪个是哪个 token。

### 场景 8：体检

```bash
cxt doctor
```

结果分三档：**阻塞项**（退出码 2）、**警告**、**提示**。它会检查 Codex 是否找得到、终端是否
可解析、绑定是否都指向存在的 token，以及你仓库里的 `AGENTS.md` 会不会被静默截断。

### 场景 9：不想记命令

```bash
cxt          # 在终端里裸敲——就是网页控制台
```

**网页控制台**是一个本地页面，由原生 `<select>` 下拉、勾选框和按钮组成——没有要记的参数，
也不用方向键。和下面的面板是同四个步骤，全在一页上：

| 步骤 | 你做什么 |
|---|---|
| 1 目录 | 敲一个路径，或者从下拉里挑一个；旁边的「复制」把框里的路径抄走，「打开」在文件管理器里打开它 |
| 2 身份 | 挑一个已有 token，或者敲名字 + 密钥新建一个 |
| 3 模型 | **勾你要的**；下方「已选」列表里每条带 `↑` / `↓` 调优先级，勾完点「下一步」 |
| 4 落点 | 看一眼，然后写入——全局 `config.json` 里一条绑定，**外加**那个目录里一份 `.cxt.json` |

**工作台：项目状态，以及「身份 ↔ 服务端地址」成对。** 整页是两栏——**左栏**按状态给你的项目
计数（点一档就是按它筛），**右栏**是一张项目表，每行最左边就是那个项目的状态下拉。

- **一个文件夹就是一个项目。** 给它一档状态（默认五档：未开始 / 进行中 / 受阻 / 已完成 / 失败），
  那一行的颜色跟着变。颜色是**命名色**，明暗模式各一套取值——所以换主题不会失真。
- **状态表由你改。**「管理状态…」能改名、换色、调顺序、增删（1–12 档）。**还有项目在用的状态
  删不掉**，它会告诉你哪些项目还在用。
- **状态单独一个文件**：`~/.codex-multi-token/projects.json`，不进 `config.json`（那份的 schema
  是严格的，多一个键旧版就整份拒载）。键是**归一化之后的**文件夹路径——`D:\work` 与 `d:/work/`
  是同一个项目。第一次标状态时才写盘；对话框底部印着完整路径，想手改也行。
- **身份与地址是一对，两个都是下拉。** 第 2 步显示选中身份自己的地址；换身份，地址跟着走；
  挑一个地址，身份跟着切过去。列表里没有的地址用「自定义…」自己敲——这是给"我们照顾不到的
  情况"留的口子。第 4 步的摘要里会多一行「服务端 → …」，写入时真的写回 `tokens/<名字>.json`
  ——**不会背着你改一个你没看着的字段**。
- **模型那一列是下拉，选一下就写。** 点开、挑一个，走的就是 `cxt model use <id>` 那条路——把
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
    `~/.codex-multi-token/resources.json`（每条带 `url` 与 `fetchedAt`），于是模型下拉里除了
    你声明过的，还能看到服务端真有的那些。**改了某个 token 的服务端地址**，那一行会标
    「地址已变」——清单来自旧地址，按一下「拉取」就换新。这份登记是**看得见、可丢弃**的：
    坏了只退回空表，向导第 3 步仍然每次现拉，**绝不拿旧清单冒充新清单**。
  - **表头多一条概览，每行多一组「用量 · 花费」两列。** 概览（几个 token · 调用 · 输入 ·
    输出 · 花费 · 多久之前算的）加的就是表里那几行，**口径同源**；花费按三级取价：你的
    `prices.json` ＞ 拉取模型清单时端点自报的价 ＞ 没有价。一个模型都查不到价的行，花费写
    「—」，**绝不写 `$0`**；有模型没价时数字后面带 `+`，意思是"这只是下限"。
  - **「重算用量」按钮就是 `cxt pool sync`。** 它读本机 rollout（codex 自己写的那份记账）
    重算整池，落盘 `pool.json` 后页面重新载入——命令行与页面因此看到同一个数。**它只算
    用量、不动状态**（要刷新状态请按「检测」）；一份记录都没找到时它会明说，不把旧数字
    留着充数。
  - **多数时候不必按它。** 打开面板、打开网页控制台、或跑一次 `cxt pool list`，都会先在
    **数字比 `usageSeconds`（默认 600 秒）旧**的时候顺手重算——600 秒这个窗口只管"读本机
    文件"，与探测额度的 300 秒刻意分开。重算也很便宜：**size 与 mtime 都没变**的文件直接从
    `pool-usage-cache.json` 取，所以真正被重读的只有你确实追加过内容的那几份。这份缓存只存
    每个文件的模型明细，**不存 `in` / `out` 合计**——合计永远是合并时现算的，"概览 = 明细
    之和"因此不可能漂。删掉缓存只丢速度、不丢准确度；`--force` 才是全部重读。

**它跑在哪，以及为什么别人访问不到。** `cxt` 起一个 `node:http` 服务，绑在 **`127.0.0.1`**
上——只绑回环，绝不 `0.0.0.0`——端口**随机**，而每个 URL 里都带着一个每次运行现生成的
**32 位 hex 路径口令**。不带它的请求拿到一个空 404（连"这个路径存在"都不说）；`Host` 或
`Origin` 不是这个服务的请求会被拒。没有配置文件、没有缓存、没有锁——端口和口令只在内存里，
随进程一起消失。

**三条退路**：「退出」按钮 · `Ctrl+C` · 空闲 30 分钟（它自己关掉，所以绝不会比你的终端活得久）。

**没有浏览器？** 控制台会打印 URL 并打开它，优先开一个 Chrome/Edge 的**应用窗口**（没有地址栏——
看着像个客户端，不像一个标签页），找不到就退回你的默认浏览器。两条都不行它会说出来，并把 URL
交给你。`--no-open` 只打印 URL、什么都不开，顺带让口令不进终端的回滚缓冲：

```bash
cxt ui --web --no-open   # 只打印 URL，不开任何窗口
```

#### 全屏面板（`cxt ui`）

**同一个 reducer，同样四个步骤——方向键代替鼠标。** 它除了一个终端什么都不需要，所以 SSH、
容器里、或者一台根本没有浏览器的机器上，能用的是它。

```
 当前目录                         │authToken: sk-****abcd        │模型 (2)
 agent_multi_token  → relay-a │baseUrl:   https://oneapi-…   │▸ gpt-5.6-sol
 (未绑定)              → relay-b │source:    路径绑定               │  deepseek-chat
 + 新建…                        │profile:   已建                 │
```

方向键选，**回车启动**（等价 `cxt run`，开新标签页）。★ 启动后**面板留在原地**并显示
「已启动 ✓」——所以你可以连着开好几个窗口。

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
`.cxt.json`（见下）。于是那个目录从此"自带身份"——即使配置被拷到别的机器上。

> **终端被强杀后备用屏残留了？** Windows 上 `taskkill /F`、任务管理器、直接关窗口都是
> 无条件 `TerminateProcess`，**没有回调可以拦**，所以备用屏可能留在那儿。出路是
> `CXT_UI=plain cxt ui`——逐行输出、不进备用屏，同一份内容、同一套按键。见「坑」。

### 场景 10：让项目自己带着配置走

在项目根目录放一份 `.cxt.json`：

```json
{ "version": 1, "token": "relay-a", "models": [{ "id": "gpt-5.6-sol" }] }
```

从那个目录（或它的任何子目录）启动，它就自动生效，**赢过路径绑定**。克隆一份仓库下来、
进目录、`cxt run`——身份对了，不用先想起来 `cxt bind`。

★ 这份文件**天生不含密钥**（`authToken` / `baseUrl` 一律禁止，见下），所以**可以安全提交进
仓库**。团队里每人只要 `cxt token add relay-a --token <自己的 key>`，其余照抄。

---

## 概念

### 四要素

`cxt` 解析的一切最终归结为四样东西：

| 要素 | 落到哪里 |
|------|---------|
| **cwd** | `codex -C <dir>` —— Codex 从哪个目录启动 |
| **authToken** | 一个**注入的环境变量**（`CXT_TOKEN_<NAME>`），由 provider 块的 `env_key` 指名 |
| **baseUrl** | 受管区里的 `[model_providers.<providerId>].base_url` |
| **model** | 受管区里的 `model`；你传 `--model` 时再加一个 `-c model=…` 差量 |

`providerId` 是派生的（`cxt-<token>`），环境变量名是派生的（`CXT_TOKEN_<TOKEN>`，转大写、
`-` → `_`），profile 目录就是 token 名。你配四要素，其余都是推出来的。

> **为什么走环境变量而不是 `experimental_bearer_token`？** 因为这样凭证就**只有一个落点**：
> `tokens/<name>.json`。`config.toml` 是个**双作者**文件——受管区归 `cxt`，其余归你——把明文
> 密钥写进去等于给它多开一个泄漏口。

### 配置级联

每项都从**声明了它的最具体那一层**解析：

```
命令行 --flag  >  项目本地 .cxt.json  >  路径绑定 (bindings[])  >  token 文件  >  全局 defaults  >  内置
```

`cxt resolve` 会打印每一项的胜出来源层。三条刻意的不对称，不是 bug，别「补全」它们：

- **`defaults` 没有 `cwd`。** 级联是 `--cwd` → `token.cwd` → 当前目录。凭空多一层「全局默认
  落点」只会让「我在哪跑」变得难猜。
- **`bindings[]` 没有 `cwd`。** 绑定回答的是「**这个目录**用哪个 token」，不是「去哪个目录」。
- **`bindings[]` 没有 `codexArgs`。** 绑定是「选身份」，不是「调行为」。

**项目本地配置也没有 `cwd` 和 `baseUrl` / `authToken`。** 前者是循环定义（文件本身就是"按路径
找到的"，再声明 cwd 算什么）；后者是**外泄通道**——克隆来的仓库里写一句
`baseUrl: https://evil.com`，你的 key 就被送到那儿去了。详见下面「项目本地配置」。

`token.cwd` **只对 `cxt run` 生效**。`cxt exec` 是一次启动的后半程，那时 cwd 早就定了，
所以它跳过这个字段。

### 路径绑定

一条绑定是 `{ path, token, …覆盖项 }`。按**最长前缀**匹配：`D:\work` 上的绑定在
`D:\work\client-a` 里也生效，而 `D:\work\client-a` 上的绑定在那里赢过它。并列时取数组里
先出现的那条。

路径**按你写的原样比较**。`cxt` **不会**对你的绑定路径调 `path.resolve()` 或 `realpath`——
规范化意味着配置里的路径和你敲进去的悄悄不是同一个，而一条「看起来对但永远匹配不上」的绑定，
比一条明显写错的绑定糟糕得多。

### 项目本地配置（`.cxt.json`）

一份放在**项目目录**里的配置，从 `cwd` **往上逐级找，最近的一份胜出**，直到文件系统根。

```json
{
  "version": 1,
  "token": "relay-a",
  "models": [{ "id": "gpt-5.6-sol" }],
  "catalog": null,
  "env": { "RUST_LOG": "warn" },
  "sandboxMode": "danger-full-access",
  "approvalPolicy": "never",
  "codexArgs": []
}
```

**允许**：`version`（必填）· `token` · `models` · `catalog` · `env` · `sandboxMode` ·
`approvalPolicy` · `codexArgs`

**禁止**，而且每一个都有专门的报错指名道姓：

| 禁掉的键 | 为什么 |
|---|---|
| `authToken` | 凭证只有一个落点：`tokens/<name>.json`。多一个落点就多一份明文副本 |
| `baseUrl` | ★ **这是外泄通道**：克隆来的仓库里写 `baseUrl: https://evil.com`，你的 key 就被送到那儿了 |
| `env.CODEX_HOME` | 隔离原语。项目文件不许改身份落点 |
| `cwd` | 文件本身就是「按路径找到的」，再声明 cwd 是循环定义 |
| `codexBin` / `terminalMode` | 机器级偏好，不是项目级 |

⇒ **副产品：`.cxt.json` 天生不含密钥，可以安全提交进仓库。**

它**绝不会被自动创建**（`cxt` 的惰性纪律）。要么用前端的向导（控制台或面板），要么自己写一份。
`--config <path>` 指向另一份（同一套 schema，跳过向上发现）：
`--config <路径>` 可以指定一份别的（同一份 schema，跳过向上发现）：

```bash
cxt --config ./sub/.cxt.json resolve
```

读不了（JSON 非法 / schema 错）→ **硬报错**，不静默跳过。

### 模型优先级列表

模型列表是**有序**的：`models[0]` 是正在用的，其余是排队的备选。`cxt model next` 轮转，
`cxt model use <id>` 把指定的一个提到首位，`cxt model clear` 删掉该层自己的列表让它重新继承。
网页控制台的资源表里点「模型优先级」能直接拖出这个顺序（`↑` / `↓`），保存后写回该 token 的
`models`——**同一个数组，同一个语义**，没有第二份"优先级"。

启动时 `cxt exec` 会拿这个顺序去问端点一次（见「模型故障转移」）：`models[0]` 不在清单里就
顺位往下挑，挑到的那个只是**这一次运行**的首位，配置里的顺序一个字都不改。

当你对一层做 `use`/`next` 而那层**自己没有列表**时，`cxt` 会**物化**一份——把当前生效的
列表复制进去再运算。这件事会被明确报出来，因为从此那一层不再跟着上层变了：

```console
$ cxt model next --path D:/work/client-a
✓ 已轮转 路径 … 的模型列表
  DS 对话 → DS 推理
ℹ 该层原先没有自己的列表，已**物化**一份（复制当时生效的列表再运算）。
  从此它不再随上层变化；想回退上层用 `cxt model clear --path "D:/work/client-a"`。
```

### 受管区

这是它与「纯环境变量工具」的结构性差异：**Codex 没有用环境变量注入 provider 的通道**，
所以 `cxt` 必须写配置文件。它只写 `profiles/<token>/config.toml` 里一块定义明确的区域：

```toml
# ── 以下是 cxt 受管区 ────────────────────
model = 'deepseek-chat'
model_provider = 'cxt-relay-a'

[model_providers.cxt-relay-a]
name = 'cxt relay-a'
base_url = 'https://api.deepseek.com/'
env_key = 'CXT_TOKEN_RELAY_A'
wire_api = 'responses'
# ── 以下都是你的 ────────────────────────
```

`cxt` 拥有：顶层的 `model`、`model_provider`、`model_catalog_json`，以及整个
`[model_providers.<providerId>]` 段。它**就地**改这几个键——你的注释、你的
`approval_policy`、你的 `[projects.*]`、你的排版，全都原样留着。

`cxt` 明确**从不**写的键（尽管它能写）：`approval_policy`、`sandbox_mode`、
`sandbox_workspace_write.*`、`[projects.*]`、`[profiles.*]` / 顶层 `profile`、
`openai_base_url` / `chatgpt_base_url`，以及那些会覆盖模型元数据的键
（`model_context_window`、`base_instructions`、`service_tier` …）。第一组是**你仓库的安全
策略**——它属于项目自己的 `.codex/config.toml`，不属于一个生成的文件。最后一组则会让一个
生成的文件悄悄改变模型的行为方式。

因为 `model_provider` 指着一个段名，**键和段永远在同一趟里写入**——一个指向不存在段的
`model_provider` 会让整个 `config.toml` 加载失败，那会连你自己的设置一起带下去。

**TOML 里没有 `null`**，所以「还没解析出来」的表达方式是**省略这个键**，绝不是写一个空值。

### 项目信任

Codex 在每个新项目目录上有一道信任闸。那个回答是**按 `CODEX_HOME` 存的**，存在
`[projects.'<path>'] trust_level`——而 `cxt` 给每个 token 一个自己的 `CODEX_HOME`。于是信任
是一个**矩阵，不是一个开关**：(N 个 token) × (M 个项目)。

`cxt` 把它建成三态，因为 Codex 给这个字段三种含义：

| `cxt trust ls` | TOML 里的 `trust_level` | Codex 的 `projects.<path>.trust_level` | Codex 的行为 |
|---|---|---|---|
| `✓ trusted` | `trusted` | `trusted` | 永不询问 |
| `✗ 显式 untrusted` | `untrusted` | `untrusted` | 每次都问（`UnlessTrusted`） |
| `· 从未标记` | *键不存在* | *不存在* | 按需询问（`OnRequest`） |

后两者是真的不同，`cxt` 把它们分得清清楚楚。把项目标成不可信是一个**决定**；从没标过是这个
决定的**缺席**。`cxt trust` **只增不减**——没有 `cxt trust rm`。要撤销一次信任，就写它的
反面：

```bash
cxt trust 'D:\work\client-a' --token relay-a --untrust
```

> **这是本方案唯一真实的代价。** N 个 token × M 个项目 = 最多 N×M 次确认。
> `cxt trust <path> --token <t>` 可以把它们提前做掉，`cxt trust --all --token <t>` 一次做
> 完一个 token 的全部路径，而信任**不继承**——信任了 `D:\work` 不会顺带信任
> `D:\work\client-a`。如果你项目多、token 也多，为一次性的 `cxt trust` 扫尾留点预算。
> `cxt` 其余任何地方都不会让你重复劳动。

---

## 模型故障转移：为什么**中途**是手动的

`cxt` 不会在**对话中途**探测「模型挂了」然后自动切换。`cxt model next` 就是一次按键，这是刻意的：
自动转移意味着工具**替你**判定一次失败是模型问题而不是网络问题、额度问题或提示词问题——
而一个在对话中途悄悄换掉模型的工具，会让一个错误的答案变得极难归因。模型开始报错时，
轮转一下，然后 `cxt run -c` 把会话捡回来。

唯一自动的一步在**启动之前**：`cxt exec` 拉一次 `/models`（见场景 4），从优先级里挑第一个
端点确实还挂着的。它只读、只做一次、失败不阻塞、`defaults.preflight: false` 可关——**它和你
开会话时把模型换掉，是两件不同的事**：前者发生在你按下回车之前，你能看见那一行提示；
后者发生在你看着回答的时候，你只会觉得"它怎么突然变笨了"。

Codex 没有 `--fallback-model`，也没有别的东西可以把这个活交出去。这个列表是一个**人工提拔
栈**，不是自动队列。

凭证同理——但多一句：**一次启动用哪个 token** 仍然在窗口打开**之前**决定、之后绝不改变，所以
你永远能说清哪份输出是哪个身份产生的。这一次决定现在可以交给 **token 池**：没有别的层能解析出
token 时由它补上，或者你带上 `--pool` 让它替你挑（见下面「Token 池」）。被禁的是本节禁的那些：
会话内换、后台健康检查、负载均衡。

---

## Token 池

上面所有内容回答的是"这个目录该跑什么"。池回答的是一个更窄的问题——**下一个窗口该用哪个
token**——而且只在别处都没有答案的时候才回答。

它存在的场景是团队式的：N 把 key、额度每月 1 号自动刷新、没有余额查询接口、不试一下就说不出
哪把已经用完。`token_pool.py`（本次移植的原型）把这个数据放在 Redis 里；在这里真相是一份本地
文件，Redis 只是一个要你显式开启的镜像。

### 池是什么，不是什么

`pool.json` 是**按 token 名索引的状态/用量覆盖层**。它不持有任何凭证：key 唯一的落点仍然是
`tokens/<name>.json`。`cxt token add` 仍然是创建身份的唯一入口，`cxt pool import` 只是
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

没有余额接口，所以"这把 key 还能不能用"只能靠**真发一次最小的请求**来回答。每把 key 花掉
一点点钱，所以池只在必须的时候探：

| 上次状态 | 何时重探 |
|---|---|
| 从没探过，或 `checkedAt` 读不懂 | 立刻 |
| `ok` | 超过 `cacheSeconds`（默认 300 秒） |
| `no_quota` | **跨过月初**——额度 1 号刷新 |
| `invalid` | 24 小时之后 |

`no_quota` 不是"更长的超时"，而是一条不同的规则：额度在 1 号刷新，用一段固定时长去近似它，
会让一把早已恢复的 key 继续躺着被判死刑。

探测只发生在两处：`cxt pool check`（以及控制台上的「检测」），和下面那次启动前的挑选。
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
| `cxt run` 解析不到任何 token | 补上空位（`defaults.pool.auto: false` 可关） |
| `cxt run --pool` | 强制挑一个，**盖过绑定和 `defaults.token`** |
| `cxt run --print` | 显示挑中的是谁、来源是 `pool`——花钱之前先看见 |
| `cxt resolve` | 只提示；只读的诊断命令不该为看一眼而发请求 |
| `cxt exec` | 从不——它跑到的时候 token 早就定了 |

★ **`-c` 守卫。** `-c` 续的是 Codex 在**这个 profile 里**最近一次会话，而 profile 属于某一个
token。如果第二次 `cxt run -c` 挑了另一个 token，它会**静默开一个新会话**，而你以为在续旧的。
所以带 `-c` 时池只用 `lastPick[cwd]`——上次从这个目录挑中的那个 token。没有记录，或记录的那个人
已经不可用 → 报错，并给出两条出路（显式指名一个 token，或者去掉 `-c`）。键是**挑选之前**算出来
的 cwd：挑中之后 `token.cwd` 会改写生效的 cwd，拿改后的值当键，下一次就对不上。

`defaults.pool` 可以关掉或重新调：

```json
{ "defaults": { "pool": { "auto": false, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 } } }
```

`policy: "round-robin"` 不看用量、直接轮转。两种策略都不会中途换人——挑是一次性的决定。

### 命令

```bash
cxt pool list                       # 所有 token + 状态 + 用量；没入池的标出来
cxt pool import tokens.xlsx         # 批量 token add + 建条目；已存在的名字跳过，不覆盖
cxt pool check [name...] [--all] [--force] [--model <m>]
                                    # 立刻探测；不给名字 = --all；--force 无视新鲜度窗口
cxt pool status relay-a no_quota    # 手动覆盖（detail 记 manual）
cxt pool reset relay-a              # 回到 unknown；用量保留
cxt pool sync [--redis <url>] [--force]
                                    # 从本机 rollout 重算用量；带 --redis 时同时写 Redis
                                    # 没变过的文件走缓存，--force 才全部重读
cxt pool pull --redis <url>         # 反向：把 Redis 里的状态拉回本地
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

每次 `cxt exec` 都会在 `sessions/<id>/meta.json` 留下一条记录——token 名、cwd、pid、
开始/结束时间、退出码。写者是 exec 进程自己（它的生命周期就是会话的生命周期）；
`cxt run` 只负责开窗口然后撒手，看不到进程生死。写失败**绝不阻塞**会话。
记录**刻意不存 argv**：`--token-value` 是明文密钥。

`cxt sessions` 把所有窗口列成三态，读时现算：`live`（没有结束时间且 pid 还在）、
`ended`（记了正常退出）、`dead`（没有退出记录、进程也没了）。
它是给人看的概览，不是审计凭证——pid 被复用可能让 dead 记录看起来像 live。

`cxt msg send <id|--token <t>|--all> "正文"` 往一个**在跑**会话的 `inbox/` 投一个消息文件。
消息是**惰性数据**：cxt 里没有任何东西会读它并行动。送达是人工动作——
告诉 agent 自己去跑 `cxt msg inbox`。`msg inbox` 把展示过的消息 rename 进 `read/`
（同目录原子）标记已读；`msg gc` 按年龄清理；`sessions prune` 遇到还有未读的会话
会拒绝删除（除非 `--force`）。`type: info | action-request` 只是给读者的标注——
消息永远不产生执行权。

`cxt resume <会话 id>` 把已关闭 / 崩溃的会话原样重开（同 token、同目录、带 `-c`）。
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

## 命令

| 命令 | 作用 |
|------|------|
| `cxt` | ★ 裸敲（无参数）= **网页控制台**。非 TTY 时退回打印用法、退出 0 |
| `cxt ui` | 显式进全屏**面板**。`CXT_UI=plain cxt ui` = 逐行输出、不进备用屏 |
| `cxt ui --web [--no-open]` | **网页控制台**。没有终端也能开（它不需要终端）。`--no-open` 只打印 URL、不开浏览器；`CXT_UI=web` 等价 |
| `cxt run` | 按解析出的身份开一个新的 Codex 窗口。`--print` 预览，`-c` 续会话，`--pick` 交互式挑选，`--window` / `--tab` 强制终端模式 |
| `cxt exec` | 窗口内的那一半：注入环境并 `exec` Codex。正常情况下你从不手打——`cxt run` 把它放进新窗口的命令行。**启动前先拉一次 `/models`**，按优先级挑第一个确实存在的（见「模型故障转移」） |
| `cxt resolve [path]` | 打印四要素 + 每一项的来源层（凭证打码）。不需要终端、不 spawn、不要求装了 Codex |
| `cxt doctor` | 环境体检：阻塞项 / 警告 / 提示 |
| `cxt ls` | 所有 token、它们的模型、profile 状态、绑定路径 |
| `cxt bind <path> --token <t>` | `ls` / `rm <path>` —— 路径 → token 绑定 |
| `cxt model` | `ls` / `set` / `use` / `next` / `clear` —— 按层操作的优先级列表 |
| `cxt token` | `add` / `show` / `edit` / `rm` —— token 文件。`--label <昵称>` 设展示名，`--label ""` 清除。（列全部用 `cxt ls`） |
| `cxt trust` | `ls`；`cxt trust <path>` 写信任，`--untrust` 写反面，`--all` 一次做完该 token 的全部绑定路径 |
| `cxt profile` | `ls` —— profile 目录、各自的信任条数、**谁是孤儿**；`path <token>` 只打印一行路径 |
| `cxt usage` | 按 token / 项目 / 模型 / 日期统计用量与花费，读的是**本机 rollout 记录**，从不向余额 API 要数。`--days <n>` · `--by …` · `--json` · `--refresh`。价格：手写 `prices.json` > 端点自报价 > `—`，绝不冒充 `$0`（见「用量与花费」） |
| `cxt sessions` | 每个窗口的三态之一——`live` / `ended` / `dead`——外加未读数。`sessions prune [--older-than 30d] [--force]` 删超龄的 ended/dead 记录；在跑的永不删，有未读纸条时拒绝，`--force` 才放行 |
| `cxt resume <id\|前缀>` | 把已关闭/崩溃的窗口叫回来：同 token、同 cwd，带 `-c` 开新标签页。在跑的会话拒绝——它还开着，切回那个窗口即可 |
| `cxt msg` | `send <id\|--token <t>\|--all>` / `inbox [--session <id>] [--peek]` / `gc [--older-than 7d]` —— 给**在跑**的会话留一张纸条，再看回来。消息是**惰性数据**：`cxt` 里没有任何东西因它行动，唯一的送达方式是你告诉 agent 去跑 `cxt msg inbox` |
| `cxt pool` | `list` / `import` / `check` / `status` / `reset` / `sync` / `pull` —— token 池：状态、用量、探测。只有 `sync --redis` 与 `pull --redis` 会连 Redis（见「Token 池」） |

**全局选项**：`--config <path>` 指定一份项目本地配置（跳过向上发现）· `--json` 机器可读输出。

**退出码**（所有命令统一）：

| 码 | 含义 |
|:---:|---|
| `0` | 正常 |
| `1` | 你的输入有问题——未知选项、缺参数、值不合法 |
| `2` | 环境有问题——找不到 Codex、没有终端、配置版本太新 |
| `3` | 完整性——文件在我们脚下被改了，或这次写入会覆盖不该覆盖的东西 |

**脱敏规则**（`--print` / `cxt resolve` / `cxt token show` 共用）：**键名**匹配
`/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` 的值一律打码为「前 3 后 4」——
`sk-aaaa11112222` → `sk-****2222`。这是**按键名**而不是按前缀，因为 `env` 逃生舱里
可能塞着跟 `CXT_TOKEN_*` 毫无关系的密钥。

---

## 配置文件

`cxt` 拥有的一切都在一个目录里：

```
~/.codex-multi-token/
├── config.json                  # version、defaults、bindings[]
├── projects.json                # 项目状态：文件夹 → 状态（控制台里那套；不进 config.json）
├── pool.json                    # token 池：只有状态与用量，**没有凭证**（见下）
├── pool-usage-cache.json        # 重算缓存：每份 rollout 的 size + mtime（删了不影响正确性）
├── tokens/<name>.json           # 一个 token 一个文件——凭证唯一的落点
├── catalogs/<name>.json         # 可选的模型目录覆盖
└── profiles/<token>/            # ← 这个目录就是那个 token 的 CODEX_HOME
    ├── config.toml              #   双作者：受管区归 cxt，其余归你
    ├── config.toml.cxt.bak      #   上面那个文件的首次写入备份
    ├── auth.json                #   Codex 的——cxt 从不读也不写
    ├── sessions/                #   Codex 的
    ├── history.jsonl            #   Codex 的
    ├── log/                     #   Codex 的
    ├── *.sqlite                 #   Codex 的
    └── launch.cmd | launch.sh   #   cxt 写的终端兜底脚本
```

`~/.codex/`——你原本的 `CODEX_HOME`——**在任何情况下都不会被任何 `cxt` 命令读、写或删除**。

一切都是**惰性**创建的：`cxt` 从不预建空的 `profiles/` 或 `catalogs/`。一个目录存在，
是因为有东西真的用到了它。

> **另一份配置不在这个目录里**：项目本地的 `<项目>/.cxt.json`（见「项目本地配置」）。
> 它属于**你的仓库**，不属于 `cxt`——`cxt` 只在向导里、或你显式让它写的时候才碰它。

### `<项目>/.cxt.json`（项目本地配置）

```json
{ "version": 1, "token": "relay-a", "models": [{ "id": "gpt-5.6-sol" }] }
```

从 `cwd` 往上找**最近**的一份，赢过路径绑定。**不含密钥**（`authToken` / `baseUrl` 等一律
禁止，见「项目本地配置」一节），所以可以安全提交进仓库。

**它天生是"项目的"，不是"你的"**：clone 下来就生效，不用先 `cxt bind`。

### `config.json`

```json
{
  "version": 1,
  "defaults": {
    "token": "relay-a",
    "models": [{ "id": "deepseek-chat", "label": "DS 对话" }],
    "terminalMode": "auto",
    "codexArgs": [],
    "preflight": true,
    "pool": { "auto": true, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 }
  },
  "bindings": [
    { "path": "D:\\work\\client-a", "token": "relay-a" }
  ]
}
```

三层各自能写哪些字段（**未知键会被拒绝**，不是被忽略——配置里打错字能立刻发现）：

| 字段 | `defaults` | `tokens/<n>.json` | `bindings[]` |
|---|:---:|:---:|:---:|
| `authToken` / `baseUrl` / `wireApi` | ✅ | ✅ | ✅ |
| `providerId` / `models` / `catalog` / `env` | ✅ | ✅ | ✅ |
| `token`（默认走哪个 token） | ✅ | — | ✅ |
| `cwd` | — | ✅ | — |
| `codexArgs` | ✅ | ✅ | — |
| `sandboxMode` / `approvalPolicy` | ✅ | ✅ | ✅ |
| `terminalMode` / `codexBin` | ✅ | — | — |
| `preflight`（启动前校验，默认 `true`） | ✅ | — | — |
| `pool`（只认 `auto` / `policy` / `cacheSeconds` / `usageSeconds`） | ✅ | — | — |

> `preflight` 只住在 `defaults`：它是**机器级偏好**——写进 token 会让"同一个网关的两个身份
> 行为不一样"，写进 `.cxt.json` 更是让同事的每次启动都多一次网络探测。

`pool` 同理，而且注意它**没有**什么：没有 Redis 地址。地址可能带密码，而 `config.json` 是承重
文件（旧版 `cxt` 读到解析不了的文件会整份拒载），所以它只会从命令行或经环境变量引用进来。

两个秒数**不可互换**：`cacheSeconds` 是探测窗口（发真请求、花一点钱），`usageSeconds`
是重算窗口（读本机 rollout、不花钱）。

### `pool.json`

```json
{
  "version": 1,
  "rr": 4,
  "lastPick": { "C:/work/client-a": "relay-a" },
  "entries": {
    "relay-a": {
      "status": "ok", "detail": "HTTP 200 · 812ms",
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

> ⚠️ **和这里别的东西一样是明文——但它不含任何密钥。** 刻意的：**它一个 `sk` 字段都没有**，
> 池是按 token **名**索引的覆盖层，凭证永远只落在 `tokens/<name>.json` 里。完整说法见「安全说明」。

它是**可重建**的：删掉只丢状态、用量和 `lastPick`，别的一无所失。下一次 `pool check` 把状态
带回来，`pool sync` 从本机 rollout 重算用量。丢掉 `lastPick` 只有一个看得见的后果：`cxt run -c`
不再记得这个目录上次用的是哪个 token，于是它会请你指名一个。

文件不存在不是错误——那只是"还没有任何 token 入池"。手改坏了也不是：池会退化成"全部未知"，
代价只是一次探测。

### `tokens/<name>.json`

```json
{
  "name": "relay-a",
  "label": "阿里中转",
  "authToken": "sk-…",
  "baseUrl": "https://api.deepseek.com/",
  "wireApi": "responses",
  "models": [{ "id": "deepseek-chat", "label": "DS 对话" }]
}
```

token 名会被校验：小写字母、数字、`_`、`-`，1–32 位——它必须能当目录名、也能当环境变量名的
一部分。路径穿越（`..`、分隔符）直接拒绝。

`label` 是**昵称**，可选中、≤32 字、单行，中文与空格都行——它**只用来展示**（网页控制台的
资源表、`cxt token show`）。它不参与身份：不进 profile 目录名、不进环境变量名、不进窗口标题，
改它不会影响任何已经跑起来的东西。`--label ""` 清掉这个键。

`models` 是有序的，**顺序就是优先级**（见「概念 → 模型优先级列表」）。

### `profiles/<token>/config.toml`

两个作者，一个文件。`cxt` 只就地改**受管区**（见「概念」），走原子写入。第一次要写一个已经
存在的文件时，会先把它备份成 `config.toml.cxt.bak`。

如果你手改了受管区，下次启动会把它改回去。`cxt resolve` 会在**写之前**把漂移显示给你看：

```console
$ cxt resolve
  受管区 profiles/relay-a/config.toml
  ⚠ 与当前文件不一致（漂移）——cxt run / cxt exec 会就地修正
    + model = 'deepseek-chat'
    - model = "OLD-STALE-MODEL"
```

---

## 坑

### 面板把终端留在备用屏里了

**症状**：终端看起来"卡住"了、没有光标、敲字有回显但提示符不回来。

**原因**：Windows 上 `taskkill /F`、任务管理器、直接关终端窗口都是无条件
`TerminateProcess`——**没有 `'exit'`、没有回调**，`cxt` 的还原代码根本没机会跑。
（正常退出、`Ctrl+C`、向导中途 `q` 都会还原，那些路径都挂了网。）

**出路**（按顺序试）：

```bash
CXT_UI=plain cxt ui     # ① 逐行模式：不进备用屏，同一份内容、同一套按键
```

② 还是不行就换一个终端窗口，或者 `reset`（POSIX）/ 关掉重开（Windows）。
③ 想彻底避免：裸敲 `cxt`——**网页控制台**——压根不接管你的终端（它是浏览器里的一个页面，
不是你终端里的一个屏）。或者日常就用 `CXT_UI=plain`，或者干脆用 `cxt run` / `cxt resolve`
那套命令。

> 这不是能"修好"的东西——**拦不住的信号没有 API**。所以 `CXT_UI=plain` 不是可选项，
> 是设计的一部分。

### 信任路径：`cxt` 规整的是**写法**，不是**身份**

`cxt trust` 会把你的路径改写成 Codex 唯一认的那种规范写法，并且**在输出里说明**：

```console
$ cxt trust 'D:/work/client-b/' --token relay-b
  ✓ 已标记为可信：D:\work\client-b
    规范化    D:/work/client-b/ → D:\work\client-b
              （Windows 用反斜杠 + 去尾部分隔符 + 剥 \\?\ 前缀——Codex 只认这种写法，
                别的写法**不报错但静默不匹配**，§7.3）
```

所以下面这些都没问题——正斜杠、尾部分隔符、`\\?\` 前缀，以及 `.`/`..` 段都会被规整掉：

```
D:/work/client-a          →  D:\work\client-a
D:\work\client-a\         →  D:\work\client-a
\\?\D:\work\client-a      →  D:\work\client-a
D:\work\..\work\client-a  →  D:\work\client-a
```

它**不**做的是替你判断*你指的是哪个目录*：

- **不做 `realpath`、不解析符号链接。** `cxt` 和 Codex 读的是同一个字面
  `process.cwd()` 字符串。如果你是通过符号链接或 `subst` 盘符进到某个项目的，那么你敲的
  路径就是被写下去的路径。
- **不展开 8.3 短名。** `C:\Users\ALICE~1` 和 `C:\Users\alice` 是同一个目录的两个
  字符串，而 Codex 比的是字符串。`cxt` 能识别出来（用 `fs.realpathSync.native`，它会展开
  短名——普通的 `realpathSync` 不会）并给出**警告**，但绝不替你归一化。
- **没有父目录继承。** 信任了 `D:\work` 不会信任 `D:\work\client-a`。这是 Codex 的规则，
  不是 `cxt` 的，而 `cxt` 不会替你抹平它。
- **大小写不是坑**——Codex 比较时大小写不敏感。
- **信任表里只有一个字段。** `[projects.'<path>']` 里只有 `trust_level`，别的什么都不加。
  别手工加键——Codex 会拒绝未知字段。

`cxt trust ls` 会显示整个矩阵，以及每个格子处在哪个状态。

### `-c` 不是 `-p`

`cxt run -c` → `codex resume --last`。Codex 自己的 `-p` 是 `--profile`，用来选一个
`[profiles.*]` 块——那是遗留形态，**与命令行上的 `-p/--profile` 同时使用时直接硬失败**。
`cxt` 从不生成 `[profiles.*]`，也从不传 `-p`。

`codex resume --last` 的作用域是 `CODEX_HOME + cwd`。因为每个 token 有自己的 `CODEX_HOME`，
窗口 A 里的 `cxt run -c` 不可能捡起窗口 B 的会话——这正是要的效果。

### 孤儿 profile 没有 CLI 出口

`cxt token rm <name>` 删掉 token 文件，但**保留** `profiles/<name>/`，因为那个目录里装着
Codex 的 `auth.json` 和会话历史。结果就是一个**孤儿**：没有 token 的 profile。
`cxt profile ls` 会把它列出来，手工删除的准确命令也在那里——但 `cxt token rm --purge`
要求 token 文件还存在，所以一旦你把 token 删了，那个目录就得你自己动手。
删之前先看清里面有什么。

### `network_access = false` 会静默卡死

如果你的项目级 `.codex/config.toml` 里设了
`sandbox_workspace_write.network_access = false`，而某个工具试图联网，Codex 会**卡住且不报
任何错**。没有任何消息告诉你沙箱是原因。如果 Codex 在一次工具调用后像是冻住了，先查这个
设置，再查别的。

### Windows 上 `codex doctor` 的沙箱那节不反映项目配置

在 Windows 上，`codex doctor` 会报 `filesystem sandbox = restricted` 和
`sandbox backend = disabled`，**即使项目级 `sandbox_mode` 正在生效**。别拿它的 `sandbox.*`
几行去判断你的项目配置有没有被采纳。

### `AGENTS.md` 会被静默截断

Codex 只读你 `AGENTS.md` 的前 `project_doc_max_bytes` 字节（默认 **32768**），**剩下的直接
丢掉**——没有警告、没有报错，模型就是看不到你文件的结尾。`cxt doctor` 会报出来：

```console
$ cxt doctor
  ⚠ AGENTS.md 146903 B > project_doc_max_bytes 32768 B，Codex 将静默截断到第 32768 字节
      超了 114135 B（4.48×）。截断**不报错**——文档后面那几节会像不存在一样，用户只会怀疑自己记错了。
      → 在 config.toml 里把 project_doc_max_bytes 调到 146903 以上（这个键 cxt 不代管，得你自己写）
```

文件更大的话，去配置里调大 `project_doc_max_bytes`。这个键 `cxt` 不代管。

### 新窗口里的报错是看不见的

`cxt run` 把活交给 `wt.exe`，而它是个单实例转发桩：退出码 0 只意味着「转发请求发出去了」，
不意味着「Codex 起来了」。如果新窗口开了又立刻关掉，从启动侧你什么都拿不到。跑
`cxt run --print`，把它打印的命令自己粘到终端里——你会看到真正的报错，而且是在**有那个报错的
窗口里**看到。

### 新会话绝不继承调用方会话的身份

不管你是从哪儿调用的，`cxt run` / `cxt exec` 产出的都是**同一个**会话：

```
新会话环境 = 继承环境（剔掉会话标记）
           → cxt 明确要删掉的变量
           → cxt 的注入项              ← 永远最后生效，所以 `env` 能盖回任何一项
```

这一条是必要的，因为 **Windows Terminal 会把调用方的环境原样转发进新标签页**。
从某个 Codex 会话里跑 `cxt run`，少了这一步，新会话就会顶着父会话的
`CODEX_SESSION_ID` / `CODEX_THREAD_ID`，最糟的是继承它的 `CODEX_SQLITE_HOME`——
把新会话的状态库指到**另一个 token** 的 profile 上。
`CXT_TOKEN_*` 整个命名空间一并清掉也是同一个理由：否则新会话会带着上一个 token 的密钥。

**配置类**变量（`PATH`、`CODEX_MANAGED_BY_NPM`、`RUST_LOG` …）照常继承。判据是
「这个值描述的是不是**某一个正在跑的进程 / 会话**」，不是「它是不是以 `CODEX_` 开头」。
`cxt run --print` 与 `cxt exec --print` 会把**注入什么**和**删掉什么**都印出来。

想自己删掉一个继承来的变量，在 `env` 逃生舱里把它设成**空串**——空串的语义是**删**，
不是"设成空"（这两个在 Windows 和 POSIX 上不是一回事）：

```json
{ "env": { "CODEX_SQLITE_HOME": "" } }
```

### 项目级的 `model_provider` 会被忽略

`cxt` 把 `model_provider` 写在 profile 的 `config.toml` 顶层，Codex 就在那里解析它。你仓库
`.codex/config.toml` 里的 `model_provider` 赢不了——生效的是 profile 的受管区。想让某个项目
用不同的 provider，那是**另一个 token**，不是另一份项目配置。

### 写 `config.toml` 不是并发安全的

写入是原子的（写临时文件再改名），所以崩溃不会留下半个文件。但两个 `cxt` 进程同时写同一个
`config.toml`，仍然可能丢掉其中一次更新。实际含义是：别在同一个 profile 上同时跑
`cxt trust` 和 `cxt run`。

---

## 安全说明

**凭证是明文存储的。** `tokens/<name>.json` 里就是你放进去的东西。`cxt` 不加密它、不混淆它、
也不声称做了这些。如果这不可接受，就用 `${ENV_VAR}` 引用（场景 6），把值留在 shell 环境或
密钥管理器里。

**`cxt token show` 每次都会告诉你这件事**，想忘都难。

**`pool.json` 同样是明文，但它一个凭证都不装。** 它是一张按 token **名**索引的状态/用量
覆盖层，全文件没有 `sk` 字段，`tokens/<name>.json` 仍然是密钥唯一的落盘点。`cxt pool import`
也不是第二个家：它先把密钥走一遍 `token add` 那条路写进 token 文件，然后才记下池条目。

**启动脚本里永远没有密钥。** 当 `cxt` 退回到写 `launch.cmd` / `launch.sh`（没能直接拉起终端
时用的兜底路径），那个脚本里只有命令行——凭证走注入的环境，从不走文件。如果你在会用到脚本
兜底的路径上传了 `--token-value`，`cxt` 会**拒绝并退出 1**，而不是把你的密钥写进磁盘。

**项目自己的配置劫持不了 provider。** 因为 provider 块和 `env_key` 都是 `cxt` 写的，你克隆
下来的仓库里签入的 `.codex/config.toml` 没法把你的凭证重定向到它选的端点——受管区赢，而
`env_key` 永远指向 `CXT_TOKEN_<TOKEN>`，由 `cxt` 从你的 token 文件设置。

**`.cxt.json` 比这更彻底：它连 `baseUrl` 都不许写。** 克隆来的仓库里放一份带
`baseUrl: https://evil.com` 的 `.cxt.json`，`cxt` 会**报错退出**而不是照它说的发请求——
这条键被单独禁掉，理由就是它是一条外泄通道（见「项目本地配置」）。所以那份文件可以放心
签入仓库，而不用担心它变成一根指向别人服务器的管子。

**脱敏是按键名而不是按前缀**，所以 `env` 逃生舱也在覆盖范围内。但这是**展示时**的规则：
它保护你的终端和回滚缓冲，不保护磁盘上的文件。

**网页控制台从不把凭证发给浏览器。** 视图模型里带的是一个打码值和一个**长度**；明文密钥始终
留在服务端进程的内存里，唯一过线的密钥是你自己在表单里敲进去的那个。控制台真正暴露给的是
**你这台机器上的其它页面**——威胁模型是**跨源**，不是"本机的另一个用户"（能读
`tokens/*.json` 的人本来就有那把密钥）。所以才有：只绑回环、每次运行现生成的路径口令、
`Host` / `Origin` 校验，以及一条 `default-src 'none'` 的 CSP。也所以才有 `--no-open`——
如果你不愿意口令出现在进程列表里。

**`~/.codex/` 永远不被触碰。** 任何命令、任何时候，不读、不写、不删。那是你现有 Codex 安装
用的目录，`cxt` 无权过问。

---

## 平台支持

| | 状态 |
|---|---|
| **Windows** | 已实测。`wt.exe` / `cmd.exe` 启动路径、`.cmd` 转发脚本处理、反斜杠信任路径 |
| **macOS** | 已实现，**未在真机验证**——终端探测（`TERM_PROGRAM`）、`/Applications` 相对路径的 codex 查找、AppleScript 启动 |
| **Linux** | 已实现，**未在真机验证**——注意事项同上 |

codex 二进制查找、环境注入、配置级联和 TOML 拼接在构造上都是平台无关的。各平台有差异的是
**终端启动**，而它被隔离在 `src/platform/` 里。

网页控制台的**服务端**那一半在 Windows 上是端到端跑过的——测试套件真的 spawn 一个
`cxt ui --web`、用 HTTP 跟它说话、再把它退掉。**没在真机上验证过**的是：真的开出一个
Chrome/Edge **应用窗口**（断言的是 argv 形状，不是那个窗口）、以及 Windows 防火墙会不会弹窗。
绑回环**应该**永远不弹——但那是推理，不是实测，所以它写在开放问题里，而不是写在这张表里。

### 权限

**`cxt` 不做权限收紧，也不假装做了。** token 文件用的是你 **umask** 给的权限位——`cxt`
从不 `chmod` 它们。在 Windows 上这本来也没意义：那里的 `fs.chmod` 基本是空操作
（Node 把它映射到只读属性上，那跟「谁能读这个文件」毫无关系）。

`cxt token add` 自己会说：

```console
$ cxt token add relay-c --base-url https://x.example.com/ --token 'sk-…'
  ✓ 已创建 token relay-c
    ⚠ 这是**明文**，直接写进了 tokens/<name>.json（§1.4：cxt 不加密存储）。
      ⚠ Windows 上 cxt 不做任何权限收紧（fs.chmod 在这里基本是空操作，§2.11 五）——
        保护它的是你的用户目录 ACL。别把 home 共享给别人。
```

POSIX 上想收紧就自己来：

```bash
chmod 600 ~/.codex-multi-token/tokens/*.json
```

（`cxt` 唯一会 `chmod` 的是兜底脚本 `launch.sh`——`0755`，好让终端能执行它。那是启动要求，
不是安全措施。）

---

## 卸载

```bash
npm uninstall -g codex-multi-token
```

这只删掉命令行工具。你的数据还在，直到你删它：

```bash
# macOS / Linux
rm -rf ~/.codex-multi-token

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.codex-multi-token"
```

删掉 `~/.codex-multi-token/` 会一并删掉你的 token、绑定和每一个 profile 目录——包括存在
每个 profile 里的 Codex 会话历史。

**它不影响 `~/.codex/`。** 你原本的 Codex 安装、它的 `auth.json`、它的会话和历史都在一个
完全独立的目录里，`cxt` 从没写过那里。卸载 `cxt` 之后，你平常的 `codex` 命令跟以前一模一样。

只想删一个 token，不删全部：

```bash
cxt token rm relay-a            # 删 tokens/relay-a.json；保留 profile 目录
cxt token rm relay-a --purge    # 连 profiles/relay-a/ 一起删——会先问，--yes 跳过
```

`--purge` 执行前会警告，因为那个目录里装着 Codex 的 `auth.json` 和该 token 的会话历史，
不只是 `cxt` 自己的数据。

---

## cxt 不做什么

刻意不做，也不在路线图上：

- **不支持外部 GUI。** ChatGPT 桌面端和 VS Code 扩展不认 `-c`，而且共用
  `~/.codex/config.toml`。没有注入通道，就没有可管理的东西。
  （★ 这条禁的是**外部** GUI。`cxt` 自带**两个**界面——本地**网页控制台**（裸 `cxt`）和全屏
  **面板**（`cxt ui`）。两个都不碰 `~/.codex/`，两个都不是"去适配别人的客户端"。）
- **不做会话中的 token 轮询、负载均衡、自动故障转移。** 窗口一开，身份就钉死了，整场会话
  不会再换。**启动之前**挑一次不算：`cxt run` 在需要时从 token 池里挑一个（只要一次），
  `--pool` 也只是让这一次挑覆盖绑定——挑完就不再回头看。启动前那一次 `/models` 校验同理：
  只读、只做一次、失败不阻塞，而且都发生在你按下回车之前。见上面「模型故障转移」「Token 池」。
- **不做代理服务。** `cxt` 不坐在 Codex 和网络之间。
- **不加密存储 token。** 明文，而且它自己会说出来。
- **不修改 Codex 本身。** 不打补丁、不做包装壳、不内置副本。
- **没有余额 API，因为它不存在。** `cxt usage` 读的是**你本机的 rollout 记录**，从不向中转站
  打听额度。真正出网的只有你主动触发的两种：`cxt pool check` 每把 key 发一次**最小请求**
  （这要花一点点钱），以及 `cxt exec` 启动时拉一次 `/models`。没有后台轮询、没有统计爬取、
  没有猜出来的额度。
- **零 npm 运行时依赖。** `dependencies: {}` —— 只用 `node:` 内置模块。**两个前端也都是手写的**：
  面板是 raw mode + ANSI 转义序列（没引 TUI 库），网页控制台是 `node:http` 加一个 `fetch`
  （没引框架、没有构建步骤）。
- **永不写 `~/.codex/`。**
- **不生成 `[profiles.*]`。** 那是 Codex 的遗留形态，与命令行上的 `-p/--profile` 同时使用会
  硬失败。`cxt` 改用「一个 token 一个 `CODEX_HOME`」。

### 两个前端的 v1 边界

- **项目本地配置不许放凭证。** 要新身份走 `cxt token add`。
- **不缓存模型清单。** 每次进第 3 步都重新拉——`cxt` 不记忆任何跨会话的选择。
- **不做主题、不做 diff 渲染、不设 diff 开关。** 留着就会有人打开。
- **面板的 `e` 只改「当前生效那一层」**，不给你层级选择器。想精确指定用
  `cxt model set --global|--token|--path`。（控制台的做法是把那个按钮**置灰**，所以你点不下去、
  也就不会点了才被骂。）
- **不改 `--pick` 的行为。** 新内核只服务面板；`cxt run --pick` 仍是原来那个极简行式选择器。
- **控制台不做拖拽调序。** `↑` / `↓` 够用，而拖拽处理器是一堆没东西能测的代码——前端没有测试
  框架，因为没有依赖。
- **控制台是单用户、只绑回环的**，没有「让别人连进来」的开关。两个标签页都能用；后写赢。
- **面板没有鼠标。** 有鼠标的是控制台。

---

## 设计

完整契约在 [`AGENTS.md`](./AGENTS.md)——上面每一条决定都能追溯到那里某个编号小节，
包括那些在真机（Codex CLI 0.163.0）上验过之后被推翻重写的。

四个承重原语，按依赖顺序：

1. **解析**（`core/resolve.js`）—— 级联。纯函数，无 I/O，无平台。给定一个路径和一份配置，
   产出四要素以及每一项的来源层。
2. **TOML 拼接**（`core/toml-splice.js`）—— **就地**改 `config.toml` 的受管区，其余部分
   逐字节保留。这是双作者文件能成立的原因，也是不引 TOML 库依赖的原因。
3. **启动**（`core/launch-script.js` + `platform/`）—— 把一次解析变成命令行和一个终端。
   按平台隔离；`.cmd` 转发脚本处理和「新窗口还是新标签页」的决定都在这里。
4. **信任**（`core/trust.js`）—— (token × 项目) 矩阵，以及路径写法的规整规则。

分层：`bin → cli → core ← platform`。`core/` 从不读 `process.env`、`process.platform`、
`os.homedir()` 或 `process.cwd()`——它们由调用方注入。`core/store.js` 是唯一明确的例外
（它是唯一允许碰文件系统的 `core/` 模块），而 `cli/main.js` 是唯一读 `process.*` 并构造
上下文的地方。这正是整层解析与拼接能在不 spawn 任何东西的前提下被测出来的原因。

面板把这条纪律**降一级复制**到了 `cli/` 内部：`cli/ui/` 里 `keys.js` / `render.js` /
`app.js` 三个文件是纯的（字节流进、帧和副作用清单出），**只有 `ui/term.js` 碰
`process.stdin` / `process.stdout`**。所以面板的状态机与排版能整层被测，而不必真抢一个终端。

网页控制台则把它**横向**复制了一遍：浏览器那一半（`src/web/`）是当字节发出去的，**一行测试都
没有**，所以它不许搞错的东西全在线的服务端一侧——`commands/ui-web.js` 造视图模型，而
**`platform/serve-web.js` 是唯一 import `node:http` 的文件**（也是唯一装 `SIGINT` 处理器的，
所以上面那句「例外只此一处」继续成立）。两半在一个 JSON 形状上会合，那个形状有测试逐键断言。

```bash
npm test              # node --test —— 2047 项测试，不联网、不需要 Codex
npm run verify:codex  # 对真实 Codex 二进制断言，跑在一次性的 CODEX_HOME 里
```

---

## 许可证

MIT
