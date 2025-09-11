export interface GithubRepoCreate {
  owner: string;
  name: string;
  description?: string;
  private?: boolean;
  visibility?: "public" | "private" | "internal";
  topics?: string[];
  autoInit?: boolean;
}

export interface GithubBranchProtectionRules {
  branch: string;
  requiredApprovingReviewCount?: number;
  requireCodeOwnerReviews?: boolean;
  dismissStaleReviews?: boolean;
  enforceAdmins?: boolean;
  requireStatusChecks?: boolean;
  requiredStatusChecksContexts?: string[];
}

export interface GithubClients {
  repos: {
    create(input: GithubRepoCreate): Promise<any>;
    get(owner: string, repo: string): Promise<any>;
    listForOrg(org: string, opts?: { type?: "all" | "public" | "private" | "forks" | "sources" | "member"; includeArchived?: boolean }): Promise<any[]>;
    getBranchProtection(owner: string, repo: string, branch: string): Promise<any>;
    updateBranchProtection(owner: string, repo: string, rules: GithubBranchProtectionRules): Promise<any>;
    enableSecurityFeatures(owner: string, repo: string, opts?: { enableDependabot?: boolean; enableAdvancedSecurity?: boolean }): Promise<any>;
  };
  actions: {
    listEnvironments(owner: string, repo: string): Promise<any[]>;
    getPermissions(owner: string, repo: string): Promise<any>;
  };
}

export type MakeGithubToolsOptions = {
  clients: GithubClients | any;
  evaluateGovernance?: (toolFq: string, args: any, ctx?: any) => Promise<{ decision: "allow" | "warn" | "deny" }> | { decision: "allow" | "warn" | "deny" };
  namespace?: string;
  getAtoProfile?: (profile: string) => any;
  getAtoRule?: (domain: string, profile: string, code: string) => { controlIds?: string[]; suggest?: string } | null;
  hasAtoProfile?: (domain: string, profile: string) => boolean;
};

export type ScanFinding = { code: string; severity: "high" | "medium" | "low" | "info" | "unknown"; meta?: Record<string, any>; controlIds?: string[]; suggest?: string };
