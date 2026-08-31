import { asBuffer } from "../../util";

export type InlayAsset = {
  data: string | Blob;
  /** File extension */
  ext: string;
  height?: number;
  name: string;
  type: "image" | "video" | "audio" | "signature";
  width?: number;
};

type InlayBackupMetadata = Omit<InlayAsset, "data"> & {
  dataType: "blob" | "text";
  mime?: string;
};

export async function encodeInlayAssetBackup(
  asset: InlayAsset,
): Promise<Uint8Array> {
  const { data, ...rest } = asset;
  const isBlob = data instanceof Blob;
  const payload = isBlob
    ? new Uint8Array(await data.arrayBuffer())
    : new TextEncoder().encode(data);
  const metadata: InlayBackupMetadata = {
    ...rest,
    dataType: isBlob ? "blob" : "text",
    ...(isBlob && data.type ? { mime: data.type } : {}),
  };
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const output = new Uint8Array(
    4 + metadataBytes.byteLength + payload.byteLength,
  );
  new DataView(output.buffer).setUint32(0, metadataBytes.byteLength, true);
  output.set(metadataBytes, 4);
  output.set(payload, 4 + metadataBytes.byteLength);
  return output;
}

export function decodeInlayAssetBackup(data: Uint8Array): InlayAsset {
  if (data.byteLength < 4) throw new Error("Invalid inlay backup payload");
  const metadataLength = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getUint32(0, true);
  if (
    metadataLength === 0 ||
    metadataLength > 1024 * 1024 ||
    4 + metadataLength > data.byteLength
  ) {
    throw new Error("Invalid inlay backup metadata length");
  }
  const metadata = JSON.parse(
    new TextDecoder().decode(data.subarray(4, 4 + metadataLength)),
  ) as Partial<InlayBackupMetadata>;
  if (
    typeof metadata.name !== "string" ||
    typeof metadata.ext !== "string" ||
    !["image", "video", "audio", "signature"].includes(metadata.type ?? "") ||
    (metadata.dataType !== "blob" && metadata.dataType !== "text")
  ) {
    throw new Error("Invalid inlay backup metadata");
  }
  const payload = data.subarray(4 + metadataLength);
  const restoredData =
    metadata.dataType === "blob"
      ? new Blob([asBuffer(payload)], { type: metadata.mime ?? "" })
      : new TextDecoder().decode(payload);
  return {
    name: metadata.name,
    ext: metadata.ext,
    type: metadata.type,
    ...(typeof metadata.width === "number" ? { width: metadata.width } : {}),
    ...(typeof metadata.height === "number"
      ? { height: metadata.height }
      : {}),
    data: restoredData,
  } as InlayAsset;
}