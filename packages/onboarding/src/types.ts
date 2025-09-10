import type { z } from "zod";

/** Minimal MCP surface used across your servers */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "json"; json: any };

export type McpResult = {
  content: McpContent[];
  isError?: boolean;
};

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: any) => Promise<McpResult>;
};

export type CallToolFn = (name: string, args: any) => Promise<McpResult>;

export type EvaluateGovernanceFn = (
  fqToolName: string,
  args: any,
  context?: any
) => Promise<{
  decision: "allow" | "warn" | "deny";
  reasons?: string[];
  policyIds?: string[];
  suggestions?: Array<{ title?: string; text: string }>;
}>;

/** Execution Plan */
export type PlanStep = {
  id: string;
  title: string;
  tool: string;   // e.g., "azure.create_aks_cluster"
  args: any;
};

export type Plan = {
  summary: string;
  steps: PlanStep[];
  continueOnError?: boolean;
};

/** Package options */
export type MakeOnboardingToolsOptions = {
  call: CallToolFn;
  evaluateGovernance: EvaluateGovernanceFn;
  namespace?: string;          // defaults to "onboarding."
  /** Directory where YAML templates are stored. Defaults to process.env.ONBOARDING_TEMPLATES_DIR || "<cwd>/templates" */
  templatesDir?: string;
};