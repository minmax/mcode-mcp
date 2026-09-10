// Read-only snapshot of a MiniMax Code session from its native messages.jsonl.
//
// Layout: <dataDir>/v2/sessions/YYYY/MM/DD/<time>-session_<b64(id)>/messages.jsonl
// Thinking (`type: thinking`) and image binaries are omitted. This module never
// talks to a live mcode process and never takes the session lock. State is
// `active` only while this process has a live ACP run; otherwise `unknown`.

import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { asRecord } from "./parse.ts";
import { getSession } from "./sessions.ts";
import { expectedTranscript, findTranscript, statKey, storeRoot } from "./transcript.ts";
import { getRun } from "./transport/registry.ts";

export const HISTORY_DEFAULT_LIMIT = 50;
export const HISTORY_MAX_LIMIT = 200;
export const HISTORY_DEFAULT_MAX_CHARS = 4_000;
export const HISTORY_MAX_MAX_CHARS = 16_000;
export const HISTORY_MAX_RESPONSE_CHARS = 100_000;
export const HISTORY_MAX_SCAN_BYTES = 2_000_000;
export const HISTORY_MAX_LINE_BYTES = 1_000_000;

const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$/;
const FORBIDDEN = new Set([
	"thinking",
	"thinkingSignature",
	"thought",
	"encrypted_content",
	"encryptedContent",
	"reasoning",
	"reasoning_content",
]);

export interface HistoryItem {
	id: string;
	role: "user" | "assistant" | "tool" | "gap";
	name?: string;
	text: string;
	truncated?: boolean;
}

export interface HistoryPage {
	session: string;
	session_key: string;
	cwd: string;
	state: "active" | "unknown";
	source: "native";
	transcript: string | null;
	items: HistoryItem[];
	cursor: string;
	has_more: boolean;
	truncated_tail: boolean;
	gaps: number;
	omitted: string[];
	notes: string[];
	limits: { limit: number; max_chars: number; max_response_chars: number };
}

interface Cursor {
	v: 1;
	s: string;
	p: string;
	b: number;
	i: string;
	g: string;
}

export interface HistoryArgs {
	session: string;
	cursor?: string;
	limit: number;
	maxChars: number;
	includeTools: boolean;
}

type NativeEvent =
	| { kind: "skip" }
	| { kind: "omit"; tag: string }
	| { kind: "gap"; reason: string }
	| { kind: "item"; item: HistoryItem };

export function parseHistoryArgs(input: Record<string, unknown>, tool: string): HistoryArgs | { error: string } {
	const session = input.session;
	if (typeof session !== "string" || session.trim() === "") {
		return { error: `${tool}: \`session\` is required.` };
	}
	if (!SESSION_ID_RE.test(session) || session.includes("..") || session.includes(sep)) {
		return { error: `${tool}: \`session\` is not a valid session id.` };
	}
	if (input.cursor !== undefined && input.cursor !== null && typeof input.cursor !== "string") {
		return { error: `${tool}: \`cursor\` must be a string.` };
	}
	const limit = readBound(input.limit, HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, "limit", tool);
	if (typeof limit !== "number") return limit;
	const maxChars = readBound(input.max_chars, HISTORY_DEFAULT_MAX_CHARS, HISTORY_MAX_MAX_CHARS, "max_chars", tool);
	if (typeof maxChars !== "number") return maxChars;
	if (input.include_tools !== undefined && input.include_tools !== null && typeof input.include_tools !== "boolean") {
		return { error: `${tool}: \`include_tools\` must be a boolean.` };
	}
	const args: HistoryArgs = { session, limit, maxChars, includeTools: input.include_tools !== false };
	if (typeof input.cursor === "string" && input.cursor !== "") args.cursor = input.cursor;
	return args;
}

function readBound(
	value: unknown,
	fallback: number,
	max: number,
	name: string,
	tool: string,
): number | { error: string } {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		return { error: `${tool}: \`${name}\` must be a positive integer.` };
	}
	return Math.min(value, max);
}

export function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(raw: string, session: string): Cursor | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		return { error: "invalid cursor" };
	}
	const rec = asRecord(parsed);
	if (rec === null || rec.v !== 1 || typeof rec.s !== "string" || typeof rec.p !== "string") {
		return { error: "invalid cursor" };
	}
	if (typeof rec.b !== "number" || !Number.isInteger(rec.b) || rec.b < 0) return { error: "invalid cursor" };
	if (typeof rec.i !== "string" || typeof rec.g !== "string") return { error: "invalid cursor" };
	if (rec.s !== session) return { error: "cursor belongs to a different session" };
	return { v: 1, s: rec.s, p: rec.p, b: rec.b, i: rec.i, g: rec.g };
}

