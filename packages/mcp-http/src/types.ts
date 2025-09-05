export type JSONRPCId = string | number | null;
export interface JSONRPCRequest {
jsonrpc: "2.0";
id: JSONRPCId;
method: string;
params?: any;
}
export interface JSONRPCResponse {
jsonrpc: "2.0";
id: JSONRPCId;
result?: any;
error?: { code: number; message: string; data?: any };
}


export type ToolHandler = (args: any) => Promise<{
content: Array<
| { type: "text"; text: string }
| { type: "json"; json: any }
>;
isError?: boolean;
}>;