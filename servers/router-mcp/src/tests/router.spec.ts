/* eslint-env jest */
import { describe, it, expect } from "vitest";
import { route } from "../../src/index";

describe("NL router", () => {
  it("create RG with tags", async () => {
    const r = await route(`@platform Create a resource group named rg-ml-sbx-jrs in usgovvirginia with tags owner is jrs@live.com and env is dev`);
    expect(r.tool).toBe("platform.create_resource_group");
    expect((r.args as any).name).toBe("rg-ml-sbx-jrs");
    expect((r.args as any).location).toBe("usgovvirginia");
    expect((r.args as any).tags).toMatchObject({ owner: "jrs@live.com", env: "dev" });
  });

  it("create App Service Plan with SKU", async () => {
    const r = await route(`@platform Create an App Service Plan plan-ml-sbx-jrs in rg-ml-sbx-jrs in location usgovvirginia with SKU P1v3`);
    expect(r.tool).toBe("platform.create_app_service_plan");
    expect(r.args).toMatchObject({
      resourceGroupName: "rg-ml-sbx-jrs",
      name: "plan-ml-sbx-jrs",
      location: "usgovvirginia",
      sku: "P1v3",
    });
  });

  it("scan app workloads in rg", async () => {
    const r = await route(`@platform Scan App workloads in rg-ml-sbx-jrs for ATO warnings`);
    expect(r.tool).toBe("platform.scan_resource_group_baseline");
    expect((r.args as any).resourceGroupName).toBe("rg-ml-sbx-jrs");
    expect((r.args as any).profile).toBeDefined();
  });
});
