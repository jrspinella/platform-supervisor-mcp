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

// Azure/OpenAI client (OpenAI SDK v4)
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
  // Standard OpenAI
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY!,
    baseURL: process.env.OPENAI_BASE_URL, // optional
  });
}

// Single generic tool that proxies to the Router
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
  if (typeof name !== "string" || !name.trim()) {
    return {
      httpStatus: 400,
      contentType: "application/json",
      bodyText: JSON.stringify({ error: "router.call_tool: missing or invalid 'name'", args }),
    };
  }
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args || {} }),
  });
  const text = await r.text();

  // Log to your console for debugging
  console.log(`[supervisor→router] ${name} -> ${r.status} ${r.headers.get("content-type")} body=${text.slice(0, 200)}…`);

  // Wrap the upstream response so the model can reason about it
  const envelope = {
    ok: r.ok,
    status: r.status,
    contentType: r.headers.get("content-type") || "",
    raw: text
  };
  return {
    httpStatus: r.status,
    contentType: "application/json",
    bodyText: JSON.stringify(envelope)
  };
}

// --- Helper: if the model prints tool-call JSON blocks, parse them ---
function tryParseInlineToolCalls(text?: string) {
  if (!text) return [] as Array<{ name: string; arguments: any }>;
  const calls: Array<{ name: string; arguments: any }> = [];
  const re = /```json\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[1]
      // strip line comments the model might add
      .split(/\r?\n/).map(l => l.replace(/\/\/.*$/, "")).join("\n")
      .trim();
    try {
      const obj = JSON.parse(raw);
      // Accept common shapes:
      // { "name":"router.call_tool", "arguments":{...} }
      if (obj?.name && obj?.arguments) {
        calls.push({ name: obj.name, arguments: obj.arguments });
        continue;
      }
      // { "function": { "name":"...", "arguments":"{...}" } }
      if (obj?.function?.name && obj?.function?.arguments) {
        const args = typeof obj.function.arguments === "string"
          ? JSON.parse(obj.function.arguments)
          : obj.function.arguments;
        calls.push({ name: obj.function.name, arguments: args });
        continue;
      }
    } catch {
      // ignore parse error and keep scanning
    }
  }
  return calls;
}

// --- Helper: extract onboarding params from free-text user input ---
function extractOnboardingHints(text: string | null | undefined) {
  if (!text || typeof text !== "string") return null;
  const upn = /UPN\s+([^\s,;]+)/i.exec(text)?.[1];
  const alias = /alias\s+([^\s,;]+)/i.exec(text)?.[1];
  const region = /region\s+([^\s,;]+)/i.exec(text)?.[1];
  const dryRun = /dry\s*run/i.test(text);
  if (!upn || !alias) return null;
  return {
    playbookId: "mission-owner",
    user: { upn, alias, region },
    dryRun
  };
}

// ---------- Conversation loop ----------
async function run(userInput: string) {
  const client = makeClient();

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userInput },
  ];

  // Up to N rounds to allow Q&A + tool calls
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

    // --- SAFETY NET: if the model printed tool-call JSON, execute it anyway ---
    if (!msg.tool_calls?.length) {
      const planned = tryParseInlineToolCalls(typeof msg.content === "string" ? msg.content : undefined);
      if (planned.length) {
        const fakeCalls = planned.map((p, i) => ({
          id: `inline_${Date.now()}_${i}`,
          type: "function" as const,
          function: {
            name: "router.call_tool",
            arguments: JSON.stringify({ name: p.name, arguments: p.arguments }),
          },
        }));
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: fakeCalls });
        for (const tc of fakeCalls) {
          const { name, arguments: args } = JSON.parse(tc.function.arguments);
          const result = await callRouterTool(name, args);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.bodyText });
        }
        continue; // let the model read tool results
      }
    }

    // --- EMPTY RESPONSE FALLBACK: nudge or perform first steps ---
    if ((!msg.tool_calls || msg.tool_calls.length === 0) && (!msg.content || !String(msg.content).trim())) {
      console.warn("[WARN] Model returned empty message; applying fallback.");
      // Try to parse onboarding details from the very first user message
      const firstUser = messages.find(m => m.role === "user")?.content as string | undefined;
      const hints = extractOnboardingHints(firstUser);

      if (hints) {
        // Perform the minimal onboarding steps directly (start_run + get_checklist)
        const calls = [
          { name: "onboarding.start_run", arguments: { playbookId: hints.playbookId, user: hints.user } },
          { name: "onboarding.get_checklist", arguments: { playbookId: hints.playbookId, user: hints.user } },
        ];
        const fakeCalls = calls.map((p, i) => ({
          id: `fallback_${Date.now()}_${i}`,
          type: "function" as const,
          function: { name: "router.call_tool", arguments: JSON.stringify(p) },
        }));
        messages.push({ role: "assistant", content: "", tool_calls: fakeCalls });
        for (const tc of fakeCalls) {
          const { name, arguments: args } = JSON.parse(tc.function.arguments);
          const result = await callRouterTool(name, args);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.bodyText });
        }
        continue; // let the model read results and continue
      }

      // If we can't parse, nudge the model to act and try again
      messages.push({
        role: "system",
        content:
          "Reminder: You must take action using tool_calls. Do not print raw JSON. " +
          "For onboarding requests, first call 'onboarding.start_run' with playbookId='mission-owner' " +
          "and a user object parsed from the message, then call 'onboarding.get_checklist'.",
      });
      continue;
    }

    // 1) Tool Calls?
    if (msg.tool_calls?.length) {
      // Push the assistant message that *requested* tool calls
      messages.push({
        role: "assistant",
        tool_calls: msg.tool_calls,
        content: msg.content || "",
      });

      // Execute each tool call and push a corresponding tool message
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

          // The tool content is a string (bodyText). The model can read + decide next step.
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result.bodyText,
          });
        } else {
          // Unknown function; return a minimal error
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Unknown function ${fn}` }),
          });
        }
      }
      // Continue loop so the model can read tool results and respond/ask more
      continue;
    }

    // 2) Model answered with text (no tool call)
    if (msg.content && msg.content.length > 0) {
      // Print the assistant’s reply
      console.log("\nPlatform Assistant:\n", msg.content.trim());

      // If assistant asked a question, collect user reply and continue
      if (/\?\s*$/.test(msg.content.trim())) {
        const answer = await ask("> ");
        messages.push({ role: "assistant", content: msg.content }); // echo for context
        messages.push({ role: "user", content: answer });
        continue;
      }

      // Otherwise we’re done
      break;
    }

    // Fallback: nothing useful returned
    console.log("No content from model; exiting.");
    break;
  }

  rl.close();
}

// ---------- Entry ----------
const userText = process.argv.slice(2).join(" ").trim()
  || "I am a new mission owner. Onboard me. UPN jdoe@contoso.gov alias jdoe region usgovvirginia";

run(userText).catch((e) => {
  console.error(e);
  process.exit(1);
});
