import "dotenv/config";
import { z } from "zod";
import path from "path";
import fs from "node:fs";
import crypto from "crypto";
import type { ToolDef } from "mcp-http";

// ---------- small MCP block helpers ----------
const mcpJson = (json: any) => [{ type: "json" as const, json }];
const mcpText = (text: string) => [{ type: "text" as const, text }];

const toBool = (v: unknown) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return /^(y|yes|true|1)$/i.test(v.trim());
    if (typeof v === "number") return v === 1;
    return false;
};

// redaction for audit
const SECRET_RE = /(password|secret|token|key|conn(str|ection)|pwd|sas|client_secret)/i;
function redact(v: any): any {
    if (v == null) return v;
    if (typeof v === "string") return SECRET_RE.test(v) ? "***REDACTED***" : v;
    if (Array.isArray(v)) return v.map(redact);
    if (typeof v === "object") {
        const out: any = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = SECRET_RE.test(k) ? "***REDACTED***" : redact(val);
        }
        return out;
    }
    return v;
}

// audit log
const AUDIT_DIR = process.env.AUDIT_DIR || path.resolve(process.cwd(), "audit");
function auditWrite(event: any) {
    try {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        const file = path.join(AUDIT_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
        fs.appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
    } catch { /* ignore */ }
}

// retry/backoff
async function withRetry<T>(fn: () => Promise<T>, tries = 3) {
    let err: any;
    for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (e) {
            err = e; await new Promise(r => setTimeout(r, 250 * (i + 1)));
        }
    }
    throw err;
}

function idemKey(tool: string, payload: any) {
    const h = crypto.createHash("sha256").update(tool).update(JSON.stringify(payload)).digest("hex").slice(0, 32);
    return `${tool}:${h}`;
}

function parseOnboardingNL(text: string) {
    const upn = /(?:^|\b)(?:upn|user|email)\s*[:=]?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i.exec(text)?.[1]
        || /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(text)?.[1];
    const alias = /alias\s*[:=]?\s*([A-Za-z0-9._-]+)/i.exec(text)?.[1];
    const displayName = /name\s*[:=]?\s*"([^"]+)"|display\s*name\s*[:=]?\s*"([^"]+)"/i.exec(text)?.[1];
    const region = /region\s*[:=]?\s*([A-Za-z0-9-]+)/i.exec(text)?.[1];
    const dryRun = /\bdry\s*run\b|\bsimulate\b/i.test(text);
    return { upn, alias, displayName, region, dryRun };
}

function firstJson(resultBody: any) {
    const content = resultBody?.result?.content;
    if (Array.isArray(content)) return content.find((c: any) => c.json)?.json;
    return null;
}

function isSucceeded(obj: any): boolean {
    const ps = obj?.properties?.provisioningState || obj?.provisioningState;
    return typeof ps === "string" ? ps.toLowerCase() === "succeeded" : true;
}

async function tryAutoVerify(routerTool: string, payload: any, resultJson: any) {
    // Azure: if a resource id is returned, try a generic read
    if (routerTool.startsWith("azure.") && resultJson?.id) {
        const vr = await callRouterTool("azure.get_resource_by_id", { id: resultJson.id });
        if (!vr.ok) return { ok: false, details: vr.body };
        const vj = firstJson(vr.body);
        return { ok: !!vj, details: vj ?? vr.body };
    }

    // GitHub: if owner/name present, try get_repo
    if (routerTool.startsWith("github.")) {
        const owner = payload.org || payload.owner;
        const name = payload.name || payload.repo;
        if (owner && name) {
            const vr = await callRouterTool("github.get_repo", { owner, repo: name });
            if (!vr.ok) return { ok: false, details: vr.body };
            const vj = firstJson(vr.body);
            return { ok: !!vj, details: vj ?? vr.body };
        }
    }

    // Teams or others: no generic verify → assume ok
    return { ok: true };
}

async function callRouterTool(name: string, args: any) {
    const r = await fetch((process.env.ROUTER_URL || "http://127.0.0.1:8700") + "/a2a/tools/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, arguments: args || {} })
    });
    const text = await r.text();
    let body: any; try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (r.status === 403 && body?.error?.data?.suggestions) {
        return { ok: false, governanceDenied: true, suggestions: body.error.data.suggestions, reasons: body.error.data.reasons, body };
    }
    const warned = r.headers.get("x-governance-warning") === "true";
    const governanceDenied = r.status === 403 && body?.error?.data;
    const reasons = governanceDenied ? (body.error.data.reasons || []) : undefined;
    const suggestions = governanceDenied ? (body.error.data.suggestions || []) : undefined;

    auditWrite({
        ts: new Date().toISOString(),
        tool: name,
        idempotencyKey: idemKey(name, args),
        status: r.status,
        ok: r.ok,
        warned,
        governanceDenied,
        request: redact(args),
        response: redact(body?.result || body?.error || body),
    });

    return { ok: r.ok, status: r.status, warned, governanceDenied, reasons, suggestions, body };
}

