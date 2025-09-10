// servers/platform-mcp/src/tools.azure.ensure.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import {
  mcpJson, mcpText, firstJson, provisioningSucceeded,
  coerceTags, pendingPlanText
} from "./lib/runtime.js";

/**
 * makeEnsureTools(call) — platform.* wrappers that call local azure.* tools
 * via the injected `call(name, args)` function.
 */
export function makeEnsureTools(
  call: (name: string, args: any) => Promise<{ content?: any[]; isError?: boolean }>
): ToolDef[] {

  /** Shared wrapper for plan/execute/verify */
  function makeRouterTool<T extends z.ZodObject<any>>(opts: {
    name: string;
    description: string;
    azureTool: string;
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

        // Hold/pending plan
        if (!raw.confirm || raw.dryRun) {
          return {
            content: [
              ...mcpJson({ status: "pending", plan: { action: opts.azureTool, payload, mode } }),
              ...mcpText(pendingPlanText({
                title: opts.azureTool,
                bullets: opts.planBullets(raw),
                followup: opts.followup(raw),
                askProceed: true
              })),
            ]
          };
        }

        // Execute locally (no router hop)
        const exec = await call(opts.azureTool, payload);
        if (exec?.isError) {
          // Try to extract a helpful message
          const dump = JSON.stringify(exec, null, 2);
          return {
            content: [
              ...mcpJson({ status: "error", plan: { action: opts.azureTool, payload, mode }, error: exec }),
              ...mcpText(`❌ ${opts.name} failed:\n${dump}`)
            ],
            isError: true
          };
        }

        // Try to pull a JSON payload out of MCP content; otherwise treat the whole exec as the payload
        const resultJson = firstJson(exec) ?? exec;

        // Accept broader success shapes (ARM objects, etc.)
        const pass =
          (opts.successCheck ? opts.successCheck(resultJson) : provisioningSucceeded(resultJson))
          || !!(resultJson && (resultJson.id || resultJson.name));

        if (!pass) {
          return {
            content: [
              ...mcpJson({ status: "error", result: resultJson }),
              ...mcpText(`❌ ${opts.name} — provider response did not indicate success`)
            ],
            isError: true
          };
        }

        // Optional verification chain (still local)
        if (opts.verifyCalls?.length) {
          for (const v of opts.verifyCalls) {
            const vr = await call(v.name, v.toPayload(raw, payload, resultJson));
            if (vr?.isError) {
              return {
                content: [
                  ...mcpJson({ status: "error", verifyFailed: { tool: v.name, body: vr } }),
                  ...mcpText(v.failText?.(raw) || `❌ Verification call ${v.name} failed`)
                ],
                isError: true
              };
            }
            const vjson = firstJson(vr) ?? vr;
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

  // ───────────────────────── platform.* wrappers (local → azure.*) ─────────────────────────

  const tools: ToolDef[] = [

    // Resource Group
    makeRouterTool({
      name: "platform.create_resource_group",
      description: "Create an Azure Resource Group.",
      azureTool: "azure.create_resource_group",
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
      followup: a => `@platform create_resource_group name "${a.name}" location "${a.location}"${a.tags ? ` tags ${JSON.stringify(coerceTags(a.tags))}` : ""} confirm true`,
      // Accept ARM-ish success
      successCheck: (j) => !!(j && (j.id || j.name || j.properties)),
      verifyCalls: [{
        name: "azure.get_resource_group",
        toPayload: (a) => ({ name: a.name }),
        expect: (vj, a) => !!vj?.name && vj.name.toLowerCase() === a.name.toLowerCase()
      }]
    }),

    // App Service Plan
    makeRouterTool({
      name: "platform.create_app_service_plan",
      description: "Create an App Service Plan.",
      azureTool: "azure.create_app_service_plan",
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
      followup: a => `@platform create_app_service_plan resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" sku "${a.sku}" confirm true`,
      successCheck: (j) => !!(j && (j.id || j.name)),
      verifyCalls: [{
        name: "azure.get_app_service_plan",
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
        expect: (vj, a) => !!vj?.name && vj.name === a.name
      }]
    }),

    // Web App
    makeRouterTool({
      name: "platform.create_web_app",
      description: "Create a Web App on an App Service Plan.",
      azureTool: "azure.create_web_app",
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
      followup: a => `@platform create_web_app resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" appServicePlanName "${a.appServicePlanName}" runtime "${a.runtime}" confirm true`,
      successCheck: (j) => !!(j && (j.id || j.name)),
      verifyCalls: [{
        name: "azure.get_web_app",
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
        expect: (vj, a) => !!vj?.name && vj.name === a.name && !!vj?.properties?.serverFarmId
      }]
    }),

    // Enable MSI
    makeRouterTool({
      name: "platform.enable_webapp_identity",
      description: "Enable system-assigned identity (MSI) on a Web App.",
      azureTool: "azure.enable_system_assigned_identity",
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
      followup: a => `@platform enable_webapp_identity resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" confirm true`,
      successCheck: (j) => !!j,
      verifyCalls: [{
        name: "azure.get_web_app",
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
        expect: (vj) => vj?.identity?.type === "SystemAssigned"
      }]
    }),

    // App Settings
    makeRouterTool({
      name: "platform.apply_webapp_settings",
      description: "Set/merge App Settings on a Web App.",
      azureTool: "azure.apply_app_settings",
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
        serverFarmId: "",
        appSettings: Object.entries(a.settings).map(([k, v]) => ({ name: k, value: v })),
      }),
      planBullets: a => [
        `**Web App:** ${a.name}`,
        `**Settings:** ${Object.keys(a.settings).length} key(s)`
      ],
      followup: a => `@platform apply_webapp_settings resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" appServicePlanName "${a.appServicePlanName}" confirm true`,
      successCheck: (j) => !!j
    }),

    // Key Vault
    makeRouterTool({
      name: "platform.create_key_vault",
      description: "Create a Key Vault (RBAC enabled).",
      azureTool: "azure.create_key_vault",
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
      followup: a => `@platform create_key_vault resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" tenantId "${a.tenantId}" confirm true`,
      successCheck: (j) => !!(j && (j.id || j.name)),
      verifyCalls: [{
        name: "azure.get_key_vault",
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
        expect: (vj, a) => !!vj?.name && vj.name === a.name
      }]
    }),

    // Storage
    makeRouterTool({
      name: "platform.create_storage_account",
      description: "Create a Storage Account (StorageV2, HTTPS only).",
      azureTool: "azure.create_storage_account",
      schema: z.object({
        resourceGroupName: z.string(),
        accountName: z.string().regex(/^[a-z0-9]{3,24}$/),
        location: z.string(),
        skuName: z.enum(["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"]).default("Standard_LRS"),
        kind: z.enum(["StorageV2", "BlobStorage", "BlockBlobStorage", "FileStorage", "Storage"]).default("StorageV2"),
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
      followup: a => `@platform create_storage_account resourceGroupName "${a.resourceGroupName}" accountName "${a.accountName}" location "${a.location}" skuName "${a.skuName}" confirm true`,
      successCheck: (j) => !!(j && (j.id || j.name)),
      verifyCalls: [{
        name: "azure.get_storage_account",
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, accountName: a.accountName }),
        expect: (vj, a) => !!vj?.name && vj.name.toLowerCase() === a.accountName.toLowerCase()
      }]
    }),

    // Log Analytics
    makeRouterTool({
      name: "platform.create_log_analytics",
      description: "Create a Log Analytics Workspace.",
      azureTool: "azure.create_log_analytics_workspace",
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
      followup: a => `@platform create_log_analytics resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" confirm true`,
      successCheck: (j) => !!(j && (j.id || j.name)),
      verifyCalls: [{
        name: "azure.get_log_analytics_workspace",
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
        expect: (vj, a) => !!vj?.name && vj.name === a.name
      }]
    }),

    // VNet
    makeRouterTool({
      name: "platform.create_vnet",
      description: "Create a Virtual Network.",
      azureTool: "azure.create_virtual_network",
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
      followup: a => `@platform create_vnet resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" confirm true`,
      successCheck: (j) => !!(j && (j.id || j.name)),
      verifyCalls: [{
        name: "azure.get_virtual_network",
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.name }),
        expect: (vj, a) => !!vj?.name && vj.name === a.name
      }]
    }),

    // Subnet
    makeRouterTool({
      name: "platform.create_subnet",
      description: "Create a subnet in a VNet.",
      azureTool: "azure.create_subnet",
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
      followup: a => `@platform create_subnet resourceGroupName "${a.resourceGroupName}" vnetName "${a.vnetName}" name "${a.name}" addressPrefix "${a.addressPrefix}" confirm true`,
      successCheck: (j) => !!(j && (j.id || j.name)),
      verifyCalls: [{
        name: "azure.get_subnet",
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, vnetName: a.vnetName, name: a.name }),
        expect: (vj, a) => !!vj?.name && vj.name === a.name
      }]
    }),

    // Private Endpoint
    makeRouterTool({
      name: "platform.create_private_endpoint",
      description: "Create a Private Endpoint.",
      azureTool: "azure.create_private_endpoint",
      schema: z.object({
        resourceGroupName: z.string(),
        name: z.string(),
        location: z.string(),
        vnetName: z.string(),
        subnetName: z.string(),
        targetResourceId: z.string(),
        groupIds: z.array(z.string()).optional(),
        privateDnsZoneGroupName: z.string().optional(),
        privateDnsZoneIds: z.array(z.string()).optional(),
        tags: z.any().optional()
      }),
      toPayload: a => ({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        vnetName: a.vnetName,
        subnetName: a.subnetName,
        targetResourceId: a.targetResourceId,
        groupIds: a.groupIds,
        privateDnsZoneGroupName: a.privateDnsZoneGroupName,
        privateDnsZoneIds: a.privateDnsZoneIds,
        tags: coerceTags(a.tags),
      }),
      planBullets: a => [
        `**PE:** ${a.name}`,
        `**Target:** ${a.targetResourceId}`,
        `**Subnet:** ${a.subnetName} on ${a.vnetName}`
      ],
      followup: a => `@platform create_private_endpoint resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" vnetName "${a.vnetName}" subnetName "${a.subnetName}" targetResourceId "${a.targetResourceId}" confirm true`,
      successCheck: (j) => !!(j && (j.id || j.name))
    }),

  ];

  return tools;
}