import * as vscode from 'vscode';

type RouterRoute = {
  tool: string;
  args: Record<string, any>;
  rationale?: string;
};

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  error?: {
    code: number;
    message: string;
  };
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
    const msg = j.error?.message || 'error';
    const code = j.error?.code;
    const err: any = new Error(`${method}: ${msg}`);
    err.rpc = j.error;
    throw err;
  }
  return j.result;
}

// Probe which Platform method name exists
async function detectPlatformCallMethod(platformUrl: string, signal?: AbortSignal): Promise<string> {
  // Fast path: if tools.list works, we likely have the “tools.*” surface
  try { await callJsonRpc(platformUrl, 'tools.list', {}, signal); return 'tools.call'; } catch (_) {}

  // Try alternative names used by some servers
  const candidates = ['tools.call', 'tool.call', 'tools.invoke', 'mcp.callTool'];
  for (const m of candidates) {
    try {
      // Dry probe with a harmless method (will  -32602 invalid params, but proves method exists)
      await callJsonRpc(platformUrl, m, { name: '__probe__', arguments: {} }, signal);
      return m;
    } catch (e: any) {
      const code = e?.rpc?.code;
      // -32601 means method not found → keep trying
      if (code === -32601) continue;
      // Any *other* error means the method exists but the params were wrong → accept it
      return m;
    }
  }
  throw new Error(`No compatible Platform call method found at ${platformUrl}`);
}

async function callPlatformTool(platformUrl: string, callMethod: string, tool: string, args: any, signal?: AbortSignal) {
  return callJsonRpc(platformUrl, callMethod, { name: tool, arguments: args }, signal);
}

// ---------- Activate participant ----------
export function activate(ctx: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant('platform.supervisor', async (request, _context, stream, token) => {
    const cfg = vscode.workspace.getConfiguration('platformSupervisor');
    const routerUrl = String(cfg.get('routerUrl') || 'http://127.0.0.1:8700/rpc');
    const platformUrl = String(cfg.get('platformUrl') || 'http://127.0.0.1:8721/rpc');

    // Create AbortSignal from CancellationToken
    const controller = new AbortController();
    const signal = controller.signal;
    token.onCancellationRequested(() => controller.abort());

    try {
      const text = (request.prompt ?? '').trim();

      // 1) Route
      stream.progress(`Routing via ${routerUrl}…`);
      const route = await callJsonRpc(routerUrl, 'nl.route', { instruction: text }, signal);

      stream.markdown([        
        route.rationale ? `> ${route.rationale}` : '',
        '',
        /* '```json',
        JSON.stringify(route.args, null, 2),
        '```' */
      ].join('\n'));

      // 2) Detect the callable method once per session (cache in memento if you like)
      stream.progress(`Detecting Platform RPC at ${platformUrl}…`);
      const callMethod = await detectPlatformCallMethod(platformUrl, signal);
      stream.progress(`Using method **${callMethod}**`);

      // 3) Call tool with graceful fallback already decided
      stream.progress(`Calling ${route.tool}…`);
      const callRes = await callPlatformTool(platformUrl, callMethod, route.tool, route.args, signal);

      const contents: Array<{type: string; json?: any; text?: string}> = (callRes?.content ?? []) as any[];
      for (const c of contents) {
        if (token.isCancellationRequested) return { metadata: { status: 'cancelled' } };
        if (c.type === 'json') stream.markdown('```json\n' + JSON.stringify(c.json, null, 2) + '\n```');
        else if (c.type === 'text') stream.markdown(c.text || '');
      }

      // Offer remediation buttons if findings exist
      const findings = contents.find(c => c.type === 'json' && c.json?.findings)?.json?.findings ?? [];
      if (Array.isArray(findings) && findings.length) {
        const args = route.args || {};
        stream.markdown(`**Findings:** ${findings.length}`);
        stream.button({ title: 'Remediate (plan)', command: 'platform.remediatePlan', arguments: [{ findings, args, platformUrl, callMethod }] });
        stream.button({ title: 'Remediate (apply)', command: 'platform.remediateApply', arguments: [{ findings, args, platformUrl, callMethod }] });
      }

      return { metadata: { status: 'ok' } };
    } catch (e: any) {
      // Show precise JSON-RPC errors so you can tell “wrong URL” vs “wrong method”
      const detail = e?.rpc ? ` (code ${e.rpc.code})` : '';
      stream.markdown('⚠️ **Error**: ' + (e?.message || String(e)) + detail);
      stream.markdown(`\n_Check settings in **Platform Engineering Agent**: routerUrl=${routerUrl}, platformUrl=${platformUrl}_`);
      return { metadata: { status: 'error' } };
    }
  });

  // Buttons → commands
  ctx.subscriptions.push(
    vscode.commands.registerCommand('platform.remediatePlan', async ({ findings, args, platformUrl, callMethod }) => {
      const name = args?.name || args?.webAppName || args?.appServicePlanName;
      const rg = args?.resourceGroupName || args?.rg;
      if (!name || !rg) return vscode.window.showWarningMessage('Missing rg/name for remediation.');
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Planning remediation…' }, async () => {
        const res = await callJsonRpc(platformUrl, callMethod, {
          name: 'platform.remediate_webapp_baseline',
          arguments: { resourceGroupName: rg, name, findings, dryRun: true }
        });
        vscode.window.showInformationMessage('Remediation plan created.');
      });
    }),

    vscode.commands.registerCommand('platform.remediateApply', async ({ findings, args, platformUrl, callMethod }) => {
      const name = args?.name || args?.webAppName || args?.appServicePlanName;
      const rg = args?.resourceGroupName || args?.rg;
      if (!name || !rg) return vscode.window.showWarningMessage('Missing rg/name for remediation.');
      const ok = await vscode.window.showWarningMessage(`Apply remediation to ${name} in ${rg}?`, { modal: true }, 'Apply');
      if (ok !== 'Apply') return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Applying remediation…' }, async () => {
        const res = await callJsonRpc(platformUrl, callMethod, {
          name: 'platform.remediate_webapp_baseline',
          arguments: { resourceGroupName: rg, name, findings, dryRun: false }
        });
        vscode.window.showInformationMessage('Remediation applied. Re-run a scan to verify.');
      });
    })
  );
}

export function deactivate() {}
