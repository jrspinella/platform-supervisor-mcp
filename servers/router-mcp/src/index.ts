import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";

// ──────────────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 8700);
const PLATFORM_URL = process.env.PLATFORM_URL || "http://127.0.0.1:8721";

const AOAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || "";
const AOAI_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const AOAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || ""; // e.g. gpt-4o-mini

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
type ToolListItem = {
  name: string;
  description?: string;
  schema?: any; // JSON schema advertised by Platform MCP
};

type Catalog = {
  tools: ToolListItem[];
  byName: Map<string, ToolListItem>;
};

// ──────────────────────────────────────────────────────────────────────────────
/** HTTP helpers */
// ──────────────────────────────────────────────────────────────────────────────
async function postJson(url: string, body: any) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json: any = undefined;
  try { json = JSON.parse(text); } catch { }
  return { status: res.status, ok: res.ok, text, json };
}

async function callAzureChat(system: string, user: string) {
  if (!AOAI_ENDPOINT || !AOAI_KEY || !AOAI_DEPLOYMENT) {
    return { ok: false, error: "AzureOpenAI not configured" };
  }
  const url = `${AOAI_ENDPOINT}/openai/deployments/${AOAI_DEPLOYMENT}/chat/completions?api-version=2024-02-15-preview`;
  const body = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "api-key": AOAI_KEY
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { }
  if (!res.ok) return { ok: false, status: res.status, error: text, json };
  const content = json?.choices?.[0]?.message?.content ?? "";
  return { ok: true, content, raw: json };
}

function parseFirstJson(s: string): any {
  try { return JSON.parse(s); } catch { }
  const a = s.indexOf("{"); const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { }
  }
  return null;
}

function candidateTools(instruction: string): ToolListItem[] {
  const s = instruction.toLowerCase();

  // Simple signal terms → you can extend this safely
  const wantsPlan = /(app service plan|asp\b|sku\b)/.test(s);
  const wantsWeb = /\b(web app|app service (web|site)|https-only|tls|ftps)\b/.test(s);
  const wantsRG = /\b(resource group|rg\b)/.test(s);

  let items = CATALOG.tools;

  if (wantsPlan) {
    items = items.filter(t => /app_service_plan/.test(t.name) || /plan/.test((t.description || "").toLowerCase()));
  } else if (wantsWeb) {
    items = items.filter(t => /web_app/.test(t.name) || /web app/.test((t.description || "").toLowerCase()));
  } else if (wantsRG) {
    items = items.filter(t => /resource_group/.test(t.name));
  }

  // If we pruned too hard, fall back to all
  return items.length ? items : CATALOG.tools;
}

