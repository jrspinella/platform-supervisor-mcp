// packages/azure-core/src/presenters/policy-drift.ts
import { mcpText, mcpJson } from "../utils.js";

export type McpContent = { type: "text"; text: string } | { type: "json"; json: any };

export interface Finding {
  code: string;
  severity?: string;               // high|medium|low|info|unknown
  controlIds?: string[];
  suggest?: string;
  meta?: Record<string, any>;      // includes resource identifiers (webAppName, appServicePlanName, etc.)
}

export interface PolicyDriftInput {
  scope?: { resourceGroupName?: string };
  profile?: string;
  findings: Finding[];
}

const SEV_ICON: Record<string, string> = {
  high: "🔴", medium: "🟠", low: "🟡", info: "🔵", unknown: "⚪️",
};

function resourceKey(f: Finding) {
  const m = f.meta || {};
  // Prefer specific names first, then fall back to anything available.
  return (
    m.webAppName || m.appServicePlanName || m.storageAccountName ||
    m.keyVaultName || m.logAnalyticsName || m.vnetName || m.subnetName ||
    m.resourceId || m.name || "unknown"
  );
}

function resourceKind(f: Finding) {
  if (f.meta?.webAppName) return "Web App";
  if (f.meta?.appServicePlanName) return "App Service Plan";
  if (f.meta?.storageAccountName) return "Storage Account";
  if (f.meta?.keyVaultName) return "Key Vault";
  if (f.meta?.logAnalyticsName) return "Log Analytics";
  if (f.meta?.vnetName) return "Virtual Network";
  if (f.meta?.subnetName) return "Subnet";
  return "Resource";
}

export function presentPolicyDrift(input: PolicyDriftInput): McpContent[] {
  const groups = new Map<string, { kind: string; items: Finding[] }>();

  for (const f of input.findings) {
    const key = resourceKey(f);
    const kind = resourceKind(f);
    const g = groups.get(key) || { kind, items: [] };
    g.items.push(f);
    groups.set(key, g);
  }

  // Summary rollup
  const sevCount: Record<string, number> = {};
  for (const f of input.findings) {
    const s = String(f.severity ?? "unknown").toLowerCase();
    sevCount[s] = (sevCount[s] ?? 0) + 1;
  }
  const summaryLine = Object.entries(sevCount)
    .map(([s, n]) => `${SEV_ICON[s] ?? "⚪️"} ${n} ${s}`)
    .join(" · ");

  const md: string[] = [
    `## Policy Drift`,
    input.scope?.resourceGroupName ? `**Scope:** \`${input.scope.resourceGroupName}\`` : "",
    input.profile ? `**ATO Profile:** \`${input.profile}\`` : "",
    "",
    `**Findings:** ${input.findings.length}${summaryLine ? ` — ${summaryLine}` : ""}`,
    "",
  ];

  // Per-resource details
  for (const [name, g] of groups.entries()) {
    const rows = g.items.map((f) => {
      const sev = String(f.severity ?? "unknown").toLowerCase();
      const controls = (f.controlIds ?? []).join(", ") || "—";
      const suggest = f.suggest ?? "—";
      return `| \`${f.code}\` | ${SEV_ICON[sev] ?? "⚪️"} ${sev} | ${controls} | ${suggest} |`;
    }).join("\n") || "| — | — | — | — |";

    md.push(
      `### ${g.kind}: \`${name}\``,
      "",
      `| Code | Severity | Controls | Suggestion |`,
      `|---|---|---|---|`,
      rows,
      ""
    );
  }

  return [
    ...mcpText(md.join("\n")),
    ...mcpJson({ kind: "policyDrift", scope: input.scope, profile: input.profile, groups: groups.size, totals: input.findings.length }),
  ];
}
