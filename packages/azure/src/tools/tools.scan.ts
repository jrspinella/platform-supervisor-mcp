// packages/azure-core/src/tools.scan.ts — ATO lookup via governance-core (robust profile + aliases)
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import type { MakeAzureToolsOptions } from "../types.js";
import { normalizeAzureError, scanSummary, formatTextSummary, filterFindings } from "../utils.js";

const sevIcon: Record<string, string> = {
  high: "🔴", medium: "🟠", low: "🟡", info: "🔵", unknown: "⚪️",
};

function renderWebappReport(a: any, findings: any[], summary: any) {
  const counts = Object.entries(summary?.bySeverity ?? {})
    .map(([s, n]) => `${sevIcon[String(s).toLowerCase()] ?? "⚪️"} ${n} ${s}`)
    .join(" · ");
  const rows = (findings ?? []).map((f: any) => {
    const sev = String(f.severity ?? "unknown").toLowerCase();
    const controls = Array.isArray(f.controlIds) ? f.controlIds.join(", ") : "—";
    const suggest = f.suggest || "—";
    return `| \`${f.code}\` | ${sevIcon[sev] ?? "⚪️"} ${sev} | ${controls} | ${suggest} |`;
  }).join("\n") || "| — | — | — | — |";

  return [
    `### Web App Baseline — \`${a.resourceGroupName}/${a.name}\` (profile: \`${a.profile}\`)`,
    "",
    `**Findings:** ${summary?.total ?? 0}${counts ? ` — ${counts}` : ""}`,
    "",
    `| Code | Severity | Controls | Suggestion |`,
    `|---|---|---|---|`,
    rows,
    "",
    `<details><summary>Quick actions</summary>`,
    "",
    "```bash",
    `@platform remediate_webapp_baseline {"resourceGroupName":"${a.resourceGroupName}","name":"${a.name}","dryRun":true}`,
    "```",
    "",
    "Apply with Log Analytics Workspace:",
    "```bash",
    `@platform remediate_webapp_baseline {"resourceGroupName":"${a.resourceGroupName}","name":"${a.name}","defaults":{"lawResourceId":"<LAW Resource ID>"},"dryRun":false}`,
    "```",
    "",
    "</details>",
  ].join("\n");
}

