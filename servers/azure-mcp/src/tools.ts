// servers/azure-mcp/src/tools.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { evaluateGovernance, withGovernanceAll } from "./governance.js";
import { resClient, appClient, kvClient, storageClient, netClient, monitorClient, planId, subnetId, resolveApiVersionById, lawClient, makeCredential } from "./clients.js";

// ---------- mini helpers ----------
const j = (json: any) => [{ type: "json" as const, json }];
const t = (text: string) => [{ type: "text" as const, text }];

const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";
const ARM_ENDPOINT = process.env.ARM_ENDPOINT || "https://management.usgovcloudapi.net";

// ---------- Utility tools you requested ----------
const tool_get_resource_by_id: ToolDef = {
  name: "azure.get_resource_by_id",
  description: "Fetch any Azure resource by its ARM resourceId.",
  inputSchema: z.object({ id: z.string().min(1) }).strict(),
  handler: async (a) => {
    // Uses ARM "resources.getById(id, apiVersion)"
    const apiVersion = await resolveApiVersionById(a.id);
    if (!apiVersion) {
      return { content: [{ type: "text", text: `Could not resolve apiVersion for: ${a.id}` }], isError: true };
    }
    const res = await resClient.resources.getById(a.id, apiVersion);
    return { content: [{ type: "json", json: res }] };
  }
};

const tool_ping: ToolDef = {
  name: "azure.ping",
  description: "Health check",
  inputSchema: z.object({}).strict(),
  handler: async () => ({ content: j({ ok: true }) }),
};

function tierForSku(s: string | undefined) {
  if (!s) return undefined;
  if (/^P\d+v3$/i.test(s)) return "PremiumV3";
  if (/^P\d$/i.test(s)) return "Premium";
  if (/^S\d$/i.test(s)) return "Standard";
  if (/^B\d$/i.test(s)) return "Basic";
  if (/^F\d?$/i.test(s)) return "Free";
  return undefined;
}

function sizeForSku(s: string | undefined) {
  if (!s) return undefined;
  if (/^P\d+v3$/i.test(s)) return "P3";
  if (/^P\d$/i.test(s)) return "P1";
  if (/^S\d$/i.test(s)) return "S1";
  if (/^B\d$/i.test(s)) return "B1";
  if (/^F\d?$/i.test(s)) return "F1";
  return undefined;
}

function familyForSku(s: string | undefined) {
  if (!s) return undefined;
  if (/^P\d+v3$/i.test(s)) return "P";
  if (/^P\d$/i.test(s)) return "P";
  if (/^S\d$/i.test(s)) return "S";
  if (/^B\d$/i.test(s)) return "B";
  if (/^F\d?$/i.test(s)) return "F";
  return undefined;
}

function capacityForSku(s: string | undefined) {
  if (!s) return undefined;
  if (/^P\d+v3$/i.test(s)) return 3;
  if (/^P\d$/i.test(s)) return 1;
  if (/^S\d$/i.test(s)) return 1;
  if (/^B\d$/i.test(s)) return 1;
  if (/^F\d?$/i.test(s)) return 1;
  return undefined;
}

// Derive RG from a resource ID (handy for returns)
function rgFromId(id?: string): string | undefined {
  if (!id) return undefined;
  const m = /\/resourceGroups\/([^\/]+)\//i.exec(id);
  return m?.[1];
}

// Small wrapper to collect async iterators
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

// Handy ARM deployment template for Static Web Apps
function buildSwaArmTemplate() {
  return {
    $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
    contentVersion: "1.0.0.0",
    parameters: {
      name: { type: "string" },
      location: { type: "string" },
      sku: { type: "string", defaultValue: "Free" },
      appLocation: { type: "string", defaultValue: "/" },
      outputLocation: { type: "string", defaultValue: "dist" },
      tags: { type: "object", defaultValue: {} }
    },
    resources: [
      {
        type: "Microsoft.Web/staticSites",
        apiVersion: "2022-03-01",
        name: "[parameters('name')]",
        location: "[parameters('location')]",
        sku: { name: "[parameters('sku')]" },
        tags: "[parameters('tags')]",
        properties: {
          buildProperties: {
            appLocation: "[parameters('appLocation')]",
            outputLocation: "[parameters('outputLocation')]"
          }
        }
      }
    ]
  };
}

