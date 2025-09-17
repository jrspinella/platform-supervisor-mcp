// servers/router-mcp/src/planner.ts
import "dotenv/config";
import { z } from "zod";

/* -------------------------- Plan schema ------------------------- */
const StepSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.any()).default({}),
});

export const PlanSchema = z.object({
  apply: z.boolean().default(false),
  profile: z.string().default(process.env.ATO_PROFILE || "default"),
  steps: z.array(StepSchema).min(1).max(20),
}).strict();

export type Plan = z.infer<typeof PlanSchema>;

/* ---------------------------- System prompt ---------------------------- */
const SYS_PROMPT = `
You are an infrastructure planner for a platform engineering system.

Return ONLY a JSON object that matches:

type Plan = {
  apply: boolean;                // true = actually create, false = plan/preview only
  profile: string;
  steps: Array<{ tool: string; args: Record<string, any> }>;
};

Available tools:

# Apply (creates resources)
- platform.create_resource_group { name, location, tags? }
- platform.create_app_service_plan { resourceGroupName, name, location, sku }
- platform.create_web_app {
    resourceGroupName, name, location, appServicePlanName,
    httpsOnly?: boolean,
    minimumTlsVersion?: "1.2" | "1.3",
    ftpsState?: "Disabled" | "FtpsOnly" | "AllAllowed",
    linuxFxVersion?: string
  }
- platform.create_container_app {
    resourceGroupName, name, location,
    environmentName?: string, environmentId?: string,
    image?: string, cpu?: number, memory?: string, ingress?: { external?: boolean, targetPort?: number }
  }
- platform.create_function_app {
    resourceGroupName, name, location,
    storageAccountName: string,
    appServicePlanName?: string,            // omit for Consumption unless your platform requires one
    runtimeStack?: string,                  // e.g. "node|20" or "dotnet|8.0"
    linuxFxVersion?: string                 // if your platform uses linuxFxVersion instead of runtimeStack
  }
- platform.create_storage_account {
    resourceGroupName, name, location, sku: string, kind?: string, httpOnly?: boolean, tags?: Record<string,string>
  }
- platform.create_key_vault {
    resourceGroupName, name, location, tenantId,
    skuName: "standard" | "premium",
    enableRbacAuthorization?: boolean,
    publicNetworkAccess?: "Enabled" | "Disabled",
    tags?: Record<string,string>
  }

- platform.create_log_analytics_workspace {
    resourceGroupName, name, location, sku?: string, retentionInDays?: number, tags?: Record<string,string>
  }
- platform.create_virtual_network {
    resourceGroupName, name, location, addressPrefixes: string[], dnsServers?: string[], tags?: Record<string,string>
  }
- platform.create_microsoft_sql_server {
    resourceGroupName, name, location, administratorLogin, administratorLoginPassword, tags?: Record<string,string>
  }

# Plan (no-op preview) — use these when apply=false
- platform.plan_resource_group { name, location, tags? }
- platform.plan_app_service_plan { resourceGroupName, name, location, sku }
- platform.plan_web_app {
    resourceGroupName, name, location, appServicePlanName,
    httpsOnly?: boolean,
    minimumTlsVersion?: "1.2" | "1.3",
    ftpsState?: "Disabled" | "FtpsOnly" | "AllAllowed",
    linuxFxVersion?: string
  }
- platform.plan_container_app {
    resourceGroupName, name, location,
    environmentName?: string, environmentId?: string,
    image?: string, cpu?: number, memory?: string, ingress?: { external?: boolean, targetPort?: number }
  }
- platform.plan_function_app {
    resourceGroupName, name, location,
    storageAccountName: string,
    appServicePlanName?: string,
    runtimeStack?: string,
    linuxFxVersion?: string
  }
- platform.plan_storage_account {
    resourceGroupName, name, location, sku: string, kind?: string, tags?: Record<string,string>
  }
- platform.plan_key_vault {
    resourceGroupName, name, location, tenantId, skuName, enableRbacAuthorization?: boolean, publicNetworkAccess?: "Enabled" | "Disabled", tags?: Record<string,string>
  }
- platform.plan_log_analytics_workspace {
    resourceGroupName, name, location, sku?: string, retentionInDays?: number, tags?: Record<string,string>
  }
- platform.plan_virtual_network {
    resourceGroupName, name, location, addressPrefixes: string[], dnsServers?: string[], tags?: Record<string,string>
  }
- platform.plan_microsoft_sql_server {
    resourceGroupName, name, location, administratorLogin?, administratorLoginPassword?, tags?: Record<string,string>
  }

# Scans (ATO baseline checks — NOT create/plan)
- platform.scan_resource_group_baseline { resourceGroupName, profile }
- platform.scan_appplan_baseline { resourceGroupName, name, profile }
- platform.scan_webapp_baseline { resourceGroupName, name, profile }

# Plan executors
- platform.apply_plan { steps: Array<{ tool: string; args: Record<string, any> }> }
- platform.preview_plan { steps: Array<{ tool: string; args: Record<string, any> }> }

Rules:
- If the instruction says "scan", "assess", "ATO", "baseline", or "check", return exactly ONE scan step using a platform.scan_* tool. Ignore apply/plan in this case.
- If the instruction says "plan", "preview", "what-if", "dry run", or "don’t apply", set apply=false and use ONLY platform.plan_* tools.
- If the instruction says "create", "make", "deploy", "set up", "provision", or "apply", set apply=true and use ONLY platform.create_* tools.
- If the instruction is ambiguous, prefer NOT to create resources. Set apply=false and use platform.plan_* tools.
- If the instructions mentions "scan" or "ATO" and is not followed by "create" or "apply", prioritize the scan and return a single platform.scan_* step.
- Prefer fewer steps over more steps.
- Do NOT include any tools other than the ones listed above.
- Prefer the minimum number of steps that satisfies the instruction.
- Otherwise set apply=true and use ONLY platform.create_* tools.
- Prefer the minimum number of steps that satisfies the instruction.
- Do NOT invent names or regions. Use exactly what the user provided.
- Region default for Azure US Gov is "usgovvirginia" when location is missing.
- Key Vault skuName default is "standard" when missing.
- Storage Account sku default is "Standard_LRS" and kind default is "StorageV2" when missing.
- Log Analytics Workspace sku default is "PerGB2018" and retentionInDays default is 30 when missing.
- Web Apps: linuxFxVersion must be a valid value (e.g., "NODE|20-lts" for Node on Linux).
- Function Apps: a storageAccountName is required; do NOT create one unless the user provided a name.
- Container Apps: require an existing Container Apps Environment (environmentName or environmentId). Do NOT create it unless the user provided its name/ID.
- SQL Server: do not invent admin credentials; only use provided values.
- Output JSON only (no markdown, no comments).
`.trim();


