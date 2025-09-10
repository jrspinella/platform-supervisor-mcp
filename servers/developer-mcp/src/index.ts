import "dotenv/config";
import { startMcpHttpServer, type ToolDef } from "mcp-http";
import { makeAzureTools } from "@platform/azure-core";
import { makeGitHubTools } from "@platform/github-core";

// Assuming 'makeGitHubTools' is exported from '@platform/github-core'
import { evaluate as evaluateGovernanceSync } from "@platform/governance-core";
import { resClient, appClient, storageClient, kvClient, lawClient } from "./clients.js";

// Wrap the synchronous governance evaluator to match the expected async GovernanceFn interface
const evaluateGovernance = async (
  toolFq: string,
  args: any,
  context?: any
) => {
  return Promise.resolve(evaluateGovernanceSync(toolFq, args, context));
};

// your developer-specific tools
import { toolsEnsure } from "./tools.ensure.js";
import { toolsAlias as toolsAlias } from "./tools.alias.js";
import { toolsScan } from "./tools.scan.js";
import { toolsWizards } from "./tools.onboarding.js";
import { makeGitHubClients } from "../../platform-mcp/src/client.github.js";

const azureTools: ToolDef[] = makeAzureTools({
  clients: { resClient, appClient, storageClient, kvClient, lawClient },
  evaluateGovernance,
  namespace: "azure."
});

// GitHub — keep namespace `github.` for platform server
// build client providers (Azure clients likely already exist elsewhere)
const githubClients = makeGitHubClients();
const githubTools: ToolDef[] = makeGitHubTools({
  clients: githubClients,
  evaluateGovernance,
  namespace: "github."
});

const tools: ToolDef[] = [
  ...azureTools,
  ...githubTools,
  ...toolsEnsure,
  ...toolsAlias,
  ...toolsScan,
  ...toolsWizards
];

startMcpHttpServer({
  port: Number(process.env.PORT || 8717),
  name: "developer-mcp",
  tools
});
