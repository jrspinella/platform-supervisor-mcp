import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { callRouterTool, firstJson, mcpJson, mcpText, pendingPlanText, provisioningSucceeded, coerceTags } from "./lib/runtime.js";

/**
 * Higher-level developer wizards that orchestrate multiple steps.
 * Pattern: produce a single “pending plan” with all intended sub-steps,
 * then, on confirm==true, execute each step via Router and summarize results.
 */

type Step = {
  title: string;
  call: { name: string; args: any };
  verify?: { name: string; toArgs: (resultJson: any) => any; expect?: (vjson: any) => boolean; };
};

async function runSteps(steps: Step[]) {
  const results: Array<{ title: string; ok: boolean; body: any }> = [];
  for (const s of steps) {
    const r = await callRouterTool(s.call.name, s.call.args);
    if (!r.ok) {
      results.push({ title: s.title, ok: false, body: r.body });
      return { ok: false, results };
    }
    const j = firstJson(r.body) ?? r.body;
    let ok = provisioningSucceeded(j);
    if (ok && s.verify) {
      const vr = await callRouterTool(s.verify.name, s.verify.toArgs(j));
      const vj = firstJson(vr.body) ?? vr.body;
      ok = vr.ok && (s.verify.expect ? s.verify.expect(vj) : !!vj);
      results.push({ title: s.title, ok, body: { result: j, verify: vj } });
      if (!ok) return { ok: false, results };
    } else {
      results.push({ title: s.title, ok, body: j });
      if (!ok) return { ok: false, results };
    }
  }
  return { ok: true, results };
}

