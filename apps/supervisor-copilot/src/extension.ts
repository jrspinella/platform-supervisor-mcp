import * as vscode from "vscode";

/* ─────────────────────────── JSON-RPC helpers ─────────────────────────── */

type JsonRpcResponse = {
  jsonrpc: string;
  id: number;
  error?: { code: number; message: string };
  result?: any;
};

async function callJsonRpc(url: string, method: string, params: any, signal?: AbortSignal) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal,
  });
  if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
  const j = (await r.json()) as JsonRpcResponse;
  if (j.error) {
    const err: any = new Error(`${method}: ${j.error.message}`);
    err.rpc = j.error;
    throw err;
  }
  return j.result;
}

async function detectCallMethod(endpoint: string, signal?: AbortSignal): Promise<string> {
  try {
    await callJsonRpc(endpoint, "tools.list", {}, signal);
    return "tools.call";
  } catch (_) { }
  const candidates = ["tools.call", "tool.call", "tools.invoke", "mcp.callTool"];
  for (const m of candidates) {
    try {
      await callJsonRpc(endpoint, m, { name: "__probe__", arguments: {} }, signal);
      return m;
    } catch (e: any) {
      if (e?.rpc?.code === -32601) continue; // method not found → try next
      return m; // any other error implies method exists but wrong params
    }
  }
  throw new Error(`No compatible call method found at ${endpoint}`);
}

function showRpcError(stream: VSStream, e: any, hint?: string) {
  const detail = e?.rpc ? ` (code ${e.rpc.code})` : "";
  stream.markdown(`⚠️ **Error:** ${e?.message || String(e)}${detail}`);
  if (hint) stream.markdown(hint);
}

/* ─────────────────────────── UX helpers ─────────────────────────── */

type VSStream = {
  progress: (text: string) => void;
  markdown: (md: string) => void;
  button: (b: { title: string; command: string; arguments?: any[] }) => void;
};

type McpContent = { type: "text"; text: string } | { type: "json"; json: any };

function isJsonContent(content: McpContent): content is { type: "json"; json: any } {
  return content.type === "json";
}

function renderMcpContents(stream: VSStream, content: McpContent[], request: { prompt: string }) {
  const cfg = vscode.workspace.getConfiguration('platformSupervisor');
  const allowJsonBySetting = !!cfg.get<boolean>('showJson');
  const userWantsJson = /\b--json\b/i.test((request.prompt ?? '') as string);
  const shouldShowJson = allowJsonBySetting || userWantsJson;

  renderContentChunks(stream, content, { showJson: shouldShowJson });
}

// --- helpers at top of file (or in a small util) -----------------------------

function normalizeForDedup(s: string): string {
  return (s || "")
    .replace(/```json[\s\S]*?```/gi, "")   // strip any fenced JSON blocks
    .replace(/```[\s\S]*?```/g, "")        // strip any other fenced blocks
    .replace(/\s+/g, " ")                  // collapse whitespace
    .trim()
    .toLowerCase();
}

/** Render content chunks, hiding JSON and deduping repeated text. */
function renderContentChunks(
  stream: { markdown: (md: string) => void },
  contents: Array<{ type: "text" | "json"; text?: string; json?: any }>,
  opts?: { showJson?: boolean }
) {
  const showJson = !!opts?.showJson;
  const seen = new Set<string>();

  for (const c of contents || []) {
    if (c.type === "json") {
      if (showJson) {
        stream.markdown("```json\n" + JSON.stringify(c.json, null, 2) + "\n```");
      }
      continue; // always skip when not showing JSON
    }

    // c.type === "text"
    let t = String(c.text || "");

    // If the tool accidentally inlined raw JSON, hide it unless showJson=true
    if (!showJson) {
      // remove fenced JSON blocks
      t = t.replace(/```json[\s\S]*?```/gi, "")
        .replace(/```[\s\S]*?```/g, ""); // also remove any other fenced code to avoid leaking JSON
      // if a bare JSON object slipped in without fences, drop lines that start with "{"
      if (/^\s*\{[\s\S]*\}\s*$/.test(t.trim())) {
        continue;
      }
    }

    // de-dup identical-ish text (e.g., presenter run twice)
    const key = normalizeForDedup(t);
    if (!key) continue; // became empty after stripping
    if (seen.has(key)) continue;
    seen.add(key);

    stream.markdown(t);
  }
}

