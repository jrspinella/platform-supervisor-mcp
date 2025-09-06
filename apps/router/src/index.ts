import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { zodToJsonSchema } from "zod-to-json-schema";

function toJSONSchema(schema: any) {
  return zodToJsonSchema(schema, { $refStrategy: "none" });
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// ---- services ----
const services: Record<string, string> = {
  platform: process.env.PLATFORM_MCP_URL || "http://127.0.0.1:8710",
  github: process.env.GITHUB_MCP_URL || "http://127.0.0.1:8711",
  onboarding: process.env.ONBOARDING_MCP_URL || "http://127.0.0.1:8714",
  azure: process.env.AZURE_MCP_URL || "http://127.0.0.1:8799",
  teams: process.env.TEAMS_MCP_URL || "http://127.0.0.1:8713",
  governance: process.env.GOVERNANCE_MCP_URL || "http://127.0.0.1:8715",
};

// ---- audit helpers ----
const AUDIT_DIR = process.env.AUDIT_DIR || path.resolve(process.cwd(), "logs");
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.jsonl");
fs.mkdirSync(AUDIT_DIR, { recursive: true });

function redact(v: any) {
  const text = JSON.stringify(v);
  return text
    .replace(/("password"\s*:\s*")([^"]+)(")/gi, '$1***REDACTED***$3')
    .replace(/("connectionString"\s*:\s*")([^"]+)(")/gi, '$1***REDACTED***$3')
    .replace(/("secret|token|key"\s*:\s*")([^"]+)(")/gi, '$1***REDACTED***$3');
}
function auditWrite(entry: any) {
  const line = JSON.stringify(entry);
  fs.appendFile(AUDIT_FILE, line + "\n", () => { });
}

async function postJsonRpc(baseUrl: string, method: string, params?: any, timeoutMs = 15000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: controller.signal
    });
    const ct = r.headers.get("content-type") || "";
    const text = await r.text();
    if (!ct.includes("application/json")) throw new Error(`Upstream ${baseUrl} returned ${r.status} ${ct}: ${text.slice(0, 200)}`);
    return { status: r.status, json: JSON.parse(text) };
  } finally {
    clearTimeout(t);
  }
}

async function fetchServiceTools(serviceName: string, baseUrl: string) {
  const { json } = await postJsonRpc(baseUrl, "tools/list");
  const list = json?.result?.tools ?? [];
  return list.map((t: any) => {
    const remoteName: string = t.name;
    const parts = String(remoteName).split(".");
    const localName = parts.length > 1 ? parts.slice(1).join(".") : remoteName;
    return { localName, remoteName, description: t.description, inputSchema: t.inputSchema };
  });
}

// ---- governance preflight ----
async function governanceEvaluate(reqId: string, serviceName: string, toolLocalOrRemote: string, args: any) {
  const gov = services.governance;
  if (!gov) return { decision: "allow" as const, reasons: [], policyIds: [], suggestions: [] };
  // Tool FQ the way governance expects it:
  const toolFq = toolLocalOrRemote.includes(".")
    ? toolLocalOrRemote
    : `${serviceName}.${toolLocalOrRemote}`;
  const { json } = await postJsonRpc(gov, "tools/call", {
    name: "governance.evaluate",
    arguments: { tool: toolFq, args }
  });
  const res = json?.result ?? json; // normalize
  // governance-mcp result is JSON-RPC “result.content[0].json”
  const content = res?.content?.find?.((c: any) => c.json)?.json || {};
  return {
    decision: content.decision || "allow",
    reasons: content.reasons || [],
    policyIds: content.policyIds || [],
    suggestions: content.suggestions || []
  };
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, services });
});