// ------------------------- common mini-schemas -------------------------
const tags = z.record(z.string()).optional();

const kvSku = z.enum(["standard", "premium"]).default("standard"); // family "A" when you implement
const kvPna = z.enum(["Enabled", "Disabled"]).default("Enabled");
const kvSoftDelete = z.enum(["Enabled", "Disabled"]).default("Enabled");
const kvRetention = z.enum(["Enabled", "Disabled"]).default("Enabled");
const kvPurge = z.enum(["Enabled", "Disabled"]).default("Enabled");
const kvEnableRbac = z.boolean().default(true);

const storageSku = z.enum(["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"]).default("Standard_LRS");
const storageKind = z.enum(["StorageV2", "BlobStorage", "BlockBlobStorage", "FileStorage", "Storage"]).default("StorageV2");

const ftpsState = z.enum(["AllAllowed", "FtpsOnly", "Disabled"]).optional();
const tlsMin = z.enum(["1.0", "1.1", "1.2"]).optional();

const appServicePlanSku = z.enum(["F1", "B1", "S1", "P1", "P2", "P3"]).default("F1");

const vnetAddr = z.array(z.string()).default(["10.0.0.0/16"]);
const serviceEndpoints = z.array(z.string()).optional();
const delegations = z.array(z.object({ serviceName: z.string() })).optional();

const privateNetPol = z.enum(["Enabled", "Disabled"]).optional();

// ---------- Your existing Azure tools (unchanged) ----------

export const tool_azure_debug_env: ToolDef = {
  name: "azure.debug_env",
  description: "Show Azure MCP cloud config (authority, ARM endpoint, subscription env).",
  inputSchema: z.object({}).strict(),
  handler: async () => ({
    content: [{
      type: "json",
      json: {
        authorityHost: process.env.AZURE_AUTHORITY_HOST,
        armEndpoint: ARM_ENDPOINT,
        armScope: process.env.ARM_SCOPE,
        subscriptionId: process.env.AZURE_SUBSCRIPTION_ID
      }
    }]
  })
};

/* export const tool_azure_list_subscriptions: ToolDef = {
  name: "azure.list_subscriptions",
  description: "List subscriptions visible to these credentials (Gov endpoint).",
  inputSchema: z.object({}).strict(),
  handler: async () => {
    const cred = makeCredential();
    const subClient = new SubscriptionClient(cred, { endpoint: ARM_ENDPOINT } as any);
    const subs = [];
    for await (const s of subClient.subscriptions.list()) subs.push(s);
    return { content: [{ type: "json", json: subs }] };
  }
}; */

const tool_azure_debug_governance_eval: ToolDef = {
  name: "azure.debug_governance_eval",
  description: "Echo the payload used for governance evaluation and the decision.",
  inputSchema: z.object({
    tool: z.string(),
    args: z.any(),
    context: z.any().optional()
  }).strict(),
  handler: async (a: any) => {
    const gov = await evaluateGovernance(a.tool, a.args, a.context);
    return { content: [{ type: "json" as const, json: { tool: a.tool, evaluated: a.args, governance: gov } }] };
  }
};

const tool_create_rg: ToolDef = {
  name: "azure.create_resource_group",
  description: "Create or update a resource group.",
  inputSchema: z.object({
    name: z.string(),
    location: z.string(),
    tags: tags
  }).strict(),
  handler: async (a) => {
    const rg = await resClient.resourceGroups.createOrUpdate(a.name, {
      location: a.location,
      tags: a.tags
    });
    return { content: [{ type: "json", json: rg }] };
  }
};

