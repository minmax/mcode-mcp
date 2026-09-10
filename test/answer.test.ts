import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("happy path", () => {
	it("returns the result text, session prefix, stats and written files", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(false);
		const id = sessionIdOf(res.text);
		expect(res.text).toContain(`[session: ${id}]`);
		expect(res.text).toContain(`[session-key: mcode:${id}]`);
		expect(res.text).toContain("FINAL ANSWER");
		expect(res.text).not.toContain("NARRATION");

		const stats = res.text.split("---\n")[1];
		expect(stats).toContain("Write");
		expect(stats).toContain("mcode wrote: note.md");
	});

	it("uses ExecResult output as the print-mode answer, not the whole stdout", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir, transport: "print" });
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("FINAL ANSWER");
		expect(res.text).not.toContain("exec.started");
		expect(res.text).not.toContain('"type": "exec.result"');
		const stats = res.text.split("---\n")[1];
		expect(stats).toContain("Write");
		expect(stats).toContain("mcode wrote: note.md");
	});

	it("forwards progress notes for tool calls", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		await client.tool("mcode", { prompt: "go", cwd: ws.dir }, { progressToken: "p1" });
		client.close();
		expect(client.progressNotes()).toContain("running Write");
		expect(client.progressNotes().some((n) => n.startsWith("mcode started · mcode:"))).toBe(true);
	});

	it("keeps a completed session in mcode_sessions", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "slow", FAKE_DELAY_MS: "100" }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(res.text);

		const sessions = await client.tool("mcode_sessions");
		client.close();
		expect(sessions.text).toContain(id);
		expect(sessions.text).toContain(ws.dir);
	});
});

describe("error envelopes", () => {
	it("surfaces a failed ACP stopReason with the last thing mcode said", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "error_exec" }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("error_during_execution");
		expect(res.text).toContain("PARTIAL: 43 tests pass, now showing the failure");
	});
});
