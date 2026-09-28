import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, type Workspace } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

// The catalog comes from the session's advertised ACP configOptions, not from
// `mcode provider list --json` — under a Token Plan login the credential list
// reports an empty model set for every provider and cannot answer the question.
describe("models probe", () => {
	it("lists the models the session actually advertises", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_models");
		client.close();

		expect(res.isError).toBe(false);
		expect(res.text).toContain("2 models available:");
		expect(res.text).toContain("minimax/FakeModel-Fast#thinking");
		expect(res.text).toContain("minimax/FakeModel-Pro#thinking");
		// The footer must be the printable spelling: the opaque ACP value is not
		// something `--model` on the print transport would accept.
		expect(res.text).toContain("current: minimax/FakeModel-Fast#thinking");
		expect(res.text).not.toContain("current: m:");
	});

	it("filters by search", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const hit = await client.tool("mcode_models", { search: "Pro" });
		const none = await client.tool("mcode_models", { search: "zzz" });
		client.close();

		expect(hit.isError).toBe(false);
		expect(hit.text).toContain("FakeModel-Pro");
		expect(hit.text).not.toContain("FakeModel-Fast");

		expect(none.isError).toBe(true);
		expect(none.text).toContain('No advertised model matches "zzz"');
	});

	it("says so when the installation advertises no models", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "no_models" }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_models");
		client.close();

		expect(res.isError).toBe(true);
		expect(res.text).toContain("advertised no model options");
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
