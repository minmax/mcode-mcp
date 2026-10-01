// Named auth profiles.
//
// MiniMax Code keeps several accounts side by side: a profile is an isolated
// data directory — `~/.minimax` for the implicit default and `~/.minimax-<name>`
// for a named one — holding that account's credentials, sessions and settings.
// On the wire it is mcode's `--profile <name>` flag on every command, plus
// `MINIMAX_PROFILE`; `mcode profile list` is the CLI's own view of it.
//
// The reason this server implements its own resolution rather than leaving it to
// mcode is that it *reads* the data directory as well as writing to it:
// transcripts, config.yaml, session records. Resolving those with the same
// arithmetic mcode uses is what keeps a run and the transcript read back
// afterwards from disagreeing about which account they belong to. A mismatch
// would be silent, and a silent mismatch means the wrong account's conversation.
//
// The name allowlist below mirrors MiniMax Code's own. It is a security
// boundary, not formatting: a name becomes a directory segment under the user's
// home, so an unvalidated `../../etc` would point the credential store outside it.
//
// One deliberate divergence: `mcode_profiles` walks the filesystem instead of
// shelling out to `mcode profile list`. The CLI command costs a cold start on
// every call and exists only on a build that has profiles at all, and this
// server has to keep working against one that does not. The cost is that the
// credential layout below is a copy of an implementation detail; it is kept to
// the few facts the listing actually reports, and a layout change would show a
// profile as having no credentials rather than inventing one.

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Display name of the implicit profile, which selects the unsuffixed data directory. */
export const DEFAULT_PROFILE_NAME = "default";

/** This server's own default-profile selector. Takes precedence over MiniMax Code's. */
export const PROFILE_ENV_VAR = "MCODE_MCP_PROFILE";

/**
 * MiniMax Code's own public selector.
 *
 * Honoured as a fallback so the two can never disagree: `runMcode` passes the
 * process environment straight through, so a `MINIMAX_PROFILE` set in the user's
 * shell would otherwise send every spawned mcode into a profile while this
 * server kept reading `~/.minimax`.
 */
export const MCODE_PROFILE_ENV_VAR = "MINIMAX_PROFILE";

const MAX_PROFILE_NAME_LENGTH = 64;

/**
 * Narrower than "no path separators": a name must start and end alphanumeric, so
 * `.`, `..` and dotfiles are impossible, and it may hold no separator, whitespace
 * or leading dash. The trailing restriction also keeps `--profile <name>`
 * unambiguous.
 */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

/**
 * Entries that mark a directory as a MiniMax Code data directory.
 *
 * Needed because the installer prefix `~/.minimax-code` shares the name prefix, so
 * without this `mcode profile list`-style discovery would offer a profile named
 * `code` and a run against it would put its credential store in the installation
 * directory. Any real profile has one of these, because signing in writes
 * `auth/` — and one that has not is one that cannot answer anyway.
 */
const DATA_DIR_ENTRIES = [
	"auth",
	"config.yaml",
	"codex-auth.json",
	"v2",
	"agents",
	"internal",
	"logs",
	"memory",
	"plugins",
	"plans",
	"sessions",
	"skills",
];

const DATA_DIR_BASENAME = ".minimax";
const LEGACY_DATA_DIR_BASENAME = ".mavis";
const CONFIG_FILE_NAME = "config.yaml";

/**
 * Windows and macOS resolve paths case-insensitively, so `Work` and `work` name
 * one directory there and two on Linux. Deduplicating unconditionally would hide
 * a real account on Linux, and readdir order would decide which one survived.
 */
const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";

/** Thrown when a profile name cannot be used safely as a directory segment. */
export class InvalidProfileNameError extends Error {
	constructor(profileName: string) {
		super(
			`Invalid profile name "${profileName}". Use 1-${MAX_PROFILE_NAME_LENGTH} letters, numbers, dots, ` +
				"underscores or hyphens, starting and ending with a letter or number.",
		);
		this.name = "InvalidProfileNameError";
	}
}

export function isValidProfileName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_PROFILE_NAME_LENGTH &&
		PROFILE_NAME_PATTERN.test(value)
	);
}

