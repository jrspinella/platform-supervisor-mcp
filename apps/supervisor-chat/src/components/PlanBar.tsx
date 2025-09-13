import React from "react";

export const PlanBar: React.FC<{
  tool: string;
  rationale?: string;
  args: string;
  onArgsChange: (next: string) => void;
  onRun: () => void;
  running?: boolean;
}> = ({ tool, rationale, args, onArgsChange, onRun, running }) => {
  return (
    <div className="plan">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="small">
          <strong>Routed:</strong> {tool}
          {rationale ? <span> — {rationale}</span> : null}
        </div>
        <button onClick={onRun} disabled={running}>{running ? "Running…" : "Run tool"}</button>
      </div>
      <div style={{ marginTop: 8 }}>
        <div className="small">Args (editable JSON):</div>
        <textarea
          className="jsonedit"
          spellCheck={false}
          value={args}
          onChange={(e) => onArgsChange(e.target.value)}
        />
      </div>
    </div>
  );
};