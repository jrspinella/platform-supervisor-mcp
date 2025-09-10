import type { ToolDef } from "mcp-http";
import type { GovernanceFn } from "./types.js";

/**
 * Apply governance preflight if provided. Mirrors your GitHub-core style.
 */
export function withGovernance(td: ToolDef, evaluateGovernance?: GovernanceFn): ToolDef {
  if (!evaluateGovernance) return td;

  const guarded: ToolDef = {
    ...td,
    handler: async (args: any) => {
      try {
        const block = await evaluateGovernance(td.name, args, { via: "azure-core" });
        if (block.decision === "deny") {
          return {
            content: [
              { type: "text", text: `Governance DENY for ${td.name}` },
              { type: "json", json: block }
            ],
            isError: true
          };
        }
        if (block.decision === "warn") {
          // Return the warning plus proceed anyway. Caller can decide to gate elsewhere if needed.
          const res = await td.handler(args);
          return {
            content: [
              { type: "text", text: `Governance WARN for ${td.name}` },
              { type: "json", json: block },
              ...(res?.content ?? [])
            ],
            isError: res?.isError
          };
        }
        // allow
        return await td.handler(args);
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `Governance evaluation failed: ${e?.message || e}` }],
          isError: true
        };
      }
    }
  };
  return guarded;
}

export function withGovernanceAll(tools: ToolDef[], evaluateGovernance?: GovernanceFn): ToolDef[] {
  return tools.map(t => withGovernance(t, evaluateGovernance));
}

/**
 * Tiny wrappers to reduce boilerplate for "create" and "get".
 * These do not implement "hold/pending"; that UX belongs to platform wrappers.
 */
export function wrapCreate(
  name: string,
  description: string,
  inputSchema: any,
  invoke: (a: any) => Promise<any>
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    handler: async (a: any) => {
      try {
        const out = await invoke(a);
        return { content: [{ type: "json", json: out }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ ${name} failed: ${e?.message || e}` }],
          isError: true
        };
      }
    }
  };
}

export function wrapGet(
  name: string,
  description: string,
  inputSchema: any,
  invoke: (a: any) => Promise<any>
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    handler: async (a: any) => {
      try {
        const out = await invoke(a);
        return { content: [{ type: "json", json: out }] };
      } catch (e: any) {
        return {
          content: [{ type: "text", text: `❌ ${name} failed: ${e?.message || e}` }],
          isError: true
        };
      }
    }
  };
}

/** Coerce unknown tags to a flat string->string record */
export function coerceTags(input: any): Record<string, string> | undefined {
  if (!input) return undefined;
  if (typeof input === "object" && !Array.isArray(input)) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      out[String(k)] = String(v);
    }
    return out;
  }
  return undefined;
}