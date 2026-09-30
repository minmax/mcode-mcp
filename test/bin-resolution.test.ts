import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMcodeBin } from "../src/config.ts";

const defaultLauncher = join(homedir(), ".minimax-code", "bin", "mcode");

describe("resolveMcodeBin", () => {
	it("prefers MCODE_MCP_BIN over everything else", () => {
		expect(resolveMcodeBin({ MCODE_MCP_BIN: "/opt/mcode" }, () => true)).toBe("/opt/mcode");
	});

	it("uses the installer launcher when it exists", () => {
		expect(resolveMcodeBin({}, (path) => path === defaultLauncher)).toBe(defaultLauncher);
	});

	it("follows MCODE_INSTALL_DIR for the launcher", () => {
		const launcher = join("/custom", "bin", "mcode");
		expect(resolveMcodeBin({ MCODE_INSTALL_DIR: "/custom" }, (path) => path === launcher)).toBe(launcher);
	});

	it("falls back to mcode on PATH when no launcher is installed", () => {
		expect(resolveMcodeBin({}, () => false)).toBe("mcode");
	});

	it("ignores a blank MCODE_MCP_BIN", () => {
		expect(resolveMcodeBin({ MCODE_MCP_BIN: "  " }, () => false)).toBe("mcode");
	});
});