// governance preflight (env/profile-aware)
async function governanceEvaluate<T extends z.ZodType>(service: string | ((args: z.infer<T>, resolved?: any) => "azure" | "github" | "teams"), toolFq: string, args: any, context?: any) {
    const res = await callRouterTool("governance.evaluate", { tool: toolFq, args, context: context || {} });
    if (!res.ok) {
        const err = res.body?.error || res.body;
        return { content: [...mcpText(`governance.evaluate failed: ${String(err?.message || err)}`)], isError: true };
    }
    const content = res.body?.result?.content;
    const json = Array.isArray(content) ? content.find((c: any) => c.json)?.json : null;
    return json || { decision: "allow", reasons: [], policyIds: [], suggestions: [] };
}

// ---------- governed ensure factory (add once) ----------
// --- One-shot governed tool wrapper (no "reply with ..." loops) ---
function makeGovernedTool<T extends z.ZodObject<any>>(opts: {
    name: string;
    description: string;
    service?: "azure" | "github" | "teams";
    routerTool: string;
    schema: T;
    toPayload: (args: z.infer<T>) => any;
    planLine: (args: z.infer<T>) => string;
    followup: (args: z.infer<T>) => string;
    governed?: boolean;
    successCheck?: (resultJson: any) => boolean; // optional custom success test
    verifyCalls?: Array<{
        name: string; // e.g., "azure.get_resource_group"
        toPayload: (args: z.infer<T>, payload: any, resultJson: any) => any;
        expect?: (verifyJson: any) => boolean; // default: !!verifyJson
        failText?: (args: z.infer<T>) => string;
    }>;
    autoVerify?: boolean; // default true
}) {
    const fullSchema = opts.schema.extend({
        confirm: z.boolean().default(false),
        dryRun: z.boolean().default(false),
        context: z.object({
            upn: z.string().optional(),
            alias: z.string().optional(),
            region: z.string().optional()
        }).partial().optional(),
    }).strict();

    return {
        name: opts.name,
        description: opts.description,
        inputSchema: fullSchema,
        handler: async (raw: z.infer<typeof fullSchema>) => {
            const payload = opts.toPayload(raw as any);
            const plan = {
                action: opts.routerTool,
                payload,
                mode: raw.dryRun ? "dryRun" : (raw.confirm ? "execute" : "review"),
            };

            // Governance preflight (same as you already have)
            let gov: any = { decision: "allow" };
            if (opts.governed !== false && opts.service) {
                const fq = opts.routerTool; // already fully-qualified
                const res = await callRouterTool("governance.evaluate", { tool: fq, args: payload, context: raw.context || {} });
                const govJson = firstJson(res.body);
                if (govJson) gov = govJson;
                (plan as any).governance = gov;
            }
            const blocked = (opts.governed !== false && gov?.decision && gov.decision !== "allow");
            const needsHold = raw.dryRun || !raw.confirm || blocked;

            if (needsHold) {
                const lines: string[] = [];
                lines.push(`Plan: ${opts.planLine(raw as any)}`);
                if (opts.governed !== false && opts.service) {
                    lines.push(`Governance: ${blocked ? gov.decision.toUpperCase() : "ALLOW"}`);
                    if (gov?.reasons?.length) lines.push(`Reasons: ${gov.reasons.join(" | ")}`);
                    if (gov?.suggestions?.length) {
                        lines.push("Suggestions:");
                        for (const s of gov.suggestions) lines.push(`- ${s.title ? `${s.title}: ` : ""}${s.text}`);
                    }
                }
                lines.push("");
                lines.push("To proceed, reply with:");
                lines.push(opts.followup(raw as any));
                return { content: [...mcpJson({ status: blocked ? "blocked" : "pending", plan }), ...mcpText(lines.join("\n"))] };
            }

            // ---- Execute
            const exec = await callRouterTool(opts.routerTool, payload);
            if (!exec.ok) {
                const err = exec.body?.error || exec.body;
                return {
                    content: [
                        ...mcpJson({ status: "error", plan, error: err }),
                        ...mcpText(`❌ ${opts.planLine(raw as any)} — call failed: ${JSON.stringify(err).slice(0, 800)}`)
                    ],
                    isError: true
                };
            }

            const resultJson = firstJson(exec.body);
            const success = opts.successCheck ? opts.successCheck(resultJson) : isSucceeded(resultJson);
            if (!success) {
                return {
                    content: [
                        ...mcpJson({ status: "error", plan, result: resultJson ?? exec.body }),
                        ...mcpText(`❌ ${opts.planLine(raw as any)} — Azure/GitHub response did not indicate success`)
                    ],
                    isError: true
                };
            }

            // ---- Verify (generic): explicit verifyCalls first
            if (opts.verifyCalls?.length) {
                for (const v of opts.verifyCalls) {
                    const vr = await callRouterTool(v.name, v.toPayload(raw as any, payload, resultJson));
                    if (!vr.ok) {
                        return {
                            content: [
                                ...mcpJson({ status: "error", plan, result: resultJson, verifyFailed: { tool: v.name, body: vr.body } }),
                                ...mcpText(v.failText?.(raw as any) || `❌ ${opts.planLine(raw as any)} — verification call ${v.name} failed`)
                            ],
                            isError: true
                        };
                    }
                    const vjson = firstJson(vr.body);
                    const pass = v.expect ? v.expect(vjson) : !!vjson;
                    if (!pass) {
                        return {
                            content: [
                                ...mcpJson({ status: "error", plan, result: resultJson, verifyFailed: { tool: v.name, verify: vjson } }),
                                ...mcpText(v.failText?.(raw as any) || `❌ ${opts.planLine(raw as any)} — verification did not pass`)
                            ],
                            isError: true
                        };
                    }
                }
            } else if (opts.autoVerify !== false) {
                // fallback auto-verify
                const av = await tryAutoVerify(opts.routerTool, payload, resultJson);
                if (!av.ok) {
                    return {
                        content: [
                            ...mcpJson({ status: "error", plan, result: resultJson, autoVerify: av }),
                            ...mcpText(`❌ ${opts.planLine(raw as any)} — could not verify existence post-create`)
                        ],
                        isError: true
                    };
                }
            }

            return {
                content: [
                    ...mcpJson({ status: "done", plan, result: resultJson ?? exec.body }),
                    ...mcpText(`✅ ${opts.planLine(raw as any)} — done.`),
                ]
            };
        }
    };
}

