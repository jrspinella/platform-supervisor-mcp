export function mjson(json) { return [{ type: "json", json }]; }
export function mtext(text) { return [{ type: "text", text }]; }
export function normalizeGithubError(e) {
    const status = e?.status ?? e?.response?.status;
    const headers = e?.response?.headers ?? {};
    const requestId = headers["x-github-request-id"] || headers["x-request-id"];
    const message = e?.message || e?.response?.data?.message || "GitHub API error";
    const errors = e?.response?.data?.errors;
    const throttled = status === 429 || (status === 403 && /rate|secondary/i.test(String(message)));
    const retryable = throttled || [502, 503, 504].includes(Number(status));
    const retryAfter = Number(headers["retry-after"]) || undefined;
    return { status: "error", error: { type: "HttpError", statusCode: status, code: e?.name || e?.code, message, details: errors, requestId, throttled, retryable, retryAfterMs: retryAfter ? retryAfter * 1000 : undefined } };
}
export function withGovernance(td, evaluateGovernance) {
    if (!evaluateGovernance) {
        return {
            ...td,
            handler: async (args) => {
                try {
                    const gc = await import("@platform/governance-core");
                    if (gc && typeof gc.evaluate === "function") {
                        const block = await gc.evaluate(td.name, args);
                        if (block.decision === "deny")
                            return { content: [...mjson({ status: "deny", governance: block })], isError: true };
                    }
                    return td.handler(args);
                }
                catch (e) {
                    return { content: [...mjson(normalizeGithubError(e))], isError: true };
                }
            },
        };
    }
    return {
        ...td,
        handler: async (args) => {
            try {
                const block = await evaluateGovernance(td.name, args, { via: "github-core" });
                if (block.decision === "deny")
                    return { content: [...mjson({ status: "deny", governance: block })], isError: true };
                if (block.decision === "warn") {
                    const res = await td.handler(args);
                    return { content: [...mjson({ status: "warn", governance: block }), ...(res?.content ?? [])], isError: res?.isError };
                }
                return td.handler(args);
            }
            catch (e) {
                return { content: [...mjson(normalizeGithubError(e))], isError: true };
            }
        },
    };
}
export function withGovernanceAll(tools, evaluateGovernance) {
    return tools.map((t) => withGovernance(t, evaluateGovernance));
}
export function wrapCreate(name, description, inputSchema, invoke) {
    return { name, description, inputSchema, handler: async (a) => { try {
            const out = await invoke(a);
            return { content: [...mjson(out)] };
        }
        catch (e) {
            return { content: [...mjson(normalizeGithubError(e))], isError: true };
        } } };
}
export function wrapGet(name, description, inputSchema, invoke) {
    return { name, description, inputSchema, handler: async (a) => { try {
            const out = await invoke(a);
            return { content: [...mjson(out)] };
        }
        catch (e) {
            return { content: [...mjson(normalizeGithubError(e))], isError: true };
        } } };
}
export const severityOrder = { unknown: 0, info: 1, low: 2, medium: 3, high: 4 };
export function scanSummary(findings) { const bySeverity = {}; for (const f of findings ?? []) {
    const s = String(f.severity ?? "unknown").toLowerCase();
    bySeverity[s] = (bySeverity[s] ?? 0) + 1;
} return { total: findings?.length ?? 0, bySeverity }; }
export function formatTextSummary(kind, profile, summary) { const sev = summary?.bySeverity ?? {}; const order = ["high", "medium", "low", "info", "unknown"]; const lines = [`### ATO scan (${kind}) — profile: **${profile}**`, `Findings: **${summary.total}**`, ...order.map(k => `- ${k}: ${sev[k] ?? 0}`)]; return lines.join("\n"); }
export function filterFindings(findings = [], opts = {}) { const min = (opts.minSeverity ?? "unknown").toLowerCase(); const minRank = severityOrder[min] ?? 0; const excl = new Set((opts.excludeCodes ?? []).map((c) => c.toUpperCase())); return findings.filter((f) => { const rank = severityOrder[String(f.severity ?? "unknown").toLowerCase()] ?? 0; if (rank < minRank)
    return false; if (f.code && excl.has(String(f.code).toUpperCase()))
    return false; return true; }); }
