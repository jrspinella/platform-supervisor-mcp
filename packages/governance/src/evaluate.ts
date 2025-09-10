import type { DecisionBlock, EvaluateContext, PolicyDoc, CreateRgPolicy } from "./types.js";
import { getPolicyDoc, normalizeToolForPolicy } from "./loaders.js";

const get = (o: any, k: string): any => (o ? o[k] : undefined);

function render(tpl: string, ctx: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) =>
    ctx[key] == null ? "" : String(ctx[key])
  );
}
function suggestionsFromPolicy(pol: any, ctx: Record<string, any>) {
  const out: { title?: string; text: string }[] = [];
  if (pol?.suggest_name)   out.push({ title: "Suggested name",   text: render(pol.suggest_name, ctx) });
  if (pol?.suggest_region) out.push({ title: "Suggested region", text: render(pol.suggest_region, ctx) });
  if (pol?.suggest_tags) {
    const kv = Object.entries(pol.suggest_tags).map(([k, v]) => `${k}: ${render(String(v), ctx)}`);
    out.push({ title: "Suggested tags", text: kv.join(", ") });
  }
  return out;
}
const hasAny = (s: string, subs: string[]) =>
  subs.some(x => s.toLowerCase().includes(x.toLowerCase()));

export function evaluate(toolFq: string, args: any, ctx: EvaluateContext = {}): DecisionBlock {
  const doc: PolicyDoc = getPolicyDoc();
  const norm = normalizeToolForPolicy(toolFq);

  if (norm === "azure.create_resource_group") {
    const pol: CreateRgPolicy | undefined = get(doc, "azure")?.create_resource_group;
    if (!pol) return { decision: "allow", reasons: ["no-policy:azure.create_resource_group"] };

    const reasons: string[] = [];
    const suggestions = suggestionsFromPolicy(pol, ctx);

    const name = String(args?.name ?? "");
    const location = String(args?.location ?? "");
    const tags = args?.tags ?? {};

    // deny_names (exact)
    if (pol.deny_names?.length && name) {
      const lc = name.toLowerCase();
      if (pol.deny_names.map(x => x.toLowerCase()).includes(lc)) {
        reasons.push(`name '${name}' is denied by policy`);
      }
    }
    // deny_contains (substring)
    if (pol.deny_contains?.length && name) {
      if (hasAny(name, pol.deny_contains)) {
        reasons.push(`name '${name}' contains a banned term (${pol.deny_contains.join(", ")})`);
      }
    }
    // deny_regex (advanced)
    if (pol.deny_regex && name) {
      if (new RegExp(pol.deny_regex, "i").test(name)) {
        reasons.push(`name '${name}' matches a denied pattern`);
      }
    }
    // required name pattern
    if (pol.name_regex && name && !new RegExp(pol.name_regex).test(name)) {
      reasons.push(`name '${name}' does not match required pattern ${pol.name_regex}`);
    }
    // allowed regions
    if (pol.allowed_regions?.length && location && !pol.allowed_regions.includes(location)) {
      reasons.push(`location '${location}' is not in allowed regions: ${pol.allowed_regions.join(", ")}`);
    }
    // required tags
    if (pol.require_tags?.length) {
      const missing = pol.require_tags.filter(k => !(k in tags));
      if (missing.length) reasons.push(`missing required tag(s): ${missing.join(", ")}`);
    }

    if (reasons.length) {
      return {
        decision: "deny",
        reasons,
        suggestions: suggestions.length ? suggestions : undefined,
        controls: pol.controls && pol.controls.length ? [...pol.controls] : undefined,
        policyIds: ["azure.create_resource_group"]
      };
    }
    return { decision: "allow" };
  }

  return { decision: "allow", reasons: ["no-policy-for-tool"] };
}