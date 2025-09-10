// servers/platform-mcp/src/index.ts
import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import bodyParser from "body-parser";
import { type ToolDef } from "mcp-http";
import { zodToJsonSchema } from "zod-to-json-schema";

import { allTools } from "./compose.js";

const PORT = Number(process.env.PORT || 8721);

// Index tools for quick lookup
const toolMap = new Map<string, ToolDef>(allTools.map(t => [t.name, t]));

// ──────────────────────────────────────────────────────────────────────────────
// Small server exposing /rpc, /tools/list, /tools/call, /healthz
// ──────────────────────────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

function toJsonSchema(inputSchema: any) {
  // If it's a Zod schema (has safeParse), convert it.
  if (inputSchema && typeof inputSchema.safeParse === "function") {
    try {
      // keep it simple; you can pass options if you want OpenAPI targets, etc.
      return zodToJsonSchema(inputSchema);
    } catch {
      return {}; // fallback
    }
  }
  // Otherwise it’s already JSON-schema-ish
  return inputSchema || {};
}

function listTools() {
  return allTools.map(t => ({
    name: t.name,
    description: t.description ?? "",
    schema: toJsonSchema(t.inputSchema)
  }));
}

async function callTool(name: string, args: any) {
  const def = toolMap.get(name);
  if (!def) {
    // Return the same shape as a normal tool handler
    return {
      content: [
        { type: "json", json: { status: "error", error: { message: `Unknown tool: ${name}` } } },
        { type: "text", text: `Unknown tool: ${name}` }
      ],
      isError: true
    };
  }
  return await def.handler(args);
}

// JSON-RPC (/rpc) with tools.list & tools.call
app.post("/rpc", async (req: Request, res: Response) => {
  const { id, method, params } = req.body || {};
  try {
    if (method === "tools.list") {
      return res.json({ jsonrpc: "2.0", id, result: listTools() });
    }
    if (method === "tools.call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const result = await callTool(name, args);
      return res.json({ jsonrpc: "2.0", id, result });
    }
    if (method === "health.ping") {
      return res.json({ jsonrpc: "2.0", id, result: { ok: true } });
    }
    return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  } catch (e: any) {
    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: e?.message || "Unhandled error" }
    });
  }
});

// REST convenience (supervisor/router fallbacks)
app.post("/tools/list", (_req, res) => {
  res.json({ tools: listTools() });
});
app.post("/tools/call", async (req, res) => {
  const { name, arguments: args } = req.body || {};
  const result = await callTool(name, args ?? {});
  res.json(result);
});

// Liveness
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// (Optional) No-op /mcp so curl mistakes don’t 404
app.post("/mcp", (_req, res) => {
  res.json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32601, message: "Use /rpc (tools.list/tools.call) or /tools/*" }
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`[platform-mcp] listening on http://127.0.0.1:${PORT}`);
  console.log(`[platform-mcp] endpoints: /rpc, /tools/list, /tools/call, /healthz`);
});