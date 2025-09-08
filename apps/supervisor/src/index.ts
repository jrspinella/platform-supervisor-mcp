// apps/supervisor/src/index.ts
import "dotenv/config";
import fetch from "node-fetch";
import readline from "node:readline";
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompts/system.js";

// ---------- Config ----------
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";
const PROVIDER = process.env.AI_PROVIDER || "azure"; // "azure" | "openai"
const MODEL =
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  process.env.OPENAI_MODEL ||
  "gpt-4o";

// ---------- LLM client ----------
function makeClient() {
  if (PROVIDER === "azure") {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT!;
    const key = process.env.AZURE_OPENAI_API_KEY!;
    const apiVersion =
      process.env.AZURE_OPENAI_API_VERSION || "2024-08-01-preview";
    if (!endpoint || !key)
      throw new Error(
        "Missing AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_API_KEY"
      );
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

// ---------- Single generic tool that proxies to the Router ----------
const TOOLS = [
  {
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
  },
] as const;

// ---------- Helpers ----------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
const ask = (q: string) =>
  new Promise<string>((res) => rl.question(q + " ", (a) => res(a.trim())));

async function callRouterTool(name: string, args: any) {
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args || {} }),
  });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();

  // log compactly
  console.log(
    `[supervisor→router] ${name} -> ${r.status} ${ct} body=${text.slice(0, 180)}…`
  );

  // NEW: parse + summarize
  const bodyJson = safeJsonParse(text);
  const toolText = bodyJson ? extractToolTextFromRouterBody(bodyJson) : text;

  return {
    httpStatus: r.status,
    contentType: ct,
    bodyText: text,
    bodyJson,        // new
    toolText,        // new
  };
}

async function listRouterTools() {
  const base = process.env.ROUTER_URL || "http://127.0.0.1:8700";
  const r = await fetch(`${base}/a2a/tools/list`, { method: "GET" });
  if (!r.ok) throw new Error(`Router tools/list failed: ${r.status}`);
  const body = (await r.json()) as { result?: { tools?: any[] } };
  return body?.result?.tools ?? [];
}

let _toolCache: Array<{ name: string; description: string; inputSchema: any }> | null =
  null;
async function getToolCatalog(force = false) {
  if (force || !_toolCache) _toolCache = await listRouterTools();
  return _toolCache!;
}

function assistantWantsReply(text: string | null | undefined) {
  if (!text) return false;
  const t = text.trim();

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
        const args =
          typeof obj.function.arguments === "string"
            ? JSON.parse(obj.function.arguments)
            : obj.function.arguments;
        calls.push({ name: obj.function.name, arguments: args });
      }
    } catch { }
  }
  return calls;
}

// ---------- NEW: NL intent helpers ----------
function extractResourceGroup(text: string): string | undefined {
  const m = /\brg-[a-z0-9-]+\b/i.exec(text);
  if (m) return m[0];
  const inMatch = /\bin\s+([A-Za-z0-9-_]+)/i.exec(text);
  return inMatch?.[1];
}
type IntentHit = { name: string; arguments: any };
function detectIntent(user: string): IntentHit | null {
  const s = user.toLowerCase();

  // Scan workloads (App Service)
  if (/\bscan\b.*\b(workload|workloads|apps|app workloads)\b/.test(s)) {
    const rg = extractResourceGroup(user);
    return {
      name: "platform.scan_workloads",
      arguments: rg ? { resourceGroupName: rg } : {},
    };
  }

  // Scan networks (VNets/Subnets/NSGs)
  if (/\bscan\b.*\b(network|networks|vnet|vnets|subnet|subnets)\b/.test(s)) {
    const rg = extractResourceGroup(user);
    return {
      name: "platform.scan_networks",
      arguments: rg ? { resourceGroupName: rg } : {},
    };
  }

  return null;
}

// ---------- NEW: tool primer for the model ----------
function buildToolPrimer(
  tools: Array<{ name: string; description: string }>
) {
  const names = tools.map((t) => t.name).join(", ");
  const guidance = [
    "Use platform.* tools for end-to-end workflows.",
    "For ATO scans, prefer: platform.scan_workloads, platform.scan_networks.",
    "Do not call azure.* directly for scanning; these are implementation primitives.",
    "Use router.call_tool with {name, arguments} exactly.",
  ].join(" ");
  return `Available tools: ${names}. ${guidance}`;
}

