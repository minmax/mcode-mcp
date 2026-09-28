// One model reference, two different vocabularies.
//
//	print  provider/model            or  provider/model#variant
//	ACP    m:<provider>:<model>:u            (the variantless entry)
//	       m:<provider>:<model>:v:<variant>
//
// MiniMax Code's own guidance for ACP clients (minimax-code#176) is that option
// values are opaque: take them from the session's advertised configOptions and
// hand them back unchanged. Nothing here invents one. decodeAcpModelValue only
// *reads* an advertised value to learn which model it stands for, and
// resolveAcpModelValue always returns a string the server actually advertised —
// which is why `minimax_oauth/MiniMax-M2.5` or a bare `MiniMax-M3` is rejected
// outright instead of being sent and bounced by the server's strict parser.

/** A model as it is identified regardless of transport. `variant` is the `:u` form when null. */
export interface ModelTarget {
	providerId: string;
	modelId: string;
	variant: string | null;
}

export interface AcpModelOption {
	/** The opaque value exactly as the server advertised it. */
	value: string;
	label: string;
	target: ModelTarget;
}

const ACP_PREFIX = "m:";

function decodePart(part: string): string {
	try {
		return decodeURIComponent(part);
	} catch {
		// A malformed escape is not a reason to drop the whole value: the raw
		// text is still what the server sent, so keep it and let matching fail.
		return part;
	}
}

/** Parse `m:<provider>:<model>:u` / `m:<provider>:<model>:v:<variant>`. */
export function decodeAcpModelValue(value: string): ModelTarget | null {
	if (!value.startsWith(ACP_PREFIX)) return null;
	const parts = value.split(":");
	if (parts.length < 4 || parts[0] !== "m") return null;
	const [providerId, modelId] = [decodePart(parts[1] ?? ""), decodePart(parts[2] ?? "")];
	if (providerId === "" || modelId === "") return null;

	const kind = parts[3];
	if (kind === "u" && parts.length === 4) return { providerId, modelId, variant: null };
	if (kind === "v" && parts.length === 5) {
		const variant = decodePart(parts[4] ?? "");
		return { providerId, modelId, variant: variant === "" ? null : variant };
	}
	return null;
}

/** Inverse of {@link decodeAcpModelValue}. Kept for tests and for readable diffs. */
export function encodeAcpModelValue(target: ModelTarget): string {
	const head = [ACP_PREFIX, encodeURIComponent(target.providerId), encodeURIComponent(target.modelId)];
	return target.variant === null
		? [...head, "u"].join(":")
		: [...head, "v", encodeURIComponent(target.variant)].join(":");
}

/**
 * Parse what a caller passed as `model`.
 *
 * Accepts the print spelling (`provider/model`, optionally `#variant`) and, so a
 * value copied out of `mcode_models` round-trips, an already-encoded ACP value.
 */
export function parseModelTarget(raw: string): ModelTarget | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;

	const encoded = decodeAcpModelValue(trimmed);
	if (encoded !== null) return encoded;

	const [path, ...rest] = trimmed.split("#");
	const variant = rest.length > 0 ? rest.join("#").trim() || null : null;
	const slash = path?.indexOf("/") ?? -1;
	if (slash <= 0 || !path) return null;
	const providerId = path.slice(0, slash).trim();
	const modelId = path.slice(slash + 1).trim();
	if (providerId === "" || modelId === "") return null;
	return { providerId, modelId, variant };
}

