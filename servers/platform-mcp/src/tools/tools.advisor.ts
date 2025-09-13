// servers/platform-mcp/src/tools/tools.advisor.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { createAzureClientsFromEnv } from "../clients.azure.js";

type Finding = {
  code: string;
  severity?: "info" | "low" | "medium" | "high" | string;
  meta?: Record<string, any>;
  suggest?: string;
  controlIds?: string[];
};

const FindingsInput = z.array(
  z.object({
    code: z.string(),
    severity: z.string().optional(),
    meta: z.record(z.any()).optional(),
    suggest: z.string().optional(),
    controlIds: z.array(z.string()).optional(),
  })
);

const ok = (json: any) => ({ content: [{ type: "json" as const, json }] });
const err = (message: string) => ({
  content: [{ type: "json" as const, json: { status: "error", error: { message } } }],
  isError: true as const,
});

export function makeAdvisorTools(): ToolDef[] {
  const remediate_webapp_baseline: ToolDef = {
    name: "platform.remediate_webapp_baseline",
    description:
      "Plan/apply remediations for baseline issues on a Web App. Handles: APP_TLS_MIN_BELOW_1_2, APP_HTTPS_ONLY_DISABLED, APP_FTPS_NOT_DISABLED, APP_MSI_DISABLED, APP_DIAG_NO_LAW.",
    inputSchema: z
      .object({
        resourceGroupName: z.string(),
        name: z.string(),
        findings: FindingsInput.default([]),
        dryRun: z.boolean().default(true),
        lawWorkspaceId: z.string().optional(),
      })
      .strict(),
    handler: async (a) => {
      try {
        const clients = await createAzureClientsFromEnv();

        /** Fallback update via createOrUpdate */
        const updateSite = async (patch: any) => {
          if (typeof clients.webApps.update === "function") {
            return clients.webApps.update(a.resourceGroupName, a.name, patch);
          }
          const cur: any = await clients.webApps.get(a.resourceGroupName, a.name);
          // try to carry serverFarmId if present; otherwise infer from id
          const planId = cur?.serverFarmId;
          const planName = planId?.split("/")?.pop();
          return clients.webApps.create({
            resourceGroupName: a.resourceGroupName,
            name: a.name,
            location: cur?.location,
            appServicePlanName: planName || "",
            httpsOnly: typeof patch?.httpsOnly === "boolean" ? patch.httpsOnly : (cur?.properties?.httpsOnly ?? cur?.httpsOnly),
            minimumTlsVersion: patch?.minimumTlsVersion ?? patch?.minTlsVersion ?? (cur?.siteConfig?.minTlsVersion ?? cur?.properties?.minimumTlsVersion),
            ftpsState: patch?.ftpsState ?? cur?.siteConfig?.ftpsState,
            linuxFxVersion: patch?.linuxFxVersion ?? cur?.siteConfig?.linuxFxVersion,
            tags: patch?.tags ?? cur?.tags,
          });
        };

        const updateConfig = async (patch: any) => {
          if (typeof clients.webApps.updateConfiguration === "function") {
            return clients.webApps.updateConfiguration(a.resourceGroupName, a.name, patch);
          }
          // Fallback: push through site update (some config props can be set on siteConfig)
          const mapped: any = {};
          if (patch?.minTlsVersion || patch?.minimumTlsVersion) {
            mapped.minimumTlsVersion = patch.minimumTlsVersion ?? patch.minTlsVersion;
          }
          if (patch?.ftpsState) mapped.ftpsState = patch.ftpsState;
          return updateSite(mapped);
        };

        const ensureDiag = async () => {
          const ws = a.lawWorkspaceId || process.env.LAW_WORKSPACE_ID;
          if (!ws) throw new Error("LAW workspace id required (pass lawWorkspaceId or set LAW_WORKSPACE_ID)");
          const site: any = await clients.webApps.get(a.resourceGroupName, a.name);
          const resId = site?.id;
          const ds = clients.monitor?.diagnosticSettings;
          if (ds?.createOrUpdate) {
            // Support both signatures: (id, name, params) or (id, params)
            try {
              return await ds.createOrUpdate(resId!, `${a.name}-to-law`, { workspaceId: ws });
            } catch {
              return await ds.createOrUpdate(resId!, { workspaceId: ws });
            }
          }
          throw new Error("monitor.diagnosticSettings.createOrUpdate is not available in this client");
        };

        const actions: Array<{
          code: string;
          title: string;
          apply?: () => Promise<any>;
        }> = [];

        for (const f of a.findings || []) {
          switch (f.code) {
            case "APP_TLS_MIN_BELOW_1_2":
              actions.push({
                code: f.code,
                title: "Set minimum TLS version to 1.2",
                apply: () => updateConfig({ minTlsVersion: "1.2", minimumTlsVersion: "1.2" }),
              });
              break;
            case "APP_HTTPS_ONLY_DISABLED":
              actions.push({
                code: f.code,
                title: "Enable HTTPS-only",
                apply: () => updateSite({ httpsOnly: true }),
              });
              break;
            case "APP_FTPS_NOT_DISABLED":
              actions.push({
                code: f.code,
                title: "Disable FTPS",
                apply: () => updateConfig({ ftpsState: "Disabled" }),
              });
              break;
            case "APP_MSI_DISABLED":
              actions.push({
                code: f.code,
                title: "Enable system-assigned identity",
                apply: () => updateSite({ identity: { type: "SystemAssigned" } }),
              });
              break;
            case "APP_DIAG_NO_LAW":
              actions.push({
                code: f.code,
                title: "Enable diagnostic settings to LAW",
                apply: () => ensureDiag(),
              });
              break;
            default:
              actions.push({ code: f.code, title: "No known remediation for this finding (skipped)" });
          }
        }

        if (a.dryRun) {
          return ok({
            status: "planned",
            target: { kind: "webapp", resourceGroupName: a.resourceGroupName, name: a.name },
            actions: actions.map((x) => ({ code: x.code, title: x.title })),
          });
        }

        const results: any[] = [];
        for (const act of actions) {
          if (!act.apply) {
            results.push({ code: act.code, title: act.title, status: "skipped" });
            continue;
          }
          try {
            const r = await act.apply();
            results.push({ code: act.code, title: act.title, status: "done", result: r });
          } catch (e: any) {
            results.push({ code: act.code, title: act.title, status: "error", error: e?.message || String(e) });
          }
        }

        return ok({
          status: "applied",
          target: { kind: "webapp", resourceGroupName: a.resourceGroupName, name: a.name },
          results,
        });
      } catch (e: any) {
        return err(e?.message || String(e));
      }
    },
  };

  const remediate_appplan_baseline: ToolDef = {
    name: "platform.remediate_appplan_baseline",
    description:
      "Plan/apply remediations for App Service Plan issues (e.g., APPPLAN_SKU_TOO_LOW, APPPLAN_DIAG_NO_LAW).",
    inputSchema: z
      .object({
        resourceGroupName: z.string(),
        name: z.string(),
        findings: FindingsInput.default([]),
        dryRun: z.boolean().default(true),
        targetSku: z.string().default(process.env.ASP_MIN_SKU || "P1v3"),
        lawWorkspaceId: z.string().optional(),
      })
      .strict(),
    handler: async (a) => {
      try {
        const clients = await createAzureClientsFromEnv();

        const upgradeSku = async () => {
          if (typeof clients.appServicePlans.update === "function") {
            return clients.appServicePlans.update(a.resourceGroupName, a.name, { sku: a.targetSku });
          }
          const cur = await clients.appServicePlans.get(a.resourceGroupName, a.name);
          return clients.appServicePlans.create(
            a.resourceGroupName,
            a.name,
            cur.location,
            { ...(cur as any)?.sku, name: a.targetSku },
            cur.tags
          );
        };

        const ensureDiag = async () => {
          const ws = a.lawWorkspaceId || process.env.LAW_WORKSPACE_ID;
          if (!ws) throw new Error("LAW workspace id required (pass lawWorkspaceId or set LAW_WORKSPACE_ID)");
          const plan = await clients.appServicePlans.get(a.resourceGroupName, a.name);
          const resId = (plan as any)?.id;
          const ds = clients.monitor?.diagnosticSettings;
          if (ds?.createOrUpdate) {
            try {
              return await ds.createOrUpdate(resId!, `${a.name}-to-law`, { workspaceId: ws });
            } catch {
              return await ds.createOrUpdate(resId!, { workspaceId: ws });
            }
          }
          throw new Error("monitor.diagnosticSettings.createOrUpdate is not available in this client");
        };

        const actions: Array<{ code: string; title: string; apply?: () => Promise<any> }> = [];

        for (const f of a.findings || []) {
          switch (f.code) {
            case "APPPLAN_SKU_TOO_LOW":
              actions.push({
                code: f.code,
                title: `Upgrade App Service Plan SKU to ${a.targetSku}`,
                apply: () => upgradeSku(),
              });
              break;
            case "APPPLAN_DIAG_NO_LAW":
              actions.push({
                code: f.code,
                title: "Enable diagnostic settings to LAW",
                apply: () => ensureDiag(),
              });
              break;
            default:
              actions.push({ code: f.code, title: "No known remediation for this finding (skipped)" });
          }
        }

        if (a.dryRun) {
          return ok({
            status: "planned",
            target: { kind: "appServicePlan", resourceGroupName: a.resourceGroupName, name: a.name },
            actions: actions.map((x) => ({ code: x.code, title: x.title })),
          });
        }

        const results: any[] = [];
        for (const act of actions) {
          if (!act.apply) {
            results.push({ code: act.code, title: act.title, status: "skipped" });
            continue;
          }
          try {
            const r = await act.apply();
            results.push({ code: act.code, title: act.title, status: "done", result: r });
          } catch (e: any) {
            results.push({ code: act.code, title: act.title, status: "error", error: e?.message || String(e) });
          }
        }

        return ok({
          status: "applied",
          target: { kind: "appServicePlan", resourceGroupName: a.resourceGroupName, name: a.name },
          results,
        });
      } catch (e: any) {
        return err(e?.message || String(e));
      }
    },
  };

  const advise_from_findings: ToolDef = {
    name: "platform.advise_from_findings",
    description: "Produce an advisory list from findings (codes, controls, suggestions).",
    inputSchema: z.object({ findings: FindingsInput }).strict(),
    handler: async (a) => {
      const items = (a.findings || []).map((f: { code: any; severity: any; controlIds: any; suggest: any; }) => ({
        code: f.code,
        severity: f.severity || "unknown",
        controls: f.controlIds || [],
        recommendation: f.suggest || "Review configuration against referenced controls.",
      }));
      return ok({ status: "done", items });
    },
  };

  return [remediate_webapp_baseline, remediate_appplan_baseline, advise_from_findings];
}