import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, sessionIdOf, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("session map", () => {
	it("survives a restart of this server via the state file", async () => {
		const first = new Client(ws.env, ws.dir);
		await first.handshake();
		const res = await first.tool("mcode", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(res.text);
		first.close();

		const second = new Client(ws.env, ws.dir);
		await second.handshake();
		const sessions = await second.tool("mcode_sessions");
		second.close();
		expect(sessions.text).toContain(id);
		expect(sessions.text).toContain(ws.dir);
	});

	it("reports an empty map before any session exists", async () => {
		const fresh = makeWorkspace();
		try {
			const client = new Client(fresh.env, fresh.dir);
			await client.handshake();
			const sessions = await client.tool("mcode_sessions");
			client.close();
			expect(sessions.text).toContain("No mcode sessions recorded yet");
		} finally {
			fresh.cleanup();
		}
	});
});

describe("per-session serialization", () => {
	it("never runs two mcode processes on one session at once", async () => {
		const lockFile = join(ws.dir, "overlap.lock");
		const client = new Client(
			{ ...ws.env, FAKE_MODE: "overlap", FAKE_LOCK_FILE: lockFile, FAKE_DELAY_MS: "250" },
			ws.dir,
		);
		await client.handshake();

		const session = "session_11111111-2222-4333-8444-555555555555";
		const [first, second] = await Promise.all([
			client.tool("mcode_reply", { session, prompt: "first", cwd: ws.dir }),
			client.tool("mcode_reply", { session, prompt: "second", cwd: ws.dir }),
		]);
		client.close();

		expect(first.isError).toBe(false);
		expect(second.isError).toBe(false);
		expect(first.text).toContain("EXCLUSIVE");
		expect(second.text).toContain("EXCLUSIVE");
		expect(first.text).not.toContain("OVERLAP");
		expect(second.text).not.toContain("OVERLAP");
	});
});

describe("resume", () => {
	it("continues an existing session with mcode_reply", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const first = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(first.text);
		const reply = await client.tool("mcode_reply", { session: id, prompt: "again", cwd: ws.dir });
		client.close();
		expect(reply.isError).toBe(false);
		expect(reply.text).toContain(`[session: ${id}]`);
		expect(reply.text).toContain("FINAL ANSWER");
	});
});
