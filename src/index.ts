#!/usr/bin/env node
// Minimal stdio MCP server that exposes the locally installed `mcode` CLI
// (MiniMax Code) as a delegatable sub-agent.
//
// No runtime dependencies: newline-delimited JSON-RPC 2.0 is spoken directly.

import { FALLBACK_PROTOCOL, KILL_GRACE_MS, MAX_FRAME, PROTOCOL_VERSIONS, SERVER_INFO } from "./config.ts";
import { killAllTrees, makeCancelToken, treeCount } from "./mcode-process.ts";
import { recoverPendingContextEdit } from "./minimax-config.ts";
import {
	DEFAULT_PROFILE_NAME,
	listProfiles,
	MCODE_PROFILE_ENV_VAR,
	PROFILE_ENV_VAR,
	serverProfile,
} from "./profile.ts";
import { loadSessions } from "./sessions.ts";
import {
	callMcode,
	callMcodeContext,
	callMcodeHistory,
	callMcodeModels,
	callMcodeProfiles,
	callMcodeReply,
	callMcodeRunning,
	callMcodeSend,
	callMcodeSessions,
	profileArgumentError,
	resolveCall,
	toolDefinitions,
	toolResult,
} from "./tools.ts";
import type { CallContext, CancelToken, JsonRpcId, JsonRpcMessage, ToolResult } from "./types.ts";

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id: JsonRpcId, result: unknown): void {
	send({ jsonrpc: "2.0", id, result });
}

function replyError(id: JsonRpcId, code: number, message: string): void {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

const inFlight = new Map<string, CancelToken>();

function requestKey(id: unknown): string {
	return `${typeof id}:${String(id)}`;
}

function makeContext(token: CancelToken, meta: Record<string, unknown> | undefined): CallContext {
	const progressToken = meta?.progressToken;
	let counter = 0;
	if (progressToken === undefined || progressToken === null) return { token };
	return {
		token,
		progress: (message: string) => {
			counter += 1;
			send({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progressToken, progress: counter, message },
			});
		},
	};
}

async function dispatchTool(
	name: unknown,
	args: Record<string, unknown>,
	ctx: CallContext,
): Promise<ToolResult | null> {
	// The name carries the account: `mcode` is the server's default, `mcode_work`
	// and `mcode_work_reply` are pinned to a named profile. Resolved first, so no
	// argument can redirect a call to another account.
	const target = resolveCall(String(name));
	if (target === null) return null;
	const misdirected = profileArgumentError(target, args);
	if (misdirected !== null) return misdirected;
	switch (target.action) {
		case "mcode":
			return callMcode(args, ctx, target);
		case "mcode_reply":
			return callMcodeReply(args, ctx, target);
		case "mcode_models":
			return callMcodeModels(args, ctx, target);
		case "mcode_context":
			return callMcodeContext(args, ctx, target);
		case "mcode_send":
			return callMcodeSend(args);
		case "mcode_running":
			return callMcodeRunning();
		case "mcode_sessions":
			return callMcodeSessions();
		case "mcode_history":
			return callMcodeHistory(args, target);
		case "mcode_profiles":
			return callMcodeProfiles();
		default:
			return null;
	}
}

