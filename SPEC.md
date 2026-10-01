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

`mcode`, `mcode_reply`, `mcode_models`, `mcode_context`, `mcode_send`, `mcode_running`, `mcode_sessions`, `mcode_history`, `mcode_profiles`.

Answers keep `[session: <id>]` and also `[session-key: mcode:<id>]`. The last transport is remembered so `mcode_reply` without an explicit `transport` resumes on the same wire, and `mcode_send` / `mcode_running` do not blame print after an ACP turn.

Unsupported (honest error): `follow_up`, `effort`, `allowed_tools`, `system_prompt_append`, `permission=ask`, `mode`/`thinking_effort` on print, `permission=off` on ACP.

`mcode_history` reads native `messages.jsonl` at `<dataDir>/v2/sessions/YYYY/MM/DD/<time>-session_<b64(id)>/messages.jsonl` (MINIMAX_DATA_DIR / MAVIS_DATA_DIR / `~/.minimax[-<profile>]`). Thinking and image binaries are omitted.

## 6. Auth profiles

A profile is mcode's own isolation unit: `~/.minimax` for the implicit default and `~/.minimax-<name>` for a named one, each with its own credentials, sessions and settings. The wire is mcode's `--profile <name>` on every command; `MINIMAX_PROFILE` is its public selector. **Requires a MiniMax Code that has them (0.6.0-era) — the rest of this document is verified against 0.3.11/0.5.9.** Naming a profile on a build without it fails with mcode's own unknown-option error, and the default path is untouched.

Three rules this adapter adds, because it *reads* the data directory and not only writes to it:

1. **One resolution, used for both.** The account a run uses and the store it is read back from are resolved by the same function, with mcode's own precedence — an explicit `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` outranks the profile. A guess that disagreed with mcode would be a silent wrong-account read.
2. **The profile is pinned into the child environment**, so an inherited `MINIMAX_PROFILE` cannot be a second, disagreeing source of truth for a server that passed `process.env` through. A relative `MINIMAX_DATA_DIR` is pinned to its absolute form for the same reason.
3. **A session is pinned to the account it was created in.** `mcode_reply` may not change it — a session id only names a conversation inside one account — while `mcode_history` and `mcode_context` may read across accounts, because those are reads.

Names are validated, never repaired: 1–64 chars, alphanumeric at both ends, and a separator would redirect the credential store out of the user's home. `default` is the implicit profile, not an ordinary name.

Server default: `MCODE_MCP_PROFILE`, then `MINIMAX_PROFILE`. A malformed value stops startup — falling back would bill the wrong account.

### Advertising

`mcode_profiles` and the `profile` argument are advertised only when a profile can
change what a call does: the server is pointed at one, or one exists on disk.
Otherwise the tool list and every schema are byte-for-byte what they were before
this feature, which is the point — a caller on a MiniMax Code without profile
support meets nothing new and no argument that can only fail. Recomputed per
`tools/list`, so signing a profile in while the server runs makes it appear.

Advertising is not permission. A `profile` argument that arrives regardless of the
schema is resolved and obeyed.

### The one place this adapter does not just pass mcode through

`mcode_profiles` lists profiles by walking the home directory rather than by running `mcode profile list --json`. The CLI command costs a cold start per call and exists only on a build that has profiles, and the server has to work against one that does not. The cost is that the credential layout it inspects — `auth/**/auth.json` for OAuth, an `apiKey:` line in `config.yaml` for a Token Plan key, `auth-state.json` for a sign-in in flight — is a copy of an implementation detail. Both credential kinds are reported, because calling an API-key profile "signed out" would send the agent away from a working account. A directory is only listed when it actually holds data, which is what keeps the installer prefix `~/.minimax-code` from being offered as a profile named `code`.