/**
 * @throws {InvalidProfileNameError} — a name is validated, never sanitised.
 * Guessing at the user's intent is worse than refusing a name that looks wrong.
 */
export function assertValidProfileName(value: string): string {
	if (!isValidProfileName(value)) throw new InvalidProfileNameError(value);
	return value;
}

/**
 * Turn a user-supplied selector into the internal `string | null`.
 *
 * Absent or blank means "no profile", and so does `default`: it is the display
 * name of the implicit profile, and treating it as an ordinary name would
 * resolve `~/.minimax-default` — a second, invisible account holding its own
 * token, which is exactly the wrong-account failure profiles exist to prevent.
 * `--profile default` therefore means the same as omitting the flag.
 */
export function normalizeProfileSelector(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") throw new InvalidProfileNameError(String(value));
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	if (trimmed.toLowerCase() === DEFAULT_PROFILE_NAME) return null;
	return assertValidProfileName(trimmed);
}

/**
 * The home every path in this module is resolved under.
 *
 * `HOME` first so a test or a wrapper can redirect it, falling back to
 * `os.homedir()` which is what mcode itself uses — on Windows that is
 * `USERPROFILE`, where `HOME` is often unset.
 */
function homeDir(env: NodeJS.ProcessEnv): string {
	return resolve(env.HOME?.trim() || homedir());
}

/** A path the user pointed us at explicitly, which wins over any profile. */
function configuredDataDir(env: NodeJS.ProcessEnv, home: string): string | null {
	const configured = env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim();
	if (configured === undefined || configured === "") return null;
	if (configured === "~") return home;
	if (configured.startsWith("~/")) return join(home, configured.slice(2));
	// Relative paths are resolved against *this* process's cwd, while mcode
	// resolves the same value against the task cwd. `childEnv` hands the child the
	// absolute form so a run and the read-back still agree.
	return resolve(configured);
}

/**
 * The data directory a profile selects, with the same precedence MiniMax Code
 * uses: an explicit `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` wins, otherwise the
 * profile decides.
 */
export function dataDirForProfile(profile: string | null, env: NodeJS.ProcessEnv = process.env): string {
	const home = homeDir(env);
	const configured = configuredDataDir(env, home);
	if (configured !== null) return configured;
	if (profile === null) return join(home, DATA_DIR_BASENAME);
	const primary = join(home, `${DATA_DIR_BASENAME}-${profile}`);
	// The compat layout, the same way mcode resolves it: the primary when it holds
	// data, the legacy directory when only that does. Resolving it here rather than
	// at each call site is what keeps the run guard, the transcript lookup, the
	// config path and the listing from disagreeing about a pre-migration profile.
	if (!isDataDir(primary)) {
		const legacy = join(home, `${LEGACY_DATA_DIR_BASENAME}-${profile}`);
		if (isDataDir(legacy)) return legacy;
	}
	return primary;
}

/** True when `env` points the data directory somewhere other than this profile's own. */
export function dataDirIsOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
	return configuredDataDir(env, homeDir(env)) !== null;
}

/**
 * True when `profile` names a directory that actually holds a MiniMax account.
 *
 * Both this and the listing ask the same question of the same resolver, so they
 * cannot disagree: a looser test here would let `profile: "code"` through into the
 * installer prefix, and a stricter one would refuse a profile the listing just
 * offered. A directory with nothing in it is refused because nothing in it can
 * authenticate — signing in writes `auth/`.
 */
export function profileDirExists(profile: string, env: NodeJS.ProcessEnv = process.env): boolean {
	return isDataDir(dataDirForProfile(profile, env));
}

/**
 * The profile every call uses unless it names another one.
 *
 * @throws {InvalidProfileNameError} on a malformed variable. The composition root
 * checks this once at startup and refuses to serve, because quietly falling back
 * to the default profile would bill the wrong account.
 */
export function serverProfile(env: NodeJS.ProcessEnv = process.env): string | null {
	const own = env[PROFILE_ENV_VAR];
	if (own !== undefined && own.trim() !== "") return normalizeProfileSelector(own);
	const mcode = env[MCODE_PROFILE_ENV_VAR];
	if (mcode !== undefined && mcode.trim() !== "") return normalizeProfileSelector(mcode);
	return null;
}

