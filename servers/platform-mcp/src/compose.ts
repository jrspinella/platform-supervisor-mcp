// servers/platform-mcp/src/compose.ts
import type { ToolDef } from "mcp-http";
import { z } from "zod";

// Local packages
import { makeAzureTools } from "@platform/azure-core";
import { makeGitHubTools } from "@platform/github-core";

// governance-core
import {
  registerPolicies,
  loadPoliciesFromYaml,
  withGovernanceAll,
  getPolicyDoc
} from "@platform/governance-core";

// Local clients & wrappers
import { clients } from "./clients.azure.js";
import { makeGitHubClients } from "./client.github.js";
import { makeEnsureTools } from "./tools.azure.ensure.js";
import { makeAliasTools } from "./tools.alias.js";
import { makeScanTools } from "./tools.scan.js";
import { makeRemediationTools } from "./tools.remediation.js";
import { makeOnboardingTools } from "./tools.wizards.js";

// The local call signature the wrappers expect
export type CallFn = (name: string, args: any) => Promise<any>;

// ──────────────────────────────────────────────────────────────────────────────
// Governance: Load YAML once (robust path handling)
// ──────────────────────────────────────────────────────────────────────────────
function resolvePolicyPaths(): string[] {
  const fromEnv = process.env.GOVERNANCE_POLICIES
    ?.split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (fromEnv && fromEnv.length) return fromEnv;

  const base = (process.env.GOVERNANCE_POLICY_DIR || process.cwd() + "/policies").replace(/\/+$/, "");
  return [
    `${base}/policy.yaml`,
    `${base}/ato.yaml`
  ];
}

const mergedPolicyDoc = loadPoliciesFromYaml(resolvePolicyPaths());
registerPolicies(mergedPolicyDoc);

// ──────────────────────────────────────────────────────────────────────────────
// Build base toolsets (azure.*, github.*)
// ──────────────────────────────────────────────────────────────────────────────
const azureTools: ToolDef[] = makeAzureTools({ clients, namespace: "azure." });
const githubTools: ToolDef[] = makeGitHubTools({
  clients: makeGitHubClients(),
  namespace: "github."
});

const baseTools: ToolDef[] = [...azureTools, ...githubTools];

// ──────────────────────────────────────────────────────────────────────────────
// Local invoker so platform.* wrappers call azure.* / github.* locally
// ──────────────────────────────────────────────────────────────────────────────
function makeLocalInvoker(all: ToolDef[]) {
  const map = new Map(all.map(t => [t.name, t]));
  return async (name: string, args: any) => {
    const def = map.get(name);
    if (!def) {
      return {
        content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
        inputSchema: z.any(),
        isError: true
      };
    }
    try {
      return await def.handler(args);
    } catch (e: any) {
      return {
        content: [{ type: "text" as const, text: `Error in ${name}: ${e?.message || String(e)}` }],
        inputSchema: z.any(),
        isError: true
      };
    }
  };
}

const call = makeLocalInvoker(baseTools);

// ──────────────────────────────────────────────────────────────────────────────
// Build platform.* wrappers (NO RECURSION) and wrap with governance
// ──────────────────────────────────────────────────────────────────────────────
function buildPlatformWrappers(callFn: CallFn): ToolDef[] {
  const rawPlatform: ToolDef[] = [
    ...makeEnsureTools(callFn),
    ...makeAliasTools(callFn),
    ...makeScanTools(callFn),
    ...makeRemediationTools(callFn),
    ...makeOnboardingTools(callFn)
  ];
  // Apply governance to platform.* only
  return withGovernanceAll(rawPlatform);
}

// Debug helpers (not governed)
const tool_policy_dump: ToolDef = {
  name: "platform.policy_dump",
  description: "Return the currently loaded governance policies (merged YAML).",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  handler: async () => ({ content: [{ type: "json", json: getPolicyDoc() }] })
};

const tool_debug_governance_eval: ToolDef = {
  name: "platform.debug_governance_eval",
  description: "Evaluate governance (tool+args) and return the decision block.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tool", "args"],
    properties: { tool: { type: "string" }, args: { type: "object" } }
  },
  handler: async (a: { tool: string; args: any }) => {
    const { evaluate } = await import("@platform/governance-core");
    const block = evaluate(a.tool, a.args, { via: "platform.mcp" });
    return {
      content: [
        { type: "text", text: `Governance decision for ${a.tool}: ${block.decision}` },
        { type: "json", json: block }
      ]
    };
  }
};

// Final export: base tools + governed platform wrappers + debug
const platformTools = buildPlatformWrappers(call);
export const allTools: ToolDef[] = [
  ...baseTools,                 // optional: expose azure.* and github.* directly
  ...platformTools,             // governed platform.* wrappers
  tool_policy_dump,
  tool_debug_governance_eval
];