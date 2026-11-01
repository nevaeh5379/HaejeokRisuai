import { afterEach, describe, expect, it, vi } from "vitest";
import {
  Character,
  CHARACTER_KEYS,
  characterDefault,
  type CharacterFields,
  type CharacterUpdate,
} from "../../../../packages/protocol/domain/character.ts";
import { encodePostgresJsonValue } from "./postgresJsonCodec.ts";
import {
  decodeCharacterReadRow,
  encodeCharacterPatch,
  splitLore,
  type CharacterReadRow,
} from "./postgresRelationalCodec.ts";
import { NPostgresStorage } from "./postgresStorage.ts";

const A = "00000000-0000-4000-8000-000000000001";
const B = "00000000-0000-4000-8000-000000000002";
const GROUP = "00000000-0000-4000-8000-000000000003";
const MISSING = "00000000-0000-4000-8000-000000000004";
const storages: NPostgresStorage[] = [];
type QueryResult = {
  rows: Record<string, unknown>[];
  command: string;
  rowCount: number;
};
type Harness = ReturnType<typeof harness>;
const CHARACTER_ROW = {
  id: A,
  kind: "character",
  name: "Alpha",
  description: "Description",
  creation_time: "1234",
  view_screen: "unknown",
  tags: [
    { character_id: A, position: 1, tag: "second" },
    { character_id: A, position: 0, tag: "first" },
  ],
  __attributes: { name: encodePostgresJsonValue("Al\0pha"), modules: [] },
};
const DECODE_KEYS = [
  "chaId",
  "type",
  "name",
  "tags",
  "creation_date",
  "image",
  "viewScreen",
  "triggerscript",
  "modules",
] as const;
const INVALID_PATCHES = [
  { chaId: B },
  { type: "group" },
  { name: undefined },
  { unknown: true },
  { chaId: undefined },
];
const LORE = {
  key: "world",
  secondkey: "",
  insertorder: 0,
  comment: "",
  content: "lore",
  mode: "normal",
  alwaysActive: false,
  selective: false,
  loreCache: { cached: "value" },
};
const RICH_PATCH: CharacterUpdate = {
  name: "name\0fallback",
  firstMessage: "hello\0",
  tags: [],
  modules: ["module"],
  bias: [["x", 1]],
  alternateGreetings: ["alt"],
  group_only_greetings: ["group"],
  emotionImages: [["happy", "asset"]],
  customscript: [{ comment: "c", in: "in", out: "out", type: "editinput" }],
  triggerscript: [],
  sdData: [["key", "value"]],
  additionalAssets: [["asset", "uri", "png"]],
  ccAssets: [{ type: "icon", uri: "cc", name: "cc", ext: "png" }],
  globalLore: [],
  image: undefined,
  depth_prompt: { depth: 1, prompt: "prompt" },
};
const SETTER_EXCEPTIONS: Record<string, string> = {
  creation_date: "CreationDate",
  modification_date: "ModificationDate",
  group_only_greetings: "GroupOnlyGreetings",
  depth_prompt: "DepthPrompt",
};

afterEach(async () => {
  await Promise.all(storages.splice(0).map((storage) => storage.close()));
});

function baseData() {
  return new Map<string, Partial<CharacterReadRow>>([
    [A, structuredClone(CHARACTER_ROW)],
    [B, { id: B, kind: "character", name: "Beta" }],
    [GROUP, { id: GROUP, kind: "group", name: "Group" }],
  ]);
}

function result(rows: Record<string, unknown>[]): QueryResult {
  return { rows, command: "SELECT", rowCount: rows.length };
}

function writeResult(
  text: string,
  parameters: readonly unknown[],
  state: { revision: number; data: ReturnType<typeof baseData> },
) {
  const create = text.includes("system.character_apply_create");
  const id = create
    ? `00000000-0000-4000-8000-${String(state.revision + 100).padStart(12, "0")}`
    : String(parameters[0]);
  const updated = create || state.data.get(id)?.kind === "character";
  if (updated) state.revision++;
  return result([
    {
      id,
      storage_revision: updated ? String(state.revision) : null,
      updated: updated ? 1 : 0,
    },
  ]);
}

