// servers/platform-mcp/src/clients.azure.ts
import "dotenv/config";
import { DefaultAzureCredential } from "@azure/identity";

// ARM (management plane) SDK clients
import { ResourceManagementClient } from "@azure/arm-resources";
import { WebSiteManagementClient } from "@azure/arm-appservice";
import { KeyVaultManagementClient } from "@azure/arm-keyvault";
import { StorageManagementClient } from "@azure/arm-storage";
import { OperationalInsightsManagementClient } from "@azure/arm-operationalinsights";
import { NetworkManagementClient } from "@azure/arm-network";
import { ContainerServiceClient } from "@azure/arm-containerservice";

// .............................................................................
// Environment & endpoints
// .............................................................................
const SUBSCRIPTION_ID = process.env.AZURE_SUBSCRIPTION_ID;
if (!SUBSCRIPTION_ID) {
  throw new Error("[platform-mcp] AZURE_SUBSCRIPTION_ID is required");
}

// Default ARM endpoint works for Commercial; override for Azure Gov
// Commercial: https://management.azure.com
// Gov:        https://management.usgovcloudapi.net
const ARM_ENDPOINT =
  process.env.AZURE_ARM_ENDPOINT?.trim() || "https://management.azure.com";

// Single credential for all ARM clients
const credential: any = new DefaultAzureCredential();

// Each SDK’s constructor accepts an options bag where we can pass the baseUrl/endpoint
const commonClientOpts: any = { endpoint: ARM_ENDPOINT as string };

// Instantiate clients
const res = new ResourceManagementClient(credential, SUBSCRIPTION_ID, commonClientOpts);
const web = new WebSiteManagementClient(credential, SUBSCRIPTION_ID, commonClientOpts);
const kv  = new KeyVaultManagementClient(credential, SUBSCRIPTION_ID, commonClientOpts);
const sto = new StorageManagementClient(credential, SUBSCRIPTION_ID, commonClientOpts);
const law = new OperationalInsightsManagementClient(credential, SUBSCRIPTION_ID, commonClientOpts);
const net = new NetworkManagementClient(credential, SUBSCRIPTION_ID, commonClientOpts);
const aks = new ContainerServiceClient(credential, SUBSCRIPTION_ID, commonClientOpts);

// Small helpers
const rid = {
  plan: (rg: string, plan: string) =>
    `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${plan}`,
  law: (rg: string, name: string) =>
    `/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${rg}/providers/Microsoft.OperationalInsights/workspaces/${name}`,
};

function toAppSettingsMap(items: Array<{ name: string; value: string }>) {
  const map: Record<string, string> = {};
  for (const { name, value } of items) map[name] = value;
  return map;
}

// .............................................................................
// AzureClients implementation (exported objects match @platform/azure-core/src/types.ts)
// .............................................................................

export const resClient = {
  async create(name: string, location: string, tags?: Record<string, string>) {
    return res.resourceGroups.createOrUpdate(name, { location, tags });
  },
  async get(name: string) {
    return res.resourceGroups.get(name);
  },
};

export const appClient = {
  async create(
    resourceGroupName: string,
    name: string,
    location: string,
    sku: string | Record<string, any>,
    tags?: Record<string, string>
  ) {
    // Accept either a simple string (e.g., "P1v3") or a full SKU object
    const skuObj =
      typeof sku === "string" ? { name: sku } : sku;

    return web.appServicePlans.beginCreateOrUpdateAndWait(resourceGroupName, name, {
      location,
      sku: skuObj,
      tags,
      // You can set properties like perSiteScaling, zoneRedundant, reserved (Linux) if needed
    });
  },

  async get(resourceGroupName: string, name: string) {
    return web.appServicePlans.get(resourceGroupName, name);
  },
};

export const storageClient = {
  async create(args: {
    resourceGroupName: string;
    name: string;
    location: string;
    skuName: "Standard_LRS" | "Standard_GRS" | "Standard_RAGRS" | "Standard_ZRS" | "Premium_LRS";
    kind: "StorageV2" | "BlobStorage" | "BlockBlobStorage" | "FileStorage" | "Storage";
    enableHttpsTrafficOnly?: boolean;
    tags?: Record<string, string>;
  }) {
    const { resourceGroupName, name, location, skuName, kind, enableHttpsTrafficOnly, tags } = args;
    return sto.storageAccounts.beginCreateAndWait(resourceGroupName, name, {
      location,
      sku: { name: skuName },
      kind,
      enableHttpsTrafficOnly: enableHttpsTrafficOnly ?? true,
      tags,
    });
  },

  async get(resourceGroupName: string, name: string) {
    return sto.storageAccounts.getProperties(resourceGroupName, name);
  },
};

