import { DefaultAzureCredential, AzureAuthorityHosts } from "@azure/identity";
import { ResourceManagementClient } from "@azure/arm-resources";
import { WebSiteManagementClient } from "@azure/arm-appservice";
import { KeyVaultManagementClient } from "@azure/arm-keyvault";
import { NetworkManagementClient } from "@azure/arm-network";
import { StorageManagementClient } from "@azure/arm-storage";
import { OperationalInsightsManagementClient } from "@azure/arm-operationalinsights";
import { MonitorClient } from "@azure/arm-monitor";

const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
if (!subscriptionId) {
  throw new Error("AZURE_SUBSCRIPTION_ID is not set. Export it for the azure-mcp process.");
}

const ARM_ENDPOINT = process.env.ARM_ENDPOINT || "https://management.usgovcloudapi.net";
const ARM_SCOPE    = process.env.ARM_SCOPE    || `${ARM_ENDPOINT}/.default`;

export function makeCredential() {
  return new DefaultAzureCredential({
    authorityHost: AzureAuthorityHosts.AzureGovernment, // <- critical
  });
}

export const credential = makeCredential();

export const resClient     = new ResourceManagementClient(credential, subscriptionId, {endpoint: ARM_ENDPOINT, credentialScopes: [ARM_SCOPE]});
export const appClient     = new WebSiteManagementClient(credential, subscriptionId, {endpoint: ARM_ENDPOINT, credentialScopes: [ARM_SCOPE]});
export const kvClient      = new KeyVaultManagementClient(credential, subscriptionId, {endpoint: ARM_ENDPOINT, credentialScopes: [ARM_SCOPE]});
export const netClient     = new NetworkManagementClient(credential, subscriptionId, {endpoint: ARM_ENDPOINT, credentialScopes: [ARM_SCOPE]});
export const storageClient = new StorageManagementClient(credential, subscriptionId, {endpoint: ARM_ENDPOINT, credentialScopes: [ARM_SCOPE]});
export const lawClient     = new OperationalInsightsManagementClient(credential, subscriptionId, {endpoint: ARM_ENDPOINT, credentialScopes: [ARM_SCOPE]});
export const monitorClient = new MonitorClient(credential, subscriptionId, {endpoint: ARM_ENDPOINT, credentialScopes: [ARM_SCOPE]});

export const subId = subscriptionId;

export function planId(rg: string, plan: string) {
  return `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Web/serverfarms/${plan}`;
}
export function subnetId(rg: string, vnet: string, subnet: string) {
  return `/subscriptions/${subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Network/virtualNetworks/${vnet}/subnets/${subnet}`;
}

/** Best-effort: resolve an API version for a given resourceId using Provider metadata */
export async function resolveApiVersionById(id: string): Promise<string | undefined> {
  // /.../providers/Microsoft.Foo/type1/type2/...
  const providerMatch = id.match(/\/providers\/([^\/]+)\/(.+)/i);
  const providerNs = providerMatch?.[1];
  const remainder  = providerMatch?.[2]?.replace(/\/+$/, "") || "";
  if (!providerNs || !remainder) return undefined;

  // full type e.g. "Microsoft.Web/sites/config"
  const fullType = `${providerNs}/${remainder}`.split("/").slice(0, 3).join("/");

  // Provider info
  const prov = await resClient.providers.get(providerNs);
  const rts = prov.resourceTypes ?? [];

  // Pick longest resourceType that prefixes our type
  let best: { resourceType?: string; apiVersions?: string[] } | undefined;
  for (const rt of rts) {
    if (!rt.resourceType) continue;
    const full = `${providerNs}/${rt.resourceType}`.toLowerCase();
    if (fullType.toLowerCase().startsWith(full)) {
      if (!best || (rt.resourceType!.length > (best.resourceType?.length ?? 0))) {
        best = rt;
      }
    }
  }
  return best?.apiVersions?.[0];
}
