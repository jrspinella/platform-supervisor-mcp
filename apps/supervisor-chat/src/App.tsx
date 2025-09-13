import React from "react";
import { callTool, routeInstruction, listTools, ToolResult, ToolDef } from "./api";
import { MessageBubble } from "./components/MessageBubble";
import { PlanBar } from "./components/PlanBar";
import { ResultBlocks } from "./components/ResultBlocks";
import { ToolList } from "./components/ToolList";
import { EndpointsBar } from "./components/EndpointsBar";

type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string; plan?: { tool: string; rationale?: string; args: any }; result?: ToolResult };

const LS_HISTORY = "supervisor-chat:history";
const LS_PENDING = "supervisor-chat:pending";
const LS_AUTORUN = "supervisor-chat:autorun";

export default function App() {
  const [msgs, setMsgs] = React.useState<Msg[]>(() => loadHistory());
  const [draft, setDraft] = React.useState("");
  const [pending, setPending] = React.useState<{ tool?: string; argsJson?: string; rationale?: string }>(() => loadPending());
  const [busy, setBusy] = React.useState(false);

  const [tools, setTools] = React.useState<ToolDef[]>([]);
  const [toolFilter, setToolFilter] = React.useState("");
  const [selected, setSelected] = React.useState<ToolDef | null>(null);
  const [autoRun, setAutoRun] = React.useState<boolean>(() => (localStorage.getItem(LS_AUTORUN) === "1"));

  React.useEffect(() => { saveHistory(msgs); }, [msgs]);
  React.useEffect(() => { savePending(pending); }, [pending]);
  React.useEffect(() => { localStorage.setItem(LS_AUTORUN, autoRun ? "1" : "0"); }, [autoRun]);

  React.useEffect(() => { void reloadCatalog(); }, []);

  async function reloadCatalog() {
    try {
      const list = await listTools();
      setTools(list);
    } catch (e: any) {
      setMsgs(m => [...m, { role: "assistant", text: `Platform tools.list error: ${e?.message || String(e)}` }]);
    }
  }

  async function onSend() {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const r = await routeInstruction(text);
      const argsJson = JSON.stringify(r.args ?? {}, null, 2);
      setPending({ tool: r.tool, argsJson, rationale: r.rationale });
      setMsgs((m) => [...m, { role: "assistant", plan: { tool: r.tool, rationale: r.rationale, args: r.args ?? {} }, text: `→ Routed to \`${r.tool}\`` }]);
      if (autoRun) { await onRun(r.tool, argsJson); }
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "assistant", text: `Router error: ${e?.message || String(e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function onRun(tool?: string, argsJsonOverride?: string) {
    const theTool = tool ?? pending?.tool;
    if (!theTool) return;
    let parsed: any;
    try {
      const raw = argsJsonOverride ?? pending?.argsJson ?? "{}";
      parsed = raw ? JSON.parse(raw) : {};
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "assistant", text: `Invalid JSON args: ${e?.message || e}` }]);
      return;
    }
    setBusy(true);
    try {
      const res = await callTool(theTool, parsed);
      setMsgs((m) => [...m, { role: "assistant", result: res }]);
    } catch (e: any) {
      setMsgs((m) => [...m, { role: "assistant", text: `Tool error: ${e?.message || String(e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  function fromToolPick(t: ToolDef) {
    setSelected(t);
    setPending({ tool: t.name, argsJson: JSON.stringify({}, null, 2), rationale: "picked from catalog" });
  }

  // Keyboard shortcuts
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "enter") {
        e.preventDefault(); onRun(); return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
        e.preventDefault(); (document.getElementById("composer") as HTMLTextAreaElement)?.focus(); return;
      }
      if (e.key === "Escape") {
        (document.activeElement as HTMLElement)?.blur();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending]);

  return (
    <>
      <header>
        <div className="row">
          <div className="pill">Supervisor Chat</div>
          <div className="small">Router & Platform orchestration</div>
        </div>
        <div className="row small">
          <label className="toggle">
            <input type="checkbox" checked={autoRun} onChange={(e)=>setAutoRun(e.target.checked)} />
            Auto-run after route
          </label>
          <div className="pill">Enter: Route</div>
          <div className="pill">⌘/Ctrl+Enter: Run</div>
        </div>
      </header>

      <div className="layout">
        {/* Sidebar */}
        <aside className="sidebar">
          <EndpointsBar onCatalogReload={reloadCatalog} />
          <ToolList
            tools={tools}
            filter={toolFilter}
            onFilter={setToolFilter}
            onPick={fromToolPick}
            selected={selected || (pending?.tool ? tools.find(t=>t.name===pending.tool) || null : null)}
          />
        </aside>

        {/* Main content */}
        <section className="content">
          <div className="messages" id="messages">
            {msgs.map((m, i) => (
              <MessageBubble key={i} role={m.role}>
                {m.text ? <pre>{m.text}</pre> : null}
                {m.role === "assistant" && m.plan ? (
                  <div className="grid2" style={{ marginTop: 6 }}>
                    <div>
                      <div className="small"><strong>Tool</strong></div>
                      <pre className="monospace">{m.plan.tool}</pre>
                    </div>
                    <div>
                      <div className="small"><strong>Rationale</strong></div>
                      <pre>{m.plan.rationale || "—"}</pre>
                    </div>
                  </div>
                ) : null}
                {m.role === "assistant" && m.result ? <ResultBlocks blocks={m.result.content} /> : null}
              </MessageBubble>
            ))}

            {pending?.tool ? (
              <PlanBar
                tool={pending.tool}
                rationale={pending.rationale}
                args={pending.argsJson ?? "{}"}
                onArgsChange={(j) => setPending((p) => ({ ...(p || {}), argsJson: j }))}
                onRun={() => onRun()}
                running={busy}
              />
            ) : null}
          </div>

          <div className="composer">
            <textarea
              id="composer"
              placeholder='e.g. "scan the web app web-ml-sbx in resource group rg-ml-sbx-jrs1"'
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onSend();
                }
              }}
            />
            <button onClick={onSend} disabled={busy || !draft.trim()}>
              {busy ? "Routing…" : "Route"}
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

// ——— persistence ———
function loadHistory(): Msg[] {
  try { return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); } catch { return []; }
}
function saveHistory(m: Msg[]) {
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(m.slice(-200))); } catch {}
}
function loadPending(): { tool?: string; argsJson?: string; rationale?: string } {
  try { return JSON.parse(localStorage.getItem(LS_PENDING) || "null") || {}; } catch { return {}; }
}
function savePending(p: any) {
  try { localStorage.setItem(LS_PENDING, JSON.stringify(p || {})); } catch {}
}
