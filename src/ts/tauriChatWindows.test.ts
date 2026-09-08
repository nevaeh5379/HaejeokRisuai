import { describe, expect, it } from "vitest";
import {
  buildTauriChatWindowUrl,
  isPointInTauriChatDockZone,
  isPointOutsideTauriWindow,
  parseTauriChatWindowTarget,
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
});

describe("Tauri chat docking zone", () => {
  it("accepts the top tab-strip area of the main window", () => {
    expect(
      isPointInTauriChatDockZone(
        { x: 420, y: 180 },
        { x: 100, y: 100 },
        { width: 900, height: 700 },
        2,
      ),
    ).toBe(true);
  });

  it("rejects points below the tab-strip area", () => {
    expect(
      isPointInTauriChatDockZone(
        { x: 420, y: 240 },
        { x: 100, y: 100 },
        { width: 900, height: 700 },
        2,
      ),
    ).toBe(false);
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
