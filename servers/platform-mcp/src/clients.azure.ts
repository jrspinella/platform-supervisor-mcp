// servers/platform-mcp/src/clients.azure.ts
import { createAzureSdkClients, ensureAzureCloudEnv } from "@platform/azure-core";
import type { AzureClients } from "@platform/azure-core";
import "dotenv/config";
/**
 * Creates Azure SDK clients using DefaultAzureCredential.
 * Requires at minimum: AZURE_SUBSCRIPTION_ID
 * Optional (strongly recommended for US Gov): AZURE_CLOUD=AzureUSGovernment
 *
 * Credentials picked by DefaultAzureCredential:
 * - Azure CLI (az login), or
 * - Service principal (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET)
 */
export async function createAzureClientsFromEnv(): Promise<AzureClients> {
  // Set ARM + authority hosts from cloud (Public by default;
  // you can export AZURE_CLOUD=AzureUSGovernment to switch)
  ensureAzureCloudEnv();

  const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID;
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  if (!subscriptionId) {
    throw new Error("AZURE_SUBSCRIPTION_ID is required to create Azure clients");
  }

  return createAzureSdkClients({
    subscriptionId,
    // Optional: custom user-agent prefix for easier tracking in Azure logs
    userAgentPrefix: "platform-mcp",
  }) as unknown as AzureClients;
}