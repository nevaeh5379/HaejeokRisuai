import { afterEach, describe, expect, test } from "vitest";
import {
  clearRisuAgentContextScope,
  getRisuAgentContextScope,
  resetRisuAgentContextScopesForTesting,
  setRisuAgentContextScope,
} from "./scope";

afterEach(() => resetRisuAgentContextScopesForTesting());

describe("Risu Agent context scope registry", () => {
  test("stores stable ids keyed by the agent session", () => {
    setRisuAgentContextScope("agent-chat", {
      characterId: "char-a",
      chatId: "chat-a",
    });

    expect(getRisuAgentContextScope("agent-chat")).toEqual({
      characterId: "char-a",
      chatId: "chat-a",
    });
    expect(getRisuAgentContextScope("other-chat")).toBeUndefined();
  });

  test("a null scope detaches the session", () => {
    setRisuAgentContextScope("agent-chat", { characterId: "char-a" });
    setRisuAgentContextScope("agent-chat", null);

    expect(getRisuAgentContextScope("agent-chat")).toBeUndefined();
  });

  test("clears individual sessions and everything on teardown", () => {
    setRisuAgentContextScope("agent-1", { characterId: "char-a" });
    setRisuAgentContextScope("agent-2", { characterId: "char-b" });

    clearRisuAgentContextScope("agent-1");
    expect(getRisuAgentContextScope("agent-1")).toBeUndefined();
    expect(getRisuAgentContextScope("agent-2")).toEqual({
      characterId: "char-b",
    });

    resetRisuAgentContextScopesForTesting();
    expect(getRisuAgentContextScope("agent-2")).toBeUndefined();
  });

  test("ignores blank session ids and blank character scopes", () => {
    setRisuAgentContextScope("", { characterId: "char-a" });
    setRisuAgentContextScope("agent-1", { characterId: "" });

    expect(getRisuAgentContextScope("")).toBeUndefined();
    expect(getRisuAgentContextScope("agent-1")).toBeUndefined();
  });
});