function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}

function fingerprintFirstLine(fd: number): string {
	const buf = Buffer.alloc(4096);
	const n = readSync(fd, buf, 0, buf.length, 0);
	if (n <= 0) return "";
	const slice = buf.subarray(0, n);
	const nl = slice.indexOf(0x0a);
	const line = nl === -1 ? slice : slice.subarray(0, nl);
	if (line.length === 0) return "";
	return createHash("sha256").update(line).digest("hex").slice(0, 16);
}

function contained(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function resolveStorePath(store: string, file: string): string | { error: string } {
	let root: string;
	try {
		root = realpathSync(store);
	} catch {
		root = resolve(store);
	}
	let target: string;
	try {
		target = realpathSync(file);
	} catch {
		target = resolve(file);
	}
	if (!contained(root, target)) return { error: "transcript path is outside the session store" };
	return target;
}

function visibleStringify(value: unknown, budget: number): string {
	const seen = new WeakSet<object>();
	const walk = (node: unknown): unknown => {
		if (node === null || typeof node !== "object") return node;
		if (seen.has(node)) return "[cycle]";
		seen.add(node);
		if (Array.isArray(node)) return node.map(walk);
		const rec = node as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(rec)) {
			if (FORBIDDEN.has(key)) continue;
			out[key] = walk(val);
		}
		return out;
	};
	try {
		const text = JSON.stringify(walk(value));
		return text === undefined ? "" : text.length <= budget ? text : `${text.slice(0, budget)}…`;
	} catch {
		return "";
	}
}

function blockText(block: Record<string, unknown>): {
	omit?: string;
	text?: string;
	tool?: { name: string; text: string };
} {
	const type = block.type;
	if (type === "thinking" || type === "thought" || type === "reasoning") {
		return { omit: "thought" };
	}
	if (type === "image") return { omit: "image" };
	if (type === "text" && typeof block.text === "string") return { text: block.text };
	if (type === "toolCall") {
		const name = typeof block.name === "string" ? block.name : "tool";
		return { tool: { name, text: `call ${visibleStringify(block.arguments ?? {}, 2_000)}` } };
	}
	return {};
}

export function parseMcodeLine(raw: unknown): NativeEvent[] {
	const rec = asRecord(raw);
	if (rec === null) return [{ kind: "gap", reason: "malformed jsonl line" }];
	const message = asRecord(rec.message) ?? rec;
	const role = message.role;
	const content = message.content;
	const events: NativeEvent[] = [];
	const texts: string[] = [];
	if (Array.isArray(content)) {
		for (const entry of content) {
			const block = asRecord(entry);
			if (block === null) continue;
			const parsed = blockText(block);
			if (parsed.omit) events.push({ kind: "omit", tag: parsed.omit });
			if (parsed.text) texts.push(parsed.text);
			if (parsed.tool)
				events.push({
					kind: "item",
					item: { id: "", role: "tool", name: parsed.tool.name, text: parsed.tool.text },
				});
		}
	} else if (typeof content === "string") {
		texts.push(content);
	}
	if (role === "user") {
		const text = texts.join("");
		if (text) events.unshift({ kind: "item", item: { id: "", role: "user", text } });
		return events.length ? events : [{ kind: "skip" }];
	}
	if (role === "assistant") {
		const text = texts.join("");
		if (text) events.unshift({ kind: "item", item: { id: "", role: "assistant", text } });
		return events.length ? events : [{ kind: "skip" }];
	}
	if (role === "toolResult") {
		const name = typeof message.toolName === "string" ? message.toolName : "tool";
		const text = texts.join("") || visibleStringify(content, 2_000);
		events.push({ kind: "item", item: { id: "", role: "tool", name, text: text ? `result ${text}` : "result" } });
		return events;
	}
	if (role === "custom" || role === "compactionSummary") {
		events.push({ kind: "omit", tag: String(role) });
		return events;
	}
	return [{ kind: "skip" }];
}

interface JsonlLine {
	start: number;
	end: number;
	buf: Buffer;
}

