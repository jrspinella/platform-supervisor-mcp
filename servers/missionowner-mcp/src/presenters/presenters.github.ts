function okText(title: string, lines: string[]) { return { type: "text" as const, text: ["### " + title, "", ...lines].join("\n") }; }
function presentRepo(repo: any) {
  const url = repo?.html_url || "";
  const lines = [
    "**GitHub Repository**", "",
    `| Name | Visibility | Default Branch |`,
    `|---|---|---|`,
    `| \`${repo?.full_name}\` | \`${repo?.visibility}\` | \`${repo?.default_branch}\` |`,
    "", url ? `[Open on GitHub](${url})` : "",
  ];
  return [okText("GitHub — Repository Created", lines), { type: "json" as const, json: repo }];
}
function presentEnv(env: any, repoFullName?: string) {
  const reviewers = env?.reviewers?.map((r: any) => r?.type + ":" + (r?.reviewer?.login || r?.reviewer?.slug)).join(", ") || "—";
  const url = repoFullName ? `https://github.com/${repoFullName}/settings/environments/${encodeURIComponent(env?.name)}` : "";
  const lines = [
    "**GitHub Environment**", "",
    `| Environment | Wait Timer | Reviewers |`,
    `|---|---|---|`,
    `| \`${env?.name}\` | \`${env?.wait_timer ?? 0}\` | ${reviewers} |`,
    "", url ? `[Open Environment Settings](${url})` : "",
  ];
  return [okText("GitHub — Environment Upserted", lines), { type: "json" as const, json: env }];
}
function presentBranchProtection(repo: string, branch: string, rules: any) {
  const requirePRs = rules?.required_pull_request_reviews ? "Yes" : "No";
  const enforceAdmins = rules?.enforce_admins?.enabled ? "Yes" : "No";
  const lines = [
    "**Branch Protection**", "",
    `| Repo | Branch | Require PRs | Enforce Admins |`,
    `|---|---|---|---|`,
    `| \`${repo}\` | \`${branch}\` | \`${requirePRs}\` | \`${enforceAdmins}\` |`,
  ];
  return [okText("GitHub — Branch Protection", lines), { type: "json" as const, json: rules }];
}