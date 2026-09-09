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
      ? dat
      : new Uint8Array(dat);

  if (isTauri) {
    const bytes =
      typeof data === "string"
        ? new Uint8Array(Buffer.from(data, "utf-8"))
        : data;
    await writeFile(name, bytes, { baseDir: BaseDirectory.Download });
    return true;
  }

  if (isCapacitor) {
    const writer = await CapacitorFileWriter.open(name, getMimeType(name));
    if (!writer) return false;
    try {
      if (typeof data === "string") {
        await writer.writeText(data);
      } else {
        await writer.write(data);
      }
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
