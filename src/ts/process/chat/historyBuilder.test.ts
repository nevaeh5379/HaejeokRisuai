import { describe, expect, it } from "vitest";
import { getActiveMessages, extractInlayName } from "./historyBuilder";
import type { Chat, Message } from "src/ts/storage/database/schema";

describe("historyBuilder optimization and logic", () => {
  it("collects active messages in correct chronological order", () => {
    const chat: Chat = {
      id: "test-chat-1",
      name: "Test",
      note: "",
      localLore: [],
      fmIndex: -1,
      message: [
        { role: "user", data: "msg 1" } as Message,
        { role: "char", data: "msg 2" } as Message,
        { role: "user", data: "msg 3" } as Message,
      ],
    };

    const result = getActiveMessages(chat);
    expect(result.reset).toBe(false);
    expect(result.messages.map((m) => m.data)).toEqual([
      "msg 1",
      "msg 2",
      "msg 3",
    ]);
  });

  it("skips disabled messages while preserving order", () => {
    const chat: Chat = {
      id: "test-chat-2",
      name: "Test",
      note: "",
      localLore: [],
      fmIndex: -1,
      message: [
        { role: "user", data: "msg 1" } as Message,
        { role: "char", data: "disabled msg", disabled: true } as Message,
        { role: "user", data: "msg 3" } as Message,
      ],
    };

    const result = getActiveMessages(chat);
    expect(result.reset).toBe(false);
    expect(result.messages.map((m) => m.data)).toEqual(["msg 1", "msg 3"]);
  });

  it("handles allBefore disabled message correctly", () => {
    const chat: Chat = {
      id: "test-chat-3",
      name: "Test",
      note: "",
      localLore: [],
      fmIndex: -1,
      message: [
        { role: "user", data: "old 1" } as Message,
        { role: "char", data: "old 2" } as Message,
        { role: "user", data: "cut point", disabled: "allBefore" } as Message,
        { role: "char", data: "new 1" } as Message,
        { role: "user", data: "new 2" } as Message,
      ],
    };

    const result = getActiveMessages(chat);
    expect(result.reset).toBe(true);
    expect(result.messages.map((m) => m.data)).toEqual(["new 1", "new 2"]);
  });

  it("extracts inlay names correctly across all variants", () => {
    expect(extractInlayName("{{inlay::asset123}}")).toBe("asset123");
    expect(extractInlayName("{{inlayed::photo456}}")).toBe("photo456");
    expect(extractInlayName("{{inlayeddata::data789}}")).toBe("data789");
    expect(extractInlayName("plain_name")).toBe("plain_name");
  });
});
