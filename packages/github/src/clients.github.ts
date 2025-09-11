import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import type { GithubClients, GithubBranchProtectionRules, GithubRepoCreate } from "./types.js";

const RetryThrottledOctokit = Octokit.plugin(retry, throttling);

export type GithubAppConfig = {
  appId: string | number;
  privateKey: string;
  installationId: string | number;
  baseUrl?: string;
  userAgent?: string;
};

function octokitFromApp(cfg: GithubAppConfig) {
  return new RetryThrottledOctokit({
    baseUrl: cfg.baseUrl,
    userAgent: cfg.userAgent,
    authStrategy: createAppAuth,
    auth: { appId: Number(cfg.appId), privateKey: cfg.privateKey, installationId: Number(cfg.installationId) },
    request: { retries: 5, retryAfter: 2 },
    throttle: { onRateLimit: () => true, onSecondaryRateLimit: () => true },
  });
}

export function createGithubClients(cfg: GithubAppConfig): GithubClients {
  const oc = octokitFromApp(cfg);

  const repos = {
    async create(input: GithubRepoCreate) {
      const visibility = input.visibility ? (input.visibility === "internal" ? "private" : input.visibility) : (input.private !== false ? "private" : "public");
      const r = await oc.rest.repos.createInOrg({
        org: input.owner,
        name: input.name,
        description: input.description,
        private: visibility === "private",
        visibility,
        auto_init: input.autoInit ?? true,
        has_issues: true,
      });
      if (Array.isArray(input.topics) && input.topics.length) {
        await oc.rest.repos.replaceAllTopics({ owner: input.owner, repo: input.name, names: input.topics });
      }
      return r.data;
    },
    async get(owner: string, repo: string) {
      const r = await oc.rest.repos.get({ owner, repo });
      return r.data;
    },
    async listForOrg(org: string, opts?: { type?: "all" | "public" | "private" | "forks" | "sources" | "member"; includeArchived?: boolean }) {
      const type = opts?.type ?? "all";
      const items = await oc.paginate(oc.rest.repos.listForOrg, { org, type, per_page: 100 });
      return (opts?.includeArchived ? items : items.filter((r: any) => !r.archived));
    },
    async getBranchProtection(owner: string, repo: string, branch: string) {
      const r = await oc.rest.repos.getBranchProtection({ owner, repo, branch });
      return r.data;
    },
    async updateBranchProtection(owner: string, repo: string, rules: GithubBranchProtectionRules) {
      const required_pull_request_reviews = {
        required_approving_review_count: rules.requiredApprovingReviewCount ?? 2,
        dismiss_stale_reviews: rules.dismissStaleReviews ?? true,
        require_code_owner_reviews: rules.requireCodeOwnerReviews ?? true,
      } as any;
      const required_status_checks = rules.requireStatusChecks ? { strict: true, contexts: rules.requiredStatusChecksContexts ?? [] } : null;
      const r = await oc.rest.repos.updateBranchProtection({
        owner,
        repo,
        branch: rules.branch,
        enforce_admins: rules.enforceAdmins ?? true,
        required_pull_request_reviews,
        required_status_checks: required_status_checks as any,
        restrictions: null,
      });
      return r.data;
    },
    async enableSecurityFeatures(owner: string, repo: string, opts?: { enableDependabot?: boolean; enableAdvancedSecurity?: boolean }) {
      const tryCall = async (fn: () => Promise<any>) => { try { return await fn(); } catch (e: any) { const s = e?.status || e?.response?.status; if (s === 403 || s === 404) return null; throw e; } };
      await tryCall(() => oc.rest.repos.enableVulnerabilityAlerts({ owner, repo } as any));
      await tryCall(() => oc.rest.repos.enableAutomatedSecurityFixes({ owner, repo } as any));
      if (opts?.enableAdvancedSecurity && (oc as any).rest.repos.updateInformationAboutAdvancedSecurityForEnterprise) {
        await tryCall(() => (oc as any).rest.repos.updateInformationAboutAdvancedSecurityForEnterprise({ owner, repo, state: "enabled" }));
      }
      if (opts?.enableDependabot && (oc as any).rest.repos.enablePrivateVulnerabilityReporting) {
        await tryCall(() => (oc as any).rest.repos.enablePrivateVulnerabilityReporting({ owner, repo }));
      }
      return { ok: true };
    },
  };

  const actions = {    
    async getPermissions(owner: string, repo: string) {
      const r = await (oc as any).rest.actions.getGithubActionsPermissionsRepository({ owner, repo });
      return r.data;
    },
  };

  return { repos, actions } as GithubClients;
}
