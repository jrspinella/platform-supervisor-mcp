import type { ToolDef } from "mcp-http";
import { makeGithubTools } from "./tools/tools.github.js";
import { makeDevWizardTools } from "./tools/tools.dev.wizard.js";
import { createGithubClientFromEnv } from "./client.github.js";
import { makePlanTools } from "./tools/tools.plan.js";

export async function composeTools(): Promise<ToolDef[]> {
  // GitHub client (App auth)
  const gh = await createGithubClientFromEnv();
  const githubTools = makeGithubTools({ client: gh, namespace: "mission." });

  // Resolver so wizard can call sibling tools by name
  const resolver = (name: string) => [...githubTools].find(t => t.name === name);

  const wizardTools = makeDevWizardTools({ resolveTool: resolver });
  const plan = makePlanTools(resolver);
  return [...githubTools, ...wizardTools, ...plan];
}
