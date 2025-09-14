import * as vscode from 'vscode';

type RouterRoute = {
  tool: string;
  args: Record<string, any>;
  rationale?: string;
};

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  error?: { code: number; message: string };
  result?: any;
}

// ---------- JSON-RPC helpers ----------
async function callJsonRpc(url: string, method: string, params: any, signal?: AbortSignal) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    signal
  });
  if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
  const j = await r.json() as JsonRpcResponse;
  if (j.error) {
    const err: any = new Error(`${method}: ${j.error?.message || 'error'}`);
    err.rpc = j.error;
    throw err;
  }
  return j.result;
}

async function detectPlatformCallMethod(platformUrl: string, signal?: AbortSignal): Promise<string> {
  try { await callJsonRpc(platformUrl, 'tools.list', {}, signal); return 'tools.call'; } catch {}
  const candidates = ['tools.call', 'tool.call', 'tools.invoke', 'mcp.callTool'];
  for (const m of candidates) {
    try {
      await callJsonRpc(platformUrl, m, { name: '__probe__', arguments: {} }, signal);
      return m;
    } catch (e: any) {
      if (e?.rpc?.code === -32601) continue; // method not found
      return m; // method exists (bad params)
    }
  }
  throw new Error(`No compatible Platform call method found at ${platformUrl}`);
}

async function callPlatformTool(platformUrl: string, callMethod: string, tool: string, args: any, signal?: AbortSignal) {
  return callJsonRpc(platformUrl, callMethod, { name: tool, arguments: args }, signal);
}

// ---------- Small helpers ----------
function safeStringify(x: any) {
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
}
function hasOnlyMetaJson(j: any) {
  if (!j || typeof j !== 'object') return false;
  // suppress common meta payloads unless user opts in
  const keys = Object.keys(j);
  const metaKeys = new Set(['status','progress','summary','filters','scope','profile']);
  return keys.length > 0 && keys.every(k => metaKeys.has(k));
}

// Pull quick actions from a JSON content block
function extractActions(contents: Array<{type:string; json?:any; text?:string}>) {
  const actions: Array<{ label: string; tool: string; args: any; note?: string }> = [];
  for (const c of contents) {
    if (c.type === 'json' && c.json && Array.isArray(c.json.__actions)) {
      for (const a of c.json.__actions) actions.push(a);
    }
  }
  return actions;
}

// Group findings by resource for better “Remediate” fallbacks
function groupFindingsByResource(findings: any[]) {
  const by: Record<string, { kind: 'webapp'|'appplan'|'other'; name: string; rg?: string; items: any[] }> = {};
  for (const f of findings || []) {
    const m = f.meta || {};
    const name = m.webAppName || m.appServicePlanName || m.name || 'unknown';
    const rg = m.resourceGroupName;
    const key = `${rg || ''}/${name}`;
    const kind = m.webAppName ? 'webapp' : m.appServicePlanName ? 'appplan' : 'other';
    if (!by[key]) by[key] = { kind: kind as any, name, rg, items: [] };
    by[key].items.push(f);
  }
  return by;
}

