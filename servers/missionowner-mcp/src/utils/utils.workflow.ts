// servers/developer-mcp/src/utils/workflows.ts
export function oidcNodeWorkflowYml(opts: {
  envName?: string;
  subscriptionId?: string;
  tenantId?: string;
  clientId?: string; // if using federated credential
  nodeVersion?: string;
}): string {
  const envName = opts.envName || "dev";
  const node = opts.nodeVersion || "20.x";
  // The azure/login action can use OIDC with federated credentials + secrets for sub/tenant/client.
  return `name: ci

on:
  push:
    branches: [ main ]
  pull_request:

permissions:
  id-token: write
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    environment: ${envName}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '${node}'
      - run: npm ci
      - run: npm test --if-present
      - name: Azure Login (OIDC)
        uses: azure/login@v2
        with:
          client-id: \${{ secrets.AZURE_CLIENT_ID }}
          tenant-id: \${{ secrets.AZURE_TENANT_ID }}
          subscription-id: \${{ secrets.AZURE_SUBSCRIPTION_ID }}
      - run: echo "logged in"
`;
}