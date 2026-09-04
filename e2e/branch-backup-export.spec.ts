import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function waitForAppReady(page: Page) {
  await page.goto("/");
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes("Initialising Database") &&
      !!navigator.serviceWorker.controller,
    undefined,
    { timeout: 120_000 },
  );
}

async function seedBranchedChat(page: Page) {
  return await page.evaluate(async () => {
    const charactersUrl = "/src/ts/characters.ts";
    const domainUrl = "/src/ts/stores/domain/index.ts";
    const storesUrl = "/src/ts/stores.svelte.ts";
    const factoryUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";
    const { createNewCharacter } = (await import(
      /* @vite-ignore */ charactersUrl
    )) as {
      createNewCharacter: () => number;
    };
    const { characterStore, messageStore } = (await import(
      /* @vite-ignore */ domainUrl
    )) as { characterStore: any; messageStore: any };
    const { selectedCharID } = (await import(/* @vite-ignore */ storesUrl)) as {
      selectedCharID: { set: (index: number) => void };
    };
    const { getSqlBranchStorage } = (await import(
      /* @vite-ignore */ factoryUrl
    )) as { getSqlBranchStorage: () => Promise<any> };

    const index = createNewCharacter();
    const character = characterStore.characters[index];
    character.name = "Branch Backup E2E";
    const chatId = crypto.randomUUID();
    const promptId = crypto.randomUUID();
    const originalId = crypto.randomUUID();
    const alternativeId = crypto.randomUUID();
    const chat: any = {
      message: [],
      note: "",
      name: "Branched chat",
      localLore: [],
      fmIndex: -1,
      id: chatId,
    };
    character.chats = [chat];
    characterStore.markChatDirty(chatId);
    characterStore.markChatManifestDirty(character.chaId);
    await characterStore.flush();
    await messageStore.persistNewChat(character.chaId, chatId, []);
    character.chatPage = 0;
    selectedCharID.set(index);

    await messageStore.appendMessage(chatId, {
      chatId: promptId,
      role: "user",
      data: "shared prompt",
    });
    await messageStore.appendMessage(chatId, {
      chatId: originalId,
      role: "char",
      data: "original response",
      saying: "speaker-original",
      disabled: true,
      generationInfo: {
        model: "model-original",
        generationId: "gen-original",
        inputTokens: 11,
      },
      promptInfo: {
        promptName: "root-preset",
        promptToggles: [{ key: "root-toggle", value: "on" }],
        promptText: [{ role: "user", content: "root prompt" }],
      },
    });

    const storage = await getSqlBranchStorage();
    const branch = await storage.createChatBranch({
      id: crypto.randomUUID(),
      chatId,
      forkMessageId: promptId,
      reason: "reroll",
      createdAt: Date.now(),
    });
    chat.activeBranchId = branch.id;
    await messageStore.appendMessage(chatId, {
      chatId: alternativeId,
      role: "char",
      data: "alternative response",
      saying: "speaker-alternative",
      disabled: "allBefore",
      generationInfo: {
        model: "model-alternative",
        generationId: "gen-alternative",
        outputTokens: 17,
      },
      promptInfo: {
        promptName: "alternative-preset",
        promptToggles: [{ key: "alt-toggle", value: "off" }],
        promptText: [{ role: "assistant", content: "alternative prompt" }],
      },
    });
    await messageStore.flush();
    await characterStore.flush();

    const graph = await storage.loadChatBranchGraph(chatId);
    return {
      characterId: character.chaId,
      chatId,
      branchId: branch.id,
      promptId,
      originalId,
      alternativeId,
      graph: {
        branchCount: graph.branches.length,
        activeBranchId: graph.activeBranchId,
        messages: graph.messages.map((message: any) => message.data),
      },
    };
  });
}

async function captureNativeBackup(page: Page) {
  return await page.evaluate(async () => {
    let downloadUrl = "";
    const controller = navigator.serviceWorker.controller!;
    const originalPostMessage = controller.postMessage.bind(controller);
    controller.postMessage = (data: any, transfer: any) => {
      if (data?.type === "REGISTER_STREAM_DOWNLOAD" && data.id) {
        downloadUrl = `/sw/download?id=${data.id}`;
      }
      return originalPostMessage(data, transfer);
    };

    const backupUrl = "/src/ts/drive/backuplocal.ts";
    const { SaveLocalBackup } = (await import(
      /* @vite-ignore */ backupUrl
    )) as {
      SaveLocalBackup: (mode?: "native" | "compatible") => Promise<void>;
    };
    let saveDone = false;
    const savePromise = SaveLocalBackup("native").finally(() => {
      saveDone = true;
    });
    while (!downloadUrl && !saveDone)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!downloadUrl) {
      throw new Error(
        `Native backup finished before registering a download: ${document.body.innerText.slice(-1200)}`,
      );
    }
    const response = await fetch(downloadUrl);
    if (!response.ok)
      throw new Error(`Backup stream failed: ${response.status}`);
    const bytes = Array.from(new Uint8Array(await response.arrayBuffer()));
    await savePromise;
    return bytes;
  });
}

