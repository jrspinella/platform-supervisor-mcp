// packages/governance-core/src/policy/index.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

type Decision = "allow" | "deny" | "warn";

export type GovernanceSuggestion = { title?: string; text: string };
export type GovernanceBlock = {
  decision: Decision;
  reasons?: string[];
  suggestions?: GovernanceSuggestion[];
  controls?: string[];
  policyIds?: string[];
};

type RgPolicy = {
  deny_names?: string[];
  deny_contains?: string[];
  name_regex?: string;
  allowed_regions?: string[];
  require_tags?: string[];
  suggest_name?: string;
  suggest_region?: string;
  suggest_tags?: Record<string, string>;
  controls?: string[];
};

type AppPlanPolicy = {
  sku_allowlist?: string[];
  controls?: string[];
};

type WebAppPolicy = {
  runtime_allowlist?: string[];
  controls?: string[];
};

type StorageAccountPolicy = {
  name_regex?: string;
  sku_allowlist?: string[];
  kind_allowlist?: string[];
  require_https_only_true?: boolean;
  controls?: string[];
};

type KeyVaultPolicy = {
  sku_allowlist?: string[];
  require_rbac_true?: boolean;
  disallow_public_network_access_enabled?: boolean;
  controls?: string[];
};

type VnetPolicy = {
  name_regex?: string;
  allowed_regions?: string[];
  require_tags?: string[];
  require_ddos_plan?: boolean; // warn
  controls?: string[];
};

type SubnetPolicy = {
  name_regex?: string;
  require_nsg?: boolean;
  require_private_endpoint_policies_disabled?: boolean; // warn
  controls?: string[];
};

type PrivateEndpointPolicy = {
  require_dns_zone_link?: boolean; // warn
  target_regexes?: string[];
  controls?: string[];
};

type LogAnalyticsPolicy = {
  allowed_regions?: string[];
  retention_days_allowlist?: number[];
  controls?: string[];
};

type PublicIpPolicy = {
  sku_allowlist?: string[];
  allocation_allowlist?: string[];
  version_allowlist?: string[];
  controls?: string[];
};

type AzurePolicy = {
  create_resource_group?: RgPolicy;
  create_app_service_plan?: AppPlanPolicy;
  create_web_app?: WebAppPolicy;
  create_storage_account?: StorageAccountPolicy;
  create_key_vault?: KeyVaultPolicy;
  create_virtual_network?: VnetPolicy;
  create_subnet?: SubnetPolicy;
  create_private_endpoint?: PrivateEndpointPolicy;
  create_log_analytics_workspace?: LogAnalyticsPolicy;
  create_public_ip?: PublicIpPolicy;
};

export type PolicyDoc = {
  azure: AzurePolicy;
  // room for other providers in the future (github, etc.)
};

let loadedPolicy: PolicyDoc | null = null;

/* ------------------------------ Defaults (code-based policy) ------------------------------ */

function defaultPolicy(): PolicyDoc {
  return {
    azure: {
      // ---------- Resource Groups ----------
      create_resource_group: {
        deny_names: ["cookies", "foo", "bar"],
        deny_contains: ["cookies", "foo", "bar"],
        name_regex: "^(rg-[a-z0-9-]{3,40})$",
        allowed_regions: ["usgovvirginia", "usgovarizona"],
        require_tags: ["owner", "env"],
        suggest_name: "rg-{{alias}}-sbx",
        suggest_region: "usgovvirginia",
        suggest_tags: { owner: "{{upn}}", env: "dev" },
        controls: ["CM-2", "CM-6"],
      },

      // ---------- App Service Plan ----------
      create_app_service_plan: {
        sku_allowlist: ["P1", "P2"], // base tiers; we treat P1v3, P2v3 as P1/P2 families
        controls: ["SC-13", "SC-8"],
      },

      // ---------- Web App ----------
      create_web_app: {
        runtime_allowlist: ["NODE|20-lts", "DOTNET|8.0"],
        controls: ["SC-23", "CM-7"],
      },

      // ---------- Storage ----------
      create_storage_account: {
        name_regex: "^[a-z0-9]{3,24}$",
        sku_allowlist: ["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"],
        kind_allowlist: ["StorageV2", "BlobStorage", "BlockBlobStorage", "FileStorage", "Storage"],
        require_https_only_true: true,
        controls: ["SC-13", "SC-8", "SC-23"],
      },

      // ---------- Key Vault ----------
      create_key_vault: {
        sku_allowlist: ["standard", "premium"],
        require_rbac_true: true,
        disallow_public_network_access_enabled: true,
        controls: ["AC-3", "AC-6", "SI-12"],
      },

      // ---------- Network ----------
      create_virtual_network: {
        name_regex: "^(vnet-[a-z0-9-]{3,40})$",
        allowed_regions: ["usgovvirginia", "usgovarizona"],
        require_tags: ["owner", "env"],
        require_ddos_plan: true, // warn
        controls: ["SC-7"],
      },

      create_subnet: {
        name_regex: "^(snet-[a-z0-9-]{3,40})$",
        require_nsg: true,
        require_private_endpoint_policies_disabled: true, // warn
        controls: ["SC-7"],
      },

      create_private_endpoint: {
        require_dns_zone_link: true, // warn
        target_regexes: [
          "providers/Microsoft.KeyVault/vaults",
          "providers/Microsoft.Storage/storageAccounts",
          "providers/Microsoft.Web/sites",
        ],
        controls: ["SC-7"],
      },

      // ---------- Log Analytics ----------
      create_log_analytics_workspace: {
        allowed_regions: ["usgovvirginia", "usgovarizona"],
        retention_days_allowlist: [30, 60, 90, 180, 365, 730],
        controls: ["AU-6", "AU-12"],
      },

      // ---------- Public IP ----------
      create_public_ip: {
        sku_allowlist: ["Standard"],
        allocation_allowlist: ["Static"],
        version_allowlist: ["IPv4"],
        controls: ["SC-7"],
      },
    },
  };
}