const tool_create_kv: ToolDef = {
  name: "azure.create_key_vault",
  description: "Create a Key Vault.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    tenantId: z.string(),
    skuName: kvSku,
    enableRbacAuthorization: kvEnableRbac,
    publicNetworkAccess: kvPna,
    tags: tags
  }).strict(),
  handler: async (a) => {
    const skuName = (a.skuName || "standard").toLowerCase() as "standard" | "premium";
    const kv = await kvClient.vaults.beginCreateOrUpdateAndWait(
      a.resourceGroupName, a.name,
      {
        location: a.location,
        sku: { name: skuName, family: "A" },
        properties: {
          tenantId: a.tenantId,
          enableRbacAuthorization: a.enableRbacAuthorization,
          publicNetworkAccess: a.publicNetworkAccess
        },
        tags: a.tags
      } as any
    );
    return { content: [{ type: "json", json: kv }] };
  }
};

const tool_create_storage_account: ToolDef = {
  name: "azure.create_storage_account",
  description: "Create a Storage Account.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    skuName: storageSku,
    kind: storageKind,
    tags: tags
  }).strict(),
  handler: async (a) => {
    // a: { resourceGroupName, accountName, location, skuName, kind, enableHttpsTrafficOnly? }
    const resp = await storageClient.storageAccounts.beginCreateAndWait(
      a.resourceGroupName,
      a.name,
      {
        location: a.location,
        sku: { name: a.skuName },            // e.g., "Standard_LRS"
        kind: a.kind || "StorageV2",
        tags: a.tags,
        enableHttpsTrafficOnly: a.enableHttpsTrafficOnly ?? true
      } as any
    );
    return { content: [{ type: "json", json: resp }] };
  }
};

const tool_list_storage_accounts: ToolDef = {
  name: "azure.list_storage_accounts",
  description: "List all Storage Accounts.",
  inputSchema: z.object({
    resourceGroupName: z.string().optional()
  }).strict(),
  handler: async (a) => {
    if (a.resourceGroupName) {
      const iter = storageClient.storageAccounts.listByResourceGroup(a.resourceGroupName);
      const rows = [];
      for await (const s of iter) rows.push(s);
      return { content: [{ type: "json", json: rows }] };
    } else {
      const iter = storageClient.storageAccounts.list();
      const rows = [];
      for await (const s of iter) rows.push(s);
      return { content: [{ type: "json", json: rows }] };
    }
  }
};

const tool_create_app_service_plan: ToolDef = {
  name: "azure.create_app_service_plan",
  description: "Create an App Service Plan.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    sku: z.string(),
    tags: tags
  }).strict(),
  handler: async (a) => {
    const plan = await appClient.appServicePlans.beginCreateOrUpdateAndWait(
      a.resourceGroupName, a.name,
      {
        location: a.location,
        sku: { name: a.sku, tier: tierForSku(a.sku), size: sizeForSku(a.sku), family: familyForSku(a.sku), capacity: capacityForSku(a.sku) }
      }
    );
    return { content: [{ type: "json", json: plan }] };
  }
};

// List App Service Plans
const tool_list_app_service_plans: ToolDef = {
  name: "azure.list_app_service_plans",
  description: "List all App Service Plans.",
  inputSchema: z.object({
    resourceGroupName: z.string().optional()
  }).strict(),
  handler: async (a) => {
    if (a.resourceGroupName) {
      const iter = appClient.appServicePlans.listByResourceGroup(a.resourceGroupName);
      const rows = [];
      for await (const s of iter) rows.push(s);
      return { content: [{ type: "json", json: rows }] };
    } else {
      const iter = appClient.appServicePlans.list();
      const rows = [];
      for await (const s of iter) rows.push(s);
      return { content: [{ type: "json", json: rows }] };
    }
  }
};

