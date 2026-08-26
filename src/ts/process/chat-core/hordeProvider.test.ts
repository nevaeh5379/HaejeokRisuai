import { describe, expect, it } from "vitest";
import {
  STABLE_HORDE_TEXT_ASYNC_URL,
  buildStableHordeStatusUrl,
} from "@risuai/chat-core/hordeProvider.cjs";

describe("Stable Horde provider", () => {
  it("pins submit and status endpoints", () => {
    expect(STABLE_HORDE_TEXT_ASYNC_URL).toBe(
      "https://stablehorde.net/api/v2/generate/text/async",
    );
    expect(buildStableHordeStatusUrl("job/with spaces")).toBe(
      "https://stablehorde.net/api/v2/generate/text/status/job%2Fwith%20spaces",
    );
  });

  it("rejects invalid generation ids", () => {
    expect(buildStableHordeStatusUrl("")).toBeNull();
    expect(buildStableHordeStatusUrl("x".repeat(257))).toBeNull();
  });
});
