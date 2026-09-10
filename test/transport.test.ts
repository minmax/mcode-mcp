import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, makeWorkspace, readStdinLog, sessionIdOf, sleep, type Workspace } from "./helpers/client.ts";

async function sessionIdOfRunning(client: Client): Promise<string> {
	const running = await client.tool("mcode_running");
	const match = running.text.match(/^(session_\S+|\S+)\s+\d+\.\d+s\s+/m);
	if (!match?.[1]) throw new Error(`no running session in: ${running.text.slice(0, 200)}`);
	return match[1];
}

let ws: Workspace;

beforeAll(() => {
	ws = makeWorkspace();
});
afterAll(() => ws.cleanup());

describe("print transport", () => {
	it("uses exec stream-json, cwd, permission, and resumes with --session", async () => {
		const argvLog = join(ws.dir, `argv-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		const first = await client.tool("mcode", { prompt: "go", cwd: ws.dir, transport: "print" });
		const id = sessionIdOf(first.text);
		await client.tool("mcode_reply", { session: id, prompt: "again", cwd: ws.dir, transport: "print" });
		client.close();

		const argvs = readFileSync(argvLog, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]);
		expect(argvs.length).toBe(2);
		const firstRun = argvs[0] ?? [];
		const replyArgv = argvs[1] ?? [];
		expect(firstRun[0]).toBe("exec");
		expect(firstRun).toContain("--output-format");
		expect(firstRun).toContain("stream-json");
		expect(firstRun).toContain("--cwd");
		expect(firstRun).toContain("--permission");
		expect(firstRun.at(firstRun.indexOf("--permission") + 1)).toBe("full");
		expect(firstRun.at(-2)).toBe("--");
		expect(firstRun.at(-1)).toBe("go");
		expect(firstRun.includes("--session")).toBe(false);
		expect(replyArgv.includes("--session")).toBe(true);
		expect(replyArgv.at(replyArgv.indexOf("--session") + 1)).toBe(id);
		expect(replyArgv.at(-1)).toBe("again");
	});

	it("passes model before the prompt", async () => {
		const argvLog = join(ws.dir, `argv-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
		const client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", {
			prompt: "go",
			cwd: ws.dir,
			model: "minimax_oauth/MiniMax-M2.5",
			transport: "print",
		});
		client.close();
		expect(res.isError).toBe(false);
		const firstRun = JSON.parse(readFileSync(argvLog, "utf8").trim().split("\n")[0] ?? "[]") as string[];
		expect(firstRun).toContain("--model");
		expect(firstRun.at(firstRun.indexOf("--model") + 1)).toBe("minimax_oauth/MiniMax-M2.5");
		expect(firstRun.indexOf("--model")).toBeLessThan(firstRun.lastIndexOf("--"));
	});
});

describe("acp transport protocol", () => {
	it("initializes before creating a session and sending the first prompt", async () => {
		const stdinLog = join(ws.dir, `stdin-${Date.now()}.log`);
		const client = new Client({ ...ws.env, FAKE_STDIN_LOG: stdinLog }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "hello world", cwd: ws.dir });
		client.close();
		expect(res.isError).toBe(false);

		const lines = readStdinLog(stdinLog);
		const methods = lines.map((line) => line.method);
		expect(methods[0]).toBe("initialize");
		expect(lines[0]?.params?.protocolVersion).toBe(1);
		expect(methods).toContain("session/new");
		expect(methods).toContain("session/set_mode");
		expect(methods).toContain("session/set_config_option");
		expect(methods).toContain("session/prompt");
		expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("session/new"));
		expect(methods.indexOf("session/new")).toBeLessThan(methods.indexOf("session/prompt"));
		const mode = lines.find((line) => line.method === "session/set_mode");
		expect(mode?.params?.modeId).toBe("default");
		const perm = lines.find(
			(line) => line.method === "session/set_config_option" && line.params?.configId === "permissionMode",
		);
		expect(perm?.params?.value).toBe("bypassPermissions");
	});

	it("loads an existing session on reply", async () => {
		const stdinLog = join(ws.dir, `stdin-reply-${Date.now()}.log`);
		const client = new Client({ ...ws.env, FAKE_STDIN_LOG: stdinLog }, ws.dir);
		await client.handshake();
		const first = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(first.text);
		writeFileSync(stdinLog, "");
		await client.tool("mcode_reply", { session: id, prompt: "again", cwd: ws.dir });
		client.close();

		const methods = readStdinLog(stdinLog).map((line) => line.method);
		expect(methods).toContain("session/load");
		expect(methods).not.toContain("session/new");
	});

	it("sets the model via session/set_config_option", async () => {
		const stdinLog = join(ws.dir, `stdin-model-${Date.now()}.log`);
		const client = new Client({ ...ws.env, FAKE_STDIN_LOG: stdinLog }, ws.dir);
		await client.handshake();
		await client.tool("mcode", { prompt: "go", cwd: ws.dir, model: "minimax_oauth/MiniMax-M2.5" });
		client.close();
		const set = readStdinLog(stdinLog).find(
			(line) => line.method === "session/set_config_option" && line.params?.configId === "model",
		);
		expect(set?.params?.value).toBe("minimax_oauth/MiniMax-M2.5");
	});
});

