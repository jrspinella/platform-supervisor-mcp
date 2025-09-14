// packages/azure-core/src/tools.remediation.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import type { MakeAzureToolsOptions } from "../types.js";
import { formatTextSummary, normalizeAzureError, scanSummary } from "../utils.js";

// Minimal content helpers
const mjson = (json: any) => [{ type: "json" as const, json }];
const mtext = (text: string) => [{ type: "text" as const, text }];

type PlanStep = { action: string; args: Record<string, any> };

type ResourceReport = {
  plannedSteps: number;
  applied?: number;
  failed?: number;
  errors?: any[];
  suggestions?: string[];
  summary?: { total: number; bySeverity: Record<string, number> };
};

type GroupReport = Record<string, ResourceReport>; // key: resourceId or "rg/name"

function renderPlanMarkdown(resourceKey: string, steps: { action: string; args: Record<string, any> }[]): string {
  if (!steps?.length) return `**${resourceKey}** — no changes required.`;

  const line = (s: any) => {
    const a = String(s.action);
    const x = s.args || {};
    if (a === "webapps.setMinTls12")         return "Set minimum TLS to **1.2**";
    if (a === "webapps.setHttpsOnly")        return "Enable **HTTPS-only**";
    if (a === "webapps.setFtpsDisabled")     return "Disable **FTPS**";
    if (a === "webapps.enableMsi")           return "Enable **system-assigned identity**";
    if (a === "monitor.enableDiagnostics")   return "Enable **diagnostic settings** to Log Analytics";
    if (a === "plans.setSku")                return `Set plan SKU to **${x.sku ?? "P1v3"}**`;
    if (a === "plans.setCapacity")           return `Set worker count to **${x.capacity ?? 2}**`;
    if (a === "plans.setZoneRedundant")      return "Enable **zone redundancy**";
    return a; // fallback
  };

  return [
    `**${resourceKey}**`,
    ...steps.map((s, i) => `  ${i + 1}. ${line(s)}`)
  ].join("\n");
}

function dedupeSteps(steps: PlanStep[]): PlanStep[] {
  const seen = new Set<string>();
  const out: PlanStep[] = [];
  for (const s of steps) {
    const key = JSON.stringify({
      action: s.action,
      args: s.args && {
        rg: s.args.resourceGroupName || s.args.rg,
        name: s.args.name,
        workspaceId: s.args.workspaceId,
        tls: s.args.minimumTlsVersion,
        httpsOnly: s.args.httpsOnly,
        ftpsState: s.args.ftpsState,
        capacity: s.args.capacity,
        sku: s.args.sku,
      },
    });
    if (!seen.has(key)) { seen.add(key); out.push(s); }
  }
  return out;
}

function summarizeResults(results: any[]): { applied: number; failed: number; errors: any[] } {
  const applied = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const errors = results.filter((r) => !r.ok).map((r) => r.error || r.result?.error).filter(Boolean);
  return { applied, failed, errors };
}

function suggestNextStepsForWebApp(steps: PlanStep[], results?: any[]): string[] {
  const tips: string[] = [];
  const errs = results?.filter((r) => !r.ok) ?? [];
  if (errs.some((e: any) => (e?.statusCode || e?.error?.statusCode) === 403)) tips.push("Verify RBAC: Contributor on resource and Microsoft.Web/* permissions.");
  if (steps.some((s) => s.action === "monitor.enableDiagnostics") && !steps.some((s) => s.args.workspaceId)) tips.push("Provide defaults.lawResourceId to link diagnostics to Log Analytics.");
  tips.push("Re-run baseline scans after apply.");
  return tips;
}

function suggestNextStepsForPlan(steps: PlanStep[], results?: any[]): string[] {
  const tips: string[] = [];
  if (steps.some((s) => s.action === "plans.setSku")) tips.push("Validate SKU supports workload and budget; consider P1v3 or higher.");
  if (steps.some((s) => s.action === "plans.setCapacity") && !steps.some((s) => s.args.capacity >= 2)) tips.push("Set worker count >= 2 for HA.");
  tips.push("Re-run baseline scans after apply.");
  return tips;
}

