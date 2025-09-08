import "dotenv/config";
import { startMcpHttpServer } from "mcp-http";
import { tools } from "./tools.js";

const PORT = Number(process.env.PORT ?? 8717);
console.log(`[MCP] developer-mcp (GitHub catalog) listening on :${PORT}`);
startMcpHttpServer({ name: "developer-mcp", version: "0.1.0", port: PORT, tools });