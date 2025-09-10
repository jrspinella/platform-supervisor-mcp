import type { ToolDef } from "mcp-http";
import type { DecisionBlock } from "./types.js";
import { evaluate as defaultEvaluate } from "./evaluate.js";

export function withGovernance(
  tool: ToolDef,
  evaluateFn: (toolFq: string, args: any, ctx?: any) => Promise<DecisionBlock> | DecisionBlock = defaultEvaluate
): ToolDef {
  return {
    ...tool,
    handler: async (args: any) => {
      const decision = await Promise.resolve(evaluateFn(tool.name, args, args?.context ?? {}));
      if (decision.decision === "allow") return tool.handler(args);

      const header = decision.decision === "deny" ? "🚫 Governance: DENY" : "⚠️ Governance: WARN";
      const reasons = (decision.reasons ?? []).map(r => `- ${r}`).join("\n") || "- (no reasons)";
      const sugg = (decision.suggestions ?? []).map(s =>
        s.title ? `- **${s.title}:** ${s.text}` : `- ${s.text}`
      ).join("\n");
      const controls = decision.controls?.length ? `\n**NIST Controls:** ${decision.controls.join(", ")}` : "";

      const text =
`${header} — ${tool.description}
**Reasons:**
${reasons}
${sugg ? `\n**Suggestions:**\n${sugg}\n` : ""}
${controls}`.trim();

      return {
        content: [
          { type: "json", json: { status: decision.decision, governance: decision } },
          { type: "text", text }
        ],
        isError: decision.decision === "deny"
      };
    }
  };
}

export function withGovernanceAll(
  tools: ToolDef[],
  evaluateFn?: (toolFq: string, args: any, ctx?: any) => Promise<DecisionBlock> | DecisionBlock
): ToolDef[] {
  return tools.map(t => withGovernance(t, evaluateFn as any));
}