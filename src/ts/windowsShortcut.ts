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

const ICO_BMP_SIZES = [16, 32, 48, 64] as const;
const ICO_PNG_SIZE = 256;

function encodeRgbaToBmpDib(
  rgba: Uint8ClampedArray,
  size: number,
): Uint8Array {
  const xorSize = size * size * 4;
  const andRowBytes = ((size + 31) >> 5) << 2;
  const andSize = andRowBytes * size;
  const totalSize = 40 + xorSize + andSize;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  // BITMAPINFOHEADER (40 bytes)
  view.setUint32(0, 40, true); // biSize
  view.setInt32(4, size, true); // biWidth
  view.setInt32(8, size * 2, true); // biHeight (XOR + AND combined height)
  view.setUint16(12, 1, true); // biPlanes
  view.setUint16(14, 32, true); // biBitCount (32-bit BGRA)
  view.setUint32(16, 0, true); // biCompression (BI_RGB)
  view.setUint32(20, xorSize + andSize, true); // biSizeImage

  // Bottom-up BGRA pixels + 1-bit AND mask
  const andOffset = 40 + xorSize;
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = 40 + y * size * 4;
    const andRowStart = andOffset + y * andRowBytes;

    for (let x = 0; x < size; x++) {
      const srcIdx = srcRow + x * 4;
      const dstIdx = dstRow + x * 4;
      const r = rgba[srcIdx];
      const g = rgba[srcIdx + 1];
      const b = rgba[srcIdx + 2];
      const a = rgba[srcIdx + 3];

      out[dstIdx] = b;
      out[dstIdx + 1] = g;
      out[dstIdx + 2] = r;
      out[dstIdx + 3] = a;

      if (a === 0) {
        out[andRowStart + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return out;
}

export function packIcoFrames(
  frames: Array<{ size: number; data: Uint8Array }>,
): Uint8Array {
  const count = frames.length;
  const headerSize = 6 + count * 16;
  let totalSize = headerSize;
  for (const frame of frames) {
    totalSize += frame.data.byteLength;
  }

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  // ICONDIR header
  view.setUint16(0, 0, true); // Reserved
  view.setUint16(2, 1, true); // Type: 1 = ICO
  view.setUint16(4, count, true); // Image count

  let dataOffset = headerSize;
  for (let i = 0; i < count; i++) {
    const { size, data } = frames[i];
    const entryOffset = 6 + i * 16;
    out[entryOffset] = size >= 256 ? 0 : size; // Width (0 means 256)
    out[entryOffset + 1] = size >= 256 ? 0 : size; // Height (0 means 256)
    out[entryOffset + 2] = 0; // Color palette
    out[entryOffset + 3] = 0; // Reserved
    view.setUint16(entryOffset + 4, 1, true); // Color planes
    view.setUint16(entryOffset + 6, 32, true); // Bits per pixel
    view.setUint32(entryOffset + 8, data.byteLength, true); // Image byte size
    view.setUint32(entryOffset + 12, dataOffset, true); // Offset in file

    out.set(data, dataOffset);
    dataOffset += data.byteLength;
  }

  return out;
}

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

async function canvasToPngBytes(
  canvas: HTMLCanvasElement,
): Promise<Uint8Array | null> {
  if (typeof canvas.toBlob !== "function") return null;
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
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
      const frames: Array<{ size: number; data: Uint8Array }> = [];

      for (const size of ICO_BMP_SIZES) {
        canvas.width = size;
        canvas.height = size;
        drawRoundedCenterCrop(ctx, img, size);
        const rgba = ctx.getImageData(0, 0, size, size).data;
        frames.push({
          size,
          data: encodeRgbaToBmpDib(rgba, size),
        });
      }

      canvas.width = ICO_PNG_SIZE;
      canvas.height = ICO_PNG_SIZE;
      drawRoundedCenterCrop(ctx, img, ICO_PNG_SIZE);
      const pngBytes = await canvasToPngBytes(canvas);
      if (pngBytes && pngBytes.byteLength > 0) {
        frames.push({
          size: ICO_PNG_SIZE,
          data: pngBytes,
        });
      } else {
        const rgba = ctx.getImageData(0, 0, ICO_PNG_SIZE, ICO_PNG_SIZE).data;
        frames.push({
          size: ICO_PNG_SIZE,
          data: encodeRgbaToBmpDib(rgba, ICO_PNG_SIZE),
        });
      }

      return packIcoFrames(frames);
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