// ── Planning helpers ───────────────────────────────────────────
function planFromWebAppFindings(findings: any[], rg: string, name: string, defaults: any): PlanStep[] {
  const need = new Set(findings.map((f) => String(f.code).toUpperCase()));
  const steps: PlanStep[] = [];
  if (need.has("APP_TLS_MIN_BELOW_1_2")) steps.push({ action: "webapps.setMinTls12", args: { resourceGroupName: rg, name } });
  if (need.has("APP_HTTPS_ONLY_DISABLED")) steps.push({ action: "webapps.setHttpsOnly", args: { resourceGroupName: rg, name, httpsOnly: true } });
  if (need.has("APP_FTPS_NOT_DISABLED")) steps.push({ action: "webapps.setFtpsDisabled", args: { resourceGroupName: rg, name } });
  if (need.has("APP_MSI_DISABLED")) steps.push({ action: "webapps.enableMsi", args: { resourceGroupName: rg, name } });
  if (need.has("APP_DIAG_NO_LAW")) steps.push({ action: "monitor.enableDiagnostics", args: { resourceGroupName: rg, name, workspaceId: defaults?.lawResourceId } });
  return dedupeSteps(steps);
}

function planFromPlanFindings(findings: any[], rg: string, name: string, defaults: any): PlanStep[] {
  const need = new Set(findings.map((f) => String(f.code).toUpperCase()));
  const steps: PlanStep[] = [];
  if (need.has("PLAN_SKU_IS_FREE")) steps.push({ action: "plans.setSku", args: { resourceGroupName: rg, name, sku: defaults?.planSku || "P1v3" } });
  if (need.has("PLAN_WORKER_COUNT_TOO_LOW")) steps.push({ action: "plans.setCapacity", args: { resourceGroupName: rg, name, capacity: Math.max(2, Number(defaults?.capacity || 2)) } });
  if (need.has("PLAN_ZONE_REDUNDANCY_DISABLED")) steps.push({ action: "plans.setZoneRedundant", args: { resourceGroupName: rg, name, zoneRedundant: true } });
  return dedupeSteps(steps);
}

