import type { ChatTab, ChatTabsSnapshot } from "./chatTabs.svelte";
import {
  ChatWindowManager,
  MAIN_CHAT_WORKSPACE_WINDOW_ID,
  cloneTabsSnapshot,
  createSingleTabSnapshot,
  type ChatWorkspaceBounds,
} from "./chatWorkspace";
import { isTauri, isTauriMacOS } from "./platform";

const WINDOW_KIND_PARAM = "risuWindow";
const WINDOW_ID_PARAM = "workspaceWindowId";
const CHARACTER_NAME_PARAM = "characterName";
const CHAT_NAME_PARAM = "chatName";
const WORKSPACE_WINDOW_KIND = "chat-workspace";
const CHAT_WINDOW_LABEL_PREFIX = "chat-window-";
const WORKSPACE_STATE_EVENT = "risu://chat-workspace-state";
const WORKSPACE_WINDOW_CLOSED_EVENT = "risu://chat-workspace-window-closed";
const TAB_TRANSFER_ACK_EVENT = "risu://chat-workspace-tab-transfer-ack";
const TAB_TRANSFER_REQUEST_EVENT = "risu://chat-workspace-tab-transfer-request";
const DOCK_PREVIEW_EVENT = "risu://chat-workspace-dock-preview";
const WORKSPACE_STORAGE_KEY = "risu:chat-workspace:v1";
const WINDOW_STORAGE_PREFIX = "risu:chat-workspace-window:";
const LAUNCH_STORAGE_PREFIX = "risu:chat-workspace-launch:";
const ACTIVE_DRAG_STORAGE_KEY = "risu:chat-workspace-active-drag";
const ACTIVE_DRAG_MAX_AGE_MS = 30_000;
export const TAURI_CHAT_DRAG_MIME = "application/x-risu-chat-tab";

interface PhysicalPoint {
  x: number;
  y: number;
}
interface PhysicalArea {
  width: number;
  height: number;
}

export interface TauriWorkspaceWindowHitBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TauriDetachedWindowPlacementInput {
  cursor: PhysicalPoint;
  scaleFactor: number;
  workAreaPosition: PhysicalPoint;
  workAreaSize: PhysicalArea;
  windowWidth: number;
  windowHeight: number;
}

export type TauriOutsideTabDropAction =
  "transfer" | "move-current-window" | "create-window";

export function resolveTauriOutsideTabDropAction(
  sourceWindowId: string,
  tabCount: number,
  targetWindowId: string | null,
): TauriOutsideTabDropAction {
  if (targetWindowId) return "transfer";
  if (
    sourceWindowId !== MAIN_CHAT_WORKSPACE_WINDOW_ID &&
    sourceWindowId.startsWith(CHAT_WINDOW_LABEL_PREFIX) &&
    tabCount === 1
  ) {
    return "move-current-window";
  }
  return "create-window";
}

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

interface TauriDockPreviewPayload {
  transferId: string;
  active: boolean;
}

interface TauriWorkspaceStatePayload {
  windowId: string;
  tabs: ChatTabsSnapshot;
  bounds?: ChatWorkspaceBounds;
}

const chatWindowManager = new ChatWindowManager();
let runtimeCleanup: (() => void) | null = null;
let dockPreviewTargetWindowId: string | null = null;
let dockPreviewTransferId: string | null = null;
let dockPreviewExpiryTimer: ReturnType<typeof setTimeout> | null = null;

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
    typeof tab.id === "string" &&
    tab.id.length > 0 &&
    typeof tab.groupId === "string" &&
    tab.groupId.length > 0 &&
    typeof tab.characterId === "string" &&
    tab.characterId.length > 0 &&
    typeof tab.chatId === "string" &&
    tab.chatId.length > 0 &&
    typeof tab.unread === "boolean" &&
    typeof tab.draft === "string" &&
    typeof tab.translatedDraft === "string" &&
    Array.isArray(tab.fileInput) &&
    tab.fileInput.every((item) => typeof item === "string")
  );
}

function isTauriChatDragPayload(value: unknown): value is TauriChatDragPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<TauriChatDragPayload>;
  return (
    typeof payload.sourceWindowId === "string" &&
    payload.sourceWindowId.length > 0 &&
    typeof payload.sourceWindowLabel === "string" &&
    payload.sourceWindowLabel.length > 0 &&
    typeof payload.transferId === "string" &&
    payload.transferId.length > 0 &&
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
  if (presentation.characterName)
    params.set(CHARACTER_NAME_PARAM, presentation.characterName);
  if (presentation.chatName) params.set(CHAT_NAME_PARAM, presentation.chatName);
  return `${pathname || "/"}?${params.toString()}`;
}

