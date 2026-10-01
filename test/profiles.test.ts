// Named auth profiles: the arithmetic that decides which account a run uses, and
// the proof that the flag, the child environment and the paths this server reads
// all agree with each other.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfigPath, withContextWindow } from "../src/minimax-config.ts";
import {
	childEnv,
	DEFAULT_PROFILE_NAME,
	dataDirForProfile,
	describeProfileState,
	InvalidProfileNameError,
	isValidProfileName,
	listProfiles,
	normalizeProfileSelector,
	profileArgs,
	profileDirExists,
	profileForCall,
	serverProfile,
} from "../src/profile.ts";
import { expectedTranscript, storeRoot } from "../src/transcript.ts";
import { agentArgs, printArgs } from "../src/transport/args.ts";
import { Client, type FakeRun, makeWorkspace, readFakeRuns, sessionIdOf, type Workspace } from "./helpers/client.ts";

let home: string;
const saved = new Map<string, string | undefined>();

/**
 * Point this process at a throwaway home and strip every variable that would
 * otherwise leak the developer's shell into an assertion: a `MINIMAX_PROFILE` in
 * the ambient environment would change which account these tests believe is the
 * default one, and the failure would look like a bug in the code under test.
 */
function isolateEnv(): void {
	home = mkdtempSync(join(tmpdir(), "mcode-mcp-profiles-"));
	for (const key of [
		"HOME",
		"MINIMAX_DATA_DIR",
		"MAVIS_DATA_DIR",
		"MINIMAX_PROFILE",
		"MCODE_MCP_PROFILE",
		"MCODE_MCP_MINIMAX_CONFIG",
	]) {
		saved.set(key, process.env[key]);
		process.env[key] = "";
	}
	process.env.HOME = home;
}

function restoreEnv(): void {
	for (const [key, value] of saved) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	saved.clear();
	rmSync(home, { recursive: true, force: true });
}

beforeEach(isolateEnv);
afterEach(restoreEnv);

const withHome = (env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ HOME: home, ...env });

/** Put an OAuth credential record where mcode keeps one. */
function seedCredentials(dataDir: string, extra: Record<string, unknown> = {}): void {
	const dir = join(dataDir, "auth", "prod", "cn", "client-1");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), JSON.stringify(extra));
}

describe("profile names", () => {
	it("accepts what mcode accepts and nothing that could escape the home directory", () => {
		for (const good of ["work", "Work", "a", "a.b", "a_b", "a-b", "9", "a".repeat(64)]) {
			expect(isValidProfileName(good), good).toBe(true);
		}
		for (const bad of ["", " ", ".", "..", "../etc", "a/b", "a\\b", "-a", "a-", ".hidden", "a b", "a".repeat(65)]) {
			expect(isValidProfileName(bad), bad).toBe(false);
		}
	});

	it("treats 'default' as no profile rather than as a second account", () => {
		// `~/.minimax-default` would be an invisible account holding its own token,
		// which is exactly the wrong-account failure profiles exist to prevent.
		expect(normalizeProfileSelector("default")).toBeNull();
		expect(normalizeProfileSelector("DEFAULT")).toBeNull();
		expect(normalizeProfileSelector("  ")).toBeNull();
		expect(normalizeProfileSelector(undefined)).toBeNull();
		expect(normalizeProfileSelector("work")).toBe("work");
	});

	it("refuses a bad name instead of falling back to the default account", () => {
		expect(() => normalizeProfileSelector("../../etc")).toThrow(InvalidProfileNameError);
		expect(() => normalizeProfileSelector(42)).toThrow(InvalidProfileNameError);
	});
});

