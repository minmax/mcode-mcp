// Tool schemas and their implementations.

import { existsSync, statSync } from "node:fs";
import type { Accumulator } from "./answer.ts";
import {
	accumulate,
	answerProblem,
	clip,
	describeBrokenRun,
	newAccumulator,
	renderFailure,
	selectAnswer,
	summarize,
	tailStderr,
} from "./answer.ts";
import {
	DEFAULT_MODEL,
	DEFAULT_PERMISSION,
	MAX_PROMPT,
	MAX_TIMEOUT_MS,
	MODELS_TIMEOUT_MS,
	TIMEOUT_MS,
} from "./config.ts";
import {
	HISTORY_DEFAULT_LIMIT,
	HISTORY_DEFAULT_MAX_CHARS,
	HISTORY_MAX_LIMIT,
	HISTORY_MAX_MAX_CHARS,
	HISTORY_MAX_RESPONSE_CHARS,
	readMcodeHistory,
} from "./history.ts";
import type { RunResult } from "./mcode-process.ts";
import { runMcode, withSlot } from "./mcode-process.ts";
import { asRecord } from "./parse.ts";
import { getSession, listSessions, rememberSession, withSessionLock } from "./sessions.ts";
import { findTranscript, statKey } from "./transcript.ts";
import { modelsArgs } from "./transport/args.ts";
import type { RunPlan, Transport } from "./transport/index.ts";
import { getRun, listRuns, resolveTransport, TRANSPORT_NAMES } from "./transport/index.ts";
import type {
	CallContext,
	Permission,
	RunOverrides,
	SessionMode,
	SessionTransport,
	ToolDefinition,
	ToolResult,
} from "./types.ts";
import { isPermission, isSessionMode, PERMISSIONS, SESSION_MODES } from "./types.ts";

const MUTATING = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: true,
} as const;
const LIVE_LISTING = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
} as const;
const LOCAL_LISTING = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

const SHARED_PROPS = {
	model: {
		type: "string",
		description:
			"Model as MiniMax Code expects it: provider/model, e.g. 'minimax_oauth/MiniMax-M2.5'. " +
			"Defaults to mcode's own default. mcode_models lists what provider list --json reported.",
	},
	permission: {
		type: "string",
		enum: [...PERMISSIONS],
		description:
			"Headless --permission: 'smart' (auto routine, ask when needed), 'full' (bypassPermissions), " +
			"'off'. Server default is full. ACP maps smart→auto and full→bypassPermissions. " +
			"'off' is exec-only; ACP rejects it. 'ask' is not a headless option.",
	},
	mode: {
		type: "string",
		enum: [...SESSION_MODES],
		description:
			"ACP session/set_mode: 'default' or 'plan'. Print/exec has no session mode flag — plan on print is rejected.",
	},
	thinking_effort: {
		type: "string",
		description:
			"ACP-only session/set_config_option id=thinkingEffort. Values are model-dependent; print has no equivalent flag.",
	},
	transport: {
		type: "string",
		enum: TRANSPORT_NAMES,
		description:
			"Usually omit. The default 'acp' keeps mcode up (`mcode acp`) so a running turn can be aborted " +
			"or steered with mcode_send. 'print' is mcode exec --output-format stream-json: one process per " +
			"turn that cannot be reached while it works.",
	},
	timeout_ms: {
		type: "integer",
		minimum: 1000,
		description:
			"Usually omit — there is no server default deadline. A run killed at the deadline is not lost: " +
			"it still returns its session id and is resumable with mcode_reply. Print also forwards --timeout <N>ms.",
	},
} as const;