function pickFindings(stream: VSStream, contents: McpContent[], token: vscode.CancellationToken): any[] {
  // Look for a JSON chunk with `findings`
  if (token.isCancellationRequested) return [];
  for (const c of contents) {
    if (isJsonContent(c) && c.json?.findings && Array.isArray(c.json.findings)) {
      return c.json.findings;
    }
  }
  return [];
}

/* ─────────────────────────── Platform participant ─────────────────────────── */

async function platformHandler(
  request: { prompt: string },
  stream: VSStream,
  token: vscode.CancellationToken
) {
  const cfg = vscode.workspace.getConfiguration("platformSupervisor");
  const routerUrl = String(cfg.get("routerUrl") || "http://127.0.0.1:8701/rpc");
  const platformUrl = String(cfg.get("platformUrl") || "http://127.0.0.1:8721/rpc");

  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  const { signal } = controller;

  const text = (request.prompt ?? "").trim();
  if (!text) {
    stream.markdown("Type what you want to do, e.g.:\n\n- `create a resource group rg-foo in usgovvirginia`\n- `scan app workloads in rg-foo`\n- `create a web app web-foo on plan plan-foo in rg-foo, runtime NODE|20-lts`");
    return { metadata: { status: "no-input" } };
  }

  try {
    // 1) Route NL → { tool, args }
    stream.progress(`Routing via ${routerUrl}…`);
    const route = await callJsonRpc(routerUrl, "nl.route", { instruction: text }, signal);
    stream.markdown(route.rationale ? `> ${route.rationale}` : "");

    // 2) Discover call method once
    stream.progress(`Detecting Platform RPC at ${platformUrl}…`);
    const callMethod = await detectCallMethod(platformUrl, signal);
    stream.progress(`Using method **${callMethod}**`);

    // 3) Call tool
    stream.progress(`Calling \`${route.tool}\`…`);
    const result = await callJsonRpc(platformUrl, callMethod, { name: route.tool, arguments: route.args }, signal);

    const contents: McpContent[] = Array.isArray(result?.content) ? result.content : [];
    renderMcpContents(stream, contents, request);

    // 4) Offer remediation buttons if scan findings exist
    const findings = pickFindings(stream, contents, token);
    if (findings.length) {
      stream.markdown(`**Findings:** ${findings.length}`);
      stream.button({
        title: "Remediate (plan)",
        command: "platform.remediatePlan",
        arguments: [{ findings, args: route.args, platformUrl, callMethod }],
      });
      stream.button({
        title: "Remediate (apply)",
        command: "platform.remediateApply",
        arguments: [{ findings, args: route.args, platformUrl, callMethod }],
      });
    }

    return { metadata: { status: "ok" } };
  } catch (e: any) {
    showRpcError(
      stream,
      e,
      `\n_Check settings in **Platform Engineering Agent**: routerUrl=${routerUrl}, platformUrl=${platformUrl}_`
    );
    return { metadata: { status: "error" } };
  }
}

/* ─────────────────────── Mission Owner participant ─────────────────────── */

