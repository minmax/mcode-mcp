#!/usr/bin/env node

// A stand-in for the mcode binary. Speaks:
//   - `mcode exec --output-format stream-json` (print / headless)
//   - `mcode acp` ACP JSON-RPC
//   - `mcode provider list --json` configured catalog

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const mode = process.env.FAKE_MODE ?? "answer";
const exitCode = Number(process.env.FAKE_EXIT ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argv = process.argv.slice(2);

if (process.env.FAKE_STARTED_FILE) {
	appendFileSync(process.env.FAKE_STARTED_FILE, `${process.pid}\n`);
}
if (process.env.FAKE_ARGV_LOG) {
	appendFileSync(process.env.FAKE_ARGV_LOG, `${JSON.stringify(argv)}\n`);
}

function argValue(flag) {
	const index = argv.indexOf(flag);
	return index === -1 ? undefined : argv[index + 1];
}

const mintSession = () => process.env.FAKE_SESSION_ID ?? `session_${randomUUID()}`;
const sessionFromArgv = () => argValue("--session") ?? mintSession();

function spawnMarkedChild() {
	const tag = process.env.FAKE_CHILD_TAG ?? "mcode-mcp-child";
	const child = spawn("sh", ["-c", `sleep 120; true # ${tag}`], { stdio: "ignore" });
	child.unref();
}

function emitExec(status, output, extra = {}) {
	const id = sessionFromArgv();
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

async function runAcp() {
	const stdinLog = process.env.FAKE_STDIN_LOG;
	let sid = process.env.FAKE_SESSION_ID ?? mintSession();
	let holding = false;
	let holdInterval;
	let abortTimer;
	let promptId = null;
	let promptCount = 0;

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
			rpc(msg.id, { sessionId: sid, configOptions: [] });
			return;
		}
		if (msg.method === "session/load") {
			sid = msg.params?.sessionId ?? sid;
			rpc(msg.id, { sessionId: sid, configOptions: [] });
			return;
		}
		if (msg.method === "session/set_mode" || msg.method === "session/set_config_option") {
			rpc(msg.id, {});
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
			if (mode === "wait") {
				if (promptCount > 1) {
					clearTimeout(abortTimer);
					settlePrompt(msg.id, `QUEUED TURN ANSWER: ${text}`);
					return;
				}
				await playAcpScenario(msg.id);
				return;
			}
			await playAcpScenario(msg.id);
		}
	}
}
