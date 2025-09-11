// servers/platform-mcp/src/lib/advisor.ts
// Azure OpenAI "advisor" helper that turns tool results into next-step guidance.

// Env config
const AOAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT || ""; // e.g. https://your-aoai.openai.azure.com
const AOAI_KEY = process.env.AZURE_OPENAI_API_KEY || "";
const AOAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o-mini";
const AOAI_API_VERSION = process.env.AZURE_OPENAI_API_VERSION || "2024-05-01-preview";
const ADVISOR_ENABLED = (process.env.ADVISOR_ENABLED || "true").toLowerCase() !== "false";

export function isAdvisorConfigured() {
  return ADVISOR_ENABLED && !!AOAI_ENDPOINT && !!AOAI_KEY && !!AOAI_DEPLOYMENT;
}

// Simple redaction borrowed from audit style
function redactArgs(a: any) {
  try {
    if (!a || typeof a !== "object") return a;
    const mask = ["password", "token", "key", "clientSecret", "privateKey", "authorization", "apiKey"];
    const out: any = Array.isArray(a) ? [] : {};
    for (const [k, v] of Object.entries(a)) out[k] = mask.includes(k) ? "***" : v;
    return out;
  } catch { return a; }
}

// Create a compact summary of a tool result suitable for prompting
export function briefResult(result: any) {
  const out: any = { isError: !!result?.isError };
  const contents = Array.isArray(result?.content) ? result.content : [];
  const jsons = contents.filter((c: any) => c?.type === "json").map((c: any) => c.json);
  // Try to surface common fields
  for (const j of jsons) {
    if (j?.status) out.status = j.status;
    if (j?.summary) out.summary = j.summary;
    if (Array.isArray(j?.findings)) out.findingsCount = (out.findingsCount || 0) + j.findings.length;
    if (j?.report) out.report = j.report; // remediation reports
    if (j?.error) out.error = j.error;
  }
  // Fallback: include up to first 2 json nodes
  out.json = jsons.slice(0, 2);
  return out;
}

export async function advise(toolName: string, args: any, result: any): Promise<string | null> {
  if (!isAdvisorConfigured()) return null;
  const endpoint = `${AOAI_ENDPOINT.replace(/\/?$/, "")}/openai/deployments/${encodeURIComponent(AOAI_DEPLOYMENT)}/chat/completions?api-version=${encodeURIComponent(AOAI_API_VERSION)}`;

  const sys = [
    "You are a senior platform engineering advisor.",
    "Given a tool call (name, args) and its result, produce concise next-step guidance.",
    "Rules:",
    "- Use short bullet points.",
    "- Be actionable and specific (names, commands, follow-ups).",
    "- If errors, lead with unblocking steps (RBAC, missing params).",
    "- If a scan, summarize hotspots and suggest concrete remediations.",
    "- If a remediation plan (dryRun), list what will change and risks.",
    "- Keep under 12 bullets.",
  ].join("\n");

  const brief = briefResult(result);
  const user = {
    tool: toolName,
    args: redactArgs(args),
    result: brief,
  };

  const body = {
    messages: [
      { role: "system", content: sys },
      { role: "user", content: JSON.stringify(user, null, 2) },
    ],
    temperature: 0.2,
    max_tokens: 400,
    top_p: 0.9,
  } as any;

  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": AOAI_KEY,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      // Don't break the main flow; just return null on failure
      return null;
    }
    const data = await r.json();
    const text = data?.choices?.[0]?.message?.content?.trim?.();
    return text || null;
  } catch {
    return null;
  }
}

export async function maybeAdvise(toolName: string, args: any, result: any) {
  try {
    return await advise(toolName, args, result);
  } catch { return null; }
}
