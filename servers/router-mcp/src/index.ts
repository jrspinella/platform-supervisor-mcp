// servers/router-mcp/src/index.ts — NL router with create RG/Plan + safe location parsing
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

  // workload
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
  tagsObj: /\btags?\s*(?::|=)?\s*(\{[\s\S]*?\})/i,

  // loose tokens
  rgLoose: /\brg[-\w]+\b/i,

  // SKU capture
  skuWord: /\b(?:sku|tier|size)\b[:=]?\s*([A-Za-z0-9_+-]+)\b/i, // "sku P1v3" / "tier PremiumV3"
  skuToken: /\b(?:P\d(?:v\d)?|S\d|B\d|F\d|I\d|PremiumV3|PremiumV2|Premium|Standard|Basic|Free|Shared)\b/i,
  // alias for older code paths
  skuPattern: /\b(?:sku|tier|size)\b[:=]?\s*([A-Za-z0-9_+-]+)\b/i,
} as const;

// tiny helper
function extractFirst<T = string>(re: RegExp, s: string, group = 1): T | undefined {
  const m = re.exec(s);
  return (m && (m[group] as unknown as T)) || undefined;
}

// ── Extractors ────────────────────────────────────────────────────────────────
// Robust location parser:
//  - "in location usgovvirginia"
//  - "location usgovvirginia"
//  - "in usgovvirginia"
//  - skips tokens starting with "rg-" and the literal word "location"
function extractLocationSafe(s: string): string | undefined {
  // "in location <region>"
  const inLoc = /(?:^|\W)in\s+location\s+([a-z0-9-]{2,})\b/i.exec(s)?.[1];
  if (inLoc && !/^rg-/.test(inLoc)) return inLoc;

  // "location <region>"
  const loc = /(?:^|\W)location\s+([a-z0-9-]{2,})\b/i.exec(s)?.[1];
  if (loc && !/^rg-/.test(loc)) return loc;

  // "location: <region>"
  const locField = extractFirst<string>(RE.locationField, s);
  if (locField && !/^rg-/.test(locField)) return locField;

  // "in <region>" — iterate to skip "in location"
  let m: RegExpExecArray | null;
  const re = new RegExp(RE.locationLoose.source, "gi");
  while ((m = re.exec(s)) !== null) {
    const tok = m[1];
    if (tok.toLowerCase() === "location") {
      // try to grab the *next* word after "location"
      const after = /\blocation\s+([a-z0-9-]{2,})\b/i.exec(s.slice(m.index));
      const nxt = after?.[1];
      if (nxt && !/^rg-/.test(nxt)) return nxt;
      continue;
    }
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
function extractRgCreate(s: string) {
  const rawName =
    extractFirst<string>(RE.nameField, s, 1) ||
    extractFirst<string>(RE.rgName, s, 1) ||
    extractFirst<string>(RE.rgLoose, s, 0);

  const loc = extractLocationSafe(s);

  const sanitizedRgName = sanitizeRgName(rawName);

  let tags: Record<string, string> | undefined;
  const tagsRaw = extractFirst<string>(RE.tagsObj, s, 1);
  if (tagsRaw) {
    try { tags = parseTags(JSON.parse(tagsRaw)); } catch {}
  }
  return { rawName, sanitizedRgName, location: loc, tags };
}

function extractPlanCreate(s: string) {
  const name = extractFirst<string>(RE.planName, s);
  const resourceGroupName =
    /(?:in|on)\s+(rg-[a-z0-9-]{3,40})\b/i.exec(s)?.[1] ||
    extractFirst<string>(RE.rgLoose, s);

  const location = extractLocationSafe(s);
  const sku = extractSku(s);
  return { name, resourceGroupName, location, sku };
}

function extractWebCreate(s: string) {
  const name = extractFirst<string>(RE.webappName, s);
  const resourceGroupName =
    /(?:in|on)\s+(rg-[a-z0-9-]{3,40})\b/i.exec(s)?.[1] ||
    extractFirst<string>(RE.rgLoose, s);

  const location = extractLocationSafe(s);
  return { name, resourceGroupName, location };
}

// ── Router ────────────────────────────────────────────────────────────────────
function route(instruction: string) {
  const text = (instruction || "").trim();

  const hasScan = RE.scan.test(text);
  const hasCreate = RE.create.test(text);
  const mentionsWeb = RE.webappWord.test(text);
  const mentionsPlan = RE.planWord.test(text);
  const mentionsRg = RE.rgWord.test(text);

  // CREATE — prefer specific resources before generic RG
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

  // CREATE RG — only if the prompt is *just* about an RG (avoid hijacking plan/web prompts)
  if (hasCreate && mentionsRg && !mentionsPlan && !mentionsWeb) {
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
    const resourceGroupName = extractFirst<string>(RE.rgName, text) || extractFirst<string>(RE.rgLoose, text);
    const name = extractFirst<string>(RE.webappName, text);
    if (resourceGroupName && name) {
      return {
        tool: "platform.scan_webapp_baseline",
        args: { resourceGroupName, name, profile: ATO_DEFAULT },
        rationale: "scan webapp detected (rg + name parsed)",
      };
    }
  }

  // SCAN APP SERVICE PLAN
  if (hasScan && mentionsPlan) {
    const resourceGroupName = extractFirst<string>(RE.rgName, text) || extractFirst<string>(RE.rgLoose, text);
    const name = extractFirst<string>(RE.planName, text);
    if (resourceGroupName && name) {
      return {
        tool: "platform.scan_appplan_baseline",
        args: { resourceGroupName, name, profile: ATO_DEFAULT },
        rationale: "scan app service plan detected (rg + name parsed)",
      };
    }
  }

  // SCAN RESOURCE GROUP
  if (hasScan && mentionsRg) {
    const rgName = extractFirst<string>(RE.rgName, text) || extractFirst<string>(RE.rgLoose, text);
    if (rgName) {
      return {
        tool: "platform.scan_resource_group_baseline",
        args: { resourceGroupName: rgName, profile: ATO_DEFAULT },
        rationale: "scan + resource group detected (rg name parsed)",
      };
    }
  }

  // Workload macro
  if (RE.workload.test(text)) {
    return {
      tool: "platform.create_workload",
      args: { prompt: instruction, apply: true, profile: ATO_DEFAULT },
      rationale: "create workload detected (macro tool)",
    };
  }

  // Fallback
  return { tool: "platform.policy_dump", args: {}, rationale: "fallback: show merged policy (intent not recognized)" };
}

// ── JSON-RPC surface ──────────────────────────────────────────────────────────
app.post("/rpc", (req, res) => {
  const { method, params, id } = req.body ?? {};
  if (method === "health") return res.json({ jsonrpc: "2.0", id, result: "ok" });

  if (method === "nl.route") {
    const instruction: string = params?.instruction ?? "";
    try {
      const result = route(instruction); // { tool, args, rationale }
      return res.json({ jsonrpc: "2.0", id, result });
    } catch (e: any) {
      return res.json({ jsonrpc: "2.0", id, error: { code: -32001, message: e?.message || "routing failed" } });
    }
  }

  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

const port = Number(process.env.PORT || 8700);
app.listen(port, () => console.log(`[router-mcp] listening on http://127.0.0.1:${port}/rpc`));