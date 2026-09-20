import { decodeInlayAssetBackup, type InlayAsset } from "./inlayCodec";

export type InlayRestoreResult =
  | { status: "restored" }
  | { status: "invalid"; error: unknown }
  | { status: "storage-error"; error: unknown };

export type InlayRestoreDecode = (data: Uint8Array) => InlayAsset;

export type InlayRestoreWrite = (
  inlayKey: string,
  asset: InlayAsset,
) => Promise<void>;

export interface InlayRestoreDependencies {
  /** Payload decoder; defaults to the bundled inlay codec. */
  decode?: InlayRestoreDecode;
  /** Storage writer applied to a validated inlay asset. Required. */
  write: InlayRestoreWrite;
}

/**
 * Applies a decoded inlay backup entry: decodes the payload with the inlay
 * codec and persists the asset through the injected writer. Malformed
 * payloads are classified as "invalid" without touching storage; storage
 * failures are classified as "storage-error". No payload copies are made
 * beyond the decoded asset itself.
 */
export async function restoreInlayBackupEntry(
  inlayKey: string,
  data: Uint8Array,
  dependencies: InlayRestoreDependencies,
): Promise<InlayRestoreResult> {
  const decode: InlayRestoreDecode =
    dependencies.decode ?? decodeInlayAssetBackup;
  let asset: InlayAsset;

  try {
    asset = decode(data);
  } catch (error) {
    return { status: "invalid", error };
  }

  try {
    await dependencies.write(inlayKey, asset);
  } catch (error) {
    return { status: "storage-error", error };
  }

  return { status: "restored" };
}
