import { z } from "zod";
import type { ToolDef } from "mcp-http";
import {
  getRepo, listRepos, getBranchProtection, getRepoSecurity,
  createRepo, createRepoFromTemplate, updateBranchProtection,
  enableDependabot, enableSecurityFeatures, upsertCodeowners, createRulesetBasic,
  enableSecrets,
  enableTeamAccess
} from "./utils.js";

////// ----- MCP helpers -----
export const mcpJson = (json: any) => [{ type: "json" as const, json }];
const mcpText = (text: string) => [{ type: "text" as const, text }];

// Governance preflight (inside this MCP)
async function callGovernanceEvaluate(toolFq: string, args: any, context?: any) {
  const url = (process.env.GOVERNANCE_URL || "http://127.0.0.1:8715") + "/mcp";
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: "governance.evaluate",
      arguments: { tool: toolFq, args, context: context || {} }
    }
  };
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await r.json().catch(() => ({}));
  const content = json?.result?.content || [];
  const res = Array.isArray(content) ? (content.find((c:any)=>c.json)?.json || null) : null;
  return res || { decision: "allow", reasons: [], policyIds: [], suggestions: [] };
}

// Turn any Zod schema into a ZodObject you can .extend()
// If the provided schema is not an object, we fall back to a permissive object.
function toObjectSchema<T extends z.ZodTypeAny>(s: T): z.ZodObject<any> {
  const anyS = s as any;
  if (anyS && typeof anyS.extend === "function") {
    return anyS as z.ZodObject<any>;
  }
  return z.object({}).passthrough();
}

function withGovernance<T extends z.ZodTypeAny>(
  toolFq: string,
  schema: T,
  handler: (args: z.infer<T>) => Promise<any>
): ToolDef {
  const base = toObjectSchema(schema);
  const full = base.extend({
    context: z.object({ upn: z.string().optional(), alias: z.string().optional() }).partial().optional(),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  }).strict();

  return {
    name: toolFq,
    description: `Governed ${toolFq}`,
    inputSchema: full,
    handler: async (a: any) => {
      const gov = await callGovernanceEvaluate(toolFq, a, a.context);
      const blocked = gov.decision === "deny";

      if (a.dryRun || !a.confirm || blocked) {
        const prettyArgs = Object.entries(a)
          .filter(([k]) => k !== "confirm" && k !== "dryRun" && k !== "context")
          .map(([k,v]) => `${k} ${typeof v === "string" ? `"${v}"` : JSON.stringify(v)}`)
          .join(" ");

        const lines = [
          `Plan: ${toolFq}`,
          `Governance: ${gov.decision.toUpperCase()}`,
          gov.reasons?.length ? `Reasons: ${gov.reasons.join(" | ")}` : undefined,
          gov.suggestions?.length
            ? `Suggestions:\n${gov.suggestions.map((s:any)=>`- ${s.title ? s.title+': ' : ''}${s.text}`).join("\n")}`
            : undefined,
          "",
          "To proceed, reply with:",
          `@github ${toolFq.split(".")[1]} ${prettyArgs} confirm true`
        ].filter(Boolean).join("\n");

        return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", governance: gov, planArgs: a }), ...mcpText(lines)] };
      }

      try {
        const out = await handler(a);
        return { content: [...mcpJson({ status: "done", governance: gov, result: out })] };
      } catch (e: any) {
        return { content: [...mcpText(`Call failed: ${e?.message || String(e)}`)], isError: true };
      }
    }
  };
}

// -------------------- READ TOOLS --------------------

const t_listRepos: ToolDef = {
  name: "github.list_repos",
  description: "List repositories for an org/user.",
  inputSchema: z.object({
    owner: z.string(),
    perPage: z.number().int().min(1).max(200).default(100)
  }).strict(),
  handler: async (a) => {
    const repos = await listRepos(a.owner, a.perPage);
    return { content: [...mcpJson(repos)] };
  }
};

const t_getRepo: ToolDef = {
  name: "github.get_repo",
  description: "Get a single repository.",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string()
  }).strict(),
  handler: async (a) => {
    const r = await getRepo(a.owner, a.repo);
    return { content: [...mcpJson(r)] };
  }
};

const t_getBranchProtection: ToolDef = {
  name: "github.get_branch_protection",
  description: "Read branch protection for a branch (best-effort).",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    branch: z.string().default("main")
  }).strict(),
  handler: async (a) => {
    const p = await getBranchProtection(a.owner, a.repo, a.branch);
    return { content: [...mcpJson(p)] };
  }
};