export const TOOLS: ToolDefinition[] = [
	{
		name: "mcode",
		description:
			"Start a NEW task in the local MiniMax Code agent (`mcode`) — a separate CLI coding agent with its own " +
			"file/shell tools and its own context window. Blocks until mcode settles, then returns only its " +
			"final result plus stats, prefixed [session: <id>] and [session-key: mcode:<id>]; continue that " +
			"session later with mcode_reply.\n" +
			"Caution: with permission 'full' (the server default) mcode edits files and runs shell commands " +
			"as your user inside `cwd` without asking.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: {
					type: "string",
					description:
						"The complete task. mcode cannot see this conversation, so include everything it needs: " +
						"file paths, goal, constraints, expected output format.",
				},
				cwd: {
					type: "string",
					description:
						"Usually omit to use this server's cwd. If set, must be an absolute path (relative is " +
						"rejected). mcode works and edits here.",
				},
				...SHARED_PROPS,
			},
			required: ["prompt"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "mcode_reply",
		description:
			"Send a new turn to an existing mcode session that is not executing right now — including one " +
			"that timed out or was cancelled: the session survives in MiniMax Code's own store, so resume it here " +
			"instead of restarting with `mcode`. Survives restarts of this server. For a turn still running under " +
			"'acp', use mcode_send instead.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id from a [session: <id>] prefix, or from mcode_sessions.",
				},
				prompt: { type: "string", description: "Follow-up message for this session." },
				cwd: {
					type: "string",
					description: "Absolute path override. Defaults to the directory where the session started.",
				},
				...SHARED_PROPS,
			},
			required: ["session", "prompt"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "mcode_models",
		description:
			"List what this MiniMax Code installation reports via `mcode provider list --json`. " +
			"Use it to pick a `model` value for `mcode` / `mcode_reply`. Starts no task. Official OAuth " +
			"providers may list zero models even when a default model is configured.",
		inputSchema: {
			type: "object",
			properties: {
				search: {
					type: "string",
					description: "Optional substring filter on provider or model id.",
				},
			},
			additionalProperties: false,
		},
		annotations: LIVE_LISTING,
	},
	{
		name: "mcode_send",
		description:
			"Deliver a message into an mcode turn that is executing right now. Works only on runs started " +
			"with transport 'acp' — a session that already finished takes mcode_reply, not mcode_send. " +
			"`follow_up` is unsupported: MiniMax Code ACP does not document a mid-turn queue. `steer` " +
			"cancels the current turn and submits the message as a new prompt. `mcode_running` lists reachable sessions.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id of the running turn (see mcode_running).",
				},
				message: {
					type: "string",
					description: "Text to deliver. Required for 'steer', ignored by 'abort'.",
				},
				command: {
					type: "string",
					enum: ["steer", "abort", "follow_up"],
					description:
						"'abort' (default) cancels the current turn via ACP session/cancel; 'steer' " +
						"cancels and immediately submits the message as a new user turn. 'follow_up' is rejected.",
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
		annotations: MUTATING,
	},
	{
		name: "mcode_running",
		description:
			"List mcode turns executing at this moment — the ones mcode_send can reach — with session id, " +
			"working directory, elapsed time, and messages already sent in. Only acp-transport runs " +
			"appear. For past sessions use mcode_sessions.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: LOCAL_LISTING,
	},
	{
		name: "mcode_sessions",
		description:
			"List all mcode sessions started through this server, newest first — running or finished, " +
			"including runs that timed out. Each row gives the session id, when it last ran, cwd, " +
			"remembered transport, and model. Use it to recover an id for mcode_reply. For turns still " +
			"executing (mcode_send targets), use mcode_running.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: LOCAL_LISTING,
	},
	{
		name: "mcode_history",
		description:
			"Read a bounded snapshot of a MiniMax Code session's visible conversation from the native " +
			"messages.jsonl under ~/.minimax/v2/sessions. Does not send anything into the run, does not " +
			"take the session lock, and does not wait for mcode to finish. Returns JSON: session, state " +
			"(active if this process is running it, otherwise unknown), items (user / assistant / tool / gap), " +
			"an opaque cursor to resume even at the current EOF, has_more, truncated_tail. Thinking and " +
			"image binaries are omitted. Caps: limit (default " +
			`${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}), max_chars per item (default ` +
			`${HISTORY_DEFAULT_MAX_CHARS}, max ${HISTORY_MAX_MAX_CHARS}), and ${HISTORY_MAX_RESPONSE_CHARS} ` +
			"chars on the whole JSON page.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id from [session: <id>] or mcode_sessions / mcode_running.",
				},
				cursor: {
					type: "string",
					description:
						"Opaque resume token from a previous mcode_history call for this same session and " +
						"transcript. Omit to read from the start.",
				},
				limit: {
					type: "integer",
					minimum: 1,
					description: `Max items to return (default ${HISTORY_DEFAULT_LIMIT}, max ${HISTORY_MAX_LIMIT}).`,
				},
				max_chars: {
					type: "integer",
					minimum: 1,
					description: `Max characters per item text (default ${HISTORY_DEFAULT_MAX_CHARS}, max ${HISTORY_MAX_MAX_CHARS}).`,
				},
				include_tools: {
					type: "boolean",
					description: "Include tool calls/results (default true). Filtered tool lines still advance the cursor.",
				},
			},
			required: ["session"],
			additionalProperties: false,
		},
		annotations: LOCAL_LISTING,
	},
];

