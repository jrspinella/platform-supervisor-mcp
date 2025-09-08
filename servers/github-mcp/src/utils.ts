import fs from "node:fs";
import path from "node:path";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

const APP_ID = process.env.GITHUB_APP_ID || "";
const PRIVATE_KEY = (process.env.GITHUB_APP_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const INSTALLATION_ID_ENV = process.env.GITHUB_APP_INSTALLATION_ID || "";
const BASE_URL = process.env.GITHUB_API_URL || undefined; // e.g. https://github.enterprise.mil/api/v3

// Simple audit
const AUDIT_DIR = process.env.AUDIT_DIR || path.resolve(process.cwd(), "audit");
function auditWrite(event: any) {
  try {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
    const file = path.join(AUDIT_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  } catch {}
}

// --- installation cache (per owner) ---
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
const INSTALL_CACHE_FILE = process.env.GITHUB_INSTALL_CACHE || path.join(DATA_DIR, "gh-install-cache.json");

function loadInstallCache(): Record<string, number> {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(INSTALL_CACHE_FILE)) return {};
    const raw = fs.readFileSync(INSTALL_CACHE_FILE, "utf8");
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
function saveInstallCache(map: Record<string, number>) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INSTALL_CACHE_FILE, JSON.stringify(map, null, 2), "utf8");
  } catch {}
}


const installCache = loadInstallCache();

// --- Octokit factories ---
function makeAppOctokit(): Octokit {
  if (!APP_ID || !PRIVATE_KEY) throw new Error("GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing");
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: APP_ID, privateKey: PRIVATE_KEY },
    baseUrl: BASE_URL,
  });
}

const octoCache = new Map<string, Octokit>();

async function resolveInstallationIdForOwner(owner: string): Promise<number> {
  if (INSTALLATION_ID_ENV) return Number(INSTALLATION_ID_ENV);
  const key = owner.toLowerCase();

  if (installCache[key]) return installCache[key];

  const appOcto = makeAppOctokit();
  const installations = await appOcto.paginate(appOcto.apps.listInstallations, { per_page: 100 });
  const hit = installations.find((i: any) => i.account?.login?.toLowerCase() === key);
  if (!hit) throw new Error(`No installation found for owner '${owner}'`);

  installCache[key] = hit.id as number;
  saveInstallCache(installCache);
  return hit.id as number;
}

export async function getOctokitForOwner(owner?: string): Promise<Octokit> {
  const installationId = owner ? await resolveInstallationIdForOwner(owner) : Number(INSTALLATION_ID_ENV);
  if (!installationId) throw new Error("GITHUB_APP_INSTALLATION_ID is required when owner is not provided");

  const cacheKey = `${installationId}`;
  if (octoCache.has(cacheKey)) return octoCache.get(cacheKey)!;

  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: APP_ID, privateKey: PRIVATE_KEY, installationId },
    baseUrl: BASE_URL,
  });
  octoCache.set(cacheKey, octokit);
  return octokit;
}

// ============ READS ============

export async function getRepo(owner: string, repo: string) {
  const octo = await getOctokitForOwner(owner);
  const r = await octo.repos.get({ owner, repo });
  return r.data;
}

export async function listRepos(owner: string, perPage = 100) {
  const octo = await getOctokitForOwner(owner);
  // Prefer org listing; fall back to user
  try {
    const repos = await octo.paginate(octo.repos.listForOrg, { org: owner, per_page: perPage });
    return repos;
  } catch (e: any) {
    if (e.status !== 404 && e.status !== 422) throw e;
    const repos = await octo.paginate(octo.repos.listForUser, { username: owner, per_page: perPage });
    return repos;
  }
}

