import type { ChatTab } from "./chatTabs.svelte";
import { isTauri } from "./platform";

const CHAT_WINDOW_KIND_PARAM = "risuWindow";
const CHARACTER_ID_PARAM = "characterId";
const CHAT_ID_PARAM = "chatId";
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

export interface TauriChatDragPayload extends TauriChatWindowTarget {
  sourceWindowLabel: string;
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
    payload.sourceWindowLabel.startsWith(CHAT_WINDOW_LABEL_PREFIX)
  );
}

export function buildTauriChatWindowUrl(
  target: TauriChatWindowTarget,
  pathname = "/",
): string {
  const params = new URLSearchParams({
    [CHAT_WINDOW_KIND_PARAM]: CHAT_WINDOW_KIND,
    [CHARACTER_ID_PARAM]: target.characterId,
    [CHAT_ID_PARAM]: target.chatId,
  });
  return `${pathname || "/"}?${params.toString()}`;
}

function createChatWindowLabel(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `chat-window-${Date.now().toString(36)}-${random}`;
}

export async function openChatInNewTauriWindow(
  tab: Pick<ChatTab, "characterId" | "chatId">,
  title = "RisuAI",
): Promise<boolean> {
  if (!isTauri) return false;

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const child = new WebviewWindow(createChatWindowLabel(), {
    url: buildTauriChatWindowUrl(tab, location.pathname),
    title,
    width: Math.max(720, Math.min(window.innerWidth, 1280)),
    height: Math.max(600, Math.min(window.innerHeight, 960)),
    minWidth: 300,
    minHeight: 500,
    resizable: true,
    visible: false,
    focus: false,
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
  return { ...target, sourceWindowLabel: current.label };
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

  let accepted = false;
  try {
    const { chatTabsStore, navigateToChatTab } = await import("./chatTabs.svelte");
    const tab = chatTabsStore.openTarget(
      payload.characterId,
      payload.chatId,
      groupId ?? chatTabsStore.focusedGroupId,
    );
    accepted = await navigateToChatTab(tab.id);
  } catch (error) {
    console.error("[TauriChatWindows] Failed to accept detached chat drop", error);
  }

  if (accepted) {
    await current.emitTo(payload.sourceWindowLabel, CHAT_DROP_ACK_EVENT, {
      characterId: payload.characterId,
      chatId: payload.chatId,
    });
  }
  return accepted;
}

export async function watchDetachedTauriChatDropAck(
  target: TauriChatWindowTarget,
  onAccepted: () => void,
): Promise<() => void> {
  if (!isTauri || !isTauriChatWindowTarget(target)) return () => {};
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (!current.label.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return () => {};

  return current.listen<TauriChatWindowTarget>(CHAT_DROP_ACK_EVENT, (event) => {
    if (!isTauriChatWindowTarget(event.payload)) return;
    if (
      event.payload.characterId !== target.characterId ||
      event.payload.chatId !== target.chatId
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

export async function showCurrentDetachedTauriChatWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (!current.label.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return;
  await current.show();
  await current.setFocus();
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
  intervalMs = 60,
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
