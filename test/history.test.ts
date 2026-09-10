import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseMcodeLine } from "../src/history.ts";
import { sessionDirSuffix } from "../src/transcript.ts";
import { Client, makeWorkspace, sessionIdOf, type Workspace } from "./helpers/client.ts";

const SESSION = "mvs_testhistory00000000000000000001";

function plantTranscript(root: string, sessionId: string, lines: unknown[]): string {
	const dir = join(root, "v2", "sessions", "2026", "01", "01", `00-00-00-000${sessionDirSuffix(sessionId)}`);
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "messages.jsonl");
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return path;
}

describe("parseMcodeLine", () => {
	it("keeps user and assistant text and omits thinking", () => {
		const events = parseMcodeLine({
			message_id: "m1",
			turn_id: "t1",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "SECRET_THOUGHT", thinkingSignature: "sig" },
					{ type: "text", text: "MCODE_MCP_OK" },
				],
			},
		});
		const items = events.filter((e) => e.kind === "item");
		const omitted = events.filter((e) => e.kind === "omit");
		expect(items).toEqual([{ kind: "item", item: { id: "", role: "assistant", text: "MCODE_MCP_OK" } }]);
		expect(omitted).toEqual([{ kind: "omit", tag: "thought" }]);
	});

	it("maps toolCall and toolResult", () => {
		const call = parseMcodeLine({
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "c1", name: "Read", arguments: { path: "a.ts" } }],
			},
		});
		expect(call.some((e) => e.kind === "item" && e.item.role === "tool" && e.item.name === "Read")).toBe(true);

		const result = parseMcodeLine({
			message: {
				role: "toolResult",
				toolName: "Read",
				content: [{ type: "text", text: "file body" }],
			},
		});
		const item = result.find((e) => e.kind === "item");
		expect(item?.kind === "item" && item.item.role === "tool" && item.item.text.includes("file body")).toBe(true);
	});
});

describe("mcode_history", () => {
	let ws: Workspace;
	beforeAll(() => {
		ws = makeWorkspace({ FAKE_SESSION_ID: SESSION });
	});
	afterAll(() => ws.cleanup());

	it("reads native messages.jsonl for a remembered session", async () => {
		plantTranscript(ws.dir, SESSION, [
			{
				message_id: "u1",
				turn_id: "t1",
				message: { role: "user", content: [{ type: "text", text: "hello from user" }] },
			},
			{
				message_id: "a1",
				turn_id: "t1",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "do not leak" },
						{ type: "text", text: "hello from assistant" },
					],
				},
			},
		]);

		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const started = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		expect(sessionIdOf(started.text)).toBe(SESSION);
		const res = await client.tool("mcode_history", { session: SESSION });
		client.close();

		expect(res.isError).toBe(false);
		const page = JSON.parse(res.text) as {
			session: string;
			session_key: string;
			source: string;
			items: { role: string; text: string }[];
			omitted: string[];
		};
		expect(page.session).toBe(SESSION);
		expect(page.session_key).toBe(`mcode:${SESSION}`);
		expect(page.source).toBe("native");
		expect(page.items.map((i) => `${i.role}:${i.text}`)).toEqual([
			"user:hello from user",
			"assistant:hello from assistant",
		]);
		expect(page.omitted).toContain("thought");
		expect(res.text).not.toContain("do not leak");
	});

	it("rejects an unknown session instead of scanning arbitrary ids", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_history", { session: "mvs_not_from_this_server" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("unknown session");
	});
});
