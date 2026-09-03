import { describe, expect, it } from "vitest";
import type { Database } from "../database/schema";
import {
  buildSqlReplaceRootCommit,
  iterateSqlReplaceEntityCommits,
} from "./sqlCommit";

describe("batched SQL database replacement", () => {
  it("keeps large message lists out of the root commit", () => {
    const messages = Array.from({ length: 300 }, (_, index) => ({
      chatId: `message-${index}`,
      role: index % 2 === 0 ? "user" : "char",
      data: `message body ${index}`,
    }));
    const database = {
      characters: [
        {
          chaId: "character-1",
          name: "Bot",
          image: "assets/bot.png",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              note: "",
              localLore: [],
              message: messages,
            },
          ],
        },
      ],
      personas: [
        { name: "Persona A", icon: "assets/persona.png", personaPrompt: "Hi" },
        { name: "Persona B", icon: "", personaPrompt: "Yo" },
      ],
      modules: [{ id: "module-1", name: "Module" }],
      enabledModules: ["module-1"],
      botPresets: [{ name: "Preset", mainPrompt: "Main" }],
      botPresetsId: 0,
      pluginCustomStorage: {},
    } as unknown as Database;

    const root = buildSqlReplaceRootCommit(database, 7);
    const batches = [...iterateSqlReplaceEntityCommits(database, 7, 128)];

    expect(root.replaceAll).toBe(true);
    expect(root.characters).toHaveLength(0);
    expect(root.root.upserts.some((entry) => entry.key === "personas")).toBe(
      true,
    );
    expect(root.root.upserts.some((entry) => entry.key === "modules")).toBe(
      false,
    );
    expect(root.modules?.upserts).toEqual([
      {
        id: "module-1",
        position: 0,
        data: { id: "module-1", name: "Module" },
      },
    ]);
    expect(root.presets?.upserts).toHaveLength(1);

    expect(batches.flatMap((batch) => batch.characters)).toHaveLength(1);
    expect(batches.flatMap((batch) => batch.chats)).toHaveLength(1);
    const messageBatches = batches.filter((batch) => batch.messages.length > 0);
    expect(messageBatches.map((batch) => batch.messages.length)).toEqual([
      128, 128, 44,
    ]);
    expect(messageBatches.flatMap((batch) => batch.messages)).toHaveLength(300);

    const manifest = batches.flatMap((batch) => batch.messageManifests)[0];
    expect(manifest.ids).toHaveLength(300);
    expect(manifest.ids[0]).toBe("message-0");
    expect(manifest.ids[299]).toBe("message-299");
    expect(batches.at(-1)?.characterIds).toEqual(["character-1"]);
  });

  it("keeps colliding legacy message IDs unique across restore batches", () => {
    const database = {
      characters: [
        {
          chaId: "character-1",
          name: "Bot",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              message: [
                { chatId: "duplicate-message", role: "user", data: "first" },
                { chatId: "duplicate-message", role: "char", data: "second" },
              ],
            },
          ],
        },
      ],
    } as unknown as Database;

    const batches = [...iterateSqlReplaceEntityCommits(database, 0, 1)];
    const messages = batches.flatMap((batch) => batch.messages);
    const ids = messages.map((message) => message.id);
    const manifest = batches.flatMap((batch) => batch.messageManifests)[0];

    expect(messages.map((message) => message.data)).toEqual([
      { role: "user", data: "first" },
      { role: "char", data: "second" },
    ]);
    expect(ids[0]).toBe("duplicate-message");
    expect(new Set(ids).size).toBe(2);
    expect(manifest.ids).toEqual(ids);
  });
});
