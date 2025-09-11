import { PolicyDoc } from "./types";

let POLICY_DOC: PolicyDoc = {};
const ALIASES: Record<string, string> = {};

export function setPolicyDoc(doc: PolicyDoc) { POLICY_DOC = (doc ?? {}) as PolicyDoc; }
export function getPolicyDoc(): PolicyDoc { return POLICY_DOC; }

export function registerAliases(map: Record<string, string>) {
  for (const [from, to] of Object.entries(map || {})) ALIASES[from] = to;
}
export function resolveAlias(tool: string): string { return ALIASES[tool] ?? tool; }