function asRecordParam(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function describeInternalError(err: unknown, tool: string): string {
	const lines = [`mcode-mcp internal error while handling \`${tool}\` — this is a bug in the adapter, not in mcode.`];

	let current: unknown = err;
	let depth = 0;
	while (current !== null && current !== undefined && depth < 5) {
		const error = current instanceof Error ? current : undefined;
		const label = depth === 0 ? "error" : "caused by";
		if (error === undefined) {
			lines.push(`\n${label}: ${typeof current === "string" ? current : JSON.stringify(current)}`);
			break;
		}

		lines.push(`\n${label}: ${error.name}: ${error.message}`);
		const frames = (error.stack ?? "")
			.split("\n")
			.slice(1)
			.map((line) => line.trim())
			.filter((line) => line.includes("/mcode-mcp/") || line.includes("src/"))
			.slice(0, 8);
		if (frames.length > 0) lines.push(frames.map((f) => `  ${f}`).join("\n"));

		current = error.cause;
		depth += 1;
	}

	return lines.join("\n");
}

async function handle(msg: JsonRpcMessage): Promise<void> {
	const hasId = Object.hasOwn(msg, "id");
	const id = msg.id ?? null;
	const method = msg.method;
	const params = asRecordParam(msg.params);

	if (msg.jsonrpc !== "2.0" || typeof method !== "string") {
		if (hasId) replyError(id, -32600, "Invalid Request");
		return;
	}
	if (hasId && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number") {
		replyError(null, -32600, "Invalid Request: id must be a string, number, or null");
		return;
	}

	switch (method) {
		case "initialize": {
			if (!hasId) return;
			const requested = params.protocolVersion;
			const protocolVersion =
				typeof requested === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(requested)
					? requested
					: FALLBACK_PROTOCOL;
			reply(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
			return;
		}

		case "notifications/initialized":
		case "initialized":
			return;

		case "notifications/cancelled": {
			inFlight.get(requestKey(params.requestId))?.cancel();
			return;
		}

		case "ping":
			if (hasId) reply(id, {});
			return;

		case "tools/list":
			if (hasId) reply(id, { tools: toolDefinitions() });
			return;

		case "tools/call": {
			if (!hasId) return;
			const token = makeCancelToken();
			const key = requestKey(msg.id);
			inFlight.set(key, token);
			try {
				const ctx = makeContext(token, asRecordParam(params._meta));
				const result = await dispatchTool(params.name, asRecordParam(params.arguments), ctx);
				if (result === null) replyError(id, -32602, `Unknown tool: ${String(params.name)}`);
				else reply(id, result);
			} catch (err) {
				reply(id, toolResult(describeInternalError(err, String(params.name)), true));
			} finally {
				inFlight.delete(key);
			}
			return;
		}

		default:
			if (hasId) replyError(id, -32601, `Method not found: ${method}`);
	}
}

let shuttingDown = false;

function shutdown(reason: string, code = 0): void {
	if (shuttingDown) return;
	shuttingDown = true;
	const trees = treeCount();
	if (trees > 0) {
		process.stderr.write(`mcode-mcp: ${reason} — terminating ${trees} running mcode process(es)\n`);
		for (const token of inFlight.values()) token.cancel();
		killAllTrees("SIGTERM");
		setTimeout(() => {
			killAllTrees("SIGKILL");
			process.exit(code);
		}, KILL_GRACE_MS).unref();
		return;
	}
	process.exit(code);
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
	process.on(signal, () => shutdown(`received ${signal}`, 0));
}
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
	if (err?.code === "EPIPE") shutdown("stdout closed", 0);
});

loadSessions();

// A malformed profile selector is refused here rather than repaired. Falling back
// to the default profile would look like working software while running every
// task against the wrong account, so the server says what is wrong and stops.
let activeProfile: string | null;
try {
	activeProfile = serverProfile();
} catch (err) {
	process.stderr.write(`mcode-mcp: ${(err as Error).message}\n`);
	process.stderr.write(
		`mcode-mcp: check ${PROFILE_ENV_VAR} and ${MCODE_PROFILE_ENV_VAR}. Not serving, because running on ` +
			"the wrong account is worse than not running.\n",
	);
	process.exit(2);
}

// Finish a context_window rollback that a previous crash interrupted, before
// anything reads the config this server is about to make mcode use.
//
// Every profile, not just the one this server defaults to: the patch and its
// sidecar are left in whichever profile's config the run was using, so recovering
// only the default would leave a `work` run's unclosed edit in place. Left there,
// the next run on that profile would read the stale window back as the "original"
// value and restore that instead of the user's setting. The default profile is
// always in the list — it is reachable through an explicit `profile: "default"`
// even when the server defaults elsewhere — and each profile is swept once.
const profilesToRecover = [
	null,
	activeProfile,
	...listProfiles().flatMap((found) => (found.name === DEFAULT_PROFILE_NAME ? [] : [found.name])),
].filter((name, index, all) => all.indexOf(name) === index);
for (const profile of profilesToRecover) {
	try {
		const recovered = recoverPendingContextEdit(profile);
		if (recovered !== null) process.stderr.write(`mcode-mcp: ${recovered}\n`);
	} catch (err) {
		process.stderr.write(`mcode-mcp: could not check for an unclosed config edit: ${(err as Error).message}\n`);
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	let newline = buffer.indexOf("\n");
	while (newline !== -1) {
		const line = buffer.slice(0, newline).trim();
		buffer = buffer.slice(newline + 1);
		newline = buffer.indexOf("\n");
		if (!line) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
			continue;
		}

		const msg = parsed as JsonRpcMessage;
		handle(msg).catch((err: unknown) => {
			if (Object.hasOwn(msg, "id")) {
				replyError(msg.id ?? null, -32603, `Internal error: ${(err as Error).message ?? String(err)}`);
			}
		});
	}
	if (buffer.length > MAX_FRAME) {
		buffer = "";
		send({
			jsonrpc: "2.0",
			id: null,
			error: { code: -32600, message: `Invalid Request: frame exceeded ${MAX_FRAME} chars` },
		});
	}
});
process.stdin.on("end", () => shutdown("stdin closed", 0));
