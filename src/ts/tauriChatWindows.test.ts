import { describe, expect, it } from "vitest";
import type { ChatTab } from "./chatTabs.svelte";
import {
  buildTauriChatWorkspaceWindowUrl,
  createTauriChatDragPayload,
  getCurrentChatWorkspaceWindowId,
  isPointOutsideTauriWindow,
  parseTauriChatDragPayload,
  parseTauriChatWorkspaceLaunch,
  serializeTauriChatDragPayload,
} from "./tauriChatWindows";

function tab(id = "tab-a"): ChatTab {
  return {
    id,
    groupId: "group-a",
    characterId: "character-a",
    chatId: "chat-a",
    unread: false,
    draft: "hello",
    translatedDraft: "",
    fileInput: ["asset.png"],
  };
}

describe("Tauri chat workspace launch", () => {
  it("round-trips an auxiliary window id and presentation", () => {
    const url = buildTauriChatWorkspaceWindowUrl(
      "chat-window-abc",
      "/index.html",
      { characterName: "Alice", chatName: "First chat" },
    );
    const search = url.slice(url.indexOf("?"));
    expect(parseTauriChatWorkspaceLaunch(search)).toEqual({
      windowId: "chat-window-abc",
      presentation: { characterName: "Alice", chatName: "First chat" },
    });
  });

  it("does not treat the main application URL as auxiliary", () => {
    expect(parseTauriChatWorkspaceLaunch("?foo=bar")).toBeNull();
    expect(getCurrentChatWorkspaceWindowId("?foo=bar")).toBe("main");
  });

  it("rejects non auxiliary window labels", () => {
    expect(
      parseTauriChatWorkspaceLaunch("?risuWindow=chat-workspace&workspaceWindowId=main"),
    ).toBeNull();
  });
});

describe("Tauri chat tab transfer payload", () => {
  it("round-trips the full tab instance so drafts and duplicate identity survive", () => {
    const payload = createTauriChatDragPayload(tab(), "chat-window-source");
    const parsed = parseTauriChatDragPayload(serializeTauriChatDragPayload(payload));

    expect(parsed?.sourceWindowId).toBe("chat-window-source");
    expect(parsed?.sourceWindowLabel).toBe("chat-window-source");
    expect(parsed?.tab).toEqual(tab());
    expect(parsed?.transferId).toBeTruthy();
  });

  it("rejects incomplete transfer payloads", () => {
    expect(
      parseTauriChatDragPayload(JSON.stringify({ sourceWindowId: "main", transferId: "x" })),
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
