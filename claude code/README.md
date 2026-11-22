# claude-multi-token (`cmt`)

**One session, one token.**

[中文文档 →](./README.zh-CN.md)

> **Status: archived (November 2026).** This project is no longer developed. It is published as-is,
> under the MIT license, in case the design or the code is useful. There is no support, no roadmap,
> and no guarantee that it still matches the current versions of Claude Code. Read it as a design
> document with executable evidence.

A launcher that turns *"one machine, one globally-unique set of environment variables"*
into *"a config resolved by path"*: whichever directory you run `cmt run` in, that directory's
token / API URL / model get applied to the Claude Code session it opens.

Zero runtime dependencies. Node ≥ 18. Windows / macOS / Linux.

> **Don't want to read docs?** Type bare `cmt` in a terminal — it opens a local **web console**:
> a form of dropdowns and checkboxes. Pick a directory, type a token, fetch the model list, and it
> **writes both config layers at once**; model priority is set by ticking boxes and nudging them
> with ↑↓. The window is `cmt`'s own — bound to `127.0.0.1` only, unreachable from any other
> machine.
> Prefer the terminal? `cmt ui` opens the full-screen **panel** (arrow keys; that's the one that
> works over SSH). On a non-TTY, bare `cmt` falls back to printing usage and **exits 0**, so
> scripts are unaffected.

---

## The problem

You want three Claude Code sessions running at once — one per relay station or account.
But there is only one set of environment variables:

```bash
export ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
export ANTHROPIC_AUTH_TOKEN=<your key>
export ANTHROPIC_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-flash[1m]
export ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-flash
export CLAUDE_CODE_SUBAGENT_MODEL=deepseek-flash
export CLAUDE_CODE_EFFORT_LEVEL=max
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432
```

Project A's key and project B's key fight over the same slots. Switching means re-exporting
everything by hand, every time, and there is no way to have two of them live at once.

`cmt` makes that block a **per-path config**:

```bash
cmt bind D:/work/client-a --token relay-a
cmt bind D:/work/client-b --token relay-b
cmt run            # in D:/work/client-a → opens a session wired to relay-a
```

---

## Install

### Step 0: install Claude Code first

`cmt` is a **launcher**, not an installer — it does not install, update, or configure
Claude Code itself (see "What cmt doesn't do"). So the first step is getting `claude`
onto your PATH:

```bash
# macOS / Linux / WSL — the official native installer (recommended)
curl -fsSL https://claude.ai/install.sh | bash

# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
```

Or via a package manager:

```bash
brew install --cask claude-code          # macOS / Linuxbrew
winget install Anthropic.ClaudeCode      # Windows
```

Then open a **new terminal** to verify — PATH changes don't reach windows that are
already open:

```bash
claude --version     # expect something like 2.1.211 (Claude Code)
claude doctor        # official self-check: install health / settings validation
```

> Anthropic also ships `npm install -g @anthropic-ai/claude-code`, but that route
> declares **Node ≥ 22** while `cmt` itself needs only Node ≥ 18 — **two different
> requirements**. The native installer above is the simpler path: same native binary,
> and it auto-updates in the background.

`cmt` resolves `claude` in **four tiers**: `claudeBin` from config → `PATH` → common
install locations (the native installer's `~/.local/bin/` and Homebrew's
`/opt/homebrew/bin/` are both covered) → nothing, which is an error with exit code 2.
A hit on `PATH` or a common location is **written back to config**, so later runs skip
the probe.

The "claude executable" section of `cmt doctor` prints which tier was hit **and which
one is on PATH** — so when the binary in use isn't the one on your PATH, that section
tells you why immediately.

### Then install cmt

**From a checkout.** The package was never published to the npm registry — the project was
archived first — so `npm install -g claude-multi-token` would return a 404:

```bash
cd "claude code"        # from the repo root
npm install -g .        # → `cmt`
```

Or run it without installing anything:

```bash
node bin/cmt.js --help
```

There are no dependencies to install — `dependencies` is `{}` and everything uses `node:`
built-ins. `npm ls` on this package is empty by construction. That is a design commitment,
not an accident: nothing to audit, nothing to break, `npx`-fast.

Requires **Node ≥ 18**. Node 18.20 / 20.12+ refuses to `spawn` a `.cmd`/`.bat` directly
(CVE-2024-27980); `cmt` routes through `cmd.exe /c` on both sides, so older 18.x works too —
but newer is smoother.

---

## Usage guide

Organized by **what you actually want to do**. Every output below was captured from a real
run, so you can copy the commands as-is.

### Scenario 1: get one token working

```bash
# 1. Describe a token (the key, and where it points)
cmt token add relay-a --token 'sk-...' --base-url https://api.deepseek.com/anthropic

# 2. Give it a model priority list (first = highest priority)
cmt model set --token relay-a 'deepseek-flash[1m]:Flash 1M' deepseek-flash

# 3. Bind a directory to it
cmt bind D:/work/client-a --token relay-a

# 4. See what that directory resolves to — the single best debugging command
cmt resolve D:/work/client-a

# 5. Launch
cmt run
```

Step 4 is worth a look: all four elements, **each tagged with the layer it came from**.

```
binding  D:/work/client-a
token    relay-a
source   ← path binding (D:/work/client-a)

The four elements
  ✓ local path  D:\work\client-a                    ← current directory (cwd)
  ✓ token       sk-****1111                          ← the token itself (token relay-a)
  ✓ apiUrl      https://api.deepseek.com/anthropic   ← the token itself (token relay-a)
  ✓ model       deepseek-flash[1m]  (Flash 1M)   (1 more candidate)
                                                     ← the token itself (token relay-a)

Environment to inject
  CLAUDE_CONFIG_DIR               ~/.claude-multi-token/profiles/relay-a
  ANTHROPIC_AUTH_TOKEN            sk-****1111
  ANTHROPIC_BASE_URL              https://api.deepseek.com/anthropic
  ANTHROPIC_MODEL                 deepseek-flash[1m]
  ...
Command line
  claude --name cmt:relay-a
```

**Don't want the key — or an internal endpoint — on disk?** `--token` and `--base-url` both
accept a whole-string environment reference:

```bash
cmt token add relay-a --token '${DEEPSEEK_API_KEY}' --base-url '${RELAY_BASE_URL}'
```

What lands on disk is the reference itself; the values are read from the environment at launch:

```json
{ "name": "relay-a", "authToken": "${DEEPSEEK_API_KEY}", "baseUrl": "${RELAY_BASE_URL}" }
```

