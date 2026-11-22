# codex-multi-token (`cxt`)

**One window, one token.**

[中文文档 →](./README.zh-CN.md)

> **Status: archived (November 2026).** This project is no longer developed. It is published as-is,
> under the MIT license, in case the design or the code is useful. There is no support, no roadmap,
> and no guarantee that it still matches the current versions of Codex CLI. Read it as a design
> document with executable evidence.

Turns *"one machine, one globally-unique `CODEX_HOME`"* into *"an identity resolved by path"*:
whichever directory you run `cxt run` in, that directory's token / base URL / model get applied
to the Codex window it opens. Two client projects, two relays, two models — simultaneously,
in two windows, without editing a config file by hand.

Zero runtime dependencies. Node ≥ 18. Windows / macOS / Linux.

> **Don't want to read docs?** Type bare `cxt` in a terminal — it opens a local **web console**:
> a form of dropdowns and checkboxes. Pick a directory, type a token, fetch the model list, and it
> **writes both config layers at once**; model priority is set by ticking boxes and nudging them
> with ↑↓, and a 「资源」 view edits each token's priority (and its nickname) in place. The window
> is `cxt`'s own — bound to `127.0.0.1` only, unreachable from any other machine.
> Prefer the terminal? `cxt ui` opens the full-screen **panel** (arrow keys; that's the one that
> works over SSH). On a non-TTY, bare `cxt` falls back to printing usage and **exits 0**, so
> scripts are unaffected.

---

## The problem

Codex reads exactly one config file: `$CODEX_HOME/config.toml`, and `CODEX_HOME` defaults to
`~/.codex`. One machine therefore has one identity. Working with a second relay means editing
that file, and editing it back when you're done:

```toml
model = "deepseek-chat"
model_provider = "deepseek"

[model_providers.deepseek]
name = "DeepSeek"
base_url = "https://api.deepseek.com/"
env_key = "DEEPSEEK_API_KEY"
wire_api = "responses"
```

That's a single global switch. It can't say *"this directory is client A's relay, that one is
client B's"*, and it can't hold two of them at once. Setting `DEEPSEEK_API_KEY` in a shell
profile doesn't help either — the *provider block* is what names the key, and there's one of it.

The obvious workaround is to point `CODEX_HOME` at a different directory per shell. That works,
but you're now maintaining N hand-written `config.toml` files, and Codex writes its own state
(`auth.json`, `sessions/`, `history.jsonl`) into each one — so they drift, and the
`model_provider` / `[model_providers.*]` pair has to stay in sync by hand or Codex refuses to
load the file at all.

`cxt` does the same thing, but derives it: a token name comes from the directory you're in, the
`CODEX_HOME` comes from the token name, and the provider block is generated from the token's
`baseUrl` — every time, right before launch, so it can't drift.

---

## Install

### Step 0: install Codex CLI first

```bash
npm install -g @openai/codex
codex --version        # codex-cli 0.163.0
```

`cxt` doesn't bundle Codex; it launches the one you already have. It looks for the binary in
three tiers, and `cxt doctor` tells you which one matched:

1. `defaults.codexBin` in your `config.json` (an explicit override)
2. `PATH` — `codex` (POSIX) / trying each of `PATHEXT` (Windows)
3. The usual install locations (`npm root -g`, `%APPDATA%\npm`, `/usr/local/bin`, …)

None of them match → error, exit 2, listing every path it tried.

```console
$ cxt doctor
  ✓ codex 找到了（定位档 1）：C:\Users\…\AppData\Roaming\npm\codex.cmd
      ★ 是 `.cmd`，要经 `cmd.exe /d /s /c` 调起——Node 18.20+/20.12+ 出于 CVE-2024-27980
        会拒绝直接 spawn 它（§7.14⑥）。cxt 已经这么做了。
```

> **Windows:** `codex` installs as a **`.cmd` shim**, and Node ≥ 18.20 / 20.12 refuses to
> `spawn` a `.cmd` directly (`EINVAL`, from the CVE-2024-27980 fix). `cxt` always routes Windows
> launches through `cmd.exe /d /s /c "…"`. You don't have to do anything — but if you ever
> script around `cxt`, know that a raw `spawn('codex', …)` from your own Node code will fail
> the same way, and that's not a `cxt` bug.

### Then install cxt

**From a checkout.** The package was never published to the npm registry — the project was
archived first — so `npm install -g codex-multi-token` would return a 404:

```bash
cd codex                # from the repo root
npm install -g .        # → `cxt`
cxt --version           # 0.1.0
```

Or run it without installing anything:

```bash
node bin/cxt.js --help
```

---

## Usage guide

Every output below was captured from a real run (machine-specific absolute paths elided with `…`).

### Scenario 1: get one token working

```bash
cxt token add relay-a --base-url https://api.deepseek.com/ --token 'sk-…' --label '阿里中转'
cxt model set --token relay-a 'deepseek-chat:DS 对话' 'deepseek-reasoner:DS 推理'
```

`--label` is a **nickname** for the identity (optional, purely so you can tell them apart — the
identity is always `relay-a`).

