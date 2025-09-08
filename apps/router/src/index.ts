import "dotenv/config";
import express from "express";
import { deepSanitize } from "./sanitize.js";

const PORT = Number(process.env.PORT ?? 8700);

// IMPORTANT: base URLs should be the service root (no trailing /mcp)
// We will call `${base}/mcp` for JSON-RPC.
const services: Record<string, string> = {
  azure:      process.env.AZURE_URL      || "http://127.0.0.1:8711",
  github:     process.env.GITHUB_URL     || "http://127.0.0.1:8712",
  onboarding: process.env.ONBOARDING_URL || "http://127.0.0.1:8714",
  governance: process.env.GOVERNANCE_URL || "http://127.0.0.1:8715",
  platform:   process.env.PLATFORM_URL   || "http://127.0.0.1:8716",
  developer:  process.env.DEVELOPER_URL  || "http://127.0.0.1:8717",
};

const app = express();
app.use(express.json());

// -------------------- helpers --------------------

async function postJsonRpc(baseUrl: string, method: string, params: any) {
  const body = { jsonrpc: "2.0", id: Date.now(), method, params };
  const r = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
}

/**
 * Fetch a service's tools and normalize to:
 *   - remoteName: as published by the MCP
 *   - localName:  remote name with leading "<svc>." removed if present
 */
async function fetchServiceTools(svc: string, baseUrl: string): Promise<Array<{
  remoteName: string;
  localName: string;
  description?: string;
  inputSchema?: any;
}>> {
  const { status, json } = await postJsonRpc(baseUrl, "tools/list", {});
  if (status !== 200 || !json?.result?.tools) return [];
  const tools: Array<{ name: string; description?: string; inputSchema?: any }> = json.result.tools;

  return tools.map((t) => {
    const remoteName = t.name; // e.g. "azure.create_app_service_plan" OR "create_app_service_plan"
    const prefix = `${svc}.`;
    const localName = remoteName.startsWith(prefix) ? remoteName.slice(prefix.length) : remoteName;
    return { remoteName, localName, description: t.description, inputSchema: t.inputSchema };
  });
}

// -------------------- list tools --------------------

app.get("/a2a/tools/list", async (_req, res) => {
  try {
    const aggregated: any[] = [];

    for (const [svc, base] of Object.entries(services)) {
      try {
        // Governance is internal; skip publishing it as a callable service.
        if (svc === "governance") continue;

        const tools = await fetchServiceTools(svc, base);
        for (const t of tools) {
          // We publish a clean external name "<svc>.<localName>"
          aggregated.push({
            name: `${svc}.${t.localName}`,
            description: t.description,
            inputSchema: t.inputSchema,
          });
        }
      } catch (e) {
        console.error(`[router] tools/list: failed for ${svc}:`, e);
      }
    }

    res.json({
      jsonrpc: "2.0",
      id: Date.now(),
      result: {
        tools: deepSanitize(aggregated),
      },
    });
  } catch (e) {
    console.error("[router] tools/list error:", e);
    res.status(500).json({
      jsonrpc: "2.0",
      id: Date.now(),
      error: { code: -32000, message: "Failed to list tools" },
    });
  }
});

// -------------------- call tool --------------------

app.post("/a2a/tools/call", async (req, res) => {
  const id = Date.now();
  try {
    const { name, arguments: args } = req.body || {};
    if (!name || typeof name !== "string" || !name.includes(".")) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Expected 'name' like '<service>.<tool>'" }
      });
    }

    const firstDot = name.indexOf(".");
    const svc = name.slice(0, firstDot);                 // "azure"
    const localRequested = name.slice(firstDot + 1);     // "create_app_service_plan"

    const base = services[svc];
    if (!base) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown service: ${svc}` }
      });
    }

    // Discover current tool names from the target MCP
    const tools = await fetchServiceTools(svc, base);

    // Resolve to a remote name the MCP understands:
    // 1) exact local match
    // 2) remote equals the provided RHS as-is
    // 3) remote equals "<svc>.<local>"
    const remoteMatch =
      tools.find(t => t.localName === localRequested)?.remoteName ||
      tools.find(t => t.remoteName === localRequested)?.remoteName ||
      `${svc}.${localRequested}`; // safe fallback

    // Forward the JSON-RPC call to the target MCP
    const { status, json } = await postJsonRpc(base, "tools/call", {
      name: remoteMatch,
      arguments: args || {}
    });

    // If the MCP truly doesn't have the tool, return a consistent error
    if (json?.error && (json.error.code === -32601 || /unknown tool/i.test(String(json.error.message)))) {
      return res.status(400).json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` }
      });
    }

    // Pass through the JSON-RPC envelope, but sanitize payloads
    const safe = deepSanitize(json);
    return res.status(status).json(safe);

  } catch (e: any) {
    console.error("[router] tools/call error:", e);
    return res.status(502).json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: String(e?.message || e) }
    });
  }
});

app.post("/mcp", async (req, res) => {
  const { id, method, params } = req.body || {};
  try {
    if (method === "tools/list") {
      // reuse your existing aggregator
      const r = await fetch(`${services.platform}/mcp`, { // or aggregate across all services yourself
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/list", params: {} })
      });
      const j = await r.json();
      // If you prefer: aggregate all services here the same way you do in /a2a/tools/list
      return res.json({ jsonrpc: "2.0", id, result: j.result });
    }

    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      // forward to your existing A2A call and wrap response back into MCP shape
      const r = await fetch(`${process.env.ROUTER_URL || "http://127.0.0.1:8700"}/a2a/tools/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args })
      });
      const txt = await r.text();
      let body: any; try { body = JSON.parse(txt); } catch { body = { raw: txt }; }

      if (!r.ok || body.error) {
        return res.status(200).json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Error: ${JSON.stringify(body.error || body).slice(0,800)}` }], isError: true }
        });
      }

      return res.json({ jsonrpc: "2.0", id, result: body.result });
    }

    // default
    return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
  } catch (e: any) {
    return res.status(200).json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `Router MCP error: ${String(e?.message || e)}` }], isError: true }
    });
  }
});

app.listen(PORT, () => {
  console.log(`[router] listening on :${PORT}`);
});