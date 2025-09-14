// servers/mission-mcp/src/index.ts
import http from "node:http";
import { URL } from "node:url";
import { composeTools } from "./compose.js"; // see next snippet

type Bind = { host: string; port: number; path: string };

function parseBind(def: Bind, inputHost?: string, inputPort?: string, inputUrl?: string): Bind {
  if (inputUrl) {
    try {
      const u = new URL(inputUrl);
      return { host: u.hostname || def.host, port: Number(u.port || def.port), path: u.pathname || def.path };
    } catch {}
  }
  if (inputHost) {
    if (inputHost.includes("://")) {
      try {
        const u = new URL(inputHost);
        return { host: u.hostname || def.host, port: Number(u.port || inputPort || def.port), path: def.path };
      } catch {}
    }
    const m = inputHost.match(/^([^:]+)(?::(\d+))?$/);
    if (m) return { host: m[1], port: Number(m[2] || inputPort || def.port), path: def.path };
  }
  if (inputPort) {
    const p = Number(inputPort);
    if (Number.isFinite(p)) return { host: def.host, port: p, path: def.path };
  }
  return def;
}

async function main() {
  const DEF: Bind = { host: "127.0.0.1", port: 8731, path: "/rpc" };

  // Env knobs (all optional)
  const MISSION_URL  = process.env.MISSION_URL;   // e.g. http://127.0.0.1:8731/rpc
  const MISSION_HOST = process.env.MISSION_HOST;  // e.g. 127.0.0.1 or 127.0.0.1:8731
  const MISSION_PORT = process.env.MISSION_PORT;  // e.g. 8731
  const MISSION_PATH = process.env.MISSION_PATH;  // e.g. /rpc

  const bind = parseBind(DEF, MISSION_HOST, MISSION_PORT, MISSION_URL);
  if (MISSION_PATH) bind.path = MISSION_PATH;

  const tools = await composeTools();

  const rpc = {
    async handle(payload: any) {
      const { jsonrpc, id, method, params } = payload;
      if (jsonrpc !== "2.0") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };

      switch (method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: { list: {}, call: {} } },
              serverInfo: { name: "mission-mcp", version: "1.0.0" }
            }
          };
        case "tools.list":
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }
          };
        case "tools.call":
          try {
            const tool = tools.find(t => t.name === params?.name);
            if (!tool) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool ${params?.name}` } };
            const result = await tool.handler(params?.arguments || {});
            return { jsonrpc: "2.0", id, result: { content: result?.content ?? [] } };
          } catch (e: any) {
            return { jsonrpc: "2.0", id, error: { code: -32000, message: e?.message || "Tool execution failed" } };
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
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
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
    console.error("[mission-mcp] server error:", err);
    process.exit(1);
  });

  server.listen(bind.port, bind.host, () => {
    console.log(`Mission RPC: http://${bind.host}:${bind.port}${bind.path}`);
    console.log(`Tools: ${tools.map(t => t.name).join(", ")}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});