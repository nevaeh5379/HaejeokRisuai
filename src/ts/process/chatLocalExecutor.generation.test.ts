import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/**
 * Structural regression guard for request-local generation overrides.
 *
 * Mocking the whole local executor is expensive (it pulls the prompt pipeline,
 * storage stores and Svelte runtimes). This cheaply pins the propagation
 * contract instead: every prompt build and every recursive resend/continue path
 * must forward the caller's `generation` payload so a Risu Agent request stays
 * isolated from the shared preset while an ordinary chat runs concurrently.
 */
const source = readFileSync("src/ts/process/chatLocalExecutor.ts", "utf8");

describe("local executor generation override propagation", () => {
  test("forwards generation into the prompt build", () => {
    const promptCall = source.slice(
      source.indexOf("buildGenerationPrompt({"),
      source.indexOf("if (!prompt.ok)"),
    );
    expect(promptCall).toContain("generation: arg.generation");
  });

  test("forwards generation through group, continue and resend paths", () => {
    expect(source.match(/generation: arg\.generation/g)).toHaveLength(4);

    const continueCall = source.slice(
      source.indexOf("continueGeneration: (resultTokens)"),
      source.indexOf("resendGeneration:"),
    );
    expect(continueCall).toContain("generation: arg.generation");

    const resendCall = source.slice(
      source.indexOf("resendGeneration:"),
      source.indexOf("});\n  }\n}"),
    );
    expect(resendCall).toContain("generation: arg.generation");
  });

  test("the executor never writes overrides back into the preset store", () => {
    expect(source).not.toContain("presetStore.state.promptTemplate =");
    expect(source).not.toContain("presetStore.state.promptSettings =");
  });
});