async function decodeBackupDatabase(page: Page, bytes: number[]) {
  return await page.evaluate(async (source) => {
    const data = new Uint8Array(source);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const decoder = new TextDecoder();
    let offset = 0;
    let databaseData: Uint8Array | undefined;
    while (offset < data.length) {
      const nameLength = view.getUint32(offset, true);
      offset += 4;
      const name = decoder.decode(data.subarray(offset, offset + nameLength));
      offset += nameLength;
      const dataLength = view.getUint32(offset, true);
      offset += 4;
      const entry = data.subarray(offset, offset + dataLength);
      offset += dataLength;
      if (name === "database.risudat") databaseData = entry;
    }
    if (!databaseData) throw new Error("database.risudat missing from backup");
    const risuSaveUrl = "/src/ts/storage/backup/risuSave.ts";
    const { decodeRisuSave } = (await import(
      /* @vite-ignore */ risuSaveUrl
    )) as { decodeRisuSave: (data: Uint8Array) => Promise<any> };
    return await decodeRisuSave(databaseData);
  }, bytes);
}

test.describe("persistent branch export boundaries", () => {
  // Both cases mutate the same origin-scoped OPFS database and service worker.
  // Running them in parallel can close/reload the database underneath the other case.
  test.describe.configure({ mode: "serial" });
  test.setTimeout(120_000);

  test("preserves every branch through native backup and fresh restore", async ({
    page,
    browser,
  }) => {
    await waitForAppReady(page);
    const seeded = await seedBranchedChat(page);
    expect(seeded.graph.branchCount).toBe(2);
    expect(seeded.graph.activeBranchId).toBe(seeded.branchId);
    expect(seeded.graph.messages).toEqual(
      expect.arrayContaining([
        "shared prompt",
        "original response",
        "alternative response",
      ]),
    );

    const backupBytes = await captureNativeBackup(page);
    const decoded = await decodeBackupDatabase(page, backupBytes);
    const backedUpChat = decoded.characters
      .find((character: any) => character.chaId === seeded.characterId)
      ?.chats.find((chat: any) => chat.id === seeded.chatId);
    expect(backedUpChat?.branchState).toBeUndefined();
    expect(backedUpChat?.activeBranchId).toBeUndefined();
    const backedUpGraph = decoded.haejeokBranchGraphs?.[seeded.chatId];
    expect(backedUpGraph?.branches).toHaveLength(2);
    expect(backedUpGraph?.activeBranchId).toBe(seeded.branchId);
    expect(backedUpGraph?.messages.map((message: any) => message.data)).toEqual(
      expect.arrayContaining(["original response", "alternative response"]),
    );
    const backedUpAlternative = backedUpGraph?.messages.find(
      (message: any) => message.chatId === seeded.alternativeId,
    );
    expect(backedUpAlternative?.saying).toBe("speaker-alternative");
    expect(backedUpAlternative?.disabled).toBe("allBefore");
    expect(backedUpAlternative?.generationInfo?.generationId).toBe(
      "gen-alternative",
    );
    expect(backedUpAlternative?.promptInfo?.promptName).toBe(
      "alternative-preset",
    );

    const freshContext = await browser.newContext();
    await freshContext.addInitScript(() => {
      localStorage.setItem("haejeok_tos_2026_08_23", "true");
    });
    const freshPage = await freshContext.newPage();
    try {
      await waitForAppReady(freshPage);
      await freshPage.evaluate(async (source) => {
        const backupUrl = "/src/ts/drive/backuplocal.ts";
        const { restoreLocalBackupFile } = (await import(
          /* @vite-ignore */ backupUrl
        )) as { restoreLocalBackupFile: (file: File) => Promise<void> };
        await restoreLocalBackupFile(
          new File([new Uint8Array(source)], "branch-backup.risubackup"),
        );
      }, backupBytes);
      await freshPage.waitForTimeout(2500);
      await waitForAppReady(freshPage);

      const restoredGraph = await freshPage.evaluate(async (chatId) => {
        const factoryUrl = "/src/ts/storage/sql/sqlStorageFactory.ts";
        const { getSqlBranchStorage } = (await import(
          /* @vite-ignore */ factoryUrl
        )) as { getSqlBranchStorage: () => Promise<any> };
        const storage = await getSqlBranchStorage();
        if (!storage.isEnabled()) await storage.init();
        const graph = await storage.loadChatBranchGraph(chatId);
        const fullMessages = new Map<string, any>();
        for (const branch of graph.branches) {
          for (const message of await storage.loadBranchMessages(
            chatId,
            branch.id,
            { mode: "full" },
          )) {
            if (message.chatId && !fullMessages.has(message.chatId)) {
              fullMessages.set(message.chatId, message);
            }
          }
        }
        return {
          branchCount: graph.branches.length,
          activeBranchId: graph.activeBranchId,
          messages: graph.messages.map((message: any) => message.data),
          fullMessages: Object.fromEntries(fullMessages),
        };
      }, seeded.chatId);

      expect(restoredGraph.branchCount).toBe(2);
      expect(restoredGraph.activeBranchId).toBe(seeded.branchId);
      expect(restoredGraph.messages).toEqual(
        expect.arrayContaining([
          "shared prompt",
          "original response",
          "alternative response",
        ]),
      );
      const restoredAlternative =
        restoredGraph.fullMessages[seeded.alternativeId];
      expect(restoredAlternative?.saying).toBe("speaker-alternative");
      expect(restoredAlternative?.disabled).toBe("allBefore");
      expect(restoredAlternative?.generationInfo?.generationId).toBe(
        "gen-alternative",
      );
      expect(restoredAlternative?.promptInfo?.promptName).toBe(
        "alternative-preset",
      );
    } finally {
      await freshContext.close();
    }
  });

  test("offers compatibility and Haejeok JSON with different branch payloads", async ({
    page,
  }) => {
    await waitForAppReady(page);
    await seedBranchedChat(page);

    const exportOnce = async (format: "compatible" | "haejeok") => {
      const exportPromise = page.evaluate(async () => {
        const charactersUrl = "/src/ts/characters.ts";
        const { exportChat } = (await import(
          /* @vite-ignore */ charactersUrl
        )) as { exportChat: (page: number) => Promise<void> };
        await exportChat(0);
      });
      await page.getByRole("button", { name: "Export as JSON" }).click();
      const downloadPromise = page.waitForEvent("download");
      await page
        .getByRole("button", {
          name:
            format === "haejeok"
              ? "HaejeokRisuAI JSON (Preserve branches)"
              : "Compatibility JSON (Current timeline only)",
        })
        .click();
      const download = await downloadPromise;
      await exportPromise;
      const path = await download.path();
      if (!path) throw new Error("Chat JSON download has no local path");
      const payload = JSON.parse(await readFile(path, "utf8"));
      const ok = page.getByRole("button", { name: "OK" });
      if (await ok.isVisible().catch(() => false)) await ok.click();
      return { filename: download.suggestedFilename(), payload };
    };

    const compatible = await exportOnce("compatible");
    expect(compatible.filename).toContain("chat_compatible.json");
    expect(compatible.payload.type).toBe("risuChat");
    expect(compatible.payload.ver).toBe(2);
    expect(compatible.payload.data.branchState).toBeUndefined();
    expect(compatible.payload.data.activeBranchId).toBeUndefined();

    const native = await exportOnce("haejeok");
    expect(native.filename).toContain("chat_haejeok.json");
    expect(native.payload.type).toBe("haejeokChat");
    expect(native.payload.ver).toBe(1);
    expect(native.payload.data.chat.branchState).toBeUndefined();
    expect(native.payload.data.chat.activeBranchId).toBeUndefined();
    expect(native.payload.data.branchGraph.branches).toHaveLength(2);
    expect(
      native.payload.data.branchGraph.messages.map(
        (message: any) => message.data,
      ),
    ).toEqual(
      expect.arrayContaining(["original response", "alternative response"]),
    );
    const nativeAlternative = native.payload.data.branchGraph.messages.find(
      (message: any) => message.data === "alternative response",
    );
    expect(nativeAlternative?.saying).toBe("speaker-alternative");
    expect(nativeAlternative?.disabled).toBe("allBefore");
    expect(nativeAlternative?.generationInfo?.generationId).toBe(
      "gen-alternative",
    );
    expect(nativeAlternative?.promptInfo?.promptName).toBe(
      "alternative-preset",
    );
  });
});
