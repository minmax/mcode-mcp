import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client, makeWorkspace, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

// Each test gets its own config file, so a test that rewrites one and then fails
// cannot hand a poisoned config to the next one.
let configPath: string;

const BASE_CONFIG = [
	"defaultModel: minimax/FakeModel-Fast",
	"defaultModelContextWindow: 512000",
	"minimaxModelContextLimits:",
	"  FakeModel-Fast: 512000",
	"",
].join("\n");

const sessionOf = (text: string): string => /\[session: ([^\]]+)\]/.exec(text)?.[1] ?? "";

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

let clientEnv: Record<string, string> = {};

beforeEach(() => {
	configPath = join(ws.dir, `config-${Math.random().toString(36).slice(2)}.yaml`);
	writeFileSync(configPath, BASE_CONFIG);
	// The server must be told which config this test is about; otherwise it
	// resolves its own default in the data dir and reads a file nobody wrote.
	clientEnv = { ...ws.env, MCODE_MCP_MINIMAX_CONFIG: configPath };
});
afterEach(() => {
	writeFileSync(configPath, BASE_CONFIG);
});

/** Run one turn and hand back the answer plus a client that can read its context. */
async function runThenRead(
	env: Record<string, string>,
	args: Record<string, unknown>,
): Promise<{ answered: string; report: string; answeredIsError: boolean }> {
	const run = new Client({ ...clientEnv, ...env }, ws.dir);
	await run.handshake();
	const answered = (await run.tool("mcode", { cwd: ws.dir, ...args })).text;
	run.close();

	const session = sessionOf(answered);
	if (session === "") return { answered, report: "", answeredIsError: false };

	const ctx = new Client({ ...clientEnv, ...env }, ws.dir);
	await ctx.handshake();
	const report = (await ctx.tool("mcode_context", { session })).text;
	ctx.close();
	return { answered, report, answeredIsError: false };
}

