// servers/router-mcp/src/index.ts — NL router with RG/Plan/Web + "app workloads" scan
import express from "express";
import "dotenv/config";
import { parseTags, sanitizeRgName } from "./utils";

const app = express();
app.use(express.json());

const ATO_DEFAULT = (process.env.ATO_PROFILE || "default").trim();

// ── Regex helpers ──────────────────────────────────────────────────────────────
const RE = {
  // intents
  scan: /\bscan\b/i,
  create: /\bcreate\b/i,

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
  locationField: /\blocation\s*[:=]\s*([a-z0-9-]+)\b/i,   // e.g. "location: usgovvirginia"
  locationLoose: /\b(?:in|at)\s+([a-z0-9-]+)\b/i,         // e.g. "in usgovvirginia"
  tagsObj: /\btags?\s*[:=]\s*(\{[\s\S]*?\})/i,

  // loose tokens
  rgLoose: /\brg[-\w]+\b/i,
  rgToken: /\b(rg-[a-z0-9-]{3,40})\b/i, // capture explicit RG tokens anywhere

  // SKU patterns
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
    extractFirst<string>(RE.rgName, text, 1) ||  // "resource group rg-foo" / "rg rg-foo"
    extractFirst<string>(RE.rgToken, text, 1) || // any "rg-foo" token
    extractFirst<string>(RE.rgLoose, text, 0)    // fallback
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
  return { rawName, sanitizedRgName, location: loc, tags };
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
  return { name, resourceGroupName, location };
}

// ── Router ────────────────────────────────────────────────────────────────────
function route(instruction: string) {
  const original = (instruction || "").trim();
  const text = stripAtPrefix(original); // remove "@platform " etc.

  const hasScan = RE.scan.test(text);
  const hasCreate = RE.create.test(text);
  const mentionsWeb = RE.webappWord.test(text);
  const mentionsPlan = RE.planWord.test(text);
  const mentionsRg = RE.rgWord.test(text);

  // SCAN APP WORKLOADS (Web Apps + App Service Plans in an RG) — place first among scans
  if (hasScan && RE.appWorkloads.test(text)) {
    const rgName = getRgNameFromText(text);
    if (rgName) {
      return {
        tool: "platform.scan_resource_group_baseline",
        args: {
          resourceGroupName: rgName,
          profile: ATO_DEFAULT,
          include: ["appServicePlan", "webApp"],
        },
        rationale: "scan app workloads detected (RG parsed; filtering to plans + web apps)",
      };
    }
  }

  // CREATE — handle specific resources BEFORE generic RG
  if (hasCreate && mentionsPlan) {
    const { name, resourceGroupName, location, sku } = extractPlanCreate(text);
    if (name && resourceGroupName && location && sku) {
      return {
        tool: "platform.create_app_service_plan",
        args: { resourceGroupName, name, location, sku },
        rationale: "create app service plan detected (rg/name/location/sku parsed)",
      };
    }
  }

  if (hasCreate && mentionsWeb) {
    const { name, resourceGroupName, location } = extractWebCreate(text);
    if (name && resourceGroupName && location) {
      return {
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
        },
        rationale: "create web app detected (rg/name/location parsed)",
      };
    }
  }

  // CREATE RG — last among create paths
  if (hasCreate && mentionsRg) {
    const { rawName, sanitizedRgName, location, tags } = extractRgCreate(text);
    if (sanitizedRgName && location) {
      return {
        tool: "platform.create_resource_group",
        args: { name: sanitizedRgName, location, ...(tags ? { tags } : {}), _rawName: rawName },
        rationale: "create resource group detected (name/location parsed)",
      };
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
app.post("/rpc", (req, res) => {
  const { method, params, id } = req.body ?? {};
  if (method === "health") return res.json({ jsonrpc: "2.0", id, result: "ok" });

  if (method === "nl.route") {
    const instruction: string = params?.instruction ?? "";
    try {
      const result = route(instruction);
      return res.json({ jsonrpc: "2.0", id, result });
    } catch (e: any) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32001, message: e?.message || "routing failed" } });
    }
  }

  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

const port = Number(process.env.PORT || 8700);
app.listen(port, () => console.log(`[router-mcp] listening on http://127.0.0.1:${port}/rpc`));