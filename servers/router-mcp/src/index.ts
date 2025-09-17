// servers/router-mcp/src/index.ts — router that always delegates to planWithPlanner,
// but returns scan steps directly
import express from "express";
import "dotenv/config";
import { planWithPlanner } from "./planner.js";

const app = express();
app.use(express.json({ limit: "1mb" }));

const basePort = Number(process.env.PORT || 8701);

/* ───────────────────────── Tag phrase + gov ctx helpers ───────────────────── */

function extractTagPhrase(instruction: string): string | undefined {
  const i = instruction.toLowerCase().indexOf("tags");
  if (i < 0) return undefined;
  const after = instruction.slice(i + 4);
  const endThen = after.toLowerCase().indexOf(" then ");
  const slice = endThen >= 0 ? after.slice(0, endThen) : after;
  const blob = slice.replace(/^[:=\s,]+/, "").trim();
  return blob || undefined;
}

function addGovCtx<R extends { tool: string; args: any; rationale?: string }>(
  res: R,
  originalInstruction: string
): R {
  if (!res?.args) return res;

  const tagString = extractTagPhrase(originalInstruction);

  res.args = {
    ...res.args,
    ...(tagString && !res.args.tags ? { tagString } : {}), // opportunistic tags
    context: { ...(res.args.context || {}), text: originalInstruction },
  };

  if (Array.isArray(res.args.steps)) {
    res.args = {
      ...res.args,
      steps: res.args.steps.map((s: any) => ({
        ...s,
        args: {
          ...(s.args || {}),
          ...(tagString && !s.args?.tags ? { tagString } : {}),
          context: { ...(s.args?.context || {}), text: originalInstruction },
        },
      })),
    };
  }

  return res;
}

/* ─────────────────────────────── Route handler ────────────────────────────── */

export async function route(instruction: string) {
  const original = (instruction || "").trim();
  if (!original) {
    return {
      tool: "platform.policy_dump",
      args: {},
      rationale: "fallback: empty instruction; showing merged policy",
    };
  }

  // Ask the planner for a plan
  const plan = await planWithPlanner(original);

  // If ALL steps are scans → return the first scan step directly
  const allScan = (plan.steps || []).length > 0 &&
    plan.steps.every(s => typeof s.tool === "string" && s.tool.startsWith("platform.scan_"));

  if (allScan) {
    const s0 = plan.steps[0];
    return addGovCtx(
      {
        tool: s0.tool,
        args: s0.args,
        rationale: "ATO scan detected",
      },
      original
    );
  }

  // If ALL steps are mission.* → mission.apply_plan / mission.preview_plan
  const allMission = (plan.steps || []).length > 0 &&
    plan.steps.every(s => typeof s.tool === "string" && s.tool.startsWith("mission."));

  const tool = allMission
    ? (plan.apply ? "mission.apply_plan" : "mission.preview_plan")
    : (plan.apply ? "platform.apply_plan" : "platform.preview_plan");

  // Return a single “execute plan” call (create/plan)
  return addGovCtx(
    {
      tool,
      args: { ...plan, render: "full" },
      rationale: "planner-driven execution",
    },
    original
  );
}

/* ───────────────────────────── JSON-RPC surface ───────────────────────────── */

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

app.post("/rpc", async (req, res) => {
  const { method, params, id } = req.body ?? {};
  if (method === "health") return res.json({ jsonrpc: "2.0", id, result: "ok" });

  if (method === "nl.route" || method === "nl/route") {
    const instruction: string = params?.instruction ?? "";
    try {
      const result = await route(instruction);
      return res.json({ jsonrpc: "2.0", id, result });
    } catch (e: any) {
      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: e?.message || "routing failed" },
      });
    }
  }

  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

/* ───────────────────── Single listener with port fallback ─────────────────── */

function listen(port: number, attemptsLeft = 15) {
  const server = app.listen(port, () => {
    console.log(`[router-mcp] listening on http://127.0.0.1:${port}/rpc`);
  });
  server.on("error", (err: any) => {
    if (err?.code === "EADDRINUSE" && attemptsLeft > 0) {
      const next = port + 1;
      console.warn(`[router-mcp] port ${port} in use; trying ${next}…`);
      setTimeout(() => listen(next, attemptsLeft - 1), 100);
    } else {
      throw err;
    }
  });
}
listen(basePort);
