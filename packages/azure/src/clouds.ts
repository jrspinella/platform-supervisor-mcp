import "dotenv/config";

export type AzureCloud = {
  name: "public" | "usgov" | "china";
  authorityHost: string;
  resourceManager: string;
};

export function ensureAzureCloudEnv(): AzureCloud {
  const c = (process.env.AZURE_CLOUD || process.env.AZURE_ENV || "public").toLowerCase();
  if (c === "usgov" || c === "gov" || c === "usgovernment") {
    return {
      name: "usgov",
      authorityHost: "https://login.microsoftonline.us",
      resourceManager: "https://management.usgovcloudapi.net",
    };
  }
  if (c === "china" || c === "mooncake") {
    return {
      name: "china",
      authorityHost: "https://login.chinacloudapi.cn",
      resourceManager: "https://management.chinacloudapi.cn",
    };
  }
  return {
    name: "public",
    authorityHost: "https://login.microsoftonline.com",
    resourceManager: "https://management.azure.com",
  };
}

/** Minimal options passed to ARM SDK clients to honor non-public clouds */
export function armClientOptions() {
  const cloud = ensureAzureCloudEnv();
  // Most Azure SDK clients honor `baseUri`/`endpoint` in their options.
  // If your SDK version prefers `endpoint`, you can change this key.
  return { baseUri: cloud.resourceManager } as any;
}