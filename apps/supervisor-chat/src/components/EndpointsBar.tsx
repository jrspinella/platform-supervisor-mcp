import React from "react";
import { getEndpoints, setEndpoints, listTools } from "../api";

export const EndpointsBar: React.FC<{
  onCatalogReload: () => Promise<void>;
}> = ({ onCatalogReload }) => {
  const [router, setRouter] = React.useState(getEndpoints().router);
  const [platform, setPlatform] = React.useState(getEndpoints().platform);
  const [status, setStatus] = React.useState<string>("");

  async function save() {
    setEndpoints({ router, platform });
    setStatus("Saved");
    try {
      await onCatalogReload(); // check platform connectivity by listing tools
      setStatus("Saved ✓");
    } catch (e: any) {
      setStatus("Saved (platform error: " + (e?.message || e) + ")");
    }
    setTimeout(()=>setStatus(""), 2000);
  }

  async function pingPlatform() {
    try {
      await listTools();
      setStatus("Platform OK ✓");
    } catch (e: any) {
      setStatus("Platform error: " + (e?.message || e));
    }
  }

  return (
    <div className="section endpoints">
      <div className="small"><strong>Endpoints</strong></div>
      <div className="hr"></div>
      <div className="row" style={{ alignItems:"end" }}>
        <div style={{ flex:1 }}>
          <div className="small">Router RPC</div>
          <input value={router} onChange={(e)=>setRouter(e.target.value)} />
        </div>
        <div style={{ flex:1 }}>
          <div className="small">Platform RPC</div>
          <input value={platform} onChange={(e)=>setPlatform(e.target.value)} />
        </div>
      </div>
      <div className="row" style={{ marginTop:8 }}>
        <button className="secondary" onClick={pingPlatform}>Check platform</button>
        <button onClick={save}>Save</button>
        <div className="small">{status}</div>
      </div>
    </div>
  );
};