import { Buffer as BufferPolyfill } from "node:buffer";
import rfdc from "rfdc";
import { isIOS } from "./platform";
/**
 * Polyfill for structuredClone.
 * Falls back to rfdc (Really Fast Deep Clone) if structuredClone throws an error.
 */

const rfdcClone = rfdc({
  circles: false,
});
export function safeStructuredClone<T>(data: T): T {
  try {
    return structuredClone(data);
  } catch (error) {
    return rfdcClone(data);
  }
}

try {
  const testDom = document.createElement("div");
  const supports =
    "draggable" in testDom || ("ondragstart" in testDom && "ondrop" in testDom);
  testDom.remove();

  if (!supports || isIOS()) {
    globalThis.polyfilledDragDrop = true;
    void Promise.all([
      import("mobile-drag-drop"),
      import("mobile-drag-drop/scroll-behaviour"),
    ]).then(([{ polyfill }, { scrollBehaviourDragImageTranslateOverride }]) => {
      polyfill({
        dragImageTranslateOverride: scrollBehaviourDragImageTranslateOverride,
        forceApply: true,
      });
    });
  }
} catch (error) {}

globalThis.safeStructuredClone = safeStructuredClone;

globalThis.Buffer ??= BufferPolyfill;

if (
  !globalThis.ReadableStream ||
  !globalThis.WritableStream ||
  !globalThis.TransformStream
) {
  void import("web-streams-polyfill").then(
    ({ ReadableStream, WritableStream, TransformStream }) => {
      globalThis.WritableStream ??= WritableStream;
      // @ts-expect-error ponyfill stream types differ slightly from the DOM declarations
      globalThis.ReadableStream ??= ReadableStream;
      // @ts-expect-error ponyfill stream types differ slightly from the DOM declarations
      globalThis.TransformStream ??= TransformStream;
    },
  );
}
