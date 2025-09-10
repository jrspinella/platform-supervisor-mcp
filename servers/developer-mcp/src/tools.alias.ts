import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { callRouterTool, firstJson, mcpJson, mcpText, pendingPlanText } from "./lib/runtime.js";

/**
 * “Alias” tools = tiny NL helpers that remap params and still honor plan/confirm.
 * These call our higher-level developer.* tools directly so behavior matches Platform MCP.
 */

/** generic alias wrapper */
function makeAlias(opts: {
  name: string;
  description: string;
  target: string; // developer.* target tool
  schema: z.ZodObject<any>;
  toArgs: (raw: any) => any;
  showPlan?: (raw: any) => string[];
}): ToolDef {
  const s = opts.schema.extend({
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  });

  return {
    name: opts.name,
    description: opts.description,
    inputSchema: s,
    handler: async (raw) => {
      const args = opts.toArgs(raw);
      if (!raw.confirm || raw.dryRun) {
        const bullets = opts.showPlan
          ? opts.showPlan(raw)
          : Object.entries(args).map(([k, v]) => `**${k}:** ${typeof v === "string" ? v : JSON.stringify(v)}`);
        return {
          content: [
            ...mcpJson({ status: "pending", plan: { action: opts.target, payload: args, mode: raw.dryRun ? "dryRun" : "review" } }),
            ...mcpText(pendingPlanText({
              title: opts.target,
              bullets,
              followup: `@developer ${opts.name} ${Object.entries(args).map(([k, v]) => `${k} "${v}"`).join(" ")} confirm true`,
              askProceed: true,
            })),
          ]
        };
      }

      const r = await callRouterTool(opts.target, args);
      if (!r.ok) {
        return { content: [...mcpText(`❌ ${opts.name} failed: ${JSON.stringify(r.body).slice(0, 800)}`)], isError: true };
      }
      const j = firstJson(r.body) ?? r.body;
      return { content: [...mcpJson(j), ...mcpText(`✅ ${opts.name} completed.`)] };
    }
  };
}

export const toolsAlias: ToolDef[] = [
  // Example: developer.rg_create_resource_group_alias -> developer.create_resource_group
  makeAlias({
    name: "developer.rg_create_resource_group_alias",
    description: "Alias: Create an Azure resource group (name/location/tags).",
    target: "developer.create_resource_group",
    schema: z.object({
      name: z.string(),
      location: z.string(),
      tags: z.any().optional(),
    }),
    toArgs: a => ({ name: a.name, location: a.location, tags: a.tags }),
    showPlan: a => [
      `**Name:** ${a.name}`,
      `**Location:** ${a.location}`,
      `**Tags:** \`${JSON.stringify(a.tags || {})}\``
    ],
  }),
];