import { ClientSecretCredential, AzureAuthorityHosts } from "@azure/identity";
import { ResourceManagementClient } from "@azure/arm-resources";
import { StorageManagementClient } from "@azure/arm-storage";
import { AuthorizationManagementClient } from "@azure/arm-authorization";
import { KeyVaultManagementClient } from "@azure/arm-keyvault";
import { WebSiteManagementClient } from "@azure/arm-appservice";
import { ContainerServiceClient } from "@azure/arm-containerservice";

/**
* Creates Azure management-plane clients for Public or US Gov cloud.
* Env hints (optional):
* AZURE_CLOUD=AzureUSGovernment | Public
* AZURE_RESOURCE_MANAGER_ENDPOINT=https://management.usgovcloudapi.net | https://management.azure.com
* AZURE_RESOURCE_MANAGER_SCOPE=https://management.usgovcloudapi.net/.default | https://management.azure.com/.default
*/
export function makeAzureClients(params: {
tenantId: string; clientId: string; clientSecret: string; subscriptionId: string; cloud?: "Public" | "AzureUSGovernment";
}) {
const cloud = (params.cloud ?? (process.env.AZURE_CLOUD as any) ?? "Public") as "Public" | "AzureUSGovernment";
const authorityHost = cloud === "AzureUSGovernment" ? AzureAuthorityHosts.AzureGovernment : AzureAuthorityHosts.AzurePublicCloud;


const cred = new ClientSecretCredential(params.tenantId, params.clientId, params.clientSecret, { authorityHost });


const armEndpoint = process.env.AZURE_RESOURCE_MANAGER_ENDPOINT || (cloud === "AzureUSGovernment" ? "https://management.usgovcloudapi.net" : "https://management.azure.com");
const armScope = process.env.AZURE_RESOURCE_MANAGER_SCOPE || (cloud === "AzureUSGovernment" ? "https://management.usgovcloudapi.net/.default" : "https://management.azure.com/.default");
const clientOptions: any = { endpoint: armEndpoint, credentialScopes: armScope };


const resources = new ResourceManagementClient(cred, params.subscriptionId, clientOptions);
const storage = new StorageManagementClient(cred, params.subscriptionId, clientOptions);
const authorization = new AuthorizationManagementClient(cred, params.subscriptionId, clientOptions);
const keyvault = new KeyVaultManagementClient(cred, params.subscriptionId, clientOptions);
const web = new WebSiteManagementClient(cred, params.subscriptionId, clientOptions);
const containerservice = new ContainerServiceClient(cred, params.subscriptionId, clientOptions);

  return { resources, storage, authorization, keyvault, web, containerservice };
}