function queryResult(
  text: string,
  parameters: readonly unknown[],
  state: { revision: number; data: ReturnType<typeof baseData> },
) {
  if (text.includes("system.character_apply_"))
    return writeResult(text, parameters, state);
  if (text.includes('coalesce(max("position"), -1)'))
    return result([{ max: "6" }]);
  const ids = parameters.filter(
    (value): value is string =>
      typeof value === "string" && /^[\da-f-]{36}$/.test(value),
  );
  const lookup = text.includes('"c"."id" in (') ? ids : ids.slice(0, 1);
  return result(
    lookup.flatMap((id) => {
      const row = state.data.get(id);
      return row ? [{ ...row, __revision: state.revision }] : [];
    }),
  );
}

function harness(cache?: { maxEntries: number; maxBytes: number }) {
  const state = { revision: 1, data: baseData() };
  const query = vi.fn(async (text: string, parameters: readonly unknown[]) =>
    queryResult(text, parameters, state),
  );
  const pool = {
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
    end: vi.fn(async () => {}),
  };
  const storage = new NPostgresStorage("unused", 10, { pool, cache });
  storages.push(storage);
  return {
    storage,
    query,
    pool,
    data: state.data,
    setRevision: (value: number) => {
      state.revision = value;
    },
  };
}

function expectWriteCall(text: string, operation: "update" | "create") {
  expect(text).toContain(`select * from`);
  expect(text).toContain(`system.character_apply_${operation}(`);
  expect(text).toContain('as "result"');
  // 감사 검증은 실DB 라이브 스모크 담당.
}

async function runOperations(
  storage: NPostgresStorage,
  query: Harness["query"],
) {
  const operations = [
    () => storage.character.load(A),
    () => storage.character.read(A, "desc", "tags"),
    () => storage.character.readMany([A, B], ["name"]),
    () =>
      storage.character.update(A, {
        name: "updated",
        notes: "notes",
        tags: ["tag"],
        depth_prompt: { depth: 1, prompt: "prompt" },
      }),
    () => storage.character.create("Created"),
    () => storage.character.position.max(),
  ];
  for (const operation of operations) {
    const before = query.mock.calls.length;
    await operation();
    expect(query.mock.calls.length - before).toBe(1);
  }
}

function expectReadSql(query: Harness["query"]) {
  const readSql = query.mock.calls[1][0];
  expect(readSql).toContain('json_agg("t" order by "t"."position")');
  expect(readSql).toContain('as "__revision"');
  expect(readSql).toContain('"c"."description"');
  expect(readSql).not.toContain('"character"."greetings"');
  expect(query.mock.calls[2][0]).toMatch(/"c"\."id" in \(\$\d+, \$\d+\)/);
  expect(query.mock.calls[2][1].slice(-2)).toEqual([A, B]);
  expect(readSql).toMatch(/where "c"\."id" = \$\d+$/);
  expect(query.mock.calls[1][1].at(-1)).toBe(A);
  expect(query.mock.calls[0][0].trim()).toMatch(
    /^select "id", "kind" from "character"\."characters" where "id" = \$1$/,
  );
}

async function testStatements() {
  const { storage, query } = harness();
  await runOperations(storage, query);
  const before = query.mock.calls.length;
  const handle = await storage.character.load(A);
  expect(await storage.character.load(A)).toBe(handle);
  await storage.character.update(A, {});
  expect(query.mock.calls.length).toBe(before);
  for (const [text] of query.mock.calls)
    expect(text).not.toMatch(/\b(BEGIN|COMMIT|SAVEPOINT|SET TRANSACTION)\b/i);
  expectReadSql(query);
  expectWriteCall(query.mock.calls[3][0], "update");
  expectWriteCall(query.mock.calls[4][0], "create");
  expect(await storage.character.position.max()).toBe(6);
}

async function testRestamp() {
  const { storage, query } = harness();
  await storage.character.read(A, "name");
  await storage.character.read(B, "name");
  query.mockClear();
  await storage.character.read(A, "name");
  expect(query).toHaveBeenCalledTimes(0);
  await storage.character.update(A, { name: "new" });
  expect(query).toHaveBeenCalledTimes(1);
  expect(await storage.character.read(B, "name")).toEqual({ name: "Beta" });
  expect(query).toHaveBeenCalledTimes(1);
  await storage.character.read(A, "name");
  expect(query).toHaveBeenCalledTimes(2);
  await storage.character.read(A, "name");
  expect(query).toHaveBeenCalledTimes(2);
}

