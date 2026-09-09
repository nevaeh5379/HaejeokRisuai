import { BaseDirectory, writeFile } from "@tauri-apps/plugin-fs";
import { Buffer } from "buffer";
import { getMimeType } from "../media/mimeType";
import { isCapacitor, isTauri } from "../platform";
import { CapacitorFileWriter } from "./capacitorFileWriter";

export async function downloadFile(
  name: string,
  dat: Uint8Array | ArrayBuffer | string,
): Promise<boolean> {
  const data =
    typeof dat === "string"
      ? new Uint8Array(Buffer.from(dat, "utf-8"))
      : new Uint8Array(dat);

  if (isTauri) {
    await writeFile(name, data, { baseDir: BaseDirectory.Download });
    return true;
  }

  if (isCapacitor) {
    const writer = await CapacitorFileWriter.open(name, getMimeType(name));
    if (!writer) return false;
    try {
      await writer.write(data);
    } finally {
      await writer.close();
    }
    return true;
  }

  const blob = new Blob([data], { type: getMimeType(name) });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