// ---- list tools ----
app.post("/a2a/tools/call", async (req, res) => {
  const started = Date.now();
  const reqId = crypto.randomUUID();
  res.setHeader("x-request-id", reqId);

  const { name, arguments: args } = req.body || {};
  const id = Date.now();

  // If you don’t have these helpers, stub them or remove:
  const auditBase = { ts: new Date().toISOString(), reqId, name, argsPreview: args }; // keep simple
  const governedPrefixes = ["azure", "github", "teams"];

  try {
    if (!name || typeof name !== "string" || !name.includes(".")) {
      // auditWrite({ ...auditBase, event: "reject", reason: "bad_name" });
      return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Expected 'name' like '<service>.<tool>'" } });
    }

    const firstDot = name.indexOf(".");
    const serviceName = name.slice(0, firstDot);
    const toolNameRequested = name.slice(firstDot + 1);
    const baseUrl = services[serviceName];

    if (!baseUrl) {
      // auditWrite({ ...auditBase, event: "reject", reason: "unknown_service", serviceName });
      return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown service: ${serviceName}` } });
    }

    // 1) Resolve the *remote* tool name from the upstream service
    let tools: Array<{ localName: string; remoteName: string }>;
    try {
      tools = await fetchServiceTools(serviceName, baseUrl); // must hit POST /mcp tools/list internally
    } catch (err) {
      // auditWrite({ ...auditBase, event: "upstream_tools_error", serviceName, error: String(err) });
      return res.status(502).json({ jsonrpc: "2.0", id, error: { code: -32000, message: `Failed to fetch tools from ${serviceName}` } });
    }

    const match =
      tools.find(t => t.localName === toolNameRequested) ||
      tools.find(t => t.remoteName === toolNameRequested) ||
      tools.find(t => t.remoteName === `${serviceName}.${toolNameRequested}`);

    if (!match) {
      // auditWrite({ ...auditBase, event: "reject", reason: "unknown_tool", serviceName, toolNameRequested });
      return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });
    }

    // 2) Governance preflight ONCE, using the resolved remote name
    if (governedPrefixes.includes(serviceName) && services.governance) {
      try {
        const gov = await postJsonRpc(services.governance, "tools/call", {
          name: "governance.evaluate",
          arguments: { tool: match.remoteName, args: args || {} }
        });
        const content = gov.json?.result?.content;
        const evalJson = Array.isArray(content) ? content.find((c: any) => c.json)?.json : null;
        const decision = evalJson?.decision || "allow";
        const reasons = evalJson?.reasons || [];
        const suggestions = evalJson?.suggestions || [];

        if (decision === "deny") {
          // auditWrite({ ...auditBase, event: "governance_deny", serviceName, tool: match.remoteName, reasons, suggestions });
          return res.status(403).json({
            jsonrpc: "2.0", id,
            error: { code: -32003, message: "GovernanceDenied: not allowed",
              data: { service: serviceName, tool: match.remoteName, reasons, suggestions } }
          });
        }
        if (decision === "warn") {
          res.setHeader("x-governance-warning", "true");
          res.setHeader("x-governance-reasons", encodeURIComponent(JSON.stringify(reasons)));
          res.setHeader("x-governance-suggestions", encodeURIComponent(JSON.stringify(suggestions)));
        }
      } catch (e: any) {
        console.error("[router] governance preflight error:", e?.message || e);
        // dev: proceed; prod: you may choose to fail closed
      }
    }

    // 3) Forward the call to the upstream MCP
    const { status, json } = await postJsonRpc(baseUrl, "tools/call", { name: match.remoteName, arguments: args || {} });
    // auditWrite({ ...auditBase, event: "forwarded", serviceName, tool: match.remoteName, durationMs: Date.now() - started, upstreamStatus: status });

    if (json?.error) return res.status(400).json({ jsonrpc: "2.0", id, error: json.error });
    return res.json({ jsonrpc: "2.0", id, result: json?.result });
  } catch (e: any) {
    // auditWrite({ ...auditBase, event: "router_error", err: String(e?.message || e), durationMs: Date.now() - started });
    return res.status(500).json({ jsonrpc: "2.0", id, error: { code: -32000, message: e?.message ?? "Server error" } });
  }
});

// ---- call tool w/ governance preflight & audit ----
app.get("/a2a/tools/list", async (_req, res) => {
  try {
    const aggregated: any[] = [];
    for (const [serviceName, baseUrl] of Object.entries(services)) {
      if (serviceName === "governance") continue; // hide governance
      try {
        const tools = await fetchServiceTools(serviceName, baseUrl); // must use POST /mcp tools/list inside
        for (const t of tools) {
          aggregated.push({
            name: `${serviceName}.${t.localName}`,
            description: t.description,
            inputSchema: t.inputSchema, // <-- pass through
          });
        }
      } catch (err) {
        console.error(`Failed to fetch tools from ${serviceName}:`, err);
      }
    }
    res.json({ jsonrpc: "2.0", id: Date.now(), result: { tools: aggregated } });
  } catch (err) {
    console.error("Error listing tools:", err);
    res.status(500).json({ error: "Failed to list tools" });
  }
});

const PORT = Number(process.env.PORT || 8700);
app.listen(PORT, () => {
  console.log(`[router] listening on :${PORT}`);
  console.log(`[router] services:`, services);
});