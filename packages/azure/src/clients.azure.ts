// packages/azure-core/src/clients.azure-sdk.ts — v2 (deployments at RG/Subscription/MG)
import { DefaultAzureCredential } from "@azure/identity";
import { ResourceManagementClient, DeploymentMode } from "@azure/arm-resources";
import { WebSiteManagementClient } from "@azure/arm-appservice";
import { KeyVaultManagementClient } from "@azure/arm-keyvault";
import { StorageManagementClient } from "@azure/arm-storage";
import { OperationalInsightsManagementClient } from "@azure/arm-operationalinsights";
import { NetworkManagementClient } from "@azure/arm-network";
import { MonitorClient as AzureMonitorClient } from "@azure/arm-monitor";
import { ContainerServiceClient } from "@azure/arm-containerservice";

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
  const subscriptionId = subIdOrThrow(cfg);
  const credential = cfg?.credential ?? new DefaultAzureCredential();
  const retryOptions = {
    maxRetries: cfg?.retry?.maxRetries ?? 5,
    retryDelayInMs: cfg?.retry?.retryDelayInMs ?? 500,
    maxRetryDelayInMs: cfg?.retry?.maxRetryDelayInMs ?? 4000,
  } as const;
  const options: any = {
    userAgentOptions: cfg?.userAgentPrefix ? { userAgentPrefix: cfg.userAgentPrefix } : undefined,
    retryOptions,
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
      return res.resourceGroups.get(name);
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
    async create(rg, name, location, sku, tags) {
      const skuObj = typeof sku === "string" ? { name: sku } : sku;
      return app.appServicePlans.beginCreateOrUpdateAndWait(rg, name, { location, sku: skuObj, tags } as any);
    },
    async get(rg, name) {
      return app.appServicePlans.get(rg, name);
    },
    async listByResourceGroup(rg) {
      return toArray(app.appServicePlans.listByResourceGroup(rg));
    },
  };

  const webApps: WebAppsClient = {
    async create(p) {
      const serverFarmId = `/subscriptions/${subscriptionId}/resourceGroups/${p.resourceGroupName}/providers/Microsoft.Web/serverfarms/${p.appServicePlanName}`;
      const site: any = {
        location: p.location,
        serverFarmId,
        httpsOnly: p.httpsOnly,
        siteConfig: {
          linuxFxVersion: p.linuxFxVersion,
          ftpsState: p.ftpsState,
          minTlsVersion: p.minimumTlsVersion,
        },
        tags: p.tags,
        kind: "app,linux",
      };
      return app.webApps.beginCreateOrUpdateAndWait(p.resourceGroupName, p.name, site);
    },
    async get(rg, name) {
      return app.webApps.get(rg, name);
    },
    async getConfiguration(rg, name) {
      return app.webApps.getConfiguration(rg, name);
    },
    async enableSystemAssignedIdentity(rg, name) {
      return app.webApps.beginCreateOrUpdateAndWait(rg, name, { identity: { type: "SystemAssigned" } } as any);
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
