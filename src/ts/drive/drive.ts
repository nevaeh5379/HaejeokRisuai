import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import {
  alertError,
  alertInput,
  alertNormal,
  alertSelect,
  alertStore,
  alertProgress,
} from "../alert";
import type { Database } from "../storage/database/schema";
import { createDatabaseSnapshot } from "../storage/database/databaseSnapshot";

import { forageStorage, getUncleanables, openURL } from "../globalApi.svelte";
import { isNodeServer, isTauri } from "src/ts/platform";
import {
  BaseDirectory,
  exists,
  readFile,
  readDir,
  writeFile,
} from "@tauri-apps/plugin-fs";
import { language } from "../../lang";
import { relaunch } from "@tauri-apps/plugin-process";
import { sleep } from "../util";
import { hubURL } from "../characterCards";
import { decodeRisuSave, encodeRisuSaveLegacyAsync } from "../storage/backup/risuSave";
import {
  collectColdStorageBackupPayloads,
  confirmIncompleteColdStorageOperation,
  getColdStorageBackupName,
  isColdStorageBackupData,
  listColdDataKeys,
  setColdStorageItem,
} from "../process/coldstorage.svelte";
import { NodeStorage } from "../storage/files/nodeStorage";
import {
  buildPortableLocalBackupDatabase,
  createBackupDatabaseSnapshot,
} from "./backuplocal";
import { getSqlStorage } from "../storage/sql/sqlStorageFactory";

export async function checkDriver(
  type: "save" | "load" | "loadtauri" | "savetauri" | "reftoken",
) {
  const CLIENT_ID =
    "580075990041-l26k2d3c0nemmqiu3d3aag01npfrkn76.apps.googleusercontent.com";
  const REDIRECT_URI =
    type === "reftoken" ? "https://sv.risuai.xyz/drive" : "https://risuai.xyz/";
  const SCOPE =
    "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.appdata";
  const encodedRedirectUri = encodeURIComponent(REDIRECT_URI);
  const authorizationUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodedRedirectUri}&scope=${SCOPE}&response_type=code&state=${type}`;

  if (type === "reftoken") {
    const authorizationUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${CLIENT_ID}&redirect_uri=${encodedRedirectUri}&scope=${SCOPE}&response_type=code&state=${"accesstauri"}&access_type=offline&prompt=consent`;
    return authorizationUrl;
  }

  if (type === "save" || type === "load") {
    location.href = authorizationUrl;
  } else {
    try {
      if (isTauri) {
        openURL(authorizationUrl);
      } else {
        window.open(authorizationUrl);
      }
      let code = await alertInput(language.pasteAuthCode);
      if (code.includes(" ")) {
        code = code.substring(code.lastIndexOf(" ")).trim();
      }
      if (type === "loadtauri") {
        await loadDrive(code, "backup");
      } else {
        await backupDrive(code);
      }
    } catch (error) {
      console.error(error);
      alertError(`Backup Error: ${error}`);
    }
  }
}

export async function checkDriverInit() {
  try {
    const loc = new URLSearchParams(location.search);
    const code = loc.get("code");

    if (code) {
      const res = await fetch(
        hubURL + `/drive/token?code=${encodeURIComponent(code)}`,
      );
      if (res.status >= 200 && res.status < 300) {
        const json: {
          access_token: string;
          expires_in: number;
        } = await res.json();
        const da = loc.get("state");
        if (da === "save") {
          await backupDrive(json.access_token);
        } else if (da === "load") {
          await loadDrive(json.access_token, "backup");
        } else if (da === "savetauri" || da === "loadtauri") {
          alertStore.set({
            type: "wait2",
            msg: `Copy and paste this Auth Code: ${json.access_token}`,
          });
        } else if (da === "accesstauri") {
          alertStore.set({
            type: "wait2",
            msg: JSON.stringify(json),
          });
        }
      } else {
        alertError(await res.text());
        // location.search = ''
      }
      return true;
    } else {
      return false;
    }
  } catch (error) {
    console.error(error);
    alertError(`Backup Error: ${error}`);
    const currentURL = new URL(location.href);
    currentURL.search = "";
    window.history.replaceState({}, "", currentURL.href);
    await sleep(100000);
    return false;
  }
}

let lastSaved: number = parseInt(
  (typeof localStorage !== "undefined"
    ? localStorage.getItem("risu_lastsaved")
    : null) ?? "-1",
);

