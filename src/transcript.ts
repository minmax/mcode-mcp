// Where MiniMax Code keeps a session on disk.
//
// Native layout (mcode 0.3.11, confirmed on ~/.minimax/v2/sessions):
//   <dataDir>/v2/sessions/YYYY/MM/DD/<time>-session_<b64(sessionId)>/messages.jsonl
// dataDir is MINIMAX_DATA_DIR or MAVIS_DATA_DIR, else ~/.minimax.
// Session ids look like `mvs_<hex>`. This module only looks under v2/sessions.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

export function dataDir(): string {
	const configured = process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim();
	if (configured === undefined || configured === "") return join(homedir(), ".minimax");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return resolve(configured);
}

export function storeRoot(): string {
	return join(dataDir(), "v2", "sessions");
}

export function sessionDirSuffix(sessionId: string): string {
	return `-session_${Buffer.from(sessionId, "utf8").toString("base64")}`;
}

export function expectedTranscript(sessionId: string): string {
	return join(
		storeRoot(),
		"_unknown",
		`session_${Buffer.from(sessionId, "utf8").toString("base64")}`,
		"messages.jsonl",
	);
}

function listNames(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * Absolute path of messages.jsonl, or null while mcode has not created it yet.
 * Lookup is YYYY/MM/DD directories whose name ends with `-session_<b64(id)>`.
 */
export function findTranscript(sessionId: string): string | null {
	const root = storeRoot();
	const suffix = sessionDirSuffix(sessionId);
	let best: { path: string; mtime: number } | null = null;
	for (const year of listNames(root)) {
		if (!/^\d{4}$/.test(year)) continue;
		const yearDir = join(root, year);
		for (const month of listNames(yearDir)) {
			if (!/^\d{2}$/.test(month)) continue;
			const monthDir = join(yearDir, month);
			for (const day of listNames(monthDir)) {
				if (!/^\d{2}$/.test(day)) continue;
				const dayDir = join(monthDir, day);
				for (const name of listNames(dayDir)) {
					if (!name.endsWith(suffix)) continue;
					const candidate = join(dayDir, name, "messages.jsonl");
					if (!existsSync(candidate)) continue;
					let mtime = 0;
					try {
						mtime = statSync(candidate).mtimeMs;
					} catch {
						continue;
					}
					if (best === null || mtime >= best.mtime) best = { path: candidate, mtime };
				}
			}
		}
	}
	return best?.path ?? null;
}

export function isInsideStore(root: string, target: string): boolean {
	const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
	return target === root || target.startsWith(prefix);
}

export function resolveInsideStore(root: string, target: string): string | null {
	let realRoot: string;
	let realTarget: string;
	try {
		realRoot = realpathSync(root);
	} catch {
		realRoot = resolve(root);
	}
	try {
		realTarget = realpathSync(target);
	} catch {
		realTarget = resolve(target);
	}
	if (!isInsideStore(realRoot, realTarget)) return null;
	return realTarget;
}

export function statKey(sessionId: string): string {
	return `mcode:${sessionId}`;
}
