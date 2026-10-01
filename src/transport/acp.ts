// `mcode acp`: MiniMax Code stays up and speaks ACP JSON-RPC on stdin/stdout.
//
// Proven against 0.3.11:
//   - initialize protocolVersion is the integer 1
//   - session/new | session/load
//   - session/set_mode modeId=default|plan
//   - session/set_config_option permissionMode / model / thinkingEffort
//   - session/prompt, session/cancel, session/update
//   - session/request_permission options allow-once | allow-always | deny
//
// follow_up is not implemented: there is no documented ACP mid-turn queue.

import { INIT_TIMEOUT_MS, SERVER_INFO } from "../config.ts";
import type { McodeHandle, RunResult } from "../mcode-process.ts";
import { runMcode } from "../mcode-process.ts";
import { ConfigEditError, contextWindowModelId, withContextWindow } from "../minimax-config.ts";
import { parseModelTarget, resolveAcpModelTarget } from "../model-ref.ts";
import { asRecord } from "../parse.ts";
import { childEnv } from "../profile.ts";
import type { CallContext } from "../types.ts";
import { acpPermissionMode, agentArgs } from "./args.ts";
import type { MidRunCommand } from "./registry.ts";
import { registerRun } from "./registry.ts";
import type { RunPlan, Transport } from "./types.ts";

export function waitFor<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

interface PendingRequest {
	resolve: (value: Record<string, unknown>) => void;
	reject: (err: Error) => void;
}

class AcpClient {
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private sessionId: string | null = null;
	private textChunks: string[] = [];
	private pendingSteer: string | null = null;
	private promptId: number | null = null;
	private settled = false;
	private unregister: () => void = () => {};
	private readonly handle: McodeHandle;
	private readonly onEvent: (event: unknown) => void;
	private readonly plan: RunPlan;

	constructor(handle: McodeHandle, onEvent: (event: unknown) => void, plan: RunPlan) {
		this.handle = handle;
		this.onEvent = onEvent;
		this.plan = plan;
	}

	get id(): string | null {
		return this.sessionId;
	}

	handleLine(event: unknown): void {
		const record = asRecord(event);
		if (record === null || record.jsonrpc !== "2.0") return;

		if (typeof record.method === "string" && Object.hasOwn(record, "id") && !Object.hasOwn(record, "result")) {
			this.answerIncoming(record);
			return;
		}

		if (typeof record.id === "number") {
			const waiter = this.pending.get(record.id);
			if (waiter) {
				this.pending.delete(record.id);
				if (record.error !== undefined) {
					const err = asRecord(record.error);
					waiter.reject(new Error(typeof err?.message === "string" ? err.message : "ACP request failed"));
				} else {
					waiter.resolve(asRecord(record.result) ?? {});
				}
				if (record.id === this.promptId) {
					void this.onPromptSettled(asRecord(record.result) ?? {}, record.error !== undefined);
				}
				return;
			}
		}

		if (record.method === "session/update") {
			this.onUpdate(asRecord(record.params));
		}
	}

