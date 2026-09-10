import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
import type { ModuleFolder, RisuModule } from "../../process/modules";
import { moduleStore } from "./moduleStore.svelte";

describe("moduleStore ordering and folder positions", () => {
  let committed: SqlCommit[] = [];
  let mockStorage: ISqlStorage;

  beforeEach(() => {
    committed = [];
    mockStorage = {
      getRevision: vi.fn(() => 0),
      loadModules: vi.fn(async () => []),
      loadSettingKey: vi.fn(async () => []),
      commit: vi.fn(async (commit: SqlCommit) => {
        committed.push(structuredClone(commit));
        return { revision: committed.length };
      }),
    } as unknown as ISqlStorage;
    moduleStore.resetForTesting();
  });

  it("refreshes module-owned state from remote storage", async () => {
    let modules: RisuModule[] = [{ id: "m1", name: "Before", description: "" }];
    mockStorage.loadModules = vi.fn(async () => structuredClone(modules));
    mockStorage.loadSettingKey = vi.fn(async (key: string) =>
      key === "enabledModules" ? ["m1"] : [],
    );
    await moduleStore.init(mockStorage);

    modules = [{ id: "m1", name: "After", description: "" }];
    await moduleStore.refreshFromStorage();

    expect(moduleStore.getById("m1")?.name).toBe("After");
    expect(moduleStore.enabledModules).toEqual(["m1"]);
    expect(mockStorage.commit).not.toHaveBeenCalled();
  });

  it("generates default root order when moduleOrder is missing (legacy migration)", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    const mod2: RisuModule = {
      id: "m2",
      name: "Module 2",
      description: "",
      folderId: "f1",
    };
    const mod3: RisuModule = { id: "m3", name: "Module 3", description: "" };
    const folder1: ModuleFolder = { id: "f1", name: "Folder 1", color: "" };

    mockStorage.loadModules = vi.fn(async () => [mod1, mod2, mod3]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleFolders") return [folder1];
      if (key === "enabledModules") return [];
      if (key === "moduleOrder") return undefined;
      return [];
    });

    await moduleStore.init(mockStorage);

    // Ungrouped modules first (m1, m3), then folders (folder:f1)
    expect(moduleStore.order).toEqual(["m1", "m3", "folder:f1"]);

    const rootItems = moduleStore.getRootItems();
    expect(rootItems).toHaveLength(3);
    expect(rootItems[0]).toEqual({ type: "module", module: mod1 });
    expect(rootItems[1]).toEqual({ type: "module", module: mod3 });
    expect(rootItems[2]).toEqual({
      type: "folder",
      folder: folder1,
      modules: [mod2],
    });
  });

  it("allows moving a folder above ungrouped modules and persists the change", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    const folder1: ModuleFolder = { id: "f1", name: "Folder 1", color: "" };

    mockStorage.loadModules = vi.fn(async () => [mod1]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleFolders") return [folder1];
      if (key === "moduleOrder") return ["m1", "folder:f1"];
      return [];
    });

    await moduleStore.init(mockStorage);
    expect(moduleStore.order).toEqual(["m1", "folder:f1"]);

    // Move folder up to top position
    await moduleStore.moveFolder("f1", "up");
    expect(moduleStore.order).toEqual(["folder:f1", "m1"]);

    await moduleStore.flush();

    expect(committed.length).toBeGreaterThanOrEqual(1);
    const lastCommit = committed[committed.length - 1];
    expect(lastCommit.root.upserts).toContainEqual({
      key: "moduleOrder",
      value: ["folder:f1", "m1"],
    });

    const rootItems = moduleStore.getRootItems();
    expect(rootItems[0]).toEqual({
      type: "folder",
      folder: folder1,
      modules: [],
    });
    expect(rootItems[1]).toEqual({ type: "module", module: mod1 });
  });

  it("allows moving a module into and out of a folder", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    const folder1: ModuleFolder = { id: "f1", name: "Folder 1", color: "" };

    mockStorage.loadModules = vi.fn(async () => [mod1]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleFolders") return [folder1];
      if (key === "moduleOrder") return ["m1", "folder:f1"];
      return [];
    });

    await moduleStore.init(mockStorage);

    // Move mod1 into folder1
    await moduleStore.moveModule("m1", "f1");
    expect(moduleStore.getById("m1")?.folderId).toBe("f1");
    expect(moduleStore.order).toEqual(["folder:f1"]);

    // Move mod1 out of folder1 to root at index 0
    await moduleStore.moveModule("m1", undefined, 0);
    expect(moduleStore.getById("m1")?.folderId).toBeUndefined();
    expect(moduleStore.order).toEqual(["m1", "folder:f1"]);
  });

  it("allows reordering modules inside a folder", async () => {
    const mod1: RisuModule = {
      id: "m1",
      name: "Module 1",
      description: "",
      folderId: "f1",
    };
    const mod2: RisuModule = {
      id: "m2",
      name: "Module 2",
      description: "",
      folderId: "f1",
    };
    const folder1: ModuleFolder = { id: "f1", name: "Folder 1", color: "" };

    mockStorage.loadModules = vi.fn(async () => [mod1, mod2]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleFolders") return [folder1];
      if (key === "moduleOrder") return ["folder:f1"];
      return [];
    });

    await moduleStore.init(mockStorage);

    // Move mod2 up inside folder
    await moduleStore.moveFolderModule("m2", "up");
    const folderMods = moduleStore.modulesInFolder("f1");
    expect(folderMods.map((m) => m.id)).toEqual(["m2", "m1"]);
  });

  it("handles folder deletion by restoring contained modules to root at the folder's position", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    const mod2: RisuModule = {
      id: "m2",
      name: "Module 2",
      description: "",
      folderId: "f1",
    };
    const folder1: ModuleFolder = { id: "f1", name: "Folder 1", color: "" };

    mockStorage.loadModules = vi.fn(async () => [mod1, mod2]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleFolders") return [folder1];
      if (key === "moduleOrder") return ["folder:f1", "m1"];
      return [];
    });

    await moduleStore.init(mockStorage);

    await moduleStore.removeFolder("f1");

    expect(moduleStore.folders).toHaveLength(0);
    expect(moduleStore.getById("m2")?.folderId).toBeUndefined();
    // m2 replaced folder:f1 at index 0
    expect(moduleStore.order).toEqual(["m2", "m1"]);
  });

  it("allows moving root modules up and down", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    const mod2: RisuModule = { id: "m2", name: "Module 2", description: "" };
    const folder1: ModuleFolder = { id: "f1", name: "Folder 1", color: "" };

    mockStorage.loadModules = vi.fn(async () => [mod1, mod2]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleFolders") return [folder1];
      if (key === "moduleOrder") return ["m1", "folder:f1", "m2"];
      return [];
    });

    await moduleStore.init(mockStorage);

    // Move m2 up from index 2 to index 1
    await moduleStore.moveRootModule("m2", "up");
    expect(moduleStore.order).toEqual(["m1", "m2", "folder:f1"]);

    // Move m2 up again from index 1 to index 0
    await moduleStore.moveRootModule("m2", "up");
    expect(moduleStore.order).toEqual(["m2", "m1", "folder:f1"]);

    // Move m2 down to index 1
    await moduleStore.moveRootModule("m2", "down");
    expect(moduleStore.order).toEqual(["m1", "m2", "folder:f1"]);
  });

  it("adds newly installed modules to root moduleOrder and removes deleted modules", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    mockStorage.loadModules = vi.fn(async () => [mod1]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleOrder") return ["m1"];
      return [];
    });

    await moduleStore.init(mockStorage);
    expect(moduleStore.order).toEqual(["m1"]);

    const mod2: RisuModule = { id: "m2", name: "Module 2", description: "" };
    await moduleStore.installModule(mod2);
    expect(moduleStore.order).toEqual(["m1", "m2"]);

    await moduleStore.removeModule("m1");
    expect(moduleStore.order).toEqual(["m2"]);
  });

  it("moves a module into a specific folder index, between folders, and back to root next to folder", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    const mod2: RisuModule = {
      id: "m2",
      name: "Module 2",
      description: "",
      folderId: "f1",
    };
    const mod3: RisuModule = {
      id: "m3",
      name: "Module 3",
      description: "",
      folderId: "f1",
    };
    const folder1: ModuleFolder = { id: "f1", name: "Folder 1", color: "" };
    const folder2: ModuleFolder = { id: "f2", name: "Folder 2", color: "" };

    mockStorage.loadModules = vi.fn(async () => [mod1, mod2, mod3]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleFolders") return [folder1, folder2];
      if (key === "moduleOrder") return ["m1", "folder:f1", "folder:f2"];
      return [];
    });

    await moduleStore.init(mockStorage);

    // 1. Move m1 from root into folder1 at index 1 (between m2 and m3)
    await moduleStore.moveModule("m1", "f1", 1);
    expect(moduleStore.getById("m1")?.folderId).toBe("f1");
    expect(moduleStore.modulesInFolder("f1").map((m) => m.id)).toEqual([
      "m2",
      "m1",
      "m3",
    ]);
    expect(moduleStore.order).toEqual(["folder:f1", "folder:f2"]);

    // 2. Move m1 from folder1 into folder2 at index 0
    await moduleStore.moveModule("m1", "f2", 0);
    expect(moduleStore.getById("m1")?.folderId).toBe("f2");
    expect(moduleStore.modulesInFolder("f1").map((m) => m.id)).toEqual([
      "m2",
      "m3",
    ]);
    expect(moduleStore.modulesInFolder("f2").map((m) => m.id)).toEqual(["m1"]);

    // 3. Move m1 out of folder2 without targetIndex -> should be placed right next to folder:f2
    await moduleStore.moveModule("m1", undefined);
    expect(moduleStore.getById("m1")?.folderId).toBeUndefined();
    expect(moduleStore.modulesInFolder("f2")).toHaveLength(0);
    expect(moduleStore.order).toEqual(["folder:f1", "folder:f2", "m1"]);
  });

  it("synchronizes root order when modules are upserted through compatibility APIs", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    mockStorage.loadModules = vi.fn(async () => [mod1]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleOrder") return ["m1"];
      return [];
    });

    await moduleStore.init(mockStorage);

    const mod2: RisuModule = { id: "m2", name: "Module 2", description: "" };
    moduleStore.upsertModules([mod2]);

    expect(moduleStore.order).toEqual(["m1", "m2"]);
    expect(
      moduleStore
        .getRootItems()
        .map((item) =>
          item.type === "module" ? item.module.id : item.folder.id,
        ),
    ).toEqual(["m1", "m2"]);

    await moduleStore.flush();
    expect(committed.at(-1)?.root.upserts).toContainEqual({
      key: "moduleOrder",
      value: ["m1", "m2"],
    });
  });

  it("keeps getRootItems pure when root order is stale", async () => {
    const mod1: RisuModule = { id: "m1", name: "Module 1", description: "" };
    mockStorage.loadModules = vi.fn(async () => [mod1]);
    mockStorage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleOrder") return ["m1"];
      return [];
    });

    await moduleStore.init(mockStorage);
    moduleStore.order.push("missing-module");

    expect(moduleStore.getRootItems()).toEqual([
      { type: "module", module: mod1 },
    ]);
    expect(moduleStore.order).toEqual(["m1", "missing-module"]);
  });
});