const t_getRepoSecurity: ToolDef = {
  name: "github.get_repo_security",
  description: "Best-effort indicators for Dependabot/Secret scanning/Push protection.",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string()
  }).strict(),
  handler: async (a) => {
    const s = await getRepoSecurity(a.owner, a.repo);
    return { content: [...mcpJson(s)] };
  }
};

// -------------------- WRITE TOOLS (governed) --------------------

const t_createRepo = withGovernance(
  "github.create_repo",
  z.object({
    owner: z.string(),
    name: z.string().regex(/^[a-z0-9-]+$/, "kebab-case only"),
    visibility: z.enum(["private", "public", "internal"]).default("private"),
    description: z.string().optional(),
  }),
  async (a) => {
    return await createRepo(a.owner, a.name, { visibility: a.visibility, description: a.description });
  }
);

const t_createRepoFromTemplate = withGovernance(
  "github.create_repo_from_template",
  z.object({
    owner: z.string(),
    templateOwner: z.string(),
    templateRepo: z.string(),
    newRepoName: z.string().regex(/^[a-z0-9-]+$/, "kebab-case only"),
    description: z.string().optional(),
    includeAllBranches: z.boolean().default(false),
    visibility: z.enum(["private", "public", "internal"]).default("private"),
    teamSlug: z.string().optional(),
  }),
  async (a) => {
    return await createRepoFromTemplate(
      a.templateOwner, a.templateRepo, a.owner, a.newRepoName,
      { private: a.visibility !== "public", description: a.description, includeAllBranches: a.includeAllBranches, teamSlug: a.teamSlug }
    );
  }
);

const t_protectBranch = withGovernance(
  "github.protect_branch",
  z.object({
    owner: z.string(),
    repo: z.string(),
    branch: z.string().default("main"),
    requireApprovals: z.number().int().min(0).default(1),
    requireCodeOwnerReviews: z.boolean().default(true),
    enforceAdmins: z.boolean().default(true),
    allowForcePushes: z.boolean().default(false),
  }),
  async (a) => {
    return await updateBranchProtection(a.owner, a.repo, a.branch, {
      required_approving_review_count: a.requireApprovals,
      require_code_owner_reviews: a.requireCodeOwnerReviews,
      enforce_admins: a.enforceAdmins,
      allow_force_pushes: a.allowForcePushes,
    });
  }
);

const t_enableDependabot = withGovernance(
  "github.enable_dependabot",
  z.object({
    owner: z.string(),
    repo: z.string(),
  }),
  async (a) => {
    return await enableDependabot(a.owner, a.repo);
  }
);

// NEW: enable repo security features (secret scanning, push protection, dependabot security updates)
const t_enableRepoSecurity = withGovernance(
  "github.enable_repo_security",
  z.object({
    owner: z.string(),
    repo: z.string(),
    secretScanning: z.boolean().default(true),
    pushProtection: z.boolean().default(true),
    dependabotSecurityUpdates: z.boolean().default(true),
  }),
  async (a) => {
    return await enableSecurityFeatures(a.owner, a.repo, {
      secretScanning: a.secretScanning,
      pushProtection: a.pushProtection,
      dependabotSecurityUpdates: a.dependabotSecurityUpdates,
    });
  }
);

// NEW: upsert CODEOWNERS
const t_addCodeowners = withGovernance(
  "github.add_codeowners",
  z.object({
    owner: z.string(),
    repo: z.string(),
    // Either provide raw content string…
    content: z.string().optional(),
    // …or a simple mapping like { "/src/*": ["@navy/org-admins", "@navy/platform"] }
    entries: z.record(z.array(z.string())).optional(),
    path: z.string().default(".github/CODEOWNERS"),
    message: z.string().optional()
  }).refine(v => !!v.content || !!v.entries, { message: "Provide 'content' or 'entries'." }),
  async (a) => {
    let content = a.content;
    if (!content && a.entries) {
      const lines: string[] = ["# CODEOWNERS generated by github-mcp"];
      for (const [glob, owners] of Object.entries(a.entries)) {
        lines.push(`${glob} ${(owners as string[]).join(" ")}`);
      }
      content = lines.join("\n") + "\n";
    }
    return await upsertCodeowners(a.owner, a.repo, content!, a.path, a.message);
  }
);

// NEW: minimal repository ruleset
const t_createRulesetBasic = withGovernance(
  "github.create_ruleset_basic",
  z.object({
    owner: z.string(),
    repo: z.string(),
    name: z.string().default("baseline-protection"),
    branch: z.string().optional(),
    requireApprovals: z.number().int().min(0).default(1),
    requireCodeOwnerReviews: z.boolean().default(true),
    blockForcePushes: z.boolean().default(true),
  }),
  async (a) => {
    return await createRulesetBasic(a.owner, a.repo, {
      name: a.name,
      branch: a.branch,
      requireApprovals: a.requireApprovals,
      requireCodeOwnerReviews: a.requireCodeOwnerReviews,
      blockForcePushes: a.blockForcePushes
    });
  }
);

