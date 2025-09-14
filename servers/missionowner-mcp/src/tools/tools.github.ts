// servers/developer-mcp/src/tools/github.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import type { Octokit } from "@octokit/rest";

type MakeGithubToolsOpts = {
  client: Octokit;
  namespace?: string;           // default "mission."
};

function text(md: string) { return { type: "text" as const, text: md }; }
function json(j: any) { return { type: "json" as const, json: j }; }

export function makeGithubTools(opts: MakeGithubToolsOpts): ToolDef[] {
  const { client, namespace = "mission." } = opts;
  const n = (s: string) => `${namespace}${s}`;

  // ────────────────────────────────────────────────────────────────────────────
  // CREATE REPO
  // ────────────────────────────────────────────────────────────────────────────
  const create_repo: ToolDef = {
    name: n("create_repo"),
    description: "Create a GitHub repository in an organization (optionally from a template).",
    inputSchema: z.object({
      owner: z.string().min(1),                          // org/login
      name: z.string().min(1),                           // repo name
      visibility: z.enum(["private", "public", "internal"]).default("private"),
      description: z.string().optional(),
      template: z.string().optional(),                   // "org/template-repo"
      default_branch: z.string().optional(),             // e.g. "main"
      auto_init: z.boolean().default(true),              // create README if not templated
      // labels & topics (optional ergonomics)
      labels: z.array(z.string()).optional(),
      topics: z.array(z.string()).optional(),
    }).strict(),
    handler: async (a: any) => {
      try {
        let repo;
        if (a.template) {
          const [tplOwner, tplRepo] = String(a.template).split("/");
          const r = await client.repos.createUsingTemplate({
            template_owner: tplOwner,
            template_repo: tplRepo,
            owner: a.owner,
            name: a.name,
            private: a.visibility !== "public",
          });
          repo = r.data;
        } else {
          const r = await client.repos.createInOrg({
            org: a.owner,
            name: a.name,
            private: a.visibility !== "public",
            visibility: a.visibility as any,
            description: a.description,
            auto_init: a.auto_init,
          });
          repo = r.data;
        }

        // optional: default branch override
        if (a.default_branch) {
          await client.repos.update({
            owner: a.owner,
            repo: a.name,
            default_branch: a.default_branch,
          });
        }

        // optional: labels
        if (Array.isArray(a.labels) && a.labels.length) {
          await Promise.allSettled(
            a.labels.map((label: string) =>
              client.issues.createLabel({ owner: a.owner, repo: a.name, name: label }).catch(() => {})
            )
          );
        }
        // optional: topics
        if (Array.isArray(a.topics) && a.topics.length) {
          await client.repos.replaceAllTopics({ owner: a.owner, repo: a.name, names: a.topics });
        }

        const md = [
          `### ✅ Repository created`,
          ``,
          `| **Repository** | **Visibility** | **Owner** |\n`,
          "|---|---|---|",
          `| **${repo.full_name}** | \`${repo.visibility}\` | \`${repo.owner.login ?? '-'}\` |`,
          ``,
          `[Open in GitHub](${repo.html_url})`,
        ].join("\n");

        return { content: [text(md), json({ status: "done", repo })] };
      } catch (e: any) {
        return { content: [json({ status: "error", error: { type: "GitHubError", message: e?.message, raw: e } })], isError: true };
      }
    },
  };

  // ────────────────────────────────────────────────────────────────────────────
  // ADD/SET REPO SECRET  (requires tweetsodium dependency)
  // ────────────────────────────────────────────────────────────────────────────
  const add_repo_secret: ToolDef = {
    name: n("add_repo_secret"),
    description: "Create or update a GitHub Actions repository secret.",
    inputSchema: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      secretName: z.string().min(1),
      value: z.string().min(1),
    }).strict(),
    handler: async (a: any) => {
      try {
        // 1) get repo public key
        const { data: key } = await client.actions.getRepoPublicKey({
          owner: a.owner, repo: a.repo,
        });
        // 2) encrypt with libsodium
        const { default: sodium } = await import("tweetsodium"); // add to package.json
        const messageBytes = Buffer.from(a.value);
        const keyBytes = Buffer.from(key.key, "base64");
        const encryptedBytes = sodium.seal(messageBytes, keyBytes);
        const encrypted_value = Buffer.from(encryptedBytes).toString("base64");

        // 3) set secret
        await client.actions.createOrUpdateRepoSecret({
          owner: a.owner,
          repo: a.repo,
          secret_name: a.secretName,
          encrypted_value,
          key_id: key.key_id,
        });

        const md = [
          `### 🔐 Secret set`,
          ``,
          `\`${a.owner}/${a.repo}\` — secret **${a.secretName}**`,
        ].join("\n");
        return { content: [text(md), json({ status: "done" })] };
      } catch (e: any) {
        return { content: [json({ status: "error", error: { type: "GitHubError", message: e?.message, raw: e } })], isError: true };
      }
    },
  };

  // ────────────────────────────────────────────────────────────────────────────
  // PROTECT BRANCH
  // ────────────────────────────────────────────────────────────────────────────
  const protect_branch: ToolDef = {
    name: n("protect_branch"),
    description: "Enable branch protection with sensible defaults.",
    inputSchema: z.object({
      owner: z.string().min(1),
      repo: z.string().min(1),
      branch: z.string().default("main"),
      require_reviews: z.boolean().default(true),
      required_approving_review_count: z.number().int().min(0).max(6).default(1),
      dismiss_stale: z.boolean().default(true),
      enforce_admins: z.boolean().default(true),
      require_status_checks: z.boolean().default(false),
      required_status_checks: z.array(z.string()).default([]),
    }).strict(),
    handler: async (a: any) => {
      try {
        // GitHub API requires a full object for protection
        const rules: any = {
          required_pull_request_reviews: a.require_reviews ? {
            required_approving_review_count: a.required_approving_review_count,
            dismiss_stale_reviews: a.dismiss_stale,
          } : null,
          enforce_admins: a.enforce_admins,
          restrictions: null,
          required_status_checks: a.require_status_checks ? {
            strict: false,
            contexts: a.required_status_checks,
          } : null,
          allow_force_pushes: false,
          allow_deletions: false,
        };

        await client.repos.updateBranchProtection({
          owner: a.owner,
          repo: a.repo,
          branch: a.branch,
          ...rules,
        } as any);

        const md = `### 🛡️ Branch protected\n\n\`${a.owner}/${a.repo}\` — \`${a.branch}\``;
        return { content: [text(md), json({ status: "done" })] };
      } catch (e: any) {
        return { content: [json({ status: "error", error: { type: "GitHubError", message: e?.message, raw: e } })], isError: true };
      }
    },
  };

  return [create_repo, add_repo_secret, protect_branch];
}