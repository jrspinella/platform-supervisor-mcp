export async function callJsonRpc(url: string, method: string, params: any, signal?: AbortSignal) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal,
  });
  if (!r.ok) throw new Error(`${method} HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error) {
    const e: any = new Error(`${method}: ${j.error.message}`);
    e.rpc = j.error; throw e;
  }
  return j.result;
}

export async function callPlatformTool(platformUrl: string, name: string, args: any, signal?: AbortSignal) {
  return callJsonRpc(platformUrl, "tools.call", { name, arguments: args }, signal);
}