	request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.handle.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: Record<string, unknown>): void {
		this.handle.send({ jsonrpc: "2.0", method, params });
	}

	rejectAll(reason: string): void {
		for (const [id, waiter] of [...this.pending]) {
			this.pending.delete(id);
			waiter.reject(new Error(reason));
		}
	}

	deliver(command: MidRunCommand, message?: string): void {
		if (command === "follow_up") return;
		if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
		if (command === "steer" && typeof message === "string") this.pendingSteer = message;
	}

	attachLive(sessionId: string): void {
		this.sessionId = sessionId;
		this.unregister = registerRun({
			sessionId,
			cwd: this.plan.cwd,
			startedAt: Date.now(),
			handle: this.handle,
			deliver: (command, message) => this.deliver(command, message),
		});
	}

	detachLive(): void {
		this.unregister();
	}

	async startPrompt(text: string): Promise<void> {
		if (!this.sessionId) throw new Error("ACP session is not open");
		this.textChunks = [];
		this.promptId = this.nextId;
		await this.request("session/prompt", {
			sessionId: this.sessionId,
			prompt: [{ type: "text", text }],
		});
	}

	private answerIncoming(record: Record<string, unknown>): void {
		const method = record.method;
		if (method === "session/request_permission") {
			const params = asRecord(record.params);
			const optionId = pickPermissionOption(params, this.plan.overrides.permission);
			this.handle.send({
				jsonrpc: "2.0",
				id: record.id,
				result: { outcome: { outcome: "selected", optionId } },
			});
			return;
		}
		this.handle.send({
			jsonrpc: "2.0",
			id: record.id,
			error: { code: -32601, message: `Method not found: ${String(method)}` },
		});
	}

	private onUpdate(params: Record<string, unknown> | null): void {
		if (params === null) return;
		const update = asRecord(params.update) ?? params;
		const kind = update.sessionUpdate;
		if (kind === "agent_thought_chunk") return;
		if (kind === "agent_message_chunk") {
			const content = asRecord(update.content);
			const text = typeof content?.text === "string" ? content.text : "";
			if (text) {
				this.textChunks.push(text);
				this.onEvent({
					type: "assistant",
					message: {
						role: "assistant",
						model: this.plan.overrides.model,
						content: [{ type: "text", text }],
					},
				});
			}
			return;
		}
		if (kind === "tool_call") {
			const name =
				typeof update.toolName === "string"
					? update.toolName
					: typeof update.title === "string"
						? update.title
						: "tool";
			const rawInput = asRecord(update.rawInput) ?? {};
			this.onEvent({
				type: "assistant",
				message: {
					role: "assistant",
					model: this.plan.overrides.model,
					content: [{ type: "tool_use", id: update.toolCallId, name, input: rawInput }],
				},
			});
		}
	}

	private emitResult(subtype: string, text: string, isError: boolean): void {
		if (this.settled) return;
		this.settled = true;
		this.detachLive();
		this.onEvent({
			type: "result",
			subtype,
			is_error: isError,
			result: text,
			session_id: this.sessionId,
			num_turns: 1,
			duration_ms: 0,
			usage: { input_tokens: 0, output_tokens: 0 },
		});
		this.handle.endInput();
	}

	private async onPromptSettled(result: Record<string, unknown>, failed: boolean): Promise<void> {
		const stop = typeof result.stopReason === "string" ? result.stopReason : failed ? "error" : "end_turn";
		const text = this.textChunks.join("");

		if (this.pendingSteer !== null && (stop === "cancelled" || stop === "canceled")) {
			const steered = this.pendingSteer;
			this.pendingSteer = null;
			this.textChunks = [];
			this.promptId = this.nextId;
			try {
				await this.request("session/prompt", {
					sessionId: this.sessionId,
					prompt: [{ type: "text", text: steered }],
				});
			} catch (err) {
				this.emitResult("error_during_execution", err instanceof Error ? err.message : String(err), true);
			}
			return;
		}

		const subtype =
			stop === "end_turn"
				? "success"
				: stop === "max_tokens" || stop === "max_turn_requests"
					? "error_max_turns"
					: stop === "cancelled" || stop === "canceled"
						? "success"
						: stop === "refusal"
							? "error_during_execution"
							: "error_during_execution";
		const known =
			stop === "end_turn" ||
			stop === "max_tokens" ||
			stop === "max_turn_requests" ||
			stop === "cancelled" ||
			stop === "canceled" ||
			stop === "refusal";
		this.emitResult(known ? subtype : stop, text, subtype !== "success" || !known);
	}
}

function pickPermissionOption(params: Record<string, unknown> | null, permission: string | undefined): string {
	const options = Array.isArray(params?.options) ? params.options : [];
	const ids: string[] = [];
	for (const raw of options) {
		const rec = asRecord(raw);
		if (typeof rec?.optionId === "string") ids.push(rec.optionId);
	}
	const prefer = permission === "full" ? "allow-always" : "allow-once";
	if (ids.includes(prefer)) return prefer;
	if (ids.includes("allow-once")) return "allow-once";
	if (ids.includes("allow-always")) return "allow-always";
	return ids[0] ?? "allow-once";
}

