// servers/platform-mcp/src/tools.scan.ts
import type { ToolDef } from "mcp-http";
import { z } from "zod";
import { mcpJson, mcpText } from "./lib/runtime.js";
import { getPolicyDoc } from "@platform/governance-core";

type CallFn = (name: string, args: any) => Promise<any>;

// Pull the first JSON block out of a tool result
function firstJsonBlock(r: any) {
  if (Array.isArray(r?.content)) {
    for (const c of r.content) {
      if (c?.type === "json" && c?.json != null) return c.json;
    }
  }
  return r?.json ?? r;
}

function selectAtoProfile(doc: any) {
  const profileFromEnv = process.env.ATO_PROFILE?.trim();
  const defaultFromYaml = doc?.ato?.defaultProfile;
  const profileName = profileFromEnv || defaultFromYaml || "default";
  const profile = doc?.ato?.profiles?.[profileName] ?? {};
  return { profileName, profile };
}

function getChecksFor(kind: "subscription" | "resourceGroup" | "webapp", doc: any) {
  // Prefer profile overrides, fall back to global checks area
  const { profile } = selectAtoProfile(doc);
  const fromProfile =
    profile?.checks?.[kind] ||
    profile?.[kind]?.checks;
  const globalChecks =
    doc?.ato?.checks?.[kind] ||
    doc?.ato?.[kind]?.checks;

  // Normalize to a dictionary keyed by code
  const checksArray: any[] =
    Array.isArray(fromProfile) ? fromProfile :
    Array.isArray(globalChecks) ? globalChecks : [];

  const byCode: Record<string, any> = {};
  for (const c of checksArray) {
    if (!c?.code) continue;
    byCode[c.code] = {
      code: c.code,
      title: c.title,
      severity: c.severity,
      controls: c.controls,          // e.g., ["AC-3","SC-7"]
      recommendation: c.recommendation,
      fix: c.fix                     // optional mapping hint
    };
  }
  return byCode;
}

function enrichFindings(findings: any[], checksByCode: Record<string, any>) {
  return (findings ?? []).map((f) => {
    const spec = checksByCode[f?.code] || {};
    return {
      ...f,
      title: f?.title || spec?.title,
      severity: f?.severity || spec?.severity,
      controls: spec?.controls,
      recommendation: f?.recommendation || spec?.recommendation
    };
  });
}

function summarize(findings: any[]) {
  const counts: Record<string, number> = {};
  for (const f of findings ?? []) {
    const sev = (f?.severity || "unknown").toLowerCase();
    counts[sev] = (counts[sev] ?? 0) + 1;
  }
  const total = (findings ?? []).length;
  return { total, bySeverity: counts };
}

function textSummary(kind: string, profileName: string, summary: any) {
  const sev = summary.bySeverity;
  const parts = [
    `### ATO scan (${kind}) — profile: **${profileName}**`,
    `Findings: **${summary.total}**`,
    `- high: ${sev.high ?? 0}`,
    `- medium: ${sev.medium ?? 0}`,
    `- low: ${sev.low ?? 0}`,
    `- info: ${sev.info ?? 0}`
  ];
  return parts.join("\n");
}

/**
 * These forward to underlying azure.* scan tools,
 * then enrich with ATO metadata (NIST controls, severity, recommendations)
 * loaded from governance-core YAML.
 */
export function makeScanTools(call: CallFn): ToolDef[] {
  const scan_ato_rg: ToolDef = {
    name: "platform.scan_ato_rg",
    description: "Run ATO baseline checks for a Resource Group (enriched with NIST mappings).",
    inputSchema: z.object({
      resourceGroupName: z.string()
    }).strict(),
    handler: async (a: any) => {
      const doc = getPolicyDoc();
      const { profileName } = selectAtoProfile(doc);
      const checksByCode = getChecksFor("resourceGroup", doc);

      // Call the underlying Azure scan
      const res = await call("azure.scan_ato_rg", { resourceGroupName: a.resourceGroupName });
      const rj = firstJsonBlock(res);

      // Expect azure.scan_ato_rg to return { findings: [...] } or an array
      const rawFindings = Array.isArray(rj) ? rj : (rj?.findings ?? []);
      const findings = enrichFindings(rawFindings, checksByCode);
      const summary = summarize(findings);

      if (res?.isError) {
        return { content: [...mcpJson({ status: "error", profile: profileName, findings, summary })], isError: true };
      }

      return {
        content: [
          ...mcpJson({ status: "done", profile: profileName, findings, summary }),
          ...mcpText(textSummary("resource group", profileName, summary))
        ]
      };
    }
  };

  const scan_ato_subscription: ToolDef = {
    name: "platform.scan_ato_subscription",
    description: "Run ATO baseline checks for the current subscription (or provided subscriptionId).",
    inputSchema: z.object({
      subscriptionId: z.string().optional()
    }).strict(),
    handler: async (a: any) => {
      const doc = getPolicyDoc();
      const { profileName } = selectAtoProfile(doc);
      const checksByCode = getChecksFor("subscription", doc);

      const res = await call("azure.scan_ato_subscription", { subscriptionId: a.subscriptionId });
      const rj = firstJsonBlock(res);
      const rawFindings = Array.isArray(rj) ? rj : (rj?.findings ?? []);
      const findings = enrichFindings(rawFindings, checksByCode);
      const summary = summarize(findings);

      if (res?.isError) {
        return { content: [...mcpJson({ status: "error", profile: profileName, findings, summary })], isError: true };
      }

      return {
        content: [
          ...mcpJson({ status: "done", profile: profileName, findings, summary }),
          ...mcpText(textSummary("subscription", profileName, summary))
        ]
      };
    }
  };

  const scan_webapp_baseline: ToolDef = {
    name: "platform.scan_webapp_baseline",
    description: "Scan a Web App for baseline misconfigurations (TLS, HTTPS-only, FTPS, identity, diagnostics) with ATO enrichment.",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      name: z.string()
    }).strict(),
    handler: async (a: any) => {
      const doc = getPolicyDoc();
      const { profileName } = selectAtoProfile(doc);
      const checksByCode = getChecksFor("webapp", doc);

      const res = await call("azure.scan_webapp_baseline", { resourceGroupName: a.resourceGroupName, name: a.name });
      const rj = firstJsonBlock(res);
      const rawFindings = Array.isArray(rj) ? rj : (rj?.findings ?? []);
      const findings = enrichFindings(rawFindings, checksByCode);
      const summary = summarize(findings);

      if (res?.isError) {
        return { content: [...mcpJson({ status: "error", profile: profileName, findings, summary })], isError: true };
      }

      return {
        content: [
          ...mcpJson({ status: "done", profile: profileName, findings, summary }),
          ...mcpText(textSummary("web app", profileName, summary))
        ]
      };
    }
  };

  return [scan_ato_rg, scan_ato_subscription, scan_webapp_baseline];
}
