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

function ensureTrailingBlank(md: string) {
  return /\n\n$/.test(md) ? md : md.replace(/\s*$/, "") + "\n\n";
}

// ──────────────────────────────────────────────────────────────────────────────
// Governance presentation card + wrappers
// ──────────────────────────────────────────────────────────────────────────────
const UI_BASE = process.env.UI_BASE_URL || "";

function governanceMarkdown(tool: string, block?: GovernanceBlock, quickCmd?: string) {
  const header = `\n\n### Governance — \`${tool}\`\n`;
  if (!block) return `${header}> ⚪️ No policy applied\n`;

  const status = String(block.decision || "").toLowerCase();
  const badge =
    status === "deny" ? "🔴 **Denied**" :
    status === "warn" ? "🟡 **Warn**" :
    "🟢 **Allowed**";

  const lines: string[] = [`${header}**Status:** ${badge}`];

  // Only show grid + reasons/suggestions when NOT allowed
  if (status !== "allow") {
    const controls = (block.controls ?? []).join(", ") || "—";
    lines.push(
      "",
      "| Policies | NIST Controls |",
      "|---|---|",
      `| \`${tool}\` | ${controls} |`,
    );

    if (Array.isArray(block.reasons) && block.reasons.length) {
      lines.push("", "**Reasons**", ...block.reasons.map(r => `- ${r}`));
    }
    if (Array.isArray(block.suggestions) && block.suggestions.length) {
      lines.push(
        "",
        "**Suggestions**",
        ...block.suggestions.map(s => s.title ? `- **${s.title}:** ${s.text}` : `- ${s.text}`)
      );
    }
    if (quickCmd) {
      lines.push("", "**Quick fix**", "```bash", quickCmd, "```");
    }
  }

  lines.push(""); // trailing newline for clean separation
  return lines.join("\n");
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
  // 👇 ensure at least one blank line after governance so the next block starts cleanly
  return mcpText(ensureTrailingBlank(md + link));
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
// Scan helpers
// ──────────────────────────────────────────────────────────────────────────────
export type ScanFinding = {
  code: string;
  severity?: string;
  controlIds?: string[];
  suggest?: string;
  meta?: Record<string, any>;
  [k: string]: any
};

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
