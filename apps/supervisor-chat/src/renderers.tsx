import React from "react";

type Block = any;

const sevOrder: Record<string, number> = { high: 4, medium: 3, low: 2, info: 1, unknown: 0 };
const sevColor: Record<string, string> = {
  high: "#f87171",   // red-400
  medium: "#fbbf24", // amber-400
  low: "#34d399",    // emerald-400
  info: "#60a5fa",   // blue-400
  unknown: "#9ca3af" // gray-400
};

function Badge({ label, tone = "#334155" }: { label: string; tone?: string }) {
  return <span style={{
    display:"inline-block", padding:"2px 8px", borderRadius:999, background:`${tone}22`,
    border:`1px solid ${tone}55`, color:tone, fontSize:12
  }}>{label}</span>;
}

function Row({ left, right }: { left: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div style={{display:"flex", justifyContent:"space-between", gap:8, alignItems:"center"}}>
      <div>{left}</div>
      <div>{right}</div>
    </div>
  );
}

function toCSV(rows: any[]): string {
  const cols = ["code","severity","resource","domain","suggest","controls"];
  const esc = (v: any) => `"${String(v ?? "").replace(/"/g,'""')}"`;
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map(c => esc(r[c])).join(","));
  return lines.join("\n");
}

function resourceFromMeta(meta: any): string | undefined {
  if (!meta || typeof meta !== "object") return undefined;
  return meta.webAppName || meta.appServicePlanName || meta.storageAccountName ||
         meta.keyVaultName || meta.vnetName || meta.subnetName || meta.name ||
         meta.resourceName || meta.resourceId;
}

function domainFromCode(code: string): string {
  const c = (code || "").toUpperCase();
  if (c.startsWith("APPPLAN_")) return "app plan";
  if (c.startsWith("APP_")) return "web app";
  if (c.startsWith("KV_")) return "key vault";
  if (c.startsWith("STG_")) return "storage account";
  if (c.startsWith("LAW_")) return "log analytics";
  if (c.startsWith("NET_") || c.startsWith("SUBNET_")) return "network";
  return "other";
}

// ───────────────────────────────────────────────────────────────
// DETECTORS
// ───────────────────────────────────────────────────────────────
function isScanResult(json: any) {
  return json && typeof json === "object" &&
    Array.isArray(json.findings) && json.summary && typeof json.summary === "object";
}

function isRemediationReport(json: any) {
  return json && typeof json === "object" && (json.status === "plan" || json.status === "done") &&
    (json.steps || json.report || json.results);
}

function isNormalizedAzureError(json: any) {
  return json && json.status === "error" && json.error && json.error.type;
}

