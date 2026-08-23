/**
 * Utility for mapping file extensions and paths to MIME types.
 */

const MIME_MAP: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  avif: "image/avif",
  apng: "image/apng",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",

  // Videos
  webm: "video/webm",
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  m4v: "video/x-m4v",
  m4p: "video/mp4",
  ogv: "video/ogg",

  // Audios
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  aac: "audio/aac",
  m4a: "audio/mp4",
  weba: "audio/webm",

  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",

  // Documents & Data
  json: "application/json",
  txt: "text/plain",
  css: "text/css",
  bin: "application/octet-stream",
};

/**
 * Returns the MIME type corresponding to a given filename, path, or extension.
 * Defaults to 'application/octet-stream' if unknown.
 */
export function getMimeType(pathOrExt: string): string {
  if (!pathOrExt) return "application/octet-stream";
  // Remove query params or hash if present
  const clean = pathOrExt.split("?")[0].split("#")[0];
  const ext = clean.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] || "application/octet-stream";
}

/**
 * Extracts file extension from a path, filename, or URL.
 */
export function getFileExtension(pathOrUrl: string): string {
  if (!pathOrUrl) return "";
  const clean = pathOrUrl.split("?")[0].split("#")[0];
  const parts = clean.split(".");
  return parts.length > 1 ? (parts.pop()?.toLowerCase() ?? "") : "";
}