describe("mcode_send", () => {
	it("aborts a waiting ACP turn", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "wait" }, ws.dir);
		await client.handshake();
		const pending = client.request("tools/call", {
			name: "mcode",
			arguments: { prompt: "hold", cwd: ws.dir },
		});
		const id = await waitForSession(client);
		const sent = await client.tool("mcode_send", { session: id, command: "abort" });
		expect(sent.isError).toBe(false);
		expect(sent.text).toContain("abort");
		const res = await pending.promise;
		client.close();
		expect(res.result.content[0].text).toContain("ABORTED AFTER INTERRUPT");
	});

	it("steers a waiting ACP turn", async () => {
		const client = new Client({ ...ws.env, FAKE_MODE: "wait" }, ws.dir);
		await client.handshake();
		const pending = client.request("tools/call", {
			name: "mcode",
			arguments: { prompt: "hold", cwd: ws.dir },
		});
		const id = await waitForSession(client);
		await client.tool("mcode_send", { session: id, command: "steer", message: "turn left" });
		const res = await pending.promise;
		client.close();
		expect(res.result.content[0].text).toContain("QUEUED TURN ANSWER: turn left");
	});

	it("reports print runs as unreachable", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode_send", { session: "session_nope", command: "abort" });
		client.close();
		expect(res.isError).toBe(true);
		expect(res.text).toContain("not currently running");
		expect(res.text).not.toContain("Print transport has no mid-run channel");
	});

	it("does not blame print after a finished ACP turn", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const first = await client.tool("mcode", { prompt: "go", cwd: ws.dir });
		const id = sessionIdOf(first.text);
		const sent = await client.tool("mcode_send", { session: id, command: "abort" });
		const running = await client.tool("mcode_running");
		client.close();
		expect(sent.isError).toBe(true);
		expect(sent.text).toContain("mcode_reply");
		expect(sent.text).not.toContain("Print transport");
		expect(running.text).not.toContain("Runs started with transport 'print'");
	});

	it("mentions print only when that session last ran as print", async () => {
		const client = new Client(ws.env, ws.dir);
		await client.handshake();
		const first = await client.tool("mcode", { prompt: "go", cwd: ws.dir, transport: "print" });
		const id = sessionIdOf(first.text);
		const sent = await client.tool("mcode_send", { session: id, command: "abort" });
		client.close();
		expect(sent.isError).toBe(true);
		expect(sent.text).toContain("last ran as print");
	});

	it("replies on the remembered print transport without an explicit flag", async () => {
		const argvLog = join(ws.dir, `argv-reply-${Date.now()}.log`);
		const client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		const first = await client.tool("mcode", { prompt: "go", cwd: ws.dir, transport: "print" });
		const id = sessionIdOf(first.text);
		writeFileSync(argvLog, "");
		await client.tool("mcode_reply", { session: id, prompt: "again", cwd: ws.dir });
		client.close();
		const replyArgv = JSON.parse(readFileSync(argvLog, "utf8").trim().split("\n")[0] ?? "[]") as string[];
		expect(replyArgv[0]).toBe("exec");
		expect(replyArgv).toContain("--session");
	});
});

async function waitForSession(client: Client): Promise<string> {
	for (let i = 0; i < 50; i++) {
		const running = await client.tool("mcode_running");
		if (!running.text.startsWith("No mcode turn")) {
			return sessionIdOfRunning(client);
		}
		await sleep(50);
	}
	throw new Error("no running session");
}
