import { evaluate as defaultEvaluate } from "./evaluate.js";
const mcpText = (text) => [{ type: "text", text }];
const mcpJson = (json) => [{ type: "json", json }];
export function withGovernanceAll(tools, evaluateFn = defaultEvaluate) {
    return tools.map((t) => withGovernance(t, evaluateFn));
}
export function withGovernance(tool, evaluateFn = defaultEvaluate) {
    const h = tool.handler;
    return {
        ...tool,
        async handler(args) {
            const decision = await Promise.resolve(evaluateFn(tool.name, args, args?.context ?? {}));
            if (decision.decision === "allow")
                return h(args);
            const header = decision.decision === "deny" ? "🚫 Governance: DENY" : "⚠️ Governance: WARN";
            const reasons = (decision.reasons ?? []).map((r) => `- ${r}`).join("\n") || "- (no reasons)";
            const sugg = (decision.suggestions ?? [])
                .map((s) => (s.title ? `- **${s.title}:** ${s.text}` : `- ${s.text}`))
                .join("\n");
            const controls = decision.controls?.length ? `\n**NIST Controls:** ${decision.controls.join(", ")}` : "";
            const text = `${header} — ${tool.description ?? tool.name}\n**Reasons:**\n${reasons}\n${sugg ? `\n**Suggestions:**\n${sugg}\n` : ""}${controls}`.trim();
            return {
                content: [
                    ...mcpJson({ status: decision.decision, governance: decision }),
                    ...mcpText(text),
                ],
                isError: decision.decision === "deny",
            };
        },
    };
}
