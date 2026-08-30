// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import type { SqlCommit } from "../../storage/sql/sqlCommit";
import { personaStore } from "./personaStore.svelte";

describe("PersonaStore", () => {
  let storage: ISqlStorage;
  let commits: SqlCommit[];

  beforeEach(() => {
    personaStore.resetForTesting();
    commits = [];
    storage = {
      getRevision: vi.fn(() => commits.length),
      loadPersonas: vi.fn(async () => []),
      loadSettingKey: vi.fn(async () => undefined),
      commit: vi.fn(async (commit: SqlCommit) => {
        commits.push(structuredClone(commit));
        return { revision: commits.length };
      }),
    } as unknown as ISqlStorage;
  });

  it("loads and owns the selected persona without SettingsStore mirrors", async () => {
    storage.loadPersonas = vi.fn(async () => [
      { name: "A", icon: "a.png", personaPrompt: "A prompt" },
      { name: "B", icon: "b.png", personaPrompt: "B prompt" },
    ]);
    storage.loadSettingKey = vi.fn(async (key: string) =>
      key === "selectedPersona" ? 1 : undefined,
    );

    await personaStore.init(storage);

    expect(personaStore.activeIndex).toBe(1);
    expect(personaStore.activePersona?.name).toBe("B");
    expect(personaStore.activePersona?.personaPrompt).toBe("B prompt");
  });

  it("fails fast instead of repairing an invalid selected persona index", async () => {
    storage.loadPersonas = vi.fn(async () => [
      { name: "A", icon: "", personaPrompt: "A prompt" },
    ]);
    storage.loadSettingKey = vi.fn(async () => 3);

    await expect(personaStore.init(storage)).rejects.toThrow(
      /Invalid persona index: 3/,
    );
    expect(personaStore.isLoaded).toBe(false);
  });

  it("creates only the domain default for a genuinely empty persona store", async () => {
    await personaStore.init(storage);

    expect(personaStore.isLoaded).toBe(true);
    expect(personaStore.list).toHaveLength(1);
    expect(personaStore.activePersona).toMatchObject({
      name: "User",
      icon: "",
      personaPrompt: "",
    });
    expect(storage.commit).not.toHaveBeenCalled();
  });

  it("persists persona selection through PersonaStore itself", async () => {
    storage.loadPersonas = vi.fn(async () => [
      { name: "A", icon: "", personaPrompt: "A" },
      { name: "B", icon: "", personaPrompt: "B" },
    ]);
    await personaStore.init(storage);

    await personaStore.setActiveIndex(1);

    expect(commits).toHaveLength(1);
    expect(commits[0].root.upserts).toContainEqual({
      key: "selectedPersona",
      value: 1,
    });
    expect(commits[0].root.upserts.some(({ key }) => key === "personas")).toBe(
      false,
    );
  });

  it("persists a new persona folder as a separate root setting", async () => {
    await personaStore.init(storage);

    const folder = await personaStore.addFolder("Favorites");

    expect(personaStore.folders).toHaveLength(1);
    expect(folder.name).toBe("Favorites");
    expect(commits).toHaveLength(1);
    expect(commits[0].root.upserts).toContainEqual({
      key: "personaFolders",
      value: [folder],
    });
    expect(commits[0].root.upserts.some(({ key }) => key === "personas")).toBe(
      false,
    );
  });

  it("loads persona folders from storage and moves personas between folders", async () => {
    storage.loadPersonas = vi.fn(async () => [
      { name: "A", icon: "", personaPrompt: "A", id: "a" },
      { name: "B", icon: "", personaPrompt: "B", id: "b" },
    ]);
    storage.loadSettingKey = vi.fn(async (key: string) =>
      key === "personaFolders"
        ? [{ id: "f1", name: "Work", color: "" }]
        : undefined,
    );
    await personaStore.init(storage);
    expect(personaStore.folders).toMatchObject([{ id: "f1", name: "Work" }]);

    await personaStore.movePersonaToFolder("a", "f1");

    expect(personaStore.personasInFolder("f1").map((p) => p.name)).toEqual([
      "A",
    ]);
    expect(personaStore.personasWithoutFolder().map((p) => p.name)).toEqual([
      "B",
    ]);
    const moveCommit = commits.find((commit) =>
      commit.root.upserts.some(({ key }) => key === "personas"),
    );
    expect(moveCommit).toBeDefined();
    const upsert = moveCommit!.root.upserts.find(
      ({ key }) => key === "personas",
    )!;
    expect(
      (upsert.value as { name: string; folderId?: string }[]).find(
        (p) => p.name === "A",
      )?.folderId,
    ).toBe("f1");
  });

  it("rejects moving a persona into a nonexistent folder", async () => {
    storage.loadPersonas = vi.fn(async () => [
      { name: "A", icon: "", personaPrompt: "A", id: "a" },
    ]);
    await personaStore.init(storage);

    await expect(
      personaStore.movePersonaToFolder("a", "missing"),
    ).rejects.toThrow(/Persona folder not found/);
  });

  it("removing a folder keeps its personas by clearing folder assignments", async () => {
    storage.loadPersonas = vi.fn(async () => [
      { name: "A", icon: "", personaPrompt: "A", id: "a", folderId: "f1" },
    ]);
    storage.loadSettingKey = vi.fn(async (key: string) =>
      key === "personaFolders"
        ? [{ id: "f1", name: "Work", color: "" }]
        : undefined,
    );
    await personaStore.init(storage);

    await personaStore.removeFolder("f1");

    expect(personaStore.folders).toHaveLength(0);
    expect(personaStore.personasWithoutFolder().map((p) => p.name)).toEqual([
      "A",
    ]);
    const persona = personaStore.require(0);
    expect(persona.folderId).toBeUndefined();
    expect(commits.at(-1)!.root.upserts.map(({ key }) => key)).toEqual([
      "personas",
      "personaFolders",
    ]);
  });

  it("renames a folder and commits only the folder setting", async () => {
    await personaStore.init(storage);
    const folder = await personaStore.addFolder("Old");
    commits.length = 0;

    await personaStore.renameFolder(folder.id, "New");

    expect(personaStore.getPersonaFolderById(folder.id)?.name).toBe("New");
    expect(commits).toHaveLength(1);
    expect(commits[0].root.upserts.map(({ key }) => key)).toEqual([
      "personaFolders",
    ]);
  });
});
