import "dotenv/config";
import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import Mustache from "mustache";

const PORT = Number(process.env.PORT ?? 8715);
const RULES_FILE = process.env.GOVERNANCE_RULES_DIR || path.resolve(process.cwd(), "governance/rules.yaml");

type Rules = {
  naming?: {
    resourceGroup?: {
      pattern?: string;                 // e.g. ^rg-[a-z0-9-]{3,40}$
      forbiddenWords?: string[];        // denylist
      maxLength?: number;
      normalize?: { toLower?: boolean; replaceSpacesWithHyphen?: boolean };
      reservedPrefixes?: string[];
      allowedLocations?: string[];      // e.g. ["usgovvirginia","usgovarizona"]
    };
    repo?: {
      pattern?: string;                  // e.g. ^[a-z0-9._-]{3,100}$
      forbiddenWords?: string[];
      privateOnly?: boolean;
    };
    teamsChannel?: {
      pattern?: string;
      forbiddenWords?: string[];
    };
  };
  tags?: {
    required?: Record<string, string | { anyOf?: string[]; pattern?: string }>;
    // Example:
    // required: { owner: ".+@.+", env: { anyOf: ["dev","test","prod"] } }
  };
  templates?: {
    allowedDomains?: string[];          // where Bicep/ARM can be fetched from
  };
  governance?: {
    blockWords?: string[];              // global low-effort deny list (e.g., ["cookies","cream"])
  };
};

function loadRules(): Rules {
  if (!fs.existsSync(RULES_FILE)) {
    return {};
  }
  const raw = fs.readFileSync(RULES_FILE, "utf8");
  const doc = yaml.load(raw) as Rules;
  return doc || {};
}

function regexOk(rx: string | undefined, s: string): boolean {
  if (!rx) return true;
  try {
    const re = new RegExp(rx);
    return re.test(s);
  } catch {
    return false;
  }
}

function containsForbidden(s: string, words?: string[]): string[] {
  if (!words?.length) return [];
  const lower = s.toLowerCase();
  return words.filter(w => lower.includes(w.toLowerCase()));
}

// ---- Zod schemas for tool inputs ----
const preflightSchema = z.object({
  action: z.string(),                 // e.g., "azure.create_resource_group", "github.create_repo", "azure.deploy_bicep_rg_from_url"
  params: z.record(z.any()).default({}),
  context: z.object({
    userUpn: z.string().optional(),
    audience: z.string().optional()
  }).partial().default({})
}).strict();

const validateNameSchema = z.object({
  resourceType: z.enum(["ResourceGroup","GitHubRepo","TeamsChannel"]),
  name: z.string(),
  location: z.string().optional(),     // for RG/location checks
  visibility: z.enum(["private","public","internal"]).optional()
}).strict();

const enforceTagsSchema = z.object({
  scope: z.string(),                   // informational only (e.g. /subscriptions/.../resourceGroups/rg-x)
  tags: z.record(z.string()).default({}),
}).strict();

// ---- Validators ----
function validateResourceGroupName(rules: Rules, name: string, location?: string) {
  const out: { valid: boolean; reasons: string[]; normalized?: string } = { valid: true, reasons: [] };
  const r = rules.naming?.resourceGroup;

  // normalize suggestion
  let normalized = name;
  if (r?.normalize?.toLower) normalized = normalized.toLowerCase();
  if (r?.normalize?.replaceSpacesWithHyphen) normalized = normalized.replace(/\s+/g, "-");
  if (normalized !== name) out.normalized = normalized;

  if (r?.pattern && !regexOk(r.pattern, normalized)) {
    out.valid = false;
    out.reasons.push(`Name does not match pattern ${r.pattern}`);
  }
  if (r?.maxLength && normalized.length > r.maxLength) {
    out.valid = false;
    out.reasons.push(`Name length ${normalized.length} exceeds maxLength ${r.maxLength}`);
  }
  const hits = containsForbidden(normalized, r?.forbiddenWords);
  if (hits.length) {
    out.valid = false;
    out.reasons.push(`Name contains forbidden word(s): ${hits.join(", ")}`);
  }
  if (r?.reservedPrefixes?.length) {
    const badPrefix = r.reservedPrefixes.find(p => normalized.startsWith(p));
    if (badPrefix) {
      out.valid = false;
      out.reasons.push(`Name cannot start with reserved prefix '${badPrefix}'`);
    }
  }
  if (location && r?.allowedLocations?.length && !r.allowedLocations.includes(location)) {
    out.valid = false;
    out.reasons.push(`Location '${location}' not allowed (allowed: ${r.allowedLocations.join(", ")})`);
  }
  return out;
}

