// Narrowing for data that crosses a process boundary.

import type { McodeContentBlock, McodeEvent, McodeToolUseBlock, McodeUsage } from "./types.ts";
import { isResultBad, isResultOk } from "./types.ts";

export function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asMcodeEvent(value: unknown): (McodeEvent & { type: string }) | null {
	const record = asRecord(value);
	if (record === null || typeof record.type !== "string") return null;
	return record as unknown as McodeEvent & { type: string };
}

export interface ParsedUsage {
	input: number;
	output: number;
}

export function readUsage(value: unknown): ParsedUsage {
	const usage = asRecord(value) as Partial<McodeUsage> | null;
	return {
		input: asFiniteNumber(usage?.input_tokens) ?? 0,
		output: asFiniteNumber(usage?.output_tokens) ?? 0,
	};
}

export interface ParsedToolCall {
	name: string;
	path: string | undefined;
}

export interface ParsedAssistantMessage {
	model: string | undefined;
	text: string;
	toolCalls: ParsedToolCall[];
	usage: ParsedUsage;
}

function pathFromInput(input: unknown): string | undefined {
	const args = asRecord(input);
	return asString(args?.file_path) ?? asString(args?.path) ?? asString(args?.target_file);
}

export function readAssistantMessage(value: unknown): ParsedAssistantMessage | null {
	const envelope = asRecord(value);
	if (envelope === null || envelope.type !== "assistant") return null;
	const inner = asRecord(envelope.message);
	if (inner === null || inner.role !== "assistant") return null;

	const texts: string[] = [];
	const toolCalls: ParsedToolCall[] = [];
	const blocks = Array.isArray(inner.content) ? (inner.content as McodeContentBlock[]) : [];

	for (const raw of blocks) {
		const block = asRecord(raw);
		if (block === null || typeof block.type !== "string") continue;

		if (block.type === "text") {
			const text = asString(block.text)?.trim();
			if (text) texts.push(text);
			continue;
		}
		if (block.type === "tool_use") {
			const call = block as unknown as Partial<McodeToolUseBlock>;
			const name = asString(call.name);
			if (!name) continue;
			toolCalls.push({ name, path: pathFromInput(call.input) });
		}
	}

	return {
		model: asString(inner.model),
		text: texts.join("\n\n"),
		toolCalls,
		usage: readUsage(inner.usage),
	};
}

export type ParsedResult =
	| { kind: "ok"; text: string; usage: ParsedUsage; numTurns: number; durationMs: number }
	| {
			kind: "bad";
			subtype: string;
			message: string;
			usage: ParsedUsage;
			numTurns: number;
			durationMs: number;
	  }
	| { kind: "unknown"; subtype: string };

export function readResultMessage(value: unknown): ParsedResult | null {
	const record = asRecord(value);
	if (record === null || record.type !== "result") return null;
	const subtype = asString(record.subtype);
	if (subtype === undefined) return null;

	if (isResultOk(subtype)) {
		return {
			kind: "ok",
			text: asString(record.result) ?? "",
			usage: readUsage(record.usage),
			numTurns: asFiniteNumber(record.num_turns) ?? 0,
			durationMs: asFiniteNumber(record.duration_ms) ?? 0,
		};
	}
	if (isResultBad(subtype)) {
		const error = asRecord(record.error);
		return {
			kind: "bad",
			subtype,
			message: asString(error?.message) ?? `mcode reported ${subtype} without an error message`,
			usage: readUsage(record.usage),
			numTurns: asFiniteNumber(record.num_turns) ?? 0,
			durationMs: asFiniteNumber(record.duration_ms) ?? 0,
		};
	}
	return { kind: "unknown", subtype };
}

export function readSystemModel(value: unknown): string | undefined {
	const record = asRecord(value);
	if (record === null || record.type !== "system") return undefined;
	return asString(record.model);
}

export function formatModelRef(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim();
	const rec = asRecord(value);
	if (rec === null) return undefined;
	const provider = asString(rec.providerId);
	const model = asString(rec.modelId);
	if (provider && model) return `${provider}/${model}`;
	return model ?? provider;
}

export function execUsage(value: unknown): { input_tokens: number; output_tokens: number } {
	const rec = asRecord(value);
	return {
		input_tokens: asFiniteNumber(rec?.inputTokens) ?? asFiniteNumber(rec?.input_tokens) ?? 0,
		output_tokens: asFiniteNumber(rec?.outputTokens) ?? asFiniteNumber(rec?.output_tokens) ?? 0,
	};
}

export function stringifyOutput(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined || value === null) return "";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
