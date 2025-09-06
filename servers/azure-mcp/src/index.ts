import "dotenv/config";
import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";
import { makeAzureClients } from "auth/src/azure.js";
import { randomUUID } from "node:crypto";
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
const TENANT_ID = process.env.AZURE_TENANT_ID!;
const CLIENT_ID = process.env.AZURE_CLIENT_ID!;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET!;
const SUB_ID = process.env.AZURE_SUBSCRIPTION_ID!;
let currentSub: string = SUB_ID;


const { resources, storage, authorization, web, keyvault, containerservice } = makeAzureClients({ tenantId: TENANT_ID, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, subscriptionId: SUB_ID });

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
            // Accept synonyms and make them optional; we’ll canonicalize
            name: z.string().min(1).optional(),
            resourceGroupName: z.string().min(1).optional(),
            location: z.string().min(1).optional(),
            region: z.string().min(1).optional(),
            // Accept either an object or a string like "Foo" or "key=val,team=plat"
            tags: z.union([z.record(z.string()), z.string()]).optional(),
        }).strict().superRefine((v, ctx) => {
            if (!v.name && !v.resourceGroupName) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide 'name' (or 'resourceGroupName')." });
            }
            if (!v.location && !v.region) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Provide 'location' (or 'region')." });
            }
        }),
        handler: async (args: any) => {
            const name = args.name || args.resourceGroupName;           // canonicalize
            const location = args.location || args.region;

            // Coerce tags
            let tags: Record<string, string> | undefined;
            if (typeof args.tags === "string") {
                // Try to parse "k=v,k2=v2"; fall back to {"note": "<string>"}
                const s = args.tags.trim();
                if (s.includes("=")) {
                    tags = Object.fromEntries(
                        s.split(/[;,]\s*/).map((pair: string): [string, string] => {
                            const [k, ...rest] = pair.split("=");
                            return [k.trim(), rest.join("=").trim()];
                        }).filter(([k, v]: [string, string]) => k && v)
                    );
                } else {
                    tags = { note: s };
                }
            } else if (args.tags && typeof args.tags === "object") {
                tags = args.tags;
            }

            const rg = await resources.resourceGroups.createOrUpdate(name, { location, tags });
            return { content: [{ type: "json" as const, json: rg }] };
        }
    },
    {
        name: "azure.create_storage_account",
        description: "Create a general purpose v2 Storage Account.",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            accountName: z.string(),
            location: z.string(),
            sku: z.enum(["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"]).default("Standard_LRS")
        }),
        handler: async (args: { resourceGroupName: string; accountName: string; location: string; sku: string }) => {
            const poller = await storage.storageAccounts.beginCreateAndWait(
                args.resourceGroupName,
                args.accountName,
                {
                    location: args.location,
                    sku: { name: args.sku as any },
                    kind: "StorageV2",
                    enableHttpsTrafficOnly: true
                }
            );
            return { content: [{ type: "json" as const, json: poller }] };
        }
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
        handler: async (args: { resourceGroupName: string; name: string; location: string; skuName: string; capacity: number; zoneRedundant: boolean }) => {
            const plan = await web.appServicePlans.beginCreateOrUpdateAndWait(args.resourceGroupName, args.name, {
                location: args.location,
                kind: "linux",
                reserved: true,                    // <-- REQUIRED for Linux
                zoneRedundant: args.zoneRedundant,
                sku: { name: args.skuName, capacity: args.capacity } as any
            });
            return { content: [{ type: "json" as const, json: plan }] };
        }
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
        handler: async ({ resourceGroupName, name, location, planResourceId, planName, runtimeStack, appSettings }: {
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
        }
    },
    {
        name: "azure.create_key_vault",
        description: "Create a Key Vault (RBAC by default).",
        inputSchema: z.object({
            resourceGroupName: z.string(),
            name: z.string(),
            location: z.string(),
            tenantId: z.string(),
            skuName: z.enum(["standard", "premium"]).default("standard"),
            enableRbacAuthorization: z.boolean().default(true)
        }),
        handler: async (args: { resourceGroupName: string; name: string; location: string; tenantId: string; skuName: "standard" | "premium"; enableRbacAuthorization: boolean }) => {
            const vault = await keyvault.vaults.beginCreateOrUpdateAndWait(args.resourceGroupName, args.name, {
                location: args.location,
                properties: {
                    tenantId: args.tenantId,
                    enableRbacAuthorization: args.enableRbacAuthorization
                },
                sku: { name: args.skuName as any, family: "A" }
            } as any);
            return { content: [{ type: "json" as const, json: vault }] };
        }
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
];

console.log(`[azure-mcp] starting on :${PORT} pid=${process.pid}`);
startMcpHttpServer({ name: "azure-mcp", version: "0.1.0", port: PORT, tools });
