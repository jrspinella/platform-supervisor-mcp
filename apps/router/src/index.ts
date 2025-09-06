import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import { zodToJsonSchema } from "zod-to-json-schema";

function toJSONSchema(schema: any) {
  return zodToJsonSchema(schema, { $refStrategy: "none" });
}

const app = express();
app.use(express.json());

const services: Record<string, string> = {
  github: process.env.GITHUB_MCP_URL || "http://127.0.0.1:8711",
  azure: process.env.AZURE_MCP_URL || "http://127.0.0.1:8799",
  teams: process.env.TEAMS_MCP_URL || "http://127.0.0.1:8713",
  onboarding: process.env.ONBOARDING_MCP_URL || "http://127.0.0.1:8712",
  governance: process.env.GOVERNANCE_MCP_URL || "http://127.0.0.1:8715",
};

// ---- helpers ----
async function postJsonRpc(baseUrl: string, method: string, params?: any) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params });
  const r = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  if (!ct.includes("application/json")) {
    throw new Error(`Upstream ${baseUrl} returned ${r.status} ${ct}: ${text.slice(0, 200)}`);
  }
  let json: any;
  try { json = JSON.parse(text); } catch (e) {
    throw new Error(`Invalid JSON from ${baseUrl}: ${String(e)} body=${text.slice(0, 200)}`);
  }
  return { status: r.status, json };
}

// Get normalized upstream tool list for a service
async function fetchServiceTools(serviceName: string, baseUrl: string) {
  const { json } = await postJsonRpc(baseUrl, "tools/list");
  const list = json?.result?.tools ?? [];
  // Normalize to objects: { localName, remoteName, description, inputSchema }
  // If an upstream tool already includes a prefix like "azure.create_resource_group",
  // localName becomes the part after the first dot; else it's the whole name.
  return list.map((t: any) => {
    const remoteName: string = t.name;
    const parts = String(remoteName).split(".");
    const localName = parts.length > 1 ? parts.slice(1).join(".") : remoteName;
    return {
      localName,            // used by our router (unprefixed)
      remoteName,           // exact name expected by the MCP
      description: t.description,
      inputSchema: t.inputSchema,
    };
  });
}

async function callGovernanceValidate(service: string, toolLocalName: string, args: any) {
  const govBase = services["governance"];
  if (!govBase) return { allowed: true }; // fail-open if not configured
  try {
    const { json } = await postJsonRpc(govBase, "tools/call", {
      name: "governance.validate_request",
      arguments: { service, tool: toolLocalName, args }
    });
    const content = json?.result?.content ?? [];
    const first = content.find((c: any) => c?.json) ?? {};
    const verdict = first.json || {};
    return { allowed: !!verdict.allowed, reason: verdict.reason, suggestions: verdict.suggestions };
  } catch (e) {
    // Choose fail-open or fail-closed. For dev, fail-open:
    console.warn("[router] governance unavailable, proceeding (fail-open):", e);
    return { allowed: true };
  }
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, services });
});

// ---- A2A: list tools (aggregated) ----
app.get("/a2a/tools/list", async (_req, res) => {
  try {
    const aggregated: any[] = [];
    for (const [serviceName, baseUrl] of Object.entries(services)) {
      try {
        const tools = await fetchServiceTools(serviceName, baseUrl);
        // Present as "<service>.<localName>" to the client
        for (const t of tools) {
          aggregated.push({
            name: `${serviceName}.${t.localName}`,
            description: t.description,
            inputSchema: t.inputSchema,
          });
        }
      } catch (err) {
        console.error(`Failed to fetch tools from ${serviceName}:`, err);
      }
    }
    res.json({
      jsonrpc: "2.0",
      id: Date.now(),
      result: {
        tools: aggregated.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: toJSONSchema(t.inputSchema),
        })),
      },
    });
  } catch (err) {
    console.error("Error listing tools:", err);
    res.status(500).json({ error: "Failed to list tools" });
  }
});

// ---- A2A: call tool ----
app.post("/a2a/tools/call", async (req, res) => {
  const { name, arguments: args } = req.body || {};
  const id = Date.now();

  try {
    if (!name || typeof name !== "string" || !name.includes(".")) {
      return res.status(400).json({
        jsonrpc: "2.0", id,
        error: { code: -32602, message: "Expected 'name' like '<service>.<tool>'" },
      });
    }

    // Split once: allow tool names that themselves contain dots beyond the first
    const firstDot = name.indexOf(".");
    const serviceName = name.slice(0, firstDot);
    const toolNameRequested = name.slice(firstDot + 1); // may contain dots
    const baseUrl = services[serviceName];

    if (!baseUrl) {
      return res.status(400).json({
        jsonrpc: "2.0", id,
        error: { code: -32601, message: `Unknown service: ${serviceName}` },
      });
    }

    // Get upstream tools (normalized)
    let tools: Array<{ localName: string; remoteName: string }>;
    try {
      tools = await fetchServiceTools(serviceName, baseUrl);
    } catch (err) {
      console.error(`Failed to fetch tools from ${serviceName}:`, err);
      return res.status(502).json({
        jsonrpc: "2.0", id,
        error: { code: -32000, message: `Failed to fetch tools from ${serviceName}` },
      });
    }

    // Find matching tool (support both unprefixed and prefixed upstream naming)
    const match =
      tools.find(t => t.localName === toolNameRequested) ||
      tools.find(t => t.remoteName === toolNameRequested) ||
      tools.find(t => t.remoteName === `${serviceName}.${toolNameRequested}`);

    if (!match) {
      return res.status(400).json({
        jsonrpc: "2.0", id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      });
    }

    // Governance enforcement (only for destructive domains)
    if (["azure", "github", "teams"].includes(serviceName)) {
      const verdict = await callGovernanceValidate(serviceName, toolNameRequested, args);
      if (!verdict.allowed) {
        return res.status(403).json({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32003,
            message: `GovernanceDenied: ${verdict.reason || "not allowed"}`,
            data: { service: serviceName, tool: toolNameRequested, suggestions: verdict.suggestions || [] }
          }
        });
      }
    }

    // Call upstream MCP via JSON-RPC /mcp with the *remote* tool name
    const { json } = await postJsonRpc(baseUrl, "tools/call", {
      name: match.remoteName,
      arguments: args || {},
    });

    // Pass through result or error
    if (json?.error) {
      return res.status(400).json({ jsonrpc: "2.0", id, error: json.error });
    }
    return res.json({ jsonrpc: "2.0", id, result: json?.result });
  } catch (e: any) {
    return res.status(500).json({
      jsonrpc: "2.0", id,
      error: { code: -32000, message: e?.message ?? "Server error" },
    });
  }
});

const PORT = Number(process.env.PORT || 8700);
app.listen(PORT, () => {
  console.log(`[router] listening on :${PORT}`);
  console.log(`[router] services:`, services);
});
