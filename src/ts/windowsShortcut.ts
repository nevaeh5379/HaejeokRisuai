import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { language } from "src/lang";
import { alertError, alertNormal } from "./alert";
import { getCharImage } from "./characterImage";
import { openChatTargetInTab } from "./chatTabs.svelte";
import { isTauri, isTauriWindows } from "./platform";
import { characterStore } from "./stores/domain";
import {
  MobileGUIStack,
  PlaygroundStore,
  botMakerMode,
  settingsOpen,
} from "./stores.svelte";

export interface ChatShortcutTarget {
  characterId: string;
  chatId: string;
}

const ICO_SIZES = [16, 32, 48, 64, 256] as const;

function drawRoundedCenterCrop(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  size: number,
): void {
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  const side = Math.min(srcW, srcH);
  const sx = Math.max(0, (srcW - side) / 2);
  const sy = Math.max(0, (srcH - side) / 2);
  const radius = Math.max(2, Math.round(size * 0.18));

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(0, 0, size, size, radius);
  } else {
    ctx.rect(0, 0, size, size);
  }
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  ctx.restore();
}

async function canvasToPngArrayBuffer(
  canvas: HTMLCanvasElement,
): Promise<ArrayBuffer | null> {
  if (typeof canvas.toBlob !== "function") return null;
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) return null;
  return await blob.arrayBuffer();
}

async function buildCharacterIcoBytes(
  imageLoc: string | undefined,
): Promise<Uint8Array | null> {
  if (!imageLoc || typeof document === "undefined" || typeof Image === "undefined") {
    return null;
  }

  try {
    const src = await getCharImage(imageLoc, "plain");
    if (!src || src === "/none.webp") return null;

    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.crossOrigin = "anonymous";
      element.decoding = "async";
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error("Failed to load character avatar"));
      element.src = src;
    });

    if (!img.naturalWidth || !img.naturalHeight) return null;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    try {
      const imageBuffers: Array<{ buffer: ArrayBuffer }> = [];

      for (const size of ICO_SIZES) {
        canvas.width = size;
        canvas.height = size;
        drawRoundedCenterCrop(ctx, img, size);
        const pngBuffer = await canvasToPngArrayBuffer(canvas);
        if (pngBuffer) {
          imageBuffers.push({ buffer: pngBuffer });
        }
      }

      if (imageBuffers.length === 0) return null;

      const { encodeIco } = await import("icojs");
      const icoArrayBuffer = await encodeIco(imageBuffers);
      return new Uint8Array(icoArrayBuffer);
    } finally {
      // Release canvas backing store immediately to keep memory footprint minimal.
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch (error) {
    console.warn("[WindowsShortcut] Failed to build custom character icon:", error);
    return null;
  }
}

export async function createWindowsChatShortcut(
  characterIndex: number,
  chatIndex: number,
): Promise<boolean> {
  if (!isTauriWindows) return false;

  const character = characterStore.characters[characterIndex];
  const chat = character?.chats?.[chatIndex];
  if (!character?.chaId || !chat?.id) {
    alertError("Chat shortcut target is not ready.");
    return false;
  }

  try {
    const icoBytes = await buildCharacterIcoBytes(character.image);
    await invoke<string>("create_windows_chat_shortcut", {
      characterId: character.chaId,
      chatId: chat.id,
      botName: character.name || "Character",
      chatName: chat.name || "Chat",
      iconIcoBytes: icoBytes ? Array.from(icoBytes) : null,
    });
    alertNormal(language.desktopShortcutCreated);
    return true;
  } catch (error) {
    alertError(String(error));
    return false;
  }
}

export async function openChatFromShortcutTarget(
  target: ChatShortcutTarget | null | undefined,
): Promise<boolean> {
  if (!target?.characterId || !target?.chatId) return false;

  const characterIndex = characterStore.characters.findIndex(
    (c) => c?.chaId === target.characterId,
  );
  if (characterIndex < 0) return false;

  let character = characterStore.characters[characterIndex];
  if (character?.detailsLoaded === false && character.chaId) {
    try {
      await characterStore.ensureCharacterDetails(character.chaId);
    } catch (error) {
      console.error(
        "[WindowsShortcut] Failed to hydrate character details:",
        error,
      );
      return false;
    }
    character = characterStore.characters[characterIndex];
  }

  const chatIndex =
    character?.chats?.findIndex((chat) => chat?.id === target.chatId) ?? -1;
  if (chatIndex < 0) return false;

  settingsOpen.set(false);
  PlaygroundStore.set(0);
  botMakerMode.set(false);
  MobileGUIStack.set(1);

  const opened = await openChatTargetInTab(target.characterId, target.chatId);
  if (opened && isTauri) {
    const { publishCurrentTauriChatWorkspaceState } = await import(
      "./tauriChatWindows"
    );
    await publishCurrentTauriChatWorkspaceState();
  }
  return opened;
}

let shortcutListenerInitialized = false;

export async function initializeWindowsChatShortcutRuntime(): Promise<void> {
  if (!isTauri) return;

  if (!shortcutListenerInitialized) {
    shortcutListenerInitialized = true;
    await listen<ChatShortcutTarget>("tauri-open-chat", async (event) => {
      void invoke("take_pending_chat_shortcut").catch(() => undefined);
      await openChatFromShortcutTarget(event.payload);
    });
  }

  try {
    const pendingTarget = await invoke<ChatShortcutTarget | null>(
      "take_pending_chat_shortcut",
    );
    if (pendingTarget) {
      await openChatFromShortcutTarget(pendingTarget);
    }
  } catch (error) {
    console.warn("[WindowsShortcut] Failed to check pending chat shortcut:", error);
  }
}
