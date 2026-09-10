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
	onSessionId?: (id: string) => void;
}

export interface Transport {
	readonly name: TransportName;
	readonly acceptsMidRunMessages: boolean;
	run(plan: RunPlan, ctx: CallContext, onEvent: (event: unknown) => void): Promise<RunResult>;
}
