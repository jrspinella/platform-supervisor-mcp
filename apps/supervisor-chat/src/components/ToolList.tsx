import React from "react";
import type { ToolDef } from "../api";

export const ToolList: React.FC<{
  tools: ToolDef[];
  filter: string;
  onFilter: (s: string) => void;
  onPick: (tool: ToolDef) => void;
  selected?: ToolDef | null;
}> = ({ tools, filter, onFilter, onPick, selected }) => {
  const items = tools.filter(t =>
    !filter.trim() ||
    t.name.toLowerCase().includes(filter.toLowerCase()) ||
    (t.description || "").toLowerCase().includes(filter.toLowerCase())
  );
  return (
    <>
      <div className="section">
        <div className="row" style={{ justifyContent:"space-between" }}>
          <div className="small"><strong>Tools</strong> ({tools.length})</div>
        </div>
        <div style={{ marginTop:6 }}>
          <input placeholder="Filter tools…" value={filter} onChange={(e)=>onFilter(e.target.value)} />
        </div>
      </div>
      <div className="list">
        {items.map((t)=>(
          <div key={t.name}
               className="tool"
               onClick={()=>onPick(t)}
               style={{ borderColor: selected?.name===t.name ? "#2b6cffaa" : undefined }}>
            <div className="small monospace" style={{ fontSize:13 }}><strong>{t.name}</strong></div>
            {t.description ? <div className="small" style={{ marginTop:4 }}>{t.description}</div> : null}
          </div>
        ))}
        {!items.length && <div className="small">No tools match.</div>}
      </div>
      <div className="section">
        <div className="small"><strong>Input schema</strong></div>
        <div className="schema" style={{ marginTop:6 }}>
{JSON.stringify(selected?.inputSchema ?? {}, null, 2)}
        </div>
      </div>
    </>
  );
};