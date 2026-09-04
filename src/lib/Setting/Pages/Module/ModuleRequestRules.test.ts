import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ModuleRequestRules from "./ModuleRequestRules.svelte";
import type { RisuModule } from "src/ts/process/modules";
import { language } from "src/lang";
import {
  captureModuleRequest,
  clearModuleRequestCapture,
  setModuleRequestCapture,
} from "src/ts/process/moduleRequestCapture";

vi.mock("src/ts/stores/domain/moduleStore.svelte", () => ({
  moduleStore: {
    list: [
      { id: "owner", name: "Owner" },
      { id: "backend", name: "Backend" },
    ],
  },
}));

describe("module request rule editor", () => {
  let target: HTMLDivElement;
  let instance: ReturnType<typeof mount>;
  beforeEach(() => {
    clearModuleRequestCapture();
    setModuleRequestCapture(false);
    target = document.createElement("div");
    document.body.appendChild(target);
  });
  afterEach(async () => {
    if (instance) await unmount(instance);
    target.remove();
    setModuleRequestCapture(false);
    clearModuleRequestCapture();
  });
  const owner = (): RisuModule => ({
    id: "owner",
    name: "Owner",
    description: "",
    subModel: "owner-model",
  });

  it("creates a scoped rule from selected request text without calling a model", () => {
    setModuleRequestCapture(true);
    captureModuleRequest({
      sourceModuleId: "backend",
      activeModuleIds: ["owner", "backend"],
      messages: [{ role: "user", content: "unique output instruction" }],
      decision: { status: "unmatched", modules: [] },
    });
    const currentModule = owner();
    instance = mount(ModuleRequestRules, { target, props: { currentModule } });
    flushSync();
    const message = target.querySelector(
      "textarea[readonly]",
    ) as HTMLTextAreaElement;
    message.setSelectionRange(0, 13);
    message.dispatchEvent(new Event("select", { bubbles: true }));
    flushSync();
    const button = [...target.querySelectorAll("button")].find(
      (button) =>
        button.textContent === language.moduleRequestRules.fromSelection,
    )!;
    expect(button.disabled).toBe(false);
    button.click();
    flushSync();
    expect(currentModule.subModelRequestRules).toEqual([
      {
        enabled: true,
        phrases: ["unique output"],
        sourceModuleId: "backend",
        role: "user",
      },
    ]);
  });

  it("preserves multiline editing and maps role/source filters to stored rules", () => {
    const currentModule = {
      ...owner(),
      subModelRequestRules: [{ enabled: true, phrases: ["first"] }],
    };
    instance = mount(ModuleRequestRules, { target, props: { currentModule } });
    flushSync();
    const textarea = target.querySelector("textarea")!;
    textarea.value = "first\nsecond\n";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(currentModule.subModelRequestRules[0].phrases).toEqual([
      "first",
      "second",
      "",
    ]);
    const source = target.querySelector("select")!;
    source.value = "backend";
    source.dispatchEvent(new Event("change", { bubbles: true }));
    expect(currentModule.subModelRequestRules[0]).toMatchObject({
      sourceModuleId: "backend",
    });
  });

  it("does not show a potentially misleading preview for truncated prompts", () => {
    setModuleRequestCapture(true);
    captureModuleRequest({
      activeModuleIds: ["owner"],
      messages: [{ role: "user", content: "x".repeat(25000) }],
      decision: { status: "unmatched", modules: [] },
    });
    instance = mount(ModuleRequestRules, {
      target,
      props: { currentModule: owner() },
    });
    flushSync();
    expect(target.textContent).toContain(language.moduleRequestRules.truncated);
    expect(target.textContent).not.toContain(
      language.moduleRequestRules.preview + ":",
    );
  });
});
