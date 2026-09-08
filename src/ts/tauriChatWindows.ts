import type { ChatTab } from "./chatTabs.svelte";
import { isTauri } from "./platform";

const CHAT_WINDOW_KIND_PARAM = "risuWindow";
const CHARACTER_ID_PARAM = "characterId";
const CHAT_ID_PARAM = "chatId";
const CHARACTER_NAME_PARAM = "characterName";
const CHAT_NAME_PARAM = "chatName";
const CHAT_WINDOW_KIND = "chat";
const CHAT_DROP_ACK_EVENT = "risu://dock-chat-drop-ack";
export const TAURI_CHAT_DRAG_MIME = "application/x-risu-chat-tab";
const MAIN_WINDOW_LABEL = "main";
const CHAT_WINDOW_LABEL_PREFIX = "chat-window-";

interface PhysicalPoint {
  x: number;
  y: number;
}

interface PhysicalArea {
  width: number;
  height: number;
}

export interface TauriChatWindowTarget {
  characterId: string;
  chatId: string;
}

export interface TauriChatWindowPresentation {
  characterName?: string;
  chatName?: string;
}

export interface TauriChatDragPayload extends TauriChatWindowTarget {
  sourceWindowLabel: string;
  transferId: string;
}

export function parseTauriChatWindowTarget(
  search: string,
): TauriChatWindowTarget | null {
  const params = new URLSearchParams(search);
  if (params.get(CHAT_WINDOW_KIND_PARAM) !== CHAT_WINDOW_KIND) return null;

  const characterId = params.get(CHARACTER_ID_PARAM)?.trim();
  const chatId = params.get(CHAT_ID_PARAM)?.trim();
  if (!characterId || !chatId) return null;
  return { characterId, chatId };
}

export function parseTauriChatWindowPresentation(
  search: string,
): TauriChatWindowPresentation {
  const params = new URLSearchParams(search);
  return {
    characterName: params.get(CHARACTER_NAME_PARAM)?.trim() || undefined,
    chatName: params.get(CHAT_NAME_PARAM)?.trim() || undefined,
  };
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

function isTauriChatWindowTarget(
  value: unknown,
): value is TauriChatWindowTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<TauriChatWindowTarget>;
  return (
    typeof target.characterId === "string" &&
    target.characterId.length > 0 &&
    typeof target.chatId === "string" &&
    target.chatId.length > 0
  );
}

function isTauriChatDragPayload(
  value: unknown,
): value is TauriChatDragPayload {
  if (!isTauriChatWindowTarget(value)) return false;
  const payload = value as Partial<TauriChatDragPayload>;
  return (
    typeof payload.sourceWindowLabel === "string" &&
    payload.sourceWindowLabel.startsWith(CHAT_WINDOW_LABEL_PREFIX) &&
    typeof payload.transferId === "string" &&
    payload.transferId.length > 0
  );
}

export function buildTauriChatWindowUrl(
  target: TauriChatWindowTarget,
  pathname = "/",
  presentation: TauriChatWindowPresentation = {},
): string {
  const params = new URLSearchParams({
    [CHAT_WINDOW_KIND_PARAM]: CHAT_WINDOW_KIND,
    [CHARACTER_ID_PARAM]: target.characterId,
    [CHAT_ID_PARAM]: target.chatId,
  });
  if (presentation.characterName) {
    params.set(CHARACTER_NAME_PARAM, presentation.characterName);
  }
  if (presentation.chatName) {
    params.set(CHAT_NAME_PARAM, presentation.chatName);
  }
  return `${pathname || "/"}?${params.toString()}`;
}

function createChatWindowLabel(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `chat-window-${Date.now().toString(36)}-${random}`;
}

export async function openChatInNewTauriWindow(
  tab: Pick<ChatTab, "characterId" | "chatId">,
  title = "RisuAI",
  presentation: TauriChatWindowPresentation = {},
): Promise<boolean> {
  if (!isTauri) return false;

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const child = new WebviewWindow(createChatWindowLabel(), {
    url: buildTauriChatWindowUrl(tab, location.pathname, presentation),
    title,
    width: Math.max(720, Math.min(window.innerWidth, 1280)),
    height: Math.max(600, Math.min(window.innerHeight, 960)),
    minWidth: 300,
    minHeight: 500,
    resizable: true,
    visible: true,
    focus: true,
  });

  return new Promise<boolean>((resolve, reject) => {
    void child.once("tauri://created", () => resolve(true));
    void child.once("tauri://error", (event) => {
      reject(
        new Error(`Failed to create chat window: ${String(event.payload)}`),
      );
    });
  });
}

export async function restoreTauriChatWindowTarget(
  search = location.search,
): Promise<boolean> {
  if (!isTauri) return false;
  const target = parseTauriChatWindowTarget(search);
  if (!target) return false;

  const { openChatTargetInTab } = await import("./chatTabs.svelte");
  return openChatTargetInTab(target.characterId, target.chatId);
}

