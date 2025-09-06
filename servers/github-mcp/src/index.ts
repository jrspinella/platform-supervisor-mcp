import "dotenv/config";
import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";
import { makeGitHubClient } from "auth/src/github.js";
// ⬇️ make sure this path matches your file name ("repoWizardTools.ts" -> ".js" at runtime)
import { repoWizardTools } from "./repoWizardTools.js";

const PORT = Number(process.env.PORT ?? 8711);

const GITHUB_APP_ID = Number(process.env.GITHUB_APP_ID);
const GITHUB_PRIVATE_KEY = (process.env.GITHUB_PRIVATE_KEY || "").replace(/\\n/g, "\n");
// Installation can be omitted; we’ll prefer owner/org-based discovery in handlers
const GITHUB_INSTALLATION_ID = process.env.GITHUB_INSTALLATION_ID
  ? Number(process.env.GITHUB_INSTALLATION_ID)
  : undefined;

if (!GITHUB_APP_ID || !GITHUB_PRIVATE_KEY || GITHUB_INSTALLATION_ID === undefined) {
  throw new Error("Missing GITHUB_APP_ID, GITHUB_PRIVATE_KEY, or GITHUB_INSTALLATION_ID");
}

const ghFactory = makeGitHubClient(GITHUB_APP_ID, GITHUB_INSTALLATION_ID, GITHUB_PRIVATE_KEY);

function withErrors<TArgs>(fn: (args: TArgs) => Promise<any>) {
  return async (args: TArgs) => {
    try {
      return await fn(args);
    } catch (err: any) {
      const status = err?.status ?? err?.response?.status;
      const data = err?.response?.data ?? err?.response?.body ?? err?.request?.options ?? {};
      return {
        content: [
          { type: "text", text: `GitHub error${status ? ` ${status}` : ""}: ${err?.message || "unknown"}` },
          { type: "json", json: data }
        ],
        isError: true
      };
    }
  };
}

// Resolve a file's sha if it exists (so we decide create vs update)
async function getFileSha(octokit: any, owner: string, repo: string, path: string, ref?: string) {
  try {
    const res = await octokit.repos.getContent({ owner, repo, path, ref });
    // If the path is a file, we will have a sha string on the returned object
    // (Directories return arrays.)
    const data: any = res.data;
    if (data && typeof data.sha === "string") return data.sha;
    return undefined;
  } catch (e: any) {
    if (e?.status === 404) return undefined;
    throw e;
  }
}

// Encrypt a GitHub Actions secret value using the repo’s public key
async function encryptWithTweetsodium(plaintext: string, base64PublicKey: string) {
  // Lazy import to avoid loading unless needed
  const sodiumMod = await import("tweetsodium");
  const sodium: any = (sodiumMod as any).default ?? sodiumMod;

  const messageBytes = Buffer.from(plaintext, "utf8");
  const keyBytes = Buffer.from(base64PublicKey, "base64");
  const encryptedBytes: Uint8Array = sodium.seal(messageBytes, keyBytes);
  return Buffer.from(encryptedBytes).toString("base64");
}

