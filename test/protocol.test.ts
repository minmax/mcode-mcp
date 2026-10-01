import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("handshake", () => {
	it("echoes a protocol version it supports", async () => {
		const client = new Client(ws.env, ws.dir);
		const init = await client.handshake();
		expect(init.result.protocolVersion).toBe("2025-06-18");
		expect(init.result.capabilities.tools).toBeDefined();
		expect(init.result.serverInfo.name).toBe("mcode");
		client.close();
	});

	it("falls back to a known version when asked for an unknown one", async () => {
		const client = new Client(ws.env, ws.dir);
		const init = await client.call("initialize", {
			protocolVersion: "1999-01-01",
			capabilities: {},
			clientInfo: { name: "test", version: "1" },
		});
		expect(init.result.protocolVersion).toBe("2025-06-18");
		client.close();
	});

	it("exposes exactly its tools", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const list = await client.call("tools/list");
		expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
			"mcode",
			"mcode_context",
			"mcode_history",
			"mcode_models",
			"mcode_profiles",
			"mcode_reply",
			"mcode_running",
			"mcode_send",
			"mcode_sessions",
		]);
		client.close();
	});
});

describe("json-rpc conformance", () => {
	it("answers ping", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		expect((await client.call("ping")).result).toEqual({});
		client.close();
	});

	it("rejects an unknown method with -32601", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		expect((await client.call("no/such/method")).error?.code).toBe(-32601);
		client.close();
	});

	it("rejects an unknown tool with -32602", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.call("tools/call", { name: "nope", arguments: {} });
		expect(res.error?.code).toBe(-32602);
		client.close();
	});

	it("never answers a notification", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		client.send({ jsonrpc: "2.0", method: "tools/list" });
		client.send({ jsonrpc: "2.0", method: "initialize", params: {} });
		client.send({ jsonrpc: "2.0", method: "tools/call", params: { name: "mcode_sessions", arguments: {} } });
		await new Promise((r) => setTimeout(r, 300));
		expect(client.notifications.filter((n) => n.id !== undefined)).toEqual([]);
		client.close();
	});
});

describe("argument validation", () => {
	it("rejects a missing prompt", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { cwd: ws.dir });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("prompt");
	});

	it("rejects a relative cwd", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: "relative" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("absolute");
	});

	it("rejects effort instead of faking a flag mcode does not have", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir, effort: "high" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("no --effort flag");
	});

	it("rejects allowed_tools as unsupported", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir, allowed_tools: "Read" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("no tools allowlist");
	});

	it("rejects plan mode on print", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", {
			prompt: "go",
			cwd: ws.dir,
			transport: "print",
			mode: "plan",
		});
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("ACP-only");
	});

	it("rejects thinking_effort on print", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", {
			prompt: "go",
			cwd: ws.dir,
			transport: "print",
			thinking_effort: "high",
		});
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("ACP-only");
	});

	it("rejects permission off on ACP", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir, permission: "off" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("exec-only");
	});

	it("rejects follow_up instead of faking a queue", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_send", { session: "session_x", command: "follow_up", message: "later" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("follow_up is unsupported");
	});
});