export function toolResult(text: string, isError = false): ToolResult {
	return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function resolveCwd(requested: unknown): string {
	if (requested === undefined || requested === null || requested === "") return process.cwd();
	if (typeof requested !== "string") throw new Error("cwd must be a string");
	if (!requested.startsWith("/")) throw new Error(`cwd must be an absolute path: ${requested}`);
	if (!existsSync(requested) || !statSync(requested).isDirectory()) {
		throw new Error(`cwd does not exist or is not a directory: ${requested}`);
	}
	return requested;
}

function readTimeout(value: unknown): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1000) {
		throw new Error("timeout_ms must be a number of milliseconds, at least 1000");
	}
	if (value > MAX_TIMEOUT_MS) {
		throw new Error(`timeout_ms ${value} exceeds the server ceiling of ${MAX_TIMEOUT_MS} ms`);
	}
	return value;
}

function rejectUnsupported(input: Record<string, unknown>): void {
	if (input.effort !== undefined && input.effort !== null) {
		throw new Error(
			"mcode has no --effort flag; on ACP use thinking_effort (session/set_config_option thinkingEffort)",
		);
	}
	if (input.allowed_tools !== undefined && input.allowed_tools !== null) {
		throw new Error("mcode has no tools allowlist flag; this adapter does not invent one");
	}
	if (input.system_prompt_append !== undefined && input.system_prompt_append !== null) {
		throw new Error("mcode has no system-prompt-append / --rules flag on the supported transports");
	}
	if (input.permission === "ask") {
		throw new Error("permission 'ask' requires the TUI or an interactive ACP host; use smart, full, or off");
	}
}

