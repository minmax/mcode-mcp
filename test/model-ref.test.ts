import { describe, expect, it } from "vitest";
import {
	acpModelOptions,
	acpSelects,
	decodeAcpModelValue,
	formatModelRef,
	parseModelTarget,
	resolveAcpModelTarget,
} from "../src/model-ref.ts";

// A session's advertised model select, shaped like the one real 0.5.8 returns:
// Fast advertises a bare and a thinking entry, Pro only a thinking one.
const CONFIG_OPTIONS = [
	{ id: "permissionMode", type: "select", currentValue: "bypassPermissions", options: [] },
	{
		id: "model",
		type: "select",
		currentValue: "m:minimax:Fast:v:thinking",
		options: [
			{ value: "m:minimax:Fast:u", name: "Fast" },
			{ value: "m:minimax:Fast:v:thinking", name: "Fast · thinking" },
			{ value: "m:minimax:Pro:v:thinking", name: "Pro · thinking" },
		],
	},
];

describe("decoding an advertised ACP value", () => {
	it("reads the variantless form", () => {
		expect(decodeAcpModelValue("m:minimax:Fast:u")).toEqual({
			providerId: "minimax",
			modelId: "Fast",
			variant: null,
		});
	});

	it("reads a variant", () => {
		expect(decodeAcpModelValue("m:minimax:Fast:v:thinking")).toEqual({
			providerId: "minimax",
			modelId: "Fast",
			variant: "thinking",
		});
	});

	it("decodes percent-escaped components", () => {
		expect(decodeAcpModelValue("m:minimax:MiniMax%2DM3:v:none")).toEqual({
			providerId: "minimax",
			modelId: "MiniMax-M3",
			variant: "none",
		});
	});

	it("rejects anything that is not an advertised shape", () => {
		for (const bad of ["minimax/Fast", "m:minimax:Fast", "m:minimax:Fast:x:thinking", "m::Fast:u", ""]) {
			expect(decodeAcpModelValue(bad)).toBeNull();
		}
	});
});

describe("parsing what a caller asked for", () => {
	it("reads provider/model", () => {
		expect(parseModelTarget("minimax/Fast")).toEqual({ providerId: "minimax", modelId: "Fast", variant: null });
	});

	it("reads provider/model#variant", () => {
		expect(parseModelTarget("minimax/Fast#thinking")).toEqual({
			providerId: "minimax",
			modelId: "Fast",
			variant: "thinking",
		});
	});

	it("accepts an advertised value, so a copied row round-trips", () => {
		expect(parseModelTarget("m:minimax:Pro:v:thinking")).toEqual({
			providerId: "minimax",
			modelId: "Pro",
			variant: "thinking",
		});
	});

	it("is null for something that names no model", () => {
		for (const bad of ["Fast", "minimax/", "/Fast", "", "   "]) {
			expect(parseModelTarget(bad)).toBeNull();
		}
	});
});

describe("resolving a request against the advertised catalog", () => {
	it("keeps the session's current variant when the same model is named", () => {
		const resolved = resolveAcpModelTarget({ providerId: "minimax", modelId: "Fast", variant: null }, CONFIG_OPTIONS);
		expect(resolved).toEqual({ ok: true, value: "m:minimax:Fast:v:thinking", label: "Fast · thinking" });
	});

	it("honours an explicit variant", () => {
		const resolved = resolveAcpModelTarget(
			{ providerId: "minimax", modelId: "Fast", variant: "thinking" },
			CONFIG_OPTIONS,
		);
		expect(resolved).toEqual({ ok: true, value: "m:minimax:Fast:v:thinking", label: "Fast · thinking" });
	});

	it("picks the first advertised entry when switching to another model", () => {
		const resolved = resolveAcpModelTarget({ providerId: "minimax", modelId: "Pro", variant: null }, CONFIG_OPTIONS);
		expect(resolved).toEqual({ ok: true, value: "m:minimax:Pro:v:thinking", label: "Pro · thinking" });
	});

	it("sends the advertised string verbatim rather than building one", () => {
		const resolved = resolveAcpModelTarget(
			{ providerId: "minimax", modelId: "Fast", variant: "thinking" },
			CONFIG_OPTIONS,
		);
		expect(resolved).toEqual({ ok: true, value: "m:minimax:Fast:v:thinking", label: "Fast · thinking" });
	});

	it("refuses a model that was never advertised, and lists what was", () => {
		const resolved = resolveAcpModelTarget(
			{ providerId: "minimax_oauth", modelId: "MiniMax-M2.5", variant: null },
			CONFIG_OPTIONS,
		);
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.message).toContain("did not advertise minimax_oauth/MiniMax-M2.5");
		expect(resolved.message).toContain("minimax/Fast");
		expect(resolved.message).toContain("minimax/Pro");
	});

	it("refuses a variant that was never advertised, and lists the ones that were", () => {
		const resolved = resolveAcpModelTarget(
			{ providerId: "minimax", modelId: "Pro", variant: "none" },
			CONFIG_OPTIONS,
		);
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.message).toContain('variant "none"');
		expect(resolved.message).toContain("thinking");
	});

	it("says so when the session advertised no models at all", () => {
		const resolved = resolveAcpModelTarget({ providerId: "minimax", modelId: "Fast", variant: null }, [
			{ id: "model", type: "select", currentValue: undefined, options: [] },
		]);
		expect(resolved.ok).toBe(false);
		if (resolved.ok) return;
		expect(resolved.message).toContain("no model options");
		expect(resolved.message).toContain("print");
	});
});

describe("reading a session catalog", () => {
	it("returns only well-formed model entries", () => {
		const options = acpModelOptions([
			...CONFIG_OPTIONS,
			{ id: "model", type: "select", options: [{ value: "not-an-acp-value", name: "bogus" }] },
		]);
		expect(options.map((o) => o.value)).toEqual([
			"m:minimax:Fast:u",
			"m:minimax:Fast:v:thinking",
			"m:minimax:Pro:v:thinking",
		]);
	});

	it("is empty when configOptions is missing or nonsense", () => {
		expect(acpModelOptions(undefined)).toEqual([]);
		expect(acpModelOptions("nope")).toEqual([]);
		expect(acpSelects(null)).toEqual([]);
	});

	it("keeps the current value and the options of each select", () => {
		const selects = acpSelects(CONFIG_OPTIONS);
		expect(selects.map((s) => s.id)).toEqual(["permissionMode", "model"]);
		expect(selects[1]?.currentValue).toBe("m:minimax:Fast:v:thinking");
		expect(selects[1]?.options).toHaveLength(3);
	});
});

describe("formatting a target back for the print transport", () => {
	it("omits a missing variant and keeps one when present", () => {
		expect(formatModelRef({ providerId: "minimax", modelId: "Fast", variant: null })).toBe("minimax/Fast");
		expect(formatModelRef({ providerId: "minimax", modelId: "Fast", variant: "thinking" })).toBe(
			"minimax/Fast#thinking",
		);
	});

	it("round-trips through the parser", () => {
		const target = { providerId: "minimax", modelId: "MiniMax-M3", variant: "thinking" };
		expect(parseModelTarget(formatModelRef(target))).toEqual(target);
	});
});
