// packages/azure-core/src/cloud.ts
// Minimal cloud-awareness helpers for sovereign clouds (AzureUSGovernment, etc.)

export type AzureCloudName =
  | 'AzurePublicCloud'
  | 'AzureUSGovernment'
  | 'AzureChinaCloud'
  | 'AzureGermanCloud';

export type AzureCloudConfig = {
  name: AzureCloudName;
  authorityHost: string;
  armEndpoint: string;
  keyVaultDnsSuffix?: string;
  storageEndpointSuffix?: string;
};

const CLOUDS: Record<AzureCloudName, AzureCloudConfig> = {
  AzurePublicCloud: {
    name: 'AzurePublicCloud',
    authorityHost: 'https://login.microsoftonline.com',
    armEndpoint: 'https://management.azure.com',
    keyVaultDnsSuffix: '.vault.azure.net',
    storageEndpointSuffix: 'core.windows.net',
  },
  AzureUSGovernment: {
    name: 'AzureUSGovernment',
    authorityHost: 'https://login.microsoftonline.us',
    armEndpoint: 'https://management.usgovcloudapi.net',
    keyVaultDnsSuffix: '.vault.usgovcloudapi.net',
    storageEndpointSuffix: 'core.usgovcloudapi.net',
  },
  AzureChinaCloud: {
    name: 'AzureChinaCloud',
    authorityHost: 'https://login.chinacloudapi.cn',
    armEndpoint: 'https://management.chinacloudapi.cn',
    keyVaultDnsSuffix: '.vault.azure.cn',
    storageEndpointSuffix: 'core.chinacloudapi.cn',
  },
  AzureGermanCloud: {
    name: 'AzureGermanCloud',
    authorityHost: 'https://login.microsoftonline.de',
    armEndpoint: 'https://management.microsoftazure.de',
    keyVaultDnsSuffix: '.vault.microsoftazure.de',
    storageEndpointSuffix: 'core.cloudapi.de',
  },
};

/** Resolve cloud from env; defaults to Public. Supports AZURE_CLOUD or AZURE_ENVIRONMENT. */
export function resolveAzureCloudFromEnv(): AzureCloudConfig {
  const name = (process.env.AZURE_CLOUD || process.env.AZURE_ENVIRONMENT || 'AzureUSGovernment') as AzureCloudName;
  return CLOUDS[name] || CLOUDS.AzurePublicCloud;
}

/** Ensure env vars for identity + ARM are set based on cloud; returns the config used. */
export function ensureAzureCloudEnv(cfg?: Partial<AzureCloudConfig>): AzureCloudConfig {
  const base = resolveAzureCloudFromEnv();
  const merged: AzureCloudConfig = {
    name: (cfg?.name as AzureCloudName) || base.name,
    authorityHost: cfg?.authorityHost || base.authorityHost,
    armEndpoint: cfg?.armEndpoint || base.armEndpoint,
    keyVaultDnsSuffix: cfg?.keyVaultDnsSuffix || base.keyVaultDnsSuffix,
    storageEndpointSuffix: cfg?.storageEndpointSuffix || base.storageEndpointSuffix,
  };
  if (!process.env.AZURE_AUTHORITY_HOST) process.env.AZURE_AUTHORITY_HOST = merged.authorityHost;
  if (!process.env.ARM_ENDPOINT) process.env.ARM_ENDPOINT = merged.armEndpoint;
  return merged;
}

/** ARM base URI for management clients (maps to options.baseUri). */
export function getArmBaseUri(cfg?: AzureCloudConfig): string {
  const c = cfg || resolveAzureCloudFromEnv();
  return process.env.ARM_ENDPOINT || c.armEndpoint;
}

/** Options object that works across ARM SDKs (some expect baseUri, some endpoint). */
export function armClientOptions(cfg?: AzureCloudConfig): Record<string, any> {
  const baseUri = getArmBaseUri(cfg);
  return { baseUri, endpoint: baseUri } as Record<string, any>;
}

/** Snapshot for diagnostics or tool output. */
export function azureCloudInfo(): Pick<AzureCloudConfig, 'name' | 'authorityHost' | 'armEndpoint'> {
  const c = resolveAzureCloudFromEnv();
  return {
    name: c.name,
    authorityHost: process.env.AZURE_AUTHORITY_HOST || c.authorityHost,
    armEndpoint: process.env.ARM_ENDPOINT || c.armEndpoint,
  };
}
