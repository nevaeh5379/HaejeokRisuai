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
import {
  setDatabase,
  defaultSdDataFunc,
  getDatabase,
  setPreset,
  type Database,
} from "./storage/database.svelte";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  MobileGUI,
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
import { initMobileGesture } from "./hotkey";
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
} from "./globalApi.svelte";
import { isNodeServer, isTauri } from "./platform";
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
import { characterStore } from "./stores/domain/characterStore.svelte";
import { presetStore } from "./stores/domain/presetStore.svelte";
import { setSqlRuntime, getSqlRuntime } from "./storage/sqlRuntime";

const appWindow = isTauri ? getCurrentWebviewWindow() : null;

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
        // Web/Tauri: SQLite should always work on modern browsers
        alertError(
          "This browser does not support SQLite WASM (OPFS required). Please use a modern browser.",
        );
        return;
      }

      // ── Step 2: Load database (shallow) ───────────────────────────
      LoadingStatusState.text = "Loading Database...";
      const loadResult = await storage.loadDatabase({ shallow: true });

      if (loadResult && loadResult.status === "empty") {
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
        // Reload after potential migration
        LoadingStatusState.text = "Loading Database...";
        const reloaded = await storage.loadDatabase({ shallow: true });
        if (reloaded && reloaded.database) {
          setDatabase(reloaded.database, storage);
        } else {
          // Still empty — start with blank DB
          setDatabase({} as Database, storage);
        }
      } else if (loadResult && loadResult.database) {
        setDatabase(loadResult.database, storage);
      } else {
        // Load failed entirely
        setDatabase({} as Database, storage);
      }

      const activeDb = getDatabase();

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

      updateColorScheme();
      updateTextThemeAndCSS();
      updateAnimationSpeed();
      updateHeightMode();
      updateGuisize();
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
      const serviceWorkerReady = navigator.serviceWorker
        ? registerSw()
            .then(() => setUsingSw(true))
            .catch(() => setUsingSw(false))
        : Promise.resolve(setUsingSw(false));
      if (getDatabase().didFirstSetup) {
        const urlParams = new URLSearchParams(location.search);
        if (urlParams.has("realm") || urlParams.has("charahub")) {
          const { characterURLImport } = await import("./characterCards");
          void characterURLImport();
        }
      }

      // ── Step 7: Plugins, format checks, state updates ─────────────
      LoadingStatusState.text = "Loading chat runtime...";
      const presetReady = presetStore
        .init(storage, activeDb.activeBotPresetId)
        .then(() => {
          if (presetStore.activePreset)
            settingsStore.hydrate((state) =>
              setPreset(state as Database, presetStore.activePreset!),
            );
          performance.mark("active-preset-ready");
        })
        .catch(() => undefined);
      const pluginsReady = Promise.all([
        storage.loadPlugins(),
        storage.listPluginCustomStorageKeys(),
        storage.loadModules(),
        storage.loadSettingKey("customModels"),
        storage.loadPersonas(),
        storage.loadSettingKey("personaPrompt"),
      ])
        .then(
          async ([
            plugins,
            pluginCustomStorageKeys,
            modules,
            customModels,
            personas,
            personaPrompt,
          ]) => {
            settingsStore.hydrate((state) => {
              state.plugins = plugins ?? [];
              if (customModels !== undefined) state.customModels = customModels;
              state.personas = personas;
              state.personaPrompt =
                personaPrompt ??
                personas[state.selectedPersona]?.personaPrompt ??
                "";
            });
            settingsStore.hydratePluginCustomStorageKeys(
              pluginCustomStorageKeys,
            );
            moduleStore.init(modules ?? [], activeDb.enabledModules ?? []);
            await loadPlugins();
          },
        )
        .catch(() => undefined);
      await Promise.all([presetReady, pluginsReady, serviceWorkerReady]);
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
      const db = getDatabase();

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
      if (db.botSettingAtStart) {
        botMakerMode.set(true);
      }
      if (
        (db.betaMobileGUI && window.innerWidth <= 800) ||
        import.meta.env.VITE_RISU_LITE === "TRUE"
      ) {
        initMobileGesture();
        MobileGUI.set(true);
      }
      assignIds();
      startObserveDom();
      registerModelDynamic();
      performance.mark("plugins-ready");
      cleanChunks();
      revealShell();
      if (presetStore.activeStatus === "ready") {
        startupPhase.set("chat-ready");
        performance.mark("chat-ready");
      }
      alertTOS().then((a) => {
        if (a === false) {
          location.reload();
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
    if (!(event.error.target instanceof Worker)) {
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
  const db = getDatabase();
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
  let db = getDatabase();

  // Legacy file migrations operate on complete snapshots. SQL data is
  // migrated by the storage schema/codec and may only contain shallow
  // entities here; walking it would hydrate every deferred domain.
  if (getSqlRuntime().isSql) {
    checkCharOrder();
    return;
  }

  // Check data integrity
  db.characters = db.characters
    .map((v) => {
      if (!v) {
        return null;
      }
      v.chaId ??= uuidv4();
      v.type ??= "character";
      v.chatPage ??= 0;
      v.chats ??= [];
      v.customscript ??= [];
      v.firstMessage ??= "";
      v.globalLore ??= [];
      v.name ??= "";
      v.viewScreen ??= "none";
      v.emotionImages = v.emotionImages ?? [];

      if (v.type === "character") {
        v.bias ??= [];
        v.characterVersion ??= "";
        v.creator ??= "";
        v.desc ??= "";
        v.utilityBot ??= false;
        v.tags ??= [];
        v.systemPrompt ??= "";
        v.scenario ??= "";
      }
      return v;
    })
    .filter((v) => {
      return v !== null;
    });

  db.modules = await Promise.all(
    (db.modules ?? []).map(async (v) => {
      if (v?.lorebook) {
        if (!Array.isArray(v.lorebook)) {
          console.error("Critical: Invalid lorebook format detected in module");
          console.error("Module data:", JSON.stringify(v, null, 2));

          // Alert user about corrupted data
          alertError(
            language.bootstrap.dataCorruptionDetected(
              v.name || "Unknown",
              typeof v.lorebook,
            ),
          );
          await waitAlert();

          // Ask if user wants to report the issue
          const shouldReport = await alertConfirm(
            language.bootstrap.reportErrorQuestion,
          );

          if (shouldReport) {
            try {
              // Collect diagnostic information (without personal data)
              const diagnosticInfo = {
                timestamp: new Date().toISOString(),
                moduleName: v.name || "Unknown",
                lorebookType: typeof v.lorebook,
                lorebookValue: JSON.stringify(v.lorebook).substring(0, 500), // First 500 chars only
                isArray: Array.isArray(v.lorebook),
                keys: v.lorebook ? Object.keys(v.lorebook).join(", ") : "N/A",
                formatVersion: db.formatversion || "Unknown",
              };

              // Show the diagnostic info and allow user to copy or send
              const reportData = JSON.stringify(diagnosticInfo, null, 2);
              await alertMd(
                language.bootstrap.diagnosticInformation(reportData),
              );
              await waitAlert();

              console.log(
                "Diagnostic information for developers:",
                diagnosticInfo,
              );
            } catch (reportError) {
              console.error(
                "Failed to generate diagnostic report:",
                reportError,
              );
            }
          }

          // Ask if user wants to reset the data
          const shouldReset = await alertConfirm(
            language.bootstrap.resetLorebookQuestion,
          );

          if (shouldReset) {
            v.lorebook = [];
            console.log("Lorebook reset to empty array by user choice");
          } else {
            console.warn("User chose to keep corrupted lorebook data");
          }
        } else {
          const { updateLorebooks } = await import("./characters");
          v.lorebook = updateLorebooks(v.lorebook);
        }
      }
      return v;
    }),
  );

  db.modules = db.modules.filter((v) => {
    return v !== null && v !== undefined;
  });

  db.personas = (db.personas ?? [])
    .map((v) => {
      v.id ??= uuidv4();
      v.largePortrait ??= false;
      return v;
    })
    .filter((v) => {
      return v !== null && v !== undefined;
    });

  if (db.personas.length === 0) {
    db.personas.push({
      name: db.username || "User",
      icon: db.userIcon || "",
      personaPrompt: "",
      note: db.userNote || "",
      largePortrait: false,
      id: uuidv4(),
    });
  }
  if (
    typeof db.selectedPersona !== "number" ||
    db.selectedPersona < 0 ||
    db.selectedPersona >= db.personas.length
  ) {
    db.selectedPersona = 0;
  }

  if (!db.formatversion) {
    function checkClean(data: string) {
      if (data.startsWith("assets") || data.length < 3) {
        return data;
      } else {
        const d = "assets/" + data.replace(/\\/g, "/").split("assets/")[1];
        if (!d) {
          return data;
        }
        return d;
      }
    }

    db.customBackground = checkClean(db.customBackground);
    db.userIcon = checkClean(db.userIcon);

    for (let i = 0; i < db.characters.length; i++) {
      if (db.characters[i].image) {
        db.characters[i].image = checkClean(db.characters[i].image);
      }
      if (db.characters[i].emotionImages) {
        for (let i2 = 0; i2 < db.characters[i].emotionImages.length; i2++) {
          if (
            db.characters[i].emotionImages[i2] &&
            db.characters[i].emotionImages[i2].length >= 2
          ) {
            db.characters[i].emotionImages[i2][1] = checkClean(
              db.characters[i].emotionImages[i2][1],
            );
          }
        }
      }
    }

    db.formatversion = 2;
  }
  if (db.formatversion < 3) {
    for (let i = 0; i < db.characters.length; i++) {
      let cha = db.characters[i];
      if (cha.type === "character") {
        if (checkNullish(cha.sdData)) {
          cha.sdData = defaultSdDataFunc();
        }
      }
    }

    db.formatversion = 3;
  }
  if (db.formatversion < 4) {
    //migration removed due to issues
    db.formatversion = 4;
  }
  if (db.formatversion < 5) {
    if (db.loreBookToken < 8000) {
      db.loreBookToken = 8000;
    }
    db.formatversion = 5;
  }
  if (!db.characterOrder) {
    db.characterOrder = [];
  }
  if (db.mainPrompt === oldMainPrompt) {
    db.mainPrompt = defaultMainPrompt;
  }
  if (db.mainPrompt === oldJailbreak) {
    db.mainPrompt = defaultJailbreak;
  }
  for (let i = 0; i < db.characters.length; i++) {
    const trashTime = db.characters[i].trashTime;
    const targetTrashTime = trashTime ? trashTime + 1000 * 60 * 60 * 24 * 3 : 0;
    if (trashTime && targetTrashTime < Date.now()) {
      db.characters.splice(i, 1);
      i--;
    }
  }
  setDatabase(db);
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
  const db = getDatabase();
  if (isNodeServer) {
    return;
  }
  if (db.coldstorage && !cleanColdStorage) {
    return;
  }

  const uncleanable = new Set(await getUncleanables(db));
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
      db.characters.map((v) => v.chaId),
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
    const characterIds = new Set<string>(db.characters.map((v) => v.chaId));
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
