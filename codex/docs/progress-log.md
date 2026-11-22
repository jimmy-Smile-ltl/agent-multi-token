# 施工进度（历史记录）

> 从 `AGENTS.md` §4.4 移出（2026-10-24）：这份文件受 Codex 的 `project_doc_max_bytes` 上限约束，
> 而这里是按时间累积的**历史记录**——跑过多少条测试、每一步撞出过什么 bug——不是契约。
> 契约本体在 [`../AGENTS.md`](../AGENTS.md) §4.4（实施顺序）与 §4.5（v1 完成定义）。
>
> 新一步完成时**往这里追加**，不要往契约里堆。


| 步 | 状态 | 备注 |
|---|------|------|
| 1–7 | ✅ | 单测全绿（`node --test`） |
| 8 | ✅ | `cxt resolve` 已可用；在隔离假 home 上冒烟验过绑定命中 / 缺项 / 混用告警 / 参数冲突 / 路径穿越，并确认它**不创建任何文件** |
| 9 | ✅ | `catalog.js` + `trust.js` + 单测（**444 条全绿**）+ ★ **真机往返已跑通**：`verify-real-codex.mjs` 第 ⑥ 节逐行复核 §7.3 规则表（26 项全过） |
| 10 | ✅ | `launch-script.js` + 单测（**35 条**）+ ★ **真机跑通**：生成的 `launch.cmd` 真的交给 `cmd.exe` 跑，6 项断言（`%*` 透传 / 带空格参数 / 参数里的 `%` 不被展开 / 参数里的引号 / `cd /d` 跨盘符）。顺带撞出 §7.14 ④ |
| 11a | ✅ | `platform/find-executable.js` + 单测（**55 条**）。纯 JS 不 spawn `which`；`platform` / `env` / `fs` 全注入 ⇒ POSIX 与 Windows 两套规则都在本机跑真断言。顺带撞出 §7.14 ⑤（`statSync` 看不见 App Execution Alias），并给"返回磁盘真实拼写"补了 `readdir` 兜底 |
| 11b | ✅ | `platform/` 全层：`windows.js` / `macos.js` / `linux.js` 三个适配器 + `resolve-terminal.js`（**纯决策**，27 条单测——macOS/Linux 的断言全在本机 Windows 上跑真逻辑）+ `spawn-terminal.js`（唯一无法单测的部分）+ 门面 `index.js`（15 条，含真机断言）。★ **本机弹窗实测已跑通**：`wt` 被选中、`via: 'direct'`、窗口落在**带空格的 cwd** 里——而且 cwd 是**由新窗口自己写回文件**再核对的，不是"看见窗口弹出来就算过"。顺带撞出 §7.3 的 8.3 短名（新增一节 + `looksLikeShortName()` 8 条） |
| 11c | ✅ | `cli/codex-bin.js` + 单测（**38 条**）。四级定位（显式配置 → PATH → 常见路径 → 报错退 2）拆成纯决策 `pickCodexBin()`（可在任意机器上单测）+ 宿主门面 `locateCodexBin()`（写回 `defaults.codexBin`）。★ **真机往返 13/13**：`quoteForCmdShim()` 的转义规则逐例对照"不经 shell 的直接 spawn"基准真相，一字不差。顺带撞出 §7.14 ⑥（Node 拒绝 spawn `.cmd` ⇒ argv 被迫过 cmd 解析；`%VAR%` 是转不了只能报警的硬限制） |
| 11d | ✅ | `cxt exec` 落地：`platform/spawn-foreground.js`（`stdio:'inherit'` + 退出码转发；**被信号终止一律退 1，绝不退 0**）+ `cli/commands/exec.js` + **端到端 17 条**。★ e2e 不是跑 `--print`（那只能证明"我们以为自己会传什么"），而是放一个**假 codex** 把 `env`/`argv`/`cwd` 写下来再逐项断言，且**两种形态各跑一遍**：`.cmd`（真 shim 路径）与 `node.exe`（直接路径，参数逐字节不改写）。★ 顺带钉出 §7.6 订正（`--skip-git-repo-check` 是 `codex exec` 子命令专属，补了会让 `cxt exec` **在任何目录**都启动不了） |
| 11e | ✅ | `cxt run` 落地 + ★ **真机弹窗验收通过**（`scripts/verify-run-real.mjs`，4/4）：窗口真的弹出、落在**带空格**的 `token.cwd`、`CODEX_HOME` 落在该 token 的 profile、凭证注入到了新窗口的进程里、`-C` 到了 codex 手里。断言是**读新窗口写回的文件**，不是"看见窗口弹出来了"。★ 这一轮撞出 §7.14 ⑦：真机抓出**两个**缺陷（直接拉起那条路漏 `exec`、漏 node 解释器），根因是"两处各拼一遍头部"——已按"消灭第二处"修掉（`buildCxtCommandLine()` 单一源头），并补了能同时守住两个缺陷的回归断言（逐行查 `--print`，已验证**两种错法都会让它红**） |
| 面板（§2.14） | ✅ 代码 · ⏳ 真机 | `core/project-config.js` + `core/models-endpoint.js` + `platform/fetch-models.js` + `cli/ui/{keys,render,app,term}.js` + `cli/commands/ui.js` + 裸 `cxt` 入口 + `CXT_UI=plain`。**全量 1403 条全绿 / 238 套**（`ui-e2e.test.js` 十条）。★ **逐行模式的 e2e 抓出五个真缺陷**，其中一个是"最重要的那一行不可用"：<br>① ★★ `probeFor()` 不返回解析出来的 token 名 ⇒ 身份来自**项目本地配置**时，「当前目录」那一行既启动不了也改不了模型（`source` 明明印着「项目本地」，回车却说"没有绑定身份"）——见 §2.14 二；<br>② 绑定行把 token 名当 `argv.token` 喂进去，于是来源印成「命令行」（用户从没在命令行上给过东西）；<br>③ 第 4 步写 `.cxt.json` 缺 `version` ⇒ 在"这个目录还没有 `.cxt.json`"时**必然失败**——而那是最常见的用法；<br>④ 空行被当成"把输入框清空再回车" ⇒ 第 1 步的**预填路径被自己抹掉**（只在输入框已有字时现形）；<br>⑤ 逐行模式没有 `j`/`k` ⇒ `e`/`d` **只能作用在第一项上**（编号那条路 = 移过去 + 回车，而回车 = 启动）。<br>**共同教训**：这五个全是"**状态机与落盘**"层面的，`npm test` 全绿也照样存在——单测覆盖的是每个部件，而缺陷长在**接线**上。**接线必须有端到端的路径**，而 `CXT_UI=plain` 就是那条路径。 |
| 12–13 | ⬜ | |
| 网页控制台（§2.14 十） | ✅ 代码 · ⏳ 真机 | `ui/app.js` 的 `panel` 事件族（含真新增的 `move-model`）+ `platform/serve-web.js`（**62 条**）+ `open-browser.js`（**25 条**）+ `open-path.js`（**11 条**）+ `cli/commands/ui-web.js`（**37 条**）+ `src/web/` 三件 + 接线 + `shared-files.test.js`（**3 条**）+ `ui-e2e` 加宽到 **13 条**。**全量 1571 条全绿 / 270 套**。<br>★ **提取为什么可信**：先把「跑 effect 到静止」那个循环从 `runPlain` 里提成 `makeSession()`，**并让 `runPlain` 改用它**——于是 `ui-e2e` 那 13 条端到端断言**现在同时压着两个前端脚下的同一段驱动**，"控制台会不会把状态搞坏"和终端上问的是同一个问题、同一份代码回答。<br>★★ **e2e 抓出的那个缺陷**（见上面"裸视图"那段）：前端读 `{view, done}` 信封，服务端发的是**裸视图** ⇒ 第一个动作之后整页炸。**前端那一半没有任何测试能碰到**（零依赖 ⇒ 没有前端测试框架），所以补了一条**源码守卫**盯着 `data.view` / `.done ===` / `quitting` 三个词——**这是诚实记账**：抓不到的东西只能换成"盯着那两个词"。<br>★ **顺手补掉两个缺口**：① `source-hygiene` 的 `walk()` 扩展名表加了 `html\|css`——在那之前 `src/web/` 三件**躺在仓库里却一条规则都不受**（四条规则全静默跳过），并给"扫描面覆盖到了"补了断言；② `shared-files.test.js` 是**头一次**有东西真的守着"两个项目逐字一致"（之前纯靠契约那段话 + 人记得跑 `diff`，**一次编辑就能让它漂移而两边全绿**）。 |

