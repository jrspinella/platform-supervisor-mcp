import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';
import { z } from 'zod';
import pino from 'pino';
import fetch from 'node-fetch';
import { chat, configuredFromEnv } from './lib/aoai.js';

const log = pino({ name: 'router-mcp' });
const PORT = Number(process.env.PORT || 8700);

function normalizeRpcUrl(u: string, def: string): string {
  const url = (u || def).replace(/\/$/, '');
  return url.endsWith('/rpc') ? url : `${url}/rpc`;
}
const PLATFORM_RPC = normalizeRpcUrl(process.env.PLATFORM_RPC || '', 'http://127.0.0.1:8721/rpc');

// ── JSON-RPC helpers ──────────────────────────────────────────
async function rpc(url: string, method: string, params?: any) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  const raw = await res.text();
  try { return JSON.parse(raw).result; } catch { throw new Error(`RPC ${url} non-JSON: ${raw.slice(0,120)}`); }
}

// ── Catalog cache ─────────────────────────────────────────────
let catalog: Array<{ name: string; description?: string; inputSchema?: any }> = [];
async function refreshCatalog() {
  const res = await rpc(PLATFORM_RPC, 'tools.list', {});
  catalog = (res || []).map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  log.info({ count: catalog.length }, 'catalog refreshed');
}

function requiredArgsFor(toolName: string): string[] {
  const t = catalog.find(c => c.name === toolName);
  const schema = t?.inputSchema;
  // Accept JSON Schema or zod-ish dumps; best-effort: look for `required` array
  if (schema && Array.isArray(schema.required)) return schema.required as string[];
  return [];
}

// ── Planner (AOAI) ───────────────────────────────────────────
const nlSystem = [
  'You are a routing agent for a Platform Engineering MCP. Given an instruction and a list of tools,',
  'choose the single best tool and arguments. If any required args are missing, include questions.',
  'Return STRICT JSON: { tool: string, args: object, questions?: string[], rationale?: string }.',
  'Prefer tools with the prefix platform.* (aliases exist for azure.* and github.*).'
].join('\n');

async function planWithAoai(instruction: string) {
  const cfg = configuredFromEnv();
  if (!cfg) throw new Error('Azure OpenAI not configured.');
  const summaryCatalog = catalog.map(c => ({ name: c.name, description: c.description })).slice(0, 400);
  const user = JSON.stringify({ instruction, catalog: summaryCatalog }, null, 2);
  const out = await chat(cfg, [ { role: 'system', content: nlSystem }, { role: 'user', content: user } ], { max_tokens: 600 });
  try { return JSON.parse(out); } catch { throw new Error('planner returned non-JSON'); }
}

function naiveLocalPlan(text: string): { tool: string; args: any; rationale: string } | null {
  const s = text.trim();
  const m1 = /create\s+(?:a\s+)?resource\s+group\s+([A-Za-z0-9_-]+)/i.exec(s);
  const m1loc = /in\s+(?:region\s+)?([A-Za-z0-9-]+)/i.exec(s);
  if (m1) return { tool: 'platform.create_resource_group', args: { name: m1[1], location: m1loc?.[1] || 'eastus' }, rationale: 'heuristic: create_resource_group' };
  const m2 = /scan\s+(?:an?\s+)?app\s*service\s*plan\s+([A-Za-z0-9_-]+)\s+in\s+([A-Za-z0-9_-]+)/i.exec(s);
  if (m2) return { tool: 'platform.scan_appplan_baseline', args: { name: m2[1], resourceGroupName: m2[2] }, rationale: 'heuristic: scan_appplan_baseline' };
  const m3 = /scan\s+(?:a\s+)?web\s*app\s+([A-Za-z0-9_-]+)\s+in\s+([A-Za-z0-9_-]+)/i.exec(s);
  if (m3) return { tool: 'platform.scan_webapp_baseline', args: { name: m3[1], resourceGroupName: m3[2] }, rationale: 'heuristic: scan_webapp_baseline' };
  return null;
}

// ── Router method ─────────────────────────────────────────────
const RouteSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.any()).default({}),
  rationale: z.string().optional(),
  questions: z.array(z.string()).optional(),
});

async function handleRoute(params: any) {
  const instruction = String(params?.instruction || params?.text || '').trim();
  if (!instruction) throw new Error('Missing params.instruction (string)');
  if (catalog.length === 0) await refreshCatalog();

  let plan: z.infer<typeof RouteSchema> | null = null;

  try {
    const p = await planWithAoai(instruction);
    plan = RouteSchema.parse({ tool: p.tool, args: p.args || {}, rationale: p.rationale, questions: p.questions });
  } catch (e: any) {
    const naive = naiveLocalPlan(instruction);
    if (!naive) throw e;
    plan = RouteSchema.parse(naive);
  }

  // Add confirmations if required args are missing
  const required = requiredArgsFor(plan.tool);
  const missing = required.filter(k => !(k in (plan!.args || {})));
  const confirmations = (plan.questions || []).concat(missing.map(k => `${k}: ?`));

  return { tool: plan.tool, args: plan.args, rationale: plan.rationale, confirmations: confirmations.length ? confirmations : undefined };
}

// ── HTTP server (JSON-RPC + basic GETs) ──────────────────────
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('ok');
    }
    if (req.method === 'GET' && url.pathname === '/catalog') {
      if (catalog.length === 0) await refreshCatalog();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ count: catalog.length, catalog }));
    }

    if (req.method === 'POST' && url.pathname === '/rpc') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      let payload: any;
      try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end(JSON.stringify({ error: { message: 'invalid JSON' } })); }

      const { method, params, id } = payload || {};
      try {
        if (method === 'nl.route') {
          const result = await handleRoute(params);
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
        }
        if (method === 'refresh-catalog') {
          await refreshCatalog();
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true, count: catalog.length } }));
        }
        if (method === 'nl.tools') {
          if (catalog.length === 0) await refreshCatalog();
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: catalog }));
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
      } catch (e: any) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: e?.message || String(e) } }));
      }
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  } catch (e: any) {
    log.error(e, 'unhandled');
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('error');
  }
});

server.listen(PORT, () => log.info({ PORT, PLATFORM_RPC }, 'router-mcp listening'));