function validateRepoName(rules: Rules, name: string, visibility?: "private"|"public"|"internal") {
  const out: { valid: boolean; reasons: string[] } = { valid: true, reasons: [] };
  const r = rules.naming?.repo;
  if (r?.pattern && !regexOk(r.pattern, name)) {
    out.valid = false;
    out.reasons.push(`Repo name does not match pattern ${r.pattern}`);
  }
  const hits = containsForbidden(name, r?.forbiddenWords);
  if (hits.length) {
    out.valid = false;
    out.reasons.push(`Repo name contains forbidden word(s): ${hits.join(", ")}`);
  }
  if (r?.privateOnly && visibility && visibility !== "private") {
    out.valid = false;
    out.reasons.push("Repos must be private by policy");
  }
  return out;
}

function validateTeamsChannelName(rules: Rules, name: string) {
  const out: { valid: boolean; reasons: string[] } = { valid: true, reasons: [] };
  const r = rules.naming?.teamsChannel;
  if (r?.pattern && !regexOk(r.pattern, name)) {
    out.valid = false;
    out.reasons.push(`Channel name does not match pattern ${r.pattern}`);
  }
  const hits = containsForbidden(name, r?.forbiddenWords);
  if (hits.length) {
    out.valid = false;
    out.reasons.push(`Channel name contains forbidden word(s): ${hits.join(", ")}`);
  }
  return out;
}

function validateRequiredTags(rules: Rules, tags: Record<string,string>) {
  const problems: string[] = [];
  const req = rules.tags?.required || {};
  for (const [k, v] of Object.entries(req)) {
    const have = tags[k];
    if (typeof v === "string") {
      // treat as regex
      if (!have || !regexOk(v, have)) {
        problems.push(`Tag '${k}' missing or does not match pattern '${v}'`);
      }
    } else if (typeof v === "object" && v) {
      if (v.anyOf && (!have || !v.anyOf.includes(have))) {
        problems.push(`Tag '${k}' must be one of: ${v.anyOf.join(", ")}`);
      }
      if (v.pattern && (!have || !regexOk(v.pattern, have))) {
        problems.push(`Tag '${k}' must match pattern '${v.pattern}'`);
      }
    }
  }
  return problems;
}

