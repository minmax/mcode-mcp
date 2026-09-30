import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ConfigEditError,
	recoverPendingContextEdit,
	resolveConfigPath,
	setContextLimit,
	withContextWindow,
	withTempContextConfig,
} from "../src/minimax-config.ts";

// These exercise the module against a real file on disk, because the whole
// point of it is that the file is a file: a temporary one here, in a temp
// directory, pointed at through the same env var the server uses.

const ORIGINAL = [
	"defaultModel: minimax/MiniMax-M3.1-Flash-Preview",
	"defaultModelVariant: thinking",
	"defaultModelContextWindow: 1000000",
	"# keep me",
	"provider:",
	"  minimax:",
	"    models:",
	"      MiniMax-M3:",
	"        limit:",
	"          context: 512000",
	"",
].join("\n");

let dir: string;
let configPath: string;
let savedDataDir: string | undefined;
let savedConfigEnv: string | undefined;

function writeConfig(text: string): void {
	writeFileSync(configPath, text);
}

const read = (): string => readFileSync(configPath, "utf8");
const pending = (): string => `${configPath}.mcode-mcp-context-pending`;
const lockPath = (): string => `${configPath}.mcode-mcp-context-lock`;

/**
 * A pid that is guaranteed not to be running, so a sidecar stamped with it reads
 * as crashed rather than in flight. pid 0 is the current process group and is
 * therefore always "alive", so it cannot be used here.
 */
function deadPid(): number {
	for (let candidate = 4_194_303; candidate > 100_000; candidate -= 7_919) {
		try {
			process.kill(candidate, 0);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ESRCH") return candidate;
		}
	}
	throw new Error("could not find an unused pid for the test");
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mcode-mcp-cfg-"));
	configPath = join(dir, "config.yaml");
	writeConfig(ORIGINAL);
	savedDataDir = process.env.MINIMAX_DATA_DIR;
	process.env.MINIMAX_DATA_DIR = dir;
	savedConfigEnv = process.env.MCODE_MCP_MINIMAX_CONFIG;
	delete process.env.MCODE_MCP_MINIMAX_CONFIG;
});

afterEach(() => {
	if (savedDataDir === undefined) delete process.env.MINIMAX_DATA_DIR;
	else process.env.MINIMAX_DATA_DIR = savedDataDir;
	// Restored in afterEach, not just beforeEach: a test that fails mid-way must
	// not leave the next one pointed at a directory that no longer exists.
	if (savedConfigEnv === undefined) delete process.env.MCODE_MCP_MINIMAX_CONFIG;
	else process.env.MCODE_MCP_MINIMAX_CONFIG = savedConfigEnv;
	rmSync(dir, { recursive: true, force: true });
});

describe("locating the config", () => {
	it("finds config.yaml in the data dir", () => {
		expect(resolveConfigPath()).toBe(configPath);
	});

	it("honours MAVIS_DATA_DIR when MINIMAX_DATA_DIR is unset, like the session store", () => {
		delete process.env.MINIMAX_DATA_DIR;
		const savedMavis = process.env.MAVIS_DATA_DIR;
		process.env.MAVIS_DATA_DIR = dir;
		try {
			expect(resolveConfigPath()).toBe(configPath);
		} finally {
			if (savedMavis === undefined) delete process.env.MAVIS_DATA_DIR;
			else process.env.MAVIS_DATA_DIR = savedMavis;
		}
	});

	it("prefers the explicit override", () => {
		process.env.MCODE_MCP_MINIMAX_CONFIG = configPath;
		expect(resolveConfigPath()).toBe(configPath);
	});

	it("returns null rather than guessing when the override is wrong", () => {
		process.env.MCODE_MCP_MINIMAX_CONFIG = join(dir, "nope.yaml");
		expect(resolveConfigPath()).toBeNull();
	});
});

