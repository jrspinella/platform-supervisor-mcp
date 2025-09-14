// servers/platform-mcp/src/tools/tools.ato.ts
import type { ToolDef } from "mcp-http";
import { dumpAto } from "@platform/governance-core";

export function makeAtoTools(): ToolDef[] {
  return [
    {
      name: "ato.dump_profiles",
      description: "Dump loaded ATO profiles (resolved from env / defaults).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        const profiles = dumpAto();
        return {
          content: [
            { type: "text", text: "### ATO — loaded profiles\n" },
            { type: "json", json: profiles },
          ],
        };
      },
    },
  ];
}