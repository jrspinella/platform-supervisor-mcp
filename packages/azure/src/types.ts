import type { ToolDef } from "mcp-http";
import type { z } from "zod";

/**
 * Governance hook (optional).
 */
export type GovernanceFn = (
  toolFq: string,
  args: any,
  context?: any
) => Promise<{
  decision: "allow" | "warn" | "deny";
  reasons?: string[];
  suggestions?: Array<{ title?: string; text: string }>;
  policyIds?: string[];
}>;

/**
 * Minimal, stable interfaces the Platform MCP will implement in its `clients.azure.ts`.
 * You are free to use Azure SDK (ARM) or REST under the hood; just fulfill these shapes.
 */
export interface AzureClients {
  resourceGroups: {
    create: (name: string, location: string, tags?: Record<string, string>) => Promise<any>;
    get: (name: string) => Promise<any>;
  };
  appServicePlans: {
    create: (rg: string, name: string, location: string, sku: string | Record<string, any>, tags?: Record<string, string>) => Promise<any>;
    get: (rg: string, name: string) => Promise<any>;
  };
  webApps: {
    create: (args: {
      resourceGroupName: string;
      name: string;
      location: string;
      appServicePlanName: string;
      httpsOnly?: boolean;
      linuxFxVersion?: string;       // e.g., NODE|20-lts
      minimumTlsVersion?: "1.0" | "1.1" | "1.2";
      ftpsState?: "AllAllowed" | "FtpsOnly" | "Disabled";
      tags?: Record<string, string>;
    }) => Promise<any>;
    get: (rg: string, name: string) => Promise<any>;
    enableSystemAssignedIdentity: (rg: string, name: string) => Promise<any>;
    setAppSettings: (rg: string, name: string, appSettings: Array<{ name: string; value: string }>) => Promise<any>;
  };
  keyVaults: {
    create: (args: {
      resourceGroupName: string;
      name: string;
      location: string;
      tenantId: string;
      skuName: "standard" | "premium";
      enableRbacAuthorization?: boolean;
      publicNetworkAccess?: "Enabled" | "Disabled";
      tags?: Record<string, string>;
    }) => Promise<any>;
    get: (rg: string, name: string) => Promise<any>;
  };
  storageAccounts: {
    create: (args: {
      resourceGroupName: string;
      name: string;
      location: string;
      skuName: "Standard_LRS" | "Standard_GRS" | "Standard_RAGRS" | "Standard_ZRS" | "Premium_LRS";
      kind: "StorageV2" | "BlobStorage" | "BlockBlobStorage" | "FileStorage" | "Storage";
      enableHttpsTrafficOnly?: boolean;
      tags?: Record<string, string>;
    }) => Promise<any>;
    get: (rg: string, name: string) => Promise<any>;
  };
  logAnalytics: {
    create: (args: {
      resourceGroupName: string;
      name: string;
      location: string;
      sku?: string;               // "PerGB2018"
      retentionInDays?: number;   // optional
      tags?: Record<string, string>;
    }) => Promise<any>;
    get: (rg: string, name: string) => Promise<any>;
  };
  networks: {
    createVnet: (args: {
      resourceGroupName: string;
      name: string;
      location: string;
      addressPrefixes: string[];
      dnsServers?: string[];
      tags?: Record<string, string>;
    }) => Promise<any>;
    getVnet: (rg: string, name: string) => Promise<any>;
    createSubnet: (args: {
      resourceGroupName: string;
      virtualNetworkName: string;
      name: string;
      addressPrefix: string;
      serviceEndpoints?: string[];
      delegations?: Array<{ serviceName: string }>;
      privateEndpointNetworkPolicies?: "Enabled" | "Disabled";
      tags?: Record<string, string>;
    }) => Promise<any>;
    getSubnet: (rg: string, vnetName: string, name: string) => Promise<any>;
    createPrivateEndpoint: (args: {
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
    }) => Promise<any>;
    getPrivateEndpoint: (rg: string, name: string) => Promise<any>;
  };
  aks?: {
    createCluster: (args: {
      resourceGroupName: string;
      name: string;
      location: string;
      kubernetesVersion?: string;
      agentPoolProfiles: Array<{ name: string; count: number; vmSize: string; mode?: "System" | "User" }>;
      apiServerAccessProfile?: { enablePrivateCluster?: boolean };
      tags?: Record<string, string>;
    }) => Promise<any>;
    enableMonitoring?: (args: {
      resourceGroupName: string;
      clusterName: string;
      workspaceResourceGroup: string;
      workspaceName: string;
    }) => Promise<any>;
    get: (rg: string, name: string) => Promise<any>;
  };
}

export interface MakeAzureToolsOptions {
  clients: AzureClients;
  evaluateGovernance?: GovernanceFn;
  namespace?: string; // default: "azure."
}

export type { ToolDef, z };