import { describe, expect, it, vi } from "vitest";
import {
  loadCharacterSelectionData,
  type SelectionCharacter,
} from "./characterSelectionLoader";

describe("loadCharacterSelectionData", () => {
  it("loads known shallow character and chat data in parallel", async () => {
    const events: string[] = [];
    let character: SelectionCharacter = {
      chaId: "character-1",
      detailsLoaded: false,
      chatPage: 0,
      chats: [{ id: "chat-1", messagesLoaded: false, detailsLoaded: true }],
    };
    let resolveDetails!: () => void;
    let resolveChat!: () => void;
    const ensureCharacterDetails = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("details-start");
          resolveDetails = () => {
            character.detailsLoaded = true;
            events.push("details-end");
            resolve();
          };
        }),
    );
    const preLoadChat = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          events.push("chat-start");
          resolveChat = () => {
            character.chats![0].messagesLoaded = true;
            events.push("chat-end");
            resolve();
          };
        }),
    );

    const loading = loadCharacterSelectionData({
      getCharacter: () => character,
      ensureCharacterDetails,
      preLoadChat,
    });

    expect(events).toEqual(["details-start", "chat-start"]);
    resolveChat();
    resolveDetails();
    await loading;
    expect(preLoadChat).toHaveBeenCalledTimes(1);
  });

  it("loads the chat after details reveal storage metadata", async () => {
    let character: SelectionCharacter = {
      chaId: "character-1",
      detailsLoaded: false,
      chats: [],
    };
    const ensureCharacterDetails = vi.fn(async () => {
      character = {
        ...character,
        detailsLoaded: true,
        chatPage: 1,
        chats: [{}, { id: "chat-2", messagesLoaded: false }],
      };
    });
    const preLoadChat = vi.fn(async (chatIndex: number) => {
      character.chats![chatIndex].messagesLoaded = true;
    });

    await loadCharacterSelectionData({
      getCharacter: () => character,
      ensureCharacterDetails,
      preLoadChat,
    });

    expect(ensureCharacterDetails).toHaveBeenCalledOnce();
    expect(preLoadChat).toHaveBeenCalledOnce();
    expect(preLoadChat).toHaveBeenCalledWith(1);
  });

  it("retries the current chat when the parallel load did not finish it", async () => {
    const character: SelectionCharacter = {
      chaId: "character-1",
      detailsLoaded: false,
      chatPage: 0,
      chats: [{ id: "chat-1", messagesLoaded: false }],
    };
    const preLoadChat = vi.fn(async () => {
      if (preLoadChat.mock.calls.length === 2) {
        character.chats![0].messagesLoaded = true;
      }
    });

    await loadCharacterSelectionData({
      getCharacter: () => character,
      ensureCharacterDetails: async () => {
        character.detailsLoaded = true;
      },
      preLoadChat,
    });

    expect(preLoadChat).toHaveBeenCalledTimes(2);
  });
});