// --- JSON → short, human text extractor ---
// --- masking helpers ---
function maskSubscriptionIds(s: string): string {
  if (!s) return s;
  // Replace GUID in /subscriptions/<guid> with /subscriptions/**** (keeps rest of ID)
  return s.replace(/\/subscriptions\/[0-9a-fA-F-]{8}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{4}-[0-9a-fA-F-]{12}/g, "/subscriptions/****");
}
function maskAll(text: string) { return maskSubscriptionIds(text); }

// --- tiny utils ---
function take<T>(arr: T[], n: number) { return Array.isArray(arr) ? arr.slice(0, n) : []; }
function lastPath(id?: string) {
  if (!id || typeof id !== "string") return "";
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] || id;
}
function pickKeys(o: any, keys: string[]) {
  const out: Record<string, any> = {};
  for (const k of keys) if (o && Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}
function compactLines(lines: Array<string | undefined>) {
  return lines.filter(Boolean).join("\n");
}
function shortReasons(reasons?: string[], limit = 2) {
  if (!Array.isArray(reasons) || reasons.length === 0) return "";
  const head = take(reasons, limit).join(" | ");
  return reasons.length > limit ? `${head} (+${reasons.length - limit} more)` : head;
}

// --- targeted summarizers for common payload shapes ---
function summarizeCreateUpdate(obj: any): string | null {
  // Look for id/name/location/properties.provisioningState
  const id = obj?.id;
  const name = obj?.name || lastPath(id);
  const location = obj?.location;
  const ps = obj?.properties?.provisioningState || obj?.provisioningState;
  if (!id && !name && !location && !ps) return null;

  const parts: string[] = [];
  if (name) parts.push(`**${name}**`);
  if (location) parts.push(`in \`${location}\``);
  if (ps) parts.push(`status: ${String(ps)}`);
  let line = parts.join(" ");
  if (id) line += `\nID: ${maskSubscriptionIds(id)}`;

  const type = obj?.type || "";
  if (type) line = `${type}: ${line}`;

  return line;
}

function summarizePlan(obj: any): string | null {
  const status = obj?.status;      // pending | blocked | done | error
  const plan = obj?.plan;
  if (!plan) return null;
  const action = plan.action || plan.tool || "";
  const mode = plan.mode || "";
  const gov = plan.governance || {};
  const decision = gov.decision ? String(gov.decision).toUpperCase() : "ALLOW";
  const reasons = shortReasons(gov.reasons, 3);

  const head = `Plan: ${action} (${mode}) — Governance: ${decision}`;
  const mids = [];
  if (reasons) mids.push(`Reasons: ${reasons}`);
  if (Array.isArray(gov.suggestions) && gov.suggestions.length) {
    const sug = take(gov.suggestions, 2).map((s: any) => `- ${s.title ? `${s.title}: ` : ""}${s.text}`).join("\n");
    mids.push(`Suggestions:\n${sug}${gov.suggestions.length > 2 ? `\n(+${gov.suggestions.length - 2} more)` : ""}`);
  }
  const tail = status ? `Status: ${status}` : undefined;

  return compactLines([head, mids.join("\n"), tail]);
}

function summarizeFindings(obj: any): string | null {
  // platform.scan_* results shape: { counts, findings[], scope? }
  if (!obj || !Array.isArray(obj.findings)) return null;

  const countsLine = obj.counts
    ? "Counts: " + Object.entries(obj.counts).map(([k, v]) => `${k}=${v}`).join(", ")
    : undefined;

  const top = take(obj.findings, 5).map((f: any) => {
    const rid = maskSubscriptionIds(f.resourceId || "");
    const name = lastPath(rid);
    const rs = shortReasons(f.reasons, 2);
    return `• ${name}${rs ? ` — ${rs}` : ""}`;
  }).join("\n");

  const more = obj.findings.length > 5 ? `(+${obj.findings.length - 5} more)` : "";

  return compactLines([
    countsLine,
    top,
    more || undefined
  ]);
}

function summarizeArray(arr: any[]): string | null {
  if (!Array.isArray(arr) || arr.length === 0) return "No items.";
  // if array of objects with id/name -> list first 5 names
  if (typeof arr[0] === "object") {
    const items = take(arr, 5).map((it: any) => {
      const id = it?.id ? maskSubscriptionIds(it.id) : "";
      const name = it?.name || lastPath(id) || "(unnamed)";
      const extra = it?.location ? ` — ${it.location}` : "";
      return `• ${name}${extra}`;
    }).join("\n");
    return `${items}${arr.length > 5 ? `\n(+${arr.length - 5} more)` : ""}`;
  }
  // array of scalars
  const items = take(arr, 8).map(x => String(x)).join(", ");
  return `${items}${arr.length > 8 ? `, … (+${arr.length - 8} more)` : ""}`;
}

function summarizeGenericJson(obj: any): string {
  if (!obj || typeof obj !== "object") return "Result received.";
  const keys = Object.keys(obj);
  // show a few top-level keys to give sense of content
  const sample = take(keys, 6).join(", ");
  return `Result received (fields: ${sample}${keys.length > 6 ? ", …" : ""}).`;
}

function safeJsonParse(s: string) {
  try { return JSON.parse(s); } catch { return null; }
}

// --- MAIN extractor (replace yours with this) ---
function extractToolTextFromRouterBody(obj: any): string {
  try {
    // 1) prefer explicit text blocks in MCP result
    const content = obj?.result?.content ?? obj?.content ?? null;
    if (Array.isArray(content)) {
      const texts = content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text.trim())
        .filter(Boolean);
      if (texts.length) return maskAll(texts.join("\n\n"));

      // 2) otherwise summarize the first json block smartly
      const jsonBlocks = content.filter((c: any) => c?.type === "json").map((c: any) => c.json);
      if (jsonBlocks.length) {
        const j = jsonBlocks[0];

        // a) Plan/confirm wrapper
        const planText = summarizePlan(j);
        if (planText) return maskAll(planText);

        // b) Scan findings
        const findingText = summarizeFindings(j);
        if (findingText) return maskAll(`Scan results:\n${findingText}`);

        // c) Create/update result
        const cu = summarizeCreateUpdate(j);
        if (cu) return maskAll(cu);

        // d) Arrays
        if (Array.isArray(j)) return maskAll(summarizeArray(j) || "Result received.");

        // e) Fallback generic
        return maskAll(summarizeGenericJson(j));
      }
    }

    // 3) Some MCPs may return plain text directly
    if (typeof obj?.text === "string") return maskAll(obj.text.trim());

    // 4) Generic jsonrpc ack
    if (obj?.jsonrpc && obj?.result && !obj?.result?.content) return "Result received.";

    // 5) Last fallback
    return "Result received.";
  } catch {
    return "Result received.";
  }
}
// ---------- NEW: 429 backoff ----------
async function createCompletionWithRetry(
  client: OpenAI,
  req: OpenAI.Chat.Completions.ChatCompletionCreateParams,
  maxRetries = 3
) {
  let delayMs = 1500;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await client.chat.completions.create(req);
    } catch (e: any) {
      const status = e?.status || e?.code;
      if (String(status) === "429" || status === 429) {
        const ra = Number(e?.headers?.["retry-after"]) || Math.ceil(delayMs / 1000);
        await new Promise((r) => setTimeout(r, ra * 1000));
        delayMs *= 2;
        continue;
      }
      throw e;
    }
  }
  throw new Error("LLM call exceeded retry budget (429).");
}

