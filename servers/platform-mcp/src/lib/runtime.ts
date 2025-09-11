export type McpContent =
  | { type: "text"; text: string }
  | { type: "json"; json: any };

export const mcpText = (text: string): McpContent[] => [{ type: "text", text }];
export const mcpJson  = (json: any): McpContent[] => [{ type: "json", json }];
