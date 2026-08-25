import { describe, expect, it } from "vitest";
import { buildOpenAILegacyInstructPrompt } from "./legacyInstruct";

describe("OpenAI legacy instruct", () => {
  it("formats legacy role headings and skips blank messages", () => {
    const messages = [
      { role: "system", content: "  rules  " },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "custom", content: "value" },
      { role: "user", content: "   " },
    ] as any;

    expect(buildOpenAILegacyInstructPrompt(messages)).toBe(
      "\n## Instruction\nrules" +
        "\n## User\nhello" +
        "\n## Assistant\nhi" +
        "\n## custom\nvalue" +
        "\n## Response\n",
    );
    expect(messages[0].content).toBe("rules");
  });
});
