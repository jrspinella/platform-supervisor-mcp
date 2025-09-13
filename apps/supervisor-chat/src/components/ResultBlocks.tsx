import React from "react";
import type { ToolBlock } from "../api";
import { renderSpecial } from "../renderers";

function Collapser({ title, children }: { title: string; children: any }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="bubble assistant">
      <div className="row" style={{ justifyContent:"space-between" }}>
        <div className="small"><strong>{title}</strong></div>
        <button className="secondary" onClick={() => setOpen(o=>!o)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open ? <div style={{ marginTop:8 }}>{children}</div> : null}
    </div>
  );
}

export const ResultBlocks: React.FC<{ blocks?: ToolBlock[] }> = ({ blocks }) => {
  if (!blocks?.length) return <div className="small">No content.</div>;

  return (
    <div style={{ display:"grid", gap:10 }}>
      {blocks.map((b, i) => {
        if (b.type === "json") {
          const special = renderSpecial(b.json);
          if (special) return <div key={i}>{special}</div>;
          return (
            <Collapser key={i} title="Raw JSON">
              <pre className="monospace">{JSON.stringify(b.json, null, 2)}</pre>
            </Collapser>
          );
        }
        if (b.type === "text") {
          return (
            <div key={i} className="bubble assistant">
              <div className="small">Text</div>
              <pre>{b.text}</pre>
            </div>
          );
        }
        return <div key={i} className="bubble assistant small">Unknown block</div>;
      })}
    </div>
  );
};