/* ------------------------------ Utilities ------------------------------ */

const toArr = <T>(x?: T | T[]): T[] => (Array.isArray(x) ? x : x ? [x] : []);
const lower = (s?: string) => (s ?? "").toLowerCase();

function unique<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function suggestionsFromRgPolicy(p: RgPolicy | undefined): GovernanceSuggestion[] {
  if (!p) return [];
  const s: GovernanceSuggestion[] = [];
  if (p.suggest_name) s.push({ title: "Suggested name", text: p.suggest_name });
  if (p.suggest_region) s.push({ title: "Suggested region", text: p.suggest_region });
  if (p.suggest_tags) {
    const pairs = Object.entries(p.suggest_tags)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    s.push({ title: "Suggested tags", text: pairs });
  }
  return s;
}

function result(
  decision: Decision,
  reasons: string[],
  suggestions: GovernanceSuggestion[],
  controls?: string[],
  policyIds?: string[]
): GovernanceBlock {
  return {
    decision,
    reasons: reasons.length ? reasons : undefined,
    suggestions: suggestions.length ? suggestions : undefined,
    controls,
    policyIds,
  };
}

/* Normalize plan SKUs like P1v3 → P1 (family base) */
function normalizePlanSkuName(sku?: string): string {
  const n = (sku || "").trim();
  const m = /^([A-Za-z]+[0-9]+)(?:.*)?$/.exec(n);
  return m ? m[1].toUpperCase() : n.toUpperCase();
}

/* ------------------------------ Evaluation ------------------------------ */

function evalCreateResourceGroup(args: any, pol: RgPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const suggestions = suggestionsFromRgPolicy(pol);
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_resource_group"];

  const name = String(args?.name ?? args?.resourceGroupName ?? "").trim();
  const nameLc = name.toLowerCase();
  const loc = lower(args?.location);

  // deny_names (exact)
  for (const bad of toArr(pol.deny_names).map(lower)) {
    if (nameLc === bad) reasons.push(`name '${name}' is explicitly denied`);
  }

  // deny_contains (substring)
  for (const sub of toArr(pol.deny_contains).map(lower)) {
    if (nameLc.includes(sub)) reasons.push(`name contains denied substring '${sub}'`);
  }

  // regex
  if (pol.name_regex) {
    const r = new RegExp(pol.name_regex);
    if (!r.test(name)) reasons.push(`name does not match required pattern ${pol.name_regex}`);
  }

  // region allow
  if (pol.allowed_regions && pol.allowed_regions.length) {
    const allowed = pol.allowed_regions.map(lower);
    if (!allowed.includes(loc)) {
      reasons.push(`region '${args?.location ?? ""}' not allowed (${pol.allowed_regions.join(", ")})`);
    }
  }

  // required tags
  const required = toArr(pol.require_tags);
  if (required.length) {
    const tags = (args?.tags && typeof args.tags === "object" ? args.tags : {}) as Record<string, string>;
    const have = Object.keys(tags).map((k) => k.toLowerCase());
    const missing = required.filter((k) => !have.includes(k.toLowerCase()));
    if (missing.length) reasons.push(`missing required tag(s): ${missing.join(", ")}`);
  }

  return result(reasons.length ? "deny" : "allow", reasons, suggestions, controls, policyIds);
}

