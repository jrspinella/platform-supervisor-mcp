# Platform Supervisor Chat (VS Code)

A tiny VS Code extension that adds an **@platform.supervisor** Copilot Chat participant.  
It routes your prompt to the **Router MCP** (`nl.route`) and calls the **Platform MCP** (`tools.call`), then renders the results. When findings are present, it offers a **Plan Remediation** button.

## Setup

1. Ensure your local services are running:
   - Router MCP at `http://127.0.0.1:8700/rpc`
   - Platform MCP at `http://127.0.0.1:8721/rpc`

2. Install deps & watch build:
   ```bash
   npm i
   npm run watch