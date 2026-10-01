#!/usr/bin/env node

// A stand-in for the mcode binary. Speaks:
//   - `mcode exec --output-format stream-json` (print / headless)
//   - `mcode acp` ACP JSON-RPC
//   - `mcode provider list --json` configured catalog

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const mode = process.env.FAKE_MODE ?? "answer";
const exitCode = Number(process.env.FAKE_EXIT ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);

if (process.env.FAKE_STARTED_FILE) {
	appendFileSync(process.env.FAKE_STARTED_FILE, `${process.pid}\n`);
}
if (process.env.FAKE_ARGV_LOG) {
	// The environment as the child received it, not as the server wrote it: this is
	// what proves the adapter pinned the profile the child actually runs under.
	appendFileSync(
		process.env.FAKE_ARGV_LOG,
		`${JSON.stringify({ argv, profileEnv: process.env.MINIMAX_PROFILE ?? null, dataDir: fakeDataDir() })}\n`,
	);
}

function argValue(flag) {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

// A model catalog shaped like the one MiniMax Code advertises over ACP. The
// values are opaque `m:<provider>:<model>:u|v:<variant>` strings, and
// session/set_config_option rejects anything that is not one of them — which is
// exactly what real mcode does, and what the adapter has to get right.
const FAKE_MODEL = process.env.FAKE_MODEL_ID ?? "FakeModel-Fast";
const FAKE_MODEL_ALT = "FakeModel-Pro";
const FAKE_BASE_CONTEXT = Number(process.env.FAKE_BASE_CONTEXT ?? 512_000);

function fakeConfigOptions() {
	if (mode === "no_models") {
		return [
			{ id: "permissionMode", type: "select", currentValue: "bypassPermissions", options: [] },
			{ id: "model", type: "select", currentValue: undefined, options: [] },
		];
	}
	return [
		{
			id: "permissionMode",
			type: "select",
			name: "Permission mode",
			currentValue: "bypassPermissions",
			options: [
				{ value: "default", name: "Ask" },
				{ value: "auto", name: "Auto" },
				{ value: "bypassPermissions", name: "Full access" },
			],
		},
		{
			id: "model",
			type: "select",
			name: "Model",
			currentValue: `m:minimax:${FAKE_MODEL}:v:thinking`,
			// Mirrors 0.5.8: a model with a non-empty supportedVariants list is
			// advertised only as `:v:<variant>`, never with the bare `:u` form.
			options: [
				{ value: `m:minimax:${FAKE_MODEL}:v:thinking`, name: `${FAKE_MODEL} · thinking` },
				{ value: `m:minimax:${FAKE_MODEL_ALT}:v:thinking`, name: `${FAKE_MODEL_ALT} · thinking` },
			],
		},
		{
			id: "thinkingEffort",
			type: "select",
			name: "Thinking effort",
			currentValue: "xhigh",
			options: [
				{ value: "default", name: "Default" },
				{ value: "low", name: "Low" },
				{ value: "medium", name: "Medium" },
				{ value: "high", name: "High" },
				{ value: "xhigh", name: "Xhigh" },
				{ value: "max", name: "Max" },
			],
		},
	];
}

// Mirror how MiniMax Code resolves the context window for a model: the
// per-model override if the config carries one, otherwise the model's base.
// The windows this model advertises. Real mcode applies an override only when
// the value is in `contextWindowOptions`, and otherwise falls back to the
// model's base context — so a fixture that accepted any integer would let a
// silently-ignored value look like it worked.
const FAKE_CONTEXT_OPTIONS = (process.env.FAKE_CONTEXT_OPTIONS ?? "512000,1000000")
	.split(",")
	.map((v) => Number(v.trim()))
	.filter((v) => Number.isSafeInteger(v) && v > 0);

function effectiveContextWindow() {
	// `--config` is mcode's per-process runtime config and outranks everything,
	// which is exactly what makes transport 'print' the path that works.
	const fromFlag = argValue("--config");
	const path = fromFlag && existsSync(fromFlag) ? fromFlag : fakeConfigPath();
	if (path === undefined) return FAKE_BASE_CONTEXT;
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return FAKE_BASE_CONTEXT;
	}
	const lines = text.split(/\r?\n/);
	const start = lines.findIndex((line) => /^minimaxModelContextLimits:\s*$/.test(line));
	if (start !== -1) {
		for (let i = start + 1; i < lines.length; i += 1) {
			const line = lines[i];
			if (/^\S/.test(line)) break;
			const match = /^\s+([^:#]+):\s*(\d+)\s*$/.exec(line);
			if (match === null) continue;
			if (match[1].replace(/^['"]|['"]$/g, "") !== FAKE_MODEL) continue;
			const value = Number(match[2]);
			// Out of the advertised set: ignored, as in 0.5.8.
			return FAKE_CONTEXT_OPTIONS.includes(value) ? value : FAKE_BASE_CONTEXT;
		}
	}
	// `defaultModelContextWindow` is what a session falls back to when the
	// selection carries no context limit — which is every ACP selection.
	const def = /^defaultModelContextWindow:\s*(\d+)\s*$/m.exec(text);
	if (def !== null) {
		const value = Number(def[1]);
		if (FAKE_CONTEXT_OPTIONS.includes(value)) return value;
	}
	return FAKE_BASE_CONTEXT;
}

// mcode's own order: an explicit data dir outranks the profile, and the profile
// only decides the default directory name. `MINIMAX_PROFILE` is read as well as
// `--profile` because the adapter pins both and a test needs to see the variable
// reach the child.
function fakeDataDir() {
	const dataDir = process.env.MINIMAX_DATA_DIR ?? process.env.MAVIS_DATA_DIR;
	if (dataDir) return dataDir;
	const profile = argValue("--profile") ?? process.env.MINIMAX_PROFILE;
	return join(homedir(), profile ? `.minimax-${profile}` : ".minimax");
}

function fakeConfigPath() {
	const explicit = process.env.MCODE_MCP_MINIMAX_CONFIG;
	if (explicit) return existsSync(explicit) ? explicit : undefined;
	const candidate = join(fakeDataDir(), "config.yaml");
	return existsSync(candidate) ? candidate : undefined;
}

const mintSession = () => process.env.FAKE_SESSION_ID ?? `session_${randomUUID()}`;

// A real session keeps its context snapshot across processes: /context works
// from a later `mcode acp` that only did session/load. This fixture is spawned
// per call, so "has this session run a turn" has to live on disk.
const ranMarker = (id) => {
	const state = process.env.MCODE_MCP_STATE;
	if (!state) return null;
	return join(state.replace(/\/[^/]*$/, ""), `.fake-ran-${String(id).replace(/[^\w-]/g, "_")}`);
};
const markExecSessionRan = (id, window) => {
	const marker = ranMarker(id);
	// The window is recorded with the session, the way a real one does: a later
	// /context must report what the run actually had, not what the config says
	// now. Recomputing it per read would make every "did the patch take effect"
	// question unanswerable.
	if (marker !== null) writeFileSync(marker, String(window ?? ""));
};
const sessionHasRun = (id) => {
	const marker = ranMarker(id);
	return marker !== null && existsSync(marker);
};
const sessionWindow = (id, fallback) => {
	const marker = ranMarker(id);
	if (marker === null) return fallback;
	try {
		const value = Number(readFileSync(marker, "utf8").trim());
		return Number.isSafeInteger(value) && value > 0 ? value : fallback;
	} catch {
		return fallback;
	}
};
const sessionFromArgv = () => argValue("--session") ?? mintSession();

function spawnMarkedChild() {
	const tag = process.env.FAKE_CHILD_TAG ?? "mcode-mcp-child";
	const child = spawn("sh", ["-c", `sleep 120; true # ${tag}`], { stdio: "ignore" });
	child.unref();
}

function emitExec(status, output, extra = {}) {
	const id = sessionFromArgv();
	// A headless run produces a real session with a real context snapshot, so a
	// later mcode_context can read it — mark it the same way ACP does.
	markExecSessionRan(id, effectiveContextWindow());
	const runId = "run_fake";
	const turnId = "turn_fake";
	const base = { schemaVersion: 1, runId, sessionId: id, turnId, timestampMs: Date.now() };
	out({ ...base, sequence: 1, type: extra.resumed ? "session.resumed" : "session.started" });
	if (extra.tool) {
		out({
			...base,
			sequence: 2,
			type: "item.completed",
			item: { id: "t1", type: "tool_call", toolCall: { toolName: "Write", rawInput: { path: "note.md" } } },
		});
	}
	if (output) {
		out({
			...base,
			sequence: 3,
			type: "item.completed",
			item: { id: "m1", type: "agent_message", content: output },
		});
	}
	const result = {
		schemaVersion: 1,
		type: "exec.result",
		runId,
		sessionId: id,
		turnId,
		status,
		durationMs: 12,
		model: { providerId: "minimax_oauth", modelId: "MiniMax-M2.5" },
		usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
		...(status === "succeeded" ? { output } : { error: { message: extra.error ?? `status ${status}` } }),
	};
	out({ ...base, sequence: 4, type: "exec.completed", result });
}

async function playExec() {
	const resumed = argv.includes("--session");
	switch (mode) {
		case "error_exec":
			emitExec("failed", "PARTIAL: 43 tests pass, now showing the failure", {
				resumed,
				tool: true,
				error: "runtime failed",
			});
			process.exitCode = exitCode || 4;
			return "done";
		case "max_turns":
			emitExec("limit_exceeded", "PARTIAL: half the refactor is done", { resumed, tool: true });
			process.exitCode = exitCode || 7;
			return "done";
		case "unknown_result":
			emitExec("exploded", "mystery", { resumed });
			return "done";
		case "no_result": {
			const id = sessionFromArgv();
			out({
				schemaVersion: 1,
				sequence: 1,
				type: "session.started",
				sessionId: id,
				runId: "run_fake",
				turnId: "turn_fake",
			});
			return "done";
		}
		case "no_newline": {
			const id = sessionFromArgv();
			process.stdout.write(
				JSON.stringify({
					schemaVersion: 1,
					type: "exec.result",
					runId: "run_fake",
					sessionId: id,
					turnId: "turn_fake",
					status: "succeeded",
					output: "EOF TERMINATED ANSWER",
					durationMs: 1,
				}),
			);
			return "done";
		}
		case "garbage":
			process.stdout.write("this is not json\nneither is this\n");
			return "done";
		case "noisy_stderr":
			process.stderr.write(
				`${JSON.stringify({ type: "message_start", message: { role: "user", content: "SECRET_PROMPT_BODY" } })}\n`,
			);
			process.stderr.write(
				`${JSON.stringify({ type: "message_start", message: { role: "assistant", content: "SECRET echoed" } })}\n`,
			);
			process.stderr.write(`${JSON.stringify({ type: "message_end" })}\n`);
			process.stderr.write("Error: upstream refused the request\n");
			emitExec("succeeded", "FINAL ANSWER", { resumed, tool: true });
			return "done";
		case "big":
			emitExec("succeeded", "X".repeat(Number(process.env.FAKE_SIZE ?? 200_000)), { resumed });
			return "done";
		case "slow":
			await sleep(Number(process.env.FAKE_DELAY_MS ?? 1500));
			emitExec("succeeded", "SLOW ANSWER", { resumed, tool: true });
			return "done";
		case "hang":
			out({
				schemaVersion: 1,
				sequence: 1,
				type: "session.started",
				sessionId: sessionFromArgv(),
				runId: "run_fake",
				turnId: "turn_fake",
			});
			spawnMarkedChild();
			return "held";
		case "child_then_answer":
			spawnMarkedChild();
			emitExec("succeeded", "ANSWERED WITH CHILD LEFT", { resumed, tool: true });
			return "done";
		case "overlap": {
			const lock = process.env.FAKE_LOCK_FILE;
			const held = Boolean(lock && existsSync(lock));
			if (lock && !held) writeFileSync(lock, String(process.pid));
			await sleep(Number(process.env.FAKE_DELAY_MS ?? 300));
			emitExec("succeeded", held ? "OVERLAP DETECTED" : "EXCLUSIVE", { resumed, tool: true });
			if (lock && !held) unlinkSync(lock);
			return "done";
		}
		default:
			emitExec("succeeded", "FINAL ANSWER", { resumed, tool: true });
			return "done";
	}
}

if (argv[0] === "provider" && argv[1] === "list") {
	if (mode === "models_fail") {
		process.stderr.write("model catalog unavailable\n");
		process.exit(1);
	}
	process.stdout.write(
		`${JSON.stringify(
			{
				minimaxModelSource: "token_plan",
				providers: [
					{
						providerId: "minimax_oauth",
						name: "MiniMax OAuth",
						kind: "minimax-oauth",
						active: true,
						models: [{ modelId: "MiniMax-M2.5", selected: true }],
					},
					{
						providerId: "custom",
						name: "Custom",
						kind: "custom",
						active: false,
						models: [{ modelId: "fake-coder-max" }, { modelId: "fake-model-1" }],
					},
				],
			},
			null,
			2,
		)}\n`,
	);
	process.exit(0);
}

if (argv[0] === "acp") {
	await runAcp();
} else if (argv[0] === "exec") {
	const outcome = await playExec();
	if (outcome === "held") {
		setInterval(() => {}, 1000);
	} else {
		process.exitCode = process.exitCode ?? exitCode;
	}
} else {
	process.stderr.write("fake mcode: unknown invocation\n");
	process.exit(2);
}

function fakeModelValues() {
	return fakeConfigOptions()
		.find((option) => option.id === "model")
		.options.map((option) => option.value);
}

// The budget report mirrors the shape of mcode's own /context output, including
// a window taken from the config, so a test can prove a context_window override
// actually reached the process.
function fakeContextReport(modelValue, sessionId) {
	const window = sessionHasRun(sessionId)
		? sessionWindow(sessionId, effectiveContextWindow())
		: effectiveContextWindow();
	const used = 22_810;
	const parts = String(modelValue).split(":");
	const modelId = parts[2] ?? FAKE_MODEL;
	return [
		"Context: live",
		`Model: minimax/${modelId}`,
		`Budget: ${used.toLocaleString("en-US")} / ${window.toLocaleString("en-US")} tokens (${Math.round((used / window) * 100)}%)`,
		"Compaction: never",
		"Components:",
		"- System prompt: 4,302 tokens",
		"- Memory: 1,384 tokens",
		"- Tools: 14,023 tokens",
		"- Skills: 2,340 tokens",
		"- Messages: 606 tokens",
		"- Other: 155 tokens",
	].join("\n");
}

async function runAcp() {
	const stdinLog = process.env.FAKE_STDIN_LOG;
	let sid = process.env.FAKE_SESSION_ID ?? mintSession();
	let holding = false;
	let holdInterval;
	let abortTimer;
	let promptId = null;
	let promptCount = 0;
	let currentModel = `m:minimax:${FAKE_MODEL}:v:thinking`;

	// A real session keeps its context snapshot across processes: /context works
	// from a later `mcode acp` that only did session/load. This fixture is
	// spawned per call, so "has this session run a turn" has to live on disk.

	const rpc = (id, result) => out({ jsonrpc: "2.0", id, result });
	const rpcError = (id, message) => out({ jsonrpc: "2.0", id, error: { code: -32000, message } });
	const notify = (method, params) => out({ jsonrpc: "2.0", method, params });

	const emitChunk = (text) => {
		notify("session/update", {
			sessionId: sid,
			update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
		});
	};

	const emitTool = () => {
		notify("session/update", {
			sessionId: sid,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "c1",
				title: "Write",
				kind: "edit",
				status: "completed",
				toolName: "Write",
				rawInput: { path: "note.md", content: "hi" },
			},
		});
	};

	const settlePrompt = (id, text, stopReason = "end_turn") => {
		if (abortTimer) clearTimeout(abortTimer);
		holding = false;
		if (holdInterval) {
			clearInterval(holdInterval);
			holdInterval = undefined;
		}
		if (text) emitChunk(text);
		rpc(id, { stopReason });
		promptId = null;
		setTimeout(() => process.exit(exitCode), 3000).unref();
	};

	const playAcpScenario = async (id) => {
		switch (mode) {
			case "error_exec":
				emitChunk("PARTIAL: 43 tests pass, now showing the failure");
				rpc(id, { stopReason: "refusal" });
				setTimeout(() => process.exit(exitCode), 50).unref();
				return;
			case "max_turns":
				emitChunk("PARTIAL: half the refactor is done");
				rpc(id, { stopReason: "max_turn_requests" });
				setTimeout(() => process.exit(exitCode), 50).unref();
				return;
			case "hang":
				spawnMarkedChild();
				holding = true;
				holdInterval = setInterval(() => {}, 1000);
				return;
			case "slow":
				await sleep(Number(process.env.FAKE_DELAY_MS ?? 1500));
				emitChunk("NARRATION: I'll check that for you.");
				emitTool();
				settlePrompt(id, "SLOW ANSWER");
				return;
			case "wait":
				holding = true;
				holdInterval = setInterval(() => {}, 1000);
				promptId = id;
				return;
			case "overlap": {
				const lock = process.env.FAKE_LOCK_FILE;
				const held = Boolean(lock && existsSync(lock));
				if (lock && !held) writeFileSync(lock, String(process.pid));
				await sleep(Number(process.env.FAKE_DELAY_MS ?? 300));
				settlePrompt(id, held ? "OVERLAP DETECTED" : "EXCLUSIVE");
				if (lock && !held) unlinkSync(lock);
				return;
			}
			case "no_result":
				emitChunk("UNREPORTED WORK DONE");
				setTimeout(() => process.exit(exitCode), 50).unref();
				return;
			case "child_then_answer":
				spawnMarkedChild();
				emitTool();
				settlePrompt(id, "ANSWERED WITH CHILD LEFT");
				return;
			case "unknown_result":
				emitChunk("mystery");
				rpc(id, { stopReason: "exploded" });
				setTimeout(() => process.exit(exitCode), 50).unref();
				return;
			default:
				emitTool();
				settlePrompt(id, "FINAL ANSWER");
		}
	};

	let buffer = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buffer += chunk;
		let newline = buffer.indexOf("\n");
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			newline = buffer.indexOf("\n");
			if (!line) continue;
			void ingest(line);
		}
	});
	process.stdin.on("end", () => {
		if (holding) return;
		process.exitCode = exitCode;
	});

	async function ingest(line) {
		if (stdinLog) appendFileSync(stdinLog, `${line}\n`);
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			return;
		}

		if (msg.method === "initialize") {
			if (process.env.FAKE_INIT_FAIL === "1") rpcError(msg.id, "init refused by fake");
			else rpc(msg.id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
			return;
		}
		if (msg.method === "session/new") {
			sid = process.env.FAKE_SESSION_ID ?? mintSession();
			rpc(msg.id, { sessionId: sid, configOptions: fakeConfigOptions() });
			return;
		}
		if (msg.method === "session/load") {
			sid = msg.params?.sessionId ?? sid;
			rpc(msg.id, { sessionId: sid, configOptions: fakeConfigOptions() });
			return;
		}
		if (msg.method === "session/set_mode") {
			rpc(msg.id, {});
			return;
		}
		if (msg.method === "session/set_config_option") {
			const configId = msg.params?.configId;
			const value = msg.params?.value;
			// A model value must be one the session advertised. Accepting anything
			// here would hide the very bug this fixture exists to catch.
			if (configId === "model" && !fakeModelValues().includes(value)) {
				rpcError(msg.id, `Invalid params: Invalid model config value: ${value}`);
				return;
			}
			if (configId === "model") currentModel = value;
			rpc(msg.id, { configOptions: fakeConfigOptions() });
			return;
		}
		if (msg.method === "session/cancel") {
			if (mode === "wait" && promptId !== null) {
				clearTimeout(abortTimer);
				abortTimer = setTimeout(() => settlePrompt(promptId, "ABORTED AFTER INTERRUPT", "cancelled"), 150);
			}
			return;
		}
		if (msg.method === "session/prompt") {
			promptCount += 1;
			const text = Array.isArray(msg.params?.prompt) ? msg.params.prompt.map((b) => b.text ?? "").join("") : "";
			if (text.trim() === "/context") {
				// mcode only has a snapshot once a turn has actually run.
				if (!sessionHasRun(sid)) {
					settlePrompt(msg.id, "No Runtime context snapshot is available for this session yet.");
					return;
				}
				settlePrompt(msg.id, fakeContextReport(currentModel, sid));
				return;
			}
			if (mode === "wait") {
				if (promptCount > 1) {
					clearTimeout(abortTimer);
					markExecSessionRan(sid, effectiveContextWindow());
					settlePrompt(msg.id, `QUEUED TURN ANSWER: ${text}`);
					return;
				}
				await playAcpScenario(msg.id);
				return;
			}
			markExecSessionRan(sid, effectiveContextWindow());
			await playAcpScenario(msg.id);
		}
	}
}