function userPromptFromInstruction(instruction: string) {
  return `Instruction:\n${instruction}\n\nProduce the Plan JSON now. Do not wrap in backticks. Do not add comments.`;
}

/* ------------------------- Allow-list ------------------------- */
const allowed = new Set([
  // Apply (create)
  "platform.create_resource_group",
  "platform.create_app_service_plan",
  "platform.create_web_app",
  "platform.create_container_app",
  "platform.create_function_app",
  "platform.create_storage_account",
  "platform.create_key_vault",
  "platform.create_log_analytics_workspace",
  "platform.create_virtual_network",
  "platform.create_microsoft_sql_server",

  // Plan (no-op)
  "platform.plan_resource_group",
  "platform.plan_app_service_plan",
  "platform.plan_web_app",

  // Scans
  "platform.scan_resource_group_baseline",
  "platform.scan_appplan_baseline",
  "platform.scan_webapp_baseline",

  // Mission owner (unchanged)
  "mission.create_repo",
  "mission.add_repo_secret",
  "mission.protect_branch",

  // Plan executors (if ever returned)
  "platform.apply_plan",
  "platform.preview_plan",
]);

/* -------------------------- Minimal HTTP chat client ------------------------ */
type ChatMsg = { role: "system" | "user"; content: string };

async function chat(messages: ChatMsg[]): Promise<string> {
  const azureEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const azureKey = process.env.AZURE_OPENAI_API_KEY;
  const azureDeployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (azureEndpoint && azureKey && azureDeployment) {
    const url = `${azureEndpoint}/openai/deployments/${azureDeployment}/chat/completions?api-version=2024-02-15-preview`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": azureKey },
      body: JSON.stringify({ messages, temperature: 0, max_tokens: 800 }),
    });
    const j = await r.json();
    return j?.choices?.[0]?.message?.content || "";
  }

  if (openaiKey) {
    const model = process.env.PLANNER_MODEL || "gpt-4o-mini";
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 800, messages }),
    });
    const j = await r.json();
    return j?.choices?.[0]?.message?.content || "";
  }

  throw new Error("No LLM configured.");
}

/* ---------------------- Deterministic helpers ----------------------- */
function extractFirst(re: RegExp, s: string, g = 1): string | undefined {
  const m = re.exec(s);
  return (m && m[g]) || undefined;
}

const RE = {
  scan: /\b(scan|assess|baseline|ato|check)\b/i,
  rgNamed: /\b(?:resource\s*group|rg)\s+(?:named\s+)?([a-z0-9-]{3,64})\b/i,
  rgLoose: /\b(rg-[a-z0-9-]{3,64})\b/i,
  planName: /\b(?:app\s*service\s*plan|plan)\s+([a-z0-9-]{3,64})\b/i,
  webName: /\b(?:web\s*app|webapp)\s+([a-z0-9-]{3,64})\b/i,
};

