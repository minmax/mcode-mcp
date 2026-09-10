// Turning mcode's message stream into the one thing the caller wants — the
// answer — plus aggregate stats. Nothing else from the transcript leaves this
// module.

import { KEEP_STDERR_EVENTS, MAX_OUTPUT, STDERR_LIMIT } from "./config.ts";
import type { RunResult } from "./mcode-process.ts";
import { asMcodeEvent, readAssistantMessage, readResultMessage, readSystemModel } from "./parse.ts";

const WRITE_TOOLS: ReadonlySet<string> = new Set([
	"Write",
	"Edit",
	"StrReplace",
	"search_replace",
	"apply_patch",
	"write_file",
	"edit",
	"replace",
]);

export interface Accumulator {
	assistantTexts: string[];
	toolCalls: string[];
	writtenFiles: string[];
	model: string | null;
	usage: { input: number; output: number };
	result:
		| {
				kind: "ok";
				text: string;
				usage: { input: number; output: number };
				numTurns: number;
				durationMs: number;
		  }
		| {
				kind: "bad";
				subtype: string;
				message: string;
				usage: { input: number; output: number };
				numTurns: number;
				durationMs: number;
		  }
		| { kind: "unknown"; subtype: string }
		| null;
	counts: Map<string, number>;
	capturedBytes: number;
}

export function newAccumulator(): Accumulator {
	return {
		assistantTexts: [],
		toolCalls: [],
		writtenFiles: [],
		model: null,
		usage: { input: 0, output: 0 },
		result: null,
		counts: new Map(),
		capturedBytes: 0,
	};
}

export function accumulate(acc: Accumulator, raw: unknown): string | null {
	const message = asMcodeEvent(raw);
	if (message === null) return null;

	acc.counts.set(message.type, (acc.counts.get(message.type) ?? 0) + 1);

	switch (message.type) {
		case "system": {
			const model = readSystemModel(message);
			if (model && acc.model === null) acc.model = model;
			return null;
		}

		case "assistant": {
			const parsed = readAssistantMessage(message);
			if (parsed === null) return null;

			if (parsed.model) {
				acc.model = parsed.model;
			}
			acc.usage.input += parsed.usage.input;
			acc.usage.output += parsed.usage.output;
			if (parsed.text) acc.assistantTexts.push(parsed.text);

			for (const call of parsed.toolCalls) {
				acc.toolCalls.push(call.name);
				if (call.path !== undefined && WRITE_TOOLS.has(call.name) && !acc.writtenFiles.includes(call.path)) {
					acc.writtenFiles.push(call.path);
				}
			}
			return acc.toolCalls.length > 0 ? `running ${acc.toolCalls[acc.toolCalls.length - 1]}` : null;
		}

		case "result": {
			const parsed = readResultMessage(message);
			if (parsed === null) return null;
			acc.result = parsed;
			if (parsed.kind !== "unknown") {
				acc.usage.input = Math.max(acc.usage.input, parsed.usage.input);
				acc.usage.output = Math.max(acc.usage.output, parsed.usage.output);
			}
			return null;
		}

		default:
			return null;
	}
}

export type AnswerSource = "result" | "result-error" | "broken" | "cut-off" | "none";

export interface SelectedAnswer {
	text: string | null;
	source: AnswerSource;
}

export function selectAnswer(acc: Accumulator): SelectedAnswer {
	const result = acc.result;
	if (result?.kind === "ok") return { text: result.text || null, source: "result" };
	if (result?.kind === "bad") return { text: result.message, source: "result-error" };
	if (result?.kind === "unknown") return { text: null, source: "broken" };

	const lastText = acc.assistantTexts[acc.assistantTexts.length - 1];
	if (lastText !== undefined) return { text: lastText, source: "cut-off" };
	return { text: null, source: "none" };
}

export function answerProblem(answer: SelectedAnswer, acc: Accumulator): string | null {
	switch (answer.source) {
		case "result":
			return null;
		case "result-error":
			return `mcode ended with ${acc.result?.kind === "bad" ? acc.result.subtype : "an error"} instead of an answer`;
		case "broken":
			return `mcode returned an unrecognized result subtype=${acc.result?.kind === "unknown" ? acc.result.subtype : "?"}`;
		case "cut-off":
			return "mcode produced no result envelope — returning the last text it produced";
		case "none":
			return "mcode produced no result envelope and no assistant text";
	}
}

export function describeBrokenRun(acc: Accumulator): string {
	const counts = [...acc.counts].map(([type, count]) => `${type}×${count}`).join(", ");
	return `mcode messages seen: ${counts || "none"}, raw stdout: ${acc.capturedBytes} chars`;
}

export function clip(text: string): string {
	if (!Number.isFinite(MAX_OUTPUT) || text.length <= MAX_OUTPUT) return text;
	return `${text.slice(0, MAX_OUTPUT)}\n\n[mcode-mcp: truncated at ${MAX_OUTPUT} of ${text.length} chars]`;
}

