// servers/platform-mcp/src/lib/audit.ts
import type { ToolDef } from "mcp-http";

/**
 * Wrap a tool to log calls/results. Non-invasive; passes through untouched.
 */
// tools.audit.ts (make sure this is what you have)
const AUDIT_ONLY = /^true$/i.test(process.env.PLATFORM_AUDIT_ONLY ?? "");

export function auditToolWrapper(def: ToolDef): ToolDef {
  const orig = def.handler;                      // << use handler
  return {
    ...def,
    handler: async (args: any) => {
      console.info(`[audit] ${def.name} args=${JSON.stringify(args)}`);
      if (AUDIT_ONLY) {
        return { content: [{ type: "text", text: `[audit] ${def.name} ok` }, { type: "json", json: args }] };
      }
      const res = await orig(args);              // ✅ pass-through
      console.info(`[exec] ${def.name} done`);
      return res;
    },
  };
}

