// packages/azure-core/src/presenters/shared/portal.ts

export type AzureCloud = "public" | "usgov" | "china" | "germany" | "stack";

/** Best-effort cloud detection from common envs */
export function detectAzureCloud(): AzureCloud {
  const cloudEnv = (process.env.AZURE_CLOUD || process.env.AZURE_ENVIRONMENT || "").toLowerCase();
  const auth = (process.env.AZURE_AUTHORITY_HOST || "").toLowerCase();
  const arm = (process.env.ARM_ENDPOINT || process.env.AZURE_RESOURCE_MANAGER_ENDPOINT || "").toLowerCase();
  const blob = `${cloudEnv} ${auth} ${arm}`;

  if (blob.includes("microsoftonline.us") || blob.includes("azure.us") || cloudEnv.includes("usgov")) return "usgov";
  if (blob.includes("microsoftonline.cn") || blob.includes("azure.cn") || cloudEnv.includes("china")) return "china";
  if (blob.includes("microsoftonline.de") || blob.includes("azure.de") || cloudEnv.includes("germany")) return "germany";
  if (blob.includes("azurestack") || cloudEnv.includes("stack")) return "stack";
  return "public";
}

export function portalBaseUrl(cloud: AzureCloud = detectAzureCloud()): string {
  // Allow override for air-gapped/stack via env
  const override = process.env.AZURE_PORTAL_BASE;
  if (override) return override;

  switch (cloud) {
    case "usgov":   return "https://portal.azure.us";
    case "china":   return "https://portal.azure.cn";
    case "germany": return "https://portal.microsoftazure.de";
    case "stack":   return "https://portal.local.azurestack.external";
    default:        return "https://portal.azure.com";
  }
}

function normId(id?: string): string {
  if (!id) return "";
  let s = id.trim();
  if (!s.startsWith("/")) s = `/${s}`;
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Build a portal URL for a resource ARM ID (default blade: overview) */
export function portalUrlForResourceId(resourceId: string, blade = "overview", cloud?: AzureCloud): string {
  const base = portalBaseUrl(cloud);
  const id = normId(resourceId);
  return `${base}/#resource${id}${blade ? `/${blade}` : ""}`;
}

/** Quick resource group link helper */
export function portalUrlForResourceGroup(subscriptionId: string, resourceGroupName: string, cloud?: AzureCloud): string {
  const id = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}`;
  return portalUrlForResourceId(id, "overview", cloud);
}

/** Parse a minimal ARM ID shape (useful for presenters) */
export function parseArmId(id?: string): {
  subscriptionId?: string;
  resourceGroup?: string;
  provider?: string;
  typePath?: string; // e.g. Microsoft.Web/serverfarms
  name?: string;     // last segment name
  segments: string[];
} {
  const s = normId(id);
  if (!s) return { segments: [] };
  const seg = s.split("/").filter(Boolean);
  const out: any = { segments: seg };
  const subIdx = seg.indexOf("subscriptions");
  if (subIdx >= 0 && seg.length > subIdx + 1) out.subscriptionId = seg[subIdx + 1];
  const rgIdx = seg.indexOf("resourceGroups");
  if (rgIdx >= 0 && seg.length > rgIdx + 1) out.resourceGroup = seg[rgIdx + 1];
  const provIdx = seg.indexOf("providers");
  if (provIdx >= 0 && seg.length > provIdx + 1) {
    out.provider = seg[provIdx + 1];
    out.typePath = seg.slice(provIdx + 1, seg.length - 1).join("/"); // provider/type[/subtype...]
    out.name = seg[seg.length - 1];
  }
  return out;
}

/** Markdown convenience */
export function portalMarkdownLink(resourceId: string, text = "Open in Azure Portal", blade = "overview", cloud?: AzureCloud) {
  const url = portalUrlForResourceId(resourceId, blade, cloud);
  return `[${text}](${url})`;
}