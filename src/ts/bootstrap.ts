import {
  writeFile,
  BaseDirectory,
  readFile,
  exists,
  mkdir,
  readDir,
  remove,
} from "@tauri-apps/plugin-fs";
import { changeFullscreen, checkNullish, sleep } from "./util";
import { v4 as uuidv4 } from "uuid";
import { get } from "svelte/store";
import { defaultSdDataFunc } from "./storage/presetDefaults";
import {
  createActivePresetSnapshot,
  setPreset,
} from "./storage/presetService";
import type { Database } from "./storage/schema";
import { installStartupData } from "./storage/databaseLifecycle";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  syncMobileGUI,
  botMakerMode,
  selectedCharID,
  loadedStore,
  LoadingStatusState,
  sqlConfiguredStore,
  startupPhase,
} from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import {
  alertError,
  alertMd,
  alertTOS,
  waitAlert,
  alertConfirm,
  alertInput,
  alertSelect,
  alertNormal,
} from "./alert";
import {
  defaultJailbreak,
  defaultMainPrompt,
  oldJailbreak,
  oldMainPrompt,
} from "./storage/defaultPrompts";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { changeLanguage, language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import {
  getRemoteSaveCleanupAction,
  getRemoteSavePayloadName,
} from "./storage/remoteSaveCleanup";
import {
  forageStorage,
  getDbBackups,
  getUncleanables,
  getBasename,
  setUsingSw,
  checkCharOrder,
  prepareNativeThumbnails,
  getPreparedNativeThumbnailSrc,
} from "./globalApi.svelte";
import { isCapacitor, isNodeServer, isTauri } from "./platform";
import { checkRisuUpdate } from "./update";
import { registerModelDynamic } from "./model/modellist";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { getSqlStorage } from "./storage/sqlStorageFactory";
import type { ISqlStorage, INodeSqlStorageAdmin } from "./storage/ISqlStorage";
import { isNodeSqlStorageAdmin } from "./storage/ISqlStorage";
import {
  checkAndMigrateLegacyDatabase,
  migrateLegacyDatabase,
} from "./storage/migration";
import { moduleStore } from "./stores/domain/moduleStore.svelte";
import { settingsStore } from "./stores/domain/settingsStore.svelte";
import { deferredSettingsLoader } from "./stores/domain/deferredSettingsLoader";
import { characterStore } from "./stores/domain/characterStore.svelte";
import { presetStore } from "./stores/domain/presetStore.svelte";
import { personaStore } from "./stores/domain/personaStore.svelte";
import { setSqlRuntime, getSqlRuntime } from "./storage/sqlRuntime";
import { initDurableModelJobRecovery } from "./process/modelJobRecovery";
import { initNodeRealtimeSync } from "./process/nodeRealtimeSync";

const appWindow = isTauri ? getCurrentWebviewWindow() : null;
const startupThumbnailWarmers: HTMLImageElement[] = [];

async function prepareAndroidCharacterThumbnails() {
  if (!isCapacitor) return;

  const keys = new Set<string>();
  const addImage = (value: unknown) => {
    if (
      typeof value === "string" &&
      /\.(?:png|jpe?g|webp|avif|heic|heif|bmp)$/i.test(value)
    ) {
      keys.add(value);
    }
  };

  const imageByCharacterId = new Map(
    (characterStore.characters ?? []).map(
      (character) => [character?.chaId, character?.image] as const,
    ),
  );
  for (const item of settingsStore.state.characterOrder ?? []) {
    if (typeof item === "string") {
      addImage(imageByCharacterId.get(item));
    } else if (item && typeof item === "object") {
      addImage((item as any).imgFile);
      for (const id of (item as any).data ?? [])
        addImage(imageByCharacterId.get(id));
    }
  }
  for (const character of characterStore.characters ?? [])
    addImage(character?.image);

  const images = [...keys];
  if (images.length === 0) return;

  const batchSize = 64;
  let created = 0;
  let cached = 0;
  let missing = 0;
  let failed = 0;
  for (let offset = 0; offset < images.length; offset += batchSize) {
    const batch = images.slice(offset, offset + batchSize);
    LoadingStatusState.text = `Preparing Character Thumbnails... ${offset}/${images.length}`;
    try {
      const result = await prepareNativeThumbnails(batch, 128, 128);
      created += result.created;
      cached += result.cached;
      missing += result.missing;
      failed += result.failed;
    } catch (error) {
      console.warn("[Startup] Failed to prepare native thumbnail batch", error);
      failed += batch.length;
    }
  }
  LoadingStatusState.text = `Preparing Character Thumbnails... ${images.length}/${images.length}`;

  if (typeof Image !== "undefined") {
    LoadingStatusState.text = "Warming Character Icons...";
    startupThumbnailWarmers.length = 0;
    await Promise.all(
      images.slice(0, 16).map(async (loc) => {
        const src = getPreparedNativeThumbnailSrc(loc);
        if (!src) return;
        const image = new Image();
        image.decoding = "async";
        image.src = src;
        startupThumbnailWarmers.push(image);
        try {
          await image.decode();
        } catch {
          // A missing/corrupt icon falls back through the normal lazy path later.
        }
      }),
    );
  }

  console.info("[Startup] Android character thumbnails ready", {
    total: images.length,
    created,
    cached,
    missing,
    failed,
  });
}

/**
 * Loads the application data.
 *
 * SQL-only flow:
 *   1. Get the environment-appropriate SQL storage backend.
 *   2. Initialise it (open DB, apply schema).
 *   3. If SQL DB is empty but a legacy database.bin exists, offer migration.
 *   4. Load the database (shallow — characters/chats lazy-loaded on demand).
 *   5. Continue with plugins, format checks, etc.
 *
 * If SQL initialisation fails (e.g. browser without OPFS support), the user
 * is shown an incompatibility warning and the app does not proceed.
 */
export async function loadData() {
  const loaded = get(loadedStore);
  if (!loaded) {
    try {
      startupPhase.set("core-loading");
      // ── Step 0: Initialise forageStorage (needed for asset access
      // and Node server's NodeStorage which provides the SQL admin) ──
      if (!isTauri) {
        await forageStorage.Init();
      }

      // ── Step 1: Initialise SQL storage backend ────────────────────
      LoadingStatusState.text = "Initialising Database...";
      const storage = await getSqlStorage();
      setSqlRuntime(storage);
      const ok = await storage.init();
      if (!ok) {
        // SQL backend could not be initialised.
        if (isNodeServer && isNodeSqlStorageAdmin(storage)) {
          // Node server: show SQL configuration UI
          sqlConfiguredStore.set(false);
          LoadingStatusState.text = "SQL storage not configured";
          // The SQL settings gate UI will be shown by the app
          // (loadedStore stays false → app blocked until configured)
          return;
        }
        if (isTauri || isCapacitor) {
          const nativeError =
            typeof (storage as any).getLastInitError === "function"
              ? (storage as any).getLastInitError()
              : null;
          alertError(
            nativeError
              ? `Failed to initialize native SQLite storage: ${nativeError}`
              : "Failed to initialize native SQLite storage. Please check the application logs for details.",
          );
        } else {
          alertError(
            "This browser does not support SQLite WASM (OPFS required). Please use a modern browser.",
          );
        }
        return;
      }

      // ── Step 2: Load startup domains ─────────────────────────────
      LoadingStatusState.text = "Loading Database...";
      let startup = await storage.loadStartupData();
      if (!startup) {
        throw new Error("SQL storage returned no startup data");
      }

      if (startup.status === "empty") {
        // ── Step 3: Check for legacy migration ──────────────────────
        LoadingStatusState.text = "Checking for Legacy Data...";
        const legacyDb = await checkAndMigrateLegacyDatabase(storage);
        if (legacyDb) {
          const shouldMigrate = await alertConfirm(
            language.migrateLocalToSqlPrompt,
          );
          if (shouldMigrate) {
            LoadingStatusState.text = "Migrating Local Data to SQL...";
            const success = await migrateLegacyDatabase(
              storage,
              legacyDb,
              (status) => {
                LoadingStatusState.text = status;
              },
            );
            if (success) {
              alertNormal(language.migrateLocalToSqlSuccess);
            } else {
              alertError("Migration failed. Your legacy data is preserved.");
            }
          }
        }
        LoadingStatusState.text = "Loading Database...";
        startup = await storage.loadStartupData();
        if (!startup) {
          throw new Error("SQL storage returned no startup data after migration");
        }
      }

      installStartupData(startup, storage);

      const activeDb = settingsStore.state;

      // Non-English dictionaries are separate chunks. Resolve the one
      // selected by this database before mounting the application so
      // every component sees the final language on its first render.
      await changeLanguage(activeDb.language);
      performance.mark("core-ready");

      // ── Node server: update SQL config state ──────────────────────
      if (isNodeServer && isNodeSqlStorageAdmin(storage)) {
        sqlConfiguredStore.set(storage.isEnabled());
      }

      // ── Step 5: Drive sync check ──────────────────────────────────
      LoadingStatusState.text = "Checking Drive Sync...";
      const { checkDriverInit } = await import("./drive/drive");
      const isDriverMode = await checkDriverInit();
      if (isDriverMode) {
        return;
      }

      // Android sidebar icons use persistent 128px native thumbnails. Build any
      // missing ones while the startup screen is still visible so opening the
      // sidebar never has to compete with decode/resize/WebP work.
      await prepareAndroidCharacterThumbnails();

      updateColorScheme();
      updateTextThemeAndCSS();
      updateAnimationSpeed();
      updateHeightMode();
      updateGuisize();
      syncMobileGUI(activeDb.betaMobileGUI);
      if (activeDb.botSettingAtStart) {
        botMakerMode.set(true);
      }
      // Reset the initial selection before the shell becomes interactive.
      // Doing this later can overwrite a character the user selected while
      // the remaining startup work is still loading.
      selectedCharID.set(-1);
      const deferShellUntilRuntimeReady =
        settingsStore.state.lowSpecMode === true;
      let shellReady = false;
      const revealShell = () => {
        if (shellReady) return;
        shellReady = true;
        loadedStore.set(true);
        startupPhase.set("shell-ready");
        performance.mark("shell-ready");
      };
      if (!deferShellUntilRuntimeReady) {
        revealShell();
      }

      // ── Step 6: Service worker (web only) ─────────────────────────
      LoadingStatusState.text = "Checking Service Worker...";
      const serviceWorkerReady =
        !isCapacitor && navigator.serviceWorker
          ? registerSw()
              .then(() => setUsingSw(true))
              .catch(() => setUsingSw(false))
          : Promise.resolve(setUsingSw(false));
      if (settingsStore.state.didFirstSetup) {
        const urlParams = new URLSearchParams(location.search);
        if (urlParams.has("realm") || urlParams.has("charahub")) {
          const { characterURLImport } = await import("./characterCards");
          void characterURLImport();
        }
      }

      // ── Step 7: Plugins, format checks, state updates ─────────────
      LoadingStatusState.text = "Loading chat runtime...";
      const presetReady = presetStore
        .init(storage)
        .then(async () => {
          let activePreset = presetStore.activePreset;
          // Older SQL migrations copied the stale botPresets entry without
          // folding in the live root value for the active preset. Repair that
          // representation before setPreset can blank the visible setting.
          const liveModuleIntegration = settingsStore.state.moduleIntergration;
          if (
            activePreset &&
            activePreset.moduleIntergration === undefined &&
            typeof liveModuleIntegration === "string" &&
            liveModuleIntegration.length > 0
          ) {
            await presetStore.savePreset({
              ...activePreset,
              moduleIntergration: liveModuleIntegration,
            });
            activePreset = presetStore.activePreset;
          }
          if (activePreset) {
            settingsStore.hydrate((state) =>
              setPreset(state, activePreset),
            );
            const presetOwnedDeferredKeys = [
              "promptTemplate",
              "promptSettings",
              "customPromptTemplateToggle",
              ...(activePreset.mainPrompt !== undefined ? ["mainPrompt"] : []),
              ...(activePreset.jailbreak !== undefined ? ["jailbreak"] : []),
              ...(activePreset.globalNote !== undefined ? ["globalNote"] : []),
              ...(activePreset.autoSuggestPrompt !== undefined
                ? ["autoSuggestPrompt"]
                : []),
              ...(activePreset.instructChatTemplate !== undefined
                ? ["instructChatTemplate"]
                : []),
              ...(activePreset.JinjaTemplate !== undefined
                ? ["JinjaTemplate"]
                : []),
            ];
            deferredSettingsLoader.markLoaded(presetOwnedDeferredKeys);
            presetStore.bindActivePresetProvider(() => {
              const metadata = presetStore.activePresetMetadata;
              return metadata
                ? createActivePresetSnapshot(settingsStore.state, metadata)
                : undefined;
            });
          }
          performance.mark("active-preset-ready");
        })
        .catch(() => undefined);
      // Keep heavyweight relational settings out of one giant Capacitor result.
      // The Android bridge serializes every returned row to JSON, so hydrate
      // startup domains sequentially to limit temporary peak memory.
      const runtimeSettingsReady = (async () => {
        await deferredSettingsLoader.ensureKey("customModels");

        // Domain stores load their own state; SettingsStore never receives it.
        // Persona hydration is correctness-critical because prompts depend on it.
        await personaStore.init(storage);

        // The remaining runtime extras retain their historical best-effort
        // behavior. Persona hydration above deliberately stays outside this catch.
        try {
          await moduleStore.init(storage);

          settingsStore.hydratePluginCustomStorageKeys(
            await storage.listPluginCustomStorageKeys(),
          );
          await loadPlugins();
        } catch {}
      })();
      await Promise.all([presetReady, runtimeSettingsReady, serviceWorkerReady]);
      try {
        const standaloneNavigator = window.navigator as Navigator & {
          standalone?: boolean;
        };
        const isInStandaloneMode =
          window.matchMedia("(display-mode: standalone)").matches ||
          standaloneNavigator.standalone === true ||
          document.referrer.includes("android-app://");
        if (isInStandaloneMode) {
          await navigator.storage.persist();
        }
      } catch (error) {}
      LoadingStatusState.text = "Checking For Format Update...";
      await checkNewFormat();
      const db = settingsStore.state;

      LoadingStatusState.text = "Updating States...";
      updateErrorHandling();
      if (
        !localStorage.getItem("nightlyWarned") &&
        window.location.hostname === "nightly.risuai.xyz"
      ) {
        alertMd(language.nightlyWarning);
        await waitAlert();
        //for testing, leave empty
        localStorage.setItem("nightlyWarned", "");
      }
      assignIds();
      startObserveDom();
      registerModelDynamic();
      performance.mark("plugins-ready");
      cleanChunks();
      initDurableModelJobRecovery();
      void initNodeRealtimeSync();
      revealShell();
      if (presetStore.activeStatus === "ready") {
        startupPhase.set("chat-ready");
        performance.mark("chat-ready");
      }
      alertTOS().then((a) => {
        if (a === false) {
          location.reload();
          return;
        }
        if (isTauri || isCapacitor) {
          void checkRisuUpdate();
        }
      });
    } catch (error) {
      alertError(error);
    }
  }
}

/**
 * Registers the service worker and initializes it.
 */
async function registerSw() {
  const reg = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
  });
  try {
    await reg.update();
  } catch {}
  await sleep(100);
  const da = await fetch("/sw/init");
  if (!(da.status >= 200 && da.status < 300)) {
    location.reload();
  }
}

