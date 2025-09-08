import "dotenv/config";
import fetch from "node-fetch";
import OpenAI from "openai";
import { startMcpHttpServer, type ToolDef } from "mcp-http";
import z from "zod";
import crypto from "crypto";
import { SYSTEM_PROMPT } from "./prompts/system.js";

// ---------- Config ----------
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";
const PROVIDER = process.env.AI_PROVIDER || "azure"; // "azure" | "openai"
const MODEL =
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  process.env.OPENAI_MODEL ||
  "gpt-4o";
const SUPERVISOR_MCP_PORT = Number(process.env.SUPERVISOR_MCP_PORT || 8720);

// ---------- Redaction helpers ----------
const SECRET_KEY_RE = /(password|secret|token|key|conn(str|ection)|pwd|sas|client_secret|authorization)/i;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/ig;
const AZURE_SUB_RE = /\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/ig;

function maskAzureSubsInStrings(s: string): string {
  return s
    .replace(AZURE_SUB_RE, "/subscriptions/********-****-****-****-************")
    // optionally also mask any free GUIDs not tied to subscriptions
    .replace(UUID_RE, "********-****-****-****-************");
}

function redactScalar(v: any): any {
  if (v == null) return v;
  if (typeof v === "string") {
    // if the whole string looks like a secret-ish thing, mask fully
    if (/^[-_A-Za-z0-9=+:.\/]{24,}$/.test(v) && /[A-Za-z]/.test(v)) return "***REDACTED***";
    return maskAzureSubsInStrings(v);
  }
  return v;
}

function redactObject(input: any): any {
  if (input == null) return input;
  if (Array.isArray(input)) return input.map(redactObject);
  if (typeof input === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(input)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "***REDACTED***";
      } else if (typeof v === "string" && SECRET_KEY_RE.test(v)) {
        out[k] = "***REDACTED***";
      } else {
        out[k] = redactObject(v);
      }
    }
    return out;
  }
  return redactScalar(input);
}

function redactMcpBodyText(bodyText: string): { json?: any; text?: string } {
  try {
    const j = JSON.parse(bodyText);
    return { json: redactObject(j) };
  } catch {
    return { text: maskAzureSubsInStrings(bodyText) };
  }
}

// ---------- LLM client ----------
function makeClient() {
  if (PROVIDER === "azure") {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT!;
    const key = process.env.AZURE_OPENAI_API_KEY!;
    const apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";
    if (!endpoint || !key) throw new Error("Missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY");
    return new OpenAI({
      baseURL: `${endpoint}/openai/deployments/${MODEL}`,
      apiKey: key,
      defaultHeaders: { "api-key": key },
      defaultQuery: { "api-version": apiVersion },
    });
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL, // optional
  });
}

// ---------- Router tool schema (for the LLM) ----------
const ROUTER_TOOL = {
  type: "function",
  function: {
    name: "router.call_tool",
    description:
      "Call any MCP tool through the Router. Provide the tool 'name' (e.g., 'azure.create_resource_group') and an 'arguments' object.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["name", "arguments"],
      properties: {
        name: { type: "string", minLength: 3 },
        arguments: { type: "object", additionalProperties: true },
      },
    },
  },
} as const;

// ---------- Router caller with trace id ----------
async function callRouterTool(name: string, args: any) {
  const traceId = crypto.randomUUID();
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-trace-id": traceId,
    },
    body: JSON.stringify({ name, arguments: args || {} }),
  });

  const bodyText = await r.text();
  const hdrGov = parseGovFromHeaders(r);

  let body: any;
  try { body = JSON.parse(bodyText); } catch { body = { raw: bodyText }; }

  // Governance from body (deny/warn embedded by MCP)
  const bodyGov = parseGovFromBody(body);

  // Prefer deny if present, otherwise header warn, otherwise embedded warn
  const governance =
    (bodyGov?.decision === "deny" ? bodyGov :
      hdrGov?.decision === "warn" ? hdrGov :
        bodyGov?.decision === "warn" ? bodyGov : undefined);

  const warned = governance?.decision === "warn";
  const governanceDenied = governance?.decision === "deny";

  return {
    httpStatus: r.status,
    traceId,
    warned,
    governanceDenied,
    governance,     // ← NEW: carry forward a normalized governance block
    bodyRaw: body,  // raw JSON-RPC
    bodyText        // original for logging
  };
}

function assistantWantsReply(text?: string | null) {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  if (t.includes("?")) return true;
  const cues = [
    /please\s+(confirm|provide|specify|share)/i,
    /\bconfirm\b/i,
    /\bconsent\b/i,
    /\backnowledge\b/i,
    /\bneed(?:s)? (your )?(input|answer|permission)/i,
    /\bcan you\b/i,
    /\bwould you\b/i,
  ];
  return cues.some((re) => re.test(t));
}

