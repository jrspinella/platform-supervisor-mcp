// packages/azure-core/src/tools/tools.remediation.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import type { MakeAzureToolsOptions } from "../types.js";
import { normalizeAzureError } from "../utils.js";

export function makeAzureRemediationTools(opts: MakeAzureToolsOptions & { namespace?: string }): ToolDef[] {
  const { clients, namespace = "azure." } = opts;
  const n = (s: string) => `${namespace}${s}`;

  // Generic partial config updater for Web Apps (Linux)
  const update_web_app_config: ToolDef = {
    name: n("update_web_app_config"),
    description: "Patch Web App configuration bits (httpsOnly, ftpsState, minimumTlsVersion, linuxFxVersion).",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      httpsOnly: z.boolean().optional(),
      ftpsState: z.enum(["Disabled", "FtpsOnly", "AllAllowed"]).optional(),
      minimumTlsVersion: z.enum(["1.0", "1.1", "1.2", "1.3"]).optional(),
      linuxFxVersion: z.string().optional(),   // e.g. "NODE|20-lts"
    }).strict(),
    handler: async (a) => {
      try {
        // Some SDKs separate "site" vs "config". We try best-effort patch:
        const res = await clients.webApps.updateConfiguration?.(a.resourceGroupName, a.name, {
          httpsOnly: a.httpsOnly,
          ftpsState: a.ftpsState,
          minTlsVersion: a.minimumTlsVersion,
          linuxFxVersion: a.linuxFxVersion,
        });
        return { content: [{ type: "json", json: res ?? { status: "done" } }] };
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    }
  };

  // Remediate common baseline issues for a Web App
  const remediate_webapp_baseline: ToolDef = {
    name: n("remediate_webapp_baseline"),
    description: "Fix common Web App baseline issues (HTTPS-only, TLS >=1.2, FTPS disabled, MSI enabled, diagnostics to LAW).",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      dryRun: z.boolean().default(true),
      defaults: z.object({
        lawResourceId: z.string().optional(), // to wire diagnostics
        minimumTlsVersion: z.enum(["1.2", "1.3"]).default("1.2"),
        ftpsState: z.enum(["Disabled", "FtpsOnly", "AllAllowed"]).default("Disabled"),
      }).default({ minimumTlsVersion: "1.2", ftpsState: "Disabled" }),
    }).strict(),
    handler: async (a) => {
      const actions: any[] = [];
      try {
        const site: any = await clients.webApps.get(a.resourceGroupName, a.name);
        const cfg: any = typeof clients.webApps.getConfiguration === "function"
          ? await clients.webApps.getConfiguration(a.resourceGroupName, a.name)
          : {};

        const props = site?.properties || {};
        const currentTls = String(props.minimumTlsVersion ?? cfg?.minTlsVersion ?? "1.0");
        const httpsOnly = !!(props.httpsOnly ?? cfg?.httpsOnly ?? false);
        const ftpsState = String(props.ftpsState ?? cfg?.ftpsState ?? "AllAllowed");
        const identity = site?.identity;

        if (!httpsOnly) actions.push({ op: "set", path: "httpsOnly", value: true });
        if (currentTls < a.defaults.minimumTlsVersion) actions.push({ op: "set", path: "minimumTlsVersion", value: a.defaults.minimumTlsVersion });
        if (ftpsState !== a.defaults.ftpsState) actions.push({ op: "set", path: "ftpsState", value: a.defaults.ftpsState });
        if (!identity || identity.type !== "SystemAssigned") actions.push({ op: "enableMSI" });

        // Diagnostics → LAW
        let hasLaw = false;
        try {
          const list = await clients.monitor?.diagnosticSettings?.list?.(site?.id!);
          hasLaw = Array.isArray(list) && list.some((d: any) => d?.workspaceId);
        } catch {}
        if (!hasLaw && a.defaults.lawResourceId) {
          actions.push({ op: "enableDiagnosticsToLAW", workspaceId: a.defaults.lawResourceId });
        }

        if (a.dryRun) {
          return { content: [{ type: "json", json: { status: "planned", actions } }] };
        }

        // APPLY
        for (const act of actions) {
          if (act.op === "enableMSI") {
            await clients.webApps.enableSystemAssignedIdentity(a.resourceGroupName, a.name);
          } else if (act.op === "enableDiagnosticsToLAW") {
            await clients.monitor?.diagnosticSettings?.createOrUpdate?.(site.id, "webapp-baseline", {
              workspaceId: act.workspaceId,
              // send standard categories:
              logs: [{ category: "AppServiceHTTPLogs", enabled: true }],
              metrics: [{ category: "AllMetrics", enabled: true }],
            });
          } else {
            // config patch
            await clients.webApps.updateConfiguration?.(a.resourceGroupName, a.name, {
              httpsOnly: act.path === "httpsOnly" ? act.value : undefined,
              ftpsState: act.path === "ftpsState" ? act.value : undefined,
              minTlsVersion: act.path === "minimumTlsVersion" ? act.value : undefined,
            });
          }
        }

        return { content: [{ type: "json", json: { status: "done", actionsApplied: actions } }] };
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    }
  };

  // Remediate common baseline issues for an App Service Plan
  const remediate_appplan_baseline: ToolDef = {
    name: n("remediate_appplan_baseline"),
    description: "Fix common App Service Plan baseline issues (FTPS disabled, MSI on, diagnostics to LAW).",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      dryRun: z.boolean().default(true),
      defaults: z.object({
        lawResourceId: z.string().optional(),
        ftpsState: z.enum(["Disabled", "FtpsOnly", "AllAllowed"]).default("Disabled"),
      }).default({ ftpsState: "Disabled" }),
    }).strict(),
    handler: async (a) => {
      const actions: any[] = [];
      try {
        const plan: any = await clients.appServicePlans.get(a.resourceGroupName, a.name);
        const props = plan?.properties || {};
        const ftpsState = String(props.ftpsState ?? "AllAllowed");
        const identity = plan?.identity;

        if (ftpsState !== a.defaults.ftpsState) actions.push({ op: "setPlanFtpsState", value: a.defaults.ftpsState });
        if (!identity || identity.type !== "SystemAssigned") actions.push({ op: "enablePlanMSI" });

        // Diagnostics → LAW
        let hasLaw = false;
        try {
          const list = await clients.monitor?.diagnosticSettings?.list?.(plan?.id!);
          hasLaw = Array.isArray(list) && list.some((d: any) => d?.workspaceId);
        } catch {}
        if (!hasLaw && a.defaults.lawResourceId) {
          actions.push({ op: "enableDiagnosticsToLAW", workspaceId: a.defaults.lawResourceId });
        }

        if (a.dryRun) {
          return { content: [{ type: "json", json: { status: "planned", actions } }] };
        }

        // APPLY
        for (const act of actions) {
          if (act.op === "enablePlanMSI") {
            // Optional: only if your client exposes it; otherwise use generic update
            await clients.appServicePlans.enableSystemAssignedIdentity?.(a.resourceGroupName, a.name);
          } else if (act.op === "setPlanFtpsState") {
            await clients.appServicePlans.update?.(a.resourceGroupName, a.name, { ftpsState: act.value });
          } else if (act.op === "enableDiagnosticsToLAW") {
            await clients.monitor?.diagnosticSettings?.createOrUpdate?.(plan.id, "appplan-baseline", {
              workspaceId: act.workspaceId,
              logs: [{ category: "AppServicePlatformLogs", enabled: true }],
              metrics: [{ category: "AllMetrics", enabled: true }],
            });
          }
        }

        return { content: [{ type: "json", json: { status: "done", actionsApplied: actions } }] };
      } catch (e: any) {
        return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
      }
    }
  };

  return [update_web_app_config, remediate_webapp_baseline, remediate_appplan_baseline];
}