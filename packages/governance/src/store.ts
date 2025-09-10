// Single in-process stores. Make sure every import comes from *this* package path.
export type PolicyBlock = Record<string, any>;
export type PolicyMap = Record<string, PolicyBlock>;

const policyStore: PolicyMap = {};
const aliasStore: Record<string, string> = {};

export function getPolicies() { return policyStore; }
export function getAliases()  { return aliasStore; }

export function registerPolicies(map: PolicyMap) {
  for (const [k, v] of Object.entries(map)) policyStore[k] = v;
}

export function registerAliases(map: Record<string, string>) {
  for (const [from, to] of Object.entries(map)) aliasStore[from] = to;
}

export function resolveAlias(tool: string): string {
  return aliasStore[tool] ?? tool;
}