/**
 * Resolve the profile for one call.
 *
 * `input` is the call's own argument. Absent, empty or blank all mean "not
 * specified" — the same "use your default" the server already reads `cwd` as —
 * and fall through to `known`, the profile a session was recorded under, and then
 * to the server default. The explicit word `default` is different: it is a choice
 * of the implicit profile, and it overrides the record.
 *
 * A session's record is only consulted when the caller said nothing, which is
 * what lets `mcode_reply` and `mcode_history` reach a session started under a
 * different profile than the server now defaults to.
 *
 * @throws {InvalidProfileNameError}
 */
export function profileForCall(
	input: unknown,
	known?: string | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	if (typeof input === "string" && input.trim() === "") {
		// Blank means blank, not "the default profile": a caller that passes an
		// empty string has not chosen an account, so the record and then the server
		// default decide. Treating it as a choice of the default profile would
		// silently pull a session out of the account it was started in.
	} else {
		const explicit = normalizeProfileSelector(input);
		if (explicit !== null) return explicit;
		if (input !== undefined && input !== null) {
			// The caller named the default profile on purpose; that is a real answer
			// and must not be overridden by the record or the server default.
			return null;
		}
	}
	// Validated, not merely normalised: a stored name came from a plain JSON file
	// that anything can write, and one that cannot be used has to be refused where
	// it would be used. Normalising first would quietly turn an empty or corrupt
	// value into "the default profile" and run the session on the wrong account.
	if (known !== undefined) return normalizeProfileSelector(assertValidProfileName(known));
	return serverProfile(env);
}

export function profileArgs(profile: string | null | undefined): string[] {
	// Anything that is not a non-empty string means "no profile", rather than being
	// passed through. This builds the wire, and a malformed wire is the worst outcome
	// available: a bare `--profile` with nothing after it makes mcode read the *next*
	// flag as the profile name, so a plan that somehow lacked one would fail with a
	// baffling "Invalid profile name --permission" instead of running normally.
	return typeof profile === "string" && profile !== "" ? ["--profile", profile] : [];
}

/**
 * The environment a spawned mcode must see, with its profile pinned.
 *
 * The flag in argv is the primary route — identity travels through args, which
 * is what MiniMax Code's runtime boundary expects — but the environment is
 * normalised too, because a stale `MINIMAX_PROFILE` inherited from the server's
 * own shell would otherwise be a second, disagreeing source of truth.
 *
 * A relative `MINIMAX_DATA_DIR` / `MAVIS_DATA_DIR` is replaced by its absolute
 * form for the same reason: the server resolves it against its own cwd and the
 * child against the task's, so the value is pinned to what the server will read.
 */
export function childEnv(profile: string | null, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const configured = env.MINIMAX_DATA_DIR?.trim() || env.MAVIS_DATA_DIR?.trim();
	const needsDataDirPin = configured !== undefined && configured !== "" && !isAbsolutePath(configured);
	const has = env[PROFILE_ENV_VAR] !== undefined || env[MCODE_PROFILE_ENV_VAR] !== undefined;
	if (!has && profile === null && !needsDataDirPin) return env;

	const next = { ...env };
	if (profile === null) {
		delete next[PROFILE_ENV_VAR];
		delete next[MCODE_PROFILE_ENV_VAR];
	} else {
		next[MCODE_PROFILE_ENV_VAR] = profile;
	}
	if (needsDataDirPin && configured !== undefined) {
		const absolute = configuredDataDir(env, homeDir(env));
		if (absolute !== null) {
			if (next.MINIMAX_DATA_DIR !== undefined) next.MINIMAX_DATA_DIR = absolute;
			else next.MAVIS_DATA_DIR = absolute;
		}
	}
	return next;
}

function isAbsolutePath(value: string): boolean {
	return value === "~" || value.startsWith("~/") || resolve(value) === value;
}

export type CredentialState = "oauth" | "api-key" | "none";

