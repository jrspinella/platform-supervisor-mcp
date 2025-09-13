// servers/platform-mcp/src/tools.policy.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";

export function makePolicyTools(): ToolDef[] {
  const policy_dump: ToolDef = {
    name: "platform.policy_dump",
    description: "Dump the merged governance + ATO policy document currently loaded.",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const gc = await import("@platform/governance-core");
      const doc = gc.ensureLoaded();
      const warnings = gc.getValidationWarnings?.() ?? [];
      return { content: [{ type: "json", json: doc }, ...(warnings.length ? [{ type: "text" as const, text: warnings.join("\n") }] : [])] };
    }
  };

  const policy_reload: ToolDef = {
    name: "platform.policy_reload",
    description: "Reload governance/ATO policy from a directory or explicit YAML files.",
    inputSchema: z.object({
      dir: z.string().optional(),
      files: z.array(z.string()).optional(),
    }).strict(),
    handler: async (a: any) => {
      try {
        const gc = await import("@platform/governance-core");
        let doc: any;
        if (a.files?.length) doc = gc.loadPoliciesFromYaml(a.files);
        else if (a.dir) doc = gc.loadPoliciesFromDir(a.dir);
        else doc = gc.ensureLoaded();
        gc.registerPolicies(doc);
        const warnings = gc.getValidationWarnings?.() ?? [];
        return { content: [{ type: "json", json: { status: "done", source: a.dir || a.files || "<env-default>", warnings } }] };
      } catch (e: any) {
        return { content: [{ type: "json", json: { status: "error", error: { message: e?.message || String(e) } } }, { type: "text", text: e?.message || String(e) }], isError: true };
      }
    }
  };

  return [policy_dump, policy_reload];
}