// MiniMax Code wire shapes for `mcode exec --output-format stream-json` and ACP.
// There is no published SDK to `import type` from at runtime, so these types
// describe what the installed CLI (0.3.11) actually emits. Everything arriving
// from the mcode process is still untrusted JSON: parse.ts verifies each value
// before it is used as one of them.

/** Internal event shape shared by both transports, fed to the accumulator. */
export interface McodeEvent {
	type: string;
	subtype?: string;
	session_id?: string;
	model?: string;
	message?: {
		role?: string;
		model?: string;
		content?: unknown;
	};
	result?: string;
	is_error?: boolean;
	duration_ms?: number;
	num_turns?: number;
	usage?: McodeUsage;
	error?: { message?: string };
}

export interface McodeUsage {
	input_tokens?: number;
	output_tokens?: number;
}

export interface McodeContentBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

export interface McodeToolUseBlock {
	type: "tool_use";
	id?: string;
	name: string;
	input?: unknown;
}

export const RESULT_OK = ["success"] as const;
export const RESULT_BAD = ["error_max_turns", "error_during_execution"] as const;

export type ResultOk = (typeof RESULT_OK)[number];
export type ResultBad = (typeof RESULT_BAD)[number];

const RESULT_OK_SET: ReadonlySet<string> = new Set(RESULT_OK);
const RESULT_BAD_SET: ReadonlySet<string> = new Set(RESULT_BAD);

export function isResultOk(subtype: string): subtype is ResultOk {
	return RESULT_OK_SET.has(subtype);
}

export function isResultBad(subtype: string): subtype is ResultBad {
	return RESULT_BAD_SET.has(subtype);
}

/** Headless `--permission`. ACP maps smart→auto, full→bypassPermissions; off is exec-only. */
export const PERMISSIONS = ["smart", "full", "off"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: unknown): value is Permission {
	return typeof value === "string" && (PERMISSIONS as readonly string[]).includes(value);
}

/** ACP `session/set_mode` ids advertised by MiniMax Code 0.3.11. */
export const SESSION_MODES = ["default", "plan"] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export function isSessionMode(value: unknown): value is SessionMode {
	return typeof value === "string" && (SESSION_MODES as readonly string[]).includes(value);
}

export interface RunOverrides {
	model?: string;
	permission?: Permission;
	mode?: SessionMode;
	thinking_effort?: string;
	/**
	 * Context window for this run, in tokens (the catalog advertises 512000 and
	 * 1000000 for M3 / M3.1). Neither `mcode exec` nor `mcode acp` exposes this as
	 * a flag or a config option, so it is applied by other means — see
	 * minimax-config.ts. The values are therefore not validated against a fixed
	 * enum: a model that gains a third option tomorrow should still work.
	 */
	context_window?: number;
	add_dirs?: string[];
}

/** Which wire the session last used. Stored so reply/send hints match the run, not the server default. */
export const SESSION_TRANSPORTS = ["acp", "print"] as const;
export type SessionTransport = (typeof SESSION_TRANSPORTS)[number];

export function isSessionTransport(value: unknown): value is SessionTransport {
	return typeof value === "string" && (SESSION_TRANSPORTS as readonly string[]).includes(value);
}

export interface SessionRecord {
	cwd: string;
	lastAccessed: number;
	model?: string;
	permission?: Permission;
	mode?: SessionMode;
	thinking_effort?: string;
	transport?: SessionTransport;
	/**
	 * Named auth profile the session was started under, absent for the default one.
	 * A session id only names a conversation inside one account's store, so this
	 * is what makes `mcode_reply`, `mcode_history` and the transcript column of
	 * `mcode_sessions` look in the right place.
	 */
	profile?: string;
}

export type JsonRpcId = string | number | null;

export interface JsonRpcMessage {
	jsonrpc?: unknown;
	id?: JsonRpcId;
	method?: unknown;
	params?: Record<string, unknown>;
}

export interface ToolTextContent {
	type: "text";
	text: string;
}

export interface ToolResult {
	content: ToolTextContent[];
	isError?: boolean;
}

export interface ToolAnnotations {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: boolean;
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: ToolAnnotations;
}

export interface CancelToken {
	readonly cancelled: boolean;
	subscribe(fn: () => void): () => void;
	cancel(): void;
}

export interface CallContext {
	token: CancelToken;
	progress?: (message: string) => void;
}
