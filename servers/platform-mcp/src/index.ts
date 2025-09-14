// servers/platform-mcp/src/index.ts
import http from "node:http";
import { URL } from "node:url";
import { composeTools } from "./compose.js";
import type { ToolDef } from "mcp-http";

type Bind = { host: string; port: number; path: string };

function parseBind(def: Bind, inputHost?: string, inputPort?: string, inputUrl?: string): Bind {
  if (inputUrl) {
    try {
      const u = new URL(inputUrl);
      return { host: u.hostname || def.host, port: Number(u.port || def.port), path: u.pathname || def.path };
    } catch { /* fallthrough */ }
  }
  if (inputHost) {
    if (inputHost.includes("://")) {
      try {
        const u = new URL(inputHost);
        return { host: u.hostname || def.host, port: Number(u.port || inputPort || def.port), path: def.path };
      } catch { /* fallthrough */ }
    }
    const m = inputHost.match(/^([^:]+)(?::(\d+))?$/);
    if (m) return { host: m[1], port: Number(m[2] || inputPort || def.port), path: def.path };
  }
  if (inputPort && Number.isFinite(Number(inputPort))) {
    return { host: def.host, port: Number(inputPort), path: def.path };
  }
  return def;
}

function cors(res: http.ServerResponse) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
}

function normalizeMethod(m?: string) {
  // accept dot or slash; normalize to dot
  if (!m) return "";
  return m.replace("/", ".");
}

async function makeRpc(tools: ToolDef[]) {
  const toolIndex = new Map<string, ToolDef>();
  for (const t of tools) toolIndex.set(t.name, t);

  const listTools = () =>
    tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));

  async function handleOne(payload: any) {
    const { jsonrpc, id } = payload ?? {};
    const method = normalizeMethod(payload?.method);
    const params = payload?.params ?? {};

    if (jsonrpc !== "2.0") {
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
    }

    try {
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

        case "health":
          return { jsonrpc: "2.0", id, result: "ok" };

        case "tools.list":
          return { jsonrpc: "2.0", id, result: { tools: listTools() } };

        case "tools.call": {
          const name = params?.name;
          const args = params?.arguments ?? {};
          if (!name || typeof name !== "string") {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: "Invalid params: missing 'name'" } };
          }
          const tool = toolIndex.get(name);
          if (!tool) {
            return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${name}` } };
          }
          try {
            const out = await tool.handler(args);
            // Preserve content + isError + _meta for richer UIs
            return {
              jsonrpc: "2.0",
              id,
              result: {
                content: out?.content ?? [],
                isError: Boolean(out?.isError),
                _meta: out?._meta ?? undefined,
              },
            };
          } catch (e: any) {
            return { jsonrpc: "2.0", id, error: { code: -32000, message: e?.message || "Tool execution failed" } };
          }
        }

        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } };
      }
    } catch (e: any) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: e?.message || "Internal error" } };
    }
  }

  // Batch support
  async function handle(payload: any) {
    if (Array.isArray(payload)) {
      const out = await Promise.all(payload.map(p => handleOne(p)));
      return out;
    }
    return handleOne(payload);
  }

  return { handle };
}

async function main() {
  const DEF: Bind = { host: "127.0.0.1", port: 8721, path: "/rpc" };
  const PLATFORM_URL  = process.env.PLATFORM_URL;
  const PLATFORM_HOST = process.env.PLATFORM_HOST;
  const PLATFORM_PORT = process.env.PLATFORM_PORT;
  const PLATFORM_PATH = process.env.PLATFORM_PATH;

  const bind = parseBind(DEF, PLATFORM_HOST, PLATFORM_PORT, PLATFORM_URL);
  if (PLATFORM_PATH) bind.path = PLATFORM_PATH;

  const tools = await composeTools();
  const rpc = await makeRpc(tools);

  const server = http.createServer((req, res) => {
    // Simple health for GET and HEAD
    if (req.method !== "POST" && (req.url === "/healthz" || req.url === "/readyz")) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }

    // CORS preflight
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      return res.end();
    }

    // JSON-RPC endpoint (accept with/without trailing slash)
    const okPath = req.url && (req.url === bind.path || req.url === bind.path.replace(/\/+$/, ""));
    if (req.method === "POST" && okPath) {
      cors(res);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const result = await rpc.handle(payload);
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: e?.message || "Bad Request" } }));
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
    console.log(`Tools: ${tools.map(t => t.name).join(", ")}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});