function scanStderr(stderr: string): { diagnostics: string[]; messages: Map<string, number> } {
	const diagnostics: string[] = [];
	const messages = new Map<string, number>();

	for (const raw of stderr.split("\n")) {
		const line = raw.trim();
		if (!line) continue;

		if (!KEEP_STDERR_EVENTS) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				diagnostics.push(raw);
				continue;
			}
			const rec =
				typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
					? (parsed as { type?: unknown; role?: unknown; jsonrpc?: unknown; method?: unknown })
					: undefined;
			const type =
				typeof rec?.type === "string"
					? rec.type
					: typeof rec?.role === "string"
						? rec.role
						: typeof rec?.method === "string"
							? rec.method
							: rec?.jsonrpc !== undefined
								? "jsonrpc"
								: undefined;
			if (typeof type === "string") {
				messages.set(type, (messages.get(type) ?? 0) + 1);
				continue;
			}
			diagnostics.push(raw);
			continue;
		}

		diagnostics.push(raw);
	}

	return { diagnostics, messages };
}

export function tailStderr(stderr: string): string {
	const { diagnostics, messages } = scanStderr(stderr);

	let note = "";
	if (messages.size > 0) {
		const total = [...messages.values()].reduce((sum, n) => sum + n, 0);
		const breakdown = [...messages]
			.sort((a, b) => b[1] - a[1])
			.map(([type, count]) => `${type}×${count}`)
			.join(", ");
		note = `[${total} protocol message line(s) on stderr, suppressed: ${breakdown}]`;
	}

	const text = diagnostics.join("\n").trim();
	if (!text) return note;
	const body = text.length <= STDERR_LIMIT ? text : `[…earlier stderr omitted]\n${text.slice(-STDERR_LIMIT)}`;
	return note ? `${note}\n${body}` : body;
}

function compactTokens(n: number): string {
	if (n < 1000) return String(n);
	return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

export function summarize(acc: Accumulator, elapsedMs: number): string {
	const bits: string[] = [];
	if (acc.model) bits.push(acc.model);

	const result = acc.result;
	const turns = result && result.kind !== "unknown" ? result.numTurns : 0;
	if (turns) bits.push(`${turns} turn${turns === 1 ? "" : "s"}`);

	if (acc.toolCalls.length) {
		const counts = new Map<string, number>();
		for (const name of acc.toolCalls) counts.set(name, (counts.get(name) ?? 0) + 1);
		const ranked = [...counts].sort((a, b) => b[1] - a[1]);
		const shown = ranked.slice(0, 8).map(([n, c]) => (c > 1 ? `${n}×${c}` : n));
		if (ranked.length > 8) shown.push(`+${ranked.length - 8} more`);
		bits.push(`${acc.toolCalls.length} tool call${acc.toolCalls.length === 1 ? "" : "s"}: ${shown.join(", ")}`);
	} else {
		bits.push("no tool calls");
	}

	const usageIn = result && result.kind !== "unknown" ? result.usage.input : acc.usage.input;
	const usageOut = result && result.kind !== "unknown" ? result.usage.output : acc.usage.output;
	if (usageIn || usageOut) bits.push(`${compactTokens(usageIn)} in / ${compactTokens(usageOut)} out`);

	if (result && result.kind === "ok") {
		bits.push(`${(result.durationMs / 1000).toFixed(1)}s mcode-side`);
	}
	bits.push(`${(elapsedMs / 1000).toFixed(1)}s`);

	if (result?.kind === "unknown") bits.unshift(`unrecognized result subtype ${result.subtype};`);

	const lines = [`mcode: ${bits.join(" · ")}`];
	if (acc.writtenFiles.length) {
		const shown = acc.writtenFiles.slice(0, 12).join(", ");
		const rest = acc.writtenFiles.length - 12;
		lines.push(`mcode wrote: ${shown}${rest > 0 ? ` (+${rest} more)` : ""}`);
	}
	return lines.join("\n");
}

export function renderFailure(
	acc: Accumulator,
	result: RunResult,
	elapsedMs: number,
	session: { id: string; tool: "mcode" | "mcode_reply"; timeoutMs: number | undefined },
): string {
	const ending = result.endedBy === "interrupt" ? "the turn was interrupted" : "the process was killed";
	const reason = result.cancelled
		? `cancelled by the client; ${ending}`
		: result.timedOut
			? `timed out${session.timeoutMs === undefined ? "" : ` after ${session.timeoutMs} ms`}; ${ending}`
			: `exited with code ${result.code}`;

	const parts: string[] = [];
	if (result.protocolError) parts.push(`[error: ${result.protocolError}]`);
	parts.push(`[session: ${session.id}]`, `[session-key: mcode:${session.id}]`, `[error: mcode ${reason}]`);

	const answer = selectAnswer(acc);
	if (answer.text) {
		parts.push(`last thing mcode said:\n${clip(answer.text)}`);
	} else {
		parts.push("mcode produced no text before it died.");
	}

	parts.push(`progress before it died:\n${summarize(acc, elapsedMs)}`);

	parts.push(
		`The session may still be intact and resumable.\n` +
			`To continue where it stopped:\n` +
			`  mcode_reply({ session: "${session.id}", prompt: "..." })\n` +
			`Raise the limit for the next leg with timeout_ms if the task needs longer.`,
	);

	const err = tailStderr(result.stderr);
	if (err) parts.push(`stderr:\n${err}`);

	return parts.join("\n\n");
}
