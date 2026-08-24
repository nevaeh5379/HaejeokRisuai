import { describe, expect, it } from "vitest";
import {
  vectorContentSignature,
  vectorDescriptorRevision,
  vectorTextRevision,
} from "./vectorIndexSignature";

describe("vectorIndexSignature", () => {
  it("matches positional text and descriptor revisions", () => {
    const texts = ["alpha", "beta", "gamma"];
    const descriptors = texts.map((text, index) => ({
      id: String(index),
      signature: vectorContentSignature(text),
    }));

    expect(vectorTextRevision(texts)).toBe(
      vectorDescriptorRevision(descriptors),
    );
  });

  it("changes revision when content or order changes", () => {
    const baseline = vectorTextRevision(["alpha", "beta"]);
    expect(vectorTextRevision(["alpha", "changed"])).not.toBe(baseline);
    expect(vectorTextRevision(["beta", "alpha"])).not.toBe(baseline);
  });
});
