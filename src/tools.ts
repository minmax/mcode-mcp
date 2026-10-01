// Tool schemas and their implementations.

import { existsSync, statSync } from "node:fs";
import { withAcpQuery } from "./acp-query.ts";
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
	CONTEXT_TIMEOUT_MS,
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
import { withSlot } from "./mcode-process.ts";
import { ConfigEditError } from "./minimax-config.ts";
import { acpModelOptions, acpSelects, decodeAcpModelValue, formatModelRef } from "./model-ref.ts";
import {
	DEFAULT_PROFILE_NAME,
	dataDirForProfile,
	dataDirIsOverridden,
	describeProfileState,
	listProfiles,
	profileDirExists,
	profileForCall,
	serverProfile,
} from "./profile.ts";
import { getSession, listSessions, rememberSession, withSessionLock } from "./sessions.ts";
import { findTranscript, statKey } from "./transcript.ts";
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
	profile: {
		type: "string",
		description:
			"Named auth profile: its own MiniMax account, sessions and settings, in ~/.minimax-<name>. " +
			"Omit to use this server's default (MCODE_MCP_PROFILE, else the default profile). 'default' " +
			"means the default profile explicitly. A session keeps the profile it started under, so " +
			"`mcode_reply` does not need it, and it may not be changed — a session id only names a " +
			"conversation inside one account. Use mcode_profiles to list what exists and what is signed in; " +
			"add one with `mcode login --profile <name>` in a terminal.",
	},
	model: {
		type: "string",
		description:
			"Model as provider/model, e.g. 'minimax/MiniMax-M3.1-Flash-Preview'. Append '#variant' to pin one, " +
			"e.g. 'minimax/MiniMax-M3#thinking'; without it the model's current variant is kept. " +
			"Defaults to mcode's own default. mcode_models lists what this installation advertises.",
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
	context_window: {
		type: "integer",
		minimum: 1,
		description:
			"Context window for this run, in tokens. The catalog advertises 512000 and 1000000 for M3 / M3.1, " +
			"and 1000000 is the one marked higher_usage. Requires transport: 'print' — it hands mcode a " +
			"private config via --config and verifiably takes effect. On 'acp' this is refused: MiniMax Code " +
			"builds a session selection that carries no context limit, so there the value cannot take effect " +
			"however it is set. mcode silently ignores a window the model does not advertise, so confirm the " +
			"result with mcode_context. Only processes this call starts are affected; a session that already " +
			"exists keeps the window it was created with.",
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
			"List the models this MiniMax Code installation can actually run, taken from the session's " +
			"advertised catalog rather than from the credential list (`mcode provider list --json` reports an " +
			"empty model set under a Token Plan login, so it cannot answer this). Each row is the " +
			"`provider/model` to pass to `mcode` / `mcode_reply`, plus the variant suffix and label. " +
			"Starts no task.",
		inputSchema: {
			type: "object",
			properties: {
				search: {
					type: "string",
					description: "Optional substring filter on provider or model id.",
				},
				profile: SHARED_PROPS.profile,
			},
			additionalProperties: false,
		},
		annotations: LIVE_LISTING,
	},
	{
		name: "mcode_profiles",
		description:
			"List the MiniMax auth profiles on this machine, and which one this server uses by default. " +
			"A profile is an isolated data directory (~/.minimax-<name>) with its own account, sessions and " +
			"settings, so several token plans can be kept side by side. Read the credential state before " +
			"choosing one: a profile reported as 'signed out' or 'not created' has nothing to authenticate " +
			"with, and running against it is how a task ends up charged to the wrong account. Starts no " +
			"process and starts no task. Add one with `mcode login --profile <name>` in a terminal — login is " +
			"interactive and has no headless equivalent.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		annotations: LOCAL_LISTING,
	},
	{
		name: "mcode_context",
		description:
			"Report the context window and budget of an mcode session: total window, tokens used, how full " +
			"that is, whether compaction has run, and the per-component breakdown (system prompt, memory, " +
			"tools, skills, messages). Read-only: it opens the session, asks MiniMax Code's own /context " +
			"report and closes again, so it neither runs a task nor changes the turn. " +
			"The session must have completed at least one turn — a session that has never run has no " +
			"snapshot to report. Use it to find out what a session's `context_window` actually came out as, " +
			"since that value is chosen by mcode rather than returned by the call that set it.",
		inputSchema: {
			type: "object",
			properties: {
				session: {
					type: "string",
					description: "Session id, as printed in the [session: <id>] prefix of an mcode answer.",
				},
				profile: {
					...SHARED_PROPS.profile,
					description:
						"Defaults to the profile the session was started under, which is almost always what " +
						"you want — pass it only to read a session recorded under another profile.",
				},
			},
			required: ["session"],
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
				profile: {
					...SHARED_PROPS.profile,
					description:
						"Defaults to the profile the session was started under. The page reports which profile " +
						"it actually read, and a cursor from one profile is refused in another.",
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
	const contextWindow = input.context_window;
	if (contextWindow !== undefined && contextWindow !== null) {
		if (typeof contextWindow !== "number" || !Number.isSafeInteger(contextWindow) || contextWindow < 1) {
			throw new Error("context_window must be a whole number of tokens, at least 1");
		}
		overrides.context_window = contextWindow;
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

/**
 * The profile one call runs under, or null for the default.
 *
 * The chain from argument to recorded session to server default is where a
 * wrong-account read hides, so it lives in one place — `profileForCall` — and this
 * only turns its rejection into a readable tool error instead of a run that quietly
 * lands in another account. `mcode_history` resolves the same way.
 */
function readProfile(input: unknown, tool: string, known?: { profile?: string } | undefined): string | null {
	try {
		return profileForCall(input, known?.profile);
	} catch (err) {
		throw new Error(`${tool}: ${(err as Error).message}`);
	}
}

/**
 * Refuse a profile that has no directory yet.
 *
 * `mcode` creates the data directory on first use, so a mistyped name would
 * otherwise spawn happily, produce an empty account and fail much later with an
 * authentication error that points nowhere near the typo. A profile that exists
 * but is not signed in is left alone: it may hold an API key, and mcode is the
 * authority on whether it can authenticate.
 */
function readExistingProfile(input: unknown, tool: string, known?: { profile?: string } | undefined): string | null {
	const profile = readProfile(input, tool, known);
	if (profile !== null && !profileDirExists(profile)) {
		throw new Error(
			`${tool}: no profile named "${profile}" — there is no data directory at ${dataDirForProfile(profile)} ` +
				"on this machine. Check the name with mcode_profiles, or sign the profile in with " +
				"`mcode login --profile <name>`.",
		);
	}
	return profile;
}

interface Outcome {
	acc: Accumulator;
	result: RunResult;
	elapsedMs: number;
}

function identityPrefix(id: string, profile: string | null): string {
	// The profile rides along on every answer that is not the default one: it is
	// the difference between "this account's model answered" and "the other one
	// did", and nothing else in the answer says which account ran.
	const tag = profile === null ? "" : `\n[profile: ${profile}]`;
	return `[session: ${id}]\n[session-key: mcode:${id}]${tag}`;
}

function rememberExtras(
	overrides: RunOverrides,
	transport: SessionTransport,
	profile: string | null,
): Parameters<typeof rememberSession>[2] {
	return {
		model: overrides.model,
		permission: overrides.permission,
		mode: overrides.mode,
		thinking_effort: overrides.thinking_effort,
		transport,
		// Spelled out rather than omitted for the default profile: a session that
		// says "default" has to stay there when the server's own default changes.
		profile: profile ?? DEFAULT_PROFILE_NAME,
	};
}

function announceStart(ctx: CallContext, id: string, cwd: string, model?: string, profile?: string | null): void {
	if (!ctx.progress) return;
	const bits = [`mcode started · mcode:${id}`];
	// Named only when there is one: a progress line is not the place to teach the
	// default case, and the point is to make a non-default run obvious at a glance.
	if (profile) bits.push(`profile=${profile}`);
	if (model) bits.push(model);
	bits.push(`cwd=${cwd}`);
	ctx.progress(bits.join(" · "));
}

async function invokeMcode(transport: Transport, plan: RunPlan, ctx: CallContext): Promise<Outcome> {
	const acc = newAccumulator();
	const started = Date.now();
	let result: RunResult;
	try {
		result = await transport.run(plan, ctx, (event) => {
			const note = accumulate(acc, event);
			if (note && ctx.progress) ctx.progress(note);
		});
	} catch (err) {
		// A refused context-window edit is a decision about the user's config,
		// not a defect in this adapter. Surfacing it as an internal error with a
		// stack trace would be both alarming and wrong.
		if (err instanceof ConfigEditError) {
			result = { code: 1, stdout: "", stderr: "", protocolError: err.message };
		} else {
			throw err;
		}
	}
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
	let profile: string | null;
	try {
		prompt = readPrompt(input.prompt, "mcode");
		cwd = resolveCwd(input.cwd);
		timeoutMs = readTimeout(input.timeout_ms);
		transport = resolveTransport(input.transport);
		overrides = readOverrides(input, transport.name);
		profile = readExistingProfile(input.profile, "mcode");
	} catch (err) {
		return toolResult(`mcode: ${(err as Error).message}`, true);
	}

	let sessionId = "";
	const plan: RunPlan = {
		cwd,
		sessionId: "",
		prompt,
		overrides,
		profile,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
		onSessionId: (id) => {
			sessionId = id;
			rememberSession(id, cwd, rememberExtras(overrides, transport.name, profile));
			announceStart(ctx, id, cwd, overrides.model, profile);
		},
	};
	const outcome = await withSlot(() => invokeMcode(transport, plan, ctx));
	if (outcome.result.sessionId) sessionId = outcome.result.sessionId;
	if (sessionId) rememberSession(sessionId, cwd, rememberExtras(overrides, transport.name, profile));

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
			: identityPrefix(sessionId, profile),
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
	let profile: string | null;
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
		profile = readExistingProfile(input.profile, "mcode_reply", known);
	} catch (err) {
		return toolResult(`mcode_reply: ${(err as Error).message}`, true);
	}

	// Resuming under a different profile would ask another account to `session/load`
	// an id it never issued. That either fails or, worse, silently starts a
	// different conversation in a different account under the same session key.
	// Reading a session from another account is what `mcode_history` and
	// `mcode_context` are for; a reply may not move one.
	const recorded = known === undefined ? undefined : profileForCall(undefined, known.profile);
	if (recorded !== undefined && profile !== recorded) {
		return toolResult(
			`mcode_reply: session ${session} belongs to profile "${recorded ?? DEFAULT_PROFILE_NAME}", and this ` +
				`call asked for "${profile ?? DEFAULT_PROFILE_NAME}". A session id only names a conversation inside ` +
				"one account, so it cannot be resumed in another. Omit `profile` to resume where it started, or " +
				"use mcode_history / mcode_context to read it from the other account.",
			true,
		);
	}

	const plan: RunPlan = {
		cwd,
		sessionId: session,
		resume: true,
		prompt,
		overrides,
		profile,
		timeoutMs: timeoutMs ?? TIMEOUT_MS,
	};
	announceStart(ctx, session, cwd, overrides.model, profile);
	const outcome = await withSessionLock(session, () => withSlot(() => invokeMcode(transport, plan, ctx)));

	if (failedRun(outcome)) {
		// Pinned even on failure, and only when the record had none: this run
		// already chose an account, so a later reply that says nothing must not
		// resolve to a different one.
		rememberSession(session, cwd, recorded === undefined ? { profile: profile ?? DEFAULT_PROFILE_NAME } : {});
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
		profile?: string;
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
	// The profile is never rewritten by a reply. It was pinned when the session
	// was created and the guard above refuses any value that would move it, so
	// there is nothing here that could disagree with the session's own account.
	if (recorded === undefined) remembered.profile = profile ?? DEFAULT_PROFILE_NAME;
	rememberSession(session, cwd, remembered);

	return renderSuccess(outcome, identityPrefix(session, profile));
}

export async function callMcodeModels(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const search = input.search;
	if (search !== undefined && typeof search !== "string") {
		return toolResult("mcode_models: `search` must be a string.", true);
	}
	let profile: string | null;
	try {
		profile = readExistingProfile(input.profile, "mcode_models");
	} catch (err) {
		return toolResult((err as Error).message, true);
	}

	// `mcode provider list --json` describes *configured credentials*, and under a
	// Token Plan login it reports an empty `models` array for every provider — so
	// it cannot answer "which models can I pick". The session's advertised
	// configOptions can, and are the values ACP actually accepts, so read those.
	let configOptions: unknown;
	try {
		const query = await withSlot(() =>
			withAcpQuery(ctx, process.cwd(), MODELS_TIMEOUT_MS, profile, async (session) => {
				const created = await session.newSession();
				return created.configOptions;
			}),
		);
		configOptions = query.value;
	} catch (err) {
		return toolResult(
			`mcode_models could not read the model catalog${profile === null ? "" : ` for profile ${profile}`}: ` +
				`${err instanceof Error ? err.message : String(err)}`,
			true,
		);
	}

	const selects = acpSelects(configOptions);
	const models = acpModelOptions(configOptions);
	if (models.length === 0) {
		return toolResult(
			"mcode advertised no model options on a fresh session, so there is nothing to choose from. " +
				"mcode's configured credential list is a separate, usually empty view — this is the catalog " +
				"that actually drives model selection.",
			true,
		);
	}

	const needle = search?.toLowerCase();
	const lines: string[] = [];
	let count = 0;

	for (const option of models) {
		const id = formatModelRef(option.target);
		if (needle !== undefined && !`${id} ${option.label} ${option.value}`.toLowerCase().includes(needle)) {
			continue;
		}
		count += 1;
		// The variant already rides along in the ref, so it is not repeated here.
		lines.push(`  - ${formatModelRef(option.target)}  · ${option.label}`);
	}

	if (count === 0) {
		return toolResult(`No advertised model matches "${search}".`, true);
	}

	// With a search filter the footer is dropped: printing the unfiltered current
	// selection under a filtered list reads as a row that failed to match.
	const current = search === undefined ? selects.find((select) => select.id === "model")?.currentValue : undefined;
	const header = count === 1 ? "1 model available:" : `${count} models available:`;
	// The current selection is shown in the printable spelling, not as the
	// opaque ACP value: `--model m:…` on print is rejected, so printing the
	// opaque form here would hand the caller something it cannot use.
	const currentTarget = current === undefined ? null : decodeAcpModelValue(current);
	const footer =
		currentTarget === null
			? ""
			: `\n\ncurrent: ${formatModelRef(currentTarget)}\nPass one of these as \`model\`. On the acp transport it is resolved to the advertised value automatically.`;
	return toolResult(`${header}\n\n${lines.join("\n")}${footer}`);
}

export async function callMcodeContext(input: Record<string, unknown>, ctx: CallContext): Promise<ToolResult> {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return toolResult("mcode_context: `session` is required.", true);
	}

	// The session's own account, not the server's: session/load under a different
	// profile either fails or reports another account's budget.
	let profile: string | null;
	try {
		profile = readExistingProfile(input.profile, "mcode_context", getSession(session));
	} catch (err) {
		return toolResult((err as Error).message, true);
	}

	let report: string;
	try {
		const query = await withSlot(() =>
			withAcpQuery(ctx, process.cwd(), CONTEXT_TIMEOUT_MS, profile, async (acp) => {
				await acp.loadSession(session);
				return (await acp.prompt("/context")).text;
			}),
		);
		report = query.value.trim();
	} catch (err) {
		return toolResult(
			`mcode_context could not read the session's context: ${err instanceof Error ? err.message : String(err)}`,
			true,
		);
	}

	if (report === "") {
		return toolResult(`mcode_context: mcode returned no context report for session ${session}.`, true);
	}
	// A session that has not run yet has no snapshot; say so plainly instead of
	// passing the placeholder line through as if it were a measurement.
	if (/no runtime context snapshot/i.test(report)) {
		return toolResult(
			`Session ${session} has no context snapshot yet — it has not completed a turn. ` +
				"Run a turn with mcode or mcode_reply first, then ask again.",
			true,
		);
	}

	return toolResult(`Context report for session ${session}:\n\n${report}`);
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
		// Each session's transcript lives in its own account's store, so the lookup
		// has to use the profile it was started under — normalised, because the
		// record stores the literal name `default` and that resolves to no suffix at
		// all, not to `~/.minimax-default`.
		//
		// A record whose stored name is unusable degrades to its own row. Throwing
		// here would fail the whole listing, and the listing is how a session id is
		// found in the first place — one corrupt row must not hide the rest.
		let profile: string | null | undefined;
		try {
			profile = profileForCall(undefined, entry.profile);
		} catch {
			return `${statKey(id)}  ${when}  ${entry.cwd}${wire}${model}\n    (unusable stored profile — start a new session instead of resuming this one)`;
		}
		const transcript = findTranscript(id, profile ?? null) ?? "(no transcript on disk)";
		const label = describeProfileLabel(profile);
		// The profile line is noise on the overwhelmingly common default account,
		// so it appears only when it says something the header does not.
		return `${statKey(id)}  ${when}  ${entry.cwd}${wire}${model}${label === "" ? "" : `\n    ${label}`}\n    ${transcript}`;
	});
	if (rows.length === 0) {
		return toolResult("No mcode sessions recorded yet. Start one with the `mcode` tool.");
	}
	return toolResult(`${rows.length} session(s), newest first:\n\n${rows.join("\n")}`);
}

/**
 * Which account a row is on.
 *
 * A record with no stored profile predates profiles, so it resolves to whatever
 * this server defaults to — which is not necessarily the default profile, and
 * saying otherwise would point a reader at the wrong store.
 */
function describeProfileLabel(profile: string | null | undefined): string {
	if (profile === null) return `profile ${DEFAULT_PROFILE_NAME}`;
	if (profile === undefined) {
		const active = serverProfile();
		return active === null
			? `profile ${DEFAULT_PROFILE_NAME} (server default)`
			: `profile ${active} (server default)`;
	}
	return `profile ${profile}`;
}

/**
 * Report the profiles on this machine.
 *
 * A filesystem walk, not a spawn: `mcode profile list` would cost a cold start
 * and would only exist on a build that has profiles at all, and the question —
 * which accounts exist and which is signed in — is answered entirely by what is
 * on disk.
 */
export function callMcodeProfiles(): ToolResult {
	const profiles = listProfiles();
	// Cannot throw: the composition root refuses to serve on a malformed variable.
	const activeName = serverProfile() ?? DEFAULT_PROFILE_NAME;
	const rows = profiles.map((profile) => {
		// Compared exactly, not case-folded: on a case-sensitive filesystem `Work`
		// and `work` are two accounts, and folding here would mark both as the
		// server's default and say which one to use.
		const marker = profile.name === activeName ? "*" : " ";
		const label = profile.name === DEFAULT_PROFILE_NAME ? `${profile.name} (default)` : profile.name;
		return `${marker} ${label}\t${describeProfileState(profile)}\t${profile.dataDir}`;
	});
	const header = `${profiles.length} profile(s); * is this server's default`;
	// A redirected data directory silently overrides every profile's own path, so
	// say so rather than letting a caller reason from a row that is not the truth.
	const override = dataDirIsOverridden()
		? "\n\nMINIMAX_DATA_DIR/MAVIS_DATA_DIR is set, so every profile above resolves to that one " +
			"directory instead of its own; unset it to give profiles separate stores."
		: "";
	return toolResult(`${header}:\n\n${rows.join("\n")}${override}`);
}
