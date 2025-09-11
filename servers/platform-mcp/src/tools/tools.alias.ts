// servers/platform-mcp/src/tools.alias.ts
import type { ToolDef } from 'mcp-http';

/** Create alias tools that forward to target tools by name. */
export function aliasTools(all: ToolDef[], map: Record<string, string>): ToolDef[] {
  const index = new Map<string, ToolDef>(all.map(t => [t.name, t]));
  const out: ToolDef[] = [];
  for (const [alias, target] of Object.entries(map)) {
    const t = index.get(target);
    if (!t) continue; // ignore unknown targets
    out.push({
      name: alias,
      description: `(alias) → ${target}: ${t.description}`,
      inputSchema: t.inputSchema,
      handler: (args: any) => t.handler(args),
    });
  }
  return out;
}

/**
 * Auto-generate platform.* aliases for any tool whose name starts with one of the
 * provided prefixes (e.g., "azure.", "github."). The alias is built as
 * `platform.<suffix>` where `<suffix>` is the substring after the first dot.
 * Skips collisions when a tool named `platform.<suffix>` already exists.
 */
export function autoPlatformAliases(
  all: ToolDef[],
  prefixes: string[] = ['azure.', 'github.'],
  platformPrefix = 'platform.'
): ToolDef[] {
  const names = new Set(all.map(t => t.name));
  const out: ToolDef[] = [];

  for (const t of all) {
    const p = prefixes.find(pr => t.name.startsWith(pr));
    if (!p) continue;
    const dot = t.name.indexOf('.');
    if (dot < 0 || dot === t.name.length - 1) continue; // no suffix

    const suffix = t.name.slice(dot + 1);
    const alias = platformPrefix + suffix;
    if (names.has(alias)) continue; // do not override existing platform.*

    out.push({
      name: alias,
      description: `(alias) → ${t.name}: ${t.description}`,
      inputSchema: t.inputSchema,
      handler: (args: any) => t.handler(args),
    });
  }

  return out;
}