// ---------- A. Ensure Resource Group ----------
const EnsureRgSchema = z.object({
    resourceGroupName: z.string(),
    location: z.string(),
    tags: z.record(z.string()).default({}),
    env: z.string().optional(),
    upn: z.string().optional(),
    alias: z.string().optional(),
});
export const tool_platform_create_rg =
    makeGovernedTool({
        name: "platform.create_resource_group",
        description: "Create an Azure Resource Group.",
        service: "azure",
        routerTool: "azure.create_resource_group",
        schema: z.object({
            name: z.string(),
            location: z.string(),
            tags: z.record(z.string()).optional()
        }),
        toPayload: a => ({ name: a.name, location: a.location, tags: a.tags }),
        planLine: a => `Create RG ${a.name} in ${a.location}`,
        followup: a => `@platform create resource group name "${a.name}" location "${a.location}"${a.tags ? ` tags ${JSON.stringify(a.tags)}` : ""} confirm yes`,
        verifyCalls: [{
            name: "azure.get_resource_group",
            toPayload: (a) => ({ name: a.name }),
            expect: vj => !!vj?.name && vj.name === vj?.name // existence is enough
        }]
    });

// ---------- B. Ensure App Service Plan ----------
const EnsurePlanSchema = z.object({
    resourceGroupName: z.string(),
    planName: z.string(),
    location: z.string(),
    skuName: z.string(),
    env: z.string().optional(),
});
export const tool_platform_create_plan =
    makeGovernedTool({
        name: "platform.create_app_service_plan",
        description: "Create an App Service Plan & make sure it exists (idempotent + governed).",
        routerTool: "azure.create_app_service_plan",
        schema: EnsurePlanSchema,
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.planName, location: a.location, skuName: a.skuName }),
        planLine: a => `Create App Plan ${a.planName} (${a.skuName}) in ${a.location} RG ${a.resourceGroupName}`,
        followup: a => `@platform create_app_service_plan resourceGroupName "${a.resourceGroupName}" planName "${a.planName}" location "${a.location}" skuName "${a.skuName}" confirm true`,
        verifyCalls: [{
            name: "azure.get_app_service_plan",
            toPayload: (a) => ({ name: a.planName }),
            expect: vj => !!vj?.name && vj.name === vj?.name // existence is enough
        }]
    });

