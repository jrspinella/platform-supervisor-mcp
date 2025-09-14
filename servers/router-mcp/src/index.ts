// servers/router-mcp/src/index.ts — NL router with RG/Plan/Web + "app workloads" scan
import express from "express";
import "dotenv/config";
import { parseTags, sanitizeRgName } from "./utils.js";     // 👈 add .js for ESM
import { planWithPlanner } from "./planner.js";             // 👈 add .js for ESM

const app = express();
app.use(express.json({ limit: "1mb" }));

const ATO_DEFAULT = (process.env.ATO_PROFILE || "default").trim();
const basePort = Number(process.env.PORT || 8701);

// ── Regex helpers ──────────────────────────────────────────────────────────────
const RE = {
  // intents
  scan: /\bscan\b/i,
  create: /\b(?:create|provision|build)\b/i,

  // workload (create macro)
  workload: /(create\s+a\s+new\s+azure\s+workload|resource group .* then .* web app)/i,

  // resource kinds
  webappWord: /\b(web\s*app|webapp)\b/i,
  planWord: /\b(app\s*service\s*plan|plan)\b/i,
  rgWord: /\b(resource\s*group|rg)\b/i,

  // names
  webappName: /\b(?:web\s*app|webapp)\s+([a-z0-9-]+)\b/i,
  planName: /\b(?:app\s*service\s*plan|plan)\s+([a-z0-9-]+)\b/i,
  rgName: /\b(?:resource\s*group|rg)\s+(?:named\s+)?([a-z0-9-]+)\b/i,

  // fields
  nameField: /\bname\s*[:=]\s*([A-Za-z0-9._-]+)\b/i,
  locationField: /\blocation\s*[:=]\s*([a-z0-9-]+)\b/i,
  locationLoose: /\b(?:in|at)\s+([a-z0-9-]+)\b/i,
  tagsObj: /\btags?\s*[:=]\s*(\{[\s\S]*?\})/i,

  // loose tokens
  rgLoose: /\brg[-\w]+\b/i,
  rgToken: /\b(rg-[a-z0-9-]{3,40})\b/i,

  // SKU
  skuWord: /\b(?:sku|tier|size)\b[:=]?\s*([A-Za-z0-9_+-]+)\b/i,
  skuToken: /\b(?:P\d(?:v\d)?|S\d|B\d|F\d|I\d|PremiumV3|PremiumV2|Premium|Standard|Basic|Free|Shared)\b/i,
  skuPattern: /\b(?:sku|tier|size)\b[:=]?\s*([A-Za-z0-9_+-]+)\b/i,

  // "app workloads" detector
  appWorkloads: /\b(?:app(?:lication)?\s*workloads?|workloads?\s*(?:for|of)?\s*apps?)\b/i,
};

// tiny helper
function extractFirst<T = string>(re: RegExp, text: string, group = 1): T | undefined {
  const m = re.exec(text);
  return (m && (m[group] as unknown as T)) || undefined;
}

// Strip an optional @prefix (e.g., "@platform ")
function stripAtPrefix(s: string) {
  return s.replace(/^@\w[\w.-]*\s+/, "");
}

// Try multiple shapes to find the RG name reliably
function getRgNameFromText(text: string): string | undefined {
  return (
    extractFirst<string>(RE.rgName, text, 1) ||
    extractFirst<string>(RE.rgToken, text, 1) ||
    extractFirst<string>(RE.rgLoose, text, 0)
  );
}

// Safer location extraction (skips RG tokens misread as regions)
function extractLocationSafe(text: string): string | undefined {
  const loc1 = extractFirst<string>(RE.locationField, text, 1);
  if (loc1 && !/^rg-/.test(loc1)) return loc1;

  let m: RegExpExecArray | null;
  const re = new RegExp(RE.locationLoose.source, "gi");
  while ((m = re.exec(text)) !== null) {
    const tok = m[1];
    if (!/^rg-/.test(tok)) return tok;
  }
  return undefined;
}

function extractSku(txt: string): string | undefined {
  return (
    extractFirst<string>(RE.skuWord, txt) ||
    extractFirst<string>(RE.skuPattern, txt) ||
    extractFirst<string>(RE.skuToken, txt)
  );
}

// 1) helper to grab a free-form "tags ..." phrase from the instruction
function extractTagPhrase(instruction: string): string | undefined {
  const i = instruction.toLowerCase().indexOf("tags");
  if (i < 0) return undefined;
  const after = instruction.slice(i + 4);
  const endThen = after.toLowerCase().indexOf(" then ");
  const slice = endThen >= 0 ? after.slice(0, endThen) : after;
  const blob = slice.replace(/^[:=\s,]+/, "").trim();
  return blob || undefined;
}

