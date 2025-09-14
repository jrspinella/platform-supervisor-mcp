// servers/router-mcp/src/planner.ts
import "dotenv/config";
import { z } from "zod";

/* -------------------------- Plan schema (unchanged) ------------------------- */
export const PlanSchema = z.object({
  apply: z.boolean().default(false),
  profile: z.string().default(process.env.ATO_PROFILE || "default"),
  steps: z.array(
    z.object({
      tool: z.string().min(1), // e.g. "platform.create_resource_group"
      // Record<string, any>
      args: z.record(z.string(), z.any()).default({}),
    })
  ).min(1).max(20),
}).strict();

export type Plan = z.infer<typeof PlanSchema>;

/* ------------------------------- System prompt ------------------------------ */
const SYS_PROMPT = `
You are an infrastructure planner for a platform engineering system.

Return ONLY a JSON object that matches this TypeScript type:

type Plan = {
  apply: boolean;
  profile: string;
  steps: Array<{ tool: string; args: Record<string, any> }>;
};

Available tools:
- platform.create_resource_group { name, location, tags? }
- platform.create_app_service_plan { resourceGroupName, name, location, sku }
- platform.create_web_app {
    resourceGroupName, name, location, appServicePlanName,
    httpsOnly?: boolean,
    minimumTlsVersion?: "1.2" | "1.3",
    ftpsState?: "Disabled" | "FtpsOnly" | "AllAllowed",
    linuxFxVersion?: string        // e.g. "NODE|20-lts", "DOTNET|8.0"
  }

Rules:
- Preserve user-provided names; do NOT invent placeholder names.
- If region is not explicitly provided and context implies US Gov cloud, prefer "usgovvirginia".
- If tags (owner, env, etc.) are provided, include them on the RG step.
- If the instruction includes a runtime like "runtime NODE|20-lts" (or "DOTNET|8.0"), set linuxFxVersion to that exact token on the Web App step.
- If the instruction asks for HTTPS-only/TLS 1.2/FTPS disabled, set httpsOnly=true, minimumTlsVersion="1.2", ftpsState="Disabled".
- “fix web app **X** in **rg-Y**” → 'platform.remediate_webapp_baseline' (dryRun first).  
- “apply fixes” / “remediate now” → same, 'dryRun:false' (maybe require LAW id).
- Use profile "default" unless the instruction specifies otherwise.
- Use the minimum number of steps required to satisfy the instruction.
- If creating a Web App, ensure the RG and App Service Plan are also created in prior steps (unless they already exist).
- If creating an App Service Plan, ensure the RG is also created in a prior step (unless it already exists).
- Do NOT include any steps for resources that are not mentioned in the instruction.
- Do NOT include any steps for resources that likely already exist (e.g. "create web app X in existing rg Y").
- Do NOT include any steps that are not strictly necessary (e.g. do NOT create an App Service Plan if not creating a Web App).
- If the instruction is ambiguous or missing required information, make reasonable assumptions but do NOT invent names; prefer to omit optional fields rather than inventing values.
- If you cannot determine any valid plan from the instruction, return a single step to create a resource group with name "rg-missing" and location "usgovvir
- Use correct order: RG → Plan → Web App.
- Output JSON only (no markdown, no comments).

Sanity checks:
- Tools must exist in the list above.
- All required args present.
- Names consistent across steps (web app references the created plan).
- Default profile "default" if not specified by the user.
`.trim();

function userPromptFromInstruction(instruction: string) {
  return `Instruction:\n${instruction}\n\nProduce the Plan JSON now. Do not wrap in backticks. Do not add comments.`;
}

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

