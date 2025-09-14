// packages/azure-core/src/utils.ts
import type { ToolDef } from "mcp-http";
import type { GovernanceBlock } from "@platform/governance-core";
import { evaluate as defaultEvaluate } from "@platform/governance-core";

// ──────────────────────────────────────────────────────────────────────────────
// Shared MCP content helpers
// ──────────────────────────────────────────────────────────────────────────────
export type McpContent =
  | { type: "text"; text: string }
  | { type: "json"; json: any };

export const mcpText = (text: string): McpContent[] => [{ type: "text", text }];
export const mcpJson = (json: any): McpContent[] => [{ type: "json", json }];

export type GovernanceFn = (
  toolFq: string,
  args: any,
  ctx?: any
) => Promise<GovernanceBlock> | GovernanceBlock;

// ──────────────────────────────────────────────────────────────────────────────
// Error normalization (Azure/ARM)
// ──────────────────────────────────────────────────────────────────────────────
export interface NormalizedAzureError {
  status: "error";
  error: {
    type: string;
    code?: string;
    message: string;
    statusCode?: number;
    requestId?: string;
    target?: string;
    details?: any[];
    throttled?: boolean;
    retryable?: boolean;
    retryAfterMs?: number;
    raw?: any;
  };
}

function parseRetryAfter(
  headers?: Record<string, string | string[] | undefined>
): number | undefined {
  if (!headers) return undefined;
  const h = (headers["retry-after"] ?? headers["Retry-After"]) as any;
  if (!h) return undefined;
  const v = Array.isArray(h) ? h[0] : String(h);
  const asInt = parseInt(v, 10);
  return Number.isFinite(asInt) ? asInt * 1000 : undefined;
}