function normalizeRuntimeToken(tok?: string): string | undefined {
  if (!tok) return undefined;
  const m = tok.match(/^([a-z]+)\|([\w.-]+)$/i);
  if (!m) return undefined;
  return `${m[1].toUpperCase()}|${m[2]}`;
}

function extractRuntime(text: string): string | undefined {
  const m1 = /\bruntime\s*[:=]?\s*([A-Za-z]+\|[\w.-]+)\b/i.exec(text);
  if (m1) return normalizeRuntimeToken(m1[1]);

  const m2 = /\b([A-Za-z]+\|[\w.-]+)\b/.exec(text);
  if (m2) return normalizeRuntimeToken(m2[1]);

  return undefined;
}

// 2) attach governance-friendly context for ALL tools
function addGovCtx<R extends { tool: string; args: any; rationale?: string }>(
  res: R,
  originalInstruction: string
): R {
  if (!res?.args) return res;

  const tagString = extractTagPhrase(originalInstruction);

  // attach to top-level call
  res.args = {
    ...res.args,
    ...(tagString && !res.args.tags ? { tagString } : {}),
    context: { ...(res.args.context || {}), text: originalInstruction },
  };

  // if this is a plan, also push ctx/tags into each step (unless already present)
  if (res.tool === "platform.apply_plan" && Array.isArray(res.args.steps)) {
    res.args = {
      ...res.args,
      ...(tagString ? { tagString } : {}),
      context: { ...(res.args.context || {}), text: originalInstruction },
      steps: res.args.steps.map((s: any) => ({
        ...s,
        args: {
          ...(s.args || {}),
          ...(tagString && !s.args?.tags ? { tagString } : {}),
          context: { ...(s.args?.context || {}), text: originalInstruction },
        },
      })),
    };
  }

  return res;
}

// ── Extractors ────────────────────────────────────────────────────────────────
function extractRgCreate(text: string) {
  const rawName =
    extractFirst<string>(RE.nameField, text, 1) ||
    extractFirst<string>(RE.rgName, text, 1) ||
    extractFirst<string>(RE.rgLoose, text, 0);

  const loc = extractLocationSafe(text);
  const sanitizedRgName = sanitizeRgName(rawName);

  let tags: Record<string, string> | undefined;
  const tagsRaw = extractFirst<string>(RE.tagsObj, text, 1);
  if (tagsRaw) {
    try { tags = parseTags(JSON.parse(tagsRaw)); } catch { /* ignore */ }
  }
  const tagString = !tags ? extractTagPhrase(text) : undefined; // << NEW

  return { rawName, sanitizedRgName, location: loc, tags, tagString };
}

function extractPlanCreate(text: string) {
  const name = extractFirst<string>(RE.planName, text);
  const resourceGroupName = getRgNameFromText(text);
  const location = extractLocationSafe(text);
  const sku = extractSku(text);
  return { name, resourceGroupName, location, sku };
}

function extractWebCreate(text: string) {
  const name = extractFirst<string>(RE.webappName, text);
  const resourceGroupName = getRgNameFromText(text);
  const location = extractLocationSafe(text);
  const linuxFxVersion = extractRuntime(text);   // 👈 NEW
  return { name, resourceGroupName, location, linuxFxVersion };
}

