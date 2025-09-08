import "dotenv/config";
import { startMcpHttpServer, type ToolDef } from "mcp-http";

import { toolsEnsure } from "./tools.ensure.js";
import { toolsScan } from "./tools.scan.js";
import { toolsOnboarding } from "./tools.onboarding.js";
import { toolsAlias } from "./tools.alias.js";

const PORT = Number(process.env.PORT ?? 8716);

const tools: ToolDef[] = [
  // simple debug utility
  {
    name: "platform.debug_echo",
    description: "Echo back whatever arguments I receive (debug).",
    inputSchema: { type: "object", additionalProperties: true },
    handler: async (args: any) => ({ content: [{ type: "json", json: { received: args } }] })
  },

  // Ensure / create wrappers (forward to router→azure/github etc.)
  ...toolsEnsure,

  // Scanners (ATO coaching/advisories come from Governance MCP when Azure/GitHub MCPs evaluate)
  ...toolsScan,

  // Onboarding NL executor (delegates to onboarding MCP through router)
  ...toolsOnboarding,

  // Convenience natural-language aliases that remap arguments into ensure tools
  ...toolsAlias
];

console.log(`[MCP] platform-mcp listening on :${PORT}`);
startMcpHttpServer({ name: "platform-mcp", version: "0.1.0", port: PORT, tools });
