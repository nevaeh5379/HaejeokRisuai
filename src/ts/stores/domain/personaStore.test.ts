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

  it("persists per-bot persona lorebooks as persona-owned data", async () => {
    storage.loadPersonas = vi.fn(async () => [
      { name: "A", icon: "", personaPrompt: "A" },
    ]);
    await personaStore.init(storage);

    personaStore.requireActive().botLorebooks = {
      "char-a": [
        {
          key: "secret",
          secondkey: "",
          insertorder: 100,
          comment: "Persona lore",
          content: "Only for char-a",
          mode: "normal",
          alwaysActive: false,
          selective: false,
        },
      ],
    };
    await personaStore.flush();

    expect(commits).toHaveLength(1);
    expect(commits[0].root.upserts).toContainEqual({
      key: "personas",
      value: [
        expect.objectContaining({
          botLorebooks: {
            "char-a": [expect.objectContaining({ comment: "Persona lore" })],
          },
        }),
      ],
    });
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
});