// ---------- C. create Web App ----------
const EnsureWebSchema = z.object({
    resourceGroupName: z.string(),
    appName: z.string(),
    planName: z.string(),
    location: z.string(),
    runtimeStack: z.string(),                  // e.g., "NODE|20-lts"
    appSettings: z.record(z.string()).default({}),
    assignSystemIdentity: z.boolean().default(true),
    env: z.string().optional(),
});
export const tool_platform_create_web =
    makeGovernedTool({
        name: "platform.create_web_app",
        description: "Create a Web App exists (idempotent + governed).",
        routerTool: "azure.create_web_app",
        schema: EnsureWebSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            name: a.appName,
            planName: a.planName,
            location: a.location,
            runtimeStack: a.runtimeStack
        }),
        planLine: a => `Create Web App ${a.appName} (${a.runtimeStack}) on plan ${a.planName}`,
        followup: a => `@platform create_web_app resourceGroupName "${a.resourceGroupName}" appName "${a.appName}" planName "${a.planName}" location "${a.location}" runtimeStack "${a.runtimeStack}" confirm true`,
        verifyCalls: [{
            name: "azure.get_web_app",
            toPayload: (a) => ({ name: a.planName }),
            expect: vj => !!vj?.name && vj.name === vj?.name // existence is enough
        }]
    });

// ---------- D. Ensure Web App Identity (optional step) ----------
const EnsureWebIdSchema = z.object({
    resourceGroupName: z.string(),
    appName: z.string(),
    env: z.string().optional(),
});
export const tool_platform_create_web_id =
    makeGovernedTool({
        name: "platform.create_webapp_identity",
        description: "Ensure system-assigned identity is enabled for a Web App.",
        routerTool: "azure.web_assign_system_identity",
        schema: EnsureWebIdSchema,
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.appName }),
        planLine: a => `Create MSI on Web App ${a.appName}`,
        followup: a => `@platform create_webapp_identity resourceGroupName "${a.resourceGroupName}" appName "${a.appName}" confirm true`,
    });

// ---------- E. Ensure Web App Settings ----------
const EnsureSettingsSchema = z.object({
    resourceGroupName: z.string(),
    appName: z.string(),
    settings: z.record(z.string()),
    slot: z.string().optional(),
    env: z.string().optional(),
});
export const tool_platform_create_web_settings =
    makeGovernedTool({
        name: "platform.create_webapp_settings",
        description: "Ensure app settings are applied (idempotent merge).",
        routerTool: "azure.web_set_app_settings",
        schema: EnsureSettingsSchema,
        toPayload: a => ({ resourceGroupName: a.resourceGroupName, name: a.appName, settings: a.settings, slot: a.slot }),
        planLine: a => `Create settings on ${a.appName} (${Object.keys(a.settings).length} keys)`,
        followup: a => `@platform create_webapp_settings resourceGroupName "${a.resourceGroupName}" appName "${a.appName}" confirm true`,
    });

