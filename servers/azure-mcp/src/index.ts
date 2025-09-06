import "dotenv/config";
import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";
import { makeAzureClients } from "auth/src/azure.js";
import { randomUUID } from "node:crypto";

type Suggestion = {
    title: string;
    text: string;
    autofix?: { arguments: any };
};

type EvalResult = {
    decision: "deny" | "warn" | "allow";
    reasons: string[];
    policyIds: string[];
    suggestions?: Suggestion[];
};
import { execFile as _execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


function execFile(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        _execFile(cmd, args, (err, stdout, stderr) => {
            if (err) return reject(Object.assign(err, { stdout, stderr }));
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

const PORT = Number(process.env.PORT ?? 8712);
const GOV_URL = process.env.GOVERNANCE_MCP_URL || "http://127.0.0.1:8715";
const TENANT_ID = process.env.AZURE_TENANT_ID!;
const CLIENT_ID = process.env.AZURE_CLIENT_ID!;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET!;
const SUB_ID = process.env.AZURE_SUBSCRIPTION_ID!;
let currentSub: string = SUB_ID;

const { resources, storage, authorization, web, keyvault, containerservice } = makeAzureClients({ tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, subscriptionId: SUB_ID });

async function govCall(method: string, params: any) {
    const r = await fetch(`${GOV_URL}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    });
    const text = await r.text();
    let json: any;
    try { json = JSON.parse(text); } catch {
        throw new Error(`governance-mcp invalid JSON: ${text.slice(0, 200)}`);
    }
    if (json.error) throw new Error(`Governance RPC error: ${json.error.message || "unknown"}`);
    return json.result;
}

// -------- helper used above --------
function normalizeRgArgs(a: any): { name: string; location: string; tags?: Record<string, string> } {
    const name = (a.name ?? a.resourceGroupName) as string;
    const location = (a.location ?? a.region) as string;

    let tags: Record<string, string> | undefined;
    if (typeof a.tags === "string") {
        const s = a.tags.trim();
        if (s) {
            const pairs = s.split(/[;,]\s*/).map((p: string) => p.trim()).filter(Boolean);
            const entries: Array<[string, string]> = [];
            for (const pair of pairs) {
                const eq = pair.indexOf("=");
                if (eq > 0) {
                    const k = pair.slice(0, eq).trim();
                    const v = pair.slice(eq + 1).trim();
                    if (k && v) entries.push([k, v]);
                }
            }
            tags = entries.length ? Object.fromEntries(entries) : { note: s };
        }
    } else if (a.tags && typeof a.tags === "object") {
        tags = a.tags as Record<string, string>;
    }

    return { name, location, tags };
}

/** Ask governance if a tool call is allowed. Throws on deny (with reasons). */
async function enforceGovernance(service: "azure", tool: string, args: any) {
    // Tool name passed WITHOUT the "azure." prefix to keep policy keys clean
    const res = await govCall("tools/call", {
        name: "governance.evaluate",
        arguments: { service, tool, args }
    });
    // expect: { content:[{type:"json", json:{ decision, reasons?, suggestions? }}] }
    const first = res?.content?.find((c: any) => c.json)?.json || {};
    const decision = first.decision || "allow";
    if (decision === "deny") {
        const reasons = first.reasons || [];
        const suggestions = first.suggestions || [];
        const msg = `GovernanceDenied: ${reasons.join(" | ")}`;
        const e: any = new Error(msg);
        e.reasons = reasons;
        e.suggestions = suggestions;
        throw e;
    }
    return first; // may contain { decision:"warn", reasons, suggestions }
}

/** Decorator for Azure handlers */
function withGovernance<TArgs>(tool: string, handler: (args: TArgs) => Promise<any>, normalizeForGov?: (args: TArgs) => any) {
    return async (args: TArgs) => {
        const govArgs = normalizeForGov ? normalizeForGov(args) : args;
        await enforceGovernance("azure", tool.replace(/^azure\./, ""), govArgs);
        return handler(args);
    };
}

async function loadArmTemplateFromUrl(url: string): Promise<any> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch template (${res.status})`);
    const urlLower = url.toLowerCase();
    const ct = res.headers.get("content-type") || "";


    // JSON path
    if (urlLower.endsWith(".json") || ct.includes("application/json")) {
        return await res.json();
    }


    // Bicep path: requires BICEP_CLI_PATH or 'bicep' in PATH
    if (urlLower.endsWith(".bicep")) {
        const BICEP = process.env.BICEP_CLI_PATH || "bicep";
        const tmp = mkdtempSync(join(tmpdir(), "mcp-bicep-"));
        try {
            const inPath = join(tmp, "template.bicep");
            const text = await res.text();
            writeFileSync(inPath, text, "utf8");
            const { stdout } = await execFile(BICEP, ["build", inPath, "--stdout"]);
            return JSON.parse(stdout);
        } catch (e: any) {
            throw new Error(`Bicep compile failed. Ensure BICEP_CLI_PATH is set or 'bicep' is on PATH. Details: ${e?.stderr || e?.message}`);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    }


    throw new Error("Unsupported template type. Provide a .json ARM template or a .bicep URL.");
}

const tools = [
    {
        name: "azure.ping",
        description: "Health check for azure-mcp",
        inputSchema: z.object({}).strict(),
        handler: async () => ({ content: [{ type: "json" as const, json: { ok: true } }] })
    },
    {
        name: "azure.select_subscription",
        description: "Switch the active subscription for subsequent calls.",
        inputSchema: z.object({ subscriptionId: z.string() }).strict(),
        handler: async ({ subscriptionId }: { subscriptionId: string }) => {
            process.env.AZURE_SUBSCRIPTION_ID = subscriptionId;
            currentSub = subscriptionId;
            // Recreate clients here if needed
            return { content: [{ type: "json" as const, json: { activeSubscriptionId: currentSub } }] };
        }
    },
    {
        name: "azure.create_resource_group",
        description: "Create or update a resource group.",
        inputSchema: z.object({
            name: z.string().min(1).optional(),
            resourceGroupName: z.string().min(1).optional(),
            location: z.string().min(1).optional(),
            region: z.string().min(1).optional(),
            // Accept object or "k=v,k2=v2"
            tags: z.union([z.record(z.string()), z.string()]).optional(),
        })
            .strict()
            .superRefine((v, ctx) => {
                if (!v.name && !v.resourceGroupName) {
                    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide 'name' (or 'resourceGroupName')." });
                }
                if (!v.location && !v.region) {
                    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide 'location' (or 'region')." });
                }
            }),

        // withGovernance(toolFq, handler, payloadForGovernance)
        handler: withGovernance(
            "azure.create_resource_group",

            // ---- actual execution handler (receives raw, do not re-normalize elsewhere) ----
            async (raw: any) => {
                const { name, location, tags } = normalizeRgArgs(raw);

                const payload = { location, tags }; // body for ARM
                const rg = await resources.resourceGroups.createOrUpdate(name, payload);

                return { content: [{ type: "json" as const, json: rg }] };
            },

            // ---- normalized payload supplied to governance preflight ----
            (raw: any) => normalizeRgArgs(raw)
        )
    },
    {
        name: "azure.create_storage_account",
        description: "Create a general purpose v2 Storage Account.",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            accountName: z.string().regex(/^[a-z0-9]{3,24}$/, "3–24 chars, lowercase letters & digits only"),
            location: z.string(),
            sku: z.enum(["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"]).default("Standard_LRS"),
            tags: z.record(z.string()).optional()
        }).strict(),
        // if you have withGovernance, keep it; otherwise use `handler: async (...) => { ... }`
        handler: withGovernance("azure.create_storage_account", async (args: {
            resourceGroupName: string;
            accountName: string;
            location: string;
            sku: "Standard_LRS" | "Standard_GRS" | "Standard_RAGRS" | "Standard_ZRS" | "Premium_LRS";
            tags?: Record<string, string>;
        }) => {
            const params = {
                location: args.location,
                sku: { name: args.sku },
                kind: "StorageV2",
                tags: args.tags,
                properties: {
                    enableHttpsTrafficOnly: true,     // HTTPS only
                    allowBlobPublicAccess: false,     // safer default; allow only if you need it
                    minimumTlsVersion: "TLS1_2",
                    publicNetworkAccess: "Enabled"
                }
            } as any;

            // Returns the created StorageAccount (not a poller)
            const account = await storage.storageAccounts.beginCreateAndWait(
                args.resourceGroupName,
                args.accountName,
                params
            );

            return { content: [{ type: "json" as const, json: account }] };
        })
    },
    {
        name: "azure.deploy_template_rg",
        description: "Deploy an ARM template (JSON) to a Resource Group (Incremental by default).",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            deploymentName: z.string(),
            template: z.record(z.any()),
            parameters: z.record(z.any()).default({}),
            mode: z.enum(["Incremental", "Complete"]).default("Incremental")
        }),
        handler: async (args: { resourceGroupName: string; deploymentName: string; template: Record<string, any>; parameters: Record<string, any>; mode: "Incremental" | "Complete" }) => {
            const res = await resources.deployments.beginCreateOrUpdateAndWait(
                args.resourceGroupName,
                args.deploymentName,
                { properties: { mode: args.mode as any, template: args.template, parameters: args.parameters } }
            );
            return { content: [{ type: "json" as const, json: res }] };
        }
    },
    {
        name: "azure.deploy_bicep_rg_from_url",
        description: "Deploy a template from URL; supports .json directly or compiles .bicep via Bicep CLI.",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            deploymentName: z.string(),
            templateUrl: z.string(),
            parameters: z.record(z.any()).default({}),
            mode: z.enum(["Incremental", "Complete"]).default("Incremental")
        }),
        handler: async (args: any) => {
            const template = await loadArmTemplateFromUrl(args.templateUrl);
            const res = await resources.deployments.beginCreateOrUpdateAndWait(
                args.resourceGroupName,
                args.deploymentName,
                { properties: { mode: args.mode as any, template, parameters: args.parameters } }
            );
            return { content: [{ type: "json" as const, json: res }] };
        }
    },
    {
        name: "azure.role_assignment_create",
        description: "Assign a built-in role (by name or definitionId) to a principal at a scope (subscription, RG, or resource).",
        inputSchema: z.object({
            scope: z.string(), // e.g., /subscriptions/<sub>/resourceGroups/<rg>
            principalId: z.string(), // AAD objectId of user/SPN/MSI
            roleDefinitionId: z.string().optional(),
            roleName: z.string().optional() // e.g., Contributor, Reader
        }),
        handler: async (args: { scope: string; principalId: string; roleDefinitionId?: string; roleName?: string }) => {
            let roleDefId = args.roleDefinitionId;
            if (!roleDefId && args.roleName) {
                for await (const rd of authorization.roleDefinitions.list(args.scope)) {
                    if (rd.roleName === args.roleName) { roleDefId = rd.id!; break; }
                }
            }
            if (!roleDefId) throw new Error("roleDefinitionId not found (pass roleDefinitionId or a valid roleName)");
            const id = randomUUID();
            const res = await authorization.roleAssignments.create(args.scope, id, {
                principalId: args.principalId,
                roleDefinitionId: roleDefId
            } as any);
            return { content: [{ type: "json" as const, json: res }] };
        }
    },
    {
        name: "azure.create_app_service_plan",
        description: "Create an App Service Plan.",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            name: z.string(),
            location: z.string(),
            skuName: z.string().default("P1v3"),
            capacity: z.number().int().positive().default(1),
            zoneRedundant: z.boolean().default(false)
        }),
        handler: withGovernance("azure.create_app_service_plan", async (args: { resourceGroupName: string; name: string; location: string; skuName: string; capacity: number; zoneRedundant: boolean }) => {
            const plan = await web.appServicePlans.beginCreateOrUpdateAndWait(args.resourceGroupName, args.name, {
                location: args.location,
                kind: "linux",
                reserved: true,                    // <-- REQUIRED for Linux
                zoneRedundant: args.zoneRedundant,
                sku: { name: args.skuName, capacity: args.capacity } as any
            });
            return { content: [{ type: "json" as const, json: plan }] };
        })
    },
    {
        name: "azure.create_web_app",
        description: "Create a Linux Web App on the given App Service Plan. runtimeStack like NODE|20-lts.",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            name: z.string(),
            location: z.string(),
            // Either pass planResourceId OR planName (with SUB_ID env present)
            planResourceId: z.string().optional(),
            planName: z.string().optional(),
            runtimeStack: z.string().regex(/^[A-Z0-9]+\|[A-Za-z0-9.-]+$/, "Use format like NODE|20-lts"),
            appSettings: z.record(z.string()).optional()
        }),
        handler: withGovernance("azure.create_web_app", async ({ resourceGroupName, name, location, planResourceId, planName, runtimeStack, appSettings }: {
            resourceGroupName: string;
            name: string;
            location: string;
            planResourceId?: string;
            planName?: string;
            runtimeStack: string;
            appSettings?: Record<string, string>;
        }) => {
            const subscriptionId = process.env.AZURE_SUBSCRIPTION_ID!;
            const serverFarmId =
                planResourceId ??
                (planName
                    ? `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Web/serverfarms/${planName}`
                    : (() => { throw new Error("Provide planResourceId or planName"); })());

            const site = await web.webApps.beginCreateOrUpdateAndWait(resourceGroupName, name, {
                location,
                kind: "app,linux",                 // <-- Linux site
                serverFarmId,
                httpsOnly: true,
                siteConfig: {
                    linuxFxVersion: runtimeStack,    // e.g. NODE|20-lts
                    alwaysOn: true,
                    appSettings: appSettings
                        ? Object.entries(appSettings).map(([k, v]) => ({ name: k, value: v }))
                        : undefined
                }
            } as any);
            return { content: [{ type: "json" as const, json: site }] };
        })
    },
    {
        name: "azure.create_key_vault",
        description: "Create a Key Vault (RBAC by default).",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            name: z.string().regex(/^[a-z0-9-]{3,24}$/, "3–24 chars, lowercase letters/digits/hyphens"),
            location: z.string(),
            tenantId: z.string(), // use z.string().uuid() if you want strict GUIDs
            skuName: z.enum(["standard", "premium"]).default("standard"),
            enableRbacAuthorization: z.boolean().default(true),
            publicNetworkAccess: z.enum(["Enabled", "Disabled"]).default("Enabled"),
            tags: z.record(z.string()).optional()
        }).strict(),
        handler: withGovernance("azure.create_key_vault", async (args: {
            resourceGroupName: string;
            name: string;
            location: string;
            tenantId: string;
            skuName?: "standard" | "premium";
            enableRbacAuthorization?: boolean;
            publicNetworkAccess?: "Enabled" | "Disabled";
            tags?: Record<string, string>;
        }) => {
            try {
                const skuName = (args.skuName || "standard").toLowerCase() as "standard" | "premium";
                const parameters = {
                    location: args.location,
                    tags: args.tags,
                    properties: {
                        tenantId: args.tenantId,
                        enableRbacAuthorization: args.enableRbacAuthorization,
                        publicNetworkAccess: args.publicNetworkAccess,
                        sku: { name: skuName, family: "A" }
                    }
                } as any;

                const vault = await keyvault.vaults.beginCreateOrUpdateAndWait(
                    args.resourceGroupName,
                    args.name,
                    parameters
                );
                return { content: [{ type: "json" as const, json: vault }] };
            } catch (e: any) {
                return {
                    content: [{
                        type: "json" as const,
                        json: {
                            error: {
                                message: e?.message,
                                code: e?.code || e?.statusCode,
                                body: e?.response?.body || e?.response?.parsedBody || e?.details
                            }
                        }
                    }],
                    isError: true
                };
            }
        })
    },
    {
        name: "azure.create_aks_cluster",
        description: "Create an AKS (Managed Kubernetes) cluster with a system node pool and managed identity.",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            clusterName: z.string(),
            location: z.string(),
            nodeCount: z.number().int().positive().default(3),
            vmSize: z.string().default("Standard_DS2_v2"),
            kubernetesVersion: z.string().optional(),
            vnetSubnetId: z.string().optional(),
            networkPlugin: z.enum(["azure", "kubenet"]).default("azure"),
            osDiskSizeGB: z.number().int().positive().default(128),
            enableOIDCIssuer: z.boolean().default(true),
            enableWorkloadIdentity: z.boolean().default(false)
        }),
        handler: async (args: any) => {
            const mc = await containerservice.managedClusters.beginCreateOrUpdateAndWait(
                args.resourceGroupName,
                args.clusterName,
                {
                    location: args.location,
                    dnsPrefix: args.clusterName.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "aks",
                    kubernetesVersion: args.kubernetesVersion,
                    identity: { type: "SystemAssigned" },
                    agentPoolProfiles: [
                        {
                            name: "systempool",
                            mode: "System",
                            type: "VirtualMachineScaleSets",
                            count: args.nodeCount,
                            vmSize: args.vmSize as any,
                            osDiskSizeGB: args.osDiskSizeGB,
                            vnetSubnetID: args.vnetSubnetId,
                            osType: "Linux"
                        } as any
                    ],
                    networkProfile: {
                        networkPlugin: args.networkPlugin as any,
                        loadBalancerSku: "standard"
                    },
                    oidcIssuerProfile: { enabled: args.enableOIDCIssuer },
                    securityProfile: { workloadIdentity: { enabled: args.enableWorkloadIdentity } }
                }
            );
            return { content: [{ type: "json" as const, json: mc }] };
        }
    },
    {
        name: "azure.aks_get_kubeconfig",
        description: "Return base64-decoded kubeconfig for the cluster (user or admin).",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            clusterName: z.string(),
            admin: z.boolean().default(false)
        }),
        handler: async (args: any) => {
            const creds = args.admin
                ? await containerservice.managedClusters.listClusterAdminCredentials(args.resourceGroupName, args.clusterName)
                : await containerservice.managedClusters.listClusterUserCredentials(args.resourceGroupName, args.clusterName);

            const kc = creds.kubeconfigs?.[0];
            if (!kc?.value) throw new Error("No kubeconfig returned");
            const kubeconfig = Buffer.from(kc.value!).toString("utf8");
            return { content: [{ type: "text" as const, text: kubeconfig }] };
        }
    },
    // --- Add near your other imports
    // (nothing extra needed if you already have `web` and `keyvault` clients)

    // --- Add inside your `tools` array ---

    {
        name: "azure.web_assign_system_identity",
        description: "Enable system-assigned managed identity on a Web App. Returns principalId.",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            name: z.string()
        }),
        handler: async (args: { resourceGroupName: string; name: string }) => {
            const site = await web.webApps.update(
                args.resourceGroupName,
                args.name,
                { identity: { type: "SystemAssigned" } } as any
            );
            return {
                content: [{
                    type: "json" as const,
                    json: {
                        name: args.name,
                        principalId: site.identity?.principalId,
                        tenantId: site.identity?.tenantId
                    }
                }]
            };
        }
    },

    {
        name: "azure.web_set_app_settings",
        description: "Merge app settings (key/value). Use Key Vault refs like @Microsoft.KeyVault(SecretUri=...).",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            name: z.string(),
            settings: z.record(z.string())
        }),
        handler: async (args: { resourceGroupName: string; name: string; settings: Record<string, string> }) => {
            const res = await web.webApps.updateApplicationSettings(
                args.resourceGroupName,
                args.name,
                { properties: args.settings }
            );
            return { content: [{ type: "json" as const, json: res }] };
        }
    },
    {
        name: "azure.get_resource_group",
        description: "Get a resource group by name.",
        inputSchema: z.object({ name: z.string() }).strict(),
        handler: async ({ name }: { name: string }) => {
            const rg = await resources.resourceGroups.get(name);
            return { content: [{ type: "json" as const, json: rg }] };
        }
    },
    {
        name: "azure.get_key_vault",
        description: "Get a Key Vault by resource group and name.",
        inputSchema: z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
        handler: async ({ resourceGroupName, name }: { resourceGroupName: string; name: string }) => {
            const v = await keyvault.vaults.get(resourceGroupName, name);
            return { content: [{ type: "json" as const, json: v }] };
        }
    },
    {
        name: "azure.get_web_app",
        description: "Get an App Service (Web App) by resource group and name.",
        inputSchema: z.object({ resourceGroupName: z.string(), name: z.string() }).strict(),
        handler: async ({ resourceGroupName, name }: { resourceGroupName: string; name: string }) => {
            const app = await web.webApps.get(resourceGroupName, name);
            return { content: [{ type: "json" as const, json: app }] };
        }
    },
];

console.log(`[azure-mcp] starting on :${PORT} pid=${process.pid}`);
startMcpHttpServer({ name: "azure-mcp", version: "0.1.0", port: PORT, tools });