function readCompleteLines(
	fd: number,
	from: number,
	maxScan: number,
): { lines: JsonlLine[]; next: number; truncatedTail: boolean; eof: boolean } {
	const lines: JsonlLine[] = [];
	let pos = from;
	let leftover = Buffer.alloc(0);
	let leftoverStart = from;
	let scanned = 0;
	let eof = false;
	const chunkSize = 64 * 1024;
	while (scanned < maxScan) {
		const want = Math.min(chunkSize, maxScan - scanned);
		const buf = Buffer.alloc(want);
		const n = readSync(fd, buf, 0, want, pos);
		if (n === 0) {
			eof = true;
			break;
		}
		pos += n;
		scanned += n;
		const data = leftover.length === 0 ? buf.subarray(0, n) : Buffer.concat([leftover, buf.subarray(0, n)]);
		let start = 0;
		for (let i = 0; i < data.length; i++) {
			if (data[i] !== 0x0a) continue;
			const raw = data.subarray(start, i);
			const line = raw.length > 0 && raw[raw.length - 1] === 0x0d ? raw.subarray(0, raw.length - 1) : raw;
			lines.push({ start: leftoverStart + start, end: leftoverStart + i + 1, buf: line });
			start = i + 1;
		}
		leftover = data.subarray(start);
		leftoverStart += start;
	}
	return { lines, next: leftoverStart, truncatedTail: eof && leftover.length > 0, eof };
}

function originCursor(cursor: Cursor): boolean {
	return cursor.b === 0 && cursor.g === "" && cursor.i === "0";
}

function makeItem(role: HistoryItem["role"], id: string, text: string, maxChars: number, name?: string): HistoryItem {
	const clipped = clip(text, maxChars);
	const item: HistoryItem = { id, role, text: clipped.text };
	if (name !== undefined) item.name = name;
	if (clipped.truncated) item.truncated = true;
	return item;
}

