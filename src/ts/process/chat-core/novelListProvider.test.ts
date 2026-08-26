import { describe, expect, it } from "vitest";
import { buildNovelListRequestBody } from "@risuai/chat-core/novelListProvider.cjs";

const sampler = {
  top_p: 0.9,
  top_k: 40,
  rep_pen: 1.1,
  top_a: 0.2,
  rep_pen_slope: 0.4,
  rep_pen_range: 512,
  typical_p: 0.95,
  badwords: "bad",
  stoptokens: "END",
};

describe("NovelList provider core", () => {
  it("builds the Damsel payload and serializes logit bias pairs", () => {
    expect(
      buildNovelListRequestBody({
        text: "prompt",
        maxTokens: 256,
        temperature: 0.7,
        sampler,
        modelId: "novellist_damsel",
        biasString: [
          ["alpha", 1.5],
          ["beta", -2],
        ],
      }),
    ).toEqual({
      text: "prompt",
      length: 256,
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      rep_pen: 1.1,
      top_a: 0.2,
      rep_pen_slope: 0.4,
      rep_pen_range: 512,
      typical_p: 0.95,
      badwords: "bad",
      model: "damsel",
      stoptokens: "「END",
      logit_bias: "alpha<<|>>beta",
      logit_bias_values: "1.5|-2",
    });
  });

  it("uses SuperTrin and leaves empty bias fields undefined", () => {
    expect(
      buildNovelListRequestBody({
        text: "prompt",
        maxTokens: 128,
        temperature: 1,
        sampler,
        modelId: "novellist_supertrin",
      }),
    ).toEqual({
      text: "prompt",
      length: 128,
      temperature: 1,
      top_p: 0.9,
      top_k: 40,
      rep_pen: 1.1,
      top_a: 0.2,
      rep_pen_slope: 0.4,
      rep_pen_range: 512,
      typical_p: 0.95,
      badwords: "bad",
      model: "supertrin",
      stoptokens: "「END",
      logit_bias: undefined,
      logit_bias_values: undefined,
    });
  });
});
