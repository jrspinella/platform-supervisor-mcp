// packages/governance-core/src/load.ts
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { PolicyDoc } from "./types.js";
import { getPolicyDoc, setPolicyDoc } from "./store.js";
import {
  GovernanceDocSchema,
  GovernanceDocSchemaStrict,
  PolicyOnlySchema,
  PolicyOnlySchemaStrict,
  AtoOnlySchema,
  AtoOnlySchemaStrict,
} from "./schemas.js";

export function deepMerge(a: any, b: any): any {
  if (Array.isArray(a) && Array.isArray(b)) return b;
  if (a && typeof a === "object" && b && typeof b === "object") {
    const out: any = { ...a };
    for (const k of Object.keys(b)) out[k] = deepMerge(a?.[k], b[k]);
    return out;
  }
  return b ?? a;
}

function formatIssues(issues: readonly import("zod").ZodIssue[], source: string): string {
  const lines = issues.map((i) => {
    const p = i.path?.length ? i.path.join(".") : "<root>";
    return ` - ${source} :: ${p} — ${i.message} (${i.code})`;
  });
  return lines.join("\n");
}

export class GovernanceValidationError extends Error {
  constructor(message: string) { super(message); this.name = "GovernanceValidationError"; }
}

const WARNINGS: string[] = [];
export function getValidationWarnings() { return [...WARNINGS]; }
export function clearValidationWarnings() { WARNINGS.length = 0; }

function collectWarningsStrict(doc: any, source: string, which: "policy"|"ato"|"mixed") {
  const strict = which === "policy"
    ? PolicyOnlySchemaStrict
    : which === "ato"
    ? AtoOnlySchemaStrict
    : GovernanceDocSchemaStrict;
  const res = strict.safeParse(doc);
  if (!res.success) {
    const unknowns = res.error.issues.filter((i) => i.code === "unrecognized_keys");
    if (unknowns.length) WARNINGS.push(`Unknown keys in ${source}:\n${formatIssues(unknowns, source)}`);
  }
}

function validatePartial(doc: any, source: string): any {
  const base = path.basename(source).toLowerCase();
  const which: "policy"|"ato"|"mixed" = base.includes("ato") ? "ato" : base.includes("policy") ? "policy" : "mixed";

  collectWarningsStrict(doc, source, which);

  const schema = which === "policy" ? PolicyOnlySchema : which === "ato" ? AtoOnlySchema : GovernanceDocSchema;
  const parsed = schema.safeParse(doc);
  if (!parsed.success) {
    throw new GovernanceValidationError(
      `Invalid governance YAML in ${source}:\n${formatIssues(parsed.error.issues, source)}`
    );
  }
  return parsed.data;
}

export function loadPoliciesFromYaml(files: string[]): PolicyDoc {
  clearValidationWarnings();
  let doc: any = {};
  for (const f of files ?? []) {
    if (!f) continue;
    const p = path.resolve(f);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, "utf8");
    const y = YAML.parse(raw) || {};
    const v = validatePartial(y, p);
    doc = deepMerge(doc, v);
  }
  collectWarningsStrict(doc, "<merged>", "mixed");
  const final = GovernanceDocSchema.safeParse(doc);
  if (!final.success) {
    throw new GovernanceValidationError(
      `Invalid merged governance document:\n${formatIssues(final.error.issues, "<merged>")}`
    );
  }
  return final.data as PolicyDoc;
}

export function loadPoliciesFromDir(dir: string): PolicyDoc {
  const ymls = ["policy.yaml", "policy.yml", "ato.yaml", "ato.yml"]
    .map((n) => path.join(dir, n))
    .filter((p) => fs.existsSync(p));
  return loadPoliciesFromYaml(ymls);
}

export function registerPolicies(doc: PolicyDoc) { setPolicyDoc(doc); }

export function ensureLoaded(): PolicyDoc {
  const current = getPolicyDoc();
  if (current && Object.keys(current).length) return current;
  const dir = process.env.GOV_POL_DIR || path.resolve(process.cwd(), "policies");
  const loaded = loadPoliciesFromDir(dir);
  setPolicyDoc(loaded);
  const warns = getValidationWarnings();
  if (warns.length) console.warn("[governance-core] validation warnings:\n" + warns.join("\n\n"));
  return loaded;
}

// ATO helpers
export function hasAtoProfile(domain: string, profile = "default"): boolean {
  const doc = ensureLoaded();
  const rules = (doc as any)?.ato?.profiles?.[profile]?.[domain]?.rules;
  return !!rules && typeof rules === "object" && Object.keys(rules).length > 0;
}

export function getAtoProfile(profile = "default") {
  const doc = ensureLoaded();
  return (doc as any)?.ato?.profiles?.[profile] ?? null;
}

export function getAtoRule(domain: string, profile = "default", code: string): { controlIds?: string[]; suggest?: string } | null {
  const doc = ensureLoaded();
  const r = (doc as any)?.ato?.profiles?.[profile]?.[domain]?.rules?.[code];
  if (!r) return null;
  return {
    controlIds: r.controls || r.controlIds || [],
    suggest: r.suggest || r.suggestion,
  };
}