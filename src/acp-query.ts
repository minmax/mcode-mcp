// A short-lived, read-only ACP client.
//
// The run transport in transport/acp.ts owns a real coding session: it answers
// tool calls, streams a turn and stays alive for mcode_send. Neither of the read
// paths here needs that, and none of them should be able to disturb a live one:
//
//   mcode_models   — session/new, then read the advertised configOptions
//   mcode_context  — session/load, then ask /context for the budget breakdown
//
// So this is a separate, deliberately small client that opens a process, runs
// one scripted exchange and closes it. It never registers a live run, never
// streams a turn to the accumulator, and auto-answers permission requests so a
// read can never block on a human.

import { INIT_TIMEOUT_MS, SERVER_INFO } from "./config.ts";
import type { McodeHandle, RunResult } from "./mcode-process.ts";
import { runMcode } from "./mcode-process.ts";
import { asRecord } from "./parse.ts";
import { childEnv } from "./profile.ts";
import { agentArgs } from "./transport/args.ts";
import type { CallContext } from "./types.ts";

export interface AcpQuerySession {
	sessionId: string;
	/** Open a brand-new session; the result carries its advertised configOptions. */
	newSession(extraDirectories?: string[]): Promise<{ configOptions: unknown }>;
	/** Attach to a session that already exists in MiniMax Code's store. */
	loadSession(sessionId: string): Promise<{ configOptions: unknown }>;
	/** Send one prompt and collect the assistant text it produced. */
	prompt(text: string): Promise<{ text: string; stopReason: string }>;
}

export interface AcpQueryResult<T> {
	value: T;
	result: RunResult;
}

function waitFor<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
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