export interface DiscoveredProfile {
	/** Profile name, or `default` for the unsuffixed directory. */
	name: string;
	/** Absolute data directory backing this profile. */
	dataDir: string;
	/** True when the directory exists on disk. */
	exists: boolean;
	/** How this profile holds credentials, if at all. */
	credentials: CredentialState;
	/** True when `auth-state.json` reports an authorization that has not finished. */
	pendingAuthorization: boolean;
}

function isDirectory(target: string): boolean {
	try {
		return statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** True when `target` holds a MiniMax Code data directory rather than an unrelated one. */
function isDataDir(target: string): boolean {
	if (!isDirectory(target)) return false;
	let entries: string[];
	try {
		entries = readdirSync(target);
	} catch {
		return false;
	}
	return entries.some((name) => DATA_DIR_ENTRIES.includes(name));
}

/**
 * What this profile holds, and whether a sign-in is still running.
 *
 * Two layouts, because MiniMax Code accepts two kinds of credential: OAuth lands
 * in `auth/<buildEnv>/<region>/<clientId>/auth.json`, and a Token Plan API key
 * (`mcode provider set-minimax-key`) lands in `config.yaml`. Reporting only the
 * first would call a perfectly working API-key profile signed out, and the agent
 * would refuse a usable account.
 *
 * The credential namespace is several path segments deep and the client id is a
 * build-time constant that may change, so the tree is walked to a bounded depth
 * and keyed off file names rather than a fixed number of segments. A layout
 * change would otherwise report every profile as having no credentials.
 */
function readCredentials(dataDir: string): { credentials: CredentialState; pendingAuthorization: boolean } {
	let oauth = false;
	let pendingAuthorization = false;

	const walk = (directory: string, depth: number): void => {
		if (depth > 4) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) {
				walk(entryPath, depth + 1);
				continue;
			}
			if (entry.name === "auth.json") oauth = true;
			if (entry.name !== "auth-state.json") continue;
			try {
				const status = (JSON.parse(readFileSync(entryPath, "utf8")) as { status?: unknown }).status;
				if (status === "authorizing" || status === "refreshing") pendingAuthorization = true;
			} catch {
				// Unreadable or mid-write: report nothing rather than guess.
			}
		}
	};

	walk(join(dataDir, "auth"), 0);

	return {
		credentials: oauth ? "oauth" : hasTokenPlanKey(dataDir) ? "api-key" : "none",
		pendingAuthorization,
	};
}

/**
 * Whether the profile holds a MiniMax Token Plan API key.
 *
 * A line-level scan, not a YAML parse, and scoped to the `minimax_api` block on
 * purpose. Every provider in the file carries its own `options.apiKey`, so an
 * unscoped match would report an account that only has some third-party key as
 * ready to answer, and an empty value would read as a credential too. Under-
 * reporting here is the safe direction: the agent tries an account it thought was
 * signed out, rather than skipping one that works. It can still miss an unusual
 * layout, which is the same trade.
 */