export const kvClient = {
  async create(args: {
    resourceGroupName: string;
    name: string;
    location: string;
    tenantId: string;
    skuName: "standard" | "premium";
    enableRbacAuthorization?: boolean;
    publicNetworkAccess?: "Enabled" | "Disabled";
    tags?: Record<string, string>;
  }) {
    const {
      resourceGroupName, name, location, tenantId, skuName,
      enableRbacAuthorization = true,
      publicNetworkAccess = "Enabled",
      tags,
    } = args;

    return kv.vaults.beginCreateOrUpdateAndWait(resourceGroupName, name, {
      location,
      tags,
      properties: {
        tenantId,
        sku: { name: skuName, family: "A" },
        enableRbacAuthorization,
        // For the 2023+ API, publicNetworkAccess sits inside properties for KV mgmt
        publicNetworkAccess,
      },
    });
  },

  async get(resourceGroupName: string, name: string) {
    return kv.vaults.get(resourceGroupName, name);
  },
};

export const lawClient = {
  async create(args: {
    resourceGroupName: string;
    name: string;
    location: string;
    sku?: string; // default "PerGB2018"
    retentionInDays?: number;
    tags?: Record<string, string>;
  }) {
    const {
      resourceGroupName, name, location,
      sku = "PerGB2018",
      retentionInDays,
      tags,
    } = args;

    return law.workspaces.beginCreateOrUpdateAndWait(resourceGroupName, name, {
      location,
      tags,
      sku: { name: sku as any },
      retentionInDays,
    });
  },

  async get(resourceGroupName: string, name: string) {
    return law.workspaces.get(resourceGroupName, name);
  },
};

export const networksClient = {
  async createVnet(args: {
    resourceGroupName: string;
    name: string;
    location: string;
    addressPrefixes: string[];
    dnsServers?: string[];
    tags?: Record<string, string>;
  }) {
    const { resourceGroupName, name, location, addressPrefixes, dnsServers, tags } = args;
    return net.virtualNetworks.beginCreateOrUpdateAndWait(resourceGroupName, name, {
      location,
      tags,
      addressSpace: { addressPrefixes },
      dhcpOptions: dnsServers && dnsServers.length ? { dnsServers } : undefined,
    });
  },

  async getVnet(resourceGroupName: string, name: string) {
    return net.virtualNetworks.get(resourceGroupName, name);
  },

  async createSubnet(args: {
    resourceGroupName: string;
    virtualNetworkName: string;
    name: string;
    addressPrefix: string;
    serviceEndpoints?: string[];
    delegations?: Array<{ serviceName: string }>;
    privateEndpointNetworkPolicies?: "Enabled" | "Disabled";
    tags?: Record<string, string>;
  }) {
    const {
      resourceGroupName, virtualNetworkName, name, addressPrefix,
      serviceEndpoints, delegations, privateEndpointNetworkPolicies, tags,
    } = args;

    return net.subnets.beginCreateOrUpdateAndWait(resourceGroupName, virtualNetworkName, name, {
      addressPrefix,
      // Map ["Microsoft.Storage"] → [{ service: "Microsoft.Storage" }]
      serviceEndpoints: serviceEndpoints?.map(s => ({ service: s })),
      delegations: delegations?.map(d => ({ serviceName: d.serviceName })),
      privateEndpointNetworkPolicies,
      // Some API versions do not accept tags at the subnet level; include only if needed
      // tags,
    } as any);
  },

  async getSubnet(resourceGroupName: string, virtualNetworkName: string, name: string) {
    return net.subnets.get(resourceGroupName, virtualNetworkName, name);
  },

  async createPrivateEndpoint(args: {
    resourceGroupName: string;
    name: string;
    location: string;
    vnetName: string;
    subnetName: string;
    targetResourceId: string;
    groupIds?: string[];
    privateDnsZoneGroupName?: string;
    privateDnsZoneIds?: string[]; // resource IDs of Private DNS Zones
    tags?: Record<string, string>;
  }) {
    const {
      resourceGroupName, name, location, vnetName, subnetName,
      targetResourceId, groupIds, privateDnsZoneGroupName, privateDnsZoneIds, tags,
    } = args;

    // Lookup subnet ID first
    const subnet = await net.subnets.get(resourceGroupName, vnetName, subnetName);

    // Create Private Endpoint
    const pe = await net.privateEndpoints.beginCreateOrUpdateAndWait(resourceGroupName, name, {
      location,
      tags,
      subnet: { id: subnet.id },
      privateLinkServiceConnections: [
        {
          name: `${name}-pls`,
          privateLinkServiceId: targetResourceId,
          groupIds: groupIds ?? [],
        },
      ],
    });

    // Optionally attach Private DNS zone group
    if (privateDnsZoneGroupName && privateDnsZoneIds?.length) {
      // Many API versions expect "privateDnsZoneConfigs" with a list of zone IDs.
      await net.privateDnsZoneGroups.beginCreateOrUpdateAndWait(
        resourceGroupName,
        name, // parent PE name
        privateDnsZoneGroupName,
        {
          name: privateDnsZoneGroupName,
          privateDnsZoneConfigs: privateDnsZoneIds.map((zoneId, i) => ({
            name: `config-${i + 1}`,
            privateDnsZoneId: zoneId,
          })) as any,
        } as any
      );
    }

    return pe;
  },

  async getPrivateEndpoint(resourceGroupName: string, name: string) {
    return net.privateEndpoints.get(resourceGroupName, name);
  },
};

