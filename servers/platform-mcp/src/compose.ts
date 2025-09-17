// servers/platform-mcp/src/compose.ts
import type { ToolDef } from "mcp-http";

import {
  makeAzureRemediationTools,
  makeAzureScanTools,
  makeAzureTools,
} from "@platform/azure-core";

import {
  evaluate as evaluateGovernance,
  getAtoProfile,
  getAtoRule,
  hasAtoProfile,
  ensurePolicyLoaded,  // ✅ correct import
  ensureAtoLoaded,     // ✅ load ATO profiles
} from "@platform/governance-core";

import { createAzureClientsFromEnv } from "./clients.azure.js";
import { auditToolWrapper } from "./tools/tools.audit.js";
import { makeAdvisorTools } from "./tools/tools.advisor.js";
import { autoPlatformAliases } from "./tools/tools.alias.js";
import { makePolicyTools } from "./tools/tools.policy.js";
import { makeAtoTools } from "./tools/tools.ato.js";
import { makePlanTools } from "./tools/tools.plan.js";

// Optional: constrain known ATO domains for type safety (not strictly required)
type AtoProfileKey =
  | "webapp"
  | "appPlan"
  | "functionApp"
  | "storageAccount"
  | "sqlDatabase"
  | "network"
  | "key_vault"
  | "logAnalyticsWorkspace"
  | "resourceGroup";

export async function composeTools(): Promise<ToolDef[]> {
  // 1) Load governance + ATO (supports YAML or code-based via env in governance-core)
  ensurePolicyLoaded();
  ensureAtoLoaded();

  // 2) Build Azure SDK clients (respects Gov cloud via env)
  const azureClients = await createAzureClientsFromEnv();

  // 3) Adapt governance-core ATO helpers to the shape azure-core expects
  const DOMAIN_ALIASES: Record<string, string[]> = {
    webapp: ["webapp", "web_app", "app"],
    appPlan: ["appPlan", "app_service_plan", "asp", "plan"],
    storageAccount: ["storageAccount", "storage_account", "sa"],
    key_vault: ["keyVault", "key_vault", "kv"],
    logAnalyticsWorkspace: ["logAnalytics", "log_analytics", "logAnalyticsWorkspace", "law", "workspace"],
    network: ["network", "vnet", "virtualNetwork", "virtual_network"],
    resourceGroup: ["resourceGroup", "resource_group", "rg"],
  };

  const adaptedGetAtoRule = (domain: string, profile: string, code: string) => {
    for (const d of DOMAIN_ALIASES[domain] ?? [domain]) {
      const rule = getAtoRule(profile, d as any, code); // (profile, domain, code)
      if (rule) {
        return {
          controlIds: rule.controls ?? [],
          suggest: rule.suggest ?? undefined,
        };
      }
    }
    return null;
  };

  const adaptedHasAtoProfile = (_domain: string, profile: string) => hasAtoProfile(profile);
  const adaptedGetAtoProfile = (profile: string) => getAtoProfile(profile);

  // 4) Core Azure create/get tools (governed)
  const az = makeAzureTools({
    clients: azureClients,
    evaluateGovernance,
    getAtoProfile: adaptedGetAtoProfile,
    getAtoRule: adaptedGetAtoRule,
    hasAtoProfile: adaptedHasAtoProfile,
  });

  // 5) ATO scan tools (they only need ATO accessors)
  const azScans = makeAzureScanTools({
    clients: azureClients,
    getAtoProfile: adaptedGetAtoProfile,
    getAtoRule: adaptedGetAtoRule,
    hasAtoProfile: adaptedHasAtoProfile,
  });

  // 6) Optional remediation helpers
  const azRemediate = makeAzureRemediationTools({
    clients: azureClients,
    evaluateGovernance,
    getAtoProfile: adaptedGetAtoProfile,
    getAtoRule: adaptedGetAtoRule,
    hasAtoProfile: adaptedHasAtoProfile,
  });

  // 7) Advisor + policy + ATO utility tools
  const advisor = makeAdvisorTools();
  const policy = makePolicyTools();
  const ato = makeAtoTools();

  // 8) Base catalog
  const base: ToolDef[] = [
    ...az,
    ...azScans,
    ...azRemediate,
    ...advisor,
    ...policy,
    ...ato,
  ];

  // 9) platform.* aliases for azure.* tools
  const aliases = autoPlatformAliases(base, ["azure."], "platform.");
  const catalogRaw = [...base, ...aliases];

  // Wrap with audit
  const catalogAudited = catalogRaw.map(auditToolWrapper);

  // Plan tool needs a resolver that sees the audited catalog
  const lookup = new Map<string, ToolDef>(catalogAudited.map((t) => [t.name, t]));
  const planTools = makePlanTools((name) => lookup.get(name));

  // Final list (audited tools + plan tool)
  return [...catalogAudited, ...planTools];
}
