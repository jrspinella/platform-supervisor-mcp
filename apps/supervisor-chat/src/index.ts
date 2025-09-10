import "dotenv/config";
import { startMcpHttpServer, type ToolDef } from "mcp-http";
import fetch from "node-fetch";

const NAME = process.env.MCP_NAME || "supervisor-chat";
const PORT = Number(process.env.PORT || 8720);
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";

async function postJSON(url: string, body: any) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, body: json };
}

function firstJson(body: any) {
  const content = body?.result?.content ?? body?.content;
  if (Array.isArray(content)) {
    const j = content.find((c: any) => c?.json !== undefined);
    return j?.json ?? null;
  }
  return null;
}

const tools: ToolDef[] = [
  {
    name: "supervisor.run",
    description: "Natural language command runner. If confirm=false, returns a plan; if confirm=true, executes.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        confirm: { type: "boolean", default: false }
      },
      required: ["prompt"]
    } as any,
    handler: async (a: { prompt: string; confirm?: boolean }) => {
      // Route
      const routed = await postJSON(`${ROUTER_URL}/a2a/nl/route`, { text: a.prompt });
      if (!routed.ok) return { content: [{ type: "text", text: `❌ route failed: ${JSON.stringify(routed.body).slice(0, 800)}` }], isError: true };

      const { tool, args } = routed.body;
      // Pre-call to get plan when confirm=false
      if (!a.confirm) {
        const pre = await postJSON(`${ROUTER_URL}/a2a/tools/call`, { name: tool, arguments: { ...args, confirm: false } });
        return pre.body;
      }

      // Execute (confirm=true)
      const exec = await postJSON(`${ROUTER_URL}/a2a/tools/call`, { name: tool, arguments: { ...args, confirm: true } });
      return exec.body;
    }
  },
];

console.log(`[${NAME}] starting on :${PORT}`);
console.log(`[${NAME}] Router: ${ROUTER_URL}`);

await startMcpHttpServer({ name: NAME, port: PORT, tools });