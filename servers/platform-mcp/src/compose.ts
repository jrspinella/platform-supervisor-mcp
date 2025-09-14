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
  const DOMAIN_KEY_MAP: Record<string, AtoProfileKey> = {
    webapp: "webapp",
    app: "webapp",
    appPlan: "appPlan",
    plan: "appPlan",
    functionApp: "functionApp",
    storage: "storageAccount",
    storageAccount: "storageAccount",
    sql: "sqlDatabase",
    sqlDatabase: "sqlDatabase",
    keyVault: "key_vault",
    key_vault: "key_vault",
    network: "network",
    vnet: "network",
    logAnalytics: "logAnalyticsWorkspace",
    log_analytics: "logAnalyticsWorkspace",
    workspace: "logAnalyticsWorkspace",
    law: "logAnalyticsWorkspace",
    resourceGroup: "resourceGroup",
    rg: "resourceGroup",
  };

  const adaptedGetAtoRule = (domain: string, profile: string, code: string) => {
    const key = DOMAIN_KEY_MAP[domain] ?? (domain as AtoProfileKey);
    // ✅ correct arg order: (profile, kind, code)
    const rule = getAtoRule(profile, key, code);
    if (!rule) return {};
    return {
      controlIds: rule.controls || [],
      suggest: rule.suggest || undefined,
    };
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
    namespace: "azure.",
  });

  // 5) ATO scan tools (they only need ATO accessors)
  const azScans = makeAzureScanTools({
    clients: azureClients,
    getAtoProfile: adaptedGetAtoProfile,
    getAtoRule: adaptedGetAtoRule,
    hasAtoProfile: adaptedHasAtoProfile,
    namespace: "azure.",
  });

  // 6) Optional remediation helpers
  const azRemediate = makeAzureRemediationTools({
    clients: azureClients,
    namespace: "azure.",
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

  // 10) Audit wrapper last
  return [...base, ...aliases].map(auditToolWrapper);
}
