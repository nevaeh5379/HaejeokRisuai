import { mount, unmount } from "svelte";
import { toBlob } from "html-to-image";
import type {
  ColorPalette,
  ImageFormat,
  LogExportData,
  LogExporterSettings,
} from "./types";
import { mergeImagesVertically } from "./mediaService";
import { downloadBlob } from "./fileService";
import LogContainer from "src/lib/LogExporter/LogContainer.svelte";
import type { LogRenderProps } from "./types";

/**
 * Image export pipeline for the Log Exporter.
 *
 * Renders the themed log offscreen, captures it with html-to-image, splits
 * oversized output into vertical sections and stitches them back together
 * with ffmpeg.wasm (replacing the plugin's hand-rolled binary mergers).
 */

const BROWSER_MAX_HEIGHT = 16384;
const DEFAULT_BACKGROUND_COLOR = "#1a1b26";
const DEFAULT_MAX_IMAGE_HEIGHT = 10000;
const DEFAULT_PREVIEW_WIDTH = 900;
const MEDIA_WAIT_TIMEOUT_MS = 5000;
const DOWNLOAD_PREPARATION_DELAY_MS = 50;

export interface ExportProgressCallbacks {
  onProgressStart?: (message: string, total: number) => void;
  onProgressUpdate?: (update: { current?: number; message?: string }) => void;
  onProgressEnd?: () => void;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeFilename(name: string): string {
  return name.replace(/[/?%*:|"<>]/g, "-");
}

/** Reads the HTML full-scale factor (--log-scale) applied to an offscreen container. */
function getTransformScale(element: HTMLElement): number {
  const raw = element.style.getPropertyValue("--log-scale").trim();
  const value = raw ? Number(raw) : 1;
  return value > 0 ? value : 1;
}

/** Waits until every <img>/<video> inside the element finished loading. */
async function waitForMedia(
  element: HTMLElement,
  timeoutMs = MEDIA_WAIT_TIMEOUT_MS,
): Promise<void> {
  const images = Array.from(element.querySelectorAll("img"));
  const videos = Array.from(element.querySelectorAll("video"));
  const promises: Promise<void>[] = [
    ...images.map((img) => {
      if (img.complete) return Promise.resolve();
      return new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.onerror = () => resolve();
      });
    }),
    ...videos.map((video) => {
      if (video.readyState >= 2) return Promise.resolve();
      return new Promise<void>((resolve) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => resolve();
      });
    }),
  ];
  if (promises.length === 0) return;
  await Promise.race([Promise.all(promises), delay(timeoutMs)]);
}

// ─── Offscreen rendering ─────────────────────────────────────────────────────

export interface OffscreenRender {
  element: HTMLElement;
  destroy: () => Promise<void>;
}

/**
 * Mounts LogContainer into an offscreen container and resolves once every
 * message has rendered.
 */
async function renderOffscreen(
  data: LogExportData,
  settings: LogExporterSettings,
  colorPalette: ColorPalette,
  extra: Partial<LogRenderProps> = {},
): Promise<OffscreenRender> {
  const container = document.createElement("div");
  container.style.position = "fixed";
  container.style.left = "-10000px";
  container.style.top = "0";
  container.style.zIndex = "-1";
  container.style.width = `${settings.previewWidth || DEFAULT_PREVIEW_WIDTH}px`;
  document.body.appendChild(container);

  return await new Promise<OffscreenRender>((resolve, reject) => {
    let done = false;
    const props: LogRenderProps = {
      data,
      settings,
      color: colorPalette,
      isForImageExport: true,
      isForExport: true,
      containerWidth: settings.previewWidth || DEFAULT_PREVIEW_WIDTH,
      fontSize: settings.previewFontSize || 16,
      onReady: () => {
        if (done) return;
        done = true;
        // Defer so Svelte flushes remaining DOM work
        requestAnimationFrame(() => {
          resolve({
            element: (container.firstElementChild as HTMLElement) ?? container,
            destroy: async () => {
              await unmount(app);
              container.remove();
            },
          });
        });
      },
      ...extra,
    };
    const app = mount(LogContainer, {
      target: container,
      props,
    });
    setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error("Log rendering timed out"));
      }
    }, 30000);
  }).then(async (result) => {
    // give fonts/media one paint before returning
    await delay(50);
    return result;
  });
}

