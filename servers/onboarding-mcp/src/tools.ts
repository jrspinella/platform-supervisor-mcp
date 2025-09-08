import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import Mustache from "mustache";

// ---------- Config ----------
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";
const PLAYBOOK_DIR =
  process.env.ONBOARDING_PLAYBOOK_DIR ||
  path.resolve(process.cwd(), "onboarding/playbooks");
const STATE_DIR =
  process.env.ONBOARDING_STATE_DIR ||
  path.resolve(process.cwd(), "onboarding/state");
const DEFAULT_REGION = process.env.DEFAULT_REGION || "usgovvirginia";
const DEFAULT_PLAYBOOK_ID =
  process.env.ONBOARDING_DEFAULT_PLAYBOOK_ID || "mission-owner";

// ---------- Small helpers ----------
const mcpJson = (json: any) => [{ type: "json" as const, json }];
const mcpText = (text: string) => [{ type: "text" as const, text }];

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
function statePath(runId: string) {
  return path.join(STATE_DIR, `${runId}.json`);
}
function firstJson(body: any) {
  const content = body?.result?.content;
  if (Array.isArray(content)) return content.find((c: any) => c.json)?.json;
  return null;
}
async function callRouterTool(name: string, args: any) {
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args || {} })
  });
  const text = await r.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { ok: r.ok, status: r.status, body };
}

// ---------- Playbooks ----------
type Task = {
  id: string;
  title: string;
  description?: string;
  kind?: "info" | "manual" | "tool";
  tool?: { name: string; args?: Record<string, any> };
};
type Playbook = {
  id: string;
  name: string;
  audience?: string;
  summary?: string;
  tasks: Task[];
};

function loadPlaybooks(): Playbook[] {
  if (!fs.existsSync(PLAYBOOK_DIR)) return [];
  return fs
    .readdirSync(PLAYBOOK_DIR)
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => {
      const doc = yaml.load(
        fs.readFileSync(path.join(PLAYBOOK_DIR, f), "utf8")
      ) as any;
      return {
        id: doc.id,
        name: doc.name,
        audience: doc.audience,
        summary: doc.summary,
        tasks: doc.tasks || []
      } as Playbook;
    });
}

function renderTask(task: Task, context: any): Task {
  const t = JSON.parse(JSON.stringify(task));
  t.title = Mustache.render(t.title || "", context);
  if (t.description) t.description = Mustache.render(t.description, context);
  if (t.tool?.args) {
    const rendered: Record<string, any> = {};
    for (const [k, v] of Object.entries(t.tool.args)) {
      rendered[k] = typeof v === "string" ? Mustache.render(v as string, context) : v;
    }
    t.tool.args = rendered;
  }
  return t;
}

function summarizePlaybook(pb: Playbook, ctx: any): string {
  const titles = (pb.tasks || [])
    .map((t) => renderTask(t, ctx)?.title)
    .filter((s) => typeof s === "string" && s.trim().length > 0) as string[];
  if (titles.length === 0) return "Initial setup tasks.";
  const top = titles.slice(0, 4).map((s) => s.replace(/\.$/, ""));
  const rest = titles.length - top.length;
  let core = top.join("; ");
  if (rest > 0) core += `; and ${rest} more step${rest === 1 ? "" : "s"}`;
  return `This will: ${core}.`;
}

function summarizeTasks(playbookName: string, tasks: Task[]) {
  const bullets = tasks.map((t) => `• ${t.title}${t.kind ? ` (${t.kind})` : ""}`).join("\n");
  return `Playbook: ${playbookName}\nTasks:\n${bullets || "— none —"}`;
}

// ---------- Schemas ----------
const userSchema = z
  .object({
    upn: z.string(),
    alias: z.string().optional(),
    displayName: z.string().optional()
  })
  .strict();

const getChecklistInput = z
  .object({
    playbookId: z.string().default(DEFAULT_PLAYBOOK_ID),
    user: userSchema,
    region: z.string().optional()
  })
  .strict();

const startRunInput = z
  .object({
    playbookId: z.string().default(DEFAULT_PLAYBOOK_ID),
    user: userSchema,
    region: z.string().optional()
  })
  .strict();

const completeTaskInput = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    note: z.string().optional()
  })
  .strict();

const executeTaskInput = z
  .object({
    runId: z.string(),
    taskId: z.string(),
    confirm: z.boolean().default(true),
    dryRun: z.boolean().default(false)
  })
  .strict();

const executeAllPendingInput = z
  .object({
    runId: z.string(),
    confirm: z.boolean().default(false),
    dryRun: z.boolean().default(true),
    kinds: z.array(z.enum(["tool", "manual", "info"])).optional()
  })
  .strict();

