import { z } from "zod";
import type { ToolDef } from "mcp-http";

export function makeDeveloperPolicyTools(): ToolDef[] {
  const dump: ToolDef = {
    name: "developer.policy_dump",
    description: "Dump Developer MCP config & defaults (env knobs).",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const json = {
        status: "ok",
        platformUrl: process.env.PLATFORM_URL || "http://127.0.0.1:8721/rpc",
        github: {
          org: process.env.GITHUB_ORG || null,
          defaultBranch: process.env.GITHUB_DEFAULT_BRANCH || "main",
          defaultVisibility: process.env.GITHUB_DEFAULT_VISIBILITY || "private",
          tokenPresent: Boolean(process.env.GITHUB_TOKEN),
        },
        azure: {
          defaultLocation: "usgovvirginia",
          atoProfile: process.env.ATO_PROFILE || "default",
        },
        endpoints: {
          developerUrl: process.env.DEVELOPER_URL || `http://127.0.0.1:${process.env.DEVELOPER_PORT||8731}${process.env.DEVELOPER_PATH||"/rpc"}`,
        }
      };
      const lines = [
        "### Developer MCP — Config",
        "",
        `- Platform URL: \`${json.platformUrl}\``,
        `- GitHub Org: \`${json.github.org ?? "(not set)"}\``,
        `- GitHub Default Branch: \`${json.github.defaultBranch}\``,
        `- GitHub Default Visibility: \`${json.github.defaultVisibility}\``,
        `- GitHub Token: ${json.github.tokenPresent ? "✅ present" : "❌ missing"}`,
        `- Azure Default Location: \`${json.azure.defaultLocation}\``,
        `- ATO Profile: \`${json.azure.atoProfile}\``,
      ].join("\n");
      return { content: [{ type: "text", text: lines }, { type: "json", json }] };
    }
  };

  return [dump];
}