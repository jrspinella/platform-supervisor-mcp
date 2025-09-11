import { describe, it, expect } from "vitest";
import { withGovernance } from "../src/wrappers.js";

const echoTool = {
  name: "platform.echo",
  description: "Echo input",
  handler: async (args: any) => ({ content: [{ type: "json", json: { ok: true, args } }] })
};

describe("withGovernance", () => {
  it("passes through on allow", async () => {
    const allow = async () => ({ decision: "allow" as const });
    const wrapped = withGovernance(echoTool, allow);
    const res = await (wrapped as any).handler({ x: 1 });
    expect(res?.content?.[0]?.json?.ok).toBe(true);
  });

  it("blocks on deny with MCP content + isError", async () => {
    const deny = async () => ({ decision: "deny" as const, reasons: ["bad"] });
    const wrapped = withGovernance(echoTool, deny);
    const res = await (wrapped as any).handler({});
    expect(res?.isError).toBe(true);
    const json = res?.content?.find((c: any) => c.type === "json")?.json;
    expect(json?.status).toBe("deny");
  });
});