export const acpTransport: Transport = {
	name: "acp",
	acceptsMidRunMessages: true,

	async run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult> {
		const startProcess = (): Promise<RunResult> => spawnRun(plan, ctx, onEvent);

		const wanted = plan.overrides.context_window;
		if (wanted === undefined) return startProcess();

		// Measured on 0.5.8: a context window set this way does not take effect
		// over ACP. The session selection built from an advertised model value
		// carries provider, model and variant but no context limit, so the turn
		// falls back to `defaultModelContextWindow` from the config no matter what
		// this file says. Holding the user's shared config for a whole turn would
		// therefore cost a lot and buy nothing.
		if (process.env.MCODE_MCP_ALLOW_ACP_CONTEXT_WINDOW !== "1") {
			throw new ConfigEditError(
				"context_window cannot be set on the acp transport. MiniMax Code builds a session " +
					"selection from the advertised model value, and that selection carries no context " +
					"limit, so the turn falls back to the context window in your config whatever this " +
					"server writes there. Use transport: 'print', which hands mcode a private --config " +
					"copy and does take effect. Nothing was written to your config. Set " +
					"MCODE_MCP_ALLOW_ACP_CONTEXT_WINDOW=1 to edit the shared config anyway — it will " +
					"hold the entry for the whole run and, until minimax-code#384 lands, still have no " +
					"effect.",
			);
		}

		// Escape hatch, not a supported path. `mcode acp` has no --config, so the
		// only lever is the shared file, held under a cross-process lock for the
		// whole run and rolled back compare-and-swap afterwards.
		const modelId = contextWindowModelId(plan.overrides.model, plan.profile);
		if (modelId === null) {
			throw new ConfigEditError(
				"context_window needs to know which model to apply it to, but the configured default model " +
					"could not be read from MiniMax Code's config.yaml. Pass `model` explicitly" +
					// Naming the override would be wrong advice here: with a profile in play
					// the next call refuses it, because that config is not the one the run
					// reads.
					(plan.profile === null ? ", or set MCODE_MCP_MINIMAX_CONFIG to the config's absolute path." : "."),
			);
		}

		const run = await withContextWindow(modelId, wanted, plan.profile, startProcess);
		if (run.skipped) {
			onEvent({
				type: "system",
				subtype: "init",
				note:
					`context_window: ${modelId} was changed by something else while this run was in flight, ` +
					"so the config entry was left as it is now found.",
			});
		}
		return run.value;
	},
};

function spawnRun(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult> {
	const args = agentArgs(plan.profile);
	let handle: McodeHandle | undefined;
	let client: AcpClient | undefined;

	const running = runMcode(args, plan.cwd, {
		token: ctx.token,
		timeoutMs: plan.timeoutMs,
		stdin: "pipe",
		env: childEnv(plan.profile),
		gracefulStop: () => {
			if (client?.id) handle?.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: client.id } });
		},
		onStart: (mcodeHandle) => {
			handle = mcodeHandle;
			client = new AcpClient(mcodeHandle, onEvent, plan);
		},
		onEvent: (event) => {
			client?.handleLine(event);
		},
	}).finally(() => {
		client?.detachLive();
		client?.rejectAll("the mcode process exited before replying");
	});

	return runAcpExchange(
		plan,
		running,
		() => client,
		() => handle,
		onEvent,
	);
}

