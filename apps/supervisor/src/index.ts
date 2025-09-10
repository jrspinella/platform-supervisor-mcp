// apps/supervisor/src/index.ts
import "dotenv/config";
import fetch from "node-fetch";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROUTER_RPC = process.env.ROUTER_URL ?? "http://127.0.0.1:8700/rpc";      // only nl.route
const PLATFORM_RPC = process.env.PLATFORM_URL ?? "http://127.0.0.1:8721/rpc";  // tools.call

async function postJson(url: string, body: any) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, text, json };
}

// ————— Router (tool selection) —————
async function nlRoute(instruction: string) {
  const r = await postJson(ROUTER_RPC, {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "nl.route",
    params: { instruction },
  });
  if (!r.ok || r.json?.error) {
    const err = r.json?.error ?? { message: r.text };
    throw Object.assign(new Error("Router nl.route error"), err);
  }
  return r.json.result as { tool: string; args: any; rationale?: string };
}

// ————— Platform MCP (execution) —————
async function callPlatformTool(name: string, args: any) {
  const r = await postJson(PLATFORM_RPC, {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools.call",
    params: { name, arguments: args },
  });
  if (!r.ok || r.json?.error) {
    const err = r.json?.error ?? { message: r.text };
    throw Object.assign(new Error("Platform tools.call error"), err);
  }
  return r.json.result;
}

// ————— helpers —————
function firstJson(result: any) {
  const c = result?.content;
  if (Array.isArray(c)) return c.find((x: any) => x?.type === "json")?.json ?? null;
  return null;
}

function parseCli() {
  // Accept both:
  //  - tsx index.ts "--" "<instruction>" [--yes] [--debug]
  //  - tsx index.ts "<instruction>" [--yes] [--debug]
  const argv = process.argv.slice(2);
  const sepIdx = argv.indexOf("--");
  const tail = sepIdx >= 0 ? argv.slice(sepIdx + 1) : argv;

  let yes = false;
  let debug = false;

  const filtered = [];
  for (const a of tail) {
    if (a === "--yes" || a === "-y") { yes = true; continue; }
    if (a === "--debug") { debug = true; continue; }
    filtered.push(a);
  }

  // Join remaining parts into a single instruction (handles cases where shell split words)
  const instruction = filtered.join(" ").trim();

  return { instruction, yes, debug };
}

async function main() {
  const { instruction, yes, debug } = parseCli();

  if (!instruction) {
    console.log("[supervisor] Router RPC:", ROUTER_RPC);
    console.log('Usage: pnpm -C apps/supervisor dev -- "<instruction>" [--yes] [--debug]');
    process.exit(2);
  }

  if (debug) {
    console.log("[supervisor] Router RPC:", ROUTER_RPC);
    console.log("[supervisor] Platform RPC:", PLATFORM_RPC);
  } else {
    console.log("[supervisor] Router RPC:", ROUTER_RPC);
  }

  const routed = await nlRoute(instruction);
  console.log(`→ Routed to \`${routed.tool}\` — ${routed.rationale || ""}`);
  console.log(`→ Args: ${JSON.stringify(routed.args)}`);

  // Preview plan
  console.log([
    "",
    "### Plan",
    `- **Tool:** ${routed.tool}`,
    ...Object.entries(routed.args).map(([k, v]) => `- **${k}:** ${typeof v === "string" ? v : `\`${JSON.stringify(v)}\``}`),
    "",
    "Proceed? (y/N)",
  ].join("\n"));

  let proceed = yes;
  if (!yes) {
    const rl = readline.createInterface({ input, output });
    const answer = (await rl.question("> ")).trim().toLowerCase();
    rl.close();
    proceed = (answer === "y" || answer === "yes");
  }
  if (!proceed) {
    console.log("Aborted.");
    process.exit(0);
  }

  const execArgs = { ...routed.args, confirm: true };
  const result = await callPlatformTool(routed.tool, execArgs);

  const j = firstJson(result);
  if (j?.status === "error" || result?.isError) {
    console.error("❌ Confirmed call failed:", j?.error ?? j ?? result);
    process.exit(1);
  }

  console.log("✅ Done.");
}

main().catch((e) => {
  console.error("Platform Assistant: Uncaught error\n", e);
  process.exit(1);
});