export const webAppsClient = {
  async create(args: {
    resourceGroupName: string;
    name: string;
    location: string;
    appServicePlanName: string;
    httpsOnly?: boolean;
    linuxFxVersion?: string;
    minimumTlsVersion?: "1.0" | "1.1" | "1.2";
    ftpsState?: "AllAllowed" | "FtpsOnly" | "Disabled";
    tags?: Record<string, string>;
  }) {
    const {
      resourceGroupName, name, location, appServicePlanName,
      httpsOnly = true, linuxFxVersion, minimumTlsVersion = "1.2",
      ftpsState = "Disabled", tags,
    } = args;

    const planId = rid.plan(resourceGroupName, appServicePlanName);

    return web.webApps.beginCreateOrUpdateAndWait(resourceGroupName, name, {
      location,
      tags,
      serverFarmId: planId,
      httpsOnly,
      siteConfig: {
        linuxFxVersion,
        minTlsVersion: minimumTlsVersion,
        ftpsState,
      } as any,
    });
  },

  async get(resourceGroupName: string, name: string) {
    return web.webApps.get(resourceGroupName, name);
  },

  async enableSystemAssignedIdentity(resourceGroupName: string, name: string) {
    // PATCH the site with identity block
    return web.webApps.update(resourceGroupName, name, {
      identity: { type: "SystemAssigned" },
    } as any);
  },

  async setAppSettings(
    resourceGroupName: string,
    name: string,
    appSettings: Array<{ name: string; value: string }>
  ) {
    return web.webApps.updateApplicationSettings(resourceGroupName, name, {
      properties: toAppSettingsMap(appSettings),
    });
  },
};

// Expose a shape that matches AzureClients.webApps (the interface expects `webApps`)
export const webApps = {
  create: webAppsClient.create,
  get: webAppsClient.get,
  enableSystemAssignedIdentity: webAppsClient.enableSystemAssignedIdentity,
  setAppSettings: webAppsClient.setAppSettings,
};

// AKS helpers (used by onboarding templates)
export const aksClient = {
  async createCluster(args: {
    resourceGroupName: string;
    name: string;
    location: string;
    kubernetesVersion?: string;
    agentPoolProfiles: Array<{ name: string; count: number; vmSize: string; mode?: "System" | "User" }>;
    apiServerAccessProfile?: { enablePrivateCluster?: boolean };
    tags?: Record<string, string>;
  }) {
    const {
      resourceGroupName, name, location, kubernetesVersion,
      agentPoolProfiles, apiServerAccessProfile, tags,
    } = args;

    return aks.managedClusters.beginCreateOrUpdateAndWait(resourceGroupName, name, {
      location,
      tags,
      kubernetesVersion,
      agentPoolProfiles: agentPoolProfiles.map(p => ({
        name: p.name,
        count: p.count,
        vmSize: p.vmSize,
        mode: p.mode,
        osType: "Linux",
        type: "VirtualMachineScaleSets",
        orchestratorVersion: kubernetesVersion,
      })) as any,
      apiServerAccessProfile,
      identity: { type: "SystemAssigned" },
      dnsPrefix: `${name}-dns`,
    } as any);
  },

  async enableMonitoring(args: {
    resourceGroupName: string;
    clusterName: string;
    workspaceResourceGroup: string;
    workspaceName: string;
  }) {
    const { resourceGroupName, clusterName, workspaceResourceGroup, workspaceName } = args;

    const cluster = await aks.managedClusters.get(resourceGroupName, clusterName);
    const lawId = rid.law(workspaceResourceGroup, workspaceName);

    const addons = cluster.addonProfiles ?? {};
    addons.omsagent = {
      enabled: true,
      config: { logAnalyticsWorkspaceResourceID: lawId },
    } as any;

    return aks.managedClusters.beginCreateOrUpdateAndWait(resourceGroupName, clusterName, {
      ...cluster,
      addonProfiles: addons,
    } as any);
  },

  async get(resourceGroupName: string, name: string) {
    return aks.managedClusters.get(resourceGroupName, name);
  },
};

// Export a single 'clients' object that conforms to the AzureClients interface
export const clients = {
  resourceGroups: resClient,
  appServicePlans: appClient,
  webApps: webApps,
  keyVaults: kvClient,
  storageAccounts: storageClient,
  logAnalytics: lawClient,
  networks: networksClient,
  aks: aksClient,
};
