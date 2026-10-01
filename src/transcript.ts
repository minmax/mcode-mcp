// Where MiniMax Code keeps a session on disk.
//
// Native layout (mcode 0.3.11, confirmed on ~/.minimax/v2/sessions):
//   <dataDir>/v2/sessions/YYYY/MM/DD/<time>-session_<b64(sessionId)>/messages.jsonl
// dataDir is MINIMAX_DATA_DIR or MAVIS_DATA_DIR, else ~/.minimax for the default
// profile and ~/.minimax-<name> for a named one — see profile.ts.
// Session ids look like `mvs_<hex>`. This module only looks under v2/sessions.
//
// Every lookup takes the profile the session was started under. A session's
// transcript lives in its own account's store, so a lookup that guessed the
// default would report "no transcript" for a session that plainly has one.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { dataDirForProfile } from "./profile.ts";

export function storeRoot(profile: string | null = null): string {
	return join(dataDirForProfile(profile), "v2", "sessions");
}

export function sessionDirSuffix(sessionId: string): string {
	return `-session_${Buffer.from(sessionId, "utf8").toString("base64")}`;
}

export function expectedTranscript(sessionId: string, profile: string | null = null): string {
	return join(
		storeRoot(profile),
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
export function findTranscript(sessionId: string, profile: string | null = null): string | null {
	const root = storeRoot(profile);
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