/** Render a target back into the spelling `mcode exec --model` understands. */
export function formatModelRef(target: ModelTarget): string {
	return target.variant === null
		? `${target.providerId}/${target.modelId}`
		: `${target.providerId}/${target.modelId}#${target.variant}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** The `model` select out of an ACP session's advertised configOptions. */
export function acpModelOptions(configOptions: unknown): AcpModelOption[] {
	const list = Array.isArray(configOptions) ? configOptions : [];
	const modelOption = list.map(asRecord).find((opt) => opt?.id === "model");
	if (modelOption === undefined || modelOption === null) return [];

	const options = Array.isArray(modelOption.options) ? modelOption.options : [];
	const out: AcpModelOption[] = [];
	for (const raw of options) {
		const option = asRecord(raw);
		if (option === null) continue;
		const value = option.value;
		if (typeof value !== "string") continue;
		const target = decodeAcpModelValue(value);
		if (target === null) continue;
		const label = typeof option.name === "string" && option.name !== "" ? option.name : formatModelRef(target);
		out.push({ value, label, target });
	}
	return out;
}

export type ResolvedModel = { ok: true; value: string; label: string } | { ok: false; message: string };

function advertisedSummary(options: AcpModelOption[]): string {
	const seen = new Map<string, string>();
	for (const option of options) {
		const key = `${option.target.providerId}/${option.target.modelId}`;
		if (!seen.has(key)) seen.set(key, option.label);
	}
	return [...seen.keys()].join(", ");
}

/**
 * Pick the advertised ACP value that stands for `target`.
 *
 * With no explicit `#variant` we prefer the entry the session is already on for
 * that model, so a bare `provider/model` means "this model, as configured"
 * rather than silently flipping the reasoning variant.
 */
export function resolveAcpModelTarget(target: ModelTarget, configOptions: unknown): ResolvedModel {
	const options = acpModelOptions(configOptions);
	if (options.length === 0) {
		return {
			ok: false,
			message:
				"mcode advertised no model options on this session, so a model cannot be selected over ACP. " +
				"Run mcode_models to see the catalog, or pass transport: 'print', where --model takes provider/model.",
		};
	}

	const matches = options.filter(
		(option) => option.target.providerId === target.providerId && option.target.modelId === target.modelId,
	);
	if (matches.length === 0) {
		return {
			ok: false,
			message:
				`mcode did not advertise ${target.providerId}/${target.modelId}. ` +
				`Advertised: ${advertisedSummary(options) || "(none)"}. ` +
				"Run mcode_models for the exact provider/model spelling.",
		};
	}

	if (target.variant !== null) {
		const exact = matches.find((option) => option.target.variant === target.variant);
		if (exact === undefined) {
			const variants = matches.map((option) => option.target.variant ?? "(no variant)").join(", ");
			return {
				ok: false,
				message:
					`mcode did not advertise ${target.providerId}/${target.modelId} with variant "${target.variant}". ` +
					`Advertised variants: ${variants}.`,
			};
		}
		return { ok: true, value: exact.value, label: exact.label };
	}

	const list = configOptions as unknown;
	const current = Array.isArray(list)
		? list.map(asRecord).find((opt) => opt?.id === "model")?.currentValue
		: undefined;
	const currentTarget = typeof current === "string" ? decodeAcpModelValue(current) : null;
	const preferred =
		currentTarget && currentTarget.providerId === target.providerId && currentTarget.modelId === target.modelId
			? matches.find((option) => option.target.variant === currentTarget.variant)
			: undefined;
	const chosen = preferred ?? matches[0];
	if (chosen === undefined) {
		return { ok: false, message: `mcode advertised no usable entry for ${formatModelRef(target)}.` };
	}
	return { ok: true, value: chosen.value, label: chosen.label };
}

/** Group a session's advertised selects into the shape `mcode_models` prints. */
export interface AcpSelect {
	id: string;
	type: string;
	currentValue?: string;
	options: { value: string; name: string }[];
}

export function acpSelects(configOptions: unknown): AcpSelect[] {
	const list = Array.isArray(configOptions) ? configOptions : [];
	const out: AcpSelect[] = [];
	for (const raw of list) {
		const option = asRecord(raw);
		if (option === null) continue;
		const id = typeof option.id === "string" ? option.id : undefined;
		if (id === undefined) continue;
		const options: { value: string; name: string }[] = [];
		for (const optRaw of Array.isArray(option.options) ? option.options : []) {
			const opt = asRecord(optRaw);
			if (opt === null || typeof opt.value !== "string") continue;
			options.push({ value: opt.value, name: typeof opt.name === "string" ? opt.name : opt.value });
		}
		out.push({
			id,
			type: typeof option.type === "string" ? option.type : "unknown",
			...(typeof option.currentValue === "string" ? { currentValue: option.currentValue } : {}),
			options,
		});
	}
	return out;
}
