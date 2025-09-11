// packages/github-core/src/tools.remediation.ts — v4 (add autofix_repo_findings)
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import type { MakeGithubToolsOptions, ScanFinding } from "../types.js";
import { normalizeGithubError, mjson, mtext } from "../utils.js";

/** Minimal plan step shape */
type PlanStep = { action: string; args: Record<string, any> };

type RepoReport = {
  plannedSteps: number;
  applied?: number;
  failed?: number;
  errors?: any[];
  suggestions?: string[];
  summary?: { total: number; bySeverity: Record<string, number> };
};

type OrgReport = Record<string, RepoReport>; // key: "owner/repo"

function dedupeSteps(steps: PlanStep[]): PlanStep[] {
  const seen = new Set<string>();
  const out: PlanStep[] = [];
  for (const s of steps) {
    const key = JSON.stringify({
      action: s.action,
      args: s.args && {
        owner: s.args.owner,
        repo: s.args.repo,
        branch: s.args.branch,
        environment: s.args.environment,
        policy: s.args.policy,
        visibility: s.args.visibility,
        reviewers: s.args.reviewers,
        contexts: s.args.requiredStatusChecksContexts,
      },
    });
    if (!seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

function summarizeResults(results: any[]): { applied: number; failed: number; errors: any[] } {
  const applied = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const errors = results
    .filter((r) => !r.ok)
    .map((r) => r.error || r.result?.error)
    .filter(Boolean);
  return { applied, failed, errors };
}

function suggestNextStepsForRepo(steps: PlanStep[], results?: any[]): string[] {
  const tips: string[] = [];
  const errs = results?.filter((r) => !r.ok) ?? [];
  if (errs.some((r) => (r?.error?.statusCode || r?.statusCode) === 403))
    tips.push("Verify app installation permissions (admin on repo/org) and required plans (e.g., Advanced Security).");
  if (errs.some((r) => (r?.error?.statusCode || r?.statusCode) === 404))
    tips.push("Check repository or feature availability (GitHub Cloud vs GHES) and endpoint support.");
  if (
    steps.some((s) => s.action === "repos.updateBranchProtection") &&
    !steps.some(
      (s) =>
        Array.isArray(s?.args?.requiredStatusChecksContexts) &&
        s.args.requiredStatusChecksContexts.length
    )
  )
    tips.push("Add concrete status check contexts to branch protection for stronger gates.");
  if (
    steps.some((s) => s.action === "actions.upsertEnvironment") &&
    !steps.some((s) => s.args.teamSlugs?.length || s.args.usernames?.length)
  )
    tips.push("Provide teamSlugs/usernames to gate deployment environments.");
  tips.push("Re-run github.scan_org_repos_baseline to verify.");
  return tips;
}

function renderTextReport(title: string, perRepo: OrgReport): string {
  const lines: string[] = [title];
  for (const [repo, r] of Object.entries(perRepo)) {
    const a = r.applied ?? 0;
    const f = r.failed ?? 0;
    const sev = r.summary?.bySeverity || {};
    const sevLine = ["high", "medium", "low", "info", "unknown"]
      .map((k) => `${k}:${sev[k] ?? 0}`)
      .join(" ");
    lines.push(
      `- ${repo} — planned:${r.plannedSteps} applied:${a} failed:${f}` +
        (r.summary ? `; findings:${r.summary.total} (${sevLine})` : "")
    );
    const tips: string[] = r.suggestions || [];
    for (const t of tips.slice(0, 3)) lines.push(`  • ${t}`);
  }
  return lines.join("\n");
}

function planFromFindings(
  findings: ScanFinding[],
  owner: string,
  repo: string,
  defaults: any
) {
  const steps: PlanStep[] = [];
  const want = defaults || {};
  const need = new Set(findings.map((f) => String(f.code).toUpperCase()));

  if (need.has("REPO_NOT_PRIVATE") && want.makePrivate !== false) {
    steps.push({ action: "repos.updateVisibility", args: { owner, repo, visibility: "private" } });
  }
  if (need.has("REPO_SECRET_SCANNING_DISABLED") && want.enableSecretScanning !== false) {
    steps.push({ action: "repos.enableSecurityFeatures", args: { owner, repo, enableDependabot: true, enableAdvancedSecurity: true } });
  }
  if (need.has("REPO_SECRET_PUSH_PROTECTION_DISABLED") && want.enablePushProtection !== false) {
    steps.push({ action: "repos.enableSecurityFeatures", args: { owner, repo, enableDependabot: true, enableAdvancedSecurity: true } });
  }
  if (need.has("REPO_DEPENDABOT_UPDATES_DISABLED") && want.enableDependabot !== false) {
    steps.push({ action: "repos.enableSecurityFeatures", args: { owner, repo, enableDependabot: true } });
  }
  if (
    need.has("REPO_BRANCH_PROTECTION_MISSING") ||
    need.has("REPO_REQUIRED_REVIEWERS_TOO_LOW") ||
    need.has("REPO_STATUS_CHECKS_MISSING")
  ) {
    const bp =
      want.branchProtection ?? {
        requiredApprovingReviewCount: 2,
        requireCodeOwnerReviews: true,
        dismissStaleReviews: true,
        enforceAdmins: true,
        requireStatusChecks: true,
        requiredStatusChecksContexts: want.requiredStatusChecksContexts ?? [],
      };
    steps.push({ action: "repos.updateBranchProtection", args: { owner, repo, ...bp } });
  }
  if (need.has("PIPELINE_ENV_NO_REVIEWERS")) {
    const env = want.environmentDefaults;
    const targetEnvs = findings
      .filter((f) => String(f.code).toUpperCase() === "PIPELINE_ENV_NO_REVIEWERS")
      .map((f) => (f as any)?.meta?.environment)
      .filter(Boolean);
    const names = targetEnvs.length ? targetEnvs : env?.names ?? [];
    if (names.length && (env?.teamSlugs?.length || env?.usernames?.length)) {
      for (const name of names) {
        steps.push({
          action: "actions.upsertEnvironment",
          args: {
            owner,
            repo,
            environment: name,
            teamSlugs: env.teamSlugs || [],
            usernames: env.usernames || [],
            waitTimer: env.waitTimer || 0,
          },
        });
      }
    }
  }
  if (want.actionsPermissions) {
    steps.push({ action: "actions.setPermissions", args: { owner, repo, policy: want.actionsPermissions.policy || "selected" } });
  }

  return dedupeSteps(steps);
}

export function makeGithubRemediationTools(
  opts: MakeGithubToolsOptions & { namespace?: string }
) {
  const { clients, namespace = "github." } = opts;
  const n = (s: string) => `${namespace}${s}`;

  const remediate_repo_baseline: ToolDef = {
    name: n("remediate_repo_baseline"),
    description:
      "Apply opinionated fixes for repo/pipeline baseline findings. Best-effort; ignores unsupported features.",
    inputSchema: z
      .object({
        owner: z.string(),
        repo: z.string(),
        findings: z
          .array(z.object({ code: z.string(), severity: z.string().optional() }))
          .optional(),
        defaults: z
          .object({
            makePrivate: z.boolean().optional().default(true),
            enableSecretScanning: z.boolean().optional().default(true),
            enablePushProtection: z.boolean().optional().default(true),
            enableDependabot: z.boolean().optional().default(true),
            branchProtection: z
              .object({
                branch: z.string().default("main"),
                requiredApprovingReviewCount: z
                  .number()
                  .int()
                  .min(0)
                  .max(6)
                  .default(2),
                requireCodeOwnerReviews: z.boolean().default(true),
                dismissStaleReviews: z.boolean().default(true),
                enforceAdmins: z.boolean().default(true),
                requireStatusChecks: z.boolean().default(true),
                requiredStatusChecksContexts: z.array(z.string()).optional().default([]),
              })
              .partial()
              .optional(),
            requiredStatusChecksContexts: z.array(z.string()).optional(),
            environmentDefaults: z
              .object({
                names: z.array(z.string()).default(["prod", "staging"]).optional(),
                teamSlugs: z.array(z.string()).optional(),
                usernames: z.array(z.string()).optional(),
                waitTimer: z.number().int().min(0).max(43200).optional(),
              })
              .optional(),
            actionsPermissions: z
              .object({ policy: z.enum(["all", "selected", "disabled"]) })
              .optional(),
          })
          .optional(),
        dryRun: z.boolean().default(true),
      })
      .strict(),
    handler: async (a: any) => {
      try {
        let findings: ScanFinding[] = a.findings ?? [];
        if (!findings.length) {
          try {
            const r = await clients.repos.get(a.owner, a.repo);
            const def = r.default_branch;
            const sa = r.security_and_analysis || {};
            if (r.private !== true)
              findings.push({ code: "REPO_NOT_PRIVATE", severity: "high" });
            if (sa.secret_scanning?.status !== "enabled")
              findings.push({ code: "REPO_SECRET_SCANNING_DISABLED", severity: "high" });
            if (sa.secret_scanning_push_protection?.status !== "enabled")
              findings.push({ code: "REPO_SECRET_PUSH_PROTECTION_DISABLED", severity: "medium" });
            if (sa.dependabot_security_updates?.status !== "enabled")
              findings.push({ code: "REPO_DEPENDABOT_UPDATES_DISABLED", severity: "low" });
            try {
              await clients.repos.getBranchProtection(a.owner, a.repo, def);
            } catch {
              findings.push({ code: "REPO_BRANCH_PROTECTION_MISSING", severity: "high" });
            }
          } catch {
            // ignore
          }
        }

        const steps = planFromFindings(findings, a.owner, a.repo, a.defaults);
        const key = `${a.owner}/${a.repo}`;

        if (a.dryRun) {
          const report: OrgReport = {
            [key]: {
              plannedSteps: steps.length,
              suggestions: suggestNextStepsForRepo(steps),
            },
          };
          return {
            content: [
              ...mjson({ status: "plan", steps, count: steps.length, report }),
              ...mtext(renderTextReport("### Remediation plan (dry-run)", report)),
            ],
          };
        }

        const results: any[] = [];
        for (const s of steps) {
          try {
            if (s.action === "repos.updateVisibility") {
              const out = (clients as any).repos.update
                ? await (clients as any).repos.update(a.owner, a.repo, {
                    private: s.args.visibility === "private",
                  })
                : { ok: false, note: "repos.update not available in client" };
              results.push({ action: s.action, ok: true, result: out });
            } else if (s.action === "repos.enableSecurityFeatures") {
              const out = await clients.repos.enableSecurityFeatures(
                a.owner,
                a.repo,
                {
                  enableDependabot: !!s.args.enableDependabot,
                  enableAdvancedSecurity: !!s.args.enableAdvancedSecurity,
                }
              );
              results.push({ action: s.action, ok: true, result: out });
            } else if (s.action === "repos.updateBranchProtection") {
              const bp = s.args;
              const out = await clients.repos.updateBranchProtection(
                a.owner,
                a.repo,
                {
                  branch: bp.branch || "main",
                  requiredApprovingReviewCount:
                    bp.requiredApprovingReviewCount ?? 2,
                  requireCodeOwnerReviews: bp.requireCodeOwnerReviews ?? true,
                  dismissStaleReviews: bp.dismissStaleReviews ?? true,
                  enforceAdmins: bp.enforceAdmins ?? true,
                  requireStatusChecks: bp.requireStatusChecks ?? true,
                  requiredStatusChecksContexts:
                    bp.requiredStatusChecksContexts ?? [],
                }
              );
              results.push({ action: s.action, ok: true, result: out });
            } else if (s.action === "actions.upsertEnvironment") {
              const out = (clients as any).actions.upsertEnvironment
                ? await (clients as any).actions.upsertEnvironment(
                    a.owner,
                    a.repo,
                    s.args.environment,
                    s.args
                  )
                : { ok: true, note: "upsertEnvironment not implemented in client" };
              results.push({ action: s.action, ok: true, result: out });
            } else if (s.action === "actions.setPermissions") {
              const out = (clients as any).actions.setPermissions
                ? await (clients as any).actions.setPermissions(
                    a.owner,
                    a.repo,
                    s.args.policy
                  )
                : { ok: true, note: "setPermissions not implemented in client" };
              results.push({ action: s.action, ok: true, result: out });
            } else {
              results.push({ action: s.action, ok: false, error: { message: "unknown action" } });
            }
          } catch (e: any) {
            results.push({ action: s.action, ok: false, error: normalizeGithubError(e) });
          }
        }

        const sum = summarizeResults(results);
        const report: OrgReport = {
          [key]: {
            plannedSteps: steps.length,
            applied: sum.applied,
            failed: sum.failed,
            errors: sum.errors,
            suggestions: suggestNextStepsForRepo(steps, results),
          },
        };

        return {
          content: [
            ...mjson({ status: "done", results, report }),
            ...mtext(renderTextReport("### Remediation results", report)),
          ],
        };
      } catch (e: any) {
        return { content: mjson(normalizeGithubError(e)), isError: true };
      }
    },
  };

  const remediate_org_repos_baseline: ToolDef = {
    name: n("remediate_org_repos_baseline"),
    description:
      "Batch remediate common baseline findings across an org. Supports dry-run planning and returns a per-repo report.",
    inputSchema: z
      .object({
        org: z.string(),
        includeArchived: z.boolean().default(false),
        limit: z.number().int().min(1).max(5000).default(200),
        defaults: z.any().optional(),
        dryRun: z.boolean().default(true),
      })
      .strict(),
    handler: async (a: any) => {
      try {
        const repos = await clients.repos.listForOrg(a.org, {
          includeArchived: a.includeArchived,
        });
        const slice = repos.slice(0, a.limit);
        const plans: Record<string, PlanStep[]> = {};
        const results: Record<string, any[]> = {};
        const report: OrgReport = {};

        for (const r of slice) {
          const repoName = r.name as string;
          const key = `${a.org}/${repoName}`;
          const fs: ScanFinding[] = [];
          if (r.private !== true) fs.push({ code: "REPO_NOT_PRIVATE", severity: "high" });
          const sa = (r as any).security_and_analysis || {};
          if (sa.secret_scanning?.status !== "enabled") fs.push({ code: "REPO_SECRET_SCANNING_DISABLED", severity: "high" });
          if (sa.secret_scanning_push_protection?.status !== "enabled") fs.push({ code: "REPO_SECRET_PUSH_PROTECTION_DISABLED", severity: "medium" });
          const steps = planFromFindings(fs, a.org, repoName, a.defaults);
          plans[key] = steps;

          if (a.dryRun) {
            report[key] = { plannedSteps: steps.length, suggestions: suggestNextStepsForRepo(steps) };
            continue;
          }

          const repoOut: any[] = [];
          for (const s of steps) {
            try {
              if (s.action === "repos.enableSecurityFeatures") {
                const out = await clients.repos.enableSecurityFeatures(a.org, repoName, {
                  enableDependabot: !!s.args.enableDependabot,
                  enableAdvancedSecurity: !!s.args.enableAdvancedSecurity,
                });
                repoOut.push({ action: s.action, ok: true, result: out });
              } else if (s.action === "repos.updateBranchProtection") {
                const bp = s.args;
                const out = await clients.repos.updateBranchProtection(a.org, repoName, {
                  branch: bp.branch || "main",
                  requiredApprovingReviewCount: bp.requiredApprovingReviewCount ?? 2,
                  requireCodeOwnerReviews: bp.requireCodeOwnerReviews ?? true,
                  dismissStaleReviews: bp.dismissStaleReviews ?? true,
                  enforceAdmins: bp.enforceAdmins ?? true,
                  requireStatusChecks: bp.requireStatusChecks ?? true,
                  requiredStatusChecksContexts: bp.requiredStatusChecksContexts ?? [],
                });
                repoOut.push({ action: s.action, ok: true, result: out });
              } else if (s.action === "actions.upsertEnvironment") {
                const out = (clients as any).actions.upsertEnvironment?.(a.org, repoName, s.args.environment, s.args) ?? {
                  ok: true,
                  note: "upsertEnvironment not implemented",
                };
                repoOut.push({ action: s.action, ok: true, result: out });
              } else if (s.action === "actions.setPermissions") {
                const out = (clients as any).actions.setPermissions?.(a.org, repoName, s.args.policy) ?? {
                  ok: true,
                  note: "setPermissions not implemented",
                };
                repoOut.push({ action: s.action, ok: true, result: out });
              }
            } catch (e: any) {
              repoOut.push({ action: s.action, ok: false, error: normalizeGithubError(e) });
            }
          }
          results[key] = repoOut;
          const sum = summarizeResults(repoOut);
          report[key] = {
            plannedSteps: steps.length,
            applied: sum.applied,
            failed: sum.failed,
            errors: sum.errors,
            suggestions: suggestNextStepsForRepo(steps, repoOut),
          };
        }

        return {
          content: [
            ...mjson({ status: a.dryRun ? "plan" : "done", org: a.org, repos: slice.length, plans: a.dryRun ? plans : undefined, results: a.dryRun ? undefined : results, report }),
            ...mtext(renderTextReport(a.dryRun ? "### Remediation plan (org dry-run)" : "### Remediation results (org)", report)),
          ],
        };
      } catch (e: any) {
        return { content: mjson(normalizeGithubError(e)), isError: true };
      }
    },
  };

  const autofix_org_findings: ToolDef = {
    name: n("autofix_org_findings"),
    description:
      "Auto-fix selected finding codes from github.scan_org_repos_baseline output (plan/apply) and return a remediation report.",
    inputSchema: z
      .object({
        org: z.string(),
        findings: z
          .array(
            z.object({
              code: z.string(),
              severity: z.string().optional(),
              meta: z.record(z.any()).optional(),
            })
          )
          .min(1),
        codes: z.array(z.string()).optional(),
        defaults: z
          .object({
            makePrivate: z.boolean().optional().default(false),
            enableSecretScanning: z.boolean().optional().default(true),
            enablePushProtection: z.boolean().optional().default(true),
            enableDependabot: z.boolean().optional().default(true),
            branchProtection: z
              .object({
                branch: z.string().default("main"),
                requiredApprovingReviewCount: z
                  .number()
                  .int()
                  .min(0)
                  .max(6)
                  .default(2),
                requireCodeOwnerReviews: z.boolean().default(true),
                dismissStaleReviews: z.boolean().default(true),
                enforceAdmins: z.boolean().default(true),
                requireStatusChecks: z.boolean().default(true),
                requiredStatusChecksContexts: z.array(z.string()).optional().default([]),
              })
              .partial()
              .optional(),
            requiredStatusChecksContexts: z.array(z.string()).optional(),
            environmentDefaults: z
              .object({
                names: z.array(z.string()).default(["prod", "staging"]).optional(),
                teamSlugs: z.array(z.string()).optional(),
                usernames: z.array(z.string()).optional(),
                waitTimer: z.number().int().min(0).max(43200).optional(),
              })
              .optional(),
            actionsPermissions: z
              .object({ policy: z.enum(["all", "selected", "disabled"]) })
              .optional(),
          })
          .optional(),
        dryRun: z.boolean().default(true),
      })
      .strict(),
    handler: async (a: any) => {
      try {
        const SAFE_DEFAULT_CODES = new Set([
          "REPO_SECRET_SCANNING_DISABLED",
          "REPO_SECRET_PUSH_PROTECTION_DISABLED",
          "REPO_DEPENDABOT_UPDATES_DISABLED",
          "REPO_BRANCH_PROTECTION_MISSING",
          "REPO_REQUIRED_REVIEWERS_TOO_LOW",
          "REPO_STATUS_CHECKS_MISSING",
          "PIPELINE_ENV_NO_REVIEWERS",
        ]);
        const allow = new Set(
          (a.codes && a.codes.length ? a.codes : Array.from(SAFE_DEFAULT_CODES)).map((c: string) => c.toUpperCase())
        );

        const byRepo = new Map<string, ScanFinding[]>();
        for (const f of a.findings as ScanFinding[]) {
          const code = String(f.code).toUpperCase();
          if (!allow.has(code)) continue;
          const owner = (f as any)?.meta?.owner || a.org;
          const repo = (f as any)?.meta?.repo;
          if (!repo) continue;
          const key = `${owner}/${repo}`;
          const list = byRepo.get(key) ?? [];
          list.push(f);
          byRepo.set(key, list);
        }

        const plan: Record<string, PlanStep[]> = {};
        const results: Record<string, any[]> = {};
        const report: OrgReport = {};

        for (const [key, fs] of byRepo) {
          const [owner, repo] = key.split("/");
          const steps = planFromFindings(fs, owner, repo, a.defaults);
          plan[key] = steps;

          if (a.dryRun) {
            report[key] = { plannedSteps: steps.length, suggestions: suggestNextStepsForRepo(steps) };
            continue;
          }

          const out: any[] = [];
          for (const s of steps) {
            try {
              if (s.action === "repos.updateVisibility") {
                const res = (clients as any).repos.update
                  ? await (clients as any).repos.update(owner, repo, { private: s.args.visibility === "private" })
                  : { ok: false, note: "repos.update not available in client" };
                out.push({ action: s.action, ok: true, result: res });
              } else if (s.action === "repos.enableSecurityFeatures") {
                const res = await clients.repos.enableSecurityFeatures(owner, repo, {
                  enableDependabot: !!s.args.enableDependabot,
                  enableAdvancedSecurity: !!s.args.enableAdvancedSecurity,
                });
                out.push({ action: s.action, ok: true, result: res });
              } else if (s.action === "repos.updateBranchProtection") {
                const bp = s.args;
                const res = await clients.repos.updateBranchProtection(owner, repo, {
                  branch: bp.branch || "main",
                  requiredApprovingReviewCount: bp.requiredApprovingReviewCount ?? 2,
                  requireCodeOwnerReviews: bp.requireCodeOwnerReviews ?? true,
                  dismissStaleReviews: bp.dismissStaleReviews ?? true,
                  enforceAdmins: bp.enforceAdmins ?? true,
                  requireStatusChecks: bp.requireStatusChecks ?? true,
                  requiredStatusChecksContexts: bp.requiredStatusChecksContexts ?? [],
                });
                out.push({ action: s.action, ok: true, result: res });
              } else if (s.action === "actions.upsertEnvironment") {
                const res = (clients as any).actions.upsertEnvironment
                  ? await (clients as any).actions.upsertEnvironment(
                      owner,
                      repo,
                      s.args.environment,
                      s.args
                    )
                  : { ok: true, note: "upsertEnvironment not implemented in client" };
                out.push({ action: s.action, ok: true, result: res });
              } else if (s.action === "actions.setPermissions") {
                const res = (clients as any).actions.setPermissions
                  ? await (clients as any).actions.setPermissions(
                      owner,
                      repo,
                      s.args.policy
                    )
                  : { ok: true, note: "setPermissions not implemented in client" };
                out.push({ action: s.action, ok: true, result: res });
              } else {
                out.push({ action: s.action, ok: false, error: { message: "unknown action" } });
              }
            } catch (e: any) {
              out.push({ action: s.action, ok: false, error: normalizeGithubError(e) });
            }
          }
          results[key] = out;
          const sum = summarizeResults(out);
          report[key] = {
            plannedSteps: steps.length,
            applied: sum.applied,
            failed: sum.failed,
            errors: sum.errors,
            suggestions: suggestNextStepsForRepo(steps, out),
          };
        }

        return {
          content: [
            ...mjson({ status: a.dryRun ? "plan" : "done", repos: Array.from(byRepo.keys()), plans: a.dryRun ? plan : undefined, results: a.dryRun ? undefined : results, report }),
            ...mtext(renderTextReport(a.dryRun ? "### Autofix plan (dry-run)" : "### Autofix results", report)),
          ],
        };
      } catch (e: any) {
        return { content: mjson(normalizeGithubError(e)), isError: true };
      }
    },
  };

  const autofix_repo_findings: ToolDef = {
    name: n("autofix_repo_findings"),
    description:
      "Auto-fix selected finding codes for a single repo (plan/apply) and return a remediation report.",
    inputSchema: z
      .object({
        owner: z.string(),
        repo: z.string(),
        findings: z
          .array(
            z.object({
              code: z.string(),
              severity: z.string().optional(),
              meta: z.record(z.any()).optional(),
            })
          )
          .min(1),
        codes: z.array(z.string()).optional(),
        defaults: z
          .object({
            makePrivate: z.boolean().optional().default(false),
            enableSecretScanning: z.boolean().optional().default(true),
            enablePushProtection: z.boolean().optional().default(true),
            enableDependabot: z.boolean().optional().default(true),
            branchProtection: z
              .object({
                branch: z.string().default("main"),
                requiredApprovingReviewCount: z
                  .number()
                  .int()
                  .min(0)
                  .max(6)
                  .default(2),
                requireCodeOwnerReviews: z.boolean().default(true),
                dismissStaleReviews: z.boolean().default(true),
                enforceAdmins: z.boolean().default(true),
                requireStatusChecks: z.boolean().default(true),
                requiredStatusChecksContexts: z.array(z.string()).optional().default([]),
              })
              .partial()
              .optional(),
            requiredStatusChecksContexts: z.array(z.string()).optional(),
            environmentDefaults: z
              .object({
                names: z.array(z.string()).default(["prod", "staging"]).optional(),
                teamSlugs: z.array(z.string()).optional(),
                usernames: z.array(z.string()).optional(),
                waitTimer: z.number().int().min(0).max(43200).optional(),
              })
              .optional(),
            actionsPermissions: z
              .object({ policy: z.enum(["all", "selected", "disabled"]) })
              .optional(),
          })
          .optional(),
        dryRun: z.boolean().default(true),
      })
      .strict(),
    handler: async (a: any) => {
      try {
        const SAFE_DEFAULT_CODES = new Set([
          "REPO_SECRET_SCANNING_DISABLED",
          "REPO_SECRET_PUSH_PROTECTION_DISABLED",
          "REPO_DEPENDABOT_UPDATES_DISABLED",
          "REPO_BRANCH_PROTECTION_MISSING",
          "REPO_REQUIRED_REVIEWERS_TOO_LOW",
          "REPO_STATUS_CHECKS_MISSING",
          "PIPELINE_ENV_NO_REVIEWERS",
        ]);
        const allow = new Set(
          (a.codes && a.codes.length ? a.codes : Array.from(SAFE_DEFAULT_CODES)).map((c: string) => c.toUpperCase())
        );

        const repoFindings = (a.findings as ScanFinding[]).filter((f) =>
          allow.has(String(f.code).toUpperCase())
        );
        const steps = planFromFindings(repoFindings, a.owner, a.repo, a.defaults);
        const key = `${a.owner}/${a.repo}`;

        if (a.dryRun) {
          const report: OrgReport = {
            [key]: { plannedSteps: steps.length, suggestions: suggestNextStepsForRepo(steps) },
          };
          return {
            content: [
              ...mjson({ status: "plan", steps, count: steps.length, report }),
              ...mtext(renderTextReport("### Autofix repo plan (dry-run)", report)),
            ],
          };
        }

        const out: any[] = [];
        for (const s of steps) {
          try {
            if (s.action === "repos.updateVisibility") {
              const res = (clients as any).repos.update
                ? await (clients as any).repos.update(a.owner, a.repo, {
                    private: s.args.visibility === "private",
                  })
                : { ok: false, note: "repos.update not available in client" };
              out.push({ action: s.action, ok: true, result: res });
            } else if (s.action === "repos.enableSecurityFeatures") {
              const res = await clients.repos.enableSecurityFeatures(
                a.owner,
                a.repo,
                {
                  enableDependabot: !!s.args.enableDependabot,
                  enableAdvancedSecurity: !!s.args.enableAdvancedSecurity,
                }
              );
              out.push({ action: s.action, ok: true, result: res });
            } else if (s.action === "repos.updateBranchProtection") {
              const bp = s.args;
              const res = await clients.repos.updateBranchProtection(
                a.owner,
                a.repo,
                {
                  branch: bp.branch || "main",
                  requiredApprovingReviewCount:
                    bp.requiredApprovingReviewCount ?? 2,
                  requireCodeOwnerReviews: bp.requireCodeOwnerReviews ?? true,
                  dismissStaleReviews: bp.dismissStaleReviews ?? true,
                  enforceAdmins: bp.enforceAdmins ?? true,
                  requireStatusChecks: bp.requireStatusChecks ?? true,
                  requiredStatusChecksContexts:
                    bp.requiredStatusChecksContexts ?? [],
                }
              );
              out.push({ action: s.action, ok: true, result: res });
            } else if (s.action === "actions.upsertEnvironment") {
              const res = (clients as any).actions.upsertEnvironment
                ? await (clients as any).actions.upsertEnvironment(
                    a.owner,
                    a.repo,
                    s.args.environment,
                    s.args
                  )
                : { ok: true, note: "upsertEnvironment not implemented in client" };
              out.push({ action: s.action, ok: true, result: res });
            } else if (s.action === "actions.setPermissions") {
              const res = (clients as any).actions.setPermissions
                ? await (clients as any).actions.setPermissions(
                    a.owner,
                    a.repo,
                    s.args.policy
                  )
                : { ok: true, note: "setPermissions not implemented in client" };
              out.push({ action: s.action, ok: true, result: res });
            } else {
              out.push({ action: s.action, ok: false, error: { message: "unknown action" } });
            }
          } catch (e: any) {
            out.push({ action: s.action, ok: false, error: normalizeGithubError(e) });
          }
        }
        const sum = summarizeResults(out);
        const report: OrgReport = {
          [key]: {
            plannedSteps: steps.length,
            applied: sum.applied,
            failed: sum.failed,
            errors: sum.errors,
            suggestions: suggestNextStepsForRepo(steps, out),
          },
        };
        return {
          content: [
            ...mjson({ status: "done", results: out, report }),
            ...mtext(renderTextReport("### Autofix repo results", report)),
          ],
        };
      } catch (e: any) {
        return { content: mjson(normalizeGithubError(e)), isError: true };
      }
    },
  };

  return [
    remediate_repo_baseline,
    remediate_org_repos_baseline,
    autofix_org_findings,
    autofix_repo_findings,
  ];
}
