// Changing the context window for exactly one run.
//
// MiniMax Code reads ~/.minimax/config.yaml once per process and keeps the
// parsed result in a module-level cache (`getConfig`/`resetConfig` in
// packages/config/src/config.ts). Only in-process writers call `resetConfig()`,
// and nothing watches the file — so editing the file from outside is invisible
// to a process that is already running, and visible to the next one.
//
// `mcode acp` has no `--config` flag, so the only lever is: patch the file, let
// the freshly spawned process read it, then put the file back.
//
// Two rules make that safe enough to touch a file the user owns:
//
//   1. Never rebuild a line. A line is patched in place: the original
//      indentation, key quoting, and trailing comment all survive, and a new
//      line copies the indentation of its neighbours. Rebuilding produced
//      BAD_INDENT corruption on files that indent by four spaces.
//   2. Never invent a second top-level key. If `minimaxModelContextLimits`
//      exists in any form we do not fully own — a flow map, a scalar, a key
//      with a trailing comment — the edit is refused with an explanation
//      rather than appended, because appending yields a duplicate key and
//      mcode's own parser rejects the file outright.

import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseModelTarget } from "./model-ref.ts";

const CONTEXT_LIMITS_KEY = "minimaxModelContextLimits";
// A crash between patching the config and putting it back would leave the user's
// file holding our value forever, because nothing in the file says who wrote it.
// The sidecar records the intent *before* the patch, so the next run — or the
// next server start — can finish the rollback it could not.
const PENDING_SUFFIX = ".mcode-mcp-context-pending";
const LOCK_SUFFIX = ".mcode-mcp-context-lock";
// A sidecar younger than this, whose owner process is still alive, belongs to a
// run in flight. Another mcode-mcp instance must not "recover" it out from under
// that run: the process has not necessarily read the config yet.
const LIVE_OWNER_TTL_MS = 10 * 60_000;

export class ConfigEditError extends Error {}

class ConfigLockError extends Error {}

// ---------------------------------------------------------------------------
// Cross-process lock.
//
// A Promise chain only serialises calls inside one server process, and there is
// normally more than one: every Claude session brings up its own. Two instances
// patching the same file would capture each other's `previousValue` and leave
// one instance's limit behind forever.
//
// Staleness is judged by whether the owner is alive, never by age. The lock is
// held for the whole of a user turn, which can be many minutes, so an age-based
// reaper would delete live locks and reopen exactly the race this closes.
// ---------------------------------------------------------------------------

/** Advisory only: a real lock would be mkdir, which is atomic; this is close enough. */
async function acquireConfigLock(configPath: string, timeoutMs: number): Promise<() => Promise<void>> {
	const lockPath = `${configPath}${LOCK_SUFFIX}`;
	const token = `${process.pid}:${randomUUID()}`;
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		try {
			const fd = openSync(lockPath, "wx", 0o600);
			writeFileSync(fd, `${token} ${Date.now()}\n`);
			closeSync(fd);
			return async () => {
				// Only the owner may release: if the lock was reaped and retaken
				// while we were working, deleting it now would unlock someone else.
				if (lockOwner(lockPath) === token) {
					try {
						rmSync(lockPath, { force: true });
					} catch {
						// Already gone, or cleaned up after us.
					}
				}
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (!lockOwnerAlive(lockPath)) {
				// The owner is gone. Reaping is best effort: two instances may race
				// to remove the same dead lock, and only one of them wins the
				// recreate, which is exactly the outcome we want.
				try {
					rmSync(lockPath, { force: true });
				} catch {
					// Someone else got there first; just try again.
				}
				continue;
			}
			if (Date.now() > deadline) {
				throw new ConfigLockError(
					`another mcode-mcp is running a context_window turn against ${configPath}, and this ` +
						"one has been waiting for it. Nothing was written. If that run has since finished, " +
						"retry; otherwise use transport: 'print', which needs no shared lock because it " +
						"passes mcode a private --config copy.",
				);
			}
			// Await, never spin: the server's event loop has to keep serving other
			// calls, progress notifications and cancellation while this waits.
			await sleep(Math.min(250, Math.max(20, deadline - Date.now())));
		}
	}
}

function lockOwner(lockPath: string): string | null {
	try {
		return readFileSync(lockPath, "utf8").trim().split(/\s+/)[0] ?? null;
	} catch {
		return null;
	}
}

