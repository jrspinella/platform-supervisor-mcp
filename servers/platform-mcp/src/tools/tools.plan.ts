// servers/platform-mcp/src/tools/tools.plan.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";

// OPTIONAL: pretty presenters for JSON-only tools
import {
  presentResourceGroup,
  presentAppServicePlan,
  presentWebApp,
  presentKeyVault,
  presentStorageAccount,
  presentLogAnalyticsWorkspace,
  presentVirtualNetwork,
  presentSubnet,
  presentPrivateEndpoint,
  presentAksCluster,
} from "@platform/azure-core";

type McpContent = { type: "text"; text: string } | { type: "json"; json: any };

const StepSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.any()).default({}),
});

const PlanSchema = z.object({
  apply: z.boolean().default(false),
  profile: z.string().default(process.env.ATO_PROFILE || "default"),
  // compact: prefer text/fallback pretty, hide raw JSON unless debugJson=true
  render: z.enum(["full", "compact"]).default("compact"),
  debugJson: z.boolean().default(false),
  // optional governance context + tag string that callers may pass along
  context: z.object({ text: z.string() }).optional(),
  tagString: z.string().optional(),
  steps: z.array(StepSchema).min(1).max(20),
}).strict();

/* ───────────────────────────── Small helpers ───────────────────────────── */

function isText(c: McpContent): c is { type: "text"; text: string } { return c?.type === "text"; }
function isJson(c: McpContent): c is { type: "json"; json: any } { return c?.type === "json"; }
function asArray<T>(x: T | T[] | undefined): T[] { return Array.isArray(x) ? x : x ? [x] : []; }
function iconForResult(r: "ok" | "error") { return r === "ok" ? "✅" : "⛔️"; }

function renderPlanSummary(status: "done" | "stopped", progress: Array<{ step: number; tool: string; status: "ok" | "error" }>): McpContent {
  const banner = status === "done" ? "✅ Plan completed" : "⛔️ Plan stopped";
  const lines: string[] = [
    `\n\n### ${banner}`,
    "",
    "| # | Tool | Result |",
    "|---|------|--------|",
    ...progress.map(p => `| ${p.step + 1} | \`${p.tool}\` | ${iconForResult(p.status)} ${p.status === "ok" ? "OK" : "Error"} |`)
  ];
  return { type: "text", text: lines.join("\n") };
}

function stepHeader(i: number, toolName: string, status: "ok" | "warn" | "error"): McpContent {
  const icon = status === "ok" ? "✅" : status === "warn" ? "⚠️" : "⛔️";
  // leading blank line breaks out of any ```json fence that a prior tool emitted
  return { type: "text", text: `\n\n### ${icon} Step ${i + 1}: \`${toolName}\`` };
}

function firstJsonChunk(res: any): any | undefined {
  const content: McpContent[] = asArray(res?.content);
  return content.find(isJson)?.json;
}

function tryParseErrorJSON(msg: unknown): any | undefined {
  if (typeof msg !== "string") return undefined;
  const s = msg.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return undefined;
  try { return JSON.parse(s); } catch { return undefined; }
}

function extractUserMessage(errLike: any): string {
  const e = errLike?.error || errLike;
  const raw = e?.message ?? e?.error?.message ?? "";
  const parsed = tryParseErrorJSON(raw);
  const nice = parsed?.Message || parsed?.message || parsed?.error?.message;
  return String(nice || raw || "Unknown error");
}

function renderErrorSummary(errLike: any): string {
  const e = errLike?.error || errLike;
  const code = e?.code || e?.type || "Error";
  const status = e?.statusCode ?? e?.status;
  const requestId = e?.requestId;
  const msg = extractUserMessage(errLike);

  const lines: string[] = [
    "**Error**",
    ...(code ? [`- code: \`${code}\``] : []),
    ...(typeof status === "number" ? [`- status: **${status}**`] : []),
    ...(requestId ? [`- requestId: \`${requestId}\``] : []),
    "",
    `> ${msg}`,
  ];
  return lines.join("\n");
}

function mergeGovCtx(stepArgs: any, plan: any) {
  const out = { ...(stepArgs || {}) };
  if (plan?.context?.text) {
    out.context = { ...(out.context || {}), text: plan.context.text };
  }
  if (plan?.tagString && !out.tags && !out.tagString) {
    out.tagString = plan.tagString;
  }
  return out;
}

/* ─────────────── Fallback presenters (pretty cards from JSON) ─────────────── */