The label is joined to the id with a **colon**. If the model id itself contains a colon
(OpenRouter's `…-70b:free`), use `--id <id>` instead — that form does no splitting at all.

`cxt token add --token` takes the **secret itself**. Note the trap: in `cxt token add`, `--token`
is the *key*; in `cxt bind`, `cxt run` and `cxt trust`, `--token` is the *token's name*. Both
read as `--token` and neither accepts the other.

Check what you've got — listing tokens is `cxt ls`, not `cxt token ls`:

```console
$ cxt ls
  token    模型                                     profile  绑定路径
  relay-a  deepseek-chat > deepseek-reasoner (own)  ✓ 已建   D:/work/client-a
  relay-b  gpt-5-codex (own)                        — 未建   D:/work/client-b

  2 个 token · 2 条绑定
```

Then launch:

```bash
cxt run --token relay-a
```

That opens a new terminal window with `CODEX_HOME` pointed at
`~/.codex-multi-token/profiles/relay-a/`, the provider block written into that profile's
`config.toml`, and Codex started against it. Nothing outside that directory was touched.

### Scenario 2: bind a project directory

The point of the tool: stop typing `--token`.

```bash
cd D:\work\client-a
cxt bind . --token relay-a
```

From now on, in that directory *or any subdirectory of it*:

```bash
cxt run          # → relay-a, resolved from where you are
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

`cxt resolve` is the debugging tool: **every field is tagged with the layer it came from**,
so "why is this directory using that token" is answered by reading, not guessing. It needs no
terminal, spawns nothing, and doesn't require Codex to be installed — which is exactly why it's
safe to run when something is broken.

Bindings match by **longest prefix wins**; ties go to whichever was declared first.

### Scenario 3: two projects, two identities, at the same time

```bash
cxt bind D:\work\client-a --token relay-a
cxt bind D:\work\client-b --token relay-b

cxt run --cwd D:\work\client-a     # window 1: relay-a
cxt run --cwd D:\work\client-b     # window 2: relay-b
```

Two windows, two `CODEX_HOME`s, two relays, two models, no interference. Each window's Codex
writes its session history into its own profile directory, so `codex resume --last` inside
window 1 stays in window 1's history.

### Scenario 4: the model list is a failover priority

```bash
cxt model ls                     # what's in effect here, and from which layer
cxt model next                   # rotate to the next one
```

```console
$ cxt model ls D:/work/client-a
  模型优先级 · D:/work/client-a

  #  模型               label
  ▶  deepseek-chat      DS 对话
  2  deepseek-reasoner  DS 推理

  来源层：binding D:/work/client-a
```

When the first model starts erroring, `cxt model next` rotates the list by one and the new head
becomes the model. Rotating repeatedly cycles back to the start — the list is a ring, not a
consumable queue.

If you want to keep the conversation you were just having, relaunch with `-c`:

```bash
cxt run -c        # new window + codex resume --last
```

> ⚠️ **`-c` is not `-p`.** Codex's `-p` is `--profile` (pick a config profile), not "continue".
> `cxt run -c` maps to `codex resume --last`; `-p` would try to select a `[profiles.*]` block —
> a legacy form `cxt` never writes.

**Launch asks one question first.** Before it actually starts Codex, `cxt exec` fetches
`GET {baseUrl}/models` once (2-second timeout) and picks the first entry in your priority list that
the relay **still lists** — when a relay drops a model, you don't have to hit a 404 to find out:

```console
$ cxt exec relay-a
cxt: 启动前校验：deepseek-chat 不在 https://… 的清单里，本次改用 deepseek-reasoner
```

It **writes nothing**: the managed region still holds the model you configured, and the swap applies
to **this run only** (through a `-c` override). Endpoint unreachable, no `/models`, empty list —
all three are everyday life on an intranet relay, so it says **nothing** and starts as configured;
it only speaks up when the endpoint answered and the answer disagrees with your config. Turn it
off with `"preflight": false` (see Configuration files). `--print` never touches the network — it
says so explicitly: what it printed is the configured order, and a real launch may pick differently.

### Scenario 5: tell Codex this project is trusted

Codex asks for confirmation the first time it works in a directory. Answering "yes" in a window
whose `CODEX_HOME` is `profiles/relay-a/` records the answer **for that profile only**. The next
token you launch in the same project asks again. `cxt trust` front-loads it:

```bash
cxt trust 'D:\work\client-a' --token relay-a
```

```console
$ cxt trust 'D:\work\client-a' --token relay-a
  ✓ 已标记为可信：D:\work\client-a
    profile   relay-a（token relay-a）
    写进      [projects.'D:\work\client-a']  trust_level = "trusted"   ← 第 2 行
```

To do a whole token's worth in one go:

```bash
cxt trust --all --token relay-a      # every path bound to that token
cxt trust ls                         # the whole matrix, three-state
```

See **Pitfalls → trust** below; this is the one place where `cxt`'s model costs you real
keystrokes, and it's worth understanding before you have ten projects.

### Scenario 6: keep the key out of the file

Any credential field accepts a `${VAR}` reference instead of a literal:

```bash
cxt token add relay-b --base-url https://relay.example.com/v1 --token '${RELAY_B_TOKEN}'
```

The reference is resolved **when the window launches**, from that window's environment. If the
variable isn't set, `cxt exec` **errors and exits 1, naming the variable** — it never falls back
to the literal string `${RELAY_B_TOKEN}`, because that would become a fake token that's always
rejected and is the single hardest failure to diagnose.

`cxt resolve` and `cxt token show` print the reference **verbatim** plus a set/unset marker, and
never the value:

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

To convert an existing literal into a reference without touching the profile directory (so your
session history survives):

```bash
cxt token edit relay-b --token '${RELAY_B_TOKEN}'
```

> Only whole-string references work. `"sk-${VAR}"` and `"${A}${B}"` are **rejected at parse
> time**, not silently accepted as literals.

### Scenario 7: a different terminal

```bash
cxt run --window      # force a new window (default on Windows: wt.exe, else a new console)
cxt run --tab         # force a tab in the named "cxt" window — created if missing, rebuilt if closed
cxt run --print       # don't launch anything — print exactly what would run
```

> `--tab` targets the window **named** `cxt`, not "the most recently used one". The latter is
> what `wt -w last` means, and its symptom is that your tabs quietly land in whatever window
> you happen to be looking at. A named window is created on demand and self-heals when closed.

`--print` is the escape hatch for everything: it shows the resolved command, the injected
environment (masked), the working directory, and the managed region — and it's **paste-able**.
If a new window opens and immediately closes, `cxt run --print` is the entire evidence you need,
because the new window's errors are invisible from the one you launched it from.

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

`--suppressApplicationTitle` is load-bearing, not cosmetic: without it Codex's OSC 2 sequence
overwrites the tab title and you get a row of tabs reading `client-a` / `client-b` / `client-c`
with no way to tell which token is which.

### Scenario 8: check your setup

```bash
cxt doctor
```

Tiers the findings: **blockers** (exit 2), **warnings**, **prompts**. It checks that Codex is
findable, that a terminal is resolvable, that your bindings point at tokens that exist, and that
your repo's `AGENTS.md` won't be silently truncated.

### Scenario 9: don't want to memorize commands

```bash
cxt          # bare, in a terminal — that's the web console
```

**The web console** is a local page made of native `<select>` dropdowns, checkboxes and buttons —
no flags to remember, no arrow keys. Same four steps as the panel below, all on one page:

| Step | What you do |
|---|---|
| 1 Directory | type a path, or pick one from the dropdown. 「复制」 copies what's in the box; 「打开」 opens that folder in your file manager |
| 2 Identity | pick an existing token, or type a name + key to create a new one |
| 3 Models | **tick the ones you want**; the "selected" list below has ↑ / ↓ to set priority, then 「下一步」 |
| 4 Landing spots | review, then write — a binding in the global `config.json` **and** a `.cxt.json` in that directory |

**A workbench: project status, and each identity paired with its endpoint.** The page is two
columns — the **left rail** counts your projects by status (click one to filter by it), the
**right** is a table of projects whose first column is that project's status dropdown.

- **One folder = one project.** Give it a status (未开始 / 进行中 / 受阻 / 已完成 / 失败 out of the
  box) and the row's color follows. Colors are **named**, with separate light and dark values — so
  a theme switch never distorts them.
- **The status table is yours to edit.** 「管理状态…」 renames, recolors, reorders, adds and deletes
  them (1–12). A status still in use **can't be deleted**, and it tells you which projects use it.
- **Status lives in its own file**: `~/.codex-multi-token/projects.json`, not in `config.json` —
  that file's schema is strict, and one unknown key makes an older version refuse the whole file.
  Keys are the **normalized** folder path, so `D:\work` and `d:/work/` are the same project.
  Nothing is written until you set a status the first time; the dialog prints the full path, and
  editing it by hand is fine.
- **An identity and an endpoint are a pair, and both are dropdowns.** Step 2 shows the endpoint
  that belongs to the selected identity; change the identity and the endpoint follows; pick an
  endpoint and the identity follows. 「自定义…」 lets you type one that isn't listed yet — the
  escape hatch for setups we can't enumerate. Step 4's summary gains a 「服务端 → …」 line, and the
  write really goes back to `tokens/<name>.json` — it never edits a field you didn't see.
- **The models column is a dropdown, and picking one writes.** Choosing a model takes the same path
  as `cxt model use <id>` — the pick is **promoted to the front**, the rest keep their order, and
  the result goes to whichever layer this row **resolves from** (project file / binding / token /
  global default). 「（不声明）」 deletes that layer's `models` key so inheritance takes over again;
  「多个模型…」 at the end of the list opens the old multi-select / reorder / type-it-in panel —
  **nothing was removed**, you just no longer need a button to get there, and ids the list doesn't
  know yet are typed in that panel. The 「改模型」 button is gone: the dropdown and that last item
  each cover half of what it did.
- **A 「资源」 view sits at the top of the left rail.** It is a table with **one row per token** —
  identity · endpoint · model priority · bindings · action.
  - **The identity cell is the token itself**: the masked key (`sk-****aaaa`, monospace) plus a
    **nickname** input. The nickname lives in `tokens/<name>.json` as `label` — Chinese and spaces
    are fine, and it is **display only**: never in the profile directory name, env var name, or
    window title. Clearing the box deletes the key.
  - **The priority cell opens.** Click it for a dialog: `↑` / `↓` to reorder, `×` to drop, and a
    `datalist` input underneath to add one (the fetched list is the candidate set; any id can also
    be typed). Saving writes back the token's own `models` array — **that array *is* the priority**.
    An empty list deletes the key and returns to inheritance; a token that never declared one shows
    a grey 「继承」, one explicitly emptied shows 「（显式空）」.
  - **Two tokens on the same relay can move together.** Tick 「同网关的 N 个 token 一并套用」 in the
    dialog and the server re-derives the group from the **effective endpoint** itself (it does not
    trust a count from the page) and writes each one. The box starts ticked when the group is
    already in sync; leave it unticked to change only this token, and the row is then marked
    「同网关不同」.
  - **A 「＋ 添加 token」 button in the header adds a row in place**, even to an empty table. Name,
    secret (a password box, masked throughout) and an optional endpoint; saving runs the very write
    path wizard step 2 uses, so validation, duplicate names and an empty secret each answer in one
    sentence and **nothing is written when it fails**. The plaintext secret crosses exactly one
    POST; the receipt only ever carries the masked value.
  - **`env` is editable from that table too.** 「环境」 on a row and 「默认环境」 in the header each
    open a dialog with a JSON textarea: the former edits **that token's own layer**, the latter
    `defaults.env` in `config.json` (the fallback every token shares). The box shows **that layer's
    own text**, not the merged four-layer result — merging happens at resolve time. `JSON.parse`
    gives the early feedback in the page; the real check (`normalizeEnv`) is server-side and names
    the offending key — empty key names and non-string values are refused with the **file
    untouched**. A `""` value is meaningful: injection **drops the inherited variable**; saving `{}`
    **deletes the key** and returns to inheritance. Success is judged by the **receipt matching the
    draft**, not by a toast.
  - A row that has never been fetched reads 「未拉取」; 「拉取」 asks `GET {baseUrl}/models` right
    now, and 「全部拉取」 in the header asks every token at once, answering with
    「拉取完成：N 成功 · M 失败」. What comes back is recorded in
    `~/.codex-multi-token/resources.json` (each entry carries its `url` and `fetchedAt`), so the
    model dropdown offers the server's real ids next to the ones you declared. **Change a token's
    endpoint** and that row is marked 「地址已变」 — the list came from the old address; one 「拉取」
    replaces it. The record is **visible and disposable**: a corrupt file falls back to empty,
    wizard step 3 still fetches live every time, and a stale list never stands in for a fresh one.
  - **A summary strip sits above the table, and every row gains 「用量 · 花费」 columns.** The
    strip adds up exactly the rows below it — same source, never a second calculation — and
    shows token count · calls · input · output · spend · how long ago it was computed. Spend is
    priced in three tiers: your `prices.json` > the endpoint's own price (captured when the model
    list was fetched) > no price. A row where no model could be priced writes `—`, **never
    `$0`**; when some models have no price the number carries `+`, meaning it is a lower bound.
  - **The 「重算用量」 button is `cxt pool sync`.** It recomputes the whole pool from the rollouts
    codex wrote locally, persists `pool.json`, and reloads the page — so the CLI and the page
    read the same numbers. **It only touches usage, never status** (press 「检测」 for that), and
    when it finds no records at all it says so instead of leaving stale numbers behind.
  - **You rarely have to press it.** Opening the panel, opening the web console, or running
    `cxt pool list` recomputes first **if the numbers are older than `usageSeconds`** (default
    600) — a 600 s window on reading local files, deliberately separate from the 300 s one for
    probing. Recomputing is cheap: a file whose **size and mtime** are unchanged is served from
    `pool-usage-cache.json`, so only the rollouts you actually appended to are re-read. The
    cache stores per-file model tallies only — never the `in` / `out` totals, which stay derived
    so "the summary equals the sum of its rows" can't drift. Deleting the cache costs speed, not
    accuracy. `--force` re-reads everything.

**Where it runs, and why nobody else can reach it.** `cxt` starts a `node:http` server bound to
**`127.0.0.1`** — loopback only, never `0.0.0.0` — on a **random port**, and every URL carries a
**32-hex path token** minted per run. A request without it gets a bare 404 (not even "this path
exists"); one whose `Host` or `Origin` header isn't this server is refused. No config file, no
cache, no lock — the port and the token live in memory and vanish with the process.

**Three ways out**: the 「退出」 button · `Ctrl+C` · 30 minutes idle (it closes itself, so it never
outlives your terminal).

**No browser?** The console prints its URL and opens it, preferring a Chrome/Edge **app window**
(no address bar — it looks like a client, not a tab) and falling back to your default browser. If
both fail it says so and hands you the URL. `--no-open` prints the URL and opens nothing, which
also keeps the token out of your terminal scrollback:

```bash
cxt ui --web --no-open   # print the URL only; open nothing
```

#### The full-screen panel (`cxt ui`)

**Same reducer, same four steps — arrow keys instead of a mouse.** It needs nothing but a
terminal, which is why it's the one that works over SSH, in a container, or on a machine with no
browser at all.

```
 当前目录                         │authToken: sk-****abcd        │模型 (2)
 agent_multi_token  → relay-a │baseUrl:   https://oneapi-…   │▸ gpt-5.6-sol
 (未绑定)              → relay-b │source:    路径绑定               │  deepseek-chat
 + 新建…                        │profile:   已建                 │
```

Arrow keys to select, **Enter to launch** (same as `cxt run` — opens a new tab). ★ The panel
**stays where it is** afterwards and shows 「已启动 ✓」, so you can open several windows in a row.

| Key | Does |
|---|---|
| `↑` `↓` / `PgUp` `PgDn` / `Home` `End` | move the cursor |
| `Enter` | launch |
| `n` | new-binding wizard (directory → identity → models → landing spots) |
| `e` / `d` | edit the models of this item's **effective** layer / delete this binding |
| `r` / `q` | re-read config / quit |

**The left column holds *launchable items*, not tokens**: the current directory, every binding,
every token no binding references, and `+ 新建…`. The question the panel answers is *"where do I
want to start"* — a token is only part of the answer.

**Wizard step 3 fetches `GET {baseUrl}/models`.** Relays are often on an intranet, or don't
implement the endpoint at all, so a failed fetch offers three ways out: `[r]` retry · `[m]` type an
id by hand · `[s]` skip. **A failed fetch never traps you here.**

**Wizard step 4 writes two places at once**: a binding in the global `config.json`, **and** a
`.cxt.json` in that directory (below). The directory then carries its own identity — even if the
config is copied to another machine.

> **Terminal stuck in the alternate screen after a hard kill?** On Windows, `taskkill /F`, Task
> Manager, and closing the window are all unconditional `TerminateProcess` — **there is no callback
> to intercept**, so the alternate screen can stay behind. The way out is `CXT_UI=plain cxt ui` —
> line-by-line output, no alternate screen, same content, same keys. See Pitfalls.

### Scenario 10: let the project carry its own config

Drop a `.cxt.json` in the project root:

```json
{ "version": 1, "token": "relay-a", "models": [{ "id": "gpt-5.6-sol" }] }
```

Launching from that directory (or anywhere under it) picks it up automatically, and it **wins over
path bindings**. Clone a repo, `cd` in, `cxt run` — the identity is already right, with no need to
remember `cxt bind` first.

★ This file **can never contain a credential** (`authToken` / `baseUrl` are forbidden — see below),
so it is **safe to commit**. Everyone on the team runs
`cxt token add relay-a --token <their own key>` once; the rest is copied.

---

## Concepts

### The four elements

Everything `cxt` resolves comes down to four things:

| Element | Where it ends up |
|---------|-----------------|
| **cwd** | `codex -C <dir>` — which directory Codex starts in |
| **authToken** | an **injected environment variable** (`CXT_TOKEN_<NAME>`), named by the provider block's `env_key` |
| **baseUrl** | `[model_providers.<providerId>].base_url` in the managed region |
| **model** | `model` in the managed region, plus a `-c model=…` override when you pass `--model` |

`providerId` is derived (`cxt-<token>`), the env var name is derived (`CXT_TOKEN_<TOKEN>`,
uppercased, `-` → `_`), and the profile directory is the token name. You configure the four
elements; everything else follows.

> **Why an env var and not `experimental_bearer_token`?** Because the credential then has exactly
> one landing point: `tokens/<name>.json`. `config.toml` is a *dual-author* file — `cxt` owns the
> managed region, you own the rest — and putting a plaintext key in it would create a second
> place for the secret to leak from.

### Config cascade

Each element is resolved from the most specific layer that declares it:

```
命令行 --flag  >  项目本地 .cxt.json  >  路径绑定 (bindings[])  >  token 文件  >  全局 defaults  >  内置
```

`cxt resolve` prints the winning layer for each field. Three deliberate asymmetries, which are
not bugs and shouldn't be "completed":

- **`defaults` has no `cwd`.** The cascade is `--cwd` → `token.cwd` → process cwd. A global
  "where to launch" default would make "where am I running" hard to predict.
- **`bindings[]` has no `cwd`.** A binding answers *"which token for this directory"*, not
  *"go to this directory"*.
- **`bindings[]` has no `codexArgs`.** A binding picks an *identity*, not a *behaviour*.

**The project-local config has no `cwd` either, and no `baseUrl` / `authToken`.** The first would
be circular (the file *is* how the path was found — declaring a cwd on top of that means what?);
the second is an **exfiltration channel** — put `baseUrl: https://evil.com` in a cloned repo and
your key gets sent there. Details under "Project-local config" below.

`token.cwd` applies to `cxt run` only. `cxt exec` is the second half of a launch whose cwd was
already decided, so it skips that field.

### Path bindings

A binding is `{ path, token, …overrides }`. Matching is by **longest prefix**: a binding on
`D:\work` applies inside `D:\work\client-a`, and a binding on `D:\work\client-a` beats it there.
Ties go to whichever appears first in the array.

Paths are compared as written. `cxt` does **not** call `path.resolve()` or `realpath` on your
binding paths — canonicalizing them would mean the path in your config silently differs from the
one you typed, and a binding that *looks* right but never matches is worse than one that's
obviously wrong.

### Project-local config (`.cxt.json`)

A config that lives **in the project directory**. Discovery walks **upward from `cwd`, nearest one
wins**, all the way to the filesystem root.

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

**Allowed**: `version` (required) · `token` · `models` · `catalog` · `env` · `sandboxMode` ·
`approvalPolicy` · `codexArgs`

**Forbidden**, each with its own error that names the key:

| Forbidden key | Why |
|---|---|
| `authToken` | A credential has exactly one landing point: `tokens/<name>.json`. A second one is a second plaintext copy |
| `baseUrl` | ★ **This is an exfiltration channel**: `baseUrl: https://evil.com` in a cloned repo sends your key there |
| `env.CODEX_HOME` | An isolation primitive. A project file must not move where the identity lands |
| `cwd` | The file *is* how the path was found; declaring a cwd on top is circular |
| `codexBin` / `terminalMode` | Machine-level preferences, not project-level |

⇒ **Side benefit: `.cxt.json` can never contain a secret, so it's safe to commit.**

It is **never created automatically** (`cxt`'s laziness discipline). Either use a front-end's
wizard (the console or the panel), or write one yourself. `--config <path>` points at a different
one (same schema, skips the upward search):

```bash
cxt --config ./sub/.cxt.json resolve
```

Unreadable (bad JSON / bad schema) → **hard error**, never a silent skip.

### Model priority list

A model list is **ordered**: `models[0]` is the one in use, the rest are fallbacks in waiting.
`cxt model next` rotates; `cxt model use <id>` promotes a specific one; `cxt model clear` removes
the layer's own list so it inherits again. In the web console, the 「模型优先级」 cell of the
resources table edits that very order (`↑` / `↓`) and saves it back to the token's `models` —
**one array, one meaning**, no second "priority" anywhere.

At launch, `cxt exec` takes that order to the endpoint once (see "Model failover"): if `models[0]`
isn't in the list it walks down the priority and the pick becomes **this run's** head only —
the configured order is left untouched.

When you `use`/`next` a layer that has no list of its own, `cxt` **materializes** one — it copies
the currently-effective list into that layer, then rotates. This is reported explicitly, because
from then on that layer no longer follows its parent:

```console
$ cxt model next --path D:/work/client-a
✓ 已轮转 路径 … 的模型列表
  DS 对话 → DS 推理
ℹ 该层原先没有自己的列表，已**物化**一份（复制当时生效的列表再运算）。
  从此它不再随上层变化；想回退上层用 `cxt model clear --path "D:/work/client-a"`。
```

### The managed region

This is the structural difference from a pure-environment tool: **Codex has no way to inject a
provider via environment variables**, so `cxt` has to write a config file. It writes a
well-defined slice of `profiles/<token>/config.toml` and nothing else:

```toml
# ── managed by cxt ──────────────────────
model = 'deepseek-chat'
model_provider = 'cxt-relay-a'

[model_providers.cxt-relay-a]
name = 'cxt relay-a'
base_url = 'https://api.deepseek.com/'
env_key = 'CXT_TOKEN_RELAY_A'
wire_api = 'responses'
# ── everything else is yours ────────────
```

`cxt` owns: top-level `model`, `model_provider`, `model_catalog_json`, and the whole
`[model_providers.<providerId>]` section. It edits those keys **in place** — your comments,
your `approval_policy`, your `[projects.*]` blocks, your formatting all survive untouched.

Keys `cxt` explicitly **never** writes, even though it could: `approval_policy`, `sandbox_mode`,
`sandbox_workspace_write.*`, `[projects.*]`, `[profiles.*]` / top-level `profile`,
`openai_base_url` / `chatgpt_base_url`, and the model-metadata-overriding keys
(`model_context_window`, `base_instructions`, `service_tier`, …). The first group is **your
repo's security policy** — it belongs in the project's own `.codex/config.toml`, not in a
generated file. The last group would let a generated file silently change how the model behaves.

Because `model_provider` names a section, the key and its section are **always written in the
same pass** — a `model_provider` pointing at a missing section makes the whole `config.toml`
fail to load, which would take down your own settings along with it.

There is **no `null` in TOML**, so "not resolved yet" is expressed by **omitting the key**, never
by writing an empty value.

### Project trust

Codex gates each new project directory behind a trust prompt. That answer is stored **per
`CODEX_HOME`**, in `[projects.'<path>'] trust_level` — and `cxt` gives every token its own
`CODEX_HOME`. So trust is a **matrix, not a flag**: (N tokens) × (M projects).

`cxt` models it as three states, because Codex gives the field three meanings:

| `cxt trust ls` | `trust_level` in the TOML | Codex's `projects.<path>.trust_level` | What Codex does |
|---|---|---|---|
| `✓ trusted` | `trusted` | `trusted` | never asks |
| `✗ 显式 untrusted` | `untrusted` | `untrusted` | asks every time (`UnlessTrusted`) |
| `· 从未标记` | *key absent* | *absent* | asks on request (`OnRequest`) |

The last two are genuinely different and `cxt` keeps them apart. Marking a project untrusted is
a *decision*; never having marked it is the *absence* of one. `cxt trust` only ever adds —
there is no `cxt trust rm`. To undo a trust, write the explicit opposite:

```bash
cxt trust 'D:\work\client-a' --token relay-a --untrust
```

> **This is the scheme's one real cost.** N tokens × M projects = up to N×M confirmations.
> `cxt trust <path> --token <t>` front-loads them, `cxt trust --all --token <t>` does a whole
> token at once, and trust is **not inherited** — trusting `D:\work` does not trust
> `D:\work\client-a`. If you have many projects and many tokens, budget for a one-time `cxt trust`
> sweep per pair. Nothing else about `cxt` asks you to repeat work.

---

## Model failover: why **mid-session** is manual

`cxt` will not detect that a model is down *mid-conversation* and switch for you. `cxt model next`
is one keystroke, and that's the design: automatic failover means deciding *for you* that a
failure is a model problem and not a network problem, a quota problem, or a prompt problem — and
a tool that silently swaps models mid-conversation makes a wrong answer much harder to attribute.
When a model starts failing, rotate, then `cxt run -c` to pick the session back up.

The one automatic step happens **before launch**: `cxt exec` fetches `/models` once (see Scenario
4) and picks the first entry the endpoint still serves. It is read-only, one-shot, never blocking,
and switchable off with `defaults.preflight: false` — **that is a different thing from swapping a
model under a live session**: the former happens before you press Enter and announces itself on
one line; the latter happens while you're reading an answer, and all you'd notice is that the tool
got dumber.

Codex has no `--fallback-model`, so there is nothing to hand the job to. The list is a **manual
promotion stack**, not an automatic queue.

Same reasoning applies to credentials — with one addition. **Which token** a launch uses is still
decided *before* the window opens and never changes afterwards, so you can always tell which
identity produced which output. That one decision can now be delegated to a **token pool**: it
fills a gap when nothing else resolves, or picks for you when you pass `--pool`. See *The token
pool* below. What stays banned is what this section bans: no swapping under a live session, no
background health checks, no load balancing.

---

## The token pool

Everything above answers "what should this directory run". The pool answers a narrower question —
**which token should the next window use** — and only when nothing else has answered it.

It exists for the team case: N keys, a monthly allowance that refills on the 1st, no balance API,
and no way to tell which keys are spent without trying them. `token_pool.py` (the original Python
tool this was ported from) kept that data in Redis; here the truth is a local file and Redis is an
optional mirror you have to ask for.

### What the pool is — and is not

`pool.json` is a **status/usage overlay keyed by token name**. It holds no credential: the only
place a key lands is still `tokens/<name>.json`. `cxt token add` remains the only way to create an
identity; `cxt pool import` is "many `token add`s plus an entry each".

- An entry whose `tokens/<name>.json` no longer exists is **dropped on read** — no error, no
  resurrection.
- A token with no entry is **not pooled**: `pool list` says so, and it is never picked
  automatically. Pooling is an explicit act (`import`, `check <name>`, `status <name> <status>`).
- A missing or hand-broken `pool.json` is not an error — the pool degrades to "everything is
  unknown", which only means everything gets re-probed.

### Six states, one vocabulary

| Status | Label | Meaning |
|---|---|---|
| `ok` | 有余额 | the probe got a 2xx |
| `no_quota` | 无余额 | quota exhausted / arrears |
| `invalid` | 密钥无效 | 401, or a body that says the key is bad |
| `net_fail` | 连不上 | DNS / timeout / TLS — says nothing about the key |
| `other` | 异常 | 5xx, rate limiting, anything unreadable |
| `unknown` | 未检测 | never probed, or cleared |

`net_fail` and `other` are separate on purpose: they are re-probed on different schedules, and
neither one removes a key from the candidate list.

### Probing costs one small request

There is no balance API, so "does this key still work" is answered by **sending one minimal real
request**. That costs a fraction of a cent per key, which is why the pool probes only when it has
to:

| Last status | Re-probe when |
|---|---|
| never, or an unreadable `checkedAt` | now |
| `ok` | older than `cacheSeconds` (default 300) |
| `no_quota` | **a month boundary has passed** — the allowance refills on the 1st |
| `invalid` | after 24 hours |

`no_quota` is not "a longer timeout", it is a different rule: the allowance refills on the 1st, so
a fixed 30-day timer would keep a key marked dead long after it started working again.

Probing happens in exactly two places: `cxt pool check` (and the console's 检测 button), and the
pre-launch pick below. Nothing polls in the background, and a session never re-probes.

### Choosing

Candidates are every entry except `no_quota` and `invalid`, ordered by **total usage ascending**
(`in + out`; call count is deliberately not the key — one call can eat 100k tokens). Ties are
rotated by the `rr` cursor, so an equally-untouched group takes turns.

They are then probed **in order, stopping at the first `ok`** — normally one request, and zero when
the winner's status is still fresh. If none of them works, the launch fails with a list of names
and reasons, never a key.

### When a pick happens

Only before a window opens, never inside one:

| Situation | Behaviour |
|---|---|
| `cxt run` with no token resolvable | fills the gap, unless `defaults.pool.auto: false` |
| `cxt run --pool` | forces a pick, **overriding bindings and `defaults.token`** |
| `cxt run --print` | shows the pick and its `pool` source — see it before it costs anything |
| `cxt resolve` | hints only; a read-only diagnostic doesn't spend a request |
| `cxt exec` | never — it already has a token by the time it runs |

★ **The `-c` guard.** `-c` resumes Codex's last session *for that profile*, and a profile belongs
to one token. Had a second `cxt run -c` picked a different token, it would silently start a **new**
session while you believed you were continuing the old one. So with `-c` the pool uses only
`lastPick[cwd]` — the token it picked last time from this exact directory. No record, or the
recorded token is no longer usable → error, with the two ways out (name a token explicitly, or drop
`-c`). The key is the cwd **as computed before the pick**; the picked token's own `cwd` takes
effect afterwards and would not match next time.

`defaults.pool` turns it off or re-tunes it:

```json
{ "defaults": { "pool": { "auto": false, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 } } }
```

`policy: "round-robin"` ignores usage and just rotates. Neither policy switches anything
mid-session — a pick is a one-time decision.

### Commands

```bash
cxt pool list                       # every token + status + usage; unpooled tokens say so
cxt pool import tokens.xlsx         # batch token add + entry; existing names are skipped, not overwritten
cxt pool check [name...] [--all] [--force] [--model <m>]
                                    # probe now; no names = --all; --force ignores the freshness window
cxt pool status relay-a no_quota    # manual override (detail becomes "manual")
cxt pool reset relay-a              # back to unknown; usage is kept
cxt pool sync [--redis <url>] [--force]
                                    # recompute usage from your local rollouts; --redis also writes to Redis
                                    # unchanged files come from the cache; --force re-reads them all
cxt pool pull --redis <url>         # the reverse: bring Redis's status back into the local file
```

`pool list` / `check` / `status` / `reset` and the launch path **never open a Redis connection**.

### Import: CSV or xlsx

Column 1 is the name, column 2 is the key; a header row is detected and skipped; a `Bearer ` prefix
is stripped; blank rows (Excel loves to leave a few hundred) are skipped per cell, not per row
number. Existing names are **skipped and counted**, never overwritten — that key may be in use
right now. The receipt is `新增 N / 跳过 M`, and it never echoes a key.

Both formats are parsed in-process with `node:zlib` — no spreadsheet dependency.

### Redis is a mirror, not a home

`platform/redis.js` is a small handwritten RESP2 client on `node:net` / `node:tls`, so even this
costs no dependency. It speaks `redis://`, `rediss://` and `unix://`, with `AUTH` (including
`user:pass`) and `SELECT db`.

The rule is one-way: **the local file is the truth.** `--redis` writes through after a successful
local write; if Redis fails you get a warning and the exit code does not change. Only `pool sync
--redis` and `pool pull --redis` connect at all, so a machine without Redis never notices the
feature exists.

### In the web console

Each resource row carries a status pill (a `<select>`, so it is also how you label a key by hand)
with the probe `detail` and time in its tooltip, plus a 检测 button; the header has 全部检测, which
the page loops client-side. Two things worth knowing:

- 检测 **ignores the freshness window** — you clicked it, so it means "look now".
- 全部检测 is N requests and can take minutes. The server does not batch it: one probe can take 10
  seconds, and 18 keys would pin the whole console in "busy".

Both write through the same `pool-store.js` the commands use, and both are local-only.

---

## The session registry and the mailbox

Every `cxt exec` leaves a record under `sessions/<id>/meta.json` — token name, cwd, pid,
start/end time, exit code. It is written by the exec process itself (the one that lives as long
as the session); `cxt run` only spawns and detaches, so it cannot know. A failed write never
blocks a session. The record deliberately stores **no argv**: `--token-value` is a plaintext key.

`cxt sessions` lists every window in one of three states, computed at read time: `live` (no end
time and the pid still answers), `ended` (recorded exit), `dead` (no exit record and the process
is gone). It is an overview, not an audit trail — a reused pid can make a dead record look live.

`cxt msg send <id|--token <t>|--all> "text"` drops one message file into a live session's
`inbox/`. Messages are **inert data**: nothing in cxt reads them and acts. Delivery is a human
step — tell the agent to run `cxt msg inbox` itself. `msg inbox` marks what it shows as read by
renaming the files into `read/` (atomic, same directory); `msg gc` prunes by age, and
`sessions prune` refuses to delete sessions that still hold unread messages unless you pass
`--force`. `type: info | action-request` is a label for the reader — a message never grants
execution rights.

`cxt resume <session-id>` reopens an ended/dead session in a new window — same token, same
directory, `-c`. The session strip also offers the last 24 hours of closed sessions as a compact
"recently closed" line with a one-click resume, and the browser tab title carries the unread count
while the page refreshes itself every 10 seconds — but only while the tab is visible, so the
console's idle exit still works.

The web console shows live sessions as a strip on top of the resources screen, collapsed to one
line when everything is healthy and nothing is unread, with a "mark all read" action per session.

The home screen also opens with a **"needs you" list** that merges three signals: a live session
whose key the pool flagged as dead (no quota / invalid), sessions holding unread messages (closed
ones first), and sessions that last exited with a non-zero code. The server computes every row
*and its buttons* (at most five rows); when everything is healthy the block is simply not shown.

⚠️ Messages are plain JSON, same trust level as `pool.json`: never paste secrets into them.

---

## Commands

| Command | What it does |
|---------|--------------|
| `cxt` | ★ Bare (no arguments) = **the web console**. On a non-TTY it falls back to printing usage and exits 0 |
| `cxt ui` | Enter the full-screen **panel** explicitly. `CXT_UI=plain cxt ui` = line-by-line output, no alternate screen |
| `cxt ui --web [--no-open]` | The **web console**. Works without a terminal too (it doesn't need one). `--no-open` prints the URL and opens nothing; `CXT_UI=web` is equivalent |
| `cxt run` | Launch a new Codex window for the resolved identity. `--print` to preview, `-c` to resume, `--pick` to choose interactively, `--window` / `--tab` to force the terminal mode |
| `cxt exec` | The in-window half: inject the environment and `exec` Codex. Normally you never type this — `cxt run` puts it in the new window's command line. **Fetches `/models` once first** and picks the first priority entry that still exists (see "Model failover") |
| `cxt resolve [path]` | Print the four elements + every field's source layer (credentials masked). No terminal, no spawn, no Codex needed |
| `cxt doctor` | Environment check: blockers / warnings / prompts |
| `cxt ls` | All tokens, their models, profile status, bound paths |
| `cxt bind <path> --token <t>` | `ls` / `rm <path>` — the path → token bindings |
| `cxt model` | `ls` / `set` / `use` / `next` / `clear` — the priority list, per layer |
| `cxt token` | `add` / `show` / `edit` / `rm` — token files. `--label <nickname>` sets the display name, `--label ""` clears it. (Listing them all is `cxt ls`) |
| `cxt trust` | `ls`; `cxt trust <path>` writes trust, `--untrust` writes the opposite, `--all` does every bound path |
| `cxt profile` | `ls` — the profile directories, their trust counts, and which are **orphans**; `path <token>` prints one path |
| `cxt usage` | Usage and cost per token / project / model / day, read from your local rollouts — never from a balance API. `--days <n>` · `--by …` · `--json` · `--refresh`. Prices: hand-written `prices.json` > the endpoint's own quote > `—`, never `$0` (see "Usage and cost") |
| `cxt sessions` | Every window in one of three states — `live` / `ended` / `dead` — plus its unread count. `sessions prune [--older-than 30d] [--force]` drops old ended/dead records; a live one is never pruned, and unread mail blocks it unless `--force` |
| `cxt resume <id\|prefix>` | Reopen an ended/dead window: same token, same cwd, `-c` in a new tab. Refuses a live session — it's still open, just switch to it |
| `cxt msg` | `send <id\|--token <t>\|--all>` / `inbox [--session <id>] [--peek]` / `gc [--older-than 7d]` — leave a note for a **live** session and read it back. Messages are **inert data**: nothing in `cxt` acts on them, and the only delivery is you telling the agent to run `cxt msg inbox` |
| `cxt pool` | `list` / `import` / `check` / `status` / `reset` / `sync` / `pull` — the token pool: status, usage, probing. Only `sync --redis` and `pull --redis` ever touch Redis (see "The token pool") |

**Global options**: `--config <path>` points at a project-local config (skips the upward search) ·
`--json` for machine-readable output.

**Exit codes** (uniform across every command):

| Code | Meaning |
|:---:|---|
| `0` | OK |
| `1` | Your input is wrong — unknown flag, missing argument, bad value |
| `2` | The environment is wrong — Codex not found, no terminal, config version too new |
| `3` | Integrity — a file changed under us, or a write would clobber something it shouldn't |

**Redaction rule** (shared by `--print`, `cxt resolve`, `cxt token show`): any value whose **key**
matches `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` is masked as *first 3, last 4* —
`sk-aaaa11112222` → `sk-****2222`. This is by key, not by prefix, because the `env`
escape hatch can hold secrets that have nothing to do with `CXT_TOKEN_*`.

---

## Configuration files

Everything `cxt` owns lives in one directory:

```
~/.codex-multi-token/
├── config.json                  # version, defaults, bindings[]
├── projects.json                # project status: folder → status (the console's; not in config.json)
├── pool.json                    # token, status + usage only — NO credential (see below)
├── pool-usage-cache.json        # recompute cache: size + mtime per rollout (deletable)
├── tokens/<name>.json           # one file per token — the only place a credential lands
├── catalogs/<name>.json         # optional model catalog overrides
└── profiles/<token>/            # ← this directory is CODEX_HOME for that token
    ├── config.toml              #   dual-author: cxt owns the managed region, you own the rest
    ├── config.toml.cxt.bak      #   first-write backup of the above
    ├── auth.json                #   Codex's — cxt never reads or writes it
    ├── sessions/                #   Codex's
    ├── history.jsonl            #   Codex's
    ├── log/                     #   Codex's
    ├── *.sqlite                 #   Codex's
    └── launch.cmd | launch.sh   #   written by cxt as a fallback terminal path
```

`~/.codex/` — your original `CODEX_HOME` — is **never read, written, or deleted** by any `cxt`
command, under any circumstances.

Everything is created **lazily**: `cxt` never pre-creates an empty `profiles/` or `catalogs/`.
A directory exists because something needed it.

> **One config does *not* live here**: the project-local `<project>/.cxt.json` (see "Project-local
> config"). It belongs to **your repo**, not to `cxt` — `cxt` only touches it from the wizard, or
> when you explicitly ask it to.

### `<project>/.cxt.json` (project-local config)

```json
{ "version": 1, "token": "relay-a", "models": [{ "id": "gpt-5.6-sol" }] }
```

The **nearest** one walking up from `cwd` wins, and it beats path bindings. It **holds no secret**
(`authToken` / `baseUrl` and friends are forbidden — see the "Project-local config" section), so
it's safe to commit.

**It is inherently *the project's*, not *yours***: clone and it applies, with no `cxt bind` first.

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

Which fields each layer accepts (unknown keys are **rejected**, not ignored — a typo in your
config surfaces immediately):

| Field | `defaults` | `tokens/<n>.json` | `bindings[]` |
|---|:---:|:---:|:---:|
| `authToken` / `baseUrl` / `wireApi` | ✅ | ✅ | ✅ |
| `providerId` / `models` / `catalog` / `env` | ✅ | ✅ | ✅ |
| `token` (which token by default) | ✅ | — | ✅ |
| `cwd` | — | ✅ | — |
| `codexArgs` | ✅ | ✅ | — |
| `sandboxMode` / `approvalPolicy` | ✅ | ✅ | ✅ |
| `terminalMode` / `codexBin` | ✅ | — | — |
| `preflight` (launch-time check, default `true`) | ✅ | — | — |
| `pool` (`auto` / `policy` / `cacheSeconds` / `usageSeconds` only) | ✅ | — | — |

> `preflight` lives in `defaults` only: it is a **machine-level preference**. Putting it in a token
> would make "two identities on the same relay behave differently"; putting it in `.cxt.json` would
> hand a colleague one extra network probe on every launch.

The same goes for `pool` — and note what is **not** in it: no Redis URL. It may carry a password,
`config.json` is load-bearing (an older `cxt` refuses a file it can't parse), so the address only
ever arrives on the command line or through an environment reference.

The two second-counts are not interchangeable: `cacheSeconds` is the probing window (a real
request, a little money), `usageSeconds` the usage-recompute window (reading local rollouts, free).

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
      "calls": 12, "in": 32000, "out": 9000,
      "usageAt": "2026-10-31T08:00:00.000Z",
      "models": {
        "deepseek-flash": { "input": 12000, "cacheRead": 20000, "cacheWrite": 0, "output": 9000 }
      }
    }
  }
}
```

> ⚠️ **Plaintext, like everything else here — and yet it holds no secret.** There is no `sk`
> field, by design: the pool is an overlay keyed by token *name*, and `tokens/<name>.json` stays
> the only file a credential ever lands in. See "Security notes" for the full statement.

It is **rebuildable**: delete it and you lose the statuses, the usage counters and `lastPick` —
nothing else. The next `pool check` brings the statuses back; `pool sync` recomputes usage from
your local rollouts. Losing `lastPick` has one visible consequence: `cxt run -c` has no record of
which token last ran from this directory, so it asks you to name one.

A missing file is not an error — it means "nothing is pooled yet". Neither is a hand-broken one:
the pool degrades to "everything is unknown", which only costs a probe.

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

Token names are validated: lowercase letters, digits, `_` and `-`, 1–32 characters — usable as a
directory name and as an environment-variable fragment. Path traversal (`..`, separators) is
rejected outright.

`label` is a **nickname**: optional, ≤32 characters, single line, Chinese and spaces welcome — and
it is **display only** (the web console's resources table, `cxt token show`). It never becomes part
of the identity: not the profile directory, not an env var name, not the window title — changing it
cannot affect anything already running. `--label ""` deletes the key.

`models` is ordered, and **the order is the priority** (see "Concepts → Model priority list").

### `profiles/<token>/config.toml`

Two authors, one file. `cxt` edits only the managed region (see **Concepts**), in place, via an
atomic write. The first time it writes an existing file, it backs it up to `config.toml.cxt.bak`.

If you hand-edit the managed region, the next launch rewrites it. `cxt resolve` shows you the
drift **before** anything is written:

```console
$ cxt resolve
  受管区 profiles/relay-a/config.toml
  ⚠ 与当前文件不一致（漂移）——cxt run / cxt exec 会就地修正
    + model = 'deepseek-chat'
    - model = "OLD-STALE-MODEL"
```

---

## Pitfalls

### The panel left your terminal in the alternate screen

**Symptoms**: the terminal looks "stuck" — no cursor, keystrokes echo but the prompt never returns.

**Cause**: on Windows, `taskkill /F`, Task Manager, and closing the terminal window are all
unconditional `TerminateProcess` — **no `'exit'`, no callback**, so `cxt`'s restore code never gets
to run. (A normal exit, `Ctrl+C`, and `q` mid-wizard all restore; those paths are covered.)

**Ways out** (in order):

```bash
CXT_UI=plain cxt ui     # ① line mode: no alternate screen, same content, same keys
```

② Still stuck? Open a new terminal window, or `reset` (POSIX) / close and reopen (Windows).
③ To avoid it entirely: bare `cxt` — the **web console** — never takes the terminal over in the
first place (it's a page in your browser, not a screen in your terminal). Or use `CXT_UI=plain`
day to day, or skip the panel for the `cxt run` / `cxt resolve` family.

> This is not something that can be "fixed" — **a signal you cannot intercept has no API**. Which
> is why `CXT_UI=plain` isn't an option; it's part of the design.

### Trust paths: `cxt` normalizes the *form*, not the *identity*

`cxt trust` rewrites your path into the one canonical shape Codex accepts, and **says so in its
output**:

```console
$ cxt trust 'D:/work/client-b/' --token relay-b
  ✓ 已标记为可信：D:\work\client-b
    规范化    D:/work/client-b/ → D:\work\client-b
              （Windows 用反斜杠 + 去尾部分隔符 + 剥 \\?\ 前缀——Codex 只认这种写法，
                别的写法**不报错但静默不匹配**，§7.3）
```

So these are all fine — forward slashes, a trailing separator, a `\\?\` prefix, and `.`/`..`
segments are collapsed:

```
D:/work/client-a          →  D:\work\client-a
D:\work\client-a\         →  D:\work\client-a
\\?\D:\work\client-a      →  D:\work\client-a
D:\work\..\work\client-a  →  D:\work\client-a
```

What it does **not** do is decide *which directory you meant*:

- **No `realpath`, no symlink resolution.** `cxt` and Codex both read the same literal
  `process.cwd()` string. If you reach a project through a symlink or a `subst` drive, the path
  you type is the path that gets written.
- **No 8.3 short-name expansion.** `C:\Users\ALICE~1` and `C:\Users\alice` are the same
  directory but different strings, and Codex matches strings. `cxt` detects this (via
  `fs.realpathSync.native`, which expands short names — plain `realpathSync` does not) and emits
  a **warning**, but never normalizes for you.
- **No parent-directory inheritance.** Trusting `D:\work` does not trust `D:\work\client-a`.
  This is Codex's rule, not `cxt`'s, and `cxt` doesn't paper over it.
- **Case is not a trap** — Codex compares case-insensitively.
- **The trust table has exactly one field.** `[projects.'<path>']` gets `trust_level` and nothing
  else. Don't add keys by hand — Codex rejects unknown fields.

`cxt trust ls` shows the whole matrix and which state each cell is in.

### `-c` is not `-p`

`cxt run -c` → `codex resume --last`. Codex's own `-p` is `--profile`, which selects a
`[profiles.*]` block — a legacy form that **hard-fails when combined with `-p/--profile` on the
command line**. `cxt` never generates `[profiles.*]`, and never passes `-p`.

`codex resume --last` is scoped to `CODEX_HOME + cwd`. Since each token has its own
`CODEX_HOME`, `cxt run -c` in window A can't pick up window B's session — which is the point.

### Orphan profiles have no CLI exit

`cxt token rm <name>` deletes the token file but **keeps** `profiles/<name>/`, because that
directory holds Codex's `auth.json` and session history. The result is an **orphan**: a profile
with no token. `cxt profile ls` lists them, and it's also where you'll find the exact command to
delete one by hand — but `cxt token rm --purge` requires the token file to still exist, so once
you've deleted the token, the directory is yours to remove manually. Check what's inside first.

### `network_access = false` hangs silently

If your project-level `.codex/config.toml` sets `sandbox_workspace_write.network_access = false`
and a tool tries to reach the network, Codex **hangs with no error**. There's no message telling
you the sandbox is the reason. If Codex seems frozen right after a tool call, check that setting
before anything else.

### On Windows, `codex doctor`'s sandbox section doesn't reflect project config

`codex doctor` reports `filesystem sandbox = restricted` and `sandbox backend = disabled` on
Windows **even when a project-level `sandbox_mode` is in effect**. Don't use its `sandbox.*`
lines to judge whether your project config is being honoured.

### `AGENTS.md` is truncated silently

Codex reads `project_doc_max_bytes` of your `AGENTS.md` (default **32768**) and **silently
discards the rest** — no warning, no error, the model just never sees the end of your file.
`cxt doctor` flags it:

```console
$ cxt doctor
  ⚠ AGENTS.md 146903 B > project_doc_max_bytes 32768 B，Codex 将静默截断到第 32768 字节
      超了 114135 B（4.48×）。截断**不报错**——文档后面那几节会像不存在一样，用户只会怀疑自己记错了。
      → 在 config.toml 里把 project_doc_max_bytes 调到 146903 以上（这个键 cxt 不代管，得你自己写）
```

Raise `project_doc_max_bytes` in your config if your `AGENTS.md` is bigger. `cxt` doesn't manage
that key.

### Errors in the new window are invisible

`cxt run` hands off to `wt.exe`, which is a single-instance stub: exit 0 means *"the hand-off
request was sent"*, not *"Codex started"*. If the new window opens and immediately closes, you
get nothing from the launching side. Run `cxt run --print` and paste the command it prints into
a terminal yourself — you'll see the real error, and you'll see it in the window that has it.

### A new session never inherits the calling session's identity

`cxt run` / `cxt exec` produce the **same** session no matter where you invoke them from:

```
new session env = inherited env (session markers stripped)
                → variables cxt explicitly deletes
                → cxt's injections          ← always last, so `env` can override anything
```

This matters because **Windows Terminal forwards the calling process's environment to the new
tab verbatim**. Run `cxt run` from inside a Codex session and, without this step, the new
session would wear the parent's `CODEX_SESSION_ID` / `CODEX_THREAD_ID` and — worst of all —
inherit its `CODEX_SQLITE_HOME`, pointing the new session's state at *another token's* profile.
`CXT_TOKEN_*` is cleared as a whole namespace for the same reason: the new session would
otherwise carry the previous token's key alongside its own.

Configuration-shaped variables (`PATH`, `CODEX_MANAGED_BY_NPM`, `RUST_LOG`, …) are **kept**.
The criterion is *"does this value describe one specific running process or session?"* — not
*"does it start with `CODEX_`"*. Both `cxt run --print` and `cxt exec --print` show what gets
injected *and* what gets deleted.

To delete an inherited variable yourself, set it to the **empty string** in the `env` escape
hatch — that means *delete*, not *set to empty* (the two differ between Windows and POSIX):

```json
{ "env": { "CODEX_SQLITE_HOME": "" } }
```

### A project-level `model_provider` is ignored

`cxt` sets `model_provider` at the top level of the profile's `config.toml`, and Codex resolves
it there. A `model_provider` in your repo's `.codex/config.toml` doesn't win — the profile's
managed region is what's in effect. If you need a project to use a different provider, that's a
different *token*, not a different project config.

### Writing to `config.toml` isn't concurrency-safe

Writes are atomic (write-temp-then-rename), so a crash can't leave a half-written file. But two
`cxt` processes writing the same `config.toml` at the same time can still lose one update. In
practice this means: don't run `cxt trust` and `cxt run` in the same profile simultaneously.

---

## Security notes

**Credentials are stored in plaintext.** `tokens/<name>.json` holds whatever you put there.
`cxt` does not encrypt it, does not obfuscate it, and does not claim to. If that's not
acceptable, use a `${ENV_VAR}` reference (Scenario 6) and keep the value in your shell
environment or a secret manager instead.

**`cxt token show` tells you this every time**, so it's hard to forget.

**`pool.json` is plaintext too — and holds no credential.** It is a status/usage overlay keyed by
token *name*; there is no `sk` field anywhere in it, and `tokens/<name>.json` remains the only file
a key is ever written to. `cxt pool import` is not a second home either: it writes the key through
the same `token add` path first, then records the entry.

**Launch scripts never contain secrets.** When `cxt` falls back to writing a `launch.cmd` /
`launch.sh` (used when no terminal could be spawned directly), that script contains the command
line only — the credential travels through the injected environment, never through the file. If
you pass `--token-value` on a path that would need the script fallback, `cxt` **refuses and exits
1** rather than write your key to disk.

**A project's own config can't hijack the provider.** Because `cxt` writes the provider block and
the `env_key` itself, a checked-in `.codex/config.toml` in a repo you cloned can't redirect your
credential to an endpoint of its choosing — the managed region wins, and `env_key` always points
at `CXT_TOKEN_<TOKEN>`, which `cxt` sets from your token file.

**`.cxt.json` goes further: it can't even name a `baseUrl`.** Drop a `.cxt.json` with
`baseUrl: https://evil.com` into a repo you cloned and `cxt` **errors out** instead of sending
requests where it says — that key is banned on its own, precisely because it's an exfiltration
channel (see "Project-local config"). Which is why the file is safe to commit: it can't turn into
a pipe pointing at someone else's server.

**Redaction is by key name, not by prefix**, so the `env` escape hatch is covered too. But it's a
display-time rule: it protects your terminal and your scrollback, not the file on disk.

**The web console never sends a credential to the browser.** The view model carries a masked value
and a *length*; the plaintext key stays in the server process's memory, and the only key that
crosses the wire is the one you typed into the form yourself. What the console *is* exposed to is
**other pages on your machine** — the threat model is cross-origin, not "another user on this box"
(anyone who can read `tokens/*.json` already has the key). Hence: loopback binding, the per-run
path token, the `Host` / `Origin` checks, and a CSP of `default-src 'none'`. Hence also
`--no-open`, if you'd rather the token never showed up in a process list.

**`~/.codex/` is never touched.** Not read, not written, not deleted, by any command, ever.
That's the directory your existing Codex install uses; `cxt` has no business in it.

---

## Platform support

| | Status |
|---|---|
| **Windows** | Tested. `wt.exe` / `cmd.exe` launch paths, `.cmd` shim handling, backslash trust paths |
| **macOS** | Implemented, **not verified on real hardware** — terminal detection (`TERM_PROGRAM`), `/Applications`-relative codex discovery, AppleScript launch |
| **Linux** | Implemented, **not verified on real hardware** — same caveats |

The `codex` binary lookup, the environment injection, the config cascade and the TOML splicing
are platform-neutral by construction. What differs per platform is *terminal launching*, and
that's isolated in `src/platform/`.

The web console's **server** half is exercised end-to-end on Windows — the suite spawns a real
`cxt ui --web`, talks to it over HTTP, and quits it. What is *not* verified on real hardware:
opening an actual Chrome/Edge **app window** (the argv shape is asserted; the window isn't), and
whether Windows' firewall stays quiet. Loopback binding *should* never prompt — but that's
reasoning, not a measurement, and it's written down as an open question rather than a fact.

### Permissions

**`cxt` does not tighten file permissions, and doesn't pretend to.** Token files are created
with whatever mode your **umask** gives them — `cxt` never `chmod`s them. On Windows it wouldn't
mean anything anyway: `fs.chmod` there is essentially a no-op (Node maps it onto the read-only
attribute, which has nothing to do with who can read the file).

`cxt token add` says so itself:

```console
$ cxt token add relay-c --base-url https://x.example.com/ --token 'sk-…'
  ✓ 已创建 token relay-c
    ⚠ 这是**明文**，直接写进了 tokens/<name>.json（§1.4：cxt 不加密存储）。
      ⚠ Windows 上 cxt 不做任何权限收紧（fs.chmod 在这里基本是空操作，§2.11 五）——
        保护它的是你的用户目录 ACL。别把 home 共享给别人。
```

On POSIX, tighten it yourself if you want it:

```bash
chmod 600 ~/.codex-multi-token/tokens/*.json
```

(The one thing `cxt` *does* chmod is the `launch.sh` fallback script — `0755`, so the terminal
can execute it. That's a launch requirement, not a security measure.)

---

## Uninstall

```bash
npm uninstall -g codex-multi-token
```

That removes the CLI. Your data stays until you delete it:

```bash
# macOS / Linux
rm -rf ~/.codex-multi-token

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.codex-multi-token"
```

Deleting `~/.codex-multi-token/` removes your tokens, bindings, and every profile directory —
including the Codex session history stored inside each one.

**It does not affect `~/.codex/`.** Your original Codex install, its `auth.json`, its sessions
and its history are in a completely separate directory that `cxt` never wrote to. Uninstalling
`cxt` leaves your normal `codex` command working exactly as it did before.

To remove one token without deleting everything:

```bash
cxt token rm relay-a            # deletes tokens/relay-a.json; keeps the profile directory
cxt token rm relay-a --purge    # also deletes profiles/relay-a/ — asks first, --yes to skip
```

`--purge` warns before it runs, because that directory holds Codex's `auth.json` and its session
history for that token, not just `cxt`'s own data.

---

## What cxt doesn't do

By design, and not on the roadmap:

- **No *external* GUI support.** The ChatGPT desktop app and the VS Code extension don't honour
  `-c` and share `~/.codex/config.toml`. There is no injection channel, so there's nothing to
  manage. (★ This bans **external** GUIs. `cxt` ships **two** of its own — the local **web
  console** (bare `cxt`) and the full-screen **panel** (`cxt ui`). Neither touches `~/.codex/`,
  and neither is "adapting to someone else's client".)
- **No token polling, load balancing, or *mid-session* failover.** A pick from the token pool
  happens **before** the window opens, once, and never changes afterwards — so you can still tell
  which identity produced which output. Nothing polls in the background; a session never looks at
  the pool again. The one pre-launch `/models` check doesn't count either — read-only, one-shot,
  never blocking. See *Model failover* and *The token pool* above.
- **No proxy service.** `cxt` doesn't sit between Codex and the network.
- **No encrypted token storage.** Plaintext, and it says so.
- **No modifying Codex itself.** No patches, no wrapper shims, no vendored copy.
- **No balance API, because there isn't one.** `cxt usage` reads *your local rollouts* — it never
  asks the relay anything. The only outbound requests are the ones you trigger: `cxt pool check`
  sends one minimal request per key (that costs a little money), and `cxt exec` fetches `/models`
  once at launch. No statistics are scraped, no quota is inferred, nothing runs on a schedule.
- **No npm runtime dependencies.** `dependencies: {}` — `node:` builtins only. **Both front-ends
  are hand-written too**: the panel is raw mode + ANSI escapes (no TUI library), and the web
  console is `node:http` plus one `fetch` (no framework, no build step).
- **Never writes `~/.codex/`.**
- **No `[profiles.*]` generation.** That's Codex's legacy form; it hard-fails when combined with
  `-p/--profile` on the command line. `cxt` uses one `CODEX_HOME` per token instead.

### The front-ends' v1 boundaries

- **A project-local config may not hold a credential.** For a new identity, use `cxt token add`.
- **No caching of the model list.** Step 3 refetches every time — `cxt` remembers nothing across
  sessions.
- **No themes, no diff rendering, no diff toggle.** Leave one in and someone turns it on.
- **The panel's `e` edits only the *effective* layer**; there's no layer picker. To be precise, use
  `cxt model set --global|--token|--path`. (The console greys the button out instead, so you
  can't press it and then get told off.)
- **`--pick` behaviour is unchanged.** The new kernel serves the panel only; `cxt run --pick` is
  still the minimal line-based picker it always was.
- **The console has no drag-and-drop reordering.** ↑ / ↓ is enough, and a drag handler is a pile of
  code nothing can test — there is no front-end test framework, because there are no dependencies.
- **The console is single-user and loopback-only**, with no "let others connect" switch. Two tabs
  both work; the last write wins.
- **The panel has no mouse.** The console is the one with a mouse.

---

## Design

The full contract is in [`AGENTS.md`](./AGENTS.md) — every decision above is traceable to a
numbered section there, including the ones that were revised after testing against a real Codex
binary (Codex CLI 0.163.0).

Four load-bearing primitives, in dependency order:

1. **Resolution** (`core/resolve.js`) — the cascade. Pure, no I/O, no platform. Given a path and
   a config, it produces the four elements plus every field's source layer.
2. **TOML splicing** (`core/toml-splice.js`) — edit the managed region of a `config.toml`
   **in place**, preserving everything else byte-for-byte. This is what makes a dual-author file
   workable, and it's why there's no TOML library dependency.
3. **Launch** (`core/launch-script.js` + `platform/`) — turn a resolution into a command line and
   a terminal. Isolated per-platform; the `.cmd`-shim handling and the "new window vs new tab"
   decision live here.
4. **Trust** (`core/trust.js`) — the (token × project) matrix, with the path-form rule.

Layering: `bin → cli → core ← platform`. `core/` never reads `process.env`, `process.platform`,
`os.homedir()` or `process.cwd()` — they're injected by the caller. `core/store.js` is the one
explicit exception (it's the only `core/` module allowed to touch the filesystem), and
`cli/main.js` is the only place that reads `process.*` and constructs the context. That's what
lets the whole resolution and splicing layer be tested without spawning anything.

The panel copies that discipline **one level down**, inside `cli/`: in `cli/ui/`, `keys.js` /
`render.js` / `app.js` are pure (bytes in; a frame and a list of effects out), and **only
`ui/term.js` touches `process.stdin` / `process.stdout`**. So the panel's state machine and its
layout are testable as a whole, without ever grabbing a real terminal.

The web console copies it **sideways**: the browser half (`src/web/`) is served as bytes and has no
tests at all, so everything it must not get wrong lives on the server side of the wire —
`commands/ui-web.js` builds the view model, and **`platform/serve-web.js` is the only file that
imports `node:http`** (and the only one that installs a `SIGINT` handler, which is why the "one
exception" above still holds). The two halves meet at a JSON shape that a test asserts key by key.

```bash
npm test              # node --test — 2047 tests, no network, no Codex required
npm run verify:codex  # asserts against a real Codex binary, in a throwaway CODEX_HOME
```

---

## License

MIT
