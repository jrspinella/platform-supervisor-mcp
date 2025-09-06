import "dotenv/config";
import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import Mustache from "mustache";


const PORT = Number(process.env.PORT ?? 8714);
const PLAYBOOK_DIR = process.env.ONBOARDING_PLAYBOOK_DIR || path.resolve(process.cwd(), "onboarding/playbooks");
const STATE_DIR = process.env.ONBOARDING_STATE_DIR || path.resolve(process.cwd(), "onboarding/state");
const DEFAULT_REGION = process.env.DEFAULT_REGION || "usgovvirginia";
const DEFAULT_PLAYBOOK_ID = process.env.ONBOARDING_DEFAULT_PLAYBOOK_ID || "mission-owner";

// Reusable user schema
const userSchema = z.object({
    upn: z.string(),
    alias: z.string().optional(),
    displayName: z.string().optional(),
    region: z.string().optional(),   // <-- allow region in user
}).strict();

// Accept nested OR flat user args
const userNested = z.object({
    upn: z.string(),
    alias: z.string().optional(),
    displayName: z.string().optional(),
    region: z.string().optional(),
}).strict();

const checklistArgsUnion = z.union([
    z.object({
        playbookId: z.string(),
        user: userNested,
        region: z.string().optional(),
    }).strict(),
    z.object({
        playbookId: z.string(),
        upn: z.string(),
        alias: z.string().optional(),
        displayName: z.string().optional(),
        region: z.string().optional(),
    }).strict(),
]);

// get_checklist input
const checklistInputSchema = z.object({
    playbookId: z.string().optional(),
    user: userSchema,
    region: z.string().optional(),   // <-- optional top-level for compatibility
}).strict();

const startRunInputSchema = z.object({
    playbookId: z.string(),
    user: userSchema,
    region: z.string().optional(),   // optional top-level for compatibility
}).strict();

type Task = {
    id: string;
    title: string;
    description?: string;
    kind?: string; // info | manual | tool
    tool?: { name: string; args?: Record<string, any> };
};

type StartRunInput = z.infer<typeof startRunInputSchema>;
type ChecklistInput = z.infer<typeof checklistInputSchema>;
type ChecklistArgs = z.infer<typeof checklistArgsUnion>;
type Playbook = { id: string; name: string; audience?: string; summary?: string; tasks: Task[] };


function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }


function loadPlaybooks(): Playbook[] {
    if (!fs.existsSync(PLAYBOOK_DIR)) return [];
    return fs.readdirSync(PLAYBOOK_DIR)
        .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
        .map(f => {
            const doc = yaml.load(fs.readFileSync(path.join(PLAYBOOK_DIR, f), "utf8")) as any;
            return { id: doc.id, name: doc.name, audience: doc.audience, summary: doc.summary, tasks: doc.tasks || [] } as Playbook;
        });
}

function summarizePlaybook(pb: Playbook, context: any): string {
    // Use rendered task titles (so {{user.alias}} is resolved)
    const titles = (pb.tasks || [])
        .map(t => renderTask(t, context)?.title)
        .filter((s: any) => typeof s === "string" && s.trim().length > 0) as string[];

    if (titles.length === 0) return "This will guide you through initial setup tasks.";

    const top = titles.slice(0, 4).map(s => s.replace(/\.$/, ""));
    const rest = titles.length - top.length;

    let core = top.join("; ");
    if (rest > 0) core += `; and ${rest} more step${rest === 1 ? "" : "s"}`;

    return `This will: ${core}.`;
}

function normalizeChecklistArgs(a: ChecklistArgs) {
    const user = ('user' in a) ? a.user : {
        upn: a.upn,
        alias: a.alias,
        displayName: a.displayName,
        region: a.region,
    };
    const region = user.region || ('region' in a ? a.region : undefined) || DEFAULT_REGION;
    return { playbookId: a.playbookId, user, region };
}

function summarizeTasks(playbookName: string, tasks: any[]) {
    const bullets = tasks.map(t => `• ${t.title}${t.kind ? ` (${t.kind})` : ""}`).join("\n");
    return `Playbook: ${playbookName}\nTasks:\n${bullets || "— none —"}`;
}

