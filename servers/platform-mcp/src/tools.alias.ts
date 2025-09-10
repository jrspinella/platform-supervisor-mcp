// servers/platform-mcp/src/tools.alias.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import { mcpJson, mcpText, pendingPlanText, firstJson } from "./lib/runtime.js";

type CallFn = (name: string, args: any) => Promise<any>;

function jsonFromCallResult(r: any) {
  if (Array.isArray(r?.content)) {
    return r.content.find((c: any) => c.type === "json")?.json ?? r.content[0]?.json ?? r;
  }
  return r;
}

export function makeAliasTools(call: CallFn): ToolDef[] {
  // One-shot “web app stack” (optionally create RG) to reduce clicks.
  const provision_web_stack: ToolDef = {
    name: "platform.provision_web_stack",
    description:
      "Provision a basic App Service stack: (optional) RG → Plan → WebApp → (optional) MSI. Parameters allow you to skip RG and MSI if not needed.",
    inputSchema: z.object({
      createRg: z.boolean().default(false),
      resourceGroupName: z.string(),
      location: z.string(),
      planName: z.string(),
      planSku: z.string().default("P1v3"),
      webAppName: z.string(),
      runtime: z.string().default("NODE|20-lts"),
      enableMsi: z.boolean().default(true),
      tags: z.any().optional()
    }).strict(),
    handler: async (a: any) => {
      const bullets = [
        `**RG:** ${a.resourceGroupName} ${a.createRg ? "(will create if missing)" : "(assumed existing)"}`,
        `**Location:** ${a.location}`,
        `**Plan:** ${a.planName} / **SKU:** ${a.planSku}`,
        `**WebApp:** ${a.webAppName} / **Runtime:** ${a.runtime}`,
        `**MSI:** ${a.enableMsi ? "enable" : "skip"}`,
        ...(a.tags ? [`**Tags:** \`${JSON.stringify(a.tags)}\``] : [])
      ];

      // Hold / pending
      if (!a.confirm) {
        return {
          content: [
            ...mcpJson({
              status: "pending",
              plan: {
                action: "platform.provision_web_stack",
                payload: a,
                mode: "review"
              }
            }),
            ...mcpText(
              pendingPlanText({
                title: "platform.provision_web_stack",
                bullets,
                followup:
                  `@platform provision_web_stack ${[
                    `resourceGroupName "${a.resourceGroupName}"`,
                    `location "${a.location}"`,
                    `planName "${a.planName}"`,
                    `planSku "${a.planSku}"`,
                    `webAppName "${a.webAppName}"`,
                    `runtime "${a.runtime}"`,
                    a.createRg ? `createRg true` : ``,
                    a.enableMsi ? `enableMsi true` : `enableMsi false`,
                    a.tags ? `tags ${JSON.stringify(a.tags)}` : ``,
                    `confirm true`
                  ].filter(Boolean).join(" ")}`
              })
            )
          ]
        };
      }

      // Execute sequentially using local azure.* tools
      const results: Record<string, any> = {};

      if (a.createRg) {
        const rg = await call("azure.create_resource_group", {
          name: a.resourceGroupName,
          location: a.location,
          tags: a.tags
        });
        const rj = jsonFromCallResult(rg);
        if (rg?.isError) return { content: [...mcpJson({ status: "error", step: "rg", result: rj })], isError: true };
        results.rg = rj;
      }

      const plan = await call("azure.create_app_service_plan", {
        resourceGroupName: a.resourceGroupName,
        location: a.location,
        name: a.planName,
        sku: a.planSku,
        tags: a.tags
      });
      const pj = jsonFromCallResult(plan);
      if (plan?.isError) return { content: [...mcpJson({ status: "error", step: "plan", result: pj })], isError: true };
      results.plan = pj;

      const web = await call("azure.create_web_app", {
        resourceGroupName: a.resourceGroupName,
        location: a.location,
        name: a.webAppName,
        appServicePlanName: a.planName,
        linuxFxVersion: a.runtime,
        httpsOnly: true,
        minimumTlsVersion: "1.2",
        ftpsState: "Disabled",
        tags: a.tags
      });
      const wj = jsonFromCallResult(web);
      if (web?.isError) return { content: [...mcpJson({ status: "error", step: "webapp", result: wj })], isError: true };
      results.webApp = wj;

      if (a.enableMsi) {
        const msi = await call("azure.enable_system_assigned_identity", {
          resourceGroupName: a.resourceGroupName,
          name: a.webAppName,
          location: a.location
        });
        const mj = jsonFromCallResult(msi);
        if (msi?.isError) return { content: [...mcpJson({ status: "error", step: "msi", result: mj })], isError: true };
        results.msi = mj;
      }

      return {
        content: [
          ...mcpJson({ status: "done", result: results }),
          ...mcpText(`✅ platform.provision_web_stack — done.`)
        ]
      };
    }
  };

  // Lightweight alias to enable TLS 1.2 + HTTPS-only for a web app
  const harden_webapp_minimums: ToolDef = {
    name: "platform.harden_webapp_minimums",
    description: "Ensure HTTPS-only, TLS 1.2, and FTPS disabled on a Web App.",
    inputSchema: z.object({
      resourceGroupName: z.string(),
      name: z.string(),
      location: z.string()
    }).strict(),
    handler: async (a: any) => {
      if (!a.confirm) {
        return {
          content: [
            ...mcpJson({ status: "pending", plan: { action: "platform.harden_webapp_minimums", payload: a, mode: "review" } }),
            ...mcpText(
              pendingPlanText({
                title: "platform.harden_webapp_minimums",
                bullets: [
                  `**WebApp:** ${a.name}`,
                  `**RG:** ${a.resourceGroupName}`,
                  `**Location:** ${a.location}`,
                  `**Set:** HTTPS-only=true, TLS=1.2, FTPS=Disabled`
                ],
                followup:
                  `@platform harden_webapp_minimums resourceGroupName "${a.resourceGroupName}" name "${a.name}" location "${a.location}" confirm true`
              })
            )
          ]
        };
      }

      const res = await call("azure.configure_web_app_security", {
        resourceGroupName: a.resourceGroupName,
        name: a.name,
        httpsOnly: true,
        minimumTlsVersion: "1.2",
        ftpsState: "Disabled"
      });
      const rj = jsonFromCallResult(res);
      if (res?.isError) return { content: [...mcpJson({ status: "error", result: rj })], isError: true };

      return {
        content: [
          ...mcpJson({ status: "done", result: rj }),
          ...mcpText(`✅ platform.harden_webapp_minimums — done.`)
        ]
      };
    }
  };

  return [provision_web_stack, harden_webapp_minimums];
}