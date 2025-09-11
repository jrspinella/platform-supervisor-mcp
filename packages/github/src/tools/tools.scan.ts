// packages/github-core/src/tools.scan.ts — v3 (org per-repo summaries)
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import type { MakeGithubToolsOptions, ScanFinding } from "../types.js";
import { normalizeGithubError, scanSummary, formatTextSummary, filterFindings } from "../utils.js";

export function makeGithubScanTools(opts: MakeGithubToolsOptions & { namespace?: string }) {
  const { clients, namespace = "github.", getAtoRule, getAtoProfile, hasAtoProfile } = opts;
  const n = (s: string) => `${namespace}${s}`;

  // Lazy ATO accessors (fallback to governance-core singletons)
  let _getAtoRule = getAtoRule;
  let _getAtoProfile = getAtoProfile;
  let _hasAtoProfile = hasAtoProfile;
  async function ensureAto() {
    if (!_getAtoRule || !_getAtoProfile || !_hasAtoProfile) {
      const gc = await import("@platform/governance-core");
      _getAtoRule = _getAtoRule || gc.getAtoRule;
      _getAtoProfile = _getAtoProfile || gc.getAtoProfile;
      _hasAtoProfile = _hasAtoProfile || gc.hasAtoProfile;
    }
  }

  async function scanRepo(owner: string, repo: any, profile: string): Promise<ScanFinding[]> {
    const name = repo.name as string;
    const defBranch = repo.default_branch as string;
    const findings: ScanFinding[] = [];

    if (repo.private !== true) findings.push({ code: "REPO_NOT_PRIVATE", severity: "high", meta: { owner, repo: name } });

    const sa = (repo as any).security_and_analysis || {};
    const secretScan = sa.secret_scanning?.status === "enabled";
    const secretPP = sa.secret_scanning_push_protection?.status === "enabled";
    const depUpdates = sa.dependabot_security_updates?.status === "enabled";
    if (!secretScan) findings.push({ code: "REPO_SECRET_SCANNING_DISABLED", severity: "high", meta: { repo: name } });
    if (!secretPP) findings.push({ code: "REPO_SECRET_PUSH_PROTECTION_DISABLED", severity: "medium", meta: { repo: name } });
    if (!depUpdates) findings.push({ code: "REPO_DEPENDABOT_UPDATES_DISABLED", severity: "low", meta: { repo: name } });

    try {
      const bp: any = await clients.repos.getBranchProtection(owner, name, defBranch);
      const minReviews = bp?.required_pull_request_reviews?.required_approving_review_count;
      if (typeof minReviews === "number" && minReviews < 2) {
        findings.push({ code: "REPO_REQUIRED_REVIEWERS_TOO_LOW", severity: "medium", meta: { repo: name, current: minReviews } });
      }
      const statusChecks = bp?.required_status_checks;
      if (!statusChecks) findings.push({ code: "REPO_STATUS_CHECKS_MISSING", severity: "medium", meta: { repo: name } });
    } catch {
      findings.push({ code: "REPO_BRANCH_PROTECTION_MISSING", severity: "high", meta: { repo: name, branch: defBranch } });
    }

    // Enrich
    return findings.map((f) => {
      const map = _getAtoRule?.("githubRepo", profile, f.code) || {};
      return { ...f, controlIds: map.controlIds || [], suggest: map.suggest || undefined };
    });
  }

  async function scanPipeline(owner: string, repoName: string, profile: string): Promise<ScanFinding[]> {
    const findings: ScanFinding[] = [];
    try {
      const envs = await clients.actions.listEnvironments(owner, repoName);
      for (const e of envs) {
        const reviewers = Array.isArray(e?.protection_rules)
          ? e.protection_rules.flatMap((r: any) => r?.reviewers ?? [])
          : [];
        if (!reviewers.length) findings.push({ code: "PIPELINE_ENV_NO_REVIEWERS", severity: "medium", meta: { repo: repoName, environment: e?.name } });
      }
    } catch {
      // ignore env errors
    }

    // Enrich
    return findings.map((f) => {
      const map = _getAtoRule?.("githubPipeline", profile, f.code) || {};
      return { ...f, controlIds: map.controlIds || [], suggest: map.suggest || undefined };
    });
  }

  const scan_repo_baseline: ToolDef = {
    name: n("scan_repo_baseline"),
    description: "Scan a repository for baseline governance & security posture; enrich with ATO controls/suggestions.",
    inputSchema: z.object({ owner: z.string(), repo: z.string(), profile: z.string().default("default"), minSeverity: z.enum(["info","low","medium","high"]).optional(), excludeFindingsByCode: z.array(z.string()).optional() }).strict(),
    handler: async (a) => {
      try {
        await ensureAto();
        const repo = await clients.repos.get(a.owner, a.repo);
        const repoFindings = await scanRepo(a.owner, repo, a.profile);
        const filtered = filterFindings(repoFindings, { minSeverity: a.minSeverity, excludeCodes: a.excludeFindingsByCode });
        const summary = scanSummary(filtered);
        return { content: [ { type: "json", json: { status: "done", profile: a.profile, findings: filtered, summary } }, { type: "text", text: formatTextSummary("repo", a.profile, summary) } ] };
      } catch (e: any) {
        return { content: [ { type: "json", json: normalizeGithubError(e) } ], isError: true };
      }
    },
  };

  const scan_pipeline_baseline: ToolDef = {
    name: n("scan_pipeline_baseline"),
    description: "Scan a repository's CI/CD (GitHub Actions) baseline posture; enrich with ATO controls/suggestions.",
    inputSchema: z.object({ owner: z.string(), repo: z.string(), profile: z.string().default("default"), minSeverity: z.enum(["info","low","medium","high"]).optional(), excludeFindingsByCode: z.array(z.string()).optional() }).strict(),
    handler: async (a) => {
      try {
        await ensureAto();
        const pipeFindings = await scanPipeline(a.owner, a.repo, a.profile);
        const filtered = filterFindings(pipeFindings, { minSeverity: a.minSeverity, excludeCodes: a.excludeFindingsByCode });
        const summary = scanSummary(filtered);
        return { content: [ { type: "json", json: { status: "done", profile: a.profile, findings: filtered, summary } }, { type: "text", text: formatTextSummary("pipeline", a.profile, summary) } ] };
      } catch (e: any) {
        return { content: [ { type: "json", json: normalizeGithubError(e) } ], isError: true };
      }
    },
  };

  const scan_org_repos_baseline: ToolDef = {
    name: n("scan_org_repos_baseline"),
    description: "Enumerate repositories in an org and run repo & pipeline baseline scans with ATO enrichment; returns per-repo summaries.",
    inputSchema: z.object({
      org: z.string(),
      profile: z.string().default("default"),
      includeArchived: z.boolean().default(false),
      include: z.array(z.enum(["repo", "pipeline"]).default("repo")).optional(),
      exclude: z.array(z.enum(["repo", "pipeline"]).default("pipeline")).optional(),
      limit: z.number().int().min(1).max(5000).default(500),
      minSeverity: z.enum(["info", "low", "medium", "high"]).optional(),
      excludeFindingsByCode: z.array(z.string()).optional(),
    }).strict(),
    handler: async (a) => {
      try {
        await ensureAto();
        const kinds = new Set<string>((a.include && a.include.length ? a.include : ["repo", "pipeline"]) as string[]);
        for (const k of a.exclude || []) kinds.delete(k);

        const repos = await clients.repos.listForOrg(a.org, { includeArchived: a.includeArchived });
        const slice = repos.slice(0, a.limit);

        const perRepo: Record<string, { total: number; bySeverity: Record<string, number> }> = {};
        const allFindings: ScanFinding[] = [];

        for (const r of slice) {
          const repoName = r.name as string;
          let repoFindings: ScanFinding[] = [];

          if (kinds.has("repo")) {
            const f = await scanRepo(a.org, r, a.profile);
            repoFindings.push(...f);
          }
          if (kinds.has("pipeline")) {
            const f = await scanPipeline(a.org, repoName, a.profile);
            repoFindings.push(...f);
          }

          const filteredRepo = filterFindings(repoFindings, { minSeverity: a.minSeverity, excludeCodes: a.excludeFindingsByCode });
          const summaryRepo = scanSummary(filteredRepo);
          perRepo[`${a.org}/${repoName}`] = summaryRepo;
          allFindings.push(...filteredRepo);
        }

        const summary = scanSummary(allFindings);
        return {
          content: [
            { type: "json", json: { status: "done", scope: { org: a.org, reposScanned: slice.length }, profile: a.profile, findings: allFindings, summary, perRepo } },
            { type: "text", text: formatTextSummary("org", a.profile, summary) },
          ],
        };
      } catch (e: any) {
        return { content: [ { type: "json", json: normalizeGithubError(e) } ], isError: true };
      }
    },
  };

  return [scan_repo_baseline, scan_pipeline_baseline, scan_org_repos_baseline];
}
