import type { ChatTab } from "./chatTabs.svelte";
import { isTauri } from "./platform";

const CHAT_WINDOW_KIND_PARAM = "risuWindow";
const CHARACTER_ID_PARAM = "characterId";
const CHAT_ID_PARAM = "chatId";
const CHAT_WINDOW_KIND = "chat";
const CHAT_DOCK_EVENT = "risu://dock-chat";
const MAIN_WINDOW_LABEL = "main";
const CHAT_WINDOW_LABEL_PREFIX = "chat-window-";
const CHAT_DOCK_HEIGHT_CSS_PX = 56;

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

export function isPointInTauriChatDockZone(
  cursor: PhysicalPoint,
  mainContentPosition: PhysicalPoint,
  mainContentSize: PhysicalArea,
  scaleFactor: number,
): boolean {
  const dockHeight = CHAT_DOCK_HEIGHT_CSS_PX * Math.max(scaleFactor, 0.1);
  return (
    cursor.x >= mainContentPosition.x &&
    cursor.x <= mainContentPosition.x + mainContentSize.width &&
    cursor.y >= mainContentPosition.y &&
    cursor.y <= mainContentPosition.y + dockHeight
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

let dockListenerStarted = false;

export async function startTauriChatDockListener(): Promise<void> {
  if (!isTauri || dockListenerStarted) return;

  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  if (getCurrentWebviewWindow().label !== MAIN_WINDOW_LABEL) return;

  const { listen } = await import("@tauri-apps/api/event");
  await listen<TauriChatWindowTarget>(CHAT_DOCK_EVENT, (event) => {
    if (!isTauriChatWindowTarget(event.payload)) return;
    void import("./chatTabs.svelte").then(({ openChatTargetInTab }) =>
      openChatTargetInTab(event.payload.characterId, event.payload.chatId),
    );
  });
  dockListenerStarted = true;
}

export async function tryDockDetachedTauriChatWindow(
  target: TauriChatWindowTarget,
): Promise<boolean> {
  if (!isTauri || !isTauriChatWindowTarget(target)) return false;

  const [
    { WebviewWindow, getCurrentWebviewWindow },
    { cursorPosition },
    { emitTo },
  ] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/event"),
  ]);

  const current = getCurrentWebviewWindow();
  if (!current.label.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return false;

  const main = await WebviewWindow.getByLabel(MAIN_WINDOW_LABEL);
  if (!main) return false;

  const [cursor, position, size, scaleFactor] = await Promise.all([
    cursorPosition(),
    main.innerPosition(),
    main.innerSize(),
    main.scaleFactor(),
  ]);
  if (!isPointInTauriChatDockZone(cursor, position, size, scaleFactor)) {
    return false;
  }

  await emitTo(MAIN_WINDOW_LABEL, CHAT_DOCK_EVENT, target);
  await current.close();
  return true;
}

export async function watchDetachedTauriChatWindowDocking(
  target: TauriChatWindowTarget,
): Promise<() => void> {
  if (!isTauri || !isTauriChatWindowTarget(target)) return () => {};

  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (!current.label.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return () => {};

  let checking = false;
  return current.onMoved(() => {
    if (checking) return;
    checking = true;
    void tryDockDetachedTauriChatWindow(target).finally(() => {
      checking = false;
    });
  });
}

export async function startDetachedTauriChatWindowDrag(): Promise<boolean> {
  if (!isTauri) return false;
  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (!current.label.startsWith(CHAT_WINDOW_LABEL_PREFIX)) return false;
  await current.startDragging();
  return true;
}
