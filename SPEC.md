# mcode-mcp — Specification

MCP server that delegates coding tasks to a **locally installed**
[MiniMax Code](https://agent.minimax.io/docs/cli/quick-start) CLI (`mcode`, npm
`@minimax-ai/code`). Sibling of `kimi-cli-mcp` / `grok-cli-mcp` / `pi-cli-mcp` /
`qwen-cli-mcp`: same architecture, same principles, different agent.

Status: **0.1.0**. Behaviour: [CHANGELOG.md](CHANGELOG.md).

Verified against installed `@minimax-ai/code` **0.3.11** at
`/opt/homebrew/lib/node_modules/@minimax-ai/code` (`mcode` → `cli.js`), official
docs (`agent.minimax.io/docs/cli/{automation,integrations,reference}.md`), and
the shipped `run-exec-command` / `run-acp-command` chunks.

This is **not** the MiniMax M3 API provider in Pi, and **not** `mmx-cli`.

---

## 1. Identity

| | |
|---|---|
| package | `mcode-mcp` 0.1.0 |
| bin | `mcode-mcp` |
| MCP server name | `mcode` |
| Tool prefix | `mcode_` |
| License | MIT |
| Node | ≥ 22 (MiniMax Code itself requires Node `>=22.19 <23 \|\| >=24 <27`) |

## 2. Source material

**Architecture (port):** `kimi-cli-mcp` (ACP sibling).

**M-Code wire contract (installed 0.3.11):**
- Headless: `mcode exec --output-format stream-json --cwd DIR [--model provider/model] [--session ID] [--permission smart|full|off] [--timeout <duration>] -- <prompt>`
- Resume: `mcode exec --session <id>` (not `--continue`; that is “latest in cwd”).
- ACP: `mcode acp` — Agent Client Protocol over stdio. `initialize` uses integer
  `protocolVersion` 1. Advertised: `loadSession: true`, `sessionCapabilities` list/fork/resume/close.
- Session modes (`session/set_mode`): `default` \| `plan`.
- Config options (`session/set_config_option`): `permissionMode` (`default` \| `auto` \| `bypassPermissions`), `model`, `thinkingEffort` (model-dependent).
- Models catalog: `mcode provider list --json`.
- ExecResult: `{ schemaVersion: 1, type: "exec.result", runId, sessionId, turnId, status, output?, error?, model?, usage?, durationMs }`.
  `status`: `succeeded` \| `failed` \| `timeout` \| `cancelled` \| `limit_exceeded`.
- stream-json events: `exec.started`, `session.started`/`session.resumed`, `turn.*`, `item.*`, `exec.completed` (carries `result`).
- ACP stopReason: `end_turn` \| `max_tokens` \| `max_turn_requests` \| `refusal` \| `cancelled`.
- Mid-run: ACP `session/cancel` is documented. `steer` is cancel then a new `session/prompt`. There is no documented ACP mid-turn queue, so `follow_up` is an honest error.
- Headless `--permission ask` is rejected by the CLI (needs TUI/ACP).
- Exec `--permission` maps internally: `smart`→`auto`, `full`→`bypassPermissions`, `off`→`off`.

## 3. House rules

1. **This is an adapter.** It carries mcode's capabilities across MCP and adds none of its own. Unsupported operations are documented errors, not fakes.
2. **Zero runtime dependencies.** NDJSON JSON-RPC 2.0 is spoken directly.
3. **Fail closed on anything from mcode.** Unknown ExecResult status, unknown ACP stopReason, missing session ids, unparseable lines — report them.
4. **The answer is the contract.** Return mcode's final result text plus aggregate stats. Never the transcript, tool arguments, or raw stdout.
5. **No process outlives its request.** A timeout is not a lost session: remember the id and resume with `mcode_reply`.
6. **Tests drive the real server.** The fake is mcode, never our own code.

## 4. Transports

| Mode | Command | Mid-run |
|---|---|---|
| `acp` (default) | `mcode acp` then ACP `initialize` / `session/new\|load` / `session/set_mode` / `session/set_config_option` / `session/prompt` | `mcode_send` via `session/cancel` (`abort` / `steer`) |
| `print` | `mcode exec --output-format stream-json … -- <prompt>` | no |

## 5. Tools

`mcode`, `mcode_reply`, `mcode_models`, `mcode_send`, `mcode_running`, `mcode_sessions`, `mcode_history`.

Answers keep `[session: <id>]` and also `[session-key: mcode:<id>]`. The last transport is remembered so `mcode_reply` without an explicit `transport` resumes on the same wire, and `mcode_send` / `mcode_running` do not blame print after an ACP turn.

Unsupported (honest error): `follow_up`, `effort`, `allowed_tools`, `system_prompt_append`, `permission=ask`, `mode`/`thinking_effort` on print, `permission=off` on ACP.

`mcode_history` reads native `messages.jsonl` at `<dataDir>/v2/sessions/YYYY/MM/DD/<time>-session_<b64(id)>/messages.jsonl` (MINIMAX_DATA_DIR / MAVIS_DATA_DIR / `~/.minimax`). Thinking and image binaries are omitted.
