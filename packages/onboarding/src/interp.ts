/**
 * Very small {{var}} interpolator for strings/objects/arrays.
 * - Replaces {{key}} with inputs[key] (stringified for strings).
 * - Leaves non-string values as-is when the source is object/array.
 * - For "when": interpolate to string, then truthy if non-empty and not "false"/"0".
 */

export function interpolateString(s: string, inputs: Record<string, any>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, k) => {
    const v = inputs[k];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

export function interpolateValue(v: any, inputs: Record<string, any>): any {
  if (typeof v === "string") return interpolateString(v, inputs);
  if (Array.isArray(v)) return v.map((x) => interpolateValue(x, inputs));
  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = interpolateValue(val, inputs);
    }
    return out;
  }
  return v;
}

export function evalWhen(when: string | undefined, inputs: Record<string, any>): boolean {
  if (!when) return true;
  const s = interpolateString(when, inputs).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (lower === "false" || lower === "0" || lower === "no" || lower === "null" || lower === "undefined") {
    return false;
  }
  return true;
}