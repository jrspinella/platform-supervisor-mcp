import type { ToolDef } from 'mcp-http';
import { appendFile } from 'fs/promises';

export function auditToolWrapper(toolDef: ToolDef): ToolDef {
  const originalHandler = toolDef.handler;

  return {
    ...toolDef,
    handler: async (args: any) => {
      const startTime = Date.now();
      const toolName = toolDef.name;
      const timestamp = new Date().toISOString();

      try {
        const result = await originalHandler(args);
        const duration = Date.now() - startTime;

        // Log successful execution
        const logEntry = JSON.stringify({
          timestamp,
          toolName,
          args: JSON.stringify(args),
          duration,
          result: result.content,
          isError: result.isError || false
        }) + '\n';

        const today = new Date().toISOString().split('T')[0];
        await appendFile(`./audit/${today}.jsonl`, logEntry);

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;

        // Log error
        const logEntry = JSON.stringify({
          timestamp,
          toolName,
          args: JSON.stringify(args),
          duration,
          error: error instanceof Error ? error.message : String(error),
          isError: true
        }) + '\n';

        const today = new Date().toISOString().split('T')[0];
        await appendFile(`./audit/${today}.jsonl`, logEntry);

        throw error;
      }
    }
  };
}

export async function writeAudit(auditData: {
  ts: number;
  type: string;
  name: string;
  args: any;
  result: any;
  isError: boolean;
  ms?: number;
}): Promise<void> {
  const logEntry = JSON.stringify({
    timestamp: new Date(auditData.ts).toISOString(),
    type: auditData.type,
    name: auditData.name,
    args: JSON.stringify(auditData.args),
    ms: auditData.ms || 0,
    result: auditData.result,
    isError: auditData.isError
  }) + '\n';

  const today = new Date().toISOString().split('T')[0];
  await appendFile(`./audit/${today}.jsonl`, logEntry);
}