async function backupDrive(ACCESS_TOKEN: string) {
  alertProgress("Preparing Google Drive Backup...", 0);
  await sleep(10);

  const files: DriveFile[] = await getFilesInFolder(ACCESS_TOKEN);

  const fileNames = files.map((d) => {
    return d.name;
  });

  const databaseSnapshot = createDatabaseSnapshot();
  const coldStoragePayloads =
    await collectColdStorageBackupPayloads(databaseSnapshot);
  const unavailableColdStorageKeys = [
    ...coldStoragePayloads.missingKeys,
    ...coldStoragePayloads.invalidKeys,
  ];
  if (
    !(await confirmIncompleteColdStorageOperation(
      databaseSnapshot,
      unavailableColdStorageKeys,
      "backup",
    ))
  ) {
    return;
  }

  if (isTauri) {
    const assets = await readDir("assets", { baseDir: BaseDirectory.AppData });
    const totalAssets = assets.length;
    let i = 0;
    for (let asset of assets) {
      i += 1;
      const percent = totalAssets > 0 ? (i / totalAssets) * 80 : 80;
      alertProgress(
        `Uploading Backup to Drive... (${i} / ${totalAssets})`,
        percent,
      );
      const key = asset.name;
      if (!key || !key.endsWith(".png")) {
        continue;
      }
      const formatedKey = newFormatKeys(key);
      if (!fileNames.includes(formatedKey)) {
        await createFileInFolder(
          ACCESS_TOKEN,
          formatedKey,
          await readFile("assets/" + asset.name, {
            baseDir: BaseDirectory.AppData,
          }),
        );
      }
    }
  } else {
    const keys = await forageStorage.keys();
    const totalKeys = keys.length;

    for (let i = 0; i < totalKeys; i++) {
      const percent = totalKeys > 0 ? ((i + 1) / totalKeys) * 80 : 80;
      alertProgress(
        `Uploading Backup to Drive... (${i + 1} / ${totalKeys})`,
        percent,
      );
      const key = keys[i];
      if (!key.endsWith(".png")) {
        continue;
      }
      const formatedKey = newFormatKeys(key);
      if (!fileNames.includes(formatedKey)) {
        await createFileInFolder(
          ACCESS_TOKEN,
          formatedKey,
          (await forageStorage.getItem(key)) as unknown as Uint8Array,
        );
      }
    }
  }

  const totalCold = coldStoragePayloads.payloads.length;
  for (let i = 0; i < totalCold; i++) {
    const payload = coldStoragePayloads.payloads[i];
    const percent = totalCold > 0 ? 80 + ((i + 1) / totalCold) * 10 : 80;
    alertProgress(
      `Uploading Cold Storage... (${i + 1} / ${totalCold})`,
      percent,
    );
    if (fileNames.includes(payload.backupName)) {
      continue;
    }
    await createFileInFolder(ACCESS_TOKEN, payload.backupName, payload.encoded);
  }

  const db = await createBackupDatabaseSnapshot();
  alertProgress(`Uploading Backup... (Compressing database)`, 92);
  await sleep(20);
  const coldStorageValues = new Map(
    coldStoragePayloads.payloads.map(
      (payload) => [payload.key, payload.value] as const,
    ),
  );
  const portableDb = buildPortableLocalBackupDatabase(
    db,
    "compatible",
    coldStorageValues,
  );
  const dbData = await encodeRisuSaveLegacyAsync(portableDb, "compression");

  alertProgress(`Uploading Backup... (Saving database)`, 96);
  await sleep(10);

  await createFileInFolder(
    ACCESS_TOKEN,
    `${(Date.now() / 1000).toFixed(0)}-database.risudat`,
    dbData,
  );

  alertNormal("Success");
}

type DriveFile = {
  mimeType: string;
  name: string;
  id: string;
};

