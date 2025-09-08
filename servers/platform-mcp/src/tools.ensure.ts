import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { callRouterTool, firstJson, isSucceeded, mcpJson, mcpText, tryAutoVerify, coerceTags } from "./lib/runtime.js";

// A tiny wrapper that provides plan/dryRun/confirm UX (no governance here; MCPs do their own)
function makeRouterTool<T extends z.ZodObject<any>>(opts: {
  name: string;                       // platform.* tool name
  description: string;
  routerTool: string;                 // e.g. "azure.create_resource_group"
  schema: T;                          // zod schema (we extend with confirm/dryRun/context)
  toPayload: (args: z.infer<T>) => any;
  planLine: (args: z.infer<T>) => string;
  followup: (args: z.infer<T>) => string;
  successCheck?: (resultJson: any) => boolean;
  autoVerify?: boolean;               // default true
}): ToolDef {
  const fullSchema = opts.schema.extend({
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    context: z.object({
      upn: z.string().optional(),
      alias: z.string().optional(),
      region: z.string().optional()
    }).partial().optional()
  }).passthrough();

  return {
    name: opts.name,
    description: opts.description,
    inputSchema: fullSchema,
    handler: async (raw: z.infer<typeof fullSchema>) => {
      const payload = opts.toPayload(raw as any);
      const plan = { action: opts.routerTool, payload, mode: raw.dryRun ? "dryRun" : (raw.confirm ? "execute" : "review") };

      if (raw.dryRun || !raw.confirm) {
        const lines = [
          `Plan: ${opts.planLine(raw as any)}`,
          "",
          "To proceed, reply with:",
          opts.followup(raw as any)
        ];
        return { content: [...mcpJson({ status: "pending", plan }), ...mcpText(lines.join("\n"))] };
      }

      const exec = await callRouterTool(opts.routerTool, payload);
      if (!exec.ok) {
        const err = exec.body?.error || exec.body;
        return {
          isError: true,
          content: [
            ...mcpJson({ status: "error", plan, error: err }),
            ...mcpText(`❌ ${opts.planLine(raw as any)} — call failed`)
          ]
        };
      }

      const resultJson = firstJson(exec.body);
      const ok = opts.successCheck ? opts.successCheck(resultJson) : isSucceeded(resultJson);
      if (!ok) {
        return {
          isError: true,
          content: [
            ...mcpJson({ status: "error", plan, result: resultJson ?? exec.body }),
            ...mcpText(`❌ ${opts.planLine(raw as any)} — upstream did not return success`)
          ]
        };
      }

      if (opts.autoVerify !== false) {
        const av = await tryAutoVerify(opts.routerTool, payload, resultJson);
        if (!av.ok) {
          return {
            isError: true,
            content: [
              ...mcpJson({ status: "error", plan, result: resultJson, autoVerify: av }),
              ...mcpText(`❌ ${opts.planLine(raw as any)} — could not verify existence post-create`)
            ]
          };
        }
      }

      return {
        content: [
          ...mcpJson({ status: "done", plan, result: resultJson ?? exec.body }),
          ...mcpText(`✅ ${opts.planLine(raw as any)} — done.`)
        ]
      };
    }
  };
}

// ----------------- ENSURE / CREATE WRAPPERS -----------------