// ─── Capture ─────────────────────────────────────────────────────────────────

async function captureElementToBlob(
  element: HTMLElement,
  format: ImageFormat,
  bgColor: string,
  pixelRatio: number,
): Promise<Blob> {
  const scale = getTransformScale(element);
  const options = {
    pixelRatio,
    width: Math.round(element.offsetWidth * scale),
    height: Math.round(element.offsetHeight * scale),
    backgroundColor: format === "jpeg" ? bgColor : undefined,
  };
  if (format === "webp") {
    // html-to-image cannot encode WebP directly; produce PNG then convert
    const pngBlob = await toBlob(element, { ...options, type: "image/png" });
    const { convertViaCanvas } = await import("./canvasConvert");
    return convertViaCanvas(pngBlob, "image/webp");
  }
  const mime = format === "jpeg" ? "image/jpeg" : "image/png";
  const blob = await toBlob(element, {
    ...options,
    type: mime,
    quality: format === "jpeg" ? 1 : undefined,
  });
  if (!blob) throw new Error(`Failed to capture element (${format})`);
  return blob;
}

// ─── Section split + stitch ──────────────────────────────────────────────────

async function forEachSection(
  element: HTMLElement,
  maxHeight: number,
  resolution: number,
  format: ImageFormat,
  bgColor: string,
  onSectionBlob: (blob: Blob) => Promise<void>,
  onProgressUpdate?: (update: { message?: string }) => void,
): Promise<void> {
  const scale = getTransformScale(element);
  const totalHeight = element.offsetHeight * scale;
  const totalWidth = element.offsetWidth * scale;
  const numSections = Math.ceil(totalHeight / maxHeight);

  onProgressUpdate?.({
    message: `큰 이미지 분할 캡처 중 (${numSections}개 섹션)...`,
  });

  for (let i = 0; i < numSections; i++) {
    const startY = i * maxHeight;
    const sectionHeight = Math.min(maxHeight, totalHeight - startY);

    const wrapper = createSectionWrapper(
      element,
      startY,
      sectionHeight,
      totalWidth,
      bgColor,
    );
    document.body.appendChild(wrapper);
    try {
      onProgressUpdate?.({
        message: `[섹션 ${i + 1}/${numSections}] 캡처 중...`,
      });
      // Sections captured as PNG when stitching follows (ffmpeg handles conversion)
      const blob = await captureElementToBlob(
        wrapper,
        format === "webp" ? "png" : format,
        bgColor,
        resolution,
      );
      await onSectionBlob(blob);
    } finally {
      wrapper.remove();
    }
  }
}

