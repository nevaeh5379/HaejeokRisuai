import { registerPlugin } from "@capacitor/core";
import { Buffer } from "buffer";
import { isCapacitor } from "../platform";

export interface StreamFileWriterPlugin {
  open(options: {
    fileName: string;
    mimeType: string;
  }): Promise<{ id?: string; cancelled?: boolean }>;
  write(options: { id: string; data: string }): Promise<void>;
  writeAssets(options: {
    id: string;
    keys: string[];
  }): Promise<{ written: number; missing: string[] }>;
  close(options: { id: string }): Promise<void>;
}

const nativeStreamFileWriter = isCapacitor
  ? registerPlugin<StreamFileWriterPlugin>("StreamFileWriter")
  : undefined;

export class CapacitorFileWriter {
  private constructor(
    private readonly plugin: StreamFileWriterPlugin,
    private readonly id: string,
  ) {}

  static async open(
    fileName: string,
    mimeType = "application/octet-stream",
  ): Promise<CapacitorFileWriter | null> {
    if (!nativeStreamFileWriter) {
      throw new Error("Native file writer is unavailable");
    }
    const opened = await nativeStreamFileWriter.open({ fileName, mimeType });
    if (opened.cancelled) return null;
    if (!opened.id) throw new Error("Native save destination is unavailable");
    return new CapacitorFileWriter(nativeStreamFileWriter, opened.id);
  }

  async write(data: Uint8Array): Promise<void> {
    await this.plugin.write({
      id: this.id,
      data: Buffer.from(data).toString("base64"),
    });
  }

  async writeAssets(
    keys: string[],
  ): Promise<{ written: number; missing: string[] }> {
    return await this.plugin.writeAssets({ id: this.id, keys });
  }

  async close(): Promise<void> {
    await this.plugin.close({ id: this.id });
  }
}