async function missionOwnerHandler(
  request: { prompt: string },
  stream: VSStream,
  token: vscode.CancellationToken
) {
  const cfg = vscode.workspace.getConfiguration("platformSupervisor");

  // New: allow a dedicated mission router URL, else fall back to the platform router
  const missionRouterUrl =
    String(cfg.get("missionRouterUrl") || cfg.get("routerUrl") || "http://127.0.0.1:8701/rpc");

  const missionUrl = String(cfg.get("missionUrl") || "http://127.0.0.1:8731/rpc");

  const controller = new AbortController();
  token.onCancellationRequested(() => controller.abort());
  const { signal } = controller;

  const text = (request.prompt ?? "").trim();
  if (!text) {
    stream.markdown(
      "Tell me what you want to do, e.g.:\n\n" +
      "- `create a private repo org:my-org name:my-app and a dev env`\n" +
      "- `scan repo my-org/my-app for CI policy`\n" +
      "- `create rg rg-my-app in usgovvirginia, plan plan-my-app P1v3, web web-my-app runtime NODE|20-lts`"
    );
    return { metadata: { status: "no-input" } };
  }

  try {
    // 1) Route NL → { tool, args } via Mission Router (preferred)
    let route: { tool: string; args: any; rationale?: string };
    try {
      stream.progress(`Routing (mission) via ${missionRouterUrl}…`);
      route = await callJsonRpc(missionRouterUrl, "nl.route", { instruction: text }, signal);
      if (route?.rationale) stream.markdown(`> ${route.rationale}`);
    } catch (e) {
      // Fallback to the old “wizard heuristic” if no router
      stream.markdown("> mission router unavailable — falling back to wizard defaults");
      const defaults = {
        org: "your-org",
        repo: "hello-dev-wizard",
        createRepo: true,
        visibility: "private",
        environmentName: "dev",
        resourceGroupName: "rg-dev-wizard",
        location: "usgovvirginia",
        appServicePlanName: "plan-dev-wizard",
        webAppName: "web-dev-wizard",
        sku: "P1v3",
        runtime: "NODE|20-lts",
        addWorkflow: true,
        applyAzure: true,
        tags: { owner: "you@example.com", env: "dev" },
      };
      route = { tool: "developer.dev_env_wizard", args: defaults, rationale: "wizard fallback" };
    }

    // 2) Discover developer MCP call method
    stream.progress(`Detecting Developer (Mission Owner) RPC at ${missionUrl}…`);
    const callMethod = await detectCallMethod(missionUrl, signal);
    stream.progress(`Using method **${callMethod}**`);

    // 3) Call routed tool on developer MCP
    stream.progress(`Calling \`${route.tool}\`…`);
    const result = await callJsonRpc(
      missionUrl,
      callMethod,
      { name: route.tool, arguments: route.args },
      signal
    );

    const contents: McpContent[] = Array.isArray(result?.content) ? result.content : [];
    renderMcpContents(stream, contents, request);

    // (optional) look for scan findings and offer remediation buttons if your developer MCP returns any
    const findings = pickFindings(stream, contents, token);
    if (findings.length) {
      stream.markdown(`**Findings:** ${findings.length}`);
      stream.button({
        title: "Remediate (plan)",
        command: "platform.remediatePlan",
        arguments: [{ findings, args: route.args, platformUrl: missionUrl, callMethod }],
      });
      stream.button({
        title: "Remediate (apply)",
        command: "platform.remediateApply",
        arguments: [{ findings, args: route.args, platformUrl: missionUrl, callMethod }],
      });
    }

    return { metadata: { status: "ok" } };
  } catch (e: any) {
    showRpcError(
      stream,
      e,
      `\n_Check settings_: missionRouterUrl=${missionRouterUrl}, missionUrl=${missionUrl}`
    );
    return { metadata: { status: "error" } };
  }
}

/* ─────────────────────────────── Commands ─────────────────────────────── */