export async function getBranchProtection(owner: string, repo: string, branch: string) {
  const octo = await getOctokitForOwner(owner);
  try {
    const res = await octo.repos.getBranchProtection({ owner, repo, branch });
    // Normalize a few key toggles
    return {
      required_pull_request_reviews: res.data.required_pull_request_reviews || null,
      enforce_admins: res.data.enforce_admins || { enabled: false },
      allow_force_pushes: res.data.allow_force_pushes || { enabled: false },
      required_status_checks: res.data.required_status_checks || null,
    };
  } catch (e: any) {
    // 403/404 => treat as "no protection"
    return {
      required_pull_request_reviews: null,
      enforce_admins: { enabled: false },
      allow_force_pushes: { enabled: false },
      required_status_checks: null,
      _note: e?.status ? `protection unavailable: ${e.status}` : "protection unavailable"
    };
  }
}

export async function getRepoSecurity(owner: string, repo: string) {
  const octo = await getOctokitForOwner(owner);
  const r = await octo.repos.get({ owner, repo });
  const saa = (r.data as any).security_and_analysis || {};

  // Check vulnerability alerts (Dependabot) via GET (204 when enabled, 404 when disabled)
  let dependabotEnabled = false;
  try {
    await octo.request("GET /repos/{owner}/{repo}/vulnerability-alerts", { owner, repo });
    dependabotEnabled = true;
  } catch { dependabotEnabled = false; }

  // Secret scanning enabled? If we can list alerts, it’s enabled
  let secretScanningEnabled = false;
  try {
    await octo.request("GET /repos/{owner}/{repo}/secret-scanning/alerts", { owner, repo, per_page: 1 });
    secretScanningEnabled = true;
  } catch { secretScanningEnabled = false; }

  const pushProt = saa?.secret_scanning_push_protection?.status === "enabled";

  return {
    dependabotAlertsEnabled: dependabotEnabled,
    secretScanningEnabled,
    secretScanningPushProtectionEnabled: pushProt,
    _security_and_analysis: saa
  };
}

// ============ WRITES ============

export async function createRepo(owner: string, name: string, opts: {
  visibility?: "private" | "public" | "internal";
  description?: string;
}) {
  const octo = await getOctokitForOwner(owner);
  // Map "internal" to "private" since GitHub API doesn't support "internal" visibility
  const apiVisibility = opts.visibility === "internal" ? "private" : opts.visibility;
  try {
    const res = await octo.repos.createInOrg({
      org: owner, name,
      visibility: apiVisibility || "private",
      description: opts.description || ""
    });
    return res.data;
  } catch (e: any) {
    if (e.status !== 404 && e.status !== 422) throw e;
    // Fallback to user-owned (if the installation is on a user)
    const res = await octo.repos.createForAuthenticatedUser({
      name,
      visibility: apiVisibility || "private",
      description: opts.description || ""
    });
    return res.data;
  }
}

export async function createRepoFromTemplate(templateOwner: string, templateRepo: string, owner: string, newRepoName: string, opts?: {
  private?: boolean;
  description?: string;
  includeAllBranches?: boolean;
  teamSlug?: string;
}) {
  const octo = await getOctokitForOwner(owner);
  const res = await octo.repos.createUsingTemplate({
    template_owner: templateOwner,
    template_repo: templateRepo,
    owner,
    name: newRepoName,
    include_all_branches: !!opts?.includeAllBranches,
    private: opts?.private ?? true,
    description: opts?.description || "",
    team_slug: opts?.teamSlug
  });
  return res.data;
}

export async function updateBranchProtection(owner: string, repo: string, branch: string, cfg: {
  required_approving_review_count?: number;
  require_code_owner_reviews?: boolean;
  enforce_admins?: boolean;
  allow_force_pushes?: boolean;
}) {
  const octo = await getOctokitForOwner(owner);
  const res = await octo.repos.updateBranchProtection({
    owner, repo, branch,
    required_status_checks: null,
    enforce_admins: cfg.enforce_admins ?? true,
    required_pull_request_reviews: {
      required_approving_review_count: cfg.required_approving_review_count ?? 1,
      require_code_owner_reviews: cfg.require_code_owner_reviews ?? true
    },
    restrictions: null,
    allow_force_pushes: cfg.allow_force_pushes ?? false,
    allow_deletions: false
  });
  return res.data;
}