export const toolsWizards: ToolDef[] = [
  // Basic Network: VNet + two subnets
  {
    name: "developer.wizard_basic_network",
    description: "Create a basic VNet with workload and private-endpoint subnets.",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      location: z.string(),
      vnetName: z.string(),
      workloadSubnetName: z.string().default("snet-workload"),
      workloadCidr: z.string(),
      privateEndpointSubnetName: z.string().default("snet-private-endpoint"),
      privateEndpointCidr: z.string(),
      tags: z.any().optional(),
      confirm: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    }),
    handler: async (a) => {
      const steps: Step[] = [
        {
          title: `VNet ${a.vnetName}`,
          call: { name: "azure.create_virtual_network", args: {
            resourceGroupName: a.resourceGroupName,
            name: a.vnetName,
            location: a.location,
            addressPrefixes: ["10.0.0.0/16"], // or infer from subnets later
            tags: coerceTags(a.tags)
          }},
          verify: {
            name: "azure.get_virtual_network",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, name: a.vnetName }),
            expect: v => !!v?.name
          }
        },
        {
          title: `Subnet ${a.workloadSubnetName}`,
          call: { name: "azure.create_subnet", args: {
            resourceGroupName: a.resourceGroupName,
            virtualNetworkName: a.vnetName,
            name: a.workloadSubnetName,
            addressPrefix: a.workloadCidr
          }},
          verify: {
            name: "azure.get_subnet",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, vnetName: a.vnetName, name: a.workloadSubnetName }),
            expect: v => !!v?.name
          }
        },
        {
          title: `Subnet ${a.privateEndpointSubnetName}`,
          call: { name: "azure.create_subnet", args: {
            resourceGroupName: a.resourceGroupName,
            virtualNetworkName: a.vnetName,
            name: a.privateEndpointSubnetName,
            addressPrefix: a.privateEndpointCidr,
            privateEndpointNetworkPolicies: "Disabled"
          }},
          verify: {
            name: "azure.get_subnet",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, vnetName: a.vnetName, name: a.privateEndpointSubnetName }),
            expect: v => !!v?.name
          }
        },
      ];

      if (!a.confirm || a.dryRun) {
        return {
          content: [
            ...mcpJson({
              status: "pending",
              plan: {
                action: "developer.wizard_basic_network",
                payload: a,
                steps: steps.map(s => s.title),
                mode: a.dryRun ? "dryRun" : "review"
              }
            }),
            ...mcpText(pendingPlanText({
              title: "developer.wizard_basic_network",
              bullets: [
                `**RG:** ${a.resourceGroupName}`,
                `**Location:** ${a.location}`,
                `**VNet:** ${a.vnetName}`,
                `**Subnets:** ${a.workloadSubnetName} (${a.workloadCidr}), ${a.privateEndpointSubnetName} (${a.privateEndpointCidr})`,
              ],
              followup: `@developer wizard_basic_network resourceGroupName "${a.resourceGroupName}" location "${a.location}" vnetName "${a.vnetName}" workloadSubnetName "${a.workloadSubnetName}" workloadCidr "${a.workloadCidr}" privateEndpointSubnetName "${a.privateEndpointSubnetName}" privateEndpointCidr "${a.privateEndpointCidr}" confirm true`,
              askProceed: true
            })),
          ]
        };
      }

      const run = await runSteps(steps);
      return {
        content: [
          ...mcpJson(run),
          ...mcpText(run.ok ? "✅ Basic network created." : "❌ Failed during basic network creation.")
        ],
        isError: !run.ok
      };
    }
  },

  // Dev environment (Plan + Web App + KV + Storage + LAW + MSI + app settings)
  {
    name: "developer.wizard_dev_environment",
    description: "Provision dev resources: plan, web app, key vault, storage, LAW; then enable MSI and set recommended settings.",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      location: z.string(),
      planName: z.string(),
      planSku: z.string().default("P1v3"),
      webAppName: z.string(),
      runtime: z.string().default("NODE|20-lts"),
      keyVaultName: z.string(),
      storageName: z.string().regex(/^[a-z0-9]{3,24}$/),
      logAnalyticsName: z.string(),
      tenantId: z.string(),
      tags: z.any().optional(),
      confirm: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    }),
    handler: async (a) => {
      const tags = coerceTags(a.tags);
      const steps: Step[] = [
        {
          title: `App Service Plan ${a.planName}`,
          call: { name: "azure.create_app_service_plan", args: {
            resourceGroupName: a.resourceGroupName,
            name: a.planName,
            location: a.location,
            sku: a.planSku,
            tags
          }},
          verify: {
            name: "azure.get_app_service_plan",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, name: a.planName }),
            expect: v => !!v?.name
          }
        },
        {
          title: `Web App ${a.webAppName}`,
          call: { name: "azure.create_web_app", args: {
            resourceGroupName: a.resourceGroupName,
            name: a.webAppName,
            location: a.location,
            appServicePlanName: a.planName,
            httpsOnly: true,
            linuxFxVersion: a.runtime,
            minimumTlsVersion: "1.2",
            ftpsState: "Disabled",
            tags
          }},
          verify: {
            name: "azure.get_web_app",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, name: a.webAppName }),
            expect: v => !!v?.name && !!v?.properties?.serverFarmId
          }
        },
        {
          title: `Key Vault ${a.keyVaultName}`,
          call: { name: "azure.create_key_vault", args: {
            resourceGroupName: a.resourceGroupName,
            name: a.keyVaultName,
            location: a.location,
            tenantId: a.tenantId,
            skuName: "standard",
            enableRbacAuthorization: true,
            publicNetworkAccess: "Enabled",
            tags
          }},
          verify: {
            name: "azure.get_key_vault",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, name: a.keyVaultName }),
            expect: v => !!v?.name
          }
        },
        {
          title: `Storage ${a.storageName}`,
          call: { name: "azure.create_storage_account", args: {
            resourceGroupName: a.resourceGroupName,
            name: a.storageName,
            location: a.location,
            skuName: "Standard_LRS",
            kind: "StorageV2",
            enableHttpsTrafficOnly: true,
            tags
          }},
          verify: {
            name: "azure.get_storage_account",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, accountName: a.storageName }),
            expect: v => !!v?.name
          }
        },
        {
          title: `Log Analytics ${a.logAnalyticsName}`,
          call: { name: "azure.create_log_analytics_workspace", args: {
            resourceGroupName: a.resourceGroupName,
            name: a.logAnalyticsName,
            location: a.location,
            sku: "PerGB2018",
            tags
          }},
          verify: {
            name: "azure.get_log_analytics_workspace",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, name: a.logAnalyticsName }),
            expect: v => !!v?.name
          }
        },
        {
          title: `Enable MSI on ${a.webAppName}`,
          call: { name: "azure.enable_system_assigned_identity", args: {
            resourceGroupName: a.resourceGroupName,
            name: a.webAppName,
            location: a.location
          }},
          verify: {
            name: "azure.get_web_app",
            toArgs: () => ({ resourceGroupName: a.resourceGroupName, name: a.webAppName }),
            expect: v => v?.identity?.type === "SystemAssigned"
          }
        },
        {
          title: `Apply App Settings`,
          call: { name: "azure.apply_app_settings", args: {
            resourceGroupName: a.resourceGroupName,
            name: a.webAppName,
            location: a.location,
            appServicePlanName: a.planName,
            serverFarmId: "",
            appSettings: [
              { name: "WEBSITE_RUN_FROM_PACKAGE", value: "0" },
              { name: "SCM_DO_BUILD_DURING_DEPLOYMENT", value: "true" },
              { name: "WEBSITE_HEALTHCHECK_MAXPINGFAILURES", value: "10" },
            ]
          }},
        },
      ];

      if (!a.confirm || a.dryRun) {
        return {
          content: [
            ...mcpJson({
              status: "pending",
              plan: {
                action: "developer.wizard_dev_environment",
                payload: a,
                steps: steps.map(s => s.title),
                mode: a.dryRun ? "dryRun" : "review"
              }
            }),
            ...mcpText(pendingPlanText({
              title: "developer.wizard_dev_environment",
              bullets: [
                `**RG:** ${a.resourceGroupName}`,
                `**Plan:** ${a.planName} (${a.planSku})`,
                `**Web App:** ${a.webAppName} (${a.runtime})`,
                `**KV/Storage/LAW:** ${a.keyVaultName}, ${a.storageName}, ${a.logAnalyticsName}`,
              ],
              followup: `@developer wizard_dev_environment resourceGroupName "${a.resourceGroupName}" location "${a.location}" planName "${a.planName}" planSku "${a.planSku}" webAppName "${a.webAppName}" runtime "${a.runtime}" keyVaultName "${a.keyVaultName}" storageName "${a.storageName}" logAnalyticsName "${a.logAnalyticsName}" tenantId "${a.tenantId}" confirm true`,
              askProceed: true
            })),
          ]
        };
      }

      const run = await runSteps(steps);
      return {
        content: [
          ...mcpJson(run),
          ...mcpText(run.ok ? "✅ Dev environment provisioned." : "❌ Failed during dev environment provisioning.")
        ],
        isError: !run.ok
      };
    }
  },

  // GitHub repo wizard
  {
    name: "developer.wizard_repo_from_template",
    description: "Create a GitHub repo from a template with typical defaults for dev.",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      templateOwner: z.string(),
      templateRepo: z.string(),
      private: z.boolean().default(true),
      description: z.string().optional(),
      confirm: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    }),
    handler: async (a) => {
      const step: Step = {
        title: `Repo ${a.owner}/${a.repo} from ${a.templateOwner}/${a.templateRepo}`,
        call: { name: "github.create_repo_from_template", args: {
          owner: a.owner, name: a.repo,
          templateOwner: a.templateOwner, templateRepo: a.templateRepo,
          private: a.private, description: a.description ?? ""
        }},
        verify: {
          name: "github.get_repo",
          toArgs: () => ({ owner: a.owner, repo: a.repo }),
          expect: v => !!v?.name && v.name.toLowerCase() === a.repo.toLowerCase()
        }
      };

      if (!a.confirm || a.dryRun) {
        return {
          content: [
            ...mcpJson({ status: "pending", plan: { action: "developer.wizard_repo_from_template", payload: a, steps: [step.title], mode: a.dryRun ? "dryRun" : "review" } }),
            ...mcpText(pendingPlanText({
              title: "developer.wizard_repo_from_template",
              bullets: [
                `**Owner:** ${a.owner}`,
                `**Repo:** ${a.repo}`,
                `**Template:** ${a.templateOwner}/${a.templateRepo}`,
                `**Private:** ${a.private ? "true" : "false"}`,
              ],
              followup: `@developer wizard_repo_from_template owner "${a.owner}" repo "${a.repo}" templateOwner "${a.templateOwner}" templateRepo "${a.templateRepo}" private ${a.private ? "true" : "false"} confirm true`,
              askProceed: true
            }))
          ]
        };
      }

      const run = await runSteps([step]);
      return {
        content: [
          ...mcpJson(run),
          ...mcpText(run.ok ? "✅ Repository created." : "❌ Failed to create repository.")
        ],
        isError: !run.ok
      };
    }
  },
];