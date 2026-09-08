import { describe, expect, it } from "vitest";
import type { ChatWorkspaceSnapshot } from "./chatWorkspace";
import {
  buildTauriNavigationMenuModel,
  parseTauriNavigationCommand,
  settingsIndexForTauriAppMenuCommand,
  type TauriMenuCharacterSource,
} from "./tauriAppMenu";

describe("Tauri application menu commands", () => {
  it.each([
    ["risu.bots.settings", 1],
    ["risu.bots.personas", 12],
    ["risu.bots.lorebook", 8],
    ["risu.bots.prompts", 13],
    ["risu.modules.settings", 14],
    ["risu.modules.plugins", 4],
    ["risu.tools.settings", 1],
    ["risu.tools.advanced", 6],
    ["risu.tools.hotkeys", 15],
    ["risu.tools.account-files", 0],
  ])("maps %s to settings page %i", (command, expected) => {
    expect(settingsIndexForTauriAppMenuCommand(command)).toBe(expected);
  });

  it("ignores unknown native menu commands", () => {
    expect(settingsIndexForTauriAppMenuCommand("risu.unknown")).toBeNull();
  });
});

describe("Tauri navigation menu model", () => {
  const characters: TauriMenuCharacterSource[] = [
    {
      chaId: "char:a",
      name: "Alice",
      lastInteraction: 300,
      chatPage: 0,
      chats: [{ id: "chat:a", name: "Morning", lastDate: 250 }],
    },
    {
      chaId: "char-b",
      name: "Bob",
      lastInteraction: 200,
      chats: [{ id: "chat-b", name: "Ideas", lastDate: 180 }],
    },
    {
      chaId: "char-c",
      name: "Carol",
      lastInteraction: 100,
      chats: [{ id: "chat-c", name: "Old", lastDate: 90 }],
    },
  ];

  const workspace: ChatWorkspaceSnapshot = {
    version: 1,
    windows: [
      {
        id: "main",
        kind: "main",
        tabs: {
          focusedGroupId: "g-main",
          groups: [{ id: "g-main", activeTabId: "tab-main" }],
          tabs: [
            {
              id: "tab-main",
              groupId: "g-main",
              characterId: "char:a",
              chatId: "chat:a",
              unread: false,
              draft: "",
              translatedDraft: "",
              fileInput: [],
            },
          ],
        },
      },
      {
        id: "chat-window-1",
        kind: "auxiliary",
        tabs: {
          focusedGroupId: "g-aux",
          groups: [{ id: "g-aux", activeTabId: "tab-aux" }],
          tabs: [
            {
              id: "tab-aux",
              groupId: "g-aux",
              characterId: "char:a",
              chatId: "chat:a",
              unread: false,
              draft: "",
              translatedDraft: "",
              fileInput: [],
            },
          ],
        },
      },
    ],
  };

  it("lists exact workspace tabs and disambiguates duplicate chat targets", () => {
    const model = buildTauriNavigationMenuModel(workspace, characters, []);
    expect(model.openTabs).toEqual([
      {
        id: "risu.nav.tab:main:tab-main",
        label: "Alice — Morning (Main)",
      },
      {
        id: "risu.nav.tab:chat-window-1:tab-aux",
        label: "Alice — Morning (Window 2)",
      },
    ]);
  });

  it("bounds recent chats and sorts recent bots by interaction", () => {
    const model = buildTauriNavigationMenuModel(
      workspace,
      characters,
      [
        {
          characterId: "char-b",
          characterName: "Bob",
          chatId: "chat-b",
          chatName: "Ideas",
          timestamp: 500,
        },
        {
          characterId: "char-c",
          characterName: "Carol",
          chatId: "chat-c",
          chatName: "Old",
          timestamp: 400,
        },
      ],
      1,
    );
    expect(model.recentChats).toEqual([
      { id: "risu.nav.chat:char-b:chat-b", label: "Bob — Ideas" },
    ]);
    expect(model.recentBots).toEqual([
      { id: "risu.nav.bot:char%3Aa", label: "Alice" },
    ]);
  });

  it("parses encoded tab, chat and bot navigation commands", () => {
    expect(
      parseTauriNavigationCommand("risu.nav.tab:chat-window-1:tab-1"),
    ).toEqual({
      kind: "tab",
      windowId: "chat-window-1",
      tabId: "tab-1",
    });
    expect(
      parseTauriNavigationCommand("risu.nav.chat:char%3Aa:chat%3Aa"),
    ).toEqual({
      kind: "chat",
      characterId: "char:a",
      chatId: "chat:a",
    });
    expect(parseTauriNavigationCommand("risu.nav.bot:char%3Aa")).toEqual({
      kind: "bot",
      characterId: "char:a",
    });
  });
});