// ---------- Activate participant ----------
export function activate(ctx: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant('platform.supervisor',
    async (request, _context, stream, token) => {
      const cfg = vscode.workspace.getConfiguration('platformSupervisor');
      const routerUrl   = String(cfg.get('routerUrl')   || 'http://127.0.0.1:8701/rpc');
      const platformUrl = String(cfg.get('platformUrl') || 'http://127.0.0.1:8721/rpc');
      const showRawJson = Boolean(cfg.get('showRawJson') || false);

      const controller = new AbortController();
      const signal = controller.signal;
      token.onCancellationRequested(() => controller.abort());

      try {
        const text = String(request.prompt ?? '').trim();

        // 1) Route
        stream.progress(`Routing via ${routerUrl}…`);
        const route: RouterRoute = await callJsonRpc(routerUrl, 'nl.route', { instruction: text }, signal);

        if (route.rationale) stream.markdown(`> ${route.rationale}\n`);

        // 2) Detect platform call surface
        stream.progress(`Detecting Platform RPC at ${platformUrl}…`);
        const callMethod = await detectPlatformCallMethod(platformUrl, signal);
        stream.progress(`Using method **${callMethod}**`);

        // 3) Call the tool
        stream.progress(`Calling ${route.tool}…`);
        const callRes = await callPlatformTool(platformUrl, callMethod, route.tool, route.args, signal);

        const contents: Array<{type:string; json?:any; text?:string}> = (callRes?.content ?? []) as any[];

        // Render content: prefer markdown; suppress purely-meta JSON when showRawJson=false
        for (const c of contents) {
          if (token.isCancellationRequested) return { metadata: { status: 'cancelled' } };
          if (c.type === 'text' && c.text) {
            stream.markdown(c.text);
            continue;
          }
          if (c.type === 'json' && c.json) {
            // Render buttons if __actions present
            if (Array.isArray(c.json.__actions) && c.json.__actions.length) {
              stream.markdown('**Quick actions**');
              for (const a of c.json.__actions) {
                stream.button({
                  title: a.label || a.tool,
                  command: 'platform.runAction',
                  arguments: [{ platformUrl, callMethod, tool: a.tool, args: a.args }]
                });
                if (a.note) stream.markdown(`_Note: ${a.note}_`);
              }
              continue; // don’t dump the JSON block itself
            }

            if (!showRawJson && hasOnlyMetaJson(c.json)) {
              // Light meta summary instead of raw JSON
              if (c.json.status) stream.markdown(`**Plan status:** \`${c.json.status}\``);
              if (Array.isArray(c.json.progress)) {
                const rows = c.json.progress
                  .map((p: any) => `| ${p.step + 1} | \`${p.tool}\` | ${p.status === 'ok' ? '✅ ok' : '⛔️ error'} |`)
                  .join('\n');
                stream.markdown(['', '**Steps**', '', '| # | Tool | Result |', '|---|---|---|', rows, ''].join('\n'));
              }
              continue;
            }

            // Otherwise, show raw JSON
            stream.markdown('```json\n' + safeStringify(c.json) + '\n```');
          }
        }

        // 4) Fallback remediation buttons (if server didn’t send __actions but there are findings)
        const findings = contents.find(c => c.type === 'json' && c.json?.findings)?.json?.findings ?? [];
        if (Array.isArray(findings) && findings.length) {
          const actionsFromServer = extractActions(contents);
          if (!actionsFromServer.length) {
            const by = groupFindingsByResource(findings);
            stream.markdown(`**Findings:** ${findings.length}`);
            for (const key of Object.keys(by)) {
              const g = by[key];
              if (!g.rg || !g.name) continue;
              const isWeb = g.kind === 'webapp';
              const tool = isWeb ? 'platform.remediate_webapp_baseline' : 'platform.remediate_appplan_baseline';
              stream.button({
                title: `Remediate ${isWeb ? 'Web App' : 'Plan'} (${g.name}) — dry run`,
                command: 'platform.runAction',
                arguments: [{ platformUrl, callMethod, tool, args: { resourceGroupName: g.rg, name: g.name, dryRun: true } }]
              });
              stream.button({
                title: `Apply remediation to ${g.name}`,
                command: 'platform.runAction',
                arguments: [{ platformUrl, callMethod, tool, args: { resourceGroupName: g.rg, name: g.name, dryRun: false } }]
              });
            }
          }
        }

        return { metadata: { status: 'ok' } };
      } catch (e: any) {
        const detail = e?.rpc ? ` (code ${e.rpc.code})` : '';
        stream.markdown('⚠️ **Error**: ' + (e?.message || String(e)) + detail);
        return { metadata: { status: 'error' } };
      }
    }
  );

  // ---------- Button command: run a quick action ----------
  ctx.subscriptions.push(
    vscode.commands.registerCommand('platform.runAction', async ({ platformUrl, callMethod, tool, args }) => {
      if (!platformUrl || !callMethod || !tool) {
        return vscode.window.showWarningMessage('Missing action context.');
      }
      const label = args?.dryRun ? 'Planning remediation…' : 'Applying remediation…';
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: label }, async () => {
        const res = await callJsonRpc(platformUrl, callMethod, { name: tool, arguments: args });
        // show a toast; you can parse res.content for richer feedback
        if (args?.dryRun) vscode.window.showInformationMessage('Remediation plan generated. Review output above.');
        else vscode.window.showInformationMessage('Remediation applied. Re-run a scan to verify.');
      });
    })
  );
}

export function deactivate() {}