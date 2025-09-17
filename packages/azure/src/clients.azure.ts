// packages/azure-core/src/clients.azure-sdk.ts — v2 (deployments at RG/Subscription/MG)
import { AzureAuthorityHosts, DefaultAzureCredential, EnvironmentCredential } from "@azure/identity";
import { ResourceManagementClient, DeploymentMode } from "@azure/arm-resources";
import { WebSiteManagementClient } from "@azure/arm-appservice";
import { KeyVaultManagementClient } from "@azure/arm-keyvault";
import { StorageManagementClient } from "@azure/arm-storage";
import { OperationalInsightsManagementClient } from "@azure/arm-operationalinsights";
import { NetworkManagementClient } from "@azure/arm-network";
import { MonitorClient as AzureMonitorClient } from "@azure/arm-monitor";
import { ContainerServiceClient } from "@azure/arm-containerservice";
import { ensureAzureCloudEnv, armClientOptions } from "./clouds.js";
import "dotenv/config";
import type {
  AzureClients,
  AppServicePlansClient,
  ResourceGroupsClient,
  WebAppsClient,
  KeyVaultsClient,
  StorageAccountsClient,
  LogAnalyticsClient,
  NetworksClient,
  MonitorClient,
  AksClient,
  DeploymentsClient,
} from "./types.js";

export type AzureSdkConfig = {
  subscriptionId?: string;
  credential?: any;
  userAgentPrefix?: string;
  retry?: { maxRetries?: number; retryDelayInMs?: number; maxRetryDelayInMs?: number };
};

function subIdOrThrow(cfg?: AzureSdkConfig): string {
  const id = cfg?.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID;
  if (!id) throw new Error("AZURE_SUBSCRIPTION_ID is required to create Azure SDK clients");
  return id;
}

async function toArray<T = any>(iter: any): Promise<T[]> {
  if (!iter) return [];
  if (Array.isArray(iter)) return iter as T[];
  const out: T[] = [];
  try {
    for await (const item of iter) out.push(item as T);
    return out;
  } catch {
    const value = (iter as any)?.value ?? [];
    return Array.isArray(value) ? (value as T[]) : [];
  }
}

