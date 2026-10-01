import { describe, expect, it } from "vitest";
import { toolDefinitions } from "../src/tools.ts";

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

describe("tool annotations", () => {
	it("declares all four hints as explicit booleans on every tool", () => {
		for (const tool of toolDefinitions()) {
			for (const hint of HINTS) {
				expect(tool.annotations[hint], `${tool.name}.${hint}`).toBeTypeOf("boolean");
			}
		}
	});

	it("never calls a read-only tool destructive", () => {
		for (const tool of toolDefinitions()) {
			if (tool.annotations.readOnlyHint) {
				expect(tool.annotations.destructiveHint, tool.name).toBe(false);
			}
		}
	});
});