function parseGovFromHeaders(r: any) {
  const warned = r.headers.get("x-governance-warning") === "true";
  const reasonsHdr = r.headers.get("x-governance-reasons");
  const suggHdr = r.headers.get("x-governance-suggestions");
  let reasons: string[] | undefined;
  let suggestions: Array<{ title?: string; text: string }> | undefined;
  try {
    if (reasonsHdr) reasons = JSON.parse(decodeURIComponent(reasonsHdr));
  } catch { }
  try {
    if (suggHdr) suggestions = JSON.parse(decodeURIComponent(suggHdr));
  } catch { }
  return warned
    ? { decision: "warn" as const, reasons, suggestions }
    : undefined;
}

// Find governance blocks in a JSON-RPC body that came back from the Router
function parseGovFromBody(body: any) {
  // DENY pattern bubbled as error
  const errGov = body?.error?.data;
  if (errGov?.reasons || errGov?.suggestions) {
    return { decision: "deny" as const, reasons: errGov.reasons, suggestions: errGov.suggestions };
  }

  // Success path with governance block embedded by the MCP
  const content = body?.result?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      const j = c?.json;
      if (j?.governance?.decision) return j.governance;
      if (j?.governance && j?.governance.decision) return j.governance;
      // Some MCPs attach governance directly: { decision, reasons, suggestions }
      if (j?.decision && (j?.reasons || j?.suggestions)) {
        return { decision: j.decision, reasons: j.reasons, suggestions: j.suggestions };
      }
    }
  }
  return undefined;
}

// If the model prints a JSON tool call in a code block, run it anyway
function tryParseInlineToolCalls(text?: string) {
  if (!text) return [] as Array<{ name: string; arguments: any }>;
  const calls: Array<{ name: string; arguments: any }> = [];
  const re = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1].trim();
    try {
      const obj = JSON.parse(raw);
      if (obj?.name && obj?.arguments) {
        calls.push({ name: obj.name, arguments: obj.arguments });
      } else if (obj?.function?.name && obj?.function?.arguments) {
        const args = typeof obj.function.arguments === "string"
          ? JSON.parse(obj.function.arguments)
          : obj.function.arguments;
        calls.push({ name: obj.function.name, arguments: args });
      }
    } catch { /* ignore */ }
  }
  return calls;
}

