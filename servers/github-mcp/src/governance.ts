import { mcpJson } from "./tools.js";

export type GovResult = {
  decision: "allow" | "warn" | "deny";
  reasons?: string[];
  policyIds?: string[];
  suggestions?: Array<{ title?: string; text: string }>;
};

export async function governanceEvaluate(toolFq: string, args: any, context?: any): Promise<GovResult> {
  const url = process.env.GOVERNANCE_URL || "http://127.0.0.1:8715";
  const r = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: "governance.evaluate", arguments: { tool: toolFq, args, context: context || {} } }
    })
  });

  const body = await r.json().catch(() => ({}));
  const content = body?.result?.content;
  const json = Array.isArray(content) ? content.find((c: any) => c.json)?.json : null;
  return json || { decision: "allow" };
}

export function denyToMcpError(gr: GovResult) {
  return {
    content: mcpJson({
      status: "denied",
      reasons: gr.reasons || [],
      suggestions: gr.suggestions || []
    }),
    isError: true as const
  };
}
