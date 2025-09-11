// packages/azure-core/src/types.ts — extend deployments scopes

export interface ResourceGroupsClient {
  create(name: string, location: string, tags?: Record<string, string>): Promise<any>;
  get(name: string): Promise<any>;
}

export interface AppServicePlansClient {
  create(rg: string, name: string, location: string, sku: any, tags?: Record<string, string>): Promise<any>;
  get(rg: string, name: string): Promise<any>;
  listByResourceGroup?(rg: string): Promise<any[]>;
}

export interface WebAppsClient {
  create(p: {
    resourceGroupName: string;
    name: string;
    location: string;
    appServicePlanName: string;
    httpsOnly?: boolean;
    linuxFxVersion?: string;
    minimumTlsVersion?: "1.0" | "1.1" | "1.2";
    ftpsState?: "AllAllowed" | "FtpsOnly" | "Disabled";
    tags?: Record<string, string>;
  }): Promise<any>;
  get(rg: string, name: string): Promise<any>;
  getConfiguration?(rg: string, name: string): Promise<any>;
  enableSystemAssignedIdentity(rg: string, name: string): Promise<any>;
  setAppSettings(rg: string, name: string, kv: Array<{ name: string; value: string }>): Promise<any>;
  listByResourceGroup?(rg: string): Promise<any[]>;
}

export interface KeyVaultsClient {
  create(p: {
    resourceGroupName: string;
    name: string;
    location: string;
    tenantId: string;
    skuName: "standard" | "premium";
    enableRbacAuthorization?: boolean;
    publicNetworkAccess?: "Enabled" | "Disabled";
    tags?: Record<string, string>;
  }): Promise<any>;
  get(rg: string, name: string): Promise<any>;
  listByResourceGroup?(rg: string): Promise<any[]>;
}

export interface StorageAccountsClient {
  create(p: {
    resourceGroupName: string;
    name: string;
    location: string;
    skuName:
      | "Standard_LRS"
      | "Standard_GRS"
      | "Standard_RAGRS"
      | "Standard_ZRS"
      | "Premium_LRS";
  kind: "StorageV2" | "BlobStorage" | "BlockBlobStorage" | "FileStorage" | "Storage";
    enableHttpsTrafficOnly?: boolean;
    tags?: Record<string, string>;
  }): Promise<any>;
  get(rg: string, accountName: string): Promise<any>;
  listByResourceGroup?(rg: string): Promise<any[]>;
}

export interface LogAnalyticsClient {
  create(p: {
    resourceGroupName: string;
    name: string;
    location: string;
    sku?: string;
    retentionInDays?: number;
    tags?: Record<string, string>;
  }): Promise<any>;
  get(rg: string, name: string): Promise<any>;
  listByResourceGroup?(rg: string): Promise<any[]>;
}

export interface NetworksClient {
  createVnet(p: {
    resourceGroupName: string;
    name: string;
    location: string;
    addressPrefixes: string[];
    dnsServers?: string[];
    tags?: Record<string, string>;
  }): Promise<any>;
  getVnet(rg: string, name: string): Promise<any>;
  createSubnet(p: {
    resourceGroupName: string;
    virtualNetworkName: string;
    name: string;
    addressPrefix: string;
    serviceEndpoints?: string[];
    delegations?: Array<{ serviceName: string }>; // minimal
    privateEndpointNetworkPolicies?: "Enabled" | "Disabled";
    tags?: Record<string, string>;
  }): Promise<any>;
  getSubnet(rg: string, vnetName: string, name: string): Promise<any>;
  createPrivateEndpoint(p: {
    resourceGroupName: string;
    name: string;
    location: string;
    vnetName: string;
    subnetName: string;
    targetResourceId: string;
    groupIds?: string[];
    privateDnsZoneGroupName?: string;
    privateDnsZoneIds?: string[];
    tags?: Record<string, string>;
  }): Promise<any>;
  getPrivateEndpoint(rg: string, name: string): Promise<any>;
  listVnetsByResourceGroup?(rg: string): Promise<any[]>;
}

export interface MonitorClient {
  diagnosticSettings?: {
    list?: (resourceUri: string) => Promise<any[]>;
  };
}

export interface AksClient {
  createCluster(params: any): Promise<any>;
  enableMonitoring(params: {
    resourceGroupName: string;
    clusterName: string;
    workspaceResourceGroup: string;
    workspaceName: string;
  }): Promise<any>;
  get(rg: string, name: string): Promise<any>;
}

export interface DeploymentsClient {
  /** RG-scope deployment */
  deployToResourceGroup(
    rg: string,
    deploymentName: string,
    properties: {
      mode: "Incremental" | "Complete" | string;
      template: any;
      parameters?: Record<string, { value: any }>;
    },
    opts?: { whatIf?: boolean }
  ): Promise<any>;
  /** Subscription-scope deployment (location required) */
  deployToSubscription(
    deploymentName: string,
    properties: {
      location: string;
      mode: "Incremental" | "Complete" | string;
      template: any;
      parameters?: Record<string, { value: any }>;
    },
    opts?: { whatIf?: boolean }
  ): Promise<any>;
  /** Management group-scope deployment (location required) */
  deployToManagementGroup(
    managementGroupId: string,
    deploymentName: string,
    properties: {
      location: string;
      mode: "Incremental" | "Complete" | string;
      template: any;
      parameters?: Record<string, { value: any }>;
    },
    opts?: { whatIf?: boolean }
  ): Promise<any>;
}

export interface AzureClients {
  resourceGroups: ResourceGroupsClient;
  appServicePlans: AppServicePlansClient;
  webApps: WebAppsClient;
  keyVaults: KeyVaultsClient;
  storageAccounts: StorageAccountsClient;
  logAnalytics: LogAnalyticsClient;
  networks: NetworksClient;
  deployments: DeploymentsClient;
  monitor?: MonitorClient;
  aks?: AksClient;
}

export type MakeAzureToolsOptions = {
  clients: AzureClients | any;
  evaluateGovernance?: any;
  namespace?: string;
  getAtoProfile?: (profile: string) => any;
  getAtoRule?: (domain: string, profile: string, code: string) => { controlIds?: string[]; suggest?: string } | null;
  hasAtoProfile?: (domain: string, profile: string) => boolean;
};