const tool_create_web_app: ToolDef = {
  name: "azure.create_web_app",
  description: "Create a Web App.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    serverFarmId: z.string(),
    appServicePlanName: z.string(),
    httpsOnly: z.boolean().optional(),
    siteConfig: z.object({
      linuxFxVersion: z.string().optional(),          // e.g. "NODE|20-lts"
      netFrameworkVersion: z.string().optional(),     // e.g. "v4.8"
      minimumTlsVersion: z.string().optional(),
      ftpsState: z.string().optional(),
      appSettings: z.array(z.object({
        name: z.string().optional(),
        value: z.string().optional()
      })).optional(),
      http20Enabled: z.boolean().optional(),
      connectionStrings: z.array(z.object({
        name: z.string().optional(),
        connectionString: z.string().optional(),
        type: z.string().optional()
      })).optional()
    }),
    tags: tags
  }).strict(),
  handler: async (a) => {
    const serverFarmId = planId(a.resourceGroupName, a.appServicePlanName);
    const web = await appClient.webApps.beginCreateOrUpdateAndWait(
      a.resourceGroupName, a.name,
      {   
        location: a.location,
        serverFarmId: serverFarmId,
        httpsOnly: a.httpsOnly,
        siteConfig: {
          linuxFxVersion: a.linuxFxVersion,              // e.g. "NODE|20-lts"
          netFrameworkVersion: a.netFrameworkVersion,     // e.g. "v4.8"
          minimumTlsVersion: a.minimumTlsVersion,
          ftpsState: a.ftpsState,
          connectionStrings: a.connectionStrings,
          appSettings: a.appSettings,
          http20Enabled: a.http20Enabled
        },
        
        tags: a.tags
      } as any
    );
    return { content: [{ type: "json", json: web }] };
  }
};

// List Web Apps
const tool_list_web_apps: ToolDef = {
  name: "azure.list_web_apps",
  description: "List all Web Apps.",
  inputSchema: z.object({
    resourceGroupName: z.string().optional()
  }).strict(),
  handler: async (a) => {
    if (a.resourceGroupName) {
      const iter = appClient.webApps.listByResourceGroup(a.resourceGroupName);
      const rows = [];
      for await (const s of iter) rows.push(s);
      return { content: [{ type: "json", json: rows }] };
    } else {
      const iter = appClient.webApps.list();
      const rows = [];
      for await (const s of iter) rows.push(s);
      return { content: [{ type: "json", json: rows }] };
    }
  }
};

const tool_list_resources_by_type: ToolDef = {
  name: "azure.list_resources_by_type",
  description: "List all resources of a specific type.",
  inputSchema: z.object({
    resourceGroupName: z.string().optional(),
    resourceType: z.string()
  }).strict(),
  handler: async (a) => {
    if (a.resourceGroupName) {
      const iter = resClient.resources.listByResourceGroup(a.resourceGroupName, { filter: `resourceType eq '${a.resourceType}'` });
      const rows = [];
      for await (const s of iter) rows.push(s);
      return { content: [{ type: "json", json: rows }] };
    } else {
      const iter = resClient.resources.list({ filter: `resourceType eq '${a.resourceType}'` });
      const rows = [];
      for await (const s of iter) rows.push(s);
      return { content: [{ type: "json", json: rows }] };
    }
  }
};

const tool_enable_system_assigned_identity: ToolDef = {
  name: "azure.enable_system_assigned_identity",
  description: "Enable System Assigned Identity for a Web App.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string()
  }).strict(),
  handler: async (a) => {
    const web = await appClient.webApps.beginCreateOrUpdateAndWait(
      a.resourceGroupName, a.name,
      {
        identity: {
          type: "SystemAssigned"
        },
        location: a.location
      }
    );
    return { content: [{ type: "json", json: web }] };
  }
};

const tool_apply_app_settings: ToolDef = {
  name: "azure.apply_app_settings",
  description: "Apply App Settings to a Web App.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    appServicePlanName: z.string(),
    serverFarmId: z.string(),
    appSettings: z.array(z.object({
      name: z.string(),
      value: z.string()
    }))
  }).strict(),
  handler: async (a) => {
    const serverFarmId = planId(a.resourceGroupName, a.appServicePlanName);
    const web = await appClient.webApps.beginCreateOrUpdateAndWait(
      a.resourceGroupName, a.name,
      {
        serverFarmId: serverFarmId,
        location: a.location,
        siteConfig: {
          appSettings: a.appSettings
        }
      }
    );
    return { content: [{ type: "json", json: web }] };
  }
};