// ---------- NEW: redact + shrink tool outputs ----------
function redactSubscriptions(s: string) {
  return s.replace(
    /\/subscriptions\/[0-9a-f-]{36}/gi,
    "/subscriptions/********-****-****-****-************"
  );
}
function shrinkForLLM(s: string | undefined, max = 12000) {
  if (!s) return "";
  const t = redactSubscriptions(s);
  if (t.length <= max) return t;
  const head = t.slice(0, Math.floor(max * 0.7));
  const tail = t.slice(-Math.floor(max * 0.2));
  return head + "\n…(truncated)…\n" + tail;
}

// ---------- Conversation loop ----------
async function run(userInput: string) {
  const client = makeClient();

  // Load catalog + tool primer
  const catalog = await getToolCatalog(true);
  const primer = buildToolPrimer(
    catalog.map((t) => ({ name: t.name, description: t.description }))
  );

  // Short-circuit obvious intents (avoid LLM guesses)
  // Short-circuit obvious intents (avoid LLM guesses)
  const maybe = detectIntent(userInput);
  if (maybe) {
    const result = await callRouterTool(maybe.name, maybe.arguments || {});
    console.log("\nPlatform Assistant:\n", result.toolText || "Result received.");
    rl.close();
    return;
  }

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: primer }, // <— guide the model
    { role: "user", content: userInput },
  ];

  for (let turn = 0; turn < 12; turn++) {
    console.log(
      `[BEFORE CALL] messages= ${messages.map((m) => m.role).join(" -> ")}`
    );

    const completion = await createCompletionWithRetry(client, {
      model: MODEL,
      messages,
      tools: TOOLS as any,
      tool_choice: "auto",
      temperature: 0.2,
      stream: false,
    }) as OpenAI.Chat.Completions.ChatCompletion;

    const choice = completion.choices[0];
    const msg = choice.message;

    // If the model *printed* JSON tool calls, execute them
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
            arguments: JSON.stringify(p),
          },
        }));
        messages.push({
          role: "assistant",
          content: msg.content || "",
          tool_calls: fakeCalls,
        });
        for (const tc of fakeCalls) {
          const { name, arguments: args } = JSON.parse(tc.function.arguments);
          const result = await callRouterTool(name, args);

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result.toolText,
          });
        }
        continue;
      }
    }

    // Normal function-calling path
    if (msg.tool_calls?.length) {
      messages.push({
        role: "assistant",
        tool_calls: msg.tool_calls,
        content: msg.content || "",
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
          // Guardrail: if the model tries azure.* for scan, rewrite to platform.*
          let toolName = args?.name;
          let toolArgs = args?.arguments ?? {};
          const lastUserMsg =
            [...messages].reverse().find((m) => m.role === "user")?.content ||
            "";

          const lastUser = String(lastUserMsg).toLowerCase();
          const looksLikeScan =
            /\bscan\b/.test(lastUser) &&
            /\b(workload|workloads|apps|app workloads|network|networks|vnet|vnets|subnet|subnets)\b/.test(
              lastUser
            );

          if (/^azure\./.test(toolName) && looksLikeScan) {
            if (/\b(workload|workloads|apps|app workloads)\b/.test(lastUser)) {
              toolName = "platform.scan_workloads";
              if (!toolArgs.resourceGroupName) {
                const rg = extractResourceGroup(String(lastUserMsg));
                if (rg) toolArgs.resourceGroupName = rg;
              }
            } else if (
              /\b(network|networks|vnet|vnets|subnet|subnets)\b/.test(lastUser)
            ) {
              toolName = "platform.scan_networks";
              if (!toolArgs.resourceGroupName) {
                const rg = extractResourceGroup(String(lastUserMsg));
                if (rg) toolArgs.resourceGroupName = rg;
              }
            }
          }


          const result = await callRouterTool(toolName, toolArgs);

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result.toolText,
          });
        } else {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Unknown function ${fn}` }),
          });
        }
      }
      continue; // let the model read tool results
    }

    // Text-only answer
    if (msg.content && msg.content.length > 0) {

      console.log("\nPlatform Assistant:\n", (msg.content || "").slice(0, 12000));

      if (assistantWantsReply(typeof msg.content === "string" ? msg.content : "")) {
        const answer = await ask("> ");
        messages.push({ role: "assistant", content: msg.content }); // echo for context
        messages.push({ role: "user", content: answer });
        continue;
      }
      break;
    }

    console.log("No content from model; exiting.");
    break;
  }

  rl.close();
}

// ---------- Entry ----------
const userText =
  process.argv.slice(2).join(" ").trim() ||
  "Create RG rg-demo in usgovvirginia";

run(userText).catch((e) => {
  console.error(e);
  process.exit(1);
});
