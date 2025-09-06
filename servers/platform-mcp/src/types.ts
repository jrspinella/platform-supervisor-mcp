import z from "zod";

export const pkgInput = z.object({
    alias: z.string(),
    region: z.string().default("usgovvirginia"),
    skuName: z.string().default("P1v3"),
    runtime: z.string().default("NODE|20-lts"),
    tags: z.record(z.string()).default({}),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(true),
}).strict();

// ---- Static Web App package ----
export const staticWebAppInput = z.object({
    // identity / region
    alias: z.string(),
    region: z.string().default("usgovvirginia"),

    // resource naming (you can override)
    resourceGroupName: z.string().optional(), // default: rg-<alias>-web
    staticSiteName: z.string().optional(),    // default: swa-<alias>

    // SWA shape
    siteSku: z.enum(["Free", "Standard"]).default("Free"),
    appLocation: z.string().default("/"),
    outputLocation: z.string().default("dist"),

    // tags & control
    tags: z.record(z.string()).default({}),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(true),
}).strict();

// --- Schema + workflow builder ---
export const linkSwaInput = z.object({
  owner: z.string(),           // org or user
  repo: z.string(),            // repository name
  branch: z.string().default("main"),

  staticSiteName: z.string(),  // logical SWA name (for doc only)
  appLocation: z.string().default("/"),
  outputLocation: z.string().default("dist"),

  // If provided we'll set a repo secret AZURE_STATIC_WEB_APPS_API_TOKEN
  deploymentToken: z.string().optional(),

  // Path for the workflow file
  workflowPath: z.string().default(".github/workflows/azure-static-web-apps.yml"),

  dryRun: z.boolean().default(true),
  confirm: z.boolean().default(false)
}).strict();