describe("data directory", () => {
	it("suffixes the directory with a named profile", () => {
		expect(dataDirForProfile(null, withHome())).toBe(join(home, ".minimax"));
		expect(dataDirForProfile("work", withHome())).toBe(join(home, ".minimax-work"));
	});

	it("lets an explicit data dir outrank the profile, as mcode does", () => {
		const env = withHome({ MINIMAX_DATA_DIR: "/tmp/somewhere" });
		expect(dataDirForProfile("work", env)).toBe("/tmp/somewhere");
		expect(dataDirForProfile(null, env)).toBe("/tmp/somewhere");
	});

	it("expands ~ the way the session store always has", () => {
		expect(dataDirForProfile(null, withHome({ MAVIS_DATA_DIR: "~" }))).toBe(home);
		expect(dataDirForProfile(null, withHome({ MAVIS_DATA_DIR: "~/elsewhere" }))).toBe(join(home, "elsewhere"));
	});

	it("uses the same test of a profile as discovery, so the two cannot disagree", () => {
		// If the guard here were looser than discovery, `profile: "code"` would pass
		// it and put the credential store in the installer prefix.
		expect(profileDirExists("work", withHome())).toBe(false);
		mkdirSync(join(home, ".minimax-work"), { recursive: true });
		expect(profileDirExists("work", withHome())).toBe(false);
		seedCredentials(join(home, ".minimax-work"));
		expect(profileDirExists("work", withHome())).toBe(true);

		mkdirSync(join(home, ".minimax-code", "bin"), { recursive: true });
		writeFileSync(join(home, ".minimax-code", "package.json"), "{}");
		expect(profileDirExists("code", withHome())).toBe(false);
	});

	it("keeps a third-party provider's key from being read as a Token Plan key", () => {
		// Every provider in the file carries its own options.apiKey, and an
		// unscoped match would report an account with only such a key as ready.
		mkdirSync(join(home, ".minimax-work"), { recursive: true });
		writeFileSync(
			join(home, ".minimax-work", "config.yaml"),
			"providers:\n  openai:\n    options:\n      apiKey: sk-someone-else\n",
		);
		const work = listProfiles(withHome()).find((p) => p.name === "work");
		expect(work?.credentials).toBe("none");
	});

	it("does not read a cleared key as a credential", () => {
		mkdirSync(join(home, ".minimax-work"), { recursive: true });
		writeFileSync(join(home, ".minimax-work", "config.yaml"), 'minimax_api:\n  apiKey: ""\n');
		const work = listProfiles(withHome()).find((p) => p.name === "work");
		expect(work?.credentials).toBe("none");
	});

	it("finds a symlinked profile directory", () => {
		const elsewhere = join(home, "elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		seedCredentials(elsewhere);
		symlinkSync(elsewhere, join(home, ".minimax-work"));
		expect(listProfiles(withHome()).map((p) => p.name)).toContain("work");
	});

	it("keeps every store lookup inside its own profile", () => {
		expect(storeRoot("work")).toBe(join(home, ".minimax-work", "v2", "sessions"));
		expect(storeRoot(null)).toBe(join(home, ".minimax", "v2", "sessions"));
		expect(expectedTranscript("mvs_1", "work")).toContain(join(".minimax-work", "v2", "sessions"));
	});

	it("reads a profile's own config.yaml, and never invents one", () => {
		mkdirSync(join(home, ".minimax-work"), { recursive: true });
		expect(resolveConfigPath("work")).toBeNull();
		const config = join(home, ".minimax-work", "config.yaml");
		writeFileSync(config, "defaultModel: minimax/MiniMax-M3\n");
		expect(resolveConfigPath("work")).toBe(config);
		// The default profile is a different account with a different file.
		expect(resolveConfigPath(null)).toBeNull();
	});

	it("refuses to edit a config the run would not read", () => {
		// The override names one file while `--profile work` reads
		// ~/.minimax-work/config.yaml, so the write would succeed and the context
		// window would not move. Silently doing nothing is the one outcome worse
		// than an error.
		const override = join(home, "elsewhere.yaml");
		writeFileSync(override, "minimaxModelContextLimits: {}\n");
		process.env.MCODE_MCP_MINIMAX_CONFIG = override;
		return expect(withContextWindow("m", 512_000, "work", async () => "ran")).rejects.toThrow(
			/MCODE_MCP_MINIMAX_CONFIG/,
		);
	});
});

describe("profile selection", () => {
	it("prefers this server's own variable over mcode's", () => {
		expect(serverProfile(withHome({ MCODE_MCP_PROFILE: "work", MINIMAX_PROFILE: "personal" }))).toBe("work");
	});

	it("follows mcode's variable when it is the only one set", () => {
		// Otherwise the spawned mcode would join that account while this server kept
		// reading the default one, and the mismatch is silent.
		expect(serverProfile(withHome({ MINIMAX_PROFILE: "personal" }))).toBe("personal");
		expect(serverProfile(withHome())).toBeNull();
	});

	it("throws on a malformed variable rather than repairing it", () => {
		expect(() => serverProfile(withHome({ MCODE_MCP_PROFILE: "../evil" }))).toThrow(InvalidProfileNameError);
	});

	it("keeps a recorded default profile from being overridden by the server default", () => {
		// The failure this prevents: a session started before MCODE_MCP_PROFILE was
		// set, then resumed after it was, which would ask another account to load a
		// session id it never issued. The record is the stored name, so `default` is
		// spelled the way a record spells it.
		const env = withHome({ MCODE_MCP_PROFILE: "work" });
		expect(profileForCall(undefined, "default", env)).toBeNull();
		expect(profileForCall("", "default", env)).toBeNull();
		expect(profileForCall("default", "default", env)).toBeNull();
		expect(profileForCall("   ", "default", env)).toBeNull();
		// A legacy record with no profile has nothing to go on.
		expect(profileForCall(undefined, undefined, env)).toBe("work");
		expect(profileForCall("other", "work", env)).toBe("other");
		expect(profileForCall("default", "work", env)).toBeNull();
		expect(profileForCall(undefined, "work", env)).toBe("work");
	});

	it("refuses a stored name it cannot use, rather than reading it as the default", () => {
		// A state file is plain JSON that anything can write. Normalising an unusable
		// value would turn a corrupt record into "the default profile" and run the
		// session on an account it was never started in.
		const env = withHome({ MCODE_MCP_PROFILE: "work" });
		for (const stored of ["../../etc", "", "  ", "a/b"]) {
			expect(() => profileForCall(undefined, stored, env), stored).toThrow(InvalidProfileNameError);
		}
	});

	it("pins the profile into the child environment, and removes it for the default", () => {
		expect(childEnv("work", withHome({ MINIMAX_PROFILE: "stale" }))).toMatchObject({ MINIMAX_PROFILE: "work" });
		// An explicit `default` has to beat an ambient value, or a call that asked
		// for the default profile would silently land in another account.
		expect(childEnv(null, withHome({ MINIMAX_PROFILE: "stale" })).MINIMAX_PROFILE).toBeUndefined();
		// Nothing to normalise: the same object, not a copy.
		const clean = withHome();
		expect(childEnv(null, clean)).toBe(clean);
	});

	it("hands the child an absolute data dir, so a relative one cannot diverge", () => {
		// The server resolves a relative value against its own cwd and the child
		// against the task's; pinning it keeps the run and the read-back together.
		const env = withHome({ MINIMAX_DATA_DIR: "relative/dir" });
		expect(childEnv(null, env).MINIMAX_DATA_DIR).toBe(join(process.cwd(), "relative/dir"));
	});
});

describe("discovery", () => {
	it("finds profiles from the directory names, default first", () => {
		seedCredentials(join(home, ".minimax-work"));
		seedCredentials(join(home, ".minimax-personal"));
		expect(listProfiles(withHome()).map((p) => p.name)).toEqual([DEFAULT_PROFILE_NAME, "personal", "work"]);
	});

	it("does not list the installer directory, which shares the prefix", () => {
		// ~/.minimax-code is where mcode itself is installed. Listing it as a
		// profile named `code` would point a run's credential store at the install.
		mkdirSync(join(home, ".minimax-code", "bin"), { recursive: true });
		writeFileSync(join(home, ".minimax-code", "package.json"), "{}");
		// An empty directory is not a profile either: nothing in it can authenticate.
		mkdirSync(join(home, ".minimax-empty"), { recursive: true });
		expect(listProfiles(withHome()).map((p) => p.name)).toEqual([DEFAULT_PROFILE_NAME]);
	});

	it("reports an OAuth credential, and does not let a pending authorization hide it", () => {
		// A stored token whose auth-state still says `refreshing` is a signed-in
		// account; calling it pending would send the agent to sign in again.
		const dir = join(home, ".minimax-work");
		seedCredentials(dir);
		writeFileSync(
			join(dir, "auth", "prod", "cn", "client-1", "auth-state.json"),
			JSON.stringify({ status: "refreshing" }),
		);
		const work = listProfiles(withHome()).find((p) => p.name === "work");
		expect(work).toMatchObject({ credentials: "oauth", pendingAuthorization: true });
		expect(describeProfileState(work!)).toBe("signed in (OAuth)");
	});

	it("reports a Token Plan API key, which is not an OAuth credential", () => {
		// `mcode provider set-minimax-key` stores the key in config.yaml. Reporting
		// only auth/*.json would call a working account signed out.
		mkdirSync(join(home, ".minimax-work"), { recursive: true });
		writeFileSync(join(home, ".minimax-work", "config.yaml"), "minimax_api:\n  apiKey: sk-real-key\n");
		const work = listProfiles(withHome()).find((p) => p.name === "work");
		expect(work?.credentials).toBe("api-key");
		expect(describeProfileState(work!)).toBe("API key configured");
	});

	it("reports an authorization that has not finished, when there is nothing usable", () => {
		const dir = join(home, ".minimax-pending", "auth", "prod", "cn", "client-1");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "auth-state.json"), JSON.stringify({ status: "authorizing" }));
		const pending = listProfiles(withHome()).find((p) => p.name === "pending");
		expect(describeProfileState(pending!)).toBe("authorization pending");
	});

	it("counts a profile that still lives only in the legacy layout as existing", () => {
		// Reporting it as absent would hide stored credentials.
		const dir = join(home, ".mavis-old", "auth", "prod", "cn", "client-1");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "auth.json"), "{}");
		const old = listProfiles(withHome()).find((p) => p.name === "old");
		expect(old).toMatchObject({ exists: true, credentials: "oauth" });
	});

	it("deduplicates case only where the filesystem does", () => {
		// On macOS and Windows `.minimax-Work` and `.minimax-work` are one
		// directory. On Linux they are two accounts, and folding them there would
		// hide a real one behind whichever readdir returned first.
		seedCredentials(join(home, ".minimax-Work"));
		seedCredentials(join(home, ".minimax-work"));
		const names = listProfiles(withHome()).map((p) => p.name);
		const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
		expect(names).toEqual(
			caseInsensitive
				? [DEFAULT_PROFILE_NAME, "Work"]
				: [DEFAULT_PROFILE_NAME, "Work", "work"].sort((a, b) => a.localeCompare(b)),
		);
	});
});

