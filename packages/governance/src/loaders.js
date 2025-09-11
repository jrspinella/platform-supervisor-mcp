import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getPolicyDoc, setPolicyDoc } from "./store.js";
import { GovernanceDocSchema, GovernanceDocSchemaStrict, PolicyOnlySchema, PolicyOnlySchemaStrict, AtoOnlySchema, AtoOnlySchemaStrict, } from "./schemas.js";
export function deepMerge(a, b) {
    if (Array.isArray(a) && Array.isArray(b))
        return b; // lists override
    if (a && typeof a === "object" && b && typeof b === "object") {
        const out = { ...a };
        for (const k of Object.keys(b))
            out[k] = deepMerge(a?.[k], b[k]);
        return out;
    }
    return b ?? a;
}
function formatIssues(issues, source) {
    const lines = issues.map((i) => {
        const p = i.path?.length ? i.path.join(".") : "<root>";
        return ` - ${source} :: ${p} — ${i.message} (${i.code})`;
    });
    return lines.join("\n");
}
export class GovernanceValidationError extends Error {
    constructor(message) { super(message); this.name = "GovernanceValidationError"; }
}
const WARNINGS = [];
export function getValidationWarnings() { return [...WARNINGS]; }
export function clearValidationWarnings() { WARNINGS.length = 0; }
function collectWarningsStrict(doc, source, which) {
    const strict = which === "policy"
        ? PolicyOnlySchemaStrict
        : which === "ato"
            ? AtoOnlySchemaStrict
            : GovernanceDocSchemaStrict;
    const res = strict.safeParse(doc);
    if (!res.success) {
        const unknowns = res.error.issues.filter((i) => i.code === "unrecognized_keys");
        if (unknowns.length)
            WARNINGS.push(`Unknown keys in ${source}:\n${formatIssues(unknowns, source)}`);
    }
}
function validatePartial(doc, source) {
    const base = path.basename(source).toLowerCase();
    const which = base.includes("ato") ? "ato" : base.includes("policy") ? "policy" : "mixed";
    // warnings pass (strict): capture unknown keys but do not throw
    collectWarningsStrict(doc, source, which);
    // permissive pass: actual validation
    const schema = which === "policy" ? PolicyOnlySchema : which === "ato" ? AtoOnlySchema : GovernanceDocSchema;
    const parsed = schema.safeParse(doc);
    if (!parsed.success) {
        throw new GovernanceValidationError(`Invalid governance YAML in ${source}:\n${formatIssues(parsed.error.issues, source)}`);
    }
    return parsed.data;
}
export function loadPoliciesFromYaml(files) {
    clearValidationWarnings();
    let doc = {};
    for (const f of files ?? []) {
        if (!f)
            continue;
        const p = path.resolve(f);
        if (!fs.existsSync(p))
            continue;
        const raw = fs.readFileSync(p, "utf8");
        const y = YAML.parse(raw) || {};
        const v = validatePartial(y, p);
        doc = deepMerge(doc, v);
    }
    // Final whole-doc validation
    collectWarningsStrict(doc, "<merged>", "mixed");
    const final = GovernanceDocSchema.safeParse(doc);
    if (!final.success) {
        throw new GovernanceValidationError(`Invalid merged governance document:\n${formatIssues(final.error.issues, "<merged>")}`);
    }
    return final.data;
}
export function loadPoliciesFromDir(dir) {
    const ymls = ["policy.yaml", "policy.yml", "ato.yaml", "ato.yml"]
        .map((n) => path.join(dir, n))
        .filter((p) => fs.existsSync(p));
    return loadPoliciesFromYaml(ymls);
}
export function registerPolicies(doc) { setPolicyDoc(doc); }
export function ensureLoaded() {
    const current = getPolicyDoc();
    if (current && Object.keys(current).length)
        return current;
    const dir = process.env.GOV_POL_DIR || path.resolve(process.cwd(), "policies");
    const loaded = loadPoliciesFromDir(dir);
    setPolicyDoc(loaded);
    const warns = getValidationWarnings();
    if (warns.length)
        console.warn("[governance-core] validation warnings:\n" + warns.join("\n\n"));
    return loaded;
}
// ATO helpers (unchanged)
export function hasAtoProfile(domain, profile = "default") {
    const doc = ensureLoaded();
    const rules = doc?.ato?.profiles?.[profile]?.[domain]?.rules;
    return !!rules && typeof rules === "object" && Object.keys(rules).length > 0;
}
export function getAtoProfile(profile = "default") {
    const doc = ensureLoaded();
    return doc?.ato?.profiles?.[profile] ?? null;
}
export function getAtoRule(domain, profile = "default", code) {
    const doc = ensureLoaded();
    const r = doc?.ato?.profiles?.[profile]?.[domain]?.rules?.[code];
    if (!r)
        return null;
    return {
        controlIds: r.controls || r.controlIds || [],
        suggest: r.suggest || r.suggestion,
    };
}