export function parseTauriChatDragPayload(value: string): TauriChatDragPayload | null {
  try {
    const payload = JSON.parse(value) as unknown;
    if (!payload || typeof payload !== "object") return null;
    return isTauriChatDragPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function serializeTauriChatDragPayload(
  payload: TauriChatDragPayload,
): string {
  return JSON.stringify(payload);
}

export async function getCurrentTauriChatWindowDragPayload(
  target: TauriChatWindowTarget,
): Promise<TauriChatDragPayload | null> {
  if (!isTauri || !isTauriChatWindowTarget(target)) return null;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (!current.label.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return null;
  return {
    ...target,
    sourceWindowLabel: current.label,
    transferId:
      globalThis.crypto?.randomUUID?.() ??
      `chat-transfer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
}

export async function acceptDetachedTauriChatDrop(
  payload: TauriChatDragPayload,
  groupId?: string,
): Promise<boolean> {
  if (!isTauri || !isTauriChatDragPayload(payload)) return false;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (current.label !== MAIN_WINDOW_LABEL) return false;

  const { chatTabsStore, navigateToChatTab } = await import("./chatTabs.svelte");
  const previousActiveId = chatTabsStore.activeTabId;
  const existing = chatTabsStore.tabs.find(
    (tab) =>
      tab.characterId === payload.characterId && tab.chatId === payload.chatId,
  );
  const tab = chatTabsStore.openTarget(
    payload.characterId,
    payload.chatId,
    groupId ?? chatTabsStore.focusedGroupId,
  );

  let accepted = false;
  try {
    accepted = await navigateToChatTab(tab.id);
    if (accepted) {
      accepted = await verifyDockedTauriChatState(payload, tab.id);
    }
  } catch (error) {
    console.error("[TauriChatWindows] Failed to accept detached chat drop", error);
    accepted = false;
  }

  if (!accepted) {
    if (!existing) chatTabsStore.detach(tab.id);
    if (previousActiveId && chatTabsStore.tabs.some((item) => item.id === previousActiveId)) {
      await navigateToChatTab(previousActiveId);
    }
    return false;
  }

  await current.emitTo(payload.sourceWindowLabel, CHAT_DROP_ACK_EVENT, {
    characterId: payload.characterId,
    chatId: payload.chatId,
    sourceWindowLabel: payload.sourceWindowLabel,
    transferId: payload.transferId,
  } satisfies TauriChatDragPayload);
  return true;
}

async function verifyDockedTauriChatState(
  payload: TauriChatDragPayload,
  tabId: string,
): Promise<boolean> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const [{ get }, { selectedCharID }, { characterStore }, { chatTabsStore }] =
    await Promise.all([
      import("svelte/store"),
      import("./stores.svelte"),
      import("./stores/domain/characterStore.svelte"),
      import("./chatTabs.svelte"),
    ]);

  const tab = chatTabsStore.tabs.find((item) => item.id === tabId);
  if (!tab || tab.characterId !== payload.characterId || tab.chatId !== payload.chatId) {
    return false;
  }
  const group = chatTabsStore.getGroup(tab.groupId);
  if (
    chatTabsStore.focusedGroupId !== tab.groupId ||
    group?.activeTabId !== tab.id
  ) {
    return false;
  }

  const renderedTab = document.querySelector(
    `[data-chat-tab-id="${CSS.escape(tab.id)}"]`,
  );
  if (!renderedTab) return false;

  const selectedIndex = get(selectedCharID);
  const character = characterStore.characters[selectedIndex];
  const chat = character?.chats?.[character.chatPage ?? 0];
  return (
    character?.chaId === payload.characterId &&
    chat?.id === payload.chatId
  );
}

export async function watchDetachedTauriChatDropAck(
  payload: TauriChatDragPayload,
  onAccepted: () => void,
): Promise<() => void> {
  if (!isTauri || !isTauriChatDragPayload(payload)) return () => {};
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (current.label !== payload.sourceWindowLabel) return () => {};

  return current.listen<TauriChatDragPayload>(CHAT_DROP_ACK_EVENT, (event) => {
    if (!isTauriChatDragPayload(event.payload)) return;
    if (event.payload.transferId !== payload.transferId) return;
    if (
      event.payload.characterId !== payload.characterId ||
      event.payload.chatId !== payload.chatId
    ) return;
    onAccepted();
  });
}

export async function closeCurrentDetachedTauriChatWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (!current.label.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return;
  await current.close();
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
    current.innerPosition(),
    current.innerSize(),
  ]);
  return isPointOutsideTauriWindow(cursor, position, size, margin);
}

export async function watchCurrentTauriWindowExit(
  onExit: () => void,
  intervalMs = 32,
): Promise<() => void> {
  if (!isTauri) return () => {};
  const [{ getCurrentWebviewWindow }, { cursorPosition }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/window"),
  ]);
  const current = getCurrentWebviewWindow();
  let stopped = false;
  let checking = false;

  const timer = setInterval(
    () => {
      if (stopped || checking) return;
      checking = true;
      void Promise.all([
        cursorPosition(),
        current.innerPosition(),
        current.innerSize(),
      ])
        .then(([cursor, position, size]) => {
          if (
            !stopped &&
            isPointOutsideTauriWindow(cursor, position, size, 4)
          ) {
            stopped = true;
            clearInterval(timer);
            onExit();
          }
        })
        .catch((error) => {
          console.error(
            "[TauriChatWindows] Failed to inspect cursor during tab drag",
            error,
          );
        })
        .finally(() => {
          checking = false;
        });
    },
    Math.max(30, intervalMs),
  );

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
