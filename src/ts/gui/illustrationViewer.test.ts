import { afterEach, expect, it, vi } from "vitest";
import type Viewer from "viewerjs";
import { illustrationViewer } from "./illustrationViewer";

const { create, show, destroy } = vi.hoisted(() => ({
  create: vi.fn(),
  show: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("viewerjs", () => ({
  default: class {
    constructor(image: HTMLImageElement, options: Viewer.Options) {
      create(image, options);
    }
    show = show;
    destroy = destroy;
  },
}));

let action: ReturnType<typeof illustrationViewer>;
let parent: HTMLDivElement;

function setup() {
  parent = document.createElement("div");
  const button = document.createElement("button");
  const image = document.createElement("img");
  image.src = "blob:illustration";
  button.append(image);
  parent.append(button);
  document.body.append(parent);
  action = illustrationViewer(button);
  return { button, image };
}

afterEach(() => {
  action?.destroy();
  parent?.remove();
  vi.clearAllMocks();
});

it("loads only on click, prevents message editing and releases the viewer on close", async () => {
  const { button, image } = setup();
  const edit = vi.fn();
  parent.addEventListener("click", edit);
  parent.addEventListener("pointerdown", edit);
  expect(create).not.toHaveBeenCalled();
  button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  button.click();
  button.click();
  await vi.dynamicImportSettled();
  expect(edit).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0]).toBe(image);
  expect(show).toHaveBeenCalledTimes(1);
  button.click();
  expect(create).toHaveBeenCalledTimes(1);
  const options = create.mock.calls[0][1];
  options.hidden();
  expect(destroy).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button);
  button.click();
  await vi.dynamicImportSettled();
  expect(create).toHaveBeenCalledTimes(2);
  action.destroy();
  expect(destroy).toHaveBeenCalledTimes(2);
});

it("destroys an open viewer when its image is removed", async () => {
  const { button } = setup();
  button.click();
  await vi.dynamicImportSettled();
  action.destroy();
  expect(destroy).toHaveBeenCalledTimes(1);
});

it("does not open a viewer after disposal during lazy loading", async () => {
  const { button } = setup();
  button.click();
  action.destroy();
  await vi.dynamicImportSettled();
  expect(create).not.toHaveBeenCalled();
  expect(show).not.toHaveBeenCalled();
});
