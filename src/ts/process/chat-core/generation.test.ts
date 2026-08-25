import { describe, expect, it, vi } from "vitest";
import {
  createChatGenerationPlan,
  executeChatModelRequest,
  type ChatGenerationRuntime,
} from "./generation";
import type { OpenAIChat } from "./types";

type Response = { type: "success"; result: string; model?: string };
type Character = { id: string };

function runtime(
  counts: number[],
): ChatGenerationRuntime<Character, Response> {
  return {
    tokenizeChatsDetailed: vi.fn(async () => counts),
    getGenerationSettings: () => ({ maxResponseTokens: 8 }),
    createGenerationId: () => "generation-id",
    getGenerationModel: (model) => model ?? "default-model",
    requestModel: vi.fn(async () => ({ type: "success" as const, result: "ok" })),
    registerGenerationContext: vi.fn(),
    unregisterGenerationContext: vi.fn(),
  };
}

const chat = (content: string, removable = false): OpenAIChat => ({
  role: "user",
  content,
  removable,
});

describe("createChatGenerationPlan", () => {
  it("removes only removable prompts until the context fits", async () => {
    const rt = runtime([6, 5, 4]);
    const plan = await createChatGenerationPlan(rt, {
      formated: [chat("fixed"), chat("drop", true), chat("keep", true)],
      maxContextTokens: 10,
    });

    expect(plan).toMatchObject({
      ok: true,
      inputTokens: 10,
      outputTokens: 0,
      generationId: "generation-id",
      generationModel: "default-model",
    });
    if (plan.ok) expect(plan.formated.map((item) => item.content)).toEqual(["fixed", "keep"]);
  });

  it("reports overflow when non-removable prompts cannot fit", async () => {
    const rt = runtime([7, 6]);
    const plan = await createChatGenerationPlan(rt, {
      formated: [chat("a"), chat("b")],
      maxContextTokens: 10,
    });
    expect(plan).toEqual({ ok: false, requiredTokens: 13 });
  });

  it("caps output tokens to the remaining context", async () => {
    const rt = runtime([6]);
    rt.getGenerationSettings = () => ({ maxResponseTokens: 20 });
    const plan = await createChatGenerationPlan(rt, {
      formated: [chat("a")],
      maxContextTokens: 10,
    });
    expect(plan.ok && plan.outputTokens).toBe(4);
  });
});

describe("executeChatModelRequest", () => {
  it("wraps the model request in generation-context ownership", async () => {
    const rt = runtime([1]);
    const plan = await createChatGenerationPlan(rt, {
      formated: [chat("hello")],
      maxContextTokens: 10,
    });
    if (!plan.ok) throw new Error("unexpected overflow");

    await executeChatModelRequest(
      rt,
      {
        plan,
        biases: [],
        currentChar: { id: "char" },
        isGroupChat: false,
        durableChatId: "chat",
        speakerId: "speaker",
      },
      new AbortController().signal,
    );

    expect(rt.registerGenerationContext).toHaveBeenCalledWith({
      realChatId: "chat",
      generationId: "generation-id",
      model: "default-model",
      speakerId: "speaker",
    });
    expect(rt.unregisterGenerationContext).toHaveBeenCalledWith("generation-id");
  });
});
