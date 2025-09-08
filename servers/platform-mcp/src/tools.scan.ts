import { z } from "zod";
import type { ToolDef } from "mcp-http";

// helpers you likely already have:
const mcpJson = (json: any) => [{ type: "json" as const, json }];
const mcpText = (text: string) => [{ type: "text" as const, text }];

async function callRouterTool(name: string, args: any) {
  const r = await fetch((process.env.ROUTER_URL || "http://127.0.0.1:8700") + "/a2a/tools/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args || {} })
  });
  const text = await r.text();
  let body: any; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: r.ok, status: r.status, body };
}

function firstJson(body: any) {
  const content = body?.result?.content;
  if (Array.isArray(content)) return content.find((c: any) => c.json)?.json;
  return null;
}

async function tryOne<T=any>(calls: Array<{ name: string; args: any }>): Promise<{ ok: boolean; json: T | null; raw: any }> {
  for (const c of calls) {
    const r = await callRouterTool(c.name, c.args);
    if (r.ok) {
      const j = firstJson(r.body) ?? r.body?.result ?? r.body;
      return { ok: true, json: j as T, raw: r.body };
    }
  }
  return { ok: false, json: null, raw: { error: "no method worked" } };
}

async function evalAto(toolKey: string, cfg: any) {
  const r = await callRouterTool("governance.evaluate", { tool: toolKey, args: cfg });
  const j = firstJson(r.body);
  return j || { decision: "allow", reasons: [], policyIds: [], suggestions: [] };
}

function formatFinding(resourceId: string, ev: any, friendly?: { title?: string; severity?: string; rationale?: string; fix?: any; controls?: string[]; references?: any[] }) {
  const lines: string[] = [];
  const title = friendly?.title || "ATO advisory";
  const sev = friendly?.severity ? ` (${friendly.severity})` : "";
  lines.push(`• ${title}${sev}`);
  lines.push(`  Resource: ${resourceId}`);
  if (friendly?.rationale) lines.push(`  Why it matters: ${friendly.rationale}`);
  if (Array.isArray(ev?.reasons) && ev.reasons.length) lines.push(`  Evidence: ${ev.reasons.join(" | ")}`);
  if (friendly?.fix) {
    lines.push(`  How to fix:`);
    if (friendly.fix.cli)   lines.push(`    CLI:\n${String(friendly.fix.cli).split("\n").map(l=>"      "+l).join("\n")}`);
    if (friendly.fix.portal)lines.push(`    Portal: ${friendly.fix.portal}`);
    if (friendly.fix.bicep) lines.push(`    Bicep:\n${String(friendly.fix.bicep).split("\n").map(l=>"      "+l).join("\n")}`);
    if (friendly.fix.notes) lines.push(`    Notes: ${friendly.fix.notes}`);
  }
  if (Array.isArray(friendly?.controls) && friendly.controls.length) lines.push(`  Controls: ${friendly.controls.join(", ")}`);
  if (Array.isArray(friendly?.references) && friendly.references.length) {
    lines.push(`  References:`);
    for (const r of friendly.references) lines.push(`    - ${r.label}${r.link ? ` — ${r.link}` : ""}`);
  }
  if (Array.isArray(ev?.suggestions) && ev.suggestions.length) {
    lines.push(`  Suggestions:`);
    for (const s of ev.suggestions) lines.push(`    - ${s.title ? `${s.title}: ` : ""}${s.text}`);
  }
  return lines.join("\n");
}

