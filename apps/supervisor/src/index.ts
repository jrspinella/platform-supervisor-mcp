import 'dotenv/config';
import fetch from 'node-fetch';
import pino from 'pino';
import { z } from 'zod';
import readline from 'node:readline';
import { bold, cyan, gray, green, magenta, red, yellow } from 'kleur/colors';
import { chat, configuredFromEnv } from './lib/aoai.js';

const log = pino({ name: 'supervisor' });

function normalizeRpcUrl(u: string, def: string): string {
  const url = (u || def).replace(/\/$/, '');
  return url.endsWith('/rpc') ? url : `${url}/rpc`;
}

const ROUTER_RPC = normalizeRpcUrl(process.env.ROUTER_RPC || '', 'http://127.0.0.1:8700/rpc');
const PLATFORM_RPC = normalizeRpcUrl(process.env.PLATFORM_RPC || '', 'http://127.0.0.1:8721/rpc');
const CONFIRM_APPLY = String(process.env.CONFIRM_APPLY || 'true').toLowerCase() !== 'false';

// ── JSON-RPC helpers ──────────────────────────────────────────
async function rpc(url: string, method: string, params?: any) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  const raw = await res.text();
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`RPC ${url} returned non-JSON (first 120 chars): ${raw.slice(0, 120)}`);
  }
  if (data?.error) throw new Error(`${method} → ${data.error.message}`);
  return data?.result;
}

// ── Router schema (loose) ─────────────────────────────────────
const RouteSchema = z.object({
  tool: z.string(),
  args: z.record(z.any()).default({}),
  rationale: z.string().optional(),
  confirmations: z.array(z.string()).optional(),
});

// ── CLI utils ─────────────────────────────────────────────────
function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

function printResult(result: any) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  for (const b of blocks) {
    if (b.type === 'text') {
      process.stdout.write(`\n${magenta('— text —')}\n${b.text}\n`);
    } else if (b.type === 'json') {
      process.stdout.write(`\n${cyan('— json —')}\n${JSON.stringify(b.json, null, 2)}\n`);
    }
  }
  if (result?.isError) process.stdout.write(`\n${red('✖ error')}\n`);
}

// ── Fallback NL → tool using AOAI locally (if router is down) ─
const nlSystem = [
  'You are a supervisor agent for a Platform Engineering MCP. Given an instruction and a tool catalog,',
  'choose the single best tool and args. If required args are missing, return a list of clarifying questions.',
  'Output strict JSON with shape {tool, args, questions?: string[], rationale?: string}.',
].join('\n');

async function planWithAoai(instruction: string, catalog: Array<{ name: string; description: string }>) {
  const cfg = configuredFromEnv();
  if (!cfg) throw new Error('AOAI not configured and router unavailable. Set AZURE_OPENAI_* or start router-mcp.');
  const user = JSON.stringify({ instruction, catalog }, null, 2);
  const out = await chat(cfg, [ { role: 'system', content: nlSystem }, { role: 'user', content: user } ], { max_tokens: 500 });
  try { return JSON.parse(out); } catch { throw new Error('planner returned non-JSON'); }
}

// Minimal heuristic fallback if both Router and AOAI planners fail
function naiveLocalPlan(text: string): { tool: string; args: Record<string, any>; rationale: string } | null {
  const s = text.trim();
  // create resource group rg-name in <region>
  const m1 = /create\s+(?:a\s+)?resource\s+group\s+([A-Za-z0-9_-]+)/i.exec(s);
  const m1loc = /in\s+(?:region\s+)?([A-Za-z0-9-]+)/i.exec(s);
  if (m1) {
    return { tool: 'platform.create_resource_group', args: { name: m1[1], location: m1loc?.[1] || 'eastus' }, rationale: 'heuristic: create_resource_group' };
  }
  return null;
}

// ── Discover tools from platform (for AOAI fallback display) ─
async function listPlatformTools() {
  const r = await rpc(PLATFORM_RPC, 'tools.list', {});
  return (r || []).map((t: any) => ({ name: t.name, description: t.description }));
}

// ── Main REPL ─────────────────────────────────────────────────
async function main() {
  const initial = process.argv.slice(2).join(' ').trim();
  process.stdout.write(gray(`Router RPC: ${ROUTER_RPC}\nPlatform RPC: ${PLATFORM_RPC}\n`));

  let instruction = initial || (await prompt(bold('> What do you want to do? ')));
  while (instruction) {
    try {
      // 1) Attempt router → plan
      let plan: z.infer<typeof RouteSchema> | null = null;
      try {
        const routed = await rpc(ROUTER_RPC, 'nl.route', { instruction, text: instruction });
        plan = RouteSchema.parse(routed);
        process.stdout.write(`\n${green('→ Routed to')} ${bold(plan.tool)}${plan.rationale ? ` — ${plan.rationale}` : ''}\n`);
      } catch (e: any) {
        log.warn({ err: e?.message }, 'router route failed; trying AOAI fallback');
        const catalog = await listPlatformTools();
        try {
          const p = await planWithAoai(instruction, catalog);
          plan = RouteSchema.parse({ tool: p.tool, args: p.args || {}, rationale: p.rationale, confirmations: p.questions });
          process.stdout.write(`\n${yellow('→ Planned via AOAI')} ${bold(plan.tool)}${plan.rationale ? ` — ${plan.rationale}` : ''}\n`);
        } catch (e2: any) {
          const naive = naiveLocalPlan(instruction);
          if (naive) {
            plan = RouteSchema.parse({ tool: naive.tool, args: naive.args, rationale: naive.rationale });
            process.stdout.write(`\n${yellow('→ Heuristic plan')} ${bold(plan.tool)} — ${plan.rationale}\n`);
          } else {
            throw e2;
          }
        }
      }

      // 2) Ask any clarifying questions returned
      if (plan.confirmations && plan.confirmations.length) {
        process.stdout.write(gray('\nMissing info:'));
        for (const q of plan.confirmations) {
          const a = await prompt(`  - ${q} `);
          const m = /^([a-zA-Z0-9_\.\-]+)\s*[:=]/.exec(q);
          if (m) (plan.args as any)[m[1]] = a; else (plan.args as any)[q] = a;
        }
      }

      process.stdout.write(`\n${bold('Args:')} ${gray(JSON.stringify(plan.args))}\n`);

      // 3) Confirm
      if (CONFIRM_APPLY) {
        const ans = (await prompt(bold('\nProceed? (y/N) '))).trim().toLowerCase();
        if (ans !== 'y' && ans !== 'yes') {
          instruction = await prompt(bold('\n> Next instruction? '));
          continue;
        }
      }

      // 4) Execute via platform-mcp
      const result = await rpc(PLATFORM_RPC, 'tools.call', { name: plan.tool, args: plan.args });
      printResult(result);

      // 5) Loop
      instruction = await prompt(bold('\n> Next instruction? '));
    } catch (e: any) {
      process.stdout.write(`\n${red('✖ ' + (e?.message || String(e)))}\n`);
      instruction = await prompt(bold('\n> Try another instruction? '));
    }
  }
  process.stdout.write(gray('\nbye.\n'));
}

main().catch(e => { log.error(e, 'fatal'); process.exit(1); });