const tools = [
  // Debug: show which app we are
  {
    name: "github.debug_app",
    description: "Returns authenticated GitHub App info (name, slug).",
    inputSchema: z.object({}).strict(),
    handler: withErrors(async () => {
      const appOcto = (await ghFactory.appJwtOctokit()) as any;
      const { data } = await appOcto.apps.getAuthenticated();
      return { content: [{ type: "json", json: { id: data.id, name: data.name, slug: data.slug } }] };
    })
  },

  // Debug: list installations for this app (first page)
  {
    name: "github.debug_installations",
    description: "Lists installations for this GitHub App (first page).",
    inputSchema: z.object({}).strict(),
    handler: withErrors(async () => {
      const appOcto = (await ghFactory.appJwtOctokit()) as any;
      const { data } = await appOcto.apps.listInstallations({ per_page: 30 });
      return { content: [{ type: "json", json: data }] };
    })
  },

  // If you want to see repos for a specific installation/owner
  {
    name: "github.list_repos",
    description: "List repositories accessible to the installation. Pass owner to select the correct installation.",
    inputSchema: z.object({ owner: z.string().optional(), per_page: z.number().int().min(1).max(100).default(100) }).strict(),
    handler: withErrors(async ({ owner, per_page }: { owner?: string; per_page: number }) => {
      const octokit = (await ghFactory.forInstallation(owner)) as any; // ⬅️ pass owner
      const { data } = await octokit.apps.listReposAccessibleToInstallation({ per_page });
      return {
        content: [
          {
            type: "json" as const,
            json: data.repositories.map((r: any) => ({ name: r.name, full_name: r.full_name, private: r.private }))
          }
        ]
      };
    })
  },

  {
    name: "github.create_repo",
    description: "Create a repository in an organization.",
    inputSchema: z.object({
      org: z.string(),
      name: z.string(),
      description: z.string().optional(),
      private: z.boolean().default(true),
      auto_init: z.boolean().default(true)
    }).strict(),
    handler: withErrors(async ({ org, name, description, private: priv, auto_init }: any) => {
      const octokit = (await ghFactory.forInstallation(org)) as any; // ⬅️ pass org
      const { data } = await octokit.repos.createInOrg({ org, name, description, private: priv, auto_init } as any);
      return { content: [{ type: "json", json: { full_name: data.full_name, html_url: data.html_url, private: data.private } }] };
    })
  },

  {
    name: "github.create_issue",
    description: "Create an issue in a repo.",
    inputSchema: z.object({ owner: z.string(), repo: z.string(), title: z.string(), body: z.string().optional() }).strict(),
    handler: withErrors(async ({ owner, repo, title, body }: any) => {
      const octokit = (await ghFactory.forInstallation(owner)) as any; // ⬅️ pass owner
      const { data } = await octokit.issues.create({ owner, repo, title, body });
      return { content: [{ type: "json" as const, json: { url: data.html_url, number: data.number } }] };
    })
  },

  {
    name: "github.comment_issue",
    description: "Comment on an issue or PR by number.",
    inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number(), body: z.string() }).strict(),
    handler: withErrors(async ({ owner, repo, number, body }: any) => {
      const octokit = (await ghFactory.forInstallation(owner)) as any; // ⬅️ pass owner
      const { data } = await octokit.issues.createComment({ owner, repo, issue_number: number, body });
      return { content: [{ type: "json" as const, json: { url: data.html_url } }] };
    })
  },

  {
    name: "github.create_pr",
    description: "Open a pull request.",
    inputSchema: z.object({ owner: z.string(), repo: z.string(), title: z.string(), head: z.string(), base: z.string(), body: z.string().optional() }).strict(),
    handler: withErrors(async ({ owner, repo, title, head, base, body }: any) => {
      const octokit = (await ghFactory.forInstallation(owner)) as any; // ⬅️ pass owner
      const { data } = await octokit.pulls.create({ owner, repo, title, head, base, body });
      return { content: [{ type: "json" as const, json: { url: data.html_url, number: data.number } }] };
    })
  },

  {
    name: "github.review_pr",
    description: "Leave a PR review: APPROVE | REQUEST_CHANGES | COMMENT.",
    inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number(), event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).default("COMMENT"), body: z.string().optional() }).strict(),
    handler: withErrors(async ({ owner, repo, number, event, body }: any) => {
      const octokit = (await ghFactory.forInstallation(owner)) as any; // ⬅️ pass owner
      const { data } = await octokit.pulls.createReview({ owner, repo, pull_number: number, event, body });
      return { content: [{ type: "json", json: data }] };
    })
  },

  {
    name: "github.merge_pr",
    description: "Merge a pull request by number.",
    inputSchema: z.object({ owner: z.string(), repo: z.string(), number: z.number(), merge_method: z.enum(["merge", "squash", "rebase"]).default("merge") }).strict(),
    handler: withErrors(async ({ owner, repo, number, merge_method }: any) => {
      const octokit = (await ghFactory.forInstallation(owner)) as any; // ⬅️ pass owner
      const { data } = await octokit.pulls.merge({ owner, repo, pull_number: number, merge_method });
      return { content: [{ type: "json" as const, json: data }] };
    })
  },

  {
    name: "github.create_branch",
    description: "Create a branch from a base branch.",
    inputSchema: z.object({ owner: z.string(), repo: z.string(), base: z.string(), branch: z.string() }).strict(),
    handler: withErrors(async ({ owner, repo, base, branch }: any) => {
      const octokit = (await ghFactory.forInstallation(owner)) as any; // ⬅️ pass owner
      const baseRef = await octokit.git.getRef({ owner, repo, ref: `heads/${base}` });
      const sha = baseRef.data.object.sha;
      const r = await octokit.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha });
      return { content: [{ type: "json", json: r.data }] };
    })
  },
  // --- Create or update a file in a repo (contents API) ---
  {
    name: "github.create_or_update_file",
    description: "Create or update a file in a repository via the Contents API.",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      path: z.string(),                     // e.g. .github/workflows/build.yml
      message: z.string(),                  // commit message
      contentBase64: z.string(),            // base64-encoded file contents
      branch: z.string().default("main"),
      authorName: z.string().optional(),
      authorEmail: z.string().optional(),
      committerName: z.string().optional(),
      committerEmail: z.string().optional()
    }).strict(),
    handler: withErrors(async (args: any) => {
      const octokit = (await ghFactory.forInstallation()) as any;

      const sha = await getFileSha(octokit, args.owner, args.repo, args.path, args.branch);

      const payload: any = {
        owner: args.owner,
        repo: args.repo,
        path: args.path,
        message: args.message,
        content: args.contentBase64,
        branch: args.branch,
      };

      if (sha) payload.sha = sha;
      if (args.authorName || args.authorEmail) {
        payload.author = { name: args.authorName || "automation", email: args.authorEmail || "actions@users.noreply.github.com" };
      }
      if (args.committerName || args.committerEmail) {
        payload.committer = { name: args.committerName || "automation", email: args.committerEmail || "actions@users.noreply.github.com" };
      }

      const res = await octokit.repos.createOrUpdateFileContents(payload);

      return {
        content: [{
          type: "json" as const,
          json: {
            action: sha ? "update" : "create",
            content_path: args.path,
            commit_sha: res.data.commit?.sha,
            html_url: res.data.content?.html_url,
            branch: args.branch
          }
        }]
      };
    })
  },

  // --- Set a GitHub Actions repository secret ---
  {
    name: "github.set_repo_secret",
    description: "Create or update a GitHub Actions repository secret. (Encrypts the value using the repo public key.)",
    inputSchema: z.object({
      owner: z.string(),
      repo: z.string(),
      name: z.string(),        // secret name
      value: z.string()        // secret plaintext value
    }).strict(),
    handler: withErrors(async (args: any) => {
      const octokit = (await ghFactory.forInstallation()) as any;

      // 1) Get the repo public key
      const { data: key } = await octokit.actions.getRepoPublicKey({
        owner: args.owner,
        repo: args.repo
      });

      if (!key?.key || !key?.key_id) {
        throw new Error("Failed to obtain repository public key for secrets.");
      }

      // 2) Encrypt the secret using tweetsodium (libsodium sealed box)
      const encrypted_value = await encryptWithTweetsodium(args.value, key.key);

      // 3) Set the secret
      const putRes = await octokit.actions.createOrUpdateRepoSecret({
        owner: args.owner,
        repo: args.repo,
        secret_name: args.name,
        encrypted_value,
        key_id: key.key_id
      });

      return {
        content: [{
          type: "json" as const,
          json: {
            name: args.name,
            status: putRes.status,   // 201 (created) or 204 (updated)
            repo: `${args.owner}/${args.repo}`
          }
        }]
      };
    })
  },
  // Mission Owner repo wizard helpers + the mission-owner wizard (ensure your repowizard exports them)
  ...repoWizardTools(ghFactory as any),
];

console.log("[github-mcp] registering tools:", tools.map(t => t.name));
startMcpHttpServer({ name: "github-mcp", version: "0.1.0", port: PORT, tools });
