import { z } from "zod";
import type { ToolDef } from "mcp-http";
import {
  mcpJson, mcpText, callRouterTool, firstJson, provisioningSucceeded,
  coerceTags, asBool, pendingPlanText
} from "./lib/runtime.js";
import { withGovernanceAll, registerPolicies, loadDefaultAzurePolicies } from "@platform/governance-core";
registerPolicies(loadDefaultAzurePolicies());

/**
 * Make a “platform-style” plan/confirm wrapper that calls through the Router
 * to another MCP tool (azure.* or github.*). Verification is optional per-tool.
 */
function makeRouterTool<T extends z.ZodObject<any>>(opts: {
  name: string;
  description: string;
  routerTool: string; // e.g., "azure.create_resource_group"
  schema: T;
  toPayload: (args: z.infer<T>) => any;
  planBullets: (args: z.infer<T>) => string[];
  followup: (args: z.infer<T>) => string;
  successCheck?: (resultJson: any) => boolean;
  verifyCalls?: Array<{
    name: string;
    toPayload: (args: z.infer<T>, payload: any, resultJson: any) => any;
    expect?: (verifyJson: any, args: z.infer<T>) => boolean;
    failText?: (args: z.infer<T>) => string;
  }>;
}): ToolDef {
  const fullSchema = opts.schema.extend({
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  }).passthrough();

  return {
    name: opts.name,
    description: opts.description,
    inputSchema: fullSchema,
    handler: async (raw: any) => {
      const payload = opts.toPayload(raw);
      const mode = raw.dryRun ? "dryRun" : (raw.confirm ? "execute" : "review");

      if (!raw.confirm || raw.dryRun) {
        return {
          content: [
            ...mcpJson({ status: "pending", plan: { action: opts.routerTool, payload, mode } }),
            ...mcpText(pendingPlanText({
              title: opts.routerTool,
              bullets: opts.planBullets(raw),
              followup: opts.followup(raw),
              askProceed: true
            })),
          ]
        };
      }

      const exec = await callRouterTool(opts.routerTool, payload);
      if (!exec.ok) {
        const err = exec.body?.error || exec.body;
        return {
          content: [
            ...mcpJson({ status: "error", plan: { action: opts.routerTool, payload, mode }, error: err }),
            ...mcpText(`❌ ${opts.name} failed: ${JSON.stringify(err).slice(0, 800)}`)
          ],
          isError: true
        };
      }

      const resultJson = firstJson(exec.body) ?? exec.body;
      const pass = opts.successCheck ? opts.successCheck(resultJson) : provisioningSucceeded(resultJson);
      if (!pass) {
        return {
          content: [
            ...mcpJson({ status: "error", result: resultJson }),
            ...mcpText(`❌ ${opts.name} — provider response did not indicate success`)
          ],
          isError: true
        };
      }

      // verify (optional)
      if (opts.verifyCalls?.length) {
        for (const v of opts.verifyCalls) {
          const vr = await callRouterTool(v.name, v.toPayload(raw, payload, resultJson));
          if (!vr.ok) {
            return {
              content: [
                ...mcpJson({ status: "error", verifyFailed: { tool: v.name, body: vr.body } }),
                ...mcpText(v.failText?.(raw) || `❌ Verification call ${v.name} failed`)
              ],
              isError: true
            };
          }
          const vjson = firstJson(vr.body) ?? vr.body;
          const ok = v.expect ? v.expect(vjson, raw) : !!vjson;
          if (!ok) {
            return {
              content: [
                ...mcpJson({ status: "error", verifyFailed: { tool: v.name, verify: vjson } }),
                ...mcpText(v.failText?.(raw) || `❌ Verification did not pass`)
              ],
              isError: true
            };
          }
        }
      }

      return {
        content: [
          ...mcpJson({ status: "done", result: resultJson }),
          ...mcpText(`✅ ${opts.name} — done.`)
        ]
      };
    }
  };
}

function setGovernedAction(a: any, tool: string) {
  return { ...a, __governed_action: tool };
}

/* =========================
 *  Ensure: GitHub + Azure
 * ========================= */