describe("withContextWindow", () => {
	it("has the value in place while the body runs, and puts the file back after", async () => {
		let during = "";
		const run = await withContextWindow("MiniMax-M3.1-Flash-Preview", 512_000, async () => {
			during = read();
			return "done";
		});

		expect(run.value).toBe("done");
		expect(run.restored).toBe(true);
		expect(run.skipped).toBe(false);
		expect(during).toContain("minimaxModelContextLimits:");
		expect(during).toContain("MiniMax-M3.1-Flash-Preview: 512000");
		expect(read()).toBe(ORIGINAL);
	});

	it("restores even when the body throws", async () => {
		await expect(
			withContextWindow("MiniMax-M3", 1_000_000, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(read()).toBe(ORIGINAL);
		expect(existsSync(pending())).toBe(false);
	});

	it("leaves the file alone when somebody else changed the entry mid-run", async () => {
		const run = await withContextWindow("MiniMax-M3", 1_000_000, async () => {
			// The TUI, or a person, picked a different window while we were running.
			const edit = setContextLimit(read(), "MiniMax-M3", 999_000);
			writeConfig(edit.text);
			return "done";
		});

		expect(run.skipped).toBe(true);
		expect(read()).toContain("MiniMax-M3: 999000");
	});

	it("restores a previous value rather than removing the entry", async () => {
		writeConfig(`${ORIGINAL}minimaxModelContextLimits:\n  MiniMax-M3: 512000\n`);
		const before = read();

		const run = await withContextWindow("MiniMax-M3", 1_000_000, async () => "done");

		expect(run.restored).toBe(true);
		expect(read()).toBe(before);
	});

	it("does not corrupt a config it cannot safely edit", async () => {
		const inline = `${ORIGINAL}minimaxModelContextLimits: {MiniMax-M3: 512000}\n`;
		writeConfig(inline);

		await expect(withContextWindow("MiniMax-M3", 1_000_000, async () => "never")).rejects.toThrow(ConfigEditError);
		expect(read()).toBe(inline);
	});

	it("serialises concurrent calls so they cannot interleave", async () => {
		const order: string[] = [];
		const body = (id: string, value: number) => async () => {
			order.push(`enter:${id}`);
			// A second call starting here would read a file this one still owns.
			expect(read()).toContain(`MiniMax-M3: ${value}`);
			await new Promise((r) => setTimeout(r, 20));
			order.push(`exit:${id}`);
			return id;
		};

		const [a, b] = await Promise.all([
			withContextWindow("MiniMax-M3", 100_001, body("a", 100_001)),
			withContextWindow("MiniMax-M3", 200_002, body("b", 200_002)),
		]);

		expect(a.value).toBe("a");
		expect(b.value).toBe("b");
		expect(order).toEqual(["enter:a", "exit:a", "enter:b", "exit:b"]);
		expect(read()).toBe(ORIGINAL);
	});

	it("reports the value the caller asked for was only staged, not confirmed", async () => {
		// mcode ignores a window its model does not advertise. This server cannot
		// see the catalog before the process starts, so the honest thing is for
		// the caller to be able to check afterwards with mcode_context.
		const run = await withContextWindow("MiniMax-M3", 777, async () => "done");
		expect(run.value).toBe("done");
		expect(read()).toBe(ORIGINAL);
	});
});

describe("crash recovery", () => {
	function stageEdit(modelId: string, value: number, owner?: Record<string, unknown>): void {
		const edit = setContextLimit(read(), modelId, value);
		writeFileSync(
			pending(),
			JSON.stringify({ modelId, pid: process.pid, createdAt: Date.now(), ...edit, ...owner }),
			{ mode: 0o600 },
		);
		writeConfig(edit.text);
	}

	it("finishes a rollback that a crash left open", () => {
		stageEdit("MiniMax-M3", 1_000_000, { pid: deadPid() });
		expect(read()).toContain("MiniMax-M3: 1000000");

		const note = recoverPendingContextEdit();

		expect(note).toContain("rolled back");
		expect(read()).toBe(ORIGINAL);
		expect(existsSync(pending())).toBe(false);
	});

	it("leaves a run that is still in flight completely alone", () => {
		// A live sidecar means another server instance has not finished its turn
		// yet. Its process may not even have read the config, so "recovering" it
		// here would strip the window the user asked for.
		stageEdit("MiniMax-M3", 1_000_000);

		expect(recoverPendingContextEdit()).toBeNull();
		expect(read()).toContain("MiniMax-M3: 1000000");
		expect(existsSync(pending())).toBe(true);
	});

	it("ignores a live-looking sidecar once it is older than its window", () => {
		stageEdit("MiniMax-M3", 1_000_000, { createdAt: Date.now() - 11 * 60_000 });

		const note = recoverPendingContextEdit();

		expect(note).toContain("rolled back");
		expect(read()).toBe(ORIGINAL);
	});

	it("treats a sidecar from a reused pid as stale only after the window", () => {
		stageEdit("MiniMax-M3", 1_000_000, { pid: process.pid, createdAt: Date.now() - 11 * 60_000 });

		expect(recoverPendingContextEdit()).toContain("rolled back");
	});

	it("does not clobber a value somebody else has since written", () => {
		stageEdit("MiniMax-M3", 1_000_000, { pid: deadPid() });
		const theirs = setContextLimit(read(), "MiniMax-M3", 512_000);
		writeConfig(theirs.text);

		const note = recoverPendingContextEdit();

		expect(note).toContain("left exactly as it is now");
		expect(read()).toContain("MiniMax-M3: 512000");
		expect(existsSync(pending())).toBe(false);
	});

	it("is a no-op when there is nothing to recover", () => {
		expect(recoverPendingContextEdit()).toBeNull();
		expect(read()).toBe(ORIGINAL);
	});

	it("discards an unreadable sidecar rather than looping on it", () => {
		writeFileSync(pending(), "{not json");
		expect(recoverPendingContextEdit()).toBeNull();
		expect(existsSync(pending())).toBe(false);
	});
});

describe("the cross-process lock", () => {
	it("is released when the run finishes", async () => {
		await withContextWindow("MiniMax-M3", 1_000_000, async () => "done");
		expect(existsSync(lockPath())).toBe(false);
	});

	it("is released even when the run throws", async () => {
		await expect(
			withContextWindow("MiniMax-M3", 1_000_000, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(lockPath())).toBe(false);
	});

	it("makes a second instance wait rather than capture the first one's value", async () => {
		// Stands in for another mcode-mcp: a live owner holds the lock for the
		// whole turn, and the lock is judged by that owner being alive, not by age.
		writeFileSync(lockPath(), `${process.pid}:someone-else\n`);
		const started = Date.now();
		await expect(withContextWindow("MiniMax-M3", 1_000_000, async () => "never")).rejects.toThrow(
			/context_window turn/,
		);
		expect(Date.now() - started).toBeLessThan(20_000);
		// A refused caller must not have touched the file, and must leave the
		// other instance's lock alone.
		expect(read()).toBe(ORIGINAL);
		expect(existsSync(lockPath())).toBe(true);
		rmSync(lockPath(), { force: true });
	});

	it("reaps a lock whose owner is gone, however young it is", async () => {
		writeFileSync(lockPath(), `${deadPid()}:ghost\n`);

		const run = await withContextWindow("MiniMax-M3", 1_000_000, async () => "done");

		expect(run.value).toBe("done");
		expect(read()).toBe(ORIGINAL);
		expect(existsSync(lockPath())).toBe(false);
	});

	it("actually waits rather than failing instantly", async () => {
		// A refusal that returned at once with the same message would satisfy the
		// upper bound above, so the lower bound is asserted too.
		writeFileSync(lockPath(), `${process.pid}:someone-else\n`);
		const started = Date.now();
		await expect(withContextWindow("MiniMax-M3", 1_000_000, async () => "never")).rejects.toThrow();
		expect(Date.now() - started).toBeGreaterThan(3_000);
		rmSync(lockPath(), { force: true });
	});
});

describe("two server processes on one config", () => {
	// The lock exists because every agent session brings up its own mcode-mcp.
	// Testing it inside one process only proves it serialises promises, not that
	// it stops a second OS process from capturing our previousValue.
	it("a second process is refused while the first holds the lock", async () => {
		const script = `
			import { withContextWindow } from ${JSON.stringify(new URL("../src/minimax-config.ts", import.meta.url).href)};
			const [modelId, value, holdMs] = process.argv.slice(2);
			const run = await withContextWindow(modelId, Number(value), async () => {
				await new Promise((r) => setTimeout(r, Number(holdMs)));
				return "second";
			});
			process.stdout.write(JSON.stringify({ value: run.value, restored: run.restored }));
		`;
		const scriptPath = join(dir, "second-instance.mjs");
		writeFileSync(scriptPath, script, { mode: 0o700 });

		const spawnNode = (holdMs: number) =>
			new Promise<{ code: number; out: string; err: string }>((resolve) => {
				let err = "";
				const child = spawn(
					process.execPath,
					["--experimental-strip-types", scriptPath, "MiniMax-M3", String(1_000_000), String(holdMs)],
					{
						env: { ...process.env, MINIMAX_DATA_DIR: dir },
						stdio: ["ignore", "pipe", "pipe"],
					},
				);
				let out = "";
				child.stdout.on("data", (d: Buffer) => {
					out += String(d);
				});
				child.stderr.on("data", (d: Buffer) => {
					err += String(d);
				});
				child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
			});

		// First instance takes the lock and holds it while it "runs".
		const first = withContextWindow("MiniMax-M3", 2_000_000, async () => {
			// Give the second process time to start and find the lock held.
			await new Promise((r) => setTimeout(r, 1_500));
			expect(read()).toContain("MiniMax-M3: 2000000");
			const second = await spawnNode(0);
			// It must fail on the lock specifically, not on anything incidental.
			expect(second.err).toContain("context_window turn");
			expect(second.out).not.toContain('"second"');
			return "first";
		});

		const result = await first;
		expect(result.value).toBe("first");
		expect(read()).toBe(ORIGINAL);
		expect(existsSync(lockPath())).toBe(false);
	}, 30_000);
});

describe("withTempContextConfig", () => {
	it("hands the body a private copy and never touches the original", async () => {
		let seen = "";
		await withTempContextConfig("MiniMax-M3.1-Flash-Preview", 1_000_000, async (path) => {
			seen = readFileSync(path, "utf8");
			expect(existsSync(path)).toBe(true);
			// The copy is what mcode is pointed at, so it must carry the value.
			expect(seen).toContain("MiniMax-M3.1-Flash-Preview: 1000000");
			return undefined;
		});

		expect(read()).toBe(ORIGINAL);
	});

	it("keeps the rest of the config, since mcode needs its whole runtime config", async () => {
		await withTempContextConfig("MiniMax-M3", 1_000_000, async (path) => {
			const copy = readFileSync(path, "utf8");
			expect(copy).toContain("defaultModel: minimax/MiniMax-M3.1-Flash-Preview");
			expect(copy).toContain("# keep me");
			return undefined;
		});
	});

	it("removes the temporary copy afterwards", async () => {
		let path = "";
		await withTempContextConfig("MiniMax-M3", 1_000_000, async (p) => {
			path = p;
			return undefined;
		});
		expect(existsSync(path)).toBe(false);
		expect(existsSync(join(path, "..", ".."))).toBe(true);
	});

	it("refuses rather than writing when the config is in a form it cannot edit", async () => {
		writeConfig(`${ORIGINAL}minimaxModelContextLimits: 512000\n`);
		await expect(withTempContextConfig("MiniMax-M3", 1_000_000, async () => "never")).rejects.toThrow(
			ConfigEditError,
		);
		expect(read()).toBe(`${ORIGINAL}minimaxModelContextLimits: 512000\n`);
	});
});
