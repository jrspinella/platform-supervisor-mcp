import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { TemplateSchema, type TemplateDef } from "./schema.js";

export type LoadedTemplate = {
  id: string;
  file: string;
  yaml: string;
  def: TemplateDef;
};

export async function loadTemplatesFromDir(dir: string): Promise<LoadedTemplate[]> {
  const files = await listYamlFiles(dir);
  const out: LoadedTemplate[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    const txt = await fs.readFile(full, "utf8");
    const doc = yaml.load(txt);
    const def = TemplateSchema.parse(doc);
    out.push({ id: def.id, file: full, yaml: txt, def });
  }
  // ensure unique IDs
  const ids = new Set<string>();
  for (const t of out) {
    if (ids.has(t.id)) throw new Error(`Duplicate template id: ${t.id}`);
    ids.add(t.id);
  }
  return out;
}

async function listYamlFiles(dir: string): Promise<string[]> {
  let entries: any[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((n) => /\.ya?ml$/i.test(n))
    .sort();
}