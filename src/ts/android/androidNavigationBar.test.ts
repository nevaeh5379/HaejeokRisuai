import { describe, expect, it } from "vitest";
import { shouldHideAndroidNavigationBar } from "./androidNavigationBar";

describe("shouldHideAndroidNavigationBar", () => {
  it("uses the chat option when no sidebar is open", () => {
    expect(
      shouldHideAndroidNavigationBar({
        chatEnabled: true,
        sidebarEnabled: false,
        settingsOpen: false,
        selectedCharacterId: 0,
        sidebarOpen: false,
        mobileSidebar: 0,
      }),
    ).toBe(true);
  });

  it("uses the sidebar option ahead of the chat option", () => {
    expect(
      shouldHideAndroidNavigationBar({
        chatEnabled: true,
        sidebarEnabled: false,
        settingsOpen: false,
        selectedCharacterId: 0,
        sidebarOpen: true,
        mobileSidebar: 0,
      }),
    ).toBe(false);
    expect(
      shouldHideAndroidNavigationBar({
        chatEnabled: false,
        sidebarEnabled: true,
        settingsOpen: false,
        selectedCharacterId: -1,
        sidebarOpen: false,
        mobileSidebar: 2,
      }),
    ).toBe(true);
  });

  it("keeps navigation controls visible on the home screen", () => {
    expect(
      shouldHideAndroidNavigationBar({
        chatEnabled: true,
        sidebarEnabled: true,
        settingsOpen: false,
        selectedCharacterId: -1,
        sidebarOpen: false,
        mobileSidebar: 0,
      }),
    ).toBe(false);
  });

  it("shows navigation controls while settings are open from a chat", () => {
    expect(
      shouldHideAndroidNavigationBar({
        chatEnabled: true,
        sidebarEnabled: true,
        settingsOpen: true,
        selectedCharacterId: 0,
        sidebarOpen: true,
        mobileSidebar: 2,
      }),
    ).toBe(false);
  });
});
