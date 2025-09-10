import type { ToolDef } from "mcp-http";
import { registerPolicies, loadDefaultAzurePoliciesPlusATO, withGovernanceAll } from "@platform/governance-core";

// 1) Keep your existing files unchanged; we compose them here:
import { toolsEnsure } from "./tools.ensure.js";
import { toolsAlias } from "./tools.alias.js";
import { toolsScan } from "./tools.scan.js";
import { toolsWizards } from "./tools.onboarding.js";
import { remediationToolsDev } from "./tools.remediation.js";

// 2) Register the same Azure policy pack (extend if you add Dev-specific rules)
registerPolicies(loadDefaultAzurePoliciesPlusATO());

// 3) Optional: local governance debug tool for Developer MCP too
const tool_debug_governance_eval: ToolDef = {
  name: "developer.debug_governance_eval",
  description: "Evaluate governance locally (tool + args) and return the decision block.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tool", "args"],
    properties: {
      tool: { type: "string", minLength: 3 },
      args: { type: "object" }
    }
  },
  handler: async (a: { tool: string; args: any }) => {
    const { evaluate } = await import("@platform/governance-core");
    const block = evaluate(a.tool, a.args, { via: "developer.mcp" });
    return {
      content: [
        { type: "text", text: `Governance decision for ${a.tool}: ${block.decision}` },
        { type: "json", json: block }
      ]
    };
  }
};

// 4) Merge all your developer tools, then wrap with governance
const raw: ToolDef[] = [
  ...toolsAlias,
  ...toolsEnsure,
  ...toolsScan,
  ...toolsWizards,
  ...remediationToolsDev
];

const governed = withGovernanceAll(raw);

// 5) Export final tool list
export const tools: ToolDef[] = [...governed, tool_debug_governance_eval];