function pickPlaybookId(explicitId?: string) {
    const books = loadPlaybooks();
    if (explicitId) return explicitId;
    const mo = books.find(p => p.id === DEFAULT_PLAYBOOK_ID);
    if (mo) return mo.id;
    if (books[0]) return books[0].id;
    throw new Error("No onboarding playbooks found in " + PLAYBOOK_DIR);
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

const runIdInputSchema = z.object({ runId: z.string() }).strict();
type RunIdInput = z.infer<typeof runIdInputSchema>;

function statePath(runId: string) { return path.join(STATE_DIR, `${runId}.json`); }

const tools = [
    // (new) health
    {
        name: "onboarding.ping",
        description: "Health check",
        inputSchema: z.object({}).strict(),
        handler: async (args: {}) => ({ content: [{ type: "json" as const, json: { ok: true } }] })
    },

    {
        name: "onboarding.debug_info",
        description: "Return MCP config (playbook dir, state dir) and file list.",
        inputSchema: z.object({}).strict(),
        handler: async () => {
            const files = fs.existsSync(PLAYBOOK_DIR)
                ? fs.readdirSync(PLAYBOOK_DIR).filter(f => /\.ya?ml$/i.test(f))
                : [];
            return { content: [{ type: "json" as const, json: { playbookDir: PLAYBOOK_DIR, stateDir: STATE_DIR, files } }] };
        }
    },
    {
        name: "onboarding.validate_playbooks",
        description: "Validate all YAML playbooks and return parse results (and a snippet around any error).",
        inputSchema: z.object({}).strict(),
        handler: async () => {
            const out: any[] = [];
            if (!fs.existsSync(PLAYBOOK_DIR)) {
                return { content: [{ type: "json" as const, json: { ok: false, error: `Missing dir ${PLAYBOOK_DIR}` } }] };
            }
            for (const f of fs.readdirSync(PLAYBOOK_DIR)) {
                if (!/\.ya?ml$/i.test(f)) continue;
                const fp = path.join(PLAYBOOK_DIR, f);
                const raw = fs.readFileSync(fp, "utf8");
                try {
                    const doc = yaml.load(raw) as any;
                    out.push({ file: fp, ok: true, id: doc?.id, name: doc?.name });
                } catch (e: any) {
                    // Extract a small context snippet around the reported line
                    const m = /at line (\d+), column (\d+)/i.exec(e.message || "");
                    const lines = raw.split(/\r?\n/);
                    let ctx: string[] = [];
                    if (m) {
                        const ln = Math.max(1, parseInt(m[1], 10));
                        const start = Math.max(1, ln - 5);
                        const end = Math.min(lines.length, ln + 5);
                        for (let i = start; i <= end; i++) ctx.push(`${String(i).padStart(4)} | ${lines[i - 1]}`);
                    }
                    out.push({ file: fp, ok: false, error: e.message, context: ctx });
                }
            }
            return { content: [{ type: "json" as const, json: out }] };
        }
    },

    // (update) get_checklist – playbookId + region are optional
    {
        name: "onboarding.get_checklist",
        description: "Render a user's checklist for a playbook (no state persisted).",
        inputSchema: z.object({
            playbookId: z.string(),
            user: z.object({ upn: z.string(), alias: z.string().optional(), displayName: z.string().optional() }).strict(),
            region: z.string().optional()
        }),
        handler: async (args: any) => {
            const pb = loadPlaybooks().find(p => p.id === args.playbookId);
            if (!pb) throw new Error(`Playbook not found: ${args.playbookId}`);

            const ctx = { user, region };
            const tasks = pb.tasks.map(t => renderTask(t, ctx));
            const json = { playbook: { id: pb.id, name: pb.name, summary: pb.summary }, tasks };
            const text = summarizeTasks(pb.name, tasks);

            return {
                content: [
                    { type: "json" as const, json },
                    { type: "text" as const, text }
                ]
            };
        }
    },

    // (update) start_run – playbookId + region optional
    {
        name: "onboarding.start_run",
        description: "Create a persistent onboarding run and return a runId.",
        inputSchema: z.object({
            playbookId: z.string(),
            user: z.object({ upn: z.string(), alias: z.string().optional(), displayName: z.string().optional() }).strict(),
            region: z.string().optional()
        }),
        handler: async (args: StartRunInput) => {
            const pb = loadPlaybooks().find(p => p.id === args.playbookId);
            if (!pb) throw new Error(`Playbook not found: ${args.playbookId}`);

            ensureDir(STATE_DIR);
            const runId = `${pb.id}:${args.user.upn}:${Date.now()}`;
            const ctx = { user: args.user, region: args.region || process.env.DEFAULT_REGION || "usgovvirginia" };
            const tasks = pb.tasks.map(t => ({ ...renderTask(t, ctx), status: "pending" }));
            const summary = pb.summary || summarizePlaybook(pb, ctx);

            fs.writeFileSync(statePath(runId), JSON.stringify({ runId, playbookId: pb.id, user: args.user, summary, tasks }, null, 2), "utf8");
            return { content: [{ type: "json" as const, json: { runId, summary } }] };
        }
    },

    {
        name: "onboarding.describe_playbook",
        description: "Return a short description (summary) and step list for a playbook.",
        inputSchema: z.object({
            playbookId: z.string(),
            user: z.object({ upn: z.string(), alias: z.string().optional(), displayName: z.string().optional() }).partial().default({}),
            region: z.string().optional()
        }),
        handler: async (args: any) => {
            const pb = loadPlaybooks().find(p => p.id === args.playbookId);
            if (!pb) throw new Error(`Playbook not found: ${args.playbookId}`);
            const ctx = { user: args.user || {}, region: args.region || process.env.DEFAULT_REGION || "usgovvirginia" };
            const summary = pb.summary || summarizePlaybook(pb, ctx);
            const steps = pb.tasks.map(t => ({ id: t.id, title: renderTask(t, ctx).title, kind: t.kind || "tool" }));
            return { content: [{ type: "json" as const, json: { playbook: { id: pb.id, name: pb.name }, summary, steps } }] };
        }
    },

    // (optional) what's next helper
    {
        name: "onboarding.next_task",
        description: "Return the next pending task for a run.",
        inputSchema: runIdInputSchema,
        handler: async (args: RunIdInput) => {
            const { runId } = args;
            const p = statePath(runId);
            if (!fs.existsSync(p)) throw new Error("Run not found");
            const s = JSON.parse(fs.readFileSync(p, "utf8"));
            const next = (s.tasks || []).find((t: any) => t.status !== "done") || null;
            return { content: [{ type: "json" as const, json: { next } }] };
        }
    }
];


console.log(`[MCP] onboarding-mcp listening on :${PORT} | playbooks=${PLAYBOOK_DIR} | state=${STATE_DIR}`);
startMcpHttpServer({ name: "onboarding-mcp", version: "0.1.0", port: PORT, tools });
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import Mustache from "mustache";


const PORT = Number(process.env.PORT ?? 8714);
const PLAYBOOK_DIR = process.env.ONBOARDING_PLAYBOOK_DIR || path.resolve(process.cwd(), "onboarding/playbooks");
const STATE_DIR = process.env.ONBOARDING_STATE_DIR || path.resolve(process.cwd(), "onboarding/state");
const DEFAULT_REGION = process.env.DEFAULT_REGION || "usgovvirginia";
const DEFAULT_PLAYBOOK_ID = process.env.ONBOARDING_DEFAULT_PLAYBOOK_ID || "mission-owner";

// Reusable user schema
const userSchema = z.object({
    upn: z.string(),
    alias: z.string().optional(),
    displayName: z.string().optional(),
    region: z.string().optional(),   // <-- allow region in user
}).strict();

// Accept nested OR flat user args
const userNested = z.object({
    upn: z.string(),
    alias: z.string().optional(),
    displayName: z.string().optional(),
    region: z.string().optional(),
}).strict();

const checklistArgsUnion = z.union([
    z.object({
        playbookId: z.string(),
        user: userNested,
        region: z.string().optional(),
    }).strict(),
    z.object({
        playbookId: z.string(),
        upn: z.string(),
        alias: z.string().optional(),
        displayName: z.string().optional(),
        region: z.string().optional(),
    }).strict(),
]);

// get_checklist input
const checklistInputSchema = z.object({
    playbookId: z.string().optional(),
    user: userSchema,
    region: z.string().optional(),   // <-- optional top-level for compatibility
}).strict();

const startRunInputSchema = z.object({
    playbookId: z.string(),
    user: userSchema,
    region: z.string().optional(),   // optional top-level for compatibility
}).strict();

type Task = {
    id: string;
    title: string;
    description?: string;
    kind?: string; // info | manual | tool
    tool?: { name: string; args?: Record<string, any> };
};

type StartRunInput = z.infer<typeof startRunInputSchema>;
type ChecklistInput = z.infer<typeof checklistInputSchema>;
type ChecklistArgs = z.infer<typeof checklistArgsUnion>;
type Playbook = { id: string; name: string; audience?: string; summary?: string; tasks: Task[] };


function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }


