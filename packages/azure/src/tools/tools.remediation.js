// packages/azure-core/src/tools.remediation.ts
import { z } from "zod";
import { normalizeAzureError, scanSummary, formatTextSummary } from "../utils.js";
// Minimal content helpers
const mjson = (json) => [{ type: "json", json }];
const mtext = (text) => [{ type: "text", text }];
function dedupeSteps(steps) {
    const seen = new Set();
    const out = [];
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
        if (!seen.has(key)) {
            seen.add(key);
            out.push(s);
        }
    }
    return out;
}
function summarizeResults(results) {
    const applied = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    const errors = results.filter((r) => !r.ok).map((r) => r.error || r.result?.error).filter(Boolean);
    return { applied, failed, errors };
}
function suggestNextStepsForWebApp(steps, results) {
    const tips = [];
    const errs = results?.filter((r) => !r.ok) ?? [];
    if (errs.some((e) => (e?.statusCode || e?.error?.statusCode) === 403))
        tips.push("Verify RBAC: Contributor on resource and Microsoft.Web/* permissions.");
    if (steps.some((s) => s.action === "monitor.enableDiagnostics") && !steps.some((s) => s.args.workspaceId))
        tips.push("Provide defaults.lawResourceId to link diagnostics to Log Analytics.");
    tips.push("Re-run baseline scans after apply.");
    return tips;
}
function suggestNextStepsForPlan(steps, results) {
    const tips = [];
    if (steps.some((s) => s.action === "plans.setSku"))
        tips.push("Validate SKU supports workload and budget; consider P1v3 or higher.");
    if (steps.some((s) => s.action === "plans.setCapacity") && !steps.some((s) => s.args.capacity >= 2))
        tips.push("Set worker count >= 2 for HA.");
    tips.push("Re-run baseline scans after apply.");
    return tips;
}
// ── Planning helpers ───────────────────────────────────────────
function planFromWebAppFindings(findings, rg, name, defaults) {
    const need = new Set(findings.map((f) => String(f.code).toUpperCase()));
    const steps = [];
    if (need.has("APP_TLS_MIN_BELOW_1_2"))
        steps.push({ action: "webapps.setMinTls12", args: { resourceGroupName: rg, name } });
    if (need.has("APP_HTTPS_ONLY_DISABLED"))
        steps.push({ action: "webapps.setHttpsOnly", args: { resourceGroupName: rg, name, httpsOnly: true } });
    if (need.has("APP_FTPS_NOT_DISABLED"))
        steps.push({ action: "webapps.setFtpsDisabled", args: { resourceGroupName: rg, name } });
    if (need.has("APP_MSI_DISABLED"))
        steps.push({ action: "webapps.enableMsi", args: { resourceGroupName: rg, name } });
    if (need.has("APP_DIAG_NO_LAW"))
        steps.push({ action: "monitor.enableDiagnostics", args: { resourceGroupName: rg, name, workspaceId: defaults?.lawResourceId } });
    return dedupeSteps(steps);
}
function planFromPlanFindings(findings, rg, name, defaults) {
    const need = new Set(findings.map((f) => String(f.code).toUpperCase()));
    const steps = [];
    if (need.has("PLAN_SKU_IS_FREE"))
        steps.push({ action: "plans.setSku", args: { resourceGroupName: rg, name, sku: defaults?.planSku || "P1v3" } });
    if (need.has("PLAN_WORKER_COUNT_TOO_LOW"))
        steps.push({ action: "plans.setCapacity", args: { resourceGroupName: rg, name, capacity: Math.max(2, Number(defaults?.capacity || 2)) } });
    if (need.has("PLAN_ZONE_REDUNDANCY_DISABLED"))
        steps.push({ action: "plans.setZoneRedundant", args: { resourceGroupName: rg, name, zoneRedundant: true } });
    return dedupeSteps(steps);
}
// ── Apply helpers ──────────────────────────────────────────────
async function applyWebStep(clients, step) {
    const a = step.args;
    try {
        if (step.action === "webapps.setHttpsOnly") {
            if (typeof clients.webApps.update === "function")
                return { ok: true, result: await clients.webApps.update(a.resourceGroupName, a.name, { httpsOnly: true }) };
            const cur = await clients.webApps.get(a.resourceGroupName, a.name);
            return { ok: true, result: await clients.webApps.create({ resourceGroupName: a.resourceGroupName, name: a.name, location: cur.location, appServicePlanName: cur.serverFarmId?.split("/").pop(), httpsOnly: true, minimumTlsVersion: cur.properties?.minimumTlsVersion, ftpsState: cur.properties?.ftpsState, linuxFxVersion: cur.siteConfig?.linuxFxVersion }) };
        }
        if (step.action === "webapps.setFtpsDisabled") {
            if (typeof clients.webApps.update === "function")
                return { ok: true, result: await clients.webApps.update(a.resourceGroupName, a.name, { ftpsState: "Disabled" }) };
            const cur = await clients.webApps.get(a.resourceGroupName, a.name);
            return { ok: true, result: await clients.webApps.create({ resourceGroupName: a.resourceGroupName, name: a.name, location: cur.location, appServicePlanName: cur.serverFarmId?.split("/").pop(), httpsOnly: cur.properties?.httpsOnly, minimumTlsVersion: cur.properties?.minimumTlsVersion, ftpsState: "Disabled", linuxFxVersion: cur.siteConfig?.linuxFxVersion }) };
        }
        if (step.action === "webapps.setMinTls12") {
            if (typeof clients.webApps.updateConfiguration === "function")
                return { ok: true, result: await clients.webApps.updateConfiguration(a.resourceGroupName, a.name, { minTlsVersion: "1.2" }) };
            if (typeof clients.webApps.update === "function")
                return { ok: true, result: await clients.webApps.update(a.resourceGroupName, a.name, { minimumTlsVersion: "1.2" }) };
            const cur = await clients.webApps.get(a.resourceGroupName, a.name);
            return { ok: true, result: await clients.webApps.create({ resourceGroupName: a.resourceGroupName, name: a.name, location: cur.location, appServicePlanName: cur.serverFarmId?.split("/").pop(), httpsOnly: cur.properties?.httpsOnly, minimumTlsVersion: "1.2", ftpsState: cur.properties?.ftpsState, linuxFxVersion: cur.siteConfig?.linuxFxVersion }) };
        }
        if (step.action === "webapps.enableMsi") {
            const res = await clients.webApps.enableSystemAssignedIdentity(a.resourceGroupName, a.name);
            return { ok: true, result: res };
        }
        if (step.action === "monitor.enableDiagnostics") {
            const id = (await clients.webApps.get(a.resourceGroupName, a.name))?.id;
            if (!a.workspaceId)
                return { ok: false, error: { message: "workspaceId not provided" } };
            const ds = clients.monitor?.diagnosticSettings;
            if (ds?.createOrUpdate) {
                const res = await ds.createOrUpdate(id, `${a.name}-to-law`, { workspaceId: a.workspaceId });
                return { ok: true, result: res };
            }
            return { ok: false, error: { message: "diagnosticSettings.createOrUpdate not available" } };
        }
        return { ok: false, error: { message: "unknown action" } };
    }
    catch (e) {
        return { ok: false, error: normalizeAzureError(e) };
    }
}
async function applyPlanStep(clients, step) {
    const a = step.args;
    try {
        if (step.action === "plans.setSku") {
            if (typeof clients.appServicePlans.update === "function")
                return { ok: true, result: await clients.appServicePlans.update(a.resourceGroupName, a.name, { sku: a.sku }) };
            const cur = await clients.appServicePlans.get(a.resourceGroupName, a.name);
            return { ok: true, result: await clients.appServicePlans.create(a.resourceGroupName, a.name, cur.location, a.sku, cur.tags) };
        }
        if (step.action === "plans.setCapacity") {
            if (typeof clients.appServicePlans.update === "function")
                return { ok: true, result: await clients.appServicePlans.update(a.resourceGroupName, a.name, { capacity: a.capacity }) };
            const cur = await clients.appServicePlans.get(a.resourceGroupName, a.name);
            const sku = cur?.sku ? { ...cur.sku, capacity: a.capacity } : { name: cur?.sku?.name || "P1v3", capacity: a.capacity };
            return { ok: true, result: await clients.appServicePlans.create(a.resourceGroupName, a.name, cur.location, sku, cur.tags) };
        }
        if (step.action === "plans.setZoneRedundant") {
            if (typeof clients.appServicePlans.update === "function")
                return { ok: true, result: await clients.appServicePlans.update(a.resourceGroupName, a.name, { zoneRedundant: !!a.zoneRedundant }) };
            const cur = await clients.appServicePlans.get(a.resourceGroupName, a.name);
            const sku = cur?.sku || { name: "P1v3" };
            return { ok: true, result: await clients.appServicePlans.create(a.resourceGroupName, a.name, cur.location, { ...sku, zoneRedundant: !!a.zoneRedundant }, cur.tags) };
        }
        return { ok: false, error: { message: "unknown action" } };
    }
    catch (e) {
        return { ok: false, error: normalizeAzureError(e) };
    }
}
// ── Tools ─────────────────────────────────────────────────────
export function makeAzureRemediationTools(opts) {
    const { clients, namespace = "azure.", evaluateGovernance } = opts;
    const n = (s) => `${namespace}${s}`;
    const remediate_webapp_baseline = {
        name: n("remediate_webapp_baseline"),
        description: "Apply fixes for common Web App baseline findings (TLS, HTTPS-only, FTPS, MSI, diagnostics).",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            name: z.string(),
            findings: z.array(z.object({ code: z.string(), severity: z.string().optional(), meta: z.record(z.any()).optional() })).optional(),
            defaults: z.object({ lawResourceId: z.string().optional() }).optional(),
            dryRun: z.boolean().default(true)
        }).strict(),
        handler: async (a) => {
            try {
                let findings = a.findings;
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
                        const hasLaw = Array.isArray(list) && list.some((d) => d?.workspaceId);
                        findings = [];
                        if (tls < "1.2")
                            findings.push({ code: "APP_TLS_MIN_BELOW_1_2", severity: "high" });
                        if (!httpsOnly)
                            findings.push({ code: "APP_HTTPS_ONLY_DISABLED", severity: "high" });
                        if (ftpsState !== "Disabled")
                            findings.push({ code: "APP_FTPS_NOT_DISABLED", severity: "medium" });
                        if (!identity || identity.type !== "SystemAssigned")
                            findings.push({ code: "APP_MSI_DISABLED", severity: "medium" });
                        if (!hasLaw)
                            findings.push({ code: "APP_DIAG_NO_LAW", severity: "medium" });
                    }
                    catch {
                        findings = [];
                    }
                }
                const steps = planFromWebAppFindings(findings || [], a.resourceGroupName, a.name, a.defaults);
                const key = `${a.resourceGroupName}/webapp/${a.name}`;
                if (a.dryRun) {
                    const report = { [key]: { plannedSteps: steps.length, suggestions: suggestNextStepsForWebApp(steps) } };
                    return { content: [...mjson({ status: "plan", steps, count: steps.length, report }), ...mtext(formatTextSummary("webapp-remediate-plan", "default", { total: steps.length, bySeverity: {} }))] };
                }
                const results = [];
                for (const s of steps)
                    results.push(await applyWebStep(clients, s));
                const sum = summarizeResults(results);
                const report = { [key]: { plannedSteps: steps.length, applied: sum.applied, failed: sum.failed, errors: sum.errors, suggestions: suggestNextStepsForWebApp(steps, results) } };
                return { content: [...mjson({ status: "done", results, report }), ...mtext(formatTextSummary("webapp-remediate", "default", { total: steps.length, bySeverity: {} }))] };
            }
            catch (e) {
                return { content: mjson(normalizeAzureError(e)), isError: true };
            }
        }
    };
    const remediate_appplan_baseline = {
        name: n("remediate_appplan_baseline"),
        description: "Apply fixes for common App Service Plan baseline findings (SKU, capacity, zone redundancy).",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            name: z.string(),
            findings: z.array(z.object({ code: z.string(), severity: z.string().optional(), meta: z.record(z.any()).optional() })).optional(),
            defaults: z.object({ planSku: z.any().optional(), capacity: z.number().int().min(1).optional() }).optional(),
            dryRun: z.boolean().default(true)
        }).strict(),
        handler: async (a) => {
            try {
                let findings = a.findings;
                if (!findings?.length) {
                    try {
                        const plan = await clients.appServicePlans.get(a.resourceGroupName, a.name);
                        const tier = String(plan?.sku?.tier ?? "");
                        const skuName = String(plan?.sku?.name ?? "");
                        const capacity = plan?.sku?.capacity ?? plan?.capacity;
                        const zoneRedundant = plan?.zoneRedundant ?? plan?.properties?.zoneRedundant;
                        findings = [];
                        if (/^F/i.test(tier) || /^F/i.test(skuName) || /FREE/i.test(tier))
                            findings.push({ code: "PLAN_SKU_IS_FREE", severity: "medium" });
                        if (typeof capacity === "number" && capacity < 2)
                            findings.push({ code: "PLAN_WORKER_COUNT_TOO_LOW", severity: "medium" });
                        if (zoneRedundant === false)
                            findings.push({ code: "PLAN_ZONE_REDUNDANCY_DISABLED", severity: "low" });
                    }
                    catch {
                        findings = [];
                    }
                }
                const steps = planFromPlanFindings(findings || [], a.resourceGroupName, a.name, a.defaults);
                const key = `${a.resourceGroupName}/plan/${a.name}`;
                if (a.dryRun) {
                    const report = { [key]: { plannedSteps: steps.length, suggestions: suggestNextStepsForPlan(steps) } };
                    return { content: [...mjson({ status: "plan", steps, count: steps.length, report }), ...mtext(formatTextSummary("appplan-remediate-plan", "default", { total: steps.length, bySeverity: {} }))] };
                }
                const results = [];
                for (const s of steps)
                    results.push(await applyPlanStep(clients, s));
                const sum = summarizeResults(results);
                const report = { [key]: { plannedSteps: steps.length, applied: sum.applied, failed: sum.failed, errors: sum.errors, suggestions: suggestNextStepsForPlan(steps, results) } };
                return { content: [...mjson({ status: "done", results, report }), ...mtext(formatTextSummary("appplan-remediate", "default", { total: steps.length, bySeverity: {} }))] };
            }
            catch (e) {
                return { content: mjson(normalizeAzureError(e)), isError: true };
            }
        }
    };
    const autofix_rg_findings = {
        name: n("autofix_rg_findings"),
        description: "Auto-fix selected finding codes from azure RG scans (plan/apply) and return a remediation report per resource.",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            findings: z.array(z.object({ code: z.string(), severity: z.string().optional(), meta: z.record(z.any()).optional() })).min(1),
            codes: z.array(z.string()).optional(),
            defaults: z.object({ lawResourceId: z.string().optional(), planSku: z.any().optional(), capacity: z.number().int().min(1).optional() }).optional(),
            dryRun: z.boolean().default(true)
        }).strict(),
        handler: async (a) => {
            try {
                const SAFE_DEFAULT_CODES = new Set([
                    // webapp
                    "APP_TLS_MIN_BELOW_1_2", "APP_HTTPS_ONLY_DISABLED", "APP_FTPS_NOT_DISABLED", "APP_MSI_DISABLED", "APP_DIAG_NO_LAW",
                    // plan
                    "PLAN_SKU_IS_FREE", "PLAN_WORKER_COUNT_TOO_LOW", "PLAN_ZONE_REDUNDANCY_DISABLED"
                ]);
                const allow = new Set((a.codes && a.codes.length ? a.codes : Array.from(SAFE_DEFAULT_CODES)).map((c) => c.toUpperCase()));
                const byResource = new Map();
                for (const f of a.findings) {
                    const code = String(f.code).toUpperCase();
                    if (!allow.has(code))
                        continue;
                    const rg = a.resourceGroupName;
                    const meta = f.meta || {};
                    if (meta.webAppName || meta.siteName || meta.kind === "webapp") {
                        const name = meta.webAppName || meta.siteName || meta.name;
                        if (!name)
                            continue;
                        const key = `${rg}/webapp/${name}`;
                        const existing = byResource.get(key)?.steps ?? [];
                        const steps = planFromWebAppFindings([f], rg, name, a.defaults);
                        byResource.set(key, { kind: "webapp", name, steps: dedupeSteps(existing.concat(steps)) });
                    }
                    else if (meta.appServicePlanName || meta.planName || meta.kind === "appplan") {
                        const name = meta.appServicePlanName || meta.planName || meta.name;
                        if (!name)
                            continue;
                        const key = `${rg}/plan/${name}`;
                        const existing = byResource.get(key)?.steps ?? [];
                        const steps = planFromPlanFindings([f], rg, name, a.defaults);
                        byResource.set(key, { kind: "appplan", name, steps: dedupeSteps(existing.concat(steps)) });
                    }
                }
                const report = {};
                const results = {};
                const plans = {};
                for (const [key, entry] of byResource) {
                    const steps = entry.steps;
                    plans[key] = steps;
                    if (a.dryRun) {
                        report[key] = { plannedSteps: steps.length, suggestions: entry.kind === "webapp" ? suggestNextStepsForWebApp(steps) : suggestNextStepsForPlan(steps) };
                        continue;
                    }
                    const out = [];
                    for (const s of steps) {
                        out.push(entry.kind === "webapp" ? await applyWebStep(clients, s) : await applyPlanStep(clients, s));
                    }
                    results[key] = out;
                    const sum = summarizeResults(out);
                    report[key] = { plannedSteps: steps.length, applied: sum.applied, failed: sum.failed, errors: sum.errors, suggestions: entry.kind === "webapp" ? suggestNextStepsForWebApp(steps, out) : suggestNextStepsForPlan(steps, out) };
                }
                return { content: [...mjson({ status: a.dryRun ? "plan" : "done", resourceGroupName: a.resourceGroupName, plans: a.dryRun ? plans : undefined, results: a.dryRun ? undefined : results, report }), ...mtext(formatTextSummary("rg-remediate", "default", scanSummary([])))] };
            }
            catch (e) {
                return { content: mjson(normalizeAzureError(e)), isError: true };
            }
        }
    };
    return [remediate_webapp_baseline, remediate_appplan_baseline, autofix_rg_findings];
}