function readOverrides(input: Record<string, unknown>, transportName: string): RunOverrides {
	rejectUnsupported(input);
	const overrides: RunOverrides = {};
	const model = input.model ?? DEFAULT_MODEL;
	if (model !== undefined && model !== null) {
		if (typeof model !== "string") throw new Error("model must be a string");
		overrides.model = model;
	}
	const permission = input.permission ?? DEFAULT_PERMISSION;
	if (permission !== undefined && permission !== null) {
		if (!isPermission(permission)) {
			throw new Error(`invalid permission "${String(permission)}"; expected one of ${PERMISSIONS.join(", ")}`);
		}
		if (transportName === "acp" && permission === "off") {
			throw new Error("permission 'off' is exec-only; ACP permissionMode is default, auto, or bypassPermissions");
		}
		overrides.permission = permission;
	}
	const mode = input.mode;
	if (mode !== undefined && mode !== null) {
		if (!isSessionMode(mode)) {
			throw new Error(`invalid mode "${String(mode)}"; expected one of ${SESSION_MODES.join(", ")}`);
		}
		if (transportName === "print") {
			throw new Error("mode is ACP-only; mcode exec has no --plan / session-mode flag");
		}
		overrides.mode = mode;
	}
	const thinking = input.thinking_effort;
	if (thinking !== undefined && thinking !== null) {
		if (typeof thinking !== "string" || thinking.trim() === "") {
			throw new Error("thinking_effort must be a non-empty string");
		}
		if (transportName === "print") {
			throw new Error("thinking_effort is ACP-only; print/exec has no thinkingEffort flag");
		}
		overrides.thinking_effort = thinking;
	}
	if (input.add_dirs !== undefined && input.add_dirs !== null) {
		if (transportName === "print") {
			throw new Error("add_dirs is ACP-only; mcode exec has no --add-dir flag");
		}
		if (typeof input.add_dirs !== "string") {
			throw new Error("add_dirs must be a comma-separated string of absolute paths");
		}
		const dirs = input.add_dirs
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		for (const dir of dirs) {
			if (!dir.startsWith("/")) throw new Error(`add_dirs entries must be absolute paths: ${dir}`);
			if (!existsSync(dir) || !statSync(dir).isDirectory()) {
				throw new Error(`add_dirs path does not exist or is not a directory: ${dir}`);
			}
		}
		overrides.add_dirs = dirs;
	}
	return overrides;
}

function readPrompt(value: unknown, tool: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${tool}: \`prompt\` is required and must be a non-empty string.`);
	}
	if (value.length > MAX_PROMPT) {
		throw new Error(
			`${tool}: prompt is ${value.length} chars, over the ${MAX_PROMPT} limit. ` +
				"Split the task or point mcode at files instead.",
		);
	}
	return value;
}

interface Outcome {
	acc: Accumulator;
	result: RunResult;
	elapsedMs: number;
}

function identityPrefix(id: string): string {
	return `[session: ${id}]\n[session-key: mcode:${id}]`;
}

function rememberExtras(overrides: RunOverrides, transport: SessionTransport): Parameters<typeof rememberSession>[2] {
	return {
		model: overrides.model,
		permission: overrides.permission,
		mode: overrides.mode,
		thinking_effort: overrides.thinking_effort,
		transport,
	};
}

function announceStart(ctx: CallContext, id: string, cwd: string, model?: string): void {
	if (!ctx.progress) return;
	const bits = [`mcode started · mcode:${id}`];
	if (model) bits.push(model);
	bits.push(`cwd=${cwd}`);
	ctx.progress(bits.join(" · "));
}

async function invokeMcode(transport: Transport, plan: RunPlan, ctx: CallContext): Promise<Outcome> {
	const acc = newAccumulator();
	const started = Date.now();
	const result = await transport.run(plan, ctx, (event) => {
		const note = accumulate(acc, event);
		if (note && ctx.progress) ctx.progress(note);
	});
	acc.capturedBytes = result.stdout.length;
	return { acc, result, elapsedMs: Date.now() - started };
}

function failedRun(outcome: Outcome): boolean {
	const { result } = outcome;
	return result.code !== 0 || Boolean(result.timedOut) || Boolean(result.cancelled) || Boolean(result.protocolError);
}

function renderSuccess(outcome: Outcome, prefix: string | null): ToolResult {
	const { acc, result, elapsedMs } = outcome;
	const answer = selectAnswer(acc);
	const problem = answerProblem(answer, acc);
	const warnings = tailStderr(result.stderr);
	const parts: string[] = [];
	if (prefix) parts.push(prefix);
	if (problem) parts.push(`[warning: ${problem}]`);
	if (warnings) parts.push(`[mcode stderr: ${warnings}]`);

	if (answer.text) {
		parts.push(clip(answer.text));
	} else {
		parts.push(
			"mcode returned no usable answer text: its message stream did not match the expected " +
				"`--output-format stream-json` / ACP session/update contract.\n" +
				describeBrokenRun(acc),
		);
	}

	if (answer.source === "result-error") {
		const lastSaid = acc.assistantTexts[acc.assistantTexts.length - 1];
		if (lastSaid !== undefined && lastSaid !== answer.text) parts.push(`last thing mcode said:\n${clip(lastSaid)}`);
	}

	parts.push(`---\n${summarize(acc, elapsedMs)}`);
	return toolResult(parts.join("\n\n"), Boolean(problem));
}