async function loadDrive(
  ACCESS_TOKEN: string,
  mode: "backup" | "sync",
): Promise<void | "noSync"> {
  if (mode === "backup") {
    alertStore.set({
      type: "wait",
      msg: "Loading Backup...",
    });
  }
  const files: DriveFile[] = await getFilesInFolder(ACCESS_TOKEN);
  let foragekeys: string[] = [];
  let loadedForageKeys = false;
  let db = settingsStore.state;

  async function checkImageExists(images: string) {
    if (db?.account?.useSync) {
      return false;
    }
    if (isTauri) {
      return await exists(`assets/` + images, {
        baseDir: BaseDirectory.AppData,
      });
    } else {
      if (!loadedForageKeys) {
        foragekeys = await forageStorage.keys();
        loadedForageKeys = true;
      }
      return foragekeys.includes("assets/" + images);
    }
  }
  const fileNames = files.map((d) => {
    return d.name;
  });

  let dbs: [DriveFile, number][] = [];
  let noSyncData = true;

  if (mode === "backup") {
    for (const f of files) {
      if (f.name.endsWith("-database.risudat")) {
        const tm = parseInt(f.name.split("-")[0]);
        if (isNaN(tm)) {
          continue;
        } else {
          dbs.push([f, tm]);
        }
      }
    }
    dbs.sort((a, b) => {
      return b[1] - a[1];
    });
  } else if (mode === "sync") {
    for (const f of files) {
      if (f.name.endsWith("-database.risudat2")) {
        const tm = parseInt(f.name.split("-")[0]);
        if (isNaN(tm)) {
          continue;
        } else {
          if (tm > lastSaved) {
            dbs.push([f, tm]);
          }
          noSyncData = false;
        }
      }
    }
    dbs.sort((a, b) => {
      return b[1] - a[1];
    });
  }

  if (noSyncData && mode === "sync") {
    return "noSync";
  }

  if (dbs.length !== 0) {
    if (mode === "sync") {
      alertStore.set({
        type: "wait",
        msg: "Sync Data...",
      });
    }
    async function getDbFromList() {
      let selectables: string[] = [];
      for (let i = 0; i < dbs.length; i++) {
        selectables.push(
          `Backup saved in ${new Date(dbs[i][1] * 1000).toLocaleString()}`,
        );
        if (selectables.length > 7) {
          break;
        }
      }
      const selectedIndex =
        (await alertSelect([language.loadLatest, language.loadOthers])) === "0"
          ? 0
          : parseInt(await alertSelect(selectables));
      const selectedDb = dbs[selectedIndex][0];
      const decompressedDb: Database = await decodeRisuSave(
        await getFileData(ACCESS_TOKEN, selectedDb.id),
      );
      return decompressedDb;
    }

    const db: Database =
      mode === "backup"
        ? await getDbFromList()
        : JSON.parse(
            Buffer.from(await getFileData(ACCESS_TOKEN, dbs[0][0].id)).toString(
              "utf-8",
            ),
          );
    const coldStorageRestoreFailures = await restoreColdStorageFromDrive(
      ACCESS_TOKEN,
      files,
      db,
      mode,
    );
    if (coldStorageRestoreFailures.length > 0) {
      if (mode === "sync") {
        alertError(
          `Sync failed. ${coldStorageRestoreFailures.length} cold storage item(s) could not be restored.`,
        );
        return;
      }
      if (
        !(await confirmIncompleteColdStorageOperation(
          db,
          coldStorageRestoreFailures,
          "restore",
        ))
      ) {
        return;
      }
    }
    const requiredImages = await getUncleanables(db);
    let ind = 0;
    let errorLogs: string[] = [];
    for (const images of requiredImages) {
      ind += 1;
      for (let tries = 0; tries < 3; tries++) {
        const formatedImage =
          tries === 0 ? newFormatKeys(images) : formatKeys(images);
        if (mode === "sync") {
          alertStore.set({
            type: "wait",
            msg: `Sync Files... (${ind} / ${requiredImages.length})`,
          });
        } else {
          alertStore.set({
            type: "wait",
            msg: `Loading Backup... (${ind} / ${requiredImages.length})`,
          });
        }
        if (await checkImageExists(images)) {
          //skip process
        } else {
          if (formatedImage.length >= 7) {
            if (fileNames.includes(formatedImage)) {
              for (const file of files) {
                if (file.name === formatedImage) {
                  const fData = await getFileData(ACCESS_TOKEN, file.id);
                  if (isTauri) {
                    await writeFile(`assets/` + images, fData, {
                      baseDir: BaseDirectory.AppData,
                    });
                  } else {
                    await forageStorage.setItem("assets/" + images, fData);
                  }
                  tries = 3;
                }
              }
            } else {
              alertStore.set({
                type: "wait",
                msg: `Loading Backup... (${ind} / ${requiredImages.length}) (Error in ${formatedImage})`,
              });
              await sleep(1000);
            }
          }
        }
      }
    }
    db.didFirstSetup = true;
    db.pluginCustomStorage ??= {};
    const storage = await getSqlStorage();
    await storage.replaceDatabase(db);
    lastSaved = Date.now();
    localStorage.setItem("risu_lastsaved", `${lastSaved}`);

    if (isTauri) {
      relaunch();
      alertStore.set({
        type: "wait",
        msg: "Success, Refreshing your app.",
      });
    } else {
      location.search = "";
      alertStore.set({
        type: "wait",
        msg: "Success, Refreshing your app.",
      });
      location.reload();
    }
  } else if (mode === "backup") {
    location.search = "";
  }
}

