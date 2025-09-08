import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { mcpJson, mcpText, coerceTags } from "./lib/runtime.js";

/**
 * These alias tools DO NOT call the Router.
 * They just normalize / remap friendly inputs into the canonical
 * arguments used by platform.ensure tools, and print a follow-up command
 * you (or the LLM) can run next.
 */

export const toolsAlias: ToolDef[] = [
  // ---------- Resource Group ----------
  {
    name: "platform.create_rg_alias",
    description: "Alias: accept `name`, `region`, `tags` → platform.create_resource_group.",
    inputSchema: z.object({
      name: z.string(),
      region: z.string(),
      tags: z.any().optional()
    }).strict(),
    handler: async (a) => {
      const mapped = { name: a.name, location: a.region, tags: coerceTags(a.tags) };
      const follow = `@platform create_resource_group name "${mapped.name}" location "${mapped.location}"${mapped.tags ? ` tags ${JSON.stringify(mapped.tags)}` : ""} confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_resource_group", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- App Service Plan ----------
  {
    name: "platform.create_plan_alias",
    description: "Alias: accept `plan`, `rg`, `location`, `skuName` → platform.create_app_service_plan.",
    inputSchema: z.object({
      plan: z.string(),
      rg: z.string(),
      location: z.string(),
      skuName: z.enum(["P1v3", "P2v3"]).default("P1v3"),
      capacity: z.number().int().min(1).max(30).default(1)
    }).strict(),
    handler: async (a) => {
      const mapped = {
        resourceGroupName: a.rg,
        planName: a.plan,
        location: a.location,
        sku: { name: a.skuName, capacity: a.capacity }
      };
      const follow = `@platform create_app_service_plan resourceGroupName "${mapped.resourceGroupName}" planName "${mapped.planName}" location "${mapped.location}" sku ${JSON.stringify(mapped.sku)} confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_app_service_plan", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Web App ----------
  {
    name: "platform.create_web_alias",
    description: "Alias: accept `app`, `plan`, `rg`, `location`, `runtime` → platform.create_web_app.",
    inputSchema: z.object({
      app: z.string(),
      plan: z.string(),
      rg: z.string(),
      location: z.string(),
      runtime: z.enum(["NODE|20-lts", "DOTNET|8.0"])
    }).strict(),
    handler: async (a) => {
      const mapped = { resourceGroupName: a.rg, appName: a.app, planName: a.plan, location: a.location, runtimeStack: a.runtime };
      const follow = `@platform create_web_app resourceGroupName "${mapped.resourceGroupName}" appName "${mapped.appName}" planName "${mapped.planName}" location "${mapped.location}" runtimeStack "${mapped.runtimeStack}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_web_app", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Web App Settings ----------
  {
    name: "platform.create_web_settings_alias",
    description: "Alias: accept `app`, `rg`, `settings` → platform.create_webapp_settings.",
    inputSchema: z.object({
      app: z.string(),
      rg: z.string(),
      settings: z.record(z.string())
    }).strict(),
    handler: async (a) => {
      const mapped = { resourceGroupName: a.rg, appName: a.app, settings: a.settings };
      const follow = `@platform create_webapp_settings resourceGroupName "${mapped.resourceGroupName}" appName "${mapped.appName}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_webapp_settings", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Web App Identity ----------
  {
    name: "platform.enable_web_identity_alias",
    description: "Alias: accept `app`, `rg` → platform.create_webapp_identity (enable MSI).",
    inputSchema: z.object({
      app: z.string(),
      rg: z.string()
    }).strict(),
    handler: async (a) => {
      const mapped = { resourceGroupName: a.rg, appName: a.app };
      const follow = `@platform create_webapp_identity resourceGroupName "${mapped.resourceGroupName}" appName "${mapped.appName}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_webapp_identity", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Key Vault ----------
  {
    name: "platform.create_kv_alias",
    description: "Alias: accept `kv`, `rg`, `location`, `tenantId`, optional `skuName`, `rbac`, `pna`, `tags` → platform.create_key_vault.",
    inputSchema: z.object({
      kv: z.string(),
      rg: z.string(),
      location: z.string(),
      tenantId: z.string(),
      skuName: z.enum(["standard", "premium"]).default("standard"),
      rbac: z.boolean().default(true),
      pna: z.enum(["Enabled", "Disabled"]).default("Enabled"),
      tags: z.any().optional()
    }).strict(),
    handler: async (a) => {
      const mapped = {
        resourceGroupName: a.rg,
        vaultName: a.kv,
        location: a.location,
        tenantId: a.tenantId,
        skuName: a.skuName,
        enableRbacAuthorization: a.rbac,
        publicNetworkAccess: a.pna,
        tags: coerceTags(a.tags)
      };
      const follow = `@platform create_key_vault resourceGroupName "${mapped.resourceGroupName}" vaultName "${mapped.vaultName}" location "${mapped.location}" tenantId "${mapped.tenantId}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_key_vault", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Storage ----------
  {
    name: "platform.create_storage_alias",
    description: "Alias: accept `account`, `rg`, `location`, optional `skuName`, `kind`, `tags` → platform.create_storage_account.",
    inputSchema: z.object({
      account: z.string().regex(/^[a-z0-9]{3,24}$/),
      rg: z.string(),
      location: z.string(),
      skuName: z.enum(["Standard_LRS", "Standard_GRS", "Standard_RAGRS", "Standard_ZRS", "Premium_LRS"]).default("Standard_LRS"),
      kind: z.enum(["StorageV2", "BlobStorage", "BlockBlobStorage", "FileStorage", "Storage"]).default("StorageV2"),
      tags: z.any().optional()
    }).strict(),
    handler: async (a) => {
      const mapped = {
        resourceGroupName: a.rg,
        accountName: a.account,
        location: a.location,
        skuName: a.skuName,
        kind: a.kind,
        tags: coerceTags(a.tags)
      };
      const follow = `@platform create_storage_account resourceGroupName "${mapped.resourceGroupName}" accountName "${mapped.accountName}" location "${mapped.location}" skuName "${mapped.skuName}" kind "${mapped.kind}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_storage_account", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Log Analytics ----------
  {
    name: "platform.create_law_alias",
    description: "Alias: accept `workspace`, `rg`, `location`, optional `retentionInDays` → platform.create_log_analytics.",
    inputSchema: z.object({
      workspace: z.string(),
      rg: z.string(),
      location: z.string(),
      retentionInDays: z.number().int().min(7).max(730).default(30)
    }).strict(),
    handler: async (a) => {
      const mapped = {
        resourceGroupName: a.rg,
        workspaceName: a.workspace,
        location: a.location,
        retentionInDays: a.retentionInDays
      };
      const follow = `@platform create_log_analytics resourceGroupName "${mapped.resourceGroupName}" workspaceName "${mapped.workspaceName}" location "${mapped.location}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_log_analytics", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Static Web App ----------
  {
    name: "platform.create_swa_alias",
    description: "Alias: accept `name`, `rg`, `location`, optional `skuName` → platform.create_static_web_app.",
    inputSchema: z.object({
      name: z.string(),
      rg: z.string(),
      location: z.string(),
      skuName: z.enum(["Free", "Standard", "StandardPlus"]).default("Free")
    }).strict(),
    handler: async (a) => {
      const mapped = { resourceGroupName: a.rg, name: a.name, location: a.location, skuName: a.skuName };
      const follow = `@platform create_static_web_app resourceGroupName "${mapped.resourceGroupName}" name "${mapped.name}" location "${mapped.location}" skuName "${mapped.skuName}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_static_web_app", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Link SWA to Repo ----------
  {
    name: "platform.link_swa_repo_alias",
    description: "Alias: accept `name`, `rg`, `owner`, `repo`, optional `branch` → platform.link_static_webapp_repo.",
    inputSchema: z.object({
      name: z.string(),
      rg: z.string(),
      owner: z.string(),
      repo: z.string(),
      branch: z.string().default("main"),
      appLocation: z.string().default("/"),
      apiLocation: z.string().default("api"),
      outputLocation: z.string().default("dist")
    }).strict(),
    handler: async (a) => {
      const mapped = {
        resourceGroupName: a.rg,
        name: a.name,
        owner: a.owner,
        repo: a.repo,
        branch: a.branch,
        appLocation: a.appLocation,
        apiLocation: a.apiLocation,
        outputLocation: a.outputLocation
      };
      const follow = `@platform link_static_webapp_repo resourceGroupName "${mapped.resourceGroupName}" name "${mapped.name}" owner "${mapped.owner}" repo "${mapped.repo}" branch "${mapped.branch}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.link_static_webapp_repo", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- VNet ----------
  {
    name: "platform.create_vnet_alias",
    description: "Alias: accept `vnet`, `rg`, `location`, optional `addressPrefixes[]` → platform.create_vnet.",
    inputSchema: z.object({
      vnet: z.string(),
      rg: z.string(),
      location: z.string(),
      addressPrefixes: z.array(z.string()).default(["10.0.0.0/16"])
    }).strict(),
    handler: async (a) => {
      const mapped = { resourceGroupName: a.rg, vnetName: a.vnet, location: a.location, addressPrefixes: a.addressPrefixes };
      const follow = `@platform create_vnet resourceGroupName "${mapped.resourceGroupName}" vnetName "${mapped.vnetName}" location "${mapped.location}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_vnet", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Subnet ----------
  {
    name: "platform.create_subnet_alias",
    description: "Alias: accept `subnet`, `vnet`, `rg`, `addressPrefix` → platform.create_subnet.",
    inputSchema: z.object({
      subnet: z.string(),
      vnet: z.string(),
      rg: z.string(),
      addressPrefix: z.string()
    }).strict(),
    handler: async (a) => {
      const mapped = { resourceGroupName: a.rg, vnetName: a.vnet, subnetName: a.subnet, addressPrefix: a.addressPrefix };
      const follow = `@platform create_subnet resourceGroupName "${mapped.resourceGroupName}" vnetName "${mapped.vnetName}" subnetName "${mapped.subnetName}" addressPrefix "${mapped.addressPrefix}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_subnet", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- Private Endpoint ----------
  {
    name: "platform.create_private_endpoint_alias",
    description: "Alias: accept `pe`, `rg`, `location`, `vnet`, `subnet`, `targetResourceId` → platform.create_private_endpoint.",
    inputSchema: z.object({
      pe: z.string(),
      rg: z.string(),
      location: z.string(),
      vnet: z.string(),
      subnet: z.string(),
      targetResourceId: z.string()
    }).strict(),
    handler: async (a) => {
      const mapped = {
        resourceGroupName: a.rg,
        peName: a.pe,
        location: a.location,
        vnetName: a.vnet,
        subnetName: a.subnet,
        targetResourceId: a.targetResourceId
      };
      const follow = `@platform create_private_endpoint resourceGroupName "${mapped.resourceGroupName}" peName "${mapped.peName}" location "${mapped.location}" vnetName "${mapped.vnetName}" subnetName "${mapped.subnetName}" targetResourceId "${mapped.targetResourceId}" confirm true`;
      return { content: [...mcpJson({ tool: "platform.create_private_endpoint", mapped }), ...mcpText(`Mapped alias → run:\n${follow}`)] };
    }
  },

  // ---------- NL Route (best-effort) ----------
  {
    name: "platform.nl_route",
    description: "Parse a single natural language sentence and suggest a platform.* ensure command with mapped args.",
    inputSchema: z.object({
      text: z.string()
    }).strict(),
    handler: async (a) => {
      const t = a.text;

      // dumb heuristics; tweak as needed
      const mRG = /(?:create|make)\s+(?:rg|resource\s+group)\s+([A-Za-z0-9-_]+)/i.exec(t);
      const mRegion = /\b(usgov[a-z]+|[a-z]+[a-z-]+)\b/i.exec(t);
      const mTags = /tags?\s+(\{.*\})/i.exec(t);
      if (mRG) {
        const mapped = { name: mRG[1], location: mRegion?.[1] || "usgovvirginia", tags: mTags ? JSON.parse(mTags[1]) : undefined };
        const follow = `@platform create_resource_group name "${mapped.name}" location "${mapped.location}"${mapped.tags ? ` tags ${JSON.stringify(mapped.tags)}` : ""} confirm true`;
        return { content: [...mcpJson({ tool: "platform.create_resource_group", mapped }), ...mcpText(`Detected RG request → run:\n${follow}`)] };
      }

      const mPlan = /(?:create|make)\s+(?:app\s*service\s*plan|plan)\s+([A-Za-z0-9-_]+)/i.exec(t);
      const mRG2 = /\brg[-=: ]"?([A-Za-z0-9-_]+)"?/i.exec(t);
      const mSku = /\b(P1v3|P2v3)\b/i.exec(t);
      if (mPlan && mRG2) {
        const mapped = { resourceGroupName: mRG2[1], planName: mPlan[1], location: mRegion?.[1] || "usgovvirginia", sku: { name: (mSku?.[1] || "P1v3") as "P1v3" | "P2v3", capacity: 1 } };
        const follow = `@platform create_app_service_plan resourceGroupName "${mapped.resourceGroupName}" planName "${mapped.planName}" location "${mapped.location}" sku ${JSON.stringify(mapped.sku)} confirm true`;
        return { content: [...mcpJson({ tool: "platform.create_app_service_plan", mapped }), ...mcpText(`Detected Plan request → run:\n${follow}`)] };
      }

      const mWeb = /(?:create|make)\s+(?:web\s*app|site)\s+([A-Za-z0-9-_]+)/i.exec(t);
      const mPlan2 = /plan[-=: ]"?([A-Za-z0-9-_]+)"?/i.exec(t);
      const mRuntime = /(NODE\|20-lts|DOTNET\|8\.0)/i.exec(t);
      if (mWeb && mRG2 && mPlan2) {
        const mapped = { resourceGroupName: mRG2[1], appName: mWeb[1], planName: mPlan2[1], location: mRegion?.[1] || "usgovvirginia", runtimeStack: (mRuntime?.[1] || "NODE|20-lts").toUpperCase() };
        const follow = `@platform create_web_app resourceGroupName "${mapped.resourceGroupName}" appName "${mapped.appName}" planName "${mapped.planName}" location "${mapped.location}" runtimeStack "${mapped.runtimeStack}" confirm true`;
        return { content: [...mcpJson({ tool: "platform.create_web_app", mapped }), ...mcpText(`Detected Web App request → run:\n${follow}`)] };
      }

      return { content: [...mcpText("Sorry — I couldn’t confidently parse that into a platform action. Try:\n- “Create RG rg-x in usgovvirginia tags {\"owner\":\"jdoe\",\"env\":\"dev\"}”\n- “Create App Service Plan plan-x in rg-x location usgovvirginia sku P1v3”\n- “Create Web App web-x on plan plan-x in rg-x location usgovvirginia runtime NODE|20-lts”")] };
    }
  }
];