// ---------- Tools ----------
export const tools = [
  {
    name: "onboarding.ping",
    description: "Health check.",
    inputSchema: z.object({}).strict(),
    handler: async () => ({ content: mcpJson({ ok: true }) })
  },
  {
    name: "onboarding.debug_info",
    description: "Return config and visible playbook files.",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const files = fs.existsSync(PLAYBOOK_DIR)
        ? fs.readdirSync(PLAYBOOK_DIR).filter((f) => /\.ya?ml$/i.test(f))
        : [];
      return { content: mcpJson({ playbookDir: PLAYBOOK_DIR, stateDir: STATE_DIR, files }) };
    }
  },
  {
    name: "onboarding.validate_playbooks",
    description: "Validate all YAML playbooks and return parse results.",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const out: any[] = [];
      if (!fs.existsSync(PLAYBOOK_DIR)) {
        return { content: mcpJson({ ok: false, error: `Missing dir ${PLAYBOOK_DIR}` }) };
      }
      for (const f of fs.readdirSync(PLAYBOOK_DIR)) {
        if (!/\.ya?ml$/i.test(f)) continue;
        const fp = path.join(PLAYBOOK_DIR, f);
        const raw = fs.readFileSync(fp, "utf8");
        try {
          const doc = yaml.load(raw) as any;
          out.push({ file: fp, ok: true, id: doc?.id, name: doc?.name });
        } catch (e: any) {
          out.push({ file: fp, ok: false, error: String(e?.message || e) });
        }
      }
      return { content: mcpJson(out) };
    }
  },
  {
    name: "onboarding.list_playbooks",
    description: "List available playbooks (id and name).",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const pbs = loadPlaybooks().map((p) => ({ id: p.id, name: p.name, audience: p.audience }));
      return { content: mcpJson({ playbooks: pbs }) };
    }
  },
  {
    name: "onboarding.get_checklist",
    description: "Render a user's checklist for a playbook (no state persisted).",
    inputSchema: getChecklistInput,
    handler: async (a: z.infer<typeof getChecklistInput>) => {
      const pb = loadPlaybooks().find((p) => p.id === a.playbookId);
      if (!pb) throw new Error(`Playbook not found: ${a.playbookId}`);
      const ctx = { user: a.user, region: a.region || DEFAULT_REGION };
      const tasks = pb.tasks.map((t) => renderTask(t, ctx));
      const json = { playbook: { id: pb.id, name: pb.name, summary: pb.summary }, tasks };
      const text = summarizeTasks(pb.name, tasks);
      return { content: [...mcpJson(json), ...mcpText(text)] };
    }
  },
  {
    name: "onboarding.describe_playbook",
    description: "Return a short description and step list for a playbook.",
    inputSchema: z
      .object({
        playbookId: z.string().default(DEFAULT_PLAYBOOK_ID),
        user: userSchema.partial().default({}),
        region: z.string().optional()
      })
      .strict(),
    handler: async (a: any) => {
      const pb = loadPlaybooks().find((p) => p.id === a.playbookId);
      if (!pb) throw new Error(`Playbook not found: ${a.playbookId}`);
      const ctx = { user: a.user || {}, region: a.region || DEFAULT_REGION };
      const summary = pb.summary || summarizePlaybook(pb, ctx);
      const steps = pb.tasks.map((t) => {
        const r = renderTask(t, ctx);
        return { id: t.id, title: r.title, kind: t.kind || "tool" };
      });
      return { content: mcpJson({ playbook: { id: pb.id, name: pb.name }, summary, steps }) };
    }
  },
  {
    name: "onboarding.start_run",
    description: "Create a persistent onboarding run and return a runId.",
    inputSchema: startRunInput,
    handler: async (a: any) => {
      const pb = loadPlaybooks().find((p) => p.id === a.playbookId);
      if (!pb) throw new Error(`Playbook not found: ${a.playbookId}`);
      ensureDir(STATE_DIR);

      const ctx = { user: a.user, region: a.region || DEFAULT_REGION };
      const tasks = pb.tasks.map((t) => ({ ...renderTask(t, ctx), status: "pending" as const }));
      const summary = pb.summary || summarizePlaybook(pb, ctx);
      const runId = `${pb.id}:${a.user.upn}:${Date.now()}`;

      fs.writeFileSync(
        statePath(runId),
        JSON.stringify({ runId, playbookId: pb.id, user: a.user, region: ctx.region, summary, tasks }, null, 2),
        "utf8"
      );
      return { content: mcpJson({ runId, summary }) };
    }
  },
  {
    name: "onboarding.next_task",
    description: "Return the next pending task for a run.",
    inputSchema: z.object({ runId: z.string() }).strict(),
    handler: async ({ runId }: { runId: string }) => {
      const p = statePath(runId);
      if (!fs.existsSync(p)) throw new Error("Run not found");
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const next = (s.tasks || []).find((t: any) => t.status !== "done") || null;
      return { content: mcpJson({ next }) };
    }
  },
  {
    name: "onboarding.complete_task",
    description: "Mark a task complete in a run.",
    inputSchema: completeTaskInput,
    handler: async ({ runId, taskId, note }: { runId: string; taskId: string; note?: string }) => {
      const p = statePath(runId);
      if (!fs.existsSync(p)) throw new Error("Run not found");
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const t = (s.tasks || []).find((x: any) => x.id === taskId);
      if (!t) throw new Error("Task not found");
      t.status = "done";
      if (note) t.note = note;
      fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf8");
      return { content: mcpJson({ ok: true, taskId }) };
    }
  },
  {
    name: "onboarding.execute_task",
    description: "Execute a single tool-kind task in a run (no extra governance – delegated to each MCP).",
    inputSchema: executeTaskInput,
    handler: async (a: any) => {
      const p = statePath(a.runId);
      if (!fs.existsSync(p)) throw new Error("Run not found");
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const t = (s.tasks || []).find((x: any) => x.id === a.taskId);
      if (!t) throw new Error("Task not found");
      if (t.kind !== "tool" || !t.tool?.name) {
        return { content: mcpText(`Task ${t.id} is not a tool step; nothing to execute.`) };
      }

      const preview = `Plan: execute ${t.tool.name} ${JSON.stringify(t.tool.args || {})}`;
      if (a.dryRun || !a.confirm) {
        return {
          content: [
            ...mcpJson({ status: "pending", runId: a.runId, taskId: a.taskId, plan: { action: t.tool.name, payload: t.tool.args || {} } }),
            ...mcpText([preview, "", "Reply with:", `@onboarding execute task runId "${a.runId}" taskId "${a.taskId}" confirm true`].join("\n"))
          ]
        };
      }

      const r = await callRouterTool(t.tool.name, t.tool.args || {});
      if (!r.ok) {
        return {
          content: [
            ...mcpJson({ status: "error", runId: a.runId, taskId: a.taskId, error: r.body }),
            ...mcpText(`❌ Failed: ${t.tool.name}`)
          ],
          isError: true
        };
      }
      const j = firstJson(r.body) ?? r.body;
      t.status = "done";
      fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf8");

      return {
        content: [
          ...mcpJson({ status: "done", runId: a.runId, taskId: a.taskId, result: j }),
          ...mcpText(`✅ Executed ${t.tool.name}`)
        ]
      };
    }
  },
  {
    name: "onboarding.execute_all_pending",
    description: "Execute all pending tool-kind tasks in a run (governance occurs inside each MCP).",
    inputSchema: executeAllPendingInput,
    handler: async (a: any) => {
      const p = statePath(a.runId);
      if (!fs.existsSync(p)) throw new Error("Run not found");
      const s = JSON.parse(fs.readFileSync(p, "utf8"));

      const kinds = new Set((a.kinds || ["tool"]) as string[]);
      const pending: any[] = (s.tasks || []).filter((t: any) => t.status !== "done" && kinds.has(t.kind || "tool"));

      if (a.dryRun || !a.confirm) {
        const lines = [
          `Run: ${a.runId}`,
          `Mode: ${a.dryRun ? "DRY RUN" : "REVIEW"}`,
          "",
          "Plan:",
          ...pending.map((t) => `• ${t.title} — ${t.tool?.name || t.kind}`)
        ];
        return {
          content: [
            ...mcpJson({ status: "pending", runId: a.runId, count: pending.length, plan: pending.map((t) => ({ id: t.id, tool: t.tool?.name, args: t.tool?.args })) }),
            ...mcpText([...lines, "", "Reply with:", `@onboarding execute all runId "${a.runId}" confirm true dryRun false`].join("\n"))
          ]
        };
      }

      const results: any[] = [];
      for (const t of pending) {
        if (t.kind !== "tool" || !t.tool?.name) {
          results.push({ taskId: t.id, ok: false, error: "Not a tool step" });
          continue;
        }
        const r = await callRouterTool(t.tool.name, t.tool.args || {});
        const ok = !!r.ok;
        const j = firstJson(r.body) ?? r.body;
        results.push({ taskId: t.id, tool: t.tool.name, ok, result: j });
        if (ok) t.status = "done";
      }
      fs.writeFileSync(p, JSON.stringify(s, null, 2), "utf8");

      return {
        content: [
          ...mcpJson({ status: "done", runId: a.runId, executed: results.length, results }),
          ...mcpText(`✅ Executed ${results.filter((r) => r.ok).length}/${results.length} tasks.`)
        ]
      };
    }
  }
];
