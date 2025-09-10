export type Decision = "allow" | "warn" | "deny";

export interface Suggestion {
  title?: string;
  text: string;
}

export interface DecisionBlock {
  decision: Decision;
  reasons?: string[];
  suggestions?: Suggestion[];
  controls?: string[];      // NIST control IDs (e.g., "CM-2")
  policyIds?: string[];
}

export interface CreateRgPolicy {
  deny_names?: string[];    // exact matches
  deny_contains?: string[]; // substrings to ban (case-insensitive)
  deny_regex?: string;      // optional advanced pattern
  name_regex?: string;
  allowed_regions?: string[];
  require_tags?: string[];
  suggest_name?: string;
  suggest_region?: string;
  suggest_tags?: Record<string, string>;
  controls?: string[];      // NIST control IDs attached to this policy node
}

export interface AzurePolicySet {
  create_resource_group?: CreateRgPolicy;
  [key: string]: any;
}

export interface PolicyDoc {
  azure?: AzurePolicySet;
  [key: string]: any;
}

export interface EvaluateContext {
  upn?: string;
  alias?: string;
  region?: string;
  [key: string]: any;
}

export type McpContent =
  | { type: "text"; text: string }
  | { type: "json"; json: any };

export const mcpText = (text: string): McpContent[] => [{ type: "text", text }];
export const mcpJson  = (json: any): McpContent[] => [{ type: "json", json }];