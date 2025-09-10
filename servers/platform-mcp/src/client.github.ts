// servers/platform-mcp/src/clients.github.ts
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

/**
 * Env:
 *  - GITHUB_API_URL (optional, GHES) e.g. https://github.myco.com/api/v3
 *  - GITHUB_APP_ID (required)
 *  - GITHUB_APP_PRIVATE_KEY (required; supports literal PEM or \n-escaped)
 *    OR GITHUB_APP_PRIVATE_KEY_BASE64 (base64 of PEM)
 *  - GITHUB_APP_WEBHOOK_SECRET (optional)
 *  - GITHUB_APP_INSTALLATION_ID (optional default installation)
 *  - GITHUB_APP_INSTALLATION_MAP (optional JSON: { "my-org": 123456, "another": 7890 })
 *  - GITHUB_FALLBACK_TOKEN (optional PAT fallback if app auth not configured)
 */

const GH_BASE_URL = process.env.GITHUB_API_URL || "https://api.github.com";

function resolvePrivateKey(): string | undefined {
  let pk = process.env.GITHUB_APP_PRIVATE_KEY;
  const b64 = process.env.GITHUB_APP_PRIVATE_KEY_BASE64;
  if (!pk && b64) {
    pk = Buffer.from(b64, "base64").toString("utf8");
  }
  if (pk) {
    // Allow envs where newlines are escaped
    if (!pk.includes("-----BEGIN") && pk.includes("\\n")) {
      pk = pk.replace(/\\n/g, "\n");
    }
  }
  return pk;
}

const APP_ID = process.env.GITHUB_APP_ID ? Number(process.env.GITHUB_APP_ID) : undefined;
const APP_PK = resolvePrivateKey();
const DEFAULT_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID
  ? Number(process.env.GITHUB_APP_INSTALLATION_ID)
  : undefined;

const INSTALLATION_MAP: Record<string, number> = (() => {
  try {
    return process.env.GITHUB_APP_INSTALLATION_MAP
      ? JSON.parse(process.env.GITHUB_APP_INSTALLATION_MAP)
      : {};
  } catch {
    console.warn("[platform-mcp] GITHUB_APP_INSTALLATION_MAP is not valid JSON; ignoring.");
    return {};
  }
})();

// App-scoped Octokit (for installation discovery + token minting)
const appOctokit: Octokit | undefined =
  APP_ID && APP_PK
    ? new Octokit({
        baseUrl: GH_BASE_URL,
        authStrategy: createAppAuth,
        auth: { appId: APP_ID, privateKey: APP_PK },
        userAgent: "platform-mcp-github-app/0.1.0",
      })
    : undefined;

// Simple in-memory token cache per installation
type Cached = { token: string; expiresAt: string; octo: Octokit };
const tokenCache = new Map<number, Cached>();

function isExpired(expiresAt: string): boolean {
  // refresh 60s early
  return new Date(expiresAt).getTime() - Date.now() <= 60_000;
}

async function findInstallationIdForOwner(owner: string): Promise<number> {
  // 1) explicit map takes precedence
  if (INSTALLATION_MAP[owner]) return Number(INSTALLATION_MAP[owner]);

  // 2) single default installation (good for single-tenant setups)
  if (DEFAULT_INSTALLATION_ID) return DEFAULT_INSTALLATION_ID;

  if (!appOctokit) {
    throw new Error(
      "[platform-mcp] GitHub App auth not configured (set GITHUB_APP_ID and private key)."
    );
  }

  // 3) Try org → user → list fallbacks
  try {
    const { data } = await appOctokit.rest.apps.getOrgInstallation({ org: owner });
    return data.id;
  } catch {}

  try {
    const { data } = await appOctokit.rest.apps.getUserInstallation({ username: owner });
    return data.id;
  } catch {}

  // As a final fallback, enumerate all installations and match by account.login
  const all = await appOctokit.paginate(appOctokit.rest.apps.listInstallations, { per_page: 100 });
  const match = all.find((i: any) => i?.account?.login?.toLowerCase() === owner.toLowerCase());
  if (match?.id) return match.id;

  throw new Error(
    `[platform-mcp] No installation found for owner "${owner}". ` +
      `Install the App for this org/user, or set GITHUB_APP_INSTALLATION_MAP.`
  );
}

async function mintTokenForInstallation(installationId: number): Promise<Cached> {
  if (!appOctokit) {
    throw new Error("[platform-mcp] GitHub App auth not configured.");
  }
  const { data } = await appOctokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
  });
  const token = data.token;
  const expiresAt = data.expires_at; // ISO string

  const octo = new Octokit({
    baseUrl: GH_BASE_URL,
    auth: token,
    userAgent: "platform-mcp-installation/0.1.0",
  });

  const cached: Cached = { token, expiresAt, octo };
  tokenCache.set(installationId, cached);
  return cached;
}

/**
 * Exported factory expected by @platform/github-core:
 * returns a client provider with getOctoClient(ownerOrOrg)
 *  -> { rest, paginate } ready for GitHub calls
 */
export function makeGitHubClients() {
  const fallbackToken = process.env.GITHUB_FALLBACK_TOKEN;

  return {
    getOctoClient: async (ownerOrOrg: string) => {
      // If App auth is not configured, optionally fall back to PAT
      if (!appOctokit) {
        if (!fallbackToken) {
          throw new Error(
            "[platform-mcp] Neither GitHub App nor GITHUB_FALLBACK_TOKEN are configured."
          );
        }
        const patOcto = new Octokit({
          baseUrl: GH_BASE_URL,
          auth: fallbackToken,
          userAgent: "platform-mcp-fallback-pat/0.1.0",
        });
        return {
          rest: patOcto.rest,
          paginate: patOcto.paginate.bind(patOcto),
        };
      }

      const installationId = await findInstallationIdForOwner(ownerOrOrg);
      const cached = tokenCache.get(installationId);
      if (cached && !isExpired(cached.expiresAt)) {
        return {
          rest: cached.octo.rest,
          paginate: cached.octo.paginate.bind(cached.octo),
        };
      }

      const fresh = await mintTokenForInstallation(installationId);
      return {
        rest: fresh.octo.rest,
        paginate: fresh.octo.paginate.bind(fresh.octo),
      };
    },
  };
}