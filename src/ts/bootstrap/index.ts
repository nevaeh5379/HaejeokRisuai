import { get } from "svelte/store";
import { alertError, alertTOS } from "../alert";
import { changeLanguage } from "../../lang";
import { installStartupData } from "../storage/database/databaseLifecycle";
import { forageStorage } from "../globalApi.svelte";
import { registerModelDynamic } from "../model/modellist";
import { isCapacitor, isTauri } from "../platform";
import { initNodeRealtimeSync } from "../process/nodeRealtimeSync";
import { initDurableModelJobRecovery } from "../process/modelJobRecovery";
import { checkRisuUpdate } from "../update";
import { startObserveDom } from "../observer.svelte";
import {
  LoadingStatusState,
  botMakerMode,
  loadedStore,
  selectedCharID,
  startupPhase,
} from "../stores.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { prepareAndroidCharacterThumbnails } from "./androidThumbnails";
import { applyStartupAppearance } from "./appAppearance";
import { cleanChunks } from "./assetCleanup";
import { checkNewFormat, assignIds } from "./formatChecks";
import { migrateLegacyDataIfNeeded } from "./legacyMigration";
import { initPresetDomain } from "./presetStartup";
import { initRuntimeSettings } from "./runtimeSettings";
import { createShellRevealer } from "./shellReveal";
import { startServiceWorker } from "./serviceWorker";
import {
  initSqlStorageOrGate,
  reportNodeSqlConfigured,
} from "./sqlStartupGate";
import {
  persistStorageIfStandalone,
  updateErrorHandling,
  warnNightlyIfNeeded,
} from "./startupUiChecks";

/**
 * Loads the application data.
 *
 * SQL-only flow:
 *   1. Get the environment-appropriate SQL storage backend (gates startup
 *      when unconfigured on Node or unsupported in the browser).
 *   2. If SQL DB is empty but a legacy database exists, offer migration.
 *   3. Load the database (shallow — characters/chats lazy-loaded on demand).
 *   4. Apply appearance settings, reveal the shell, then continue with the
 *      chat runtime (presets, plugins, format checks, asset cleanup...).
 *
 * Per-step logic lives in the sibling modules of this directory; this
 * function only orchestrates the startup pipeline and owns the exact
 * ordering (and early returns) of its steps.
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
      const storage = await initSqlStorageOrGate();
      if (!storage) {
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
        await migrateLegacyDataIfNeeded(storage);
        LoadingStatusState.text = "Loading Database...";
        startup = await storage.loadStartupData();
        if (!startup) {
          throw new Error(
            "SQL storage returned no startup data after migration",
          );
        }
      }

      installStartupData(startup, storage);
      await initPresetDomain(storage);

      // Non-English dictionaries are separate chunks. Resolve the one
      // selected by this database before mounting the application so
      // every component sees the final language on its first render.
      await changeLanguage(settingsStore.state.language);
      performance.mark("core-ready");

      // ── Node server: update SQL config state ──────────────────────
      reportNodeSqlConfigured(storage);

      // ── Step 5: Drive sync check ──────────────────────────────────
      LoadingStatusState.text = "Checking Drive Sync...";
      const { checkDriverInit } = await import("../drive/drive");
      const isDriverMode = await checkDriverInit();
      if (isDriverMode) {
        return;
      }

      await prepareAndroidCharacterThumbnails();

      applyStartupAppearance();
      if (settingsStore.state.botSettingAtStart) {
        botMakerMode.set(true);
      }
      // Reset the initial selection before the shell becomes interactive.
      // Doing this later can overwrite a character the user selected while
      // the remaining startup work is still loading.
      selectedCharID.set(-1);
      const revealShell = createShellRevealer();

      // ── Step 6: Service worker (web only) ─────────────────────────
      const serviceWorkerReady = startServiceWorker();
      if (settingsStore.state.didFirstSetup) {
        const urlParams = new URLSearchParams(location.search);
        if (urlParams.has("realm") || urlParams.has("charahub")) {
          const { characterURLImport } = await import("../characterCards");
          void characterURLImport();
        }
      }

      // ── Step 7: Plugins, format checks, state updates ─────────────
      LoadingStatusState.text = "Loading chat runtime...";
      const runtimeSettingsReady = initRuntimeSettings(storage);
      await Promise.all([runtimeSettingsReady, serviceWorkerReady]);

      await persistStorageIfStandalone();
      LoadingStatusState.text = "Checking For Format Update...";
      await checkNewFormat();

      LoadingStatusState.text = "Updating States...";
      updateErrorHandling();
      await warnNightlyIfNeeded();
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
