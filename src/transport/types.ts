import type { RunResult } from "../mcode-process.ts";
import type { CallContext, RunOverrides } from "../types.ts";

export type TransportName = "print" | "acp";

export interface RunPlan {
	cwd: string;
	sessionId: string;
	resume?: boolean;
	prompt: string;
	overrides: RunOverrides;
	timeoutMs: number | undefined;
	/**
	 * Named auth profile this run belongs to, or null for the default one. It
	 * decides the account mcode signs in as, the data directory the run writes to
	 * and the store this server reads the transcript back from, so it is resolved
	 * once by the caller and used for all three. Required rather than optional:
	 * a plan that forgot it would silently run and read in different accounts.
	 */
	profile: string | null;
	/** Print only: an explicit per-process config file, via `mcode exec --config`. */
	configPath?: string;
	onSessionId?: (id: string) => void;
}

export interface Transport {
	readonly name: TransportName;
	readonly acceptsMidRunMessages: boolean;
	run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult>;
}
