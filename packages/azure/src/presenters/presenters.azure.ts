// packages/azure-core/src/presenters/more.ts
// Pretty presenters for additional Azure resources.
// All functions return McpContent[] (via mcpText) ready to splice into MCP results.

import { mcpText } from "../utils.js";
import { portalUrlForResourceId, portalMarkdownLink } from "./presenters.shared.js";

/* ────────────────────────── helpers ────────────────────────── */

function isGov(): boolean {
  return (process.env.AZURE_AUTHORITY_HOST || "").includes("login.microsoftonline.us")
      || process.env.AZURE_CLOUD === "usgovernment";
}

function extractRgFromId(id?: string) {
  const m = id?.match(/\/resourceGroups\/([^/]+)/i);
  return m?.[1];
}

function yn(v?: boolean | string | null) {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === "Enabled" || v === "On") return "true";
  if (v === "Disabled" || v === "Off") return "false";
  return String(v ?? "—");
}

function codeOrDash(s?: string) {
  return s ? `\`${s}\`` : "—";
}

/* ────────────────────────── presenters ────────────────────────── */

/** Pretty Resource Group card */
export function presentResourceGroup(res: any) {
  const name = res?.name ?? "—";
  const location = res?.location ?? "—";
  const state = res?.properties?.provisioningState ?? "—";
  const id = res?.id ?? "";
  const link = id ? `[Open in Azure Portal](${portalUrlForResourceId(id)})` : "";

  const md = [
    `**Azure Resource Group**`,
    "",
    `| Name | Location | State |`,
    `|---|---|---|`,
    `| \`${name}\` | \`${location}\` | ${state} |`,
    "",
    link,
    "",
  ].join("\n");

  return mcpText(md);
}

