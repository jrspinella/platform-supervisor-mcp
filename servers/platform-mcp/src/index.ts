// servers/platform-mcp/src/index.ts (advisor-enabled)
import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import { composeTools } from './compose.js';
import { maybeAdvise } from './lib/advisor.js';
import { writeAudit } from './lib/audit.js';

const logger = pino({ name: 'platform-mcp' });
const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 8721);

// Compose tool catalog
const tools = await composeTools();
const toolMap = new Map<string, any>(tools.map(t => [t.name, t]));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/tools', (_req, res) => {
  res.json({ count: tools.length, tools: tools.map(t => ({ name: t.name, description: t.description })) });
});

// JSON-RPC 2.0 handler (subset): tools.list, tools.call
app.post('/rpc', async (req, res) => {
  const { id, method, params } = req.body || {};
  try {
    if (method === 'tools.list') {
      const result = tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema?.toString?.() }));
      return res.json({ jsonrpc: '2.0', id, result });
    }

    if (method === 'tools.call') {
      const name = params?.name as string;
      const args = params?.args ?? {};
      const t = toolMap.get(name);
      if (!t) {
        const error = { code: -32601, message: `Unknown tool: ${name}` };
        await writeAudit({ ts: Date.now(), type: 'call', name, args, result: { error }, isError: true });
        return res.json({ jsonrpc: '2.0', id, error });
      }

      // Zod validation if present
      if (t.inputSchema?.safeParse) {
        const r = t.inputSchema.safeParse(args);
        if (!r.success) {
          const error = { code: -32602, message: 'Invalid params', data: r.error.flatten() };
          await writeAudit({ ts: Date.now(), type: 'call', name, args, result: { error }, isError: true });
          return res.json({ jsonrpc: '2.0', id, error });
        }
      }

      const started = Date.now();
      let result: any; let isError = false;
      try {
        result = await t.handler(args);
        isError = !!result?.isError;
      } catch (e: any) {
        isError = true;
        result = { content: [{ type: 'json', json: { status: 'error', message: e?.message || String(e) } }], isError: true };
      }

      // Advisor (AOAI): append natural-language next steps
      try {
        const advice = await maybeAdvise(name, args, result);
        if (advice) {
          const block = { type: 'text', text: `🧭 Advisor\n${advice}` } as const;
          const content = Array.isArray(result?.content) ? result.content : [];
          result = { ...result, content: [...content, block] };
        }
      } catch {}

      await writeAudit({ ts: Date.now(), type: 'call', name, args, ms: Date.now() - started, result, isError });
      return res.json({ jsonrpc: '2.0', id, result });
    }

    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
  } catch (e: any) {
    logger.error(e, 'RPC failure');
    return res.status(500).json({ jsonrpc: '2.0', id, error: { code: -32000, message: e?.message || String(e) } });
  }
});

app.listen(PORT, () => {
  logger.info({ port: PORT, tools: tools.length }, 'platform-mcp listening');
});
