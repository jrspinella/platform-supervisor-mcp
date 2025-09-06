import "dotenv/config";
import fetch from "node-fetch";
import readline from "node:readline";
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "./prompts/system.js";

// ---------- Config ----------
const ROUTER_URL = process.env.ROUTER_URL || "http://127.0.0.1:8700";
const PROVIDER = process.env.AI_PROVIDER || "azure"; // "azure" | "openai"
const DESTRUCTIVE_PREFIX = /^(azure|github|teams)\./; // tools that modify state
const MODEL =
  process.env.AZURE_OPENAI_DEPLOYMENT ||
  process.env.OPENAI_MODEL ||
  "gpt-4o";

// --- consent & parsing helpers ---
let CONSENT_GRANTED = false;      // flips to true after user says "yes"
let ASKED_FOR_CONSENT = false;    // ensure we only ask once per run
let DRY_RUN_ONLY = false;         // user chose dry run
let CONSENT_MODE: "none" | "exec" | "dry" | "deny" = "none"; // for model hinting

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

async function preflight(name: string, args: any) {
  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "governance.preflight",
      arguments: { action: name, params: args || {} }
    })
  });
  const json = await r.json().catch(() => ({})) as any;
  const result = json?.result?.content?.find((c: any) => c.json)?.json;
  return result as { allow: boolean; reasons: string[] } | undefined;
}