describe("mcode_context", () => {
	it("requires a session", async () => {
		const client = new Client(clientEnv, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_context", {});
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("`session` is required");
	});

	it("reports the window and the breakdown for a session that ran a turn", async () => {
		const { answered, report } = await runThenRead({}, { prompt: "go" });
		expect(answered).toContain("FINAL ANSWER");
		expect(report).toContain("Context report for session");
		expect(report).toContain("Budget:");
		expect(report).toContain("Components:");
		expect(report).toContain("- Tools:");
	});

	it("reports the window the config actually holds, not a hardcoded one", async () => {
		writeFileSync(configPath, "defaultModel: minimax/FakeModel-Fast\ndefaultModelContextWindow: 1000000\n");
		const { report } = await runThenRead({}, { prompt: "go" });

		// Anchored, so 11,000,000 cannot satisfy it.
		expect(report).toMatch(/Budget: [\d,]+ \/ 1,000,000 tokens/);
	});

	it("explains that a session with no completed turn has nothing to report", async () => {
		const client = new Client(clientEnv, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_context", { session: "session_that_never_ran" });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toMatch(/could not read|no context snapshot|has no context snapshot/i);
	});

	it("reports a failure instead of hanging when mcode cannot start", async () => {
		const client = new Client({ ...clientEnv, MCODE_MCP_BIN: "/nonexistent/mcode-binary" }, ws.dir);
		await client.handshake();
		const started = Date.now();
		const res = await client.tool("mcode_context", { session: "whatever" });
		client.close();

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(res.isError).toBe(true);
	});
});

describe("context_window on the print transport — the path that works", () => {
	it("passes --config and never writes the user's file", async () => {
		const argvLog = join(ws.dir, `argv-${Math.random().toString(36).slice(2)}.log`);
		const before = readFileSync(configPath, "utf8");

		const client = new Client({ ...clientEnv, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", {
			prompt: "go",
			cwd: ws.dir,
			transport: "print",
			context_window: 1000000,
			model: "minimax/FakeModel-Fast",
		});
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("FINAL ANSWER");

		const argv = readFileSync(argvLog, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as string[]);
		const execCall = argv.find((a) => a[0] === "exec");
		expect(execCall).toBeDefined();
		const configIndex = execCall?.indexOf("--config") ?? -1;
		expect(configIndex).toBeGreaterThan(0);
		const passed = execCall?.[configIndex + 1] ?? "";
		// A private copy, not the user's file, and gone once the run is over.
		expect(passed).not.toBe(configPath);
		expect(existsSync(passed)).toBe(false);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	it("actually changes the window the run gets, not just the argv", async () => {
		// The whole point of --config: mcode reads that copy as its runtime
		// config, so the window it reports afterwards has to be the one asked
		// for. Asserting only that `--config` appeared would still pass for a
		// copy with the wrong value, the wrong key, or no edit at all.
		const before = readFileSync(configPath, "utf8");
		const { report } = await runThenRead(
			{},
			{ prompt: "go", transport: "print", context_window: 1000000, model: "minimax/FakeModel-Fast" },
		);

		expect(report).toMatch(/Budget: [\d,]+ \/ 1,000,000 tokens/);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	it("is ignored when the value is not one the model advertises", async () => {
		// 0.5.8 applies an override only if it is in contextWindowOptions and
		// otherwise falls back. A fixture that accepted any integer would call a
		// silently-ignored value a success.
		const before = readFileSync(configPath, "utf8");
		const { report } = await runThenRead(
			{},
			{ prompt: "go", transport: "print", context_window: 777, model: "minimax/FakeModel-Fast" },
		);

		expect(report).toMatch(/Budget: [\d,]+ \/ 512,000 tokens/);
		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	it("leaves the shared config alone even when the run fails", async () => {
		const before = readFileSync(configPath, "utf8");
		const client = new Client({ ...clientEnv, FAKE_MODE: "error_exec" }, ws.dir);
		await client.handshake();
		await client.tool("mcode", {
			prompt: "go",
			cwd: ws.dir,
			transport: "print",
			context_window: 1000000,
			model: "minimax/FakeModel-Fast",
		});
		client.close();

		expect(readFileSync(configPath, "utf8")).toBe(before);
	});

	it("refuses a config it cannot safely edit, as a normal tool error", async () => {
		const hostile = "defaultModel: minimax/FakeModel-Fast\nminimaxModelContextLimits: {FakeModel-Fast: 512000}\n";
		writeFileSync(configPath, hostile);

		const client = new Client(clientEnv, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", {
			prompt: "go",
			cwd: ws.dir,
			transport: "print",
			context_window: 1000000,
			model: "minimax/FakeModel-Fast",
		});
		client.close();

		expect(res.isError).toBe(true);
		// A decision about the user's config, not a crash in the adapter.
		expect(res.text).not.toContain("this is a bug in the adapter");
		expect(res.text).toContain("inline flow map");
		expect(readFileSync(configPath, "utf8")).toBe(hostile);
	});
});

describe("context_window on the acp transport", () => {
	it("is refused outright, because it cannot take effect there", async () => {
		const before = readFileSync(configPath, "utf8");
		const client = new Client(clientEnv, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", {
			prompt: "go",
			cwd: ws.dir,
			context_window: 512000,
			model: "minimax/FakeModel-Fast",
		});
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).not.toContain("this is a bug in the adapter");
		expect(res.text).toContain("cannot be set on the acp transport");
		expect(res.text).toContain("print");
		// Nothing written on the way to refusing.
		expect(readFileSync(configPath, "utf8")).toBe(before);
		expect(existsSync(`${configPath}.mcode-mcp-context-pending`)).toBe(false);
		expect(existsSync(`${configPath}.mcode-mcp-context-lock`)).toBe(false);
	});

	// The escape hatch writes to the shared file, so these are the tests that
	// actually exercise the patch/rollback path over ACP.
	describe("under the opt-in escape hatch", () => {
		const opted = { MCODE_MCP_ALLOW_ACP_CONTEXT_WINDOW: "1" };

		it("puts the config back byte for byte, on success and on failure", async () => {
			const before = readFileSync(configPath, "utf8");

			const ok = new Client({ ...clientEnv, ...opted }, ws.dir);
			await ok.handshake();
			await ok.tool("mcode", {
				prompt: "go",
				cwd: ws.dir,
				context_window: 1000000,
				model: "minimax/FakeModel-Fast",
			});
			ok.close();
			expect(readFileSync(configPath, "utf8")).toBe(before);

			const bad = new Client({ ...clientEnv, ...opted, FAKE_MODE: "error_exec" }, ws.dir);
			await bad.handshake();
			await bad.tool("mcode", {
				prompt: "go",
				cwd: ws.dir,
				context_window: 1000000,
				model: "minimax/FakeModel-Fast",
			});
			bad.close();
			expect(readFileSync(configPath, "utf8")).toBe(before);
		});

		it("the patch is in place when the process reads its config", async () => {
			// 1000000 differs from the 512000 in the file, so the entry is genuinely
			// rewritten. The session records the window it actually got, so this
			// proves the patched value was on disk before mcode read it — which a
			// poll for the file contents could not, the fake turn is too quick.
			const before = readFileSync(configPath, "utf8");
			const run = new Client({ ...clientEnv, ...opted }, ws.dir);
			await run.handshake();
			const answered = (
				await run.tool("mcode", {
					prompt: "go",
					cwd: ws.dir,
					context_window: 1000000,
					model: "minimax/FakeModel-Fast",
				})
			).text;
			const session = sessionOf(answered);
			run.close();
			expect(answered).toContain("FINAL ANSWER");

			const ctx = new Client({ ...clientEnv, ...opted }, ws.dir);
			await ctx.handshake();
			const report = (await ctx.tool("mcode_context", { session })).text;
			ctx.close();

			expect(report).toMatch(/Budget: [\d,]+ \/ 1,000,000 tokens/);
			expect(readFileSync(configPath, "utf8")).toBe(before);
		});

		it("leaves no lock or sidecar behind", async () => {
			const client = new Client({ ...clientEnv, ...opted }, ws.dir);
			await client.handshake();
			await client.tool("mcode", {
				prompt: "go",
				cwd: ws.dir,
				context_window: 1000000,
				model: "minimax/FakeModel-Fast",
			});
			client.close();

			expect(existsSync(`${configPath}.mcode-mcp-context-pending`)).toBe(false);
			expect(existsSync(`${configPath}.mcode-mcp-context-lock`)).toBe(false);
		});
	});
});
