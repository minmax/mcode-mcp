import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("models probe", () => {
	it("formats the catalog mcode actually reported", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_models");
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("2 provider(s), 3 model(s), source token_plan:");
		expect(res.text).toContain("minimax_oauth/MiniMax-M2.5 · selected");
		expect(res.text).toContain("custom/fake-coder-max");
		expect(res.text).toContain("custom/fake-model-1");
	});

	it("filters by search", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_models", { search: "coder" });
		const none = await client.tool("mcode_models", { search: "zzz" });
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("fake-coder-max");
		expect(res.text).not.toContain("MiniMax-M2.5");

		expect(none.isError).toBe(true);
		expect(none.text).toContain('No mcode providers or models match "zzz"');
	});

	it("reports a catalog refusal honestly", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "models_fail" }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_models");
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("could not read the model catalog");
		expect(res.text).toContain("model catalog unavailable");
	});

	it("fails fast when the mcode binary cannot start, instead of hanging", async () => {
		const client = new Client({ ...ws.env, MCODE_MCP_BIN: "/nonexistent/mcode-binary" }, ws.dir);
		await client.handshake();
		const started = Date.now();
		const res = await client.tool("mcode_models");
		client.close();
		expect(Date.now() - started).toBeLessThan(5_000);
		expect(res.isError).toBe(true);
	});
});
