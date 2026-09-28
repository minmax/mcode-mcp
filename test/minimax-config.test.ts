import { describe, expect, it } from "vitest";
import { ConfigEditError, readDefaultModelId, restoreContextLimit, setContextLimit } from "../src/minimax-config.ts";

// The config is edited as text, on a file the user owns, and handed back
// afterwards. Two things are asserted throughout: the round trip is byte-exact,
// and an edit never touches an entry it did not write. The shapes below are the
// ones that a hand-edited config realistically contains — several of them
// corrupted the file when the edit rebuilt lines instead of patching them.

const BASE = [
	"defaultModel: minimax/MiniMax-M3.1-Flash-Preview",
	"defaultModelVariant: thinking",
	"defaultModelContextWindow: 1000000",
	"# a comment worth keeping",
	"provider:",
	"  minimax:",
	"    models:",
	"      MiniMax-M3:",
	"        limit:",
	"          context: 512000",
].join("\n");

function roundTrip(text: string, modelId: string, value: number): string | null {
	const edit = setContextLimit(text, modelId, value);
	expect(edit.text).not.toBe(text);
	return restoreContextLimit(edit.text, modelId, edit);
}

describe("context window edits round-trip byte for byte", () => {
	it("file with no such block", () => {
		expect(roundTrip(BASE, "MiniMax-M3", 1_000_000)).toBe(BASE);
	});

	it("file that already had the block", () => {
		const text = `${BASE}\nminimaxModelContextLimits:\n  MiniMax-M3: 512000\n`;
		expect(roundTrip(text, "MiniMax-M3.1-Flash-Preview", 1_000_000)).toBe(text);
	});

	it("trailing blank lines survive", () => {
		const text = `${BASE}\n\n\n`;
		expect(roundTrip(text, "MiniMax-M3", 1_000_000)).toBe(text);
	});

	it("file that has no trailing newline", () => {
		const text = BASE.replace(/\n$/, "");
		expect(roundTrip(text, "MiniMax-M3", 1_000_000)).toBe(text);
	});

	it("CRLF line endings", () => {
		const text = `${BASE}\r\n`;
		expect(roundTrip(text, "MiniMax-M3", 1_000_000)).toBe(text);
	});

	it("CRLF throughout, not just at the end", () => {
		const text = `${BASE.split("\n").join("\r\n")}\r\n`;
		expect(text).toContain("\r\n");
		expect(roundTrip(text, "MiniMax-M3", 1_000_000)).toBe(text);
	});

	it("a file that mixes CRLF and LF, which a global normaliser would flatten", () => {
		// The earlier implementation picked one terminator for the whole document
		// and rewrote the other's lines. Only a file with both can catch that.
		const text = `defaultModel: minimax/Fast\r\ndefaultModelVariant: thinking\npermissionMode: auto\r\n`;
		expect(roundTrip(text, "MiniMax-M3", 1_000_000)).toBe(text);
	});

	it("keeps each line's own terminator when the block is appended", () => {
		const text = "a: 1\r\nb: 2\nc: 3\r\n";
		const edit = setContextLimit(text, "M", 1_000_000);
		expect(edit.text).toContain("a: 1\r\n");
		expect(edit.text).toContain("b: 2\n");
		expect(restoreContextLimit(edit.text, "M", edit)).toBe(text);
	});

	it("a comment at column 0 inside the block", () => {
		const text = `${BASE}\nminimaxModelContextLimits:\n# a note\n  MiniMax-M3: 512000\n`;
		expect(roundTrip(text, "MiniMax-M3.1-Flash-Preview", 1_000_000)).toBe(text);
	});
});