describe("argv", () => {
	const plan = {
		cwd: "/tmp",
		sessionId: "s",
		prompt: "hello",
		overrides: {},
		profile: null as string | null,
		timeoutMs: undefined,
	};

	it("puts --profile where mcode still reads options", () => {
		expect(agentArgs(null)).toEqual(["acp"]);
		expect(agentArgs("work")).toEqual(["acp", "--profile", "work"]);

		const args = printArgs({ ...plan, profile: "work", timeoutMs: 1000 });
		expect(args.slice(0, 7)).toEqual([
			"exec",
			"--output-format",
			"stream-json",
			"--cwd",
			"/tmp",
			"--profile",
			"work",
		]);
		// After `--` everything is prompt text, so a profile there would be part of
		// the task rather than a selection.
		expect(args.indexOf("--")).toBeGreaterThan(args.indexOf("--profile"));
	});

	it("emits nothing for the default profile, so the default path is unchanged", () => {
		expect(profileArgs(null)).toEqual([]);
		expect(printArgs(plan)).not.toContain("--profile");
	});

	it("emits no --profile at all when a plan somehow lacks one", () => {
		// A bare `--profile` would make mcode read the *next* flag as the profile
		// name, so a plan that forgot the field would fail with "Invalid profile
		// name --permission" instead of running normally. The wire is built here, so
		// it is defended here.
		const incomplete = { ...plan };
		delete (incomplete as { profile?: string | null }).profile;
		expect(printArgs(incomplete)).toEqual(["exec", "--output-format", "stream-json", "--cwd", "/tmp", "--", "hello"]);
		expect(profileArgs(undefined)).toEqual([]);
		expect(profileArgs("")).toEqual([]);
	});
});