export function readHistoryFile(opts: {
	sessionId: string;
	sessionKey: string;
	cwd: string;
	path: string | null;
	expectedPath: string;
	storeRoot: string;
	live: boolean;
	cursor?: string | undefined;
	limit: number;
	maxChars: number;
	includeTools: boolean;
}): HistoryPage | { error: string } {
	const notes: string[] = [];
	const omitted = new Set<string>();
	const state: HistoryPage["state"] = opts.live ? "active" : "unknown";
	const limits = {
		limit: opts.limit,
		max_chars: opts.maxChars,
		max_response_chars: HISTORY_MAX_RESPONSE_CHARS,
	};

	const emptyPage = (cursor: Cursor, extraNotes: string[], transcript: string | null): HistoryPage => ({
		session: opts.sessionId,
		session_key: opts.sessionKey,
		cwd: opts.cwd,
		state,
		source: "native",
		transcript,
		items: [],
		cursor: encodeCursor(cursor),
		has_more: false,
		truncated_tail: false,
		gaps: 0,
		omitted: [],
		notes: extraNotes,
		limits,
	});

	if (opts.path === null) {
		if (opts.cursor !== undefined) {
			const decoded = decodeCursor(opts.cursor, opts.sessionId);
			if ("error" in decoded) return decoded;
			if (!originCursor(decoded) && decoded.p !== opts.expectedPath) {
				return { error: "transcript replaced or moved; pass no cursor to read the current file from the start" };
			}
		}
		return emptyPage(
			{ v: 1, s: opts.sessionId, p: opts.expectedPath, b: 0, i: "0", g: "" },
			["transcript not written yet"],
			null,
		);
	}

	const resolved = resolveStorePath(opts.storeRoot, opts.path);
	if (typeof resolved !== "string") return resolved;

	let fd: number;
	try {
		fd = openSync(resolved, "r");
	} catch {
		return emptyPage(
			{ v: 1, s: opts.sessionId, p: resolved, b: 0, i: "0", g: "" },
			["transcript is unreadable"],
			null,
		);
	}

	try {
		const st = fstatSync(fd);
		const gen = fingerprintFirstLine(fd);
		const ino = String(st.ino);
		let from = 0;
		if (opts.cursor !== undefined) {
			const decoded = decodeCursor(opts.cursor, opts.sessionId);
			if ("error" in decoded) return decoded;
			if (!originCursor(decoded)) {
				if (decoded.p !== resolved) {
					return { error: "transcript replaced or moved; pass no cursor to read the current file from the start" };
				}
				if (decoded.i !== "0" && decoded.i !== ino) {
					return { error: "transcript file was replaced; pass no cursor to read it from the start" };
				}
				if (decoded.g !== "" && gen !== "" && decoded.g !== gen) {
					return { error: "transcript file was replaced; pass no cursor to read it from the start" };
				}
				if (decoded.b > st.size) {
					return { error: "transcript was truncated; pass no cursor to read it from the start" };
				}
				from = decoded.b;
			}
		}

		const { lines, next, truncatedTail, eof } = readCompleteLines(fd, from, HISTORY_MAX_SCAN_BYTES);
		const items: HistoryItem[] = [];
		let gaps = 0;
		let consumeTo = from;
		let stoppedEarly = false;
		let sawUser = false;
		const fromStart = from === 0;

		const envelopeSize = (pending: HistoryItem[]): number =>
			JSON.stringify({
				session: opts.sessionId,
				session_key: opts.sessionKey,
				cwd: opts.cwd,
				state,
				source: "native",
				transcript: resolved,
				items: pending,
				cursor: "",
				has_more: true,
				truncated_tail: truncatedTail,
				gaps,
				omitted: [...omitted],
				notes,
				limits,
			}).length;

		const fits = (pending: HistoryItem[]): boolean => envelopeSize(pending) <= HISTORY_MAX_RESPONSE_CHARS;

		const pushAll = (incoming: HistoryItem[]): boolean => {
			if (incoming.some((i) => i.role === "user")) sawUser = true;
			if (items.length >= opts.limit && items.length > 0) return false;
			const nextItems = [...items, ...incoming];
			if (nextItems.length > opts.limit && items.length > 0) return false;
			if (!fits(nextItems)) {
				if (items.length === 0) {
					items.push(...incoming);
					return true;
				}
				return false;
			}
			items.push(...incoming);
			return true;
		};

		for (const line of lines) {
			if (line.buf.length > HISTORY_MAX_LINE_BYTES) {
				gaps += 1;
				if (!pushAll([makeItem("gap", `b${line.start}`, "oversized jsonl line", opts.maxChars)])) {
					stoppedEarly = true;
					break;
				}
				consumeTo = line.end;
				continue;
			}
			const text = line.buf.toString("utf8");
			if (text.trim() === "") {
				consumeTo = line.end;
				continue;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(text);
			} catch {
				gaps += 1;
				if (!pushAll([makeItem("gap", `b${line.start}`, "malformed jsonl line", opts.maxChars)])) {
					stoppedEarly = true;
					break;
				}
				consumeTo = line.end;
				continue;
			}
			const incoming: HistoryItem[] = [];
			for (const event of parseMcodeLine(raw)) {
				if (event.kind === "skip") continue;
				if (event.kind === "omit") {
					omitted.add(event.tag);
					continue;
				}
				if (event.kind === "gap") {
					gaps += 1;
					incoming.push(makeItem("gap", `b${line.start}`, event.reason, opts.maxChars));
					continue;
				}
				if (event.item.role === "tool" && !opts.includeTools) continue;
				incoming.push(makeItem(event.item.role, `b${line.start}`, event.item.text, opts.maxChars, event.item.name));
			}
			if (incoming.length === 0) {
				consumeTo = line.end;
				continue;
			}
			if (!pushAll(incoming)) {
				stoppedEarly = true;
				break;
			}
			consumeTo = line.end;
		}

		const hasMore = stoppedEarly || !eof || consumeTo < next;
		if (fromStart && eof && !hasMore && !truncatedTail && !sawUser) {
			notes.push("transcript had no user message in this snapshot");
		}

		const cursor: Cursor = { v: 1, s: opts.sessionId, p: resolved, b: consumeTo, i: ino, g: gen };
		return {
			session: opts.sessionId,
			session_key: opts.sessionKey,
			cwd: opts.cwd,
			state,
			source: "native",
			transcript: resolved,
			items,
			cursor: encodeCursor(cursor),
			has_more: hasMore,
			truncated_tail: truncatedTail,
			gaps,
			omitted: [...omitted],
			notes,
			limits,
		};
	} finally {
		closeSync(fd);
	}
}

export function readMcodeHistory(input: Record<string, unknown>): HistoryPage | { error: string } {
	const args = parseHistoryArgs(input, "mcode_history");
	if ("error" in args) return args;
	const known = getSession(args.session);
	if (known === undefined) {
		return {
			error: `mcode_history: unknown session ${args.session}. Use mcode_sessions to list sessions started through this server.`,
		};
	}
	const live = getRun(args.session) !== undefined;
	const found = findTranscript(args.session);
	return readHistoryFile({
		sessionId: args.session,
		sessionKey: statKey(args.session),
		cwd: known.cwd,
		path: found,
		expectedPath: expectedTranscript(args.session),
		storeRoot: storeRoot(),
		live,
		cursor: args.cursor,
		limit: args.limit,
		maxChars: args.maxChars,
		includeTools: args.includeTools,
	});
}
