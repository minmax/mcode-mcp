# mcode-mcp

Provisional **local** MCP server that delegates coding tasks to your **locally
installed** [MiniMax Code](https://agent.minimax.io/docs/cli/quick-start) CLI
(`mcode`, npm package `@minimax-ai/code`).

It wraps the real `mcode` binary instead of bundling its own copy of the agent,
so every call inherits your MiniMax login, models and `~/.minimax` config.

Local **0.1.0** (git tag `v0.1.0`). `package.json` is `"private": true`. Not on
npm / GitHub. Do not publish unless a later task authorises it. Behaviour
notes: [CHANGELOG.md](CHANGELOG.md). Design: [SPEC.md](SPEC.md).

This is **not** the MiniMax M3 API provider in Pi, and **not** `mmx-cli`.

Sibling architecture of `kimi-cli-mcp` / `grok-cli-mcp` / `pi-cli-mcp` /
`qwen-cli-mcp` — same principles, MiniMax Code behind the wheel.

Verified against MiniMax Code **0.3.11**.

## Requirements

- Node ≥ 22 to run **this** server.
- A working `mcode` on `PATH`. MiniMax Code itself requires Node `>=22.19 <23`
  or `>=24 <27`, and its native SQLite module must match that Node ABI.
- On this machine the Homebrew `mcode` shim uses `env node`. If `PATH` still
  has Node 22.16, `mcode` will refuse to start. Point the adapter at a matching
  runtime without changing global config:

```bash
export MCODE_MCP_BIN=/opt/homebrew/lib/node_modules/@minimax-ai/code/cli.js
export MCODE_MCP_WRAP=/path/to/node-22.22+/bin/node
```

`MCODE_MCP_WRAP` is a command prefix (no shell interpolation). The process is
spawned as `node cli.js <args…>`.

## Tools

| Tool | Purpose |
|---|---|
| `mcode` | Start a session. Returns `[session: <id>]`, `[session-key: mcode:<id>]`, the result, and stats. |
| `mcode_reply` | Continue a finished or interrupted session — including one killed by a timeout. |
| `mcode_models` | List what `mcode provider list --json` reports. |
| `mcode_send` | Deliver into a turn executing right now (`abort` / `steer`). ACP only. |
| `mcode_running` | List turns executing right now that `mcode_send` can reach. |
| `mcode_sessions` | List known sessions started through this server, newest first. |
| `mcode_history` | Read-only native transcript (`messages.jsonl`). Does not prompt the agent. |

### `mcode`

| Argument | Notes |
|---|---|
| `prompt` | Required. Must be self-contained — mcode cannot see your conversation. |
| `cwd` | Absolute path; defaults to this server's cwd. Passed as `--cwd` / ACP `cwd`. |
| `model` | `--model provider/model` / ACP `session/set_config_option` id=`model`. |
| `permission` | `smart` \| `full` \| `off`. Exec `--permission`. ACP maps `smart`→`auto`, `full`→`bypassPermissions`. `off` is exec-only. Server default is `full`. |
| `mode` | ACP-only session mode: `default` \| `plan`. |
| `thinking_effort` | ACP-only `session/set_config_option` id=`thinkingEffort`. Values are model-dependent. |
| `transport` | `acp` (default) or `print`. Usually omit. |
| `timeout_ms` | Wall clock for this run. Off unless you set it. Print also forwards `--timeout <N>ms`. |

**Not supported (honest error, not a fake flag):** `follow_up` on `mcode_send`,
`effort`, `allowed_tools`, `system_prompt_append`, `permission=ask`.

```js
mcode({
  prompt: "Read and execute the prompt: /abs/path/prompt.md",
  cwd: "/abs/path/to/repo",
  model: "minimax_oauth/MiniMax-M2.5"
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

## Local build

```bash
cd /Users/pavel.karataev/ai/mcode-mcp
npm install
npm test
npm run build
```

Point an MCP client at `dist/index.js`. This package is not on npm; do not
`npm publish`. Codex on this machine is already wired to that path with
`MCODE_MCP_BIN` / `MCODE_MCP_WRAP` as above.