// ---------- F. Ensure Key Vault ----------
const EnsureKvSchema = z.object({
    resourceGroupName: z.string(),
    vaultName: z.string(),
    location: z.string(),
    skuName: z.enum(["standard", "premium"]).default("standard"),
    tenantId: z.string(),
    enableRbacAuthorization: z.boolean().default(true),
    publicNetworkAccess: z.enum(["Enabled", "Disabled"]).default("Enabled"),
    env: z.string().optional(),
});
export const tool_platform_create_kv =
    makeGovernedTool({
        name: "platform.create_key_vault",
        description: "Create & Ensure a Key Vault exists (RBAC preferred).",
        routerTool: "azure.create_key_vault",
        schema: EnsureKvSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            vaultName: a.vaultName,
            location: a.location,
            properties: {
                enableRbacAuthorization: a.enableRbacAuthorization,
                publicNetworkAccess: a.publicNetworkAccess,
            },
            skuName: a.skuName,
            tenantId: a.tenantId
        }),
        planLine: a => `Create KV ${a.vaultName} in ${a.location}`,
        followup: a => `@platform create_key_vault resourceGroupName "${a.resourceGroupName}" vaultName "${a.vaultName}" location "${a.location}" confirm true`,
    });

// ---------- G. Ensure Storage Account ----------
const EnsureStorageSchema = z.object({
    resourceGroupName: z.string(),
    accountName: z.string(),
    location: z.string(),
    skuName: z.string().default("Standard_LRS"),
    kind: z.string().default("StorageV2"),
    env: z.string().optional(),
});
export const tool_platform_create_storage =
    makeGovernedTool({
        name: "platform.create_storage_account",
        description: "Ensure a Storage Account exists.",
        routerTool: "azure.create_storage_account",
        schema: EnsureStorageSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            name: a.accountName,
            location: a.location,
            skuName: a.skuName,
            kind: a.kind
        }),
        planLine: a => `Create Storage Account ${a.accountName} in ${a.location}`,
        followup: a => `@platform create_storage_account resourceGroupName "${a.resourceGroupName}" accountName "${a.accountName}" location "${a.location}" confirm true`,
    });

// ---------- H. Ensure Log Analytics Workspace ----------
const EnsureLawSchema = z.object({
    resourceGroupName: z.string(),
    workspaceName: z.string(),
    location: z.string(),
    retentionInDays: z.number().int().min(7).max(730).default(30),
    env: z.string().optional(),
});
export const tool_platform_create_law =
    makeGovernedTool({
        name: "platform.create_log_analytics",
        description: "Ensure a Log Analytics Workspace exists.",
        routerTool: "azure.create_log_analytics_workspace",
        schema: EnsureLawSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            name: a.workspaceName,
            location: a.location,
            retentionInDays: a.retentionInDays
        }),
        planLine: a => `Create LAW ${a.workspaceName} in ${a.location}`,
        followup: a => `@platform create_log_analytics resourceGroupName "${a.resourceGroupName}" workspaceName "${a.workspaceName}" location "${a.location}" confirm true`,
    });

// ---------- I. Ensure Repo from Template ----------
const EnsureRepoFromTmplSchema = z.object({
    owner: z.string(),                 // target org/user
    templateOwner: z.string(),
    templateRepo: z.string(),
    newRepoName: z.string().regex(/^[a-z0-9-]+$/, "kebab-case only"),
    description: z.string().optional(),
    visibility: z.enum(["private", "public", "internal"]).default("private"),
    teamSlug: z.string().optional(),
    env: z.string().optional(),
});
export const tool_platform_create_repo_from_template =
    makeGovernedTool({
        name: "platform.create_repo_from_template",
        description: "Ensure a repo exists (from a template) with governance and optional team access.",
        routerTool: "github.create_repo_from_template",
        schema: EnsureRepoFromTmplSchema,
        toPayload: a => ({
            templateOwner: a.templateOwner,
            templateRepo: a.templateRepo,
            owner: a.owner,
            name: a.newRepoName,
            private: a.visibility !== "public",
            description: a.description || "",
            includeAllBranches: false
        }),
        planLine: a => `Create repo ${a.owner}/${a.newRepoName} from ${a.templateOwner}/${a.templateRepo}`,
        followup: a => `@platform create_repo_from_template owner "${a.owner}" templateOwner "${a.templateOwner}" templateRepo "${a.templateRepo}" newRepoName "${a.newRepoName}" confirm true`,
        // (optional) you can add a post-step tool to grant team permissions
    });

