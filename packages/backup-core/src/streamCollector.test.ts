import { describe, expect, it } from "vitest";
import { PortableDatabaseStreamCollector } from "./streamCollector";
import {
  PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  type PortableDatabaseStreamFragment,
  type PortableDatabaseStreamManifest,
} from "./streamFormat";
import type { LegacyBackupSqlRecord } from "./legacyRecords";

type StreamRecord = LegacyBackupSqlRecord;

function fragment(
  index: number,
  records: StreamRecord[],
): PortableDatabaseStreamFragment {
  return {
    format: "risu-portable-database-fragment",
    version: 1,
    index,
    records,
  };
}

function manifest(
  overrides: Partial<PortableDatabaseStreamManifest> = {},
): PortableDatabaseStreamManifest {
  return {
    format: "risu-portable-database-stream",
    version: 1,
    revision: 7,
    totalFragments: 1,
    totalRecords: 0,
    counts: {},
    complete: true,
    ...overrides,
  };
}

function feed(
  collector: PortableDatabaseStreamCollector,
  records: StreamRecord[],
): void {
  collector.addFragment(fragment(1, records));
  const counts: Partial<Record<string, number>> = {};
  let revision = manifest().revision;
  for (const record of records) {
    counts[record.type] = (counts[record.type] ?? 0) + 1;
    if (record.type === "meta" && typeof record.revision === "number") {
      revision = record.revision;
    }
  }
  collector.setManifest({
    ...manifest(),
    revision,
    totalRecords: records.length,
    counts: counts as PortableDatabaseStreamManifest["counts"],
  });
}

function collect(records: StreamRecord[]): Record<string, any> {
  const collector = new PortableDatabaseStreamCollector();
  feed(collector, records);
  return collector.finish();
}

function character(id: string, position = 0, data: Record<string, any> = {}) {
  return { type: "character", position, id, data } as StreamRecord;
}

function chat(id: string, characterId: string, position = 0) {
  return { type: "chat", position, characterId, id, data: {} } as StreamRecord;
}

function branch(chatId: string, id: string, reason = "manual") {
  return { type: "branch", chatId, data: { id, reason } } as StreamRecord;
}

function message(
  chatId: string,
  id: string,
  position: number,
  data: Record<string, any> = {},
  extra: Partial<StreamRecord> = {},
) {
  return {
    type: "message",
    chatId,
    id,
    position,
    originBranchId: "root",
    data,
    ...extra,
  } as StreamRecord;
}

