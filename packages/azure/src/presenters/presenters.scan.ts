// servers/platform-mcp/src/presenters/rg-scan.ts
type McpContent = { type: "text"; text: string } | { type: "json"; json: any };

function sevIcon(s: string) {
  const k = (s || "").toLowerCase();
  if (k === "high" || k === "critical") return "🔴";
  if (k === "medium") return "🟠";
  if (k === "low") return "🟡";
  if (k === "info") return "🔷";
  return "⚪️";
}

export function renderRgScanPretty(result: {
  scope: { resourceGroupName: string };
  profile: string;
  findings: Array<{ code: string; severity: string; meta?: any; controlIds?: string[]; suggest?: string }>;
  summary: { total: number; bySeverity?: Record<string, number> };
  filters?: { dropped?: number };
}, opts?: { debugJson?: boolean, titlePrefix?: string }): McpContent[] {

  const { scope, profile, findings = [], summary = { total: 0, bySeverity: {} }, filters } = result || {};
  const rg = scope?.resourceGroupName || "<unknown>";
  const by = summary.bySeverity || {};
  const dropped = filters?.dropped ?? 0;

  const header = `### ATO scan — Resource Group \`${rg}\` (profile: \`${profile || "default"}\`)`;

  if ((summary.total ?? findings.length) === 0) {
    const md = [
      header,
      "",
      "**Findings:** 0",
      "",
      "✅ No issues detected for the selected workloads.",
      dropped ? `\n> (${dropped} findings were filtered out)` : ""
    ].join("\n");
    const out: McpContent[] = [{ type: "text", text: md }];
    if (opts?.debugJson) out.push({ type: "json", json: result });
    return out;
  }

  // Summary card
  const counts = [
    by.high ? `🔴 high: ${by.high}` : "",
    by.medium ? `🟠 medium: ${by.medium}` : "",
    by.low ? `🟡 low: ${by.low}` : "",
    by.info ? `🔷 info: ${by.info}` : "",
  ].filter(Boolean).join(" · ");

  const lines: string[] = [
    header,
    "",
    `**Findings:** **${summary.total}**` + (counts ? ` — ${counts}` : ""),
    dropped ? `\n> (${dropped} findings were filtered out)` : "",
    "",
    "#### App Service Plans & Web Apps",
    "",
    "| Resource | Code | Severity | Controls | Suggestion |",
    "|---|---|---:|---|---|",
  ];

  for (const f of findings) {
    const sev = `${sevIcon(f.severity)} ${f.severity}`;
    const res =
      f.meta?.appServicePlanName ||
      f.meta?.webAppName ||
      f.meta?.name ||
      "—";
    const controls = (f.controlIds ?? []).join(", ") || "—";
    const suggest = f.suggest || "—";
    lines.push(`| \`${res}\` | \`${f.code}\` | ${sev} | ${controls} | ${suggest} |`);
  }

  const out: McpContent[] = [{ type: "text", text: lines.join("\n") }];
  if (opts?.debugJson) out.push({ type: "json", json: result });
  return out;
}
