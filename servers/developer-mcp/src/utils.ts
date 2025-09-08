import path from "node:path";
import fs from "node:fs";

export const mcpJson = (json: any) => [{ type: "json" as const, json }];
export const mcpText = (text: string) => [{ type: "text" as const, text }];

export function listFilesRecursive(root: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

export function rel(from: string, full: string) {
  return path.relative(from, full).replaceAll(path.sep, "/");
}

export function safeParseJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

export function toKeyVals(obj?: Record<string, string>) {
  if (!obj) return "";
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join(", ");
}