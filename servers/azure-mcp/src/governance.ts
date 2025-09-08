// servers/azure-mcp/src/gov.ts
import type { ToolDef } from "mcp-http";

type GovDecision = "allow" | "warn" | "deny";
export type GovBlock = {
  decision: GovDecision;
  reasons?: string[];
  policyIds?: string[];
  suggestions?: Array<{ title?: string; text: string }>;
};

const GOV_URL = process.env.GOVERNANCE_URL || "http://127.0.0.1:8715/mcp";

const mjson = (json: any) => [{ type: "json" as const, json }];
const mtext = (text: string) => [{ type: "text" as const, text }];

async function postJsonRpc(url: string, method: string, params: any) {
  const body = { jsonrpc: "2.0", id: Date.now(), method, params };
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { ok: r.ok, status: r.status, json: JSON.parse(text) }; }
  catch { return { ok: r.ok, status: r.status, json: { raw: text } }; }
}

function firstJson(body: any) {
  const content = body?.result?.content;
  if (Array.isArray(content)) return content.find((c: any) => c.json)?.json;
  return null;
}

export async function evaluateGovernance(toolFq: string, args: any, context?: any): Promise<GovBlock> {  
  const { json } = await postJsonRpc(GOV_URL, "tools/call", {
    name: "governance.evaluate",
    arguments: { tool: toolFq, args, context: context || {} }
  });

  // Default, if governance is unreachable: allow
  const fj = firstJson(json);
  if (!fj) return { decision: "allow" };
  return fj as GovBlock;
}

/**
 * Wrap a ToolDef with governance preflight.
 * - Calls governance.evaluate(toolName, args)
 * - If deny => return isError with governance details
 * - If warn => append advisory text + governance json block
 * - If allow => pass-through
 */
export function withGovernance(def: ToolDef): ToolDef {
  // Ensure fully-qualified tool name (we expect azure.* here)
  const toolFq = def.name;

  return {
    ...def,
    handler: async (args: any) => {
      // Run governance preflight
      const ctx = (args && typeof args === "object" && "context" in args) ? (args as any).context : undefined;
      const gov = await evaluateGovernance(toolFq, args, ctx);

      if (gov.decision === "deny") {
        const reasons = gov.reasons?.join(" | ") || "Policy violation";
        const lines = [
          "Governance: **DENY**",
          gov.reasons?.length ? `Reasons: ${reasons}` : undefined,
          gov.suggestions?.length ? "Suggestions:" : undefined,
          ...(gov.suggestions || []).map(s => `- ${s.title ? `${s.title}: ` : ""}${s.text}`)
        ].filter(Boolean);

        return {
          isError: true,
          content: [
            ...mtext(`❌ Request denied by governance.\n\n${lines.join("\n")}`),
            ...mjson({ governance: gov })
          ]
        };
      }

      // Call the original tool handler
      const result = await def.handler!(args);

      // On warn, surface advisory content but still succeed
      if (gov.decision === "warn") {
        const reasons = gov.reasons?.join(" | ");
        const lines = [
          "⚠️ Governance advisory",
          reasons ? `Reasons: ${reasons}` : undefined,
          gov.suggestions?.length ? "Suggestions:" : undefined,
          ...(gov.suggestions || []).map(s => `- ${s.title ? `${s.title}: ` : ""}${s.text}`)
        ].filter(Boolean);

        // append advisory text + governance block to existing content
        return {
          ...result,
          content: [
            ...(result?.content || []),
            ...mtext(lines.join("\n")),
            ...mjson({ governance: gov })
          ]
        };
      }

      return result;
    }
  };
}

/**
 * Wrap all tools with governance, except those explicitly excluded.
 * Useful if you already have a big tools array and want one-liner wrapping.
 */
export function withGovernanceAll(tools: ToolDef[], exclude: string[] = []): ToolDef[] {
  const skip = new Set(exclude);
  return tools.map(def => (skip.has(def.name) ? def : withGovernance(def)));
}