// servers/platform-mcp/src/tools.advisor.ts
import { z } from 'zod';
import type { ToolDef } from 'mcp-http';
import { isAdvisorConfigured, maybeAdvise, briefResult } from '../lib/advisor.js';

export function makeAdvisorTools(): ToolDef[] {
  const summarize: ToolDef = {
    name: 'platform.advisor_summarize',
    description: 'Summarize an arbitrary tool result (or any JSON) into concise next actions using Azure OpenAI.',
    inputSchema: z.object({
      title: z.string().optional(),
      tool: z.string().optional(),
      args: z.any().optional(),
      result: z.any(),
    }).strict(),
    handler: async (a: any) => {
      if (!isAdvisorConfigured()) {
        return { content: [{ type: 'text', text: 'Advisor is not configured (set AZURE_OPENAI_* env vars).'}], isError: true };
      }
      const advice = await maybeAdvise(a.tool || a.title || 'context', a.args || {}, { content: [{ type: 'json', json: a.result }], isError: false });
      if (!advice) return { content: [{ type: 'text', text: 'Advisor is unavailable right now.' }], isError: true };
      return { content: [ { type: 'text', text: `🧭 Advisor\n${advice}` } ] };
    }
  };
  return [summarize];
}
