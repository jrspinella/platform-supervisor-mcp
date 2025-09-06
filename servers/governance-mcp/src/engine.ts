// governance/src/engine.ts
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Policy, EvalResult, Check, Suggestion } from "./types.js";

function safeStat(p: string) { try { return fs.statSync(p); } catch { return null; } }

// -------- path resolution (robust) --------
function resolveRulesRoot() {
  // Prefer explicit directory; fall back to ./governance
  const dir = process.env.GOVERNANCE_RULES_DIR
    ? path.resolve(process.env.GOVERNANCE_RULES_DIR)
    : path.resolve(process.cwd(), "governance");
  return dir;
}

const ROOT_DIR  = resolveRulesRoot();
const POLICY_JSON = path.join(ROOT_DIR, "policy.json");
const POLICY_YAML = path.join(ROOT_DIR, "policy.yaml");
const ATO_YAML    = path.join(ROOT_DIR, "ato.yaml");

// ---- utils ----
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
    case "requiredTrue": {
      return v === true ? undefined : (c.message || `Field '${c.path}' must be true`);
    }
    case "requiredPresent": {
      const present = v !== undefined && v !== null && !(typeof v === "string" && v.trim() === "");
      return present ? undefined : (c.message || `Field '${c.path}' is required`);
    }
    case "equals": {
      return v === c.value ? undefined : (c.message || `Field '${c.path}' must equal ${JSON.stringify(c.value)}`);
    }
    case "notEquals": {
      return v !== c.value ? undefined : (c.message || `Field '${c.path}' must not equal ${JSON.stringify(c.value)}`);
    }
  }
}

