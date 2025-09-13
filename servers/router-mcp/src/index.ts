// servers/router-mcp/src/index.ts — minimal NL router with arg mapping + default profile injection
import express from "express";
import "dotenv/config";

const app = express();
app.use(express.json());

const ATO_DEFAULT = (process.env.ATO_PROFILE || "default").trim();

// ── Regex helpers ──────────────────────────────────────────────────────────────
const RE = {
  // intents
  scan: /\bscan\b/i,
  create: /\bcreate\b/i,

  // resource kinds
  webappWord: /\b(web\s*app|webapp)\b/i,
  planWord: /\b(app\s*service\s*plan|plan)\b/i,
  rgWord: /\b(resource\s*group|rg)\b/i,

  // names
  webappName: /\b(?:web\s*app|webapp)\s+([a-z0-9-]+)/i,
  planName: /\b(?:app\s*service\s*plan|plan)\s+([a-z0-9-]+)/i,
  rgName: /\bresource\s*group\s+([a-z0-9-]+)/i,

  // generic captures
  location: /\b(location|in)\s+([a-z0-9-]+)\b/i,
  tagsObj: /\btags\s*[:=]\s*(\{[^}]*\})/i,
  nameField: /\bname\s*[:=]\s*([A-Za-z0-9-_]+)/i,
  rgLoose: /\brg[-\w]+\b/i,
};

// ── Extractors ────────────────────────────────────────────────────────────────
function extractRgCreate(text: string) {
  // name from "name: x", or "rg-foo" token after create rg, or "resource group <name>"
  const name =
    RE.nameField.exec(text)?.[1] ||
    RE.rgName.exec(text)?.[1] ||
    RE.rgLoose.exec(text)?.[0];

  const loc = RE.location.exec(text)?.[2];

  let tags: Record<string, string> | undefined;
  const tagsRaw = RE.tagsObj.exec(text)?.[1];
  if (tagsRaw) {
    try { tags = parseTags(JSON.parse(tagsRaw)); } catch { /* ignore */ }
  }
  return { name, location: loc, tags };
}

function extractWebScan(text: string) {
  const resourceGroupName = RE.rgName.exec(text)?.[1];
  const name = RE.webappName.exec(text)?.[1];
  return { resourceGroupName, name };
}

function extractPlanScan(text: string) {
  const resourceGroupName = RE.rgName.exec(text)?.[1];
  const name = RE.planName.exec(text)?.[1];
  return { resourceGroupName, name };
}

// Robust, forgiving tag parser for NL inputs.
function parseTags(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lower = input.trim();

  // Canonicalize common synonyms; extend as needed.
  const canon = (k: string) =>
    ({
      environment: "env",
      env: "env",
      owner: "owner",
      application: "app",
      app: "app",
      project: "project",
    }[k] || k);

  // Focus on text after the word "tags" if present (reduces false positives).
  const iTags = lower.toLowerCase().indexOf("tags");
  const scope = iTags >= 0 ? lower.slice(iTags + 4) : lower;

  // 1) Fast path: key :|=| is value   (value may be "quoted" or 'quoted' or single-token)
  //    Examples: owner:jrs, owner=jrs, owner is jrs, owner:"John R S"
  const pairRe =
    /\b([a-z][\w.-]*)\s*(?:=|:|\bis\b)\s*(?:"([^"]+)"|'([^']+)'|([^\s,;{}]+))/gi;

  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(scope)) !== null) {
    const key = canon(m[1].toLowerCase());
    if (key === "tags") continue;
    const val = (m[2] ?? m[3] ?? m[4] ?? "").replace(/[.,;]$/g, "");
    if (key && val) out[key] = val;
  }

  // 2) Brace block fallback: tags { owner:jrs, env:dev }  (json-ish, yaml-ish)
  if (Object.keys(out).length === 0) {
    const brace = scope.match(/\{([\s\S]*?)\}/);
    if (brace) {
      const body = brace[1];
      // Reuse the same regex within the braces
      let mb: RegExpExecArray | null;
      while ((mb = pairRe.exec(body)) !== null) {
        const key = canon(mb[1].toLowerCase());
        const val = (mb[2] ?? mb[3] ?? mb[4] ?? "").replace(/[.,;]$/g, "");
        if (key && val) out[key] = val;
      }
      // Last resort: try to coerce into JSON (quote keys) and parse
      if (Object.keys(out).length === 0) {
        try {
          const jsonish = "{" +
            body
              .replace(/([,{]\s*)([A-Za-z_][\w.-]*)\s*:/g, '$1"$2":') // quote keys
              .replace(/:\s*'([^']*)'/g, ':"$1"') +
            "}";
          const obj = JSON.parse(jsonish);
          for (const [k, v] of Object.entries(obj)) out[canon(k.toLowerCase())] = String(v);
        } catch {
          /* ignore */
        }
      }
    }
  }

  return out;
}

