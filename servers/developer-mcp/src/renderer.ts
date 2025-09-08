// Super-light handlebars-ish renderer: replaces {{key}} with values[key]
export function renderString(tpl: string, values: Record<string, any>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = key.split(".").reduce((o: any, k: string) => (o ? o[k] : undefined), values);
    return v == null ? "" : String(v);
  });
}

export type RenderedFile = { path: string; content: string };

export function renderFiles(files: Array<{ path: string; content: string }>, values: Record<string, any>): RenderedFile[] {
  return files.map(f => ({
    path: renderString(f.path, values).replace(/\.hbs$/i, ""),
    content: renderString(f.content, values)
  }));
}