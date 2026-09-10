import type { McodeHandle } from "../mcode-process.ts";

export type MidRunCommand = "abort" | "steer" | "follow_up";

export interface LiveRun {
	sessionId: string;
	cwd: string;
	startedAt: number;
	handle: McodeHandle;
	deliver?: (command: MidRunCommand, message?: string) => void;
	sent: { at: number; type: string }[];
}

const live = new Map<string, LiveRun>();

export function registerRun(run: Omit<LiveRun, "sent">): () => void {
	const entry: LiveRun = { ...run, sent: [] };
	live.set(run.sessionId, entry);
	return () => {
		if (live.get(run.sessionId) === entry) live.delete(run.sessionId);
	};
}

export function getRun(sessionId: string): LiveRun | undefined {
	return live.get(sessionId);
}

export function listRuns(): LiveRun[] {
	return [...live.values()].sort((a, b) => a.startedAt - b.startedAt);
}