function tryParseJson(text?: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractArmError(e: any): {
  statusCode?: number;
  code?: string;
  message?: string;
  details?: any[];
  target?: string;
  requestId?: string;
  headers?: Record<string, string>;
} {
  const statusCode = e?.statusCode ?? e?.response?.status ?? e?.status;
  const requestId =
    e?.requestId ??
    e?.response?.headers?.["x-ms-request-id"] ??
    e?.response?.headers?.["x-ms-correlation-request-id"];
  const headers = e?.response?.headers ?? e?.headers;
  const bodyText: string | undefined =
    e?.body ?? e?.response?.bodyAsText ?? e?.response?.parsedBody;
  const parsed = typeof bodyText === "string" ? tryParseJson(bodyText) : bodyText;
  const err =
    parsed?.error ??
    e?.details ??
    e?.response?.parsedBody?.error ??
    e?.parsedBody?.error;
  const code = e?.code || err?.code;
  const message = e?.message || err?.message;
  const details = err?.details;
  const target = err?.target;
  return { statusCode, code, message, details, target, requestId, headers } as any;
}

function sanitizeError(e: any) {
  try {
    return {
      name: e?.name,
      code: e?.code,
      message: e?.message,
      statusCode: e?.statusCode ?? e?.response?.status,
      requestId: e?.requestId ?? e?.response?.headers?.["x-ms-request-id"],
    };
  } catch {
    return undefined;
  }
}

export function normalizeAzureError(e: any): NormalizedAzureError {
  if (
    e?.name === "CredentialUnavailableError" ||
    e?.name === "AuthenticationError" ||
    e?.errorMessage?.includes?.("ManagedIdentityCredential")
  ) {
    return {
      status: "error",
      error: {
        type: "CredentialError",
        message: e?.message || String(e),
        raw: sanitizeError(e),
      },
    };
  }
  const arm = extractArmError(e);
  const status = arm.statusCode;
  const throttled = status === 429 || /thrott/i.test(arm.code ?? "");
  const retryable = throttled || status === 408 || (typeof status === "number" && status >= 500);
  const retryAfterMs = parseRetryAfter(arm.headers as any);
  const type = typeof status === "number" ? "HttpError" : "AzureError";
  const message = arm.message || e?.message || "Unknown Azure error";
  return {
    status: "error",
    error: {
      type,
      code: arm.code,
      message,
      statusCode: status,
      requestId: arm.requestId,
      target: arm.target,
      details: Array.isArray(arm.details) ? arm.details : undefined,
      throttled,
      retryable,
      retryAfterMs,
      raw: sanitizeError(e),
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Tag parsing/normalization
// ──────────────────────────────────────────────────────────────────────────────
function canonKey(k: string) {
  const m: Record<string, string> = {
    environment: "env",
    env: "env",
    owner: "owner",
    application: "app",
    app: "app",
    project: "project",
  };
  return m[k] || k;
}

/** Parse `owner:jrs, env=dev`, `owner is "Jane"`, or `tags { owner:jrs, env:dev }` → Record */
export function parseLooseTags(
  input: string | undefined
): Record<string, string> | undefined {
  if (!input) return undefined;
  const out: Record<string, string> = {};
  const lower = input.trim();
  const iTags = lower.toLowerCase().indexOf("tags");
  const scope = iTags >= 0 ? lower.slice(iTags + 4) : lower;

  const pairRe =
    /\b([a-z][\w.-]*)\s*(?:=|:|\bis\b)\s*(?:"([^"]+)"|'([^']+)'|([^\s,;{}]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(scope)) !== null) {
    const key = canonKey(m[1].toLowerCase());
    if (key === "tags") continue;
    const val = (m[2] ?? m[3] ?? m[4] ?? "").replace(/[.,;]$/g, "");
    if (key && val) out[key] = val;
  }
  if (Object.keys(out).length) return out;

  const brace = scope.match(/\{([\s\S]*?)\}/);
  if (brace) {
    let mb: RegExpExecArray | null;
    while ((mb = pairRe.exec(brace[1])) !== null) {
      const key = canonKey(mb[1].toLowerCase());
      const val = (mb[2] ?? mb[3] ?? mb[4] ?? "").replace(/[.,;]$/g, "");
      if (key && val) out[key] = val;
    }
    if (Object.keys(out).length) return out;

    try {
      const jsonish =
        "{" +
        brace[1]
          .replace(/([,{]\s*)([A-Za-z_][\w.-]*)\s*:/g, '$1"$2":')
          .replace(/:\s*'([^']*)'/g, ':"$1"') +
        "}";
      const obj = JSON.parse(jsonish);
      for (const [k, v] of Object.entries(obj))
        out[canonKey((k as string).toLowerCase())] = String(v);
      if (Object.keys(out).length) return out;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export function coerceTags(input: any): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[String(k)] = String(v);
  return out;
}

export function normalizeTags(input: any): Record<string, string> | undefined {
  if (typeof input === "string") return parseLooseTags(input);
  return coerceTags(input);
}

// ──────────────────────────────────────────────────────────────────────────────
// Governance presentation card + wrappers
// ──────────────────────────────────────────────────────────────────────────────
const UI_BASE = process.env.UI_BASE_URL || "";

function governanceMarkdown(
  tool: string,
  block?: GovernanceBlock,
  quickCmd?: string
) {
  const header = `### Governance — \`${tool}\`\n`;

  if (!block) return `${header}> ⚪️ No policy applied`;

  const status = String(block.decision || "").toLowerCase();
  const badge =
    status === "deny"
      ? "🔴 **Denied**"
      : status === "warn"
        ? "🟡 **Warn**"
        : "🟢 **Allowed**";

  const controls = (block.controls ?? []).join(", ") || "—";
  const policyCell = `\`${tool}\``;

  const lines: string[] = [
    `${header}**Status:** ${badge}`,
    "",
    "| Policies | NIST Controls |",
    "|---|---|",
    `| ${policyCell} | ${controls} |`,
  ];

  const hasReasons = Array.isArray(block.reasons) && block.reasons.length > 0;
  if (hasReasons && status !== "allow") {
    lines.push("", "**Reasons**", ...block.reasons!.map((r) => `- ${r}`));
  }

  const hasSuggestions =
    Array.isArray(block.suggestions) && block.suggestions.length > 0;
  if (hasSuggestions) {
    lines.push(
      "",
      "**Suggestions**",
      ...block.suggestions!.map((s) =>
        s.title ? `- **${s.title}:** ${s.text}` : `- ${s.text}`
      )
    );
  }

  if (quickCmd && status !== "allow") {
    lines.push("", "**Quick fix**", "```bash", quickCmd, "```");
  }

  return lines.join("\n") + "\n\n"
}

function buildQuickCommand(
  toolFq: string,
  args: any,
  block: GovernanceBlock | undefined
) {
  const route = toolFq.replace(/^platform\./, "");
  const findS = (key: string) =>
    (block?.suggestions ?? []).find(
      (x: any) => x.title && new RegExp(key, "i").test(x.title)
    );
  const name = findS("name")?.text ?? args?.name ?? "";
  const location = findS("region")?.text ?? args?.location ?? "";

  const tagsText = findS("tag")?.text; // "owner: {{upn}}, env: dev"
  const suggestedTags = normalizeTags(tagsText);
  const payload = {
    name,
    location,
    ...(suggestedTags
      ? { tags: suggestedTags }
      : args?.tags
        ? { tags: args.tags }
        : {}),
  };
  return `@platform ${route} ${JSON.stringify(payload)}`;
}

async function maybeLinkToUI(
  toolFq: string,
  block: GovernanceBlock | undefined
) {
  const f = (globalThis as any).fetch as typeof fetch | undefined;
  if (!UI_BASE || typeof f !== "function") return "";
  try {
    const payload = {
      agent: "Platform Engineering Agent",
      route: toolFq,
      status: block?.decision,
      governance: {
        decision: block?.decision,
        reasons: block?.reasons ?? [],
        suggestions: block?.suggestions ?? [],
        controls: block?.controls ?? [],
        policyIds: [toolFq],
      },
    };
    const resp = await f(`${UI_BASE}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "governance", payload }),
    });
    if (resp.ok) {
      const { id } = await resp.json();
      return `\n\n[Open full UI](${UI_BASE}/reports/governance/${id})`;
    }
  } catch {
    // ignore
  }
  return "";
}

export async function presentGovernance(
  toolFq: string,
  args: any,
  block: GovernanceBlock | undefined
) {
  const quick = buildQuickCommand(toolFq, args, block);
  const md = governanceMarkdown(toolFq, block, quick);
  const link = await maybeLinkToUI(toolFq, block);
  return mcpText(md + link);
}

/** Harvest tags from free-form args fields if tags are missing */
export function harvestTagsFromArgs(args: any): Record<string, string> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const candidates: string[] = [];

  const KEYS = [
    "tags",
    "tagString",
    "text",
    "prompt",
    "note",
    "description",
    "raw",
    "utterance",
    "input",
    "message",
    "command",
  ];

  for (const k of KEYS) {
    const v = (args as any)[k];
    if (typeof v === "string" && v.length <= 4000) candidates.push(v);
  }
  const cx = (args as any).context || {};
  for (const k of KEYS) {
    const v = cx[k];
    if (typeof v === "string" && v.length <= 4000) candidates.push(v);
  }
  if (typeof (args as any)._raw === "string") candidates.push((args as any)._raw);

  let out: Record<string, string> | undefined;
  for (const s of candidates) {
    const parsed = parseLooseTags(s);
    if (parsed) out = { ...(out || {}), ...parsed };
  }
  return out;
}

/** Normalize args (notably tags) before governance evaluation */
function normalizeArgsForGovernance(args: any) {
  if (!args || typeof args !== "object") return args;
  const out = { ...args };
  let tags = normalizeTags(out.tags);
  if (!tags) tags = harvestTagsFromArgs(out);
  if (tags) out.tags = tags;
  return out;
}

export function withGovernance(td: ToolDef, evaluateGovernance?: GovernanceFn): ToolDef {
  const originalHandler = td.handler;
  return {
    ...td,
    handler: async (args: any) => {
      const normArgs = normalizeArgsForGovernance(args);
      try {
        const block = evaluateGovernance
          ? await Promise.resolve(
            evaluateGovernance(td.name, normArgs, normArgs?.context ?? {})
          )
          : await Promise.resolve(
            defaultEvaluate(td.name, normArgs, normArgs?.context ?? {})
          );

        const govContent = presentGovernance(td.name, normArgs, block);

        if (block.decision === "deny") {
          return {
            content: [...(await govContent)],
            isError: true,
            _meta: { governance: block, blocked: true },
          };
        }

        const res = await originalHandler(args);

        // If the inner handler already added governance, don't prepend again
        const alreadyGoverned = !!(res as any)?._meta?.governance;
        if (alreadyGoverned) {
          return res;
        }
        if (res && Array.isArray(res.content)) {
          return {
            ...res,
            content: [...(await govContent), ...res.content],
            _meta: { ...(res._meta || {}), governance: block, blocked: false },
          };
        }
        return {
          content: [...(await govContent), ...mcpJson(res)],
          _meta: { governance: block, blocked: false },
        };
      } catch (e: any) {
        return { content: [...mcpJson(normalizeAzureError(e))], isError: true };
      }
    },
  } as ToolDef;
}

export function withGovernanceAll(
  tools: ToolDef[],
  evaluateFn: GovernanceFn = defaultEvaluate
): ToolDef[] {
  return tools.map((t) => withGovernance(t, evaluateFn));
}

// ──────────────────────────────────────────────────────────────────────────────
/** Governed wrappers for create/get tools with UX & error handling baked in */
// ──────────────────────────────────────────────────────────────────────────────
export function wrapCreate(
  name: string,
  description: string,
  inputSchema: any,
  invoke: (a: any) => Promise<any>,
  options?: {
    present?: (out: any, args: any) => McpContent[] | undefined;
    evaluateGovernance?: GovernanceFn;
    governed?: boolean;
  }
): ToolDef {
  const governed = options?.governed !== false;
  const evalGov = options?.evaluateGovernance ?? defaultEvaluate;

  return {
    name,
    description,
    inputSchema,
    handler: async (args: any) => {
      const normArgs = normalizeArgsForGovernance(args);

      let govBlock: GovernanceBlock | undefined;
      let govContent: McpContent[] = [];

      try {
        if (governed) {
          govBlock = await Promise.resolve(
            evalGov(name, normArgs, normArgs?.context ?? {})
          );
          govContent = await presentGovernance(name, normArgs, govBlock);
          if (govBlock.decision === "deny") {
            return {
              content: [...govContent],
              isError: true,
              _meta: { governance: govBlock, blocked: true },
            };
          }
        }

        const out = await invoke(args);
        const pretty = options?.present ? options.present(out, args) : undefined;

        const base = { ...(govBlock ? { governance: govBlock, blocked: false } : {}) };

        return {
          content: [...govContent, ...(pretty ?? []), ...mcpJson(out)],
          _meta: base,
        };
      } catch (e: any) {
        const err = normalizeAzureError(e);
        return {
          content: [...govContent, ...mcpJson(err)],
          isError: true,
          _meta: govBlock ? { governance: govBlock, blocked: false } : undefined,
        };
      }
    },
  } satisfies ToolDef;
}

export function wrapGet(
  name: string,
  description: string,
  inputSchema: any,
  invoke: (a: any) => Promise<any>,
  options?: {
    present?: (out: any, args: any) => McpContent[] | undefined;
    evaluateGovernance?: GovernanceFn;
    governed?: boolean;
  }
): ToolDef {
  const governed = options?.governed !== false;
  const evalGov = options?.evaluateGovernance ?? defaultEvaluate;

  return {
    name,
    description,
    inputSchema,
    handler: async (args: any) => {
      const normArgs = normalizeArgsForGovernance(args);

      let govBlock: GovernanceBlock | undefined;
      let govContent: McpContent[] = [];

      try {
        if (governed) {
          govBlock = await Promise.resolve(
            evalGov(name, normArgs, normArgs?.context ?? {})
          );
          govContent = await presentGovernance(name, normArgs, govBlock);
          if (govBlock.decision === "deny") {
            return {
              content: [...govContent],
              isError: true,
              _meta: { governance: govBlock, blocked: true },
            };
          }
        }

        const out = await invoke(args);
        const pretty = options?.present ? options.present(out, args) : undefined;

        return {
          content: [...govContent, ...(pretty ?? []), ...mcpJson(out)],
          _meta: govBlock ? { governance: govBlock, blocked: false } : undefined,
        };
      } catch (e: any) {
        const err = normalizeAzureError(e);
        return {
          content: [...govContent, ...mcpJson(err)],
          isError: true,
          _meta: govBlock ? { governance: govBlock, blocked: false } : undefined,
        };
      }
    },
  } satisfies ToolDef;
}

// ──────────────────────────────────────────────────────────────────────────────
// Resource presenters (nice, compact cards + portal links)
// ──────────────────────────────────────────────────────────────────────────────
export function portalUrlForResourceId(resourceId: string) {
  const isGov =
    (process.env.AZURE_AUTHORITY_HOST || "").includes("login.microsoftonline.us") ||
    process.env.AZURE_CLOUD === "usgovernment";
  const base = isGov ? "https://portal.azure.us" : "https://portal.azure.com";
  return `${base}/#resource${resourceId}/overview`;
}

export function extractRgFromId(id?: string) {
  const m = id?.match(/\/resourceGroups\/([^/]+)/i);
  return m?.[1];
}

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

// ──────────────────────────────────────────────────────────────────────────────
// Scan helpers
// ──────────────────────────────────────────────────────────────────────────────
export type ScanFinding = { severity?: string;[k: string]: any };

export function scanSummary(findings: ScanFinding[] | undefined) {
  const bySeverity: Record<string, number> = {};
  for (const f of findings ?? []) {
    const sev = String(f?.severity ?? "unknown").toLowerCase();
    bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
  }
  return { total: findings?.length ?? 0, bySeverity };
}

export function formatTextSummary(
  kind: string,
  profile: string,
  summary: { total: number; bySeverity: Record<string, number> }
) {
  const sev = summary?.bySeverity ?? ({} as Record<string, number>);
  const ordered = ["high", "medium", "low", "info", "unknown"] as const;
  const extras = Object.keys(sev)
    .filter((k) => !ordered.includes(k as any))
    .sort();
  const lines: string[] = [
    `### ATO scan (${kind}) — profile: **${profile}**`,
    `Findings: **${summary?.total ?? 0}**`,
    ...ordered.map((k) => `- ${k}: ${sev[k] ?? 0}`),
    ...extras.map((k) => `- ${k}: ${sev[k] ?? 0}`),
  ];
  return lines.join("\n");
}

export const severityOrder: Record<string, number> = {
  unknown: 0,
  info: 1,
  low: 2,
  medium: 3,
  high: 4,
};

export function filterFindings(
  findings: ScanFinding[] = [],
  opts: { minSeverity?: string; excludeCodes?: string[] } = {}
) {
  const min = (opts.minSeverity ?? "unknown").toLowerCase();
  const minRank = severityOrder[min] ?? 0;
  const excl = new Set((opts.excludeCodes ?? []).map((c) => c.toUpperCase()));
  return findings.filter((f) => {
    const rank =
      severityOrder[String(f.severity ?? "unknown").toLowerCase()] ?? 0;
    if (rank < minRank) return false;
    const code = String((f as any)?.code ?? "").toUpperCase();
    if (code && excl.has(code)) return false;
    return true;
  });
}