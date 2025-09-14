// packages/azure-core/src/presenters/planner.ts
import { mcpText } from "../utils.js";
import type { GovernanceBlock } from "@platform/governance-core";

export type McpContent = { type: "text"; text: string } | { type: "json"; json: any };

export type PlannerStepStatus = "planned" | "running" | "succeeded" | "failed" | "skipped";
export interface PlannerStep {
  id: string;
  title: string;
  tool: string;                 // e.g. "platform.create_resource_group"
  args: any;
  status: PlannerStepStatus;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  governance?: GovernanceBlock; // optional — if you evaluate before execution
  resultId?: string;            // ARM resourceId or logical id
  error?: { message: string; code?: string };
}

export interface PlannerPlan {
  id: string;
  goal: string;
  createdAt: string;
  apply: boolean;
  profile?: string;  // ATO profile (if relevant)
  steps: PlannerStep[];
}

const STATUS_EMOJI: Record<PlannerStepStatus, string> = {
  planned: "📝",
  running: "🏃",
  succeeded: "✅",
  failed: "❌",
  skipped: "⏭️",
};

function codeFenceJSON(obj: any, maxChars = 500): string {
  const pretty = JSON.stringify(obj ?? {}, null, 2);
  const body = pretty.length > maxChars ? pretty.slice(0, maxChars) + "\n… (truncated)" : pretty;
  return ["```json", body, "```"].join("\n");
}

function miniGovBadge(g?: GovernanceBlock): string {
  if (!g) return "";
  const s = (g.decision || "").toLowerCase();
  const badge = s === "deny" ? "🔴 Denied" : s === "warn" ? "🟡 Warn" : "🟢 Allowed";
  const ctrls = (g.controls ?? []).join(", ") || "—";
  const ids = (g.policyIds ?? []).map(p => `\`${p}\``).join(", ") || "—";
  // one-liner to avoid the big card you already render elsewhere
  return `> **Governance:** ${badge} · **Policies:** ${ids} · **Controls:** ${ctrls}`;
}

function fmtMs(ms?: number) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

export function presentPlanOverview(plan: PlannerPlan) {
  const rows = plan.steps.map((s, i) => {
    const st = STATUS_EMOJI[s.status] || "•";
    return `| ${i + 1} | ${st} ${s.status} | \`${s.tool}\` | ${s.title} |`;
  }).join("\n") || "| — | — | — | — |";

  const md = [
    `## Plan Overview`,
    "",
    `**Goal:** ${plan.goal}`,
    `**Mode:** ${plan.apply ? "Apply" : "Dry-run"}${plan.profile ? ` · **ATO Profile:** \`${plan.profile}\`` : ""}`,
    `**Steps:** ${plan.steps.length}`,
    "",
    `| # | Status | Tool | Title |`,
    `|---:|---|---|---|`,
    rows,
    "",
  ].join("\n");

  return mcpText(md);
}

export function presentStepDetail(step: PlannerStep) {
  const lines: string[] = [
    `### ${STATUS_EMOJI[step.status]} ${step.title}`,
    "",
    `**Tool:** \`${step.tool}\` · **Status:** ${step.status} · **Time:** ${fmtMs(step.durationMs)}`,
    "",
    `**Args**`,
    codeFenceJSON(step.args),
  ];

  const g = miniGovBadge(step.governance);
  if (g) lines.push("", g);

  if (step.resultId) {
    const url = portalUrlForResourceId(step.resultId);
    lines.push("", url ? `[Open in Azure Portal](${url})` : "");
  }

  if (step.error) {
    lines.push(
      "",
      `> **Error:** ${step.error.message}${step.error.code ? ` (code: \`${step.error.code}\`)` : ""}`
    );
  }

  lines.push(""); // trailing newline
  return mcpText(lines.join("\n"));
}

export function presentExecutionUpdate(step: PlannerStep) {
  const md = [
    `**${STATUS_EMOJI[step.status]} Step ${step.status}:** ${step.title}`,
    step.status === "running" ? "" : `Duration: ${fmtMs(step.durationMs)}`,
    step.status === "failed" && step.error ? `\n> ${step.error.message}` : "",
    "",
  ].join("\n");
  return mcpText(md);
}

export function presentFinalSummary(plan: PlannerPlan) {
  const total = plan.steps.length;
  const passed = plan.steps.filter(s => s.status === "succeeded").length;
  const failed = plan.steps.filter(s => s.status === "failed").length;
  const skipped = plan.steps.filter(s => s.status === "skipped").length;

  const md = [
    `## Execution Summary`,
    "",
    `**Goal:** ${plan.goal}`,
    `**Mode:** ${plan.apply ? "Apply" : "Dry-run"}`,
    "",
    `- Succeeded: **${passed}**`,
    `- Failed: **${failed}**`,
    `- Skipped: **${skipped}**`,
    `- Total: **${total}**`,
    "",
    failed > 0
      ? [
          `<details><summary>Retry failed steps</summary>`,
          "",
          "```bash",
          ...plan.steps
            .filter(s => s.status === "failed")
            .map(s => `@platform ${s.tool.replace(/^azure\./, "platform.")} ${JSON.stringify(s.args)}`),
          "```",
          "",
          "</details>",
          "",
        ].join("\n")
      : "",
  ].join("\n");

  return mcpText(md);
}

// --- Azure Portal helpers (kept inline to avoid extra imports) ----------------
function isGov(): boolean {
  return (process.env.AZURE_AUTHORITY_HOST || "").includes("login.microsoftonline.us")
      || process.env.AZURE_CLOUD === "usgovernment";
}
function portalUrlForResourceId(resourceId?: string) {
  if (!resourceId) return "";
  const base = isGov() ? "https://portal.azure.us" : "https://portal.azure.com";
  return `${base}/#resource${resourceId}/overview`;
}