export const toolsEnsure: ToolDef[] = [

  // Resource Group
  makeRouterTool({
    name: "platform.create_resource_group",
    description: "Create an Azure Resource Group.",
    routerTool: "azure.create_resource_group",
    schema: z.object({
      name: z.string(),
      location: z.string(),
      tags: z.any().optional()
    }),
    toPayload: (a) => ({ name: a.name, location: a.location, tags: coerceTags(a.tags) }),
    planLine: (a) => `Create RG ${a.name} in ${a.location}`,
    followup: (a) => `@platform create_resource_group name "${a.name}" location "${a.location}"${a.tags ? ` tags ${JSON.stringify(coerceTags(a.tags))}` : ""} confirm true`
  }),

  // App Service Plan
  makeRouterTool({
    name: "platform.create_app_service_plan",
    description: "Create an App Service Plan.",
    routerTool: "azure.create_app_service_plan",
    schema: z.object({
      resourceGroupName: z.string(),
      planName: z.string(),
      location: z.string(),
      sku: z.object({
        name: z.enum(["P1v3", "P2v3"]).default("P1v3"),
        capacity: z.number().int().min(1).max(30).default(1)
      }).default({ name: "P1v3", capacity: 1 })
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      name: a.planName,
      location: a.location,
      sku: a.sku
    }),
    planLine: (a) => `Create App Service Plan ${a.planName} (${a.sku.name} x${a.sku.capacity})`,
    followup: (a) =>
      `@platform create_app_service_plan resourceGroupName "${a.resourceGroupName}" planName "${a.planName}" location "${a.location}" sku ${JSON.stringify(a.sku)} confirm true`
  }),

  // Web App
  makeRouterTool({
    name: "platform.create_web_app",
    description: "Create a Web App.",
    routerTool: "azure.create_web_app",
    schema: z.object({
      resourceGroupName: z.string(),
      appName: z.string(),
      planName: z.string(),
      location: z.string(),
      runtimeStack: z.enum(["NODE|20-lts", "DOTNET|8.0"])
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      name: a.appName,
      planName: a.planName,
      location: a.location,
      runtimeStack: a.runtimeStack
    }),
    planLine: (a) => `Create Web App ${a.appName} (${a.runtimeStack}) on ${a.planName}`,
    followup: (a) =>
      `@platform create_web_app resourceGroupName "${a.resourceGroupName}" appName "${a.appName}" planName "${a.planName}" location "${a.location}" runtimeStack "${a.runtimeStack}" confirm true`
  }),

  // Web App Identity (MSI)
  makeRouterTool({
    name: "platform.create_webapp_identity",
    description: "Enable system-assigned identity for a Web App.",
    routerTool: "azure.web_assign_system_identity",
    schema: z.object({
      resourceGroupName: z.string(),
      appName: z.string()
    }),
    toPayload: (a) => ({ resourceGroupName: a.resourceGroupName, name: a.appName }),
    planLine: (a) => `Enable MSI on ${a.appName}`,
    followup: (a) => `@platform create_webapp_identity resourceGroupName "${a.resourceGroupName}" appName "${a.appName}" confirm true`
  }),

  // Web App Settings
  makeRouterTool({
    name: "platform.create_webapp_settings",
    description: "Set/merge Web App settings.",
    routerTool: "azure.web_set_app_settings",
    schema: z.object({
      resourceGroupName: z.string(),
      appName: z.string(),
      settings: z.record(z.string())
    }),
    toPayload: (a) => ({ resourceGroupName: a.resourceGroupName, name: a.appName, settings: a.settings }),
    planLine: (a) => `Apply ${Object.keys(a.settings).length} app settings to ${a.appName}`,
    followup: (a) => `@platform create_webapp_settings resourceGroupName "${a.resourceGroupName}" appName "${a.appName}" confirm true`
  }),

  // Key Vault (RBAC)
  makeRouterTool({
    name: "platform.create_key_vault",
    description: "Create a Key Vault (RBAC, family A).",
    routerTool: "azure.create_key_vault",
    schema: z.object({
      resourceGroupName: z.string(),
      vaultName: z.string(),
      location: z.string(),
      tenantId: z.string(),
      skuName: z.enum(["standard", "premium"]).default("standard"),
      enableRbacAuthorization: z.boolean().default(true),
      publicNetworkAccess: z.enum(["Enabled", "Disabled"]).default("Enabled"),
      tags: z.any().optional()
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      name: a.vaultName,
      location: a.location,
      tenantId: a.tenantId,
      skuName: a.skuName,
      enableRbacAuthorization: a.enableRbacAuthorization,
      publicNetworkAccess: a.publicNetworkAccess,
      tags: coerceTags(a.tags)
    }),
    planLine: (a) => `Create Key Vault ${a.vaultName} in ${a.location}`,
    followup: (a) =>
      `@platform create_key_vault resourceGroupName "${a.resourceGroupName}" vaultName "${a.vaultName}" location "${a.location}" tenantId "${a.tenantId}" confirm true`
  }),

  // Storage Account
  makeRouterTool({
    name: "platform.create_storage_account",
    description: "Create a Storage Account (StorageV2, HTTPS only).",
    routerTool: "azure.create_storage_account",
    schema: z.object({
      resourceGroupName: z.string(),
      accountName: z.string().regex(/^[a-z0-9]{3,24}$/),
      location: z.string(),
      skuName: z.enum(["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"]).default("Standard_LRS"),
      kind: z.enum(["StorageV2", "BlobStorage", "BlockBlobStorage", "FileStorage", "Storage"]).default("StorageV2"),
      tags: z.any().optional()
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      accountName: a.accountName,
      location: a.location,
      skuName: a.skuName,
      kind: a.kind,
      tags: coerceTags(a.tags),
      enableHttpsTrafficOnly: true
    }),
    planLine: (a) => `Create Storage ${a.accountName} (${a.skuName}/${a.kind})`,
    followup: (a) =>
      `@platform create_storage_account resourceGroupName "${a.resourceGroupName}" accountName "${a.accountName}" location "${a.location}" skuName "${a.skuName}" confirm true`
  }),

  // Log Analytics
  makeRouterTool({
    name: "platform.create_log_analytics",
    description: "Create a Log Analytics Workspace.",
    routerTool: "azure.create_log_analytics_workspace",
    schema: z.object({
      resourceGroupName: z.string(),
      workspaceName: z.string(),
      location: z.string(),
      retentionInDays: z.number().int().min(7).max(730).default(30)
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      name: a.workspaceName,
      location: a.location,
      retentionInDays: a.retentionInDays
    }),
    planLine: (a) => `Create LAW ${a.workspaceName} (${a.retentionInDays}d)`,
    followup: (a) =>
      `@platform create_log_analytics resourceGroupName "${a.resourceGroupName}" workspaceName "${a.workspaceName}" location "${a.location}" confirm true`
  }),

  // Static Web App
  makeRouterTool({
    name: "platform.create_static_web_app",
    description: "Create an Azure Static Web App.",
    routerTool: "azure.create_static_web_app",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      skuName: z.enum(["Free", "Standard", "StandardPlus"]).default("Free")
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      name: a.name,
      location: a.location,
      skuName: a.skuName
    }),
    planLine: (a) => `Create SWA ${a.name} (${a.skuName})`,
    followup: (a) =>
      `@platform create_static_web_app resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" confirm true`
  }),

  // Link SWA to GitHub
  makeRouterTool({
    name: "platform.link_static_webapp_repo",
    description: "Link a Static Web App to a GitHub repo (CI/CD).",
    routerTool: "azure.link_static_webapp_repo",
    schema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      owner: z.string(),
      repo: z.string(),
      branch: z.string().default("main"),
      appLocation: z.string().default("/"),
      apiLocation: z.string().default("api"),
      outputLocation: z.string().default("dist"),
      buildPreset: z.string().optional()
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      name: a.name,
      owner: a.owner,
      repo: a.repo,
      branch: a.branch,
      appLocation: a.appLocation,
      apiLocation: a.apiLocation,
      outputLocation: a.outputLocation,
      buildPreset: a.buildPreset
    }),
    planLine: (a) => `Link SWA ${a.name} -> ${a.owner}/${a.repo}@${a.branch}`,
    followup: (a) =>
      `@platform link_static_webapp_repo resourceGroupName "${a.resourceGroupName}" name "${a.name}" owner "${a.owner}" repo "${a.repo}" branch "${a.branch}" confirm true`
  }),

  // VNet
  makeRouterTool({
    name: "platform.create_vnet",
    description: "Create a Virtual Network.",
    routerTool: "azure.create_virtual_network",
    schema: z.object({
      resourceGroupName: z.string(),
      vnetName: z.string(),
      location: z.string(),
      addressPrefixes: z.array(z.string()).default(["10.0.0.0/16"]),
      dnsServers: z.array(z.string()).optional()
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      name: a.vnetName,
      location: a.location,
      addressPrefixes: a.addressPrefixes,
      dnsServers: a.dnsServers
    }),
    planLine: (a) => `Create VNet ${a.vnetName} (${a.addressPrefixes.join(",")})`,
    followup: (a) =>
      `@platform create_vnet resourceGroupName "${a.resourceGroupName}" vnetName "${a.vnetName}" location "${a.location}" confirm true`
  }),

  // Subnet
  makeRouterTool({
    name: "platform.create_subnet",
    description: "Create a Subnet in a VNet.",
    routerTool: "azure.create_subnet",
    schema: z.object({
      resourceGroupName: z.string(),
      vnetName: z.string(),
      subnetName: z.string(),
      addressPrefix: z.string(),
      serviceEndpoints: z.array(z.string()).optional(),
      delegations: z.array(z.object({ serviceName: z.string() })).optional(),
      privateEndpointNetworkPolicies: z.enum(["Enabled", "Disabled"]).optional()
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      vnetName: a.vnetName,
      name: a.subnetName,
      addressPrefix: a.addressPrefix,
      serviceEndpoints: a.serviceEndpoints,
      delegations: a.delegations,
      privateEndpointNetworkPolicies: a.privateEndpointNetworkPolicies
    }),
    planLine: (a) => `Create Subnet ${a.subnetName} (${a.addressPrefix}) on ${a.vnetName}`,
    followup: (a) =>
      `@platform create_subnet resourceGroupName "${a.resourceGroupName}" vnetName "${a.vnetName}" subnetName "${a.subnetName}" addressPrefix "${a.addressPrefix}" confirm true`
  }),

  // Private Endpoint
  makeRouterTool({
    name: "platform.create_private_endpoint",
    description: "Create a Private Endpoint to a target resource.",
    routerTool: "azure.create_private_endpoint",
    schema: z.object({
      resourceGroupName: z.string(),
      peName: z.string(),
      location: z.string(),
      vnetName: z.string(),
      subnetName: z.string(),
      targetResourceId: z.string(),
      groupIds: z.array(z.string()).optional(),
      privateDnsZoneGroupName: z.string().optional(),
      privateDnsZoneIds: z.array(z.string()).optional()
    }),
    toPayload: (a) => ({
      resourceGroupName: a.resourceGroupName,
      name: a.peName,
      location: a.location,
      vnetName: a.vnetName,
      subnetName: a.subnetName,
      targetResourceId: a.targetResourceId,
      groupIds: a.groupIds,
      privateDnsZoneGroupName: a.privateDnsZoneGroupName,
      privateDnsZoneIds: a.privateDnsZoneIds
    }),
    planLine: (a) => `Create Private Endpoint ${a.peName} -> ${a.targetResourceId}`,
    followup: (a) =>
      `@platform create_private_endpoint resourceGroupName "${a.resourceGroupName}" peName "${a.peName}" location "${a.location}" vnetName "${a.vnetName}" subnetName "${a.subnetName}" targetResourceId "${a.targetResourceId}" confirm true`
  })
];