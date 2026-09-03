import { describe, expect, it } from "vitest";
import {
  createChatAssetNameIndex,
  resolveChatAssetFromIndex,
} from "./chatAssetResolver";

const distance = (left: string, right: string) => {
  if (left === right) return 0;
  return Math.abs(left.length - right.length) + 1;
};

describe("chat asset resolver", () => {
  it("lets later assets override duplicate names", () => {
    const index = createChatAssetNameIndex([
      ["portrait.png", "module-path", "png"],
      ["PORTRAIT.PNG", "character-path", "png"],
    ]);

    expect(resolveChatAssetFromIndex(index, "portrait.png", distance)).toBe(
      "character-path",
    );
  });

  it("limits fuzzy matching to assets sharing the requested filename prefix", () => {
    const index = createChatAssetNameIndex([
      ["alice.png", "alice-png", "png"],
      ["alice.webp", "alice-webp", "webp"],
      ["bob.png", "bob-png", "png"],
    ]);

    const seen: string[] = [];
    const result = resolveChatAssetFromIndex(
      index,
      "alice.jpg",
      (left, right) => {
        seen.push(right);
        return right.endsWith(".png") ? 1 : 2;
      },
    );

    expect(result).toBe("alice-png");
    expect(seen.sort()).toEqual(["alice.png", "alice.webp"]);
  });
});
