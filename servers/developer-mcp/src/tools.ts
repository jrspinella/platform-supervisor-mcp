import { z } from "zod";
import path from "node:path";
import { mcpJson, mcpText } from "./utils.js";
import { catalogHybrid, loadTemplateFilesHybrid } from "./catalog.js";
import { renderFiles } from "./renderer.js";
import type { ToolDef } from "mcp-http";
import { CatalogEntry } from "./types.js";
import { callMcp, firstJson } from "./mcp.js";

// ---------- config ----------
const GOVERNANCE_URL = process.env.GOVERNANCE_URL || "";
const GITHUB_MCP_URL = process.env.GITHUB_MCP_URL || "";
const PLATFORM_MCP_URL = process.env.PLATFORM_MCP_URL || "";

// ---------- helpers ----------
async function governanceEvaluate(toolFq: string, args: any) {
  if (!GOVERNANCE_URL) return { decision: "allow", reasons: [], policyIds: [], suggestions: [] };
  const res = await callMcp(GOVERNANCE_URL, "governance.evaluate", { tool: toolFq, args });
  const json = firstJson(res.json);
  return json || { decision: "allow", reasons: [], policyIds: [], suggestions: [] };
}

// ---------- schemas ----------
const MintSchema = z.object({
  templateId: z.string(),
  projectName: z.string(),
  owner: z.string(),
  repoName: z.string().optional(),
  params: z.record(z.any()).default({}),
  private: z.boolean().default(true),
  defaultBranch: z.string().default("main"),
  infra: z.object({
    createRg: z.boolean().default(false),
    createKv: z.boolean().default(false),
    region: z.string().default("usgovvirginia"),
    tags: z.record(z.string()).default({})
  }).default({}),
  dryRun: z.boolean().default(true),
  confirm: z.boolean().default(false)
}).strict();

const PreviewSchema = z.object({
  templateId: z.string(),
  params: z.record(z.any()).default({})
}).strict();

const GetSchema = z.object({ templateId: z.string() }).strict();

