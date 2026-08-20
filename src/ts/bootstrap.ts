import {
    writeFile,
    BaseDirectory,
    readFile,
    exists,
    mkdir,
    readDir,
    remove
} from "@tauri-apps/plugin-fs"
import { changeFullscreen, checkNullish, sleep } from "./util"
import { v4 as uuidv4 } from 'uuid';
import { get } from "svelte/store";
import { setDatabase, defaultSdDataFunc, getDatabase, type Database } from "./storage/database.svelte";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { checkRisuUpdate } from "./update";
import { MobileGUI, botMakerMode, selectedCharID, loadedStore, DBState, LoadingStatusState, sqlConfiguredStore } from "./stores.svelte";
import { loadPlugins } from "./plugins/plugins.svelte";
import { alertError, alertMd, alertTOS, waitAlert, alertConfirm, alertInput, alertSelect, alertNormal } from "./alert";
import { checkDriverInit } from "./drive/drive";
import { characterURLImport } from "./characterCards";
import { defaultJailbreak, defaultMainPrompt, oldJailbreak, oldMainPrompt } from "./storage/defaultPrompts";
import { loadRisuAccountData } from "./drive/accounter";
import { decodeRisuSave, encodeRisuSaveLegacy } from "./storage/risuSave";
import { updateAnimationSpeed } from "./gui/animation";
import { updateColorScheme, updateTextThemeAndCSS } from "./gui/colorscheme";
import { autoServerBackup } from "./kei/backup";
import { language } from "src/lang";
import { startObserveDom } from "./observer.svelte";
import { updateGuisize } from "./gui/guisize";
import { updateLorebooks } from "./characters";
import { initMobileGesture } from "./hotkey";
import { moduleUpdate } from "./process/modules";
import type { AccountStorage } from "./storage/accountStorage";
import { NodeStorage } from "./storage/nodeStorage";
import { makeColdData } from "./process/coldstorage.svelte";
import { getRemoteSaveCleanupAction, getRemoteSavePayloadName } from "./storage/remoteSaveCleanup";
import {
    forageStorage,
    saveDb,
    getDbBackups,
    getUncleanables,
    getBasename,
    setUsingSw,
    checkCharOrder
} from "./globalApi.svelte";
import { isNodeServer, isTauri } from "./platform";
import { registerModelDynamic } from "./model/modellist";
import { convertFileSrc } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";

const appWindow = isTauri ? getCurrentWebviewWindow() : null

/**
 * Loads the application data.
 */