function hasTokenPlanKey(dataDir: string): boolean {
	let text: string;
	try {
		text = readFileSync(join(dataDir, CONFIG_FILE_NAME), "utf8");
	} catch {
		return false;
	}
	let inside = false;
	let indent = 0;
	for (const raw of text.split("\n")) {
		if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue;
		const leading = raw.length - raw.trimStart().length;
		if (inside && leading <= indent) inside = false;
		if (/^minimax_api:\s*(#.*)?$/.test(raw.trim())) {
			inside = true;
			indent = leading;
			continue;
		}
		if (!inside) continue;
		const match = /^apiKey:\s*(\S.*)$/.exec(raw.trim());
		// A quoted empty string is a key that was cleared, not one that is set.
		if (match && !["''", '""', "~", "null"].includes(match[1]?.trim() ?? "")) return true;
	}
	return false;
}

/**
 * Every profile present in the home directory, `default` first.
 *
 * Profiles are discovered from the directory names rather than a registry file,
 * so a profile that still holds credentials can never become invisible. Only
 * directories are considered: the installer prefix `~/.minimax-code` shares the
 * prefix, and listing it as a profile named `code` would point a run's credential
 * store at the installation directory.
 */
export function listProfiles(env: NodeJS.ProcessEnv = process.env): DiscoveredProfile[] {
	const home = homeDir(env);
	const names = new Map<string, string>([[DEFAULT_PROFILE_NAME, DEFAULT_PROFILE_NAME]]);

	const prefixes = [DATA_DIR_BASENAME, LEGACY_DATA_DIR_BASENAME].map((base) => `${base}-`);

	let entries: Dirent[];
	try {
		entries = readdirSync(home, { withFileTypes: true });
	} catch {
		entries = [];
	}
	for (const entry of entries) {
		// A symlink counts: `~/.mavis-work` is a compat link to `~/.minimax-work`,
		// and one created by hand is a legitimate way to point a profile elsewhere.
		// `isDirectory()` on a Dirent does not follow links, so it is checked here
		// and the real decision is made by the data-directory test below.
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
		for (const prefix of prefixes) {
			if (!entry.name.startsWith(prefix)) continue;
			const candidate = entry.name.slice(prefix.length);
			if (!isValidProfileName(candidate)) continue;
			// `~/.mavis-work` is a compat symlink to `~/.minimax-work`, so both
			// spell the same profile. Case folding is only correct where the
			// filesystem folds case too; on Linux the two are different accounts.
			const key = CASE_INSENSITIVE_FS ? candidate.toLowerCase() : candidate;
			if (!names.has(key)) names.set(key, candidate);
		}
	}

	const describe = (name: string): DiscoveredProfile => {
		const profile = name === DEFAULT_PROFILE_NAME ? null : name;
		const dataDir = dataDirForProfile(profile, { ...env, HOME: home });
		// A profile upgraded from the `~/.mavis-<name>` layout may still live only
		// there, so that is checked too — reporting it as absent would hide stored
		// credentials and make a removal refuse to clean it up.
		const legacyDir = profile === null ? null : join(home, `${LEGACY_DATA_DIR_BASENAME}-${profile}`);
		const current = isDataDir(dataDir);
		const legacy = legacyDir !== null && isDataDir(legacyDir);
		if (!current && !legacy) {
			return { name, dataDir, exists: false, credentials: "none", pendingAuthorization: false };
		}
		return { name, dataDir, exists: true, ...readCredentials(current ? dataDir : (legacyDir as string)) };
	};

	// `default` is always listed, whether or not anything is on disk: it is the
	// account every run falls back to, and a caller has to be able to ask about it.
	const described = [...names.values()]
		.sort((left, right) => {
			if (left === DEFAULT_PROFILE_NAME) return -1;
			if (right === DEFAULT_PROFILE_NAME) return 1;
			return left.localeCompare(right);
		})
		.map(describe);

	return described.filter((profile) => profile.exists || profile.name === DEFAULT_PROFILE_NAME);
}

/**
 * One line describing whether this profile can answer.
 *
 * A live credential outranks a pending authorization: a stored OAuth token whose
 * `auth-state.json` still says `refreshing` is a signed-in account, and calling
 * it pending would tell the agent to go and sign in again for no reason. The
 * pending state is only reported when there is nothing usable to wait for.
 */
/**
 * Whether profiles are worth putting in front of the caller at all.
 *
 * A user on a build of MiniMax Code without profile support, who has never named a
 * profile, should see the tool surface they had before this feature existed — not a
 * parameter that can only fail and a tool that lists nothing. So the answer is only
 * yes when a profile can actually change what a call does: the server has been
 * pointed at one, or one exists on disk.
 *
 * This decides what is *advertised*, never what is *honoured*: a caller that passes
 * `profile` is obeyed either way, because a client that knows about the feature
 * should not be second-guessed by what this machine happens to have.
 */
export function profilesAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	if ((env[PROFILE_ENV_VAR]?.trim() ?? "") !== "") return true;
	if ((env[MCODE_PROFILE_ENV_VAR]?.trim() ?? "") !== "") return true;
	return listProfiles(env).some((profile) => profile.name !== DEFAULT_PROFILE_NAME);
}

export function describeProfileState(profile: DiscoveredProfile): string {
	if (profile.credentials === "none" && profile.pendingAuthorization) return "authorization pending";
	if (profile.credentials === "oauth") return "signed in (OAuth)";
	if (profile.credentials === "api-key") return "API key configured";
	return profile.exists ? "signed out" : "not created";
}
