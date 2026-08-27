import { describe, expect, it } from "vitest";
import { decodeRisuSave, encodeRisuSaveLegacy } from "./risuSave";

class NoCopyUint8Array extends Uint8Array<ArrayBuffer> {
  override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
    throw new Error("RisuSave decoder copied the full input buffer");
  }
}

describe("RisuSave decode memory behavior", () => {
  it("decodes legacy raw saves without copying the full input buffer", async () => {
    const source = encodeRisuSaveLegacy({
      personas: [{ name: "A", icon: "", personaPrompt: "" }],
      modules: [{ id: "module-1", name: "Module" }],
      botPresets: [{ name: "Preset", mainPrompt: "hello" }],
    });
    const guarded = new NoCopyUint8Array(new ArrayBuffer(source.byteLength));
    guarded.set(source);

    const decoded = await decodeRisuSave(guarded);

    expect(decoded.personas).toHaveLength(1);
    expect(decoded.modules).toHaveLength(1);
    expect(decoded.botPresets).toHaveLength(1);
  });
});