describe("indentation and quoting of the entry under the key", () => {
	it("matches four-space indentation already used by the block", () => {
		const text = `${BASE}\nminimaxModelContextLimits:\n    MiniMax-M3: 512000\n`;
		const edit = setContextLimit(text, "MiniMax-M3", 1_000_000);
		// The rewritten line must keep the file's own indentation.
		expect(edit.text).toContain("    MiniMax-M3: 1000000");
		expect(restoreContextLimit(edit.text, "MiniMax-M3", edit)).toBe(text);
	});

	it("a new entry copies the indentation of its neighbours", () => {
		const text = `${BASE}\nminimaxModelContextLimits:\n    MiniMax-M3: 512000\n`;
		const edit = setContextLimit(text, "MiniMax-M2.7", 1_000_000);
		expect(edit.text).toContain("    MiniMax-M2.7: 1000000");
		expect(restoreContextLimit(edit.text, "MiniMax-M2.7", edit)).toBe(text);
	});

	it("keeps a quoted key and its trailing comment", () => {
		const text = `${BASE}\nminimaxModelContextLimits:\n  "MiniMax-M3": 512000 # mine\n`;
		const edit = setContextLimit(text, "MiniMax-M3", 1_000_000);
		expect(edit.text).toContain('"MiniMax-M3": 1000000 # mine');
		expect(restoreContextLimit(edit.text, "MiniMax-M3", edit)).toBe(text);
	});
});

describe("forms this server refuses rather than corrupts", () => {
	// Appending a second top-level key would leave a duplicate, and mcode's own
	// parser rejects the whole file. Refusing is the only safe answer.
	it("an inline flow map", () => {
		const text = `${BASE}\nminimaxModelContextLimits: {MiniMax-M3: 512000}\n`;
		const before = text;
		expect(() => setContextLimit(text, "MiniMax-M3", 1_000_000)).toThrow(ConfigEditError);
		expect(text).toBe(before);
	});

	it("a scalar value", () => {
		const text = `${BASE}\nminimaxModelContextLimits: null\n`;
		const before = text;
		expect(() => setContextLimit(text, "MiniMax-M3", 1_000_000)).toThrow(ConfigEditError);
		expect(text).toBe(before);
	});
});

describe("a key line that carries only a comment", () => {
	// `key: # comment` followed by indented lines is a valid block, so this is
	// edited rather than refused — but the comment must survive the round trip.
	it("is treated as a block and comes back untouched", () => {
		const text = `${BASE}\nminimaxModelContextLimits: # managed elsewhere\n`;
		const edit = setContextLimit(text, "MiniMax-M3", 1_000_000);
		expect(edit.text).toContain("minimaxModelContextLimits: # managed elsewhere\n  MiniMax-M3: 1000000");
		expect(restoreContextLimit(edit.text, "MiniMax-M3", edit)).toBe(text);
	});
});

describe("restore never overwrites somebody else", () => {
	it("when the entry was rewritten during the run", () => {
		const edit = setContextLimit(BASE, "MiniMax-M3", 1_000_000);
		const hijacked = edit.text.replace("MiniMax-M3: 1000000", "MiniMax-M3: 512000");
		expect(restoreContextLimit(hijacked, "MiniMax-M3", edit)).toBeNull();
	});

	it("when the block we created grew another entry", () => {
		const edit = setContextLimit(BASE, "MiniMax-M3", 1_000_000);
		const grown = `${edit.text}  MiniMax-M2.7: 512000\n`;
		expect(restoreContextLimit(grown, "MiniMax-M3", edit)).toBeNull();
	});
});

describe("default model lookup", () => {
	it("reads the model id out of defaultModel", () => {
		expect(readDefaultModelId(BASE)).toBe("MiniMax-M3.1-Flash-Preview");
	});

	it("handles CRLF and a trailing comment", () => {
		expect(readDefaultModelId("defaultModel: minimax/MiniMax-M3\r\npermissionMode: auto\r\n")).toBe("MiniMax-M3");
	});

	it("is null when the key is absent", () => {
		expect(readDefaultModelId("permissionMode: auto\n")).toBeNull();
	});
});