function route(instruction: string) {
  const raw = instruction.toLowerCase() || "";
  const text = raw.trim();

  const hasScan = RE.scan.test(text);
  const hasCreate = RE.create.test(text);
  const mentionsWeb = RE.webappWord.test(text);
  const mentionsPlan = RE.planWord.test(text);
  const mentionsRg = RE.rgWord.test(text);  

  // CREATE RG
  if (hasCreate && mentionsRg) {
    const { name, location, tags } = extractRgCreate(text);
    if (name && location) {
      return {
        tool: "platform.create_resource_group",
        args: { name, location, ...(tags ? { tags } : {}) },
        rationale: "create + resource group detected (name/location parsed)",
      };
    }
  }

  // SCAN WEB APP
  if (hasScan && mentionsWeb) {
    const { resourceGroupName, name } = extractWebScan(text);
    if (resourceGroupName && name) {
      return {
        tool: "platform.scan_webapp_baseline",
        args: { resourceGroupName, name, profile: ATO_DEFAULT },
        rationale: "scan + webapp detected (rg + name parsed)",
      };
    }
  }

  // SCAN APP SERVICE PLAN
  if (hasScan && mentionsPlan) {
    const { resourceGroupName, name } = extractPlanScan(text);
    if (resourceGroupName && name) {
      return {
        tool: "platform.scan_appplan_baseline",
        args: { resourceGroupName, name, profile: ATO_DEFAULT },
        rationale: "scan + app service plan detected (rg + name parsed)",
      };
    }
  }

  // SCAN RESOURCE GROUP (baseline everything in RG)
  if (hasScan && mentionsRg) {
    const rgName =
      RE.rgName.exec(text)?.[1] ||
      RE.rgLoose.exec(text)?.[0];

    if (rgName) {
      return {
        tool: "platform.scan_resource_group_baseline",
        args: { resourceGroupName: rgName, profile: ATO_DEFAULT },
        rationale: "scan + resource group detected (rg name parsed)",
      };
    }
  }

  // Fallback
  return {
    tool: "platform.policy_dump",
    args: {},
    rationale: "fallback: show merged policy (intent not recognized)",
  };
}

app.post("/rpc", (req, res) => {
  const { method, params, id } = req.body ?? {};

  // Health ping (handy for testing)
  if (method === "health") {
    return res.json({ jsonrpc: "2.0", id, result: "ok" });
  }

  // The only method this service implements
  if (method === "nl.route") {
    const instruction: string = params?.instruction ?? "";
    try {
      const result = route(instruction); // { tool, args, rationale }
      return res.json({ jsonrpc: "2.0", id, result });
    } catch (e: any) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: e?.message || "routing failed" },
      });
    }
  }

  // Unknown method — return JSON-RPC error (not HTTP 404)
  return res.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  });
});

const port = Number(process.env.PORT || 8700);
app.listen(port, () => console.log(`[router-mcp] listening on http://127.0.0.1:${port}/rpc`));