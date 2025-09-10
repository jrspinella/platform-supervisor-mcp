import path from "node:path";
import { z } from "zod";
import { loadTemplatesFromDir } from "./loader.js";
import { resolveInputs, compileTemplateToPlan } from "./plan.js";
import type { MakeOnboardingToolsOptions, ToolDef, McpContent, Plan } from "./types.js";

/** small helpers */
const j = (json: any): McpContent[] => [{ type: "json", json }];
const t = (text: string): McpContent[] => [{ type: "text", text }];

function summarizePlan(plan: Plan) {
  const lines = [
    `### Plan`,
    `- **Summary:** ${plan.summary}`,
    ...plan.steps.map(s => `- **${s.title}** → \`${s.tool}\``)
  ];
  return lines.join("\n");
}

export function makeOnboardingTools(opts: MakeOnboardingToolsOptions): ToolDef[] {
  const NS = (opts.namespace ?? "onboarding.").replace(/\.$/, ".");
  const templatesDir = opts.templatesDir || process.env.ONBOARDING_PLAYBOOK_DIR || path.resolve(process.cwd(), "templates");

  // cache templates in memory; refresh on each call for dev convenience
  async function loadAll() {
    return loadTemplatesFromDir(templatesDir);
  }

  // -------- list_templates --------
  const listTemplates: ToolDef = {
    name: `${NS}list_templates`,
    description: `List available onboarding templates from ${templatesDir}`,
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const all = await loadAll();
      return { content: j(all.map(a => ({ id: a.id, name: a.def.name, version: a.def.version, file: a.file }))) };
    }
  };

  // -------- get_template --------
  const getTemplate: ToolDef = {
    name: `${NS}get_template`,
    description: "Get a template YAML by id.",
    inputSchema: z.object({ id: z.string() }).strict(),
    handler: async (a) => {
      const all = await loadAll();
      const found = all.find(x => x.id === a.id);
      if (!found) return { content: t(`Template not found: ${a.id}`), isError: true };
      return { content: j({ id: found.id, name: found.def.name, version: found.def.version, yaml: found.yaml, file: found.file }) };
    }
  };

  // -------- plan_from_template --------
  const planFromTemplate: ToolDef = {
    name: `${NS}plan_from_template`,
    description: "Compile a template (by id) and inputs into an execution plan with governance preview.",
    inputSchema: z.object({
      id: z.string(),
      inputs: z.record(z.any()).default({}),
      continueOnError: z.boolean().default(false)
    }).strict(),
    handler: async (a) => {
      const all = await loadAll();
      const tpl = all.find(x => x.id === a.id);
      if (!tpl) return { content: t(`Template not found: ${a.id}`), isError: true };

      let resolved: Record<string, any>;
      try {
        resolved = resolveInputs(tpl.def, a.inputs || {});
      } catch (e: any) {
        return { content: t(`Input validation failed: ${e?.message || e}`), isError: true };
      }

      const plan = compileTemplateToPlan(tpl.def, resolved);
      plan.continueOnError = !!a.continueOnError;

      // Governance preview
      const preview: Array<{ id: string; decision: string; reasons?: string[] }> = [];
      for (const s of plan.steps) {
        try {
          const g = await opts.evaluateGovernance(s.tool, s.args);
          preview.push({ id: s.id, decision: g.decision, reasons: g.reasons });
        } catch {
          preview.push({ id: s.id, decision: "allow" });
        }
      }

      const holdLines = [
        summarizePlan(plan),
        "",
        "Proceed? (y/N)"
      ].join("\n");

      return {
        content: [
          ...j({ status: "pending", plan, governancePreview: preview }),
          ...t(holdLines)
        ]
      };
    }
  };

  // -------- run_plan --------
  const runPlan: ToolDef = {
    name: `${NS}run_plan`,
    description: "Execute a compiled plan. Respects governance. Supports dryRun and confirm gating.",
    inputSchema: z.object({
      plan: z.object({
        summary: z.string(),
        continueOnError: z.boolean().optional(),
        steps: z.array(z.object({
          id: z.string(),
          title: z.string(),
          tool: z.string(),
          args: z.any()
        }))
      }),
      confirm: z.boolean().default(false),
      dryRun: z.boolean().default(false),
      context: z.object({
        upn: z.string().optional(),
        alias: z.string().optional(),
        region: z.string().optional()
      }).partial().optional()
    }).strict(),
    handler: async (a) => {
      const plan = a.plan as Plan;

      if (a.dryRun || !a.confirm) {
        const lines = [
          `### Plan (HOLD)`,
          `- **Summary:** ${plan.summary}`,
          ...plan.steps.map(s => `- ${s.title} → \`${s.tool}\``),
          ``,
          `Proceed? (y/N)`
        ];
        return { content: [...j({ status: "pending", plan }), ...t(lines.join("\n"))] };
      }

      const results: any[] = [];
      for (const step of plan.steps) {
        const g = await opts.evaluateGovernance(step.tool, step.args);
        if (g.decision === "deny") {
          results.push({ id: step.id, title: step.title, tool: step.tool, status: "denied", governance: g });
          if (!plan.continueOnError) {
            return {
              content: [
                ...j({ status: "stopped", plan, results }),
                ...t(`❌ Stopped at "${step.title}" — governance denied.`)
              ],
              isError: true
            };
          }
          continue;
        }
        if (g.decision === "warn") {
          results.push({ id: step.id, title: step.title, tool: step.tool, status: "warn", governance: g });
        }

        const r = await opts.call(step.tool, step.args);
        results.push({ id: step.id, title: step.title, tool: step.tool, status: r.isError ? "error" : "ok", result: r });
        if (r.isError && !plan.continueOnError) {
          return {
            content: [
              ...j({ status: "stopped", plan, results }),
              ...t(`❌ Stopped at "${step.title}" — tool error.`)
            ],
            isError: true
          };
        }
      }

      return {
        content: [
          ...j({ status: "done", plan, results }),
          ...t(`✅ Completed: ${plan.summary}`)
        ]
      };
    }
  };

  // -------- generate_prompts (from an existing plan) --------
  const generatePrompts: ToolDef = {
    name: `${NS}generate_prompts`,
    description: "Render plan steps as @platform follow-ups for Copilot/Supervisor.",
    inputSchema: z.object({
      plan: z.object({
        summary: z.string(),
        steps: z.array(z.object({
          id: z.string(),
          title: z.string(),
          tool: z.string(),
          args: z.any()
        }))
      })
    }).strict(),
    handler: async (a) => {
      const prompts = a.plan.steps.map((s: { tool: string; args: any; }) => {
        const ns = s.tool.split(".")[0]; // e.g., "azure"
        const handle = ns === "azure" ? "@platform" : `@${ns}`; // customize if needed
        const argStr = toArgString(s.args);
        return `${handle} ${s.tool.split(".")[1]} ${argStr}`.trim();
      });

      return { content: [...j({ prompts }), ...t(prompts.map((p: any) => `- ${p}`).join("\n"))] };
    }
  };

  return [listTemplates, getTemplate, planFromTemplate, runPlan, generatePrompts];
}

/** Render flat args to key "value" pairs; nested fall back to JSON */
function toArgString(args: any): string {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k} "${String(v)}"`);
    } else {
      parts.push(`${k} ${JSON.stringify(v)}`);
    }
  }
  return parts.join(" ");
}