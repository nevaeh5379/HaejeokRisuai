import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, character } from "./storage/database/schema";
const vars = vi.hoisted(() => ({ get: vi.fn(() => "null"), set: vi.fn() }));
vi.mock("./parser/chatVar.svelte", () => ({
  getChatVar: vars.get,
  setChatVar: vars.set,
}));
import {
  normalizeOnboarding,
  applyOnboardingAnswers,
  readFormAnswers,
  getActiveOnboarding,
  isOnboardingPending,
  isQuestionAnswered,
  createOnboardingQuestion,
} from "./onboarding";

describe("character onboarding", () => {
  beforeEach(() => vi.clearAllMocks());
  it("normalizes imported cards and ignores malformed questions/options", () => {
    const onboarding = normalizeOnboarding({
      enabled: true,
      mode: "form",
      title: 42,
      questions: [
        null,
        {
          title: "Route",
          type: "multiple",
          varName: "route",
          options: [null, { label: "A", value: "a" }],
        },
      ],
    });
    expect(onboarding).toMatchObject({
      enabled: true,
      title: "",
      questions: [
        {
          title: "Route",
          type: "multiple",
          varName: "route",
          options: [{ label: "A", value: "a" }],
        },
      ],
    });
    expect(onboarding!.questions[0].id).toBeTruthy();
  });
  it("writes answers to the opened chat target and marks only that chat complete", () => {
    const target = { characterId: "room-1", chatId: "chat-1" };
    const chat = { id: "chat-1" } as Chat;
    applyOnboardingAnswers(chat, { route: "a", empty: "", zero: "0" }, target);
    expect(vars.set.mock.calls).toEqual([
      ["route", "a", target],
      ["empty", "", target],
      ["zero", "0", target],
    ]);
    expect(chat.onboardingDone).toBe(true);
    const question = { ...createOnboardingQuestion(), varName: "route" };
    vars.get.mockReturnValueOnce("0");
    expect(readFormAnswers([question], target)).toEqual({ route: "0" });
    expect(vars.get).toHaveBeenCalledWith("route", target);
  });
  it("only offers nonempty enabled onboarding and validates required multiple answers", () => {
    const char = {
      type: "character",
      onboarding: normalizeOnboarding({
        enabled: true,
        mode: "html",
        html: "<p>Pick a route</p>",
      }),
    } as character;
    expect(isOnboardingPending(char, {} as Chat)).toBe(true);
    expect(isOnboardingPending(char, { onboardingDone: true } as Chat)).toBe(
      false,
    );
    char.onboarding!.html = " ";
    expect(getActiveOnboarding(char)).toBeNull();
    expect(
      isQuestionAnswered(
        { ...createOnboardingQuestion(), type: "multiple", varName: "route" },
        { route: "[]" },
      ),
    ).toBe(false);
  });
});
