// packages/azure-core/src/presenters/planner-impact.ts
import { mcpText, mcpJson } from "../utils.js";

export type McpContent = { type: "text"; text: string } | { type: "json"; json: any };
export type ChangeAction = "create" | "update" | "delete" | "noop";

export interface PlanDiffResourceChange {
  id: string;
  type: string;              // e.g. "Microsoft.Web/serverfarms"
  name: string;
  action: ChangeAction;
  before?: any;
  after?: any;
  region?: string;
}

export interface PlanDiff {
  scope?: { subscriptionId?: string; resourceGroupName?: string };
  changes: PlanDiffResourceChange[];
}

/** Optional pricing hook (inject real pricing if you have it) */
export interface PriceSource {
  getUnitPrice(service: string, sku: string, region?: string): number | null; // USD/month per instance
}

/** Safe defaults: relative multipliers (NOT real $) for App Service Plan — PremiumV3 */
const RELATIVE_MULTIPLIERS: Record<string, number> = {
  "P1V3": 1.0,
  "P2V3": 2.0,
  "P3V3": 4.0,
};

/** Try to read SKU name consistently */
function readSkuName(x: any): string | undefined {
  const n = x?.sku?.name ?? x?.properties?.sku?.name ?? x?.skuName;
  return typeof n === "string" ? n : undefined;
}

/** Try to read capacity / worker count */
function readCapacity(x: any): number {
  const c =
    x?.sku?.capacity ??
    x?.properties?.sku?.capacity ??
    x?.properties?.numberOfWorkers ??
    x?.numberOfWorkers;
  return typeof c === "number" && Number.isFinite(c) ? c : 1;
}

function normSku(s: string | undefined) {
  return (s || "").trim().toUpperCase();
}

function impactForAppServicePlan(before: any, after: any, region?: string, price?: PriceSource) {
  const bSku = normSku(readSkuName(before));
  const aSku = normSku(readSkuName(after));
  const bCap = readCapacity(before);
  const aCap = readCapacity(after);

  // Units as a safe default (if no price hook)
  const bUnit = RELATIVE_MULTIPLIERS[bSku] ?? 0;
  const aUnit = RELATIVE_MULTIPLIERS[aSku] ?? 0;

  const bMonthlyUnits = bUnit * bCap;
  const aMonthlyUnits = aUnit * aCap;
  const deltaUnits = aMonthlyUnits - bMonthlyUnits;

  let bUsd: number | null = null;
  let aUsd: number | null = null;
  let deltaUsd: number | null = null;

  if (price) {
    const bPrice = price.getUnitPrice("AppServicePlan", bSku, region);
    const aPrice = price.getUnitPrice("AppServicePlan", aSku, region);
    if (typeof bPrice === "number") bUsd = bPrice * bCap;
    if (typeof aPrice === "number") aUsd = aPrice * aCap;
    if (typeof aUsd === "number" && typeof bUsd === "number") {
      deltaUsd = aUsd - bUsd;
    }
  }

  return {
    domain: "AppServicePlan",
    before: { sku: bSku || "—", capacity: bCap, unitsMonthly: bMonthlyUnits, usdMonthly: bUsd },
    after:  { sku: aSku || "—", capacity: aCap, unitsMonthly: aMonthlyUnits, usdMonthly: aUsd },
    delta:  { unitsMonthly: deltaUnits, usdMonthly: deltaUsd }
  };
}

function isAppServicePlan(type: string) {
  return /Microsoft\.Web\/serverfarms/i.test(type);
}

function fmtUsd(n: number | null | undefined) {
  return typeof n === "number" && Number.isFinite(n) ? `$${n.toFixed(2)}/mo` : "—";
}

function sign(n: number) {
  return n > 0 ? "+" : n < 0 ? "−" : "±";
}

/** Markdown presenter */
export function presentChangeImpact(diff: PlanDiff, priceSource?: PriceSource): McpContent[] {
  const rows: string[] = [];
  const details: string[] = [];
  let totalUnits = 0;
  let totalUsd: number | null = null;

  for (const c of diff.changes) {
    if (!isAppServicePlan(c.type)) continue;

    const region = c.region;
    const imp = impactForAppServicePlan(c.before, c.after, region, priceSource);

    // Accumulate totals
    totalUnits += imp.delta.unitsMonthly;
    if (imp.delta.usdMonthly != null) {
      totalUsd = (totalUsd ?? 0) + imp.delta.usdMonthly;
    }

    rows.push(
      `| \`${c.name}\` | ${c.action} | ${imp.before.sku}×${imp.before.capacity} → ${imp.after.sku}×${imp.after.capacity} | ` +
      `${sign(imp.delta.unitsMonthly)}${Math.abs(imp.delta.unitsMonthly)} units | ${fmtUsd(imp.delta.usdMonthly)} |`
    );

    details.push(
      `<details><summary>${c.name} · App Service Plan</summary>

**Before**
- SKU: \`${imp.before.sku}\`
- Capacity: \`${imp.before.capacity}\`
- **Units:** \`${imp.before.unitsMonthly}\`${imp.before.usdMonthly != null ? ` · **Cost:** ${fmtUsd(imp.before.usdMonthly)}` : ""}

**After**
- SKU: \`${imp.after.sku}\`
- Capacity: \`${imp.after.capacity}\`
- **Units:** \`${imp.after.unitsMonthly}\`${imp.after.usdMonthly != null ? ` · **Cost:** ${fmtUsd(imp.after.usdMonthly)}` : ""}

**Delta:** \`${sign(imp.delta.unitsMonthly)}${Math.abs(imp.delta.unitsMonthly)} units\`${imp.delta.usdMonthly != null ? ` · ${fmtUsd(imp.delta.usdMonthly)}` : ""}
</details>`
    );
  }

  const headline = [
    `## Change Impact`,
    `**Scope:** ${diff.scope?.resourceGroupName ? `\`${diff.scope.resourceGroupName}\`` : "—"}`,
    "",
    rows.length
      ? [
          `| Plan | Action | SKU/Capacity | Δ Units | Δ Est. Cost |`,
          `|---|---|---|---:|---:|`,
          rows.join("\n"),
        ].join("\n")
      : "_No App Service Plan changes detected._",
    "",
    totalUnits || totalUsd != null
      ? `**Total Delta:** ${sign(totalUnits)}${Math.abs(totalUnits)} units` +
        (totalUsd != null ? ` · **Total Est.:** ${fmtUsd(totalUsd)}` : "") :
        "",
    "",
    ...(details.length ? details : []),
  ].filter(Boolean).join("\n");

  return [
    ...mcpText(headline),
    ...mcpJson({ kind: "changeImpact", totals: { units: totalUnits, usdMonthly: totalUsd }, items: rows.length }),
  ];
}