export async function callMcode(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	let prompt: string;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	try {
		prompt = readPrompt(input.prompt, "mcode");
		cwd = resolveCwd(input.cwd);
		timeoutMs = readTimeout(input.timeout_ms);
		transport = resolveTransport(input.transport);
		overrides = readOverrides(input, transport.name);
	} catch (err) {
		return toolResult(`mcode: ${(err as Error).message}`, true);
	}

	let sessionId = "";
	const plan: RunPlan = {
		cwd,
		sessionId: "",
		prompt,
		overrides,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
		onSessionId: (id) => {
			sessionId = id;
			rememberSession(id, cwd, rememberExtras(overrides, transport.name));
			announceStart(ctx, id, cwd, overrides.model);
		},
	};
	const outcome = await withSlot(() => invokeMcode(transport, plan, ctx));
	if (outcome.result.sessionId) sessionId = outcome.result.sessionId;
	if (sessionId) rememberSession(sessionId, cwd, rememberExtras(overrides, transport.name));

	if (failedRun(outcome)) {
		return toolResult(
			renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
				id: sessionId || "(unknown)",
				tool: "mcode",
				timeoutMs: timeoutMs ?? TIMEOUT_MS,
			}),
			true,
		);
	}

	const answerSource = selectAnswer(outcome.acc).source;
	const brokenAnswer = answerSource === "broken" || answerSource === "cut-off" || answerSource === "none";
	return renderSuccess(
		outcome,
		brokenAnswer
			? `note: session ${sessionId || "(unknown)"} never produced a result envelope; it stays listed by mcode_sessions`
			: identityPrefix(sessionId),
	);
}

export async function callMcodeReply(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("mcode_reply: `session` is required.", true);
	}

	const known = getSession(session);
	let prompt: string;
	let cwd: string;
	let overrides: RunOverrides;
	let timeoutMs: number | undefined;
	let transport: Transport;
	try {
		prompt = readPrompt(input.prompt, "mcode_reply");
		cwd = resolveCwd(input.cwd ?? known?.cwd);
		timeoutMs = readTimeout(input.timeout_ms);
		transport = resolveTransport(input.transport ?? known?.transport);
		overrides = readOverrides(
			{
				...input,
				model: input.model ?? known?.model,
				permission: input.permission ?? known?.permission,
				mode: input.mode ?? known?.mode,
				thinking_effort: input.thinking_effort ?? known?.thinking_effort,
			},
			transport.name,
		);
	} catch (err) {
		return toolResult(`mcode_reply: ${(err as Error).message}`, true);
	}

	const plan: RunPlan = {
		cwd,
		sessionId: session,
		resume: true,
		prompt,
		overrides,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
	};
	announceStart(ctx, session, cwd, overrides.model);
	const outcome = await withSessionLock(session, () => withSlot(() => invokeMcode(transport, plan, ctx)));

	if (failedRun(outcome)) {
		rememberSession(session, cwd, {});
		return toolResult(
			renderFailure(outcome.acc, outcome.result, outcome.elapsedMs, {
				id: session,
				tool: "mcode_reply",
				timeoutMs: timeoutMs ?? TIMEOUT_MS,
			}),
			true,
		);
	}

	const remembered: {
		model?: string;
		permission?: Permission;
		mode?: SessionMode;
		thinking_effort?: string;
		transport?: SessionTransport;
	} = {};
	if (input.model !== undefined && overrides.model !== undefined) remembered.model = overrides.model;
	if (input.permission !== undefined && overrides.permission !== undefined) {
		remembered.permission = overrides.permission;
	}
	if (input.mode !== undefined && overrides.mode !== undefined) remembered.mode = overrides.mode;
	if (input.thinking_effort !== undefined && overrides.thinking_effort !== undefined) {
		remembered.thinking_effort = overrides.thinking_effort;
	}
	if (input.transport !== undefined || known?.transport === undefined) remembered.transport = transport.name;
	rememberSession(session, cwd, remembered);

	return renderSuccess(outcome, identityPrefix(session));
}