describe("PortableDatabaseStreamCollector reconstruction", () => {
  it("reconstructs settings, plugin storage, and position ordering", () => {
    const restored = collect([
      { type: "meta", formatVersion: 1, revision: 7 },
      { type: "setting", key: "personas", value: [{ name: "User" }] },
      { type: "setting", key: "activeBotPresetId", value: "preset-2" },
      { type: "plugin-storage", key: "plugin-1", value: { retained: true } },
      {
        type: "module",
        position: 2,
        id: "module-2",
        data: { name: "Second" },
      },
      {
        type: "module",
        position: 0,
        id: "module-0",
        data: { name: "First" },
      },
      {
        type: "preset",
        position: 1,
        id: "preset-2",
        data: { name: "Preset Two" },
      },
      {
        type: "preset",
        position: 0,
        id: "preset-1",
        data: { name: "Preset One" },
      },
    ]);

    expect(restored.personas).toEqual([{ name: "User" }]);
    expect(restored.pluginCustomStorage).toEqual({
      "plugin-1": { retained: true },
    });
    expect(restored.modules.map((m: any) => m.name)).toEqual([
      "First",
      "Second",
    ]);
    expect(restored.botPresets.map((p: any) => p.name)).toEqual([
      "Preset One",
      "Preset Two",
    ]);
    expect(restored.botPresetsId).toBe(1);
  });

  it("falls back to index 0 for an unknown or non-string active preset id", () => {
    const unknown = collect([
      { type: "meta", formatVersion: 1, revision: 7 },
      { type: "setting", key: "activeBotPresetId", value: "missing" },
      { type: "preset", position: 0, id: "preset-a", data: { name: "A" } },
    ]);
    expect(unknown.botPresetsId).toBe(0);

    const numeric = collect([
      { type: "meta", formatVersion: 1, revision: 7 },
      { type: "setting", key: "activeBotPresetId", value: 5 },
      { type: "preset", position: 0, id: "preset-a", data: { name: "A" } },
    ]);
    expect(numeric.botPresetsId).toBe(0);
  });

  it("reconstructs characters, ordered chats, and the native branch graph", () => {
    const restored = collect([
      { type: "meta", formatVersion: 1, revision: 3 },
      character("cha-1", 0, { name: "Alice", coldstorage: "cold-1" }),
      chat("chat-1", "cha-1"),
      branch("chat-1", "root", "root"),
      branch("chat-1", "b2"),
      {
        type: "active-branch",
        chatId: "chat-1",
        branchId: "b2",
      } as StreamRecord,
      message("chat-1", "msg-2", 1, { data: "second" }, {
        originBranchId: "b2",
      } as Partial<StreamRecord>),
      message("chat-1", "msg-1", 0, { data: "first" }, {
        originBranchId: "root",
      } as Partial<StreamRecord>),
    ]);

    const characterEntry = restored.characters[0];
    expect(characterEntry.chaId).toBe("cha-1");
    expect(characterEntry.name).toBe("Alice");
    expect(characterEntry.coldstorage).toBe("cold-1");
    expect(characterEntry.detailsLoaded).toBe(true);
    expect(characterEntry.chats).toHaveLength(1);

    const chatRecord = characterEntry.chats[0];
    expect(chatRecord.id).toBe("chat-1");
    expect(chatRecord.message).toEqual([]);
    expect(chatRecord.messageOffset).toBe(0);
    expect(chatRecord.messageTotal).toBe(0);
    expect(chatRecord.messagesLoaded).toBe(true);
    expect(chatRecord.messagesFullyLoaded).toBe(true);
    expect(chatRecord.detailsLoaded).toBe(true);

    const graph = restored.haejeokBranchGraphs["chat-1"];
    expect(graph.branches).toEqual([
      { id: "root", reason: "root" },
      { id: "b2", reason: "manual" },
    ]);
    expect(graph.activeBranchId).toBe("b2");
    expect(graph.messages.map((m: any) => m.data)).toEqual(["first", "second"]);
    expect(graph.messages[0].chatId).toBe("msg-1");
    expect(graph.links).toEqual([
      {
        messageId: "msg-1",
        position: 0,
        parentMessageId: undefined,
        originBranchId: "root",
      },
      {
        messageId: "msg-2",
        position: 1,
        parentMessageId: undefined,
        originBranchId: "b2",
      },
    ]);
  });

  it("orders multiple characters by position regardless of arrival order", () => {
    const restored = collect([
      { type: "meta", formatVersion: 1, revision: 1 },
      character("cha-b", 5, { name: "B" }),
      character("cha-a", 1, { name: "A" }),
    ]);
    expect(restored.characters.map((c: any) => c.name)).toEqual(["A", "B"]);
  });

  it("keeps zero-count record types satisfied by the manifest", () => {
    const restored = collect([
      { type: "meta", formatVersion: 1, revision: 7 },
      character("c1"),
    ]);
    expect(restored.pluginCustomStorage).toEqual({});
    expect(restored.modules).toEqual([]);
    expect(restored.botPresets).toEqual([]);
    expect(restored.botPresetsId).toBe(0);
  });
});

