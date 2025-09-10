// packages/github-core/src/types.ts
import type { ToolDef } from "mcp-http";
import type { z } from "zod";

export interface GitHubClients {
  /**
   * Return a ready-to-use Octokit instance for a given owner/org scope.
   * The object MUST expose `.rest` with GitHub REST APIs and `.paginate` helper.
   */
  getOctoClient: (ownerOrOrg: string) => Promise<{
    rest: any;
    paginate: (fn: any, params: Record<string, any>) => Promise<any[]>;
  }>;
}

export type GovernanceFn = (
  toolFq: string,
  args: any,
  context?: any
) => Promise<{
  decision: "allow" | "warn" | "deny";
  reasons?: string[];
  suggestions?: Array<{ title?: string; text: string }>;
  policyIds?: string[];
}>;

export interface MakeGitHubToolsOptions {
  clients: GitHubClients;
  evaluateGovernance?: GovernanceFn;
  namespace?: string; // default "github."
}

export type { ToolDef, z };