describe("what is advertised", () => {
	let ws: Workspace;
	let client: Client | undefined;

	beforeEach(() => {
		// MINIMAX_DATA_DIR is cleared so the profile directories under this test's
		// home are the only ones in play.
		ws = makeWorkspace({ HOME: home, MINIMAX_DATA_DIR: "" });
	});

	afterEach(() => {
		client?.close();
		ws.cleanup();
	});

	async function names(env: Record<string, string> = {}): Promise<string[]> {
		client = new Client({ ...ws.env, ...env }, ws.dir);
		await client.handshake();
		const list = await client.toolList();
		client.close();
		client = undefined;
		return list.map((tool) => tool.name).sort();
	}

	async function propertiesOf(env: Record<string, string> = {}): Promise<Record<string, string[]>> {
		client = new Client({ ...ws.env, ...env }, ws.dir);
		await client.handshake();
		const list = await client.toolList();
		const out: Record<string, string[]> = {};
		for (const tool of list) out[tool.name] = Object.keys(tool.inputSchema.properties ?? {});
		client.close();
		client = undefined;
		return out;
	}

	const WITHOUT_PROFILES = [
		"mcode",
		"mcode_context",
		"mcode_history",
		"mcode_models",
		"mcode_reply",
		"mcode_running",
		"mcode_send",
		"mcode_sessions",
	];

	it("advertises nothing profile-related when there is no profile", async () => {
		expect(await names()).toEqual(WITHOUT_PROFILES);
		for (const [tool, properties] of Object.entries(await propertiesOf())) {
			expect(properties, tool).not.toContain("profile");
		}
	});

	it("advertises one tool set per profile, named after it", async () => {
		// Two accounts are two tools, so a model can have both live at once.
		seedCredentials(join(home, ".minimax-work"));
		seedCredentials(join(home, ".minimax-personal"));
		const listed = await names();
		expect(listed).toContain("mcode_profiles");
		for (const profile of ["work", "personal"]) {
			expect(listed, profile).toContain(`mcode_${profile}`);
			for (const action of ["reply", "models", "context", "history"]) {
				expect(listed, `${profile}.${action}`).toContain(`mcode_${profile}_${action}`);
			}
		}
	});

	it("no longer advertises a profile argument on any tool", async () => {
		seedCredentials(join(home, ".minimax-work"));
		for (const [tool, properties] of Object.entries(await propertiesOf())) {
			expect(properties, tool).not.toContain("profile");
		}
	});

	it("keeps a profile whose name ends in a digit addressable next to its prefix", async () => {
		seedCredentials(join(home, ".minimax-work"));
		seedCredentials(join(home, ".minimax-work_2"));
		const listed = await names();
		expect(listed).toContain("mcode_work_2");
		expect(listed).toContain("mcode_work_2_reply");
		expect(listed).toContain("mcode_work_reply");
	});

	it("advertises a profile the server is pointed at but has not created yet", async () => {
		// Otherwise setting the variable would leave a server whose default account has
		// no tool at all, and the tool explaining how to fix that is one call away —
		// behind a tool that cannot work.
		expect(await names({ MCODE_MCP_PROFILE: "work" })).toContain("mcode_work");
		expect(await names({ MCODE_MCP_PROFILE: "", MINIMAX_PROFILE: "work" })).toContain("mcode_work");
	});

	it("runs several profiles at once from one server", async () => {
		seedCredentials(join(home, ".minimax-work"));
		seedCredentials(join(home, ".minimax-personal"));
		const argvLog = join(home, "argv.log");
		client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();

		const onWork = await client.tool("mcode_work", { prompt: "a" });
		const onPersonal = await client.tool("mcode_personal", { prompt: "b" });
		const onDefault = await client.tool("mcode", { prompt: "c" });
		expect([onWork, onPersonal, onDefault].map((r) => r.isError)).toEqual([false, false, false]);
		expect(onWork.text).toContain("[profile: work]");
		expect(onPersonal.text).toContain("[profile: personal]");
		expect(onDefault.text).not.toContain("[profile:");

		expect(readFakeRuns(argvLog).map((run) => run.argv.slice(0, 3))).toEqual([
			["acp", "--profile", "work"],
			["acp", "--profile", "personal"],
			["acp"],
		]);
	});

	it("refuses a `profile` argument instead of quietly running on another account", async () => {
		seedCredentials(join(home, ".minimax-work"));
		seedCredentials(join(home, ".minimax-personal"));
		const argvLog = join(home, "argv.log");
		client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		// A caller that still knows the old schema asked for an account. Ignoring the
		// argument would bill the default one; naming it on a pinned tool must not
		// move the call either.
		for (const name of ["mcode", "mcode_work", "mcode_work_history"]) {
			const res = await client.tool(name, { prompt: "do it", session: "x", profile: "personal" });
			expect(res.isError, name).toBe(true);
			expect(res.text, name).toContain("no `profile` argument");
		}
		expect(readFakeRuns(argvLog)).toEqual([]);
	});

	it("leaves a stray `profile` argument alone when no profile is in play", async () => {
		// The 0.2.0 surface, including ignoring what it never declared.
		const argvLog = join(home, "argv.log");
		client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		const res = await client.tool("mcode", { prompt: "do it", profile: "work" });
		expect(res.isError).toBe(false);
		expect(readFakeRuns(argvLog)[0]?.argv.slice(0, 2)).toEqual(["acp"]);
	});

	it("gives the default account a tool once the server default has moved off it", async () => {
		seedCredentials(join(home, ".minimax-work"));
		const argvLog = join(home, "argv.log");
		client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog, MCODE_MCP_PROFILE: "work" }, ws.dir);
		await client.handshake();
		const listed = (await client.toolList()).map((tool) => tool.name);
		expect(listed).toContain("mcode_default");
		expect(listed).toContain("mcode_default_reply");

		const onDefault = await client.tool("mcode_default", { prompt: "a" });
		const untargeted = await client.tool("mcode", { prompt: "b" });
		expect(onDefault.text).not.toContain("[profile:");
		expect(untargeted.text).toContain("[profile: work]");
		expect(readFakeRuns(argvLog).map((run) => run.argv.slice(0, 3))).toEqual([["acp"], ["acp", "--profile", "work"]]);
	});

	it("does not trip on the variable that is not the default", async () => {
		// Only the winning variable is validated at startup, so the other one can be
		// anything and must not take tools/list down.
		seedCredentials(join(home, ".minimax-work"));
		const listed = await names({ MCODE_MCP_PROFILE: "work", MINIMAX_PROFILE: "../../etc" });
		expect(listed).toContain("mcode_work");
		expect(listed.some((name) => name.includes("etc"))).toBe(false);
	});

	it("never advertises two tools under one name, or one that would run on the wrong account", async () => {
		// `work_reply` next to `work`: both would be `mcode_work_reply`. `reply` and
		// `models` would be the base tools' own names. A dot is not a portable tool name.
		for (const profile of ["work", "work_reply", "reply", "models", "a.b"]) {
			seedCredentials(join(home, `.minimax-${profile}`));
		}
		const listed = await names();
		expect(new Set(listed).size).toBe(listed.length);
		expect(listed).toContain("mcode_work_reply");
		expect(listed).toContain("mcode_work_history");
		expect(listed).not.toContain("mcode_work_reply_history");
		expect(listed.filter((name) => /[^A-Za-z0-9_-]/.test(name))).toEqual([]);

		// The surviving `mcode_work_reply` is `work`'s reply, never a task on `work_reply`.
		const argvLog = join(home, "argv.log");
		client = new Client({ ...ws.env, FAKE_ARGV_LOG: argvLog }, ws.dir);
		await client.handshake();
		const started = await client.tool("mcode_work", { prompt: "a" });
		const replied = await client.tool("mcode_work_reply", { session: sessionIdOf(started.text), prompt: "b" });
		expect(replied.isError).toBe(false);
		expect(readFakeRuns(argvLog).map((run) => run.argv.slice(0, 3))).toEqual([
			["acp", "--profile", "work"],
			["acp", "--profile", "work"],
		]);

		const listing = await client.tool("mcode_profiles", {});
		expect(listing.text).toContain("no tool of its own");
	});
});