function createSectionWrapper(
  element: HTMLElement,
  startY: number,
  sectionHeight: number,
  totalWidth: number,
  bgColor: string,
): HTMLElement {
  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${totalWidth}px`,
    height: `${sectionHeight}px`,
    overflow: "hidden",
    backgroundColor: bgColor,
  });
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.position = "absolute";
  clone.style.top = `${-startY}px`;
  clone.style.left = "0";
  wrapper.appendChild(clone);
  return wrapper;
}

// ─── Resolution handling ─────────────────────────────────────────────────────

function computeAutoResolution(height: number): number {
  if (height > 0 && height * 4 <= BROWSER_MAX_HEIGHT) return 4;
  if (height > 0 && height * 3 <= BROWSER_MAX_HEIGHT) return 3;
  if (height > 0 && height * 2 <= BROWSER_MAX_HEIGHT) return 2;
  return 1;
}

// ─── Main entry ──────────────────────────────────────────────────────────────

export interface SaveAsImageOptions extends ExportProgressCallbacks {
  backgroundColor?: string;
}

/**
 * Renders the log offscreen and saves it as image file(s).
 */
export async function saveAsImage(
  data: LogExportData,
  settings: LogExporterSettings,
  colorPalette: ColorPalette,
  format: ImageFormat,
  options: SaveAsImageOptions = {},
): Promise<void> {
  const { onProgressStart, onProgressUpdate, onProgressEnd, backgroundColor } =
    options;
  const bgColor = backgroundColor || DEFAULT_BACKGROUND_COLOR;
  const safeCharName = sanitizeFilename(data.charInfo.name);
  const safeChatName = sanitizeFilename(data.charInfo.chatName);
  const baseFilename = `Risu_Log_${safeCharName}_${safeChatName}`;

  try {
    onProgressStart?.("이미지 생성 중...", 1);
    const render = await renderOffscreen(data, settings, colorPalette);
    try {
      const element = render.element;
      await inlineRemainingImages(element);
      await waitForMedia(element);

      const scale = getTransformScale(element);
      const renderedHeight = element.offsetHeight * scale;
      const renderedWidth = element.offsetWidth * scale;

      const resolutionSetting = settings.imageResolution;
      let resolution =
        resolutionSetting === "auto"
          ? computeAutoResolution(renderedHeight)
          : resolutionSetting;
      if (renderedHeight * resolution > BROWSER_MAX_HEIGHT) {
        resolution = Math.max(
          1,
          Math.floor(BROWSER_MAX_HEIGHT / renderedHeight),
        );
        onProgressUpdate?.({
          message: `[경고] 해상도가 높아 ${resolution}x로 자동 조정됨.`,
        });
      }

      const finalMaxHeight = Math.min(
        settings.maxImageHeight ?? DEFAULT_MAX_IMAGE_HEIGHT,
        Math.floor(BROWSER_MAX_HEIGHT / resolution),
      );

      let blob: Blob | null = null;
      const isTooTall = renderedHeight > finalMaxHeight;

      if (isTooTall && settings.splitImage === "chunk") {
        const blobs: Blob[] = [];
        await forEachSection(
          element,
          finalMaxHeight,
          resolution,
          format,
          bgColor,
          async (b) => {
            blobs.push(b);
          },
          onProgressUpdate,
        );
        blob = await mergeImagesVertically(blobs, format, onProgressUpdate);
      } else if (isTooTall && settings.splitImage === "message") {
        let sectionIndex = 0;
        const numSections = Math.ceil(element.offsetHeight / finalMaxHeight);
        await forEachSection(
          element,
          finalMaxHeight,
          resolution,
          format,
          bgColor,
          async (b) => {
            onProgressUpdate?.({
              message: `[섹션 ${sectionIndex + 1}/${numSections}] 파일 저장 중...`,
            });
            await downloadBlob(
              b,
              `${baseFilename}_part${++sectionIndex}.${format}`,
            );
            await delay(DOWNLOAD_PREPARATION_DELAY_MS);
          },
          onProgressUpdate,
        );
        return;
      } else {
        onProgressUpdate?.({ message: "이미지 데이터 생성 중..." });
        blob = await captureElementToBlob(element, format, bgColor, resolution);
      }

      if (!blob) throw new Error("Failed to generate image blob.");
      onProgressUpdate?.({ message: "파일 다운로드 중..." });
      await delay(DOWNLOAD_PREPARATION_DELAY_MS);
      await downloadBlob(blob, `${baseFilename}.${format}`);
    } finally {
      await render.destroy();
    }
  } catch (e) {
    console.error("[logexporter] saveAsImage failed:", e);
    throw e;
  } finally {
    onProgressEnd?.();
  }
}

/** Converts remaining remote images inside an element to data URLs pre-capture. */
async function inlineRemainingImages(element: HTMLElement): Promise<void> {
  const { imageUrlToDataUrl, extractBackgroundImageUrl } =
    await import("./messageRenderer");
  const images = Array.from(element.querySelectorAll<HTMLImageElement>("img"));
  const bgElements = Array.from(
    element.querySelectorAll<HTMLElement>('[style*="background-image"]'),
  );

  await Promise.all([
    ...images.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (src.startsWith("data:")) return;
      if (!src) {
        img.remove();
        return;
      }
      img.src = await imageUrlToDataUrl(src);
    }),
    ...bgElements.map(async (el) => {
      const styleAttr = el.getAttribute("style") ?? "";
      const bgUrl = extractBackgroundImageUrl(styleAttr);
      if (!bgUrl || bgUrl.startsWith("data:")) return;
      const dataUrl = await imageUrlToDataUrl(bgUrl);
      el.setAttribute("style", styleAttr.replace(bgUrl, dataUrl));
    }),
  ]);
}
