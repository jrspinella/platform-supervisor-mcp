export type Decision = "allow" | "warn" | "deny";
export type Severity = "high" | "medium" | "low" | "info" | "unknown";

export interface Suggestion { title?: string; text: string }

export interface GovernanceBlock {
  decision: Decision;
  reasons?: string[];
  suggestions?: Suggestion[];
  controls?: string[];      // NIST controls (e.g., CM-2)
  policyIds?: string[];     // which policy nodes applied
}

export interface CreateRgPolicy {
  deny_names?: string[];    // exact matches
  deny_contains?: string[]; // substrings to ban
  deny_regex?: string;      // optional advanced pattern
  name_regex?: string;      // required naming pattern
  allowed_regions?: string[];
  require_tags?: string[];
  suggest_name?: string;
  suggest_region?: string;
  suggest_tags?: Record<string, string>;
  controls?: string[];      // NIST control IDs attached to this policy node
}

export interface AzurePolicySet {
  create_resource_group?: CreateRgPolicy;
  // extend with more policy nodes as needed
  [key: string]: unknown;
}

export interface PolicyDoc {
  azure?: AzurePolicySet;
  ato?: {
    defaultProfile?: string;
    profiles?: Record<string, any>;
    checks?: Record<string, any>;
  };
  [key: string]: unknown;
}

export interface AtoCheck {
  code: string;
  title?: string;
  severity?: Severity | string;
  controls?: string[];
  recommendation?: string;
  fix?: unknown;
}

export interface EvaluateContext {
  upn?: string;
  alias?: string;
  region?: string;
  [key: string]: unknown;
}

export type McpContent = { type: "text"; text: string } | { type: "json"; json: any };