/* ---------------------- Deterministic (no-LLM) parser ----------------------- */
// Light tag parser: accepts JSON-ish { owner:"a", env:"b" } or phrases "owner is a, env is b"
function parseLooseTags(text: string): Record<string, string> | undefined {
  if (!text) return undefined;
  // JSON object first
  const objMatch = text.match(/\{[\s\S]*?\}/);
  if (objMatch) {
    try {
      const jsonish = objMatch[0]
        .replace(/([,{]\s*)([A-Za-z_][\w.-]*)\s*:/g, '$1"$2":')
        .replace(/:\s*'([^']*)'/g, ':"$1"');
      const obj = JSON.parse(jsonish);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj)) out[String(k)] = String(v);
      return Object.keys(out).length ? out : undefined;
    } catch { /* ignore */ }
  }
  // key "is" value or key:value
  const out: Record<string, string> = {};
  const pairRe = /\b([a-z][\w.-]*)\s*(?:=|:|\bis\b)\s*(?:"([^"]+)"|'([^']+)'|([^\s,;{}]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(text)) !== null) {
    const key = m[1].toLowerCase();
    if (key === "tags") continue;
    const val = (m[2] ?? m[3] ?? m[4] ?? "").replace(/[.,;]$/g, "");
    if (key && val) out[key] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

function extractFirst(re: RegExp, s: string, g = 1): string | undefined {
  const m = re.exec(s);
  return (m && m[g]) || undefined;
}

// ---- NEW: runtime helpers ----------------------------------------------------
function normalizeRuntimeToken(tok?: string): string | undefined {
  if (!tok) return undefined;
  // Accept "node|20-lts", "NODE|20-lts", "dotnet|8.0", "DOTNET|8.0"
  const m = tok.match(/^([a-z]+)\|([\w.-]+)$/i);
  if (!m) return undefined;
  const left = m[1].toUpperCase();
  const right = m[2]; // keep casing for the version segment
  return `${left}|${right}`;
}

function extractRuntime(s: string): string | undefined {
  // 1) explicit "runtime: NODE|20-lts" or "runtime NODE|20-lts"
  const m1 = /\bruntime\s*[:=]?\s*([A-Za-z]+\|[\w.-]+)\b/i.exec(s);
  if (m1) {
    const norm = normalizeRuntimeToken(m1[1]);
    if (norm) return norm;
  }
  // 2) any standalone token that looks like "NODE|20-lts" or "DOTNET|8.0"
  const m2 = /\b([A-Za-z]+\|[\w.-]+)\b/.exec(s);
  if (m2) {
    const norm = normalizeRuntimeToken(m2[1]);
    if (norm) return norm;
  }
  return undefined;
}
// -----------------------------------------------------------------------------

const RE = {
  rgNamed: /\b(?:resource\s*group|rg)\s+(?:named\s+)?([a-z0-9-]{3,64})\b/i,
  rgLoose: /\b(rg-[a-z0-9-]{3,64})\b/i,
  planName: /\b(?:app\s*service\s*plan|plan)\s+([a-z0-9-]{3,64})\b/i,
  webName: /\b(?:web\s*app|webapp)\s+([a-z0-9-]{3,64})\b/i,
  onPlan: /\bon\s+(?:plan\s+)?([a-z0-9-]{3,64})\b/i,
  locationField: /\blocation\s*[:=]?\s*([a-z0-9-]{3,})\b/i,
  locationIn: /\b(?:in|at)\s+([a-z0-9-]{3,})\b/i,
  skuWord: /\b(?:sku|tier|size)\b[:=]?\s*([A-Za-z0-9_+-]+)\b/i,
  skuParen: /\(\s*([A-Za-z0-9_+-]+)\s*\)/,
  httpsOnly: /\bhttps[-\s]?only\b/i,
  tls12: /\b(?:tls|min\s*tls)\s*1\.2\b/i,
  ftpsDisabled: /\bftps\s*(?:off|disabled)\b/i,
};

function extractRegion(s: string): string | undefined {
  // Prefer explicit "location:" first
  const loc = extractFirst(RE.locationField, s)
    || (() => {
      // "in <region>" but skip false positives like "in rg-..."
      const m = RE.locationIn.exec(s);
      if (!m) return undefined;
      const tok = m[1];
      if (/^rg-/.test(tok)) return undefined;
      return tok;
    })();
  return loc;
}

