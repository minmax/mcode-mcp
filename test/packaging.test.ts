import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const distDir = join(root, "dist");

describe("runtime dependencies", () => {
	it("has no dependencies declared at all", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		expect(pkg.dependencies ?? {}).toEqual({});
		expect(pkg.private).toBe(true);
	});

	it("imports nothing outside node: builtins and relative paths", () => {
		for (const dir of [srcDir, distDir]) {
			if (!existsSync(dir)) continue;
			for (const file of readdirSync(dir, { recursive: true }) as string[]) {
				const full = join(dir, file);
				if (!statSync(full).isFile() || !(full.endsWith(".ts") || full.endsWith(".js"))) continue;
				const text = readFileSync(full, "utf8");
				const patterns = [
					/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm,
					/^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm,
					/\bimport\(\s*["']([^"']+)["']\s*\)/g,
				];
				for (const pattern of patterns) {
					for (const match of text.matchAll(pattern)) {
						const specifier = match[1] ?? "";
						const allowed =
							specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../");
						expect(allowed, `${full} has a runtime import of ${specifier}`).toBe(true);
					}
				}
			}
		}
	});
});

describe("packaging", () => {
	it("ships the built output and nothing else", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		expect(pkg.files).toContain("dist");
		expect(pkg.bin["mcode-mcp"]).toBe("dist/index.js");
		expect(pkg.files).not.toContain("src");
		expect(pkg.files).not.toContain("test");
	});

	it("declares the node version the code actually needs", () => {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		expect(pkg.engines.node).toBe(">=22");
	});
});