describe("PortableDatabaseStreamCollector validation", () => {
  const validRecord: StreamRecord = {
    type: "setting",
    key: "k",
    value: null,
  };

  it("rejects malformed fragments", () => {
    const collector = new PortableDatabaseStreamCollector();
    expect(() =>
      collector.addFragment({
        format: "wrong",
        version: 1,
        index: 1,
        records: [validRecord],
      } as any),
    ).toThrow("Invalid streaming database fragment");
    expect(() =>
      collector.addFragment({
        ...fragment(1, [validRecord]),
        version: 2,
      } as any),
    ).toThrow("Invalid streaming database fragment");
    expect(() =>
      collector.addFragment({ ...fragment(1, [validRecord]), index: 0 }),
    ).toThrow("Invalid streaming database fragment");
    expect(() =>
      collector.addFragment({ ...fragment(1, [validRecord]), index: 1.5 }),
    ).toThrow("Invalid streaming database fragment");
    expect(() =>
      collector.addFragment({ ...fragment(1, [validRecord]), records: [] }),
    ).toThrow("Invalid streaming database fragment");
    expect(() =>
      collector.addFragment({
        ...fragment(1, [validRecord]),
        records: undefined as any,
      }),
    ).toThrow("Invalid streaming database fragment");
  });

  it("rejects fragments exceeding the shared max record bound", () => {
    const collector = new PortableDatabaseStreamCollector();
    const tooMany = Array.from(
      { length: PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS + 1 },
      () => validRecord,
    );
    expect(() => collector.addFragment(fragment(1, tooMany))).toThrow(
      "Invalid streaming database fragment",
    );
    const atBound = Array.from(
      { length: PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS },
      () => validRecord,
    );
    expect(() => collector.addFragment(fragment(1, atBound))).not.toThrow();
  });

  it("rejects duplicate fragment indexes", () => {
    const collector = new PortableDatabaseStreamCollector();
    collector.addFragment(fragment(1, [validRecord]));
    expect(() => collector.addFragment(fragment(1, [validRecord]))).toThrow(
      "Duplicate streaming database fragment 1",
    );
  });

  it("rejects invalid record payloads", () => {
    const collector = new PortableDatabaseStreamCollector();
    collector.addFragment(fragment(1, [validRecord]));
    expect(() =>
      collector.addFragment(
        fragment(2, [{ type: "unknown" } as unknown as StreamRecord]),
      ),
    ).toThrow("Invalid streaming database record");
    expect(() =>
      collector.addFragment(fragment(3, [null as unknown as StreamRecord])),
    ).toThrow("Invalid streaming database record");
  });

  it("rejects duplicate or malformed metadata", () => {
    expect(() =>
      collect([
        { type: "meta", formatVersion: 1, revision: 1 },
        { type: "meta", formatVersion: 1, revision: 2 },
      ]),
    ).toThrow("Duplicate streaming database metadata");
    expect(() =>
      collect([
        {
          type: "meta",
          formatVersion: 2,
          revision: 1,
        } as unknown as StreamRecord,
      ]),
    ).toThrow("Invalid streaming database metadata");
    expect(() =>
      collect([{ type: "meta", formatVersion: 1, revision: -1 }]),
    ).toThrow("Invalid streaming database metadata");
    expect(() =>
      collect([
        {
          type: "meta",
          formatVersion: 1,
          revision: Number.MAX_SAFE_INTEGER + 1,
        },
      ]),
    ).toThrow("Invalid streaming database metadata");
  });

  it.each([
    ["module", { type: "module", position: -1, id: "m", data: {} }],
    ["module", { type: "module", position: 1.5, id: "m", data: {} }],
    ["preset", { type: "preset", position: -1, id: "p", data: {} }],
    ["character", { type: "character", position: -1, id: "c", data: {} }],
  ])("rejects invalid %s positions", (_label, record) => {
    expect(() => collect([record as StreamRecord])).toThrow(
      new RegExp(`Invalid streamed ${_label} position`),
    );
  });

  it("rejects duplicate characters and chats", () => {
    expect(() =>
      collect([
        { type: "meta", formatVersion: 1, revision: 1 },
        character("c1", 0),
        character("c1", 1),
      ]),
    ).toThrow("Duplicate streamed character c1");

    expect(() =>
      collect([
        { type: "meta", formatVersion: 1, revision: 1 },
        character("c1"),
        chat("t1", "c1", 0),
        chat("t1", "c1", 1),
      ]),
    ).toThrow("Duplicate streamed chat t1");
  });

  it("rejects chats whose owning character has not arrived", () => {
    expect(() =>
      collect([
        { type: "meta", formatVersion: 1, revision: 1 },
        chat("t1", "ghost"),
      ]),
    ).toThrow("Streamed chat has no character ghost");
  });

  it("rejects branch, active-branch, and message records for unknown chats", () => {
    expect(() =>
      collect([
        { type: "meta", formatVersion: 1, revision: 1 },
        branch("t-x", "b1"),
      ]),
    ).toThrow("Streamed branch graph has no chat t-x");
    expect(() =>
      collect([
        { type: "meta", formatVersion: 1, revision: 1 },
        {
          type: "active-branch",
          chatId: "t-x",
          branchId: "b1",
        } as StreamRecord,
      ]),
    ).toThrow("Streamed branch graph has no chat t-x");
    expect(() => collect([message("t-x", "m1", 0)])).toThrow(
      "Streamed branch graph has no chat t-x",
    );
  });

  it("rejects invalid message positions", () => {
    expect(() =>
      collect([
        { type: "meta", formatVersion: 1, revision: 1 },
        character("c1"),
        chat("t1", "c1"),
        branch("t1", "b1", "root"),
        message("t1", "m1", -3),
      ]),
    ).toThrow("Invalid streamed message position");
  });

  it("rejects duplicate or unsupported manifests", () => {
    const collector = new PortableDatabaseStreamCollector();
    feed(collector, [validRecord]);
    expect(() => collector.setManifest(manifest())).toThrow(
      "Duplicate streaming database manifest",
    );

    const fresh = () => {
      const instance = new PortableDatabaseStreamCollector();
      instance.addFragment(fragment(1, [validRecord]));
      return instance;
    };
    expect(() =>
      fresh().setManifest({ ...manifest(), format: "nope" } as any),
    ).toThrow("Unsupported streaming database manifest");
    expect(() =>
      fresh().setManifest({ ...manifest(), version: 9 } as any),
    ).toThrow("Unsupported streaming database manifest");
    expect(() =>
      fresh().setManifest({ ...manifest(), complete: false } as any),
    ).toThrow("Unsupported streaming database manifest");
    expect(() => fresh().setManifest({ ...manifest(), revision: -1 })).toThrow(
      "Unsupported streaming database manifest",
    );
    expect(() =>
      fresh().setManifest({ ...manifest(), totalFragments: 0 }),
    ).toThrow("Unsupported streaming database manifest");
    expect(() =>
      fresh().setManifest({ ...manifest(), totalRecords: 1.5 }),
    ).toThrow("Unsupported streaming database manifest");
    expect(() =>
      fresh().setManifest({ ...manifest(), counts: null } as any),
    ).toThrow("Unsupported streaming database manifest");
  });

  it("requires a manifest before finishing", () => {
    const collector = new PortableDatabaseStreamCollector();
    collector.addFragment(fragment(1, [validRecord]));
    expect(() => collector.finish()).toThrow(
      "Streaming database manifest is missing",
    );
  });

  it("rejects incomplete assemblies and fragment gaps", () => {
    const gapped = new PortableDatabaseStreamCollector();
    gapped.addFragment(fragment(1, [validRecord, validRecord]));
    gapped.addFragment(fragment(3, [validRecord]));
    gapped.setManifest(
      manifest({
        totalFragments: 2,
        totalRecords: 3,
        counts: { setting: 3 },
      }),
    );
    expect(() => gapped.finish()).toThrow(
      "Streaming database fragment 2 is missing",
    );

    const short = new PortableDatabaseStreamCollector();
    short.addFragment(fragment(1, [validRecord]));
    short.setManifest(
      manifest({ totalFragments: 2, totalRecords: 2, counts: { setting: 2 } }),
    );
    expect(() => short.finish()).toThrow(
      /Streaming database is incomplete \(1\/2 fragments, 1\/2 records\)/,
    );
  });

  it("rejects revision and per-type count mismatches", () => {
    const revision = new PortableDatabaseStreamCollector();
    const records: StreamRecord[] = [
      { type: "meta", formatVersion: 1, revision: 7 },
      validRecord,
    ];
    revision.addFragment(fragment(1, records));
    revision.setManifest(
      manifest({
        revision: 9,
        totalRecords: records.length,
        counts: { meta: 1, setting: 1 },
      }),
    );
    expect(() => revision.finish()).toThrow(
      "Streaming database revision does not match",
    );

    const counts = new PortableDatabaseStreamCollector();
    const counted: StreamRecord[] = [
      { type: "meta", formatVersion: 1, revision: 7 },
      { type: "setting", key: "k", value: 1 },
      { type: "setting", key: "k2", value: 2 },
    ];
    counts.addFragment(fragment(1, counted));
    counts.setManifest(
      manifest({
        totalRecords: counted.length,
        counts: { meta: 1, setting: 5 },
      }),
    );
    expect(() => counts.finish()).toThrow(
      "Streaming database setting count does not match",
    );
  });

  it("rejects a chat whose branch graph is missing", () => {
    expect(() =>
      collect([
        { type: "meta", formatVersion: 1, revision: 1 },
        character("c1"),
        chat("t1", "c1"),
      ]),
    ).toThrow("Streaming branch graph is missing for chat t1");
  });

  it("does not mutate the record payloads it consumes", () => {
    const records: StreamRecord[] = [
      { type: "meta", formatVersion: 1, revision: 1 },
      character("c1", 0, { name: "Alice" }),
      chat("t1", "c1"),
      branch("t1", "b1", "root"),
      message("t1", "m1", 0, { data: "hello" }, {
        originBranchId: "b1",
      } as Partial<StreamRecord>),
    ];
    const snapshot = JSON.parse(JSON.stringify(records));
    collect(records);
    expect(records).toEqual(snapshot);
  });
});