export async function loadData() {
    const loaded = get(loadedStore)
    if (!loaded) {
        try {
            if (isTauri) {
                LoadingStatusState.text = "Checking Files..."
                appWindow.maximize()
                if (!await exists('', { baseDir: BaseDirectory.AppData })) {
                    await mkdir('', { baseDir: BaseDirectory.AppData })
                }
                if (!await exists('database', { baseDir: BaseDirectory.AppData })) {
                    await mkdir('database', { baseDir: BaseDirectory.AppData })
                }
                if (!await exists('assets', { baseDir: BaseDirectory.AppData })) {
                    await mkdir('assets', { baseDir: BaseDirectory.AppData })
                }
                if (!await exists('database/database.bin', { baseDir: BaseDirectory.AppData })) {
                    await writeFile('database/database.bin', encodeRisuSaveLegacy({}), { baseDir: BaseDirectory.AppData });
                }
                const appDataDirPath = await appDataDir();
                try {
                    LoadingStatusState.text = "Reading Save File..."
                    const dbPath = await join(appDataDirPath, 'database/database.bin');
                    const assetUrl = convertFileSrc(dbPath);
                    const response = await fetch(assetUrl);
                    if (!response.ok) {
                        throw new Error(`Failed to load database: ${response.status}`);
                    }
                    const readed = new Uint8Array(await response.arrayBuffer());
                    LoadingStatusState.text = "Cleaning Unnecessary Files..."
                    getDbBackups() //this also cleans the backups
                    LoadingStatusState.text = "Decoding Save File..."
                    const decoded = await decodeRisuSave(readed)
                    setDatabase(decoded)
                } catch (error) {
                    LoadingStatusState.text = "Reading Backup Files..."
                    const backups = await getDbBackups()
                    let backupLoaded = false
                    for (const backup of backups) {
                        if (!backupLoaded) {
                            try {
                                LoadingStatusState.text = `Reading Backup File ${backup}...`
                                const backupPath = await join(appDataDirPath, `database/dbbackup-${backup}.bin`);
                                const backupAssetUrl = convertFileSrc(backupPath);
                                const backupResponse = await fetch(backupAssetUrl);
                                if (!backupResponse.ok) {
                                    throw new Error(`Failed to load backup ${backup}: ${backupResponse.status}`);
                                }
                                const backupData = new Uint8Array(await backupResponse.arrayBuffer());
                                setDatabase(
                                    await decodeRisuSave(backupData)
                                )
                                backupLoaded = true
                            } catch (error) {
                                console.error(error)
                            }
                        }
                    }
                    if (!backupLoaded) {
                        throw "Your save file is corrupted"
                    }
                }
                LoadingStatusState.text = "Checking Update..."
                await checkRisuUpdate()
                await changeFullscreen()

            }
            else {
                await forageStorage.Init()

                let loadedFromPostgres = false
                let isSqlActive = false
                if(isNodeServer && forageStorage.realStorage instanceof NodeStorage){
                    const nodeStorage = forageStorage.realStorage
                    // SQL 설정 상태 조회 (vendor 무관)
                    let sqlConfig = null
                    try {
                        sqlConfig = await nodeStorage.postgres.getDatabaseConfig()
                        sqlConfiguredStore.set(Boolean(sqlConfig.enabled && sqlConfig.configured))
                    } catch (error) {
                        console.error('SQL config load failed', error)
                        sqlConfiguredStore.set(false)
                    }

                    if(sqlConfig?.enabled){
                        isSqlActive = true
                        LoadingStatusState.text = "Loading SQL Save Data..."
                        try {
                            const postgresDatabase = await nodeStorage.postgres.loadDatabase()
                            if(postgresDatabase){
                                setDatabase(postgresDatabase)
                                loadedFromPostgres = true
                            } else {
                                // SQL은 활성이지만 DB가 비어있음 (최초 초기화 상태).
                                // 로컬 database.bin이 존재하는 경우 최초 1회 명시적 마이그레이션 여부 확인.
                                let localDbData: Database | null = null
                                try {
                                    const localBytes: Uint8Array = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
                                    if (localBytes) {
                                        localDbData = await decodeRisuSave(localBytes)
                                    }
                                } catch {}

                                if (localDbData && localDbData.characters && localDbData.characters.length > 0) {
                                    const shouldMigrate = await alertConfirm(language.migrateLocalToSqlPrompt)
                                    if (shouldMigrate) {
                                        LoadingStatusState.text = "Migrating local data to SQL..."
                                        await nodeStorage.postgres.replaceDatabase(localDbData)
                                        try {
                                            await nodeStorage.postgres.migrateLegacyData()
                                        } catch (e) {
                                            console.error('Cold storage migration skipped:', e)
                                        }
                                        alertNormal(language.migrateLocalToSqlSuccess)
                                        const reloaded = await nodeStorage.postgres.loadDatabase()
                                        if (reloaded) {
                                            setDatabase(reloaded)
                                            loadedFromPostgres = true
                                        }
                                    }
                                }

                                if (!loadedFromPostgres) {
                                    // SQL 모드 격리: database.bin으로 폴백하지 않고 SQL 전용 빈 DB로 초기화
                                    const emptyDb: Database = {} as any
                                    setDatabase(emptyDb)
                                    const cache = nodeStorage.postgres.getCache()
                                    cache.initialized = true
                                    loadedFromPostgres = true
                                }
                            }
                        } catch (error) {
                            console.error('Failed to load SQL database:', error)
                            alertError(`Failed to connect to SQL storage: ${error instanceof Error ? error.message : String(error)}`)
                            throw error
                        }
                    }
                }

                if(!isSqlActive && !loadedFromPostgres){
                    // SQL 스토리지가 비활성화된 경우에만 로컬 database.bin을 로드 (완전 격리)
                    await resolveDatabaseBinConflict()
                    LoadingStatusState.text = "Loading Local Save File..."
                    let gotStorage: Uint8Array = await forageStorage.getItem('database/database.bin') as unknown as Uint8Array
                    LoadingStatusState.text = "Decoding Local Save File..."
                    if (checkNullish(gotStorage)) {
                        gotStorage = await resolveMissingDatabase()
                    }
                    try {
                        const decoded = await decodeRisuSave(gotStorage)
                        console.log(decoded)
                        setDatabase(decoded)
                    } catch (error) {
                        console.error(error)
                        const backups = await getDbBackups()
                        let backupLoaded = false
                        for (const backup of backups) {
                            try {
                                LoadingStatusState.text = `Reading Backup File ${backup}...`
                                const backupData: Uint8Array = await forageStorage.getItem(`database/dbbackup-${backup}.bin`) as unknown as Uint8Array
                                setDatabase(
                                    await decodeRisuSave(backupData)
                                )
                                backupLoaded = true
                            } catch (error) { }
                        }
                        if (!backupLoaded) {
                            throw "Forage: Your save file is corrupted"
                        }
                    }
                }

                if (await forageStorage.checkAccountSync()) {
                    LoadingStatusState.text = "Checking Account Sync..."
                    let gotStorage: Uint8Array = await (forageStorage.realStorage as AccountStorage).getItem('database/database.bin', (v) => {
                        LoadingStatusState.text = `Loading Remote Save File ${(v * 100).toFixed(2)}%`
                    })
                    if (checkNullish(gotStorage)) {
                        gotStorage = encodeRisuSaveLegacy({})
                        await forageStorage.setItem('database/database.bin', gotStorage)
                    }
                    try {
                        setDatabase(
                            await decodeRisuSave(gotStorage)
                        )
                    } catch (error) {
                        const backups = await getDbBackups()
                        let backupLoaded = false
                        for (const backup of backups) {
                            try {
                                LoadingStatusState.text = `Reading Backup File ${backup}...`
                                const backupData: Uint8Array = await forageStorage.getItem(`database/dbbackup-${backup}.bin`) as unknown as Uint8Array
                                setDatabase(
                                    await decodeRisuSave(backupData)
                                )
                                backupLoaded = true
                            } catch (error) { }
                        }
                        if (!backupLoaded) {
                            // throw "Your save file is corrupted"
                            await autoServerBackup()
                            await sleep(10000)
                        }
                    }
                }
                LoadingStatusState.text = "Rechecking Account Sync..."
                await forageStorage.checkAccountSync()
                LoadingStatusState.text = "Checking Drive Sync..."
                const isDriverMode = await checkDriverInit()
                if (isDriverMode) {
                    return
                }
                LoadingStatusState.text = "Checking Service Worker..."
                if (navigator.serviceWorker) {
                    setUsingSw(true)
                    await registerSw()
                }
                else {
                    setUsingSw(false)
                }
                if (getDatabase().didFirstSetup) {
                    characterURLImport()
                }
            }
            LoadingStatusState.text = "Loading Plugins..."
            try {
                await loadPlugins()
            } catch (error) { }
            if (getDatabase().account) {
                LoadingStatusState.text = "Checking Account Data..."
                try {
                    await loadRisuAccountData()
                } catch (error) { }
            }
            try {
                //@ts-expect-error navigator.standalone is iOS Safari non-standard property, not in Navigator interface
                const isInStandaloneMode = (window.matchMedia('(display-mode: standalone)').matches) || (window.navigator.standalone) || document.referrer.includes('android-app://');
                if (isInStandaloneMode) {
                    await navigator.storage.persist()
                }
            } catch (error) {

            }
            LoadingStatusState.text = "Checking For Format Update..."
            await checkNewFormat()
            const db = getDatabase();

            LoadingStatusState.text = "Updating States..."
            updateColorScheme()
            updateTextThemeAndCSS()
            updateAnimationSpeed()
            updateHeightMode()
            updateErrorHandling()
            updateGuisize()
            if (!localStorage.getItem('nightlyWarned') && window.location.hostname === 'nightly.risuai.xyz') {
                alertMd(language.nightlyWarning)
                await waitAlert()
                //for testing, leave empty
                localStorage.setItem('nightlyWarned', '')
            }
            if (db.botSettingAtStart) {
                botMakerMode.set(true)
            }
            if ((db.betaMobileGUI && window.innerWidth <= 800) || import.meta.env.VITE_RISU_LITE === 'TRUE') {
                initMobileGesture()
                MobileGUI.set(true)
            }
            await makeColdData()
            loadedStore.set(true)
            selectedCharID.set(-1)
            startObserveDom()
            assignIds()
            registerModelDynamic()
            saveDb()
            moduleUpdate()
            cleanChunks()
            alertTOS().then((a) => {
                if (a === false) {
                    location.reload()
                }
            })
            
        } catch (error) {
            alertError(error)
        }
    }
}

