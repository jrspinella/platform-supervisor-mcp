// servers/platform-mcp/src/tools.policy.ts
import { z } from "zod";
import type { ToolDef } from "mcp-http";
import * as fs from "fs/promises";
import * as path from "path";
import YAML from "yaml";

/** Minimal deep merge for policy objects */
function deepMerge<T extends Record<string, any>>(...objs: T[]): T {
  const out: any = {};
  for (const o of objs) {
    for (const [k, v] of Object.entries(o || {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = deepMerge(out[k] || {}, v as any);
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

/** Load & merge multiple YAML files when the core lib doesn't offer a helper */
async function loadYamlFiles(files: string[]): Promise<any> {
  const docs = await Promise.all(
    files.map(async (p) => {
      const txt = await fs.readFile(p, "utf8");
      // Support multi-doc YAML too
      const parsed = YAML.parseAllDocuments(txt).map((d) => d.toJSON());
      return deepMerge(...parsed);
    })
  );
  return deepMerge(...docs);
}

export function makePolicyTools(): ToolDef[] {
  const policy_dump: ToolDef = {
    name: "platform.policy_dump",
    description: "Dump the merged governance + ATO policy document currently loaded.",
    inputSchema: z.object({}).strict(),
    handler: async () => {
      const gc = await import("@platform/governance-core");

      // Ensure policy in memory (new name) or fall back (old)
      if (typeof (gc as any).ensurePolicyLoaded === "function") {
        await (gc as any).ensurePolicyLoaded();
      } else if (typeof (gc as any).ensureLoaded === "function") {
        await (gc as any).ensureLoaded();
      }
      if (typeof (gc as any).ensureAtoLoaded === "function") {
        await (gc as any).ensureAtoLoaded();
      }

      const doc =
        typeof (gc as any).getMergedPolicy === "function"
          ? (gc as any).getMergedPolicy()
          : (gc as any).loadedPolicy ?? {};

      const warnings =
        typeof (gc as any).getPolicyValidationWarnings === "function"
          ? (gc as any).getPolicyValidationWarnings()
          : (gc as any).getValidationWarnings?.() ?? [];

      const content: ({ type: "text"; text: string } | { type: "json"; json: any })[] = [
        { type: "json", json: doc },
      ];
      if (warnings.length) content.push({ type: "text", text: warnings.join("\n") });
      return { content };
    },
  };

  const policy_reload: ToolDef = {
    name: "platform.policy_reload",
    description: "Reload governance/ATO policy from a directory or explicit YAML files.",
    inputSchema: z
      .object({
        dir: z.string().optional(),
        files: z.array(z.string()).optional(),
      })
      .strict(),
    handler: async (a: any) => {
      try {
        const gc = await import("@platform/governance-core");
        let doc: any | undefined;

        if (a.files?.length) {
          // Prefer official helper if present (old API name)
          if (typeof (gc as any).loadPoliciesFromYaml === "function") {
            doc = (gc as any).loadPoliciesFromYaml(a.files);
          } else {
            // Manual merge of YAML files
            doc = await loadYamlFiles(a.files.map((f: string) => path.resolve(f)));
          }
        } else if (a.dir) {
          // Prefer new API name if present
          if (typeof (gc as any).loadPolicyFromDir === "function") {
            doc = (gc as any).loadPolicyFromDir(a.dir);
          } else if (typeof (gc as any).loadPoliciesFromDir === "function") {
            // Older API (plural)
            doc = (gc as any).loadPoliciesFromDir(a.dir);
          } else {
            // As a last resort, glob *.ya?ml in dir and load them
            const dir = path.resolve(a.dir);
            const entries = await fs.readdir(dir);
            const files = entries
              .filter((n) => /\.ya?ml$/i.test(n))
              .map((n) => path.join(dir, n));
            doc = await loadYamlFiles(files);
          }
        } else {
          // No args: ensure current policy is in memory and return it
          if (typeof (gc as any).ensurePolicyLoaded === "function") {
            await (gc as any).ensurePolicyLoaded();
          } else if (typeof (gc as any).ensureLoaded === "function") {
            await (gc as any).ensureLoaded();
          }
          doc =
            typeof (gc as any).getMergedPolicy === "function"
              ? (gc as any).getMergedPolicy()
              : (gc as any).loadedPolicy ?? {};
        }

        // Register into singleton
        if (doc) {
          if (typeof (gc as any).registerPolicy === "function") {
            (gc as any).registerPolicy(doc);
          } else if (typeof (gc as any).registerPolicies === "function") {
            (gc as any).registerPolicies(doc);
          }
        }

        const warnings =
          typeof (gc as any).getPolicyValidationWarnings === "function"
            ? (gc as any).getPolicyValidationWarnings()
            : (gc as any).getValidationWarnings?.() ?? [];

        const merged =
          typeof (gc as any).getMergedPolicy === "function"
            ? (gc as any).getMergedPolicy()
            : doc ?? {};

        return {
          content: [
            {
              type: "json",
              json: {
                status: "done",
                source: a.dir || a.files || "<env-default>",
                warnings,
                policy: merged,
              },
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            { type: "json", json: { status: "error", error: { message: e?.message || String(e) } } },
            { type: "text", text: e?.message || String(e) },
          ],
          isError: true,
        };
      }
    },
  };

  return [policy_dump, policy_reload];
}