export function getCurrentChatWorkspaceWindowId(
  search = typeof location === "undefined" ? "" : location.search,
): string {
  return (
    parseTauriChatWorkspaceLaunch(search)?.windowId ??
    MAIN_CHAT_WORKSPACE_WINDOW_ID
  );
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

function isWorkspaceWindowId(id: string): boolean {
  return (
    id === MAIN_CHAT_WORKSPACE_WINDOW_ID ||
    id.startsWith(CHAT_WINDOW_LABEL_PREFIX)
  );
}

export function findWorkspaceWindowAtPoint(
  cursor: PhysicalPoint,
  windows: TauriWorkspaceWindowHitBox[],
  sourceWindowId: string,
): string | null {
  const matches = windows.filter(
    (window) =>
      window.id !== sourceWindowId &&
      isWorkspaceWindowId(window.id) &&
      cursor.x >= window.x &&
      cursor.x <= window.x + window.width &&
      cursor.y >= window.y &&
      cursor.y <= window.y + window.height,
  );
  if (matches.length === 0) return null;

  // Auxiliary windows are usually layered above the main window. Prefer them
  // when native bounds overlap, then prefer the smaller (more specific) window.
  matches.sort((a, b) => {
    const aMain = a.id === MAIN_CHAT_WORKSPACE_WINDOW_ID ? 1 : 0;
    const bMain = b.id === MAIN_CHAT_WORKSPACE_WINDOW_ID ? 1 : 0;
    if (aMain !== bMain) return aMain - bMain;
    return a.width * a.height - b.width * b.height;
  });
  return matches[0].id;
}

export async function findTauriWorkspaceWindowUnderCursor(
  sourceWindowId = getCurrentChatWorkspaceWindowId(),
): Promise<string | null> {
  if (!isTauri) return null;
  const [{ getAllWebviewWindows }, { cursorPosition }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/window"),
  ]);
  const cursor = await cursorPosition();
  const windows = (await getAllWebviewWindows()).filter(
    (window) =>
      window.label !== sourceWindowId && isWorkspaceWindowId(window.label),
  );
  const hitBoxes = (
    await Promise.all(
      windows.map(
        async (window): Promise<TauriWorkspaceWindowHitBox | null> => {
          try {
            const [position, size] = await Promise.all([
              window.outerPosition(),
              window.outerSize(),
            ]);
            return {
              id: window.label,
              x: position.x,
              y: position.y,
              width: size.width,
              height: size.height,
            };
          } catch {
            return null;
          }
        },
      ),
    )
  ).filter((window): window is TauriWorkspaceWindowHitBox => window !== null);
  return findWorkspaceWindowAtPoint(cursor, hitBoxes, sourceWindowId);
}

export function calculateDetachedWindowPlacement(
  input: TauriDetachedWindowPlacementInput,
): { x: number; y: number } {
  const scale =
    Number.isFinite(input.scaleFactor) && input.scaleFactor > 0
      ? input.scaleFactor
      : 1;
  const cursorX = input.cursor.x / scale;
  const cursorY = input.cursor.y / scale;
  const workX = input.workAreaPosition.x / scale;
  const workY = input.workAreaPosition.y / scale;
  const workWidth = input.workAreaSize.width / scale;
  const workHeight = input.workAreaSize.height / scale;

  // Keep the grabbed tab/header close to the pointer instead of placing the
  // pointer on the exact top-left corner of the detached window.
  const desiredX = cursorX - 140;
  const desiredY = cursorY - 18;
  const maxX = Math.max(workX, workX + workWidth - input.windowWidth);
  const maxY = Math.max(workY, workY + workHeight - input.windowHeight);
  return {
    x: Math.round(Math.min(Math.max(desiredX, workX), maxX)),
    y: Math.round(Math.min(Math.max(desiredY, workY), maxY)),
  };
}