/**
 * Updates the error handling by adding custom handlers for errors and unhandled promise rejections.
 */
function updateErrorHandling() {
  const errorHandler = (event: ErrorEvent) => {
    console.error(event.error);
    if (event.error && !(event.error.target instanceof Worker)) {
      alertError(event.error);
    }
  };
  const rejectHandler = (event: PromiseRejectionEvent) => {
    console.error(event.reason);
    alertError(event.reason);
  };
  window.addEventListener("error", errorHandler);
  window.addEventListener("unhandledrejection", rejectHandler);
}

/**
 * Updates the height mode of the document based on the value stored in the database.
 */
function updateHeightMode() {
  const db = settingsStore.state;
  const root = document.querySelector(":root") as HTMLElement;
  switch (db.heightMode) {
    case "auto":
      root.style.setProperty("--risu-height-size", "100%");
      break;
    case "vh":
      root.style.setProperty("--risu-height-size", "100vh");
      break;
    case "dvh":
      root.style.setProperty("--risu-height-size", "100dvh");
      break;
    case "lvh":
      root.style.setProperty("--risu-height-size", "100lvh");
      break;
    case "svh":
      root.style.setProperty("--risu-height-size", "100svh");
      break;
    case "percent":
      root.style.setProperty("--risu-height-size", "100%");
      break;
  }
}