// ---- loaders/compilers ----
function loadJsonPolicies(filePath: string): Policy[] {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// Compile your policy.yaml DSL into Policy[]
function compilePolicyYaml(doc: any): Policy[] {
  const out: Policy[] = [];
  const az = doc?.azure || {};

  // ---------- azure.create_resource_group ----------
  const rg = az.create_resource_group;
  if (rg) {
    // deny_names -> negative lookahead on args.name
    if (Array.isArray(rg.deny_names) && rg.deny_names.length) {
      const alternation = rg.deny_names
        .map((s: string) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("|");
      out.push({
        id: "azure.rg.denyNames",
        description: "Disallow specific RG names",
        target: { tool: "azure.create_resource_group" },
        effect: "deny",
        checks: [{
          type: "regex",
          path: "name",
          pattern: `^(?!.*\\b(${alternation})\\b).+$`,
          message: `RG name cannot contain: ${rg.deny_names.join(", ")}`
        }]
      });
    }

    // name_regex -> regex on args.name
    if (rg.name_regex) {
      out.push({
        id: "azure.rg.nameRegex",
        description: "RG name must match pattern",
        target: { tool: "azure.create_resource_group" },
        effect: "deny",
        checks: [{ type: "regex", path: "name", pattern: String(rg.name_regex) }]
      });
    }

    // allowed_regions -> allowedValues on args.location
    if (Array.isArray(rg.allowed_regions) && rg.allowed_regions.length) {
      out.push({
        id: "azure.rg.allowedRegions",
        description: "Allowed RG locations",
        target: { tool: "azure.create_resource_group" },
        effect: "deny",
        checks: [{ type: "allowedValues", path: "location", values: rg.allowed_regions.map(String) }]
      });
    }

    // require_tags -> requiredTags on args.tags
    if (Array.isArray(rg.require_tags) && rg.require_tags.length) {
      out.push({
        id: "azure.rg.requiredTags",
        description: "Required RG tags",
        target: { tool: "azure.create_resource_group" },
        effect: "deny",
        checks: [{ type: "requiredTags", path: "tags", keys: rg.require_tags.map(String) }]
      });
    }

    // suggestions (attached to warn-only helper so they show on violations)
    if (rg.suggest_name) {
      out.push({
        id: "azure.rg.suggestName",
        description: "Name suggestion",
        target: { tool: "azure.create_resource_group" },
        effect: "warn",
        checks: [{ type: "regex", path: "name", pattern: ".*" }], // always evaluates, produces warn with suggest
        suggest: { title: "Name Suggestion", text: `Try name like: ${rg.suggest_name}` }
      });
    }
    if (rg.suggest_region) {
      out.push({
        id: "azure.rg.suggestRegion",
        description: "Region suggestion",
        target: { tool: "azure.create_resource_group" },
        effect: "warn",
        checks: [{ type: "regex", path: "location", pattern: ".*" }],
        suggest: { title: "Region Suggestion", text: `Region suggestion: ${rg.suggest_region}` }
      });
    }
    if (rg.suggest_tags) {
      out.push({
        id: "azure.rg.suggestTags",
        description: "Tag suggestions",
        target: { tool: "azure.create_resource_group" },
        effect: "warn",
        checks: [{ type: "regex", path: "name", pattern: ".*" }],
        suggest: { title: "Tag Suggestions", text: `Tag suggestions: ${JSON.stringify(rg.suggest_tags)}` }
      });
    }
  }

  // ---------- azure.create_app_service_plan ----------
  const plan = az.create_app_service_plan;
  if (plan?.sku_allowlist) {
    out.push({
      id: "azure.plan.skuAllow",
      description: "App Service Plan SKU allowlist",
      target: { tool: "azure.create_app_service_plan" },
      effect: "deny",
      checks: [{ type: "allowedValues", path: "skuName", values: plan.sku_allowlist.map(String) }]
    });
  }

  // ---------- azure.create_web_app ----------
  const web = az.create_web_app;
  if (web?.runtime_allowlist) {
    out.push({
      id: "azure.web.runtimeAllow",
      description: "Web App runtime allowlist",
      target: { tool: "azure.create_web_app" },
      effect: "deny",
      checks: [{ type: "allowedValues", path: "runtimeStack", values: web.runtime_allowlist.map(String) }]
    });
  }

  return out;
}

// Compile ATO YAML (generic) to WARN Policies
function compileAtoYaml(doc: any): Policy[] {
  if (!doc || typeof doc !== "object" || !doc.ato) return [];
  const out: Policy[] = [];

  // Example generic structure:
  // ato:
  //   policies:
  //     - id: ato.web.https
  //       target: { tool: "azure.create_web_app" }
  //       description: "Enable HTTPS-Only"
  //       checks:
  //         - { type: "requiredTrue", path: "httpsOnly", message: "Enable HTTPS-only" }
  //       suggest: { title: "Security", text: "Set httpsOnly=true." }

  const list = Array.isArray(doc.ato.policies) ? doc.ato.policies : [];
  for (const p of list) {
    const checks: Check[] = (p.checks || []).map((c: any) => c as Check);
    out.push({
      id: p.id,
      description: p.description,
      target: p.target,
      effect: "warn",
      checks,
      suggest: p.suggest
    });
  }
  return out;
}

export function loadPoliciesFlexible(customDir?: string): Policy[] {
  const dir = customDir ? path.resolve(customDir) : ROOT_DIR;
  const pYaml = path.join(dir, "policy.yaml");
  const pJson = path.join(dir, "policy.json");
  const ato   = path.join(dir, "ato.yaml");

  const policies: Policy[] = [];

  if (safeStat(pJson)?.isFile()) {
    const json = loadJsonPolicies(pJson);
    policies.push(...json);
  }
  if (safeStat(pYaml)?.isFile()) {
    const raw = fs.readFileSync(pYaml, "utf8");
    const compiled = compilePolicyYaml(yaml.load(raw));
    policies.push(...compiled);
  }
  if (safeStat(ato)?.isFile()) {
    const raw = fs.readFileSync(ato, "utf8");
    policies.push(...compileAtoYaml(yaml.load(raw)));
  }
  return policies;
}

// ---- evaluator ----
export function evaluate(tool: string, args: any, customDir?: string): EvalResult {
  const policies = loadPoliciesFlexible(customDir);
  const hits = policies.filter((p) => p.target.tool === tool || p.target.prefix === tool.split(".")[0]);

  let decision: EvalResult["decision"] = "allow";
  const reasons: string[] = [];
  const policyIds: string[] = [];
  const suggestions: Suggestion[] = [];

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

      if (pol.suggest) {
        const s = typeof pol.suggest === "string" ? { text: pol.suggest } : pol.suggest;
        if (s?.text) suggestions.push({ title: s.title, text: s.text });
      }
    }
  }

  return { decision, reasons, policyIds, suggestions: suggestions.length ? suggestions : undefined };
}