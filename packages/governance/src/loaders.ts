import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { PolicyDoc } from "./types.js";

let _doc: PolicyDoc | null = null;

export function registerPolicies(doc: PolicyDoc) {
  _doc = doc;
}
export function getPolicyDoc(): PolicyDoc {
  return _doc ?? {};
}

function deepMerge<T>(a: T, b: Partial<T>): T {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b] as any;
  if (typeof a === "object" && a && typeof b === "object" && b) {
    const out: any = { ...a };
    for (const k of Object.keys(b)) {
      const av = (a as any)[k];
      const bv = (b as any)[k];
      if (av && typeof av === "object" && bv && typeof bv === "object") {
        out[k] = deepMerge(av, bv);
      } else {
        out[k] = bv;
      }
    }
    return out;
  }
  return (b as T) ?? a;
}

function loadYamlFileIfExists(file: string): any {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, "utf8");
  return YAML.parse(text) ?? {};
}

export function loadPoliciesFromYaml(paths: string | string[]): PolicyDoc {
  const inputs = Array.isArray(paths) ? paths : [paths];
  let merged: PolicyDoc = {};
  for (const p of inputs) {
    const stat = fs.existsSync(p) ? fs.statSync(p) : null;
    if (!stat) continue;
    if (stat.isDirectory()) {
      const files = fs.readdirSync(p)
        .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
        .map(f => path.join(p, f))
        .sort();
      for (const f of files) merged = deepMerge(merged, loadYamlFileIfExists(f));
    } else {
      merged = deepMerge(merged, loadYamlFileIfExists(p));
    }
  }
  return merged;
}

/** Map platform.* wrappers to policy namespace */
export function normalizeToolForPolicy(toolFq: string): string {
  const map: Record<string, string> = {
    "platform.create_resource_group": "azure.create_resource_group",
    // add more wrapper→policy mappings as you expose them
  };
  return map[toolFq] ?? toolFq;
}