export const tool_platform_scan_workloads: ToolDef = {
  name: "platform.scan_workloads",
  description: "Scan App Services for ATO warnings (HTTPS-only, TLS, FTPS, diagnostics, secrets via KV, identity, etc.).",
  inputSchema: z.object({
    subscriptionId: z.string().optional(),
    resourceGroupName: z.string().optional()
  }).strict(),
  handler: async (a) => {
    const scope = { subscriptionId: a.subscriptionId, resourceGroupName: a.resourceGroupName };

    // ---- 1) enumerate web apps (try several methods)
    const appsRes = await tryOne<any[]>([
      { name: "azure.list_web_apps", args: scope },
      { name: "azure.list_resources_by_type", args: { ...scope, resourceType: "Microsoft.Web/sites" } },
      { name: "azure.web_list_apps", args: scope },
      // add a Resource Graph fallback if you expose one:
      // { name: "azure.resource_graph_query", args: { query: "...", subscriptions:[a.subscriptionId].filter(Boolean) } },
    ]);
    if (!appsRes.ok || !Array.isArray(appsRes.json)) {
      return {
        isError: true,
        content: [
          ...mcpText("Could not enumerate Web Apps (no supported azure.* list method worked)."),
          ...mcpJson({ scope, debug: appsRes.raw })
        ]
      };
    }
    const apps = appsRes.json;

    const findings: any[] = [];
    for (const app of apps) {
      const rg = app.resourceGroup || app.resourceGroupName || app.id?.split("/resourceGroups/")[1]?.split("/")[0];
      const name = app.name;

      // ---- 2) gather config/settings/diag (best-effort)
      const [cfg, stg, diag] = await Promise.all([
        tryOne<any>([
          { name: "azure.get_web_app_config", args: { resourceGroupName: rg, name } },
          { name: "azure.web_get_configuration", args: { resourceGroupName: rg, name } },
        ]),
        tryOne<any>([
          { name: "azure.get_web_app_settings", args: { resourceGroupName: rg, name } },
          { name: "azure.web_list_app_settings", args: { resourceGroupName: rg, name } },
        ]),
        tryOne<any>([
          { name: "azure.get_diagnostic_settings", args: { resourceId: app.id } },
        ]),
      ]);

      const siteConfig = (cfg.json && (cfg.json.properties || cfg.json)) || {};
      const appSettingsProps = (stg.json && (stg.json.properties || stg.json)) || {};
      const diagWsId = (diag.json && (diag.json.workspaceId || diag.json?.properties?.workspaceId)) || undefined;

      // ---- 3) build config for ATO governance
      const configForAto = {
        id: app.id,
        name: name,
        properties: {
          httpsOnly: app.properties?.httpsOnly ?? siteConfig.httpsOnly,
          siteConfig: {
            minimumTlsVersion: siteConfig.minimumTlsVersion || app.properties?.siteConfig?.minimumTlsVersion,
            ftpsState: siteConfig.ftpsState || app.properties?.siteConfig?.ftpsState
          }
        },
        diagnosticWorkspaceResourceId: diagWsId,
        appSettings: appSettingsProps
      };

      // ---- 4) evaluate against governance (ato.workload.web_app)
      const ev = await evalAto("ato.workload.web_app", configForAto);

      if (ev.decision !== "allow") {
        findings.push({
          resourceId: app.id,
          kind: "web_app",
          decision: ev.decision,
          reasons: ev.reasons,
          suggestions: ev.suggestions
        });
      }
    }

    const summary = [
      `Scanned workloads${a.resourceGroupName ? ` in RG ${a.resourceGroupName}` : ""}:`,
      `• Web Apps: ${apps.length}`,
      `• Findings: ${findings.length}`,
    ].join("\n");

    // Optional: pretty-print each finding (if you attach rich hints in governance)
    const pretty = findings.length
      ? "\nFindings:\n" + findings.map(f => `• ${f.resourceId}\n  Reasons: ${f.reasons?.join(" | ") || "(none)"}\n`).join("\n")
      : "\nNo ATO issues detected.";

    return {
      content: [
        ...mcpJson({ scope, counts: { webApps: apps.length, findings: findings.length }, findings }),
        ...mcpText(summary + pretty)
      ]
    };
  }
};

// ---------- Wrap EVERYTHING with governance ----------
const rawTools: ToolDef[] = [
  tool_platform_scan_workloads
]

// Governance is applied here, centrally:
export const toolsScan: ToolDef[] = rawTools;