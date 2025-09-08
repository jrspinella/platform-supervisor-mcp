// servers/governance-mcp/src/index.ts
import "dotenv/config";
import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";
import { evaluate, loadPoliciesFlexible, debugConfig } from "./engine.js";

const PORT = Number(process.env.PORT ?? 8715);

const evalSchema = z.object({
  tool: z.string(),   // fully-qualified, e.g. "azure.create_resource_group" or "ato.workload.web_app"
  args: z.any(),
  context: z.object({
    env: z.string().optional(),
    upn: z.string().optional(),
    alias: z.string().optional(),
  }).optional(),
}).strict();

const oscalSchema = z.object({
  steps: z.array(z.object({
    tool: z.string(),
    args: z.any(),
    result: z.any().optional()
  }))
}).strict();

const evidenceSchema = z.object({
  items: z.array(z.object({
    name: z.string(),
    blob: z.any()
  }))
}).strict();

const tools = [
  {
    name: "governance.ping",
    description: "Health check",
    inputSchema: z.object({}).strict(),
    handler: async () => ({ content: [{ type: "json" as const, json: { ok: true } }] })
  },
  {
    name: "governance.debug_config",
    description: "Return rules directory and compiled policy count.",
    inputSchema: z.object({}).strict(),
    handler: async () => ({ content: [{ type: "json" as const, json: debugConfig() }] })
  },
  {
    name: "governance.dump_policies",
    description: "Dump all compiled policies (after YAML/JSON load).",
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
  // Optional helpers
  {
    name: "governance.generate_oscal_snapshot",
    description: "Return a minimal OSCAL-like JSON snapshot from executed steps.",
    inputSchema: oscalSchema,
    handler: async (a: z.infer<typeof oscalSchema>) => {
      const snapshot = {
        system: { name: "Navy Platform System", timestamp: new Date().toISOString() },
        implementedRequirements: a.steps.map(s => ({
          tool: s.tool,
          satisfiedControls: [] // extend by mapping evaluate(s.tool,s.args) to control IDs if you embed them
        }))
      };
      return { content: [{ type: "json" as const, json: snapshot }] };
    }
  },
  {
    name: "governance.export_evidence_bundle",
    description: "Return a simple evidence bundle (opaque JSON) you can zip/store elsewhere.",
    inputSchema: evidenceSchema,
    handler: async (a: z.infer<typeof evidenceSchema>) => ({ content: [{ type: "json" as const, json: { ok: true, count: a.items.length } }] })
  }
];

console.log(`[MCP] governance-mcp listening on :${PORT} | rules=${process.env.GOVERNANCE_RULES_DIR || "governance/"}`);
startMcpHttpServer({ name: "governance-mcp", version: "0.1.0", port: PORT, tools });
