import { z } from "zod";

/** Input spec for a template variable */
export const InputSpecSchema = z.object({
  required: z.boolean().optional(),
  default: z.any().optional(),
  enum: z.array(z.any()).optional(),
  description: z.string().optional()
}).strict();

export const InputsSchema = z.record(InputSpecSchema);

/** Tool call inside a task */
export const ToolCallSchema = z.object({
  name: z.string(),
  args: z.any().default({})
}).strict();

export const TaskSchema: z.ZodType<any> = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.enum(["tool", "group"]).default("tool"),
  when: z.string().optional(),
  tool: ToolCallSchema.optional(),
  tasks: z.array(z.lazy(() => TaskSchema)).optional()
}).strict().refine((t) => {
  if (t.kind === "tool") return !!t.tool;
  if (t.kind === "group") return Array.isArray(t.tasks) && t.tasks.length > 0;
  return false;
}, { message: "Task kind mismatch: tool requires 'tool', group requires 'tasks'." });

export const TemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  summary: z.string().optional(),
  inputs: InputsSchema.default({}),
  tasks: z.array(TaskSchema).default([])
}).strict();

export type TemplateDef = z.infer<typeof TemplateSchema>;
export type TaskDef = z.infer<typeof TaskSchema>;