async function callRouterTool(name: string, args: any) {
  if (typeof name !== "string" || !name.trim()) {
    return {
      httpStatus: 400,
      contentType: "application/json",
      bodyText: JSON.stringify({ error: "router.call_tool: missing or invalid 'name'", args }),
    };
  }

  // Block destructive tools until consent
  if (!CONSENT_GRANTED && (DESTRUCTIVE_PREFIX.test(name) || (name.startsWith("onboarding.") && !isSafeBeforeConsent(name)))) {
    const LAST_ACTION_WAITING_CONSENT = name; // <— remember what was blocked
    const blocking = {
      error: "consent_required",
      message: "User must acknowledge the onboarding summary before executing this tool.",
      name,
      arguments: args ?? {}
    };
    return {
      httpStatus: 403,
      contentType: "application/json",
      bodyText: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), error: { code: -32001, message: "Consent required", data: blocking } })
    };
  }

  // Simulate side effects if user chose "dry run"
  if (DRY_RUN_ONLY && (DESTRUCTIVE_PREFIX.test(name))) {
    const simulated = { simulated: true, name, arguments: args ?? {} };
    return {
      httpStatus: 200,
      contentType: "application/json",
      bodyText: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), result: { content: [{ type: "json", json: simulated }] } })
    };
  }

  // Governance preflight: block early if policy denies
  if (DESTRUCTIVE_PREFIX.test(name)) {
    const pf = await preflight(name, args);
    if (pf && pf.allow === false) {
      return {
        httpStatus: 403,
        contentType: "application/json",
        bodyText: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          error: { code: -32002, message: "Governance preflight denied", data: { reasons: pf.reasons, action: name, args } }
        })
      };
    }
  }

  const r = await fetch(`${ROUTER_URL}/a2a/tools/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args || {} }),
  });
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();

  // Log to your console for debugging
  console.log(`[supervisor→router] ${name} -> ${r.status} ${ct} body=${text.slice(0, 200)}…`);

  // If upstream is JSON, pass it straight through so the model can read it.
  if (ct.includes("application/json")) {
    return { httpStatus: r.status, contentType: ct, bodyText: text };
  }

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
    user: { upn, alias },
    region,
    dryRun
  };
}

function tryParseJSON<T = any>(s: string): T | null {
  try { return JSON.parse(s); } catch { return null; }
}

function extractSummaryFromTool(bodyText: string): string | null {
  // Accept either passthrough JSON or the old envelope-with-raw
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

// Which tools are allowed before consent (safe, read-only, or planning)
const SAFE_BEFORE_CONSENT = [
  /^onboarding\.list_playbooks$/,
  /^onboarding\.describe_playbook$/,
  /^onboarding\.get_checklist$/,
  /^onboarding\.start_run$/,
  /^onboarding\.get_run$/,
  /^onboarding\.validate_playbooks$/,
];



function isSafeBeforeConsent(name: string) {
  return SAFE_BEFORE_CONSENT.some(re => re.test(name));
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

        // Add the assistant-with-tool_calls message
        messages.push({ role: "assistant", content: msg.content || "", tool_calls: fakeCalls });

        // Execute ALL and push corresponding tool messages
        let collectedSummary: string | null = null;
        for (const tc of fakeCalls) {
          const { name, arguments: args } = JSON.parse(tc.function.arguments);
          const result = await callRouterTool(name, args);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result.bodyText });
          // If the router blocked execution for consent, prompt right away
          try {
            const payload = JSON.parse(result.bodyText);
            const root = payload.raw ? JSON.parse(payload.raw) : payload;
            const err = root?.error;

            if (err && (err.code === -32001 || /consent required/i.test(err.message || ""))) {
              // We got blocked. If we've already asked once, don't ask again—just apply the current mode.
              if (ASKED_FOR_CONSENT) {
                const auto = CONSENT_MODE === "dry" ? "dry run" : CONSENT_MODE === "exec" ? "yes" : "no";
                messages.push({ role: "user", content: auto });
                continue;
              }

              // First time: ask the user
              console.log("\nThis action requires your acknowledgment.");
              const ans = (await ask("Type 'yes' to continue, 'dry run' to simulate, or 'no' to cancel: ")).trim().toLowerCase();

              ASKED_FOR_CONSENT = true;
              if (ans.startsWith("y")) {
                CONSENT_GRANTED = true;
                DRY_RUN_ONLY = false;
                CONSENT_MODE = "exec";
                messages.push({ role: "system", content: "[consent] mode=exec" }); // hint the model to stop asking
                messages.push({ role: "user", content: "yes" });
              } else if (ans.startsWith("dry")) {
                CONSENT_GRANTED = true;
                DRY_RUN_ONLY = true;
                CONSENT_MODE = "dry";
                messages.push({ role: "system", content: "[consent] mode=dry" });
                messages.push({ role: "user", content: "dry run" });
              } else {
                CONSENT_GRANTED = false;
                DRY_RUN_ONLY = true; // safest
                CONSENT_MODE = "deny";
                messages.push({ role: "system", content: "[consent] mode=deny" });
                messages.push({ role: "user", content: "no" });
              }

              const LAST_ACTION_WAITING_CONSENT = null; // clear
              continue;
            }
          } catch { /* non-JSON upstream: ignore */ }
          const s = extractSummaryFromTool(result.bodyText);
          if (s && !collectedSummary) collectedSummary = s;
        }

        // Consent AFTER all tool messages
        if (collectedSummary && !ASKED_FOR_CONSENT) {
          console.log(`\nOnboarding Summary:\n ${collectedSummary}\n`);
          const ans = (await ask("Proceed with these actions? Type 'yes' to continue, 'dry run' to simulate, or 'no' to stop: ")).trim().toLowerCase();

          ASKED_FOR_CONSENT = true;
          if (ans.startsWith("y")) {
            CONSENT_GRANTED = true;
            DRY_RUN_ONLY = false;
            messages.push({ role: "user", content: "I acknowledge the plan. Proceed with execution." });
          } else if (ans.startsWith("dry")) {
            CONSENT_GRANTED = true;
            DRY_RUN_ONLY = true;
            messages.push({ role: "user", content: "I acknowledge the plan. Proceed in dry run mode only." });
          } else {
            CONSENT_GRANTED = false;
            DRY_RUN_ONLY = true;
            messages.push({ role: "user", content: "I do not consent to execute. Do not make changes." });
          }
        }

        continue; // let model read results and proceed
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
          { name: "onboarding.start_run", arguments: { playbookId: hints.playbookId, user: hints.user, region: hints.region } },
          { name: "onboarding.get_checklist", arguments: { playbookId: hints.playbookId, user: hints.user, region: hints.region } },
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
    // 1) Tool Calls?
    if (msg.tool_calls?.length) {
      // Push the assistant message that *requested* tool calls
      messages.push({
        role: "assistant",
        tool_calls: msg.tool_calls,
        content: msg.content || "",
      });

      // Execute ALL tool calls first
      let collectedSummary: string | null = null;

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

          // ALWAYS push a tool message for this specific tool_call_id
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result.bodyText,
          });

          // Collect a summary if present (for consent UX)
          const s = extractSummaryFromTool(result.bodyText);
          if (s && !collectedSummary) collectedSummary = s;
        } else {
          // Unknown function; still satisfy the tool_call_id
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: `Unknown function ${fn}` }),
          });
        }
      }

      // Now that ALL tool messages are appended, you may ask for consent once
      if (collectedSummary && !ASKED_FOR_CONSENT) {
        console.log(`\nOnboarding Summary:\n ${collectedSummary}\n`);
        const ans = (await ask("Proceed with these actions? Type 'yes' to continue, 'dry run' to simulate, or 'no' to stop: ")).trim().toLowerCase();

        ASKED_FOR_CONSENT = true;
        if (ans.startsWith("y")) {
          CONSENT_GRANTED = true;
          DRY_RUN_ONLY = false;
          messages.push({ role: "user", content: "I acknowledge the plan. Proceed with execution." });
        } else if (ans.startsWith("dry")) {
          CONSENT_GRANTED = true;   // allow tools
          DRY_RUN_ONLY = true;      // simulate destructive calls
          messages.push({ role: "user", content: "I acknowledge the plan. Proceed in dry run mode only." });
        } else {
          CONSENT_GRANTED = false;
          DRY_RUN_ONLY = true;      // safest default
          messages.push({ role: "user", content: "I do not consent to execute. Do not make changes." });
        }
      }

      // Let the model read tool results (and any consent reply) and continue
      continue;
    }

    // 2) Model answered with text (no tool call)
    if (msg.content && msg.content.length > 0) {
      // Print the assistant’s reply
      console.log("\nPlatform Assistant:\n", msg.content.trim());

      // If assistant asked a question, collect user reply and continue
      const text = (msg.content || "").trim();
      const wantsReply =
        /\?\s*$/.test(text) ||
        /:\s*$/.test(text) ||
        /\b(confirm|consent|proceed|continue|approve|acknowledge)\b/i.test(text) ||
        /Type\s+['"“”]?(yes|no|dry run)/i.test(text);

      // If we've already settled consent, auto-answer to avoid circular confirmations
      if (wantsReply && (ASKED_FOR_CONSENT || CONSENT_GRANTED || CONSENT_MODE !== "none")) {
        const auto = CONSENT_MODE === "dry" ? "dry run" : CONSENT_MODE === "exec" ? "yes" : "no";
        messages.push({ role: "assistant", content: msg.content });
        messages.push({ role: "user", content: auto });
        continue;
      }

      // Otherwise, prompt the user once
      if (wantsReply) {
        const answer = await ask("> ");
        // If the user replied with a consent keyword, lock it in
        const a = answer.trim().toLowerCase();
        if (/(^yes$)|(^y$)/i.test(a)) { CONSENT_GRANTED = true; DRY_RUN_ONLY = false; CONSENT_MODE = "exec"; ASKED_FOR_CONSENT = true; }
        else if (/^dry/.test(a)) { CONSENT_GRANTED = true; DRY_RUN_ONLY = true; CONSENT_MODE = "dry"; ASKED_FOR_CONSENT = true; }
        else if (/(^no$)|(^n$)/i.test(a)) { CONSENT_GRANTED = false; DRY_RUN_ONLY = true; CONSENT_MODE = "deny"; ASKED_FOR_CONSENT = true; }

        messages.push({ role: "assistant", content: msg.content });
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