export async function callMcodeModels(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const search = input.search;
	if (search !== undefined && typeof search !== "string") {
		return toolResult("mcode_models: `search` must be a string.", true);
	}

	const result = await withSlot(() =>
		runMcode(modelsArgs(), process.cwd(), {
			token: ctx.token,
			timeoutMs: MODELS_TIMEOUT_MS,
		}),
	);

	if (result.cancelled) return toolResult("mcode_models was cancelled.", true);

	if (result.code !== 0) {
		return toolResult(
			`mcode_models could not read the model catalog from mcode (exit code ${result.code}).` +
				(result.stderr
					? `\n\n${tailStderr(result.stderr)}`
					: result.stdout
						? `\n\n${tailStderr(result.stdout)}`
						: ""),
			true,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdout);
	} catch {
		return toolResult(
			`mcode_models could not parse the model catalog from mcode.` +
				(result.stdout.trim() ? `\n\n${tailStderr(result.stdout)}` : " mcode printed nothing."),
			true,
		);
	}

	const rec = asRecord(parsed);
	const providers = rec && Array.isArray(rec.providers) ? rec.providers : null;
	if (providers === null) {
		return toolResult(
			`mcode_models could not parse the model catalog from mcode.` +
				(result.stdout.trim() ? `\n\n${tailStderr(result.stdout)}` : " mcode printed nothing."),
			true,
		);
	}

	const source = typeof rec?.minimaxModelSource === "string" ? rec.minimaxModelSource : undefined;
	const needle = search?.toLowerCase();
	const lines: string[] = [];
	let modelCount = 0;

	for (const raw of providers) {
		const provider = asRecord(raw);
		if (provider === null) continue;
		const providerId = typeof provider.providerId === "string" ? provider.providerId : "unknown";
		const name = typeof provider.name === "string" ? provider.name : providerId;
		const active = provider.active === true;
		const models = Array.isArray(provider.models) ? provider.models : [];
		const header = `- ${providerId} (${name})${active ? " · active" : ""}`;
		const modelLines: string[] = [];
		for (const modelRaw of models) {
			if (typeof modelRaw === "string") {
				const id = `${providerId}/${modelRaw}`;
				if (needle && !id.toLowerCase().includes(needle) && !name.toLowerCase().includes(needle)) continue;
				modelCount += 1;
				modelLines.push(`  - ${id}`);
				continue;
			}
			const model = asRecord(modelRaw);
			const modelId = typeof model?.modelId === "string" ? model.modelId : undefined;
			if (!modelId) continue;
			const id = `${providerId}/${modelId}`;
			const hay = `${id} ${name}`.toLowerCase();
			if (needle && !hay.includes(needle)) continue;
			modelCount += 1;
			const selected = model?.selected === true ? " · selected" : "";
			modelLines.push(`  - ${id}${selected}`);
		}
		if (needle && modelLines.length === 0 && !`${providerId} ${name}`.toLowerCase().includes(needle)) continue;
		lines.push(header);
		if (modelLines.length === 0) lines.push("  (no models listed)");
		else lines.push(...modelLines);
	}

	if (lines.length === 0) {
		return toolResult(
			search ? `No mcode providers or models match "${search}".` : "mcode reported no providers.",
			true,
		);
	}

	const intro = `${providers.length} provider(s), ${modelCount} model(s)${source ? `, source ${source}` : ""}:`;
	return toolResult(`${intro}\n\n${lines.join("\n")}`);
}