const tool_create_static_web_app: ToolDef = {
  name: "azure.create_static_web_app",
  description: "Create a Static Web App.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    serverFarmId: z.string(),
    skuName: z.string(),
    appLocation: z.string(),
    outputLocation: z.string(),
    siteConfig: z.object({
      appSettings: z.array(z.object({
        name: z.string(),
        value: z.string()
      })),
      connectionStrings: z.array(z.object({
        name: z.string(),
        connectionString: z.string(),
        type: z.string()
      }))
    }),
    tags: tags
  }).strict(),
  handler: async (a) => {
    // a: { resourceGroupName, name, location, skuName?, appLocation?, outputLocation?, tags? }
    const template = buildSwaArmTemplate();
    const deploymentName = `swa-${a.name}-${Date.now()}`;

    const result = await resClient.deployments.beginCreateOrUpdateAndWait(
      a.resourceGroupName,
      deploymentName,
      {
        properties: {
          mode: "Incremental",
          template,
          parameters: {
            name: { value: a.name },
            location: { value: a.location },
            sku: { value: a.skuName || "Free" },
            serverFarmId: { value: a.serverFarmId },
            appLocation: { value: a.appLocation ?? "/" },
            outputLocation: { value: a.outputLocation ?? "dist" },
            siteConfig: { value: a.siteConfig ?? {} },
            tags: { value: a.tags ?? {} }
          }
        }
      } as any
    );

    return { content: [{ type: "json", json: result }] };
  }
};

const tool_get_static_web_app_secrets: ToolDef = {
  name: "azure.get_static_web_app_secrets",
  description: "Get the secrets for a Static Web App.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string()
  }).strict(),
  handler: async (a) => {
    // Returns object with e.g. { properties: { apiKey, githubActionSecretName } }
    // az equivalent: az staticwebapp secrets list -g <rg> -n <name>
    try {
      const secrets = await appClient.staticSites.listStaticSiteSecrets(a.resourceGroupName, a.name);
      return { content: [{ type: "json", json: secrets }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: `Failed to fetch SWA secrets: ${e?.message || e}` }], isError: true };
    }
  }
};

const tool_create_virtual_network: ToolDef = {
  name: "azure.create_virtual_network",
  description: "Create a Virtual Network.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    addressPrefix: vnetAddr,
    tags: tags
  }).strict(),
  handler: async (a) => {
    const vnet = await netClient.virtualNetworks.beginCreateOrUpdateAndWait(
      a.resourceGroupName, a.name,
      {
        location: a.location,
        addressSpace: { addressPrefixes: a.addressPrefixes },
        dhcpOptions: a.dnsServers ? { dnsServers: a.dnsServers } : undefined,
        tags: a.tags
      }
    );
    return { content: [{ type: "json", json: vnet }] };
  }
};

// List VNets (subscription or RG)
export const tool_list_virtual_networks = {
  name: "azure.list_virtual_networks",
  description: "List Virtual Networks (optionally filter by resource group).",
  inputSchema: z.object({
    resourceGroupName: z.string().optional(),
  }).strict(),
  handler: async (a: { resourceGroupName?: string }) => {
    const rows = a.resourceGroupName
      ? await collect(netClient.virtualNetworks.list(a.resourceGroupName))
      : await collect(netClient.virtualNetworks.listAll());
    // add resourceGroup for convenience
    const withRg = rows.map(v => ({ ...v, resourceGroup: v.id ? rgFromId(v.id) : undefined }));
    return { content: [{ type: "json" as const, json: withRg }] };
  }
};


