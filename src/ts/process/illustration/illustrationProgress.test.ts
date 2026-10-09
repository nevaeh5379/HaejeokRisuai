import { describe, expect, it } from "vitest";
import {
  prepareIllustrations,
  type Illustration,
  type IllustrationMessage,
} from "@risuai/protocol/src/illustration.ts";
import {
  applyIllustrationProgress,
  preserveIllustrationProgress,
} from "./illustrationProgress";

function fixture() {
  const message: IllustrationMessage = {
    chatId: "message",
    role: "char",
    data: "Scene.<Illustration>",
  };
  const [item] = prepareIllustrations(message, "branch", "server", "run");
  const first: Illustration = {
    ...item,
    token: "{{inlay::first}}",
    imageId: "first",
    imageIds: ["first"],
    status: "generating",
    progress: 3,
  };
  return { message, first };
}

describe("committed illustration progress", () => {
  it("preserves the latest image when a delayed full chat refresh replaces the message array", () => {
    const { message, first } = fixture();
    const delayed = structuredClone(message);
    applyIllustrationProgress(message, first, "branch");
    preserveIllustrationProgress([message], [delayed], "branch");
    expect(delayed.data).toBe(message.data);
    expect(delayed.illustrations![0].imageId).toBe("first");
    expect(delayed.illustrations![0].progress).toBe(3);
  });
  it("does not override a newer server snapshot or another edited scene during full chat refresh", () => {
    const { message, first } = fixture();
    applyIllustrationProgress(message, first, "branch");
    const newer = structuredClone(message);
    newer.illustrations![0].progress = 5;
    newer.illustrations![0].status = "complete";
    const edited = structuredClone(message);
    edited.data += "new scene";
    preserveIllustrationProgress([message], [newer, edited], "branch");
    expect(newer.illustrations![0].progress).toBe(5);
    expect(newer.illustrations![0].status).toBe("complete");
    expect(edited.data).toContain("new scene");
  });
  it("shows the first saved image immediately while the rest of the batch is running", () => {
    const { message, first } = fixture();
    expect(applyIllustrationProgress(message, first, "branch")).toBe(true);
    expect(message.data).toBe("Scene.{{inlay::first}}");
    expect(message.illustrations![0].status).toBe("generating");
  });
  it("rejects an older polling result after a newer SSE snapshot, including equal image counts", () => {
    const { message, first } = fixture();
    applyIllustrationProgress(message, first, "branch");
    expect(
      applyIllustrationProgress(
        message,
        { ...first, status: "tagging", progress: 2 },
        "branch",
      ),
    ).toBe(false);
    expect(message.illustrations![0]).toBe(first);
    const second: Illustration = {
      ...first,
      token: "{{inlay::second}}",
      imageId: "second",
      imageIds: ["first", "second"],
      progress: 7,
    };
    applyIllustrationProgress(message, second, "branch");
    expect(applyIllustrationProgress(message, first, "branch")).toBe(false);
    expect(message.data).toBe("Scene.{{inlay::second}}");
  });
  it.each(["edit", "branch", "version", "token"])(
    "does not overwrite progress invalidated by %s",
    (kind) => {
      const { message, first } = fixture();
      if (kind === "edit") message.data += "user edit";
      if (kind === "token") message.data = "Removed illustration";
      if (kind === "version") message.illustrations![0].version++;
      const before = structuredClone(message);
      expect(
        applyIllustrationProgress(
          message,
          first,
          kind === "branch" ? "other" : "branch",
        ),
      ).toBe(false);
      expect(message).toEqual(before);
    },
  );
});
