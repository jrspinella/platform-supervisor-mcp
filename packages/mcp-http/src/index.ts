import * as express from "express";
import type { JSONRPCRequest, JSONRPCResponse, ToolHandler } from "./types.js";
import { toJSONSchema } from "./zodJson.js";


export interface ToolDef {
    name: string; // e.g., "github.create_issue"
    description: string;
    inputSchema: any; // zod schema
    handler: ToolHandler;
}


interface Options {
    name: string;
    version: string;
    port: number;
    tools: ToolDef[];
}


export function startMcpHttpServer(opts: Options) {
    const app = (express as unknown as () => express.Express)();
    app.use(express.json({ limit: "1mb" }));

    app.get("/healthz", (_: any, res: any) => res.status(204).send());

    app.post("/mcp", async (req: any, res: any) => {
        const body = req.body as JSONRPCRequest;
        const reply: JSONRPCResponse = { jsonrpc: "2.0", id: body.id ?? null };

        try {
            switch (body.method) {
                case "initialize": {
                    reply.result = {
                        protocolVersion: "2024-11-05",
                        serverInfo: { name: opts.name, version: opts.version },
                        capabilities: { tools: { listChanged: false } }
                    };
                    break;
                }
                case "tools/list": {
                    reply.result = {
                        tools: opts.tools.map(t => ({
                            name: t.name,
                            description: t.description,
                            inputSchema: toJSONSchema(t.inputSchema)
                        }))
                    };
                    break;
                }
                case "tools/call": {
                    const { name, arguments: args } = body.params ?? {};
                    const tool = opts.tools.find(t => t.name === name);
                    if (!tool) throw new Error(`Unknown tool: ${name}`);
                    const parsed = tool.inputSchema.safeParse(args ?? {});
                    if (!parsed.success) {
                        reply.result = {
                            content: [{ type: "text", text: `Validation error: ${parsed.error.message}` }],
                            isError: true
                        };
                        break;
                    }
                    const out = await tool.handler(parsed.data);
                    reply.result = out;
                    break;
                }
                default:
                    reply.error = { code: -32601, message: `Method not found: ${body.method}` };
            }
        } catch (err: any) {
            reply.error = { code: -32000, message: err?.message ?? "Server error" };
        }


        res.json(reply);
    });


    app.listen(opts.port, () => {
        console.log(`[MCP] ${opts.name}@${opts.version} listening on :${opts.port}`);
    });
}