async function testCreate() {
  const { storage, query } = harness();
  const name = "new\0name'; DROP TABLE character.characters; --";
  const handle = await storage.character.create(name);
  expect(query).toHaveBeenCalledTimes(1);
  const [text, parameters] = query.mock.calls[0];
  expectWriteCall(text, "create");
  expect(text).not.toContain(name);
  expect(parameters).toEqual([JSON.stringify(encodePostgresJsonValue(name))]);
  expect(await handle.get("chaId", "type", "name")).toEqual({
    chaId: handle.id,
    type: "character",
    name,
  });
  expect(await storage.character.load(handle.id)).toBe(handle);
  expect(query).toHaveBeenCalledTimes(1);
}

function decodedA() {
  return {
    chaId: A,
    type: "character",
    name: "Al\0pha",
    tags: ["first", "second"],
    creation_date: 1234,
    image: undefined,
    viewScreen: "none",
    triggerscript: characterDefault("triggerscript"),
    modules: [],
  };
}

async function testDecode() {
  const { storage } = harness();
  expect(await storage.character.read(A, ...DECODE_KEYS)).toEqual(decodedA());
  expect(
    await storage.character.readMany([A, MISSING, GROUP], DECODE_KEYS),
  ).toEqual([decodedA()]);
  expect(
    await storage.character.read(B, "modules", "group_only_greetings"),
  ).toEqual({ modules: undefined, group_only_greetings: undefined });
}

async function testClones() {
  const { storage, query } = harness();
  const first = await storage.character.read(A, "tags");
  first.tags.push("mutation");
  const second = await storage.character.read(A, "tags");
  expect(second.tags).toEqual(["first", "second"]);
  second.tags.length = 0;
  await storage.character.read(A, "name");
  query.mockClear();
  expect(await storage.character.read(A, "name", "tags")).toEqual({
    name: "Al\0pha",
    tags: ["first", "second"],
  });
  expect(query).not.toHaveBeenCalled();
}

async function expectInvalidReads(storage: NPostgresStorage) {
  await expect(
    storage.character.read(A, ...([] as unknown as ["name"])),
  ).rejects.toThrow(TypeError);
  await expect(storage.character.readMany([A], [])).rejects.toThrow(TypeError);
  await expect(
    storage.character.read(A, "__proto__" as keyof CharacterFields),
  ).rejects.toThrow(TypeError);
}

async function testValidation() {
  const { storage, query } = harness();
  await storage.character.read(A, "name", "name");
  expect(query.mock.calls[0][0].match(/"c"\."name"/g)).toHaveLength(1);
  query.mockClear();
  await expectInvalidReads(storage);
  for (const patch of INVALID_PATCHES)
    await expect(
      storage.character.update(A, patch as CharacterUpdate),
    ).rejects.toThrow(TypeError);
  expect(query).not.toHaveBeenCalled();
}

async function expectMissing(storage: NPostgresStorage, id: string) {
  await expect(storage.character.load(id)).rejects.toThrow(
    `Character not found: ${id}`,
  );
  await expect(storage.character.read(id, "name")).rejects.toThrow(
    `Character not found: ${id}`,
  );
  await expect(
    storage.character.update(id, { name: "changed", tags: ["tag"] }),
  ).rejects.toThrow(`Character not found: ${id}`);
}

async function testMissing() {
  const { storage, query } = harness();
  for (const id of [GROUP, MISSING]) await expectMissing(storage, id);
  expect(query).toHaveBeenCalledTimes(6);
  expectWriteCall(query.mock.calls[2][0], "update");
  expect(query.mock.calls[2][1][0]).toBe(GROUP);
}

async function testIdentity() {
  const { storage } = harness();
  const [one, two] = await Promise.all([
    storage.character.load(A),
    storage.character.load(A),
  ]);
  expect(one).toBe(two);
  expect(await one.get("name")).toEqual(await two.get("name"));
}

async function testExternal() {
  const { storage, query, setRevision } = harness();
  await storage.character.read(A, "name");
  await storage.character.read(B, "name");
  setRevision(5);
  await storage.character.read(A, "tags");
  query.mockClear();
  await storage.character.read(B, "name");
  expect(query).toHaveBeenCalledTimes(1);
  storage.notifyExternalWrite();
  await storage.character.read(B, "name");
  expect(query).toHaveBeenCalledTimes(2);
}

async function expectByteBounds() {
  const tiny = harness({ maxEntries: 64, maxBytes: 1 });
  await tiny.storage.character.read(A, "name");
  await tiny.storage.character.read(A, "name");
  expect(tiny.query).toHaveBeenCalledTimes(2);
  const bounded = harness({ maxEntries: 64, maxBytes: 300 });
  await bounded.storage.character.read(A, "name");
  await bounded.storage.character.read(B, "name");
  await bounded.storage.character.read(A, "name");
  expect(bounded.query).toHaveBeenCalledTimes(3);
}