function normalizeArgsKeys(args: any, schema: any) {
  if (!args || typeof args !== "object") return args;

  // Build canonical set from schema
  const props: Record<string, any> = schema?.properties || {};

  // Common Azure synonyms → canonical field
  const synonyms: Record<string, string> = {
    // RG
    resource_group: "resourceGroupName",
    rg: "resourceGroupName",
    group: "resourceGroupName",

    // Location
    region: "location",
    geo: "location",

    // Web/App Plan typicals (no-op unless present)
    plan: "name",
    app_service_plan_name: "name"
  };

  const out: any = { ...args };
  for (const [k, v] of Object.entries(args)) {
    const lower = k.toLowerCase();
    // if key is already canonical, keep it
    if (props[k]) continue;
    // if we have a synonym that matches a canonical property, move it
    const target = synonyms[lower];
    if (target && props[target] !== undefined && out[target] === undefined) {
      out[target] = v;
      delete out[k];
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
/** Catalog loading (live from Platform MCP) */
// ──────────────────────────────────────────────────────────────────────────────
async function loadPlatformCatalog(): Promise<Catalog> {
  const r = await postJson(`${PLATFORM_URL}/rpc`, {
    jsonrpc: "2.0", id: 1, method: "tools.list", params: {}
  });
  if (!r.ok || !Array.isArray(r.json?.result)) {
    throw new Error(`Failed to load catalog from platform MCP: ${r.status} ${r.text}`);
  }
  // Keep platform.* by default (you can include developer.* / onboarding.* if you like)
  const items: ToolListItem[] = r.json.result
    .filter((t: any) => t?.name && typeof t.name === "string")
    .filter((t: any) => /^platform\./.test(t.name))
    .map((t: any) => ({
      name: t.name,
      description: t.description || "",
      schema: t.schema || t.inputSchema || {}
    }));
  return { tools: items, byName: new Map(items.map(t => [t.name, t])) };
}

let CATALOG: Catalog = { tools: [], byName: new Map() };

(async () => {
  try {
    CATALOG = await loadPlatformCatalog();
    console.log(`[router] loaded ${CATALOG.tools.length} platform tools from ${PLATFORM_URL}`);
  } catch (e: any) {
    console.error("[router] catalog load failed:", e?.message || e);
  }
})();

// ──────────────────────────────────────────────────────────────────────────────
/** Very light JSON schema validator (required-only).
 *  Swap with AJV for strict type checking if desired. */
// ──────────────────────────────────────────────────────────────────────────────
function validateArgs(args: any, schema: any): { ok: boolean; error?: string } {
  if (!schema || typeof schema !== "object") return { ok: true };
  const req: string[] = Array.isArray(schema.required) ? schema.required : [];
  for (const k of req) {
    if (!(k in (args || {}))) return { ok: false, error: `Missing required field: ${k}` };
  }
  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────────
/** LLM prompts (2-stage) */
// ──────────────────────────────────────────────────────────────────────────────
function toolChoiceSystemPrompt(toolNames: string) {
  return [
    "You are a routing function.",
    "Return ONLY JSON with the fields:",
    '- "tool": exact tool name string (e.g., "platform.create_resource_group")',
    '- "rationale": short string (why this tool)',
    "",
    "Pick the tool that most directly satisfies the request.",
    'Prefer tools with prefix "platform." for Azure operations (RG, AppService Plan, Web App, VNet, KV, Storage, LAW).',
    "Do not include args in this step.",
    "",
    "Available tools:",
    toolNames
  ].join("\n");
}

function toolArgsSystemPrompt(toolName: string, schema: any) {
  return [
    "You fill ONLY the args for the selected tool.",
    "Return ONLY JSON with:",
    '- "args": object that satisfies the tool schema',
    '- "rationale": short string explaining how fields were inferred',
    "",
    "Rules:",
    "- Use ONLY info stated or trivially implied by the instruction.",
    "- Do NOT invent fields.",
    "- Set obvious defaults only if universally sensible (e.g., runtime \"NODE|20-lts\").",
    "- Keep types correct (string/number/boolean/object).",
    "",
    `Tool: ${toolName}`,
    "Schema (JSON):",
    JSON.stringify(schema ?? {}, null, 2)
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Express app
// ──────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.type("text").send("ok"));

app.post("/refresh-catalog", async (_req, res) => {
  try {
    CATALOG = await loadPlatformCatalog();
    res.json({ ok: true, count: CATALOG.tools.length });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

app.post("/rpc", async (req: Request, res: Response) => {
  const { id, method, params } = req.body || {};

  if (method !== "nl.route") {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method" } });
  }

  const instruction: string | undefined = params?.instruction;
  if (!instruction || typeof instruction !== "string") {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing params.instruction (string)" } });
  }

  // ── Stage 1: choose tool (no args) ─────────────────────────────────────────
  const candidates = candidateTools(instruction);
  const toolNames = candidates.map(t => `- ${t.name} — ${t.description || ""}`).join("\n");
  const choiceSystem = toolChoiceSystemPrompt(toolNames);
  const choiceUser = `Instruction: ${instruction}\nReturn ONLY {"tool": "...", "rationale":"..."}`;

  const choice = await callAzureChat(choiceSystem, choiceUser);
  if (!choice.ok) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32001, message: "Router choice call failed", data: choice } });
  }
  const choiceJson = parseFirstJson(choice.content);
  const tool = String(choiceJson?.tool || "");
  if (!tool) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32001, message: "Could not determine a tool from the router." } });
  }
  const item = CATALOG.byName.get(tool);
  if (!item) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32001, message: `Unknown or unavailable tool: ${tool}` } });
  }
  const rationale1 = String(choiceJson?.rationale || "");

  // ── Stage 2: extract args for chosen tool ───────────────────────────────────
  const argSystem = toolArgsSystemPrompt(tool, item.schema);
  const argUser = `Instruction: ${instruction}\nReturn ONLY {"args": {...}, "rationale":"..."}`;

  let argsPass = await callAzureChat(argSystem, argUser);
  if (!argsPass.ok) {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32002, message: "Router arg fill call failed", data: argsPass } });
  }
  let argsObj = parseFirstJson(argsPass.content) ?? {};
  let args = argsObj?.args ?? {};
  args = normalizeArgsKeys(args, item.schema);

  // Validate and repair once if needed
  let v = validateArgs(args, item.schema);
  if (!v.ok) {
    const repairUser =
      `The previous args failed validation: ${v.error}\n` +
      `Instruction: ${instruction}\n` +
      `Re-output ONLY {"args": {...}, "rationale":"..."} that satisfies the schema.`;
    const repair = await callAzureChat(argSystem, repairUser);
    if (!repair.ok) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32003, message: "Router arg repair failed", data: repair } });
    }
    const repaired = parseFirstJson(repair.content) ?? {};
    args = repaired?.args ?? {};
    v = validateArgs(args, item.schema);
    if (!v.ok) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32004, message: `Args still invalid: ${v.error}` } });
    }
  }

  const rationale2 = String((argsObj?.rationale ?? "").trim());

  return res.json({
    jsonrpc: "2.0",
    id,
    result: { tool, args, rationale: rationale2 || rationale1 || "schema-driven mapping" }
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[router] listening on http://127.0.0.1:${PORT}`);
  console.log(`[router] PLATFORM_URL=${PLATFORM_URL}`);
  console.log(`[router] AzureOpenAI configured=${!!(AOAI_ENDPOINT && AOAI_KEY && AOAI_DEPLOYMENT)}`);
});