/** A lock is live while its owning process exists — however long it has held it. */
function lockOwnerAlive(lockPath: string): boolean {
	const owner = lockOwner(lockPath);
	if (owner === null) return false;
	const pid = Number(owner.split(":")[0]);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: it exists, it just belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** True when a sidecar belongs to a run that is still in flight. */
function sidecarIsLive(record: { pid?: unknown; createdAt?: unknown }): boolean {
	if (typeof record.pid !== "number" || typeof record.createdAt !== "number") return false;
	if (Date.now() - record.createdAt > LIVE_OWNER_TTL_MS) return false;
	try {
		process.kill(record.pid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists but belongs to someone else — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Where MiniMax Code keeps its config. Upstream resolves this from a chain of
 * env vars plus git-based auto-detection that is not worth reimplementing here,
 * so the env var is an explicit escape hatch and the common case is the default
 * profile directory. We only ever write to a path that already exists.
 */
export function resolveConfigPath(): string | null {
	const override = process.env.MCODE_MCP_MINIMAX_CONFIG?.trim();
	if (override) return existsSync(override) ? override : null;

	const dataDir = process.env.MINIMAX_DATA_DIR?.trim();
	if (dataDir) {
		const candidate = join(dataDir, "config.yaml");
		return existsSync(candidate) ? candidate : null;
	}

	const candidate = join(homedir(), ".minimax", "config.yaml");
	return existsSync(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Line-level helpers. Everything below is deliberately textual: re-serialising
// the document would reorder keys and drop comments in a file the user owns.
// ---------------------------------------------------------------------------

/**
 * Split into lines *with their own terminator attached*. A config is usually
 * uniform, but normalising every line to one EOL would rewrite a file that
 * mixes them, and the round trip has to be byte-exact. Everything below works
 * on the line body and reattaches the original terminator.
 */
function splitLines(text: string): string[] {
	return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function body(line: string): string {
	return line.replace(/\r?\n$/, "");
}

function eolOf(line: string): string {
	return /\r?\n$/.exec(line)?.[0] ?? "";
}

/** The terminator a newly inserted line should use: its neighbour's. */
function eolNear(lines: string[], at: number): string {
	for (let i = at; i < lines.length; i += 1) {
		const eol = eolOf(lines[i] ?? "");
		if (eol !== "") return eol;
	}
	for (let i = at - 1; i >= 0; i -= 1) {
		const eol = eolOf(lines[i] ?? "");
		if (eol !== "") return eol;
	}
	return "\n";
}

function withBody(line: string, nextBody: string): string {
	return `${nextBody}${eolOf(line)}`;
}

/**
 * Give a line its terminator if it lacks one. Without this, a line inserted
 * after a final line that has no newline would be glued onto it — turning
 * `b: 2` into `b: 2someNewKey:` and making the key unparseable.
 */
function ensureTerminated(lines: string[], index: number, eol: string): void {
	const line = lines[index];
	if (line !== undefined && eolOf(line) === "") lines[index] = `${line}${eol}`;
}

function joinLines(lines: string[]): string {
	return lines.join("");
}

/** Index of the first `#` that is not inside quotes, else -1. */
function commentStart(line: string): number {
	let quote: string | null = null;
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];
		if (quote !== null) {
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "#") return i;
	}
	return -1;
}

interface ParsedLine {
	indent: string;
	key: string;
	colon: string;
	value: string;
	trailing: string;
	/** Everything up to and including the space after the colon. */
	prefix: string;
	/** Trailing whitespace plus any comment. */
	suffix: string;
}

const CHILD = /^(\s*)((?:'[^']*'|"[^"]*"|[^:#\s][^:#]*?))(\s*:\s*)([^#]*?)(\s*)$/;

/** Parse `  key: value # comment`, keeping every piece so only `value` is ever replaced. */
function splitKeyValue(line: string): ParsedLine | null {
	const hash = commentStart(line);
	const code = hash === -1 ? line : line.slice(0, hash);
	const match = CHILD.exec(code);
	if (match === null) return null;
	const indent = match[1] ?? "";
	const key = match[2] ?? "";
	const colon = match[3] ?? "";
	const value = match[4] ?? "";
	const trailing = match[5] ?? "";
	return {
		indent,
		key,
		colon,
		value,
		trailing,
		prefix: `${indent}${key}${colon}`,
		suffix: `${trailing}${hash === -1 ? "" : line.slice(hash)}`,
	};
}

function lineValue(line: string): string | null {
	const parsed = splitKeyValue(line);
	return parsed === null ? null : parsed.value.trim();
}

function unquoteYamlKey(raw: string): string {
	const trimmed = raw.trim();
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
		return trimmed.slice(1, -1).replace(/''/g, "'");
	}
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function formatYamlKey(key: string): string {
	return /^[A-Za-z0-9_.-]+$/.test(key) ? key : `'${key.replace(/'/g, "''")}'`;
}

interface KeySite {
	/** Line index of the top-level key, or -1 when it is absent. */
	index: number;
	/** Whatever followed the colon on the key's own line, trimmed. */
	inline: string | null;
	/** Exclusive end of an indented child block, or -1 when there is none. */
	blockEnd: number;
}

function findTopLevelKey(lines: string[], key: string): KeySite {
	const absent: KeySite = { index: -1, inline: null, blockEnd: -1 };
	for (let i = 0; i < lines.length; i += 1) {
		const line = body(lines[i] ?? "");
		if (/^\s/.test(line) || line.trim() === "") continue;
		const hash = commentStart(line);
		const code = hash === -1 ? line : line.slice(0, hash);
		const match = /^([^:#]+):\s*(.*)$/.exec(code);
		if (match === null) continue;
		if (unquoteYamlKey(match[1] ?? "") !== key) continue;
		const inline = (match[2] ?? "").trim();
		if (inline !== "") return { index: i, inline, blockEnd: -1 };
		let end = i + 1;
		for (; end < lines.length; end += 1) {
			const text = body(lines[end] ?? "");
			// A child, a blank line, or a comment: the block continues. A comment
			// at column 0 does not close a YAML block, and treating it as the end
			// would strand every child after it and produce a duplicate key.
			if (/^\s+\S/.test(text) || text.trim() === "" || text.trim().startsWith("#")) continue;
			break;
		}
		while (end > i + 1 && body(lines[end - 1] ?? "").trim() === "") end -= 1;
		return { index: i, inline: null, blockEnd: end };
	}
	return absent;
}

function findChildLine(lines: string[], from: number, to: number, key: string): number {
	for (let i = from + 1; i < to; i += 1) {
		const line = body(lines[i] ?? "");
		if (!/^\s+\S/.test(line) || line.trim().startsWith("#")) continue;
		const parts = splitKeyValue(line);
		if (parts === null) continue;
		if (unquoteYamlKey(parts.key) === key) return i;
	}
	return -1;
}

function childIndent(lines: string[], from: number, to: number): string {
	for (let i = from + 1; i < to; i += 1) {
		const line = body(lines[i] ?? "");
		if (/^\s+\S/.test(line) && !line.trim().startsWith("#")) {
			const parts = splitKeyValue(line);
			if (parts !== null) return parts.indent === "" ? "  " : parts.indent;
		}
	}
	return "  ";
}

/**
 * Why an edit was refused, phrased for a person looking at their config.
 * The inline forms are the ones mcode itself never writes, but a hand-edited
 * file can easily contain them.
 */
function refuseInline(form: string): ConfigEditError {
	return new ConfigEditError(
		`${CONTEXT_LIMITS_KEY} is written as ${form}, not as an indented block of ` +
			`"${CONTEXT_LIMITS_KEY}:" followed by "  <modelId>: <tokens>" lines. ` +
			"This server only edits the block form, because appending to any other form " +
			"would leave a duplicate key and mcode would refuse to load the file. " +
			"Rewrite it as a block, or use transport: 'print', which takes a private --config copy.",
	);
}

export interface ContextLimitEdit {
	text: string;
	/** What the entry held before, or null when it did not exist. */
	previousValue: string | null;
	/** The value we put there, used to recognise our own write on restore. */
	writtenValue: string;
	/** True when we created the whole `minimaxModelContextLimits:` block. */
	addedBlock: boolean;
	/**
	 * True when appending required us to give the file's last real line a
	 * terminator it did not have. Restore removes it again, otherwise the file
	 * would come back with one more byte than it started with.
	 */
	terminatedAnchor?: boolean;
}

export function setContextLimit(text: string, modelId: string, value: number): ContextLimitEdit {
	const lines = splitLines(text);
	const writtenValue = String(value);
	const site = findTopLevelKey(lines, CONTEXT_LIMITS_KEY);

	if (site.index !== -1 && site.inline !== null) {
		const form = site.inline.startsWith("{") ? "an inline flow map" : `an inline value (${site.inline})`;
		throw refuseInline(form);
	}

	if (site.index !== -1) {
		const child = findChildLine(lines, site.index, site.blockEnd, modelId);
		if (child !== -1) {
			const parts = splitKeyValue(body(lines[child] ?? ""));
			if (parts === null) throw refuseInline("a line this server cannot parse safely");
			const previousValue = lineValue(body(lines[child] ?? ""));
			// Patch in place: indentation, key quoting, comment and terminator survive.
			lines[child] = withBody(lines[child] ?? "", `${parts.prefix}${writtenValue}${parts.suffix}`);
			return { text: joinLines(lines), previousValue, writtenValue, addedBlock: false };
		}
		// Match the indentation the block already uses rather than assuming two.
		const indent = childIndent(lines, site.index, site.blockEnd);
		const eol = eolNear(lines, site.index + 1);
		ensureTerminated(lines, site.index, eol);
		lines.splice(site.index + 1, 0, `${indent}${formatYamlKey(modelId)}: ${writtenValue}${eol}`);
		return { text: joinLines(lines), previousValue: null, writtenValue, addedBlock: false };
	}

	// No key at all: append a block *before* the file's trailing blank lines, so
	// they are still there afterwards and the round trip stays byte-exact.
	let end = lines.length;
	while (end > 0 && body(lines[end - 1] ?? "").trim() === "") end -= 1;
	const eol = eolNear(lines, end);
	const terminatedAnchor = end > 0 && eolOf(lines[end - 1] ?? "") === "";
	ensureTerminated(lines, end - 1, eol);
	lines.splice(end, 0, `${CONTEXT_LIMITS_KEY}:${eol}`, `  ${formatYamlKey(modelId)}: ${writtenValue}${eol}`);
	return { text: joinLines(lines), previousValue: null, writtenValue, addedBlock: true, terminatedAnchor };
}

/**
 * Undo a {@link setContextLimit}, but only while the entry still holds the value
 * we wrote. If anything else changed it in the meantime — the TUI writing its
 * own selection, another client, the user — the file is left exactly as it is.
 * Returns `null` when the caller must not write anything back.
 */
export function restoreContextLimit(text: string, modelId: string, edit: ContextLimitEdit): string | null {
	const lines = splitLines(text);
	const site = findTopLevelKey(lines, CONTEXT_LIMITS_KEY);
	if (site.index === -1 || site.inline !== null) return null;

	const child = findChildLine(lines, site.index, site.blockEnd, modelId);
	if (child === -1) return null;
	if (lineValue(body(lines[child] ?? "")) !== edit.writtenValue) return null;

	if (edit.addedBlock) {
		if (site.blockEnd - site.index !== 2) return null;
		// Only drop the terminator we added if nothing was written after our block.
		// A writer appending a key there means that line now depends on our
		// newline, and removing it would glue the two together.
		if (edit.terminatedAnchor && site.index + 2 === lines.length && site.index > 0) {
			const anchor = site.index - 1;
			lines[anchor] = (lines[anchor] ?? "").replace(/\r?\n$/, "");
		}
		lines.splice(site.index, 2);
		return joinLines(lines);
	}

	if (edit.previousValue === null) {
		// Only the entry is ours to remove. The key line belongs to the user —
		// and a `key: # comment` line with an empty block under it is still valid
		// YAML, so it stays exactly as written.
		lines.splice(child, 1);
		return joinLines(lines);
	}

	const parts = splitKeyValue(body(lines[child] ?? ""));
	if (parts === null) return null;
	lines[child] = withBody(lines[child] ?? "", `${parts.prefix}${edit.previousValue}${parts.suffix}`);
	return joinLines(lines);
}

/**
 * The `modelId` of the session's default model, read straight out of the config
 * text. Needed before a context window can be patched: the patch is keyed by
 * model id, and for a run that does not name a model, the default is what the
 * process will pick. `null` when the key is absent or unreadable.
 */
export function readDefaultModelId(text: string): string | null {
	for (const line of text.split(/\r?\n/)) {
		if (/^\s/.test(line) || line.trim() === "") continue;
		const hash = commentStart(line);
		const code = hash === -1 ? line : line.slice(0, hash);
		const match = /^([^:#]+):\s*(.*)$/.exec(code);
		if (match === null || unquoteYamlKey(match[1] ?? "") !== "defaultModel") continue;
		const value = unquoteYamlKey((match[2] ?? "").trim());
		const slash = value.lastIndexOf("/");
		const modelId = slash === -1 ? value : value.slice(slash + 1);
		return modelId === "" ? null : modelId;
	}
	return null;
}

export function contextWindowModelId(model: string | undefined): string | null {
	if (model !== undefined && model !== "") {
		return parseModelTarget(model)?.modelId ?? null;
	}
	const path = resolveConfigPath();
	if (path === null) return null;
	try {
		return readDefaultModelId(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Replace the file's contents without ever leaving it half-written. A crash
 * between truncate and write is the one failure the sidecar cannot repair,
 * because the sidecar holds the patched text, not the original.
 *
 * The write follows the path's real target: a config reached through a symlink
 * is updated in place rather than replaced by a regular file, which is how
 * MiniMax Code's own dotfile setups usually arrange things.
 */
function writeConfigAtomic(path: string, text: string): void {
	let target = path;
	try {
		if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
	} catch {
		// Not a link, or unreadable: the plain path is the right target.
	}
	const dir = dirname(target);
	const tmp = join(dir, `.mcode-mcp-config-${process.pid}.tmp`);
	try {
		writeFileSync(tmp, text, { mode: 0o600 });
		renameSync(tmp, target);
	} catch (err) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// Best effort; the rename never happened so nothing is left to clean.
		}
		throw err;
	}
}

function pendingPath(configPath: string): string {
	return `${configPath}${PENDING_SUFFIX}`;
}

function writePending(configPath: string, modelId: string, edit: ContextLimitEdit): void {
	// The owner is recorded so another instance can tell a crashed run from one
	// that is still in flight, and refuse to roll the latter back.
	writeFileSync(
		pendingPath(configPath),
		JSON.stringify({ modelId, pid: process.pid, createdAt: Date.now(), ...edit }),
		{ mode: 0o600 },
	);
}

function clearPending(configPath: string): void {
	try {
		rmSync(pendingPath(configPath), { force: true });
	} catch {
		// A leftover sidecar is harmless: the next recovery re-checks and no-ops.
	}
}

/**
 * Finish a rollback that a crash interrupted. Safe to call at any time: it only
 * acts when the sidecar exists *and* the entry still holds the value we wrote,
 * so a real user change is never overwritten. Returns a note when it acted.
 */
export function recoverPendingContextEdit(): string | null {
	const configPath = resolveConfigPath();
	if (configPath === null) return null;
	const pending = pendingPath(configPath);
	if (!existsSync(pending)) return null;

	let record: { modelId?: unknown; pid?: unknown; createdAt?: unknown } & Partial<ContextLimitEdit>;
	try {
		record = JSON.parse(readFileSync(pending, "utf8")) as typeof record;
	} catch {
		clearPending(configPath);
		return null;
	}
	if (typeof record.modelId !== "string" || typeof record.writtenValue !== "string") {
		clearPending(configPath);
		return null;
	}

	// A sidecar whose owner is still alive belongs to a run in progress. That run
	// may not have read the config yet, so rolling it back here would silently
	// strip the window the user asked for.
	if (sidecarIsLive(record)) {
		return null;
	}

	const current = readFileSync(configPath, "utf8");
	const rolled = restoreContextLimit(current, record.modelId, {
		text: record.text ?? current,
		previousValue: typeof record.previousValue === "string" ? record.previousValue : null,
		writtenValue: record.writtenValue,
		addedBlock: record.addedBlock === true,
		// Without this, a crash between the append and the rollback leaves the
		// one extra byte we had to add to the anchor line.
		terminatedAnchor: record.terminatedAnchor === true,
	});
	// `null` here means the entry no longer holds our value: someone else owns it
	// now, so saying we "rolled back" would be a lie.
	if (rolled === null) {
		clearPending(configPath);
		return (
			`${record.modelId}: an unclosed context_window edit was found, but that entry has since ` +
			"changed. It was left exactly as it is now."
		);
	}
	if (rolled === current) {
		clearPending(configPath);
		return (
			`${record.modelId}: an unclosed context_window edit was found, and the entry already holds the ` +
			"original value. Nothing was changed."
		);
	}
	writeConfigAtomic(configPath, rolled);
	clearPending(configPath);
	return `rolled back an unclosed context_window edit for ${record.modelId}, left behind by a crash`;
}

export interface ContextWindowRun<T> {
	value: T;
	/** True when our value was still in place and we put the old one back. */
	restored: boolean;
	/** True when something else had already rewritten the entry, so we left it alone. */
	skipped: boolean;
}

// Serialise our own read-modify-write cycles: two overlapping calls must not
// interleave between "write ours" and "spawn the process that reads it".
let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const next = chain.then(fn, fn);
	chain = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

/**
 * Run `fn` with `minimaxModelContextLimits[modelId]` temporarily set to `value`.
 *
 * The window is only in force for processes started *inside* `fn`: MiniMax Code
 * caches the config at startup, so a process spawned before the patch keeps the
 * old value and one spawned after it gets the new one.
 */
export function withContextWindow<T>(
	modelId: string,
	value: number,
	fn: () => Promise<T>,
): Promise<ContextWindowRun<T>> {
	return serialize(async () => {
		const path = resolveConfigPath();
		if (path === null) {
			throw new ConfigEditError(
				"could not locate MiniMax Code's config.yaml, so the context window cannot be set. " +
					"Point MCODE_MCP_MINIMAX_CONFIG at the file's absolute path, or use transport: 'print' " +
					"(which takes --config and never touches your config).",
			);
		}

		// The lock spans the whole edit, not just the write: the `previousValue`
		// captured here has to still be the user's value when the rollback runs,
		// and it is the gap between those two moments that let two server
		// instances capture each other's.
		const release = await acquireConfigLock(path, 5_000);
		try {
			const before = readFileSync(path, "utf8");
			let edit: ContextLimitEdit;
			try {
				edit = setContextLimit(before, modelId, value);
			} catch (err) {
				if (err instanceof ConfigEditError) throw err;
				throw new ConfigEditError(
					`could not edit ${path}: ${err instanceof Error ? err.message : String(err)}. ` + "Nothing was written.",
				);
			}
			if (edit.text === before) {
				return { value: await fn(), restored: true, skipped: false };
			}

			// The intent is recorded first, so a crash on either side of the write is
			// recoverable; only the write itself can be lost, and that is a no-op.
			writePending(path, modelId, edit);
			writeConfigAtomic(path, edit.text);

			return await runHeld(edit, before, path, fn, modelId);
		} finally {
			await release();
		}
	});
}

async function runHeld<T>(
	edit: ContextLimitEdit,
	before: string,
	path: string,
	fn: () => Promise<T>,
	modelId: string,
): Promise<ContextWindowRun<T>> {
	// Restore before resolving: the caller is told whether the file went back,
	// and an error from `fn` must not skip the rollback.
	let outcome: ContextWindowRun<T> | undefined;
	let thrown: unknown;
	try {
		outcome = { value: await fn(), restored: false, skipped: false };
	} catch (err) {
		thrown = err;
	}

	let restored = false;
	let skipped = false;
	try {
		const after = readFileSync(path, "utf8");
		const rolled = restoreContextLimit(after, modelId, edit);
		if (rolled === null) {
			skipped = after !== before;
		} else {
			writeConfigAtomic(path, rolled);
			restored = rolled === before;
		}
	} finally {
		clearPending(path);
	}

	if (outcome !== undefined) return { ...outcome, restored, skipped };
	throw thrown;
}

/**
 * The print transport's route to a context window: `mcode exec --config <path>`
 * reads a whole runtime config for that one process, so a copy of the user's
 * config with one edited entry is enough — and their own file is never touched,
 * which makes this free of the races `withContextWindow` has to guard against.
 */
export async function withTempContextConfig<T>(
	modelId: string,
	value: number,
	fn: (configPath: string) => Promise<T>,
): Promise<T> {
	const source = resolveConfigPath();
	if (source === null) {
		throw new ConfigEditError(
			"could not locate MiniMax Code's config.yaml, so a copy of it cannot be made for --config. " +
				"Point MCODE_MCP_MINIMAX_CONFIG at the file's absolute path.",
		);
	}

	const edit = setContextLimit(readFileSync(source, "utf8"), modelId, value);
	const dir = mkdtempSync(join(tmpdir(), "mcode-mcp-config-"));
	const configPath = join(dir, "config.yaml");
	try {
		// MiniMax Code refuses to start on a group/world-writable config, and a
		// fresh mkdtemp is already 0700, so the source's mode is copied across.
		writeFileSync(configPath, edit.text, { mode: statSync(source).mode & 0o777 });
		return await fn(configPath);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
