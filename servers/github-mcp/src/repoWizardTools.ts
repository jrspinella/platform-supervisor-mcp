import { z } from "zod";
import type { Octokit } from "@octokit/rest";

// Simple, robust pagination using core routes
async function listOrgReposCore(gh: any, org: string, per_page = 100) {
  const all: any[] = [];
  for (let page = 1; page <= 50; page++) { // hard cap
    const res = await gh.request("GET /orgs/{org}/repos", {
      org, per_page, page, type: "all"
    });
    const batch = Array.isArray(res.data) ? res.data : [];
    all.push(...batch);
    if (batch.length < per_page) break;
  }
  return all;
}

// Guard: use rest if present, otherwise core routes
function hasRest(gh: any) {
  return !!(gh && gh.rest && gh.rest.repos);
}

export function repoWizardTools(ghFactory: { forInstallation: (ownerOrOrg?: string) => Promise<Octokit> }) {
  const nameRegex = /^[A-Za-z0-9._-]{1,100}$/;

  const listTemplatesSchema = z.object({
    org: z.string(),
    per_page: z.number().int().min(1).max(100).default(100),
  }).strict();

  const createFromTemplateSchema = z.object({
    templateOwner: z.string(),
    templateRepo: z.string(),
    owner: z.string(),
    name: z.string().regex(nameRegex, "Invalid repository name"),
    description: z.string().optional(),
    private: z.boolean().default(true),
    includeAllBranches: z.boolean().default(false),
  }).strict();

  const assignTeamPermSchema = z.object({
    owner: z.string(),
    repo: z.string(),
    teamSlug: z.string(),
    permission: z.enum(["pull", "triage", "push", "maintain", "admin"]),
  }).strict();

  const protectDefaultBranchSchema = z.object({
    owner: z.string(),
    repo: z.string(),
    branch: z.string().default("main"),
    requirePRReviews: z.boolean().default(true),
    requiredApprovingReviewCount: z.number().int().min(0).max(6).default(1),
    enforceAdmins: z.boolean().default(true),
  }).strict();

  const wizardSchema = z.object({
    templateOwner: z.string().optional(),
    templateRepo: z.string().optional(),
    owner: z.string().optional(),
    newRepoName: z.string().regex(nameRegex, "Invalid repository name").optional(),
    suggestName: z.string().optional(),
    visibility: z.enum(["private", "public", "internal"]).default("private"),
    description: z.string().optional(),
    defaultBranch: z.string().default("main"),
    labels: z.array(z.object({ name: z.string(), color: z.string().optional(), description: z.string().optional() })).optional(),
    teamSlug: z.string().optional(),
    dryRun: z.boolean().default(true),
  }).strict();

  return [
    {
      name: "github.list_template_repos",
      description: "List repositories in an org that are marked as templates (is_template=true).",
      inputSchema: listTemplatesSchema,
      handler: async ({ org, per_page }: z.infer<typeof listTemplatesSchema>) => {
        const gh = await ghFactory.forInstallation(org);
        let repos: any[] = [];
        if (hasRest(gh)) {
          // Prefer rest+paginate if available
          if ((gh as any).paginate?.iterator) {
            for await (const page of (gh as any).paginate.iterator((gh as any).rest.repos.listForOrg, { org, per_page, type: "all" })) {
              repos.push(...page.data);
            }
          } else {
            repos = await listOrgReposCore(gh, org, per_page);
          }
        } else {
          repos = await listOrgReposCore(gh, org, per_page);
        }
        const templates = repos
          .filter((r: any) => r && r.is_template)
          .map((r: any) => ({
            name: r.name,
            full_name: r.full_name,
            description: r.description,
            default_branch: r.default_branch,
            visibility: r.private ? "private" : "public",
          }));
        return { content: [{ type: "json" as const, json: templates }] };
      },
    },

    {
      name: "github.create_repo_from_template",
      description: "Generate a new repository from a template repo (template must have is_template=true).",
      inputSchema: createFromTemplateSchema,
      handler: async ({ templateOwner, templateRepo, owner, name, description, private: priv, includeAllBranches }: z.infer<typeof createFromTemplateSchema>) => {
        const gh = await ghFactory.forInstallation(owner);
        const res = await gh.request("POST /repos/{template_owner}/{template_repo}/generate", {
          template_owner: templateOwner,
          template_repo: templateRepo,
          owner,
          name,
          description,
          include_all_branches: includeAllBranches,
          private: priv,
        });
        return { content: [{ type: "json" as const, json: res.data }] };
      },
    },

    {
      name: "github.assign_team_permission",
      description: "Grant a team permission (pull|triage|push|maintain|admin) on a repo.",
      inputSchema: assignTeamPermSchema,
      handler: async ({ owner, repo, teamSlug, permission }: z.infer<typeof assignTeamPermSchema>) => {
        const gh = await ghFactory.forInstallation(owner);
        if (hasRest(gh)) {
          const res = await (gh as any).rest.teams.addOrUpdateRepoPermissionsInOrg({ org: owner, team_slug: teamSlug, owner, repo, permission });
          return { content: [{ type: "json" as const, json: { status: res.status } }] };
        }
        await gh.request("PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}", {
          org: owner, team_slug: teamSlug, owner, repo, permission
        });
        return { content: [{ type: "json" as const, json: { status: 200 } }] };
      },
    },

    {
      name: "github.protect_default_branch",
      description: "Apply a sensible default-branch protection policy.",
      inputSchema: protectDefaultBranchSchema,
      handler: async ({ owner, repo, branch, requirePRReviews, requiredApprovingReviewCount, enforceAdmins }: z.infer<typeof protectDefaultBranchSchema>) => {
        const gh = await ghFactory.forInstallation(owner);
        const protectionBody: any = {
          required_status_checks: null,
          enforce_admins: enforceAdmins,
          restrictions: null,
          allow_force_pushes: false,
          allow_deletions: false,
        };
        if (requirePRReviews) {
          protectionBody.required_pull_request_reviews = { required_approving_review_count: requiredApprovingReviewCount };
        }
        if (hasRest(gh)) {
          await (gh as any).rest.repos.updateBranchProtection({ owner, repo, branch, ...protectionBody });
        } else {
          await gh.request("PUT /repos/{owner}/{repo}/branches/{branch}/protection", {
            owner, repo, branch, ...protectionBody
          });
        }
        return { content: [{ type: "text" as const, text: `Branch protection applied to ${owner}/${repo}@${branch}` }] };
      },
    },

    {
      name: "github.repo_wizard_mission_owner",
      description: "Mission Owner repo wizard: plan or execute create-from-template + protections + team + labels. Defaults to dryRun=true.",
      inputSchema: wizardSchema,
      handler: async (args: z.infer<typeof wizardSchema>) => {
        const owner = args.owner;
        const templateOwner = args.templateOwner;
        const templateRepo = args.templateRepo;
        const name = args.newRepoName || args.suggestName;
        const isPrivate = args.visibility !== "public";

        const plan = {
          action: "create_repo_from_template",
          dryRun: args.dryRun,
          request: {
            template: templateOwner && templateRepo ? `${templateOwner}/${templateRepo}` : "(missing)",
            owner: owner || "(missing)",
            name: name || "(missing)",
            private: isPrivate,
            description: args.description || "",
          },
          postCreate: {
            setBranchProtection: { branch: args.defaultBranch || "main", enforceAdmins: true, approvals: 1 },
            addTeamPermission: args.teamSlug ? { teamSlug: args.teamSlug, permission: "push" as const } : null,
            createLabels: args.labels || [],
          },
        };

        if (!owner || !templateOwner || !templateRepo || !name) {
          return { content: [{ type: "json" as const, json: { ...plan, ready: false, missing: { owner: !owner, templateOwner: !templateOwner, templateRepo: !templateRepo, name: !name } } }] };
        }

        // Template must exist & be a template
        const tmplGh = await ghFactory.forInstallation(templateOwner);
        const tmplRes = await (tmplGh as any).request("GET /repos/{owner}/{repo}", { owner: templateOwner, repo: templateRepo });
        if (!tmplRes?.data?.is_template) {
          return { content: [{ type: "text" as const, text: `Template ${templateOwner}/${templateRepo} is not marked as a template` }], isError: true };
        }

        if (args.dryRun) {
          return { content: [{ type: "json" as const, json: { ...plan, ready: true } }] };
        }

        const gh = await ghFactory.forInstallation(owner);
        const result: any = { dryRun: false, steps: [] };

        // 1) Create from template
        const gen = await gh.request("POST /repos/{template_owner}/{template_repo}/generate", {
          template_owner: templateOwner,
          template_repo: templateRepo,
          owner,
          name,
          private: isPrivate,
          description: args.description || "",
          include_all_branches: false,
        });
        result.steps.push({ step: "generate", status: gen.status });

        // 2) Branch protection
        try {
          await gh.request("PUT /repos/{owner}/{repo}/branches/{branch}/protection", {
            owner, repo: name, branch: args.defaultBranch || "main",
            required_status_checks: null,
            enforce_admins: true,
            required_pull_request_reviews: { required_approving_review_count: 1 },
            restrictions: null,
            allow_force_pushes: false,
            allow_deletions: false,
          });
          result.steps.push({ step: "protect_branch", status: "ok" });
        } catch (e: any) {
          result.steps.push({ step: "protect_branch", status: "skip", error: String(e?.message || e) });
        }

        // 3) Team permission (optional)
        if (args.teamSlug) {
          try {
            await gh.request("PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}", {
              org: owner, team_slug: args.teamSlug, owner, repo: name, permission: "push",
            });
            result.steps.push({ step: "team_permission", status: "ok", team: args.teamSlug });
          } catch (e: any) {
            result.steps.push({ step: "team_permission", status: "skip", error: String(e?.message || e) });
          }
        }

        // 4) Labels (optional)
        if (args.labels?.length) {
          for (const L of args.labels) {
            try {
              await gh.request("POST /repos/{owner}/{repo}/labels", {
                owner, repo: name, name: L.name, color: L.color || "ededed", description: L.description || ""
              });
              result.steps.push({ step: "label", name: L.name, status: "ok" });
            } catch (e: any) {
              result.steps.push({ step: "label", name: L.name, status: "skip", error: String(e?.message || e) });
            }
          }
        }

        result.repo = { owner, name };
        return { content: [{ type: "json" as const, json: result }] };
      },
    },
  ];
}
