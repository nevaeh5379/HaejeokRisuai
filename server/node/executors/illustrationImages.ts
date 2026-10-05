import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import sharp from "sharp";
import { unzip } from "fflate";
import type { ImageGenerationRuntime } from "../../../packages/protocol/dist/imageGeneration.cjs";

/**
 * Defines the asset operations needed by the Node illustration image adapter.
 *
 * 한국어: Node 삽화 이미지 어댑터에 필요한 자산 저장소 동작 계약.
 */
type Assets = {
  /**
   * Reads image or reference bytes by encoded asset key.
   *
   * 한국어: 인코딩한 자산 키로 그림·참조 이미지 바이트를 읽는 함수.
   */
  read(key: string): Promise<Uint8Array>;
  /**
   * Durably writes encoded inlay bytes.
   *
   * 한국어: 인코딩된 인레이 바이트를 영구 저장하는 함수.
   */
  write(key: string, data: Uint8Array): Promise<unknown>;
  /**
   * Deletes assets by encoded keys.
   *
   * 한국어: 인코딩한 키 목록으로 자산을 삭제하는 함수.
   */
  remove(keys: string[]): Promise<unknown>;
};
/**
 * Encodes a logical asset name in the hexadecimal format expected by server storage.
 *
 * 한국어: 논리 자산 이름을 서버 저장소에서 사용하는 16진수 키로 바꾸는 함수.
 */
const hex = (key: string) => Buffer.from(key).toString("hex");

/**
 * Creates Node image transport, reference processing and durable inlay storage adapters.
 *
 * 한국어: Node 이미지 전송·참조 처리·인레이 영구 저장 어댑터를 만드는 함수.
 *
 * @param getAssets - Resolves the active asset storage. / 활성 자산 저장소 조회 함수.
 * @param recordAssets - Registers saved asset sizes in the existing catalog. / 저장 자산 크기를 기존 목록에 등록하는 함수.
 * @param sanitizeUrl - Existing proxy URL validator. / 기존 프록시 URL 검증 함수.
 * @returns Image runtime and inlay save/remove operations. / 이미지 실행 어댑터·인레이 저장 및 제거 함수.
 */
export function createIllustrationImages(
  getAssets: () => Assets,
  recordAssets: (entries: { key: string; size: number }[]) => Promise<void>,
  sanitizeUrl: (url: string) => string | null,
) {
  /**
   * Validates the destination, rejects redirects and applies a default ten-minute timeout.
   *
   * 한국어: 목적지 검증·리디렉션 차단·기본 10분 제한을 적용해 요청하는 함수.
   */
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
    /**
     * Adapts JSON or raw-byte HTTP responses to the shared provider transport contract.
     *
     * 한국어: JSON·바이트 HTTP 응답을 공통 제공자 전송 계약에 맞추는 함수.
     */
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
    /**
     * Reads a character/reference image or returns null when no asset path is supplied.
     *
     * 한국어: 캐릭터·참조 이미지를 읽거나 자산 경로가 없으면 null을 반환하는 함수.
     */
    readImage: async (path) => (path ? getAssets().read(hex(path)) : null),
    /**
     * Fits a reference into a black 1472-square PNG canvas using sharp.
     *
     * 한국어: sharp로 참조 그림 비율을 유지하며 검은 1472 정사각 PNG에 맞추는 함수.
     */
    resizeReference: async (base64) => {
      if (!base64) return "";
      return (
        await sharp(Buffer.from(base64, "base64"))
          .resize(1472, 1472, { fit: "contain", background: "black" })
          .png()
          .toBuffer()
      ).toString("base64");
    },
    /**
     * Extracts the first PNG/JPEG entry from a provider ZIP into an image data URL.
     *
     * 한국어: 제공자 ZIP에서 첫 PNG·JPEG 파일을 추출해 이미지 데이터 URL로 만드는 함수.
     *
     * @throws When the ZIP contains no accepted image entry. / ZIP에 허용한 이미지 파일이 없는 경우.
     */
    unzipImage: async (data) => {
      const files = await new Promise<Record<string, Uint8Array>>(
        (resolve, reject) =>
          unzip(
            data,
            {
              /**
               * Selects only PNG/JPEG entries before ZIP decompression.
               *
               * 한국어: ZIP 압축 해제 전에 PNG·JPEG 항목만 선택하는 함수.
               */
              filter: (file) => /\.(png|jpe?g)$/i.test(file.name),
            },
            (error, result) => (error ? reject(error) : resolve(result)),
          ),
      );
      const image = Object.values(files)[0];
      if (!image) throw new Error("No image found in ZIP file");
      return `data:image/png;base64,${Buffer.from(image).toString("base64")}`;
    },
  };
  /**
   * Saves a validated image as a PNG inlay capped at 1024 squared pixels and records its asset entry.
   *
   * 한국어: 검증한 그림을 최대 1024×1024 픽셀 수의 PNG 인레이로 저장하고 자산 항목을 등록하는 함수.
   *
   * @param data - Base64 image data URL. / Base64 이미지 데이터 URL.
   * @returns New inlay ID after both asset write and catalog registration succeed. / 자산 저장·목록 등록 성공 후 새 인레이 ID.
   * @remarks
   * Uses the existing backup codec so server-created pictures survive ordinary backups/restores.
   * 한국어: 기존 백업 코덱으로 서버 생성 그림도 일반 백업·복원에서 유지.
   */
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
    /**
     * Deletes an orphaned inlay's encoded asset from server storage.
     *
     * 한국어: 미사용 인레이의 인코딩된 자산을 서버 저장소에서 삭제하는 함수.
     */
    removeImage: async (id: string) => {
      await getAssets().remove([hex(`inlay_${id}.risuinlay`)]);
    },
  };
}
