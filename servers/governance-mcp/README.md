# Governance MCP Rules

This folder holds hard-gate policies (`policy.yaml`) and ATO advisories (`ato.yaml`) for all service MCPs.

## Configure

Set an absolute path to this folder:

```bash
export GOVERNANCE_RULES_DIR="/abs/path/to/repo/governance"
pnpm -C servers/governance-mcp dev