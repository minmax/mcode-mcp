# mcode-mcp

MCP server that delegates coding tasks to your **locally installed**
[MiniMax Code](https://agent.minimax.io/docs/cli/quick-start) CLI (`mcode`,
npm package `@minimax-ai/code`).

It wraps the real `mcode` binary instead of bundling its own copy of the agent,
so every call inherits your MiniMax login, models and `~/.minimax` config.

This is **not** the MiniMax M3 API provider in Pi, and **not** `mmx-cli`.

Sibling of [pi-cli-mcp](https://www.npmjs.com/package/pi-cli-mcp),
[qwen-cli-mcp](https://www.npmjs.com/package/qwen-cli-mcp),
[kimi-cli-mcp](https://www.npmjs.com/package/kimi-cli-mcp) and
[grok-code-mcp](https://www.npmjs.com/package/grok-code-mcp) — same architecture,
same principles, MiniMax Code behind the wheel. Design: [SPEC.md](SPEC.md).
Behaviour: [CHANGELOG.md](CHANGELOG.md).

Verified against MiniMax Code **0.5.9**.

## Install

```bash
npx -y mcode-mcp         # no install
npm install -g mcode-mcp # or global
```

Requires Node ≥ 22 and MiniMax Code installed with its own installer.

The installer keeps MiniMax Code in `~/.minimax-code` (or `$MCODE_INSTALL_DIR`)
and exposes a launcher, `<prefix>/bin/mcode`, that follows the current release
and pins a Node matching MiniMax Code's native SQLite ABI. The adapter finds and
spawns that launcher by itself; there is nothing to configure.

Resolution order: `MCODE_MCP_BIN` → `<prefix>/bin/mcode` → `mcode` on `PATH`.
Set `MCODE_MCP_BIN` only to use a different `mcode`. Never point it into
`<prefix>/releases/<version>/…`: that path changes on every self-update.

### Claude Code

```bash
claude mcp add-json mcode -s user '{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "mcode-mcp"],
  "timeout": 3600000
}'
```

### Any other MCP client

```json
{
  "mcpServers": {
    "mcode": { "command": "npx", "args": ["-y", "mcode-mcp"] }
  }
}
```

Keep the server name short (`mcode`): it becomes part of the tool names your
model sees.

## Tools

| Tool | Purpose |
|---|---|
| `mcode` | Start a session. Returns `[session: <id>]`, `[session-key: mcode:<id>]`, the result, and stats. |
| `mcode_<profile>`, `mcode_<profile>_reply`, … | The same tools, pinned to a named account. One set per profile, so several accounts are live at once. |
| `mcode_reply` | Continue a finished or interrupted session — including one killed by a timeout. |
| `mcode_models` | List the models this installation can actually run, from the session catalog. |
| `mcode_context` | Read a session's context window, budget and per-component breakdown. |
| `mcode_send` | Deliver into a turn executing right now (`abort` / `steer`). ACP only. |
| `mcode_running` | List turns executing right now that `mcode_send` can reach. |
| `mcode_sessions` | List known sessions started through this server, newest first. |
| `mcode_history` | Read-only native transcript (`messages.jsonl`). Does not prompt the agent. |
| `mcode_profiles` | List the auth profiles on this machine and which one is the default. |

### `mcode`

| Argument | Notes |
|---|---|
| `prompt` | Required. Must be self-contained — mcode cannot see your conversation. |
| `cwd` | Absolute path; defaults to this server's cwd. Passed as `--cwd` / ACP `cwd`. |
| `model` | `provider/model`, optionally `provider/model#variant`. On ACP the value is resolved against the session catalog automatically. |
| `permission` | `smart` \| `full` \| `off`. Exec `--permission`. ACP maps `smart`→`auto`, `full`→`bypassPermissions`. `off` is exec-only. Server default is `full`. |
| `mode` | ACP-only session mode: `default` \| `plan`. |
| `thinking_effort` | ACP-only `session/set_config_option` id=`thinkingEffort`. Values are model-dependent. |
| `context_window` | Context window in tokens (M3 / M3.1 advertise `512000` and `1000000`; the latter is marked `higher_usage`). See the note below. |
| `transport` | `acp` (default) or `print`. Usually omit. |
| `timeout_ms` | Wall clock for this run. Off unless you set it. Print also forwards `--timeout <N>ms`. |

### Profiles

**The account is the tool's name, not an argument.** There is no `profile`
parameter. For a profile called `work` you get `mcode_work`, `mcode_work_reply`,
`mcode_work_models`, `mcode_work_context` and `mcode_work_history`; the untargeted
`mcode` and friends stay on whatever the launch parameter selected.

```js
mcode_work({ prompt: "…" })        // this task runs on the `work` account
mcode_personal({ prompt: "…" })    // and this one on `personal`, at the same time
```

That is what lets several accounts be live in one agent at once: they are separate
tools, so a model chooses the account by choosing what to call, and the choice
survives being retried, forwarded, or read back out of a transcript. An argument
cannot do that — one tool is one account per call, and every call site has to carry
the choice.

**You will not see any of it unless a profile is in play.** The per-profile tools
and `mcode_profiles` appear only when the server has been pointed at a profile
(`MCODE_MCP_PROFILE` / `MINIMAX_PROFILE`) or one exists on disk. On a machine with
neither — which includes everyone on a MiniMax Code that has never heard of a
profile — the tool list and every argument schema are exactly what they were in
0.2.0, so there is nothing new to be puzzled by. Signing a profile in makes the
tools appear without restarting the server.

Asking for an account that does not exist is an unknown tool, not a run: a name
only resolves to a real profile, so there is no path from a typo to a directory.

A profile is a separate MiniMax account with its own data directory —
`~/.minimax` for the default one, `~/.minimax-<name>` for a named one — holding
its own credentials, sessions and settings. It is mcode's own feature; this
server passes it through with the same `--profile <name>` flag and resolves its
own paths with the same arithmetic, so a run and the transcript read back
afterwards can never disagree about which account they belong to.

```js
mcode_profiles()                       // what exists, and what is signed in
mcode({ prompt: "…", profile: "work" }) // a task on the `work` account
```

Names must be 1–64 letters, numbers, dots, underscores or hyphens, starting and
ending with a letter or number — a name becomes a directory segment under your
home, so `../../etc` is refused rather than sanitised. Because the name is spliced
into a tool name, a profile containing `_` is read back by the longest match first,
so `work_2` and `work` can both exist.

**The server's default** is `MCODE_MCP_PROFILE`, falling back to mcode's own
`MINIMAX_PROFILE` if that is set and ours is not. A malformed value makes the
server refuse to start instead of quietly falling back to the default account —
running every task on the wrong account is worse than not running. The chosen
profile is pinned into the environment of every mcode this server spawns, so an
inherited `MINIMAX_PROFILE` can never send a run to an account other than the one
this server reads from.

Two things to know before using one:

- **A profile must have credentials first.** Signing in is interactive and has no
  headless equivalent, so do it in a terminal with `mcode login --profile <name>`
  (or give it a Token Plan key with `mcode provider set-minimax-key --profile
  <name>`). Until then `mcode_profiles` reports `signed out` or `not created`, and
  a run against it cannot authenticate.
- **`MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` outranks the profile**, exactly as it
  does in mcode: with either set, every profile resolves to that one directory
  and they stop being separate accounts. `mcode_profiles` says so when it detects
  this. `MCODE_MCP_MINIMAX_CONFIG` is likewise a single path with no profile
  indirection, and combining it with a named profile is refused: the run would
  read the profile's own `config.yaml`, so the edit would succeed and the context
  window would not move.

An answer from a non-default profile carries `[profile: <name>]` in its prefix.

A session keeps the profile it started under, and **it cannot be changed by a
reply** — a session id only names a conversation inside one account, so
`mcode_reply` refuses a different `profile` rather than asking another account to
load an id it never issued. `mcode_history` and `mcode_context` may read a session
from another account, since those are reads; `mcode_history` reports the profile
it read, and a cursor issued for one profile is refused in another, because a byte
offset means nothing across accounts. Note that a `context_window` edit is a real
write to that profile's `config.yaml`.

A profile name that has no directory is refused before anything starts, rather
than letting mcode create an empty account for it.

### `context_window`

mcode exposes no flag and no ACP config option for the context window: the only
way to reach it is the `minimaxModelContextLimits` entry in your own
`~/.minimax/config.yaml`.

**It works on `print` and is refused on `acp`.** On `print` this server writes a
private copy of the config and passes `--config`, and the window verifiably
takes effect. On `acp` it does not: MiniMax Code builds a session selection from
the advertised model value, and that selection carries a provider, model and
variant but no context limit, so the turn falls back to the window in your
config however this server writes that file. Measured on 0.5.8 — asking for
512000 with an explicit model, the session still reported 1,000,000. Since
`mcode acp` has no `--config`, and the config path cannot be redirected without
also moving the data directory, there is no way to make it work on that
transport. Asking for it there is an error that says so, and nothing is written.

Set `MCODE_MCP_ALLOW_ACP_CONTEXT_WINDOW=1` to edit the shared entry anyway: the
server holds it for the whole run under a cross-process lock — which is judged
stale by whether its owner process is alive, never by age — and rolls it back
compare-and-swap, so a change by the TUI or by you wins, another instance's start
will not disturb a run in flight, and a crash is repaired on the next start.
Until [minimax-code#384](https://github.com/MiniMax-AI/minimax-code/issues/384)
lands it will have no effect.

mcode silently ignores a window the model does not advertise, so confirm the
result with `mcode_context`. Only processes this call starts are affected, and a
session that already exists keeps the window it was created with.

**Not supported (honest error, not a fake flag):** `follow_up` on `mcode_send`,
`effort`, `allowed_tools`, `system_prompt_append`, `permission=ask`.

```js
mcode({
  prompt: "Read and execute the prompt: /abs/path/prompt.md",
  cwd: "/abs/path/to/repo",
  model: "minimax/MiniMax-M3.1-Flash-Preview"
})

// later:
mcode_reply({
  session: "<id from the prefix>",
  prompt: "Now check the error paths of those call sites."
})
```

> **Default permission is `full`.** Delegation is only useful when the delegate
> can act. Headless `smart` can stop with `INTERACTION_NOT_AVAILABLE` if Runtime
> asks a question. ACP `session/cancel` is how a running turn is aborted; there
> is no documented mid-turn follow-up queue, so `mcode_send` `follow_up` errors
> instead of pretending to queue.

## What comes back

Only mcode's final result plus aggregate stats — never the transcript, thinking,
tool arguments or raw stdout.

A timed-out or cancelled run still returns `[session: <id>]` and
`[session-key: mcode:<id>]` when mcode named the session. Resume it with
`mcode_reply`; do not treat the deadline as a lost session.

### `mcode_history`

Read-only snapshot of the native transcript. Does not prompt mcode.

```js
mcode_history({ session: "<id from the prefix>" })
```

Source: `<dataDir>/v2/sessions/YYYY/MM/DD/<time>-session_<base64(id)>/messages.jsonl`, where
`<dataDir>` is `MINIMAX_DATA_DIR`, then `MAVIS_DATA_DIR`, then `~/.minimax[-<profile>]`
for the session's own profile. The page reports the profile it read.
Items are `user` / `assistant` / `tool` / `gap`. Thinking and image binaries are
omitted. Pass `cursor` from the previous page to continue; `include_tools: false`
hides tool calls/results but still advances the cursor.

## Source

```bash
git clone https://github.com/minmax/mcode-mcp.git
cd mcode-mcp
npm ci
npm test
```

### Releasing

Releases are published by the `Publish npm package` workflow when a `v*` tag is
pushed. It authenticates through npm trusted publishing (GitHub OIDC), so there
is no `NPM_TOKEN` secret. The tag must equal `v<version>` from `package.json`.

```bash
npm version patch   # bumps package.json and creates the vX.Y.Z tag
git push --follow-tags
```