function evalCreateAppServicePlan(args: any, pol: AppPlanPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_app_service_plan"];
  const suggestions: GovernanceSuggestion[] = [];

  const skuInput = String(args?.sku ?? args?.skuName ?? "").trim();
  if (pol.sku_allowlist && pol.sku_allowlist.length) {
    const base = normalizePlanSkuName(skuInput);
    const allowed = pol.sku_allowlist.map((s) => s.toUpperCase());
    if (!allowed.includes(base)) {
      reasons.push(`sku '${skuInput}' not allowed (${allowed.join(", ")})`);
    }
  }
  return result(reasons.length ? "deny" : "allow", reasons, suggestions, controls, policyIds);
}

function evalCreateWebApp(args: any, pol: WebAppPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_web_app"];
  const suggestions: GovernanceSuggestion[] = [];

  const runtime =
    args?.runtime ??
    args?.runtimeStack ??
    args?.linuxFxVersion ??
    args?.siteConfig?.linuxFxVersion ??
    "";

  if (pol.runtime_allowlist && pol.runtime_allowlist.length) {
    if (!runtime) {
      return result(
        "warn",
        ["runtime not specified; allowed options: " + pol.runtime_allowlist.join(", ")],
        suggestions,
        controls,
        policyIds
      );
    }
    const ok = pol.runtime_allowlist.some((r) => r.toLowerCase() === String(runtime).toLowerCase());
    if (!ok) reasons.push(`runtime '${runtime}' not allowed (${pol.runtime_allowlist.join(", ")})`);
  }
  return result(reasons.length ? "deny" : "allow", reasons, suggestions, controls, policyIds);
}

function evalCreateStorageAccount(args: any, pol: StorageAccountPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_storage_account"];
  const suggestions: GovernanceSuggestion[] = [];

  const name = String(args?.name ?? "").trim();
  if (pol.name_regex) {
    const r = new RegExp(pol.name_regex);
    if (!r.test(name)) reasons.push(`name does not match required pattern ${pol.name_regex}`);
  }

  if (pol.sku_allowlist?.length) {
    const sku = String(args?.sku ?? args?.skuName ?? args?.skuTier ?? "").trim();
    const allowed = pol.sku_allowlist;
    if (!allowed.includes(sku)) reasons.push(`sku '${sku}' not allowed (${allowed.join(", ")})`);
  }

  if (pol.kind_allowlist?.length) {
    const kind = String(args?.kind ?? "").trim();
    if (!pol.kind_allowlist.includes(kind)) {
      reasons.push(`kind '${kind}' not allowed (${pol.kind_allowlist.join(", ")})`);
    }
  }

  if (pol.require_https_only_true) {
    const httpsOnly =
      args?.httpsOnly ?? args?.supportsHttpsTrafficOnly ?? args?.enableHttpsTrafficOnly ?? false;
    if (!httpsOnly) reasons.push("https-only must be enabled");
  }

  return result(reasons.length ? "deny" : "allow", reasons, suggestions, controls, policyIds);
}

function evalCreateKeyVault(args: any, pol: KeyVaultPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_key_vault"];
  const suggestions: GovernanceSuggestion[] = [];

  if (pol.sku_allowlist?.length) {
    const sku = String(args?.sku ?? args?.properties?.sku?.name ?? "").toLowerCase();
    const allowed = pol.sku_allowlist.map((x) => x.toLowerCase());
    if (!allowed.includes(sku)) reasons.push(`sku '${sku}' not allowed (${allowed.join(", ")})`);
  }

  if (pol.require_rbac_true) {
    const rbac = !!(args?.properties?.enableRbacAuthorization ?? args?.enableRbacAuthorization);
    if (!rbac) reasons.push("RBAC authorization must be enabled");
  }

  if (pol.disallow_public_network_access_enabled) {
    const pna =
      args?.properties?.publicNetworkAccess ?? args?.publicNetworkAccess ?? "Enabled";
    if (String(pna).toLowerCase() !== "disabled") {
      reasons.push("Public network access must be disabled");
    }
  }

  return result(reasons.length ? "deny" : "allow", reasons, suggestions, controls, policyIds);
}

