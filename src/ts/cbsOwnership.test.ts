// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it } from "vitest";
import {
  defaultCBSRegisterArg,
  registerCBS,
  type RegisterCallback,
} from "./cbs";
import { settingsStore } from "./stores/domain/settingsStore.svelte";
import { presetStore } from "./stores/domain/presetStore.svelte";

const callbacks = new Map<string, RegisterCallback>();
registerCBS({
  ...defaultCBSRegisterArg,
  registerFunction: ({ name, callback }) => {
    if (callback !== "doc_only") callbacks.set(name, callback);
  },
  getSettings: () => settingsStore.state,
  getPresetSettings: () => presetStore.state,
});

function run(name: string, ...args: string[]) {
  return callbacks.get(name)!(
    "",
    {
      chatID: -1,
      db: settingsStore.state,
      chara: "test",
      rmVar: false,
      cbsConditions: {},
    },
    args,
    null,
  );
}

beforeEach(() => {
  settingsStore.init({ language: "ko", jailbreakToggle: true }, null);
  settingsStore.releasePresetOwnedState();
  presetStore.resetForTesting();
  Object.assign(presetStore.state, {
    mainPrompt: "main",
    jailbreak: "jailbreak",
    globalNote: "note",
    aiModel: "claude-test",
    subModel: "sub-test",
    maxContext: 4096,
    promptTemplate: [{ type: "authornote", defaultText: "author note" }],
  });
});
afterEach(() => {
  settingsStore.dispose();
  presetStore.resetForTesting();
});

it("routes prompt and model CBS values to PresetStore", () => {
  for (const [name, value] of Object.entries({
    mainprompt: "main",
    jb: "jailbreak",
    globalnote: "note",
    authornote: "author note",
    model: "claude-test",
    axmodel: "sub-test",
    maxcontext: "4096",
    prefillsupported: "1",
  }))
    expect(run(name), name).toBe(value);
  presetStore.state.mainPrompt = "changed";
  expect(run("mainprompt")).toBe("changed");
});

it("keeps general and preset metadata in their own domains", () => {
  expect(run("metadata", "language")).toBe("ko");
  expect(run("metadata", "maxcontext")).toBe("4096");
  expect(run("jbtoggled")).toBe("1");
});