function loadPlaybooks(): Playbook[] {
    if (!fs.existsSync(PLAYBOOK_DIR)) return [];
    return fs.readdirSync(PLAYBOOK_DIR)
        .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
        .map(f => {
            const doc = yaml.load(fs.readFileSync(path.join(PLAYBOOK_DIR, f), "utf8")) as any;
            return { id: doc.id, name: doc.name, audience: doc.audience, summary: doc.summary, tasks: doc.tasks || [] } as Playbook;
        });
}

function summarizePlaybook(pb: Playbook, context: any): string {
    // Use rendered task titles (so {{user.alias}} is resolved)
    const titles = (pb.tasks || [])
        .map(t => renderTask(t, context)?.title)
        .filter((s: any) => typeof s === "string" && s.trim().length > 0) as string[];

    if (titles.length === 0) return "This will guide you through initial setup tasks.";

    const top = titles.slice(0, 4).map(s => s.replace(/\.$/, ""));
    const rest = titles.length - top.length;

    let core = top.join("; ");
    if (rest > 0) core += `; and ${rest} more step${rest === 1 ? "" : "s"}`;

    return `This will: ${core}.`;
}

function normalizeChecklistArgs(a: ChecklistArgs) {
    const user = ('user' in a) ? a.user : {
        upn: a.upn,
        alias: a.alias,
        displayName: a.displayName,
        region: a.region,
    };
    const region = user.region || ('region' in a ? a.region : undefined) || DEFAULT_REGION;
    return { playbookId: a.playbookId, user, region };
}

