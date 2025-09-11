let POLICY_DOC = {};
const ALIASES = {};
export function setPolicyDoc(doc) { POLICY_DOC = (doc ?? {}); }
export function getPolicyDoc() { return POLICY_DOC; }
export function registerAliases(map) {
    for (const [from, to] of Object.entries(map || {}))
        ALIASES[from] = to;
}
export function resolveAlias(tool) { return ALIASES[tool] ?? tool; }
