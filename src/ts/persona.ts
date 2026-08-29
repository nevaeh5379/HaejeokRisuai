import { saveImage } from "./storage/files/assetPersistence";

import { selectSingleFile, sleep } from "./util";
import { alertError, alertNormal, alertStore, alertConfirm, alertInput, alertSelect } from "./alert";
import { AppendableBuffer, downloadFile, readImage } from "./globalApi.svelte";
import { language } from "src/lang";
import { reencodeImage } from "./process/files/inlays";
import { PngChunk } from "./pngChunk";
import { v4 } from "uuid";
import { personaStore } from "./stores/domain/personaStore.svelte";

export async function selectUserImg() {
  const selected = await selectSingleFile(["png"]);
  if (!selected) {
    return;
  }

  await personaStore.ensureLoaded();
  const persona = personaStore.requireActive(selectUserImg.name);
  persona.icon = await saveImage(selected.data);
}

export function changeUserPersona(id: number) {
  personaStore.select(id, changeUserPersona.name);
}

export async function createPersonaFolder() {
  const name = await alertInput(language.folderName);
  if (!name) return;
  await personaStore.ensureLoaded();
  const folder = await personaStore.addFolder(name);
  return folder;
}

export async function renamePersonaFolder(folderId: string) {
  const folder = personaStore.getPersonaFolderById(folderId);
  if (!folder) return;
  const name = await alertInput(language.renameFolder, undefined, folder.name);
  if (!name) return;
  await personaStore.renameFolder(folderId, name);
}

export async function removePersonaFolder(folderId: string) {
  const folder = personaStore.getPersonaFolderById(folderId);
  if (!folder) return;
  const confirmed = await alertConfirm(
    `${language.personaFolderRemoveConfirm} (${folder.name})`,
  );
  if (!confirmed) return;
  await personaStore.removeFolder(folderId);
}

/** Opens a folder-picker and moves the persona at `index` to the chosen folder. */
export async function movePersonaToFolderByIndex(index: number) {
  await personaStore.ensureLoaded();
  const persona = personaStore.require(index, movePersonaToFolderByIndex.name);
  persona.id ??= v4();
  const folders = personaStore.folders;
  const options = [language.noFolder, ...folders.map((folder) => folder.name)];
  const sel = parseInt(await alertSelect(options));
  if (Number.isNaN(sel)) return;
  if (sel === 0) {
    await personaStore.movePersonaToFolder(persona.id, undefined);
  } else {
    const folder = folders[sel - 1];
    if (folder) {
      await personaStore.movePersonaToFolder(persona.id, folder.id);
    }
  }
}

interface PersonaCard {
  name: string;
  personaPrompt: string;
  note?: string;
}

export async function exportUserPersona() {
  await personaStore.ensureLoaded();
  const persona = personaStore.requireActive(exportUserPersona.name);

  if (!persona.name || !persona.personaPrompt) {
    alertError("username or persona prompt is empty");
    return;
  }

  let img: Uint8Array;
  if (!persona.icon) {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgb(100, 116, 139)";
    ctx.fillRect(0, 0, 256, 256);
    const dataUrl = canvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];
    img = new Uint8Array(Buffer.from(base64, "base64"));
  } else {
    img = await readImage(persona.icon);
  }

  const card: PersonaCard = {
    name: persona.name,
    personaPrompt: persona.personaPrompt,
    note: persona.note,
  };

  alertStore.set({
    type: "wait",
    msg: "Loading... (Writing Exif)",
  });

  await sleep(10);

  img = (await PngChunk.write(await reencodeImage(img), {
    persona: Buffer.from(JSON.stringify(card)).toString("base64"),
  })) as Uint8Array;

  alertStore.set({
    type: "wait",
    msg: "Loading... (Writing)",
  });

  await sleep(10);
  await downloadFile(
    `${persona.name.replace(/[<>:"/\\|?*\.\,]/g, "")}_export.png`,
    img,
  );

  alertNormal(language.successExport);
}

export async function importUserPersona() {
  try {
    const v = await selectSingleFile(["png"]);
    if (!v) {
      return;
    }
    const readGenerator = PngChunk.readGenerator(v.data);
    let decoded: string | undefined;

    for await (const chunk of readGenerator) {
      if (
        chunk &&
        !(chunk instanceof AppendableBuffer) &&
        chunk.key === "persona"
      ) {
        decoded = chunk.value;
        break;
      }
    }

    if (!decoded) {
      alertError(language.errors.noData);
      return;
    }
    const data: PersonaCard = JSON.parse(
      Buffer.from(decoded, "base64").toString("utf-8"),
    );
    if (data.name && data.personaPrompt) {
      await personaStore.ensureLoaded();
      personaStore.add({
        name: data.name,
        icon: await saveImage(await reencodeImage(v.data)),
        personaPrompt: data.personaPrompt,
        note: data.note,
        id: v4(),
      });
      alertNormal(language.successImport);
    } else {
      alertError(language.errors.noData);
    }
  } catch (error) {
    alertError(error);
    return;
  }
}