// -------------------- Natural-language wizard --------------------

const t_repoWizard: ToolDef = {
  name: "github.repo_tool_wizard",
  description: "Natural-language helper to create a repo fresh or from a template (governed).",
  inputSchema: z.object({
    request: z.string(),
    owner: z.string().optional(),
    visibility: z.enum(["private", "public", "internal"]).default("private"),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(true),
    context: z.object({ upn: z.string().optional(), alias: z.string().optional() }).partial().optional()
  }).strict(),
  handler: async (a) => {
    const text = a.request || "";
    const owner = a.owner || /owner\s*[:=]?\s*([A-Za-z0-9._-]+)/i.exec(text)?.[1];
    const tmpl = /template\s+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/i.exec(text);
    const name = /repo\s+([a-z0-9-]{2,})/i.exec(text)?.[1] || /name\s*[:=]?\s*"([a-z0-9-]{2,})"/i.exec(text)?.[1];

    if (!owner || !name) {
      return { content: [...mcpText(`Please include owner and repo name. Example:\n"Create a private repo repo nav-data-pipeline owner navy-org from template navy-org/ts-template"`)] };
    }

    if (tmpl) {
      const payload = {
        owner, templateOwner: tmpl[1], templateRepo: tmpl[2],
        newRepoName: name, visibility: a.visibility, confirm: a.confirm, dryRun: a.dryRun, context: a.context
      };

      // 1) Create repo
      const gov = await callGovernanceEvaluate("github.create_repo_from_template", payload, a.context);
      const blocked = gov.decision === "deny";
      if (a.dryRun || !a.confirm || blocked) {
        const lines = [
          `Plan: github.create_repo_from_template ${tmpl[1]}/${tmpl[2]} -> ${owner}/${name}`,
          `Governance: ${gov.decision.toUpperCase()}`,
          gov.reasons?.length ? `Reasons: ${gov.reasons.join(" | ")}` : undefined,
          "",
          "To proceed, reply with:",
          `@github create_repo_from_template owner "${owner}" templateOwner "${tmpl[1]}" templateRepo "${tmpl[2]}" newRepoName "${name}" visibility "${a.visibility}" confirm true`
        ].filter(Boolean).join("\n");
        return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", governance: gov, planArgs: payload }), ...mcpText(lines)] };
      }
      const out = await createRepoFromTemplate(tmpl[1], tmpl[2], owner, name, { private: a.visibility !== "public" });
      return { content: [...mcpJson({ status: "done", result: out })] };
    }

    const payload = { owner, name, visibility: a.visibility, confirm: a.confirm, dryRun: a.dryRun, context: a.context };
    const gov = await callGovernanceEvaluate("github.create_repo", payload, a.context);
    const blocked = gov.decision === "deny";
    if (a.dryRun || !a.confirm || blocked) {
      const lines = [
        `Plan: github.create_repo ${owner}/${name}`,
        `Governance: ${gov.decision.toUpperCase()}`,
        gov.reasons?.length ? `Reasons: ${gov.reasons.join(" | ")}` : undefined,
        "",
        "To proceed, reply with:",
        `@github create_repo owner "${owner}" name "${name}" visibility "${a.visibility}" confirm true`
      ].filter(Boolean).join("\n");
      return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", governance: gov, planArgs: payload }), ...mcpText(lines)] };
    }
    const repo = await createRepo(owner, name, { visibility: a.visibility });
    
    // 2) CODEOWNERS
    const codeowners = a.context?.codeowners || [];
    if (codeowners.length) {
      const payload = { owner, name, codeowners };
      const gov = await callGovernanceEvaluate("github.create_codeowners", payload, a.context);
      const blocked = gov.decision === "deny";
      if (a.dryRun || !a.confirm || blocked) {
        const lines = [
          `Plan: github.create_codeowners ${owner}/${name}`,
          `Governance: ${gov.decision.toUpperCase()}`,
          gov.reasons?.length ? `Reasons: ${gov.reasons.join(" | ")}` : undefined,
          "",
          "To proceed, reply with:",
          `@github create_codeowners owner "${owner}" name "${name}" codeowners ${JSON.stringify(codeowners)} confirm true`
        ].filter(Boolean).join("\n");
        return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", governance: gov, planArgs: payload }), ...mcpText(lines)] };
      }
      const out = await upsertCodeowners(owner, name, codeowners);
      return { content: [...mcpJson({ status: "done", result: out })] };
    }

    // 3) Branch protection
    const branchProtection = a.context?.branchProtection || [];
    if (branchProtection.length) {
      const payload = { owner, name, branchProtection };
      const gov = await callGovernanceEvaluate("github.create_branch_protection", payload, a.context);
      const blocked = gov.decision === "deny";
      if (a.dryRun || !a.confirm || blocked) {
        const lines = [
          `Plan: github.create_branch_protection ${owner}/${name}`,
          `Governance: ${gov.decision.toUpperCase()}`,
          gov.reasons?.length ? `Reasons: ${gov.reasons.join(" | ")}` : undefined,
          "",
          "To proceed, reply with:",
          `@github create_branch_protection owner "${owner}" name "${name}" branchProtection ${JSON.stringify(branchProtection)} confirm true`
        ].filter(Boolean).join("\n");
        return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", governance: gov, planArgs: payload }), ...mcpText(lines)] };
      }
      const out = await updateBranchProtection(owner, name, "main", branchProtection);
      return { content: [...mcpJson({ status: "done", result: out })] };
    }

    // 4) Security features
    const securityFeatures = a.context?.securityFeatures || [];
    if (securityFeatures.length) {
      const payload = { owner, name, securityFeatures };
      const gov = await callGovernanceEvaluate("github.create_security_features", payload, a.context);
      const blocked = gov.decision === "deny";
      if (a.dryRun || !a.confirm || blocked) {
        const lines = [
          `Plan: github.create_security_features ${owner}/${name}`,
          `Governance: ${gov.decision.toUpperCase()}`,
          gov.reasons?.length ? `Reasons: ${gov.reasons.join(" | ")}` : undefined,
          "",
          "To proceed, reply with:",
          `@github create_security_features owner "${owner}" name "${name}" securityFeatures ${JSON.stringify(securityFeatures)} confirm true`
        ].filter(Boolean).join("\n");
        return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", governance: gov, planArgs: payload }), ...mcpText(lines)] };
      }
      const out = await enableSecurityFeatures(owner, name, securityFeatures);
      return { content: [...mcpJson({ status: "done", result: out })] };
    }

    // 5) Secrets
    const secrets = a.context?.secrets || [];
    if (secrets.length) {
      const payload = { owner, name, secrets };
      const gov = await callGovernanceEvaluate("github.create_secrets", payload, a.context);
      const blocked = gov.decision === "deny";
      if (a.dryRun || !a.confirm || blocked) {
        const lines = [
          `Plan: github.create_secrets ${owner}/${name}`,
          `Governance: ${gov.decision.toUpperCase()}`,
          gov.reasons?.length ? `Reasons: ${gov.reasons.join(" | ")}` : undefined,
          "",
          "To proceed, reply with:",
          `@github create_secrets owner "${owner}" name "${name}" secrets ${JSON.stringify(secrets)} confirm true`
        ].filter(Boolean).join("\n");
        return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", governance: gov, planArgs: payload }), ...mcpText(lines)] };
      }
      const out = await enableSecrets(owner, name, secrets);
      return { content: [...mcpJson({ status: "done", result: out })] };
    }

    // 6) Team access (optional)
    const teamAccess = a.context?.teamAccess || [];
    if (teamAccess.length) {
      const payload = { owner, name, teamAccess };
      const gov = await callGovernanceEvaluate("github.create_team_access", payload, a.context);
      const blocked = gov.decision === "deny";
      if (a.dryRun || !a.confirm || blocked) {
        const lines = [
          `Plan: github.create_team_access ${owner}/${name}`,
          `Governance: ${gov.decision.toUpperCase()}`,
          gov.reasons?.length ? `Reasons: ${gov.reasons.join(" | ")}` : undefined,
          "",
          "To proceed, reply with:",
          `@github create_team_access owner "${owner}" name "${name}" teamAccess ${JSON.stringify(teamAccess)} confirm true`
        ].filter(Boolean).join("\n");
        return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", governance: gov, planArgs: payload }), ...mcpText(lines)] };
      }
      const out = await enableTeamAccess(owner, name, teamAccess);
      return { content: [...mcpJson({ status: "done", result: out })] };
    }

    return { content: [...mcpJson({ status: "done", result: repo })] };
  }
};

// Export all tools
export const tools: ToolDef[] = [
  // READ
  t_listRepos,
  t_getRepo,
  t_getBranchProtection,
  t_getRepoSecurity,
  // WRITE (governed)
  t_createRepo,
  t_createRepoFromTemplate,
  t_protectBranch,
  t_enableDependabot,
  // NEW
  t_enableRepoSecurity,
  t_addCodeowners,
  t_createRulesetBasic,
  // Wizard
  t_repoWizard
];


