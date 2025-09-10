import { TemplateDef, TaskDef } from "./schema.js";
import { interpolateValue, evalWhen } from "./interp.js";
import type { Plan, PlanStep } from "./types.js";

export type ResolvedInputs = Record<string, any>;

export function resolveInputs(tpl: TemplateDef, inputs: Record<string, any>): ResolvedInputs {
  const out: ResolvedInputs = {};
  for (const [key, spec] of Object.entries(tpl.inputs || {})) {
    if (inputs[key] === undefined) {
      if (spec.required && spec.default === undefined) {
        throw new Error(`Missing required input: ${key}`);
      }
      out[key] = spec.default;
    } else {
      out[key] = inputs[key];
    }
    if (spec.enum && spec.enum.length && !spec.enum.includes(out[key])) {
      throw new Error(`Invalid value for ${key}. Expected one of: ${spec.enum.join(", ")}`);
    }
  }
  // pass-through unknown inputs
  for (const [k, v] of Object.entries(inputs)) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

export function compileTemplateToPlan(tpl: TemplateDef, inputs: ResolvedInputs): Plan {
  const steps: PlanStep[] = [];
  for (const task of tpl.tasks) {
    emitTask(task, inputs, steps);
  }
  return {
    summary: tpl.summary || `${tpl.name} (${tpl.id})`,
    steps
  };
}

function emitTask(task: TaskDef, inputs: ResolvedInputs, out: PlanStep[]) {
  // evaluate "when"
  if (!evalWhen(task.when, inputs)) return;

  if (task.kind === "group") {
    for (const child of task.tasks || []) emitTask(child, inputs, out);
    return;
  }

  // tool
  const tool = task.tool!;
  const args = interpolateValue(tool.args ?? {}, inputs);
  out.push({
    id: task.id,
    title: task.title,
    tool: tool.name,
    args
  });
}