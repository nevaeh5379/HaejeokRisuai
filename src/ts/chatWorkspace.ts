import type { ChatTab, ChatTabsSnapshot } from "./chatTabs.svelte";

export const MAIN_CHAT_WORKSPACE_WINDOW_ID = "main";

export interface ChatWorkspaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ChatWorkspaceWindowState {
  id: string;
  kind: "main" | "auxiliary";
  tabs: ChatTabsSnapshot;
  bounds?: ChatWorkspaceBounds;
}

export interface ChatWorkspaceSnapshot {
  version: 1;
  windows: ChatWorkspaceWindowState[];
}

function cloneTab(tab: ChatTab): ChatTab {
  return { ...tab, fileInput: [...tab.fileInput] };
}

export function cloneTabsSnapshot(snapshot: ChatTabsSnapshot): ChatTabsSnapshot {
  return {
    tabs: snapshot.tabs.map(cloneTab),
    groups: snapshot.groups.map((group) => ({ ...group })),
    focusedGroupId: snapshot.focusedGroupId,
  };
}

export function createSingleTabSnapshot(tab: ChatTab): ChatTabsSnapshot {
  const groupId = `workspace-group-${tab.id}`;
  return {
    tabs: [{ ...cloneTab(tab), groupId }],
    groups: [{ id: groupId, activeTabId: tab.id }],
    focusedGroupId: groupId,
  };
}

export class ChatWindowManager {
  private windows = new Map<string, ChatWorkspaceWindowState>();

  constructor(mainTabs?: ChatTabsSnapshot) {
    if (mainTabs) this.registerMain(mainTabs);
  }

  registerMain(tabs: ChatTabsSnapshot): ChatWorkspaceWindowState {
    return this.setWindow({
      id: MAIN_CHAT_WORKSPACE_WINDOW_ID,
      kind: "main",
      tabs,
    });
  }

  registerAuxiliary(
    id: string,
    tabs: ChatTabsSnapshot,
    bounds?: ChatWorkspaceBounds,
  ): ChatWorkspaceWindowState {
    if (!id || id === MAIN_CHAT_WORKSPACE_WINDOW_ID) {
      throw new Error("Auxiliary chat windows require a unique non-main id");
    }
    return this.setWindow({ id, kind: "auxiliary", tabs, bounds });
  }

  updateTabs(id: string, tabs: ChatTabsSnapshot): ChatWorkspaceWindowState | null {
    const window = this.windows.get(id);
    if (!window) return null;
    window.tabs = cloneTabsSnapshot(tabs);
    return this.getWindow(id)!;
  }

  updateBounds(id: string, bounds: ChatWorkspaceBounds): void {
    const window = this.windows.get(id);
    if (window) window.bounds = { ...bounds };
  }

  removeWindow(id: string): boolean {
    if (id === MAIN_CHAT_WORKSPACE_WINDOW_ID) return false;
    return this.windows.delete(id);
  }

  moveTab(
    tabId: string,
    sourceWindowId: string,
    targetWindowId: string,
    targetGroupId?: string,
  ): ChatTab | null {
    if (sourceWindowId === targetWindowId) return null;
    const sourceWindow = this.windows.get(sourceWindowId);
    const targetWindow = this.windows.get(targetWindowId);
    if (!sourceWindow || !targetWindow) return null;
    const sourceTab = sourceWindow.tabs.tabs.find((tab) => tab.id === tabId);
    if (!sourceTab || targetWindow.tabs.tabs.some((tab) => tab.id === tabId)) return null;

    const sourceGroup = sourceWindow.tabs.groups.find((group) => group.id === sourceTab.groupId);
    if (!sourceGroup) return null;
    sourceWindow.tabs.tabs = sourceWindow.tabs.tabs.filter((tab) => tab.id !== tabId);
    const remainingSourceTabs = sourceWindow.tabs.tabs.filter(
      (tab) => tab.groupId === sourceGroup.id,
    );
    if (remainingSourceTabs.length === 0 && sourceWindow.tabs.groups.length > 1) {
      sourceWindow.tabs.groups = sourceWindow.tabs.groups.filter(
        (group) => group.id !== sourceGroup.id,
      );
      if (sourceWindow.tabs.focusedGroupId === sourceGroup.id) {
        sourceWindow.tabs.focusedGroupId = sourceWindow.tabs.groups[0].id;
      }
    } else if (sourceGroup.activeTabId === tabId) {
      sourceGroup.activeTabId = remainingSourceTabs[0]?.id ?? null;
    }

    const targetGroup =
      targetWindow.tabs.groups.find((group) => group.id === targetGroupId) ??
      targetWindow.tabs.groups.find(
        (group) => group.id === targetWindow.tabs.focusedGroupId,
      ) ??
      targetWindow.tabs.groups[0];
    if (!targetGroup) return null;
    const moved = { ...cloneTab(sourceTab), groupId: targetGroup.id, unread: false };
    targetWindow.tabs.tabs.push(moved);
    targetGroup.activeTabId = moved.id;
    targetWindow.tabs.focusedGroupId = targetGroup.id;
    return cloneTab(moved);
  }

  getWindow(id: string): ChatWorkspaceWindowState | null {
    const window = this.windows.get(id);
    return window ? this.cloneWindow(window) : null;
  }

  listWindows(): ChatWorkspaceWindowState[] {
    return [...this.windows.values()].map((window) => this.cloneWindow(window));
  }

  snapshot(): ChatWorkspaceSnapshot {
    return { version: 1, windows: this.listWindows() };
  }

  restore(snapshot: ChatWorkspaceSnapshot): void {
    if (snapshot.version !== 1) throw new Error("Unsupported chat workspace version");
    this.windows.clear();
    for (const window of snapshot.windows) this.setWindow(window);
  }

  private setWindow(window: ChatWorkspaceWindowState): ChatWorkspaceWindowState {
    const cloned = this.cloneWindow(window);
    this.windows.set(window.id, cloned);
    return this.cloneWindow(cloned);
  }

  private cloneWindow(window: ChatWorkspaceWindowState): ChatWorkspaceWindowState {
    return {
      ...window,
      tabs: cloneTabsSnapshot(window.tabs),
      bounds: window.bounds ? { ...window.bounds } : undefined,
    };
  }
}
