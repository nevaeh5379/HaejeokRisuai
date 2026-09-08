import { beforeEach, describe, expect, it } from "vitest";
import type { ChatTab } from "./chatTabs.svelte";
import {
  buildTauriChatWorkspaceWindowUrl,
  calculateDetachedWindowPlacement,
  clearActiveTauriChatDragPayload,
  createTauriChatDragPayload,
  getActiveTauriChatDragPayload,
  getCurrentChatWorkspaceWindowId,
  findWorkspaceWindowAtPoint,
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
      parseTauriChatWorkspaceLaunch(
        "?risuWindow=chat-workspace&workspaceWindowId=main",
      ),
    ).toBeNull();
  });
});

describe("Tauri chat tab transfer payload", () => {
  it("round-trips the full tab instance so drafts and duplicate identity survive", () => {
    const payload = createTauriChatDragPayload(tab(), "chat-window-source");
    const parsed = parseTauriChatDragPayload(
      serializeTauriChatDragPayload(payload),
    );

    expect(parsed?.sourceWindowId).toBe("chat-window-source");
    expect(parsed?.sourceWindowLabel).toBe("chat-window-source");
    expect(parsed?.tab).toEqual(tab());
    expect(parsed?.transferId).toBeTruthy();
  });

  it("rejects incomplete transfer payloads", () => {
    expect(
      parseTauriChatDragPayload(
        JSON.stringify({ sourceWindowId: "main", transferId: "x" }),
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

describe("Tauri workspace window hit testing", () => {
  const windows = [
    { id: "main", x: 0, y: 0, width: 1200, height: 900 },
    { id: "chat-window-a", x: 1300, y: 100, width: 700, height: 700 },
    { id: "chat-window-b", x: 2100, y: 100, width: 700, height: 700 },
  ];

  it("finds another auxiliary window under the global cursor", () => {
    expect(
      findWorkspaceWindowAtPoint({ x: 2200, y: 300 }, windows, "chat-window-a"),
    ).toBe("chat-window-b");
  });

  it("never resolves the source window as a docking target", () => {
    expect(
      findWorkspaceWindowAtPoint({ x: 1400, y: 300 }, windows, "chat-window-a"),
    ).toBeNull();
  });

  it("prefers an auxiliary window over main when native bounds overlap", () => {
    const overlapping = [
      { id: "main", x: 0, y: 0, width: 1400, height: 1000 },
      { id: "chat-window-b", x: 400, y: 200, width: 600, height: 500 },
    ];
    expect(
      findWorkspaceWindowAtPoint(
        { x: 500, y: 300 },
        overlapping,
        "chat-window-a",
      ),
    ).toBe("chat-window-b");
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
    const payload = createTauriChatDragPayload(
      tab("stale-tab"),
      "chat-window-a",
    );
    publishActiveTauriChatDragPayload(payload, 1_000);

    expect(getActiveTauriChatDragPayload(31_001)).toBeNull();
  });
});

describe("Tauri detached window placement", () => {
  it("places the detached header near the cursor using logical pixels", () => {
    expect(
      calculateDetachedWindowPlacement({
        cursor: { x: 1200, y: 600 },
        scaleFactor: 2,
        workAreaPosition: { x: 0, y: 48 },
        workAreaSize: { width: 3024, height: 1876 },
        windowWidth: 720,
        windowHeight: 600,
      }),
    ).toEqual({ x: 460, y: 282 });
  });

  it("keeps a new detached window inside the monitor work area", () => {
    expect(
      calculateDetachedWindowPlacement({
        cursor: { x: 2980, y: 1840 },
        scaleFactor: 2,
        workAreaPosition: { x: 0, y: 48 },
        workAreaSize: { width: 3024, height: 1876 },
        windowWidth: 720,
        windowHeight: 600,
      }),
    ).toEqual({ x: 792, y: 362 });
  });

  it("supports monitors with negative desktop coordinates", () => {
    expect(
      calculateDetachedWindowPlacement({
        cursor: { x: -600, y: 500 },
        scaleFactor: 1,
        workAreaPosition: { x: -1920, y: 0 },
        workAreaSize: { width: 1920, height: 1080 },
        windowWidth: 720,
        windowHeight: 600,
      }),
    ).toEqual({ x: -740, y: 480 });
  });
});
