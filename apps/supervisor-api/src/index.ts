import "dotenv/config";
import express from "express";
import fetch from "node-fetch";
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompts/system.js";

// ---------- Config ----------
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";
const ROUTER_API_KEY = process.env.ROUTER_API_KEY || "";
const PROVIDER = process.env.AI_PROVIDER || "azure"; // "azure" | "openai"
const MODEL =
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  process.env.OPENAI_MODEL ||
  "gpt-4o";

const PORT = Number(process.env.PORT || 8787);

// ---------- OpenAI client ----------
function makeClient() {
  if (PROVIDER === "azure") {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT!;
    const key = process.env.AZURE_OPENAI_API_KEY!;
    const apiVersion =
      process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";
    if (!endpoint || !key)
      throw new Error("Missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY");
    return new OpenAI({
      baseURL: `${endpoint}/openai/deployments/${MODEL}`,
      apiKey: key,
      defaultHeaders: { "api-key": key },
      defaultQuery: { "api-version": apiVersion }
    });
  }
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL // optional
  });
}

// ---------- Router proxy as a single tool ----------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "router.call_tool",
      description:
        "Call any MCP tool via Router: pass {name:'azure.create_resource_group', arguments:{...}}.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name", "arguments"],
        properties: {
          name: { type: "string", minLength: 3 },
          arguments: { type: "object", additionalProperties: true }
        }
      }
    }
  }
] as const;

// ---------- Helpers ----------
async function callRouterTool(name: string, args: any) {
  if (!name || typeof name !== "string") {
    return {
      httpStatus: 400,
      contentType: "application/json",
      bodyText: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        error: { code: -32602, message: "router.call_tool: invalid 'name'" }
      })
    };
  }
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ROUTER_API_KEY ? { "x-router-api-key": ROUTER_API_KEY } : {})
    },
    body: JSON.stringify({ name, arguments: args || {} })
  });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  // Pass JSON straight through
  if (ct.includes("application/json")) {
    return { httpStatus: r.status, contentType: ct, bodyText: text };
  }
  // Wrap non-JSON bodies
  return {
    httpStatus: r.status,
    contentType: "application/json",
    bodyText: JSON.stringify({
      ok: r.ok,
      status: r.status,
      contentType: ct,
      raw: text
    })
  };
}

function tryParseJSON<T = any>(s: string): T | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractSummaryFromTool(bodyText: string): string | null {
  const first = tryParseJSON<any>(bodyText);
  const root = first?.raw ? tryParseJSON<any>(first.raw) : first;
  const content = root?.result?.content;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c?.json?.summary) return String(c.json.summary);
      if (c?.json?.playbook?.summary) return String(c.json.playbook.summary);
    }
  }
  return null;
}

function tryParseInlineToolCalls(text?: string) {
  if (!text) return [] as Array<{ name: string; arguments: any }>;
  const calls: Array<{ name: string; arguments: any }> = [];
  const re = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n")
      .trim();
    try {
      const obj = JSON.parse(raw);
      if (obj?.name && obj?.arguments) {
        calls.push({ name: obj.name, arguments: obj.arguments });
        continue;
      }
      if (obj?.function?.name && obj?.function?.arguments) {
        const args =
          typeof obj.function.arguments === "string"
            ? JSON.parse(obj.function.arguments)
            : obj.function.arguments;
        calls.push({ name: obj.function.name, arguments: args });
      }
    } catch {
      /* ignore */
    }
  }
  return calls;
}

const SAFE_BEFORE_CONSENT = [
  /^onboarding\.list_playbooks$/,
  /^onboarding\.describe_playbook$/,
  /^onboarding\.get_checklist$/,
  /^onboarding\.start_run$/,
  /^onboarding\.get_run$/,
  /^onboarding\.validate_playbooks$/
];
const DESTRUCTIVE_PREFIX = /^(azure|github|teams)\./;
function isSafeBeforeConsent(name: string) {
  return SAFE_BEFORE_CONSENT.some((re) => re.test(name));
}

// ---------- HTTP server ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    router: ROUTER_URL,
    model: MODEL,
    provider: PROVIDER
  });
});

/**
 * POST /chat
 * Body:
 * {
 *   "input": "free text request",
 *   "consent": "yes" | "no" | "dry",
 *   "maxTurns": 12
 * }
 *
 * Returns: final assistant message + tool call transcripts
 */
