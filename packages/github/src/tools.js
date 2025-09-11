// packages/github-core/src/tools.ts — append remediation tools
import { z } from "zod";
import { withGovernanceAll, wrapCreate, wrapGet } from "./utils.js";
import { makeGithubRemediationTools } from "./tools/tools.remediation.js";
export function makeGithubTools(opts) {
    const { clients, evaluateGovernance, namespace = "github." } = opts;
    const n = (s) => `${namespace}${s}`;
    const create_repo = wrapCreate(n("create_repo"), "Create a repository in an organization (private by default).", z.object({ owner: z.string(), name: z.string(), description: z.string().optional(), private: z.boolean().optional(), visibility: z.enum(["public", "private", "internal"]).optional(), topics: z.array(z.string()).optional(), autoInit: z.boolean().optional() }).strict(), async (a) => clients.repos.create(a));
    const get_repo = wrapGet(n("get_repo"), "Get repository metadata.", z.object({ owner: z.string(), repo: z.string() }).strict(), async (a) => clients.repos.get(a.owner, a.repo));
    const set_branch_protection = wrapCreate(n("set_branch_protection"), "Configure branch protection on a repository branch.", z.object({ owner: z.string(), repo: z.string(), branch: z.string(), requiredApprovingReviewCount: z.number().int().min(0).max(6).default(2), requireCodeOwnerReviews: z.boolean().default(true), dismissStaleReviews: z.boolean().default(true), enforceAdmins: z.boolean().default(true), requireStatusChecks: z.boolean().default(true), requiredStatusChecksContexts: z.array(z.string()).optional() }).strict(), async (a) => clients.repos.updateBranchProtection(a.owner, a.repo, a));
    const enable_security = wrapCreate(n("enable_security_features"), "Enable security features (vulnerability alerts, automated security fixes, and optional Advanced Security/Dependabot where available).", z.object({ owner: z.string(), repo: z.string(), enableDependabot: z.boolean().optional(), enableAdvancedSecurity: z.boolean().optional() }).strict(), async (a) => clients.repos.enableSecurityFeatures(a.owner, a.repo, { enableDependabot: a.enableDependabot, enableAdvancedSecurity: a.enableAdvancedSecurity }));
    const remediationTools = makeGithubRemediationTools({ ...opts, namespace });
    return withGovernanceAll([create_repo, get_repo, set_branch_protection, enable_security, ...remediationTools], evaluateGovernance);
}
