import { describe, expect, it } from "vitest";
import { resolveRecentChatActiveTarget } from "./recentChatActivity";

describe("resolveRecentChatActiveTarget", () => {
  const characters = [
    {
      chaId: "older",
      lastInteraction: 100,
      chatPage: 1,
      chats: [{ id: "older-1" }, { id: "older-2" }],
    },
    {
      chaId: "latest",
      lastInteraction: 300,
      chatPage: 2,
      chats: [{ id: "latest-1" }, { id: "latest-2" }, { id: "latest-3" }],
    },
  ];

  it("keeps the selected stable chat target even when another bot is newer", () => {
    expect(resolveRecentChatActiveTarget(characters, 0)).toEqual({
      characterId: "older",
      chatId: "older-2",
      timestamp: 100,
    });
  });

  it("recovers the last opened chat after Home clears the selection", () => {
    expect(resolveRecentChatActiveTarget(characters, -1)).toEqual({
      characterId: "latest",
      chatId: "latest-3",
      timestamp: 300,
    });
  });

  it("ignores trashed characters and zero-time placeholders", () => {
    expect(
      resolveRecentChatActiveTarget([
        { ...characters[1], trashTime: 1 },
        { ...characters[0], lastInteraction: Number.NaN },
      ]),
    ).toBeNull();
  });
});
