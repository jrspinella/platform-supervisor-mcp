// servers/platform-mcp/src/tools.onboarding.ts
import type { ToolDef } from "mcp-http";
import { z } from "zod";
import { mcpJson, mcpText, pendingPlanText } from "./lib/runtime.js";

type CallFn = (name: string, args: any) => Promise<any>;
function jsonFromCallResult(r: any) {
  if (Array.isArray(r?.content)) {
    return r.content.find((c: any) => c.type === "json")?.json ?? r.content[0]?.json ?? r;
  }
  return r;
}

export function makeOnboardingTools(call: CallFn): ToolDef[] {
  // Generic “apply template” starting with a supported id (aks-dev-cluster)
  const apply_template: ToolDef = {
    name: "platform.onboard_apply_template",
    description:
      "Apply an onboarding template by id with inputs. Currently supports: aks-dev-cluster.",
    inputSchema: z.object({
      id: z.enum(["aks-dev-cluster"]),
      inputs: z.object({
        rgName: z.string(),
        region: z.string().default("usgovvirginia"),
        clusterName: z.string(),
        nodeCount: z.number().int().min(1).default(2),
        nodeSize: z.string().default("Standard_D4s_v5"),
        privateCluster: z.boolean().default(false),
        lawName: z.string().optional()
      })
    }).strict(),
    handler: async (a: any) => {
      const i = a.inputs;
      const bullets = [
        `**Template:** ${a.id}`,
        `**RG:** ${i.rgName} (${i.region})`,
        `**AKS:** ${i.clusterName} nodes=${i.nodeCount} size=${i.nodeSize} private=${i.privateCluster ? "true" : "false"}`,
        ...(i.lawName ? [`**LAW:** ${i.lawName}`] : [])
      ];

      if (!a.confirm) {
        return {
          content: [
            ...mcpJson({ status: "pending", plan: { action: "platform.onboard_apply_template", payload: a, mode: "review" } }),
            ...mcpText(
              pendingPlanText({
                title: "platform.onboard_apply_template",
                bullets,
                followup: `@platform onboard_apply_template id "${a.id}" inputs ${JSON.stringify(a.inputs)} confirm true`
              })
            )
          ]
        };
      }

      const results: Record<string, any> = {};

      // Optional LAW first
      if (i.lawName) {
        const law = await call("azure.create_log_analytics_workspace", {
          resourceGroupName: i.rgName,
          name: i.lawName,
          location: i.region,
          sku: "PerGB2018"
        });
        const lj = jsonFromCallResult(law);
        if (law?.isError) return { content: [...mcpJson({ status: "error", step: "law", result: lj })], isError: true };
        results.law = lj;
      }

      // AKS cluster creation (your azure layer must expose this)
      const aks = await call("azure.create_aks_cluster", {
        resourceGroupName: i.rgName,
        name: i.clusterName,
        location: i.region,
        kubernetesVersion: "",
        agentPoolProfiles: [
          { name: "nodepool1", count: i.nodeCount, vmSize: i.nodeSize, mode: "System" }
        ],
        apiServerAccessProfile: { enablePrivateCluster: i.privateCluster }
      });
      const aj = jsonFromCallResult(aks);
      if (aks?.isError) return { content: [...mcpJson({ status: "error", step: "aks", result: aj })], isError: true };
      results.aks = aj;

      if (i.lawName) {
        const mon = await call("azure.enable_aks_monitoring", {
          resourceGroupName: i.rgName,
          clusterName: i.clusterName,
          workspaceResourceGroup: i.rgName,
          workspaceName: i.lawName
        });
        const mj = jsonFromCallResult(mon);
        if (mon?.isError) return { content: [...mcpJson({ status: "error", step: "aks-monitor", result: mj })], isError: true };
        results.monitor = mj;
      }

      return {
        content: [
          ...mcpJson({ status: "done", result: results }),
          ...mcpText(`✅ platform.onboard_apply_template — done.`)
        ]
      };
    }
  };

  return [apply_template];
}