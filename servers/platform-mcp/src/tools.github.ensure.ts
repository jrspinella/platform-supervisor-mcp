// servers/platform-mcp/src/tools.github.ensure.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { mcpJson, mcpText } from "./lib/runtime.js";

// tiny helper for the “hold/pending” plan text
function pendingPlanText(opts: { title: string; bullets: string[]; askProceed?: boolean }) {
  const lines = [
    `### Plan`,
    `- **Action:** ${opts.title}`,
    ...opts.bullets.map((b) => `- ${b}`),
    "",
    opts.askProceed === false ? "" : "Proceed? (y/N)"
  ].filter(Boolean);
  return lines.join("\n");
}

function makeLocalWrapper<T extends z.ZodObject<any>>(opts: {
  name: string;
  description: string;
  toolName: string;            // underlying github.* tool
  schema: T;
  toArgs: (a: z.infer<T>) => any;
  bullets: (a: z.infer<T>) => string[];
  verify?: {
    tool: string;              // e.g., github.get_repo
    toArgs: (src: z.infer<T>) => any;
    ok: (verifyJson: any, src: z.infer<T>) => boolean;
    failText?: (src: z.infer<T>) => string;
  };
  call: (name: string, args: any) => Promise<any>; // injected local caller
}): ToolDef {
  const full = opts.schema.extend({
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(false)
  }).passthrough();

  return {
    name: opts.name,
    description: opts.description,
    inputSchema: full,
    handler: async (raw: any) => {
      const a = await full.parseAsync(raw);
      const args = opts.toArgs(a);
      const mode = a.dryRun ? "dryRun" : (a.confirm ? "execute" : "review");

      // Hold/pending
      if (!a.confirm || a.dryRun) {
        return {
          content: [
            ...mcpJson({ status: "pending", plan: { action: opts.toolName, payload: args, mode } }),
            ...mcpText(pendingPlanText({ title: opts.toolName, bullets: opts.bullets(a), askProceed: true }))
          ]
        };
      }

      // Execute locally (no router)
      const exec = await opts.call(opts.toolName, args);
      const body = Array.isArray(exec?.content) ? exec : { content: [{ type: "json", json: exec }] };

      // Optional verify
      if (opts.verify) {
        const vr = await opts.call(opts.verify.tool, opts.verify.toArgs(a));
        const vjson = vr?.content?.find((c: any) => c.type === "json")?.json ?? vr;
        const pass = opts.verify.ok(vjson, a);
        if (!pass) {
          return {
            content: [
              ...mcpJson({ status: "error", verifyFailed: vjson }),
              ...mcpText(opts.verify.failText?.(a) || `❌ Verification did not pass`)
            ],
            isError: true
          };
        }
      }

      return {
        content: [
          ...mcpJson({ status: "done", result: body?.content?.[0]?.json ?? null }),
          ...mcpText(`✅ ${opts.name} — done.`)
        ]
      };
    }
  };
}

/** Build GitHub “ensure” wrappers that call github-core locally */
export function makeGitHubEnsureTools(call: (name: string, args: any) => Promise<any>): ToolDef[] {
  return [
    // Create repo (org)
    makeLocalWrapper({
      name: "platform.github.create_repo_for_org",
      description: "Create a repository in an organization (hold/pending + confirm).",
      toolName: "github.create_repo_for_org",
      schema: z.object({
        org: z.string(),
        name: z.string(),
        private: z.boolean().optional().default(true),
        description: z.string().optional()
      }),
      toArgs: (a) => ({ org: a.org, name: a.name, private: a.private, description: a.description }),
      bullets: (a) => [
        `**Org:** ${a.org}`,
        `**Repo:** ${a.name}`,
        `**Private:** ${a.private ? "true" : "false"}${a.description ? `, **Desc:** ${a.description}` : ""}`
      ],
      verify: {
        tool: "github.get_repo",
        toArgs: (a) => ({ owner: a.org, repo: a.name }),
        ok: (vj, a) => !!vj?.name && vj.name.toLowerCase() === a.name.toLowerCase()
      },
      call
    }),

    // Create issue
    makeLocalWrapper({
      name: "platform.github.create_issue",
      description: "Create an issue (hold/pending + confirm).",
      toolName: "github.create_issue",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        title: z.string(),
        body: z.string().optional(),
        assignees: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional()
      }),
      toArgs: (a) => ({
        owner: a.owner, repo: a.repo, title: a.title,
        body: a.body, assignees: a.assignees, labels: a.labels
      }),
      bullets: (a) => [
        `**Repo:** ${a.owner}/${a.repo}`,
        `**Title:** ${a.title}${a.labels?.length ? `, **Labels:** ${a.labels.join(", ")}` : ""}`
      ],
      call
    }),

    // Put repo secret
    makeLocalWrapper({
      name: "platform.github.put_repo_secret",
      description: "Create/update a repo Actions secret (hold/pending + confirm).",
      toolName: "github.put_repo_secret",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        name: z.string(),
        value: z.string()
      }),
      toArgs: (a) => ({ owner: a.owner, repo: a.repo, name: a.name, value: a.value }),
      bullets: (a) => [
        `**Repo:** ${a.owner}/${a.repo}`,
        `**Secret:** ${a.name}`
      ],
      call
    }),

    // Protect branch
    makeLocalWrapper({
      name: "platform.github.protect_branch",
      description: "Protect a branch (hold/pending + confirm).",
      toolName: "github.protect_branch",
      schema: z.object({
        owner: z.string(),
        repo: z.string(),
        branch: z.string(),
        enforceAdmins: z.boolean().optional().default(true),
        requireLinearHistory: z.boolean().optional().default(true),
        allowForcePushes: z.boolean().optional().default(false),
        allowDeletions: z.boolean().optional().default(false),
        requiredApprovingReviewCount: z.number().int().min(0).max(6).optional().default(1),
        dismissStaleReviews: z.boolean().optional().default(true),
        requireCodeOwnerReviews: z.boolean().optional().default(false),
        requireStatusChecks: z.boolean().optional().default(false),
        statusCheckContexts: z.array(z.string()).optional()
      }),
      toArgs: (a) => ({ ...a }),
      bullets: (a) => [
        `**Repo:** ${a.owner}/${a.repo}`,
        `**Branch:** ${a.branch}`,
        `**Admins:** ${a.enforceAdmins ? "enforced" : "not enforced"}, **Reviews:** ${a.requiredApprovingReviewCount}`
      ],
      call
    })
  ];
}