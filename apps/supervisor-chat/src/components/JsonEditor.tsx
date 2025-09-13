import React from "react";

export const JsonEditor: React.FC<{
  value: any;
  onChange: (v: any) => void;
}> = ({ value, onChange }) => {
  const [raw, setRaw] = React.useState<string>(() => toPretty(value));
  const [err, setErr] = React.useState<string>();

  React.useEffect(() => setRaw(toPretty(value)), [value]);

  return (
    <div>
      <textarea
        className="jsonedit"
        value={raw}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          setRaw(v);
          try {
            const parsed = JSON.parse(v || "{}");
            setErr(undefined);
            onChange(parsed);
          } catch (e: any) {
            setErr(e?.message || "Invalid JSON");
          }
        }}
      />
      {err ? <div className="small" style={{ color: "#ff8c8c" }}>{err}</div> : null}
    </div>
  );
};

function toPretty(v: any) {
  try { return JSON.stringify(v ?? {}, null, 2); } catch { return "{}"; }
}