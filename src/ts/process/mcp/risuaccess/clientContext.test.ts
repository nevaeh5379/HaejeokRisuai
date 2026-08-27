import { expect, test, vi } from "vitest";

const characterHandle = vi.hoisted(() => vi.fn(async () => [{ type: "text", text: "ok" }]));

vi.mock("./characters", () => ({
  CharacterHandler: class {
    getTools() { return []; }
    handle = characterHandle;
  },
}));
vi.mock("./chats", () => ({
  ChatHandler: class {
    getTools() { return []; }
    handle = vi.fn(async () => null);
  },
}));
vi.mock("./modules", () => ({
  ModuleHandler: class {
    getTools() { return []; }
    handle = vi.fn(async () => null);
  },
}));

import { RisuAccessClient } from "./client";

test("resolves blank character IDs from the tool generation context", async () => {
  const client = new RisuAccessClient();
  const currentChar = { chaId: "char-a", name: "Target" } as never;
  const chatTarget = { characterId: "char-a", chatId: "chat-a" };

  await client.callTool(
    "risu-get-character-info",
    { id: "", fields: ["name"] },
    { currentChar, chatTarget },
  );

  expect(characterHandle).toHaveBeenCalledWith(
    "risu-get-character-info",
    { id: "char-a", fields: ["name"] },
    { currentChar, chatTarget },
  );
});
