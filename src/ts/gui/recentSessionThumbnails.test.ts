import { describe, expect, it } from "vitest";
import { shouldEagerLoadRecentSessionThumbnails } from "./recentSessionThumbnails";

describe("shouldEagerLoadRecentSessionThumbnails", () => {
  it("keeps Capacitor recent-session avatars lazy by default", () => {
    expect(shouldEagerLoadRecentSessionThumbnails(true, undefined)).toBe(false);
    expect(shouldEagerLoadRecentSessionThumbnails(true, false)).toBe(false);
  });

  it("allows the Android advanced setting to opt back into eager loading", () => {
    expect(shouldEagerLoadRecentSessionThumbnails(true, true)).toBe(true);
  });

  it("preserves eager loading on non-Capacitor platforms", () => {
    expect(shouldEagerLoadRecentSessionThumbnails(false, undefined)).toBe(true);
    expect(shouldEagerLoadRecentSessionThumbnails(false, false)).toBe(true);
  });
});
