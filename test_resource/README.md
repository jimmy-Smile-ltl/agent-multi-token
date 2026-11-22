# test_resource —— 联调夹具与 wire API 笔记

给 `cmt`（`claude code/`）和 `cxt`（`codex/`）做真机联调时用的**示例夹具**，以及联调中踩出来的
两条 wire API 约束和三个 Windows 陷阱。

> **仓库里没有任何真实密钥或内网地址。** 本目录按「默认拒绝」忽略（规则见下）：
> 只有这份 `README.md` 和两个 `*.example.json` 会进仓库，其余文件一律留在本地。

---

## 文件

| 文件 | 进仓库？ | 内容 |
|---|---|---|
| `README.md` | ✅ | 本文件 |
| `tokens.example.json` | ✅ | token 夹具模板：`relay-a`(ok) / `relay-b`(no_quota) / `relay-c`(invalid) |
| `endpoints.example.json` | ✅ | 端点 / 模型清单 / 探测方法 / 错误签名模板 |
| `tokens.json` | ❌ 忽略 | 真实夹具（自己准备；结构与 example 一致） |
| `endpoints.json` | ❌ 忽略 | 真实端点（自己准备；结构与 example 一致） |
| `probe.py` / `probe_wire.py` | ❌ 忽略 | 本地探测脚本，读 `tokens.json`。脚本本身不含密钥，但被默认拒绝规则挡住 |

根 `.gitignore` 里的规则（**别改窄**——写成 `tokens.json` 这种窄写法，新文件就漏了）：

```
test_resource/*
!test_resource/README.md
!test_resource/*.example.json
```

新增文件默认被挡住；要让什么进仓库，必须显式加 `!` 行。这个摩擦是故意的。

---

## wire API：cmt 与 cxt 走的是两套协议

| 端点 | 协议 | 谁在用 |
|---|---|---|
| `/v1/messages` | Anthropic Messages | **cmt**（Claude Code 说 Anthropic 协议） |
| `/v1/responses` | OpenAI Responses | **cxt**（Codex 0.59 起只认这个） |
| `/v1/chat/completions` | OpenAI Chat | 只用来判活探测 |

### 两条硬约束

**1. cmt 的 baseUrl 不带 `/v1`，cxt 的必须带 `/v1`。**

两边都自己拼 `/v1/...`（cmt 拼出 `/v1/messages`，cxt 拼出 `/v1/responses`）。
写错就成了 `/v1/v1/...` → 404 `Invalid URL`。

**2. cxt 的 `models[0]` 必须是 OpenAI 系渠道的模型。**

`/v1/responses` 的支持是**按渠道**的，不是全站开关：

- OpenAI 系渠道：原生支持，200。
- 部分第三方渠道（Kimi、Claude 等转售）：`500 not implemented`。

这个坑很隐蔽：那个模型**在 `/models` 清单里**、`/v1/chat/completions` **也通** —— 但**就是不能给
cxt 用**，因为 cxt 只走 responses。光看「这个模型可用」会得出错误结论。
`probe_wire.py` 就是为这条准备的小工具：配 cxt 之前先跑它。

---

## 怎么用

**探测某把 key 是否还活着**（最小 chat 请求，成本可忽略）：

> ⚠️ **别把中文写进 `curl.exe` 的命令行参数。** 本机 shell 把 argv 交给 `curl.exe` 时会做一次
> 编码转换，非 ASCII 字节会被毁掉——`"content":"你好"` 发出去变成 `����`，模型会回你
> 「你的消息是乱码」。**而且失败是静默的**：HTTP 照样 200，只有回复内容不对。
> `<ASCII 转义>` 的写法也坏，只有让 body 从磁盘读才完好。

```bash
# baseUrl 从本地的 endpoints.json 里取（本文件不写死任何地址）
BASE_URL=$(py -c "import json;print(json.load(open('endpoints.json'))['baseUrl'])")

# body 由 Python 写成真正的 UTF-8 文件，curl 从磁盘读（中文完好）
py -c "import json,pathlib;pathlib.Path('body.json').write_bytes(json.dumps({'model':'<model-id>','messages':[{'role':'user','content':'你好'}]},ensure_ascii=False).encode('utf-8'))"
curl -sS "$BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-..." \
  --data-binary @body.json

# 内容全用 ASCII（够判活，最省事）
curl -sS "$BASE_URL/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-..." \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"ping"}]}'
```

`probe.py` 不受这条影响——它用 `json.dumps(...).encode()` 自己拼字节，不经过 argv。

**灌进 cmt / cxt 做联调**（token 文件是它们唯一的设计归宿）：

```bash
# ★ baseUrl 不同！cmt 不带 /v1、cxt 带 /v1（原因见上一节）
#   <host> = endpoints.json 的 baseUrl 去掉结尾的 /v1
cmt token add relay-a --token sk-... --base-url https://<host>
cxt token add relay-a --token sk-... --base-url https://<host>/v1
```

**测故障切换**：`tokens.example.json` 里的 `relay-b`（no_quota）/ `relay-c`（invalid）
就是为这条路径准备的——`cmt model next` / `cxt model next` 之后应轮到下一个候选。

---

## 三个 Windows 陷阱

1. **脚本不写 Unix shebang。** `py` 启动器会解析 `#!` 行，而 `/usr/bin/env python3`
   在部分 Windows 环境里不存在 → `py probe.py` **静默退出 49、零输出**，没有任何报错。
2. **控制台是 GBK（代码页 936）。** 模型回复里带 emoji（😊）会让 `print` 抛
   `UnicodeEncodeError`——**请求其实是成功的，崩在打印上**。脚本在 `main()` 开头把
   stdout/stderr 重配成 UTF-8 解决。
3. **CLI 传参的编码损失是静默的**（见上一节）：HTTP 200 不代表 body 没坏。

`TIMEOUT` 是 60s。单次请求通常几秒，但**冷启动见过 ~15s 量级**——别往下调。

---

## 脱敏约定

`cmt` / `cxt` 自己的约定是按**键名**匹配 `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i`，
打码「前 3 后 4」；`token show` 输出形如 `sk-****abcd`。
任何日志、面板、视图模型都只带打码值，明文只存在于 `tokens/<name>.json`。
