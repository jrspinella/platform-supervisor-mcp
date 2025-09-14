// router/parseTags.ts
export function parseTags(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = String(input ?? "").trim();

  // Canonicalize common synonyms
  const canon = (k: string) =>
    ({
      environment: "env",
      env: "env",
      owner: "owner",
      application: "app",
      app: "app",
      project: "project",
    }[k] || k);

  // Focus on the portion after "tags"/"tag"
  const head = /(?:^|\b)tags?\b[:=\-\s]*/i.exec(text);
  let scope = head ? text.slice(head.index + head[0].length) : text;

  // Stop at next step indicator ("then"/"and") so multi-step prompts don't leak in
  scope = scope.split(/\b(?:then|and)\b/i)[0];

  // Pair regex: key (=|:|is) value  with support for straight/curly quotes
  const pairRe =
    /\b([a-z][\w.-]*)\s*(?:=|:|：|\bis\b)\s*(?:"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’|([^\s,;{}]+))/gi;

  pairRe.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = pairRe.exec(scope)); ) {
    const key = canon(m[1].toLowerCase());
    if (key === "tags") continue;
    const val = (m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? "").replace(/[.,;]$/g, "");
    if (key && val) out[key] = val;
  }

  if (Object.keys(out).length === 0) {
    // Fallback: braces block { owner:..., env:... }
    const brace = scope.match(/\{([\s\S]*?)\}/);
    if (brace) {
      const body = brace[1];
      pairRe.lastIndex = 0;
      for (let mb: RegExpExecArray | null; (mb = pairRe.exec(body)); ) {
        const key = canon(mb[1].toLowerCase());
        const val = (mb[2] ?? mb[3] ?? mb[4] ?? mb[5] ?? mb[6] ?? "").replace(/[.,;]$/g, "");
        if (key && val) out[key] = val;
      }
      if (Object.keys(out).length === 0) {
        try {
          const jsonish =
            "{" +
            body
              .replace(/([,{]\s*)([A-Za-z_][\w.-]*)\s*:/g, '$1"$2":')
              .replace(/:\s*'([^']*)'/g, ':"$1"')
              .replace(/:\s*“([^”]*)”/g, ':"$1"') +
            "}";
          const obj = JSON.parse(jsonish);
          for (const [k, v] of Object.entries(obj)) out[canon(k.toLowerCase())] = String(v);
        } catch { /* ignore */ }
      }
    }
  }

  return out;
}

export function sanitizeRgName(input?: string): string | undefined {
  const s = (input || "").trim().toLowerCase();
  if (!s) return undefined;

  // If someone accidentally captured the literal word "named", ignore it.
  if (s === "named") return undefined;

  // Already valid
  if (/^rg-[a-z0-9-]{3,40}$/.test(s)) return s;

  // Extract first rg-* token from the string (if any)
  const m = s.match(/\brg-[a-z0-9-]+\b/);
  if (m) {
    const token = m[0];
    // Enforce the 3–40 limit on the part after "rg-"
    const suffix = token.slice(3).replace(/[^a-z0-9-]/g, "").slice(0, 40);
    if (suffix.length >= 3) return `rg-${suffix}`;
  }

  // No safe name; let governance suggest one instead of fabricating
  return undefined;
}