export function callMcodeSend(input: Record<string, unknown>): ToolResult {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("mcode_send: `session` is required.", true);
	}

	const command = input.command ?? "abort";
	if (command !== "steer" && command !== "follow_up" && command !== "abort") {
		return toolResult(`mcode_send: \`command\` must be steer, follow_up, or abort (got ${String(command)}).`, true);
	}

	if (command === "follow_up") {
		return toolResult(
			"mcode_send: follow_up is unsupported. MiniMax Code ACP does not document a mid-turn queue. " +
				"Use abort or steer on a running turn, or mcode_reply after it finishes.",
			true,
		);
	}

	const message = input.message;
	if (command === "steer" && (typeof message !== "string" || message.trim() === "")) {
		return toolResult("mcode_send: `message` is required for steer.", true);
	}
	if (message !== undefined && typeof message !== "string") {
		return toolResult("mcode_send: `message` must be a string.", true);
	}

	const run = getRun(session);
	if (run === undefined) {
		const alive = listRuns();
		const hint =
			alive.length === 0
				? "No mcode turn is running under the acp transport right now."
				: `Running sessions: ${alive.map((r) => r.sessionId).join(", ")}.`;
		const known = getSession(session);
		const trail =
			known?.transport === "print"
				? "This session last ran as print; print has no mid-run channel. Continue it with mcode_reply."
				: "A finished session is continued with mcode_reply instead. Only a still-running ACP turn can be reached with mcode_send.";
		return toolResult(
			`mcode_send: session ${session} is not currently running, so there is nothing to send to. ${hint}\n${trail}`,
			true,
		);
	}

	if (run.deliver) {
		run.deliver(command, typeof message === "string" ? message : undefined);
	} else {
		return toolResult("mcode_send: this run has no delivery channel.", true);
	}
	run.sent.push({ at: Date.now(), type: String(command) });

	const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
	const effect =
		command === "abort"
			? "The interrupted turn's report appears in the answer of the call that is waiting on it."
			: "mcode decides when to act on it; the reaction appears in the answer of the call that is still " +
				"waiting on this turn.";
	return toolResult(`Sent ${command} to session ${session} (running for ${elapsed}s).\n${effect}`);
}

export function callMcodeRunning(): ToolResult {
	const runs = listRuns();
	if (runs.length === 0) {
		return toolResult(
			"No mcode turn is running under the acp transport. Use mcode_reply for a finished session. " +
				"mcode_running only lists ACP turns that are in flight.",
		);
	}
	const rows = runs.map((run) => {
		const elapsed = ((Date.now() - run.startedAt) / 1000).toFixed(1);
		const sent = run.sent.length > 0 ? ` sent: ${run.sent.map((s) => s.type).join(",")}` : "";
		return `${run.sessionId}  ${elapsed}s  ${run.cwd}${sent}`;
	});
	return toolResult(`${rows.length} running:\n\n${rows.join("\n")}`);
}

export function callMcodeHistory(input: Record<string, unknown>): ToolResult {
	const page = readMcodeHistory(input);
	if ("error" in page) return toolResult(page.error, true);
	return toolResult(JSON.stringify(page));
}

export function callMcodeSessions(): ToolResult {
	const rows = listSessions().map(([id, entry]) => {
		const when = entry.lastAccessed ? new Date(entry.lastAccessed).toISOString() : "unknown";
		const model = entry.model ? `  ${entry.model}` : "";
		const wire = entry.transport ? `  ${entry.transport}` : "";
		const transcript = findTranscript(id) ?? "(no transcript on disk)";
		return `${statKey(id)}  ${when}  ${entry.cwd}${wire}${model}\n    ${transcript}`;
	});
	if (rows.length === 0) {
		return toolResult("No mcode sessions recorded yet. Start one with the `mcode` tool.");
	}
	return toolResult(`${rows.length} session(s), newest first:\n\n${rows.join("\n")}`);
}