// ───────────────────────────────────────────────────────────────
// SCAN RESULT VIEW
// ───────────────────────────────────────────────────────────────
export const ScanResultView: React.FC<{ data: any }> = ({ data }) => {
  const profile = data.profile || "default";
  const summary = data.summary || { total: 0, bySeverity: {} };
  const findings = (data.findings || []) as any[];

  const rows = findings.map(f => ({
    code: f.code,
    severity: String(f.severity || "unknown").toLowerCase(),
    resource: resourceFromMeta(f.meta),
    domain: domainFromCode(f.code),
    suggest: f.suggest,
    controls: (f.controlIds || f.controls || []).join(" ")
  }));

  const sorted = rows.sort((a,b) => (sevOrder[b.severity] - sevOrder[a.severity]) || (a.code||"").localeCompare(b.code||""));

  const sevChips = Object.entries(summary.bySeverity || {})
    .sort((a,b) => (sevOrder[b[0]] ?? 0) - (sevOrder[a[0]] ?? 0))
    .map(([k,v]) => <Badge key={k} label={`${k}: ${v}`} tone={sevColor[k] || sevColor.unknown} />);

  function copyJSON() {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
  }
  function exportCSV() {
    const blob = new Blob([toCSV(sorted)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "findings.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="bubble assistant">
      <Row left={<div className="small"><strong>ATO Scan</strong> — profile <Badge label={profile} /></div>}
           right={<div className="row" style={{gap:6}}>
             <button className="secondary" onClick={exportCSV}>Export CSV</button>
             <button className="secondary" onClick={copyJSON}>Copy JSON</button>
           </div>}
      />
      <div style={{marginTop:8}} className="row">{sevChips}</div>
      <div className="small" style={{marginTop:8}}>Total findings: <strong>{summary.total ?? findings.length}</strong></div>

      <div style={{overflow:"auto", marginTop:10}}>
        <table style={{ width:"100%", borderCollapse:"separate", borderSpacing:0 }}>
          <thead>
            <tr style={{ background:"#0a0f1c" }}>
              {["Severity","Code","Resource","Domain","Suggestion","Controls"].map((h, i) => (
                <th key={i} style={{ textAlign:"left", padding:"8px 10px", fontSize:12, color:"#9fb0d7", position:"sticky", top:0 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => (
              <tr key={i} style={{ borderTop:"1px solid #141c30" }}>
                <td style={{ padding:"8px 10px" }}><Badge label={r.severity} tone={sevColor[r.severity] || sevColor.unknown} /></td>
                <td style={{ padding:"8px 10px", fontFamily:"ui-monospace,Menlo,Consolas,monospace" }}>{r.code}</td>
                <td style={{ padding:"8px 10px" }}>{r.resource || "—"}</td>
                <td style={{ padding:"8px 10px" }}>{r.domain}</td>
                <td style={{ padding:"8px 10px", whiteSpace:"pre-wrap" }}>{r.suggest || "—"}</td>
                <td style={{ padding:"8px 10px", fontFamily:"ui-monospace,Menlo,Consolas,monospace" }}>{r.controls || "—"}</td>
              </tr>
            ))}
            {!sorted.length && (
              <tr><td colSpan={6} style={{ padding:"10px", color:"#9fb0d7" }}>No findings.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// REMEDIATION VIEW
// ───────────────────────────────────────────────────────────────
export const RemediationView: React.FC<{ data: any }> = ({ data }) => {
  const status = data.status;
  const plans: Record<string, any[]> = data.plans || {};
  const results: Record<string, any[]> = data.results || {};
  const report = data.report || {};

  const keys = Object.keys(report);

  function StepRow({ s }: { s: any }) {
    const label =
      s.action === "webapps.setHttpsOnly" ? "Enable HTTPS-only" :
      s.action === "webapps.setFtpsDisabled" ? "Disable FTPS" :
      s.action === "webapps.setMinTls12" ? "Set min TLS 1.2" :
      s.action === "webapps.enableMsi" ? "Enable system-assigned identity" :
      s.action === "monitor.enableDiagnostics" ? "Enable diagnostics to LAW" :
      s.action === "plans.setSku" ? "Set plan SKU" :
      s.action === "plans.setCapacity" ? "Set worker capacity" :
      s.action === "plans.setZoneRedundant" ? "Enable zone redundancy" :
      s.action;

    return (
      <li style={{ margin:"4px 0" }}>
        <span className="small">{label}</span>
      </li>
    );
  }

  return (
    <div className="bubble assistant">
      <Row left={<div className="small"><strong>Remediation</strong> — {status}</div>} />
      <div style={{ marginTop:8 }}>
        {keys.map((k) => {
          const p = plans[k] || [];
          const r = results[k] || [];
          const rep = report[k] || {};
          return (
            <div key={k} style={{ border:"1px solid #1b2236", borderRadius:10, padding:10, marginTop:10, background:"#0b1328" }}>
              <div className="row" style={{ justifyContent:"space-between" }}>
                <div className="small"><strong>{k}</strong></div>
                <div className="row" style={{ gap:6 }}>
                  <Badge label={`planned: ${rep.plannedSteps ?? p.length}`} />
                  {rep.applied != null ? <Badge label={`applied: ${rep.applied}`} tone="#34d399" /> : null}
                  {rep.failed != null ? <Badge label={`failed: ${rep.failed}`} tone="#f87171" /> : null}
                </div>
              </div>
              {!!p.length && (
                <ul style={{ margin:"8px 0 0 18px", padding:0 }}>
                  {p.map((s, i) => <StepRow key={i} s={s} />)}
                </ul>
              )}
              {Array.isArray(rep.suggestions) && rep.suggestions.length ? (
                <div style={{ marginTop:8 }}>
                  <div className="small"><strong>Suggestions</strong></div>
                  <ul style={{ margin:"6px 0 0 18px" }}>
                    {rep.suggestions.map((t: string, i: number) => <li key={i} className="small">{t}</li>)}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })}
        {!keys.length && <div className="small">No plan items.</div>}
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// ERROR VIEW
// ───────────────────────────────────────────────────────────────
export const ErrorView: React.FC<{ data: any }> = ({ data }) => {
  const e = data.error || {};
  return (
    <div className="bubble assistant" style={{ borderColor:"#3f1f1f", background:"#170f0f" }}>
      <div className="small"><strong>Error:</strong> {e.type}</div>
      <div className="small" style={{ marginTop:6 }}>
        <div><strong>Message:</strong> {e.message || "—"}</div>
        <div><strong>Status:</strong> {e.statusCode ?? "—"}  <strong>Code:</strong> {e.code ?? "—"}</div>
        {e.retryable ? <Badge label="retryable" tone="#fbbf24" /> : null}
        {e.throttled ? <Badge label="throttled" tone="#f87171" /> : null}
        {e.retryAfterMs ? <span className="small"> retryAfter: {Math.round(e.retryAfterMs/1000)}s</span> : null}
      </div>
      {e.details ? <pre className="monospace" style={{ marginTop:8 }}>{JSON.stringify(e.details, null, 2)}</pre> : null}
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// ENTRY POINT
// ───────────────────────────────────────────────────────────────
export function renderSpecial(json: any): React.ReactNode | null {
  if (isScanResult(json)) return <ScanResultView data={json} />;
  if (isRemediationReport(json)) return <RemediationView data={json} />;
  if (isNormalizedAzureError(json)) return <ErrorView data={json} />;
  return null;
}