import { beforeEach, expect, test, vi } from "vitest";

const getUserName = vi.hoisted(() => vi.fn(() => "Target User"));
const addText = vi.hoisted(() => vi.fn(async () => {}));
const similaritySearch = vi.hoisted(() =>
  vi.fn(async (text: string) => [text]),
);

vi.mock("src/ts/util", () => ({ getUserName }));
vi.mock("../memory/hypamemory", () => ({
  HypaProcesser: class {
    addText = addText;
    similaritySearch = similaritySearch;
  },
}));

import { additionalInformations } from "./addinfo";

beforeEach(() => {
  vi.clearAllMocks();
});test("uses the explicit chat target for user names", async () => {
  const target = { characterId: "char-target", chatId: "chat-target" };
  const result = await additionalInformations(
    { name: "Bot", additionalText: "reference" } as never,
    {
      message: [
        { role: "user", data: "hello" },
        { role: "char", data: "hi" },
      ],
    } as never,
    target,
  );

  expect(getUserName).toHaveBeenCalledWith(target);
  expect(similaritySearch).toHaveBeenCalledWith(
    "Target User: hello\n\nBot: hi",
  );
  expect(result).toBe("Target User: hello\n\nBot: hi");
});