function summarizeTasks(playbookName: string, tasks: any[]) {
    const bullets = tasks.map(t => `• ${t.title}${t.kind ? ` (${t.kind})` : ""}`).join("\n");
    return `Playbook: ${playbookName}\nTasks:\n${bullets || "— none —"}`;
}

function pickPlaybookId(explicitId?: string) {
    const books = loadPlaybooks();
    if (explicitId) return explicitId;
    const mo = books.find(p => p.id === DEFAULT_PLAYBOOK_ID);
    if (mo) return mo.id;
    if (books[0]) return books[0].id;
    throw new Error("No onboarding playbooks found in " + PLAYBOOK_DIR);
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

const runIdInputSchema = z.object({ runId: z.string() }).strict();
type RunIdInput = z.infer<typeof runIdInputSchema>;

function statePath(runId: string) { return path.join(STATE_DIR, `${runId}.json`); }

const tools = [
    // (new) health
    {
        name: "onboarding.ping",
        description: "Health check",
        inputSchema: z.object({}).strict(),
        handler: async (args: {}) => ({ content: [{ type: "json" as const, json: { ok: true } }] })
    },

    {
        name: "onboarding.debug_info",
        description: "Return MCP config (playbook dir, state dir) and file list.",
        inputSchema: z.object({}).strict(),
        handler: async () => {
            const files = fs.existsSync(PLAYBOOK_DIR)
                ? fs.readdirSync(PLAYBOOK_DIR).filter(f => /\.ya?ml$/i.test(f))
                : [];
            return { content: [{ type: "json" as const, json: { playbookDir: PLAYBOOK_DIR, stateDir: STATE_DIR, files } }] };
        }
    },
    {
        name: "onboarding.validate_playbooks",
        description: "Validate all YAML playbooks and return parse results (and a snippet around any error).",
        inputSchema: z.object({}).strict(),
        handler: async () => {
            const out: any[] = [];
            if (!fs.existsSync(PLAYBOOK_DIR)) {
                return { content: [{ type: "json" as const, json: { ok: false, error: `Missing dir ${PLAYBOOK_DIR}` } }] };
            }
            for (const f of fs.readdirSync(PLAYBOOK_DIR)) {
                if (!/\.ya?ml$/i.test(f)) continue;
                const fp = path.join(PLAYBOOK_DIR, f);
                const raw = fs.readFileSync(fp, "utf8");
                try {
                    const doc = yaml.load(raw) as any;
                    out.push({ file: fp, ok: true, id: doc?.id, name: doc?.name });
                } catch (e: any) {
                    // Extract a small context snippet around the reported line
                    const m = /at line (\d+), column (\d+)/i.exec(e.message || "");
                    const lines = raw.split(/\r?\n/);
                    let ctx: string[] = [];
                    if (m) {
                        const ln = Math.max(1, parseInt(m[1], 10));
                        const start = Math.max(1, ln - 5);
                        const end = Math.min(lines.length, ln + 5);
                        for (let i = start; i <= end; i++) ctx.push(`${String(i).padStart(4)} | ${lines[i - 1]}`);
                    }
                    out.push({ file: fp, ok: false, error: e.message, context: ctx });
                }
            }
            return { content: [{ type: "json" as const, json: out }] };
        }
    },

    // (update) get_checklist – playbookId + region are optional
    {
        name: "onboarding.get_checklist",
        description: "Render a user's checklist for a playbook (no state persisted).",
        // Accept nested or flat args
        inputSchema: checklistArgsUnion,
        handler: async (raw: ChecklistArgs) => {
            const { playbookId, user, region } = normalizeChecklistArgs(raw);
            const id = pickPlaybookId(playbookId);
            const pb = loadPlaybooks().find(p => p.id === id);
            if (!pb) throw new Error(`Playbook not found: ${id}`);

            const ctx = { user, region };
            const tasks = pb.tasks.map(t => renderTask(t, ctx));
            const json = { playbook: { id: pb.id, name: pb.name, summary: pb.summary }, tasks };
            const text = summarizeTasks(pb.name, tasks);

            return {
                content: [
                    { type: "json" as const, json },
                    { type: "text" as const, text }
                ]
            };
        }
    },

    // (update) start_run – playbookId + region optional
    {
        name: "onboarding.start_run",
        description: "Create a persistent onboarding run and return a runId and summary.",
        // Accept nested or flat args
        inputSchema: checklistArgsUnion,
        handler: async (raw: ChecklistArgs) => {
            const { playbookId, user, region } = normalizeChecklistArgs(raw);
            const id = pickPlaybookId(playbookId);
            const pb = loadPlaybooks().find(p => p.id === id);
            if (!pb) throw new Error(`Playbook not found: ${id}`);

            ensureDir(STATE_DIR);
            const runId = `${pb.id}:${user.upn}:${Date.now()}`;
            const ctx = { user, region };
            const tasks = pb.tasks.map(t => ({ ...renderTask(t, ctx), status: "pending" }));
            const summary = pb.summary || summarizePlaybook(pb, ctx);

            fs.writeFileSync(
                statePath(runId),
                JSON.stringify({ runId, playbookId: pb.id, user, summary, tasks }, null, 2),
                "utf8"
            );

            return {
                content: [
                    { type: "json" as const, json: { runId, summary } },
                    { type: "text" as const, text: summary }
                ]
            };
        }
    },

    {
        name: "onboarding.describe_playbook",
        description: "Return a short description (summary) and step list for a playbook.",
        inputSchema: z.union([
            z.object({
                playbookId: z.string().optional(),
                user: userSchema.partial().default({}),
                region: z.string().optional()
            }).strict(),
            z.object({
                playbookId: z.string().optional(),
                upn: z.string().optional(),
                alias: z.string().optional(),
                displayName: z.string().optional(),
                region: z.string().optional()
            }).strict()
        ]),
        handler: async (raw: any) => {
            // normalize to { playbookId?, user, region }
            const tmp = ('user' in raw)
                ? { playbookId: raw.playbookId, user: raw.user || {}, region: raw.region }
                : {
                    playbookId: raw.playbookId,
                    user: { upn: raw.upn, alias: raw.alias, displayName: raw.displayName, region: raw.region },
                    region: raw.region
                };

            const id = pickPlaybookId(tmp.playbookId);
            const pb = loadPlaybooks().find(p => p.id === id);
            if (!pb) throw new Error(`Playbook not found: ${id}`);

            const region = tmp.user?.region || tmp.region || DEFAULT_REGION;
            const ctx = { user: tmp.user || {}, region };
            const summary = pb.summary || summarizePlaybook(pb, ctx);
            const steps = pb.tasks.map(t => {
                const rt = renderTask(t, ctx);
                return { id: t.id, title: rt.title, kind: t.kind || "tool" };
            });

            return { content: [{ type: "json" as const, json: { playbook: { id: pb.id, name: pb.name }, summary, steps } }] };
        }
    },

    // (optional) what's next helper
    {
        name: "onboarding.next_task",
        description: "Return the next pending task for a run.",
        inputSchema: runIdInputSchema,
        handler: async (args: RunIdInput) => {
            const { runId } = args;
            const p = statePath(runId);
            if (!fs.existsSync(p)) throw new Error("Run not found");
            const s = JSON.parse(fs.readFileSync(p, "utf8"));
            const next = (s.tasks || []).find((t: any) => t.status !== "done") || null;
            return { content: [{ type: "json" as const, json: { next } }] };
        }
    }
];


console.log(`[MCP] onboarding-mcp listening on :${PORT} | playbooks=${PLAYBOOK_DIR} | state=${STATE_DIR}`);
startMcpHttpServer({ name: "onboarding-mcp", version: "0.1.0", port: PORT, tools });