function evalCreateVnet(args: any, pol: VnetPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const warns: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_virtual_network"];
  const suggestions: GovernanceSuggestion[] = [];

  const name = String(args?.name ?? "").trim();
  const loc = lower(args?.location);

  if (pol.name_regex) {
    const r = new RegExp(pol.name_regex);
    if (!r.test(name)) reasons.push(`name does not match required pattern ${pol.name_regex}`);
  }

  if (pol.allowed_regions?.length) {
    const allowed = pol.allowed_regions.map(lower);
    if (!allowed.includes(loc)) reasons.push(`region '${args?.location ?? ""}' not allowed (${pol.allowed_regions.join(", ")})`);
  }

  if (pol.require_tags?.length) {
    const tags = (args?.tags && typeof args.tags === "object" ? args.tags : {}) as Record<string, string>;
    const have = Object.keys(tags).map((k) => k.toLowerCase());
    const missing = pol.require_tags.filter((k) => !have.includes(k.toLowerCase()));
    if (missing.length) reasons.push(`missing required tag(s): ${missing.join(", ")}`);
  }

  if (pol.require_ddos_plan) {
    const hasDdos = !!args?.ddosProtectionPlan;
    if (!hasDdos) warns.push("Consider attaching a DDoS protection plan");
  }

  if (reasons.length) return result("deny", reasons, suggestions, controls, policyIds);
  if (warns.length) return result("warn", warns, suggestions, controls, policyIds);
  return result("allow", [], suggestions, controls, policyIds);
}

function evalCreateSubnet(args: any, pol: SubnetPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const warns: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_subnet"];
  const suggestions: GovernanceSuggestion[] = [];

  const name = String(args?.name ?? "").trim();
  if (pol.name_regex) {
    const r = new RegExp(pol.name_regex);
    if (!r.test(name)) reasons.push(`name does not match required pattern ${pol.name_regex}`);
  }

  if (pol.require_nsg) {
    const hasNsg = !!args?.networkSecurityGroup || !!args?.nsgId;
    if (!hasNsg) reasons.push("subnet must be associated with an NSG");
  }

  if (pol.require_private_endpoint_policies_disabled) {
    const disabled =
      args?.privateEndpointNetworkPolicies === "Disabled" ||
      args?.disablePrivateEndpointNetworkPolicies === true;
    if (!disabled) warns.push("disable private endpoint network policies for PE subnets");
  }

  if (reasons.length) return result("deny", reasons, suggestions, controls, policyIds);
  if (warns.length) return result("warn", warns, suggestions, controls, policyIds);
  return result("allow", [], suggestions, controls, policyIds);
}

function evalCreatePrivateEndpoint(args: any, pol: PrivateEndpointPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const warns: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_private_endpoint"];
  const suggestions: GovernanceSuggestion[] = [];

  const targetId = String(args?.targetResourceId ?? args?.privateLinkServiceId ?? "").toLowerCase();
  if (pol.target_regexes?.length) {
    const ok = pol.target_regexes.some((rx) => new RegExp(rx, "i").test(targetId));
    if (!ok) reasons.push("target resource type not permitted by policy");
  }

  if (pol.require_dns_zone_link) {
    const linked = !!(args?.dnsZoneGroup || args?.privateDnsZoneGroup);
    if (!linked) warns.push("link to Private DNS Zone for the target resource type");
  }

  if (reasons.length) return result("deny", reasons, suggestions, controls, policyIds);
  if (warns.length) return result("warn", warns, suggestions, controls, policyIds);
  return result("allow", [], suggestions, controls, policyIds);
}

function evalCreateLAW(args: any, pol: LogAnalyticsPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_log_analytics_workspace"];
  const suggestions: GovernanceSuggestion[] = [];

  const loc = lower(args?.location);
  if (pol.allowed_regions?.length) {
    const allowed = pol.allowed_regions.map(lower);
    if (!allowed.includes(loc)) reasons.push(`region '${args?.location ?? ""}' not allowed (${pol.allowed_regions.join(", ")})`);
  }

  if (pol.retention_days_allowlist?.length) {
    const days = Number(args?.retentionInDays ?? args?.retentionDays);
    if (!pol.retention_days_allowlist.includes(days)) {
      reasons.push(`retention '${days}' not allowed (${pol.retention_days_allowlist.join(", ")})`);
    }
  }

  return result(reasons.length ? "deny" : "allow", reasons, suggestions, controls, policyIds);
}

