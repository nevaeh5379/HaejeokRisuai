import { describe, expect, it } from "vitest";
import {
  NOVELAI_BAD_WORD_IDS,
  NOVELAI_REPETITION_PENALTY_WHITELIST,
  buildNovelAIRequest,
} from "@risuai/chat-core/novelAIProvider.cjs";

const settings = {
  topK: 10,
  topP: 0.9,
  topA: 0.1,
  tailFreeSampling: 0.95,
  repetitionPenalty: 1.1,
  repetitionPenaltyRange: 2048,
  repetitionPenaltySlope: 0.2,
  frequencyPenalty: 0.3,
  presencePenalty: 0.4,
  typicalp: 0.8,
};

describe("NovelAI provider core", () => {
  it("keeps provider token policy constants in shared core", () => {
    expect(NOVELAI_BAD_WORD_IDS.length).toBeGreaterThan(300);
    expect(NOVELAI_BAD_WORD_IDS[0]).toEqual([60]);
    expect(NOVELAI_BAD_WORD_IDS.at(-1)).toEqual([23]);
    expect(NOVELAI_REPETITION_PENALTY_WHITELIST).toContain(49256);
    expect(NOVELAI_REPETITION_PENALTY_WHITELIST).toContain(12);
  });

  it("builds Kayra adventure payloads with legacy defaults", () => {
    const bias = {
      sequence: [1, 2],
      bias: 1.5,
      ensure_sequence_finish: false as const,
      generate_once: true as const,
    };
    const result = buildNovelAIRequest({
      prompt: "prompt",
      modelId: "novelai_kayra",
      adventureMode: true,
      temperature: 0.7,
      maxTokens: 300,
      settings,
      logitBiasExp: [bias],
    });

    expect(result.variant).toBe("kayra");
    expect(result.body.model).toBe("kayra-v1");
    expect(result.body.input).toBe("prompt");
    expect(result.body.parameters).toMatchObject({
      temperature: 0.7,
      max_length: 300,
      prefix: "theme_textadventure",
      mirostat_lr: 1,
      mirostat_tau: 0,
      cfg_scale: 1,
      logit_bias_exp: [bias],
      bad_words_ids: NOVELAI_BAD_WORD_IDS,
      repetition_penalty_whitelist: NOVELAI_REPETITION_PENALTY_WHITELIST,
    });
  });

  it("builds Clio payloads and preserves explicit advanced sampler values", () => {
    const result = buildNovelAIRequest({
      prompt: "prompt",
      modelId: "novelai_clio",
      adventureMode: false,
      temperature: 1,
      maxTokens: 128,
      settings: {
        ...settings,
        mirostat_lr: 0.25,
        mirostat_tau: 4,
        cfg_scale: 1.5,
      },
    });

    expect(result.variant).toBe("clio");
    expect(result.body.model).toBe("clio-v1");
    expect(result.body.parameters).toMatchObject({
      prefix: "vanilla",
      mirostat_lr: 0.25,
      mirostat_tau: 4,
      cfg_scale: 1.5,
      stop_sequences: [[49287], [49405]],
      order: [6, 2, 3, 0, 4, 1, 5, 8],
    });
  });
});
