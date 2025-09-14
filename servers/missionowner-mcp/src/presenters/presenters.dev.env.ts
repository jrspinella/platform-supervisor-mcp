// servers/developer-mcp/src/tools/dev_wizard.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { oidcNodeWorkflowYml } from "../utils/utils.workflow.js";

type Content = { type: "text"; text: string } | { type: "json"; json: any };
const text = (s: string): Content => ({ type: "text", text: s });

function h3(s: string) { return `### ${s}`; }
function stepTitle(i: number, t: string, emoji = "✅") { return `\n\n${h3(`${emoji} Step ${i}: ${t}`)}`; }

const WizardSchema = z.object({
  // GitHub
  org: z.string(),
  repo: z.string(),
  createRepo: z.boolean().default(true),
  visibility: z.enum(["private", "public", "internal"]).default("private"),
  defaultBranch: z.string().default("main"),

  environmentName: z.string().default("dev"),
  protectBranch: z.boolean().default(true),

  // OIDC / secrets
  setAzureSecrets: z.boolean().default(true),
  azureTenantId: z.string().optional(),
  azureSubscriptionId: z.string().optional(),
  azureClientId: z.string().optional(), // federated app

  addWorkflow: z.boolean().default(true),

  // Azure infra (provisioned by Platform MCP)
  applyAzure: z.boolean().default(true),
  resourceGroupName: z.string(),
  location: z.string().default(process.env.AZURE_DEFAULT_LOCATION || "usgovvirginia"),
  appServicePlanName: z.string(),
  webAppName: z.string(),
  sku: z.string().default("P1v3"),
  runtime: z.string().default("NODE|20-lts"),

  // Optional governance tag glue
  tags: z.record(z.string()).optional(),

  // Platform MCP URL (for platform.apply_plan)
  platformUrl: z.string().default(process.env.PLATFORM_URL || "http://127.0.0.1:8721/rpc"),
}).strict();

async function callJsonRpc(url: string, method: string, params: any) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const j = await r.json();
  if (j?.error) {
    const e: any = new Error(j.error?.message || "JSON-RPC error");
    e.rpc = j.error; throw e;
  }
  return j?.result;
}

async function detectPlatformCallMethod(platformUrl: string): Promise<string> {
  try { await callJsonRpc(platformUrl, "tools.list", {}); return "tools.call"; } catch {}
  const candidates = ["tools.call", "tool.call", "tools.invoke", "mcp.callTool"];
  for (const m of candidates) {
    try { await callJsonRpc(platformUrl, m, { name: "__probe__", arguments: {} }); return m; }
    catch (e: any) { if (e?.rpc?.code === -32601) continue; return m; }
  }
  throw new Error(`No compatible Platform call method found at ${platformUrl}`);
}

