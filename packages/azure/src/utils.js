export function mjson(json) { return [{ type: "json", json }]; }
export function mtext(text) { return [{ type: "text", text }]; }
function parseRetryAfter(headers) {
    if (!headers)
        return undefined;
    const h = (headers["retry-after"] ?? headers["Retry-After"]);
    if (!h)
        return undefined;
    const v = Array.isArray(h) ? h[0] : String(h);
    const asInt = parseInt(v, 10);
    return Number.isFinite(asInt) ? asInt * 1000 : undefined;
}
function tryParseJson(text) {
    if (!text)
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function extractArmError(e) {
    const statusCode = e?.statusCode ?? e?.response?.status ?? e?.status;
    const requestId = e?.requestId ?? e?.response?.headers?.["x-ms-request-id"] ?? e?.response?.headers?.["x-ms-correlation-request-id"];
    const headers = e?.response?.headers ?? e?.headers;
    const bodyText = e?.body ?? e?.response?.bodyAsText ?? e?.response?.parsedBody;
    const parsed = typeof bodyText === "string" ? tryParseJson(bodyText) : bodyText;
    const err = parsed?.error ?? e?.details ?? e?.response?.parsedBody?.error ?? e?.parsedBody?.error;
    const code = e?.code || err?.code;
    const message = e?.message || err?.message;
    const details = err?.details;
    const target = err?.target;
    return { statusCode, code, message, details, target, requestId, headers };
}
function sanitizeError(e) {
    try {
        return {
            name: e?.name,
            code: e?.code,
            message: e?.message,
            statusCode: e?.statusCode ?? e?.response?.status,
            requestId: e?.requestId ?? e?.response?.headers?.["x-ms-request-id"],
        };
    }
    catch {
        return undefined;
    }
}
export function normalizeAzureError(e) {
    if (e?.name === "CredentialUnavailableError" || e?.name === "AuthenticationError" || e?.errorMessage?.includes?.("ManagedIdentityCredential")) {
        return { status: "error", error: { type: "CredentialError", message: e?.message || String(e), raw: sanitizeError(e) } };
    }
    const arm = extractArmError(e);
    const status = arm.statusCode;
    const throttled = status === 429 || /thrott/i.test(arm.code ?? "");
    const retryable = throttled || status === 408 || (typeof status === "number" && status >= 500);
    const retryAfterMs = parseRetryAfter(arm.headers);
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
export function withGovernance(td, evaluateGovernance) {
    if (!evaluateGovernance) {
        return {
            ...td,
            handler: async (args) => {
                try {
                    const gc = await import("@platform/governance-core");
                    if (gc && typeof gc.evaluate === "function") {
                        const block = await gc.evaluate(td.name, args);
                        if (block.decision === "deny") {
                            return { content: [...mjson({ status: "deny", governance: block })], isError: true };
                        }
                    }
                    return td.handler(args);
                }
                catch (e) {
                    return { content: [...mjson(normalizeAzureError(e))], isError: true };
                }
            },
        };
    }
    return {
        ...td,
        handler: async (args) => {
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
            }
            catch (e) {
                return { content: [...mjson(normalizeAzureError(e))], isError: true };
            }
        },
    };
}
export function withGovernanceAll(tools, evaluateGovernance) {
    return tools.map((t) => withGovernance(t, evaluateGovernance));
}
export function wrapCreate(name, description, inputSchema, invoke) {
    return {
        name,
        description,
        inputSchema,
        handler: async (a) => {
            try {
                const out = await invoke(a);
                return { content: [...mjson(out)] };
            }
            catch (e) {
                return { content: [...mjson(normalizeAzureError(e))], isError: true };
            }
        },
    };
}
export function wrapGet(name, description, inputSchema, invoke) {
    return {
        name,
        description,
        inputSchema,
        handler: async (a) => {
            try {
                const out = await invoke(a);
                return { content: [...mjson(out)] };
            }
            catch (e) {
                return { content: [...mjson(normalizeAzureError(e))], isError: true };
            }
        },
    };
}
/** Coerce unknown tags to a flat string->string record */
export function coerceTags(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return undefined;
    const out = {};
    for (const [k, v] of Object.entries(input))
        out[String(k)] = String(v);
    return out;
}
export function scanSummary(findings) {
    const bySeverity = {};
    for (const f of findings ?? []) {
        const sev = String(f?.severity ?? "unknown").toLowerCase();
        bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
    }
    return { total: findings?.length ?? 0, bySeverity };
}
export function formatTextSummary(kind, profile, summary) {
    const sev = summary?.bySeverity ?? {};
    const ordered = ["high", "medium", "low", "info", "unknown"];
    const extras = Object.keys(sev)
        .filter((k) => !ordered.includes(k))
        .sort();
    const lines = [
        `### ATO scan (${kind}) — profile: **${profile}**`,
        `Findings: **${summary?.total ?? 0}**`,
        ...ordered.map((k) => `- ${k}: ${sev[k] ?? 0}`),
        ...extras.map((k) => `- ${k}: ${sev[k] ?? 0}`),
    ];
    return lines.join("\n");
}
export const severityOrder = {
    unknown: 0,
    info: 1,
    low: 2,
    medium: 3,
    high: 4,
};
export function filterFindings(findings = [], opts = {}) {
    const min = (opts.minSeverity ?? "unknown").toLowerCase();
    const minRank = severityOrder[min] ?? 0;
    const excl = new Set((opts.excludeCodes ?? []).map((c) => c.toUpperCase()));
    return findings.filter((f) => {
        const rank = severityOrder[String(f.severity ?? "unknown").toLowerCase()] ?? 0;
        if (rank < minRank)
            return false;
        const code = String(f?.code ?? "").toUpperCase();
        if (code && excl.has(code))
            return false;
        return true;
    });
}
