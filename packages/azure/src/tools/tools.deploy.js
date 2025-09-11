// packages/azure-core/src/tools.deploy.ts — v2 (RG/Subscription/MG)
import { z } from "zod";
import { normalizeAzureError } from "../utils.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
/** ARM parameter wrapper */
function toArmParameters(input) {
    if (!input)
        return undefined;
    const out = {};
    for (const [k, v] of Object.entries(input))
        out[k] = { value: v };
    return out;
}
function readJsonFile(p) {
    const text = fs.readFileSync(p, "utf8");
    try {
        return JSON.parse(text);
    }
    catch (e) {
        throw new Error(`Invalid JSON in file: ${p} — ${e?.message || e}`);
    }
}
function which(cmd) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
    return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}
function compileBicepToJson(filePath) {
    const bicep = which("bicep") || null;
    const az = which("az") || null;
    if (bicep) {
        const r = spawnSync(bicep, ["build", filePath, "--stdout"], { encoding: "utf8" });
        if (r.status !== 0)
            throw new Error(`bicep build failed: ${r.stderr || r.stdout}`);
        return JSON.parse(r.stdout || "{}");
    }
    if (az) {
        const r = spawnSync(az, ["bicep", "build", "--file", filePath, "--stdout"], { encoding: "utf8" });
        if (r.status !== 0)
            throw new Error(`az bicep build failed: ${r.stderr || r.stdout}`);
        return JSON.parse(r.stdout || "{}");
    }
    throw new Error("No Bicep compiler found. Install 'bicep' or 'az' CLI.");
}
function cloneGitRepo(repo, ref) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bicep-repo-"));
    const git = which("git");
    if (!git)
        throw new Error("git is required to fetch templates from a repo");
    let r = spawnSync(git, ["clone", "--depth", "1", repo, tmp], { encoding: "utf8" });
    if (r.status !== 0)
        throw new Error(`git clone failed: ${r.stderr || r.stdout}`);
    if (ref) {
        r = spawnSync(git, ["-C", tmp, "fetch", "--depth", "1", "origin", ref], { encoding: "utf8" });
        if (r.status === 0)
            r = spawnSync(git, ["-C", tmp, "checkout", ref], { encoding: "utf8" });
        if (r.status !== 0)
            throw new Error(`git checkout ${ref} failed: ${r.stderr || r.stdout}`);
    }
    return tmp;
}
function resolveTemplateFromSource(a) {
    let baseDir;
    let templatePath;
    if (a.source.kind === "file") {
        baseDir = path.resolve(a.source.path);
        templatePath = path.resolve(baseDir, a.source.file ?? a.source.path);
    }
    else {
        baseDir = cloneGitRepo(a.source.repo, a.source.ref);
        templatePath = path.resolve(baseDir, a.source.file);
    }
    if (!fs.existsSync(templatePath))
        throw new Error(`Template not found: ${templatePath}`);
    const ext = path.extname(templatePath).toLowerCase();
    const template = ext === ".json" ? readJsonFile(templatePath) : compileBicepToJson(templatePath);
    let paramsObj = a.parameters ? { ...a.parameters } : undefined;
    if (a.parametersFile) {
        const p = path.isAbsolute(a.parametersFile) ? a.parametersFile : path.resolve(baseDir, a.parametersFile);
        const pf = readJsonFile(p);
        paramsObj = pf?.parameters ?? pf;
    }
    const parameters = toArmParameters(paramsObj);
    return { baseDir, templatePath, template, parameters };
}
export function makeAzureDeployTools(opts) {
    const { clients, namespace = "azure." } = opts;
    const n = (s) => `${namespace}${s}`;
    // RG scope
    const deploy_bicep = {
        name: n("deploy_bicep"),
        description: "Deploy a Bicep/ARM template to a Resource Group. Source can be a local file or a Git repo. Supports optional parameters and What-If.",
        inputSchema: z
            .object({
            resourceGroupName: z.string(),
            deploymentName: z.string().default(() => `mcp-${Date.now()}`),
            mode: z.enum(["Incremental", "Complete"]).default("Incremental"),
            source: z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("file"), path: z.string(), file: z.string().optional() }),
                z.object({ kind: z.literal("git"), repo: z.string().url(), ref: z.string().optional(), file: z.string() }),
            ]),
            parameters: z.record(z.any()).optional(),
            parametersFile: z.string().optional(),
            whatIf: z.boolean().default(false),
        })
            .strict(),
        handler: async (a) => {
            try {
                const { template, parameters } = resolveTemplateFromSource(a);
                const properties = { mode: a.mode, template, parameters };
                const result = await clients.deployments.deployToResourceGroup(a.resourceGroupName, a.deploymentName, properties, { whatIf: a.whatIf });
                return { content: [{ type: "json", json: { status: "done", scope: { resourceGroupName: a.resourceGroupName }, deploymentName: a.deploymentName, whatIf: a.whatIf || undefined, result } }] };
            }
            catch (e) {
                return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
            }
        },
    };
    // Subscription scope
    const deploy_bicep_subscription = {
        name: n("deploy_bicep_subscription"),
        description: "Deploy a Bicep/ARM template at **subscription scope** (requires location).",
        inputSchema: z
            .object({
            deploymentName: z.string().default(() => `mcp-sub-${Date.now()}`),
            location: z.string(),
            mode: z.enum(["Incremental", "Complete"]).default("Incremental"),
            source: z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("file"), path: z.string(), file: z.string().optional() }),
                z.object({ kind: z.literal("git"), repo: z.string().url(), ref: z.string().optional(), file: z.string() }),
            ]),
            parameters: z.record(z.any()).optional(),
            parametersFile: z.string().optional(),
            whatIf: z.boolean().default(false),
        })
            .strict(),
        handler: async (a) => {
            try {
                const { template, parameters } = resolveTemplateFromSource(a);
                const properties = { location: a.location, mode: a.mode, template, parameters };
                const result = await clients.deployments.deployToSubscription(a.deploymentName, properties, { whatIf: a.whatIf });
                return { content: [{ type: "json", json: { status: "done", scope: { subscription: true }, deploymentName: a.deploymentName, location: a.location, whatIf: a.whatIf || undefined, result } }] };
            }
            catch (e) {
                return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
            }
        },
    };
    // Management group scope
    const deploy_bicep_management_group = {
        name: n("deploy_bicep_management_group"),
        description: "Deploy a Bicep/ARM template at **management group scope** (requires managementGroupId and location).",
        inputSchema: z
            .object({
            managementGroupId: z.string(),
            deploymentName: z.string().default(() => `mcp-mg-${Date.now()}`),
            location: z.string(),
            mode: z.enum(["Incremental", "Complete"]).default("Incremental"),
            source: z.discriminatedUnion("kind", [
                z.object({ kind: z.literal("file"), path: z.string(), file: z.string().optional() }),
                z.object({ kind: z.literal("git"), repo: z.string().url(), ref: z.string().optional(), file: z.string() }),
            ]),
            parameters: z.record(z.any()).optional(),
            parametersFile: z.string().optional(),
            whatIf: z.boolean().default(false),
        })
            .strict(),
        handler: async (a) => {
            try {
                const { template, parameters } = resolveTemplateFromSource(a);
                const properties = { location: a.location, mode: a.mode, template, parameters };
                const result = await clients.deployments.deployToManagementGroup(a.managementGroupId, a.deploymentName, properties, { whatIf: a.whatIf });
                return { content: [{ type: "json", json: { status: "done", scope: { managementGroupId: a.managementGroupId }, deploymentName: a.deploymentName, location: a.location, whatIf: a.whatIf || undefined, result } }] };
            }
            catch (e) {
                return { content: [{ type: "json", json: normalizeAzureError(e) }], isError: true };
            }
        },
    };
    return [deploy_bicep, deploy_bicep_subscription, deploy_bicep_management_group];
}
