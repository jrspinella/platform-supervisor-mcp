import { z } from "zod";
import type { MakeAzureToolsOptions } from "./types.js";
import type { ToolDef } from "mcp-http";
import { makeAzureScanTools } from "./tools/tools.scan.js";
import { makeAzureRemediationTools } from "./tools/tools.remediation.js";
import { coerceTags, harvestTagsFromArgs, normalizeAzureError, normalizeTags, presentAksCluster, presentAppServicePlan, presentKeyVault, presentLogAnalyticsWorkspace, presentPrivateEndpoint, presentResourceGroup, presentStorageAccount, presentSubnet, presentVirtualNetwork, presentWebApp, withGovernanceAll, wrapCreate, wrapGet } from "./utils.js";
import { evaluate } from "@platform/governance-core";

export function makeAzureTools(opts: MakeAzureToolsOptions) {
  const { clients, evaluateGovernance, namespace = "azure." } = opts;
  const n = (s: string) => `${namespace}${s}`;

  // ──────────────────────────────────────────────────────────────
  // Resource Groups
  // ──────────────────────────────────────────────────────────────
  const create_rg = wrapCreate(
    n("create_resource_group"),
    "Create (or update) an Azure Resource Group.",
    z.object({ name: z.string(), location: z.string(), tags: z.any().optional() }).strict(),
    async (a) => {
      try {
        const tags = coerceTags(a.tags);
        return clients.resourceGroups.create(a.name, a.location, tags);
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    },
    { present: (out: any) => presentResourceGroup(out) }
  );

  const get_rg = wrapGet(
    n("get_resource_group"),
    "Get a Resource Group by name.",
    z.object({ name: z.string() }).strict(),
    async (a: any) => {
      try {
        return await clients.resourceGroups.get(a.name);
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    },
    { present: (out: any) => presentResourceGroup(out) }
  );

  // ──────────────────────────────────────────────────────────────
  // App Service Plan
  // ──────────────────────────────────────────────────────────────
  const create_plan = wrapCreate(
    n("create_app_service_plan"),
    "Create an App Service Plan.",
    z
      .object({
        resourceGroupName: z.string(),
        name: z.string(),
        location: z.string(),
        sku: z.union([z.string(), z.record(z.any())]).default("P1v3"),
        tags: z.any().optional(),
      })
      .strict(),
    async (a) => {
      try {
        const tags = coerceTags(a.tags);
        return clients.appServicePlans.create(a.resourceGroupName, a.name, a.location, a.sku, tags);
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    },
    { present: (out) => presentAppServicePlan(out) }
  );

  const get_plan = wrapGet(
    n("get_app_service_plan"),
    "Get an App Service Plan.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a: any) => {
      try {
        return await clients.appServicePlans.get(a.resourceGroupName, a.name);
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    },
    { present: (out) => presentAppServicePlan(out) }
  );

  // ──────────────────────────────────────────────────────────────
  // Web Apps
  // ──────────────────────────────────────────────────────────────
  const create_web = wrapCreate(
    n("create_web_app"),
    "Create a Web App (Linux) on an App Service Plan.",
    z
      .object({
        resourceGroupName: z.string(),
        name: z.string(),
        location: z.string(),
        appServicePlanName: z.string(),
        httpsOnly: z.boolean().optional().default(true),
        linuxFxVersion: z.string().optional(),
        runtimeStack: z.string().optional(),
        minimumTlsVersion: z.union([z.literal("1.0"), z.literal("1.1"), z.literal("1.2"), z.literal("1.3")]).optional().default("1.2"),
        ftpsState: z.enum(["AllAllowed", "FtpsOnly", "Disabled"]).optional().default("Disabled"),
        tags: z.any().optional(),
      })
      .strict(),
    async (a: { tags: any; resourceGroupName: string; name: string; location: string; appServicePlanName: string; httpsOnly: boolean; linuxFxVersion: string; minimumTlsVersion: string; ftpsState: string; runtimeStack: string; }) => {
      try {
        const linuxFx = a.linuxFxVersion ?? a.runtimeStack;
        const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
        const out = await clients.webApps.create({
          resourceGroupName: a.resourceGroupName,
          name: a.name,
          location: a.location,
          appServicePlanName: a.appServicePlanName,
          httpsOnly: a.httpsOnly,
          linuxFxVersion: linuxFx,
          minimumTlsVersion: a.minimumTlsVersion,
          ftpsState: a.ftpsState,
          tags,
        });
        return out;
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    },
    { present: (out) => presentWebApp(out) }
  );

  const get_web = {
    name: n("get_web_app"),
    description: "Get a Web App.",
    inputSchema: z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    handler: async (a: any) => {
      try {
        const out = await clients.webApps.get(a.resourceGroupName, a.name);
        return { content: presentWebApp(out) };
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    },
  } satisfies ToolDef;

  const enable_msi = wrapCreate(
    n("enable_system_assigned_identity"),
    "Enable system-assigned identity for a Web App.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a: { resourceGroupName: any; name: any; }) => clients.webApps.enableSystemAssignedIdentity(a.resourceGroupName, a.name)
  );

  const apply_settings = wrapCreate(
    n("apply_app_settings"),
    "Merge/apply app settings (key/value) on a Web App.",
    z
      .object({ resourceGroupName: z.string(), name: z.string(), appSettings: z.array(z.object({ name: z.string(), value: z.string() })).min(1) })
      .strict(),
    async (a: { resourceGroupName: any; name: any; appSettings: any; }) => clients.webApps.setAppSettings(a.resourceGroupName, a.name, a.appSettings)
  );

  // ──────────────────────────────────────────────────────────────
  // Key Vault
  // ──────────────────────────────────────────────────────────────
  const create_kv = wrapCreate(
    n("create_key_vault"),
    "Create Key Vault (RBAC recommended).",
    z
      .object({
        resourceGroupName: z.string(),
        name: z.string(),
        location: z.string(),
        tenantId: z.string(),
        skuName: z.enum(["standard", "premium"]).default("standard"),
        enableRbacAuthorization: z.boolean().optional().default(true),
        publicNetworkAccess: z.enum(["Enabled", "Disabled"]).optional().default("Enabled"),
        tags: z.any().optional(),
      })
      .strict(),
    async (a: { tags: any; resourceGroupName: string; name: string; location: string; tenantId: string; skuName: string; enableRbacAuthorization: boolean; publicNetworkAccess: string; }) => {
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.keyVaults.create({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        tenantId: a.tenantId,
        skuName: a.skuName,
        enableRbacAuthorization: a.enableRbacAuthorization,
        publicNetworkAccess: a.publicNetworkAccess,
        tags,
      });
    },
    { present: (out: any) => presentKeyVault(out) }
  );

  const get_kv = wrapGet(
    n("get_key_vault"),
    "Get Key Vault.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a: { resourceGroupName: any; name: any; }) => clients.keyVaults.get(a.resourceGroupName, a.name),
    { present: (out: any) => presentKeyVault(out) }
  );

  // ──────────────────────────────────────────────────────────────
  // Storage
  // ──────────────────────────────────────────────────────────────
  const create_sa = wrapCreate(
    n("create_storage_account"),
    "Create a Storage Account (StorageV2, HTTPS only recommended).",
    z
      .object({
        resourceGroupName: z.string(),
        name: z.string().regex(/^[a-z0-9]{3,24}$/),
        location: z.string(),
        skuName: z.enum(["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"]).default("Standard_LRS"),
        kind: z.enum(["StorageV2", "BlobStorage", "BlockBlobStorage", "FileStorage", "Storage"]).default("StorageV2"),
        enableHttpsTrafficOnly: z.boolean().optional().default(true),
        tags: z.any().optional(),
      })
      .strict(),
    async (a: { tags: any; resourceGroupName: string; name: string; location: string; skuName: string; kind: string; enableHttpsTrafficOnly: boolean; }) => {
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.storageAccounts.create({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        skuName: a.skuName,
        kind: a.kind,
        enableHttpsTrafficOnly: a.enableHttpsTrafficOnly,
        tags,
      });
    },
    { present: (out: any) => presentStorageAccount(out) }
  );

  const get_sa = wrapGet(
    n("get_storage_account"),
    "Get a Storage Account.",
    z.object({ resourceGroupName: z.string(), accountName: z.string() }).strict(),
    async (a: { resourceGroupName: any; accountName: any; }) => clients.storageAccounts.get(a.resourceGroupName, a.accountName),
    { present: (out: any) => presentStorageAccount(out) }
  );

  // ──────────────────────────────────────────────────────────────
  // Log Analytics
  // ──────────────────────────────────────────────────────────────
  const create_law = wrapCreate(
    n("create_log_analytics_workspace"),
    "Create a Log Analytics Workspace.",
    z
      .object({
        resourceGroupName: z.string(),
        name: z.string(),
        location: z.string(),
        sku: z.string().optional().default("PerGB2018"),
        retentionInDays: z.number().int().min(7).max(730).optional(),
        tags: z.any().optional(),
      })
      .strict(),
    async (a: { tags: any; resourceGroupName: string; name: string; location: string; sku: string; retentionInDays: number; }) => {
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.logAnalytics.create({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        sku: a.sku,
        retentionInDays: a.retentionInDays,
        tags,
      });
    }
  );

  const get_law = wrapGet(
    n("get_log_analytics_workspace"),
    "Get a Log Analytics Workspace.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a: { resourceGroupName: any; name: any; }) => clients.logAnalytics.get(a.resourceGroupName, a.name)
  );

  // ──────────────────────────────────────────────────────────────
  // Networking
  // ──────────────────────────────────────────────────────────────
  const create_vnet = wrapCreate(
    n("create_virtual_network"),
    "Create a Virtual Network.",
    z
      .object({ resourceGroupName: z.string(), name: z.string(), location: z.string(), addressPrefixes: z.array(z.string()).nonempty(), dnsServers: z.array(z.string()).optional(), tags: z.any().optional() })
      .strict(),
    async (a: { tags: any; resourceGroupName: string; name: string; location: string; addressPrefixes: string[]; dnsServers: string[]; }) => {
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.networks.createVnet({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        addressPrefixes: a.addressPrefixes,
        dnsServers: a.dnsServers,
        tags,
      });
    }
  );

  const get_vnet = wrapGet(
    n("get_virtual_network"),
    "Get a Virtual Network.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a: { resourceGroupName: any; name: any; }) => clients.networks.getVnet(a.resourceGroupName, a.name)
  );

  const create_subnet = wrapCreate(
    n("create_subnet"),
    "Create a Subnet in a VNet.",
    z
      .object({
        resourceGroupName: z.string(),
        virtualNetworkName: z.string(),
        name: z.string(),
        addressPrefix: z.string(),
        serviceEndpoints: z.array(z.string()).optional(),
        delegations: z.array(z.object({ serviceName: z.string() })).optional(),
        privateEndpointNetworkPolicies: z.enum(["Enabled", "Disabled"]).optional(),
        tags: z.any().optional(),
      })
      .strict(),
    async (a: { tags: any; resourceGroupName: string; virtualNetworkName: string; name: string; addressPrefix: string; serviceEndpoints: string[]; delegations: any[]; privateEndpointNetworkPolicies: any; }) => {
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.networks.createSubnet({
        resourceGroupName: a.resourceGroupName,
        virtualNetworkName: a.virtualNetworkName,
        name: a.name,
        addressPrefix: a.addressPrefix,
        serviceEndpoints: a.serviceEndpoints,
        delegations: a.delegations,
        privateEndpointNetworkPolicies: a.privateEndpointNetworkPolicies,
        tags,
      });
    }
  );

  const get_subnet = wrapGet(
    n("get_subnet"),
    "Get a Subnet.",
    z.object({ resourceGroupName: z.string(), virtualNetworkName: z.string(), name: z.string() }).strict(),
    async (a: { resourceGroupName: any; virtualNetworkName: any; name: any; }) => clients.networks.getSubnet(a.resourceGroupName, a.virtualNetworkName, a.name)
  );

  const create_pe = wrapCreate(
    n("create_private_endpoint"),
    "Create a Private Endpoint.",
    z
      .object({
        resourceGroupName: z.string(),
        name: z.string(),
        location: z.string(),
        vnetName: z.string(),
        subnetName: z.string(),
        targetResourceId: z.string(),
        groupIds: z.array(z.string()).optional(),
        privateDnsZoneGroupName: z.string().optional(),
        privateDnsZoneIds: z.array(z.string()).optional(),
        tags: z.any().optional(),
      })
      .strict(),
    async (a: { tags: any; resourceGroupName: string; name: string; location: string; vnetName: string; subnetName: string; targetResourceId: string; groupIds: string[]; privateDnsZoneGroupName: string; privateDnsZoneIds: string[]; }) => {
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.networks.createPrivateEndpoint({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        vnetName: a.vnetName,
        subnetName: a.subnetName,
        targetResourceId: a.targetResourceId,
        groupIds: a.groupIds,
        privateDnsZoneGroupName: a.privateDnsZoneGroupName,
        privateDnsZoneIds: a.privateDnsZoneIds,
        tags,
      });
    }
  );

  const get_pe = wrapGet(
    n("get_private_endpoint"),
    "Get a Private Endpoint.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a: { resourceGroupName: any; name: any; }) => clients.networks.getPrivateEndpoint(a.resourceGroupName, a.name)
  );

  // ──────────────────────────────────────────────────────────────
  // AKS (optional)
  // ──────────────────────────────────────────────────────────────
  const create_aks = wrapCreate(
    n("create_aks_cluster"),
    "Create an AKS cluster.",
    z
      .object({
        resourceGroupName: z.string(),
        name: z.string(),
        location: z.string(),
        kubernetesVersion: z.string().optional(),
        agentPoolProfiles: z
          .array(z.object({ name: z.string(), count: z.number().int().min(1), vmSize: z.string(), mode: z.enum(["System", "User"]).optional().default("System") }))
          .nonempty(),
        apiServerAccessProfile: z.object({ enablePrivateCluster: z.boolean().optional() }).optional(),
        tags: z.any().optional(),
      })
      .strict(),
    async (a: { tags: any; resourceGroupName: string; name: string; location: string; kubernetesVersion: string; agentPoolProfiles: any[]; apiServerAccessProfile: any; }) => {
      if (!clients.aks?.createCluster) throw new Error("AKS client not configured");
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.aks.createCluster({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        kubernetesVersion: a.kubernetesVersion,
        agentPoolProfiles: a.agentPoolProfiles as any,
        apiServerAccessProfile: a.apiServerAccessProfile,
        tags,
      });
    }
  );

  const enable_aks_monitoring = wrapCreate(
    n("enable_aks_monitoring"),
    "Enable Container Insights for an AKS cluster (LAW link).",
    z.object({ resourceGroupName: z.string(), clusterName: z.string(), workspaceResourceGroup: z.string(), workspaceName: z.string() }).strict(),
    async (a: { resourceGroupName: any; clusterName: any; workspaceResourceGroup: any; workspaceName: any; }) => {
      if (!clients.aks?.enableMonitoring) throw new Error("AKS monitoring not configured");
      return clients.aks.enableMonitoring(a);
    }
  );

  const get_aks = wrapGet(
    n("get_aks_cluster"),
    "Get an AKS cluster.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a: { resourceGroupName: any; name: any; }) => {
      if (!clients.aks?.get) throw new Error("AKS client not configured");
      return clients.aks.get(a.resourceGroupName, a.name);
    }
  );

  // ──────────────────────────────────────────────────────────────
  // Scans (ATO-enriched)
  // ──────────────────────────────────────────────────────────────
  const scans = makeAzureScanTools(opts);
  const remediations = makeAzureRemediationTools(opts);

  const all: ToolDef[] = [
    // RG
    create_rg,
    get_rg,

    // Plan
    create_plan,
    get_plan,

    // Web
    create_web,
    get_web,
    enable_msi,
    apply_settings,

    // KV
    create_kv,
    get_kv,

    // Storage
    create_sa,
    get_sa,

    // LAW
    create_law,
    get_law,

    // Net
    create_vnet,
    get_vnet,
    create_subnet,
    get_subnet,
    create_pe,
    get_pe,

    // AKS
    create_aks,
    enable_aks_monitoring,
    get_aks,

    // Scans
    ...scans,

    // Remediations
    ...remediations,
  ];

  return withGovernanceAll(all, evaluate);
}
