import fs from "node:fs";
import path from "node:path";
import { Policy, EvalResult, Check } from "./types.js";


const DEFAULT_POLICIES_PATH = path.resolve(process.cwd(), "packages/governance/policies.json");


function get(obj: any, dotted: string) {
    return dotted.split(".").reduce((o, k) => (o ? o[k] : undefined), obj);
}


function runCheck(args: any, c: Check): string | undefined {
    const v = get(args, c.path);
    switch (c.type) {
        case "regex": {
            const ok = typeof v === "string" && new RegExp(c.pattern).test(v);
            return ok ? undefined : (c.message || `Field '${c.path}' must match ${c.pattern}`);
        }
        case "noSpaces": {
            const has = typeof v === "string" && v.includes(" ");
            return has ? (c.message || `Field '${c.path}' must not contain spaces`) : undefined;
        }
        case "allowedValues": {
            const ok = c.values.includes(String(v));
            return ok ? undefined : (c.message || `Field '${c.path}' must be one of: ${c.values.join(", ")}`);
        }
        case "requiredTags": {
            const m: string[] = [];
            for (const k of c.keys) {
                if (!v || typeof v !== "object" || !(k in v)) m.push(k);
            }
            return m.length ? (c.message || `Missing required tags: ${m.join(", ")}`) : undefined;
        }
    }
}


function loadPolicies(customPath?: string): Policy[] {
    const p = customPath || process.env.GOVERNANCE_POLICY_FILE || DEFAULT_POLICIES_PATH;
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8"));
}


export function evaluate(tool: string, args: any, customPath?: string): EvalResult {
    const policies = loadPolicies(customPath);
    const hits = policies.filter((p) => p.target.tool === tool || p.target.prefix === tool.split(".")[0]);
    let decision: EvalResult["decision"] = "allow";
    const reasons: string[] = [];
    const policyIds: string[] = [];


    for (const pol of hits) {
        const localReasons: string[] = [];
        for (const c of pol.checks) {
            const r = runCheck(args, c);
            if (r) localReasons.push(r);
        }
        if (localReasons.length) {
            policyIds.push(pol.id);
            reasons.push(`${pol.id}: ${localReasons.join("; ")}`);
            if (pol.effect === "deny") decision = "deny";
            else if (pol.effect === "warn" && decision === "allow") decision = "warn";
        }
    }
    return { decision, reasons, policyIds };
}