import { describe, expect, it } from "vitest";
import {
  decodeRisuSave,
  encodeRisuSaveLegacy,
  encodeRisuSaveLegacyAsync,
} from "./risuSave";

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
      plugins: [
        {
          name: "backup-plugin",
          version: "3.0",
          enabled: true,
          script: "console.log('backup')",
        },
      ],
      pluginCustomStorage: { "backup-plugin": { restored: true } },
    });
    const guarded = new NoCopyUint8Array(new ArrayBuffer(source.byteLength));
    guarded.set(source);

    const decoded = await decodeRisuSave(guarded);

    expect(decoded.personas).toHaveLength(1);
    expect(decoded.modules).toHaveLength(1);
    expect(decoded.botPresets).toHaveLength(1);
    expect(decoded.plugins?.[0]?.name).toBe("backup-plugin");
    expect(decoded.pluginCustomStorage).toEqual({
      "backup-plugin": { restored: true },
    });
  });

  it("preserves branch-scoped Lua state through compressed backup encoding", async () => {
    const largeState = JSON.stringify({ scenes: ["x".repeat(128 * 1024)] });
    const source = {
      characters: [
        {
          chaId: "char-1",
          type: "character",
          name: "Bot",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              note: "",
              localLore: [],
              message: [{ role: "user", data: "hello", chatId: "m1" }],
              scriptstate: { "$lb-xnai-stack": "live" },
              branchState: {
                baseMessageIndex: 0,
                activeBranchId: "child",
                branches: [
                  {
                    id: "root",
                    branchMessageIndex: 0,
                    reason: "root",
                    createdAt: 1,
                    messages: [],
                    scriptstate: { "$lb-xnai-stack": largeState },
                    GLGlobalVariables: { lightboard: "root" },
                    useLocallySetGlobalVariables: true,
                  },
                  {
                    id: "child",
                    parentBranchId: "root",
                    branchMessageIndex: 0,
                    reason: "reroll",
                    createdAt: 2,
                    messages: [],
                    scriptstate: null,
                    GLGlobalVariables: null,
                    useLocallySetGlobalVariables: false,
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const encoded = await encodeRisuSaveLegacyAsync(source, "compression");
    const decoded = await decodeRisuSave(encoded);

    expect(decoded.characters[0].chats[0].branchState).toEqual(
      source.characters[0].chats[0].branchState,
    );
    expect(decoded.characters[0].chats[0].scriptstate).toEqual({
      "$lb-xnai-stack": "live",
    });
  });
});
