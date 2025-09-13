export type ToolRoute = { tool: string; args: any; rationale?: string };
export type ToolBlock = { type: "json" | "text"; json?: any; text?: string };
export type ToolResult = { content?: ToolBlock[]; isError?: boolean };
export type ToolDef = { name: string; description?: string; inputSchema?: any };

const LS_KEY = "supervisor-chat:endpoints";

let endpoints = loadEndpoints();

function loadEndpoints() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    return {
      router: saved?.router || (import.meta.env.VITE_ROUTER_RPC ?? "/router"),
      platform: saved?.platform || (import.meta.env.VITE_PLATFORM_RPC ?? "/platform")
    };
  } catch {
    return {
      router: import.meta.env.VITE_ROUTER_RPC ?? "/router",
      platform: import.meta.env.VITE_PLATFORM_RPC ?? "/platform"
    };
  }
}

export function getEndpoints() {
  return { ...endpoints };
}

export function setEndpoints(next: { router?: string; platform?: string }) {
  endpoints = { ...endpoints, ...next };
  localStorage.setItem(LS_KEY, JSON.stringify(endpoints));
}

async function postJson(url: string, body: any) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return json;
}

export async function routeInstruction(instruction: string): Promise<ToolRoute> {
  const body = { jsonrpc: "2.0", id: Date.now(), method: "nl.route", params: { instruction } };
  const r = await postJson(endpoints.router, body);
  const res = r?.result;
  if (!res?.tool) throw new Error("Router did not return a tool.");
  return { tool: res.tool, args: res.args ?? {}, rationale: res.rationale };
}

export async function callTool(name: string, args: any): Promise<ToolResult> {
  const body = { jsonrpc: "2.0", id: Date.now(), method: "tools.call", params: { name, arguments: args } };
  const r = await postJson(endpoints.platform, body);
  return r?.result ?? {};
}

export async function listTools(): Promise<ToolDef[]> {
  const body = { jsonrpc: "2.0", id: Date.now(), method: "tools.list", params: {} };
  const r = await postJson(endpoints.platform, body);
  return (r?.result ?? []) as ToolDef[];
}