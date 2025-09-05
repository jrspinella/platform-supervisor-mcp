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
type Playbook = { id: string; name: string; audience?: string; tasks: Task[] };


function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); }


function loadPlaybooks(): Playbook[] {
    if (!fs.existsSync(PLAYBOOK_DIR)) return [];
    return fs.readdirSync(PLAYBOOK_DIR)
        .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
        .map(f => {
            const doc = yaml.load(fs.readFileSync(path.join(PLAYBOOK_DIR, f), "utf8")) as any;
            return { id: doc.id, name: doc.name, audience: doc.audience, tasks: doc.tasks || [] } as Playbook;
        });
}

// near the top
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

    // (update) get_checklist – playbookId + region are optional
    {
        name: "onboarding.get_checklist",
        description: "Render a user's checklist (no state).",
        inputSchema: checklistInputSchema,
        handler: async (args: ChecklistInput) => {
            const playbookId = pickPlaybookId(args.playbookId);
            const pb = loadPlaybooks().find(p => p.id === playbookId);
            if (!pb) throw new Error(`Playbook not found: ${playbookId}`);

            // Prefer user.region, then top-level region, then default
            const region = args.user.region ?? args.region ?? DEFAULT_REGION;

            const ctx = { user: args.user, region };
            const tasks = pb.tasks.map(t => renderTask(t, ctx));
            return {
                content: [
                    { type: "json" as const, json: { playbook: { id: pb.id, name: pb.name }, tasks } }
                ]
            };
        }
    },

    // (update) start_run – playbookId + region optional
    {
        name: "onboarding.start_run",
        description: "Create a persistent onboarding run and return a runId.",
        inputSchema: startRunInputSchema,
        handler: async (args: StartRunInput) => {
            const playbookId = pickPlaybookId(args.playbookId);
            const pb = loadPlaybooks().find(p => p.id === playbookId);
            if (!pb) throw new Error(`Playbook not found: ${playbookId}`);

            const region = args.user.region ?? args.region ?? DEFAULT_REGION;

            ensureDir(STATE_DIR);
            const runId = `${playbookId}:${args.user.upn}:${Date.now()}`;
            const ctx = { user: args.user, region };
            const tasks = pb.tasks.map(t => ({ ...renderTask(t, ctx), status: "pending" }));
            fs.writeFileSync(statePath(runId), JSON.stringify({ runId, playbookId, user: args.user, region, tasks }, null, 2), "utf8");
            return { content: [{ type: "json" as const, json: { runId } }] };
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
