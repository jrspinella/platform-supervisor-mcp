import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
const RetryThrottledOctokit = Octokit.plugin(retry, throttling);
function octokitFromApp(cfg) {
    return new RetryThrottledOctokit({
        baseUrl: cfg.baseUrl,
        userAgent: cfg.userAgent,
        authStrategy: createAppAuth,
        auth: { appId: Number(cfg.appId), privateKey: cfg.privateKey, installationId: Number(cfg.installationId) },
        request: { retries: 5, retryAfter: 2 },
        throttle: { onRateLimit: () => true, onSecondaryRateLimit: () => true },
    });
}
export function createGithubClients(cfg) {
    const oc = octokitFromApp(cfg);
    const repos = {
        async create(input) {
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
        async get(owner, repo) {
            const r = await oc.rest.repos.get({ owner, repo });
            return r.data;
        },
        async listForOrg(org, opts) {
            const type = opts?.type ?? "all";
            const items = await oc.paginate(oc.rest.repos.listForOrg, { org, type, per_page: 100 });
            return (opts?.includeArchived ? items : items.filter((r) => !r.archived));
        },
        async getBranchProtection(owner, repo, branch) {
            const r = await oc.rest.repos.getBranchProtection({ owner, repo, branch });
            return r.data;
        },
        async updateBranchProtection(owner, repo, rules) {
            const required_pull_request_reviews = {
                required_approving_review_count: rules.requiredApprovingReviewCount ?? 2,
                dismiss_stale_reviews: rules.dismissStaleReviews ?? true,
                require_code_owner_reviews: rules.requireCodeOwnerReviews ?? true,
            };
            const required_status_checks = rules.requireStatusChecks ? { strict: true, contexts: rules.requiredStatusChecksContexts ?? [] } : null;
            const r = await oc.rest.repos.updateBranchProtection({
                owner,
                repo,
                branch: rules.branch,
                enforce_admins: rules.enforceAdmins ?? true,
                required_pull_request_reviews,
                required_status_checks: required_status_checks,
                restrictions: null,
            });
            return r.data;
        },
        async enableSecurityFeatures(owner, repo, opts) {
            const tryCall = async (fn) => { try {
                return await fn();
            }
            catch (e) {
                const s = e?.status || e?.response?.status;
                if (s === 403 || s === 404)
                    return null;
                throw e;
            } };
            await tryCall(() => oc.rest.repos.enableVulnerabilityAlerts({ owner, repo }));
            await tryCall(() => oc.rest.repos.enableAutomatedSecurityFixes({ owner, repo }));
            if (opts?.enableAdvancedSecurity && oc.rest.repos.updateInformationAboutAdvancedSecurityForEnterprise) {
                await tryCall(() => oc.rest.repos.updateInformationAboutAdvancedSecurityForEnterprise({ owner, repo, state: "enabled" }));
            }
            if (opts?.enableDependabot && oc.rest.repos.enablePrivateVulnerabilityReporting) {
                await tryCall(() => oc.rest.repos.enablePrivateVulnerabilityReporting({ owner, repo }));
            }
            return { ok: true };
        },
    };
    const actions = {
        async getPermissions(owner, repo) {
            const r = await oc.rest.actions.getGithubActionsPermissionsRepository({ owner, repo });
            return r.data;
        },
    };
    return { repos, actions };
}
