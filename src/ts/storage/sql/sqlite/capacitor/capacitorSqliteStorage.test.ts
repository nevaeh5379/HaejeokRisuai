import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { makeCapacitorStorage } from "../sqliteTestHarness";
import sqliteSchemaSql from "@risuai/storage-sqlite/schema/schema.sql?raw";
import { buildFullDatabase } from "../sqliteTestFixtures";
import { presetTemplate } from "../../../presets/presetDefaults";
import { installStartupData } from "../../../database/databaseLifecycle";
import { settingsStore } from "../../../../stores/domain/settingsStore.svelte";
import { deferredSettingsLoader } from "../../../../stores/domain/deferredSettingsLoader";
import { createEmptySqlCommit } from "../../sqlCommit";
import * as sqliteCommit from "@risuai/storage-sqlite/commit/apply";
import * as nodeCodec from "@risuai/storage-sqlite/schema/codec";

describe("CapacitorSqliteStorage", () => {
  it("flushes small statements before JSON escapes would overflow the batch", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
    const storage = makeCapacitorStorage(database);
    const plugin = (storage as any).sqlitePlugin;
    const batchSizes: number[] = [];
    const executeBatch = plugin.executeBatch.bind(plugin);
    plugin.executeBatch = async (options: any) => {
      batchSizes.push(JSON.stringify(options).length);
      return executeBatch(options);
    };
    const value = '\u0001\\"\b\t\n\f\r한😀'.repeat(1_024);
    await (storage as any).runNativeTransaction(null, async (execute: any) => {
      for (let id = 0; id < 50; id++)
        await execute("INSERT INTO probe VALUES (?, ?)", [id, value]);
    });
    const rows = database.prepare("SELECT value FROM probe").all();
    expect(rows).toHaveLength(50);
    expect(rows.every((row) => row.value === value)).toBe(true);
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(256 * 1024);
    database.close();
  });

  it("bounds escaped bridge requests and streams oversized individual binds without changing their values", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    const plugin = (storage as any).sqlitePlugin;
    const batchSizes: number[] = [];
    const chunkSizes: number[] = [];
    const executeBatch = plugin.executeBatch.bind(plugin);
    const append = plugin.restoreAppend.bind(plugin);
    plugin.executeBatch = async (options: any) => {
      batchSizes.push(JSON.stringify(options).length);
      return executeBatch(options);
    };
    plugin.restoreAppend = async (options: any) => {
      chunkSizes.push(options.data.length);
      return append(options);
    };
    const large = '한\n"'.repeat(174_762);
    const values = [
      "before",
      ...Array(12).fill(large),
      "after",
      ...Array(40).fill("\0".repeat(4_096)),
      "\ud800😀",
    ];
    const commit = createEmptySqlCommit(0, "bounded-bridge");
    commit.modules = {
      upserts: [
        {
          id: "bridge-probe",
          position: 0,
          data: {
            id: "bridge-probe",
            name: "probe",
            lorebook: [],
            values,
          } as any,
        },
      ],
      deletes: [],
    };
    await storage.commit(commit);
    const rows = database
      .prepare(
        "SELECT * FROM module_extension_nodes WHERE module_id = ? ORDER BY node_id",
      )
      .all("bridge-probe");
    expect((nodeCodec.rebuild(rows) as any).values).toEqual(values);
    expect(batchSizes.length).toBeGreaterThan(1);
    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(256 * 1024);
    expect(chunkSizes.length).toBeGreaterThan(12);
    expect(Math.max(...chunkSizes)).toBeLessThan(256 * 1024);
    expect(
      database.prepare("SELECT revision FROM system_storage_meta").get()!
        .revision,
    ).toBe(1);
    database.close();
  });

  it.each(["batch", "stream"])(
    "rolls back normal and streamed writes when a later %s fails",
    async (failurePath) => {
      const database = new DatabaseSync(":memory:");
      database.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
      const storage = makeCapacitorStorage(database);
      const run = (task: any) =>
        (storage as any).runNativeTransaction(null, task);
      const plugin = (storage as any).sqlitePlugin;
      const streamed = vi.spyOn(plugin, "restoreOpen");
      await expect(
        run(async (execute: any) => {
          await execute("INSERT INTO probe VALUES (?, ?)", [1, "before"]);
          await execute("INSERT INTO probe VALUES (?, ?)", [
            2,
            "한".repeat(512 * 1024),
          ]);
          await execute("INSERT INTO missing_table VALUES (?)", [
            failurePath === "stream" ? "x".repeat(512 * 1024) : 3,
          ]);
        }),
      ).rejects.toThrow(/missing_table/);
      expect(streamed).toHaveBeenCalled();
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM probe").get()!.count,
      ).toBe(0);
      // Failure must release both the pipe and transaction so the next write works.
      await run(async (execute: any) =>
        execute("INSERT INTO probe VALUES (?, ?)", [4, "next"]),
      );
      expect(
        database.prepare("SELECT value FROM probe WHERE id = 4").get()!.value,
      ).toBe("next");
      database.close();
    },
  );

  it("counts size-limited node statements exactly, including encoded keys and sparse arrays", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const values: unknown[] = new Array(300);
    values[0] = "x".repeat(512 * 1024);
    values[120] = "\0".repeat(64 * 1024);
    values[299] = {
      ["\ud800".repeat(60 * 1024)]: "end",
      nan: NaN,
      infinity: -Infinity,
    };
    const commit = createEmptySqlCommit(0, "node-budgets");
    commit.root.upserts = [{ key: "probe", value: values }];
    let executed = 0;
    await sqliteCommit.apply(commit, (sql, bind) => {
      database.prepare(sql).run(...(bind! as any[]));
      executed++;
    });
    expect(executed).toBe(sqliteCommit.countStatements(commit));
    const rows = database
      .prepare(
        "SELECT * FROM setting_extension_nodes WHERE setting_key = ? ORDER BY node_id",
      )
      .all("probe");
    expect(nodeCodec.rebuild(rows)).toEqual([
      values[0],
      values[120],
      values[299],
    ]);
    database.close();
  });

  it("loads shallow startup data in one native query stream", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    await storage.replaceDatabase(buildFullDatabase() as any);

    const stats = (storage as any).__bridgeStats;
    stats.queryStreamCalls = 0;
    const loaded = await storage.loadStartupData();

    expect(loaded?.status).toBe("ready");
    expect(stats.queryStreamCalls).toBe(1);
    database.close();
  });

  it("hydrates a selected character through one native query stream", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    const source = buildFullDatabase() as any;
    await storage.replaceDatabase(source);

    const stats = (storage as any).__bridgeStats;
    stats.queryStreamCalls = 0;
    const selected = await storage.loadCharacterForSelection(
      source.characters[0].chaId,
    );

    expect(selected?.chaId).toBe(source.characters[0].chaId);
    expect(selected?.detailsLoaded).toBe(true);
    expect(selected?.chats?.length).toBe(source.characters[0].chats.length);
    expect(stats.queryStreamCalls).toBe(1);
    database.close();
  });

  it("hydrates the active chat and recent messages through one native query stream", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    const source = buildFullDatabase() as any;
    await storage.replaceDatabase(source);

    const chatId = source.characters[0].chats[0].id;
    const stats = (storage as any).__bridgeStats;
    stats.queryStreamCalls = 0;
    const chat = await storage.loadChat(chatId, { messageLimit: 24 });

    expect(chat?.id).toBe(chatId);
    expect(chat?.messagesLoaded).toBe(true);
    expect(stats.queryStreamCalls).toBe(1);
    database.close();
  });

  it("restores plugin definitions and custom storage through the Android path", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    const source = buildFullDatabase() as any;
    source.plugins = [
      {
        name: "android-restore-plugin",
        displayName: "Android Restore Plugin",
        version: "3.0",
        enabled: true,
        script: "console.log('android restore')",
      },
    ];
    source.pluginCustomStorage = {
      "android-restore-plugin": { enabledFeature: true, count: 7 },
    };

    await storage.replaceDatabase(source);

    const plugins = await storage.plugin.loadAll();
    expect(plugins).toHaveLength(1);
    const { script, ...expectedMetadata } = source.plugins[0];
    expect(plugins[0]).toMatchObject(expectedMetadata);
    expect(plugins[0].position).toBe(0);
    expect(await storage.plugin.script.load(plugins[0].id)).toEqual({
      pluginId: plugins[0].id,
      script,
    });
    expect(await storage.loadPluginCustomStorage()).toEqual(
      source.pluginCustomStorage,
    );
    const startup = await storage.loadStartupData();
    expect(startup?.deferredSettingKeys).not.toContain("plugins");
    expect(startup?.settings.plugins).toBeUndefined();
    database.close();
  });

  it("defers oversized shallow settings and hydrates them on demand", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    const source = buildFullDatabase() as any;
    source.largeStartupProbe = "x".repeat(300 * 1024);
    await storage.replaceDatabase(source);

    const loaded = await storage.loadStartupData();
    expect(loaded?.status).toBe("ready");
    expect(loaded?.deferredSettingKeys).toContain("largeStartupProbe");
    expect(
      Object.prototype.hasOwnProperty.call(
        loaded?.settings ?? {},
        "largeStartupProbe",
      ),
    ).toBe(false);

    await installStartupData(loaded!, storage);
    expect(
      (settingsStore.getStateRecord() as any).largeStartupProbe,
    ).toBeUndefined();
    await deferredSettingsLoader.ensureKey("largeStartupProbe");
    expect((settingsStore.getStateRecord() as any).largeStartupProbe).toBe(
      source.largeStartupProbe,
    );
    settingsStore.dispose();
    database.close();
  });

  it("runs commits through the native transaction bridge with real SQL", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    const queryLog = (storage as any).__log;

    await storage.replaceDatabase(buildFullDatabase() as any);

    const revision = database
      .prepare(
        "SELECT revision, initialized FROM system_storage_meta WHERE singleton = 1",
      )
      .get() as { revision: number; initialized: number };
    expect(revision.revision).toBe(1);
    expect(revision.initialized).toBe(1);
    // The capacitor path batches the commit inside beginTransaction/commit.
    expect(
      queryLog.entries.some((e: any) => e.kind === "run" && e.sql === "BEGIN"),
    ).toBe(true);
    expect(
      queryLog.entries.some((e: any) => e.kind === "run" && e.sql === "COMMIT"),
    ).toBe(true);
    database.close();
  });

  it("reports monotonic SQL restore progress with an exact statement total", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);
    const progress: number[] = [];
    const statuses: string[] = [];

    const source = buildFullDatabase() as any;
    source.characters[0].tags = Array.from({ length: 520 }, (_, index) =>
      index % 3 === 0 ? null : `tag-${index}`,
    );
    source.customModels = Array.from({ length: 300 }, (_, index) => ({
      id: `model-${index}`,
      name: `Model ${index}`,
    }));
    source.progressSparseProbe = new Array(300);
    source.progressSparseProbe[0] = "first";
    source.progressSparseProbe[299] = "last";

    await storage.replaceDatabase(source, (status, value) => {
      statuses.push(status);
      if (value !== undefined) progress.push(value);
    });

    expect(progress[0]).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]).toBeGreaterThanOrEqual(progress[index - 1]);
    }
    const plan = statuses.find((status) =>
      status.startsWith("SQL restore plan ready"),
    );
    expect(plan).toMatch(/\(\d+ statements\)$/);
    const finalApplying = statuses
      .filter((status) => status.startsWith("Applying SQL"))
      .at(-1);
    expect(finalApplying).toMatch(/\((\d+)\/(\d+) streamed, \1\/\2 applied\)$/);
    database.close();
  });

  it("streams restore statements instead of collecting a complete transaction payload", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);

    // The shared Tauri path buffers a statement array for one native invoke.
    // Android must bypass that method and execute each statement inside the
    // already-open Capacitor transaction to keep restore memory bounded.
    (storage as any).executeNativeTransaction = async () => {
      throw new Error("buffered transaction path must not be used");
    };

    const source = buildFullDatabase() as any;
    source.personas = [
      { name: "One", icon: "assets/one.png", personaPrompt: "one", note: "" },
      { name: "Two", icon: "assets/two.png", personaPrompt: "two", note: "" },
      { name: "Three", icon: "", personaPrompt: "three", note: "" },
    ];
    source.modules = [
      { id: "module-1", name: "First module", lorebook: [] },
      { id: "module-2", name: "Second module", lorebook: [] },
    ];
    source.botPresets = [
      { ...structuredClone(presetTemplate), name: "First preset" },
      { ...structuredClone(presetTemplate), name: "Second preset" },
    ];
    source.botPresetsId = 1;
    source.mainPrompt = "restored prompt";

    await expect(storage.replaceDatabase(source)).resolves.toBe(true);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM characters").get(),
    ).toEqual({ count: 2 });
    expect(
      (await storage.loadPersonas()).map((persona) => persona.name),
    ).toEqual(["One", "Two", "Three"]);
    expect((await storage.loadModules()).map((module) => module.name)).toEqual([
      "First module",
      "Second module",
    ]);
    const presets = await storage.listBotPresets();
    expect(presets.map((preset) => preset.name)).toEqual([
      "First preset",
      "Second preset",
    ]);
    expect((await storage.loadPrompts()).mainPrompt).toBe("restored prompt");
    database.close();
  });

  it("restores thousands of Android entities without using the buffered transaction path", async () => {
    const characterCount = 1_200;
    const personaCount = 3_000;
    const moduleCount = 3_000;
    const presetCount = 3_000;
    const database = new DatabaseSync(":memory:");
    database.exec(sqliteSchemaSql);
    const storage = makeCapacitorStorage(database);

    (storage as any).executeNativeTransaction = async () => {
      throw new Error("buffered transaction path must not be used");
    };

    const source = buildFullDatabase() as any;
    source.characters = Array.from({ length: characterCount }, (_, index) => ({
      chaId: `stress-character-${index}`,
      type: "character",
      name: `Stress character ${index}`,
      image: `assets/stress-character-${index}.png`,
      firstMessage: `First message ${index}`,
      chats: [],
    }));
    source.personas = Array.from({ length: personaCount }, (_, index) => ({
      name: `Stress persona ${index}`,
      icon: `assets/stress-persona-${index}.png`,
      personaPrompt: `Persona prompt ${index}`,
      note: `Persona note ${index}`,
      largePortrait: index % 2 === 0,
    }));
    source.modules = Array.from({ length: moduleCount }, (_, index) => ({
      id: `stress-module-${index}`,
      name: `Stress module ${index}`,
      description: `Module description ${index}`,
      lorebook: [],
    }));
    source.botPresets = Array.from({ length: presetCount }, (_, index) => ({
      name: `Stress preset ${index}`,
      image: `assets/stress-preset-${index}.png`,
      apiType: "openai",
      aiModel: `stress-model-${index % 8}`,
      mainPrompt: `Preset prompt ${index}`,
    }));
    source.botPresetsId = presetCount - 1;
    source.mainPrompt = "stress restored prompt";

    await expect(storage.replaceDatabase(source)).resolves.toBe(true);

    expect(
      database.prepare("SELECT COUNT(*) AS count FROM characters").get(),
    ).toEqual({ count: characterCount });
    const personas = await storage.loadPersonas();
    expect(personas).toHaveLength(personaCount);
    expect([
      personas[0].name,
      personas[Math.floor(personaCount / 2)].name,
      personas[personaCount - 1].name,
    ]).toEqual([
      "Stress persona 0",
      `Stress persona ${Math.floor(personaCount / 2)}`,
      `Stress persona ${personaCount - 1}`,
    ]);
    const modules = await storage.loadModules();
    expect(modules).toHaveLength(moduleCount);
    expect(modules[moduleCount - 1].name).toBe(
      `Stress module ${moduleCount - 1}`,
    );
    const presets = await storage.listBotPresets();
    expect(presets).toHaveLength(presetCount);
    expect(presets[0].name).toBe("Stress preset 0");
    expect(presets[Math.floor(presetCount / 2)].name).toBe(
      `Stress preset ${Math.floor(presetCount / 2)}`,
    );
    expect(presets[presetCount - 1].name).toBe(
      `Stress preset ${presetCount - 1}`,
    );
    expect((await storage.loadPrompts()).mainPrompt).toBe(
      "stress restored prompt",
    );
    database.close();
  }, 120_000);
});
