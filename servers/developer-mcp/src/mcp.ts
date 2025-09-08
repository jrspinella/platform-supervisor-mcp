// MCP utility functions for making calls to MCP servers

export interface CallMcpResult {
  json: any;
  ok: boolean;
  status: number;
}

export async function callMcp(url: string, method: string, args: any): Promise<CallMcpResult> {
  const response = await fetch(`${url}/call`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ method, arguments: args }),
  });

  if (!response.ok) {
    throw new Error(`MCP call failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  return { json, ok: response.ok, status: response.status };
}

export function firstJson(data: any): any {
  // Extract the first JSON object from the response
  // This is a simple implementation - adjust based on MCP protocol
  return data.result || data.response || data || {};
}
