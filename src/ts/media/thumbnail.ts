import { Buffer } from "buffer";

/**
 * Generates a downscaled thumbnail (default max 128px) in WebP format on the client side.
 * Uses createImageBitmap when available for hardware-accelerated decode & resize off the main thread.
 *
 * @param imageData - Raw binary data of the original image
 * @param maxSize - Maximum width/height for the thumbnail (default: 128)
 * @returns Downscaled image buffer as Uint8Array
 */
export async function generateClientThumbnail(
  imageData: Uint8Array,
  maxSize: number = 128,
): Promise<Uint8Array> {
  if (typeof window === "undefined") {
    return imageData;
  }
  try {
    const blob = new Blob([imageData as any]);

    const drawCoverTop = (
      ctx:
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D,
      source: CanvasImageSource,
      srcW: number,
      srcH: number,
    ) => {
      // Cover-crop anchored to the top: scale so the shorter side fills maxSize,
      // center horizontally, align to the top.
      const scale = Math.max(maxSize / srcW, maxSize / srcH);
      const scaledW = Math.round(srcW * scale);
      const scaledH = Math.round(srcH * scale);
      const dx = Math.round((maxSize - scaledW) / 2);
      const dy = 0;
      ctx.drawImage(source, 0, 0, srcW, srcH, dx, dy, scaledW, scaledH);
    };

    if ("createImageBitmap" in window) {
      const bitmap = await createImageBitmap(blob);

      let canvas: HTMLCanvasElement | OffscreenCanvas;
      if (typeof OffscreenCanvas !== "undefined") {
        canvas = new OffscreenCanvas(maxSize, maxSize);
      } else {
        canvas = document.createElement("canvas");
        canvas.width = maxSize;
        canvas.height = maxSize;
      }

      const ctx = canvas.getContext("2d") as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null;
      if (!ctx) {
        bitmap.close();
        return imageData;
      }
      drawCoverTop(ctx, bitmap, bitmap.width, bitmap.height);
      bitmap.close();

      if ("convertToBlob" in canvas) {
        const outBlob = await (canvas as OffscreenCanvas).convertToBlob({
          type: "image/webp",
          quality: 0.8,
        });
        return new Uint8Array(await outBlob.arrayBuffer());
      } else {
        const dataUrl = (canvas as HTMLCanvasElement).toDataURL(
          "image/webp",
          0.8,
        );
        const b64 = dataUrl.split(",")[1];
        return Buffer.from(b64, "base64");
      }
    } else {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          const canvas = document.createElement("canvas");
          canvas.width = maxSize;
          canvas.height = maxSize;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            drawCoverTop(ctx, img, img.width, img.height);
            const dataUrl = canvas.toDataURL("image/webp", 0.8);
            const b64 = dataUrl.split(",")[1];
            resolve(Buffer.from(b64, "base64"));
          } else {
            resolve(imageData);
          }
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          resolve(imageData);
        };
        img.src = url;
      });
    }
  } catch (e) {
    console.warn(
      "[Thumbnail] Client thumbnail generation fallback to original:",
      e,
    );
    return imageData;
  }
}