function fallbackPresenterFromJson(json: any): McpContent[] | undefined {
  if (!json || typeof json !== "object") return undefined;
  const type = String(json.type || "").toLowerCase();

  try {
    if (type.includes("microsoft.resources/resourcegroups")) return presentResourceGroup(json);
    if (type.includes("microsoft.web/serverfarms")) return presentAppServicePlan(json);
    if (type.includes("microsoft.web/sites")) return presentWebApp(json);
    if (type.includes("microsoft.keyvault/vaults")) return presentKeyVault(json);
    if (type.includes("microsoft.storage/storageaccounts")) return presentStorageAccount(json);
    if (type.includes("microsoft.operationalinsights/workspaces")) return presentLogAnalyticsWorkspace(json);
    if (type.includes("microsoft.network/virtualnetworks")) return presentVirtualNetwork(json);
    if (type.includes("microsoft.network/virtualnetworks/subnets")) return presentSubnet(json);
    if (type.includes("microsoft.network/privateendpoints")) return presentPrivateEndpoint(json);
    if (type.includes("microsoft.containerservice/managedclusters")) return presentAksCluster(json);
  } catch { /* ignore presenter errors */ }

  return undefined;
}

/* ─────────────────────── Failure classification + tips ────────────────────── */

function classifyFailure(_toolName: string, _args: any, errLike: any) {
  const e = errLike?.error || errLike || {};
  const code = String(e.code || e.type || "");
  const msg = String(e.message || "");

  if (code === "ResourceGroupNotFound" || /Resource group .* not be found/i.test(msg)) {
    return { kind: "MISSING_RG" as const };
  }
  if (/LinuxFxVersion/i.test(msg) || /invalid value/i.test(msg)) {
    return { kind: "BAD_LINUX_FX" as const };
  }
  return { kind: "UNKNOWN" as const };
}

function suggestNextSteps(toolName: string, args: any, failure: ReturnType<typeof classifyFailure>) {
  const suggestions: { title: string; bash: string }[] = [];

  if (failure.kind === "MISSING_RG") {
    const rg = args?.resourceGroupName || args?.name;
    const loc = args?.location || "usgovvirginia";
    if (rg) {
      suggestions.push({
        title: "Create the missing resource group",
        bash: `@platform platform.create_resource_group ${JSON.stringify({ name: rg, location: loc })}`,
      });
    }
  }

  if (failure.kind === "BAD_LINUX_FX") {
    const patch = {
      resourceGroupName: args?.resourceGroupName,
      name: args?.name,
      linuxFxVersion: args?.linuxFxVersion ?? args?.runtimeStack ?? "NODE|20-lts",
    };
    suggestions.push({
      title: "Fix runtime (LinuxFxVersion)",
      bash: `@platform azure.update_web_app_config ${JSON.stringify(patch)}`,
    });
  }

  return suggestions;
}

