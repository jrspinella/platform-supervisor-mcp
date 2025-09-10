import { z } from "zod";
import type { ToolDef } from "mcp-http";
import {
  evaluateWebAppAto,
  evaluateVnetAto,
  evaluateSubnetAto,
  evaluateNsgAto,
  evaluatePublicIpAto,
  summarizeFindings
} from "@platform/governance-core"; // adjust if needed

const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";

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
const arr = <T,>(x: T | T[] | undefined | null): T[] => (!x ? [] : Array.isArray(x) ? x : [x]);

export const dev_scan_workloads_ato: ToolDef = {
  name: "developer.scan_workloads_ato",
  description: "Developer-facing scan of Web Apps for ATO issues (forwards to azure.* list APIs).",
  inputSchema: z.object({ resourceGroupName: z.string().min(1) }).strict(),
  handler: async (a) => {
    const listResp = await callRouterTool("azure.list_web_apps", { resourceGroupName: a.resourceGroupName });
    if (!listResp.ok) return { isError: true, content: t(`Router error: ${JSON.stringify(listResp.body).slice(0, 800)}`) };
    const apps = arr(firstJson(listResp.body));

    const findings = apps.map((app: any) => evaluateWebAppAto({
      id: app?.id,
      name: app?.name,
      httpsOnly: app?.properties?.httpsOnly ?? app?.httpsOnly,
      minimumTlsVersion: app?.properties?.siteConfig?.minimumTlsVersion ?? app?.siteConfig?.minimumTlsVersion,
      linuxFxVersion: app?.properties?.siteConfig?.linuxFxVersion ?? app?.siteConfig?.linuxFxVersion,
      identity: app?.identity
    })).filter(Boolean) as any[];

    const summary = summarizeFindings(findings);
    const human = [
      `Scanned workloads in RG ${a.resourceGroupName}:`,
      `• Web Apps: ${apps.length}`,
      `• Findings: ${summary.counts.total} (warn: ${summary.counts.warn}, deny: ${summary.counts.deny})`,
      ...(findings.length ? ["", "Findings:", ...findings.map(f => `• ${f.resourceId ?? f.name}\n  Reasons: ${f.reasons.join(" | ")}`)] : ["", "No ATO findings. ✅"])
    ].join("\n");

    return { content: [...j({ scope: { resourceGroupName: a.resourceGroupName }, counts: { webApps: apps.length, ...summary.counts }, findings }), ...t(human)] };
  }
};

export const dev_scan_networks_ato: ToolDef = {
  name: "developer.scan_networks_ato",
  description: "Developer-facing scan of VNets/Subnets/NSGs/Public IPs for ATO issues (forwards to azure.* list APIs).",
  inputSchema: z.object({ resourceGroupName: z.string().min(1) }).strict(),
  handler: async (a) => {
    const vnetResp = await callRouterTool("azure.list_virtual_networks", { resourceGroupName: a.resourceGroupName });
    if (!vnetResp.ok) return { isError: true, content: t(`Router error: ${JSON.stringify(vnetResp.body).slice(0, 800)}`) };
    const vnets = arr(firstJson(vnetResp.body));

    const subnetsAll: any[] = [];
    for (const v of vnets) {
      const vnetName = v?.name;
      if (!vnetName) continue;
      const sResp = await callRouterTool("azure.list_subnets", { resourceGroupName: a.resourceGroupName, vnetName });
      if (!sResp.ok) return { isError: true, content: t(`Router error (subnets ${vnetName}): ${JSON.stringify(sResp.body).slice(0, 800)}`) };
      subnetsAll.push(...arr(firstJson(sResp.body)).map(s => ({ ...s, _vnetName: vnetName })));
    }

    const nsgResp = await callRouterTool("azure.list_network_security_groups", { resourceGroupName: a.resourceGroupName });
    if (!nsgResp.ok) return { isError: true, content: t(`Router error: ${JSON.stringify(nsgResp.body).slice(0, 800)}`) };
    const nsgs = arr(firstJson(nsgResp.body));

    const pipResp = await callRouterTool("azure.list_public_ip_addresses", { resourceGroupName: a.resourceGroupName });
    if (!pipResp.ok) return { isError: true, content: t(`Router error: ${JSON.stringify(pipResp.body).slice(0, 800)}`) };
    const pips = arr(firstJson(pipResp.body));

    const findings = [
      ...vnets.map(v => evaluateVnetAto({ id: v?.id, name: v?.name, addressPrefixes: v?.addressSpace?.addressPrefixes })),
      ...subnetsAll.map(s => evaluateSubnetAto({ id: s?.id, name: s?.name, addressPrefix: s?.addressPrefix, privateEndpointNetworkPolicies: s?.privateEndpointNetworkPolicies })),
      ...nsgs.map(n => evaluateNsgAto({ id: n?.id, name: n?.name, securityRules: n?.securityRules })),
      ...pips.map(p => evaluatePublicIpAto({ id: p?.id, name: p?.name, tags: p?.tags }))
    ].filter(Boolean) as any[];

    const summary = summarizeFindings(findings);
    const human = [
      `Scanned networks in RG ${a.resourceGroupName}:`,
      `• VNets: ${vnets.length} | Subnets: ${subnetsAll.length} | NSGs: ${nsgs.length} | Public IPs: ${pips.length}`,
      `• Findings: ${summary.counts.total} (warn: ${summary.counts.warn}, deny: ${summary.counts.deny})`,
      ...(findings.length ? ["", "Findings:", ...findings.map(f => `• [${f.kind}] ${f.resourceId ?? f.name}\n  Reasons: ${f.reasons.join(" | ")}`)] : ["", "No ATO findings. ✅"])
    ].join("\n");

    return { content: [...j({ scope: { resourceGroupName: a.resourceGroupName }, counts: { vnets: vnets.length, subnets: subnetsAll.length, nsgs: nsgs.length, publicIps: pips.length, ...summary.counts }, findings }), ...t(human)] };
  }
};

export const toolsScan: ToolDef[] = [dev_scan_workloads_ato, dev_scan_networks_ato];