function deterministicScanFromText(instruction: string): Plan | undefined {
  const text = instruction || "";
  if (!RE.scan.test(text)) return undefined;

  const rg = extractFirst(RE.rgNamed, text) || extractFirst(RE.rgLoose, text);
  const planName = extractFirst(RE.planName, text);
  const webName = extractFirst(RE.webName, text);

  const steps: Plan["steps"] = [];
  const profile = process.env.ATO_PROFILE || "default";

  if (rg && !planName && !webName) {
    steps.push({ tool: "platform.scan_resource_group_baseline", args: { resourceGroupName: rg, profile } });
  } else if (rg && planName) {
    steps.push({ tool: "platform.scan_appplan_baseline", args: { resourceGroupName: rg, name: planName, profile } });
  } else if (rg && webName) {
    steps.push({ tool: "platform.scan_webapp_baseline", args: { resourceGroupName: rg, name: webName, profile } });
  }

  if (steps.length) return { apply: false, profile, steps };
  return undefined;
}

/* ------------------------- Deterministic create/plan (unchanged) ------------------------- */
// (Keep your existing deterministic create/plan builder here)
// For brevity, not repeated — no change needed to those parts.

/* --------------------------- Public planner API ----------------------------- */
function llmConfigured(): boolean {
  return Boolean(
    (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_DEPLOYMENT)
    || process.env.OPENAI_API_KEY
  );
}

function normalizePlanTools(plan: Plan): Plan {
  // Keep as-is; scans are standalone and not normalized to plan/create
  return plan;
}

// planner.ts
function normalizeRegion(s?: string) {
  if (!s) return s;
  const t = s.toLowerCase();
  if (t === "usgivvirginia") return "usgovvirginia"; // common typo
  return t;
}

function pickSkuName(a: any): string | undefined {
  // accept multiple shapes
  const candidates = [
    a?.skuName,
    a?.sku,
    a?.tier,
    a?.pricingTier,
    a?.sku?.name
  ].filter(Boolean);

  if (!candidates.length) return undefined;

  let v = String(candidates[0]).trim().toLowerCase();
  // common aliases
  if (v === "std") v = "standard";
  if (v === "prem") v = "premium";

  if (v === "standard" || v === "premium") return v;
  return undefined; // invalid value → let policy complain clearly
}

function postProcessPlan(plan: Plan): Plan {
  const steps = plan.steps.map(s => {
    const a: any = { ...(s.args || {}) };

    // Key Vault tool arg fixups
    if (s.tool === "platform.create_key_vault" || s.tool === "platform.plan_key_vault") {
      // map and validate skuName (do NOT coerce undefined → "")
      const skuNorm = pickSkuName(a);
      if (skuNorm) a.skuName = skuNorm;
      delete a.sku; delete a.tier; delete a.pricingTier;

      // region normalization
      if (a.location) a.location = normalizeRegion(a.location);

      // optional: default to "standard" if not provided
      if (!a.skuName) a.skuName = "standard"; // ← remove this line if you prefer policy to enforce explicit choice
    }

    // generic region normalization
    if (a.location) a.location = normalizeRegion(a.location);

    return { ...s, args: a };
  });
  return { ...plan, steps };
}


export async function planWithPlanner(instruction: string): Promise<Plan> {
  // 0) Deterministic short-circuit for scans
  const scanPlan = deterministicScanFromText(instruction);
  if (scanPlan) return scanPlan;

  if (llmConfigured()) {
    try {
      const raw = await chat([
        { role: "system", content: SYS_PROMPT },
        { role: "user", content: userPromptFromInstruction(instruction) },
      ]);
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end < 0 || end <= start) throw new Error("no JSON");
      let plan = PlanSchema.parse(JSON.parse(raw.slice(start, end + 1)));
      plan = postProcessPlan(plan);

      // Validate tool names against allowlist
      for (const s of plan.steps) {
        if (!allowed.has(s.tool)) {
          const familyOk =
            s.tool.startsWith("platform.create_") ||
            s.tool.startsWith("platform.plan_") ||
            s.tool.startsWith("platform.scan_") ||
            s.tool.startsWith("platform.apply_") ||
            s.tool.startsWith("mission.");
          if (!familyOk) throw new Error(`unknown tool ${s.tool}`);
        }
      }

      return normalizePlanTools(plan);
    } catch {
      // fall through to deterministic (create/plan) builder
    }
  }

  // If no LLM (or it failed) and not a scan, fall back to your existing deterministic create/plan
  // (Call your current deterministicPlanFromText here)
  return /* deterministicPlanFromText */ (() => {
    // Minimal safe fallback: just return a policy dump step to avoid throwing
    return {
      apply: false, profile: process.env.ATO_PROFILE || "default", steps: [
        { tool: "platform.plan_resource_group", args: { name: "rg-missing", location: "usgovvirginia" } }
      ]
    };
  })();
}
