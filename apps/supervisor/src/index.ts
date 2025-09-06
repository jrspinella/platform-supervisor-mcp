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
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>((res) => rl.question(q + " ", (a) => res(a.trim())));

async function callRouterTool(name: string, args: any) {
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args || {} }),
  });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();
  console.log(`[supervisor→router] ${name} -> ${r.status} ${ct} body=${text.slice(0, 200)}…`);
  return { httpStatus: r.status, contentType: ct, bodyText: text };
} 

function assistantWantsReply(text: string | null | undefined) {
  if (!text) return false;
  const t = text.trim();

  // Any question mark anywhere
  if (t.includes("?")) return true;

  // Common request/confirmation cues
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
        const args = typeof obj.function.arguments === "string"
          ? JSON.parse(obj.function.arguments)
          : obj.function.arguments;
        calls.push({ name: obj.function.name, arguments: args });
      }
    } catch { }
  }
  return calls;
}

// ---------- Conversation loop ----------
async function run(userInput: string) {
  const client = makeClient();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userInput },
  ];

  for (let turn = 0; turn < 12; turn++) {
    console.log(`[BEFORE CALL] messages= ${messages.map((m) => m.role).join(" -> ")}`);

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS as any,
      tool_choice: "auto",
      temperature: 0.2,
    });

    const choice = completion.choices[0];
    const msg = choice.message;

    // If the model *printed* JSON tool calls, execute them
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
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.bodyText });
        }
        continue;
      }
    }

    // Normal function-calling path
    if (msg.tool_calls?.length) {
      messages.push({ role: "assistant", tool_calls: msg.tool_calls, content: msg.content || "" });

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
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.bodyText });
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
      console.log("\nPlatform Assistant:\n", msg.content.trim());
      if (assistantWantsReply(typeof msg.content === "string" ? msg.content : "")) {
        const answer = await ask("> ");
        // no need to echo the assistant message back into history
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
const userText = process.argv.slice(2).join(" ").trim()
  || "Create RG rg-demo in usgovvirginia";

run(userText).catch((e) => {
  console.error(e);
  process.exit(1);
});