import { afterEach, expect, it, vi } from "vitest";
import { illustrationViewer } from "./illustrationViewer";

let action: ReturnType<typeof illustrationViewer>;
let button: HTMLButtonElement;

afterEach(() => {
  action?.destroy();
  button?.remove();
});

it("opens the real modal, closes with Escape or its button and restores scrolling", async () => {
  button = document.createElement("button");
  const image = document.createElement("img");
  // Avoid happy-dom's synchronous data-URL load events; browsers load asynchronously.
  image.src = "blob:illustration";
  button.append(image);
  document.body.append(button);
  action = illustrationViewer(button);
  button.click();
  await vi.dynamicImportSettled();
  expect(document.querySelector(".viewer-container")).not.toBeNull();
  expect(document.body.classList.contains("viewer-open")).toBe(true);
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }),
  );
  expect(document.querySelector(".viewer-container")).toBeNull();
  expect(document.body.classList.contains("viewer-open")).toBe(false);
  expect(document.activeElement).toBe(button);
  button.click();
  await vi.dynamicImportSettled();
  document.querySelector<HTMLButtonElement>(".viewer-button")!.click();
  expect(document.querySelector(".viewer-container")).toBeNull();
  expect(document.body.classList.contains("viewer-open")).toBe(false);
  button.click();
  await vi.dynamicImportSettled();
  action.destroy();
  expect(document.querySelector(".viewer-container")).toBeNull();
  expect(document.body.classList.contains("viewer-open")).toBe(false);
});
