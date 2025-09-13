// servers/platform-mcp/src/index.ts
import http from "node:http";
import { URL } from "node:url";
import { composeTools } from "./compose.js";

type Bind = { host: string; port: number; path: string };

function parseBind(def: Bind, inputHost?: string, inputPort?: string, inputUrl?: string): Bind {
  // Highest precedence: full URL (e.g., http://127.0.0.1:8721/rpc)
  if (inputUrl) {
    try {
      const u = new URL(inputUrl);
      return {
        host: u.hostname || def.host,
        port: Number(u.port || def.port),
        path: u.pathname || def.path,
      };
    } catch { /* fallthrough */ }
  }

  // Next: HOST that might be "host:port" or bare host (never include scheme)
  if (inputHost) {
    // Reject accidental "http://"
    if (inputHost.includes("://")) {
      try {
        const u = new URL(inputHost);
        return {
          host: u.hostname || def.host,
          port: Number(u.port || inputPort || def.port),
          path: def.path,
        };
      } catch { /* fallthrough */ }
    }
    const m = inputHost.match(/^([^:]+)(?::(\d+))?$/);
    if (m) {
      return {
        host: m[1],
        port: Number(m[2] || inputPort || def.port),
        path: def.path,
      };
    }
  }

  // Fallback: explicit PORT env
  if (inputPort) {
    const p = Number(inputPort);
    if (Number.isFinite(p)) return { host: def.host, port: p, path: def.path };
  }

  return def;
}

async function main() {
  // Defaults
  const DEF: Bind = { host: "127.0.0.1", port: 8721, path: "/rpc" };

  // Env knobs (all optional)
  const PLATFORM_URL   = process.env.PLATFORM_URL;         // e.g. http://127.0.0.1:8721/rpc
  const PLATFORM_HOST  = process.env.PLATFORM_HOST;        // e.g. 127.0.0.1 or 127.0.0.1:8721
  const PLATFORM_PORT  = process.env.PLATFORM_PORT;        // e.g. 8721
  const PLATFORM_PATH  = process.env.PLATFORM_PATH;        // e.g. /rpc

  const bind = parseBind(DEF, PLATFORM_HOST, PLATFORM_PORT, PLATFORM_URL);
  if (PLATFORM_PATH) bind.path = PLATFORM_PATH;

  // Compose tools
  const tools = await composeTools();

  // Minimal JSON-RPC handler
  const rpc = {
    handle: async (payload: any) => {
      const { jsonrpc, id, method, params } = payload;
      if (jsonrpc !== "2.0") {
        return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
      }

      switch (method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: { list: {}, call: {} } },
              serverInfo: { name: "platform-mcp", version: "1.0.0" }
            }
          };
        case "tools.list":
          const toolList = tools.map(t => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }));
          return { jsonrpc: "2.0", id, result: { tools: toolList } };
        case "tools.call":
          const tool = tools.find(t => t.name === params.name);
          if (!tool) {
            return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
          }
          try {
            const result = await tool.handler(params.arguments || {});
            return { jsonrpc: "2.0", id, result: { content: result.content } };
          } catch (e: any) {
            return { jsonrpc: "2.0", id, error: { code: -32000, message: e.message || "Tool execution failed" } };
          }
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
      }
    }
  };

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url && req.url.startsWith(bind.path)) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const result = await rpc.handle(payload);
          const json = JSON.stringify(result);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(json);
        } catch (e: any) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: e?.message || "Bad Request" }, id: null }));
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not Found");
  });

  server.on("error", (err) => {
    console.error("[platform-mcp] server error:", err);
    process.exit(1);
  });

  server.listen(bind.port, bind.host, () => {
    const url = `http://${bind.host}:${bind.port}${bind.path}`;
    console.log(`Platform RPC: ${url}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
