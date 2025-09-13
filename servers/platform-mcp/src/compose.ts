// servers/platform-mcp/src/compose.ts
import type { ToolDef } from "mcp-http";

import { makeAzureRemediationTools, makeAzureScanTools, makeAzureTools } from "@platform/azure-core";

import { evaluate as evaluateGovernance, getAtoProfile, getAtoRule, hasAtoProfile, ensureLoaded as ensureGovLoaded, } from "@platform/governance-core";

import { createAzureClientsFromEnv } from "./clients.azure.js";
import { auditToolWrapper } from "./tools/tools.audit.js";
import { makeAdvisorTools } from "./tools/tools.advisor.js";
import { autoPlatformAliases } from "./tools/tools.alias.js";
import { makePolicyTools } from "./tools/tools.policy.js";

export async function composeTools(): Promise<ToolDef[]> {
  // Ensure governance doc in memory (respects GOV_POL_DIR env)
  ensureGovLoaded();

  const azureClients = await createAzureClientsFromEnv();

  const az = makeAzureTools({
    clients: azureClients,
    evaluateGovernance,
    getAtoProfile,
    getAtoRule,
    hasAtoProfile,
    namespace: "azure."
  });

  const azScans = makeAzureScanTools({
    clients: azureClients,
    getAtoProfile,
    getAtoRule,
    namespace: "azure.",
  });

  const azRemediate = makeAzureRemediationTools({
    clients: azureClients,
    namespace: "azure.",
  });

  const advisor = makeAdvisorTools();
  const policy = makePolicyTools();

  const base: ToolDef[] = [
    ...az,
    ...azScans,
    ...azRemediate,
    ...advisor,
    ...policy,
  ];

  // platform.* aliases for all azure.* (and advisor/policy where it makes sense)
  const aliases = autoPlatformAliases(base, ["azure."], "platform.");

  const catalog = [...base, ...aliases];

  // audit wrapper
  return catalog.map(auditToolWrapper);
}