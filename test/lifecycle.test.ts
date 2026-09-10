import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, type Workspace, waitFor } from "./helpers/client.ts";

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

const CHILD_TAG = "mcode-mcp-lifecycle-child";

function survivors(): string {
	return spawnSync("pgrep", ["-f", CHILD_TAG], { encoding: "utf8" }).stdout.trim();
}

describe("cancellation", () => {
	it("kills the whole process tree, not just mcode", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "hang", FAKE_CHILD_TAG: CHILD_TAG }, ws.dir);
		await client.handshake();
		const call = client.request("tools/call", { name: "mcode", arguments: { prompt: "go", cwd: ws.dir } });
		await waitFor("mcode to spawn its child", () => survivors() !== "");

		client.send({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: call.id, reason: "test" },
		});
		const res = (await call.promise).result;
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("cancelled");

		await waitFor("the process tree to be reaped", () => survivors() === "");
		client.close();
	});
});

describe("clean exit", () => {
	it("does not leave a marked child behind after a successful run that spawned one", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "child_then_answer", FAKE_CHILD_TAG: CHILD_TAG }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		client.close();
		expect(res.isError).toBe(false);
		await waitFor("the leftover child to be reaped", () => survivors() === "");
	});
});