export function presentWebApp(site: any) {
  const name = site?.name ?? "—";
  const rg = site?.resourceGroup ?? extractRgFromId(site?.id) ?? "—";
  const loc = site?.location ?? "—";
  const plan = site?.serverFarmId?.split?.("/")?.pop?.() ?? "—";
  const tls = site?.properties?.minimumTlsVersion ?? site?.siteConfig?.minTlsVersion ?? "—";
  const https = (site?.httpsOnly ?? site?.properties?.httpsOnly) ? "enabled" : "disabled";
  const ftps = site?.siteConfig?.ftpsState ?? site?.properties?.ftpsState ?? "—";
  const runtime = site?.siteConfig?.linuxFxVersion ?? site?.linuxFxVersion ?? "—";
  const url = portalUrlForResourceId(site?.id);

  const text = [
    "**Azure Web App (Linux)**",
    "",
    "| Name | Resource Group | Location | Plan | Runtime | TLS min | HTTPS-only | FTPS |",
    "|---|---|---|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${plan}\` | \`${runtime}\` | \`${tls}\` | \`${https}\` | \`${ftps}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentKeyVault(v: any) {
  const name = v?.name ?? "—";
  const rg = v?.resourceGroup ?? extractRgFromId(v?.id) ?? "—";
  const loc = v?.location ?? "—";
  const sku = v?.properties?.sku?.name ?? v?.sku?.name ?? "—";
  const rbac = v?.properties?.enableRbacAuthorization === true ? "enabled" : "disabled";
  const pna = v?.properties?.publicNetworkAccess ?? "—";
  const url = portalUrlForResourceId(v?.id);

  const text = [
    "**Azure Key Vault**",
    "",
    "| Name | Resource Group | Location | SKU | RBAC | Public Network Access |",
    "|---|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${sku}\` | \`${rbac}\` | \`${pna}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentStorageAccount(sa: any) {
  const name = sa?.name ?? "—";
  const rg = sa?.resourceGroup ?? extractRgFromId(sa?.id) ?? "—";
  const loc = sa?.location ?? "—";
  const kind = sa?.kind ?? "—";
  const sku = sa?.sku?.name ?? "—";
  const httpsOnly = (sa?.properties?.supportsHttpsTrafficOnly ?? sa?.supportsHttpsTrafficOnly) ? "true" : "false";
  const minTls = sa?.properties?.minimumTlsVersion ?? sa?.minimumTlsVersion ?? "—";
  const url = portalUrlForResourceId(sa?.id);

  const text = [
    "**Azure Storage Account**",
    "",
    "| Name | Resource Group | Location | Kind | SKU | HTTPS-only | Min TLS |",
    "|---|---|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${kind}\` | \`${sku}\` | \`${httpsOnly}\` | \`${minTls}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentLogAnalyticsWorkspace(w: any) {
  const name = w?.name ?? "—";
  const rg = w?.resourceGroup ?? extractRgFromId(w?.id) ?? "—";
  const loc = w?.location ?? "—";
  const sku = w?.sku?.name ?? "—";
  const retention = w?.retentionInDays ?? w?.properties?.retentionInDays ?? "—";
  const url = portalUrlForResourceId(w?.id);

  const text = [
    "**Log Analytics Workspace**",
    "",
    "| Name | Resource Group | Location | SKU | Retention (days) |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${sku}\` | \`${retention}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentVirtualNetwork(vnet: any) {
  const name = vnet?.name ?? "—";
  const rg = vnet?.resourceGroup ?? extractRgFromId(vnet?.id) ?? "—";
  const loc = vnet?.location ?? "—";
  const prefixes = vnet?.addressSpace?.addressPrefixes?.join(", ") ?? "—";
  const ddos = (vnet?.enableDdosProtection || vnet?.ddosProtectionPlan?.id) ? "enabled" : "disabled";
  const url = portalUrlForResourceId(vnet?.id);

  const text = [
    "**Virtual Network**",
    "",
    "| Name | Resource Group | Location | Address Space | DDoS |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${prefixes}\` | \`${ddos}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentSubnet(snet: any) {
  const name = snet?.name ?? "—";
  const rg = extractRgFromId(snet?.id) ?? "—";
  const vnet = snet?.id?.match?.(/virtualNetworks\/([^/]+)/i)?.[1] ?? "—";
  const prefix = snet?.addressPrefix ?? "—";
  const penp = snet?.privateEndpointNetworkPolicies ?? "—";
  const delegs = Array.isArray(snet?.delegations) ? snet.delegations.length : 0;
  const svc = Array.isArray(snet?.serviceEndpoints) ? snet.serviceEndpoints.map((s: any) => s?.service || s).join(", ") : "—";
  const url = portalUrlForResourceId(snet?.id);

  const text = [
    "**Subnet**",
    "",
    "| Name | Resource Group | VNet | Address Prefix | Delegations | Service Endpoints | Private Endpoint Policies |",
    "|---|---|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${vnet}\` | \`${prefix}\` | \`${delegs}\` | \`${svc}\` | \`${penp}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentPrivateEndpoint(pe: any) {
  const name = pe?.name ?? "—";
  const rg = pe?.resourceGroup ?? extractRgFromId(pe?.id) ?? "—";
  const loc = pe?.location ?? "—";
  const vnet = pe?.subnet?.id?.match?.(/virtualNetworks\/([^/]+)/i)?.[1] ?? "—";
  const subnet = pe?.subnet?.id?.split?.("/")?.pop?.() ?? "—";
  const target = pe?.privateLinkServiceConnections?.[0]?.privateLinkServiceId ?? "—";
  const url = portalUrlForResourceId(pe?.id);

  const text = [
    "**Private Endpoint**",
    "",
    "| Name | Resource Group | Location | VNet/Subnet | Target |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${vnet}/${subnet}\` | \`${target}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentAppServicePlan(plan: any) {
  const name = plan?.name ?? "—";
  const rg = plan?.resourceGroup ?? extractRgFromId(plan?.id) ?? "—";
  const loc = plan?.location ?? "—";
  const sku = plan?.sku?.name ?? plan?.properties?.sku?.name ?? "—";
  const status = plan?.properties?.status ?? "—";
  const url = portalUrlForResourceId(plan?.id);

  const text = [
    "**Azure App Service Plan**",
    "",
    "| Name | Resource Group | Location | SKU | Status |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${sku}\` | \`${status}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentFunctionApp(app: any) {
  const name = app?.name ?? "—";
  const rg = app?.resourceGroup ?? extractRgFromId(app?.id) ?? "—";
  const loc = app?.location ?? "—";
  const plan = app?.serverFarmId?.split?.("/")?.pop?.() ?? "—";
  const https = yn(app?.httpsOnly ?? app?.properties?.httpsOnly);
  const tls = app?.properties?.minimumTlsVersion ?? app?.siteConfig?.minTlsVersion ?? "—";
  const ftps = app?.siteConfig?.ftpsState ?? app?.properties?.ftpsState ?? "—";
  const runtime = app?.siteConfig?.linuxFxVersion ?? app?.linuxFxVersion ?? "—";
  const md = [
    "**Azure Function App (Linux)**",
    "",
    "| Name | Resource Group | Location | Plan | Runtime | TLS min | HTTPS-only | FTPS |",
    "|---|---|---|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${plan}\` | \`${runtime}\` | \`${tls}\` | \`${https}\` | \`${ftps}\` |`,
    "",
    portalMarkdownLink(app?.id)
  ].join("\n");
  return mcpText(md);
}

export function presentSqlServer(sql: any) {
  const name = sql?.name ?? "—";
  const rg = extractRgFromId(sql?.id) ?? "—";
  const loc = sql?.location ?? "—";
  const ver = sql?.version ?? sql?.properties?.version ?? "—";
  const aad = yn(sql?.administratorLogin ?? false) === "—" ? "AAD only?" : "SQL login set";
  const url = portalUrlForResourceId(sql?.id);
  const md = [
    "**Azure SQL Server**",
    "",
    "| Name | Resource Group | Location | Version | Login |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${ver}\` | ${aad} |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(md);
}

export function presentSqlDatabase(db: any) {
  const name = db?.name ?? "—";
  const rg = extractRgFromId(db?.id) ?? "—";
  const loc = db?.location ?? "—";
  const sku = db?.sku?.name ?? db?.sku ?? "—";
  const status = db?.status ?? db?.properties?.status ?? "—";
  const url = portalUrlForResourceId(db?.id);
  const md = [
    "**Azure SQL Database**",
    "",
    "| Name | Resource Group | Location | SKU | State |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${sku}\` | \`${status}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(md);
}

export function presentCosmosAccount(acc: any) {
  const name = acc?.name ?? "—";
  const rg = extractRgFromId(acc?.id) ?? "—";
  const loc = acc?.location ?? "—";
  const kind = acc?.kind ?? (acc?.capabilities?.map?.((c: any)=>c?.name).join(", ") || "—");
  const net = acc?.isVirtualNetworkFilterEnabled === true ? "restricted" : "open";
  const url = portalUrlForResourceId(acc?.id);
  const md = [
    "**Azure Cosmos DB Account**",
    "",
    "| Name | Resource Group | Location | Mode/Capabilities | Network Access |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${kind}\` | \`${net}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentRedisCache(r: any) {
  const name = r?.name ?? "—";
  const rg = extractRgFromId(r?.id) ?? "—";
  const loc = r?.location ?? "—";
  const sku = r?.sku?.name ? `${r.sku.name}${r.sku.family ?? ""}${r.sku.capacity ?? ""}` : "—";
  const tls = r?.minimumTlsVersion ?? "—";
  const url = portalUrlForResourceId(r?.id);
  const md = [
    "**Azure Cache for Redis**",
    "",
    "| Name | Resource Group | Location | SKU | Min TLS |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${sku}\` | \`${tls}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentServiceBusNamespace(ns: any) {
  const name = ns?.name ?? "—";
  const rg = extractRgFromId(ns?.id) ?? "—";
  const loc = ns?.location ?? "—";
  const sku = ns?.sku?.name ?? "—";
  const zone = yn(ns?.zoneRedundant);
  const url = portalUrlForResourceId(ns?.id);
  const md = [
    "**Azure Service Bus Namespace**",
    "",
    "| Name | Resource Group | Location | SKU | Zone Redundant |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${sku}\` | \`${zone}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentApiManagement(apim: any) {
  const name = apim?.name ?? "—";
  const rg = extractRgFromId(apim?.id) ?? "—";
  const loc = apim?.location ?? "—";
  const sku = apim?.sku?.name ?? "—";
  const vnet = apim?.virtualNetworkType ?? apim?.properties?.virtualNetworkType ?? "None";
  const url = portalUrlForResourceId(apim?.id);
  const md = [
    "**API Management**",
    "",
    "| Name | Resource Group | Location | SKU | VNet Mode |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${sku}\` | \`${vnet}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentPublicIp(pip: any) {
  const name = pip?.name ?? "—";
  const rg = extractRgFromId(pip?.id) ?? "—";
  const loc = pip?.location ?? "—";
  const sku = pip?.sku?.name ?? "—";
  const alloc = pip?.publicIPAllocationMethod ?? "—";
  const ver = pip?.publicIPAddressVersion ?? "—";
  const url = portalUrlForResourceId(pip?.id);
  const md = [
    "**Public IP**",
    "",
    "| Name | Resource Group | Location | SKU | Allocation | Version |",
    "|---|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${sku}\` | \`${alloc}\` | \`${ver}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentNetworkSecurityGroup(nsg: any) {
  const name = nsg?.name ?? "—";
  const rg = extractRgFromId(nsg?.id) ?? "—";
  const loc = nsg?.location ?? "—";
  const rules = Array.isArray(nsg?.securityRules) ? nsg.securityRules.length : 0;
  const url = portalUrlForResourceId(nsg?.id);
  const md = [
    "**Network Security Group (NSG)**",
    "",
    "| Name | Resource Group | Location | Rules |",
    "|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${rules}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentRouteTable(rt: any) {
  const name = rt?.name ?? "—";
  const rg = extractRgFromId(rt?.id) ?? "—";
  const loc = rt?.location ?? "—";
  const routes = Array.isArray(rt?.routes) ? rt.routes.length : 0;
  const url = portalUrlForResourceId(rt?.id);
  const md = [
    "**Route Table**",
    "",
    "| Name | Resource Group | Location | Routes |",
    "|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${routes}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentPrivateDnsZone(zone: any) {
  const name = zone?.name ?? "—";
  const rg = extractRgFromId(zone?.id) ?? "—";
  const recs = Array.isArray(zone?.recordSets) ? zone.recordSets.length : "—";
  const url = portalUrlForResourceId(zone?.id);
  const md = [
    "**Private DNS Zone**",
    "",
    "| Name | Resource Group | Records |",
    "|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${recs}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentPrivateDnsLink(link: any) {
  const name = link?.name ?? "—";
  const rg = extractRgFromId(link?.id) ?? "—";
  const vnet = link?.virtualNetwork?.id?.split?.("/")?.pop?.() ?? "—";
  const reg = yn(link?.registrationEnabled);
  const url = portalUrlForResourceId(link?.id);
  const md = [
    "**Private DNS Zone Link**",
    "",
    "| Name | Resource Group | VNet | Auto-register |",
    "|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${vnet}\` | \`${reg}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentApplicationInsights(ai: any) {
  const name = ai?.name ?? "—";
  const rg = extractRgFromId(ai?.id) ?? "—";
  const loc = ai?.location ?? "—";
  const appType = ai?.applicationType ?? ai?.kind ?? "—";
  const retention = ai?.retentionInDays ?? ai?.properties?.retentionInDays ?? "—";
  const url = portalUrlForResourceId(ai?.id);
  const md = [
    "**Application Insights**",
    "",
    "| Name | Resource Group | Location | Type | Retention (days) |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${appType}\` | \`${retention}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentAksCluster(mc: any) {
  const name = mc?.name ?? "—";
  const rg = mc?.resourceGroup ?? extractRgFromId(mc?.id) ?? "—";
  const loc = mc?.location ?? "—";
  const ver = mc?.kubernetesVersion ?? "—";
  const pools = Array.isArray(mc?.agentPoolProfiles) ? mc.agentPoolProfiles.length : (mc?.properties?.agentPoolProfiles?.length ?? "—");
  const privateCluster = mc?.apiServerAccessProfile?.enablePrivateCluster === true ? "true" : "false";
  const url = portalUrlForResourceId(mc?.id);

  const text = [
    "**AKS Cluster**",
    "",
    "| Name | Resource Group | Location | Version | Pools | Private Cluster |",
    "|---|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${ver}\` | \`${pools}\` | \`${privateCluster}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : ""
  ].join("\n");
  return mcpText(text);
}

export function presentContainerApp(app: any) {
  const name = app?.name ?? "—";
  const rg = extractRgFromId(app?.id) ?? "—";
  const loc = app?.location ?? "—";
  const env = app?.properties?.environmentId?.split?.("/")?.pop?.() ?? "—";
  const revMode = app?.properties?.managedEnvironmentId ? "Single" : (app?.properties?.configuration?.activeRevisionsMode ?? "—");
  const url = portalUrlForResourceId(app?.id);
  const md = [
    "**Azure Container App**",
    "",
    "| Name | Resource Group | Location | Environment | Revisions |",
    "|---|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${env}\` | \`${revMode}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

export function presentContainerAppsEnv(env: any) {
  const name = env?.name ?? "—";
  const rg = extractRgFromId(env?.id) ?? "—";
  const loc = env?.location ?? "—";
  const zoneRedundant = yn(env?.zoneRedundant);
  const url = portalUrlForResourceId(env?.id);
  const md = [
    "**Container Apps Environment**",
    "",
    "| Name | Resource Group | Location | Zone Redundant |",
    "|---|---|---|---|",
    `| \`${name}\` | \`${rg}\` | \`${loc}\` | \`${zoneRedundant}\` |`,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");
  return mcpText(md);
}

/* Optional: summarize diag settings (LAW) for any resource */
export function presentDiagnosticSettingsSummary(resourceId: string, diagList: any[] = []) {
  const url = portalUrlForResourceId(resourceId);
  const hasLaw = diagList.some((d) => d?.workspaceId);
  const rows = diagList.length
    ? diagList.map((d) => {
        const name = d?.name ?? "—";
        const law = d?.workspaceId ? "`✓ LAW`" : "—";
        const la = d?.logs?.some?.((l: any) => l?.enabled) ? "logs" : "—";
        const mt = d?.metrics?.some?.((m: any) => m?.enabled) ? "metrics" : "—";
        return `| \`${name}\` | ${law} | ${la} | ${mt} |`;
      }).join("\n")
    : "| — | — | — | — |";

  const md = [
    "**Diagnostic Settings**",
    "",
    `LAW connected: **${hasLaw ? "yes" : "no"}**`,
    "",
    "| Name | LAW | Logs | Metrics |",
    "|---|---|---|---|",
    rows,
    "",
    url ? `[Open in Azure Portal](${url})` : "",
  ].join("\n");

  return mcpText(md);
}
