# Developer MCP (GitHub-hosted catalog)

This MCP lists **approved templates** stored in a GitHub repository, previews a rendered tree, and **mints projects** by creating a GitHub repo and committing the rendered files. Optionally kicks off basic infra via Platform MCP.

- GitHub MCP enforces its own governance on any GitHub actions.
- Azure/Platform MCPs enforce their own governance on infra steps.
- (Optional) Developer MCP can do a light preflight via Governance MCP for `developer.mint_project`.

## Configure

1. Run GitHub MCP and configure it.
2. Set the Developer MCP `.env`:
   - `GITHUB_MCP_URL`, `CATALOG_OWNER`, `CATALOG_REPO`, `CATALOG_REF`, `CATALOG_DIR`.
3. (Optional) `GOVERNANCE_URL` if you want a preflight for `developer.mint_project`.

## Run

```bash
pnpm i
pnpm dev