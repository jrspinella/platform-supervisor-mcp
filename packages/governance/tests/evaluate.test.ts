import { describe, it, expect, beforeEach } from "vitest";
import { registerPolicies } from "../src/index.js";
import { evaluate } from "../src/evaluate.js";

beforeEach(() => {
  // reset with a fresh policy doc
  registerPolicies({
    azure: {
      create_resource_group: {
        deny_names: ["bad-rg"],
        name_regex: "^rg-[a-z0-9-]+$",
        allowed_regions: ["eastus", "westus2"],
        require_tags: ["owner", "env"],
        suggest_name: "rg-suggested",
        suggest_region: "eastus",
        suggest_tags: { owner: "you", env: "dev" },
        controls: ["CM-2"]
      }
    }
  } as any);
});

describe("evaluate azure.create_resource_group", () => {
  it("denies when rules are violated and returns suggestions/controls", async () => {
    const block = await evaluate("azure.create_resource_group", {
      name: "bad-rg",
      location: "centralus",
      tags: { owner: "me" }
    });
    expect(block.decision).toBe("deny");
    expect(block.reasons?.length).toBeGreaterThan(0);
    expect(block.suggestions?.length).toBeGreaterThan(0);
    expect(block.controls).toEqual(["CM-2"]);
  });

  it("allows when compliant", async () => {
    const block = await evaluate("azure.create_resource_group", {
      name: "rg-good-123",
      location: "eastus",
      tags: { owner: "me", env: "dev" }
    });
    expect(block.decision).toBe("allow");
  });
});