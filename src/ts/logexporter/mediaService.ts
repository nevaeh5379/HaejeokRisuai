import type { FFmpeg } from "@ffmpeg/ffmpeg";
import type { ImageFormat } from "./types";

/**
 * ffmpeg.wasm media service.
 *
 * Replaces the plugin's hand-written binary codecs (png.ts / jpeg.ts /
 * webp.ts / webmConverter.ts): vertical image stitching, format conversion
 * and WebM → animated WebP conversion are delegated to a real ffmpeg build,
 * loaded on demand from CDN so it never touches the initial bundle.
 *
 * Note: the core MUST use the ESM build (dist/esm). Every web worker in this
 * app is compiled as an ES module (vite worker.format='es') and
 * @ffmpeg/ffmpeg spawns its worker as a module worker, where
 * `importScripts()` is unavailable; the worker therefore imports the core
 * with a dynamic `import()`. The UMD core has no default export, so loading
 * it would fail with `ERROR_IMPORT_FAILURE` ("failed to import
 * ffmpeg-core.js"). The ESM core exports the expected default.
 */
const CORE_VERSION = "0.12.10";
// ESM build required — see the module-worker note above.
const CORE_BASE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`;

/** How long to wait (ms) for ffmpeg.wasm to be ready before giving up. */
const FFMPEG_LOAD_TIMEOUT_MS = 45000;

export const DEFAULT_WEBM_FPS = 10;
export const DEFAULT_WEBM_MAX_WIDTH = 500;
export const DEFAULT_WEBM_QUALITY = 80;

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

export interface MediaProgress {
  progress: number;
  time: number;
}

/** Lazily loads (and caches) the ffmpeg.wasm core. */
export async function getFFmpeg(
  onLog?: (message: string) => void,
): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (!loadPromise) {
    loadPromise = (async () => {
      // Dynamic imports keep @ffmpeg/ffmpeg out of the initial bundle
      const { FFmpeg: FFmpegClass } = await import("@ffmpeg/ffmpeg");
      const { toBlobURL } = await import("@ffmpeg/util");
      const ffmpeg = new FFmpegClass();
      if (onLog) {
        ffmpeg.on("log", ({ message }) => onLog(message));
      }
      await ffmpeg.load({
        coreURL: await toBlobURL(
          `${CORE_BASE_URL}/ffmpeg-core.js`,
          "text/javascript",
        ),
        wasmURL: await toBlobURL(
          `${CORE_BASE_URL}/ffmpeg-core.wasm`,
          "application/wasm",
        ),
      });
      ffmpegInstance = ffmpeg;
      return ffmpeg;
    })().catch((e) => {
      loadPromise = null;
      throw e;
    });
  }
  // A stalled CDN fetch would otherwise leave callers (and the progress UI)
  // hanging forever; race it with a timeout and let callers degrade.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedLoad = Promise.race([
    loadPromise,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              `ffmpeg.wasm 로드 시간 초과 (${FFMPEG_LOAD_TIMEOUT_MS / 1000}초). 네트워크 상태를 확인해주세요.`,
            ),
          ),
        FFMPEG_LOAD_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  return timedLoad;
}

export function isFFmpegLoaded(): boolean {
  return ffmpegInstance !== null;
}

/** Converts a Blob into the data format ffmpeg.writeFile expects. */
async function toFFmpegData(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

// ─── Vertical image stitching ────────────────────────────────────────────────

function extFor(format: ImageFormat): string {
  switch (format) {
    case "png":
      return "png";
    case "jpeg":
      return "jpg";
    case "webp":
      return "webp";
  }
}

function mimeFor(format: ImageFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
  }
}

/**
 * Stitches image blobs vertically into one file using ffmpeg's vstack filter.
 *
 * Falls back to canvas stitching when ffmpeg is unavailable (offline CDN,
 * worker restrictions); see mergeBlobsViaCanvas for its limits.
 */
export async function mergeImagesVertically(
  blobs: Blob[],
  format: ImageFormat = "png",
  onProgressUpdate?: (update: { message?: string }) => void,
): Promise<Blob> {
  if (blobs.length === 0) throw new Error("No images to merge");
  if (blobs.length === 1) return blobs[0];
  try {
    return await mergeBlobsWithFFmpeg(blobs, format, onProgressUpdate);
  } catch (e) {
    console.warn(
      "[logexporter] ffmpeg merge failed, falling back to canvas stitching:",
      e,
    );
  }
  return await mergeBlobsViaCanvas(blobs, format, onProgressUpdate);
}

async function mergeBlobsWithFFmpeg(
  blobs: Blob[],
  format: ImageFormat = "png",
  onProgressUpdate?: (update: { message?: string }) => void,
): Promise<Blob> {
  onProgressUpdate?.({ message: "ffmpeg 로드 중..." });
  const ffmpeg = await getFFmpeg();

  const ext = extFor(format);
  const inputNames: string[] = [];

  // Probe natural widths via ImageBitmap to normalize scale
  let targetWidth = Infinity;
  const bitmaps: ImageBitmap[] = [];
  try {
    for (const blob of blobs) {
      const bmp = await createImageBitmap(blob);
      bitmaps.push(bmp);
      targetWidth = Math.min(targetWidth, bmp.width);
    }
  } catch {
    targetWidth = Infinity;
  } finally {
    for (const bmp of bitmaps) bmp.close?.();
  }

  for (let i = 0; i < blobs.length; i++) {
    const name = `in${i}.${ext}`;
    await ffmpeg.writeFile(name, await toFFmpegData(blobs[i]));
    inputNames.push(name);
  }

  try {
    // Build filter_complex: scale all inputs to a common width, then vstack
    const scaleAll = targetWidth !== Infinity;
    const parts: string[] = [];
    if (scaleAll) {
      inputNames.forEach((_, i) =>
        parts.push(`[${i}:v]scale=${targetWidth}:-1:flags=lanczos[p${i}]`),
      );
    }
    const stackInputs = inputNames
      .map((_, i) => `[${scaleAll ? "p" + i : i + ":v"}]`)
      .join("");
    parts.push(`${stackInputs}vstack=inputs=${inputNames.length}[out]`);
    const filterComplex = parts.join(";");

    onProgressUpdate?.({ message: `${blobs.length}개 이미지 병합 중...` });
    await ffmpeg.exec([
      ...inputNames.flatMap((name) => ["-i", name]),
      "-filter_complex",
      filterComplex,
      "-frames:v",
      "1",
      ...(format === "jpeg" ? ["-q:v", "2"] : []),
      ...(format === "webp" ? ["-lossless", "0", "-q:v", "95"] : []),
      "-c:v",
      format === "webp" ? "libwebp" : format === "jpeg" ? "mjpeg" : "png",
      `out.${ext}`,
    ]);

    const data = await ffmpeg.readFile(`out.${ext}`);
    return new Blob([data as unknown as BlobPart], { type: mimeFor(format) });
  } finally {
    for (const name of inputNames) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* ignore */
      }
    }
    try {
      await ffmpeg.deleteFile(`out.${ext}`);
    } catch {
      /* ignore */
    }
  }
}

// ─── Canvas stitching fallback ──────────────────────────────────────────

/** Conservative browser canvas caps shared by Chromium/Firefox/Safari. */
const CANVAS_MAX_DIMENSION = 16384;
const CANVAS_MAX_AREA = CANVAS_MAX_DIMENSION * CANVAS_MAX_DIMENSION;

/**
 * Canvas-based vertical stitch used when ffmpeg.wasm cannot load (offline
 * CDN, module-worker restrictions, memory pressure). Sections are produced
 * from the same element, so widths match in practice; mismatched widths are
 * drawn scaled to the narrowest width. Unlike the ffmpeg path it is bounded
 * by browser canvas caps — exceeding them throws an actionable error.
 */
async function mergeBlobsViaCanvas(
  blobs: Blob[],
  format: ImageFormat,
  onProgressUpdate?: (update: { message?: string }) => void,
): Promise<Blob> {
  const mime = mimeFor(format);

  // Probe pass: record natural dimensions while holding only one bitmap at a
  // time, so peak memory stays at the largest section instead of the sum.
  const dims: { w: number; h: number }[] = [];
  let targetWidth = Infinity;
  for (const blob of blobs) {
    const bmp = await createImageBitmap(blob);
    dims.push({ w: bmp.width, h: bmp.height });
    if (bmp.width < targetWidth) targetWidth = bmp.width;
    bmp.close?.();
  }
  if (!Number.isFinite(targetWidth) || targetWidth <= 0) {
    throw new Error("Failed to decode images for canvas merge");
  }
  const scaledHeights = dims.map(({ w, h }) =>
    Math.round((h * targetWidth) / w),
  );
  const totalHeight = scaledHeights.reduce((a, b) => a + b, 0);
  if (
    totalHeight > CANVAS_MAX_DIMENSION ||
    targetWidth * totalHeight > CANVAS_MAX_AREA
  ) {
    throw new Error(
      `병합 이미지(${targetWidth}x${totalHeight})가 브라우저 캔버스 한도를 초과했습니다. 해상도를 낮추거나 분할 높이를 늘려주세요.`,
    );
  }

  onProgressUpdate?.({
    message: `[대체 캔버스 방식] ${blobs.length}개 이미지 병합 중...`,
  });
  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2D rendering context");
  if (format === "jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetWidth, totalHeight);
  }

  // Draw pass: decode and draw one section at a time.
  let y = 0;
  for (let i = 0; i < blobs.length; i++) {
    const bmp = await createImageBitmap(blobs[i]);
    try {
      ctx.drawImage(bmp, 0, y, targetWidth, scaledHeights[i]);
      y += scaledHeights[i];
    } finally {
      bmp.close?.();
    }
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(
      resolve,
      mime,
      format === "jpeg" ? 0.95 : format === "webp" ? 0.9 : undefined,
    ),
  );
  if (!blob) {
    throw new Error(`Failed to encode merged image (${format})`);
  }
  return blob;
}

// ─── WebM → Animated WebP ────────────────────────────────────────────────────

/**
 * Converts a WebM video into a spec-compliant animated WebP image using
 * ffmpeg (`libwebp` encoder). Replaces the manual frame-extraction +
 * RIFF chunk assembly in the plugin's webmConverter.ts.
 */
export async function convertWebMToAnimatedWebp(
  videoBlob: Blob,
  options: {
    fps?: number | null;
    maxWidth?: number | null;
    quality?: number;
  } = {},
): Promise<Blob> {
  const fps = options.fps ?? DEFAULT_WEBM_FPS;
  const maxWidth = options.maxWidth ?? DEFAULT_WEBM_MAX_WIDTH;
  const quality = Math.min(
    100,
    Math.max(1, options.quality ?? DEFAULT_WEBM_QUALITY),
  );

  const ffmpeg = await getFFmpeg();
  await ffmpeg.writeFile("input.webm", await toFFmpegData(videoBlob));
  try {
    const vfParts = [`fps=${fps}`];
    if (maxWidth && maxWidth > 0) {
      vfParts.push(`scale='min(${maxWidth},iw)':-2:flags=lanczos`);
    }
    await ffmpeg.exec([
      "-i",
      "input.webm",
      "-vf",
      vfParts.join(","),
      "-c:v",
      "libwebp",
      "-lossless",
      "0",
      "-q:v",
      String(quality),
      "-loop",
      "0",
      "-an",
      "-vsync",
      "0",
      "output.webp",
    ]);
    const data = await ffmpeg.readFile("output.webp");
    return new Blob([data as unknown as BlobPart], { type: "image/webp" });
  } finally {
    try {
      await ffmpeg.deleteFile("input.webm");
    } catch {
      /* ignore */
    }
    try {
      await ffmpeg.deleteFile("output.webp");
    } catch {
      /* ignore */
    }
  }
}