async function runHealthCommand() {
  const cfg = vscode.workspace.getConfiguration("platformSupervisor");
  const routerUrl = String(cfg.get("routerUrl") || "http://127.0.0.1:8701/rpc");
  const platformUrl = String(cfg.get("platformUrl") || "http://127.0.0.1:8721/rpc");
  const missionUrl = String(cfg.get("missionUrl") || "http://127.0.0.1:8731/rpc");
  const missionRouterUrl = String(cfg.get("missionRouterUrl") || routerUrl); // NEW

  const ping = async (url: string) => {
    try {
      await callJsonRpc(url, "tools.list", {});
      return "✅";
    } catch (e: any) {
      return `❌ (${e?.message || e})`;
    }
  };

  const [r, p, m, mr] = await Promise.all([
    ping(routerUrl),
    ping(platformUrl),
    ping(missionUrl),
    ping(missionRouterUrl),
  ]);

  vscode.window.showInformationMessage(
    `Router: ${r}  Platform: ${p}  Mission: ${m}  MissionRouter: ${mr}`
  );
}

async function runRouteOnce() {
  const cfg = vscode.workspace.getConfiguration("platformSupervisor");

  // Router: prefer missionRouterUrl if set, else routerUrl
  const routerUrl = String(cfg.get("missionRouterUrl") || cfg.get("routerUrl") || "http://127.0.0.1:8701/rpc");
  const platformUrl = String(cfg.get("platformUrl") || "http://127.0.0.1:8721/rpc");
  const missionUrl = String(cfg.get("missionUrl") || "http://127.0.0.1:8731/rpc");

  // cache RPC method per URL (tools.call vs variants)
  const methodCache = new Map<string, string>();
  const detectCallMethodFor = async (url: string) => {
    if (methodCache.has(url)) return methodCache.get(url)!;
    const m = await detectCallMethod(url); // you already have this helper
    methodCache.set(url, m);
    return m;
  };

  const instr = await vscode.window.showInputBox({
    prompt: "Instruction to route & execute (platform/mission)"
  });
  if (!instr) return;

  const out = vscode.window.createOutputChannel("Platform Supervisor");
  out.clear();

  try {
    out.appendLine(`Routing via ${routerUrl} …`);
    const route = await callJsonRpc(routerUrl, "nl.route", { instruction: instr });

    const toolName: string = route?.tool || "";
    const args = route?.args || {};

    // choose backend by tool prefix
    const targetUrl = toolName.startsWith("mission.") ? missionUrl : platformUrl;
    const which = toolName.startsWith("mission.") ? "mission" : "platform";

    out.appendLine(`Tool: ${toolName}`);
    if (route?.rationale) out.appendLine(`Rationale: ${route.rationale}`);
    out.appendLine(`Calling ${which} MCP at ${targetUrl} …`);

    const callMethod = await detectCallMethodFor(targetUrl);

    const result = await callJsonRpc(targetUrl, callMethod, {
      name: toolName,
      arguments: args
    });

    // Render content nicely
    const contents: Array<{ type: "text" | "json"; text?: string; json?: any }> = result?.content ?? [];
    if (!Array.isArray(contents) || contents.length === 0) {
      out.appendLine("(no content)");
    } else {
      for (const c of contents) {
        if (c.type === "text") {
          out.appendLine(c.text ?? "");
        } else if (c.type === "json") {
          out.appendLine("```json");
          out.appendLine(JSON.stringify(c.json ?? {}, null, 2));
          out.appendLine("```");
        }
      }
    }

    out.show(true);
  } catch (e: any) {
    const msg = e?.message || String(e);
    const code = e?.rpc?.code;
    out.appendLine(`⚠️ Error: ${msg}${code !== undefined ? ` (code ${code})` : ""}`);
    out.appendLine(`Check settings: routerUrl=${routerUrl}, platformUrl=${platformUrl}, missionUrl=${missionUrl}`);
    out.show(true);
  }
}

/* ───────────────────────── Remediation commands ───────────────────────── */

async function remediatePlan(args: { findings: any[]; args: any; platformUrl: string; callMethod: string }) {
  const name = args?.args?.name || args?.args?.webAppName || args?.args?.appServicePlanName;
  const rg = args?.args?.resourceGroupName || args?.args?.rg;
  if (!name || !rg) return vscode.window.showWarningMessage("Missing rg/name for remediation.");
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Planning remediation…" }, async () => {
    await callJsonRpc(args.platformUrl, args.callMethod, {
      name: "platform.remediate_webapp_baseline",
      arguments: { resourceGroupName: rg, name, findings: args.findings, dryRun: true },
    });
    vscode.window.showInformationMessage("Remediation plan created.");
  });
}

