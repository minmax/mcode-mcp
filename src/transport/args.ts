import { profileArgs } from "../profile.ts";
import type { RunPlan } from "./types.ts";

/**
 * `mcode exec` headless flags. Prompt is last after `--` so a leading dash in
 * the task text cannot be parsed as an option. argv is a string array — no shell.
 *
 * `--profile` is emitted before `--`, where mcode still reads options: after it
 * every token is prompt text, so a profile named there would be part of the task.
 *
 * `configPath` becomes `--config`: exec accepts an explicit runtime config for
 * this process, which is how a context window is set without touching the user's
 * own config.yaml. `mcode acp` has no such flag.
 */
export function printArgs(plan: RunPlan): string[] {
	const { overrides } = plan;
	const args: string[] = ["exec", "--output-format", "stream-json", "--cwd", plan.cwd];
	args.push(...profileArgs(plan.profile));
	if (overrides.permission) args.push("--permission", overrides.permission);
	if (overrides.model) args.push("--model", overrides.model);
	if (plan.configPath) args.push("--config", plan.configPath);
	if (plan.resume) args.push("--session", plan.sessionId);
	if (plan.timeoutMs !== undefined) args.push("--timeout", `${plan.timeoutMs}ms`);
	args.push("--", plan.prompt);
	return args;
}

export function agentArgs(profile: string | null = null): string[] {
	return ["acp", ...profileArgs(profile)];
}

/** ACP `permissionMode` config values. `off` is exec-only. */
export function acpPermissionMode(permission: string | undefined): "auto" | "bypassPermissions" | undefined {
	if (permission === "smart") return "auto";
	if (permission === "full") return "bypassPermissions";
	return undefined;
}