// ---- Tools ----
const tools = [
  {
    name: "governance.ping",
    description: "Health check",
    inputSchema: z.object({}).strict(),
    handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] })
  },
  {
    name: "governance.get_rules",
    description: "Return the current governance rules (from YAML).",
    inputSchema: z.object({}).strict(),
    handler: async () => ({ content: [{ type: "json" as const, json: loadRules() }] })
  },
  {
    name: "governance.validate_name",
    description: "Validate a name for a resource type against policy (and suggest normalized).",
    inputSchema: validateNameSchema,
    handler: async (args: z.infer<typeof validateNameSchema>) => {
      const rules = loadRules();
      const globalHits = containsForbidden(args.name, rules.governance?.blockWords);
      if (globalHits.length) {
        return { content: [{ type: "json" as const, json: { valid: false, reasons: [`Contains forbidden word(s): ${globalHits.join(", ")}`] } }] };
      }

      if (args.resourceType === "ResourceGroup") {
        const r = validateResourceGroupName(rules, args.name, args.location);
        return { content: [{ type: "json" as const, json: r }] };
      }
      if (args.resourceType === "GitHubRepo") {
        const r = validateRepoName(rules, args.name, args.visibility);
        return { content: [{ type: "json" as const, json: r }] };
      }
      if (args.resourceType === "TeamsChannel") {
        const r = validateTeamsChannelName(rules, args.name);
        return { content: [{ type: "json" as const, json: r }] };
      }
      return { content: [{ type: "json" as const, json: { valid: true, reasons: [] } }] };
    }
  },
  {
    name: "governance.enforce_tags",
    description: "Validate required tags and return (optionally normalized) tags.",
    inputSchema: enforceTagsSchema,
    handler: async (args: z.infer<typeof enforceTagsSchema>) => {
      const rules = loadRules();
      const problems = validateRequiredTags(rules, args.tags || {});
      return { content: [{ type: "json" as const, json: { ok: problems.length === 0, problems, tags: args.tags || {} } }] };
    }
  },
  {
    name: "governance.preflight",
    description: "Evaluate a planned action and decide allow/deny with reasons.",
    inputSchema: preflightSchema,
    handler: async (args: z.infer<typeof preflightSchema>) => {
      const rules = loadRules();
      const { action, params } = args;
      const reasons: string[] = [];
      let allow = true;

      // very simple domain allowlist for template URLs
      function checkTemplateUrl(url?: string) {
        if (!url) return;
        const allowed = rules.templates?.allowedDomains;
        if (!allowed?.length) return;
        try {
          const u = new URL(url);
          if (!allowed.some(dom => u.hostname.endsWith(dom))) {
            allow = false;
            reasons.push(`Template URL host '${u.hostname}' is not in allowedDomains`);
          }
        } catch {
          allow = false;
          reasons.push("templateUrl is not a valid URL");
        }
      }

      // global block words on any name-ish field
      const block = rules.governance?.blockWords || [];
      const scanFields = ["name","resourceGroupName","deploymentName","owner","repo","displayName","templateUrl"];
      for (const k of scanFields) {
        const v = String((params?.[k] ?? "")).toLowerCase();
        if (v) {
          const hits = block.filter(w => v.includes(w.toLowerCase()));
          if (hits.length) {
            allow = false;
            reasons.push(`Field '${k}' contains forbidden word(s): ${hits.join(", ")}`);
          }
        }
      }

      // Action-specific checks
      if (action === "azure.create_resource_group") {
        const name = String(params?.name || "");
        const location = String(params?.location || "");
        const tags = (params?.tags || {}) as Record<string, string>;
        const v = validateResourceGroupName(rules, name, location);
        if (!v.valid) { allow = false; reasons.push(...v.reasons); }
        const tagProblems = validateRequiredTags(rules, tags);
        if (tagProblems.length) { allow = false; reasons.push(...tagProblems); }
      }

      if (action === "azure.deploy_bicep_rg_from_url") {
        checkTemplateUrl(String(params?.templateUrl || ""));
      }

      if (action === "github.create_repo" || action === "github.create_repo_from_template") {
        const vis = params?.private === false ? "public" : "private";
        const r = validateRepoName(rules, String(params?.name || ""), vis as any);
        if (!r.valid) { allow = false; reasons.push(...r.reasons); }
      }

      if (action === "teams.create_channel") {
        const r = validateTeamsChannelName(rules, String(params?.displayName || params?.name || ""));
        if (!r.valid) { allow = false; reasons.push(...r.reasons); }
      }

      return { content: [{ type: "json" as const, json: { allow, reasons, action, params } }] };
    }
  }
];

console.log(`[MCP] governance-mcp listening on :${PORT} | rules=${RULES_FILE}`);
startMcpHttpServer({ name: "governance-mcp", version: "0.1.0", port: PORT, tools });