/**
 * When S3 storage is active and both the local FS and S3 hold a
 * `database/database.bin` whose SHA-256 hashes differ, prompt the user to
 * choose which copy to keep. The non-chosen copy is overwritten so both
 * locations agree afterwards. Returns the chosen bytes (or null when there
 * is no conflict / S3 isn't active / the user cancels).
 */
async function resolveDatabaseBinConflict(): Promise<boolean> {
    if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
        return false
    }
    const nodeStorage = forageStorage.realStorage
    let hashes
    try {
        hashes = await nodeStorage.s3.getDatabaseBinHashes()
    } catch (error) {
        console.error('db-hash probe failed', error)
        return false
    }
    // Only remote-backed setups can diverge; both null means no remote is configured.
    const remoteHashes = [hashes.s3, hashes.azuresql].filter((h): h is NonNullable<typeof h> => Boolean(h))
    if (remoteHashes.length === 0 || hashes.same === null || hashes.same === true) {
        return false
    }
    const localExists = hashes.local?.exists === true
    // Collect all sides that have a copy (local + any remote).
    const sides: { label: string; keep: 'local' | 's3' | 'azuresql'; exists: boolean; size: number; hashShort: string }[] = []
    {
        const localSize = hashes.local?.size ?? 0
        const localHashShort = (hashes.local?.hash || '').slice(0, 12)
        sides.push({
            label: language.dbConflictUseLocal(localSize, localHashShort),
            keep: 'local',
            exists: localExists,
            size: localSize,
            hashShort: localHashShort,
        })
    }
    if (hashes.s3) {
        const s3Exists = hashes.s3.exists === true
        const s3Size = hashes.s3.size ?? 0
        const s3HashShort = (hashes.s3.hash || '').slice(0, 12)
        sides.push({
            label: language.dbConflictUseS3(s3Size, s3HashShort),
            keep: 's3',
            exists: s3Exists,
            size: s3Size,
            hashShort: s3HashShort,
        })
    }
    if (hashes.azuresql) {
        const azExists = hashes.azuresql.exists === true
        const azSize = hashes.azuresql.size ?? 0
        const azHashShort = (hashes.azuresql.hash || '').slice(0, 12)
        sides.push({
            label: language.dbConflictUseAzureSql(azSize, azHashShort),
            keep: 'azuresql',
            exists: azExists,
            size: azSize,
            hashShort: azHashShort,
        })
    }
    const anyExists = sides.some(s => s.exists)
    if (!anyExists) {
        return false
    }
    // If only one side has data, there is no content conflict to resolve.
    const existsCount = sides.filter(s => s.exists).length
    if (existsCount <= 1) {
        return false
    }

    const options = [...sides.map(s => s.label), language.cancel]
    const choice = await alertSelect(options, language.dbConflictPrompt)
    const idx = parseInt(choice, 10)

    if (idx >= 0 && idx < sides.length) {
        const chosen = sides[idx]
        try {
            await nodeStorage.s3.resolveDatabaseBinConflict(chosen.keep)
        } catch (error) {
            console.error(`db-resolve (${chosen.keep}) failed`, error)
            alertError(error)
            return false
        }
        return true
    }
    // Cancel: fall through to normal load.
    return false
}

