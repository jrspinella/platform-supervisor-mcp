import type { ToolDef } from "mcp-http";
import type { GovernanceFn } from "@platform/governance-core";

export function mjson(json: unknown) { return [{ type: "json", json }] as const; }
export function mtext(text: string) { return [{ type: "text", text }] as const; }

// ──────────────────────────────────────────────────────────────
// Error normalization (ARM + pipeline)
// ──────────────────────────────────────────────────────────────
export interface NormalizedAzureError {
  status: "error";
  error: {
    type: string; // AzureError | HttpError | CredentialError | Unknown
    code?: string;
    message: string;
    statusCode?: number;
    requestId?: string;
    target?: string;
    details?: any[];
    throttled?: boolean; // 429
    retryable?: boolean; // 408/429/5xx
    retryAfterMs?: number;
    raw?: any; // trimmed snapshot
  };
}

function parseRetryAfter(headers?: Record<string, string | string[] | undefined>): number | undefined {
  if (!headers) return undefined;
  const h = (headers["retry-after"] ?? headers["Retry-After"]) as any;
  if (!h) return undefined;
  const v = Array.isArray(h) ? h[0] : String(h);
  const asInt = parseInt(v, 10);
  return Number.isFinite(asInt) ? asInt * 1000 : undefined;
}

function tryParseJson(text?: string): any {
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function extractArmError(e: any): {
  statusCode?: number; code?: string; message?: string; details?: any[]; target?: string; requestId?: string; headers?: Record<string, string>;
} {
  const statusCode = e?.statusCode ?? e?.response?.status ?? e?.status;
  const requestId = e?.requestId ?? e?.response?.headers?.["x-ms-request-id"] ?? e?.response?.headers?.["x-ms-correlation-request-id"];
  const headers = e?.response?.headers ?? e?.headers;
  const bodyText: string | undefined = e?.body ?? e?.response?.bodyAsText ?? e?.response?.parsedBody;
  const parsed = typeof bodyText === "string" ? tryParseJson(bodyText) : bodyText;
  const err = parsed?.error ?? e?.details ?? e?.response?.parsedBody?.error ?? e?.parsedBody?.error;
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
  } catch { return undefined; }
}

export function normalizeAzureError(e: any): NormalizedAzureError {
  if (e?.name === "CredentialUnavailableError" || e?.name === "AuthenticationError" || e?.errorMessage?.includes?.("ManagedIdentityCredential")) {
    return { status: "error", error: { type: "CredentialError", message: e?.message || String(e), raw: sanitizeError(e) } };
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

// ──────────────────────────────────────────────────────────────
// Governance wrappers + tool helpers
// ──────────────────────────────────────────────────────────────
export function withGovernance(td: ToolDef, evaluateGovernance?: GovernanceFn): ToolDef {
  if (!evaluateGovernance) {
    return {
      ...td,
      handler: async (args: any) => {
        try {
          const gc = await import("@platform/governance-core");
          if (gc && typeof gc.evaluate === "function") {
            const block = await gc.evaluate(td.name, args);
            if (block.decision === "deny") {
              return { content: [...mjson({ status: "deny", governance: block })], isError: true };
            }
          }
          return td.handler(args);
        } catch (e: any) {
          return { content: [...mjson(normalizeAzureError(e))], isError: true };
        }
      },
    } satisfies ToolDef;
  }
  return {
    ...td,
    handler: async (args: any) => {
      try {
        const block = await evaluateGovernance(td.name, args, { via: "azure-core" });
        if (block.decision === "deny") {
          return { content: [...mjson({ status: "deny", governance: block })], isError: true };
        }
        if (block.decision === "warn") {
          const res = await td.handler(args);
          return { content: [...mjson({ status: "warn", governance: block }), ...(res?.content ?? [])], isError: res?.isError };
        }
        return td.handler(args);
      } catch (e: any) {
        return { content: [...mjson(normalizeAzureError(e))], isError: true };
      }
    },
  } satisfies ToolDef;
}

export function withGovernanceAll(tools: ToolDef[], evaluateGovernance?: GovernanceFn): ToolDef[] {
  return tools.map((t) => withGovernance(t, evaluateGovernance));
}

export function wrapCreate(
  name: string,
  description: string,
  inputSchema: any,
  invoke: (a: any) => Promise<any>
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    handler: async (a: any) => {
      try {
        const out = await invoke(a);
        return { content: [...mjson(out)] };
      } catch (e: any) {
        return { content: [...mjson(normalizeAzureError(e))], isError: true };
      }
    },
  } satisfies ToolDef;
}

export function wrapGet(
  name: string,
  description: string,
  inputSchema: any,
  invoke: (a: any) => Promise<any>
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    handler: async (a: any) => {
      try {
        const out = await invoke(a);
        return { content: [...mjson(out)] };
      } catch (e: any) {
        return { content: [...mjson(normalizeAzureError(e))], isError: true };
      }
    },
  } satisfies ToolDef;
}

/** Coerce unknown tags to a flat string->string record */
export function coerceTags(input: any): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) out[String(k)] = String(v);
  return out;
}

// ──────────────────────────────────────────────────────────────
// Scan helpers: summary + text formatting + filters
// ──────────────────────────────────────────────────────────────
export type ScanFinding = { severity?: string; [k: string]: any };

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
    const rank = severityOrder[String(f.severity ?? "unknown").toLowerCase()] ?? 0;
    if (rank < minRank) return false;
    const code = String((f as any)?.code ?? "").toUpperCase();
    if (code && excl.has(code)) return false;
    return true;
  });
}