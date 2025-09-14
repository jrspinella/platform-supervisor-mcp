import { z } from "zod";
import type { ToolDef } from "mcp-http";

// If you already have these, import them instead of redefining:
type McpContent = { type: "text"; text: string } | { type: "json"; json: any };

// Reuse your existing tag parser if available; otherwise this is your shared one.
function parseTags(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lower = input.trim();

  const canon = (k: string) =>
    ({ environment: "env", env: "env", owner: "owner", application: "app", app: "app", project: "project" }[k] || k);

  const iTags = lower.toLowerCase().indexOf("tags");
  const scope = iTags >= 0 ? lower.slice(iTags + 4) : lower;

  const pairRe = /\b([a-z][\w.-]*)\s*(?:=|:|\bis\b)\s*(?:"([^"]+)"|'([^']+)'|([^\s,;{}]+))/gi;

  let m: RegExpExecArray | null;
  while ((m = pairRe.exec(scope)) !== null) {
    const key = canon(m[1].toLowerCase());
    if (key === "tags") continue;
    const val = (m[2] ?? m[3] ?? m[4] ?? "").replace(/[.,;]$/g, "");
    if (key && val) out[key] = val;
  }

  if (Object.keys(out).length === 0) {
    const brace = scope.match(/\{([\s\S]*?)\}/);
    if (brace) {
      let mb: RegExpExecArray | null;
      while ((mb = pairRe.exec(brace[1])) !== null) {
        const key = canon(mb[1].toLowerCase());
        const val = (mb[2] ?? mb[3] ?? mb[4] ?? "").replace(/[.,;]$/g, "");
        if (key && val) out[key] = val;
      }
      if (Object.keys(out).length === 0) {
        try {
          const jsonish =
            "{" +
            brace[1]
              .replace(/([,{]\s*)([A-Za-z_][\w.-]*)\s*:/g, '$1"$2":')
              .replace(/:\s*'([^']*)'/g, ':"$1"') +
            "}";
          const obj = JSON.parse(jsonish);
          for (const [k, v] of Object.entries(obj)) out[canon(k.toLowerCase())] = String(v);
        } catch {}
      }
    }
  }
  return out;
}

// Very small, robust extractors for your sentence shape
function parseWorkloadPrompt(prompt: string) {
  const text = " " + prompt.replace(/@platform/gi, "").trim(); // ignore duplicated @platforms
  const rgMatch = text.match(/\bresource group\s+([a-z0-9-]+)\s+in\s+([a-z0-9-]+)/i);
  const planMatch = text.match(/\bapp service plan\s+([a-z0-9-]+)\s*\(([^)]+)\)/i);
  const webMatch = text.match(/\b(?:linux\s+)?web app\s+([a-z0-9-]+)/i);

  const tags = parseTags(text);
  const httpsOnly = /\bhttps[-\s]?only\b/i.test(text);
  const tlsMatch = text.match(/\bTLS\s*([0-9.]+)/i);
  const ftpsDisabled = /\bFTPS\s+disabled\b/i.test(text);

  const minimumTlsVersion = tlsMatch ? tlsMatch[1] : undefined;
  const ftpsState = ftpsDisabled ? "Disabled" : undefined;

  const rg = rgMatch
    ? { name: rgMatch[1], location: rgMatch[2], tags }
    : undefined;

  const plan = planMatch
    ? { name: planMatch[1], sku: planMatch[2] }
    : undefined;

  const web = webMatch
    ? { name: webMatch[1], httpsOnly, minimumTlsVersion, ftpsState }
    : undefined;

  return { rg, plan, web };
}

// Pretty step list
function planMarkdown(scope: { rg?: any; plan?: any; web?: any }) {
  const lines: string[] = ["### Planned actions"];
  if (scope.rg) lines.push(`1. Create **Resource Group** \`${scope.rg.name}\` in \`${scope.rg.location}\` with tags ${JSON.stringify(scope.rg.tags || {}, null, 0)}`);
  if (scope.plan) lines.push(`2. Create **App Service Plan** \`${scope.plan.name}\` (SKU **${scope.plan.sku}**)`);
  if (scope.web) {
    const parts = [];
    if (scope.web.httpsOnly) parts.push("HTTPS-only");
    if (scope.web.minimumTlsVersion) parts.push(`TLS ${scope.web.minimumTlsVersion}`);
    if (scope.web.ftpsState === "Disabled") parts.push("FTPS disabled");
    lines.push(`3. Create **Linux Web App** \`${scope.web.name}\`${parts.length ? ` with ${parts.join(", ")}` : ""}`);
  }
  return lines.join("\n");
}

// This tool will call your *existing* azure-core tools by name
export function makeCreateWorkloadTool(registry: Map<string, ToolDef>): ToolDef {
  const run = async (toolName: string, args: any) => {
    const t = registry.get(toolName);
    if (!t) throw new Error(`Tool not found: ${toolName}`);
    const out = await t.handler(args);
    return out;
  };

  return {
    name: "platform.create_workload",
    description: "Parse a natural-language Azure workload request and execute multiple Azure steps (RG, Plan, Web App) sequentially.",
    inputSchema: z.object({
      prompt: z.string(),
      apply: z.boolean().default(true),
      defaults: z
        .object({
          // fallback when web/plan don't state location explicitly
          location: z.string().optional(),
        })
        .optional(),
    }).strict(),
    handler: async (a: any) => {
      const { rg, plan, web } = parseWorkloadPrompt(String(a.prompt || ""));
      if (!rg && !plan && !web) {
        const msg = "No actionable steps detected. Mention at least a resource group, plan, or web app.";
        return { content: [{ type: "text", text: `> ⚠️ ${msg}` }], isError: true };
      }

      const planMd = planMarkdown({ rg, plan, web });
      if (!a.apply) {
        return {
          content: [
            { type: "text", text: planMd },
            { type: "json", json: { status: "plan", steps: { rg, plan, web } } },
          ],
        };
      }

      const outputs: McpContent[] = [{ type: "text", text: planMd }];

      // 1) RG
      if (rg) {
        const res = await run("azure.create_resource_group", { name: rg.name, location: rg.location, tags: rg.tags });
        outputs.push(...(res?.content || []));
        if (res?.isError) return { content: outputs, isError: true }; // likely governance DENY; pretty block already included
      }

      // 2) Plan
      if (plan) {
        const res = await run("azure.create_app_service_plan", {
          resourceGroupName: rg?.name,
          name: plan.name,
          location: rg?.location || a.defaults?.location || "",
          sku: plan.sku,
        });
        outputs.push(...(res?.content || []));
        if (res?.isError) return { content: outputs, isError: true };
      }

      // 3) Web App
      if (web) {
        const res = await run("azure.create_web_app", {
          resourceGroupName: rg?.name,
          name: web.name,
          location: rg?.location || a.defaults?.location || "",
          appServicePlanName: plan?.name,
          httpsOnly: web.httpsOnly === true ? true : undefined,
          minimumTlsVersion: web.minimumTlsVersion ?? undefined,
          ftpsState: web.ftpsState ?? undefined,
        });
        outputs.push(...(res?.content || []));
        if (res?.isError) return { content: outputs, isError: true };
      }

      return { content: outputs };
    },
  } satisfies ToolDef;
}
