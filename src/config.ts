import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPermission, type Permission } from "./types.ts";

function numEnv(name: string, fallback: number, min: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min) {
		process.stderr.write(`mcode-mcp: ignoring invalid ${name}=${raw}, using ${fallback}\n`);
		return fallback;
	}
	return value;
}

/** Like numEnv, but an absent variable means "no limit" rather than a number. */
function numEnvOrUndefined(name: string, min: number): number | undefined {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < min) {
		process.stderr.write(`mcode-mcp: ignoring invalid ${name}=${raw}, using no limit\n`);
		return undefined;
	}
	return value;
}

export const MCODE_BIN = process.env.MCODE_MCP_BIN ?? "mcode";

/**
 * Optional command prefix, e.g. MCODE_MCP_WRAP="/path/to/node-22.22/bin/node".
 * Lets you pick the Node that matches MiniMax Code's native SQLite ABI without
 * this server knowing anything about installers.
 */
export const MCODE_WRAP = (process.env.MCODE_MCP_WRAP ?? "").trim();

export const TIMEOUT_MS = numEnvOrUndefined("MCODE_MCP_TIMEOUT_MS", 1_000);
export const MAX_TIMEOUT_MS = numEnv("MCODE_MCP_MAX_TIMEOUT_MS", 86_400_000, 1_000);
export const KILL_GRACE_MS = numEnv("MCODE_MCP_KILL_GRACE_MS", 5_000, 0);
export const INTERRUPT_GRACE_MS = numEnv("MCODE_MCP_INTERRUPT_GRACE_MS", 5_000, 0);
// A cold `mcode acp` start on this machine measured 3.6-21.8s for the
// initialize handshake alone, against a 15s default that failed repeatedly.
// The run path keeps 60s: a dead process there should not hang the call, and
// the caller's own timeout_ms already bounds the run as a whole.
export const INIT_TIMEOUT_MS = numEnv("MCODE_MCP_INIT_TIMEOUT_MS", 60_000, 1_000);
// The two read-only tools spawn a process that does nothing but a cold start
// and one query, and nothing else bounds them, so they can afford a far wider
// margin: a false failure here is pure noise with no work lost. 120s is ~5x the
// worst handshake seen, and still bounded.
export const MODELS_TIMEOUT_MS = numEnv("MCODE_MCP_MODELS_TIMEOUT_MS", 120_000, 1_000);
export const CONTEXT_TIMEOUT_MS = numEnv("MCODE_MCP_CONTEXT_TIMEOUT_MS", 120_000, 1_000);

export const MAX_OUTPUT = process.env.MCODE_MCP_MAX_OUTPUT
	? numEnv("MCODE_MCP_MAX_OUTPUT", 4_000_000, 1_000)
	: Number.POSITIVE_INFINITY;

export const STDERR_LIMIT = numEnv("MCODE_MCP_STDERR_LIMIT", 1_500, 200);
export const KEEP_STDERR_EVENTS = process.env.MCODE_MCP_STDERR_KEEP_EVENTS === "1";
export const MAX_CAPTURE = numEnv("MCODE_MCP_MAX_CAPTURE", 16_000_000, 100_000);
export const MAX_LINE = numEnv("MCODE_MCP_MAX_LINE", 8_000_000, 100_000);
export const MAX_FRAME = numEnv("MCODE_MCP_MAX_FRAME", 8_000_000, 100_000);
export const MAX_SESSIONS = numEnv("MCODE_MCP_MAX_SESSIONS", 1_000, 1);
export const MAX_CONCURRENT = numEnv("MCODE_MCP_MAX_CONCURRENT", 100, 1);

export const STATE_FILE =
	process.env.MCODE_MCP_STATE ?? join(homedir(), ".local", "state", "mcode-mcp", "sessions.json");
export const DEFAULT_MODEL = process.env.MCODE_MCP_MODEL ?? null;

function defaultPermission(): Permission {
	const raw = process.env.MCODE_MCP_PERMISSION;
	if (raw === undefined || raw === "") return "full";
	if (!isPermission(raw)) {
		process.stderr.write(`mcode-mcp: ignoring invalid MCODE_MCP_PERMISSION=${raw}, using full\n`);
		return "full";
	}
	return raw;
}
export const DEFAULT_PERMISSION: Permission = defaultPermission();

export const DEFAULT_TRANSPORT = process.env.MCODE_MCP_TRANSPORT === "print" ? "print" : "acp";
export const MAX_PROMPT = 2_000_000;

function readVersion(): string {
	try {
		const manifest = readFileSync(new URL("../package.json", import.meta.url), "utf8");
		const version = (JSON.parse(manifest) as { version?: unknown }).version;
		if (typeof version === "string") return version;
	} catch {
		// Unreadable manifest is not worth failing a handshake over.
	}
	return "0.0.0";
}

export const SERVER_INFO = { name: "mcode", version: readVersion() } as const;
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const FALLBACK_PROTOCOL = "2025-06-18";