async function getDetachedWindowPlacement(
  windowWidth: number,
  windowHeight: number,
): Promise<{ x: number; y: number } | undefined> {
  try {
    const { cursorPosition, monitorFromPoint } =
      await import("@tauri-apps/api/window");
    const cursor = await cursorPosition();
    const monitor = await monitorFromPoint(cursor.x, cursor.y);
    if (!monitor) return undefined;
    return calculateDetachedWindowPlacement({
      cursor,
      scaleFactor: monitor.scaleFactor,
      workAreaPosition: monitor.workArea.position,
      workAreaSize: monitor.workArea.size,
      windowWidth,
      windowHeight,
    });
  } catch (error) {
    console.warn(
      "[TauriChatWorkspace] Failed to place detached window at cursor",
      error,
    );
    return undefined;
  }
}

export async function moveCurrentTauriWorkspaceWindowToCursor(): Promise<boolean> {
  if (!isTauri) return false;
  const windowId = getCurrentChatWorkspaceWindowId();
  if (windowId === MAIN_CHAT_WORKSPACE_WINDOW_ID) return false;

  try {
    const [{ getCurrentWebviewWindow }, windowApi] = await Promise.all([
      import("@tauri-apps/api/webviewWindow"),
      import("@tauri-apps/api/window"),
    ]);
    const current = getCurrentWebviewWindow();
    const cursor = await windowApi.cursorPosition();
    const monitor = await windowApi.monitorFromPoint(cursor.x, cursor.y);
    if (!monitor) return false;
    const [size, currentScale] = await Promise.all([
      current.outerSize(),
      current.scaleFactor(),
    ]);
    const placement = calculateDetachedWindowPlacement({
      cursor,
      scaleFactor: monitor.scaleFactor,
      workAreaPosition: monitor.workArea.position,
      workAreaSize: monitor.workArea.size,
      windowWidth: size.width / currentScale,
      windowHeight: size.height / currentScale,
    });
    await current.setPosition(
      new windowApi.LogicalPosition(placement.x, placement.y),
    );
    return true;
  } catch (error) {
    console.warn(
      "[TauriChatWorkspace] Failed to move auxiliary window to cursor",
      error,
    );
    return false;
  }
}

async function emitDockPreview(
  targetWindowId: string,
  transferId: string,
  active: boolean,
): Promise<void> {
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().emitTo(targetWindowId, DOCK_PREVIEW_EVENT, {
    transferId,
    active,
  } satisfies TauriDockPreviewPayload);
}

export async function updateTauriChatDockPreview(
  payload: TauriChatDragPayload,
): Promise<string | null> {
  if (!isTauri || !isTauriChatDragPayload(payload)) return null;
  const targetWindowId = await findTauriWorkspaceWindowUnderCursor(
    payload.sourceWindowId,
  );
  if (
    dockPreviewTargetWindowId &&
    dockPreviewTargetWindowId !== targetWindowId
  ) {
    await emitDockPreview(
      dockPreviewTargetWindowId,
      dockPreviewTransferId ?? payload.transferId,
      false,
    );
  }
  dockPreviewTargetWindowId = targetWindowId;
  dockPreviewTransferId = payload.transferId;
  if (targetWindowId) {
    await emitDockPreview(targetWindowId, payload.transferId, true);
  }
  return targetWindowId;
}

export async function clearTauriChatDockPreview(
  payload?: TauriChatDragPayload,
): Promise<void> {
  if (!dockPreviewTargetWindowId) return;
  const targetWindowId = dockPreviewTargetWindowId;
  const transferId = dockPreviewTransferId ?? payload?.transferId;
  dockPreviewTargetWindowId = null;
  dockPreviewTransferId = null;
  if (!transferId) return;
  try {
    await emitDockPreview(targetWindowId, transferId, false);
  } catch {
    // The target may have closed while a drag was active.
  }
}

function setCurrentWindowDockPreview(payload: TauriDockPreviewPayload): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (payload.active) {
    root.dataset.risuChatDockPreview = "true";
    root.dataset.risuChatDockPreviewTransfer = payload.transferId;
    if (dockPreviewExpiryTimer) clearTimeout(dockPreviewExpiryTimer);
    dockPreviewExpiryTimer = setTimeout(() => {
      if (root.dataset.risuChatDockPreviewTransfer !== payload.transferId)
        return;
      delete root.dataset.risuChatDockPreview;
      delete root.dataset.risuChatDockPreviewTransfer;
      dockPreviewExpiryTimer = null;
    }, 350);
    return;
  }
  if (root.dataset.risuChatDockPreviewTransfer !== payload.transferId) return;
  if (dockPreviewExpiryTimer) clearTimeout(dockPreviewExpiryTimer);
  dockPreviewExpiryTimer = null;
  delete root.dataset.risuChatDockPreview;
  delete root.dataset.risuChatDockPreviewTransfer;
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

