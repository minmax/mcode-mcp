// Runs against the real mcode binary. Opt-in: MCODE_CLI_MCP_LIVE=1 npm run test:live

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, sessionIdOf } from "./helpers/client.ts";

const live = process.env.MCODE_CLI_MCP_LIVE === "1";
let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "mcode-mcp-live-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.runIf(live)("real mcode", () => {
	it("answers a prompt end to end without writing files", async () => {
		const client = new Client({ MCODE_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const res = await client.tool("mcode", {
			prompt: "Reply with exactly: MCODE_MCP_OK. Do not use tools. Do not write or edit any files.",
			cwd: dir,
			permission: "full",
			mode: "plan",
			timeout_ms: 90_000,
		});
		client.close();
		expect(res.isError).toBe(false);
		expect(res.text).toContain("MCODE_MCP_OK");
		expect(res.text).toMatch(/\[session: /);
		const receipt = join(dir, "LIVE_RECEIPT.md");
		writeFileSync(
			receipt,
			`# mcode-mcp live smoke\n\n- when: ${new Date().toISOString()}\n- cwd: ${dir}\n- session: ${sessionIdOf(res.text)}\n- ok: MCODE_MCP_OK present\n`,
		);
	}, 120_000);

	it("lists real providers from mcode provider list --json", async () => {
		const client = new Client({ MCODE_MCP_STATE: join(dir, "state.json") }, dir);
		await client.handshake();
		const res = await client.tool("mcode_models");
		client.close();
		if (res.isError) {
			expect(res.text).toContain("could not");
		} else {
			expect(res.text.trim().length).toBeGreaterThan(0);
		}
	}, 60_000);
});