async function remediateApply(args: { findings: any[]; args: any; platformUrl: string; callMethod: string }) {
  const name = args?.args?.name || args?.args?.webAppName || args?.args?.appServicePlanName;
  const rg = args?.args?.resourceGroupName || args?.args?.rg;
  if (!name || !rg) return vscode.window.showWarningMessage("Missing rg/name for remediation.");
  const ok = await vscode.window.showWarningMessage(`Apply remediation to ${name} in ${rg}?`, { modal: true }, "Apply");
  if (ok !== "Apply") return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Applying remediation…" }, async () => {
    await callJsonRpc(args.platformUrl, args.callMethod, {
      name: "platform.remediate_webapp_baseline",
      arguments: { resourceGroupName: rg, name, findings: args.findings, dryRun: false },
    });
    vscode.window.showInformationMessage("Remediation applied. Re-run a scan to verify.");
  });
}

/* ───────────────────────── Mission helper command ───────────────────────── */

async function missionWizardSample() {
  const cfg = vscode.workspace.getConfiguration("platformSupervisor");
  const missionUrl = String(cfg.get("missionUrl") || "http://127.0.0.1:8731/rpc");
  const callMethod = await detectCallMethod(missionUrl);

  const args = {
    org: "your-org",
    repo: "hello-dev-wizard",
    createRepo: true,
    visibility: "private",
    environmentName: "dev",
    resourceGroupName: "rg-dev-wizard",
    location: "usgovvirginia",
    appServicePlanName: "plan-dev-wizard",
    webAppName: "web-dev-wizard",
    sku: "P1v3",
    runtime: "NODE|20-lts",
    addWorkflow: true,
    applyAzure: true,
    tags: { owner: "you@example.com", env: "dev" },
  };

  const res = await callJsonRpc(missionUrl, callMethod, {
    name: "developer.dev_env_wizard",
    arguments: args,
  });

  const panel = vscode.window.createOutputChannel("Mission Owner Wizard");
  panel.clear();
  panel.appendLine(JSON.stringify(res, null, 2));
  panel.show(true);
}

/* ────────────────────────────── activate() ────────────────────────────── */

export function activate(ctx: vscode.ExtensionContext) {
  // Chat participant: platform.supervisor
  ctx.subscriptions.push(
    vscode.chat.createChatParticipant(
      "platform.supervisor",
      async (request, _context, streamApi, token) => {
        const stream: VSStream = {
          progress: (t) => streamApi.progress(t),
          markdown: (md) => streamApi.markdown(md),
          button: (b) => streamApi.button(b),
        };
        return platformHandler({ prompt: request.prompt }, stream, token);
      }
    )
  );

  // Chat participant: platform.supervisor.missionowner
  ctx.subscriptions.push(
    vscode.chat.createChatParticipant(
      "platform.supervisor.missionowner",
      async (request, _context, streamApi, token) => {
        const stream: VSStream = {
          progress: (t) => streamApi.progress(t),
          markdown: (md) => streamApi.markdown(md),
          button: (b) => streamApi.button(b),
        };
        return missionOwnerHandler({ prompt: request.prompt }, stream, token);
      }
    )
  );

  // Commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand("platform.supervisor.health", runHealthCommand),
    vscode.commands.registerCommand("platform.supervisor.run", runRouteOnce),
    vscode.commands.registerCommand("platform.remediatePlan", remediatePlan),
    vscode.commands.registerCommand("platform.remediateApply", remediateApply),
    vscode.commands.registerCommand("platform.missionowner.wizardSample", missionWizardSample),
  );
}


export function deactivate() { }