// ── Apply helpers ──────────────────────────────────────────────
async function applyWebStep(clients: MakeAzureToolsOptions["clients"], step: PlanStep) {
  const a = step.args;
  try {
    if (step.action === "webapps.setHttpsOnly") {
      if (typeof clients.webApps.update === "function") return { ok: true, result: await clients.webApps.update(a.resourceGroupName, a.name, { httpsOnly: true }) };
      const cur = await clients.webApps.get(a.resourceGroupName, a.name);
      return { ok: true, result: await clients.webApps.create({ resourceGroupName: a.resourceGroupName, name: a.name, location: cur.location, appServicePlanName: cur.serverFarmId?.split("/").pop(), httpsOnly: true, minimumTlsVersion: cur.properties?.minimumTlsVersion, ftpsState: cur.properties?.ftpsState, linuxFxVersion: cur.siteConfig?.linuxFxVersion }) };
    }
    if (step.action === "webapps.setFtpsDisabled") {
      if (typeof clients.webApps.update === "function") return { ok: true, result: await clients.webApps.update(a.resourceGroupName, a.name, { ftpsState: "Disabled" }) };
      const cur = await clients.webApps.get(a.resourceGroupName, a.name);
      return { ok: true, result: await clients.webApps.create({ resourceGroupName: a.resourceGroupName, name: a.name, location: cur.location, appServicePlanName: cur.serverFarmId?.split("/").pop(), httpsOnly: cur.properties?.httpsOnly, minimumTlsVersion: cur.properties?.minimumTlsVersion, ftpsState: "Disabled", linuxFxVersion: cur.siteConfig?.linuxFxVersion }) };
    }
    if (step.action === "webapps.setMinTls12") {
      if (typeof clients.webApps.updateConfiguration === "function") return { ok: true, result: await clients.webApps.updateConfiguration(a.resourceGroupName, a.name, { minTlsVersion: "1.2" }) };
      if (typeof clients.webApps.update === "function") return { ok: true, result: await clients.webApps.update(a.resourceGroupName, a.name, { minimumTlsVersion: "1.2" }) };
      const cur = await clients.webApps.get(a.resourceGroupName, a.name);
      return { ok: true, result: await clients.webApps.create({ resourceGroupName: a.resourceGroupName, name: a.name, location: cur.location, appServicePlanName: cur.serverFarmId?.split("/").pop(), httpsOnly: cur.properties?.httpsOnly, minimumTlsVersion: "1.2", ftpsState: cur.properties?.ftpsState, linuxFxVersion: cur.siteConfig?.linuxFxVersion }) };
    }
    if (step.action === "webapps.enableMsi") {
      const res = await clients.webApps.enableSystemAssignedIdentity(a.resourceGroupName, a.name);
      return { ok: true, result: res };
    }
    if (step.action === "monitor.enableDiagnostics") {
      const id = (await clients.webApps.get(a.resourceGroupName, a.name))?.id;
      if (!a.workspaceId) return { ok: false, error: { message: "workspaceId not provided" } };
      const ds = clients.monitor?.diagnosticSettings as any;
      if (ds?.createOrUpdate) {
        const res = await ds.createOrUpdate(id, `${a.name}-to-law`, { workspaceId: a.workspaceId });
        return { ok: true, result: res };
      }
      return { ok: false, error: { message: "diagnosticSettings.createOrUpdate not available" } };
    }
    return { ok: false, error: { message: "unknown action" } };
  } catch (e: any) {
    return { ok: false, error: normalizeAzureError(e) };
  }
}

async function applyPlanStep(clients: MakeAzureToolsOptions["clients"], step: PlanStep) {
  const a = step.args;
  try {
    if (step.action === "plans.setSku") {
      if (typeof clients.appServicePlans.update === "function") return { ok: true, result: await clients.appServicePlans.update(a.resourceGroupName, a.name, { sku: a.sku }) };
      const cur = await clients.appServicePlans.get(a.resourceGroupName, a.name);
      return { ok: true, result: await clients.appServicePlans.create(a.resourceGroupName, a.name, cur.location, a.sku, cur.tags) };
    }
    if (step.action === "plans.setCapacity") {
      if (typeof clients.appServicePlans.update === "function") return { ok: true, result: await clients.appServicePlans.update(a.resourceGroupName, a.name, { capacity: a.capacity }) };
      const cur = await clients.appServicePlans.get(a.resourceGroupName, a.name);
      const sku = cur?.sku ? { ...cur.sku, capacity: a.capacity } : { name: cur?.sku?.name || "P1v3", capacity: a.capacity };
      return { ok: true, result: await clients.appServicePlans.create(a.resourceGroupName, a.name, cur.location, sku, cur.tags) };
    }
    if (step.action === "plans.setZoneRedundant") {
      if (typeof clients.appServicePlans.update === "function") return { ok: true, result: await clients.appServicePlans.update(a.resourceGroupName, a.name, { zoneRedundant: !!a.zoneRedundant }) };
      const cur = await clients.appServicePlans.get(a.resourceGroupName, a.name);
      const sku = cur?.sku || { name: "P1v3" };
      return { ok: true, result: await clients.appServicePlans.create(a.resourceGroupName, a.name, cur.location, { ...sku, zoneRedundant: !!a.zoneRedundant }, cur.tags) };
    }
    return { ok: false, error: { message: "unknown action" } };
  } catch (e: any) {
    return { ok: false, error: normalizeAzureError(e) };
  }
}

