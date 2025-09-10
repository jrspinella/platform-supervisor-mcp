export type McpContent =
  | { type: "text"; text: string }
  | { type: "json"; json: any };

export const mcpText = (text: string): McpContent[] => [{ type: "text", text }];
export const mcpJson  = (json: any): McpContent[] => [{ type: "json", json }];

export const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";

export function fmt(obj: any) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

export function firstJson(body: any): any | null {
  const content = body?.result?.content ?? body?.content;
  if (Array.isArray(content)) {
    const j = content.find((c: any) => c?.json !== undefined);
    return j?.json ?? null;
  }
  return null;
}

export function provisioningSucceeded(x: any): boolean {
  if (!x) return false;
  if (x?.status && String(x.status).toLowerCase() === "succeeded") return true;
  const ps = x?.properties?.provisioningState ?? x?.provisioningState;
  if (ps && /succeed/i.test(ps)) return true;
  if (x?.id && typeof x.id === "string") return true;
  if (x?.status === "done" && (x?.result || x?.resource)) return true;
  return false;
}

const META_KEYS = new Set([
  "confirm",
  "dryRun",
  "assumeYes",
  "assume_no",
  "prompt",
  "planOnly",
  "context",
]);

export function stripMeta(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripMeta);
  if (typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      if (META_KEYS.has(k)) continue;
      const vv = stripMeta(v);
      if (vv !== undefined) out[k] = vv;
    }
    return out;
  }
  return obj;
}

export function dropUndefined(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(dropUndefined);
  if (typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const vv = dropUndefined(v);
      if (vv !== undefined) out[k] = vv;
    }
    return out;
  }
  return obj;
}

export function pick(a: any, ...keys: string[]) {
  for (const k of keys) {
    if (a?.[k] !== undefined && a?.[k] !== null && a?.[k] !== "") return a[k];
  }
  return undefined;
}

export function asBool(v: any, dflt = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (["y", "yes", "true", "1", "on"].includes(t)) return true;
    if (["n", "no", "false", "0", "off"].includes(t)) return false;
  }
  if (typeof v === "number") return v !== 0;
  return dflt;
}

export function coerceTags(t: any): Record<string,string> | undefined {
  if (!t) return undefined;
  if (typeof t === "string") {
    try { return JSON.parse(t); } catch { return undefined; }
  }
  if (typeof t === "object") {
    const out: Record<string,string> = {};
    for (const [k, v] of Object.entries(t)) out[String(k)] = String(v);
    return out;
  }
  return undefined;
}

export async function callRouterTool(name: string, args: any) {
  const r = await fetch(`${ROUTER_URL}/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: stripMeta(dropUndefined(args)) }),
  });
  const text = await r.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: r.ok, status: r.status, body };
}

export function pendingPlanText(opts: {
  title: string;
  bullets: string[];
  followup?: string;
  askProceed?: boolean;
}) {
  const lines: string[] = [];
  lines.push(`### Plan`);
  if (opts.title) lines.push(`- **Action:** ${opts.title}`);
  for (const b of opts.bullets) lines.push(`- ${b}`);
  if (opts.followup) {
    lines.push("");
    lines.push(`To proceed, reply with:`);
    lines.push("```");
    lines.push(opts.followup);
    lines.push("```");
  }
  if (opts.askProceed) lines.push(`Proceed? (y/N)`);
  return lines.join("\n");
}
