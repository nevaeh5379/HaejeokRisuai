import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ComfyWorkflowJson from "./ComfyWorkflowJson.svelte";

vi.mock(
  "src/lib/UI/GUI/TextAreaInput.svelte",
  async () => import("src/lib/UI/GUI/TextInput.svelte"),
);

describe("ComfyUI workflow JSON view", () => {
  let target: HTMLDivElement;
  let instance: ReturnType<typeof mount>;
  function render(workflow: string) {
    target = document.createElement("div");
    document.body.appendChild(target);
    instance = mount(ComfyWorkflowJson, { target, props: { workflow } });
    flushSync();
  }
  afterEach(async () => {
    await unmount(instance);
    target.remove();
  });
  const toggle = () =>
    target.querySelector<HTMLButtonElement>("button[aria-pressed]")!;

  it("renders a collapsible tree, with nested nodes initially collapsed", () => {
    render(
      JSON.stringify({
        "1": { class_type: "Text", inputs: { text: "{{risu_prompt}}" } },
      }),
    );
    expect(target.querySelector('[role="tree"]')).not.toBeNull();
    expect(target.querySelector("input")).toBeNull();
    expect(target.textContent).not.toContain("class_type");
    target
      .querySelector<HTMLElement>('[role="button"][aria-expanded="false"]')!
      .click();
    flushSync();
    expect(target.textContent).toContain("class_type");
    expect(target.textContent).toContain("Text");
  });

  it("preserves raw editing and displays the changed JSON after returning to the tree", () => {
    render('{"text":"old"}');
    toggle().click();
    flushSync();
    expect(target.querySelector('[role="tree"]')).toBeNull();
    const input = target.querySelector<HTMLInputElement>("input")!;
    input.value = '{"text":"{{risu_prompt}}"}';
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    toggle().click();
    flushSync();
    expect(target.querySelector('[role="tree"]')?.textContent).toContain(
      "{{risu_prompt}}",
    );
  });

  it("keeps invalid edits available for correction and opens empty workflows in the editor", () => {
    render("");
    const input = target.querySelector<HTMLInputElement>("input")!;
    input.value = "{";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    toggle().click();
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "valid workflow JSON",
    );
    expect(input.value).toBe("{");
    expect(target.querySelector('[role="tree"]')).toBeNull();
  });
});
