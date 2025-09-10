// packages/github-core/src/index.ts
import { z } from "zod";
import sodium from "tweetsodium";
import type { MakeGitHubToolsOptions } from "./types.js";
import { wrapCreate, wrapGet, wrapList, withGovernanceAll } from "./utils.js";

/** Encrypt a plaintext for GH Actions secrets using repo/org public key */
function encryptForSecrets(publicKeyBase64: string, plaintext: string): string {
  const messageBytes = Buffer.from(plaintext);
  const keyBytes = Buffer.from(publicKeyBase64, "base64");
  const encryptedBytes = sodium.seal(messageBytes, keyBytes);
  return Buffer.from(encryptedBytes).toString("base64");
}

export function makeGitHubTools(opts: MakeGitHubToolsOptions) {
  const { clients, evaluateGovernance, namespace = "github." } = opts;
  const n = (s: string) => `${namespace}${s}`;

  // Repos
  const create_repo_for_org = wrapCreate(
    n("create_repo_for_org"),
    "Create a repository in an organization.",
    z.object({
      org: z.string(),
      name: z.string(),
      private: z.boolean().optional().default(true),
      description: z.string().optional()
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.org);
      const res = await octo.rest.repos.createInOrg({
        org: a.org,
        name: a.name,
        private: a.private,
        description: a.description
      });
      return res.data;
    }
  );

  const create_repo_from_template = wrapCreate(
    n("create_repo_from_template"),
    "Create a repository from a template repository.",
    z.object({
      templateOwner: z.string(),
      templateRepo: z.string(),
      owner: z.string(),
      name: z.string(),
      private: z.boolean().optional().default(true),
      description: z.string().optional()
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const res = await octo.rest.repos.createUsingTemplate({
        template_owner: a.templateOwner,
        template_repo: a.templateRepo,
        owner: a.owner,
        name: a.name,
        private: a.private,
        description: a.description
      });
      return res.data;
    }
  );

  const get_repo = wrapGet(
    n("get_repo"),
    "Get a repository.",
    z.object({ owner: z.string(), repo: z.string() }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const res = await octo.rest.repos.get({ owner: a.owner, repo: a.repo });
      return res.data;
    }
  );

  const list_repos_for_org = wrapList(
    n("list_repos_for_org"),
    "List repositories for an organization.",
    z.object({
      org: z.string(),
      type: z.enum(["all", "public", "private", "forks", "sources", "member"]).optional().default("all")
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.org);
      return await octo.paginate(octo.rest.repos.listForOrg, { org: a.org, per_page: 100, type: a.type });
    }
  );

  const list_templates_for_org = wrapList(
    n("list_templates_for_org"),
    "List org repos that are marked as templates (is_template=true).",
    z.object({ org: z.string() }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.org);
      const all = await octo.paginate(octo.rest.repos.listForOrg, { org: a.org, per_page: 100, type: "all" });
      return all.filter((r: any) => r?.is_template === true);
    }
  );

  // Issues & Labels
  const create_issue = wrapCreate(
    n("create_issue"),
    "Create an issue.",
    z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      body: z.string().optional(),
      assignees: z.array(z.string()).optional(),
      labels: z.array(z.string()).optional()
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const res = await octo.rest.issues.create({
        owner: a.owner,
        repo: a.repo,
        title: a.title,
        body: a.body,
        assignees: a.assignees,
        labels: a.labels
      });
      return res.data;
    }
  );

  const create_labels = wrapCreate(
    n("create_labels"),
    "Create/update multiple labels in a repo.",
    z.object({
      owner: z.string(),
      repo: z.string(),
      labels: z.array(
        z.object({
          name: z.string(),
          color: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
          description: z.string().optional()
        }).strict()
      )
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const existing = await octo.paginate(octo.rest.issues.listLabelsForRepo, { owner: a.owner, repo: a.repo, per_page: 100 });
      const map = new Map(existing.map((l: any) => [l.name.toLowerCase(), l]));
      const results: any[] = [];
      for (const l of a.labels) {
        const key = l.name.toLowerCase();
        if (map.has(key)) {
          const res = await octo.rest.issues.updateLabel({
            owner: a.owner, repo: a.repo, name: map.get(key).name,
            new_name: l.name, color: l.color, description: l.description
          });
          results.push(res.data);
        } else {
          const res = await octo.rest.issues.createLabel({
            owner: a.owner, repo: a.repo, name: l.name, color: l.color, description: l.description
          });
          results.push(res.data);
        }
      }
      return results;
    }
  );

  // Actions: Secrets / Variables / Dispatch
  const put_repo_secret = wrapCreate(
    n("put_repo_secret"),
    "Create or update a repo Actions secret.",
    z.object({ owner: z.string(), repo: z.string(), name: z.string(), value: z.string() }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const pk = await octo.rest.actions.getRepoPublicKey({ owner: a.owner, repo: a.repo });
      const encrypted_value = encryptForSecrets(pk.data.key, a.value);
      await octo.rest.actions.createOrUpdateRepoSecret({
        owner: a.owner, repo: a.repo, secret_name: a.name, encrypted_value, key_id: pk.data.key_id
      });
      return { ok: true, secret: a.name };
    }
  );

  const delete_repo_secret = wrapCreate(
    n("delete_repo_secret"),
    "Delete a repo Actions secret.",
    z.object({ owner: z.string(), repo: z.string(), name: z.string() }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      await octo.rest.actions.deleteRepoSecret({ owner: a.owner, repo: a.repo, secret_name: a.name });
      return { ok: true, secret: a.name, deleted: true };
    }
  );

  const dispatch_workflow = wrapCreate(
    n("dispatch_workflow"),
    "Dispatch a GH Actions workflow by ID or file name.",
    z.object({
      owner: z.string(),
      repo: z.string(),
      workflowId: z.union([z.number(), z.string()]),
      ref: z.string(),
      inputs: z.record(z.any()).optional()
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      await octo.rest.actions.createWorkflowDispatch({
        owner: a.owner, repo: a.repo, workflow_id: a.workflowId, ref: a.ref, inputs: a.inputs
      });
      return { ok: true, dispatched: true };
    }
  );

  // Access & Protection
  const add_repo_collaborator = wrapCreate(
    n("add_repo_collaborator"),
    "Add a collaborator to a repo.",
    z.object({
      owner: z.string(), repo: z.string(), username: z.string(),
      permission: z.enum(["pull","triage","push","maintain","admin"]).optional().default("push")
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const res = await octo.rest.repos.addCollaborator({
        owner: a.owner, repo: a.repo, username: a.username, permission: a.permission
      });
      return { ok: true, invitation: res.data };
    }
  );

  const protect_branch = wrapCreate(
    n("protect_branch"),
    "Configure branch protection.",
    z.object({
      owner: z.string(), repo: z.string(), branch: z.string(),
      enforceAdmins: z.boolean().optional().default(true),
      requireLinearHistory: z.boolean().optional().default(true),
      allowForcePushes: z.boolean().optional().default(false),
      allowDeletions: z.boolean().optional().default(false),
      requiredApprovingReviewCount: z.number().int().min(0).max(6).optional().default(1),
      dismissStaleReviews: z.boolean().optional().default(true),
      requireCodeOwnerReviews: z.boolean().optional().default(false),
      requireStatusChecks: z.boolean().optional().default(false),
      statusCheckContexts: z.array(z.string()).optional()
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const required_status_checks = a.requireStatusChecks ? { strict: true, contexts: a.statusCheckContexts ?? [] } : null;
      const res = await octo.rest.repos.updateBranchProtection({
        owner: a.owner, repo: a.repo, branch: a.branch,
        enforce_admins: a.enforceAdmins,
        required_linear_history: a.requireLinearHistory,
        allow_force_pushes: a.allowForcePushes,
        allow_deletions: a.allowDeletions,
        required_status_checks,
        required_pull_request_reviews: {
          required_approving_review_count: a.requiredApprovingReviewCount,
          dismiss_stale_reviews: a.dismissStaleReviews,
          require_code_owner_reviews: a.requireCodeOwnerReviews
        },
        restrictions: null
      } as any);
      return res.data ?? { ok: true };
    }
  );

  // Releases & Environments
  const create_release = wrapCreate(
    n("create_release"),
    "Create a GitHub release.",
    z.object({
      owner: z.string(), repo: z.string(), tagName: z.string(),
      targetCommitish: z.string().optional(), name: z.string().optional(),
      body: z.string().optional(), draft: z.boolean().optional().default(false),
      prerelease: z.boolean().optional().default(false)
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const res = await octo.rest.repos.createRelease({
        owner: a.owner, repo: a.repo,
        tag_name: a.tagName, target_commitish: a.targetCommitish,
        name: a.name, body: a.body, draft: a.draft, prerelease: a.prerelease
      });
      return res.data;
    }
  );

  const create_or_update_environment = wrapCreate(
    n("create_or_update_environment"),
    "Create or update a repo environment.",
    z.object({
      owner: z.string(), repo: z.string(), environmentName: z.string(),
      waitTimer: z.number().int().min(0).max(43200).optional(),
      reviewers: z.array(z.object({ type: z.enum(["User","Team"]), id: z.number() })).optional(),
      deploymentBranchPolicy: z.object({
        protectedBranches: z.boolean().default(true),
        customBranchPolicies: z.boolean().default(false)
      }).optional()
    }).strict(),
    async (a) => {
      const octo = await clients.getOctoClient(a.owner);
      const res = await octo.rest.repos.createOrUpdateEnvironment({
        owner: a.owner, repo: a.repo, environment_name: a.environmentName,
        wait_timer: a.waitTimer, reviewers: a.reviewers,
        deployment_branch_policy: a.deploymentBranchPolicy
          ? {
              protected_branches: a.deploymentBranchPolicy.protectedBranches,
              custom_branch_policies: a.deploymentBranchPolicy.customBranchPolicies
            }
          : undefined
      } as any);
      return res.data ?? { ok: true };
    }
  );

  const tools = [
    create_repo_for_org,
    create_repo_from_template,
    get_repo,
    list_repos_for_org,
    list_templates_for_org,
    create_issue,
    create_labels,
    put_repo_secret,
    delete_repo_secret,
    dispatch_workflow,
    add_repo_collaborator,
    protect_branch,
    create_release,
    create_or_update_environment
  ];

  return withGovernanceAll(tools, opts.evaluateGovernance);
}