export function makeDevWizardTools(opts: { resolveTool: (name: string) => ToolDef | undefined }): ToolDef[] {
  const wizard: ToolDef = {
    name: "developer.dev_env_wizard",
    description: "End-to-end developer environment setup (GitHub repo/env + Azure RG/Plan/WebApp via Platform MCP).",
    inputSchema: WizardSchema,
    handler: async (a) => {
      const out: Content[] = [];
      let step = 1;

      // 1) Create (or assume) repo
      if (a.createRepo) {
        out.push(text(stepTitle(step++, `Create GitHub repo \`${a.org}/${a.repo}\``)));
        const t = opts.resolveTool("github.create_repo");
        if (!t) return { content: [text("❌ Missing tool github.create_repo")], isError: true };
        const res = await t.handler({
          org: a.org, name: a.repo, visibility: a.visibility, autoInit: true, defaultBranch: a.defaultBranch, gitignoreTemplate: "Node",
        });
        out.push(...(res?.content ?? []));
        if (res?.isError) return { content: out, isError: true };
      }

      // 2) Environment
      {
        out.push(text(stepTitle(step++, `Add environment \`${a.environmentName}\``)));
        const t = opts.resolveTool("github.add_environment");
        if (!t) return { content: [text("❌ Missing tool github.add_environment")], isError: true };
        const res = await t.handler({ org: a.org, repo: a.repo, environmentName: a.environmentName, waitTimer: 0 });
        out.push(...(res?.content ?? []));
        if (res?.isError) return { content: out, isError: true };
      }

      // 3) Secrets (OIDC inputs)
      if (a.setAzureSecrets) {
        out.push(text(stepTitle(step++, "Set repo secrets (AZURE_* for OIDC)")));
        const setSecret = opts.resolveTool("github.set_repo_secret");
        if (!setSecret) return { content: [text("❌ Missing tool github.set_repo_secret")], isError: true };
        const secrets: Record<string,string|undefined> = {
          AZURE_TENANT_ID: a.azureTenantId,
          AZURE_SUBSCRIPTION_ID: a.azureSubscriptionId,
          AZURE_CLIENT_ID: a.azureClientId,
        };
        for (const [k, v] of Object.entries(secrets)) {
          if (!v) continue;
          const res = await setSecret.handler({ org: a.org, repo: a.repo, name: k, value: v });
          out.push(...(res?.content ?? []));
          if (res?.isError) return { content: out, isError: true };
        }
      }

      // 4) Branch protection
      if (a.protectBranch) {
        out.push(text(stepTitle(step++, `Protect branch \`${a.defaultBranch}\``)));
        const t = opts.resolveTool("github.protect_branch");
        if (!t) return { content: [text("❌ Missing tool github.protect_branch")], isError: true };
        const res = await t.handler({
          org: a.org, repo: a.repo, branch: a.defaultBranch,
          requirePullRequestReviews: true, requiredApprovingReviewCount: 1, dismissStaleReviews: true,
          enforceAdmins: true, requiredStatusChecks: { strict: true, contexts: [] },
        });
        out.push(...(res?.content ?? []));
        if (res?.isError) return { content: out, isError: true };
      }

      // 5) Workflow
      if (a.addWorkflow) {
        out.push(text(stepTitle(step++, "Commit CI workflow (.github/workflows/ci.yml)")));
        const t = opts.resolveTool("github.add_workflow_file");
        if (!t) return { content: [text("❌ Missing tool github.add_workflow_file")], isError: true };
        const yml = oidcNodeWorkflowYml({ envName: a.environmentName });
        const res = await t.handler({ org: a.org, repo: a.repo, path: ".github/workflows/ci.yml", message: "chore: add CI (OIDC)", content: yml, branch: a.defaultBranch });
        out.push(...(res?.content ?? []));
        if (res?.isError) return { content: out, isError: true };
      }

      // 6) Azure infra (call Platform MCP plan)
      const plan = {
        apply: true,
        profile: process.env.ATO_PROFILE || "default",
        render: "compact",
        steps: [
          { tool: "platform.create_resource_group", args: { name: a.resourceGroupName, location: a.location, ...(a.tags ? { tags: a.tags } : {}) } },
          { tool: "platform.create_app_service_plan", args: { resourceGroupName: a.resourceGroupName, name: a.appServicePlanName, location: a.location, sku: a.sku } },
          { tool: "platform.create_web_app", args: { resourceGroupName: a.resourceGroupName, name: a.webAppName, location: a.location, appServicePlanName: a.appServicePlanName, httpsOnly: true, minimumTlsVersion: "1.2", ftpsState: "Disabled", runtimeStack: a.runtime } },
        ],
      };

      if (a.applyAzure) {
        out.push(text(stepTitle(step++, `Provision Azure RG/Plan/WebApp via Platform MCP`)));
        try {
          const callMethod = await detectPlatformCallMethod(a.platformUrl);
          const res = await callJsonRpc(a.platformUrl, callMethod, { name: "platform.apply_plan", arguments: plan });
          // Echo back Platform’s cards/JSON as-is
          const platformContent: Content[] = Array.isArray(res?.content) ? res.content : [];
          out.push(...platformContent);
        } catch (e: any) {
          out.push(text("**Error calling Platform MCP**"));
          out.push({ type: "json", json: { status: "error", error: e?.rpc || { message: e?.message || String(e) } } });
          return { content: out, isError: true };
        }
      } else {
        out.push(text(stepTitle(step++, "Azure plan (not applied)")));
        out.push({ type: "json", json: plan });
      }

      // Done
      out.push({ type: "json", json: { status: "done" } });
      return { content: out };
    },
  };

  return [wizard];
}