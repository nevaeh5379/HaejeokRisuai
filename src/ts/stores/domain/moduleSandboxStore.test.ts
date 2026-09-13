import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
import { moduleStore } from "./moduleStore.svelte";

describe("module sandbox group storage", () => {
  let commits: SqlCommit[];
  let storage: ISqlStorage;

  beforeEach(() => {
    commits = [];
    storage = {
      getRevision: vi.fn(() => 0),
      loadModules: vi.fn(async () => []),
      loadSettingKey: vi.fn(async () => []),
      commit: vi.fn(async (commit: SqlCommit) => {
        commits.push(structuredClone(commit));
        return { revision: commits.length };
      }),
    } as unknown as ISqlStorage;
    moduleStore.resetForTesting();
  });

  it("loads bundle metadata independently from module definitions", async () => {
    storage.loadSettingKey = vi.fn(async (key: string) => {
      if (key === "moduleSandboxGroups") {
        return [
          {
            id: "group-a",
            name: "Illustration",
            subModel: "image-model",
            members: [{ instanceId: "instance-a", moduleId: "lightboard" }],
          },
        ];
      }
      if (key === "enabledModuleSandboxGroups") return ["group-a"];
      return [];
    });

    await moduleStore.init(storage);

    expect(moduleStore.sandboxGroups[0]?.name).toBe("Illustration");
    expect(moduleStore.enabledSandboxGroups).toEqual(["group-a"]);
  });

  it("persists group membership and activation as small root settings", async () => {
    await moduleStore.init(storage);
    const group = await moduleStore.addSandboxGroup("Illustration");
    await moduleStore.addModuleToSandbox(group.id, "lightboard");

    const upserts = commits.flatMap((commit) => commit.root.upserts);
    expect(upserts.some((entry) => entry.key === "moduleSandboxGroups")).toBe(
      true,
    );
    expect(
      upserts.some((entry) => entry.key === "enabledModuleSandboxGroups"),
    ).toBe(true);
    expect(moduleStore.sandboxGroups[0].members[0].moduleId).toBe("lightboard");
  });
});
