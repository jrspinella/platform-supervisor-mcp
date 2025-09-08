import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { callRouterTool, firstJson, mcpJson, mcpText } from "./lib/runtime.js";

// very small NL parser to pull out UPN/alias/region/dry run phrases
function parseOnboardingNL(text: string) {
  const upn = /(?:^|\b)(?:upn|user|email)\s*[:=]?\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/i.exec(text)?.[1]
    || /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(text)?.[1];
  const alias = /alias\s*[:=]?\s*([A-Za-z0-9._-]+)/i.exec(text)?.[1];
  const displayName = /name\s*[:=]?\s*"([^"]+)"|display\s*name\s*[:=]?\s*"([^"]+)"/i.exec(text)?.[1];
  const region = /region\s*[:=]?\s*([A-Za-z0-9-]+)/i.exec(text)?.[1];
  const dryRun = /\bdry\s*run\b|\bsimulate\b/i.test(text);
  return { upn, alias, displayName, region, dryRun };
}

export const toolsOnboarding: ToolDef[] = [
  {
    name: "platform.onboarding_execute_task",
    description: "Execute a single onboarding checklist (mission-owner) with NL input and confirm/dryRun safety.",
    inputSchema: z.object({
      request: z.string(),                 // free text
      playbookId: z.string().default("mission-owner"),
      confirm: z.boolean().default(false),
      dryRun: z.boolean().default(true),
      defaults: z.object({
        upn: z.string().optional(),
        alias: z.string().optional(),
        displayName: z.string().optional(),
        region: z.string().optional()
      }).partial().optional()
    }).strict(),
    handler: async (a) => {
      const parsed = parseOnboardingNL(a.request || "");
      const user = {
        upn: parsed.upn || a.defaults?.upn,
        alias: parsed.alias || a.defaults?.alias,
        displayName: parsed.displayName || a.defaults?.displayName
      };
      const region = parsed.region || a.defaults?.region || "usgovvirginia";
      const dryRun = a.dryRun ?? parsed.dryRun ?? true;

      if (!user.upn || !user.alias) {
        const hint = [
          "Missing required fields.",
          `Please include UPN and alias. Example:`,
          `“Onboard me as a mission owner. UPN jdoe@contoso.gov alias jdoe region usgovvirginia (dry run).”`
        ].join("\n");
        return { content: [...mcpText(hint)] };
      }

      // start run
      const start = await callRouterTool("onboarding.start_run", { playbookId: a.playbookId, user, region });
      const startJ = firstJson(start.body);
      const runId = startJ?.runId;
      if (!runId) {
        return { isError: true, content: [...mcpText(`Failed to start onboarding: ${JSON.stringify(start.body).slice(0, 800)}`)] };
      }

      // get checklist
      const cls = await callRouterTool("onboarding.get_checklist", { playbookId: a.playbookId, user, region });
      const clsJ = firstJson(cls.body);
      const tasks = clsJ?.tasks || [];
      const playbookName = clsJ?.playbook?.name || a.playbookId;

      const bullets = tasks.map((t: any) => `• ${t.title}${t.kind ? ` (${t.kind})` : ""}`).join("\n");
      const header = `Onboarding Plan for ${user.upn} (${user.alias}) — ${playbookName} @ ${region}`;
      const modeLine = dryRun ? "Mode: DRY RUN" : (a.confirm ? "Mode: EXECUTE" : "Mode: REVIEW");

      if (dryRun || !a.confirm) {
        const follow = `@platform onboarding_execute_task request "Proceed with mission-owner for ${user.upn} alias ${user.alias} region ${region}" confirm true dryRun false`;
        return {
          content: [
            ...mcpJson({ runId, tasks }),
            ...mcpText([header, modeLine, "", "Checklist:", bullets || "— none —", "", "To execute now, reply with:", follow].join("\n"))
          ]
        };
      }

      // execute tool-kind tasks
      const results: any[] = [];
      for (const t of tasks) {
        if (t.kind !== "tool" || !t.tool?.name) { results.push({ taskId: t.id, status: "skipped" }); continue; }
        const r = await callRouterTool(t.tool.name, t.tool.args || {});
        const ok = !!r.ok;
        const j = firstJson(r.body) ?? r.body;
        results.push({ taskId: t.id, tool: t.tool.name, ok, result: j });
        try { await callRouterTool("onboarding.complete_task", { runId, taskId: t.id, note: `Ran ${t.tool.name}` }); } catch {}
      }

      return { content: [...mcpJson({ runId, executed: true, results }), ...mcpText(`✅ Executed ${results.filter(x => x.tool).length} task(s).`)] };
    }
  }
];