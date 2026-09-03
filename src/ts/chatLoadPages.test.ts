import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  LOW_SPEC_CHAT_LOAD_ADDITIONAL_PAGES,
  LOW_SPEC_CHAT_LOAD_INITIAL_PAGES,
  getAbsoluteChatMessageIndex,
  getAdditionalChatLoadPages,
  getInitialChatLoadPages,
  normalizeChatLoadPages,
} from "./chatLoadPages";

describe("normalizeChatLoadPages", () => {
  it("keeps positive finite counts as integers", () => {
    expect(normalizeChatLoadPages(42, DEFAULT_CHAT_LOAD_INITIAL_PAGES)).toBe(
      42,
    );
    expect(normalizeChatLoadPages(7.9, DEFAULT_CHAT_LOAD_INITIAL_PAGES)).toBe(
      7,
    );
  });

  it("falls back for invalid counts", () => {
    expect(normalizeChatLoadPages(0, DEFAULT_CHAT_LOAD_INITIAL_PAGES)).toBe(
      DEFAULT_CHAT_LOAD_INITIAL_PAGES,
    );
    expect(normalizeChatLoadPages(-1, DEFAULT_CHAT_LOAD_INITIAL_PAGES)).toBe(
      DEFAULT_CHAT_LOAD_INITIAL_PAGES,
    );
    expect(
      normalizeChatLoadPages(Infinity, DEFAULT_CHAT_LOAD_INITIAL_PAGES),
    ).toBe(DEFAULT_CHAT_LOAD_INITIAL_PAGES);
    expect(
      normalizeChatLoadPages(Number.NaN, DEFAULT_CHAT_LOAD_INITIAL_PAGES),
    ).toBe(DEFAULT_CHAT_LOAD_INITIAL_PAGES);
    expect(normalizeChatLoadPages("", DEFAULT_CHAT_LOAD_INITIAL_PAGES)).toBe(
      DEFAULT_CHAT_LOAD_INITIAL_PAGES,
    );
  });

  it("uses built-in defaults for chat load settings", () => {
    expect(getInitialChatLoadPages({})).toBe(DEFAULT_CHAT_LOAD_INITIAL_PAGES);
    expect(getInitialChatLoadPages({ chatLoadInitialPages: 12 })).toBe(12);
    expect(getAdditionalChatLoadPages({})).toBe(
      DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
    );
    expect(getAdditionalChatLoadPages({ chatLoadAdditionalPages: 8 })).toBe(8);
    expect(getInitialChatLoadPages({ lowSpecMode: true })).toBe(
      LOW_SPEC_CHAT_LOAD_INITIAL_PAGES,
    );
    expect(getAdditionalChatLoadPages({ lowSpecMode: true })).toBe(
      LOW_SPEC_CHAT_LOAD_ADDITIONAL_PAGES,
    );
    expect(
      getInitialChatLoadPages({ chatLoadInitialPages: 40, lowSpecMode: true }),
    ).toBe(LOW_SPEC_CHAT_LOAD_INITIAL_PAGES);
    expect(
      getAdditionalChatLoadPages({
        chatLoadAdditionalPages: 40,
        lowSpecMode: true,
      }),
    ).toBe(LOW_SPEC_CHAT_LOAD_ADDITIONAL_PAGES);
  });
});

describe("getAbsoluteChatMessageIndex", () => {
  it("keeps full-chat indexes unchanged when there is no page offset", () => {
    expect(getAbsoluteChatMessageIndex(5, 0)).toBe(5);
    expect(getAbsoluteChatMessageIndex(5, undefined)).toBe(5);
  });

  it("adds the SQL page offset for script-visible chat indexes", () => {
    expect(getAbsoluteChatMessageIndex(0, 40)).toBe(40);
    expect(getAbsoluteChatMessageIndex(15, 40)).toBe(55);
  });

  it("preserves synthetic negative message indexes", () => {
    expect(getAbsoluteChatMessageIndex(-1, 40)).toBe(-1);
  });
});
