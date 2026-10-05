import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import sharp from "sharp";
import { unzip } from "fflate";
import type { ImageGenerationRuntime } from "../../../packages/protocol/dist/imageGeneration.cjs";

type Assets = {
  read(key: string): Promise<Uint8Array>;
  write(key: string, data: Uint8Array): Promise<unknown>;
  remove(keys: string[]): Promise<unknown>;
};
const hex = (key: string) => Buffer.from(key).toString("hex");

export function createIllustrationImages(
  getAssets: () => Assets,
  recordAssets: (entries: { key: string; size: number }[]) => Promise<void>,
  sanitizeUrl: (url: string) => string | null,
) {
  const checkedFetch: typeof fetch = async (input, init) => {
    const url = sanitizeUrl(String(input));
    if (!url) throw new Error("Invalid image provider URL");
    return fetch(url, {
      ...init,
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(10 * 60 * 1000),
    });
  };
  const runtime: ImageGenerationRuntime = {
    fetchNative: checkedFetch,
    fetchJson: async (url, options) => {
      const headers = new Headers(options.headers);
      if (!headers.has("content-type"))
        headers.set("content-type", "application/json");
      const response = await checkedFetch(url, {
        method: options.method ?? (options.body ? "POST" : "GET"),
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      });
      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers),
        data: options.rawResponse
          ? new Uint8Array(await response.arrayBuffer())
          : await response.json(),
      };
    },
    readImage: async (path) => (path ? getAssets().read(hex(path)) : null),
    resizeReference: async (base64) => {
      if (!base64) return "";
      return (
        await sharp(Buffer.from(base64, "base64"))
          .resize(1472, 1472, { fit: "contain", background: "black" })
          .png()
          .toBuffer()
      ).toString("base64");
    },
    unzipImage: async (data) => {
      const files = await new Promise<Record<string, Uint8Array>>(
        (resolve, reject) =>
          unzip(
            data,
            { filter: (file) => /\.(png|jpe?g)$/i.test(file.name) },
            (error, result) => (error ? reject(error) : resolve(result)),
          ),
      );
      const image = Object.values(files)[0];
      if (!image) throw new Error("No image found in ZIP file");
      return `data:image/png;base64,${Buffer.from(image).toString("base64")}`;
    },
  };
  const storeImage = async (data: string) => {
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(data))
      throw new Error("Invalid image data");
    const bytes = Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
    const image = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 });
    const metadata = await image.metadata();
    const scale = Math.min(
      1,
      Math.sqrt((1024 * 1024) / (metadata.width * metadata.height)),
    );
    const width = Math.max(1, Math.floor(metadata.width * scale)),
      height = Math.max(1, Math.floor(metadata.height * scale));
    const png = await image.resize(width, height).png().toBuffer();
    const id = randomUUID();
    const { encodeInlayAssetBackup } =
      await import("../../../packages/backup-core/dist/inlayCodec.js");
    const asset = await encodeInlayAssetBackup({
      name: id,
      ext: "png",
      type: "image",
      width,
      height,
      data: new Blob([new Uint8Array(png)], { type: "image/png" }),
    });
    const key = `inlay_${id}.risuinlay`;
    await getAssets().write(hex(key), asset);
    await recordAssets([{ key, size: asset.byteLength }]);
    return id;
  };
  return {
    runtime,
    storeImage,
    removeImage: async (id: string) => {
      await getAssets().remove([hex(`inlay_${id}.risuinlay`)]);
    },
  };
}
