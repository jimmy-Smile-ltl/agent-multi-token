// @ts-check
/**
 * 帮助文本。内容即 §5 命令面——改命令先改这里，别让 `--help` 说谎。
 */

export const USAGE = `cmt — 一个会话一个 token 的 Claude Code 多开管理器

把"全局唯一的环境变量组"变成"按路径解析的配置"：
cmt run 在哪个目录跑，就自动套用哪个目录该用的 token / apiUrl / model。
`;

export const COMMANDS_HELP = `
用法：cmt <命令> [选项]

前端
  ui                       交互面板：方向键选，回车启动（§2.12）
                           n 新建（路径→身份→模型→落点）· e 改模型 · d 删绑定
      --web                换成本地**网页控制台**：一张下拉框 + 勾选框的表单
                           （--no-open 只打印 URL，不自动开浏览器）
                           ★ 裸 \`cmt\`（不带参数）在终端里开的就是它；
                             非 TTY 时退回打印本帮助（退出 0，脚本不受影响）
                           ⚠️ 终端被强杀后备用屏可能残留（Windows 拦不住，§7.8⑤）：
                              CMT_UI=plain cmt ui   ← 逐行输出，不进备用屏

会话
  run [<token>]            在 cmt 窗口开新标签页启动 Claude（不带 token 名则按当前目录匹配绑定）
      --cwd <path>         覆盖工作目录（四要素之一）
      --model <id>         覆盖模型（默认取 models[0]）
      --url <u>            覆盖 API 端点
      --pick               从模型列表里交互挑一个
      --pool               无视绑定/配置，从 token 池里挑一个（§2.13 三）
      -c, --continue       转发 claude -c：继续该目录最近一次会话
      --window | --tab     覆盖 defaults.terminalMode：
                           tab（默认）= 在名为 cmt 的专属窗口里开新标签页
                           window     = 每次都开一个新窗口
      --print              只打印将要执行的完整环境与命令，不启动
      -- <参数...>         其余参数原样透传给 claude
  exec [<token>]           内部命令：注入环境后启动 claude（launch 脚本调用）
                           不给 token 就是"纯 defaults 模式"（profile 落 _default）
  resolve [<path>]         ★ 打印该路径解析出的四要素 + 每项来源层（token 打码）

配置
  ls [--json]              token 列表 + 各自 cwd / 模型来源（自己的 / 继承全局的）
  bind <path> [--token <t>] [--url <u>] [--model <id>]
                           新增/更新一条绑定；--model 可重复给，顺序即优先级
  bind ls [--json]         列出全部绑定
  bind rm <path>           删除一条绑定
  token add <name> --token <t> [--base-url <u>] [--cwd <path>] [--auth-mode token|key]
  token rm <name> [--purge] [--yes]
                           默认**保留** profile（登录态与会话历史）；--purge 才连它一起删
  token show <name>        token 打码显示：sk-****abcd
  token edit <name> [--token <v>] [--base-url <u>] [--cwd <p>] [--auth-mode token|key]
                           ★ 改凭证/端点但不动 profile 目录 → 会话历史保留，claude -c 依然有效

模型（人工故障转移）
  model ls [<path>|<token>] [--json]        看生效的优先级列表（标注来自哪一层）
  model set [--global|--token <t>|--path <p>] <id[:label]>...   顺序即优先级，第一个最高
  model use <id> [--global|--token <t>|--path <p>]   ★ 提拔到首位
  model next [--global|--token <t>|--path <p>]       ★ 轮转一位
  model clear [--token <t>|--path <p>]      删掉该层 list → 回退上一层
  slot set [--global|--token <t>|--path <p>] <槽>=<模型id>     槽：opus|sonnet|haiku|fable|subagent
  slot ls  [--global|--token <t>|--path <p>]  看槽位映射（没列出的槽自动填 models[0]）

排查
  profile path <token>     打印 profile 目录（= CLAUDE_CONFIG_DIR，会话历史就存在它下面）
  profile ls               列出全部 profile 目录
  doctor [--cwd <path>]    自检：node / claude / 终端探测 / 四要素完整性 / 绑定悬空引用 / 非 ASCII 路径

用量
  usage [--days <n>] [--by token|project|model|day] [--json] [--refresh]
                           按 token / 项目 / 模型 / 日期统计 token 用量与花费
                           ★ 只读 transcript，价格从 prices.json 取（USD / 百万 token）

Token 池（§2.13）
  pool list                所有 token + 额度状态 + 用量；没入池的标「未入池」
                           ★ 顺手按 usageSeconds 重算过一次期的用量（不是纯只读）
  pool import <csv|xlsx>   批量建 token + 入池（第 1 列名字、第 2 列密钥；已存在的跳过）
  pool check [name...] [--all] [--force] [--model <m>]
                           探测额度：每把 key 发一次**最小的真实请求**（会花一点点钱）
                           不带参数 = 池里的全部；--force 无视新鲜度窗口
  pool status <name> <s>   手动覆盖状态（detail 记 manual）
  pool reset <name>        清状态（回到 unknown），用量保留
  pool sync [--redis <url>] [--force]
                           从本机 transcript 重算用量；带 --redis 时写穿到 Redis
                           ★ 没变过的文件走缓存，--force 才全部重读
  pool pull --redis <url>      反向：把 Redis 里的状态拉回本地
                           ★ 池只是状态/用量覆盖层，**密钥永远只在 tokens/<name>.json**
                           ★ list / check / status / reset / 启动 全程不连 Redis

会话在场（§2.14）
  sessions [--json]        列出窗口会话三态：在跑 / 已退出 / 已断 + 未读数
  sessions prune [--older-than 30d] [--force]
                           删超龄的 ended/dead 记录（在跑的永不删）
                           有未读纸条时保留，--force 才一并删
  resume <会话 id|前缀>     把关闭/崩溃的窗口叫回来：同 token、同 cwd，带 -c 开新窗
                           （live 会话拒绝——它还开着，切回那个窗口即可）
  msg send <id|--token <t>|--all> [--type info|action-request] <正文...>
                           给在跑的会话留一张纸条
                           ★ 工具永不自动送达：让 agent 自己跑 \`cmt msg inbox\`
  msg inbox [--session <id>] [--peek] [--json]
                           看信箱；默认读完即标记已读（--peek 只看不动）
  msg gc [--older-than 7d] 清理超龄消息（inbox 与 read 都算）
                           ⚠️ 消息是惰性数据——收到 ≠ 获得执行权；也不要把密钥贴进消息

全局
  --config <path>          ★ 指定一份项目本地配置（.cmt.json），**跳过向上发现**
  --json                   机器可读输出（ls / resolve / model ls / bind ls / profile / doctor /
                           usage / pool）
  -h, --help               显示帮助
  -v, --version            显示版本
`;

export const EXAMPLES = `
常见用法：

  # 让 D:/work/client-a 下的窗口默认用 relay-a 这个 token
  cmt bind D:/work/client-a --token relay-a

  # 看这个目录到底会用什么（排查第一招）
  cmt resolve

  # 在 cmt 窗口的新标签页里启动（多个 token 共用一个窗口，标题各不相同）
  cmt run

  # 模型挂了 → 提拔下一个优先级 → 同路径重启并续上刚才的会话
  cmt model next
  cmt run -c

  # 换 key 但保留会话历史（别切 token，那是换身份）
  cmt token edit relay-a --token <新 key>
`;
