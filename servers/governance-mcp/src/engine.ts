// servers/governance-mcp/src/engine.ts
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Policy, EvalResult, Check, Suggestion } from "./types.js";

const RULES_DIR = process.env.GOVERNANCE_RULES_DIR || path.resolve(process.cwd(), "governance");
const POLICY_JSON = path.join(RULES_DIR, "policy.json");   // legacy
const POLICY_YAML = path.join(RULES_DIR, "policy.yaml");   // DSL: hard gates
const ATO_YAML = path.join(RULES_DIR, "ato.yaml");      // DSL: advisories

// ---------------- utils ----------------
function get(obj: any, dotted: string) {
  if (!obj) return undefined;
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
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
      const ok = c.values.map(String).includes(String(v));
      return ok ? undefined : (c.message || `Field '${c.path}' must be one of: ${c.values.join(", ")}`);
    }
    case "requiredTags": {
      const missing: string[] = [];
      for (const k of c.keys) {
        if (!v || typeof v !== "object" || !(k in v)) missing.push(k);
      }
      return missing.length ? (c.message || `Missing required tags: ${missing.join(", ")}`) : undefined;
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

// normalize suggestions into array
function normalizeSuggest(s: any): Suggestion[] {
  if (!s) return [];
  if (typeof s === "string") return [{ text: s }];
  if (Array.isArray(s)) {
    return s.map((x) => (typeof x === "string" ? { text: x } : x)).filter(Boolean);
  }
  if (typeof s === "object" && s.text) return [s as Suggestion];
  return [];
}

// ---------------- loaders/compilers ----------------
function loadJsonPolicies(filePath: string): Policy[] {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function escapeRe(s: string) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** policy.yaml (DSL) -> Policy[] for azure/github */
/** policy.yaml (DSL) -> Policy[] for azure/github */
function compilePolicyYaml(doc: any): Policy[] {
  const out: Policy[] = [];
  const az = doc?.azure || {};
  const gh = doc?.github || {};

  // ---------- helpers ----------
  const add = (p: Policy | undefined) => { if (p) out.push(p); };
  const S = (v: any) => String(v);
  const A = (arr: any) => (Array.isArray(arr) ? arr.map(S) : []);
  const suggestArr = (x: any) => normalizeSuggest(x);
  const allowVals = (path: string, values: string[], message?: string): Check =>
    ({ type: "allowedValues", path, values, message });
  const eq = (path: string, value: any, message?: string): Check =>
    ({ type: "equals", path, value, message });
  const reqTrue = (path: string, message?: string): Check =>
    ({ type: "requiredTrue", path, message });
  const reqPresent = (path: string, message?: string): Check =>
    ({ type: "requiredPresent", path, message });
  const re = (path: string, pattern: string, message?: string): Check =>
    ({ type: "regex", path, pattern, message });

  // =========================
  // AZURE
  // =========================

  // ----- Resource Group -----
  if (az.create_resource_group) {
    const rg = az.create_resource_group;

    if (Array.isArray(rg.deny_names) && rg.deny_names.length) {
      const alternation = rg.deny_names.map(escapeRe).join("|");
      add({
        id: "azure.rg.denyNames",
        description: "Disallow specific RG names",
        target: { tool: "azure.create_resource_group" },
        effect: "deny",
        checks: [re("name", `^(?!.*\\b(${alternation})\\b).+$`, `RG name cannot contain: ${rg.deny_names.join(", ")}`)]
      });
    }
    if (rg.name_regex) {
      add({
        id: "azure.rg.nameRegex",
        description: "RG name must match pattern",
        target: { tool: "azure.create_resource_group" },
        effect: "deny",
        checks: [re("name", S(rg.name_regex))]
      });
    }
    if (Array.isArray(rg.allowed_regions) && rg.allowed_regions.length) {
      add({
        id: "azure.rg.allowedRegions",
        description: "Allowed RG locations",
        target: { tool: "azure.create_resource_group" },
        effect: "deny",
        checks: [allowVals("location", A(rg.allowed_regions))]
      });
    }
    if (Array.isArray(rg.require_tags) && rg.require_tags.length) {
      add({
        id: "azure.rg.requiredTags",
        description: "Required RG tags",
        target: { tool: "azure.create_resource_group" },
        effect: "deny",
        checks: [{ type: "requiredTags", path: "tags", keys: rg.require_tags.map(S) }]
      });
    }
    const sug: Suggestion[] = [
      ...suggestArr(rg.suggest_name && `Try name like: ${rg.suggest_name}`),
      ...suggestArr(rg.suggest_region && `Region suggestion: ${rg.suggest_region}`),
      ...suggestArr(rg.suggest_tags && `Tag suggestions: ${JSON.stringify(rg.suggest_tags)}`)
    ];
    if (sug.length) {
      add({
        id: "azure.rg.suggest",
        description: "RG suggestions",
        target: { tool: "azure.create_resource_group" },
        effect: "warn",
        checks: [reqPresent("name")],
        suggest: sug
      });
    }
  }

  // ----- App Service Plan -----
  if (az.create_app_service_plan?.sku_allowlist) {
    const app = az.create_app_service_plan;
    if (Array.isArray(app.sku_allowlist) && app.sku_allowlist.length) {
      const values = A(app.sku_allowlist);
      add({
        id: "azure.plan.skuAllow",
        description: "App Service Plan SKU allowlist",
        target: { tool: "azure.create_app_service_plan" },
        effect: "deny",
        checks: [
          allowVals("sku", values)
        ]
      });
    }
  }

  // ----- Web App -----
  if (az.create_web_app?.runtime_allowlist) {
    const values = A(az.create_web_app.runtime_allowlist);
    add({
      id: "azure.web.runtimeAllow",
      description: "Web App runtime allowlist",
      target: { tool: "azure.create_web_app" },
      effect: "deny",
      checks: [allowVals("siteConfig.linuxFxVersion", values)]
    });
  }
  if (az.create_web_app?.require_https_only_true) {
    add({
      id: "azure.web.httpsOnly",
      description: "HTTPS-only must be enabled",
      target: { tool: "azure.create_web_app" },
      effect: "warn",
      checks: [reqTrue("httpsOnly", "Enable HTTPS-only") && eq("siteConfig.minimumTlsVersion", "1.2", "Set minimum TLS version to 1.2 or higher")],
      suggest: [{ text: "Set httpsOnly=true and minimum TLS ≥ 1.2." }]
    });
  }

  // ----- Static Web App -----
  if (az.create_static_web_app?.sku_allowlist) {
    const values = A(az.create_static_web_app.sku_allowlist);
    add({
      id: "azure.swa.skuAllow",
      description: "Static Web App SKU allowlist",
      target: { tool: "azure.create_static_web_app" },
      effect: "deny",
      checks: [allowVals("skuName", values)]
    });
  }

  // ----- Key Vault -----
  if (az.create_key_vault) {
    const kv = az.create_key_vault;

    if (kv.sku_allowlist) {
      const values = A(kv.sku_allowlist).map(s => s.toLowerCase());
      add({
        id: "azure.kv.skuAllow",
        description: "Key Vault SKU allowlist",
        target: { tool: "azure.create_key_vault" },
        effect: "deny",
        checks: [
          allowVals("skuName", values),
          allowVals("sku.name", values)
        ]
      });
    }
    if (kv.require_rbac_true) {
      add({
        id: "azure.kv.rbac",
        description: "Prefer RBAC authorization",
        target: { tool: "azure.create_key_vault" },
        effect: "warn",
        checks: [
          reqTrue("enableRbacAuthorization", "Enable RBAC authorization"),
          reqTrue("properties.enableRbacAuthorization", "Enable RBAC authorization")
        ],
        suggest: [{ text: "Set enableRbacAuthorization=true and manage access via RBAC." }]
      });
    }
    if (kv.disallow_public_network_access_enabled) {
      add({
        id: "azure.kv.privateAccess",
        description: "Discourage public network access",
        target: { tool: "azure.create_key_vault" },
        effect: "warn",
        checks: [
          { type: "notEquals", path: "publicNetworkAccess", value: "Enabled", message: "Prefer Private Endpoints + firewall" },
          { type: "notEquals", path: "properties.publicNetworkAccess", value: "Enabled", message: "Prefer Private Endpoints + firewall" }
        ],
        suggest: [{ text: "Plan Private Endpoints and IP allow-listing for KV." }]
      });
    }
  }

  // ----- Storage Account -----
  if (az.create_storage_account) {
    const sa = az.create_storage_account;

    if (sa.name_regex) {
      add({
        id: "azure.sa.nameRegex",
        description: "Storage account name rules",
        target: { tool: "azure.create_storage_account" },
        effect: "deny",
        checks: [re("accountName", S(sa.name_regex))]
      });
    }
    if (sa.sku_allowlist) {
      add({
        id: "azure.sa.skuAllow",
        description: "Storage SKU allowlist",
        target: { tool: "azure.create_storage_account" },
        effect: "deny",
        checks: [
          allowVals("skuName", A(sa.sku_allowlist)),
          allowVals("sku.name", A(sa.sku_allowlist))
        ]
      });
    }
    if (sa.kind_allowlist) {
      add({
        id: "azure.sa.kindAllow",
        description: "Storage kind allowlist",
        target: { tool: "azure.create_storage_account" },
        effect: "deny",
        checks: [allowVals("kind", A(sa.kind_allowlist))]
      });
    }
    if (sa.require_https_only_true) {
      add({
        id: "azure.sa.httpsOnly",
        description: "HTTPS-only must be enabled",
        target: { tool: "azure.create_storage_account" },
        effect: "deny",
        checks: [reqTrue("enableHttpsTrafficOnly", "Enable HTTPS-only for Storage")],
        suggest: [{ text: "Set enableHttpsTrafficOnly=true." }]
      });
    }
  }

  // ----- Virtual Network -----
  if (az.create_virtual_network) {
    const vn = az.create_virtual_network;

    if (vn.name_regex) {
      add({
        id: "azure.vnet.nameRegex",
        description: "VNet naming",
        target: { tool: "azure.create_virtual_network" },
        effect: "deny",
        checks: [re("name", S(vn.name_regex))]
      });
    }
    if (vn.allowed_regions) {
      add({
        id: "azure.vnet.locationAllow",
        description: "VNet region allowlist",
        target: { tool: "azure.create_virtual_network" },
        effect: "deny",
        checks: [allowVals("location", A(vn.allowed_regions))]
      });
    }
    if (vn.require_tags) {
      add({
        id: "azure.vnet.requiredTags",
        description: "VNet required tags",
        target: { tool: "azure.create_virtual_network" },
        effect: "deny",
        checks: [{ type: "requiredTags", path: "tags", keys: A(vn.require_tags) }]
      });
    }
    if (vn.require_ddos_plan) {
      add({
        id: "azure.vnet.ddosPlan",
        description: "Consider DDoS plan",
        target: { tool: "azure.create_virtual_network" },
        effect: "warn",
        checks: [reqPresent("ddosProtectionPlan.id", "Attach DDoS Protection Plan")],
        suggest: [{ text: "Enable Standard DDoS plan on critical VNets." }]
      });
    }
  }

  // ----- Subnet -----
  if (az.create_subnet) {
    const sn = az.create_subnet;

    if (sn.name_regex) {
      add({
        id: "azure.subnet.nameRegex",
        description: "Subnet naming",
        target: { tool: "azure.create_subnet" },
        effect: "deny",
        checks: [re("name", S(sn.name_regex))]
      });
    }
    if (sn.require_nsg) {
      add({
        id: "azure.subnet.nsg",
        description: "Require NSG",
        target: { tool: "azure.create_subnet" },
        effect: "warn",
        checks: [reqPresent("networkSecurityGroup.id", "Attach NSG to subnet")],
        suggest: [{ text: "Ensure least-privilege NSG rules are applied." }]
      });
    }
    if (sn.require_private_endpoint_policies_disabled) {
      add({
        id: "azure.subnet.pePolicies",
        description: "Private Endpoint subnet policies",
        target: { tool: "azure.create_subnet" },
        effect: "warn",
        checks: [eq("privateEndpointNetworkPolicies", "Disabled", "Disable policies for PE subnets")],
        suggest: [{ text: "Set privateEndpointNetworkPolicies=Disabled for PE subnets." }]
      });
    }
  }

  // ----- Private Endpoint -----
  if (az.create_private_endpoint) {
    const pe = az.create_private_endpoint;

    if (pe.require_dns_zone_link) {
      add({
        id: "azure.pe.dnsZones",
        description: "DNS zone group & zones",
        target: { tool: "azure.create_private_endpoint" },
        effect: "warn",
        checks: [
          reqPresent("privateDnsZoneGroupName", "Provide a Private DNS Zone Group"),
          reqPresent("privateDnsZoneIds", "Link Private DNS Zones")
        ],
        suggest: [{ text: "Create a DNS zone group and link appropriate Private DNS zones." }]
      });
    }
    if (pe.target_regexes && Array.isArray(pe.target_regexes) && pe.target_regexes.length) {
      const alternation = pe.target_regexes.map(escapeRe).join("|");
      add({
        id: "azure.pe.targetMatch",
        description: "Target resource type(s)",
        target: { tool: "azure.create_private_endpoint" },
        effect: "warn",
        checks: [re("targetResourceId", `(${alternation})`, "Target resource must match allowed providers")]
      });
    }
  }

  // ----- Log Analytics Workspace -----
  if (az.create_log_analytics_workspace) {
    const law = az.create_log_analytics_workspace;
    if (law.allowed_regions) {
      add({
        id: "azure.law.locationAllow",
        description: "LAW region allowlist",
        target: { tool: "azure.create_log_analytics_workspace" },
        effect: "deny",
        checks: [allowVals("location", A(law.allowed_regions))]
      });
    }
    if (law.retention_days_allowlist) {
      const vals = A(law.retention_days_allowlist);
      add({
        id: "azure.law.retentionAllow",
        description: "Retention days allowlist",
        target: { tool: "azure.create_log_analytics_workspace" },
        effect: "deny",
        checks: [allowVals("retentionInDays", vals)]
      });
    }
  }

  // ----- Public IP -----
  if (az.create_public_ip) {
    const pip = az.create_public_ip;
    if (pip.sku_allowlist) {
      add({
        id: "azure.pip.skuAllow",
        description: "Public IP SKU allowlist",
        target: { tool: "azure.create_public_ip" },
        effect: "deny",
        checks: [
          allowVals("skuName", A(pip.sku_allowlist)),
          allowVals("sku.name", A(pip.sku_allowlist))
        ]
      });
    }
    if (pip.allocation_allowlist) {
      add({
        id: "azure.pip.allocAllow",
        description: "Allocation method allowlist",
        target: { tool: "azure.create_public_ip" },
        effect: "deny",
        checks: [
          allowVals("publicIPAllocationMethod", A(pip.allocation_allowlist)),
          allowVals("allocationMethod", A(pip.allocation_allowlist))
        ]
      });
    }
    if (pip.version_allowlist) {
      add({
        id: "azure.pip.versionAllow",
        description: "IP version allowlist",
        target: { tool: "azure.create_public_ip" },
        effect: "deny",
        checks: [allowVals("publicIPAddressVersion", A(pip.version_allowlist))]
      });
    }
  }

  // =========================
  // GITHUB (existing + keep)
  // =========================

  if (gh.create_repo) {
    const gr = gh.create_repo;
    if (Array.isArray(gr.deny_names) && gr.deny_names.length) {
      const alternation = gr.deny_names.map(escapeRe).join("|");
      add({
        id: "github.repo.denyNames",
        description: "Disallow specific repo names",
        target: { tool: "github.create_repo" },
        effect: "deny",
        checks: [re("name", `^(?!.*\\b(${alternation})\\b).+$`, `Repo name cannot contain: ${gr.deny_names.join(", ")}`)]
      });
    }
    if (gr.name_regex) {
      add({
        id: "github.repo.nameRegex",
        description: "Repo name must match pattern",
        target: { tool: "github.create_repo" },
        effect: "deny",
        checks: [re("name", S(gr.name_regex))]
      });
    }
    if (Array.isArray(gr.visibility_allowlist) && gr.visibility_allowlist.length) {
      add({
        id: "github.repo.visibilityAllow",
        description: "Repo visibility allowlist",
        target: { tool: "github.create_repo" },
        effect: "deny",
        checks: [allowVals("visibility", A(gr.visibility_allowlist))]
      });
    }
    const sug = [
      ...suggestArr(gr.suggest_name && `Try name like: ${gr.suggest_name}`),
      ...suggestArr(gr.suggest_visibility && `Visibility suggestion: ${gr.suggest_visibility}`),
      ...suggestArr(gr.suggest_description && `Description suggestion: ${gr.suggest_description}`)
    ];
    if (sug.length) {
      add({
        id: "github.repo.suggest",
        description: "Repo suggestions",
        target: { tool: "github.create_repo" },
        effect: "warn",
        checks: [reqPresent("name")],
        suggest: sug
      });
    }
  }

  if (gh.create_repo_from_template) {
    const rt = gh.create_repo_from_template;
    if (Array.isArray(rt.deny_names) && rt.deny_names.length) {
      const alternation = rt.deny_names.map(escapeRe).join("|");
      add({
        id: "github.templateRepo.denyNames",
        description: "Disallow specific repo names",
        target: { tool: "github.create_repo_from_template" },
        effect: "deny",
        checks: [
          re("name", `^(?!.*\\b(${alternation})\\b).+$`),
          re("newRepoName", `^(?!.*\\b(${alternation})\\b).+$`)
        ]
      });
    }
    if (rt.new_name_regex) {
      const pattern = S(rt.new_name_regex);
      add({
        id: "github.templateRepo.nameRegex",
        description: "New repo name must match pattern",
        target: { tool: "github.create_repo_from_template" },
        effect: "deny",
        checks: [re("name", pattern), re("newRepoName", pattern)]
      });
    }
    if (Array.isArray(rt.visibility_allowlist) && rt.visibility_allowlist.length) {
      add({
        id: "github.templateRepo.visibilityAllow",
        description: "New repo visibility allowlist",
        target: { tool: "github.create_repo_from_template" },
        effect: "deny",
        checks: [allowVals("visibility", A(rt.visibility_allowlist))]
      });
    }
    if (rt.suggest_visibility) {
      add({
        id: "github.templateRepo.suggest",
        description: "Template repo suggestion",
        target: { tool: "github.create_repo_from_template" },
        effect: "warn",
        checks: [reqPresent("templateRepo")],
        suggest: [{ text: `Visibility suggestion: ${rt.suggest_visibility}` }]
      });
    }
  }

  if (gh.protect_branch) {
    const p = gh.protect_branch;
    const checks: Check[] = [];
    if (p.enforce_admins_required) checks.push(reqTrue("enforceAdmins", "Enforce for admins"));
    if (p.code_owner_reviews_required) checks.push(reqTrue("requireCodeOwnerReviews", "Require CODEOWNERS reviews"));
    if (p.min_approvals_not_zero) checks.push({ type: "notEquals", path: "requiredApprovingReviewCount", value: 0, message: "Set ≥1 required approval" });
    if (p.block_force_pushes) checks.push(reqTrue("blockForcePushes", "Block force pushes"));
    add({
      id: "github.protect_branch.baseline",
      description: "Branch protection baseline",
      target: { tool: "github.protect_branch" },
      effect: "warn",
      checks,
      suggest: suggestArr(p.suggest)
    });
  }

  if (gh.enable_repo_security) {
    const s = gh.enable_repo_security;
    const checks: Check[] = [];
    if (s.require_secret_scanning) checks.push(reqTrue("secretScanning", "Enable Secret Scanning"));
    if (s.require_push_protection) checks.push(reqTrue("secretScanningPushProtection", "Enable Push Protection"));
    if (s.require_dependabot_security_updates) checks.push(reqTrue("dependabotSecurityUpdates", "Enable Dependabot security updates"));
    add({
      id: "github.security.baseline",
      description: "Repo security features baseline",
      target: { tool: "github.enable_repo_security" },
      effect: "warn",
      checks,
      suggest: suggestArr(s.suggest)
    });
  }

  if (gh.add_codeowners) {
    const c = gh.add_codeowners;
    add({
      id: "github.codeowners.present",
      description: "CODEOWNERS present",
      target: { tool: "github.add_codeowners" },
      effect: "warn",
      checks: [reqPresent("entries", "Add CODEOWNERS entries")],
      suggest: suggestArr(c.suggest)
    });
  }

  if (gh.create_ruleset_basic) {
    const r = gh.create_ruleset_basic;
    const checks: Check[] = [];
    if (r.require_approvals_not_zero) checks.push({ type: "notEquals", path: "requiredApprovals", value: 0, message: "Require ≥1 approval" });
    if (r.require_codeowner_reviews_true) checks.push(reqTrue("requireCodeOwnerReviews", "Require CODEOWNERS reviews"));
    if (r.block_force_pushes_true) checks.push(reqTrue("blockForcePushes", "Block force-pushes"));
    add({
      id: "github.ruleset.basic",
      description: "Basic repository ruleset",
      target: { tool: "github.create_ruleset_basic" },
      effect: "warn",
      checks,
      suggest: suggestArr(r.suggest)
    });
  }

  return out;
}

/** ato.yaml (advisories) -> Policy[] keyed by pseudo-tools like "ato.workload.web_app" */
function compileAtoYaml(doc: any): Policy[] {
  if (!doc || typeof doc !== "object" || !doc.ato) return [];
  const out: Policy[] = [];

  // Support shapes:
  // ato:
  //   workload: { policies: [...] }
  //   network:  { policies: [...] }
  //   key_vault:{ policies: [...] }
  //
  // Each policy: { id, description, target:{tool}, effect: warn, checks:[], suggest }

  const sections = doc.ato;
  const collect = (node: any) => (Array.isArray(node?.policies) ? node.policies : []);

  const allPolicies = [
    ...collect(sections.workload),
    ...collect(sections.network),
    ...collect(sections.key_vault),
    ...collect(sections.common),       // if you add common advisories later
    ...collect(sections.app_service)   // compatibility with older examples
  ];

  for (const p of allPolicies) {
    if (!p?.target?.tool || !p.effect) continue;
    const checks: Check[] = [];

    for (const c of p.checks || []) {
      if (c.type) { checks.push(c as Check); continue; }
      const key = Object.keys(c)[0];
      const rest = Object.values(c)[0] as any || {};
      switch (key) {
        case "regex": checks.push({ type: "regex", path: rest.path, pattern: String(rest.pattern), message: rest.message }); break;
        case "noSpaces": checks.push({ type: "noSpaces", path: rest.path, message: rest.message }); break;
        case "allowedValues": checks.push({ type: "allowedValues", path: rest.path, values: (rest.values || []).map(String), message: rest.message }); break;
        case "requiredTags": checks.push({ type: "requiredTags", path: rest.path, keys: (rest.keys || []).map(String), message: rest.message }); break;
        case "equals": checks.push({ type: "equals", path: rest.path, value: rest.value, message: rest.message }); break;
        case "notEquals": checks.push({ type: "notEquals", path: rest.path, value: rest.value, message: rest.message }); break;
        case "booleanTrue": checks.push({ type: "requiredTrue", path: rest.path, message: rest.message }); break;
        case "exists": checks.push({ type: "requiredPresent", path: rest.path, message: rest.message }); break;
      }
    }

    out.push({
      id: String(p.id || p.description || p.target.tool),
      description: p.description,
      target: { tool: String(p.target.tool) },
      effect: p.effect, // expected 'warn'
      checks,
      suggest: p.suggest
    });
  }

  return out;
}

export function loadPoliciesFlexible(customDir?: string): Policy[] {
  const dir = customDir || RULES_DIR;
  const list: Policy[] = [];

  if (fs.existsSync(POLICY_JSON)) list.push(...loadJsonPolicies(POLICY_JSON));

  if (fs.existsSync(POLICY_YAML)) {
    const raw = fs.readFileSync(POLICY_YAML, "utf8");
    list.push(...compilePolicyYaml(yaml.load(raw)));
  }

  if (fs.existsSync(ATO_YAML)) {
    const raw = fs.readFileSync(ATO_YAML, "utf8");
    list.push(...compileAtoYaml(yaml.load(raw)));
  }

  return list;
}

// ---------------- evaluator ----------------
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
    if (!localReasons.length) continue;

    policyIds.push(pol.id);
    reasons.push(`${pol.id}: ${localReasons.join("; ")}`);

    if (pol.effect === "deny") decision = "deny";
    else if (pol.effect === "warn" && decision === "allow") decision = "warn";

    // attach any suggestions declared on the policy
    if (pol.suggest) suggestions.push(...normalizeSuggest(pol.suggest));
  }

  return { decision, reasons, policyIds, suggestions: suggestions.length ? suggestions : undefined };
}

export function debugConfig() {
  const policies = loadPoliciesFlexible();
  return {
    dir: RULES_DIR,
    policyCount: policies.length
  };
}
