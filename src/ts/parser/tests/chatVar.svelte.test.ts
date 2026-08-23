import fc from "fast-check";
import { writable } from "svelte/store";
import { beforeEach, expect, test, vi } from "vitest";
import { characterStore } from "../../stores/domain/characterStore.svelte";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { getChatVar, getGlobalChatVar, setChatVar } from "../chatVar.svelte";
import { resetChatVariables } from "./cbs/lib";

//#region module mocks

vi.mock(
  import("../../storage/database.svelte"),
  () =>
    ({
      appVer: "1234.5.67",
      getCurrentCharacter: () => ({}),
      getDatabase: () => ({}),
    }) as typeof import("../../storage/database.svelte"),
);

vi.mock(import("../../globalApi.svelte"), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(""),
}));

vi.mock(import("../../stores/domain/characterStore.svelte"), () => {
  return {
    characterStore: {
      characters: [
        {
          chatPage: 0,
          chats: [
            {
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