const tool_create_subnet: ToolDef = {
  name: "azure.create_subnet",
  description: "Create a Subnet.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    virtualNetworkName: z.string(),
    name: z.string(),
    addressPrefix: z.string(),
    tags: tags
  }).strict(),
  handler: async (a) => {
    const subnet = await netClient.subnets.beginCreateOrUpdateAndWait(
      a.resourceGroupName, a.virtualNetworkName, a.name,
      {
        addressPrefix: a.addressPrefix,
        serviceEndpoints: a.serviceEndpoints?.map((s: any) => ({ service: s })),
        delegations: a.delegations?.map((d: any) => ({ serviceName: d.serviceName })),
        privateEndpointNetworkPolicies: a.privateEndpointNetworkPolicies
      } as any
    );
    return { content: [{ type: "json", json: subnet }] };
  }
};

export const tool_list_subnets = {
  name: "azure.list_subnets",
  description: "List Subnets in a specific VNet.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    vnetName: z.string(),
  }).strict(),
  handler: async (a: { resourceGroupName: string; vnetName: string }) => {
    const rows = await collect(netClient.subnets.list(a.resourceGroupName, a.vnetName));
    const withCtx = rows.map(s => ({ ...s, resourceGroup: a.resourceGroupName, virtualNetwork: a.vnetName }));
    return { content: [{ type: "json" as const, json: withCtx }] };
  }
};

const tool_create_private_endpoint: ToolDef = {
  name: "azure.create_private_endpoint",
  description: "Create a Private Endpoint.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    subnetId: z.string(),
    privateLinkServiceId: z.string(),
    tags: tags
  }).strict(),
  handler: async (a) => {
    const sId = subnetId(a.resourceGroupName, a.vnetName, a.subnetName);
    const pe = await netClient.privateEndpoints.beginCreateOrUpdateAndWait(
      a.resourceGroupName, a.name,
      {
        location: a.location,
        subnet: { id: sId },
        privateLinkServiceConnections: [{
          name: "plink",
          privateLinkServiceId: a.targetResourceId,
          groupIds: a.groupIds || []
        }],
        tags: a.tags
      } as any
    );
    return { content: [{ type: "json", json: pe }] };
  }
};

// List Private Endpoints (subscription or RG)
export const tool_list_private_endpoints = {
  name: "azure.list_private_endpoints",
  description: "List Private Endpoints (optionally filter by resource group).",
  inputSchema: z.object({
    resourceGroupName: z.string().optional(),
  }).strict(),
  handler: async (a: { resourceGroupName?: string }) => {
    const rows = a.resourceGroupName
      ? await collect(netClient.privateEndpoints.list(a.resourceGroupName))
      : await collect(netClient.privateEndpoints.listBySubscription());
    const withRg = rows.map(pe => ({ ...pe, resourceGroup: pe.id ? rgFromId(pe.id) : undefined }));
    return { content: [{ type: "json" as const, json: withRg }] };
  }
};

const tool_create_network_security_groups: ToolDef = {
  name: "azure.create_network_security_group",
  description: "Create a Network Security Group.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    location: z.string(),
    name: z.string(),
    tags: tags
  }).strict(),
  handler: async (a) => {
    const nsg = await netClient.networkSecurityGroups.beginCreateOrUpdateAndWait(
      a.resourceGroupName,
      a.name,
      {
        location: a.location,
        tags: a.tags
      }
    );
    return { content: [{ type: "json", json: nsg }] };
  }
};

export const tool_list_network_security_groups = {
  name: "azure.list_network_security_groups",
  description: "List Network Security Groups (optionally filter by resource group).",
  inputSchema: z.object({
    resourceGroupName: z.string().optional(),
  }).strict(),
  handler: async (a: { resourceGroupName?: string }) => {
    const rows = a.resourceGroupName
      ? await collect(netClient.networkSecurityGroups.list(a.resourceGroupName))
      : await collect(netClient.networkSecurityGroups.listAll());
    const withRg = rows.map(n => ({ ...n, resourceGroup: n.id ? rgFromId(n.id) : undefined }));
    return { content: [{ type: "json" as const, json: withRg }] };
  }
};