/**
 * Checks and updates the database format to the latest version.
 */
async function checkNewFormat(): Promise<void> {
  // Runtime storage is SQL-only. Legacy aggregate migrations are completed
  // before startup data is installed, so format checks must never reach into
  // domain-owned state through SettingsStore.
  checkCharOrder();
}

/**
 * Purges chunks of data that are not needed.
 */
async function cleanChunks(
  options: {
    cleanColdStorage?: boolean;
  } = {},
) {
  const cleanColdStorage = options.cleanColdStorage ?? false;
  const db = settingsStore.state;
  // SQL startup intentionally keeps character details lazy. A destructive
  // asset sweep cannot prove that images referenced by unhydrated fields
  // (emotionImages/additionalAssets/VITS/etc.) are unused, so never delete
  // local assets from a partial SQL snapshot.
  if (isNodeServer || getSqlRuntime().isSql) {
    return;
  }
  if (db.coldstorage && !cleanColdStorage) {
    return;
  }

  const uncleanable = new Set(
    await getUncleanables(db as Database, "basename", {
      chars: characterStore.characters,
    }),
  );
  if (isTauri) {
    const assets = await readDir("assets", { baseDir: BaseDirectory.AppData });
    console.log(assets);
    for (const asset of assets) {
      try {
        const n = getBasename(asset.name);
        if (!uncleanable.has(n)) {
          await remove("assets/" + asset.name, {
            baseDir: BaseDirectory.AppData,
          });
        }
      } catch (error) {
        console.log("error", asset.name);
      }
    }

    if (!(await exists("remotes", { baseDir: BaseDirectory.AppData }))) {
      await mkdir("remotes", { baseDir: BaseDirectory.AppData });
    }

    const remotes = await readDir("remotes", {
      baseDir: BaseDirectory.AppData,
    });

    const remoteUncleanables = new Set<string>(
      characterStore.characters.map((v) => v.chaId),
    );
    for (const remote of remotes) {
      try {
        const remoteFileName = getBasename(remote.name);
        const remotePayloadName = getRemoteSavePayloadName(remoteFileName);
        if (!remotePayloadName) {
          continue;
        }
        const fexists = remoteUncleanables.has(remotePayloadName);
        if (!fexists) {
          const metaPath = "remotes/" + remote.name + ".meta";
          let metaExists = false;
          let metaLastUsed: unknown;
          try {
            metaExists = await exists(metaPath, {
              baseDir: BaseDirectory.AppData,
            });
            if (metaExists) {
              const meta = await readFile(metaPath, {
                baseDir: BaseDirectory.AppData,
              });
              const metaJson = JSON.parse(new TextDecoder().decode(meta));
              metaLastUsed = metaJson.lastUsed;
            }
          } catch (error) {}

          const cleanupAction = getRemoteSaveCleanupAction({
            fileName: remoteFileName,
            activeCharacterIds: remoteUncleanables,
            hasMeta: metaExists,
            metaLastUsed,
          });
          if (cleanupAction === "create-meta") {
            const metaJson = {
              lastUsed: Date.now(),
            };
            await writeFile(
              metaPath,
              new TextEncoder().encode(JSON.stringify(metaJson)),
              { baseDir: BaseDirectory.AppData },
            );
          } else if (cleanupAction === "delete") {
            await remove("remotes/" + remote.name, {
              baseDir: BaseDirectory.AppData,
            });
            await remove(metaPath, { baseDir: BaseDirectory.AppData });
          }
        }
      } catch (error) {
        console.log("error", remote.name);
      }
    }
  } else {
    const indexes = await forageStorage.keys();
    const characterIds = new Set<string>(
      characterStore.characters.map((v) => v.chaId),
    );
    for (const asset of indexes) {
      if (asset.startsWith("assets/")) {
        const n = getBasename(asset);
        if (!uncleanable.has(n)) {
          await forageStorage.removeItem(asset);
        }
      } else if (asset.endsWith(".meta")) {
        continue;
      } else if (asset.startsWith("remotes/")) {
        const name = getBasename(asset).slice(0, -10); //remove .local.bin
        const exists = characterIds.has(name);
        if (!exists) {
          let okayToDelete = false;
          try {
            const metaPath = asset + ".meta";
            const metaExists = (await forageStorage.keys()).includes(metaPath);
            if (metaExists) {
              const metaData: Uint8Array = (await forageStorage.getItem(
                metaPath,
              )) as unknown as Uint8Array;
              const metaJson = JSON.parse(new TextDecoder().decode(metaData));
              const lastUsed = metaJson.lastUsed as number;
              if (Date.now() - lastUsed > 1000 * 60 * 60 * 24 * 7) {
                //not used for 7 days
                okayToDelete = true;
              }
            } else {
              //write meta for next time
              const metaJson = {
                lastUsed: Date.now(),
              };
              await forageStorage.setItem(
                metaPath,
                new TextEncoder().encode(JSON.stringify(metaJson)),
              );
            }
          } catch (error) {}
          if (okayToDelete) {
            await forageStorage.removeItem(asset);
          }
        }
      }
    }
  }
}

/**
 * Assigns unique IDs to characters and chats.
 */
function assignIds() {
  const characters = characterStore.characters;
  if (!characters) {
    return;
  }
  const assignedIds = new Set<string>();
  for (const cha of characters) {
    if (!cha) {
      continue;
    }
    if (!cha.chaId) {
      cha.chaId = uuidv4();
    }
    if (assignedIds.has(cha.chaId)) {
      console.warn(`Duplicate chaId found: ${cha.chaId}. Assigning new ID.`);
      cha.chaId = uuidv4();
    }
    assignedIds.add(cha.chaId);
    // SQL startup may expose character metadata before its chats have
    // been hydrated. IDs are assigned when those rows are loaded/created.
    for (const chat of cha.chats ?? []) {
      if (!chat) {
        continue;
      }
      if (!chat.id) {
        chat.id = uuidv4();
      }
      if (assignedIds.has(chat.id)) {
        console.warn(`Duplicate chat ID found: ${chat.id}. Assigning new ID.`);
        chat.id = uuidv4();
      }
      assignedIds.add(chat.id);
    }
  }
}
