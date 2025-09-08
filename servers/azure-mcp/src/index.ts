// servers/azure-mcp/src/index.ts
import "dotenv/config";
import { startMcpHttpServer } from "mcp-http";
import { tools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 8711);

console.log(`[MCP] azure-mcp listening on :${PORT} | governance=${process.env.GOVERNANCE_URL || "http://127.0.0.1:8715/mcp"}`);
startMcpHttpServer({ name: "azure-mcp", version: "0.1.0", port: PORT, tools });