class QueryClient {
	private nextId = 1;
	private readonly pending = new Map<
		number,
		{ resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
	>();
	private chunks: string[] = [];
	private sessionId: string | null = null;
	private readonly handle: McodeHandle;

	constructor(handle: McodeHandle) {
		this.handle = handle;
	}

	private send(message: unknown): void {
		this.handle.send(message);
	}

	request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	handleLine(event: unknown): void {
		const record = asRecord(event);
		if (record === null || record.jsonrpc !== "2.0") return;

		if (typeof record.method === "string" && Object.hasOwn(record, "id") && !Object.hasOwn(record, "result")) {
			// Nothing here is interactive, and nothing here should ever be
			// approved: a read that hits a permission prompt is a read that has
			// drifted into work it was never meant to do. Deny rather than hang,
			// and deny rather than hand a path that is supposed to be incapable
			// of acting an "allow always".
			if (record.method === "session/request_permission") {
				this.send({
					jsonrpc: "2.0",
					id: record.id,
					result: { outcome: { outcome: "cancelled" } },
				});
				return;
			}
			this.send({
				jsonrpc: "2.0",
				id: record.id,
				error: { code: -32601, message: `Method not found: ${record.method}` },
			});
			return;
		}

		if (typeof record.id === "number") {
			const waiter = this.pending.get(record.id);
			if (waiter !== undefined) {
				this.pending.delete(record.id);
				if (record.error !== undefined) {
					const err = asRecord(record.error);
					waiter.reject(new Error(typeof err?.message === "string" ? err.message : "ACP request failed"));
				} else {
					waiter.resolve(asRecord(record.result) ?? {});
				}
				return;
			}
		}

		if (record.method === "session/update") {
			const update = asRecord(asRecord(record.params)?.update) ?? asRecord(record.params);
			if (update?.sessionUpdate !== "agent_message_chunk") return;
			const text = asRecord(update.content)?.text;
			if (typeof text === "string") this.chunks.push(text);
		}
	}

	rejectAll(reason: string): void {
		for (const [id, waiter] of [...this.pending]) {
			this.pending.delete(id);
			waiter.reject(new Error(reason));
		}
	}

	get id(): string | null {
		return this.sessionId;
	}

	async initialize(): Promise<void> {
		await this.request("initialize", {
			protocolVersion: 1,
			clientInfo: { name: SERVER_INFO.name, version: SERVER_INFO.version },
			clientCapabilities: {},
		});
	}

	async newSession(cwd: string, extraDirectories?: string[]): Promise<{ sessionId: string; configOptions: unknown }> {
		const created = await this.request("session/new", {
			cwd,
			mcpServers: [],
			...(extraDirectories && extraDirectories.length > 0 ? { additionalDirectories: extraDirectories } : {}),
		});
		const sessionId = created.sessionId;
		if (typeof sessionId !== "string" || sessionId === "") {
			throw new Error("session/new did not return a sessionId");
		}
		this.sessionId = sessionId;
		return { sessionId, configOptions: created.configOptions };
	}

	async loadSession(sessionId: string, cwd: string): Promise<{ sessionId: string; configOptions: unknown }> {
		const loaded = await this.request("session/load", { sessionId, cwd, mcpServers: [] });
		this.sessionId = typeof loaded.sessionId === "string" && loaded.sessionId !== "" ? loaded.sessionId : sessionId;
		return { sessionId: this.sessionId, configOptions: loaded.configOptions };
	}

	async prompt(text: string): Promise<{ text: string; stopReason: string }> {
		if (this.sessionId === null) throw new Error("no ACP session is open");
		this.chunks = [];
		const settled = this.request("session/prompt", {
			sessionId: this.sessionId,
			prompt: [{ type: "text", text }],
		});
		const result = await settled;
		return {
			text: this.chunks.join(""),
			stopReason: typeof result.stopReason === "string" ? result.stopReason : "end_turn",
		};
	}
}

/**
 * Open `mcode acp`, hand a scripted session to `fn`, then close the process.
 * `fn` decides which session to open; a failure still tears the process down.
 *
 * `profile` is the account the read runs against. It is not optional in effect:
 * a session/load under the wrong profile either fails or reports another
 * account's budget, so it is resolved by the caller exactly as a run resolves it.
 */
export async function withAcpQuery<T>(
	ctx: CallContext,
	cwd: string,
	timeoutMs: number,
	profile: string | null,
	fn: (session: AcpQuerySession) => Promise<T>,
): Promise<AcpQueryResult<T>> {
	let handle: McodeHandle | undefined;
	let client: QueryClient | undefined;

	const running = runMcode(agentArgs(profile), cwd, {
		token: ctx.token,
		timeoutMs,
		stdin: "pipe",
		env: childEnv(profile),
		onStart: (mcodeHandle) => {
			handle = mcodeHandle;
			client = new QueryClient(mcodeHandle);
		},
		onEvent: (event) => {
			client?.handleLine(event);
		},
	}).finally(() => {
		client?.rejectAll("the mcode process exited before replying");
	});

	try {
		if (client === undefined || handle === undefined) {
			const ready = await Promise.race([
				running.then(() => false),
				new Promise<boolean>((resolve) => {
					// The poll must stop as soon as either side of the race settles,
					// or a process that dies during the handshake leaves this
					// rescheduling itself forever.
					let timer: NodeJS.Timeout | undefined;
					const check = (): void => {
						if (client !== undefined && handle !== undefined) resolve(true);
						else timer = setTimeout(check, 5);
					};
					const stop = (): void => {
						if (timer) clearTimeout(timer);
					};
					running.then(stop, stop);
					check();
				}),
			]);
			if (!ready || client === undefined) {
				const result = await running;
				throw new Error(`mcode acp exited before the handshake (exit code ${result.code})`);
			}
		}

		await waitFor(client.initialize(), INIT_TIMEOUT_MS, "the initialize handshake");

		const value = await fn({
			get sessionId() {
				return client?.id ?? "";
			},
			newSession: async (extraDirectories) => {
				const created = await waitFor(client!.newSession(cwd, extraDirectories), INIT_TIMEOUT_MS, "session/new");
				return { configOptions: created.configOptions };
			},
			loadSession: async (sessionId) => {
				const loaded = await waitFor(client!.loadSession(sessionId, cwd), INIT_TIMEOUT_MS, "session/load");
				return { configOptions: loaded.configOptions };
			},
			prompt: async (text) => waitFor(client!.prompt(text), timeoutMs, "session/prompt"),
		});

		// Closing stdin lets a well-behaved `mcode acp` exit on its own.
		handle?.endInput();
		const result = await running;
		return { value, result };
	} catch (err) {
		handle?.kill("SIGTERM");
		await running.catch(() => undefined);
		throw err;
	}
}
