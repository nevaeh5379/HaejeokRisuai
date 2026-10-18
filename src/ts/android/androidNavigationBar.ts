export interface AndroidNavigationBarState {
  chatEnabled: boolean;
  sidebarEnabled: boolean;
  settingsOpen: boolean;
  selectedCharacterId: number;
  sidebarOpen: boolean;
  mobileSidebar: number;
}

/** Returns whether navigation controls should be hidden for the current UI. */
export function shouldHideAndroidNavigationBar(
  state: AndroidNavigationBarState,
): boolean {
  if (state.settingsOpen) return false;
  if (state.sidebarOpen || state.mobileSidebar > 0) {
    return state.sidebarEnabled;
  }
  return state.chatEnabled && state.selectedCharacterId >= 0;
}
