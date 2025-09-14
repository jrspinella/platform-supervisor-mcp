// apps/supervisor/src/index.ts
/**
 * Supervisor CLI (interactive) — with "Fix now?" remediation flow
 * - Routes natural language via Router MCP (nl.route)
 * - Calls Platform MCP tools
 * - If a scan tool returns findings, offers to remediate:
 *    - web app:  platform.remediate_webapp_baseline
 *    - app plan: platform.remediate_appplan_baseline
 *    - RG / workload scans: lets you pick a Web App or App Plan to fix
 *
 * No external deps. Requires Node 18+ (global fetch + readline/promises).
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type Json = any;

const ROUTER_RPC = process.env.ROUTER_RPC || "http://127.0.0.1:8701/rpc";
const PLATFORM_RPC = process.env.PLATFORM_RPC || "http://127.0.0.1:8721/rpc";

const hr = () => console.log("".padEnd(80, "─"));

function printHeader() {
  console.log("Supervisor CLI — interactive mode");
  console.log(`Router:   ${ROUTER_RPC}`);
  console.log(`Platform: ${PLATFORM_RPC}`);
  console.log("\nTips: type an instruction (e.g., “create a web app…”)");
  console.log("      or use commands: /catalog, /policy, /reload, /route, /call, /quit\n");
}

async function jsonRpc(url: string, method: string, params: Record<string, any> = {}) {
  const body = { jsonrpc: "2.0", id: Date.now(), method, params };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    if (json.error) throw Object.assign(new Error(json.error?.message || "RPC Error"), { rpc: json });
    return json.result;
  } catch (e: any) {
    // Helpful when HTML comes back (e.g., wrong port)
    if (text?.startsWith("<!DOCTYPE")) {
      throw new Error(`Received HTML from ${url}. Are you pointing at the right RPC?`);
    }
    throw e;
  }
}

async function routerRoute(instruction: string) {
  console.log(`Router RPC: ${ROUTER_RPC}`);
  console.log(`Platform RPC: ${PLATFORM_RPC}`);
  return jsonRpc(ROUTER_RPC, "nl.route", { instruction });
}

async function platformCallTool(name: string, args: Record<string, any>) {
  return jsonRpc(PLATFORM_RPC, "tools.call", { name, arguments: args || {} });
}

async function platformList() {
  return jsonRpc(PLATFORM_RPC, "tools.list", {});
}

async function platformPolicyDump() {
  return jsonRpc(PLATFORM_RPC, "tools.call", { name: "platform.policy_dump", arguments: {} });
}

async function platformPolicyReload(dir?: string) {
  return jsonRpc(PLATFORM_RPC, "tools.call", {
    name: "platform.policy_reload",
    arguments: dir ? { dir } : {},
  });
}

// ──────────────────────────────────────────────────────────────
// Content helpers
// ──────────────────────────────────────────────────────────────
function firstJsonContent(result: any): any | null {
  const items: Array<{ type: string; json?: any; text?: string }> = result?.content || [];
  for (const c of items) if (c?.type === "json") return c.json;
  // Fallback: if the content itself is JSON
  if (result && typeof result === "object" && !Array.isArray(result) && "status" in result) return result;
  return null;
}

function allTextContent(result: any): string[] {
  const items: Array<{ type: string; text?: string }> = result?.content || [];
  return items.filter((c) => c?.type === "text" && c.text).map((c) => String(c.text));
}

function printToolResult(result: any) {
  const j = firstJsonContent(result);
  const ts = allTextContent(result);

  if (j) {
    console.log("┌─ JSON");
    console.log(JSON.stringify(j, null, 2));
    console.log("└────────");
  }
  if (ts?.length) {
    for (const t of ts) {
      console.log("┌─ TEXT");
      console.log(t);
      console.log("└────────");
    }
  }
  if (result?.isError) console.log("⛔ Error flag set on tool result");
}

// ──────────────────────────────────────────────────────────────
type Finding = {
  code: string;
  severity?: string;
  suggest?: string;
  controlIds?: string[];
  meta?: Record<string, any>;
};

function extractFindingsFromToolResult(result: any): Finding[] {
  const j = firstJsonContent(result);
  const findings = j?.findings;
  if (Array.isArray(findings)) return findings as Finding[];
  return [];
}

function summarizeFindings(findings: Finding[]) {
  const bySev = new Map<string, number>();
  for (const f of findings) {
    const s = (f.severity || "unknown").toLowerCase();
    bySev.set(s, (bySev.get(s) || 0) + 1);
  }
  const order = ["high", "medium", "low", "info", "unknown"];
  const parts = order
    .map((k) => `${k}: ${bySev.get(k) || 0}`)
    .concat(
      [...bySev.keys()].filter((k) => !order.includes(k)).map((k) => `${k}: ${bySev.get(k) || 0}`)
    );
  return `Findings: ${findings.length}  —  ${parts.join("  ·  ")}`;
}

function filterFindingsForWebApp(findings: Finding[], rg: string, name: string) {
  const n = String(name).toLowerCase();
  return findings.filter((f) => {
    const m = f.meta || {};
    const w = (m.webAppName || m.siteName || m.name || "").toString().toLowerCase();
    const rgOk = !m.resourceGroupName || String(m.resourceGroupName).toLowerCase() === String(rg).toLowerCase();
    const looksWeb = f.code?.startsWith("APP_") || m.kind === "webapp";
    return looksWeb && rgOk && (w ? w === n : true);
  });
}

function filterFindingsForPlan(findings: Finding[], rg: string, name: string) {
  const n = String(name).toLowerCase();
  return findings.filter((f) => {
    const m = f.meta || {};
    const p = (m.appServicePlanName || m.planName || m.name || "").toString().toLowerCase();
    const rgOk = !m.resourceGroupName || String(m.resourceGroupName).toLowerCase() === String(rg).toLowerCase();
    const looksPlan = f.code?.startsWith("APPPLAN_") || m.kind === "appplan";
    return looksPlan && rgOk && (p ? p === n : true);
  });
}

// For RG/workload scans: group webapps + plans for selection
function groupTargetableResources(findings: Finding[]) {
  const webapps = new Map<string, { rg: string; name: string }>();
  const plans = new Map<string, { rg: string; name: string }>();
  for (const f of findings) {
    const m = f.meta || {};
    if (f.code?.startsWith("APP_") || m.kind === "webapp" || m.webAppName || m.siteName) {
      const rg = String(m.resourceGroupName || "");
      const name = String(m.webAppName || m.siteName || m.name || "");
      if (rg && name) webapps.set(`${rg}/${name}`, { rg, name });
    }
    if (f.code?.startsWith("APPPLAN_") || m.kind === "appplan" || m.appServicePlanName) {
      const rg = String(m.resourceGroupName || "");
      const name = String(m.appServicePlanName || m.name || "");
      if (rg && name) plans.set(`${rg}/${name}`, { rg, name });
    }
  }
  return { webapps: [...webapps.values()], plans: [...plans.values()] };
}

// ──────────────────────────────────────────────────────────────
// Prompts
// ──────────────────────────────────────────────────────────────
async function yesNo(rl: any, prompt: string, defNo = true): Promise<boolean> {
  const ans = (await rl.question(`${prompt} ${defNo ? "[y/N]" : "[Y/n]"} `)).trim().toLowerCase();
  if (!ans) return !defNo;
  return ans === "y" || ans === "yes";
}

async function editJson(rl: any, initial: any): Promise<any> {
  console.log("Current args:");
  console.log(JSON.stringify(initial, null, 2));
  const edited = await rl.question("Paste new JSON (or press Enter to keep): ");
  if (!edited.trim()) return initial;
  try {
    return JSON.parse(edited);
  } catch (e: any) {
    console.log(`Invalid JSON: ${e?.message || e}`);
    return initial;
  }
}

async function chooseOne(rl: any, title: string, items: string[]): Promise<number> {
  if (!items.length) return -1;
  console.log(`\n${title}`);
  items.forEach((it, i) => console.log(`  ${i + 1}. ${it}`));
  for (;;) {
    const ans = (await rl.question(`Choose 1-${items.length} (or Enter to cancel): `)).trim();
    if (!ans) return -1;
    const idx = Number(ans);
    if (Number.isInteger(idx) && idx >= 1 && idx <= items.length) return idx - 1;
    console.log("Invalid choice.");
  }
}

// ──────────────────────────────────────────────────────────────
// Remediation flows
// ──────────────────────────────────────────────────────────────
async function remediateWebApp(rl: any, args: { resourceGroupName?: string; rg?: string; name?: string; webapp?: string }, findings: Finding[]) {
  const resourceGroupName = args.resourceGroupName || args.rg;
  const name = args.name || args.webapp;
  if (!resourceGroupName || !name) {
    console.log("Cannot remediate: missing resourceGroupName or name.");
    return;
  }
  const subset = filterFindingsForWebApp(findings, resourceGroupName, name);
  if (!subset.length) {
    console.log("No applicable Web App findings for this resource.");
    return;
  }

  // LAW workspace id if needed
  const needsDiag = subset.some((f) => f.code === "APP_DIAG_NO_LAW");
  let lawWorkspaceId: string | undefined = process.env.LAW_WORKSPACE_ID;
  if (needsDiag && !lawWorkspaceId) {
    const ans = await rl.question("Enter LAW workspace resource ID for diagnostics (or Enter to skip diag): ");
    lawWorkspaceId = ans.trim() || undefined;
  }

  const dryArgs = { resourceGroupName, name, findings: subset, dryRun: true as const, ...(lawWorkspaceId ? { lawWorkspaceId } : {}) };
  console.log("\n→ Planning remediation: platform.remediate_webapp_baseline");
  let res = await platformCallTool("platform.remediate_webapp_baseline", dryArgs);
  printToolResult(res);

  if (!(await yesNo(rl, "Apply fixes now?", true))) return;

  const applyArgs = { ...dryArgs, dryRun: false as const };
  console.log("\n→ Applying remediation: platform.remediate_webapp_baseline");
  res = await platformCallTool("platform.remediate_webapp_baseline", applyArgs);
  printToolResult(res);
}

async function remediateAppPlan(rl: any, args: { resourceGroupName?: string; rg?: string; name?: string; appServicePlanName?: string }, findings: Finding[]) {
  const resourceGroupName = args.resourceGroupName || args.rg;
  const name = args.name || args.appServicePlanName;
  if (!resourceGroupName || !name) {
    console.log("Cannot remediate: missing resourceGroupName or name.");
    return;
  }
  const subset = filterFindingsForPlan(findings, resourceGroupName, name);
  if (!subset.length) {
    console.log("No applicable App Service Plan findings for this resource.");
    return;
  }

  const targetSku = process.env.ASP_MIN_SKU || "P1v3";

  // LAW workspace id if needed
  const needsDiag = subset.some((f) => f.code === "APPPLAN_DIAG_NO_LAW");
  let lawWorkspaceId: string | undefined = process.env.LAW_WORKSPACE_ID;
  if (needsDiag && !lawWorkspaceId) {
    const ans = await rl.question("Enter LAW workspace resource ID for diagnostics (or Enter to skip diag): ");
    lawWorkspaceId = ans.trim() || undefined;
  }

  const dryArgs = {
    resourceGroupName,
    name,
    findings: subset,
    dryRun: true as const,
    targetSku,
    ...(lawWorkspaceId ? { lawWorkspaceId } : {}),
  };
  console.log("\n→ Planning remediation: platform.remediate_appplan_baseline");
  let res = await platformCallTool("platform.remediate_appplan_baseline", dryArgs);
  printToolResult(res);

  if (!(await yesNo(rl, "Apply fixes now?", true))) return;

  const applyArgs = { ...dryArgs, dryRun: false as const };
  console.log("\n→ Applying remediation: platform.remediate_appplan_baseline");
  res = await platformCallTool("platform.remediate_appplan_baseline", applyArgs);
  printToolResult(res);
}

// For RG/workload scans: let user pick a target to remediate
async function remediateFromAggregateScan(rl: any, findings: Finding[]) {
  const groups = groupTargetableResources(findings);
  const choices: string[] = [
    ...groups.webapps.map((w) => `Web App: ${w.rg}/${w.name}`),
    ...groups.plans.map((p) => `App Plan: ${p.rg}/${p.name}`),
  ];
  if (choices.length === 0) {
    console.log("No Web Apps or App Service Plans found in findings to remediate.");
    return;
  }
  const idx = await chooseOne(rl, "Select a resource to remediate:", choices);
  if (idx < 0) return;

  if (idx < groups.webapps.length) {
    const pick = groups.webapps[idx];
    await remediateWebApp(rl, { resourceGroupName: pick.rg, name: pick.name }, findings);
  } else {
    const pick = groups.plans[idx - groups.webapps.length];
    await remediateAppPlan(rl, { resourceGroupName: pick.rg, name: pick.name }, findings);
  }
}

// ──────────────────────────────────────────────────────────────
// Main loop
// ──────────────────────────────────────────────────────────────
async function main() {
  const rl = createInterface({ input, output });
  printHeader();

  // If an initial instruction was provided after `--`
  const initial = process.argv.slice(2).join(" ").replace(/^--\s*/, "").trim();
  let last = initial ? initial : "";

  for (;;) {
    const prompt = last ? `> ` : `> `;
    const line = last || (await rl.question(prompt));
    last = ""; // only use initial once

    const s = line.trim();
    if (!s) continue;

    // Commands
    if (s === "/quit" || s === "/exit") break;
    if (s === "/catalog") {
      const list = await platformList();
      const names = (list?.map?.((t: any) => t?.name) || []).filter(Boolean);
      console.log("\nTools:");
      console.log(names.sort().join("\n"));
      console.log("");
      continue;
    }
    if (s === "/policy") {
      const res = await platformPolicyDump();
      printToolResult(res);
      continue;
    }
    if (s.startsWith("/reload")) {
      const dir = s.split(/\s+/)[1];
      const res = await platformPolicyReload(dir);
      printToolResult(res);
      continue;
    }
    if (s.startsWith("/route ")) {
      const msg = s.slice(7).trim();
      const route = await routerRoute(msg);
      console.log(JSON.stringify(route, null, 2));
      continue;
    }
    if (s.startsWith("/call ")) {
      try {
        const payload = JSON.parse(s.slice(6));
        const res = await platformCallTool(payload.name, payload.arguments || {});
        printToolResult(res);
      } catch (e: any) {
        console.log("Usage: /call {\"name\":\"tool.name\",\"arguments\":{...}}");
        console.log(e?.message || String(e));
      }
      continue;
    }

    // Route
    const route = await routerRoute(s);
    const tool = route?.tool;
    const args = route?.args || {};
    const rationale = route?.rationale;

    console.log(`→ Routed to \`${tool}\` — ${rationale || "no rationale"}`);
    console.log("→ Args:", JSON.stringify(args, null, 2));

    const edit = await yesNo(rl, "Edit args before calling?", true);
    const finalArgs = edit ? await editJson(rl, args) : args;

    const proceed = await yesNo(rl, "Proceed?", false);
    if (!proceed) continue;

    // Call tool
    const result = await platformCallTool(tool, finalArgs);
    printToolResult(result);

    // If scan tool, offer remediation
    const findings = extractFindingsFromToolResult(result);
    if (findings.length && /^platform\.scan_/.test(tool)) {
      console.log("\n" + summarizeFindings(findings));

      const fix = await yesNo(rl, "Fix now?", true);
      if (!fix) continue;

      if (tool === "platform.scan_webapp_baseline") {
        await remediateWebApp(rl, finalArgs, findings);
      } else if (tool === "platform.scan_appplan_baseline") {
        await remediateAppPlan(rl, finalArgs, findings);
      } else if (tool === "platform.scan_workload_baseline" || tool === "platform.scan_resource_group_baseline") {
        await remediateFromAggregateScan(rl, findings);
      } else {
        console.log("No remediation flow wired for this scan tool.");
      }
    }
  }

  rl.close();
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});