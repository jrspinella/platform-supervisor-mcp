import { z } from "zod";
import type { ToolDef } from "mcp-http";

type McpContent = { type: "text"; text: string } | { type: "json"; json: any };
const StepSchema = z.object({ tool: z.string().min(1), args: z.record(z.any()).default({}) });
const PlanSchema = z.object({
  apply: z.boolean().default(true),
  profile: z.string().default("default"),
  steps: z.array(StepSchema).min(1).max(20),
}).strict();

const isText = (c: McpContent): c is any => c?.type === "text";
const asArr = <T>(x: T|T[]|undefined): T[] => Array.isArray(x) ? x : x ? [x] : [];

function header(i: number, tool: string, ok: boolean) {
  const icon = ok ? "✅" : "⛔️";
  return { type: "text", text: `\n\n### ${icon} Step ${i + 1}: \`${tool}\`` } as McpContent;
}
function renderError(res: any) {
  const e = res?.error || res;
  const code = e?.code || e?.type || "Error";
  const status = e?.statusCode ?? e?.status;
  const msg = e?.message || e?.error?.message || "Unknown error";
  const lines = [
    "**Error**",
    `- code: \`${code}\``,
    ...(status ? [`- status: **${status}**`] : []),
    "",
    `> ${msg}`
  ];
  return { type: "text", text: lines.join("\n") } as McpContent;
}

export function makePlanTools(resolveTool: (name: string) => ToolDef | undefined): ToolDef[] {
  const apply: ToolDef = {
    name: "mission.apply_plan",
    description: "Execute a sequence of mission.* steps; stops on first error.",
    inputSchema: PlanSchema,
    handler: async (plan) => {
      const progress: Array<{ step: number; tool: string; status: "ok" | "error" }> = [];
      const transcript: McpContent[] = [];

      for (let i = 0; i < plan.steps.length; i++) {
        const s = plan.steps[i];
        const tool = resolveTool(s.tool);
        if (!tool) {
          transcript.push(header(i, s.tool, false));
          transcript.push({ type: "text", text: `**Error**\n> Tool not found: \`${s.tool}\`` });
          progress.push({ step: i, tool: s.tool, status: "error" });
          return { content: [...transcript, { type: "json", json: { status: "stopped", progress } }], isError: true };
        }
        try {
          const res = await tool.handler(s.args || {});
          const ok = !res?.isError;
          transcript.push(header(i, s.tool, ok));
          transcript.push(...asArr(res?.content));
          progress.push({ step: i, tool: s.tool, status: ok ? "ok" : "error" });
          if (!ok) {
            return { content: [...transcript, { type: "json", json: { status: "stopped", progress } }], isError: true };
          }
        } catch (e: any) {
          transcript.push(header(i, s.tool, false), renderError(e));
          progress.push({ step: i, tool: s.tool, status: "error" });
          return { content: [...transcript, { type: "json", json: { status: "stopped", progress } }], isError: true };
        }
      }

      return { content: [...transcript, { type: "json", json: { status: "done", progress } }] };
    },
  };
  return [apply];
}