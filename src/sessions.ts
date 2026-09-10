// MiniMax Code owns the conversation on disk (`--session` / ACP session/load);
// this only remembers which directory a session belongs to, so `mcode_reply`
// resumes in the right project.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_SESSIONS, STATE_FILE } from "./config.ts";
import { asRecord } from "./parse.ts";
import {
	isPermission,
	isSessionMode,
	isSessionTransport,
	type Permission,
	type SessionMode,
	type SessionRecord,
	type SessionTransport,
} from "./types.ts";

const sessions = new Map<string, SessionRecord>();

function readRecord(value: unknown): SessionRecord | null {
	const entry = asRecord(value);
	if (entry === null || typeof entry.cwd !== "string") return null;
	const record: SessionRecord = {
		cwd: entry.cwd,
		lastAccessed: typeof entry.lastAccessed === "number" ? entry.lastAccessed : 0,
	};
	if (typeof entry.model === "string") record.model = entry.model;
	if (isPermission(entry.permission)) record.permission = entry.permission;
	if (isSessionMode(entry.mode)) record.mode = entry.mode;
	if (typeof entry.thinking_effort === "string") record.thinking_effort = entry.thinking_effort;
	if (isSessionTransport(entry.transport)) record.transport = entry.transport;
	return record;
}

function readStateFile(): Map<string, SessionRecord> {
	const found = new Map<string, SessionRecord>();
	try {
		const parsed = asRecord(JSON.parse(readFileSync(STATE_FILE, "utf8")));
		if (parsed?.version !== 1) return found;
		const stored = asRecord(parsed.sessions);
		if (stored === null) return found;
		for (const [id, value] of Object.entries(stored)) {
			const record = readRecord(value);
			if (record !== null) found.set(id, record);
		}
	} catch {
		// No state yet, or it is unreadable — start empty rather than fail.
	}
	return found;
}

export function loadSessions(): void {
	sessions.clear();
	for (const [id, record] of readStateFile()) sessions.set(id, record);
	prune();
}

function prune(): void {
	if (sessions.size <= MAX_SESSIONS) return;
	const ordered = [...sessions.entries()].sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
	for (const [id] of ordered.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
}

function save(): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		const merged = readStateFile();
		for (const [id, record] of sessions) merged.set(id, record);

		const ordered = [...merged.entries()].sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);
		const payload = { version: 1, sessions: Object.fromEntries(ordered.slice(0, MAX_SESSIONS)) };
		const tmp = `${STATE_FILE}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
		renameSync(tmp, STATE_FILE);
	} catch (err) {
		process.stderr.write(`mcode-mcp: could not persist sessions: ${(err as Error).message}\n`);
	}
}

export function getSession(id: string): SessionRecord | undefined {
	return sessions.get(id);
}

export function listSessions(): [string, SessionRecord][] {
	return [...sessions.entries()].sort((a, b) => b[1].lastAccessed - a[1].lastAccessed);
}

export interface RememberOptions {
	model?: string | undefined;
	permission?: Permission | undefined;
	mode?: SessionMode | undefined;
	thinking_effort?: string | undefined;
	transport?: SessionTransport | undefined;
}

export function rememberSession(id: string, cwd: string, extra: RememberOptions = {}): void {
	const prev = sessions.get(id);
	const next: SessionRecord = { ...prev, cwd, lastAccessed: Date.now() };
	if (extra.model !== undefined) next.model = extra.model;
	if (extra.permission !== undefined) next.permission = extra.permission;
	if (extra.mode !== undefined) next.mode = extra.mode;
	if (extra.thinking_effort !== undefined) next.thinking_effort = extra.thinking_effort;
	if (extra.transport !== undefined) next.transport = extra.transport;
	sessions.set(id, next);
	prune();
	save();
}

const sessionLocks = new Map<string, { tail: Promise<unknown> }>();

export async function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
	const previous = sessionLocks.get(id)?.tail ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const handle = { tail: previous.then(() => current) };
	sessionLocks.set(id, handle);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		void Promise.resolve().then(() => {
			if (sessionLocks.get(id) === handle) sessionLocks.delete(id);
		});
	}
}

export function lockCount(): number {
	return sessionLocks.size;
}
