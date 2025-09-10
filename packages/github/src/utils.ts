// packages/github-core/src/utils.ts
import type { ToolDef } from "mcp-http";
import { z } from "zod";

export function wrapCreate<T extends z.ZodObject<any>>(
  name: string,
  description: string,
  schema: T,
  handler: (args: z.infer<T>) => Promise<any>
): ToolDef {
  return {
    name,
    description,
    inputSchema: schema,
    handler: async (raw: any) => {
      const a = await schema.parseAsync(raw);
      const data = await handler(a as any);
      return { content: [{ type: "json", json: data }] };
    }
  };
}

export function wrapGet<T extends z.ZodObject<any>>(
  name: string,
  description: string,
  schema: T,
  handler: (args: z.infer<T>) => Promise<any>
): ToolDef {
  return wrapCreate(name, description, schema, handler);
}

export function wrapList<T extends z.ZodObject<any>>(
  name: string,
  description: string,
  schema: T,
  handler: (args: z.infer<T>) => Promise<any[]>
): ToolDef {
  return {
    name,
    description,
    inputSchema: schema,
    handler: async (raw: any) => {
      const a = await schema.parseAsync(raw);
      const items = await handler(a as any);
      return { content: [{ type: "json", json: items }] };
    }
  };
}

/**
 * Governance wrapper. If `evaluate` returns deny, short-circuit.
 * If `warn`, include a text warning but continue.
 */
export function withGovernance(td: ToolDef, evaluate?: (tool: string, args: any, ctx?: any) => Promise<any>): ToolDef {
  if (!evaluate) return td;
  return {
    ...td,
    handler: async (raw: any) => {
      const block = await evaluate(td.name, raw, { via: "github-core" });
      if (block?.decision === "deny") {
        return {
          content: [
            { type: "text", text: `❌ Denied by governance (${(block.policyIds || []).join(", ") || "policy"})` },
            { type: "json", json: block }
          ],
          isError: true
        };
      }
      const res = await td.handler(raw);
      if (block?.decision === "warn") {
        return {
          ...res,
          content: [
            { type: "text", text: `⚠️ Governance warning: ${(block.reasons || []).join("; ")}` },
            ...(res.content ?? [])
          ]
        };
      }
      return res;
    }
  };
}

export function withGovernanceAll(tds: ToolDef[], evaluate?: (tool: string, args: any, ctx?: any) => Promise<any>) {
  return tds.map((t) => withGovernance(t, evaluate));
}