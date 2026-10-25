export type InlayAsset = {
  data: string | Blob;
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

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const VALID_INLAY_TYPES = new Set(["image", "video", "audio", "signature"]);

export async function encodeInlayAssetBackup(
  asset: InlayAsset,
): Promise<Uint8Array> {
  const { data, ...rest } = asset;
  const isBlob = data instanceof Blob;
  const payload = isBlob
    ? new Uint8Array(await data.arrayBuffer())
    : textEncoder.encode(data);
  const metadata: InlayBackupMetadata = {
    ...rest,
    dataType: isBlob ? "blob" : "text",
    ...(isBlob && data.type ? { mime: data.type } : {}),
  };
  const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
  const metadataLength = metadataBytes.byteLength;
  const output = new Uint8Array(
    4 + metadataLength + payload.byteLength,
  );
  output[0] = metadataLength & 0xff;
  output[1] = (metadataLength >>> 8) & 0xff;
  output[2] = (metadataLength >>> 16) & 0xff;
  output[3] = (metadataLength >>> 24) & 0xff;
  output.set(metadataBytes, 4);
  output.set(payload, 4 + metadataLength);
  return output;
}

export function decodeInlayAssetBackup(data: Uint8Array): InlayAsset {
  if (data.byteLength < 4) throw new Error("Invalid inlay backup payload");
  const metadataLength =
    (data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24)) >>> 0;
  if (
    metadataLength === 0 ||
    metadataLength > 1024 * 1024 ||
    4 + metadataLength > data.byteLength
  ) {
    throw new Error("Invalid inlay backup metadata length");
  }

  const metadata = JSON.parse(
    textDecoder.decode(data.subarray(4, 4 + metadataLength)),
  ) as Partial<InlayBackupMetadata>;
  if (
    typeof metadata.name !== "string" ||
    typeof metadata.ext !== "string" ||
    !VALID_INLAY_TYPES.has(metadata.type ?? "") ||
    (metadata.dataType !== "blob" && metadata.dataType !== "text")
  ) {
    throw new Error("Invalid inlay backup metadata");
  }

  const payload = data.subarray(4 + metadataLength);
  const restoredData =
    metadata.dataType === "blob"
      ? new Blob([payload as BlobPart], { type: metadata.mime ?? "" })
      : textDecoder.decode(payload);
  return {
    name: metadata.name,
    ext: metadata.ext,
    type: metadata.type,
    ...(typeof metadata.width === "number" ? { width: metadata.width } : {}),
    ...(typeof metadata.height === "number" ? { height: metadata.height } : {}),
    data: restoredData,
  } as InlayAsset;
}