app.post("/chat", async (req, res) => {
  const input: string = String(req.body?.input || "");
  const consent: string = String(req.body?.consent || "").toLowerCase();
  const maxTurns: number = Math.max(1, Math.min(20, Number(req.body?.maxTurns || 12)));

  let CONSENT_GRANTED = consent === "yes" || consent === "dry";
  let DRY_RUN_ONLY = consent === "dry";
  let ASKED_FOR_CONSENT = false;

  const client = makeClient();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: input }
  ];

  const transcripts: any[] = [];

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS as any,
        tool_choice: "auto",
        temperature: 0.2
      });

      const choice = completion.choices[0];
      const msg = choice.message;

      // Safety net: if model printed inline tool JSON blocks
      if (!msg.tool_calls?.length) {
        const planned = tryParseInlineToolCalls(
          typeof msg.content === "string" ? msg.content : undefined
        );
        if (planned.length) {
          const fakeCalls = planned.map((p, i) => ({
            id: `inline_${Date.now()}_${i}`,
            type: "function" as const,
            function: {
              name: "router.call_tool",
              arguments: JSON.stringify({ name: p.name, arguments: p.arguments })
            }
          }));
          messages.push({
            role: "assistant",
            content: msg.content || "",
            tool_calls: fakeCalls
          });
          for (const tc of fakeCalls) {
            const { name, arguments: args } = JSON.parse(tc.function.arguments);

            // Block destructive tools until consent (unless tool is safe)
            if (
              !CONSENT_GRANTED &&
              !isSafeBeforeConsent(name) &&
              DESTRUCTIVE_PREFIX.test(name)
            ) {
              transcripts.push({
                blocked: true,
                name,
                reason: "consent_required"
              });
              continue;
            }

            // Dry run simulation: return a fake result
            if (DRY_RUN_ONLY && DESTRUCTIVE_PREFIX.test(name)) {
              const simulated = {
                simulated: true,
                name,
                arguments: args || {}
              };
              const payload = JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                result: { content: [{ type: "json", json: simulated }] }
              });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: payload
              });
              transcripts.push({ name, dryRun: true, args });
              continue;
            }

            const result = await callRouterTool(name, args);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result.bodyText
            });
            transcripts.push({ name, args, status: result.httpStatus });

            // Check for a summary and auto-ack if caller pre-supplied consent
            const summary = extractSummaryFromTool(result.bodyText);
            if (summary && !ASKED_FOR_CONSENT && !CONSENT_GRANTED) {
              ASKED_FOR_CONSENT = true;
              // No interactive prompt here; return summary to caller and stop
              return res.status(200).json({
                needConsent: true,
                summary,
                hint:
                  "Resubmit /chat with consent: 'yes' to execute, 'dry' to simulate, or 'no' to cancel.",
                transcripts
              });
            }
          }
          continue; // let model read tool results
        }
      }

      // Tool calls?
      if (msg.tool_calls?.length) {
        messages.push({
          role: "assistant",
          tool_calls: msg.tool_calls,
          content: msg.content || ""
        });

        for (const tc of msg.tool_calls) {
          if (tc.type !== "function") continue;
          const fn = tc.function?.name;
          const argsStr = tc.function?.arguments || "{}";
          let args: any = {};
          try {
            args = JSON.parse(argsStr);
          } catch {
            args = {};
          }

          if (fn === "router.call_tool") {
            const toolName = args?.name;
            const toolArgs = args?.arguments ?? {};

            if (
              !CONSENT_GRANTED &&
              !isSafeBeforeConsent(toolName) &&
              DESTRUCTIVE_PREFIX.test(toolName)
            ) {
              transcripts.push({
                blocked: true,
                name: toolName,
                reason: "consent_required"
              });
              // Provide a synthetic tool response explaining the block
              const payload = JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                error: {
                  code: -32001,
                  message:
                    "Consent required before executing destructive tools.",
                  data: { toolName }
                }
              });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: payload
              });
              continue;
            }

            if (DRY_RUN_ONLY && DESTRUCTIVE_PREFIX.test(toolName)) {
              const simulated = {
                simulated: true,
                name: toolName,
                arguments: toolArgs || {}
              };
              const payload = JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                result: { content: [{ type: "json", json: simulated }] }
              });
              messages.push({
                role: "tool",
                tool_call_id: tc.id,
                content: payload
              });
              transcripts.push({ name: toolName, dryRun: true, args: toolArgs });
              continue;
            }

            const result = await callRouterTool(toolName, toolArgs);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: result.bodyText
            });
            transcripts.push({
              name: toolName,
              args: toolArgs,
              status: result.httpStatus
            });

            const summary = extractSummaryFromTool(result.bodyText);
            if (summary && !ASKED_FOR_CONSENT && !CONSENT_GRANTED) {
              ASKED_FOR_CONSENT = true;
              return res.status(200).json({
                needConsent: true,
                summary,
                hint:
                  "Resubmit /chat with consent: 'yes' to execute, 'dry' to simulate, or 'no' to cancel.",
                transcripts
              });
            }
          } else {
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ error: `Unknown function ${fn}` })
            });
          }
        }
        continue; // next outer turn
      }

      // Pure text answer
      const text = (msg.content && String(msg.content).trim()) || "";
      if (text) {
        return res.status(200).json({
          message: text,
          transcripts
        });
      }

      // Nothing useful → break
      break;
    }

    // If we exit loop without returning, provide transcripts
    return res.status(200).json({
      message: "No additional content.",
      transcripts
    });
  } catch (e: any) {
    return res.status(500).json({
      error: String(e?.message || e),
      transcripts
    });
  }
});

app.listen(PORT, () => {
  console.log(`[supervisor-api] listening on http://127.0.0.1:${PORT}`);
  console.log(`[supervisor-api] Router: ${ROUTER_URL}, Provider: ${PROVIDER}, Model: ${MODEL}`);
});
