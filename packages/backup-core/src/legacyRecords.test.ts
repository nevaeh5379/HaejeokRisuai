import { describe, expect, it } from "vitest";
import { iterateLegacyBackupSqlRecords } from "./legacyRecords";

function ids() {
  let index = 0;
  return () => `generated-${++index}`;
}

describe("iterateLegacyBackupSqlRecords", () => {
  it("converts a linear legacy database into branch-aware SQL records", () => {
    const records = [
      ...iterateLegacyBackupSqlRecords(
        {
          language: "ko",
          pluginCustomStorage: { plugin: { enabled: true } },
          modules: [{ id: "module-1", name: "M" }],
          botPresets: [{ name: "Preset" }],
          botPresetsId: 0,
          characters: [
            {
              chaId: "char-1",
              name: "A",
              chats: [
                {
                  id: "chat-1",
                  name: "Main",
                  message: [
                    { chatId: "m1", role: "user", data: "one" },
                    { chatId: "m2", role: "char", data: "two" },
                  ],
                },
              ],
            },
          ],
        },
        { idFactory: ids(), sourceRevision: 0 },
      ),
    ];

    expect(records.map((record) => record.type)).toEqual([
      "meta",
      "setting",
      "setting",
      "plugin-storage",
      "module",
      "preset",
      "character",
      "chat",
      "branch",
      "active-branch",
      "message",
      "message",
    ]);
    expect(
      records.find(
        (record) =>
          record.type === "setting" &&
          record.key === "activeBotPresetId",
      ),
    ).toMatchObject({ value: "generated-1" });
    const branch = records.find((record) => record.type === "branch");
    expect(branch).toMatchObject({
      chatId: "chat-1",
      data: { id: "root", headMessageId: "m2" },
    });
    const messages = records.filter((record) => record.type === "message");
    expect(messages).toMatchObject([
      {
        id: "m1",
        position: 0,
        originBranchId: "root",
      },
      {
        id: "m2",
        position: 1,
        parentMessageId: "m1",
        originBranchId: "root",
      },
    ]);
  });

  it("preserves portable branch graph records", () => {
    const records = [
      ...iterateLegacyBackupSqlRecords(
        {
          characters: [
            {
              chaId: "char-1",
              chats: [
                {
                  id: "chat-1",
                  name: "Chat",
                  message: [
                    { chatId: "m1", role: "user", data: "one" },
                    { chatId: "m2", role: "char", data: "root" },
                  ],
                },
              ],
            },
          ],
          haejeokBranchGraphs: {
            "chat-1": {
              branches: [
                {
                  id: "root",
                  chatId: "chat-1",
                  reason: "root",
                  createdAt: 0,
                  headMessageId: "m2",
                },
                {
                  id: "reroll",
                  chatId: "chat-1",
                  parentBranchId: "root",
                  forkMessageId: "m1",
                  reason: "reroll",
                  createdAt: 1,
                  headMessageId: "m3",
                },
              ],
              activeBranchId: "reroll",
              messages: [
                { chatId: "m1", role: "user", data: "one" },
                { chatId: "m2", role: "char", data: "root" },
                { chatId: "m3", role: "char", data: "alt" },
              ],
              links: [
                {
                  messageId: "m1",
                  originBranchId: "root",
                },
                {
                  messageId: "m2",
                  parentMessageId: "m1",
                  originBranchId: "root",
                },
                {
                  messageId: "m3",
                  parentMessageId: "m1",
                  originBranchId: "reroll",
                },
              ],
            },
          },
        },
        { idFactory: ids() },
      ),
    ];

    expect(records.filter((record) => record.type === "branch")).toHaveLength(
      2,
    );
    expect(
      records.find((record) => record.type === "active-branch"),
    ).toMatchObject({ branchId: "reroll" });
    expect(
      records.filter((record) => record.type === "message").map((record) => ({
        id: "id" in record ? record.id : "",
        origin:
          "originBranchId" in record ? record.originBranchId : "",
      })),
    ).toEqual([
      { id: "m1", origin: "root" },
      { id: "m2", origin: "root" },
      { id: "m3", origin: "reroll" },
    ]);
  });
});