function deterministicPlanFromText(instruction: string): Plan {
  const text = instruction || "";

  const rgName = extractFirst(RE.rgNamed, text) || extractFirst(RE.rgLoose, text);
  const planName = extractFirst(RE.planName, text);
  const webName = extractFirst(RE.webName, text);
  const planRef = extractFirst(RE.onPlan, text) || planName;
  const location = extractRegion(text) || (process.env.AZURE_CLOUD === "usgovernment" ? "usgovvirginia" : undefined);
  const sku = extractFirst(RE.skuWord, text) || extractFirst(RE.skuParen, text);

  const tags = parseLooseTags(text);

  const httpsOnly = RE.httpsOnly.test(text) ? true : undefined;
  const minimumTlsVersion = RE.tls12.test(text) ? "1.2" as const : undefined;
  const ftpsState = RE.ftpsDisabled.test(text) ? "Disabled" as const : undefined;

  // NEW: runtime -> linuxFxVersion
  const linuxFxVersion = extractRuntime(text);

  const steps: Plan["steps"] = [];

  if (rgName && location) {
    steps.push({
      tool: "platform.create_resource_group",
      args: { name: rgName, location, ...(tags ? { tags } : {}) },
    });
  }

  if (rgName && planName && (location || true) && sku) {
    steps.push({
      tool: "platform.create_app_service_plan",
      args: { resourceGroupName: rgName, name: planName, location: location || "usgovvirginia", sku },
    });
  }

  if (rgName && webName && planRef) {
    steps.push({
      tool: "platform.create_web_app",
      args: {
        resourceGroupName: rgName,
        name: webName,
        location: location || "usgovvirginia",
        appServicePlanName: planRef,
        ...(httpsOnly !== undefined ? { httpsOnly } : {}),
        ...(minimumTlsVersion ? { minimumTlsVersion } : {}),
        ...(ftpsState ? { ftpsState } : {}),
        ...(linuxFxVersion ? { linuxFxVersion } : {}), // 👈 IMPORTANT
      },
    });
  }

  if (!steps.length) {
    // Fallback: try at least RG creation if we can
    if (rgName && location) {
      steps.push({ tool: "platform.create_resource_group", args: { name: rgName, location, ...(tags ? { tags } : {}) } });
    } else {
      // As a last resort, show a single-step skeleton to avoid planner failure
      steps.push({ tool: "platform.create_resource_group", args: { name: "rg-missing", location: "usgovvirginia" } });
    }
  }

  const plan: Plan = {
    apply: true,
    profile: process.env.ATO_PROFILE || "default",
    steps,
  };

  // Validate shape
  return PlanSchema.parse(plan);
}

/* --------------------------- Public planner API ----------------------------- */
function llmConfigured(): boolean {
  return Boolean(
    (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY && process.env.AZURE_OPENAI_DEPLOYMENT)
    || process.env.OPENAI_API_KEY
  );
}

// Try LLM; if unavailable or it fails, use deterministic parser
export async function planWithPlanner(instruction: string): Promise<Plan> {
  if (llmConfigured()) {
    try {
      const raw = await chat([
        { role: "system", content: SYS_PROMPT },
        { role: "user", content: userPromptFromInstruction(instruction) },
      ]);
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start < 0 || end < 0 || end <= start) throw new Error("no JSON");
      const parsed = JSON.parse(raw.slice(start, end + 1));
      const plan = PlanSchema.parse(parsed);
      const allowed = new Set([
        "platform.create_resource_group",
        "platform.create_app_service_plan",
        "platform.create_web_app",
      ]);
      for (const s of plan.steps) if (!allowed.has(s.tool)) throw new Error(`unknown tool ${s.tool}`);
      return plan;
    } catch {
      // fall through to deterministic
    }
  }
  return deterministicPlanFromText(instruction);
}