export function makeAzureScanTools(opts: MakeAzureToolsOptions & { namespace?: string }) {
  const { clients, namespace = "azure.", getAtoRule, getAtoProfile, hasAtoProfile } = opts;
  const n = (s: string) => `${namespace}${s}`;

  // Lazy ATO accessors (fallback to governance-core singletons)
  let _getAtoRule = getAtoRule;
  let _getAtoProfile = getAtoProfile;
  let _hasAtoProfile = hasAtoProfile;
  async function ensureAto() {
    if (!_getAtoRule || !_getAtoProfile || !_hasAtoProfile) {
      const gc = await import("@platform/governance-core");
      _getAtoRule = _getAtoRule || gc.getAtoRule;
      _getAtoProfile = _getAtoProfile || gc.getAtoProfile;
      _hasAtoProfile = _hasAtoProfile || gc.hasAtoProfile;
    }
  }

  // Domain alias map (accept common variants from YAML and code)
  const DOMAIN_ALIASES: Record<string, string[]> = {
    webapp: ["webapp", "web_app", "app"],
    appPlan: ["appPlan", "app_service_plan", "asp", "plan"],
    network: ["network", "vnet", "virtualNetwork", "virtual_network"],
    keyVault: ["keyVault", "key_vault", "kv"],
    storageAccount: ["storageAccount", "storage_account", "sa"],
    logAnalytics: ["logAnalytics", "log_analytics", "logAnalyticsWorkspace", "law", "workspace"],
    resourceGroup: ["resourceGroup", "resource_group", "rg"],
  };

  // Optional rule presence check (for diagnostics only)
  function resolveRulesFromProfile(profileObj: any, domain: keyof typeof DOMAIN_ALIASES) {
    if (!profileObj || typeof profileObj !== "object") return undefined;
    for (const k of DOMAIN_ALIASES[domain]) {
      const r = profileObj?.[k]?.rules;
      if (r && typeof r === "object") return r;
    }
    return undefined;
  }

  // Robust getter: try domain aliases until a mapping is found
  function getRuleMap(domain: keyof typeof DOMAIN_ALIASES, profile: string, code: string) {
    const keys = DOMAIN_ALIASES[domain] ?? [domain];
    for (const d of keys) {
      const map = _getAtoRule?.(d, profile, code);
      if (map) return map;
    }
    return {};
  }

  // ────────────────────────────────────────────────────────────
  // App Service Plan baseline
  // ────────────────────────────────────────────────────────────
  const scan_appplan_baseline: ToolDef = {
    name: n("scan_appplan_baseline"),
    description:
      "Scan an App Service Plan for baseline misconfigurations (SKU, HTTPS-only, FTPS, MSI, diagnostics) and enrich with ATO controls & suggestions.",
    inputSchema: z
      .object({ resourceGroupName: z.string(), name: z.string(), profile: z.string().default("default") })
      .strict(),
    handler: async (a) => {
      try {
        await ensureAto();
        const profile = a.profile || process.env.ATO_PROFILE || "default";
        const prof = _getAtoProfile?.(profile);
        // Optional: will be undefined if YAML uses a different alias or is missing; we don't fail hard.
        const _rules = resolveRulesFromProfile(prof, "appPlan");

        const plan = await clients.appServicePlans.get(a.resourceGroupName, a.name);
        const props = (plan as any)?.properties || {};
        const sku = String((plan as any)?.sku?.name || "").toLowerCase();
        const httpsOnly = !!(props.httpsOnly ?? false);
        const ftpsState = String(props.ftpsState ?? "AllAllowed");
        const identity = (plan as any)?.identity;

        let hasLaw = false;
        try {
          const list = await clients.monitor?.diagnosticSettings?.list?.((plan as any)?.id!);
          hasLaw = Array.isArray(list) && list.some((d) => d?.workspaceId);
        } catch { }

        const findings: any[] = [];
        if (sku === "free" || sku === "shared")
          findings.push({
            code: "APPPLAN_SKU_TOO_LOW",
            severity: "high",
            meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.name, sku },
          });
        if (!httpsOnly)
          findings.push({
            code: "APPPLAN_HTTPS_ONLY_DISABLED",
            severity: "high",
            meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.name },
          });
        if (ftpsState !== "Disabled")
          findings.push({
            code: "APPPLAN_FTPS_NOT_DISABLED",
            severity: "medium",
            meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.name, ftpsState },
          });
        if (!identity || identity.type !== "SystemAssigned")
          findings.push({
            code: "APPPLAN_MSI_DISABLED",
            severity: "medium",
            meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.name },
          });
        if (!hasLaw)
          findings.push({
            code: "APPPLAN_DIAG_NO_LAW",
            severity: "medium",
            meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.name },
          });

        const enriched = findings.map((f) => {
          const map = getRuleMap("appPlan", profile, f.code);
          return { ...f, controlIds: map.controlIds || [], suggest: map.suggest || undefined };
        });
        const summary = scanSummary(enriched);

        const md = renderWebappReport(a, enriched, summary);
        return {
          content: [
            // put text (markdown) FIRST so Copilot shows it nicely
            { type: "text" as const, text: md },
            { type: "json" as const, json: { status: "done", profile: a.profile, findings: enriched, summary } },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
      }
    },
  };

  // ────────────────────────────────────────────────────────────
  // Web App baseline
  // ────────────────────────────────────────────────────────────
  const scan_webapp_baseline: ToolDef = {
    name: n("scan_webapp_baseline"),
    description:
      "Scan a Web App for baseline misconfigurations (TLS, HTTPS-only, FTPS, MSI, diagnostics) and enrich with ATO controls & suggestions.",
    inputSchema: z
      .object({ resourceGroupName: z.string(), name: z.string(), profile: z.string().default("default") })
      .strict(),
    handler: async (a) => {
      try {
        await ensureAto();
        const profile = a.profile || process.env.ATO_PROFILE || "default";
        const prof = _getAtoProfile?.(profile);
        const _rules = resolveRulesFromProfile(prof, "webapp");

        const site: any = await clients.webApps.get(a.resourceGroupName, a.name);
        const cfg: any =
          typeof clients.webApps.getConfiguration === "function"
            ? await clients.webApps.getConfiguration(a.resourceGroupName, a.name)
            : {};
        const props = site?.properties || {};
        const tls = String(props.minimumTlsVersion ?? cfg?.minTlsVersion ?? "1.0");
        const httpsOnly = !!(props.httpsOnly ?? cfg?.httpsOnly ?? false);
        const ftpsState = String(props.ftpsState ?? cfg?.ftpsState ?? "AllAllowed");
        const identity = site?.identity;

        let hasLaw = false;
        try {
          const list = await clients.monitor?.diagnosticSettings?.list?.(site?.id!);
          hasLaw = Array.isArray(list) && list.some((d) => d?.workspaceId);
        } catch { }

        const findings: any[] = [];
        if (tls < "1.2")
          findings.push({
            code: "APP_TLS_MIN_BELOW_1_2",
            severity: "high",
            meta: { resourceGroupName: a.resourceGroupName, webAppName: a.name, tls },
          });
        if (!httpsOnly)
          findings.push({
            code: "APP_HTTPS_ONLY_DISABLED",
            severity: "high",
            meta: { resourceGroupName: a.resourceGroupName, webAppName: a.name },
          });
        if (ftpsState !== "Disabled")
          findings.push({
            code: "APP_FTPS_NOT_DISABLED",
            severity: "medium",
            meta: { resourceGroupName: a.resourceGroupName, webAppName: a.name, ftpsState },
          });
        if (!identity || identity.type !== "SystemAssigned")
          findings.push({
            code: "APP_MSI_DISABLED",
            severity: "medium",
            meta: { resourceGroupName: a.resourceGroupName, webAppName: a.name },
          });
        if (!hasLaw)
          findings.push({
            code: "APP_DIAG_NO_LAW",
            severity: "medium",
            meta: { resourceGroupName: a.resourceGroupName, webAppName: a.name },
          });

        const enriched = findings.map((f) => {
          const map = getRuleMap("webapp", profile, f.code);
          return { ...f, controlIds: map.controlIds || [], suggest: map.suggest || undefined };
        });
        const summary = scanSummary(enriched);
        const md = renderWebappReport(a, enriched, summary);
        return {
          content: [
            // put text (markdown) FIRST so Copilot shows it nicely
            { type: "text" as const, text: md },
            { type: "json" as const, json: { status: "done", profile: a.profile, findings: enriched, summary } },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
      }
    },
  };

  // ────────────────────────────────────────────────────────────
  // Network baseline
  // ────────────────────────────────────────────────────────────
  const scan_network_baseline: ToolDef = {
    name: n("scan_network_baseline"),
    description: "Scan a Virtual Network and subnets for baseline network ATO posture (DDOS, PE policies, diagnostics).",
    inputSchema: z.object({ resourceGroupName: z.string(), vnetName: z.string(), profile: z.string().default("default") }).strict(),
    handler: async (a) => {
      try {
        await ensureAto();
        const profile = a.profile || process.env.ATO_PROFILE || "default";
        const vnet = await clients.networks.getVnet(a.resourceGroupName, a.vnetName);
        const findings: any[] = [];
        const ddosEnabled = Boolean((vnet as any)?.enableDdosProtection || (vnet as any)?.ddosProtectionPlan?.id);
        if (!ddosEnabled)
          findings.push({
            code: "NET_DDOS_DISABLED",
            severity: "low",
            meta: { resourceGroupName: a.resourceGroupName, vnetName: a.vnetName },
          });
        const subnets: any[] = Array.isArray((vnet as any)?.subnets) ? (vnet as any).subnets : [];
        for (const s of subnets) {
          const penp = String(s?.privateEndpointNetworkPolicies ?? "Enabled");
          if (penp !== "Disabled")
            findings.push({ code: "SUBNET_PENP_NOT_DISABLED", severity: "medium", meta: { subnetName: s?.name } });
        }
        const enriched = findings.map((f) => {
          const map = getRuleMap("network", profile, f.code);
          return { ...f, controlIds: map.controlIds || [], suggest: map.suggest || undefined };
        });
        const summary = scanSummary(enriched);
        return {
          content: [
            {
              type: "json" as const,
              json: {
                status: "done",
                profile,
                findings: enriched,
                summary,
                filters: {
                  minSeverity: a.minSeverity,
                  excludeFindingsByCode: a.excludeFindingsByCode,
                  dropped: (findings?.length ?? 0) - (enriched?.length ?? 0),
                },
              },
            },
            { type: "text" as const, text: formatTextSummary("network", profile, summary) },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
      }
    },
  };

  // ────────────────────────────────────────────────────────────
  // Workload baseline (multi-resource, names provided)
  // ────────────────────────────────────────────────────────────
  const scan_workload_baseline: ToolDef = {
    name: n("scan_workload_baseline"),
    description:
      "Scan a workload (set of resources) for baseline misconfigurations and enrich with ATO controls & suggestions. Supports: App Service Plan, Web App, Key Vault, Storage Account, Log Analytics, VNet.",
    inputSchema: z
      .object({
        resourceGroupName: z.string(),
        appServicePlanName: z.string().optional(),
        webAppName: z.string().optional(),
        keyVaultName: z.string().optional(),
        storageAccountName: z.string().optional(),
        logAnalyticsName: z.string().optional(),
        vnetName: z.string().optional(),
        profile: z.string().default("default"),
        tolerateMissing: z.boolean().default(true),
        excludeFindingsByCode: z.array(z.string()).optional(),
        minSeverity: z.enum(["info", "low", "medium", "high"]).optional(),
      })
      .strict()
      .refine(
        (o) =>
          !!(
            o.appServicePlanName ||
            o.webAppName ||
            o.keyVaultName ||
            o.storageAccountName ||
            o.logAnalyticsName ||
            o.vnetName
          ),
        { message: "At least one resource name must be provided" }
      ),
    handler: async (a) => {
      try {
        await ensureAto();
        const profile = a.profile || process.env.ATO_PROFILE || "default";
        const findings: any[] = [];
        const push = (domain: keyof typeof DOMAIN_ALIASES, f: any) => {
          const map = getRuleMap(domain, profile, f.code) || {};
          findings.push({ ...f, controlIds: map.controlIds || [], suggest: map.suggest || undefined });
        };
        const shouldContinue = (e: any) => {
          const n = normalizeAzureError(e);
          return a.tolerateMissing && n?.error?.statusCode === 404;
        };

        // App Service Plan
        if (a.appServicePlanName) {
          try {
            const plan: any = await clients.appServicePlans.get(a.resourceGroupName, a.appServicePlanName);
            const props = plan?.properties || {};
            const sku = String(plan?.sku?.name || "").toLowerCase();
            const httpsOnly = !!(props.httpsOnly ?? false);
            const ftpsState = String(props.ftpsState ?? "AllAllowed");
            const identity = plan?.identity;
            let hasLaw = false;
            try {
              const list = await clients.monitor?.diagnosticSettings?.list?.(plan?.id!);
              hasLaw = Array.isArray(list) && list.some((d) => d?.workspaceId);
            } catch { }
            if (sku === "free" || sku === "shared")
              push("appPlan", {
                code: "APPPLAN_SKU_TOO_LOW",
                severity: "high",
                meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.appServicePlanName, sku },
              });
            if (!httpsOnly)
              push("appPlan", {
                code: "APPPLAN_HTTPS_ONLY_DISABLED",
                severity: "high",
                meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.appServicePlanName },
              });
            if (ftpsState !== "Disabled")
              push("appPlan", {
                code: "APPPLAN_FTPS_NOT_DISABLED",
                severity: "medium",
                meta: {
                  resourceGroupName: a.resourceGroupName,
                  appServicePlanName: a.appServicePlanName,
                  ftpsState,
                },
              });
            if (!identity || identity.type !== "SystemAssigned")
              push("appPlan", {
                code: "APPPLAN_MSI_DISABLED",
                severity: "medium",
                meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.appServicePlanName },
              });
            if (!hasLaw)
              push("appPlan", {
                code: "APPPLAN_DIAG_NO_LAW",
                severity: "medium",
                meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.appServicePlanName },
              });
          } catch (e) {
            if (shouldContinue(e)) {
              push("appPlan", {
                code: "APPPLAN_MISSING",
                severity: "high",
                meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: a.appServicePlanName },
              });
            } else {
              return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
            }
          }
        }

        // Web App
        if (a.webAppName) {
          try {
            const site: any = await clients.webApps.get(a.resourceGroupName, a.webAppName);
            const cfg: any =
              typeof clients.webApps.getConfiguration === "function"
                ? await clients.webApps.getConfiguration(a.resourceGroupName, a.webAppName)
                : {};
            const props = site?.properties || {};
            const tls = String(props.minimumTlsVersion ?? cfg?.minTlsVersion ?? "1.0");
            const httpsOnly = !!(props.httpsOnly ?? cfg?.httpsOnly ?? false);
            const ftpsState = String(props.ftpsState ?? cfg?.ftpsState ?? "AllAllowed");
            const identity = site?.identity;
            let hasLaw = false;
            try {
              const list = await clients.monitor?.diagnosticSettings?.list?.(site?.id!);
              hasLaw = Array.isArray(list) && list.some((d) => d?.workspaceId);
            } catch { }
            if (tls < "1.2")
              push("webapp", {
                code: "APP_TLS_MIN_BELOW_1_2",
                severity: "high",
                meta: { resourceGroupName: a.resourceGroupName, webAppName: a.webAppName, tls },
              });
            if (!httpsOnly)
              push("webapp", {
                code: "APP_HTTPS_ONLY_DISABLED",
                severity: "high",
                meta: { resourceGroupName: a.resourceGroupName, webAppName: a.webAppName },
              });
            if (ftpsState !== "Disabled")
              push("webapp", {
                code: "APP_FTPS_NOT_DISABLED",
                severity: "medium",
                meta: { resourceGroupName: a.resourceGroupName, webAppName: a.webAppName, ftpsState },
              });
            if (!identity || identity.type !== "SystemAssigned")
              push("webapp", {
                code: "APP_MSI_DISABLED",
                severity: "medium",
                meta: { resourceGroupName: a.resourceGroupName, webAppName: a.webAppName },
              });
            if (!hasLaw)
              push("webapp", {
                code: "APP_DIAG_NO_LAW",
                severity: "medium",
                meta: { resourceGroupName: a.resourceGroupName, webAppName: a.webAppName },
              });
          } catch (e) {
            if (shouldContinue(e)) {
              push("webapp", {
                code: "APP_MISSING",
                severity: "high",
                meta: { resourceGroupName: a.resourceGroupName, webAppName: a.webAppName },
              });
            } else {
              return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
            }
          }
        }

        // Key Vault
        if (a.keyVaultName) {
          try {
            const v: any = await clients.keyVaults.get(a.resourceGroupName, a.keyVaultName);
            const p = v?.properties || {};
            if (p.enableRbacAuthorization !== true)
              push("keyVault", { code: "KV_RBAC_NOT_ENABLED", severity: "medium", meta: { keyVaultName: a.keyVaultName } });
            if (p.publicNetworkAccess === "Enabled")
              push("keyVault", {
                code: "KV_PUBLIC_NETWORK_ENABLED",
                severity: "high",
                meta: { keyVaultName: a.keyVaultName },
              });
            if (p.enablePurgeProtection !== true)
              push("keyVault", {
                code: "KV_PURGE_PROTECTION_DISABLED",
                severity: "high",
                meta: { keyVaultName: a.keyVaultName },
              });
            if (p.enableSoftDelete === false)
              push("keyVault", {
                code: "KV_SOFT_DELETE_DISABLED",
                severity: "medium",
                meta: { keyVaultName: a.keyVaultName },
              });
          } catch (e) {
            if (shouldContinue(e)) {
              push("keyVault", { code: "KV_MISSING", severity: "high", meta: { keyVaultName: a.keyVaultName } });
            } else {
              return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
            }
          }
        }

        // Storage Account
        if (a.storageAccountName) {
          try {
            const sa: any = await clients.storageAccounts.get(a.resourceGroupName, a.storageAccountName);
            const props = (sa as any)?.properties ?? sa;
            const httpsOnly = props?.supportsHttpsTrafficOnly;
            const minTls = (props?.minimumTlsVersion || props?.minimumTlsVersion?.toString?.()) as any;
            const allowBlobPublicAccess = props?.allowBlobPublicAccess === true;
            if (!httpsOnly)
              push("storageAccount", {
                code: "STG_HTTPS_ONLY_DISABLED",
                severity: "high",
                meta: { storageAccountName: a.storageAccountName },
              });
            if (typeof minTls === "string" && minTls < "TLS1_2")
              push("storageAccount", {
                code: "STG_MIN_TLS_BELOW_1_2",
                severity: "high",
                meta: { storageAccountName: a.storageAccountName, minTls },
              });
            if (allowBlobPublicAccess)
              push("storageAccount", {
                code: "STG_BLOB_PUBLIC_ACCESS_ENABLED",
                severity: "high",
                meta: { storageAccountName: a.storageAccountName },
              });
          } catch (e) {
            if (shouldContinue(e)) {
              push("storageAccount", { code: "STG_MISSING", severity: "high", meta: { storageAccountName: a.storageAccountName } });
            } else {
              return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
            }
          }
        }

        // Log Analytics Workspace
        if (a.logAnalyticsName) {
          try {
            const w: any = await clients.logAnalytics.get(a.resourceGroupName, a.logAnalyticsName);
            const retention = (w as any)?.retentionInDays ?? (w as any)?.properties?.retentionInDays;
            if (typeof retention === "number" && retention < 30) {
              push("logAnalytics", {
                code: "LAW_RETENTION_TOO_LOW",
                severity: "medium",
                meta: { logAnalyticsName: a.logAnalyticsName, retention },
              });
            }
          } catch (e) {
            if (shouldContinue(e)) {
              push("logAnalytics", { code: "LAW_MISSING", severity: "high", meta: { logAnalyticsName: a.logAnalyticsName } });
            } else {
              return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
            }
          }
        }

        // Network (VNet)
        if (a.vnetName) {
          try {
            const vnet: any = await clients.networks.getVnet(a.resourceGroupName, a.vnetName);
            const ddosEnabled = Boolean(vnet?.enableDdosProtection || vnet?.ddosProtectionPlan?.id);
            if (!ddosEnabled)
              push("network", {
                code: "NET_DDOS_DISABLED",
                severity: "low",
                meta: { resourceGroupName: a.resourceGroupName, vnetName: a.vnetName },
              });
            const subnets: any[] = Array.isArray(vnet?.subnets) ? vnet.subnets : [];
            for (const s of subnets) {
              const penp = String(s?.privateEndpointNetworkPolicies ?? "Enabled");
              if (penp !== "Disabled")
                push("network", { code: "SUBNET_PENP_NOT_DISABLED", severity: "medium", meta: { subnetName: s?.name } });
            }
          } catch (e) {
            if (shouldContinue(e)) {
              push("network", { code: "VNET_MISSING", severity: "high", meta: { vnetName: a.vnetName } });
            } else {
              return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
            }
          }
        }

        const filtered = filterFindings(findings, {
          minSeverity: a.minSeverity,
          excludeCodes: a.excludeFindingsByCode,
        });
        const summary = scanSummary(filtered);
        return {
          content: [
            {
              type: "json" as const,
              json: {
                status: "done",
                profile,
                findings: filtered,
                summary,
                filters: {
                  minSeverity: a.minSeverity,
                  excludeFindingsByCode: a.excludeFindingsByCode,
                  dropped: (findings?.length ?? 0) - (filtered?.length ?? 0),
                },
              },
            },
            { type: "text" as const, text: formatTextSummary("workload", profile, summary) },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
      }
    },
  };

  // ────────────────────────────────────────────────────────────
  // Resource Group baseline (enumerate & scan)
  // ────────────────────────────────────────────────────────────
  const scan_resource_group_baseline: ToolDef = {
    name: n("scan_resource_group_baseline"),
    description: "Enumerate supported resources in a resource group and run baseline scans with ATO enrichment.",
    inputSchema: z
      .object({
        resourceGroupName: z.string(),
        profile: z.string().default("default"),
        include: z
          .array(z.enum(["appServicePlan", "webApp", "keyVault", "storageAccount", "logAnalytics", "vnet"]))
          .optional(),
        exclude: z
          .array(z.enum(["appServicePlan", "webApp", "keyVault", "storageAccount", "logAnalytics", "vnet"]))
          .optional(),
        limitPerType: z.number().int().min(1).max(200).default(100),
        excludeFindingsByCode: z.array(z.string()).optional(),
        minSeverity: z.enum(["info", "low", "medium", "high"]).optional(),
      })
      .strict(),
    handler: async (a) => {
      try {
        await ensureAto();
        const profile = a.profile || process.env.ATO_PROFILE || "default";
        const kinds = ["appServicePlan", "webApp", "keyVault", "storageAccount", "logAnalytics", "vnet"] as const;
        const inc = new Set<string>((a.include && a.include.length ? a.include : kinds) as string[]);
        for (const x of a.exclude || []) inc.delete(x);

        const findings: any[] = [];
        const push = (domain: keyof typeof DOMAIN_ALIASES, f: any) => {
          const map = getRuleMap(domain, profile, f.code);
          findings.push({ ...f, controlIds: map.controlIds || [], suggest: map.suggest || undefined });
        };

        const list = async (fn: (() => Promise<any[]>) | undefined) => {
          try {
            return (await fn?.()) ?? [];
          } catch {
            return [];
          }
        };

        // App Service Plans
        if (inc.has("appServicePlan")) {
          const items = (await list(() => clients.appServicePlans.listByResourceGroup?.(a.resourceGroupName) ?? Promise.resolve([]))).slice(0, a.limitPerType);
          for (const it of items) {
            try {
              const name = it?.name as string;
              const plan = await clients.appServicePlans.get(a.resourceGroupName, name);
              const props = (plan as any)?.properties || {};
              const sku = String((plan as any)?.sku?.name || "").toLowerCase();
              const httpsOnly = !!(props.httpsOnly ?? false);
              const ftpsState = String(props.ftpsState ?? "AllAllowed");
              const identity = (plan as any)?.identity;
              let hasLaw = false;
              try {
                const list = await clients.monitor?.diagnosticSettings?.list?.((plan as any)?.id!);
                hasLaw = Array.isArray(list) && list.some((d) => d?.workspaceId);
              } catch { }
              if (sku === "free" || sku === "shared")
                push("appPlan", {
                  code: "APPPLAN_SKU_TOO_LOW",
                  severity: "high",
                  meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: name, sku },
                });
              if (!httpsOnly)
                push("appPlan", {
                  code: "APPPLAN_HTTPS_ONLY_DISABLED",
                  severity: "high",
                  meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: name },
                });
              if (ftpsState !== "Disabled")
                push("appPlan", {
                  code: "APPPLAN_FTPS_NOT_DISABLED",
                  severity: "medium",
                  meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: name, ftpsState },
                });
              if (!identity || identity.type !== "SystemAssigned")
                push("appPlan", {
                  code: "APPPLAN_MSI_DISABLED",
                  severity: "medium",
                  meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: name },
                });
              if (!hasLaw)
                push("appPlan", {
                  code: "APPPLAN_DIAG_NO_LAW",
                  severity: "medium",
                  meta: { resourceGroupName: a.resourceGroupName, appServicePlanName: name },
                });
            } catch {
              /* continue */
            }
          }
        }

        // Web Apps
        if (inc.has("webApp")) {
          const items = (await list(() => clients.webApps.listByResourceGroup?.(a.resourceGroupName) ?? Promise.resolve([]))).slice(0, a.limitPerType);
          for (const it of items) {
            try {
              const name = it?.name as string;
              const site: any = await clients.webApps.get(a.resourceGroupName, name);
              const cfg: any =
                typeof clients.webApps.getConfiguration === "function"
                  ? await clients.webApps.getConfiguration(a.resourceGroupName, name)
                  : {};
              const props = site?.properties || {};
              const tls = String(props.minimumTlsVersion ?? cfg?.minTlsVersion ?? "1.0");
              const httpsOnly = !!(props.httpsOnly ?? cfg?.httpsOnly ?? false);
              const ftpsState = String(props.ftpsState ?? cfg?.ftpsState ?? "AllAllowed");
              const identity = site?.identity;
              let hasLaw = false;
              try {
                const list = await clients.monitor?.diagnosticSettings?.list?.(site?.id!);
                hasLaw = Array.isArray(list) && list.some((d) => d?.workspaceId);
              } catch { }
              if (tls < "1.2")
                push("webapp", {
                  code: "APP_TLS_MIN_BELOW_1_2",
                  severity: "high",
                  meta: { resourceGroupName: a.resourceGroupName, webAppName: name, tls },
                });
              if (!httpsOnly)
                push("webapp", {
                  code: "APP_HTTPS_ONLY_DISABLED",
                  severity: "high",
                  meta: { resourceGroupName: a.resourceGroupName, webAppName: name },
                });
              if (ftpsState !== "Disabled")
                push("webapp", {
                  code: "APP_FTPS_NOT_DISABLED",
                  severity: "medium",
                  meta: { resourceGroupName: a.resourceGroupName, webAppName: name, ftpsState },
                });
              if (!identity || identity.type !== "SystemAssigned")
                push("webapp", {
                  code: "APP_MSI_DISABLED",
                  severity: "medium",
                  meta: { resourceGroupName: a.resourceGroupName, webAppName: name },
                });
              if (!hasLaw)
                push("webapp", {
                  code: "APP_DIAG_NO_LAW",
                  severity: "medium",
                  meta: { resourceGroupName: a.resourceGroupName, webAppName: name },
                });
            } catch {
              /* continue */
            }
          }
        }

        // Key Vaults
        if (inc.has("keyVault")) {
          const items = (await list(() => clients.keyVaults.listByResourceGroup?.(a.resourceGroupName) ?? Promise.resolve([]))).slice(0, a.limitPerType);
          for (const it of items) {
            try {
              const name = it?.name as string;
              const v: any = await clients.keyVaults.get(a.resourceGroupName, name);
              const p = v?.properties || {};
              if (p.enableRbacAuthorization !== true)
                push("keyVault", { code: "KV_RBAC_NOT_ENABLED", severity: "medium", meta: { keyVaultName: name } });
              if (p.publicNetworkAccess === "Enabled")
                push("keyVault", { code: "KV_PUBLIC_NETWORK_ENABLED", severity: "high", meta: { keyVaultName: name } });
              if (p.enablePurgeProtection !== true)
                push("keyVault", {
                  code: "KV_PURGE_PROTECTION_DISABLED",
                  severity: "high",
                  meta: { keyVaultName: name },
                });
              if (p.enableSoftDelete === false)
                push("keyVault", {
                  code: "KV_SOFT_DELETE_DISABLED",
                  severity: "medium",
                  meta: { keyVaultName: name },
                });
            } catch {
              /* continue */
            }
          }
        }

        // Storage Accounts
        if (inc.has("storageAccount")) {
          const items = (await list(() => clients.storageAccounts.listByResourceGroup?.(a.resourceGroupName) ?? Promise.resolve([]))).slice(0, a.limitPerType);
          for (const it of items) {
            try {
              const name = it?.name as string;
              const sa: any = await clients.storageAccounts.get(a.resourceGroupName, name);
              const props = (sa as any)?.properties ?? sa;
              const httpsOnly = props?.supportsHttpsTrafficOnly;
              const minTls = (props?.minimumTlsVersion || props?.minimumTlsVersion?.toString?.()) as any;
              const allowBlobPublicAccess = props?.allowBlobPublicAccess === true;
              if (!httpsOnly)
                push("storageAccount", {
                  code: "STG_HTTPS_ONLY_DISABLED",
                  severity: "high",
                  meta: { storageAccountName: name },
                });
              if (typeof minTls === "string" && minTls < "TLS1_2")
                push("storageAccount", {
                  code: "STG_MIN_TLS_BELOW_1_2",
                  severity: "high",
                  meta: { storageAccountName: name, minTls },
                });
              if (allowBlobPublicAccess)
                push("storageAccount", {
                  code: "STG_BLOB_PUBLIC_ACCESS_ENABLED",
                  severity: "high",
                  meta: { storageAccountName: name },
                });
            } catch {
              /* continue */
            }
          }
        }

        // Log Analytics
        if (inc.has("logAnalytics")) {
          const items = (await list(() => clients.logAnalytics.listByResourceGroup?.(a.resourceGroupName) ?? Promise.resolve([]))).slice(0, a.limitPerType);
          for (const it of items) {
            try {
              const name = it?.name as string;
              const w: any = await clients.logAnalytics.get(a.resourceGroupName, name);
              const retention = (w as any)?.retentionInDays ?? (w as any)?.properties?.retentionInDays;
              if (typeof retention === "number" && retention < 30)
                push("logAnalytics", {
                  code: "LAW_RETENTION_TOO_LOW",
                  severity: "medium",
                  meta: { logAnalyticsName: name, retention },
                });
            } catch {
              /* continue */
            }
          }
        }

        // VNets
        if (inc.has("vnet")) {
          const items = (await list(() => clients.networks.listVnetsByResourceGroup?.(a.resourceGroupName) ?? Promise.resolve([]))).slice(0, a.limitPerType);
          for (const it of items) {
            try {
              const name = it?.name as string;
              const vnet: any = await clients.networks.getVnet(a.resourceGroupName, name);
              const ddosEnabled = Boolean(vnet?.enableDdosProtection || vnet?.ddosProtectionPlan?.id);
              if (!ddosEnabled)
                push("network", {
                  code: "NET_DDOS_DISABLED",
                  severity: "low",
                  meta: { resourceGroupName: a.resourceGroupName, vnetName: name },
                });
              const subnets: any[] = Array.isArray(vnet?.subnets) ? vnet.subnets : [];
              for (const s of subnets) {
                const penp = String(s?.privateEndpointNetworkPolicies ?? "Enabled");
                if (penp !== "Disabled")
                  push("network", {
                    code: "SUBNET_PENP_NOT_DISABLED",
                    severity: "medium",
                    meta: { subnetName: s?.name, vnetName: name },
                  });
              }
            } catch {
              /* continue */
            }
          }
        }

        const filtered = filterFindings(findings, {
          minSeverity: a.minSeverity,
          excludeCodes: a.excludeFindingsByCode,
        });
        const summary = scanSummary(filtered);
        return {
          content: [
            {
              type: "json" as const,
              json: {
                status: "done",
                scope: { resourceGroupName: a.resourceGroupName },
                profile,
                findings: filtered,
                summary,
                filters: {
                  minSeverity: a.minSeverity,
                  excludeFindingsByCode: a.excludeFindingsByCode,
                  dropped: (findings?.length ?? 0) - (filtered?.length ?? 0),
                },
              },
            },
            { type: "text" as const, text: formatTextSummary("resource group", profile, summary) },
          ],
        };
      } catch (e: any) {
        return { content: [{ type: "json" as const, json: normalizeAzureError(e) }], isError: true as const };
      }
    },
  };

  return [scan_webapp_baseline, scan_appplan_baseline, scan_network_baseline, scan_workload_baseline, scan_resource_group_baseline];
}