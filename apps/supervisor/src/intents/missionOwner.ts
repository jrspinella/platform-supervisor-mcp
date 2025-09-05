export type MissionOwnerIntent = {
  playbookId: "mission-owner";
  user: { upn?: string; alias?: string; displayName?: string; region?: string };
};

export function parseMissionOwnerIntent(text: string): MissionOwnerIntent | null {
  const lower = text.toLowerCase();
  if (!/mission[- ]owner/.test(lower) || !/(onboard|on-?board)/.test(lower)) return null;

  const upnMatch = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  const aliasMatch = text.match(/alias\s+([A-Za-z0-9._-]+)/i);
  const regionMatch = text.match(/region\s+([A-Za-z0-9-]+)/i);
  const nameMatch = text.match(/(?:i am|i'm|name is)\s+([A-Z][A-Za-z]+\s+[A-Z][A-Za-z]+)/i);

  const upn = upnMatch?.[0];
  const alias = aliasMatch?.[1] || (upn ? upn.split("@")[0] : undefined);
  const displayName = nameMatch?.[1];
  const region = regionMatch?.[1] || "usgovvirginia";

  return { playbookId: "mission-owner", user: { upn, alias, displayName, region } };
}
