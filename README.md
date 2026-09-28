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

Verified against MiniMax Code **0.5.8**.

## Install

```bash
npx -y mcode-mcp         # no install
npm install -g mcode-mcp # or global
```

Requires Node ≥ 22 and a working `mcode` on `PATH` (`npm i -g @minimax-ai/code`).
MiniMax Code itself needs Node `>=22.19 <23` or `>=24 <27`, and its native
SQLite module must match that Node ABI. If `mcode` refuses to start, point the
adapter at the CLI and a matching Node without changing global PATH:

```bash
export MCODE_MCP_BIN=/path/to/@minimax-ai/code/cli.js
export MCODE_MCP_WRAP=/path/to/node
```

`MCODE_MCP_WRAP` is a command prefix (no shell interpolation). The process is
spawned as `node cli.js <args…>`.

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
| `mcode_reply` | Continue a finished or interrupted session — including one killed by a timeout. |
| `mcode_models` | List the models this installation can actually run, from the session catalog. |
| `mcode_context` | Read a session's context window, budget and per-component breakdown. |
| `mcode_send` | Deliver into a turn executing right now (`abort` / `steer`). ACP only. |
| `mcode_running` | List turns executing right now that `mcode_send` can reach. |
| `mcode_sessions` | List known sessions started through this server, newest first. |
| `mcode_history` | Read-only native transcript (`messages.jsonl`). Does not prompt the agent. |

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

Source: `<MINIMAX_DATA_DIR|~/.minimax>/v2/sessions/YYYY/MM/DD/<time>-session_<base64(id)>/messages.jsonl`.
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