export async function enableDependabot(owner: string, repo: string) {
  const octo = await getOctokitForOwner(owner);
  // 204 No Content on success
  await octo.request("PUT /repos/{owner}/{repo}/vulnerability-alerts", { owner, repo });
  return { ok: true };
}

export async function enableSecrets(owner: string, repo: string, secrets: Array<{ name: string; value: string }>) {
  const octo = await getOctokitForOwner(owner);
  const res = await octo.request("PUT /repos/{owner}/{repo}/actions/secrets", {
    owner,
    repo,
    secrets
  });
  return res.data;
}

// Enable repo security features via the repo update API (best-effort on GHES)
export async function enableSecurityFeatures(owner: string, repo: string, opts: {
  secretScanning?: boolean;
  pushProtection?: boolean;
  dependabotSecurityUpdates?: boolean;
}) {
  const octo = await getOctokitForOwner(owner);
  const payload: any = { owner, repo, security_and_analysis: {} as any };

  if (opts.secretScanning !== undefined) {
    payload.security_and_analysis.secret_scanning = { status: opts.secretScanning ? "enabled" : "disabled" };
  }
  if (opts.pushProtection !== undefined) {
    payload.security_and_analysis.secret_scanning_push_protection = { status: opts.pushProtection ? "enabled" : "disabled" };
  }
  if (opts.dependabotSecurityUpdates !== undefined) {
    payload.security_and_analysis.dependabot_security_updates = { status: opts.dependabotSecurityUpdates ? "enabled" : "disabled" };
  }

  const res = await octo.repos.update(payload);
  return res.data;
}

// Create/update CODEOWNERS file
export async function upsertCodeowners(owner: string, repo: string, content: string, pathRel = ".github/CODEOWNERS", message?: string) {
  const octo = await getOctokitForOwner(owner);
  let sha: string | undefined;
  try {
    const cur = await octo.repos.getContent({ owner, repo, path: pathRel });
    if (!Array.isArray(cur.data) && "sha" in cur.data) {
      sha = (cur.data as any).sha;
    }
  } catch { /* not exists */ }

  const res = await octo.repos.createOrUpdateFileContents({
    owner, repo,
    path: pathRel,
    message: message || "chore: update CODEOWNERS",
    content: Buffer.from(content).toString("base64"),
    sha
  });
  return res.data;
}

// Minimal Repository Ruleset (require PR reviews, block force pushes)
export async function createRulesetBasic(owner: string, repo: string, cfg: {
  name: string;
  branch?: string;                 // default: default branch
  requireApprovals?: number;       // default: 1
  requireCodeOwnerReviews?: boolean; // default: true
  blockForcePushes?: boolean;      // default: true
}) {
  const octo = await getOctokitForOwner(owner);
  const repoInfo = await octo.repos.get({ owner, repo });
  const defaultBranch = repoInfo.data.default_branch || "main";
  const branch = cfg.branch || defaultBranch;

  // API: POST /repos/{owner}/{repo}/rulesets
  const res = await octo.request("POST /repos/{owner}/{repo}/rulesets", {
    owner, repo,
    name: cfg.name,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: [branch], exclude: [] }
    },
    // Minimal rules: pull_request + non-fast-forward (block force push)
    rules: [
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: cfg.requireApprovals ?? 1,
          require_code_owner_review: cfg.requireCodeOwnerReviews ?? true,
          dismiss_stale_reviews_on_push: true,
          require_last_push_approval: false,
          required_review_thread_resolution: false
        }
      },
      {
        type: "non_fast_forward"
      }
    ],
    headers: {
      // rulesets are GA on dotcom; preview headers are safe on GHES
      "accept": "application/vnd.github+json"
    }
  });

  return res.data;
}

export async function enableTeamAccess(owner: string, repo: string, teamAccess: Array<{ teamId: string; permission: string }>) {
  const octo = await getOctokitForOwner(owner);
  const res = await octo.request("PUT /repos/{owner}/{repo}/teams", {
    owner,
    repo,
    teams: teamAccess
  });
  return res.data;
}
