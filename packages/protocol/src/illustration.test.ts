import { describe, test } from "vitest";
import { findIllustrationMarkers } from "./illustration.ts";
describe("what is that", () => {
  test("", () => {
    console.log(findIllustrationMarkers("hello <Illustration>"));
  });
});
