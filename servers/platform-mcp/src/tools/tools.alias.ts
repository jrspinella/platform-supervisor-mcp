// servers/platform-mcp/src/tools/tools.alias.ts
import type { ToolDef } from "mcp-http";

function cloneToolWithName(t: ToolDef, name: string): ToolDef {
  // Shallow-clone everything but wrap handler to preserve `this` if used
  return {
    ...t,
    name,
    // keep same inputSchema/description/etc.
    handler: async (args: any) => t.handler!(args),
  };
}

/**
 * Create alias copies of tools by rewriting a prefix (e.g. azure.* -> platform.*).
 * fromPrefixes can include multiple options; first match wins.
 */
export function autoPlatformAliases(
  tools: ToolDef[],
  fromPrefixes: string[] = ["azure."],
  toPrefix = "platform."
): ToolDef[] {
  const aliases: ToolDef[] = [];

  for (const t of tools) {
    const match = fromPrefixes.find((p) => t.name.startsWith(p));
    if (!match) continue;

    const rest = t.name.slice(match.length); // e.g. "scan_webapp_baseline"
    const aliasedName = `${toPrefix}${rest}`;

    // Avoid duplicates if platform.* already exists
    if (tools.some((x) => x.name === aliasedName)) continue;

    aliases.push(cloneToolWithName(t, aliasedName));
  }

  return aliases;
}
