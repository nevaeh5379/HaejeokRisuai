import { describe, expect, it } from "vitest";
import { normalizeOllamaStreamResponse } from "./ollama";

describe("normalizeOllamaStreamResponse", () => {
  it("should split multiple JSON objects with newlines and ignore brackets inside strings", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Stream with JSON objects containing escaped quotes and braces in strings
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('{"message":{"content":"Hello {world}"}}'),
        );
        controller.enqueue(
          encoder.encode('{"message":{"content":"Second \\"quote\\" here"}}'),
        );
        controller.close();
      },
    });

    const response = new Response(stream);
    const normalized = normalizeOllamaStreamResponse(response);

    const reader = normalized.body!.getReader();
    let result = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      result += decoder.decode(value, { stream: true });
    }
    result += decoder.decode();

    const lines = result.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toEqual({
      message: { content: "Hello {world}" },
    });
    expect(JSON.parse(lines[1])).toEqual({
      message: { content: 'Second "quote" here' },
    });
  });

  it("should handle null body gracefully", () => {
    const response = new Response(null);
    const normalized = normalizeOllamaStreamResponse(response);
    expect(normalized.body).toBeNull();
  });
});
