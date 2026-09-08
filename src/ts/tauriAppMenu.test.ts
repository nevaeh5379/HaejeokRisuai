import { describe, expect, it } from "vitest";
import { settingsIndexForTauriAppMenuCommand } from "./tauriAppMenu";

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
