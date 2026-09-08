import { describe, expect, it } from "vitest";
import {
  buildTauriChatWindowUrl,
  isPointOutsideTauriWindow,
  parseTauriChatDragPayload,
  parseTauriChatWindowPresentation,
  parseTauriChatWindowTarget,
  serializeTauriChatDragPayload,
} from "./tauriChatWindows";

describe("Tauri chat window targets", () => {
  it("round-trips character and chat ids through a launch URL", () => {
    const url = buildTauriChatWindowUrl(
      { characterId: "character one", chatId: "chat/two" },
      "/index.html",
    );

    const search = url.slice(url.indexOf("?"));
    expect(parseTauriChatWindowTarget(search)).toEqual({
      characterId: "character one",
      chatId: "chat/two",
    });
  });

  it("ignores normal application URLs", () => {
    expect(parseTauriChatWindowTarget("?characterId=a&chatId=b")).toBeNull();
  });

  it("rejects incomplete chat window targets", () => {
    expect(
      parseTauriChatWindowTarget("?risuWindow=chat&characterId=a"),
    ).toBeNull();
    expect(parseTauriChatWindowTarget("?risuWindow=chat&chatId=b")).toBeNull();
  });

  it("carries presentation labels for the immediate detached shell", () => {
    const url = buildTauriChatWindowUrl(
      { characterId: "character-a", chatId: "chat-b" },
      "/",
      { characterName: "Alice", chatName: "First chat" },
    );
    const search = url.slice(url.indexOf("?"));
    expect(parseTauriChatWindowPresentation(search)).toEqual({
      characterName: "Alice",
      chatName: "First chat",
    });
  });


});

describe("Tauri chat drag payload", () => {
  it("round-trips a transfer-specific payload", () => {
    const payload = {
      characterId: "character-a",
      chatId: "chat-b",
      sourceWindowLabel: "chat-window-test",
      transferId: "transfer-1",
    };
    expect(parseTauriChatDragPayload(serializeTauriChatDragPayload(payload))).toEqual(
      payload,
    );
  });

  it("rejects payloads without a transfer id", () => {
    expect(
      parseTauriChatDragPayload(
        JSON.stringify({
          characterId: "character-a",
          chatId: "chat-b",
          sourceWindowLabel: "chat-window-test",
        }),
      ),
    ).toBeNull();
  });
});

describe("Tauri window exit detection", () => {
  it("detects a cursor outside the native content bounds", () => {
    expect(
      isPointOutsideTauriWindow(
        { x: 99, y: 300 },
        { x: 100, y: 100 },
        { width: 800, height: 600 },
      ),
    ).toBe(true);
    expect(
      isPointOutsideTauriWindow(
        { x: 450, y: 350 },
        { x: 100, y: 100 },
        { width: 800, height: 600 },
      ),
    ).toBe(false);
  });
});


describe("Tauri detached chat drag payload", () => {
  it("round-trips a detached chat payload", () => {
    const payload = {
      characterId: "character-a",
      chatId: "chat-b",
      sourceWindowLabel: "chat-window-test",
      transferId: "transfer-test",
    };
    expect(parseTauriChatDragPayload(serializeTauriChatDragPayload(payload))).toEqual(payload);
  });

  it("rejects payloads that do not come from detached chat windows", () => {
    expect(parseTauriChatDragPayload(JSON.stringify({
      characterId: "character-a",
      chatId: "chat-b",
      sourceWindowLabel: "main",
      transferId: "transfer-test",
    }))).toBeNull();
  });
});
