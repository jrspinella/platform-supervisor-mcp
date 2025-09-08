import crypto from "node:crypto";

export const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";

export const mcpJson = (json: any) => [{ type: "json" as const, json }];
export const mcpText = (text: string) => [{ type: "text" as const, text }];

export async function callRouterTool(name: string, args: any) {
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args || {} })
  });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: r.ok, status: r.status, headers: r.headers, body };
}

export function firstJson(body: any) {
  const content = body?.result?.content;
  if (Array.isArray(content)) {
    const b = content.find((c: any) => c.json);
    return b?.json ?? null;
  }
  return null;
}

export function isSucceeded(obj: any): boolean {
  const ps = obj?.properties?.provisioningState || obj?.provisioningState;
  return typeof ps === "string" ? ps.toLowerCase() === "succeeded" : true;
}

// permissive "tags" coercion: accept {k:v}, or "k=v,k2=v2", or a bare note string
export function coerceTags(input: unknown): Record<string, string> | undefined {
  if (!input) return undefined;
  if (typeof input === "object" && !Array.isArray(input)) return input as Record<string, string>;
  if (typeof input === "string") {
    const s = input.trim();
    if (!s) return undefined;
    if (!s.includes("=")) return { note: s };
    const obj: Record<string, string> = {};
    s.split(/[;,]\s*/).forEach(pair => {
      const [k, ...rest] = pair.split("=");
      if (k && rest.length) obj[k.trim()] = rest.join("=").trim();
    });
    return Object.keys(obj).length ? obj : undefined;
  }
  return undefined;
}

export function idemKey(tool: string, payload: any) {
  return crypto.createHash("sha256")
    .update(tool)
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 32);
}

// best-effort post-create verification
export async function tryAutoVerify(routerTool: string, payload: any, resultJson: any) {
  // Azure: generic by id
  if (routerTool.startsWith("azure.") && resultJson?.id) {
    const vr = await callRouterTool("azure.get_resource_by_id", { id: resultJson.id });
    const vj = firstJson(vr.body);
    return { ok: !!vj, details: vj ?? vr.body };
  }
  // GitHub: read back the repo
  if (routerTool.startsWith("github.")) {
    const owner = payload.owner || payload.org;
    const repo  = payload.name  || payload.repo;
    if (owner && repo) {
      const vr = await callRouterTool("github.get_repo", { owner, repo });
      const vj = firstJson(vr.body);
      return { ok: !!vj, details: vj ?? vr.body };
    }
  }
  return { ok: true };
}

// simple indentation for message formatting
export function indent(s: string, n = 2) {
  const pad = " ".repeat(n);
  return s.split("\n").map(l => pad + l).join("\n");
}