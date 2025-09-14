// GitHub App auth — returns an authenticated Octokit instance (or a tiny adapter if you prefer).

import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import 'dotenv/config';

// Create Octokit using GitHub App credentials from env vars
// Requires GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_INSTALLATION_ID
// (or throws at runtime if missing)

export async function createGithubClientFromEnv() {
  try {
    const appId = process.env.GITHUB_APP_ID as string;
    const privateKey = (process.env.GITHUB_PRIVATE_KEY || '').replaceAll('\\n', '\n');
    const installationId = Number(process.env.GITHUB_INSTALLATION_ID || '0');
    if (!appId || !privateKey || !installationId) throw new Error('Missing GITHUB_APP_ID/GITHUB_PRIVATE_KEY/GITHUB_INSTALLATION_ID');

    const octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey, installationId }
    });
    return octokit; // Pass straight into github-core factories
  } catch (e) {
    // Fallback: throw at runtime with helpful message
    throw new Error(`GitHub client not configured: ${e instanceof Error ? e.message : String(e)}`);
  }
}
