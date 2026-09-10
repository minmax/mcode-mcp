import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, type Workspace, waitFor } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

const CHILD_TAG = "mcode-mcp-failure-child";

function survivors(): string {
	return spawnSync("pgrep", ["-f", CHILD_TAG], { encoding: "utf8" }).stdout.trim();
}

describe("stderr", () => {
	it("suppresses misdirected protocol messages but keeps diagnostics", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "noisy_stderr" }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("[3 protocol message line(s) on stderr, suppressed:");
		expect(res.text).toContain("message_start×2");
		expect(res.text).toContain("message_end×1");
		expect(res.text).toContain("Error: upstream refused the request");
		expect(res.text).not.toContain("SECRET_PROMPT_BODY");
	});

	it("forwards stderr verbatim when the guard is switched off", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "noisy_stderr", MCODE_MCP_STDERR_KEEP_EVENTS: "1" }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).not.toContain("protocol message line(s) on stderr");
		expect(res.text).toContain("upstream refused");
	});
});

describe("timeout", () => {
	it("kills mcode and its tree, and reports a resumable run", async () => {
		const client = new Client(
			{
				...ws.env,
				FAKE_MODE: "hang",
				FAKE_CHILD_TAG: CHILD_TAG,
				MCODE_MCP_TIMEOUT_MS: "1000",
				MCODE_MCP_INTERRUPT_GRACE_MS: "300",
			},
			ws.dir,
		);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("timed out after 1000 ms");
		expect(res.text).toMatch(/the (process was killed|turn was interrupted)/);
		const id = sessionIdOf(res.text);
		expect(res.text).toContain(`[session: ${id}]`);
		expect(res.text).toContain("progress before it died:");
		expect(res.text).toContain(`mcode_reply({ session: "${id}", prompt: "..." })`);
		expect(res.text).toContain("Raise the limit for the next leg with timeout_ms");

		await waitFor("the process tree to be reaped", () => survivors() === "");
	});
});

describe("protocol failures", () => {
	it("fails the run honestly when the initialize handshake is rejected", async () => {
		const client = new Client({ ...ws.env, FAKE_INIT_FAIL: "1" }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("initialize handshake");
	});
});