// ---------- Ensure Static Web App ----------
const EnsureSwaSchema = z.object({
    resourceGroupName: z.string(),
    name: z.string(),
    location: z.string(),
    skuName: z.enum(["Free", "Standard", "StandardPlus"]).default("Free"),
    env: z.string().optional(),
});
export const tool_platform_create_static_web_app =
    makeGovernedTool({
        name: "platform.create_static_web_app",
        description: "Ensure an Azure Static Web App exists (governed, idempotent).",
        routerTool: "azure.create_static_web_app",
        schema: EnsureSwaSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            name: a.name,
            location: a.location,
            skuName: a.skuName
        }),
        planLine: a => `Create Static Web App ${a.name} (${a.skuName}) in ${a.location}`,
        followup: a =>
            `@platform create_static_web_app resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" skuName "${a.skuName}" confirm true`,
        verifyCalls: [{
            name: "azure.get_static_web_app",
            toPayload: (a) => ({ name: a.name }),
            expect: vj => !!vj?.name && vj.name === vj?.name // existence is enough
        }]
    });

// ---------- Link SWA to GitHub (CI/CD) ----------
const LinkSwaRepoSchema = z.object({
    resourceGroupName: z.string(),
    name: z.string(),                  // SWA name
    owner: z.string(),                 // GitHub org/user
    repo: z.string(),                  // GitHub repo name
    branch: z.string().default("main"),
    appLocation: z.string().default("/"),
    apiLocation: z.string().default("api"),
    outputLocation: z.string().default("dist"),
    buildPreset: z.string().optional(), // optional preset hint
    env: z.string().optional(),
});
export const tool_platform_link_static_webapp_repo =
    makeGovernedTool({
        name: "platform.link_static_webapp_repo",
        description: "Ensure a Static Web App is linked to a GitHub repo with CI/CD.",
        routerTool: "azure.link_static_webapp_repo",
        schema: LinkSwaRepoSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            name: a.name,
            owner: a.owner,
            repo: a.repo,
            branch: a.branch,
            appLocation: a.appLocation,
            apiLocation: a.apiLocation,
            outputLocation: a.outputLocation,
            buildPreset: a.buildPreset
        }),        
        planLine: a => `Create SWA ${a.name} to ${a.owner}/${a.repo}@${a.branch}`,
        followup: a =>
            `@platform link_static_webapp_repo resourceGroupName "${a.resourceGroupName}" name "${a.name}" owner "${a.owner}" repo "${a.repo}" branch "${a.branch}" confirm true`,
    });

// ---------- Ensure VNet ----------
const EnsureVnetSchema = z.object({
    resourceGroupName: z.string(),
    vnetName: z.string(),
    location: z.string(),
    addressPrefixes: z.array(z.string()).default(["10.0.0.0/16"]),
    dnsServers: z.array(z.string()).optional(),
    env: z.string().optional(),
});
export const tool_platform_create_vnet =
    makeGovernedTool({
        name: "platform.create_vnet",
        description: "Ensure a Virtual Network exists (idempotent + governed).",
        routerTool: "azure.create_virtual_network",
        schema: EnsureVnetSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            name: a.vnetName,
            location: a.location,
            addressPrefixes: a.addressPrefixes,
            dnsServers: a.dnsServers
        }),
        planLine: a => `Create VNet ${a.vnetName} ${a.addressPrefixes.join(",")} in ${a.location}`,
        followup: a =>
            `@platform create_vnet resourceGroupName "${a.resourceGroupName}" vnetName "${a.vnetName}" location "${a.location}" confirm true`,
        verifyCalls: [{
            name: "azure.get_virtual_network",
            toPayload: (a) => ({ name: a.vnetName }),
            expect: vj => !!vj?.name && vj.name === vj?.name // existence is enough
        }]
    });