References must be the **entire string** (`"${A}"` ✅, `"sk-${A}"` ❌ — error). If the variable
is unset, `cmt` **fails and names the variable** — it never silently falls back to the literal
`"${A}"`, which would become a permanently-rejected fake token (or, for the endpoint, a
hostname that doesn't resolve).

### Scenario 2: two projects, two tokens (the core case)

This is why the tool exists. **One session, one token, told apart by directory:**

```bash
cmt token add corp    --token '${CORP_API_KEY}' --base-url https://relay.example.com
cmt token add deepseek --token '${DEEPSEEK_API_KEY}'              --base-url https://api.deepseek.com/anthropic

cmt model set --token corp    DeepSeek-V4.1-Flash
cmt model set --token deepseek 'deepseek-flash[1m]:Flash 1M' deepseek-flash

cmt bind D:/work/client-a --token corp
cmt bind D:/work/client-b --token deepseek
```

`cmt ls` shows the whole picture — note whether each token's models are its **own list** or
**inherited from the global default**:

```
token (2 total)

  corp
    cwd     (unset)
    models  DeepSeek-V4.1-Flash   ← its own list
    apiUrl  https://relay.example.com

  deepseek
    cwd     (unset)
    models  deepseek-flash[1m] → deepseek-flash   ← its own list
    apiUrl  https://api.deepseek.com/anthropic

  2 bindings (`cmt bind ls` for detail)
```

Then open a session in each — by default both land as tabs in the same `cmt` window, titled
`cmt:corp · client-a` and `cmt:deepseek · client-b`:

```bash
cd D:/work/client-a && cmt run     # → corp
cd D:/work/client-b && cmt run     # → deepseek
```

**Bindings match by prefix**, so subdirectories inherit the parent's binding:

```bash
cmt bind D:/work --token corp                # everything under D:/work uses corp
cmt bind D:/work/client-b --token deepseek    # only client-b overrides to deepseek
```

The longer prefix wins. `cmt bind ls` lists them all; `cmt bind rm <path>` removes one.

### Scenario 3: try a different token or model once, without editing config

```bash
cmt run relay-b                      # use relay-b for this launch only
cmt run --model deepseek-reasoner    # different model (promoted to the head of the list)
cmt run --url https://other.example.com/anthropic
cmt run --cwd D:/work/client-a       # use another directory's config, from here
cmt run --pick                       # choose interactively from the model list
```

These flags affect **this launch only** and write nothing to disk. To see exactly what would
happen, add `--print`:

```bash
cmt run --print
```

```
(--print: none of the following will actually run)

The four elements
  local path  D:\work\client-a                    ← current directory (cwd)
  token       corp                                ← path binding (D:/work/client-a)
  apiUrl      https://relay.example.com           ← the token itself (token corp)
  model       DeepSeek-V4.1-Flash                 ← the token itself (token corp)

Environment to inject
  CLAUDE_CONFIG_DIR               ~/.claude-multi-token/profiles/corp
  ANTHROPIC_AUTH_TOKEN            sk-****abcd
  ANTHROPIC_BASE_URL              https://relay.example.com
  ANTHROPIC_MODEL                 DeepSeek-V4.1-Flash
  ANTHROPIC_DEFAULT_OPUS_MODEL    DeepSeek-V4.1-Flash
  ...
```

Secrets are always masked (first 3, last 4). Masking keys off the **variable name** matching
`TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL`, so other secrets you put in the `env` escape hatch
are masked too.

### Scenario 4: a model goes down — switch in two steps

> ⚠️ **"Priority" is not automatic failover.** Claude Code's `--fallback-model` **only works
> with `--print`**; in interactive mode a dead model does **not** roll over to the next
> candidate.

So switching is manual, and `cmt` makes it exactly two commands:

```bash
cmt model next      # rotate: models[0] moves to the end, the next candidate comes up
cmt run -c          # new tab; claude -c resumes this directory's last session
```

- `cmt model next` **rotates** rather than deletes, so switching repeatedly never exhausts
  the candidates
- `cmt model use <id>` promotes a specific model to the head, others keep their relative order
- Both accept `--global` / `--token <t>` / `--path <p>`; the default is the current directory

```
✓ Promoted (path binding D:\work\client-a)

  1. DeepSeek-V4.1   ← default for this session
  2. DeepSeek-V4.1-Flash

  ℹ This path's inherited list has been **materialized** locally — `cmt resolve` will now
    report the source layer as "path binding"
```

Materializing is deliberate: the list was inherited, you changed it, so `cmt` writes an
explicit path-local copy and the source layer moves from `token` to `binding` — the change is
visible, with no implicit magic. Undo it with `cmt model clear --path <p>` to go back to
inheriting.

### Scenario 5: swap a key **without losing session history**

`-c`'s scope is **config dir + current directory** — nothing to do with the token value.
History lives in `<config dir>/projects/<cwd-slug>/`.

- ✅ Change only `ANTHROPIC_AUTH_TOKEN` (config dir unchanged) → `-c` still finds the session
- ❌ Change `CLAUDE_CONFIG_DIR` → that's a different history; `-c` won't find it

Under `cmt`, "one token, one profile" means **switching tokens also switches the config dir**,
so `-c` breaks. To change a key and keep the conversation, **edit the existing token's
credential**:

```bash
cmt token edit relay-a --token 'sk-newkey'   # profile untouched → history and -c survive
```

**Don't "switch to another token" to change a key** — that changes your identity, not your key.

### Scenario 6: confirm which token a session is actually using

Three layers of assurance, fastest to most precise:

**① The tab (or window) title** — `cmt run` writes the session name into it:

```
cmt:corp · claude code
   ↑token      ↑last segment of the directory
```

Every session gets its own tab in one dedicated `cmt` window (see
[Platform support](#platform-support)), so a glance at the tab bar tells you which token and
which project each session belongs to. `cmt run --window` gives each session its own window
instead, with the same title.

**② `cmt resolve`** — the four elements for a directory, **plus which layer each came from**:

```bash
cmt resolve            # current directory
cmt resolve D:/work/client-a
```

```
binding  D:/work/client-a
token    corp
source   ← path binding (D:/work/client-a)

The four elements
  ✓ local path  D:\work\client-a                    ← current directory (cwd)
  ✓ token       ${CORP_API_KEY} (set)                   ← the token itself (token corp)
  ✓ apiUrl      https://relay.example.com           ← the token itself (token corp)
  ✓ model       DeepSeek-V4.1-Flash                 ← the token itself (token corp)
```

**③ Ask the environment inside the session** — `cmt` injects real environment variables, so
they're visible to the shell:

```bash
echo $CLAUDE_CONFIG_DIR     # bash / zsh
```

### Scenario 7: troubleshooting

**The first move is always `cmt resolve`.** It shares its assembly code with `cmt run`, so
what it shows is what launches.

```bash
cmt doctor          # self-check: node / claude / terminal detection / four elements /
                    # dangling bindings / non-ASCII paths
cmt doctor --cwd D:/work/client-a
```

`cmt doctor` **always exits 0** — it's a diagnostic, not a gate; running it in CI shouldn't go
red because one machine lacks claude.

| Symptom | Look here first |
|---------|-----------------|
| "four elements incomplete, missing N" | `cmt resolve` — every row is tagged with its source layer |
| A binding exists but reports "binding (none)" | Compare normalized strings via `cmt bind ls`; `cmt resolve` flags near-miss bindings that share a last segment |
| Wrong model | `cmt model ls` — shows which layer the effective list came from |
| Want to confirm nothing will launch | `cmt run --print` — executes not a single byte |
| Window opens but claude errors | The `claude` section of `cmt doctor`, then the non-ASCII path warning |

### Scenario 8: third-party model endpoints

`cmt`'s job is to inject the right environment variables; **whether the endpoint works is the
endpoint's business.** Two common noises from third-party Anthropic-compatible endpoints,
neither of them a `cmt` problem:

- **`unrecognized_model`**: Claude Code doesn't recognize the model name. It warns and carries
  on; functionality is unaffected.
- **The `authMode` confirmation prompt**: using `ANTHROPIC_API_KEY` (the `X-Api-Key` header)
  instead of `ANTHROPIC_AUTH_TOKEN` (`Authorization: Bearer`) makes interactive mode prompt
  once. `cmt`'s `authMode` **defaults to `"token"`** precisely to avoid that prompt. Only
  change it if your endpoint truly requires `X-Api-Key`:
  `cmt token edit relay-a --auth-mode key`.

### Scenario 9: don't want to memorize commands

```bash
cmt          # bare, in a terminal — that's the web console
```

**The web console** is a local page made of native `<select>` dropdowns, checkboxes and buttons —
no flags to remember, no arrow keys. Same four steps as the panel below, all on one page:

| Step | What you do |
|---|---|
| 1 Directory | type a path, or pick one from the dropdown. 「复制」 copies what's in the box; 「打开」 opens that folder in your file manager |
| 2 Identity | pick an existing token, or type a name + key to create a new one |
| 3 Models | **tick the ones you want**; the "selected" list below has ↑ / ↓ to set priority, then 「下一步」 |
| 4 Landing spots | review, then write — a binding in the global `config.json` **and** a `.cmt.json` in that directory |

**A workbench: project status, and each identity paired with its endpoint.** The page is two
columns — the **left rail** counts your projects by status (click one to filter by it), the
**right** is a table of projects whose first column is that project's status dropdown.

- **One folder = one project.** Give it a status (未开始 / 进行中 / 受阻 / 已完成 / 失败 out of the
  box) and the row's color follows. Colors are **named**, with separate light and dark values — so
  a theme switch never distorts them.
- **The status table is yours to edit.** 「管理状态…」 renames, recolors, reorders, adds and deletes
  them (1–12). A status still in use **can't be deleted**, and it tells you which projects use it.
- **Status lives in its own file**: `~/.claude-multi-token/projects.json`, not in `config.json` —
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
  as `cmt model use <id>` — the pick is **promoted to the front**, the rest keep their order, and
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
    `~/.claude-multi-token/resources.json` (each entry carries its `url` and `fetchedAt`), so the
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
  - **The 「重算用量」 button is `cmt pool sync`.** It recomputes the whole pool from the
    transcripts Claude Code wrote locally, persists `pool.json`, and reloads the page — so the
    CLI and the page read the same numbers. **It only touches usage, never status** (press
    「检测」 for that), and when it finds no records at all it says so instead of leaving stale
    numbers behind.
  - **You rarely have to press it.** Opening the panel, opening the web console, or running
    `cmt pool list` recomputes first **if the numbers are older than `usageSeconds`** (default
    600) — a 600 s window on reading local files, deliberately separate from the 300 s one for
    probing. Recomputing is cheap: a file whose **size and mtime** are unchanged is served from
    `pool-usage-cache.json`, so only the transcripts you actually appended to are re-read. The
    cache stores per-file model tallies only — never the `in` / `out` totals, which stay derived
    so "the summary equals the sum of its rows" can't drift. Deleting the cache costs speed, not
    accuracy. `--force` re-reads everything.

**Where it runs, and why nobody else can reach it.** `cmt` starts a `node:http` server bound to
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
cmt ui --web --no-open   # print the URL only; open nothing
```

#### The full-screen panel (`cmt ui`)

**Same reducer, same four steps — arrow keys instead of a mouse.** It needs nothing but a
terminal, which is why it's the one that works over SSH, in a container, or on a machine with no
browser at all.

```
 当前目录                         │authToken: sk-****abcd        │模型 (2)
 agent_multi_token  → relay-a │baseUrl:   https://api.deep…  │▸ deepseek-flash[1m]
 (未绑定)              → relay-b │source:    路径绑定               │  deepseek-flash
 + 新建…                        │profile:   已建                 │
```

Arrow keys to select, **Enter to launch** (same as `cmt run` — opens a new tab). ★ The panel
**stays where it is** afterwards and shows 「已启动 ✓」, so you can open several sessions in a row.

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
`.cmt.json` in that directory (below). The directory then carries its own identity — even if the
config is copied to another machine.

> **Terminal stuck in the alternate screen after a hard kill?** On Windows, `taskkill /F`, Task
> Manager, and closing the window are all unconditional `TerminateProcess` — **there is no callback
> to intercept**, so the alternate screen can stay behind. The way out is `CMT_UI=plain cmt ui` —
> line-by-line output, no alternate screen, same content, same keys. See Pitfalls.

### Scenario 10: let the project carry its own config

Drop a `.cmt.json` in the project root:

```json
{ "version": 1, "token": "relay-a", "models": [{ "id": "deepseek-flash[1m]" }] }
```

Launching from that directory (or anywhere under it) picks it up automatically, and it **wins over
path bindings**. Clone a repo, `cd` in, `cmt run` — the identity is already right, with no need to
remember `cmt bind` first.

★ This file **can never contain a credential** (`authToken` / `baseUrl` are forbidden — see below),
so it is **safe to commit**. Everyone on the team runs
`cmt token add relay-a --token <their own key>` once; the rest is copied.

---

## Concepts

### The four elements

Starting a Claude session needs **all four**. `cmt` refuses to launch if any is missing,
and names the one that's missing:

| Element | Field | What breaks without it |
|---------|-------|------------------------|
| Local path | `cwd` | Don't know where to run |
| token | `authToken` (+ `authMode`) | Can't authenticate |
| apiUrl | `baseUrl` | Can't reach the endpoint |
| model | `models[0]` | Don't know which model to use |

### Config cascade

Highest priority first. Every resolved value can say which layer it came from.

| Element | Resolution order (left = wins) |
|---------|-------------------------------|
| `cwd` | `--cwd` → the token's `cwd` → current directory |
| `token` | `--token` → path binding → `defaults.token` → none |
| `baseUrl` | `--url` → binding → token → global defaults |
| `authToken` | `--token-value` → binding → token → global defaults |
| `authMode` | `--auth-mode` → binding → token → global defaults → built-in `"token"` |
| `models` | binding → token → global (**whole-list override, never merged**) |
| `slots` | binding → token → global (**whole-map override**) |
| `env` | global ← token ← binding (**merged key-by-key**) |
| `claudeArgs` | global + token (**concatenated**, then `--` args last) |
| `terminalMode` | `--window`/`--tab` → `defaults.terminalMode` → built-in `"tab"` |

Three semantics worth knowing, because they're easy to get wrong:

- **`--token` is the token's *name*; `--token-value` is the secret itself.** The first picks
  an identity (and therefore a profile directory), the second swaps a credential.
  **`cmt run` refuses `--token-value`** — the launched terminal's `cmt exec` can only receive that
  value on its command line, which either goes into `launch.cmd` or stays in the terminal's
  argv. Both are a second place the credential lands on disk, which is exactly what the
  single-token-file design avoids. Use `cmt exec --token-value <v>` for a one-off, or
  `cmt token add <name> --token <v>` for one you'll reuse. Non-secrets (`--url`,
  `--auth-mode`) *are* forwarded — and `--url` is usually a `${ENV_VAR}` reference anyway,
  which crosses the process boundary fine because it isn't the secret.
  **`cmt run --url` also refuses a value carrying userinfo** (`https://user:pass@host/…`):
  the userinfo *is* the credential, so inlining it would write the secret into the launch
  script. Use a `${ENV_VAR}` reference, put the endpoint in the token config
  (`cmt token edit <t> --base-url <u>`), or use `cmt exec --url <u>` (writes nothing).
- **Binding match always uses the *invocation* cwd**, never `token.cwd`. The latter means
  "where this token lands by default" — matching on it would be circular.
- **`models` is a list of options; `claudeArgs` is a bag of independent switches.** So the
  former is overridden wholesale and the latter is concatenated.

### Path bindings

`bindings` is an array of `{ path, token?, baseUrl?, models?, slots?, env? }`, matched by
**longest prefix**: `D:/work/a/sub` hits `D:/work/a`, not `D:/work`.

Normalization before comparing: NFC (macOS stores filenames decomposed — our own `startsWith`
is byte-sensitive, so this matters), `\` → `/`, lowercase on Windows/macOS but **not** on
Linux, `.`/`..` resolved, trailing `/` dropped. Symlinks are **not** resolved — that would
make bindings mysteriously stop working. `cmt resolve` prints the normalized form so you can
see exactly what got matched.

> WSL: `/mnt/c/...` and `C:\...` are different strings and bindings do **not** cross between
> them. Deliberate — no path translation.

### Project-local config (`.cmt.json`)

A config that lives **in the project directory**. Discovery walks **upward from `cwd`, nearest one
wins**, all the way to the filesystem root.

```json
{
  "version": 1,
  "token": "relay-a",
  "models": [{ "id": "deepseek-flash[1m]" }],
  "env": { "CLAUDE_CODE_EFFORT_LEVEL": "max" },
  "claudeArgs": []
}
```

**Allowed**: `version` (required) · `token` · `models` · `env` · `claudeArgs`

**Forbidden**, each with its own error that names the key:

| Forbidden key | Why |
|---|---|
| `authToken` | A credential has exactly one landing point: `tokens/<name>.json`. A second one is a second plaintext copy — and this one gets committed by `git add .` |
| `baseUrl` | ★ **This is an exfiltration channel**: `baseUrl: "https://evil.example.com"` in a cloned repo sends your key there. Not an inconvenience — an attack surface |
| `env.CLAUDE_CONFIG_DIR` | The isolation primitive (§2.2). A project file must not move where the profile lands, or `cmt run` starts touching your real `~/.claude/` |
| `cwd` | The file *is* how the path was found; declaring a cwd on top is circular |
| `slots` | ★ Slots stay out on purpose — the panel configures `models` only. Two panels each configuring a set (`models` and `slots`) would inevitably diverge |
| `claudeBin` / `terminalMode` / `seed` | Machine-level preferences, not project-level |

⇒ **Side benefit: `.cmt.json` can never contain a secret, so it's safe to commit.**

It is **never created automatically** (`cmt`'s laziness discipline). Either use the panel's wizard,
or write one yourself. `--config <path>` points at a different one (same schema, skips the upward
search):

```bash
cmt --config ./sub/.cmt.json resolve
```

Unreadable (bad JSON / bad schema) → **hard error**, never a silent skip.

### Model priority list

`models` is an **ordered priority list**. `models[0]` is the session's default model.

1. `--model <id>` → use it
2. otherwise → `models[0]` (no interactive prompt; use `--pick` to choose)
3. `models: []` → inject no model, use Claude Code's own default
4. `models` absent → inherit from the layer above

**`slots`** maps models onto Claude Code's alias slots — essential for relay stations,
otherwise `/model opus` inside a session requests a model the relay doesn't have:

| slot | environment variable |
|------|---------------------|
| `opus` / `sonnet` / `haiku` / `fable` | `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` |
| `subagent` | `CLAUDE_CODE_SUBAGENT_MODEL` |

**Any slot you don't list is automatically filled with `models[0]`.** Explicit `null` means
"don't inject this one". That default is why a DeepSeek-only relay works without configuring
five slots by hand.

---

## Model failover: why it's manual

> ⚠️ **"Priority" is not automatic failover.** Claude Code's `--fallback-model` is
> **`--print`-only** (its own help says so). In interactive mode `models[0]` is merely the
> default selection — it will **not** jump to `models[1]` when the model is down.

That's an upstream limit, not a `cmt` choice. What `cmt` can do is make the manual switch as
short as possible: **two commands**, and `next` **rotates** rather than deletes, so switching
back and forth never exhausts the candidate list.

For the walkthrough see Scenario 4 (a model goes down) and Scenario 5 (swapping a key without
losing history) in the usage guide.

**The cost of "one token, one profile":** switching tokens also switches
`CLAUDE_CONFIG_DIR`, and `-c`'s scope is exactly **config dir + current directory**. So to
change a key, edit the existing token's credential (`cmt token edit`) — don't switch to
another token. That's changing identity, not key.

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
place a key lands is still `tokens/<name>.json`. `cmt token add` remains the only way to create an
identity; `cmt pool import` is "many `token add`s plus an entry each".

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
request** — one `/v1/messages` call with `max_tokens: 1`, authenticated the way that token is
configured (`Authorization: Bearer` or `x-api-key`). That costs a fraction of a cent per key, which
is why the pool probes only when it has to:

| Last status | Re-probe when |
|---|---|
| never, or an unreadable `checkedAt` | now |
| `ok` | older than `cacheSeconds` (default 300) |
| `no_quota` | **a month boundary has passed** — the allowance refills on the 1st |
| `invalid` | after 24 hours |

`no_quota` is not "a longer timeout", it is a different rule: the allowance refills on the 1st, so
a fixed 30-day timer would keep a key marked dead long after it started working again.

Probing happens in exactly two places: `cmt pool check` (and the console's 检测 button), and the
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
| `cmt run` with no token resolvable | fills the gap, unless `defaults.pool.auto: false` |
| `cmt run --pool` | forces a pick, **overriding bindings and `defaults.token`** |
| `cmt run --print` | shows the pick and its `pool` source — see it before it costs anything |
| `cmt resolve` | hints only; a read-only diagnostic doesn't spend a request |
| `cmt exec` | never — it already has a token by the time it runs |

★ **The `-c` guard.** `-c` resumes the most recent conversation *in the current directory, inside
that profile*, and a profile belongs to one token. Had a second `cmt run -c` picked a different
token, it would silently start a **new** session while you believed you were continuing the old
one. So with `-c` the pool uses only `lastPick[cwd]` — the token it picked last time from this
exact directory. No record, or the recorded token is no longer usable → error, with the two ways
out (name a token explicitly, or drop `-c`). The key is the cwd **as computed before the pick**;
the picked token's own `cwd` takes effect afterwards and would not match next time.

`defaults.pool` turns it off or re-tunes it:

```json
{ "defaults": { "pool": { "auto": false, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 } } }
```

`policy: "round-robin"` ignores usage and just rotates. Neither policy switches anything
mid-session — a pick is a one-time decision.

### Commands

```bash
cmt pool list                       # every token + status + usage; unpooled tokens say so
cmt pool import tokens.xlsx         # batch token add + entry; existing names are skipped, not overwritten
cmt pool check [name...] [--all] [--force] [--model <m>]
                                    # probe now; no names = --all; --force ignores the freshness window
cmt pool status relay-a no_quota    # manual override (detail becomes "manual")
cmt pool reset relay-a              # back to unknown; usage is kept
cmt pool sync [--redis <url>] [--force]
                                    # recompute usage from your local transcripts; --redis also writes to Redis
                                    # unchanged files come from the cache; --force re-reads them all
cmt pool pull --redis <url>         # the reverse: bring Redis's status back into the local file
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

Every `cmt exec` leaves a record under `sessions/<id>/meta.json` — token name, cwd, pid,
start/end time, exit code. It is written by the exec process itself (the one that lives as long
as the session); `cmt run` only spawns and detaches, so it cannot know. A failed write never
blocks a session. The record deliberately stores **no argv**: `--token-value` is a plaintext key.

`cmt sessions` lists every window in one of three states, computed at read time: `live` (no end
time and the pid still answers), `ended` (recorded exit), `dead` (no exit record and the process
is gone). It is an overview, not an audit trail — a reused pid can make a dead record look live.

`cmt msg send <id|--token <t>|--all> "text"` drops one message file into a live session's
`inbox/`. Messages are **inert data**: nothing in cmt reads them and acts. Delivery is a human
step — tell the agent to run `cmt msg inbox` itself. `msg inbox` marks what it shows as read by
renaming the files into `read/` (atomic, same directory); `msg gc` prunes by age, and
`sessions prune` refuses to delete sessions that still hold unread messages unless you pass
`--force`. `type: info | action-request` is a label for the reader — a message never grants
execution rights.

`cmt resume <session-id>` reopens an ended/dead session in a new window — same token, same
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

```
Front-ends
  cmt                                      ★ bare (no arguments) = the web console. On a
                                           non-TTY it prints usage and exits 0
  cmt ui                                   enter the full-screen panel explicitly.
                                           CMT_UI=plain cmt ui = line-by-line output, no
                                           alternate screen
  cmt ui --web [--no-open]                 the web console. Works without a terminal too
                                           (it doesn't need one). --no-open prints the URL
                                           and opens nothing; CMT_UI=web is equivalent

Sessions
  cmt run [<token>] [--cwd <p>] [--model <id>] [--url <u>]
                    [--auth-mode token|key] [--pick] [--pool] [-c] [--window|--tab]
                    [--print] [-- <claude args...>]
                    # no --token-value: a credential can't cross into the new
                    # terminal without landing on disk (see "Config cascade")
                    # --pool: pick from the token pool, overriding any binding
  cmt exec [<token>] [--model <id>] [--url <u>] [--token-value <v>]
                    [--auth-mode token|key] [-c]
                                           internal: inject env then exec claude
                                           ★ the one place a one-off credential fits
  cmt resolve [<path>]                     ★ four elements + source layer of each

Presence & mailbox (§2.14)
  cmt sessions [--json]                    every window in one of three states — live /
                                           ended / dead — plus its unread count
  cmt sessions prune [--older-than 30d] [--force]
                                           drop old ended/dead records; a live session is
                                           never pruned, and unread mail blocks it unless
                                           --force
  cmt resume <id|prefix>                   reopen an ended/dead window: same token, same
                                           cwd, `-c` in a new tab. Refuses a live one —
                                           it's still open, just switch to it
  cmt msg send <id|--token <t>|--all> [--type info|action-request] <text...>
                                           leave a note for a **live** session. A message
                                           is inert data — nothing acts on it. Delivery
                                           is you telling the agent to run `cmt msg inbox`
  cmt msg inbox [--session <id>] [--peek] [--json]
                                           read it; what it shows moves from inbox/ to
                                           read/ (same-directory rename) unless --peek
  cmt msg gc [--older-than 7d]             prune old messages (inbox and read alike)

Config
  cmt ls [--json]                          token list + each one's cwd / model source
  cmt bind <path> [--token <t>] [--url <u>] [--model <id>]
  cmt bind ls [--json]
  cmt bind rm <path>
  cmt token add <name> --token <t> [--base-url <u>] [--cwd <p>] [--auth-mode token|key]
  cmt token rm <name> [--purge] [--yes]
  cmt token show <name>
  cmt token edit <name> [--token <v>] [--base-url <u>] [--cwd <p>] [--auth-mode token|key]

Models
  cmt model ls [<path>|<token>] [--json]
  cmt model set [--global|--token <t>|--path <p>] <id[:label]>...
  cmt model use <id>   [--global|--token <t>|--path <p>]
  cmt model next       [--global|--token <t>|--path <p>]
  cmt model clear      [--token <t>|--path <p>]
  cmt slot set [--global|--token <t>|--path <p>] <slot>=<modelId>
  cmt slot ls  [--global|--token <t>|--path <p>]

Troubleshooting
  cmt profile path <token>   print the profile directory (= CLAUDE_CONFIG_DIR)
  cmt profile ls             list all profile directories
  cmt doctor [--cwd <path>]  self-check: node / claude / terminal / four elements /
                             dangling bindings / non-ASCII paths

Usage
  cmt usage [--days <n>] [--by token|project|model|day] [--json] [--refresh]
                             token usage and cost from your local transcripts;
                             prices come from prices.json (USD per million tokens)

Token pool (§2.13)
  cmt pool list              every token + status + usage; unpooled tokens say so
  cmt pool import <csv|xlsx> batch token add + entry (col 1 name, col 2 key)
  cmt pool check [name...] [--all] [--force] [--model <m>]
                             probe: one minimal real request per key (costs a little)
  cmt pool status <name> <s> manual override (detail becomes "manual")
  cmt pool reset <name>      back to unknown; usage is kept
  cmt pool sync [--redis <url>] [--force]
                             recompute usage from transcripts; --redis writes through;
                             unchanged files hit the cache, --force re-reads everything
  cmt pool pull --redis <url>     the reverse: Redis's status → the local file
                             ★ list / check / status / reset / launch never touch Redis

Global
  --config <path>  ★ point at a project-local config (.cmt.json), skipping the upward search
  --json     machine-readable output (ls / resolve / model ls / bind ls / profile / doctor /
             usage / pool)
  -h, --help
  -v, --version
```

**Exit codes:** `0` success · `1` user error (missing token, bad name, missing element) ·
`2` environment error (claude not on PATH, terminal detection failed, directory not writable).

Errors always name the next command to run. Example:

> Path `D:/work/x` resolves to no token (no binding, no global default).
> Try: `cmt bind D:/work/x --token relay-a`

---

## Configuration files

Everything lives in `~/.claude-multi-token/`:

```
~/.claude-multi-token/
├── config.json              # global defaults + path bindings
├── projects.json            # project status: folder → status (the console's; not in config.json)
├── pool.json                # token, status + usage only — NO credential (see below)
├── pool-usage-cache.json    # recompute cache: size + mtime per transcript (deletable)
├── tokens/<name>.json       # one per token
└── profiles/<token>/        # ← CLAUDE_CONFIG_DIR points here; Claude Code fills it
    ├── .claude.json         #   app state: OAuth session, project trust, personal MCP
    ├── .credentials.json    #   credentials (Windows/Linux)
    ├── settings.json        #   user settings
    ├── projects/ sessions/  #   session history, concurrency probes
    └── launch.cmd | .sh     #   ★ the only file cmt writes into this directory
```

Everything is created **lazily**: `cmt` never pre-creates an empty `profiles/`. A directory exists
because something needed it.

> **One config does *not* live here**: the project-local `<project>/.cmt.json` (see "Project-local
> config"). It belongs to **your repo**, not to `cmt` — `cmt` only touches it from the wizard, or
> when you explicitly ask it to.

### `<project>/.cmt.json` (project-local config)

```json
{ "version": 1, "token": "relay-a", "models": [{ "id": "deepseek-flash[1m]" }] }
```

The **nearest** one walking up from `cwd` wins, and it beats path bindings. It **holds no secret**
(`authToken` / `baseUrl` and friends are forbidden — see the "Project-local config" section), so
it's safe to commit.

**It is inherently *the project's*, not *yours***: clone and it applies, with no `cmt bind` first.

`config.json` is exactly your export block, relocated:

```jsonc
{
  "version": 1,
  "defaults": {
    "authToken": "${DEEPSEEK_API_KEY}",   // ${ENV_VAR} refs allowed (here and baseUrl); plaintext works too
    "authMode": "token",                  // "token" → ANTHROPIC_AUTH_TOKEN | "key" → ANTHROPIC_API_KEY
    "baseUrl": "https://api.deepseek.com/anthropic",
    "models": [                           // ★ ordered, first = highest priority
      { "id": "deepseek-flash[1m]", "label": "Flash 1M" },
      { "id": "deepseek-flash",     "label": "Flash" }
    ],
    "slots": { "haiku": "deepseek-flash", "subagent": "deepseek-flash" },
    "env": {                              // escape hatch: any environment variable
      "CLAUDE_CODE_EFFORT_LEVEL": "max",
      "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "786432"
    },
    "terminalMode": "tab",                // "tab" = new tab in the cmt window (default); "window" = a new window every time
    "claudeArgs": [],
    "seed": "off",                        // skip first-run dialogs: "off" | "onboarding" | "full"
    "preflight": true,                    // ★ launch-time /models check; false turns it off
    "pool": { "auto": true, "policy": "least-used", "cacheSeconds": 300, "usageSeconds": 600 }
  },
  "bindings": [
    { "path": "D:/work/client-a", "token": "relay-a" }
  ]
}
```

| your export | where it goes |
|-------------|---------------|
| `ANTHROPIC_BASE_URL` | `defaults.baseUrl` |
| `ANTHROPIC_AUTH_TOKEN` | `defaults.authToken` + `defaults.authMode: "token"` |
| `ANTHROPIC_MODEL` | `defaults.models[0].id` (not configured separately) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | `defaults.slots.opus` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | `defaults.slots.sonnet` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | `defaults.slots.haiku` |
| `CLAUDE_CODE_SUBAGENT_MODEL` | `defaults.slots.subagent` |
| `CLAUDE_CODE_EFFORT_LEVEL` | `defaults.env.CLAUDE_CODE_EFFORT_LEVEL` |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `defaults.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` |

Unknown keys are **rejected**, not silently ignored — a typo in a hand-edited config tells you
so immediately.

`${ENV_VAR}` references: **`authToken` and `baseUrl` both accept them**, at any layer (global
defaults, a path binding, a token file, `--token`, `--url`). The **whole string** must be one
reference (`"${A}"` ✅, `"sk-${A}"` ❌ → error). Evaluated from the new window's process
environment at launch. If the variable is unset → error, exit code 1, naming the variable. It
will **never** silently fall back to the literal string `"${A}"` — that would become a
permanently-rejected fake token (or, for the endpoint, a hostname that doesn't resolve), which
is the hardest kind of thing to debug. `cmt resolve` reports set/unset without printing the
value.

> **`cmt` reads `process.env` — it does not parse `.env`.** Loading that file is your shell's
> job (`source .env`, direnv, your shell profile, a CI secret). So keeping an internal endpoint
> out of the repo is two steps: `RELAY_BASE_URL=…` lives in the file you don't commit, and
> `"${RELAY_BASE_URL}"` lives in `config.json`. This project's `.gitignore` already ignores
> `.env` and `.env.*` for exactly this workflow.

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
your local transcripts. Losing `lastPick` has one visible consequence: `cmt run -c` has no record
of which token last ran from this directory, so it asks you to name one.

A missing file is not an error — it means "nothing is pooled yet". Neither is a hand-broken one:
the pool degrades to "everything is unknown", which only costs a probe.

`defaults.pool` accepts exactly four keys — `auto`, `policy`, `cacheSeconds`, `usageSeconds`.
The two second-counts are not interchangeable: `cacheSeconds` is the probing window (a real
request, a little money), `usageSeconds` the recompute window (reading local files, free).
What is **not** in it: the Redis URL. It may carry a password, and `config.json` is load-bearing
(an older `cmt` refuses a file it can't parse), so the address only ever arrives on the command
line or through an environment reference.

---

## Pitfalls

### The panel left your terminal in the alternate screen

**Symptoms**: the terminal looks "stuck" — no cursor, keystrokes echo but the prompt never returns.

**Cause**: on Windows, `taskkill /F`, Task Manager, and closing the terminal window are all
unconditional `TerminateProcess` — **no `'exit'`, no callback**, so `cmt`'s restore code never gets
to run. (A normal exit, `Ctrl+C`, and `q` mid-wizard all restore; those paths are covered.)

**Ways out** (in order):

```bash
CMT_UI=plain cmt ui     # ① line mode: no alternate screen, same content, same keys
```

② Still stuck? Open a new terminal window, or `reset` (POSIX) / close and reopen (Windows).
③ To avoid it entirely: bare `cmt` — the **web console** — never takes the terminal over in the
first place (it's a page in your browser, not a screen in your terminal). Or use `CMT_UI=plain`
day to day, or skip the panel for the `cmt run` / `cmt resolve` family.

> This is not something that can be "fixed" — **a signal you cannot intercept has no API**. Which
> is why `CMT_UI=plain` isn't an option; it's part of the design.

### Pointing `ANTHROPIC_BASE_URL` at a non-first-party domain

Claude Code **disables MCP tool search by default** when `ANTHROPIC_BASE_URL` isn't an
Anthropic domain, and **disables Remote Control** (v2.1.196+). This is the thing relay-station
users trip over most. To turn tool search back on:

```jsonc
"env": { "ENABLE_TOOL_SEARCH": "true" }
```

### `authMode` defaults to `"token"` on purpose

`ANTHROPIC_API_KEY` triggers a one-time *"Use a custom API key?"* confirmation in interactive
mode; `ANTHROPIC_AUTH_TOKEN` does not. Relay stations default to the latter to save that
prompt once per token.

### Skipping the first-run dialogs (`defaults.seed`)

An empty profile triggers theme selection and a workspace-trust prompt — once per token,
and both **block startup**. There is no env var, no settings key and no CLI flag that skips
them: Claude Code reads exactly two fields in `.claude.json`, so writing that file is the
only way. `defaults.seed` has `cmt` do it for you, just before launch:

| value | what cmt adds | effect |
|-------|---------------|--------|
| `"off"` | nothing | **default** — cmt never writes into a profile |
| `"onboarding"` | `hasCompletedOnboarding: true` | skips theme selection |
| `"full"` | the above + `hasTrustDialogAccepted: true` for the current directory | zero clicks |

```jsonc
"defaults": { "seed": "full" }
```

It is **add-only and idempotent**: existing keys are never modified — including a
`hasTrustDialogAccepted: false` you set by explicitly declining a directory — and from the
second launch on it degrades to a pure read. A one-time `.claude.json.cmt.bak` is kept.

`seed` covers the two dialogs that block startup, and nothing else. It does **not** write
`settings.json`: a brand-new profile gets Claude Code's default theme until you pick one,
and shows the bypass-permissions warning once unless that profile's `settings.json` has
`skipDangerousModePermissionPrompt`. Those are settings, not one-shot answers — cmt stays
out of them (see *What cmt doesn't touch*).

### Managed settings override everything

If injection seems to do nothing, check for managed settings: Windows
`C:\Program Files\ClaudeCode\` + registry `HKLM\SOFTWARE\Policies\ClaudeCode`, macOS
`/Library/Application Support/ClaudeCode/`, Linux `/etc/claude-code/`. These outrank
`--settings` and every file-based layer.

### `~/.claude.json` and `~/.claude/settings.json` are different files

The former is app state (OAuth session, project trust, personal MCP, UI toggles); the latter
is settings (`permissions` / `hooks` / `env`). When "my config didn't take effect", check
which one you edited.

### A binding that "looks identical" but doesn't match

Binding match is **string prefix matching** — deliberately no `realpath` (see *Path
bindings*). So one directory can have several spellings, and only one of them is in your
config. The classic case on Windows is the **8.3 short name**:
`C:/Users/ALICE~1/work` and `C:/Users/alice/work` are the same directory but different
strings.

When this happens, `cmt resolve` doesn't just say "no binding" — it points at the binding
whose last path segment matches and prints both normalized strings so you can compare them
character by character:

```
  绑定   （无）
         ⚠ 这条绑定的末段相同、整串却对不上：
             C:/Users/alice/work/client-a
             归一化 c:/users/alice/work/client-a   ← 与上面的归一化目录逐字符比一比
```

Fix it by re-binding with the exact spelling you launch with. Note that **case differences
are never the cause** — normalization folds case on Windows/macOS before comparing, so a
case-only difference simply matches.

---

## Security notes

**Tokens are stored in plaintext** (`tokens/<name>.json`). This is a deliberate v1 choice, not
an oversight — there is no encryption. If that bothers you, use an environment reference so
the secret stays in your environment:

```bash
cmt token add relay-a --token '${DEEPSEEK_API_KEY}'
```

**`pool.json` is plaintext too — and holds no credential.** It is a status/usage overlay keyed by
token *name*; there is no `sk` field anywhere in it, and `tokens/<name>.json` remains the only file
a key is ever written to. `cmt pool import` is not a second home either: it writes the key through
the same `token add` path first, then records the entry.

**Launch scripts never contain secrets.** A generated `launch.cmd` / `launch.sh` only calls
`cmt exec` by absolute path; the key is injected into the process environment by `cmt exec`
itself. The token has exactly one on-disk home — no second plaintext copy in the profile
directory. Non-secret overrides you passed on the command line (`--url`, `--auth-mode`) *are*
written in, since the script has to reproduce your command line exactly; `--url` is usually a
`${ENV_VAR}` reference, which is safe to write down. A `--url` carrying userinfo
(`https://user:pass@host/…`) is refused for the same reason `--token-value` is — that userinfo
is a credential, so it must not reach the file.

**Project and local settings cannot set `CLAUDE_CONFIG_DIR`** (documented Claude Code
behavior). A malicious repository therefore cannot redirect your token profile. This is one
of the reasons the design is built on `CLAUDE_CONFIG_DIR` rather than on editing files.

**cmt does not write Claude Code's settings.** Environment injection happens through process
environment variables, never by rewriting configuration. The only file `cmt` ever writes
inside a profile directory is `profiles/<token>/launch.{cmd,sh}` — plus, **only if you turn
it on**, `profiles/<token>/.claude.json` (see *Skipping the first-run dialogs* above).

That second one is the single carve-out, and it is off by default. It exists because Claude
Code's first-run gate reads that one file and **nothing else** — not a settings key, not a
CLI flag, not any of the 570 `CLAUDE_CODE_*` environment variables — so "never write it" and
"no manual clicking" cannot both be true. When enabled it is add-only and idempotent, and
writes nine fields and nothing else. `settings.json` remains off-limits even then: theme and
`skipDangerousModePermissionPrompt` are settings you keep changing, not one-shot answers,
and a tool that rewrites them is a tool fighting you over one file forever.

**Redaction** (`--print` / `cmt resolve` / `cmt token show`): any key matching
`/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` is masked to *first 3 + last 4*. Not hardcoded to
`ANTHROPIC_AUTH_TOKEN` — the `env` escape hatch can hold other secrets.

**The web console never sends a credential to the browser.** The view model carries a masked value
and a *length*; the plaintext key stays in the server process's memory, and the only key that
crosses the wire is the one you typed into the form yourself. What the console *is* exposed to is
**other pages on your machine** — the threat model is cross-origin, not "another user on this box"
(anyone who can read `tokens/*.json` already has the key). Hence: loopback binding, the per-run
path token, the `Host` / `Origin` checks, and a CSP of `default-src 'none'`. Hence also
`--no-open`, if you'd rather the token never showed up in a process list.

---

## Platform support

| Platform | Terminal launch | Status |
|----------|----------------|--------|
| Windows | `wt.exe -w cmt new-tab --title <t> --suppressApplicationTitle -d <cwd> <argv>` → `cmd /c start` fallback | **tested** (Windows 11, Windows Terminal 1.24) |
| macOS | iTerm2 / Terminal.app via `osascript` → `open -a Terminal` | code written, **unverified** |
| Linux | `$TERMINAL` → `x-terminal-emulator` → gnome-terminal / konsole / xterm | code written, **unverified** |

**`tab` (the default) vs `window`.** On Windows, `--tab` opens a tab in a window **named
`cmt`** — created on first use, reused from then on, and rebuilt automatically if you close
it. So N sessions across N projects are N tabs in one window, each titled
`cmt:<token> · <cwd tail>`. `--window` uses `-w -1` (always a new window) and keeps the same
title, which is what you want if you prefer separate windows on separate monitors.

Two things about that argv are load-bearing:

- **`-w cmt` rather than `-w 0`.** `-w 0` / `-w last` means *most recently used* window, not
  *the current* one — with several WT windows open, where a tab lands depends on which one you
  touched last. A fixed name is deterministic.
- **`--suppressApplicationTitle`, right after `new-tab`.** `--title` alone is a suggestion:
  the program inside the tab can overwrite it with OSC 2, and Claude Code does exactly that
  (`cmt:relay-test · claude_test` → `✳ cmt:relay-test`, losing the directory). Without this
  flag the title contract above is simply false. It must come *after* the `new-tab`
  subcommand or WT ignores it.

**macOS and Linux terminal launching has not been tested on real hardware.** The code paths
exist and are marked `// UNVERIFIED` at the top of the relevant modules, and the escaping
rules they need have unit tests — but only Windows has been run end to end. Feedback and
patches very welcome.

The web console's **server** half is exercised end-to-end on Windows — the suite spawns a real
`cmt ui --web`, talks to it over HTTP, and quits it. What is *not* verified on real hardware:
opening an actual Chrome/Edge **app window** (the argv shape is asserted; the window isn't), and
whether Windows' firewall stays quiet. Loopback binding *should* never prompt — but that's
reasoning, not a measurement, and it's written down as an open question rather than a fact.

`cmt doctor` is the tool for this: it reports which terminals were probed and why each
candidate failed, and `cmt run --print` shows exactly what would be executed without
launching anything.

### Environment-variable injection is platform-neutral by construction

Environment variables are **not** injected through a shell script. `cmt exec` uses
`spawn(cmd, args, { env })`, which sidesteps cmd / PowerShell / sh quoting entirely. `argv` is
always an array and never passes through a shell — which is also why paths with spaces and
non-ASCII characters (中文) work. `launch.cmd` is pure ASCII with CRLF endings, because
cmd.exe decodes `.cmd` files in the OEM code page; `launch.sh` is LF.

### The new session does not inherit the calling session's identity

A new terminal is **not** a clean environment. Windows Terminal forwards the calling process's
environment verbatim to the new tab — including when the tab is opened through
`wt -w <name> new-tab` (measured on Windows 11 / WT 1.24). So `cmt run` invoked from inside a
Claude Code session would otherwise hand the new tab that session's entire identity:

| Inherited variable | What it does to the new session |
|--------------------|--------------------------------|
| `CLAUDE_CODE_CHILD_SESSION=1` | prints `⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker` and **stops writing the transcript to disk** |
| `CLAUDE_CODE_SESSION_ID` | the new session wears the *parent's* session id |
| `CLAUDE_CODE_MESSAGING_SOCKET` + `..._TOKEN` | points back at the parent's IPC pipe, with a live credential for it |
| `CLAUDECODE` / `CLAUDE_PID` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_EXECPATH` / `CLAUDE_CODE_SSE_PORT` | all describe the parent process |

`cmt` strips all nine on both spawn paths (`cmt run`'s terminal and `cmt exec`'s claude), so:

> **The result of `cmt run` / `cmt exec` does not depend on where it was called from.**
> New-session env = inherited env **minus session markers** → **minus what cmt explicitly
> doesn't inject** → **plus cmt's injections**.

The middle step covers the `ANTHROPIC_*` variables cmt decides *not* to inject but whose
inherited value would otherwise win: `models: []` ("use Claude Code's own default") and
`slots: { opus: null }` ("leave that slot unset") both delete the inherited `ANTHROPIC_MODEL` /
`ANTHROPIC_DEFAULT_OPUS_MODEL` rather than let it stand in for them. Same for whichever auth
variable you didn't pick — `ANTHROPIC_AUTH_TOKEN` outranks `ANTHROPIC_API_KEY`, so under
`authMode: "key"` an inherited `AUTH_TOKEN` would silently win.

The distinction is **identity vs. configuration**: values describing *one running process or
session* (a pid, a session id, a pipe, a port, an executable path, how it was launched) are
stripped; values that are *configuration* (`CLAUDE_CODE_EFFORT_LEVEL`,
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_DISABLE_AUTOUPDATER`, …) are kept — those are
cmt's business, and the ones cmt manages are overridden by its own config anyway.

`cmt resolve` and `cmt run --print` print both halves — what will be injected **and** what will
be deleted from the inherited environment. Injection happens last, so the `env` escape hatch can
always put something back.

### Permissions

POSIX: `chmod 0600` on files containing tokens. **Windows: `fs.chmod` is effectively a no-op**
— protection comes from your user-directory ACL. We're not pretending otherwise.

**macOS:** credentials live in the Keychain, not in the profile directory, so
`cmt token rm --purge` cannot remove them. `cmt` prints a reminder to clean them up manually
rather than silently leaving them behind.

---

## Uninstall

```bash
npm uninstall -g claude-multi-token
rm -rf ~/.claude-multi-token     # Windows: rmdir /s %USERPROFILE%\.claude-multi-token
```

**This does not touch `~/.claude/`** — your main Claude Code configuration, login, and session
history are untouched. `cmt` never reads or writes that directory.

Deleting `~/.claude-multi-token/` removes the tokens, bindings, and every profile directory
(including per-token session history). If you want to keep the history, back up
`~/.claude-multi-token/profiles/` first.

---

## What cmt doesn't do

- ❌ No *mid-session* token rotation / load balancing / automatic failover. Once a window opens its
  identity is fixed for the whole session. **A pick before launch does not count**: `cmt run` may
  draw one token from the pool when nothing else resolved, and `--pool` makes that single pick
  override a binding — after which nothing looks at the pool again. Same for the one `/models`
  check before launch: read-only, one-shot, non-blocking, and both happen before you hit Enter.
  See "Model failover" and "The token pool".
- ❌ No proxy server — it doesn't implement the relay
- ❌ No token encryption (plaintext JSON, warned above)
- ❌ No installing or updating Claude Code itself (that's "Step 0", and it's yours to do)
- ❌ No modification of Claude Code itself, no hooking its internals
- ❌ **No balance API, because there isn't one.** `cmt usage` reads *your local transcripts* — it
  never asks the relay anything. The only outbound requests are the ones you trigger:
  `cmt pool check` sends one minimal request per key (that costs a little money), and `cmt exec`
  fetches `/models` once at launch. No statistics are scraped, no quota is inferred, nothing runs
  on a schedule.
- ❌ **No *external* GUI** — no desktop app, no VS Code extension.
  (★ This bans **external** GUIs. `cmt` ships **two** of its own — the local **web console**
  (bare `cmt`) and the full-screen **panel** (`cmt ui`). Neither touches `~/.claude/`, and neither
  is "adapting to someone else's client". Without saying so, this bullet and the two front-ends
  read as a contradiction.)
- ❌ No npm runtime dependencies. `dependencies: {}` — `node:` builtins only. **Both front-ends
  are hand-written too**: the panel is raw mode + ANSI escapes (no TUI library), and the web
  console is `node:http` plus one `fetch` (no framework, no build step).

### The panel's v1 boundaries

- **A project-local config may not hold a credential.** For a new identity, use `cmt token add`.
- **`slots` are not in the panel.** The wizard configures `models` only; slot mappings still go
  through `cmt slot set`. (`fillDefaultSlots` fills any unset slot with `models[0]`, so configuring
  `models` already covers the common case.)
- **No caching of the model list.** Step 3 refetches every time — `cmt` remembers nothing across
  sessions.
- **No themes, no mouse, no diff rendering, no diff toggle.** Leave one in and someone turns it on.
- **The panel's `e` edits only the *effective* layer**; there's no layer picker. To be precise, use
  `cmt model set --global|--token|--path`.
- **`--pick` behaviour is unchanged.** The new kernel serves the panel only; `cmt run --pick` is
  still the minimal line-based picker it always was.

---

## Design

The architecture contract is [`CLAUDE.md`](./CLAUDE.md) — the authoritative document for
contributors, covering the resolution cascade, the ownership rules for every path under
`~/.claude-multi-token/`, the launch-script contract, and the platform adaptation layers.

Two load-bearing primitives, and deliberately only two:

| Primitive | Role |
|-----------|------|
| `CLAUDE_CONFIG_DIR` | **identity isolation** — one profile per token |
| `ANTHROPIC_*` / `CLAUDE_CODE_*` | **auth + model + behavior injection** |

```
bin → cli → core ← platform
```

`core/` is pure logic with no IO side effects — it never reads `process.env`,
`process.platform`, or `os.homedir()`, and never spawns. Those are injected by the CLI layer
as `{ platform, home, env }`. That's what lets the Windows, macOS, and Linux path rules all
be unit-tested on any one machine.

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
npm test                         # node --test — 1566 tests, no network, no claude required
node scripts/verify-ui-real.mjs  # asserts the panel's Windows facts (M1–M7) into ui-real-report.json
```

---

## License

MIT