/**
 * Resolves a missing server-side database by offering the user a choice
 * between recovering data from the browser HTTP cache (and any server-side
 * backups) or starting fresh. Only used in the Node legacy file storage mode.
 */
async function resolveMissingDatabase(): Promise<Uint8Array> {
    const nodeStorage = isNodeServer && forageStorage.realStorage instanceof NodeStorage
        ? forageStorage.realStorage
        : null

    type Candidate = { label: string, load: () => Promise<Uint8Array | Buffer | null> }
    const candidates: Candidate[] = []

    if (nodeStorage) {
        try {
            const cachedDb = await nodeStorage.getItemFromBrowserCache('database/database.bin')
            if (cachedDb && cachedDb.length > 0) {
                candidates.push({
                    label: language.cachedDatabaseLabel,
                    load: async () => cachedDb
                })
            }
        } catch (error) {
            console.error('Browser cache probe failed', error)
        }
    }

    let serverBackups: number[] = []
    try {
        serverBackups = await getDbBackups()
    } catch (error) {
        console.error('Failed to list server backups', error)
    }
    for (const backup of serverBackups) {
        const dateLabel = new Date(backup * 100).toLocaleString()
        candidates.push({
            label: language.backupLabelFormat(dateLabel),
            load: async () => await forageStorage.getItem(`database/dbbackup-${backup}.bin`) as unknown as Uint8Array
        })
    }

    if (candidates.length === 0) {
        const gotStorage = encodeRisuSaveLegacy({})
        await forageStorage.setItem('database/database.bin', gotStorage)
        return gotStorage
    }

    const options = [
        ...candidates.map((c) => c.label),
        language.startFresh,
        language.cancel
    ]
    const choice = await alertSelect(options, language.cacheRecoveryPrompt)
    const choiceIdx = parseInt(choice, 10)

    if (Number.isNaN(choiceIdx) || choiceIdx < 0 || choiceIdx >= candidates.length) {
        if (choiceIdx === candidates.length) {
            const gotStorage = encodeRisuSaveLegacy({})
            await forageStorage.setItem('database/database.bin', gotStorage)
            return gotStorage
        }
        throw new Error(language.cacheRecoveryCancelled)
    }

    const selected = candidates[choiceIdx]
    const loaded = await selected.load()
    if (checkNullish(loaded)) {
        const gotStorage = encodeRisuSaveLegacy({})
        await forageStorage.setItem('database/database.bin', gotStorage)
        return gotStorage
    }
    const gotStorage = new Uint8Array(loaded as Uint8Array)
    await forageStorage.setItem('database/database.bin', gotStorage)
    return gotStorage
}


