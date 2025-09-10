// servers/developer-mcp/src/clients.ts
// Reuse the same concrete Azure adapters as platform-mcp to avoid drift.
export {
  resClient,
  appClient,
  storageClient,
  kvClient,
  lawClient,
} from "../../platform-mcp/src/clients.azure.js";

export { makeGitHubClients } from "../../platform-mcp/src/client.github.js";