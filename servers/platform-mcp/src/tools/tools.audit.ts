// servers/platform-mcp/src/lib/audit.ts
import type { ToolDef } from "mcp-http";

/**
 * Wrap a tool to log calls/results. Non-invasive; passes through untouched.
 */
export function auditToolWrapper(t: ToolDef): ToolDef {
  if (!t.handler) return t;
  const wrapped: ToolDef = {
    ...t,
    handler: async (args: any, ctx?: any) => {
      const started = Date.now();
      try {
        const res = await t.handler!(args);
        const ms = Date.now() - started;
        // Simple console audit; replace with structured logger if desired
        console.log(`[audit] ${t.name} ok in ${ms}ms args=${JSON.stringify(args)}`);
        return res;
      } catch (e) {
        const ms = Date.now() - started;
        console.warn(`[audit] ${t.name} error in ${ms}ms args=${JSON.stringify(args)} err=${(e as any)?.message || e}`);
        throw e;
      }
    },
  };
  return wrapped;
}
