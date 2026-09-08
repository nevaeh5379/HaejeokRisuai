import type { ChatTab } from "./chatTabs.svelte";
import { isTauri } from "./platform";

const CHAT_WINDOW_KIND_PARAM = "risuWindow";
const CHARACTER_ID_PARAM = "characterId";
const CHAT_ID_PARAM = "chatId";
const CHAT_WINDOW_KIND = "chat";
const CHAT_DOCK_REQUEST_EVENT = "risu://dock-chat-request";
const CHAT_DOCK_ACK_EVENT = "risu://dock-chat-ack";
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

interface TauriChatDockRequest extends TauriChatWindowTarget {
  requestId: string;
  sourceWindowLabel: string;
}

interface TauriChatDockAck {
  requestId: string;
  accepted: boolean;
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

function isTauriChatDockRequest(value: unknown): value is TauriChatDockRequest {
  if (!isTauriChatWindowTarget(value)) return false;
  const request = value as Partial<TauriChatDockRequest>;
  return (
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    typeof request.sourceWindowLabel === "string" &&
    request.sourceWindowLabel.startsWith(CHAT_WINDOW_LABEL_PREFIX)
  );
}

function isTauriChatDockAck(value: unknown): value is TauriChatDockAck {
  if (!value || typeof value !== "object") return false;
  const ack = value as Partial<TauriChatDockAck>;
  return (
    typeof ack.requestId === "string" &&
    ack.requestId.length > 0 &&
    typeof ack.accepted === "boolean"
  );
}

export async function startTauriChatDockListener(): Promise<void> {
  if (!isTauri || dockListenerStarted) return;

  const { getCurrentWebviewWindow } =
    await import("@tauri-apps/api/webviewWindow");
  const current = getCurrentWebviewWindow();
  if (current.label !== MAIN_WINDOW_LABEL) return;

  await current.listen<TauriChatDockRequest>(
    CHAT_DOCK_REQUEST_EVENT,
    (event) => {
      if (!isTauriChatDockRequest(event.payload)) return;
      const request = event.payload;
      void (async () => {
        let accepted = false;
        try {
          const { openChatTargetInTab } = await import("./chatTabs.svelte");
          accepted = await openChatTargetInTab(
            request.characterId,
            request.chatId,
          );
        } catch (error) {
          console.error(
            "[TauriChatWindows] Failed to dock chat into main window",
            error,
          );
        }

        await current.emitTo(request.sourceWindowLabel, CHAT_DOCK_ACK_EVENT, {
          requestId: request.requestId,
          accepted,
        } satisfies TauriChatDockAck);
      })();
    },
  );
  dockListenerStarted = true;
}

async function requestMainWindowDock(
  current: {
    label: string;
    listen<T>(
      event: string,
      handler: (event: { payload: T }) => void,
    ): Promise<() => void>;
    emitTo(target: string, event: string, payload?: unknown): Promise<void>;
  },
  target: TauriChatWindowTarget,
): Promise<boolean> {
  const requestId =
    globalThis.crypto?.randomUUID?.() ??
    `dock-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  return new Promise<boolean>(async (resolve) => {
    let settled = false;
    const finish = (accepted: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unlisten?.();
      resolve(accepted);
    };
    let unlisten: (() => void) | undefined;
    const timeout = setTimeout(() => finish(false), 1800);

    try {
      unlisten = await current.listen<TauriChatDockAck>(
        CHAT_DOCK_ACK_EVENT,
        (event: { payload: TauriChatDockAck }) => {
          if (!isTauriChatDockAck(event.payload)) return;
          if (event.payload.requestId !== requestId) return;
          finish(event.payload.accepted);
        },
      );
      await current.emitTo(MAIN_WINDOW_LABEL, CHAT_DOCK_REQUEST_EVENT, {
        ...target,
        requestId,
        sourceWindowLabel: current.label,
      } satisfies TauriChatDockRequest);
    } catch (error) {
      console.error("[TauriChatWindows] Failed to request docking", error);
      finish(false);
    }
  });
}

export async function tryDockDetachedTauriChatWindow(
  target: TauriChatWindowTarget,
): Promise<boolean> {
  if (!isTauri || !isTauriChatWindowTarget(target)) return false;

  const [{ WebviewWindow, getCurrentWebviewWindow }, { cursorPosition }] =
    await Promise.all([
      import("@tauri-apps/api/webviewWindow"),
      import("@tauri-apps/api/window"),
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

  const accepted = await requestMainWindowDock(current, target);
  if (!accepted) return false;
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
