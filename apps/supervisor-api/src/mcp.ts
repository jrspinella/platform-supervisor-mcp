import "dotenv/config";
import fetch from "node-fetch";
import { z } from "zod";
import { startMcpHttpServer } from "mcp-http";

const PORT = Number(process.env.PORT ?? 8787);              // keep your 8787
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";

// --- helpers ---
async function routerCall(name: string, args: any) {
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args || {} }),
  });
  const text = await r.text();
  if (!r.ok) {
    return {
      content: [
        { type: "text" as const, text: `Router error ${r.status}` },
        { type: "text" as const, text: text.slice(0, 2_000) }
      ],
      isError: true as const
    };
  }
  // Pass through upstream JSON to the MCP client
  try {
    const json = JSON.parse(text);
    return { content: [{ type: "json" as const, json }] };
  } catch {
    return { content: [{ type: "text" as const, text: text }] };
  }
}

const tools = [
  // --- basic health ---
  {
    name: "supervisor.ping",
    description: "Health check for supervisor MCP.",
    inputSchema: z.object({}).strict(),
    handler: async () => ({ content: [{ type: "text" as const, text: "pong" }] })
  },

  // --- plan-only onboarding (safe for Copilot to call first) ---
  {
    name: "supervisor.onboarding_plan",
    description:
      "Plan Mission Owner onboarding (dry-run). Returns summary + checklist using onboarding MCP. Does NOT make changes.",
    inputSchema: z.object({
      upn: z.string().email(),
      alias: z.string(),
      region: z.string().default("usgovvirginia")
    }).strict(),
    handler: async ({ upn, alias, region }: { upn: string; alias: string; region: string }) => {
      // start_run (records a runId) — harmless
      const startRes = await routerCall("onboarding.start_run", {
        playbookId: "mission-owner",
        user: { upn, alias, displayName: alias },
      });

      // get_checklist (rendered with your user/region) — harmless
      const chkRes = await routerCall("onboarding.get_checklist", {
        playbookId: "mission-owner",
        user: { upn, alias, displayName: alias, region },
      });

      return {
        content: [
          { type: "text" as const, text: "Planned onboarding (dry-run). Review summary & tasks below." },
          ...(Array.isArray((startRes as any).content) ? (startRes as any).content : []),
          ...(Array.isArray((chkRes as any).content) ? (chkRes as any).content : []),
        ]
      };
    }
  },

  // --- record consent (for your supervisor’s consent gate) ---
  {
    name: "supervisor.onboarding_ack",
    description:
      "Record user acknowledgment for onboarding: 'yes' (execute), 'dry-run' (simulate), or 'no' (stop). This is non-destructive.",
    inputSchema: z.object({
      runId: z.string().optional(),
      mode: z.enum(["yes", "dry-run", "no"])
    }).strict(),
    handler: async ({ runId, mode }: { runId: string | undefined; mode: "yes" | "dry-run" | "no" }) => {
      // In a future iteration you can persist this locally by runId if you like.
      return { content: [{ type: "json" as const, json: { ok: true, runId: runId ?? null, consent: mode } }] };
    }
  },

  // --- generic pass-through so Copilot can hit any platform tool via supervisor ---
  {
    name: "supervisor.route_tool",
    description:
      "Call any platform tool via the Router, e.g. name='azure.create_resource_group' with appropriate arguments.",
    inputSchema: z.object({
      name: z.string().min(3),
      arguments: z.record(z.any()).default({})
    }).strict(),
    handler: async ({ name, arguments: args }: { name: string; arguments: Record<string, any> }) => {
      return routerCall(name, args);
    }
  }
];

startMcpHttpServer({ name: "supervisor-mcp", version: "0.1.0", port: PORT, tools });
console.log(`[MCP] supervisor-mcp listening on :${PORT} (POST /mcp) → Router ${ROUTER_URL}`);