const tool_create_public_ip_addresses: ToolDef = {
  name: "azure.create_public_ip_address",
  description: "Create a Public IP Address.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    location: z.string(),
    name: z.string(),
    sku: z.string(),
    tags: tags
  }).strict(),
  handler: async (a) => {
    const publicIp = await netClient.publicIPAddresses.beginCreateOrUpdateAndWait(
      a.resourceGroupName,
      a.name,
      {
        location: a.location,
        sku: { name: a.sku },
        tags: a.tags
      }
    );
    return { content: [{ type: "json", json: publicIp }] };
  }
};

// List Public IPs (subscription or RG)
export const tool_list_public_ip_addresses = {
  name: "azure.list_public_ip_addresses",
  description: "List Public IP Addresses (optionally filter by resource group).",
  inputSchema: z.object({
    resourceGroupName: z.string().optional(),
  }).strict(),
  handler: async (a: { resourceGroupName?: string }) => {
    const rows = a.resourceGroupName
      ? await collect(netClient.publicIPAddresses.list(a.resourceGroupName))
      : await collect(netClient.publicIPAddresses.listAll());
    const withRg = rows.map(p => ({ ...p, resourceGroup: p.id ? rgFromId(p.id) : undefined }));
    return { content: [{ type: "json" as const, json: withRg }] };
  }
};

const tool_create_log_analytics_workspace: ToolDef = {
  name: "azure.create_log_analytics_workspace",
  description: "Create a Log Analytics Workspace.",
  inputSchema: z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    sku: z.string(),
    tags: tags
  }).strict(),
  handler: async (a) => {
    const workspace = await lawClient.workspaces.beginCreateOrUpdateAndWait(
      a.resourceGroupName,
      a.name,
      {
        location: a.location,
        sku: { name: a.sku },
        tags: a.tags
      }
    );
    return { content: [{ type: "json", json: workspace }] };
  }
};

const tool_list_log_analytics_workspaces: ToolDef = {
  name: "azure.list_log_analytics_workspaces",
  description: "List all Log Analytics Workspaces.",
  inputSchema: z.object({
    resourceGroupName: z.string().optional()
  }).strict(),
  handler: async (a) => {
    if (a.resourceGroupName) {
      const iter = lawClient.workspaces.listByResourceGroup(a.resourceGroupName);
      const rows = [];
      for await (const w of iter) rows.push(w);
      return { content: [{ type: "json", json: rows }] };
    } else {
      const iter = lawClient.workspaces.list();
      const rows = [];
      for await (const w of iter) rows.push(w);
      return { content: [{ type: "json", json: rows }] };
    }
  }
};

// ---------- Wrap EVERYTHING with governance ----------
const rawTools: ToolDef[] = [
  tool_ping,
  tool_azure_debug_env,
  tool_azure_debug_governance_eval,
  tool_get_resource_by_id,
  tool_create_rg,
  tool_create_kv,
  tool_create_storage_account,
  tool_list_storage_accounts,
  tool_create_app_service_plan,
  tool_list_app_service_plans,
  tool_create_web_app,
  tool_list_web_apps,
  tool_list_resources_by_type,
  tool_enable_system_assigned_identity,
  tool_apply_app_settings,
  tool_create_static_web_app,
  tool_get_static_web_app_secrets,
  tool_create_virtual_network,
  tool_list_virtual_networks,
  tool_create_subnet,
  tool_list_subnets,
  tool_create_network_security_groups,
  tool_list_network_security_groups,
  tool_create_public_ip_addresses,
  tool_list_public_ip_addresses,
  tool_create_private_endpoint,
  tool_list_private_endpoints,
  tool_create_log_analytics_workspace,
  tool_list_log_analytics_workspaces,
  // ...add ALL your other existing Azure tools here (unchanged)...
];

// Governance is applied here, centrally:
export const tools: ToolDef[] = withGovernanceAll(rawTools);