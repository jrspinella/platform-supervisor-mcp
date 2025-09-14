// Severity chips
const sevIcon: Record<string, string> = {
  high: "🔴", medium: "🟠", low: "🟡", info: "🔵", unknown: "⚪️",
};

function mdTable(rows: string[]) {
  if (!rows.length) return "| — | — | — | — | — |\n";
  return rows.join("\n") + "\n";
}

function portalResourceHint(kind: string) {
  return kind === "webApp" ? "Web App" :
         kind === "appServicePlan" ? "App Service Plan" :
         kind;
}

export function renderRgScanPretty(result: {
  scope?: { resourceGroupName?: string };
  profile?: string;
  findings?: Array<{
    code: string;
    severity?: string;
    controlIds?: string[];
    suggest?: string;
    meta?: Record<string, any>;
  }>;
  summary?: { total?: number; bySeverity?: Record<string, number> };
  filters?: { dropped?: number };
}) {
  const rg = result.scope?.resourceGroupName || "—";
  const profile = result.profile || "default";
  const total = result.summary?.total ?? (result.findings?.length ?? 0);
  const bySev = result.summary?.bySeverity || {};
  const sevCounts = Object.entries(bySev)
    .map(([s, n]) => `${sevIcon[s.toLowerCase?.() || "unknown"] ?? "⚪️"} ${n} ${s}`)
    .join(" · ");

  // Partition by resource flavor (best-effort)
  const appPlan: typeof result.findings = [];
  const webApp: typeof result.findings = [];
  const other: typeof result.findings = [];
  for (const f of result.findings || []) {
    const m = f.meta || {};
    if (m.appServicePlanName) appPlan.push(f);
    else if (m.webAppName) webApp.push(f);
    else other.push(f);
  }

  const mkRows = (items: any[], kind: "appServicePlan" | "webApp" | "other") => {
    return items.map((f) => {
      const sev = String(f.severity ?? "unknown").toLowerCase();
      const controls = (Array.isArray(f.controlIds) && f.controlIds.length) ? f.controlIds.join(", ") : "—";
      const suggest = f.suggest ?? "—";
      let res: string;
      if (kind === "appServicePlan") {
        res = `\`${f.meta?.appServicePlanName}\``;
      } else if (kind === "webApp") {
        res = `\`${f.meta?.webAppName}\``;
      } else {
        res = "`—`";
      }
      return `| ${res} | \`${f.code}\` | ${sevIcon[sev] ?? "⚪️"} ${sev} | ${controls} | ${suggest} |`;
    });
  };

  const rowsPlan = mkRows(appPlan, "appServicePlan");
  const rowsWeb  = mkRows(webApp, "webApp");
  const rowsOther= mkRows(other, "other");

  // Quick actions
  const quick: string[] = [];
  // web apps in this RG — example remediate commands
  for (const f of webApp) {
    const name = f.meta?.webAppName;
    if (name) quick.push(`@platform remediate_webapp_baseline {"resourceGroupName":"${rg}","name":"${name}","dryRun":true}`);
  }
  // app plans in this RG — example remediate commands (adjust if your tool name differs)
  for (const f of appPlan) {
    const name = f.meta?.appServicePlanName;
    if (name) quick.push(`@platform remediate_appplan_baseline {"resourceGroupName":"${rg}","name":"${name}","dryRun":true}`);
  }

  const md = [
    `### ATO scan — **Resource Group** \`${rg}\`  (profile: \`${profile}\`)`,
    ``,
    `**Findings:** ${total}${sevCounts ? ` — ${sevCounts}` : ""}`,
    result.filters?.dropped ? `_(filtered out ${result.filters.dropped})_` : "",
    ``,
    webApp.length ? `#### Web Apps (${webApp.length})` : "",
    webApp.length ? `| Resource | Code | Severity | Controls | Suggestion |
|---|---|---|---|---|
${mdTable(rowsWeb)}` : "",
    appPlan.length ? `#### App Service Plans (${appPlan.length})` : "",
    appPlan.length ? `| Resource | Code | Severity | Controls | Suggestion |
|---|---|---|---|---|
${mdTable(rowsPlan)}` : "",
    other.length ? `#### Other (${other.length})` : "",
    other.length ? `| Resource | Code | Severity | Controls | Suggestion |
|---|---|---|---|---|
${mdTable(rowsOther)}` : "",
    quick.length ? `<details><summary>Quick actions</summary>

\`\`\`bash
${quick.join("\n")}
\`\`\`

</details>` : "",
  ].filter(Boolean).join("\n");

  return md;
}