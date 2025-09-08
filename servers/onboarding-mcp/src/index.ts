import "dotenv/config";
import { startMcpHttpServer, type ToolDef } from "mcp-http";
import { tools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 8714);
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";

console.log(`[MCP] onboarding-mcp listening on :${PORT} (router=${ROUTER_URL})`);
startMcpHttpServer({
  name: "onboarding-mcp",
  version: "0.2.0",
  port: PORT,
  tools: tools as ToolDef[]
});
