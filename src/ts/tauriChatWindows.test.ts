import { describe, expect, it } from "vitest";
import {
  buildTauriChatWindowUrl,
  parseTauriChatWindowTarget,
} from "./tauriChatWindows";

describe("Tauri chat window targets", () => {
  it("round-trips character and chat ids through a launch URL", () => {
    const url = buildTauriChatWindowUrl(
      { characterId: "character one", chatId: "chat/two" },
      "/index.html",
    );

    const search = url.slice(url.indexOf("?"));
    expect(parseTauriChatWindowTarget(search)).toEqual({
      characterId: "character one",
      chatId: "chat/two",
    });
  });

  it("ignores normal application URLs", () => {
    expect(parseTauriChatWindowTarget("?characterId=a&chatId=b")).toBeNull();
  });

  it("rejects incomplete chat window targets", () => {
    expect(
      parseTauriChatWindowTarget("?risuWindow=chat&characterId=a"),
    ).toBeNull();
    expect(parseTauriChatWindowTarget("?risuWindow=chat&chatId=b")).toBeNull();
  });
});