function evalCreatePublicIp(args: any, pol: PublicIpPolicy): GovernanceBlock {
  const reasons: string[] = [];
  const controls = pol.controls ?? [];
  const policyIds = ["azure.create_public_ip"];
  const suggestions: GovernanceSuggestion[] = [];

  if (pol.sku_allowlist?.length) {
    const sku = String(args?.sku ?? args?.skuName ?? "").trim();
    if (!pol.sku_allowlist.includes(sku)) reasons.push(`sku '${sku}' not allowed (${pol.sku_allowlist.join(", ")})`);
  }

  if (pol.allocation_allowlist?.length) {
    const alloc = String(args?.publicIPAllocationMethod ?? args?.allocationMethod ?? "").trim();
    if (!pol.allocation_allowlist.includes(alloc)) {
      reasons.push(`allocation '${alloc}' not allowed (${pol.allocation_allowlist.join(", ")})`);
    }
  }

  if (pol.version_allowlist?.length) {
    const ver = String(args?.publicIPAddressVersion ?? args?.ipVersion ?? "").trim();
    if (!pol.version_allowlist.includes(ver)) {
      reasons.push(`ip version '${ver}' not allowed (${pol.version_allowlist.join(", ")})`);
    }
  }

  return result(reasons.length ? "deny" : "allow", reasons, suggestions, controls, policyIds);
}

/* ------------------------------ Public API ------------------------------ */

export function ensurePolicyLoaded(): void {
  if (!loadedPolicy) {
    loadedPolicy = defaultPolicy();
    // Optional: surface validation warnings for local dev
    const warnings = validatePolicy(loadedPolicy);
    if (warnings.length) {
      // eslint-disable-next-line no-console
      console.warn("[governance-core] policy warnings:\n - " + warnings.join("\n - "));
    }
  }
}

/** Back-compat alias */
export function ensureLoaded(): void {
  ensurePolicyLoaded();
}

export function getPolicy(): PolicyDoc {
  ensurePolicyLoaded();
  return loadedPolicy!;
}

export function dumpPolicy(): any {
  return getPolicy();
}

/** Very light validator: flags unknown top-level azure tool keys (informational only) */
export function validatePolicy(p: PolicyDoc): string[] {
  const warnings: string[] = [];
  const knownTools = new Set([
    "create_resource_group",
    "create_app_service_plan",
    "create_web_app",
    "create_storage_account",
    "create_key_vault",
    "create_virtual_network",
    "create_subnet",
    "create_private_endpoint",
    "create_log_analytics_workspace",
    "create_public_ip",
  ]);

  if (!p?.azure) {
    warnings.push("Missing 'azure' section");
    return warnings;
  }
  for (const k of Object.keys(p.azure)) {
    if (!knownTools.has(k)) warnings.push(`azure.${k} — Unknown tool key (will be ignored)`);
  }
  return warnings;
}

/**
 * Evaluate a fully-qualified tool name against policy.
 * Accepts both `azure.*` and `platform.*` (aliases are mapped to azure.*).
 */
export function evaluate(toolFq: string, args: any, _ctx?: any): GovernanceBlock {
  ensurePolicyLoaded();
  const fq = String(toolFq || "");
  const azureFq = fq.startsWith("platform.") ? fq.replace(/^platform\./, "azure.") : fq;

  const azure = getPolicy().azure;

  switch (azureFq) {
    case "azure.create_resource_group":
      return evalCreateResourceGroup(args, azure.create_resource_group ?? {});
    case "azure.create_app_service_plan":
      return evalCreateAppServicePlan(args, azure.create_app_service_plan ?? {});
    case "azure.create_web_app":
      return evalCreateWebApp(args, azure.create_web_app ?? {});
    case "azure.create_storage_account":
      return evalCreateStorageAccount(args, azure.create_storage_account ?? {});
    case "azure.create_key_vault":
      return evalCreateKeyVault(args, azure.create_key_vault ?? {});
    case "azure.create_virtual_network":
      return evalCreateVnet(args, azure.create_virtual_network ?? {});
    case "azure.create_subnet":
      return evalCreateSubnet(args, azure.create_subnet ?? {});
    case "azure.create_private_endpoint":
      return evalCreatePrivateEndpoint(args, azure.create_private_endpoint ?? {});
    case "azure.create_log_analytics_workspace":
      return evalCreateLAW(args, azure.create_log_analytics_workspace ?? {});
    case "azure.create_public_ip":
      return evalCreatePublicIp(args, azure.create_public_ip ?? {});
    default:
      // Unknown tool: allow by default, but return an informational block
      return {
        decision: "allow",
        reasons: undefined,
        suggestions: undefined,
        controls: undefined,
        policyIds: [azureFq],
      };
  }
}