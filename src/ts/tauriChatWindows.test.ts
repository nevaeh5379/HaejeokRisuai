import { beforeEach, describe, expect, it } from "vitest";
import type { ChatTab } from "./chatTabs.svelte";
import {
  buildTauriChatWorkspaceWindowUrl,
  clearActiveTauriChatDragPayload,
  createTauriChatDragPayload,
  getActiveTauriChatDragPayload,
  getCurrentChatWorkspaceWindowId,
  isPointOutsideTauriWindow,
  parseTauriChatDragPayload,
  parseTauriChatWorkspaceLaunch,
  publishActiveTauriChatDragPayload,
  serializeTauriChatDragPayload,
} from "./tauriChatWindows";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

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

describe("Tauri cross-window drag registry", () => {
  it("recovers a tab payload when WebKit strips custom drag MIME", () => {
    const payload = createTauriChatDragPayload(tab("aux-tab"), "chat-window-a");
    publishActiveTauriChatDragPayload(payload, 1_000);

    expect(getActiveTauriChatDragPayload(1_500)).toEqual(payload);
    clearActiveTauriChatDragPayload(payload.transferId);
    expect(getActiveTauriChatDragPayload(1_500)).toBeNull();
  });

  it("expires abandoned cross-window drags", () => {
    const payload = createTauriChatDragPayload(tab("stale-tab"), "chat-window-a");
    publishActiveTauriChatDragPayload(payload, 1_000);

    expect(getActiveTauriChatDragPayload(31_001)).toBeNull();
  });
});