export function serializeTauriChatDragPayload(
  payload: TauriChatDragPayload,
): string {
  return JSON.stringify(payload);
}

export function parseTauriChatDragPayload(
  value: string,
): TauriChatDragPayload | null {
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
  writeStorage(ACTIVE_DRAG_STORAGE_KEY, {
    payload,
    startedAt,
  } satisfies StoredTauriChatDragPayload);
}

export function getActiveTauriChatDragPayload(
  now = Date.now(),
): TauriChatDragPayload | null {
  const stored = readStorage<StoredTauriChatDragPayload>(
    ACTIVE_DRAG_STORAGE_KEY,
  );
  if (
    !stored ||
    !isTauriChatDragPayload(stored.payload) ||
    !Number.isFinite(stored.startedAt)
  ) {
    removeStorage(ACTIVE_DRAG_STORAGE_KEY);
    return null;
  }
  if (
    now - stored.startedAt > ACTIVE_DRAG_MAX_AGE_MS ||
    now < stored.startedAt
  ) {
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
    console.warn(
      "[TauriChatWorkspace] Failed to persist workspace state",
      error,
    );
  }
}

function removeStorage(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function persistWorkspaceManager(): void {
  writeStorage(WORKSPACE_STORAGE_KEY, chatWindowManager.snapshot());
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("risu:workspace-menu-refresh"));
  }
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

  const width =
    bounds?.width ?? Math.max(720, Math.min(window.innerWidth, 1280));
  const height =
    bounds?.height ?? Math.max(600, Math.min(window.innerHeight, 960));
  const placement = bounds
    ? { x: bounds.x, y: bounds.y }
    : await getDetachedWindowPlacement(width, height);

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const child = new WebviewWindow(windowId, {
    url: buildTauriChatWorkspaceWindowUrl(
      windowId,
      location.pathname,
      presentation,
    ),
    title,
    x: placement?.x,
    y: placement?.y,
    width,
    height,
    minWidth: 300,
    minHeight: 500,
    resizable: true,
    transparent: isTauriMacOS,
    visible: true,
    focus: true,
  });

  return new Promise<boolean>((resolve, reject) => {
    void child.once("tauri://created", () => resolve(true));
    void child.once("tauri://error", (event) => {
      removeStorage(`${LAUNCH_STORAGE_PREFIX}${windowId}`);
      reject(
        new Error(
          `Failed to create auxiliary chat window: ${String(event.payload)}`,
        ),
      );
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
  const created = await openAuxiliaryWindow(
    windowId,
    tabs,
    title,
    presentation,
  );
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

  const { chatTabsStore, navigateToChatTab } =
    await import("./chatTabs.svelte");
  chatTabsStore.restoreSnapshot(snapshot);
  const active = chatTabsStore.activeTab;
  if (!active) {
    console.error(
      "[TauriChatWorkspace] Restored auxiliary window has no active tab",
      launch.windowId,
    );
    return false;
  }
  const navigated = await navigateToChatTab(active.id);
  if (!navigated) {
    console.error(
      "[TauriChatWorkspace] Failed to navigate restored auxiliary tab",
      {
        windowId: launch.windowId,
        tabId: active.id,
        characterId: active.characterId,
        chatId: active.chatId,
      },
    );
    return false;
  }
  await publishCurrentTauriChatWorkspaceState();
  return true;
}

async function readCurrentWindowBounds(): Promise<
  ChatWorkspaceBounds | undefined
> {
  if (!isTauri) return undefined;
  try {
    const { getCurrentWebviewWindow } =
      await import("@tauri-apps/api/webviewWindow");
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

  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  await getCurrentWebviewWindow().emitTo(
    MAIN_CHAT_WORKSPACE_WINDOW_ID,
    WORKSPACE_STATE_EVENT,
    {
      windowId,
      tabs,
      bounds,
    } satisfies TauriWorkspaceStatePayload,
  );
}

export async function initializeTauriChatWorkspaceRuntime(): Promise<void> {
  if (!isTauri || runtimeCleanup) return;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  const windowId = getCurrentChatWorkspaceWindowId();
  const cleanups: Array<() => void> = [];

  cleanups.push(
    await current.listen<TauriDockPreviewPayload>(
      DOCK_PREVIEW_EVENT,
      (event) => {
        const payload = event.payload;
        if (
          !payload ||
          typeof payload.transferId !== "string" ||
          typeof payload.active !== "boolean"
        )
          return;
        setCurrentWindowDockPreview(payload);
      },
    ),
  );

  cleanups.push(
    await current.listen<TauriChatDragPayload>(
      TAB_TRANSFER_REQUEST_EVENT,
      (event) => {
        const payload = event.payload;
        if (
          !isTauriChatDragPayload(payload) ||
          payload.sourceWindowId === windowId
        )
          return;
        void acceptTauriChatTabDrop(payload);
      },
    ),
  );

  if (windowId === MAIN_CHAT_WORKSPACE_WINDOW_ID) {
    const persisted = readStorage<ReturnType<ChatWindowManager["snapshot"]>>(
      WORKSPACE_STORAGE_KEY,
    );
    if (persisted?.version === 1) {
      try {
        chatWindowManager.restore(persisted);
      } catch {
        /* ignore stale layout */
      }
    }
    const { getAllWebviewWindows } =
      await import("@tauri-apps/api/webviewWindow");
    const liveWindowIds = new Set(
      (await getAllWebviewWindows()).map((window) => window.label),
    );
    for (const window of chatWindowManager.listWindows()) {
      if (window.kind === "auxiliary" && !liveWindowIds.has(window.id)) {
        chatWindowManager.removeWindow(window.id);
        removeStorage(`${WINDOW_STORAGE_PREFIX}${window.id}`);
      }
    }
    await publishCurrentTauriChatWorkspaceState();
    cleanups.push(
      await current.listen<TauriWorkspaceStatePayload>(
        WORKSPACE_STATE_EVENT,
        (event) => {
          const payload = event.payload;
          if (!payload?.windowId?.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return;
          const existing = chatWindowManager.getWindow(payload.windowId);
          if (existing)
            chatWindowManager.updateTabs(payload.windowId, payload.tabs);
          else
            chatWindowManager.registerAuxiliary(
              payload.windowId,
              payload.tabs,
              payload.bounds,
            );
          if (payload.bounds)
            chatWindowManager.updateBounds(payload.windowId, payload.bounds);
          persistWorkspaceManager();
        },
      ),
    );
    cleanups.push(
      await current.listen<string>(WORKSPACE_WINDOW_CLOSED_EVENT, (event) => {
        if (!event.payload?.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return;
        chatWindowManager.removeWindow(event.payload);
        removeStorage(`${WINDOW_STORAGE_PREFIX}${event.payload}`);
        persistWorkspaceManager();
      }),
    );
  } else {
    cleanups.push(
      await current.onMoved(() => {
        void publishCurrentTauriChatWorkspaceState();
      }),
    );
    cleanups.push(
      await current.onResized(() => {
        void publishCurrentTauriChatWorkspaceState();
      }),
    );
    cleanups.push(
      await current.onCloseRequested(() => {
        void current.emitTo(
          MAIN_CHAT_WORKSPACE_WINDOW_ID,
          WORKSPACE_WINDOW_CLOSED_EVENT,
          windowId,
        );
      }),
    );
    await publishCurrentTauriChatWorkspaceState();
  }

  runtimeCleanup = () => {
    for (const cleanup of cleanups) cleanup();
    if (dockPreviewExpiryTimer) clearTimeout(dockPreviewExpiryTimer);
    dockPreviewExpiryTimer = null;
    if (typeof document !== "undefined") {
      delete document.documentElement.dataset.risuChatDockPreview;
      delete document.documentElement.dataset.risuChatDockPreviewTransfer;
    }
    runtimeCleanup = null;
  };
}

export function getTauriChatWindowManager(): ChatWindowManager {
  return chatWindowManager;
}

export async function requestTauriChatTabTransferToWindow(
  payload: TauriChatDragPayload,
  targetWindowId: string,
  timeoutMs = 1500,
): Promise<boolean> {
  if (
    !isTauri ||
    !isTauriChatDragPayload(payload) ||
    !isWorkspaceWindowId(targetWindowId) ||
    targetWindowId === payload.sourceWindowId
  )
    return false;

  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (current.label !== payload.sourceWindowLabel) return false;

  let resolveAck: (accepted: boolean) => void = () => {};
  const ack = new Promise<boolean>((resolve) => {
    resolveAck = resolve;
  });
  const unlisten = await current.listen<TauriChatDragPayload>(
    TAB_TRANSFER_ACK_EVENT,
    (event) => {
      const received = event.payload;
      if (!isTauriChatDragPayload(received)) return;
      if (received.transferId !== payload.transferId) return;
      if (received.sourceWindowId !== payload.sourceWindowId) return;
      if (received.tab.id !== payload.tab.id) return;
      resolveAck(true);
    },
  );
  const timer = setTimeout(() => resolveAck(false), timeoutMs);
  try {
    await current.emitTo(targetWindowId, TAB_TRANSFER_REQUEST_EVENT, payload);
    return await ack;
  } catch (error) {
    console.error("[TauriChatWorkspace] Failed to request tab transfer", error);
    return false;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
}

export async function watchTauriChatTabTransferAck(
  payload: TauriChatDragPayload,
  onAccepted: () => void,
): Promise<() => void> {
  if (!isTauri || !isTauriChatDragPayload(payload)) return () => {};
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (current.label !== payload.sourceWindowLabel) return () => {};
  return current.listen<TauriChatDragPayload>(
    TAB_TRANSFER_ACK_EVENT,
    (event) => {
      const ack = event.payload;
      if (!isTauriChatDragPayload(ack)) return;
      if (
        ack.transferId !== payload.transferId ||
        ack.sourceWindowId !== payload.sourceWindowId
      )
        return;
      if (ack.tab.id !== payload.tab.id) return;
      onAccepted();
    },
  );
}

export async function acceptTauriChatTabDrop(
  payload: TauriChatDragPayload,
  groupId?: string,
  targetIndex?: number,
): Promise<boolean> {
  if (!isTauri || !isTauriChatDragPayload(payload)) return false;
  const targetWindowId = getCurrentChatWorkspaceWindowId();
  if (payload.sourceWindowId === targetWindowId) return false;

  const { chatTabsStore, navigateToChatTab } =
    await import("./chatTabs.svelte");
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
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      accepted = Boolean(
        document.querySelector(`[data-chat-tab-id="${CSS.escape(tab.id)}"]`),
      );
    }
    if (!accepted) throw new Error("Transferred tab did not become visible");
    await publishCurrentTauriChatWorkspaceState();
    const { getCurrentWebviewWindow } =
      await import("@tauri-apps/api/webviewWindow");
    await getCurrentWebviewWindow().emitTo(
      payload.sourceWindowLabel,
      TAB_TRANSFER_ACK_EVENT,
      payload,
    );
    return true;
  } catch (error) {
    console.error("[TauriChatWorkspace] Failed to accept tab transfer", error);
    chatTabsStore.detach(tab.id);
    if (
      previousActiveId &&
      chatTabsStore.tabs.some((item) => item.id === previousActiveId)
    ) {
      await navigateToChatTab(previousActiveId);
    }
    await publishCurrentTauriChatWorkspaceState();
    return false;
  }
}

export async function completeCurrentTauriTabTransfer(
  payload: TauriChatDragPayload,
): Promise<boolean> {
  if (!isTauri || getCurrentChatWorkspaceWindowId() !== payload.sourceWindowId)
    return false;
  const { chatTabsStore, navigateToChatTab } =
    await import("./chatTabs.svelte");
  const { selectedCharID } = await import("./stores.svelte");
  const result = chatTabsStore.detach(payload.tab.id);
  if (result.becameEmpty) selectedCharID.set(-1);
  else if (result.activeChanged && result.activeTab)
    await navigateToChatTab(result.activeTab.id);
  await publishCurrentTauriChatWorkspaceState();
  if (
    result.becameEmpty &&
    payload.sourceWindowId !== MAIN_CHAT_WORKSPACE_WINDOW_ID
  ) {
    const { getCurrentWebviewWindow } =
      await import("@tauri-apps/api/webviewWindow");
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

export async function isCurrentTauriCursorOutsideWindow(
  margin = 4,
): Promise<boolean> {
  if (!isTauri) return false;
  const [{ getCurrentWebviewWindow }, { cursorPosition }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/window"),
  ]);
  const current = getCurrentWebviewWindow();
  const [cursor, position, size] = await Promise.all([
    cursorPosition(),
    current.outerPosition(),
    current.outerSize(),
  ]);
  return isPointOutsideTauriWindow(cursor, position, size, margin);
}
