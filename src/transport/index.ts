import { DEFAULT_TRANSPORT } from "../config.ts";
import { acpTransport } from "./acp.ts";
import { printTransport } from "./print.ts";
import type { Transport, TransportName } from "./types.ts";

export const TRANSPORTS: Record<TransportName, Transport> = {
	print: printTransport,
	acp: acpTransport,
};

export const TRANSPORT_NAMES = Object.keys(TRANSPORTS) as TransportName[];

export function isTransportName(value: unknown): value is TransportName {
	return typeof value === "string" && value in TRANSPORTS;
}

export function resolveTransport(requested: unknown): Transport {
	if (requested === undefined || requested === null) {
		return TRANSPORTS[DEFAULT_TRANSPORT];
	}
	if (!isTransportName(requested)) {
		throw new Error(`unknown transport "${String(requested)}"; expected one of ${TRANSPORT_NAMES.join(", ")}`);
	}
	return TRANSPORTS[requested];
}

export { waitFor } from "./acp.ts";
export { getRun, listRuns } from "./registry.ts";
export type { RunPlan, Transport, TransportName } from "./types.ts";
