import fc from "fast-check";
import { writable } from "svelte/store";
import { beforeEach, expect, test, vi } from "vitest";
import { characterStore } from "../../stores/domain/characterStore.svelte";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import {
  getChatVar,
  getGlobalChatVar,
  isLocallyHandledGlobalChatVar,
  removeLocallyHandledGlobalChatVar,
  setChatVar,
  setGlobalChatVar,
} from "../chatVar.svelte";
import { resetChatVariables } from "./cbs/lib";

//#region module mocks

vi.mock(import("../../globalApi.svelte"), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(""),
}));

vi.mock(import("../../stores/domain/characterStore.svelte"), () => {
  return {
    characterStore: {
      selectedId: 0,
      characters: [
        {
          chaId: "char-selected",
          chatPage: 0,
          chats: [
            {
              id: "chat-selected",
              scriptstate: {},
            },
          ],
          defaultVariables: "",
        },
      ],
    },
  } as any;
});

vi.mock(import("../../stores/domain/settingsStore.svelte"), () => {
  return {
    settingsStore: {
      state: {
        globalChatVariables: {},
        templateDefaultVariables: "",
      },
    },
  } as any;
});

vi.mock(import("../../stores.svelte"), () => {
  return {
    selIdState: {
      selId: 0,
    },
    selectedCharID: writable(0),
  } as any;
});

//#endregion

const anyValidDefaultVarKey = fc
  .string({ minLength: 1, unit: "grapheme" })
  .filter((s) => !/[=\n]/.test(s));
const anyValidDefaultVarValue = fc
  .anything()
  .map(JSON.stringify)
  .filter((s) => s !== undefined && !/[=\n]/.test(s));

beforeEach(() => {
  vi.resetAllMocks();
  resetChatVariables();
  characterStore.characters.splice(1);
  const chat = characterStore.characters[0].chats[0];
  chat.scriptstate = {};
  chat.GLGlobalVariables = {};
  chat.useLocallySetGlobalVariables = false;
  settingsStore.state.globalChatVariables = {};
});

test("can get a character default variable", () => {
  fc.assert(
    fc.property(
      anyValidDefaultVarKey,
      anyValidDefaultVarValue,
      (key, value) => {
        characterStore.characters[0].defaultVariables = `${key}=${value}`;
        expect(getChatVar(key)).toBe(value);
      },
    ),
  );
});

test("can get a template default variable", () => {
  fc.assert(
    fc.property(
      anyValidDefaultVarKey,
      anyValidDefaultVarValue,
      (key, value) => {
        settingsStore.state.templateDefaultVariables = `${key}=${value}`;
        expect(getChatVar(key)).toBe(value);
      },
    ),
  );
});

test("can set and get a chat variable", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "grapheme" }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        setChatVar(key, value);
        expect(getChatVar(key)).toBe(value);
      },
    ),
  );
});

test("can target chat variables without following the selected character", () => {
  characterStore.characters.push({
    chaId: "char-target",
    chatPage: 0,
    chats: [
      { id: "chat-other", scriptstate: { $scope: "other" } },
      { id: "chat-target", scriptstate: { $scope: "target" } },
    ],
    defaultVariables: "",
  } as any);

  const target = { characterId: "char-target", chatId: "chat-target" };
  expect(getChatVar("scope", target)).toBe("target");
  expect(setChatVar("scope", "updated", target)).toBe(true);
  expect(getChatVar("scope", target)).toBe("updated");
  expect(getChatVar("scope")).toBe("null");
});

test("can set a chat variable over its default value", () => {
  characterStore.characters[0].defaultVariables = "char=default";
  settingsStore.state.templateDefaultVariables = "template=default";

  setChatVar("char", "overridden");
  setChatVar("template", "overridden");

  expect(getChatVar("char")).toBe("overridden");
  expect(getChatVar("template")).toBe("overridden");
});

test("can get a global chat variable", () => {
  fc.assert(
    fc.property(
      fc.string({ unit: "grapheme" }),
      fc
        .anything()
        .filter((v) => v !== undefined)
        .map(JSON.stringify),
      (key, value) => {
        settingsStore.state.globalChatVariables[`toggle_${key}`] = value;

        expect(getGlobalChatVar(`toggle_${key}`)).toBe(value);
      },
    ),
  );
});

test('returns "null" for undefined variables', () => {
  fc.assert(
    fc.property(fc.string({ unit: "grapheme" }), (key) => {
      expect(getChatVar(key)).toBe("null");
      expect(getGlobalChatVar(`toggle_${key}`)).toBe("null");
    }),
  );
});

test("stores toggle values in the current chat when local toggles are enabled", () => {
  const chat = characterStore.characters[0].chats[0];
  settingsStore.state.globalChatVariables.toggle_demo = "global";
  chat.useLocallySetGlobalVariables = true;

  expect(setGlobalChatVar("toggle_demo", "0")).toBe(true);
  expect(getGlobalChatVar("toggle_demo")).toBe("0");
  expect(isLocallyHandledGlobalChatVar("toggle_demo")).toBe(true);
  expect(settingsStore.state.globalChatVariables.toggle_demo).toBe("global");

  expect(setGlobalChatVar("toggle_demo", "")).toBe(true);
  expect(getGlobalChatVar("toggle_demo")).toBe("");
});

test("removing a local toggle falls back to the global value", () => {
  const chat = characterStore.characters[0].chats[0];
  settingsStore.state.globalChatVariables.toggle_demo = "global";
  chat.useLocallySetGlobalVariables = true;
  setGlobalChatVar("toggle_demo", "local");

  expect(removeLocallyHandledGlobalChatVar("toggle_demo")).toBe(true);
  expect(isLocallyHandledGlobalChatVar("toggle_demo")).toBe(false);
  expect(getGlobalChatVar("toggle_demo")).toBe("global");
});

test("writing globally clears an existing local override", () => {
  const chat = characterStore.characters[0].chats[0];
  chat.useLocallySetGlobalVariables = true;
  setGlobalChatVar("toggle_demo", "local");

  chat.useLocallySetGlobalVariables = false;
  expect(setGlobalChatVar("toggle_demo", "new-global")).toBe(true);
  expect(isLocallyHandledGlobalChatVar("toggle_demo")).toBe(false);
  expect(getGlobalChatVar("toggle_demo")).toBe("new-global");
});
