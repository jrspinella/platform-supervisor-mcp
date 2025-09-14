// packages/azure-core/src/tools.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import type { MakeAzureToolsOptions } from "./types.js";

import { makeAzureScanTools } from "./tools/tools.scan.js";
import { makeAzureRemediationTools } from "./tools/tools.remediation.js";

// keep governance-aware wrappers + tag helpers from utils
import {
  coerceTags,
  harvestTagsFromArgs,
  normalizeTags,
  withGovernanceAll,
  wrapCreate,
  wrapGet,
} from "./utils.js";

// ✅ presenters now come from presenters/
import {
  presentResourceGroup,
  presentAppServicePlan,
  presentWebApp,
  presentKeyVault,
  presentStorageAccount,
  presentLogAnalyticsWorkspace,
  presentVirtualNetwork,
  presentSubnet,
  presentPrivateEndpoint,
  presentAksCluster,
} from "./presenters/presenters.azure.js";

// (optional) fallback if caller doesn’t supply an evaluator
import { evaluate as defaultEvaluate } from "@platform/governance-core";

export function makeAzureTools(opts: MakeAzureToolsOptions) {
  const { clients, evaluateGovernance, namespace = "azure." } = opts;
  const n = (s: string) => `${namespace}${s}`;
  const evalGov = evaluateGovernance ?? defaultEvaluate;

  // ──────────────────────────────────────────────────────────────
  // Resource Groups
  // ──────────────────────────────────────────────────────────────
  const create_rg = wrapCreate(
    n("create_resource_group"),
    "Create (or update) an Azure Resource Group.",
    z.object({ name: z.string(), location: z.string(), tags: z.any().optional() }).strict(),
    async (a) => {
      const tags = coerceTags(a.tags);
      return clients.resourceGroups.create(a.name, a.location, tags);
    },
    { present: (out) => presentResourceGroup(out), evaluateGovernance: evalGov },
  );

  const get_rg = wrapGet(
    n("get_resource_group"),
    "Get a Resource Group by name.",
    z.object({ name: z.string() }).strict(),
    async (a) => clients.resourceGroups.get(a.name),
    { present: (out) => presentResourceGroup(out), evaluateGovernance: evalGov },
  );

  // ──────────────────────────────────────────────────────────────
  // App Service Plan
  // ──────────────────────────────────────────────────────────────
  const create_plan = wrapCreate(
    n("create_app_service_plan"),
    "Create an App Service Plan.",
    z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      sku: z.union([z.string(), z.record(z.any())]).default("P1v3"),
      tags: z.any().optional(),
    }).strict(),
    async (a) => {
      const tags = coerceTags(a.tags);
      return clients.appServicePlans.create(a.resourceGroupName, a.name, a.location, a.sku, tags);
    },
    { present: (out) => presentAppServicePlan(out), evaluateGovernance: evalGov },
  );

  const get_plan = wrapGet(
    n("get_app_service_plan"),
    "Get an App Service Plan.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a) => clients.appServicePlans.get(a.resourceGroupName, a.name),
    { present: (out) => presentAppServicePlan(out), evaluateGovernance: evalGov },
  );

  // ──────────────────────────────────────────────────────────────
  // Web Apps
  // ──────────────────────────────────────────────────────────────
  const create_web = wrapCreate(
    n("create_web_app"),
    "Create a Web App (Linux) on an App Service Plan.",
    z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      appServicePlanName: z.string(),
      httpsOnly: z.boolean().optional().default(true),
      linuxFxVersion: z.string().optional(),
      runtimeStack: z.string().optional(),
      minimumTlsVersion: z.enum(["1.0", "1.1", "1.2", "1.3"]).optional().default("1.2"),
      ftpsState: z.enum(["AllAllowed", "FtpsOnly", "Disabled"]).optional().default("Disabled"),
      tags: z.any().optional(),
    }).strict(),
    async (a) => {
      const linuxFx = a.linuxFxVersion ?? a.runtimeStack;
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.webApps.create({
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
    },
    { present: (out) => presentWebApp(out), evaluateGovernance: evalGov },
  );

  const get_web = wrapGet(
    n("get_web_app"),
    "Get a Web App.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a) => clients.webApps.get(a.resourceGroupName, a.name),
    { present: (out) => presentWebApp(out), evaluateGovernance: evalGov },
  );

  const enable_msi = wrapCreate(
    n("enable_system_assigned_identity"),
    "Enable system-assigned identity for a Web App.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a) => clients.webApps.enableSystemAssignedIdentity(a.resourceGroupName, a.name),
    { evaluateGovernance: evalGov },
  );

  const apply_settings = wrapCreate(
    n("apply_app_settings"),
    "Merge/apply app settings (key/value) on a Web App.",
    z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      appSettings: z.array(z.object({ name: z.string(), value: z.string() })).min(1),
    }).strict(),
    async (a) => clients.webApps.setAppSettings(a.resourceGroupName, a.name, a.appSettings),
    { evaluateGovernance: evalGov },
  );

  // ──────────────────────────────────────────────────────────────
  // Key Vault
  // ──────────────────────────────────────────────────────────────
  const create_kv = wrapCreate(
    n("create_key_vault"),
    "Create Key Vault (RBAC recommended).",
    z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      tenantId: z.string(),
      skuName: z.enum(["standard", "premium"]).default("standard"),
      enableRbacAuthorization: z.boolean().optional().default(true),
      publicNetworkAccess: z.enum(["Enabled", "Disabled"]).optional().default("Enabled"),
      tags: z.any().optional(),
    }).strict(),
    async (a) => {
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
    { present: (out) => presentKeyVault(out), evaluateGovernance: evalGov },
  );

  const get_kv = wrapGet(
    n("get_key_vault"),
    "Get Key Vault.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a) => clients.keyVaults.get(a.resourceGroupName, a.name),
    { present: (out) => presentKeyVault(out), evaluateGovernance: evalGov },
  );

  // ──────────────────────────────────────────────────────────────
  // Storage
  // ──────────────────────────────────────────────────────────────
  const create_sa = wrapCreate(
    n("create_storage_account"),
    "Create a Storage Account (StorageV2, HTTPS only recommended).",
    z.object({
      resourceGroupName: z.string(),
      name: z.string().regex(/^[a-z0-9]{3,24}$/),
      location: z.string(),
      skuName: z.enum(["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"]).default("Standard_LRS"),
      kind: z.enum(["StorageV2", "BlobStorage", "BlockBlobStorage", "FileStorage", "Storage"]).default("StorageV2"),
      enableHttpsTrafficOnly: z.boolean().optional().default(true),
      tags: z.any().optional(),
    }).strict(),
    async (a) => {
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
    { present: (out) => presentStorageAccount(out), evaluateGovernance: evalGov },
  );

  const get_sa = wrapGet(
    n("get_storage_account"),
    "Get a Storage Account.",
    z.object({ resourceGroupName: z.string(), accountName: z.string() }).strict(),
    async (a) => clients.storageAccounts.get(a.resourceGroupName, a.accountName),
    { present: (out) => presentStorageAccount(out), evaluateGovernance: evalGov },
  );

  // ──────────────────────────────────────────────────────────────
  // Log Analytics
  // ──────────────────────────────────────────────────────────────
  const create_law = wrapCreate(
    n("create_log_analytics_workspace"),
    "Create a Log Analytics Workspace.",
    z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      sku: z.string().optional().default("PerGB2018"),
      retentionInDays: z.number().int().min(7).max(730).optional(),
      tags: z.any().optional(),
    }).strict(),
    async (a) => {
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.logAnalytics.create({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        sku: a.sku,
        retentionInDays: a.retentionInDays,
        tags,
      });
    },
    { present: (out) => presentLogAnalyticsWorkspace(out), evaluateGovernance: evalGov },
  );

  const get_law = wrapGet(
    n("get_log_analytics_workspace"),
    "Get a Log Analytics Workspace.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a) => clients.logAnalytics.get(a.resourceGroupName, a.name),
    { present: (out) => presentLogAnalyticsWorkspace(out), evaluateGovernance: evalGov },
  );

  // ──────────────────────────────────────────────────────────────
  // Networking
  // ──────────────────────────────────────────────────────────────
  const create_vnet = wrapCreate(
    n("create_virtual_network"),
    "Create a Virtual Network.",
    z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      addressPrefixes: z.array(z.string()).nonempty(),
      dnsServers: z.array(z.string()).optional(),
      tags: z.any().optional(),
    }).strict(),
    async (a) => {
      const tags = normalizeTags(a.tags) ?? harvestTagsFromArgs(a);
      return clients.networks.createVnet({
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        location: a.location,
        addressPrefixes: a.addressPrefixes,
        dnsServers: a.dnsServers,
        tags,
      });
    },
    { present: (out) => presentVirtualNetwork(out), evaluateGovernance: evalGov },
  );

  const get_vnet = wrapGet(
    n("get_virtual_network"),
    "Get a Virtual Network.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a) => clients.networks.getVnet(a.resourceGroupName, a.name),
    { present: (out) => presentVirtualNetwork(out), evaluateGovernance: evalGov },
  );

  const create_subnet = wrapCreate(
    n("create_subnet"),
    "Create a Subnet in a VNet.",
    z.object({
      resourceGroupName: z.string(),
      virtualNetworkName: z.string(),
      name: z.string(),
      addressPrefix: z.string(),
      serviceEndpoints: z.array(z.string()).optional(),
      delegations: z.array(z.object({ serviceName: z.string() })).optional(),
      privateEndpointNetworkPolicies: z.enum(["Enabled", "Disabled"]).optional(),
      tags: z.any().optional(),
    }).strict(),
    async (a) => {
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
    },
    { present: (out) => presentSubnet(out), evaluateGovernance: evalGov },
  );

  const get_subnet = wrapGet(
    n("get_subnet"),
    "Get a Subnet.",
    z.object({ resourceGroupName: z.string(), virtualNetworkName: z.string(), name: z.string() }).strict(),
    async (a) => clients.networks.getSubnet(a.resourceGroupName, a.virtualNetworkName, a.name),
    { present: (out) => presentSubnet(out), evaluateGovernance: evalGov },
  );

  const create_pe = wrapCreate(
    n("create_private_endpoint"),
    "Create a Private Endpoint.",
    z.object({
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
    }).strict(),
    async (a) => {
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
    },
    { present: (out) => presentPrivateEndpoint(out), evaluateGovernance: evalGov },
  );

  const get_pe = wrapGet(
    n("get_private_endpoint"),
    "Get a Private Endpoint.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a) => clients.networks.getPrivateEndpoint(a.resourceGroupName, a.name),
    { present: (out) => presentPrivateEndpoint(out), evaluateGovernance: evalGov },
  );

  // ──────────────────────────────────────────────────────────────
  // AKS (optional)
  // ──────────────────────────────────────────────────────────────
  const create_aks = wrapCreate(
    n("create_aks_cluster"),
    "Create an AKS cluster.",
    z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string(),
      kubernetesVersion: z.string().optional(),
      agentPoolProfiles: z.array(
        z.object({
          name: z.string(),
          count: z.number().int().min(1),
          vmSize: z.string(),
          mode: z.enum(["System", "User"]).optional().default("System"),
        }),
      ).nonempty(),
      apiServerAccessProfile: z.object({ enablePrivateCluster: z.boolean().optional() }).optional(),
      tags: z.any().optional(),
    }).strict(),
    async (a) => {
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
    },
    { present: (out) => presentAksCluster(out), evaluateGovernance: evalGov },
  );

  const enable_aks_monitoring = wrapCreate(
    n("enable_aks_monitoring"),
    "Enable Container Insights for an AKS cluster (LAW link).",
    z.object({
      resourceGroupName: z.string(),
      clusterName: z.string(),
      workspaceResourceGroup: z.string(),
      workspaceName: z.string(),
    }).strict(),
    async (a) => {
      if (!clients.aks?.enableMonitoring) throw new Error("AKS monitoring not configured");
      return clients.aks.enableMonitoring(a);
    },
    { evaluateGovernance: evalGov },
  );

  const get_aks = wrapGet(
    n("get_aks_cluster"),
    "Get an AKS cluster.",
    z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
    async (a) => {
      if (!clients.aks?.get) throw new Error("AKS client not configured");
      return clients.aks.get(a.resourceGroupName, a.name);
    },
    { present: (out) => presentAksCluster(out), evaluateGovernance: evalGov },
  );

  // ──────────────────────────────────────────────────────────────
  // Scans + Remediations
  // ──────────────────────────────────────────────────────────────
  const scans = makeAzureScanTools(opts);
  const remediations = makeAzureRemediationTools(opts);

  const all: ToolDef[] = [
    // RG
    create_rg, get_rg,

    // Plan
    create_plan, get_plan,

    // Web
    create_web, get_web, enable_msi, apply_settings,

    // KV
    create_kv, get_kv,

    // Storage
    create_sa, get_sa,

    // LAW
    create_law, get_law,

    // Net
    create_vnet, get_vnet, create_subnet, get_subnet, create_pe, get_pe,

    // AKS
    create_aks, enable_aks_monitoring, get_aks,

    // Scans + Remediations
    ...scans,
    ...remediations,
  ];

  // Apply governance to everything (create/get/remediate), using injected evaluator
  return withGovernanceAll(all, evalGov);
}