async function testLru() {
  const { storage, query, data } = harness({ maxEntries: 2, maxBytes: 1024 });
  data.set(GROUP, { id: GROUP, kind: "character", name: "Third" });
  await storage.character.read(A, "name");
  await storage.character.read(B, "name");
  await storage.character.read(A, "name");
  await storage.character.read(GROUP, "name");
  query.mockClear();
  await storage.character.read(A, "name");
  expect(query).not.toHaveBeenCalled();
  await storage.character.read(B, "name");
  expect(query).toHaveBeenCalledTimes(1);
  await expectByteBounds();
}

function deferNextQuery(query: Harness["query"]) {
  let resolve!: (value: QueryResult) => void;
  query.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  return (value: QueryResult) => resolve(value);
}

async function testOlderRead() {
  const { storage, query } = harness();
  const resolve = deferNextQuery(query);
  const older = storage.character.read(A, "name");
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  query.mockResolvedValueOnce(
    result([{ id: A, kind: "character", name: "newer", __revision: 2 }]),
  );
  expect(await storage.character.read(A, "name")).toEqual({ name: "newer" });
  resolve(result([{ id: A, kind: "character", name: "older", __revision: 1 }]));
  await older;
  query.mockClear();
  expect(await storage.character.read(A, "name")).toEqual({ name: "newer" });
  expect(query).not.toHaveBeenCalled();
}

async function testInvalidatedRead() {
  const { storage, query } = harness();
  const resolve = deferNextQuery(query);
  const pending = storage.character.read(A, "name");
  await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(1));
  await storage.character.update(A, { name: "new" });
  resolve(result([{ id: A, kind: "character", name: "stale", __revision: 1 }]));
  await pending;
  query.mockClear();
  await storage.character.read(A, "name");
  expect(query).toHaveBeenCalledTimes(1);
  storage.notifyExternalWrite();
  expect(await storage.character.read(A, "name")).toEqual({ name: "Al\0pha" });
}

function expectRichAttributes(parameters: readonly unknown[]) {
  const attributes = JSON.parse(parameters[3] as string);
  expect(attributes).toEqual(
    expect.arrayContaining([
      { character_id: A, key: "tags", value: [] },
      { character_id: A, key: "triggerscript", value: [] },
      {
        character_id: A,
        key: "name",
        value: encodePostgresJsonValue("name\0fallback"),
      },
    ]),
  );
}

async function expectCardCall(
  storage: NPostgresStorage,
  query: Harness["query"],
) {
  query.mockClear();
  await storage.character.update(A, {
    ccAssets: [{ type: "icon", uri: "cc", name: "cc", ext: "png" }],
  });
  expectWriteCall(query.mock.calls[0][0], "update");
  const relations = JSON.parse(query.mock.calls[0][1][2] as string);
  expect(relations[0]).toMatchObject({
    table: "character.assets",
    discriminator: ["asset_source", "character-card"],
  });
}

async function testRichUpdate() {
  const { storage, query } = harness();
  await storage.character.update(A, RICH_PATCH);
  expect(query).toHaveBeenCalledTimes(1);
  const [text, parameters] = query.mock.calls[0];
  expectWriteCall(text, "update");
  expect(text).not.toContain("name\0fallback");
  expectRichAttributes(parameters);
  await expectCardCall(storage, query);
}

async function testRelationProjection() {
  const { storage, query, data } = harness();
  data.get(A)!.globalLore = splitLore({ character_id: A }, [LORE]);
  const read = await storage.character.read(
    A,
    "alternateGreetings",
    "customscript",
    "ccAssets",
    "globalLore",
  );
  expect(read.globalLore).toEqual([LORE]);
  const [text, parameters] = query.mock.calls[0];
  expect(text).toContain('"t"."greeting_type" = $');
  expect(text).toContain('"t"."script_kind" = $');
  expect(text).toContain('"t"."asset_source" = $');
  expect(text).toContain('from "character"."lore_entries" as "t"');
  expect(parameters).toEqual(
    expect.arrayContaining(["alternate", "custom", "character-card"]),
  );
}

