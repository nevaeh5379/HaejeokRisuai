import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LLMTokenizer } from "src/ts/model/types.ts";
import { tokenizerList } from "src/ts/tokenizer.ts";
import {
  DEFAULT_TIKTOKEN_ROUTE,
  FALLBACK_TIKTOKEN_ROUTE,
  modelTokenizerRoutes,
  namedTokenizerRoutes,
  nonTiktokenNamedRoutes,
  resolveModelTokenizerRoute,
  resolveNamedTokenizerRoute,
  webTokenizerSources,
} from "src/ts/tokenizerRoutes.ts";

describe("tokenizer routing", () => {
  it("routes every tokenizer id the settings and the playground offer", () => {
    const ids = tokenizerList.map(([id]) => id).filter((id) => id !== "tik");
    for (const id of ids) {
      const route = resolveNamedTokenizerRoute(id, FALLBACK_TIKTOKEN_ROUTE);
      expect(route, `no route for the "${id}" tokenizer id`).not.toBe(
        FALLBACK_TIKTOKEN_ROUTE,
      );
      if (route.kind === "web") {
        expect(webTokenizerSources[route.target]).toBeDefined();
      }
    }
    expect(Object.keys(namedTokenizerRoutes).sort()).toEqual(
      [...ids, "cl100k_base", "o200k_base"].sort(),
    );
  });

  it("honours a plugin that declares a tiktoken encoding directly", () => {
    expect(
      resolveNamedTokenizerRoute("cl100k_base", DEFAULT_TIKTOKEN_ROUTE),
    ).toEqual({ kind: "tiktoken", encoding: "cl100k_base" });
    expect(
      resolveNamedTokenizerRoute("o200k_base", DEFAULT_TIKTOKEN_ROUTE),
    ).toEqual({ kind: "tiktoken", encoding: "o200k_base" });
    expect(resolveNamedTokenizerRoute("none", DEFAULT_TIKTOKEN_ROUTE)).toBe(
      DEFAULT_TIKTOKEN_ROUTE,
    );
  });

  it("falls back to the caller's tiktoken default for the bare tiktoken id", () => {
    // Provider settings count with o200k, which is also what the Node server uses;
    // the playground picker keeps its historical cl100k behaviour.
    expect(resolveNamedTokenizerRoute("tik", DEFAULT_TIKTOKEN_ROUTE)).toEqual({
      kind: "tiktoken",
      encoding: "o200k_base",
    });
    expect(resolveNamedTokenizerRoute("tik", FALLBACK_TIKTOKEN_ROUTE)).toEqual({
      kind: "tiktoken",
      encoding: "cl100k_base",
    });
  });

  it("counts the llama3 setting with the Llama 3 vocabulary, not Llama 1/2", () => {
    const route = resolveNamedTokenizerRoute("llama3", FALLBACK_TIKTOKEN_ROUTE);
    expect(route).toEqual({ kind: "web", target: "llama3" });
    expect(webTokenizerSources.llama3.path).toBe("/token/llama/llama3.json");
    expect(webTokenizerSources.llama.path).toBe("/token/llama/llama.model");
  });

  it("counts gemma and Gemini with a Gemma vocabulary, not the Llama 3 one", () => {
    expect(
      resolveNamedTokenizerRoute("gemma", FALLBACK_TIKTOKEN_ROUTE),
    ).toEqual({ kind: "web", target: "gemma" });
    const modelRoute = resolveModelTokenizerRoute(
      LLMTokenizer.GoogleCloud,
      false,
    );
    expect(modelRoute).toEqual({ kind: "web", target: "gemma" });

    const source = webTokenizerSources.gemma;
    expect(source.loader).toBe("sentencePiece");
    expect(source.path).toContain("/token/gemma");
    expect(source.path).not.toContain("/token/llama");
  });

  it("covers every tokenizer a model list entry can declare", () => {
    for (const tokenizer of Object.values(LLMTokenizer)) {
      const route = resolveModelTokenizerRoute(tokenizer, false);
      expect(route).toBeDefined();
      if (route.kind === "web") {
        expect(webTokenizerSources[route.target]).toBeDefined();
      }
    }
    expect(modelTokenizerRoutes[LLMTokenizer.Llama3]).toEqual({
      kind: "web",
      target: "llama3",
    });
    expect(modelTokenizerRoutes[LLMTokenizer.Local]).toEqual({ kind: "gguf" });
    expect(resolveModelTokenizerRoute(LLMTokenizer.GoogleCloud, true)).toEqual({
      kind: "googleCloud",
    });
  });

  it("ships every vocabulary file the routes point at", () => {
    for (const [target, source] of Object.entries(webTokenizerSources)) {
      expect(
        existsSync(join(process.cwd(), "public", source.path)),
        `${target} vocabulary is missing from public/`,
      ).toBe(true);
    }
  });

  it("keeps non-tiktoken ids out of the server side token counting", () => {
    expect(nonTiktokenNamedRoutes.has("tik")).toBe(false);
    for (const id of ["llama3", "gemma", "claude", "glm5"]) {
      expect(nonTiktokenNamedRoutes.has(id)).toBe(true);
    }
  });
});