/* ─────────────────────────── Waiters / readiness ─────────────────────────── */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function waitUntil(
  check: () => Promise<boolean>,
  { timeoutMs = Number(process.env.PLAN_WAIT_TIMEOUT_MS || 45_000), intervalMs = 1500, label = "resource" } = {}
) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await check()) return true;
    } catch { /* retry */ }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} to become available`);
}

async function waitForPropagation(
  stepTool: string,
  args: any,
  resolveTool: (name: string) => ToolDef | undefined
) {
  if (stepTool === "platform.create_resource_group" && args?.name) {
    const get = resolveTool("platform.get_resource_group");
    if (get?.handler) {
      const name = args.name;
      await waitUntil(async () => {
        const r = await get.handler({ name });
        return !r?.isError;
      }, { label: `resource group ${name}` });
    }
  }

  if (stepTool === "platform.create_app_service_plan" && args?.resourceGroupName && args?.name) {
    const get = resolveTool("platform.get_app_service_plan");
    if (get?.handler) {
      const { resourceGroupName, name } = args;
      await waitUntil(async () => {
        const r = await get.handler({ resourceGroupName, name });
        return !r?.isError;
      }, { label: `app service plan ${resourceGroupName}/${name}` });
    }
  }
}

/* ─────────────────── Compose per-step display content ──────────────────── */

function buildStepContent(
  i: number,
  toolName: string,
  res: { content?: McpContent[]; isError?: boolean; _meta?: any } | any,
  render: "full" | "compact",
  debugJson: boolean
): McpContent[] {
  const out: McpContent[] = [];
  const decision = res?._meta?.governance?.decision;
  const status: "ok" | "warn" | "error" =
    res?.isError ? "error" : decision === "warn" ? "warn" : "ok";

  // Header
  out.push(stepHeader(i, toolName, status));

  // If failed, show concise error summary up front
  if (res?.isError) {
    const j = firstJsonChunk(res);
    out.push({ type: "text", text: renderErrorSummary(j ?? res) });
  }

  const content: McpContent[] = asArray(res?.content);
  const textParts = content.filter(isText);
  const jsonParts = content.filter(isJson);

  if (render === "compact") {
    if (textParts.length) {
      out.push(...textParts);
      return out;
    }
    const fp = jsonParts.length ? fallbackPresenterFromJson(jsonParts[0].json) : undefined;
    if (fp?.length) {
      out.push(...fp);
      return out;
    }
    if (debugJson && jsonParts.length) out.push(jsonParts[0]);
    return out;
  }

  // full mode: if no text, try fallback pretty first
  if (!textParts.length && jsonParts.length) {
    const fp = fallbackPresenterFromJson(jsonParts[0].json);
    if (fp?.length) out.push(...fp);
  }

  // include original content; optionally filter JSON if debugJson=false
  if (!debugJson) {
    out.push(...content.filter(isText));
  } else {
    out.push(...content);
  }

  return out;
}

/* ────────────────────────────── Public entry ────────────────────────────── */

export function makePlanTools(resolveTool: (name: string) => ToolDef | undefined): ToolDef[] {
  const apply_plan: ToolDef = {
    name: "platform.apply_plan",
    description: "Execute a sequence of platform.* steps with governance gates; waits for RG/Plan readiness; stops on first error/deny.",
    inputSchema: PlanSchema,
    handler: async (plan) => {
      const progress: Array<{ step: number; tool: string; status: "ok" | "error"; error?: string }> = [];
      const transcript: McpContent[] = [];

      for (let i = 0; i < plan.steps.length; i++) {
        const step = plan.steps[i];
        const tool = resolveTool(step.tool);

        if (!tool?.handler) {
          progress.push({ step: i, tool: step.tool, status: "error", error: "unknown tool" });
          transcript.push(stepHeader(i, step.tool, "error"));
          transcript.push({ type: "text", text: `**Error**\n> Tool not found: \`${step.tool}\`` });
          return { content: [...transcript, { type: "json", json: { status: "stopped", progress } }], isError: true };
        }

        const args = { ...(step.args || {}), ...(plan.profile ? { profile: plan.profile } : {}) };
        const mergedArgs = mergeGovCtx(args, plan);

        try {
          const res = await tool.handler(mergedArgs);

          const denied = res?._meta?.governance?.decision === "deny";
          const failed = Boolean(res?.isError || denied);

          // Render this step (header + pretty + optional JSON)
          transcript.push(...buildStepContent(i, step.tool, res, plan.render, plan.debugJson));

          if (failed) {
            // Add Next steps suggestions
            const failure = classifyFailure(step.tool, mergedArgs, res);
            const next = suggestNextSteps(step.tool, mergedArgs, failure);
            if (next.length) {
              transcript.push({ type: "text", text: "\n**Next steps**" });
              for (const s of next) {
                transcript.push({ type: "text", text: `- ${s.title}` });
                transcript.push({ type: "text", text: "```bash\n" + s.bash + "\n```" });
              }
            }

            progress.push({ step: i, tool: step.tool, status: "error" });
            return {
              content: [
                ...transcript,
                renderPlanSummary("stopped", progress),
                ...(plan.debugJson ? [{ type: "json" as const, json: { status: "stopped", progress } }] : []),
              ],
              isError: true,
            };
          }

          progress.push({ step: i, tool: step.tool, status: "ok" });

          // Wait for propagation after create RG / create plan
          try { await waitForPropagation(step.tool, mergedArgs, resolveTool); } catch { /* don't fail plan on waiter */ }

        } catch (e: any) {
          const msg = e?.message || String(e);
          progress.push({ step: i, tool: step.tool, status: "error", error: msg });
          transcript.push(stepHeader(i, step.tool, "error"));
          transcript.push({ type: "text", text: renderErrorSummary({ error: { message: msg } }) });
          return { content: [...transcript, { type: "json", json: { status: "stopped", progress } }], isError: true };
        }
      }

      // All steps completed
      return {
        content: [
          ...transcript,
          renderPlanSummary("done", progress),
          ...(plan.debugJson ? [{ type: "json" as const, json: { status: "done", progress } }] : []),
        ],
      };
    },
  };

  return [apply_plan];
}