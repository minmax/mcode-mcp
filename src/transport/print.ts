// `mcode exec --output-format stream-json`: one process per turn.
//
// Official events carry schemaVersion/sequence plus type. The answer lives in
// `exec.completed.result` (stable ExecResult). Session id is on every event
// and on the result. Mid-run send is impossible.

import type { RunResult } from "../mcode-process.ts";
import { runMcode } from "../mcode-process.ts";
import { asRecord, execUsage, formatModelRef, stringifyOutput } from "../parse.ts";
import type { CallContext } from "../types.ts";
import { printArgs } from "./args.ts";
import type { RunPlan, Transport } from "./types.ts";

export const printTransport: Transport = {
	name: "print",
	acceptsMidRunMessages: false,

	async run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult> {
		let sessionId: string | undefined;

		const result = await runMcode(printArgs(plan), plan.cwd, {
			token: ctx.token,
			timeoutMs: plan.timeoutMs,
			onEvent: (raw) => {
				const converted = convertExecLine(raw);
				if (converted === null) return;
				if (typeof converted.session_id === "string") {
					sessionId = converted.session_id;
					plan.onSessionId?.(sessionId);
				}
				onEvent(converted);
			},
		});

		if (sessionId === undefined && result.code === 0 && !result.timedOut && !result.cancelled) {
			return {
				...result,
				protocolError: "print mode produced no sessionId — mcode did not name the session",
			};
		}
		return { ...result, ...(sessionId ? { sessionId } : {}) };
	},
};

function convertExecLine(raw: unknown): Record<string, unknown> | null {
	const rec = asRecord(raw);
	if (rec === null) return null;

	if (rec.type === "exec.result") {
		return convertExecResult(rec);
	}

	const sessionId = typeof rec.sessionId === "string" ? rec.sessionId : undefined;

	if (rec.type === "session.started" || rec.type === "session.resumed") {
		return {
			type: "system",
			subtype: "init",
			session_id: sessionId,
		};
	}

	if (rec.type === "item.started" || rec.type === "item.updated" || rec.type === "item.completed") {
		return convertItem(asRecord(rec.item), sessionId, rec.type === "item.completed");
	}

	if (rec.type === "exec.completed") {
		const result = asRecord(rec.result);
		if (result === null) return null;
		return convertExecResult(result);
	}

	return null;
}

function convertItem(
	item: Record<string, unknown> | null,
	sessionId: string | undefined,
	completed: boolean,
): Record<string, unknown> | null {
	if (item === null) return null;

	if (item.type === "agent_message") {
		const text = completed
			? typeof item.content === "string"
				? item.content
				: undefined
			: typeof item.contentDelta === "string"
				? item.contentDelta
				: undefined;
		if (!text) return null;
		if (!completed) return null;
		return {
			type: "assistant",
			session_id: sessionId,
			message: { role: "assistant", content: [{ type: "text", text }] },
		};
	}

	if (item.type === "tool_call") {
		const call = asRecord(item.toolCall) ?? item;
		const name =
			(typeof call.toolName === "string" && call.toolName) ||
			(typeof call.name === "string" && call.name) ||
			(typeof call.title === "string" && call.title) ||
			"tool";
		const input = asRecord(call.rawInput) ?? asRecord(call.input) ?? {};
		return {
			type: "assistant",
			session_id: sessionId,
			message: {
				role: "assistant",
				content: [{ type: "tool_use", name, input }],
			},
		};
	}

	return null;
}

function convertExecResult(result: Record<string, unknown>): Record<string, unknown> | null {
	const status = typeof result.status === "string" ? result.status : undefined;
	if (status === undefined) return null;

	const sessionId = typeof result.sessionId === "string" ? result.sessionId : undefined;
	const usage = execUsage(result.usage);
	const durationMs =
		typeof result.durationMs === "number" && Number.isFinite(result.durationMs) ? result.durationMs : 0;
	const model = formatModelRef(result.model);
	const error = asRecord(result.error);
	const errorMessage = typeof error?.message === "string" ? error.message : undefined;

	const subtype =
		status === "succeeded"
			? "success"
			: status === "limit_exceeded"
				? "error_max_turns"
				: status === "failed" || status === "timeout" || status === "cancelled"
					? "error_during_execution"
					: status;

	const ok = subtype === "success";
	const output = stringifyOutput(result.output);
	return {
		type: "result",
		subtype,
		is_error: !ok,
		result: ok ? output : (errorMessage ?? output),
		session_id: sessionId,
		model,
		num_turns: 1,
		duration_ms: durationMs,
		usage,
		...(ok ? {} : { error: { message: errorMessage ?? `mcode exec status ${status}` } }),
	};
}