// ── Tools ─────────────────────────────────────────────────────
export function makeAzureRemediationTools(opts: MakeAzureToolsOptions & { namespace?: string }) {
  const { clients, namespace = "azure.", evaluateGovernance } = opts;
  const n = (s: string) => `${namespace}${s}`;

  const remediate_webapp_baseline: ToolDef = {
    name: n("remediate_webapp_baseline"),
    description: "Apply fixes for common Web App baseline findings (TLS, HTTPS-only, FTPS, MSI, diagnostics).",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      findings: z.array(z.object({ code: z.string(), severity: z.string().optional(), meta: z.record(z.any()).optional() })).optional(),
      defaults: z.object({ lawResourceId: z.string().optional() }).optional(),
      dryRun: z.boolean().default(true)
    }).strict(),
    handler: async (a: any) => {
      try {
        let findings = a.findings as any[] | undefined;
        if (!findings?.length) {
          try {
            const site = await clients.webApps.get(a.resourceGroupName, a.name);
            const cfg = typeof clients.webApps.getConfiguration === "function" ? await clients.webApps.getConfiguration(a.resourceGroupName, a.name) : undefined;
            const props = site?.properties || {};
            const tls = String(props.minimumTlsVersion ?? cfg?.minTlsVersion ?? "1.0");
            const httpsOnly = !!(props.httpsOnly ?? cfg?.httpsOnly ?? false);
            const ftpsState = String(props.ftpsState ?? cfg?.ftpsState ?? "AllAllowed");
            const identity = site?.identity;
            const list = await clients.monitor?.diagnosticSettings?.list?.(site?.id);
            const hasLaw = Array.isArray(list) && list.some((d: any) => d?.workspaceId);
            findings = [] as any[];
            if (tls < "1.2") findings.push({ code: "APP_TLS_MIN_BELOW_1_2", severity: "high" });
            if (!httpsOnly) findings.push({ code: "APP_HTTPS_ONLY_DISABLED", severity: "high" });
            if (ftpsState !== "Disabled") findings.push({ code: "APP_FTPS_NOT_DISABLED", severity: "medium" });
            if (!identity || identity.type !== "SystemAssigned") findings.push({ code: "APP_MSI_DISABLED", severity: "medium" });
            if (!hasLaw) findings.push({ code: "APP_DIAG_NO_LAW", severity: "medium" });
          } catch {
            findings = [];
          }
        }
        const steps = planFromWebAppFindings(findings || [], a.resourceGroupName, a.name, a.defaults);
        const key = `${a.resourceGroupName}/webapp/${a.name}`;

        // 2) In remediate_webapp_baseline handler, dryRun branch:
        if (a.dryRun) {
          const key = `${a.resourceGroupName}/webapp/${a.name}`;
          const report: GroupReport = { [key]: { plannedSteps: steps.length, suggestions: suggestNextStepsForWebApp(steps) } };
          const preview = renderPlanMarkdown(key, steps);
          return {
            content: [
              {
                type: "json", json: {
                  status: "plan", steps, count: steps.length, report, nextActions: [
                    `Call platform.remediate_webapp_baseline with {"resourceGroupName":"${a.resourceGroupName}","name":"${a.name}","dryRun":false}`,
                  ]
                }
              },
              { type: "text", text: `### Remediation plan (web app)\n${preview}\n\nReply “apply webapp **${a.name}** now” to execute.` }
            ]
          };
        }

        const results: any[] = [];
        for (const s of steps) results.push(await applyWebStep(clients, s));
        const sum = summarizeResults(results);
        const report: GroupReport = { [key]: { plannedSteps: steps.length, applied: sum.applied, failed: sum.failed, errors: sum.errors, suggestions: suggestNextStepsForWebApp(steps, results) } };
        return { content: [...mjson({ status: "done", results, report }), ...mtext(formatTextSummary("webapp-remediate", "default", { total: steps.length, bySeverity: {} }))] };
      } catch (e: any) {
        return { content: mjson(normalizeAzureError(e)), isError: true } as any;
      }
    }
  };

  const remediate_appplan_baseline: ToolDef = {
    name: n("remediate_appplan_baseline"),
    description: "Apply fixes for common App Service Plan baseline findings (SKU, capacity, zone redundancy).",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      findings: z.array(z.object({ code: z.string(), severity: z.string().optional(), meta: z.record(z.any()).optional() })).optional(),
      defaults: z.object({ planSku: z.any().optional(), capacity: z.number().int().min(1).optional() }).optional(),
      dryRun: z.boolean().default(true)
    }).strict(),
    handler: async (a: any) => {
      try {
        let findings = a.findings as any[] | undefined;
        if (!findings?.length) {
          try {
            const plan = await clients.appServicePlans.get(a.resourceGroupName, a.name);
            const tier = String(plan?.sku?.tier ?? "");
            const skuName = String(plan?.sku?.name ?? "");
            const capacity = plan?.sku?.capacity ?? plan?.capacity;
            const zoneRedundant = plan?.zoneRedundant ?? plan?.properties?.zoneRedundant;
            findings = [] as any[];
            if (/^F/i.test(tier) || /^F/i.test(skuName) || /FREE/i.test(tier)) findings.push({ code: "PLAN_SKU_IS_FREE", severity: "medium" });
            if (typeof capacity === "number" && capacity < 2) findings.push({ code: "PLAN_WORKER_COUNT_TOO_LOW", severity: "medium" });
            if (zoneRedundant === false) findings.push({ code: "PLAN_ZONE_REDUNDANCY_DISABLED", severity: "low" });
          } catch { findings = []; }
        }
        const steps = planFromPlanFindings(findings || [], a.resourceGroupName, a.name, a.defaults);
        const key = `${a.resourceGroupName}/plan/${a.name}`;

        if (a.dryRun) {
          const key = `${a.resourceGroupName}/plan/${a.name}`;
          const report: GroupReport = { [key]: { plannedSteps: steps.length, suggestions: suggestNextStepsForPlan(steps) } };
          const preview = renderPlanMarkdown(key, steps);
          return {
            content: [
              {
                type: "json", json: {
                  status: "plan", steps, count: steps.length, report, nextActions: [
                    `Call platform.remediate_appplan_baseline with {"resourceGroupName":"${a.resourceGroupName}","name":"${a.name}","dryRun":false}`,
                  ]
                }
              },
              { type: "text", text: `### Remediation plan (app service plan)\n${preview}\n\nReply “apply plan **${a.name}** now” to execute.` }
            ]
          };
        }

        const results: any[] = [];
        for (const s of steps) results.push(await applyPlanStep(clients, s));
        const sum = summarizeResults(results);
        const report: GroupReport = { [key]: { plannedSteps: steps.length, applied: sum.applied, failed: sum.failed, errors: sum.errors, suggestions: suggestNextStepsForPlan(steps, results) } };
        return { content: [...mjson({ status: "done", results, report }), ...mtext(formatTextSummary("appplan-remediate", "default", { total: steps.length, bySeverity: {} }))] };
      } catch (e: any) {
        return { content: mjson(normalizeAzureError(e)), isError: true } as any;
      }
    }
  };

  const autofix_rg_findings: ToolDef = {
    name: n("autofix_rg_findings"),
    description: "Auto-fix selected finding codes from azure RG scans (plan/apply) and return a remediation report per resource.",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      findings: z.array(z.object({ code: z.string(), severity: z.string().optional(), meta: z.record(z.any()).optional() })).min(1),
      codes: z.array(z.string()).optional(),
      defaults: z.object({ lawResourceId: z.string().optional(), planSku: z.any().optional(), capacity: z.number().int().min(1).optional() }).optional(),
      dryRun: z.boolean().default(true)
    }).strict(),
    handler: async (a: any) => {
      try {
        const SAFE_DEFAULT_CODES = new Set([
          // webapp
          "APP_TLS_MIN_BELOW_1_2", "APP_HTTPS_ONLY_DISABLED", "APP_FTPS_NOT_DISABLED", "APP_MSI_DISABLED", "APP_DIAG_NO_LAW",
          // plan
          "PLAN_SKU_IS_FREE", "PLAN_WORKER_COUNT_TOO_LOW", "PLAN_ZONE_REDUNDANCY_DISABLED"
        ]);
        const allow = new Set((a.codes && a.codes.length ? a.codes : Array.from(SAFE_DEFAULT_CODES)).map((c: string) => c.toUpperCase()));

        const byResource = new Map<string, { kind: "webapp" | "appplan"; name: string; steps: PlanStep[] }>();

        for (const f of a.findings as any[]) {
          const code = String(f.code).toUpperCase();
          if (!allow.has(code)) continue;
          const rg = a.resourceGroupName;
          const meta = f.meta || {};
          if (meta.webAppName || meta.siteName || meta.kind === "webapp") {
            const name = meta.webAppName || meta.siteName || meta.name;
            if (!name) continue;
            const key = `${rg}/webapp/${name}`;
            const existing = byResource.get(key)?.steps ?? [];
            const steps = planFromWebAppFindings([f], rg, name, a.defaults);
            byResource.set(key, { kind: "webapp", name, steps: dedupeSteps(existing.concat(steps)) });
          } else if (meta.appServicePlanName || meta.planName || meta.kind === "appplan") {
            const name = meta.appServicePlanName || meta.planName || meta.name;
            if (!name) continue;
            const key = `${rg}/plan/${name}`;
            const existing = byResource.get(key)?.steps ?? [];
            const steps = planFromPlanFindings([f], rg, name, a.defaults);
            byResource.set(key, { kind: "appplan", name, steps: dedupeSteps(existing.concat(steps)) });
          }
        }

        const report: GroupReport = {};
        const results: Record<string, any[]> = {};
        const plans: Record<string, PlanStep[]> = {};

        for (const [key, entry] of byResource) {
          const steps = entry.steps;
          plans[key] = steps;
          if (a.dryRun) {
            const sections = Object.entries(plans).map(([k, steps]) => renderPlanMarkdown(k, steps));
            const md = `### Remediation plan (resource group: ${a.resourceGroupName})\n` + sections.join("\n\n");
            return {
              content: [
                { type: "json", json: { status: "plan", resourceGroupName: a.resourceGroupName, plans, report } },
                { type: "text", text: md + `\n\nReply “apply RG **${a.resourceGroupName}** plan” to execute.` }
              ]
            };
          }
          const out: any[] = [];
          for (const s of steps) {
            out.push(entry.kind === "webapp" ? await applyWebStep(clients, s) : await applyPlanStep(clients, s));
          }
          results[key] = out;
          const sum = summarizeResults(out);
          report[key] = { plannedSteps: steps.length, applied: sum.applied, failed: sum.failed, errors: sum.errors, suggestions: entry.kind === "webapp" ? suggestNextStepsForWebApp(steps, out) : suggestNextStepsForPlan(steps, out) };
        }

        return { content: [...mjson({ status: a.dryRun ? "plan" : "done", resourceGroupName: a.resourceGroupName, plans: a.dryRun ? plans : undefined, results: a.dryRun ? undefined : results, report }), ...mtext(formatTextSummary("rg-remediate", "default", scanSummary([])))] };
      } catch (e: any) {
        return { content: mjson(normalizeAzureError(e)), isError: true } as any;
      }
    }
  };

  return [remediate_webapp_baseline, remediate_appplan_baseline, autofix_rg_findings];
}