function removalAttributes() {
  return [
    { character_id: A, key: "additionalAssets", value: [] },
    {
      character_id: A,
      key: "tags",
      value: encodePostgresJsonValue(["bad\0tag"]),
    },
  ];
}

function expectRemovalDecode(patch: ReturnType<typeof encodeCharacterPatch>) {
  expect(
    decodeCharacterReadRow(
      {
        id: A,
        kind: "character",
        __revision: 1,
        creation_time: null,
        __attributes: { tags: patch.attributes[1].value },
      },
      ["creation_date", "tags"],
    ),
  ).toEqual({ creation_date: undefined, tags: ["bad\0tag"] });
}

function testEncoding() {
  const patch = encodeCharacterPatch(A, {
    image: undefined,
    additionalAssets: [],
    tags: ["bad\0tag"],
    newGenData: undefined,
  });
  expect(patch.columns).toEqual({ image: null });
  expect(patch.relations.every((relation) => relation.rows.length === 0)).toBe(
    true,
  );
  expect(patch.attributes).toEqual(removalAttributes());
  expectRemovalDecode(patch);
}

function setterHandle() {
  const read = vi.fn(async (...keys: (keyof CharacterFields)[]) =>
    Object.fromEntries(keys.map((key) => [key, characterDefault(key)])),
  );
  const write = vi.fn(async (_patch: CharacterUpdate) => {});
  const handle = new Character(
    A,
    read as <K extends keyof CharacterFields>(
      ...keys: [K, ...K[]]
    ) => Promise<Pick<CharacterFields, K>>,
    write,
  );
  return { read, write, handle };
}

function expectSetterNames(handle: Character) {
  for (const key of CHARACTER_KEYS) {
    const setter = `set${SETTER_EXCEPTIONS[key] ?? key[0].toUpperCase() + key.slice(1)}`;
    expect(typeof (handle as unknown as Record<string, unknown>)[setter]).toBe(
      "function",
    );
  }
}

function expectHandleErrors(handle: Character) {
  expect(() => handle.setChaId(B)).toThrow(TypeError);
  expect(() =>
    handle.update({ type: "group" } as unknown as CharacterUpdate),
  ).toThrow(TypeError);
  expect(() => handle.update({ name: undefined })).toThrow(TypeError);
  expect(() => handle.update({ unknown: 1 } as CharacterUpdate)).toThrow(
    TypeError,
  );
}

async function testSetters() {
  const { read, write, handle } = setterHandle();
  expectSetterNames(handle);
  await handle.setName("name");
  expect(write).toHaveBeenCalledWith({ name: "name" });
  await handle.get("name", "name");
  expect(read).toHaveBeenCalledWith("name");
  expectHandleErrors(handle);
  expect(Object.keys(handle)).toEqual(["id"]);
}

const cases: [string, () => void | Promise<void>][] = [
  [
    "uses one query per miss/write/max, zero for identity hits and empty updates",
    testStatements,
  ],
  ["restamps B after writing A and invalidates only A", testRestamp],
  [
    "seeds create with the actual NUL-bearing name and a canonical handle",
    testCreate,
  ],
  [
    "decodes columns, sorted relations, defaults, BIGINTs and attribute overrides for both read paths",
    testDecode,
  ],
  [
    "returns clones on misses and hits and preserves partial cached projections",
    testClones,
  ],
  [
    "deduplicates projections and rejects invalid reads and patches before SQL",
    testValidation,
  ],
  [
    "rejects non-characters and missing IDs without caching handles",
    testMissing,
  ],
  [
    "keeps a single canonical handle when concurrent loads finish",
    testIdentity,
  ],
  [
    "invalidates on external observations and explicit notification",
    testExternal,
  ],
  ["evicts the least recently used entry and bounds bytes", testLru],
  [
    "never lets an older concurrent read replace a newer observation",
    testOlderRead,
  ],
  [
    "ignores in-flight snapshots invalidated by a write or notification",
    testInvalidatedRead,
  ],
  [
    "passes every relation and attribute to the write function, including explicit empties/NUL",
    testRichUpdate,
  ],
  [
    "projects discriminator-filtered relations and includes lore cache payload",
    testRelationProjection,
  ],
  [
    "encodes optional removal, empty markers and recursive NUL fallback",
    testEncoding,
  ],
  [
    "provides field setters through stateless callbacks and enforces handle invariants",
    testSetters,
  ],
];

describe("NPostgresStorage single-statement character contract", () => {
  for (const [name, run] of cases) it(name, run);
});