async function restoreColdStorageFromDrive(
  ACCESS_TOKEN: string,
  files: DriveFile[],
  db: Database,
  mode: "backup" | "sync",
) {
  const coldKeys = await listColdDataKeys(db);
  const failures: string[] = [];
  for (let i = 0; i < coldKeys.length; i++) {
    const key = coldKeys[i];
    const names = new Set([
      getColdStorageBackupName(key),
      `coldstorage/${key}.json`,
      `${key}.json`,
    ]);
    const file = files.find((driveFile) => names.has(driveFile.name));
    if (!file) {
      console.warn(`Cold storage data not found in Drive backup: ${key}`);
      failures.push(key);
      continue;
    }
    alertStore.set({
      type: "wait",
      msg: `${mode === "sync" ? "Sync" : "Loading Backup"} Cold Storage... (${i + 1} / ${coldKeys.length})`,
    });
    try {
      const jsonData = JSON.parse(
        new TextDecoder().decode(await getFileData(ACCESS_TOKEN, file.id)),
      );
      if (isColdStorageBackupData(jsonData)) {
        if (!(await setColdStorageItem(key, jsonData))) {
          failures.push(key);
        }
      } else {
        console.warn(`Skipping invalid cold storage Drive item ${file.name}`);
        failures.push(key);
      }
    } catch (error) {
      console.error(`Failed to restore cold storage item ${key}:`, error);
      failures.push(key);
    }
  }
  return failures;
}

function checkImageExist(image: string) {}

function formatKeys(name: string) {
  return (
    getBasename(name)
      .replace(/\_/g, "__")
      .replace(/\./g, "_d")
      .replace(/\//, "_s") + ".png"
  );
}

function newFormatKeys(name: string) {
  let n = getBasename(name);
  const bf = Buffer.from(n).toString("hex");
  return n + ".bin";
}

async function getFilesInFolder(
  ACCESS_TOKEN: string,
  nextPageToken = "",
): Promise<DriveFile[]> {
  const url =
    `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&pageSize=300` +
    nextPageToken;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (response.ok) {
    const data = await response.json();
    if (data.nextPageToken) {
      return (data.files as DriveFile[]).concat(
        await getFilesInFolder(
          ACCESS_TOKEN,
          `&pageToken=${data.nextPageToken}`,
        ),
      );
    }
    return data.files as DriveFile[];
  } else {
    throw `Error: ${response.status}`;
  }
}

async function createFileInFolder(
  accessToken: string,
  fileName: string,
  content: Uint8Array,
  mimeType = "application/octet-stream",
) {
  const metadata = {
    name: fileName,
    mimeType: mimeType,
    parents: ["appDataFolder"],
  };

  const body = new FormData();
  body.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" }),
  );
  body.append("file", new Blob([content as any], { type: mimeType }));

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      body: body,
    },
  );

  const result = await response.json();

  if (response.ok) {
    return result;
  } else {
    console.error("Error creating file:", result);
    throw new Error(result.error.message);
  }
}

const baseNameRegex = /\\/g;
function getBasename(data: string) {
  const splited = data.replace(baseNameRegex, "/").split("/");
  const lasts = splited[splited.length - 1];
  return lasts;
}

async function getFileData(ACCESS_TOKEN: string, fileId: string) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  const request = {
    method: "GET",
    headers: {
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
  };

  const response = await fetch(url, request);

  if (response.ok) {
    const data = new Uint8Array(await response.arrayBuffer());
    return data;
  } else {
    throw "Error in response when reading files in folder";
  }
}