describe("through the server", () => {
	let ws: Workspace;
	let client: Client | undefined;
	let argvLog: string;

	beforeEach(() => {
		argvLog = join(home, "argv.log");
		// HOME is redirected and the data dir cleared, so each profile really does
		// get its own store under this test's home.
		ws = makeWorkspace({ HOME: home, MINIMAX_DATA_DIR: "", FAKE_ARGV_LOG: argvLog });
		// A directory with nothing in it is not a profile, so give it the one entry
		// every signed-in profile has.
		seedCredentials(join(home, ".minimax-work"));
	});

	afterEach(() => {
		client?.close();
		ws?.cleanup();
	});

	const runs = (): FakeRun[] => readFakeRuns(argvLog);
	const clearRuns = (): void => writeFileSync(argvLog, "");

	async function open(env: Record<string, string> = {}): Promise<Client> {
		client = new Client({ ...ws.env, ...env }, ws.dir);
		await client.handshake();
		return client;
	}

	it("passes the profile to mcode and says which account answered", async () => {
		const c = await open();
		const res = await c.tool("mcode_work", { prompt: "do it" });
		expect(res.isError).toBe(false);
		expect(sessionIdOf(res.text)).toBeTruthy();
		expect(res.text).toContain("[profile: work]");

		const run = runs().find((r) => r.argv[0] === "acp");
		expect(run?.argv.slice(0, 3)).toEqual(["acp", "--profile", "work"]);
		// The child must agree with the flag, or a stale variable in the server's
		// own shell would send the run to a different account than the flag names.
		expect(run?.profileEnv).toBe("work");
	});

	it("leaves the default profile's argv and child environment alone", async () => {
		const c = await open();
		const res = await c.tool("mcode", { prompt: "do it" });
		expect(res.isError).toBe(false);
		expect(res.text).not.toContain("[profile:");
		const run = runs().find((r) => r.argv[0] === "acp");
		expect(run?.argv.slice(0, 1)).toEqual(["acp"]);
		expect(run?.profileEnv).toBeNull();
	});

	it("runs on the launch parameter's account, not always the default one", async () => {
		// The untargeted `mcode` is whatever the launch parameter selected. Naming an
		// account is the per-profile tool's job now, so the base tool has one meaning:
		// the server's default.
		const c = await open({ MCODE_MCP_PROFILE: "work" });
		const res = await c.tool("mcode", { prompt: "do it" });
		expect(res.isError).toBe(false);
		expect(res.text).toContain("[profile: work]");
		const run = runs().find((r) => r.argv[0] === "acp");
		expect(run?.argv.slice(0, 3)).toEqual(["acp", "--profile", "work"]);
	});
	it("follows mcode's own variable when this server's is not set", async () => {
		const c = await open({ MINIMAX_PROFILE: "work" });
		const res = await c.tool("mcode", { prompt: "do it" });
		expect(res.isError).toBe(false);
		expect(res.text).toContain("[profile: work]");
		expect(
			runs()
				.find((r) => r.argv[0] === "acp")
				?.argv.slice(0, 3),
		).toEqual(["acp", "--profile", "work"]);
	});

	it("cannot be called for an account that does not exist, at all", async () => {
		// A tool name only resolves to a profile that is real, so a mistyped account is
		// an unknown tool and nothing is spawned. That is stronger than validating an
		// argument: a name like `mcode_../../etc` has no profile to resolve to, so
		// there is no path for it to reach a directory at all.
		const c = await open();
		for (const name of ["mcode_wrok", "mcode_../../etc", "mcode_work_reply_2"]) {
			// A protocol error, not a tool result: there is no such account, so there is
			// no tool and nothing ran.
			const res = await c.call("tools/call", { name, arguments: { prompt: "do it" } });
			expect(res.error?.code, name).toBe(-32602);
		}
		expect(runs()).toEqual([]);
	});

	it("refuses the account the launch parameter names when it does not exist", async () => {
		// The one reachable case: the variable is honoured for the base tool and gets a
		// tool, but there is no account behind it yet, and saying so is better than
		// letting mcode create an empty one.
		const c = await open({ MCODE_MCP_PROFILE: "notyet" });
		const res = await c.tool("mcode_notyet", { prompt: "do it" });
		expect(res.isError).toBe(true);
		expect(res.text).toContain('no profile named "notyet"');
		expect(runs()).toEqual([]);
	});

	it("carries the session's own profile into mcode_reply, so it resumes in the same account", async () => {
		const c = await open();
		const started = await c.tool("mcode_work", { prompt: "first" });
		clearRuns();

		const replied = await c.tool("mcode_reply", { session: sessionIdOf(started.text), prompt: "second" });
		expect(replied.isError).toBe(false);
		expect(replied.text).toContain("[profile: work]");
		const reply = runs().find((r) => r.argv[0] === "acp");
		expect(reply?.argv.slice(0, 3)).toEqual(["acp", "--profile", "work"]);
		expect(reply?.profileEnv).toBe("work");
	});

	it("keeps a default-profile session on the default account after the default moves", async () => {
		// The wrong-account read this prevents: the session was started with no
		// profile at all, so its record says `default`, and a later server with
		// MCODE_MCP_PROFILE set must not move it.
		const first = await open();
		const started = await first.tool("mcode", { prompt: "first" });
		const session = sessionIdOf(started.text);
		first.close();
		client = undefined;

		const moved = await open({ MCODE_MCP_PROFILE: "work" });
		clearRuns();
		const replied = await moved.tool("mcode_reply", { session, prompt: "second" });
		expect(replied.isError).toBe(false);
		expect(replied.text).not.toContain("[profile:");
		const reply = runs().find((r) => r.argv[0] === "acp");
		expect(reply?.argv).toEqual(["acp"]);
		expect(reply?.profileEnv).toBeNull();
	});

	it("refuses to resume a session in another account", async () => {
		const c = await open();
		const started = await c.tool("mcode", { prompt: "first" });
		clearRuns();

		const res = await c.tool("mcode_work_reply", { session: sessionIdOf(started.text), prompt: "x" });
		expect(res.isError).toBe(true);
		expect(res.text).toContain("belongs to profile");
		expect(runs()).toEqual([]);
	});

	it("records the profile so the session list and the transcript find the right store", async () => {
		const c = await open();
		const started = await c.tool("mcode_work", { prompt: "first" });
		const session = sessionIdOf(started.text);

		const sessions = await c.tool("mcode_sessions", {});
		expect(sessions.text).toContain("profile work");

		// The transcript of a `work` session lives under ~/.minimax-work. The path is
		// the same arithmetic the code under test uses, which is the point: a
		// mismatch here would be the wrong-account read.
		const b64 = Buffer.from(session, "utf8").toString("base64");
		const sessionDir = join(home, ".minimax-work", "v2", "sessions", "2026", "10", "01", `10-00-session_${b64}`);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "messages.jsonl"),
			`${JSON.stringify({
				message_id: "u1",
				turn_id: "t1",
				message: { role: "user", content: [{ type: "text", text: "in the work account" }] },
			})}\n`,
		);

		const history = await c.tool("mcode_history", { session });
		expect(history.isError).toBe(false);
		const page = JSON.parse(history.text);
		expect(page.profile).toBe("work");
		expect(page.transcript).toContain(".minimax-work");
		expect(page.items[0].text).toBe("in the work account");

		// A cursor is a byte offset into one account's file, so it must not carry
		// over to another — and the refusal has to name that reason. The second
		// profile has to exist, or the guard answers first, which is a better error
		// but a different one.
		seedCredentials(join(home, ".minimax-personal"));
		const elsewhere = await c.tool("mcode_personal_history", { session, cursor: page.cursor });
		expect(elsewhere.text).toContain("issued for profile");
	});

	it("refuses a history cursor issued for a different profile, by name", async () => {
		seedCredentials(join(home, ".minimax-personal"));

		const c = await open();
		const started = await c.tool("mcode", { prompt: "first" });
		const session = sessionIdOf(started.text);
		const sessionDir = join(
			home,
			".minimax",
			"v2",
			"sessions",
			"2026",
			"10",
			"01",
			`10-00-session_${Buffer.from(session, "utf8").toString("base64")}`,
		);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "messages.jsonl"),
			`${JSON.stringify({ message_id: "u1", turn_id: "t1", message: { role: "user", content: [{ type: "text", text: "hi" }] } })}\n`,
		);
		const page = JSON.parse((await c.tool("mcode_history", { session })).text);

		const res = await c.tool("mcode_personal_history", { session, cursor: page.cursor });
		expect(res.isError).toBe(true);
		expect(res.text).toContain("issued for profile");
	});

	it("reads a blank profile as 'not specified', so a session keeps its account", async () => {
		const c = await open({ MCODE_MCP_PROFILE: "work" });
		const started = await c.tool("mcode", { prompt: "first" });
		clearRuns();

		// A blank string is the same "use your default" that `cwd` already reads as,
		// not a choice of the default profile. Reading it as a choice would refuse
		// the reply, and treating it as the server default would move the session.
		const replied = await c.tool("mcode_reply", { session: sessionIdOf(started.text), prompt: "second" });
		expect(replied.isError).toBe(false);
		expect(
			runs()
				.find((r) => r.argv[0] === "acp")
				?.argv.slice(0, 3),
		).toEqual(["acp", "--profile", "work"]);
	});

	it("finds a default-profile session's transcript, not a ~/.minimax-default one", async () => {
		// The record stores the literal name `default`, and that resolves to no
		// suffix at all. Handing it to the path resolver unnormalised would look for
		// ~/.minimax-default and report every default session as having no
		// transcript, which is the common case rather than an edge one.
		const c = await open();
		const started = await c.tool("mcode", { prompt: "first" });
		const session = sessionIdOf(started.text);
		const sessionDir = join(
			home,
			".minimax",
			"v2",
			"sessions",
			"2026",
			"10",
			"01",
			`10-00-session_${Buffer.from(session, "utf8").toString("base64")}`,
		);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(
			join(sessionDir, "messages.jsonl"),
			`${JSON.stringify({ message_id: "u1", turn_id: "t1", message: { role: "user", content: [{ type: "text", text: "default account" }] } })}\n`,
		);

		const sessions = await c.tool("mcode_sessions", {});
		expect(sessions.text).not.toContain("(no transcript on disk)");
		expect(sessions.text).toContain(".minimax/v2/sessions");
	});

	it("recovers an unclosed edit on the default profile while defaulting elsewhere", async () => {
		// The sweep must always include the default profile: it is reachable through
		// an explicit `profile: "default"`, so a leftover edit there is real.
		const config = join(home, ".minimax", "config.yaml");
		mkdirSync(join(home, ".minimax"), { recursive: true });
		const modelId = "MiniMax-M3";
		const patched = `minimaxModelContextLimits:\n  ${modelId}: 512000\n`;
		writeFileSync(config, patched);
		writeFileSync(
			`${config}.mcode-mcp-context-pending`,
			JSON.stringify({
				modelId,
				pid: 2 ** 30,
				createdAt: Date.now() - 60_000,
				text: patched,
				previousValue: "1000000",
				writtenValue: "512000",
			}),
		);

		await open({ MCODE_MCP_PROFILE: "work" });
		expect(existsSync(`${config}.mcode-mcp-context-pending`)).toBe(false);
		expect(readFileSync(config, "utf8")).toBe(`minimaxModelContextLimits:\n  ${modelId}: 1000000\n`);
	});

	it("carries the profile on the print transport and its reads", async () => {
		const c = await open();
		const started = await c.tool("mcode_work", { prompt: "first", transport: "print" });
		expect(started.isError).toBe(false);
		const run = runs().find((r) => r.argv[0] === "exec");
		expect(run?.argv.slice(0, 7)).toEqual([
			"exec",
			"--output-format",
			"stream-json",
			"--cwd",
			run?.argv[4] ?? "",
			"--profile",
			"work",
		]);
		expect(run?.profileEnv).toBe("work");
	});

	it("reads the model catalog against the named profile", async () => {
		const c = await open();
		const res = await c.tool("mcode_work_models", {});
		expect(res.isError).toBe(false);
		expect(
			runs()
				.find((r) => r.argv[0] === "acp")
				?.argv.slice(0, 3),
		).toEqual(["acp", "--profile", "work"]);
	});

	it("refuses a session record whose stored profile name is unusable", async () => {
		const c = await open({ MCODE_MCP_PROFILE: "work" });
		const started = await c.tool("mcode", { prompt: "first" });
		const session = sessionIdOf(started.text);
		c.close();
		client = undefined;

		// Corrupt the record the way anything writing plain JSON could.
		const stateFile = ws.stateFile;
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		state.sessions[session].profile = "../../etc";
		writeFileSync(stateFile, JSON.stringify(state));

		const reopened = await open({ MCODE_MCP_PROFILE: "work" });
		clearRuns();
		const res = await reopened.tool("mcode_reply", { session, prompt: "x" });
		// Fail closed: adopting the record would run this conversation on whichever
		// account the server now defaults to.
		expect(res.isError).toBe(true);
		expect(res.text).toContain("Invalid profile name");
		expect(runs()).toEqual([]);

		// Through a pinned tool as well: a thrown error would escape as a protocol
		// failure instead of a tool result.
		const pinned = await reopened.tool("mcode_work_reply", { session, prompt: "x" });
		expect(pinned.isError).toBe(true);
		expect(pinned.text).toContain("Invalid profile name");
		expect(runs()).toEqual([]);
	});

	it("keeps one corrupt record from taking the whole session list down", async () => {
		const c = await open();
		const good = await c.tool("mcode", { prompt: "first" });
		const bad = await c.tool("mcode", { prompt: "second" });
		c.close();
		client = undefined;

		const stateFile = ws.stateFile;
		const state = JSON.parse(readFileSync(stateFile, "utf8"));
		state.sessions[sessionIdOf(bad.text)].profile = "../../etc";
		writeFileSync(stateFile, JSON.stringify(state));

		const reopened = await open();
		const sessions = await reopened.tool("mcode_sessions", {});
		// The listing is how a session id is found, so one bad row has to degrade to
		// itself rather than fail the call.
		expect(sessions.isError).toBe(false);
		expect(sessions.text).toContain(sessionIdOf(good.text));
		expect(sessions.text).toContain("unusable stored profile");
	});

	it("answers mcode_profiles with the tool names that reach each account", async () => {
		const c = await open();
		const res = await c.tool("mcode_profiles", {});
		expect(res.isError).toBe(false);
		expect(res.text).toContain("mcode_work, mcode_work_reply");
		expect(res.text).toContain("mcode_work_context");
	});

	it("lists the profiles and marks the one it uses", async () => {
		seedCredentials(join(home, ".minimax-work"));
		const c = await open({ MCODE_MCP_PROFILE: "work" });
		const res = await c.tool("mcode_profiles", {});
		expect(res.isError).toBe(false);
		expect(res.text).toContain("* work");
		expect(res.text).toContain("signed in (OAuth)");
		expect(res.text).toContain("default (default)");
	});

	it("refuses a mistyped account on a read, instead of reporting a missing file", async () => {
		const c = await open();
		const started = await c.tool("mcode", { prompt: "first" });
		// "transcript not written yet" would read as a missing file rather than a
		// wrong name, and send the caller looking in the wrong place. An account that
		// does not exist has no tool at all.
		const res = await c.call("tools/call", {
			name: "mcode_wrok_history",
			arguments: { session: sessionIdOf(started.text) },
		});
		expect(res.error?.code).toBe(-32602);
	});

	it("warns that a redirected data dir collapses every profile onto one store", async () => {
		const c = await open({ MINIMAX_DATA_DIR: join(ws.dir, "redirected") });
		const res = await c.tool("mcode_profiles", {});
		expect(res.text).toContain("MINIMAX_DATA_DIR/MAVIS_DATA_DIR is set");
	});

	it("refuses to start on a malformed profile variable instead of using the default account", async () => {
		const broken = new Client({ ...ws.env, MCODE_MCP_PROFILE: "../evil" }, ws.dir);
		const exited = new Promise<number>((resolve) => broken.child.on("close", (code) => resolve(code ?? -1)));
		await new Promise((r) => setTimeout(r, 500));
		expect(await exited).toBe(2);
		broken.close();
	});

	it("refuses to start on mcode's malformed variable, with no explicit override of its own", async () => {
		const broken = new Client({ ...ws.env, MCODE_MCP_PROFILE: "", MINIMAX_PROFILE: "../evil" }, ws.dir);
		const exited = new Promise<number>((resolve) => broken.child.on("close", (code) => resolve(code ?? -1)));
		await new Promise((r) => setTimeout(r, 500));
		expect(await exited).toBe(2);
		broken.close();
	});

	it("recovers an unclosed context_window edit in a profile that is not the default", async () => {
		// Startup sweeps every profile, not only the one this server defaults to:
		// left behind, the next run on that profile would read the stale window as
		// the "original" value and restore that instead of the user's setting.
		const config = join(home, ".minimax-work", "config.yaml");
		const original = "defaultModel: minimax/MiniMax-M3\n";
		const modelId = "MiniMax-M3";
		const patched = `${original}minimaxModelContextLimits:\n  ${modelId}: 512000\n`;
		writeFileSync(config, patched);
		// What a crash between patching and rolling back leaves behind: the owner's
		// process is long gone, so it is fair game to roll back.
		writeFileSync(
			`${config}.mcode-mcp-context-pending`,
			JSON.stringify({
				modelId,
				pid: 2 ** 30,
				createdAt: Date.now() - 60_000,
				text: patched,
				previousValue: "1000000",
				writtenValue: "512000",
			}),
		);

		await open();
		expect(existsSync(`${config}.mcode-mcp-context-pending`)).toBe(false);
		expect(readFileSync(config, "utf8")).toBe(`${original}minimaxModelContextLimits:\n  ${modelId}: 1000000\n`);
	});
});
