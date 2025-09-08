import "dotenv/config";
import { startMcpHttpServer, type ToolDef } from "mcp-http";
import { tools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 8712);

console.log(`[MCP] github-mcp listening on :${PORT}`);
startMcpHttpServer({
  name: "github-mcp",
  version: "0.1.0",
  port: PORT,
  tools: tools as ToolDef[],
});