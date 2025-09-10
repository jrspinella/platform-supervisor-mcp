export function aggregateError(attempts: Array<{ url: string; status?: number; error?: any }>) {
  const lines = attempts.map(a => `- ${a.url} => status:${a.status ?? "n/a"} error:${a.error ? String(a.error) : "n/a"}`);
  return new Error(`Router call failed. Tried endpoints:\n${lines.join("\n")}`);
}

const ROUTER_BASE = (process.env.ROUTER_URL || "http://127.0.0.1:8700").replace(/\/+$/, "");

async function postJson(url: string, body: any) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = text; }
  return { ok: res.ok, status: res.status, body: json };
}

export async function callRouterTool(name: string, args: any) {
  const payload = { jsonrpc: "2.0", id: Date.now(), method: "tools.call", params: { name, arguments: args } };
  const tries = [`${ROUTER_BASE}/rpc`, `${ROUTER_BASE}/tools/call`];
  const attempts: any[] = [];
  for (const url of tries) {
    try {
      const r = await postJson(url, payload.method === "tools.call" && url.endsWith("/tools/call") ? payload.params : payload);
      if (r.ok) return r.body;
      attempts.push({ url, status: r.status, error: r.body?.error || r.body });
    } catch (e: any) {
      attempts.push({ url, error: e?.message || String(e) });
    }
  }
  throw aggregateError(attempts);
}

export async function routerNlRoute(prompt: string) {
  const payload = { jsonrpc: "2.0", id: Date.now(), method: "nl.route", params: { prompt } };
  const url = `${ROUTER_BASE}/rpc`;
  const r = await postJson(url, payload);
  if (!r.ok) {
    throw new Error(`Router nl.route failed HTTP ${r.status}: ${typeof r.body === "string" ? r.body : JSON.stringify(r.body)}`);
  }
  const result = r.body?.result ?? r.body;
  // Accept BOTH shapes:
  // 1) Plain { tool, args, rationale? }
  // 2) MCP content-wrapped: { content:[{type:"json", json:{tool,args}}] }
  if (result?.tool) return result;
  const contentJson = result?.content?.find?.((c: any) => c?.type === "json")?.json;
  if (contentJson?.tool) return contentJson;
  throw new Error(`Could not determine a tool from the router. Got: ${JSON.stringify(result)}`);
}