// ── Router core ───────────────────────────────────────────────────────────────
export async function route(instruction: string) {
  const original = (instruction || "").trim();
  const text = stripAtPrefix(original);

  const hasScan = RE.scan.test(text);
  const hasCreate = RE.create.test(text);
  const mentionsWeb = RE.webappWord.test(text);
  const mentionsPlan = RE.planWord.test(text);
  const mentionsRg = RE.rgWord.test(text);

  // Multi-step intent? Use planner (LLM if available, else deterministic)
  const hasThenCreate = /\bthen\s+create\b/i.test(text);
  const hasCreateTwice = (text.match(/\b(create|provision|build)\b/gi)?.length ?? 0) >= 2;
  const hasCreateThen = /\b(create|provision|build)\b[\s\S]*?\b(workload|then|and then)\b/i.test(text);

  if (hasThenCreate || hasCreateTwice || hasCreateThen) {
    const plan = await planWithPlanner(instruction);
    return addGovCtx({
      tool: "platform.apply_plan",
      args: { ...plan, render: "full" },
      rationale: "planned multi-step workload",
    }, original);
  }

  // SCAN APP WORKLOADS (Web Apps + Plans in an RG)
  if (hasScan && RE.appWorkloads.test(text)) {
    const rgName = getRgNameFromText(text);
    if (rgName) {
      return {
        tool: "platform.scan_resource_group_baseline",
        args: { resourceGroupName: rgName, profile: ATO_DEFAULT, include: ["appServicePlan", "webApp"] },
        rationale: "scan app workloads detected (RG parsed; plans + web apps)",
      };
    }
  }

  // CREATE — handle specific resources BEFORE generic RG
  if (hasCreate && mentionsPlan) {
    const { name, resourceGroupName, location, sku } = extractPlanCreate(text);
    if (name && resourceGroupName && location && sku) {
      return addGovCtx({
        tool: "platform.create_app_service_plan",
        args: { resourceGroupName, name, location, sku },
        rationale: "create app service plan detected (rg/name/location/sku parsed)",
      }, original);
    }
  }

  if (hasCreate && mentionsWeb) {
    const { name, resourceGroupName, location, linuxFxVersion } = extractWebCreate(text);
    if (name && resourceGroupName && location) {
      return addGovCtx({
        tool: "platform.create_web_app",
        args: {
          resourceGroupName,
          name,
          location,
          appServicePlanName:
            /plan\s+([a-z0-9-]+)/i.exec(text)?.[1] ||
            /service\s*plan\s+([a-z0-9-]+)/i.exec(text)?.[1] ||
            "<APP_SERVICE_PLAN_NAME>",
          httpsOnly: /\bhttps[-\s]?only\b/i.test(text) ? true : undefined,
          minimumTlsVersion: /\b(?:tls|min\s*tls)\s*1\.2\b/i.test(text) ? "1.2" : undefined,
          ftpsState: /\bftps\s*(?:off|disabled)\b/i.test(text) ? "Disabled" : undefined,
          ...(linuxFxVersion ? { linuxFxVersion } : {}),   // 👈 NEW
        },
        rationale: "create web app detected (rg/name/location parsed)",
      }, original);
    }
  }

  // CREATE RG — last among create paths
  if (hasCreate && mentionsRg) {
    const { rawName, sanitizedRgName, location, tags, tagString } = extractRgCreate(text);
    if (sanitizedRgName && location) {
      return addGovCtx({
        tool: "platform.create_resource_group",
        args: { name: sanitizedRgName, location, ...(tags ? { tags } : {}), _rawName: rawName },
        rationale: "create resource group detected (name/location parsed)",
      }, original)
    }
  }

  // SCAN WEB APP
  if (hasScan && mentionsWeb) {
    const rgName = getRgNameFromText(text);
    const name = extractFirst<string>(RE.webappName, text);
    if (rgName && name) {
      return {
        tool: "platform.scan_webapp_baseline",
        args: { resourceGroupName: rgName, name, profile: ATO_DEFAULT },
        rationale: "scan webapp detected (rg + name parsed)",
      };
    }
  }

  // SCAN APP SERVICE PLAN
  if (hasScan && mentionsPlan) {
    const rgName = getRgNameFromText(text);
    const name = extractFirst<string>(RE.planName, text);
    if (rgName && name) {
      return {
        tool: "platform.scan_appplan_baseline",
        args: { resourceGroupName: rgName, name, profile: ATO_DEFAULT },
        rationale: "scan app service plan detected (rg + name parsed)",
      };
    }
  }

  // SCAN RESOURCE GROUP (baseline everything in RG)
  if (hasScan && (mentionsRg || RE.rgToken.test(text) || RE.rgLoose.test(text))) {
    const rgName = getRgNameFromText(text);
    if (rgName) {
      return {
        tool: "platform.scan_resource_group_baseline",
        args: { resourceGroupName: rgName, profile: ATO_DEFAULT },
        rationale: "scan + resource group detected (rg name parsed)",
      };
    }
  }

  // Workload macro (least specific)
  if (RE.workload.test(text)) {
    return {
      tool: "platform.create_workload",
      args: { prompt: original, apply: true, profile: ATO_DEFAULT },
      rationale: "create workload detected (macro tool)",
    };
  }

  // Fallback
  return {
    tool: "platform.policy_dump",
    args: {},
    rationale: "fallback: show merged policy (intent not recognized)",
  };
}

// ── JSON-RPC surface ──────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/rpc", async (req, res) => {
  const { method, params, id } = req.body ?? {};
  if (method === "health") return res.json({ jsonrpc: "2.0", id, result: "ok" });

  // Accept both "nl.route" and "nl/route"
  if (method === "nl.route" || method === "nl/route") {
    const instruction: string = params?.instruction ?? "";
    try {
      const result = await route(instruction); // 👈 await the async route
      return res.json({ jsonrpc: "2.0", id, result });
    } catch (e: any) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32001, message: e?.message || "routing failed" } });
    }
  }

  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

// Single listener with port fallback (avoid double listen/EADDRINUSE)
function listen(port: number, attemptsLeft = 15) {
  const server = app.listen(port, () => {
    console.log(`[router-mcp] listening on http://127.0.0.1:${port}/rpc`);
  });
  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE" && attemptsLeft > 0) {
      const next = port + 1;
      console.warn(`[router-mcp] port ${port} in use; trying ${next}…`);
      setTimeout(() => listen(next, attemptsLeft - 1), 100);
    } else {
      throw err;
    }
  });
}
listen(basePort);