async function runAcpExchange(
	plan: RunPlan,
	running: Promise<RunResult>,
	pickClient: () => AcpClient | undefined,
	pickHandle: () => McodeHandle | undefined,
	onEvent: (event: unknown) => void,
): Promise<RunResult> {
	let client = pickClient();
	let handle = pickHandle();
	try {
		// The client is created by runMcode's onStart callback, so it may not
		// exist yet on the first line after the spawn. Poll the live accessors,
		// not the local snapshot, or the wait never resolves.
		if (!client || !handle) {
			const ready = await Promise.race([
				running.then(() => false),
				new Promise<boolean>((resolve) => {
					// The poll must stop as soon as either side of the race settles,
					// or a process that dies during the handshake leaves this
					// rescheduling itself forever.
					let timer: NodeJS.Timeout | undefined;
					const check = (): void => {
						if (pickClient() && pickHandle()) resolve(true);
						else timer = setTimeout(check, 5);
					};
					const stop = (): void => {
						if (timer) clearTimeout(timer);
					};
					running.then(stop, stop);
					check();
				}),
			]);
			client = pickClient();
			handle = pickHandle();
			if (!ready || !client || !handle) {
				const result = await running;
				return { ...result, protocolError: "the mcode process exited before the ACP handshake" };
			}
		}

		try {
			await waitFor(
				client.request("initialize", {
					protocolVersion: 1,
					clientInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
					clientCapabilities: {},
				}),
				INIT_TIMEOUT_MS,
				"the initialize handshake",
			);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`mcode rejected the initialize handshake: ${detail}`);
		}

		let sessionId: string;
		// session/new and session/load both answer with the session's advertised
		// configOptions. The model select is what turns a caller's
		// `provider/model` into the opaque value this protocol actually accepts.
		let configOptions: unknown;
		if (plan.resume) {
			const loaded = await waitFor(
				client.request("session/load", {
					sessionId: plan.sessionId,
					cwd: plan.cwd,
					mcpServers: [],
				}),
				INIT_TIMEOUT_MS,
				"session/load",
			);
			configOptions = loaded.configOptions;
			sessionId = plan.sessionId;
		} else {
			const created = await waitFor(
				client.request("session/new", {
					cwd: plan.cwd,
					mcpServers: [],
					...(plan.overrides.add_dirs ? { additionalDirectories: plan.overrides.add_dirs } : {}),
				}),
				INIT_TIMEOUT_MS,
				"session/new",
			);
			const reported = created.sessionId;
			if (typeof reported !== "string" || reported === "") {
				throw new Error("session/new did not return a sessionId");
			}
			configOptions = created.configOptions;
			sessionId = reported;
			plan.onSessionId?.(sessionId);
		}

		const mode = plan.overrides.mode ?? "default";
		await client.request("session/set_mode", { sessionId, modeId: mode });

		const permissionMode = acpPermissionMode(plan.overrides.permission);
		if (permissionMode) {
			await client.request("session/set_config_option", {
				sessionId,
				configId: "permissionMode",
				value: permissionMode,
			});
		}

		if (plan.overrides.model) {
			const target = parseModelTarget(plan.overrides.model);
			if (target === null) {
				throw new Error(
					`model "${plan.overrides.model}" is not a provider/model reference. ` +
						"Use mcode_models to see what this installation advertises.",
				);
			}
			const resolved = resolveAcpModelTarget(target, configOptions);
			if (!resolved.ok) throw new Error(resolved.message);
			await client.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: resolved.value,
			});
		}
		if (plan.overrides.thinking_effort) {
			await client.request("session/set_config_option", {
				sessionId,
				configId: "thinkingEffort",
				value: plan.overrides.thinking_effort,
			});
		}

		client.attachLive(sessionId);
		onEvent({
			type: "system",
			subtype: "init",
			session_id: sessionId,
			model: plan.overrides.model,
			cwd: plan.cwd,
		});

		await client.startPrompt(plan.prompt);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		client?.rejectAll(message);
		handle?.kill("SIGTERM");
		const result = await running;
		return { ...result, protocolError: message, ...(client?.id ? { sessionId: client.id } : {}) };
	}

	const result = await running;
	return { ...result, ...(client?.id ? { sessionId: client.id } : {}) };
}