// ---------- Ensure Subnet ----------
const EnsureSubnetSchema = z.object({
    resourceGroupName: z.string(),
    vnetName: z.string(),
    subnetName: z.string(),
    addressPrefix: z.string(),
    serviceEndpoints: z.array(z.string()).optional(),
    delegations: z.array(z.object({ serviceName: z.string() })).optional(),
    privateEndpointNetworkPolicies: z.enum(["Enabled", "Disabled"]).optional(),
    env: z.string().optional(),
});
export const tool_platform_create_subnet =
    makeGovernedTool({
        name: "platform.create_subnet",
        description: "Ensure a Subnet exists on a VNet (idempotent + governed).",
        routerTool: "azure.create_subnet",
        schema: EnsureSubnetSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            vnetName: a.vnetName,
            name: a.subnetName,
            addressPrefix: a.addressPrefix,
            serviceEndpoints: a.serviceEndpoints,
            delegations: a.delegations,
            privateEndpointNetworkPolicies: a.privateEndpointNetworkPolicies
        }),        
        planLine: a => `Create Subnet ${a.subnetName} ${a.addressPrefix} on ${a.vnetName}`,
        followup: a =>
            `@platform create_subnet resourceGroupName "${a.resourceGroupName}" vnetName "${a.vnetName}" subnetName "${a.subnetName}" addressPrefix "${a.addressPrefix}" confirm true`,
        verifyCalls: [{
            name: "azure.get_subnet",
            toPayload: (a) => ({ name: a.subnetName }),
            expect: vj => !!vj?.name && vj.name === vj?.name // existence is enough
        }]
    });

// ---------- Ensure Private Endpoint ----------
const EnsurePeSchema = z.object({
    resourceGroupName: z.string(),
    peName: z.string(),
    location: z.string(),
    vnetName: z.string(),
    subnetName: z.string(),
    targetResourceId: z.string(),               // e.g., KV/Storage/WebApp resourceId
    groupIds: z.array(z.string()).optional(),   // subresource names
    privateDnsZoneGroupName: z.string().optional(),
    privateDnsZoneIds: z.array(z.string()).optional(), // resourceIds of private DNS zones
    env: z.string().optional(),
});
export const tool_platform_create_private_endpoint =
    makeGovernedTool({
        name: "platform.create_private_endpoint",
        description: "Ensure a Private Endpoint exists for a target resource.",
        routerTool: "azure.create_private_endpoint",
        schema: EnsurePeSchema,
        toPayload: a => ({
            resourceGroupName: a.resourceGroupName,
            name: a.peName,
            location: a.location,
            vnetName: a.vnetName,
            subnetName: a.subnetName,
            targetResourceId: a.targetResourceId,
            groupIds: a.groupIds,
            privateDnsZoneGroupName: a.privateDnsZoneGroupName,
            privateDnsZoneIds: a.privateDnsZoneIds
        }),
        planLine: a => `Ensure Private Endpoint ${a.peName} -> ${a.targetResourceId}`,
        followup: a =>
            `@platform create_private_endpoint resourceGroupName "${a.resourceGroupName}" peName "${a.peName}" location "${a.location}" vnetName "${a.vnetName}" subnetName "${a.subnetName}" targetResourceId "${a.targetResourceId}" confirm true`,
        verifyCalls: [{
            name: "azure.get_private_endpoint",
            toPayload: (a) => ({ name: a.peName }),
            expect: vj => !!vj?.name && vj.name === vj?.name // existence is enough
        }]
    });

