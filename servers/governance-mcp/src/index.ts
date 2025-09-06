import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";
import { evaluate, loadPoliciesFlexible } from "./engine.js";
import path from "node:path";

const PORT = Number(process.env.PORT ?? 8715);

const evalSchema = z.object({
  tool: z.string(),    // e.g. "azure.create_resource_group"
  args: z.any(),
  context: z.object({
    env: z.string().optional(),
    upn: z.string().optional(),
    alias: z.string().optional(),
  }).optional(),
}).strict();

const tools = [
  {
    name: "governance.debug_config",
    description: "Show governance loader info",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const dir = process.env.GOVERNANCE_RULES_DIR || path.resolve(process.cwd(), "governance");
      const policies = loadPoliciesFlexible();
      return { content: [{ type: "json" as const, json: { dir, policyCount: policies.length } }] };
    }
  },
  {
    name: "governance.dump_policies",
    description: "Dump compiled policies after YAML/JSON load",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const policies = loadPoliciesFlexible();
      return { content: [{ type: "json" as const, json: policies }] };
    }
  },
  {
    name: "governance.evaluate",
    description: "Evaluate a tool call against governance/ATO policies.",
    inputSchema: evalSchema,
    handler: async (a: z.infer<typeof evalSchema>) => {
      const out = evaluate(a.tool, a.args);
      return { content: [{ type: "json" as const, json: out }] };
    }
  },
  {
    name: "governance.ping",
    description: "Health check",
    inputSchema: z.object({}).strict(),
    handler: async () => ({ content: [{ type: "json" as const, json: { ok: true } }] })
  },
  {
    name: "governance.generate_oscal_snapshot",
    description: "Create a minimal OSCAL-like JSON snapshot from executed steps.",
    inputSchema: z.object({
      steps: z.array(z.object({
        tool: z.string(),
        args: z.any(),
        result: z.any().optional()
      }))
    }).strict(),
    handler: async (a: { steps: any[]; }) => {
      const snapshot = {
        system: { name: "Navy Platform System", timestamp: new Date().toISOString() },
        implementedRequirements: a.steps.map(s => ({
          tool: s.tool,
          satisfiedControls: [],
        })),
      };
      return { content: [{ type: "json" as const, json: snapshot }] };
    }
  },
  {
    name: "governance.export_evidence_bundle",
    description: "Return a simple evidence bundle (JSON) you can later zip/store.",
    inputSchema: z.object({
      items: z.array(z.object({ name: z.string(), blob: z.any() }))
    }).strict(),
    handler: async (a: { items: { name: string; blob: any; }[]; }) => ({ content: [{ type: "json" as const, json: { ok: true, count: a.items.length } }] })
  }
];

console.log(`[MCP] governance-mcp listening on :${PORT}`);
startMcpHttpServer({ name: "governance-mcp", version: "0.1.0", port: PORT, tools });