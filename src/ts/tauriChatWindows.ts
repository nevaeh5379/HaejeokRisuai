import type { ChatTab, ChatTabsSnapshot } from "./chatTabs.svelte";
import {
  ChatWindowManager,
  MAIN_CHAT_WORKSPACE_WINDOW_ID,
  cloneTabsSnapshot,
  createSingleTabSnapshot,
  type ChatWorkspaceBounds,
} from "./chatWorkspace";
import { isTauri } from "./platform";

const WINDOW_KIND_PARAM = "risuWindow";
const WINDOW_ID_PARAM = "workspaceWindowId";
const CHARACTER_NAME_PARAM = "characterName";
const CHAT_NAME_PARAM = "chatName";
const WORKSPACE_WINDOW_KIND = "chat-workspace";
const CHAT_WINDOW_LABEL_PREFIX = "chat-window-";
const WORKSPACE_STATE_EVENT = "risu://chat-workspace-state";
const WORKSPACE_WINDOW_CLOSED_EVENT = "risu://chat-workspace-window-closed";
const TAB_TRANSFER_ACK_EVENT = "risu://chat-workspace-tab-transfer-ack";
const WORKSPACE_STORAGE_KEY = "risu:chat-workspace:v1";
const WINDOW_STORAGE_PREFIX = "risu:chat-workspace-window:";
const LAUNCH_STORAGE_PREFIX = "risu:chat-workspace-launch:";
const ACTIVE_DRAG_STORAGE_KEY = "risu:chat-workspace-active-drag";
const ACTIVE_DRAG_MAX_AGE_MS = 30_000;
export const TAURI_CHAT_DRAG_MIME = "application/x-risu-chat-tab";

interface PhysicalPoint { x: number; y: number }
interface PhysicalArea { width: number; height: number }

export interface TauriChatWindowPresentation {
  characterName?: string;
  chatName?: string;
}

export interface TauriChatWorkspaceLaunch {
  windowId: string;
  presentation: TauriChatWindowPresentation;
}

export interface TauriChatDragPayload {
  sourceWindowId: string;
  sourceWindowLabel: string;
  transferId: string;
  tab: ChatTab;
}

interface StoredTauriChatDragPayload {
  payload: TauriChatDragPayload;
  startedAt: number;
}

interface TauriWorkspaceStatePayload {
  windowId: string;
  tabs: ChatTabsSnapshot;
  bounds?: ChatWorkspaceBounds;
}

const chatWindowManager = new ChatWindowManager();
let runtimeCleanup: (() => void) | null = null;

function cloneTab(tab: ChatTab): ChatTab {
  return { ...tab, fileInput: [...tab.fileInput] };
}

function createWindowId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${CHAT_WINDOW_LABEL_PREFIX}${Date.now().toString(36)}-${random}`;
}

function createTransferId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `chat-transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function isChatTab(value: unknown): value is ChatTab {
  if (!value || typeof value !== "object") return false;
  const tab = value as Partial<ChatTab>;
  return (
    typeof tab.id === "string" && tab.id.length > 0 &&
    typeof tab.groupId === "string" && tab.groupId.length > 0 &&
    typeof tab.characterId === "string" && tab.characterId.length > 0 &&
    typeof tab.chatId === "string" && tab.chatId.length > 0 &&
    typeof tab.unread === "boolean" &&
    typeof tab.draft === "string" &&
    typeof tab.translatedDraft === "string" &&
    Array.isArray(tab.fileInput) && tab.fileInput.every((item) => typeof item === "string")
  );
}

function isTauriChatDragPayload(value: unknown): value is TauriChatDragPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<TauriChatDragPayload>;
  return (
    typeof payload.sourceWindowId === "string" && payload.sourceWindowId.length > 0 &&
    typeof payload.sourceWindowLabel === "string" && payload.sourceWindowLabel.length > 0 &&
    typeof payload.transferId === "string" && payload.transferId.length > 0 &&
    isChatTab(payload.tab)
  );
}