// ---------- Core NL Orchestration (shared by MCP tools) ----------
type ChatOpts = {
  maxSteps?: number;
  temperature?: number;
  assumeYes?: boolean;     // auto-confirm loops by injecting "yes"
  autoReplyText?: string;  // or inject custom reply string
};
async function runChat(prompt: string, opts: ChatOpts = {}) {
  const client = makeClient();
  const maxSteps = Math.min(Math.max(opts.maxSteps ?? 8, 1), 20);
  const temperature = opts.temperature ?? 0.2;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  const transcript: Array<{ role: "assistant" | "tool"; content: any; traceId?: string; warned?: boolean }> = [];

  let text: string = "";

  for (let step = 0; step < maxSteps; step++) {
    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: [ROUTER_TOOL] as any,
      tool_choice: "auto",
      temperature,
    });

    const msg = completion.choices[0].message;

    // Execute printed tool calls
    if (!msg.tool_calls?.length) {
      const planned = tryParseInlineToolCalls(typeof msg.content === "string" ? msg.content : undefined);
      if (planned.length) {
        const fakeCalls = planned.map((p, i) => ({
          id: `inline_${Date.now()}_${i}`,
          type: "function" as const,
          function: { name: "router.call_tool", arguments: JSON.stringify(p) },
        }));
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: fakeCalls });
        for (const tc of fakeCalls) {
          const { name, arguments: args } = JSON.parse(tc.function.arguments);
          const result = await callRouterTool(name, args);
          const sanitized = redactMcpBodyText(result.bodyText);
          const payload = sanitized.json ?? sanitized.text ?? "(empty)";
          messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(payload) });
          transcript.push({ role: "tool", content: payload, traceId: result.traceId, warned: result.warned });
          // Surface governance explicitly so Copilot shows it
          if (result.governance) {
            const g = result.governance;
            const title = g.decision === "deny" ? "⛔ Governance DENY" : "⚠️ Governance advisory";
            const lines = [
              title,
              g.reasons?.length ? `Reasons: ${g.reasons.join(" | ")}` : undefined,
              g.suggestions?.length ? "Suggestions:" : undefined,
              ...(g.suggestions || []).map((s: { title: any; text: any; }) => `- ${s.title ? `${s.title}: ` : ""}${s.text}`)
            ].filter(Boolean).join("\n");

            // Insert a short text banner so users SEE it
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ governance: g, traceId: result.traceId })
            });

            transcript.push({ role: "tool", content: { governance: g }, traceId: result.traceId });
            // Optional: also add a human-readable line as a tool content (many UIs render it inline)
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ text: lines })
            });
          }
        }
        continue;
      }
    }

    // Normal function-calling path
    if (msg.tool_calls?.length) {
      messages.push({ role: "assistant", content: msg.content || "", tool_calls: msg.tool_calls });
      if (msg.content) transcript.push({ role: "assistant", content: msg.content });

      for (const tc of msg.tool_calls) {
        if (tc.type !== "function") continue;
        const fn = tc.function?.name;
        const argsStr = tc.function?.arguments || "{}";
        let args: any = {};
        try { args = JSON.parse(argsStr); } catch { args = {}; }

        if (fn === "router.call_tool") {
          const toolName = args?.name;
          const toolArgs = args?.arguments ?? {};
          const result = await callRouterTool(toolName, toolArgs);
          const sanitized = redactMcpBodyText(result.bodyText);
          const payload = sanitized.json ?? sanitized.text ?? "(empty)";
          messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(payload) });
          transcript.push({ role: "tool", content: payload, traceId: result.traceId, warned: result.warned });
        } else {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Unknown function ${fn}` }),
          });
        }
      }
      continue; // loop again to let the model read results
    }

    // Assistant text only
    text = typeof msg.content === "string" ? msg.content : "";
    transcript.push({ role: "assistant", content: text });

    // Auto-confirm if requested
    if (assistantWantsReply(text) && (opts.assumeYes || opts.autoReplyText)) {
      messages.push({ role: "assistant", content: text });
      messages.push({ role: "user", content: opts.autoReplyText || "yes" });
      continue;
    }

    // Done
    const safeText = maskAzureSubsInStrings(text || "(no content)");
    return {
      content: [
        { type: "text" as const, text: safeText },
        { type: "json" as const, json: { transcript: redactObject(transcript) } },
      ],
    };
  }

  // collect governance notes from transcript
  const govEvents: Array<{ decision: "warn" | "deny"; reasons?: string[]; suggestions?: any; traceId?: string }> = [];
  for (const row of transcript) {
    const g = (row?.content && row.content.governance) ? row.content.governance : undefined;
    if (g?.decision === "warn" || g?.decision === "deny") {
      govEvents.push({ decision: g.decision, reasons: g.reasons, suggestions: g.suggestions, traceId: row.traceId });
    }
  }

  const govSummaryText = govEvents.length
    ? [
      "",
      "——",
      "Governance summary:",
      ...govEvents.map((ev, i) => {
        const head = ev.decision === "deny" ? "⛔ DENY" : "⚠️ WARN";
        const r = ev.reasons?.length ? ` — ${ev.reasons.join(" | ")}` : "";
        return `${i + 1}. ${head}${r}${ev.traceId ? ` [trace ${ev.traceId}]` : ""}`;
      })
    ].join("\n")
    : "";

  const safeText = maskAzureSubsInStrings(text || "(no content)") + govSummaryText;

  return {
    content: [
      { type: "text" as const, text: safeText },
      { type: "json" as const, json: { transcript: redactObject(transcript), governanceSummary: govEvents } },
    ],
  };
}

// ---------- MCP Tools (exposed by Supervisor) ----------
const mcpTools: ToolDef[] = [
  {
    name: "supervisor.chat",
    description: "Natural-language orchestration with tool access via the Router. Set assumeYes=true to auto-confirm.",
    inputSchema: z.object({
      prompt: z.string(),
      assumeYes: z.boolean().default(false),
      autoReplyText: z.string().optional(),
      maxSteps: z.number().int().min(1).max(20).default(8),
      temperature: z.number().min(0).max(2).default(0.2),
    }).strict(),
    handler: async (a) => {
      return runChat(a.prompt, {
        assumeYes: a.assumeYes,
        autoReplyText: a.autoReplyText,
        maxSteps: a.maxSteps,
        temperature: a.temperature,
      });
    }
  },
  {
    name: "supervisor.router_call",
    description: "Directly call any MCP tool through the Router by name and arguments (debug helper).",
    inputSchema: z.object({
      name: z.string(),
      arguments: z.record(z.any()).default({}),
    }),
    handler: async (a) => {
      const r = await callRouterTool(a.name, a.arguments);
      const sanitized = redactMcpBodyText(r.bodyText);
      const payload = sanitized.json ?? sanitized.text ?? "(empty)";
      const banner = r.governance
        ? (r.governance.decision === "deny" ? "⛔ Governance DENY" : "⚠️ Governance advisory")
        : undefined;

      return {
        content: [
          banner ? { type: "text" as const, text: banner } : undefined,
          { type: "json" as const, json: { traceId: r.traceId, governance: r.governance, result: payload } }
        ].filter(Boolean) as any
      };
    }
  }
];

// ---------- Start MCP server ----------
startMcpHttpServer({
  name: "supervisor-mcp",
  version: "0.1.0",
  port: SUPERVISOR_MCP_PORT,
  tools: mcpTools,
});
console.log(`[MCP] supervisor-mcp listening on :${SUPERVISOR_MCP_PORT} (router=${ROUTER_URL})`);

// ---------- Optional CLI entry ----------
const argsText = process.argv.slice(2).join(" ").trim();
if (argsText) {
  (async () => {
    const r = await runChat(argsText, { maxSteps: 8 });
    const textBlock = r.content.find(c => c.type === "text") as any;
    console.log("\nPlatform Assistant:\n", textBlock?.text || JSON.stringify(r.content, null, 2));
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
