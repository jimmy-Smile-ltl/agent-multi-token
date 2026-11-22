# agent-multi-token

> **Status: archived (November 2026).** This project is no longer developed. It is published as-is,
> under the MIT license, in case the design or the code is useful. There is no support, no roadmap,
> and no guarantee that it still matches the current versions of Claude Code or Codex CLI.
> Read it as a design document with executable evidence.

Two zero-dependency Node CLIs that turn an AI coding agent's **one global configuration** into a
**per-path identity**:

| | [`claude code/`](claude%20code/) | [`codex/`](codex/) |
|---|---|---|
| Command | **`cmt`** | **`cxt`** |
| npm package | `claude-multi-token` | `codex-multi-token` |
| Wraps | Claude Code CLI | Codex CLI |
| Isolation primitive | `CLAUDE_CONFIG_DIR` | `CODEX_HOME` |
| Runtime home | `~/.claude-multi-token/` | `~/.codex-multi-token/` |
| Architecture contract | [`CLAUDE.md`](claude%20code/CLAUDE.md) | [`AGENTS.md`](codex/AGENTS.md) |
| User guide | [EN](claude%20code/README.md) · [中文](claude%20code/README.zh-CN.md) | [EN](codex/README.md) · [中文](codex/README.zh-CN.md) |

中文版：[README.zh-CN.md](README.zh-CN.md)

**What this document is.** The umbrella design document for both tools: the framework structure, the
logic system, and the reasons behind them. Usage, flags, and troubleshooting live in each project's
own README; the binding rules live in each project's contract. A reading order that works:

1. this file — the shared design;
2. `claude code/README.md` / `codex/README.md` — the command surface and pitfalls;
3. `CLAUDE.md` / `AGENTS.md` — the authoritative specification, including things this file omits.

---

## Quick start

