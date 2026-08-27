// @vitest-environment happy-dom

import { expect, test, vi } from "vitest";
import {
  defaultCBSRegisterArg,
  registerCBS,
  type matcherArg,
  type RegisterCallback,
} from "./cbs";

const selectedRoom = {
  type: "character",
  chaId: "selected",
  name: "Selected",
  nickname: "Selected Nick",
  desc: "selected-desc",
  chatPage: 0,
  chats: [
    {
      id: "selected-chat",
      fmIndex: -1,
      message: [{ role: "user", data: "selected-last" }],
      localLore: [{ comment: "selected-local" }],
    },
  ],
  globalLore: [{ comment: "selected-global" }],
  firstMessage: "selected-first",
  alternateGreetings: [],
};
const targetRoom = {
  type: "character",
  chaId: "target-room",
  name: "Target Room",
  nickname: "Target Room Nick",
  desc: "target-room-desc",
  chatPage: 0,
  chats: [
    { id: "unused", fmIndex: -1, message: [], localLore: [] },
    {
      id: "target-chat",
      fmIndex: -1,
      message: [{ role: "char", data: "target-last" }],
      localLore: [{ comment: "target-local" }],
    },
  ],
  globalLore: [{ comment: "room-global" }],
  firstMessage: "target-first",
  alternateGreetings: [],
};

const speaker = {
  type: "character",
  chaId: "speaker",
  name: "Speaker",
  nickname: "Speaker Nick",
  desc: "speaker-desc",
  globalLore: [{ comment: "speaker-global" }],
};
const callbacks = new Map<string, RegisterCallback>();
const getModuleLorebooks = vi.fn((room?: any) =>
  room?.chaId === "target-room"
    ? [
        {
          key: "",
          secondkey: "",
          insertorder: 0,
          comment: "target-module",
          content: "",
          mode: "normal" as const,
          alwaysActive: true,
          selective: false,
        },
      ]
    : [],
);

registerCBS({
  ...defaultCBSRegisterArg,
  registerFunction: ({ name, alias, callback }) => {
    if (callback === "doc_only") return;
    callbacks.set(name, callback);
    for (const item of alias) callbacks.set(item, callback);
  },
  getSettings: () => ({ promptTemplate: [] }) as any,
  getCharacters: () => [selectedRoom, targetRoom] as any,
  getSelectedCharID: () => 0,
  risuChatParser: (text) => text,
  makeArray: (items) => JSON.stringify(items),
  safeStructuredClone: (value) => structuredClone(value),
  getModuleLorebooks,
});

function run(name: string, overrides: Partial<matcherArg> = {}) {
  const callback = callbacks.get(name);
  if (!callback) throw new Error(`Missing CBS callback: ${name}`);
  const arg = {
    chatID: -1,
    db: { promptTemplate: [] },
    chara: speaker,
    rmVar: false,
    cbsConditions: {},
    chatTarget: { characterId: "target-room", chatId: "target-chat" },
    ...overrides,
  } as matcherArg;
  return callback(name, arg, [], null);
}

test("uses the explicit speaker for character variables", () => {
  expect(run("char")).toBe("Speaker Nick");
  expect(run("description")).toBe("speaker-desc");
});

test("uses the explicit room and chat for message context", () => {
  expect(run("lastmessage")).toBe("target-last");
  expect(run("lastmessageid")).toBe("0");
});

test("combines speaker, target chat, and target room module lore", () => {
  const encoded = run("lorebook") as string;
  const lore = (JSON.parse(encoded) as string[]).map((item) => JSON.parse(item));
  expect(lore.map((item) => item.comment)).toEqual([
    "speaker-global",
    "target-local",
    "target-module",
  ]);
  expect(getModuleLorebooks).toHaveBeenCalledWith(targetRoom);
});
