// apps/platform-mcp/src/index.ts
import "dotenv/config";
import { startMcpHttpServer, type ToolDef } from "mcp-http";
import { tool_platform_create_kv, tool_platform_create_law, tool_platform_create_plan, tool_platform_create_private_endpoint, tool_platform_create_repo_from_template, tool_platform_create_rg, tool_platform_create_static_web_app, tool_platform_create_storage, tool_platform_create_subnet, tool_platform_create_vnet, tool_platform_create_web, tool_platform_create_web_id, tool_platform_create_web_settings, tool_platform_link_static_webapp_repo, tool_platform_onboarding_execute_task } from "./tools.js";

// ---------- Config ----------
const PORT = Number(process.env.PORT ?? 8716);
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";
const GOVERNANCE_URL = process.env.GOVERNANCE_URL || "http://127.0.0.1:8715";

// ---------- Helpers ----------

function buildSwaArmTemplate() {
    // Minimal ARM template for Microsoft.Web/staticSites
    return {
        $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
        contentVersion: "1.0.0.0",
        parameters: {
            name: { type: "string" },
            location: { type: "string" },
            sku: { type: "string", defaultValue: "Free" },
            appLocation: { type: "string", defaultValue: "/" },
            outputLocation: { type: "string", defaultValue: "dist" },
            tags: { type: "object", defaultValue: {} }
        },
        resources: [
            {
                type: "Microsoft.Web/staticSites",
                apiVersion: "2022-03-01",
                name: "[parameters('name')]",
                location: "[parameters('location')]",
                sku: { name: "[parameters('sku')]" },
                tags: "[parameters('tags')]",
                properties: {
                    buildProperties: {
                        appLocation: "[parameters('appLocation')]",
                        outputLocation: "[parameters('outputLocation')]"
                    }
                }
            }
        ]
    };
}

function buildSwaWorkflowYml(p: {
    branch: string;
    appLocation: string;
    outputLocation: string;
}) {
    // Minimal, expects a pre-built site in outputLocation (skip app build).
    // Adjust to your build system as needed.
    return `name: Azure Static Web Apps CI/CD

on:
  push:
    branches: [ ${p.branch} ]
  pull_request:
    types: [opened, synchronize, reopened, closed]
    branches: [ ${p.branch} ]

jobs:
  build_and_deploy:
    if: github.event_name == 'push' || (github.event_name == 'pull_request' && github.event.action != 'closed')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        uses: Azure/static-web-apps-deploy@v1
        with:
          repo_token: \${{ secrets.GITHUB_TOKEN }}
          azure_static_web_apps_api_token: \${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN }}
          action: "upload"
          app_location: "${p.appLocation}"
          output_location: "${p.outputLocation}"
          skip_app_build: true

  close_pull_request_job:
    if: github.event_name == 'pull_request' && github.event.action == 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: Azure/static-web-apps-deploy@v1
        with:
          action: "close"
          azure_static_web_apps_api_token: \${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN }}
`;
}

// ---------- Tool: platform.package_app_service ----------
const platformEnsureTools = [
    tool_platform_create_rg,
    tool_platform_create_plan,
    tool_platform_create_web,
    tool_platform_create_web_id,
    tool_platform_create_web_settings,
    tool_platform_create_kv,
    tool_platform_create_storage,
    tool_platform_create_law,
    tool_platform_create_repo_from_template,
    tool_platform_create_static_web_app,
    tool_platform_link_static_webapp_repo,
    tool_platform_create_vnet,
    tool_platform_create_subnet,
    tool_platform_create_private_endpoint,
];

const platformOnboardingTools = [
    tool_platform_onboarding_execute_task,
];

// If you already have other tools:
const tools: ToolDef[] = [
    // ...your existing tools,
    ...platformEnsureTools,
    ...platformOnboardingTools,
].filter(tool => tool) as ToolDef[];

// ---------- Boot ----------
console.log(`[MCP] platform-mcp listening on :${PORT} (router=${ROUTER_URL}, governance=${GOVERNANCE_URL})`);
startMcpHttpServer({ name: "platform-mcp", version: "0.1.0", port: PORT, tools });