export function parseTauriChatWorkspaceLaunch(
  search: string,
): TauriChatWorkspaceLaunch | null {
  const params = new URLSearchParams(search);
  if (params.get(WINDOW_KIND_PARAM) !== WORKSPACE_WINDOW_KIND) return null;
  const windowId = params.get(WINDOW_ID_PARAM)?.trim();
  if (!windowId || !windowId.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return null;
  return {
    windowId,
    presentation: {
      characterName: params.get(CHARACTER_NAME_PARAM)?.trim() || undefined,
      chatName: params.get(CHAT_NAME_PARAM)?.trim() || undefined,
    },
  };
}

export function buildTauriChatWorkspaceWindowUrl(
  windowId: string,
  pathname = "/",
  presentation: TauriChatWindowPresentation = {},
): string {
  const params = new URLSearchParams({
    [WINDOW_KIND_PARAM]: WORKSPACE_WINDOW_KIND,
    [WINDOW_ID_PARAM]: windowId,
  });
  if (presentation.characterName) params.set(CHARACTER_NAME_PARAM, presentation.characterName);
  if (presentation.chatName) params.set(CHAT_NAME_PARAM, presentation.chatName);
  return `${pathname || "/"}?${params.toString()}`;
}

export function getCurrentChatWorkspaceWindowId(
  search = typeof location === "undefined" ? "" : location.search,
): string {
  return parseTauriChatWorkspaceLaunch(search)?.windowId ?? MAIN_CHAT_WORKSPACE_WINDOW_ID;
}

export function isPointOutsideTauriWindow(
  cursor: PhysicalPoint,
  contentPosition: PhysicalPoint,
  contentSize: PhysicalArea,
  margin = 0,
): boolean {
  return (
    cursor.x < contentPosition.x - margin ||
    cursor.x > contentPosition.x + contentSize.width + margin ||
    cursor.y < contentPosition.y - margin ||
    cursor.y > contentPosition.y + contentSize.height + margin
  );
}

export function createTauriChatDragPayload(
  tab: ChatTab,
  sourceWindowId = getCurrentChatWorkspaceWindowId(),
): TauriChatDragPayload {
  return {
    sourceWindowId,
    sourceWindowLabel: sourceWindowId,
    transferId: createTransferId(),
    tab: cloneTab(tab),
  };
}

export function serializeTauriChatDragPayload(payload: TauriChatDragPayload): string {
  return JSON.stringify(payload);
}

export function parseTauriChatDragPayload(value: string): TauriChatDragPayload | null {
  try {
    const payload = JSON.parse(value) as unknown;
    return isTauriChatDragPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function publishActiveTauriChatDragPayload(
  payload: TauriChatDragPayload,
  startedAt = Date.now(),
): void {
  if (!isTauriChatDragPayload(payload)) return;
  writeStorage(ACTIVE_DRAG_STORAGE_KEY, { payload, startedAt } satisfies StoredTauriChatDragPayload);
}

export function getActiveTauriChatDragPayload(
  now = Date.now(),
): TauriChatDragPayload | null {
  const stored = readStorage<StoredTauriChatDragPayload>(ACTIVE_DRAG_STORAGE_KEY);
  if (!stored || !isTauriChatDragPayload(stored.payload) || !Number.isFinite(stored.startedAt)) {
    removeStorage(ACTIVE_DRAG_STORAGE_KEY);
    return null;
  }
  if (now - stored.startedAt > ACTIVE_DRAG_MAX_AGE_MS || now < stored.startedAt) {
    removeStorage(ACTIVE_DRAG_STORAGE_KEY);
    return null;
  }
  return { ...stored.payload, tab: cloneTab(stored.payload.tab) };
}

export function clearActiveTauriChatDragPayload(transferId?: string): void {
  if (!transferId) {
    removeStorage(ACTIVE_DRAG_STORAGE_KEY);
    return;
  }
  const active = getActiveTauriChatDragPayload();
  if (active?.transferId === transferId) removeStorage(ACTIVE_DRAG_STORAGE_KEY);
}

function readStorage<T>(key: string): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.warn("[TauriChatWorkspace] Failed to persist workspace state", error);
  }
}

function removeStorage(key: string): void {
  if (typeof localStorage === "undefined") return;
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}

function persistWorkspaceManager(): void {
  writeStorage(WORKSPACE_STORAGE_KEY, chatWindowManager.snapshot());
}

async function openAuxiliaryWindow(
  windowId: string,
  tabs: ChatTabsSnapshot,
  title: string,
  presentation: TauriChatWindowPresentation,
  bounds?: ChatWorkspaceBounds,
): Promise<boolean> {
  if (!isTauri) return false;
  writeStorage(`${LAUNCH_STORAGE_PREFIX}${windowId}`, cloneTabsSnapshot(tabs));
  writeStorage(`${WINDOW_STORAGE_PREFIX}${windowId}`, cloneTabsSnapshot(tabs));

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const child = new WebviewWindow(windowId, {
    url: buildTauriChatWorkspaceWindowUrl(windowId, location.pathname, presentation),
    title,
    x: bounds?.x,
    y: bounds?.y,
    width: bounds?.width ?? Math.max(720, Math.min(window.innerWidth, 1280)),
    height: bounds?.height ?? Math.max(600, Math.min(window.innerHeight, 960)),
    minWidth: 300,
    minHeight: 500,
    resizable: true,
    visible: true,
    focus: true,
  });

  return new Promise<boolean>((resolve, reject) => {
    void child.once("tauri://created", () => resolve(true));
    void child.once("tauri://error", (event) => {
      removeStorage(`${LAUNCH_STORAGE_PREFIX}${windowId}`);
      reject(new Error(`Failed to create auxiliary chat window: ${String(event.payload)}`));
    });
  });
}

export async function moveTabToNewTauriWorkspaceWindow(
  tab: ChatTab,
  title = "RisuAI",
  presentation: TauriChatWindowPresentation = {},
): Promise<boolean> {
  if (!isTauri) return false;
  const windowId = createWindowId();
  const tabs = createSingleTabSnapshot(tab);
  const created = await openAuxiliaryWindow(windowId, tabs, title, presentation);
  if (!created) return false;
  if (getCurrentChatWorkspaceWindowId() === MAIN_CHAT_WORKSPACE_WINDOW_ID) {
    chatWindowManager.registerAuxiliary(windowId, tabs);
    persistWorkspaceManager();
  }
  return true;
}

export async function openChatInNewTauriWindow(
  tab: ChatTab,
  title = "RisuAI",
  presentation: TauriChatWindowPresentation = {},
): Promise<boolean> {
  const duplicate = cloneTab(tab);
  duplicate.id = createTransferId();
  return moveTabToNewTauriWorkspaceWindow(duplicate, title, presentation);
}

export async function restoreTauriChatWorkspaceWindowState(
  search = location.search,
): Promise<boolean> {
  if (!isTauri) return false;
  const launch = parseTauriChatWorkspaceLaunch(search);
  if (!launch) return false;

  const key = `${LAUNCH_STORAGE_PREFIX}${launch.windowId}`;
  const snapshot =
    readStorage<ChatTabsSnapshot>(key) ??
    readStorage<ChatTabsSnapshot>(`${WINDOW_STORAGE_PREFIX}${launch.windowId}`);
  if (!snapshot) return false;
  removeStorage(key);

  const { chatTabsStore, navigateToChatTab } = await import("./chatTabs.svelte");
  chatTabsStore.restoreSnapshot(snapshot);
  const active = chatTabsStore.activeTab;
  if (active) await navigateToChatTab(active.id);
  await publishCurrentTauriChatWorkspaceState();
  return true;
}

async function readCurrentWindowBounds(): Promise<ChatWorkspaceBounds | undefined> {
  if (!isTauri) return undefined;
  try {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const current = getCurrentWebviewWindow();
    const [position, size, scale] = await Promise.all([
      current.outerPosition(),
      current.outerSize(),
      current.scaleFactor(),
    ]);
    return {
      x: Math.round(position.x / scale),
      y: Math.round(position.y / scale),
      width: Math.round(size.width / scale),
      height: Math.round(size.height / scale),
    };
  } catch {
    return undefined;
  }
}

export async function publishCurrentTauriChatWorkspaceState(): Promise<void> {
  if (!isTauri) return;
  const { chatTabsStore } = await import("./chatTabs.svelte");
  const windowId = getCurrentChatWorkspaceWindowId();
  const tabs = chatTabsStore.snapshot();
  const bounds = await readCurrentWindowBounds();
  writeStorage(`${WINDOW_STORAGE_PREFIX}${windowId}`, tabs);

  if (windowId === MAIN_CHAT_WORKSPACE_WINDOW_ID) {
    chatWindowManager.registerMain(tabs);
    if (bounds) chatWindowManager.updateBounds(windowId, bounds);
    persistWorkspaceManager();
    return;
  }

  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().emitTo(MAIN_CHAT_WORKSPACE_WINDOW_ID, WORKSPACE_STATE_EVENT, {
    windowId,
    tabs,
    bounds,
  } satisfies TauriWorkspaceStatePayload);
}

export async function initializeTauriChatWorkspaceRuntime(): Promise<void> {
  if (!isTauri || runtimeCleanup) return;
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const windowId = getCurrentChatWorkspaceWindowId();
  const cleanups: Array<() => void> = [];

  if (windowId === MAIN_CHAT_WORKSPACE_WINDOW_ID) {
    const persisted = readStorage<ReturnType<ChatWindowManager["snapshot"]>>(WORKSPACE_STORAGE_KEY);
    if (persisted?.version === 1) {
      try { chatWindowManager.restore(persisted); } catch { /* ignore stale layout */ }
    }
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const liveWindowIds = new Set((await getAllWebviewWindows()).map((window) => window.label));
    for (const window of chatWindowManager.listWindows()) {
      if (window.kind === "auxiliary" && !liveWindowIds.has(window.id)) {
        chatWindowManager.removeWindow(window.id);
        removeStorage(`${WINDOW_STORAGE_PREFIX}${window.id}`);
      }
    }
    await publishCurrentTauriChatWorkspaceState();
    cleanups.push(await current.listen<TauriWorkspaceStatePayload>(WORKSPACE_STATE_EVENT, (event) => {
      const payload = event.payload;
      if (!payload?.windowId?.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return;
      const existing = chatWindowManager.getWindow(payload.windowId);
      if (existing) chatWindowManager.updateTabs(payload.windowId, payload.tabs);
      else chatWindowManager.registerAuxiliary(payload.windowId, payload.tabs, payload.bounds);
      if (payload.bounds) chatWindowManager.updateBounds(payload.windowId, payload.bounds);
      persistWorkspaceManager();
    }));
    cleanups.push(await current.listen<string>(WORKSPACE_WINDOW_CLOSED_EVENT, (event) => {
      if (!event.payload?.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return;
      chatWindowManager.removeWindow(event.payload);
      removeStorage(`${WINDOW_STORAGE_PREFIX}${event.payload}`);
      persistWorkspaceManager();
    }));
  } else {
    cleanups.push(await current.onMoved(() => { void publishCurrentTauriChatWorkspaceState(); }));
    cleanups.push(await current.onResized(() => { void publishCurrentTauriChatWorkspaceState(); }));
    cleanups.push(await current.onCloseRequested(() => {
      void current.emitTo(MAIN_CHAT_WORKSPACE_WINDOW_ID, WORKSPACE_WINDOW_CLOSED_EVENT, windowId);
    }));
    await publishCurrentTauriChatWorkspaceState();
  }

  runtimeCleanup = () => {
    for (const cleanup of cleanups) cleanup();
    runtimeCleanup = null;
  };
}

export function getTauriChatWindowManager(): ChatWindowManager {
  return chatWindowManager;
}

export async function watchTauriChatTabTransferAck(
  payload: TauriChatDragPayload,
  onAccepted: () => void,
): Promise<() => void> {
  if (!isTauri || !isTauriChatDragPayload(payload)) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (current.label !== payload.sourceWindowLabel) return () => {};
  return current.listen<TauriChatDragPayload>(TAB_TRANSFER_ACK_EVENT, (event) => {
    const ack = event.payload;
    if (!isTauriChatDragPayload(ack)) return;
    if (ack.transferId !== payload.transferId || ack.sourceWindowId !== payload.sourceWindowId) return;
    if (ack.tab.id !== payload.tab.id) return;
    onAccepted();
  });
}

export async function acceptTauriChatTabDrop(
  payload: TauriChatDragPayload,
  groupId?: string,
  targetIndex?: number,
): Promise<boolean> {
  if (!isTauri || !isTauriChatDragPayload(payload)) return false;
  const targetWindowId = getCurrentChatWorkspaceWindowId();
  if (payload.sourceWindowId === targetWindowId) return false;

  const { chatTabsStore, navigateToChatTab } = await import("./chatTabs.svelte");
  const previousActiveId = chatTabsStore.activeTabId;
  const targetGroupId = groupId ?? chatTabsStore.focusedGroupId;
  const tab = chatTabsStore.importTransferredTab(
    payload.tab,
    targetGroupId,
    targetIndex ?? chatTabsStore.tabsForGroup(targetGroupId).length,
  );
  if (!tab) return false;

  let accepted = false;
  try {
    accepted = await navigateToChatTab(tab.id);
    if (accepted) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      accepted = Boolean(document.querySelector(`[data-chat-tab-id="${CSS.escape(tab.id)}"]`));
    }
    if (!accepted) throw new Error("Transferred tab did not become visible");
    await publishCurrentTauriChatWorkspaceState();
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await getCurrentWebviewWindow().emitTo(payload.sourceWindowLabel, TAB_TRANSFER_ACK_EVENT, payload);
    return true;
  } catch (error) {
    console.error("[TauriChatWorkspace] Failed to accept tab transfer", error);
    chatTabsStore.detach(tab.id);
    if (previousActiveId && chatTabsStore.tabs.some((item) => item.id === previousActiveId)) {
      await navigateToChatTab(previousActiveId);
    }
    await publishCurrentTauriChatWorkspaceState();
    return false;
  }
}

export async function completeCurrentTauriTabTransfer(payload: TauriChatDragPayload): Promise<boolean> {
  if (!isTauri || getCurrentChatWorkspaceWindowId() !== payload.sourceWindowId) return false;
  const { chatTabsStore, navigateToChatTab } = await import("./chatTabs.svelte");
  const { selectedCharID } = await import("./stores.svelte");
  const result = chatTabsStore.detach(payload.tab.id);
  if (result.becameEmpty) selectedCharID.set(-1);
  else if (result.activeChanged && result.activeTab) await navigateToChatTab(result.activeTab.id);
  await publishCurrentTauriChatWorkspaceState();
  if (result.becameEmpty && payload.sourceWindowId !== MAIN_CHAT_WORKSPACE_WINDOW_ID) {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const current = getCurrentWebviewWindow();
    await current.emitTo(
      MAIN_CHAT_WORKSPACE_WINDOW_ID,
      WORKSPACE_WINDOW_CLOSED_EVENT,
      payload.sourceWindowId,
    );
    await current.close();
  }
  return true;
}

export async function isCurrentTauriCursorOutsideWindow(margin = 4): Promise<boolean> {
  if (!isTauri) return false;
  const [{ getCurrentWebviewWindow }, { cursorPosition }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/window"),
  ]);
  const current = getCurrentWebviewWindow();
  const [cursor, position, size] = await Promise.all([
    cursorPosition(),
    current.innerPosition(),
    current.innerSize(),
  ]);
  return isPointOutsideTauriWindow(cursor, position, size, margin);
}
