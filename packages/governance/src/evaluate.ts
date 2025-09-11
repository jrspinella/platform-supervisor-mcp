import type { GovernanceBlock } from "./types.js";
import { ensureLoaded } from "./loaders.js";

const TOOL_MAP: Record<string, string> = {
  "platform.create_resource_group": "azure.create_resource_group",
  "platform.create_app_service_plan": "azure.create_app_service_plan",
  "platform.create_web_app": "azure.create_web_app",
  "platform.create_storage_account": "azure.create_storage_account",
  "platform.create_key_vault": "azure.create_key_vault",
  "platform.create_log_analytics": "azure.create_log_analytics_workspace",
  "platform.create_vnet": "azure.create_virtual_network",
  "platform.create_subnet": "azure.create_subnet",
  "platform.create_private_endpoint": "azure.create_private_endpoint",
};

export async function evaluate(toolFq: string, args: any): Promise<GovernanceBlock> {
  const fq = TOOL_MAP[toolFq] || toolFq;
  const az = ensureLoaded()?.azure || {};
  const p = (az as any)?.create_resource_group;

  if (fq === "azure.create_resource_group" && p) {
    const reasons: string[] = [];
    const suggestions: { title: string; text: string }[] = [];
    const controls: string[] = Array.isArray(p.controls) ? p.controls : [];
    const policyIds = ["azure.create_resource_group"];

    const name = String(args?.name ?? "");
    const loc = String(args?.location ?? "");
    const tags = args?.tags ?? {};

    if (Array.isArray(p.deny_names) && p.deny_names.includes(name)) {
      reasons.push(`name '${name}' explicitly denied`);
    }
    if (Array.isArray(p.deny_contains) && p.deny_contains.some((w: string) => name.includes(w))) {
      reasons.push("name contains denied token(s)");
    }
    if (p.deny_regex) {
      try { if (new RegExp(p.deny_regex).test(name)) reasons.push("name matches deny_regex"); } catch {/* ignore invalid regex */}
    }
    if (p.name_regex) {
      try { if (!new RegExp(p.name_regex).test(name)) reasons.push(`name does not match required pattern ${p.name_regex}`); } catch {/* ignore invalid regex */}
    }
    if (Array.isArray(p.allowed_regions) && !p.allowed_regions.includes(loc)) {
      reasons.push(`region '${loc}' not allowed (${p.allowed_regions.join(", ")})`);
    }
    if (Array.isArray(p.require_tags)) {
      const missing = p.require_tags.filter((k: string) => !(k in tags));
      if (missing.length) reasons.push(`missing required tag(s): ${missing.join(", ")}`);
    }

    if (p.suggest_name) suggestions.push({ title: "Suggested name", text: p.suggest_name });
    if (p.suggest_region) suggestions.push({ title: "Suggested region", text: p.suggest_region });
    if (p.suggest_tags) {
      const kv = Object.entries(p.suggest_tags).map(([k, v]) => `${k}: ${String(v)}`).join(", ");
      suggestions.push({ title: "Suggested tags", text: kv });
    }

    if (reasons.length) {
      return { decision: "deny", reasons, suggestions, controls, policyIds };
    }
    return { decision: "allow", policyIds };
  }

  return { decision: "allow", reasons: [`no-policy:${fq}`] };
}