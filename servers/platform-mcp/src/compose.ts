// servers/platform-mcp/src/compose.ts (advisor-enabled, with platform.* aliases)
import { z } from 'zod';
import type { ToolDef } from 'mcp-http';

import { makeAzureTools, makeAzureScanTools, makeAzureRemediationTools } from '@platform/azure-core';

import { makeGithubTools, makeGithubScanTools, makeGithubRemediationTools } from '@platform/github-core';

import { evaluate as evaluateGovernance, getAtoProfile, getAtoRule } from '@platform/governance-core';

import { createAzureClientsFromEnv } from './clients.azure.js';
import { createGithubClientFromEnv } from './client.github.js';
import { auditToolWrapper } from './lib/audit.js';
import { makeAdvisorTools } from './tools/tools.advisor.js';
import { autoPlatformAliases } from './tools/tools.alias.js';

export async function composeTools(): Promise<ToolDef[]> {
  const azureClients = await createAzureClientsFromEnv();
  const githubClient = await createGithubClientFromEnv();

  const az = makeAzureTools({ clients: azureClients, evaluateGovernance, getAtoProfile, getAtoRule });
  const azScan = makeAzureScanTools({ clients: azureClients, getAtoProfile, getAtoRule });
  const azRem = makeAzureRemediationTools({ clients: azureClients });

  const gh = makeGithubTools({ clients: githubClient as any, evaluateGovernance, getAtoProfile, getAtoRule });
  const ghScan = makeGithubScanTools({ clients: githubClient as any, getAtoProfile, getAtoRule });
  const ghRem = makeGithubRemediationTools({ clients: githubClient as any });

  // Onboarding example
  const onboarding: ToolDef[] = [
    {
      name: 'platform.onboard_webapp_minimum',
      description: 'Create RG + Plan + Web App with baseline settings and LAW diagnostics link.',
      inputSchema: z.object({
        rg: z.string(),
        location: z.string(),
        plan: z.string(),
        web: z.string(),
        lawWorkspaceId: z.string().optional()
      }).strict(),
      handler: async (a) => {
        const steps: Array<{ name: string; result?: any; isError?: boolean }> = [];
        steps.push({ name: 'azure.create_resource_group', result: (await findAndCall(az, 'azure.create_resource_group', { name: a.rg, location: a.location })) });
        steps.push({ name: 'azure.create_app_service_plan', result: (await findAndCall(az, 'azure.create_app_service_plan', { resourceGroupName: a.rg, name: a.plan, location: a.location, sku: 'P1v3' })) });
        steps.push({ name: 'azure.create_web_app', result: (await findAndCall(az, 'azure.create_web_app', { resourceGroupName: a.rg, name: a.web, location: a.location, appServicePlanName: a.plan, httpsOnly: true, minimumTlsVersion: '1.2', ftpsState: 'Disabled' })) });
        if (a.lawWorkspaceId) {
          steps.push({
            name: 'azure.remediate_webapp_baseline',
            result: (await findAndCall(azRem, 'azure.remediate_webapp_baseline', {
              resourceGroupName: a.rg,
              name: a.web,
              defaults: { lawResourceId: a.lawWorkspaceId },
              dryRun: false
            }))
          });
        }
        return { content: [{ type: 'json', json: { status: 'done', steps } }] };
      }
    }
  ];

  const advisor = makeAdvisorTools();

  // Base catalog
  const base = [
    ...az, ...azScan, ...azRem,
    ...gh, ...ghScan, ...ghRem,
    ...onboarding,
    ...advisor,
  ];
// Auto-generate platform.* aliases for azure.* and github.* tools
const aliases = autoPlatformAliases(base, ['azure.', 'github.'], 'platform.');


const all = [...base, ...aliases];


return all.map(auditToolWrapper);
}


async function findAndCall(list: ToolDef[], name: string, args: any) {
const t = list.find(x => x.name === name);
if (!t) throw new Error(`tool not found: ${name}`);
return await t.handler(args);
}