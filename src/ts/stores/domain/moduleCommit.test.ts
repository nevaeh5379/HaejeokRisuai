import { describe, expect, it } from "vitest";
import type { RisuModule } from "../../process/modules";
import { buildModuleDelta } from "./moduleCommit";

describe("buildModuleDelta", () => {
  const createModule = (id: string, name: string): RisuModule => ({
    id,
    name,
    description: `Description of ${name}`,
  });

  it("returns empty upserts and deletes when modules are unchanged", () => {
    const mod1 = createModule("m1", "Module 1");
    const mod2 = createModule("m2", "Module 2");
    const delta = buildModuleDelta([mod1, mod2], [mod1, mod2]);

    expect(delta.upserts).toEqual([]);
    expect(delta.deletes).toEqual([]);
    expect(delta.order).toBeUndefined();
  });

  it("detects new modules as upserts and reflects new order", () => {
    const mod1 = createModule("m1", "Module 1");
    const mod2 = createModule("m2", "Module 2");
    const delta = buildModuleDelta([mod1], [mod1, mod2]);

    expect(delta.upserts).toEqual([{ id: "m2", position: 1, data: mod2 }]);
    expect(delta.deletes).toEqual([]);
    expect(delta.order).toEqual(["m1", "m2"]);
  });

  it("detects removed modules as deletes and updates order", () => {
    const mod1 = createModule("m1", "Module 1");
    const mod2 = createModule("m2", "Module 2");
    const delta = buildModuleDelta([mod1, mod2], [mod1]);

    expect(delta.upserts).toEqual([]);
    expect(delta.deletes).toEqual(["m2"]);
    expect(delta.order).toEqual(["m1"]);
  });

  it("detects modified modules as upserts without order change", () => {
    const mod1 = createModule("m1", "Module 1");
    const mod2 = createModule("m2", "Module 2");
    const mod1Updated = { ...mod1, description: "Updated description" };
    const delta = buildModuleDelta([mod1, mod2], [mod1Updated, mod2]);

    expect(delta.upserts).toEqual([
      { id: "m1", position: 0, data: mod1Updated },
    ]);
    expect(delta.deletes).toEqual([]);
    expect(delta.order).toBeUndefined();
  });

  it("detects reordered modules and emits order array without unnecessary upserts", () => {
    const mod1 = createModule("m1", "Module 1");
    const mod2 = createModule("m2", "Module 2");
    const delta = buildModuleDelta([mod1, mod2], [mod2, mod1]);

    expect(delta.upserts).toEqual([]);
    expect(delta.deletes).toEqual([]);
    expect(delta.order).toEqual(["m2", "m1"]);
  });
});
