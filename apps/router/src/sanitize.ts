// Mask Azure subscription/tenant GUIDs in strings and deep JSON payloads.

export function maskAzureIdsInString(s: string): string {
  if (typeof s !== "string") return s as unknown as string;

  const GUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
  const keepTail = (guid: string) =>
    `***-****-****-****-********${guid.slice(-4)}`;

  // Resource IDs (/subscriptions/<guid>, /tenants/<guid>)
  s = s.replace(/(\/subscriptions\/)([0-9a-fA-F\-]{36})/gi, (_m, p1, g) => `${p1}${keepTail(g)}`);
  s = s.replace(/(\/tenants\/)([0-9a-fA-F\-]{36})/gi, (_m, p1, g) => `${p1}${keepTail(g)}`);

  // JSON style keys: "subscriptionId": "…", "tenantId": "…"
  s = s.replace(/("subscriptionId"\s*:\s*")([0-9a-fA-F\-]{36})(")/gi, (_m, p1, g, p3) => `${p1}${keepTail(g)}${p3}`);
  s = s.replace(/("tenantId"\s*:\s*")([0-9a-fA-F\-]{36})(")/gi, (_m, p1, g, p3) => `${p1}${keepTail(g)}${p3}`);

  // Also mask any standalone GUIDs (last resort)
  s = s.replace(GUID, (g) => keepTail(g));
  return s;
}

export function deepSanitize<T = any>(val: T): T {
  if (val == null) return val;
  if (typeof val === "string") return maskAzureIdsInString(val) as unknown as T;
  if (Array.isArray(val)) return val.map(v => deepSanitize(v)) as unknown as T;
  if (typeof val === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(val as any)) {
      out[k] = deepSanitize(v);
    }
    return out;
  }
  return val;
}