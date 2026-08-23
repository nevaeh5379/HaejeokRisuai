/** Canvas-based single-image format conversion (capture post-processing). */

export async function loadImageBlobToCanvas(
  blob: Blob,
  options: { alpha?: boolean } = {},
): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { alpha: options.alpha !== false });
  if (!ctx) throw new Error("Failed to get 2D rendering context");
  if (options.alpha === false) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  return canvas;
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas toBlob failed"));
      },
      type,
      quality,
    );
  });
}

/** Converts any image blob to another MIME format via canvas. */
export async function convertViaCanvas(
  blob: Blob,
  mimeType: string,
  quality = 0.95,
): Promise<Blob> {
  const canvas = await loadImageBlobToCanvas(blob, {
    alpha: !mimeType.includes("jpeg"),
  });
  return canvasToBlob(canvas, mimeType, quality);
}
