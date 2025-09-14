import type { ToolDef } from "mcp-http";

export function auditToolWrapper(t: ToolDef): ToolDef {
  return {
    ...t,
    handler: async (args: any) => {
      const start = Date.now();
      const name = t.name;
      try {
        // light console audit
        console.log(`[missionowner-mcp] → ${name}`, JSON.stringify(args));
        const res = await t.handler(args);
        const ms = Date.now() - start;
        console.log(`[missionowner-mcp] ← ${name} (${ms}ms) ${res?.isError ? "ERROR" : "OK"}`);
        return res;
      } catch (e) {
        const ms = Date.now() - start;
        console.error(`[missionowner-mcp] ← ${name} (${ms}ms) THROW`, e);
        throw e;
      }
    }
  };
}