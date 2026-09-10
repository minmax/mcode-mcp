# Changelog

What changed in behaviour, in the order it shipped. Dates are publish dates from the registry.

## Unreleased

## 0.1.0 — 2026-09-10

First public release. Adapter over installed MiniMax Code CLI (`mcode` / `@minimax-ai/code` 0.3.11). Not MiniMax M3 in Pi, not `mmx-cli`.

- **ACP is the default transport.** `mcode acp` unless the call (or `MCODE_MCP_TRANSPORT`) asks for `print` (`mcode exec --output-format stream-json`). A running ACP turn can be `abort`/`steer` via `session/cancel`; print has no mid-run channel.
- **`follow_up` is an honest error.** MiniMax Code ACP does not document a mid-turn queue. Use `abort`/`steer` on a live ACP turn, or `mcode_reply` after it finishes.
- **A killed run is resumable.** Timeout, cancel and non-zero exit still return `[session: <id>]`. Resume with `mcode_reply`. There is no server-wide default deadline.
- **Every answer names the run.** `[session: <id>]` and `[session-key: mcode:<id>]`. With a `progressToken`, the server also sends `mcode started · mcode:<id> · cwd=…` when the session id is known.
- **Last transport is remembered.** `mcode_reply` without `transport` resumes on the same wire. `mcode_send` / `mcode_running` do not blame print after an ACP turn; print is mentioned only when that session last ran as print.
- **`mcode_history` reads a session without prompting it.** Native `messages.jsonl` at `<dataDir>/v2/sessions/YYYY/MM/DD/<time>-session_<b64(id)>/messages.jsonl` (`MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` / `~/.minimax`). User / assistant / tool; thinking and image binaries omitted. Opaque byte-offset cursor. Does not take the session lock. `state` is `active` only while this process has the ACP turn; otherwise `unknown`.
- **`mcode_sessions` lists recovery rows** including remembered transport and the transcript path when the jsonl exists.
- Tools: `mcode`, `mcode_reply`, `mcode_models`, `mcode_send`, `mcode_running`, `mcode_sessions`, `mcode_history`. Each declares MCP annotations.
- Unsupported (error, not a fake flag): `follow_up`, `effort`, `allowed_tools`, `system_prompt_append`, `permission=ask`, `permission=off` on ACP, `mode`/`thinking_effort` on print.