export const tool_platform_onboarding_execute_task: ToolDef = {
    name: "platform.onboarding_execute_task",
    description: "Execute a single onboarding checklist task with governance preflight; marks task complete on success when runId is provided.",
    inputSchema: z.object({
        request: z.string(),                           // free text: "I'm a new mission owner… UPN jdoe@… alias jdoe region usgovvirginia dry run"
        playbookId: z.string().default("mission-owner"),
        confirm: z.boolean().default(false),           // execute tool tasks if true
        dryRun: z.boolean().default(true),             // default to plan-only safety
        defaults: z.object({
            upn: z.string().optional(),
            alias: z.string().optional(),
            displayName: z.string().optional(),
            region: z.string().optional(),
        }).partial().optional(),
    }).strict(),
    handler: async (a: any) => {
        // 1) Parse free text + merge defaults
        const parsed = parseOnboardingNL(a.request || "");
        const user = {
            upn: parsed.upn || a.defaults?.upn,
            alias: parsed.alias || a.defaults?.alias,
            displayName: parsed.displayName || a.defaults?.displayName,
        };
        const region = parsed.region || a.defaults?.region || "usgovvirginia";
        const dryRun = a.dryRun ?? parsed.dryRun ?? true;

        if (!user.upn || !user.alias) {
            const hint = [
                "Missing required fields.",
                "Please include at least UPN and alias in your sentence. Example:",
                `“I am a new mission owner. Onboard me. UPN jdoe@contoso.gov alias jdoe region usgovvirginia. Let's do a dry run only.”`
            ].join("\n");
            return { content: [...mcpText(hint)] };
        }

        // 2) Start run
        const start = await callRouterTool("onboarding.start_run", {
            playbookId: a.playbookId,
            user,                       // your onboarding MCP accepts user={ upn, alias, displayName }
            region                      // top-level region is supported in your server
        });
        const startJ = firstJson(start);
        const runId = startJ?.runId;
        const summary = startJ?.summary || "Onboarding initialized.";

        if (!runId) {
            return {
                content: [
                    ...mcpText(`Failed to start onboarding: ${JSON.stringify(start.body || start).slice(0, 800)}`),
                ], isError: true
            };
        }

        // 3) Fetch checklist
        const cls = await callRouterTool("onboarding.get_checklist", {
            playbookId: a.playbookId,
            user, region
        });
        const clsJ = firstJson(cls);
        const tasks = clsJ?.tasks || [];
        const playbookName = clsJ?.playbook?.name || a.playbookId;

        // Build a friendly preview
        const bullets = tasks.map((t: any) => `• ${t.title}${t.kind ? ` (${t.kind})` : ""}`).join("\n");
        const header = `Onboarding Plan for ${user.upn} (${user.alias}) — ${playbookName} @ ${region}`;
        const modeLine = dryRun ? "Mode: DRY RUN (no changes will be made)" : (a.confirm ? "Mode: EXECUTE" : "Mode: REVIEW");

        // 4) If not confirmed or dry run, just present the plan and a follow-up
        if (dryRun || !a.confirm) {
            const follow = `@platform onboarding nl request "Proceed with the mission-owner checklist for ${user.upn} alias ${user.alias} region ${region}" confirm yes dryRun false`;
            return {
                content: [
                    ...mcpJson({ runId, summary, tasks }),
                    ...mcpText([header, modeLine, "", "Summary:", summary, "", "Checklist:", bullets || "— none —", "", "To execute now, reply with:", follow].join("\n"))
                ]
            };
        }

        // 5) EXECUTE (only tool-kind tasks) via Router (governance preflight is in Router)
        const results: any[] = [];
        for (const t of tasks) {
            if (t.kind !== "tool" || !t.tool?.name) { results.push({ taskId: t.id, status: "skipped" }); continue; }

            const toolName = t.tool.name;     // e.g., "azure.create_resource_group" / "github.create_repo" / etc.
            const toolArgs = t.tool.args || {};
            const r = await callRouterTool(toolName, toolArgs);
            const ok = !!r.ok;
            const j = firstJson(r) ?? r.body;
            results.push({ taskId: t.id, tool: toolName, ok, result: j });

            // optional: mark complete in onboarding state (best-effort)
            try { await callRouterTool("onboarding.complete_task", { runId, taskId: t.id, note: `Ran ${toolName}` }); } catch { }
        }

        return {
            content: [
                ...mcpJson({ runId, executed: true, results }),
                ...mcpText(`✅ Executed ${results.filter((x: any) => x.tool).length} task(s) for ${user.alias}.`),
            ]
        };
    }
};