export function createAzureSdkClients(cfg?: AzureSdkConfig): AzureClients {
  const cloud = ensureAzureCloudEnv(); // must set login.microsoftonline.us + usgovcloudapi.net
  const subscriptionId = subIdOrThrow(cfg);

  // 👇 Prefer SPN from env for servers; avoid CLI/VSC creds (can be public cloud)
  const haveSpn =
    !!process.env.AZURE_TENANT_ID &&
    !!process.env.AZURE_CLIENT_ID &&
    !!process.env.AZURE_CLIENT_SECRET;

  const authorityHost =
    cloud.authorityHost || AzureAuthorityHosts.AzureGovernment; // e.g. https://login.microsoftonline.us

  const credential = haveSpn
    ? new EnvironmentCredential({ authorityHost })
    : new DefaultAzureCredential({
      authorityHost,
    });

  // 👇 Ensure Gov ARM endpoint is used by all clients
  const armEndpoint = cloud.resourceManager || "https://management.usgovcloudapi.net";

  // If your armClientOptions() doesn’t already set endpoint, force it:
  const base = { ...armClientOptions(), endpoint: armEndpoint };

  const options: any = {
    ...base,
    userAgentOptions: cfg?.userAgentPrefix ? { userAgentPrefix: cfg.userAgentPrefix } : undefined,
    retryOptions: {
      maxRetries: cfg?.retry?.maxRetries ?? 5,
      retryDelayInMs: cfg?.retry?.retryDelayInMs ?? 500,
      maxRetryDelayInMs: cfg?.retry?.maxRetryDelayInMs ?? 4000,
    },
  };

  const res = new ResourceManagementClient(credential, subscriptionId, options);
  const app = new WebSiteManagementClient(credential, subscriptionId, options);
  const kv = new KeyVaultManagementClient(credential, subscriptionId, options);
  const st = new StorageManagementClient(credential, subscriptionId, options);
  const law = new OperationalInsightsManagementClient(credential, subscriptionId, options);
  const net = new NetworkManagementClient(credential, subscriptionId, options);
  const mon = new AzureMonitorClient(credential, subscriptionId, options);
  const aks = new ContainerServiceClient(credential, subscriptionId, options);

  const resourceGroups: ResourceGroupsClient = {
    async create(name, location, tags) {
      return res.resourceGroups.createOrUpdate(name, { location, tags });
    },
    async get(name) {
      // inside your handler after creating/fetching the RG:
      const result = await res.resourceGroups.get(name);
      return result;
    },
  };

  const deployments: DeploymentsClient = {
    async deployToResourceGroup(rg, deploymentName, properties, opts) {
      const deploymentProps = {
        mode: properties.mode as DeploymentMode,
        template: properties.template,
        parameters: properties.parameters,
      };
      if (opts?.whatIf && (res.deployments as any)?.beginWhatIfAndWait) {
        return (res.deployments as any).beginWhatIfAndWait(rg, deploymentName, { properties: deploymentProps });
      }
      return res.deployments.beginCreateOrUpdateAndWait(rg, deploymentName, { properties: deploymentProps });
    },
    async deployToSubscription(deploymentName, properties, opts) {
      const deploymentProps = {
        mode: properties.mode as DeploymentMode,
        template: properties.template,
        parameters: properties.parameters,
      };
      const body: any = {
        location: properties.location,
        properties: deploymentProps,
      };
      if (opts?.whatIf && (res.deployments as any)?.beginWhatIfAtSubscriptionScopeAndWait) {
        return (res.deployments as any).beginWhatIfAtSubscriptionScopeAndWait(deploymentName, body);
      }
      return (res.deployments as any).beginCreateOrUpdateAtSubscriptionScopeAndWait(deploymentName, body);
    },
    async deployToManagementGroup(managementGroupId, deploymentName, properties, opts) {
      const deploymentProps = {
        mode: properties.mode as DeploymentMode,
        template: properties.template,
        parameters: properties.parameters,
      };
      const body: any = {
        location: properties.location,
        properties: deploymentProps,
      };
      if (opts?.whatIf && (res.deployments as any)?.beginWhatIfAtManagementGroupScopeAndWait) {
        return (res.deployments as any).beginWhatIfAtManagementGroupScopeAndWait(managementGroupId, deploymentName, body);
      }
      return (res.deployments as any).beginCreateOrUpdateAtManagementGroupScopeAndWait(managementGroupId, deploymentName, body);
    },
  };

  const appServicePlans: AppServicePlansClient = {
    async create(rg, name, region, sku, tags) {
      if (!region) throw new Error("App Service Plan region missing");
      const skuObj = typeof sku === "string" ? { name: sku } : sku;

      const body: any = { location: region, sku: skuObj, tags };
      console.info("[sdk] appServicePlans.create", { rg, name, region, sku: skuObj }); // <- optional but handy

      return app.appServicePlans.beginCreateOrUpdateAndWait(rg, name, body);
    },

    async get(rg, name) {
      return app.appServicePlans.get(rg, name);
    },

    async listByResourceGroup(rg) {
      return toArray(app.appServicePlans.listByResourceGroup(rg));
    },

    async update(rg, name, patch) {
      // Reuse current location; Azure requires it on updates
      const cur: any = await app.appServicePlans.get(rg, name);
      const region = cur?.location;
      if (!region) throw new Error("Existing App Service Plan has no location");

      const mergedSku =
        typeof patch?.sku === "string"
          ? { ...(cur?.sku ?? {}), name: patch.sku }
          : { ...(cur?.sku ?? {}), ...(patch?.sku ?? {}) };

      if (typeof patch?.capacity === "number") {
        (mergedSku as any).capacity = patch.capacity;
      }

      const body: any = {
        location: region,
        tags: patch?.tags ?? cur?.tags,
        sku: mergedSku,
        zoneRedundant:
          typeof patch?.zoneRedundant === "boolean"
            ? patch.zoneRedundant
            : (cur as any)?.zoneRedundant,
      };

      console.info("[sdk] appServicePlans.update", { rg, name, region, sku: mergedSku }); // optional

      return app.appServicePlans.beginCreateOrUpdateAndWait(rg, name, body);
    },
  };


  const webApps: WebAppsClient = {
    async create(p) {
      if (!p.resourceGroupName) throw new Error("Web App resourceGroupName missing");
      if (!p.location) throw new Error("Web App location missing");
      const serverFarmId =
        `/subscriptions/${subscriptionId}/resourceGroups/${p.resourceGroupName}` +
        `/providers/Microsoft.Web/serverfarms/${p.appServicePlanName}`;

      const site: any = {
        location: p.location,
        serverFarmId,
        httpsOnly: p.httpsOnly ?? true,
        // Linux web app:
        kind: "linux",
        reserved: true,
        siteConfig: {
          ...(p.minimumTlsVersion ? { minTlsVersion: p.minimumTlsVersion } : {}),  // TLS version
          ...(p.ftpsState ? { ftpsState: p.ftpsState } : {}),                   // FTPS state
          ...(p.linuxFxVersion ? { linuxFxVersion: p.linuxFxVersion } : {}) // Linux runtime
        },
        tags: p.tags,
      };

      return app.webApps.beginCreateOrUpdateAndWait(p.resourceGroupName, p.name, site);
    },

    async get(rg, name) {
      return app.webApps.get(rg, name);
    },

    async getConfiguration(rg, name) {
      return app.webApps.getConfiguration(rg, name);
    },

    async update(rg, name, patch) {
      const cur: any = await app.webApps.get(rg, name);
      const site: any = {
        location: cur?.location,
        serverFarmId: cur?.serverFarmId,
        httpsOnly: (typeof patch?.httpsOnly === "boolean")
          ? patch.httpsOnly
          : (cur?.httpsOnly ?? cur?.properties?.httpsOnly),
        kind: cur?.kind || "app,linux",
        reserved: cur?.reserved ?? true,
        siteConfig: {
          ...(cur?.siteConfig || {}),
          minTlsVersion:
            patch?.minTlsVersion ??
            patch?.minimumTlsVersion ??
            cur?.siteConfig?.minTlsVersion ??
            cur?.properties?.minimumTlsVersion,
          ftpsState: patch?.ftpsState ?? cur?.siteConfig?.ftpsState,
          linuxFxVersion: patch?.linuxFxVersion ?? cur?.siteConfig?.linuxFxVersion,
        },
        identity: patch?.identity ?? cur?.identity,
        tags: patch?.tags ?? cur?.tags,
      };

      return app.webApps.beginCreateOrUpdateAndWait(rg, name, site);
    },

    async updateConfiguration(rg, name, patch) {
      return (app.webApps as any).updateConfiguration(rg, name, patch);
    },

    async enableSystemAssignedIdentity(rg, name) {
      // Include location + existing fields to avoid serializer errors
      const cur: any = await app.webApps.get(rg, name);

      const site: any = {
        location: cur?.location,
        serverFarmId: cur?.serverFarmId,
        kind: cur?.kind || "app,linux",
        reserved: cur?.reserved ?? true,
        httpsOnly: cur?.httpsOnly ?? cur?.properties?.httpsOnly,
        siteConfig: cur?.siteConfig,
        identity: { type: "SystemAssigned" },
        tags: cur?.tags,
      };

      return app.webApps.beginCreateOrUpdateAndWait(rg, name, site);
    },

    async setAppSettings(rg, name, settings) {
      const props: Record<string, string> = {};
      for (const { name: k, value } of settings) props[k] = value;
      return app.webApps.updateApplicationSettings(rg, name, { properties: props });
    },

    async listByResourceGroup(rg) {
      return toArray(app.webApps.listByResourceGroup(rg));
    },
  };

  const keyVaults: KeyVaultsClient = {
    async create(p) {
      const parameters: any = {
        location: p.location,
        tags: p.tags,
        properties: {
          tenantId: p.tenantId,
          sku: { name: p.skuName },
          enableRbacAuthorization: p.enableRbacAuthorization,
          publicNetworkAccess: p.publicNetworkAccess,
        },
      };
      return kv.vaults.beginCreateOrUpdateAndWait(p.resourceGroupName, p.name, parameters);
    },
    async get(rg, name) {
      return kv.vaults.get(rg, name);
    },
    async listByResourceGroup(rg) {
      return toArray(kv.vaults.listByResourceGroup(rg));
    },
  };

  const storageAccounts: StorageAccountsClient = {
    async create(p) {
      const parameters: any = {
        location: p.location,
        kind: p.kind,
        sku: { name: p.skuName },
        tags: p.tags,
        properties: { supportsHttpsTrafficOnly: p.enableHttpsTrafficOnly },
      };
      return st.storageAccounts.beginCreateAndWait(p.resourceGroupName, p.name, parameters);
    },
    async get(rg, accountName) {
      return st.storageAccounts.getProperties(rg, accountName);
    },
    async listByResourceGroup(rg) {
      return toArray(st.storageAccounts.listByResourceGroup(rg));
    },
  };

  const logAnalytics: LogAnalyticsClient = {
    async create(p) {
      const parameters: any = {
        location: p.location,
        sku: p.sku ? { name: p.sku } : undefined,
        retentionInDays: p.retentionInDays,
        tags: p.tags,
      };
      return law.workspaces.beginCreateOrUpdateAndWait(p.resourceGroupName, p.name, parameters);
    },
    async get(rg, name) {
      return law.workspaces.get(rg, name);
    },
    async listByResourceGroup(rg) {
      return toArray(law.workspaces.listByResourceGroup(rg));
    },
  };

  const networks: NetworksClient = {
    async createVnet(p) {
      const parameters: any = {
        location: p.location,
        addressSpace: { addressPrefixes: p.addressPrefixes },
        dhcpOptions: p.dnsServers ? { dnsServers: p.dnsServers } : undefined,
        tags: p.tags,
      };
      return net.virtualNetworks.beginCreateOrUpdateAndWait(p.resourceGroupName, p.name, parameters);
    },
    async getVnet(rg, name) {
      return net.virtualNetworks.get(rg, name);
    },
    async createSubnet(p) {
      const parameters: any = {
        addressPrefix: p.addressPrefix,
        serviceEndpoints: Array.isArray(p.serviceEndpoints)
          ? p.serviceEndpoints.map((s, i) => ({ service: s }))
          : undefined,
        delegations: Array.isArray(p.delegations)
          ? p.delegations.map((d, i) => ({ name: `del${i}`, serviceName: d.serviceName }))
          : undefined,
        privateEndpointNetworkPolicies: p.privateEndpointNetworkPolicies,
      };
      return net.subnets.beginCreateOrUpdateAndWait(
        p.resourceGroupName,
        p.virtualNetworkName,
        p.name,
        parameters
      );
    },
    async getSubnet(rg, vnetName, name) {
      return net.subnets.get(rg, vnetName, name);
    },
    async createPrivateEndpoint(p) {
      const peSubnetId = `/subscriptions/${subscriptionId}/resourceGroups/${p.resourceGroupName}/providers/Microsoft.Network/virtualNetworks/${p.vnetName}/subnets/${p.subnetName}`;
      const parameters: any = {
        location: p.location,
        subnet: { id: peSubnetId },
        privateLinkServiceConnections: [
          { name: "pls-0", privateLinkServiceId: p.targetResourceId, groupIds: p.groupIds },
        ],
        tags: p.tags,
      };
      if (p.privateDnsZoneGroupName && Array.isArray(p.privateDnsZoneIds) && p.privateDnsZoneIds.length) {
        parameters.privateDnsZoneGroups = [
          {
            name: p.privateDnsZoneGroupName,
            privateDnsZoneConfigs: p.privateDnsZoneIds.map((id: string, i: number) => ({
              name: `zone${i}`,
              privateDnsZoneId: id,
            })),
          },
        ];
      }
      return net.privateEndpoints.beginCreateOrUpdateAndWait(p.resourceGroupName, p.name, parameters);
    },
    async getPrivateEndpoint(rg, name) {
      return net.privateEndpoints.get(rg, name);
    },
    async listVnetsByResourceGroup(rg) {
      return toArray(net.virtualNetworks.list(rg));
    },
  };

  const monitor: MonitorClient = {
    diagnosticSettings: {
      async list(resourceUri: string) {
        const result = await mon.diagnosticSettings.list(resourceUri);
        return toArray(result.value);
      },
      async createOrUpdate(resourceUri: string, nameOrParams: any, maybeParams?: any) {
        // Support both SDK shapes:
        // - createOrUpdate(resourceUri, name, params)
        // - createOrUpdate(resourceUri, params)
        const ds: any = (mon as any).diagnosticSettings;
        if (maybeParams !== undefined) {
          return ds.createOrUpdate(resourceUri, nameOrParams, maybeParams);
        }
        return ds.createOrUpdate(resourceUri, nameOrParams);
      },
    },
  };

  const aksClient: AksClient = {
    async createCluster(params: any) {
      return aks.managedClusters.beginCreateOrUpdateAndWait(
        params.resourceGroupName,
        params.name,
        params
      );
    },
    async enableMonitoring({ resourceGroupName, clusterName, workspaceResourceGroup, workspaceName }: any) {
      const wsId = `/subscriptions/${subscriptionId}/resourceGroups/${workspaceResourceGroup}/providers/Microsoft.OperationalInsights/workspaces/${workspaceName}`;
      const current = await aks.managedClusters.get(resourceGroupName, clusterName);
      const updated: any = {
        location: (current as any)?.location,
        tags: (current as any)?.tags,
        identity: (current as any)?.identity,
        dnsPrefix: (current as any)?.dnsPrefix,
        kubernetesVersion: (current as any)?.kubernetesVersion,
        agentPoolProfiles: (current as any)?.agentPoolProfiles,
        linuxProfile: (current as any)?.linuxProfile,
        windowsProfile: (current as any)?.windowsProfile,
        networkProfile: (current as any)?.networkProfile,
        servicePrincipalProfile: (current as any)?.servicePrincipalProfile,
        addonProfiles: {
          ...(current as any)?.addonProfiles,
          omsagent: { enabled: true, config: { logAnalyticsWorkspaceResourceID: wsId } },
        },
      };
      return aks.managedClusters.beginCreateOrUpdateAndWait(
        resourceGroupName,
        clusterName,
        updated
      );
    },
    async get(rg: string, name: string) {
      return aks.managedClusters.get(rg, name);
    },
  };

  const clients: AzureClients = {
    resourceGroups,
    appServicePlans: appServicePlans,
    webApps,
    keyVaults,
    storageAccounts,
    logAnalytics,
    networks,
    deployments,
    monitor,
    aks: aksClient,
  };
  return clients;
}