> 第 8 步的冒烟测试抓出三个 bug，都已修并补了回归单测：
> ① 受管区出现 `base_url = null`（见 §2.9 的 null 条）→ 四要素不齐时 `cxt resolve` 自己崩；
> ② `--model` 的差量被写进受管区（见 §2.5 的两侧表）；
> ③ `--token ../etc` 报"不存在"而非"名字非法"（见 §2.8 的顺序条）。
> **共同教训**：`cxt resolve` 这种"只读诊断命令"要专门测**退化输入**——
> 它最该干活的场景恰恰是配置本身有问题的时候，而单测容易只覆盖"配置都对"的快乐路径。

> 第 9 步同样抓出四个 bug，其中两个是**会静默炸到用户脸上**的那种：
> ① ★ `priority` 在 `CATALOG_REQUIRED` 里却不在 `CATALOG_DEFAULTS` 里，
> 于是"给已有条目补必填字段"补出个 `undefined`——而 `JSON.stringify` 会把它**整个丢掉**，
> 产物里那个键根本不存在，真机后果是 **Codex 拒绝加载整个 `config.toml`**。
> 修法是 `CATALOG_DERIVED_REQUIRED` + `assertComplete()` 运行时哨兵
> + 一条**常量表一致性守护测试**（这类"两张表脱节"的 bug 只有守护测试能防住）。
> ② `trust.js` 解析顶层键值对时只看单行，于是多行字符串里写着
> `projects."C:\x".trust_level = "trusted"` 会被当成真条目 → 改为整段跳过。
> ③ `catalog.js` 的 `unchanged` 写成了嵌套三元烂码。
> ④ `buildInjection` 把 `catalog` 的**原值**写进受管区，而 §2.4 的样例是 `~/...` 形式 →
> 加 `platform` 参数（与 `home` 同级必填）做 `expandTilde`。
> **共同教训**：`undefined` 在 JSON 里是**会消失**的，所以"补了个默认值"和"补了个 `undefined`"
> 在产物上长得一模一样——凡是"从表里查兜底值"的代码，都要有一条断言守着表本身。