/**
 * Registers the service worker and initializes it.
 */
async function registerSw() {
    await navigator.serviceWorker.register("/sw.js", {
        scope: "/"
    });
    await sleep(100);
    const da = await fetch('/sw/init');
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
        if(!(event.error.target instanceof Worker)){
            alertError(event.error);            
        }
    };
    const rejectHandler = (event: PromiseRejectionEvent) => {
        console.error(event.reason);
        alertError(event.reason);
    };
    window.addEventListener('error', errorHandler);
    window.addEventListener('unhandledrejection', rejectHandler);
}

/**
 * Updates the height mode of the document based on the value stored in the database.
 */
function updateHeightMode() {
    const db = getDatabase()
    const root = document.querySelector(':root') as HTMLElement;
    switch (db.heightMode) {
        case 'auto':
            root.style.setProperty('--risu-height-size', '100%');
            break
        case 'vh':
            root.style.setProperty('--risu-height-size', '100vh');
            break
        case 'dvh':
            root.style.setProperty('--risu-height-size', '100dvh');
            break
        case 'lvh':
            root.style.setProperty('--risu-height-size', '100lvh');
            break
        case 'svh':
            root.style.setProperty('--risu-height-size', '100svh');
            break
        case 'percent':
            root.style.setProperty('--risu-height-size', '100%');
            break
    }
}

/**
 * Checks and updates the database format to the latest version.
 */
