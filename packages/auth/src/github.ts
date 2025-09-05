// packages/auth/src/github.ts
import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";
import * as fs from "node:fs";
import * as path from "node:path";

function loadPrivateKey(): string {
  const file = process.env.GITHUB_PRIVATE_KEY_FILE;
  if (file && fs.existsSync(file)) return fs.readFileSync(path.resolve(file), "utf8");

  const b64 = process.env.GITHUB_PRIVATE_KEY_BASE64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");

  let raw = process.env.GITHUB_PRIVATE_KEY || "";
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) raw = raw.slice(1, -1);
  if (raw.includes("\\n")) raw = raw.replace(/\\n/g, "\n");
  return raw;
}

/**
 * Create a GitHub App client that can return installation-scoped Octokit
 * for a specific owner/org, with a fallback default installation.
 */
export function makeGitHubClient(appId: number, defaultInstallationId?: number, _privateKey?: string) {
  const privateKey = (_privateKey && _privateKey.length > 0) ? _privateKey : loadPrivateKey();
  if (!privateKey || (!privateKey.includes("BEGIN RSA PRIVATE KEY") && !privateKey.includes("BEGIN PRIVATE KEY"))) {
    throw new Error("GitHub private key not loaded. Provide GITHUB_PRIVATE_KEY(_BASE64|_FILE).");
  }
  if (!appId) throw new Error("GITHUB_APP_ID is required.");

  const app = new App({ appId, privateKey });

  // Cache resolved installation IDs per owner/org to avoid repeated lookups
  const instCache = new Map<string, number>();

  async function resolveInstallationId(ownerOrOrg?: string): Promise<number> {
    if (ownerOrOrg) {
      if (instCache.has(ownerOrOrg)) return instCache.get(ownerOrOrg)!;

      // Try as org first
      try {
        const { data } = await app.octokit.request("GET /orgs/{org}/installation", { org: ownerOrOrg });
        instCache.set(ownerOrOrg, data.id);
        return data.id;
      } catch { /* fall through */ }

      // Try as user
      try {
        const { data } = await app.octokit.request("GET /users/{username}/installation", { username: ownerOrOrg });
        instCache.set(ownerOrOrg, data.id);
        return data.id;
      } catch { /* fall through */ }
    }

    if (typeof defaultInstallationId === "number") return defaultInstallationId;
    throw new Error(`No installation found for ${ownerOrOrg ?? "(unspecified owner)"} and no default GITHUB_INSTALLATION_ID set.`);
  }

  return {
    /** App-scoped Octokit (JWT), useful for listing installations, etc. */
    appJwtOctokit() {
      return app.octokit;
    },

    /** Installation-scoped Octokit for a specific owner/org (or the default installation). */
    async forInstallation(ownerOrOrg?: string) {
      const instId = await resolveInstallationId(ownerOrOrg);
      return app.getInstallationOctokit(instId);
    },
  };
}
