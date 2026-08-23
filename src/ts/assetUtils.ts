import { saveAsset } from "./globalApi.svelte";

export type AssetCategory = "all" | "image" | "audio" | "video" | "font" | "other";

export const IMAGE_EXTENSIONS = new Set([
  "png", "webp", "jpeg", "jpg", "gif", "avif", "svg", "bmp", "ico", "tiff", "apng"
]);

export const AUDIO_EXTENSIONS = new Set([
  "mp3", "wav", "ogg", "flac", "aac", "m4a", "opus", "weba"
]);

export const VIDEO_EXTENSIONS = new Set([
  "mp4", "webm", "mkv", "mov", "avi", "m4v", "ogv"
]);

export const FONT_EXTENSIONS = new Set([
  "ttf", "otf", "woff", "woff2", "eot"
]);

export const SUPPORTED_ASSET_EXTENSIONS = [
  "png", "webp", "mp4", "mp3", "gif", "jpeg", "jpg", "ttf", "otf", "css",
  "webm", "woff", "woff2", "svg", "avif", "wav", "ogg", "flac", "aac",
  "m4a", "mkv", "mov", "avi", "txt", "json"
];

/**
 * Returns the asset category based on its file extension.
 */
export function getAssetCategory(extension: string): AssetCategory {
  const ext = (extension || "").toLowerCase().replace(/^\./, "").trim();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (FONT_EXTENSIONS.has(ext)) return "font";
  return "other";
}

/**
 * Returns default macro tag for an asset.
 */
export function getDefaultMacroTag(extension: string, name: string): string {
  const category = getAssetCategory(extension);
  const trimmedName = name.trim();
  switch (category) {
    case "image":
      return `{{img::${trimmedName}}}`;
    case "audio":
      return `{{audio::${trimmedName}}}`;
    case "video":
      return `{{video::${trimmedName}}}`;
    case "font":
      return `{{font::${trimmedName}}}`;
    default:
      return `{{raw::${trimmedName}}}`;
  }
}

export interface MacroFormatOption {
  label: string;
  tag: string;
  description: string;
}

/**
 * Returns multiple macro format options for a given asset.
 */
export function getAvailableMacroFormats(extension: string, name: string): MacroFormatOption[] {
  const category = getAssetCategory(extension);
  const trimmedName = name.trim();
  const options: MacroFormatOption[] = [];

  switch (category) {
    case "image":
      options.push(
        { label: "{{img::...}}", tag: `{{img::${trimmedName}}}`, description: "Standard Image Display" },
        { label: "{{bg::...}}", tag: `{{bg::${trimmedName}}}`, description: "Background Image" },
        { label: "{{raw::...}}", tag: `{{raw::${trimmedName}}}`, description: "Raw Resolved Image URL" },
        { label: "HTML <img>", tag: `<img src="{{raw::${trimmedName}}}" alt="${trimmedName}" />`, description: "Custom HTML Image Tag" },
        { label: "CSS url()", tag: `background-image: url("{{raw::${trimmedName}}}");`, description: "CSS Background Property" }
      );
      break;
    case "audio":
      options.push(
        { label: "{{audio::...}}", tag: `{{audio::${trimmedName}}}`, description: "Audio Player" },
        { label: "{{sound::...}}", tag: `{{sound::${trimmedName}}}`, description: "Sound Effect" },
        { label: "{{music::...}}", tag: `{{music::${trimmedName}}}`, description: "Background Music" },
        { label: "{{raw::...}}", tag: `{{raw::${trimmedName}}}`, description: "Raw Resolved Audio URL" }
      );
      break;
    case "video":
      options.push(
        { label: "{{video::...}}", tag: `{{video::${trimmedName}}}`, description: "Standard Video Player" },
        { label: "{{raw::...}}", tag: `{{raw::${trimmedName}}}`, description: "Raw Resolved Video URL" },
        { label: "HTML <video>", tag: `<video src="{{raw::${trimmedName}}}" controls class="w-full rounded-md"></video>`, description: "Custom HTML Video Player" }
      );
      break;
    case "font":
      options.push(
        { label: "{{font::...}}", tag: `{{font::${trimmedName}}}`, description: "Custom Font Declaration" },
        { label: "{{raw::...}}", tag: `{{raw::${trimmedName}}}`, description: "Raw Font File URL" }
      );
      break;
    default:
      options.push(
        { label: "{{raw::...}}", tag: `{{raw::${trimmedName}}}`, description: "Raw File URL" },
        { label: "{{path::...}}", tag: `{{path::${trimmedName}}}`, description: "Resolved File Path" }
      );
      break;
  }

  return options;
}

/**
 * Copies a string to clipboard with browser fallback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fallback
  }

  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand("copy");
    textArea.remove();
    return successful;
  } catch {
    return false;
  }
}

/**
 * Generates a unique asset name if a collision exists.
 */
export function generateUniqueAssetName(desiredName: string, existingNames: Set<string>): string {
  let name = desiredName.trim();
  if (!existingNames.has(name)) {
    return name;
  }

  const dotIndex = name.lastIndexOf(".");
  const baseName = dotIndex !== -1 ? name.substring(0, dotIndex) : name;
  const ext = dotIndex !== -1 ? name.substring(dotIndex) : "";

  let counter = 1;
  while (existingNames.has(`${baseName}_${counter}${ext}`)) {
    counter++;
  }
  return `${baseName}_${counter}${ext}`;
}

export interface RawFilePayload {
  name: string;
  data: Uint8Array;
}

/**
 * Processes file uploads, saving them as binary assets and appending to additionalAssets array.
 */
export async function processAssetUploads(
  files: (File | RawFilePayload)[],
  currentAssets: [string, string, string][] = []
): Promise<[string, string, string][]> {
  const result: [string, string, string][] = [...currentAssets];
  const existingNames = new Set(result.map((a) => a[0]));

  for (const file of files) {
    let name = file.name;
    let data: Uint8Array;

    if (file instanceof File) {
      data = new Uint8Array(await file.arrayBuffer());
    } else {
      data = file.data;
    }

    const dotIndex = name.lastIndexOf(".");
    const ext = dotIndex !== -1 ? name.substring(dotIndex + 1).toLowerCase() : "png";
    const uniqueName = generateUniqueAssetName(name, existingNames);
    existingNames.add(uniqueName);

    const assetId = await saveAsset(data, "", ext);
    result.push([uniqueName, assetId, ext]);
  }

  return result;
}
