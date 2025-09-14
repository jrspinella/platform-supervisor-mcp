import { z } from "zod";
import type { ToolDef } from "mcp-http";

const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8701";

async function callRouterTool(name: string, args: any) {
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args })
  });
  const txt = await r.text();
  try { return { ok: r.ok, body: JSON.parse(txt) }; }
  catch { return { ok: r.ok, body: { raw: txt } }; }
}
function firstJson(body: any) {
  const content = body?.result?.content || body?.content;
  if (Array.isArray(content)) {
    const j = content.find((c: any) => c?.json)?.json;
    if (j !== undefined) return j;
    const t = content.find((c: any) => c?.text)?.text;
    if (t !== undefined) return t;
  }
  return body?.result ?? body;
}
const j = (json: any) => [{ type: "json" as const, json }];
const t = (text: string) => [{ type: "text" as const, text }];

const toArr = <T,>(x: T | T[] | undefined | null): T[] => !x ? [] : Array.isArray(x) ? x : [x];
const rgFromId = (id?: string) => id?.split("/resourceGroups/")[1]?.split("/")[0];
const siteNameFromId = (id?: string) => id?.split("/sites/")[1]?.split("/")[0];

type Finding = {
  kind?: string;
  resourceId?: string;
  name?: string;
  decision?: "warn" | "deny" | "allow";
  reasons: string[];
  suggestions?: Array<{ title?: string; text: string }>;
};

function buildStepsDev(findings: Finding[], opts: { defaultMinTls?: "1.2" | "1.3"; lawName?: string; kvName?: string; kvSecretRef?: string } = {}) {
  const steps: Array<{ cmd?: string; why: string; todo?: string; resourceId?: string }> = [];
  const minTls = opts.defaultMinTls || "1.2";

  for (const f of findings) {
    const id = f.resourceId;
    const rg = rgFromId(id);
    const name = siteNameFromId(id) || f.name;

    if (f.kind === "web_app" && rg && name) {
      if (f.reasons.some(r => r.includes("webapp-identity"))) {
        steps.push({
          cmd: `@platform create_webapp_identity resourceGroupName "${rg}" appName "${name}" confirm true`,
          why: `Enable system-assigned identity on ${name} (required for KV refs).`,
          resourceId: id
        });
      }
      if (f.reasons.some(r => r.includes("webapp-https-only")) || f.reasons.some(r => r.includes("webapp-min-tls"))) {
        steps.push({
          todo: `Add/update tool to set httpsOnly=true and minimumTlsVersion=${minTls} for ${name} (PATCH siteConfig).`,
          why: "Harden transport security (HTTPS-only, TLS >= 1.2).",
          resourceId: id
        });
      }
      if (f.reasons.some(r => r.includes("webapp-diagnostics-law"))) {
        if (opts.lawName) {
          steps.push({
            todo: `Create tool to upsert Diagnostic Settings to LAW "${opts.lawName}" for ${name} (logs + metrics).`,
            why: "Ship logs/metrics to LAW for auditability.",
            resourceId: id
          });
        } else {
          steps.push({
            todo: `Pick LAW and attach diagnostic settings for ${name}.`,
            why: "LAW not specified; required for centralized logging.",
            resourceId: id
          });
        }
      }
      if (opts.kvName && opts.kvSecretRef) {
        steps.push({
          cmd: `@platform create_webapp_settings resourceGroupName "${rg}" appName "${name}" settings {"MY_SECRET":"${opts.kvSecretRef}"} confirm true`,
          why: "Add KV reference to app settings (requires MSI).",
          resourceId: id
        });
      }
    }
  }

  return steps;
}

export const tool_dev_generate_remediation_plan: ToolDef = {
  name: "developer.generate_remediation_plan",
  description: "Turn ATO findings into @platform follow-ups geared for developers (MSI, TLS/HTTPS-only, LAW diagnostics, KV refs).",
  inputSchema: z.object({
    findings: z.array(z.any()).optional(),
    scan: z.object({
      type: z.enum(["workloads", "networks", "both"]).default("workloads"),
      resourceGroupName: z.string()
    }).optional(),
    lawName: z.string().optional(),
    kvName: z.string().optional(),
    kvSecretRef: z.string().optional(),
    defaultMinTls: z.enum(["1.2", "1.3"]).default("1.2")
  }).strict(),
  handler: async (a) => {
    let findings: Finding[] = [];

    if (a.findings?.length) {
      findings = a.findings as Finding[];
    } else if (a.scan) {
      const scope = { resourceGroupName: a.scan.resourceGroupName };
      if (a.scan.type === "workloads" || a.scan.type === "both") {
        const r = await callRouterTool("platform.scan_workloads_ato", scope);
        if (!r.ok) return { isError: true, content: t(`Scan workloads failed: ${JSON.stringify(r.body).slice(0, 800)}`) };
        const js = firstJson(r.body);
        findings.push(...toArr(js?.findings));
      }
      if (a.scan.type === "networks" || a.scan.type === "both") {
        const r = await callRouterTool("platform.scan_networks_ato", scope);
        if (!r.ok) return { isError: true, content: t(`Scan networks failed: ${JSON.stringify(r.body).slice(0, 800)}`) };
        const js = firstJson(r.body);
        findings.push(...toArr(js?.findings));
      }
    } else {
      return { isError: true, content: t("Provide either `findings` or `scan { type, resourceGroupName }`.") };
    }

    const steps = buildStepsDev(findings, {
      defaultMinTls: a.defaultMinTls,
      lawName: a.lawName,
      kvName: a.kvName,
      kvSecretRef: a.kvSecretRef
    });

    const human = [
      "Developer Remediation Plan:",
      ...steps.map((s, i) => {
        const head = s.cmd ? `#${i + 1} ${s.cmd}` : `#${i + 1} TODO: ${s.todo}`;
        return [
          head,
          `   Why: ${s.why}`,
          s.resourceId ? `   Resource: ${s.resourceId}` : undefined
        ].filter(Boolean).join("\n");
      })
    ].join("\n");

    return { content: [...j({ steps }), ...t(human)] };
  }
};

export const remediationToolsDev: ToolDef[] = [tool_dev_generate_remediation_plan];