export const toolsEnsure: ToolDef[] = [
  // --- Azure: Resource Group (developer.* wrapper) ---
  makeRouterTool({
    name: "developer.create_resource_group",
    description: "Create an Azure Resource Group.",
    routerTool: "azure.create_resource_group",
    schema: z.object({
      name: z.string(),
      location: z.string(),
      tags: z.any().optional()
    }),
    toPayload: a => ({ name: a.name, location: a.location, tags: coerceTags(a.tags) }),
    planBullets: a => [
      `**Name:** ${a.name}`,
      `**Location:** ${a.location}`,
      `**Tags:** \`${JSON.stringify(coerceTags(a.tags) || {})}\``
    ],
    followup: a => `@developer create_resource_group name "${a.name}" location "${a.location}"${a.tags ? ` tags ${JSON.stringify(coerceTags(a.tags))}` : ""} confirm true`,
    verifyCalls: [{
      name: "azure.get_resource_group",
      toPayload: (a) => ({ name: a.name }),
      expect: (vj, a) => !!vj?.name && vj.name === a.name
    }]
  }),

  // --- Azure: App Service plan ---
  makeRouterTool({
    name: "developer.create_app_service_plan",
    description: "Create an App Service Plan.",
    routerTool: "azure.create_app_service_plan",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      sku: z.string().default("P1v3"),
      tags: z.any().optional()
    }),
    toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name, location: a.location, sku: a.sku, tags: coerceTags(a.tags) }),
    planBullets: a => [
      `**Plan:** ${a.name}`,
      `**RG:** ${a.resourceGroupName}`,
      `**Location:** ${a.location}`,
      `**SKU:** ${a.sku}`
    ],
    followup: a => `@developer create_app_service_plan resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" sku "${a.sku}" confirm true`,
    verifyCalls: [{
      name: "azure.get_app_service_plan",
      toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
      expect: (vj, a) => !!vj?.name && vj.name === a.name
    }]
  }),

  // --- Azure: Web App ---
  makeRouterTool({
    name: "developer.create_web_app",
    description: "Create a Web App on an App Service Plan.",
    routerTool: "azure.create_web_app",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      appServicePlanName: z.string(),
      runtime: z.string().default("NODE|20-lts"),
      httpsOnly: z.boolean().default(true),
      minTls: z.enum(["1.0", "1.1", "1.2"]).default("1.2"),
      ftpsState: z.enum(["AllAllowed", "FtpsOnly", "Disabled"]).default("Disabled"),
      tags: z.any().optional()
    }),
    toPayload: a => ({
      resourceGroupName: a.resourceGroupName,
      name: a.name,
      location: a.location,
      appServicePlanName: a.appServicePlanName,
      // let azure MCP translate planName -> serverFarmId
      httpsOnly: a.httpsOnly,
      linuxFxVersion: a.runtime,
      minimumTlsVersion: a.minTls,
      ftpsState: a.ftpsState,
      tags: coerceTags(a.tags)
    }),
    planBullets: a => [
      `**Web App:** ${a.name}`,
      `**Plan:** ${a.appServicePlanName}`,
      `**Runtime:** ${a.runtime}`,
      `**TLS:** ${a.minTls}, **HTTPS-only:** ${a.httpsOnly ? "true" : "false"}`
    ],
    followup: a => `@developer create_web_app resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" appServicePlanName "${a.appServicePlanName}" runtime "${a.runtime}" confirm true`,
    verifyCalls: [{
      name: "azure.get_web_app",
      toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
      expect: (vj, a) => !!vj?.name && vj.name === a.name && !!vj?.properties?.serverFarmId
    }]
  }),

  // --- Azure: Enable MSI on Web App ---
  makeRouterTool({
    name: "developer.enable_webapp_identity",
    description: "Enable system-assigned identity (MSI) on a Web App.",
    routerTool: "azure.enable_system_assigned_identity",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string()
    }),
    toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name, location: a.location }),
    planBullets: a => [
      `**Web App:** ${a.name}`,
      `**RG:** ${a.resourceGroupName}`,
      `**Location:** ${a.location}`
    ],
    followup: a => `@developer enable_webapp_identity resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" confirm true`,
    verifyCalls: [{
      name: "azure.get_web_app",
      toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
      expect: (vj) => vj?.identity?.type === "SystemAssigned"
    }]
  }),

  // --- Azure: Apply App Settings ---
  makeRouterTool({
    name: "developer.apply_webapp_settings",
    description: "Set/merge App Settings on a Web App.",
    routerTool: "azure.apply_app_settings",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      appServicePlanName: z.string(),
      settings: z.record(z.string()),
    }),
    toPayload: a => ({
      resourceGroupName: a.resourceGroupName,
      name: a.name,
      location: a.location,
      appServicePlanName: a.appServicePlanName,
      serverFarmId: "", // azure MCP will compute; kept for parity
      appSettings: Object.entries(a.settings).map(([k, v]) => ({ name: k, value: v })),
    }),
    planBullets: a => [
      `**Web App:** ${a.name}`,
      `**Settings:** ${Object.keys(a.settings).length} key(s)`
    ],
    followup: a => `@developer apply_webapp_settings resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" appServicePlanName "${a.appServicePlanName}" confirm true`,
  }),

  // --- Azure: Key Vault ---
  makeRouterTool({
    name: "developer.create_key_vault",
    description: "Create a Key Vault (RBAC enabled).",
    routerTool: "azure.create_key_vault",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      tenantId: z.string(),
      skuName: z.enum(["standard", "premium"]).default("standard"),
      enableRbacAuthorization: z.boolean().default(true),
      publicNetworkAccess: z.enum(["Enabled", "Disabled"]).default("Enabled"),
      tags: z.any().optional(),
    }),
    toPayload: a => ({
      resourceGroupName: a.resourceGroupName,
      name: a.name,
      location: a.location,
      tenantId: a.tenantId,
      skuName: a.skuName,
      enableRbacAuthorization: a.enableRbacAuthorization,
      publicNetworkAccess: a.publicNetworkAccess,
      tags: coerceTags(a.tags),
    }),
    planBullets: a => [
      `**KeyVault:** ${a.name}`,
      `**RG:** ${a.resourceGroupName}`,
      `**Location:** ${a.location}`,
      `**RBAC:** ${a.enableRbacAuthorization ? "true" : "false"}`
    ],
    followup: a => `@developer create_key_vault resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" tenantId "${a.tenantId}" confirm true`,
    verifyCalls: [{
      name: "azure.get_key_vault",
      toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
      expect: (vj, a) => !!vj?.name && vj.name === a.name && (a.enableRbacAuthorization ? vj?.properties?.enableRbacAuthorization === true : true)
    }]
  }),

  // --- Azure: Storage Account ---
  makeRouterTool({
    name: "developer.create_storage_account",
    description: "Create a Storage Account (StorageV2, HTTPS only).",
    routerTool: "azure.create_storage_account",
    schema: z.object({
      resourceGroupName: z.string(),
      accountName: z.string().regex(/^[a-z0-9]{3,24}$/),
      location: z.string(),
      skuName: z.enum(["Standard_LRS","Standard_GRS","Standard_RAGRS","Standard_ZRS","Premium_LRS"]).default("Standard_LRS"),
      kind: z.enum(["StorageV2","BlobStorage","BlockBlobStorage","FileStorage","Storage"]).default("StorageV2"),
      tags: z.any().optional()
    }),
    toPayload: a => ({
      resourceGroupName: a.resourceGroupName,
      name: a.accountName,
      location: a.location,
      skuName: a.skuName,
      kind: a.kind,
      enableHttpsTrafficOnly: true,
      tags: coerceTags(a.tags),
    }),
    planBullets: a => [
      `**Account:** ${a.accountName}`,
      `**SKU:** ${a.skuName} / ${a.kind}`
    ],
    followup: a => `@developer create_storage_account resourceGroupName "${a.resourceGroupName}" accountName "${a.accountName}" location "${a.location}" skuName "${a.skuName}" confirm true`,
    verifyCalls: [{
      name: "azure.get_storage_account",
      toPayload: a => ({ resourceGroupName: a.resourceGroupName, accountName: a.accountName }),
      expect: (vj, a) => !!vj?.name && vj.name.toLowerCase() === a.accountName.toLowerCase()
    }]
  }),

  // --- Azure: Log Analytics Workspace ---
  makeRouterTool({
    name: "developer.create_log_analytics",
    description: "Create a Log Analytics Workspace.",
    routerTool: "azure.create_log_analytics_workspace",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      sku: z.string().default("PerGB2018"),
      tags: z.any().optional()
    }),
    toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name, location: a.location, sku: a.sku, tags: coerceTags(a.tags) }),
    planBullets: a => [
      `**LAW:** ${a.name}`,
      `**RG:** ${a.resourceGroupName}`,
      `**Location:** ${a.location}`,
      `**SKU:** ${a.sku}`
    ],
    followup: a => `@developer create_log_analytics resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" confirm true`,
    verifyCalls: [{
      name: "azure.get_log_analytics_workspace",
      toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
      expect: (vj, a) => !!vj?.name && vj.name === a.name
    }]
  }),

  // --- Azure: Network (VNet/Subnet) ---
  makeRouterTool({
    name: "developer.create_vnet",
    description: "Create a Virtual Network.",
    routerTool: "azure.create_virtual_network",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      addressPrefixes: z.array(z.string()).default(["10.0.0.0/16"]),
      dnsServers: z.array(z.string()).optional(),
      tags: z.any().optional()
    }),
    toPayload: a => ({
      resourceGroupName: a.resourceGroupName,
      name: a.name,
      location: a.location,
      addressPrefixes: a.addressPrefixes,
      dnsServers: a.dnsServers,
      tags: coerceTags(a.tags)
    }),
    planBullets: a => [
      `**VNet:** ${a.name}`,
      `**Prefixes:** ${a.addressPrefixes.join(", ")}`
    ],
    followup: a => `@developer create_vnet resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" confirm true`,
    verifyCalls: [{
      name: "azure.get_virtual_network",
      toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
      expect: (vj, a) => !!vj?.name && vj.name === a.name
    }]
  }),

  makeRouterTool({
    name: "developer.create_subnet",
    description: "Create a subnet in a VNet.",
    routerTool: "azure.create_subnet",
    schema: z.object({
      resourceGroupName: z.string(),
      vnetName: z.string(),
      name: z.string(),
      addressPrefix: z.string(),
      serviceEndpoints: z.array(z.string()).optional(),
      tags: z.any().optional()
    }),
    toPayload: a => ({
      resourceGroupName: a.resourceGroupName,
      virtualNetworkName: a.vnetName,
      name: a.name,
      addressPrefix: a.addressPrefix,
      serviceEndpoints: a.serviceEndpoints,
      tags: coerceTags(a.tags),
    }),
    planBullets: a => [
      `**Subnet:** ${a.name}`,
      `**VNet:** ${a.vnetName}`,
      `**CIDR:** ${a.addressPrefix}`
    ],
    followup: a => `@developer create_subnet resourceGroupName "${a.resourceGroupName}" vnetName "${a.vnetName}" name "${a.name}" addressPrefix "${a.addressPrefix}" confirm true`,
    verifyCalls: [{
      name: "azure.get_subnet",
      toPayload: a => ({ resourceGroupName: a.resourceGroupName, vnetName: a.vnetName, name: a.name }),
      expect: (vj, a) => !!vj?.name && vj.name === a.name
    }]
  }),

  // --- GitHub: repo from template ---
  makeRouterTool({
    name: "developer.create_repo_from_template",
    description: "Create a repo from a template (private/public) with description.",
    routerTool: "github.create_repo_from_template",
    schema: z.object({
      owner: z.string(),                  // destination org/user
      repo: z.string(),                   // destination repo name
      templateOwner: z.string(),
      templateRepo: z.string(),
      private: z.boolean().default(true),
      description: z.string().optional(),
    }),
    toPayload: a => ({
      owner: a.owner,
      name: a.repo,
      templateOwner: a.templateOwner,
      templateRepo: a.templateRepo,
      private: a.private,
      description: a.description ?? ""
    }),
    planBullets: a => [
      `**Owner:** ${a.owner}`,
      `**Repo:** ${a.repo}`,
      `**From Template:** ${a.templateOwner}/${a.templateRepo}`,
      `**Private:** ${a.private ? "true" : "false"}`
    ],
    followup: a => `@developer create_repo_from_template owner "${a.owner}" repo "${a.repo}" templateOwner "${a.templateOwner}" templateRepo "${a.templateRepo}" private ${a.private ? "true" : "false"} confirm true`,
    verifyCalls: [{
      name: "github.get_repo",
      toPayload: a => ({ owner: a.owner, repo: a.repo }),
      expect: (vj, a) => !!vj?.name && vj.name?.toLowerCase() === a.repo.toLowerCase()
    }]
  }),
];