// ---------- tools ----------
export const tools: ToolDef[] = [
  {
    name: "developer.list_templates",
    description: "List available developer templates (GitHub-hosted catalog preferred).",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const items = (await catalogHybrid()).map(c => ({
        id: c.id, name: c.manifest.name, version: c.manifest.version, description: c.manifest.description,
        inputs: c.manifest.inputs, actions: c.manifest.actions, controls: c.manifest.controls
      }));
      return { content: [...mcpJson({ count: items.length, items })] };
    }
  },
  {
    name: "developer.get_template",
    description: "Get a template's manifest.",
    inputSchema: GetSchema,
    handler: async (a) => {
      const all = await catalogHybrid();
      const c = all.find(x => x.id === a.templateId);
      if (!c) return { content: [...mcpText(`Template '${a.templateId}' not found`)], isError: true };
      return { content: [...mcpJson(c.manifest)] };
    }
  },
  {
    name: "developer.preview_template",
    description: "Render a template (dry-run) to view the file tree and first 1KB of each file.",
    inputSchema: PreviewSchema,
    handler: async (a) => {
      const all = await catalogHybrid();
      const c = all.find(x => x.id === a.templateId);
      if (!c) return { content: [...mcpText(`Template '${a.templateId}' not found`)], isError: true };
      const files = await loadTemplateFilesHybrid(c);
      const rendered = renderFiles(files, a.params || {});
      const preview = rendered.map(f => ({
        path: f.path,
        size: f.content.length,
        sample: f.content.slice(0, 1024)
      }));
      return { content: [...mcpJson({ templateId: a.templateId, count: preview.length, preview })] };
    }
  },
  {
    name: "developer.mint_project",
    description: "Create a new project from an approved template (repo + CI; optional infra via Platform MCP).",
    inputSchema: MintSchema,
    handler: async (a) => {
      const all = await catalogHybrid();
      const c = all.find(x => x.id === a.templateId);
      if (!c) return { content: [...mcpText(`Template '${a.templateId}' not found`)], isError: true };

      const repoName = a.repoName || a.projectName.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      const values = { projectName: a.projectName, repoName, owner: a.owner, ...a.params };

      // Optional developer-level preflight
      const pre = await governanceEvaluate("developer.mint_project", {
        templateId: a.templateId, projectName: a.projectName, owner: a.owner, repoName, params: a.params, infra: a.infra
      });
      if (pre.decision === "deny") {
        return {
          content: [
            ...mcpJson({ status: "denied", reasons: pre.reasons, suggestions: pre.suggestions }),
            ...mcpText(`Governance denied mint_project: ${pre.reasons.join(" | ")}`)
          ],
          isError: true
        };
      }

      const files = renderFiles(await loadTemplateFilesHybrid(c), values);

      if (a.dryRun || !a.confirm) {
        const plan = {
          repo: { owner: a.owner, name: repoName, private: a.private, defaultBranch: a.defaultBranch },
          files: files.map(f => f.path),
          infra: a.infra,
          governance: pre
        };
        const followup = `@developer mint project templateId "${a.templateId}" projectName "${a.projectName}" owner "${a.owner}" repoName "${repoName}" confirm true dryRun false`;
        return {
          content: [
            ...mcpJson({ status: "pending", plan }),
            ...mcpText(
              [
                `Plan to mint '${a.projectName}' from '${c.manifest.name}'`,
                `• Repo: ${a.owner}/${repoName} (private=${a.private}, branch=${a.defaultBranch})`,
                `• Files: ${files.length}`,
                a.infra?.createRg || a.infra?.createKv ? `• Infra: ${JSON.stringify(a.infra)}` : `• Infra: none`,
                pre.decision !== "allow" ? `• Governance: ${pre.decision} — ${pre.reasons.join(" | ")}` : "• Governance: ALLOW",
                "",
                "Reply to execute:",
                followup
              ].join("\n")
            )
          ]
        };
      }

      // EXECUTE against GitHub MCP (which does its own governance)
      if (!GITHUB_MCP_URL) {
        return { content: [...mcpText("GITHUB_MCP_URL not set")], isError: true };
      }

      // 1) Create repo
      const createRes = await callMcp(GITHUB_MCP_URL, "github.create_repo", {
        owner: a.owner,
        name: repoName,
        description: `${a.projectName} (scaffolded by Developer MCP)`,
        private: a.private,
        defaultBranch: a.defaultBranch
      });
      if (!createRes.ok || (createRes.json && (createRes.json.error || createRes.status >= 400))) {
        return { content: [...mcpText(`Repo creation failed: ${JSON.stringify(createRes.json).slice(0,800)}`)], isError: true };
      }

      // 2) Commit rendered files
      const filesMap = Object.fromEntries(files.map(f => [f.path, f.content]));
      const commitRes = await callMcp(GITHUB_MCP_URL, "github.commit_files", {
        owner: a.owner,
        repo: repoName,
        message: "chore: initial scaffold",
        files: filesMap
      });
      if (!commitRes.ok || commitRes.json?.error) {
        return { content: [...mcpText(`Commit failed: ${JSON.stringify(commitRes.json).slice(0,800)}`)], isError: true };
      }

      // 3) Optional repo hardening based on manifest actions
      const acts = c.manifest.actions?.github || {};
      if (acts.enableSecurity) {
        await callMcp(GITHUB_MCP_URL, "github.enable_repo_security", {
          owner: a.owner, repo: repoName,
          secretScanning: true, secretScanningPushProtection: true, dependabotSecurityUpdates: true
        });
      }
      if (acts.addCodeowners) {
        await callMcp(GITHUB_MCP_URL, "github.add_codeowners", {
          owner: a.owner, repo: repoName,
          entries: [{ pattern: "*", owners: ["@"+a.owner+"/platform-team"] }]
        });
      }
      if (acts.protectMain) {
        await callMcp(GITHUB_MCP_URL, "github.protect_branch", {
          owner: a.owner, repo: repoName, branch: a.defaultBranch,
          requireCodeOwnerReviews: true, requiredApprovingReviewCount: 1, enforceAdmins: true, blockForcePushes: true
        });
      }

      // 4) Optional infra step via Platform MCP (which does its own governance → Azure MCP)
      const infraResults: any[] = [];
      if (a.infra && PLATFORM_MCP_URL) {
        if (a.infra.createRg) {
          infraResults.push(await callMcp(PLATFORM_MCP_URL, "platform.create_resource_group", {
            name: `rg-${repoName}`,
            location: a.infra.region,
            tags: a.infra.tags,
            confirm: true
          }));
        }
        if (a.infra.createKv) {
          infraResults.push(await callMcp(PLATFORM_MCP_URL, "platform.create_key_vault", {
            resourceGroupName: `rg-${repoName}`,
            vaultName: `kv-${repoName}`.slice(0,24),
            location: a.infra.region,
            tenantId: a.params?.tenantId,
            enableRbacAuthorization: true,
            publicNetworkAccess: "Enabled",
            confirm: true
          }));
        }
      }

      return {
        content: [
          ...mcpJson({
            status: "done",
            repo: { owner: a.owner, name: repoName },
            governance: pre,
            infra: infraResults.map(r => firstJson(r.json) ?? r.json)
          }),
          ...mcpText(`✅ Created ${a.owner}/${repoName} and pushed ${files.length} files.`)
        ]
      };
    }
  }
];