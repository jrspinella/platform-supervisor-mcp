// Factory that returns the Azure client adapters expected by @platform/azure-core tools.
// If you already ship an adapter in your monorepo, import it here and return its clients.

export async function createAzureClientsFromEnv() {
  // Try to load your shared adapter first (preferred)
  try {
    const mod = await import('@platform/azure-core');
    if (mod?.createAzureSdkClients) return await mod.createAzureSdkClients();
  } catch {}

  // Fallback: minimal stub that throws when used (compiles, prompts configuration)
  const notConfigured = () => { throw new Error('Azure clients not configured. Provide @platform/azure-core or update clients.azure.js'); };
  return {
    resourceGroups: { create: notConfigured, get: notConfigured },
    appServicePlans: { create: notConfigured, get: notConfigured, update: notConfigured },
    webApps: { create: notConfigured, get: notConfigured, update: notConfigured, updateConfiguration: notConfigured, enableSystemAssignedIdentity: notConfigured, setAppSettings: notConfigured },
    keyVaults: { create: notConfigured, get: notConfigured, update: notConfigured, setNetworkRules: notConfigured },
    storageAccounts: { create: notConfigured, get: notConfigured, update: notConfigured, setNetworkRules: notConfigured },
    logAnalytics: { create: notConfigured, get: notConfigured },
    networks: { createVnet: notConfigured, getVnet: notConfigured, createSubnet: notConfigured, getSubnet: notConfigured, createPrivateEndpoint: notConfigured, getPrivateEndpoint: notConfigured },
    monitor: { diagnosticSettings: { list: notConfigured, createOrUpdate: notConfigured } },
    aks: { createCluster: notConfigured, enableMonitoring: notConfigured, get: notConfigured }
  };
}