**Prerequisite: the agent itself.** `cmt` / `cxt` are launchers, not installers — they do not
install, update, or configure Claude Code / Codex. Install that first, open a **new** terminal,
and confirm `claude --version` / `codex --version` works. Each project's README has the exact
commands ([`claude code/README.md`](claude%20code/README.md#step-0-install-claude-code-first),
[`codex/README.md`](codex/README.md#step-0-install-codex-cli-first)).

```bash
# 1. install the two CLIs from the checkout — Node ≥ 18, zero dependencies,
#    no build step. (The packages are not on the npm registry; see §9.)
cd "claude code" && npm install -g .    # gives you `cmt`
cd ../codex      && npm install -g .    # gives you `cxt`

# 2. describe an identity, bind a directory to it, launch there
cmt token add relay-a --token 'sk-...' --base-url https://api.deepseek.com/anthropic
cmt model set --token relay-a 'deepseek-flash[1m]:Flash 1M'
cmt bind D:/work/client-a --token relay-a

cd D:/work/client-a
cmt resolve        # the four elements, each tagged with the layer it came from
cmt run            # or bare: `cmt` → the browser console
```

`cxt` is the same five steps — one difference in the endpoint (`.../v1` for Codex), plus
`cxt trust <path>` to front-load the "do you trust this project?" question Codex asks at launch.

**Try before installing:** `node "claude code/bin/cmt.js" --help` runs straight from a checkout.

**Confirm the isolation, not just the launch.** Add a second token, bind a second directory, and
run `resolve` in each: the token, the endpoint **and** the profile directory must all differ.
That difference is the product (§1) — a window opening proves much less.

---

## Contents

- [Quick start](#quick-start)
- [1. The problem](#1-the-problem)
- [2. One design, two targets](#2-one-design-two-targets)
- [3. Framework structure](#3-framework-structure)
  - [3.1 Four layers, one direction](#31-four-layers-one-direction)
  - [3.2 Module map](#32-module-map)
  - [3.3 The shared kernel: 23 byte-identical files](#33-the-shared-kernel-23-byte-identical-files)
  - [3.4 Repository layout](#34-repository-layout)
- [4. The logic system](#4-the-logic-system)
  - [4.1 Identity: four elements, each with provenance](#41-identity-four-elements-each-with-provenance)
  - [4.2 Configuration: four layers, one merge](#42-configuration-four-layers-one-merge)
  - [4.3 Models: an ordered priority, not failover](#43-models-an-ordered-priority-not-failover)
  - [4.4 Two gates before anything launches](#44-two-gates-before-anything-launches)
  - [4.5 The launch chain: run hands off to exec](#45-the-launch-chain-run-hands-off-to-exec)
  - [4.6 Session-marker purge](#46-session-marker-purge)
  - [4.7 Isolation: one profile per token](#47-isolation-one-profile-per-token)
  - [4.8 Presence: the session registry](#48-presence-the-session-registry)
  - [4.9 Mailbox: messages are inert data](#49-mailbox-messages-are-inert-data)
  - [4.10 Attention: what the panel says needs you](#410-attention-what-the-panel-says-needs-you)
  - [4.11 The pool: an overlay, not a second credential store](#411-the-pool-an-overlay-not-a-second-credential-store)
  - [4.12 Two frontends, one reducer](#412-two-frontends-one-reducer)
  - [4.13 Usage and cost](#413-usage-and-cost)
- [5. Where the tools differ, on purpose](#5-where-the-tools-differ-on-purpose)
- [6. Command surface](#6-command-surface)
- [7. Security boundaries](#7-security-boundaries)
- [8. Tests](#8-tests)
- [9. Install and first run](#9-install-and-first-run)
- [10. Known limitations and footguns](#10-known-limitations-and-footguns)
- [11. Platform notes](#11-platform-notes)
- [12. License](#12-license)

---

## 1. The problem

Every AI coding agent keeps **one** global configuration per machine. One `ANTHROPIC_*` environment
block for Claude Code. One `$CODEX_HOME/config.toml` for Codex. So "run project A against relay A
and project B against relay B, at the same time" degenerates into hand-editing a global file or
re-exporting a block of variables every time you switch directories — and whichever you set last
wins everywhere.

```bash
# the manual workflow, repeated every time you switch projects
export ANTHROPIC_BASE_URL=https://relay.example.test
export ANTHROPIC_AUTH_TOKEN=...            # the key for THIS project only
export ANTHROPIC_MODEL=model-a
```

`cmt` and `cxt` replace that with **resolution**: you run the command in a directory, and the
token / endpoint / model for that directory are chosen for you, with **every value able to say which
layer it came from**.

```bash
cmt run            # in D:/work/client-a  → token relay-a, model-a, https://a.example.test
cmt run            # in D:/work/client-b  → token relay-b, model-b, https://b.example.test
```

### The one load-bearing idea: session isolation

Config switchers are a crowded category — [cc-switch](https://github.com/farion1231/cc-switch)
([ccswitch.io](https://ccswitch.io/zh/)) and
[api-key-manager](https://github.com/pikecode/api-key-manager) are two of them. A switcher's unit of
change is the machine-wide configuration: it decides **which identity the next launch reads**. By
construction one identity is active at a time, and the agent still has exactly one config directory.

The idea here is the opposite one — **isolation as a per-session property** — and almost everything
in this document follows from it:

- the isolation primitive (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) points at `profiles/<token>/`, so
  config, login state, and history never meet (§4.7);
- an identity is chosen **before** a session starts and held for its whole life — no in-session
  switching, no polling, no load balancing (§4.1, §4.3);
- which identity you get is a property of **where you ran**, resolved from a path, not of a global
  toggle (§4.2);
- once sessions are first-class objects, they earn a registry, a mailbox, and an attention list —
  all file-based, all owned by the wrapper (§4.8–§4.10).

The neighbours go further in directions this project deliberately refused: managing the agent's own
sessions and state, and giving each session a different LLM configuration *inside* the agent. Both
mean hooking or reimplementing the agent, which the contract forbids (§7) — a wrapper that only
injects environment variables has no business doing either. Switching is a configuration change;
isolation is a state boundary. Everything else in this repository — the two frontends, the pool, the
mailbox — is scaffolding around that one boundary.

---

## 2. One design, two targets

The two projects are not forks of each other. They are **two implementations of the same design**
against two different hosts, and they deliberately keep their domain layers identical in shape:

| Shared concept | Why it is shared |
|---|---|
| **Four elements** — `cwd` / `token` / `baseUrl` / `model` | A session needs all four. Missing any one refuses to launch, **naming the missing one**. |
| **Provenance on every resolved value** | `resolve` must answer "why did this directory get this token?" — so each value carries its source layer. |
| **Two launch gates** | (1) four elements complete; (2) no unresolved `${...}` reference. Both throw; neither is a warning — the child TUI would paint over it. |
| **Isolation by environment variable** | One env var points the agent at a per-token profile directory. That is the whole trick. |
| **Credentials only as process environment** | Never inlined into a launch script, never a second plaintext copy on disk. |
| **Layered configuration, right wins** | Global defaults ← token ← path binding ← project-local file, plus CLI flags on top for a one-off. |
| **Ordered model priority** | `models[0]` is the default; the rest is an explicit, human-driven promotion stack. |
| **Two frontends, one reducer** | A full-screen TUI and a local web console drive the *same* state machine. |
| **Presence and mailbox** | A file-based session registry and a file-based inbox, both owned by the wrapper, both readable by `cmt`/`cxt` and the panel. |
| **Zero runtime dependencies** | `node:` built-ins only. No build step. The published tarball is the source. |

### Product invariants (both tools)

1. **One session, one token.** No polling, no load balancing, no in-session automatic switching.
2. **Total isolation.** Different tokens never see each other's config, login state, or history.
3. **Layered and explainable.** Any layer can override the one below it, and every value can name
   the layer it came from.
4. **The tool never acts on the user's behalf.** A message is delivered only when a human tells the
   agent to read it; the tool does not auto-reply, auto-forward, or auto-launch.

### Non-goals (both tools)

- ❌ Not a proxy / relay implementation. It only points at one.
- ❌ No encryption of stored tokens — plaintext JSON, documented as such.
- ❌ No modification of, or hooks into, the wrapped agent.
- ❌ No external GUI service. (Both ship **their own** two frontends — see below. That is not the
  same thing.)
- ❌ **Zero npm runtime dependencies**, ever. `node:` built-ins only.

---

## 3. Framework structure

### 3.1 Four layers, one direction

Both projects use the same layering. The arrows matter more than the folder names:

```
bin/            argv → cli/                     shebang forwarding only; no logic
  │
  ▼
cli/            parse · call core · call platform · render
  │                │
  ▼                ▼
core/  ◀────────  platform/                     core receives the platform, never imports it
pure rules        the only layer that knows the host
```

| Layer | Allowed | Forbidden |
|---|---|---|
| `bin/` | forward to `cli/main.js` | any decision, any I/O |
| `cli/` | parse args, orchestrate, read/write through core, render | owning domain rules |
| `core/` | pure domain logic; `store.js` is the **single** fs seam | `process.env`, `process.platform`, `os.homedir()`, `spawn`, `node:http` |
| `platform/` | the concrete OS, terminal, filesystem, network | knowing the tool's business rules |

Three files are the proof that the boundary is real:

- `platform/serve-web.js` is the only file that imports `node:http`.
- `cli/ui/term.js` is the only file under `cli/ui/` that touches stdin/stdout.
- `platform/pid.js` is the only file that calls `process.kill`.

`core/` gets its platform facts injected (`{ ok, now, rand, ... }`), which is what makes the domain
tests deterministic without mocking Node.

### 3.2 Module map

The two trees are the same skeleton plus host-specific pieces. `codex/`-only modules are marked
**cxt+**.

```
claude code/  (cmt)                         codex/  (cxt)
├── bin/cmt.js                              ├── bin/cxt.js
├── src/
│   ├── core/                               │   ├── core/
│   │   ├── paths · schema · validate       │   │   ├── (same)
│   │   ├── store            ← fs seam      │   │   ├── (same)
│   │   ├── resolve · bindings              │   │   ├── (same)
│   │   ├── models · models-endpoint        │   │   ├── (same)
│   │   ├── project-config · project-state  │   │   ├── (same)
│   │   ├── resources · pool · sheet        │   │   ├── (same)
│   │   ├── sessions · usage · prices       │   │   ├── (same)
│   │   ├── launch-script · seed · errors   │   │   ├── (same)
│   │   │                                   │   │   ├── catalog      ← cxt+  (codex config.toml model)
│   │   │                                   │   │   ├── trust        ← cxt+  (trust table)
│   │   │                                   │   │   ├── toml-splice  ← cxt+  (line-level editor)
│   │   │                                   │   │   ├── toml-value   ← cxt+
│   │   │                                   │   │   └── doctor       ← cxt+  (managed-region checks)
│   ├── cli/                                │   ├── cli/
│   │   ├── main · help · parse-args        │   │   ├── (same)
│   │   ├── format · arg-path · target      │   │   ├── (same)
│   │   ├── session · resume · sessions     │   │   ├── (same)
│   │   ├── pool-pick · pool-store          │   │   ├── (same)
│   │   ├── pool-usage · preflight          │   │   ├── (same)
│   │   ├── price-table · probe             │   │   ├── (same)
│   │   ├── usage-sources · pick · types    │   │   ├── (same)
│   │   ├── claude-bin                      │   │   ├── codex-bin
│   │   ├── commands/                       │   │   ├── commands/
│   │   │   ├── ls · resolve · run · exec   │   │   │   ├── (same)
│   │   │   ├── token · bind · model · slot │   │   │   ├── token · bind · model
│   │   │   ├── pool · doctor · profile     │   │   │   ├── pool · doctor · profile
│   │   │   ├── usage · ui · ui-web         │   │   │   ├── (same)
│   │   │   ├── sessions · msg · resume     │   │   │   ├── (same)
│   │   │   │                               │   │   │   ├── trust        ← cxt+
│   │   │   │                               │   │   │   └── (no slot — Codex has no aliases)
│   │   │                                   │   │   ├── state-edit     ← cxt+
│   │   └── ui/{app,keys,render,term}.js    │   │   └── ui/{app,keys,render,term}.js
│   ├── platform/                           │   ├── platform/
│   │   ├── index · windows · macos · linux │   │   ├── (same)
│   │   ├── find-executable                 │   │   ├── (same)
│   │   ├── fetch-models · open-browser     │   │   ├── (same)
│   │   ├── open-path · serve-web           │   │   ├── (same)
│   │   ├── redis · pid                     │   │   ├── (same)
│   │   │                                   │   │   ├── resolve-terminal   ← cxt+
│   │   │                                   │   │   ├── spawn-terminal     ← cxt+
│   │   │                                   │   │   └── spawn-foreground   ← cxt+
│   └── web/{index.html,app.js,style.css}   │   └── web/{index.html,app.js,style.css}
├── tests/                                  ├── tests/
├── scripts/                                ├── scripts/
├── CLAUDE.md                               ├── AGENTS.md
└── README.md / README.zh-CN.md             └── README.md / README.zh-CN.md
```

Two conventions are load-bearing:

- **A command file renders; it does not decide.** `cli/commands/*.js` wires arguments to core and
  formats the result. Rules live in `core/`.
- **The panel is the same command surface, not a second implementation.** `ui.js` and `ui-web.js`
  call the same session/pool/token functions the CLI calls.

### 3.3 The shared kernel: 23 byte-identical files

Two files called `resolve.js` would be a fork. Two files called `core/sessions.js` are a
**contract**: "what counts as a live session" must have one definition, or the two projects will
slowly disagree while both suites stay green.

Twenty-three files exist twice and **must be byte-identical**:

```
src/cli/ui/{app,keys,render,term}.js                  panel kernel + reducer
src/platform/{serve-web,open-browser,open-path}.js    local HTTP, browser, file manager
src/web/{index.html,app.js,style.css}                 the web console itself
src/core/{pool,sheet,sessions}.js                     pool logic, spreadsheet import, presence
src/platform/{redis,pid}.js                           RESP2 client, process liveness probe
tests/{serve-web,open-browser,open-path,pool,
       sheet,redis,sessions,pid}.test.js              their guards
```

`tests/shared-files.test.js` compares bytes with `Buffer.equals()` — not string equality, which
would hide BOM and line-ending drift — and **visibly skips** rather than silently passing when the
sibling project is not in the checkout.

The constraint this imposes: shared files contain **no tool name, no environment variable name, and
no parent section number**. Tool names arrive through the view model; env var names are resolved by
the caller; contract references cite a section by name. Otherwise one project's copy would be wrong
in the other's context.

### 3.4 Repository layout

```
agent-multi-token/
├── README.md / README.zh-CN.md     ← this design document (EN / 中文)
├── LICENSE                         ← MIT
├── .gitattributes                  ← LF by default; .cmd CRLF; .sh LF
├── .gitignore                      ← runtime homes, keys, test_resource/ default-deny
├── claude code/                    ← cmt  (bin, src, tests, scripts, CLAUDE.md, README ×2)
├── codex/                          ← cxt  (bin, src, tests, scripts, AGENTS.md, README ×2)
└── test_resource/                  ← optional wiring notes and example fixtures
    ├── README.md                   ← tracked: wire-API findings + Windows traps
    ├── tokens.example.json         ← tracked: fake keys, three pool states
    ├── endpoints.example.json      ← tracked: placeholder endpoint + probe shape
    └── tokens.json / endpoints.json / probe*.py   ← IGNORED, local-only, never committed
```

`test_resource/` is **default-deny**: everything is ignored, and only `README.md` and
`*.example.json` are re-included with explicit `!` rules. Adding a file there does not require
editing `.gitignore` — being blocked is the default, and that friction is the point. Tracked files
contain no real keys or internal hosts; if you keep real fixtures locally, they stay local.

---

## 4. The logic system

The whole product is one loop. Everything below is a detail of this diagram:

```
cwd ──resolve──▶ four elements + provenance
                        │
                        ▼
                  two gates (complete? resolved?)
                        │
                        ▼
              cmt run  ──spawn terminal──▶  cmt exec
                                                │
                         strip inherited markers │
                         inject this identity    ▼
                                            spawn agent
                                                │
                       ┌────────────────────────┴────────────────────────┐
                       ▼                        ▼                        ▼
                 meta.json (presence)     inbox/ (mailbox)        sample stdout
                       │
              live → ended / dead  ──▶  sessions · recentSessions · attention · resume
```

### 4.1 Identity: four elements, each with provenance

A session is defined by four values:

```
cwd      where the agent runs
token    which credential (and therefore which profile)
baseUrl  where requests go
model    what the agent asks for by default
```

Resolution walks the layers for each field independently. The result is not just the values — it is
`{ value, source }` for each one, so `resolve` can answer the only question that matters when
something is wrong:

```bash
cmt resolve            # token relay-a (binding: D:/work/client-a) · model model-a (token)
```

Provenance is not decoration. Without it, "why is this window using the wrong key?" has no answer
short of reading every config file by hand.

### 4.2 Configuration: four layers, one merge

```
defaults (global)  ←  token  ←  path binding  ←  project-local file
                                                (.cmt.json / .cxt.json)

              ... and CLI flags beat all four for a single invocation.
```

Resolution runs top-to-bottom per field, and the result records which layer won. `--model` and
`--url` are not a fifth layer — they are per-invocation intent, applied last.

Merge semantics differ **per field kind**, and this asymmetry is deliberate:

| Kind | Rule | Why |
|---|---|---|
| `baseUrl` / `authToken` / `models` / `slots` | **Whole-value replacement** | These are a coherent choice. Half of one endpoint with half of another is not a configuration. |
| `env` | **Key-wise merge** | Independent escape-hatch variables. |
| `claudeArgs` | **Concatenation**, low → high | Independent switches; later ones win argv parsing. |

Two rules carry more weight than they look like they do:

- **`""` (empty string) in `env` means *delete*, not *inject empty*.** On Windows an empty environment
  variable *is* a deletion; on POSIX it is a real empty value. One config must not mean two things
  across platforms — so `""` always lands in the "remove from the inherited environment" set.
- **`models: []` (explicit empty) ≠ `models` absent.** Absent means "inherit"; explicit empty means
  "do not inject a model, use the agent's own default" — and therefore *also* remove the inherited
  model override, or "default" would silently mean "the parent session's model".

Project-local files (`.cmt.json`, `.cxt.json`) are the fourth layer, and they are **restricted on
purpose**: they may name a token, set models, env, and args — but **may not carry credentials or a
base URL**. A cloned repository that could redirect your key to its own endpoint is an attack
surface, not a convenience. The consequence is a feature: these files contain no secrets, so they
are safe to commit. Discovery walks upward from `cwd` to the nearest file; `--config <path>` skips
discovery and names one explicitly.

### 4.3 Models: an ordered priority, not failover

```
models[0]   = the default for this session
models[1..] = candidates, promoted by a human when [0] goes down
```

Alias slots (`opus` / `sonnet` / `haiku` / `fable` / `subagent`, cmt only) map onto the host's
alias variables. Any slot not declared is **filled from `models[0]`** — otherwise an alias the relay
does not serve would be requested the moment a user types `/model`. An explicit `null` means "do not
inject this slot", which also removes the inherited variable.

> **Priority is not failover.** Mid-session automatic fallback does not exist. The
> `--fallback-model` chain (Claude Code) only applies in `--print` mode; interactive sessions simply
> run `models[0]`. The supported workflow is two commands:
>
> ```bash
> cmt model next     # rotate: the next candidate becomes models[0]
> cmt run -c         # new tab, continue the conversation that just died
> ```
>
> `cxt model next` does the same thing. Rotation writes the configuration layer you asked for, so the
> next launch — and the next window — sees the new order.

There is one automatic behavior, and it is **not** failover: a **startup preflight**. Before
spawning, the tool may issue one read-only `GET {baseUrl}/models` with a 2-second timeout and use the
first model from the list that actually exists.

| Situation | Behavior |
|---|---|
| `models[0]` is listed | launch as configured, **say nothing** |
| `models[0]` missing, `models[k]` present | use `models[k]` **for this run only**, one `⚠` line to stderr, **write nothing** |
| nothing matches | launch as configured, one line explaining it |
| endpoint unreachable / no `/models` | **silent**, launch as configured — normal for internal endpoints |

Boundaries that keep this from becoming something else: it happens **once**, **only on the real
launch path** (`--print` diagnostics never hit the network), **never** writes config, resources, or
profiles, and can be disabled with `defaults.preflight: false`.

### 4.4 Two gates before anything launches

Both are hard refusals, not warnings. A warning printed before an interactive TUI starts is a
warning nobody sees.

1. **Completeness.** All four elements must resolve. The error names the missing one and prints the
   command that would fix it (`cmt bind ...`, `cmt token add ...`).
2. **No unresolved references.** `${VAR}` in a credential or URL is expanded at resolve time. If a
   reference cannot be expanded, the launch is refused — the tool never hands the literal `${VAR}` to
   the agent as if it were a key.

Exit codes are part of the interface: **0** success, **1** user error (bad token name, conflicting
flags, missing element), **2** environment error (agent not on `PATH`, terminal detection failed,
directory not writable). Scripts can tell "you asked wrong" from "this machine is missing
something".

### 4.5 The launch chain: run hands off to exec

Both tools split launching into **two processes**, and the split is the security design:

```
cmt run relay-a
  ├─ 1. resolve four elements (recording provenance)
  ├─ 2. completeness gate → refuse, naming what is missing
  ├─ 3. unresolved-reference gate → refuse (never inline a literal `${VAR}`)
  ├─ 4. detect a terminal, spawn it with an argv ARRAY
  └─ 5. write nothing. Stateless.

new tab:  cmt exec relay-a --model <id>
  ├─ buildSessionEnv() = strip session markers → delete `unset` → apply injection
  ├─ record the session in meta.json (presence)
  ├─ (optional) startup preflight — read-only GET /models
  └─ spawn(claude, argv, { env, stdio: 'inherit' })   ← the ONLY spawn point
```

Three consequences worth stating outright:

1. **The launch script never contains the token.** It only calls `<abs node> <abs cmt> exec ...`.
   A self-contained script would be one more plaintext copy of the key, on disk, forever.
2. **No shell ever parses the arguments.** `argv` stays an array all the way to `spawn`, which is
   why a Chinese path in a Chinese Windows `cmd.exe` (OEM code page) does not corrupt anything.
   The launch script is only a **fallback** for terminals that can only take a command string.
3. **`cmt run` refuses `--token-value`** — the value would have to cross a process boundary, and
   every way of doing that writes it somewhere. One-off credentials go through `exec` (already
   inside the window); reusable ones go through `token add`. (`cxt run` accepts it because Codex's
   launcher passes the value differently, but the same preference applies: use `token add`.)

The outer process never waits for the window, and the inner process is the only one that knows the
session's lifetime. That is why the presence record is written by `exec`, not by `run`.

### 4.6 Session-marker purge

A new terminal is **not** a clean environment: Windows Terminal forwards the caller's whole process
environment into the new tab. If you launched from inside an agent session, the new session inherits
the parent's identity — including `CLAUDE_CODE_CHILD_SESSION=1`, which turns transcript saving
**off**.

So the final environment is always computed, never inherited blindly:

```
inherited environment
  → strip session markers          (cmt: 9 Claude names · cxt: 13 CODEX_* names)
  → delete everything in `unset`   (unselected auth var, explicitly-empty models/slots, env "")
  → apply injected values          (wins over `unset`, always)
  → add this session's id          (CMT_SESSION_ID / CXT_SESSION_ID, for the mailbox)
```

`cxt` also clears the **entire foreign `CXT_TOKEN_*` family**, keeping only the variable this
session injects — otherwise a stale credential from the parent would still be visible to the child.
The session-id variable is itself on the strip list, so a nested window cannot inherit its parent's
mailbox identity.

The invariant: **the result must not depend on where the command was called from.** A test asserts
that the same resolution produces a byte-identical environment under a clean base and a fully
polluted one.

### 4.7 Isolation: one profile per token

```
profiles/<token>/     ← the profile; comes from the isolation variable
profiles/_default/    ← reserved name for "no token identity"
```

The profile is named after the **token**, never after the directory. A token used in five
directories shares one profile; the agent separates history by directory slug inside it. Therefore:

- `-c` / `--continue` is scoped to **config directory + current directory** — not to the key value.
- **Changing the key for an existing token keeps history**: `cmt token edit <name> --token <new>`.
  Switching to *another token* is switching identity, and `-c` will not find that conversation.
  Use the former, not the latter, to rotate a key.

Do not confuse `profiles/<token>/sessions/` (the agent's own conversation history) with the
wrapper's `sessions/<id>/` described next. They share a word and nothing else; the wrapper never
reads or writes the agent's history.

### 4.8 Presence: the session registry

`run` spawns a terminal and forgets it. The only process that spans a session's lifetime is `exec`,
so `exec` is the **only writer** of the presence record:

```
<runtime home>/sessions/<id>/
├── meta.json                  {v, id, token, cwd, pid, startedAt, endedAt, exitCode, model}
├── inbox/<ms>-<rand>.json     unread messages
└── read/<ms>-<rand>.json      read messages (moved here by rename)
```

- **ID shape**: `<profile>-<base36 timestamp>-<pid>` — readable, sortable, unique per launch.
- **Written at start and at exit**: `recordSessionStart()` / `recordSessionEnd()`. If writing fails,
  the session continues and prints one warning — presence must never block real work.
- **No argv, ever**: `meta.json` is a whitelist of nine fields. This is enforced twice — the writer
  does not pass argv, and `normalizeSessionMeta()` drops anything else. The reason is concrete:
  `cxt exec --token-value` is a plaintext key, and a "just log the command line" change would put it
  on disk.
- **Three states, computed at read time**:
  - `live` — no `endedAt`, and `process.kill(pid, 0)` succeeds (EPERM counts as alive: the process
    exists, we just may not signal it).
  - `ended` — `endedAt` present.
  - `dead` — no `endedAt` but the process is gone (crash, `kill -9`, terminal closed).
- **Known limit**: pid reuse can report a `dead` session as `live`. This is an overview for a human,
  not an audit log; the contract says so.

```bash
cmt sessions                 # table: state · session · token · unread · start · cwd
cmt sessions --json          # machine-readable rows
cmt sessions prune [--older-than 30d] [--force]
```

`prune` deletes old `ended`/`dead` records, never a `live` one, and refuses to delete a session with
unread mail unless `--force`. `resume <id|prefix>` brings a closed or crashed window back: same
token, same `cwd`, with `-c` in a new window. It **refuses a live session** — that window is still
open; switch to it instead.

The panel derives two lists from the same registry:

- `sessions[]` — live only, joined with pool status and unread count.
- `recentSessions[]` — `ended`/`dead` within **24 hours**, at most **5**, newest first. This is what
  the "restore" buttons in the session strip are built from.

### 4.9 Mailbox: messages are inert data

```
cmt msg send <id|--token <t>|--all> [--type info|action-request] "text"
cmt msg inbox [--session <id>] [--peek] [--json]
cmt msg gc [--older-than 7d]
```

A message is one JSON file:

```json
{ "v": 1, "id": "…", "ts": "…", "from": "human", "to": "<session id>",
  "type": "info", "body": "…" }
```

- **Delivery is a file.** `msg send` writes one file into `<session>/inbox/`. Each target gets its
  own copy; there is no shared queue and no broadcast daemon.
- **Reading is a rename.** `msg inbox` (without `--peek`) moves each message from `inbox/` to
  `read/` in the same directory — atomic, no partial state, no second ledger of what was read.
  `--peek` shows without moving.
- **Only live sessions accept mail.** `send` targets `state === 'live'`; a prefix must match exactly
  one live session, and "no target" is a loud exit-1 error, not a silent no-op.
- **Sender identity comes from the environment.** `exec` injects `CMT_SESSION_ID` / `CXT_SESSION_ID`.
  If that value is missing, invalid, or does not correspond to a real meta record, `from` is
  `"human"` — a forged value cannot impersonate a session.
- **The tool never acts on a message.** This is the central rule: a message is data, not a command.
  `type: info | action-request` is a label for the reader; neither grants execution rights. There is
  no auto-forward, no auto-reply, no agent loop. The only delivery mechanism is a human telling the
  agent "run `cmt msg inbox`" — which is also why mailboxes cannot ping-pong.
- **Retention.** `msg gc` removes messages older than 7 days by default, from both `inbox/` and
  `read/`. Unparsable or future timestamps are left alone rather than guessed at.
- **Messages are plaintext JSON.** Do not paste secrets into them; the help text says this.

### 4.10 Attention: what the panel says needs you

The panel does not ask the browser to decide what is wrong. The server computes a short list,
**at most 5 rows**, each with an action descriptor the page can render without understanding it:

```json
{ "kind": "mail", "severity": "high",
  "title": "relay-a has 2 unread (window closed)",
  "detail": "first line of the oldest…",
  "actions": [{ "label": "Restore", "op": "resume-session", "args": { "session": "…" } },
              { "label": "Mark all read", "op": "msg-read-all", "args": { "session": "…" } }] }
```

Three kinds, in priority order:

| Kind | When | Severity |
|---|---|---|
| `token-bad` | A **live** session's token has become `no_quota` or `invalid` | high |
| `mail` | A session has unread messages; a **closed** session ranks above a live one | high / normal |
| `exit-fail` | A recently closed session exited non-zero (and has no unread mail) | normal |

Actions reuse existing operations (`check-token`, `msg-read-all`, `resume-session`), so adding a new
signal means changing the server only. An empty list is healthy and renders as a collapsed block —
the panel never shows an empty "action required" area.

### 4.11 The pool: an overlay, not a second credential store

`pool.json` holds quota status and usage for tokens that already exist. It **never contains a key**:

```
tokens/<name>.json   ← the only home of the plaintext credential
pool.json            ← status, checkedAt, usage, models; joined by token name
```

Six states, one vocabulary: `ok` · `no_quota` · `invalid` · `net_fail` · `other` · `unknown`.
`pool check` sends one **minimal real request** per key (it costs a little money) and classifies the
response — 402 is `no_quota`, 401 is `invalid`, quota phrases in the body beat the status code.

Freshness is per state, not one global TTL:

| State | Re-probe after |
|---|---|
| `ok` / `other` / `net_fail` | 300 s (configurable) |
| `no_quota` | the month changes (local calendar) |
| `invalid` | 24 h |
| `unknown` | immediately |

Choosing a token (`--pool`, or auto-fill when nothing resolves) sorts candidates; it does not
balance load across a session:

- Policy: least-used (total usage) or round-robin for ties.
- **Tokens currently held by live sessions are sorted to the end — not excluded.** Running two
  windows on one token is allowed; the default just avoids stealing the key someone is using.
- **`-c` is guarded by `lastPick[cwd]`.** If `--pool` would pick a different token than the one that
  wrote the conversation being continued, the tool refuses instead of silently starting a fresh
  session under a new identity. Resuming is not the moment to change who you are.
- One pick, pinned for the whole session. No in-session switching, ever.

Redis is an optional **mirror**, not a home: `pool sync --redis` writes through; `pool pull --redis`
reads back. `pool list` / `check` / `status` / `reset` and every launch path never connect to Redis.
Without Redis, everything still works.

### 4.12 Two frontends, one reducer

Neither tool makes you memorize flags. Both ship:

- **`cmt ui` / `cxt ui`** — a full-screen TUI in the terminal you already have (arrow keys,
  paste-safe, strict per-line width so CJK never wraps the layout, guaranteed terminal restore on
  exit).
- **the bare command** on a TTY — a **local web console**: native `<select>`, checkboxes, buttons,
  rendered by your browser against a server that is still the CLI process itself.

```
commands/ui.js        ← business: side effects, result events, view model
  ├─ commands/ui-web.js   ← the bridge (HTTP)
  │     └─ platform/serve-web.js  ← 127.0.0.1 only, random port, path token
  └─ cli/ui/{app,keys,render,term}.js  ← TUI presentation
```

What is shared is **all business logic**: the side-effect vocabulary, the reducer, and the view
model. What is not shared is **presentation**. There is no second path that writes configuration.
Browser-only operations (`set-status`, `set-model`, `check-token`, `set-pool-status`, `sync-usage`,
`resume-session`, `msg-read-all`, `open-path`, …) are intercepted before the shared reducer sees
them; everything else becomes the same event the TUI would produce.

The **view model** is a frozen key set shared by both projects: a panel opened by one build can be
read by the other's tests. It carries `items`, `tokens`, `resources`, `poolStatuses`, `sessions`,
`recentSessions`, `attention`, `statuses`, `wizard`, `notice`, … — and **never a plaintext key**.
Masked values (`sk-****abcd`) and `secretLength` are the only credential-shaped things that cross
the wire; the one exception is the user's own typing in the new-token form.

**Threat model** — the console writes config files and receives plaintext keys, so it is built like a
local service, not a dev server: bind `127.0.0.1` only · random port · a 32-hex **path token**
compared with `timingSafeEqual` (the main line of defense) · `Host` allowlist on every request
(DNS rebinding) · `Origin` required on POST (CSRF) · never emits CORS headers · strict CSP ·
64 KiB body cap enforced while reading · per-method allowlist · `no-store` on the API · 30-minute
idle exit · SIGINT cleanup · request logs never contain bodies. Each control has a test that must go
red when the control is removed.

### 4.13 Usage and cost

Both tools read the transcript files the agent already writes and report token usage; prices come
from a three-level chain:

```
hand-written prices.json (settlement price)
  > pricing advertised by the endpoint (pulled with /models)
    > unknown → render "—", never pretend it is $0
```

The hand-written price always wins, because a gateway's advertised price must not silently overwrite
the price you actually pay. Usage is recomputed from the local files, incrementally cached by
size + mtime; the pool's aggregate is the sum of its per-token details, asserted as an invariant.

```bash
cmt usage --days 7 --by model
cxt usage --days 7 --by token --json
```

---

## 5. Where the tools differ, on purpose

Everything above is shared. The differences below come from the hosts, not from taste.

### `cmt`: writes nothing

Claude Code is configured entirely through **environment variables**. So `cmt` has one rule:
**never write the agent's configuration files.** That keeps the tool from breaking every time
Claude Code's config format evolves.

There is exactly one exception, and it is opt-in, off by default: `defaults.seed`
(`off` | `onboarding` | `full`) may *add* missing keys to `profiles/<token>/.claude.json` so a new
profile starts without dialogs. It is append-only (an existing `hasTrustDialogAccepted: false` is
never flipped), idempotent, backed up once, and **never copies the user's real `~/.claude.json`**.
`settings.json` is excluded, permanently.

### `cxt`: a config file with two authors

Codex does not accept everything from the environment. It must find its provider in
`$CODEX_HOME/config.toml` — which **Codex itself also writes** (`[projects.*]` trust records).
So the file has two authors, and `cxt` edits a **managed region** inside it:

```toml
model = 'model-a'
model_provider = 'cxt-relay-a'

[model_providers.cxt-relay-a]
name = 'relay-a'
base_url = 'https://a.example.test/v1'
env_key = 'CXT_TOKEN_RELAY_A'      # only the NAME; the value is injected at spawn time
wire_api = 'responses'
```

Four rules make this safe: touch only managed keys · never delete `[projects.*]` · never delete the
file · back it up once (`config.toml.cxt.bak`). The editor is a **line-level splicer**, not a TOML
parser — a parse-and-reserialize would discard comments and key order, i.e. destroy the other
author's work on every run. Missing managed keys are inserted *before the first section header*,
because inserting them after one would silently turn them into keys of that section.

> The credential still does not go into the file. `env_key` stores only the variable **name**;
> `cxt` injects the value into the child's environment. `experimental_bearer_token` would inline the
> key, giving it a second home and doubling the leak surface.

### Trust (cxt only)

Codex records trust per project path in `[projects.'<path>']` inside `config.toml`. `cxt trust`
writes that entry with the **path exactly as the OS spells it** (Windows backslashes preserved,
TOML literal string). A forward-slash variant does not error — it silently never matches, which is
the easiest mistake in the whole tool. `--untrust` sets `"untrusted"` rather than deleting the
entry; `--all` marks every binding of a token; `trust ls` is read-only.

### Terminal placement

`cmt run` defaults to opening a **tab in a window named `cmt`**, so many tokens share one window with
distinct titles. `cxt run` defaults to a **new window**. Both accept `--window` / `--tab` to override
`defaults.terminalMode` for one launch.

### Wire API and `baseUrl`

The two hosts speak different protocols, so they expect different URLs:

| | Protocol | Endpoint | `baseUrl` you configure |
|---|---|---|---|
| `cmt` | Anthropic Messages | `/v1/messages` | **without** `/v1` |
| `cxt` | OpenAI Responses | `/v1/responses` | **with** `/v1` |

Both append `/v1/...` themselves, so getting this backwards yields `/v1/v1/...` and a 404.

And for `cxt`, **`models[0]` must be an OpenAI-family model**: Codex ≥ 0.59 only accepts
`wire_api = "responses"`, and many relays implement `/v1/responses` only for their OpenAI channels.
A model can be listed in `/models` *and* work on `/v1/chat/completions` while still being unusable
by `cxt`. Run the probe before committing a token.

---

## 6. Command surface

The full list is in `cmt --help` / `cxt --help` and in each README. The shape is:

| Concern | Commands | Notes |
|---|---|---|
| Tokens | `token add / show / edit / rm`, `ls` | `show` is always masked; `edit` rotates a key without losing history |
| Binding | `bind`, `bind ls`, `bind rm` | longest-prefix match over normalized paths |
| Resolution | `resolve`, `doctor` | `resolve` prints every value **and its source layer** |
| Models | `model ls / set / use / next / clear` | `cmt` also has `slot`; `cxt` does not (no alias slots) |
| Launch | `run`, `exec` | `run` opens the terminal; `exec` is the in-window half |
| Sessions | `sessions`, `sessions prune`, `resume` | three states, unread guard, restore by id/prefix |
| Mailbox | `msg send / inbox / gc` | inert files; reading moves inbox → read |
| Pool | `pool list / import / check / status / reset / sync / pull` | `import` takes CSV or xlsx |
| Usage | `usage [--days] [--by token\|project\|model\|day]` | reads local transcripts; prices are layered |
| Frontends | `ui`, `ui --web`, bare command | TUI and browser console share one reducer |
| Profiles | `profile path`, `profile ls` | the directory is the isolation variable |
| Trust | `cxt trust …` | `cxt` only |

Common flags: `--json` (machine output), `--config <path>` (name a project-local file, skip upward
discovery), `--cwd`, `--model`, `--url`, `--print` (show the environment and command without
launching), `--` (pass the rest to the agent).

---

## 7. Security boundaries

- **A token has exactly one on-disk home**: `~/.{claude,codex}-multi-token/tokens/<name>.json`.
  It is not encrypted. Protect your home directory; do not sync these files to shared storage.
- **The launch script never contains credentials.** `cmt run` refuses `--token-value`, and refuses
  `--url` values carrying `user:pass@`. `cxt` writes only the env var *name* into `config.toml`.
- **`cmt` never writes the agent's `settings.json`**; the only file it may touch is `.claude.json`,
  append-only, opt-in, off by default.
- **`cxt` only edits its managed region** of `config.toml` and never removes `[projects.*]`.
  Everything outside the marker block belongs to Codex or to the user.
- **Project-local files cannot carry keys or endpoints**, so a cloned repository cannot exfiltrate
  your key — it can only *name* a token that already lives in your home directory.
- **The web console binds loopback only**, with a per-run path token; it is not reachable from the
  LAN, and it is not a service — it dies with the process.
- **Presence and mail contain no secrets**: `meta.json` is a nine-field whitelist; messages are
  plaintext text the user wrote, and the help text warns against pasting keys.
- **Never commit real keys or internal hosts.** `test_resource/` is default-deny and tracked files
  contain only examples. Test fixtures use fake keys everywhere; the source-hygiene test fails the
  suite on an `sk-…`-shaped string.

---

## 8. Tests

```bash
cd "claude code" && npm test     # = node --test
cd codex         && npm test     # = node --test
```

No test framework, no dev dependencies. The suites cover:

- **Pure logic** (`core/`): path normalization (NFC, case rules, separators), longest-prefix binding,
  resolution order and provenance, environment merge and purge, model rotation/promotion, schema
  validation, launch-script generation rules, pool freshness and ordering, session-state
  classification, message normalization.
- **End-to-end** with a **fake agent binary** that writes back exactly what it received — argv,
  env, cwd — including through a real `.cmd` shim on Windows, exit-code propagation, and the
  two-gate refusal paths.
- **Presence and mailbox** against a sandboxed home: start → live, normal exit → ended, unreachable
  pid → dead, inbox → read atomic move, `--peek` leaves files, prune refuses unread mail without
  `--force`, `resume` refuses a live session.
- **Terminal/panel**: byte-level assertions on restore sequences, size invariants across viewport
  sizes, split-key input, paste mode swallowing control characters.
- **Security**: each console control, the path/`Host`/`Origin` checks, the API returning the bare view
  model, the golden key set of the cross-project interface, and the 23 shared files.
- **Source hygiene** (`tests/source-hygiene.test.js`): no `sk-…`-shaped secrets, no `https://` host
  outside RFC 2606 placeholders or reserved TLDs, no raw control characters, no BOM. Error messages
  print only the first 3 characters and a length — the guard must not become the next leak.

The contracts forbid putting volatile numbers (test counts, hashes) into assertions; the guards
assert **structure and relationships**, not snapshots of them.

---

## 9. Install and first run

The five-command walkthrough is at the top of this file: [Quick start](#quick-start). This section
is the install detail around it.

**Node ≥ 18.** No build step, no dependencies: `dependencies` is `{}` in both packages and every
import is `node:` built-in, so there is nothing to audit and nothing to break.

**The packages are not on the npm registry.** This project was archived before publication, so
`npm install -g claude-multi-token` will return a 404. Install from the checkout:

```bash
cd "claude code" && npm install -g .    # → `cmt`
cd ../codex      && npm install -g .    # → `cxt`
```

Without installing anything:

```bash
node "claude code/bin/cmt.js" --help
node codex/bin/cxt.js --help
```

**Where it writes.** `~/.claude-multi-token/` and `~/.codex-multi-token/` — `config.json`,
`tokens/*.json` (plaintext; see §7), `profiles/<token>/` (the agent's own state, one per identity),
and `sessions/`. Nothing outside those trees and the directories you bind.

**Uninstall completely:**

```bash
npm uninstall -g claude-multi-token codex-multi-token
rm -rf ~/.claude-multi-token ~/.codex-multi-token    # Windows: Remove-Item -Recurse
```

The agent's real `~/.claude/` and `~/.codex/` were never touched (§7 and §4.7), so removing those
two directories undoes everything `cmt` / `cxt` ever did.

Each project's README covers the full command surface, the wizard, the panels, and the pitfalls.
Each project's contract (`CLAUDE.md` / `AGENTS.md`) is the authoritative specification — read it
before changing behavior, and change it **before** changing code.

---

## 10. Known limitations and footguns

- **Archived.** The wrapped agents move; this code does not. Check the contracts before trusting a
  behavior that depends on Claude Code / Codex internals.
- **Pid reuse.** A `dead` session can be reported as `live` if its pid was recycled. Presence is an
  overview, not an audit log.
- **Mail requires a human.** The tool never notifies an agent; someone has to tell it to run
  `msg inbox`. That is a deliberate safety property, not a missing feature.
- **`${VAR}` support differs.** `cmt` accepts an env reference in both `authToken` and `baseUrl`.
  `cxt` accepts it **only in `authToken`** — a `${` in `baseUrl` / `catalog` / `codexBin` / `cwd` is
  rejected at load time, and because all token files are loaded eagerly, **one bad file makes every
  config-loading command in that home exit 1** (including `ls`). Deliberate, documented, and it
  bites exactly once.
- **Session-marker families are per-tool.** `cmt` strips Claude's names, `cxt` strips Codex's.
  Do not assume one tool's purge covers the other.
- **`--continue` is per profile and per directory.** Switching tokens loses it; rotating a key with
  `token edit` keeps it.
- **Overselling `models` as failover.** It is an ordered preference plus a manual promotion stack.
  Only `--print` gets a real fallback chain, and only preflight auto-corrects — once, read-only.
- **Console concurrency.** Two consoles can write the same `config.json`; atomic writes prevent
  corruption, not lost updates. Last writer wins. Accepted for a single-user CLI.
- **`cxt trust` matches the path form, not the path identity.** A forward-slash spelling of a Windows
  path is accepted and silently never matches; use the native form.
- **`cxt -c` is not Codex `-p`.** `cxt -c` continues a conversation; Codex's own `-p` selects a
  profile. The two flags live in different parsers and mean different things.
- **macOS / Linux are unverified in a real terminal.** Adapters exist and are unit-tested with
  injected platform rules; branches that were never exercised on a real machine are marked
  `// UNVERIFIED`.

---

## 11. Platform notes

Windows is the primary, most-tested platform (Windows Terminal, PowerShell, `cmd.exe`). A few
hard-won facts are encoded in both projects and are not negotiable:

- All-ASCII `.cmd` files only — a Chinese path inside a batch file corrupts at the OEM code page,
  **silently**, while the same path passed through the environment works fine. This is why "argv
  array, no shell" is the primary launch path and scripts are the fallback.
- `.cmd` shims are invoked via `cmd.exe /c` (CVE-2024-27980); in a shim, `ENDLOCAL` must be chained
  with `&` or the child's exit code is swallowed.
- `wt.exe -w <name> new-tab` reuses a named window. Never `-w 0` / `-w last` (ambiguous), and
  `--suppressApplicationTitle` after `--title` or the agent's title overrides it.
- Window counting requires `EnumWindows`; `MainWindowHandle` reports 1 for the whole process.
- `explorer.exe` returns exit code 1 on **success**.
- The console code page is GBK: printing a model's emoji reply can raise `UnicodeEncodeError` even
  though the request succeeded. UTF-8 stdout is configured explicitly where it matters.

macOS and Linux adapters exist and are covered by unit tests with injected platform rules, but
real-terminal verification is Windows-only so far; those branches are marked `// UNVERIFIED`.

---

## 12. License

MIT — see [LICENSE](LICENSE). The two npm packages declare the same license.