async function checkNewFormat(): Promise<void> {
    let db = getDatabase();

    // Check data integrity
    db.characters = db.characters.map((v) => {
        if (!v) {
            return null;
        }
        v.chaId ??= uuidv4();
        v.type ??= 'character';
        v.chatPage ??= 0;
        v.chats ??= [];
        v.customscript ??= [];
        v.firstMessage ??= '';
        v.globalLore ??= [];
        v.name ??= '';
        v.viewScreen ??= 'none';
        v.emotionImages = v.emotionImages ?? [];

        if (v.type === 'character') {
            v.bias ??= [];
            v.characterVersion ??= '';
            v.creator ??= '';
            v.desc ??= '';
            v.utilityBot ??= false;
            v.tags ??= [];
            v.systemPrompt ??= '';
            v.scenario ??= '';
        }
        return v;
    }).filter((v) => {
        return v !== null;
    });

    db.modules = await Promise.all((db.modules ?? []).map(async (v) => {
        if (v?.lorebook) {
            if (!Array.isArray(v.lorebook)) {
                console.error('Critical: Invalid lorebook format detected in module');
                console.error('Module data:', JSON.stringify(v, null, 2));
                
                // Alert user about corrupted data
                alertError(language.bootstrap.dataCorruptionDetected(v.name || 'Unknown', typeof v.lorebook));
                await waitAlert();
                
                // Ask if user wants to report the issue
                const shouldReport = await alertConfirm(language.bootstrap.reportErrorQuestion);
                
                if (shouldReport) {
                    try {
                        // Collect diagnostic information (without personal data)
                        const diagnosticInfo = {
                            timestamp: new Date().toISOString(),
                            moduleName: v.name || 'Unknown',
                            lorebookType: typeof v.lorebook,
                            lorebookValue: JSON.stringify(v.lorebook).substring(0, 500), // First 500 chars only
                            isArray: Array.isArray(v.lorebook),
                            keys: v.lorebook ? Object.keys(v.lorebook).join(', ') : 'N/A',
                            formatVersion: db.formatversion || 'Unknown'
                        };
                        
                        // Show the diagnostic info and allow user to copy or send
                        const reportData = JSON.stringify(diagnosticInfo, null, 2);
                        await alertMd(language.bootstrap.diagnosticInformation(reportData));
                        await waitAlert();
                        
                        console.log('Diagnostic information for developers:', diagnosticInfo);
                    } catch (reportError) {
                        console.error('Failed to generate diagnostic report:', reportError);
                    }
                }
                
                // Ask if user wants to reset the data
                const shouldReset = await alertConfirm(language.bootstrap.resetLorebookQuestion);
                
                if (shouldReset) {
                    v.lorebook = [];
                    console.log('Lorebook reset to empty array by user choice');
                } else {
                    console.warn('User chose to keep corrupted lorebook data');
                }
            } else {
                v.lorebook = updateLorebooks(v.lorebook);
            }
        }
        return v
    }));
    
    db.modules = db.modules.filter((v) => {
        return v !== null && v !== undefined;
    });

    db.personas = (db.personas ?? []).map((v) => {
        v.id ??= uuidv4()
        v.largePortrait ??= false
        return v
    }).filter((v) => {
        return v !== null && v !== undefined;
    });

    if (db.personas.length === 0) {
        db.personas.push({
            name: db.username || 'User',
            icon: db.userIcon || '',
            personaPrompt: '',
            note: db.userNote || '',
            largePortrait: false,
            id: uuidv4()
        })
    }
    if (typeof db.selectedPersona !== 'number' || db.selectedPersona < 0 || db.selectedPersona >= db.personas.length) {
        db.selectedPersona = 0
    }

    if (!db.formatversion) {
        function checkClean(data: string) {

            if (data.startsWith('assets') || (data.length < 3)) {
                return data
            }
            else {
                const d = 'assets/' + (data.replace(/\\/g, '/').split('assets/')[1])
                if (!d) {
                    return data
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
                    if (db.characters[i].emotionImages[i2] && db.characters[i].emotionImages[i2].length >= 2) {
                        db.characters[i].emotionImages[i2][1] = checkClean(db.characters[i].emotionImages[i2][1]);
                    }
                }
            }
        }

        db.formatversion = 2;
    }
    if (db.formatversion < 3) {
        for (let i = 0; i < db.characters.length; i++) {
            let cha = db.characters[i];
            if (cha.type === 'character') {
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
async function cleanChunks(options:{
    cleanColdStorage?: boolean
} = {}) {
    const cleanColdStorage = options.cleanColdStorage ?? false
    const db = getDatabase()
    if (isNodeServer || db.account?.useSync) {
        return
    }
    if(db.coldstorage && !cleanColdStorage){
        return
    }

    const uncleanable = new Set(await getUncleanables(db))
    if (isTauri) {
        const assets = await readDir('assets', { baseDir: BaseDirectory.AppData })
        console.log(assets)
        for (const asset of assets) {
            try {
                const n = getBasename(asset.name)
                if (!uncleanable.has(n)) {
                    await remove('assets/' + asset.name, { baseDir: BaseDirectory.AppData })
                }
            } catch (error) {
                console.log('error', asset.name)
            }
        }

        
        if(!await exists('remotes', { baseDir: BaseDirectory.AppData })) {
            await mkdir('remotes', { baseDir: BaseDirectory.AppData })
        }

        const remotes = await readDir('remotes', { baseDir: BaseDirectory.AppData })

        const remoteUncleanables = new Set<string>(
            db.characters.map((v) => v.chaId)
        )
        for (const remote of remotes) {
            try {
                const remoteFileName = getBasename(remote.name)
                const remotePayloadName = getRemoteSavePayloadName(remoteFileName)
                if(!remotePayloadName){
                    continue
                }
                const fexists = remoteUncleanables.has(remotePayloadName)
                if(!fexists){

                    const metaPath = 'remotes/' + remote.name + '.meta'
                    let metaExists = false
                    let metaLastUsed:unknown
                    try {
                        metaExists = await exists(metaPath, { baseDir: BaseDirectory.AppData })
                        if (metaExists) {
                            const meta = await readFile(metaPath, { baseDir: BaseDirectory.AppData })
                            const metaJson = JSON.parse(new TextDecoder().decode(meta))
                            metaLastUsed = metaJson.lastUsed
                        }
                    } catch (error) {}

                    const cleanupAction = getRemoteSaveCleanupAction({
                        fileName: remoteFileName,
                        activeCharacterIds: remoteUncleanables,
                        hasMeta: metaExists,
                        metaLastUsed
                    })
                    if(cleanupAction === 'create-meta'){
                        const metaJson = {
                            lastUsed: Date.now()
                        }
                        await writeFile(metaPath, new TextEncoder().encode(JSON.stringify(metaJson)), { baseDir: BaseDirectory.AppData })
                    }
                    else if(cleanupAction === 'delete'){
                        await remove('remotes/' + remote.name, { baseDir: BaseDirectory.AppData })
                        await remove(metaPath, { baseDir: BaseDirectory.AppData })
                    }
                }
            } catch (error) {
                console.log('error', remote.name)
            }
        }
    }
    else {
        const indexes = await forageStorage.keys()
        const characterIds = new Set<string>(
            db.characters.map((v) => v.chaId)
        )
        for (const asset of indexes) {
            if (asset.startsWith('assets/')) {
                const n = getBasename(asset)
                if(!uncleanable.has(n)) {
                    await forageStorage.removeItem(asset)
                }
            }
            else if (asset.endsWith('.meta')){
                continue
            }
            else if (asset.startsWith('remotes/')) {
                const name = getBasename(asset).slice(0, -10) //remove .local.bin
                const exists = characterIds.has(name)
                if(!exists){
                    let okayToDelete = false
                    try {
                        const metaPath = asset + '.meta'
                        const metaExists = (await forageStorage.keys()).includes(metaPath)
                        if (metaExists) {
                            const metaData: Uint8Array = await forageStorage.getItem(metaPath) as unknown as Uint8Array
                            const metaJson = JSON.parse(new TextDecoder().decode(metaData))
                            const lastUsed = metaJson.lastUsed as number
                            if(Date.now() - lastUsed > 1000 * 60 * 60 * 24 * 7) { //not used for 7 days
                                okayToDelete = true
                            }
                        }
                        else{
                            //write meta for next time
                            const metaJson = {
                                lastUsed: Date.now()
                            }
                            await forageStorage.setItem(metaPath, new TextEncoder().encode(JSON.stringify(metaJson)))
                        }
                    } catch (error) {}
                    if (okayToDelete) {
                        await forageStorage.removeItem(asset)
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
    if (!DBState?.db?.characters) {
        return
    }
    const assignedIds = new Set<string>()
    for (let i = 0; i < DBState.db.characters.length; i++) {
        const cha = DBState.db.characters[i]
        if (!cha.chaId) {
            cha.chaId = uuidv4()
        }
        if (assignedIds.has(cha.chaId)) {
            console.warn(`Duplicate chaId found: ${cha.chaId}. Assigning new ID.`);
            cha.chaId = uuidv4();
        }
        assignedIds.add(cha.chaId)
        for (let i2 = 0; i2 < cha.chats.length; i2++) {
            const chat = cha.chats[i2]
            if (!chat.id) {
                chat.id = uuidv4()
            }
            if (assignedIds.has(chat.id)) {
                console.warn(`Duplicate chat ID found: ${chat.id}. Assigning new ID.`);
                chat.id = uuidv4();
            }
            assignedIds.add(chat.id)
        }
    }
}
