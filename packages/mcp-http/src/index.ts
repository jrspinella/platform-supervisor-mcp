// packages/mcp-http/src/index.ts
import _express from "express";

// Robust default resolution for both ESM and CJS builds
const express = (typeof _express === "function" ? _express : (_express as any).default) as unknown as typeof _express;

// Re-export types
export type { ToolDef } from './types';

// (optional) types for your server starter
export interface StartOptions {
  name?: string;
  version?: string;
  port?: number;
  path?: string; // e.g., "/mcp"
  logger?: (line: string) => void;
  tools?: import('./types').ToolDef[];
  // add whatever you already expose (tool registry, etc.)
}

export async function startMcpHttpServer(opts: StartOptions = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8720);
  const path = opts.path ?? "/mcp";
  const log = opts.logger ?? ((s) => console.log(`[mcp-http] ${s}`));

  const app = express();
  app.use(express.json());

  // Health
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // MCP JSON-RPC endpoint
  app.post(path, async (req, res) => {
    try {
      const { jsonrpc, id, method, params } = req.body;
      if (jsonrpc !== "2.0") {
        return res.status(400).json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
      }

      switch (method) {
        case "initialize":
          return res.json({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: { list: {}, call: {} }
              },
              serverInfo: {
                name: opts.name ?? "mcp-http-server",
                version: opts.version ?? "1.0.0"
              }
            }
          });

        case "tools/list":
          const tools = opts.tools?.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          })) ?? [];
          return res.json({
            jsonrpc: "2.0",
            id,
            result: { tools }
          });

        case "tools/call":
          const tool = opts.tools?.find(t => t.name === params.name);
          if (!tool) {
            return res.status(404).json({
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: "Method not found" }
            });
          }
          try {
            const result = await tool.handler(params.arguments || {});
            return res.json({
              jsonrpc: "2.0",
              id,
              result: { content: result.content }
            });
          } catch (e: any) {
            return res.json({
              jsonrpc: "2.0",
              id,
              error: { code: -32000, message: e.message || "Tool execution failed" }
            });
          }

        default:
          return res.status(404).json({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found" }
          });
      }
    } catch (e: any) {
      log(`POST ${path} error: ${e?.stack || e}`);
      res.status(500).json({ error: String(e?.message || e) });
    }
  });

  // Optional: Return 200 (empty SSE stub) so legacy SSE fallback doesn’t crash
  app.get(path, (_req, res) => {
    // Some clients try GET /mcp as a legacy SSE path; respond gently.
    res
      .status(200)
      .type("text/plain")
      .send("MCP endpoint expects POST JSON-RPC. SSE not enabled.\n");
  });

  app.listen(port, () => log(`listening on :${port} (path ${path})`));
}
